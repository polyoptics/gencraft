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
  return usePosterMapStore(s => (url && kind === 'model' ? s.map[url] ?? null : null))
}

/** Ask for a thumbnail. Cheap to call repeatedly; queued, deduped, capped
 *  concurrency. Models are NEVER generated implicitly — requestThumb on a
 *  model is a no-op unless `force` is true, because rendering a 44 MB GLB
 *  to draw a 72 px tile is what made the pool unusable. */
export function requestThumb(url: string, kind: ThumbKind, force?: boolean): void {
  if (!url) return
  if (kind !== 'model') return   // the dev server owns these — see the header
  if (!force) return

  const have = getModelPoster(url)
  if (have) { warmServerCache(url, have); return }

  if (waitingSet.has(url) || running.has(url)) return
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
    void ensureModelPoster(url)
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
