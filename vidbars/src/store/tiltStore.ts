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

import { create } from 'zustand'

/** CSS perspective distance (px) — also the three.js camera distance. */
export const TILT_PERSPECTIVE = 1200
export const TILT_MAX = 75
/** Let go below this and the view eases the rest of the way to flat — tilting back up to top-down is the way home. */
export const TILT_SNAP = 10

export type TiltShading = 'textured' | 'shaded' | 'wire'

interface TiltStore {
  /** Degrees the plane is tipped back; 0 = flat. */
  tilt: number
  /** Degrees the plane is turned about its normal. */
  spin: number
  shading: TiltShading
  /** Models turn slowly on their card. */
  turn: boolean
  setView: (tilt: number, spin: number) => void
  setShading: (s: TiltShading) => void
  setTurn: (on: boolean) => void
  /** Ease back to the flat view. */
  flatten: () => void
}

let flattenRaf: number | null = null

export const useTiltStore = create<TiltStore>()((set, get) => ({
  tilt: 0,
  spin: 0,
  shading: 'textured',
  turn: true,
  setView: (tilt, spin) => {
    if (flattenRaf !== null) { cancelAnimationFrame(flattenRaf); flattenRaf = null }
    set({ tilt: Math.max(0, Math.min(TILT_MAX, tilt)), spin })
  },
  setShading: shading => set({ shading }),
  setTurn: turn => set({ turn }),
  flatten: () => {
    if (flattenRaf !== null) cancelAnimationFrame(flattenRaf)
    const { tilt: t0, spin: s0raw } = get()
    // Unwind the spin the short way round.
    const s0 = ((s0raw % 360) + 540) % 360 - 180
    const start = performance.now()
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / 320)
      const k = 1 - Math.pow(1 - t, 3)
      set({ tilt: t0 * (1 - k), spin: s0 * (1 - k) })
      if (t < 1) flattenRaf = requestAnimationFrame(tick)
      else { flattenRaf = null; set({ tilt: 0, spin: 0 }) }
    }
    flattenRaf = requestAnimationFrame(tick)
  },
}))

export const isTilted = (tilt: number) => tilt > 0.01

/** The CSS transform for a tilted layer whose box is the canvas host and
 *  whose transform-origin is its centre. 'none' when flat, so the flat view
 *  is byte-for-byte what it was before tilt existed (no containing block
 *  for fixed children, no stacking context). */
export function tiltCss(tilt: number, spin: number): string {
  if (!isTilted(tilt) && Math.abs(spin) < 0.01) return 'none'
  return `perspective(${TILT_PERSPECTIVE}px) rotateX(${tilt}deg) rotateZ(${spin}deg)`
}

/** Where a point on SCREEN (px from the host centre) lands on the tilted
 *  plane, in FLAT px from the centre — i.e. the flat-view point now drawn
 *  under it. Null above the horizon. */
export function unprojectTilt(sx: number, sy: number, tiltDeg: number, spinDeg: number): { x: number; y: number } | null {
  const P = TILT_PERSPECTIVE
  const t = tiltDeg * Math.PI / 180, s = spinDeg * Math.PI / 180
  const ct = Math.cos(t), st = Math.sin(t)
  // Ray from the eye (0,0,P) through (sx,sy,0) meets the plane n·p = 0,
  // n = Rx(t)·(0,0,1) = (0,-sin t, cos t).
  const denom = sy * st + P * ct
  if (denom <= 1e-3) return null
  const lam = (P * ct) / denom
  const qx = lam * sx, qy = lam * sy, qz = P - lam * P
  // Back into plane coordinates: Rz(-s)·Rx(-t)·q.
  const y1 = qy * ct + qz * st
  const cs = Math.cos(s), ss = Math.sin(s)
  return { x: qx * cs + y1 * ss, y: -qx * ss + y1 * cs }
}
