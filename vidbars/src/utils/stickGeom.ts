// stickGeom.ts — a measuring stick's measures (store/notesStore Stick),
// shared by its flat drawing (components/Notes/StickLayer), its 3D one
// (three/stickOverlay) and its mouse (utils/stickTool). All in feet: a
// length in canvas units is these times the stick's `per`.
//
// Its look (Brian 2026-11-18, from his picture of a bus stop pole): feet
// spread on the ground, a short thick lower tube, a thinner tube out of
// it that goes up and down, ticked like a ruler, and a board on its top
// with its height in orange (in a font of his choosing) over the unit
// it is read in.

import type { Stick } from '../store/notesStore'

/** How tall a new stick is. */
export const STICK_FT = 6
/** The shortest and tallest a stick's top drags to, feet. */
export const STICK_MIN = 1.5
export const STICK_MAX = 200
/** How far across a new stick's 6 ft are on screen (px), at the zoom it
 *  is made at. */
export const STICK_NEW_PX = 240
export const FT_PER_M = 3.280839895

/** The thin tube's radius; the thick lower tube's, and where it stops;
 *  the feet's reach and height. */
export const POLE_R = 0.05
export const LOWER_R = 0.095
export const LOWER_TOP = 0.95
export const BASE_R = 0.4
export const BASE_H = 0.16
/** The board on its top: half its width and height, how far its corners
 *  are cut, and the share of its height (from its top) the number has. */
export const SIGN_W = 0.62
export const SIGN_H = 0.4
export const SIGN_CUT = 0.09
export const SIGN_TEXT = 0.6
/** How tall the numbers by its marks are. */
export const NUM_H = 0.3

export const CREAM = '#ecebc8', GREEN = '#3f6b52', ORANGE = '#f47b20', DARK = '#1c2b24', ACCENT = '#3d7fd9'
export const DEFAULT_FONT = 'system-ui, sans-serif'

/** A stick's length, canvas units. */
export const stickLen = (s: Stick) => s.ft * s.per

/** A stick's height as its board writes it: 6′, 7′ 4″; metric, 1.83. */
export function heightText(s: Pick<Stick, 'ft' | 'metric'>): string {
  if (s.metric) return (s.ft / FT_PER_M).toFixed(2)
  const inches = Math.round(s.ft * 12)
  const f = Math.floor(inches / 12), i = inches % 12
  return i ? `${f}′ ${i}″` : `${f}′`
}
/** The unit under it. */
export const unitText = (s: Pick<Stick, 'metric'>) => s.metric ? 'METRES' : 'FEET'

/** A height dragged to, feet: to the inch, or metric to the centimetre. */
export function snapHeight(ft: number, metric: boolean | undefined): number {
  const v = metric ? Math.round(ft / FT_PER_M * 100) / 100 * FT_PER_M : Math.round(ft * 12) / 12
  return Math.max(STICK_MIN, Math.min(STICK_MAX, v))
}

/** A ring round the tube at height `at` (feet): `k` 0 a fine tick, 1 a
 *  middle one, 2 a numbered one, 3 the mark (6 ft; metric, 2 m). */
export interface Tick { at: number; k: 0 | 1 | 2 | 3; label?: string }

/** The ruler's ticks up the thin tube, from the thick tube's top to
 *  just under the board. Feet: every inch fine, every half foot,
 *  every foot numbered. Metric: every 5 cm,
 *  every 10, every half metre numbered. A very tall stick's are thinned. */
export function stickTicks(s: Pick<Stick, 'ft' | 'metric'>): Tick[] {
  const out: Tick[] = []
  const top = s.ft - 0.06
  const tall = s.ft > 14 ? (s.ft > 60 ? 10 : s.ft > 30 ? 5 : 2) : 1
  if (s.metric) {
    const cmTop = Math.floor(top / FT_PER_M * 100 + 1e-6)
    const fine = tall > 1 ? 10 : 5
    for (let cm = Math.ceil(LOWER_TOP / FT_PER_M * 100 / fine) * fine; cm <= cmTop; cm += fine) {
      const at = cm / 100 * FT_PER_M
      const numbered = cm % (50 * tall) === 0
      if (cm === 200) out.push({ at, k: 3, label: '2' })
      else if (numbered) out.push({ at, k: 2, label: String(cm / 100) })
      else if (cm % (10 * tall) === 0) out.push({ at, k: 1 })
      else if (tall <= 2) out.push({ at, k: 0 })
    }
    return out
  }
  const inTop = Math.floor(top * 12 + 1e-6)
  const fine = tall > 1 ? 6 : 1
  for (let i = Math.ceil(LOWER_TOP * 12 / fine) * fine; i <= inTop; i += fine) {
    const at = i / 12
    const numbered = i % (12 * tall) === 0
    if (i === STICK_FT * 12) out.push({ at, k: 3, label: String(STICK_FT) })
    else if (numbered) out.push({ at, k: 2, label: String(i / 12) })
    else if (i % 6 === 0 && tall <= 2) out.push({ at, k: 1 })
    else if (tall === 1) out.push({ at, k: 0 })
  }
  return out
}
/** How far out a tick's ring stands, and how tall it is, feet. */
export const TICK = [
  { r: POLE_R + 0.009, h: 0.008, color: GREEN },
  { r: POLE_R + 0.026, h: 0.018, color: GREEN },
  { r: POLE_R + 0.045, h: 0.04, color: GREEN },
  { r: POLE_R + 0.06, h: 0.07, color: ORANGE },
] as const

/** A height as someone writes it on a card's back, in feet: 183 cm,
 *  1.83 m, 6'2", 6 ft 2 in, 74 in. A bare number is read by its size:
 *  up to 3 metres, up to 30 feet, up to 100 inches, over that
 *  centimetres. Null: no height there. */
export function parseHeight(text: string | undefined): number | null {
  if (!text) return null
  const t = text.trim().toLowerCase().replace(/,/g, '.')
  const num = '(\\d+(?:\\.\\d+)?)'
  let m = new RegExp(`${num}\\s*(?:'|′|’|ft|feet|foot)\\s*(?:${num}\\s*(?:"|″|”|''|in|inch|inches)?)?`).exec(t)
  if (m) return +m[1] + (m[2] ? +m[2] / 12 : 0)
  m = new RegExp(`${num}\\s*cm`).exec(t)
  if (m) return +m[1] / 100 * FT_PER_M
  m = new RegExp(`${num}\\s*mm`).exec(t)
  if (m) return +m[1] / 1000 * FT_PER_M
  m = new RegExp(`${num}\\s*(?:m|metres?|meters?)\\b`).exec(t)
  if (m) return +m[1] * FT_PER_M
  m = new RegExp(`${num}\\s*(?:"|″|”|in|inch|inches)`).exec(t)
  if (m) return +m[1] / 12
  m = new RegExp(`^${num}$`).exec(t)
  if (!m) return null
  const n = +m[1]
  if (n <= 0) return null
  return n <= 3 ? n * FT_PER_M : n <= 30 ? n : n <= 100 ? n / 12 : n / 100 * FT_PER_M
}
