// clipMotion.ts — a strip seen MOVING: its clip (a video or a GIF) played
// through its effects, frame after frame.
//
// Every look has a slow half (the drawing tools: depth, masks, outlines,
// hatching, drawn by the worker a chunk of frames at a time) and a fast half
// (the sliders: the strip's GPU effects laid over those drawings). Playing
// draws ahead of the playhead and keeps each finished frame, small, for this
// session; once a stretch is drawn it plays at the clip's own rate, and the
// next time round it costs nothing. "Draw all" goes on past the playhead
// until the whole clip is drawn, in the background, while you work.
//
// A slider moved while it plays: the frames already drawn go on showing
// until each is drawn again with the new value, right ahead of the
// playhead, so the change streams in instead of stopping the picture. A
// slow card's dial moved makes the worker draw its chunk again; the rest is
// compositing.
//
// The drawings are asked for at the size a Run asks for (RUN_DRAW_SIDE), so
// the worker keeps one set: a Run after the clip was drawn here only lays
// the effects over it again, at full size.
//
// One engine per key: 'rail:<id>' for a loop strip, 'mix:<node>' for the
// look mixer. Whoever shows it registers `onFrame` and gets a fresh canvas
// for every frame shown. Transient: nothing here is saved.

import { create } from 'zustand'
import { forgetImage, runChain, type ChainItem } from './chain'
import { clipChunkError, setClipChunk, stripNeedsAux } from './aiEffects'
import { clipChunks, openClip, type ClipChunkPlan, type OpenClip } from './clipSource'
import { clipLane } from './clipRun'

/** The long edge a played frame is composited at. */
export const MOTION_SIDE = 960
/** What the drawing tools are asked to draw at: a Run's own size (railRun
 *  RUN_SIDE), so what is drawn here is what a Run finds kept. */
const RUN_DRAW_SIDE = 8192
/** Frames kept per engine (small JPEGs): a minute or so of film. */
const KEEP_FRAMES = 1800

export interface MotionView {
  /** Frames of the clip that play: first..end-1 (whole-file numbers). */
  first: number
  end: number
  fps: number
  /** The frame on show. */
  frame: number
  playing: boolean
  /** Draw every frame, not only those ahead of the playhead. */
  drawAll: boolean
  /** Frames drawn with the strip as it is now. */
  drawn: number
  /** What it is doing, when it takes a while ('Drawing frames 1–120…'). */
  note?: string
  error?: string
  /** It has shown a frame of its own (the poster preview steps aside). */
  engaged: boolean
}

export const useClipMotion = create<{ byKey: Record<string, MotionView> }>(() => ({ byKey: {} }))

function patch(key: string, p: Partial<MotionView>) {
  useClipMotion.setState(s => {
    const cur = s.byKey[key]
    if (!cur) return s
    const next = { ...cur, ...p }
    if ((Object.keys(p) as (keyof MotionView)[]).every(k => cur[k] === next[k])) return s
    return { byKey: { ...s.byKey, [key]: next } }
  })
}

type Source = Extract<ChainItem, { kind: 'source' }>

interface Engine {
  key: string
  items: ChainItem[]
  sig: string
  clipSig: string
  clip: OpenClip | null
  opening: Promise<void> | null
  /** frame → its drawn picture and the strip it was drawn with. */
  frames: Map<number, { sig: string; blob: Blob }>
  onFrame: ((c: HTMLCanvasElement) => void) | null
  drawing: boolean
  timer: number
  lastTick: number
  /** The frame on show and what it was drawn with. */
  shown: { frame: number; sig: string } | null
  /** Bumped whenever the engine is dropped or the clip changes. */
  gen: number
}

const engines = new Map<string, Engine>()

const view = (key: string) => useClipMotion.getState().byKey[key]
const subjectOf = (items: ChainItem[]): Source | null => {
  const s = items[0]
  return s?.kind === 'source' && s.video ? s : null
}
const clipSigOf = (s: Source) => `${s.video}|${s.clipIn ?? ''}|${s.clipOut ?? ''}`

/** Give an engine its strip (items, subject first). A strip whose subject is
 *  not a clip drops it. Cheap when nothing changed. */
export function motionAttach(key: string, items: ChainItem[] | null, onFrame?: (c: HTMLCanvasElement) => void,
  /** Show the first frame through the look straight away (the mixer); a
   *  strip waits for Play, its still preview showing meanwhile. */
  opts: { showFirst?: boolean } = {}): void {
  const subject = items ? subjectOf(items) : null
  if (!items || !subject) { motionDrop(key); return }
  let e = engines.get(key)
  const clipSig = clipSigOf(subject)
  if (!e || e.clipSig !== clipSig) {
    if (e) motionDrop(key)
    e = {
      key, items, sig: JSON.stringify(items), clipSig, clip: null, opening: null, frames: new Map(),
      onFrame: onFrame ?? null, drawing: false, timer: 0, lastTick: 0, shown: null, gen: 0,
    }
    engines.set(key, e)
    useClipMotion.setState(s => ({ byKey: { ...s.byKey, [key]: { first: 0, end: 0, fps: 24, frame: 0, playing: false, drawAll: false, drawn: 0, engaged: !!opts.showFirst } } }))
    const made = e
    void ensureOpen(e).then(() => { if (opts.showFirst && engines.get(key) === made) wake(made) })
  }
  if (onFrame) e.onFrame = onFrame
  const sig = JSON.stringify(items)
  if (sig !== e.sig) {
    e.items = items
    e.sig = sig
    patch(key, { drawn: countDrawn(e) })
    // Paused on a frame: draw it again with the new strip.
    wake(e)
  }
}

/** Forget an engine: its frames and its state. */
export function motionDrop(key: string): void {
  const e = engines.get(key)
  if (!e) return
  e.gen++
  window.clearInterval(e.timer)
  engines.delete(key)
  useClipMotion.setState(s => {
    if (!s.byKey[key]) return s
    const byKey = { ...s.byKey }
    delete byKey[key]
    return { byKey }
  })
}

/** Is this engine showing frames of its own (so a still preview steps aside)? */
export const motionEngaged = (key: string): boolean => !!view(key)?.engaged

function ensureOpen(e: Engine): Promise<void> {
  if (e.clip) return Promise.resolve()
  if (e.opening) return e.opening
  const s = subjectOf(e.items)!
  const gen = e.gen
  e.opening = openClip({ url: s.video!, clipIn: s.clipIn, clipOut: s.clipOut, label: s.label }).then(c => {
    if (e.gen !== gen || engines.get(e.key) !== e) return
    if ('error' in c) { patch(e.key, { error: c.error }); return }
    e.clip = c
    patch(e.key, { first: c.first, end: c.end, fps: c.fps, frame: c.first, error: undefined })
  }).finally(() => { e.opening = null })
  return e.opening
}

function countDrawn(e: Engine): number {
  let n = 0
  for (const f of e.frames.values()) if (f.sig === e.sig) n++
  return n
}

/** Play or pause. Playing from the end starts again at the beginning. */
export function motionPlay(key: string, on: boolean): void {
  const e = engines.get(key)
  if (!e) return
  patch(key, { playing: on, engaged: true })
  window.clearInterval(e.timer)
  if (on) {
    e.lastTick = performance.now()
    e.timer = window.setInterval(() => tick(e), 1000 / 60)
  }
  wake(e)
}

/** Draw every frame of the clip (on), or only what playing needs (off). */
export function motionDrawAll(key: string, on: boolean): void {
  const e = engines.get(key)
  if (!e) return
  patch(key, { drawAll: on, engaged: true })
  wake(e)
}

/** Show frame `f` (a scrub, or stepping). */
export function motionSeek(key: string, f: number): void {
  const e = engines.get(key)
  const v = view(key)
  if (!e || !v || !e.clip) return
  const frame = Math.max(v.first, Math.min(v.end - 1, Math.round(f)))
  patch(key, { frame, engaged: true })
  void show(e, frame)
  wake(e)
}

/** Advance the playhead at the clip's rate, waiting on a frame not drawn yet. */
function tick(e: Engine) {
  const v = view(e.key)
  if (!v || !v.playing || !e.clip) { e.lastTick = performance.now(); return }
  const now = performance.now()
  const step = 1000 / Math.max(1, v.fps)
  if (now - e.lastTick < step) return
  e.lastTick = now - Math.min(step, now - e.lastTick - step)
  const next = v.frame + 1 >= v.end ? v.first : v.frame + 1
  // Not drawn yet (in any version): hold here until it is.
  if (!e.frames.has(next)) { if (!e.drawing) wake(e); return }
  patch(e.key, { frame: next })
  void show(e, next)
  // A frame shown from an older strip: draw it again ahead of the rest.
  wake(e)
}

/** Put a drawn frame on show (the newest version of it there is). */
async function show(e: Engine, frame: number): Promise<void> {
  const f = e.frames.get(frame)
  if (!f || !e.onFrame) return
  if (e.shown && e.shown.frame === frame && e.shown.sig === f.sig) return
  e.shown = { frame, sig: f.sig }
  try {
    const bmp = await createImageBitmap(f.blob)
    // A newer frame went on show meanwhile.
    if (e.shown?.frame !== frame || view(e.key)?.frame !== frame) { bmp.close(); return }
    const c = document.createElement('canvas')
    c.width = bmp.width; c.height = bmp.height
    c.getContext('2d')!.drawImage(bmp, 0, 0)
    bmp.close()
    e.onFrame?.(c)
  } catch { /* a frame that will not decode is drawn again */ }
}

/** The next frame to draw, or null: the one on show first, then on from the
 *  playhead (round to the start) while playing or drawing all. */
function nextToDraw(e: Engine): number | null {
  const v = view(e.key)
  if (!v || !e.clip) return null
  const stale = (f: number) => e.frames.get(f)?.sig !== e.sig
  // Paused: the frame on show first. Playing: the frames AHEAD of it (it
  // is already on show; by the time it is drawn again the playhead has
  // moved on), and itself last.
  if (!v.playing) {
    if (stale(v.frame)) return v.frame
    if (!v.drawAll) return null
  }
  const len = v.end - v.first
  for (let k = 1; k <= len; k++) {
    const f = v.first + ((v.frame - v.first + k) % len)
    if (stale(f)) return f
  }
  return null
}

/** Start the drawer if there is drawing to do. */
function wake(e: Engine) {
  if (e.drawing) return
  e.drawing = true
  void drawLoop(e).finally(() => { e.drawing = false })
}

async function drawLoop(e: Engine): Promise<void> {
  const gen = e.gen
  await ensureOpen(e)
  for (;;) {
    if (e.gen !== gen || engines.get(e.key) !== e || !e.clip) return
    const f = nextToDraw(e)
    if (f === null) { patch(e.key, { note: undefined }); return }
    const chunk = clipChunks(e.clip.first, e.clip.end, e.clip.n).find(c => f >= c.start && f < c.start + c.count)
    if (!chunk) return
    const err = await drawChunk(e, chunk, f, gen)
    if (err) { patch(e.key, { error: err, note: undefined, playing: false, drawAll: false }); window.clearInterval(e.timer); return }
  }
}

/** Draw the frames of one chunk that need it, from `from` on (then the ones
 *  before it), while that chunk is still what is wanted next. Resolves an
 *  error, or null. */
async function drawChunk(e: Engine, ch: ClipChunkPlan, from: number, gen: number): Promise<string | null> {
  const clip = e.clip!
  const v0 = view(e.key)!
  const total = v0.end - v0.first
  return clipLane(async () => {
    const got = await clip.read(ch.lo, ch.hi)
    if ('error' in got) return got.error
    const aux = stripNeedsAux(e.items)
    if (aux) {
      if (!clip.workerId) { got.release(); return 'The drawing cards play in the VidBars desktop app' }
      setClipChunk({ id: clip.workerId, start: ch.lo, count: ch.hi - ch.lo, total: clip.n, urls: got.urls })
    }
    try {
      for (;;) {
        if (e.gen !== gen || engines.get(e.key) !== e) return null
        const f = nextToDraw(e)
        // Wanted next is in another chunk: let go of this one.
        if (f === null || f < ch.start || f >= ch.start + ch.count) return null
        const t = f - ch.lo
        if (t >= got.urls.length) {
          // The file holds fewer frames than its header said: it ends here.
          return f === from ? `The clip ends at frame ${ch.lo + got.urls.length}` : null
        }
        const v = view(e.key)!
        const done = countDrawn(e)
        patch(e.key, { note: aux ? `Drawing frame ${f - v.first + 1} of ${total}` : `Frame ${f - v.first + 1} of ${total}` })
        const sig = e.sig
        const items = e.items
        const s = items[0] as Source
        const r = await runChain([{ ...s, url: got.urls[t], video: undefined }, ...items.slice(1)], MOTION_SIDE, false, { drawSide: RUN_DRAW_SIDE })
        forgetImage(got.urls[t])
        const failed = aux ? clipChunkError() : null
        if (failed) return failed
        const out = r.outputs[0]
        for (const o of r.outputs.slice(1)) o.canvas.width = o.canvas.height = 0
        if (!out) return r.error ?? 'Nothing came out'
        const blob = await new Promise<Blob | null>(res => out.canvas.toBlob(res, 'image/jpeg', 0.88))
        out.canvas.width = out.canvas.height = 0
        if (!blob) return 'A frame came back empty'
        if (e.gen !== gen) return null
        e.frames.delete(f)
        e.frames.set(f, { sig, blob })
        // Keep the newest; the oldest go first.
        while (e.frames.size > KEEP_FRAMES) e.frames.delete(e.frames.keys().next().value!)
        patch(e.key, { drawn: sig === e.sig ? done + 1 : countDrawn(e) })
        const now = view(e.key)
        if (now && now.frame === f) void show(e, f)
      }
    } finally {
      if (aux) setClipChunk(null)
      got.release()
    }
  })
}
