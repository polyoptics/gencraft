// deckDockDrag.ts — shared magnet-docking glue for GROUP/CARD/DECK drags,
// used by every gesture that moves a whole group: card + stacked-deck
// drags (CardLayer, card zoom), the NLE timeline-header drag (board
// zoom), and ungrouped-block release (block zoom). Dock membership stays
// derived from geometry; these helpers only provide the drag-time
// affordance and the flush snap + load on release.

import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useViewport3DStore } from '../store/viewport3dStore'
import { useMagnetPreviewStore } from '../store/magnetPreviewStore'
import { findMagnetCandidate, magnetRadiusForZoom, type WindowRect } from './viewportDocking'
import { collectDeckModels } from './modelTraversal'
import { groupSlot, type GroupSlot } from './nlePush'
import { computeGroupLayout } from './nleRows'

export function viewportWindowRects(): WindowRect[] {
  return Object.values(useViewport3DStore.getState().windows)
    .map(w => ({ id: w.id, x: w.x, y: w.y, width: w.width, height: w.height }))
}

/** Cards visually extend UP above their bar content by the header
 *  surrogate — mirror useCardDecks' clustering formula exactly so docking
 *  aligns the CARD face, not the bar footprint ("snapping at the lowest
 *  board level"). Zoom-aware like deck clustering: geometry follows what
 *  you see. */
export function headerExtendCanvas(zoom: number): number {
  return (Math.max(36 /* NLE_HEADER_CANVAS_H */ * zoom, 20) + 2 * zoom) / zoom
}

/** The card's VISUAL rect (canvas units) from its bar-footprint slot. */
export function groupVisualRect(slot: GroupSlot, zoom: number): { x: number; y: number; width: number; height: number } {
  const ext = headerExtendCanvas(zoom)
  return { x: slot.left, y: slot.top - ext, width: slot.right - slot.left, height: (slot.bottom - slot.top) + ext }
}

/** During a drag: show/clear the "will snap here" ghost for the dragged
 *  slot (initial slot + current clamped delta). */
export function updateDeckMagnetPreview(canDock: boolean, slot: GroupSlot | null, dx: number, dy: number): void {
  if (!canDock || !slot) return
  const zoom = useCanvasStore.getState().zoom
  const vis = groupVisualRect(slot, zoom)
  const rect = { x: vis.x + dx, y: vis.y + dy, width: vis.width, height: vis.height }
  const wins = viewportWindowRects()
  const radius = magnetRadiusForZoom(zoom)
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
  slotGroupId: string,
  slotBoardIds: string[],
  dragIds: string[],
): boolean {
  const mp = useMagnetPreviewStore.getState()
  const preview = mp.preview
  if (preview) mp.setPreview(null)
  if (!canDock || !preview) return false
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.id === slotGroupId)
  if (!g) return false
  const slot = groupSlot(slotGroupId, slotBoardIds, bs.boards, g.originX, g.originY, computeGroupLayout(slotBoardIds, bs.boards))
  if (!slot) return false
  // Snap by the card's VISUAL rect — the preview stored visual coords.
  const vis = groupVisualRect(slot, useCanvasStore.getState().zoom)
  const ddx = preview.x - vis.x
  const ddy = preview.y - vis.y
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
 *  block zoom where ungrouped boards become groups on drop): if the
 *  group's slot rests within the magnet radius of a window edge, snap it
 *  flush and load its first model. */
export function tryDockGroupAtRest(groupId: string): boolean {
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.id === groupId)
  if (!g) return false
  const slot = groupSlot(groupId, g.boardIds, bs.boards, g.originX, g.originY, computeGroupLayout(g.boardIds, bs.boards))
  if (!slot) return false
  const zoom = useCanvasStore.getState().zoom
  const rect = groupVisualRect(slot, zoom)
  const wins = viewportWindowRects()
  const radius = magnetRadiusForZoom(zoom)
  const cand = wins.length > 0 ? findMagnetCandidate(rect, wins, radius) : null
  if (!cand) return false
  const models = collectDeckModels(groupId, bs.groups, bs.boards)
  if (models.length === 0) return false
  const ddx = cand.snapped.x - rect.x
  const ddy = cand.snapped.y - rect.y
  if (ddx !== 0 || ddy !== 0) {
    bs.setGroupPosBatch([{ groupId, originX: g.originX + ddx, originY: g.originY + ddy }])
  }
  useViewport3DStore.getState().setActiveModel(cand.windowId, models[0].url)
  return true
}
