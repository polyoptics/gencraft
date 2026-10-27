// railCards.ts — cards on a loop strip (utils/rail).
//
// A loop strip lays out and runs TILES. A card meets it as itself: a picture
// card dragged onto a role column leaves the canvas and is held, whole —
// its group and every block — by a docked tile that wears its face
// (`stashedCard`). The strip cascades, reorders and picks it like any
// picture. Its face still steps through its blocks (‹ ›, ←/→). Pulled off
// the strip, it is the same card again, back on the canvas.
//
// A closed deck docks as ONE item that stays a deck: its face steps through
// every picture of every card, it fans out in place to look at its cards,
// and pulled off it is the same deck.
//
// For a run, a docked card counts as all of its pictures ('each': every
// block, in its reading order) or as its face ('pick'): railUnits below is
// what utils/fx/railChain reads. Results come back grouped by the card they
// started from: one result card per input card, its pictures as blocks in
// the same order (landResultCard).
//
// An effect card dragged onto the slot row puts a copy of its effect there,
// settings and all, and stays where it was.

import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore, type FreeNodeData, type FreeNodeType } from '../store/freeNodeStore'
import { useRailUiStore } from '../store/railUiStore'
import { getMediaItems, type MediaItem } from '../types/bar'
import { cardFaceSize, createMediaCard, gridOrder, layoutCardGrid } from './cardGrid'
import { drawnRect } from './effectCards'
import { clientToCanvas } from './fx/createEffect'
import { knownKind } from './fx/effects'
import { RAIL_TRAY, isRail, railDropTarget, railLayout, railMembers, type RailDropTarget } from './rail'

/** One card as it was on the canvas: its group and its blocks. */
export interface HeldCard {
  group: ProjectGroup
  boards: BoardData[]
}

/** A card off the canvas, held by the tile that stands for it on a strip —
 *  or a closed DECK: `group` is its front card and `members` the rest, in
 *  deck order, every deck field kept, so it comes back the same deck. */
export interface StashedCard extends HeldCard {
  members?: HeldCard[]
  /** A deck spread out in place to look at its cards — a view. */
  fanned?: boolean
}

/** One picture: the card and block it is in, and what it shows. */
export interface Entry { groupId: string; boardId: string; media: MediaItem; label: string }

const isPicture = (m: MediaItem) => m.type === 'image' || m.type === 'video'

/** A block's first picture or video, if any. */
function blockPicture(b: BoardData | undefined): MediaItem | null {
  for (const rid of b?.rootIds ?? []) {
    const m = getMediaItems(b!.bars[rid]?.content).find(isPicture)
    if (m) return m
  }
  return null
}

/** Every picture a card holds, one per block, in its reading order. */
export function cardEntries(g: ProjectGroup, boards: Record<string, BoardData>): Entry[] {
  const out: Entry[] = []
  if (g.effect) return out
  for (const bid of gridOrder(g, boards)) {
    const b = boards[bid]
    const media = blockPicture(b)
    if (!media) continue
    const root = b.bars[b.rootIds[0]]
    const named = b.layers?.block?.label || (root?.name && root.name !== 'Untitled' ? root.name : '')
    out.push({ groupId: g.id, boardId: bid, media, label: named || g.name || 'picture' })
  }
  return out
}

const boardsOf = (c: HeldCard) => Object.fromEntries(c.boards.map(b => [b.id, b]))

/** The cards a tile holds, front first. */
export const heldCards = (st: StashedCard): HeldCard[] => [st, ...(st.members ?? [])]

/** One held card's pictures. */
export const heldEntries = (c: HeldCard): Entry[] => cardEntries(c.group, boardsOf(c))

/** The card a held deck's face shows (as on the canvas, utils/cardGrid
 *  deckFaceSteps): the one it was stepped to, else the front. */
export function shownCard(st: StashedCard): HeldCard {
  return st.members?.find(c => c.group.id === st.group.deckFaceCard) ?? st
}

/** Every picture a tile holds — a deck's, card by card in deck order — and
 *  which one its face is on. */
export function stashSteps(st: StashedCard): { entries: Entry[]; index: number } {
  const entries = heldCards(st).flatMap(heldEntries)
  const card = shownCard(st)
  const own = entries.filter(e => e.groupId === card.group.id)
  const block = own.find(e => e.boardId === card.group.faceBoardId) ?? own[0]
  return { entries, index: Math.max(0, block ? entries.indexOf(block) : 0) }
}

/** A held card's own pictures and which one it is on, for a fanned deck. */
export function heldSteps(c: HeldCard): { entries: Entry[]; index: number } {
  const entries = heldEntries(c)
  return { entries, index: Math.max(0, entries.findIndex(e => e.boardId === c.group.faceBoardId)) }
}

/** What the tile shows: the face picture. */
function faceFields(st: StashedCard): Partial<FreeNodeData> {
  const { entries, index } = stashSteps(st)
  const m = entries[index]?.media
  return {
    imageUrl: m?.url ?? null,
    mediaType: m?.type ?? null,
    posterUrl: m?.posterUrl ?? null,
    label: st.group.name || 'Card',
  }
}

/** Turn the held card `groupId` to block `boardId`; on a deck, show that
 *  card on its face too. A view, not an undo step. */
function showEntry(nodeId: string, groupId: string, boardId: string, onFace = true): void {
  const fs = useFreeNodeStore.getState()
  const st = fs.nodes[nodeId]?.stashedCard
  if (!st) return
  const turn = (c: HeldCard): HeldCard => c.group.id === groupId ? { ...c, group: { ...c.group, faceBoardId: boardId } } : c
  const front = turn(st)
  const next: StashedCard = {
    ...st, ...front,
    group: st.members && onFace ? { ...front.group, deckFaceCard: groupId } : front.group,
    members: st.members?.map(turn),
  }
  fs.updateFreeNode(nodeId, { stashedCard: next, ...faceFields(next) })
}

/** Step a tile's face to its next (+1) or previous (-1) picture — across
 *  every card of a held deck — wrapping. Like a card's own face. */
export function stepStashFace(nodeId: string, dir: 1 | -1): void {
  const st = useFreeNodeStore.getState().nodes[nodeId]?.stashedCard
  if (!st) return
  const { entries, index } = stashSteps(st)
  if (entries.length < 2) return
  const e = entries[(index + dir + entries.length) % entries.length]
  showEntry(nodeId, e.groupId, e.boardId)
}

/** In a fanned deck: step one card through its own pictures. It does not
 *  become the face unless it already is. */
export function stepHeldCard(nodeId: string, groupId: string, dir: 1 | -1): void {
  const st = useFreeNodeStore.getState().nodes[nodeId]?.stashedCard
  const c = st && heldCards(st).find(h => h.group.id === groupId)
  if (!st || !c) return
  const { entries, index } = heldSteps(c)
  if (entries.length < 2) return
  const e = entries[(index + dir + entries.length) % entries.length]
  showEntry(nodeId, groupId, e.boardId, shownCard(st).group.id === groupId)
}

/** In a fanned deck: put card `groupId` on the deck's face. */
export function showHeldCard(nodeId: string, groupId: string): void {
  const st = useFreeNodeStore.getState().nodes[nodeId]?.stashedCard
  const c = st && heldCards(st).find(h => h.group.id === groupId)
  const e = c && heldEntries(c)[heldSteps(c).index]
  if (e) showEntry(nodeId, groupId, e.boardId)
}

/** Spread a held deck out in place, or close it up. */
export function setStashFanned(nodeId: string, fanned: boolean): void {
  const fs = useFreeNodeStore.getState()
  const st = fs.nodes[nodeId]?.stashedCard
  if (st?.members?.length) fs.updateFreeNode(nodeId, { stashedCard: { ...st, fanned: fanned || undefined } })
}

/** What a run reads from a docked tile: a held card — or every card of a
 *  held deck — is each of its pictures ('each') or the face ('pick'), as
 *  picture tiles whose ids are `<tile>#<card>#<block>` (unitOwner reads the
 *  tile back, unitCard the card). Anything else is itself. */
export function railUnits(n: FreeNodeData, mode: 'each' | 'pick'): FreeNodeData[] {
  const st = n.stashedCard
  if (!st) return [n]
  const { entries, index } = stashSteps(st)
  const used = mode === 'pick' ? entries.slice(index, index + 1) : entries
  return used.map(e => ({
    ...n, id: `${n.id}#${e.groupId}#${e.boardId}`,
    type: e.media.type === 'video' ? 'video' as const : 'image' as const,
    imageUrl: e.media.url, mediaType: e.media.type, posterUrl: e.media.posterUrl ?? null,
    label: e.label,
  }))
}

/** The docked tile a run unit came from. */
export const unitOwner = (id: string): string => id.split('#')[0]
/** The held card a run unit came from (`<tile>#<card>`), or null for a
 *  loose picture. */
export const unitCard = (id: string): string | null => {
  const [tile, card] = id.split('#')
  return card ? `${tile}#${card}` : null
}
/** A held card's name, by its unitCard key. */
export function unitCardName(nodes: Record<string, FreeNodeData>, key: string): string {
  const [tile, card] = key.split('#')
  const st = nodes[tile]?.stashedCard
  return (st && heldCards(st).find(c => c.group.id === card)?.group.name) || 'Card'
}

/** Take cards off the canvas and out of the cards' store. */
function takeOff(groups: ProjectGroup[]): void {
  const gone = new Set(groups.map(g => g.id))
  const goneBoards = new Set(groups.flatMap(g => g.boardIds))
  useBoardsStore.setState(st => ({
    groups: st.groups.filter(g => !gone.has(g.id)),
    boards: Object.fromEntries(Object.entries(st.boards).filter(([b]) => !goneBoards.has(b))),
    boardOrder: st.boardOrder.filter(b => !goneBoards.has(b)),
    selectedGroupIds: st.selectedGroupIds.filter(g => !gone.has(g)),
  }))
}

/** A new tile holding `st`, at its front card's drawn box. */
function holdTile(st: StashedCard): string {
  const bs = useBoardsStore.getState()
  const zoom = useCanvasStore.getState().zoom
  const face = cardFaceSize(zoom)
  const r = drawnRect(st.group, bs.boards, zoom)
  const fs = useFreeNodeStore.getState()
  const id = fs.addFreeNode(r?.x ?? st.group.originX, r?.y ?? st.group.originY, 'image')
  fs.updateFreeNode(id, { stashedCard: st, ...faceFields(st), width: r?.width ?? face.w, height: r?.height ?? face.h })
  return id
}

const held = (g: ProjectGroup, boards: Record<string, BoardData>): HeldCard =>
  ({ group: g, boards: g.boardIds.map(b => boards[b]).filter(Boolean) })

/** Take picture cards off the canvas into tiles that hold them, one each,
 *  in the order given. Returns the tile ids. The caller holds the undo
 *  checkpoint. */
function stashCards(ids: string[]): string[] {
  const bs = useBoardsStore.getState()
  const cards = ids.map(id => bs.groups.find(g => g.id === id)).filter((g): g is ProjectGroup => !!g && !g.effect && !g.pin)
  // Off the canvas a loose card is in no deck: it comes back on its own.
  const made = cards.map(g => holdTile(held({ ...g, deckState: undefined, deckAnchorId: undefined, deckOffsetX: undefined, deckOffsetY: undefined }, bs.boards)))
  takeOff(cards)
  return made
}

/** Take a closed deck off the canvas into ONE tile: `ids[0]` is its front
 *  card, the rest in deck order — effect cards too, so the deck comes back
 *  whole. Returns the tile id, or null. The caller holds the checkpoint. */
function stashDeck(ids: string[]): string | null {
  const bs = useBoardsStore.getState()
  const cards = ids.map(id => bs.groups.find(g => g.id === id)).filter((g): g is ProjectGroup => !!g && !g.pin)
  if (cards.length === 0) return null
  const [front, ...rest] = cards.map(g => held(g, bs.boards))
  const id = holdTile({ ...front, members: rest.length ? rest : undefined })
  takeOff(cards)
  return id
}

/** Put what a tile holds back on the canvas — a card, or a deck as the
 *  same deck — its front card's face where the tile's top-left is, and
 *  remove the tile. Cards already on the canvas under the same ids (a
 *  pasted copy of the tile) come back under new ids. The caller holds the
 *  undo checkpoint. Returns the front card's id, or null for a plain tile. */
export function releaseStashedCard(nodeId: string): string | null {
  const fs = useFreeNodeStore.getState()
  const n = fs.nodes[nodeId]
  const st = n?.stashedCard
  if (!n || !st) return null
  const cards = heldCards(st)
  const bs = useBoardsStore.getState()
  const clash = cards.some(c => bs.groups.some(g => g.id === c.group.id) || c.boards.some(b => bs.boards[b.id]))
  const ids = new Map<string, string>()
  const fresh = (id: string) => clash ? (ids.get(id) ?? (ids.set(id, crypto.randomUUID()), ids.get(id)!)) : id
  // Ids inside the deck map with it; ids outside it (none, normally) stay.
  const inside = new Set(cards.flatMap(c => [c.group.id, ...c.boards.map(b => b.id)]))
  const map = (id: string | undefined) => id && inside.has(id) ? fresh(id) : id
  const boards = cards.flatMap(c => c.boards.map(b => ({ ...b, id: fresh(b.id) })))
  const groups: ProjectGroup[] = cards.map(c => ({
    ...c.group, id: fresh(c.group.id),
    boardIds: c.group.boardIds.filter(b => c.boards.some(x => x.id === b)).map(fresh),
    faceBoardId: map(c.group.faceBoardId),
    deckAnchorId: map(c.group.deckAnchorId),
    deckFaceCard: map(c.group.deckFaceCard),
  }))
  useBoardsStore.setState(s => ({
    groups: [...s.groups, ...groups],
    boards: { ...s.boards, ...Object.fromEntries(boards.map(b => [b.id, b])) },
    boardOrder: [...s.boardOrder, ...boards.map(b => b.id).filter(b => b !== 'primary' && !s.boardOrder.includes(b))],
  }))
  // Line the front card's drawn face up with the tile (the origin is not
  // the face's corner); the rest of a deck moves with it.
  const r = drawnRect(groups[0], useBoardsStore.getState().boards, useCanvasStore.getState().zoom)
  if (r) {
    const dx = n.x - r.x, dy = n.y - r.y
    const moved = new Set(groups.map(g => g.id))
    useBoardsStore.setState(s => ({
      groups: s.groups.map(g => moved.has(g.id) ? { ...g, originX: g.originX + dx, originY: g.originY + dy } : g),
    }))
  }
  fs.deleteFreeNode(nodeId)
  return groups[0].id
}

/** A stand-in tile for railDropTarget, which only reads its type. */
function probe(type: FreeNodeType): FreeNodeData {
  return { id: '', x: 0, y: 0, width: 0, height: 0, type, label: '', text: '', imageUrl: 'probe', color: '' }
}

/** The loop strip under client (x, y), looking PAST cards — the card being
 *  dragged is drawn over the canvas, right under the pointer — but stopping
 *  at the first tile: a strip under a panel takes nothing aimed at the
 *  panel. Pinned strips take nothing. */
function railUnder(x: number, y: number): FreeNodeData | null {
  const nodes = useFreeNodeStore.getState().nodes
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.closest('[data-layer-card],[data-link-drop^="card:"],[data-card-drop]')) continue
    const tile = el.closest<HTMLElement>('[data-freenode]')
    if (!tile) continue
    const n = tile.dataset.id ? nodes[tile.dataset.id] : undefined
    if (!n) return null
    const railId = isRail(n) ? n.id : n.railDock && !n.railDock.lifted ? n.railDock.railId : null
    const rail = railId ? nodes[railId] : undefined
    return rail && isRail(rail) && !rail.pin ? rail : null
  }
  return null
}

/** Where the dragged cards would go on a loop strip, let go at client
 *  (x, y): a column for picture cards, the slot row for effect cards. */
export function cardRailTarget(ids: string[], x: number, y: number): RailDropTarget | null {
  const { groups } = useBoardsStore.getState()
  const cards = ids.map(id => groups.find(g => g.id === id)).filter((g): g is ProjectGroup => !!g)
  const effects = cards.length > 0 && cards.every(g => g.effect)
  const rail = railUnder(x, y)
  if (!rail || cards.length === 0) return null
  const nodes = useFreeNodeStore.getState().nodes
  const L = railLayout(rail, railMembers(nodes).get(rail.id))
  const { cx, cy } = clientToCanvas(x, y)
  const t = L ? railDropTarget(L, rail, { x: cx, y: cy }, probe(effects ? 'effect' : 'image')) : null
  return t && (t.kind === 'row') === effects ? t : null
}

/** While a card drag is over a strip: the strip draws where it would land
 *  (railUiStore, as for a dragged tile). Null clears it. */
export function previewCardRail(t: RailDropTarget | null, draggedId: string): void {
  const rs = useRailUiStore.getState()
  if (t) rs.setDrop({ target: t, draggedId })
  else if (rs.drop?.draggedId === draggedId) rs.setDrop(null)
}

/** Put the cards on the strip at `t`. A column takes the picture cards
 *  themselves, in the order given (loose cards left to right is the
 *  caller's) — or, `asDeck`, the closed deck they make as ONE item, front
 *  card first. The row takes a copy of each effect card's effect; the
 *  effect cards stay. The caller holds the undo checkpoint. Returns how
 *  many went on. */
export function dockCardsOnRail(ids: string[], t: RailDropTarget, asDeck = false): number {
  const { groups } = useBoardsStore.getState()
  const cards = ids.map(id => groups.find(g => g.id === id)).filter((g): g is ProjectGroup => !!g)
  const fs = () => useFreeNodeStore.getState()
  if (t.kind === 'row') {
    const fx = cards.filter(g => g.effect)
    fx.forEach((g, i) => {
      const id = fs().addFreeNode(0, 0, 'effect')
      fs().updateFreeNode(id, { effect: { kind: knownKind(g.effect!.kind), params: { ...(g.effect!.params ?? {}) } }, label: g.name })
      fs().dockToRail([id], { ...t, insertAt: t.insertAt + i })
    })
    return fx.length
  }
  const deck = asDeck && cards.length > 1 ? stashDeck(cards.map(g => g.id)) : null
  const made = deck ? [deck] : stashCards(cards.filter(g => !g.effect).map(g => g.id))
  if (made.length) fs().dockToRail(made, t)
  return made.length
}

/** Land a run's results for one input card on the rail's tray: a card of
 *  their own, one block per picture in the order given, held by a tray
 *  tile like any docked card. False when the rail is gone. */
export function landResultCard(railId: string, name: string, results: { url: string; w: number; h: number; label: string }[]): boolean {
  const rail = useFreeNodeStore.getState().nodes[railId]
  if (!isRail(rail) || results.length === 0) return false
  const gid = createMediaCard({ cx: rail.x, cy: rail.y }, results.map(r => ({ media: { url: r.url, type: 'image' as const }, label: r.label })))
  if (!gid) return false
  useBoardsStore.getState().renameGroup(gid, name)
  // Their shapes are known: lay the grid out now, before it leaves.
  const g = useBoardsStore.getState().groups.find(x => x.id === gid)
  if (g) {
    const order = gridOrder(g, useBoardsStore.getState().boards)
    layoutCardGrid(gid, Object.fromEntries(order.map((b, i) => [b, results[i] && results[i].w > 0 ? results[i].h / results[i].w : 0.75])))
  }
  useBoardsStore.getState().setSelectedGroup(null)
  const [tile] = stashCards([gid])
  if (!tile) return false
  useFreeNodeStore.getState().dockToRail([tile], { railId, kind: 'column', slotId: RAIL_TRAY, index: Infinity })
  return true
}
