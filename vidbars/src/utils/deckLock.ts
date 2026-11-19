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

/** Card `g` fronts a kept deck among the cards `row` (an open row): that
 *  deck's cards there, when the row holds others too (null otherwise). Its
 *  front is the card it was kept under, or with that one elsewhere, its
 *  leftmost here. */
export function keptIn(g: ProjectGroup, row: string[], groups: ProjectGroup[]): string[] | null {
  const k = g.deckKeep
  if (!k) return null
  const byId = new Map(groups.map(o => [o.id, o]))
  const mine = row.filter(id => byId.get(id)?.deckKeep === k)
  if (mine.length < 2 || mine.length >= row.length) return null
  const front = mine.includes(k) ? k : [...mine].sort((a, b) => byId.get(a)!.originX - byId.get(b)!.originX)[0]
  return front === g.id ? mine : null
}
