// clipRun.ts — a loop strip's Run over a VIDEO card: the whole clip through
// the strip, as a video, not just its poster frame.
//
// The live preview stays on the poster (one frame is all a preview needs).
// A Run reads the clip out a chunk at a time (sketchWorker CHUNK frames,
// never the whole clip at once); for each chunk the drawing tools (Depth,
// Segment, the outline, the hatch and look cards) run ONCE over its frames
// as a sequence — so boil, optical flow, temporal steadying and SAM 3's
// tracking see the motion — and keep every frame's result (aiEffects
// setClipChunk). Then each frame goes through the strip like a picture, is
// written as a JPEG, and at the end they are put together as an MP4 with the
// clip's sound, in Pictures\VidBars Effects. The worker keeps what it drew
// per chunk, so running the same strip again costs only the compositing.

import { diskFileUrl } from '../diskUrl'
import { clipChunkError, setClipChunk } from './aiEffects'
import { forgetImage, runChain, type ChainItem } from './chain'

/** Clips longer than this ask first: every frame is a full-size drawing. */
const ASK_FRAMES = 900
/** Frames per chunk, at most: the clip is cut into equal chunks of about this. */
const CHUNK = 120
/** Each chunk is drawn with this many frames more on either side, which are
 *  then not used: the tools carry state from drawing to drawing (the
 *  outline's line strength, the scale's smoothing, optical flow), and a
 *  sequence that starts or ends at the chunk's edge draws its first and last
 *  frames differently — a visible jump in line weight at every seam. Even,
 *  so the drawings on twos fall on the same frames in every chunk. */
const OVERLAP = 16

export type ClipMade = { url: string; w: number; h: number; video: true } | { error: string } | { stopped: true }

/** The strip's items with its subject (items[0], a video card) baked over
 *  the whole clip. `note` says how it is going; `stopped` is asked between
 *  frames. */
export async function makeClip(items: ChainItem[], maxSide: number, name: string, stopped: () => boolean,
  note: (s: string) => void): Promise<ClipMade> {
  const d = window.vidbarsDesktop
  const src = items[0]
  if (src?.kind !== 'source' || !src.video) return { error: 'not a video' }
  if (!d?.sketchClip || !d.sketchClipFrames || !d.sketchBakeFrame || !d.sketchBakeEncode) return { error: 'Videos run in the VidBars desktop app' }
  note('Opening the clip…')
  const info = await d.sketchClip(src.video)
  if ('error' in info) return { error: info.error }
  // A trimmed clip (a Rough Cut's) draws only its part: frames [first, end).
  const first = src.clipIn ? Math.max(0, Math.min(info.n - 1, Math.floor(src.clipIn * info.fps))) : 0
  const end = src.clipOut ? Math.max(first + 1, Math.min(info.n, Math.ceil(src.clipOut * info.fps))) : info.n
  const frames = end - first
  if (frames > ASK_FRAMES && !window.confirm(
    `“${src.label || 'This clip'}” is ${frames} frames (${(frames / info.fps).toFixed(0)} s). Draw every frame of it?`)) return { stopped: true }
  const bake = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')
  // Equal chunks (no short one at the end), each an even number of frames.
  const size = 2 * Math.ceil(frames / Math.ceil(frames / CHUNK) / 2)
  let stop = end
  let w = 0, h = 0, encoded = false
  try {
    for (let start = first; start < stop; start += size) {
      const count = Math.min(size, stop - start)
      const lo = Math.max(0, start - OVERLAP), hi = Math.min(info.n, start + count + OVERLAP)
      if (stopped()) return { stopped: true }
      note(`Reading frames ${start - first + 1}–${start - first + count} of ${frames}…`)
      const got = await d.sketchClipFrames({ id: info.id, start: lo, count: hi - lo })
      if ('error' in got) return { error: got.error }
      // The file can hold fewer frames than its header says: the clip ends there.
      const urls = got.paths.map(p => diskFileUrl(p))
      setClipChunk({ id: info.id, start: lo, count: hi - lo, total: info.n, urls })
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
        const s = await d.sketchBakeFrame(bake, lo + t, jpg)
        if (s.error) return { error: s.error }
      }
      if (last < start - lo + count) { stop = lo + last; break }
    }
    note('Making the video…')
    // (The encode takes the bake's frames away, made or not.)
    encoded = true
    const s = await d.sketchBakeEncode(bake, { id: info.id, start: first, count: stop - first }, name)
    return 'error' in s ? { error: s.error } : { url: diskFileUrl(s.path), w, h, video: true }
  } finally {
    if (!encoded) void d.sketchBakeDrop?.(bake)
    setClipChunk(null)
    note('')
  }
}
