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

type R = { x: number; y: number; width: number; height: number }

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
  if (a && key.startsWith('card:') && linkedHere(key.slice(5), a.area)) return null
  return a && { ...a, box }
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
