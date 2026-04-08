// nleZone.ts — computes the NLE timeline bounding box in canvas coordinates
// and clamps free nodes so they can't rest inside it.

import { useBoardsStore } from '../store/boardsStore'
import { computeGroupLayout, getRowY, getRowHeight } from './nleRows'

const BOARD_PADDING_X = 20
const NLE_HEADER_H = 36
const GAP = 8
const ZONE_PADDING = 50 // breathing room around the NLE zone

export function getNleZoneBounds(): { left: number; right: number; top: number; bottom: number } | null {
  const { boards, groups } = useBoardsStore.getState()

  const extents: { left: number; right: number; y: number; rowH: number }[] = []

  groups.forEach(group => {
    const groupLayout = computeGroupLayout(group.boardIds, boards)

    group.boardIds.forEach(bid => {
      const board = boards[bid]
      if (!board) return
      const bScale = board.boardScale ?? 1
      const rootBars = board.rootIds.map(id => board.bars[id]).filter(Boolean)
      if (rootBars.length === 0) return
      const minX = Math.min(...rootBars.map(b => b.x))
      const maxX = Math.max(...rootBars.map(b => b.x + b.width))
      const bx = group.originX + (board.nleX ?? 0)
      const row = board.nleRow ?? 0
      const by = group.originY + getRowY(row, groupLayout)
      extents.push({
        left: bx + BOARD_PADDING_X + minX * bScale,
        right: bx + BOARD_PADDING_X + maxX * bScale,
        y: by,
        rowH: getRowHeight(row, groupLayout),
      })
    })
  })

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
