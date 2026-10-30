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
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'

/** CSS perspective distance (px) — also the three.js camera distance. */
export const TILT_PERSPECTIVE = 1200
/** Just short of edge-on: the plane can be seen from the side (Brian
 *  2026-10-30), never from below. Exactly 90 has no ground under the cursor. */
export const TILT_MAX = 89
/** Let go below this and the view eases the rest of the way to flat — tilting back up to top-down is the way home. */
export const TILT_SNAP = 10

/** How models are drawn, as three independent choices (Brian 2026-10-30):
 *  their own textures or plain clay; lit, or flat (even light, smooth
 *  normals); and a wireframe off, over the surface, or on its own. */
export type TiltWire = 'off' | 'over' | 'only'

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
}
export const DEFAULT_LIGHT: TiltLight = { azimuth: -40, elevation: 45, power: 3, env: 0.35, spin: false }

interface TiltStore {
  /** Degrees the plane is tipped back; 0 = flat. */
  tilt: number
  /** Degrees the plane is turned about its normal. */
  spin: number
  /** The model's own materials and textures; off = plain clay. */
  texture: boolean
  /** Even, low-contrast light with smooth normals instead of the lit look. */
  flat: boolean
  wire: TiltWire
  light: TiltLight
  /** Models turn slowly on their card. */
  turn: boolean
  /** A back wall on each model card with its file name and size. */
  walls: boolean
  /** A person beside each model, for scale. */
  figure: boolean
  setView: (tilt: number, spin: number) => void
  setTexture: (on: boolean) => void
  setFlat: (on: boolean) => void
  setWire: (w: TiltWire) => void
  setLight: (patch: Partial<TiltLight>) => void
  setTurn: (on: boolean) => void
  setWalls: (on: boolean) => void
  setFigure: (on: boolean) => void
  /** Ease back to the flat view. */
  flatten: () => void
}

let flattenRaf: number | null = null

export const useTiltStore = create<TiltStore>()((set, get) => ({
  tilt: 0,
  spin: 0,
  texture: true,
  flat: false,
  wire: 'off',
  light: DEFAULT_LIGHT,
  turn: true,
  walls: true,
  figure: false,
  setView: (tilt, spin) => {
    if (flattenRaf !== null) { cancelAnimationFrame(flattenRaf); flattenRaf = null }
    set({ tilt: Math.max(0, Math.min(TILT_MAX, tilt)), spin })
  },
  setTexture: texture => set({ texture }),
  setFlat: flat => set({ flat }),
  setWire: wire => set({ wire }),
  setLight: patch => set(s => ({ light: { ...s.light, ...patch } })),
  setTurn: turn => set({ turn }),
  setWalls: walls => set({ walls }),
  setFigure: figure => set({ figure }),
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

/** Keep a tilt stage element's transform in step with the store, straight
 *  on the element: the transform changes every frame of a tilt, and going
 *  through React would re-render the whole canvas each time. */
export function bindTiltStage(el: HTMLElement): () => void {
  let last = ''
  const apply = (s: { tilt: number; spin: number }) => {
    const t = tiltCss(s.tilt, s.spin)
    if (t === last) return
    last = t
    el.style.transform = t
    if (t === 'none') el.removeAttribute('data-tilted')
    else el.setAttribute('data-tilted', '')
  }
  apply(useTiltStore.getState())
  return useTiltStore.subscribe(apply)
}

/** Callback ref for a tilt stage — see bindTiltStage. */
export function useTiltStage() {
  return useCallback((el: HTMLDivElement | null) => (el ? bindTiltStage(el) : undefined), [])
}

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
