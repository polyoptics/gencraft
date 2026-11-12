// contentKinds.ts — the shared vocabulary for content-kind filtering.
//
// Used by the Rolodex's kind-filter chips, the pinned list objects'
// query evaluation, and (indirectly) the content browser: one definition
// of "does this group/tile hold content of kind K" so a filtered Rolodex,
// a pinned list, and a browser playlist always agree. The same goes for
// what a SEARCH matches on a free tile (freeNodeInResults), and which
// effects a search offers to add.
//
// Semantics notes:
//  - Group matching inspects the group's OWN boards only (not its deck
//    tree) — the Rolodex lists every group individually, so recursive
//    matching would light up a whole deck for one member's model.
//  - A card's hero DOES count as 'image' content: it is the card's face,
//    and the browser enumerates it too (see contentTraversal). Block
//    thumbnails remain decoration.

import type { ProjectGroup, BoardData } from '../store/boardsStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { getMediaItems } from '../types/bar'
import { EFFECTS, EFFECT_ORDER, effectKindOf, type EffectKind } from './fx/effects'
import { CARD_TYPES, cardTypeOf, type CardType } from './cardTypes'

export type ContentKind = 'model' | 'image' | 'video' | 'audio' | 'text'

export const KIND_LABELS: Record<ContentKind | 'all', string> = {
  all: 'All', model: '3D', image: 'Img', video: 'Vid', audio: 'Aud', text: 'Txt',
}

export interface ListQuery {
  query: string
  kind: ContentKind | 'all'
  includeCanvasItems: boolean
  /** Snapshot of the Rolodex sort at pin time; the EMBEDDED rolodex on a
   *  pinned tile edits this in place (its own sort toggle). */
  sortMode: 'creation' | 'alphabetical'
  /** Embedded-rolodex view state, persisted per pinned tile. */
  view?: 'flat' | 'tree'
  collapsedDeckIds?: string[]
  /** Per-instance display mode. Optional, so every list tile that exists
   *  today keeps working on the 'auto' default with no migration. */
  displayMode?: 'auto' | 'compact' | 'full'
  /** Card types to show, each its own on/off chip. None lit = every type.
   *  Optional, so list tiles from before it keep working unchanged. */
  cardTypes?: CardType[]
}

/** Short names for the card-type chips in the Card Browser's filter strip
 *  (they share one row, like the 3D / Img / Vid chips above them). */
export const CARD_TYPE_SHORT: Record<CardType, string> = {
  element: 'Elm', character: 'Chr', faction: 'Fac', family: 'Fam', location: 'Loc',
  prop: 'Prp', audio: 'Aud', scene: 'Scn', event: 'Evt', prompt: 'Pmt', note: 'Nte', state: 'Sta', area3d: '3D',
}

/** Is the card one of the lit card types? None lit = yes. */
export function groupMatchesTypes(g: ProjectGroup, types: CardType[] | undefined): boolean {
  return !types?.length || types.includes(cardTypeOf(g))
}

/** Human summary for list-tile headers, e.g. `3D · “mech”` or `All`. */
export function formatListQuerySummary(q: ListQuery): string {
  const kind = q.kind === 'all' ? 'All' : KIND_LABELS[q.kind]
  const types = q.cardTypes?.length ? ` · ${q.cardTypes.map(t => CARD_TYPES[t].label).join(', ')}` : ''
  const query = q.query.trim()
  return query ? `${kind}${types} · “${query}”` : `${kind}${types}`
}

/** Does a card answer a search? Its name holds the words, or the words
 *  name its card type: "character" or "characters" finds every character
 *  card, so the Card Browser can be filtered to one type (and feed that
 *  type to a window magneted to it, utils/cardBacks). An empty search
 *  matches every card. */
export function groupMatchesQuery(g: ProjectGroup, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if ((g.name || '').toLowerCase().includes(q)) return true
  if (q.length < 3) return false
  const type = CARD_TYPES[cardTypeOf(g)].label.toLowerCase()
  return type.startsWith(q) || q.startsWith(type)
}

/** True iff the group's OWN boards hold content of `kind`. */
export function groupHasContentOfKind(
  g: ProjectGroup,
  boards: Record<string, BoardData>,
  kind: ContentKind,
): boolean {
  if (kind === 'text' && (g.cardText || g.cardHeaderText)) return true
  // The card's face counts as an image, matching collectGroupOwnContent.
  // If it did not, a list filtered to images would refuse to match a card
  // whose only image is the one you are looking at.
  if (kind === 'image' && g.cardHeroImage) return true
  for (const bid of g.boardIds) {
    const board = boards[bid]
    if (!board) continue
    for (const bar of Object.values(board.bars)) {
      if (kind === 'text') {
        if (bar.content?.text || bar.content?.headerText) return true
      } else if (getMediaItems(bar.content).some(m => m.type === kind)) {
        return true
      }
    }
  }
  return false
}

/** True iff the free node matches `kind`. Lists index things — they are
 *  not content themselves, so they only appear under 'all'. Media tiles
 *  need real content (imageUrl); empty drop targets only show under 'all'. */
export function freeNodeMatchesKind(n: FreeNodeData, kind: ContentKind | 'all'): boolean {
  if (n.type === 'list') return kind === 'all'
  if (kind === 'all') return true
  if (kind === 'text') return (n.type === 'text' || n.type === 'note') && n.text.trim() !== ''
  return n.type === kind && !!n.imageUrl
}

/** What a search reads on a free node, lower-cased. The label — plus, on
 *  an effect card, what it IS: its effect's name and kind and the generic
 *  words for effects, so "bloom", "glare" or "fx" find a card someone
 *  renamed "hero shot". */
export function freeNodeSearchText(n: FreeNodeData): string {
  const base = n.label || ''
  if (n.type !== 'effect') return base.toLowerCase()
  const k = effectKindOf(n)
  return `${base} ${EFFECTS[k].label} ${k} effect effects fx`.toLowerCase()
}

/** True iff the free node matches a search `query` (an empty one matches
 *  everything). A LIST never matches a non-empty query: its label is its
 *  own query summary (`All · “bloom”`), so an embedded Rolodex searching
 *  for "bloom" always listed itself. */
export function freeNodeMatchesQuery(n: FreeNodeData, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (n.type === 'list') return false
  return freeNodeSearchText(n).includes(q)
}

/** Is the free node one of a list's tile results? The ONE rule for the
 *  Rolodex's tile rows and a pinned list's evaluator, so the two agree by
 *  construction. With Tiles on: every tile matching the kind and the
 *  search. With Tiles off: effect cards still answer a search that names
 *  them — an effect card is a tool you go looking for by name, and hiding
 *  it behind a toggle about "canvas items" made "where is my Bloom?"
 *  unanswerable. Pinned ones stay out: they are on the screen, not lost. */
export function freeNodeInResults(
  n: FreeNodeData,
  q: Pick<ListQuery, 'query' | 'kind' | 'includeCanvasItems'>,
): boolean {
  if (!q.includeCanvasItems && (n.type !== 'effect' || n.pin || !q.query.trim())) return false
  return freeNodeMatchesKind(n, q.kind) && freeNodeMatchesQuery(n, q.query)
}

/** The effects a search offers to ADD ("Add new <effect>" rows): those
 *  whose name or kind contains the query, or all of them for a query that
 *  asks for effects in general — "fx", or a start of "effects" of two
 *  letters or more. Nothing for a one-letter query: "e" alone would put
 *  eight add rows in front of the cards you were starting to type the
 *  name of. Exact name matches first, then names that start with the
 *  query, then the rest, each in EFFECT_ORDER (the add menu's order). */
export function effectKindsForQuery(query: string): EffectKind[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  if (q === 'fx' || 'effects'.startsWith(q)) return [...EFFECT_ORDER]
  // Ranked, because Enter and the top row create rows[0]: in plain
  // EFFECT_ORDER, typing the whole name "screen" led with Screentone
  // ("screentone" contains "screen" and comes first), so the user got a
  // different effect from the one they named.
  const rank = (k: EffectKind) => {
    const l = EFFECTS[k].label.toLowerCase()
    return k === q || l === q ? 0 : k.startsWith(q) || l.startsWith(q) ? 1 : 2
  }
  return EFFECT_ORDER
    .filter(k => k.includes(q) || EFFECTS[k].label.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b))   // stable: EFFECT_ORDER within a tier
}

/** Defensive filter — true iff the group has at least one board with at
 *  least one valid root bar. Mirrors the canvas's validity check in
 *  CardLayer's GroupCard bounds calc; phantom groups are invisible on
 *  canvas, so lists shouldn't show them either. (Moved here from
 *  CardRolodex so the pinned-list evaluator shares it.) */
export function hasRenderableContent(g: ProjectGroup, boards: Record<string, BoardData>): boolean {
  for (const bid of g.boardIds) {
    const board = boards[bid]
    if (!board) continue
    for (const rid of board.rootIds) {
      if (board.bars[rid]) return true
    }
  }
  return false
}

/** Sort groups by the Rolodex sort mode. Returns a copy. 'creation'
 *  preserves array order (boardsStore appends new groups at the end).
 *  (Moved here from CardRolodex so the pinned-list evaluator shares it.) */
export function sortGroups(arr: ProjectGroup[], sortMode: 'creation' | 'alphabetical'): ProjectGroup[] {
  if (sortMode === 'alphabetical') {
    return [...arr].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }
  return [...arr]
}

/** Sort free nodes by the Rolodex sort mode (labels ↔ names). */
export function sortFreeNodes(arr: FreeNodeData[], sortMode: 'creation' | 'alphabetical'): FreeNodeData[] {
  if (sortMode === 'alphabetical') {
    return [...arr].sort((a, b) => (a.label || '').localeCompare(b.label || ''))
  }
  return [...arr]
}
