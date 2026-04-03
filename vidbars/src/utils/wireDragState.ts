/**
 * Shared state for port-to-port wire dragging.
 * NLEBlock writes during drag; NLELayout renders the temp wire.
 */

export interface WireDrag {
  fromBlockId: string
  fromPort: 'top' | 'bottom'
  startX: number   // NLE layout coords
  startY: number
  currentX: number // NLE layout coords (follows cursor)
  currentY: number
}

let current: WireDrag | null = null
const listeners = new Set<() => void>()

export const wireDragState = {
  get: () => current,
  set: (v: WireDrag | null) => {
    current = v
    listeners.forEach(fn => fn())
  },
  subscribe: (fn: () => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },
}
