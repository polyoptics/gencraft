// curveGeom.ts — the shape of a curve (store/notesStore): its SVG path and
// its arrowheads, in canvas units.

import type { Curve, CurvePoint, CurveHandle, CurveEnd } from '../store/notesStore'

type P = { x: number; y: number }
const out = (p: CurvePoint): P => ({ x: p.x + (p.hout?.x ?? 0), y: p.y + (p.hout?.y ?? 0) })
const inn = (p: CurvePoint): P => ({ x: p.x + (p.hin?.x ?? 0), y: p.y + (p.hin?.y ?? 0) })
const f = (n: number) => Math.round(n * 100) / 100

/** A point in the canvas's space: x, y on it, z up off it. */
export interface P3 { x: number; y: number; z: number }
const zOf = (p: { z?: number } | undefined) => p?.z ?? 0
const h3 = (x: number, y: number, z: number): CurveHandle => z ? { x, y, z } : { x, y }
/** An anchor without its handles. */
const bare = (p: CurvePoint): CurvePoint => {
  const q: CurvePoint = { x: p.x, y: p.y }
  if (p.z) q.z = p.z
  if (p.t) q.t = p.t
  return q
}
const hasHandle = (h: CurveHandle | undefined) => !!h && (Math.abs(h.x) > 1e-6 || Math.abs(h.y) > 1e-6 || Math.abs(h.z ?? 0) > 1e-6)

/** A point whose handles are set by hand, even on a smooth curve. */
export const ownsHandles = (p: CurvePoint) => p.t === 'broken' || p.t === 'unified'

/** A curve's points with the handles that carry the line through them.
 *  A 'corner' point has none, whatever the curve. On a smooth curve a
 *  'broken' or 'unified' point keeps the handles set on it by hand, and every other
 *  point's are found here: inside the line each point's tangent is a
 *  centripetal Catmull-Rom's (the nearer neighbour counts for more, so a
 *  short segment beside a long one neither overshoots nor kinks); an open
 *  line's two ends have no neighbour to lean on, so each bends in one even
 *  arc towards the handle of the point next to it (the end segment is a
 *  quadratic) instead of setting off straight and turning late. In all
 *  three directions: a point's height counts as its place on the canvas
 *  does. Other curves' points as they are. */
export function curvePoints(c: Pick<Curve, 'kind' | 'pts' | 'closed' | 'smooth'>): CurvePoint[] {
  const pts = c.pts
  if (c.kind !== 'bezier' || pts.length < 2) return pts
  if (!c.smooth) return pts.some(p => p.t === 'corner' && (p.hin || p.hout)) ? pts.map(p => p.t === 'corner' ? bare(p) : p) : pts
  const n = pts.length
  const closed = !!c.closed && n > 2
  const EPS = 1e-6
  // A segment's share of the parameter: the square root of its length.
  const span = (a: CurvePoint, b: CurvePoint) => Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y, zOf(b) - zOf(a)))
  const auto = (p: CurvePoint) => p.t !== 'corner' && !ownsHandles(p)
  const res: CurvePoint[] = pts.map((p, i) => {
    if (ownsHandles(p)) return p
    const a = i > 0 ? pts[i - 1] : closed ? pts[n - 1] : null
    const b = i < n - 1 ? pts[i + 1] : closed ? pts[0] : null
    if (p.t === 'corner' || !a || !b) return bare(p)
    const t0 = span(a, p), t1 = span(p, b)
    if (t0 < EPS && t1 < EPS) return bare(p)
    const m = (pa: number, pp: number, pb: number) =>
      t0 < EPS ? (pb - pp) / t1 : t1 < EPS ? (pp - pa) / t0 : (pp - pa) / t0 - (pb - pa) / (t0 + t1) + (pb - pp) / t1
    const mx = m(a.x, p.x, b.x), my = m(a.y, p.y, b.y), mz = m(zOf(a), zOf(p), zOf(b))
    return { ...bare(p), hin: h3(-mx * t0 / 3, -my * t0 / 3, -mz * t0 / 3), hout: h3(mx * t1 / 3, my * t1 / 3, mz * t1 / 3) }
  })
  if (!closed) {
    // The quadratic through the end and its neighbour whose control point
    // lies along the neighbour's handle, written as this cubic's handles.
    const end = (i: number, j: number, side: 'hin' | 'hout', near: 'hin' | 'hout') => {
      if (!auto(pts[i])) return
      const p = res[i], q = res[j], h = q[near]
      const dz = zOf(q) - zOf(p)
      if (!hasHandle(h)) {
        p[side] = h3((q.x - p.x) / 3, (q.y - p.y) / 3, dz / 3)
        return
      }
      p[side] = h3((q.x + 1.5 * h!.x - p.x) * 2 / 3, (q.y + 1.5 * h!.y - p.y) * 2 / 3, (dz + 1.5 * zOf(h)) * 2 / 3)
    }
    end(0, 1, 'hout', 'hin')
    end(n - 1, n - 2, 'hin', 'hout')
  }
  return res
}

const at3 = (p: CurvePoint, h?: CurveHandle): P3 => ({ x: p.x + (h?.x ?? 0), y: p.y + (h?.y ?? 0), z: zOf(p) + zOf(h) })
const lerp3 = (a: P3, b: P3, t: number): P3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })

/** A sample of a curve's line: where, and which segment (the one leaving
 *  point `seg`) at what share `t` of it. */
export interface CurveSample extends P3 { seg: number; t: number }

/** The line of a curve as points along it, in all three directions:
 *  `per` to a bent segment, its two ends alone for a straight one. */
export function curveSamples(c: Pick<Curve, 'kind' | 'pts' | 'closed' | 'smooth'>, per = 20): CurveSample[] {
  const pts = curvePoints(c)
  const n = pts.length
  if (!n) return []
  if (c.kind === 'free') return pts.map((p, i) => ({ ...at3(p), seg: Math.min(i, n - 2), t: i === n - 1 && n > 1 ? 1 : 0 }))
  const out: CurveSample[] = [{ ...at3(pts[0]), seg: 0, t: 0 }]
  const segs = c.closed && n > 2 ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n]
    const p0 = at3(a), p1 = at3(a, a.hout), p2 = at3(b, b.hin), p3 = at3(b)
    const steps = hasHandle(a.hout) || hasHandle(b.hin) ? per : 1
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, u = 1 - t
      const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t
      out.push({
        x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
        y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
        z: w0 * p0.z + w1 * p1.z + w2 * p2.z + w3 * p3.z,
        seg: i, t,
      })
    }
  }
  return out
}

/** The place on a curve's line nearest (x, y), as `to` draws its points
 *  (the canvas itself seen flat, the screen in 3D): the segment, the share
 *  of it, and how far off the line (x, y) is. */
export function nearestOnCurve(c: Pick<Curve, 'kind' | 'pts' | 'closed' | 'smooth'>, to: (p: P3) => { x: number; y: number } | null, x: number, y: number): { seg: number; t: number; d: number } | null {
  let best: { seg: number; t: number; d: number } | null = null
  let prev: { q: { x: number; y: number }; s: CurveSample } | null = null
  for (const s of curveSamples(c)) {
    const q = to(s)
    if (!q) { prev = null; continue }
    if (prev) {
      const dx = q.x - prev.q.x, dy = q.y - prev.q.y, l2 = dx * dx + dy * dy
      const k = l2 ? Math.max(0, Math.min(1, ((x - prev.q.x) * dx + (y - prev.q.y) * dy) / l2)) : 0
      const d = Math.hypot(x - prev.q.x - dx * k, y - prev.q.y - dy * k)
      if (!best || d < best.d) {
        // Within one segment its samples' shares run on; a new segment starts at 0.
        const t0 = prev.s.seg === s.seg ? prev.s.t : 0
        best = { seg: s.seg, t: t0 + (s.t - t0) * k, d }
      }
    }
    prev = { q, s }
  }
  return best
}

/** A curve's points with one more, on its line at share `t` of the
 *  segment leaving point `seg`: the line keeps its shape (the handles
 *  either side are shortened to suit). The new point's index with them. */
export function splitCurveAt(c: Pick<Curve, 'kind' | 'pts' | 'closed' | 'smooth'>, seg: number, t: number): { pts: CurvePoint[]; index: number } | null {
  const n = c.pts.length
  if (c.kind !== 'bezier' || n < 2 || seg < 0 || seg >= n) return null
  const eff = curvePoints(c)
  const j = (seg + 1) % n
  const a = eff[seg], b = eff[j]
  const p0 = at3(a), p1 = at3(a, a.hout), p2 = at3(b, b.hin), p3 = at3(b)
  const q0 = lerp3(p0, p1, t), q1 = lerp3(p1, p2, t), q2 = lerp3(p2, p3, t)
  const r0 = lerp3(q0, q1, t), r1 = lerp3(q1, q2, t), s = lerp3(r0, r1, t)
  const rel = (p: P3, o: P3) => h3(p.x - o.x, p.y - o.y, p.z - o.z)
  const pts = c.pts.slice()
  const np: CurvePoint = { x: s.x, y: s.y }
  if (s.z) np.z = s.z
  // A point whose handles are its own (not found by a smooth curve) has
  // them cut to suit; so has the new point on a curve set by hand.
  const own = (p: CurvePoint) => p.t !== 'corner' && (!c.smooth || ownsHandles(p))
  // On a straight stretch (no handle at either end) it is a plain point,
  // as a clicked one is.
  if (!c.smooth && (hasHandle(a.hout) || hasHandle(b.hin))) { np.hin = rel(r0, s); np.hout = rel(r1, s) }
  if (own(pts[seg]) && hasHandle(a.hout)) pts[seg] = { ...pts[seg], hout: rel(q0, p0) }
  if (own(pts[j]) && hasHandle(b.hin)) pts[j] = { ...pts[j], hin: rel(q2, p3) }
  pts.splice(seg + 1, 0, np)
  return { pts, index: seg + 1 }
}

/** A curve's line pattern: the lengths of its solid and empty sections
 *  (canvas units), or null for one solid line. */
export function dashOf(c: Pick<Curve, 'dash' | 'width'>): [number, number] | null {
  const d = c.dash
  if (!d) return null
  if (d === 'dash') return [c.width * 3.5, c.width * 1.5]
  if (d === 'dot') return [c.width, c.width * 1.5]
  return d[0] > 0 && d[1] > 0 ? d : null
}

/** What stands on a curve's end (`end`) or its start: nothing on a closed
 *  one. */
export function endOf(c: Pick<Curve, 'endStart' | 'endEnd' | 'arrowStart' | 'arrowEnd' | 'closed' | 'pts'>, end: boolean): CurveEnd | null {
  if (c.closed && c.pts.length > 2) return null
  return (end ? c.endEnd : c.endStart) ?? ((end ? c.arrowEnd : c.arrowStart) ? 'arrow' : null)
}
/** How long an arrowhead is, how far across a cube or a ball on an end. */
export const endSize = (c: Pick<Curve, 'width'>, kind: CurveEnd) => kind === 'arrow' ? Math.max(c.width * 4.5, 6) : Math.max(c.width * 3.2, 5)
/** How much of the line an end's shape stands in for (the line stops
 *  inside it, so none of it shows past the shape). */
export const endTrim = (c: Pick<Curve, 'width'>, kind: CurveEnd) => endSize(c, kind) * (kind === 'arrow' ? 0.8 : 0.25)
/** How thick a ring `on` across is drawn (its tube's radius). */
export const ringTube = (c: Pick<Curve, 'width'>, on: number) => Math.min(c.width * 0.35, on * 0.2)
/** How far across the graphic at a curve's points is. */
export const markSize = (c: Pick<Curve, 'width'>) => Math.max(c.width * 6, 8)

/** The pattern a curve's line repeats: the piece, how long (or across)
 *  it is and the gap after it. Null: one solid line. */
export function patternOf(c: Pick<Curve, 'dash' | 'width' | 'unit'>): { unit: 'line' | 'ball' | 'ring'; on: number; gap: number } | null {
  const unit = c.unit ?? 'line'
  if (unit === 'line') {
    const d = dashOf(c)
    return d ? { unit, on: d[0], gap: d[1] } : null
  }
  const d = c.dash
  if (Array.isArray(d) && d[0] > 0) return { unit, on: d[0], gap: Math.max(0, d[1]) }
  const legacy = dashOf(c)
  return legacy ? { unit, on: legacy[0], gap: legacy[1] } : { unit, on: c.width * 2.5, gap: c.width * 2.5 }
}

/** How far a curve's pattern has run along the line by `time` (seconds):
 *  0 up to one `period`. */
export function flowShift(c: Pick<Curve, 'flow'>, period: number, time: number): number {
  if (!c.flow || !(period > 0)) return 0
  return (((c.flow * time) % period) + period) % period
}

const dist3 = (a: P3, b: P3) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
const mix3 = (a: P3, b: P3, t: number): P3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })

/** How long a line is. */
export function lineLength(s: P3[]): number {
  let total = 0
  for (let i = 1; i < s.length; i++) total += dist3(s[i - 1], s[i])
  return total
}

/** A line without its first `a` and its last `b` (lengths along it).
 *  Nothing when that is all of it. */
export function trimLine<T extends P3>(s: T[], a: number, b: number): P3[] {
  if (a <= 0 && b <= 0) return s
  const total = lineLength(s)
  const to = total - b
  if (to - a < 1e-6) return []
  const out: P3[] = []
  let run = 0
  for (let i = 1; i < s.length; i++) {
    const p = s[i - 1], q = s[i], d = dist3(p, q)
    const r0 = run, r1 = run + d
    run = r1
    if (r1 < a || d < 1e-12) continue
    if (r0 > to) break
    if (!out.length) out.push(r0 >= a ? p : mix3(p, q, (a - r0) / d))
    out.push(r1 <= to ? q : mix3(p, q, (to - r0) / d))
  }
  return out
}

/** Places along a line every `period`, the first `first` along it: where
 *  each is and which way the line runs there. */
export function alongEvery(s: P3[], period: number, first: number, max = 600): { p: P3; d: P3 }[] {
  const out: { p: P3; d: P3 }[] = []
  if (!(period > 0) || s.length < 2) return out
  const total = lineLength(s)
  period *= Math.max(1, total / period / max)
  let next = first, run = 0
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i], d = dist3(a, b)
    if (d < 1e-12) continue
    const dir = { x: (b.x - a.x) / d, y: (b.y - a.y) / d, z: (b.z - a.z) / d }
    while (next <= run + d + 1e-9) {
      out.push({ p: mix3(a, b, Math.max(0, (next - run) / d)), d: dir })
      next += period
    }
    run += d
  }
  return out
}

/** A curve's line cut into the pieces a patterned line shows: each `on`
 *  long with `off` between (canvas units along the line), the pattern
 *  run `shift` along it. A piece is the points along it. */
export function dashPieces(s: P3[], on: number, off: number, shift = 0, max = 1500): P3[][] {
  if (s.length < 2) return []
  // Never more pieces than is sane to draw: a very long line's are longer.
  const k = Math.max(1, lineLength(s) / (on + off) / max)
  on *= k; off *= k; shift *= k
  const out: P3[][] = []
  // Where in the pattern the line starts.
  const phase = (on + off - shift % (on + off)) % (on + off)
  let cur: P3[] | null = phase < on ? [s[0]] : null
  let left = phase < on ? on - phase : on + off - phase   // how much of this piece (or gap) is still to run
  for (let i = 1; i < s.length; i++) {
    let a = s[i - 1]
    const b = s[i]
    let d = dist3(a, b)
    while (d > left) {
      a = mix3(a, b, left / d)
      d -= left
      if (cur) { cur.push(a); out.push(cur); cur = null; left = off }
      else { cur = [a]; left = on }
    }
    left -= d
    if (cur) cur.push(b)
  }
  if (cur && cur.length > 1) out.push(cur)
  return out
}

/** A curve's line as it shows: without what its ends' shapes stand in
 *  for. And each end's shape: what, where its tip is, which way it points
 *  (out of the curve, along the last of the line) and its size. */
export function shownLine(c: Curve, per = 24): { line: P3[]; ends: { kind: CurveEnd; tip: P3; dir: P3; size: number; end: boolean }[] } {
  const s = curveSamples(c, per)
  const ends: { kind: CurveEnd; tip: P3; dir: P3; size: number; end: boolean }[] = []
  if (s.length < 2) return { line: s, ends }
  const total = lineLength(s)
  let a = 0, b = 0
  for (const end of [false, true]) {
    const kind = endOf(c, end)
    if (!kind) continue
    const size = endSize(c, kind)
    const tip = end ? s[s.length - 1] : s[0]
    // It points along the chord of the line it covers, so it sits square
    // on where the line stops.
    const back = Math.min(size, total * 0.999)
    const cut = end ? trimLine(s, 0, back) : trimLine(s, back, 0)
    const from = cut.length ? (end ? cut[cut.length - 1] : cut[0]) : (end ? s[0] : s[s.length - 1])
    const l = dist3(from, tip)
    if (l < 1e-9) continue
    ends.push({ kind, tip: { x: tip.x, y: tip.y, z: tip.z }, dir: { x: (tip.x - from.x) / l, y: (tip.y - from.y) / l, z: (tip.z - from.z) / l }, size, end })
    if (end) b = endTrim(c, kind); else a = endTrim(c, kind)
  }
  return { line: trimLine(s, a, b), ends }
}

/** The SVG path of a curve, in canvas units. */
export function curvePath(c: Pick<Curve, 'kind' | 'pts' | 'closed' | 'smooth'>): string {
  const pts = curvePoints(c)
  if (pts.length === 0) return ''
  if (pts.length === 1) return `M${f(pts[0].x)} ${f(pts[0].y)}`
  if (c.kind === 'free') {
    // A pen line: smoothed through the midpoints.
    let d = `M${f(pts[0].x)} ${f(pts[0].y)}`
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2
      d += ` Q${f(pts[i].x)} ${f(pts[i].y)} ${f(mx)} ${f(my)}`
    }
    const l = pts[pts.length - 1]
    return d + ` L${f(l.x)} ${f(l.y)}`
  }
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`
  const seg = (a: CurvePoint, b: CurvePoint) => {
    const c1 = out(a), c2 = inn(b)
    d += ` C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(b.x)} ${f(b.y)}`
  }
  for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i])
  if (c.closed && pts.length > 2) { seg(pts[pts.length - 1], pts[0]); d += ' Z' }
  return d
}

/** The box round a curve's anchors and handles, canvas units. */
export function curveBounds(c: Curve): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const add = (p: P) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y) }
  for (const p of curvePoints(c)) { add(p); if (c.kind === 'bezier') { add(inn(p)); add(out(p)) } }
  return { x0, y0, x1, y1 }
}
