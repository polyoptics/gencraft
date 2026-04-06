/**
 * Dynamic per-row height computation for the NLE timeline.
 *
 * Each NLE row's height is determined by the tallest board on that row.
 * Board content height = tallest root-bar height × boardScale + header/padding overhead.
 */

import type { Bar } from '../types/bar'
import { DEFAULT_H } from './barConstants'
import { useCanvasStore } from '../store/canvasStore'

/** Overhead added to bar content to get total board height in canvas units */
const BOARD_OVERHEAD = 90   // header + top/bottom padding
const ROW_GAP = 16          // canvas-unit gap between rows
const MIN_ROW_H = 160       // minimum row height even if content is smaller

/** Compute the content height of a single board from its bars */
export function boardContentHeight(
  bars: Record<string, Bar>,
  rootIds: string[],
  boardScale = 1,
): number {
  // Walk visible bars to find per-row max heights (same logic as NLELayout)
  const rowH: Record<number, number> = {}
  const allBars = Object.values(bars)
  // Only count bars reachable from roots
  const reachable = new Set<string>()
  const collect = (id: string) => {
    if (reachable.has(id)) return
    const bar = bars[id]
    if (!bar) return
    reachable.add(id)
    bar.children.forEach(collect)
  }
  rootIds.forEach(collect)

  allBars.filter(b => reachable.has(b.id)).forEach(b => {
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

/** Result of computing NLE row layout */
export interface RowLayout {
  /** Height of each row (indexed by row number) */
  rowHeights: Record<number, number>
  /** Y position of each row top (indexed by row number) */
  rowTops: Record<number, number>
  /** Total height of all rows */
  totalHeight: number
}

/**
 * Compute per-row heights and Y positions from all boards.
 * Call this whenever board content or positions change.
 *
 * When `canvasStore.dynamicRowHeights` is false, all rows get a uniform
 * height (the fixed `nleRowHeight` value), preserving the original fixed-grid
 * behavior with zero changes to any consumer code.
 */
export function computeRowLayout(
  boards: Record<string, any>,
  primaryBoardRow: number,
): RowLayout {
  const cs = useCanvasStore.getState()
  const dynamic = cs.dynamicRowHeights
  const fixedH = cs.nleRowHeight   // fallback uniform height (420)

  // Collect all boards with their row assignments and content heights
  const rowContentHeights: Record<number, number> = {}

  Object.values(boards).forEach(board => {
    if (!board) return
    const row = board.id === 'primary' ? primaryBoardRow : (board.nleRow ?? 0)
    if (dynamic) {
      const h = boardContentHeight(board.bars, board.rootIds, board.boardScale ?? 1)
      rowContentHeights[row] = Math.max(rowContentHeights[row] ?? MIN_ROW_H, h)
    } else {
      rowContentHeights[row] = fixedH
    }
  })

  // Ensure at least row 0 exists
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

  return { rowHeights, rowTops, totalHeight: Math.max(y - ROW_GAP, dynamic ? MIN_ROW_H : fixedH) }
}

/** Get the Y position for a given row */
export function getRowY(row: number, layout: RowLayout): number {
  // If row is in the layout, use it directly
  if (row in layout.rowTops) return layout.rowTops[row]

  // Row is beyond computed range — extrapolate
  const rows = Object.keys(layout.rowTops).map(Number).sort((a, b) => a - b)
  if (rows.length === 0) return row * MIN_ROW_H

  const maxRow = rows[rows.length - 1]
  const minRow = rows[0]

  if (row > maxRow) {
    // Extrapolate below: last row top + last row height + gap per extra row
    const lastTop = layout.rowTops[maxRow]
    const lastH = layout.rowHeights[maxRow] ?? MIN_ROW_H
    return lastTop + lastH + ROW_GAP + (row - maxRow - 1) * (MIN_ROW_H + ROW_GAP)
  }

  if (row < minRow) {
    // Extrapolate above
    const firstTop = layout.rowTops[minRow]
    return firstTop - (minRow - row) * (MIN_ROW_H + ROW_GAP)
  }

  // Row is in range but not occupied — interpolate from neighbors
  // Find nearest lower row that exists
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

/** Convert a Y position to the nearest row index */
export function yToRow(y: number, layout: RowLayout): number {
  const rows = Object.keys(layout.rowTops).map(Number).sort((a, b) => a - b)
  if (rows.length === 0) return Math.max(0, Math.round(y / MIN_ROW_H))

  // Find which row this Y falls in
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    const top = layout.rowTops[r]
    const h = layout.rowHeights[r] ?? MIN_ROW_H
    const mid = top + h / 2
    if (y >= mid) return r + (i < rows.length - 1 ? 0 : Math.max(0, Math.round((y - top - h) / (MIN_ROW_H + ROW_GAP))))
  }

  // Above all rows
  const firstRow = rows[0]
  const firstTop = layout.rowTops[firstRow]
  if (y < firstTop) {
    const rowsAbove = Math.round((firstTop - y) / (MIN_ROW_H + ROW_GAP))
    return Math.max(0, firstRow - rowsAbove)
  }

  return 0
}

/** Convert accumulated Y delta to a row delta, given the layout and starting row */
export function dyToRowDelta(dy: number, startRow: number, layout: RowLayout): number {
  const startY = getRowY(startRow, layout)
  const targetY = startY + dy
  return yToRow(targetY, layout) - startRow
}
