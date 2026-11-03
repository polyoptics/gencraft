// ─── Card-to-card edge snap ───
//
// While a card is dragged, its side edge pulls onto a neighbouring card's
// opposite side (resting at the same gap a push against it would stop at),
// and its top or bottom lines up with that neighbour's. It only grabs when
// the edges are very close: elsewhere placement stays free (dots aside).
// Used by snapCardToDots, so every card drag gets it and Ctrl still
// places freely. The reach is a few screen px, but never more than a small
// share of the card itself, so zoomed far out it stays tight to the cards.

import type { ProjectGroup, BoardData } from '../store/boardsStore'
import { cardVisualRect, canvasObstacleGroups, isHiddenDeckMember } from '../hooks/useCardDecks'

/** Same gap clampGroupMove keeps between cards (nlePush DEFAULT_GAP). */
const CARD_GAP = 12
/** How close (screen px) two edges must come before they snap. */
const EDGE_SNAP_PX = 10
/** ...but never more than this share of the dragged card's smaller side. */
const EDGE_SNAP_MAX_SHARE = 1 / 6

type Rect = { left: number; right: number; top: number; bottom: number }

export interface CardEdgeSnap {
  /** Dragged card's visual rect relative to its anchor's origin. */
  rel: Rect
  /** Visual rects of the cards it can snap to. */
  others: Rect[]
}

/** Gather the edges for a drag, at drag start. `anchorId` is the card whose
 *  origin the drag moves; `dragIds` everything moving with it. */
export function cardEdgeSnapFor(
  anchorId: string, dragIds: Iterable<string>,
  groups: ProjectGroup[], boards: Record<string, BoardData>, zoom: number,
): CardEdgeSnap | null {
  const anchor = groups.find(g => g.id === anchorId)
  if (!anchor) return null
  const dragging = new Set(dragIds)
  dragging.add(anchorId)
  let rel: Rect | null = null
  for (const g of groups) {
    if (!dragging.has(g.id) || (g.id !== anchorId && isHiddenDeckMember(g))) continue
    const v = cardVisualRect(g, boards, zoom)
    if (!v) continue
    const r = v.rect
    rel = rel
      ? { left: Math.min(rel.left, r.left), right: Math.max(rel.right, r.right), top: Math.min(rel.top, r.top), bottom: Math.max(rel.bottom, r.bottom) }
      : { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
  }
  if (!rel) return null
  rel = { left: rel.left - anchor.originX, right: rel.right - anchor.originX, top: rel.top - anchor.originY, bottom: rel.bottom - anchor.originY }
  const others: Rect[] = []
  for (const g of canvasObstacleGroups(groups, dragging)) {
    const v = cardVisualRect(g, boards, zoom)
    if (v) others.push(v.rect)
  }
  return others.length ? { rel, others } : null
}

/** Pull from a card edge onto a neighbour, per axis; null on an axis means
 *  nothing is close enough there. */
export function snapCardEdges(
  x: number, y: number, edges: CardEdgeSnap, zoom: number,
): { dx: number | null; dy: number | null } {
  const { rel } = edges
  const w = rel.right - rel.left, h = rel.bottom - rel.top
  const reach = Math.min(EDGE_SNAP_PX / zoom, Math.min(w, h) * EDGE_SNAP_MAX_SHARE)
  const m = { left: x + rel.left, right: x + rel.right, top: y + rel.top, bottom: y + rel.bottom }

  // Side by side: a side edge onto the neighbour's opposite side, when the
  // two overlap vertically.
  let dx: number | null = null
  for (const o of edges.others) {
    if (m.bottom + reach < o.top || m.top - reach > o.bottom) continue
    for (const d of [o.right + CARD_GAP - m.left, o.left - CARD_GAP - m.right]) {
      if (Math.abs(d) <= reach && (dx === null || Math.abs(d) < Math.abs(dx))) dx = d
    }
  }
  // Lined up: top with top (or bottom with bottom) of a card sitting right
  // beside it.
  const sx = dx ?? 0
  let dy: number | null = null
  for (const o of edges.others) {
    const gapRight = o.left - (m.right + sx), gapLeft = (m.left + sx) - o.right
    const beside = Math.abs(gapRight - CARD_GAP) <= reach || Math.abs(gapLeft - CARD_GAP) <= reach
    if (!beside) continue
    for (const d of [o.top - m.top, o.bottom - m.bottom]) {
      if (Math.abs(d) <= reach && (dy === null || Math.abs(d) < Math.abs(dy))) dy = d
    }
  }
  return { dx, dy }
}
