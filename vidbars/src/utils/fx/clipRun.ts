// clipRun.ts — a loop strip's Run over a VIDEO or GIF card: the whole clip
// through the strip, as a moving picture, not just its first frame.
//
// The live preview stays on one frame until it is played (utils/fx/
// clipMotion). A Run reads the clip out a chunk at a time (clipSource
// clipChunks, never the whole clip at once); for each chunk the drawing
// tools (Depth, Segment, the outline, the hatch and look cards) run ONCE
// over its frames as a sequence — so boil, optical flow, temporal steadying
// and SAM 3's tracking see the motion — and keep every frame's result
// (aiEffects setClipChunk). Then each frame goes through the strip like a
// picture, is written as a JPEG, and at the end they are put together: an
// MP4 with the clip's sound, or a looping GIF for a GIF, in Pictures\VidBars
// Effects. The worker keeps what it drew per chunk, so running the same
// strip again — or after the motion preview drew it — costs only the
// compositing.

import { clipChunkError, setClipChunk } from './aiEffects'
import { forgetImage, runChain, type ChainItem } from './chain'
import { clipChunks, openClip } from './clipSource'
import { diskFileUrl as diskUrlOf } from '../diskUrl'

/** Clips longer than this ask first: every frame is a full-size drawing. */
const ASK_FRAMES = 900

/** One clip job at a time, whoever asks (a Run, the motion preview, the
 *  mixer): the drawing tools' chunk (setClipChunk) is one for the page. */
let lane: Promise<unknown> = Promise.resolve()
export function clipLane<T>(job: () => Promise<T>): Promise<T> {
  const p = lane.then(job)
  lane = p.catch(() => undefined)
  return p
}

export type ClipMade = { url: string; w: number; h: number; video?: true } | { error: string } | { stopped: true }

/** The strip's items with its subject (items[0], a video or GIF) baked over
 *  the whole clip. `note` says how it is going; `stopped` is asked between
 *  frames. `ask`: false skips the "draw every frame?" question (the mixer
 *  asked once for all its shots). */
export async function makeClip(items: ChainItem[], maxSide: number, name: string, stopped: () => boolean,
  note: (s: string) => void, ask = true): Promise<ClipMade> {
  const d = window.vidbarsDesktop
  const src = items[0]
  if (src?.kind !== 'source' || !src.video) return { error: 'not a video' }
  if (!d?.sketchClip || !d.sketchClipFrames || !d.sketchBakeFrame || !d.sketchBakeEncode) return { error: 'Videos run in the VidBars desktop app' }
  note('Opening the clip…')
  const clip = await openClip({ url: src.video, clipIn: src.clipIn, clipOut: src.clipOut, label: src.label })
  if ('error' in clip) return { error: clip.error }
  if (!clip.workerId) return { error: 'This clip is not a file VidBars can read frames from' }
  const id = clip.workerId
  const { first, end } = clip
  const frames = end - first
  if (ask && frames > ASK_FRAMES && !window.confirm(
    `“${src.label || 'This clip'}” is ${frames} frames (${(frames / clip.fps).toFixed(0)} s). Draw every frame of it?`)) return { stopped: true }
  const gif = !!src.gif
  const bake = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')
  return clipLane(async () => {
    let stop = end
    let w = 0, h = 0, encoded = false
    try {
      for (const ch of clipChunks(first, end, clip.n)) {
        const { start, count, lo, hi } = ch
        if (start >= stop) break
        if (stopped()) return { stopped: true }
        note(`Reading frames ${start - first + 1}–${start - first + count} of ${frames}…`)
        const got = await clip.read(lo, hi)
        if ('error' in got) return { error: got.error }
        // The file can hold fewer frames than its header says: the clip ends there.
        const urls = got.urls
        setClipChunk({ id, start: lo, count: hi - lo, total: clip.n, urls })
        const last = Math.min(urls.length, start - lo + count)
        for (let t = start - lo; t < last; t++) {
          if (stopped()) return { stopped: true }
          note(t === start - lo ? `Drawing frames ${start - first + 1}–${start - first + count} of ${frames}…` : `Frame ${lo + t - first + 1} of ${frames}`)
          const r = await runChain([{ ...src, url: urls[t], video: undefined }, ...items.slice(1)], maxSide, false)
          forgetImage(urls[t])
          const failed = clipChunkError()
          if (failed) return { error: `frames ${start + 1}–${start + count}: ${failed}` }
          const out = r.outputs[0]
          for (const o of r.outputs.slice(1)) o.canvas.width = o.canvas.height = 0
          if (!out) return { error: `frame ${lo + t + 1}: ${r.error ?? 'nothing came out'}` }
          w = out.canvas.width; h = out.canvas.height
          const jpg = out.canvas.toDataURL('image/jpeg', 0.95)
          out.canvas.width = out.canvas.height = 0
          if (jpg.length < 64) return { error: `frame ${lo + t + 1} came back empty` }
          const s = await d.sketchBakeFrame!(bake, lo + t, jpg)
          if (s.error) return { error: s.error }
        }
        got.release()
        if (last < start - lo + count) { stop = lo + last; break }
      }
      note(gif ? 'Making the GIF…' : 'Making the video…')
      // (The encode takes the bake's frames away, made or not.)
      encoded = true
      const s = await d.sketchBakeEncode!(bake, { id, start: first, count: stop - first }, name, gif ? { gif: true } : undefined)
      if ('error' in s) return { error: s.error }
      // A GIF made from a GIF is a picture (it loops on its card as the
      // GIF did); anything else is a video. An older main makes an MP4.
      const isGif = /\.gif$/i.test(s.path)
      return { url: diskUrlOf(s.path), w, h, ...(isGif ? {} : { video: true as const }) }
    } finally {
      if (!encoded) void d.sketchBakeDrop?.(bake)
      setClipChunk(null)
      note('')
    }
  })
}

