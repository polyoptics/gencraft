// snipCards — pieces cut out of a picture are CARDS, and pieces of the same
// picture close into one deck (ProjectGroup.snipOf), newest on top. The Viewer's
// image tools land here (ImageStudio), and tilesToCards brings over image tiles
// left on the canvas from before snips were cards.

import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { createMediaCard, gridOrder, layoutCardGrid } from './cardGrid'
import { drawnRect } from './effectCards'
import { deckCards, placeCard } from './railCards'
import { lyingLeft } from './deckAway'
import { expandTileIds } from './tileDecks'
import { putAwayUnder, isShut } from './deckTree'

export interface SnipPiece {
  url: string
  /** Height over width, so the card holds the piece at its own shape. */
  aspect: number
  label: string
  /** What it was cut from: pieces of one source share a deck. */
  source: string
}

const rectOf = (id: string) => {
  const s = useBoardsStore.getState()
  const g = s.groups.find(x => x.id === id)
  return g ? drawnRect(g, s.boards, useCanvasStore.getState().zoom) : null
}

/** What a card keeps to name its source. A data: url is the whole picture,
 *  which must not ride along on every card cut from it, so it keeps a hash. */
function sourceKey(source: string): string {
  if (!source.startsWith('data:')) return source
  let h = 0
  for (let i = 0; i < source.length; i++) h = (h * 31 + source.charCodeAt(i)) | 0
  return `data:${source.length}:${h}`
}

/** The deck, or lone card, earlier pieces of `source` left on the canvas. A
 *  card on a loop strip or pinned to the screen has been taken away. */
function sourceFront(source: string): ProjectGroup | null {
  const { groups } = useBoardsStore.getState()
  const docked = new Set(Object.values(useFreeNodeStore.getState().nodes).map(n => n.cardRef))
  const mine = groups.filter(g => g.snipOf === source && !g.pin && !docked.has(g.id))
  const inDeck = mine.find(g => isShut(g) && g.deckAnchorId)
  if (inDeck) return groups.find(g => g.id === inDeck.deckAnchorId) ?? inDeck
  return mine[mine.length - 1] ?? null
}

/** A new card for `piece`: on top of its source's deck, which stays where it
 *  is, or at `firstSlot` when it is the first. The caller takes the undo
 *  checkpoint. Returns the card, or null when none could be made. */
export function landSnip(piece: SnipPiece, firstSlot: () => { x: number; y: number }): string | null {
  const source = sourceKey(piece.source)
  const front = sourceFront(source)
  const at = front ? rectOf(front.id) : null
  const gid = createMediaCard({ cx: 0, cy: 0 }, [{ media: { url: piece.url, type: 'image' }, label: piece.label }])
  if (!gid) return null
  useBoardsStore.setState(s => ({ groups: s.groups.map(g => g.id === gid ? { ...g, snipOf: source } : g) }))
  const made = useBoardsStore.getState().groups.find(g => g.id === gid)
  if (made) {
    const [board] = gridOrder(made, useBoardsStore.getState().boards)
    if (board) layoutCardGrid(gid, { [board]: piece.aspect })
  }
  if (!front || !at) {
    const slot = firstSlot()
    placeCard(gid, slot.x, slot.y)
    return gid
  }
  placeCard(gid, at.x, at.y)
  // The older cards open to the right of the new one (setDeckState keeps the
  // layout they closed from), so the deck reads newest first when opened.
  // A deck lying left of its front (utils/deckAway) goes on to the left
  // instead. One with cards on both sides of its front (a primary card in
  // the middle) goes far enough right that those on its left clear the new card.
  const kids = putAwayUnder(front.id, useBoardsStore.getState().groups)
  const w = rectOf(gid)?.width ?? at.width
  const leftward = kids.length > 0 && lyingLeft(kids)
  const reach = leftward ? 0 : Math.max(0, ...kids.map(k => -(k.deckOffsetX ?? 0)))
  placeCard(front.id, leftward ? at.x - at.width : at.x + w + reach, at.y)
  const older = deckCards(front.id, useBoardsStore.getState().groups)
  useBoardsStore.getState().setDeckState([gid, ...older], 'stacked', { asGiven: true })
  return gid
}

/** An image tile that can become a card. Tiles on a strip are the strip's. */
export function canBecomeCard(n: FreeNodeData | undefined): n is FreeNodeData {
  return !!n && n.type === 'image' && !!n.imageUrl && !n.pin && !n.railDock && !n.cardRef
}

/** Turn image tiles into cards, each at its tile's place. Tiles from one
 *  source share a deck: `snipOf`, or the "✂" label older snips carry. Any
 *  other picture stays a card of its own. Takes no undo checkpoint. Returns
 *  the front of each deck or lone card. */
export function tilesToCards(ids: string[]): string[] {
  const fs = useFreeNodeStore.getState()
  const tiles = expandTileIds(ids, fs.nodes).map(id => fs.nodes[id]).filter(canBecomeCard)
  const made = new Map<string, string>()
  for (const t of tiles) {
    const source = t.snipOf ?? (t.label.endsWith('✂') ? `label:${t.label}` : `tile:${t.id}`)
    const gid = landSnip({
      url: t.imageUrl!,
      aspect: t.width > 0 && t.height > 0 ? t.height / t.width : 0.75,
      label: t.label,
      source,
    }, () => ({ x: t.x, y: t.y }))
    if (!gid) continue
    // Keyed by the deck's own front: the latest card landed is on top.
    made.set(source, gid)
    fs.deleteFreeNode(t.id)
  }
  return [...made.values()]
}
