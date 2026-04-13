// BoardLayer — full board/node editing view (zoom ≥ 0.3)
// Wraps the existing BoardsCanvas + FreeCanvas + NLETimelineHeader.
// This is the richest layer with full bar trees, wires, free nodes, etc.

import React, { useMemo } from 'react'
import { BoardsCanvas } from '../NLE/BoardsCanvas'
import { FreeCanvas } from '../Canvas/FreeCanvas'
import { NLETimelineHeader } from '../NLE/NLETimelineHeader'
import { CardOutline } from './CardOutline'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { getHiddenGroupIds } from '../../hooks/useCardDecks'

/** Canvas-space: boards + free nodes (inside transform container) */
const Canvas: React.FC = () => (
  <>
    <FreeCanvas />
    <BoardsCanvas />
  </>
)

/** Screen-space overlay: one NLE timeline header per group */
const Overlay: React.FC = () => {
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const zoneLineY = useCanvasStore(s => s.zoneLineY)
  const hiddenGroups = useMemo(
    () => getHiddenGroupIds(groups, boards, zoneLineY),
    [groups, boards, zoneLineY],
  )
  const visibleGroups = useMemo(
    () => groups.filter(g => !hiddenGroups.has(g.id)),
    [groups, hiddenGroups],
  )
  return (
    <>
      {visibleGroups.map(g => (
        <React.Fragment key={g.id}>
          <CardOutline group={g} />
          <NLETimelineHeader groupId={g.id} />
        </React.Fragment>
      ))}
    </>
  )
}

export const BoardLayer = { Canvas, Overlay }
