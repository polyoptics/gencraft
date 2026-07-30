// thumbService.ts — the one place that decides how a pool tile gets a picture.
//
// The pool used to answer that question by rendering EVERY model in the
// folder: 85 GLBs (two of them 44 MB) downloaded, parsed into three.js
// scenes and drawn offscreen so a 72 px tile would not be blank. That is
// 1077.9 MB of fetch and a 7.9 ms → 35.5 ms frame time for a panel nobody
// had scrolled yet. Nothing leaked — posterService disposes correctly — the
// work was simply unbounded.
//
// So the work is split by who can do it cheaply:
//
//   images  — the DEV SERVER does it. /api/browse hands each file a `thumb`
//             URL and /api/thumb encodes a 384 px copy on demand and keeps
//             it on disk. The client just points an <img> at it. There is
//             deliberately NO client-side canvas downscaler here: making a
//             thumbnail in the browser means decoding the full-size 8.5 MB
//             original first, which is the exact cost we are removing.
//   models  — only the browser can do it (it needs GL), so this service
//             brokers posterService: queued, deduped, capped, droppable,
//             and never started unless a caller explicitly asks.
//
// A model poster we do generate is also POSTed back to the dev server, so
// from the next session the same tile costs one cached read instead of a
// 44 MB download and a parse.
//
// NO NEW PERSISTED STORE, deliberately. Model posters already persist in
// posterService's map, and the server's disk cache plus HTTP caching covers
// everything else. A second IndexedDB map of data URLs would re-create the
// pathology posterService already demonstrates: a whole-map `partialize`
// behind a 400 ms debounce re-serialises a multi-megabyte JSON string on
// the main thread once per completion.

import { useEffect } from 'react'
import { ensureModelPoster, getModelPoster, usePosterMapStore } from '../three/posterService'

export type ThumbKind = 'image' | 'video' | 'audio' | 'model'

/** Two, not one: posterService renders strictly serially, so a second slot
 *  keeps one job warming up while another draws, and no more than that.
 *  Every extra slot is also a job that can no longer be dropped. */
const MAX_INFLIGHT = 2

/** A file that fails is worth one more try later — a model can fail simply
 *  because the shared renderer had not mounted yet — but not forever. */
const MAX_ATTEMPTS = 2
const RETRY_MS = 60_000

/** Uploading a poster is a loopback POST of a few hundred KB, cheap but not
 *  free, and only ever happens for models someone actually looked at. The
 *  cap is a backstop against a pathological folder, not a tuning knob. */
const MAX_UPLOADS = 300

const waiting: string[] = []
const waitingSet = new Set<string>()
const running = new Set<string>()
/** What each queued url IS, so pump can pick the right generator. */
const kindOf = new Map<string, ThumbKind>()

/** Live `useThumb` subscribers per url — see pump(). */
const retained = new Map<string, number>()
/** Urls that have been on screen at least once. Only these are droppable:
 *  a caller that never renders the hook cannot be judged by it. */
const seenOnScreen = new Set<string>()

const failures = new Map<string, { count: number; retryAt: number }>()
const uploaded = new Set<string>()

/** Cached thumbnail for a file, or null if none is available yet. Reactive. */
export function useThumb(url: string | null, kind: ThumbKind): string | null {
  // Mounting this hook IS the visibility signal. A tile that scrolls out of
  // the virtualised window unmounts, which is how a queued job gets dropped
  // instead of pulling a 44 MB GLB for something nobody is looking at.
  // Nothing has to remember to cancel; not rendering is the cancel.
  useEffect(() => {
    if (!url) return
    retain(url)
    return () => release(url)
  }, [url])

  // Models resolve through posterService's map rather than a copy of it:
  // one source of truth, already persisted, already handles invalidation
  // and url renames. Other kinds have no client-generated thumbnail at all
  // — their picture is the server's `thumb` URL from the listing.
  // Models AND videos resolve through posterService's map: one source of
  // truth, already persisted, already handling invalidation and renames.
  // Images get the server's `thumb` url instead, and audio gets a glyph.
  return usePosterMapStore(s =>
    (url && (kind === 'model' || kind === 'video') ? s.map[url] ?? null : null))
}

/** Ask for a thumbnail. Cheap to call repeatedly; queued, deduped, capped
 *  concurrency. Models are NEVER generated implicitly — requestThumb on a
 *  model is a no-op unless `force` is true, because rendering a 44 MB GLB
 *  to draw a 72 px tile is what made the pool unusable. */
export function requestThumb(url: string, kind: ThumbKind, force?: boolean): void {
  if (!url) return
  // Images belong to the dev server (see the header). Audio has no frame to
  // grab — a waveform would be a different feature, and a glyph is honest.
  if (kind !== 'model' && kind !== 'video') return
  // A video frame costs a seek on a file that is already being served, so it
  // does not need the explicit ask a 44 MB model does.
  if (kind === 'model' && !force) return
  kindOf.set(url, kind)

  const have = getModelPoster(url)
  if (have) { warmServerCache(url, have); return }

  if (waitingSet.has(url) || running.has(url)) return
  // An explicit ask always retries. The attempt cap exists to stop AUTOMATIC
  // retries looping on a file that cannot be read; applying it to a button
  // press turned that button into a silent no-op for the rest of the
  // session, with no way to tell it apart from a slow load.
  if (force) failures.delete(url)
  const f = failures.get(url)
  if (f && (f.count >= MAX_ATTEMPTS || Date.now() < f.retryAt)) return

  waiting.push(url)
  waitingSet.add(url)
  pump()
}

/** Non-reactive read. */
export function getThumb(url: string): string | null {
  return url ? getModelPoster(url) : null
}

/** Is this url queued or being generated right now? Lets a tile show that
 *  a click was received, instead of looking identical to one that was
 *  discarded. */
export function isThumbPending(url: string): boolean {
  return waitingSet.has(url) || running.has(url)
}

/** Has this url given up? Used to label the retry honestly. */
export function hasThumbFailed(url: string): boolean {
  return (failures.get(url)?.count ?? 0) >= MAX_ATTEMPTS
}

/** Drop everything not yet started — for closing a pool or jumping folders.
 *  Jobs already handed to posterService keep going: its generation queue is
 *  module-global with no abort path, so the honest guarantee here is that
 *  at most MAX_INFLIGHT models finish after you walk away, not zero. */
export function cancelThumbs(): void {
  waiting.length = 0
  waitingSet.clear()
}

function retain(url: string): void {
  retained.set(url, (retained.get(url) ?? 0) + 1)
  // Bounded by the folder, but a long session browsing many folders would
  // otherwise grow this forever. Clearing it only costs one stale job.
  if (seenOnScreen.size > 4000) seenOnScreen.clear()
  seenOnScreen.add(url)
}

function release(url: string): void {
  const n = (retained.get(url) ?? 0) - 1
  if (n > 0) retained.set(url, n)
  else retained.delete(url)
}

/** Grab a frame from a video, without ever touching a Blob.
 *
 *  The obvious route — fetch the file, make a Blob, read it — is closed in
 *  this runtime. A <video> pointed straight at the server url is not: it
 *  streams, we seek a little way in (frame 0 of a lot of footage is black or
 *  a fade), draw one frame, and read it back off a canvas as a data url.
 *  preload='metadata' keeps this from pulling the whole file. */
function captureVideoPoster(url: string): Promise<string | null> {
  return new Promise(resolve => {
    const v = document.createElement('video')
    let settled = false
    const done = (out: string | null) => {
      if (settled) return
      settled = true
      v.removeAttribute('src')
      try { v.load() } catch { /* releasing the decoder is best-effort */ }
      resolve(out)
    }
    v.muted = true
    v.playsInline = true
    v.preload = 'metadata'
    v.crossOrigin = 'anonymous'
    v.onloadedmetadata = () => {
      // A tenth of the way in, capped — far enough past a fade-in to be
      // representative, near enough that seeking stays cheap.
      const t = Math.min(1.5, (v.duration || 0) * 0.1)
      if (!Number.isFinite(t)) { done(null); return }
      v.currentTime = t
    }
    v.onseeked = () => {
      const w = v.videoWidth, h = v.videoHeight
      if (!w || !h) { done(null); return }
      const scale = Math.min(1, THUMB_W / w)
      const cnv = document.createElement('canvas')
      cnv.width = Math.max(1, Math.round(w * scale))
      cnv.height = Math.max(1, Math.round(h * scale))
      const ctx = cnv.getContext('2d')
      if (!ctx) { done(null); return }
      try {
        ctx.drawImage(v, 0, 0, cnv.width, cnv.height)
        const data = cnv.toDataURL('image/jpeg', 0.72)
        done(data.length > 64 ? data : null)
      } catch { done(null) }     // a tainted canvas lands here, not in a throw
    }
    v.onerror = () => done(null)
    // A file that never fires metadata must not hold a queue slot forever.
    setTimeout(() => done(null), 15_000)
    v.src = url
  })
}

/** The one poster width. Matches the server's thumbnail width so a video
 *  frame and an image thumbnail carry the same weight in the grid. */
const THUMB_W = 384

function pump(): void {
  while (running.size < MAX_INFLIGHT && waiting.length > 0) {
    const url = waiting.shift()!
    waitingSet.delete(url)

    // Dropped, not deferred: this tile has left the screen since it asked.
    if (seenOnScreen.has(url) && !retained.has(url)) continue

    // It may have arrived while this job sat in the queue.
    const have = getModelPoster(url)
    if (have) { warmServerCache(url, have); continue }

    running.add(url)
    // Videos grab a frame; everything else in this queue is a model.
    const job = kindOf.get(url) === 'video'
      ? captureVideoPoster(url).then(data => {
          if (data) usePosterMapStore.getState().setPoster(url, data)
          return data
        })
      : ensureModelPoster(url)
    void job
      .then(res => {
        if (res) { failures.delete(url); warmServerCache(url, res) }
        else noteFailure(url)
      })
      .catch(() => noteFailure(url))
      .finally(() => { running.delete(url); pump() })
  }
}

function noteFailure(url: string): void {
  const count = (failures.get(url)?.count ?? 0) + 1
  failures.set(url, { count, retryAt: Date.now() + RETRY_MS })
}

/** Hand a generated poster to the dev server so the next session reads it
 *  off disk instead of re-downloading and re-parsing the model. Silent and
 *  serialised — this is an optimisation, and a pool whose server predates
 *  the endpoint must behave exactly as it does today. */
function warmServerCache(url: string, dataUrl: string): void {
  if (uploaded.has(url) || uploaded.size >= MAX_UPLOADS) return
  // Only server-served files can be filed under a disk path. A localised
  // 'mediaref:' model is not one, and neither is a bare data: url.
  if (!url.startsWith('/')) return
  // Posters are canvas.toDataURL('image/png') — never blob: bytes, which
  // this runtime cannot read back above ~256 B (an <img> on the object url
  // decodes 0x0 and arrayBuffer() throws NotReadableError, both landing in
  // the same silent catch as a 404). If this ever needs resizing it must
  // stay <img> → drawImage → canvas.toDataURL.
  if (!dataUrl.startsWith('data:image/') || dataUrl.length > 4_000_000) return

  uploaded.add(url)
  uploadChain = uploadChain
    .then(() => fetch('/api/thumb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, dataUrl }),
    }))
    .catch(() => { /* dev-server nicety; nothing in the pool depends on it */ })
}

let uploadChain: Promise<unknown> = Promise.resolve()
