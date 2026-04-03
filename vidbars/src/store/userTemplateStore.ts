import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Bar } from '../types/bar'
import type { BoardData } from './boardsStore'
import type { FreeNodeData } from './freeNodeStore'

export interface SavedTemplate {
  id: string
  name: string
  savedAt: number
  // Primary board
  projectName: string
  bars: Record<string, Bar>
  rootIds: string[]
  // Canvas
  pan: { x: number; y: number }
  boardPos: { x: number; y: number }
  zoom: number
  canvasWidth: number
  nleRowHeight: number
  // Extra boards
  extraBoards: BoardData[]
  boardOrder: string[]
  // Free nodes
  freeNodes: Record<string, FreeNodeData>
}

interface UserTemplateStore {
  templates: SavedTemplate[]
  _loaded: boolean
  saveTemplate: (t: Omit<SavedTemplate, 'id' | 'savedAt'>) => void
  updateTemplate: (id: string, t: Omit<SavedTemplate, 'id' | 'savedAt'>) => void
  removeTemplate: (id: string) => void
}

/** Sync current templates array to the server-side JSON file */
function syncToFile(templates: SavedTemplate[]) {
  fetch('/api/user-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(templates),
  }).catch(() => { /* dev server might not be running */ })
}

export const useUserTemplateStore = create<UserTemplateStore>()(
  persist(
    (set, get) => ({
      templates: [],
      _loaded: false,

      saveTemplate(data) {
        const tmpl: SavedTemplate = { ...data, id: crypto.randomUUID(), savedAt: Date.now() }
        set(s => {
          const next = [...s.templates, tmpl]
          syncToFile(next)
          return { templates: next }
        })
      },

      updateTemplate(id, data) {
        set(s => {
          const next = s.templates.map(t =>
            t.id === id ? { ...data, id, savedAt: Date.now() } : t
          )
          syncToFile(next)
          return { templates: next }
        })
      },

      removeTemplate(id) {
        set(s => {
          const next = s.templates.filter(t => t.id !== id)
          syncToFile(next)
          return { templates: next }
        })
      },
    }),
    {
      name: 'vidbars-user-templates',
      onRehydrate: () => {
        // After localStorage rehydration, also load from file (file wins if localStorage is empty)
        fetch('/api/user-templates')
          .then(r => r.json())
          .then((fileTemplates: SavedTemplate[]) => {
            const store = useUserTemplateStore.getState()
            if (fileTemplates.length > 0 && store.templates.length === 0) {
              // localStorage was cleared but file has data — restore
              useUserTemplateStore.setState({ templates: fileTemplates, _loaded: true })
            } else if (store.templates.length > 0 && fileTemplates.length === 0) {
              // localStorage has data but file doesn't — sync to file
              syncToFile(store.templates)
              useUserTemplateStore.setState({ _loaded: true })
            } else if (fileTemplates.length > 0 && store.templates.length > 0) {
              // Both have data — merge by id, prefer newer savedAt
              const merged = new Map<string, SavedTemplate>()
              for (const t of fileTemplates) merged.set(t.id, t)
              for (const t of store.templates) {
                const existing = merged.get(t.id)
                if (!existing || t.savedAt > existing.savedAt) merged.set(t.id, t)
              }
              const result = Array.from(merged.values()).sort((a, b) => a.savedAt - b.savedAt)
              useUserTemplateStore.setState({ templates: result, _loaded: true })
              syncToFile(result)
            } else {
              useUserTemplateStore.setState({ _loaded: true })
            }
          })
          .catch(() => {
            useUserTemplateStore.setState({ _loaded: true })
          })
      },
    },
  ),
)
