// stickGeom.ts — a measuring stick's measures (store/notesStore Stick),
// shared by its flat drawing (components/Notes/StickLayer), its 3D one
// (three/stickOverlay) and its mouse (utils/stickTool). All in feet: a
// length in canvas units is these times the stick's `per`.

import type { Stick } from '../store/notesStore'

/** How tall a new stick is, and the height its mark stays at however far
 *  its top is dragged. */
export const STICK_FT = 6
/** The shortest and tallest a stick's top drags to, feet. */
export const STICK_MIN = 1
export const STICK_MAX = 200
/** How far across a new stick's 6 ft are on screen (px), at the zoom it
 *  is made at. */
export const STICK_NEW_PX = 240

/** The pole's radius, the round sign's, the foot plate's (and how thick
 *  it is), and the collar at the 6 ft mark: its radius and height. */
export const POLE_R = 0.05
export const SIGN_R = 0.46
export const BASE_R = 0.42
export const BASE_H = 0.05
export const MARK_R = 0.13
export const MARK_H = 0.1
/** How tall the numbers by its feet are. */
export const NUM_H = 0.34

export const RED = '#e5484d', WHITE = '#f4f5f7', MARK = '#ffcf3f', DARK = '#161a26', ACCENT = '#3d7fd9'

/** A stick's length, canvas units. */
export const stickLen = (s: Stick) => s.ft * s.per

/** A height in feet as it is written: 6′, 7′ 4″. */
export function feetText(ft: number): string {
  const inches = Math.round(ft * 12)
  const f = Math.floor(inches / 12), i = inches % 12
  return i ? `${f}′ ${i}″` : `${f}′`
}

/** Its bands, foot to top: each a foot long (the last, what is left),
 *  red and white by turns. */
export function stickBands(ft: number): { from: number; to: number; red: boolean }[] {
  const out: { from: number; to: number; red: boolean }[] = []
  for (let i = 0; i < ft - 1e-6; i++) out.push({ from: i, to: Math.min(i + 1, ft), red: i % 2 === 0 })
  return out
}

/** The feet that have a number by them: every one below its top, every
 *  second or fifth on a very tall stick. */
export function stickNumbers(ft: number): number[] {
  const step = ft > 60 ? 10 : ft > 24 ? 5 : ft > 12 ? 2 : 1
  const out: number[] = []
  for (let i = step; i < ft - 0.4; i += step) out.push(i)
  return out
}
