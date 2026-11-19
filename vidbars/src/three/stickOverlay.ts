// stickOverlay.ts — the measuring sticks in the 3D view (store/notesStore
// sticks; Brian 2026-11-18: "a measuring stick... so that I can put it up
// against things like a lineup of characters"). Tilted, a stick is a real
// thing in the scene: a pole standing on its foot plate, banded red and
// white a foot at a time, a collar at its 6 ft mark, a number by each
// foot and a round sign on its top that says how tall it is and always
// faces the viewer (a bus stop's). It stands up off the canvas as the
// view tips back, from lying flat pointing up the canvas, which is how
// the flat view draws it (components/Notes/StickLayer). Drawn after the
// models, against their depth: where something stands in front of it, it
// shows through faintly, so it is never lost (as three/pathOverlay).
//
// This also answers where a stick's foot, top and sign are on screen
// (spots), for utils/stickTool.

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Stick } from '../store/notesStore'
import { STICK_FT, POLE_R, SIGN_R, BASE_R, BASE_H, MARK_R, MARK_H, NUM_H, RED, WHITE, MARK, DARK, ACCENT, feetText, stickBands, stickNumbers } from '../utils/stickGeom'

/** What the 3D view draws of the sticks this frame. */
export interface StickFrame {
  sticks: Stick[]
  selected: string | null
  /** The part under the cursor: `${id}:top` or `${id}:body`. */
  hot: string | null
  zoom: number
  /** The canvas's origin, flat px from the host centre. */
  ox: number
  oy: number
}

type Pt = { x: number; y: number }
/** A stick on screen, px on the 3D canvas: its foot, the top of its pole,
 *  and its sign (its middle and radius). */
export interface StickSpot { id: string; foot: Pt; top: Pt; sign: Pt; r: number }

/** The round sign: white, a ring round its edge, the height in its middle. */
function signTexture(text: string, ring: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 256
  const g = cv.getContext('2d')!
  g.beginPath(); g.arc(128, 128, 124, 0, Math.PI * 2); g.fillStyle = DARK; g.fill()
  g.beginPath(); g.arc(128, 128, 116, 0, Math.PI * 2); g.fillStyle = ring; g.fill()
  g.beginPath(); g.arc(128, 128, 94, 0, Math.PI * 2); g.fillStyle = WHITE; g.fill()
  g.fillStyle = DARK
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  let px = 104
  do { g.font = `700 ${px}px system-ui, sans-serif`; px -= 6 } while (g.measureText(text).width > 160 && px > 20)
  g.fillText(text, 128, 134)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** A number by a foot: light on a dark edge, so it reads over anything. */
function numTexture(text: string): { tex: THREE.CanvasTexture; aspect: number } {
  const cv = document.createElement('canvas')
  const g = cv.getContext('2d')!
  const font = '700 44px system-ui, sans-serif'
  g.font = font
  const w = Math.ceil(g.measureText(text).width) + 20, h = 56
  cv.width = w; cv.height = h
  g.font = font
  g.textBaseline = 'middle'
  g.lineJoin = 'round'
  g.lineWidth = 9
  g.strokeStyle = 'rgba(8,10,20,0.9)'
  g.strokeText(text, 10, h / 2 + 2)
  g.fillStyle = '#fff'
  g.fillText(text, 10, h / 2 + 2)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return { tex, aspect: w / h }
}

interface Built {
  /** What it was built from: its height and how it is lit. */
  sig: string
  ft: number
  /** In feet: scaled by the stick's `per`, at its foot. */
  group: THREE.Group
  own: { dispose: () => void }[]
}

/** A round bar up the pole (feet), from `from` to `to`. */
const bar = (r: number, from: number, to: number, radial = 18) =>
  new THREE.CylinderGeometry(r, r, to - from, radial).rotateX(Math.PI / 2).translate(0, 0, (from + to) / 2)

export function createStickOverlay() {
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x59607a, 1.5))
  const sun = new THREE.DirectionalLight(0xffffff, 1.6)
  sun.position.set(-0.5, 0.9, 1)
  scene.add(sun)
  const root = new THREE.Group()
  root.matrixAutoUpdate = false
  scene.add(root)
  const built = new Map<string, Built>()
  const m4 = new THREE.Matrix4(), v = new THREE.Vector3(), eye = new THREE.Vector3(), fwd = new THREE.Vector3()
  let cam: THREE.PerspectiveCamera | null = null, lastW = 0, lastH = 0, drawn = false

  const drop = (b: Built) => {
    for (const o of b.own) o.dispose()
    b.group.removeFromParent()
  }

  function build(s: Stick, sig: string, selected: boolean, hotTop: boolean): Built {
    const group = new THREE.Group()
    const own: Built['own'] = []
    const keep = <T extends { dispose: () => void }>(o: T) => { own.push(o); return o }
    // Each colour twice: faint through whatever stands in front of it,
    // then solid where nothing does.
    const body = (geo: THREE.BufferGeometry, hex: string) => {
      const color = new THREE.Color(hex)
      const ghost = keep(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false, toneMapped: false }))
      const solid = keep(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.38, roughness: 0.45, metalness: 0, toneMapped: false }))
      keep(geo)
      for (const [mat, order] of [[ghost, 40], [solid, 41]] as const) {
        const m = new THREE.Mesh(geo, mat)
        m.renderOrder = order
        m.frustumCulled = false
        group.add(m)
      }
    }
    const merged = (parts: THREE.BufferGeometry[]) => {
      const g = mergeGeometries(parts)
      for (const p of parts) p.dispose()
      return g
    }
    const bands = stickBands(s.ft)
    const red = bands.filter(b => b.red).map(b => bar(POLE_R, b.from, b.to))
    const white = bands.filter(b => !b.red).map(b => bar(POLE_R, b.from, b.to))
    if (red.length) body(merged(red), RED)
    if (white.length) body(merged(white), WHITE)
    // Its foot plate (lit while it is selected), and the collar at 6 ft.
    body(bar(BASE_R, 0, BASE_H, 40), selected ? ACCENT : DARK)
    if (s.ft >= STICK_FT - 1e-6) body(bar(MARK_R, STICK_FT - MARK_H / 2, STICK_FT + MARK_H / 2, 24), MARK)
    // The sign on its top, and the numbers by its feet: face on to the
    // viewer, wherever they look from.
    const sprite = (tex: THREE.Texture, w: number, h: number, z: number, cx: number) => {
      keep(tex)
      for (const [ghost, order] of [[true, 40], [false, 42]] as const) {
        const mat = keep(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: ghost ? 0.22 : 1, alphaTest: ghost ? 0 : 0.5, depthTest: !ghost, depthWrite: !ghost, toneMapped: false }))
        const sp = new THREE.Sprite(mat)
        sp.center.set(cx, 0.5)
        sp.position.set(0, 0, z)
        sp.scale.set(w, h, 1)
        sp.renderOrder = order
        sp.frustumCulled = false
        group.add(sp)
      }
    }
    sprite(signTexture(feetText(s.ft), selected || hotTop ? ACCENT : RED), SIGN_R * 2, SIGN_R * 2, s.ft + SIGN_R, 0.5)
    for (const n of stickNumbers(s.ft)) {
      const t = numTexture(String(n))
      sprite(t.tex, NUM_H * t.aspect, NUM_H, n, -0.25)
    }
    root.add(group)
    return { sig, ft: s.ft, group, own }
  }

  /** Draw the sticks over what the frame drew. `ground` is the canvas's
   *  plane in the scene (flat px from the host centre, z up off it).
   *  `rise`: how far up they stand, 0 (lying flat, pointing up the
   *  canvas) to 1 (standing). */
  function render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, ground: THREE.Matrix4, f: StickFrame | undefined, W: number, H: number, rise: number) {
    cam = camera; lastW = W; lastH = H
    drawn = false
    const seen = new Set<string>()
    if (f) {
      for (const s of f.sticks) {
        seen.add(s.id)
        const selected = f.selected === s.id, hotTop = f.hot === `${s.id}:top`
        const sig = `${s.ft}|${selected}|${hotTop}`
        let b = built.get(s.id)
        if (!b || b.sig !== sig) {
          if (b) drop(b)
          b = build(s, sig, selected, hotTop)
          built.set(s.id, b)
        }
        b.group.position.set(s.x, s.y, 0)
        b.group.scale.setScalar(s.per)
        // About its foot: lying, it points up the canvas (y runs down it).
        b.group.rotation.set((1 - Math.max(0, Math.min(1, rise))) * Math.PI / 2, 0, 0)
      }
    }
    for (const [id, b] of built) if (!seen.has(id)) { drop(b); built.delete(id) }
    if (!f || !built.size) return
    // Canvas units → the plane: scaled by the zoom, y down the canvas.
    root.matrix.copy(ground).multiply(m4.makeTranslation(f.ox, -f.oy, 0)).multiply(m4.makeScale(f.zoom, -f.zoom, f.zoom))
    root.matrixWorldNeedsUpdate = true
    root.updateMatrixWorld(true)
    camera.updateMatrixWorld()
    renderer.render(scene, camera)
    drawn = true
  }

  /** Where the sticks were last drawn, px on the 3D canvas. One behind
   *  the eye is left out. */
  function spots(): StickSpot[] {
    if (!cam || !drawn) return []
    cam.getWorldPosition(eye)
    cam.getWorldDirection(fwd)
    const pxPer = lastH / 2 / Math.tan(cam.fov * Math.PI / 360)
    const px = (z: number, b: Built): (Pt & { depth: number }) | null => {
      v.set(0, 0, z).applyMatrix4(b.group.matrixWorld)
      const depth = v.clone().sub(eye).dot(fwd)
      if (depth <= cam!.near) return null
      v.project(cam!)
      return { x: (v.x + 1) / 2 * lastW, y: (1 - v.y) / 2 * lastH, depth }
    }
    const out: StickSpot[] = []
    for (const [id, b] of built) {
      const foot = px(0, b), top = px(b.ft, b), sign = px(b.ft + SIGN_R, b)
      if (!foot || !top || !sign) continue
      const unit = v.setFromMatrixScale(b.group.matrixWorld).x || 1
      out.push({ id, foot, top, sign, r: SIGN_R * unit * pxPer / sign.depth })
    }
    return out
  }

  function dispose() {
    for (const b of built.values()) drop(b)
    built.clear()
  }

  return { render, spots, dispose }
}
