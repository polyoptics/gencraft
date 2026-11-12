// pathRide.ts — models riding paths (Brian 2026-11-12: "visualize the
// models moving down one of those motion paths at the speed of the proper
// motion for each path ... start and end times on the animations per line
// ... so they would be in sync ... parent the models to the paths").
//
// A curve keeps its riders (store/notesStore Curve.riders): a model
// parented to it in the Outliner stands on the path in the 3D view, where
// the ride clock says. One clock for every path, so models on several
// stay in step; each path says when on that clock its riders set off and
// arrive. Nothing of the model's card moves: it is where the model is
// drawn in 3D that rides (components/Canvas/tilt/TiltModels).

import * as THREE from 'three'
import { create } from 'zustand'
import { useNotesStore, type Curve, type PathRider } from '../store/notesStore'
import { curveSamples, frameOf, type P3 } from './curveGeom'

// ── The clock ──

interface RideClock {
  playing: boolean
  /** The clock's time (seconds) when it was last set or started. */
  base: number
  /** performance.now() then. */
  stamp: number
  play: () => void
  pause: () => void
  seek: (t: number) => void
}
export const useRideClock = create<RideClock>(set => ({
  playing: false, base: 0, stamp: 0,
  play: () => set(s => s.playing ? s : { playing: true, stamp: performance.now() }),
  pause: () => set(s => s.playing ? { playing: false, base: rideTime() } : s),
  seek: t => set({ base: Math.max(0, t), stamp: performance.now() }),
}))
/** The ride clock now, seconds. */
export function rideTime(): number {
  const c = useRideClock.getState()
  return c.playing ? c.base + (performance.now() - c.stamp) / 1000 : c.base
}

// ── A path as a ride ──

interface RideLine { pts: P3[]; len: number }
const lines = new WeakMap<Curve, RideLine>()
/** The whole of a curve's line (not stopped short at its end shapes),
 *  each place with how far along it is and the twist there. */
function lineOf(c: Curve): RideLine {
  let l = lines.get(c)
  if (l) return l
  const n = c.pts.length
  let run = 0
  const raw = curveSamples(c, 32)
  const pts: P3[] = raw.map((q, i) => {
    if (i) run += Math.hypot(q.x - raw[i - 1].x, q.y - raw[i - 1].y, q.z - raw[i - 1].z)
    return { x: q.x, y: q.y, z: q.z, s: run, tw: (c.pts[q.seg]?.twist ?? 0) * (1 - q.t) + (c.pts[(q.seg + 1) % n]?.twist ?? 0) * q.t }
  })
  l = { pts, len: run }
  lines.set(c, l)
  return l
}
export const rideLength = (c: Curve) => lineOf(c).len

function placeAt(l: RideLine, dist: number): { p: P3; d: P3 } {
  const { pts } = l
  if (pts.length < 2) return { p: pts[0] ?? { x: 0, y: 0, z: 0 }, d: { x: 1, y: 0, z: 0 } }
  const s = Math.max(0, Math.min(l.len, dist))
  let lo = 0, hi = pts.length - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if ((pts[m].s ?? 0) <= s) lo = m; else hi = m }
  const a = pts[lo], b = pts[hi]
  const span = (b.s ?? 0) - (a.s ?? 0)
  const t = span > 1e-9 ? (s - (a.s ?? 0)) / span : 0
  const dl = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1
  return {
    p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, tw: (a.tw ?? 0) + ((b.tw ?? 0) - (a.tw ?? 0)) * t },
    d: { x: (b.x - a.x) / dl, y: (b.y - a.y) / dl, z: (b.z - a.z) / dl },
  }
}

/** How long a path's ride lasts, seconds, and when it sets off: from its
 *  start and end times, or at the speed of the line's own motion (four
 *  seconds for a line that has none). */
export function rideSpan(c: Curve): { start: number; dur: number; timed: boolean } {
  const start = Math.max(0, c.rideStart ?? 0)
  if (c.rideEnd !== undefined && c.rideEnd > start) return { start, dur: c.rideEnd - start, timed: true }
  const len = lineOf(c).len
  return { start, dur: c.flow ? Math.max(0.05, len / Math.abs(c.flow)) : 4, timed: false }
}

/** How far along its path (0..1) a rider is at `time`, and whether it is
 *  then going back towards the start. */
export function rideShare(c: Curve, r: PathRider, time: number): { u: number; back: boolean } {
  const { start, dur } = rideSpan(c)
  const closed = !!c.closed && c.pts.length > 2
  const after = c.rideAfter ?? 'loop'
  // The line's motion running towards its start: so do its riders.
  const rev = !!c.flow && c.flow < 0
  let x = Math.max(0, time - start) / dur
  let back = false
  if (after === 'stop') x = Math.min(1, x)
  else if (after === 'pingpong') { const k = x % 2; back = k > 1; x = back ? 2 - k : k }
  else x = x % 1
  if (c.rideEase) x = x * x * (3 - 2 * x)
  let u = x + (r.lead ?? 0)
  // Ahead of the rest, it goes round a loop (or a closed path); on a path
  // with ends it stops at the end.
  u = after === 'loop' || closed ? ((u % 1) + 1) % 1 : Math.min(1, Math.max(0, u))
  return rev ? { u: 1 - u, back: !back } : { u, back }
}

export interface RideSpot {
  /** Where its feet are, canvas units (z up). */
  x: number; y: number; z: number
  /** How it is turned there, as the 3D view's models are (x across, y up,
   *  z down the canvas), or null: as it stands. */
  q: [number, number, number, number] | null
}

const mB = new THREE.Matrix4(), qB = new THREE.Quaternion(), qH = new THREE.Quaternion()
const vX = new THREE.Vector3(), vU = new THREE.Vector3(), vD = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0)

/** Where a rider is on its path at `time`, and how it is turned. */
export function rideSpot(c: Curve, r: PathRider, time: number): RideSpot {
  const l = lineOf(c)
  const { u, back } = rideShare(c, r, time)
  const dist = u * l.len
  const at = placeAt(l, dist)
  let d = at.d
  if (r.slope === false) {
    const h = Math.hypot(d.x, d.y)
    if (h > 1e-4) d = { x: d.x / h, y: d.y / h, z: 0 }
  }
  let roll = r.twist === false ? 0 : at.p.tw ?? 0
  if (r.bank) {
    // Leaning into the turn: by how far the path swings round just here.
    const w = Math.max(l.len * 0.04, 1e-6)
    const a = placeAt(l, dist - w).d, b = placeAt(l, dist + w).d
    const turn = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) * 180 / Math.PI
    roll += Math.max(-80, Math.min(80, -turn * r.bank / 100))
  }
  const f = frameOf(d, roll)
  const lift = r.lift ?? 0, side = r.side ?? 0
  const spot: RideSpot = {
    x: at.p.x + f.up.x * lift + f.side.x * side,
    y: at.p.y + f.up.y * lift + f.side.y * side,
    z: at.p.z + f.up.z * lift + f.side.z * side,
    q: null,
  }
  if (r.aim === false) return spot
  // (The canvas's y and its up are the models' z and y.) Its front goes
  // the way it is going: back along the path on its way back.
  const sgn = back ? -1 : 1
  vD.set(f.d.x * sgn, f.d.z * sgn, f.d.y * sgn)
  vU.set(f.up.x, f.up.z, f.up.y)
  vX.crossVectors(vU, vD)
  qB.setFromRotationMatrix(mB.makeBasis(vX, vU, vD))
  if (r.heading) qB.multiply(qH.setFromAxisAngle(Y, r.heading * Math.PI / 180))
  spot.q = [qB.x, qB.y, qB.z, qB.w]
  return spot
}

// ── Who rides what ──

/** The path a model rides, and its settings there. */
export function riderOf(key: string, curves = useNotesStore.getState().curves): { curve: Curve; rider: PathRider } | null {
  for (const c of Object.values(curves)) {
    const rider = c.riders?.find(r => r.key === key)
    if (rider) return { curve: c, rider }
  }
  return null
}

let memo: { curves: unknown; time: number; map: Map<string, RideSpot> } | null = null
/** Every riding model's place now, by its key. */
export function rideSpots(): Map<string, RideSpot> {
  const curves = useNotesStore.getState().curves
  const time = rideTime()
  if (memo && memo.curves === curves && memo.time === time) return memo.map
  const map = new Map<string, RideSpot>()
  for (const c of Object.values(curves)) for (const r of c.riders ?? []) if (c.pts.length > 1) map.set(r.key, rideSpot(c, r, time))
  memo = { curves, time, map }
  return map
}

/** Something is riding and the clock runs: the 3D view keeps drawing. */
export const rideRuns = () => useRideClock.getState().playing && Object.values(useNotesStore.getState().curves).some(c => c.riders?.length)

/** How long the longest timed ride takes to its end, seconds (for the
 *  clock's slider). */
export function rideTotal(): number {
  let t = 0
  for (const c of Object.values(useNotesStore.getState().curves)) if (c.riders?.length) { const s = rideSpan(c); t = Math.max(t, s.start + s.dur) }
  return t
}

/** Parent a model to a path (off any other it rode), keeping its
 *  settings if it already rode this one. */
export function parentToPath(key: string, curveId: string) {
  const ns = useNotesStore.getState()
  const to = ns.curves[curveId]
  if (!to || to.kind !== 'bezier') return
  for (const c of Object.values(ns.curves)) if (c.id !== curveId && c.riders?.some(r => r.key === key)) ns.updateCurve(c.id, { riders: c.riders.filter(r => r.key !== key) })
  if (!to.riders?.some(r => r.key === key)) ns.updateCurve(curveId, { riders: [...(to.riders ?? []), { key }] })
}
/** Take a model off the path it rides. */
export function unparentFromPath(key: string) {
  const ns = useNotesStore.getState()
  for (const c of Object.values(ns.curves)) if (c.riders?.some(r => r.key === key)) ns.updateCurve(c.id, { riders: c.riders.filter(r => r.key !== key) })
}
/** Change a rider's settings. */
export function setRider(curveId: string, key: string, patch: Partial<PathRider>) {
  const ns = useNotesStore.getState()
  const c = ns.curves[curveId]
  if (!c?.riders) return
  ns.updateCurve(curveId, { riders: c.riders.map(r => r.key === key ? { ...r, ...patch } : r) })
}
