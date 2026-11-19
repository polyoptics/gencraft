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
// Each block remembers the card it was, and pulled out comes back as that
// card (extractBlockToCard).
// Older cards keep the layout they were built with: nothing here touches a
// card that is not a grid card.

import { NEW_CARD_FACE, useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { createScaleFor } from './canvasCreate'
import { loadImage } from './fx/chain'
import { getMediaItems, type MediaItem } from '../types/bar'
import { layoutCutCard, readClipLengths } from './cutCard'
import { ensureModelPoster, getModelPoster, usePosterMapStore } from '../three/posterService'
import { byLay } from './deckAway'
import { hasNoPicture, stampMadeWith, withAdded } from './madeWith'

// A new poster for a model (the Viewer's SNAP, or one just rendered)
// goes onto every block holding that model at once, so card faces, block
// thumbnails and anything reading `posterUrl` show it straight away.
// One url at a time only: the store loading from disk changes them all,
// and that is not a new poster.
usePosterMapStore.subscribe((s, prev) => {
  const changed = Object.keys(s.map).filter(k => s.map[k] && s.map[k] !== prev.map[k])
  if (changed.length !== 1) return
  const url = changed[0], poster = s.map[url]
  const { boards } = useBoardsStore.getState()
  let next: Record<string, BoardData> | null = null
  for (const [bid, board] of Object.entries(boards)) {
    for (const [rid, bar] of Object.entries(board.bars)) {
      const media = bar.content.media
      if (!media?.some(m => m.type === 'model' && m.url === url && m.posterUrl !== poster)) continue
      next ??= { ...boards }
      const nb = next[bid] === board ? (next[bid] = { ...board, bars: { ...board.bars } }) : next[bid]
      nb.bars[rid] = { ...bar, content: { ...bar.content, media: media.map(m => m.type === 'model' && m.url === url ? { ...m, posterUrl: poster } : m) } }
    }
  }
  if (next) useBoardsStore.setState({ boards: next })
})

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
  // A Rough Cut lays its clips out as a cut, not a grid.
  if (g.cut) { layoutCutCard(groupId); void readClipLengths(groupId); return }
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

/** What a media item shows on a card face: a picture or a video as
 *  itself, a 3D model as its rendered poster (the thumbnail its tile
 *  showed), anything else nothing. */
function faceable(m: MediaItem): MediaItem | null {
  if (m.type === 'image' || m.type === 'video') return m
  if (m.type === 'model') {
    const poster = getModelPoster(m.url) ?? m.posterUrl
    return poster ? { url: poster, type: 'image', originalName: m.originalName } : null
  }
  return null
}

/** The face block's first media item, or the first block's that has one. */
export function faceMedia(g: ProjectGroup, boards: Record<string, BoardData>): { boardId: string; media: MediaItem } | null {
  const order = gridOrder(g, boards)
  const pick = (bid: string) => {
    const b = boards[bid]
    for (const rid of b?.rootIds ?? []) {
      for (const x of getMediaItems(b.bars[rid]?.content)) {
        const m = faceable(x)
        if (m) return { boardId: bid, media: m }
      }
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

/** The file a card's face is on, as its block holds it: a 3D model's own
 *  url, not the poster the face draws it with. The same choice as
 *  cardFaceMedia. A Viewer matches the face by this, so clicking a deck of
 *  models shows the one on its face there, not the deck's first. */
export function cardFaceSourceUrl(g: ProjectGroup, boards: Record<string, BoardData>): string | null {
  const blocks = faceBlocks(g, boards)
  const stepped = !!g.faceBoardId && blocks.includes(g.faceBoardId)
  if (!stepped && g.cardHeroImage) return g.cardHeroImage
  const b = boards[stepped ? g.faceBoardId! : blocks[0]]
  for (const rid of b?.rootIds ?? []) {
    for (const m of getMediaItems(b.bars[rid]?.content)) {
      if (m.type === 'image' || m.type === 'video' || m.type === 'model') return m.url
    }
  }
  return null
}

/** Turn card `anchorId`, or the card of its deck that holds `url`, to the
 *  block with that file: a Viewer it is docked to stepped there, and the
 *  deck shows what the Viewer shows (Brian 2026-10-30). A stacked deck
 *  brings that card to its face. A view, not an undo step. False when no
 *  block of theirs holds it (a text page, a nested deck's card). */
export function turnFaceToUrl(anchorId: string, url: string): boolean {
  const s = useBoardsStore.getState()
  const anchor = s.groups.find(g => g.id === anchorId)
  if (!anchor) return false
  const stacked = anchor.deckState === 'stacked'
  const cards = [anchor, ...s.groups.filter(g => g.id !== anchorId && g.deckAnchorId === anchorId)]
  for (const g of cards) {
    if (g.effect) continue
    const holds = (bid: string) => s.boards[bid].rootIds.some(rid => getMediaItems(s.boards[bid].bars[rid]?.content).some(m => m.url === url))
    const block = faceBlocks(g, s.boards).find(holds)
    const hero = !block && g.cardHeroImage === url
    if (!block && !hero) continue
    useBoardsStore.setState(st => ({
      groups: st.groups.map(x => {
        let out = x
        if (x.id === g.id && x.faceBoardId !== block) out = { ...out, faceBoardId: block }
        if (stacked && x.id === anchorId && x.deckFaceCard !== g.id) out = { ...out, deckFaceCard: g.id }
        return out
      }),
    }))
    return true
  }
  return false
}

/** A card's blocks the face can show — those with a picture, video or 3D
 *  model — in reading order. A note-only block would leave the face blank. */
export function faceBlocks(g: ProjectGroup, boards: Record<string, BoardData>): string[] {
  return gridOrder(g, boards).filter(bid => {
    const b = boards[bid]
    return b.rootIds.some(rid => getMediaItems(b.bars[rid]?.content).some(m => m.type === 'image' || m.type === 'video' || m.type === 'model'))
  })
}

/** How many of a card's blocks the face can show, and which one it is on
 *  (0-based), for the arrows and the "2 / 5" count. */
export function faceSteps(g: ProjectGroup, boards: Record<string, BoardData>): { count: number; index: number } {
  const order = faceBlocks(g, boards)
  const f = g.faceBoardId ? order.indexOf(g.faceBoardId) : -1
  return { count: order.length, index: Math.max(0, f) }
}

/** Step the face to the next (+1) or previous (-1) block, wrapping. Not an
 *  undo step: which block a card shows is a view, like a page turned. */
export function stepFace(groupId: string, dir: 1 | -1): void {
  const s = useBoardsStore.getState()
  const g = s.groups.find(gr => gr.id === groupId)
  if (!g) return
  const order = faceBlocks(g, s.boards)
  if (order.length < 2) return
  const cur = g.faceBoardId && order.includes(g.faceBoardId) ? order.indexOf(g.faceBoardId) : 0
  const next = order[(cur + dir + order.length) % order.length]
  useBoardsStore.setState(st => ({ groups: st.groups.map(gr => gr.id === groupId ? { ...gr, faceBoardId: next } : gr) }))
}

/** A closed deck's face: every picture block of every card in it, card by
 *  card in deck order (`memberIds`, front card first), each card's in its
 *  reading order — and which one the face is on. Effect cards hold none.
 *  `card` is the member the face shows, whose own face block it is on. */
export function deckFaceSteps(anchor: ProjectGroup, memberIds: string[], groups: ProjectGroup[], boards: Record<string, BoardData>):
  { entries: { groupId: string; boardId: string }[]; index: number; card: ProjectGroup } {
  const members = memberIds.map(id => groups.find(g => g.id === id)).filter((g): g is ProjectGroup => !!g && !g.effect)
  const entries = members.flatMap(g => faceBlocks(g, boards).map(boardId => ({ groupId: g.id, boardId })))
  const card = members.find(g => g.id === anchor.deckFaceCard) ?? anchor
  const blocks = faceBlocks(card, boards)
  const block = card.faceBoardId && blocks.includes(card.faceBoardId) ? card.faceBoardId : blocks[0]
  const index = entries.findIndex(e => e.groupId === card.id && e.boardId === block)
  return { entries, index: Math.max(0, index), card }
}

/** Step a closed deck's face to the next (+1) or previous (-1) picture
 *  across all its cards, wrapping. Turns the member to that block too, so
 *  effects on it process what the deck shows. A view, not an undo step. */
export function stepDeckFace(anchorId: string, memberIds: string[], dir: 1 | -1): void {
  const s = useBoardsStore.getState()
  const anchor = s.groups.find(g => g.id === anchorId)
  if (!anchor) return
  const { entries, index } = deckFaceSteps(anchor, memberIds, s.groups, s.boards)
  if (entries.length < 2) return
  const next = entries[(index + dir + entries.length) % entries.length]
  useBoardsStore.setState(st => ({
    groups: st.groups.map(g => {
      let out = g
      if (g.id === anchorId) out = { ...out, deckFaceCard: next.groupId }
      if (g.id === next.groupId) out = { ...out, faceBoardId: next.boardId }
      return out
    }),
  }))
}

/** The cards of the closed deck `anchorId` anchors, front first then as they
 *  lay before stacking. For a caller with no Deck at hand (the keyboard). */
export function stackedDeckMembers(anchorId: string, groups: ProjectGroup[]): string[] {
  const anchor = groups.find(g => g.id === anchorId)
  if (anchor?.deckState !== 'stacked') return []
  const kids = groups.filter(g => g.id !== anchorId && g.deckAnchorId === anchorId && g.deckState === 'stacked')
  const rest = byLay(kids)
  return [anchorId, ...rest.map(g => g.id)]
}

/** Set (or, null, reset) the thumbnail of the video on card `groupId`'s
 *  face: the frame at `time`, as a small image (`url`, a data: url). It
 *  becomes the video's poster — what every face, deck, browser and loop
 *  strip shows of it while it is not playing. The caller takes the undo
 *  checkpoint. False when the face is not a video. */
export function setFaceThumbnail(groupId: string, thumb: { time: number; url: string } | null): boolean {
  const s = useBoardsStore.getState()
  const g = s.groups.find(gr => gr.id === groupId)
  const face = g ? faceMedia(g, s.boards) : null
  if (!face || face.media.type !== 'video') return false
  const b = s.boards[face.boardId]
  for (const rid of b.rootIds) {
    const items = getMediaItems(b.bars[rid]?.content)
    const i = items.findIndex(m => m.url === face.media.url)
    if (i < 0) continue
    const m = items[i]
    const next: MediaItem = { ...m }
    if (thumb) {
      if (m.posterTime === undefined) next.posterOriginal = m.posterUrl
      next.posterUrl = thumb.url
      next.posterTime = thumb.time
    } else {
      next.posterUrl = m.posterTime === undefined ? m.posterUrl : m.posterOriginal
      delete next.posterTime
      delete next.posterOriginal
      if (!next.posterUrl) delete next.posterUrl
    }
    s.setContent(face.boardId, rid, { media: items.map((x, j) => j === i ? next : x) })
    return true
  }
  return false
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
  const firstPicture = hasNoPicture(groupId)
  media = withAdded(media)
  store.setContent(boardId, rootBar, { media: [media] })
  layoutCardGrid(groupId)
  // Its own shape once the picture has been read. Not an undo step of its
  // own: it only finishes what this one began.
  void measure(media).then(aspect => { if (aspect) layoutCardGrid(groupId, { [boardId]: aspect }) })
  // A picture that says how it was made (a Midjourney download carries its
  // prompt) keeps that; a card's first picture also writes it on the back.
  void stampMadeWith(groupId, boardId, media, firstPicture)
  // A 3D model shows on the card face by its poster (getFirstImageUrl):
  // render one now if it has none, and give it to the block once made.
  if (media.type === 'model' && !media.posterUrl) {
    void ensureModelPoster(media.url).then(posterUrl => {
      if (!posterUrl) return
      const st = useBoardsStore.getState()
      const bar = st.boards[boardId]?.bars[rootBar]
      const items = bar?.content.media ?? []
      if (!items.some(m => m.url === media.url && !m.posterUrl)) return
      st.setContent(boardId, rootBar, { media: items.map(m => m.url === media.url && !m.posterUrl ? { ...m, posterUrl } : m) })
    })
  }
  return boardId
}

/** An empty grid card, its frame's top-left at (cx, cy) less half its size
 *  (centred there), with one untouched block. The caller takes the undo
 *  checkpoint. */
function newGridCard(at: { cx: number; cy: number }, name: string): { groupId: string; boardId: string } {
  const size = cardFaceSize()
  const bs = useBoardsStore.getState()
  const boardId = bs.createBoard(0, 0)
  const groupId = bs.createGroup(name, [boardId])
  useBoardsStore.setState(st => ({
    groups: st.groups.map(gr => gr.id === groupId ? {
      ...gr, layout: 'grid' as const,
      cardWidthOverride: size.w, cardHeightOverride: size.h,
      // The frame's left is its first cell's left: the block's content
      // starts one board padding (20) right of the origin.
      originX: at.cx - size.w / 2 - 20, originY: at.cy - size.h / 2,
    } : gr),
  }))
  return { groupId, boardId }
}

/** A new grid card holding `items`, one block each, its frame's top-left
 *  at (cx, cy) less half its size (centred there). Named after the first
 *  item. The caller takes the undo checkpoint. Returns the group id. */
export function createMediaCard(at: { cx: number; cy: number }, items: { media: MediaItem; label?: string }[]): string | null {
  if (items.length === 0) return null
  const { groupId, boardId } = newGridCard(at, items[0].label || 'Card')
  items.forEach((it, i) => addMediaToGridCard(groupId, it.media, it.label, i === 0 ? boardId : null))
  return groupId
}

/** Text coming in (a dropped .txt/.md file, dragged text, "Add text") is a
 *  card like any other media: its words on the face, the title above the
 *  body. Edited there as any card's text is. The caller takes the undo
 *  checkpoint. Returns the group id. */
export function createTextCard(at: { cx: number; cy: number }, text: { title?: string; body?: string }): string {
  const title = (text.title ?? '').trim()
  const { groupId } = newGridCard(at, title || 'Text')
  const st = useBoardsStore.getState()
  st.setGroupCardHeaderText(groupId, title)
  st.setGroupCardText(groupId, text.body ?? '')
  // Most of the face for the words; the title keeps a line of its own.
  st.setGroupTextSplitRatio(groupId, title ? 0.18 : 0.12)
  return groupId
}

/** The sound on a card whose face has no picture, video or model to show:
 *  its first audio clip in reading order, which the face plays. */
export function cardFaceAudio(g: ProjectGroup, boards: Record<string, BoardData>): MediaItem | null {
  if (cardFaceMedia(g, boards)) return null
  for (const bid of gridOrder(g, boards)) {
    const b = boards[bid]
    for (const rid of b?.rootIds ?? []) {
      const m = getMediaItems(b.bars[rid]?.content).find(x => x.type === 'audio')
      if (m) return m
    }
  }
  return null
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
      if (boards[bid]) boards[bid] = { ...remembered(boards[bid], sources.find(g => g.boardIds.includes(bid))), nleRow: nextRow, nleX: i * 1e-3 + (isGridCard(target) ? 1e6 : 0) }
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

/** A block about to join another card, carrying what its card was. A block
 *  that already carries one keeps it: it goes home, not to the last stop. */
function remembered(b: BoardData, source: ProjectGroup | undefined): BoardData {
  if (b.fromCard || !source) return b
  const card: Partial<ProjectGroup> = { ...source }
  // Where it was, not what it is: it comes back wherever it is dropped.
  for (const k of ['boardIds', 'originX', 'originY', 'deckState', 'deckAnchorId', 'nestedDeck', 'deckOffsetX', 'deckOffsetY', 'deckFaceCard', 'ghostSlots', 'pin', 'home', 'pinnedLayer', 'railBase', 'deckLastFront', 'deckLock', 'deckKeep'] as const) delete card[k]
  const root = isSimpleBlock(b) ? b.bars[b.rootIds[0]] : undefined
  return {
    ...b,
    fromCard: {
      card: card as NonNullable<BoardData['fromCard']>['card'],
      boardScale: b.boardScale,
      root: root && { x: root.x, width: root.width, height: root.height },
    },
  }
}

/** Move one block to card `targetId`, remembering the card it leaves, and
 *  tidy both grids. The caller takes the undo checkpoint. */
export function moveBlockToCard(boardId: string, targetId: string, at: { x: number; y: number }): void {
  const s = useBoardsStore.getState()
  const source = s.groups.find(g => g.boardIds.includes(boardId))
  const b = s.boards[boardId]
  if (!b || source?.id === targetId) return
  useBoardsStore.setState(st => ({ boards: { ...st.boards, [boardId]: remembered(b, source) } }))
  useBoardsStore.getState().reassignBoard(boardId, targetId, at)
  layoutCardGrid(targetId)
  if (source) layoutCardGrid(source.id)
}

/** Pull a block out of its card into a card of its own, top-left at `at`
 *  (or where the block is). A block that was merged in comes back as the
 *  card it was, under its own id while that is free, so links to it hold;
 *  any other takes its name from what it holds and its card's kind. A
 *  card's only block is already its card. The caller takes the undo
 *  checkpoint. Returns the block's card. */
export function extractBlockToCard(boardId: string, at?: { x: number; y: number }): string | null {
  const s = useBoardsStore.getState()
  const b = s.boards[boardId]
  if (!b) return null
  const source = s.groups.find(g => g.boardIds.includes(boardId))
  if (source?.boardIds.length === 1) return source.id
  const pos = at ?? { x: (source?.originX ?? 0) + b.nleX, y: source?.originY ?? 0 }
  const was = b.fromCard
  const id = was && !s.groups.some(g => g.id === was.card.id) ? was.card.id : crypto.randomUUID()
  const media = b.rootIds.flatMap(rid => getMediaItems(b.bars[rid]?.content))
  const card: ProjectGroup = was
    ? { ...was.card, id, boardIds: [boardId], originX: pos.x, originY: pos.y, faceBoardId: was.card.faceBoardId === boardId ? boardId : undefined }
    : {
        id, boardIds: [boardId], originX: pos.x, originY: pos.y,
        name: b.layers?.block?.label || media.find(m => m.originalName)?.originalName || b.projectName || '',
        color: b.color ?? source?.color ?? '#5b8dd9',
        cardHeroImage: null, cardSummary: '', cardText: '', cardHeaderText: '',
        cardHeroTransform: { ...NEW_CARD_FACE },
        ...(isGridCard(source) ? { layout: 'grid' as const, cardWidthOverride: source!.cardWidthOverride, cardHeightOverride: source!.cardHeightOverride } : {}),
      }
  useBoardsStore.setState(st => {
    const { fromCard: _, ...rest } = st.boards[boardId]
    const next: BoardData = { ...rest, nleRow: 0, nleX: 0, canvasX: undefined, canvasY: undefined }
    if (was) {
      next.boardScale = was.boardScale
      const root = next.bars[next.rootIds[0]]
      if (was.root && root) next.bars = { ...next.bars, [root.id]: { ...root, ...was.root } }
    }
    return {
      boards: { ...st.boards, [boardId]: next },
      groups: [...st.groups.map(g => g.id === source?.id ? { ...g, boardIds: g.boardIds.filter(bid => bid !== boardId) } : g), card],
      selectedGroupIds: [id],
    }
  })
  layoutCardGrid(id)
  if (source) layoutCardGrid(source.id)
  return id
}
