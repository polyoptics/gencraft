// historyStore.ts — one record of what happened, in several kinds.
//
// The History window is NOT part of the Media Pool. It is its own app, so
// that docking it somewhere else shows a different kind of history — the
// same way a Viewer shows a different kind of media depending on what feeds
// it. That only works if the record is central and TYPED: every app writes
// its own kind of entry here, and a History window decides which kinds to
// show from what it is magneted to.
//
//   prompt  — a prompt was sent from a Prompt Pad
//   view    — an item was opened in a Viewer
//   folder  — a Media Pool was pointed at a folder
//   place   — something was placed on the canvas
//
// Entries are replayable: clicking one hands its payload back to whichever
// app is next to the History window (load the prompt, revisit the folder,
// re-open the item). That is why the payload is kept structured rather than
// flattened into a display string.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'

export type HistoryKind = 'prompt' | 'view' | 'folder' | 'place'

export interface HistoryEntry {
  id: string
  kind: HistoryKind
  at: number
  /** One-line display text. */
  label: string
  /** Optional thumbnail (image url / poster). */
  face?: string | null
  /** Kind-specific payload, enough to replay the entry. */
  prompt?: string
  url?: string
  mediaType?: 'image' | 'video' | 'audio' | 'model'
  dir?: string
  /** Which node/window produced it — lets a docked History scope itself. */
  sourceId?: string
}

/** A long tail is the point of a history, but not an unbounded one. */
const CAP = 400

interface HistoryStore {
  entries: HistoryEntry[]          // newest first
  record: (e: Omit<HistoryEntry, 'id' | 'at'>) => void
  remove: (id: string) => void
  clear: (kind?: HistoryKind) => void
}

export const useHistoryStore = create<HistoryStore>()(persist((set) => ({
  entries: [],

  record: (e) => set(s => {
    const entry: HistoryEntry = { ...e, id: crypto.randomUUID(), at: Date.now() }

    // Places and things behave like a recents list: revisiting one moves it
    // to the top instead of stacking another copy, so the list stays a set
    // of where you have been rather than a log of every mount and remount.
    // Prompts are different — sending the same prompt twice is two events,
    // and only an immediate repeat is noise.
    if (e.kind === 'folder' || e.kind === 'view' || e.kind === 'place') {
      const same = (x: HistoryEntry) =>
        x.kind === e.kind && (e.dir ? x.dir === e.dir : x.url === e.url && x.label === e.label)
      return { entries: [entry, ...s.entries.filter(x => !same(x))].slice(0, CAP) }
    }

    const prev = s.entries[0]
    if (prev && prev.kind === e.kind && prev.label === e.label) return s
    return { entries: [entry, ...s.entries].slice(0, CAP) }
  }),

  remove: (id) => set(s => ({ entries: s.entries.filter(x => x.id !== id) })),

  clear: (kind) => set(s => ({
    entries: kind ? s.entries.filter(x => x.kind !== kind) : [],
  })),
}), {
  name: 'vidbars-history',
  version: 1,
  storage: createDebouncedIDBStorage(600),
  // WITHOUT THIS, NOTHING SAVES. Omitting partialize persists the whole
  // store — including `record`, `remove` and `clear`, which are functions.
  // IndexedDB structured-clones its values and throws DataCloneError on a
  // function, so every single write failed, and the storage banner sat on
  // screen shouting about it. Every other store here partialises; this one
  // did not, and that was the entire bug.
  partialize: (s) => ({ entries: s.entries }),
}))

/** Non-hook recorder — call sites are mostly outside React. */
export function recordHistory(e: Omit<HistoryEntry, 'id' | 'at'>): void {
  useHistoryStore.getState().record(e)
}
