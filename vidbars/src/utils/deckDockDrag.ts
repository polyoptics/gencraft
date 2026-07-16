// deckDockDrag.ts — shared magnet-docking glue for GROUP/CARD/DECK drags,
// used by every gesture that moves a whole group: card + stacked-deck
// drags (CardLayer, card zoom), the NLE timeline-header drag (board
// zoom), and block drags/releases (block zoom). Dock membership stays
// derived from geometry; these helpers only provide the drag-time
// affordance and the flush snap + load on release.
//
// ALL geometry here is the CARD-LEVEL visual rect (cardVisualRect — the
// same authority deck clustering uses), never the bar-footprint slot:
// cards magnet and snap by what you see, exactly like deck formation.
// Helpers read LIVE store state (call them AFTER the drag's setState).

import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useViewport3DStore } from '../store/viewport3dStore'
import { useMagnetPreviewStore } from '../store/magnetPreviewStore'
import { findMagnetCandidate, magnetRadiusForZoom, type WindowRect } from './viewportDocking'
import { collectDeckModels } from './modelTraversal'
import { cardVisualRect } from '../hooks/useCardDecks'

export function viewportWindowRects(): WindowRect[] {
  return Object.values(useViewport3DStore.getState().windows)
    .map(w => ({ id: w.id, x: w.x, y: w.y, width: w.width, height: w.height }))
}

/** The group's live visual card rect as an x/y/w/h rect, or null. */
function liveCardRect(groupId: string): { x: number; y: number; width: number; height: number } | null {
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.id === groupId)
  if (!g) return null
  const v = cardVisualRect(g, bs.boards, useCanvasStore.getState().zoom)
  if (!v) return null
  return { x: v.rect.left, y: v.rect.top, width: v.rect.right - v.rect.left, height: v.rect.bottom - v.rect.top }
}

/** During a drag (after the move's setState): show/clear the "will snap
 *  here" ghost for the group's live card rect. */
export function updateDeckMagnetPreview(canDock: boolean, groupId: string): void {
  if (!canDock) return
  const rect = liveCardRect(groupId)
  if (!rect) return
  const wins = viewportWindowRects()
  const radius = magnetRadiusForZoom(useCanvasStore.getState().zoom)
  const cand = wins.length > 0 ? findMagnetCandidate(rect, wins, radius) : null
  const mp = useMagnetPreviewStore.getState()
  if (cand) {
    mp.setPreview({ windowId: cand.windowId, edge: cand.edge, x: cand.snapped.x, y: cand.snapped.y, width: rect.width, height: rect.height })
  } else if (mp.preview) {
    mp.setPreview(null)
  }
}

/** On release: snap the whole drag set flush to the previewed edge (same
 *  batched id set as the drag, so decks arrive intact) and load the deck's
 *  first model. Returns true when a dock happened. */
export function finishDeckMagnetDock(
  canDock: boolean,
  rootGroupId: string,
  rectGroupId: string,
  dragIds: string[],
): boolean {
  const mp = useMagnetPreviewStore.getState()
  const preview = mp.preview
  if (preview) mp.setPreview(null)
  if (!canDock || !preview) return false
  const rect = liveCardRect(rectGroupId)
  if (!rect) return false
  const ddx = preview.x - rect.x
  const ddy = preview.y - rect.y
  const bs = useBoardsStore.getState()
  if (ddx !== 0 || ddy !== 0) {
    const updates = dragIds.flatMap(gid => {
      const gg = bs.groups.find(x => x.id === gid)
      return gg ? [{ groupId: gid, originX: gg.originX + ddx, originY: gg.originY + ddy }] : []
    })
    bs.setGroupPosBatch(updates)
  }
  const models = collectDeckModels(rootGroupId, bs.groups, bs.boards)
  if (models[0]) useViewport3DStore.getState().setActiveModel(preview.windowId, models[0].url)
  return true
}

/** Release-time dock attempt for a group with NO drag preview (used by
 *  block zoom where boards move within their group / become groups on
 *  drop): if the group's card rect rests within the magnet radius of a
 *  window edge, snap it flush and load its first model. */
export function tryDockGroupAtRest(groupId: string): boolean {
  const rect = liveCardRect(groupId)
  if (!rect) return false
  const wins = viewportWindowRects()
  const radius = magnetRadiusForZoom(useCanvasStore.getState().zoom)
  const cand = wins.length > 0 ? findMagnetCandidate(rect, wins, radius) : null
  if (!cand) return false
  const bs = useBoardsStore.getState()
  const models = collectDeckModels(groupId, bs.groups, bs.boards)
  if (models.length === 0) return false
  const g = bs.groups.find(x => x.id === groupId)
  if (!g) return false
  const ddx = cand.snapped.x - rect.x
  const ddy = cand.snapped.y - rect.y
  if (ddx !== 0 || ddy !== 0) {
    bs.setGroupPosBatch([{ groupId, originX: g.originX + ddx, originY: g.originY + ddy }])
  }
  useViewport3DStore.getState().setActiveModel(cand.windowId, models[0].url)
  return true
}
