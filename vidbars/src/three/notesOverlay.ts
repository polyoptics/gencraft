// notesOverlay.ts — what the 3D notes tools draw on the standing models
// (store/notesStore): coloured strokes on a model's surface, and the dots
// of its pins. Drawn in a scene of their own after the models, against
// their depth, so a stroke round the back of a model is hidden by it. Each
// model's notes ride its own matrix (copied each frame), so they stay on
// the surface as it turns, grows in and is sized.
//
// The pins' labels are page elements (components/Notes/PinLabels), crisp
// at every size: this works out where each pin is on screen every frame
// and hands that over (pinSpots).

import * as THREE from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import type { ModelNotes } from '../store/notesStore'

/** What the overlay needs of a model standing in the 3D view. */
export interface NotesHost {
  url: string
  inst: THREE.Object3D | null
  visible: boolean
  /** What to raycast for whether a pin is hidden behind the model. */
  body: THREE.Object3D
  /** The model's size (the diagonal of its box, its own units). */
  size: number
}

/** A pin on screen: px from the 3D canvas's top-left. */
export interface PinSpot {
  /** `${model key}|${pin id}`. */
  id: string
  key: string
  url: string
  pinId: string
  x: number
  y: number
  /** Where its label sits on screen (its 3D spot, ModelPin.at). */
  lx: number
  ly: number
  /** Behind the model, seen from here. */
  hidden: boolean
}

/** A pin's label spot, model space: its own, or a little way out from the
 *  pin along its normal, leaning up. */
export function labelSpot(p: { p: [number, number, number]; n: [number, number, number]; at?: [number, number, number] }, size: number): THREE.Vector3 {
  if (p.at) return new THREE.Vector3(...p.at)
  const d = new THREE.Vector3(...p.n).normalize().add(new THREE.Vector3(0, 0.7, 0)).normalize()
  return new THREE.Vector3(...p.p).addScaledVector(d, size * 0.12)
}

export const PIN_COLORS = { open: 0x7fd4ff, resolved: 0x5fe39b } as const

function dotTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2)
  g.fillStyle = '#ffffff'; g.fill()
  g.lineWidth = 8; g.strokeStyle = 'rgba(10,12,20,0.9)'; g.stroke()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

interface Built {
  group: THREE.Group
  notes: ModelNotes | undefined
  lines: Line2[]
  dots: { sprite: THREE.Sprite; pinId: string; local: THREE.Vector3; label: THREE.Vector3 }[]
  size: number
  /** Which pins were last seen hidden, and when that was checked (frame). */
  hidden: Map<string, boolean>
  checkedAt: number
}

export function createNotesOverlay() {
  const scene = new THREE.Scene()
  const built = new Map<string, Built>()
  const dotTex = dotTexture()
  const spots: PinSpot[] = []
  let frameNo = 0
  const ray = new THREE.Raycaster()
  const v = new THREE.Vector3(), eye = new THREE.Vector3()

  const clear = (b: Built) => {
    for (const l of b.lines) { l.geometry.dispose(); (l.material as LineMaterial).dispose() }
    for (const d of b.dots) (d.sprite.material as THREE.SpriteMaterial).dispose()
    b.group.clear()
    b.lines = []
    b.dots = []
  }
  const build = (b: Built, notes: ModelNotes | undefined, size: number) => {
    clear(b)
    b.notes = notes
    b.size = size
    if (!notes) return
    for (const s of notes.strokes) {
      if (s.pts.length < 6) continue
      const geo = new LineGeometry()
      geo.setPositions(s.pts)
      const mat = new LineMaterial({ color: new THREE.Color(s.color), linewidth: s.width, transparent: true, depthTest: true, depthWrite: false, toneMapped: false })
      const line = new Line2(geo, mat)
      line.computeLineDistances()
      line.frustumCulled = false
      line.renderOrder = 20
      b.group.add(line)
      b.lines.push(line)
    }
    for (const p of notes.pins) {
      const mat = new THREE.SpriteMaterial({
        map: dotTex, color: PIN_COLORS[p.status], sizeAttenuation: false,
        depthTest: false, depthWrite: false, transparent: true, toneMapped: false,
      })
      const sprite = new THREE.Sprite(mat)
      const local = new THREE.Vector3(...p.p)
      sprite.position.copy(local)
      sprite.renderOrder = 30
      sprite.frustumCulled = false
      b.group.add(sprite)
      b.dots.push({ sprite, pinId: p.id, local, label: labelSpot(p, size) })
    }
  }

  /** Draw the notes of the models standing now, over what the frame drew. */
  function render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, standing: Map<string, NotesHost>,
    notesOf: ((url: string) => ModelNotes | undefined) | undefined, fade: number, W: number, H: number) {
    frameNo++
    spots.length = 0
    if (!notesOf) return
    let any = false
    for (const [key, s] of standing) {
      const notes = notesOf(s.url)
      let b = built.get(key)
      if (!notes && !b) continue
      if (!b) {
        const group = new THREE.Group()
        group.matrixAutoUpdate = false
        scene.add(group)
        b = { group, notes: undefined, lines: [], dots: [], hidden: new Map(), checkedAt: -999, size: 0 }
        built.set(key, b)
      }
      if (b.notes !== notes || b.size !== s.size) build(b, notes, s.size)
      b.group.visible = !!s.inst && s.visible && !!notes && (notes.strokes.length + notes.pins.length > 0)
      if (!b.group.visible || !s.inst) continue
      any = true
      s.inst.updateWorldMatrix(true, false)
      b.group.matrix.copy(s.inst.matrixWorld)
      b.group.matrixWorldNeedsUpdate = true
      for (const l of b.lines) {
        const m = l.material as LineMaterial
        m.resolution.set(W, H)
        m.opacity = fade
      }
      // Is a pin round the back? A ray to it, against the model, now and
      // then (a ray through a big model each frame is not free).
      const check = frameNo - b.checkedAt > 12
      if (check) b.checkedAt = frameNo
      camera.getWorldPosition(eye)
      const worldScale = Math.max(1e-9, new THREE.Vector3().setFromMatrixScale(s.inst.matrixWorld).x)
      for (const d of b.dots) {
        const mat = d.sprite.material as THREE.SpriteMaterial
        // A constant size on screen: the sprite is drawn at its scale times
        // the model's, so the model's is taken back out.
        const sz = 0.013 / worldScale
        d.sprite.scale.set(sz, sz, 1)
        v.copy(d.local).applyMatrix4(s.inst.matrixWorld)
        if (check) {
          const dist = eye.distanceTo(v)
          ray.set(eye, v.clone().sub(eye).normalize())
          ray.far = dist
          const hit = ray.intersectObject(s.body, true)[0]
          b.hidden.set(d.pinId, !!hit && hit.distance < dist * 0.995)
        }
        const hidden = b.hidden.get(d.pinId) ?? false
        mat.opacity = fade * (hidden ? 0.35 : 1)
        v.project(camera)
        if (v.z > 1) continue
        const l = d.label.clone().applyMatrix4(s.inst.matrixWorld).project(camera)
        spots.push({
          id: `${key}|${d.pinId}`, key, url: s.url, pinId: d.pinId,
          x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H,
          lx: (l.x + 1) / 2 * W, ly: (1 - l.y) / 2 * H, hidden,
        })
      }
    }
    for (const [key, b] of built) {
      if (!standing.has(key)) { clear(b); b.group.removeFromParent(); built.delete(key) }
    }
    if (!any) return
    renderer.render(scene, camera)
  }

  /** Where the ray through (x, y) (px on the 3D canvas) meets model `key`'s
   *  surface, in the model's own space, with its normal there. */
  function surfaceAt(camera: THREE.PerspectiveCamera, W: number, H: number, s: NotesHost, x: number, y: number):
    { p: THREE.Vector3; n: THREE.Vector3 } | null {
    if (!s.inst) return null
    ray.far = Infinity
    ray.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), camera)
    const hit = ray.intersectObject(s.body, true)[0]
    if (!hit) return null
    s.inst.updateWorldMatrix(true, false)
    const inv = new THREE.Matrix4().copy(s.inst.matrixWorld).invert()
    const p = hit.point.clone().applyMatrix4(inv)
    let n = new THREE.Vector3(0, 1, 0)
    if (hit.face) {
      // The face's normal, into the model's space (through the hit mesh's
      // own transform).
      const nm = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)
      n = hit.face.normal.clone().applyMatrix3(nm).normalize()
      const back = new THREE.Matrix3().getNormalMatrix(inv)
      n.applyMatrix3(back).normalize()
      // Facing the eye: a back face hit (double-sided) points away.
      const toEye = ray.ray.direction.clone().negate()
      const wn = hit.face.normal.clone().applyMatrix3(nm)
      if (wn.dot(toEye) < 0) n.negate()
    }
    return { p, n }
  }

  /** Where the ray through (x, y) meets the plane facing the eye through
   *  `through` (model space): in model space. Where a label dragged there
   *  sits, at the depth it was. */
  function planeAt(camera: THREE.PerspectiveCamera, W: number, H: number, s: NotesHost, through: THREE.Vector3, x: number, y: number): THREE.Vector3 | null {
    if (!s.inst) return null
    s.inst.updateWorldMatrix(true, false)
    const w = through.clone().applyMatrix4(s.inst.matrixWorld)
    const n = new THREE.Vector3(); camera.getWorldDirection(n)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, w)
    ray.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), camera)
    const hit = ray.ray.intersectPlane(plane, new THREE.Vector3())
    if (!hit) return null
    return hit.applyMatrix4(new THREE.Matrix4().copy(s.inst.matrixWorld).invert())
  }

  /** The stroke drawn on a model nearest (x, y) on screen, within `tol` px
   *  of its line (plus half its width): its model and id. */
  function strokeAt(camera: THREE.PerspectiveCamera, W: number, H: number, x: number, y: number, tol = 8): { url: string; id: string } | null {
    let best: { url: string; id: string; d: number } | null = null
    const a = new THREE.Vector3(), c = new THREE.Vector3()
    for (const b of built.values()) {
      if (!b.group.visible || !b.notes) continue
      for (const st of b.notes.strokes) {
        let prev: { x: number; y: number } | null = null
        for (let i = 0; i + 2 < st.pts.length; i += 3) {
          a.set(st.pts[i], st.pts[i + 1], st.pts[i + 2]).applyMatrix4(b.group.matrix).project(camera)
          if (a.z > 1) { prev = null; continue }
          const q = { x: (a.x + 1) / 2 * W, y: (1 - a.y) / 2 * H }
          const p0 = prev ?? q
          // Distance from (x, y) to the segment p0 → q.
          c.set(q.x - p0.x, q.y - p0.y, 0)
          const len2 = c.x * c.x + c.y * c.y
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - p0.x) * c.x + (y - p0.y) * c.y) / len2)) : 0
          const d = Math.hypot(x - (p0.x + c.x * t), y - (p0.y + c.y * t)) - st.width / 2
          if (d < tol && (!best || d < best.d)) best = { url: b.notes.url, id: st.id, d }
          prev = q
        }
      }
    }
    return best && { url: best.url, id: best.id }
  }

  function forget(key: string) {
    const b = built.get(key)
    if (!b) return
    clear(b); b.group.removeFromParent(); built.delete(key)
  }

  function dispose() {
    for (const k of [...built.keys()]) forget(k)
    dotTex.dispose()
  }

  return { render, surfaceAt, planeAt, strokeAt, forget, dispose, spots: () => spots }
}
