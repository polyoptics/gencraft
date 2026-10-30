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
import { TILT_PERSPECTIVE, DEFAULT_LIGHT, type TiltWire, type TiltLight } from '../store/tiltStore'

const DEFAULT_SHADOWS = DEFAULT_LIGHT.shadows, DEFAULT_SHEEN = DEFAULT_LIGHT.sheen
/** How long a model's pop onto a Viewer takes. */
const POP_MS = 320
/** How long a model takes to grow in when it comes into view in 3D (the
 *  tilt itself fades the whole look in and out: TiltLayer's FADE_TILT). */
export const FADE_MS = 500

/** Drawn only where the artwork mask (stencil 1) is not. */
const SKIP_ART = {
  stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc,
  stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
} as const

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
  /** How high the card it stands on is (px): a deck's or a lifted card's top. */
  z?: number
  /** Arrives with a quick scale-up pop (a model moving onto a Viewer). */
  pop?: boolean
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
  /** Height of the face above the plane, px: a card lifted off a tray's
   *  floor. Default 0. */
  z?: number
  /** Stood up on a hinge (console mode): turned by `a` radians about the
   *  line across the plane at flat `v` (px from the centre, y down) and
   *  height `z`, its far side rising. A card and its raised parts share one. */
  hinge?: { v: number; z: number; a: number }
  /** Draw its top in its side colour: nothing in the DOM covers it. */
  cap?: boolean
  /** A raised rim round the edge (a tray): its width and height, px. */
  rim?: { w: number; h: number }
  /** A small raised part (a header, button or banner): the sheen covers
   *  all of it. Elsewhere it only runs round the face's border. */
  pop?: boolean
  /** With a hinge: only its top turns; its walls drop straight to the
   *  floor from the turned top's edge (a wedge, sloped on top). */
  loft?: boolean
  /** Furniture three.js alone draws (console mode's sloped back), owned by
   *  this key: its top is coloured and solid, it gets no sheen, and pick()
   *  answers `deco|<owner>` for it. */
  deco?: string
}

/** Artwork on the plane — a picture, video or Viewer screen — as a rect
 *  (centre u, v and size w, h in flat px, z its height). The light's
 *  shadows and sheen never fall on these: artwork shows exactly as it is
 *  (Brian 2026-10-30). */
export interface TiltArt { u: number; v: number; w: number; h: number; z: number }

export interface TiltFrameState {
  tilt: number
  /** The camera's sideways move (screen px), tiltStore's shiftX/Y. */
  shiftX: number
  shiftY: number
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
  art: TiltArt[]
  /** How far in the 3D look has come (0 → 1 as the canvas tips back, and
   *  1 → 0 as it lies flat again), eased: the sheen and models follow it.
   *  The raised parts come already scaled by it. */
  fade: number
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
  /** When its model first showed (ms), to grow or pop it in from. */
  shownAt: number
  /** Its model's own materials (copies: the cached ones are shared with the
   *  Viewers and posters), each with the opacity and transparency it came
   *  with, and the fade they were last set to. */
  mats: { m: THREE.Material; o: number; t: boolean }[]
  alpha: number
}

const WIRE_MAT = new THREE.MeshBasicMaterial({ color: 0x9fd0ff, wireframe: true, transparent: true, opacity: 0.85 })
/** Over a surface the wire is drawn where the surface is, so it may sit
 *  exactly on it: LessEqual lets it win those ties. */
const WIRE_OVER_MAT = new THREE.MeshBasicMaterial({ color: 0x9fd0ff, wireframe: true, transparent: true, opacity: 0.55, depthFunc: THREE.LessEqualDepth, depthWrite: false })
/** Texture off: plain clay. Flat comes from the light rig, not this. */
const CLAY_MAT = new THREE.MeshStandardMaterial({ color: 0xc8ccd8, roughness: 0.85, metalness: 0 })
/** Set `m` to `o` × the 3D look's fade, see-through only while fading. */
function fadeMat(m: THREE.Material, o: number, t: boolean, fade: number) {
  m.opacity = o * fade
  const see = t || fade < 1
  if (m.transparent !== see) { m.transparent = see; m.needsUpdate = true }
}
const PLACARD_GEO = new THREE.BoxGeometry(0.985, 0.96, 1)
const PLACARD_MAT = new THREE.MeshStandardMaterial({ color: 0x1a1c28, roughness: 0.7, emissive: 0x15161f })
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
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, stencil: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setClearColor(0x000000, 0)
  // Brighter, with highlights (Brian 2026-10-30): a soft studio environment
  // the models reflect, and a tone map so the bright parts roll off
  // instead of washing out.
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1
  // Shadows from the one light (key) onto the canvas. Updated by hand, once
  // per pass that needs it: the clay and wireframe passes reuse the map.
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.shadowMap.autoUpdate = false
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
  pmrem.dispose()

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
  const deco = new THREE.Scene()
  deco.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.2))
  const ground = new THREE.Group(); ground.matrixAutoUpdate = false; scene.add(ground)
  const groundDeco = new THREE.Group(); groundDeco.matrixAutoUpdate = false; deco.add(groundDeco)
  // One light for the whole view (Brian 2026-10-30): the Light panel's key
  // lights the models, the slabs' sides and a sheen on every face, and
  // casts shadows on the canvas. It lives on the plane, so it turns with
  // it. Two copies, one per scene, kept in step each frame.
  const shadowLight = (l: THREE.DirectionalLight) => {
    l.castShadow = true
    l.shadow.mapSize.set(2048, 2048)
    l.shadow.bias = -0.0006
    l.shadow.normalBias = 0.5
    l.shadow.radius = 3
    return l
  }
  const key = shadowLight(new THREE.DirectionalLight(0xffffff, 2))
  ground.add(key, key.target)
  const decoKey = shadowLight(new THREE.DirectionalLight(0xffffff, 1.5))
  groundDeco.add(decoKey, decoKey.target)
  // The canvas as a shadow catcher: invisible but for the shadows on it.
  // No depth write, so slab sides drawn below the plane still show.
  const catcher = () => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.45, depthWrite: false, ...SKIP_ART }))
    m.receiveShadow = true
    m.renderOrder = 10
    m.frustumCulled = false
    return m
  }
  const modelShadow = catcher(); ground.add(modelShadow)
  const slabShadow = catcher(); groundDeco.add(slabShadow)
  // It lies in the same plane as the faces' depth-only tops: pulled a hair
  // towards the camera so it is not lost behind them.
  Object.assign(slabShadow.material, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })

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
    // A little thickness behind the label, so it reads as a placard and
    // not a sheet of paper from the side.
    const back = new THREE.Mesh(PLACARD_GEO, PLACARD_MAT)
    back.name = 'placard'
    wall.add(back)
    wall.visible = false
    groundDeco.add(wall)
    const s: Standing = {
      url, stand, turn, inst: null, size: new THREE.Vector3(), unit: 1, unitSet: false, triangles: 0,
      figure, wall, wallText: '', smooth: null, smoothOn: false, phase: Math.random() * 6.28, dead: false, seen: frameNo, shownAt: 0,
      mats: [], alpha: -1,
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
      inst.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = true })
      // Its own materials, so it can fade with the tilt and not fade the
      // same model in a Viewer or a poster.
      const own = (m: THREE.Material) => {
        const c = m.clone()
        s.mats.push({ m: c, o: c.opacity, t: c.transparent })
        return c
      }
      inst.traverse(o => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh) mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material)
      })
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
    for (const { m } of s.mats) m.dispose()
    standing.delete(key)
  }

  // ── Thickness (Brian 2026-10-30) ──
  // Every card, deck, tile and Viewer is a slab: the DOM element is its top
  // face and its sides are drawn here, going down from it. A loop strip is
  // a tray: a rim stands up round its edge, and the cards docked in it are
  // lifted off its floor (the DOM is moved up too, TiltLayer), each with
  // its own sides. All slabs are rebuilt into one pair of buffers each
  // frame (they move with every pan and zoom): the sides, lit, and the
  // tops, depth only, so a nearer slab hides what is behind it as a solid
  // would.
  // ── Fitting a shadow map round its casters ──
  const lightDir = new THREE.Vector3(0, 0, 1)
  const invGround = new THREE.Matrix4()
  const fitBox = new THREE.Box3(), tmpBox = new THREE.Box3(), slabBox = new THREE.Box3()
  const fitC = new THREE.Vector3(), fitS = new THREE.Vector3()
  let shadowsOn = false, modelCast = false
  /** Aim `l` down lightDir at the middle of `box` (plane coordinates) with
   *  a shadow camera just wide enough for it: its shadows fall inside that
   *  prism, whatever the light's angle. False when nothing casts. */
  function fitShadow(l: THREE.DirectionalLight, box: THREE.Box3): boolean {
    if (box.isEmpty()) return false
    box.getCenter(fitC)
    const r = box.getSize(fitS).length() / 2 + 4
    const D = r * 2 + 100
    l.target.position.copy(fitC)
    l.position.copy(fitC).addScaledVector(lightDir, D)
    const c = l.shadow.camera
    c.left = c.bottom = -r; c.right = c.top = r
    c.near = Math.max(1, D - r - 10)
    c.far = D + r + (fitC.z + r) / Math.max(0.05, lightDir.z)
    c.updateProjectionMatrix()
    return true
  }

  /** Which side triangles are furniture, and whose (pick()). */
  const decoTris: { from: number; to: number; owner: string }[] = []
  const SLAB_MAX = 200, CORNER_SEG = 4
  const RING = 4 * (CORNER_SEG + 1)
  const SIDE_V = SLAB_MAX * (RING * 8 + 2), SIDE_I = SLAB_MAX * RING * 24
  const sideGeo = new THREE.BufferGeometry()
  const sidePos = new Float32Array(SIDE_V * 3)
  const sideNrm = new Float32Array(SIDE_V * 3)
  const sideCol = new Float32Array(SIDE_V * 3)
  const sideIdx = new Uint32Array(SIDE_I)
  sideGeo.setAttribute('position', new THREE.BufferAttribute(sidePos, 3).setUsage(THREE.DynamicDrawUsage))
  sideGeo.setAttribute('normal', new THREE.BufferAttribute(sideNrm, 3).setUsage(THREE.DynamicDrawUsage))
  sideGeo.setAttribute('color', new THREE.BufferAttribute(sideCol, 3).setUsage(THREE.DynamicDrawUsage))
  sideGeo.setIndex(new THREE.BufferAttribute(sideIdx, 1))
  const topGeo = new THREE.BufferGeometry()
  const topPos = new Float32Array(SLAB_MAX * (RING + 1) * 3)
  const topIdx = new Uint32Array(SLAB_MAX * RING * 3)
  topGeo.setAttribute('position', new THREE.BufferAttribute(topPos, 3).setUsage(THREE.DynamicDrawUsage))
  // Every face looks straight up off the plane. The top fans wind
  // clockwise as seen from above, so three draws them as back faces and
  // flips their normal: store it pointing down.
  const topNrm = new Float32Array(topPos.length)
  for (let i = 2; i < topNrm.length; i += 3) topNrm[i] = -1
  topGeo.setAttribute('normal', new THREE.BufferAttribute(topNrm, 3))
  topGeo.setIndex(new THREE.BufferAttribute(topIdx, 1))
  const sideMesh = new THREE.Mesh(sideGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, emissive: 0x2a2e3c }))
  const topMesh = new THREE.Mesh(topGeo, new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }))
  // The sheen: the key light's highlight on the faces (the DOM draws them;
  // this adds only the shine, black plus specular, added on top).
  const SHEEN_SPEC = new THREE.Color(0x9aa4bc)
  const SHEEN_MAT = new THREE.MeshPhongMaterial({
    color: 0x000000, specular: SHEEN_SPEC.clone(), shininess: 14, side: THREE.DoubleSide, ...SKIP_ART,
    // Added to the colour only: the canvas's alpha stays as it was, so the
    // DOM face under it still shows (adding alpha too paints it black).
    transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    depthWrite: false, depthFunc: THREE.LessEqualDepth,
    // In the plane of the depth-only tops but triangulated differently: pulled
    // a hair towards the camera, or it fights them and buzzes.
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  })
  // Where the sheen goes (Brian 2026-10-30): a band round each face's
  // border and the whole of small raised parts — never across a face,
  // where the work is (pictures, an effect card's text).
  const SHEEN_V = SLAB_MAX * (RING * 2 + 1)
  const sheenPos = new Float32Array(SHEEN_V * 3)
  const sheenNrm = new Float32Array(SHEEN_V * 3)
  for (let i = 2; i < sheenNrm.length; i += 3) sheenNrm[i] = -1   // as the tops: wound as back faces
  const sheenIdx = new Uint32Array(SLAB_MAX * RING * 6)
  const sheenGeo = new THREE.BufferGeometry()
  sheenGeo.setAttribute('position', new THREE.BufferAttribute(sheenPos, 3).setUsage(THREE.DynamicDrawUsage))
  // Not turned with a leaning face: turned, its shine faced the camera and
  // washed out its name and edges. Lit as if flat, it reads as before.
  sheenGeo.setAttribute('normal', new THREE.BufferAttribute(sheenNrm, 3))
  sheenGeo.setIndex(new THREE.BufferAttribute(sheenIdx, 1))
  const sheenMesh = new THREE.Mesh(sheenGeo, SHEEN_MAT)
  sideMesh.frustumCulled = topMesh.frustumCulled = sheenMesh.frustumCulled = false
  topMesh.renderOrder = -1
  sheenMesh.renderOrder = 11
  // Shadows come from the sides and from faces lifted off the plane (a
  // docked card). A face flush with the canvas would only shade itself
  // (the speckle Brian saw), so those tops cast nothing.
  const liftGeo = new THREE.BufferGeometry()
  liftGeo.setAttribute('position', topGeo.getAttribute('position'))
  const liftIdx = new Uint32Array(topIdx.length)
  liftGeo.setIndex(new THREE.BufferAttribute(liftIdx, 1))
  const liftMesh = new THREE.Mesh(liftGeo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide }))
  liftMesh.frustumCulled = false
  liftMesh.castShadow = true
  // Lifted faces catch shadows too (a raised button's, on its card).
  liftGeo.setAttribute('normal', topGeo.getAttribute('normal'))
  const liftCatch = new THREE.Mesh(liftGeo, new THREE.ShadowMaterial({
    opacity: 0.45, depthWrite: false, depthFunc: THREE.LessEqualDepth, side: THREE.DoubleSide, ...SKIP_ART,
  }))
  liftCatch.receiveShadow = true
  liftCatch.renderOrder = 10
  liftCatch.frustumCulled = false
  sideMesh.castShadow = true
  groundDeco.add(topMesh, sideMesh, sheenMesh, liftMesh, liftCatch)

  // ── Artwork mask: each picture's rect goes into the stencil first, and
  // the shadow catchers and the sheen skip it. ──
  const ART_MAX = 200
  const artPos = new Float32Array(ART_MAX * 4 * 3)
  const artIdx = new Uint32Array(ART_MAX * 6)
  for (let i = 0; i < ART_MAX; i++) {
    const o = i * 6, v = i * 4
    artIdx.set([v, v + 1, v + 2, v, v + 2, v + 3], o)
  }
  const artGeo = new THREE.BufferGeometry()
  artGeo.setAttribute('position', new THREE.BufferAttribute(artPos, 3).setUsage(THREE.DynamicDrawUsage))
  artGeo.setIndex(new THREE.BufferAttribute(artIdx, 1))
  const artMesh = new THREE.Mesh(artGeo, new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
  }))
  artMesh.frustumCulled = false
  const artScene = new THREE.Scene()
  const groundArt = new THREE.Group(); groundArt.matrixAutoUpdate = false
  groundArt.add(artMesh); artScene.add(groundArt)
  function buildArt(art: TiltArt[]) {
    const n = Math.min(art.length, ART_MAX)
    for (let k = 0; k < n; k++) {
      const a = art[k], o = k * 12
      const x0 = a.u - a.w / 2, x1 = a.u + a.w / 2, y0 = -(a.v - a.h / 2), y1 = -(a.v + a.h / 2)
      artPos.set([x0, y0, a.z, x1, y0, a.z, x1, y1, a.z, x0, y1, a.z], o)
    }
    artGeo.getAttribute('position').needsUpdate = true
    artGeo.setDrawRange(0, n * 6)
  }
  const col = new THREE.Color()

  /** A rounded-rect outline: RING points (x, y in the plane's y-up frame)
   *  with their outward normals. */
  const ox = new Float32Array(RING), oy = new Float32Array(RING), onx = new Float32Array(RING), ony = new Float32Array(RING)
  const ix = new Float32Array(RING), iy = new Float32Array(RING)
  function outline(u: number, v: number, hw: number, hh: number, r: number, X: Float32Array, Y: Float32Array, NX?: Float32Array, NY?: Float32Array) {
    r = Math.max(0, Math.min(r, hw, hh))
    const corners = [[hw - r, hh - r, 0], [-(hw - r), hh - r, Math.PI / 2], [-(hw - r), -(hh - r), Math.PI], [hw - r, -(hh - r), Math.PI * 1.5]] as const
    let p = 0
    for (const [cx, cy, a0] of corners) {
      for (let i = 0; i <= CORNER_SEG; i++, p++) {
        const a = a0 + (i / CORNER_SEG) * (Math.PI / 2)
        const nx = Math.cos(a), ny = Math.sin(a)
        X[p] = u + cx + nx * r; Y[p] = -v - (cy + ny * r)
        if (NX && NY) { NX[p] = nx; NY[p] = -ny }
      }
    }
  }

  function buildSlabs(slabs: TiltSlab[]) {
    const n = Math.min(slabs.length, SLAB_MAX)
    let sv = 0, si = 0, tv = 0, ti = 0, li = 0, hv = 0, hi = 0
    slabBox.makeEmpty()
    decoTris.length = 0
    const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, shade: number) => {
      const o = sv * 3
      sidePos[o] = x; sidePos[o + 1] = y; sidePos[o + 2] = z
      sideNrm[o] = nx; sideNrm[o + 1] = ny; sideNrm[o + 2] = nz
      sideCol[o] = col.r * shade; sideCol[o + 1] = col.g * shade; sideCol[o + 2] = col.b * shade
      return sv++
    }
    /** A band of quads between two rings of vertices (a0.., b0..). */
    const band = (a0: number, b0: number, flip: boolean) => {
      for (let i = 0; i < RING; i++) {
        const j = (i + 1) % RING
        const a = a0 + i, a2 = a0 + j, b = b0 + i, b2 = b0 + j
        if (flip) { sideIdx[si++] = a; sideIdx[si++] = b; sideIdx[si++] = a2; sideIdx[si++] = a2; sideIdx[si++] = b; sideIdx[si++] = b2 }
        else { sideIdx[si++] = a; sideIdx[si++] = a2; sideIdx[si++] = b; sideIdx[si++] = a2; sideIdx[si++] = b2; sideIdx[si++] = b }
      }
    }
    // Stand a slab's vertices up on its hinge (positions, and normals).
    const turn = (P: Float32Array, N: Float32Array | null, from: number, to: number, h: { v: number; z: number; a: number }) => {
      const c = Math.cos(h.a), sn = Math.sin(h.a), y0 = -h.v
      for (let o = from * 3; o < to * 3; o += 3) {
        const dy = P[o + 1] - y0, dz = P[o + 2] - h.z
        P[o + 1] = y0 + dy * c - dz * sn; P[o + 2] = h.z + dy * sn + dz * c
        if (N) { const ny = N[o + 1], nz = N[o + 2]; N[o + 1] = ny * c - nz * sn; N[o + 2] = ny * sn + nz * c }
      }
    }
    for (let k = 0; k < n; k++) {
      const s = slabs[k]
      const hw = s.w / 2, hh = s.h / 2
      const z = s.z ?? 0
      const sv0 = sv, tv0 = tv / 3, hv0 = hv / 3, si0 = si
      col.setHex(s.color)
      outline(s.u, s.v, hw, hh, s.r, ox, oy, onx, ony)
      const rimH = s.rim ? s.rim.h : 0
      // What stands up off the plane casts the slabs' shadows.
      if (z > 0.5 || rimH > 0) {
        slabBox.expandByPoint(fitC.set(s.u - hw, -s.v - hh, 0))
        slabBox.expandByPoint(fitC.set(s.u + hw, -s.v + hh, z + rimH))
      }
      // Outer wall: from the rim's top (or the face) down to the bottom.
      const up = sv; for (let i = 0; i < RING; i++) vert(ox[i], oy[i], z + rimH, onx[i], ony[i], 0, 1)
      const dn = sv; for (let i = 0; i < RING; i++) vert(ox[i], oy[i], z - s.t, onx[i], ony[i], 0, 0.7)
      band(up, dn, false)
      if (s.rim) {
        const rw = s.rim.w
        outline(s.u, s.v, hw - rw, hh - rw, s.r - rw, ix, iy)
        // The rim's top, then its inner wall down to the floor (the face).
        const o0 = sv; for (let i = 0; i < RING; i++) vert(ox[i], oy[i], z + rimH, 0, 0, 1, 1.1)
        const i0 = sv; for (let i = 0; i < RING; i++) vert(ix[i], iy[i], z + rimH, 0, 0, 1, 1.1)
        band(o0, i0, true)
        const w0 = sv; for (let i = 0; i < RING; i++) vert(ix[i], iy[i], z + rimH, -onx[i], -ony[i], 0, 0.9)
        const w1 = sv; for (let i = 0; i < RING; i++) vert(ix[i], iy[i], z, -onx[i], -ony[i], 0, 0.6)
        band(w0, w1, true)
      }
      // A bottom, for a camera panned down under the canvas (Brian
      // 2026-10-30): from below a slab is solid, not hollow.
      const c0 = vert(s.u, -s.v, z - s.t, 0, 0, -1, 0.45)
      const b0 = sv; for (let i = 0; i < RING; i++) vert(ox[i], oy[i], z - s.t, 0, 0, -1, 0.45)
      for (let i = 0; i < RING; i++) { sideIdx[si++] = c0; sideIdx[si++] = b0 + i; sideIdx[si++] = b0 + ((i + 1) % RING) }
      // A coloured top, for a slab no DOM face covers (a deck's lower cards).
      const capAt = sv
      if (s.cap) {
        const c1 = vert(s.u, -s.v, z, 0, 0, 1, 1)
        const b1 = sv; for (let i = 0; i < RING; i++) vert(ox[i], oy[i], z, 0, 0, 1, 1)
        for (let i = 0; i < RING; i++) { sideIdx[si++] = c1; sideIdx[si++] = b1 + ((i + 1) % RING); sideIdx[si++] = b1 + i }
      }
      if (s.deco) {
        // Solid and coloured all through, and nothing of the DOM's: no
        // depth-only top, no sheen, casts by its walls.
        if (s.hinge && s.loft) {
          turn(sidePos, null, up, up + RING, s.hinge)
          turn(sidePos, sideNrm, capAt, sv, s.hinge)
          // The walls and the bottom drop straight down from the turned edge.
          for (let i = 0; i < RING; i++) {
            const f = (up + i) * 3
            for (const r of [dn, b0]) { const o = (r + i) * 3; sidePos[o] = sidePos[f]; sidePos[o + 1] = sidePos[f + 1] }
          }
          const m = (capAt) * 3
          if (s.cap) { sidePos[c0 * 3] = sidePos[m]; sidePos[c0 * 3 + 1] = sidePos[m + 1] }
        } else if (s.hinge) {
          turn(sidePos, sideNrm, sv0, sv, s.hinge)
        }
        for (let o = sv0 * 3; o < sv * 3; o += 3) slabBox.expandByPoint(fitC.set(sidePos[o], sidePos[o + 1], sidePos[o + 2]))
        decoTris.push({ from: si0 / 3, to: si / 3, owner: s.deco })
        continue
      }
      // Depth-only top at the face.
      const top0 = tv / 3
      topPos[tv++] = s.u; topPos[tv++] = -s.v; topPos[tv++] = z
      for (let i = 0; i < RING; i++) { topPos[tv++] = ox[i]; topPos[tv++] = oy[i]; topPos[tv++] = z }
      for (let i = 0; i < RING; i++) { topIdx[ti++] = top0; topIdx[ti++] = top0 + 1 + i; topIdx[ti++] = top0 + 1 + ((i + 1) % RING) }
      // Not a leaning face: its normals stay the flat ones, so it would
      // catch and cast askew. Its turned walls still cast.
      if (z > 0.5 && !s.hinge) for (let i = 0; i < RING; i++) { liftIdx[li++] = top0; liftIdx[li++] = top0 + 1 + i; liftIdx[li++] = top0 + 1 + ((i + 1) % RING) }
      // Sheen: the outline, and an inset ring (or the centre, for a small
      // raised part), wound the same way as the top's fan.
      if (s.hinge) {
        turn(sidePos, sideNrm, sv0, sv, s.hinge)
        turn(topPos, null, tv0, tv / 3, s.hinge)
        for (let o = sv0 * 3; o < sv * 3; o += 3) slabBox.expandByPoint(fitC.set(sidePos[o], sidePos[o + 1], sidePos[o + 2]))
      }
      // Round buttons get none: a highlight on a disc reads as a second,
      // misregistered disc.
      if (s.pop && Math.max(s.w, s.h) < Math.min(s.w, s.h) * 1.6) continue
      const o0 = hv / 3
      for (let i = 0; i < RING; i++) { sheenPos[hv++] = ox[i]; sheenPos[hv++] = oy[i]; sheenPos[hv++] = z }
      if (s.pop) {
        const c = hv / 3
        sheenPos[hv++] = s.u; sheenPos[hv++] = -s.v; sheenPos[hv++] = z
        for (let i = 0; i < RING; i++) { sheenIdx[hi++] = c; sheenIdx[hi++] = o0 + i; sheenIdx[hi++] = o0 + (i + 1) % RING }
      } else {
        const bw = Math.max(2, Math.min(14, Math.min(s.w, s.h) * 0.05))
        outline(s.u, s.v, hw - bw, hh - bw, Math.max(0, s.r - bw), ix, iy)
        const i0 = hv / 3
        for (let i = 0; i < RING; i++) { sheenPos[hv++] = ix[i]; sheenPos[hv++] = iy[i]; sheenPos[hv++] = z }
        for (let i = 0; i < RING; i++) {
          const j = (i + 1) % RING
          sheenIdx[hi++] = i0 + i; sheenIdx[hi++] = o0 + i; sheenIdx[hi++] = o0 + j
          sheenIdx[hi++] = i0 + i; sheenIdx[hi++] = o0 + j; sheenIdx[hi++] = i0 + j
        }
      }
      if (s.hinge) turn(sheenPos, null, hv0, hv / 3, s.hinge)
    }
    sheenGeo.getAttribute('position').needsUpdate = true
    sheenGeo.index!.needsUpdate = true
    sheenGeo.setDrawRange(0, hi)
    for (const g of [sideGeo, topGeo]) {
      for (const a of Object.values(g.attributes)) (a as THREE.BufferAttribute).needsUpdate = true
      g.index!.needsUpdate = true
    }
    liftGeo.index!.needsUpdate = true
    sideGeo.setDrawRange(0, si)
    topGeo.setDrawRange(0, ti)
    liftGeo.setDrawRange(0, li)
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
    // CSS translate(shift) before the rotations is a move in three's view
    // plane too (y flipped).
    ground.matrix.makeTranslation(st.shiftX, -st.shiftY, 0).multiply(F).multiply(R).multiply(F)
    ground.matrixWorldNeedsUpdate = true
    groundDeco.matrix.copy(ground.matrix)
    groundDeco.matrixWorldNeedsUpdate = true
    groundArt.matrix.copy(ground.matrix)
    groundArt.matrixWorldNeedsUpdate = true

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
      s.stand.position.set(tg.u, -tg.v, tg.z ?? 0)
      const foot = Math.max(s.size.x, s.size.z, 1e-6)
      let k = (tg.w * 0.6) / foot
      if (s.size.y * k > tg.w * 1.1) k = (tg.w * 1.1) / Math.max(s.size.y, 1e-6)
      k *= st.sizeFor(tg.key)
      // ...and grow up out of them when the tilt starts, or when one
      // turns up while tilted, rather than popping on.
      if (s.inst && !s.shownAt) s.shownAt = now
      if (tg.pop) {
        // Overshoot a touch and settle: 0 → 1 over POP_MS.
        const x = s.shownAt ? Math.min(1, (now - s.shownAt) / POP_MS) : 0
        const c = 1.7, y = x - 1
        k *= Math.max(0.001, 1 + (c + 1) * y * y * y + c * y * y)
      }
      const since = s.shownAt ? 1 - (1 - Math.min(1, (now - s.shownAt) / FADE_MS)) ** 3 : 0
      // Tipping in, a model fades in with the rest of the 3D look, already
      // standing some way up: grown up from flat, it lay over its card's
      // picture as a flat print of its footprint in the first degrees of
      // tilt (Brian 2026-10-30). A Viewer's still pops up from flat.
      const up = tg.pop ? ease : 0.4 + 0.6 * ease
      s.stand.scale.set(k, k * Math.max(up * (tg.pop ? 1 : since), 0.001), k)
      if (s.alpha !== st.fade) {
        s.alpha = st.fade
        for (const x of s.mats) fadeMat(x.m, x.o, x.t, st.fade)
      }
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
      const d = Math.max(1.5, wallH * 0.07)
      const back = s.wall.getObjectByName('placard')!
      back.scale.z = d
      back.position.z = -d / 2 - 0.3
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
    // The artwork mask goes in first, on a cleared buffer (stencil too);
    // every pass after draws over it without clearing.
    buildArt(st.tilt > 0.5 || st.fade > 0 ? st.art : [])
    renderer.autoClear = true
    renderer.render(artScene, camera)
    renderer.autoClear = false
    litRig.visible = !st.flat
    key.visible = !st.flat
    flatRig.visible = st.flat
    {
      const L = st.light
      const az = (L.azimuth * Math.PI / 180) + (L.spin && st.turn ? now / 1000 * 0.6 : 0)
      const el = Math.max(2, Math.min(90, L.elevation)) * Math.PI / 180
      const span = Math.max(W, H) * 1.6
      lightDir.set(Math.cos(el) * Math.sin(az), -Math.cos(el) * Math.cos(az), Math.sin(el))
      // The models' shadow map is fitted round the models alone, so every
      // texel is small and the edges stay crisp.
      ground.updateMatrixWorld(true)
      invGround.copy(ground.matrixWorld).invert()
      fitBox.makeEmpty()
      for (const s of standing.values()) {
        if (!s.stand.visible) continue
        s.stand.updateWorldMatrix(false, true)
        fitBox.union(tmpBox.setFromObject(s.stand).applyMatrix4(invGround))
      }
      modelCast = fitShadow(key, fitBox)
      key.intensity = L.power
      decoKey.intensity = L.power * 0.5
      scene.environmentIntensity = st.flat ? 0.6 : L.env
      const shadows = L.shadows ?? DEFAULT_SHADOWS, sheen = L.sheen ?? DEFAULT_SHEEN
      for (const m of [modelShadow, slabShadow]) m.scale.set(span * 2, span * 2, 1)
      for (const m of [modelShadow, slabShadow, liftCatch]) (m.material as THREE.ShadowMaterial).opacity = shadows
      ;(modelShadow.material as THREE.ShadowMaterial).opacity = shadows * st.fade
      // The clay, wire and person looks fade in and out with the models.
      fadeMat(CLAY_MAT, 1, false, st.fade)
      fadeMat(WIRE_MAT, 0.85, true, st.fade)
      fadeMat(WIRE_OVER_MAT, 0.55, true, st.fade)
      fadeMat(FIGURE_MAT, 0.85, true, st.fade)
      shadowsOn = shadows > 0.01 && !st.flat
      key.castShadow = shadowsOn && modelCast
      const type = L.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap
      if (renderer.shadowMap.type !== type) {
        renderer.shadowMap.type = type
        for (const m of [modelShadow, slabShadow, liftCatch]) (m.material as THREE.Material).needsUpdate = true
      }
      // The sheen follows the light's strength, but never glares.
      SHEEN_MAT.opacity = Math.min(1, sheen * L.power / 3)
      // It fades up as the canvas tips, and away as it lies flat, rather
      // than switching on and off (Brian 2026-10-30).
      SHEEN_MAT.specular.copy(SHEEN_SPEC).multiplyScalar(st.fade)
      sheenMesh.visible = sheen > 0.01 && !st.flat
    }
    // The catcher must not take the clay or wireframe look: it is drawn on
    // its own after those passes, with the models hidden and the shadow
    // map they made.
    const overridden = st.wire === 'only' || !st.texture
    modelShadow.visible = key.castShadow && !overridden
    renderer.shadowMap.needsUpdate = true
    if (st.wire === 'only') {
      scene.overrideMaterial = WIRE_MAT
      renderer.render(scene, camera)
      renderer.autoClear = false
    } else {
      scene.overrideMaterial = st.texture ? null : CLAY_MAT
      renderer.render(scene, camera)
      renderer.autoClear = false
      if (st.wire === 'over') {
        const was = modelShadow.visible
        modelShadow.visible = false
        scene.overrideMaterial = WIRE_OVER_MAT
        renderer.render(scene, camera)
        modelShadow.visible = was
      }
    }
    scene.overrideMaterial = null
    if (overridden && key.castShadow) {
      const shown = [...standing.values()].filter(s => s.stand.visible)
      for (const s of shown) s.stand.visible = false
      modelShadow.visible = true
      renderer.render(scene, camera)
      for (const s of shown) s.stand.visible = true
    }
    renderer.shadowMap.needsUpdate = true
    buildSlabs(st.tilt > 0.5 || st.fade > 0 ? st.slabs : [])
    // The slabs' shadow map, fitted round what stands up off the plane.
    decoKey.castShadow = shadowsOn && fitShadow(decoKey, slabBox)
    liftCatch.visible = decoKey.castShadow
    renderer.render(deco, camera)
    if (into) { renderer.setRenderTarget(null); return }

    // Outlines: paint the silhouettes into a mask, then ring them.
    const outlined = [...standing.entries()].filter(([key, s]) =>
      s.stand.visible && (st.selected.has(key) || key === st.hovered))
    if (outlined.length) {
      const vis = new Map<THREE.Object3D, boolean>()
      for (const s of standing.values()) { vis.set(s.stand, s.stand.visible); vis.set(s.figure, s.figure.visible); s.figure.visible = false }
      // The shadow catcher is a plane as big as the view: in the mask it
      // would ring the whole ground and swamp the models on it.
      vis.set(modelShadow, modelShadow.visible); modelShadow.visible = false
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
  /** How high (px off the plane) the last furniture pick hit it. */
  let pickedZ = 0
  function pick(x: number, y: number): string | null {
    if (!lastW || !lastH) return null
    raycaster.setFromCamera(new THREE.Vector2((x / lastW) * 2 - 1, -(y / lastH) * 2 + 1), camera)
    // A raised part (a button, an arrow, a nearer card) in front of a model
    // hides it, and takes the click: only a model nearer than those counts.
    // Furniture three.js alone draws answers for its owner.
    let best: { key: string; d: number } | null = null
    for (const m of [topMesh, sideMesh]) {
      m.geometry.computeBoundingSphere()
      const hit = raycaster.intersectObject(m, false)[0]
      if (!hit || (best && hit.distance >= best.d)) continue
      const f = m === sideMesh && hit.faceIndex != null ? decoTris.find(d => hit.faceIndex! >= d.from && hit.faceIndex! < d.to) : undefined
      best = { key: f ? `deco|${f.owner}` : '', d: hit.distance }
      if (f) pickedZ = groundDeco.worldToLocal(hit.point.clone()).z
    }
    for (const [key, s] of standing) {
      if (!s.stand.visible || !s.inst) continue
      const hit = raycaster.intersectObject(s.turn, true)[0]
      if (hit && (!best || hit.distance < best.d)) best = { key, d: hit.distance }
      const man = s.figure.visible ? raycaster.intersectObject(s.figure, true)[0] : undefined
      if (man && (!best || man.distance < best.d)) best = { key: `person|${key}`, d: man.distance }
    }
    return best?.key || null
  }

  /** Load and upload what the cards in view need — models, wall labels,
   *  shaders — while still flat, so the first frames of a tilt have
   *  nothing left to do. Draws nothing on screen. */
  const warmRT = new THREE.WebGLRenderTarget(4, 4)
  function warm(W: number, H: number, targets: TiltTarget[], st: TiltFrameState) {
    frame(performance.now(), W, H, targets, { ...st, tilt: 30, shiftX: 0, shiftY: 0 }, warmRT)
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

  return { frame, warm, pick, pickZ: () => pickedZ, info, dispose }
}
