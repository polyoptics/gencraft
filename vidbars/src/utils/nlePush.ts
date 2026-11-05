import type { Bar } from '../types/bar'
import type { RowLayout } from './nleRows'
import { getRowY, getRowHeight } from './nleRows'

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

/** Compute a board's visual slot from its root bars only, accounting for boardScale */
function slotFromBars(
  id: string,
  nleRow: number,
  anchorX: number,
  bars: Record<string, Bar>,
  rootIds: string[],
  boardScale = 1,
): BoardSlot {
  const rootBars = rootIds.map(rid => bars[rid]).filter(Boolean)
  const minBarX = rootBars.length > 0 ? Math.min(...rootBars.map(b => b.x)) : 0
  const maxBarX = rootBars.length > 0 ? Math.max(...rootBars.map(b => b.x + b.width)) : 200
  // Store scaled values so all consumers work in visual canvas coords
  const scaledMinBarX = minBarX * boardScale
  return {
    id,
    nleRow,
    anchorX,
    minBarX: scaledMinBarX,
    nleX: anchorX + BOARD_PADDING_X + scaledMinBarX,
    width: Math.max((maxBarX - minBarX) * boardScale, 4),
  }
}

/**
 * Build BoardSlots for all boards within one group, using the group's origin
 * for absolute X but keeping local nleRow for same-row collision matching.
 * Collision only makes sense within a group (shared row grid).
 */
export function groupBoardSlots(
  groupOriginX: number,
  boardIds: string[],
  boards: Record<string, any>,
): BoardSlot[] {
  return boardIds
    .map(bid => {
      const b = boards[bid]
      if (!b) return null
      const absX = groupOriginX + (b.nleX ?? 0)
      return slotFromBars(bid, b.nleRow ?? 0, absX, b.bars, b.rootIds ?? [], b.boardScale ?? 1)
    })
    .filter(Boolean) as BoardSlot[]
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

// ── Group-level collision (card layer) ──────────────────────────────

/** 2D bounding box for a group of boards in canvas space */
export interface GroupSlot {
  id: string
  left: number
  right: number
  top: number
  bottom: number
}

/** Build a GroupSlot from a group's board IDs using two-level positioning */
export function groupSlot(
  groupId: string,
  boardIds: string[],
  boards: Record<string, any>,
  groupOriginX: number,
  groupOriginY: number,
  layout: RowLayout,
): GroupSlot | null {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
  boardIds.forEach(bid => {
    const board = boards[bid]
    if (!board) return
    const bScale = board.boardScale ?? 1
    const rootBars = board.rootIds.map((rid: string) => board.bars[rid]).filter(Boolean)
    if (rootBars.length === 0) return
    const bx = groupOriginX + (board.nleX ?? 0)
    const row = board.nleRow ?? 0
    const by = groupOriginY + getRowY(row, layout)
    const rowH = getRowHeight(row, layout)
    const minX = Math.min(...rootBars.map((b: any) => b.x))
    const maxX = Math.max(...rootBars.map((b: any) => b.x + b.width))
    const l = bx + BOARD_PADDING_X + minX * bScale - 16
    const r = bx + BOARD_PADDING_X + maxX * bScale + 16
    if (l < left) left = l
    if (r > right) right = r
    if (by < top) top = by
    if (by + rowH > bottom) bottom = by + rowH
  })
  if (left === Infinity) return null
  return { id: groupId, left, right, top, bottom }
}

/**
 * Clamp a proposed dx/dy so the moving GroupSlot doesn't overlap any obstacle.
 * Same approach-direction logic as clampBoardX, extended to 2D.
 */
export function clampGroupMove(
  moving: GroupSlot,
  dx: number,
  dy: number,
  obstacles: GroupSlot[],
  gap = DEFAULT_GAP,
  /** The furthest down it may go (a storyline wall's foot, utils/wallRoom). */
  maxDy = Infinity,
): { dx: number; dy: number } {
  let clampedDx = dx
  let clampedDy = Math.min(dy, maxDy)

  for (const obs of obstacles) {
    const ml = moving.left   + clampedDx
    const mr = moving.right  + clampedDx
    const mt = moving.top    + clampedDy
    const mb = moving.bottom + clampedDy

    const ol = obs.left   - gap
    const or_ = obs.right + gap
    const ot = obs.top    - gap
    const ob = obs.bottom + gap

    // Check overlap
    if (ml >= or_ || mr <= ol || mt >= ob || mb <= ot) continue

    // Overlap exists — resolve on the axis with least penetration
    const pushRight = or_ - ml   // push moving rightward
    const pushLeft  = ol - mr    // push moving leftward (negative)
    const pushDown  = ob - mt    // push moving downward
    const pushUp    = ot - mb    // push moving upward (negative)

    const minAbsX = Math.abs(pushRight) < Math.abs(pushLeft) ? pushRight : pushLeft
    // A push down past maxDy is never taken: the overlap goes sideways or up.
    const down = clampedDy + pushDown <= maxDy ? pushDown : Infinity
    const minAbsY = Math.abs(down)  < Math.abs(pushUp)   ? down  : pushUp

    // Resolve on whichever axis needs the smaller correction
    if (Math.abs(minAbsX) < Math.abs(minAbsY)) {
      clampedDx += minAbsX
    } else {
      clampedDy += minAbsY
    }
  }

  return { dx: clampedDx, dy: clampedDy }
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
