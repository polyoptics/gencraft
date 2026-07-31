// Ephemeral state for the "drag to create a link" interaction.
// Mirrors the NLEBlock color-drag pattern: a pointerdown on a source chip or
// deck-browser tile begins a drag; `LinkDragOverlay` reads this store to
// render a dashed line + floating circle that trails the cursor; on pointerup
// the drop target is detected via elementsFromPoint and the link is created.
//
// Not persisted.

import { create } from 'zustand'
import type { LinkRef } from '../utils/linkTargets'

interface Point { x: number; y: number }

interface LinkDragStore {
  active: boolean
  /** What is being dragged — a card, a block or an element. Was a bare group
   *  id back when cards were the only thing that could be linked. */
  source: LinkRef | null
  sourceColor: string
  startScreenPos: Point | null
  currentPos: Point | null

  begin: (source: LinkRef, color: string, x: number, y: number) => void
  move: (x: number, y: number) => void
  end: () => void
}

export const useLinkDragStore = create<LinkDragStore>((set) => ({
  active: false,
  source: null,
  sourceColor: '#5b8dd9',
  startScreenPos: null,
  currentPos: null,

  begin: (source, color, x, y) => set({
    active: true,
    source,
    sourceColor: color,
    startScreenPos: { x, y },
    currentPos: { x, y },
  }),

  move: (x, y) => set({ currentPos: { x, y } }),

  end: () => set({
    active: false,
    source: null,
    sourceColor: '#5b8dd9',
    startScreenPos: null,
    currentPos: null,
  }),
}))
