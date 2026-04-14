// BoardsCanvas — renders all Board components.
// No zoom guard here — the LayerRouter decides which layer is active.
import React, { useMemo } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { Board } from './Board'
import { getHiddenBoardIds } from '../../hooks/useCardDecks'

export const BoardsCanvas: React.FC = () => {
  const boardOrder = useBoardsStore(s => s.boardOrder)
  const groups = useBoardsStore(s => s.groups)
  const zoneLineY = useCanvasStore(s => s.zoneLineY)
  // getHiddenBoardIds only reads groups (boards/_zoneLineY params unused)
  const hiddenBoards = useMemo(
    () => getHiddenBoardIds(groups, {} as any, zoneLineY),
    [groups, zoneLineY],
  )

  return (
    <>
      {!hiddenBoards.has('primary') && <Board boardId="primary" />}
      {boardOrder.filter(id => !hiddenBoards.has(id)).map(id => <Board key={id} boardId={id} />)}
    </>
  )
}
