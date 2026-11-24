// A row of touching cards has a primary card (Brian 2026-11-05). The row's
// own controls sit on it (its outline, dragging the row, double-click to
// close it), and the row closes onto it: the deck forms where it is, and it
// never moves. By default it is the leftmost card. Make primary on a card's
// menu makes it the row's primary; a deck's front card is made primary when
// the deck opens, so the open row keeps it however its cards lie (to its
// left, above it, all around it). The row's cards each remember it
// (ProjectGroup.deckLastFront), and it holds only while it is in a row with
// another card that remembers it: pull it out of its row and the row goes
// back to its leftmost card, and it takes over no other row it touches.
// With two in one row, the leftmost of them.

import type { ProjectGroup } from '../store/boardsStore'
import { putAwayUnder, isShut } from './deckTree'

/** Each card's row of touching cards as the canvas last drew it, its
 *  primary card first (CardLayer keeps it; rows with controls only). */
const rows = new Map<string, string[]>()
let rowsVersion = 0
export function setRows(clusters: string[][]) {
  rows.clear()
  for (const c of clusters) for (const id of c) rows.set(id, c)
  rowsVersion++
  for (const f of rowsListeners) f()
}
const rowsListeners = new Set<() => void>()
/** Called whenever the rows are drawn anew (for useSyncExternalStore with
 *  rowsSeen). */
export function onRows(f: () => void): () => void {
  rowsListeners.add(f)
  return () => { rowsListeners.delete(f) }
}
/** Card `id`'s row as drawn, its primary card first (none when it is in none). */
export const rowOf = (id: string): string[] | undefined => rows.get(id)
/** Changes whenever the rows are drawn anew, for a cache. */
export const rowsSeen = () => rowsVersion
/** The open deck card `id` is the primary card of: the rest of its row
 *  (none when it is no row's primary). They go where it goes, as a closed
 *  deck's cards do: with its storyline dot, and standing up with its
 *  storyline. Pulled out of the row, a card no longer comes along. */
export function openDeckOf(id: string): string[] {
  const r = rows.get(id)
  return r && r[0] === id ? r.slice(1) : []
}

/** (utils/deckTree: the one test for a card closed up.) */
const isClosed = isShut

/** `ids` (a row, or a deck's cards, leftmost first) with the card they
 *  close onto first: an existing deck's own front card when `ids` hold all
 *  of it, so a stack ↔ fan or the menu's Stack never hands the deck to
 *  another card (it would jump to that card's place); else the row's
 *  primary card; else the first, the leftmost. */
export function primaryFirst(groups: ProjectGroup[], ids: string[]): string[] {
  if (ids.length < 2) return ids
  const set = new Set(ids)
  const byId = new Map(groups.map(g => [g.id, g]))
  const kidsOf = (id: string) => putAwayUnder(id, groups)
  const first = (id: string) => (id === ids[0] ? ids : [id, ...ids.filter(x => x !== id)])
  for (const id of ids) {
    const g = byId.get(id)
    if (!g || !isClosed(g) || (g.deckAnchorId && g.deckAnchorId !== g.id)) continue
    const kids = kidsOf(id)
    if (kids.length && kids.every(o => set.has(o.id))) return first(id)
  }
  // Remembered by itself and by another card of the row. A card hidden in a
  // deck is never the row's primary. A closed deck of its own inside the
  // row can be (Brian 2026-11-23, a deck of decks: "my primary card is a
  // deck"): the deck of decks closes onto it again, wherever it stands.
  const primary = ids.find(id => {
    const g = byId.get(id)
    return !!g && g.deckLastFront === id && ids.some(o => o !== id && byId.get(o)?.deckLastFront === id)
      && !(isClosed(g) && g.deckAnchorId && g.deckAnchorId !== g.id)
  })
  return primary ? first(primary) : ids
}

/** The front card of the deck `ids` hold, for opening it (null: none). */
export function deckFront(groups: ProjectGroup[], ids: string[]): ProjectGroup | null {
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
