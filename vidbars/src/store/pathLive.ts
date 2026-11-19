// pathLive.ts — what of the curves is live under the mouse right now
// (not kept): the curve being drawn, and the point or handle the cursor
// is over in 3D. Read by the flat drawing (components/Notes/CurveLayer)
// and the 3D one (three/pathOverlay, through TiltModels); written by the
// mouse (utils/notesTool).

import { create } from 'zustand'
import type { Curve } from './notesStore'

/** The curve being drawn, and where the cursor is (for the next segment). */
export const useCurveDraft = create<{ curve: Curve | null; hover: { x: number; y: number } | null }>(() => ({ curve: null, hover: null }))

/** A curve's right-click menu (components/Notes/PathMenu): where on
 *  screen, and what it was opened on: a point, or the line at share `t`
 *  of the segment leaving point `seg`. */
export const usePathMenu = create<{ at: { x: number; y: number; id: string; point?: number; seg?: number; t?: number } | null }>(() => ({ at: null }))

/** The part of a curve under the cursor in 3D: `p:${id}:${i}` (a point)
 *  or `h:${id}:${i}:${side}` (a handle). */
export const usePathHot = create<{ hot: string | null }>(() => ({ hot: null }))

/** The measuring sticks (notesStore sticks), live: the one selected, and
 *  the part of one under the cursor, `${id}:top` (its sign, which drags
 *  its height) or `${id}:body`. Written by utils/stickTool. */
export const useStickUi = create<{
  selected: string | null
  hot: string | null
  /** The font list, open for a stick's number, and where on screen. */
  fonts: { id: string; x: number; y: number } | null
  /** Bumped when a font has loaded: the 3D view draws the boards again. */
  fontRev: number
}>(() => ({ selected: null, hot: null, fonts: null, fontRev: 0 }))
