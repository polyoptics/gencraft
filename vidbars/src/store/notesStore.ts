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

/** A bezier handle, relative to its anchor (canvas units; `z` up). */
export interface CurveHandle { x: number; y: number; z?: number }

/** One anchor of a curve, canvas units. `z` is its height off the canvas
 *  (Brian 2026-11-12: a path's points move up and down in 3D; flat, a
 *  curve is seen from straight above). `hin`/`hout` are its bezier
 *  handles, relative to the anchor; absent = a sharp corner. `t` is how
 *  its tangents behave: absent, the two handles stay in one line (on a
 *  smooth curve, the line finds them itself); 'unified', its handles are
 *  set by hand and stay in one line (what a point on a smooth curve
 *  becomes when its tangent is turned by hand); 'broken', each handle is
 *  its own, set by hand; 'corner', no handles: the line turns sharply. */
export interface CurvePoint {
  x: number; y: number; z?: number; hin?: CurveHandle; hout?: CurveHandle; t?: 'unified' | 'broken' | 'corner'
  /** How far the path is rolled about its own line here, in degrees
   *  (it blends along the line between points): which way is up for what
   *  rides or shows on the path. */
  twist?: number
  /** A few words shown by the point. */
  label?: string
  /** false: its curve's point graphic (Curve.mark) is off at this point. */
  mark?: false
  /** What rides the path slows into this point and gathers speed out of it. */
  slow?: boolean
}

/** What stands on an end of a curve. */
export type CurveEnd = 'arrow' | 'cube' | 'ball'
/** The piece a curve's pattern repeats: a length of line, a ball, a ring,
 *  a wire cube, 'plus' (a plus sign in all three directions); or 'hatch',
 *  a road: two edges with chevrons between, lying flat to the path. The
 *  last three show the path's twist. */
export type CurveUnit = 'line' | 'ball' | 'ring' | 'hatch' | 'cube' | 'plus'
/** A graphic at each point of a curve: a cube of which only the corners
 *  show, a crosshair in all three directions, the line swelling. */
export type CurveMark = 'corners' | 'cross' | 'bulge'
/** How a bulge falls away from its point. */
export type CurveEase = 'linear' | 'in' | 'out' | 'inout' | 'log' | 'exp' | 'spike' | 'step' | 'bounce'

/** A model riding a path (Brian 2026-11-12: "parent the models to the
 *  paths"): which model, and how it sits on the path as it goes. */
export interface PathRider {
  /** The model, as the 3D view knows it: 'node:<id>' or 'card:<id>'. */
  key: string
  /** How far along the path it starts, 0..1 of its length: several on
   *  one path follow each other. Absent: 0. */
  lead?: number
  /** Faces the way the path runs. Absent: on. */
  aim?: boolean
  /** Turned from the way the path runs, degrees. Absent: 0. */
  heading?: number
  /** How much it leans into the path's turns, percent. Absent: 0. */
  bank?: number
  /** Tips up and down with the path's climbs. Absent: on. */
  slope?: boolean
  /** Rolls with the path's twist. Absent: on. */
  twist?: boolean
  /** The middle of its bounding box keeps to the path, and it turns
   *  about that middle. Absent: off (its feet do). */
  centre?: boolean
  /** Carried above the path, and to its side (canvas units). Absent: 0. */
  lift?: number
  side?: number
  /** How it is turned at points of the path (by the point's index), set
   *  by reframing a camera there while looking through it: a turn of its
   *  own in the 3D view's axes, blended from point to point. A point
   *  without one: as the path has it. */
  keys?: Record<number, [number, number, number, number]>
}
/** What a path's riders do once they reach its end. */
export type RideAfter = 'loop' | 'stop' | 'pingpong'

export interface Curve {
  id: string
  /** What it is called in the Outliner. Absent: by what it is (Curve, Arrow, Pen line). */
  name?: string
  /** The models riding it, and when (seconds on the ride clock, which
   *  every path shares, so several stay in step): they set off at
   *  `rideStart` and arrive at `rideEnd` (absent or not after the start:
   *  they go at the speed of the line's own motion, `flow`). Then they go
   *  round again, stop, or come back (`rideAfter`; absent: loop).
   *  `rideEase`: they gather speed and slow into the ends. */
  riders?: PathRider[]
  rideStart?: number
  rideEnd?: number
  rideAfter?: RideAfter
  rideEase?: boolean
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
  /** Its line as a repeating pattern (Brian 2026-11-12: "control of the
   *  length of the solid section and the length of the empty section"):
   *  [solid, empty] lengths along the line, canvas units. Absent: one
   *  solid line. ('dash' and 'dot' are the first hours' fixed styles,
   *  still drawn: utils/curveGeom dashOf.) */
  dash?: [number, number] | 'dash' | 'dot'
  /** The piece the pattern repeats (absent: lengths of the line). A
   *  ball or a ring is `dash[0]` across, `dash[1]` apart. */
  unit?: 'ball' | 'ring' | 'hatch' | 'cube' | 'plus'
  /** A road's chevrons: how far each points ahead, as a share of the
   *  road's width (absent: 0.5), and whether a pulse runs down them. */
  chev?: number
  pulse?: boolean
  /** Its points ping one after another along it. */
  ping?: boolean
  /** The ping: how fast (times; absent 1), how wide its rings spread
   *  (canvas units across; absent: goes with the point graphic's size)
   *  and how many rings follow each other (absent 1). */
  pingSpeed?: number
  pingSize?: number
  pingRings?: number
  /** The 'bulge' graphic: near each point the line and the pieces of its
   *  pattern are this many times their size (absent: 2; under 1 they
   *  shrink), over `bulgeReach` either side (canvas units; absent: as far
   *  as the point's tangent handles reach), falling away as `bulgeEase`
   *  (absent: 'inout'). The size, or the colour, can pulse. */
  bulge?: number
  bulgeReach?: number
  bulgeEase?: CurveEase
  pulseSize?: boolean
  pulseColor?: boolean
  /** The line and its pattern's pieces are this many times their size at
   *  its start / its end (absent: 1, no change; 0: down to nothing),
   *  over `endReach` (canvas units; absent: a length that goes with the
   *  thickness). */
  startScale?: number
  endScale?: number
  endReach?: number
  /** How solid it is, 0..1 (absent: 1). */
  opacity?: number
  /** The pattern runs along the line: canvas units a second, towards its
   *  end (negative: towards its start). */
  flow?: number
  /** A graphic at each of its points (CurvePoint.mark false: not there). */
  mark?: CurveMark
  /** The point graphics' own colour and how far across they are (canvas
   *  units). Absent: the line's colour, a size that goes with its
   *  thickness. */
  markColor?: string
  markSize?: number
  /** The same for what stands on its ends. */
  endColor?: string
  endSize?: number
  /** What stands on its ends. Absent: an arrowhead where arrowStart /
   *  arrowEnd say so (as before there was a choice), else nothing. */
  endStart?: CurveEnd
  endEnd?: CurveEnd
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
  /** The link is to the whole deck `cardId` is the front of (a closed
   *  deck clicked while linking, Brian 2026-11-09). */
  deck?: boolean
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

/** A lasting mark on a picture (the Viewer's Annotate mode, Brian
 *  2026-11-08): kept by the picture's url, in its natural pixels, so it
 *  is there whenever and wherever the picture is shown. */
export interface PictureMark {
  id: string
  color: string
  /** Line width, natural px. */
  size: number
  /** The brush's path, or a shape's two corners (a line's two ends). */
  pts: { x: number; y: number }[]
  shape?: 'rect' | 'ellipse' | 'line' | 'arrow'
  fill?: boolean
}

interface NotesStore {
  pictures: Record<string, PictureMark[]>
  addMark: (url: string, m: PictureMark) => void
  updateMark: (url: string, id: string, patch: Partial<PictureMark>) => void
  removeMarks: (url: string, ids: string[]) => void
  clearMarks: (url: string) => void
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
  pictures: {},
  rev: 0,
  addMark: (url, m) => set(s => ({ pictures: { ...s.pictures, [url]: [...(s.pictures[url] ?? []), m] } })),
  updateMark: (url, id, patch) => set(s => s.pictures[url] ? { pictures: { ...s.pictures, [url]: s.pictures[url].map(m => m.id === id ? { ...m, ...patch } : m) } } : s),
  removeMarks: (url, ids) => set(s => {
    const list = s.pictures[url]
    if (!list) return s
    const next = list.filter(m => !ids.includes(m.id))
    return next.length === list.length ? s : { pictures: { ...s.pictures, [url]: next } }
  }),
  clearMarks: url => set(s => {
    if (!s.pictures[url]) return s
    const pictures = { ...s.pictures }
    delete pictures[url]
    return { pictures }
  }),
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
  storage: createDebouncedIDBStorage<Pick<NotesStore, 'curves' | 'models' | 'pictures'>>(400, {
    isEmpty: s => Object.keys(s.curves ?? {}).length === 0 && Object.keys(s.models ?? {}).length === 0 && Object.keys(s.pictures ?? {}).length === 0,
  }),
  partialize: s => ({ curves: s.curves, models: s.models, pictures: s.pictures }),
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
  /** New curves' ends. */
  endStart: CurveEnd | null
  endEnd: CurveEnd | null
  /** New curves' pattern piece, how solid they are (percent), how fast
   *  the pattern runs (screen px a second; 0 still) and the graphic at
   *  their points. */
  unit: CurveUnit
  opacity: number
  flow: number
  mark: CurveMark | null
  /** The point graphics' and the ends' own colour (null: the line's) and
   *  size (screen px; 0: goes with the line's thickness). */
  markColor: string | null
  markSize: number
  /** A road's chevrons: how far each points ahead (percent of its width)
   *  and the pulse; the points' ping. */
  chev: number
  pulse: boolean
  ping: boolean
  /** The ping's speed (percent), size (screen px across; 0: follows the points' size) and rings. */
  pingSpeed: number
  pingSize: number
  pingRings: number
  /** The bulge: its size (percent), reach (screen px; 0: the tangents'),
   *  falloff and pulses; the size at each end (percent) and how far in
   *  from the end that reaches (screen px). */
  bulge: number
  bulgeReach: number
  bulgeEase: CurveEase
  pulseSize: boolean
  pulseColor: boolean
  startScale: number
  endScale: number
  endReach: number
  endColor: string | null
  endSize: number
  /** New curves run smoothly through their points. */
  smooth: boolean
  /** New curves' line pattern: the length of each solid section and of
   *  the empty one after it, screen px at the zoom it is drawn at. An
   *  empty length of 0 is one solid line. */
  dashOn: number
  dashGap: number
  /** Selected curves. */
  selected: string[]
  /** Selected points of curves: `${curve id}:${index}` (utils/pathEdit). */
  points: string[]
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
  endStart: saved.endStart !== undefined ? saved.endStart : (saved as { arrowStart?: boolean }).arrowStart ? 'arrow' : null,
  endEnd: saved.endEnd !== undefined ? saved.endEnd : (saved as { arrowEnd?: boolean }).arrowEnd === false ? null : 'arrow',
  unit: saved.unit ?? 'line',
  opacity: saved.opacity ?? 100,
  flow: saved.flow ?? 0,
  mark: saved.mark ?? null,
  markColor: saved.markColor ?? null,
  markSize: saved.markSize ?? 0,
  chev: saved.chev ?? 50,
  pulse: saved.pulse ?? false,
  ping: saved.ping ?? false,
  pingSpeed: saved.pingSpeed ?? 100,
  pingSize: saved.pingSize ?? 0,
  pingRings: saved.pingRings ?? 1,
  bulge: saved.bulge ?? 200,
  bulgeReach: saved.bulgeReach ?? 0,
  bulgeEase: saved.bulgeEase ?? 'inout',
  pulseSize: saved.pulseSize ?? false,
  pulseColor: saved.pulseColor ?? false,
  startScale: saved.startScale ?? 100,
  endScale: saved.endScale ?? 100,
  endReach: saved.endReach ?? 80,
  endColor: saved.endColor ?? null,
  endSize: saved.endSize ?? 0,
  smooth: saved.smooth ?? false,
  dashOn: saved.dashOn ?? 16,
  dashGap: saved.dashGap ?? 0,
  selected: [],
  points: [],
  linking: null,
  focus: null,
}))
useNotesUi.subscribe(s => {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({
      open: s.open, collapsed: s.collapsed, color: s.color, width: s.width, endStart: s.endStart, endEnd: s.endEnd, smooth: s.smooth, dashOn: s.dashOn, dashGap: s.dashGap,
      unit: s.unit, opacity: s.opacity, flow: s.flow, mark: s.mark, chev: s.chev, pulse: s.pulse, ping: s.ping, pingSpeed: s.pingSpeed, pingSize: s.pingSize, pingRings: s.pingRings, bulge: s.bulge, bulgeReach: s.bulgeReach, bulgeEase: s.bulgeEase, pulseSize: s.pulseSize, pulseColor: s.pulseColor, startScale: s.startScale, endScale: s.endScale, endReach: s.endReach, markColor: s.markColor, markSize: s.markSize, endColor: s.endColor, endSize: s.endSize,
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
