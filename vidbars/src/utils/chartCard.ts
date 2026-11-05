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
import { isAbove } from './cardTypes'
import type { ChartData, ChartPlace, ChartTier } from './chartData'
import { makeLinkedCard, masterOf } from './linkedCards'
import { newGroupId, type FactionGroup } from './factionGroups'
import type { StorylineData } from './storyline'
import { baseYOf, play, setChartMotion } from './chartMotion'

/** Folding and unfolding are played out (Brian 2026-11-05: "so we can
 *  tell what's happening"; the storyline too: "all the points drop, and the
 *  line slides into the side"). utils/chartMotion draws the storyline; the
 *  linked cards ride with it, each a plain position write per frame (one
 *  undo was taken). While one plays, another fold or show waits it out. */
const DROP_MS = 300
const SLIDE_MS = 380
let moving = false

/** How far each linked card drops with its dot to the base line. */
function dropsOf(d: StorylineData, tiers: { dot: string; cards: string[] }[], idOf: (c: string) => string | undefined): Map<string, number> {
  const by = baseYOf(d)
  const out = new Map<string, number>()
  for (const t of tiers) {
    const p = d.dots.find(q => q.id === t.dot)
    if (!p) continue
    for (const c of t.cards) { const id = idOf(c); if (id && !out.has(id)) out.set(id, by - p.y) }
  }
  return out
}

/** The side of card `g` the line slides into (node units of `n`): the side
 *  facing the storyline, half way down. */
function sideOf(g: ProjectGroup, n: { x: number; y: number; width?: number }): { x: number; y: number } {
  const size = cardFaceSize()
  const w = g.cardWidthOverride ?? size.w, h = g.cardHeightOverride ?? size.h
  const right = n.x + (n.width || 0) / 2 > g.originX + w / 2
  return { x: (right ? g.originX + w : g.originX) - n.x, y: g.originY + h / 2 - n.y }
}

type Ride = { id: string; x: number; y: number; dy: number }
function put(cards: Ride[], at: (c: Ride) => { x: number; y: number }): void {
  if (!cards.length) return
  useBoardsStore.getState().setGroupPosBatch(cards.map(c => { const p = at(c); return { groupId: c.id, originX: p.x, originY: p.y } }))
}

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
  if (!n || !d || moving) return null
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
  // Its groups (utils/factionGroups): one per dot, top to bottom. Who
  // reports to whom is kept; in a group, the rest report to the card on its
  // dot unless they report to someone in the group already.
  const fgs: FactionGroup[] = tiers.map(t => ({ id: newGroupId(), title: t.title, cards: t.cards }))
  useBoardsStore.setState(s => ({
    groups: s.groups.map(g => {
      if (g.id !== cardId) return g
      const tree: Record<string, string[]> = { ...(g.reportsTo ?? {}) }
      for (const t of tiers) for (const c of t.cards.slice(1)) if (!(tree[c] ?? []).some(b => t.cards.includes(b)) && !isAbove({ ...g, reportsTo: tree }, c, t.cards[0])) tree[c] = [t.cards[0]]
      const kept = (g.factionGroups ?? []).map(x => ({ ...x, cards: x.cards.filter(c => !onMasters.has(c) && !old.has(c)) })).filter(x => x.cards.length)
      return {
        ...g, chart, reportsTo: tree, factionGroups: [...fgs, ...kept],
        linkedGroupIds: [...new Set([...(g.linkedGroupIds ?? []).filter(x => !old.has(x)), ...members])],
      }
    }),
  }))

  // The points drop to the base line, the linked cards riding them; then
  // the line slides into the card's side as the cards fly into it, and they
  // go. The masters stay where they are.
  const home = useBoardsStore.getState().groups.find(g => g.id === cardId)
  const links = [...on.keys()].flatMap(id => { const g = useBoardsStore.getState().groups.find(x => x.id === id); return g?.linkOf ? [g] : [] })
  const gone = () => {
    for (const g0 of links) {
      const g = useBoardsStore.getState().groups.find(x => x.id === g0.id)
      if (!g || useBoardsStore.getState().groups.length <= 1) continue
      g.boardIds.forEach(bid => useBoardsStore.getState().deleteBoard(bid))
      useBoardsStore.getState().deleteGroup(g.id)
    }
    useFreeNodeStore.getState().deleteFreeNode(nodeId)
    setChartMotion(nodeId, null)
    moving = false
  }
  if (!home) { gone(); return cardId }
  const isLink = new Set(links.map(g => g.id))
  const drops = new Map<string, number>()
  const by = baseYOf(d)
  for (const p of d.dots) for (const c of cardsOf(d, new Set([p.id])).keys()) if (isLink.has(c) && !drops.has(c)) drops.set(c, by - p.y)
  const ride: Ride[] = links.map(g => ({ id: g.id, x: g.originX, y: g.originY, dy: drops.get(g.id) ?? 0 }))
  const to = sideOf(home, n)
  const hx = home.originX, hy = home.originY
  moving = true
  play(DROP_MS, k => {
    setChartMotion(nodeId, { drop: k, slide: 0, to })
    put(ride, c => ({ x: c.x, y: c.y + c.dy * k }))
  }, () => play(SLIDE_MS, k => {
    setChartMotion(nodeId, { drop: 1, slide: k, to })
    put(ride, c => ({ x: c.x + (hx - c.x) * k, y: c.y + c.dy + (hy - c.y - c.dy) * k }))
  }, gone))
  return cardId
}

/** Brings card `cardId`'s chart back out where it was, with linked cards.
 *  Returns the storyline's id. */
export function recallChart(cardId: string): string | null {
  const card = useBoardsStore.getState().groups.find(g => g.id === cardId)
  const chart = card?.chart
  if (!chart || chartOutOf(cardId) || moving) return null
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
  const live: StorylineData = { ...d, chartCard: cardId, dots: d.dots.map(p => ({ ...p, cards: p.cards?.flatMap(c => link.get(c) ?? []) })) }
  fs.updateFreeNode(id, { ...node, storyline: live })
  // The line slides out of the card's side as the cards fly out to it,
  // dropped onto it; then the points rise to their places, the cards riding
  // them.
  const drops = dropsOf(d, chart.tiers, c => link.get(c))
  const ride: Ride[] = useBoardsStore.getState().groups.filter(g => at.has(g.id))
    .map(g => ({ id: g.id, x: g.originX, y: g.originY, dy: drops.get(g.id) ?? 0 }))
  const to = sideOf(card, node)
  const fx = card.originX, fy = card.originY
  moving = true
  play(SLIDE_MS, k => {
    setChartMotion(id, { drop: 1, slide: 1 - k, to })
    put(ride, c => ({ x: fx + (c.x - fx) * k, y: fy + (c.y + c.dy - fy) * k }))
  }, () => play(DROP_MS, k => {
    setChartMotion(id, { drop: 1 - k, slide: 0, to })
    put(ride, c => ({ x: c.x, y: c.y + c.dy * (1 - k) }))
  }, () => { setChartMotion(id, null); moving = false }))
  return id
}

/** The ground a chart covers when recalled (canvas units): its storyline
 *  and the cards on it, where they were. */
export function chartArea(chart: ChartData): { x: number; y: number; w: number; h: number } {
  const n = chart.node
  let x0 = n.x, y0 = n.y, x1 = n.x + (n.width || 0), y1 = n.y + (n.height || 0)
  for (const p of chart.places) {
    const x = n.x + p.dx, y = n.y + p.dy
    x0 = Math.min(x0, x); y0 = Math.min(y0, y)
    x1 = Math.max(x1, x + (p.w ?? 0)); y1 = Math.max(y1, y + (p.h ?? 0))
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Where the chart would sit beside card `cardId`: its area's top-left just
 *  right of the card, level with its top. */
export function chartSpotBeside(chart: ChartData, card: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  const a = chartArea(chart)
  const nx = card.x + card.w + card.w * 0.25, ny = card.y
  return { x: chart.node.x + (nx - a.x), y: chart.node.y + (ny - a.y) }
}

/** Moves where card `cardId`'s chart is recalled to: node x/y `at`. */
export function setChartSpot(cardId: string, at: { x: number; y: number }): void {
  useUndoCoordinator.getState().checkpoint()
  useBoardsStore.setState(s => ({
    groups: s.groups.map(g => g.id === cardId && g.chart ? { ...g, chart: { ...g.chart, node: { ...g.chart.node, x: at.x, y: at.y } } } : g),
  }))
}
