import React from 'react'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { FreeNode } from './FreeNode'

export const FreeCanvas: React.FC = React.memo(() => {
  const nodes = useFreeNodeStore(s => s.nodes)
  return (
    <>
      {Object.keys(nodes).map(id => <FreeNode key={id} id={id} />)}
    </>
  )
})
