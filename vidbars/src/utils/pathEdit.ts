// pathEdit.ts — working on the points of a curve (store/notesStore; Brian
// 2026-11-12: a placeable, movable path whose points are selected,
// deleted, added, lifted, turned and sized). Points are selected by key
// (`${curve id}:${index}`, useNotesUi.points). With none selected, what
// acts on points acts on every point of the selected curves: the whole
// curve. The mouse is utils/notesTool, the 3D manipulator on them
// utils/area3dHandles; both go through here, flat and in 3D alike.

import { useNotesStore, useNotesUi, type Curve, type CurvePoint, type CurveHandle } from '../store/notesStore'
import { curvePoints, splitCurveAt } from './curveGeom'

export const ptKey = (id: string, i: number) => `${id}:${i}`
export function parsePt(k: string): { id: string; i: number } {
  const at = k.lastIndexOf(':')
  return { id: k.slice(0, at), i: +k.slice(at + 1) }
}

/** The selected points, by curve (only what is still there). */
export function pickedPoints(): Map<string, number[]> {
  const { curves } = useNotesStore.getState()
  const m = new Map<string, number[]>()
  for (const k of useNotesUi.getState().points) {
    const { id, i } = parsePt(k)
    const c = curves[id]
    if (!c || !(i >= 0 && i < c.pts.length)) continue
    m.set(id, [...(m.get(id) ?? []), i])
  }
  return m
}

/** What a move, turn or size acts on: the selected points, or with none
 *  selected every point of the selected curves. */
export function targetPoints(): Map<string, number[]> {
  const picked = pickedPoints()
  if (picked.size) return picked
  const { curves } = useNotesStore.getState()
  const m = new Map<string, number[]>()
  for (const id of useNotesUi.getState().selected) {
    const c = curves[id]
    if (c) m.set(id, c.pts.map((_, i) => i))
  }
  return m
}

/** The middle of those points (canvas units, z up): where the manipulator
 *  sits, and what a turn or a size is about. */
export function targetMiddle(t = targetPoints()): { x: number; y: number; z: number } | null {
  const { curves } = useNotesStore.getState()
  let x = 0, y = 0, z = 0, n = 0
  for (const [id, idx] of t) for (const i of idx) {
    const p = curves[id]?.pts[i]
    if (!p) continue
    x += p.x; y += p.y; z += p.z ?? 0; n++
  }
  return n ? { x: x / n, y: y / n, z: z / n } : null
}

/** Select a point: alone, or (`add`) added to or taken from the others.
 *  Its curve is selected with it. */
export function selectPoint(id: string, i: number, add: boolean) {
  const ui = useNotesUi.getState()
  const k = ptKey(id, i)
  const points = add ? (ui.points.includes(k) ? ui.points.filter(x => x !== k) : [...ui.points, k]) : [k]
  const selected = ui.selected.includes(id) ? ui.selected : add ? [...ui.selected, id] : [id]
  useNotesUi.setState({ points, selected })
}

/** Every point of a curve. */
export function selectAllPoints(id: string) {
  const c = useNotesStore.getState().curves[id]
  if (!c) return
  const ui = useNotesUi.getState()
  useNotesUi.setState({ points: c.pts.map((_, i) => ptKey(id, i)), selected: ui.selected.includes(id) ? ui.selected : [id] })
}

/** Delete the selected points. A curve left with fewer than two goes
 *  with them. False when no point was selected. */
export function deletePickedPoints(): boolean {
  const picked = pickedPoints()
  if (!picked.size) return false
  const ns = useNotesStore.getState()
  const gone: string[] = []
  for (const [id, idx] of picked) {
    const c = ns.curves[id]
    const pts = c.pts.filter((_, i) => !idx.includes(i))
    if (pts.length < 2) gone.push(id)
    else ns.updateCurve(id, { pts, closed: c.closed && pts.length > 2 })
  }
  if (gone.length) ns.deleteCurves(gone)
  useNotesUi.setState(u => ({ points: [], selected: u.selected.filter(id => !gone.includes(id)) }))
  return true
}

/** A new point on a curve's line, at share `t` of the segment leaving
 *  point `seg`; the line keeps its shape. The new point is selected. */
export function insertPoint(id: string, seg: number, t: number): number | null {
  const ns = useNotesStore.getState()
  const c = ns.curves[id]
  const r = c && splitCurveAt(c, seg, Math.max(0.02, Math.min(0.98, t)))
  if (!r) return null
  ns.updateCurve(id, { pts: r.pts })
  useNotesUi.setState(u => ({ points: [ptKey(id, r.index)], selected: u.selected.includes(id) ? u.selected : [id] }))
  return r.index
}

const hasH = (h: CurveHandle | undefined) => !!h && (Math.abs(h.x) > 1e-6 || Math.abs(h.y) > 1e-6 || Math.abs(h.z ?? 0) > 1e-6)
const hz = (h: CurveHandle | undefined) => h?.z ?? 0
const len = (h: CurveHandle) => Math.hypot(h.x, h.y, hz(h))
const mk = (x: number, y: number, z: number): CurveHandle => z ? { x, y, z } : { x, y }

/** How the selected points' tangents stand: all broken, all corners (a
 *  point without handles on a curve set by hand is a corner too). */
export function tangentState(): { any: boolean; broken: boolean; corner: boolean } {
  const picked = pickedPoints()
  const { curves } = useNotesStore.getState()
  let any = false, broken = true, corner = true
  for (const [id, idx] of picked) {
    const c = curves[id]
    if (c.kind !== 'bezier') continue
    for (const i of idx) {
      const p = c.pts[i]
      any = true
      if (p.t !== 'broken') broken = false
      if (!(p.t === 'corner' || (!c.smooth && p.t !== 'broken' && !hasH(p.hin) && !hasH(p.hout)))) corner = false
    }
  }
  return { any, broken: any && broken, corner: any && corner }
}

/** The handles a point runs on now, found for it where it has none of
 *  its own (a smooth curve's, or a corner's on a curve set by hand). */
function handlesNow(c: Curve, i: number): { hin: CurveHandle; hout: CurveHandle } {
  const as = (smooth: boolean) => curvePoints({ ...c, smooth, pts: c.pts.map((p, k) => k === i ? { ...p, t: undefined, hin: undefined, hout: undefined } : p) })[i]
  const p = c.pts[i]
  // Its own, if it has them; else what a smooth line through it would use.
  const own = p.t !== 'corner' && (!c.smooth || p.t === 'broken') && (hasH(p.hin) || hasH(p.hout))
  const e = own ? p : c.smooth && p.t !== 'corner' && p.t !== 'broken' ? curvePoints(c)[i] : as(true)
  return { hin: e.hin ?? { x: 0, y: 0 }, hout: e.hout ?? { x: 0, y: 0 } }
}

/** Break the selected points' tangents (each handle its own, for a sharp
 *  turn with bent sides) or join them again (one line through the point:
 *  the incoming handle turns to face the outgoing one, keeping its length). */
export function setBroken(on: boolean) {
  const ns = useNotesStore.getState()
  for (const [id, idx] of pickedPoints()) {
    const c = ns.curves[id]
    if (c.kind !== 'bezier') continue
    const pts = c.pts.slice()
    for (const i of idx) {
      const p = pts[i]
      if (on) {
        if (p.t === 'broken') continue
        pts[i] = { ...p, ...handlesNow(c, i), t: 'broken' }
      } else {
        if (p.t !== 'broken') continue
        const q: CurvePoint = { ...p, t: undefined }
        delete q.t
        const o = q.hout, n = q.hin
        if (o && hasH(o)) {
          const l = n && hasH(n) ? len(n) : len(o), k = l / len(o)
          q.hin = mk(-o.x * k, -o.y * k, -hz(o) * k)
        } else if (n && hasH(n)) q.hout = mk(-n.x, -n.y, -hz(n))
        pts[i] = q
      }
    }
    ns.updateCurve(id, { pts })
  }
}

/** Make the selected points sharp corners (no handles), or give them
 *  their handles back (found as a smooth line through them would). */
export function setCorner(on: boolean) {
  const ns = useNotesStore.getState()
  for (const [id, idx] of pickedPoints()) {
    const c = ns.curves[id]
    if (c.kind !== 'bezier') continue
    const pts = c.pts.slice()
    for (const i of idx) {
      const p = pts[i]
      if (on) {
        const q: CurvePoint = { ...p, t: 'corner' }
        delete q.hin; delete q.hout
        pts[i] = q
      } else {
        const q: CurvePoint = { ...p }
        delete q.t
        // On a curve set by hand it needs handles of its own again.
        if (!c.smooth) Object.assign(q, handlesNow({ ...c, pts: pts.map((x, k) => k === i ? q : x) }, i))
        pts[i] = q
      }
    }
    ns.updateCurve(id, { pts })
  }
}

// ── Moving, turning and sizing points (the 3D manipulator, a drag) ──

/** The points as they were when a drag began. */
export interface PointsHeld {
  pts: Map<string, { i: number; p: CurvePoint }[]>
  mid: { x: number; y: number; z: number }
  /** The lowest of them: what a size keeps where it is, so a curve
   *  standing on the canvas grows up off it, not down through it. */
  low: number
}

export function holdPoints(t = targetPoints()): PointsHeld | null {
  const { curves } = useNotesStore.getState()
  const pts = new Map<string, { i: number; p: CurvePoint }[]>()
  for (const [id, idx] of t) {
    const c = curves[id]
    if (c) pts.set(id, idx.filter(i => c.pts[i]).map(i => ({ i, p: c.pts[i] })))
  }
  const mid = targetMiddle(t)
  let low = Infinity
  for (const list of pts.values()) for (const { p } of list) low = Math.min(low, p.z ?? 0)
  return mid ? { pts, mid, low } : null
}

/** Write the held points back, each changed by `f`. */
function writeHeld(h: PointsHeld, f: (p: CurvePoint) => CurvePoint) {
  const ns = useNotesStore.getState()
  for (const [id, list] of h.pts) {
    const c = ns.curves[id]
    if (!c) continue
    const pts = c.pts.slice()
    for (const { i, p } of list) if (pts[i]) pts[i] = f(p)
    ns.updateCurve(id, { pts })
  }
}
const withZ = (p: CurvePoint, z: number): CurvePoint => {
  const q = { ...p }
  if (Math.abs(z) > 1e-6) q.z = z; else delete q.z
  return q
}

/** Moved by (dx, dy) across the canvas and dz up, from where they were. */
export function moveHeld(h: PointsHeld, dx: number, dy: number, dz: number) {
  writeHeld(h, p => withZ({ ...p, x: p.x + dx, y: p.y + dy }, (p.z ?? 0) + dz))
}

/** Each place and handle carried by `m` (a 3×3, rows) about the middle. */
function mapHeld(h: PointsHeld, m: number[][], c = h.mid) {
  const ap = (x: number, y: number, z: number) => ({
    x: m[0][0] * x + m[0][1] * y + m[0][2] * z,
    y: m[1][0] * x + m[1][1] * y + m[1][2] * z,
    z: m[2][0] * x + m[2][1] * y + m[2][2] * z,
  })
  writeHeld(h, p => {
    const d = ap(p.x - c.x, p.y - c.y, (p.z ?? 0) - c.z)
    const q = withZ({ ...p, x: c.x + d.x, y: c.y + d.y }, c.z + d.z)
    for (const side of ['hin', 'hout'] as const) {
      const hd = p[side]
      if (!hd) continue
      const v = ap(hd.x, hd.y, hz(hd))
      q[side] = mk(v.x, v.y, v.z)
    }
    return q
  })
}

/** Turned by `angle` (radians) about `axis` (a unit vector: x across the
 *  canvas, y down it, z up) through their middle. One point alone turns
 *  its handles: the way the line runs through it. */
export function turnHeld(h: PointsHeld, axis: [number, number, number], angle: number) {
  const [x, y, z] = axis, c = Math.cos(angle), s = Math.sin(angle), k = 1 - c
  mapHeld(h, [
    [c + x * x * k, x * y * k - z * s, x * z * k + y * s],
    [y * x * k + z * s, c + y * y * k, y * z * k - x * s],
    [z * x * k - y * s, z * y * k + x * s, c + z * z * k],
  ])
}

/** Sized by (sx, sy, sz) about their middle across the canvas and their
 *  lowest point's height. One point alone sizes its handles: how far the
 *  line leans on it. */
export function sizeHeld(h: PointsHeld, sx: number, sy: number, sz: number) {
  mapHeld(h, [[sx, 0, 0], [0, sy, 0], [0, 0, sz]], { x: h.mid.x, y: h.mid.y, z: h.low })
}
