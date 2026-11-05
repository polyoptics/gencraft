// clipFrames.ts — a small picture of one frame of a video: what a clip in the
// Rough Cut shows, so a movie split into shots shows each shot's own first
// frame instead of the whole movie's poster.
//
// Light on purpose: 160 px wide, made once per frame and kept for the page
// session only (never stored), one hidden video per file, one seek at a time.

import { useSyncExternalStore } from 'react'
import { resolveMediaUrl } from './useResolvedMedia'

const W = 160
const cache = new Map<string, string | null>()
const listeners = new Set<() => void>()
const queues = new Map<string, number[]>()
const busy = new Set<string>()

const keyOf = (url: string, t: number) => `${url}@${Math.round(t * 30)}`

/** A frame's picture if it has been made (null: not yet, or it failed). */
export function getClipFrame(url: string, t: number): string | null {
  return cache.get(keyOf(url, t)) ?? null
}

function seek(v: HTMLVideoElement, t: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = window.setTimeout(() => { v.onseeked = null; resolve(false) }, 8000)
    v.onseeked = () => { window.clearTimeout(timer); v.onseeked = null; resolve(true) }
    v.currentTime = t
  })
}

async function run(url: string): Promise<void> {
  if (busy.has(url)) return
  busy.add(url)
  const src = await resolveMediaUrl(url)
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  const ok = !!src && await new Promise<boolean>(resolve => {
    v.onloadeddata = () => resolve(true)
    v.onerror = () => resolve(false)
    window.setTimeout(() => resolve(false), 15000)
    v.src = src
  })
  const q = queues.get(url) ?? []
  const cnv = document.createElement('canvas')
  const ctx = cnv.getContext('2d')
  while (q.length) {
    const t = q.shift()!
    const key = keyOf(url, t)
    let out: string | null = null
    if (ok && ctx && v.videoWidth && await seek(v, t)) {
      cnv.width = W
      cnv.height = Math.max(1, Math.round(W * v.videoHeight / v.videoWidth))
      try {
        ctx.drawImage(v, 0, 0, cnv.width, cnv.height)
        const d = cnv.toDataURL('image/jpeg', 0.7)
        out = d.length > 64 ? d : null
      } catch { out = null }
    }
    cache.set(key, out)
    listeners.forEach(l => l())
  }
  v.removeAttribute('src')
  try { v.load() } catch { /* best effort */ }
  busy.delete(url)
  queues.delete(url)
}

function request(url: string, t: number): void {
  const key = keyOf(url, t)
  if (cache.has(key)) return
  cache.set(key, null)   // asked for: not asked again while it is made
  const q = queues.get(url) ?? []
  q.push(t)
  queues.set(url, q)
  void run(url)
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** The picture of the frame at `t` seconds into a video, made when first asked for. */
export function useClipFrame(url: string | null, t: number): string | null {
  const frame = useSyncExternalStore(subscribe, () => (url ? getClipFrame(url, t) : null))
  if (url && !cache.has(keyOf(url, t))) queueMicrotask(() => request(url, t))
  return frame
}
