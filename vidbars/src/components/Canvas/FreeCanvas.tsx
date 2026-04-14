import React, { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { FreeNode } from './FreeNode'
import { useViewportBounds, intersectsViewport } from '../../hooks/useViewportBounds'

export const FreeCanvas: React.FC = React.memo(() => {
  // Only re-render when nodes are added/removed, not when node content changes
  const nodeIds = useFreeNodeStore(useShallow(s => Object.keys(s.nodes)))
  const vp = useViewportBounds()

  // Cull nodes outside viewport + margin buffer
  const visibleIds = useMemo(() => {
    const nodes = useFreeNodeStore.getState().nodes
    return nodeIds.filter(id => {
      const n = nodes[id]
      if (!n) return false
      return intersectsViewport(vp, n.x, n.y, n.width, n.height)
    })
  }, [nodeIds, vp])

  return (
    <>
      {visibleIds.map(id => <FreeNode key={id} id={id} />)}
    </>
  )
})
