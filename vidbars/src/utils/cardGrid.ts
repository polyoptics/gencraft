// cardGrid.ts — cards-first: a card is the unit, and it keeps its shape.
//
// A grid card (ProjectGroup.layout === 'grid') is a card-face-shaped frame
// — portrait, the size the Blank card was set to by hand — that never grows
// wider as blocks are added. Its blocks sit inside it in rows of
// GRID_COLS small cells, in reading order (left to right, then top to
// bottom), each cell the width of a column and as tall as its picture's
// shape. Zoomed in, that grid is what you see; on the face, the arrows step
// through the blocks in the same order. More blocks than fit make the card
// taller, never wider.
//
// Every import becomes a grid card of its own (createMediaCard), and
// dropping cards onto a card merges them into it as blocks (mergeCardsInto).
// Older cards keep the layout they were built with: nothing here touches a
// card that is not a grid card.

import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { createScaleFor } from './canvasCreate'
import { loadImage } from './fx/chain'
import { getMediaItems, type MediaItem } from '../types/bar'

/** The card face on screen at the zoom it is made at: the Blank card as it
 *  was set by hand (963 × 1419 at 13%). Canvas size = this × createScaleFor. */
export const CARD_FACE_PX = { w: 125, h: 184 }
/** Blocks per row inside a grid card. */
export const GRID_COLS = 4
/** Gap between cells, as a share of the card's width. */
const GAP_FRAC = 0.025
/** The share of a fixed row a cell may fill, so rows keep a gap. */
const ROW_FILL = 0.92
/** A picture's shape before it has loaded (or a video's, which never does). */
const DEFAULT_ASPECT = 0.75

export function isGridCard(g: ProjectGroup | undefined): boolean {
  return g?.layout === 'grid'
}

/** A new card's frame, in canvas units, for the current zoom. */
export function cardFaceSize(zoom = useCanvasStore.getState().zoom): { w: number; h: number } {
  const k = createScaleFor(zoom)
  return { w: CARD_FACE_PX.w * k, h: CARD_FACE_PX.h * k }
}

/** A grid card's frame width: what it was made at (its width override). */
function frameWidth(g: ProjectGroup): number {
  return g.cardWidthOverride ?? cardFaceSize().w
}

function cellGeometry(g: ProjectGroup): { cellW: number; gap: number } {
  const w = frameWidth(g)
  const gap = w * GAP_FRAC
  return { cellW: (w - gap * (GRID_COLS - 1)) / GRID_COLS, gap }
}

/** The card's blocks in reading order: by row, then left to right. The
 *  order the grid fills and the face's arrows step in. */
export function gridOrder(g: ProjectGroup, boards: Record<string, BoardData>): string[] {
  return [...g.boardIds]
    .filter(bid => boards[bid])
    .sort((a, b) => ((boards[a].nleRow ?? 0) - (boards[b].nleRow ?? 0)) || ((boards[a].nleX ?? 0) - (boards[b].nleX ?? 0)))
}

/** A block's width at scale 1: the extent of its top-level bars. */
function contentWidth(b: BoardData): number {
  const roots = b.rootIds.map(id => b.bars[id]).filter(Boolean)
  if (roots.length === 0) return 1
  return Math.max(1, Math.max(...roots.map(r => r.x + r.width)) - Math.min(...roots.map(r => r.x)))
}

/** A block that is one picture (or video) on one bar: sized to its cell
 *  directly. Anything richer — a merged storyboard — is scaled to fit. */
function isSimpleBlock(b: BoardData): boolean {
  return b.rootIds.length === 1 && (b.bars[b.rootIds[0]]?.children.length ?? 1) === 0
}

/** The height a cell may take: its picture's shape, kept inside a fixed
 *  row (Rows: Fixed) so rows never run into each other. */
function cellHeight(cellW: number, aspect: number): number {
  const cs = useCanvasStore.getState()
  const h = cellW * aspect
  return cs.dynamicRowHeights ? h : Math.min(h, cs.nleRowHeight * ROW_FILL)
}

/** Lay a grid card's blocks out in reading order, GRID_COLS to a row,
 *  each fitted to its cell. Simple blocks keep their own shape (`aspects`,
 *  by board, for those just measured); the rest are scaled to the column.
 *  The caller takes the undo checkpoint. */
export function layoutCardGrid(groupId: string, aspects: Record<string, number> = {}): void {
  const s = useBoardsStore.getState()
  const g = s.groups.find(gr => gr.id === groupId)
  if (!g || !isGridCard(g)) return
  const { cellW, gap } = cellGeometry(g)
  const order = gridOrder(g, s.boards)
  useBoardsStore.setState(st => {
    const boards = { ...st.boards }
    order.forEach((bid, i) => {
      const b = boards[bid]
      if (!b) return
      const col = i % GRID_COLS
      const row = Math.floor(i / GRID_COLS)
      const placed: BoardData = { ...b, nleRow: row, nleX: col * (cellW + gap) }
      if (isSimpleBlock(b)) {
        const root = b.bars[b.rootIds[0]]
        const aspect = aspects[bid] ?? (root.width > 0 ? root.height / root.width : DEFAULT_ASPECT)
        placed.bars = { ...b.bars, [root.id]: { ...root, x: 0, width: cellW, height: cellHeight(cellW, aspect) } }
        placed.boardScale = 1
      } else {
        placed.boardScale = Math.max(0.25, Math.min(3, cellW / contentWidth(b)))
      }
      boards[bid] = placed
    })
    // Reading order is the stored order too, so every reader agrees.
    const groups = st.groups.map(gr => gr.id === groupId ? { ...gr, boardIds: [...order, ...gr.boardIds.filter(b => !order.includes(b))] } : gr)
    return { boards, groups }
  })
}

/** The face block's first media item, or the first block's that has one. */
export function faceMedia(g: ProjectGroup, boards: Record<string, BoardData>): { boardId: string; media: MediaItem } | null {
  const order = gridOrder(g, boards)
  const pick = (bid: string) => {
    const b = boards[bid]
    for (const rid of b?.rootIds ?? []) {
      const m = getMediaItems(b.bars[rid]?.content).find(x => x.type === 'image' || x.type === 'video')
      if (m) return { boardId: bid, media: m }
    }
    return null
  }
  if (g.faceBoardId && order.includes(g.faceBoardId)) {
    const face = pick(g.faceBoardId)
    if (face) return face
  }
  for (const bid of order) {
    const m = pick(bid)
    if (m) return m
  }
  return null
}

/** What a card's face shows: the block it has been stepped to, else its
 *  hero image, else its first picture or video. GroupCard draws this, and
 *  effects snapped to the card process it (utils/fx/cardStrips). */
export function cardFaceMedia(g: ProjectGroup, boards: Record<string, BoardData>): MediaItem | null {
  if (g.faceBoardId && g.boardIds.includes(g.faceBoardId)) {
    const f = faceMedia(g, boards)
    if (f) return f.media
  }
  if (g.cardHeroImage) return { url: g.cardHeroImage, type: 'image' }
  return faceMedia(g, boards)?.media ?? null
}

/** How many of a card's blocks the face can show, and which one it is on
 *  (0-based), for the arrows and the "2 / 5" count. */
export function faceSteps(g: ProjectGroup, boards: Record<string, BoardData>): { count: number; index: number } {
  const order = gridOrder(g, boards).filter(bid => {
    const b = boards[bid]
    return b.rootIds.some(rid => getMediaItems(b.bars[rid]?.content).some(m => m.type === 'image' || m.type === 'video'))
  })
  const f = g.faceBoardId ? order.indexOf(g.faceBoardId) : -1
  return { count: order.length, index: Math.max(0, f) }
}

/** Step the face to the next (+1) or previous (-1) block, wrapping. Not an
 *  undo step: which block a card shows is a view, like a page turned. */
export function stepFace(groupId: string, dir: 1 | -1): void {
  const s = useBoardsStore.getState()
  const g = s.groups.find(gr => gr.id === groupId)
  if (!g) return
  // Only blocks with something to show: a note-only block would leave
  // the face blank.
  const order = gridOrder(g, s.boards).filter(bid => {
    const b = s.boards[bid]
    return b.rootIds.some(rid => getMediaItems(b.bars[rid]?.content).some(m => m.type === 'image' || m.type === 'video'))
  })
  if (order.length < 2) return
  const cur = g.faceBoardId && order.includes(g.faceBoardId) ? order.indexOf(g.faceBoardId) : 0
  const next = order[(cur + dir + order.length) % order.length]
  useBoardsStore.setState(st => ({ groups: st.groups.map(gr => gr.id === groupId ? { ...gr, faceBoardId: next } : gr) }))
}

/** A picture's height/width once it has loaded, or null (videos, failures). */
async function measure(media: MediaItem): Promise<number | null> {
  if (media.type !== 'image') return null
  const img = await loadImage(media.url)
  return img && img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : null
}

/** Put one media item into a grid card as a block of its own, in the next
 *  cell. Fills the card's untouched first block before adding one. The
 *  caller takes the undo checkpoint. Returns the block's board id. */
export function addMediaToGridCard(groupId: string, media: MediaItem, label?: string, unusedBoardId?: string | null): string | null {
  const s = useBoardsStore.getState()
  const g = s.groups.find(gr => gr.id === groupId)
  if (!g) return null
  const boardId = unusedBoardId ?? s.createBoard(0, 0)
  if (!unusedBoardId) {
    useBoardsStore.setState(st => ({
      // createBoard files a new board under the FIRST card; it belongs here
      // only, or it would show in both.
      groups: st.groups.map(gr => gr.id === groupId
        ? { ...gr, boardIds: [...gr.boardIds.filter(b => b !== boardId), boardId] }
        : { ...gr, boardIds: gr.boardIds.filter(b => b !== boardId) }),
      // Last in reading order until the layout below places it.
      boards: { ...st.boards, [boardId]: { ...st.boards[boardId], nleRow: 1e6, nleX: 0 } },
    }))
  }
  const store = useBoardsStore.getState()
  const rootBar = store.boards[boardId]?.rootIds[0]
  if (!rootBar) return null
  if (label) { store.renameBar(boardId, rootBar, label); store.setBlockLabel(boardId, label) }
  store.setContent(boardId, rootBar, { media: [media] })
  layoutCardGrid(groupId)
  // Its own shape once the picture has been read. Not an undo step of its
  // own: it only finishes what this one began.
  void measure(media).then(aspect => { if (aspect) layoutCardGrid(groupId, { [boardId]: aspect }) })
  return boardId
}

/** A new grid card holding `items`, one block each, its frame's top-left
 *  at (cx, cy) less half its size (centred there). Named after the first
 *  item. The caller takes the undo checkpoint. Returns the group id. */
export function createMediaCard(at: { cx: number; cy: number }, items: { media: MediaItem; label?: string }[]): string | null {
  if (items.length === 0) return null
  const size = cardFaceSize()
  const bs = useBoardsStore.getState()
  const boardId = bs.createBoard(0, 0)
  const groupId = bs.createGroup(items[0].label || 'Card', [boardId])
  useBoardsStore.setState(st => ({
    groups: st.groups.map(gr => gr.id === groupId ? {
      ...gr, layout: 'grid' as const,
      cardWidthOverride: size.w, cardHeightOverride: size.h,
      // The frame's left is its first cell's left: the block's content
      // starts one board padding (20) right of the origin.
      originX: at.cx - size.w / 2 - 20, originY: at.cy - size.h / 2,
    } : gr),
  }))
  items.forEach((it, i) => addMediaToGridCard(groupId, it.media, it.label, i === 0 ? boardId : null))
  return groupId
}

/** Merge `sourceIds` cards into `targetId`: every block of each source
 *  joins the target, in the sources' own reading order, and the source
 *  cards are gone. A grid target lays them out in its grid; any other
 *  target takes them on its next row. The caller takes the undo checkpoint
 *  (one step: undo puts every card back). */
export function mergeCardsInto(targetId: string, sourceIds: string[]): boolean {
  const s = useBoardsStore.getState()
  const target = s.groups.find(g => g.id === targetId)
  // Effect cards (utils/effectCards) are never blocks: they neither take
  // a merge nor go into one — dragged along with a card, they stay cards.
  const sources = sourceIds.map(id => s.groups.find(g => g.id === id)).filter((g): g is ProjectGroup => !!g && g.id !== targetId && !g.pin && !g.effect)
  if (!target || target.pin || target.effect || sources.length === 0) return false
  const moving = sources.flatMap(src => gridOrder(src, s.boards))
  const nextRow = Math.max(-1, ...target.boardIds.map(b => s.boards[b]?.nleRow ?? 0)) + 1
  useBoardsStore.setState(st => {
    const boards = { ...st.boards }
    moving.forEach((bid, i) => {
      // Behind the target's own blocks in reading order: the grid places
      // them; a non-grid target gets them on a row of their own.
      if (boards[bid]) boards[bid] = { ...boards[bid], nleRow: nextRow, nleX: i * 1e-3 + (isGridCard(target) ? 1e6 : 0) }
    })
    if (!isGridCard(target)) {
      let x = 0
      for (const bid of moving) {
        const b = boards[bid]
        if (!b) continue
        boards[bid] = { ...b, nleX: x }
        x += contentWidth(b) * (b.boardScale ?? 1) + 60
      }
    }
    const gone = new Set(sources.map(g => g.id))
    const groups = st.groups
      .filter(g => !gone.has(g.id))
      .map(g => g.id === targetId ? { ...g, boardIds: [...g.boardIds, ...moving] } : g)
    return { boards, groups, selectedGroupIds: [targetId] }
  })
  layoutCardGrid(targetId)
  return true
}
