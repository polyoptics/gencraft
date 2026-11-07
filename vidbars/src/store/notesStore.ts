// notesStore.ts — the 3D notes and drawing tools (Brian 2026-11-07):
//  - CURVES: bezier curves and arrows on the canvas, flat or tilted (they
//    lie on the ground, so 2D and 3D show the same thing), and freehand
//    pen lines on the canvas;
//  - MODEL NOTES, per model file: coloured strokes drawn onto the model's
//    surface and pins (small labels, each backed by a card).
// The tools themselves (which one is in the hand, its colour) are UI state:
// useNotesUi below, kept in localStorage.
//
// Model notes are keyed by the model's FILE (its url): wherever that model
// stands (its tile, a card showing it, a Viewer) its strokes and pins are on
// it. Points are in the model's own space (three's local space of the loaded
// file), so they stay on the surface however it is sized or turned.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'

/** One anchor of a curve, canvas units. `hin`/`hout` are its bezier
 *  handles, relative to the anchor; absent = a sharp corner. */
export interface CurvePoint { x: number; y: number; hin?: { x: number; y: number }; hout?: { x: number; y: number } }

export interface Curve {
  id: string
  /** 'bezier': anchors with handles (the Curve tool); 'free': a pen line,
   *  many points, no handles. */
  kind: 'bezier' | 'free'
  pts: CurvePoint[]
  closed?: boolean
  color: string
  /** Line width, canvas units (so it scales with the canvas, as a card does). */
  width: number
  arrowStart?: boolean
  arrowEnd?: boolean
  /** Smooth: the line runs through its points on its own, no handles to
   *  set (a bezier's stored handles are kept but not used). */
  smooth?: boolean
}

/** A stroke drawn on a model's surface, in the model's own space. */
export interface SurfaceStroke {
  id: string
  color: string
  /** Screen px. */
  width: number
  /** x, y, z triples. */
  pts: number[]
}

export type PinStatus = 'open' | 'resolved'

/** A pin on a model: a small label, backed by a card. */
export interface ModelPin {
  id: string
  /** Where on the surface, model space, and the surface normal there. */
  p: [number, number, number]
  n: [number, number, number]
  /** Its title when it has no card (the card's name wins while it has one). */
  title: string
  /** Optional second line. */
  desc: string
  /** The card it links to (a canvas card's group id). Any card can be linked. */
  cardId?: string
  status: PinStatus
  /** Creation order, for numbering. */
  n0: number
  /** Where its label sits, model space: it stays there in 3D as the view
   *  turns. Absent: a little way out from the pin, along its normal and up. */
  at?: [number, number, number]
}

export interface ModelNotes {
  url: string
  /** Name to show for the model (its file name). */
  name: string
  strokes: SurfaceStroke[]
  pins: ModelPin[]
  /** The Annotation card (free node) made for it. */
  cardNodeId?: string
}

interface NotesStore {
  curves: Record<string, Curve>
  models: Record<string, ModelNotes>
  /** Bumped on every change to `models`, so the 3D view rebuilds what it
   *  draws only when something changed. */
  rev: number
  addCurve: (c: Curve) => void
  updateCurve: (id: string, patch: Partial<Curve>) => void
  deleteCurves: (ids: string[]) => void
  moveCurves: (ids: string[], dx: number, dy: number) => void
  ensureModel: (url: string, name: string) => ModelNotes
  patchModel: (url: string, patch: Partial<ModelNotes>) => void
  addStroke: (url: string, s: SurfaceStroke) => void
  removeStroke: (url: string, id: string) => void
  clearStrokes: (url: string) => void
  addPin: (url: string, pin: ModelPin) => void
  updatePin: (url: string, id: string, patch: Partial<ModelPin>) => void
  removePin: (url: string, id: string) => void
}

const touchModel = (s: NotesStore, url: string, f: (m: ModelNotes) => ModelNotes) => {
  const m = s.models[url]
  if (!m) return s
  return { models: { ...s.models, [url]: f(m) }, rev: s.rev + 1 }
}

export const useNotesStore = create<NotesStore>()(persist((set, get) => ({
  curves: {},
  models: {},
  rev: 0,
  addCurve: c => set(s => ({ curves: { ...s.curves, [c.id]: c } })),
  updateCurve: (id, patch) => set(s => s.curves[id] ? { curves: { ...s.curves, [id]: { ...s.curves[id], ...patch } } } : s),
  deleteCurves: ids => set(s => {
    const curves = { ...s.curves }
    for (const id of ids) delete curves[id]
    return { curves }
  }),
  moveCurves: (ids, dx, dy) => set(s => {
    if (!dx && !dy) return s
    const curves = { ...s.curves }
    for (const id of ids) {
      const c = curves[id]
      if (c) curves[id] = { ...c, pts: c.pts.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) }
    }
    return { curves }
  }),
  ensureModel: (url, name) => {
    const have = get().models[url]
    if (have) return have
    const m: ModelNotes = { url, name, strokes: [], pins: [] }
    set(s => ({ models: { ...s.models, [url]: m }, rev: s.rev + 1 }))
    return m
  },
  patchModel: (url, patch) => set(s => touchModel(s, url, m => ({ ...m, ...patch }))),
  addStroke: (url, st) => set(s => touchModel(s, url, m => ({ ...m, strokes: [...m.strokes, st] }))),
  removeStroke: (url, id) => set(s => touchModel(s, url, m => ({ ...m, strokes: m.strokes.filter(x => x.id !== id) }))),
  clearStrokes: url => set(s => touchModel(s, url, m => ({ ...m, strokes: [] }))),
  addPin: (url, pin) => set(s => touchModel(s, url, m => ({ ...m, pins: [...m.pins, pin] }))),
  updatePin: (url, id, patch) => set(s => touchModel(s, url, m => ({ ...m, pins: m.pins.map(p => p.id === id ? { ...p, ...patch } : p) }))),
  removePin: (url, id) => set(s => touchModel(s, url, m => ({ ...m, pins: m.pins.filter(p => p.id !== id) }))),
}), {
  name: 'vidbars-notes',
  storage: createDebouncedIDBStorage<Pick<NotesStore, 'curves' | 'models'>>(400, {
    isEmpty: s => Object.keys(s.curves ?? {}).length === 0 && Object.keys(s.models ?? {}).length === 0,
  }),
  partialize: s => ({ curves: s.curves, models: s.models }),
}))

// ── The tools (UI state) ──

/** What the mouse does on the canvas. null: what it always does. */
export type NotesTool = 'curve' | 'pen' | 'pin' | 'erase'

export const NOTE_COLORS = ['#ffffff', '#ff5a5a', '#ffb23f', '#ffe14a', '#5fe39b', '#4fc3ff', '#a98bff', '#ff8fd1', '#111318']

interface NotesUi {
  /** The side panel is out. */
  open: boolean
  /** Folded to its icon strip. */
  collapsed: boolean
  tool: NotesTool | null
  color: string
  /** Screen px at the zoom it is drawn at. */
  width: number
  arrowStart: boolean
  arrowEnd: boolean
  /** New curves run smoothly through their points. */
  smooth: boolean
  /** Selected curves. */
  selected: string[]
  /** A pin waiting for a card to be clicked, to link to it. */
  linking: { url: string; pinId: string } | null
  /** The pin being looked at: its label lit, its card shown beside it on
   *  its Annotation card. */
  focus: { url: string; pinId: string } | null
}

const UI_KEY = 'vidbars.notesUi'
function readUi(): Partial<NotesUi> {
  try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}') } catch { return {} }
}
const saved = readUi()
export const useNotesUi = create<NotesUi>(() => ({
  open: saved.open ?? false,
  collapsed: saved.collapsed ?? false,
  tool: null,
  color: saved.color ?? '#4fc3ff',
  width: saved.width ?? 3,
  arrowStart: saved.arrowStart ?? false,
  arrowEnd: saved.arrowEnd ?? true,
  smooth: saved.smooth ?? false,
  selected: [],
  linking: null,
  focus: null,
}))
useNotesUi.subscribe(s => {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({
      open: s.open, collapsed: s.collapsed, color: s.color, width: s.width, arrowStart: s.arrowStart, arrowEnd: s.arrowEnd, smooth: s.smooth,
    }))
  } catch { /* private window */ }
})

/** Pick a tool up, or (in the hand already) put it down. */
export function toggleTool(t: NotesTool) {
  const s = useNotesUi.getState()
  useNotesUi.setState({ tool: s.tool === t ? null : t, linking: null })
}

let seq = 0
export const newNoteId = (p: string) => `${p}${Date.now().toString(36)}${(seq = (seq + 1) % 1e6).toString(36)}`

/** A model's file name, for showing. */
export const modelFileName = (url: string) =>
  /^mediaref:/.test(url) ? 'Model' : decodeURIComponent(url.split(/[\\/]/).pop()!.split('?')[0]) || 'Model'
