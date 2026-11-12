// pathLive.ts — what of the curves is live under the mouse right now
// (not kept): the curve being drawn, and the point or handle the cursor
// is over in 3D. Read by the flat drawing (components/Notes/CurveLayer)
// and the 3D one (three/pathOverlay, through TiltModels); written by the
// mouse (utils/notesTool).

import { create } from 'zustand'
import type { Curve } from './notesStore'

/** The curve being drawn, and where the cursor is (for the next segment). */
export const useCurveDraft = create<{ curve: Curve | null; hover: { x: number; y: number } | null }>(() => ({ curve: null, hover: null }))

/** The part of a curve under the cursor in 3D: `p:${id}:${i}` (a point)
 *  or `h:${id}:${i}:${side}` (a handle). */
export const usePathHot = create<{ hot: string | null }>(() => ({ hot: null }))
