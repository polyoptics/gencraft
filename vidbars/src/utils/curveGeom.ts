// curveGeom.ts — the shape of a curve (store/notesStore): its SVG path and
// its arrowheads, in canvas units.

import type { Curve, CurvePoint } from '../store/notesStore'

type P = { x: number; y: number }
const out = (p: CurvePoint): P => ({ x: p.x + (p.hout?.x ?? 0), y: p.y + (p.hout?.y ?? 0) })
const inn = (p: CurvePoint): P => ({ x: p.x + (p.hin?.x ?? 0), y: p.y + (p.hin?.y ?? 0) })
const f = (n: number) => Math.round(n * 100) / 100

/** A smooth curve's points with the handles that carry the line through
 *  them. Inside the line each point's tangent is a centripetal
 *  Catmull-Rom's: the nearer neighbour counts for more, so a short segment
 *  beside a long one neither overshoots nor kinks. An open line's two ends
 *  have no neighbour to lean on, so each bends in one even arc towards the
 *  handle of the point next to it (the end segment is a quadratic) instead
 *  of setting off straight and turning late. Other curves' points as they
 *  are. */
export function curvePoints(c: Pick<Curve, 'kind' | 'pts' | 'closed' | 'smooth'>): CurvePoint[] {
  const pts = c.pts
  if (c.kind !== 'bezier' || !c.smooth || pts.length < 2) return pts
  const n = pts.length
  const closed = !!c.closed && n > 2
  const EPS = 1e-6
  // A segment's share of the parameter: the square root of its length.
  const span = (a: CurvePoint, b: CurvePoint) => Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y))
  const res: CurvePoint[] = pts.map((p, i) => {
    const a = i > 0 ? pts[i - 1] : closed ? pts[n - 1] : null
    const b = i < n - 1 ? pts[i + 1] : closed ? pts[0] : null
    if (!a || !b) return { x: p.x, y: p.y }
    const t0 = span(a, p), t1 = span(p, b)
    if (t0 < EPS && t1 < EPS) return { x: p.x, y: p.y }
    let mx: number, my: number
    if (t0 < EPS) { mx = (b.x - p.x) / t1; my = (b.y - p.y) / t1 }
    else if (t1 < EPS) { mx = (p.x - a.x) / t0; my = (p.y - a.y) / t0 }
    else {
      mx = (p.x - a.x) / t0 - (b.x - a.x) / (t0 + t1) + (b.x - p.x) / t1
      my = (p.y - a.y) / t0 - (b.y - a.y) / (t0 + t1) + (b.y - p.y) / t1
    }
    return { x: p.x, y: p.y, hin: { x: -mx * t0 / 3, y: -my * t0 / 3 }, hout: { x: mx * t1 / 3, y: my * t1 / 3 } }
  })
  if (!closed) {
    // The quadratic through the end and its neighbour whose control point
    // lies along the neighbour's handle, written as this cubic's handles.
    const end = (i: number, j: number, side: 'hin' | 'hout', near: 'hin' | 'hout') => {
      const p = res[i], q = res[j], h = q[near]
      if (!h || (Math.abs(h.x) < EPS && Math.abs(h.y) < EPS)) {
        p[side] = { x: (q.x - p.x) / 3, y: (q.y - p.y) / 3 }
        return
      }
      p[side] = { x: (q.x + 1.5 * h.x - p.x) * 2 / 3, y: (q.y + 1.5 * h.y - p.y) * 2 / 3 }
    }
    end(0, 1, 'hout', 'hin')
    end(n - 1, n - 2, 'hin', 'hout')
  }
  return res
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

/** Which way the line runs into its end (`end`) or out of its start, as a
 *  unit vector pointing out of the curve. */
function endDir(c: Curve, end: boolean): P | null {
  const pts = curvePoints(c)
  if (pts.length < 2) return null
  const tip = end ? pts[pts.length - 1] : pts[0]
  const cands: P[] = []
  if (c.kind === 'bezier') cands.push(end ? inn(tip) : out(tip))
  // Fall back along the anchors until one is somewhere else.
  const order = end ? [...pts].reverse() : pts
  for (const p of order.slice(1)) {
    if (c.kind === 'bezier') cands.push(end ? out(p) : inn(p))
    cands.push(p)
  }
  for (const q of cands) {
    const dx = tip.x - q.x, dy = tip.y - q.y, l = Math.hypot(dx, dy)
    if (l > 1e-6) return { x: dx / l, y: dy / l }
  }
  return null
}

/** The arrowheads' triangles (SVG points strings), canvas units. The line
 *  itself is cut back to the arrow's base by curveTrim. */
export function arrowHeads(c: Curve): string[] {
  const heads: string[] = []
  const size = Math.max(c.width * 4.5, 6)
  const one = (end: boolean) => {
    const d = endDir(c, end)
    if (!d) return
    const tip = end ? c.pts[c.pts.length - 1] : c.pts[0]
    const bx = tip.x - d.x * size, by = tip.y - d.y * size
    const nx = -d.y * size * 0.5, ny = d.x * size * 0.5
    heads.push(`${f(tip.x)},${f(tip.y)} ${f(bx + nx)},${f(by + ny)} ${f(bx - nx)},${f(by - ny)}`)
  }
  if (c.arrowEnd && !c.closed) one(true)
  if (c.arrowStart && !c.closed) one(false)
  return heads
}

/** The box round a curve's anchors and handles, canvas units. */
export function curveBounds(c: Curve): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const add = (p: P) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y) }
  for (const p of curvePoints(c)) { add(p); if (c.kind === 'bezier') { add(inn(p)); add(out(p)) } }
  return { x0, y0, x1, y1 }
}
