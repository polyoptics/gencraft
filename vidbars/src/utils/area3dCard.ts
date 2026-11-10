// 3D area cards (Brian 2026-11-08): a 3D area (the mat that is a 3D
// workspace, freeNodeStore 'area') folds into a card and comes back out of
// it, as a chart does (utils/chartCard), so a scene layout can go into a
// deck, a scene card or a state like any card.
//
// Fold: the card keeps the mat (where it comes out, its size) and what
// lies on it: each card's master (utils/linkedCards) where it lay, its deck
// as it was, and how its model stands (size and turn, tiltStore
// useModelScaleStore); tiles on it (an old model tile, a picture) whole.
// Linked cards and tiles on it go with it; master cards stay where they
// are, free to move away (as a chart's do).
//
// Show: the mat comes back where it was, with LINKED cards of those
// masters, each where it lay, turned and sized as it was, and the tiles.
// Moving the card takes its 3D area along (out or folded).

import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { useCanvasStore } from '../store/canvasStore'
import { isUndoRestoring, useUndoCoordinator } from '../store/undoCoordinator'
import { useModelScaleStore, type ScenePlace, type CameraLens } from '../store/tiltStore'
import { cardBox, isUnder, laying, lyingIn, setCards } from './area3dScene'
import { cardFaceSize, createTextCard } from './cardGrid'
import { makeLinkedCard, masterOf } from './linkedCards'

type Quat = [number, number, number, number]

/** A card on a folded 3D area: its master, where it lay (from the mat's
 *  top-left), its size and deck as it was, and how its model stood. */
export interface Area3dCardItem {
  card: string
  dx: number; dy: number
  w?: number; h?: number
  flipped?: boolean
  deckState?: ProjectGroup['deckState']
  deckAnchorId?: string
  deckOffsetX?: number; deckOffsetY?: number
  nestedDeck?: ProjectGroup['nestedDeck']
  deckLastFront?: string
  size?: number
  pose?: Quat
  /** Its model colour (tiltStore tintOf). */
  tint?: string
  /** Where its model stands in the scene (tiltStore placeOf). */
  place?: ScenePlace
  /** Stretched along its own axes (tiltStore stretchOf). */
  stretch?: [number, number, number]
  /** A camera's lens (tiltStore lensOf). */
  lens?: CameraLens
}
/** A tile on a folded 3D area, whole, where it lay. */
export interface Area3dTileItem {
  tile: Omit<FreeNodeData, 'id'>
  dx: number; dy: number
  size?: number
  pose?: Quat
  /** Its model colour (tiltStore tintOf). */
  tint?: string
  /** Where its model stands in the scene (tiltStore placeOf). */
  place?: ScenePlace
  /** Stretched along its own axes (tiltStore stretchOf). */
  stretch?: [number, number, number]
  /** A camera's lens (tiltStore lensOf). */
  lens?: CameraLens
}
export interface Area3dData {
  /** The mat: where it comes out (top-left), its size and look. */
  mat: { x: number; y: number; width: number; height: number; color?: string; label?: string }
  cards: Area3dCardItem[]
  tiles: Area3dTileItem[]
}

/** The 3D area out of card `cardId`, if it is out. */
export function area3dOutOf(cardId: string): string | null {
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) if (n.type === 'area' && n.areaCard === cardId) return n.id
  return null
}

const inside = (a: FreeNodeData, x: number, y: number) => x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height

/** What lies on 3D area `a`: its cards (the corner as areaFollow reads it)
 *  and tiles (their middle), not the card it came out of. */
function onMat(a: FreeNodeData) {
  const fs = useFreeNodeStore.getState()
  const { groups, boards } = useBoardsStore.getState()
  // On it, and the model cards docked along its sides.
  const cards = setCards(a, groups, boards, a.areaCard)
  const tiles = Object.values(fs.nodes).filter(n => n.id !== a.id && n.type !== 'area' && n.type !== 'storyline' && !n.pin && n.areaCard === undefined && !isUnder(a, `node:${n.id}`) && inside(a, n.x + n.width / 2, n.y + n.height / 2))
  return { cards, tiles }
}

/** Folds 3D area `nodeId` into its card (a new 3D area card under it when
 *  it came out of none). Returns the card's id. */
export function foldArea3d(nodeId: string): string | null {
  const fs = useFreeNodeStore.getState()
  const a = fs.nodes[nodeId]
  if (!a || a.type !== 'area') return null
  useUndoCoordinator.getState().checkpoint()
  const bs = useBoardsStore.getState()
  let cardId = a.areaCard && bs.groups.some(g => g.id === a.areaCard) ? a.areaCard : null
  if (!cardId) {
    const size = cardFaceSize()
    cardId = createTextCard({ cx: a.x + size.w / 2, cy: a.y + a.height + size.h * 0.75 }, { title: a.label && a.label !== 'Area' && a.label !== '3D area' && a.label !== '3D scene' ? a.label : '3D set' })
    useFreeNodeStore.getState().updateFreeNode(nodeId, { areaCard: cardId })
    useBoardsStore.getState().setCardsType([cardId], 'area3d')
  }
  const { cards, tiles } = onMat(a)
  const ms = useModelScaleStore.getState()
  const groups = useBoardsStore.getState().groups
  const master = (id: string) => masterOf(groups, id)
  const onMasters = new Set(cards.map(g => master(g.id)))
  const seen = new Set<string>()
  const cardItems: Area3dCardItem[] = []
  for (const g of cards) {
    const m = master(g.id)
    if (seen.has(m)) continue
    seen.add(m)
    const anchor = g.deckAnchorId ? master(g.deckAnchorId) : undefined
    const inDeck = !!anchor && onMasters.has(anchor)
    cardItems.push({
      card: m, dx: g.originX - a.x, dy: g.originY - a.y,
      w: g.cardWidthOverride, h: g.cardHeightOverride, flipped: g.flipped,
      ...(inDeck ? { deckState: g.deckState, deckAnchorId: anchor, deckOffsetX: g.deckOffsetX, deckOffsetY: g.deckOffsetY, nestedDeck: g.nestedDeck } : {}),
      ...(g.deckLastFront && onMasters.has(master(g.deckLastFront)) ? { deckLastFront: master(g.deckLastFront) } : {}),
      ...((ms.setSizeOf[`card:${g.id}`] ?? ms.sizeOf[`card:${g.id}`]) !== undefined ? { size: ms.setSizeOf[`card:${g.id}`] ?? ms.sizeOf[`card:${g.id}`] } : {}),
      ...(ms.poseOf[`card:${g.id}`] ? { pose: ms.poseOf[`card:${g.id}`] } : {}),
      ...(ms.tintOf[`card:${g.id}`] ? { tint: ms.tintOf[`card:${g.id}`] } : {}),
      ...(ms.placeOf[`card:${g.id}`] ? { place: ms.placeOf[`card:${g.id}`] } : {}),
      ...(ms.stretchOf[`card:${g.id}`] ? { stretch: ms.stretchOf[`card:${g.id}`] } : {}),
      ...(ms.lensOf[`card:${g.id}`] ? { lens: ms.lensOf[`card:${g.id}`] } : {}),
    })
  }
  const tileItems: Area3dTileItem[] = tiles.map(n => {
    const { id: _id, ...tile } = n
    void _id
    return {
      tile, dx: n.x - a.x, dy: n.y - a.y,
      ...((ms.setSizeOf[`node:${n.id}`] ?? ms.sizeOf[`node:${n.id}`]) !== undefined ? { size: ms.setSizeOf[`node:${n.id}`] ?? ms.sizeOf[`node:${n.id}`] } : {}),
      ...(ms.poseOf[`node:${n.id}`] ? { pose: ms.poseOf[`node:${n.id}`] } : {}),
      ...(ms.tintOf[`node:${n.id}`] ? { tint: ms.tintOf[`node:${n.id}`] } : {}),
      ...(ms.placeOf[`node:${n.id}`] ? { place: ms.placeOf[`node:${n.id}`] } : {}),
      ...(ms.stretchOf[`node:${n.id}`] ? { stretch: ms.stretchOf[`node:${n.id}`] } : {}),
      ...(ms.lensOf[`node:${n.id}`] ? { lens: ms.lensOf[`node:${n.id}`] } : {}),
    }
  })
  const data: Area3dData = {
    mat: { x: a.x, y: a.y, width: a.width, height: a.height, color: a.color, label: a.label },
    cards: cardItems, tiles: tileItems,
  }
  writing = true
  try { useBoardsStore.setState(s => ({ groups: s.groups.map(g => g.id === cardId ? { ...g, area3d: data } : g) })) } finally { writing = false }
  clearMat(nodeId)
  return cardId
}

/** Takes 3D area `nodeId` off the canvas: its linked cards and tiles go
 *  with it; master cards stay. */
function clearMat(nodeId: string, withTiles = true) {
  const a = useFreeNodeStore.getState().nodes[nodeId]
  if (!a) return
  const { cards, tiles } = onMat(a)
  clearing = true
  try {
    for (const g of cards) {
      if (!g.linkOf) continue
      g.boardIds.forEach(bid => useBoardsStore.getState().deleteBoard(bid))
      useBoardsStore.getState().deleteGroup(g.id)
    }
    if (withTiles) for (const n of tiles) useFreeNodeStore.getState().deleteFreeNode(n.id)
    useFreeNodeStore.getState().deleteFreeNode(nodeId)
  } finally { clearing = false }
}

// ── A 3D set and its card are one (Brian 2026-11-10) ──
// Made together: a new 3D set comes with its card. Deleted together: the
// card deleted, its set goes from the canvas (with the linked cards it
// brought out; master cards and the tiles on it stay); the set deleted,
// its card goes. Folding the set into its card deletes nothing.

/** clearMat is at work (a fold, a card deleted): the deletes are its own. */
let clearing = false

/** Gives new 3D set `nodeId` its card, just under its bottom-left corner
 *  (where folding one without a card put it). Returns the card's id. */
export function bundleArea3dCard(nodeId: string): string | null {
  const a = useFreeNodeStore.getState().nodes[nodeId]
  if (!a || a.type !== 'area' || a.areaCard) return null
  const size = cardFaceSize()
  const cardId = createTextCard({ cx: a.x + size.w / 2, cy: a.y + a.height + size.h * 0.75 }, { title: '3D set' })
  useBoardsStore.getState().setCardsType([cardId], 'area3d')
  useFreeNodeStore.getState().updateFreeNode(nodeId, { areaCard: cardId })
  return cardId
}

/** Deleting a 3D set's card or its ground deletes the other. The stores'
 *  own delete actions, wrapped once: only a delete someone asked for, never
 *  a load or an undo. */
export function startArea3dBundle(): void {
  const w = window as unknown as { __a3dBundle?: boolean }
  if (w.__a3dBundle) return
  w.__a3dBundle = true
  const delGroup = useBoardsStore.getState().deleteGroup
  const delNode = useFreeNodeStore.getState().deleteFreeNode
  useBoardsStore.setState({
    deleteGroup: (groupId: string) => {
      const out = clearing ? null : area3dOutOf(groupId)
      delGroup(groupId)
      // The tiles on it are kept nowhere else: they stay on the canvas.
      if (out && !useBoardsStore.getState().groups.some(g => g.id === groupId)) clearMat(out, false)
    },
  })
  useFreeNodeStore.setState({
    deleteFreeNode: (id: string) => {
      const n = useFreeNodeStore.getState().nodes[id]
      delNode(id)
      if (clearing || n?.type !== 'area' || !n.areaCard || useFreeNodeStore.getState().nodes[id]) return
      const card = useBoardsStore.getState().groups.find(g => g.id === n.areaCard)
      if (!card) return
      clearing = true
      try {
        card.boardIds.forEach(bid => useBoardsStore.getState().deleteBoard(bid))
        delGroup(card.id)
      } finally { clearing = false }
    },
  })
}

/** Folding writes the card's layout; any other change to it (a State
 *  card's output turned to another state, another showing of the same card
 *  folded) lays the 3D area out again from what the card now holds. */
let writing = false

/** Where a 3D area comes out of a card that has none yet: an empty mat
 *  just right of the card's top-right corner. */
function freshMat(card: ProjectGroup): Area3dData {
  const w = card.cardWidthOverride ?? cardFaceSize().w
  // Clear of the card as it is drawn now (zoomed in, a card opens up wider
  // than its face: the area came out under it, Brian 2026-11-09), and
  // sized to the card, not to the zoom it is shown at.
  const box = cardBox(card)
  const right = Math.max(card.originX + w, box ? box.x + box.width : -Infinity)
  const width = w * 6.4, height = width * 9 / 14
  return { mat: { x: right + w * 0.15, y: card.originY, width, height }, cards: [], tiles: [] }
}

/** Where card `card`'s 3D area comes out, and the room it takes (canvas
 *  units): where it was folded, or, never out yet, beside the card. The
 *  dashed outline shown before it opens (Brian 2026-11-10). */
export function area3dSpot(card: ProjectGroup): { x: number; y: number; w: number; h: number } {
  const m = (card.area3d ?? freshMat(card)).mat
  return { x: m.x, y: m.y, w: m.width, h: m.height }
}

/** Brings card `cardId`'s 3D area out (an empty one the first time).
 *  Returns the mat's id. */
export function showArea3d(cardId: string, quiet = false, spot?: { x: number; y: number }, under?: string[]): string | null {
  const card = useBoardsStore.getState().groups.find(g => g.id === cardId)
  if (!card || area3dOutOf(cardId)) return null
  if (!quiet) useUndoCoordinator.getState().checkpoint()
  const d0 = card.area3d ?? freshMat(card)
  // Laid out anew where the one before stood (a state turned).
  const data = spot ? { ...d0, mat: { ...d0.mat, x: spot.x, y: spot.y } } : d0
  const fs = useFreeNodeStore.getState()
  const m = data.mat
  // What already lies there stays out of the scene (Brian 2026-11-10); laid
  // out anew, what was under it before still is.
  const below = under ?? lyingIn(m, cardId)
  let id = ''
  laying.on = true
  try {
    id = fs.addFreeNode(m.x, m.y, 'area')
    fs.updateFreeNode(id, { x: m.x, y: m.y, width: m.width, height: m.height, areaCard: cardId, label: m.label ?? card.name ?? '3D set', ...(m.color ? { color: m.color } : {}), ...(below.length ? { under: below } : {}) })
  } finally { laying.on = false }
  // The cards it brings out never join a row with the cards under it.
  const belowCards = below.filter(k => k.startsWith('card:')).map(k => k.slice(5))
  const ms = useModelScaleStore.getState()
  // Its cards: linked showings of the masters (a master gone is skipped).
  const link = new Map<string, string>()
  for (const p of data.cards) {
    const lid = makeLinkedCard(p.card)
    if (lid) link.set(p.card, lid)
  }
  const at = new Map(data.cards.map(p => [link.get(p.card), p]))
  useBoardsStore.setState(s => ({
    groups: s.groups.map((g): ProjectGroup => {
      const p = at.get(g.id)
      if (!p) return g
      const anchor = p.deckAnchorId ? link.get(p.deckAnchorId) : undefined
      return {
        ...g, originX: m.x + p.dx, originY: m.y + p.dy,
        cardWidthOverride: p.w, cardHeightOverride: p.h, flipped: p.flipped,
        deckState: anchor ? p.deckState : undefined, deckAnchorId: anchor,
        deckOffsetX: anchor ? p.deckOffsetX : undefined, deckOffsetY: anchor ? p.deckOffsetY : undefined,
        nestedDeck: anchor ? p.nestedDeck : undefined,
        deckLastFront: p.deckLastFront ? link.get(p.deckLastFront) : undefined,
        ...(belowCards.length ? { rowUnder: belowCards } : {}),
      }
    }),
  }))
  for (const [lid, p] of at) {
    if (!lid) continue
    if (p.size !== undefined) ms.setSetSize(`card:${lid}`, p.size)
    if (p.pose) ms.setPose(`card:${lid}`, p.pose)
    if (p.tint) ms.setTint(`card:${lid}`, p.tint)
    if (p.place) ms.setPlace(`card:${lid}`, p.place)
    if (p.stretch) ms.setStretch(`card:${lid}`, p.stretch)
    if (p.lens) ms.setLens(`card:${lid}`, p.lens)
  }
  // Its tiles, whole.
  for (const t of data.tiles) {
    const nid = fs.addFreeNode(m.x + t.dx, m.y + t.dy, t.tile.type)
    useFreeNodeStore.getState().updateFreeNode(nid, { ...t.tile, x: m.x + t.dx, y: m.y + t.dy })
    if (t.size !== undefined) ms.setSetSize(`node:${nid}`, t.size)
    if (t.pose) ms.setPose(`node:${nid}`, t.pose)
    if (t.tint) ms.setTint(`node:${nid}`, t.tint)
    if (t.place) ms.setPlace(`node:${nid}`, t.place)
    if (t.lens) ms.setLens(`node:${nid}`, t.lens)
    if (t.stretch) ms.setStretch(`node:${nid}`, t.stretch)
  }
  return id
}

// ── The motion (Brian 2026-11-09: the set's frame minimizes onto the card) ──
// Folding, the mat and what is on it (its linked cards and tiles; the
// master cards stay on the canvas) shrink as ONE picture into the card,
// keeping their places on the mat, and fade at the very end, then fold.
// Showing, the set grows out of the card the same way, backwards.

const MOTION_MS = 460
const sel = (kind: 'card' | 'node', id: string) => kind === 'node'
  ? [`[data-freenode][data-id="${id}"]`]
  : [`[data-layer-card="${id}"]`, `[data-group-card][data-id="${id}"]`, `[data-card-header="${id}"]`, `[data-primary-rail="${id}"]`, `[data-row-of="${id}"]`, `[data-row-band="${id}"]`]
type Rider = { kind: 'card' | 'node'; id: string; cx: number; cy: number }
let moving = false

/** The card's middle, canvas units. */
function middleOf(g: ProjectGroup) {
  const size = cardFaceSize()
  return { x: g.originX + (g.cardWidthOverride ?? size.w) / 2, y: g.originY + (g.cardHeightOverride ?? size.h) / 2 }
}

/** How small mat `a` gets to sit on card `g`'s face. */
function fitInto(a: FreeNodeData, g: ProjectGroup) {
  const size = cardFaceSize()
  return Math.min((g.cardWidthOverride ?? size.w) / a.width, (g.cardHeightOverride ?? size.h) / a.height) * 0.9
}

/** What rides with mat `a`: the mat, its linked cards and its tiles. */
function riders(a: FreeNodeData): Rider[] {
  const size = cardFaceSize()
  const { cards, tiles } = onMat(a)
  return [
    { kind: 'node', id: a.id, cx: a.x + a.width / 2, cy: a.y + a.height / 2 },
    ...cards.filter(g => g.linkOf).map(g => ({ kind: 'card' as const, id: g.id, cx: g.originX + (g.cardWidthOverride ?? size.w) / 2, cy: g.originY + (g.cardHeightOverride ?? size.h) / 2 })),
    ...tiles.map(n => ({ kind: 'node' as const, id: n.id, cx: n.x + n.width / 2, cy: n.y + n.height / 2 })),
  ]
}

/** Plays riders `rs` between where they are and card middle `to` (in:
 *  out of the card; else into it), then `done`. Elements drawn part way
 *  pick the motion up where it has got to, hidden till then. */
function ride(rs: Rider[], to: { x: number; y: number }, out: boolean, done: () => void, k = 0.12) {
  const zoom = useCanvasStore.getState().zoom
  // The mat (first rider) shrinks to `k` of its size onto the card's
  // middle; everything else keeps its place on it, so it is one picture.
  const from = rs[0] ? { x: rs[0].cx, y: rs[0].cy } : to
  const frames = (r: Rider, el: HTMLElement) => {
    // Scaled about its own transform origin (a mat's is its corner), so
    // its middle is put right: d = middle less origin, px.
    const o = getComputedStyle(el).transformOrigin.split(' ').map(parseFloat)
    const dx = el.offsetWidth / 2 - (o[0] || 0), dy = el.offsetHeight / 2 - (o[1] || 0)
    // Screen px per px of its own: tiles sit in the zoomed canvas, cards not.
    const u = el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1
    const z = zoom / (u || 1)
    const x = (to.x + (r.cx - from.x) * k - r.cx) * z + dx * (1 - k), y = (to.y + (r.cy - from.y) * k - r.cy) * z + dy * (1 - k)
    const away = { transform: `translate(${x}px, ${y}px) scale(${k})` }
    const home = { transform: 'translate(0px, 0px) scale(1)' }
    return out ? [away, home] : [home, away]
  }
  // Seen the whole way, gone only at the card.
  const fade: Keyframe[] = out
    ? [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 1 }]
    : [{ opacity: 1 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }]
  const all = rs.flatMap(r => sel(r.kind, r.id).map(q => ({ r, q })))
  const hide = document.createElement('style')
  hide.textContent = `${all.map(x => `${x.q}:not([data-a3-riding])`).join(', ')} { opacity: 0 !important; }`
  if (out && all.length) document.head.appendChild(hide)
  const anims: Animation[] = []
  const clock = document.documentElement.animate([], { duration: MOTION_MS })
  let over = false
  const catchUp = () => {
    const t = Number(clock.currentTime ?? 0)
    for (const { r, q } of all) {
      for (const el of document.querySelectorAll<HTMLElement>(q)) {
        if (el.hasAttribute('data-a3-riding')) continue
        el.setAttribute('data-a3-riding', '')
        const f = frames(r, el)
        const how = { duration: MOTION_MS, easing: 'cubic-bezier(0.55, 0, 0.25, 1)', fill: 'forwards' } as const
        const a = el.animate(f, { ...how, composite: 'add' })
        const b = el.animate(fade, { ...how, easing: 'linear' })
        a.currentTime = t; b.currentTime = t
        anims.push(a, b)
      }
    }
    if (!over) requestAnimationFrame(catchUp)
  }
  catchUp()
  const end = () => {
    over = true
    done()
    // A frame later (what folded is gone by then): back to as drawn.
    requestAnimationFrame(() => {
      hide.remove()
      anims.forEach(x => x.cancel())
      document.querySelectorAll('[data-a3-riding]').forEach(e => e.removeAttribute('data-a3-riding'))
    })
  }
  clock.finished.then(end, end)
}

/** Fold 3D area `nodeId` into its card, with the motion; `then` runs
 *  once it is folded in. */
export function foldArea3dMoving(nodeId: string, then?: () => void): void {
  const a = useFreeNodeStore.getState().nodes[nodeId]
  if (!a || a.type !== 'area' || moving) return
  const card = a.areaCard ? useBoardsStore.getState().groups.find(g => g.id === a.areaCard) : undefined
  const size = cardFaceSize()
  // No card yet: where the new one goes (foldArea3d).
  const to = card ? middleOf(card) : { x: a.x + size.w / 2, y: a.y + a.height + size.h * 0.75 }
  moving = true
  const fit = card ? fitInto(a, card) : Math.min(size.w / a.width, size.h / a.height)
  ride(riders(a), to, false, () => { moving = false; foldArea3d(nodeId); then?.() }, fit)
}

/** Show card `cardId`'s 3D area, with the motion. */
export function showArea3dMoving(cardId: string): void {
  if (moving) return
  const id = showArea3d(cardId)
  const a = id ? useFreeNodeStore.getState().nodes[id] : undefined
  const card = useBoardsStore.getState().groups.find(g => g.id === cardId)
  if (!a || !card) return
  moving = true
  ride(riders(a), middleOf(card), true, () => { moving = false }, fitInto(a, card))
}

/** Show or fold card `cardId`'s 3D area. */
export function toggleArea3d(cardId: string): void {
  const out = area3dOutOf(cardId)
  if (out) foldArea3dMoving(out); else showArea3dMoving(cardId)
}

/** A 3D scene card that is an open deck's primary: folding its scene
 *  closes the deck too, in one (Brian 2026-11-09). `row` = the deck's
 *  cards, the scene card first. The deck closes once the scene is in, so
 *  the scene's own cards are gone from it by then. No scene out: false. */
export function foldArea3dAndDeck(cardId: string, row: string[]): boolean {
  const out = area3dOutOf(cardId)
  if (!out) return false
  foldArea3dMoving(out, () => {
    const gs = useBoardsStore.getState().groups
    const left = row.filter(id => gs.some(g => g.id === id))
    if (left.length > 1) useBoardsStore.getState().setDeckState(left, 'stacked')
  })
  return true
}

/** A 3D area card moving takes its 3D area along: out, the mat (and what
 *  is on it, utils/areaFollow); folded, where it comes out. Not while the
 *  mat is selected too (a drag of both moves both), nor on undo. */
export function startArea3dFollow(): () => void {
  const seen = (gs: ProjectGroup[]) => {
    const m = new Map<string, { x: number; y: number; data: Area3dData | undefined }>()
    for (const g of gs) if (g.cardType === 'area3d' || g.area3d) m.set(g.id, { x: g.originX, y: g.originY, data: g.area3d })
    return m
  }
  let last = seen(useBoardsStore.getState().groups)
  let busy = false
  return useBoardsStore.subscribe(s => {
    if (busy) return
    const now = seen(s.groups)
    const moves: { id: string; dx: number; dy: number }[] = []
    const relay: string[] = []
    if (!isUndoRestoring()) {
      for (const [id, p] of now) {
        const q = last.get(id)
        if (q && (q.x !== p.x || q.y !== p.y)) moves.push({ id, dx: p.x - q.x, dy: p.y - q.y })
        // Its layout changed under a 3D area that is out: lay it out anew.
        if (q && q.data !== p.data && p.data && !writing && area3dOutOf(id)) relay.push(id)
      }
    }
    last = now
    if (relay.length) {
      busy = true
      try {
        for (const id of relay) {
          const out = area3dOutOf(id)
          const n = out ? useFreeNodeStore.getState().nodes[out] : undefined
          if (out) clearMat(out)
          showArea3d(id, true, n && { x: n.x, y: n.y }, n?.under ?? [])
        }
      } finally { busy = false }
      last = seen(useBoardsStore.getState().groups)
    }
    for (const mv of moves) {
      const out = area3dOutOf(mv.id)
      if (out) {
        const fs = useFreeNodeStore.getState()
        const n = fs.nodes[out]
        // The card lying on its own mat moves with it already.
        if (!n || fs.selectedIds.includes(out)) continue
        const g = useBoardsStore.getState().groups.find(x => x.id === mv.id)
        const r = g && cardBox(g)
        if (r && inside(n, r.x + r.width / 2 - mv.dx, r.y + r.height / 2 - mv.dy)) continue
        fs.moveFreeNode(out, mv.dx, mv.dy)
      } else {
        useBoardsStore.setState(st => ({
          groups: st.groups.map(g => (g.id === mv.id && g.area3d
            ? { ...g, area3d: { ...g.area3d, mat: { ...g.area3d.mat, x: g.area3d.mat.x + mv.dx, y: g.area3d.mat.y + mv.dy } } }
            : g)),
        }))
      }
    }
  })
}
