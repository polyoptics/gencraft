// Locking a storyline's chains (Brian 2026-11-05): the decks and cards on
// a base dot's chain, and locking them all (utils/deckLock). The base
// dots' decks and lock buttons (components/Canvas/StorylineLayer) and a
// chart shown for the first time (utils/chartCard) use these.

import type { ProjectGroup } from '../store/boardsStore'
import { useBoardsStore } from '../store/boardsStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { expandWithNestedMembers, isHiddenDeckMember } from '../hooks/useCardDecks'
import { rowOf } from './primaryCard'
import { downstream } from './storyline'
import { putAwayUnder } from './deckTree'

/** The card `c` is shown as: itself, or, hidden in a closed deck, that
 *  deck's front card. */
export function shownAs(c: string, byId: Map<string, ProjectGroup>): string {
  let id = c
  for (let k = 0; k < 32; k++) {
    const g = byId.get(id)
    if (!g || !isHiddenDeckMember(g) || !byId.has(g.deckAnchorId!)) break
    id = g.deckAnchorId!
  }
  return id
}

const isClosedDeck = (g: ProjectGroup | undefined) => !!g && !!g.deckState && g.deckState !== 'open'

/** The decks on base dot `dotId`'s chain (the dot and every dot hanging off
 *  it, utils/storyline downstream): each closed deck a linked card is in or
 *  fronts (its front card first), and each open row of touching cards a
 *  linked card is in, unless the row holds a card linked to a dot off the
 *  chain (that one is the other chain's to close). */
export function chainDecks(nodeId: string, dotId: string): { closed: string[][]; open: string[][] } {
  const nodes = useFreeNodeStore.getState().nodes
  const d = nodes[nodeId]?.storyline
  if (!d?.dots) return { closed: [], open: [] }
  const chain = downstream(d, dotId)
  const mine = new Set<string>(), elsewhere = new Set<string>()
  for (const [nid, n] of Object.entries(nodes)) for (const p of n.storyline?.dots ?? []) for (const c of p.cards ?? []) {
    if (nid === nodeId && chain.has(p.id)) mine.add(c)
    else elsewhere.add(c)
  }
  const groups = useBoardsStore.getState().groups
  const byId = new Map(groups.map(g => [g.id, g]))
  const closed: string[][] = [], open: string[][] = []
  const seen = new Set<string>()
  for (const c of mine) {
    const f = shownAs(c, byId)
    const front = byId.get(f)
    if (!front) continue
    if (isClosedDeck(front)) {
      if (seen.has(f)) continue
      seen.add(f)
      const kids = putAwayUnder(f, groups).map(g => g.id)
      if (kids.length) closed.push([f, ...kids])
      continue
    }
    const row = rowOf(f)
    if (!row || row.length < 2 || seen.has(row[0])) continue
    seen.add(row[0])
    if (!row.some(m => elsewhere.has(m) && !mine.has(m))) open.push(row)
  }
  return { closed, open }
}

/** Every card on base dot `dotId`'s chain, as the locks they take
 *  (utils/deckLock): each deck (closed, or an open row) under its front or
 *  primary card, with the cards hidden in it; a card in no deck alone. */
export function chainLocks(nodeId: string, dotId: string): Map<string, string[]> {
  const nodes = useFreeNodeStore.getState().nodes
  const d = nodes[nodeId]?.storyline
  const out = new Map<string, string[]>()
  if (!d?.dots) return out
  const chain = downstream(d, dotId)
  const groups = useBoardsStore.getState().groups
  const byId = new Map(groups.map(g => [g.id, g]))
  const taken = new Set<string>()
  const { closed, open } = chainDecks(nodeId, dotId)
  for (const ids of [...closed, ...open]) {
    const all = expandWithNestedMembers(ids, groups).filter(id => !taken.has(id))
    all.forEach(id => taken.add(id))
    if (all.length) out.set(ids[0], all)
  }
  for (const p of d.dots) if (chain.has(p.id)) for (const c of p.cards ?? []) {
    const f = shownAs(c, byId)
    if (!byId.has(f) || taken.has(f)) continue
    const row = rowOf(f)
    if (row && row.length > 1) continue // a row the chain does not own
    taken.add(f)
    out.set(f, expandWithNestedMembers([f], groups))
  }
  return out
}

/** Lock every deck and card on every chain of storyline `nodeId` (a chart
 *  shown for the first time starts locked). */
export function lockChains(nodeId: string): void {
  const d = useFreeNodeStore.getState().nodes[nodeId]?.storyline
  const bs = useBoardsStore.getState()
  for (const b of d?.base ?? []) for (const [front, all] of chainLocks(nodeId, b)) {
    if (all.length > 1) bs.setRowPrimary(front, all)
    bs.setDeckLock(front, all)
  }
}
