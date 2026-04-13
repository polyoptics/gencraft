import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createDebouncedStorage } from '../utils/debouncedStorage'
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
export interface ProjectGroup {
  id: string
  name: string
  color: string
  boardIds: string[]   // ordered, can include 'primary'
  cardHeroImage: string | null
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
  textSplitRatio?: number // header/body vertical split (0-1, default 0.5)
}

/** Find which group a board belongs to */
export function getGroupForBoard(groups: ProjectGroup[], boardId: string): ProjectGroup | undefined {
  return groups.find(g => g.boardIds.includes(boardId))
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
    label: string              // display name override at block zoom
    text: string               // independent body text at block zoom
    textStyle?: import('../store/freeNodeStore').TextStyle
    headerText?: string
    headerTextStyle?: import('../store/freeNodeStore').TextStyle
    widthOverride?: number     // user-set width (canvas px, pre-zoom)
    heightOverride?: number    // user-set height (canvas px, pre-zoom)
    textSplitRatio?: number    // header/body vertical split (0-1, default 0.5)
  }
  // Board layer uses bar tree directly — no extra fields needed
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
  setGroupCardSummary: (groupId: string, summary: string) => void
  setGroupCardText: (groupId: string, text: string) => void
  setGroupCardTextStyle: (groupId: string, style: import('../store/freeNodeStore').TextStyle) => void
  setGroupCardHeaderText: (groupId: string, text: string) => void
  setGroupCardHeaderTextStyle: (groupId: string, style: import('../store/freeNodeStore').TextStyle) => void
  setGroupCardSize: (groupId: string, w: number | undefined, h: number | undefined) => void
  setGroupTextSplitRatio: (groupId: string, ratio: number) => void
  setBlockTextSplitRatio: (boardId: string, ratio: number) => void
  setCardTextSplitRatio: (boardId: string, ratio: number) => void
  setDeckState: (groupIds: string[], state: 'open' | 'fanned' | 'stacked') => void
  setGroupPos: (groupId: string, originY: number, originX: number) => void
  reassignBoard: (boardId: string, targetGroupId: string, dropCanvasPos?: { x: number; y: number }) => void
  moveToNewGroup: (boardId: string) => void
  duplicateGroup: (groupId: string) => string | null
  selectedGroupIds: string[]
  setSelectedGroup: (groupId: string | null) => void
  toggleGroupSelection: (groupId: string) => void
  setSelectedGroups: (groupIds: string[]) => void
  clearGroupSelection: () => void

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
      id, projectName: 'New VidBar', color: '#5b8dd9',
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
      id, projectName: src.projectName + ' copy', color: src.color,
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
      layers: { ...b.layers, block: { ...b.layers.block, thumbnail: url } },
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
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardHeroImage: url } : g) }))
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

  setDeckState(groupIds, state) {
    const idSet = new Set(groupIds)
    // The first ID in the array is the anchor (leftmost card in the cluster)
    const anchorId = state === 'open' ? undefined : groupIds[0]
    set(s => {
      // Detect sub-deck anchors: members whose ID is referenced by
      // deckAnchorId of groups OUTSIDE this set (they anchor a nested sub-deck)
      const subDeckAnchors = new Set<string>()
      for (const g of s.groups) {
        if (!idSet.has(g.id) && g.deckAnchorId && idSet.has(g.deckAnchorId)) {
          subDeckAnchors.add(g.deckAnchorId)
        }
      }
      // Find the anchor group for offset computation
      const anchorGroup = anchorId ? s.groups.find(g => g.id === anchorId) : null
      // For opening: the first ID is the anchor whose current position is the reference
      const openAnchor = state === 'open' ? s.groups.find(g => g.id === groupIds[0]) : null

      return {
        groups: s.groups.map(g => {
          if (!idSet.has(g.id)) return g
          if (subDeckAnchors.has(g.id)) {
            // Sub-deck anchor: only update parent membership, preserve sub-deck state
            // Store offset from parent anchor for position restore
            const offX = anchorGroup ? g.originX - anchorGroup.originX : g.deckOffsetX
            const offY = anchorGroup ? g.originY - anchorGroup.originY : g.deckOffsetY
            return { ...g, deckAnchorId: anchorId, nestedDeck: true, deckOffsetX: offX, deckOffsetY: offY }
          }
          if (state === 'open') {
            // Restore position relative to anchor's current position
            let ox = g.originX, oy = g.originY
            if (openAnchor && g.deckOffsetX != null && g.deckOffsetY != null && g.id !== groupIds[0]) {
              ox = openAnchor.originX + g.deckOffsetX
              oy = openAnchor.originY + g.deckOffsetY
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

  setGroupPos(groupId, originY, originX) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, originY, originX } : g) }))
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
      return { boards: { ...s2.boards, [boardId]: updatedBoard }, groups }
    })
  },

  moveToNewGroup(boardId) {
    const s = get()
    const board = s.boards[boardId]
    if (!board) return
    const name = board.projectName ?? 'New Group'
    const color = board.color ?? '#5b8dd9'
    const id = crypto.randomUUID()
    // Use absolute position so the new group origin matches the board's current visual position
    const absPos = getBoardAbsolutePos(boardId, s.groups, s.boards)
    set(s2 => {
      const groups = s2.groups.map(g => ({
        ...g, boardIds: g.boardIds.filter(bid => bid !== boardId),
      }))
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
        cardSummary: group.cardSummary,
        cardText: group.cardText ?? '',
        cardHeaderText: group.cardHeaderText ?? '',
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
      id, projectName: 'New VidBar', color: '#5b8dd9',
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
      const groups = s2.groups.map(g =>
        g.id === group.id ? { ...g, boardIds: g.boardIds.filter(bid => bid !== boardId) } : g
      )
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
      name: board.projectName ?? 'New Group',
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
}), {
  name: 'vidbars-boards',
  storage: createJSONStorage(() => createDebouncedStorage(500)),
  version: 10,
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
