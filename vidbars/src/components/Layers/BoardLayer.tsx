// BoardLayer — full board/node editing view (zoom ≥ 0.3)
// Wraps the existing BoardsCanvas + FreeCanvas + NLETimelineHeader.
// This is the richest layer with full bar trees, wires, free nodes, etc.

import React, { useMemo } from 'react'
import { BoardsCanvas } from '../NLE/BoardsCanvas'
import { FreeCanvas } from '../Canvas/FreeCanvas'
import { Viewport3DLayer } from '../Viewport3D/Viewport3DLayer'
import { NLETimelineHeader } from '../NLE/NLETimelineHeader'
import { CardOutline } from './CardOutline'
import { BlockOutline } from './BlockOutline'
import { PortalFrame } from './PortalFrame'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { getHiddenGroupIds } from '../../hooks/useCardDecks'

/** Canvas-space: boards + free nodes (inside transform container) */
/** Scoped (`only`) renders JUST the boards of one pinned card. The Viewer
 *  windows and free nodes are global furniture — mounting a second copy of
 *  them inside a pinned card would duplicate every viewer on the canvas. */
const Canvas: React.FC<{ only?: string[] }> = ({ only }) => (
  only
    ? <BoardsCanvas only={only} />
    : (
      <>
        <Viewport3DLayer />
        <FreeCanvas />
        <BoardsCanvas />
      </>
    )
)

/** Screen-space overlay: one NLE timeline header per group */
const Overlay: React.FC<{ only?: string[] }> = ({ only }) => {
  const allGroups = useBoardsStore(s => s.groups)
  const groups = useMemo(
    () => (only ? allGroups.filter(g => only.includes(g.id)) : allGroups.filter(g => !g.pin)),
    [allGroups, only],
  )
  const portalSelections = useCanvasStore(s => s.deckPortalSelections)
  const hiddenGroups = useMemo(
    () => getHiddenGroupIds(groups, !!only),
    [groups, only],
  )
  const visibleGroups = useMemo(
    () => groups.filter(g => !hiddenGroups.has(g.id)),
    [groups, hiddenGroups],
  )
  // Anchors with active portals: suppress their normal CardOutline,
  // BlockOutlines, and NLETimelineHeader — PortalFrame provides the
  // unified header + body for portal anchors instead. The displayed
  // member's own boards still render their natural block-level
  // headers (that's the proper board-level chrome for the bars
  // shown inside the portal slot).
  const portalAnchorIds = useMemo(
    () => new Set(Object.keys(portalSelections)),
    [portalSelections],
  )
  const visibleNonPortalGroups = useMemo(
    () => visibleGroups.filter(g => !portalAnchorIds.has(g.id)),
    [visibleGroups, portalAnchorIds],
  )
  const portalGlows = useMemo(() => {
    const out: Array<{ key: string; anchor: typeof groups[0]; member: typeof groups[0]; memberColor: string }> = []
    for (const [anchorId, memberId] of Object.entries(portalSelections)) {
      const anchor = groups.find(g => g.id === anchorId)
      const member = groups.find(g => g.id === memberId)
      if (!anchor || !member) continue
      out.push({ key: `portal-glow-${anchorId}`, anchor, member, memberColor: member.color })
    }
    return out
  }, [portalSelections, groups])
  return (
    <>
      {visibleNonPortalGroups.map(g => (
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
      {portalGlows.map(p => (
        <PortalFrame key={p.key} anchor={p.anchor} member={p.member} memberColor={p.memberColor} />
      ))}
    </>
  )
}

export const BoardLayer = { Canvas, Overlay }
