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
// inputs (followFaces), and on a tray scaled up (RailData.trayScale) are
// shown that much bigger, back to their own size once they leave it.
//
// Mounted once, in App (RailSyncHost) — like FxStripsHost, so the per-change
// work re-renders nothing.

import { useEffect } from 'react'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { onUndoRestore } from '../store/undoCoordinator'
import { RAIL_TRAY, isRail, railPlacements, setTrayAspect } from '../utils/rail'
import { useRailRunStore } from '../store/railRunStore'
import { railViewerDocks, touchRail } from '../utils/railViewer'
import { useViewport3DStore } from '../store/viewport3dStore'
import { layoutCardGrid } from '../utils/cardGrid'
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
  // Strips docked to a Viewer's left edge (utils/railViewer) grow and
  // shrink LEFTWARDS, so their right end stays on the Viewer.
  const onViewer = new Set([...railViewerDocks(nodes, useViewport3DStore.getState().windows, useCanvasStore.getState().zoom).values()].flat())
  let shifted = false
  for (const [id, r] of railPlacements(nodes)) {
    const n = nodes[id]
    if (!n) continue
    const isRailTile = n.type === 'rail'
    const dx = Math.abs(n.x - r.x), dy = Math.abs(n.y - r.y)
    const dw = Math.abs(n.width - r.width), dh = Math.abs(n.height - r.height)
    // The rail's own x/y is where the user put it — only its size follows.
    if (isRailTile ? (dw > EPS || dh > EPS) : (dx > EPS || dy > EPS || dw > EPS || dh > EPS)) {
      if (isRailTile && dw > EPS && onViewer.has(id)) {
        put(n, { x: n.x + n.width - r.width, width: r.width, height: r.height })
        shifted = true   // its cards are placed from the new x next pass
      } else {
        put(n, isRailTile ? { width: r.width, height: r.height } : { x: r.x, y: r.y, width: r.width, height: r.height })
      }
    }
  }
  if (patch) useFreeNodeStore.setState(s => ({ nodes: { ...s.nodes, ...patch } }))
  return syncCards(prev) || shifted
}

/** Cards on a results tray at their tray's scale; any other card that was
 *  scaled there back to its own frame size (ProjectGroup.railBase). True
 *  when any card changed size. */
function scaleTrayCards(): boolean {
  const nodes = useFreeNodeStore.getState().nodes
  const want = new Map<string, number>()
  for (const n of Object.values(nodes)) {
    const d = n.railDock
    if (!n.cardRef || !d || d.lifted || d.slotId !== RAIL_TRAY) continue
    const rail = nodes[d.railId]
    if (isRail(rail)) want.set(n.cardRef, rail.rail.trayScale ?? 1)
  }
  const changed: string[] = []
  const groups = useBoardsStore.getState().groups.map(g => {
    const k = want.get(g.id) ?? 1
    if (k === 1 && !g.railBase) return g
    const base = g.railBase ?? { w: g.cardWidthOverride, h: g.cardHeightOverride }
    if (base.w === undefined || base.h === undefined) return g
    if (k === 1) {
      changed.push(g.id)
      return { ...g, cardWidthOverride: base.w, cardHeightOverride: base.h, railBase: undefined }
    }
    const w = base.w * k, h = base.h * k
    if (g.railBase && Math.abs((g.cardWidthOverride ?? 0) - w) < 0.5 && Math.abs((g.cardHeightOverride ?? 0) - h) < 0.5) return g
    changed.push(g.id)
    return { ...g, cardWidthOverride: w, cardHeightOverride: h, railBase: base }
  })
  if (changed.length === 0) return false
  useBoardsStore.setState({ groups })
  // Its blocks laid out again in the frame it now has.
  for (const id of changed) layoutCardGrid(id)
  return true
}

/** Cards follow their stand-ins (see the top of the file). `prev` is the
 *  tiles before the change, when a tile change set this off. True when a
 *  card's size changed its column's layout: the caller lays out again. */
function syncCards(prev?: Record<string, FreeNodeData>): boolean {
  // Not before the cards' own store is loaded: there is nothing to follow.
  if (useBoardsStore.persist?.hasHydrated?.() === false) return false
  let resized = scaleTrayCards()
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
    const off = useFreeNodeStore.subscribe((s, prev) => {
      if (s.nodes === prev.nodes) return
      // An effect on a strip tweaked: that strip is the active one
      // (utils/railViewer — a Viewer shows it).
      for (const n of Object.values(s.nodes)) {
        const was = prev.nodes[n.id]
        if (n.railDock && n.effect && was && was.effect !== n.effect) touchRail(n.railDock.railId)
      }
      run(prev.nodes)
    })
    // A docked card moved or resized by anything else goes back to its
    // place; result cards step with their inputs.
    const offCards = useBoardsStore.subscribe((s, prev) => {
      if (s.groups === prev.groups && s.boards === prev.boards) return
      if (s.groups !== prev.groups) {
        followFaces(prev.groups, s.groups, s.boards)
        // A card on a strip stepped or selected: that strip is the active
        // one (utils/railViewer).
        const before = new Map(prev.groups.map(g => [g.id, g]))
        const hit = new Set(s.groups.filter(g => {
          const b = before.get(g.id)
          return b && (b.faceBoardId !== g.faceBoardId || b.deckFaceCard !== g.deckFaceCard)
        }).map(g => g.id))
        if (s.selectedGroupIds !== prev.selectedGroupIds) s.selectedGroupIds.forEach(id => hit.add(id))
        if (hit.size) {
          for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
            if (n.cardRef && n.railDock && hit.has(n.cardRef)) touchRail(n.railDock.railId)
          }
        }
      }
      run()
    })
    const offZoom = useCanvasStore.subscribe((s, prev) => { if (s.zoom !== prev.zoom) run() })
    // A results tray is as tall as its preview's picture: a new preview
    // with a new shape lays its rail out again.
    const offPreview = useRailRunStore.subscribe((s, prev) => {
      if (s.preview === prev.preview) return
      let changed = false
      for (const [railId, p] of Object.entries(s.preview)) {
        const c = p.canvas
        if (c && c.width > 0) changed = setTrayAspect(railId, c.height / c.width) || changed
      }
      if (changed) run()
    })
    const offUndo = onUndoRestore(land)
    return () => { off(); offCards(); offZoom(); offPreview(); offHydrate?.(); offUndo() }
  }, [])
}
