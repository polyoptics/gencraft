// makeGif.ts — a card's movie, or every shot of a deck, as one looping
// animated GIF on a NEW card beside it. What it was made from is not touched.
//
// Made here in the page: each movie is stepped through frame by frame on a
// canvas and written by utils/gifEncode. Kept small so it is quick — at most
// 480 px on its long side, 10 frames a second, 200 frames; a longer run
// plays at fewer frames a second rather than being cut short. A still
// picture among a deck's shots is held for a moment. Ping-pong plays the
// whole run forward then backward, within the same 200 frames.
//
// Desktop: the GIF is a real file in Pictures\VidBars GIFs, so it can be
// dragged out and revealed like any other. Plain browser (or a desktop
// window older than this): it is kept in the app's own media store.

import { create } from 'zustand'
import type { MediaItem } from '../types/bar'
import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { cardFaceMedia, cardFaceSize, createMediaCard, gridOrder, layoutCardGrid } from './cardGrid'
import { markNew } from './newCards'
import { cardEntries, placeCard } from './railCards'
import { drawnRect } from './effectCards'
import { resolveMediaUrl } from './useResolvedMedia'
import { putMedia } from './mediaStore'
import { makeMediaRef } from './mediaRef'
import { diskFileUrl } from './diskUrl'
import { GifWriter } from './gifEncode'
import { makeMovie } from './makeMovie'
import { placeInFrame } from './shotFrame'
import { findFreeSlotRightOf } from '../components/Viewport3D/ImageStudio'

const MAX_SIDE = 480
const FPS = 10
const MAX_FRAMES = 200
const STILL_SECONDS = 1.5

/** What the maker is doing, for the notice on screen (GifNotice). */
export const useGifJob = create<{ text: string | null; busy: boolean }>(() => ({ text: null, busy: false }))

let clearTimer = 0
function say(text: string | null, busy: boolean, clearAfterMs = 0) {
  window.clearTimeout(clearTimer)
  useGifJob.setState({ text, busy })
  if (clearAfterMs) clearTimer = window.setTimeout(() => useGifJob.setState({ text: null }), clearAfterMs)
}
/** A short line in the notice at the bottom of the screen (GifNotice), for
 *  any process that has something to say: gone after `clearAfterMs`. */
export const screenNote = say

/** The movie on a card's face, if that is what its face shows. A Rough Cut
 *  card's face plays its whole cut, so it gives every clip, in cut order. */
export function cardGifShots(g: ProjectGroup): MediaItem[] {
  if (g.cut) return deckGifShots([g.id])
  const m = cardFaceMedia(g, useBoardsStore.getState().boards)
  return m?.type === 'video' ? [m] : []
}

/** Every shot of the cards `ids`, in order: each card's movies and pictures.
 *  Empty when there is no movie among them (nothing would move). */
export function deckGifShots(ids: string[]): MediaItem[] {
  const { groups, boards } = useBoardsStore.getState()
  const shots = ids.flatMap(id => {
    const g = groups.find(x => x.id === id)
    return g ? cardEntries(g, boards).map(e => e.media) : []
  })
  return shots.some(m => m.type === 'video') ? shots : []
}

interface Source {
  draw: CanvasImageSource
  w: number
  h: number
  /** A movie: the part it plays, seconds. */
  video?: { el: HTMLVideoElement; lo: number; hi: number }
  /** A still: how long it is held, seconds (a Rough Cut's own hold, if set). */
  hold: number
  /** The frame it goes out in (MediaItem.frame). */
  frame?: MediaItem['frame']
}

function waitFor(el: HTMLElement, ok: string, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    const done = (v: boolean) => { window.clearTimeout(t); el.removeEventListener(ok, yes); el.removeEventListener('error', no); resolve(v) }
    const yes = () => done(true), no = () => done(false)
    const t = window.setTimeout(no, ms)
    el.addEventListener(ok, yes)
    el.addEventListener('error', no)
  })
}

async function open(m: MediaItem): Promise<Source | null> {
  const url = await resolveMediaUrl(m.url)
  if (!url) return null
  if (m.type === 'video') {
    const el = document.createElement('video')
    el.muted = true
    el.playsInline = true
    el.preload = 'auto'
    const ready = waitFor(el, 'loadeddata', 20_000)
    el.src = url
    if (!(await ready) || !el.videoWidth) return null
    const length = Number.isFinite(el.duration) ? el.duration : 0
    const lo = Math.max(0, Math.min(m.clipIn ?? 0, length))
    const hi = Math.max(lo, Math.min(m.clipOut ?? length, length))
    return { draw: el, w: el.videoWidth, h: el.videoHeight, video: { el, lo, hi }, hold: 0, frame: m.frame }
  }
  const img = new Image()
  const ready = waitFor(img, 'load', 20_000)
  img.src = url
  if (!(await ready) || !img.naturalWidth) return null
  const held = m.clipOut != null ? m.clipOut - (m.clipIn ?? 0) : STILL_SECONDS
  return { draw: img, w: img.naturalWidth, h: img.naturalHeight, hold: Math.max(0.2, Math.min(10, held)), frame: m.frame }
}

async function seek(el: HTMLVideoElement, t: number): Promise<void> {
  if (Math.abs(el.currentTime - t) < 1e-4 && el.readyState >= 2) return
  const done = waitFor(el, 'seeked', 5_000)
  el.currentTime = t
  await done
}

function toDataUrl(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return 'data:image/gif;base64,' + btoa(s)
}

/** Keep the GIF and name where it is: a file on disk (desktop), else the
 *  app's media store, else the bytes themselves. */
async function keep(bytes: Uint8Array, name: string): Promise<string> {
  const dataUrl = toDataUrl(bytes)
  const d = window.vidbarsDesktop
  if (d && typeof d.saveImage === 'function') {
    try {
      const r = await d.saveImage('gif', name, dataUrl)
      const path = typeof r === 'string' ? r : r && 'path' in r ? r.path : null
      if (path) return diskFileUrl(path)
    } catch { /* fall through to the app's own store */ }
  }
  try {
    return makeMediaRef(await putMedia(new Blob([bytes as BlobPart], { type: 'image/gif' })))
  } catch {
    return dataUrl
  }
}

/** The box cards `ids` take up together, canvas units. */
function boxOf(ids: string[]): { x: number; y: number; width: number; height: number } | null {
  const { groups, boards } = useBoardsStore.getState()
  const zoom = useCanvasStore.getState().zoom
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const id of ids) {
    const g = groups.find(x => x.id === id)
    const r = g ? drawnRect(g, boards, zoom) : null
    if (!r) continue
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height)
  }
  return x1 > x0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null
}

/** Make `shots` into one looping GIF, on a new card named `name` in the
 *  first free spot right of cards `besideIds`. One at a time. Ping-pong:
 *  it plays forward, then backward. */
export async function makeGif(shots: MediaItem[], name: string, besideIds: string[], pingPong = false): Promise<void> {
  if (useGifJob.getState().busy || shots.length === 0) return
  say('Making GIF…', true)
  const opened: Source[] = []
  try {
    for (const m of shots) {
      const s = await open(m)
      if (s) opened.push(s)
    }
    if (!opened.some(s => s.video && s.video.hi > s.video.lo)) throw new Error('the movie could not be read')

    // The first shot sets the shape; the others are fitted inside it. Shots
    // with a frame (a Rough Cut's): the first one's frame is the shape, the
    // largest of it the first shot holds, and each shot fills it or is
    // fitted inside it as its own frame says.
    const first = opened[0]
    const aspect = opened.find(s => s.frame)?.frame?.aspect
    const fw = aspect ? Math.min(first.w, first.h * aspect) : first.w
    const fh = aspect ? fw / aspect : first.h
    const k = Math.min(1, MAX_SIDE / Math.max(fw, fh))
    const w = Math.max(2, Math.round(fw * k)), h = Math.max(2, Math.round(fh * k))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('no canvas to draw on')

    const stills = opened.filter(s => !s.video).length
    const seconds = opened.reduce((n, s) => n + (s.video ? s.video.hi - s.video.lo : 0), 0)
    const fps = Math.min(FPS, Math.max(1, (pingPong ? MAX_FRAMES / 2 : MAX_FRAMES) - stills) / Math.max(0.1, seconds))
    const step = 1 / fps
    const total = Math.max(1, Math.round(seconds * fps) + stills)

    const gif = new GifWriter(w, h)
    let made = 0
    const put = (s: Source, delayCs: number) => {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, w, h)
      const at = placeInFrame(s.w, s.h, w, h, s.frame?.fill, s.frame)
      ctx.drawImage(s.draw, at.x, at.y, at.w, at.h)
      gif.frame(ctx.getImageData(0, 0, w, h).data, delayCs)
      made++
      say(`Making GIF… ${Math.min(99, Math.round(made / total * 100))}%`, true)
    }
    for (const s of opened) {
      if (!s.video) { put(s, s.hold * 100); await new Promise(r => setTimeout(r)); continue }
      const { el, lo, hi } = s.video
      // Each frame is taken from the MIDDLE of the time it stands for, never
      // at the in point itself: a cut set a hair before a shot change has
      // one frame of the shot before it there. Played, that frame is gone
      // in a blink; in a GIF it would be held (Brian 2026-11-11: a face he
      // had cut out came back).
      for (let from = lo; from < hi - 1e-3; from += step) {
        const len = Math.min(step, hi - from)
        await seek(el, from + len / 2)
        put(s, len * 100)
      }
    }
    if (made === 0) throw new Error('no frames came out')

    const url = await keep(gif.finish(pingPong), name)
    useUndoCoordinator.getState().checkpoint()
    const gid = createMediaCard({ cx: 0, cy: 0 }, [{ media: { url, type: 'image', originalName: `${name}.gif` }, label: name }])
    if (!gid) throw new Error('the card could not be made')
    markNew([gid])
    const card = useBoardsStore.getState().groups.find(g => g.id === gid)
    const [board] = card ? gridOrder(card, useBoardsStore.getState().boards) : []
    if (board) layoutCardGrid(gid, { [board]: h / w })
    const face = cardFaceSize()
    const beside = boxOf(besideIds)
    if (beside) {
      const slot = findFreeSlotRightOf(beside, face.w, face.h)
      placeCard(gid, slot.x, slot.y)
    }
    say(null, false)
  } catch (err) {
    console.warn('[gif] not made', err)
    say(`GIF not made: ${String((err as Error)?.message ?? err)}`, false, 5000)
  } finally {
    for (const s of opened) if (s.video) { s.video.el.removeAttribute('src'); s.video.el.load() }
  }
}

/** Every shot of a deck, in order, as one MP4 movie on a new card in the
 *  first free spot right of cards `besideIds` (utils/makeMovie). One at a
 *  time, with the GIFs: they share the notice on screen. */
export async function makeDeckMovie(shots: MediaItem[], name: string, besideIds: string[]): Promise<void> {
  if (useGifJob.getState().busy || shots.length === 0) return
  say('Making the movie…', true)
  const r = await makeMovie(shots, name, () => boxOf(besideIds), () => false, s => say(s, true))
  if ('error' in r) say(`Movie not made: ${r.error}`, false, 8000)
  else if ('shots' in r) say(`Movie made: ${r.shots} shots, on a new card beside the deck.`, false, 5000)
  else say(null, false)
}
