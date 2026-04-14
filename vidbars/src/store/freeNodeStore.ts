import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createDebouncedStorage } from '../utils/debouncedStorage'

export type FreeNodeType = 'note' | 'image' | 'text' | 'video' | 'audio'

export interface TextStyle {
  fontSize: number       // in px (base, before zoom scaling)
  color: string          // text color
  bgColor: string        // background color
  bgOpacity: number      // 0–1
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
  vAlign: 'top' | 'middle' | 'bottom'
  fontFamily?: string    // CSS font-family value
  lineHeight?: number    // multiplier, e.g. 1.0, 1.2, 1.5 — default 1.55
  letterSpacing?: number // px — default 0
  fontWeight?: number    // 100–900 — overrides bold when set
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSize: 18,
  color: '#ffffff',
  bgColor: '#000000',
  bgOpacity: 0,
  bold: false,
  italic: false,
  align: 'left',
  vAlign: 'top',
}

export const DEFAULT_HEADER_STYLE: TextStyle = {
  fontSize: 28,
  color: '#ffffff',
  bgColor: '#000000',
  bgOpacity: 0,
  bold: true,
  italic: false,
  align: 'center',
  vAlign: 'top',
}

export const DEFAULT_BLOCK_HEADER_STYLE: TextStyle = {
  ...DEFAULT_HEADER_STYLE,
  fontSize: 45,
}

export const DEFAULT_BODY_STYLE: TextStyle = {
  ...DEFAULT_TEXT_STYLE,
}

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
  imageTransform?: import('../store/boardsStore').HeroImageTransform
  mediaType?: 'image' | 'video' | 'audio' | null
  color: string
  textStyle?: TextStyle
}

const COLORS = ['#1e2235', '#1e3028', '#2e1e35', '#35281e', '#1e2e35', '#2e351e']
let colorIdx = 0

interface FreeNodeStore {
  nodes: Record<string, FreeNodeData>
  selectedIds: string[]
  addFreeNode: (x: number, y: number, type: FreeNodeType) => string
  moveFreeNode: (id: string, dx: number, dy: number) => void
  moveManyFreeNodes: (ids: string[], dx: number, dy: number) => void
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
    const labels: Record<FreeNodeType, string> = {
      image: 'Image', note: 'Note', text: 'Text', video: 'Video', audio: 'Audio',
    }
    const heights: Record<FreeNodeType, number> = {
      image: 180, note: 160, text: 180, video: 180, audio: 120,
    }
    const node: FreeNodeData = {
      id, x, y,
      width: type === 'audio' ? 260 : 200,
      height: heights[type] ?? 160,
      type,
      label: labels[type] ?? type,
      text: '',
      imageUrl: null,
      mediaType: null,
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

  moveManyFreeNodes: (ids, dx, dy) =>
    set(s => {
      const updated = { ...s.nodes }
      for (const id of ids) {
        const n = updated[id]
        if (n) updated[id] = { ...n, x: n.x + dx, y: n.y + dy }
      }
      return { nodes: updated }
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
  storage: createJSONStorage(() => createDebouncedStorage(500)),
  partialize: (s) => ({ nodes: s.nodes }),  // selectedIds is transient
}))
