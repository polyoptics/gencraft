// cameraLook.ts — looks on a camera or a 3D set (Brian 2026-11-15: "docked
// on a camera or a 3D set, not per model, so one set can look plain from
// one camera and cel-shaded from another").
//
// A look is nothing new: it is the effect cards. Lined up to the right of a
// camera's card (the way they line up after a picture card, utils/
// effectCards), they are that camera's look. With a 3D set (docked under
// it or along it, or lined up after the set's own card) and not after
// another card, they are the set's look, and every camera of the set has
// it. A camera's picture goes through its set's look first, then its own,
// left to right, wherever that camera's view is shown: looking through it,
// and in a Viewer set to it. The models, the set and the main 3D view are
// never changed by it.
//
// Only effects that draw at once take part (Bloom, Glare, Glow, Ink lines,
// Cel shade, Sketch, Screentone, Chromatic, Colour grade). One that needs a
// second picture, a depth map, a mask or the drawing tools is passed over
// here, as if switched off: those take seconds a frame.

import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { getHiddenGroupIds } from '../hooks/useCardDecks'
import { getMediaItems } from '../types/bar'
import { CAMERA_URL } from '../three/primitives'
import { effectChain } from './effectCards'
import { sceneOf } from './area3dScene'
import { fx } from './fx/fxEngine'
import { effectiveItems, planChain, type ChainItem } from './fx/chain'
import { EFFECTS, effectParams, knownKind } from './fx/effects'

type EffectItem = Extract<ChainItem, { kind: 'effect' }>

export interface CameraLook {
  /** The effects that run, in order. */
  steps: EffectItem[]
  /** Names what it would draw: the same string, the same look. */
  sig: string
}

/** Can this effect be drawn on a moving picture, frame by frame? */
function live(kind: EffectItem['effect']): boolean {
  const def = EFFECTS[kind]
  return !def.blend && !def.needs?.length && kind !== 'combine' && kind !== 'linemix' && kind !== 'shademix' && kind !== 'depth' && kind !== 'segment'
}

function holdsCamera(g: ProjectGroup, boards: Record<string, BoardData>): boolean {
  for (const bid of g.boardIds ?? []) {
    const b = boards[bid]
    for (const rid of b?.rootIds ?? []) {
      if (getMediaItems(b.bars[rid]?.content).some(m => m.type === 'model' && m.url === CAMERA_URL)) return true
    }
  }
  return false
}

const itemOf = (g: ProjectGroup): EffectItem => ({
  id: g.id, kind: 'effect', effect: knownKind(g.effect!.kind), params: g.effect!.params, text: g.effect!.text, off: g.effect!.off, solo: g.effect!.solo,
})

let memo: { groups: unknown; boards: unknown; nodes: unknown; zoom: number; of: Map<string, CameraLook | null> } | null = null

function build(): Map<string, CameraLook | null> {
  const of = new Map<string, CameraLook | null>()
  const { groups, boards } = useBoardsStore.getState()
  const effects = groups.filter(g => g.effect && !g.pin)
  if (!effects.length) return of
  const hidden = getHiddenGroupIds(groups)
  const byId = new Map(groups.map(g => [g.id, g]))
  const setOf = (id: string) => sceneOf(`card:${id}`)?.area ?? null
  // Each set's cards that are not effect cards, and the effect cards lined
  // up after each: a camera's are its look, the set's card's are the set's,
  // any other card's are that card's own business.
  const bySet = new Map<string, { area: NonNullable<ReturnType<typeof setOf>>; cameras: Map<string, string[]>; own: string[]; taken: Set<string> }>()
  const entry = (area: NonNullable<ReturnType<typeof setOf>>) => {
    let e = bySet.get(area.id)
    if (!e) bySet.set(area.id, e = { area, cameras: new Map(), own: [], taken: new Set() })
    return e
  }
  const alone = new Map<string, string[]>()
  for (const g of groups) {
    if (g.effect || g.pin || hidden.has(g.id)) continue
    const area = setOf(g.id)
    const camera = holdsCamera(g, boards)
    if (!area) {
      // A camera on its own, in no set: its own look only.
      if (camera) alone.set(g.id, effectChain(g.id, groups, boards))
      continue
    }
    const chain = effectChain(g.id, groups, boards)
    const e = entry(area)
    if (camera) e.cameras.set(g.id, chain)
    else if (g.id === area.areaCard) e.own.push(...chain)
    if (g.id !== area.areaCard) for (const id of chain) e.taken.add(id)
  }
  // The effect cards with a set and after no card: the set's, left to right.
  const loose = new Map<string, ProjectGroup[]>()
  for (const g of effects) {
    if (hidden.has(g.id)) continue
    const area = setOf(g.id)
    const e = area ? bySet.get(area.id) ?? entry(area) : null
    if (!e || e.taken.has(g.id) || e.own.includes(g.id)) continue
    loose.set(e.area.id, [...(loose.get(e.area.id) ?? []), g])
  }
  const lookOf = (ids: string[]): CameraLook | null => {
    const items = ids.map(id => byId.get(id)).filter((g): g is ProjectGroup => !!g?.effect).map(itemOf)
    // Off and solo as on any strip (utils/fx/chain), then what can run live.
    const src: ChainItem = { id: 'camera', kind: 'source', url: '', label: '' }
    const steps = planChain(effectiveItems([src, ...items])).steps.map(s => s.item).filter(it => live(it.effect))
    return steps.length ? { steps, sig: JSON.stringify(steps.map(s => [s.effect, effectParams(s.effect, s.params)])) } : null
  }
  for (const [camera, chain] of alone) of.set(camera, lookOf(chain))
  for (const [setId, e] of bySet) {
    const rest = (loose.get(setId) ?? []).sort((a, b) => a.originX - b.originX || a.originY - b.originY).map(g => g.id)
    const ofSet = [...e.own, ...rest]
    for (const [camera, chain] of e.cameras) of.set(camera, lookOf([...ofSet, ...chain]))
  }
  return of
}

/** The look camera `key` (`card:<id>`) sees through, or null for none. */
export function lookFor(key: string | null | undefined): CameraLook | null {
  if (!key?.startsWith('card:')) return null
  const bs = useBoardsStore.getState(), nodes = useFreeNodeStore.getState().nodes, zoom = useCanvasStore.getState().zoom
  if (!memo || memo.groups !== bs.groups || memo.boards !== bs.boards || memo.nodes !== nodes || memo.zoom !== zoom) {
    let of = new Map<string, CameraLook | null>()
    try { of = build() } catch (err) { console.warn('[cameraLook] reading the looks failed', err) }
    memo = { groups: bs.groups, boards: bs.boards, nodes, zoom, of }
  }
  return memo.of.get(key.slice(5)) ?? null
}

/** `src` through a look, as a new canvas at most `maxSide` on its long edge
 *  (the caller's to draw and let go of), or null when it cannot be drawn. */
export function runLook(src: HTMLCanvasElement, look: CameraLook, maxSide: number): HTMLCanvasElement | null {
  if (!src.width || !src.height) return null
  const e = fx()
  if (!e) return null
  let cur = null as ReturnType<typeof e.upload> | null
  try {
    cur = e.upload(src, maxSide)
    for (const s of look.steps) {
      const next = EFFECTS[s.effect].run(e, cur, effectParams(s.effect, s.params), null, {})
      if (next !== cur) e.release(cur)
      cur = next
    }
    return e.toCanvas(cur)
  } catch (err) {
    console.warn('[cameraLook] a look could not be drawn', err)
    return null
  } finally {
    e.release(cur)
  }
}
