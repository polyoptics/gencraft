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
import { isUndoRestoring, useUndoCoordinator } from '../store/undoCoordinator'
import { useModelScaleStore } from '../store/tiltStore'
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
}
/** A tile on a folded 3D area, whole, where it lay. */
export interface Area3dTileItem {
  tile: Omit<FreeNodeData, 'id'>
  dx: number; dy: number
  size?: number
  pose?: Quat
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
  const cards = useBoardsStore.getState().groups.filter(g => g.id !== a.areaCard && !g.pin && inside(a, g.originX + 20, g.originY + 20))
  const tiles = Object.values(fs.nodes).filter(n => n.id !== a.id && n.type !== 'area' && n.type !== 'storyline' && !n.pin && n.areaCard === undefined && inside(a, n.x + n.width / 2, n.y + n.height / 2))
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
    cardId = createTextCard({ cx: a.x + size.w / 2, cy: a.y + a.height + size.h * 0.75 }, { title: a.label && a.label !== 'Area' ? a.label : '3D area' })
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
      ...(ms.sizeOf[`card:${g.id}`] !== undefined ? { size: ms.sizeOf[`card:${g.id}`] } : {}),
      ...(ms.poseOf[`card:${g.id}`] ? { pose: ms.poseOf[`card:${g.id}`] } : {}),
    })
  }
  const tileItems: Area3dTileItem[] = tiles.map(n => {
    const { id: _id, ...tile } = n
    void _id
    return {
      tile, dx: n.x - a.x, dy: n.y - a.y,
      ...(ms.sizeOf[`node:${n.id}`] !== undefined ? { size: ms.sizeOf[`node:${n.id}`] } : {}),
      ...(ms.poseOf[`node:${n.id}`] ? { pose: ms.poseOf[`node:${n.id}`] } : {}),
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
function clearMat(nodeId: string) {
  const a = useFreeNodeStore.getState().nodes[nodeId]
  if (!a) return
  const { cards, tiles } = onMat(a)
  for (const g of cards) {
    if (!g.linkOf) continue
    g.boardIds.forEach(bid => useBoardsStore.getState().deleteBoard(bid))
    useBoardsStore.getState().deleteGroup(g.id)
  }
  for (const n of tiles) useFreeNodeStore.getState().deleteFreeNode(n.id)
  useFreeNodeStore.getState().deleteFreeNode(nodeId)
}

/** Folding writes the card's layout; any other change to it (a State
 *  card's output turned to another state, another showing of the same card
 *  folded) lays the 3D area out again from what the card now holds. */
let writing = false

/** Where a 3D area comes out of a card that has none yet: an empty mat
 *  just right of the card's top-right corner. */
function freshMat(card: ProjectGroup): Area3dData {
  const size = cardFaceSize()
  const w = card.cardWidthOverride ?? size.w
  const width = size.w * 6.4, height = width * 9 / 14
  return { mat: { x: card.originX + w * 1.1, y: card.originY, width, height }, cards: [], tiles: [] }
}

/** Brings card `cardId`'s 3D area out (an empty one the first time).
 *  Returns the mat's id. */
export function showArea3d(cardId: string, quiet = false, spot?: { x: number; y: number }): string | null {
  const card = useBoardsStore.getState().groups.find(g => g.id === cardId)
  if (!card || area3dOutOf(cardId)) return null
  if (!quiet) useUndoCoordinator.getState().checkpoint()
  const d0 = card.area3d ?? freshMat(card)
  // Laid out anew where the one before stood (a state turned).
  const data = spot ? { ...d0, mat: { ...d0.mat, x: spot.x, y: spot.y } } : d0
  const fs = useFreeNodeStore.getState()
  const m = data.mat
  const id = fs.addFreeNode(m.x, m.y, 'area')
  fs.updateFreeNode(id, { x: m.x, y: m.y, width: m.width, height: m.height, areaCard: cardId, label: m.label ?? card.name ?? '3D area', ...(m.color ? { color: m.color } : {}) })
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
      }
    }),
  }))
  for (const [lid, p] of at) {
    if (!lid) continue
    if (p.size !== undefined) ms.setSize(`card:${lid}`, p.size)
    if (p.pose) ms.setPose(`card:${lid}`, p.pose)
  }
  // Its tiles, whole.
  for (const t of data.tiles) {
    const nid = fs.addFreeNode(m.x + t.dx, m.y + t.dy, t.tile.type)
    useFreeNodeStore.getState().updateFreeNode(nid, { ...t.tile, x: m.x + t.dx, y: m.y + t.dy })
    if (t.size !== undefined) ms.setSize(`node:${nid}`, t.size)
    if (t.pose) ms.setPose(`node:${nid}`, t.pose)
  }
  return id
}

/** Show or fold card `cardId`'s 3D area. */
export function toggleArea3d(cardId: string): void {
  const out = area3dOutOf(cardId)
  if (out) foldArea3d(out); else showArea3d(cardId)
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
          showArea3d(id, true, n && { x: n.x, y: n.y })
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
        if (g && inside(n, g.originX + 20 - mv.dx, g.originY + 20 - mv.dy)) continue
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
