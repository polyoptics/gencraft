// Card on card (Brian 2026-11-12): a card whose link "+" was dropped on
// another is TUCKED under it. The drop target owns the link
// (LinkDragOverlay), so the cards tucked under a card are the ones it
// links to. They are listed in its tray (components/Linking/CardTray), the
// one thing that hangs tucked under a card's bottom edge; the card that is
// tucked names the cards it is under on its chips (PrimaryChipRail).
//
// Factions, families and notes tuck nothing: their links are members.
// A scene card also holds the cards linked to its sections (a link "+" let
// go on a section: utils/sceneCard links).
// Nothing here is stored.

import type { ProjectGroup } from '../store/boardsStore'
import { cardTypeOf } from './cardTypes'
import { sceneLinks } from './sceneCard'

const MEMBERSHIP = new Set(['faction', 'family', 'note'])

/** Does this card tuck the cards it links to under it? All but the ones
 *  whose links are their members. */
export function tucks(host: ProjectGroup | undefined): boolean {
  return !!host && !MEMBERSHIP.has(cardTypeOf(host))
}

/** What is worked out once for a list of cards and asked of it many times:
 *  each card by id, and the cards each one is tucked under. Every card on
 *  the canvas asks (its chips, its tray's count), on every change to any
 *  card and on every frame of a drag, and each used to walk every card and
 *  every scene card's sections to answer: with a full canvas that was most
 *  of a frame. The list is replaced, never changed in place, when a card
 *  changes (store/boardsStore), so it is the key. */
interface LinkIndex { byId: Map<string, ProjectGroup>; holders: Map<string, string[]> }
const indexes = new WeakMap<ProjectGroup[], LinkIndex>()
const NONE: string[] = []

export function linkIndex(groups: ProjectGroup[]): LinkIndex {
  let ix = indexes.get(groups)
  if (ix) return ix
  const byId = new Map<string, ProjectGroup>()
  const holders = new Map<string, string[]>()
  for (const g of groups) {
    if (!byId.has(g.id)) byId.set(g.id, g)
    if (!tucks(g)) continue
    const links = g.scene ? new Set([...(g.linkedGroupIds ?? []), ...sceneLinks(g.scene)]) : new Set(g.linkedGroupIds ?? [])
    for (const id of links) {
      if (id === g.id) continue
      const at = holders.get(id)
      if (at) at.push(g.id); else holders.set(id, [g.id])
    }
  }
  ix = { byId, holders }
  indexes.set(groups, ix)
  return ix
}

/** The cards `card` is tucked under (Brian 2026-11-13: "the effect has the
 *  list of its members under it"): its chips name them. */
export function holderIds(card: ProjectGroup | undefined, groups: ProjectGroup[]): string[] {
  if (!card) return []
  return [...(linkIndex(groups).holders.get(card.id) ?? NONE)]
}

/** Every card linked with `card`: the ones it links to, and, where it
 *  tucks, the ones it is tucked under. */
export function shownIds(card: ProjectGroup | undefined, groups: ProjectGroup[]): string[] {
  if (!card) return []
  const byId = linkIndex(groups).byId
  const inScene = card.scene ? sceneLinks(card.scene).filter(id => byId.has(id)) : []
  const own = [...new Set([...(card.linkedGroupIds ?? []), ...inScene])].filter(id => id !== card.id)
  return tucks(card) ? [...new Set([...own, ...holderIds(card, groups)])] : own
}
