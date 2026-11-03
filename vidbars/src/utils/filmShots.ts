// filmShots.ts — shot cards for the Film Look mixer.
//
// A shot card is an ordinary grid card whose picture carries `filmShot`, the
// mixer's name for that shot. The mixer on the canvas mixes the shots on the
// cards touching it, deck and all, in reading order: dock a deck beside it,
// or lay a card over its title bar. Nothing about that is stored; it is worked
// out from where the cards are, like any deck.

import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { roughCutShots } from './roughCut'
import { getMediaItems } from '../types/bar'
import { cardFaceSize, createMediaCard, gridOrder } from './cardGrid'
import { DOCK_TOLERANCE, rectsTouch, type Rect } from './viewportDocking'
import { cardScreenRect } from '../components/Layers/CardLayer'
import { expandWithNestedMembers } from '../hooks/useCardDecks'

/** A card's shots, in its blocks' reading order. */
export function cardShots(g: ProjectGroup, boards: Record<string, BoardData>): string[] {
  const out: string[] = []
  for (const bid of gridOrder(g, boards)) {
    const b = boards[bid]
    for (const rid of b.rootIds) {
      for (const m of getMediaItems(b.bars[rid]?.content)) if (m.filmShot) out.push(m.filmShot)
    }
  }
  return out
}

function canvasRect(g: ProjectGroup, boards: Record<string, BoardData>): Rect | null {
  const r = cardScreenRect(g, boards, { x: 0, y: 0 }, 1)
  return r ? { x: r.screenLeft, y: r.screenTop, width: r.screenWidth, height: r.screenHeight } : null
}

/** The cards touching the mixer, and the cards touching those (a deck),
 *  with any stacked deck's hidden members, in reading order: top row first,
 *  left to right. */
export function dockedCards(node: FreeNodeData, groups: ProjectGroup[], boards: Record<string, BoardData>): ProjectGroup[] {
  const rects = new Map<string, Rect>()
  for (const g of groups) {
    if (g.pin) continue
    const r = canvasRect(g, boards)
    if (r) rects.set(g.id, r)
  }
  const tol = DOCK_TOLERANCE / Math.max(0.05, useCanvasStore.getState().zoom)
  const nodeRect = { x: node.x, y: node.y, width: node.width, height: node.height }
  const found = new Set<string>()
  const queue: string[] = []
  for (const [id, r] of rects) if (rectsTouch(r, nodeRect, tol)) { found.add(id); queue.push(id) }
  while (queue.length) {
    const a = rects.get(queue.shift()!)!
    for (const [id, r] of rects) {
      if (!found.has(id) && rectsTouch(a, r, tol)) { found.add(id); queue.push(id) }
    }
  }
  const ids = expandWithNestedMembers([...found], groups)
  const byId = new Map(groups.map(g => [g.id, g]))
  const rowH = cardFaceSize(1).h / 2
  return ids.map(id => byId.get(id)!).filter(Boolean).sort((a, b) =>
    (Math.round(a.originY / rowH) - Math.round(b.originY / rowH)) || (a.originX - b.originX))
}

/** The shots the mixer should mix: every shot on its docked cards, once. */
export function dockedShots(node: FreeNodeData, groups: ProjectGroup[], boards: Record<string, BoardData>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const g of dockedCards(node, groups, boards)) {
    for (const s of cardShots(g, boards)) if (!seen.has(s)) { seen.add(s); out.push(s) }
  }
  // A Rough Cut touching the mixer feeds it its shots, in cut order.
  const tol = DOCK_TOLERANCE / Math.max(0.05, useCanvasStore.getState().zoom)
  const nodeRect = { x: node.x, y: node.y, width: node.width, height: node.height }
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    if (n.type !== 'roughCut' || n.pin || !rectsTouch(nodeRect, { x: n.x, y: n.y, width: n.width, height: n.height }, tol)) continue
    for (const s of roughCutShots(n)) if (!seen.has(s)) { seen.add(s); out.push(s) }
  }
  return out
}

/** Every shot the mixer can mix, as a deck of cards below the mixer: one card
 *  per shot, touching in rows, so they are one deck and nothing is docked yet.
 *  Resolves the number made, or an error. */
export async function makeShotCards(node: FreeNodeData): Promise<{ made: number } | { error: string }> {
  const d = window.vidbarsDesktop
  if (!d?.mixerCall || !d.mixerThumb) return { error: 'Close VidBars and open it again once, so it can make shot cards.' }
  const shots = await d.mixerCall('shots')
  if (!Array.isArray(shots) || !shots.length) return { error: 'The mixer has no shots to make cards of yet.' }
  // A few at a time: the mixer serves its page and the playback meanwhile.
  const thumbs: (string | null)[] = []
  for (let n = 0; n < shots.length; n += 4) {
    thumbs.push(...await Promise.all(shots.slice(n, n + 4).map(s => d.mixerThumb!(s.k))))
  }
  const size = cardFaceSize()
  const perRow = 8
  // A card's spot is its centre. Below the mixer, clear of its edge by half a
  // card, so the deck is not docked the moment it is made.
  const x0 = node.x + size.w / 2, y0 = node.y + node.height + size.h
  useUndoCoordinator.getState().checkpoint()
  let made = 0
  shots.forEach((s, n) => {
    const url = thumbs[n]
    if (!url) return
    const cx = x0 + (n % perRow) * size.w, cy = y0 + Math.floor(n / perRow) * size.h
    if (createMediaCard({ cx, cy }, [{ media: { url, type: 'image', originalName: s.clip, filmShot: s.clip }, label: s.clip }])) made++
  })
  useBoardsStore.getState().setSelectedGroups([])
  return { made }
}
