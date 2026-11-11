// Cards laid out on the canvas, gathered into one scene card (Brian
// 2026-11-11: "I can arrange the cards themselves into the same pattern to
// form the shape of the scene card, but just with cards"). The new scene
// card has the shape they were laid out in: a section where each card
// lay, holding that card (its face copied in, a link back to it). A closed
// deck among them goes in whole; a closed deck on its own gathers as if it
// were open, a section for each of its cards. It lands right of them; the cards
// themselves are not moved or changed. Baking out (utils/sceneBake) is
// the way back.

import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { cardVisualRect } from '../hooks/useCardDecks'
import { createCardOrBoardAt } from './canvasCreate'
import { stackedDeckMembers } from './cardGrid'
import { newDetailId } from './cardTypes'
import { copyFrom } from './sceneContent'
import { markNew } from './newCards'
import type { SceneDiv } from './sceneCard'

type Rect = { left: number; right: number; top: number; bottom: number }
/** What goes in one section: a card, or a closed deck by its front. */
type Unit = { id: string; deck?: string[]; r: Rect }

const boundsOf = (us: { r: Rect }[]): Rect => ({
  left: Math.min(...us.map(u => u.r.left)), right: Math.max(...us.map(u => u.r.right)),
  top: Math.min(...us.map(u => u.r.top)), bottom: Math.max(...us.map(u => u.r.bottom)),
})

/** The cards of `ids` that lie on the canvas to be gathered: each card
 *  once, a closed deck as one (by its front), no effect cards. */
function unitsOf(ids: string[]): Unit[] {
  const bs = useBoardsStore.getState()
  const zoom = useCanvasStore.getState().zoom
  const out: Unit[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const g = bs.groups.find(x => x.id === id)
    if (!g || g.effect) continue
    // A card inside a closed deck stands for its deck.
    const front = g.deckState === 'stacked' && g.deckAnchorId && g.deckAnchorId !== g.id ? bs.groups.find(x => x.id === g.deckAnchorId) ?? g : g
    if (seen.has(front.id)) continue
    seen.add(front.id)
    const r = cardVisualRect(front, bs.boards, zoom)?.rect
    if (!r) continue
    const deck = stackedDeckMembers(front.id, bs.groups).filter(m => !bs.groups.find(x => x.id === m)?.effect)
    out.push({ id: front.id, deck: deck.length > 1 ? deck : undefined, r })
  }
  // A closed deck on its own (Brian 2026-11-11): as if it were open, each
  // of its cards where it would lie.
  if (out.length === 1 && out[0].deck) {
    const anchor = bs.groups.find(x => x.id === out[0].id)!
    return out[0].deck.flatMap(id => {
      const m = bs.groups.find(x => x.id === id)
      if (!m) return []
      const open = m.id === anchor.id ? m : { ...m, originX: anchor.originX + (m.deckOffsetX ?? 0), originY: anchor.originY + (m.deckOffsetY ?? 0) }
      const r = cardVisualRect(open, bs.boards, zoom)?.rect
      return r ? [{ id, r }] : []
    })
  }
  return out
}

/** How many cards of `ids` Gather would take (2 or more: it can). */
export const gatherCount = (ids: string[]): number => unitsOf(ids).length

/** The units cut into runs along one way: a new run starts where every
 *  card so far ends before the next begins (cards that touch, or lap by a
 *  sliver, still count as apart). */
function runs(us: Unit[], across: boolean, slack: number): Unit[][] {
  const lo = (u: Unit) => across ? u.r.left : u.r.top
  const hi = (u: Unit) => across ? u.r.right : u.r.bottom
  const sorted = [...us].sort((a, b) => lo(a) - lo(b))
  const out: Unit[][] = [[sorted[0]]]
  let end = hi(sorted[0])
  for (const u of sorted.slice(1)) {
    if (lo(u) >= end - slack) out.push([u])
    else out[out.length - 1].push(u)
    end = Math.max(end, hi(u))
  }
  return out
}

function leafOf(u: Unit, groups: ProjectGroup[]): SceneDiv {
  const card = groups.find(g => g.id === u.id)!
  const c = copyFrom(card)
  return { id: newDetailId(), color: card.color, ...c, name: c.name || card.name || '', card: u.id, ...(u.deck ? { deck: u.deck } : {}) }
}

/** The layout of these cards as a scene's divisions: cut into rows where a
 *  clear line runs across, else into columns, and so on inside each; each
 *  part as big as the room its cards took. */
function layoutOf(us: Unit[], groups: ProjectGroup[], slack: number): SceneDiv {
  if (us.length === 1) return leafOf(us[0], groups)
  const rows = runs(us, false, slack), cols = runs(us, true, slack)
  const split = (parts: Unit[][], dir: 'row' | 'col'): SceneDiv => {
    const ext = parts.map(p => { const b = boundsOf(p); return Math.max(1, dir === 'row' ? b.right - b.left : b.bottom - b.top) })
    const total = ext.reduce((a, b) => a + b, 0)
    return { id: newDetailId(), dir, sizes: ext.map(e => e / total), kids: parts.map(p => layoutOf(p, groups, slack)) }
  }
  if (rows.length > 1) return split(rows, 'col')
  if (cols.length > 1) return split(cols, 'row')
  // No clear line either way (cards over one another): side by side, in
  // reading order.
  const order = [...us].sort((a, b) => (a.r.top + a.r.bottom) - (b.r.top + b.r.bottom) || a.r.left - b.r.left)
  return { id: newDetailId(), dir: 'row', sizes: order.map(() => 1 / order.length), kids: order.map(u => leafOf(u, groups)) }
}

/** Gather cards `ids` into a new scene card right of them, in the shape
 *  they lie in. Returns it (null: fewer than two to gather). One undo. */
export function gatherIntoScene(ids: string[]): string | null {
  const us = unitsOf(ids)
  if (us.length < 2) return null
  const zoom = useCanvasStore.getState().zoom
  const all = boundsOf(us)
  const w = all.right - all.left, h = all.bottom - all.top
  const slack = Math.min(...us.map(u => Math.min(u.r.right - u.r.left, u.r.bottom - u.r.top))) * 0.12
  const scene = layoutOf(us, useBoardsStore.getState().groups, slack)
  useUndoCoordinator.getState().checkpoint()
  const boardId = createCardOrBoardAt({ cx: all.right + w, cy: (all.top + all.bottom) / 2 }, { noCheckpoint: true })
  let bs = useBoardsStore.getState()
  const made = bs.groups.find(g => g.boardIds.includes(boardId))
  if (!made) return null
  bs.setCardsType([made.id], 'scene')
  bs.setGroupScene(made.id, scene)
  // The size the cards took together (its header is its own, on top).
  const head = (cardVisualRect(made, bs.boards, zoom)?.contentTop ?? 0) - (cardVisualRect(made, bs.boards, zoom)?.rect.top ?? 0)
  bs.setGroupCardSize(made.id, w, Math.max(1, h - head))
  // Right of them, tops level, clear of whatever lies there.
  bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.id === made.id)!
  const r = cardVisualRect(g, bs.boards, zoom)?.rect
  if (r) {
    const others = bs.groups.filter(o => o.id !== g.id && !(o.deckState === 'stacked' && o.deckAnchorId && o.deckAnchorId !== o.id))
      .map(o => cardVisualRect(o, bs.boards, zoom)?.rect).filter(Boolean) as Rect[]
    const gap = Math.min(w * 0.2, (r.right - r.left) * 0.2)
    let left = all.right + gap
    for (let n = 0; n < 40; n++) {
      const hit = others.find(o => o.left < left + (r.right - r.left) + gap * 0.5 && o.right > left - gap * 0.5 && o.top < all.top + (r.bottom - r.top) && o.bottom > all.top)
      if (!hit) break
      left = hit.right + gap
    }
    bs.setGroupPos(g.id, g.originY + (all.top - r.top), g.originX + (left - r.left))
  }
  markNew([made.id])
  useBoardsStore.getState().setSelectedGroup(made.id)
  return made.id
}
