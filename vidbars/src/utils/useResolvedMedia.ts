// useResolvedMedia.ts — resolve a stored media value to a URL usable
// directly as <img src> or CSS url().
//
// Plain URLs (data: / http(s): / blob: / paths) pass through unchanged.
// A `mediaref:<id>` value is loaded from the blob store (mediaStore)
// exactly once and cached as an object URL for the page session, with
// every component that references the same id re-rendering when it
// resolves.
//
// Session cache (never revoked mid-session): an object URL is a cheap
// pointer to the already-stored blob, and revoking on unmount would
// churn/flicker as virtualized Rolodex rows and zoom-layer components
// mount and unmount. The (bounded) set of object URLs is released when
// the page unloads.

import { useSyncExternalStore } from 'react'
import { isMediaRef, mediaRefId } from './mediaRef'
import { getMedia } from './mediaStore'

type Status = 'loading' | 'ready' | 'missing' | 'error'
interface Entry {
  status: Status
  url: string | null
  listeners: Set<() => void>
}

const cache = new Map<string, Entry>()

function ensure(id: string): Entry {
  const existing = cache.get(id)
  if (existing) return existing
  const entry: Entry = { status: 'loading', url: null, listeners: new Set() }
  cache.set(id, entry)
  getMedia(id)
    .then(blob => {
      if (blob) {
        entry.url = URL.createObjectURL(blob)
        entry.status = 'ready'
      } else {
        entry.status = 'missing'
        console.warn(`[media] no blob stored for ${id}`)
      }
      entry.listeners.forEach(l => l())
    })
    .catch(err => {
      entry.status = 'error'
      console.warn(`[media] failed to load ${id}`, err)
      entry.listeners.forEach(l => l())
    })
  return entry
}

const NO_OP_UNSUB = () => {}

/** Resolve a media value to a render-ready URL, or null while loading /
 *  if missing. Hook-order-safe for any input (always calls the same
 *  hooks). Most callers can pass `getFirstImageUrl(...)` / `cardHeroImage`
 *  directly — a non-ref string is returned as-is. */
export function useResolvedMedia(ref: string | null | undefined): string | null {
  const id = isMediaRef(ref) ? mediaRefId(ref) : null

  const subscribe = (cb: () => void) => {
    if (!id) return NO_OP_UNSUB
    const entry = ensure(id)
    entry.listeners.add(cb)
    return () => { entry.listeners.delete(cb) }
  }
  // getSnapshot must return a STABLE value for unchanged state:
  // - passthrough: the original string (or null)
  // - mediaref: the cached object URL (same string ref once ready) or null
  const getSnapshot = (): string | null => {
    if (!id) return ref ?? null
    return ensure(id).url
  }
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
