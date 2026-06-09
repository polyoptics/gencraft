// BoardsCanvas — renders all Board components.
// No zoom guard here — the LayerRouter decides which layer is active.
import React, { useMemo } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { Board } from './Board'
import { getHiddenBoardIds } from '../../hooks/useCardDecks'
import { computeGroupBlockFootprint } from '../Layers/PortalFrame'

export const BoardsCanvas: React.FC = () => {
  const boardOrder = useBoardsStore(s => s.boardOrder)
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const portalSelections = useCanvasStore(s => s.deckPortalSelections)
  const hiddenBoards = useMemo(
    () => getHiddenBoardIds(groups),
    [groups],
  )

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
      {!effectiveHiddenBoards.has('primary') && <Board boardId="primary" />}
      {boardOrder.filter(id => !effectiveHiddenBoards.has(id)).map(id => <Board key={id} boardId={id} />)}
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
