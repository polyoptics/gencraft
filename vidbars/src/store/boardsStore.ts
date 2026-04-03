import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Bar } from '../types/bar'
import { TEMPLATES } from '../data/templates'
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

export interface BoardData {
  id: string
  projectName: string
  color: string        // board-level color (NLE overview block)
  nleRow: number       // which NLE row (integer, snapped)
  nleX: number         // horizontal canvas position
  bars: Record<string, Bar>
  rootIds: string[]
  viewerBarId: string | null
  selectedIds: string[]
  savedCollapsedState: Record<string, boolean> | null
  pristine: boolean
  boardScale: number   // content zoom (primary only, but stored per-board for generality)
}

interface BoardsState {
  boards: Record<string, BoardData>
  boardOrder: string[]    // does NOT include 'primary'

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
}

export const useBoardsStore = create<BoardsState>()(persist((set, get) => ({
  boards: { primary: PRIMARY_BOARD },
  boardOrder: [],

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
    }
    set(s => ({ boards: { ...s.boards, [id]: board }, boardOrder: [...s.boardOrder, id] }))
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
    }
    set(s => ({ boards: { ...s.boards, [id]: board }, boardOrder: [...s.boardOrder, id] }))
    return id
  },

  deleteBoard(id) {
    set(s => {
      const { [id]: _, ...rest } = s.boards
      return { boards: rest, boardOrder: s.boardOrder.filter(x => x !== id) }
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
}), {
  name: 'vidbars-boards',
  version: 2,
  migrate(persisted: any, _version: number) {
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
  }),
}))
