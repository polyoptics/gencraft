import React, { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { FreeNode } from './FreeNode'
import { MagnetDockPreview } from './MagnetDockPreview'
import { useViewportBounds, intersectsViewport } from '../../hooks/useViewportBounds'
import { computeTileClusters, type DockableItem, type WindowRect } from '../../utils/viewportDocking'
import { isDockableTile } from '../../utils/contentTraversal'
import { tileDeckIndex } from '../../utils/tileDecks'

export const FreeCanvas: React.FC = React.memo(() => {
  // Only re-render when nodes are added/removed, not when node content changes
  const nodeIds = useFreeNodeStore(useShallow(s => Object.keys(s.nodes)))
  const nodes = useFreeNodeStore(s => s.nodes)
  const windows = useViewport3DStore(s => s.windows)
  const vp = useViewportBounds()
  // Collapsed tile decks, in one pass: the tiles hidden behind a face are
  // not drawn and are not geometry — the deck is its face's rect.
  const deckIdx = useMemo(() => tileDeckIndex(nodes), [nodes])

  // Cull nodes outside viewport + margin buffer
  // This is a PARTITION, not just a cull: without the `n.pin` test a
  // pinned node would render in BOTH hosts, and the world copy would
  // scale with zoom. `nodes` must be a dep — a placement flip changes
  // neither nodeIds nor vp, so on unpin the node would otherwise not
  // reappear here until the next pan.
  const visibleIds = useMemo(() => {
    return nodeIds.filter(id => {
      const n = nodes[id]
      if (!n || n.pin) return false     // pinned ⇒ PinLayer renders it
      if (deckIdx.hidden.has(id)) return false   // behind a deck face
      return intersectsViewport(vp, n.x, n.y, n.width, n.height)
    })
  }, [nodeIds, nodes, vp, deckIdx])

  // Deck-style tile connections: CONTENT-bearing tiles touching each
  // other join a cluster; a cluster touching a browser window is
  // CONNECTED to it — those tiles get the accent affordance and
  // click-to-load (FreeNode).
  const tileConnections = useMemo(() => {
    const tiles: DockableItem[] = Object.values(nodes)
      // A pinned tile is not canvas geometry — its x/y are stale, so it
      // would join clusters at wherever it used to be. Nor is a tile hidden
      // in a deck: the face's own rect stands for the whole deck.
      .filter(n => !n.pin && !deckIdx.hidden.has(n.id) && isDockableTile(n))
      .map(n => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height }))
    const winRects: WindowRect[] = Object.values(windows)
      .map(w => ({ id: w.id, x: w.x, y: w.y, width: w.width, height: w.height }))
    if (tiles.length === 0 || winRects.length === 0) return new Map<string, string>()
    return computeTileClusters(tiles, winRects).tileToWindow
  }, [nodes, windows, deckIdx])

  return (
    <>
      {visibleIds.map(id => (
        <FreeNode key={id} id={id} connectedWindowId={tileConnections.get(id) ?? null} />
      ))}
      <MagnetDockPreview />
    </>
  )
})
