// clipSource.ts — a moving picture (a video, or an animated GIF) as frames.
//
// A strip, the look mixer and a Run all read a clip the same way: opened
// once, then a stretch of frames at a time, each frame a picture url that
// runChain draws like any other picture.
//
// In the desktop app the clip is opened by the sketch worker (ffmpeg): its
// frames are files, cut in the same chunks a Run cuts (clipChunks), so the
// drawing tools (Depth, Segment, the outline and look cards) see each chunk
// as one sequence and the worker keeps what it drew per chunk for the next
// pass. Anywhere else, or for a GIF kept only inside the project, the page
// reads the frames itself: a GIF with the browser's image decoder, a video
// by seeking a hidden player. Those frames can take every effect that needs
// no drawing tool.

import { diskFileUrl } from '../diskUrl'
import { resolveMediaUrl } from '../useResolvedMedia'
import { isDataUrl, isMediaRef } from '../mediaRef'

/** Is this picture an animated GIF (its url, or the name it came in with)? */
export function isGifUrl(url: string | null | undefined, name?: string | null): boolean {
  if (!url) return false
  if (/^data:image\/gif[;,]/i.test(url)) return true
  if (name && /\.gif$/i.test(name.trim())) return true
  // A file referenced in place: /api/file?…&path=D:\…\x.gif
  try {
    const u = new URL(url, 'http://x')
    const p = u.searchParams.get('path')
    if (p && /\.gif$/i.test(p)) return true
    if (/\.gif$/i.test(decodeURIComponent(u.pathname))) return true
  } catch { /* not a url */ }
  return false
}

/** Frames per chunk, at most: a clip is cut into equal chunks of about this. */
export const CHUNK = 120
/** Each chunk is drawn with this many frames more on either side, which are
 *  then not used: the tools carry state from drawing to drawing (the
 *  outline's line strength, the scale's smoothing, optical flow), and a
 *  sequence that starts or ends at the chunk's edge draws its first and last
 *  frames differently — a visible jump in line weight at every seam. Even,
 *  so the drawings on twos fall on the same frames in every chunk. */
export const OVERLAP = 16

export interface ClipChunkPlan {
  /** The frames this chunk is for: [start, start + count). */
  start: number; count: number
  /** The frames read and drawn as one sequence: [lo, hi). */
  lo: number; hi: number
}

/** How a clip's frames [first, end) are cut into chunks: equal chunks (no
 *  short one at the end), each an even number of frames. Run and the motion
 *  preview cut the same way, so what one drew the other finds kept. */
export function clipChunks(first: number, end: number, n: number): ClipChunkPlan[] {
  const frames = Math.max(0, end - first)
  if (!frames) return []
  const size = 2 * Math.ceil(frames / Math.ceil(frames / CHUNK) / 2)
  const out: ClipChunkPlan[] = []
  for (let start = first; start < end; start += size) {
    const count = Math.min(size, end - start)
    out.push({ start, count, lo: Math.max(0, start - OVERLAP), hi: Math.min(n, start + count + OVERLAP) })
  }
  return out
}

/** An opened clip. Frames are numbered in the whole file; `first`..`end`
 *  is the part that plays (a trimmed clip's in and out points). */
export interface OpenClip {
  /** The sketch worker's id for it (desktop), or null when the page reads it. */
  workerId: string | null
  n: number
  fps: number
  w: number
  h: number
  first: number
  end: number
  /** Frames [lo, hi) as picture urls (fewer when the file ends early).
   *  `release` lets go of what the page made for them. */
  read(lo: number, hi: number): Promise<{ urls: string[]; release: () => void } | { error: string }>
}

/** What opens a clip: the source's stored url, its in and out points. */
export interface ClipRef { url: string; clipIn?: number; clipOut?: number; label?: string }

/** A clip's own file on this computer, for the worker: a file referenced in
 *  place as it is; a GIF kept inside the project written out first. */
async function onDisk(url: string): Promise<string | null> {
  if (url.startsWith('/')) return url
  const d = window.vidbarsDesktop
  if (!d?.saveImage || !(isMediaRef(url) || isDataUrl(url))) return null
  const src = await resolveMediaUrl(url)
  if (!src) return null
  try {
    const blob = await (await fetch(src)).blob()
    if (blob.type !== 'image/gif') return null
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(r.error)
      r.readAsDataURL(blob)
    })
    const saved = await d.saveImage('drag', 'clip.gif', dataUrl)
    const p = typeof saved === 'string' ? saved : saved && 'path' in saved ? saved.path : null
    return p ? diskFileUrl(p) : null
  } catch {
    return null
  }
}

/** The part of the file a trimmed clip plays. */
function span(ref: ClipRef, n: number, fps: number): { first: number; end: number } {
  const first = ref.clipIn ? Math.max(0, Math.min(n - 1, Math.floor(ref.clipIn * fps))) : 0
  const end = ref.clipOut ? Math.max(first + 1, Math.min(n, Math.ceil(ref.clipOut * fps))) : n
  return { first, end }
}

const opened = new Map<string, Promise<OpenClip | { error: string }>>()

/** Open a clip (once per url and trim; a failure is tried afresh next time). */
export function openClip(ref: ClipRef): Promise<OpenClip | { error: string }> {
  const key = `${ref.url}|${ref.clipIn ?? ''}|${ref.clipOut ?? ''}`
  const hit = opened.get(key)
  if (hit) return hit
  const p = open(ref).then(r => {
    if ('error' in r) opened.delete(key)
    return r
  })
  opened.set(key, p)
  return p
}

async function open(ref: ClipRef): Promise<OpenClip | { error: string }> {
  const d = window.vidbarsDesktop
  if (d?.sketchClip && d.sketchClipFrames) {
    const file = await onDisk(ref.url)
    if (file) {
      const info = await d.sketchClip(file)
      if (!('error' in info)) {
        const { first, end } = span(ref, info.n, info.fps)
        return {
          workerId: info.id, n: info.n, fps: info.fps, w: info.w, h: info.h, first, end,
          read: async (lo, hi) => {
            const got = await d.sketchClipFrames!({ id: info.id, start: lo, count: hi - lo })
            if ('error' in got) return got
            return { urls: got.paths.map(p => diskFileUrl(p)), release: () => {} }
          },
        }
      }
      // Fall through: the page may still read it (an older desktop main).
    }
  }
  return isGifUrl(ref.url, ref.label) || (await looksLikeGif(ref.url)) ? openGif(ref) : openVideo(ref)
}

async function looksLikeGif(url: string): Promise<boolean> {
  if (!isMediaRef(url)) return false
  const src = await resolveMediaUrl(url)
  if (!src) return false
  try { return (await (await fetch(src)).blob()).type === 'image/gif' } catch { return false }
}

/** Frames as small JPEG files the page holds, revoked on release. */
function frameUrl(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  if (canvas instanceof HTMLCanvasElement) {
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(URL.createObjectURL(b)) : reject(new Error('empty frame'))), 'image/jpeg', 0.92))
  }
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 }).then(b => URL.createObjectURL(b))
}

/** The page's own reading of a GIF: the browser's image decoder. */
async function openGif(ref: ClipRef): Promise<OpenClip | { error: string }> {
  type Decoder = {
    tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null }
    decode(o: { frameIndex: number }): Promise<{ image: { displayWidth: number; displayHeight: number; duration: number | null; close(): void } & CanvasImageSource }>
    close(): void
  }
  const ID = (window as unknown as { ImageDecoder?: new (o: { data: ReadableStream | ArrayBuffer; type: string }) => Decoder }).ImageDecoder
  if (!ID) return { error: 'This window cannot read GIF frames' }
  const src = await resolveMediaUrl(ref.url)
  if (!src) return { error: 'The GIF could not be found' }
  let data: ArrayBuffer
  try { data = await (await fetch(src)).arrayBuffer() } catch { return { error: 'The GIF could not be read' } }
  const dec = new ID({ data, type: 'image/gif' })
  await dec.tracks.ready
  const n = dec.tracks.selectedTrack?.frameCount ?? 0
  if (!n) return { error: 'The GIF has no frames' }
  const f0 = await dec.decode({ frameIndex: 0 })
  const w = f0.image.displayWidth, h = f0.image.displayHeight
  // A GIF's frames can each hold for their own time; the clip plays at
  // the first frame's rate (most GIFs hold every frame the same).
  const fps = f0.image.duration ? Math.max(1, Math.min(60, 1e6 / f0.image.duration)) : 10
  f0.image.close()
  const { first, end } = span(ref, n, fps)
  // GIF frames are often only the part that changed: each is decoded whole
  // by the decoder, so they can be read in any order.
  return {
    workerId: null, n, fps, w, h, first, end,
    read: async (lo, hi) => {
      const urls: string[] = []
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const g = c.getContext('2d')!
      try {
        for (let i = lo; i < Math.min(hi, n); i++) {
          const f = await dec.decode({ frameIndex: i })
          g.clearRect(0, 0, w, h)
          g.drawImage(f.image, 0, 0, w, h)
          f.image.close()
          urls.push(await frameUrl(c))
        }
      } catch (err) {
        urls.forEach(u => URL.revokeObjectURL(u))
        return { error: String((err as Error)?.message ?? err) }
      }
      return { urls, release: () => urls.forEach(u => URL.revokeObjectURL(u)) }
    },
  }
}

/** The page's own reading of a video: a hidden player, seeked frame by frame. */
async function openVideo(ref: ClipRef): Promise<OpenClip | { error: string }> {
  const src = await resolveMediaUrl(ref.url)
  if (!src) return { error: 'The video could not be found' }
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  v.crossOrigin = 'anonymous'
  const ok = await new Promise<boolean>(resolve => {
    v.onloadeddata = () => resolve(true)
    v.onerror = () => resolve(false)
    v.src = src
  })
  if (!ok || !v.videoWidth || !Number.isFinite(v.duration)) return { error: 'The video could not be read here' }
  // The page cannot ask a video its frame rate: 24, the film rate.
  const fps = 24
  const n = Math.max(1, Math.floor(v.duration * fps))
  const { first, end } = span(ref, n, fps)
  const w = v.videoWidth, h = v.videoHeight
  let lane: Promise<unknown> = Promise.resolve()
  const seek = (t: number) => new Promise<boolean>(resolve => {
    const timer = window.setTimeout(() => { v.onseeked = null; resolve(false) }, 8000)
    v.onseeked = () => { window.clearTimeout(timer); v.onseeked = null; resolve(true) }
    v.currentTime = t
  })
  return {
    workerId: null, n, fps, w, h, first, end,
    read: (lo, hi) => {
      const job = lane.then(async () => {
        const urls: string[] = []
        const c = document.createElement('canvas')
        // Long edge at most 1920: the page's frames are for looking at.
        const k = Math.min(1, 1920 / Math.max(w, h))
        c.width = Math.round(w * k); c.height = Math.round(h * k)
        const g = c.getContext('2d')!
        for (let i = lo; i < Math.min(hi, n); i++) {
          if (!(await seek((i + 0.5) / fps))) break
          g.drawImage(v, 0, 0, c.width, c.height)
          urls.push(await frameUrl(c))
        }
        return { urls, release: () => urls.forEach(u => URL.revokeObjectURL(u)) }
      })
      lane = job.catch(() => undefined)
      return job
    },
  }
}
