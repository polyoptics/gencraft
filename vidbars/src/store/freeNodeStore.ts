import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type FreeNodeType = 'note' | 'image'

export interface FreeNodeData {
  id: string
  x: number
  y: number
  width: number
  height: number
  type: FreeNodeType
  label: string
  text: string
  imageUrl: string | null
  color: string
}

const COLORS = ['#1e2235', '#1e3028', '#2e1e35', '#35281e', '#1e2e35', '#2e351e']
let colorIdx = 0

interface FreeNodeStore {
  nodes: Record<string, FreeNodeData>
  selectedIds: string[]
  addFreeNode: (x: number, y: number, type: FreeNodeType) => string
  moveFreeNode: (id: string, dx: number, dy: number) => void
  resizeFreeNode: (id: string, dw: number, dh: number) => void
  updateFreeNode: (id: string, patch: Partial<FreeNodeData>) => void
  deleteFreeNode: (id: string) => void
  setFreeSelection: (ids: string[]) => void
  toggleFreeSelection: (id: string) => void
  clearFreeSelection: () => void
}

export const useFreeNodeStore = create<FreeNodeStore>()(persist((set) => ({
  nodes: {},
  selectedIds: [],

  addFreeNode: (x, y, type) => {
    const id = crypto.randomUUID()
    const color = COLORS[colorIdx++ % COLORS.length]
    const node: FreeNodeData = {
      id, x, y,
      width: 200,
      height: type === 'image' ? 180 : 160,
      type,
      label: type === 'image' ? 'Image' : 'Note',
      text: '',
      imageUrl: null,
      color,
    }
    set(s => ({ nodes: { ...s.nodes, [id]: node } }))
    return id
  },

  moveFreeNode: (id, dx, dy) =>
    set(s => {
      const n = s.nodes[id]
      if (!n) return s
      return { nodes: { ...s.nodes, [id]: { ...n, x: n.x + dx, y: n.y + dy } } }
    }),

  resizeFreeNode: (id, dw, dh) =>
    set(s => {
      const n = s.nodes[id]
      if (!n) return s
      return { nodes: { ...s.nodes, [id]: { ...n, width: Math.max(120, n.width + dw), height: Math.max(80, n.height + dh) } } }
    }),

  updateFreeNode: (id, patch) =>
    set(s => {
      const n = s.nodes[id]
      if (!n) return s
      return { nodes: { ...s.nodes, [id]: { ...n, ...patch } } }
    }),

  deleteFreeNode: (id) =>
    set(s => {
      const { [id]: _, ...rest } = s.nodes
      return { nodes: rest, selectedIds: s.selectedIds.filter(x => x !== id) }
    }),

  setFreeSelection: (ids) => set({ selectedIds: ids }),
  toggleFreeSelection: (id) => set(s => ({
    selectedIds: s.selectedIds.includes(id)
      ? s.selectedIds.filter(x => x !== id)
      : [...s.selectedIds, id],
  })),
  clearFreeSelection: () => set({ selectedIds: [] }),
}), {
  name: 'vidbars-freenodes',
  partialize: (s) => ({ nodes: s.nodes }),  // selectedIds is transient
}))
