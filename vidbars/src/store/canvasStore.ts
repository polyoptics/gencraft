import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedJSONStorage } from '../utils/debouncedJSONStorage'
import { useBoardsStore } from './boardsStore'
import { computeGroupLayout, getRowY, getRowHeight } from '../utils/nleRows'
import { DEFAULT_H } from '../utils/barConstants'
import {
  type DrawSurface,
  DEFAULT_PEN_COLOR,
  DEFAULT_PEN_SIZE,
} from '../types/stroke'

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
  /** IDs of extracted cards whose ghost slot is currently selected. Pressing
   *  Delete/Backspace severs each one (parent's ghostSlots entry removed). */
  selectedGhostGroupIds: string[]
  /** Deck.id whose preview affordance icon is currently hovered. Drives the
   *  open-footprint preview outlines AND the icon's full "active" highlight.
   *  Set/cleared by the dashed-rect icon's own enter/leave handlers. */
  previewHoveredDeckId: string | null
  /** Deck.id whose card body is currently hovered (any surface other than
   *  the affordance icon). Drives a SOFT hint glow on the affordance icon —
   *  a subtle nudge that the affordance is there. Distinct from
   *  previewHoveredDeckId so the soft hint and the full open-preview never
   *  fire from the same hover. */
  cardHoveredDeckId: string | null
  /** Group.id of a card that's currently being dragged out of a fanned deck
   *  (between the 30px threshold and pointerup). While set:
   *   - The fan wrapper renders the card itself at strip-equivalent z-index
   *     so it slides out from between the layers instead of disappearing
   *     behind the entire fan.
   *   - CardLayer's main loop skips rendering this card, since the fan
   *     owns it during the drag.
   *  Cleared on pointerup, after which the card transitions to its normal
   *  z-index 40 standalone render. */
  extractingCardId: string | null
  /** Active stack ↔ fan transition. While set, FannedDeckOverlay's strips
   *  imperatively animate (sliding out from the primary card on 'fanning',
   *  collapsing back into it on 'stacking'). For 'stacking', CardLayer
   *  keeps rendering the FannedDeckOverlay even though deck.state has
   *  already flipped to 'stacked' — the overlay needs to stay alive for
   *  the closing animation duration. */
  fanTransition: {
    deckId: string                   // id of the transitioning deck
    phase: 'fanning' | 'stacking'    // direction
  } | null
  zoneLineY: number
  /** When non-null, the user is in draw / annotation mode on this surface.
   *  Pointer events on the surface paint strokes; the floating DrawToolbar
   *  is visible. Click-outside / Esc / Done button clears it. */
  drawSurface: DrawSurface | null
  drawTool: 'pen' | 'eraser'
  drawColor: string
  drawSize: number
  /** Card Rolodex panel visibility — toggleable, persisted. */
  rolodexOpen: boolean
  /** Sort mode for the rolodex list. Persisted across sessions. */
  rolodexSortMode: 'creation' | 'alphabetical'

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
  setSelectedGhostGroupIds: (ids: string[]) => void
  clearSelectedGhostGroupIds: () => void
  setPreviewHoveredDeckId: (id: string | null) => void
  setCardHoveredDeckId: (id: string | null) => void
  setExtractingCardId: (id: string | null) => void
  setFanTransition: (t: CanvasStore['fanTransition']) => void
  setZoneLineY: (y: number) => void
  /** Pan (keeping current zoom) so the given group is centered in the viewport. */
  jumpToGroup: (groupId: string) => void
  // ── Annotation / draw mode ──
  setDrawSurface: (s: DrawSurface | null) => void
  setDrawTool: (t: 'pen' | 'eraser') => void
  setDrawColor: (c: string) => void
  setDrawSize: (n: number) => void
  // ── Card Rolodex ──
  toggleRolodex: () => void
  setRolodexOpen: (open: boolean) => void
  setRolodexSortMode: (mode: 'creation' | 'alphabetical') => void
}

export const useCanvasStore = create<CanvasStore>()(persist((set, get) => ({
  pan: { x: 0, y: 0 },
  zoom: 1,
  boardPos: { x: 0, y: 0 },
  nleRowHeight: 300,
  dynamicRowHeights: false,
  focusedBoardId: null,
  selectedBlockBoardIds: [],
  selectedGhostGroupIds: [],
  previewHoveredDeckId: null,
  cardHoveredDeckId: null,
  extractingCardId: null,
  fanTransition: null,
  zoneLineY: 0,
  drawSurface: null,
  drawTool: 'pen',
  drawColor: DEFAULT_PEN_COLOR,
  drawSize: DEFAULT_PEN_SIZE,
  rolodexOpen: false,
  rolodexSortMode: 'creation',

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

  setSelectedGhostGroupIds: (selectedGhostGroupIds) => set({ selectedGhostGroupIds }),
  clearSelectedGhostGroupIds: () => set({ selectedGhostGroupIds: [] }),

  setPreviewHoveredDeckId: (previewHoveredDeckId) => set({ previewHoveredDeckId }),

  setCardHoveredDeckId: (cardHoveredDeckId) => set({ cardHoveredDeckId }),

  setExtractingCardId: (extractingCardId) => set({ extractingCardId }),

  setFanTransition: (fanTransition) => set({ fanTransition }),

  setZoneLineY: (zoneLineY) => set({ zoneLineY }),

  setDrawSurface: (drawSurface) => set({ drawSurface }),
  setDrawTool: (drawTool) => set({ drawTool }),
  setDrawColor: (drawColor) => set({ drawColor }),
  setDrawSize: (drawSize) => set({ drawSize }),

  toggleRolodex: () => set(s => ({ rolodexOpen: !s.rolodexOpen })),
  setRolodexOpen: (rolodexOpen) => set({ rolodexOpen }),
  setRolodexSortMode: (rolodexSortMode) => set({ rolodexSortMode }),

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
    // Tool preferences persist across reloads; the active drawSurface does not.
    drawColor: s.drawColor,
    drawSize: s.drawSize,
    rolodexOpen: s.rolodexOpen,
    rolodexSortMode: s.rolodexSortMode,
  }),
  version: 1,
  migrate: (persisted: any, version: number) => {
    if (version < 1) {
      persisted.zoneLineY = 0
    }
    return persisted
  },
}))
