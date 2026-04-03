import type { Bar } from '../types/bar'

/** Slot describing a board's visual span on the NLE timeline */
export interface BoardSlot {
  id: string
  nleRow: number
  /** Visual left edge in canvas coords = boardAnchorX + BOARD_PADDING_X + minRootBarX */
  nleX: number
  /** Visual width = maxRootBarX - minRootBarX */
  width: number
  /** The board's anchor X (boardPos.x or board.nleX) — needed to convert back */
  anchorX: number
  /** min root-bar X within the board — needed to convert visual X → anchor X */
  minBarX: number
}

const BOARD_PADDING_X = 20
const DEFAULT_GAP = 12

/** Compute a board's visual slot from its bars */
function slotFromBars(
  id: string,
  nleRow: number,
  anchorX: number,
  bars: Record<string, Bar>,
): BoardSlot {
  const topRowBars = Object.values(bars).filter(b => b.rowIndex === 0)
  const minBarX = topRowBars.length > 0 ? Math.min(...topRowBars.map(b => b.x)) : 0
  const maxBarX = topRowBars.length > 0 ? Math.max(...topRowBars.map(b => b.x + b.width)) : 200
  return {
    id,
    nleRow,
    anchorX,
    minBarX,
    nleX: anchorX + BOARD_PADDING_X + minBarX,
    width: Math.max(maxBarX - minBarX, 4),
  }
}

/** Build a slot for the primary board */
export function primarySlot(
  boardPosX: number,
  boardRow: number,
  bars: Record<string, Bar>,
): BoardSlot {
  return slotFromBars('primary', boardRow, boardPosX, bars)
}

/** Build slots for all extra boards (excludes the primary board) */
export function extraSlots(
  boards: Record<string, { id: string; nleRow: number; nleX: number; bars: Record<string, Bar> }>,
): BoardSlot[] {
  return Object.values(boards)
    .filter(b => b.id !== 'primary')
    .map(b => slotFromBars(b.id, b.nleRow, b.nleX, b.bars))
}

/**
 * Compute new anchor positions for all boards on `targetRow` after placing
 * `movedId`'s visual left edge at `newVisualX`.
 *
 * Always pass the **pre-drag snapshot** of slots so that boards snap back
 * to their natural positions when the moved board moves away.
 *
 * Returns Map<boardId, newAnchorX> for every board whose anchor changed
 * (excluding movedId itself).
 */
export function computeNLEPush(
  preDragSlots: BoardSlot[],
  movedId: string,
  newVisualX: number,
  targetRow: number,
  gap = DEFAULT_GAP,
): Map<string, number> {
  const result = new Map<string, number>()
  const movedSlot = preDragSlots.find(s => s.id === movedId)
  if (!movedSlot) return result

  // All slots on the target row, excluding moved board, using pre-drag positions
  const rowSlots = preDragSlots.filter(s => s.nleRow === targetRow && s.id !== movedId)
  // Working visual-X positions (start from pre-drag)
  const wx = new Map<string, number>(rowSlots.map(s => [s.id, s.nleX]))

  // Full set including the moved board at its new position
  const allSlots: BoardSlot[] = [
    { ...movedSlot, nleX: newVisualX, nleRow: targetRow },
    ...rowSlots,
  ]

  // Iterative overlap resolution — movedId is fixed
  const maxIter = (allSlots.length + 1) * 4
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false

    const sorted = [...allSlots].sort((a, b) => {
      const ax = a.id === movedId ? newVisualX : (wx.get(a.id) ?? a.nleX)
      const bx = b.id === movedId ? newVisualX : (wx.get(b.id) ?? b.nleX)
      return ax - bx
    })

    for (let i = 0; i < sorted.length - 1; i++) {
      const left  = sorted[i]
      const right = sorted[i + 1]
      const lx = left.id  === movedId ? newVisualX : (wx.get(left.id)  ?? left.nleX)
      const rx = right.id === movedId ? newVisualX : (wx.get(right.id) ?? right.nleX)
      const lRight = lx + left.width

      if (lRight + gap > rx) {
        if (right.id === movedId) {
          // movedId is on the right → push left board leftward
          const target = newVisualX - left.width - gap
          const cur = wx.get(left.id) ?? left.nleX
          if (Math.abs(cur - target) > 0.5) { wx.set(left.id, target); changed = true }
        } else {
          // push right board rightward
          const target = lRight + gap
          const cur = wx.get(right.id) ?? right.nleX
          if (Math.abs(cur - target) > 0.5) { wx.set(right.id, target); changed = true }
        }
      }
    }

    if (!changed) break
  }

  // Convert visual X back to anchor X and collect changes
  for (const s of rowSlots) {
    const finalVisualX = wx.get(s.id) ?? s.nleX
    const newAnchorX   = finalVisualX - BOARD_PADDING_X - s.minBarX
    if (Math.abs(newAnchorX - s.anchorX) > 0.5) {
      result.set(s.id, newAnchorX)
    }
  }

  return result
}

/**
 * Clamp a board's proposed anchor X so it cannot overlap any other board
 * on `targetRow`. Returns the clamped anchor X.
 */
export function clampBoardX(
  allSlots: BoardSlot[],
  movedId: string,
  proposedAnchorX: number,
  targetRow: number,
  gap = DEFAULT_GAP,
): number {
  const moved = allSlots.find(s => s.id === movedId)
  if (!moved) return proposedAnchorX

  const movedVisualW = moved.width
  const movedMinBarX = moved.minBarX
  // Visual left edge of the proposed position
  let visualLeft = proposedAnchorX + BOARD_PADDING_X + movedMinBarX
  const visualRight = () => visualLeft + movedVisualW

  const others = allSlots.filter(s => s.nleRow === targetRow && s.id !== movedId)

  // Sort others by visual left
  const sorted = [...others].sort((a, b) => a.nleX - b.nleX)

  for (const other of sorted) {
    const otherLeft  = other.nleX
    const otherRight = other.nleX + other.width

    // Overlapping from the right side of `other`? clamp our left to other's right
    if (visualLeft < otherRight + gap && visualRight() > otherLeft - gap) {
      // Determine which side we're approaching from
      const overlapFromLeft  = visualLeft < otherLeft  // we're to the left
      if (overlapFromLeft) {
        // clamp our right edge to other's left
        visualLeft = otherLeft - gap - movedVisualW
      } else {
        // clamp our left edge to other's right
        visualLeft = otherRight + gap
      }
    }
  }

  return visualLeft - BOARD_PADDING_X - movedMinBarX
}
