/**
 * Unified undo/redo coordinator.
 *
 * Call checkpoint() at the START of each user interaction (pointerdown, click).
 * It captures the current state. On undo, that state is restored.
 * No debounce, no throttle — explicit checkpoints only.
 *
 * Snapshots are deep-cloned (structuredClone) so they are fully isolated
 * from the live Zustand state — no shared references.
 *
 * Transient per-board fields (selectedIds, viewerBarId, savedCollapsedState)
 * are stripped from snapshots so undo never disturbs selection / viewer state.
 */

import { useBoardsStore } from './boardsStore'
import { useCanvasStore } from './canvasStore'
import { useFreeNodeStore } from './freeNodeStore'
import { create } from 'zustand'

const LIMIT = 30

const CANVAS_EXCLUDE = new Set(['focusedBoardId', 'pan', 'zoom'])
const FREE_EXCLUDE = new Set(['selectedIds'])

// Per-board keys that are transient and should NOT participate in undo
const BOARD_TRANSIENT = ['selectedIds', 'viewerBarId', 'savedCollapsedState'] as const

interface Snapshot {
  boards: Record<string, unknown>
  canvas: Record<string, unknown>
  freeNodes: Record<string, unknown>
}

function snapStore(
  state: Record<string, unknown>,
  exclude: Set<string>,
): Record<string, unknown> {
  const snap: Record<string, unknown> = {}
  for (const key of Object.keys(state)) {
    if (!exclude.has(key) && typeof state[key] !== 'function') {
      snap[key] = state[key]
    }
  }
  return snap
}

/** Deep-clone boards, stripping transient fields from each board entry */
function snapBoards(boards: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {}
  for (const [id, board] of Object.entries(boards)) {
    const clean: Record<string, unknown> = {}
    for (const key of Object.keys(board)) {
      if (!(BOARD_TRANSIENT as readonly string[]).includes(key)) {
        clean[key] = board[key]
      }
    }
    result[id] = clean
  }
  return result
}

function captureSnapshot(): Snapshot {
  const boardsState = useBoardsStore.getState() as unknown as Record<string, unknown>
  const boards = boardsState.boards as Record<string, Record<string, unknown>>

  // Deep-clone the entire snapshot so it's fully isolated from live state
  return structuredClone({
    boards: {
      boards: snapBoards(boards),
      boardOrder: boardsState.boardOrder,
    },
    canvas: snapStore(
      useCanvasStore.getState() as unknown as Record<string, unknown>,
      CANVAS_EXCLUDE,
    ),
    freeNodes: snapStore(
      useFreeNodeStore.getState() as unknown as Record<string, unknown>,
      FREE_EXCLUDE,
    ),
  })
}

function restoreSnapshot(snap: Snapshot) {
  // For boardsStore: merge snapshot data but preserve current transient fields
  const currentBoards = (useBoardsStore.getState() as unknown as Record<string, unknown>)
    .boards as Record<string, Record<string, unknown>>
  const snapBoardsData = snap.boards as Record<string, unknown>
  const snapBoardEntries = snapBoardsData.boards as Record<string, Record<string, unknown>>

  const merged: Record<string, Record<string, unknown>> = {}
  for (const [id, snapBoard] of Object.entries(snapBoardEntries)) {
    const current = currentBoards[id]
    merged[id] = {
      ...snapBoard,
      // Preserve transient fields from current state
      selectedIds: current?.selectedIds ?? [],
      viewerBarId: current?.viewerBarId ?? null,
      savedCollapsedState: current?.savedCollapsedState ?? null,
    }
  }

  useBoardsStore.setState({ boards: merged, boardOrder: snapBoardsData.boardOrder })
  useCanvasStore.setState(snap.canvas)
  useFreeNodeStore.setState(snap.freeNodes)
}

interface UndoCoordinatorState {
  canUndo: boolean
  canRedo: boolean
  /** Call at the START of a user interaction to save the "before" state */
  checkpoint: () => void
  undo: () => void
  redo: () => void
  clearHistory: () => void
}

const undoStack: Snapshot[] = []
const redoStack: Snapshot[] = []
let restoring = false

export const useUndoCoordinator = create<UndoCoordinatorState>()((set) => ({
  canUndo: false,
  canRedo: false,

  checkpoint() {
    if (restoring) return
    undoStack.push(captureSnapshot())
    if (undoStack.length > LIMIT) undoStack.shift()
    redoStack.length = 0
    set({ canUndo: true, canRedo: false })
  },

  undo() {
    if (undoStack.length === 0) return
    redoStack.push(captureSnapshot())
    const prev = undoStack.pop()!
    restoring = true
    restoreSnapshot(prev)
    restoring = false
    set({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 })
  },

  redo() {
    if (redoStack.length === 0) return
    undoStack.push(captureSnapshot())
    const next = redoStack.pop()!
    restoring = true
    restoreSnapshot(next)
    restoring = false
    set({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 })
  },

  clearHistory() {
    undoStack.length = 0
    redoStack.length = 0
    set({ canUndo: false, canRedo: false })
  },
}))
