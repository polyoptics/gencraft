// Debounced IndexedDB storage for Zustand `persist`.
//
// Drop-in replacement for `createDebouncedJSONStorage`. Same debouncing
// semantics — every `set()` queues a write that flushes after `delay` ms
// of quiet — but the underlying store is a single shared IndexedDB
// database instead of localStorage. IDB has roughly hundreds-of-MB to
// GB-scale quotas (vs localStorage's 5–10 MB ceiling in Electron), so
// large persisted state (~30 MB boards + ~20 MB freenodes in this app)
// fits comfortably with room to grow.
//
// Migration: on the first read of a key that doesn't exist in IDB but
// DOES exist in localStorage, we copy the localStorage value into IDB
// and then `removeItem` the localStorage key. That frees the quota
// pressure that was causing silent save failures, and is one-shot —
// subsequent reads hit IDB only.
//
// Failure surfacing mirrors `debouncedJSONStorage`: a write that still
// fails after one retry fires a `storage-write-failed` window event, and
// every successful write fires `storage-write-ok`, so the
// StoragePersistenceBanner shows only problems that are still happening.
//
// Never write over saved data the store hasn't seen. Zustand's persist
// writes on every set(), including sets that run before the async IDB
// read has finished, when the store still holds its EMPTY defaults
// (startup, or a store module re-run by HMR). Hydration then restores the
// real data in memory without writing, so that queued empty write landed
// a moment later and the next reload came up blank. So:
//   - writes for a key are ignored until this storage has read that key
//     (hydration replaces that state anyway), and a read cancels any write
//     still queued from before it;
//   - if the read fails (after one retry), saving that key stays off for
//     the session and the banner says so, instead of saving defaults;
//   - with `isEmpty`, an empty value is only written over non-empty saved
//     data when this storage has itself seen that key hold content (so the
//     emptiness came from a delete in this session, not from a store that
//     never got its data).

import type { PersistStorage, StorageValue } from 'zustand/middleware'
import {
  STORAGE_WRITE_FAILED,
  notifyStorageWriteOk,
  type StorageWriteFailedDetail,
} from './debouncedJSONStorage'

const DB_NAME = 'vidbars-zustand'
const STORE_NAME = 'kv'
const DB_VERSION = 1
// How long to wait before retrying a failed write. Long enough for a
// passing transaction abort to clear, short enough that a real failure
// is reported while the artist is still at the same edit.
const RETRY_DELAY_MS = 1500

// Lazy singleton so multiple stores share one connection. Resolves on the
// first request and is reused for the lifetime of the page.
let dbPromise: Promise<IDBDatabase> | null = null

function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IDB open blocked — another tab is upgrading the schema'))
  })
  // If the open fails, allow another caller to retry by clearing the cache.
  dbPromise.catch(() => { dbPromise = null })
  return dbPromise
}

function idbGet<T = unknown>(key: string): Promise<T | null> {
  return getDB().then(db => new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(key)
    req.onsuccess = () => resolve((req.result as T) ?? null)
    req.onerror = () => reject(req.error)
  }))
}

function idbSet<T = unknown>(key: string, value: T): Promise<void> {
  return getDB().then(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'))
  }))
}

function idbDelete(key: string): Promise<void> {
  return getDB().then(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  }))
}

function totalLocalStorageBytes(): number {
  if (typeof localStorage === 'undefined') return 0
  let total = 0
  try {
    for (const k of Object.keys(localStorage)) {
      total += k.length + (localStorage.getItem(k)?.length ?? 0)
    }
  } catch { /* ignore */ }
  return total
}

function surfaceWriteFailure(name: string, e: unknown, payloadBytes: number) {
  const detail: StorageWriteFailedDetail = {
    key: name,
    errorName: (e instanceof Error ? e.name : 'Unknown'),
    errorMessage: (e instanceof Error ? e.message : String(e)),
    isQuotaExceeded:
      e instanceof Error &&
      (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'),
    payloadBytes,
    totalLocalStorageBytes: totalLocalStorageBytes(),
    timestamp: Date.now(),
  }
  // eslint-disable-next-line no-console
  console.error(
    `[debouncedIDBStorage] FAILED to persist "${name}":`,
    detail.errorName, '—', detail.errorMessage,
  )
  if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent(STORAGE_WRITE_FAILED, { detail }))
    } catch { /* ignore */ }
  }
}

/** Read a key: IDB first, then a one-shot migration from localStorage.
 *  Throws when IDB itself can't be read (as opposed to holding nothing). */
async function readSaved<T>(name: string): Promise<StorageValue<T> | null> {
  const idbValue = await idbGet<StorageValue<T>>(name)
  if (idbValue != null) return idbValue
  // Migration: nothing in IDB, but maybe localStorage has it from
  // before the swap. Copy across, then clear localStorage so we
  // free up the quota that was choking writes.
  if (typeof localStorage === 'undefined') return null
  const lsRaw = localStorage.getItem(name)
  if (!lsRaw) return null
  let parsed: StorageValue<T> | null = null
  try {
    parsed = JSON.parse(lsRaw) as StorageValue<T>
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[debouncedIDBStorage] migration parse failed for "${name}":`, e)
    return null
  }
  try {
    await idbSet(name, parsed)
    // Only clear localStorage AFTER IDB has the data — no
    // mid-migration data loss.
    localStorage.removeItem(name)
    // eslint-disable-next-line no-console
    console.info(
      `[debouncedIDBStorage] migrated "${name}" from localStorage → IDB ` +
      `(${lsRaw.length} bytes); localStorage entry removed.`,
    )
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[debouncedIDBStorage] migration write failed for "${name}":`, e)
    // Leave localStorage data in place; we'll retry next load.
  }
  return parsed
}

export interface DebouncedIDBStorageOptions<T> {
  /** True when a persisted state holds nothing worth keeping. Enables the
   *  empty-overwrite guard described at the top of this file. */
  isEmpty?: (state: T) => boolean
}

export function createDebouncedIDBStorage<T>(
  delay = 400,
  opts: DebouncedIDBStorageOptions<T> = {},
): PersistStorage<T> {
  // Per key: 'reading' until the saved value has been read, 'ready' once
  // writes are safe, 'failed' when it couldn't be read (saving stays off).
  // A key with no entry has not been read yet, so writes wait as well.
  const loadState = new Map<string, 'reading' | 'ready' | 'failed'>()
  // Keys this storage has seen hold content (read or written).
  const seenContent = new Set<string>()
  const isEmpty = opts.isEmpty
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pending = new Map<string, StorageValue<T>>()
  // Bumped on every setItem, so a retry can tell that a newer value has
  // since been queued or written and must not be overwritten.
  const generation = new Map<string, number>()

  const flush = async (name: string) => {
    const value = pending.get(name)
    pending.delete(name)
    const t = timers.get(name)
    if (t) clearTimeout(t)
    timers.delete(name)
    if (value === undefined) return
    const gen = generation.get(name)
    if (isEmpty && !seenContent.has(name) && isEmpty(value.state)) {
      // Empty, and this storage never saw the key hold anything: only
      // write it if what is saved is empty too.
      let saved: StorageValue<T> | null
      try { saved = await idbGet<StorageValue<T>>(name) } catch { return }
      if (generation.get(name) !== gen) return
      if (saved && !isEmpty(saved.state)) {
        // eslint-disable-next-line no-console
        console.warn(`[debouncedIDBStorage] refused to overwrite saved "${name}" with an empty state.`)
        return
      }
    }
    try {
      await idbSet(name, value)
      notifyStorageWriteOk(name)
      return
    } catch { /* retried below */ }
    // One retry: transactions can abort for passing reasons, and a single
    // blip is not lost work. If a newer value was set meanwhile, its own
    // flush supersedes this one and reports how it went.
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
    if (generation.get(name) !== gen) return
    try {
      await idbSet(name, value)
      notifyStorageWriteOk(name)
    } catch (e) {
      // Estimate payload size for diagnostics — cheap stringify; if it
      // blows up just report 0.
      let bytes = 0
      try { bytes = JSON.stringify(value).length } catch { /* ignore */ }
      surfaceWriteFailure(name, e, bytes)
    }
  }

  // Best-effort flush on unload. IDB writes are async so the page may
  // unload mid-transaction, but we kick them off either way — the
  // browser usually finishes pending IDB transactions even after
  // pagehide. (For 100% durability across hard kills we'd want explicit
  // flushes — see Snapshot save flow.)
  if (typeof window !== 'undefined') {
    const onLeave = () => {
      for (const name of Array.from(pending.keys())) {
        // Fire-and-forget; the browser will usually drain the IDB
        // queue before tearing down the context.
        void flush(name)
      }
    }
    window.addEventListener('beforeunload', onLeave)
    window.addEventListener('pagehide', onLeave)
  }

  return {
    getItem: async (name) => {
      // Anything queued before this read came from state the read is
      // about to replace: drop it.
      loadState.set(name, 'reading')
      const t = timers.get(name)
      if (t) clearTimeout(t)
      timers.delete(name)
      pending.delete(name)
      generation.set(name, (generation.get(name) ?? 0) + 1)
      let lastErr: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
        try {
          const value = await readSaved<T>(name)
          loadState.set(name, 'ready')
          if (value && isEmpty && !isEmpty(value.state)) seenContent.add(name)
          return value
        } catch (e) {
          lastErr = e
        }
      }
      // Couldn't read what is saved. The store will run on its defaults;
      // saving them would wipe the real data, so saving stays off.
      loadState.set(name, 'failed')
      // eslint-disable-next-line no-console
      console.error(`[debouncedIDBStorage] getItem failed for "${name}"; saving is off for it:`, lastErr)
      const why = lastErr instanceof Error ? lastErr.message : String(lastErr)
      surfaceWriteFailure(
        name,
        new Error(`Couldn't load saved data (${why}). Saving is paused so it isn't overwritten; reload to try again.`),
        0,
      )
      return null
    },
    setItem: (name, value) => {
      // Not before the saved value has been read (see top of file).
      if (loadState.get(name) !== 'ready') return
      if (isEmpty && !isEmpty(value.state)) seenContent.add(name)
      generation.set(name, (generation.get(name) ?? 0) + 1)
      pending.set(name, value)
      const existing = timers.get(name)
      if (existing) clearTimeout(existing)
      timers.set(name, setTimeout(() => flush(name), delay))
    },
    removeItem: async (name) => {
      const existing = timers.get(name)
      if (existing) clearTimeout(existing)
      timers.delete(name)
      pending.delete(name)
      generation.set(name, (generation.get(name) ?? 0) + 1)
      try { await idbDelete(name) } catch { /* swallow */ }
    },
  }
}
