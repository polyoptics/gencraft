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
  if (info.n > ASK_FRAMES && !window.confirm(
    `“${src.label || 'This clip'}” is ${info.n} frames (${(info.n / info.fps).toFixed(0)} s). Draw every frame of it?`)) return { stopped: true }
  const bake = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')
  const CHUNK = 120
  let w = 0, h = 0, encoded = false
  try {
    for (let start = 0; start < info.n; start += CHUNK) {
      const count = Math.min(CHUNK, info.n - start)
      if (stopped()) return { stopped: true }
      note(`Reading frames ${start + 1}–${start + count} of ${info.n}…`)
      const got = await d.sketchClipFrames({ id: info.id, start, count })
      if ('error' in got) return { error: got.error }
      // The file can hold fewer frames than its header says: the clip ends there.
      const urls = got.paths.map(p => diskFileUrl(p))
      setClipChunk({ id: info.id, start, count, total: info.n, urls })
      for (let t = 0; t < urls.length; t++) {
        if (stopped()) return { stopped: true }
        note(t === 0 ? `Drawing frames ${start + 1}–${start + count} of ${info.n}…` : `Frame ${start + t + 1} of ${info.n}`)
        const r = await runChain([{ ...src, url: urls[t], video: undefined }, ...items.slice(1)], maxSide, false)
        forgetImage(urls[t])
        const failed = clipChunkError()
        if (failed) return { error: `frames ${start + 1}–${start + count}: ${failed}` }
        const out = r.outputs[0]
        for (const o of r.outputs.slice(1)) o.canvas.width = o.canvas.height = 0
        if (!out) return { error: `frame ${start + t + 1}: ${r.error ?? 'nothing came out'}` }
        w = out.canvas.width; h = out.canvas.height
        const jpg = out.canvas.toDataURL('image/jpeg', 0.95)
        out.canvas.width = out.canvas.height = 0
        if (jpg.length < 64) return { error: `frame ${start + t + 1} came back empty` }
        const s = await d.sketchBakeFrame(bake, start + t, jpg)
        if (s.error) return { error: s.error }
      }
      if (urls.length < count) { info.n = start + urls.length; break }
    }
    note('Making the video…')
    // (The encode takes the bake's frames away, made or not.)
    encoded = true
    const s = await d.sketchBakeEncode(bake, { id: info.id, start: 0, count: info.n }, name)
    return 'error' in s ? { error: s.error } : { url: diskFileUrl(s.path), w, h, video: true }
  } finally {
    if (!encoded) void d.sketchBakeDrop?.(bake)
    setClipChunk(null)
    note('')
  }
}
