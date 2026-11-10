// Match master decks (Brian 2026-11-10): a chart's decks take the layout
// their master cards have now. He reorders and resizes the cards of a master
// deck to show who's who (bigger towards the top, smaller below); the chart's
// linked decks kept the layout they were baked with. Asked for, each dot's
// deck on the chart is laid out as its masters are: every card where it sits
// from the dot's own card, at its size next to that card's. The dot's card
// stays where it is, at the size it is, so the deck neither grows nor leaves
// its dot. Only the cards the chart already has: a card new to the master
// deck is not on the chart, and stays off it. A deck whose masters are no
// longer together (one deck, touching or locked) has no one layout to take,
// and is left as it is. The masters are only read. Pure reading here;
// utils/chartCard writes it.

import { boundsOf } from '../store/canvasStore'
import type { BoardData, ProjectGroup } from '../store/boardsStore'
import { cardTouchRect, isHiddenDeckMember } from '../hooks/useCardDecks'
import type { ChartData, ChartPlace } from './chartData'
import { liveLocks, lockOf } from './deckLock'

type Boards = Record<string, BoardData>
type Rect = { x: number; y: number; w: number; h: number }

/** Where card `g` is: a card closed into a deck sits where it would open
 *  (its place from its deck's front card). */
function originOf(g: ProjectGroup, byId: Map<string, ProjectGroup>, seen = new Set<string>()): { x: number; y: number } {
  const a = g.deckAnchorId ? byId.get(g.deckAnchorId) : undefined
  if (!a || !isHiddenDeckMember(g) || g.deckOffsetX == null || g.deckOffsetY == null || seen.has(g.id)) return { x: g.originX, y: g.originY }
  seen.add(g.id)
  const o = originOf(a, byId, seen)
  return { x: o.x + g.deckOffsetX, y: o.y + g.deckOffsetY }
}

/** Card `g`'s face as drawn, were its origin `at` (its own when absent). */
function faceOf(g: ProjectGroup, boards: Boards, at?: { x: number; y: number }): Rect | null {
  return boundsOf(at ? { ...g, originX: at.x, originY: at.y } : g, boards)
}

/** How wide card `g`'s face is with no width set: it is never narrower. */
function contentWidth(g: ProjectGroup, boards: Boards): number {
  return boundsOf({ ...g, cardWidthOverride: undefined }, boards)?.w ?? 1
}

/** Whether cards `ids` are in one deck: closed into one, locked as one, or
 *  touching (through any cards between them), as decks are told apart. */
function together(ids: string[], groups: ProjectGroup[], byId: Map<string, ProjectGroup>, boards: Boards, zoom: number): boolean {
  const shown = (id: string) => {
    let g = byId.get(id)
    const seen = new Set<string>()
    while (g && isHiddenDeckMember(g) && !seen.has(g.id)) { seen.add(g.id); g = byId.get(g.deckAnchorId!) }
    return g
  }
  const reps = [...new Set(ids.map(shown))]
  if (reps.some(g => !g || g.pin)) return false
  if (reps.length === 1) return true
  const live = liveLocks(groups)
  const lock = lockOf(reps[0], live)
  if (lock && reps.every(g => lockOf(g, live) === lock)) return true
  const pool = groups.filter(g => !isHiddenDeckMember(g) && !g.pin)
  const rects = new Map<string, ReturnType<typeof cardTouchRect>>()
  const rect = (g: ProjectGroup) => { if (!rects.has(g.id)) rects.set(g.id, cardTouchRect(g, boards, zoom)); return rects.get(g.id) }
  const TOL = 16
  const reached = new Set<string>([reps[0]!.id])
  const todo = [reps[0]!]
  while (todo.length) {
    const a = todo.pop()!, ra = rect(a)
    if (!ra) continue
    for (const b of pool) {
      if (reached.has(b.id) || lockOf(a, live) !== lockOf(b, live)) continue
      const rb = rect(b)
      if (!rb || ra.right + TOL < rb.left || rb.right + TOL < ra.left || ra.bottom + TOL < rb.top || rb.bottom + TOL < ra.top) continue
      reached.add(b.id)
      todo.push(b)
    }
  }
  return reps.every(g => reached.has(g!.id))
}

/** The places on `chart` that Match master decks would change, by master
 *  id, as they would be. Empty: the chart's decks are as their masters are
 *  (or none has masters together to take a layout from). */
export function matchedPlaces(chart: ChartData, groups: ProjectGroup[], boards: Boards, zoom: number): Map<string, ChartPlace> {
  const byId = new Map(groups.map(g => [g.id, g]))
  const placeOf = new Map(chart.places.map(p => [p.card, p]))
  const out = new Map<string, ChartPlace>()
  const near = (a: number | undefined, b: number | undefined) => Math.abs((a ?? 0) - (b ?? 0)) <= 0.5
  for (const t of chart.tiers) {
    const cards = t.cards.filter(c => placeOf.has(c) && byId.has(c))
    if (cards.length < 2 || !together(cards, groups, byId, boards, zoom)) continue
    // Each master: its face where it sits now, and how far its face is from
    // its origin (the same on its linked card: the same blocks).
    const at = new Map<string, { face: Rect; ox: number; oy: number; content: number }>()
    for (const c of cards) {
      const g = byId.get(c)!
      const raw = faceOf(g, boards), face = faceOf(g, boards, originOf(g, byId))
      if (raw && face) at.set(c, { face, ox: raw.x - g.originX, oy: raw.y - g.originY, content: contentWidth(g, boards) })
    }
    if (at.size < cards.length) continue
    const lead = cards[0], pl = placeOf.get(lead)!, ml = at.get(lead)!
    // The dot's card as it is on the chart: the scale every other card takes.
    const s = Math.max(ml.content, pl.w ?? 0) / ml.face.w
    const next = new Map<string, ChartPlace>([[lead, pl]])
    for (const c of cards.slice(1)) {
      const p = placeOf.get(c)!, m = at.get(c)!
      next.set(c, {
        ...p,
        dx: pl.dx + ml.ox + (m.face.x - ml.face.x) * s - m.ox,
        dy: pl.dy + ml.oy + (m.face.y - ml.face.y) * s - m.oy,
        w: m.face.w * s, h: m.face.h * s,
      })
    }
    // A closed deck's cards keep their places from its front card in step.
    for (const [c, p] of next) {
      const a = p.deckAnchorId && p.deckAnchorId !== c ? next.get(p.deckAnchorId) : undefined
      if (a && p.deckOffsetX != null && p.deckOffsetY != null) next.set(c, { ...p, deckOffsetX: p.dx - a.dx, deckOffsetY: p.dy - a.dy })
    }
    for (const [c, p] of next) {
      const was = placeOf.get(c)!
      const wasW = Math.max(at.get(c)!.content, was.w ?? 0)
      if (!near(p.dx, was.dx) || !near(p.dy, was.dy) || !near(Math.max(at.get(c)!.content, p.w ?? 0), wasW)
        || !near(p.deckOffsetX, was.deckOffsetX) || !near(p.deckOffsetY, was.deckOffsetY)) out.set(c, p)
    }
  }
  return out
}
