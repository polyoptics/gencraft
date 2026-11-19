// stickTool.ts — the mouse for the measuring sticks (store/notesStore
// sticks; Brian 2026-11-18). Installed once when this module loads, ahead
// of utils/notesTool's listeners and the canvas's own, so a press on a
// stick reaches nothing else. Idle (no stick on the canvas, the tool not
// in the hand) it returns at once. The same flat and in 3D: flat a stick
// lies on the canvas pointing up it, in 3D it stands, and where it is on
// screen is asked of whichever draws it.
//  - The Measuring stick tool (the Notes panel): click the canvas to put
//    one down, 6 ft tall. The tool is put down with it.
//  - Drag its board: its top goes higher or lower, an inch at a time (a
//    centimetre, metric). Shift-drag the board: the whole stick grows or
//    shrinks, marks and all, and the models of the cards it is docked to
//    with it (utils/stickDock).
//  - Double-click the number on its board: the list of fonts for it.
//    Double-click the rest of the board: feet or metres.
//  - Drag its pole or foot: it moves across the canvas. Let go with its
//    feet on a card or a deck, it is docked to it.
//  - Click it to select it; Delete removes it. The Erase tool's click
//    removes it too.

import { useNotesStore, useNotesUi, newNoteId, type Stick } from '../store/notesStore'
import { useStickUi, useCurveDraft } from '../store/pathLive'
import { useCanvasStore } from '../store/canvasStore'
import { useTiltStore, isTilted } from '../store/tiltStore'
import { useManip } from '../store/manipStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { clientToCanvas } from './fx/createEffect'
import { canvasPointUnder, overCanvas, usePlacing } from './placeTool'
import { models } from '../components/Canvas/tilt/TiltModels'
import type { StickSpot } from '../three/stickOverlay'
import './stickDock'
import { STICK_FT, STICK_NEW_PX, SIGN_W, SIGN_H, SIGN_TEXT, stickLen, snapHeight } from './stickGeom'

type Pt = { x: number; y: number }
type Part = 'top' | 'body'

const checkpoint = () => useUndoCoordinator.getState().checkpoint()
const sticksNow = () => useNotesStore.getState().sticks
const in3d = () => isTilted(useTiltStore.getState())

/** Where every stick is on screen, client px. */
function spots(): StickSpot[] {
  if (in3d()) return models.stickSpots?.() ?? []
  const zoom = useCanvasStore.getState().zoom
  const o = clientToCanvas(0, 0)
  const at = (x: number, y: number) => ({ x: (x - o.cx) * zoom, y: (y - o.cy) * zoom })
  return Object.values(sticksNow()).map(s => {
    const L = stickLen(s)
    return { id: s.id, foot: at(s.x, s.y), top: at(s.x, s.y - L), sign: at(s.x, s.y - L - (0.05 + SIGN_H) * s.per), hw: SIGN_W * s.per * zoom, hh: SIGN_H * s.per * zoom }
  })
}

const segDist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t)
}

/** The stick, and the part of it, at a point on screen. */
function hitAt(p: Pt): { spot: StickSpot; part: Part } | null {
  let best: { spot: StickSpot; part: Part; d: number } | null = null
  for (const s of spots()) {
    const ds = Math.hypot(p.x - s.sign.x, p.y - s.sign.y)
    const on = Math.abs(p.x - s.sign.x) <= Math.max(s.hw, 9) && Math.abs(p.y - s.sign.y) <= Math.max(s.hh, 9)
    if (on && (!best || best.part !== 'top' || ds < best.d)) { best = { spot: s, part: 'top', d: ds }; continue }
    const db = Math.min(segDist(p, s.foot, s.top), Math.hypot(p.x - s.foot.x, p.y - s.foot.y) - 4)
    if (db <= 7 && (!best || (best.part === 'body' && db < best.d))) best = { spot: s, part: 'body', d: db }
  }
  return best
}

/** A press or the cursor here is the canvas's (not a panel's, a pinned
 *  card's or a menu's), and nothing else has the mouse. */
function free(target: EventTarget | null, e: { clientX: number; clientY: number }): boolean {
  const el = target as Element | null
  if (!el?.closest || el.closest('[data-notes-panel],[data-top-icon-bar],[data-tilt-hud],[data-path-menu]')) return false
  if (!overCanvas(el)) return false
  if (useManip.getState().through || usePlacing.getState().kind || useCurveDraft.getState().curve) return false
  // A model's manipulator is in front of it.
  if (in3d() && models.gizmoAt?.(e.clientX, e.clientY)) return false
  return true
}

/** A point on a stick's board is on its number (the board's upper part,
 *  over the rule). */
const onNumber = (p: Pt, s: StickSpot) => (p.y - (s.sign.y - s.hh)) / Math.max(1, s.hh * 2) < SIGN_TEXT

/** Two presses on a board this close together: a double-click (ms). */
const DOUBLE_MS = 380
let lastPress: { id: string; t: number; x: number; y: number } | null = null
let drag: { move: (e: PointerEvent) => void } | null = null
let eatClick = false
let hotCursor = false

function claim(e: Event) {
  e.preventDefault()
  e.stopImmediatePropagation()
}

function onDown(e: PointerEvent) {
  if (!e.isTrusted || e.button !== 0 || e.altKey) return
  const ui = useNotesUi.getState()
  const have = Object.keys(sticksNow()).length > 0
  if (ui.tool !== 'stick' && !have) return
  if (!free(e.target, e)) return

  // The tool in the hand: a new stick stands where the canvas is clicked.
  if (ui.tool === 'stick') {
    const p = canvasPointUnder(e.clientX, e.clientY)
    if (!p) return
    claim(e); eatClick = true
    checkpoint()
    const zoom = useCanvasStore.getState().zoom || 1
    const s: Stick = { id: newNoteId('st'), x: p.cx, y: p.cy, ft: STICK_FT, per: STICK_NEW_PX / STICK_FT / zoom }
    useNotesStore.getState().addStick(s)
    useStickUi.setState({ selected: s.id })
    useNotesUi.setState({ tool: null, selected: [], points: [] })
    return
  }

  const hit = hitAt({ x: e.clientX, y: e.clientY })
  if (!hit) {
    if (useStickUi.getState().selected) useStickUi.setState({ selected: null })
    return
  }
  if (ui.tool === 'erase') {
    claim(e); eatClick = true
    checkpoint()
    useNotesStore.getState().deleteSticks([hit.spot.id])
    useStickUi.setState({ selected: null, hot: null })
    return
  }
  // Any other tool in the hand draws over it.
  if (ui.tool) return
  const s0 = sticksNow()[hit.spot.id]
  if (!s0) return
  claim(e); eatClick = true
  useStickUi.setState({ selected: s0.id })
  if (ui.selected.length) useNotesUi.setState({ selected: [], points: [] })
  const x0 = e.clientX, y0 = e.clientY
  // Double-click its board: on the number, the fonts; off it, the unit.
  if (hit.part === 'top') {
    const now = performance.now(), was = lastPress
    lastPress = { id: s0.id, t: now, x: x0, y: y0 }
    if (was && was.id === s0.id && now - was.t < DOUBLE_MS && Math.hypot(x0 - was.x, y0 - was.y) < 6) {
      lastPress = null
      if (onNumber({ x: x0, y: y0 }, hit.spot)) useStickUi.setState({ fonts: { id: s0.id, x: x0 + 14, y: y0 - 20 } })
      else { checkpoint(); useNotesStore.getState().updateStick(s0.id, { metric: s0.metric ? undefined : true }) }
      return
    }
  } else lastPress = null
  let moved = false
  const begin = (ev: PointerEvent) => {
    if (moved) return true
    if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return false
    moved = true
    lastPress = null
    checkpoint()
    return true
  }
  if (hit.part === 'top') {
    // The screen step of one canvas unit up the pole, at the press.
    // Seen end on it is nothing: then up the screen is up.
    const L0 = stickLen(s0), zoom = useCanvasStore.getState().zoom || 1
    let u = { x: (hit.spot.top.x - hit.spot.foot.x) / L0, y: (hit.spot.top.y - hit.spot.foot.y) / L0 }
    if (Math.hypot(u.x, u.y) < 0.05 * zoom) u = { x: 0, y: -0.5 * zoom }
    const whole = e.shiftKey
    drag = {
      move: ev => {
        if (!begin(ev)) return
        const L = L0 + ((ev.clientX - x0) * u.x + (ev.clientY - y0) * u.y) / (u.x * u.x + u.y * u.y)
        if (whole) {
          // The whole stick, its marks with it.
          useNotesStore.getState().updateStick(s0.id, { per: Math.max(s0.per * 0.02, L / s0.ft) })
        } else {
          // Its top alone, to the inch (metric, the centimetre).
          useNotesStore.getState().updateStick(s0.id, { ft: snapHeight(L / s0.per, s0.metric) })
        }
      },
    }
  } else {
    // Its foot goes where the cursor takes it across the canvas.
    const f0 = hit.spot.foot
    drag = {
      move: ev => {
        if (!begin(ev)) return
        const p = canvasPointUnder(f0.x + ev.clientX - x0, f0.y + ev.clientY - y0)
        if (p) useNotesStore.getState().updateStick(s0.id, { x: p.cx, y: p.cy })
      },
    }
  }
}

function onMove(e: PointerEvent) {
  if (!e.isTrusted) return
  if (drag) { claim(e); drag.move(e); return }
  // The part under the cursor lights up.
  let hot: string | null = null, part: Part | null = null
  const tool = useNotesUi.getState().tool
  if (!e.buttons && (!tool || tool === 'erase') && Object.keys(sticksNow()).length && free(e.target, e)) {
    const h = hitAt({ x: e.clientX, y: e.clientY })
    if (h) { hot = `${h.spot.id}:${h.part}`; part = h.part }
  }
  if (useStickUi.getState().hot !== hot) useStickUi.setState({ hot })
  if (part || hotCursor) document.documentElement.style.cursor = !part ? '' : tool === 'erase' ? 'pointer' : part === 'top' ? 'ns-resize' : 'move'
  hotCursor = !!part
}

function onUp(e: PointerEvent) {
  if (!drag) return
  claim(e)
  drag = null
  setTimeout(() => { eatClick = false }, 0)
}

function onClick(e: MouseEvent) {
  if (!eatClick) return
  eatClick = false
  claim(e)
}

/** A double-click on a stick is the stick's (taken on its second press). */
function onDbl(e: MouseEvent) {
  if (!e.isTrusted || useNotesUi.getState().tool || !Object.keys(sticksNow()).length) return
  if (useStickUi.getState().fonts || (free(e.target, e) && hitAt({ x: e.clientX, y: e.clientY }))) claim(e)
}

function onKey(e: KeyboardEvent) {
  const sel = useStickUi.getState().selected
  if (!sel || (e.key !== 'Delete' && e.key !== 'Backspace')) return
  const t = document.activeElement as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  if (!sticksNow()[sel]) { useStickUi.setState({ selected: null }); return }
  claim(e)
  checkpoint()
  useNotesStore.getState().deleteSticks([sel])
  useStickUi.setState({ selected: null, hot: null })
}

// Installed once; a reload of this module (dev) swaps the handlers in place.
type Handlers = { onDown: typeof onDown; onMove: typeof onMove; onUp: typeof onUp; onClick: typeof onClick; onKey: typeof onKey; onDbl?: typeof onDbl }
const w = (typeof window !== 'undefined' ? window : undefined) as (Window & { __stickTool?: Handlers }) | undefined
if (w) {
  const first = !w.__stickTool
  w.__stickTool = { onDown, onMove, onUp, onClick, onKey, onDbl }
  // (A dev reload of the first version of this file left no double-click listener.)
  if (!first && !(w as unknown as { __stickDbl?: boolean }).__stickDbl) { (w as unknown as { __stickDbl?: boolean }).__stickDbl = true; w.addEventListener('dblclick', e => w.__stickTool!.onDbl?.(e), true) }
  if (first) {
    const h = () => w.__stickTool!
    w.addEventListener('pointerdown', e => h().onDown(e), true)
    w.addEventListener('pointermove', e => h().onMove(e), true)
    w.addEventListener('pointerup', e => h().onUp(e), true)
    w.addEventListener('pointercancel', e => h().onUp(e), true)
    w.addEventListener('click', e => h().onClick(e), true)
    w.addEventListener('keydown', e => h().onKey(e), true)
    ;(w as unknown as { __stickDbl?: boolean }).__stickDbl = true
    w.addEventListener('dblclick', e => h().onDbl?.(e), true)
  }
}
