// Ephemeral UI state for deck-linking expansion.
// Tracks which "expansion paths" are currently open.
// A path is a sequence of group IDs from a root host down through nested
// ghost expansions — e.g. ['story-deck', 'pelagia-9', 'cathedral-frond'].
// This lets the user expand the same linked group under two different hosts
// without conflating the two expansion states.
//
// NOT persisted — expansion is a view session, not saved content.

import { create } from 'zustand'

const serialize = (path: string[]) => path.join('>')

interface LinkingStore {
  expandedPaths: Set<string>
  isExpanded: (path: string[]) => boolean
  toggleExpanded: (path: string[]) => void
  setExpanded: (path: string[], open: boolean) => void
  closeAll: () => void
  /** Close any expansion whose path contains the given group id. Call after unlink. */
  closeContaining: (groupId: string) => void

  /** Snapshot of deck-member ids captured when a clone's deck was opened, so
   *  the expansion survives master-deck state changes (e.g. the user toggling
   *  Pelagia-9 between stacked/open on the canvas shouldn't collapse the
   *  clone's already-expanded deck). Keyed by the serialized path. */
  deckSnapshots: Map<string, string[]>
  openDeck: (path: string[], memberIds: string[]) => void
  closeDeck: (path: string[]) => void
  isDeckOpen: (path: string[]) => boolean
  getDeckSnapshot: (path: string[]) => string[] | null
}

export const useLinkingStore = create<LinkingStore>((set, get) => ({
  expandedPaths: new Set<string>(),

  isExpanded: (path) => get().expandedPaths.has(serialize(path)),

  toggleExpanded: (path) => {
    const key = serialize(path)
    set(s => {
      const next = new Set(s.expandedPaths)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { expandedPaths: next }
    })
  },

  setExpanded: (path, open) => {
    const key = serialize(path)
    set(s => {
      const next = new Set(s.expandedPaths)
      if (open) next.add(key)
      else next.delete(key)
      return { expandedPaths: next }
    })
  },

  closeAll: () => set({ expandedPaths: new Set<string>() }),

  closeContaining: (groupId) => {
    set(s => {
      const next = new Set<string>()
      for (const key of s.expandedPaths) {
        if (!key.split('>').includes(groupId)) next.add(key)
      }
      // Also prune any deck snapshots whose path contains this group
      const nextDecks = new Map<string, string[]>()
      for (const [k, v] of s.deckSnapshots) {
        if (!k.split('>').includes(groupId)) nextDecks.set(k, v)
      }
      return { expandedPaths: next, deckSnapshots: nextDecks }
    })
  },

  deckSnapshots: new Map<string, string[]>(),

  openDeck: (path, memberIds) => {
    const key = serialize(path)
    set(s => {
      const next = new Map(s.deckSnapshots)
      next.set(key, [...memberIds])
      return { deckSnapshots: next }
    })
  },

  closeDeck: (path) => {
    const key = serialize(path)
    set(s => {
      if (!s.deckSnapshots.has(key)) return s
      const next = new Map(s.deckSnapshots)
      next.delete(key)
      return { deckSnapshots: next }
    })
  },

  isDeckOpen: (path) => get().deckSnapshots.has(serialize(path)),

  getDeckSnapshot: (path) => get().deckSnapshots.get(serialize(path)) ?? null,
}))
