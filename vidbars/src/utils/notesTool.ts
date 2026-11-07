// notesTool.ts — the mouse for the 3D notes tools (store/notesStore,
// components/Notes/NotesPanel). Installed once, when this module loads, so
// it runs before the canvas's own listeners and the tilted view's re-send
// (as utils/placeTool): a press a tool takes reaches nothing else. Idle (no
// tool in the hand, no curve under the press) it returns at once.
//
// The same everywhere, flat or tilted: the canvas point under the cursor is
// read through the tilt (placeTool canvasPointUnder), so a curve drawn in
// 3D lies on the ground exactly where it would be drawn flat.
//  - Curve: click to add corner points, click-drag to pull a smooth point's
//    handles out. Double-click, Enter or Esc finishes it; clicking its first
//    point closes it. Arrowheads per the panel's toggles.
//  - Pen: freehand. Over a standing model in 3D it draws on the model's
//    surface; anywhere else it draws on the canvas.
//  - Pin: click a standing model in 3D to pin a note there (with its card).
//  - Erase: press or drag over a stroke on a model, a pin's dot or a curve
//    to remove just that (never the model or a card).
//  - Select (no tool): a curve is clicked to select it (Shift adds), dragged to move
//    it; a selected curve's points and handles drag (with any tool in the
//    hand too). Delete removes.
//  - Smooth (panel toggle): a curve runs through its points by itself.

import { create } from 'zustand'
import { useNotesStore, useNotesUi, newNoteId, type Curve, type CurvePoint } from '../store/notesStore'
import { canvasPointUnder, overCanvas } from './placeTool'
import { useCanvasStore } from '../store/canvasStore'
import { useTiltStore, isTilted } from '../store/tiltStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { models, modelKey } from '../components/Canvas/tilt/TiltModels'
import { ensureAnnotated, addPin } from './annotations'

/** The curve being drawn, and where the cursor is (for the next segment). */
export const useCurveDraft = create<{ curve: Curve | null; hover: { x: number; y: number } | null }>(() => ({ curve: null, hover: null }))

const zoomNow = () => useCanvasStore.getState().zoom
const checkpoint = () => useUndoCoordinator.getState().checkpoint()

/** Finish the curve being drawn: kept with two points or more. */
export function commitDraft() {
  const { curve } = useCurveDraft.getState()
  useCurveDraft.setState({ curve: null, hover: null })
  if (!curve) return
  // A double-click's two presses add the same point twice.
  const pts: CurvePoint[] = []
  const near = 2 / zoomNow()
  for (const p of curve.pts) {
    const q = pts[pts.length - 1]
    if (q && Math.hypot(q.x - p.x, q.y - p.y) < near) { if (p.hout) q.hout = p.hout; continue }
    pts.push(p)
  }
  if (pts.length < 2) return
  useNotesStore.getState().addCurve({ ...curve, pts })
  useNotesUi.setState({ selected: [curve.id] })
}

// Putting the curve tool down finishes what it was drawing.
useNotesUi.subscribe((s, prev) => { if (prev.tool === 'curve' && s.tool !== 'curve') commitDraft() })

type Drag = (e: PointerEvent) => void
let drag: { move: Drag; up: Drag } | null = null
let eatClick = false

function claim(e: Event) {
  e.preventDefault()
  e.stopImmediatePropagation()
}

/** The standing model under a point in 3D, if any: its key. */
function modelUnder(e: PointerEvent): string | null {
  if (!isTilted(useTiltStore.getState()) || !models.pick) return null
  const k = modelKey(models.pick(e.clientX, e.clientY))
  return k && !k.startsWith('person|') ? k : null
}

function startDrag(move: Drag, up: Drag) {
  drag = { move, up }
}

function onDown(e: PointerEvent) {
  if (!e.isTrusted || e.button !== 0 || e.altKey) return
  const target = e.target as Element | null
  if (!target?.closest) return
  if (target.closest('[data-notes-panel],[data-top-icon-bar],[data-tilt-hud]')) return
  const ui = useNotesUi.getState()

  // Linking a pin: the next card clicked is the one.
  if (ui.linking) {
    const card = target.closest<HTMLElement>('[data-group-card][data-id]')
    if (card) {
      claim(e); eatClick = true
      checkpoint()
      useNotesStore.getState().updatePin(ui.linking.url, ui.linking.pinId, { cardId: card.dataset.id! })
      useNotesUi.setState({ linking: null })
      return
    }
    if (overCanvas(target)) useNotesUi.setState({ linking: null })
    return
  }

  // A selected curve's points and handles drag whatever tool is in the hand.
  if (!ui.tool || (!useCurveDraft.getState().curve && target.closest('[data-curve-anchor],[data-curve-handle]'))) { selectPress(e, target); return }
  if (!overCanvas(target)) return

  if (ui.tool === 'curve') {
    const p = canvasPointUnder(e.clientX, e.clientY)
    if (!p) return
    claim(e); eatClick = true
    const z = zoomNow()
    let { curve } = useCurveDraft.getState()
    if (curve && curve.pts.length >= 2) {
      const f = curve.pts[0]
      if (Math.hypot(f.x - p.cx, f.y - p.cy) * z < 9) {
        useCurveDraft.setState({ curve: { ...curve, closed: true } })
        commitDraft()
        return
      }
    }
    if (!curve) {
      checkpoint()
      curve = {
        id: newNoteId('cv'), kind: 'bezier', pts: [], color: ui.color, width: ui.width / z,
        arrowStart: ui.arrowStart, arrowEnd: ui.arrowEnd, smooth: ui.smooth,
      }
    }
    const anchor: CurvePoint = { x: p.cx, y: p.cy }
    curve = { ...curve, pts: [...curve.pts, anchor] }
    useCurveDraft.setState({ curve, hover: null })
    const x0 = e.clientX, y0 = e.clientY
    // Dragging out from a new point pulls its handles: a smooth point. On a
    // smooth curve (no handles) the point itself goes where it is dragged.
    startDrag(ev => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
      const q = canvasPointUnder(ev.clientX, ev.clientY)
      const c = useCurveDraft.getState().curve
      if (!q || !c) return
      const last = c.pts[c.pts.length - 1]
      if (c.smooth) {
        useCurveDraft.setState({ curve: { ...c, pts: c.pts.slice(0, -1).concat({ x: q.cx, y: q.cy }) } })
        return
      }
      const hout = { x: q.cx - last.x, y: q.cy - last.y }
      const pts = c.pts.slice(0, -1).concat({ ...last, hout, hin: { x: -hout.x, y: -hout.y } })
      useCurveDraft.setState({ curve: { ...c, pts } })
    }, () => {})
    return
  }

  if (ui.tool === 'pen') {
    const key = modelUnder(e)
    if (key && models.surface) {
      const hit = models.surface(key, e.clientX, e.clientY)
      if (hit) { claim(e); eatClick = true; surfaceStroke(e, key, hit); return }
    }
    const p = canvasPointUnder(e.clientX, e.clientY)
    if (!p) return
    claim(e); eatClick = true
    checkpoint()
    const z = zoomNow()
    const curve: Curve = { id: newNoteId('cv'), kind: 'free', pts: [{ x: p.cx, y: p.cy }], color: ui.color, width: ui.width / z }
    useCurveDraft.setState({ curve, hover: null })
    let lx = e.clientX, ly = e.clientY
    startDrag(ev => {
      if (Math.hypot(ev.clientX - lx, ev.clientY - ly) < 2) return
      lx = ev.clientX; ly = ev.clientY
      const q = canvasPointUnder(ev.clientX, ev.clientY)
      const c = useCurveDraft.getState().curve
      if (!q || !c) return
      useCurveDraft.setState({ curve: { ...c, pts: [...c.pts, { x: q.cx, y: q.cy }] } })
    }, () => {
      const c = useCurveDraft.getState().curve
      useCurveDraft.setState({ curve: null, hover: null })
      if (c && c.pts.length >= 2) useNotesStore.getState().addCurve(c)
    })
    return
  }

  if (ui.tool === 'erase') {
    if (!overCanvas(target) && !target.closest('[data-curve-id]')) return
    // Every press on the canvas is the eraser's: nothing under it is moved,
    // selected or deleted but what it rubs out.
    claim(e); eatClick = true
    let marked = false
    const rub = (ev: PointerEvent) => {
      const once = () => { if (!marked) { marked = true; checkpoint() } }
      const ns = useNotesStore.getState()
      // A pin's dot.
      const r = models.root?.getBoundingClientRect()
      const spot = r && models.pinSpots?.().find(s => Math.hypot(r.left + s.x - ev.clientX, r.top + s.y - ev.clientY) < 9)
      if (spot) { once(); ns.removePin(spot.url, spot.pinId); return }
      // A stroke on a model.
      const st = models.strokeAt?.(ev.clientX, ev.clientY)
      if (st) { once(); ns.removeStroke(st.url, st.id); return }
      // A curve on the canvas.
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-curve-id]')
      const id = under?.getAttribute('data-curve-id')
      if (id && ns.curves[id]) {
        once(); ns.deleteCurves([id])
        useNotesUi.setState(u => ({ selected: u.selected.filter(x => x !== id) }))
      }
    }
    rub(e)
    startDrag(rub, () => {})
    return
  }

  if (ui.tool === 'pin') {
    const key = modelUnder(e)
    const hit = key && models.surface?.(key, e.clientX, e.clientY)
    if (!key || !hit) return
    claim(e); eatClick = true
    checkpoint()
    const eps = hit.size * 0.002
    addPin(hit.url, key,
      [hit.p.x + hit.n.x * eps, hit.p.y + hit.n.y * eps, hit.p.z + hit.n.z * eps],
      [hit.n.x, hit.n.y, hit.n.z])
    startDrag(() => {}, () => {})
  }
}

/** Draw on a model's surface, from a press at `hit`. */
function surfaceStroke(e: PointerEvent, key: string, hit: NonNullable<ReturnType<NonNullable<typeof models.surface>>>) {
  const ui = useNotesUi.getState()
  checkpoint()
  ensureAnnotated(hit.url, key)
  const url = hit.url
  // A hair off the surface, along its normal, so it is not lost in it.
  const eps = hit.size * 0.003
  const pts = [hit.p.x + hit.n.x * eps, hit.p.y + hit.n.y * eps, hit.p.z + hit.n.z * eps]
  const id = newNoteId('st')
  const ns = useNotesStore.getState()
  ns.addStroke(url, { id, color: ui.color, width: ui.width, pts: pts.concat(pts) })
  let lx = e.clientX, ly = e.clientY
  const set = () => {
    const m = useNotesStore.getState().models[url]
    if (m) useNotesStore.getState().patchModel(url, { strokes: m.strokes.map(s => s.id === id ? { ...s, pts: pts.slice() } : s) })
  }
  startDrag(ev => {
    if (Math.hypot(ev.clientX - lx, ev.clientY - ly) < 2) return
    const h = models.surface?.(key, ev.clientX, ev.clientY)
    if (!h) return
    lx = ev.clientX; ly = ev.clientY
    pts.push(h.p.x + h.n.x * eps, h.p.y + h.n.y * eps, h.p.z + h.n.z * eps)
    set()
  }, () => {
    if (pts.length < 6) useNotesStore.getState().removeStroke(url, id)
  })
}

/** No tool: presses on curves select, move and reshape them. */
function selectPress(e: PointerEvent, target: Element) {
  const ui = useNotesUi.getState()
  const handle = target.closest<SVGElement>('[data-curve-handle]')
  const anchor = target.closest<SVGElement>('[data-curve-anchor]')
  const line = target.closest<SVGElement>('[data-curve-id]')
  if (handle || anchor) {
    claim(e); eatClick = true
    const [id, i, side] = (handle ?? anchor)!.getAttribute(handle ? 'data-curve-handle' : 'data-curve-anchor')!.split(':')
    const idx = +i
    let started = false
    const ctrl = e.ctrlKey
    startDrag(ev => {
      const q = canvasPointUnder(ev.clientX, ev.clientY)
      const c = useNotesStore.getState().curves[id]
      if (!q || !c) return
      if (!started) { started = true; checkpoint() }
      const pts = c.pts.slice()
      const p = { ...pts[idx] }
      if (handle) {
        const h = { x: q.cx - p.x, y: q.cy - p.y }
        const other = side === 'in' ? 'hout' : 'hin'
        if (side === 'in') p.hin = h; else p.hout = h
        // Kept smooth: the other handle turns with it (Ctrl breaks the point).
        if (!ctrl && !ev.ctrlKey) {
          const o = p[other]
          const len = o ? Math.hypot(o.x, o.y) : Math.hypot(h.x, h.y)
          const l = Math.hypot(h.x, h.y) || 1
          p[other] = { x: -h.x / l * len, y: -h.y / l * len }
        }
      } else {
        p.x = q.cx; p.y = q.cy
      }
      pts[idx] = p
      useNotesStore.getState().updateCurve(id, { pts })
    }, () => {})
    return
  }
  if (line) {
    claim(e); eatClick = true
    const id = line.getAttribute('data-curve-id')!
    const sel = e.shiftKey
      ? (ui.selected.includes(id) ? ui.selected.filter(x => x !== id) : [...ui.selected, id])
      : (ui.selected.includes(id) ? ui.selected : [id])
    useNotesUi.setState({ selected: sel })
    const p0 = canvasPointUnder(e.clientX, e.clientY)
    if (!p0) return
    let last = p0, started = false
    const x0 = e.clientX, y0 = e.clientY
    startDrag(ev => {
      if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
      const q = canvasPointUnder(ev.clientX, ev.clientY)
      if (!q) return
      if (!started) { started = true; checkpoint() }
      useNotesStore.getState().moveCurves(useNotesUi.getState().selected, q.cx - last.cx, q.cy - last.cy)
      last = q
    }, () => {})
    return
  }
  // Elsewhere on the canvas: the curves let go (the press goes on as usual).
  if (ui.selected.length && overCanvas(target)) useNotesUi.setState({ selected: [] })
}

function onMove(e: PointerEvent) {
  if (!e.isTrusted) return
  if (drag) { claim(e); drag.move(e); return }
  if (useNotesUi.getState().tool === 'curve' && useCurveDraft.getState().curve) {
    const p = overCanvas(e.target) ? canvasPointUnder(e.clientX, e.clientY) : null
    useCurveDraft.setState({ hover: p && { x: p.cx, y: p.cy } })
  }
}

function onUp(e: PointerEvent) {
  if (!drag || !e.isTrusted) return
  claim(e)
  const d = drag
  drag = null
  d.up(e)
  setTimeout(() => { eatClick = false }, 0)
}

function onClick(e: MouseEvent) {
  if (e.type === 'dblclick' && useNotesUi.getState().tool === 'curve' && useCurveDraft.getState().curve) {
    claim(e)
    commitDraft()
    return
  }
  if (eatClick) claim(e)
}

function typing(): boolean {
  const t = document.activeElement as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}

function onKey(e: KeyboardEvent) {
  if (typing()) return
  const ui = useNotesUi.getState()
  const draft = useCurveDraft.getState().curve
  if (e.key === 'Escape') {
    if (draft) { claim(e); commitDraft(); return }
    if (ui.linking) { claim(e); useNotesUi.setState({ linking: null }); return }
    if (ui.tool) { claim(e); useNotesUi.setState({ tool: null }); return }
    if (ui.selected.length) { useNotesUi.setState({ selected: [] }); return }
    return
  }
  if (e.key === 'Enter' && draft) { claim(e); commitDraft(); return }
  if ((e.key === 'Delete' || e.key === 'Backspace') && ui.selected.length) {
    claim(e)
    checkpoint()
    useNotesStore.getState().deleteCurves(ui.selected)
    useNotesUi.setState({ selected: [] })
  }
}

// Installed once; a reload of this module (dev) swaps the handlers in place.
type Handlers = { onDown: typeof onDown; onMove: typeof onMove; onUp: typeof onUp; onClick: typeof onClick; onKey: typeof onKey }
const w = (typeof window !== 'undefined' ? window : undefined) as (Window & { __notesTool?: Handlers }) | undefined
if (w) {
  const first = !w.__notesTool
  w.__notesTool = { onDown, onMove, onUp, onClick, onKey }
  if (first) {
    const h = () => w.__notesTool!
    w.addEventListener('pointerdown', e => h().onDown(e), true)
    w.addEventListener('pointermove', e => h().onMove(e), true)
    w.addEventListener('pointerup', e => h().onUp(e), true)
    w.addEventListener('pointercancel', e => h().onUp(e), true)
    w.addEventListener('click', e => h().onClick(e), true)
    w.addEventListener('dblclick', e => h().onClick(e), true)
    w.addEventListener('keydown', e => h().onKey(e), true)
  }
}
