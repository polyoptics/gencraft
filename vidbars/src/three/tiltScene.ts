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
import { acquireModel, releaseModel, disposeInstance } from './modelCache'
import { computePosedBounds } from './orbitState'
import { createLook, applyLook, disposeLook, type LookInstance, type ModelShade } from './modelLook'
import { TILT_PERSPECTIVE, DEFAULT_LIGHT, CAMERA_LENS, type TiltLight, type CameraLens } from '../store/tiltStore'
import { CAMERA_URL, CAMERA_LENS_AT } from './primitives'
import { createNotesOverlay, type NotesHost } from './notesOverlay'
import type { ModelNotes } from '../store/notesStore'

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
  /** Standing off its card (in a 3D area's scene): where the card is, for
   *  its back wall. */
  wall?: { u: number; v: number; h: number }
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
  /** How far past the face, px, its depth-only top reaches: a selection
   *  ring the DOM draws round it, kept clear of what stands behind it. */
  ring?: number
  /** A raised rim round the edge (a tray): its width and height, px. */
  rim?: { w: number; h: number }
  /** A small raised part (a header, button or banner): the sheen covers
   *  all of it. Elsewhere it only runs round the face's border. */
  pop?: boolean
  /** No sheen at all: a raised part that is mostly text (an effect card's
   *  name), where a shine greyed the words over in 3D alone. */
  bare?: boolean
  /** With a hinge: only its top turns; its walls drop straight to the
   *  floor from the turned top's edge (a wedge, sloped on top). */
  loft?: boolean
  /** Furniture three.js alone draws (console mode's sloped back), owned by
   *  this key: its top is coloured and solid, it gets no sheen, and pick()
   *  answers `deco|<owner>` for it. */
  deco?: string
  /** pick() sees through it: the plate under a mark the page draws with
   *  no pointer events (a drop mark), so the press is what is behind. */
  nopick?: boolean
  /** What its walls (and coloured top) are made of (FINISH): how rough,
   *  how metal, how much it glows. Default: a card's painted edge. */
  finish?: TiltFinish
  /** A bright machined line round its outer wall, this far below its top
   *  (px): the parting line of a two-part case. */
  seam?: number
  /** A chamfer round its top edge, px (and its rim's): a machined edge
   *  that catches the light. Only on a slab no DOM face covers to its
   *  edge (a rim, or furniture). */
  bevel?: number
  /** Turned in the plane about its own middle, radians (y down): a plate
   *  laid along a slanting line (a standing storyline's). */
  spin?: number
  /** Only its depth-only top: no walls, no bottom, no sheen, so it casts
   *  nothing and shows nothing of its own, seen from either side. It hides
   *  what is behind it and is hidden by what is in front (a standing
   *  storyline's lines and dots, which the page draws). */
  ghost?: boolean
}

/** Console finishes (Brian 2026-11-01: "like a million dollars"): roughness,
 *  metalness, glow (emissive, × its colour), how much of the studio
 *  around it it reflects, and how much of the even lift every wall gets
 *  (sideMat's emissive), for a slab's walls. A card's painted edge
 *  reflects none of it and keeps all the lift: it looks as it always has.
 *  The console's furniture keeps little of it, so its shape comes from
 *  the light: lit tops, darker walls, the rim light along its back. */
export const FINISH = {
  paint: [0.6, 0, 0, 0, 1],
  body: [0.48, 0.25, 0, 0.4, 0.2],
  rim: [0.36, 0.3, 0, 0.55, 0.2],
  alu: [0.24, 0.95, 0, 1, 0.2],
  dark: [0.55, 0.1, 0, 0.35, 0.2],
  gloss: [0.12, 0.05, 0, 0.9, 0.2],
  rubber: [0.92, 0, 0, 0.15, 0.2],
  glow: [0.4, 0, 1.6, 0, 0],
} as const
export type TiltFinish = keyof typeof FINISH
/** A seam's metal (TiltSlab.seam). */
const SEAM_RGB = 0xc4cad4

/** Artwork on the plane — a picture, video or Viewer screen — as a rect
 *  (centre u, v and size w, h in flat px, z its height). The light's
 *  shadows and sheen never fall on these: artwork shows exactly as it is
 *  (Brian 2026-10-30). */
/** A picture's rect, flat px from the centre, at height `z`; on a standing
 *  card (or Viewer), turned with it on its hinge. */
export interface TiltArt { u: number; v: number; w: number; h: number; z: number; hinge?: { v: number; z: number; a: number } }

export interface TiltFrameState {
  tilt: number
  /** The sideways swing, degrees (tiltStore). */
  yaw: number
  /** A wheel zoom easing in (tiltStore TiltGlide): the plane scaled about
   *  a point, as the CSS stage is. */
  glide?: { k: number; x: number; y: number } | null
  /** The camera's sideways move (screen px), tiltStore's shiftX/Y. */
  shiftX: number
  shiftY: number
  spin: number
  texture: boolean
  shade: ModelShade
  wire: boolean
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
  /** How a card's model stands turned, kept (useModelScaleStore poseOf). */
  poseFor?: (key: string) => [number, number, number, number] | undefined
  /** Stands on a 3D area (a scene layout): it keeps the turn it is
   *  given and never turns on the turntable. */
  placed?: (key: string) => boolean
  /** A model's own colour (useModelScaleStore tintOf), '#rrggbb'. */
  tintFor?: (key: string) => string | undefined
  /** A model stretched along its own axes, [x, y, z]. */
  stretchFor?: (key: string) => [number, number, number] | undefined
  /** The manipulator's settings (store/manipStore). */
  manip?: ManipSettings
  /** Cards, decks, tiles and Viewers, for their thickness. */
  slabs: TiltSlab[]
  art: TiltArt[]
  /** How far in the 3D look has come (0 → 1 as the canvas tips back, and
   *  1 → 0 as it lies flat again), eased: the sheen and models follow it.
   *  The raised parts come already scaled by it. */
  fade: number
  /** The 3D notes on a model file (store/notesStore): strokes and pins. */
  notesOf?: (url: string) => ModelNotes | undefined
  /** Locked into 3D (tiltStore lock3d): models stay standing however far
   *  the camera looks down. */
  lock?: boolean
  /** A camera's lens (tiltStore lensOf), by model key. */
  lensFor?: (key: string) => CameraLens | undefined
  /** Looking through this camera (store/manipStore through, Brian
   *  2026-11-09): the full 3D world seen from it, nothing of the canvas. */
  through?: string | null
}

/** How long a model turned by hand takes to roll back (ms). */
const DRIFT_MS = 3000
/** Let go mid-turn, it carries on turning the way it went, slowing with
 *  this time constant (s), while it rolls home (Brian 2026-11-04). */
const COAST_S = 0.45
/** The fastest it carries on at (rad/s), so a hard flick stays sane. */
const COAST_MAX = 12
const coastAxis = new THREE.Vector3(), coastQ = new THREE.Quaternion(), rockQ = new THREE.Quaternion()
/** Its rock into place: radians per (radian per second) it was turning
 *  at when let go, and at most ROCK_MAX — kept subtle. */
const ROCK_PER_SPEED = 0.02
const ROCK_MAX = 3 * Math.PI / 180

/** A person, in metres, for scale. */
export const PERSON_H = 1.75

/** What a model measures, per url — a skinned model's posed bounds walk
 *  every vertex, which is far too slow to redo each time a card comes
 *  back into view. */
const measured = new Map<string, { size: THREE.Vector3; centre: THREE.Vector3; minY: number; triangles: number }>()
/** A model file's triangles, once it has been loaded (the triangle budget). */
export const trianglesOf = (url: string): number | undefined => measured.get(url)?.triangles

interface Standing {
  url: string
  stand: THREE.Group       // on the plane; local +Y is the plane's normal
  turn: THREE.Group        // turntable about that normal
  /** The user's own turn of the model (Alt-drag on it), about its middle. */
  orient: THREE.Group
  /** How it stands turned, kept (a 3D area's layout), under that. */
  pose: THREE.Group
  /** Its handles on a 3D area, selected: a ring to turn it, a knob to
   *  size it (made when first shown). */
  /** Its manipulator (a selected model in a 3D area's scene). */
  gizmo: Manip | null
  /** A camera's view lines and focal point (made when first shown). */
  rig: CamRig | null
  /** The colour it is shown in now, and its materials' own colours. */
  tint: string | null
  baseColors: Map<THREE.Material, THREE.Color> | null
  /** Let go after a turn: it drifts back about `axis` from `angle` to
   *  none over DRIFT_MS, rocking past by up to `rock` (radians). */
  back: {
    axis: THREE.Vector3; angle: number; rock: number; at: number
    /** How it stood when let go, and the turn it was carrying on with
     *  (about `coast`, in rad/s; zero when it was held still). */
    from: THREE.Quaternion; coast: THREE.Vector3
  } | null
  /** The last moments of a turn (when, about what, radians): its speed. */
  spun: { t: number; axis: THREE.Vector3; a: number }[]
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
  /** Its own materials and normals, once loaded. */
  look: LookInstance | null
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
const WIRE_OVER_MAT = new THREE.MeshBasicMaterial({ color: 0x9fd0ff, wireframe: true, transparent: true, opacity: 0.2, depthFunc: THREE.LessEqualDepth, depthWrite: false })
/** Texture off: plain grey, smooth or faceted. */
const GRAY_MAT = new THREE.MeshStandardMaterial({ color: 0xc8ccd8, roughness: 0.85, metalness: 0 })
const GRAY_FLAT_MAT = new THREE.MeshStandardMaterial({ color: 0xc8ccd8, roughness: 0.85, metalness: 0, flatShading: true })
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


/** Pictures masked from the shadow and sheen at most (the ones in view). */
export const ART_MAX = 1000

// ── The manipulator (Brian 2026-11-09: a handle on the model, like
// Maya's). One set of handles at a time (W move, E rotate, R scale,
// store/manipStore), on the world's axes or the model's own: x across the
// canvas (red), y up (green), z down the canvas (blue). Move: arrows, and a
// yellow square in the middle that moves on the camera's plane, or on the
// plane across an axis Ctrl-clicked. Rotate: a ring per axis and a dashed
// yellow outer ring that turns it on the camera's plane. Scale: a box per
// axis (stretch along it) and one in the middle (size). A constant size
// on screen, drawn over everything.

export type ManipPart = 'mx' | 'my' | 'mz' | 'mc' | 'rx' | 'ry' | 'rz' | 'rc' | 'sx' | 'sy' | 'sz' | 's' | 'f'
export type ManipV3 = [number, number, number]
export interface ManipSettings { mode: 'move' | 'rotate' | 'scale'; local: boolean; plane: 'cam' | 'x' | 'y' | 'z' }
/** What a press on the manipulator holds: its part, the model's middle on
 *  screen (px), and per part, in scene axes (x across the canvas, y up,
 *  z down the canvas):
 *   - move: the directions it moves along, each with its screen px per
 *     ground px (`axes`);
 *   - rotate: the axis it turns about, and which way it turns for a
 *     clockwise drag on screen (`axis`, `sign`);
 *   - scale: which of the model's own axes it stretches (`k`) and that
 *     axis's direction on screen, unit length (`dir`). */
export interface ManipHit {
  key: string; part: ManipPart; c: { x: number; y: number }
  axes?: { v: ManipV3; dir: { x: number; y: number } }[]
  axis?: ManipV3; sign?: number
  k?: 0 | 1 | 2; dir?: { x: number; y: number }
}
interface Manip {
  group: THREE.Group; meshes: Map<ManipPart, THREE.Mesh[]>; hot: ManipPart | null; square: THREE.Mesh; outer: THREE.Group
  /** Its axes in scene axes: the model's turn (own axes) or none (world). */
  lq: THREE.Quaternion
  mode: ManipSettings['mode'] | null; plane: ManipSettings['plane']
}
const DEF_MANIP: ManipSettings = { mode: 'move', local: false, plane: 'cam' }
const ONE3: [number, number, number] = [1, 1, 1]
/** The middle square's turn for each plane across an axis (made in xy). */
const SQUARE_Q = {
  x: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
  y: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
  z: new THREE.Quaternion(),
} as const

const MANIP_PX = 78
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) } as const
const manipMat = (color: number, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })
const MANIP_MATS = { x: manipMat(0xff4d5e), y: manipMat(0x6fe36f), z: manipMat(0x4f9dff), c: manipMat(0xffe14a, 0.55), s: manipMat(0xe8ecf4), hot: manipMat(0xffe14a), outer: manipMat(0xffe14a, 0.85) }
const M_SHAFT = new THREE.CylinderGeometry(0.014, 0.014, 0.7, 8).translate(0, 0.5, 0)
const M_HEAD = new THREE.ConeGeometry(0.055, 0.17, 16).translate(0, 0.93, 0)
const M_SLINE = new THREE.CylinderGeometry(0.012, 0.012, 0.72, 8).translate(0, 0.51, 0)
const M_SBOX = new THREE.BoxGeometry(0.1, 0.1, 0.1).translate(0, 0.92, 0)
const M_RING = new THREE.TorusGeometry(0.62, 0.011, 6, 96)
const M_BOX = new THREE.BoxGeometry(0.13, 0.13, 0.13)
const M_SQUARE = new THREE.PlaneGeometry(0.17, 0.17)
const OUTER_R = 0.84
/** A dashed ring: four arcs. */
const M_ARC = new THREE.TorusGeometry(OUTER_R, 0.01, 6, 24, Math.PI / 3.2)
/** A ring's turn about axis a: two axes across it, b then c, so a
 *  positive turn takes b towards c. */
const RING_BASIS = { x: ['y', 'z'], y: ['z', 'x'], z: ['x', 'y'] } as const
const PARTS_OF: Record<ManipSettings['mode'], ManipPart[]> = {
  move: ['mx', 'my', 'mz', 'mc'], rotate: ['rx', 'ry', 'rz', 'rc'], scale: ['sx', 'sy', 'sz', 's'],
}
/** The stand's turn: its y off the plane. */
const STAND_Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)

// ── A camera's view (Brian 2026-11-09) ──
// A camera primitive in a 3D scene shows where it looks: lines from its
// lens out to its frame at the focal point, a little roof on the frame's
// top edge (which way is up, so a roll reads), and the focal point, a
// yellow ball you drag to aim it. In the camera's own units (it grows
// with the camera), on its turn but not its stretch.
interface CamRig { group: THREE.Group; lines: THREE.LineSegments; focal: THREE.Mesh; sig: string; /** Its lens, in its own space. */ lens: THREE.Vector3 }
const RIG_SEGS = 15
const RIG_LINE = new THREE.LineBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0.9, toneMapped: false })
const RIG_FOCAL = new THREE.MeshBasicMaterial({ color: 0xffe14a, depthTest: false, depthWrite: false, transparent: true, toneMapped: false })
const RIG_BALL = new THREE.SphereGeometry(1, 20, 12)
const RIG_FOCAL_R = 0.06
function makeRig(): CamRig {
  const group = new THREE.Group()
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RIG_SEGS * 2 * 3), 3))
  const lines = new THREE.LineSegments(geo, RIG_LINE)
  lines.frustumCulled = false
  const focal = new THREE.Mesh(RIG_BALL, RIG_FOCAL)
  focal.renderOrder = 999
  focal.scale.setScalar(RIG_FOCAL_R)
  group.add(lines, focal)
  return { group, lines, focal, sig: '', lens: new THREE.Vector3() }
}
/** A lens's frame, half width and half height, `f` ahead. */
const halfFrame = (l: CameraLens, f: number) => { const hw = f * 18 / l.mm; return { hw, hh: hw / l.aspect } }
/** Lay a camera's lines out for lens `l`, its lens at `a` (orient space). */
function layRig(r: CamRig, l: CameraLens, a: THREE.Vector3) {
  const sig = `${l.mm}|${l.aspect}|${l.focus}|${a.x}|${a.y}|${a.z}`
  if (sig === r.sig) return
  r.sig = sig
  r.lens.copy(a)
  const f = l.focus, { hw, hh } = halfFrame(l, f)
  const P = (r.lines.geometry.attributes.position as THREE.BufferAttribute)
  let i = 0
  const seg = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    P.setXYZ(i++, a.x + x0, a.y + y0, a.z + z0); P.setXYZ(i++, a.x + x1, a.y + y1, a.z + z1)
  }
  const c = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
  for (const [x, y] of c) seg(0, 0, 0, x, y, f)
  for (let k = 0; k < 4; k++) seg(c[k][0], c[k][1], f, c[(k + 1) % 4][0], c[(k + 1) % 4][1], f)
  // Its roof: which way is up.
  seg(-hw * 0.35, hh * 1.06, f, 0, hh * 1.45, f); seg(0, hh * 1.45, f, hw * 0.35, hh * 1.06, f); seg(-hw * 0.35, hh * 1.06, f, hw * 0.35, hh * 1.06, f)
  // The line it looks along, and a cross on the focal point.
  seg(0, 0, 0, 0, 0, f)
  const x = Math.min(hw, hh) * 0.25
  seg(-x, 0, f, x, 0, f); seg(0, -x, f, 0, x, f)
  // (spare segments collapse onto the lens)
  while (i < RIG_SEGS * 2) P.setXYZ(i++, a.x, a.y, a.z)
  P.needsUpdate = true
  r.focal.position.set(a.x, a.y, a.z + f)
}

/** A floor grid in the plane (xy), 2n cells a side, one unit each, made of
 *  one segment per cell side (long lines crossing behind the camera were
 *  dropped whole on some GPUs), fading out with distance. */
function makeGrid(n: number): THREE.LineSegments {
  const pos: number[] = [], col: number[] = []
  const c = new THREE.Color()
  const put = (x0: number, y0: number, x1: number, y1: number, major: boolean) => {
    for (const [x, y] of [[x0, y0], [x1, y1]]) {
      const f = Math.max(0, 1 - Math.hypot(x, y) / n)
      c.set(major ? 0x737d9f : 0x3c4359).multiplyScalar(f * f * f)
      pos.push(x, y, 0); col.push(c.r, c.g, c.b)
    }
  }
  for (let i = -n; i <= n; i++) {
    const major = i % 5 === 0
    for (let j = -n; j < n; j++) { put(i, j, i, j + 1, major); put(j, i, j + 1, i, major) }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  const g = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, depthWrite: false }))
  g.frustumCulled = false
  return g
}
const rigLens = new THREE.Vector3()
const ZERO3 = new THREE.Vector3(), UP3 = new THREE.Vector3(0, 1, 0)
/** A camera looks down its +z; three's cameras look down -z. */
const TURN_Y = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)

function makeManip(): Manip {
  const group = new THREE.Group()
  const meshes = new Map<ManipPart, THREE.Mesh[]>()
  const add = (part: ManipPart, m: THREE.Mesh, order: number, parent: THREE.Object3D = group) => {
    m.renderOrder = order
    m.userData.mat = m.material
    parent.add(m)
    meshes.set(part, [...(meshes.get(part) ?? []), m])
    return m
  }
  for (const a of ['x', 'y', 'z'] as const) {
    const turnTo = (m: THREE.Mesh) => { if (a === 'x') m.rotation.z = -Math.PI / 2; else if (a === 'z') m.rotation.x = Math.PI / 2; return m }
    add(`m${a}`, turnTo(new THREE.Mesh(M_SHAFT, MANIP_MATS[a])), 1002)
    add(`m${a}`, turnTo(new THREE.Mesh(M_HEAD, MANIP_MATS[a])), 1002)
    add(`s${a}`, turnTo(new THREE.Mesh(M_SLINE, MANIP_MATS[a])), 1002)
    add(`s${a}`, turnTo(new THREE.Mesh(M_SBOX, MANIP_MATS[a])), 1002)
    const ring = new THREE.Mesh(M_RING, MANIP_MATS[a])   // round z as made
    if (a === 'x') ring.rotation.y = Math.PI / 2
    else if (a === 'y') ring.rotation.x = Math.PI / 2
    add(`r${a}`, ring, 1001)
  }
  const square = add('mc', new THREE.Mesh(M_SQUARE, MANIP_MATS.c), 1003)
  const outer = new THREE.Group()
  group.add(outer)
  for (let i = 0; i < 4; i++) {
    const arc = add('rc', new THREE.Mesh(M_ARC, MANIP_MATS.outer), 1001, outer)
    arc.rotation.z = i * Math.PI / 2 + Math.PI / 4 - Math.PI / 6.4
  }
  add('s', new THREE.Mesh(M_BOX, MANIP_MATS.s), 1004)
  group.visible = false
  return { group, meshes, hot: null, square, outer, lq: new THREE.Quaternion(), mode: null, plane: 'cam' }
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
  const deco = new THREE.Scene()
  // A cool sky over a dark table, so tops read lit and walls fall darker
  // (the mockup machine's light), and a cool rim from behind the view: it
  // runs along the far edges and bevels, so the furniture stands out
  // against the canvas. Only the slabs' sides and furniture take it; the
  // DOM draws the faces and pictures as they are.
  deco.add(new THREE.HemisphereLight(0xdfe6ff, 0x262836, 1.25))
  const rimLight = new THREE.DirectionalLight(0x9db4ff, 0.6)
  rimLight.position.set(0.45, 0.6, -1)
  // And a soft fill from over the viewer's shoulder: a wall the key does
  // not reach (the far side, turned to the camera) still shows its shape
  // and its seams, not a black box.
  const viewFill = new THREE.DirectionalLight(0xdfe6ff, 0.7)
  viewFill.position.set(-0.3, 0.5, 1)
  deco.add(rimLight, viewFill)
  // The console's metal and gloss reflect the same soft studio the models do.
  deco.environment = envRT.texture
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
  // Warm, as a studio key: the cool sky and rim set it off.
  const decoKey = shadowLight(new THREE.DirectionalLight(0xfff1dc, 1.5))
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
  // Looking through a camera: the floor, a grid (one unit a square, scaled
  // to the camera's length).
  const grid = makeGrid(120)
  grid.visible = false
  // ...lost in a haze far off, so the lines don't pile up at the horizon.
  const lookFog = new THREE.Fog(0x1b1e26, 1, 2)
  groundDeco.add(grid)
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
  // The manipulators: their own scene, drawn last, over everything.
  const manipScene = new THREE.Scene()
  const manipRoot = new THREE.Group(); manipRoot.matrixAutoUpdate = false; manipScene.add(manipRoot)
  quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), outlineMat))
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  const standing = new Map<string, Standing>()
  let frameNo = 0
  // The 3D notes on the models (three/notesOverlay).
  const notes = createNotesOverlay()
  const notesHost = (s: Standing): NotesHost => ({ url: s.url, inst: s.inst, visible: s.stand.visible, body: s.turn, size: s.size.length() })

  const spawn = (key: string, url: string): Standing => {
    const stand = new THREE.Group()
    stand.rotation.x = Math.PI / 2   // model +Y → plane normal; its front faces the viewer
    const turn = new THREE.Group()
    stand.add(turn)
    const orient = new THREE.Group()
    turn.add(orient)
    const pose = new THREE.Group()
    orient.add(pose)
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
      url, stand, turn, orient, pose, gizmo: null, rig: null, tint: null, baseColors: null, back: null, spun: [], inst: null, size: new THREE.Vector3(), unit: 1, unitSet: false, triangles: 0,
      figure, wall, wallText: '', look: null, phase: Math.random() * 6.28, dead: false, seen: frameNo, shownAt: 0,
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
      s.look = createLook(inst, c => s.mats.push({ m: c, o: c.opacity, t: c.transparent }))
      // Feet on the card, centred on it; the user's turn (orient) is about
      // the model's middle, half its height up.
      orient.position.set(0, m.size.y / 2, 0)
      inst.position.set(-m.centre.x, -m.minY - m.size.y / 2, -m.centre.z)
      pose.add(inst)
      s.inst = inst
    }).catch(() => { /* unreadable model: the card just stays flat */ })
    standing.set(key, s)
    return s
  }
  const drop = (key: string, s: Standing) => {
    s.dead = true
    s.stand.removeFromParent()
    s.gizmo?.group.removeFromParent()
    s.wall.removeFromParent()
    s.wall.material.map?.dispose()
    s.wall.material.dispose()
    s.wall.geometry.dispose()
    if (s.inst) { disposeInstance(s.inst); releaseModel(s.url) }
    if (s.look) disposeLook(s.look)
    notes.forget(key)
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
  /** Top triangles grown past their face for a selection ring (see
   *  TiltSlab.ring), and that face: the margin is drawn, not pressed. */
  const ringTops: { from: number; to: number; u: number; v: number; hw: number; hh: number; hinge?: { v: number; z: number; a: number } }[] = []
  /** Top and side triangles of slabs pick() sees through (TiltSlab.nopick). */
  const noPick: { mesh: 'top' | 'side'; from: number; to: number }[] = []
  const SLAB_MAX = 400, CORNER_SEG = 4
  const RING = 4 * (CORNER_SEG + 1)
  const SIDE_V = SLAB_MAX * (RING * 14 + 4), SIDE_I = SLAB_MAX * RING * 44
  const sideGeo = new THREE.BufferGeometry()
  const sidePos = new Float32Array(SIDE_V * 3)
  const sideNrm = new Float32Array(SIDE_V * 3)
  const sideCol = new Float32Array(SIDE_V * 3)
  const sideFin = new Float32Array(SIDE_V * 4)
  const sideLift = new Float32Array(SIDE_V)
  const sideIdx = new Uint32Array(SIDE_I)
  sideGeo.setAttribute('position', new THREE.BufferAttribute(sidePos, 3).setUsage(THREE.DynamicDrawUsage))
  sideGeo.setAttribute('normal', new THREE.BufferAttribute(sideNrm, 3).setUsage(THREE.DynamicDrawUsage))
  sideGeo.setAttribute('color', new THREE.BufferAttribute(sideCol, 3).setUsage(THREE.DynamicDrawUsage))
  sideGeo.setAttribute('finish', new THREE.BufferAttribute(sideFin, 4).setUsage(THREE.DynamicDrawUsage))
  sideGeo.setAttribute('lift', new THREE.BufferAttribute(sideLift, 1).setUsage(THREE.DynamicDrawUsage))
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
  const sideMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, emissive: 0x2a2e3c, envMapIntensity: 0.9 })
  // Each vertex says what it is made of (FINISH): one draw for all of it.
  sideMat.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 finish;\nattribute float lift;\nvarying vec4 vFinish;\nvarying float vLift;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFinish = finish;\nvLift = lift;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vFinish;\nvarying float vLift;')
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\niblIrradiance *= vFinish.w;\nradiance *= vFinish.w;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vFinish.x;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vFinish.y;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = totalEmissiveRadiance * vLift * (1.0 - 0.75 * vFinish.y) + vColor.rgb * vFinish.z;')
  }
  const sideMesh = new THREE.Mesh(sideGeo, sideMat)
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
  // The faces' depth again, before the models. The DOM draws a face under
  // this canvas, so a model painted first stays painted whatever is in front
  // of it: it showed through a leaning card. Pushed back a hair, so the
  // shadow catcher lying in the same plane as a flat face still shows on it.
  const topFirst = new THREE.Mesh(topGeo, new THREE.MeshBasicMaterial({
    colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4,
  }))
  topFirst.frustumCulled = false
  const topFirstScene = new THREE.Scene()
  const groundTop = new THREE.Group(); groundTop.matrixAutoUpdate = false
  groundTop.add(topFirst); topFirstScene.add(groundTop)

  // ── Artwork mask: each picture's rect goes into the stencil first, and
  // the shadow catchers and the sheen skip it. ──
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
      if (a.hinge) {
        // As buildSlabs' turn(): the far side rises.
        const h = a.hinge, c = Math.cos(h.a), sn = Math.sin(h.a), hy = -h.v
        for (let p = o; p < o + 12; p += 3) {
          const dy = artPos[p + 1] - hy, dz = artPos[p + 2] - h.z
          artPos[p + 1] = hy + dy * c - dz * sn; artPos[p + 2] = h.z + dy * sn + dz * c
        }
      }
    }
    artGeo.getAttribute('position').needsUpdate = true
    artGeo.setDrawRange(0, n * 6)
  }
  const col = new THREE.Color()

  /** A rounded-rect outline: RING points (x, y in the plane's y-up frame)
   *  with their outward normals. */
  const ox = new Float32Array(RING), oy = new Float32Array(RING), onx = new Float32Array(RING), ony = new Float32Array(RING)
  const ix = new Float32Array(RING), iy = new Float32Array(RING)
  /** The slab being built's turn in the plane (TiltSlab.spin). */
  let spinC = 1, spinS = 0
  function outline(u: number, v: number, hw: number, hh: number, r: number, X: Float32Array, Y: Float32Array, NX?: Float32Array, NY?: Float32Array) {
    r = Math.max(0, Math.min(r, hw, hh))
    const corners = [[hw - r, hh - r, 0], [-(hw - r), hh - r, Math.PI / 2], [-(hw - r), -(hh - r), Math.PI], [hw - r, -(hh - r), Math.PI * 1.5]] as const
    let p = 0
    for (const [cx, cy, a0] of corners) {
      for (let i = 0; i <= CORNER_SEG; i++, p++) {
        const a = a0 + (i / CORNER_SEG) * (Math.PI / 2)
        const nx = Math.cos(a), ny = Math.sin(a)
        const dx = cx + nx * r, dy = cy + ny * r
        X[p] = u + dx * spinC - dy * spinS; Y[p] = -v - (dx * spinS + dy * spinC)
        if (NX && NY) { NX[p] = nx * spinC - ny * spinS; NY[p] = -(nx * spinS + ny * spinC) }
      }
    }
  }

  function buildSlabs(slabs: TiltSlab[]) {
    const n = Math.min(slabs.length, SLAB_MAX)
    let sv = 0, si = 0, tv = 0, ti = 0, li = 0, hv = 0, hi = 0
    slabBox.makeEmpty()
    decoTris.length = 0
    ringTops.length = 0
    noPick.length = 0
    let fin: readonly number[] = FINISH.paint
    const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, shade: number) => {
      const o = sv * 3
      sidePos[o] = x; sidePos[o + 1] = y; sidePos[o + 2] = z
      sideNrm[o] = nx; sideNrm[o + 1] = ny; sideNrm[o + 2] = nz
      sideCol[o] = col.r * shade; sideCol[o + 1] = col.g * shade; sideCol[o + 2] = col.b * shade
      const f = sv * 4
      sideFin[f] = fin[0]; sideFin[f + 1] = fin[1]; sideFin[f + 2] = fin[2]; sideFin[f + 3] = fin[3]
      sideLift[sv] = fin[4]
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
      fin = FINISH[s.finish ?? 'paint']
      spinC = Math.cos(s.spin ?? 0); spinS = Math.sin(s.spin ?? 0)
      outline(s.u, s.v, hw, hh, s.r, ox, oy, onx, ony)
      const rimH = s.rim ? s.rim.h : 0
      // A chamfer round the top edge: no deeper than the slab (or its rim),
      // no wider than a third of its rim or of its shorter side.
      const bev = s.bevel && !s.loft && (s.rim || s.cap || s.deco)
        ? Math.max(0, Math.min(s.bevel, (s.rim ? Math.min(s.rim.w, rimH) : Math.min(hw, hh, s.t)) / 3)) : 0
      // What stands up off the plane casts the slabs' shadows.
      if (z > 0.5 || rimH > 0) {
        slabBox.expandByPoint(fitC.set(s.u - hw, -s.v - hh, 0))
        slabBox.expandByPoint(fitC.set(s.u + hw, -s.v + hh, z + rimH))
      }
      // Outer wall: from the rim's top (or the face) down to the bottom.
      const up = sv; for (let i = 0; i < RING; i++) vert(ox[i], oy[i], z + rimH - bev, onx[i], ony[i], 0, 1)
      const dn = sv; for (let i = 0; i < RING; i++) vert(ox[i], oy[i], z - s.t, onx[i], ony[i], 0, 0.7)
      band(up, dn, false)
      // The parting line: a band just proud of the wall, bright metal.
      if (s.seam && s.seam < s.t) {
        const sw = Math.max(0.6, Math.min(2.5, s.t * 0.07)), keep = fin, kc = col.getHex()
        fin = FINISH.alu; col.setHex(SEAM_RGB)
        outline(s.u, s.v, hw + 0.35, hh + 0.35, s.r + 0.35, ix, iy)
        const s0 = sv; for (let i = 0; i < RING; i++) vert(ix[i], iy[i], z - s.seam + sw / 2, onx[i], ony[i], 0, 1)
        const s1 = sv; for (let i = 0; i < RING; i++) vert(ix[i], iy[i], z - s.seam - sw / 2, onx[i], ony[i], 0, 0.8)
        band(s0, s1, false)
        fin = keep; col.setHex(kc)
      }
      // The chamfer: from the wall's top edge in and up to the top, its
      // normals half out, half up, so it catches the light as a bright line.
      let topRing = up
      if (bev) {
        outline(s.u, s.v, hw - bev, hh - bev, s.r - bev, ix, iy)
        const c1 = sv; for (let i = 0; i < RING; i++) vert(ix[i], iy[i], z + rimH, onx[i] * 0.7, ony[i] * 0.7, 0.7, 1.25)
        const c0 = sv; for (let i = 0; i < RING; i++) vert(ox[i], oy[i], z + rimH - bev, onx[i] * 0.7, ony[i] * 0.7, 0.7, 1.25)
        band(c1, c0, false)
        topRing = c1
      }
      if (s.rim) {
        const rw = s.rim.w
        // The rim's top, then its inner wall down to the floor (the face),
        // its inner edge chamfered as its outer.
        const o0 = sv
        if (bev) { outline(s.u, s.v, hw - bev, hh - bev, s.r - bev, ix, iy); for (let i = 0; i < RING; i++) vert(ix[i], iy[i], z + rimH, 0, 0, 1, 1.1) }
        else for (let i = 0; i < RING; i++) vert(ox[i], oy[i], z + rimH, 0, 0, 1, 1.1)
        outline(s.u, s.v, hw - rw + bev, hh - rw + bev, s.r - rw + bev, ix, iy)
        const i0 = sv; for (let i = 0; i < RING; i++) vert(ix[i], iy[i], z + rimH, 0, 0, 1, 1.1)
        band(o0, i0, true)
        if (bev) {
          const e0 = sv; for (let i = 0; i < RING; i++) vert(ix[i], iy[i], z + rimH, -onx[i] * 0.7, -ony[i] * 0.7, 0.7, 1.2)
          outline(s.u, s.v, hw - rw, hh - rw, s.r - rw, ix, iy)
          const e1 = sv; for (let i = 0; i < RING; i++) vert(ix[i], iy[i], z + rimH - bev, -onx[i] * 0.7, -ony[i] * 0.7, 0.7, 1.2)
          band(e0, e1, true)
        } else {
          outline(s.u, s.v, hw - rw, hh - rw, s.r - rw, ix, iy)
        }
        const wt = sv; for (let i = 0; i < RING; i++) vert(ix[i], iy[i], z + rimH - bev, -onx[i], -ony[i], 0, 0.9)
        const w1 = sv; for (let i = 0; i < RING; i++) vert(ix[i], iy[i], z, -onx[i], -ony[i], 0, 0.6)
        band(wt, w1, true)
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
        const b1 = sv
        if (bev && !s.rim) { for (let i = 0; i < RING; i++) { const o = (topRing + i) * 3; vert(sidePos[o], sidePos[o + 1], z, 0, 0, 1, 1) } }
        else for (let i = 0; i < RING; i++) vert(ox[i], oy[i], z, 0, 0, 1, 1)
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
      if (s.ghost) { sv = sv0; si = si0 }
      // Depth-only top at the face.
      const top0 = tv / 3
      const g = s.ring ?? 0
      if (g) outline(s.u, s.v, hw + g, hh + g, s.r + g, ix, iy)
      const tx = g ? ix : ox, ty = g ? iy : oy
      topPos[tv++] = s.u; topPos[tv++] = -s.v; topPos[tv++] = z
      for (let i = 0; i < RING; i++) { topPos[tv++] = tx[i]; topPos[tv++] = ty[i]; topPos[tv++] = z }
      if (g) ringTops.push({ from: ti / 3, to: ti / 3 + RING, u: s.u, v: s.v, hw, hh, hinge: s.hinge })
      if (s.nopick) noPick.push({ mesh: 'top', from: ti / 3, to: ti / 3 + RING }, { mesh: 'side', from: si0 / 3, to: si / 3 })
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
      if (s.ghost || s.bare || (s.pop && Math.max(s.w, s.h) < Math.min(s.w, s.h) * 1.6)) continue
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
    // Only what was written goes up to the GPU (the buffers are sized for
    // SLAB_MAX, most frames use far fewer).
    const upload = (a: THREE.BufferAttribute, n: number) => { a.clearUpdateRanges(); a.addUpdateRange(0, n); a.needsUpdate = true }
    upload(sheenGeo.getAttribute('position') as THREE.BufferAttribute, hv)
    upload(sheenGeo.index!, hi)
    sheenGeo.setDrawRange(0, hi)
    for (const a of ['position', 'normal', 'color']) upload(sideGeo.getAttribute(a) as THREE.BufferAttribute, sv * 3)
    upload(sideGeo.getAttribute('finish') as THREE.BufferAttribute, sv * 4)
    upload(sideGeo.getAttribute('lift') as THREE.BufferAttribute, sv)
    upload(sideGeo.index!, si)
    upload(topGeo.getAttribute('position') as THREE.BufferAttribute, tv)
    upload(topGeo.index!, ti)
    upload(liftGeo.index!, li)
    sideGeo.setDrawRange(0, si)
    topGeo.setDrawRange(0, ti)
    liftGeo.setDrawRange(0, li)
  }

  let lastW = 0, lastH = 0
  const glideM = new THREE.Matrix4()


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
    // (Looking through a camera moves it: back where the canvas's is.)
    camera.position.set(0, 0, TILT_PERSPECTIVE)
    camera.quaternion.identity()
    camera.near = 10; camera.far = TILT_PERSPECTIVE * 20
    camera.updateProjectionMatrix()
    // The plane: CSS rotateX(t) rotateZ(s), carried from CSS's y-down
    // space into three's y-up space (F·R·F, F = flip y).
    R.makeRotationX(st.tilt * Math.PI / 180).multiply(Rz.makeRotationY(st.yaw * Math.PI / 180)).multiply(Rz.makeRotationZ(st.spin * Math.PI / 180))
    // CSS translate(shift) before the rotations is a move in three's view
    // plane too (y flipped).
    ground.matrix.makeTranslation(st.shiftX, -st.shiftY, 0).multiply(F).multiply(R).multiply(F)
    if (st.glide) {
      const { k, x, y } = st.glide
      ground.matrix
        .multiply(glideM.makeTranslation(x, -y, 0))
        .multiply(glideM.makeScale(k, k, k))
        .multiply(glideM.makeTranslation(-x, y, 0))
    }
    ground.matrixWorldNeedsUpdate = true
    groundDeco.matrix.copy(ground.matrix)
    groundDeco.matrixWorldNeedsUpdate = true
    groundArt.matrix.copy(ground.matrix)
    groundArt.matrixWorldNeedsUpdate = true
    groundTop.matrix.copy(ground.matrix)
    groundTop.matrixWorldNeedsUpdate = true

    // Models rise out of their cards as the plane tips back, and only then:
    // swung sideways or tipped up, the card faces stay clear for the layers
    // hanging behind them. The swing lowers them again smoothly.
    const off = Math.max(Math.abs(st.tilt), Math.abs(st.yaw))
    const swingK = Math.min(1, Math.abs(st.yaw) / 35)
    const rise = st.lock ? 1 : Math.min(1, Math.max(0, (st.tilt - 4) / 26)) * (1 - swingK * swingK * (3 - 2 * swingK))
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
      if (s.look) applyLook(s.look, st.texture, st.shade)
      s.stand.visible = !!s.inst && ease > 0
      const placed = !!st.placed?.(tg.key)
      s.turn.rotation.y = st.turn && !placed ? now / 1000 * 0.6 + s.phase : 0
      const pq = st.poseFor?.(tg.key)
      if (pq) s.pose.quaternion.set(pq[0], pq[1], pq[2], pq[3]); else s.pose.quaternion.identity()
      // Its colour (Brian 2026-11-08): over its materials' own.
      const tint = (s.look && st.tintFor?.(tg.key)) || null
      if (s.look && tint !== s.tint) {
        s.tint = tint
        if (!s.baseColors) {
          s.baseColors = new Map()
          for (const m of s.look.all) { const c = (m as THREE.MeshStandardMaterial).color; if (c) s.baseColors.set(m, c.clone()) }
        }
        const t = tint ? new THREE.Color(tint) : null
        for (const [m, c] of s.baseColors) {
          const mc = (m as THREE.MeshStandardMaterial).color
          if (!t) mc.copy(c)
          // A textured model takes the colour over its picture; a plain
          // one (a primitive) shows it as it is.
          else if ((m as THREE.MeshStandardMaterial).map) mc.copy(c).multiply(t)
          else mc.copy(t)
        }
      }
      // Its manipulator: in a 3D area's scene, selected, standing.
      const handles = placed && st.selected.has(tg.key) && !!s.inst && ease > 0.5
      if (handles && !s.gizmo) { s.gizmo = makeManip(); manipRoot.add(s.gizmo.group) }
      // Stretched along its own axes (scale handles), feet kept down.
      const sv = st.stretchFor?.(tg.key) ?? ONE3
      if (s.inst) {
        s.pose.scale.set(sv[0], sv[1], sv[2])
        s.orient.position.y = s.size.y / 2 * sv[1]
      }
      if (s.gizmo) {
        const g = s.gizmo
        g.group.visible = handles
        if (handles) {
          const m = st.manip ?? DEF_MANIP
          // At the model's middle (where it turns about).
          g.group.position.set(s.stand.position.x, s.stand.position.y, s.stand.position.z + s.stand.scale.y * s.size.y / 2 * sv[1])
          // On the model's own axes, or the world's. Scale always stretches
          // along its own.
          if (m.local || m.mode === 'scale') g.lq.copy(s.pose.quaternion); else g.lq.identity()
          g.group.quaternion.copy(STAND_Q).multiply(g.lq)
          if (g.mode !== m.mode) {
            g.mode = m.mode
            const show = PARTS_OF[m.mode]
            for (const [p, list] of g.meshes) for (const x of list) x.visible = show.includes(p)
          }
          g.plane = m.plane
          if (m.plane !== 'cam') g.square.quaternion.copy(SQUARE_Q[m.plane])
        }
      }
      // A camera's view lines and focal point, in its scene.
      const cam = s.url === CAMERA_URL && placed && !!s.inst
      if (cam && !s.rig) { s.rig = makeRig(); s.orient.add(s.rig.group) }
      if (s.rig) {
        s.rig.group.visible = cam && ease > 0
        if (cam) {
          const m = measured.get(s.url)
          if (m) layRig(s.rig, st.lensFor?.(tg.key) ?? CAMERA_LENS, rigLens.set(CAMERA_LENS_AT[0] - m.centre.x, CAMERA_LENS_AT[1] - m.minY - m.size.y / 2, CAMERA_LENS_AT[2] - m.centre.z))
          s.rig.group.quaternion.copy(s.pose.quaternion)
          // Its focal point stays a size you can grab.
          s.rig.focal.scale.setScalar(RIG_FOCAL_R * Math.max(1, Math.min(4, (st.lensFor?.(tg.key) ?? CAMERA_LENS).focus / 4)))
        }
      }
      if (s.back) {
        // Let go after an Alt-drag: it rolls back to how it stood (Brian
        // 2026-11-04), easing in and out, and rocks a little past and back
        // into place as it lands, more the faster it was turning. Let go
        // mid-turn, it first carries on the way it was going, slowing down,
        // while that roll home takes over (the same 3 s).
        const u = Math.min(1, (now - s.back.at) / DRIFT_MS)
        const x = Math.min(1, u / 0.7), e = x * x * (3 - 2 * x)
        const v = (u - 0.6) / 0.4
        const r = v > 0 ? Math.sin(3 * Math.PI * v) * (1 - v) ** 2 : 0
        // (The coast is scaled to end exactly on time, so it lands home.)
        const w = s.back.coast.length()
        const turned = w * COAST_S * (1 - Math.exp(-u * DRIFT_MS / 1000 / COAST_S)) / (1 - Math.exp(-DRIFT_MS / 1000 / COAST_S))
        if (w > 0) coastAxis.copy(s.back.coast).divideScalar(w)
        coastQ.setFromAxisAngle(coastAxis, w > 0 ? turned : 0).multiply(s.back.from)
        rockQ.setFromAxisAngle(s.back.axis, -s.back.angle * e - s.back.rock * r)
        s.orient.quaternion.multiplyQuaternions(rockQ, coastQ)
        if (u >= 1) { s.back = null; s.orient.quaternion.identity() }
      }
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
      const wt = tg.wall ?? tg
      s.wall.position.set(wt.u, -(wt.v - wt.h / 2), (wallH * ease) / 2)
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
      if (s.gizmo) s.gizmo.group.visible = false
      if (frameNo - s.seen > 120) drop(key, s)
    }

    // Looking through a camera: the camera goes where it is, sees what it
    // sees, and nothing of the canvas shows.
    const thru = st.through ? standing.get(st.through) : undefined
    const looking = !!(thru?.rig && thru.inst && !into)
    grid.visible = false
    if (looking) {
      const r = thru!.rig!
      thru!.stand.updateWorldMatrix(true, true)
      r.group.localToWorld(camera.position.copy(r.lens))
      r.group.getWorldQuaternion(camera.quaternion).multiply(TURN_Y)
      const l = st.lensFor?.(st.through!) ?? CAMERA_LENS
      const th = 18 / l.mm, sa = W / H
      camera.fov = 2 * Math.atan(sa >= l.aspect ? th / l.aspect : th / sa) * 180 / Math.PI
      const k = thru!.stand.scale.x * (new THREE.Vector3().setFromMatrixScale(ground.matrixWorld).x || 1)
      camera.near = Math.max(0.05, k * 0.05); camera.far = k * 4000
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld()
      // Its own body is not in its view; the walls and handles are not either.
      thru!.stand.visible = false
      for (const s of standing.values()) { s.wall.visible = false; if (s.gizmo) s.gizmo.group.visible = false }
      // A floor to stand things on: a grid one camera length a square,
      // under the camera.
      const cell = thru!.stand.scale.x
      grid.scale.setScalar(cell)
      grid.position.set(Math.round(thru!.stand.position.x / cell) * cell, Math.round(thru!.stand.position.y / cell) * cell, 0)
      grid.visible = true
      lookFog.near = cell * 4; lookFog.far = cell * 70
    }

    renderer.setRenderTarget(into)
    if (looking) renderer.setClearColor(0x1b1e26, 1)
    // The artwork mask goes in first, on a cleared buffer (stencil too);
    // every pass after draws over it without clearing.
    buildArt(!looking && (off > 0.5 || st.fade > 0) ? st.art : [])
    renderer.autoClear = true
    renderer.render(artScene, camera)
    renderer.setClearColor(0x000000, 0)
    renderer.autoClear = false
    buildSlabs(!looking && (off > 0.5 || st.fade > 0) ? st.slabs : [])
    renderer.render(topFirstScene, camera)
    const surface = st.texture || st.shade !== null
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
      scene.environmentIntensity = L.env
      const shadows = L.shadows ?? DEFAULT_SHADOWS, sheen = L.sheen ?? DEFAULT_SHEEN
      for (const m of [modelShadow, slabShadow]) m.scale.set(span * 2, span * 2, 1)
      for (const m of [modelShadow, slabShadow, liftCatch]) (m.material as THREE.ShadowMaterial).opacity = shadows
      ;(modelShadow.material as THREE.ShadowMaterial).opacity = shadows * st.fade
      // The grey, wire and person looks fade in and out with the models.
      fadeMat(GRAY_MAT, 1, false, st.fade)
      fadeMat(GRAY_FLAT_MAT, 1, false, st.fade)
      fadeMat(WIRE_MAT, 0.85, true, st.fade)
      fadeMat(WIRE_OVER_MAT, 0.2, true, st.fade)
      fadeMat(FIGURE_MAT, 0.85, true, st.fade)
      shadowsOn = shadows > 0.01
      key.castShadow = shadowsOn && modelCast && surface
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
      sheenMesh.visible = sheen > 0.01
    }
    // The catcher must not take the grey or wireframe look: it is drawn on
    // its own after those passes, with the models hidden and the shadow
    // map they made.
    const overridden = !st.texture
    modelShadow.visible = key.castShadow && !overridden
    renderer.shadowMap.needsUpdate = true
    if (surface) {
      scene.overrideMaterial = st.texture ? null : st.shade === 'flat' ? GRAY_FLAT_MAT : GRAY_MAT
      renderer.render(scene, camera)
    }
    if (st.wire) {
      const was = modelShadow.visible
      modelShadow.visible = false
      scene.overrideMaterial = surface ? WIRE_OVER_MAT : WIRE_MAT
      renderer.render(scene, camera)
      modelShadow.visible = was
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
    // The slabs' shadow map, fitted round what stands up off the plane.
    decoKey.castShadow = shadowsOn && fitShadow(decoKey, slabBox)
    liftCatch.visible = decoKey.castShadow
    deco.fog = looking ? lookFog : null
    renderer.render(deco, camera)
    deco.fog = null
    if (into) { renderer.setRenderTarget(null); return }
    {
      const hosts = new Map<string, NotesHost>()
      for (const [key, s] of standing) hosts.set(key, notesHost(s))
      notes.render(renderer, camera, hosts, st.notesOf, st.fade, W, H)
    }

    // Outlines: paint the silhouettes into a mask, then ring them.
    const outlined = looking ? [] : [...standing.entries()].filter(([key, s]) =>
      s.stand.visible && (st.selected.has(key) || key === st.hovered))
    if (outlined.length) {
      const vis = new Map<THREE.Object3D, boolean>()
      for (const s of standing.values()) {
        vis.set(s.stand, s.stand.visible); vis.set(s.figure, s.figure.visible); s.figure.visible = false
        // A camera's view lines are not part of its outline.
        if (s.rig) { vis.set(s.rig.group, s.rig.group.visible); s.rig.group.visible = false }
      }
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
    if (!looking) renderManips()
  }

  /** The manipulators, sized to MANIP_PX on screen, over everything. */
  function renderManips() {
    let any = false
    for (const s of standing.values()) if (s.gizmo?.group.visible) any = true
    if (!any || !lastW) return
    manipRoot.matrix.copy(ground.matrix)
    manipRoot.matrixWorldNeedsUpdate = true
    manipRoot.updateMatrixWorld(true)
    camera.updateMatrixWorld()
    const gk = new THREE.Vector3().setFromMatrixScale(ground.matrix).x || 1
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3()
    for (const s of standing.values()) {
      const g = s.gizmo
      if (!g?.group.visible) continue
      g.group.scale.setScalar(1)
      g.group.updateMatrixWorld(true)
      g.group.getWorldPosition(p0)
      p1.copy(p0).add(right)
      const a = p0.clone().project(camera), b = p1.project(camera)
      const pxPerWorld = Math.hypot((b.x - a.x) / 2 * lastW, (b.y - a.y) / 2 * lastH) || 1
      g.group.scale.setScalar(MANIP_PX / (pxPerWorld * gk))
      g.group.updateMatrixWorld(true)
      // The middle square on the camera's plane, and the outer ring: face
      // the camera.
      const inv = g.group.getWorldQuaternion(new THREE.Quaternion()).invert()
      const face = inv.multiply(camera.quaternion)
      g.outer.quaternion.copy(face)
      if (g.plane === 'cam') g.square.quaternion.copy(face)
      g.group.updateMatrixWorld(true)
    }
    renderer.render(manipScene, camera)
  }

  /** Light up part `part` of model `key`'s manipulator (the cursor is over
   *  it, or it is held), or none. */
  function manipHot(key: string | null, part: ManipPart | null) {
    for (const [k, s] of standing) {
      const g = s.gizmo
      if (!g) continue
      const want = k === key ? part : null
      if (g.hot === want) continue
      g.hot = want
      for (const [p, list] of g.meshes) for (const m of list) m.material = p === want ? MANIP_MATS.hot : m.userData.mat
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
      const hit = raycaster.intersectObject(m, false).find(h => !seenThrough(h, m === topMesh ? 'top' : 'side') && (m !== topMesh || !inRing(h)))
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
    // '' is a slab hit (a solid part with no owner of its own).
    return best ? best.key : null
  }
  /** Turn a model freely, as a trackball: a drag of (dx, dy) screen px
   *  rolls its near side the way the cursor goes, about its middle,
   *  whichever way the camera looks. Whether there was a model to turn. */
  const spinAxis = new THREE.Vector3(), spinQ = new THREE.Quaternion(), parentQ = new THREE.Quaternion()
  function spinBy(key: string, dx: number, dy: number, rad: number): boolean {
    const s = standing.get(key)
    if (!s || !s.inst) return false
    s.back = null
    const t = performance.now()
    s.spun = s.spun.filter(x => t - x.t < 150)
    const len = Math.hypot(dx, dy)
    if (len) {
      // In the camera's space: right is +x, up +y, toward the eye +z.
      // Dragging right turns about +y, dragging down about +x.
      spinAxis.set(dy, dx, 0).normalize().applyQuaternion(camera.quaternion)
      s.turn.updateWorldMatrix(true, false)
      s.turn.getWorldQuaternion(parentQ).invert()
      spinAxis.applyQuaternion(parentQ).normalize()
      spinQ.setFromAxisAngle(spinAxis, len * rad)
      s.orient.quaternion.premultiply(spinQ).normalize()
      s.spun.push({ t, axis: spinAxis.clone(), a: len * rad })
    }
    return true
  }
  /** Let go of a model being turned: it starts drifting back, or with
   *  `settle` off stays just as it is. */
  function letGo(key: string, settle = true) {
    const s = standing.get(key)
    if (!s) return
    if (!settle) { s.spun = []; s.back = null; return }
    const now = performance.now()
    // How fast it was turning as it was let go (rad/s), over the last 120 ms.
    // And which way: the turn it carries on with (rad/s about its axis).
    const coast = new THREE.Vector3()
    for (const x of s.spun) if (now - x.t < 120) coast.addScaledVector(x.axis, x.a / 0.12)
    const speed = coast.length()
    if (speed > COAST_MAX) coast.multiplyScalar(COAST_MAX / speed)
    s.spun = []
    const from = s.orient.quaternion.clone()
    // Where the carrying on would leave it: it rolls home from there (the
    // roll and the coast run together, so it never stops on the way).
    const total = coast.length() * COAST_S
    const q = new THREE.Quaternion().setFromAxisAngle(coast.clone().normalize(), total).multiply(from)
    if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w)
    const angle = 2 * Math.acos(Math.min(1, q.w)), sn = Math.sin(angle / 2)
    if (sn < 1e-6 && speed < 1e-3) { s.orient.quaternion.identity(); return }
    s.back = {
      axis: sn < 1e-6 ? coast.clone().normalize() : new THREE.Vector3(q.x / sn, q.y / sn, q.z / sn), angle, at: now,
      rock: Math.min(ROCK_MAX, speed * ROCK_PER_SPEED, angle * 0.3),
      from, coast,
    }
  }

  /** A hit on a slab pick() sees through. */
  function seenThrough(hit: THREE.Intersection, mesh: 'top' | 'side'): boolean {
    const f = hit.faceIndex
    return f != null && noPick.some(t => t.mesh === mesh && f >= t.from && f < t.to)
  }
  /** A top hit in a selection ring's margin, outside its face. */
  function inRing(hit: THREE.Intersection): boolean {
    const r = hit.faceIndex != null ? ringTops.find(t => hit.faceIndex! >= t.from && hit.faceIndex! < t.to) : undefined
    if (!r) return false
    const p = groundDeco.worldToLocal(hit.point.clone())
    let y = p.y
    if (r.hinge) {
      // Laid back down off its hinge (turn(), undone).
      const c = Math.cos(r.hinge.a), sn = Math.sin(r.hinge.a), y0 = -r.hinge.v
      y = y0 + (p.y - y0) * c + (p.z - r.hinge.z) * sn
    }
    return Math.abs(p.x - r.u) > r.hw || Math.abs(y + r.v) > r.hh
  }

  /** Load and upload what the cards in view need — models, wall labels,
   *  shaders — while still flat, so the first frames of a tilt have
   *  nothing left to do. Draws nothing on screen. */
  const warmRT = new THREE.WebGLRenderTarget(4, 4)
  function warm(W: number, H: number, targets: TiltTarget[], st: TiltFrameState) {
    frame(performance.now(), W, H, targets, { ...st, tilt: 30, shiftX: 0, shiftY: 0 }, warmRT)
  }

  /** Where the cursor at (x, y) (px on the canvas) meets model `key`'s
   *  surface, in the model's own space, and how big the model is there
   *  (its diagonal, model units). */
  function surfaceAt(key: string, x: number, y: number) {
    const s = standing.get(key)
    if (!s || !s.inst || !lastW) return null
    const hit = notes.surfaceAt(camera, lastW, lastH, notesHost(s), x, y)
    return hit && { url: s.url, p: hit.p, n: hit.n, size: s.size.length() }
  }

  /** Where a pin's label dragged to (x, y) (px on the 3D canvas) sits, in
   *  model `key`'s space: at the depth of `through`, facing the eye. */
  function labelAt(key: string, through: [number, number, number], x: number, y: number): [number, number, number] | null {
    const s = standing.get(key)
    if (!s || !s.inst || !lastW) return null
    const p = notes.planeAt(camera, lastW, lastH, notesHost(s), new THREE.Vector3(...through), x, y)
    return p && [p.x, p.y, p.z]
  }
  function strokeAt(x: number, y: number) {
    return lastW ? notes.strokeAt(camera, lastW, lastH, x, y) : null
  }
  /** A model's size (its box's diagonal, its own units). */
  function modelSize(key: string): number | null {
    const s = standing.get(key)
    return s && s.inst ? s.size.length() : null
  }

  /** The manipulator part under (x, y) (px on the 3D canvas), if any,
   *  with what a drag of it needs (ManipHit). */
  function gizmoAt(x: number, y: number): ManipHit | null {
    if (!lastW || !lastH) return null
    manipRoot.updateMatrixWorld(true)
    const v = new THREE.Vector3()
    let best: (ManipHit & { d: number }) | null = null
    for (const [key, s] of standing) {
      const g = s.gizmo
      if (!g?.group.visible) continue
      g.group.updateMatrixWorld(true)
      const px = (lx: number, ly: number, lz: number) => {
        g.group.localToWorld(v.set(lx, ly, lz)).project(camera)
        return { x: (v.x + 1) / 2 * lastW, y: (1 - v.y) / 2 * lastH, z: v.z }
      }
      const c = px(0, 0, 0)
      if (c.z > 1) continue
      // One local unit is this many ground px.
      const unit = g.group.scale.x
      const axisPx = (a: THREE.Vector3) => { const q = px(a.x, a.y, a.z); return { x: (q.x - c.x) / unit, y: (q.y - c.y) / unit } }
      const take = (h: ManipHit, d: number, bias: number) => { if (!best || d - bias < best.d) best = { ...h, d: d - bias } }
      const segD = (a: { x: number; y: number }, b: { x: number; y: number }) => {
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy
        const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0
        return Math.hypot(x - a.x - dx * t, y - a.y - dy * t)
      }
      const lq = g.lq
      const sceneV = (a: THREE.Vector3): ManipV3 => { const w = a.clone().applyQuaternion(lq); return [w.x, w.y, w.z] }
      const toLocal = (wd: THREE.Vector3) => wd.applyQuaternion(g.group.getWorldQuaternion(new THREE.Quaternion()).invert())
      const dc = Math.hypot(x - c.x, y - c.y)
      // A camera's focal point: drag it to aim the camera (any mode).
      if (s.rig?.group.visible) {
        const f = px(0, 0, 0)
        s.rig.focal.getWorldPosition(v).project(camera)
        f.x = (v.x + 1) / 2 * lastW; f.y = (1 - v.y) / 2 * lastH
        const fd = Math.hypot(x - f.x, y - f.y)
        if (v.z < 1 && fd < 11) take({ key, part: 'f', c: { x: f.x, y: f.y } }, fd, 9)
      }
      const along = (A: THREE.Vector3, from: number, to: number) => segD(px(A.x * from, A.y * from, A.z * from), px(A.x * to, A.y * to, A.z * to))
      if (g.mode === 'move') {
        for (const a of ['x', 'y', 'z'] as const) {
          const A = AXES[a]
          const d = along(A, 0.15, 1.02)
          if (d < 8) take({ key, part: `m${a}`, c, axes: [{ v: sceneV(A), dir: axisPx(A) }] }, d, 2)
        }
        // The middle square: on the camera's plane, or across an axis.
        if (dc < 13) {
          const pair = g.plane === 'cam'
            ? [toLocal(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)), toLocal(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1))]
            : RING_BASIS[g.plane].map(n => AXES[n])
          take({ key, part: 'mc', c, axes: pair.map(A => ({ v: sceneV(A), dir: axisPx(A) })) }, dc, 6)
        }
      } else if (g.mode === 'rotate') {
        for (const a of ['x', 'y', 'z'] as const) {
          const [bn, cn] = RING_BASIS[a]
          const B = AXES[bn], C = AXES[cn]
          let prev: { x: number; y: number } | null = null
          let rd = Infinity
          for (let i = 0; i <= 64; i++) {
            const t = i / 64 * Math.PI * 2, cs = Math.cos(t) * 0.62, sn = Math.sin(t) * 0.62
            const q = px(B.x * cs + C.x * sn, B.y * cs + C.y * sn, B.z * cs + C.z * sn)
            if (prev) rd = Math.min(rd, segD(prev, q))
            prev = q
          }
          if (rd < 7) {
            const b = axisPx(B), cc = axisPx(C)
            take({ key, part: `r${a}`, c, axis: sceneV(AXES[a]), sign: b.x * cc.y - b.y * cc.x > 0 ? 1 : -1 }, rd, 0)
          }
        }
        // The outer ring: about the line to the camera. A clockwise drag
        // on screen turns it clockwise as seen.
        const od = Math.abs(dc - OUTER_R * MANIP_PX)
        if (od < 8) take({ key, part: 'rc', c, axis: sceneV(toLocal(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2)).normalize()), sign: -1 }, od, 0)
      } else {
        ;(['x', 'y', 'z'] as const).forEach((a, i) => {
          const A = AXES[a]
          const d = along(A, 0.15, 0.98)
          if (d < 8) {
            const q = axisPx(A), l = Math.hypot(q.x, q.y) || 1
            take({ key, part: `s${a}`, c, k: i as 0 | 1 | 2, dir: { x: q.x / l, y: q.y / l } }, d, 2)
          }
        })
        if (dc < 10) take({ key, part: 's', c }, dc, 6)
      }
    }
    if (!best) return null
    const { d: _d, ...hit } = best as ManipHit & { d: number }
    void _d
    return hit
  }

  /** Aim camera `key` at the point under (x, y) (px on the 3D canvas):
   *  across the floor at its focal point's height, or (`rise`) up and down
   *  on the plane facing the view. How it then stands turned, and how far
   *  ahead its focal point is (camera lengths). */
  function aimAt(key: string, x: number, y: number, rise = false): { q: [number, number, number, number]; focus: number } | null {
    const s = standing.get(key), r = s?.rig
    if (!s || !r || !s.inst || !lastW || !lastH) return null
    s.stand.updateWorldMatrix(true, true)
    camera.updateMatrixWorld()
    const F = r.focal.getWorldPosition(new THREE.Vector3())
    const n = camera.getWorldDirection(new THREE.Vector3())
    if (!rise) {
      // The floor's normal, unless the view is nearly along the floor.
      const up = new THREE.Vector3().setFromMatrixColumn(ground.matrixWorld, 2).normalize()
      if (Math.abs(up.dot(n)) > 0.12) n.copy(up)
    }
    raycaster.setFromCamera(new THREE.Vector2(x / lastW * 2 - 1, 1 - y / lastH * 2), camera)
    const W = raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, F), new THREE.Vector3())
    if (!W || W.distanceTo(camera.position) > camera.far * 0.5) return null
    // In the camera's own space (its middle, its units, before its turn).
    const w = s.orient.worldToLocal(W)
    const q = s.pose.quaternion.clone(), d = new THREE.Vector3(), m = new THREE.Matrix4()
    // Its lens is off its middle: aim from where the lens ends up.
    for (let i = 0; i < 4; i++) {
      d.copy(w).sub(r.lens.clone().applyQuaternion(q))
      if (d.lengthSq() < 1e-8) return null
      q.setFromRotationMatrix(m.lookAt(d, ZERO3, UP3))
    }
    d.copy(w).sub(r.lens.clone().applyQuaternion(q))
    return { q: [q.x, q.y, q.z, q.w], focus: Math.max(0.3, d.length()) }
  }

  /** Where camera `key` is and how it looks, for moving it while looking
   *  through it: its lens and its axes (right, up, ahead), in scene axes
   *  (x across the canvas, y up, z down it) and ground px, and its focal
   *  point there. null when it is not standing. */
  function cameraFrame(key: string): { pivot: THREE.Vector3; lens: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3; ahead: THREE.Vector3; focal: THREE.Vector3; k: number } | null {
    const s = standing.get(key), r = s?.rig
    if (!s || !r || !s.inst) return null
    s.stand.updateWorldMatrix(true, true)
    // The stand's parent space (ground px), turned into scene axes.
    const inv = new THREE.Matrix4().copy(ground.matrixWorld).invert()
    const toScene = (p: THREE.Vector3) => { p.applyMatrix4(inv); return p.set(p.x, p.z, -p.y) }
    const lens = toScene(r.group.localToWorld(r.lens.clone()))
    const focal = toScene(r.group.localToWorld(r.focal.position.clone()))
    const at = (x: number, y: number, z: number) => toScene(r.group.localToWorld(r.lens.clone().add(new THREE.Vector3(x, y, z)))).sub(lens)
    const k = at(0, 0, 1).length()
    const pivot = toScene(s.orient.localToWorld(new THREE.Vector3()))
    return { pivot, lens, focal, right: at(1, 0, 0).divideScalar(k), up: at(0, 1, 0).divideScalar(k), ahead: at(0, 0, 1).divideScalar(k), k }
  }

  /** Keep model `key`'s turn (a 3D area's layout): what the hand turned it
   *  by goes into how it stands. Returns that, or null. */
  function keepTurn(key: string): [number, number, number, number] | null {
    const s = standing.get(key)
    if (!s) return null
    s.spun = []; s.back = null
    const q = s.orient.quaternion.clone().multiply(s.pose.quaternion).normalize()
    s.orient.quaternion.identity()
    s.pose.quaternion.copy(q)
    return [q.x, q.y, q.z, q.w]
  }

  /** Settle turned back on: every model left turned rolls home. */
  function settleAll() {
    for (const [key, s] of standing) {
      const q = s.orient.quaternion
      if (!s.back && Math.abs(q.w) < 0.99999) letGo(key)
    }
  }

  /** Where model `key` is on screen (px from the 3D layer's top-left): the
   *  box round it, and the point it stands on (its middle, on the card). */
  const boxW = new THREE.Box3(), cornerV = new THREE.Vector3()
  function screenBox(key: string): { x0: number; y0: number; x1: number; y1: number; foot: { x: number; y: number } } | null {
    const s = standing.get(key)
    if (!s || !s.inst || !s.stand.visible || !lastW || !lastH) return null
    s.stand.updateWorldMatrix(true, true)
    boxW.setFromObject(s.turn, true)
    if (boxW.isEmpty()) return null
    const toPx = (v: THREE.Vector3) => { v.project(camera); return { x: (v.x + 1) / 2 * lastW, y: (1 - v.y) / 2 * lastH } }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let i = 0; i < 8; i++) {
      cornerV.set(i & 1 ? boxW.max.x : boxW.min.x, i & 2 ? boxW.max.y : boxW.min.y, i & 4 ? boxW.max.z : boxW.min.z)
      const p = toPx(cornerV)
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
    }
    const foot = toPx(s.stand.getWorldPosition(cornerV))
    return { x0, y0, x1, y1, foot }
  }

  /** Model `key`'s middle, where it turns about (and where its
   *  manipulator sits): flat px from the host centre (u, v) and px up off
   *  the plane (z), and how high its foot is (base). */
  function pivotOf(key: string): { u: number; v: number; z: number; base: number } | null {
    const s = standing.get(key)
    if (!s || !s.inst || !s.stand.visible) return null
    return { u: s.stand.position.x, v: -s.stand.position.y, z: s.stand.position.z + s.stand.scale.y * s.orient.position.y, base: s.stand.position.z }
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
    notes.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
  }

  return { frame, warm, pick, pickZ: () => pickedZ, info, spinBy, letGo, settleAll, keepTurn, gizmoAt, aimAt, cameraFrame, manipHot, screenBox, pivotOf, labelAt, strokeAt, modelSize, dispose, surfaceAt, pinSpots: notes.spots }
}
