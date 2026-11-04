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
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
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

/** Every card linked to a storyline dot, as one sorted string: it changes
 *  only when a card is linked or unlinked, for a store selector. */
export function storyCardsKey(nodes: Record<string, FreeNodeData>): string {
  const ids: string[] = []
  for (const n of linkedLines(nodes)) for (const p of n.storyline!.dots) if (p.cards?.length) ids.push(...p.cards)
  return ids.sort().join('|')
}

/** Whether any of the cards `ids` is linked to a storyline dot (read live).
 *  Only such a deck reads its cards from its front card leftward or upward;
 *  any other deck keeps its old order and draws its edges on the right. */
export function deckOnStoryline(ids: string[]): boolean {
  const lines = linkedLines(useFreeNodeStore.getState().nodes)
  return lines.length > 0 && ids.some(id => !!linkOf(lines, id))
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
export const lyingUp = (offs: { deckOffsetY?: number }[]) =>
  offs.some(c => (c.deckOffsetY ?? 0) < -1) && offs.every(c => (c.deckOffsetY ?? 0) <= 1)

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
  // On a storyline: the front card's dot, else one of its cards'. A deck
  // off every storyline is drawn as it always was, on the right.
  const onLine = linkOf(lines, anchor.id) ?? members.reduce<ReturnType<typeof linkOf>>((l, g) => l ?? linkOf(lines, g.id), null)
  const plain = (): DeckLay => ({ spots, ghosts, flipped: false, side: onLine ? sideOf(spots) : 'right' })

  // Left as laid: off any storyline, pinned, holding effect cards (their
  // chain reads left to right off the picture), or holding a deck of its
  // own (its cards hang off it, not off this front card).
  const link = members.length && !anchor.pin ? onLine : null
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

/** The front card of the deck that `ids` are (or close into), first. Off
 *  every storyline: the first, as always. On one: an existing deck's own
 *  front card when `ids` hold all of it, so a stack ↔ fan or the menu's
 *  Stack never hands the deck to another card (it would jump to that card's
 *  place); closing open cards, the card that fronted them when they were
 *  opened (deckLastFront), else the card holding checked-out cards' slots,
 *  else the linked card nearest its dot, so the deck stays on its line and
 *  closes onto the same card every time. */
export function frontFirst(groups: ProjectGroup[], ids: string[], nodes: Record<string, FreeNodeData>,
                           boards: Record<string, BoardData>): string[] {
  // Off every storyline: the first, as always.
  const lines = linkedLines(nodes)
  if (!lines.length || !ids.some(id => linkOf(lines, id))) return ids
  const set = new Set(ids)
  const byId = new Map(groups.map(g => [g.id, g]))
  const kidsOf = (id: string) => groups.filter(o => o.id !== id && o.deckAnchorId === id && isClosed(o))
  const first = (id: string) => [id, ...ids.filter(x => x !== id)]
  for (const id of ids) {
    const g = byId.get(id)
    if (!g || !isClosed(g) || (g.deckAnchorId && g.deckAnchorId !== g.id)) continue
    const kids = kidsOf(id)
    if (kids.length && kids.every(o => set.has(o.id))) return first(id)
  }
  // A card hidden in a deck, or one fronting a deck inside the cards (its
  // cards left out of `ids`), fronts only itself.
  const eligible = (id: string) => {
    const g = byId.get(id)
    return !!g && !(isClosed(g) && g.deckAnchorId && g.deckAnchorId !== g.id) && !kidsOf(id).some(o => !set.has(o.id))
  }
  const linked = ids.flatMap(id => {
    const l = eligible(id) ? linkOf(lines, id) : null
    if (!l) return []
    const g = byId.get(id)!, b = boundsOf(g, boards)
    const c = b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : { x: g.originX, y: g.originY }
    return [{ id, d: Math.hypot(c.x - l.x, c.y - l.y) }]
  })
  if (!linked.length) return ids
  // The card that fronted (some of) these same cards when they opened.
  const fronts = ids.filter(id => eligible(id) && byId.get(id)?.deckLastFront === id
    && ids.some(o => o !== id && byId.get(o)?.deckLastFront === id))
  if (fronts.length === 1) return first(fronts[0])
  const holder = ids.find(id => eligible(id) && byId.get(id)?.ghostSlots?.length)
  if (holder) return first(holder)
  return first(linked.reduce((a, b) => (b.d < a.d ? b : a)).id)
}

/** The front card of the deck `ids` hold, for opening it (null: none). */
export function frontOf(groups: ProjectGroup[], ids: string[]): ProjectGroup | null {
  const set = new Set(ids)
  for (const id of ids) {
    const g = groups.find(o => o.id === id)
    if (!g || !isClosed(g) || (g.deckAnchorId && g.deckAnchorId !== g.id)) continue
    if (groups.some(o => o.id !== id && o.deckAnchorId === id && isClosed(o) && set.has(o.id))) return g
  }
  // An open card the closed ones still hang off (a deck kept from an older
  // save, or a deck's own deck once that has opened), as useCardDecks reads it.
  for (const id of ids) {
    const g = groups.find(o => o.id === id)
    if (g && isClosed(g) && g.deckAnchorId && g.deckAnchorId !== g.id && set.has(g.deckAnchorId))
      return groups.find(o => o.id === g.deckAnchorId) ?? null
  }
  return null
}

/** A closed deck's cards in the order they lay out from its front card,
 *  nearest first: left to right and top down. On a storyline (`onLine`),
 *  right to left for a deck whose cards all lie left of it and bottom up
 *  for one whose cards all lie above it (opened away from the line). */
export function byLay<T extends { deckOffsetX?: number; deckOffsetY?: number }>(cards: T[], onLine = false): T[] {
  const k = onLine && lyingLeft(cards) ? -1 : 1, j = onLine && lyingUp(cards) ? -1 : 1
  return [...cards].sort((a, b) => k * ((a.deckOffsetX ?? 0) - (b.deckOffsetX ?? 0)) || j * ((a.deckOffsetY ?? 0) - (b.deckOffsetY ?? 0)))
}
