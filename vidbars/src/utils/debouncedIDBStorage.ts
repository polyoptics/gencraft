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
// Failure surfacing mirrors `debouncedJSONStorage`: any error fires a
// `storage-write-failed` window event so the StoragePersistenceBanner
// can show it. (IDB failures are rare in practice — usually only on
// truly catastrophic disk-full scenarios — but we surface them anyway.)

import type { PersistStorage, StorageValue } from 'zustand/middleware'
import type { StorageWriteFailedDetail } from './debouncedJSONStorage'

const DB_NAME = 'vidbars-zustand'
const STORE_NAME = 'kv'
const DB_VERSION = 1

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
      window.dispatchEvent(new CustomEvent('storage-write-failed', { detail }))
    } catch { /* ignore */ }
  }
}

export function createDebouncedIDBStorage<T>(delay = 400): PersistStorage<T> {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pending = new Map<string, StorageValue<T>>()

  const flush = async (name: string) => {
    const value = pending.get(name)
    pending.delete(name)
    const t = timers.get(name)
    if (t) clearTimeout(t)
    timers.delete(name)
    if (value === undefined) return
    try {
      await idbSet(name, value)
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
      try {
        // Read from IDB first.
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
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[debouncedIDBStorage] getItem failed for "${name}":`, e)
        return null
      }
    },
    setItem: (name, value) => {
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
      try { await idbDelete(name) } catch { /* swallow */ }
    },
  }
}
