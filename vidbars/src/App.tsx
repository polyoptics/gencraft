import { useEffect, useRef, useState } from 'react'
import { InfiniteCanvas } from './components/Canvas/InfiniteCanvas'
import { NLETimelineViewer } from './components/NLE/NLETimelineViewer'
import { LayerContent, LayerOverlay } from './components/Layers/LayerRouter'
import { Viewer } from './components/Viewer/Viewer'
import { TemplateMenu } from './components/UI/TemplateMenu'
import { DeckBrowserTray } from './components/DeckBrowser/DeckBrowserTray'
import { LinkDragOverlay } from './components/Linking/LinkDragOverlay'
import { useBoardsStore } from './store/boardsStore'
import { useCanvasStore } from './store/canvasStore'
import { useFreeNodeStore } from './store/freeNodeStore'
import { useUndoCoordinator } from './store/undoCoordinator'
import type { Bar } from './types/bar'
import type { FreeNodeData } from './store/freeNodeStore'
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
let clipboardGroupId: string | null = null
let freeNodeClipboard: FreeNodeData[] = []

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
        // Free node copy: if any free nodes are selected, copy them
        const freeSelected = useFreeNodeStore.getState().selectedIds
        const freeNodes = useFreeNodeStore.getState().nodes
        if (freeSelected.length > 0) {
          freeNodeClipboard = freeSelected
            .map(id => freeNodes[id])
            .filter(Boolean)
            .map(n => structuredClone(n))
          clipboard = null
          clipboardGroupId = null
          return
        }

        freeNodeClipboard = []
        const zoom = useCanvasStore.getState().zoom
        // Card-level copy: copy selected group
        if (zoom <= 0.18) {
          const selectedGroupIds = useBoardsStore.getState().selectedGroupIds
          if (selectedGroupIds.length > 0) {
            clipboardGroupId = selectedGroupIds[0]
            clipboard = null
          }
          return
        }
        clipboardGroupId = null
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
        useUndoCoordinator.getState().checkpoint()
        // Free node paste
        if (freeNodeClipboard.length > 0) {
          const newIds: string[] = []
          for (const src of freeNodeClipboard) {
            const id = useFreeNodeStore.getState().addFreeNode(src.x + 40, src.y + 40, src.type)
            useFreeNodeStore.getState().updateFreeNode(id, {
              label: src.label,
              text: src.text,
              imageUrl: src.imageUrl,
              mediaType: src.mediaType,
              color: src.color,
              width: src.width,
              height: src.height,
              textStyle: src.textStyle ? { ...src.textStyle } : undefined,
            })
            newIds.push(id)
          }
          useFreeNodeStore.getState().setFreeSelection(newIds)
          return
        }
        // Card-level paste: duplicate group
        if (clipboardGroupId) {
          useBoardsStore.getState().duplicateGroup(clipboardGroupId)
          return
        }
        if (!clipboard) return
        if (clipboard.isWholeBoard) {
          useBoardsStore.getState().duplicateBoard(clipboard.boardId)
        } else {
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

      // Free node delete
      const freeSelected = useFreeNodeStore.getState().selectedIds
      if (freeSelected.length > 0) {
        ;[...freeSelected].forEach(id => useFreeNodeStore.getState().deleteFreeNode(id))
        useFreeNodeStore.getState().clearFreeSelection()
        return
      }

      // Block-layer multi-select delete (whole boards)
      const selBlocks = useCanvasStore.getState().selectedBlockBoardIds
      if (selBlocks.length > 0) {
        const bs = useBoardsStore.getState()
        for (const bid of selBlocks) {
          if (bid === 'primary') continue
          if (bs.boards[bid]) bs.deleteBoard(bid)
        }
        useCanvasStore.getState().clearSelectedBlockBoardIds()
        return
      }

      // Group/card delete
      const selGroups = useBoardsStore.getState().selectedGroupIds
      if (selGroups.length > 0) {
        for (const gid of selGroups) {
          const bs = useBoardsStore.getState()
          if (bs.groups.length <= 1) break  // keep at least one group
          const g = bs.groups.find(gr => gr.id === gid)
          if (!g) continue
          g.boardIds.forEach(bid => { if (bid !== 'primary') bs.deleteBoard(bid) })
          bs.deleteGroup(gid)
        }
        useBoardsStore.getState().setSelectedGroup(null)
        return
      }

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

function DynamicRowToggle() {
  const active = useCanvasStore(s => s.dynamicRowHeights)
  const toggle = useCanvasStore(s => s.toggleDynamicRowHeights)
  return (
    <button
      onClick={toggle}
      title={active ? 'Dynamic row heights (click for fixed)' : 'Fixed row heights (click for dynamic)'}
      style={{
        background: active ? 'rgba(37,99,235,0.22)' : 'rgba(255,255,255,0.06)',
        border: active ? '1px solid rgba(37,99,235,0.45)' : '1px solid rgba(255,255,255,0.08)',
        color: active ? 'rgba(130,180,255,0.9)' : 'rgba(255,255,255,0.35)',
        fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
        padding: '3px 10px', borderRadius: 6, cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >{active ? 'Rows: Dynamic' : 'Rows: Fixed'}</button>
  )
}

function useBase64Migration() {
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    import('./utils/migrateBase64').then(m => m.migrateBase64ToServer())
  }, [])
}

export default function App() {
  useKeyboardDelete()
  useKeyboardCopyPaste()
  useKeyboardUndo()
  useBase64Migration()

  const [deckBrowserOpen, setDeckBrowserOpen] = useState(false)

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
        <span style={{ color: '#fff', fontSize: 14, fontWeight: 800, letterSpacing: '-0.5px' }}>Armarium</span>
        <button
          onClick={() => setDeckBrowserOpen(o => !o)}
          title="Deck Browser — drag decks onto cards to link"
          style={{
            height: 24,
            padding: '0 8px',
            display: 'flex', alignItems: 'center', gap: 5,
            background: deckBrowserOpen ? 'rgba(217,122,98,0.22)' : 'rgba(255,255,255,0.05)',
            border: deckBrowserOpen
              ? '1px solid rgba(217,122,98,0.5)'
              : '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6,
            color: deckBrowserOpen ? '#ffb19e' : 'rgba(255,255,255,0.6)',
            fontSize: 11, fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <span style={{ fontSize: 13 }}>📚</span>
          Decks
        </button>
        <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)' }} />
        <span style={{ color: 'rgba(255,255,255,0.22)', fontSize: 11 }}>a canvas for creative work</span>
        <div style={{ flex: 1 }} />
        <UndoRedoButtons />
        <span style={{ color: 'rgba(255,255,255,0.15)', fontSize: 10 }}>
          drag header · resize edges · dbl-click empty space to collapse all · Del to delete selected
        </span>
        <DynamicRowToggle />
        <TemplateMenu />
      </div>

      {/* ── Infinite Canvas ── */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <InfiniteCanvas initialCenterW={520} initialCenterH={310}>
          <LayerContent />
        </InfiniteCanvas>
        {/* Layer overlay renders outside the canvas transform (screen-space headers/cards) */}
        <LayerOverlay />
      </div>

      {/* Deck browser tray + link-drag overlay */}
      <DeckBrowserTray open={deckBrowserOpen} onClose={() => setDeckBrowserOpen(false)} />
      <LinkDragOverlay />

      {/* Viewers render outside the canvas so they are fixed to the viewport */}
      <AllViewers />
      <NLETimelineViewer />
    </div>
  )
}
