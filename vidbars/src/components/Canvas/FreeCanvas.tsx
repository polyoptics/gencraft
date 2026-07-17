import React, { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { FreeNode } from './FreeNode'
import { MagnetDockPreview } from './MagnetDockPreview'
import { useViewportBounds, intersectsViewport } from '../../hooks/useViewportBounds'
import { computeTileClusters, type DockableItem, type WindowRect } from '../../utils/viewportDocking'
import { tileBrowseItem } from '../../utils/contentTraversal'

export const FreeCanvas: React.FC = React.memo(() => {
  // Only re-render when nodes are added/removed, not when node content changes
  const nodeIds = useFreeNodeStore(useShallow(s => Object.keys(s.nodes)))
  const nodes = useFreeNodeStore(s => s.nodes)
  const windows = useViewport3DStore(s => s.windows)
  const vp = useViewportBounds()

  // Cull nodes outside viewport + margin buffer
  const visibleIds = useMemo(() => {
    const all = useFreeNodeStore.getState().nodes
    return nodeIds.filter(id => {
      const n = all[id]
      if (!n) return false
      return intersectsViewport(vp, n.x, n.y, n.width, n.height)
    })
  }, [nodeIds, vp])

  // Deck-style tile connections: CONTENT-bearing tiles touching each
  // other join a cluster; a cluster touching a browser window is
  // CONNECTED to it — those tiles get the accent affordance and
  // click-to-load (FreeNode).
  const tileConnections = useMemo(() => {
    const tiles: DockableItem[] = Object.values(nodes)
      .filter(n => tileBrowseItem(n) !== null)
      .map(n => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height }))
    const winRects: WindowRect[] = Object.values(windows)
      .map(w => ({ id: w.id, x: w.x, y: w.y, width: w.width, height: w.height }))
    if (tiles.length === 0 || winRects.length === 0) return new Map<string, string>()
    return computeTileClusters(tiles, winRects).tileToWindow
  }, [nodes, windows])

  return (
    <>
      {visibleIds.map(id => (
        <FreeNode key={id} id={id} connectedWindowId={tileConnections.get(id) ?? null} />
      ))}
      <MagnetDockPreview />
    </>
  )
})
