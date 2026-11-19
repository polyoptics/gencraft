// stickOverlay.ts — the measuring sticks in the 3D view (store/notesStore
// sticks; Brian 2026-11-18: "a measuring stick... so that I can put it up
// against things like a lineup of characters"). Tilted, a stick is a real
// thing in the scene, made as his picture of a bus stop pole: a D-shaped
// base, flat on the side it docks by, a short thick lower tube, a
// thinner tube out of it ticked like a ruler (a ring round it at every
// mark, a number by the main ones), and a board on its top that says how
// tall it is and always faces the viewer. A selected card of its group
// has a mark on the tube at its height. Docked, a short ticked line runs
// along the edge it is docked by.
// it back there.
//
// As the view lies back flat the tube goes down into its base and the
// board comes down over it: flat, it
// is the tab the flat view draws (components/Notes/StickLayer). Drawn
// after the models, against their depth: where something stands in front
// of it, it shows through faintly (as three/pathOverlay).
//
// This also answers where a stick's foot, top and board are on screen
// (spots), for utils/stickTool.

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Stick } from '../store/notesStore'
import { POLE_R, LOWER_R, LOWER_TOP, BASE_H, BASE_W, DOCK_LINE, SIGN_W, SIGN_H, SIGN_CUT, SIGN_TEXT, NUM_H, CREAM, GREEN, ORANGE, DARK, ACCENT, DEFAULT_FONT, TICK, heightText, unitText, stickTicks, tabOut, tabDepth, tabCentre, type Side } from '../utils/stickGeom'

/** A mark on a stick's tube: a selected card's height (utils/stickDock). */
export interface StickMarkAt { id: string; ft: number; color: string; text: string; unset?: boolean }
/** What the 3D view draws of the sticks this frame. */
export interface StickFrame {
  sticks: Stick[]
  selected: string | null
  /** The part under the cursor: `${id}:top` or `${id}:body`. */
  hot: string | null
  /** The sticks docked to cards (utils/stickDock), and the side of its
   *  card each is on. */
  docked: Set<string>
  sides: Map<string, Side>
  /** A docked stick's place on that edge. */
  at: Map<string, Pt>
  /** The middle of its mount line on that edge. */
  line: Map<string, Pt>
  /** Each stick's marks. */
  marks: Map<string, StickMarkAt[]>
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
export interface StickSpot { id: string; foot: Pt; top: Pt; sign: Pt; hw: number; hh: number; /** Its base's reach, px. */ br: number
  /** Its marks (a selected card's height, by card id): where each is, to be dragged. */
  marks: { id: string; at: Pt }[] }

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
  g.fillStyle = s.color ?? ORANGE
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
function numTexture(text: string, color = '#fff'): { tex: THREE.CanvasTexture; aspect: number } {
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
  g.fillStyle = color
  g.fillText(text, 10, h / 2 + 2)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return { tex, aspect: w / h }
}

interface Built {
  /** What it was built from: its height and how it is lit. */
  sig: string
  ft: number
  /** In feet: scaled by the stick's `per`, at its middle. */
  group: THREE.Group
  /** Its tubes: they go down into the base as the view lies flat. */
  mast: THREE.Group
  /** Its board, and what is written by the tube (at these heights). */
  board: THREE.Sprite[]
  labels: { sp: THREE.Sprite; at: number }[]
  /** On the ground, in canvas units: the line along the edge it is
   *  docked by. */
  ground: THREE.Group
  marks: StickMarkAt[]
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
    b.ground.removeFromParent()
  }

  function build(s: Stick, sig: string, selected: boolean, hotTop: boolean, docked: boolean, side: Side | null, marks: StickMarkAt[]): Built {
    const group = new THREE.Group(), mast = new THREE.Group(), ground = new THREE.Group()
    group.add(mast)
    const own: Built['own'] = []
    const keep = <T extends { dispose: () => void }>(o: T) => { own.push(o); return o }
    const merged = (parts: THREE.BufferGeometry[]) => {
      const g = mergeGeometries(parts.map(p => p.index ? p.toNonIndexed() : p))
      for (const p of parts) p.dispose()
      return g
    }
    // Each colour twice: faint through whatever stands in front of it,
    // then solid where nothing does.
    const body = (parts: THREE.BufferGeometry[], hex: string, into: THREE.Object3D = mast) => {
      if (!parts.length) return null
      const geo = keep(parts.length > 1 ? merged(parts) : parts[0])
      const color = new THREE.Color(hex)
      const ghost = keep(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }))
      const solid = keep(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.38, roughness: 0.45, metalness: 0, toneMapped: false, side: THREE.DoubleSide }))
      let last: THREE.Mesh | null = null
      for (const [mat, order] of [[ghost, 40], [solid, 41]] as const) {
        const m = new THREE.Mesh(geo, mat)
        m.renderOrder = order
        m.frustumCulled = false
        into.add(m)
        last = m
      }
      return last
    }
    const ticks = stickTicks(s)
    const out = tabOut(side), depth = tabDepth(side)
    // Its base: a D, flat on the side it docks by (which lies on the
    // stick's own point), round on the other. Lit while it is selected.
    const d = new THREE.Shape()
    d.moveTo(-BASE_W, -depth); d.lineTo(BASE_W, -depth); d.lineTo(BASE_W, 0)
    d.absarc(0, 0, BASE_W, 0, Math.PI, false)
    d.lineTo(-BASE_W, -depth)
    // (Drawn with the way out as +y; turned to the way out it has.)
    body([new THREE.ExtrudeGeometry(d, { depth: BASE_H, bevelEnabled: false, curveSegments: 20 }).rotateZ(Math.atan2(-out.x, out.y))], selected ? ACCENT : GREEN, group)
    const j = BASE_H + 0.08
    // The joints and the ruler's ticks: the machine's green.
    body([
      bar(LOWER_R + 0.03, BASE_H, j, 20),
      bar(LOWER_R + 0.022, LOWER_TOP - 0.07, LOWER_TOP + 0.03, 20),
      bar(POLE_R + 0.03, s.ft - 0.05, s.ft + 0.05, 16),
      ...ticks.filter(t => t.k < 3).map(t => bar(TICK[t.k].r, t.at - TICK[t.k].h / 2, t.at + TICK[t.k].h / 2, 14)),
    ], GREEN)
    // The thick lower tube, and the thinner one that goes up and down out of it.
    body([bar(LOWER_R, j, LOWER_TOP - 0.07, 22), bar(POLE_R, LOWER_TOP + 0.03, s.ft - 0.05, 16)], CREAM)
    // A stripe on the lower tube, and the mark.
    body([
      bar(LOWER_R + 0.004, 0.46, 0.6, 22),
      ...ticks.filter(t => t.k === 3).map(t => bar(TICK[3].r, t.at - TICK[3].h / 2, t.at + TICK[3].h / 2, 18)),
    ], ORANGE)
    // The board on its top, and what is written by the tube: face on to
    // the viewer, wherever they look from.
    const sprite = (tex: THREE.Texture, w: number, h: number, cx: number, cutout: boolean) => {
      keep(tex)
      const pair: THREE.Sprite[] = []
      for (const [ghost, order] of [[true, 40], [false, 42]] as const) {
        const mat = keep(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: ghost ? 0.22 : 1, alphaTest: ghost || !cutout ? 0 : 0.5, depthTest: !ghost, depthWrite: !ghost && cutout, toneMapped: false }))
        const sp = new THREE.Sprite(mat)
        sp.center.set(cx, 0.5)
        sp.scale.set(w, h, 1)
        sp.renderOrder = order
        sp.frustumCulled = false
        group.add(sp)
        pair.push(sp)
      }
      return pair
    }
    const board = sprite(signTexture(s, selected || hotTop ? ACCENT : GREEN), SIGN_W * 2, SIGN_H * 2, 0.5, true)
    const labels: Built['labels'] = []
    for (const t of ticks) {
      if (!t.label) continue
      const n = numTexture(t.label)
      for (const sp of sprite(n.tex, NUM_H * n.aspect, NUM_H, -0.3, false)) labels.push({ sp, at: t.at })
    }
    // A selected card of its group: a band round the tube at its height,
    // in the card's colour, its height written on the other side from the numbers.
    for (const m of marks) {
      if (m.ft > s.ft + 1e-6) continue
      body([bar(POLE_R + 0.075, m.ft - 0.03, m.ft + 0.03, 20)], m.color)
      const n = numTexture(m.text, s.color ?? ORANGE)
      for (const sp of sprite(n.tex, NUM_H * 1.15 * n.aspect, NUM_H * 1.15, 1.25, false)) labels.push({ sp, at: m.ft })
    }
    // Docked: a short line along the edge it is docked by, ticked. In
    // canvas units on the ground, through the stick's own point.
    const flat = (x0: number, y0: number, x1: number, y1: number, w: number) => {
      const l = Math.hypot(x1 - x0, y1 - y0)
      return new THREE.BoxGeometry(Math.max(l, 1e-6), w, 0.01 * s.per).rotateZ(Math.atan2(y1 - y0, x1 - x0)).translate((x0 + x1) / 2, (y0 + y1) / 2, 0.012 * s.per)
    }
    if (docked) {
      const tx = -out.y, ty = out.x, L = DOCK_LINE / 2 * s.per, w = 0.035 * s.per
      const parts = [flat(-tx * L, -ty * L, tx * L, ty * L, w)]
      for (let i = -4; i <= 4; i++) {
        const a = i / 4 * L, k = (i % 2 === 0 ? 0.13 : 0.07) * s.per
        parts.push(flat(tx * a, ty * a, tx * a + out.x * k, ty * a + out.y * k, w * 0.7))
      }
      body(parts, ORANGE, ground)
    }
    root.add(ground)
    root.add(group)
    return { sig, ft: s.ft, group, mast, board, labels, ground, marks, own }
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
        const side = f.sides.get(s.id) ?? null, marks = f.marks.get(s.id) ?? []
        const sig = `${s.ft}|${s.per}|${!!s.metric}|${s.font ?? ''}|${s.color ?? ''}|${selected}|${hotTop}|${docked}|${side}|${f.fontRev}|${marks.map(m => `${m.id}${m.ft.toFixed(3)}${m.color}${m.unset ? '?' : ''}`).join(',')}`
        let b = built.get(s.id)
        if (!b || b.sig !== sig) {
          if (b) drop(b)
          b = build(s, sig, selected, hotTop, docked, side, marks)
          built.set(s.id, b)
        }
        // Its middle.
        const e = Math.max(0, Math.min(1, rise))
        const at = f.at.get(s.id) ?? s
        const c = tabCentre({ x: at.x, y: at.y, per: s.per }, side)
        const px = c.x, py = c.y
        b.group.position.set(px, py, 0)
        b.group.scale.setScalar(s.per)
        // The tubes go down into the base, and the board comes down over it.
        b.mast.scale.set(1, 1, Math.max(e, 0.001))
        b.mast.visible = e > 0.01
        for (const sp of b.board) sp.position.set(0, 0, e * (s.ft + 0.05 + SIGN_H) + (1 - e) * (BASE_H + 0.02))
        for (const l of b.labels) { l.sp.position.set(0, 0, l.at * e); l.sp.visible = e > 0.6 }
        const ln = f.line.get(s.id) ?? at
        b.ground.position.set(ln.x, ln.y, 0)
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
      const foot = px(0, b), top = px(b.ft * b.mast.scale.z, b), sign = px(b.board[0].position.z, b)
      if (!foot || !top || !sign) continue
      const k = (v.setFromMatrixScale(b.group.matrixWorld).x || 1) * pxPer / sign.depth
      const per = v.setFromMatrixScale(b.group.matrixWorld).x || 1
      const marks: StickSpot['marks'] = []
      for (const m of b.marks) {
        const at = m.ft <= b.ft + 1e-6 ? px(m.ft * b.mast.scale.z, b) : null
        if (at) marks.push({ id: m.id, at: { x: at.x, y: at.y } })
      }
      out.push({ id, foot, top, sign, hw: SIGN_W * k, hh: SIGN_H * k, br: BASE_W * per * pxPer / foot.depth, marks })
    }
    return out
  }

  function dispose() {
    for (const b of built.values()) drop(b)
    built.clear()
  }

  return { render, spots, dispose }
}
