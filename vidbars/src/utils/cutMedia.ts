// cutMedia.ts — what a Rough Cut needs from its media: a strip of frames
// along each video (the clips in its timeline are drawn from them), a sound's
// waveform, and where each cut's playhead is, shared by its face and its
// timeline so zooming in and out keeps your place.

import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { resolveMediaUrl } from './useResolvedMedia'

// ── Frames along a video ──

export interface Filmstrip { duration: number; frames: string[] }
/** Frames per strip, evenly spaced through the video. */
const STRIP_FRAMES = 24
const stripCache = new Map<string, Promise<Filmstrip | null>>()
const stripDone = new Map<string, Filmstrip>()
/** One video decodes at a time: a cut with many clips doesn't stall. */
let stripQueue: Promise<unknown> = Promise.resolve()

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise(resolve => {
    const done = () => { v.removeEventListener('seeked', done); resolve() }
    v.addEventListener('seeked', done)
    window.setTimeout(done, 1500)
    v.currentTime = t
  })
}

function makeStrip(url: string): Promise<Filmstrip | null> {
  const job = stripQueue.then(async () => {
    const src = await resolveMediaUrl(url)
    if (!src) return null
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.crossOrigin = 'anonymous'
    v.src = src
    const ok = await new Promise<boolean>(resolve => {
      v.onloadeddata = () => resolve(true)
      v.onerror = () => resolve(false)
      window.setTimeout(() => resolve(false), 10000)
    })
    if (!ok || !(v.duration > 0)) { v.removeAttribute('src'); v.load(); return null }
    const h = 90, w = Math.round(h * (v.videoWidth / Math.max(1, v.videoHeight))) || 160
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d')
    const frames: string[] = []
    for (let i = 0; i < STRIP_FRAMES; i++) {
      await seek(v, Math.min(v.duration - 0.05, ((i + 0.5) / STRIP_FRAMES) * v.duration))
      try {
        g?.drawImage(v, 0, 0, w, h)
        frames.push(c.toDataURL('image/jpeg', 0.7))
      } catch { break }
    }
    const strip = { duration: v.duration, frames }
    v.removeAttribute('src')
    v.load()
    stripDone.set(url, strip)
    return frames.length ? strip : null
  })
  stripQueue = job.catch(() => null)
  return job
}

/** The frames along a video, made once per url (null until ready). */
export function useFilmstrip(url: string | null | undefined): Filmstrip | null {
  const [strip, setStrip] = useState<Filmstrip | null>(() => (url ? stripDone.get(url) ?? null : null))
  useEffect(() => {
    if (!url) { setStrip(null); return }
    const have = stripDone.get(url)
    if (have) { setStrip(have); return }
    let live = true
    let p = stripCache.get(url)
    if (!p) { p = makeStrip(url); stripCache.set(url, p) }
    void p.then(s => { if (live) setStrip(s) })
    return () => { live = false }
  }, [url])
  return strip
}

// ── A sound's waveform ──

const waveCache = new Map<string, Promise<{ duration: number; peaks: Float32Array } | null>>()

export function useWaveform(url: string | null | undefined): { duration: number; peaks: Float32Array } | null {
  const [wave, setWave] = useState<{ duration: number; peaks: Float32Array } | null>(null)
  useEffect(() => {
    if (!url) return
    let live = true
    let p = waveCache.get(url)
    if (!p) {
      p = (async () => {
        try {
          const src = await resolveMediaUrl(url)
          if (!src) return null
          const buf = await (await fetch(src)).arrayBuffer()
          const ctx = new OfflineAudioContext(1, 1, 44100)
          const audio = await ctx.decodeAudioData(buf)
          const data = audio.getChannelData(0)
          const n = 1200
          const peaks = new Float32Array(n)
          const step = Math.max(1, Math.floor(data.length / n))
          for (let i = 0; i < n; i++) {
            let m = 0
            for (let j = i * step, e = Math.min(data.length, j + step); j < e; j += 8) m = Math.max(m, Math.abs(data[j]))
            peaks[i] = m
          }
          return { duration: audio.duration, peaks }
        } catch { return null }
      })()
      waveCache.set(url, p)
    }
    void p.then(w => { if (live) setWave(w) })
    return () => { live = false }
  }, [url])
  return wave
}

// ── The playhead of each cut ──

interface CutPlayState {
  t: Record<string, number>
  playing: string | null
  setT: (cardId: string, t: number) => void
  setPlaying: (cardId: string | null) => void
}

/** Where each Rough Cut's playhead is (seconds into the cut), and which one
 *  is playing: one at a time. Not saved. */
export const useCutPlay = create<CutPlayState>(set => ({
  t: {},
  playing: null,
  setT: (cardId, t) => set(s => (s.t[cardId] === t ? s : { t: { ...s.t, [cardId]: t } })),
  setPlaying: cardId => set({ playing: cardId }),
}))
