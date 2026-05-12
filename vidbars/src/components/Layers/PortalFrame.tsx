// PortalFrame — unified frame rendered for an active deck portal at
// block & board zoom. Replaces the anchor's normal CardOutline +
// NLETimelineHeader with an anchor-titled header on top + a member-
// colored glow body below, both sized to fit the locked member's
// content footprint. Reads as one cohesive element: "this is X's
// slot, displaying Y's content."
//
// Also exports `computeGroupBlockFootprint`, the shared rect helper
// that converts a group's boards into a single bounding-box rect in
// canvas coords — used by the portal logic in BoardsCanvas/BlockLayer
// to align the member's content to the anchor's top-left edge and to
// size the frame around it.

import React, { useMemo } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import type { ProjectGroup, BoardData } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { computeGroupLayout, getRowY, getRowHeight } from '../../utils/nleRows'
import { DEFAULT_H } from '../../utils/barConstants'
import { NLE_HEADER_CANVAS_H } from '../NLE/NLETimelineHeader'
import { hexToHsl, hslToHex } from '../../utils/colorUtils'

const BOARD_PADDING_X = 20

/** Visual block-level footprint of a group: the bounding box (in canvas
 *  coords) of all its boards' rendered rects. Returns null if the group
 *  has no renderable content. */
export function computeGroupBlockFootprint(
  group: ProjectGroup,
  boards: Record<string, BoardData>,
): { left: number; top: number; width: number; height: number } | null {
  const layout = computeGroupLayout(group.boardIds, boards)
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
  for (const bid of group.boardIds) {
    const board = boards[bid]
    if (!board) continue
    const bScale = board.boardScale ?? 1
    const rootBars = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
    if (rootBars.length === 0) continue
    const bx = group.originX + (board.nleX ?? 0)
    const localRow = board.nleRow ?? 0
    const by = group.originY + getRowY(localRow, layout)
    const rowH = getRowHeight(localRow, layout)
    const rootH = Math.max(...rootBars.map(b => b.height), DEFAULT_H) * bScale
    const visualH = Math.max(rowH, rootH)
    const minX = Math.min(...rootBars.map(b => b.x))
    const maxX = Math.max(...rootBars.map(b => b.x + b.width))
    const l = bx + BOARD_PADDING_X + minX * bScale
    const r = bx + BOARD_PADDING_X + maxX * bScale
    if (l < left) left = l
    if (r > right) right = r
    if (by < top) top = by
    if (by + visualH > bottom) bottom = by + visualH
  }
  if (left === Infinity) return null
  const w = right - left
  const h = bottom - top
  const finalW = Math.max(w, group.cardWidthOverride ?? 0)
  const finalH = Math.max(h, group.cardHeightOverride ?? 0)
  return { left, top, width: finalW, height: finalH }
}

export const PortalFrame: React.FC<{
  anchor: ProjectGroup
  member: ProjectGroup
  memberColor: string
}> = ({ anchor, member, memberColor }) => {
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const boards = useBoardsStore(s => s.boards)
  const rect = useMemo(() => {
    const anchorFp = computeGroupBlockFootprint(anchor, boards)
    const memberFp = computeGroupBlockFootprint(member, boards)
    if (!anchorFp || !memberFp) return null
    return {
      screenLeft: pan.x + anchorFp.left * zoom,
      screenTop: pan.y + anchorFp.top * zoom,
      screenWidth: memberFp.width * zoom,
      screenHeight: memberFp.height * zoom,
    }
  }, [anchor, member, boards, pan, zoom])
  if (!rect || rect.screenWidth === 0) return null

  // Header: anchor's color brightened 15% at 25% opacity — same recipe
  // as the standard NLETimelineHeader so the portal blends visually.
  const headerHeight = Math.max(NLE_HEADER_CANVAS_H * zoom, 20)
  const headerTop = rect.screenTop - headerHeight
  const { h, s, l } = hexToHsl(anchor.color)
  const brighterHex = hslToHex(h, s, Math.min(1, l + 0.15))
  const n = parseInt(brighterHex.replace('#', ''), 16)
  const headerBg = `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},0.25)`

  const FRAME_PAD = 4
  const frameLeft = rect.screenLeft - FRAME_PAD
  const frameWidth = rect.screenWidth + FRAME_PAD * 2

  return (
    <>
      <div
        data-portal-header={anchor.id}
        style={{
          position: 'absolute',
          left: frameLeft,
          top: headerTop,
          width: frameWidth,
          height: headerHeight,
          background: headerBg,
          borderRadius: '12px 12px 0 0',
          borderTop: `2px solid ${memberColor}`,
          borderLeft: `2px solid ${memberColor}`,
          borderRight: `2px solid ${memberColor}`,
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px',
          pointerEvents: 'none',
          zIndex: 11,
          boxShadow: `0 0 12px 1px ${memberColor}66`,
        }}
      >
        <span style={{
          color: anchor.name ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.35)',
          fontStyle: anchor.name ? 'normal' : 'italic',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.2px',
          textShadow: '0 1px 4px rgba(0,0,0,0.6)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flex: 1,
          minWidth: 0,
          lineHeight: '14px',
        }}>{anchor.name || 'Card'}</span>
      </div>
      <div
        data-portal-glow={anchor.id}
        style={{
          position: 'absolute',
          left: frameLeft,
          top: rect.screenTop - FRAME_PAD,
          width: frameWidth,
          height: rect.screenHeight + FRAME_PAD * 2,
          border: `2px solid ${memberColor}`,
          borderRadius: '0 0 14px 14px',
          boxShadow: `0 0 18px 4px ${memberColor}80, inset 0 0 12px ${memberColor}40`,
          pointerEvents: 'none',
          zIndex: 10,
        }}
      />
    </>
  )
}
