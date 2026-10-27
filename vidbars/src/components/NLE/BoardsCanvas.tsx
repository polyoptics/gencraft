// BoardsCanvas — renders all Board components.
// No zoom guard here — the LayerRouter decides which layer is active.
import React, { useMemo } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { Board } from './Board'
import { getHiddenBoardIds } from '../../hooks/useCardDecks'
import { computeGroupBlockFootprint } from '../Layers/PortalFrame'

export const BoardsCanvas: React.FC<{ only?: string[] }> = ({ only }) => {
  const boardOrder = useBoardsStore(s => s.boardOrder)
  const allGroups = useBoardsStore(s => s.groups)
  // Scoped to one pinned card's groups, or the canvas minus pinned ones —
  // PinLayer draws those with a frozen camera and they must not appear twice.
  const groups = useMemo(
    () => (only ? allGroups.filter(g => only.includes(g.id)) : allGroups.filter(g => !g.pin)),
    [allGroups, only],
  )
  const boards = useBoardsStore(s => s.boards)
  /** Boards this render may draw, or null for the whole canvas. */
  const scopedBoards = useMemo(
    () => (only ? new Set(groups.flatMap(g => g.boardIds)) : null),
    [only, groups],
  )
  /** Boards that have left the canvas for a pin — see BlockLayer. Boards
   *  render per board id, so dropping pinned GROUPS from the list never
   *  stopped their bars showing through underneath the pinned card. */
  const pinnedAwayBoards = useMemo(
    () => (only ? null : new Set(allGroups.filter(g => g.pin).flatMap(g => g.boardIds))),
    [only, allGroups],
  )
  const portalSelections = useCanvasStore(s => s.deckPortalSelections)
  const hiddenBoards = useMemo(
    () => getHiddenBoardIds(groups, !!only),
    [groups, only],
  )
  // 'primary' is deleted with its card. Board returns early when its board
  // is missing, which a mounted Board must never start doing mid-life.
  const hasPrimary = useBoardsStore(s => !!s.boards.primary)

  // Deck portals at board zoom: replace the anchor's boards with the
  // locked member's boards, rendered at the anchor's canvas position.
  // Same alignment math as Phase 2 (block zoom): translate by the
  // delta between anchor's footprint top-left and member's footprint
  // top-left, not raw origin difference, so content tucks flush into
  // the anchor's slot. The member group itself is already hidden as a
  // non-anchor deck member, so no duplicate at the member's location.
  const { effectiveHiddenBoards, portalRenderings } = useMemo(() => {
    const eff = new Set(hiddenBoards)
    const portals: Array<{ key: string; anchorId: string; memberId: string; dx: number; dy: number; boardIds: string[] }> = []
    for (const [anchorId, memberId] of Object.entries(portalSelections)) {
      const anchor = groups.find(g => g.id === anchorId)
      const member = groups.find(g => g.id === memberId)
      if (!anchor || !member) continue
      const anchorFp = computeGroupBlockFootprint(anchor, boards)
      const memberFp = computeGroupBlockFootprint(member, boards)
      if (!anchorFp || !memberFp) continue
      for (const bid of anchor.boardIds) eff.add(bid)
      portals.push({
        key: `portal-${anchorId}-${memberId}`,
        anchorId, memberId,
        dx: anchorFp.left - memberFp.left,
        dy: anchorFp.top - memberFp.top,
        boardIds: [...member.boardIds],
      })
    }
    return { effectiveHiddenBoards: eff, portalRenderings: portals }
  }, [hiddenBoards, portalSelections, groups, boards])

  return (
    <>
      {/* 'primary' is a real board and usually the one a card owns. */}
      {hasPrimary && (!scopedBoards || scopedBoards.has('primary')) && !effectiveHiddenBoards.has('primary')
        && !pinnedAwayBoards?.has('primary') && (
        <Board boardId="primary" />
      )}
      {/* Same trap as the block layer: boards render from boardOrder, which
          is every board in the project, so filtering `groups` alone left a
          pinned card at board level drawing the whole canvas inside itself. */}
      {boardOrder
        .filter(id => !effectiveHiddenBoards.has(id))
        .filter(id => !scopedBoards || scopedBoards.has(id))
        .filter(id => !pinnedAwayBoards?.has(id))
        .map(id => <Board key={id} boardId={id} />)}
      {/* Portal renderings: each wraps the locked member's boards in
          a translate so they land at the anchor's canvas position.
          pointerEvents:'none' enforces view-only (no bar editing, no
          drag, no resize handles) while the portal is active. */}
      {portalRenderings.map(p => (
        <div
          key={p.key}
          data-portal-render={`${p.anchorId}:${p.memberId}`}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transform: `translate(${p.dx}px, ${p.dy}px)`,
            pointerEvents: 'none',
          }}
        >
          {p.boardIds.map(bid => <Board key={bid} boardId={bid} />)}
        </div>
      ))}
    </>
  )
}
