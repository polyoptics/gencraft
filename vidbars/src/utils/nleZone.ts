// nleZone.ts — computes the NLE timeline bounding box in canvas coordinates
// and clamps free nodes so they can't rest inside it.

import { useCanvasStore } from '../store/canvasStore'
import { useBoardsStore } from '../store/boardsStore'
import { computeRowLayout, getRowY, getRowHeight, yToRow } from './nleRows'

const BOARD_PADDING_X = 20
const NLE_HEADER_H = 36
const GAP = 8
const ZONE_PADDING = 50 // breathing room around the NLE zone

export function getNleZoneBounds(): { left: number; right: number; top: number; bottom: number } | null {
  const { boardPos } = useCanvasStore.getState()
  const { boards, boardOrder } = useBoardsStore.getState()

  const layout0 = computeRowLayout(boards, 0)
  const pRow = Math.max(0, yToRow(boardPos.y, layout0))
  const layout = computeRowLayout(boards, pRow)

  const extents: { left: number; right: number; y: number; rowH: number }[] = []

  // Primary board
  const primary = boards['primary']
  if (primary) {
    const pScale = primary.boardScale ?? 1
    const rootBars = primary.rootIds.map(id => primary.bars[id]).filter(Boolean)
    if (rootBars.length > 0) {
      const minX = Math.min(...rootBars.map(b => b.x))
      const maxX = Math.max(...rootBars.map(b => b.x + b.width))
      extents.push({
        left: boardPos.x + BOARD_PADDING_X + minX * pScale,
        right: boardPos.x + BOARD_PADDING_X + maxX * pScale,
        y: boardPos.y,
        rowH: getRowHeight(pRow, layout),
      })
    }
  }

  // Extra boards
  for (const bid of boardOrder) {
    const board = boards[bid]
    if (!board) continue
    const bScale = board.boardScale ?? 1
    const rootBars = board.rootIds.map(id => board.bars[id]).filter(Boolean)
    if (rootBars.length === 0) continue
    const minX = Math.min(...rootBars.map(b => b.x))
    const maxX = Math.max(...rootBars.map(b => b.x + b.width))
    const y = getRowY(board.nleRow, layout)
    extents.push({
      left: board.nleX + BOARD_PADDING_X + minX * bScale,
      right: board.nleX + BOARD_PADDING_X + maxX * bScale,
      y,
      rowH: getRowHeight(board.nleRow, layout),
    })
  }

  if (extents.length === 0) return null

  const left = Math.min(...extents.map(e => e.left)) - ZONE_PADDING
  const right = Math.max(...extents.map(e => e.right)) + ZONE_PADDING
  const topY = Math.min(...extents.map(e => e.y))
  const bottomY = Math.max(...extents.map(e => e.y + e.rowH))
  const top = topY - NLE_HEADER_H - GAP - ZONE_PADDING
  const bottom = bottomY + ZONE_PADDING

  return { left, right, top, bottom }
}

/**
 * If a free node overlaps the NLE zone, push it to the nearest edge.
 * Returns the adjusted position, or the original if no overlap.
 */
export function clampToNoParkZone(
  nodeX: number, nodeY: number,
  nodeW: number, nodeH: number,
): { x: number; y: number } {
  const zone = getNleZoneBounds()
  if (!zone) return { x: nodeX, y: nodeY }

  const nodeRight = nodeX + nodeW
  const nodeBottom = nodeY + nodeH

  // No overlap — node is outside the zone
  if (nodeRight <= zone.left || nodeX >= zone.right ||
      nodeBottom <= zone.top || nodeY >= zone.bottom) {
    return { x: nodeX, y: nodeY }
  }

  // Overlapping — find shortest push to get outside
  const pushLeft = zone.left - nodeRight     // push node left (negative dx)
  const pushRight = zone.right - nodeX       // push node right (positive dx)
  const pushUp = zone.top - nodeBottom       // push node up (negative dy)
  const pushDown = zone.bottom - nodeY       // push node down (positive dy)

  const candidates = [
    { x: nodeX + pushLeft, y: nodeY, dist: Math.abs(pushLeft) },
    { x: nodeX + pushRight, y: nodeY, dist: Math.abs(pushRight) },
    { x: nodeX, y: nodeY + pushUp, dist: Math.abs(pushUp) },
    { x: nodeX, y: nodeY + pushDown, dist: Math.abs(pushDown) },
  ]

  candidates.sort((a, b) => a.dist - b.dist)
  const { x, y } = candidates[0]

  return { x, y }
}
