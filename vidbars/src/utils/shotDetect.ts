// shotDetect.ts — find the cuts in a video: where one shot ends and the next begins.
//
// The video plays through once, hidden and fast, and every frame it shows is
// shrunk to a few hundred pixels and boiled down to its colours. A cut is a
// frame whose colours jump far more than the frames around it move; that
// keeps camera moves and flashes inside a shot from counting. Each cut found
// is then pinned to the frame by seeking back and forth between the two
// frames either side of it.

import { resolveMediaUrl } from './useResolvedMedia'

const SW = 32, SH = 18
/** Colour bins per channel (4 → 64 bins). */
const BINS = 4
/** How fast the hidden video plays through (frames still arrive one by one). */
const SCAN_RATE = 4
/** A jump must be at least this (0..1) to be a cut at all… */
const ABS_MIN = 0.28
/** …and this many times bigger than the usual frame-to-frame change around it. */
const RATIO = 3
/** Shots shorter than this are not split off (seconds). */
const MIN_SHOT = 0.25

interface Sig { hist: Float32Array; luma: Float32Array }
interface Sample { t: number; sig: Sig }

function sigOf(ctx: CanvasRenderingContext2D, v: HTMLVideoElement): Sig {
  ctx.drawImage(v, 0, 0, SW, SH)
  const px = ctx.getImageData(0, 0, SW, SH).data
  const hist = new Float32Array(BINS * BINS * BINS)
  const luma = new Float32Array(SW * SH)
  const k = 256 / BINS
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const r = px[i], g = px[i + 1], b = px[i + 2]
    hist[((r / k) | 0) * BINS * BINS + ((g / k) | 0) * BINS + ((b / k) | 0)]++
    luma[p] = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  }
  const n = SW * SH
  for (let i = 0; i < hist.length; i++) hist[i] /= n
  return { hist, luma }
}

/** How different two frames are, 0 (same) to 1: their colours, and their pictures. */
export function sigDistance(a: Sig, b: Sig): number {
  let h = 0
  for (let i = 0; i < a.hist.length; i++) h += Math.abs(a.hist[i] - b.hist[i])
  let l = 0
  for (let i = 0; i < a.luma.length; i++) l += Math.abs(a.luma[i] - b.luma[i])
  l /= a.luma.length
  // A cut changes both what is where and which colours there are.
  return Math.min(1, 0.5 * (h / 2) + 0.5 * Math.min(1, l * 3))
}

/** Which jumps between neighbouring samples are cuts: the index of the sample after each. */
export function pickCuts(d: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < d.length; i++) {
    if (d[i] < ABS_MIN) continue
    const around: number[] = []
    for (let j = Math.max(1, i - 6); j <= Math.min(d.length - 1, i + 6); j++) if (j !== i) around.push(d[j])
    around.sort((a, b) => a - b)
    const usual = around.length ? around[Math.floor(around.length / 2)] : 0
    if (d[i] >= RATIO * Math.max(usual, 0.03)) out.push(i)
  }
  return out
}

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise(resolve => {
    const done = () => { v.removeEventListener('seeked', done); resolve() }
    v.addEventListener('seeked', done)
    v.currentTime = t
  })
}

function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    // On the page (but unseen), so the browser keeps handing it frames.
    v.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:36px;opacity:0;pointer-events:none;z-index:-1'
    document.body.appendChild(v)
    v.onloadeddata = () => resolve(v)
    v.onerror = () => { v.remove(); reject(new Error('The video could not be opened.')) }
    v.src = src
  })
}

type FrameCb = (now: number, meta: { mediaTime: number }) => void
type RvfcVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: FrameCb) => number; cancelVideoFrameCallback?: (h: number) => void }

/** Every frame from `from` to `to`, played through fast. */
async function scanPlaying(v: RvfcVideo, ctx: CanvasRenderingContext2D, from: number, to: number, progress: (f: number) => void, cancelled: () => boolean): Promise<Sample[]> {
  const out: Sample[] = []
  await seek(v, from)
  out.push({ t: from, sig: sigOf(ctx, v) })
  return new Promise((resolve, reject) => {
    let handle = 0, stall = 0, lastT = from
    const finish = () => { v.pause(); window.clearInterval(stall); v.cancelVideoFrameCallback?.(handle); resolve(out) }
    const onFrame: FrameCb = (_now, meta) => {
      if (cancelled()) { finish(); return }
      const t = meta.mediaTime
      if (t > lastT + 1e-4) {
        out.push({ t, sig: sigOf(ctx, v) })
        lastT = t
        progress((t - from) / Math.max(1e-3, to - from))
      }
      if (t >= to - 1e-3 || v.ended) { finish(); return }
      handle = v.requestVideoFrameCallback!(onFrame)
    }
    handle = v.requestVideoFrameCallback!(onFrame)
    v.onended = finish
    // If frames stop coming (the browser paused it), say so rather than hang.
    let seen = -1
    stall = window.setInterval(() => {
      if (out.length === seen) { window.clearInterval(stall); v.pause(); reject(new Error('stalled')) }
      seen = out.length
    }, 4000)
    v.playbackRate = SCAN_RATE
    v.play().catch(err => { window.clearInterval(stall); reject(err) })
  })
}

/** The slow way, when the video will not play: a frame every tenth of a second. */
async function scanSeeking(v: HTMLVideoElement, ctx: CanvasRenderingContext2D, from: number, to: number, progress: (f: number) => void, cancelled: () => boolean): Promise<Sample[]> {
  const out: Sample[] = []
  for (let t = from; t <= to + 1e-6 && !cancelled(); t += 0.1) {
    await seek(v, Math.min(t, to))
    out.push({ t: Math.min(t, to), sig: sigOf(ctx, v) })
    progress((t - from) / Math.max(1e-3, to - from))
  }
  return out
}

/** Pin a cut between two frames to the first frame of the new shot, by seeking. */
async function refine(v: HTMLVideoElement, ctx: CanvasRenderingContext2D, a: Sample, b: Sample): Promise<number> {
  let lo = a.t, hi = b.t
  while (hi - lo > 1 / 120) {
    const mid = (lo + hi) / 2
    await seek(v, mid)
    const s = sigOf(ctx, v)
    if (sigDistance(s, b.sig) < sigDistance(s, a.sig)) hi = mid
    else lo = mid
  }
  return hi
}

/** The times (seconds into the video) where a new shot starts, between `from` and `to`.
 *  `progress` hears 0..1 as it goes; `cancelled` stops it early. */
export async function findCuts(
  url: string, from: number, to: number,
  progress: (f: number) => void = () => {}, cancelled: () => boolean = () => false,
): Promise<number[]> {
  const src = await resolveMediaUrl(url)
  if (!src) throw new Error('The video is not stored here.')
  const v = await loadVideo(src) as RvfcVideo
  try {
    to = Math.min(to, Number.isFinite(v.duration) ? v.duration : to)
    const canvas = document.createElement('canvas')
    canvas.width = SW
    canvas.height = SH
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const scan = (f: number) => progress(Math.min(1, f) * 0.85)
    let samples: Sample[]
    try {
      if (!v.requestVideoFrameCallback) throw new Error('no frame callback')
      samples = await scanPlaying(v, ctx, from, to, scan, cancelled)
    } catch {
      samples = await scanSeeking(v, ctx, from, to, scan, cancelled)
    }
    if (cancelled()) return []
    const d = samples.map((s, i) => (i ? sigDistance(samples[i - 1].sig, s.sig) : 0))
    const picks = pickCuts(d)
    const cuts: number[] = []
    for (let k = 0; k < picks.length; k++) {
      if (cancelled()) return []
      const i = picks[k]
      const t = await refine(v, ctx, samples[i - 1], samples[i])
      if (t - from >= MIN_SHOT && to - t >= MIN_SHOT && (!cuts.length || t - cuts[cuts.length - 1] >= MIN_SHOT)) cuts.push(t)
      progress(0.85 + 0.15 * (k + 1) / picks.length)
    }
    progress(1)
    return cuts
  } finally {
    v.pause()
    v.removeAttribute('src')
    v.load()
    v.remove()
  }
}
