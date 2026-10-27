// cardContent.ts — putting media INTO a card.
//
// A card holds its content as blocks (boards) in its group. New media gets
// a block of its own, with the media on that block's top-level bar: an
// untouched board (a fresh card's default one) is filled first, otherwise a
// new block lands just right of the card's face, and the cards that growth
// would run into move right with it. Nothing on the card is replaced — its
// face keeps showing the first picture it holds (or its hero override),
// which is what makes a card a container you can keep adding references to.
//
// Shared by every way media reaches a card: files from Explorer, Media Pool
// tiles, and canvas tiles dragged onto it.

import { useBoardsStore, type BoardData } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { cardVisualRect, canvasObstacleGroups, expandWithNestedMembers, isHiddenDeckMember } from '../hooks/useCardDecks'
import { cardScreenRect } from '../components/Layers/CardLayer'
import { createScaleFor } from './canvasCreate'
import type { GroupSlot } from './nlePush'
import type { MediaItem } from '../types/bar'
import { addMediaToGridCard, isGridCard } from './cardGrid'

const BOARD_PADDING_X = 20   // a block's content inset from its anchor
const BLOCK_GAP = 40         // the card's face to the new block
/** useCardDecks' TOUCH_TOLERANCE: two cards' visual rects this close or
 *  closer cluster into a deck. */
const TOUCH_GAP = 16

/** A board nothing has touched: the single default root bar with no
 *  children, name, media, text, icon or strokes, and no block/card layer
 *  content. A fresh card's default board qualifies. */
export function isBoardUnused(b: BoardData | undefined): boolean {
  if (!b || b.rootIds.length !== 1) return false
  const root = b.bars[b.rootIds[0]]
  if (!root || root.children.length > 0) return false
  const c = root.content
  const barUntouched = (root.name === 'Untitled' || root.name === '')
    && !root.icon && !(root.strokes && root.strokes.length > 0)
    && (!c || (!c.text && !c.headerText && (c.images?.length ?? 0) === 0 && (c.media?.length ?? 0) === 0))
  const layersUntouched = !b.layers?.block?.label && !b.layers?.block?.thumbnail
    && !b.layers?.card?.text && !b.layers?.card?.heroImage && !b.projectName
  return barUntouched && layersUntouched
}

/** Add `media` to the card as a block of its own; the block's top bar is
 *  named `label`. Returns the board it landed in, or null if the group is
 *  gone. Call once per item, in order — each new block is placed after
 *  the last. The caller takes the undo checkpoint. */
export function addMediaBlockToCard(groupId: string, media: MediaItem, label?: string): string | null {
  const bs0 = useBoardsStore.getState()
  const group = bs0.groups.find(g => g.id === groupId)
  if (!group) return null

  const fill = (boardId: string): string | null => {
    const rootBar = useBoardsStore.getState().boards[boardId]?.rootIds[0]
    if (!rootBar) return null
    const store = useBoardsStore.getState()
    // The block's header names it too — it reads "New Block" otherwise.
    if (label) { store.renameBar(boardId, rootBar, label); store.setBlockLabel(boardId, label) }
    store.setContent(boardId, rootBar, { media: [media] })
    return boardId
  }

  // Fill-first: reuse an untouched board before adding a block.
  const emptyBoardId = group.boardIds.find(bid => isBoardUnused(bs0.boards[bid]))
  // A grid card keeps its shape: the block takes the next cell inside it
  // (utils/cardGrid), and nothing grows sideways or pushes its neighbours.
  if (isGridCard(group)) return addMediaToGridCard(groupId, media, label, emptyBoardId ?? null)
  if (emptyBoardId) return fill(emptyBoardId)
  // Land the new block after the card's existing content: top row, just
  // right of the card's face — cardScreenRect at an identity camera is that
  // face in canvas units, size overrides included.
  const zoom = useCanvasStore.getState().zoom
  const before = cardVisualRect(group, bs0.boards, zoom)?.rect
  const face = cardScreenRect(group, bs0.boards, { x: 0, y: 0 }, 1)
  const dropX = (face ? face.screenLeft + face.screenWidth : group.originX) + BLOCK_GAP - BOARD_PADDING_X
  const newBoardId = bs0.createBoard(0, 0)
  // Sized like a new card's block made at this zoom (createCardOrBoardAt):
  // a new board's bar is a 120-unit speck — a picture you cannot see, and
  // too narrow for its block or bar to fit a drag-out grip.
  const k = createScaleFor(zoom)
  const rootId = useBoardsStore.getState().boards[newBoardId]?.rootIds[0]
  const rootBar = rootId ? useBoardsStore.getState().boards[newBoardId].bars[rootId] : undefined
  if (rootId && rootBar && k !== 1) {
    const bs = useBoardsStore.getState()
    bs.resizeBarEdge(newBoardId, rootId, 'right', rootBar.width * (k - 1))
    bs.setBarHeight(newBoardId, rootId, rootBar.height * k)
  }
  useBoardsStore.getState().reassignBoard(newBoardId, groupId, { x: dropX, y: group.originY })
  const landed = fill(newBoardId)
  if (before) pushNeighboursRight(groupId, before, zoom)
  return landed
}

/** The card grew rightward from `before`: the cards that growth now runs
 *  into — or brings close enough to cluster with — move right by the same
 *  amount, and so does whatever THEY then run into. Each keeps its gap to
 *  the card that pushed it, so nothing new overlaps (card drags would jump
 *  to undo it) and no new deck forms; cards with room to spare stay put.
 *  Measured in cardVisualRect, the rect clustering reads — it contains the
 *  slot clampGroupMove collides with. A pinned card, or a deck member drawn
 *  as a strip, has no canvas footprint to grow into. */
function pushNeighboursRight(groupId: string, before: GroupSlot, zoom: number) {
  const { groups, boards } = useBoardsStore.getState()
  const g = groups.find(gr => gr.id === groupId)
  if (!g || g.pin || isHiddenDeckMember(g)) return
  const after = cardVisualRect(g, boards, zoom)?.rect
  const shift = after ? after.right - before.right : 0
  if (!after || shift <= 0) return

  const others = canvasObstacleGroups(groups, new Set(expandWithNestedMembers([groupId], groups)))
    .flatMap(o => {
      const r = cardVisualRect(o, boards, zoom)?.rect
      return r && r.left > before.left ? [{ id: o.id, r }] : []
    })
    .sort((a, b) => a.r.left - b.r.left)
  // Everything that pushes, at its pre-push rect: the card (its old right
  // edge, its new height), then each card pushed so far. Left-to-right
  // order means a card's pushers are all decided before it is.
  const pushers: GroupSlot[] = [{ ...after, left: before.left, right: before.right }]
  const pushed: string[] = []
  for (const o of others) {
    // Within reach as rectsTouch counts it: a gap of TOUCH_GAP still touches.
    // Only cards that start at or beyond the pusher's OLD right edge: the
    // growth goes rightward from there, so a card sitting above or below
    // the pusher (its left inside the pusher's span) is never in its way.
    const hit = pushers.some(p =>
      o.r.left >= p.right - TOUCH_GAP
      && o.r.top <= p.bottom + TOUCH_GAP && o.r.bottom >= p.top - TOUCH_GAP
      && o.r.left - (p.right + shift) <= TOUCH_GAP)
    if (!hit) continue
    pushed.push(o.id)
    pushers.push(o.r)
  }
  if (pushed.length === 0) return
  // A pushed deck takes its hidden members with it.
  const moved = expandWithNestedMembers(pushed, groups)
  useBoardsStore.getState().setGroupPosBatch(moved.flatMap(id => {
    const m = groups.find(gr => gr.id === id)
    return m ? [{ groupId: id, originY: m.originY, originX: m.originX + shift }] : []
  }))
}

/** What a drop on a card landed on: a group's card, or an ungrouped
 *  board's card — which can hold content only once it is grouped, see
 *  groupForCardHit. */
export type CardHit = { groupId: string } | { boardId: string }

/** The card `el` is part of, or null. A fan's strips and its face carry
 *  the member they SHOW (`data-card-drop`), which beats the deck's own
 *  identity: the deck's link-drop names its anchor. */
export function cardHitOf(el: Element): CardHit | null {
  const member = (el.closest('[data-card-drop]') as HTMLElement | null)?.dataset.cardDrop
  if (member) return { groupId: member }
  const ref = (el.closest('[data-link-drop^="card:"]') as HTMLElement | null)?.dataset.linkDrop
  if (ref) return { groupId: ref.slice('card:'.length) }
  const layerCard = (el.closest('[data-layer-card]') as HTMLElement | null)?.dataset.layerCard
  if (layerCard) return { groupId: layerCard }
  const boardId = (el.closest('[data-nle-card]') as HTMLElement | null)?.dataset.nleCard
  if (boardId) {
    const existing = useBoardsStore.getState().groups.find(g => g.boardIds.includes(boardId))
    return existing ? { groupId: existing.id } : { boardId }
  }
  return null
}

/** Real surfaces that are not cards. */
const NOT_A_CARD = '[data-freenode],[data-viewport3d],[data-layer-block],[data-block][data-id]'

/** The card under these elements (topmost first, as elementsFromPoint
 *  lists them). Scans past chrome that carries no identity — a header, a
 *  deck's hover zone — but stops at the first real surface that is not a
 *  card: a tile, a Viewer, a block, a bar, or anything pinned other than a
 *  pinned card. The topmost hit wins; a drop never falls through onto a
 *  card hidden behind something else.
 *
 *  Pure: an ungrouped board's card comes back as its board. Group it with
 *  groupForCardHit, AFTER the undo checkpoint. */
export function cardHitAt(els: Element[]): CardHit | null {
  for (const el of els) {
    const hit = cardHitOf(el)
    if (hit) return hit
    if (el.closest(NOT_A_CARD)) return null
    if (el.closest('[data-pin-host]') && !el.closest('[data-pinned-group]')) return null
  }
  return null
}

/** The group a card hit puts content into. A board some group already
 *  holds stays in that group (default-group included — it is a real card);
 *  only a board no group holds is grouped, as a card of its own. Mutates:
 *  call after the undo checkpoint. */
export function groupForCardHit(hit: CardHit): string | null {
  if ('groupId' in hit) return hit.groupId
  const bs = useBoardsStore.getState()
  const existing = bs.groups.find(g => g.boardIds.includes(hit.boardId))
  if (existing) return existing.id
  if (!bs.boards[hit.boardId]) return null
  bs.groupBoardAsNew(hit.boardId)
  return useBoardsStore.getState().groups.find(g => g.boardIds.includes(hit.boardId))?.id ?? null
}
