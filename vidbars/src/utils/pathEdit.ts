// pathEdit.ts — working on the points of a curve (store/notesStore; Brian
// 2026-11-12: a placeable, movable path whose points are selected,
// deleted, added, lifted, turned and sized). Points are selected by key
// (`${curve id}:${index}`, useNotesUi.points). With none selected, what
// acts on points acts on every point of the selected curves: the whole
// curve. The mouse is utils/notesTool, the 3D manipulator on them
// utils/area3dHandles; both go through here, flat and in 3D alike.

import { useNotesStore, useNotesUi, type Curve, type CurvePoint, type CurveHandle } from '../store/notesStore'
import { curvePoints, splitCurveAt, endOf, patternOf, pointFrames, type P3 } from './curveGeom'

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

/** How a point's tangents behave:
 *   - auto: on a Smooth curve, the line finds its handles itself;
 *   - unified: its handles are set by hand and stay in one line;
 *   - broken: each handle is its own;
 *   - corner: no handles, the line turns sharply. */
export type TangentMode = 'auto' | 'unified' | 'broken' | 'corner'

export function modeOf(c: Pick<Curve, 'smooth'>, p: CurvePoint): TangentMode {
  if (p.t === 'corner') return 'corner'
  if (p.t === 'broken') return 'broken'
  if (c.smooth) return p.t === 'unified' ? 'unified' : 'auto'
  // Set by hand: a point without handles is a corner.
  return hasH(p.hin) || hasH(p.hout) ? 'unified' : 'corner'
}

/** How the selected points' tangents stand: all broken, all corners. */
export function tangentState(): { any: boolean; broken: boolean; corner: boolean } {
  const picked = pickedPoints()
  const { curves } = useNotesStore.getState()
  let any = false, broken = true, corner = true
  for (const [id, idx] of picked) {
    const c = curves[id]
    if (c.kind !== 'bezier') continue
    for (const i of idx) {
      const m = modeOf(c, c.pts[i])
      any = true
      if (m !== 'broken') broken = false
      if (m !== 'corner') corner = false
    }
  }
  return { any, broken: any && broken, corner: any && corner }
}

/** The handles a point runs on now, found for it where it has none of
 *  its own (a smooth curve's, or a corner's on a curve set by hand). */
function handlesNow(c: Curve, i: number): { hin?: CurveHandle; hout?: CurveHandle } {
  const p = c.pts[i]
  const m = modeOf(c, p)
  const e = m === 'unified' || m === 'broken' ? p
    : m === 'auto' ? curvePoints(c)[i]
    // A corner: what a smooth line through it would use.
    : curvePoints({ ...c, smooth: true, pts: c.pts.map((x, k) => k === i ? { x: x.x, y: x.y, z: x.z } : x) })[i]
  const r: { hin?: CurveHandle; hout?: CurveHandle } = {}
  if (hasH(e.hin)) r.hin = e.hin
  if (hasH(e.hout)) r.hout = e.hout
  return r
}

/** `p` with handles `h`, in one line: the incoming handle turned to face
 *  the outgoing one, keeping its length. */
function inLine(p: CurvePoint, h: { hin?: CurveHandle; hout?: CurveHandle }): CurvePoint {
  const q: CurvePoint = { ...p }
  delete q.hin; delete q.hout
  const o = h.hout, n = h.hin
  if (o && n) {
    const k = len(n) / len(o)
    q.hout = o
    q.hin = mk(-o.x * k, -o.y * k, -hz(o) * k)
  } else if (o) q.hout = o
  else if (n) q.hin = n
  return q
}

/** Set how the selected points' tangents behave (or just the points
 *  given). The line keeps its shape where the new mode allows. */
export function setTangentMode(mode: TangentMode, picked = pickedPoints()) {
  const ns = useNotesStore.getState()
  for (const [id, idx] of picked) {
    const c = ns.curves[id]
    if (!c || c.kind !== 'bezier') continue
    const pts = c.pts.slice()
    for (const i of idx) {
      const p = pts[i]
      if (!p || modeOf(c, p) === mode) continue
      const h = handlesNow(c, i)
      let q: CurvePoint
      if (mode === 'corner') {
        q = { ...p, t: 'corner' }
        delete q.hin; delete q.hout
      } else if (mode === 'broken') {
        q = { ...p, t: 'broken' }
        delete q.hin; delete q.hout
        Object.assign(q, h)
      } else if (mode === 'unified' || !c.smooth) {
        // (Auto on a curve set by hand: smooth handles of its own.)
        q = inLine(p, mode === 'auto' ? handlesNow({ ...c, pts: c.pts.map((x, k) => k === i ? { ...x, t: 'corner' as const } : x) }, i) : h)
        if (c.smooth) q.t = 'unified'; else delete q.t
      } else {
        q = { ...p }
        delete q.t; delete q.hin; delete q.hout
      }
      pts[i] = q
    }
    ns.updateCurve(id, { pts })
  }
}

/** Break the selected points' tangents (each handle its own, for a sharp
 *  turn with bent sides) or join them again (one line through the point). */
export function setBroken(on: boolean) { setTangentMode(on ? 'broken' : 'unified') }

/** Make the selected points sharp corners (no handles), or give them
 *  their handles back (found as a smooth line through them would). */
export function setCorner(on: boolean) { setTangentMode(on ? 'corner' : 'auto') }

// ── Moving, turning and sizing points (the 3D manipulator, a drag) ──

/** The points as they were when a drag began. */
export interface PointsHeld {
  pts: Map<string, { i: number; p: CurvePoint }[]>
  mid: { x: number; y: number; z: number }
  /** The lowest of them: what a size keeps where it is, so a curve
   *  standing on the canvas grows up off it, not down through it. */
  low: number
  /** One point alone, held with handles of its own (Brian 2026-11-12: "if
   *  I'm rotating a point that point has tangents, so it should change the
   *  shape of the curve"): a turn or a size acts on these, so on a Smooth
   *  curve the point takes its tangent into its own hands. */
  solo?: CurvePoint
  /** Which way the path runs at each held point: a turn about that rolls
   *  the path there (its twist). */
  dirs: Map<CurvePoint, P3>
}

export function holdPoints(t = targetPoints()): PointsHeld | null {
  const { curves } = useNotesStore.getState()
  const pts = new Map<string, { i: number; p: CurvePoint }[]>()
  const dirs = new Map<CurvePoint, P3>()
  for (const [id, idx] of t) {
    const c = curves[id]
    if (!c) continue
    pts.set(id, idx.filter(i => c.pts[i]).map(i => ({ i, p: c.pts[i] })))
    if (c.kind === 'bezier') { const fr = pointFrames(c); for (const i of idx) if (c.pts[i]) dirs.set(c.pts[i], fr[i].d) }
  }
  const mid = targetMiddle(t)
  let low = Infinity
  for (const list of pts.values()) for (const { p } of list) low = Math.min(low, p.z ?? 0)
  if (!mid) return null
  const held: PointsHeld = { pts, mid, low, dirs }
  const all = [...pts.entries()]
  if (all.length === 1 && all[0][1].length === 1) {
    const c = curves[all[0][0]], { i, p } = all[0][1][0]
    if (c.kind === 'bezier' && modeOf(c, p) === 'auto') {
      const solo = inLine(p, handlesNow(c, i))
      solo.t = 'unified'
      held.solo = solo
    }
  }
  return held
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
function mapHeld(h: PointsHeld, m: number[][], c = h.mid, more?: (p0: CurvePoint, q: CurvePoint) => void) {
  const ap = (x: number, y: number, z: number) => ({
    x: m[0][0] * x + m[0][1] * y + m[0][2] * z,
    y: m[1][0] * x + m[1][1] * y + m[1][2] * z,
    z: m[2][0] * x + m[2][1] * y + m[2][2] * z,
  })
  writeHeld(h, p0 => {
    const p = h.solo ?? p0
    const d = ap(p.x - c.x, p.y - c.y, (p.z ?? 0) - c.z)
    const q = withZ({ ...p, x: c.x + d.x, y: c.y + d.y }, c.z + d.z)
    for (const side of ['hin', 'hout'] as const) {
      const hd = p[side]
      if (!hd) continue
      const v = ap(hd.x, hd.y, hz(hd))
      q[side] = mk(v.x, v.y, v.z)
    }
    more?.(p0, q)
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
  ], h.mid, (p0, q) => {
    // As much of the turn as is about the path's own line rolls it there.
    const d = h.dirs.get(p0)
    const roll = d ? angle * (x * d.x + y * d.y + z * d.z) * 180 / Math.PI : 0
    const tw = Math.round(((p0.twist ?? 0) + roll) * 10) / 10
    if (tw) q.twist = tw; else delete q.twist
  })
}

/** Sized by (sx, sy, sz) about their middle across the canvas and their
 *  lowest point's height. One point alone sizes its handles: how far the
 *  line leans on it. */
export function sizeHeld(h: PointsHeld, sx: number, sy: number, sz: number) {
  mapHeld(h, [[sx, 0, 0], [0, sy, 0], [0, 0, sz]], { x: h.mid.x, y: h.mid.y, z: h.low })
}

// ── How a curve looks ──

type Ui = ReturnType<typeof useNotesUi.getState>
/** The settings of how a curve looks, as the panel holds them (screen px
 *  at the zoom it is seen at). */
export type LookKey = 'color' | 'width' | 'endStart' | 'endEnd' | 'dashOn' | 'dashGap' | 'unit' | 'opacity' | 'flow' | 'mark' | 'markColor' | 'markSize' | 'endColor' | 'endSize' | 'chev' | 'pulse' | 'ping' | 'pingSpeed' | 'pingSize' | 'pingRings' | 'bulge' | 'bulgeReach' | 'bulgeEase' | 'pulseSize' | 'pulseColor' | 'startScale' | 'endScale' | 'endReach'

/** The panel's settings as a curve's own (canvas units), at zoom `z`:
 *  what a new curve is given. */
export function lookOf(ui: Ui, z: number): Partial<Curve> {
  return {
    color: ui.color, width: ui.width / z,
    endStart: ui.endStart ?? undefined, arrowStart: ui.endStart === 'arrow',
    endEnd: ui.endEnd ?? undefined, arrowEnd: ui.endEnd === 'arrow',
    dash: ui.dashGap > 0 || ui.unit !== 'line' ? [ui.dashOn / z, ui.dashGap / z] : undefined,
    unit: ui.unit === 'line' ? undefined : ui.unit,
    opacity: ui.opacity < 100 ? ui.opacity / 100 : undefined,
    flow: ui.flow ? ui.flow / z : undefined,
    mark: ui.mark ?? undefined,
    chev: ui.unit === 'hatch' && ui.chev !== 50 ? ui.chev / 100 : undefined, pulse: ui.unit === 'hatch' && ui.pulse ? true : undefined, ping: ui.ping ? true : undefined,
    markColor: ui.markColor ?? undefined, markSize: ui.markSize > 0 ? ui.markSize / z : undefined,
    endColor: ui.endColor ?? undefined, endSize: ui.endSize > 0 ? ui.endSize / z : undefined,
    pingSpeed: ui.pingSpeed !== 100 ? ui.pingSpeed / 100 : undefined, pingSize: ui.pingSize > 0 ? ui.pingSize / z : undefined, pingRings: ui.pingRings > 1 ? ui.pingRings : undefined,
    bulge: ui.bulge !== 200 ? ui.bulge / 100 : undefined, bulgeReach: ui.bulgeReach > 0 ? ui.bulgeReach / z : undefined,
    bulgeEase: ui.bulgeEase !== 'inout' ? ui.bulgeEase : undefined,
    pulseSize: ui.pulseSize ? true : undefined, pulseColor: ui.pulseColor ? true : undefined,
    startScale: ui.startScale !== 100 ? ui.startScale / 100 : undefined, endScale: ui.endScale !== 100 ? ui.endScale / 100 : undefined,
    endReach: ui.endReach > 0 ? ui.endReach / z : undefined,
  }
}

const LOOK_FIELDS: Record<LookKey, (keyof Curve)[]> = {
  color: ['color'], width: ['width'], endStart: ['endStart', 'arrowStart'], endEnd: ['endEnd', 'arrowEnd'],
  dashOn: ['dash', 'unit'], dashGap: ['dash', 'unit'], unit: ['dash', 'unit', 'chev', 'pulse'], opacity: ['opacity'], flow: ['flow'], mark: ['mark'],
  chev: ['chev'], pulse: ['pulse'], ping: ['ping'],
  markColor: ['markColor'], markSize: ['markSize'], endColor: ['endColor'], endSize: ['endSize'],
  pingSpeed: ['pingSpeed'], pingSize: ['pingSize'], pingRings: ['pingRings'],
  bulge: ['bulge'], bulgeReach: ['bulgeReach'], bulgeEase: ['bulgeEase'], pulseSize: ['pulseSize'], pulseColor: ['pulseColor'],
  startScale: ['startScale'], endScale: ['endScale'], endReach: ['endReach'],
}

/** Change settings in the panel, and the same on the selected curves
 *  (only what was changed: the rest of each curve stays its own). */
export function setLook(patch: Partial<Pick<Ui, LookKey>>, z: number) {
  useNotesUi.setState(patch)
  const ns = useNotesStore.getState()
  const look = lookOf(useNotesUi.getState(), z) as Record<string, unknown>
  for (const id of useNotesUi.getState().selected) {
    if (!ns.curves[id]) continue
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(patch) as LookKey[]) for (const f of LOOK_FIELDS[k]) out[f] = look[f]
    ns.updateCurve(id, out as Partial<Curve>)
  }
}

/** A curve's look as the panel's settings, seen at zoom `z`: what the
 *  panel shows while the curve is selected. */
export function lookFrom(c: Curve, z: number): Partial<Pick<Ui, LookKey | 'smooth'>> {
  const base = { color: c.color, width: Math.max(1, Math.round(c.width * z)) }
  // A pen line has a colour and a thickness; the rest is a curve's.
  if (c.kind !== 'bezier') return base
  const pat = patternOf(c)
  return {
    ...base,
    endStart: endOf(c, false), endEnd: endOf(c, true),
    smooth: !!c.smooth,
    ...(pat ? { dashOn: Math.max(1, Math.round(pat.on * z)), dashGap: Math.round(pat.gap * z) } : { dashGap: 0 }),
    unit: c.unit ?? 'line',
    opacity: Math.round((c.opacity ?? 1) * 100),
    flow: Math.round((c.flow ?? 0) * z * 10) / 10,
    mark: c.mark ?? null,
    chev: Math.round((c.chev ?? 0.5) * 100), pulse: !!c.pulse, ping: !!c.ping,
    markColor: c.markColor ?? null, markSize: c.markSize ? Math.max(1, Math.round(c.markSize * z)) : 0,
    endColor: c.endColor ?? null, endSize: c.endSize ? Math.max(1, Math.round(c.endSize * z)) : 0,
    pingSpeed: Math.round((c.pingSpeed ?? 1) * 100), pingSize: c.pingSize ? Math.max(1, Math.round(c.pingSize * z)) : 0, pingRings: c.pingRings ?? 1,
    bulge: Math.round((c.bulge ?? 2) * 100), bulgeReach: c.bulgeReach ? Math.max(1, Math.round(c.bulgeReach * z)) : 0,
    bulgeEase: c.bulgeEase ?? 'inout', pulseSize: !!c.pulseSize, pulseColor: !!c.pulseColor,
    startScale: Math.round((c.startScale ?? 1) * 100), endScale: Math.round((c.endScale ?? 1) * 100),
    endReach: c.endReach ? Math.max(1, Math.round(c.endReach * z)) : 0,
  }
}

/** Whether the selected points show their curve's point graphic. */
export function markState(): { any: boolean; on: boolean } {
  const { curves } = useNotesStore.getState()
  let any = false, on = true
  for (const [id, idx] of pickedPoints()) for (const i of idx) {
    any = true
    if (curves[id].pts[i].mark === false) on = false
  }
  return { any, on: any && on }
}

/** The curve's point graphic on or off at the selected points. */
export function setPointMarks(on: boolean) {
  const ns = useNotesStore.getState()
  for (const [id, idx] of pickedPoints()) {
    const c = ns.curves[id]
    ns.updateCurve(id, { pts: c.pts.map((p, i) => {
      if (!idx.includes(i)) return p
      const q = { ...p }
      if (on) delete q.mark; else q.mark = false
      return q
    }) })
  }
}

/** The selected points' twist (the first's), in degrees. */
export function twistState(): { any: boolean; twist: number } {
  const { curves } = useNotesStore.getState()
  for (const [id, idx] of pickedPoints()) if (curves[id].kind === 'bezier' && idx.length) return { any: true, twist: Math.round(curves[id].pts[idx[0]].twist ?? 0) }
  return { any: false, twist: 0 }
}

/** Roll the path about its own line at the selected points: degrees. */
export function setPointTwist(deg: number) {
  const ns = useNotesStore.getState()
  for (const [id, idx] of pickedPoints()) {
    const c = ns.curves[id]
    if (c.kind !== 'bezier') continue
    ns.updateCurve(id, { pts: c.pts.map((p, i) => {
      if (!idx.includes(i)) return p
      const q = { ...p }
      if (deg) q.twist = deg; else delete q.twist
      return q
    }) })
  }
}

/** The selected points back to no rotation of their own: no twist, and
 *  whatever rides the path turned there as the path has it (a camera's
 *  reframing at that point forgotten). */
export function resetPointTurn() {
  const ns = useNotesStore.getState()
  for (const [id, idx] of pickedPoints()) {
    const c = ns.curves[id]
    if (c.kind !== 'bezier') continue
    const riders = c.riders?.map(r => {
      if (!r.keys || !idx.some(i => r.keys![i])) return r
      const keys = { ...r.keys }
      for (const i of idx) delete keys[i]
      const q = { ...r }
      if (Object.keys(keys).length) q.keys = keys; else delete q.keys
      return q
    })
    ns.updateCurve(id, {
      pts: c.pts.map((p, i) => { if (!idx.includes(i) || p.twist === undefined) return p; const q = { ...p }; delete q.twist; return q }),
      ...(riders ? { riders } : {}),
    })
  }
}

/** The selected points' label (the first's). */
export function labelState(): { any: boolean; label: string } {
  const { curves } = useNotesStore.getState()
  for (const [id, idx] of pickedPoints()) if (curves[id].kind === 'bezier' && idx.length) return { any: true, label: curves[id].pts[idx[0]].label ?? '' }
  return { any: false, label: '' }
}

/** A few words by each of the selected points ('' takes them away). */
export function setPointLabel(text: string) {
  const ns = useNotesStore.getState()
  for (const [id, idx] of pickedPoints()) {
    const c = ns.curves[id]
    if (c.kind !== 'bezier') continue
    ns.updateCurve(id, { pts: c.pts.map((p, i) => {
      if (!idx.includes(i)) return p
      const q = { ...p }
      if (text) q.label = text; else delete q.label
      return q
    }) })
  }
}
