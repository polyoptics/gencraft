// area3dScene.ts — a 3D area as a scene (Brian 2026-11-09): model cards
// lie on the area or dock along its sides, and their models stand INSIDE
// the area, each where it was put (tiltStore placeOf), up in the air if
// lifted. A model never placed stands on its card when the card lies on
// the area (as before), or just inside the edge when docked outside it.

import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useModelScaleStore, type ScenePlace } from '../store/tiltStore'
import { getMediaItems } from '../types/bar'
import { faceBlocks } from './cardGrid'
import { drawnRect } from './effectCards'
import { useViewport3DStore, type ViewportWindow3D } from '../store/viewport3dStore'
import { viewportVisualRect } from './viewportDocking'
import { useNotesStore } from '../store/notesStore'
import { cardsTouch, headerSlackAt, isHiddenDeckMember } from '../hooks/useCardDecks'

type R = { x: number; y: number; width: number; height: number }

/** What already lay where 3D area `a` opened out of its card (Brian
 *  2026-11-10): under it, not on it. A scene owns what it brought out and
 *  what is set down on it afterwards; these never move with it, fold into
 *  it or stand in its scene, until moved by hand (startAreaUnder). */
export const isUnder = (a: { under?: string[] }, key: string): boolean => !!a.under && a.under.includes(key)

/** How near a card's edge must come to the area's to dock (canvas units).
 *  The same at every zoom: zoomed out, a wider gap let cards nearby join
 *  the scene, and leave it again zooming in (magnets still snap a card
 *  flush, from further off when zoomed out). */
const dockGap = () => 24

const touches = (a: R, b: R, gap: number) =>
  a.x <= b.x + b.width + gap && a.x + a.width >= b.x - gap && a.y <= b.y + b.height + gap && a.y + a.height >= b.y - gap
/** Does a CARD's box `r` (as drawn now) dock against `b`? As any box, and
 *  along `b`'s bottom from further off: a card's header band is drawn above
 *  it and is taller, in canvas units, the further out the view is, so a
 *  card set flush under a set zoomed out lay well below it zoomed in and
 *  was docked no more (Brian 2026-11-13: "cards don't dock on the bottom
 *  properly"). Under it as far as that band can have put it: docked, the
 *  same at every zoom (as under a card-back window, HEADER_BAND_SLACK). */
const cardTouches = (r: R, b: R, gap: number) => touches(r, b, gap) ||
  (r.x <= b.x + b.width + gap && r.x + r.width >= b.x - gap && r.y > b.y + b.height && r.y <= b.y + b.height + gap + headerSlackAt(useCanvasStore.getState().zoom))
/** Is a CARD's box `r` docked under `b`: along its bottom, from below? */
export const docksUnder = (r: R, b: R): boolean => r.y + r.height / 2 > b.y + b.height && cardTouches(r, b, dockGap())
const inside = (a: R, px: number, py: number) => px >= a.x && px <= a.x + a.width && py >= a.y && py <= a.y + a.height

/** Does card `g` show a 3D model on its face? */
export function cardHoldsModel(g: ProjectGroup, boards: Record<string, BoardData>): boolean {
  const blocks = faceBlocks(g, boards)
  // (A face picture of its own shows flat; the model is still its model.)
  const bid = g.faceBoardId && blocks.includes(g.faceBoardId) ? g.faceBoardId : blocks[0]
  const b = bid ? boards[bid] : undefined
  for (const rid of b?.rootIds ?? []) {
    const m = getMediaItems(b!.bars[rid]?.content).find(it => it.type === 'image' || it.type === 'video' || it.type === 'model')
    if (m) return m.type === 'model'
  }
  return false
}

/** A card's box, canvas units. */
export function cardBox(g: ProjectGroup, boards = useBoardsStore.getState().boards): R | null {
  return drawnRect(g, boards, useCanvasStore.getState().zoom)
}

const areas = (nodes: Record<string, FreeNodeData>) => Object.values(nodes).filter(n => n.type === 'area' && !n.pin)
const smallest = (list: FreeNodeData[]) => list.sort((a, b) => a.width * a.height - b.width * b.height)[0] ?? null

/** The 3D area box `r` lies on (its middle inside), or else docks against
 *  (touching it from outside) — the smallest, for nested ones. */
export function areaOfBox(r: R, nodes = useFreeNodeStore.getState().nodes, not?: string, card = false): { area: FreeNodeData; docked: boolean } | null {
  const list = areas(nodes).filter(a => a.id !== not)
  const on = smallest(list.filter(a => inside(a, r.x + r.width / 2, r.y + r.height / 2)))
  if (on) return { area: on, docked: false }
  const gap = dockGap()
  const at = smallest(list.filter(a => (card ? cardTouches : touches)(r, a, gap)))
  return at ? { area: at, docked: true } : null
}

/** Where model `key`'s scene settings (place, turn, size, colour, stretch:
 *  tiltStore) are kept. A closed deck shows one member's model on its face
 *  (stepped with the arrows), so they go with that member card, not the
 *  deck's front card (Brian 2026-11-09). */
export function dataKey(key: string): string {
  if (!key.startsWith('card:')) return key
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.id === key.slice(5))
  if (!g) return key
  const face = deckFace(g, bs.groups)
  if (face) return `card:${face}`
  const front = frontShowing(g, bs.groups)
  return front ? `card:${front.id}` : key
}
/** The member a closed or fanned deck's front card `g` shows on its face,
 *  when that is not the front card itself. */
function deckFace(g: ProjectGroup, groups: ProjectGroup[]): string | undefined {
  const portal = g.deckState === 'fanned' ? useCanvasStore.getState().deckPortalSelections[g.id] : undefined
  const face = g.deckState === 'stacked' ? g.deckFaceCard : portal
  return face && face !== g.id && groups.some(x => x.id === face && x.deckAnchorId === g.id) ? face : undefined
}
/** Card `g` put away in a closed or fanned deck and shown on its face:
 *  that deck's front card. The front card stands for `g` then (dataKey,
 *  TiltModels cardModel), so `g` stands for the front card: its model and
 *  its settings. Each model of the deck is still in the scene, whichever
 *  card the face is on (Brian 2026-11-13: stepping a docked deck, "the
 *  first card is getting mixed up"). */
export function frontShowing(g: ProjectGroup, groups: ProjectGroup[]): ProjectGroup | undefined {
  if (!g.deckAnchorId || g.deckAnchorId === g.id || !isHiddenDeckMember(g)) return undefined
  const front = groups.find(x => x.id === g.deckAnchorId)
  return front && deckFace(front, groups) === g.id ? front : undefined
}

/** A model card or tile's box, from its key ('card:<id>' / 'node:<id>'). */
export function boxOfKey(key: string): R | null {
  if (key.startsWith('node:')) {
    const n = useFreeNodeStore.getState().nodes[key.slice(5)]
    return n && n.type === 'model' && !n.pin ? { x: n.x, y: n.y, width: n.width, height: n.height } : null
  }
  if (key.startsWith('card:')) {
    const bs = useBoardsStore.getState()
    const g = bs.groups.find(x => x.id === key.slice(5))
    return g && !g.pin ? cardBox(g, bs.boards) : null
  }
  return null
}

/** What lies in box `m` (canvas units), as keys: cards (and the model cards
 *  along its sides), tiles and other areas, Viewers, and curves drawn
 *  wholly there before curves had parents (a curve with a parent, or
 *  unparented by hand, goes by that: utils/curveParent). Not card
 *  `notCard`, nor tile `notNode`. */
export function lyingIn(m: R, notCard?: string, notNode?: string): string[] {
  const { groups, boards } = useBoardsStore.getState()
  const on = (x: number, y: number) => x >= m.x && x <= m.x + m.width && y >= m.y && y <= m.y + m.height
  return [
    ...setCards({ x: m.x, y: m.y, width: m.width, height: m.height }, groups, boards, notCard).map(g => `card:${g.id}`),
    ...Object.values(useFreeNodeStore.getState().nodes).filter(n => n.id !== notNode && !n.pin && n.type !== 'storyline' && on(n.x + n.width / 2, n.y + n.height / 2)).map(n => `node:${n.id}`),
    ...Object.values(useViewport3DStore.getState().windows).filter(w => on(w.x + w.width / 2, w.y + w.height / 2)).map(w => `viewer:${w.id}`),
    ...Object.values(useNotesStore.getState().curves).filter(c => c.parent === undefined && c.pts.length && c.pts.every(p => on(p.x, p.y))).map(c => `curve:${c.id}`),
  ]
}

/** Does Viewer `w` (as drawn, its header with it) lie against box `b`? */
export const viewerTouches = (w: ViewportWindow3D, b: R): boolean =>
  !w.pin && touches(viewportVisualRect(w, useCanvasStore.getState().zoom), b, dockGap())
/** The Viewers with 3D set `a` (its box `box`): on its ground, or set
 *  against one of its sides (Brian 2026-11-13: "The 2D viewer should magnet
 *  to the 3D set, and collapse with the 3D set card"). They go where it
 *  goes and fold away with it (utils/areaFollow, utils/area3dCard). Not
 *  one it came out over or next to (isUnder), till that one is moved. */
export function setViewers(a: { under?: string[] }, box: R): ViewportWindow3D[] {
  return Object.values(useViewport3DStore.getState().windows).filter(w =>
    !w.pin && !isUnder(a, `viewer:${w.id}`) && (inside(box, w.x + w.width / 2, w.y + w.height / 2) || viewerTouches(w, box)))
}

/** While a 3D set is being laid out from its card (utils/area3dCard), what
 *  its ground covers is worked out there, not by the sweep (areaFollow). */
export const laying = { on: false }

/** While a 3D set is taking its cards along (moved: areaFollow; an edge
 *  pulled: holdSets), they are not moving by themselves: its card moving
 *  then does not move the set in turn (area3dCard startArea3dFollow). */
export const carrying = { on: false }
/** Cards that moved by themselves in the change being followed (a drag of
 *  the set's card takes the set along): the set does not move those again. */
export const selfMoved = new Set<string>()

/** The cards in a row with a 3D set's card, while its set is out (Brian
 *  2026-11-10: the set is a deck; a model card or deck attached to its
 *  card is in the set, and its model stands in the set's view). By card
 *  id, the set's ground. Worked out once for each state of the canvas. */
type RowSpot = { area: FreeNodeData; i: number; n: number }

/** 3D set `a`'s card and the cards with it (Brian 2026-11-13: a set and
 *  its card are never apart, and any card docked under the set is with
 *  it till it is dragged off by hand): its card first, then every card
 *  docked along the set's bottom (any kind; not a linked card, which is
 *  the set's by its layout, nor what the set opened over), and the cards
 *  in a row with those. `box`: the set's box to go by (where it was, as it
 *  moves). `taken`: cards another set has. */
export function rowCards(a: FreeNodeData, box: R = a, taken?: (id: string) => boolean): ProjectGroup[] {
  const bs = useBoardsStore.getState(), zoom = useCanvasStore.getState().zoom
  const seen = bs.groups.filter(g => !g.pin && !isHiddenDeckMember(g))
  const card = seen.find(g => g.id === a.areaCard)
  if (!card) return []
  const apart = (p: ProjectGroup, q: ProjectGroup) => !!p.rowUnder?.includes(q.id) || !!q.rowUnder?.includes(p.id)
  const row = [card]
  for (const g of seen) {
    if (row.includes(g) || g.linkOf || taken?.(g.id) || apart(g, card) || isUnder(a, `card:${g.id}`)) continue
    const r = cardBox(g, bs.boards)
    if (r && docksUnder(r, box)) row.push(g)
  }
  for (let i = 0; i < row.length; i++) {
    for (const g of seen) {
      if (row.includes(g) || taken?.(g.id) || apart(g, row[i]) || isUnder(a, `card:${g.id}`) || !cardsTouch(g, row[i], bs.boards, zoom)) continue
      row.push(g)
    }
  }
  return row
}
let rowMemo: { groups: unknown; boards: unknown; nodes: unknown; zoom: number; of: Map<string, RowSpot> } | null = null
function rowSets(): Map<string, RowSpot> {
  const bs = useBoardsStore.getState(), nodes = useFreeNodeStore.getState().nodes, zoom = useCanvasStore.getState().zoom
  if (rowMemo && rowMemo.groups === bs.groups && rowMemo.boards === bs.boards && rowMemo.nodes === nodes && rowMemo.zoom === zoom) return rowMemo.of
  const of = new Map<string, RowSpot>()
  const outs = areas(nodes).filter(a => a.areaCard)
  if (outs.length) {
    for (const a of outs) {
      const row = rowCards(a, a, id => of.has(id))
      if (!row.length) continue
      // Each its turn along the set's front, for a model never placed.
      const mine: string[] = []
      for (const g of row.slice(1)) mine.push(g.id)
      // A closed deck in the row (Brian 2026-11-10): its cards are in the
      // set too, so the models placed there stand there without opening
      // it (one never placed waits in the deck). The one a deck shows on
      // its face is its front card's model, and stands for the front
      // card's own (dataKey).
      const inside: ProjectGroup[] = []
      const fronts = row.slice(1).filter(g => !!g.deckState && g.deckState !== 'open')
      for (let i = 0; i < fronts.length; i++) {
        for (const m of bs.groups) {
          if (m.pin || m.id === fronts[i].id || m.deckAnchorId !== fronts[i].id || !isHiddenDeckMember(m) || inside.includes(m)) continue
          inside.push(m)
          fronts.push(m)
        }
      }
      const placeOf = useModelScaleStore.getState().placeOf
      for (const m of inside) if (!of.has(m.id) && placeOf[dataKey(`card:${m.id}`)]) mine.push(m.id)
      mine.forEach((id, i) => of.set(id, { area: a, i, n: mine.length }))
    }
  }
  rowMemo = { groups: bs.groups, boards: bs.boards, nodes, zoom, of }
  return of
}

/** Is master card `id` shown in area `area`'s scene by a linked card of
 *  it? A scene shown from its card brings out linked cards of the masters
 *  folded into it, which stand where the masters stood. The scene's models
 *  are those linked cards' own, as a chart's are (Brian 2026-11-09): the
 *  master itself, opened or closed, is never part of that scene. */
function linkedHere(id: string, area: FreeNodeData): boolean {
  const bs = useBoardsStore.getState()
  for (const g of bs.groups) {
    if (g.linkOf !== id || g.pin) continue
    const r = cardBox(g, bs.boards)
    if (r && areaOfBox(r, undefined, undefined, true)?.area.id === area.id) return true
  }
  return false
}

/** The 3D area model `key` is in the scene of, if any. */
export function sceneOf(key: string): { area: FreeNodeData; docked: boolean; box: R } | null {
  const box = boxOfKey(key)
  if (!box) return null
  const a = areaOfBox(box, undefined, key.startsWith('node:') ? key.slice(5) : undefined, key.startsWith('card:'))
  // It lay there before the scene opened over it: not in that scene.
  if (a && isUnder(a.area, key)) return null
  if (a && key.startsWith('card:') && linkedHere(key.slice(5), a.area)) return null
  if (a) return { ...a, box }
  // In a row with a 3D set's card: in that set, as one docked along it.
  const row = key.startsWith('card:') ? rowSets().get(key.slice(5)) : undefined
  return row ? { area: row.area, docked: true, box } : null
}

/** Does model `key` stand in a 3D set: on its ground, or, attached to it
 *  (docked along it, in its card's deck), once it has been placed there
 *  (Brian 2026-11-10)? Attached and never placed, it waits on its own
 *  card, turning, as on any card, till it is dragged onto the set. */
export function standsIn(key: string): boolean {
  const sc = sceneOf(key)
  return !!sc && (!sc.docked || !!useModelScaleStore.getState().placeOf[dataKey(key)])
}

/** Where model `key` stands in area `a`'s scene when it was never placed:
 *  its card's middle, pulled just inside the area. */
export function defaultPlace(a: FreeNodeData, box: R): ScenePlace {
  const m = Math.min(a.width, a.height) * 0.12
  const cx = Math.min(a.x + a.width - m, Math.max(a.x + m, box.x + box.width / 2))
  const cy = Math.min(a.y + a.height - m, Math.max(a.y + m, box.y + box.height / 2))
  return { dx: cx - a.x, dy: cy - a.y, h: 0 }
}

/** Where model `key` stands, canvas units (its foot's middle and height),
 *  when it stands off its card: placed in a set. null: on its card, as
 *  any model. */
export function sceneSpot(key: string): { x: number; y: number; h: number; card: R } | null {
  const sc = sceneOf(key)
  if (!sc) return null
  const q = useModelScaleStore.getState().placeOf[dataKey(key)]
  if (!q) return null
  return { x: sc.area.x + q.dx, y: sc.area.y + q.dy, h: q.h, card: sc.box }
}

/** Where model `key` stands now in its scene, as a place (for a handle drag
 *  to start from). */
export function placeNow(key: string): ScenePlace | null {
  const sc = sceneOf(key)
  if (!sc) return null
  // Never placed: where it is, on its card (on the set's ground or off it).
  return useModelScaleStore.getState().placeOf[dataKey(key)]
    ?? { dx: sc.box.x + sc.box.width / 2 - sc.area.x, dy: sc.box.y + sc.box.height / 2 - sc.area.y, h: 0 }
}

/** What was each 3D set's own when the resize of it by hand that is going
 *  on began (by the set's id; holdSets): its own all through that drag,
 *  whatever its edge passes and comes back across, or comes to cover
 *  (areaFollow's sweep). */
export const resizing = new Map<string, Set<string>>()

/** The set each place held in a resize by hand was measured from then
 *  (holdSets), and where its card or tile and the place itself were left:
 *  while neither has changed since, the place is that set's still, wherever
 *  the card has come to lie by the set's edges alone (one set inside
 *  another: an edge of the inner one passed it and it lies on the outer). */
const measured = new Map<string, { set: string; x: number; y: number; dx: number; dy: number }>()

/** The 3D set each kept place (tiltStore placeOf, by its key) is measured
 *  from. The set its model stands in (sceneOf); for one that does not show
 *  now, the set its card or tile is with all the same: lying under it,
 *  shown there by a linked card, pinned off it, or a card of a closed deck
 *  there that is not on the deck's face; and for one with no set (its card
 *  was taken off, or the set's edge has passed it), the set nearest its
 *  card: put back on, its model stands where it stood. Places of cards
 *  and tiles that are gone are left out. */
function placeSets(): Map<string, string> {
  const placeOf = useModelScaleStore.getState().placeOf
  const nodes = useFreeNodeStore.getState().nodes
  const { groups, boards } = useBoardsStore.getState()
  const byId = new Map(groups.map(g => [g.id, g]))
  const sets = areas(nodes)
  // Where it lies (as sceneOf): on a set's ground, docked along it, or in
  // a row with its card.
  const at = (box: R | null, key: string): string | null => {
    const not = key.startsWith('node:') ? key.slice(5) : undefined
    // On a set and under another that has grown over it: the first one's.
    const free = Object.fromEntries(Object.entries(nodes).filter(([, n]) => !isUnder(n, key)))
    const card = key.startsWith('card:')
    const a = box && (areaOfBox(box, free, not, card) ?? areaOfBox(box, nodes, not, card))
    return a ? a.area.id : key.startsWith('card:') ? rowSets().get(key.slice(5))?.area.id ?? null : null
  }
  const off = (a: R, b: R) => Math.hypot(Math.max(a.x - b.x - b.width, b.x - a.x - a.width, 0), Math.max(a.y - b.y - b.height, b.y - a.y - a.height, 0))
  const nearest = (box: R | null): string | null => {
    let best: FreeNodeData | null = null, d = Infinity
    if (box) for (const a of sets) { const da = off(box, a); if (da < d) { best = a; d = da } }
    return best ? best.id : null
  }
  const of = new Map<string, string>()
  for (const [dk, m] of measured) {
    const q = placeOf[dk], b = boxOfKey(dk), a = nodes[m.set]
    if (q && b && a && a.type === 'area' && !a.pin && q.dx === m.dx && q.dy === m.dy && b.x === m.x && b.y === m.y) of.set(dk, m.set)
    else measured.delete(dk)
  }
  // The member on a closed deck's face stands where the deck is (dataKey).
  for (const g of groups) {
    if (g.pin || isHiddenDeckMember(g) || (g.deckState !== 'stacked' && g.deckState !== 'fanned')) continue
    const key = `card:${g.id}`, dk = dataKey(key)
    const set = dk !== key && placeOf[dk] ? at(cardBox(g, boards), key) : null
    if (set && !of.has(dk)) of.set(dk, set)
  }
  for (const dk of Object.keys(placeOf)) {
    if (of.has(dk)) continue
    let box: R | null = null, set: string | null = null
    if (dk.startsWith('node:')) {
      const n = nodes[dk.slice(5)]
      if (!n) continue
      box = n
      set = at(box, dk)
    } else if (dk.startsWith('card:')) {
      let g = byId.get(dk.slice(5))
      if (!g) continue
      box = cardBox(g, boards)
      set = at(box, dk)
      // Inside a closed deck, lying nowhere itself: where its deck is.
      for (let i = 0; !set && i < 8 && isHiddenDeckMember(g); i++) {
        const up: ProjectGroup | undefined = byId.get(g.deckAnchorId!)
        if (!up) break
        g = up
        box = cardBox(g, boards)
        set = at(box, `card:${g.id}`)
      }
    } else continue
    set ??= nearest(box)
    if (set) of.set(dk, set)
  }
  return of
}

/** 3D sets resized by hand change their ground and nothing on it (Brian
 *  2026-11-13: more ground on any side "when I don't want to adjust
 *  anything else"). Called as a resize of the nodes `ids` begins; null
 *  when none of them is a 3D set.
 *   - Models stay where they stand. A place is measured from its set's
 *     corner (tiltStore placeOf), which a pull on the set's top or left
 *     edge moves, so it is taken from the corner as that goes: `step`,
 *     after each change of the sets' boxes. Every place of the set
 *     (placeSets), also one whose model does not show now: when it shows
 *     again it stands where it stood.
 *   - The ground's grid stays where it lies, under what is on it: where
 *     it begins (the set's gridAt) is taken from the corner the same way.
 *   - What is a set's own stays its own though an edge passes it, or comes
 *     to cover it, in this drag (`resizing`), till `end`. */
export function holdSets(ids: string[], spread = false): { step: () => void; end: () => void } | null {
  const all = useFreeNodeStore.getState().nodes
  const sets = ids.map(id => all[id]).filter(a => a && a.type === 'area' && !a.pin)
  if (!sets.length) return null
  // (A drag whose end was never heard of is over all the same.)
  resizing.clear()
  for (const a of sets) {
    // What lies on it, and what is its own by another rule: the cards in
    // a row with its card, and a model tile along its side whose model
    // stands in it.
    const own = new Set(lyingIn(a, a.areaCard, a.id))
    for (const [id, row] of rowSets()) if (row.area.id === a.id) own.add(`card:${id}`)
    // The Viewers set against it: each with the side it is on.
    for (const w of setViewers(a, a)) own.add(`viewer:${w.id}`)
    // Its own card, docked under it: with the edge it lies along.
    if (a.areaCard) own.add(`card:${a.areaCard}`)
    for (const n of Object.values(all)) {
      const key = `node:${n.id}`
      if (n.type === 'model' && !n.pin && standsIn(key) && sceneOf(key)?.area.id === a.id) own.add(key)
    }
    resizing.set(a.id, own)
  }
  // What goes with each set's edges, from where it was at the press. Along
  // a side of the set (docked, in a row with its card): with that side.
  // On its ground: by a corner, spread with the ground (`spread`); by a
  // side, it stays.
  type Rider = { x: number; y: number; to: (dx: number, dy: number, fx: number, fy: number) => void }
  const riders = new Map<string, Rider[]>()
  const bs0 = useBoardsStore.getState()
  for (const a of sets) {
    const own = resizing.get(a.id)!
    const list: Rider[] = []
    // (What lies on a set inside this one goes as that set goes: areaFollow.)
    const inner = Object.values(all).filter(n => n.type === 'area' && n.id !== a.id && !n.pin && own.has(`node:${n.id}`))
    const carried = (x: number, y: number) => inner.some(n => inside(n, x, y))
    const out = (x: number, y: number) => !inside(a, x, y)
    for (const key of own) {
      if (isUnder(a, key)) continue
      const id = key.slice(key.indexOf(':') + 1)
      if (key.startsWith('card:')) {
        const g = bs0.groups.find(x => x.id === id), b = g && cardBox(g, bs0.boards)
        if (!g || !b) continue
        const x = b.x + b.width / 2, y = b.y + b.height / 2
        if (carried(x, y) || !spread && !out(x, y)) continue
        const ox = g.originX, oy = g.originY
        list.push({ x, y, to: (dx, dy) => {
          const now = useBoardsStore.getState().groups.find(q => q.id === id)
          if (now && (now.originX !== ox + dx || now.originY !== oy + dy)) useBoardsStore.getState().setGroupPosBatch([{ groupId: id, originX: ox + dx, originY: oy + dy }])
        } })
      } else if (key.startsWith('node:')) {
        const n = all[id]
        if (!n) continue
        const x = n.x + n.width / 2, y = n.y + n.height / 2
        if (n.type !== 'area' && carried(x, y) || !spread && !out(x, y)) continue
        const ox = n.x, oy = n.y
        list.push({ x, y, to: (dx, dy) => {
          const now = useFreeNodeStore.getState().nodes[id]
          if (now && (now.x !== ox + dx || now.y !== oy + dy)) useFreeNodeStore.getState().updateFreeNode(id, { x: ox + dx, y: oy + dy })
        } })
      } else if (key.startsWith('viewer:')) {
        const w = useViewport3DStore.getState().windows[id]
        if (!w) continue
        const x = w.x + w.width / 2, y = w.y + w.height / 2
        if (carried(x, y) || !spread && !out(x, y)) continue
        const ox = w.x, oy = w.y
        list.push({ x, y, to: (dx, dy) => {
          const now = useViewport3DStore.getState().windows[id]
          if (now && (now.x !== ox + dx || now.y !== oy + dy)) useViewport3DStore.getState().updateWindow(id, { x: ox + dx, y: oy + dy })
        } })
      }
    }
    // Its arrows and lines (parented to it; from before parents, lying on it): each point.
    if (spread) for (const c of Object.values(useNotesStore.getState().curves)) {
      if (c.parent !== a.id && !(c.parent === undefined && own.has(`curve:${c.id}`) && !isUnder(a, `curve:${c.id}`))) continue
      const pts = c.pts, id = c.id
      pts.forEach((p, i) => list.push({ x: p.x, y: p.y, to: (dx, dy, fx, fy) => {
        const cur = useNotesStore.getState().curves[id], q = cur?.pts[i]
        if (!cur || !q || cur.pts.length !== pts.length) return
        const h = (v?: { x: number; y: number; z?: number }) => v && { ...v, x: v.x * fx, y: v.y * fy }
        const hin = h(p.hin), hout = h(p.hout)
        if (q.x === p.x + dx && q.y === p.y + dy && q.hin?.x === hin?.x && q.hin?.y === hin?.y && q.hout?.x === hout?.x && q.hout?.y === hout?.y) return
        const next = cur.pts.slice()
        next[i] = { ...q, x: p.x + dx, y: p.y + dy, ...(hin ? { hin } : {}), ...(hout ? { hout } : {}) }
        useNotesStore.getState().updateCurve(id, { pts: next })
      } }))
    }
    riders.set(a.id, list)
  }
  const placeOf = useModelScaleStore.getState().placeOf
  const held: { dk: string; p: ScenePlace; set: string }[] = []
  const mine = new Set(sets.map(a => a.id))
  for (const [dk, set] of placeSets()) {
    if (!mine.has(set)) continue
    const p = placeOf[dk], b = boxOfKey(dk)
    held.push({ dk, p, set })
    if (b) measured.set(dk, { set, x: b.x, y: b.y, dx: p.dx, dy: p.dy })
  }
  return {
    // All from where the drag began, not from the step before: right also
    // after an undo in the middle of the drag has put everything back.
    step: () => {
      const fs = useFreeNodeStore.getState()
      // How far each set's corner has gone.
      const gone = new Map<string, { x: number; y: number }>()
      for (const a0 of sets) {
        const a = fs.nodes[a0.id]
        if (!a) continue
        const d = { x: a.x - a0.x, y: a.y - a0.y }
        gone.set(a0.id, d)
        const gx = (a0.gridAt?.x ?? 0) - d.x, gy = (a0.gridAt?.y ?? 0) - d.y
        if ((a.gridAt?.x ?? 0) !== gx || (a.gridAt?.y ?? 0) !== gy) fs.updateFreeNode(a.id, { gridAt: gx || gy ? { x: gx, y: gy } : undefined })
      }
      const now = useModelScaleStore.getState().placeOf
      let next: Record<string, ScenePlace> | null = null
      for (const { dk, p, set } of held) {
        const d = gone.get(set), q = now[dk]
        // (One taken off its place meanwhile stays off it.)
        if (!d || !q) continue
        const a0 = all[set], a = fs.nodes[set]
        // By a corner the ground spreads, and where each stands on it with it.
        const dx = spread && a ? p.dx * a.width / a0.width : p.dx - d.x, dy = spread && a ? p.dy * a.height / a0.height : p.dy - d.y
        if (q.dx !== dx || q.dy !== dy) (next ??= { ...now })[dk] = { ...q, dx, dy }
        const m = measured.get(dk)
        if (m && m.set === set) { m.dx = dx; m.dy = dy }
      }
      if (next) useModelScaleStore.setState({ placeOf: next })
      for (const a0 of sets) {
        const a = useFreeNodeStore.getState().nodes[a0.id]
        if (!a) continue
        const fx = spread ? a.width / a0.width : 1, fy = spread ? a.height / a0.height : 1
        // Past an edge: as far past it as it was. Between the edges: spread, or where it was.
        const go = (v: number, lo0: number, len0: number, lo: number, len: number, f: number) =>
          v < lo0 ? lo - lo0 : v > lo0 + len0 ? lo + len - lo0 - len0 : spread ? lo + (v - lo0) * f - v : 0
        const was = carrying.on
        carrying.on = true
        try {
          for (const r of riders.get(a0.id) ?? []) r.to(go(r.x, a0.x, a0.width, a.x, a.width, fx), go(r.y, a0.y, a0.height, a.y, a.height, fy), fx, fy)
        } finally { carrying.on = was }
      }
    },
    end: () => { for (const a of sets) resizing.delete(a.id) },
  }
}

/** The cards of 3D area `a` (box `was`, its id `id`): those lying on it
 *  (their middle, as drawn, inside it) and the model cards docked along
 *  its sides. ONE rule for the scene, its fold and its moving (a card bigger
 *  than its corner told apart, Brian 2026-11-09: cards made on a scene
 *  zoomed out were missed by the fold). */
export function setCards(was: R & { under?: string[] }, groups: ProjectGroup[], boards: Record<string, BoardData>, not?: string): ProjectGroup[] {
  // What lay there before it opened is under it, not on it (isUnder).
  if (was.under?.length) groups = groups.filter(g => !isUnder(was, `card:${g.id}`))
  const on = groups.filter(g => {
    if (g.id === not || g.pin) return false
    const r = cardBox(g, boards)
    return !!r && inside(was, r.x + r.width / 2, r.y + r.height / 2)
  })
  return [...on, ...dockedCards(was, groups.filter(g => g.id !== not && !on.includes(g)), boards)]
}

/** Model cards docked along area `was`'s sides (not on it). */
export function dockedCards(was: R, groups: ProjectGroup[], boards: Record<string, BoardData>): ProjectGroup[] {
  const gap = dockGap()
  // A set's own card and the cards with it (rowCards) are with the set as
  // they are: never folded into it as its layout's cards are.
  const rows = rowSets()
  const setCardIds = new Set(areas(useFreeNodeStore.getState().nodes).map(a => a.areaCard))
  // (Nor a card put away in a closed deck that is with a set: it is in
  // that deck, wherever it lies under the deck's front card.)
  const byId = new Map(groups.map(g => [g.id, g]))
  const withSet = (g: ProjectGroup): boolean => {
    let up: ProjectGroup | undefined = g
    for (let i = 0; up && i < 8; i++) {
      if (rows.has(up.id) || setCardIds.has(up.id)) return true
      up = isHiddenDeckMember(up) ? byId.get(up.deckAnchorId!) : undefined
    }
    return false
  }
  return groups.filter(g => {
    if (g.pin || withSet(g)) return false
    const r = cardBox(g, boards)
    if (!r || inside(was, r.x + r.width / 2, r.y + r.height / 2) || !cardTouches(r, was, gap) || !cardHoldsModel(g, boards)) return false
    // A master with a linked card of it in this scene stays where it is.
    return !groups.some(l => {
      if (l.linkOf !== g.id || l.pin) return false
      const lr = cardBox(l, boards)
      return !!lr && (inside(was, lr.x + lr.width / 2, lr.y + lr.height / 2) || cardTouches(lr, was, gap))
    })
  })
}

/** Something under a 3D area (isUnder) moved by hand is under it no more:
 *  set down on the area, it is on it, as anything put there. The area
 *  itself never moves what is under it, so any move of one is by hand. */
export function startAreaUnder(): () => void {
  type P = { x: number; y: number }
  const spots = (): Map<string, P> => {
    const m = new Map<string, P>()
    const nodes = useFreeNodeStore.getState().nodes
    const keys = new Set(Object.values(nodes).flatMap(n => (n.type === 'area' && n.under?.length ? n.under : [])))
    if (!keys.size) return m
    const groups = useBoardsStore.getState().groups
    for (const k of keys) {
      if (k.startsWith('card:')) { const g = groups.find(x => x.id === k.slice(5)); if (g) m.set(k, { x: g.originX, y: g.originY }) }
      else if (k.startsWith('node:')) { const n = nodes[k.slice(5)]; if (n) m.set(k, { x: n.x, y: n.y }) }
      else if (k.startsWith('viewer:')) { const w = useViewport3DStore.getState().windows[k.slice(7)]; if (w) m.set(k, { x: w.x, y: w.y }) }
    }
    return m
  }
  let last = spots()
  let busy = false
  const check = () => {
    if (busy) return
    const now = spots()
    const moved = new Set<string>()
    for (const [k, p] of now) { const q = last.get(k); if (q && (q.x !== p.x || q.y !== p.y)) moved.add(k) }
    last = now
    if (!moved.size) return
    busy = true
    try {
      const fs = useFreeNodeStore.getState()
      for (const a of Object.values(fs.nodes)) {
        if (a.type !== 'area' || !a.under?.some(k => moved.has(k))) continue
        fs.updateFreeNode(a.id, { under: a.under.filter(k => !moved.has(k)) })
      }
    } finally { busy = false }
    last = spots()
  }
  const offA = useBoardsStore.subscribe(check)
  const offB = useFreeNodeStore.subscribe(check)
  const offC = useViewport3DStore.subscribe(check)
  return () => { offA(); offB(); offC() }
}
