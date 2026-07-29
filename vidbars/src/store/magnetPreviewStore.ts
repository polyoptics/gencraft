// magnetPreviewStore.ts — transient (non-persisted) "will snap here" state.
//
// Originally this only described a tile approaching a VIEWER, so it stored
// a windowId and let the renderer look the window up. That made the
// affordance impossible to reuse: panel-to-panel snaps have no window, and
// pinned snaps are not even in canvas coordinates. Since the magnet is the
// same gesture everywhere, the preview now carries everything it needs —
// where the dragged thing lands, which edge of what it meets, and which
// space those numbers are in — and no longer knows what kind of thing is
// on either end.

import { create } from 'zustand'
import type { DockEdge } from '../utils/viewportDocking'

export interface Rect { x: number; y: number; width: number; height: number }

export interface MagnetPreview {
  /** Where the dragged thing will come to rest. */
  x: number
  y: number
  width: number
  height: number
  /** Which edge of the target it will meet — the edge that gets the glow. */
  edge: DockEdge
  /** The target's rect, so the glow can be drawn without a lookup. */
  target: Rect
  /** CANVAS units, or SCREEN pixels for pinned things. Decides which layer
   *  draws it: the two strata never mix. */
  space: 'canvas' | 'screen'
  /** Set only when the target is a Viewer, because dropping there also
   *  loads the content. A panel-to-panel snap has no window and must not
   *  be forced to invent one. */
  windowId?: string
}

interface MagnetPreviewStore {
  preview: MagnetPreview | null
  setPreview: (p: MagnetPreview | null) => void
}

export const useMagnetPreviewStore = create<MagnetPreviewStore>()((set) => ({
  preview: null,
  setPreview: (p) => set(s => (s.preview === p ? s : { preview: p })),
}))
