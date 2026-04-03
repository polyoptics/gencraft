import { useEffect } from 'react'
import { InfiniteCanvas } from './components/Canvas/InfiniteCanvas'
import { BoardsCanvas } from './components/NLE/BoardsCanvas'
import { NLETimelineHeader } from './components/NLE/NLETimelineHeader'
import { NLETimelineViewer } from './components/NLE/NLETimelineViewer'
import { FreeCanvas } from './components/Canvas/FreeCanvas'
import { Viewer } from './components/Viewer/Viewer'
import { TemplateMenu } from './components/UI/TemplateMenu'
import { useBoardsStore } from './store/boardsStore'
import { useCanvasStore } from './store/canvasStore'
import { useFreeNodeStore } from './store/freeNodeStore'
import { useUndoCoordinator } from './store/undoCoordinator'
import type { Bar } from './types/bar'
import { collectSubtree } from './utils/barOps'

function AllViewers() {
  const boardOrder = useBoardsStore(s => s.boardOrder)
  return (
    <>
      <Viewer boardId="primary" />
      {boardOrder.map(id => <Viewer key={id} boardId={id} />)}
    </>
  )
}

// Module-level clipboard — survives re-renders
interface Clipboard {
  bars: Record<string, Bar>
  rootIds: string[]
  boardId: string        // source board
  isWholeBoard: boolean  // true → paste creates new board; false → paste adds bars
}
let clipboard: Clipboard | null = null

function remapIds(bars: Record<string, Bar>, rootIds: string[]): { bars: Record<string, Bar>; rootIds: string[] } {
  const idMap = new Map<string, string>()
  Object.keys(bars).forEach(id => { idMap.set(id, crypto.randomUUID()) })
  const remapped: Record<string, Bar> = {}
  Object.values(bars).forEach(bar => {
    const newId = idMap.get(bar.id)!
    remapped[newId] = {
      ...bar,
      id: newId,
      parentId: bar.parentId ? (idMap.get(bar.parentId) ?? null) : null,
      children: bar.children.map(cid => idMap.get(cid) ?? cid),
    }
  })
  return { bars: remapped, rootIds: rootIds.map(id => idMap.get(id) ?? id) }
}

function useKeyboardCopyPaste() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      if (e.key === 'c' || e.key === 'C') {
        const { boards } = useBoardsStore.getState()
        // Bar-level copy: any board has selected bars
        for (const board of Object.values(boards)) {
          if (board.selectedIds.length > 0) {
            const allIds = [...new Set(board.selectedIds.flatMap(id => collectSubtree(board.bars, id)))]
            const copied: Record<string, Bar> = {}
            allIds.forEach(id => { if (board.bars[id]) copied[id] = board.bars[id] })
            const copiedSet = new Set(allIds)
            const rootIds = board.selectedIds.filter(id => {
              const bar = board.bars[id]
              return !bar?.parentId || !copiedSet.has(bar.parentId)
            })
            clipboard = { bars: copied, rootIds, boardId: board.id, isWholeBoard: false }
            return
          }
        }
        // Board-level copy: no bars selected, but a board is focused
        const focusedId = useCanvasStore.getState().focusedBoardId
        if (focusedId) {
          const board = boards[focusedId]
          if (board) {
            clipboard = { bars: board.bars, rootIds: board.rootIds, boardId: focusedId, isWholeBoard: true }
          }
        }
      }

      if (e.key === 'v' || e.key === 'V') {
        if (!clipboard) return
        useUndoCoordinator.getState().checkpoint()
        if (clipboard.isWholeBoard) {
          // Paste as new board
          useBoardsStore.getState().duplicateBoard(clipboard.boardId)
        } else {
          // Paste bars into same board
          const { bars: remappedBars, rootIds: remappedRoots } = remapIds(clipboard.bars, clipboard.rootIds)
          useBoardsStore.getState().importBars(clipboard.boardId, remappedBars, remappedRoots, 40)
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
}

function useKeyboardDelete() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      useUndoCoordinator.getState().checkpoint()
      const { boards } = useBoardsStore.getState()
      let deletedBars = false
      Object.values(boards).forEach(board => {
        if (board.selectedIds.length > 0) {
          ;[...board.selectedIds].forEach(id =>
            useBoardsStore.getState().deleteBar(board.id, id)
          )
          useBoardsStore.getState().clearSelection(board.id)
          deletedBars = true
        }
      })

      // Board-level delete: no bars selected, focused board is an extra board
      if (!deletedBars) {
        const focusedId = useCanvasStore.getState().focusedBoardId
        if (focusedId && focusedId !== 'primary' && boards[focusedId]) {
          useBoardsStore.getState().deleteBoard(focusedId)
          useCanvasStore.getState().setFocusedBoard(null)
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
}

function useKeyboardUndo() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== 'z' && e.key !== 'Z')) return
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()

      if (e.shiftKey) {
        useUndoCoordinator.getState().redo()
      } else {
        useUndoCoordinator.getState().undo()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
}

function UndoRedoButtons() {
  const canUndo = useUndoCoordinator(s => s.canUndo)
  const canRedo = useUndoCoordinator(s => s.canRedo)
  const undo = useUndoCoordinator(s => s.undo)
  const redo = useUndoCoordinator(s => s.redo)

  const btn = (enabled: boolean): React.CSSProperties => ({
    background: 'none',
    border: 'none',
    color: enabled ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.15)',
    fontSize: 16,
    cursor: enabled ? 'pointer' : 'default',
    padding: '2px 6px',
    fontFamily: 'inherit',
    lineHeight: 1,
  })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <button style={btn(canUndo)} onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">↩</button>
      <button style={btn(canRedo)} onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">↪</button>
    </div>
  )
}

export default function App() {
  useKeyboardDelete()
  useKeyboardCopyPaste()
  useKeyboardUndo()

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', background: '#0d0e1a' }}>

      {/* ── Toolbar ── */}
      <div style={{
        height: 38, flexShrink: 0,
        background: '#080910',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        display: 'flex', alignItems: 'center',
        padding: '0 16px', gap: 10, zIndex: 600,
      }}>
        <span style={{ color: '#fff', fontSize: 14, fontWeight: 800, letterSpacing: '-0.5px' }}>VidBars</span>
        <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)' }} />
        <span style={{ color: 'rgba(255,255,255,0.22)', fontSize: 11 }}>GenAI Video Composer</span>
        <div style={{ flex: 1 }} />
        <UndoRedoButtons />
        <span style={{ color: 'rgba(255,255,255,0.15)', fontSize: 10 }}>
          drag header · resize edges · dbl-click empty space to collapse all · Del to delete selected
        </span>
        <TemplateMenu />
      </div>

      {/* ── Infinite Canvas ── */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <InfiniteCanvas initialCenterW={520} initialCenterH={310}>
          <FreeCanvas />
          <BoardsCanvas />
        </InfiniteCanvas>
        {/* NLE header renders outside the canvas transform so it stays readable at any zoom */}
        <NLETimelineHeader />
      </div>

      {/* Viewers render outside the canvas so they are fixed to the viewport */}
      <AllViewers />
      <NLETimelineViewer />
    </div>
  )
}
