// 3D area cards (Brian 2026-11-08): a 3D area (the mat that is a 3D
// workspace, freeNodeStore 'area') folds into a card and comes back out of
// it, as a chart does (utils/chartCard), so a scene layout can go into a
// deck, a scene card or a state like any card.
//
// Fold: the card keeps the mat (where it comes out, its size) and what
// lies on it: each card's master (utils/linkedCards) where it lay, its deck
// as it was, and how its model stands (size and turn, tiltStore
// useModelScaleStore); tiles on it (an old model tile, a picture) whole;
// and the curves parented to it (utils/curveParent), whole. Linked cards,
// tiles and its curves go with it; master cards stay where they are, free
// to move away (as a chart's do). A model of the set that rides a path
// (utils/pathRide) keeps its ride: back out, it rides that path again.
//
// Show: the mat comes back where it was, with LINKED cards of those
// masters, each where it lay, turned and sized as it was, the tiles and
// its curves. Moving the card takes its 3D area along (out or folded).

import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useFreeNodeStore, type FreeNodeData, type AreaGround, type AreaFlatView, type MapNotes } from '../store/freeNodeStore'
import { useCanvasStore } from '../store/canvasStore'
import { isUndoRestoring, useUndoCoordinator } from '../store/undoCoordinator'
import { useModelScaleStore, type ScenePlace, type CameraLens, type PieceView } from '../store/tiltStore'
import { cardBox, carrying, docksUnder, isUnder, laying, lyingIn, rowCards, selfMoved, setCards, setViewers } from './area3dScene'
import { useViewport3DStore, type ViewportWindow3D } from '../store/viewport3dStore'
import { viewportVisualRect } from './viewportDocking'
import { isHiddenDeckMember } from '../hooks/useCardDecks'
import { cardFaceSize, createTextCard } from './cardGrid'
import { makeLinkedCard, masterOf } from './linkedCards'
import { useNotesStore, useNotesUi, newNoteId, type Curve, type PathRider } from '../store/notesStore'
import { curvesOf } from './curveParent'
import { riderOf, parentToPath, setRider } from './pathRide'

type Quat = [number, number, number, number]

/** The path a folded model rode (utils/pathRide), and how it sat on it:
 *  one of the set's own curves (its place among `curves`), or one left on
 *  the canvas (its id). */
export interface Area3dRide { on: number | string; rider: Omit<PathRider, 'key'> }

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
  /** The view its piece is drawn from (tiltStore pieceOf). */
  piece?: PieceView
  /** The path its model rode. */
  ride?: Area3dRide
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
  /** The view its piece is drawn from (tiltStore pieceOf). */
  piece?: PieceView
  /** The path its model rode. */
  ride?: Area3dRide
}
export interface Area3dData {
  /** The mat: where it comes out (top-left), its size and look. */
  mat: { x: number; y: number; width: number; height: number; color?: string; label?: string; gridAt?: { x: number; y: number }; ground?: AreaGround; flatView?: AreaFlatView; rideLoop?: boolean; mapNotes?: MapNotes }
  cards: Area3dCardItem[]
  tiles: Area3dTileItem[]
  /** The cards that were with the set when it was folded (docked under
   *  it, in a row with its card: area3dScene rowCards), by id. Kept for
   *  the record only: which cards are with a set is read from where they
   *  lie (a card docked under it is with it), nothing else. */
  row?: string[]
  /** The curves parented to it (utils/curveParent), whole: their points
   *  from the mat's top-left, their parent left out (it is this set). */
  curves?: Curve[]
  /** The Viewers that were with it (on it, set against its sides:
   *  area3dScene setViewers), whole, their places from the mat's top-left.
   *  They fold away with the set and come out with it, as they were. */
  viewers?: ViewportWindow3D[]
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
  // And the cards docked under it (Brian 2026-11-15: the set works as a
  // chart does; the masters put against it stay out when it folds, and
  // what is kept in its card are links to them), with the cards put away
  // in a closed deck among those.
  const add = (g: ProjectGroup) => { if (!cards.includes(g)) cards.push(g) }
  const row = rowCards(a).slice(1)
  row.forEach(add)
  const fronts = row.filter(g => !!g.deckState && g.deckState !== 'open')
  for (let i = 0; i < fronts.length; i++) {
    for (const m of groups) {
      if (m.pin || m.id === fronts[i].id || m.deckAnchorId !== fronts[i].id || !isHiddenDeckMember(m) || fronts.includes(m)) continue
      add(m)
      fronts.push(m)
    }
  }
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
  // A path one of its models rides goes with the model, as where it
  // stands does: kept with it here (by the curve's place among the set's
  // own, or its id on the canvas), and taken up again by the card or tile
  // that comes back out for it. The one it was on rides no longer (a
  // master card stays on the canvas, a plain card again).
  const own = curvesOf(a.id)
  const gone = new Set<string>()
  const rideOf = (key: string): { ride?: Area3dRide } => {
    const r = riderOf(key)
    if (!r) return {}
    gone.add(key)
    const i = own.findIndex(c => c.id === r.curve.id)
    const { key: _key, ...rider } = r.rider
    void _key
    return { ride: { on: i >= 0 ? i : r.curve.id, rider } }
  }
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
      ...(ms.pieceOf[`card:${g.id}`] ? { piece: ms.pieceOf[`card:${g.id}`] } : {}),
      ...rideOf(`card:${g.id}`),
    })
  }
  // (A second showing of a master on the same set is kept once, above:
  // the linked one goes with the fold all the same.)
  for (const g of cards) if (g.linkOf && riderOf(`card:${g.id}`)) gone.add(`card:${g.id}`)
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
      ...(ms.pieceOf[`node:${n.id}`] ? { piece: ms.pieceOf[`node:${n.id}`] } : {}),
      ...rideOf(`node:${n.id}`),
    }
  })
  // (Their rides are kept with them, above: not a second time on a curve.)
  const staying = (c: Curve) => c.riders?.filter(r => !gone.has(r.key))
  const curveItems = own.map(c => {
    const { parent: _parent, riders: _riders, ...curve } = c
    void _parent; void _riders
    const riders = staying(c)
    return { ...curve, ...(riders?.length ? { riders } : {}), pts: c.pts.map(p => ({ ...p, x: p.x - a.x, y: p.y - a.y })) }
  })
  // A path left on the canvas lets go of the ones that go.
  if (gone.size) {
    const ns = useNotesStore.getState()
    const mine = new Set(own.map(c => c.id))
    for (const c of Object.values(ns.curves)) {
      if (mine.has(c.id) || !c.riders?.some(r => gone.has(r.key))) continue
      const left = staying(c)
      ns.updateCurve(c.id, { riders: left?.length ? left : undefined })
    }
  }
  const withIt = setViewers(a, a)
  const data: Area3dData = {
    mat: { x: a.x, y: a.y, width: a.width, height: a.height, color: a.color, label: a.label, ...(a.gridAt ? { gridAt: a.gridAt } : {}), ...(a.ground ? { ground: a.ground } : {}), ...(a.flatView ? { flatView: a.flatView } : {}), ...(a.rideLoop ? { rideLoop: true } : {}), ...(a.mapNotes ? { mapNotes: a.mapNotes } : {}) },
    cards: cardItems, tiles: tileItems,
    ...(curveItems.length ? { curves: curveItems } : {}),
    row: rowCards(a).slice(1).map(g => g.id),
    ...(withIt.length ? { viewers: withIt.map(w => ({ ...w, x: w.x - a.x, y: w.y - a.y })) } : {}),
  }
  writing = true
  try { useBoardsStore.setState(s => ({ groups: s.groups.map(g => g.id === cardId ? { ...g, area3d: data } : g) })) } finally { writing = false }
  for (const w of withIt) useViewport3DStore.getState().removeWindow(w.id)
  clearMat(nodeId)
  return cardId
}

/** Takes 3D area `nodeId` off the canvas: its linked cards, tiles and
 *  curves go with it (but curves `keep`); master cards stay. */
function clearMat(nodeId: string, withTiles = true, keep?: Set<string>) {
  const a = useFreeNodeStore.getState().nodes[nodeId]
  if (!a) return
  const { cards, tiles } = onMat(a)
  const curves = withTiles ? curvesOf(a.id).map(c => c.id).filter(id => !keep?.has(id)) : []
  clearing = true
  try {
    for (const g of cards) {
      if (!g.linkOf) continue
      g.boardIds.forEach(bid => useBoardsStore.getState().deleteBoard(bid))
      useBoardsStore.getState().deleteGroup(g.id)
    }
    if (withTiles) for (const n of tiles) useFreeNodeStore.getState().deleteFreeNode(n.id)
    // Its curves, as its tiles: kept in its card when folded; left on the
    // canvas, no one's, when it goes because its card was deleted.
    if (curves.length) {
      useNotesStore.getState().deleteCurves(curves)
      const ui = useNotesUi.getState()
      if (ui.selected.some(id => curves.includes(id))) useNotesUi.setState({ selected: ui.selected.filter(id => !curves.includes(id)) })
    }
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
  // Flush under the set, as it is drawn (its header band and all).
  const made = useBoardsStore.getState().groups.find(g => g.id === cardId)
  const box = made && cardBox(made)
  if (made && box) useBoardsStore.getState().setGroupPosBatch([{ groupId: cardId, originX: made.originX + (a.x - box.x), originY: made.originY + (a.y + a.height - box.y) }])
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
 *  folded) lays the 3D area out again from what the card now holds. Its
 *  curves the card held go, for the ones it holds now; the ones drawn on
 *  it since, which no card holds, stay (startArea3dFollow). */
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
  return { ...matOver(card, m), w: m.width, h: m.height }
}

/** Where a 3D set comes out of its card: its card is always docked under
 *  it (Brian 2026-11-13: "the card should always be docked on the bottom
 *  of the 3D set area"). Where it was kept (`m`) when the card is docked
 *  under that; else straight over the card, its bottom-left corner on the
 *  card's top-left. The set goes to the card: the card is never moved. */
function matOver(card: ProjectGroup, m: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  const box = cardBox(card)
  if (!box || docksUnder(box, m)) return { x: m.x, y: m.y }
  return { x: box.x, y: box.y - m.height }
}

/** Is model `key` ('card:<id>' / 'node:<id>') still on the canvas? */
const modelThere = (key: string) => key.startsWith('node:')
  ? !!useFreeNodeStore.getState().nodes[key.slice(5)]
  : useBoardsStore.getState().groups.some(g => g.id === key.slice(5))

/** Brings card `cardId`'s 3D area out (an empty one the first time).
 *  Returns the mat's id. */
export function showArea3d(cardId: string, quiet = false, spot?: { x: number; y: number }, under?: string[]): string | null {
  const card = useBoardsStore.getState().groups.find(g => g.id === cardId)
  if (!card || area3dOutOf(cardId)) return null
  if (!quiet) useUndoCoordinator.getState().checkpoint()
  const d0 = card.area3d ?? freshMat(card)
  // Laid out anew where the one before stood (a state turned); else over
  // its card (matOver).
  const data = { ...d0, mat: { ...d0.mat, ...(spot ?? matOver(card, d0.mat)) } }
  const fs = useFreeNodeStore.getState()
  const m = data.mat
  // What already lies there stays out of the scene (Brian 2026-11-10); laid
  // out anew, what was under it before still is.
  // (Not the cards docked under it: those are with the set, utils/area3dScene rowCards.)
  const groups0 = useBoardsStore.getState().groups
  const docked = (k: string) => {
    const g = k.startsWith('card:') ? groups0.find(x => x.id === k.slice(5)) : undefined
    const r = g && !g.linkOf ? cardBox(g) : null
    return !!r && docksUnder(r, m)
  }
  const below = under ?? lyingIn(m, cardId).filter(k => !docked(k))
  let id = ''
  laying.on = true
  try {
    id = fs.addFreeNode(m.x, m.y, 'area')
    fs.updateFreeNode(id, { x: m.x, y: m.y, width: m.width, height: m.height, areaCard: cardId, label: m.label ?? card.name ?? '3D set', ...(m.color ? { color: m.color } : {}), ...(m.gridAt ? { gridAt: m.gridAt } : {}), ...(m.ground ? { ground: m.ground } : {}), ...(m.flatView ? { flatView: m.flatView } : {}), ...(m.rideLoop ? { rideLoop: true } : {}), ...(m.mapNotes ? { mapNotes: m.mapNotes } : {}), ...(below.length ? { under: below } : {}) })
  } finally { laying.on = false }
  // Its Viewers, where they were by it (one still on the canvas stays as it is).
  if (data.viewers?.length) {
    useViewport3DStore.setState(st => {
      const windows = { ...st.windows }
      for (const w of data.viewers!) if (!windows[w.id]) windows[w.id] = { ...w, x: m.x + w.x, y: m.y + w.y }
      return { windows }
    })
  }
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
  // The paths its models rode: taken up again once its curves are out.
  const rides: { key: string; ride: Area3dRide }[] = []
  for (const [lid, p] of at) {
    if (!lid) continue
    if (p.ride) rides.push({ key: `card:${lid}`, ride: p.ride })
    if (p.size !== undefined) ms.setSetSize(`card:${lid}`, p.size)
    if (p.pose) ms.setPose(`card:${lid}`, p.pose)
    if (p.tint) ms.setTint(`card:${lid}`, p.tint)
    // Where it stood in the set and the view its piece was given, as they
    // were folded or not at all: a linked card is made with its master's
    // (boardsStore duplicateGroup), which are not this set's.
    ms.setPlace(`card:${lid}`, p.place ?? null)
    if (p.stretch) ms.setStretch(`card:${lid}`, p.stretch)
    if (p.lens) ms.setLens(`card:${lid}`, p.lens)
    ms.setPiece(`card:${lid}`, p.piece ?? null)
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
    if (t.piece) ms.setPiece(`node:${nid}`, t.piece)
    if (t.ride) rides.push({ key: `node:${nid}`, ride: t.ride })
  }
  // Its curves, whole, parented to the mat that came out. New ids: the
  // same layout can be out more than once (a linked card of this one).
  const out: string[] = []
  for (const c of data.curves ?? []) {
    const cid = newNoteId('cv')
    out.push(cid)
    // A model that stayed on the canvas and rode it rides it again,
    // unless it is gone, or rides another path by now.
    const { riders: rode, ...curve } = c
    const riders = rode?.filter(r => modelThere(r.key) && !riderOf(r.key))
    useNotesStore.getState().addCurve({ ...curve, ...(riders?.length ? { riders } : {}), id: cid, parent: id, pts: c.pts.map(p => ({ ...p, x: p.x + m.x, y: p.y + m.y })) })
  }
  // Its models back on the paths they rode (a path gone since: they stand
  // where they were put).
  for (const { key, ride } of rides) {
    const cid = typeof ride.on === 'number' ? out[ride.on] : ride.on
    if (!cid || useNotesStore.getState().curves[cid]?.kind !== 'bezier') continue
    parentToPath(key, cid)
    setRider(cid, key, ride.rider)
  }
  return id
}

// ── The motion (Brian 2026-11-09: the set's frame minimizes onto the card) ──
// Folding, the mat and what is on it (its linked cards, tiles and curves,
// and its models' pieces in the flat view; the master cards stay on the
// canvas) shrink as ONE picture into the card, keeping their places on the
// mat, and fade at the very end, then fold. Showing, the set grows out of
// the card the same way, backwards.

const MOTION_MS = 460
type RiderKind = 'card' | 'node' | 'curve' | 'piece'
const sel = (kind: RiderKind, id: string) => kind === 'node'
  ? [`[data-freenode][data-id="${id}"]`]
  // A curve's line, and the layers drawn along it (curveGeom layerCurves).
  : kind === 'curve' ? [`[data-curve-shape="${id}"]`, `[data-curve-shape^="${id}~"]`]
  // Every piece of the set (components/Canvas/PieceLayer), by the set.
  : kind === 'piece' ? [`[data-piece-set="${id}"]`]
  : [`[data-layer-card="${id}"]`, `[data-group-card][data-id="${id}"]`, `[data-card-header="${id}"]`, `[data-primary-rail="${id}"]`, `[data-row-of="${id}"]`, `[data-row-band="${id}"]`]
type Rider = { kind: RiderKind; id: string; cx: number; cy: number }
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

/** What rides with mat `a`: the mat, its linked cards, its tiles, its
 *  curves and its models' pieces. */
function riders(a: FreeNodeData): Rider[] {
  const size = cardFaceSize()
  const { cards, tiles } = onMat(a)
  return [
    { kind: 'node', id: a.id, cx: a.x + a.width / 2, cy: a.y + a.height / 2 },
    ...cards.filter(g => g.linkOf).map(g => ({ kind: 'card' as const, id: g.id, cx: g.originX + (g.cardWidthOverride ?? size.w) / 2, cy: g.originY + (g.cardHeightOverride ?? size.h) / 2 })),
    ...tiles.map(n => ({ kind: 'node' as const, id: n.id, cx: n.x + n.width / 2, cy: n.y + n.height / 2 })),
    // (A curve is drawn from the canvas's own origin: no middle to find.)
    ...curvesOf(a.id).map(c => ({ kind: 'curve' as const, id: c.id, cx: 0, cy: 0 })),
    // (Each piece's middle is read off it as drawn, in ride().)
    { kind: 'piece', id: a.id, cx: 0, cy: 0 },
  ]
}

/** Plays riders `rs` between where they are and card middle `to` (in:
 *  out of the card; else into it), then `done`. Elements drawn part way
 *  pick the motion up where it has got to, hidden till then. */
function ride(rs: Rider[], to: { x: number; y: number }, out: boolean, done: () => void, k = 0.12, tick?: (away: number) => void) {
  const zoom = useCanvasStore.getState().zoom
  // The mat (first rider) shrinks to `k` of its size onto the card's
  // middle; everything else keeps its place on it, so it is one picture.
  const from = rs[0] ? { x: rs[0].cx, y: rs[0].cy } : to
  const frames = (r0: Rider, el: HTMLElement) => {
    const home = { transform: 'translate(0px, 0px) scale(1)' }
    // A piece is drawn in screen px from the canvas's origin, unturned
    // (its picture turns inside it), its box set to a part of a px
    // (components/Canvas/PieceLayer): read as it is set, not in whole px
    // (offsetWidth), by which a small one rode wide of its place on the
    // mat. Its middle, canvas units.
    const piece = r0.kind === 'piece'
    const set = (v: string, or: number) => { const n = parseFloat(v); return Number.isFinite(n) ? n : or }
    const w = piece ? set(el.style.width, el.offsetWidth) : el.offsetWidth, h = piece ? set(el.style.height, el.offsetHeight) : el.offsetHeight
    const r = piece ? { ...r0, cx: (set(el.style.left, el.offsetLeft) + w / 2) / zoom, cy: (set(el.style.top, el.offsetTop) + h / 2) / zoom } : r0
    // A curve is drawn in the canvas's own units, about the canvas's
    // origin (components/Notes/CurveLayer): the mat's shrink, as it is.
    if (r.kind === 'curve') {
      const away = { transform: `translate(${to.x - from.x * k}px, ${to.y - from.y * k}px) scale(${k})` }
      return out ? [away, home] : [home, away]
    }
    // Scaled about its own transform origin (a mat's is its corner), so
    // its middle is put right: d = middle less origin, px.
    const o = getComputedStyle(el).transformOrigin.split(' ').map(parseFloat)
    const dx = w / 2 - (o[0] || 0), dy = h / 2 - (o[1] || 0)
    // Screen px per px of its own: tiles sit in the zoomed canvas, cards not.
    const u = w ? el.getBoundingClientRect().width / w : 1
    const z = zoom / (u || 1)
    const x = (to.x + (r.cx - from.x) * k - r.cx) * z + dx * (1 - k), y = (to.y + (r.cy - from.y) * k - r.cy) * z + dy * (1 - k)
    const away = { transform: `translate(${x}px, ${y}px) scale(${k})` }
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
  const rode: HTMLElement[] = []
  const clock = document.documentElement.animate([], { duration: MOTION_MS })
  let over = false
  // Whatever goes wrong on the way, the motion ends and what it hid or
  // faded is drawn as it is again (Brian 2026-11-13: after a set was
  // opened and closed a few times its ground was not there: a motion that
  // never ended left it faded out, and no other could begin).
  const end = () => {
    if (over) return
    over = true
    clearTimeout(late)
    try { done() } catch (err) { console.error('[area3dCard] the fold or show after the motion failed', err) }
    // A frame later (what folded is gone by then): back to as drawn.
    const back = () => {
      hide.remove()
      anims.forEach(x => { try { x.cancel() } catch { /* gone */ } })
      // Its own only: another motion may have begun by now.
      rode.forEach(e => e.removeAttribute('data-a3-riding'))
    }
    requestAnimationFrame(back)
    // (No frame comes while the window is hidden.)
    setTimeout(back, 250)
  }
  clock.finished.then(end, end)
  const late = setTimeout(end, MOTION_MS + 600)
  const catchUp = () => {
    if (over) return
    try {
      const t = Number(clock.currentTime ?? 0)
      // How far into the card it is by now (1: there), as the riders are.
      if (tick) { const e = RIDE_EASE(Math.min(1, Math.max(0, t / MOTION_MS))); tick(out ? 1 - e : e) }
      for (const { r, q } of all) {
        for (const el of document.querySelectorAll<HTMLElement>(q)) {
          if (el.hasAttribute('data-a3-riding')) continue
          el.setAttribute('data-a3-riding', '')
          rode.push(el)
          const f = frames(r, el)
          const how = { duration: MOTION_MS, easing: 'cubic-bezier(0.55, 0, 0.25, 1)', fill: 'forwards' } as const
          const a = el.animate(f, { ...how, composite: 'add' })
          const b = el.animate(fade, { ...how, easing: 'linear' })
          anims.push(a, b)
          a.currentTime = t; b.currentTime = t
        }
      }
    } catch (err) {
      console.error('[area3dCard] the fold or show motion failed', err)
      end()
      return
    }
    requestAnimationFrame(catchUp)
  }
  catchUp()
}

// ── The Viewers with a set zip into it, then go into the card with it ──
// (Brian 2026-11-13: "can the viewers zip sideways into the 3D set just
// before the 3D set zips into the card?") A Viewer's 3D picture is drawn
// from its box in the store (three/viewportRenderer), not from its
// element, so the motion moves the box itself, frame by frame, and puts
// it back as it was at the end; nothing of it is kept.
const ZIP_MS = 170
/** cubic-bezier(x1, y1, x2, y2), as the riders' easing. */
function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const f = (a: number, b: number, u: number) => 3 * a * u * (1 - u) * (1 - u) + 3 * b * u * u * (1 - u) + u * u * u
  return t => {
    let lo = 0, hi = 1
    for (let i = 0; i < 24; i++) { const u = (lo + hi) / 2; if (f(x1, x2, u) < t) lo = u; else hi = u }
    return f(y1, y2, (lo + hi) / 2)
  }
}
const RIDE_EASE = bezier(0.55, 0, 0.25, 1)
type Zip = { id: string; x: number; y: number; width: number; height: number; dx: number; dy: number }
/** Set `a`'s Viewers, each as it is and how far it slides to lie on the
 *  set (0, 0 for one on its ground already). */
function zipsOf(a: FreeNodeData): Zip[] {
  const zoom = useCanvasStore.getState().zoom
  return setViewers(a, a).map(w => {
    const v = viewportVisualRect(w, zoom)
    const nx = Math.max(a.x, Math.min(v.x, a.x + a.width - v.width)), ny = Math.max(a.y, Math.min(v.y, a.y + a.height - v.height))
    return { id: w.id, x: w.x, y: w.y, width: w.width, height: w.height, dx: nx - v.x, dy: ny - v.y }
  })
}
const zipSet = (z: Zip, r: { x: number; y: number; width: number; height: number }) => {
  if (useViewport3DStore.getState().windows[z.id]) useViewport3DStore.getState().updateWindow(z.id, r)
}
/** Each as it was. */
function zipHome(zs: Zip[]) {
  for (const z of zs) {
    zipSet(z, { x: z.x, y: z.y, width: z.width, height: z.height })
    const el = document.querySelector<HTMLElement>(`[data-viewport3d="${z.id}"]`)
    if (el) el.style.opacity = ''
  }
}
/** Each `e` (0..1) of its way onto the set. */
function zipSlide(zs: Zip[], e: number) {
  for (const z of zs) zipSet(z, { x: z.x + z.dx * e, y: z.y + z.dy * e, width: z.width, height: z.height })
}
/** Lying on the set, each `away` (0..1) of the set's way into the card:
 *  the mat shrinks to `k` of its size, its middle `from` onto `to`. */
function zipRide(zs: Zip[], away: number, from: { x: number; y: number }, to: { x: number; y: number }, k: number) {
  const s = 1 + (k - 1) * away
  for (const z of zs) {
    const px = z.x + z.dx, py = z.y + z.dy
    zipSet(z, { x: px + (to.x + (px - from.x) * k - px) * away, y: py + (to.y + (py - from.y) * k - py) * away, width: z.width * s, height: z.height * s })
    const el = document.querySelector<HTMLElement>(`[data-viewport3d="${z.id}"]`)
    if (el) el.style.opacity = away > 0.75 ? String(Math.max(0, (1 - away) / 0.25)) : ''
  }
}
/** Plays the slide onto the set (`back`: off it again), then `done`. */
function zipPlay(zs: Zip[], back: boolean, done: () => void) {
  let over = false
  let late: ReturnType<typeof setTimeout> | undefined
  const end = () => { if (over) return; over = true; if (late !== undefined) clearTimeout(late); done() }
  if (!zs.some(z => z.dx || z.dy)) { end(); return }
  late = setTimeout(end, ZIP_MS + 400)
  const t0 = performance.now()
  const step = () => {
    if (over) return
    const t = Math.min(1, (performance.now() - t0) / ZIP_MS)
    const e = RIDE_EASE(t)
    try { zipSlide(zs, back ? 1 - e : e) } catch (err) { console.error('[area3dCard] the Viewers\' slide failed', err); end(); return }
    if (t >= 1) end(); else requestAnimationFrame(step)
  }
  step()
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
  // Its curves ride in as drawn: a selected one's points are put away.
  const mine = new Set(curvesOf(a.id).map(c => c.id))
  const ui = useNotesUi.getState()
  if (ui.selected.some(id => mine.has(id))) useNotesUi.setState({ selected: ui.selected.filter(id => !mine.has(id)) })
  const fit = card ? fitInto(a, card) : Math.min(size.w / a.width, size.h / a.height)
  // Its Viewers zip onto it first, then go into the card with it; folded
  // as they were (foldArea3d keeps their places).
  const zs = zipsOf(a)
  const from = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
  const fold = () => { zipHome(zs); moving = false; foldArea3d(nodeId); then?.() }
  zipPlay(zs, false, () => {
    try {
      ride(riders(a), to, false, fold, fit, zs.length ? away => zipRide(zs, away, from, to, fit) : undefined)
    } catch (err) {
      // No motion: folded all the same.
      console.error('[area3dCard] the fold motion could not begin', err)
      fold()
    }
  })
}

/** Show card `cardId`'s 3D area, with the motion. */
export function showArea3dMoving(cardId: string): void {
  if (moving) return
  const id = showArea3d(cardId)
  const a = id ? useFreeNodeStore.getState().nodes[id] : undefined
  const card = useBoardsStore.getState().groups.find(g => g.id === cardId)
  if (!a || !card) return
  moving = true
  // Its Viewers come out of the card on it, then zip out to its sides.
  const zs = zipsOf(a)
  const from = { x: a.x + a.width / 2, y: a.y + a.height / 2 }, to = middleOf(card), fit = fitInto(a, card)
  const out = () => { zipSlide(zs, 1); zipPlay(zs, true, () => { zipHome(zs); moving = false }) }
  try {
    if (zs.length) zipRide(zs, 1, from, to, fit)
    ride(riders(a), to, true, out, fit, zs.length ? away => zipRide(zs, away, from, to, fit) : undefined)
  } catch (err) {
    // No motion: it is out all the same.
    console.error('[area3dCard] the show motion could not begin', err)
    zipHome(zs)
    moving = false
  }
}

/** Show or fold card `cardId`'s 3D area. */
export function toggleArea3d(cardId: string): void {
  const out = area3dOutOf(cardId)
  if (out) foldArea3dMoving(out); else showArea3dMoving(cardId)
}

/** A 3D set's card double-clicked with its set out: the set folds in,
 *  with the cards docked under it (area3dScene rowCards) kept in its card
 *  as links, however they lie there: a row, a gap and another row, a deck
 *  of their own (Brian 2026-11-13: it "reopens in the same state it was
 *  in"). `_row`: the card's open deck, not closed onto it any more. No
 *  set out: false. */
export function foldArea3dAndDeck(cardId: string, _row: string[]): boolean {
  const out = area3dOutOf(cardId)
  if (!out) return false
  // (The cards docked under it are kept in its card as links, foldArea3d;
  // the masters among them stay where they lie, Brian 2026-11-15: no
  // deck is closed onto the set's card any more.)
  foldArea3dMoving(out)
  return true
}

/** The same layout, but for where it comes out (a folded showing of the
 *  card was moved: the card's own set, out, is where it is all the same)? */
const sameLayout = (a: Area3dData | undefined, b: Area3dData) => !!a && a.cards === b.cards && a.tiles === b.tiles && a.curves === b.curves
  && a.mat.width === b.mat.width && a.mat.height === b.mat.height && a.mat.color === b.mat.color && a.mat.label === b.mat.label

/** A curve as a 3D set's card holds it (its points from the mat's corner
 *  `ox`, `oy`; not its id, its parent or who rides it), as one string:
 *  two that are the same but for rounding read the same. (To a hundredth,
 *  taken from the millionth: a point at an exact half hundredth, as one
 *  drawn at a round zoom is, reads the same after the set was moved and
 *  the sums left it a hair under.) */
function heldAs(c: Curve, ox = 0, oy = 0, back?: Back): string {
  const { id: _id, parent: _parent, riders: _riders, pts, ...rest } = c
  void _id; void _parent; void _riders
  const tidy = (v: unknown): unknown => Array.isArray(v) ? v.map(tidy)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, tidy(x)]))
    : typeof v === 'number' ? Math.round(Math.round(v * 1e6) / 1e4) / 100 : v
  return JSON.stringify(tidy({ ...rest, pts: pts.map(p => back ? back(p) : ({ ...p, x: p.x - ox, y: p.y - oy })) }))
}
type Back = (p: Curve['pts'][number]) => Curve['pts'][number]

/** A point of a set's curve as it lay before the set (`n` now) was pulled
 *  by a corner from the size `mat`, which spreads what is on it with its
 *  ground (utils/area3dScene holdSets): from the mat's corner. */
const unspread = (n: { x: number; y: number; width: number; height: number }, mat: { width: number; height: number }): Back => {
  const fx = mat.width / n.width, fy = mat.height / n.height
  const un = (v: number, lo: number, len: number, len0: number, f: number) => v < lo ? v - lo : v > lo + len ? len0 + v - lo - len : (v - lo) * f
  const h = <T extends { x: number; y: number }>(v?: T) => v && { ...v, x: v.x * fx, y: v.y * fy }
  return p => ({ ...p, x: un(p.x, n.x, n.width, mat.width, fx), y: un(p.y, n.y, n.height, mat.height, fy), ...(p.hin ? { hin: h(p.hin) } : {}), ...(p.hout ? { hout: h(p.hout) } : {}) })
}

/** Where the curves a set was laid out with are measured from now: the
 *  mat's corner as it was when they were laid, moved as the set has moved
 *  since. That is the corner `n` has now, unless the mat was resized by
 *  its top or its left edge (which moves its corner and leaves what is on
 *  it where it is): then it is as far from the mat's far corner as the
 *  mat was big when it was laid (`mat`, the layout's). Across and down,
 *  each way is tried, and the one taken from which the most of `live`
 *  (the set's curves now) are still as `was` (the layout's) has them;
 *  with none from any, the corner as it is. Nothing is made of how the
 *  curves lie among themselves: one moved by hand is the owner's, however
 *  many were moved the same way. */
function laidFrom(live: Curve[], was: Curve[], n: { x: number; y: number; width: number; height: number }, mat?: { width: number; height: number }): { x: number; y: number; back?: Back } {
  const held = new Set(was.map(c => heldAs(c)))
  const xs = mat && mat.width !== n.width ? [n.x, n.x + n.width - mat.width] : [n.x]
  const ys = mat && mat.height !== n.height ? [n.y, n.y + n.height - mat.height] : [n.y]
  let best: { x: number; y: number; back?: Back } = { x: n.x, y: n.y }, most = 0
  for (const x of xs) for (const y of ys) {
    const k = live.filter(c => held.has(heldAs(c, x, y))).length
    if (k > most) { most = k; best = { x, y } }
  }
  // Or the mat was pulled by a corner, and they spread with it.
  if (mat && (mat.width !== n.width || mat.height !== n.height) && n.width > 0 && n.height > 0) {
    const back = unspread(n, mat)
    const k = live.filter(c => held.has(heldAs(c, 0, 0, back))).length
    if (k > most) best = { x: n.x, y: n.y, back }
  }
  return best
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
  return useBoardsStore.subscribe((s, prev) => {
    if (busy) return
    // The set is taking its cards along: its card is not leading it.
    if (carrying.on) { last = seen(s.groups); return }
    const now = seen(s.groups)
    const moves: { id: string; dx: number; dy: number }[] = []
    const relay: string[] = []
    if (!isUndoRestoring()) {
      for (const [id, p] of now) {
        const q = last.get(id)
        if (q && (q.x !== p.x || q.y !== p.y)) moves.push({ id, dx: p.x - q.x, dy: p.y - q.y })
        // Its layout changed under a 3D area that is out: lay it out anew.
        if (q && q.data !== p.data && p.data && !writing && !sameLayout(q.data, p.data) && area3dOutOf(id)) relay.push(id)
      }
    }
    const before = last
    last = now
    if (relay.length) {
      busy = true
      try {
        for (const id of relay) {
          const out = area3dOutOf(id)
          const n = out ? useFreeNodeStore.getState().nodes[out] : undefined
          // Its curves the layout it was laid from does not hold (drawn on
          // it since, or changed): no card keeps them, so they are not
          // taken off the canvas. They stay, the set's that comes out anew.
          const was = before.get(id)?.data?.curves ?? []
          const held = new Set(was.map(c => heldAs(c)))
          const live = n ? curvesOf(n.id) : []
          const from = n ? laidFrom(live, was, n, before.get(id)?.data?.mat) : null
          const stay = from ? live.filter(c => !held.has(heldAs(c, from.x, from.y, from.back))) : []
          if (out) clearMat(out, true, new Set(stay.map(c => c.id)))
          const again = showArea3d(id, true, n && { x: n.x, y: n.y }, n?.under ?? [])
          // (One from before curves had parents lies on it as it did.)
          if (again) for (const c of stay) if (c.parent !== undefined) useNotesStore.getState().updateCurve(c.id, { parent: again })
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
        if (!n) continue
        if (fs.selectedIds.includes(out)) {
          // Selected too: a drag of both moves both. If only the card went
          // (the set selected, its card dragged alone), the set goes after
          // it all the same: they are never apart (Brian 2026-11-13).
          const x0 = n.x, y0 = n.y, dx = mv.dx, dy = mv.dy
          queueMicrotask(() => {
            const f2 = useFreeNodeStore.getState(), n2 = f2.nodes[out]
            if (!n2 || n2.x !== x0 || n2.y !== y0 || isUndoRestoring()) return
            selfMoved.clear()
            selfMoved.add(mv.id)
            try { f2.moveFreeNode(out, dx, dy) } finally { selfMoved.clear() }
          })
          continue
        }
        const g = useBoardsStore.getState().groups.find(x => x.id === mv.id)
        const r = g && cardBox(g)
        if (r && inside(n, r.x + r.width / 2 - mv.dx, r.y + r.height / 2 - mv.dy)) continue
        // The cards that moved in this same change (the set's card, and any
        // dragged with it) have moved: the set takes the others along.
        selfMoved.clear()
        if (prev.groups !== s.groups) {
          const was = new Map(prev.groups.map(q => [q.id, q]))
          for (const q of s.groups) { const p = was.get(q.id); if (p && (p.originX !== q.originX || p.originY !== q.originY)) selfMoved.add(q.id) }
        }
        try { fs.moveFreeNode(out, mv.dx, mv.dy) } finally { selfMoved.clear() }
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
