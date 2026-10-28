// railCards.ts — cards on a loop strip (utils/rail).
//
// A card on a strip IS the canvas card: the same group, drawn by CardLayer
// with its title band, frame, deck edges and < > stepping, behaving as it
// does anywhere. The strip only decides where it sits. It does that through
// a stand-in tile (`cardRef`): an invisible docked free node that the
// strip lays out, cascades, reorders and picks like any picture, and that
// useRailSync follows by moving the card — or a whole deck, by its front
// card — to the stand-in's place.
//
// Dragging a docked card lifts its stand-in (the column closes up); let go
// on a column it docks there, anywhere else it stays where it was let go,
// off the strip. A strip deleted, or its tray taken off, sets its cards
// down on the canvas below it.
//
// For a run, a docked card counts as all of its pictures ('each': every
// block, in its reading order — a deck's, card by card) or as its face
// ('pick'). Results come back grouped by the card they started from: one
// result card per input card, its pictures as blocks in the same order
// (landResultCard), stepped in step with it (followFaces).
//
// An effect card dragged onto the slot row puts a copy of its effect there,
// settings and all, and stays where it was.

import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore, type FreeNodeData, type FreeNodeType } from '../store/freeNodeStore'
import { useRailUiStore } from '../store/railUiStore'
import { expandWithNestedMembers } from '../hooks/useCardDecks'
import { getMediaItems, type MediaItem } from '../types/bar'
import { createMediaCard, deckFaceSteps, gridOrder, layoutCardGrid } from './cardGrid'
import { drawnRect } from './effectCards'
import { clientToCanvas } from './fx/createEffect'
import { knownKind } from './fx/effects'
import { RAIL_TRAY, isRail, railDropTarget, railLayout, railMembers, type RailDropTarget } from './rail'

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

/** The cards of the deck `anchorId` fronts — closed or fanned — front first,
 *  then as they lay before it closed. Just the card when it fronts none. */
export function deckCards(anchorId: string, groups: ProjectGroup[]): string[] {
  const anchor = groups.find(g => g.id === anchorId)
  if (!anchor) return []
  if (!anchor.deckState || anchor.deckState === 'open') return [anchorId]
  const rest = groups.filter(g => g.id !== anchorId && g.deckAnchorId === anchorId && g.deckState && g.deckState !== 'open')
    .sort((a, b) => ((a.deckOffsetX ?? 0) - (b.deckOffsetX ?? 0)) || ((a.deckOffsetY ?? 0) - (b.deckOffsetY ?? 0)))
  return [anchorId, ...rest.map(g => g.id)]
}

/** Every picture a docked card (or deck) holds, and which one its face is
 *  on — read live from the card. */
export function dockedSteps(cardId: string): { entries: Entry[]; index: number } {
  const { groups, boards } = useBoardsStore.getState()
  const ids = deckCards(cardId, groups)
  const cards = ids.map(id => groups.find(g => g.id === id)).filter((g): g is ProjectGroup => !!g)
  const entries = cards.flatMap(g => cardEntries(g, boards))
  if (cards.length === 0) return { entries, index: 0 }
  let groupId = cards[0].id, boardId = cards[0].faceBoardId
  if (ids.length > 1) {
    const f = deckFaceSteps(cards[0], ids, groups, boards)
    const e = f.entries[f.index]
    if (e) { groupId = e.groupId; boardId = e.boardId }
  }
  const own = entries.filter(e => e.groupId === groupId)
  const at = own.find(e => e.boardId === boardId) ?? own[0]
  return { entries, index: Math.max(0, at ? entries.indexOf(at) : 0) }
}

/** What a run reads from a docked tile: a card's stand-in is each of the
 *  card's pictures ('each') or its face ('pick'), as picture tiles whose ids
 *  are `<tile>#<card>#<block>` (unitOwner reads the tile back, unitCard the
 *  card). Anything else is itself. */
export function railUnits(n: FreeNodeData, mode: 'each' | 'pick'): FreeNodeData[] {
  if (!n.cardRef) return [n]
  const { entries, index } = dockedSteps(n.cardRef)
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
/** The card a run unit came from (`<tile>#<card>`), or null for a loose
 *  picture. */
export const unitCard = (id: string): string | null => {
  const [tile, card] = id.split('#')
  return card ? `${tile}#${card}` : null
}
/** The card id in a unitCard key. */
export const unitCardId = (key: string): string => key.split('#')[1] ?? ''

/** The stand-ins of cards `ids`. */
function standIns(ids: string[]): FreeNodeData[] {
  const set = new Set(ids)
  return Object.values(useFreeNodeStore.getState().nodes).filter(n => n.cardRef && set.has(n.cardRef))
}

/** A card drag has started: lift the stand-ins of those of `ids` that are
 *  docked, so their columns close up and the strip stops placing them. */
export function liftDockedCards(ids: string[]): void {
  const fs = useFreeNodeStore.getState()
  for (const n of standIns(ids)) {
    if (n.railDock && !n.railDock.lifted) fs.updateFreeNode(n.id, { railDock: { ...n.railDock, lifted: true } })
  }
}

/** A card drag has ended, not on a strip: docked cards that were lifted
 *  stay where they were let go, off their strip; a press that never moved
 *  leaves them docked. */
export function endDockedDrag(ids: string[], moved: boolean): void {
  const fs = useFreeNodeStore.getState()
  for (const n of standIns(ids)) {
    if (!n.railDock?.lifted) continue
    if (moved) fs.deleteFreeNode(n.id)
    else fs.updateFreeNode(n.id, { railDock: { ...n.railDock, lifted: undefined } })
  }
}

/** Cards `ids` with every card of the decks they front. */
function deckCardsOf(ids: string[]): Set<string> {
  const { groups } = useBoardsStore.getState()
  return new Set(expandWithNestedMembers(ids.flatMap(id => deckCards(id, groups)), groups))
}

/** Dock cards `ids` (each the front of its deck, or a card of its own) in
 *  the column at `t`, in that order. A card already on a strip moves. */
function dockCards(ids: string[], t: Extract<RailDropTarget, { kind: 'column' }>): number {
  const fs = useFreeNodeStore.getState()
  const bs = useBoardsStore.getState()
  for (const old of standIns(ids)) fs.deleteFreeNode(old.id)
  const zoom = useCanvasStore.getState().zoom
  const made: string[] = []
  for (const gid of ids) {
    const g = bs.groups.find(x => x.id === gid)
    if (!g || g.pin) continue
    const r = drawnRect(g, bs.boards, zoom)
    if (!r) continue
    const id = fs.addFreeNode(r.x, r.y, 'image')
    fs.updateFreeNode(id, { cardRef: gid, label: g.name, width: r.width, height: r.height })
    made.push(id)
  }
  if (made.length) {
    fs.dockToRail(made, t)
    // Drawn in cascade order, each over the one above it: last in the list.
    const order = deckCardsOf(ids)
    useBoardsStore.setState(s => ({ groups: [...s.groups.filter(g => !order.has(g.id)), ...s.groups.filter(g => order.has(g.id))] }))
  }
  return made.length
}

/** Move card `id` — with every card of the deck it fronts — so its drawn
 *  face's top-left is at (x, y). Returns whether it moved. */
export function placeCard(id: string, x: number, y: number): boolean {
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(gr => gr.id === id)
  const r = g ? drawnRect(g, bs.boards, useCanvasStore.getState().zoom) : null
  if (!r) return false
  const dx = x - r.x, dy = y - r.y
  if (Math.abs(dx) < 0.25 && Math.abs(dy) < 0.25) return false
  const moving = deckCardsOf([id])
  useBoardsStore.setState(s => ({
    groups: s.groups.map(gr => moving.has(gr.id) ? { ...gr, originX: gr.originX + dx, originY: gr.originY + dy } : gr),
  }))
  return true
}

/** A stand-in tile for railDropTarget, which only reads its type. */
function probe(type: FreeNodeType): FreeNodeData {
  return { id: '', x: 0, y: 0, width: 0, height: 0, type, label: '', text: '', imageUrl: 'probe', color: '' }
}

/** The loop strip under client (x, y), looking PAST cards — the card being
 *  dragged is drawn over the canvas, right under the pointer, and docked
 *  cards lie over their strip — but stopping at the first tile: a strip
 *  under a panel takes nothing aimed at the panel. Pinned strips take
 *  nothing. */
function railUnder(x: number, y: number): FreeNodeData | null {
  const nodes = useFreeNodeStore.getState().nodes
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.closest('[data-layer-card],[data-link-drop^="card:"],[data-card-drop],[data-group-card]')) continue
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
 *  caller's; a deck is given by its front card and goes as one). The row
 *  takes a copy of each effect card's effect; the effect cards stay. The
 *  caller holds the undo checkpoint. Returns how many went on. */
export function dockCardsOnRail(ids: string[], t: RailDropTarget): number {
  const { groups } = useBoardsStore.getState()
  const cards = ids.map(id => groups.find(g => g.id === id)).filter((g): g is ProjectGroup => !!g)
  const fs = () => useFreeNodeStore.getState()
  if (t.kind === 'row') {
    const fx = cards.filter(g => g.effect)
    fx.forEach((g, i) => {
      const id = fs().addFreeNode(0, 0, 'effect')
      fs().updateFreeNode(id, { effect: { kind: knownKind(g.effect!.kind), params: { ...(g.effect!.params ?? {}) }, text: g.effect!.text }, label: g.name })
      fs().dockToRail([id], { ...t, insertAt: t.insertAt + i })
    })
    return fx.length
  }
  if (t.kind === 'input') return 0   // a card from the canvas is never a side input (utils/rail)
  return dockCards(cards.filter(g => !g.effect).map(g => g.id), t)
}

/** Land a run's results for one input card on the rail's tray: a card of
 *  their own, one block per picture in the order given, docked like any
 *  card, and stepped in step with its input (`source`). False when the
 *  rail is gone. */
export function landResultCard(railId: string, name: string, source: string, results: { url: string; w: number; h: number; label: string }[]): boolean {
  const rail = useFreeNodeStore.getState().nodes[railId]
  if (!isRail(rail) || results.length === 0) return false
  const gid = createMediaCard({ cx: rail.x, cy: rail.y }, results.map(r => ({ media: { url: r.url, type: 'image' as const }, label: r.label })))
  if (!gid) return false
  const bs = useBoardsStore.getState()
  bs.renameGroup(gid, name)
  // Their shapes are known: lay the grid out now.
  const g = useBoardsStore.getState().groups.find(x => x.id === gid)
  if (g) {
    const order = gridOrder(g, useBoardsStore.getState().boards)
    layoutCardGrid(gid, Object.fromEntries(order.map((b, i) => [b, results[i] && results[i].w > 0 ? results[i].h / results[i].w : 0.75])))
  }
  // On the same picture as its input, from the start.
  const st = useBoardsStore.getState()
  const input = st.groups.find(x => x.id === source)
  const made = st.groups.find(x => x.id === gid)
  const at = input ? Math.max(0, cardEntries(input, st.boards).findIndex(e => e.boardId === input.faceBoardId)) : 0
  const face = made ? cardEntries(made, st.boards)[at]?.boardId : undefined
  useBoardsStore.setState(s => ({ groups: s.groups.map(x => x.id === gid ? { ...x, railSource: source, faceBoardId: face } : x) }))
  bs.setSelectedGroup(null)
  return dockCards([gid], { railId, kind: 'column', slotId: RAIL_TRAY, index: Infinity }) > 0
}

/** Result cards step with the card they were made from (`railSource`):
 *  stepping the input to picture 3 shows result 3, and stepping a result
 *  steps its input — and the input's other results — to match. Only where
 *  a result holds one picture per input picture. Given the cards before and
 *  after a change; a view, so no undo step. */
export function followFaces(prev: ProjectGroup[], next: ProjectGroup[], boards: Record<string, BoardData>): void {
  const results = next.filter(g => g.railSource)
  if (results.length === 0) return
  const before = new Map(prev.map(g => [g.id, g.faceBoardId]))
  const changed = next.filter(g => before.has(g.id) && before.get(g.id) !== g.faceBoardId)
  if (changed.length === 0) return
  const byId = new Map(next.map(g => [g.id, g]))
  const want = new Map<string, string>()
  const turn = (g: ProjectGroup, i: number) => {
    const e = cardEntries(g, boards)[i]
    if (e && e.boardId !== g.faceBoardId) want.set(g.id, e.boardId)
  }
  for (const c of changed) {
    const input = c.railSource ? byId.get(c.railSource) : c
    if (!input) continue
    const entries = cardEntries(c, boards)
    if (entries.length === 0) continue
    const index = Math.max(0, entries.findIndex(e => e.boardId === c.faceBoardId))
    const n = cardEntries(input, boards).length
    const outs = results.filter(r => r.railSource === input.id && cardEntries(r, boards).length === n)
    if (c.railSource && !outs.includes(c)) continue
    for (const g of [input, ...outs]) if (g !== c) turn(g, index)
  }
  if (want.size) {
    useBoardsStore.setState(s => ({ groups: s.groups.map(g => want.has(g.id) ? { ...g, faceBoardId: want.get(g.id) } : g) }))
  }
}
