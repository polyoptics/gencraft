// ─── Background dot grid = card snap points ───
//
// The dots behind the canvas sit in WORLD space: one main dot every
// DOT_SPACING canvas units (the same spacing as the faint card-level row
// lines), so a dot stays put under a card however far you zoom. Zoomed in,
// fainter dots appear evenly between them (halves, quarters, ...) once
// they are far enough apart to read. Dragging a card pulls its top-left
// corner (header included) onto the nearest dot it can see: main dots are
// always snap points, the in-between ones only while they are showing.
// Hold Ctrl while dragging to place it freely.

import { CARD_GRID_SPACING, computeGroupLayout, getRowY } from './nleRows'
import type { ProjectGroup, BoardData } from '../store/boardsStore'

export const DOT_SPACING = CARD_GRID_SPACING
/** In-between dots show (and snap) once they are this far apart on screen. */
const MIN_SUB_PX = 32
const MAX_SUB_LEVELS = 6
/** How close (screen px) the corner must come to a dot to be pulled onto it. */
const SNAP_PX = 12
const BOARD_PADDING_X = 20

/** The finest dot step (canvas units) showing at this zoom: DOT_SPACING,
 *  or DOT_SPACING / 2, / 4, ... while those dots are MIN_SUB_PX apart. */
export function dotStep(zoom: number): number {
  let step = DOT_SPACING
  for (let i = 0; i < MAX_SUB_LEVELS && (step / 2) * zoom >= MIN_SUB_PX; i++) step /= 2
  return step
}

/** A card's top-left content corner in canvas units, relative to its origin
 *  (the same extent CardLayer draws the card from). Null when it has no bars. */
export function cardCornerOffset(group: ProjectGroup, boards: Record<string, BoardData>): { x: number; y: number } | null {
  const layout = computeGroupLayout(group.boardIds, boards)
  let left = Infinity, top = Infinity
  for (const bid of group.boardIds) {
    const board = boards[bid]
    if (!board) continue
    const rootBars = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
    if (rootBars.length === 0) continue
    const bScale = board.boardScale ?? 1
    const l = (board.nleX ?? 0) + BOARD_PADDING_X + Math.min(...rootBars.map(b => b.x)) * bScale
    const t = getRowY(board.nleRow ?? 0, layout)
    if (l < left) left = l
    if (t < top) top = t
  }
  return left === Infinity ? null : { x: left, y: top }
}

/** Pull a dragged card's origin so its top-left corner lands on a dot.
 *  `corner` is from cardCornerOffset; `headerPx` the card's header band
 *  above its content (NLETimelineHeader headerExtend) at this zoom. Each
 *  axis snaps on its own; `free` (Ctrl held) skips snapping. */
export function snapCardToDots(
  rawX: number, rawY: number,
  corner: { x: number; y: number } | null,
  zoom: number, headerPx: number, free = false,
): { x: number; y: number } {
  if (free || !corner) return { x: rawX, y: rawY }
  const step = dotStep(zoom)
  const reach = SNAP_PX / zoom
  const pull = (v: number) => {
    const n = Math.round(v / step) * step
    return Math.abs(n - v) <= reach ? n - v : 0
  }
  return {
    x: rawX + pull(rawX + corner.x),
    y: rawY + pull(rawY + corner.y - headerPx / zoom),
  }
}
