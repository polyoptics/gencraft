// A scene card cut in two, and two scene cards made one (Brian 2026-11-16):
// "one scene card that has nine cells on it ... I actually want to take the
// first three, the middle three, and the last three ... each on separate
// cards", "a horizontal or vertical strip that cuts all the way through ...
// split into a new card and have it break off to the side or underneath";
// and back: "magnet the scene cards together and then click on one of those
// seams and say Join cards".
//
//  - SPLIT, at a line that runs straight through the whole face: what is
//    past the line (right of it, or under it) breaks off into a new scene
//    card set against the first. Every section keeps its contents, its
//    size and its look. A heading the line runs through (the title strip
//    over a column that is cut) is on both cards.
//  - JOIN, of two scene cards lying against one another: the left (or top)
//    one keeps its name, colour and links and takes the other's sections in
//    beside (or under) its own, at the size they were; the other card goes.
//    A split and then a join puts the card back as it was.
//
// One undo each.

import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { cardVisualRect } from '../hooks/useCardDecks'
import { createCardOrBoardAt } from './canvasCreate'
import { newDetailId } from './cardTypes'
import { markNew } from './newCards'
import { FOLD_STRIP, canFold, divBoxes, isLeaf, shareUnits, type SceneDiv } from './sceneCard'
import { faceLayout, holdFit, GAP, PAD } from './sceneGrow'

type Box = { x: number; y: number; w: number; h: number }
type Boxes = Map<string, Box>
type Face = { width: number; height: number }

const EPS = 0.01
const normal = (s: number[]) => { const t = s.reduce((a, b) => a + b, 0) || 1; return s.map(x => x / t) }
const sizesOf = (d: SceneDiv) => d.sizes ?? d.kids!.map(() => 1 / d.kids!.length)
const foldedNow = (d: SceneDiv) => !!d.fold && canFold(d)

/** Where the line between parts i and i+1 of a split lies on the face:
 *  `vertical` (it runs top to bottom, at x = pos) or not (at y = pos). */
export function seamLine(split: SceneDiv, i: number, boxes: Boxes): { vertical: boolean; pos: number } | null {
  const b = boxes.get(split.kids?.[i]?.id ?? '')
  if (!b) return null
  const vertical = split.dir === 'row'
  return { vertical, pos: (vertical ? b.x + b.w : b.y + b.h) + GAP / 2 }
}

/** The face cut along a straight line: what lies before it and what lies
 *  past it. Null when the line does not run through the whole face between
 *  sections (it would cut a section in two), or leaves a side empty.
 *  `boxes`: every part's box as laid out now (divBoxes). */
export function cutScene(root: SceneDiv, vertical: boolean, pos: number, boxes: Boxes): { a: SceneDiv; b: SceneDiv } | null {
  type Cut = { a: SceneDiv | null; b: SceneDiv | null }
  const walk = (d: SceneDiv, head: boolean): Cut | null => {
    const bx = boxes.get(d.id)
    if (!bx) return null
    const lo = vertical ? bx.x : bx.y, hi = lo + (vertical ? bx.w : bx.h)
    if (hi <= pos + EPS) return { a: d, b: null }
    if (lo >= pos - EPS) return { a: null, b: d }
    // The line runs through it. A heading is on both sides (its cast too).
    if (isLeaf(d)) return head ? { a: d, b: { ...d, id: newDetailId(), opens: undefined } } : null
    if (foldedNow(d)) return null
    const sizes = sizesOf(d)
    if ((d.dir === 'row') === vertical) {
      // Its parts lie one after another across the line: those before it,
      // those past it, each keeping the length it has now.
      const unit = shareUnits(d, bx, GAP)
      const A: SceneDiv[] = [], B: SceneDiv[] = [], la: number[] = [], lb: number[] = []
      for (let i = 0; i < d.kids!.length; i++) {
        const k = d.kids![i]
        const c = walk(k, false)
        if (!c) return null
        const kb = boxes.get(k.id)!
        const klo = vertical ? kb.x : kb.y, khi = klo + (vertical ? kb.w : kb.h)
        const own = sizes[i] * unit
        if (c.a && c.b) { A.push(c.a); la.push(pos - GAP / 2 - klo); B.push(c.b); lb.push(khi - pos - GAP / 2) }
        else if (c.a) { A.push(c.a); la.push(own) }
        else if (c.b) { B.push(c.b); lb.push(own) }
      }
      const mk = (ks: SceneDiv[], lens: number[], id: string): SceneDiv | null =>
        ks.length === 0 ? null : ks.length === 1 ? ks[0] : { ...d, id, kids: ks, sizes: normal(lens) }
      return { a: mk(A, la, d.id), b: mk(B, lb, newDetailId()) }
    }
    // Its parts are stacked along the line: every one is cut at the same place.
    const A: SceneDiv[] = [], B: SceneDiv[] = []
    for (let i = 0; i < d.kids!.length; i++) {
      const c = walk(d.kids![i], i === 0 && canFold(d))
      if (!c || !c.a || !c.b) return null
      A.push(c.a); B.push(c.b)
    }
    return { a: { ...d, kids: A }, b: { ...d, id: newDetailId(), kids: B } }
  }
  const c = walk(root, false)
  return c && c.a && c.b ? { a: c.a, b: c.b } : null
}

const groupOf = (id: string) => useBoardsStore.getState().groups.find(g => g.id === id)

/** A card's face on screen (what SceneFace is given): its size, px. */
function faceOf(g: ProjectGroup, zoom: number): Face | null {
  const v = cardVisualRect(g, useBoardsStore.getState().boards, zoom)
  return v ? { width: (v.rect.right - v.rect.left) * zoom, height: (v.rect.bottom - v.contentTop) * zoom } : null
}

/** Card `id`'s face made `face` px, its layout scale held at `fit`. An
 *  empty card's own block is brought in under that size, so the card can
 *  be as small as its face (a card is never smaller than what is in it). */
function sizeCard(id: string, face: Face, fit: number, zoom: number): void {
  const bs = useBoardsStore.getState()
  const g = groupOf(id)
  if (!g) return
  const w = face.width / zoom, h = face.height / zoom
  const board = g.boardIds.length === 1 ? bs.boards[g.boardIds[0]] : undefined
  if (board && board.rootIds.length === 1 && Object.keys(board.bars).length === 1) {
    const bar = board.bars[board.rootIds[0]], sc = board.boardScale ?? 1
    if (bar && bar.width * sc + 32 > w) bs.resizeBarEdge(board.id, bar.id, 'right', Math.max(40, (w - 32) / sc) - bar.width)
    if (bar && bar.height * sc > h) bs.setBarHeight(board.id, bar.id, h / sc)
  }
  bs.setGroupSceneView(id, { ...(g.sceneView ?? {}), fitK: holdFit(fit, face.width, face.height, zoom) })
  bs.setGroupCardSize(id, w, h)
}

/** The gap cards keep between them (nlePush DEFAULT_GAP). */
const CARD_GAP = 12
/** How near two scene cards lie to be joined (canvas units), and how much
 *  of the shorter one's side must face the other. */
const JOIN_REACH = 22, JOIN_FACING = 0.5

/** Scene card `sceneId` cut along a line of its face (seamLine): what is
 *  past the line becomes a new scene card set against it, on its right
 *  (a vertical line) or under it. `face`: its face's size on screen now.
 *  Returns the new card (null: no cut there). */
export function splitSceneCard(sceneId: string, vertical: boolean, pos: number, face: Face): string | null {
  const g = groupOf(sceneId)
  const zoom = useCanvasStore.getState().zoom
  if (!g?.scene) return null
  const L = faceLayout(face.width, face.height, zoom, g.sceneView?.fitK)
  const c = cutScene(g.scene, vertical, pos, divBoxes(g.scene, L.iw, L.ih, GAP))
  const r0 = cardVisualRect(g, useBoardsStore.getState().boards, zoom)?.rect
  if (!c || !r0) return null
  const aPx = (pos - GAP / 2 + PAD * 2) * L.s
  const bPx = ((vertical ? L.iw : L.ih) - pos - GAP / 2 + PAD * 2) * L.s
  const part = (px: number): Face => (vertical ? { width: px, height: face.height } : { width: face.width, height: px })
  useUndoCoordinator.getState().checkpoint()
  const boardId = createCardOrBoardAt({ cx: r0.right, cy: r0.bottom }, { noCheckpoint: true })
  let bs = useBoardsStore.getState()
  const made = bs.groups.find(x => x.boardIds.includes(boardId))
  if (!made) return null
  bs.renameGroup(made.id, g.name)
  bs.setGroupColor(made.id, g.color)
  bs.setCardsType([made.id], 'scene')
  bs.setGroupScene(made.id, c.b)
  bs.setGroupScene(sceneId, c.a)
  sizeCard(sceneId, part(aPx), L.fit, zoom)
  sizeCard(made.id, part(bPx), L.fit, zoom)
  // Against the first: on its right, tops level; or under it, left sides level.
  bs = useBoardsStore.getState()
  const a = groupOf(sceneId), b = groupOf(made.id)
  const ra = a && cardVisualRect(a, bs.boards, zoom)?.rect, rb = b && cardVisualRect(b, bs.boards, zoom)?.rect
  if (b && ra && rb) {
    const dx = vertical ? ra.right + CARD_GAP - rb.left : ra.left - rb.left
    const dy = vertical ? ra.top - rb.top : ra.bottom + CARD_GAP - rb.top
    bs.setGroupPos(b.id, b.originY + dy, b.originX + dx)
  }
  markNew([made.id])
  return made.id
}

/** The scene card lying against scene card `sceneId` on that side, near
 *  enough to join (the nearest, if several). */
export function joinNeighbour(sceneId: string, side: 'top' | 'bottom' | 'left' | 'right'): string | null {
  const bs = useBoardsStore.getState()
  const zoom = useCanvasStore.getState().zoom
  const me = groupOf(sceneId)
  const r = me && cardVisualRect(me, bs.boards, zoom)?.rect
  if (!me || !r) return null
  const across = side === 'left' || side === 'right'
  let best: string | null = null, bestGap = Infinity
  for (const g of bs.groups) {
    if (g.id === sceneId || !g.scene || g.cardType !== 'scene' || g.flipped || g.linkOf) continue
    if (g.deckState === 'stacked' && g.deckAnchorId && g.deckAnchorId !== g.id) continue
    const o = cardVisualRect(g, bs.boards, zoom)?.rect
    if (!o) continue
    const gap = side === 'right' ? o.left - r.right : side === 'left' ? r.left - o.right : side === 'bottom' ? o.top - r.bottom : r.top - o.bottom
    if (gap < -2 || gap > JOIN_REACH) continue
    const facing = across
      ? Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top)
      : Math.min(r.right, o.right) - Math.max(r.left, o.left)
    const least = across ? Math.min(r.bottom - r.top, o.bottom - o.top) : Math.min(r.right - r.left, o.right - o.left)
    if (facing < least * JOIN_FACING) continue
    if (gap < bestGap) { best = g.id; bestGap = gap }
  }
  return best
}

/** Scene cards `aId` and `bId` made one: b's sections go in on a's right
 *  ('row') or under it ('col'), at the size they have now; a keeps its
 *  name, colour and links (b's links become a's too) and b goes. */
export function joinSceneCards(aId: string, bId: string, dir: 'row' | 'col'): boolean {
  const a = groupOf(aId), b = groupOf(bId)
  const zoom = useCanvasStore.getState().zoom
  if (!a?.scene || !b?.scene || aId === bId) return false
  const fa = faceOf(a, zoom), fb = faceOf(b, zoom)
  if (!fa || !fb) return false
  const LA = faceLayout(fa.width, fa.height, zoom, a.sceneView?.fitK)
  const LB = faceLayout(fb.width, fb.height, zoom, b.sceneView?.fitK)
  const row = dir === 'row'
  // The parts along the join, each with the length it has now (in a's
  // layout units). A face already laid that way gives its parts one by
  // one, so a card cut and joined again is as it was; b's own heading
  // keeps its section to itself.
  const parts = (root: SceneDiv, L: typeof LA, flat: boolean): { d: SceneDiv; len: number }[] => {
    const k = L.s / LA.s
    if (!flat) return [{ d: root, len: (row ? L.iw : L.ih) * k }]
    const unit = shareUnits(root, { w: L.iw, h: L.ih }, GAP)
    const sizes = sizesOf(root)
    return root.kids!.map((d, i) => ({ d, len: sizes[i] * unit * k }))
  }
  const lays = (root: SceneDiv) => !isLeaf(root) && root.dir === dir && !root.fold
  const flatA = lays(a.scene), flatB = lays(b.scene) && (row || !canFold(b.scene))
  const all = [...parts(a.scene, LA, flatA), ...parts(b.scene, LB, flatB)]
  const root: SceneDiv = { ...(flatA ? a.scene : {}), id: flatA ? a.scene.id : newDetailId(), dir, kids: all.map(p => p.d), sizes: normal(all.map(p => p.len)) }
  const along = all.reduce((t, p) => t + (foldedNow(p.d) ? FOLD_STRIP : p.len), 0) + GAP * (all.length - 1)
  const alongPx = (along + PAD * 2) * LA.s
  const face: Face = row
    ? { width: alongPx, height: Math.max(fa.height, fb.height) }
    : { width: Math.max(fa.width, fb.width), height: alongPx }
  useUndoCoordinator.getState().checkpoint()
  let bs = useBoardsStore.getState()
  bs.setGroupScene(aId, root)
  sizeCard(aId, face, LA.fit, zoom)
  // b's links are a's now, and what was linked to b is linked to a.
  for (const id of b.linkedGroupIds ?? []) if (id !== aId) bs.linkGroups(aId, id)
  for (const g of bs.groups) {
    if (g.id === aId || g.id === bId || !(g.linkedGroupIds ?? []).includes(bId)) continue
    bs.unlinkGroups(g.id, bId)
    bs.linkGroups(g.id, aId)
  }
  bs.unlinkGroups(aId, bId)
  // b goes. Blocks it holds (anything past its own empty one) go to a.
  bs = useBoardsStore.getState()
  const empty = (bid: string) => { const bd = bs.boards[bid]; return !bd || Object.keys(bd.bars).length <= bd.rootIds.length }
  b.boardIds.filter(empty).forEach(bid => useBoardsStore.getState().deleteBoard(bid))
  const left = groupOf(bId)
  if (left) {
    if (left.boardIds.length) useBoardsStore.setState(s => ({ groups: s.groups.map(g => g.id === aId ? { ...g, boardIds: [...g.boardIds, ...left.boardIds] } : g.id === bId ? { ...g, boardIds: [] } : g) }))
    useBoardsStore.setState(s => ({ groups: s.groups.filter(g => g.id !== bId) }))
  }
  return true
}
