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
  /** Its lock (utils/deckLock), a master id. */
  deckLock?: string
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
  /** It has been shown before, so its places hold its locks as they were
   *  left. Absent: never shown, and it comes out locked (Brian 2026-11-05). */
  lockSet?: boolean
}

/** Sizes inside one deck, read as steps (Brian 2026-11-10): he sizes a
 *  deck's cards to show who's who, in three or four clear sizes, each a
 *  little off from resizing by hand. The largest are step 1, the next clear
 *  size down 2, and so on; a card within a tenth of the one before shares
 *  its step. `widths` in any order; a step for each, in that order. */
export function sizeSteps(widths: number[]): number[] {
  const order = widths.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w)
  const out = new Array<number>(widths.length).fill(1)
  let step = 1
  order.forEach((c, k) => {
    if (k > 0 && c.w < order[k - 1].w * 0.9) step++
    out[c.i] = step
  })
  return out
}

/** Where `cardId` (a master id) stands on a chart: its group, counted from
 *  the top (1), and the card that leads that group, when it is not it.
 *  `step`: its size step in that group's deck (sizeSteps), when the deck has
 *  more than one size and every card in it has a size set. */
export function chartRankOf(chart: ChartData, cardId: string): { rank: number; leader?: string; step?: number } | null {
  const i = chart.tiers.findIndex(t => t.cards.includes(cardId))
  if (i < 0) return null
  const cards = chart.tiers[i].cards
  const lead = cards[0]
  const widths = cards.map(c => chart.places.find(p => p.card === c)?.w)
  const steps = widths.every(w => w != null && w > 0) ? sizeSteps(widths as number[]) : []
  const step = steps.some(s => s > 1) ? steps[cards.indexOf(cardId)] : undefined
  return { rank: i + 1, leader: lead !== cardId ? lead : undefined, ...(step ? { step } : {}) }
}

/** A rank as shown: 2, or 2.3 for size step 3 in the rank 2 deck. */
export const rankText = (r: { rank: number; step?: number }) => r.step ? `${r.rank}.${r.step}` : String(r.rank)
