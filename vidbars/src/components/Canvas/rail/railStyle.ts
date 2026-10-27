// railStyle — the loop strip's palette and the small event helpers its face
// shares (RailBody, RailRunArrow, RailOverlay).
//
// Flat colours only: the rail is a piece of furniture the cards hang from,
// so it stays darker and quieter than anything docked on it. The one loud
// colour is the run arrow's orange — the user's sketch had it — which also
// marks whatever the run is busy with.

import type React from 'react'
import { useUndoCoordinator } from '../../../store/undoCoordinator'

export const RAIL_COLORS = {
  /** The rail's body. */
  ground: '#16171f',
  /** Its outline. */
  edge: 'rgba(255,255,255,0.09)',
  /** The band the slot headers sit on — the rail proper. */
  track: '#1f212c',
  /** A role column's header chip. */
  head: '#2a2c3b',
  /** The run arrow, and anything the run is working on. */
  orange: '#D85A30',
  orangeHi: '#F07A4A',
  /** The arrow with nothing to run. */
  orangeDim: '#5e3526',
  /** The arrow's track while a run fills it. */
  orangeTrack: '#4a2518',
  /** Where a dragged card would land. */
  drop: '#8FD3FF',
  /** A slot the run passes by (railWarnings). */
  amber: '#F2B84B',
  /** A run or preview that failed. */
  error: '#FFA48F',
} as const

/** A text shadow sized to the rail's unit, so type reads on any card. */
export function railShadow(u: number): string {
  return `0 ${0.5 * u}px ${1.6 * u}px rgba(0,0,0,0.7)`
}

/** `hex` (#rrggbb) mixed into `ground` (#rrggbb) by `t` (0..1), as a flat
 *  rgb() colour — an effect's colour as a dark, readable band. */
export function mixHex(hex: string, ground: string, t: number): string {
  const a = parseInt(hex.slice(1), 16)
  const b = parseInt(ground.slice(1), 16)
  const ch = (shift: number) => Math.round(((a >> shift) & 0xff) * t + ((b >> shift) & 0xff) * (1 - t))
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`
}

/** A control owns a primary press: it must not start a rail move (FreeNode's
 *  onNodeDown captures the pointer, and a click after a capture goes to the
 *  capturing wrapper — so the control's own click and double-click would
 *  never arrive), nor reach the canvas and pan or marquee. Other buttons
 *  fall through: a middle-drag over a control still pans, as everywhere. */
export const stopPrimary = (e: React.PointerEvent | React.MouseEvent) => {
  if (e.button === 0) e.stopPropagation()
}

/** stopPrimary for a button's mousedown, which also keeps the button from
 *  taking keyboard focus: a focused button turns the Space that pans the
 *  canvas (InfiniteCanvas only pans with focus on the body), or an Enter,
 *  into a click on it — a run started, a mode flipped, a column added. */
export const pressButton = (e: React.MouseEvent) => {
  if (e.button === 0) { e.stopPropagation(); e.preventDefault() }
}

/** Keep an event to the control (double-clicks, keys in an input). */
export const stop = (e: React.SyntheticEvent) => { e.stopPropagation() }

export const checkpoint = () => useUndoCoordinator.getState().checkpoint()
