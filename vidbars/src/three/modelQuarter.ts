// modelQuarter.ts — a model squared up: turned by quarter turns and
// mirrored, for one that came in facing the wrong way or lying down (Brian
// 2026-11-18: "the characters are popping up on the cards, but they're
// faced the wrong way"). Kept with the model's file (tiltStore quarterOf,
// by its url), and put on every copy of it as it is handed out
// (modelCache.acquireModel), so it shows the same wherever the model
// does: on its card and its linked cards, in a deck, a 3D set, a Viewer,
// and in the pictures drawn of it (its poster on a flat card, its piece).
// Whoever holds a copy asks quarterStamp(url) to know it has changed, or
// listens with onQuarterChange.

import * as THREE from 'three'
import { useModelScaleStore, type ModelQuarter } from '../store/tiltStore'
import { computePosedBounds } from './orbitState'

export type { ModelQuarter }
/** One press: a quarter turn about upright (its front to the left or the
 *  right), tipped a quarter forward (its top towards you) or sideways
 *  (its top to the right), or mirrored left to right. */
export type QuarterStep = 'left' | 'right' | 'forward' | 'side' | 'mirror'
export const QUARTER_STEPS: readonly QuarterStep[] = ['left', 'right', 'forward', 'side', 'mirror']

type Quat = [number, number, number, number]
const H = Math.SQRT1_2
const STEP_Q: Record<Exclude<QuarterStep, 'mirror'>, Quat> = {
  left: [0, -H, 0, H],
  right: [0, H, 0, H],
  forward: [H, 0, 0, H],
  side: [0, 0, -H, H],
}
const mul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]
/** Quarter turns only ever land on these: kept exact, press after press. */
const SNAPS = [0, 0.5, H, 1]
const snap = (v: number) => { const a = Math.abs(v); let best = 0; for (const s of SNAPS) if (Math.abs(a - s) < Math.abs(a - best)) best = s; return v < 0 ? -best : best }

/** `now` after one more press. null: as it came. The press is made as the
 *  model stands now (to the left is the viewer's left, whatever was done
 *  to it before). */
export function stepQuarter(now: ModelQuarter | undefined | null, step: QuarterStep): ModelQuarter | null {
  const q0: Quat = now?.q ?? [0, 0, 0, 1]
  let mirror = !!now?.mirror
  let q: Quat
  if (step === 'mirror') { mirror = !mirror; q = [q0[0], -q0[1], -q0[2], q0[3]] }
  else q = mul(STEP_Q[step], q0)
  q = q.map(snap) as Quat
  if (q[3] < 0 || (q[3] === 0 && (q[0] < 0 || (q[0] === 0 && (q[1] < 0 || (q[1] === 0 && q[2] < 0)))))) q = q.map(v => -v || 0) as Quat
  if (q[3] === 1 && !mirror) return null
  return mirror ? { q, mirror: true } : { q }
}

/** A quarter read from outside (the agent, an old file): made exact, or
 *  null when it is not one. */
export function cleanQuarter(v: unknown): ModelQuarter | null {
  const o = v as { q?: unknown; mirror?: unknown } | null
  const q = Array.isArray(o?.q) && o!.q.length === 4 && o!.q.every(n => Number.isFinite(n)) ? (o!.q as number[]).map(snap) as Quat : null
  if (!q || Math.abs(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] - 1) > 1e-6) return null
  if (Math.abs(q[3]) === 1 && !o!.mirror) return null
  return o!.mirror ? { q, mirror: true } : { q }
}

/** How model `url` is squared up, if it is. A shape made here (a cube, a
 *  camera) never is: every card of one shares it. */
export const quarterable = (url: string | null | undefined): url is string => !!url && !url.startsWith('prim:')
export function quarterOfUrl(url: string): ModelQuarter | undefined {
  return quarterable(url) ? useModelScaleStore.getState().quarterOf[url] : undefined
}

const stamps = new Map<string, number>()
/** Goes up each time model `url` is squared up another way: a copy made
 *  under another stamp is out of date. */
export const quarterStamp = (url: string): number => stamps.get(url) ?? 0

const listeners = new Set<(url: string, fresh: boolean) => void>()
/** Told each model whose squaring up has changed. `fresh`: changed just
 *  now, by hand; not: read back as it was kept (pictures drawn of it
 *  before are still right). */
export function onQuarterChange(fn: (url: string, fresh: boolean) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
useModelScaleStore.subscribe((s, p) => {
  if (s.quarterOf === p.quarterOf) return
  for (const url of new Set([...Object.keys(s.quarterOf), ...Object.keys(p.quarterOf)])) {
    const a = s.quarterOf[url], b = p.quarterOf[url]
    if (a === b || (a && b && !!a.mirror === !!b.mirror && a.q.every((v, i) => v === b.q[i]))) continue
    stamps.set(url, quarterStamp(url) + 1)
    const fresh = useModelScaleStore.persist?.hasHydrated?.() ?? true
    for (const fn of listeners) { try { fn(url, fresh) } catch (e) { console.warn('[modelQuarter]', e) } }
  }
})

/** The model itself inside a copy handed out by acquireModel: what is
 *  marked on its surface (notes, pins) is kept in ITS space, so it stays
 *  on the model however it is squared up. */
export const modelBody = (inst: THREE.Object3D): THREE.Object3D => (inst.userData.quarterBody as THREE.Object3D | undefined) ?? inst

/** What the model measures as it came, by url: found once. */
const boxes = new Map<string, THREE.Box3>()

/** A fresh copy `inst` of model `url`, squared up: wrapped so the holder
 *  can still place, turn and size what it is given. The middle of its
 *  floor stays where it was (a model with its feet on the ground still
 *  has them there, tipped over). Stamped either way. */
export function squareUp(url: string, inst: THREE.Object3D): THREE.Object3D {
  const stamp = quarterStamp(url)
  const qt = quarterOfUrl(url)
  if (!qt) { inst.userData.quarterStamp = stamp; return inst }
  let box = boxes.get(url)
  if (!box) { box = computePosedBounds(inst); boxes.set(url, box) }
  const wrap = new THREE.Group(), turned = new THREE.Group()
  turned.quaternion.set(qt.q[0], qt.q[1], qt.q[2], qt.q[3])
  if (qt.mirror) turned.scale.x = -1
  if (!box.isEmpty()) {
    turned.updateMatrix()
    const b = box.clone().applyMatrix4(turned.matrix)
    turned.position.set((box.min.x + box.max.x - b.min.x - b.max.x) / 2, box.min.y - b.min.y, (box.min.z + box.max.z - b.min.z - b.max.z) / 2)
  }
  turned.add(inst)
  wrap.add(turned)
  wrap.animations = inst.animations
  wrap.userData.quarterBody = inst
  wrap.userData.quarterStamp = stamp
  return wrap
}
