import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { FreeNode } from './FreeNode'

export const FreeCanvas: React.FC = React.memo(() => {
  // Only re-render when nodes are added/removed, not when node content changes
  const nodeIds = useFreeNodeStore(useShallow(s => Object.keys(s.nodes)))
  return (
    <>
      {nodeIds.map(id => <FreeNode key={id} id={id} />)}
    </>
  )
})
