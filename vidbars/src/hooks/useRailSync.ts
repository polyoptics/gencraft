// useRailSync — keeps every loop strip laid out.
//
// A docked tile stays an ordinary canvas tile (its own body, sliders, grip,
// menu); the rail only decides WHERE it sits and how big it is. This host
// writes those boxes whenever the free-node store changes: each docked tile
// to its cascade slot (utils/rail railLayout), each rail tile to the box its
// layout needs. Derived placement, so no undo checkpoint — the action that
// changed the layout (dock, undock, move the rail) took one already.
//
// Also releases tiles whose rail is gone (deleted outside deleteFreeNode,
// e.g. an undo that predates the rail): their railDock is cleared and the
// size they had before docking comes back.
//
// Cards on a strip (utils/railCards) follow their stand-in tiles: each
// docked card — a deck by its front card — is moved to its stand-in's place,
// and its own drawn size is what the column lays out. A stand-in set down
// off its strip (the strip deleted, the tray taken off) puts its card there
// and goes; one whose card is gone goes too. Result cards step with their
// inputs (followFaces).
//
// Mounted once, in App (RailSyncHost) — like FxStripsHost, so the per-change
// work re-renders nothing.

import { useEffect } from 'react'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { onUndoRestore } from '../store/undoCoordinator'
import { isRail, railPlacements } from '../utils/rail'
import { followFaces, placeCard } from '../utils/railCards'
import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { drawnRect } from '../utils/effectCards'

const EPS = 0.25   // canvas units: below this a box counts as unchanged

/** A lifted card belongs to a drag in flight. One still lifted when the app
 *  starts was dropped mid-gesture (a reload, a crash): put it back. So is one
 *  an undo or redo brings back — a checkpoint taken mid-drag (a Delete, a
 *  paste, a run's first result) recorded it lifted. Landing the card being
 *  dragged right now is safe too: its release docks it where it is aimed,
 *  or leaves it in its column. */
function landStrayLifts(): void {
  const { nodes } = useFreeNodeStore.getState()
  const stray = Object.values(nodes).filter(n => n.railDock?.lifted)
  if (stray.length === 0) return
  useFreeNodeStore.setState(s => {
    const next = { ...s.nodes }
    for (const n of stray) next[n.id] = { ...n, railDock: { ...n.railDock!, lifted: undefined } }
    return { nodes: next }
  })
}

function syncRails(prev?: Record<string, FreeNodeData>): boolean {
  const { nodes } = useFreeNodeStore.getState()
  let patch: Record<string, FreeNodeData> | null = null
  const put = (n: FreeNodeData, p: Partial<FreeNodeData>) => {
    if (!patch) patch = {}
    patch[n.id] = { ...(patch[n.id] ?? n), ...p }
  }
  // Released: docked on a rail that no longer exists.
  for (const n of Object.values(nodes)) {
    const d = n.railDock
    if (d && !isRail(nodes[d.railId])) {
      put(n, { railDock: undefined, width: d.prevW ?? n.width, height: d.prevH ?? n.height })
    }
  }
  for (const [id, r] of railPlacements(nodes)) {
    const n = nodes[id]
    if (!n) continue
    const isRailTile = n.type === 'rail'
    const dx = Math.abs(n.x - r.x), dy = Math.abs(n.y - r.y)
    const dw = Math.abs(n.width - r.width), dh = Math.abs(n.height - r.height)
    // The rail's own x/y is where the user put it — only its size follows.
    if (isRailTile ? (dw > EPS || dh > EPS) : (dx > EPS || dy > EPS || dw > EPS || dh > EPS)) {
      put(n, isRailTile ? { width: r.width, height: r.height } : { x: r.x, y: r.y, width: r.width, height: r.height })
    }
  }
  if (patch) useFreeNodeStore.setState(s => ({ nodes: { ...s.nodes, ...patch } }))
  return syncCards(prev)
}

/** Cards follow their stand-ins (see the top of the file). `prev` is the
 *  tiles before the change, when a tile change set this off. True when a
 *  card's size changed its column's layout: the caller lays out again. */
function syncCards(prev?: Record<string, FreeNodeData>): boolean {
  // Not before the cards' own store is loaded: there is nothing to follow.
  if (useBoardsStore.persist?.hasHydrated?.() === false) return false
  let resized = false
  const fs = useFreeNodeStore.getState()
  const zoom = useCanvasStore.getState().zoom
  for (const n of Object.values(fs.nodes)) {
    if (!n.cardRef) continue
    const bs = useBoardsStore.getState()
    const g = bs.groups.find(gr => gr.id === n.cardRef)
    if (!g) { useFreeNodeStore.getState().deleteFreeNode(n.id); continue }
    const d = n.railDock
    if (!d) {
      // Set down off its strip: the card goes there; the stand-in is done.
      // (One not docked YET is being made: dockCards docks it next.)
      if (prev?.[n.id]?.railDock) {
        placeCard(g.id, n.x, n.y)
        useFreeNodeStore.getState().deleteFreeNode(n.id)
      }
      continue
    }
    if (d.lifted || !isRail(fs.nodes[d.railId])) continue
    // The column lays the card out at its own drawn size.
    const r = drawnRect(g, bs.boards, zoom)
    if (r && (Math.abs((d.prevW ?? 0) - r.width) > EPS || Math.abs((d.prevH ?? 0) - r.height) > EPS)) {
      useFreeNodeStore.getState().updateFreeNode(n.id, { railDock: { ...d, prevW: r.width, prevH: r.height } })
      resized = true
      continue   // re-laid out; the next pass places the card
    }
    placeCard(g.id, n.x, n.y)
  }
  return resized
}

export function useRailSync(): void {
  useEffect(() => {
    let busy = false
    const run = (prev?: Record<string, FreeNodeData>) => {
      if (busy) return            // our own write re-enters; it settles in one pass
      busy = true
      // A card that changed size re-lays its column: a pass or two more.
      try { let again = syncRails(prev); for (let k = 0; again && k < 3; k++) again = syncRails() } finally { busy = false }
    }
    // Persisted nodes may still be hydrating; land stray lifts once they are in.
    const land = () => { landStrayLifts(); run() }
    if (useFreeNodeStore.persist?.hasHydrated?.()) land()
    const offHydrate = useFreeNodeStore.persist?.onFinishHydration?.(land)
    const off = useFreeNodeStore.subscribe((s, prev) => { if (s.nodes !== prev.nodes) run(prev.nodes) })
    // A docked card moved or resized by anything else goes back to its
    // place; result cards step with their inputs.
    const offCards = useBoardsStore.subscribe((s, prev) => {
      if (s.groups === prev.groups && s.boards === prev.boards) return
      if (s.groups !== prev.groups) followFaces(prev.groups, s.groups, s.boards)
      run()
    })
    const offZoom = useCanvasStore.subscribe((s, prev) => { if (s.zoom !== prev.zoom) run() })
    const offUndo = onUndoRestore(land)
    return () => { off(); offCards(); offZoom(); offHydrate?.(); offUndo() }
  }, [])
}
