/**
 * Shared mutable state for grip-drag in progress.
 * NLEBlock writes it during drag; NLELayout reads it for wire offset.
 * We use a simple callback subscription so NLELayout can re-render when it changes.
 */

export interface GripDrag {
  blockId: string
  offsetY: number
  snappedRow: number  // the row the block is visually snapped to
}

let current: GripDrag | null = null
const listeners = new Set<() => void>()

export const gripDragState = {
  get: () => current,
  set: (v: GripDrag | null) => {
    current = v
    listeners.forEach(fn => fn())
  },
  subscribe: (fn: () => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },
}
