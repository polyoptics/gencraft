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
// size they had before docking comes back. A tile holding a CARD
// (utils/railCards) off any strip becomes that card again — deleting a strip
// sets its cards down this way.
//
// Mounted once, in App (RailSyncHost) — like FxStripsHost, so the per-change
// work re-renders nothing.

import { useEffect } from 'react'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { onUndoRestore } from '../store/undoCoordinator'
import { isRail, railPlacements } from '../utils/rail'
import { releaseStashedCard } from '../utils/railCards'
import { useBoardsStore } from '../store/boardsStore'

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

function syncRails(prev?: Record<string, FreeNodeData>): void {
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
  // Held cards that just came off their strip (it was deleted): cards
  // again, where the tile lies. Only those that WERE docked — a tile being
  // made for a card is not docked yet. Not before the cards' own store is
  // loaded, which would then overwrite them.
  if (!prev || useBoardsStore.persist?.hasHydrated?.() === false) return
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    if (n.stashedCard && !n.railDock && prev[n.id]?.railDock) releaseStashedCard(n.id)
  }
}

export function useRailSync(): void {
  useEffect(() => {
    let busy = false
    const run = (prev?: Record<string, FreeNodeData>) => {
      if (busy) return            // our own write re-enters; it settles in one pass
      busy = true
      try { syncRails(prev) } finally { busy = false }
    }
    // Persisted nodes may still be hydrating; land stray lifts once they are in.
    const land = () => { landStrayLifts(); run() }
    if (useFreeNodeStore.persist?.hasHydrated?.()) land()
    const offHydrate = useFreeNodeStore.persist?.onFinishHydration?.(land)
    const off = useFreeNodeStore.subscribe((s, prev) => { if (s.nodes !== prev.nodes) run(prev.nodes) })
    const offUndo = onUndoRestore(land)
    return () => { off(); offHydrate?.(); offUndo() }
  }, [])
}
