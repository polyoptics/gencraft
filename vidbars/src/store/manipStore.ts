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
  set: (p: Partial<Pick<ManipStore, 'mode' | 'local' | 'plane'>>) => void
}

export const useManip = create<ManipStore>()(persist(set => ({
  mode: 'move',
  local: false,
  plane: 'cam',
  set: p => set(p),
}), {
  name: 'vidbars.manip',
  partialize: s => ({ mode: s.mode, local: s.local, plane: s.plane }),
}))
