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
import { mediaShots } from './filmPlan'
import { getMediaItems } from '../types/bar'
import { cardFaceSize, createMediaCard, gridOrder } from './cardGrid'
import { DOCK_TOLERANCE, rectsTouch, type Rect } from './viewportDocking'
import { cardScreenRect } from '../components/Layers/CardLayer'
import { cardTouchRect } from '../hooks/useCardDecks'
import { expandWithNestedMembers } from '../hooks/useCardDecks'

/** A card's shots, in its blocks' reading order. */
export function cardShots(g: ProjectGroup, boards: Record<string, BoardData>): string[] {
  const out: string[] = []
  for (const bid of gridOrder(g, boards)) {
    const b = boards[bid]
    for (const rid of b.rootIds) {
      for (const m of getMediaItems(b.bars[rid]?.content)) out.push(...mediaShots(m))
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
export function dockedCards(node: FreeNodeData, groups: ProjectGroup[], boards: Record<string, BoardData>, fixedReach = false): ProjectGroup[] {
  const rects = new Map<string, Rect>()
  const zoom = useCanvasStore.getState().zoom
  for (const g of groups) {
    if (g.pin) continue
    let r: Rect | null
    if (fixedReach) {
      const t = cardTouchRect(g, boards, zoom)
      r = t && { x: t.left, y: t.top, width: t.right - t.left, height: t.bottom - t.top }
    } else r = canvasRect(g, boards)
    if (r) rects.set(g.id, r)
  }
  // The card-back windows (utils/cardBacks) ask for the reach every other
  // dock uses, the same at every zoom (Brian 2026-11-07); Film Look keeps
  // its own, which grows as you zoom out.
  const tol = fixedReach ? DOCK_TOLERANCE : DOCK_TOLERANCE / Math.max(0.05, useCanvasStore.getState().zoom)
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
  return docked(node, groups, boards).shots
}

/** A picture or video on a docked card, as the mixer's deck player plays it:
 *  from its in point to its out point (seconds; a still is held). */
export interface DockedClip {
  key: string
  label: string
  kind: 'video' | 'image'
  url: string
  poster?: string
  in: number
  /** NaN for a video whose length is not known: it plays to its end. */
  out: number
}

/** How long a still holds in the deck player when nothing says otherwise. */
const STILL_HOLD = 2

/** Every picture and video on the docked cards, in the deck's reading order. */
function clipsOf(cards: ProjectGroup[], boards: Record<string, BoardData>): DockedClip[] {
  const out: DockedClip[] = []
  for (const g of cards) {
    for (const bid of gridOrder(g, boards)) {
      const b = boards[bid]
      for (const rid of b.rootIds) {
        const bar = b.bars[rid]
        getMediaItems(bar?.content).forEach((m, n) => {
          if (m.type !== 'video' && m.type !== 'image') return
          const label = bar?.name || g.name || 'Shot'
          const key = `${g.id}:${bid}:${n}`
          if (m.type === 'image') out.push({ key, label, kind: 'image', url: m.url, poster: m.url, in: 0, out: m.clipOut ?? STILL_HOLD })
          else out.push({ key, label, kind: 'video', url: m.url, poster: m.posterUrl, in: m.clipIn ?? 0, out: m.clipOut ?? m.duration ?? NaN })
        })
      }
    }
  }
  return out
}

/** The mixer's shots on what is docked to it, every clip on the docked cards
 *  (for the deck player, when there are no shots to mix), and how many cards
 *  and Rough Cuts are docked at all (so an empty mixer can say why). */
export function docked(node: FreeNodeData, groups: ProjectGroup[], boards: Record<string, BoardData>): { shots: string[]; things: number; clips: DockedClip[] } {
  const seen = new Set<string>()
  const out: string[] = []
  const cards = dockedCards(node, groups, boards)
  let things = cards.length
  for (const g of cards) {
    for (const s of cardShots(g, boards)) if (!seen.has(s)) { seen.add(s); out.push(s) }
  }
  // A Rough Cut touching the mixer feeds it its shots, in cut order.
  const tol = DOCK_TOLERANCE / Math.max(0.05, useCanvasStore.getState().zoom)
  const nodeRect = { x: node.x, y: node.y, width: node.width, height: node.height }
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    if (n.type !== 'roughCut' || n.pin || !rectsTouch(nodeRect, { x: n.x, y: n.y, width: n.width, height: n.height }, tol)) continue
    things++
    for (const s of roughCutShots(n)) if (!seen.has(s)) { seen.add(s); out.push(s) }
  }
  return { shots: out, things, clips: clipsOf(cards, boards) }
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
