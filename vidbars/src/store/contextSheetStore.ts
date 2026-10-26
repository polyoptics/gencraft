// contextSheetStore — which cards the context-sheet dialog is open for.
// Transient (not persisted): a menu opens it, the dialog closes it. Lives in
// a store rather than in the menu because the menu closes the moment its
// item is clicked, and the dialog must outlive it (and a zoom change).

import { create } from 'zustand'

interface ContextSheetState {
  /** The cards to put on one sheet, in order; null when closed. */
  groupIds: string[] | null
  openSheet: (groupIds: string[]) => void
  closeSheet: () => void
}

export const useContextSheetStore = create<ContextSheetState>(set => ({
  groupIds: null,
  openSheet: groupIds => set({ groupIds }),
  closeSheet: () => set({ groupIds: null }),
}))
