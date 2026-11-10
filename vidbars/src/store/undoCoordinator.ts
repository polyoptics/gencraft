/**
 * Unified undo/redo coordinator.
 *
 * Call checkpoint() at the START of each user interaction (pointerdown, click).
 * It captures the current state. On undo, that state is restored.
 * No debounce, no throttle — explicit checkpoints only.
 *
 * Snapshots use targeted cloning: only boards.bars (deeply nested bar trees)
 * are structuredClone'd. Everything else is shallow-copied since Zustand's
 * immutable updates already create new references on mutation.
 *
 * Transient per-board fields (selectedIds, viewerBarId, savedCollapsedState)
 * are stripped from snapshots so undo never disturbs selection / viewer state.
 */

import { useBoardsStore } from './boardsStore'
import { useCanvasStore } from './canvasStore'
import { useFreeNodeStore } from './freeNodeStore'
import { useViewport3DStore } from './viewport3dStore'
import type { ViewportWindow3D } from './viewport3dStore'
import { tileDeckIndex } from '../utils/tileDecks'
import { create } from 'zustand'
import { useNotesStore } from './notesStore'
import { useModelScaleStore } from './tiltStore'

const LIMIT = 30

// Panel visibility / position / size are a "look", not an edit, and are
// written without checkpoints — leaving them in meant "edit, move the
// panel, Ctrl+Z" teleported the panel back. Same reasoning as the
// viewport camera/text-zoom merge below. homeRolodexId is deliberately
// NOT excluded: identity must be undone with the node it names.
const CANVAS_EXCLUDE = new Set([
  'focusedBoardId', 'pan', 'zoom',
  'rolodexOpen', 'rolodexPos', 'rolodexExpansion',
  // The world clock's bar being out is a look too (utils/worldClock).
  'worldClockOpen',
])
const FREE_EXCLUDE = new Set(['selectedIds'])

// Per-board keys that are transient and should NOT participate in undo
const BOARD_TRANSIENT = ['selectedIds', 'viewerBarId', 'savedCollapsedState'] as const

interface Snapshot {
  boards: Record<string, unknown>
  canvas: Record<string, unknown>
  freeNodes: Record<string, unknown>
  viewports3d: Record<string, ViewportWindow3D>
  /** The 3D notes: curves, and strokes and pins on models (store/notesStore). */
  notes?: { curves: unknown; models: unknown; pictures?: unknown }
  /** Models' size and turn on their cards (tiltStore useModelScaleStore). */
  models3d?: { sizeOf: unknown; poseOf: unknown; tintOf?: unknown; placeOf?: unknown; stretchOf?: unknown; lensOf?: unknown; floatOf?: unknown }
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

/** Clone boards with targeted deep-cloning: only bars (deeply nested trees) use structuredClone */
function snapBoards(boards: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {}
  for (const [id, board] of Object.entries(boards)) {
    const clean: Record<string, unknown> = {}
    for (const key of Object.keys(board)) {
      if (!(BOARD_TRANSIENT as readonly string[]).includes(key)) {
        // Deep-clone only the bars tree (complex nested structure)
        clean[key] = key === 'bars' ? structuredClone(board[key]) : board[key]
      }
    }
    result[id] = clean
  }
  return result
}

function captureSnapshot(): Snapshot {
  const boardsState = useBoardsStore.getState() as unknown as Record<string, unknown>
  const boards = boardsState.boards as Record<string, Record<string, unknown>>

  // Targeted cloning: deep-clone only bars (via snapBoards), shallow-copy everything else
  return {
    boards: {
      boards: snapBoards(boards),
      boardOrder: boardsState.boardOrder,
      // Include groups so undo restores group positions, colors, deck states
      groups: boardsState.groups,
    },
    canvas: snapStore(
      useCanvasStore.getState() as unknown as Record<string, unknown>,
      CANVAS_EXCLUDE,
    ),
    freeNodes: snapStore(
      useFreeNodeStore.getState() as unknown as Record<string, unknown>,
      FREE_EXCLUDE,
    ),
    // View prefs (camera, text zoom) ride IN the snapshot; restoreSnapshot
    // is what keeps them out of history — see the liveness test there.
    viewports3d: useViewport3DStore.getState().windows,
    notes: { curves: useNotesStore.getState().curves, models: useNotesStore.getState().models, pictures: useNotesStore.getState().pictures },
    models3d: { sizeOf: useModelScaleStore.getState().sizeOf, poseOf: useModelScaleStore.getState().poseOf, tintOf: useModelScaleStore.getState().tintOf, placeOf: useModelScaleStore.getState().placeOf, stretchOf: useModelScaleStore.getState().stretchOf, lensOf: useModelScaleStore.getState().lensOf, floatOf: useModelScaleStore.getState().floatOf },
  }
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

  const restoreData: Record<string, unknown> = { boards: merged, boardOrder: snapBoardsData.boardOrder }
  if (snapBoardsData.groups !== undefined) restoreData.groups = snapBoardsData.groups
  useBoardsStore.setState(restoreData)
  useCanvasStore.setState(snap.canvas)
  useFreeNodeStore.setState(snap.freeNodes)
  // Selection is transient and survives undo (FREE_EXCLUDE), but a tile the
  // restored state hides behind a deck face must not stay selected: undoing
  // an expand would leave the whole deck selected behind one ringed face,
  // and Copy or Delete would then act on tiles the user cannot see.
  const fs = useFreeNodeStore.getState()
  const { hidden } = tileDeckIndex(fs.nodes)
  if (fs.selectedIds.some(id => hidden.has(id))) {
    useFreeNodeStore.setState({ selectedIds: fs.selectedIds.filter(id => !hidden.has(id)) })
  }
  // Viewports: restore the records, but VIEW PREFS always come from the
  // LIVE window while it still exists — an orbit or a reading size is a
  // "look", not an edit, so an unrelated undo must never yank either. A
  // window present ONLY in the snapshot (undo of its close, redo past its
  // creation) is restored whole, so its looks come back WITH it instead
  // of being silently dropped.
  const currentWins = useViewport3DStore.getState().windows
  const mergedWins: Record<string, ViewportWindow3D> = {}
  for (const [id, snapWin] of Object.entries(snap.viewports3d)) {
    const live = currentWins[id]
    mergedWins[id] = live
      ? {
          ...snapWin,
          camera: live.camera,
          cameraUrl: live.cameraUrl,
          textScales: live.textScales,
          defaultTextScale: live.defaultTextScale,
        }
      : snapWin
  }
  useViewport3DStore.setState({ windows: mergedWins })
  if (snap.notes) {
    const ns = useNotesStore.getState()
    useNotesStore.setState({ curves: snap.notes.curves as typeof ns.curves, models: snap.notes.models as typeof ns.models, pictures: (snap.notes.pictures ?? {}) as typeof ns.pictures, rev: ns.rev + 1 })
  }
  if (snap.models3d) {
    type MS = ReturnType<typeof useModelScaleStore.getState>
    useModelScaleStore.setState({ sizeOf: snap.models3d.sizeOf as MS['sizeOf'], poseOf: snap.models3d.poseOf as MS['poseOf'], tintOf: (snap.models3d.tintOf ?? {}) as MS['tintOf'], placeOf: (snap.models3d.placeOf ?? {}) as MS['placeOf'], stretchOf: (snap.models3d.stretchOf ?? {}) as MS['stretchOf'], lensOf: (snap.models3d.lensOf ?? {}) as MS['lensOf'], floatOf: (snap.models3d.floatOf ?? {}) as MS['floatOf'] })
  }
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
/** Whether an undo or redo is putting a snapshot back right now. */
export const isUndoRestoring = () => restoring

/** Called after every undo or redo has restored a snapshot — for work that
 *  is still writing into the state the user just stepped back from (a loop
 *  strip's run, utils/fx/railRun). */
const restoreListeners = new Set<() => void>()
export function onUndoRestore(fn: () => void): () => void {
  restoreListeners.add(fn)
  return () => { restoreListeners.delete(fn) }
}

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
    for (const fn of restoreListeners) fn()
  },

  redo() {
    if (redoStack.length === 0) return
    undoStack.push(captureSnapshot())
    const next = redoStack.pop()!
    restoring = true
    restoreSnapshot(next)
    restoring = false
    set({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 })
    for (const fn of restoreListeners) fn()
  },

  clearHistory() {
    undoStack.length = 0
    redoStack.length = 0
    set({ canUndo: false, canRedo: false })
  },
}))
