// BlockOutline — subtle dashed outline showing a block's bounding box.
// Used by BoardLayer at board zoom to give spatial context: even though
// blocks aren't visually rendered at this zoom, the user has set their
// dimensions at block zoom (often via widthOverride/heightOverride) and the
// outline restores that sense of "where this block ends" without taking
// focus from the bar editing surface.
//
// Visual identity: dashed border (vs CardOutline's solid one) so the eye
// distinguishes inner block partitions from the outer card boundary, even
// when both are rendered at the same zoom.

import React, { useMemo } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import type { ProjectGroup } from '../../store/boardsStore'
import { useCardView } from './cardView'
import { computeGroupLayout, getRowY } from '../../utils/nleRows'
import { DEFAULT_H } from '../../utils/barConstants'

// Mirrors the constants in NLE/Board.tsx (HEADER_H, BOARD_PADDING_TOP,
// BOARD_PADDING_X). The board's bar content is offset DOWN from the wrapper
// top by HEADER_H + BOARD_PADDING_TOP — so to outline the block body at board
// zoom we have to start there, not at the wrapper top. Hardcoded with this
// note so a drift between the constants is easy to spot.
const BOARD_PADDING_X = 20
const BOARD_HEADER_H = 28
const BOARD_PADDING_TOP = 28

export const BlockOutline: React.FC<{ group: ProjectGroup; boardId: string }> = ({ group, boardId }) => {
  // Frozen inside a pinned card — same reason as CardOutline: at board level
  // this outline belongs to a block that may be rendering under a pin's
  // camera, and the canvas camera would put it somewhere else entirely.
  const { pan, zoom } = useCardView()
  const boards = useBoardsStore(s => s.boards)
  const board = boards[boardId]

  const rect = useMemo(() => {
    if (!board) return null
    const bScale = board.boardScale ?? 1
    const rootBars = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
    if (rootBars.length === 0) return null
    const minX = Math.min(...rootBars.map(b => b.x))
    const maxX = Math.max(...rootBars.map(b => b.x + b.width))
    const contentW = (maxX - minX) * bScale
    const contentH = Math.max(...rootBars.map(b => b.height), DEFAULT_H) * bScale
    // Same width/height the BlockLayer uses for the rendered block, so the
    // outline matches what the user designed at block zoom — including any
    // manual widthOverride / heightOverride that extends the block beyond
    // its bar content.
    const wOverride = board.layers?.block?.widthOverride ?? 0
    const hOverride = board.layers?.block?.heightOverride ?? 0
    const finalW = Math.max(contentW, wOverride)
    const finalH = Math.max(contentH, hOverride)
    const layout = computeGroupLayout(group.boardIds, boards)
    const bx = group.originX + (board.nleX ?? 0)
    const by = group.originY + getRowY(board.nleRow ?? 0, layout)
    // Bars at board zoom render at:
    //   x: boardX + BOARD_PADDING_X + (bar.x * bScale)
    //   y: boardY + BOARD_HEADER_H + BOARD_PADDING_TOP + (bar.y * bScale)
    // The Board's wrapper top sits ABOVE the bars by HEADER_H + PADDING_TOP
    // canvas units, so to outline the block body (where the bars actually
    // are) we must add that offset to canvasTop. Without it the outline
    // floats over the board header area, well above the bars.
    const canvasLeft = bx + BOARD_PADDING_X + minX * bScale
    const canvasTop = by + BOARD_HEADER_H + BOARD_PADDING_TOP
    return {
      screenLeft: pan.x + canvasLeft * zoom,
      screenTop: pan.y + canvasTop * zoom,
      screenWidth: finalW * zoom,
      screenHeight: finalH * zoom,
    }
  }, [group, board, boards, pan, zoom])

  if (!rect || rect.screenWidth === 0 || rect.screenHeight === 0) return null

  return (
    <div
      data-block-outline={boardId}
      style={{
        position: 'absolute',
        left: rect.screenLeft,
        top: rect.screenTop,
        width: rect.screenWidth,
        height: rect.screenHeight,
        border: '1px dashed rgba(255,255,255,0.13)',
        borderRadius: 8,
        pointerEvents: 'none',
      }}
    />
  )
}
