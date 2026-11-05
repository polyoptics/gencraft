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
import { isUndoRestoring, useUndoCoordinator } from '../store/undoCoordinator'
import { cardFaceSize, createTextCard } from './cardGrid'
import { isAbove } from './cardTypes'
import type { ChartData, ChartPlace, ChartTier } from './chartData'
import { makeLinkedCard, masterOf } from './linkedCards'
import { newGroupId, type FactionGroup } from './factionGroups'
import type { StorylineData } from './storyline'
import { baseYOf, play, setChartMotion } from './chartMotion'
import { flushSync } from 'react-dom'
import { useCanvasStore } from '../store/canvasStore'

/** Folding and unfolding are played out (Brian 2026-11-05: "so we can
 *  tell what's happening"; the storyline too: "all the points drop, and the
 *  line slides into the side"), as ONE quick motion ("chunky... smooth it
 *  into a nice motion"): the points drop to the base line as the line slides
 *  into the card's side; showing, the reverse. utils/chartMotion draws the
 *  storyline; the linked cards ride along as transform animations on their
 *  own elements (moving them in the store every frame redrew every card and
 *  dropped frames). Their positions are written once. While one plays,
 *  another fold or show waits it out. */
const MOTION_MS = 360
let moving = false
const clamp01 = (t: number) => Math.max(0, Math.min(1, t))
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
type Phase = { drop: number; slide: number }
/** Folding at time t (0..1): the drop leads, the slide follows on. */
const foldAt = (t: number): Phase => ({ drop: easeOut(clamp01(t / 0.5)), slide: easeInOut(clamp01((t - 0.3) / 0.7)) })
/** Showing: the slide out leads, the rise settles it. */
const showAt = (t: number): Phase => ({ drop: 1 - easeOut(clamp01((t - 0.5) / 0.5)), slide: 1 - easeInOut(clamp01(t / 0.7)) })

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

/** A linked card riding the motion: where it is in the store, and how far
 *  its dot drops. */
type Ride = { id: string; x: number; y: number; dy: number }

/** Plays the motion on storyline `nodeId`: drawn each frame, its cards
 *  animated from where they are in the store to `at` (canvas units) on the
 *  compositor; then `done`. `hold` keeps the cards where they end up until
 *  they go (a fold). */
function playChart(nodeId: string, to: { x: number; y: number }, ride: Ride[], at: (c: Ride, m: Phase) => { x: number; y: number }, phase: (t: number) => Phase, hold: boolean, done: () => void): void {
  const zoom = useCanvasStore.getState().zoom
  const N = 18
  const frames = new Map(ride.map(c => [c.id, Array.from({ length: N + 1 }, (_, i) => {
    const p = at(c, phase(i / N))
    return { transform: `translate(${(p.x - c.x) * zoom}px, ${(p.y - c.y) * zoom}px)` }
  })]))
  // Each card's elements ride; one drawn anew part way (React may redraw a
  // card it has just put down) picks the ride up where it has got to.
  const riding = new WeakSet<Element>()
  const ridden = (ms: number) => {
    for (const [id, f] of frames) {
      for (const el of document.querySelectorAll(`[data-layer-card="${id}"], [data-card-header="${id}"], [data-primary-rail="${id}"]`)) {
        if (riding.has(el)) continue
        riding.add(el)
        const a = (el as HTMLElement).animate(f, { duration: MOTION_MS, easing: 'linear', composite: 'add', fill: hold ? 'forwards' : 'none' })
        a.currentTime = ms
      }
    }
  }
  play(MOTION_MS, (t, ms) => { ridden(ms); setChartMotion(nodeId, { ...phase(t), to }) }, done)
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
    // A new card's chart comes out right off its top-right corner (Brian
    // 2026-11-05), and moves with it (startChartFollow).
    const c = useBoardsStore.getState().groups.find(g => g.id === cardId)
    if (c) {
      const spot = chartSpotBeside(chart, { x: c.originX, y: c.originY, w: c.cardWidthOverride ?? size.w, h: c.cardHeightOverride ?? size.h })
      chart.node = { ...chart.node, x: spot.x, y: spot.y }
    }
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

  // The points drop to the base line as the line slides into the card's
  // side, the linked cards riding along into the card, and they go. The masters stay where they are.
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
  playChart(nodeId, to, ride, (c, m) => {
    const y = c.y + c.dy * m.drop
    return { x: c.x + (hx - c.x) * m.slide, y: y + (hy - y) * m.slide }
  }, foldAt, true, gone)
  return cardId
}

/** Brings card `cardId`'s chart back out where it was, with linked cards.
 *  Returns the storyline's id. */
export function recallChart(cardId: string): string | null {
  const card = useBoardsStore.getState().groups.find(g => g.id === cardId)
  const chart = card?.chart
  if (!chart || chartOutOf(cardId) || moving) return null
  useUndoCoordinator.getState().checkpoint()
  // All of it drawn at once (flushSync), already started on its way out,
  // so the cards are there to animate and nothing shows where it lands
  // first.
  const { id, link, at, node } = flushSync(() => {
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
    setChartMotion(id, { ...showAt(0), to: sideOf(card, node) })
    return { id, link, at, node }
  })
  // The line slides out of the card's side, the cards riding out with it;
  // then the points rise to their places.
  const drops = dropsOf(node.storyline!, chart.tiers, c => link.get(c))
  const ride: Ride[] = useBoardsStore.getState().groups.filter(g => at.has(g.id))
    .map(g => ({ id: g.id, x: g.originX, y: g.originY, dy: drops.get(g.id) ?? 0 }))
  const fx = card.originX, fy = card.originY
  moving = true
  playChart(id, sideOf(card, node), ride, (c, m) => {
    const y = c.y + c.dy * m.drop
    return { x: c.x + (fx - c.x) * m.slide, y: y + (fy - y) * m.slide }
  }, showAt, false, () => { setChartMotion(id, null); moving = false })
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
 *  right off the card's top-right corner. */
export function chartSpotBeside(chart: ChartData, card: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  const a = chartArea(chart)
  const nx = card.x + card.w + card.w * 0.1, ny = card.y
  return { x: chart.node.x + (nx - a.x), y: chart.node.y + (ny - a.y) }
}

/** Moves where card `cardId`'s chart is recalled to: node x/y `at`. */
export function setChartSpot(cardId: string, at: { x: number; y: number }): void {
  useUndoCoordinator.getState().checkpoint()
  useBoardsStore.setState(s => ({
    groups: s.groups.map(g => g.id === cardId && g.chart ? { ...g, chart: { ...g.chart, node: { ...g.chart.node, x: at.x, y: at.y } } } : g),
  }))
}

/** A chart card moving takes its chart along (Brian 2026-11-05: "if I move
 *  the card, the chart moves too"): while out, the storyline and the cards
 *  on it; folded, where it comes out. The chart moved on its own leaves the
 *  card where it is, and folds in remembering where it stands. Not while
 *  the storyline itself is selected (a drag of both moves both already),
 *  nor on undo (that puts both back). */
export function startChartFollow(cardsOf: CardsOfDots): () => void {
  const seen = (gs: ProjectGroup[]) => {
    const m = new Map<string, { x: number; y: number }>()
    for (const g of gs) if (g.chart) m.set(g.id, { x: g.originX, y: g.originY })
    return m
  }
  let last = seen(useBoardsStore.getState().groups)
  return useBoardsStore.subscribe(s => {
    const now = seen(s.groups)
    const moves: { id: string; dx: number; dy: number }[] = []
    if (!moving && !isUndoRestoring()) {
      for (const [id, p] of now) {
        const q = last.get(id)
        if (q && (q.x !== p.x || q.y !== p.y)) moves.push({ id, dx: p.x - q.x, dy: p.y - q.y })
      }
    }
    last = now
    for (const m of moves) {
      const out = chartOutOf(m.id)
      if (out) {
        const fs = useFreeNodeStore.getState()
        const n = fs.nodes[out]
        if (!n?.storyline || fs.selectedIds.includes(out)) continue
        const cards = cardsOf(n.storyline, new Set(n.storyline.dots.map(p => p.id)))
        cards.delete(m.id)
        fs.updateFreeNode(out, { x: n.x + m.dx, y: n.y + m.dy })
        if (cards.size) useBoardsStore.getState().setGroupPosBatch([...cards].map(([id, o]) => ({ groupId: id, originX: o.x + m.dx, originY: o.y + m.dy })))
      } else {
        useBoardsStore.setState(st => ({
          groups: st.groups.map(g => (g.id === m.id && g.chart
            ? { ...g, chart: { ...g.chart, node: { ...g.chart.node, x: g.chart.node.x + m.dx, y: g.chart.node.y + m.dy } } }
            : g)),
        }))
      }
    }
  })
}
