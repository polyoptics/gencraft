// deckJoin.ts — a row closing onto a closed deck adds its cards to that
// deck (Brian 2026-11-19). The deck's own cards open where they lay from
// its front card; the cards beside the closed deck stand in those same
// places, so opened again the two lots landed on each other. Joining, the
// added cards are set past the deck's own cards, as a block (their gaps
// and order kept), on the side of the front card they lie: one clean line
// when it opens. Only the cards being closed in are placed; the deck's own
// cards and its front card stay as they are.

import type { BoardData, ProjectGroup } from '../store/boardsStore'
import { boundsOf } from '../store/canvasStore'
import { isShut } from './deckTree'

type Box = { x: number; y: number; w: number; h: number }
const GAP = 12 // the gap cards keep between them (utils/nlePush DEFAULT_GAP)

/** (utils/deckTree: the one test for a card closed up.) */
const isClosed = isShut

/** How far the cards `comers` (about to close onto the closed deck `anchor`
 *  fronts) move to clear where that deck's own cards open (null: they are
 *  clear already, or it has none). */
export function joinShift(anchor: ProjectGroup, comers: ProjectGroup[], groups: ProjectGroup[],
                          boards: Record<string, BoardData>): { dx: number; dy: number } | null {
  if (!comers.length) return null
  const coming = new Set(comers.map(g => g.id))
  const own = groups.filter(g => g.id !== anchor.id && !coming.has(g.id) && g.deckAnchorId === anchor.id && isClosed(g)
    && g.deckOffsetX != null && g.deckOffsetY != null)
  if (!own.length) return null
  const boxes = (gs: ProjectGroup[], at: (g: ProjectGroup) => { x: number; y: number }): Box[] => gs.flatMap(g => {
    const b = boundsOf(g, boards)
    if (!b) return []
    const p = at(g)
    // The card's face: boundsOf reaches 16 past its content each side.
    return [{ x: b.x + 16 + p.x - g.originX, y: b.y + p.y - g.originY, w: Math.max(b.w - 32, g.cardWidthOverride ?? 0), h: b.h }]
  })
  const A = boxes([anchor], g => ({ x: g.originX, y: g.originY }))[0]
  if (!A) return null
  const ownBoxes = boxes(own, g => ({ x: anchor.originX + g.deckOffsetX!, y: anchor.originY + g.deckOffsetY! }))
  const comeBoxes = boxes(comers, g => ({ x: g.originX, y: g.originY }))
  if (!ownBoxes.length || !comeBoxes.length) return null
  const laps = (a: Box, b: Box) => a.x + a.w - 1 > b.x && b.x + b.w - 1 > a.x && a.y + a.h - 1 > b.y && b.y + b.h - 1 > a.y
  if (!comeBoxes.some(c => ownBoxes.some(o => laps(c, o)))) return null
  const span = (bs: Box[]) => ({
    l: Math.min(...bs.map(b => b.x)), r: Math.max(...bs.map(b => b.x + b.w)),
    t: Math.min(...bs.map(b => b.y)), b: Math.max(...bs.map(b => b.y + b.h)),
  })
  const C = span(comeBoxes), O = span([A, ...ownBoxes])
  const cx = (C.l + C.r) / 2 - (A.x + A.w / 2), cy = (C.t + C.b) / 2 - (A.y + A.h / 2)
  if (Math.abs(cx) >= Math.abs(cy)) return { dx: cx >= 0 ? O.r + GAP - C.l : O.l - GAP - C.r, dy: 0 }
  return { dx: 0, dy: cy >= 0 ? O.b + GAP - C.t : O.t - GAP - C.b }
}
