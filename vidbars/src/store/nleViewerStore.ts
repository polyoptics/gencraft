import { create } from 'zustand'

interface NLEViewerState {
  /** Set of group IDs whose viewers are currently open */
  openGroupIds: Set<string>
  /** Legacy convenience — true if any viewer is open */
  open: boolean
  toggle: (groupId?: string) => void
  close: (groupId?: string) => void
  isOpen: (groupId: string) => boolean
}

export const useNLEViewerStore = create<NLEViewerState>((set, get) => ({
  openGroupIds: new Set(),
  open: false,

  toggle(groupId) {
    set(s => {
      const next = new Set(s.openGroupIds)
      if (!groupId) {
        // Legacy: toggle all — close all if any are open, else this is a no-op
        if (next.size > 0) next.clear()
      } else if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return { openGroupIds: next, open: next.size > 0 }
    })
  },

  close(groupId) {
    set(s => {
      const next = new Set(s.openGroupIds)
      if (groupId) next.delete(groupId)
      else next.clear()
      return { openGroupIds: next, open: next.size > 0 }
    })
  },

  isOpen(groupId) {
    return get().openGroupIds.has(groupId)
  },
}))
