import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'
import { useCanvasStore } from './canvasStore'
import type { Bar } from '../types/bar'
import { TEMPLATES } from '../data/templates'
import { getBoardAbsolutePos, computeGroupLayout, yToRow } from '../utils/nleRows'
import {
  makeBar,
  collectSubtree,
  addChild,
  addSibling,
  moveBarOp,
  moveMultipleOp,
  resizeEdge,
  deleteBarOp,
  deleteSubtreeOp,
  addParentAboveOp,
  reorderSiblingsOp,
  collapseAllToggleOp,
  importBarsOp,
  changeRowOp,
  reparentBarOp,
} from '../utils/barOps'

const INIT_W = 480
const INIT_H = 270
const PRIMARY_INIT_ID = 'root-bar'

/** A project group — boards that collapse into one card at card zoom level */
export interface HeroImageTransform {
  scale: number      // 1 = cover-fit, >1 = zoomed in
  offsetX: number    // % shift from center (background-position)
  offsetY: number    // % shift from center
  flipH: boolean
  flipV: boolean
  opacity?: number   // hero image opacity (0–1, default 0.7)
}

export interface ProjectGroup {
  id: string
  name: string
  color: string
  boardIds: string[]   // ordered, can include 'primary'
  cardHeroImage: string | null
  cardHeroTransform?: HeroImageTransform
  cardSummary: string
  cardText: string     // independent body text visible on the card
  cardTextStyle?: import('../store/freeNodeStore').TextStyle
  cardHeaderText?: string
  cardHeaderTextStyle?: import('../store/freeNodeStore').TextStyle
  originY: number      // canvas-space Y position (group origin)
  originX: number      // canvas-space X position (group origin)
  cardWidthOverride?: number   // user-set card width (screen px)
  cardHeightOverride?: number  // user-set card height (screen px)
  deckState?: 'open' | 'fanned' | 'stacked'  // deck visual state (default: 'open')
  deckAnchorId?: string   // group ID of the deck anchor (leftmost card); set when deckState !== 'open'
  nestedDeck?: boolean    // true if this group is a sub-deck anchor (persists through fan/stack cycles)
  deckOffsetX?: number    // offset from OWN anchor at stacking time (for position restore on open)
  deckOffsetY?: number
  /**
   * When THIS group is a deck anchor, ghostSlots holds "checked-out" entries
   * for cards that were extracted from this deck. Each entry remembers where
   * the card's slot was so the dotted-outline strip can render in the fan
   * AND so the card can return to its slot when dropped on the ghost.
   * Extracted cards have NO deckAnchorId — they are independent on canvas.
   */
  ghostSlots?: Array<{
    cardId: string
    deckOffsetX: number
    deckOffsetY: number
  }>
  textSplitRatio?: number // header/body vertical split (0-1, default 0.5)
  linkedGroupIds?: string[]  // bi-directional references to other groups (optional for legacy; treat as [] when absent)
  /** Annotation layer drawn on this card at card zoom. */
  cardStrokes?: import('../types/stroke').Stroke[]
}

/** Find which group a board belongs to */
export function getGroupForBoard(groups: ProjectGroup[], boardId: string): ProjectGroup | undefined {
  return groups.find(g => g.boardIds.includes(boardId))
}

/**
 * IDs of every group reachable from rootId via deckAnchorId chains, EXCLUDING
 * rootId itself. Used by extract/return to keep a sub-deck's members spatially
 * coherent with their anchor when the anchor moves: shift every descendant by
 * the same delta so deckOffsetX/Y stays consistent with originX/Y.
 *
 * Mirrors `expandWithNestedMembers` in useCardDecks.ts but inlined here to
 * avoid a circular import between the store and the hook.
 */
function getTransitiveDescendantIds(rootId: string, groups: ProjectGroup[]): string[] {
  const result = new Set<string>([rootId])
  let added = true
  while (added) {
    added = false
    for (const g of groups) {
      if (!result.has(g.id) && g.deckAnchorId && result.has(g.deckAnchorId)) {
        result.add(g.id)
        added = true
      }
    }
  }
  result.delete(rootId)
  return Array.from(result)
}

/** Layer-specific metadata — each zoom level has its own data fields */
export interface BoardLayerData {
  card: {
    heroImage: string | null   // card-level thumbnail (NOT bar.content.images[0])
    summary: string            // short text visible on card
    text: string               // independent body text at card zoom
    textStyle?: import('../store/freeNodeStore').TextStyle
    headerText?: string
    headerTextStyle?: import('../store/freeNodeStore').TextStyle
    widthOverride?: number     // user-set width (canvas px, pre-zoom)
    heightOverride?: number    // user-set height (canvas px, pre-zoom)
    textSplitRatio?: number    // header/body vertical split (0-1, default 0.5)
  }
  block: {
    thumbnail: string | null   // block-level representative image
    thumbnailTransform?: HeroImageTransform
    label: string              // display name override at block zoom
    text: string               // independent body text at block zoom
    textStyle?: import('../store/freeNodeStore').TextStyle
    headerText?: string
    headerTextStyle?: import('../store/freeNodeStore').TextStyle
    widthOverride?: number     // user-set width (canvas px, pre-zoom)
    heightOverride?: number    // user-set height (canvas px, pre-zoom)
    textSplitRatio?: number    // header/body vertical split (0-1, default 0.5)
    /** Annotation layer drawn on this block at block zoom. */
    strokes?: import('../types/stroke').Stroke[]
  }
  // Board layer uses bar tree directly — strokes per bar live on Bar.strokes
}

const DEFAULT_LAYERS: BoardLayerData = {
  card: { heroImage: null, summary: '', text: '' },
  block: { thumbnail: null, label: '', text: '' },
}

export interface BoardData {
  id: string
  projectName: string
  color: string        // board-level color (NLE overview block)
  nleRow: number       // which NLE row (integer, snapped)
  nleX: number         // horizontal canvas position
  canvasX?: number     // absolute canvas X (only when ungrouped / free canvas)
  canvasY?: number     // absolute canvas Y (only when ungrouped / free canvas)
  bars: Record<string, Bar>
  rootIds: string[]
  viewerBarId: string | null
  selectedIds: string[]
  savedCollapsedState: Record<string, boolean> | null
  pristine: boolean
  boardScale: number   // content zoom (primary only, but stored per-board for generality)
  layers: BoardLayerData  // layer-specific metadata for card/block zoom levels
}

/** True if board is not in any group's boardIds */
export function isUngrouped(groups: ProjectGroup[], boardId: string): boolean {
  return !groups.some(g => g.boardIds.includes(boardId))
}

/** Get all board IDs that aren't in any group */
export function getUngroupedBoardIds(groups: ProjectGroup[], boards: Record<string, BoardData>): string[] {
  const grouped = new Set(groups.flatMap(g => g.boardIds))
  return Object.keys(boards).filter(id => !grouped.has(id))
}

interface BoardsState {
  boards: Record<string, BoardData>
  boardOrder: string[]    // does NOT include 'primary'
  groups: ProjectGroup[]  // project groups — each collapses to one card

  createBoard: (nleRow: number, nleX: number) => string
  duplicateBoard: (sourceBoardId: string) => string
  extractBarToBoard: (sourceBoardId: string, barId: string) => string | null
  deleteBoard: (id: string) => void
  setBoardNlePos: (id: string, nleRow: number, nleX: number) => void
  setBoardColor: (id: string, color: string) => void
  setBoardProjectName: (id: string, name: string) => void
  setBoardScale: (id: string, scale: number) => void
  loadTemplate: (boardId: string, templateId: string) => void
  loadLayout: (boardId: string, data: { bars: Record<string, Bar>; rootIds: string[]; projectName: string }) => void

  addChildToBar: (boardId: string, barId: string) => void
  addSiblingBar: (boardId: string, barId: string, position: 'before' | 'after') => void
  moveBar: (boardId: string, barId: string, dx: number) => void
  moveMultiple: (boardId: string, ids: string[], dx: number) => void
  resizeBarEdge: (boardId: string, barId: string, edge: 'left' | 'right', delta: number) => void
  setBarHeight: (boardId: string, barId: string, h: number) => void
  renameBar: (boardId: string, barId: string, name: string) => void
  setSubtitle: (boardId: string, barId: string, subtitle: string) => void
  setIcon: (boardId: string, barId: string, icon: string | null) => void
  setBarColor: (boardId: string, barId: string, color: string) => void
  deleteBar: (boardId: string, barId: string) => void
  deleteSubtree: (boardId: string, barId: string) => void
  addParentAbove: (boardId: string, barId: string) => void
  openViewer: (boardId: string, barId: string) => void
  closeViewer: (boardId: string) => void
  setSelection: (boardId: string, ids: string[]) => void
  clearSelection: (boardId: string) => void
  clearAllSelections: () => void
  toggleSelection: (boardId: string, barId: string) => void
  toggleCollapsed: (boardId: string, barId: string) => void
  reorderSiblings: (boardId: string, barId: string) => void
  setContent: (boardId: string, barId: string, patch: Partial<Bar['content']>) => void
  collapseAllToggle: (boardId: string) => void
  importBars: (boardId: string, bars: Record<string, Bar>, newRootIds: string[], xOffset: number) => void
  changeBarRow: (boardId: string, barId: string, newRow: number, detach?: boolean) => void
  reparentBar: (boardId: string, barId: string, newParentId: string) => void
  crossBoardReparent: (sourceBoardId: string, barId: string, targetBoardId: string, newParentId: string) => void

  // ── Layer-specific actions ──
  setCardHeroImage: (boardId: string, url: string | null) => void
  setCardSummary: (boardId: string, summary: string) => void
  setBlockThumbnail: (boardId: string, url: string | null) => void
  setBlockThumbnailTransform: (boardId: string, transform: HeroImageTransform | undefined) => void
  setBlockLabel: (boardId: string, label: string) => void
  setBlockText: (boardId: string, text: string) => void
  setCardText: (boardId: string, text: string) => void
  setBlockTextStyle: (boardId: string, style: import('../store/freeNodeStore').TextStyle) => void
  setCardTextStyle: (boardId: string, style: import('../store/freeNodeStore').TextStyle) => void
  setBlockHeaderText: (boardId: string, text: string) => void
  setBlockHeaderTextStyle: (boardId: string, style: import('../store/freeNodeStore').TextStyle) => void
  setCardHeaderText: (boardId: string, text: string) => void
  setCardHeaderTextStyle: (boardId: string, style: import('../store/freeNodeStore').TextStyle) => void
  setCardSize: (boardId: string, w: number | undefined, h: number | undefined) => void
  setBlockSize: (boardId: string, w: number | undefined, h: number | undefined) => void

  // ── Project group actions ──
  createGroup: (name: string, boardIds: string[]) => string
  deleteGroup: (groupId: string) => void
  renameGroup: (groupId: string, name: string) => void
  setGroupColor: (groupId: string, color: string) => void
  setGroupCardHeroImage: (groupId: string, url: string | null) => void
  setGroupCardHeroTransform: (groupId: string, transform: HeroImageTransform | undefined) => void
  setGroupCardSummary: (groupId: string, summary: string) => void
  setGroupCardText: (groupId: string, text: string) => void
  setGroupCardTextStyle: (groupId: string, style: import('../store/freeNodeStore').TextStyle) => void
  setGroupCardHeaderText: (groupId: string, text: string) => void
  setGroupCardHeaderTextStyle: (groupId: string, style: import('../store/freeNodeStore').TextStyle) => void
  setGroupCardSize: (groupId: string, w: number | undefined, h: number | undefined) => void
  setGroupTextSplitRatio: (groupId: string, ratio: number) => void
  setBlockTextSplitRatio: (boardId: string, ratio: number) => void
  setCardTextSplitRatio: (boardId: string, ratio: number) => void
  // ── Annotation / stroke actions ──
  setBarStrokes: (boardId: string, barId: string, strokes: import('../types/stroke').Stroke[]) => void
  setBlockStrokes: (boardId: string, strokes: import('../types/stroke').Stroke[]) => void
  setCardStrokes: (groupId: string, strokes: import('../types/stroke').Stroke[]) => void
  setDeckState: (groupIds: string[], state: 'open' | 'fanned' | 'stacked') => void
  /** Pull a card out of its deck onto the canvas. The parent gets a ghostSlots
   *  entry remembering the slot's offset so the card can return. The card
   *  itself becomes independent (deckAnchorId/deckOffset cleared). If the
   *  card has tethered sub-members, it self-anchors and renders as a free-
   *  floating sub-deck on canvas. */
  extractFromDeck: (cardId: string, newOriginX: number, newOriginY: number) => void
  /** Return an extracted card to its parent deck's ghost slot. Re-tethers
   *  the card to the parent at the slot's saved offset, removes the slot
   *  entry, and snaps the card's origin to the slot position. */
  returnToDeck: (cardId: string) => void
  /** Permanently sever the tether: remove the card's ghost slot from its
   *  former parent. Card stays where it is on canvas, fully independent. */
  severDeckTether: (cardId: string) => void
  setGroupPos: (groupId: string, originY: number, originX: number) => void
  setGroupPosBatch: (updates: { groupId: string; originY: number; originX: number }[]) => void
  reassignBoard: (boardId: string, targetGroupId: string, dropCanvasPos?: { x: number; y: number }) => void
  moveToNewGroup: (boardId: string) => void
  duplicateGroup: (groupId: string) => string | null
  selectedGroupIds: string[]
  setSelectedGroup: (groupId: string | null) => void
  toggleGroupSelection: (groupId: string) => void
  setSelectedGroups: (groupIds: string[]) => void
  clearGroupSelection: () => void

  // ── Bi-directional group linking ──
  linkGroups: (a: string, b: string) => void
  unlinkGroups: (a: string, b: string) => void

  // ── Ungrouped board actions (free canvas) ──
  createUngroupedBoard: (canvasX: number, canvasY: number) => string
  ungroupBoard: (boardId: string) => void
  groupBoard: (boardId: string, targetGroupId: string) => void
  groupBoardAsNew: (boardId: string) => void
  setUngroupedBoardPos: (boardId: string, canvasX: number, canvasY: number) => void
}

type SetFn = (fn: (s: BoardsState) => Partial<BoardsState>) => void

function updateBoard(
  set: SetFn,
  boardId: string,
  fn: (b: BoardData) => Partial<BoardData>,
) {
  set(s => {
    const b = s.boards[boardId]
    if (!b) return s
    return { boards: { ...s.boards, [boardId]: { ...b, ...fn(b) } } }
  })
}

/** Apply a BarMutResult from barOps to a board via updateBoard */
function applyBarMut(
  set: SetFn,
  boardId: string,
  result: { bars: Record<string, Bar>; rootIds?: string[]; savedCollapsedState?: Record<string, boolean> | null } | null,
) {
  if (!result) return
  updateBoard(set, boardId, () => {
    const patch: Partial<BoardData> = { bars: result.bars }
    if (result.rootIds !== undefined) patch.rootIds = result.rootIds
    if (result.savedCollapsedState !== undefined) patch.savedCollapsedState = result.savedCollapsedState
    return patch
  })
}

const PRIMARY_BOARD: BoardData = {
  id: 'primary',
  projectName: 'storyMap',
  color: '#5b8dd9',
  nleRow: 0,
  nleX: 0,
  bars: {
    [PRIMARY_INIT_ID]: makeBar({
      id: PRIMARY_INIT_ID, parentId: null, rowIndex: 0,
      x: 0, width: INIT_W, height: INIT_H,
      name: 'Untitled', subtitle: '', color: '#5b8dd9',
    }),
  },
  rootIds: [PRIMARY_INIT_ID],
  viewerBarId: null,
  selectedIds: [],
  savedCollapsedState: null,
  pristine: true,
  boardScale: 1,
  layers: { ...DEFAULT_LAYERS },
}

const DEFAULT_GROUP: ProjectGroup = {
  id: 'default-group',
  name: 'NLE Timeline',
  color: '#5b8dd9',
  boardIds: ['primary'],
  cardHeroImage: null,
  cardSummary: '',
  cardText: '',
  cardHeaderText: '',
  originY: 0,
  originX: 0,
}

export const useBoardsStore = create<BoardsState>()(persist((set, get) => ({
  boards: { primary: PRIMARY_BOARD },
  boardOrder: [],
  groups: [DEFAULT_GROUP],
  selectedGroupIds: [],

  createBoard(nleRow, nleX) {
    const id = crypto.randomUUID()
    const rootId = crypto.randomUUID()
    const board: BoardData = {
      id, projectName: '', color: '#5b8dd9',
      nleRow, nleX,
      bars: {
        [rootId]: makeBar({ id: rootId, parentId: null, rowIndex: 0, x: 0, width: INIT_W, height: INIT_H }),
      },
      rootIds: [rootId],
      viewerBarId: null,
      selectedIds: [],
      savedCollapsedState: null,
      pristine: true,
      boardScale: 1,
      layers: { ...DEFAULT_LAYERS },
    }
    set(s => {
      // Add new board to the first group
      const groups = s.groups.map((g, i) => i === 0 ? { ...g, boardIds: [...g.boardIds, id] } : g)
      return { boards: { ...s.boards, [id]: board }, boardOrder: [...s.boardOrder, id], groups }
    })
    return id
  },

  duplicateBoard(sourceBoardId) {
    const src = get().boards[sourceBoardId]
    const id = crypto.randomUUID()
    const idMap = new Map<string, string>()
    Object.keys(src.bars).forEach(bid => idMap.set(bid, crypto.randomUUID()))
    const bars: Record<string, Bar> = {}
    Object.values(src.bars).forEach(b => {
      const newId = idMap.get(b.id)!
      bars[newId] = {
        ...b, id: newId,
        parentId: b.parentId ? (idMap.get(b.parentId) ?? null) : null,
        children: b.children.map(cid => idMap.get(cid) ?? cid),
      }
    })
    const rootIds = src.rootIds.map(rid => idMap.get(rid) ?? rid)
    const board: BoardData = {
      // Empty source projectName stays empty in the copy (placeholder handles the display).
      id, projectName: src.projectName ? src.projectName + ' copy' : '', color: src.color,
      nleRow: src.nleRow, nleX: src.nleX + 40,
      bars, rootIds,
      viewerBarId: null, selectedIds: [], savedCollapsedState: null, pristine: false,
      boardScale: src.boardScale ?? 1,
      layers: structuredClone(src.layers ?? DEFAULT_LAYERS),
    }
    set(s => {
      // Add duplicate to same group as source
      const groups = s.groups.map(g =>
        g.boardIds.includes(sourceBoardId) ? { ...g, boardIds: [...g.boardIds, id] } : g
      )
      return { boards: { ...s.boards, [id]: board }, boardOrder: [...s.boardOrder, id], groups }
    })
    return id
  },

  extractBarToBoard(sourceBoardId, barId) {
    const src = get().boards[sourceBoardId]
    if (!src) return null
    const bar = src.bars[barId]
    if (!bar) return null

    // Collect the bar + its entire subtree
    const subtreeIds = collectSubtree(src.bars, barId)
    if (subtreeIds.length === 0) return null

    // Don't extract if it would leave the source board empty
    const remainingRoots = src.rootIds.filter(rid => !subtreeIds.includes(rid))
    if (remainingRoots.length === 0 && src.rootIds.includes(barId)) return null

    // Build bars for the new board (clone with same IDs — they're unique UUIDs)
    const extractedBars: Record<string, Bar> = {}
    const subtreeSet = new Set(subtreeIds)
    for (const sid of subtreeIds) {
      const b = src.bars[sid]
      if (!b) continue
      extractedBars[sid] = {
        ...b,
        // If this bar's parent is outside the subtree, make it a root
        parentId: b.parentId && subtreeSet.has(b.parentId) ? b.parentId : null,
        // Filter children to only those in the subtree
        children: b.children.filter(cid => subtreeSet.has(cid)),
      }
    }

    // Normalize x positions so the leftmost bar starts at 0
    const minX = Math.min(...Object.values(extractedBars).map(b => b.x))
    for (const b of Object.values(extractedBars)) b.x -= minX

    // Root IDs for the new board: bars with no parent in the extracted set
    const newRootIds = Object.values(extractedBars).filter(b => !b.parentId).map(b => b.id)

    const newBoardId = crypto.randomUUID()
    const newBoard: BoardData = {
      id: newBoardId,
      projectName: bar.name || src.projectName,
      color: bar.color || src.color,
      nleRow: src.nleRow ?? 0,
      nleX: (src.nleX ?? 0) + 200,
      bars: extractedBars,
      rootIds: newRootIds,
      viewerBarId: null,
      selectedIds: [],
      savedCollapsedState: null,
      pristine: false,
      boardScale: src.boardScale ?? 1,
      layers: { ...DEFAULT_LAYERS },
    }

    // Remove extracted bars from source board
    const srcBars = { ...src.bars }
    for (const sid of subtreeIds) delete srcBars[sid]

    // Detach from parent in source if this bar was a child
    if (bar.parentId && srcBars[bar.parentId]) {
      srcBars[bar.parentId] = {
        ...srcBars[bar.parentId],
        children: srcBars[bar.parentId].children.filter(cid => cid !== barId),
      }
    }

    const srcRootIds = src.rootIds.filter(rid => !subtreeSet.has(rid))

    set(s => {
      const updatedSrc = { ...s.boards[sourceBoardId], bars: srcBars, rootIds: srcRootIds, selectedIds: [] }
      const boards = { ...s.boards, [sourceBoardId]: updatedSrc, [newBoardId]: newBoard }
      // Add new board to the same group as the source
      const groups = s.groups.map(g =>
        g.boardIds.includes(sourceBoardId) ? { ...g, boardIds: [...g.boardIds, newBoardId] } : g
      )
      return { boards, boardOrder: [...s.boardOrder, newBoardId], groups }
    })
    return newBoardId
  },

  deleteBoard(id) {
    set(s => {
      const { [id]: _, ...rest } = s.boards
      // Remove from its group; auto-delete empty groups (keep at least one)
      let groups = s.groups.map(g => ({
        ...g,
        boardIds: g.boardIds.filter(bid => bid !== id),
      }))
      if (groups.length > 1) groups = groups.filter(g => g.boardIds.length > 0)
      return { boards: rest, boardOrder: s.boardOrder.filter(x => x !== id), groups }
    })
  },

  setBoardNlePos(id, nleRow, nleX) {
    const b = get().boards[id]
    if (b && b.nleRow === nleRow && b.nleX === nleX) return
    updateBoard(set, id, () => ({ nleRow, nleX }))
  },

  setBoardColor(id, color) {
    updateBoard(set, id, () => ({ color }))
  },

  setBoardProjectName(id, name) {
    updateBoard(set, id, () => ({ projectName: name }))
  },

  // ── Bar mutations: thin wrappers around barOps ──

  addChildToBar(boardId, barId) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, addChild(board.bars, board.rootIds, barId))
  },

  addSiblingBar(boardId, barId, position) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, addSibling(board.bars, board.rootIds, barId, position))
  },

  moveBar(boardId, barId, dx) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, moveBarOp(board.bars, barId, dx))
  },

  moveMultiple(boardId, ids, dx) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, moveMultipleOp(board.bars, ids, dx))
  },

  resizeBarEdge(boardId, barId, edge, delta) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, resizeEdge(board.bars, barId, edge, delta))
  },

  setBarHeight(boardId, barId, h) {
    updateBoard(set, boardId, b => ({ bars: { ...b.bars, [barId]: { ...b.bars[barId], height: Math.max(40, h) } } }))
  },

  renameBar(boardId, barId, name) {
    updateBoard(set, boardId, b => ({ bars: { ...b.bars, [barId]: { ...b.bars[barId], name } } }))
  },

  setSubtitle(boardId, barId, subtitle) {
    updateBoard(set, boardId, b => ({ bars: { ...b.bars, [barId]: { ...b.bars[barId], subtitle } } }))
  },

  setIcon(boardId, barId, icon) {
    updateBoard(set, boardId, b => ({ bars: { ...b.bars, [barId]: { ...b.bars[barId], icon } } }))
  },

  setBarColor(boardId, barId, color) {
    updateBoard(set, boardId, b => ({ bars: { ...b.bars, [barId]: { ...b.bars[barId], color } } }))
  },

  deleteBar(boardId, barId) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, deleteBarOp(board.bars, board.rootIds, barId))
  },

  deleteSubtree(boardId, barId) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, deleteSubtreeOp(board.bars, board.rootIds, barId))
  },

  addParentAbove(boardId, barId) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, addParentAboveOp(board.bars, board.rootIds, barId))
  },

  openViewer(boardId, barId) {
    updateBoard(set, boardId, () => ({ viewerBarId: barId }))
  },
  closeViewer(boardId) {
    updateBoard(set, boardId, () => ({ viewerBarId: null }))
  },
  setSelection(boardId, ids) {
    updateBoard(set, boardId, () => ({ selectedIds: ids }))
  },
  clearSelection(boardId) {
    updateBoard(set, boardId, () => ({ selectedIds: [] }))
  },
  clearAllSelections() {
    const boards = get().boards
    const updated: Record<string, any> = {}
    let changed = false
    for (const [id, board] of Object.entries(boards)) {
      if (board.selectedIds.length > 0) {
        updated[id] = { ...board, selectedIds: [] }
        changed = true
      } else {
        updated[id] = board
      }
    }
    if (changed) set({ boards: updated as any })
  },
  toggleSelection(boardId, barId) {
    updateBoard(set, boardId, b => ({
      selectedIds: b.selectedIds.includes(barId)
        ? b.selectedIds.filter(x => x !== barId)
        : [...b.selectedIds, barId],
    }))
  },
  toggleCollapsed(boardId, barId) {
    updateBoard(set, boardId, b => ({
      bars: { ...b.bars, [barId]: { ...b.bars[barId], collapsed: !b.bars[barId]?.collapsed } }
    }))
  },

  reorderSiblings(boardId, barId) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, reorderSiblingsOp(board.bars, barId))
  },

  setContent(boardId, barId, patch) {
    updateBoard(set, boardId, b => ({
      bars: { ...b.bars, [barId]: { ...b.bars[barId], content: { ...b.bars[barId]?.content, ...patch } } }
    }))
  },

  collapseAllToggle(boardId) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, collapseAllToggleOp(board.bars, board.savedCollapsedState))
  },

  importBars(boardId, newBars, newRootIds, xOffset) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, importBarsOp(board.bars, board.rootIds, newBars, newRootIds, xOffset))
  },

  changeBarRow(boardId, barId, newRow, detach = true) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, changeRowOp(board.bars, board.rootIds, barId, newRow, detach))
  },

  reparentBar(boardId, barId, newParentId) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, reparentBarOp(board.bars, board.rootIds, barId, newParentId))
  },

  crossBoardReparent(sourceBoardId, barId, targetBoardId, newParentId) {
    const sourceBoard = get().boards[sourceBoardId]; if (!sourceBoard) return
    const targetBoard = get().boards[targetBoardId]; if (!targetBoard) return
    const newParent = targetBoard.bars[newParentId]; if (!newParent) return

    // Collect subtree from source
    const subtreeIds = collectSubtree(sourceBoard.bars, barId)
    const subtreeBars: Record<string, Bar> = {}
    subtreeIds.forEach(id => { if (sourceBoard.bars[id]) subtreeBars[id] = sourceBoard.bars[id] })

    // Adjust rowIndex: only move if bar is at or above new parent row
    const sourceBar = sourceBoard.bars[barId]; if (!sourceBar) return
    const minChildRow = newParent.rowIndex + 1
    if (sourceBar.rowIndex < minChildRow) {
      const rowDelta = minChildRow - sourceBar.rowIndex
      subtreeIds.forEach(id => {
        if (subtreeBars[id]) subtreeBars[id] = { ...subtreeBars[id], rowIndex: Math.max(0, subtreeBars[id].rowIndex + rowDelta) }
      })
    }

    // Adjust x positions: center the bar under new parent, shift entire subtree by same delta
    const parentCenterX = newParent.x + newParent.width / 2
    const barCenterX = sourceBar.x + sourceBar.width / 2
    const xDelta = parentCenterX - barCenterX
    subtreeIds.forEach(id => {
      if (subtreeBars[id]) subtreeBars[id] = { ...subtreeBars[id], x: subtreeBars[id].x + xDelta }
    })

    subtreeBars[barId] = { ...subtreeBars[barId], parentId: newParentId }

    // Add to target board
    const targetBars = { ...targetBoard.bars, ...subtreeBars }
    const targetParent = targetBars[newParentId]
    targetBars[newParentId] = { ...targetParent, children: [...targetParent.children, barId] }
    updateBoard(set, targetBoardId, () => ({ bars: targetBars }))

    // Remove from source board
    applyBarMut(set, sourceBoardId, deleteSubtreeOp(sourceBoard.bars, sourceBoard.rootIds, barId))
  },

  loadTemplate(boardId, templateId) {
    const tmpl = TEMPLATES.find(t => t.id === templateId)
    if (!tmpl) return
    updateBoard(set, boardId, () => ({
      bars: tmpl.bars,
      rootIds: tmpl.rootIds,
      projectName: tmpl.projectName,
      viewerBarId: null,
      pristine: true,
      selectedIds: [],
      savedCollapsedState: null,
    }))
  },

  loadLayout(boardId, data) {
    updateBoard(set, boardId, () => ({
      bars: data.bars,
      rootIds: data.rootIds,
      projectName: data.projectName,
      viewerBarId: null,
      pristine: true,
      selectedIds: [],
      savedCollapsedState: null,
    }))
  },

  setBoardScale(id, scale) {
    updateBoard(set, id, () => ({ boardScale: Math.max(0.25, Math.min(3.0, scale)) }))
  },

  // ── Layer-specific actions ──

  setCardHeroImage(boardId, url) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, card: { ...b.layers.card, heroImage: url } },
    }))
  },

  setCardSummary(boardId, summary) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, card: { ...b.layers.card, summary } },
    }))
  },

  setBlockThumbnail(boardId, url) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, thumbnail: url, ...(url === null ? { thumbnailTransform: undefined } : {}) } },
    }))
  },

  setBlockThumbnailTransform(boardId, transform) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, thumbnailTransform: transform } },
    }))
  },

  setBlockLabel(boardId, label) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, label } },
    }))
  },

  setBlockText(boardId: string, text: string) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, text } },
    }))
  },

  setCardText(boardId: string, text: string) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, card: { ...b.layers.card, text } },
    }))
  },

  setBlockTextStyle(boardId, style) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, textStyle: style } },
    }))
  },

  setCardTextStyle(boardId, style) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, card: { ...b.layers.card, textStyle: style } },
    }))
  },

  setBlockHeaderText(boardId, text) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, headerText: text } },
    }))
  },

  setBlockHeaderTextStyle(boardId, style) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, headerTextStyle: style } },
    }))
  },

  setCardHeaderText(boardId, text) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, card: { ...b.layers.card, headerText: text } },
    }))
  },

  setCardHeaderTextStyle(boardId, style) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, card: { ...b.layers.card, headerTextStyle: style } },
    }))
  },

  setCardSize(boardId, w, h) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, card: { ...b.layers.card, widthOverride: w, heightOverride: h } },
    }))
  },

  setBlockSize(boardId, w, h) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, widthOverride: w, heightOverride: h } },
    }))
  },

  // ── Project group actions ──

  createGroup(name, boardIds) {
    const id = crypto.randomUUID()
    const group: ProjectGroup = {
      id, name, color: '#5b8dd9', boardIds,
      cardHeroImage: null, cardSummary: '', cardText: '', cardHeaderText: '',
      originY: 0, originX: 0,
    }
    set(s => {
      // Remove these boardIds from any existing group to avoid duplicates
      const cleaned = s.groups.map(g => ({
        ...g, boardIds: g.boardIds.filter(bid => !boardIds.includes(bid)),
      }))
      // Remove empty groups (keep at least one via the new group)
      const remaining = cleaned.filter(g => g.boardIds.length > 0)
      return { groups: [...remaining, group] }
    })
    return id
  },

  deleteGroup(groupId) {
    set(s => {
      const target = s.groups.find(g => g.id === groupId)
      if (!target || s.groups.length <= 1) return s
      // Move orphaned boards to the first remaining group
      const others = s.groups.filter(g => g.id !== groupId)
      const first = { ...others[0], boardIds: [...others[0].boardIds, ...target.boardIds] }
      return { groups: [first, ...others.slice(1)] }
    })
  },

  renameGroup(groupId, name) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, name } : g) }))
  },

  setGroupColor(groupId, color) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, color } : g) }))
  },

  setGroupCardHeroImage(groupId, url) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardHeroImage: url, ...(url === null ? { cardHeroTransform: undefined } : {}) } : g) }))
  },

  setGroupCardHeroTransform(groupId, transform) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardHeroTransform: transform } : g) }))
  },

  setGroupCardSummary(groupId, summary) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardSummary: summary } : g) }))
  },

  setGroupCardText(groupId: string, text: string) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardText: text } : g) }))
  },

  setGroupCardTextStyle(groupId, style) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardTextStyle: style } : g) }))
  },

  setGroupCardHeaderText(groupId, text) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardHeaderText: text } : g) }))
  },

  setGroupCardHeaderTextStyle(groupId, style) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardHeaderTextStyle: style } : g) }))
  },

  setGroupCardSize(groupId, w, h) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardWidthOverride: w, cardHeightOverride: h } : g) }))
  },

  setGroupTextSplitRatio(groupId, ratio) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, textSplitRatio: ratio } : g) }))
  },

  setBlockTextSplitRatio(boardId, ratio) {
    set(s => {
      const b = s.boards[boardId]
      if (!b) return s
      return { boards: { ...s.boards, [boardId]: { ...b, layers: { ...b.layers, block: { ...b.layers.block, textSplitRatio: ratio } } } } }
    })
  },

  setCardTextSplitRatio(boardId, ratio) {
    set(s => {
      const b = s.boards[boardId]
      if (!b) return s
      return { boards: { ...s.boards, [boardId]: { ...b, layers: { ...b.layers, card: { ...b.layers.card, textSplitRatio: ratio } } } } }
    })
  },

  // ── Annotation strokes ─────────────────────────────────────
  // Each surface (bar / block / card) has its own per-zoom stroke layer.
  // `strokes` arrays use normalized 0–1 coords so strokes scale with their
  // host. Setters do a full replace; add/delete/clear are composed in
  // utils/strokeActions.ts so undo + history get a single mutation per change.

  setBarStrokes(boardId, barId, strokes) {
    set(s => {
      const b = s.boards[boardId]
      if (!b) return s
      const bar = b.bars[barId]
      if (!bar) return s
      return {
        boards: {
          ...s.boards,
          [boardId]: { ...b, bars: { ...b.bars, [barId]: { ...bar, strokes } } },
        },
      }
    })
  },

  setBlockStrokes(boardId, strokes) {
    set(s => {
      const b = s.boards[boardId]
      if (!b) return s
      return {
        boards: {
          ...s.boards,
          [boardId]: { ...b, layers: { ...b.layers, block: { ...b.layers.block, strokes } } },
        },
      }
    })
  },

  setCardStrokes(groupId, strokes) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardStrokes: strokes } : g) }))
  },

  setDeckState(groupIds, state) {
    const idSet = new Set(groupIds)
    // For stacking/fanning: the new deck anchor is groupIds[0] (leftmost in
    // the cluster). For opening: anchorId is undefined (no deck after open).
    const anchorId = state === 'open' ? undefined : groupIds[0]
    // Detect a stack ↔ fan crossing. When firing, mark the deck for
    // animation in canvasStore — FannedDeckOverlay's strips imperatively
    // slide out (fanning) or back in (stacking). For 'stacking', CardLayer
    // keeps the fan rendered during the animation window; once it clears,
    // the StackedDeckCard takes over.
    {
      const groups = get().groups
      const firstAnchor = groupIds[0] // canvasStore's deckId is just the anchor's id; matches what CardLayer compares against
      const wasFanned = groupIds.some(id => groups.find(g => g.id === id)?.deckState === 'fanned')
      const wasStacked = groupIds.some(id => groups.find(g => g.id === id)?.deckState === 'stacked')
      let phase: 'fanning' | 'stacking' | null = null
      if (state === 'fanned' && wasStacked) phase = 'fanning'
      else if (state === 'stacked' && wasFanned) phase = 'stacking'
      if (phase) {
        useCanvasStore.getState().setFanTransition({ deckId: firstAnchor, phase })
        // Adaptive cleanup: match the actual animation end so the
        // FannedDeckOverlay → StackedDeckCard handoff doesn't sit on a
        // pause. Per-strip duration + (N-1)*stagger + tiny buffer.
        // Stagger scales with deck size for readability — mirrors the
        // formula in FannedDeckOverlay's useLayoutEffect.
        const stripCount = Math.max(1, groupIds.length - 1)
        const STRIP_DURATION_MS = phase === 'fanning' ? 100 : 90
        const STAGGER_MS = Math.max(8, Math.min(20, Math.floor(stripCount * 1.5)))
        const CLEAR_BUFFER_MS = 20
        const clearAfter = STRIP_DURATION_MS + (stripCount - 1) * STAGGER_MS + CLEAR_BUFFER_MS
        setTimeout(() => {
          const cur = useCanvasStore.getState().fanTransition
          if (cur && cur.deckId === firstAnchor && cur.phase === phase) {
            useCanvasStore.getState().setFanTransition(null)
          }
        }, clearAfter)
      }
    }
    set(s => {
      // Detect sub-deck anchors: members whose ID is referenced by
      // deckAnchorId of groups OUTSIDE this set (they anchor a nested sub-deck)
      const subDeckAnchors = new Set<string>()
      for (const g of s.groups) {
        if (!idSet.has(g.id) && g.deckAnchorId && idSet.has(g.deckAnchorId)) {
          subDeckAnchors.add(g.deckAnchorId)
        }
      }
      // For stacking/fanning, the new anchor is groupIds[0].
      const anchorGroup = anchorId ? s.groups.find(g => g.id === anchorId) : null
      const groupById = new Map(s.groups.map(g => [g.id, g]))

      // For opening: each member is repositioned relative to its OWN
      // deckAnchorId (which is the deck's actual anchor — the group with
      // self-anchored deckAnchorId === id). Using groupIds[0] would be wrong
      // when groupIds[0] !== actual anchor, e.g. when a sub-member's content
      // extends further leftward than the anchor's so that the sub-member
      // lands as memberIds[0] in deck.memberIds (sorted by rect.left).
      const refAnchor = (g: ProjectGroup) =>
        g.deckAnchorId && g.id !== g.deckAnchorId ? groupById.get(g.deckAnchorId) ?? null : null

      // When opening, propagate each in-idSet member's repositioning delta
      // down to its transitive descendants OUTSIDE idSet (deeper nested
      // sub-deck members). Without this, those nested members keep stale
      // absolute positions and their sub-deck's layout scrambles. Each
      // outside group adopts the delta of its NEAREST in-idSet ancestor.
      const positionShifts = new Map<string, { dx: number; dy: number }>()
      if (state === 'open') {
        const idSetDeltas = new Map<string, { dx: number; dy: number }>()
        for (const g of s.groups) {
          if (!idSet.has(g.id)) continue
          if (g.deckOffsetX == null || g.deckOffsetY == null) continue
          const anchor = refAnchor(g)
          if (!anchor) continue // self-anchored or no anchor — doesn't move
          const newOx = anchor.originX + g.deckOffsetX
          const newOy = anchor.originY + g.deckOffsetY
          const dx = newOx - g.originX
          const dy = newOy - g.originY
          if (dx !== 0 || dy !== 0) idSetDeltas.set(g.id, { dx, dy })
        }
        if (idSetDeltas.size > 0) {
          // Walk each outside group's deckAnchorId chain to its nearest
          // in-idSet ancestor. Visited-set guards against any cycle in the
          // anchor graph (e.g. a self-anchored card outside idSet).
          for (const g of s.groups) {
            if (idSet.has(g.id)) continue
            let cur = g.deckAnchorId
            const visited = new Set<string>()
            while (cur && !visited.has(cur)) {
              if (idSet.has(cur)) {
                const delta = idSetDeltas.get(cur)
                if (delta) positionShifts.set(g.id, delta)
                break
              }
              visited.add(cur)
              const parent = groupById.get(cur)
              if (!parent) break
              cur = parent.deckAnchorId
            }
          }
        }
      }

      return {
        groups: s.groups.map(g => {
          if (!idSet.has(g.id)) {
            const shift = positionShifts.get(g.id)
            if (shift) return { ...g, originX: g.originX + shift.dx, originY: g.originY + shift.dy }
            return g
          }
          if (subDeckAnchors.has(g.id)) {
            if (state === 'open') {
              // Sub-deck anchor opening: restore position relative to its own
              // deckAnchorId, preserving the sub-deck's own state and the
              // nestedDeck flag (it's still a sub-deck on canvas).
              let ox = g.originX, oy = g.originY
              const anchor = refAnchor(g)
              if (anchor && g.deckOffsetX != null && g.deckOffsetY != null) {
                ox = anchor.originX + g.deckOffsetX
                oy = anchor.originY + g.deckOffsetY
              }
              return { ...g, deckAnchorId: undefined, nestedDeck: true, originX: ox, originY: oy, deckOffsetX: undefined, deckOffsetY: undefined }
            }
            // Stacking/fanning: store offset from new parent anchor for later restore.
            const offX = anchorGroup ? g.originX - anchorGroup.originX : g.deckOffsetX
            const offY = anchorGroup ? g.originY - anchorGroup.originY : g.deckOffsetY
            return { ...g, deckAnchorId: anchorId, nestedDeck: true, deckOffsetX: offX, deckOffsetY: offY }
          }
          if (state === 'open') {
            // Regular member opening: restore position relative to its own anchor.
            let ox = g.originX, oy = g.originY
            const anchor = refAnchor(g)
            if (anchor && g.deckOffsetX != null && g.deckOffsetY != null) {
              ox = anchor.originX + g.deckOffsetX
              oy = anchor.originY + g.deckOffsetY
            }
            return { ...g, deckState: state, deckAnchorId: anchorId, nestedDeck: undefined, originX: ox, originY: oy, deckOffsetX: undefined, deckOffsetY: undefined }
          }
          // Stacking/fanning: store offset from anchor
          const offX = anchorGroup ? g.originX - anchorGroup.originX : g.deckOffsetX
          const offY = anchorGroup ? g.originY - anchorGroup.originY : g.deckOffsetY
          return { ...g, deckState: state, deckAnchorId: anchorId, nestedDeck: g.nestedDeck, deckOffsetX: offX, deckOffsetY: offY }
        })
      }
    })
  },

  extractFromDeck(cardId, newOriginX, newOriginY) {
    set(s => {
      const card = s.groups.find(g => g.id === cardId)
      if (!card || !card.deckAnchorId) return {}
      const parentId = card.deckAnchorId
      const parent = s.groups.find(g => g.id === parentId)
      if (!parent) return {}
      // Snapshot the card's slot offsets before clearing.
      const slotOffsetX = card.deckOffsetX ?? 0
      const slotOffsetY = card.deckOffsetY ?? 0
      // Does the card have tethered sub-members? Then it stays as a deck
      // anchor (self-anchored) so its sub-deck renders as a stacked/fanned
      // card on canvas. Otherwise it becomes a plain open card.
      const hasSubMembers = s.groups.some(g => g.id !== cardId && g.deckAnchorId === cardId)
      // Shift any transitive sub-members by the same delta as the anchor so
      // their absolute originX/Y stays consistent with their preserved
      // deckOffsetX/Y. Without this, sub-members render at the anchor's
      // pre-extract location until something forces a deckState='open' pass.
      const dx = newOriginX - card.originX
      const dy = newOriginY - card.originY
      const subTreeIds = hasSubMembers ? new Set(getTransitiveDescendantIds(cardId, s.groups)) : new Set<string>()
      return {
        groups: s.groups.map(g => {
          if (g.id === parentId) {
            const slots = g.ghostSlots ?? []
            // De-dupe by cardId in case the card was somehow already extracted.
            const filtered = slots.filter(sl => sl.cardId !== cardId)
            return { ...g, ghostSlots: [...filtered, { cardId, deckOffsetX: slotOffsetX, deckOffsetY: slotOffsetY }] }
          }
          if (g.id === cardId) {
            if (hasSubMembers) {
              // Self-anchored sub-deck on canvas; preserve its own deckState.
              const own: 'stacked' | 'fanned' =
                (g.deckState === 'stacked' || g.deckState === 'fanned') ? g.deckState : 'stacked'
              return {
                ...g,
                originX: newOriginX,
                originY: newOriginY,
                deckAnchorId: g.id,
                deckOffsetX: 0,
                deckOffsetY: 0,
                deckState: own,
                nestedDeck: undefined,
              }
            }
            // Plain open card.
            return {
              ...g,
              originX: newOriginX,
              originY: newOriginY,
              deckAnchorId: undefined,
              deckOffsetX: undefined,
              deckOffsetY: undefined,
              deckState: 'open',
              nestedDeck: undefined,
            }
          }
          if (subTreeIds.has(g.id)) {
            return { ...g, originX: g.originX + dx, originY: g.originY + dy }
          }
          return g
        }),
      }
    })
  },

  returnToDeck(cardId) {
    set(s => {
      // Find the parent that holds this card's ghost slot.
      const parent = s.groups.find(p => (p.ghostSlots ?? []).some(sl => sl.cardId === cardId))
      if (!parent) return {}
      const slot = (parent.ghostSlots ?? []).find(sl => sl.cardId === cardId)!
      const card = s.groups.find(g => g.id === cardId)
      if (!card) return {}
      const newOriginX = parent.originX + slot.deckOffsetX
      const newOriginY = parent.originY + slot.deckOffsetY
      // Shift any transitive sub-members by the anchor's delta so the whole
      // sub-tree lands intact at the slot position. Without this, returning a
      // sub-deck snaps the anchor home but leaves its members at the drag-drop
      // location, breaking the visual layout until the sub-deck is re-opened.
      const dx = newOriginX - card.originX
      const dy = newOriginY - card.originY
      const subTreeIds = getTransitiveDescendantIds(cardId, s.groups)
      const subTreeIdSet = new Set(subTreeIds)
      // Cards reachable inside the returning anchor (anchor + descendants) are
      // no longer "extracted" from the parent — they live inside parent again
      // via the nested-deck chain. Drop any of their lingering ghostSlots from
      // the parent so we don't render orphan slots in the fan.
      const reachable = new Set<string>([cardId, ...subTreeIds])
      return {
        groups: s.groups.map(g => {
          if (g.id === parent.id) {
            const slots = (g.ghostSlots ?? []).filter(sl => !reachable.has(sl.cardId))
            return { ...g, ghostSlots: slots.length > 0 ? slots : undefined }
          }
          if (g.id === cardId) {
            // Land at the slot position; the exact tether depends on whether
            // the parent is currently a deck (fanned/stacked) or open.
            const hasSubMembers = subTreeIds.length > 0
            const parentIsOpen = !parent.deckState || parent.deckState === 'open'
            if (hasSubMembers) {
              const own: 'stacked' | 'fanned' =
                (g.deckState === 'stacked' || g.deckState === 'fanned') ? g.deckState : 'stacked'
              if (parentIsOpen) {
                // Parent is currently NOT a deck. Re-tethering to it would
                // mark this card as a hidden deck member of a non-existent
                // fan — it'd vanish from view until the parent re-closes.
                // Instead, return as a self-anchored sub-deck on canvas at
                // the slot position. Sub-tree members travel along via the
                // delta shift below.
                return {
                  ...g,
                  originX: newOriginX,
                  originY: newOriginY,
                  deckAnchorId: g.id,
                  deckOffsetX: 0,
                  deckOffsetY: 0,
                  deckState: own,
                  nestedDeck: undefined,
                }
              }
              // Parent is fanned/stacked → A becomes a nested sub-deck
              // member, rendering as a strip in the parent's fan/stack.
              return {
                ...g,
                originX: newOriginX,
                originY: newOriginY,
                deckAnchorId: parent.id,
                deckOffsetX: slot.deckOffsetX,
                deckOffsetY: slot.deckOffsetY,
                deckState: own,
                nestedDeck: true,
              }
            }
            // No sub-members. parent.deckState='open' here gives the card
            // 'open' deckState — a standalone open card at the slot
            // position, matching the other now-open siblings.
            return {
              ...g,
              originX: newOriginX,
              originY: newOriginY,
              deckAnchorId: parent.id,
              deckOffsetX: slot.deckOffsetX,
              deckOffsetY: slot.deckOffsetY,
              deckState: parent.deckState ?? 'open',
              nestedDeck: undefined,
            }
          }
          if (subTreeIdSet.has(g.id)) {
            return { ...g, originX: g.originX + dx, originY: g.originY + dy }
          }
          return g
        }),
      }
    })
  },

  severDeckTether(cardId) {
    set(s => ({
      groups: s.groups.map(g => {
        const slots = g.ghostSlots
        if (!slots || !slots.some(sl => sl.cardId === cardId)) return g
        const filtered = slots.filter(sl => sl.cardId !== cardId)
        return { ...g, ghostSlots: filtered.length > 0 ? filtered : undefined }
      }),
    }))
  },

  setGroupPos(groupId, originY, originX) {
    const g = get().groups.find(gr => gr.id === groupId)
    if (g && g.originY === originY && g.originX === originX) return
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, originY, originX } : g) }))
  },

  setGroupPosBatch(updates) {
    if (updates.length === 0) return
    // Single-group shortcut
    if (updates.length === 1) {
      const u = updates[0]
      const g = get().groups.find(gr => gr.id === u.groupId)
      if (g && g.originY === u.originY && g.originX === u.originX) return
      set(s => ({ groups: s.groups.map(g => g.id === u.groupId ? { ...g, originY: u.originY, originX: u.originX } : g) }))
      return
    }
    // Build lookup for O(1) per-group update
    const lookup = new Map(updates.map(u => [u.groupId, u]))
    // Check if anything actually changed
    const groups = get().groups
    const anyChanged = updates.some(u => {
      const g = groups.find(gr => gr.id === u.groupId)
      return !g || g.originY !== u.originY || g.originX !== u.originX
    })
    if (!anyChanged) return
    set(s => ({
      groups: s.groups.map(g => {
        const u = lookup.get(g.id)
        return u ? { ...g, originY: u.originY, originX: u.originX } : g
      })
    }))
  },

  reassignBoard(boardId, targetGroupId, dropCanvasPos) {
    const s = get()
    const targetGroup = s.groups.find(g => g.id === targetGroupId)
    if (!targetGroup) return
    // Use explicit drop position if provided, otherwise compute from current state
    const absPos = dropCanvasPos ?? getBoardAbsolutePos(boardId, s.groups, s.boards)
    // Compute local position within the target group
    const nleX = absPos.x - targetGroup.originX
    const targetLayout = computeGroupLayout(targetGroup.boardIds, s.boards)
    const localY = absPos.y - targetGroup.originY
    const nleRow = yToRow(localY, targetLayout)
    set(s2 => {
      const board = s2.boards[boardId]
      if (!board) return s2
      const updatedBoard = { ...board, nleRow, nleX }
      let groups = s2.groups.map(g => {
        if (g.id === targetGroupId) return { ...g, boardIds: g.boardIds.includes(boardId) ? g.boardIds : [...g.boardIds, boardId] }
        return { ...g, boardIds: g.boardIds.filter(bid => bid !== boardId) }
      })
      // Drop any source group that became empty (except default-group)
      groups = groups.filter(g => g.id === 'default-group' || g.id === targetGroupId || g.boardIds.length > 0)
      return { boards: { ...s2.boards, [boardId]: updatedBoard }, groups }
    })
  },

  moveToNewGroup(boardId) {
    const s = get()
    const board = s.boards[boardId]
    if (!board) return
    // Keep group.name empty for brand-new groups — the UI renders "New Card"
    // as a dimmed placeholder when the field is empty. If the board already
    // has a user-entered name, carry it over.
    const name = board.projectName && board.projectName.length > 0 ? board.projectName : ''
    const color = board.color ?? '#5b8dd9'
    const id = crypto.randomUUID()
    // Use absolute position so the new group origin matches the board's current visual position
    const absPos = getBoardAbsolutePos(boardId, s.groups, s.boards)
    set(s2 => {
      let groups = s2.groups.map(g => ({
        ...g, boardIds: g.boardIds.filter(bid => bid !== boardId),
      }))
      // Drop any source group that became empty (except default-group)
      groups = groups.filter(g => g.id === 'default-group' || g.boardIds.length > 0)
      // Reset board's local position to 0,0 within the new group
      const updatedBoard = { ...s2.boards[boardId], nleRow: 0, nleX: 0 }
      const newGroup: ProjectGroup = { id, name, color, boardIds: [boardId], cardHeroImage: null, cardSummary: '', cardText: '', cardHeaderText: '', originY: absPos.y, originX: absPos.x }
      return { boards: { ...s2.boards, [boardId]: updatedBoard }, groups: [...groups, newGroup] }
    })
  },

  duplicateGroup(groupId) {
    const group = get().groups.find(g => g.id === groupId)
    if (!group) return null
    const newGroupId = crypto.randomUUID()
    const newBoardIds: string[] = []
    // Duplicate each board in the group
    group.boardIds.forEach(bid => {
      const newBid = get().duplicateBoard(bid)
      newBoardIds.push(newBid)
    })
    // Remove the duplicated boards from whatever group they landed in, create new group
    set(s => {
      const cleaned = s.groups.map(g => ({
        ...g, boardIds: g.boardIds.filter(bid => !newBoardIds.includes(bid)),
      }))
      const remaining = cleaned.filter(g => g.boardIds.length > 0)
      const newGroup: ProjectGroup = {
        id: newGroupId,
        name: group.name + ' copy',
        color: group.color,
        boardIds: newBoardIds,
        cardHeroImage: group.cardHeroImage,
        cardHeroTransform: group.cardHeroTransform ? { ...group.cardHeroTransform } : undefined,
        cardSummary: group.cardSummary,
        cardText: group.cardText ?? '',
        cardHeaderText: group.cardHeaderText ?? '',
        cardTextStyle: group.cardTextStyle ? { ...group.cardTextStyle } : undefined,
        cardHeaderTextStyle: group.cardHeaderTextStyle ? { ...group.cardHeaderTextStyle } : undefined,
        cardWidthOverride: group.cardWidthOverride,
        cardHeightOverride: group.cardHeightOverride,
        textSplitRatio: group.textSplitRatio,
        originY: group.originY + 100,
        originX: group.originX + 100,
      }
      return { groups: [...remaining, newGroup] }
    })
    return newGroupId
  },

  // ── Ungrouped board actions (free canvas) ──

  createUngroupedBoard(canvasX, canvasY) {
    const id = crypto.randomUUID()
    const rootId = crypto.randomUUID()
    const board: BoardData = {
      id, projectName: '', color: '#5b8dd9',
      nleRow: 0, nleX: 0,
      canvasX, canvasY,
      bars: {
        [rootId]: makeBar({ id: rootId, parentId: null, rowIndex: 0, x: 0, width: INIT_W, height: INIT_H }),
      },
      rootIds: [rootId],
      viewerBarId: null,
      selectedIds: [],
      savedCollapsedState: null,
      pristine: true,
      boardScale: 1,
      layers: { ...DEFAULT_LAYERS },
    }
    set(s => ({
      boards: { ...s.boards, [id]: board },
      boardOrder: [...s.boardOrder, id],
      // NOT added to any group — this is the key difference
    }))
    return id
  },

  ungroupBoard(boardId) {
    if (boardId === 'primary') return  // never ungroup primary
    const s = get()
    const group = s.groups.find(g => g.boardIds.includes(boardId))
    if (!group) return  // already ungrouped
    // Compute absolute canvas position before removing from group
    const absPos = getBoardAbsolutePos(boardId, s.groups, s.boards)
    set(s2 => {
      // Update board with absolute position
      const board = s2.boards[boardId]
      if (!board) return s2
      const updatedBoard = { ...board, canvasX: absPos.x, canvasY: absPos.y }
      // Remove from group
      let groups = s2.groups.map(g =>
        g.id === group.id ? { ...g, boardIds: g.boardIds.filter(bid => bid !== boardId) } : g
      )
      // Drop the source group if it became empty (except default-group)
      groups = groups.filter(g => g.id === 'default-group' || g.boardIds.length > 0)
      return { boards: { ...s2.boards, [boardId]: updatedBoard }, groups }
    })
  },

  groupBoard(boardId, targetGroupId) {
    const s = get()
    const board = s.boards[boardId]
    if (!board) return
    const group = s.groups.find(g => g.id === targetGroupId)
    if (!group) return
    // Compute local position within the target group
    const cx = board.canvasX ?? 0
    const cy = board.canvasY ?? 0
    const nleX = cx - group.originX
    const groupLayout = computeGroupLayout(group.boardIds, s.boards)
    const localY = cy - group.originY
    const nleRow = yToRow(localY, groupLayout)
    set(s2 => {
      const updatedBoard = { ...s2.boards[boardId], nleRow, nleX, canvasX: undefined, canvasY: undefined }
      const groups = s2.groups.map(g =>
        g.id === targetGroupId ? { ...g, boardIds: [...g.boardIds, boardId] } : g
      )
      return { boards: { ...s2.boards, [boardId]: updatedBoard }, groups }
    })
  },

  groupBoardAsNew(boardId) {
    const board = get().boards[boardId]
    if (!board) return
    const cx = board.canvasX ?? 0
    const cy = board.canvasY ?? 0
    const id = crypto.randomUUID()
    const newGroup: ProjectGroup = {
      id,
      // Empty so the UI renders "New Card" as a dimmed placeholder.
      name: board.projectName && board.projectName.length > 0 ? board.projectName : '',
      color: board.color ?? '#5b8dd9',
      boardIds: [boardId],
      cardHeroImage: null,
      cardSummary: '',
      cardText: '',
      cardHeaderText: '',
      originY: cy,
      originX: cx,
    }
    set(s => {
      const updatedBoard = { ...s.boards[boardId], nleRow: 0, nleX: 0, canvasX: undefined, canvasY: undefined }
      return {
        boards: { ...s.boards, [boardId]: updatedBoard },
        groups: [...s.groups, newGroup],
      }
    })
  },

  setUngroupedBoardPos(boardId, canvasX, canvasY) {
    const b = get().boards[boardId]
    if (b && b.canvasX === canvasX && b.canvasY === canvasY) return
    updateBoard(set, boardId, () => ({ canvasX, canvasY }))
  },

  setSelectedGroup(groupId) {
    set({ selectedGroupIds: groupId ? [groupId] : [] })
  },
  toggleGroupSelection(groupId) {
    set(s => {
      const ids = s.selectedGroupIds
      return { selectedGroupIds: ids.includes(groupId) ? ids.filter(id => id !== groupId) : [...ids, groupId] }
    })
  },
  setSelectedGroups(groupIds) {
    set({ selectedGroupIds: groupIds })
  },
  clearGroupSelection() {
    set({ selectedGroupIds: [] })
  },

  // ── One-way group linking ──
  // Stores only the outbound direction: "a references b". The reverse
  // (back-reference) is derived at render time via `getBackRefs`.
  // This lets the UI present asymmetric weights: the link you *made* is
  // prominent on your card; the back-reference on the referenced card
  // is smaller/muted.
  linkGroups(a, b) {
    if (!a || !b || a === b) return
    set(s => ({
      groups: s.groups.map(g => {
        if (g.id !== a) return g
        const cur = g.linkedGroupIds ?? []
        return cur.includes(b) ? g : { ...g, linkedGroupIds: [...cur, b] }
      }),
    }))
  },
  unlinkGroups(a, b) {
    if (!a || !b) return
    set(s => ({
      groups: s.groups.map(g => {
        if (g.id !== a) return g
        const cur = g.linkedGroupIds ?? []
        return cur.includes(b) ? { ...g, linkedGroupIds: cur.filter(id => id !== b) } : g
      }),
    }))
  },
}), {
  name: 'vidbars-boards',
  storage: createDebouncedIDBStorage(400),
  version: 12,
  migrate(persisted: any, version: number) {
    if (version < 3) {
      const boards = persisted.boards ?? {}
      for (const key of Object.keys(boards)) {
        if (!boards[key].layers) {
          boards[key].layers = { card: { heroImage: null, summary: '' }, block: { thumbnail: null, label: '' } }
        }
      }
    }
    if (version < 4) {
      const boardOrder: string[] = persisted.boardOrder ?? []
      const primary = persisted.boards?.['primary']
      const heroImage = primary?.layers?.card?.heroImage ?? null
      const summary = primary?.layers?.card?.summary ?? ''
      const color = primary?.color ?? '#5b8dd9'
      persisted.groups = [{
        id: 'default-group',
        name: 'NLE Timeline',
        color,
        boardIds: ['primary', ...boardOrder],
        cardHeroImage: heroImage,
        cardSummary: summary,
        originY: 0, originX: 0,
      }]
    }
    if (version < 5) {
      // v4→v5: Convert global nleRow/nleX to group-local + compute group origins.
      // Each group's origin = the minimum absolute position of its boards.
      // Each board's nleRow/nleX becomes relative to the group origin.
      //
      // For primary board: its global Y was stored in canvasStore.boardPos.y,
      // and its nleRow was 0. We read canvasStore separately and set primary's
      // nleRow/nleX in the group-local system.
      const boards = persisted.boards ?? {}
      const groups: any[] = persisted.groups ?? []
      const ROW_GAP = 16
      const FIXED_H = 300  // default nleRowHeight

      // Read canvasStore from localStorage to get primary board's absolute position
      let primaryAbsY = 0
      let primaryAbsX = 0
      try {
        const canvasRaw = localStorage.getItem('vidbars-canvas')
        if (canvasRaw) {
          const cs = JSON.parse(canvasRaw)?.state
          if (cs?.boardPos) {
            primaryAbsY = cs.boardPos.y ?? 0
            primaryAbsX = cs.boardPos.x ?? 0
          }
        }
      } catch {}

      // Helper: get a board's absolute Y from old global nleRow
      function oldAbsY(bid: string): number {
        if (bid === 'primary') return primaryAbsY
        const b = boards[bid]
        if (!b) return 0
        return (b.nleRow ?? 0) * (FIXED_H + ROW_GAP)
      }
      function oldAbsX(bid: string): number {
        if (bid === 'primary') return primaryAbsX
        return boards[bid]?.nleX ?? 0
      }

      groups.forEach((g: any) => {
        const bids: string[] = g.boardIds ?? []
        if (bids.length === 0) {
          g.originY = 0
          g.originX = 0
          return
        }

        // Group origin = min absolute position of its boards
        const absYs = bids.map(oldAbsY)
        const absXs = bids.map(oldAbsX)
        const minY = Math.min(...absYs)
        const minX = Math.min(...absXs)
        g.originY = minY
        g.originX = minX

        // Convert each board to group-local coordinates
        bids.forEach(bid => {
          const b = boards[bid]
          if (!b) return
          const absY = oldAbsY(bid)
          // Compute local row from Y offset within group
          const localY = absY - minY
          const localRow = Math.round(localY / (FIXED_H + ROW_GAP))
          b.nleRow = localRow
          b.nleX = oldAbsX(bid) - minX
        })
      })

      persisted.groups = groups
    }
    if (version < 7) {
      // v6→v7: Compact group-local nleRow values to sequential 0, 1, 2...
      // Previous data may have gaps or non-zero-based row numbers.
      const boards = persisted.boards ?? {}
      const groups: any[] = persisted.groups ?? []
      groups.forEach((g: any) => {
        const bids: string[] = g.boardIds ?? []
        if (bids.length === 0) return
        // Collect unique row numbers, sort them, map to 0-based sequential
        const rowSet = new Set<number>()
        bids.forEach(bid => { if (boards[bid]) rowSet.add(boards[bid].nleRow ?? 0) })
        const sorted = [...rowSet].sort((a, b) => a - b)
        const rowMap = new Map<number, number>()
        sorted.forEach((oldRow, idx) => rowMap.set(oldRow, idx))
        bids.forEach(bid => {
          const b = boards[bid]
          if (b) b.nleRow = rowMap.get(b.nleRow ?? 0) ?? 0
        })
      })
      persisted.groups = groups
    }
    if (version < 9) {
      // v8→v9: Add independent text fields to layers and groups
      const boards = persisted.boards ?? {}
      for (const b of Object.values(boards) as any[]) {
        if (b.layers?.card && !('text' in b.layers.card)) b.layers.card.text = ''
        if (b.layers?.block && !('text' in b.layers.block)) b.layers.block.text = ''
      }
      const groups: any[] = persisted.groups ?? []
      for (const g of groups) {
        if (!('cardText' in g)) g.cardText = ''
      }
    }
    if (version < 10) {
      // v9→v10: Backfill deckAnchorId for groups that have deckState set.
      // Groups with deckState !== 'open' but no deckAnchorId need one.
      // Reset them to 'open' so user can re-stack cleanly.
      const groups: any[] = persisted.groups ?? []
      for (const g of groups) {
        if (g.deckState && g.deckState !== 'open' && !g.deckAnchorId) {
          g.deckState = 'open'
        }
      }
    }
    if (version < 11) {
      // v10→v11: Backfill linkedGroupIds for bi-directional deck linking.
      const groups: any[] = persisted.groups ?? []
      for (const g of groups) {
        if (!Array.isArray(g.linkedGroupIds)) g.linkedGroupIds = []
      }
    }
    if (version < 12) {
      // v11→v12: Sweep "phantom" groups whose boardIds all resolve to
      // missing or empty boards (no valid root bars). Such groups
      // accumulated from interrupted localStorage writes, abandoned
      // create flows, and old migrations; the canvas renders them as
      // 0×0 (invisible) but the Rolodex would still list them. This
      // mirrors the validity check the canvas already applies in
      // CardLayer.tsx (see the GroupCard bounds calc).
      const boards = persisted.boards ?? {}
      const groups: any[] = persisted.groups ?? []
      const isRenderable = (g: any): boolean => {
        for (const bid of (g.boardIds ?? [])) {
          const board = boards[bid]
          if (!board) continue
          for (const rid of (board.rootIds ?? [])) {
            if (board.bars && board.bars[rid]) return true
          }
        }
        return false
      }
      const cleaned = groups.filter(isRenderable)
      // Invariant: keep at least one group so the canvas always has a
      // destination for new boards. If every group was phantom, fall
      // back to the original first group (almost always default-group).
      persisted.groups = cleaned.length > 0
        ? cleaned
        : (groups.length > 0 ? [groups[0]] : [])
    }
    return persisted as BoardsState
  },
  partialize: (s) => ({
    boards: Object.fromEntries(
      Object.entries(s.boards).map(([id, b]) => [id, {
        ...b,
        viewerBarId: null,
        selectedIds: [],
      }])
    ),
    boardOrder: s.boardOrder,
    groups: s.groups,
  }),
}))
