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
/** Now, as the frame being drawn has it (ms): one time for everything
 *  drawn in a frame, a frame apart from the last (Brian 2026-11-13: "the
 *  motion's really jittery"). The time a piece of code happens to run at
 *  within its frame comes early or late by a few milliseconds from one
 *  frame to the next, and what goes by it steps unevenly along its path:
 *  the faster it goes, the more it shows. */
const frameNow = (): number => {
  const t = typeof document !== 'undefined' ? document.timeline?.currentTime : null
  return typeof t === 'number' ? t : performance.now()
}
export const useRideClock = create<RideClock>(set => ({
  playing: false, base: 0, stamp: 0,
  play: () => set(s => s.playing ? s : { playing: true, stamp: frameNow() }),
  pause: () => set(s => s.playing ? { playing: false, base: rideTime() } : s),
  seek: t => set({ base: Math.max(0, t), stamp: frameNow() }),
}))
/** The ride clock now, seconds. */
export function rideTime(): number {
  const c = useRideClock.getState()
  return c.playing ? Math.max(0, c.base + (frameNow() - c.stamp) / 1000) : c.base
}

// ── A path as a ride ──

interface RideLine { pts: P3[]; len: number; closed: boolean; /** How far along each of the curve's points is. */ at: number[] }
const lines = new WeakMap<Curve, RideLine>()
/** The whole of a curve's line (not stopped short at its end shapes),
 *  each place with how far along it is and the twist there. */
function lineOf(c: Curve): RideLine {
  let l = lines.get(c)
  if (l) return l
  const n = c.pts.length
  let run = 0
  // In pieces short enough that what rides it does not show them: a long
  // stretch between two points in as many more.
  let far = 0
  for (let i = 0; i + 1 < n || (i < n && !!c.closed && n > 2); i++) {
    const a = c.pts[i], b = c.pts[(i + 1) % n]
    far = Math.max(far, Math.hypot(b.x - a.x, b.y - a.y, (b.z ?? 0) - (a.z ?? 0)))
  }
  const raw = curveSamples(c, Math.max(32, Math.min(400, Math.ceil(far * 1.5 / PIECE))))
  const at: number[] = new Array(n).fill(0)
  const pts: P3[] = raw.map((q, i) => {
    if (i) run += Math.hypot(q.x - raw[i - 1].x, q.y - raw[i - 1].y, q.z - raw[i - 1].z)
    if (q.t === 1 && q.seg + 1 < n) at[q.seg + 1] = run
    return { x: q.x, y: q.y, z: q.z, s: run, tw: (c.pts[q.seg]?.twist ?? 0) * (1 - q.t) + (c.pts[(q.seg + 1) % n]?.twist ?? 0) * q.t }
  })
  l = { pts, len: run, at, closed: !!c.closed && n > 2 && run > 0 }
  lines.set(c, l)
  return l
}
export const rideLength = (c: Curve) => lineOf(c).len

/** How long the pieces a ride's line is read in are, about (canvas
 *  units), and how far either side of a rider the line's way is read
 *  across, at most (`AIM`), and its swing for a lean (`LEAN`). A share of
 *  the path's length on a short one, as it was; a long path's riders were
 *  read across a longer stretch the longer the path, so they pointed
 *  across its bends, not along them, and leant the more for the same bend
 *  (Brian 2026-11-13: "some follow better than others"). */
const PIECE = 5, AIM = 40, LEAN = 60

/** The place `dist` along the line. */
function pointAt(l: RideLine, dist: number): P3 {
  const { pts } = l
  const s = Math.max(0, Math.min(l.len, dist))
  let lo = 0, hi = pts.length - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if ((pts[m].s ?? 0) <= s) lo = m; else hi = m }
  const a = pts[lo], b = pts[hi]
  const span = (b.s ?? 0) - (a.s ?? 0)
  const t = span > 1e-9 ? (s - (a.s ?? 0)) / span : 0
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, tw: (a.tw ?? 0) + ((b.tw ?? 0) - (a.tw ?? 0)) * t }
}
/** The place `dist` along the line and which way the line runs there.
 *  The way is taken across a short stretch either side (Brian
 *  2026-11-13: "weird, jittery, tilty motion"): the line is drawn as
 *  short straight pieces, and read piece by piece what rides it turns in
 *  steps and snaps round a corner; read across a stretch it turns
 *  evenly, and rounds a corner over that stretch. */
function placeAt(l: RideLine, dist: number): { p: P3; d: P3 } {
  if (l.pts.length < 2) return { p: l.pts[0] ?? { x: 0, y: 0, z: 0 }, d: { x: 1, y: 0, z: 0 } }
  const wrap = (x: number) => l.closed ? ((x % l.len) + l.len) % l.len : x
  dist = l.closed ? wrap(dist) : Math.max(0, Math.min(l.len, dist))
  const p = pointAt(l, dist)
  const w = Math.min(l.len * 0.05, AIM)
  let dx = 0, dy = 0, dz = 0
  // Several reaches together: no one piece's end tells.
  for (let k = 1; k <= 4; k++) {
    const a = pointAt(l, wrap(dist - w * k / 4)), b = pointAt(l, wrap(dist + w * k / 4))
    dx += b.x - a.x; dy += b.y - a.y; dz += b.z - a.z
  }
  const n = Math.hypot(dx, dy, dz)
  return { p, d: n > 1e-9 ? { x: dx / n, y: dy / n, z: dz / n } : { x: 1, y: 0, z: 0 } }
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

const smooth = (t: number) => t * t * (3 - 2 * t)
const unsmooth = (y: number) => 0.5 - Math.sin(Math.asin(1 - 2 * Math.max(0, Math.min(1, y))) / 3)

/** The shares of the path (0..1) its points stand at, the two ends of an
 *  open path among them, and whether what rides slows at each. */
function knots(c: Curve, l: RideLine): { u: number; slow: boolean }[] {
  const k = c.pts.map((p, i) => ({ u: l.len > 0 ? l.at[i] / l.len : 0, slow: !!p.slow }))
  if (c.closed && c.pts.length > 2) k.push({ u: 1, slow: !!c.pts[0].slow })
  return k
}
/** Between two points: slowing into or out of the ones that ask for it.
 *  `back`: the other way, from how far to when. */
function between(t: number, a: boolean, b: boolean, back = false): number {
  if (a && b) return back ? unsmooth(t) : smooth(t)
  if (a) return back ? Math.sqrt(t) : t * t
  if (b) return back ? 1 - Math.sqrt(1 - t) : 1 - (1 - t) * (1 - t)
  return t
}
/** The steady share `y` of the way (0..1) as the share of the path it has
 *  reached, slowing at the points that ask for it; `back`, the reverse. */
function paced(c: Curve, l: RideLine, y: number, back = false): number {
  const k = knots(c, l)
  if (!k.some(x => x.slow)) return y
  for (let i = 0; i + 1 < k.length; i++) {
    const a = k[i], b = k[i + 1], d = b.u - a.u
    if (y <= b.u || i + 2 === k.length) return d > 1e-9 ? a.u + d * between(Math.max(0, Math.min(1, (y - a.u) / d)), a.slow, b.slow, back) : a.u
  }
  return y
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
  if (c.rideEase) x = smooth(x)
  x = paced(c, lineOf(c), x)
  let u = x + (r.lead ?? 0)
  // Ahead of the rest, it goes round a loop (or a closed path); on a path
  // with ends it stops at the end.
  u = after === 'loop' || closed ? ((u % 1) + 1) % 1 : Math.min(1, Math.max(0, u))
  return rev ? { u: 1 - u, back: !back } : { u, back }
}

/** When on the clock (its first time along) a rider is at point `i` of
 *  its path. */
export function ridePointTime(c: Curve, r: PathRider, i: number): number {
  const l = lineOf(c)
  const { start, dur } = rideSpan(c)
  const rev = !!c.flow && c.flow < 0
  const share = l.len > 0 ? l.at[Math.max(0, Math.min(c.pts.length - 1, i))] / l.len : 0
  let u = (rev ? 1 - share : share) - (r.lead ?? 0)
  if (u < 0) u = (c.rideAfter ?? 'loop') === 'loop' || (!!c.closed && c.pts.length > 2) ? u + 1 : 0
  let x = paced(c, l, u, true)
  if (c.rideEase) x = unsmooth(x)
  return start + dur * x
}
/** The point of its path a rider is nearest in time, and whether it is
 *  on it. */
export function ridePointNow(c: Curve, r: PathRider, time = rideTime()): { i: number; on: boolean } {
  let best = 0, d = Infinity
  c.pts.forEach((_, i) => { const x = Math.abs(ridePointTime(c, r, i) - time); if (x < d) { d = x; best = i } })
  return { i: best, on: d < 2e-3 }
}

export interface RideSpot {
  /** Where its feet are, canvas units (z up). */
  x: number; y: number; z: number
  /** How it is turned there, as the 3D view's models are (x across, y up,
   *  z down the canvas), or null: as it stands. */
  q: [number, number, number, number] | null
  /** The middle of its box is what is there, not its feet (PathRider.centre). */
  mid?: boolean
}

const mB = new THREE.Matrix4(), qB = new THREE.Quaternion(), qH = new THREE.Quaternion()
const vX = new THREE.Vector3(), vU = new THREE.Vector3(), vD = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0)

/** A rider `dist` along its path as the path alone has it: where, and
 *  how turned (into `q`; false when it does not aim along the path). */
function pathSpot(l: RideLine, r: PathRider, dist: number, back: boolean, q: THREE.Quaternion): { x: number; y: number; z: number; aimed: boolean } {
  const at = placeAt(l, dist)
  let d = at.d
  if (r.slope === false) {
    const h = Math.hypot(d.x, d.y)
    if (h > 1e-4) d = { x: d.x / h, y: d.y / h, z: 0 }
  }
  let roll = r.twist === false ? 0 : at.p.tw ?? 0
  if (r.bank) {
    // Leaning into the turn: by how far the path swings round just here.
    const w = Math.max(Math.min(l.len * 0.04, LEAN), 1e-6)
    const a = placeAt(l, dist - w).d, b = placeAt(l, dist + w).d
    const turn = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) * 180 / Math.PI
    roll += Math.max(-80, Math.min(80, -turn * r.bank / 100))
  }
  const f = frameOf(d, roll)
  const lift = r.lift ?? 0, side = r.side ?? 0
  const spot = {
    x: at.p.x + f.up.x * lift + f.side.x * side,
    y: at.p.y + f.up.y * lift + f.side.y * side,
    z: at.p.z + f.up.z * lift + f.side.z * side,
    aimed: r.aim !== false,
  }
  if (!spot.aimed) { q.identity(); return spot }
  // (The canvas's y and its up are the models' z and y.) Its front goes
  // the way it is going: back along the path on its way back.
  const sgn = back ? -1 : 1
  vD.set(f.d.x * sgn, f.d.z * sgn, f.d.y * sgn)
  vU.set(f.up.x, f.up.z, f.up.y)
  vX.crossVectors(vU, vD)
  q.setFromRotationMatrix(mB.makeBasis(vX, vU, vD))
  if (r.heading) q.multiply(qH.setFromAxisAngle(Y, r.heading * Math.PI / 180))
  return spot
}

const qA = new THREE.Quaternion(), qK = new THREE.Quaternion(), oA = new THREE.Quaternion(), oB = new THREE.Quaternion()
/** How far a rider's own turn at point `i` (its key there) is from the
 *  path's, into `o`: nothing where it has none. */
function keyOff(l: RideLine, r: PathRider, i: number, back: boolean, o: THREE.Quaternion) {
  const k = r.keys?.[i]
  if (!k) { o.identity(); return }
  pathSpot(l, r, l.at[i] ?? 0, back, qA)
  o.copy(qA).invert().multiply(qK.set(k[0], k[1], k[2], k[3]))
}

/** Where a rider is on its path at `time`, and how it is turned. */
export function rideSpot(c: Curve, r: PathRider, time: number): RideSpot {
  const l = lineOf(c)
  const { u, back } = rideShare(c, r, time)
  const dist = u * l.len
  const s = pathSpot(l, r, dist, back, qB)
  const spot: RideSpot = { x: s.x, y: s.y, z: s.z, q: null, mid: !!r.centre }
  const keyed = !!r.keys && Object.keys(r.keys).length > 0
  if (!s.aimed && !keyed) return spot
  if (keyed) {
    // Its own turn at the points either side of it, blended by how far
    // between them it is.
    const n = c.pts.length, closed = !!c.closed && n > 2
    let i = 0
    while (i + 1 < n && l.at[i + 1] <= dist) i++
    const j = i + 1 < n ? i + 1 : closed ? 0 : i
    const a = l.at[i], b = j === 0 && closed ? l.len : l.at[j]
    keyOff(l, r, i, back, oA)
    keyOff(l, r, j, back, oB)
    qB.multiply(oA.slerp(oB, b - a > 1e-9 ? Math.max(0, Math.min(1, (dist - a) / (b - a))) : 0))
  }
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

/** A rider's own turn at point `i` of its path (null: as the path has it). */
export function setRiderKey(curveId: string, key: string, i: number, q: [number, number, number, number] | null) {
  const ns = useNotesStore.getState()
  const c = ns.curves[curveId]
  const r = c?.riders?.find(x => x.key === key)
  if (!c || !r) return
  const keys = { ...r.keys }
  if (q) keys[i] = q; else delete keys[i]
  setRider(curveId, key, { keys: Object.keys(keys).length ? keys : undefined })
}
