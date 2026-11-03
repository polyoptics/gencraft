// Debounced JSON storage for Zustand `persist`.
//
// Replaces the old `createJSONStorage(() => createDebouncedStorage(...))` pair.
// The key win: Zustand's `persist` middleware calls `storage.setItem(name,
// value)` on EVERY `set()` in the store. When wrapped with `createJSONStorage`,
// that path stringifies the entire store SYNCHRONOUSLY inside `setItem`, even
// if the underlying `localStorage` write is debounced downstream. With a
// large state (many boards, nested bars, text styles), that stringify is
// ~80ms per call — any loop of N sets costs N × 80ms on the main thread.
//
// By omitting `createJSONStorage`, Zustand hands us the raw state object
// (a `{ state, version }` envelope). We stash the latest reference, start a
// trailing-debounce timer, and only stringify + commit to localStorage once
// per idle window. Every `set()` then pays ~0ms until the debounce fires.
//
// Trade-off: if the tab is killed within the debounce window, the last few
// hundred ms of changes are lost. Same risk profile as the previous debounced
// storage — the cost has just moved from the write to include the stringify.
//
// Failure surfacing: localStorage has a tight quota in browser/Electron
// (~5–10 MB total across all keys, depending on the build). When the
// store grows past that ceiling, every subsequent setItem throws
// QuotaExceededError. Old code swallowed that error silently, leading
// to a particularly nasty failure mode: in-memory state advances normally,
// but every reload rehydrates the LAST PERSISTED state — which can be
// days old if the ceiling was hit days ago. We now dispatch a window
// CustomEvent('storage-write-failed') so a UI banner can surface the
// problem to the user immediately, plus log diagnostics to the console.

import type { PersistStorage, StorageValue } from 'zustand/middleware'

export interface StorageWriteFailedDetail {
  key: string
  errorName: string
  errorMessage: string
  isQuotaExceeded: boolean
  payloadBytes: number
  totalLocalStorageBytes: number
  timestamp: number
}

export interface StorageWriteOkDetail {
  key: string
}

/** Window events the StoragePersistenceBanner listens for. A failure is
 *  reported per store key; the next successful write of that key clears it. */
export const STORAGE_WRITE_FAILED = 'storage-write-failed'
export const STORAGE_WRITE_OK = 'storage-write-ok'

export function notifyStorageWriteOk(key: string): void {
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return
  try {
    window.dispatchEvent(new CustomEvent<StorageWriteOkDetail>(STORAGE_WRITE_OK, { detail: { key } }))
  } catch { /* ignore */ }
}

function isQuotaError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  // QuotaExceededError on Chrome/Edge/Electron, NS_ERROR_DOM_QUOTA_REACHED
  // on Firefox; some browsers also use code 22 / 1014 on DOMException.
  if (e.name === 'QuotaExceededError') return true
  if (e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true
  if (typeof DOMException !== 'undefined' && e instanceof DOMException) {
    if (e.code === 22 || e.code === 1014) return true
  }
  return false
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

export function createDebouncedJSONStorage<T>(delay = 400): PersistStorage<T> {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pending = new Map<string, StorageValue<T>>()

  const flush = (name: string) => {
    const value = pending.get(name)
    pending.delete(name)
    const t = timers.get(name)
    if (t) clearTimeout(t)
    timers.delete(name)
    if (value === undefined) return
    let payload: string
    try {
      payload = JSON.stringify(value)
    } catch (e) {
      // JSON.stringify can throw on circular refs etc. — surface it too.
      surfaceWriteFailure(name, e, 0)
      return
    }
    try {
      localStorage.setItem(name, payload)
      notifyStorageWriteOk(name)
    } catch (e) {
      surfaceWriteFailure(name, e, payload.length)
    }
  }

  const surfaceWriteFailure = (name: string, e: unknown, payloadBytes: number) => {
    const detail: StorageWriteFailedDetail = {
      key: name,
      errorName: (e instanceof Error ? e.name : 'Unknown'),
      errorMessage: (e instanceof Error ? e.message : String(e)),
      isQuotaExceeded: isQuotaError(e),
      payloadBytes,
      totalLocalStorageBytes: totalLocalStorageBytes(),
      timestamp: Date.now(),
    }
    // Loud log so even users without the banner see something in the
    // console. The banner picks this up via the dispatched event.
    // eslint-disable-next-line no-console
    console.error(
      `[debouncedJSONStorage] FAILED to persist "${name}":`,
      detail.errorName, '—', detail.errorMessage,
      `(payload ${payloadBytes} B, total localStorage ${detail.totalLocalStorageBytes} B)`,
    )
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      try {
        window.dispatchEvent(new CustomEvent(STORAGE_WRITE_FAILED, { detail }))
      } catch { /* ignore */ }
    }
  }

  // Flush any pending writes before the page unloads so in-flight work isn't lost.
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      for (const name of Array.from(pending.keys())) flush(name)
    })
    // pagehide is more reliable on mobile; safe to call twice (flush is idempotent).
    window.addEventListener('pagehide', () => {
      for (const name of Array.from(pending.keys())) flush(name)
    })
  }

  return {
    getItem: (name) => {
      try {
        const raw = localStorage.getItem(name)
        return raw ? (JSON.parse(raw) as StorageValue<T>) : null
      } catch {
        return null
      }
    },
    setItem: (name, value) => {
      // Cheap: just stash the envelope and (re)schedule the flush.
      pending.set(name, value)
      const existing = timers.get(name)
      if (existing) clearTimeout(existing)
      timers.set(name, setTimeout(() => flush(name), delay))
    },
    removeItem: (name) => {
      const existing = timers.get(name)
      if (existing) clearTimeout(existing)
      timers.delete(name)
      pending.delete(name)
      try {
        localStorage.removeItem(name)
      } catch { /* swallow */ }
    },
  }
}
