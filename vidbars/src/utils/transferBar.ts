import type { Bar } from '../types/bar'
import { useBoardsStore, getGroupForBoard } from '../store/boardsStore'
import { collectSubtree } from './barOps'
import { computeGroupLayout, getRowY } from './nleRows'

const BOARD_PADDING_X = 20

/**
 * Describe every board as a horizontal range in canvas space.
 * Used to find which board a dragged bar is hovering over.
 */
export interface BoardRange {
  id: string           // 'primary' for the primary board
  anchorX: number      // board's absolute X (group.originX + board.nleX)
  nleRow: number
  left: number         // canvas left edge of bar content
  right: number        // canvas right edge of bar content
}

export function buildBoardRanges(): BoardRange[] {
  const bsState = useBoardsStore.getState()

  const ranges: BoardRange[] = []

  bsState.groups.forEach(group => {
    const groupLayout = computeGroupLayout(group.boardIds, bsState.boards)

    group.boardIds.forEach(bid => {
      const board = bsState.boards[bid]
      if (!board) return
      const bScale = board.boardScale ?? 1
      const topRow = Object.values(board.bars).filter(b => b.rowIndex === 0)
      if (topRow.length === 0) return
      const minX = Math.min(...topRow.map(b => b.x))
      const maxX = Math.max(...topRow.map(b => b.x + b.width))
      const absX = group.originX + (board.nleX ?? 0)
      ranges.push({
        id: bid,
        anchorX: absX,
        nleRow: board.nleRow ?? 0,
        left: absX + BOARD_PADDING_X + minX * bScale,
        right: absX + BOARD_PADDING_X + maxX * bScale,
      })
    })
  })

  return ranges
}

/**
 * Given a bar's center in canvas space, find which board it's hovering over.
 * Only considers boards on the same NLE row as the source board.
 * Returns null if no suitable target found.
 */
export function findTargetBoard(
  barCenterCanvas: number,
  sourceId: string,
  sourceRow: number,
): BoardRange | null {
  const ranges = buildBoardRanges()
  for (const r of ranges) {
    if (r.id === sourceId) continue
    if (r.nleRow !== sourceRow) continue
    if (barCenterCanvas >= r.left && barCenterCanvas <= r.right) return r
  }
  return null
}

/**
 * Transfer a bar (and its subtree) from one board to another.
 * The bar's canvas position is preserved by translating its x.
 */
export function transferBar(
  barId: string,
  sourceId: string,
  target: BoardRange,
  sourceBars: Record<string, Bar>,
  sourceAnchorX: number,
) {
  const xOffset = sourceAnchorX - target.anchorX

  // Collect subtree from the snapshot
  const subtreeIds = collectSubtree(sourceBars, barId)
  const subtreeBars: Record<string, Bar> = {}
  subtreeIds.forEach(id => {
    if (sourceBars[id]) subtreeBars[id] = sourceBars[id]
  })

  // Root bar becomes a new root in target (no parent, rowIndex 0)
  if (subtreeBars[barId]) {
    subtreeBars[barId] = { ...subtreeBars[barId], parentId: null, rowIndex: 0 }
  }

  // Import into target board (works for both primary and extra)
  useBoardsStore.getState().importBars(target.id, subtreeBars, [barId], xOffset)

  // Delete from source board
  useBoardsStore.getState().deleteSubtree(sourceId, barId)
}
