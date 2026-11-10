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
import { useViewport3DStore } from '../store/viewport3dStore'
import { useNotesStore } from '../store/notesStore'
import { cardsTouch, isHiddenDeckMember } from '../hooks/useCardDecks'

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
const inside = (a: R, px: number, py: number) => px >= a.x && px <= a.x + a.width && py >= a.y && py <= a.y + a.height

/** Does card `g` show a 3D model on its face? */
export function cardHoldsModel(g: ProjectGroup, boards: Record<string, BoardData>): boolean {
  const blocks = faceBlocks(g, boards)
  const bid = g.faceBoardId && blocks.includes(g.faceBoardId) ? g.faceBoardId : g.cardHeroImage ? null : blocks[0]
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
export function areaOfBox(r: R, nodes = useFreeNodeStore.getState().nodes, not?: string): { area: FreeNodeData; docked: boolean } | null {
  const list = areas(nodes).filter(a => a.id !== not)
  const on = smallest(list.filter(a => inside(a, r.x + r.width / 2, r.y + r.height / 2)))
  if (on) return { area: on, docked: false }
  const gap = dockGap()
  const at = smallest(list.filter(a => touches(r, a, gap)))
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
  const portal = g.deckState === 'fanned' ? useCanvasStore.getState().deckPortalSelections[g.id] : undefined
  const face = g.deckState === 'stacked' ? g.deckFaceCard : portal
  return face && face !== g.id && bs.groups.some(x => x.id === face && x.deckAnchorId === g.id) ? `card:${face}` : key
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
 *  wholly there. Not card `notCard`, nor tile `notNode`. */
export function lyingIn(m: R, notCard?: string, notNode?: string): string[] {
  const { groups, boards } = useBoardsStore.getState()
  const on = (x: number, y: number) => x >= m.x && x <= m.x + m.width && y >= m.y && y <= m.y + m.height
  return [
    ...setCards({ x: m.x, y: m.y, width: m.width, height: m.height }, groups, boards, notCard).map(g => `card:${g.id}`),
    ...Object.values(useFreeNodeStore.getState().nodes).filter(n => n.id !== notNode && !n.pin && n.type !== 'storyline' && on(n.x + n.width / 2, n.y + n.height / 2)).map(n => `node:${n.id}`),
    ...Object.values(useViewport3DStore.getState().windows).filter(w => on(w.x + w.width / 2, w.y + w.height / 2)).map(w => `viewer:${w.id}`),
    ...Object.values(useNotesStore.getState().curves).filter(c => c.pts.length && c.pts.every(p => on(p.x, p.y))).map(c => `curve:${c.id}`),
  ]
}

/** While a 3D set is being laid out from its card (utils/area3dCard), what
 *  its ground covers is worked out there, not by the sweep (areaFollow). */
export const laying = { on: false }

/** The cards in a row with a 3D set's card, while its set is out (Brian
 *  2026-11-10: the set is a deck; a model card or deck attached to its
 *  card is in the set, and its model stands in the set's view). By card
 *  id, the set's ground. Worked out once for each state of the canvas. */
let rowMemo: { groups: unknown; boards: unknown; nodes: unknown; zoom: number; of: Map<string, FreeNodeData> } | null = null
function rowSets(): Map<string, FreeNodeData> {
  const bs = useBoardsStore.getState(), nodes = useFreeNodeStore.getState().nodes, zoom = useCanvasStore.getState().zoom
  if (rowMemo && rowMemo.groups === bs.groups && rowMemo.boards === bs.boards && rowMemo.nodes === nodes && rowMemo.zoom === zoom) return rowMemo.of
  const of = new Map<string, FreeNodeData>()
  const outs = areas(nodes).filter(a => a.areaCard)
  if (outs.length) {
    const seen = bs.groups.filter(g => !g.pin && !isHiddenDeckMember(g))
    const apart = (a: ProjectGroup, b: ProjectGroup) => !!a.rowUnder?.includes(b.id) || !!b.rowUnder?.includes(a.id)
    for (const a of outs) {
      const card = seen.find(g => g.id === a.areaCard)
      if (!card) continue
      const row = [card]
      for (let i = 0; i < row.length; i++) {
        for (const g of seen) {
          if (row.includes(g) || of.has(g.id) || apart(g, row[i]) || !cardsTouch(g, row[i], bs.boards, zoom)) continue
          row.push(g)
        }
      }
      for (const g of row.slice(1)) of.set(g.id, a)
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
    if (r && areaOfBox(r, undefined)?.area.id === area.id) return true
  }
  return false
}

/** The 3D area model `key` is in the scene of, if any. */
export function sceneOf(key: string): { area: FreeNodeData; docked: boolean; box: R } | null {
  const box = boxOfKey(key)
  if (!box) return null
  const a = areaOfBox(box, undefined, key.startsWith('node:') ? key.slice(5) : undefined)
  // It lay there before the scene opened over it: not in that scene.
  if (a && isUnder(a.area, key)) return null
  if (a && key.startsWith('card:') && linkedHere(key.slice(5), a.area)) return null
  if (a) return { ...a, box }
  // In a row with a 3D set's card: in that set, as one docked along it.
  const row = key.startsWith('card:') ? rowSets().get(key.slice(5)) : undefined
  return row ? { area: row, docked: true, box } : null
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
 *  when it stands off its card: placed, or docked outside. null: on its
 *  card, as any model. */
export function sceneSpot(key: string): { x: number; y: number; h: number; card: R } | null {
  const sc = sceneOf(key)
  if (!sc) return null
  const p = useModelScaleStore.getState().placeOf[dataKey(key)]
  if (!p && !sc.docked) return null
  const q = p ?? defaultPlace(sc.area, sc.box)
  return { x: sc.area.x + q.dx, y: sc.area.y + q.dy, h: q.h, card: sc.box }
}

/** Where model `key` stands now in its scene, as a place (for a handle drag
 *  to start from). */
export function placeNow(key: string): ScenePlace | null {
  const sc = sceneOf(key)
  if (!sc) return null
  return useModelScaleStore.getState().placeOf[dataKey(key)] ?? defaultPlace(sc.area, sc.box)
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
  return groups.filter(g => {
    if (g.pin) return false
    const r = cardBox(g, boards)
    if (!r || inside(was, r.x + r.width / 2, r.y + r.height / 2) || !touches(r, was, gap) || !cardHoldsModel(g, boards)) return false
    // A master with a linked card of it in this scene stays where it is.
    return !groups.some(l => {
      if (l.linkOf !== g.id || l.pin) return false
      const lr = cardBox(l, boards)
      return !!lr && (inside(was, lr.x + lr.width / 2, lr.y + lr.height / 2) || touches(lr, was, gap))
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
  return () => { offA(); offB() }
}
