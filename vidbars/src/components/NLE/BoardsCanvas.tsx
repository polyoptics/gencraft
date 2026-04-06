// BoardsCanvas — renders all Board components.
// No zoom guard here — the LayerRouter decides which layer is active.
import React from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { Board } from './Board'

export const BoardsCanvas: React.FC = () => {
  const boardOrder = useBoardsStore(s => s.boardOrder)

  return (
    <>
      <Board boardId="primary" />
      {boardOrder.map(id => <Board key={id} boardId={id} />)}
    </>
  )
}
