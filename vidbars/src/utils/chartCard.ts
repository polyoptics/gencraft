// Baking a storyline into a card, and recalling it (Brian 2026-11-05).
//
// Bake: he builds a chart on a storyline with his master cards, then folds
// it into a card (a faction card, new, or the one it was recalled from).
// The card keeps the storyline, where each card sat on it and its groups
// top to bottom (utils/chartData); its members are the chart's master
// cards. The storyline goes; the master cards stay where they are, free to
// move away. Linked cards on it (a recalled chart's) fold away with it.
//
// Recall: the storyline comes back where it was, filled with LINKED cards
// showing those masters (utils/linkedCards), each where it sat, in its deck
// as it was. Edits on them are edits on the masters.

import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { cardFaceSize, createTextCard } from './cardGrid'
import type { ChartData, ChartPlace, ChartTier } from './chartData'
import { makeLinkedCard, masterOf } from './linkedCards'
import type { StorylineData } from './storyline'

/** The cards that go with these dots, as the storyline moves them
 *  (StorylineLayer cardOrigins): card id → origin. */
export type CardsOfDots = (d: StorylineData, dots: Set<string>) => Map<string, { x: number; y: number }>

/** The chart's name: the storyline's own title when it has one, else its
 *  first dot title, else "Chart". */
function chartTitle(n: FreeNodeData): string {
  const s = n.storyline as (StorylineData & Record<string, unknown>) | undefined
  const named = [s?.title, s?.baseTitle, s?.label, (n as unknown as Record<string, unknown>).title]
    .find(v => typeof v === 'string' && v.trim()) as string | undefined
  if (named) return named.trim()
  if (n.label && n.label !== 'Storyline') return n.label
  return s?.dots.find(p => p.title?.trim())?.title.trim() || 'Chart'
}

/** The storyline recalled from card `cardId`, when it is out. */
export function chartOutOf(cardId: string): string | null {
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) if (n.storyline?.chartCard === cardId) return n.id
  return null
}

/** Folds storyline `nodeId` into its card. Returns the card's id, or null
 *  when no card is on it. */
export function bakeStoryline(nodeId: string, cardsOf: CardsOfDots): string | null {
  const fs = useFreeNodeStore.getState()
  const n = fs.nodes[nodeId]
  const d = n?.storyline
  if (!n || !d) return null
  const groups = useBoardsStore.getState().groups
  const byId = new Map(groups.map(g => [g.id, g]))
  const on = cardsOf(d, new Set(d.dots.map(p => p.id)))
  if (on.size === 0) return null
  const master = (id: string) => masterOf(groups, id)
  const onMasters = new Set([...on.keys()].map(master))

  const places: ChartPlace[] = []
  const placed = new Set<string>()
  for (const id of on.keys()) {
    const g = byId.get(id)
    const m = master(id)
    if (!g || placed.has(m)) continue
    placed.add(m)
    const anchor = g.deckAnchorId ? master(g.deckAnchorId) : undefined
    const inDeck = !!anchor && onMasters.has(anchor)
    places.push({
      card: m, dx: g.originX - n.x, dy: g.originY - n.y,
      w: g.cardWidthOverride, h: g.cardHeightOverride, flipped: g.flipped,
      ...(inDeck ? { deckState: g.deckState, deckAnchorId: anchor, deckOffsetX: g.deckOffsetX, deckOffsetY: g.deckOffsetY, nestedDeck: g.nestedDeck } : {}),
      ...(g.deckLastFront && onMasters.has(master(g.deckLastFront)) ? { deckLastFront: master(g.deckLastFront) } : {}),
    })
  }

  // Each dot's group, top to bottom; the card linked to the dot leads it.
  const tiers: ChartTier[] = []
  const tiered = new Set<string>()
  for (const p of [...d.dots].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (!p.cards?.length) continue
    const lead = p.cards.map(master)
    const rest = [...cardsOf(d, new Set([p.id])).keys()].map(master)
    const cards = [...new Set([...lead, ...rest])].filter(c => !tiered.has(c))
    cards.forEach(c => tiered.add(c))
    if (cards.length) tiers.push({ dot: p.id, title: p.title ?? '', cards })
  }

  const { id: _id, ...rest } = n
  void _id
  const storyline: StorylineData = { ...d, chartCard: undefined, dots: d.dots.map(p => ({ ...p, cards: p.cards?.map(master) })) }
  const chart: ChartData = { title: chartTitle(n), node: { ...rest, storyline }, places, tiers }

  useUndoCoordinator.getState().checkpoint()
  let cardId = d.chartCard && byId.has(d.chartCard) ? d.chartCard : null
  if (!cardId) {
    const size = cardFaceSize()
    cardId = createTextCard({ cx: n.x + size.w / 2, cy: n.y + n.height + size.h * 0.75 }, { title: chart.title })
    useBoardsStore.getState().setCardsType([cardId], 'faction')
  }
  const old = new Set(byId.get(cardId)?.chart?.places.map(p => p.card) ?? [])
  const members = [...onMasters]
  useBoardsStore.setState(s => ({
    groups: s.groups.map(g => g.id !== cardId ? g : {
      ...g, chart,
      linkedGroupIds: [...new Set([...(g.linkedGroupIds ?? []).filter(x => !old.has(x)), ...members])],
    }),
  }))

  // The linked cards on it fold away; the masters stay where they are.
  const bs = useBoardsStore.getState()
  for (const id of on.keys()) {
    const g = bs.groups.find(x => x.id === id)
    if (!g?.linkOf || useBoardsStore.getState().groups.length <= 1) continue
    g.boardIds.forEach(bid => useBoardsStore.getState().deleteBoard(bid))
    useBoardsStore.getState().deleteGroup(id)
  }
  fs.deleteFreeNode(nodeId)
  return cardId
}

/** Brings card `cardId`'s chart back out where it was, with linked cards.
 *  Returns the storyline's id. */
export function recallChart(cardId: string): string | null {
  const card = useBoardsStore.getState().groups.find(g => g.id === cardId)
  const chart = card?.chart
  if (!chart || chartOutOf(cardId)) return null
  useUndoCoordinator.getState().checkpoint()
  const link = new Map<string, string>()
  for (const p of chart.places) {
    const id = makeLinkedCard(p.card)
    if (id) link.set(p.card, id)
  }
  const at = new Map(chart.places.map(p => [link.get(p.card), p]))
  const node = chart.node
  useBoardsStore.setState(s => ({
    groups: s.groups.map((g): ProjectGroup => {
      const p = at.get(g.id)
      if (!p) return g
      const anchor = p.deckAnchorId ? link.get(p.deckAnchorId) : undefined
      return {
        ...g,
        originX: node.x + p.dx, originY: node.y + p.dy,
        cardWidthOverride: p.w, cardHeightOverride: p.h, flipped: p.flipped,
        deckState: anchor ? p.deckState : undefined,
        deckAnchorId: anchor,
        deckOffsetX: anchor ? p.deckOffsetX : undefined,
        deckOffsetY: anchor ? p.deckOffsetY : undefined,
        nestedDeck: anchor ? p.nestedDeck : undefined,
        deckLastFront: p.deckLastFront ? link.get(p.deckLastFront) : undefined,
      }
    }),
  }))
  const fs = useFreeNodeStore.getState()
  const id = fs.addFreeNode(node.x, node.y, 'storyline')
  const d = node.storyline!
  fs.updateFreeNode(id, {
    ...node,
    storyline: {
      ...d, chartCard: cardId,
      dots: d.dots.map(p => ({ ...p, cards: p.cards?.flatMap(c => link.get(c) ?? []) })),
    },
  })
  return id
}
