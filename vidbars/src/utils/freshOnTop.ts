// The newest thing on the canvas draws over everything beside it.
//
// Free nodes and Viewers stack by kind (FreeNode's canvasZ, a Viewer's
// zIndex 1), so a new Viewer made over a Media Pool landed underneath it,
// and a new node could come up under a hovered or open one (Brian
// 2026-11-03). Whatever was added last, by any route (toolbar, canvas menu,
// a drop, an effect card), is lifted over its neighbours until it is moved:
// once it has been picked up and set down, it is placed, and stacks the
// ordinary way again.

import { create } from 'zustand'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useViewport3DStore } from '../store/viewport3dStore'

export const useFreshOnTop = create<{ id: string | null }>(() => ({ id: null }))

/** Lifted over its neighbours, under a drag in progress (a lifted tile, 65). */
export const FRESH_Z = 64

/** Where the fresh item was once its create had finished (a create adds,
 *  then sizes and places, in one go): moving off it ends the lift. */
let restAt: { x: number; y: number } | null = null

function watch<T extends { x: number; y: number }>(
  get: () => Record<string, T>,
  subscribe: (fn: () => void) => void,
) {
  let known = new Set(Object.keys(get()))
  subscribe(() => {
    const all = get()
    const added = Object.keys(all).filter(id => !known.has(id))
    known = new Set(Object.keys(all))
    // One at a time is a create. A project loading, or a batch coming back
    // with an undo, is not something new to lift.
    if (added.length === 1) {
      const id = added[0]
      useFreshOnTop.setState({ id })
      restAt = null
      setTimeout(() => {
        const n = get()[id]
        if (useFreshOnTop.getState().id === id && n) restAt = { x: n.x, y: n.y }
      }, 0)
      return
    }
    const fresh = useFreshOnTop.getState().id
    if (!fresh) return
    const n = all[fresh]
    if (!n) {
      if (!isLive(fresh)) { useFreshOnTop.setState({ id: null }); restAt = null }
      return
    }
    if (restAt && (n.x !== restAt.x || n.y !== restAt.y)) {
      useFreshOnTop.setState({ id: null })
      restAt = null
    }
  })
}

function isLive(id: string): boolean {
  return id in useFreeNodeStore.getState().nodes || id in useViewport3DStore.getState().windows
}

watch(() => useFreeNodeStore.getState().nodes, fn => useFreeNodeStore.subscribe(fn))
watch(() => useViewport3DStore.getState().windows, fn => useViewport3DStore.subscribe(fn))
