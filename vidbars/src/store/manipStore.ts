// manipStore.ts — the 3D manipulator's settings (Brian 2026-11-09, as in
// Maya): which handles show (W move, E rotate, R scale), whether they
// follow the model's own axes or the world's, and the plane the middle
// square moves on (the camera's, or the one across an axis Ctrl-clicked).
// Kept in localStorage: a preference, not part of the scene.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ManipMode = 'move' | 'rotate' | 'scale'
/** The middle square's plane: facing the camera, or across axis x/y/z. */
export type ManipPlane = 'cam' | 'x' | 'y' | 'z'

interface ManipStore {
  mode: ManipMode
  local: boolean
  plane: ManipPlane
  /** Models stand up off cards out on the canvas in 3D (the 3D bar's
   *  Models toggle, Brian 2026-11-09). A 3D scene's models always do. */
  models: boolean
  /** Looking through this camera (a model key, Brian 2026-11-09): the
   *  full 3D world from it. Not kept: a reload is back on the canvas. */
  through: string | null
  set: (p: Partial<Pick<ManipStore, 'mode' | 'local' | 'plane' | 'models' | 'through'>>) => void
}

export const useManip = create<ManipStore>()(persist(set => ({
  mode: 'move',
  local: false,
  plane: 'cam',
  models: true,
  through: null,
  set: p => set(p),
}), {
  name: 'vidbars.manip',
  partialize: s => ({ mode: s.mode, local: s.local, plane: s.plane, models: s.models }),
}))
