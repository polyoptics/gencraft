// stickOverlay.ts — the measuring sticks in the 3D view (store/notesStore
// sticks; Brian 2026-11-18: "a measuring stick... so that I can put it up
// against things like a lineup of characters"). Tilted, a stick is a real
// thing in the scene, made as his picture of a bus stop pole: feet spread
// on the ground, a short thick lower tube, a thinner tube out of it
// ticked like a ruler (a ring round it at every mark, a number by the
// main ones), and a board on its top that says how tall it is and always
// faces the viewer. It stands up off the canvas as the view tips back,
// from lying flat pointing up the canvas, which is how the flat view
// draws it (components/Notes/StickLayer). Drawn after the models, against
// their depth: where something stands in front of it, it shows through
// faintly, so it is never lost (as three/pathOverlay).
//
// This also answers where a stick's foot, top and board are on screen
// (spots), for utils/stickTool.

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Stick } from '../store/notesStore'
import { POLE_R, LOWER_R, LOWER_TOP, BASE_R, BASE_H, SIGN_W, SIGN_H, SIGN_CUT, SIGN_TEXT, NUM_H, CREAM, GREEN, ORANGE, DARK, ACCENT, DEFAULT_FONT, TICK, heightText, unitText, stickTicks } from '../utils/stickGeom'

/** What the 3D view draws of the sticks this frame. */
export interface StickFrame {
  sticks: Stick[]
  selected: string | null
  /** The part under the cursor: `${id}:top` or `${id}:body`. */
  hot: string | null
  /** The sticks docked to cards (utils/stickDock). */
  docked: Set<string>
  /** Bumped when a font has loaded: the boards are drawn again. */
  fontRev: number
  zoom: number
  /** The canvas's origin, flat px from the host centre. */
  ox: number
  oy: number
}

type Pt = { x: number; y: number }
/** A stick on screen, px on the 3D canvas: its foot, the top of its pole,
 *  and its board (its middle, half its width and half its height). */
export interface StickSpot { id: string; foot: Pt; top: Pt; sign: Pt; hw: number; hh: number }

/** The board: cream with its corners cut, the height in orange over a
 *  rule, the unit small under it. */
function signTexture(s: Stick, edge: string): THREE.CanvasTexture {
  const W = 496, H = Math.round(W * SIGN_H / SIGN_W)
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const g = cv.getContext('2d')!
  const cut = SIGN_CUT / (SIGN_W * 2) * W
  const board = (inset: number) => {
    const c = cut + inset * 0.4
    g.beginPath()
    g.moveTo(c, inset); g.lineTo(W - c, inset); g.lineTo(W - inset, c); g.lineTo(W - inset, H - c)
    g.lineTo(W - c, H - inset); g.lineTo(c, H - inset); g.lineTo(inset, H - c); g.lineTo(inset, c)
    g.closePath()
  }
  board(2); g.fillStyle = DARK; g.fill()
  board(8); g.fillStyle = edge; g.fill()
  board(20); g.fillStyle = CREAM; g.fill()
  const rule = H * SIGN_TEXT
  const text = heightText(s)
  g.fillStyle = ORANGE
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  let px = Math.round(rule * 0.78)
  const font = s.font ?? DEFAULT_FONT
  do { g.font = `700 ${px}px ${font}`; px -= 6 } while (g.measureText(text).width > W - 84 && px > 20)
  g.fillText(text, W / 2, 20 + (rule - 20) / 2 + 4)
  g.fillRect(40, rule, W - 80, 10)
  g.fillStyle = GREEN
  g.font = `700 ${Math.round((H - rule) * 0.42)}px ${DEFAULT_FONT}`
  try { (g as unknown as { letterSpacing: string }).letterSpacing = '6px' } catch { /* older canvas */ }
  g.fillText(unitText(s), W / 2, rule + (H - 20 - rule) / 2 + 8)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** A number by a mark: light on a dark edge, so it reads over anything. */
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

/** A round bar up the pole (feet), from `from` to `to`: `r` across at
 *  its top, `r0` at its bottom (the same, unless given). */
const bar = (r: number, from: number, to: number, radial = 18, r0 = r) =>
  new THREE.CylinderGeometry(r, r0, to - from, radial).rotateX(Math.PI / 2).translate(0, 0, (from + to) / 2)

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

  function build(s: Stick, sig: string, selected: boolean, hotTop: boolean, docked: boolean): Built {
    const group = new THREE.Group()
    const own: Built['own'] = []
    const keep = <T extends { dispose: () => void }>(o: T) => { own.push(o); return o }
    const merged = (parts: THREE.BufferGeometry[]) => {
      const g = mergeGeometries(parts)
      for (const p of parts) p.dispose()
      return g
    }
    // Each colour twice: faint through whatever stands in front of it,
    // then solid where nothing does.
    const body = (parts: THREE.BufferGeometry[], hex: string) => {
      if (!parts.length) return
      const geo = keep(parts.length > 1 ? merged(parts) : parts[0])
      const color = new THREE.Color(hex)
      const ghost = keep(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false, toneMapped: false }))
      const solid = keep(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.38, roughness: 0.45, metalness: 0, toneMapped: false }))
      for (const [mat, order] of [[ghost, 40], [solid, 41]] as const) {
        const m = new THREE.Mesh(geo, mat)
        m.renderOrder = order
        m.frustumCulled = false
        group.add(m)
      }
    }
    const ticks = stickTicks(s)
    const j = BASE_H + 0.08
    // Its feet (lit while it is selected) and the joints: the machine's green.
    body([bar(LOWER_R + 0.035, 0, BASE_H, 6, BASE_R)], selected ? ACCENT : GREEN)
    body([
      bar(LOWER_R + 0.03, BASE_H, j, 20),
      bar(LOWER_R + 0.022, LOWER_TOP - 0.07, LOWER_TOP + 0.03, 20),
      bar(POLE_R + 0.03, s.ft - 0.05, s.ft + 0.05, 16),
      ...ticks.filter(t => t.k < 3).map(t => bar(TICK[t.k].r, t.at - TICK[t.k].h / 2, t.at + TICK[t.k].h / 2, 14)),
    ], GREEN)
    // The thick lower tube, and the thinner one that goes up and down out of it.
    body([bar(LOWER_R, j, LOWER_TOP - 0.07, 22), bar(POLE_R, LOWER_TOP + 0.03, s.ft - 0.05, 16)], CREAM)
    // A stripe on the lower tube, the mark, and (docked) a ring on the
    // ground round its feet.
    body([
      bar(LOWER_R + 0.004, 0.46, 0.6, 22),
      ...ticks.filter(t => t.k === 3).map(t => bar(TICK[3].r, t.at - TICK[3].h / 2, t.at + TICK[3].h / 2, 18)),
      ...(docked ? [new THREE.RingGeometry(BASE_R + 0.06, BASE_R + 0.11, 48).translate(0, 0, 0.004)] : []),
    ], ORANGE)
    // The board on its top, and the numbers by its marks: face on to the
    // viewer, wherever they look from.
    const sprite = (tex: THREE.Texture, w: number, h: number, z: number, cx: number, cutout: boolean) => {
      keep(tex)
      for (const [ghost, order] of [[true, 40], [false, 42]] as const) {
        const mat = keep(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: ghost ? 0.22 : 1, alphaTest: ghost || !cutout ? 0 : 0.5, depthTest: !ghost, depthWrite: !ghost && cutout, toneMapped: false }))
        const sp = new THREE.Sprite(mat)
        sp.center.set(cx, 0.5)
        sp.position.set(0, 0, z)
        sp.scale.set(w, h, 1)
        sp.renderOrder = order
        sp.frustumCulled = false
        group.add(sp)
      }
    }
    sprite(signTexture(s, selected || hotTop ? ACCENT : GREEN), SIGN_W * 2, SIGN_H * 2, s.ft + 0.05 + SIGN_H, 0.5, true)
    for (const t of ticks) {
      if (!t.label) continue
      const n = numTexture(t.label)
      sprite(n.tex, NUM_H * n.aspect, NUM_H, t.at, -0.3, false)
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
        const selected = f.selected === s.id, hotTop = f.hot === `${s.id}:top`, docked = f.docked.has(s.id)
        const sig = `${s.ft}|${!!s.metric}|${s.font ?? ''}|${selected}|${hotTop}|${docked}|${f.fontRev}`
        let b = built.get(s.id)
        if (!b || b.sig !== sig) {
          if (b) drop(b)
          b = build(s, sig, selected, hotTop, docked)
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
      const foot = px(0, b), top = px(b.ft, b), sign = px(b.ft + 0.05 + SIGN_H, b)
      if (!foot || !top || !sign) continue
      const k = (v.setFromMatrixScale(b.group.matrixWorld).x || 1) * pxPer / sign.depth
      out.push({ id, foot, top, sign, hw: SIGN_W * k, hh: SIGN_H * k })
    }
    return out
  }

  function dispose() {
    for (const b of built.values()) drop(b)
    built.clear()
  }

  return { render, spots, dispose }
}
