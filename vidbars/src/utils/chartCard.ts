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

import { lockChains } from './chainLock'
import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { isUndoRestoring, useUndoCoordinator } from '../store/undoCoordinator'
import { cardFaceSize, createTextCard } from './cardGrid'
import { chartRank, isAbove } from './cardTypes'
import { rankText, type ChartData, type ChartPlace, type ChartTier } from './chartData'
import { matchedPlaces } from './chartMatch'
import { linkedHeight, makeLinkedCard, masterOf } from './linkedCards'
import { newGroupId, type FactionGroup } from './factionGroups'
import type { StorylineData } from './storyline'
import { play, setChartMotion } from './chartMotion'
import { flushSync } from 'react-dom'
import { useCanvasStore } from '../store/canvasStore'

/** Folding and unfolding are played out (Brian 2026-11-05: "so we can
 *  tell what's happening"; the storyline too: "all the points drop, and the
 *  line slides into the side"), as ONE quick motion ("chunky... smooth it
 *  into a nice motion"). Showing, the line comes first, then the cards
 *  jump out; folding, the cards go in first, then the line goes (Brian
 *  2026-11-05): its points drop to the base line as it slides into the
 *  card's side. utils/chartMotion draws the storyline; the linked cards
 *  move as transform animations on their
 *  own elements (moving them in the store every frame redrew every card and
 *  dropped frames). Their positions are written once. While one plays,
 *  another fold or show waits it out. */
const MOTION_MS = 452
let moving = false
const clamp01 = (t: number) => Math.max(0, Math.min(1, t))
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
type Phase = { drop: number; slide: number; tether: number; lead: number }
/** Folding at time t (0..1): the cards go (cardsGone), their tethers
 *  pull back into the dots, then the line drops and slides into its start
 *  dot, which pops into the card. */
const foldAt = (t: number): Phase => ({ tether: 1 - easeInOut(clamp01((t - 0.239) / 0.117)), drop: easeOut(clamp01((t - 0.356) / 0.261)), slide: easeInOut(clamp01((t - 0.429) / 0.441)), lead: easeOut(clamp01((t - 0.87) / 0.13)) })
/** The cards don't travel (Brian 2026-11-05): each just appears where it
 *  sits, quickly, one after another from the bottom up, and goes the same
 *  way top down. Card `i` of `n` in that order: shown 0..1 at time t. */
const POP = 0.044
const cardsGone = (i: number, n: number, t: number) => 1 - clamp01((t - (0.239 - POP) * (n > 1 ? i / (n - 1) : 0)) / POP)
/** Showing: the start dot pops out, the line grows out of it and rises, the tethers grow out of the
 *  dots to where the cards will be (Brian 2026-11-05), then the cards
 *  appear (cardsShown). */
const showAt = (t: number): Phase => ({ lead: 1 - easeOut(clamp01(t / 0.13)), slide: 1 - easeInOut(clamp01((t - 0.13) / 0.279)), drop: 1 - easeOut(clamp01((t - 0.323) / 0.259)), tether: easeOut(clamp01((t - 0.582) / 0.186)) })
const cardsShown = (i: number, n: number, t: number) => clamp01((t - 0.768 - (0.232 - POP) * (n > 1 ? i / (n - 1) : 0)) / POP)
/** Ride order for popping: lowest card first (`up`), else highest. */
const popOrder = (ride: Ride[], up: boolean) => {
  const by = [...ride].sort((a, b) => (up ? b.y - a.y : a.y - b.y))
  return new Map(by.map((c, i) => [c.id, i]))
}

/** The side of card `g` the line slides into (node units of `n`): the side
 *  facing the storyline, half way down. */
function sideOf(g: ProjectGroup, n: { x: number; y: number; width?: number }): { x: number; y: number } {
  const size = cardFaceSize()
  const w = g.cardWidthOverride ?? size.w, h = g.cardHeightOverride ?? size.h
  const right = n.x + (n.width || 0) / 2 > g.originX + w / 2
  return { x: (right ? g.originX + w : g.originX) - n.x, y: g.originY + h / 2 - n.y }
}

/** A linked card in the motion: where it is in the store. */
type Ride = { id: string; x: number; y: number }

/** Plays the motion on storyline `nodeId`: drawn each frame, its cards
 *  animated from where they are in the store to `at` (canvas units) on the
 *  compositor; then `done`. `hold` keeps the cards where they end up until
 *  they go (a fold). */
function playChart(nodeId: string, to: { x: number; y: number }, ride: Ride[], at: (c: Ride, t: number) => { x: number; y: number; o: number }, phase: (t: number) => Phase, hold: boolean, done: () => void): void {
  const zoom = useCanvasStore.getState().zoom
  const N = 18
  const frames = new Map(ride.map(c => [c.id, Array.from({ length: N + 1 }, (_, i) => {
    const p = at(c, i / N)
    return { transform: `translate(${(p.x - c.x) * zoom}px, ${(p.y - c.y) * zoom}px)`, o: p.o }
  })]))
  // Each card's elements ride; one drawn anew part way (React may redraw a
  // card it has just put down) picks the ride up where it has got to, and
  // is hidden till then, so no card shows before its time (Brian
  // 2026-11-05: showing, the cards are the very last thing to appear;
  // folding, the very first to go).
  // A card on its own, or a closed or fanned deck it fronts (Brian
  // 2026-11-05: decks were left behind), with its header and chips.
  const sel = (id: string) => `[data-layer-card="${id}"], [data-group-card][data-id="${id}"], [data-card-header="${id}"], [data-primary-rail="${id}"]`
  const hide = document.createElement('style')
  hide.textContent = `${ride.flatMap(c => sel(c.id).split(', ').map(x => `${x}:not([data-chart-riding])`)).join(', ')} { opacity: 0 !important; }`
  if (ride.length) document.head.appendChild(hide)
  const fades: Animation[] = []
  const riding = new WeakSet<Element>()
  const ridden = (ms: number) => {
    for (const [id, f] of frames) {
      for (const el of document.querySelectorAll(sel(id))) {
        if (riding.has(el)) continue
        riding.add(el)
        el.setAttribute('data-chart-riding', '')
        const how = { duration: MOTION_MS, easing: 'linear', fill: hold ? 'forwards' : 'none' } as const
        const a = (el as HTMLElement).animate(f.map(k => ({ transform: k.transform })), { ...how, composite: 'add' })
        const b = (el as HTMLElement).animate(f.map(k => ({ opacity: k.o })), { ...how, fill: 'forwards' })
        fades.push(b)
        a.currentTime = ms
        b.currentTime = ms
      }
    }
  }
  play(MOTION_MS, (t, ms) => { ridden(ms); setChartMotion(nodeId, { ...phase(t), to }) }, () => {
    // Showing, the cards stay shown; folding, hidden till they go.
    if (!hold) { hide.remove(); fades.forEach(b => b.cancel()); document.querySelectorAll('[data-chart-riding]').forEach(e => e.removeAttribute('data-chart-riding')) }
    done()
    if (hold) requestAnimationFrame(() => hide.remove())
  })
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

/** Storyline `nodeId` as a chart (utils/chartData), as it stands now: its
 *  cards kept by their masters' ids. Null when no card is on it. */
export function chartOfStoryline(nodeId: string, cardsOf: CardsOfDots): ChartData | null {
  return chartFrom(nodeId, cardsOf)?.chart ?? null
}

function chartFrom(nodeId: string, cardsOf: CardsOfDots) {
  const n = useFreeNodeStore.getState().nodes[nodeId]
  const d = n?.storyline
  if (!n || !d) return null
  const groups = useBoardsStore.getState().groups
  const byId = new Map(groups.map(g => [g.id, g]))
  // A shown chart is its linked cards only (Brian 2026-11-09: "anything
  // that's on there needs a link"), its linked decks' cards included; a card
  // that is not a link never joins because it sits touching or under one.
  const keep = (id: string) => !d.chartCard || !!byId.get(id)?.linkOf
  const on = new Map([...cardsOf(d, new Set(d.dots.map(p => p.id)))].filter(([id]) => keep(id)))
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
      ...(g.deckLock && (g.deckLock === g.id || onMasters.has(master(g.deckLock))) ? { deckLock: master(g.deckLock) } : {}),
    })
  }

  // Each dot's group, top to bottom; the card linked to the dot leads it.
  const tiers: ChartTier[] = []
  const tiered = new Set<string>()
  for (const p of [...d.dots].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (!p.cards?.length) continue
    const lead = p.cards.map(master)
    const rest = [...cardsOf(d, new Set([p.id])).keys()].filter(keep).map(master)
    const cards = [...new Set([...lead, ...rest])].filter(c => !tiered.has(c))
    cards.forEach(c => tiered.add(c))
    if (cards.length) tiers.push({ dot: p.id, title: p.title ?? '', cards })
  }

  const { id: _id, ...rest } = n
  void _id
  const storyline: StorylineData = { ...d, chartCard: undefined, dots: d.dots.map(p => ({ ...p, cards: p.cards?.map(master) })) }
  // A chart that was shown keeps its locks as they were left; one baked
  // from a plain storyline comes out locked the first time.
  const chart: ChartData = { title: chartTitle(n), node: { ...rest, storyline }, places, tiers, ...(d.chartCard ? { lockSet: true } : {}) }
  return { chart, n, d, on, onMasters, byId }
}

/** Folds storyline `nodeId` into its card. Returns the card's id, or null
 *  when no card is on it. */
export function bakeStoryline(nodeId: string, cardsOf: CardsOfDots): string | null {
  if (moving) return null
  const got = chartFrom(nodeId, cardsOf)
  if (!got) return null
  const { chart, n, d, on, onMasters, byId } = got
  const tiers = chart.tiers

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
      // A family's tree (utils/familySpine) folds back in as its chart
      // only: kin, not command, so no reporting lines or sections.
      if (g.cardType === 'family') return { ...g, chart, linkedGroupIds: [...new Set([...(g.linkedGroupIds ?? []).filter(x => !old.has(x)), ...members])] }
      const tree: Record<string, string[]> = { ...(g.reportsTo ?? {}) }
      for (const t of tiers) for (const c of t.cards.slice(1)) if (!(tree[c] ?? []).some(b => t.cards.includes(b)) && !isAbove({ ...g, reportsTo: tree }, c, t.cards[0])) tree[c] = [t.cards[0]]
      const kept = (g.factionGroups ?? []).map(x => ({ ...x, cards: x.cards.filter(c => !onMasters.has(c) && !old.has(c)) })).filter(x => x.cards.length)
      return {
        ...g, chart, reportsTo: tree, factionGroups: [...fgs, ...kept],
        linkedGroupIds: [...new Set([...(g.linkedGroupIds ?? []).filter(x => !old.has(x)), ...members])],
      }
    }),
  }))

  // The linked cards go into the card, then the line goes (its points
  // drop to the base line as it slides into the card's side), and they go.
  // The masters stay where they are.
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
  const ride: Ride[] = links.map(g => ({ id: g.id, x: g.originX, y: g.originY }))
  const to = sideOf(home, n)
  moving = true
  const order = popOrder(ride, false)
  playChart(nodeId, to, ride, (c, t) => ({ x: c.x, y: c.y, o: cardsGone(order.get(c.id) ?? 0, ride.length, t) }), foldAt, true, gone)
  return cardId
}

/** Chart `chart` laid out on the canvas, its storyline's node at `pos`:
 *  a new storyline, filled with new LINKED cards showing its masters, each
 *  where it sat, in its deck as it was. `chartCard`: the card it comes out
 *  of (absent: a storyline of its own, a pasted copy). Returns the
 *  storyline's id and the linked cards' places. */
function layChart(chart: ChartData, pos: { x: number; y: number }, chartCard?: string) {
    const card = chartCard ? useBoardsStore.getState().groups.find(g => g.id === chartCard) : undefined
    const link = new Map<string, string>()
    for (const p of chart.places) {
      const id = makeLinkedCard(p.card)
      if (id) link.set(p.card, id)
    }
    const at = new Map(chart.places.map(p => [link.get(p.card), p]))
    const node = { ...chart.node, x: pos.x, y: pos.y }
    useBoardsStore.setState(s => ({
      groups: s.groups.map((g): ProjectGroup => {
        const p = at.get(g.id)
        if (!p) return g
        const anchor = p.deckAnchorId ? link.get(p.deckAnchorId) : undefined
        return {
          ...g,
          originX: node.x + p.dx, originY: node.y + p.dy,
          // Its master's shape now, at the size it was shown (linkedCards).
          cardWidthOverride: p.w, cardHeightOverride: linkedHeight(p.card, p.w, p.h), flipped: p.flipped,
          deckState: anchor ? p.deckState : undefined,
          deckAnchorId: anchor,
          deckOffsetX: anchor ? p.deckOffsetX : undefined,
          deckOffsetY: anchor ? p.deckOffsetY : undefined,
          nestedDeck: anchor ? p.nestedDeck : undefined,
          deckLastFront: p.deckLastFront ? link.get(p.deckLastFront) : undefined,
          deckLock: p.deckLock ? link.get(p.deckLock) : undefined,
        }
      }),
    }))
    const fs = useFreeNodeStore.getState()
    const id = fs.addFreeNode(node.x, node.y, 'storyline')
    const d = node.storyline!
    const live: StorylineData = { ...d, chartCard, dots: d.dots.map(p => ({ ...p, cards: p.cards?.flatMap(c => link.get(c) ?? []) })) }
    fs.updateFreeNode(id, { ...node, storyline: live })
    if (chartCard && card) setChartMotion(id, { ...showAt(0), to: sideOf(card, node) })
    return { id, at, node }
}

/** Pastes a copy of chart `chart` (copied with chartOfStoryline), its
 *  storyline's node at `pos`: the same storyline, with LINKED cards showing
 *  the same masters (Brian 2026-11-06: "an exact duplicate"), in their
 *  decks and locks as they were. A storyline of its own, from no card.
 *  The caller takes the undo checkpoint. Returns the new storyline's id. */
export function pasteChart(chart: ChartData, pos: { x: number; y: number }): string {
  return layChart(chart, pos).id
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
  const { id, at, node } = flushSync(() => layChart(chart, chart.node, cardId))
  // The line slides out of the card's side and its points rise to their
  // places; then the cards jump out to theirs.
  const ride: Ride[] = useBoardsStore.getState().groups.filter(g => at.has(g.id))
    .map(g => ({ id: g.id, x: g.originX, y: g.originY }))
  moving = true
  const order = popOrder(ride, true)
  playChart(id, sideOf(card, node), ride, (c, t) => ({ x: c.x, y: c.y, o: cardsShown(order.get(c.id) ?? 0, ride.length, t) }), showAt, false, () => {
    setChartMotion(id, null); moving = false
    // Shown for the first time: it comes out locked (Brian 2026-11-05).
    if (!chart.lockSet) lockChains(id)
  })
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

/** Match master decks (Brian 2026-11-10, utils/chartMatch): card `cardId`'s
 *  chart, out or folded, takes the layout its master decks have now: each
 *  dot's deck as its masters sit and are sized, from the dot's own card,
 *  which stays as it is. Linked cards only; the masters are read, never
 *  moved. Returns how many cards it changes (`dry`: would change, nothing
 *  written). One undo. */
export function matchChart(cardId: string, cardsOf: CardsOfDots, dry = false): number {
  const bs = useBoardsStore.getState()
  const card = bs.groups.find(g => g.id === cardId)
  if (!card?.chart || moving) return 0
  const out = chartOutOf(cardId)
  const got = out ? chartFrom(out, cardsOf) : null
  if (out && !got) return 0
  const chart = got?.chart ?? card.chart
  const next = matchedPlaces(chart, bs.groups, bs.boards, useCanvasStore.getState().zoom)
  if (dry || next.size === 0) return next.size
  useUndoCoordinator.getState().checkpoint()
  if (!got) {
    useBoardsStore.setState(s => ({
      groups: s.groups.map(g => g.id === cardId && g.chart ? { ...g, chart: { ...g.chart, places: g.chart.places.map(p => next.get(p.card) ?? p) } } : g),
    }))
    return next.size
  }
  // Out: its linked cards, the first showing of each master (as chartFrom
  // reads them).
  const patch = new Map<string, Partial<ProjectGroup>>()
  const done = new Set<string>()
  for (const id of got.on.keys()) {
    const g = got.byId.get(id)
    const m = masterOf(bs.groups, id)
    const p = next.get(m)
    if (!g || !p || done.has(m)) continue
    done.add(m)
    patch.set(id, {
      originX: got.n.x + p.dx, originY: got.n.y + p.dy,
      cardWidthOverride: p.w, cardHeightOverride: linkedHeight(m, p.w, p.h),
      ...(g.deckAnchorId && p.deckOffsetX != null && p.deckOffsetY != null ? { deckOffsetX: p.deckOffsetX, deckOffsetY: p.deckOffsetY } : {}),
    })
  }
  useBoardsStore.setState(s => ({ groups: s.groups.map(g => patch.has(g.id) ? { ...g, ...patch.get(g.id)! } : g) }))
  return next.size
}

/** Erases the chart baked into card `cardId` (Brian 2026-11-09, "Erase
 *  chart layout"): its layout only, the dots, lines and where each card
 *  sat. The card, its members, who reports to whom and its sections stay,
 *  and so do the cards themselves. A "+ chart" rank detail that read this
 *  chart keeps the number it showed, as plain text. Not while the chart is
 *  out. One undo. */
export function eraseChart(cardId: string): boolean {
  const bs = useBoardsStore.getState()
  const card = bs.groups.find(g => g.id === cardId)
  if (!card?.chart || chartOutOf(cardId)) return false
  useUndoCoordinator.getState().checkpoint()
  useBoardsStore.setState(s => ({
    groups: s.groups.map(g => {
      if (g.id === cardId) { const { chart: _c, ...rest } = g; void _c; return rest as ProjectGroup }
      if (!g.details?.some(d => d.link?.card === cardId && d.link.rankOf)) return g
      return { ...g, details: g.details.map(d => {
        if (d.link?.card !== cardId || !d.link.rankOf) return d
        const r = chartRank(card, d.link.rankOf)
        const { link: _l, ...plain } = d; void _l
        return { ...plain, value: r ? rankText(r) : d.value }
      }) }
    }),
  }))
  return true
}
