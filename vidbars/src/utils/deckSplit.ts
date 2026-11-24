// NOT USED since 2026-11-19: a row closes as one deck (boardsStore
// setDeckState; Brian: four cards in a line kept closing with a deck
// inside). Kept for the record of what the tags were read for.
//
// deckSplit.ts — an open deck stays that deck (Brian 2026-11-10). While a
// deck is open its cards carry its tag (ProjectGroup.deckHome, the id of
// its front card; utils/deckUnder keeps it: one tag a card, never a
// history). A row closing onto its primary card takes the other open decks
// in it as decks of their own, not as loose cards: each is closed first,
// onto its own front, and goes in as a deck inside the deck.

import type { ProjectGroup } from '../store/boardsStore'
import { primaryFirst } from './primaryCard'
import { isShut } from './deckTree'

/** (utils/deckTree: the one test for a card closed up.) */
const isClosed = isShut

/** Row `ids` about to close: the open decks in it other than its primary
 *  card's own (each its front first), and the row without their other
 *  cards. */
export function splitOpenDecks(groups: ProjectGroup[], ids: string[]): { subs: string[][]; rest: string[] } {
  const byId = new Map(groups.map(g => [g.id, g]))
  const main = byId.get(primaryFirst(groups, ids)[0])?.deckHome
  const tags = new Map<string, ProjectGroup[]>()
  for (const id of ids) {
    const g = byId.get(id)
    if (!g || isClosed(g) || !g.deckHome || g.deckHome === main) continue
    tags.set(g.deckHome, [...(tags.get(g.deckHome) ?? []), g])
  }
  const subs = [...tags].filter(([, m]) => m.length >= 2).map(([t, m]) => {
    // Onto its own front card; that one gone from it, its leftmost.
    const front = m.find(g => g.id === t) ?? [...m].sort((a, b) => a.originX - b.originX)[0]
    return [front.id, ...m.filter(g => g !== front).map(g => g.id)]
  })
  const gone = new Set(subs.flatMap(sub => sub.slice(1)))
  return { subs, rest: ids.filter(id => !gone.has(id)) }
}
