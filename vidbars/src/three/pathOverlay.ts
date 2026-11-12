// pathOverlay.ts — the canvas's curves in the 3D view (store/notesStore;
// Brian 2026-11-12: "in 3D, it's still kind of flat graphics. The points
// along the line should be cubes"). Tilted, a curve is a real thing in the
// scene: a round line through its points at their heights, cones for its
// arrowheads and, selected, a cube on every point and its tangent handles.
// A point off the ground has a thin stem down to where it stands. Drawn
// after the models, against their depth: where something stands in front
// of the line it shows through faintly, so it is never lost. Cubes and
// handles are a constant size on screen and always in front.
//
// Flat, the same curves are drawn by components/Notes/CurveLayer, seen
// from straight above. This also answers what is under the cursor (at)
// and where a point is on screen (project), for utils/notesTool.

import * as THREE from 'three'
import type { Curve } from '../store/notesStore'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { curvePoints, nearestOnCurve, dashPieces, ownsHandles, shownLine, patternOf, flowShift, alongEvery, lineLength, markSize, markBar, ringTube, pointFrames, frameOf, unitBars, markBars, barOf, pingAt, pingSize, pingRings, PING_ECHO, fieldOf, fineLine, tintRgb, type P3, type Bar, type PathFrame3 } from '../utils/curveGeom'

/** What the 3D view draws of the curves this frame. */
export interface PathFrame {
  /** The bezier curves, the one being drawn among them. */
  curves: Curve[]
  selected: Set<string>
  /** Selected points, `${curve id}:${index}`. */
  points: Set<string>
  zoom: number
  /** The canvas's origin, flat px from the host centre. */
  ox: number
  oy: number
  /** The part under the cursor: `p:${id}:${i}` or `h:${id}:${i}:${side}`. */
  hot: string | null
  /** Where the manipulator sits (canvas units, z up), if anything of a
   *  curve is selected. */
  gizmo: P3 | null
  /** One point alone is selected: the path's directions there, for the
   *  manipulator in Local. */
  gizmoFrame?: PathFrame3 | null
  /** Seconds, for the patterns that run along their lines (0: none does). */
  time: number
  /** Changes whenever any of the above does. */
  sig: number
}

export type PathHit =
  | { kind: 'point'; id: string; i: number }
  | { kind: 'handle'; id: string; i: number; side: 'in' | 'out' }
  | { kind: 'line'; id: string; seg: number; t: number }

const CUBE_PX = 11, HANDLE_PX = 8, LABEL_PX = 15

/** A few words as a picture: light on a dark edge, so they read over anything. */
function labelTexture(text: string, color: string): { tex: THREE.CanvasTexture; aspect: number } | null {
  const cv = document.createElement('canvas')
  const g = cv.getContext('2d')
  if (!g) return null
  const font = '600 44px system-ui, sans-serif'
  g.font = font
  const w = Math.ceil(g.measureText(text).width) + 24, h = 60
  cv.width = w; cv.height = h
  g.font = font
  g.textBaseline = 'middle'
  g.lineJoin = 'round'
  g.lineWidth = 9
  g.strokeStyle = 'rgba(8,10,20,0.9)'
  g.strokeText(text, 12, h / 2 + 2)
  g.fillStyle = color
  g.fillText(text, 12, h / 2 + 2)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return { tex, aspect: w / h }
}
const COL = { picked: 0xffe14a, selected: 0xffffff, hot: 0x9fd0ff, handle: 0x78b4ff }

/** A round line through `s` (canvas units), radius `r`. With `at`, each
 *  place along it is `k` times as thick and (if it gives one) its own
 *  colour. */
function tube(s: P3[], r: number, closed: boolean, radial = 10, at?: (p: P3) => { k: number; rgb?: [number, number, number] }): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [], src: P3[] = []
  for (const p of s) {
    const v = new THREE.Vector3(p.x, p.y, p.z)
    if (!pts.length || pts[pts.length - 1].distanceToSquared(v) > 1e-10) { pts.push(v); src.push(p) }
  }
  if (closed && pts.length > 2 && pts[0].distanceToSquared(pts[pts.length - 1]) < 1e-10) { pts.pop(); src.pop() }
  const col: number[] = []
  const n = pts.length
  const geo = new THREE.BufferGeometry()
  if (n < 2) return geo
  const loop = closed && n > 2
  const pos: number[] = [], nor: number[] = [], idx: number[] = []
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), v = new THREE.Vector3()
  const dir = (i: number, j: number, into: THREE.Vector3) => into.subVectors(pts[(j + n) % n], pts[(i + n) % n]).normalize()
  for (let i = 0; i < n; i++) {
    const hasIn = loop || i > 0, hasOut = loop || i < n - 1
    if (hasIn) dir(i - 1, i, a)
    if (hasOut) dir(i, i + 1, b)
    if (!hasIn) a.copy(b)
    if (!hasOut) b.copy(a)
    T.addVectors(a, b)
    if (T.lengthSq() < 1e-8) T.copy(b)
    T.normalize()
    // Wider at a turn, so the line keeps its width round it.
    const k = 1 / Math.max(0.5, T.dot(a))
    if (i === 0) {
      N.set(0, 0, 1)
      if (Math.abs(T.z) > 0.9) N.set(1, 0, 0)
    }
    N.addScaledVector(T, -N.dot(T))
    if (N.lengthSq() < 1e-8) N.set(1, 0, 0).addScaledVector(T, -T.x)
    N.normalize()
    B.crossVectors(T, N)
    const here = at?.(src[i])
    const rr = r * k * (here ? here.k : 1)
    for (let j = 0; j < radial; j++) {
      const th = j / radial * Math.PI * 2
      v.copy(N).multiplyScalar(Math.cos(th)).addScaledVector(B, Math.sin(th))
      nor.push(v.x, v.y, v.z)
      pos.push(pts[i].x + v.x * rr, pts[i].y + v.y * rr, pts[i].z + v.z * rr)
      if (here?.rgb) col.push(here.rgb[0], here.rgb[1], here.rgb[2])
    }
  }
  const rings = loop ? n : n - 1
  for (let i = 0; i < rings; i++) {
    const i1 = (i + 1) % n
    for (let j = 0; j < radial; j++) {
      const j1 = (j + 1) % radial
      const p00 = i * radial + j, p01 = i * radial + j1, p10 = i1 * radial + j, p11 = i1 * radial + j1
      idx.push(p00, p10, p01, p01, p10, p11)
    }
  }
  if (!loop) {
    // Round off the two open ends with a flat cap each.
    for (const [i, sign] of [[0, -1], [n - 1, 1]] as const) {
      const c = pos.length / 3
      dir(i === 0 ? 0 : n - 2, i === 0 ? 1 : n - 1, a)
      pos.push(pts[i].x, pts[i].y, pts[i].z)
      nor.push(a.x * sign, a.y * sign, a.z * sign)
      if (col.length) col.push(col[i * radial * 3], col[i * radial * 3 + 1], col[i * radial * 3 + 2])
      for (let j = 0; j < radial; j++) {
        const j1 = (j + 1) % radial
        if (sign < 0) idx.push(c, i * radial + j, i * radial + j1)
        else idx.push(c, i * radial + j1, i * radial + j)
      }
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  if (col.length) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.setIndex(idx)
  return geo
}

/** A soft ring as a picture, for the pings: it always faces the viewer. */
let ringTex: THREE.CanvasTexture | null = null
function ringTexture(): THREE.CanvasTexture {
  if (ringTex) return ringTex
  const cv = document.createElement('canvas')
  cv.width = cv.height = 256
  const g = cv.getContext('2d')!
  g.strokeStyle = '#fff'
  g.lineWidth = 9
  g.beginPath(); g.arc(128, 128, 120, 0, Math.PI * 2); g.stroke()
  ringTex = new THREE.CanvasTexture(cv)
  return ringTex
}

const CUBE = new THREE.BoxGeometry(1, 1, 1)
const CUBE_EDGES = new THREE.EdgesGeometry(CUBE)
const BALL = new THREE.SphereGeometry(0.5, 14, 10)
const EDGE_MAT = new THREE.LineBasicMaterial({ color: 0x0d1020, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false, toneMapped: false })
const STEM_MAT = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false, toneMapped: false })
const ARM_MAT = new THREE.LineBasicMaterial({ color: COL.handle, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false })
const Y_UP = new THREE.Vector3(0, 1, 0), Z_UP = new THREE.Vector3(0, 0, 1)

/** A round bar from the origin up y, 1 long and 1 thick: scaled and
 *  turned onto each bar of a wire pattern or a point's graphic. */
const BAR = new THREE.CylinderGeometry(0.5, 0.5, 1, 6).translate(0, 0.5, 0)
const barM = new THREE.Matrix4(), barQ = new THREE.Quaternion(), barA = new THREE.Vector3(), barD = new THREE.Vector3(), barS = new THREE.Vector3()
/** Where BAR goes to be the bar `b`, `t` thick (a little long, so bars
 *  that meet close the corner). */
function barMatrix(b: Bar, t: number): THREE.Matrix4 {
  barA.set(b[0].x, b[0].y, b[0].z)
  barD.set(b[1].x - b[0].x, b[1].y - b[0].y, b[1].z - b[0].z)
  const l = barD.length()
  t *= b[2] ?? 1
  if (l > 1e-9) barD.divideScalar(l); else barD.set(0, 1, 0)
  barQ.setFromUnitVectors(Y_UP, barD)
  barA.addScaledVector(barD, -t * 0.3)
  return barM.compose(barA, barQ, barS.set(t, l + t * 0.6, t))
}
const frameQuat = (f: PathFrame3) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(f.d.x, f.d.y, f.d.z), new THREE.Vector3(f.side.x, f.side.y, f.side.z), new THREE.Vector3(f.up.x, f.up.y, f.up.z)))

interface Knob { mesh: THREE.Mesh; at: THREE.Vector3; px: number; key: string; base: number }
interface Built {
  curve: Curve
  selected: boolean
  group: THREE.Group
  /** What is thrown away with it. */
  own: (THREE.BufferGeometry | THREE.Material)[]
  cubes: Knob[]
  handles: (Knob & { i: number; side: 'in' | 'out' })[]
  /** Its pattern, run on to `time`: only when it runs. */
  flow?: (time: number) => void
  /** The words by its points: a constant size on screen. */
  labels: { sprite: THREE.Sprite; at: THREE.Vector3; aspect: number }[]
}

export function createPathOverlay() {
  const scene = new THREE.Scene()
  // Lit from over the viewer's shoulder, whichever way the canvas lies:
  // the cubes' faces read apart and the line reads round.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x59607a, 1.5))
  const sun = new THREE.DirectionalLight(0xffffff, 1.6)
  sun.position.set(-0.5, 0.9, 1)
  scene.add(sun)
  const root = new THREE.Group()
  root.matrixAutoUpdate = false
  scene.add(root)
  const built = new Map<string, Built>()
  const m4 = new THREE.Matrix4(), v = new THREE.Vector3(), eye = new THREE.Vector3()
  let cam: THREE.PerspectiveCamera | null = null, lastW = 0, lastH = 0
  let last: PathFrame | null = null

  const drop = (b: Built) => {
    for (const o of b.own) o.dispose()
    b.group.removeFromParent()
  }

  function build(c: Curve, selected: boolean, time: number): Built {
    const group = new THREE.Group()
    const own: (THREE.BufferGeometry | THREE.Material)[] = []
    const keep = <T extends THREE.BufferGeometry | THREE.Material>(o: T) => { own.push(o); return o }
    const color = new THREE.Color(c.color)
    const op = Math.max(0.05, Math.min(1, c.opacity ?? 1))
    const solid = keep(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.38, roughness: 0.45, metalness: 0, toneMapped: false, transparent: op < 1, opacity: op }))
    const ghost = keep(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22 * op, depthTest: false, depthWrite: false, toneMapped: false }))
    // The points' graphics and the ends can have a colour of their own.
    const matsOf = (hex: string | undefined): readonly [THREE.Material, THREE.Material] => {
      if (!hex || hex === c.color) return [ghost, solid]
      const col = new THREE.Color(hex)
      return [
        keep(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22 * op, depthTest: false, depthWrite: false, toneMapped: false })),
        keep(new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.38, roughness: 0.45, metalness: 0, toneMapped: false, transparent: op < 1, opacity: op })),
      ]
    }
    const body = (geo: THREE.BufferGeometry, place?: (m: THREE.Mesh) => void, mats: readonly [THREE.Material, THREE.Material] = [ghost, solid]) => {
      const pair: THREE.Mesh[] = []
      for (const [mat, order] of [[mats[0], 40], [mats[1], 41]] as const) {
        const m = new THREE.Mesh(geo, mat)
        m.renderOrder = order
        m.frustumCulled = false
        place?.(m)
        group.add(m)
        pair.push(m)
      }
      return pair
    }
    // The line stops inside whatever stands on its ends, so none of it
    // shows past an arrowhead's point.
    const shown = shownLine(c, 24)
    const ends = shown.ends
    const closed = !!c.closed && c.pts.length > 2
    const w = c.width
    const pat = patternOf(c)
    // Its size along it (a bulge at its points, its ends growing or
    // shrinking): the line is cut finer, so the change reads smooth.
    const field = fieldOf(c, shown.at, shown.len)
    const line = field ? fineLine(shown.line, Math.max(w * 0.75, shown.len / 500)) : shown.line
    // Pulsing in colour, each place has its own: white stuff, coloured
    // place by place.
    const tinted = !!field && !!c.pulseColor && c.mark === 'bulge'
    const dyed = (m: THREE.Material, vertex: boolean) => {
      const d = keep(m.clone()) as THREE.MeshStandardMaterial
      d.color.set(0xffffff)
      d.vertexColors = vertex
      return d
    }
    const lineMats = tinted ? [dyed(ghost, true), dyed(solid, true)] as const : [ghost, solid] as const
    const instMats = tinted ? [dyed(ghost, false), dyed(solid, false)] as const : [ghost, solid] as const
    const rgbAt = (s: number, tm: number) => tintRgb(c.color, field ? field.tint(s, tm) : 0)
    const tmpCol = new THREE.Color()
    // (A place's colour on the line itself is given as the light it is, not as it is written.)
    const linAt = (s: number, tm: number): [number, number, number] => { const v = rgbAt(s, tm); tmpCol.setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace); return [tmpCol.r, tmpCol.g, tmpCol.b] }
    const sized = (tm: number) => field ? (p: P3) => ({ k: field.k(p.s ?? 0, tm), rgb: tinted ? linAt(p.s ?? 0, tm) : undefined }) : undefined
    // What of it moves by itself, stepped on to the frame's time.
    const ticks: ((time: number) => void)[] = []
    if (line.length > 1 && !pat) {
      if (!field) body(keep(tube(line, w / 2, closed)))
      else {
        let geo: THREE.BufferGeometry | null = null
        let pair: THREE.Mesh[] | null = null
        const cut = (tm: number) => {
          const g = tube(line, w / 2, closed, 10, sized(tm))
          geo?.dispose()
          geo = g
          if (pair) for (const m of pair) m.geometry = g
          else pair = body(g, undefined, lineMats)
        }
        cut(time)
        own.push({ dispose: () => geo?.dispose() } as unknown as THREE.BufferGeometry)
        if (field.moves) ticks.push(cut)
      }
    } else if (line.length > 1 && pat) {
      const period = pat.period
      if (pat.unit === 'line') {
        // Lengths of the round line with gaps between (as the flat
        // drawing's). Running, they are cut again each step.
        let geo: THREE.BufferGeometry | null = null
        let pair: THREE.Mesh[] | null = null
        const cut = (shift: number, tm: number) => {
          const parts = dashPieces(line, pat.on, pat.gap, shift, c.flow ? 500 : 1500).filter(p => p.length > 1).map(p => tube(p, w / 2, false, 8, sized(tm)))
          const g = parts.length ? mergeGeometries(parts) : new THREE.BufferGeometry()
          for (const p of parts) p.dispose()
          geo?.dispose()
          geo = g
          if (pair) for (const m of pair) m.geometry = g
          else pair = body(g, undefined, lineMats)
        }
        cut(flowShift(c, period, time), time)
        own.push({ dispose: () => geo?.dispose() } as unknown as THREE.BufferGeometry)
        if (c.flow || field?.moves) ticks.push(t => cut(flowShift(c, period, t), t))
      } else if (pat.unit === 'hatch' || pat.unit === 'cube' || pat.unit === 'plus') {
        // Wire cubes, plus signs, or a road with chevrons: bars set to
        // the path, twist and all.
        const unit = pat.unit, t = barOf(c)
        const first = unitBars(c, line, unit, pat.on, period, flowShift(c, period, time), time, field)
        const cap = first.length + 80
        const inst = ([[instMats[0], 40], [instMats[1], 41]] as const).map(([mat, order]) => {
          const m = new THREE.InstancedMesh(BAR, mat, cap)
          m.renderOrder = order
          m.frustumCulled = false
          group.add(m)
          own.push({ dispose: () => m.dispose() } as unknown as THREE.BufferGeometry)
          return m
        })
        const place = (bars: Bar[]) => {
          const n = Math.min(cap, bars.length)
          for (let i = 0; i < n; i++) {
            const mat = barMatrix(bars[i], t)
            for (const m of inst) m.setMatrixAt(i, mat)
            if (tinted) { const rgb = tintRgb(c.color, bars[i][3] ?? 0); tmpCol.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace); for (const m of inst) m.setColorAt(i, tmpCol) }
          }
          for (const m of inst) { m.count = n; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true }
        }
        place(first)
        if (c.flow || (c.pulse && unit === 'hatch') || field?.moves) ticks.push(tm => place(unitBars(c, line, unit, pat.on, period, flowShift(c, period, tm), tm, field)))
      } else {
        // Balls or rings along the line, each `on` across.
        const tr = ringTube(c, pat.on)
        const geo = keep(pat.unit === 'ball' ? new THREE.SphereGeometry(pat.on / 2, 16, 12) : new THREE.TorusGeometry(pat.on / 2 - tr, tr, 8, 28))
        const cap = Math.min(600, Math.floor(lineLength(line) / period) + 2)
        const inst = ([[instMats[0], 40], [instMats[1], 41]] as const).map(([mat, order]) => {
          const m = new THREE.InstancedMesh(geo, mat, cap)
          m.renderOrder = order
          m.frustumCulled = false
          group.add(m)
          own.push({ dispose: () => m.dispose() } as unknown as THREE.BufferGeometry)
          return m
        })
        const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), at = new THREE.Vector3(), dv = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1)
        const place = (shift: number, tm: number) => {
          // The first stands half of itself in from the line's start.
          const spots = alongEvery(line, period, (shift + pat.on / 2) % period, cap)
          const n = Math.min(cap, spots.length)
          for (let i = 0; i < n; i++) {
            const s = spots[i]
            q.setFromUnitVectors(Z_UP, dv.set(s.d.x, s.d.y, s.d.z))
            if (field) one.setScalar(Math.max(0.0001, field.k(s.p.s ?? 0, tm)))
            mat.compose(at.set(s.p.x, s.p.y, s.p.z), q, one)
            for (const m of inst) m.setMatrixAt(i, mat)
            if (tinted) { const rgb = rgbAt(s.p.s ?? 0, tm); tmpCol.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace); for (const m of inst) m.setColorAt(i, tmpCol) }
          }
          for (const m of inst) { m.count = n; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true }
        }
        place(flowShift(c, period, time), time)
        if (c.flow || field?.moves) ticks.push(t => place(flowShift(c, period, t), t))
      }
    }
    // What stands on the ends: a cone with its point on the end, a cube
    // or a ball on it.
    const shaped = new Set<number>()
    const endMats = matsOf(c.endColor)
    for (const e of ends) {
      shaped.add(e.end ? c.pts.length - 1 : 0)
      const dv = new THREE.Vector3(e.dir.x, e.dir.y, e.dir.z)
      const size = e.size
      if (e.kind === 'arrow') {
        body(keep(new THREE.ConeGeometry(size * 0.46, size, 24)), m => {
          m.position.set(e.tip.x, e.tip.y, e.tip.z).addScaledVector(dv, -size / 2)
          m.quaternion.setFromUnitVectors(Y_UP, dv)
        }, endMats)
      } else if (e.kind === 'cube') {
        body(keep(new THREE.BoxGeometry(size, size, size)), m => {
          m.position.set(e.tip.x, e.tip.y, e.tip.z)
          // Square on to the line, turned with the path's twist there.
          // (Set to the way the path runs, not the way its start points
          // out: or the start's cube would roll backwards with the twist.)
          m.quaternion.copy(frameQuat(frameOf(e.end ? e.dir : { x: -e.dir.x, y: -e.dir.y, z: -e.dir.z }, e.tip.tw)))
        }, endMats)
      } else {
        body(keep(new THREE.SphereGeometry(size / 2, 22, 14)), m => m.position.set(e.tip.x, e.tip.y, e.tip.z), endMats)
      }
    }
    // The graphic at its points, where it is on and no end's shape
    // stands: set to the path there, twist and all.
    const frames = c.mark || selected ? pointFrames(c) : []
    const markMats = matsOf(c.markColor)
    // (A bulge is no shape of its own: it is the line's size there.)
    if (c.mark && c.mark !== 'bulge') {
      const bars: Bar[] = []
      c.pts.forEach((p, i) => { if (p.mark !== false && !shaped.has(i)) bars.push(...markBars(c.mark as 'corners' | 'cross', { x: p.x, y: p.y, z: p.z ?? 0 }, frames[i], markSize(c))) })
      const t = markBar(c)
      const parts = bars.map(b => BAR.clone().applyMatrix4(barMatrix(b, t)))
      if (parts.length) {
        body(keep(mergeGeometries(parts)), undefined, markMats)
        for (const p of parts) p.dispose()
      }
    }
    // Its points ping one after another: rings spreading from each,
    // fading as they go, always face on to the viewer.
    if (c.ping) {
      const far = pingSize(c), count = pingRings(c)
      const tex = ringTexture()
      const rings: { m: THREE.Sprite; mat: THREE.SpriteMaterial; i: number; j: number }[] = []
      c.pts.forEach((p, i) => {
        if (p.mark === false) return
        for (let j = 0; j < count; j++) {
          const mat = keep(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(c.markColor ?? c.color), transparent: true, opacity: 0, depthWrite: false, toneMapped: false }))
          const m = new THREE.Sprite(mat)
          m.position.set(p.x, p.y, p.z ?? 0)
          m.renderOrder = 42
          m.frustumCulled = false
          m.visible = false
          group.add(m)
          rings.push({ m, mat, i, j })
        }
      })
      const step = (tm: number) => rings.forEach(r => {
        const k = pingAt(r.i, c.pts.length, tm, c.pingSpeed ?? 1, r.j * PING_ECHO)
        r.m.visible = k !== null
        if (k === null) return
        r.m.scale.setScalar(Math.max(0.001, far * 2 * k))
        r.mat.opacity = op * (1 - k) * (1 - k)
      })
      step(time)
      ticks.push(step)
    }
    // The words by its points.
    const labels: Built['labels'] = []
    c.pts.forEach((p, i) => {
      if (!p.label) return
      const made = labelTexture(p.label, c.markColor ?? c.color)
      if (!made) return
      own.push(made.tex as unknown as THREE.BufferGeometry)
      const mat = keep(new THREE.SpriteMaterial({ map: made.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }))
      const sprite = new THREE.Sprite(mat)
      // Above the point: clear of its cube and its graphic.
      sprite.center.set(0.5, -0.9)
      sprite.position.set(p.x, p.y, p.z ?? 0)
      sprite.renderOrder = 62
      group.add(sprite)
      labels.push({ sprite, at: sprite.position, aspect: made.aspect })
      void i
    })
    // Selected: a cube on every point. A stem under each point off the
    // ground, always: how high the line runs there.
    const cubes: Knob[] = []
    const stems: number[] = []
    c.pts.forEach((p, i) => {
      if (Math.abs(p.z ?? 0) > 1e-6) stems.push(p.x, p.y, 0, p.x, p.y, p.z!)
      if (!selected) return
      const mat = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0, depthTest: false, depthWrite: false, toneMapped: false, transparent: true }))
      const mesh = new THREE.Mesh(CUBE, mat)
      mesh.position.set(p.x, p.y, p.z ?? 0)
      // It sits as the path runs there, twist and all.
      if (frames[i]) mesh.quaternion.copy(frameQuat(frames[i]))
      mesh.renderOrder = 60
      const edges = new THREE.LineSegments(CUBE_EDGES, EDGE_MAT)
      edges.renderOrder = 61
      mesh.add(edges)
      group.add(mesh)
      cubes.push({ mesh, at: mesh.position, px: CUBE_PX, key: `p:${c.id}:${i}`, base: color.getHex() })
    })
    if (stems.length) {
      const g = keep(new THREE.BufferGeometry())
      g.setAttribute('position', new THREE.Float32BufferAttribute(stems, 3))
      const l = new THREE.LineSegments(g, STEM_MAT)
      l.renderOrder = 50
      l.frustumCulled = false
      group.add(l)
    }
    // Selected: the tangent handles of the points that have their own (a
    // smooth curve finds the others' itself).
    const handles: Built['handles'] = []
    if (selected) {
      const arms: number[] = []
      const eff = curvePoints(c)
      eff.forEach((p, i) => {
        if (p.t === 'corner' || (c.smooth && !ownsHandles(p))) return
        for (const side of ['in', 'out'] as const) {
          const h = side === 'in' ? p.hin : p.hout
          if (!h || (Math.abs(h.x) < 1e-6 && Math.abs(h.y) < 1e-6 && Math.abs(h.z ?? 0) < 1e-6)) continue
          const z = p.z ?? 0
          const mat = keep(new THREE.MeshStandardMaterial({ color: COL.handle, roughness: 0.5, depthTest: false, depthWrite: false, toneMapped: false, transparent: true }))
          const mesh = new THREE.Mesh(BALL, mat)
          mesh.position.set(p.x + h.x, p.y + h.y, z + (h.z ?? 0))
          mesh.renderOrder = 58
          group.add(mesh)
          arms.push(p.x, p.y, z, mesh.position.x, mesh.position.y, mesh.position.z)
          handles.push({ mesh, at: mesh.position, px: HANDLE_PX, key: `h:${c.id}:${i}:${side}`, base: COL.handle, i, side })
        }
      })
      if (arms.length) {
        const g = keep(new THREE.BufferGeometry())
        g.setAttribute('position', new THREE.Float32BufferAttribute(arms, 3))
        const l = new THREE.LineSegments(g, ARM_MAT)
        l.renderOrder = 55
        l.frustumCulled = false
        group.add(l)
      }
    }
    root.add(group)
    return { curve: c, selected, group, own, cubes, handles, labels, flow: ticks.length ? t => { for (const f of ticks) f(t) } : undefined }
  }

  /** Draw the curves over what the frame drew. `ground` is the canvas's
   *  plane in the scene (flat px from the host centre, z up off it).
   *  `plain`: the line alone, no cubes or handles (looking through a
   *  camera). */
  function render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, ground: THREE.Matrix4, f: PathFrame | undefined, W: number, H: number, plain: boolean) {
    cam = camera; lastW = W; lastH = H
    last = f ?? null
    const seen = new Set<string>()
    if (f) {
      for (const c of f.curves) {
        seen.add(c.id)
        const sel = f.selected.has(c.id)
        const b = built.get(c.id)
        if (b && b.curve === c && b.selected === sel) { b.flow?.(f.time); continue }
        if (b) drop(b)
        built.set(c.id, build(c, sel, f.time))
      }
    }
    for (const [id, b] of built) if (!seen.has(id)) { drop(b); built.delete(id) }
    if (!f || !built.size) return
    // Canvas units → the plane: scaled by the zoom, y down the canvas.
    root.matrix.copy(ground).multiply(m4.makeTranslation(f.ox, -f.oy, 0)).multiply(m4.makeScale(f.zoom, -f.zoom, f.zoom))
    root.matrixWorldNeedsUpdate = true
    root.updateMatrixWorld(true)
    camera.updateMatrixWorld()
    camera.getWorldPosition(eye)
    const fwd = camera.getWorldDirection(new THREE.Vector3())
    // Screen px per scene unit, one unit ahead of the eye.
    const pxPer = H / 2 / Math.tan(camera.fov * Math.PI / 360)
    const unit = new THREE.Vector3().setFromMatrixScale(root.matrixWorld).x || 1
    const size = (k: Knob) => {
      v.copy(k.at).applyMatrix4(root.matrixWorld)
      const depth = v.sub(eye).dot(fwd)
      k.mesh.visible = !plain && depth > camera.near
      k.mesh.scale.setScalar(k.px * Math.max(depth, 1e-3) / pxPer / unit)
    }
    for (const b of built.values()) {
      for (const k of b.cubes) {
        size(k)
        const mat = k.mesh.material as THREE.MeshStandardMaterial
        const key = k.key.slice(2)
        mat.color.setHex(f.points.has(key) ? COL.picked : b.selected ? COL.selected : k.base)
        if (f.hot === k.key) mat.color.lerp(new THREE.Color(COL.hot), f.points.has(key) ? 0.35 : 0.7)
      }
      for (const k of b.handles) {
        size(k)
        ;(k.mesh.material as THREE.MeshStandardMaterial).color.setHex(f.hot === k.key ? COL.selected : k.base)
      }
      for (const l of b.labels) {
        v.copy(l.at).applyMatrix4(root.matrixWorld)
        const depth = v.sub(eye).dot(fwd)
        l.sprite.visible = depth > camera.near
        const hgt = LABEL_PX * Math.max(depth, 1e-3) / pxPer / unit
        // (The plane's y runs down the canvas: turned back, so the words read.)
        l.sprite.scale.set(hgt * l.aspect, -hgt, 1)
      }
    }
    renderer.render(scene, camera)
  }

  /** Where a point (canvas units, z up) is drawn: px on the 3D canvas.
   *  Null behind the eye. */
  function project(p: P3): { x: number; y: number } | null {
    if (!cam || !last) return null
    v.set(p.x, p.y, p.z).applyMatrix4(root.matrixWorld)
    const fwd = cam.getWorldDirection(new THREE.Vector3())
    if (v.clone().sub(eye).dot(fwd) <= cam.near) return null
    v.project(cam)
    return { x: (v.x + 1) / 2 * lastW, y: (1 - v.y) / 2 * lastH }
  }

  /** What of a curve is at (x, y) (px on the 3D canvas): a point's cube,
   *  a handle, or the line. `only`: just these curves. */
  function at(x: number, y: number, only?: Set<string>): PathHit | null {
    const f = last
    if (!f || !cam) return null
    let best: { hit: PathHit; d: number } | null = null
    const take = (hit: PathHit, d: number, bias: number) => { if (!best || d - bias < best.d) best = { hit, d: d - bias } }
    for (const b of built.values()) {
      const c = b.curve
      if (only && !only.has(c.id)) continue
      b.cubes.forEach((k, i) => {
        const q = project({ x: k.at.x, y: k.at.y, z: k.at.z })
        if (!q) return
        const d = Math.hypot(x - q.x, y - q.y)
        if (d < CUBE_PX * 0.5 + 4) take({ kind: 'point', id: c.id, i }, d, 40)
      })
      for (const h of b.handles) {
        const q = project({ x: h.at.x, y: h.at.y, z: h.at.z })
        if (!q) continue
        const d = Math.hypot(x - q.x, y - q.y)
        if (d < HANDLE_PX * 0.5 + 5) take({ kind: 'handle', id: c.id, i: h.i, side: h.side }, d, 20)
      }
      const near = nearestOnCurve(c, project, x, y)
      if (near && near.d < Math.max(7, c.width * f.zoom / 2 + 4)) take({ kind: 'line', id: c.id, seg: near.seg, t: near.t }, near.d, 0)
    }
    return best ? (best as { hit: PathHit }).hit : null
  }

  function dispose() {
    for (const b of built.values()) drop(b)
    built.clear()
  }

  return { render, at, project, dispose }
}
