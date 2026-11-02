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
/** How far tipped back a sideways drag has become pure turntable, degrees. */
const TURNTABLE_AT = 20
/** 0 near flat or tipped up, where a sideways drag swings the view; 1 tipped
 *  back, where it turns the ground about its normal. Between, a blend. */
export function turntableShare(tilt: number): number {
  const k = Math.max(0, Math.min(1, tilt / TURNTABLE_AT))
  return k * k * (3 - 2 * k)
}

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
    // Orbit about what is in the middle of the screen: the ground point
    // there stays there as the view turns or tips.
    const g = centreGround(get())
    tilt = Math.max(-TILT_UP, Math.min(TILT_MAX, tilt))
    // Tipped back any swing eases out: with the ground standing under models,
    // a swing would lean it, which reads as the camera rolling.
    const room = TILT_MAX * (1 - turntableShare(tilt))
    yaw = Math.max(-room, Math.min(room, yaw))
    set({ tilt, spin, yaw, ...(g ? shiftKeeping(g, tilt, spin, yaw) : {}) })
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
    const g = centreGround(get())
    const start = performance.now()
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / 320)
      const k = 1 - Math.pow(1 - t, 3)
      // Flat, the camera's sideways move is a plain slide of the canvas,
      // which TiltLayer then hands to the canvas pan.
      const tilt = t < 1 ? t0 * (1 - k) : 0, spin = t < 1 ? s0 * (1 - k) : 0, yaw = t < 1 ? y0 * (1 - k) : 0
      if (t >= 1) flattenRaf = null
      set({ tilt, spin, yaw, ...(g ? shiftKeeping(g, tilt, spin, yaw) : {}) })
      if (t < 1) flattenRaf = requestAnimationFrame(tick)
    }
    flattenRaf = requestAnimationFrame(tick)
  },
}))

/** How far off the flat view the camera is, by either axis, in degrees. */
export const offFlat = (s: { tilt: number; yaw: number }) => Math.max(Math.abs(s.tilt), Math.abs(s.yaw))
/** Is the camera off the flat view at all? */
export const isTilted = (s: { tilt: number; yaw: number }) => offFlat(s) > 0.01

/** The ground point (flat px from the host centre) drawn at the middle of
 *  the screen, or null when the middle shows sky. */
function centreGround(s: { tilt: number; spin: number; yaw: number; shiftX: number; shiftY: number }) {
  return unprojectTilt(0, 0, s.tilt, s.spin, s.shiftX, s.shiftY, 0, Infinity, s.yaw)
}
/** The camera shift that puts ground point `g` at the middle of the screen
 *  for this tilt and spin — unprojectTilt run backwards: the point sits at
 *  q = Ry(yaw)·Rx(tilt)·Rz(spin)·g, and the middle's ray is the line x = -shiftX,
 *  y = -shiftY. Flat, it is just -g. */
function shiftKeeping(g: { x: number; y: number }, tiltDeg: number, spinDeg: number, yawDeg: number) {
  const t = tiltDeg * Math.PI / 180, s = spinDeg * Math.PI / 180, b = yawDeg * Math.PI / 180
  const x1 = g.x * Math.cos(s) - g.y * Math.sin(s)
  const y1 = g.x * Math.sin(s) + g.y * Math.cos(s)
  return { shiftX: -(x1 * Math.cos(b) + y1 * Math.sin(t) * Math.sin(b)), shiftY: -y1 * Math.cos(t) }
}

/** The CSS transform for a tilted layer whose box is the canvas host and
 *  whose transform-origin is its centre. 'none' when flat, so the flat view
 *  is byte-for-byte what it was before tilt existed (no containing block
 *  for fixed children, no stacking context). */
export function tiltCss(tilt: number, spin: number, shiftX = 0, shiftY = 0, glide: TiltGlide | null = null, yaw = 0): string {
  if (!glide && !isTilted({ tilt, yaw }) && Math.abs(spin) < 0.01 && Math.abs(shiftX) + Math.abs(shiftY) < 0.01) return 'none'
  // The shift comes before the perspective: it moves the camera sideways,
  // so near and far slide alike on screen, as in Maya.
  const base = `perspective(${TILT_PERSPECTIVE}px) translate(${shiftX}px, ${shiftY}px) rotateY(${yaw}deg) rotateX(${tilt}deg) rotateZ(${spin}deg)`
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
  // n = Ry(b)·Rx(t)·(0,0,1) = (cos t sin b, -sin t, cos t cos b).
  const nx = ct * sb, nz = ct * cb
  const denom = -nx * sx + sy * st + P * nz
  if (denom <= 1e-3) return null
  // `height`: a plane that far above the canvas (a lifted tile's face).
  const lam = (-nx * shiftX + shiftY * st + P * nz - height) / denom
  if (lam <= 0 || lam > far) return null
  const qx = -shiftX + lam * sx, qy = -shiftY + lam * sy, qz = P - lam * P
  // Back into plane coordinates: Rz(-s)·Rx(-t)·Ry(-b)·q.
  const x0 = qx * cb - qz * sb, z0 = qx * sb + qz * cb
  const y1 = qy * ct + z0 * st
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
  partialize: s => ({ unitsPerMetre: s.unitsPerMetre, sizeOf: s.sizeOf }),
  storage: createDebouncedIDBStorage(400),
}))
