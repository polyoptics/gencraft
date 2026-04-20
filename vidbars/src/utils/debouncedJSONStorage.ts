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

import type { PersistStorage, StorageValue } from 'zustand/middleware'

export function createDebouncedJSONStorage<T>(delay = 400): PersistStorage<T> {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pending = new Map<string, StorageValue<T>>()

  const flush = (name: string) => {
    const value = pending.get(name)
    pending.delete(name)
    const t = timers.get(name)
    if (t) clearTimeout(t)
    timers.delete(name)
    if (value !== undefined) {
      try {
        localStorage.setItem(name, JSON.stringify(value))
      } catch {
        // localStorage full or unavailable — swallow, next write will retry
      }
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
