// tiltScene.ts — the three.js side of the tilted canvas view
// (components/Canvas/TiltLayer). One transparent canvas over the tilted
// DOM, with the camera the CSS perspective uses, drawing on each model
// card:
//  - the model, standing up out of the card and turning;
//  - an outline that follows its silhouette: selected, or under the cursor;
//  - a back wall along the card's top edge with the file name and size;
//  - optionally a person for scale beside it.
// pick() is the hit test, so a model can be clicked straight in 3D.

import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { acquireModel, releaseModel, disposeInstance } from './modelCache'
import { computePosedBounds } from './orbitState'
import { TILT_PERSPECTIVE, type TiltWire, type TiltLight } from '../store/tiltStore'

export interface TiltTarget {
  key: string
  url: string
  /** Card centre, flat px from the host centre. */
  u: number
  v: number
  /** Card width / height on the flat view (px). */
  w: number
  h: number
  /** What the back wall says. */
  name: string
}

/** A flat element given thickness on the tilted plane: a rounded slab
 *  whose top is the element itself (at the plane) and whose sides go down
 *  `t` px. Centre and size in flat px from the host centre. */
export interface TiltSlab {
  u: number
  v: number
  w: number
  h: number
  /** Corner radius, px. */
  r: number
  /** Thickness, px. */
  t: number
  /** Side colour. */
  color: number
}

export interface TiltFrameState {
  tilt: number
  spin: number
  texture: boolean
  flat: boolean
  wire: TiltWire
  light: TiltLight
  turn: boolean
  walls: boolean
  figure: boolean
  selected: Set<string>
  hovered: string | null
  /** The model units per metre the user set for a url, if any. */
  unitsFor: (url: string) => number | undefined
  /** Display size multiplier for a card's model (dragging the model). */
  sizeFor: (key: string) => number
  /** Cards, decks, tiles and Viewers, for their thickness. */
  slabs: TiltSlab[]
}

/** A person, in metres, for scale. */
export const PERSON_H = 1.75

/** What a model measures, per url — a skinned model's posed bounds walk
 *  every vertex, which is far too slow to redo each time a card comes
 *  back into view. */
const measured = new Map<string, { size: THREE.Vector3; centre: THREE.Vector3; minY: number; triangles: number }>()

interface Standing {
  url: string
  stand: THREE.Group       // on the plane; local +Y is the plane's normal
  turn: THREE.Group        // turntable about that normal
  inst: THREE.Object3D | null
  size: THREE.Vector3
  /** Model units per metre: set by the user, or guessed — 1 for glTF,
   *  100 when it reads as centimetres. */
  unit: number
  unitSet: boolean
  triangles: number
  figure: THREE.Group
  wall: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  wallText: string
  /** Smooth-normal geometry for the Flat mode (null until first needed). */
  smooth: Swap[] | null
  smoothOn: boolean
  phase: number
  dead: boolean
  seen: number
}

const WIRE_MAT = new THREE.MeshBasicMaterial({ color: 0x9fd0ff, wireframe: true, transparent: true, opacity: 0.85 })
/** Over a surface the wire is drawn where the surface is, so it may sit
 *  exactly on it: LessEqual lets it win those ties. */
const WIRE_OVER_MAT = new THREE.MeshBasicMaterial({ color: 0x9fd0ff, wireframe: true, transparent: true, opacity: 0.55, depthFunc: THREE.LessEqualDepth, depthWrite: false })
/** Texture off: plain clay. Flat comes from the light rig, not this. */
const CLAY_MAT = new THREE.MeshStandardMaterial({ color: 0xc8ccd8, roughness: 0.85, metalness: 0 })
// Silhouette masks: red channel = selected, green = under the cursor.
const MASK_SEL = new THREE.MeshBasicMaterial({ color: 0xff0000 })
const MASK_HOVER = new THREE.MeshBasicMaterial({ color: 0x00ff00 })
const FIGURE_MAT = new THREE.MeshStandardMaterial({ color: 0x8f98b0, roughness: 0.9, metalness: 0, transparent: true, opacity: 0.85 })

/** A plain mannequin PERSON_H tall, feet at the origin, facing +Z. */
function makeFigure(): THREE.Group {
  const g = new THREE.Group()
  const part = (geo: THREE.BufferGeometry, x: number, y: number, z = 0) => {
    const m = new THREE.Mesh(geo, FIGURE_MAT)
    m.position.set(x, y, z)
    g.add(m)
  }
  const leg = new THREE.CapsuleGeometry(0.075, 0.72, 4, 10)
  part(leg, -0.1, 0.43); part(leg, 0.1, 0.43)
  part(new THREE.CapsuleGeometry(0.17, 0.42, 4, 12), 0, 1.12)
  const arm = new THREE.CapsuleGeometry(0.055, 0.6, 4, 8)
  part(arm, -0.25, 1.1); part(arm, 0.25, 1.1)
  part(new THREE.SphereGeometry(0.11, 16, 12), 0, 1.62)
  return g
}

function wallTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 1024; c.height = 256
  const ctx = c.getContext('2d')!
  ctx.fillStyle = 'rgba(19,20,31,0.82)'
  ctx.beginPath(); ctx.roundRect(4, 4, 1016, 248, 28); ctx.fill()
  ctx.strokeStyle = 'rgba(140,180,255,0.45)'; ctx.lineWidth = 4; ctx.stroke()
  const [title, ...rest] = text.split('\n')
  ctx.fillStyle = '#e8ecff'
  ctx.font = '600 78px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  let t = title
  while (ctx.measureText(t).width > 940 && t.length > 4) t = t.slice(0, -2)
  if (t !== title) t = t.slice(0, -1) + '…'
  ctx.fillText(t, 42, 92)
  ctx.fillStyle = 'rgba(200,210,240,0.7)'
  ctx.font = '400 54px system-ui, sans-serif'
  ctx.fillText(rest.join('  ·  '), 42, 182)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

function fmtCount(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`
}

const OUTLINE_VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`
const OUTLINE_FRAG = `
uniform sampler2D mask; uniform vec2 texel; uniform float px;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(mask, vUv);
  if (c.r > 0.5 || c.g > 0.5) discard;
  float s = 0.0, h = 0.0;
  for (int i = 0; i < 16; i++) {
    float a = 6.2831853 * float(i) / 16.0;
    vec2 d = vec2(cos(a), sin(a)) * texel;
    vec4 m1 = texture2D(mask, vUv + d * px);
    vec4 m2 = texture2D(mask, vUv + d * px * 0.5);
    s = max(s, max(m1.r, m2.r)); h = max(h, max(m1.g, m2.g));
  }
  if (s > 0.5) gl_FragColor = vec4(0.47, 0.70, 1.0, 1.0);
  else if (h > 0.5) gl_FragColor = vec4(1.0, 1.0, 1.0, 0.7);
  else discard;
}`

/** Smooth-normal copies of model geometry for Flat: many models
 *  arrive with split, faceted normals. Normals are averaged across faces
 *  that meet at under SMOOTH_CREASE, so curves go smooth and hard edges
 *  stay hard. Textured keeps the model's own normals. The cached source
 *  geometry is shared with the Viewers, so only tilted instances swap to
 *  the copy, ref-counted per source and built the first time Flat shows. */
const SMOOTH_CREASE = Math.PI * 70 / 180
const SMOOTH_MAX_TRIS = 400_000
const smoothed = new Map<THREE.BufferGeometry, { geo: THREE.BufferGeometry; refs: number }>()
type Swap = { mesh: THREE.Mesh; orig: THREE.BufferGeometry; smooth: THREE.BufferGeometry }

function smoothSwaps(root: THREE.Object3D): Swap[] {
  const out: Swap[] = []
  root.traverse(o => {
    const mesh = o as THREE.Mesh
    const src = mesh.isMesh ? mesh.geometry : null
    if (!src?.attributes.position || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return
    const tris = src.index ? src.index.count / 3 : src.attributes.position.count / 3
    if (tris > SMOOTH_MAX_TRIS) return
    let e = smoothed.get(src)
    if (!e) {
      try { e = { geo: toCreasedNormals(src, SMOOTH_CREASE), refs: 0 } } catch { return }
      smoothed.set(src, e)
    }
    e.refs++
    out.push({ mesh, orig: src, smooth: e.geo })
  })
  return out
}

function releaseSwaps(swaps: Swap[] | null) {
  for (const w of swaps ?? []) {
    w.mesh.geometry = w.orig
    const e = smoothed.get(w.orig)
    if (e && --e.refs <= 0) { e.geo.dispose(); smoothed.delete(w.orig) }
  }
}

export function createTiltScene(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setClearColor(0x000000, 0)
  // Brighter, with highlights (Brian 2026-10-30): a soft studio environment
  // the models reflect, and a tone map so the bright parts roll off
  // instead of washing out.
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
  pmrem.dispose()

  const lights = () => {
    const l = new THREE.Group()
    l.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.2))
    const sun = new THREE.DirectionalLight(0xffffff, 1.5)
    sun.position.set(300, 800, 900)
    l.add(sun)
    return l
  }
  // Models in one scene (shading override applies), walls in another (it
  // must not). Both share the plane transform and the depth buffer, so a
  // model still stands in front of its wall.
  const scene = new THREE.Scene()
  scene.environment = envRT.texture
  // Lit: a key light the Light panel moves (it lives on the plane, so it
  // turns with it), a soft sky/ground fill, and the environment.
  const litRig = new THREE.Group()
  const litFill = new THREE.HemisphereLight(0xffffff, 0x40404c, 0.5)
  litRig.add(litFill)
  scene.add(litRig)
  // Flat: mostly even ambient, a weak key from the viewer's side for just
  // enough form, so neither texture nor clay goes dark on one side.
  const flatRig = new THREE.Group()
  flatRig.add(new THREE.AmbientLight(0xffffff, 2.1))
  const flatKey = new THREE.DirectionalLight(0xffffff, 0.6)
  flatKey.position.set(0, 400, 1200)
  flatRig.add(flatKey)
  flatRig.visible = false
  scene.add(flatRig)
  const deco = new THREE.Scene(); deco.add(lights())
  const ground = new THREE.Group(); ground.matrixAutoUpdate = false; scene.add(ground)
  const key = new THREE.DirectionalLight(0xffffff, 2)
  ground.add(key, key.target)
  const groundDeco = new THREE.Group(); groundDeco.matrixAutoUpdate = false; deco.add(groundDeco)

  const camera = new THREE.PerspectiveCamera(50, 1, 10, TILT_PERSPECTIVE * 20)
  camera.position.set(0, 0, TILT_PERSPECTIVE)
  const F = new THREE.Matrix4().makeScale(1, -1, 1)
  const R = new THREE.Matrix4(), Rz = new THREE.Matrix4()

  const maskRT = new THREE.WebGLRenderTarget(1, 1)
  const outlineMat = new THREE.ShaderMaterial({
    vertexShader: OUTLINE_VERT, fragmentShader: OUTLINE_FRAG,
    uniforms: { mask: { value: maskRT.texture }, texel: { value: new THREE.Vector2() }, px: { value: 3 } },
    transparent: true, depthTest: false, depthWrite: false,
  })
  const quadScene = new THREE.Scene()
  quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), outlineMat))
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  const standing = new Map<string, Standing>()
  let frameNo = 0

  const spawn = (key: string, url: string): Standing => {
    const stand = new THREE.Group()
    stand.rotation.x = Math.PI / 2   // model +Y → plane normal; its front faces the viewer
    const turn = new THREE.Group()
    stand.add(turn)
    const figure = makeFigure()
    figure.visible = false
    stand.add(figure)
    ground.add(stand)
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }),
    )
    wall.rotation.x = Math.PI / 2    // stands up off the plane, facing the viewer
    wall.visible = false
    groundDeco.add(wall)
    const s: Standing = {
      url, stand, turn, inst: null, size: new THREE.Vector3(), unit: 1, unitSet: false, triangles: 0,
      figure, wall, wallText: '', smooth: null, smoothOn: false, phase: Math.random() * 6.28, dead: false, seen: frameNo,
    }
    acquireModel(url).then(inst => {
      if (s.dead) { releaseModel(url); disposeInstance(inst); return }
      let m = measured.get(url)
      if (!m) {
        const box = computePosedBounds(inst)
        let triangles = 0
        inst.traverse(o => {
          const mesh = o as THREE.Mesh
          const pos = mesh.isMesh ? mesh.geometry?.attributes?.position : null
          if (pos) triangles += mesh.geometry.index ? mesh.geometry.index.count / 3 : pos.count / 3
        })
        m = { size: box.getSize(new THREE.Vector3()), centre: box.getCenter(new THREE.Vector3()), minY: box.min.y, triangles }
        measured.set(url, m)
      }
      s.size.copy(m.size)
      s.triangles = m.triangles
      inst.position.set(-m.centre.x, -m.minY, -m.centre.z)   // feet on the card, centred on it
      turn.add(inst)
      s.inst = inst
    }).catch(() => { /* unreadable model: the card just stays flat */ })
    standing.set(key, s)
    return s
  }
  const drop = (key: string, s: Standing) => {
    s.dead = true
    s.stand.removeFromParent()
    s.wall.removeFromParent()
    s.wall.material.map?.dispose()
    s.wall.material.dispose()
    s.wall.geometry.dispose()
    if (s.inst) { disposeInstance(s.inst); releaseSwaps(s.smooth); releaseModel(s.url) }
    standing.delete(key)
  }

  // ── Thickness (Brian 2026-10-30) ──
  // Every card, deck, tile and Viewer is a slab: the DOM element is its top
  // face, at the plane, and its sides are drawn here going down from it. All
  // slabs are rebuilt into one pair of buffers each frame (they move with
  // every pan and zoom): the sides, lit, and the tops, depth only, so a
  // nearer slab hides the sides of the ones behind it as a solid would.
  const SLAB_MAX = 160, CORNER_SEG = 4
  const RING = 4 * (CORNER_SEG + 1)
  const sideGeo = new THREE.BufferGeometry()
  const sidePos = new Float32Array(SLAB_MAX * RING * 2 * 3)
  const sideNrm = new Float32Array(SLAB_MAX * RING * 2 * 3)
  const sideCol = new Float32Array(SLAB_MAX * RING * 2 * 3)
  const sideIdx = new Uint32Array(SLAB_MAX * RING * 6)
  sideGeo.setAttribute('position', new THREE.BufferAttribute(sidePos, 3).setUsage(THREE.DynamicDrawUsage))
  sideGeo.setAttribute('normal', new THREE.BufferAttribute(sideNrm, 3).setUsage(THREE.DynamicDrawUsage))
  sideGeo.setAttribute('color', new THREE.BufferAttribute(sideCol, 3).setUsage(THREE.DynamicDrawUsage))
  sideGeo.setIndex(new THREE.BufferAttribute(sideIdx, 1))
  const topGeo = new THREE.BufferGeometry()
  const topPos = new Float32Array(SLAB_MAX * (RING + 1) * 3)
  const topIdx = new Uint32Array(SLAB_MAX * RING * 3)
  topGeo.setAttribute('position', new THREE.BufferAttribute(topPos, 3).setUsage(THREE.DynamicDrawUsage))
  topGeo.setIndex(new THREE.BufferAttribute(topIdx, 1))
  const sideMesh = new THREE.Mesh(sideGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, emissive: 0x2a2e3c }))
  const topMesh = new THREE.Mesh(topGeo, new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }))
  sideMesh.frustumCulled = topMesh.frustumCulled = false
  topMesh.renderOrder = -1
  groundDeco.add(topMesh, sideMesh)
  const col = new THREE.Color()

  function buildSlabs(slabs: TiltSlab[]) {
    const n = Math.min(slabs.length, SLAB_MAX)
    let sv = 0, si = 0, tv = 0, ti = 0
    for (let k = 0; k < n; k++) {
      const s = slabs[k]
      const hw = s.w / 2, hh = s.h / 2
      const r = Math.max(0, Math.min(s.r, hw, hh))
      col.setHex(s.color)
      // Outline, corner by corner (y is flipped: the plane's y is down).
      const base = sv / 3 / 1, top0 = tv / 3
      topPos[tv++] = s.u; topPos[tv++] = -s.v; topPos[tv++] = 0
      const corners = [[hw - r, hh - r, 0], [-(hw - r), hh - r, Math.PI / 2], [-(hw - r), -(hh - r), Math.PI], [hw - r, -(hh - r), Math.PI * 1.5]] as const
      let p = 0
      for (const [cx, cy, a0] of corners) {
        for (let i = 0; i <= CORNER_SEG; i++, p++) {
          const a = a0 + (i / CORNER_SEG) * (Math.PI / 2)
          const nx = Math.cos(a), ny = Math.sin(a)
          const x = s.u + cx + nx * r, y = -s.v - (cy + ny * r)
          for (const z of [0, -s.t]) {
            sidePos[sv] = x; sidePos[sv + 1] = y; sidePos[sv + 2] = z
            sideNrm[sv] = nx; sideNrm[sv + 1] = -ny; sideNrm[sv + 2] = 0
            const shade = z === 0 ? 1 : 0.7
            sideCol[sv] = col.r * shade; sideCol[sv + 1] = col.g * shade; sideCol[sv + 2] = col.b * shade
            sv += 3
          }
          topPos[tv++] = x; topPos[tv++] = y; topPos[tv++] = 0
        }
      }
      for (let i = 0; i < RING; i++) {
        const a = base + i * 2, b = base + ((i + 1) % RING) * 2
        sideIdx[si++] = a; sideIdx[si++] = b; sideIdx[si++] = a + 1
        sideIdx[si++] = b; sideIdx[si++] = b + 1; sideIdx[si++] = a + 1
        topIdx[ti++] = top0; topIdx[ti++] = top0 + 1 + i; topIdx[ti++] = top0 + 1 + ((i + 1) % RING)
      }
    }
    for (const g of [sideGeo, topGeo]) {
      for (const a of Object.values(g.attributes)) (a as THREE.BufferAttribute).needsUpdate = true
      g.index!.needsUpdate = true
    }
    sideGeo.setDrawRange(0, si)
    topGeo.setDrawRange(0, ti)
  }

  let lastW = 0, lastH = 0

  function frame(now: number, W: number, H: number, targets: TiltTarget[], st: TiltFrameState, into: THREE.WebGLRenderTarget | null = null) {
    frameNo++
    if (W !== lastW || H !== lastH) {
      renderer.setSize(W, H, false)
      lastW = W; lastH = H
    }
    const buf = renderer.getDrawingBufferSize(new THREE.Vector2())
    if (maskRT.width !== buf.x || maskRT.height !== buf.y) maskRT.setSize(buf.x, buf.y)
    outlineMat.uniforms.texel.value.set(1 / buf.x, 1 / buf.y)
    outlineMat.uniforms.px.value = 2.5 * renderer.getPixelRatio()

    camera.aspect = W / H
    camera.fov = 2 * Math.atan(H / 2 / TILT_PERSPECTIVE) * 180 / Math.PI
    camera.updateProjectionMatrix()
    // The plane: CSS rotateX(t) rotateZ(s), carried from CSS's y-down
    // space into three's y-up space (F·R·F, F = flip y).
    R.makeRotationX(st.tilt * Math.PI / 180).multiply(Rz.makeRotationZ(st.spin * Math.PI / 180))
    ground.matrix.copy(F).multiply(R).multiply(F)
    ground.matrixWorldNeedsUpdate = true
    groundDeco.matrix.copy(ground.matrix)
    groundDeco.matrixWorldNeedsUpdate = true

    // Models rise out of their cards as the plane tips back.
    const rise = Math.min(1, Math.max(0, (st.tilt - 4) / 26))
    const ease = rise * rise * (3 - 2 * rise)
    const keep = new Set<string>()
    for (const tg of targets) {
      keep.add(tg.key)
      let s = standing.get(tg.key)
      if (s && s.url !== tg.url) { drop(tg.key, s); s = undefined }
      if (!s) s = spawn(tg.key, tg.url)
      s.seen = frameNo
      s.stand.position.set(tg.u, -tg.v, 0)
      const foot = Math.max(s.size.x, s.size.z, 1e-6)
      let k = (tg.w * 0.6) / foot
      if (s.size.y * k > tg.w * 1.1) k = (tg.w * 1.1) / Math.max(s.size.y, 1e-6)
      k *= st.sizeFor(tg.key)
      s.stand.scale.set(k, k * Math.max(ease, 0.001), k)
      const wantSmooth = st.flat && !!s.inst
      if (wantSmooth && !s.smooth) s.smooth = smoothSwaps(s.inst!)
      if (s.smooth && wantSmooth !== s.smoothOn) {
        s.smoothOn = wantSmooth
        for (const w of s.smooth) w.mesh.geometry = wantSmooth ? w.smooth : w.orig
      }
      s.stand.visible = !!s.inst && ease > 0
      s.turn.rotation.y = st.turn ? now / 1000 * 0.6 + s.phase : 0
      // glTF is in metres; something over 30 units tall is far likelier a
      // centimetre file (FBX's habit) than a 30 m model — unless the user
      // sized the person, which settles it.
      const set = st.unitsFor(s.url)
      s.unitSet = set !== undefined
      s.unit = set ?? (s.size.y > 30 ? 100 : 1)
      // The person stands beside the model, clear of its widest reach.
      s.figure.scale.setScalar(s.unit)
      s.figure.position.set(Math.hypot(s.size.x, s.size.z) / 2 + 0.45 * s.unit, 0, 0)
      // A guessed person only where they would read: not a giant beside a
      // teacup. One the user sized always shows.
      s.figure.visible = st.figure && !!s.inst && (s.unitSet || PERSON_H * s.unit < s.size.y * 5)

      // Back wall: stands on the card's top edge.
      const text = s.inst
        ? `${tg.name}\n${fmtCount(Math.round(s.triangles))} triangles\n${(s.size.y / s.unit).toFixed(s.size.y / s.unit < 10 ? 2 : 1)} m tall`
        : ''
      if (text !== s.wallText) {
        s.wall.material.map?.dispose()
        s.wall.material.map = text ? wallTexture(text) : null
        s.wall.material.needsUpdate = true
        s.wallText = text
      }
      const wallW = tg.w, wallH = tg.w / 4
      s.wall.scale.set(wallW, wallH * Math.max(ease, 0.001), 1)
      s.wall.position.set(tg.u, -(tg.v - tg.h / 2), (wallH * ease) / 2)
      s.wall.visible = st.walls && !!text && ease > 0
    }
    // A card missing for a frame or two (a re-render, a deck shuffling) is
    // only hidden: dropping it would reload the model and blink.
    for (const [key, s] of standing) {
      if (keep.has(key)) continue
      s.stand.visible = false
      s.wall.visible = false
      if (frameNo - s.seen > 120) drop(key, s)
    }

    renderer.setRenderTarget(into)
    renderer.autoClear = true
    litRig.visible = !st.flat
    key.visible = !st.flat
    flatRig.visible = st.flat
    {
      const L = st.light
      const az = (L.azimuth * Math.PI / 180) + (L.spin && st.turn ? now / 1000 * 0.6 : 0)
      const el = Math.max(2, Math.min(90, L.elevation)) * Math.PI / 180
      key.position.set(Math.cos(el) * Math.sin(az) * 1000, -Math.cos(el) * Math.cos(az) * 1000, Math.sin(el) * 1000)
      key.intensity = L.power
      scene.environmentIntensity = st.flat ? 0.6 : L.env
    }
    if (st.wire === 'only') {
      scene.overrideMaterial = WIRE_MAT
      renderer.render(scene, camera)
      renderer.autoClear = false
    } else {
      scene.overrideMaterial = st.texture ? null : CLAY_MAT
      renderer.render(scene, camera)
      renderer.autoClear = false
      if (st.wire === 'over') {
        scene.overrideMaterial = WIRE_OVER_MAT
        renderer.render(scene, camera)
      }
    }
    scene.overrideMaterial = null
    buildSlabs(st.tilt > 0.5 ? st.slabs : [])
    renderer.render(deco, camera)
    if (into) { renderer.setRenderTarget(null); return }

    // Outlines: paint the silhouettes into a mask, then ring them.
    const outlined = [...standing.entries()].filter(([key, s]) =>
      s.stand.visible && (st.selected.has(key) || key === st.hovered))
    if (outlined.length) {
      const vis = new Map<THREE.Object3D, boolean>()
      for (const s of standing.values()) { vis.set(s.stand, s.stand.visible); vis.set(s.figure, s.figure.visible); s.figure.visible = false }
      renderer.setRenderTarget(maskRT)
      renderer.setClearColor(0x000000, 0)
      renderer.clear()
      for (const pass of ['sel', 'hover'] as const) {
        for (const s of standing.values()) s.stand.visible = false
        let any = false
        for (const [key, s] of outlined) {
          const isSel = st.selected.has(key)
          if ((pass === 'sel') === isSel) { s.stand.visible = true; any = true }
        }
        if (!any) continue
        scene.overrideMaterial = pass === 'sel' ? MASK_SEL : MASK_HOVER
        renderer.render(scene, camera)
      }
      renderer.setRenderTarget(null)
      for (const [o, v] of vis) o.visible = v
      scene.overrideMaterial = null
      renderer.render(quadScene, quadCam)
    }
  }

  const raycaster = new THREE.Raycaster()
  /** The key of the model drawn at this point (px from the canvas's
   *  top-left), `person|<key>` for the person beside one, or null. */
  function pick(x: number, y: number): string | null {
    if (!lastW || !lastH) return null
    raycaster.setFromCamera(new THREE.Vector2((x / lastW) * 2 - 1, -(y / lastH) * 2 + 1), camera)
    let best: { key: string; d: number } | null = null
    for (const [key, s] of standing) {
      if (!s.stand.visible || !s.inst) continue
      const hit = raycaster.intersectObject(s.turn, true)[0]
      if (hit && (!best || hit.distance < best.d)) best = { key, d: hit.distance }
      const man = s.figure.visible ? raycaster.intersectObject(s.figure, true)[0] : undefined
      if (man && (!best || man.distance < best.d)) best = { key: `person|${key}`, d: man.distance }
    }
    return best?.key ?? null
  }

  /** Load and upload what the cards in view need — models, wall labels,
   *  shaders — while still flat, so the first frames of a tilt have
   *  nothing left to do. Draws nothing on screen. */
  const warmRT = new THREE.WebGLRenderTarget(4, 4)
  function warm(W: number, H: number, targets: TiltTarget[], st: TiltFrameState) {
    frame(performance.now(), W, H, targets, { ...st, tilt: 30 }, warmRT)
  }

  /** The url and model units per metre of a model on screen. */
  function info(key: string): { url: string; unit: number } | null {
    const s = standing.get(key)
    return s ? { url: s.url, unit: s.unit } : null
  }

  function dispose() {
    for (const [key, s] of [...standing]) drop(key, s)
    maskRT.dispose()
    warmRT.dispose()
    outlineMat.dispose()
    envRT.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
  }

  return { frame, warm, pick, info, dispose }
}
