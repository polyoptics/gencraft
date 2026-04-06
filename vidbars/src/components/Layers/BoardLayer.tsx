// BoardLayer — full board/node editing view (zoom ≥ 0.3)
// Wraps the existing BoardsCanvas + FreeCanvas + NLETimelineHeader.
// This is the richest layer with full bar trees, wires, free nodes, etc.

import React from 'react'
import { BoardsCanvas } from '../NLE/BoardsCanvas'
import { FreeCanvas } from '../Canvas/FreeCanvas'
import { NLETimelineHeader } from '../NLE/NLETimelineHeader'
import { useBoardsStore } from '../../store/boardsStore'

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
  return (
    <>
      {groups.map(g => (
        <NLETimelineHeader key={g.id} groupId={g.id} />
      ))}
    </>
  )
}

export const BoardLayer = { Canvas, Overlay }
