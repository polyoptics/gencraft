/**
 * Two-level row layout for the NLE timeline.
 *
 * Level 1 — Group (card) positioning: each ProjectGroup has an originY/originX
 *           in canvas space.  Moving a group moves all its boards as a rigid unit.
 *
 * Level 2 — Board (local) rows within a group: each board has nleRow (0, 1, 2…)
 *           relative to the group origin.  Row heights are either fixed (nleRowHeight)
 *           or dynamic (tallest board on that row).
 */

import type { Bar } from '../types/bar'
import { DEFAULT_H } from './barConstants'
import { useCanvasStore } from '../store/canvasStore'

/** Overhead added to bar content to get total board height in canvas units */
const BOARD_OVERHEAD = 90   // header + top/bottom padding
export const ROW_GAP = 16   // canvas-unit gap between rows
const MIN_ROW_H = 160       // minimum row height even if content is smaller

/** Compute the content height of a single board from its bars */
export function boardContentHeight(
  bars: Record<string, Bar>,
  rootIds: string[],
  boardScale = 1,
): number {
  const rowH: Record<number, number> = {}
  const reachable = new Set<string>()
  const collect = (id: string) => {
    if (reachable.has(id)) return
    const bar = bars[id]
    if (!bar) return
    reachable.add(id)
    bar.children.forEach(collect)
  }
  rootIds.forEach(collect)

  Object.values(bars).filter(b => reachable.has(b.id)).forEach(b => {
    rowH[b.rowIndex] = Math.max(rowH[b.rowIndex] ?? DEFAULT_H, b.height)
  })

  const rows = Object.keys(rowH).map(Number).sort((a, b) => a - b)
  if (rows.length === 0) return MIN_ROW_H

  let total = 0
  const minRow = rows[0]
  const maxRow = rows[rows.length - 1]
  for (let r = minRow; r <= maxRow; r++) {
    total += (rowH[r] ?? DEFAULT_H)
    if (r < maxRow) total += 8 // internal row gap within board
  }

  return total * boardScale + BOARD_OVERHEAD
}

// ─── Row Layout (shared shape for both levels) ───

export interface RowLayout {
  rowHeights: Record<number, number>
  rowTops: Record<number, number>
  totalHeight: number
}

// ─── Level 2: Group-local board rows ───

/**
 * Compute per-row heights and Y positions for boards within ONE group.
 * Board `nleRow` values are group-local (0, 1, 2…).
 *
 * When `canvasStore.dynamicRowHeights` is false, all rows get fixed height.
 */
// ── Layout cache: avoids recomputation when inputs haven't changed ──
const _layoutCache = new Map<string, RowLayout>()

export function computeGroupLayout(
  groupBoardIds: string[],
  boards: Record<string, any>,
): RowLayout {
  const cs = useCanvasStore.getState()
  const dynamic = cs.dynamicRowHeights
  const fixedH = cs.nleRowHeight

  // Build a cache key from board row/scale/bar-count to detect changes cheaply
  const keyParts = groupBoardIds.map(bid => {
    const b = boards[bid]
    if (!b) return `${bid}:_`
    return `${bid}:${b.nleRow ?? 0}:${b.boardScale ?? 1}:${Object.keys(b.bars ?? {}).length}`
  })
  const cacheKey = `${dynamic}:${fixedH}:${keyParts.join('|')}`
  const cached = _layoutCache.get(cacheKey)
  if (cached) return cached

  const rowContentHeights: Record<number, number> = {}

  groupBoardIds.forEach(bid => {
    const board = boards[bid]
    if (!board) return
    const row = board.nleRow ?? 0
    if (dynamic) {
      const h = boardContentHeight(board.bars, board.rootIds, board.boardScale ?? 1)
      rowContentHeights[row] = Math.max(rowContentHeights[row] ?? MIN_ROW_H, h)
    } else {
      rowContentHeights[row] = fixedH
    }
  })

  if (Object.keys(rowContentHeights).length === 0) {
    rowContentHeights[0] = dynamic ? MIN_ROW_H : fixedH
  }

  const rows = Object.keys(rowContentHeights).map(Number).sort((a, b) => a - b)
  const minRow = rows[0]
  const maxRow = rows[rows.length - 1]

  const rowHeights: Record<number, number> = {}
  const rowTops: Record<number, number> = {}
  let y = 0

  for (let r = minRow; r <= maxRow; r++) {
    const h = dynamic
      ? Math.max(rowContentHeights[r] ?? MIN_ROW_H, MIN_ROW_H)
      : fixedH
    rowHeights[r] = h
    rowTops[r] = y
    y += h + ROW_GAP
  }

  const result: RowLayout = { rowHeights, rowTops, totalHeight: Math.max(y - ROW_GAP, dynamic ? MIN_ROW_H : fixedH) }
  // Cap cache size to prevent unbounded growth
  if (_layoutCache.size > 50) _layoutCache.clear()
  _layoutCache.set(cacheKey, result)
  return result
}

/**
 * Compute the total canvas-space height of a group (all its local rows + gaps).
 */
export function getGroupHeight(
  groupBoardIds: string[],
  boards: Record<string, any>,
): number {
  return computeGroupLayout(groupBoardIds, boards).totalHeight
}

// ─── Row helpers (work with any RowLayout — group-local or legacy) ───

/** Get the Y position for a given row */
export function getRowY(row: number, layout: RowLayout): number {
  if (row in layout.rowTops) return layout.rowTops[row]

  const rows = Object.keys(layout.rowTops).map(Number).sort((a, b) => a - b)
  if (rows.length === 0) return row * MIN_ROW_H

  const maxRow = rows[rows.length - 1]
  const minRow = rows[0]

  if (row > maxRow) {
    const lastTop = layout.rowTops[maxRow]
    const lastH = layout.rowHeights[maxRow] ?? MIN_ROW_H
    return lastTop + lastH + ROW_GAP + (row - maxRow - 1) * (MIN_ROW_H + ROW_GAP)
  }

  if (row < minRow) {
    const firstTop = layout.rowTops[minRow]
    return firstTop - (minRow - row) * (MIN_ROW_H + ROW_GAP)
  }

  let prevRow = row - 1
  while (prevRow >= minRow && !(prevRow in layout.rowTops)) prevRow--
  if (prevRow >= minRow) {
    const prevTop = layout.rowTops[prevRow]
    const prevH = layout.rowHeights[prevRow] ?? MIN_ROW_H
    return prevTop + prevH + ROW_GAP + (row - prevRow - 1) * (MIN_ROW_H + ROW_GAP)
  }

  return row * MIN_ROW_H
}

/** Get the height of a given row */
export function getRowHeight(row: number, layout: RowLayout): number {
  return layout.rowHeights[row] ?? MIN_ROW_H
}

/** Convert a Y position (relative to group origin) to the nearest row index */
export function yToRow(y: number, layout: RowLayout): number {
  const rows = Object.keys(layout.rowTops).map(Number).sort((a, b) => a - b)
  if (rows.length === 0) return Math.max(0, Math.round(y / MIN_ROW_H))

  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    const top = layout.rowTops[r]
    const h = layout.rowHeights[r] ?? MIN_ROW_H
    const mid = top + h / 2
    if (y >= mid) return r + (i < rows.length - 1 ? 0 : Math.max(0, Math.round((y - top - h) / (MIN_ROW_H + ROW_GAP))))
  }

  const firstRow = rows[0]
  const firstTop = layout.rowTops[firstRow]
  if (y < firstTop) {
    const rowsAbove = Math.round((firstTop - y) / (MIN_ROW_H + ROW_GAP))
    return Math.max(0, firstRow - rowsAbove)
  }

  return 0
}

/** Convert accumulated Y delta to a row delta */
export function dyToRowDelta(dy: number, startRow: number, layout: RowLayout): number {
  // Fixed mode: clean division by stride for stable row quantization
  const cs = useCanvasStore.getState()
  if (!cs.dynamicRowHeights) {
    const stride = cs.nleRowHeight + ROW_GAP
    return Math.round(dy / stride)
  }
  // Dynamic mode: position-based
  const startY = getRowY(startRow, layout)
  const targetY = startY + dy
  return yToRow(targetY, layout) - startRow
}

// ─── Level 1: Group absolute positioning ───

/**
 * Compute the absolute canvas-space position of a board.
 * Returns { x, y } in canvas coordinates.
 */
export function getBoardAbsolutePos(
  boardId: string,
  groups: { originY: number; originX: number; boardIds: string[] }[],
  boards: Record<string, any>,
): { x: number; y: number } {
  const board = boards[boardId]
  if (!board) return { x: 0, y: 0 }

  const group = groups.find(g => g.boardIds.includes(boardId))
  if (!group) return { x: board.nleX ?? 0, y: 0 }

  const groupLayout = computeGroupLayout(group.boardIds, boards)
  return {
    x: group.originX + (board.nleX ?? 0),
    y: group.originY + getRowY(board.nleRow ?? 0, groupLayout),
  }
}

/**
 * Compute the absolute canvas-space X of a board.
 */
export function getBoardAbsoluteX(
  boardId: string,
  groups: { originX: number; boardIds: string[] }[],
  boards: Record<string, any>,
): number {
  const board = boards[boardId]
  if (!board) return 0
  const group = groups.find(g => g.boardIds.includes(boardId))
  return (group?.originX ?? 0) + (board.nleX ?? 0)
}

/**
 * Compute the absolute canvas-space Y of a board.
 */
export function getBoardAbsoluteY(
  boardId: string,
  groups: { originY: number; boardIds: string[] }[],
  boards: Record<string, any>,
): number {
  const board = boards[boardId]
  if (!board) return 0
  const group = groups.find(g => g.boardIds.includes(boardId))
  if (!group) return 0
  const groupLayout = computeGroupLayout(
    (group as any).boardIds ?? [],
    boards,
  )
  return (group.originY ?? 0) + getRowY(board.nleRow ?? 0, groupLayout)
}

// ─── Coarse grid helpers for group-level snap ───

/** Default coarse grid spacing for group snap (canvas units) */
export const CARD_GRID_SPACING = 500

/**
 * Snap a group originY to the nearest coarse grid line.
 * Returns the snapped Y if within threshold, else the raw Y.
 */
export function snapToCardGrid(
  rawY: number,
  gridSpacing: number = CARD_GRID_SPACING,
  threshold: number = 80,
): { y: number; snapped: boolean } {
  const nearest = Math.round(rawY / gridSpacing) * gridSpacing
  const dist = Math.abs(rawY - nearest)
  if (dist < threshold) return { y: nearest, snapped: true }
  return { y: rawY, snapped: false }
}

// ─── Legacy compat: computeRowLayout → redirects to computeGroupLayout ───

/**
 * @deprecated Use computeGroupLayout instead.
 * Kept for consumers not yet migrated. Computes layout for ALL boards
 * (treats them as one flat group — same as old behavior).
 */
export function computeRowLayout(
  boards: Record<string, any>,
  _primaryBoardRow: number,
): RowLayout {
  const allIds = Object.keys(boards)
  return computeGroupLayout(allIds, boards)
}
