// A deck linked to a storyline opens away from the line (Brian 2026-11-04).
// Beside a line that runs up or down, its cards open on the side of the
// front card away from the line: left of the line to the left, right of it
// to the right. Above or below a level line, they open up or down, away
// from it. The front card, which is the closed deck, never moves: the cards
// that run toward the line flip to its far side, mirrored about it and set
// past the cards already there, so they keep their gaps and their order
// out from it. A closed deck's edges and its fan show on the side its cards
// open to.

import type { BoardData, ProjectGroup } from '../store/boardsStore'
import { boundsOf } from '../store/canvasStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { neighbours } from './storyline'

type Box = { x: number; y: number; w: number; h: number }
/** A card's origin. */
export type Spot = { x: number; y: number }
export type GhostSlot = { cardId: string; deckOffsetX: number; deckOffsetY: number }
export type DeckSide = 'left' | 'right'

export interface DeckLay {
  /** Each other card's open place (its origin). */
  spots: Map<string, Spot>
  /** The front card's checked-out slots, as offsets from it. */
  ghosts?: GhostSlot[]
  /** The cards were turned away from a storyline (spots and ghosts differ
   *  from what is stored). */
  flipped: boolean
  /** The side of the front card its cards lie on. */
  side: DeckSide
}

type Lines = FreeNodeData[]
/** The storylines that hold a card, looked through once per pass. */
export function linkedLines(nodes: Record<string, FreeNodeData>): Lines {
  return Object.values(nodes).filter(n => n.type === 'storyline' && n.storyline?.dots?.some(p => p.cards?.length))
}

/** The storyline dot card `id` is linked to, and the far ends of the lines
 *  leaving it (canvas units). */
function linkOf(lines: Lines, id: string): { x: number; y: number; ends: Spot[] } | null {
  for (const n of lines) {
    const d = n.storyline!
    const p = d.dots.find(q => q.cards?.includes(id))
    if (!p) continue
    const ends = (d.edges ? neighbours(d, p.id) : [])
      .map(o => d.dots.find(q => q.id === o))
      .filter((q): q is NonNullable<typeof q> => !!q)
      .map(q => ({ x: n.x + q.x, y: n.y + q.y }))
    return { x: n.x + p.x, y: n.y + p.y, ends }
  }
  return null
}

/** Every linked storyline's dots, as one string: it changes when a line a
 *  deck could be linked to moves, for a store selector ('' when none). */
export function storyLinksKey(nodes: Record<string, FreeNodeData>): string {
  let out = ''
  for (const n of linkedLines(nodes)) {
    const d = n.storyline!
    out += `${n.id}@${n.x},${n.y}|${d.edges?.map(e => e.a + e.b).join(',') ?? ''}|`
    for (const p of d.dots) out += `${p.x},${p.y}${p.cards?.length ? ':' + p.cards.join('+') : ''};`
  }
  return out
}

const isClosed = (g: ProjectGroup) => !!g.deckState && g.deckState !== 'open'

/** Cards that all lie left of their front card (by their offsets from it):
 *  some to its left, none to its right. */
export const lyingLeft = (offs: { deckOffsetX?: number }[]) =>
  offs.some(c => (c.deckOffsetX ?? 0) < -1) && offs.every(c => (c.deckOffsetX ?? 0) <= 1)

/** Where the cards of the deck `anchor` fronts open, and which side of it
 *  they lie on. `memberIds` are the deck's cards (or, closing, the open
 *  cards about to form it); a closed card of its deck opens at the front
 *  card plus its offset, an open one is where it is. With the front card
 *  linked to a storyline, the cards that run toward the line go to the
 *  front card's far side. */
export function deckLay(anchor: ProjectGroup, memberIds: string[], byId: Map<string, ProjectGroup>,
                        boards: Record<string, BoardData>, lines: Lines): DeckLay {
  const members = memberIds.filter(id => id !== anchor.id).map(id => byId.get(id)).filter((g): g is ProjectGroup => !!g)
  const spotOf = (g: ProjectGroup): Spot =>
    g.deckAnchorId === anchor.id && isClosed(g) && g.deckOffsetX != null && g.deckOffsetY != null
      ? { x: anchor.originX + g.deckOffsetX, y: anchor.originY + g.deckOffsetY }
      : { x: g.originX, y: g.originY }
  const spots = new Map(members.map(g => [g.id, spotOf(g)]))
  const ghosts = anchor.ghostSlots
  const A = boundsOf(anchor, boards)
  const boxAt = (g: ProjectGroup, s: Spot): Box | null => {
    const b = boundsOf(g, boards)
    return b && { x: b.x + s.x - g.originX, y: b.y + s.y - g.originY, w: b.w, h: b.h }
  }
  // Which side by where the cards are drawn (a card's face sits off its
  // origin by its own boards' layout), its cards only, as useCardDecks reads it.
  const sideOf = (sp: Map<string, Spot>): DeckSide => {
    const ax = A?.x ?? anchor.originX
    return lyingLeft(members.map(g => {
      const s = sp.get(g.id)!, b = boxAt(g, s)
      return { deckOffsetX: (b ? b.x : s.x + (A ? A.x - anchor.originX : 0)) - ax }
    })) ? 'left' : 'right'
  }
  const plain = (): DeckLay => ({ spots, ghosts, flipped: false, side: sideOf(spots) })

  // Left as laid: its front card on no storyline (a card of its deck on a
  // dot is never turned away from its own dot), pinned, holding effect
  // cards (their chain reads left to right off the picture), or holding a
  // deck of its own (its cards hang off it, not off this front card).
  const link = members.length && !anchor.pin ? linkOf(lines, anchor.id) : null
  if (!link || !A) return plain()
  if (anchor.effect || members.some(g => g.effect)) return plain()
  const inDeck = new Set([anchor.id, ...members.map(g => g.id)])
  for (const g of byId.values()) {
    if (!inDeck.has(g.id) && g.deckAnchorId && g.deckAnchorId !== g.id && inDeck.has(g.deckAnchorId) && isClosed(g)) return plain()
  }
  type Item = { key: string; spot: Spot; box: Box }
  const items: Item[] = [
    ...members.map(g => { const spot = spots.get(g.id)!; return { key: g.id, spot, box: boxAt(g, spot) } }),
    ...(ghosts ?? []).map(sl => {
      const spot = { x: anchor.originX + sl.deckOffsetX, y: anchor.originY + sl.deckOffsetY }
      return { key: `ghost:${sl.cardId}`, spot, box: boxAt(byId.get(sl.cardId) ?? anchor, spot) }
    }),
  ].filter((it): it is Item => !!it.box)
  const cx = A.x + A.w / 2, cy = A.y + A.h / 2
  const move = new Map<string, Spot>()
  const shift = (key: string, dx: number, dy: number) => {
    const m = move.get(key) ?? { x: 0, y: 0 }
    move.set(key, { x: m.x + dx, y: m.y + dy })
  }
  // The cards that lie wholly past the front card toward the line (s = +1:
  // the line is on the right / below) are mirrored about its middle, then
  // set past the cards already on the far side.
  const turn = (s: 1 | -1, lo: (b: Box) => number, len: (b: Box) => number,
                aLo: number, aLen: number, c: number, put: (key: string, d: number) => void) => {
    const toward = items.filter(it => s > 0 ? lo(it.box) >= aLo + aLen - 1 : lo(it.box) + len(it.box) <= aLo + 1)
    if (!toward.length) return
    const far = items.filter(it => !toward.includes(it))
    const reach = Math.max(0, ...far.map(it => s > 0 ? aLo - lo(it.box) : lo(it.box) + len(it.box) - (aLo + aLen)))
    for (const it of toward) put(it.key, 2 * c - len(it.box) - 2 * lo(it.box) - s * reach)
  }
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
  const nearest = (vs: number[], c: number) => vs.reduce((a, b) => (Math.abs(b - c) < Math.abs(a - c) ? b : a))
  // Beside a line that runs up or down from the dot (the front card is
  // level with some of it): left of it, the cards belong on the left. Which
  // side, by where the line is at the front card's middle height.
  const upright = link.ends.filter(e => Math.abs(e.y - link.y) > Math.abs(e.x - link.x)
    && A.y < Math.max(link.y, e.y) && A.y + A.h > Math.min(link.y, e.y))
  if (upright.length) {
    const lx = nearest(upright.map(e => link.x + (e.x - link.x) * clamp01((cy - link.y) / (e.y - link.y))), cx)
    if (Math.abs(cx - lx) > 1) turn(cx < lx ? 1 : -1, b => b.x, b => b.w, A.x, A.w, cx, (k, d) => shift(k, d, 0))
  }
  // Over or under a level line: above it, the cards belong above.
  const level = link.ends.filter(e => Math.abs(e.y - link.y) <= Math.abs(e.x - link.x) && e.x !== link.x
    && A.x < Math.max(link.x, e.x) && A.x + A.w > Math.min(link.x, e.x))
  if (level.length) {
    const ly = nearest(level.map(e => link.y + (e.y - link.y) * clamp01((cx - link.x) / (e.x - link.x))), cy)
    if (Math.abs(cy - ly) > 1) turn(cy < ly ? 1 : -1, b => b.y, b => b.h, A.y, A.h, cy, (k, d) => shift(k, 0, d))
  }
  if (!move.size) return plain()

  const moved = (key: string, s: Spot): Spot => { const m = move.get(key); return m ? { x: s.x + m.x, y: s.y + m.y } : s }
  const flippedSpots = new Map(members.map(g => [g.id, moved(g.id, spots.get(g.id)!)]))
  const flippedGhosts = ghosts?.map(sl => {
    const m = move.get(`ghost:${sl.cardId}`)
    return m ? { ...sl, deckOffsetX: sl.deckOffsetX + m.x, deckOffsetY: sl.deckOffsetY + m.y } : sl
  })
  return { spots: flippedSpots, ghosts: flippedGhosts, flipped: true, side: sideOf(flippedSpots) }
}

/** Cards that all lie above their front card (by their offsets from it). */
export const lyingUp = (offs: { deckOffsetY?: number }[]) =>
  offs.length > 0 && offs.every(c => (c.deckOffsetY ?? 0) < -1)

/** Two of a deck's cards by how far across each lies from its front card
 *  (their offsets from it), nearest first, then top down. For a deck laid
 *  out to the right that is left to right, as it reads; to the left, right
 *  to left; with its primary card in the middle, out from it, the right-hand
 *  card first where two are as far. `up`: the deck lies above its front card
 *  (lyingUp), so bottom up instead of top down. */
export function nearer(ax: number, ay: number, bx: number, by: number, up = false): number {
  return Math.abs(ax) - Math.abs(bx) || bx - ax || (up ? by - ay : ay - by)
}

/** A closed deck's cards in the order they lay out from its front card,
 *  nearest first (see nearer). */
export function byLay<T extends { deckOffsetX?: number; deckOffsetY?: number }>(cards: T[]): T[] {
  const up = lyingUp(cards)
  return [...cards].sort((a, b) => nearer(a.deckOffsetX ?? 0, a.deckOffsetY ?? 0, b.deckOffsetX ?? 0, b.deckOffsetY ?? 0, up))
}
