// Card details and card types (Brian 2026-11-04). Flip a card over and its
// back is its DETAILS side: name / value rows, e.g. a character's licence
// or a building's floors. A card's TYPE gives it a starting set of
// details and a colour. A value can point at another card, or at one of
// that card's details, and shows it live; anything can read a card's
// details by name (detailText).

import type { ProjectGroup } from '../store/boardsStore'

/** Where a detail's value comes from when it is linked: another card (its
 *  name), or one detail on it (that detail's value, live). */
export interface DetailLink {
  card: string
  detail?: string
}

/** One row on a card's details side. */
export interface CardDetail {
  id: string
  name: string
  value: string
  link?: DetailLink
}

export type CardType = 'element' | 'character' | 'faction' | 'location' | 'prop' | 'audio' | 'scene'

export interface CardTypeInfo {
  label: string
  /** The colour cards of this type take, unless coloured themselves. */
  color: string
  /** The details a card of this type starts with. */
  details: string[]
}

/** In the order the picker lists them. Element: a card that is not (yet)
 *  any of the others, a loose bit of context. Every card without a type
 *  is one. */
export const CARD_TYPES: Record<CardType, CardTypeInfo> = {
  element:   { label: 'Element',   color: '#5b8dd9', details: [] },
  character: { label: 'Character', color: '#c8463f', details: ['ID', 'Licence', 'Age', 'Height', 'Role', 'Stats'] },
  faction:   { label: 'Faction',   color: '#7d55c7', details: ['Territory', 'Allies', 'Rivals'] },
  location:  { label: 'Location',  color: '#23897e', details: ['Place', 'Building', 'Use', 'Floors', 'Basement'] },
  prop:      { label: 'Prop',      color: '#c97a2c', details: ['Kind', 'Ammo', 'Capacity', 'Owner'] },
  audio:     { label: 'Audio',     color: '#b0478a', details: ['Artist', 'Length', 'Tempo', 'Key', 'Mood'] },
  scene:     { label: 'Scene',     color: '#3f6fd0', details: ['Act', 'Location', 'Time of day', 'Mood'] },
}
export const CARD_TYPE_ORDER = Object.keys(CARD_TYPES) as CardType[]

export function cardTypeOf(g: Pick<ProjectGroup, 'cardType'> | undefined): CardType {
  return g?.cardType && CARD_TYPES[g.cardType] ? g.cardType : 'element'
}

/** A type's colour: the one chosen for it, else its own. */
export function typeColor(type: CardType, chosen?: Partial<Record<CardType, string>>): string {
  return chosen?.[type] ?? CARD_TYPES[type].color
}

let seq = 0
export function newDetailId(): string {
  seq = (seq + 1) % 1e6
  return `d${Date.now().toString(36)}${seq.toString(36)}`
}

/** `details` with the type's starting rows added, the ones it does not
 *  already have (by name, any case). Nothing is removed or reordered. */
export function withTypeDetails(details: CardDetail[] | undefined, type: CardType): CardDetail[] {
  const have = new Set((details ?? []).map(d => d.name.trim().toLowerCase()))
  const add = CARD_TYPES[type].details
    .filter(n => !have.has(n.toLowerCase()))
    .map(name => ({ id: newDetailId(), name, value: '' }))
  return [...(details ?? []), ...add]
}

/** What a detail shows: its own text, or, linked, the card it points at
 *  (its name) or that card's detail (its value, followed through links). */
export function detailShown(groups: ProjectGroup[], d: CardDetail, seen = new Set<string>()): { text: string; card?: ProjectGroup; missing?: boolean } {
  if (!d.link) return { text: d.value }
  const card = groups.find(g => g.id === d.link!.card)
  if (!card) return { text: d.value, missing: true }
  if (!d.link.detail) return { text: card.name, card }
  const key = `${card.id}:${d.link.detail}`
  const target = card.details?.find(x => x.id === d.link!.detail)
  if (!target || seen.has(key)) return { text: card.name, card, missing: !target }
  seen.add(key)
  return { ...detailShown(groups, target, seen), card }
}

/** A card's detail, read by name (any case): what it shows, links
 *  followed. For anything that wants to read a card's details. */
export function detailText(groups: ProjectGroup[], cardId: string, name: string): string | undefined {
  const card = groups.find(g => g.id === cardId)
  const d = card?.details?.find(x => x.name.trim().toLowerCase() === name.trim().toLowerCase())
  return d ? detailShown(groups, d).text : undefined
}

/** A faction's members: the cards it links to (a card's link "+" let go
 *  on the faction), each with its rank there (1 = the top). Ranked first,
 *  by rank, then the unranked, in the order they joined. */
export function factionMembers(groups: ProjectGroup[], faction: ProjectGroup): { card: ProjectGroup; rank?: number }[] {
  const ids = faction.linkedGroupIds ?? []
  const list = ids.flatMap((id, i) => {
    const card = groups.find(g => g.id === id)
    return card ? [{ card, rank: faction.ranks?.[id], i }] : []
  })
  list.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.i - b.i)
  return list.map(({ card, rank }) => ({ card, rank }))
}

/** The factions a card is a member of, and its rank in each. */
export function factionsOf(groups: ProjectGroup[], cardId: string): { faction: ProjectGroup; rank?: number }[] {
  return groups
    .filter(g => g.cardType === 'faction' && (g.linkedGroupIds ?? []).includes(cardId))
    .map(faction => ({ faction, rank: faction.ranks?.[cardId] }))
}
