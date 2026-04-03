import React from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { Board } from './Board'

const COLLAPSE_ZOOM = 0.15

export const BoardsCanvas: React.FC = () => {
  const boardOrder = useBoardsStore(s => s.boardOrder)
  const zoom = useCanvasStore(s => s.zoom)

  // At very low zoom, the NLE timeline header renders a single collapsed card
  // so we hide individual boards to avoid clutter
  if (zoom <= COLLAPSE_ZOOM) return null

  return (
    <>
      <Board boardId="primary" />
      {boardOrder.map(id => <Board key={id} boardId={id} />)}
    </>
  )
}
