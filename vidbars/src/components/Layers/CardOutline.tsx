// CardOutline — subtle outline + tinted fill showing the card bounding box
// Used by BlockLayer and BoardLayer overlays to hint at card shape

import React, { useMemo } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import type { ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { computeGroupLayout, getRowY, getRowHeight } from '../../utils/nleRows'
import { DEFAULT_H } from '../../utils/barConstants'
import { NLE_HEADER_CANVAS_H } from '../NLE/NLETimelineHeader'

const BOARD_PADDING_X = 20

export const CardOutline: React.FC<{ group: ProjectGroup }> = ({ group }) => {
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const boards = useBoardsStore(s => s.boards)

  const rect = useMemo(() => {
    const layout = computeGroupLayout(group.boardIds, boards)
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
    group.boardIds.forEach(bid => {
      const board = boards[bid]
      if (!board) return
      const bScale = board.boardScale ?? 1
      const rootBars = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
      if (rootBars.length === 0) return
      const bx = group.originX + (board.nleX ?? 0)
      const localRow = board.nleRow ?? 0
      const by = group.originY + getRowY(localRow, layout)
      const rowH = getRowHeight(localRow, layout)
      const rootH = Math.max(...rootBars.map(b => b.height), DEFAULT_H) * bScale
      const visualH = Math.max(rowH, rootH)
      const minX = Math.min(...rootBars.map(b => b.x))
      const maxX = Math.max(...rootBars.map(b => b.x + b.width))
      // Outline bounds match the content bounds exactly (no outer padding).
      // Matches the card-visual computations in CardLayer so the outline
      // aligns with the actual card.
      const l = bx + BOARD_PADDING_X + minX * bScale
      const r = bx + BOARD_PADDING_X + maxX * bScale
      if (l < left) left = l
      if (r > right) right = r
      if (by < top) top = by
      if (by + visualH > bottom) bottom = by + visualH
    })
    if (left === Infinity) return null
    const cW = right - left
    const cH = bottom - top
    const finalW = Math.max(cW, group.cardWidthOverride ?? 0)
    const finalH = Math.max(cH, group.cardHeightOverride ?? 0)
    const headerExtend = Math.max(NLE_HEADER_CANVAS_H * zoom, 20) + 2 * zoom
    return {
      screenLeft: pan.x + left * zoom,
      screenTop: pan.y + top * zoom - headerExtend,
      screenWidth: finalW * zoom,
      screenHeight: finalH * zoom + headerExtend,
    }
  }, [group, boards, pan, zoom])

  if (!rect || rect.screenWidth === 0) return null

  return (
    <div
      data-group-outline={group.id}
      style={{
        position: 'absolute',
        left: rect.screenLeft,
        top: rect.screenTop,
        width: rect.screenWidth,
        height: rect.screenHeight,
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        background: group.color + '0a',
        pointerEvents: 'none',
      }}
    />
  )
}
