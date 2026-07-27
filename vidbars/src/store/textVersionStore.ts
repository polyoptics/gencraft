// textVersionStore.ts — saved snapshots ("documents") of a text source,
// taken from the Viewer's text editor.
//
// Keyed by the same sourceId the browser uses for text items
// ('bar:<boardId>:<barId>' | 'group:<groupId>' | 'tile:<nodeId>'), so a
// card's versions follow the card wherever it's viewed from. Snapshots
// are plain text — small enough to persist inline, no blob store needed.
//
// This is deliberately NOT undo history: undo is for accidents, these
// are drafts you deliberately keep and come back to.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'

export interface TextVersion {
  id: string
  label: string
  headerText: string
  text: string
  savedAt: number
}

interface TextVersionStore {
  /** sourceId → versions, newest first. */
  versions: Record<string, TextVersion[]>
  saveVersion: (sourceId: string, snap: { headerText: string; text: string; label?: string }) => string
  deleteVersion: (sourceId: string, id: string) => void
  renameVersion: (sourceId: string, id: string, label: string) => void
}

/** Default label: first meaningful line, else a word count. */
function autoLabel(headerText: string, text: string): string {
  const firstLine = (headerText || text).split('\n').map(s => s.trim()).find(Boolean) ?? ''
  if (firstLine) return firstLine.slice(0, 42)
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return words > 0 ? `${words} words` : 'Empty draft'
}

export const useTextVersionStore = create<TextVersionStore>()(persist((set) => ({
  versions: {},

  saveVersion: (sourceId, snap) => {
    const id = crypto.randomUUID()
    const version: TextVersion = {
      id,
      label: snap.label?.trim() || autoLabel(snap.headerText, snap.text),
      headerText: snap.headerText,
      text: snap.text,
      savedAt: Date.now(),
    }
    set(s => ({
      versions: { ...s.versions, [sourceId]: [version, ...(s.versions[sourceId] ?? [])] },
    }))
    return id
  },

  deleteVersion: (sourceId, id) =>
    set(s => {
      const list = s.versions[sourceId]
      if (!list) return s
      const next = list.filter(v => v.id !== id)
      const versions = { ...s.versions }
      if (next.length > 0) versions[sourceId] = next
      else delete versions[sourceId]
      return { versions }
    }),

  renameVersion: (sourceId, id, label) =>
    set(s => {
      const list = s.versions[sourceId]
      if (!list) return s
      return {
        versions: {
          ...s.versions,
          [sourceId]: list.map(v => (v.id === id ? { ...v, label: label.trim() || v.label } : v)),
        },
      }
    }),
}), {
  name: 'vidbars-text-versions',
  storage: createDebouncedIDBStorage(400),
  partialize: (s) => ({ versions: s.versions }),
  version: 0,
}))
