// tiltStore.ts — the canvas TILT: Alt+drag tips the flat canvas back into
// a ground plane seen in perspective, and model cards stand their model up
// above the card (components/Canvas/TiltLayer).
//
// Tilt is a way of LOOKING, not a place you edit: every hit zone, drag and
// drop on the canvas assumes the flat view, so while tilted the TiltLayer
// owns the pointer (pan, zoom, Alt+drag) and editing waits for flat again.
// Not persisted: a reload always opens flat.
//
// One projection, used by the CSS that tilts the DOM layers AND the three.js
// camera that draws the models over them, so the two line up exactly:
// camera at distance TILT_PERSPECTIVE in front of the host's centre,
// plane rotated rotateX(tilt) rotateZ(spin) about that centre.

import { useCallback } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_LOOK, type ModelShade } from '../three/modelLook'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'
import { markMoving } from '../utils/rasterSettle'

/** CSS perspective distance (px) — also the three.js camera distance. */
export const TILT_PERSPECTIVE = 1200
/** Just short of edge-on: the plane can be seen from the side (Brian
 *  2026-10-30), never from below. Exactly 90 has no ground under the cursor. */
export const TILT_MAX = 89
/** Let go below this and the view eases the rest of the way to flat — tilting back up to top-down is the way home. */
export const TILT_SNAP = 10
/** How far the view can tip upward past flat. */
export const TILT_UP = 45
/** Tipped back this far a sideways drag still only swings, degrees: near
 *  top-down a turn of the ground would just twist the picture on screen. */
const SWING_TO = 20
/** Tipped back this far it has become pure turntable, degrees. */
const TURNTABLE_AT = 32
const smooth01 = (k: number) => { const c = Math.max(0, Math.min(1, k)); return c * c * (3 - 2 * c) }
/** 0 near flat or tipped up, where a sideways drag swings the view; 1 tipped
 *  back, where it turns the ground about its normal. Between, a blend. */
export function turntableShare(tilt: number): number {
  return smooth01((tilt - SWING_TO) / (TURNTABLE_AT - SWING_TO))
}
/** How far the ground can be turned at this tilt: not at all top-down, so
 *  coming back up to top-down always arrives untwisted. */
const spinRoom = (tilt: number) => 180 * smooth01(tilt / SWING_TO)

/** The key light on the models, set in the Light panel. Angles in degrees,
 *  in the plane's frame: azimuth round the card, elevation up from it. */
export interface TiltLight {
  azimuth: number
  elevation: number
  /** Key light strength. */
  power: number
  /** Reflections from the studio environment (what makes highlights). */
  env: number
  /** The light turns with the turntable, so a model keeps its lit side. */
  spin: boolean
  /** The same light across everything raised (Brian 2026-10-30): how
   *  dark the shadows it casts on the canvas are, 0-1, and how strong the
   *  highlight it puts on card and tile faces is, 0-1. */
  shadows: number
  sheen: number
  /** Soft (blurred) shadow edges; off = crisp (Brian 2026-10-30). */
  soft: boolean
}
export const DEFAULT_LIGHT: TiltLight = { azimuth: -40, elevation: 45, power: 3, env: 0.35, spin: false, shadows: 0.45, sheen: 0.5, soft: false }

interface TiltStore {
  /** Degrees the plane is tipped back; 0 = flat, below 0 tipped the other
   *  way, down to -TILT_UP. */
  tilt: number
  /** Degrees the plane is turned about its normal. */
  spin: number
  /** Degrees the view is swung round the screen's vertical: the sideways
   *  look, with no pole at flat. 0 is the tilt as it always was. */
  yaw: number
  /** The camera moved in its own view plane (Maya's pan, Alt+middle), in
   *  screen px: the whole tilted view slides, nothing on it moves. */
  shiftX: number
  shiftY: number
  /** The flat point (px from the host centre) the view turns about, held
   *  where it is on screen: what an Alt-twist peek started over
   *  (utils/peek). Null: the middle of the screen. */
  pivot: { x: number; y: number } | null
  setPivot: (pivot: { x: number; y: number } | null) => void
  /** How models are drawn: see three/modelLook.ts. */
  texture: boolean
  shade: ModelShade
  wire: boolean
  light: TiltLight
  /** Models turn slowly on their card. */
  turn: boolean
  /** A back wall on each model card with its file name and size. */
  walls: boolean
  /** A person beside each model, for scale. */
  figure: boolean
  /** A wheel zoom easing in, not yet the canvas zoom (TiltGlide). */
  glide: TiltGlide | null
  setGlide: (g: TiltGlide | null) => void
  /** Console mode: the loop strip's cards stand up off the tray on their
   *  bottom edges, like a machine's panels; off = they lie in it. Kept
   *  across reloads. */
  console: boolean
  setConsole: (on: boolean) => void
  setView: (tilt: number, spin: number, yaw?: number) => void
  setShift: (x: number, y: number) => void
  setTexture: (on: boolean) => void
  setShade: (shade: ModelShade) => void
  setWire: (on: boolean) => void
  setLight: (patch: Partial<TiltLight>) => void
  setTurn: (on: boolean) => void
  setWalls: (on: boolean) => void
  setFigure: (on: boolean) => void
  /** Ease back to the flat view. */
  flatten: () => void
}

let flattenRaf: number | null = null
const CONSOLE_KEY = 'vidbars.tiltConsole'
function readConsole(): boolean {
  try { return localStorage.getItem(CONSOLE_KEY) === '1' } catch { return false }
}

export const useTiltStore = create<TiltStore>()((set, get) => ({
  tilt: 0,
  spin: 0,
  yaw: 0,
  shiftX: 0,
  shiftY: 0,
  pivot: null,
  setPivot: pivot => set({ pivot }),
  texture: true,
  shade: DEFAULT_LOOK.shade,
  wire: false,
  light: DEFAULT_LIGHT,
  turn: true,
  walls: true,
  figure: false,
  glide: null,
  setGlide: glide => set({ glide }),
  console: readConsole(),
  setConsole: on => { set({ console: on }); try { localStorage.setItem(CONSOLE_KEY, on ? '1' : '0') } catch { /* private window */ } },
  setView: (tilt, spin, yaw = get().yaw) => {
    if (flattenRaf !== null) { cancelAnimationFrame(flattenRaf); flattenRaf = null }
    // Orbit about what is in the middle of the screen (or the pivot): the
    // ground point there stays there as the view turns or tips.
    const keep = keeping(get())
    tilt = Math.max(-TILT_UP, Math.min(TILT_MAX, tilt))
    // Tipped back any swing eases out: with the ground standing under models,
    // a swing would lean it, which reads as the camera rolling.
    const room = TILT_MAX * (1 - turntableShare(tilt))
    yaw = Math.max(-room, Math.min(room, yaw))
    const turn = ((spin % 360) + 540) % 360 - 180, turnRoom = spinRoom(tilt)
    spin = Math.max(-turnRoom, Math.min(turnRoom, turn))
    set({ tilt, spin, yaw, ...(keep ? shiftKeeping(keep.g, tilt, spin, yaw, keep.at) : {}) })
  },
  setShift: (shiftX, shiftY) => set({ shiftX, shiftY }),
  setTexture: texture => set({ texture }),
  setShade: shade => set({ shade }),
  setWire: wire => set({ wire }),
  setLight: patch => set(s => ({ light: { ...s.light, ...patch } })),
  setTurn: turn => set({ turn }),
  setWalls: walls => set({ walls }),
  setFigure: figure => set({ figure }),
  flatten: () => {
    if (flattenRaf !== null) cancelAnimationFrame(flattenRaf)
    const { tilt: t0, spin: s0raw, yaw: y0 } = get()
    // Unwind the spin the short way round.
    const s0 = ((s0raw % 360) + 540) % 360 - 180
    // What is in the middle of the screen stays there all the way down, so
    // the flat view lands exactly where you were looking (Brian 2026-10-30).
    // With a pivot, it stays put instead, so a peek lands back exactly.
    const keep = keeping(get())
    const start = performance.now()
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / 320)
      const k = 1 - Math.pow(1 - t, 3)
      // Flat, the camera's sideways move is a plain slide of the canvas,
      // which TiltLayer then hands to the canvas pan.
      const tilt = t < 1 ? t0 * (1 - k) : 0, spin = t < 1 ? s0 * (1 - k) : 0, yaw = t < 1 ? y0 * (1 - k) : 0
      if (t >= 1) flattenRaf = null
      set({ tilt, spin, yaw, ...(keep ? shiftKeeping(keep.g, tilt, spin, yaw, keep.at) : {}) })
      if (t >= 1) set({ pivot: null })
      if (t < 1) flattenRaf = requestAnimationFrame(tick)
    }
    flattenRaf = requestAnimationFrame(tick)
  },
}))

/** How far off the flat view the camera is, by either axis, in degrees. */
export const offFlat = (s: { tilt: number; yaw: number }) => Math.max(Math.abs(s.tilt), Math.abs(s.yaw))
/** How far tipped back things stand up for, in degrees: models out of their
 *  cards, cards off the console. Only tipped back, and less as the view swings
 *  sideways, so swung round the faces lie flat for the layers behind them. */
export const standTilt = (s: { tilt: number; yaw: number }) => {
  const k = Math.min(1, Math.abs(s.yaw) / 35)
  return Math.max(0, s.tilt) * (1 - k * k * (3 - 2 * k))
}
/** How far what stands up in the tilted view is up, 0..1: rising over the
 *  first degrees of tipping back and lying down again over the last, eased
 *  at both ends — the same as a project cabinet and a console's cards
 *  (TiltLayer, CONSOLE.from to FADE_TILT), so all of them rise together. */
export const standRise = (s: { tilt: number; yaw: number }) => {
  const x = Math.max(0, Math.min(1, (standTilt(s) - 4) / (15 - 4)))
  return x * x * (3 - 2 * x)
}
/** Is the camera off the flat view at all? */
export const isTilted = (s: { tilt: number; yaw: number }) => offFlat(s) > 0.01

/** The ground point (flat px from the host centre) drawn at the middle of
 *  the screen, or null when the middle shows sky. */
function centreGround(s: { tilt: number; spin: number; yaw: number; shiftX: number; shiftY: number }) {
  return unprojectTilt(0, 0, s.tilt, s.spin, s.shiftX, s.shiftY, 0, Infinity, s.yaw)
}
/** Ground point `g` turned into view space: q = Rx(tilt)·Ry(yaw)·Rz(spin)·g. */
function viewPoint(g: { x: number; y: number }, tiltDeg: number, spinDeg: number, yawDeg: number) {
  const t = tiltDeg * Math.PI / 180, s = spinDeg * Math.PI / 180, b = yawDeg * Math.PI / 180
  const x1 = g.x * Math.cos(s) - g.y * Math.sin(s)
  const y1 = g.x * Math.sin(s) + g.y * Math.cos(s)
  return { x: x1 * Math.cos(b), y: y1 * Math.cos(t) + x1 * Math.sin(b) * Math.sin(t), z: y1 * Math.sin(t) - x1 * Math.sin(b) * Math.cos(t) }
}
/** The camera shift that puts ground point `g` at screen point `at` (px from
 *  the middle; default the middle) for this tilt and spin — unprojectTilt
 *  run backwards: the point at q is drawn at (q + shift)·P/(P - q.z). Flat,
 *  it is just at - g. */
function shiftKeeping(g: { x: number; y: number }, tiltDeg: number, spinDeg: number, yawDeg: number, at = { x: 0, y: 0 }) {
  const q = viewPoint(g, tiltDeg, spinDeg, yawDeg)
  const k = (TILT_PERSPECTIVE - q.z) / TILT_PERSPECTIVE
  return { shiftX: at.x * k - q.x, shiftY: at.y * k - q.y }
}
/** Where ground point `g` is drawn now, px from the screen's middle; null
 *  when it is behind the eye. */
function screenOf(g: { x: number; y: number }, s: { tilt: number; spin: number; yaw: number; shiftX: number; shiftY: number }) {
  const q = viewPoint(g, s.tilt, s.spin, s.yaw)
  const k = (TILT_PERSPECTIVE - q.z) / TILT_PERSPECTIVE
  return k > 0.05 ? { x: (q.x + s.shiftX) / k, y: (q.y + s.shiftY) / k } : null
}
/** What a turn of the view keeps still: the pivot where it is drawn, else
 *  the ground point at the middle of the screen. */
function keeping(s: { tilt: number; spin: number; yaw: number; shiftX: number; shiftY: number; pivot: { x: number; y: number } | null }) {
  const at = s.pivot && screenOf(s.pivot, s)
  if (s.pivot && at) return { g: s.pivot, at }
  const g = centreGround(s)
  return g && { g, at: { x: 0, y: 0 } }
}

/** The CSS transform for a tilted layer whose box is the canvas host and
 *  whose transform-origin is its centre. 'none' when flat, so the flat view
 *  is byte-for-byte what it was before tilt existed (no containing block
 *  for fixed children, no stacking context). */
export function tiltCss(tilt: number, spin: number, shiftX = 0, shiftY = 0, glide: TiltGlide | null = null, yaw = 0): string {
  if (!glide && !isTilted({ tilt, yaw }) && Math.abs(spin) < 0.01 && Math.abs(shiftX) + Math.abs(shiftY) < 0.01) return 'none'
  // The shift comes before the perspective: it moves the camera sideways,
  // so near and far slide alike on screen, as in Maya.
  const base = `perspective(${TILT_PERSPECTIVE}px) translate(${shiftX}px, ${shiftY}px) rotateX(${tilt}deg) rotateY(${yaw}deg) rotateZ(${spin}deg)`
  // A wheel zoom in progress: the plane scaled about the zoom point, on the
  // compositor, until the zoom settles into the canvas zoom (see TiltGlide).
  return glide ? `${base} translate(${glide.x}px, ${glide.y}px) scale3d(${glide.k}, ${glide.k}, ${glide.k}) translate(${-glide.x}px, ${-glide.y}px)` : base
}

/** A tilted wheel zoom on its way: the plane drawn `k` times bigger about
 *  (x, y) (flat px from the host centre) without touching the canvas zoom.
 *  Each wheel click used to change the canvas zoom, so every card was
 *  painted again at every click (Brian 2026-10-31). Now the clicks ease the
 *  scale on the already-painted plane, and the canvas zoom takes it in one
 *  go once the wheel rests: one crisp repaint at the end. */
export interface TiltGlide { k: number; x: number; y: number }

/** How far off the plane is still pressed, as a multiple of the eye's
 *  distance to the screen (what is there shows 1/TILT_FAR its size). Just
 *  under the horizon a pixel of mouse is thousands of flat px: a card
 *  dragged up there was flung off out of sight and came back, and let go
 *  there it landed far away (Brian 2026-10-30). Past this it is sky. */
export const TILT_FAR = 16

/** Where a point on SCREEN (px from the host centre) lands on the tilted
 *  plane, in FLAT px from the centre — i.e. the flat-view point now drawn
 *  under it. Null above the horizon, or past `far` (see TILT_FAR). */
export function unprojectTilt(sx: number, sy: number, tiltDeg: number, spinDeg: number, shiftX = 0, shiftY = 0, height = 0, far = Infinity, yawDeg = useTiltStore.getState().yaw): { x: number; y: number } | null {
  const P = TILT_PERSPECTIVE
  const t = tiltDeg * Math.PI / 180, s = spinDeg * Math.PI / 180
  const ct = Math.cos(t), st = Math.sin(t)
  const b = yawDeg * Math.PI / 180, cb = Math.cos(b), sb = Math.sin(b)
  // Undo the shift by moving the eye instead: the ray from (-shift, P)
  // through (screen - shift, 0) meets the plane n·p = 0,
  // n = Rx(t)·Ry(b)·(0,0,1) = (sin b, -sin t cos b, cos t cos b): swung first
  // and tipped after, so the canvas's own up stays upright on the screen.
  const nx = sb, ny = -st * cb, nz = ct * cb
  const denom = -nx * sx - ny * sy + P * nz
  if (denom <= 1e-3) return null
  // `height`: a plane that far above the canvas (a lifted tile's face).
  const lam = (-nx * shiftX - ny * shiftY + P * nz - height) / denom
  if (lam <= 0 || lam > far) return null
  const qx = -shiftX + lam * sx, qy = -shiftY + lam * sy, qz = P - lam * P
  // Back into plane coordinates: Rz(-s)·Ry(-b)·Rx(-t)·q.
  const y1 = qy * ct + qz * st, z1 = -qy * st + qz * ct
  const x0 = qx * cb - z1 * sb
  const cs = Math.cos(s), ss = Math.sin(s)
  return { x: x0 * cs + y1 * ss, y: -x0 * ss + y1 * cs }
}

/** Keep a tilt stage element's transform in step with the store, straight
 *  on the element: the transform changes every frame of a tilt, and going
 *  through React would re-render the whole canvas each time. An `inner`
 *  stage sits inside another and tips with it: it only takes the marks. */
export function bindTiltStage(el: HTMLElement, inner = false): () => void {
  let last = ''
  const apply = (s: { tilt: number; spin: number; yaw: number; shiftX: number; shiftY: number; glide: TiltGlide | null }) => {
    const t = tiltCss(s.tilt, s.spin, s.shiftX, s.shiftY, s.glide, s.yaw)
    if (t === last) return
    last = t
    if (!inner) {
      el.style.transform = t
      markMoving(el)
    }
    if (t === 'none') el.removeAttribute('data-tilted')
    else el.setAttribute('data-tilted', '')
  }
  apply(useTiltStore.getState())
  return useTiltStore.subscribe(apply)
}

/** Callback ref for a tilt stage — see bindTiltStage. */
export function useTiltStage(inner = false) {
  return useCallback((el: HTMLDivElement | null) => (el ? bindTiltStage(el, inner) : undefined), [inner])
}

/** The box the screen-space layer overlay (App's TiltStage: cards, block and
 *  board headers) is drawn into. It is inside the world tilt stage, so
 *  tilted, the cards and the tiles are one 3D space: what stands in front
 *  hides what is behind it, whichever layer either is in. As two stages
 *  side by side, the browser painted the whole overlay over the whole
 *  world, and a leaning effect card showed the cards behind it through
 *  itself (Brian 2026-11-01). */
export const useTiltOverlayHost = create<{ el: HTMLElement | null; set: (el: HTMLElement | null) => void }>(set => ({
  el: null,
  set: el => set({ el }),
}))

/** Model units per metre, set by sizing the person beside a model in the
 *  tilted view. Keyed by the model's url, so every card showing the same
 *  file shares its scale. Absent: guessed (see three/tiltScene). */
interface ModelScaleStore {
  unitsPerMetre: Record<string, number>
  setUnitsPerMetre: (url: string, u: number) => void
  /** How big a model stands on its card in the tilted view, × the fit to
   *  the card. Keyed by the card or tile ('card:<id>' / 'node:<id>'), set
   *  by dragging the model up or down. Absent: 1. */
  sizeOf: Record<string, number>
  setSize: (key: string, k: number) => void
}

export const useModelScaleStore = create<ModelScaleStore>()(persist(set => ({
  unitsPerMetre: {},
  setUnitsPerMetre: (url, u) => set(s => ({ unitsPerMetre: { ...s.unitsPerMetre, [url]: u } })),
  sizeOf: {},
  setSize: (key, k) => set(s => ({ sizeOf: { ...s.sizeOf, [key]: k } })),
}), {
  name: 'vidbars-model-scale',
  partialize: s => ({ unitsPerMetre: s.unitsPerMetre, sizeOf: s.sizeOf}),
  storage: createDebouncedIDBStorage(400),
}))
