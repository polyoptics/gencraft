// magnetPreviewStore.ts — transient (non-persisted) state for the magnet
// docking affordance: while a model tile or model-bearing deck is being
// dragged within MAGNET_RADIUS of a viewport window edge, `preview` holds
// the ghost rect + target so MagnetDockPreview can render "will snap
// here". Cleared on drop / drag-away.

import { create } from 'zustand'
import type { DockEdge } from '../utils/viewportDocking'

export interface MagnetPreview {
  windowId: string
  edge: DockEdge
  x: number
  y: number
  width: number
  height: number
}

interface MagnetPreviewStore {
  preview: MagnetPreview | null
  setPreview: (p: MagnetPreview | null) => void
}

export const useMagnetPreviewStore = create<MagnetPreviewStore>()((set) => ({
  preview: null,
  setPreview: (p) => set(s => (s.preview === p ? s : { preview: p })),
}))
