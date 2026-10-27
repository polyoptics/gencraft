// railCards.ts — cards on a loop strip (utils/rail).
//
// A loop strip lays out and runs TILES. A card meets it as itself: a picture
// card dragged onto a role column leaves the canvas and is held, whole —
// its group and every block — by a docked tile that wears its face
// (`stashedCard`). The strip cascades, reorders and picks it like any
// picture. Its face still steps through its blocks (‹ ›, ←/→). Pulled off
// the strip, it is the same card again, back on the canvas.
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
import { RAIL_GEOM, RAIL_TRAY, isRail, railDropTarget, railLayout, railMembers, type RailDropTarget } from './rail'

/** A card off the canvas, held by the tile that stands for it on a strip. */
export interface StashedCard {
  group: ProjectGroup
  boards: BoardData[]
}

/** One picture of a card: the block it is in, and what it shows. */
interface Entry { boardId: string; media: MediaItem; label: string }

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
  for (const bid of gridOrder(g, boards)) {
    const b = boards[bid]
    const media = blockPicture(b)
    if (!media) continue
    const root = b.bars[b.rootIds[0]]
    const named = b.layers?.block?.label || (root?.name && root.name !== 'Untitled' ? root.name : '')
    out.push({ boardId: bid, media, label: named || g.name || 'picture' })
  }
  return out
}

const boardsOf = (st: StashedCard) => Object.fromEntries(st.boards.map(b => [b.id, b]))

/** A held card's pictures, and which one its face is on. */
export function stashSteps(st: StashedCard): { entries: Entry[]; index: number } {
  const entries = cardEntries(st.group, boardsOf(st))
  const i = entries.findIndex(e => e.boardId === st.group.faceBoardId)
  return { entries, index: Math.max(0, i) }
}

/** What the tile shows: its card's face picture. */
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

/** Step a held card's face to its next (+1) or previous (-1) picture,
 *  wrapping. Like a card's own face (stepFace): a view, not an undo step. */
export function stepStashFace(nodeId: string, dir: 1 | -1): void {
  const fs = useFreeNodeStore.getState()
  const n = fs.nodes[nodeId]
  const st = n?.stashedCard
  if (!st) return
  const { entries, index } = stashSteps(st)
  if (entries.length < 2) return
  const next = entries[(index + dir + entries.length) % entries.length]
  const stashedCard = { ...st, group: { ...st.group, faceBoardId: next.boardId } }
  fs.updateFreeNode(nodeId, { stashedCard, ...faceFields(stashedCard) })
}

/** What a run reads from a docked tile: a held card is each of its
 *  pictures ('each') or its face ('pick'), as picture tiles whose ids are
 *  `<tile id>#<block id>` (unitOwner reads the tile back). Anything else is
 *  itself. */
export function railUnits(n: FreeNodeData, mode: 'each' | 'pick'): FreeNodeData[] {
  const st = n.stashedCard
  if (!st) return [n]
  const { entries, index } = stashSteps(st)
  const used = mode === 'pick' ? entries.slice(index, index + 1) : entries
  return used.map(e => ({
    ...n, id: `${n.id}#${e.boardId}`,
    type: e.media.type === 'video' ? 'video' as const : 'image' as const,
    imageUrl: e.media.url, mediaType: e.media.type, posterUrl: e.media.posterUrl ?? null,
    label: e.label,
  }))
}

/** The docked tile a run unit came from. */
export const unitOwner = (id: string): string => id.split('#')[0]

/** Take cards off the canvas into tiles that hold them, in the order
 *  given, sized as their faces are drawn. Returns the tile ids. The
 *  caller holds the undo checkpoint. */
function stashCards(ids: string[]): string[] {
  const bs = useBoardsStore.getState()
  const zoom = useCanvasStore.getState().zoom
  const face = cardFaceSize(zoom)
  const made: string[] = []
  const gone = new Set<string>()
  const goneBoards = new Set<string>()
  for (const gid of ids) {
    const g = bs.groups.find(x => x.id === gid)
    if (!g || g.effect || g.pin) continue
    const r = drawnRect(g, bs.boards, zoom)
    const stashedCard: StashedCard = {
      // Off the canvas it is in no deck: it comes back as a card of its own.
      group: { ...g, deckState: undefined, deckAnchorId: undefined, deckOffsetX: undefined, deckOffsetY: undefined },
      boards: g.boardIds.map(b => bs.boards[b]).filter(Boolean),
    }
    const fs = useFreeNodeStore.getState()
    const id = fs.addFreeNode(r?.x ?? g.originX, r?.y ?? g.originY, 'image')
    fs.updateFreeNode(id, {
      stashedCard, ...faceFields(stashedCard),
      width: r?.width ?? face.w, height: r?.height ?? face.h,
    })
    made.push(id)
    gone.add(gid)
    g.boardIds.forEach(b => goneBoards.add(b))
  }
  if (gone.size) {
    useBoardsStore.setState(st => ({
      groups: st.groups.filter(g => !gone.has(g.id)),
      boards: Object.fromEntries(Object.entries(st.boards).filter(([b]) => !goneBoards.has(b))),
      boardOrder: st.boardOrder.filter(b => !goneBoards.has(b)),
      selectedGroupIds: st.selectedGroupIds.filter(g => !gone.has(g)),
    }))
  }
  return made
}

/** Put a held card back on the canvas, its face's top-left where the tile's
 *  is, and remove the tile. A card already on the canvas under the same id
 *  (a pasted copy of the tile) comes back under new ids. The caller holds
 *  the undo checkpoint. Returns the card's id, or null for a plain tile. */
export function releaseStashedCard(nodeId: string): string | null {
  const fs = useFreeNodeStore.getState()
  const n = fs.nodes[nodeId]
  const st = n?.stashedCard
  if (!n || !st) return null
  const bs = useBoardsStore.getState()
  const clash = bs.groups.some(g => g.id === st.group.id) || st.boards.some(b => bs.boards[b.id])
  const ids = new Map<string, string>()
  const fresh = (id: string) => clash ? (ids.get(id) ?? (ids.set(id, crypto.randomUUID()), ids.get(id)!)) : id
  const boards = st.boards.map(b => ({ ...b, id: fresh(b.id) }))
  const group: ProjectGroup = {
    ...st.group, id: fresh(st.group.id),
    boardIds: st.group.boardIds.filter(b => st.boards.some(x => x.id === b)).map(fresh),
    faceBoardId: st.group.faceBoardId ? fresh(st.group.faceBoardId) : undefined,
  }
  useBoardsStore.setState(s => ({
    groups: [...s.groups, group],
    boards: { ...s.boards, ...Object.fromEntries(boards.map(b => [b.id, b])) },
    boardOrder: [...s.boardOrder, ...boards.map(b => b.id).filter(b => b !== 'primary' && !s.boardOrder.includes(b))],
  }))
  // Line its drawn face up with the tile: the origin is not the face's corner.
  const s2 = useBoardsStore.getState()
  const r = drawnRect(group, s2.boards, useCanvasStore.getState().zoom)
  if (r) {
    const dx = n.x - r.x, dy = n.y - r.y
    useBoardsStore.setState(s => ({
      groups: s.groups.map(g => g.id === group.id ? { ...g, originX: g.originX + dx, originY: g.originY + dy } : g),
    }))
  }
  fs.deleteFreeNode(nodeId)
  return group.id
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
 *  themselves, in the order given (a deck's order; loose cards left to
 *  right is the caller's). The row takes a copy of each effect card's
 *  effect; the effect cards stay. The caller holds the undo checkpoint.
 *  Returns how many went on. */
export function dockCardsOnRail(ids: string[], t: RailDropTarget): number {
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
  const made = stashCards(cards.filter(g => !g.effect).map(g => g.id))
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
  const u = rail.rail.unit > 0 ? rail.rail.unit : 1
  const face = cardFaceSize(1)
  // Its size off the strip: the column's width at a card's shape.
  useFreeNodeStore.getState().updateFreeNode(tile, { width: RAIL_GEOM.picW * u, height: RAIL_GEOM.picW * u * (face.h / face.w) })
  useFreeNodeStore.getState().dockToRail([tile], { railId, kind: 'column', slotId: RAIL_TRAY, index: Infinity })
  return true
}
