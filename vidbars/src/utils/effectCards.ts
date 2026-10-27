// effectCards.ts — effects as real cards.
//
// An effect card is a card (ProjectGroup) carrying an `effect`: its face is
// the effect's sliders (EffectTileBody), and lined up to the RIGHT of a
// picture card it processes that card's face (utils/fx/cardStrips reads
// the row left to right, blends included). Being a card, it does all a
// card does: lined up flush, effect cards and the picture card touch, so
// they are one deck — it stacks and fans with it, and can be a sub-deck or
// a fan of its own.
//
// What makes a row a row:
// - Lined up against a card's right edge an effect card snaps flush, and
//   slides along that edge like a bead on a rail, clicking to the top,
//   centre or bottom (stripSnap's edgeRailY, the rule effect tiles use).
// - The effect cards lined up to the right of a card are its chain
//   (effectChain): dragging the card brings them along, and so does
//   dragging an effect card bring the ones after it.
//
// Boxes are measured as drawn at the current zoom (cardScreenRect ÷ zoom):
// a card's title band is a screen-sized band, so measured at zoom 1 the
// cards would not line up with what shows.

import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { cardScreenRect } from '../components/Layers/CardLayer'
import { getHiddenGroupIds } from '../hooks/useCardDecks'
import { EFFECTS, knownKind, type EffectKind } from './fx/effects'
import { edgeRailY } from './fx/stripSnap'
import { magnetRadiusForZoom, type Rect } from './viewportDocking'
import { cardFaceSize } from './cardGrid'
import { viewportCenterInCanvas } from './canvasCreate'

export const isEffectCard = (g: ProjectGroup | undefined): boolean => !!g?.effect

/** A card's box as it is drawn at `zoom`, in canvas units. */
export function drawnRect(g: ProjectGroup, boards: Record<string, BoardData>, zoom: number): Rect | null {
  if (zoom <= 0) return null
  const r = cardScreenRect(g, boards, { x: 0, y: 0 }, zoom)
  if (!r || r.screenWidth <= 0) return null
  return { x: r.screenLeft / zoom, y: r.screenTop / zoom, width: r.screenWidth / zoom, height: r.screenHeight / zoom }
}

/** Move cards by a canvas delta, in one store write. */
function moveCards(ids: string[], dx: number, dy: number): void {
  if (ids.length === 0 || (dx === 0 && dy === 0)) return
  const set = new Set(ids)
  useBoardsStore.setState(st => ({
    groups: st.groups.map(g => set.has(g.id) ? { ...g, originX: g.originX + dx, originY: g.originY + dy } : g),
  }))
}

/** The effect cards lined up to the right of card `gid`, in order: each
 *  flush against the one before (within a hair on screen), overlapping it
 *  in height. A card that is not an effect card ends the chain. */
export function effectChain(
  gid: string,
  groups: ProjectGroup[] = useBoardsStore.getState().groups,
  boards: Record<string, BoardData> = useBoardsStore.getState().boards,
  zoom: number = useCanvasStore.getState().zoom,
): string[] {
  const hidden = getHiddenGroupIds(groups)
  const rects = new Map<string, Rect>()
  for (const g of groups) {
    if (g.pin || hidden.has(g.id)) continue
    const r = drawnRect(g, boards, zoom)
    if (r) rects.set(g.id, r)
  }
  const tol = 3 / zoom
  const out: string[] = []
  const seen = new Set([gid])
  let cur = rects.get(gid)
  while (cur) {
    const c = cur
    const next = groups.find(g => {
      const r = g.effect && !seen.has(g.id) ? rects.get(g.id) : undefined
      return !!r && Math.abs(r.x - (c.x + c.width)) <= tol && r.y < c.y + c.height && r.y + r.height > c.y
    })
    if (!next) break
    out.push(next.id)
    seen.add(next.id)
    cur = rects.get(next.id)
  }
  return out
}

/** Let go of effect card `gid`: lined up against a card's right edge (near
 *  enough to snap), it goes flush there, at the height edgeRailY gives —
 *  the top for a first snap, or where it was let go, clicking to top,
 *  centre or bottom, if it was already on that edge (`start`: its box when
 *  the drag began). `carry` (the cards after it) move with it. Cards in
 *  `skip` are never targets (what is being dragged). The caller's drag
 *  holds the undo checkpoint. True when it snapped. */
export function snapEffectCard(gid: string, start: Rect | null, carry: string[] = [], skip: Set<string> = new Set()): boolean {
  const { groups, boards } = useBoardsStore.getState()
  const zoom = useCanvasStore.getState().zoom
  const me = groups.find(g => g.id === gid)
  const r = me ? drawnRect(me, boards, zoom) : null
  if (!me || !r || me.pin) return false
  const reach = magnetRadiusForZoom(zoom) * 1.5
  const hidden = getHiddenGroupIds(groups)
  let best: { c: Rect; d: number } | null = null
  for (const o of groups) {
    if (o.id === gid || skip.has(o.id) || carry.includes(o.id) || o.pin || hidden.has(o.id)) continue
    const c = drawnRect(o, boards, zoom)
    if (!c || !(r.y < c.y + c.height && r.y + r.height > c.y)) continue
    const d = Math.abs(r.x - (c.x + c.width))
    if (d <= reach && (!best || d < best.d)) best = { c, d }
  }
  if (!best) return false
  const c = best.c
  const tol = 3 / zoom
  const onEdge = !!start && Math.abs(start.x - (c.x + c.width)) <= tol && start.y < c.y + c.height && start.y + start.height > c.y
  const y = edgeRailY(c, r.y, r.height, onEdge, reach)
  moveCards([gid, ...carry], c.x + c.width - r.x, y - r.y)
  return true
}

/** A new effect card of `kind`. With `after` (a card), it goes flush at the
 *  right end of that card's chain, top-aligned to the last card in it; with
 *  `at` (canvas units, its centre), there — snapped onto a card's edge when
 *  that close; otherwise centred in view. Card-face sized, like a picture
 *  card made at this zoom. Selected, so the next one goes after it. The
 *  caller takes the undo checkpoint. Returns the group id. */
export function createEffectCardGroup(kind: EffectKind, opts: { at?: { cx: number; cy: number }; after?: string | null } = {}): string {
  const k = knownKind(kind)
  const def = EFFECTS[k]
  const size = cardFaceSize()
  const bs = useBoardsStore.getState()
  const boardId = bs.createBoard(0, 0)
  const gid = bs.createGroup(def.label, [boardId])
  useBoardsStore.setState(st => ({
    groups: st.groups.map(g => g.id === gid ? {
      ...g, effect: { kind: k, params: {} }, color: def.color,
      cardWidthOverride: size.w, cardHeightOverride: size.h,
    } : g),
  }))
  const zoom = useCanvasStore.getState().zoom
  const place = (x: number, y: number) => {
    const s = useBoardsStore.getState()
    const g = s.groups.find(gr => gr.id === gid)
    const r = g ? drawnRect(g, s.boards, zoom) : null
    if (r) moveCards([gid], x - r.x, y - r.y)
  }
  const s = useBoardsStore.getState()
  const anchor = opts.after ? s.groups.find(g => g.id === opts.after) : undefined
  if (anchor) {
    const chain = effectChain(anchor.id)
    const last = s.groups.find(g => g.id === (chain[chain.length - 1] ?? anchor.id))
    const lr = last ? drawnRect(last, s.boards, zoom) : null
    if (lr) place(lr.x + lr.width, lr.y)
  } else {
    const at = opts.at ?? viewportCenterInCanvas()
    const g = s.groups.find(gr => gr.id === gid)
    const r = g ? drawnRect(g, s.boards, zoom) : null
    if (r) place(at.cx - r.width / 2, at.cy - r.height / 2)
    if (opts.at) snapEffectCard(gid, null)
  }
  useBoardsStore.getState().setSelectedGroup(gid)
  return gid
}
