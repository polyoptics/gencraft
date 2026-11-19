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
 *  (Brian 2026-11-19). Closed, it is the kept cards closed together. Open,
 *  it is the kept cards that touch one another (`touch`), through kept
 *  cards only: the largest such group of two or more (of two as large, the
 *  one with the card it was kept under, else the leftmost). Its front is
 *  the card it was kept under, or with that one away, its leftmost. A kept
 *  card pulled off it is out of it until it touches it again. */
export function keptDeck(k: string, groups: ProjectGroup[], touch: Touch): ProjectGroup[] | null {
  const marked = groups.filter(g => g.deckKeep === k && !g.pin)
  if (marked.length < 2) return null
  const lead = (c: ProjectGroup[]) => {
    const f = c.find(g => g.id === k) ?? c.reduce((a, b) => (b.originX < a.originX ? b : a))
    return [f, ...c.filter(g => g !== f)]
  }
  const closed = marked.filter(shut)
  if (closed.length >= 2) return [closed.find(g => !g.deckAnchorId || g.deckAnchorId === g.id || !closed.some(o => o.id === g.deckAnchorId)) ?? closed[0], ...closed].filter((g, i, a) => a.indexOf(g) === i)
  const open = marked.filter(g => !shut(g))
  const seen = new Set<ProjectGroup>()
  let best: ProjectGroup[] | null = null
  const left = (c: ProjectGroup[]) => Math.min(...c.map(g => g.originX))
  for (const g of open) {
    if (seen.has(g)) continue
    const c = [g]
    seen.add(g)
    for (let i = 0; i < c.length; i++) for (const o of open) if (!seen.has(o) && touch(c[i], o)) { c.push(o); seen.add(o) }
    if (c.length < 2) continue
    const has = (x: ProjectGroup[]) => x.some(o => o.id === k)
    if (!best || c.length > best.length || (c.length === best.length && (has(c) || (!has(best) && left(c) < left(best))))) best = c
  }
  return best && lead(best)
}

/** Card `g` fronts a kept deck among the cards `row` (an open row): that
 *  deck's cards, when the row holds others too (null otherwise). */
export function keptIn(g: ProjectGroup, row: string[], groups: ProjectGroup[], touch: Touch): string[] | null {
  if (!g.deckKeep) return null
  const deck = keptDeck(g.deckKeep, groups, touch)
  if (!deck || deck[0].id !== g.id || deck.length >= row.length) return null
  const mine = new Set(deck.map(o => o.id))
  const here = row.filter(id => mine.has(id))
  return here.length >= 2 ? here : null
}
