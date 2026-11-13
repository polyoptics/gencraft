// Card on card (Brian 2026-11-12): a card whose link "+" was dropped on
// another is TUCKED under it. The drop target owns the link
// (LinkDragOverlay), so the cards tucked under a card are the ones it
// links to. They are listed in its tray (components/Linking/CardTray), the
// one thing that hangs tucked under a card's bottom edge; the card that is
// tucked names the cards it is under on its chips (PrimaryChipRail).
//
// Factions, families and notes tuck nothing: their links are members.
// Nothing here is stored.

import type { ProjectGroup } from '../store/boardsStore'
import { cardTypeOf } from './cardTypes'

const MEMBERSHIP = new Set(['faction', 'family', 'note'])

/** Does this card tuck the cards it links to under it? All but the ones
 *  whose links are their members. */
export function tucks(host: ProjectGroup | undefined): boolean {
  return !!host && !MEMBERSHIP.has(cardTypeOf(host))
}

/** The cards `card` is tucked under (Brian 2026-11-13: "the effect has the
 *  list of its members under it"): its chips name them. */
export function holderIds(card: ProjectGroup | undefined, groups: ProjectGroup[]): string[] {
  if (!card) return []
  return groups.filter(g => g.id !== card.id && tucks(g) && (g.linkedGroupIds ?? []).includes(card.id)).map(g => g.id)
}

/** Every card linked with `card`: the ones it links to, and, where it
 *  tucks, the ones it is tucked under. */
export function shownIds(card: ProjectGroup | undefined, groups: ProjectGroup[]): string[] {
  if (!card) return []
  const own = (card.linkedGroupIds ?? []).filter(id => id !== card.id)
  return tucks(card) ? [...new Set([...own, ...holderIds(card, groups)])] : own
}
