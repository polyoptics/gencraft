// mapNotes.ts — notes on a 3D set's map (Brian 2026-11-15): marks and pins
// drawn on the set in the flat view. They are the set's (kept on its
// ground's node, FreeNodeData.mapNotes, from its top-left corner): they go
// where it goes, fold into its card with it (utils/area3dCard keeps them
// in the card's mat) and lie on its ground, under the cursor where they
// were drawn. Drawn by components/Notes/MapNotesLayer.
//
// The tools are the Viewer's Annotate tools (components/Viewport3D/
// ImageStudio): brush, rectangle, ellipse, line, arrow, eraser, fill,
// colour and size, and a Pin, which holds words. One set at a time is
// being annotated (useMapNotesUi.area): while it is, a press on its ground
// draws; a press anywhere else does what it always does.
//
// The mouse is installed once, when this module loads (utils/notesTool
// imports it first), so it runs before the canvas's own listeners: a press
// it takes reaches nothing else. Idle it returns at once.

import { create } from 'zustand'
import { useFreeNodeStore, type MapMark, type MapNotes, type MapPin } from '../store/freeNodeStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { canvasPointUnder, overCanvas } from './placeTool'

export type MapTool = 'brush' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'pin' | 'erase'

interface MapNotesUi {
  /** The set being annotated (its ground's node id). */
  area: string | null
  tool: MapTool
  color: string
  /** Screen px at the zoom it is drawn at. */
  size: number
  fill: boolean
  /** The mark being drawn. */
  draft: MapMark | null
  /** A pin being moved: where it is now. */
  held: { id: string; x: number; y: number } | null
  /** The pin whose words are being typed. */
  editing: string | null
}

const KEY = 'vidbars.mapNotesUi'
const saved: Partial<MapNotesUi> = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} } })()
export const useMapNotesUi = create<MapNotesUi>(() => ({
  area: null,
  tool: saved.tool ?? 'brush',
  color: saved.color ?? '#fbbf24',
  size: saved.size ?? 4,
  fill: saved.fill ?? false,
  draft: null,
  held: null,
  editing: null,
}))
useMapNotesUi.subscribe(s => {
  try { localStorage.setItem(KEY, JSON.stringify({ tool: s.tool, color: s.color, size: s.size, fill: s.fill })) } catch { /* private window */ }
})

const EMPTY: MapNotes = { marks: [], pins: [] }
export const notesOf = (id: string): MapNotes => useFreeNodeStore.getState().nodes[id]?.mapNotes ?? EMPTY
const hasAny = (n: MapNotes) => n.marks.length > 0 || n.pins.length > 0

/** Change set `id`'s notes. The caller takes the undo checkpoint. */
export function setNotes(id: string, f: (n: MapNotes) => MapNotes) {
  const fs = useFreeNodeStore.getState()
  const a = fs.nodes[id]
  if (!a || a.type !== 'area') return
  const next = f(a.mapNotes ?? EMPTY)
  fs.updateFreeNode(id, { mapNotes: hasAny(next) || next.off ? next : undefined })
}

/** How big a pin and its words are drawn, × their natural screen size: as
 *  on the screen till the canvas is zoomed far out, then smaller with it. */
export const pinScale = (zoom: number) => Math.max(0.3, Math.min(1, zoom / 0.12))
/** A pin's dot, screen px across at its natural size. */
export const PIN_DOT = 18

let seq = 0
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq = (seq + 1) % 1e6).toString(36)}`

/** Start, or stop, annotating set `id`. Starting shows its notes. */
export function annotateSet(id: string | null) {
  useMapNotesUi.setState({ area: id, draft: null, held: null, editing: null })
  if (id && notesOf(id).off) setNotes(id, n => ({ ...n, off: undefined }))
}

/** Its notes layer shown or not (kept either way). */
export function showSetNotes(id: string, on: boolean) {
  useUndoCoordinator.getState().checkpoint()
  setNotes(id, n => ({ ...n, off: on ? undefined : true }))
  if (!on && useMapNotesUi.getState().area === id) annotateSet(null)
}

export function clearSetNotes(id: string) {
  if (!hasAny(notesOf(id))) return
  useUndoCoordinator.getState().checkpoint()
  useMapNotesUi.setState({ editing: null })
  setNotes(id, n => ({ ...n, marks: [], pins: [] }))
}

/** A pin's words. One undo step for each time its words are opened. */
export function setPinText(areaId: string, pinId: string, patch: Partial<Pick<MapPin, 'title' | 'desc'>>) {
  setNotes(areaId, n => ({ ...n, pins: n.pins.map(p => p.id === pinId ? { ...p, ...patch } : p) }))
}

/** Is set-local point n on mark m (within tol canvas units)? As the
 *  Viewer's (ImageStudio hitMark). */
export function hitMapMark(m: MapMark, n: { x: number; y: number }, tol: number): boolean {
  const t = tol + m.size / 2
  const seg = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy
    const u = l2 ? Math.max(0, Math.min(1, ((n.x - a.x) * dx + (n.y - a.y) * dy) / l2)) : 0
    return Math.hypot(n.x - a.x - dx * u, n.y - a.y - dy * u) <= t
  }
  const a = m.pts[0], b = m.pts[m.pts.length - 1]
  if (!m.shape) return m.pts.length === 1 ? seg(a, a) : m.pts.some((p, i) => i > 0 && seg(m.pts[i - 1], p))
  if (m.shape === 'line' || m.shape === 'arrow') return seg(a, b)
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y)
  if (m.shape === 'rect') {
    if (m.fill && n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1) return true
    const c = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
    return c.some((p, i) => seg(p, c[(i + 1) % 4]))
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max((x1 - x0) / 2, 1e-6), ry = Math.max((y1 - y0) / 2, 1e-6)
  const q = Math.hypot((n.x - cx) / rx, (n.y - cy) / ry)
  if (m.fill && q <= 1) return true
  return Math.abs(q - 1) * Math.min(rx, ry) <= t
}

// ── The mouse ──

type Gesture =
  | { kind: 'draw' }
  | { kind: 'erase'; took: boolean }
  | { kind: 'pin'; id: string; dx: number; dy: number; x0: number; y0: number; moved: boolean }

let gesture: Gesture | null = null
let pointer = -1
let eatClick = false

/** The set being annotated and the point under the cursor on it (from its
 *  corner), when the cursor is over its ground. */
function onSet(e: { clientX: number; clientY: number; target: EventTarget | null }, anywhere = false) {
  const id = useMapNotesUi.getState().area
  const a = id ? useFreeNodeStore.getState().nodes[id] : null
  if (!id || !a || a.type !== 'area') return null
  if (!anywhere && !overCanvas(e.target)) return null
  const p = canvasPointUnder(e.clientX, e.clientY)
  if (!p) return null
  const x = p.cx - a.x, y = p.cy - a.y
  if (!anywhere && (x < 0 || y < 0 || x > a.width || y > a.height)) return null
  return { id, a, x, y }
}

function eraseAt(id: string, x: number, y: number, g: { took: boolean }) {
  const zoom = useCanvasStore.getState().zoom
  const n = notesOf(id)
  const marks = n.marks.filter(m => !hitMapMark(m, { x, y }, 6 / zoom))
  const r = PIN_DOT / 2 * pinScale(zoom) / zoom + 3 / zoom
  const pins = n.pins.filter(p => Math.hypot(p.x - x, p.y - y) > r)
  if (marks.length === n.marks.length && pins.length === n.pins.length) return
  if (!g.took) { useUndoCoordinator.getState().checkpoint(); g.took = true }
  const ed = useMapNotesUi.getState().editing
  if (ed && !pins.some(p => p.id === ed)) useMapNotesUi.setState({ editing: null })
  setNotes(id, v => ({ ...v, marks, pins }))
}

function onDown(e: PointerEvent) {
  const ui = useMapNotesUi.getState()
  if (!ui.area) return
  if (e.button !== 0 || gesture) return
  const target = e.target as Element | null
  // Its own bar, and a pin's words being typed: theirs.
  if (target?.closest?.('[data-map-notes-bar], [data-map-pin-edit]')) return
  const at = onSet(e)
  if (!at) return
  const zoom = useCanvasStore.getState().zoom
  const take = () => {
    e.preventDefault()
    e.stopImmediatePropagation()
    pointer = e.pointerId
    eatClick = true
    // (Words being typed are kept as the press takes the focus away.)
    const act = document.activeElement as HTMLElement | null
    if (act?.closest?.('[data-map-pin-edit]')) act.blur()
  }
  if (ui.tool === 'erase') {
    take()
    gesture = { kind: 'erase', took: false }
    eraseAt(at.id, at.x, at.y, gesture)
    return
  }
  // A pin under the press: with the Pin tool it is held, to move it or
  // (let go where it was) to open its words. With another tool, a click
  // on it opens its words too.
  const r = PIN_DOT / 2 * pinScale(zoom) / zoom + 2 / zoom
  const pin = notesOf(at.id).pins.find(p => Math.hypot(p.x - at.x, p.y - at.y) <= r)
  const onWords = target?.closest?.('[data-map-pin]')?.getAttribute('data-map-pin')
  if (ui.tool === 'pin' || pin || onWords) {
    take()
    const hit = pin ?? (onWords ? notesOf(at.id).pins.find(p => p.id === onWords) : undefined)
    if (hit) {
      gesture = { kind: 'pin', id: hit.id, dx: hit.x - at.x, dy: hit.y - at.y, x0: e.clientX, y0: e.clientY, moved: false }
      return
    }
    useUndoCoordinator.getState().checkpoint()
    const n = notesOf(at.id)
    const made: MapPin = { id: newId('mp'), x: at.x, y: at.y, color: ui.color, title: '', desc: '', n0: Math.max(0, ...n.pins.map(p => p.n0)) + 1 }
    setNotes(at.id, v => ({ ...v, pins: [...v.pins, made] }))
    useMapNotesUi.setState({ editing: made.id })
    gesture = null
    return
  }
  take()
  useMapNotesUi.setState({ editing: null })
  const p = { x: at.x, y: at.y }
  const size = ui.size / zoom
  useMapNotesUi.setState({
    draft: ui.tool === 'brush'
      ? { id: newId('mm'), color: ui.color, size, pts: [p] }
      : { id: newId('mm'), color: ui.color, size, pts: [p, p], shape: ui.tool, fill: ui.fill },
  })
  gesture = { kind: 'draw' }
}

function onMove(e: PointerEvent) {
  if (!gesture || e.pointerId !== pointer) return
  e.stopImmediatePropagation()
  const at = onSet(e, true)
  if (!at) return
  const zoom = useCanvasStore.getState().zoom
  if (gesture.kind === 'erase') { eraseAt(at.id, at.x, at.y, gesture); return }
  if (gesture.kind === 'pin') {
    if (!gesture.moved && Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) < 4) return
    gesture.moved = true
    const x = Math.max(0, Math.min(at.a.width, at.x + gesture.dx)), y = Math.max(0, Math.min(at.a.height, at.y + gesture.dy))
    useMapNotesUi.setState({ held: { id: gesture.id, x, y } })
    return
  }
  const d = useMapNotesUi.getState().draft
  if (!d) return
  const p = { x: at.x, y: at.y }
  if (d.shape) { useMapNotesUi.setState({ draft: { ...d, pts: [d.pts[0], p] } }); return }
  const l = d.pts[d.pts.length - 1]
  if (Math.hypot(p.x - l.x, p.y - l.y) < 1.5 / zoom) return
  useMapNotesUi.setState({ draft: { ...d, pts: [...d.pts, p] } })
}

function onUp(e: PointerEvent) {
  if (!gesture || e.pointerId !== pointer) return
  e.stopImmediatePropagation()
  const g = gesture
  gesture = null
  pointer = -1
  const ui = useMapNotesUi.getState()
  const id = ui.area
  if (g.kind === 'pin') {
    const held = ui.held
    useMapNotesUi.setState({ held: null })
    if (!id) return
    if (g.moved && held && e.type === 'pointerup') {
      useUndoCoordinator.getState().checkpoint()
      setNotes(id, n => ({ ...n, pins: n.pins.map(p => p.id === held.id ? { ...p, x: held.x, y: held.y } : p) }))
    } else if (!g.moved && e.type === 'pointerup') {
      useMapNotesUi.setState({ editing: g.id })
    }
    return
  }
  if (g.kind !== 'draw') return
  const d = ui.draft
  useMapNotesUi.setState({ draft: null })
  if (!d || !id || e.type !== 'pointerup') return
  // A shape of no size is a slip of the hand; a brush dot is a dot.
  const zoom = useCanvasStore.getState().zoom
  if (d.shape && Math.hypot(d.pts[1].x - d.pts[0].x, d.pts[1].y - d.pts[0].y) < 3 / zoom) return
  useUndoCoordinator.getState().checkpoint()
  setNotes(id, n => ({ ...n, marks: [...n.marks, d] }))
}

function onClick(e: MouseEvent) {
  if (!eatClick) return
  eatClick = false
  if (!useMapNotesUi.getState().area) return
  if ((e.target as Element | null)?.closest?.('[data-map-notes-bar], [data-map-pin-edit]')) return
  e.stopImmediatePropagation()
  e.preventDefault()
}

function onKey(e: KeyboardEvent) {
  const ui = useMapNotesUi.getState()
  if (!ui.area || e.key !== 'Escape') return
  e.stopImmediatePropagation()
  if (ui.editing) { useMapNotesUi.setState({ editing: null }); return }
  annotateSet(null)
}

// The set gone (deleted, folded into its card): nothing is being annotated.
useFreeNodeStore.subscribe(s => {
  const id = useMapNotesUi.getState().area
  if (id && s.nodes[id]?.type !== 'area') annotateSet(null)
})

// (Through `h`, so an edit to this file is picked up without a reload
// leaving the old listeners on.)
const live = { onDown, onMove, onUp, onClick, onKey }
type W = Window & { __mapNotesTool?: typeof live }
if (typeof window !== 'undefined') {
  const w = window as W
  const first = !w.__mapNotesTool
  w.__mapNotesTool = live
  const h = () => (window as W).__mapNotesTool!
  if (first) {
    w.addEventListener('pointerdown', e => h().onDown(e), true)
    w.addEventListener('pointermove', e => h().onMove(e), true)
    w.addEventListener('pointerup', e => h().onUp(e), true)
    w.addEventListener('pointercancel', e => h().onUp(e), true)
    w.addEventListener('click', e => h().onClick(e), true)
    w.addEventListener('keydown', e => h().onKey(e), true)
  }
}
