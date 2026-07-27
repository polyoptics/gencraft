// viewport3dStore.ts — persisted state for on-canvas CONTENT BROWSER
// windows ("Viewers").
//
// A viewer window is a canvas-space rectangle (pans/zooms with the world,
// sits UNDER other nodes) that renders its ACTIVE ITEM by type: models
// via the shared WebGL renderer (src/three/viewportRenderer.ts), images/
// video/audio/text via DOM views (Viewport3D/ContentViews.tsx). Only the
// window records persist here: which content is "docked" to a window is
// DERIVED from geometry (utils/viewportDocking.ts), never stored —
// matching how deck membership is derived in useCardDecks. `activeItem`
// is the one piece of content state.
//
// Camera persists per window (so a reload restores the view) but is
// STRIPPED from undo snapshots (an orbit is a "look", not an edit) —
// see undoCoordinator.ts. `cameraUrl` records which MODEL owns the saved
// camera, so browsing away to an image/text page and back to the same
// model restores the orbit; only a different model resets it.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'
import type { MediaType } from '../types/bar'

export interface Viewport3DCamera {
  theta: number   // azimuth (rad)
  phi: number     // polar (rad), clamped away from poles
  radius: number  // dolly distance
  tx: number; ty: number; tz: number  // orbit target
}

/** What a browser window shows. Media items carry the raw ref (the bytes
 *  resolve via useResolvedMedia); text items carry a source pointer and
 *  resolve their content live from the stores at render time. */
export type ActiveItem =
  | { kind: 'media'; mediaType: MediaType; url: string; posterUrl?: string | null; name?: string }
  | { kind: 'text'; sourceId: string; name?: string }
  // text sourceId forms: 'bar:<boardId>:<barId>' | 'group:<groupId>' | 'tile:<nodeId>'

/** Stable identity for equality, dedupe, and strip-active matching. */
export function activeItemKey(i: ActiveItem | null | undefined): string | null {
  if (!i) return null
  return i.kind === 'media' ? `media:${i.url}` : `text:${i.sourceId}`
}

export interface ViewportWindow3D {
  id: string
  x: number       // canvas units, top-left
  y: number
  width: number   // canvas units
  height: number
  title: string
  /** What this window is showing (docked content list is derived). */
  activeItem: ActiveItem | null
  /** undefined ⇒ auto-frame the model on next load. */
  camera?: Viewport3DCamera
  /** The model url `camera` was saved for — see header comment. */
  cameraUrl?: string
  /** VIEW-ONLY text zoom for this window (1 = the source's own sizes).
   *  Purely how big text renders HERE — never touches the card. */
  textScale?: number
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
  /** Clears the camera ONLY when a DIFFERENT model takes over. */
  setActiveItem: (id: string, item: ActiveItem | null) => void
  saveCamera: (id: string, cam: Viewport3DCamera) => void
  /** View-only text zoom (does NOT edit any card). */
  setTextScale: (id: string, scale: number) => void
}

export const useViewport3DStore = create<Viewport3DStore>()(persist((set) => ({
  windows: {},

  addWindow: (x, y) => {
    const id = crypto.randomUUID()
    const win: ViewportWindow3D = {
      id, x, y,
      width: VIEWPORT3D_DEFAULT_W,
      height: VIEWPORT3D_DEFAULT_H,
      title: 'Viewer',
      activeItem: null,
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

  setActiveItem: (id, item) =>
    set(s => {
      const w = s.windows[id]
      if (!w || activeItemKey(w.activeItem) === activeItemKey(item)) return s
      const nextModel = item?.kind === 'media' && item.mediaType === 'model' ? item.url : null
      // Camera resets only when a DIFFERENT model takes over; it survives
      // image/video/text excursions so returning to the model restores
      // the orbit.
      const resetCam = nextModel !== null && nextModel !== w.cameraUrl
      return {
        windows: {
          ...s.windows,
          [id]: {
            ...w, activeItem: item,
            ...(resetCam ? { camera: undefined, cameraUrl: undefined } : {}),
          },
        },
      }
    }),

  saveCamera: (id, cam) =>
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      const url = w.activeItem?.kind === 'media' && w.activeItem.mediaType === 'model'
        ? w.activeItem.url
        : w.cameraUrl
      return { windows: { ...s.windows, [id]: { ...w, camera: cam, cameraUrl: url } } }
    }),

  setTextScale: (id, scale) =>
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      // Wide range on purpose: the whole point is fitting a long page
      // into a small window, so allow going properly small.
      const clamped = Math.max(0.08, Math.min(5, scale))
      if (w.textScale === clamped) return s
      return { windows: { ...s.windows, [id]: { ...w, textScale: clamped } } }
    }),
}), {
  name: 'vidbars-viewports3d',
  storage: createDebouncedIDBStorage(400),
  partialize: (s) => ({ windows: s.windows }),
  // v2: activeModelUrl → discriminated activeItem; '3D View' → 'Viewer';
  // camera ownership recorded in cameraUrl.
  version: 2,
  migrate: (persisted, version) => {
    const p = persisted as { windows?: Record<string, ViewportWindow3D & { activeModelUrl?: string | null }> }
    if (version < 2 && p?.windows) {
      for (const w of Object.values(p.windows)) {
        w.activeItem = w.activeModelUrl
          ? { kind: 'media', mediaType: 'model', url: w.activeModelUrl }
          : null
        if (w.camera && w.activeModelUrl) w.cameraUrl = w.activeModelUrl
        delete w.activeModelUrl
        if (w.title === '3D View') w.title = 'Viewer'
      }
    }
    return p as never
  },
}))
