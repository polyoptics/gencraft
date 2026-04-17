import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createDebouncedStorage } from '../utils/debouncedStorage'

const MIN_ZOOM = 0.11
const MAX_ZOOM = 4

interface CanvasStore {
  pan: { x: number; y: number }
  zoom: number
  boardPos: { x: number; y: number }
  nleRowHeight: number
  dynamicRowHeights: boolean
  focusedBoardId: string | null
  selectedBlockBoardIds: string[]
  zoneLineY: number

  setPan: (pan: { x: number; y: number }) => void
  setZoom: (zoom: number) => void
  shiftPan: (dx: number, dy: number) => void
  zoomAtPoint: (factor: number, mx: number, my: number) => void
  setBoardPos: (pos: { x: number; y: number }) => void
  shiftBoardPos: (dx: number, dy: number) => void
  setNleRowHeight: (h: number) => void
  toggleDynamicRowHeights: () => void
  setFocusedBoard: (id: string | null) => void
  setSelectedBlockBoardIds: (ids: string[]) => void
  clearSelectedBlockBoardIds: () => void
  setZoneLineY: (y: number) => void
}

export const useCanvasStore = create<CanvasStore>()(persist((set, get) => ({
  pan: { x: 0, y: 0 },
  zoom: 1,
  boardPos: { x: 0, y: 0 },
  nleRowHeight: 300,
  dynamicRowHeights: false,
  focusedBoardId: null,
  selectedBlockBoardIds: [],
  zoneLineY: 0,

  setPan: (pan) => set({ pan }),

  setZoom: (zoom) => set({ zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)) }),

  shiftPan: (dx, dy) =>
    set(s => ({ pan: { x: s.pan.x + dx, y: s.pan.y + dy } })),

  zoomAtPoint: (factor, mx, my) => {
    const { zoom, pan } = get()
    let newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor))
    if (Math.abs(newZoom - zoom) < 1e-8) return
    const ratio = newZoom / zoom
    set({
      zoom: newZoom,
      pan: {
        x: mx - (mx - pan.x) * ratio,
        y: my - (my - pan.y) * ratio,
      },
    })
  },

  setBoardPos: (boardPos) => set({ boardPos }),

  shiftBoardPos: (dx, dy) =>
    set(s => ({ boardPos: { x: s.boardPos.x + dx, y: s.boardPos.y + dy } })),

  setNleRowHeight: (nleRowHeight) => set({ nleRowHeight }),

  toggleDynamicRowHeights: () => set(s => ({ dynamicRowHeights: !s.dynamicRowHeights })),

  setFocusedBoard: (focusedBoardId) => set({ focusedBoardId }),

  setSelectedBlockBoardIds: (selectedBlockBoardIds) => set({ selectedBlockBoardIds }),
  clearSelectedBlockBoardIds: () => set({ selectedBlockBoardIds: [] }),

  setZoneLineY: (zoneLineY) => set({ zoneLineY }),
}), {
  name: 'vidbars-canvas',
  storage: createJSONStorage(() => createDebouncedStorage(500)),
  partialize: (s) => ({
    pan: s.pan,
    zoom: s.zoom,
    boardPos: s.boardPos,
    nleRowHeight: s.nleRowHeight,
    dynamicRowHeights: s.dynamicRowHeights,
    zoneLineY: s.zoneLineY,
  }),
  version: 1,
  migrate: (persisted: any, version: number) => {
    if (version < 1) {
      persisted.zoneLineY = 0
    }
    return persisted
  },
}))
