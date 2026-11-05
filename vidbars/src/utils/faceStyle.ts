// A card's face, styled once and copied (Brian 2026-11-04): the text on
// its face (title and body), how it is set (font, size, alignment,
// colours) and where the line between them sits, taken from one card and
// put on others. A one-time copy: the cards are not tied after it.
//
// Face text can show a card's own details: {Name}, {Age}, {Role}, any
// detail by its name, {Details} for its whole DETAILS list, and {Type},
// {Faction}, {Rank}, {Reports to}, {Family}. So a face copied from one character shows each character's
// own. Copying turns the card's own name in its text into {Name}, so a
// face that says "Ratchet" on Ratchet says each card's name on the rest.

import type { ProjectGroup } from '../store/boardsStore'
import type { TextStyle } from '../store/freeNodeStore'
import { CARD_TYPES, CARD_TYPE_ORDER, cardTypeOf, detailShown, detailText, factionsOf } from './cardTypes'
import { familiesOf } from './family'

/** What a field shows on a card ('' if it has none). */
function field(groups: ProjectGroup[], card: ProjectGroup, key: string): string {
  const k = key.trim().toLowerCase()
  if (k === 'name') return card.name ?? ''
  if (k === 'type') return CARD_TYPES[cardTypeOf(card)].label
  const own = detailText(groups, card.id, k)
  if (own !== undefined) return own
  // The back's DETAILS list, a line each, those filled in (Brian
  // 2026-11-05: {details} on a faction's face showed nothing).
  if (k === 'details') {
    // A line written in a row's name alone is shown as it is (Brian's
    // faction, 2026-11-05); an empty row a card type made up is not, its
    // own type's or one left from a type it was before (Brian's chart
    // card showed a scene's Act, Location, Time of day).
    const made = new Set(CARD_TYPE_ORDER.flatMap(t => CARD_TYPES[t].details.map(s => s.toLowerCase())))
    return (card.details ?? []).flatMap(d => {
      const v = detailShown(groups, d).text.trim(), n = d.name.trim()
      if (v) return [n ? `${n}: ${v}` : v]
      return n && !made.has(n.toLowerCase()) ? [n] : []
    }).join('\n')
  }
  const f = factionsOf(groups, card.id)[0]
  if (k === 'faction') return f?.faction.name ?? ''
  if (k === 'rank') return f ? String(f.rank) : ''
  if (k === 'reports to') return f?.bosses.map(b => b.name).join(', ') ?? ''
  if (k === 'family') return familiesOf(groups, card.id)[0]?.name ?? ''
  return ''
}

/** Face text with its {fields} filled in from this card. */
export function fillFields(text: string, groups: ProjectGroup[], cardId: string): string {
  if (!text.includes('{')) return text
  const card = groups.find(g => g.id === cardId)
  if (!card) return text
  return text.replace(/\{([^{}\n]{1,40})\}/g, (_m, key: string) => field(groups, card, key))
}

/** A card's title as shown: its header with its {fields} filled in, else
 *  its name. For the chips, menus and lists that name a card (Brian
 *  2026-11-05: a link chip said "{Name}"). */
export function cardTitle(groups: ProjectGroup[], card: ProjectGroup): string {
  return fillFields(card.cardHeaderText ?? '', groups, card.id).trim() || card.name || ''
}

export interface FaceStyle {
  header: string
  body: string
  headerStyle?: TextStyle
  bodyStyle?: TextStyle
  split?: number
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A card's face, to copy: its own name in its text becomes {Name}. */
export function faceStyleOf(card: ProjectGroup): FaceStyle {
  const name = (card.name ?? '').trim()
  const generic = (s: string | undefined) => {
    const t = s ?? ''
    return name.length >= 2 ? t.replace(new RegExp(`(?<![\\w{])${escape(name)}(?![\\w}])`, 'g'), '{Name}') : t
  }
  return {
    header: generic(card.cardHeaderText),
    body: generic(card.cardText),
    headerStyle: card.cardHeaderTextStyle,
    bodyStyle: card.cardTextStyle,
    split: card.textSplitRatio,
  }
}

/** The face copied last (Copy style), for Paste style. Not saved. */
let copied: FaceStyle | null = null
export const copyFaceStyle = (card: ProjectGroup) => { copied = faceStyleOf(card) }
export const copiedFaceStyle = () => copied
