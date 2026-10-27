// railUiStore — transient loop-strip UI state shared between the dragged
// tile (FreeNode, which knows where a release would land) and the rail
// (RailBody, which draws where that is). Never persisted.

import { create } from 'zustand'
import type { RailDropTarget } from '../utils/rail'

interface RailUiState {
  /** Where the tile being dragged would dock if released now, or null. */
  drop: { target: RailDropTarget; draggedId: string } | null
  setDrop: (drop: RailUiState['drop']) => void
  /** Strips by when they were last used — clicked, tweaked, stepped — most
   *  recent first. A Viewer shows the first of these docked to it
   *  (utils/railViewer). */
  active: string[]
  touch: (railId: string) => void
}

export const useRailUiStore = create<RailUiState>(set => ({
  drop: null,
  active: [],
  touch: railId => set(s => (s.active[0] === railId ? s : { active: [railId, ...s.active.filter(x => x !== railId)].slice(0, 32) })),
  setDrop: drop => set(s => {
    const a = s.drop, b = drop
    // Same target as last frame: no new state, no re-render.
    if (a === b) return s
    if (a && b && a.draggedId === b.draggedId && JSON.stringify(a.target) === JSON.stringify(b.target)) return s
    return { drop }
  }),
}))
