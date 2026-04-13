// CardOutline — subtle outline + tinted fill showing the card bounding box
// Used by BlockLayer and BoardLayer overlays to hint at card shape

import React, { useMemo } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import type { ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { computeGroupLayout, getRowY, getRowHeight, boardContentHeight } from '../../utils/nleRows'

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
      const contentH = boardContentHeight(board.bars, board.rootIds, bScale)
      const visualH = Math.max(rowH, contentH)
      const minX = Math.min(...rootBars.map(b => b.x))
      const maxX = Math.max(...rootBars.map(b => b.x + b.width))
      const l = bx + BOARD_PADDING_X + minX * bScale - 16
      const r = bx + BOARD_PADDING_X + maxX * bScale + 16
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
    return {
      screenLeft: pan.x + left * zoom,
      screenTop: pan.y + top * zoom,
      screenWidth: finalW * zoom,
      screenHeight: finalH * zoom,
    }
  }, [group, boards, pan, zoom])

  if (!rect || rect.screenWidth === 0) return null

  return (
    <div style={{
      position: 'absolute',
      left: rect.screenLeft,
      top: rect.screenTop,
      width: rect.screenWidth,
      height: rect.screenHeight,
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 12,
      background: group.color + '0a',
      pointerEvents: 'none',
    }} />
  )
}
