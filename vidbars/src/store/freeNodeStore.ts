import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'

// 'list' | 'pool' | 'prompt' | 'history' are COMPONENTS rather than media: a
// node whose body is a whole panel. They ride the same substrate as
// everything else — drag, resize, pin, dock, select, undo, export — which is
// the point of the modular design: a component is just a node that happens
// to be a tool.
export type FreeNodeType =
  | 'note' | 'image' | 'text' | 'video' | 'audio' | 'model'
  | 'list'     // the Rolodex / image scroller
  | 'pool'     // media pool — a folder on disk
  | 'prompt'   // prompt pad + tag palette
  | 'history'  // history lens — shows the kind of history it is docked to

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
  mediaType?: import('../types/bar').MediaType | null
  /** Model tiles: rendered poster thumbnail (`mediaref:`), lazily generated. */
  posterUrl?: string | null
  /** List tiles: the pinned LIVE query (results derive from the stores). */
  listQuery?: import('../utils/contentKinds').ListQuery
  /** Media Pool: the directory it points at. Only the PATH persists — the
   *  listing is re-read on mount, since a folder changes under you. */
  poolDir?: string
  /** Prompt Pad: the tag workshop and saved prompts. Persisted per pad, so
   *  two pads can carry different vocabularies. */
  promptKit?: import('../utils/promptKit').PromptKit
  /** SCREEN-PINNED instances. Present ⇒ this node is rendered by
   *  <PinLayer/> OUTSIDE the world transform and is SKIPPED by
   *  FreeCanvas. Absent ⇒ canvas-placed. That is the whole model.
   *
   *  x/y are CANVAS-CONTAINER pixels — origin = top-left of the
   *  InfiniteCanvas container, the SAME basis `pan` is measured in. NOT
   *  document space: that differs by the toolbar height and shifts again
   *  when the storage banner mounts.
   *
   *  `scale` is the world zoom FROZEN at pin time. width/height stay
   *  CANVAS units and stay LIVE — the pinned box is
   *  layout(width × height) × scale(pin.scale). That is what keeps every
   *  existing size writer working unchanged (the Rolodex expansion
   *  drawer, the aspect-locked corner, resizeFreeNode's canvas-unit
   *  floors) and what makes offsetWidth — and so the panel's own
   *  embedScale — identical across the flip.
   *
   *  While pinned, x/y hold the pre-pin canvas position: stale, but still
   *  a VALID canvas quantity, so a missed guard is cosmetic rather than
   *  corrupting. Unpin recomputes them. */
  pin?: { x: number; y: number; scale: number }
  /** Where this node came FROM, captured when it was pinned. Unpinning
   *  puts it back here rather than dropping it wherever it happened to be
   *  sitting on screen — a pin is a temporary visit to the screen, not a
   *  move. Absent on nodes pinned before this existed, and on nodes that
   *  have never been pinned; both fall back to unprojecting the current
   *  position, which is the old behaviour. The re-home control overwrites
   *  it with the current spot when the visit turns out to be permanent. */
  home?: { x: number; y: number; width: number; height: number }
  color: string
  textStyle?: TextStyle
  /** Annotation layer — vector strokes drawn on this node. */
  strokes?: import('../types/stroke').Stroke[]
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
  /** Flip nodes between screen-pinned and canvas-placed. Takes an ARRAY
   *  so a host and everything docked to it later convert in ONE set —
   *  a half-converted assembly can then never exist, not even across the
   *  400ms debounced IDB write. pan/zoom are PASSED IN so this store
   *  keeps zero imports of canvasStore. */
  setNodePlacement: (ids: string[], to: 'screen' | 'canvas',
                     view: { pan: { x: number; y: number }; zoom: number }) => void
  /** Re-home a PINNED node: make where it sits now the spot it returns to.
   *  Without this a pin could never be made permanent — you would always
   *  snap back to wherever you first pinned from. */
  rehomePinnedNode: (id: string,
                     view: { pan: { x: number; y: number }; zoom: number }) => void
  /** SCREEN-px delta for pinned nodes. moveManyFreeNodes stays
   *  canvas-delta-only; keeping the two separate is what lets a pinned
   *  host carry pinned children later without reopening this store. */
  movePinnedNodes: (ids: string[], dx: number, dy: number) => void
  clampPinnedIntoView: (hostW: number, hostH: number) => void
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
      image: 'Image', note: 'Note', text: 'Text', video: 'Video', audio: 'Audio', model: 'Model',
      list: 'List', pool: 'Media Pool', prompt: 'Prompt Pad', history: 'History',
    }
    const heights: Record<FreeNodeType, number> = {
      image: 180, note: 160, text: 180, video: 180, audio: 120, model: 180,
      list: 440, pool: 420, prompt: 360, history: 400,
    }
    const widths: Partial<Record<FreeNodeType, number>> = {
      audio: 260,
      // Lists host a full embedded Rolodex — size for its natural panel
      // width (LEFTCOL_W 196 + margins).
      list: 240,
      pool: 520,     // a grid plus a preview needs room to read as one
      prompt: 460,
    }
    const node: FreeNodeData = {
      id, x, y,
      width: widths[type] ?? 200,
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

  moveFreeNode: (id, dx, dy) => {
    if (dx === 0 && dy === 0) return
    set(s => {
      const n = s.nodes[id]
      if (!n) return s
      return { nodes: { ...s.nodes, [id]: { ...n, x: n.x + dx, y: n.y + dy } } }
    })
  },

  moveManyFreeNodes: (ids, dx, dy) => {
    if (dx === 0 && dy === 0) return
    set(s => {
      const updated = { ...s.nodes }
      for (const id of ids) {
        const n = updated[id]
        // Canvas deltas only — pinned nodes take SCREEN deltas via
        // movePinnedNodes. Unguarded, dragging a Viewer header at zoom
        // 0.1 would walk a pinned panel 100px per 10px of drag.
        if (n && !n.pin) updated[id] = { ...n, x: n.x + dx, y: n.y + dy }
      }
      return { nodes: updated }
    })
  },

  resizeFreeNode: (id, dw, dh) =>
    set(s => {
      const n = s.nodes[id]
      if (!n) return s
      return { nodes: { ...s.nodes, [id]: { ...n, width: Math.max(120, n.width + dw), height: Math.max(80, n.height + dh) } } }
    }),

  setNodePlacement: (ids, to, view) =>
    set(s => {
      const nodes = { ...s.nodes }
      let changed = false
      for (const id of ids) {
        const n = nodes[id]
        if (!n) continue
        if (to === 'screen') {
          if (n.pin) continue
          // The rect the browser is painting RIGHT NOW: the world div is
          // translate(pan) scale(zoom) and the node is left:x top:y.
          nodes[id] = {
            ...n,
            pin: {
              x: view.pan.x + n.x * view.zoom,
              y: view.pan.y + n.y * view.zoom,
              scale: view.zoom,
            },
            // Remember where it stood, so unpinning is a return trip.
            home: { x: n.x, y: n.y, width: n.width, height: n.height },
          }
        } else {
          if (!n.pin) continue
          const { pin: _drop, home: _dropHome, ...rest } = n
          // Deliberately NOT routed through resizeFreeNode: its 120/80
          // floors would silently resize a small tile mid-flip and break
          // the seam.
          if (n.home) {
            nodes[id] = { ...rest, ...n.home }
          } else {
            // No recorded home — either pinned before homes existed, or
            // re-homing was never used. Unproject where it is now, which
            // is what unpin always did.
            const k = n.pin.scale / view.zoom
            nodes[id] = {
              ...rest,
              x: (n.pin.x - view.pan.x) / view.zoom,
              y: (n.pin.y - view.pan.y) / view.zoom,
              width: n.width * k,
              height: n.height * k,
            }
          }
        }
        changed = true
      }
      return changed ? { nodes } : s
    }),

  rehomePinnedNode: (id, view) =>
    set(s => {
      const n = s.nodes[id]
      if (!n?.pin) return s
      // Exactly the rect a no-home unpin would produce — so pressing this
      // and then unpinning leaves the panel visually where it is.
      const k = n.pin.scale / view.zoom
      return {
        nodes: {
          ...s.nodes,
          [id]: {
            ...n,
            home: {
              x: (n.pin.x - view.pan.x) / view.zoom,
              y: (n.pin.y - view.pan.y) / view.zoom,
              width: n.width * k,
              height: n.height * k,
            },
          },
        },
      }
    }),

  movePinnedNodes: (ids, dx, dy) => {
    if (dx === 0 && dy === 0) return
    set(s => {
      const nodes = { ...s.nodes }
      for (const id of ids) {
        const n = nodes[id]
        if (n?.pin) nodes[id] = { ...n, pin: { ...n.pin, x: n.pin.x + dx, y: n.pin.y + dy } }
      }
      return { nodes }
    })
  },

  clampPinnedIntoView: (hostW, hostH) =>
    set(s => {
      if (hostW <= 0 || hostH <= 0) return s
      const KEEP = 48
      const nodes = { ...s.nodes }
      let changed = false
      for (const n of Object.values(s.nodes)) {
        if (!n.pin) continue
        const w = n.width * n.pin.scale
        // x may go negative (a panel can hang off the left edge); y floors
        // at 0 because the header is the drag handle and a header above
        // the top edge is unrecoverable.
        const x = Math.max(KEEP - w, Math.min(hostW - KEEP, n.pin.x))
        const y = Math.max(0, Math.min(hostH - KEEP, n.pin.y))
        if (x !== n.pin.x || y !== n.pin.y) {
          nodes[n.id] = { ...n, pin: { ...n.pin, x, y } }
          changed = true
        }
      }
      return changed ? { nodes } : s
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
  storage: createDebouncedIDBStorage(400),
  partialize: (s) => ({ nodes: s.nodes }),  // selectedIds is transient
}))
