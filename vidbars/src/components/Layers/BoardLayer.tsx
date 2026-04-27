// BoardLayer — full board/node editing view (zoom ≥ 0.3)
// Wraps the existing BoardsCanvas + FreeCanvas + NLETimelineHeader.
// This is the richest layer with full bar trees, wires, free nodes, etc.

import React, { useMemo } from 'react'
import { BoardsCanvas } from '../NLE/BoardsCanvas'
import { FreeCanvas } from '../Canvas/FreeCanvas'
import { NLETimelineHeader } from '../NLE/NLETimelineHeader'
import { CardOutline } from './CardOutline'
import { BlockOutline } from './BlockOutline'
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
  const zoneLineY = useCanvasStore(s => s.zoneLineY)
  const hiddenGroups = useMemo(
    () => getHiddenGroupIds(groups, {} as any, zoneLineY),
    [groups, zoneLineY],
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
          {/* BlockOutlines: inner-partition outlines per board. CardOutline
              spans the full card (including the NLE header surrogate area
              above the bars), while BlockOutlines start where the bars
              actually render — so they don't coincide even for single-board
              cards. Render unconditionally. */}
          {g.boardIds.map(bid => (
            <BlockOutline key={`block-outline-${bid}`} group={g} boardId={bid} />
          ))}
          <NLETimelineHeader groupId={g.id} />
        </React.Fragment>
      ))}
    </>
  )
}

export const BoardLayer = { Canvas, Overlay }
