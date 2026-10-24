import { useEffect, useState } from 'react'
import { InfiniteCanvas } from './components/Canvas/InfiniteCanvas'
import { NLETimelineViewer } from './components/NLE/NLETimelineViewer'
import { LayerContent, LayerOverlay } from './components/Layers/LayerRouter'
import { Viewer } from './components/Viewer/Viewer'
import { TemplateMenu } from './components/UI/TemplateMenu'
import { ProjectBackupMenu } from './components/UI/ProjectBackupMenu'
import { useInlineMediaMigration } from './utils/migrateInlineMedia'
import { useVideoPosterBackfill } from './hooks/useVideoPosterBackfill'
import { DeckBrowserTray } from './components/DeckBrowser/DeckBrowserTray'
import { LinkDragOverlay } from './components/Linking/LinkDragOverlay'
import { DrawToolbar } from './components/Annotation/DrawToolbar'
import { ensureRolodexHome, useRolodexHomeBootstrap } from './utils/rolodexHome'
import { StoragePersistenceBanner } from './components/UI/StoragePersistenceBanner'
import { useBoardsStore } from './store/boardsStore'
import { useCanvasStore } from './store/canvasStore'
import { useFreeNodeStore } from './store/freeNodeStore'
import { useUndoCoordinator } from './store/undoCoordinator'
import { useViewport3DStore } from './store/viewport3dStore'
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
          const cs = useCanvasStore.getState()
          for (const src of freeNodeClipboard) {
            // Unproject the source's ON-SCREEN top-left, so a paste always
            // lands 40 screen px from what the user is looking at whatever
            // the source's placement — src.x/y are stale while pinned.
            const sx = src.pin ? src.pin.x : cs.pan.x + src.x * cs.zoom
            const sy = src.pin ? src.pin.y : cs.pan.y + src.y * cs.zoom
            const k = src.pin ? src.pin.scale / cs.zoom : 1
            const id = useFreeNodeStore.getState().addFreeNode(
              (sx + 40 - cs.pan.x) / cs.zoom, (sy + 40 - cs.pan.y) / cs.zoom, src.type)
            // The copy is always canvas-placed: `pin` is deliberately never
            // carried, or two pinned panels would stack on the same pixels.
            useFreeNodeStore.getState().updateFreeNode(id, {
              label: src.label,
              text: src.text,
              imageUrl: src.imageUrl,
              mediaType: src.mediaType,
              posterUrl: src.posterUrl,
              color: src.color,
              width: src.width * k,
              height: src.height * k,
              textStyle: src.textStyle ? { ...src.textStyle } : undefined,
              // These three were omitted, which is why a pasted list tile
              // was permanently dead (its editors bail with no listQuery)
              // and pasted annotations/crops were silently lost.
              listQuery: src.listQuery ? structuredClone(src.listQuery) : undefined,
              strokes: src.strokes ? structuredClone(src.strokes) : undefined,
              imageTransform: src.imageTransform ? { ...src.imageTransform } : undefined,
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

      // Ghost-slot sever delete: if a ghost slot is selected (extracted card's
      // slot in its former parent's fan), severing removes the parent's
      // ghostSlots entry — the card stays where it is on canvas, fully
      // independent. Higher priority than other deletes so the user's intent
      // is unambiguous when a ghost is selected.
      const selGhosts = useCanvasStore.getState().selectedGhostGroupIds
      if (selGhosts.length > 0) {
        const bs = useBoardsStore.getState()
        for (const cardId of selGhosts) bs.severDeckTether(cardId)
        useCanvasStore.getState().clearSelectedGhostGroupIds()
        return
      }

      // Free node delete
      const freeSelected = useFreeNodeStore.getState().selectedIds
      if (freeSelected.length > 0) {
        const homeId = useCanvasStore.getState().homeRolodexId
        ;[...freeSelected].forEach(id => useFreeNodeStore.getState().deleteFreeNode(id))
        useFreeNodeStore.getState().clearFreeSelection()
        if (homeId && freeSelected.includes(homeId)) {
          // The home Rolodex really deletes. The pointer goes null and the
          // next Cards press re-mints it from the seed prefs, which are
          // still persisted — so there is never an orphaned button. Undo
          // restores node and pointer together.
          useCanvasStore.getState().setHomeRolodexId(null)
          useCanvasStore.getState().setRolodexOpen(false)
        }
        return
      }

      // Viewer (content-browser window) delete — the same call the frame's
      // × already makes, minus the checkpoint (line above fired one). No
      // teardown here: the renderer's store subscription destroys the GL
      // view, docked content is DERIVED geometry and deliberately stays on
      // canvas, and undo restores the window whole with its camera and
      // text scales.
      //
      // AFTER free nodes: Ctrl+V sets a tile selection with no pointer
      // event at all, which is the one way both sets can be lit — and the
      // paste is the more recent intent. BEFORE blocks/groups/bars: those
      // are only ever selected by a pointer gesture, and every such
      // gesture clears this selection, so they cannot be lit while this
      // is. Going first among them means that if a clear is ever missed,
      // what dies is a WINDOW — undoable, destroying no content.
      const v3 = useViewport3DStore.getState()
      const liveViewers = v3.selectedIds.filter(wid => v3.windows[wid])
      if (liveViewers.length > 0) {
        for (const wid of liveViewers) v3.removeWindow(wid)
        v3.clearViewerSelection()
        return
      }
      // An id left dangling by undo (restoreSnapshot rewrites `windows`
      // but never `selectedIds`) renders nothing, so it must not silently
      // swallow the keypress for every kind below.
      if (v3.selectedIds.length > 0) v3.clearViewerSelection()

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

/** A Viewer stays selected only until the next press lands somewhere else.
 *
 *  A document-level CAPTURE listener rather than a handler on a container,
 *  because the surfaces that set a COMPETING selection live in sibling
 *  subtrees: cards, decks and ghost slots render in the overlay layer, a
 *  sibling of the canvas, and the Rolodex, deck tray, NLE viewer and
 *  toolbar are siblings again. One listener covers all of them plus every
 *  portaled menu, with no ancestry assumptions — and it matches the
 *  document-listener idiom of the hooks above.
 *
 *  Capture phase so no child's stopPropagation can swallow it, and it runs
 *  before React's dispatch, so a press INSIDE a Viewer early-returns and
 *  the frame's own capture handler then selects.
 *
 *  Deliberately NOT gated on e.button: a middle-drag pan or a right-click
 *  elsewhere should drop the selection too, so the ring never survives a
 *  gesture that moved attention off the window. */
function useDeselectViewerOnOutsidePress() {
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target
      if (t instanceof Element && t.closest('[data-viewport3d]')) return
      useViewport3DStore.getState().clearViewerSelection()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
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

/** Esc exits annotation / draw mode (whatever surface is active). */
function useEscapeDrawMode() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!useCanvasStore.getState().drawSurface) return
      e.preventDefault()
      useCanvasStore.getState().setDrawSurface(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
}

/** Esc clears any deck-portal preview (click on a fanned member locks
 *  that member's content onto the anchor's face; this hook releases
 *  the lock so the anchor goes back to showing its own content). */
function useEscapeDeckPortals() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const cs = useCanvasStore.getState()
      if (Object.keys(cs.deckPortalSelections).length === 0) return
      e.preventDefault()
      cs.clearAllDeckPortals()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
}

// Garbage-collect dead deck portals: if a portal's anchor or member is
// deleted, drop the entry so we don't silently render against a stale
// id. Runs on every groups change — cheap because the inner loop only
// fires when there's at least one active portal.
function useDeadDeckPortalCleanup() {
  const groups = useBoardsStore(s => s.groups)
  useEffect(() => {
    const cs = useCanvasStore.getState()
    const portals = cs.deckPortalSelections
    const entries = Object.entries(portals)
    if (entries.length === 0) return
    const aliveIds = new Set(groups.map(g => g.id))
    const next: Record<string, string> = {}
    let changed = false
    for (const [anchorId, memberId] of entries) {
      if (aliveIds.has(anchorId) && aliveIds.has(memberId)) {
        next[anchorId] = memberId
      } else {
        changed = true
      }
    }
    if (changed) useCanvasStore.setState({ deckPortalSelections: next })
  }, [groups])
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

/** Three states, so the button is never dead and never lies:
 *   pinned + visible  → lit; click hides it
 *   pinned + hidden   → dim; click shows it
 *   on the canvas     → dashed + 📍; click pins it back
 *  It never moves the camera — the button's promise is "the card index,
 *  here, now". Re-pinning a panel that is still on screen is seamless
 *  (nothing moves, only the lighting changes); re-pinning one that has
 *  been panned away is an explicit recall to the default anchor at
 *  scale 1, because pinning it at card zoom would produce a sliver. */
function RolodexToggleButton() {
  const open = useCanvasStore(s => s.rolodexOpen)
  const homeId = useCanvasStore(s => s.homeRolodexId)
  const home = useFreeNodeStore(s => (homeId ? s.nodes[homeId] : undefined))
  const onCanvas = !!home && !home.pin
  const lit = open && !!home?.pin

  const onClick = () => {
    const cs = useCanvasStore.getState()
    const id = ensureRolodexHome()
    if (!id) return                     // pre-hydration; the bootstrap will run
    const n = useFreeNodeStore.getState().nodes[id]!
    if (n.pin) { cs.setRolodexOpen(!open); return }
    useUndoCoordinator.getState().checkpoint()
    const sx = cs.pan.x + n.x * cs.zoom, sy = cs.pan.y + n.y * cs.zoom
    const onScreen = sx < window.innerWidth && sy < window.innerHeight
                  && sx + n.width * cs.zoom > 0 && sy + n.height * cs.zoom > 0
    if (onScreen) {
      useFreeNodeStore.getState().setNodePlacement([id], 'screen', { pan: cs.pan, zoom: cs.zoom })
    } else {
      useFreeNodeStore.getState().updateFreeNode(id, { pin: { x: 12, y: 22, scale: 1 } })
    }
    cs.setRolodexOpen(true)
  }

  return (
    <button
      onClick={onClick}
      title={onCanvas
        ? 'Cards is on the canvas — click to pin it back to the screen'
        : lit ? 'Hide the Cards panel'
        : 'Cards — browse all cards in your project'}
      style={{
        height: 24,
        padding: '0 8px',
        display: 'flex', alignItems: 'center', gap: 5,
        background: lit ? 'rgba(120,170,255,0.22)' : 'rgba(255,255,255,0.05)',
        border: onCanvas
          ? '1px dashed rgba(120,170,255,0.7)'
          : lit ? '1px solid rgba(120,170,255,0.5)' : '1px solid rgba(255,255,255,0.1)',
        borderRadius: 6,
        color: lit || onCanvas ? '#a8c8ff' : 'rgba(255,255,255,0.6)',
        fontSize: 11, fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <span style={{ fontSize: 13 }}>{onCanvas ? '📍' : '🗂'}</span>
      Cards
    </button>
  )
}

export default function App() {
  useKeyboardDelete()
  useRolodexHomeBootstrap()
  useDeselectViewerOnOutsidePress()
  useKeyboardCopyPaste()
  useKeyboardUndo()
  useEscapeDrawMode()
  useEscapeDeckPortals()
  useDeadDeckPortalCleanup()
  // Move base64-inline images out of state into the local blob store
  // (one-time, versioned). Replaces the old server-based base64 migration.
  useInlineMediaMigration()
  // Poster frames for videos on bars — the only way a bar's video is seen.
  useVideoPosterBackfill()

  const [deckBrowserOpen, setDeckBrowserOpen] = useState(false)

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', background: '#0d0e1a' }}>

      {/* Sticky banner — only visible when localStorage persistence is
            failing (or about to fail). Diagnoses the "my recent edits
            disappear after a reload" class of bug. */}
      <StoragePersistenceBanner />

      {/* ── Toolbar ── */}
      <div style={{
        height: 38, flexShrink: 0,
        background: '#080910',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        display: 'flex', alignItems: 'center',
        padding: '0 16px', gap: 10, zIndex: 600,
      }}>
        <span style={{ color: '#fff', fontSize: 14, fontWeight: 800, letterSpacing: '-0.5px' }}>genCraft</span>
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
        <RolodexToggleButton />
        <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)' }} />
        <span style={{ color: 'rgba(255,255,255,0.22)', fontSize: 11 }}>a canvas for creative work</span>
        <div style={{ flex: 1 }} />
        <UndoRedoButtons />
        <span style={{ color: 'rgba(255,255,255,0.15)', fontSize: 10 }}>
          drag header · resize edges · dbl-click empty space to collapse all · Del to delete selected
        </span>
        <DynamicRowToggle />
        <ProjectBackupMenu />
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

      {/* Annotation / draw-mode floating toolbar (only visible while in draw mode) */}
      <DrawToolbar />

      {/* The Rolodex is no longer mounted here: the home instance is an
          ordinary pinned `list` node, rendered by PinLayer → FreeNode →
          <CardRolodex embedded>. See utils/rolodexHome.ts. */}

      {/* Viewers render outside the canvas so they are fixed to the viewport */}
      <AllViewers />
      <NLETimelineViewer />
    </div>
  )
}
