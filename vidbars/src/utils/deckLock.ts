// A locked deck (Brian 2026-11-05): once he likes a deck he can lock it.
// Locking keeps the cards it has then, by card, not by what touches: it
// picks up no card it lies on or that is dropped onto it, and a press on
// any of its cards moves the whole deck as one thing, leaving the cards
// under it where they are. Unlocked, it goes back to touching rules.
// Every card of the deck carries the lock (ProjectGroup.deckLock, the id
// of the card that was primary when it was locked); the lock counts only
// while two or more cards carry it, or a card carries its own.

import type { ProjectGroup } from '../store/boardsStore'

/** The locks that hold: carried by two or more cards, or a card's lock of
 *  its own (a single card locked with its chain on a storyline: it joins
 *  nothing it touches). */
export function liveLocks(groups: ProjectGroup[]): Set<string> {
  const n = new Map<string, number>()
  const own = new Set<string>()
  for (const g of groups) if (g.deckLock) {
    n.set(g.deckLock, (n.get(g.deckLock) ?? 0) + 1)
    if (g.deckLock === g.id) own.add(g.id)
  }
  return new Set([...n].filter(([k, c]) => c >= 2 || own.has(k)).map(([k]) => k))
}

/** The lock card `g` is held by (undefined: none). */
export function lockOf(g: ProjectGroup | undefined, live: Set<string>): string | undefined {
  return g?.deckLock && live.has(g.deckLock) ? g.deckLock : undefined
}

/** `ids` with every card of every locked deck one of them is in. */
export function withLockMates(ids: string[], groups: ProjectGroup[]): string[] {
  const live = liveLocks(groups)
  if (!live.size) return ids
  const byId = new Map(groups.map(g => [g.id, g]))
  const locks = new Set(ids.map(id => lockOf(byId.get(id), live)).filter(Boolean) as string[])
  if (!locks.size) return ids
  const out = new Set(ids)
  for (const g of groups) if (g.deckLock && locks.has(g.deckLock)) out.add(g.id)
  return [...out]
}

// ── The lock's first stage: a kept deck (Brian 2026-11-19) ──
// One press of the lock keeps a deck: its cards are remembered as that
// deck (ProjectGroup.deckKeep) until it is let go, however often it, or a
// bigger row round it, is opened and closed. Unlike a locked deck it still
// joins rows by touching and is moved a card at a time; like one, it picks
// up no card. A second press locks it, a third lets it go.

/** The kept deck card `g` is in (undefined: none): two or more cards carry it. */
export function keepOf(g: ProjectGroup | undefined, groups: ProjectGroup[]): string | undefined {
  const k = g?.deckKeep
  return k && groups.some(o => o.id !== g!.id && o.deckKeep === k) ? k : undefined
}

type Touch = (a: ProjectGroup, b: ProjectGroup) => boolean
const shut = (g: ProjectGroup) => !!g.deckState && g.deckState !== 'open'

/** The kept deck `k` as it stands, its front card first (null: none).
 *  Contact decides, as for every deck, and no card of it is special
 *  (Brian 2026-11-19). A closed deck of its cards counts as one thing,
 *  standing where its front card stands, so a deck closed inside the open
 *  deck is in it like any card (Brian 2026-11-20, "I can't lock this deck
 *  ... It has to do with the sub deck"). Closed whole, it is the kept
 *  cards closed together. Open, it is the kept things that touch one
 *  another (`touch`), through kept things only: the largest such group of
 *  two or more cards (of two as large, the one with the card it was kept
 *  under, else the leftmost). Its front is the card it was kept under, or
 *  with that one away, its leftmost. A kept card pulled off it is out of
 *  it until it touches it again. */
export function keptDeck(k: string, groups: ProjectGroup[], touch: Touch): ProjectGroup[] | null {
  const marked = groups.filter(g => g.deckKeep === k && !g.pin)
  if (marked.length < 2) return null
  const byId = new Map(groups.map(g => [g.id, g]))
  // The card a closed card is seen as: the front of the closed deck it is in.
  const top = (g: ProjectGroup): ProjectGroup => {
    let t = g
    for (let i = 0; i < 32 && shut(t); i++) {
      const a = t.deckAnchorId && t.deckAnchorId !== t.id ? byId.get(t.deckAnchorId) : undefined
      if (!a || !shut(a)) break
      t = a
    }
    return t
  }
  // Each thing on the canvas: an open card, or a closed deck's kept cards.
  const things = new Map<ProjectGroup, ProjectGroup[]>()
  for (const g of marked) {
    const t = top(g)
    const u = things.get(t)
    if (u) { if (g === t) u.unshift(g); else u.push(g) } else things.set(t, [g])
  }
  const tops = [...things.keys()]
  const seen = new Set<ProjectGroup>()
  let best: { tops: ProjectGroup[]; cards: ProjectGroup[] } | null = null
  const left = (c: ProjectGroup[]) => Math.min(...c.map(g => g.originX))
  const has = (c: ProjectGroup[]) => c.some(o => o.id === k)
  for (const t of tops) {
    if (seen.has(t)) continue
    const c = [t]
    seen.add(t)
    for (let i = 0; i < c.length; i++) for (const o of tops) if (!seen.has(o) && touch(c[i], o)) { c.push(o); seen.add(o) }
    const cards = c.flatMap(o => things.get(o)!)
    if (cards.length < 2) continue
    if (!best || cards.length > best.cards.length
      || (cards.length === best.cards.length && (has(c) || (!has(best.tops) && left(c) < left(best.tops))))) best = { tops: c, cards }
  }
  if (!best) return null
  // Its front: the card it was kept under where that one shows, else its leftmost.
  const f = best.tops.find(g => g.id === k) ?? best.tops.reduce((a, b) => (b.originX < a.originX ? b : a))
  const first = things.get(f)!
  return [...first, ...best.cards.filter(g => !first.includes(g))]
}

/** Card `g` fronts a kept deck among the cards `row` (an open row): that
 *  deck's cards, when the row holds others too (null otherwise). */
export function keptIn(g: ProjectGroup, row: string[], groups: ProjectGroup[], touch: Touch): string[] | null {
  if (!g.deckKeep) return null
  const deck = keptDeck(g.deckKeep, groups, touch)
  if (!deck || deck[0].id !== g.id) return null
  const mine = new Set(deck.map(o => o.id))
  const here = row.filter(id => mine.has(id))
  return here.length >= 2 && here.length < row.length ? here : null
}
