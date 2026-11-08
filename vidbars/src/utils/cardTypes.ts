// Card details and card types (Brian 2026-11-04). Flip a card over and its
// back is its DETAILS side: name / value rows, e.g. a character's licence
// or a building's floors. A card's TYPE gives it a starting set of
// details and a colour. A value can point at another card, or at one of
// that card's details, and shows it live; anything can read a card's
// details by name (detailText).

import type { ProjectGroup } from '../store/boardsStore'
import { groupRankOf } from './factionGroups'
import { chartRankOf, type ChartData } from './chartData'

/** Where a detail's value comes from when it is linked: another card (its
 *  name), or one detail on it (that detail's value, live). */
export interface DetailLink {
  card: string
  detail?: string
  /** Not the card's name or a detail: how many members it has (a faction
   *  or family), counted live (Brian 2026-11-06). */
  count?: 'members'
  /** Not the card's name or a detail: where card `rankOf` (the card whose
   *  back this is, its master) ranks on the chart baked into `card`, read
   *  live (Brian 2026-11-06: "add a chart attribute... pick lethality"). */
  rankOf?: string
}

/** One row on a card's details side. */
export interface CardDetail {
  id: string
  name: string
  value: string
  link?: DetailLink
  /** A long value folded to one line on the card's back. */
  collapsed?: boolean
}

export type CardType = 'element' | 'character' | 'faction' | 'family' | 'location' | 'prop' | 'audio' | 'scene' | 'prompt' | 'note' | 'state' | 'area3d'

export interface CardTypeInfo {
  label: string
  /** The colour cards of this type take, unless coloured themselves. */
  color: string
  /** The details a card of this type starts with. */
  details: string[]
}

/** In the order the picker lists them. Element: a card that is not (yet)
 *  any of the others, a loose bit of context. Every card without a type
 *  is one (and keeps whatever colour it had until made one on purpose).
 *  Colours: Brian's picks (character red, prop blue, faction purple),
 *  the rest each its own. */
export const CARD_TYPES: Record<CardType, CardTypeInfo> = {
  element:   { label: 'Element',   color: '#6b7280', details: [] },
  character: { label: 'Character', color: '#c8463f', details: ['ID', 'Licence', 'Body', 'Age', 'Height', 'Weight', 'Role', 'Stats'] },
  faction:   { label: 'Faction',   color: '#7d55c7', details: ['Territory', 'Allies', 'Rivals'] },
  family:    { label: 'Family',    color: '#9a6440', details: ['Home', 'Origin', 'Motto'] },
  location:  { label: 'Location',  color: '#23897e', details: ['Place', 'Building', 'Use', 'Floors', 'Basement'] },
  prop:      { label: 'Prop',      color: '#2f64c9', details: ['Kind', 'Ammo', 'Capacity', 'Owner'] },
  audio:     { label: 'Audio',     color: '#b0478a', details: ['Artist', 'Length', 'Tempo', 'Key', 'Mood'] },
  scene:     { label: 'Scene',     color: '#c9962a', details: ['Act', 'Location', 'Time of day', 'Mood'] },
  // A card of prompt words (2026-11-06): each detail a group of them, its
  // value the words, comma separated. The card Prompt Pad deals them out
  // as tags.
  prompt:    { label: 'Prompt',    color: '#1f9bb4', details: ['Subject', 'Framing', 'Lighting', 'Lens', 'Mood', 'Style'] },
  // A note (2026-11-07): what a pin on a model says, and where it stands.
  // Every pin on a model is backed by one (store/notesStore).
  note:      { label: 'Note',      color: '#e0a23a', details: ['Note', 'Status', 'Model'] },
  // A STATE card (2026-11-08): the states a thing can be in, each a master
  // deck, and one output deck showing the current one (utils/stateCard).
  state:     { label: 'State',     color: '#4f8f5a', details: [] },
  area3d:    { label: '3D area',   color: '#3d7fd9', details: [] },
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
  if (d.link.count === 'members') return { text: String(memberCount(groups, card)), card }
  if (d.link.rankOf) { const r = chartRank(card, d.link.rankOf); return { text: r ? String(r.rank) : '—', card } }
  if (!d.link.detail) return { text: card.name, card }
  const key = `${card.id}:${d.link.detail}`
  const target = card.details?.find(x => x.id === d.link!.detail)
  if (!target || seen.has(key)) return { text: card.name, card, missing: !target }
  seen.add(key)
  return { ...detailShown(groups, target, seen), card }
}

// ── Ranks on charts (Brian 2026-11-06) ──
// A card's back can have a detail that reads where it ranks on a chart
// (a storyline baked into a card, utils/chartData), e.g. LETHALITY 2.
// Its group on the chart counted from the top (1), as chartRankOf reads it
// and as the faction's own RANK row shows it; cards in one dot's group
// share a rank. Never typed. While the chart is out on the canvas it is
// read from the storyline as it stands (StorylineLayer hands the reader in,
// so this file needn't know about storylines).

let liveChart: (cardId: string) => ChartData | null = () => null
/** Set once by StorylineLayer: the chart of card `cardId` as it stands
 *  out on the canvas, or null when it is folded. */
export function setLiveChartReader(f: (cardId: string) => ChartData | null) { liveChart = f }

/** Where card `cardId` ranks on chart card `chartCard`: live while the
 *  chart is out, else as it was baked. */
export function chartRank(chartCard: ProjectGroup, cardId: string): { rank: number } | null {
  const chart = liveChart(chartCard.id) ?? chartCard.chart
  return chart ? chartRankOf(chart, cardId) : null
}

/** The cards that hold a chart, to rank on (masters only; a linked copy
 *  shows the same chart). */
export const chartCards = (groups: ProjectGroup[]) => groups.filter(g => g.chart && !g.linkOf)

/** The chart's name, for a detail's name. */
export const chartName = (g: ProjectGroup) => g.name?.trim() || g.chart?.title?.trim() || 'Chart'

/** Whether `d` reads a rank on a chart. */
export const isChartRank = (d: CardDetail) => !!d.link?.rankOf

// ── Members, counted (Brian 2026-11-06) ──
// A faction's or family's back has a MEMBERS detail that counts the cards
// in it, live: a detail like any other (the Attributes window, Card
// Prompts, {Members} on a face, a link from another card all read it),
// whose value is never typed.

/** Card types whose back counts its members. */
export const hasMembers = (g: Pick<ProjectGroup, 'cardType'>) => g.cardType === 'faction' || g.cardType === 'family'

/** How many cards are in `card` (a faction or family): the ones still there. */
export function memberCount(groups: ProjectGroup[], card: ProjectGroup): number {
  const ids = new Set(groups.map(g => g.id))
  return new Set((card.linkedGroupIds ?? []).filter(id => id !== card.id && ids.has(id))).size
}

/** Whether `d` is card `cardId`'s own member count. */
export const isOwnCount = (d: CardDetail, cardId: string) => d.link?.count === 'members' && d.link.card === cardId

/** `card`'s details with its member count put first, when it is a faction
 *  or family without one (null: nothing to add). A linked copy gets its
 *  master's, which counts the master. */
export function withMemberCount(card: ProjectGroup): CardDetail[] | null {
  if (!hasMembers(card) || card.linkOf) return null
  if ((card.details ?? []).some(d => isOwnCount(d, card.id))) return null
  return [{ id: newDetailId(), name: 'Members', value: '', link: { card: card.id, count: 'members' } }, ...(card.details ?? [])]
}

/** A card's detail, read by name (any case): what it shows, links
 *  followed. For anything that wants to read a card's details. */
export function detailText(groups: ProjectGroup[], cardId: string, name: string): string | undefined {
  const card = groups.find(g => g.id === cardId)
  const d = card?.details?.find(x => x.name.trim().toLowerCase() === name.trim().toLowerCase())
  return d ? detailShown(groups, d).text : undefined
}

/** A faction member's place in it. */
export interface FactionMember {
  card: ProjectGroup
  /** Steps down from the top (the top is 1): one below the lowest of the
   *  members it reports to. Worked out from who reports to whom, never
   *  typed, so it cannot disagree with the tree. */
  rank: number
  /** How far in it sits in the faction's list (0: the top). */
  depth: number
  /** The members it reports to. The first is the one it sits under in
   *  the list (the lowest of them); any others are its other bosses. */
  bosses: ProjectGroup[]
}

/** The members `memberId` reports to in `faction` (members only). */
function bossIdsOf(faction: ProjectGroup, memberId: string, members: Set<string>): string[] {
  return [...new Set(faction.reportsTo?.[memberId] ?? [])].filter(b => b !== memberId && members.has(b))
}

/** A faction's members, read as its tree, top down: the cards it links to
 *  (a card's link "+" let go on the faction), each under the member it
 *  reports to (faction.reportsTo), in the order they joined. Someone who
 *  reports to more than one sits under the lowest of them. */
export function factionMembers(groups: ProjectGroup[], faction: ProjectGroup): FactionMember[] {
  const byId = new Map(groups.map(g => [g.id, g]))
  const ids = [...new Set(faction.linkedGroupIds ?? [])].filter(id => byId.has(id))
  const members = new Set(ids)
  const rank = new Map<string, number>()
  const rankOf = (id: string, path: Set<string>): number => {
    const known = rank.get(id)
    if (known) return known
    if (path.has(id)) return 0 // a loop (should never be stored): read as above the top
    path.add(id)
    const bs = bossIdsOf(faction, id, members)
    const r = bs.length ? 1 + Math.max(...bs.map(b => rankOf(b, path))) : 1
    path.delete(id)
    rank.set(id, Math.max(1, r))
    return Math.max(1, r)
  }
  ids.forEach(id => rankOf(id, new Set()))
  const bossesOf = new Map(ids.map(id => {
    const bs = bossIdsOf(faction, id, members)
    // The one it sits under first: the lowest of its bosses.
    const low = Math.max(0, ...bs.map(b => rank.get(b) ?? 0))
    const i = bs.findIndex(b => rank.get(b) === low)
    return [id, i > 0 ? [bs[i], ...bs.slice(0, i), ...bs.slice(i + 1)] : bs] as const
  }))
  const under = new Map<string, string[]>()
  const tops: string[] = []
  for (const id of ids) {
    const first = bossesOf.get(id)![0]
    if (first && (rank.get(first) ?? 0) < (rank.get(id) ?? 0)) under.set(first, [...(under.get(first) ?? []), id])
    else tops.push(id)
  }
  const out: FactionMember[] = []
  const seen = new Set<string>()
  const walk = (id: string, depth: number) => {
    if (seen.has(id)) return
    seen.add(id)
    out.push({ card: byId.get(id)!, rank: rank.get(id) ?? 1, depth, bosses: bossesOf.get(id)!.map(b => byId.get(b)!) })
    for (const k of under.get(id) ?? []) walk(k, depth + 1)
  }
  tops.forEach(id => walk(id, 0))
  ids.forEach(id => walk(id, 0))
  return out
}

/** Whether `memberId` is above `otherId` in the faction: `otherId`
 *  reports to it, or to someone who does, and so on. */
export function isAbove(faction: ProjectGroup, memberId: string, otherId: string): boolean {
  const seen = new Set<string>()
  const up = (id: string): boolean => {
    if (seen.has(id)) return false
    seen.add(id)
    return (faction.reportsTo?.[id] ?? []).some(b => b === memberId || up(b))
  }
  return up(otherId)
}

/** The factions a card is a member of: its rank and bosses in each. */
export function factionsOf(groups: ProjectGroup[], cardId: string): { faction: ProjectGroup; rank: number; bosses: ProjectGroup[] }[] {
  return groups
    .filter(g => g.cardType === 'faction' && (g.linkedGroupIds ?? []).includes(cardId))
    .flatMap(faction => {
      const m = factionMembers(groups, faction).find(x => x.card.id === cardId)
      // In groups (utils/factionGroups): its rank is its group's, from the top.
      const g = groupRankOf(faction, cardId)
      return m ? [{ faction, rank: g ?? m.rank, bosses: m.bosses }] : []
    })
}
