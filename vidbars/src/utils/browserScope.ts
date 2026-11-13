// browserScope.ts — what a Card Browser browses when cards are docked on it
// (Brian 2026-11-09: "If I docked a card that has card information in it,
// like a faction ... the card browser should show the contents of the card.
// Same as if I dock a deck, it should browse that deck.")
//
// Worked out from where things are, never stored, as every dock is: the
// cards touching the browser, and the cards touching those (utils/filmShots
// dockedCards). Pull them away and the browser shows everything again.
//  - A deck (two or more cards) docked: the browser shows that deck's cards.
//  - One card docked: the cards it holds, when it holds any (a faction's or
//    family's members, a baked chart's cards, the cards a scene card's
//    divisions came from); a card that holds none shows just itself.
// A linked card (a chart's copy) holds what its master holds.

import type { BoardData, ProjectGroup } from '../store/boardsStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { dockedCards } from './filmShots'
import { leaves } from './sceneCard'
import { hasMembers } from './cardTypes'
import { shownIds } from './tucked'

/** The cards a card holds, by id, in its own order (none: []). */
export function cardContents(card: ProjectGroup, groups: ProjectGroup[]): string[] {
  const byId = new Map(groups.map(g => [g.id, g]))
  const g = (card.linkOf && byId.get(card.linkOf)) || card
  const out: string[] = []
  const add = (id: string | undefined) => {
    if (id && id !== g.id && id !== card.id && byId.has(id) && !out.includes(id)) out.push(id)
  }
  if (hasMembers(g)) (g.linkedGroupIds ?? []).forEach(add)
  if (g.chart) for (const t of g.chart.tiers) t.cards.forEach(add)
  if (g.scene) for (const d of leaves(g.scene)) { add(d.card); (d.cards ?? []).forEach(add) }
  return out
}

export interface BrowserScope {
  /** The cards the browser shows, by id. */
  ids: Set<string>
  /** What is docked, for the browser to say so: the card's name, or the
   *  deck's front card's name and how many cards it has. */
  label: string
}

/** What the Card Browser `node` browses, or null when nothing is docked on
 *  it (it browses the whole project). Canvas only: a screen-pinned browser
 *  has left the cards' canvas. */
export function browserScope(node: FreeNodeData, groups: ProjectGroup[], boards: Record<string, BoardData>): BrowserScope | null {
  if (node.pin) return null
  const docked = dockedCards(node, groups, boards)
  if (docked.length === 0) return null
  if (docked.length === 1) {
    const one = docked[0]
    const held = cardContents(one, groups)
    return { ids: new Set(held.length ? held : [one.id]), label: one.name || 'Card' }
  }
  return { ids: new Set(docked.map(g => g.id)), label: `${docked[0].name || 'Deck'} (${docked.length})` }
}

/** What a card's tray lists (Brian 2026-11-13: "all the linked cards"):
 *  the cards it holds, as a browser it is docked on would show, and the
 *  cards linked with it either way (tucked under it, or it under them). */
export function trayIds(card: ProjectGroup | undefined, groups: ProjectGroup[]): string[] {
  if (!card) return []
  return [...new Set([...cardContents(card, groups), ...shownIds(card, groups)])].filter(id => id !== card.id)
}

/** The scope of the browser in card `cardId`'s tray. */
export function trayScope(cardId: string, groups: ProjectGroup[]): BrowserScope {
  const card = groups.find(g => g.id === cardId)
  return { ids: new Set(trayIds(card, groups)), label: card?.name || 'Card' }
}
