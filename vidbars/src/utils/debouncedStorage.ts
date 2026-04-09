/**
 * Debounced localStorage wrapper for zustand persist.
 * Prevents serializing 98MB of state on every pixel of a drag.
 * Reads are instant; writes are batched with a trailing-edge debounce.
 */
export function createDebouncedStorage(delay = 500): Storage {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  return {
    get length() { return localStorage.length },
    key(index: number) { return localStorage.key(index) },
    getItem(name: string) { return localStorage.getItem(name) },
    setItem(name: string, value: string) {
      const existing = timers.get(name)
      if (existing) clearTimeout(existing)
      timers.set(name, setTimeout(() => {
        localStorage.setItem(name, value)
        timers.delete(name)
      }, delay))
    },
    removeItem(name: string) {
      const existing = timers.get(name)
      if (existing) clearTimeout(existing)
      localStorage.removeItem(name)
      timers.delete(name)
    },
    clear() { localStorage.clear() },
  }
}
