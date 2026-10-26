// mediaSources.ts — which FILES a card, deck, block or bar hands over.
//
// Two answers per container, both STORED urls of the media itself (a video
// or model's file, never its poster — see getFirstMediaSource):
//
//   …FaceSource   the one picture you SEE: what dragging it out gives, and
//                 what its right-click file menu names.
//   …ImageSources every IMAGE inside it, in reading order, de-duplicated —
//                 the Shift-drag "give me everything" set. Images only: a
//                 website's upload box rejects a whole drop over one .glb.
//
// The face walks must match what the layers DRAW (the hero loops in
// CardLayer, BlockItem's thumbnail): first bar with a picture wins.

import { getFirstImageUrl, getFirstMediaSource, getMediaItems, type Bar } from '../types/bar'
import type { BoardData, ProjectGroup } from '../store/boardsStore'

type Boards = Record<string, BoardData>

/** For overrides (a card's hero, a block's thumbnail), which carry a url but
 *  no type: does it name an image? Refs that cannot be told (mediaref:,
 *  data:) pass — they have no file on disk, so they never reach a drag. */
function looksLikeImage(u: string): boolean {
  if (!u.startsWith('/')) return true
  let p = u
  try { p = decodeURIComponent(u) } catch { /* keep raw */ }
  return /\.(png|jpe?g|jfif|webp|gif|avif|bmp|svg|ico|tiff?|heic|jxl)$/i.test(p.split(/[?#]/)[0]) ||
    /\.(png|jpe?g|jfif|webp|gif|avif|bmp|svg|ico|tiff?|heic|jxl)$/i.test(p)
}

/** A card's face: its hero override, else the first bar with a picture
 *  (boardIds → rootIds), read for its SOURCE. */
export function groupFaceSource(g: ProjectGroup, boards: Boards): string | null {
  if (g.cardHeroImage) return g.cardHeroImage
  for (const bid of g.boardIds) {
    const board = boards[bid]
    if (!board) continue
    for (const rid of board.rootIds) {
      const content = board.bars[rid]?.content
      if (getFirstImageUrl(content)) return getFirstMediaSource(content)
    }
  }
  return null
}

/** A block's face: its thumbnail override if set, else the first root bar
 *  with a picture. Mirrors BlockItem's `thumbnail`; keep the two in step. */
export function boardFaceSource(board: BoardData | undefined): string | null {
  if (!board) return null
  const override = board.layers?.block?.thumbnail
  if (override != null) return override
  const bar = board.rootIds.map(id => board.bars[id]).find(b => b && getFirstImageUrl(b.content))
  return bar ? getFirstMediaSource(bar.content) : null
}

/** Every image in a bar and its sub-bars, depth first. */
export function barImageSources(board: BoardData, barId: string, out: string[] = []): string[] {
  const bar: Bar | undefined = board.bars[barId]
  if (!bar) return out
  for (const m of getMediaItems(bar.content)) {
    if (m.type === 'image' && !out.includes(m.url)) out.push(m.url)
  }
  for (const child of bar.children) barImageSources(board, child, out)
  return out
}

/** Every image in a block: its thumbnail override (when it is an image
 *  file of its own), then its bars in tree order. */
export function boardImageSources(board: BoardData | undefined, out: string[] = []): string[] {
  if (!board) return out
  const thumb = board.layers?.block?.thumbnail
  if (thumb && looksLikeImage(thumb) && !out.includes(thumb)) out.push(thumb)
  for (const rid of board.rootIds) barImageSources(board, rid, out)
  return out
}

/** Every image in a card: its hero override, then each block in order. */
export function groupImageSources(g: ProjectGroup, boards: Boards, out: string[] = []): string[] {
  if (g.cardHeroImage && looksLikeImage(g.cardHeroImage) && !out.includes(g.cardHeroImage)) out.push(g.cardHeroImage)
  for (const bid of g.boardIds) boardImageSources(boards[bid], out)
  return out
}

/** What a card's or block's drag-out grip leads with: its face when that
 *  can be a file on disk, else the first such image inside it. A face
 *  pasted in before files were referenced in place lives in the app's own
 *  store, not on disk, and must not hide the files the container DOES
 *  hold. `isFile` is useFileMenu's mayHaveDiskFile. */
export function gripSource(
  face: string | null,
  inside: () => string[],
  isFile: (u: string | null) => boolean,
): string | null {
  if (isFile(face)) return face
  return inside().find(isFile) ?? null
}

/** One face per card of a deck, in the order given (front card first). */
export function deckFaceSources(members: ProjectGroup[], boards: Boards): string[] {
  const out: string[] = []
  for (const g of members) {
    const face = groupFaceSource(g, boards)
    if (face && !out.includes(face)) out.push(face)
  }
  return out
}

/** Every image in every card of a deck. */
export function deckImageSources(members: ProjectGroup[], boards: Boards): string[] {
  const out: string[] = []
  for (const g of members) groupImageSources(g, boards, out)
  return out
}
