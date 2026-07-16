import { create } from 'zustand'
import type { Bar } from '../types/bar'
import type { BoardData, ProjectGroup } from './boardsStore'
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
  // Groups
  groups: ProjectGroup[]
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

export const useUserTemplateStore = create<UserTemplateStore>()((set, _get) => ({
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
}))

// Load templates from file on startup (file is the sole source of truth)
fetch('/api/user-templates')
  .then(r => r.json())
  .then((fileTemplates: SavedTemplate[]) => {
    useUserTemplateStore.setState({
      templates: Array.isArray(fileTemplates) ? fileTemplates : [],
      _loaded: true,
    })
  })
  .catch(() => {
    useUserTemplateStore.setState({ _loaded: true })
  })
