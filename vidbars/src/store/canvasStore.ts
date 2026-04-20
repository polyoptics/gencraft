import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedJSONStorage } from '../utils/debouncedJSONStorage'
import { useBoardsStore } from './boardsStore'
import { computeGroupLayout, getRowY, getRowHeight } from '../utils/nleRows'
import { DEFAULT_H } from '../utils/barConstants'

const MIN_ZOOM = 0.11
const MAX_ZOOM = 4
const APP_TOOLBAR_H = 38
const BOARD_PADDING_X = 20

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
  /** Pan (keeping current zoom) so the given group is centered in the viewport. */
  jumpToGroup: (groupId: string) => void
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

  jumpToGroup: (groupId) => {
    const bs = useBoardsStore.getState()
    const group = bs.groups.find(g => g.id === groupId)
    if (!group) return

    // Compute the group's canvas bounds — mirrors GroupCard's geometry math.
    const layout = computeGroupLayout(group.boardIds, bs.boards)
    let minX = Infinity, maxX = -Infinity, topY = Infinity, bottomY = -Infinity
    for (const bid of group.boardIds) {
      const board = bs.boards[bid]
      if (!board) continue
      const bScale = board.boardScale ?? 1
      const roots = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
      if (roots.length === 0) continue
      const bx = group.originX + (board.nleX ?? 0)
      const by = group.originY + getRowY(board.nleRow ?? 0, layout)
      const rowH = getRowHeight(board.nleRow ?? 0, layout)
      const rootH = Math.max(...roots.map(b => b.height), DEFAULT_H) * bScale
      const visualH = Math.max(rowH, rootH)
      const lo = Math.min(...roots.map(b => b.x))
      const hi = Math.max(...roots.map(b => b.x + b.width))
      const l = bx + BOARD_PADDING_X + lo * bScale - 16
      const r = bx + BOARD_PADDING_X + hi * bScale + 16
      if (l < minX) minX = l
      if (r > maxX) maxX = r
      if (by < topY) topY = by
      if (by + visualH > bottomY) bottomY = by + visualH
    }
    if (minX === Infinity) return // nothing to center on

    const finalW = Math.max(maxX - minX, group.cardWidthOverride ?? 0)
    const finalH = Math.max(bottomY - topY, group.cardHeightOverride ?? 0)
    const centerCX = minX + finalW / 2
    const centerCY = topY + finalH / 2

    const z = get().zoom
    const vpW = window.innerWidth
    const vpH = window.innerHeight - APP_TOOLBAR_H
    set({
      pan: {
        x: vpW / 2 - centerCX * z,
        y: vpH / 2 - centerCY * z,
      },
    })
  },
}), {
  name: 'vidbars-canvas',
  storage: createDebouncedJSONStorage(400),
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
