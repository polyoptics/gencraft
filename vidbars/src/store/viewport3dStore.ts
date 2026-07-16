// viewport3dStore.ts — persisted state for on-canvas 3D viewport windows.
//
// A viewport window is a canvas-space rectangle (pans/zooms with the world,
// sits UNDER other nodes) that renders a GLB/GLTF model via the shared
// WebGL renderer (src/three/viewportRenderer.ts). Only the window records
// persist here: which models are "docked" to a window is DERIVED from
// geometry (utils/viewportDocking.ts), never stored — matching how deck
// membership is derived in useCardDecks. `activeModelUrl` is the one piece
// of content state: the RAW media ref (`mediaref:` / path) of the model the
// window is currently showing.
//
// Camera persists per window (so a reload restores the view) but is
// STRIPPED from undo snapshots (an orbit is a "look", not an edit) —
// see undoCoordinator.ts.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'

export interface Viewport3DCamera {
  theta: number   // azimuth (rad)
  phi: number     // polar (rad), clamped away from poles
  radius: number  // dolly distance
  tx: number; ty: number; tz: number  // orbit target
}

export interface ViewportWindow3D {
  id: string
  x: number       // canvas units, top-left
  y: number
  width: number   // canvas units
  height: number
  title: string
  /** RAW ref of the model this window shows (docked list is derived). */
  activeModelUrl: string | null
  /** undefined ⇒ auto-frame the model on next load. */
  camera?: Viewport3DCamera
  createdAt: number
}

export const VIEWPORT3D_MIN_W = 240
export const VIEWPORT3D_MIN_H = 180
export const VIEWPORT3D_DEFAULT_W = 480
export const VIEWPORT3D_DEFAULT_H = 360

interface Viewport3DStore {
  windows: Record<string, ViewportWindow3D>
  addWindow: (x: number, y: number) => string
  moveWindow: (id: string, dx: number, dy: number) => void
  resizeWindow: (id: string, dw: number, dh: number) => void
  updateWindow: (id: string, patch: Partial<ViewportWindow3D>) => void
  removeWindow: (id: string) => void
  /** Also clears the camera so the new model auto-frames. */
  setActiveModel: (id: string, url: string | null) => void
  saveCamera: (id: string, cam: Viewport3DCamera) => void
}

export const useViewport3DStore = create<Viewport3DStore>()(persist((set) => ({
  windows: {},

  addWindow: (x, y) => {
    const id = crypto.randomUUID()
    const win: ViewportWindow3D = {
      id, x, y,
      width: VIEWPORT3D_DEFAULT_W,
      height: VIEWPORT3D_DEFAULT_H,
      title: '3D View',
      activeModelUrl: null,
      createdAt: Date.now(),
    }
    set(s => ({ windows: { ...s.windows, [id]: win } }))
    return id
  },

  moveWindow: (id, dx, dy) => {
    if (dx === 0 && dy === 0) return
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      return { windows: { ...s.windows, [id]: { ...w, x: w.x + dx, y: w.y + dy } } }
    })
  },

  resizeWindow: (id, dw, dh) =>
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      return {
        windows: {
          ...s.windows,
          [id]: {
            ...w,
            width: Math.max(VIEWPORT3D_MIN_W, w.width + dw),
            height: Math.max(VIEWPORT3D_MIN_H, w.height + dh),
          },
        },
      }
    }),

  updateWindow: (id, patch) =>
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      return { windows: { ...s.windows, [id]: { ...w, ...patch } } }
    }),

  removeWindow: (id) =>
    set(s => {
      const { [id]: _, ...rest } = s.windows
      return { windows: rest }
    }),

  setActiveModel: (id, url) =>
    set(s => {
      const w = s.windows[id]
      if (!w || w.activeModelUrl === url) return s
      return { windows: { ...s.windows, [id]: { ...w, activeModelUrl: url, camera: undefined } } }
    }),

  saveCamera: (id, cam) =>
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      return { windows: { ...s.windows, [id]: { ...w, camera: cam } } }
    }),
}), {
  name: 'vidbars-viewports3d',
  storage: createDebouncedIDBStorage(400),
  partialize: (s) => ({ windows: s.windows }),
  version: 1,
}))
