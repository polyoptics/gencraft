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
//  - Points (Brian 2026-11-12): a selected curve's points are clicked to
//    select them (Shift adds or takes away; double-click a point for all
//    of its curve's), dragged to move them, all the selected ones
//    together; Shift-drag in 3D lifts and lowers. Delete removes the
//    selected points. Double-click the line for a new point there. A
//    handle turns its other handle with it unless the point is broken
//    (the panel's Break, or Ctrl-drag a handle); Shift-drag a handle in 3D
//    lifts it. With the Curve tool, a click on an open curve's end point
//    carries on drawing from it.
//    In 3D the curves are things in the scene (three/pathOverlay), so what
//    is under the cursor is asked of the 3D view; flat, of the page.

import { useCurveDraft, usePathHot, usePathMenu } from '../store/pathLive'
import { useNotesStore, useNotesUi, newNoteId, type Curve, type CurvePoint, type CurveHandle } from '../store/notesStore'
import { curveSamples, nearestOnCurve } from './curveGeom'
import { ptKey, parsePt, pickedPoints, selectPoint, selectAllPoints, deletePickedPoints, insertPoint, holdPoints, moveHeld } from './pathEdit'
import type { PathHit } from '../three/pathOverlay'
import { clientToCanvas } from './fx/createEffect'
import { canvasPointUnder, overCanvas } from './placeTool'
import { useCanvasStore } from '../store/canvasStore'
import { useBoardsStore } from '../store/boardsStore'
import { useTiltStore, isTilted, unprojectTilt, TILT_FAR } from '../store/tiltStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { models, modelKey } from '../components/Canvas/tilt/TiltModels'
import { ensureAnnotated, addPin } from './annotations'

export { useCurveDraft }

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
  useNotesUi.setState({ selected: [curve.id], points: [] })
}

// A point is selected only on a selected curve: whatever lets a curve go
// lets its points go.
useNotesUi.subscribe(s => {
  if (!s.points.length) return
  const points = s.points.filter(k => s.selected.includes(parsePt(k).id))
  if (points.length !== s.points.length) useNotesUi.setState({ points })
})

const in3d = () => isTilted(useTiltStore.getState())

/** The canvas point under the cursor on the level `h` (canvas units) above
 *  the canvas, through the tilt when tilted: where a point at that height
 *  goes when dragged across. Null above the horizon. */
function canvasPointAt(clientX: number, clientY: number, h: number): { cx: number; cy: number } | null {
  const t = useTiltStore.getState()
  if (!isTilted(t) || !h) return canvasPointUnder(clientX, clientY)
  const host = document.querySelector('[data-tilt-stage="world"]')?.parentElement
  if (!host) return null
  const r = host.getBoundingClientRect()
  const mx = r.left + r.width / 2, my = r.top + r.height / 2
  const g = unprojectTilt(clientX - mx, clientY - my, t.tilt, t.spin, t.shiftX, t.shiftY, h * zoomNow(), TILT_FAR)
  return g ? clientToCanvas(mx + g.x, my + g.y) : null
}

/** How far up (canvas units) a drag of (dx, dy) screen px lifts a point
 *  at `p` in 3D: along the way up is drawn there. */
function liftBy(p: { x: number; y: number; z: number }, dx: number, dy: number): number {
  const a = models.pathPx?.(p), b = models.pathPx?.({ ...p, z: p.z + 100 })
  if (!a || !b) return 0
  const ux = (b.x - a.x) / 100, uy = (b.y - a.y) / 100, l2 = ux * ux + uy * uy
  return l2 > 1e-9 ? (dx * ux + dy * uy) / l2 : 0
}

/** What of a curve is under a press: in 3D as the 3D view draws it, flat
 *  (and a pen line, always) as the page does. `only`: just these curves. */
function hitAt(e: { clientX: number; clientY: number }, target: Element, only?: Set<string>): PathHit | null {
  if (in3d() && models.pathAt && overCanvas(target)) {
    const h = models.pathAt(e.clientX, e.clientY, only)
    if (h) return h
  }
  const handle = target.closest<SVGElement>('[data-curve-handle]')
  const anchor = target.closest<SVGElement>('[data-curve-anchor]')
  const line = target.closest<SVGElement>('[data-curve-id]')
  if (handle || anchor) {
    const [id, i, side] = (handle ?? anchor)!.getAttribute(handle ? 'data-curve-handle' : 'data-curve-anchor')!.split(':')
    if (only && !only.has(id)) return null
    return handle ? { kind: 'handle', id, i: +i, side: side as 'in' | 'out' } : { kind: 'point', id, i: +i }
  }
  if (line) {
    const id = line.getAttribute('data-curve-id')!
    const c = useNotesStore.getState().curves[id]
    if (!c || (only && !only.has(id))) return null
    const q = clientToCanvas(e.clientX, e.clientY)
    const near = nearestOnCurve(c, p => p, q.cx, q.cy)
    return { kind: 'line', id, seg: near?.seg ?? 0, t: near?.t ?? 0 }
  }
  return null
}

/** With the Curve tool, a click on an open curve's end point: carry on
 *  drawing from it. */
function resumeFrom(id: string, i: number): boolean {
  const ns = useNotesStore.getState()
  const c = ns.curves[id]
  if (!c || c.kind !== 'bezier' || c.closed || (i !== 0 && i !== c.pts.length - 1)) return false
  checkpoint()
  ns.deleteCurves([id])
  // From its first point: the points turn round, so the new ones follow
  // on; its arrowheads stay on the ends they were on.
  const flip = (p: CurvePoint): CurvePoint => {
    const q: CurvePoint = { ...p, hin: p.hout, hout: p.hin }
    if (!q.hin) delete q.hin
    if (!q.hout) delete q.hout
    return q
  }
  const curve: Curve = i === 0 && c.pts.length > 1
    ? { ...c, pts: c.pts.map(flip).reverse(), arrowStart: c.arrowEnd, arrowEnd: c.arrowStart }
    : c
  useNotesUi.setState({ selected: [], points: [] })
  useCurveDraft.setState({ curve, hover: null })
  return true
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
    // An open deck's primary is covered by its hover zone (data-row-of):
    // clicking it links the whole deck too.
    const row = card ? undefined : target.closest<HTMLElement>('[data-row-of]')?.dataset.rowOf
    if (row) {
      claim(e); eatClick = true
      checkpoint()
      useNotesStore.getState().updatePin(ui.linking.url, ui.linking.pinId, { cardId: row, deck: true })
      useNotesUi.setState({ linking: null })
      return
    }
    if (card) {
      claim(e); eatClick = true
      checkpoint()
      // A closed deck clicked: the pin links the whole deck (its front).
      const g = useBoardsStore.getState().groups.find(x => x.id === card.dataset.id)
      const closed = !!g && (g.deckState === 'stacked' || g.deckState === 'fanned')
      useNotesStore.getState().updatePin(ui.linking.url, ui.linking.pinId, closed
        ? { cardId: g!.deckAnchorId ?? g!.id, deck: true }
        : { cardId: card.dataset.id!, deck: undefined })
      useNotesUi.setState({ linking: null })
      return
    }
    if (overCanvas(target)) useNotesUi.setState({ linking: null })
    return
  }

  // A selected curve's points and handles drag whatever tool is in the hand.
  if (!ui.tool) { selectPress(e, target, hitAt(e, target)); return }
  if (!useCurveDraft.getState().curve && ui.selected.length) {
    const h = hitAt(e, target, new Set(ui.selected))
    if (h && h.kind !== 'line') { selectPress(e, target, h); return }
    // The Curve tool on a selected curve's line: a new point there.
    if (h && ui.tool === 'curve' && useNotesStore.getState().curves[h.id]?.kind === 'bezier') {
      claim(e); eatClick = true
      checkpoint()
      insertPoint(h.id, h.seg, h.t)
      startDrag(() => {}, () => {})
      return
    }
  }
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
        arrowStart: ui.arrowStart, arrowEnd: ui.arrowEnd, smooth: ui.smooth, ...(ui.dashGap > 0 ? { dash: [ui.dashOn / z, ui.dashGap / z] as [number, number] } : {}),
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
      // A curve on the canvas (in 3D, as the 3D view draws it).
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-curve-id]')
      const id = (in3d() ? models.pathAt?.(ev.clientX, ev.clientY)?.id : null) ?? under?.getAttribute('data-curve-id')
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

const hz = (h: CurveHandle | undefined) => h?.z ?? 0
const mkH = (x: number, y: number, z: number): CurveHandle => Math.abs(z) > 1e-6 ? { x, y, z } : { x, y }

/** Presses on curves select, move and reshape them. `hit`: what of a
 *  curve is under the press. */
function selectPress(e: PointerEvent, target: Element, hit: PathHit | null) {
  const ui = useNotesUi.getState()
  const x0 = e.clientX, y0 = e.clientY
  const moved = (ev: PointerEvent) => Math.hypot(ev.clientX - x0, ev.clientY - y0) >= 4
  if (hit?.kind === 'handle') {
    claim(e); eatClick = true
    const { id, i, side } = hit
    const c0 = useNotesStore.getState().curves[id]
    const p0 = c0?.pts[i]
    const h0 = p0 && (side === 'in' ? p0.hin : p0.hout)
    if (!p0 || !h0) return
    // Dragged across the level it is on; Shift lifts and lowers it.
    const level = (p0.z ?? 0) + hz(h0)
    const g0 = canvasPointAt(x0, y0, level)
    let started = false
    const ctrl = e.ctrlKey
    startDrag(ev => {
      const c = useNotesStore.getState().curves[id]
      if (!c || !c.pts[i]) return
      if (!started) { if (!moved(ev)) return; started = true; checkpoint() }
      const pts = c.pts.slice()
      const p = { ...pts[i] }
      let h: CurveHandle
      if (ev.shiftKey && in3d()) {
        h = mkH(h0.x, h0.y, hz(h0) + liftBy({ x: p0.x + h0.x, y: p0.y + h0.y, z: level }, ev.clientX - x0, ev.clientY - y0))
      } else {
        const q = canvasPointAt(ev.clientX, ev.clientY, level)
        if (!q || !g0) return
        h = mkH(h0.x + q.cx - g0.cx, h0.y + q.cy - g0.cy, hz(h0))
      }
      const other = side === 'in' ? 'hout' : 'hin'
      if (side === 'in') p.hin = h; else p.hout = h
      // Ctrl breaks the point: from then on each handle is its own.
      if (ctrl || ev.ctrlKey) p.t = 'broken'
      // Kept in one line: the other handle turns with it, keeping its length.
      if (p.t !== 'broken') {
        const o = p[other]
        const l = Math.hypot(h.x, h.y, hz(h)) || 1
        const len = o ? Math.hypot(o.x, o.y, hz(o)) : l
        p[other] = mkH(-h.x / l * len, -h.y / l * len, -hz(h) / l * len)
      }
      pts[i] = p
      useNotesStore.getState().updateCurve(id, { pts })
    }, () => {})
    return
  }
  if (hit?.kind === 'point') {
    claim(e); eatClick = true
    const { id, i } = hit
    const key = ptKey(id, i)
    const was = ui.points.includes(key)
    // Shift adds it (and, already in, takes it out when let go unmoved);
    // without, it is the one selected, unless it is one of several, which
    // then all move with it.
    if (e.shiftKey) { if (!was) selectPoint(id, i, true) }
    else if (!was) selectPoint(id, i, false)
    const grabbed = useNotesStore.getState().curves[id]?.pts[i]
    if (!grabbed) return
    const level = grabbed.z ?? 0
    const g0 = canvasPointAt(x0, y0, level)
    const held = holdPoints(pickedPoints())
    let started = false
    startDrag(ev => {
      if (!held) return
      if (!started) { if (!moved(ev)) return; started = true; checkpoint() }
      if (ev.shiftKey && in3d()) {
        moveHeld(held, 0, 0, liftBy({ x: grabbed.x, y: grabbed.y, z: level }, ev.clientX - x0, ev.clientY - y0))
        return
      }
      const q = canvasPointAt(ev.clientX, ev.clientY, level)
      if (q && g0) moveHeld(held, q.cx - g0.cx, q.cy - g0.cy, 0)
    }, () => {
      if (started) return
      // The Curve tool on an end point: carry on drawing from it.
      if (useNotesUi.getState().tool === 'curve' && resumeFrom(id, i)) return
      if (e.shiftKey) { if (was) selectPoint(id, i, true) }
      else if (was) selectPoint(id, i, false)
    })
    return
  }
  if (hit?.kind === 'line') {
    claim(e); eatClick = true
    const id = hit.id
    const sel = e.shiftKey
      ? (ui.selected.includes(id) ? ui.selected.filter(x => x !== id) : [...ui.selected, id])
      : (ui.selected.includes(id) ? ui.selected : [id])
    useNotesUi.setState({ selected: sel, points: e.shiftKey ? ui.points : [] })
    // Dragged across the level the line is at where it was grabbed.
    const c0 = useNotesStore.getState().curves[id]
    const s = c0 ? curveSamples(c0) : []
    let level = 0, best = Infinity
    for (const q of s) {
      const d = Math.abs(q.seg + q.t - hit.seg - hit.t)
      if (d < best) { best = d; level = q.z }
    }
    const p0 = canvasPointAt(x0, y0, level)
    if (!p0) return
    let last = p0, started = false
    startDrag(ev => {
      if (!started && !moved(ev)) return
      const q = canvasPointAt(ev.clientX, ev.clientY, level)
      if (!q) return
      if (!started) { started = true; checkpoint() }
      useNotesStore.getState().moveCurves(useNotesUi.getState().selected, q.cx - last.cx, q.cy - last.cy)
      last = q
    }, () => {})
    return
  }
  // Elsewhere on the canvas: the curves let go (the press goes on as usual).
  if (ui.selected.length && overCanvas(target)) useNotesUi.setState({ selected: [], points: [] })
}

/** The part of a curve the cursor is over in 3D lights up. */
let hotCursor = false
function hover3d(e: PointerEvent) {
  const ui = useNotesUi.getState()
  let hot: string | null = null, line = false
  const target = e.target as Element | null
  if (!e.buttons && in3d() && models.pathAt && target?.closest && overCanvas(target) && !useCurveDraft.getState().curve
    && (!ui.tool || ui.selected.length) && !models.gizmoAt?.(e.clientX, e.clientY)) {
    const h = models.pathAt(e.clientX, e.clientY, ui.tool ? new Set(ui.selected) : undefined)
    if (h?.kind === 'point') hot = `p:${h.id}:${h.i}`
    else if (h?.kind === 'handle') hot = `h:${h.id}:${h.i}:${h.side}`
    else if (h && !ui.tool) line = true
  }
  if (usePathHot.getState().hot !== hot) usePathHot.setState({ hot })
  const want = !!hot || line
  if (want || hotCursor) document.documentElement.style.cursor = hot ? 'move' : line ? 'pointer' : ''
  hotCursor = want
}

function onMove(e: PointerEvent) {
  if (!e.isTrusted) return
  if (drag) { claim(e); drag.move(e); return }
  hover3d(e)
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
  // Select: double-click a point for every point of its curve, the line
  // for a new point there.
  if (e.type === 'dblclick' && !useNotesUi.getState().tool && e.isTrusted) {
    const target = e.target as Element | null
    const hit = target?.closest ? hitAt(e, target) : null
    if (hit?.kind === 'point') { claim(e); selectAllPoints(hit.id); return }
    if (hit?.kind === 'line' && useNotesStore.getState().curves[hit.id]?.kind === 'bezier') {
      claim(e)
      checkpoint()
      insertPoint(hit.id, hit.seg, hit.t)
      return
    }
  }
  if (eatClick) claim(e)
}

/** Right-click a curve's point or its line: its menu (components/Notes/
 *  PathMenu), where a point's tangent mode is set right in the view, and
 *  points are added and deleted. What it acts on is selected first. */
function onMenu(e: MouseEvent) {
  if (!e.isTrusted || useCurveDraft.getState().curve) return
  const target = e.target as Element | null
  if (!target?.closest || target.closest('[data-notes-panel],[data-top-icon-bar],[data-tilt-hud],[data-path-menu]')) return
  const hit = hitAt(e, target)
  if (!hit || hit.kind === 'handle') return
  const c = useNotesStore.getState().curves[hit.id]
  if (!c) return
  claim(e)
  const ui = useNotesUi.getState()
  if (hit.kind === 'point') {
    if (!ui.points.includes(ptKey(hit.id, hit.i))) selectPoint(hit.id, hit.i, false)
    usePathMenu.setState({ at: { x: e.clientX, y: e.clientY, id: hit.id, point: hit.i } })
  } else {
    useNotesUi.setState({ selected: ui.selected.includes(hit.id) ? ui.selected : [hit.id], points: ui.selected.includes(hit.id) ? ui.points : [] })
    usePathMenu.setState({ at: { x: e.clientX, y: e.clientY, id: hit.id, seg: hit.seg, t: hit.t } })
  }
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
    if (ui.points.length) { useNotesUi.setState({ points: [] }); return }
    if (ui.selected.length) { useNotesUi.setState({ selected: [] }); return }
    return
  }
  if (e.key === 'Enter' && draft) { claim(e); commitDraft(); return }
  if ((e.key === 'Delete' || e.key === 'Backspace') && ui.selected.length) {
    claim(e)
    checkpoint()
    // The selected points; with none selected, the curves themselves.
    if (deletePickedPoints()) return
    useNotesStore.getState().deleteCurves(ui.selected)
    useNotesUi.setState({ selected: [], points: [] })
  }
}

// Installed once; a reload of this module (dev) swaps the handlers in place.
type Handlers = { onDown: typeof onDown; onMove: typeof onMove; onUp: typeof onUp; onClick: typeof onClick; onKey: typeof onKey; onMenu?: typeof onMenu }
const w = (typeof window !== 'undefined' ? window : undefined) as (Window & { __notesTool?: Handlers }) | undefined
if (w) {
  const first = !w.__notesTool
  w.__notesTool = { onDown, onMove, onUp, onClick, onKey, onMenu }
  if (first) {
    const h = () => w.__notesTool!
    w.addEventListener('pointerdown', e => h().onDown(e), true)
    w.addEventListener('pointermove', e => h().onMove(e), true)
    w.addEventListener('pointerup', e => h().onUp(e), true)
    w.addEventListener('pointercancel', e => h().onUp(e), true)
    w.addEventListener('click', e => h().onClick(e), true)
    w.addEventListener('dblclick', e => h().onClick(e), true)
    w.addEventListener('keydown', e => h().onKey(e), true)
    w.addEventListener('contextmenu', e => h().onMenu?.(e), true)
  }
}
