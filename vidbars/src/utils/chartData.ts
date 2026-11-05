// A chart baked into a card (Brian 2026-11-05): a storyline he built with
// his master cards, folded into one card. The card keeps the storyline as
// it was, where each card sat on it, and its groups top to bottom. Recalled,
// the storyline comes back where it was, filled with LINKED versions of
// those cards (utils/linkedCards). Pure data and reading here; baking and
// recalling are in utils/chartCard.

import type { FreeNodeData } from '../store/freeNodeStore'

/** Where one card sat on the chart, kept by its MASTER card's id. */
export interface ChartPlace {
  card: string
  /** Its origin less the storyline node's x/y (canvas units). */
  dx: number
  dy: number
  w?: number
  h?: number
  flipped?: boolean
  /** Its deck as it was on the chart (ids are master ids). */
  deckState?: 'open' | 'fanned' | 'stacked'
  deckAnchorId?: string
  deckOffsetX?: number
  deckOffsetY?: number
  deckLastFront?: string
  nestedDeck?: boolean
}

/** One dot's group: its cards (master ids), the one linked to the dot first. */
export interface ChartTier {
  dot: string
  title: string
  cards: string[]
}

export interface ChartData {
  title: string
  /** The storyline node as it was, less its id; its dots hold master ids. */
  node: Omit<FreeNodeData, 'id'>
  places: ChartPlace[]
  /** Top to bottom, as the dots sat. */
  tiers: ChartTier[]
}

/** Where `cardId` (a master id) stands on a chart: its group, counted from
 *  the top (1), and the card that leads that group, when it is not it. */
export function chartRankOf(chart: ChartData, cardId: string): { rank: number; leader?: string } | null {
  const i = chart.tiers.findIndex(t => t.cards.includes(cardId))
  if (i < 0) return null
  const lead = chart.tiers[i].cards[0]
  return { rank: i + 1, leader: lead !== cardId ? lead : undefined }
}
