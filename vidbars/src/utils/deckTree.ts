// deckTree.ts — the ONE place that answers questions about closed decks
// (Brian 2026-11-24, after the look back over the week: a deck was "eleven
// tags per card, where you think of a folder", and 51 files each read the
// tags for themselves, a little differently).
//
// A closed deck is a folder: a front card with cards put away under it,
// any of which may itself be the front of a closed deck (Brian 2026-11-23:
// "think of the system like folders"). Today that is stored as tags on
// each card (ProjectGroup.deckState, deckAnchorId and the rest); it is
// about to be stored as a folder. Code that asks its questions HERE does
// not care which, so the change can be made in one file.
//
// An OPEN deck is not stored and is not here: it is whichever cards touch
// (hooks/useCardDecks), as he asked (2026-11-19: decks are "completely
// built around physical contact").
//
// Types only from the store: the store itself may ask here.

import type { ProjectGroup } from '../store/boardsStore'

/** Is this card closed up (a closed or fanned deck's front, or a card put
 *  away in one)? */
export const isShut = (g: ProjectGroup | undefined): boolean => !!g && !!g.deckState && g.deckState !== 'open'

/** Is this card put away in a closed or fanned deck (not its front, so not
 *  seen on the canvas)? */
export const isPutAway = (g: ProjectGroup | undefined): boolean => isShut(g) && !!g!.deckAnchorId && g!.deckAnchorId !== g!.id

/** The cards put away directly under front card `frontId`, not the front
 *  card itself. One of them may front a closed deck of its own: that
 *  deck's cards are under IT (see allUnder). */
export function putAwayUnder(frontId: string, groups: ProjectGroup[]): ProjectGroup[] {
  return groups.filter(g => g.id !== frontId && g.deckAnchorId === frontId && isShut(g))
}

/** Every card under front card `frontId`, at every depth (a deck of decks),
 *  not the front card itself. */
export function allUnder(frontId: string, groups: ProjectGroup[]): ProjectGroup[] {
  const out: ProjectGroup[] = [], seen = new Set([frontId])
  for (let from = [frontId]; from.length;) {
    const next: string[] = []
    for (const id of from) for (const g of putAwayUnder(id, groups)) {
      if (seen.has(g.id)) continue
      seen.add(g.id); out.push(g); next.push(g.id)
    }
    from = next
  }
  return out
}

/** The front card of the outermost closed deck card `g` is in: the card
 *  seen on the canvas for it. `g` itself when it is not put away. */
export function shownFront(g: ProjectGroup, groups: ProjectGroup[]): ProjectGroup {
  let at = g
  for (let i = 0; i < 32 && isPutAway(at); i++) {
    const up = groups.find(x => x.id === at.deckAnchorId)
    if (!up) break
    at = up
  }
  return at
}
