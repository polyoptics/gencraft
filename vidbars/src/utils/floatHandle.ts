// floatHandle.ts — the lift handle on a regular model card's model in the
// 3D view (Brian 2026-11-10: "on regular model cards, a height
// adjustment"). Hover the model: a dot at its foot on a dashed stem down
// to a soft mark on its card. Drag the dot up or down: the model floats
// up off its card or sinks back (tiltStore floatOf, canvas units, kept
// and undoable). The mark shrinks and softens as it lifts. Double-click
// the dot: back sitting on its card. Nothing shows until hovered. Models
// in a 3D scene have the manipulator instead (utils/area3dHandles).
// In the 3D models' side view (utils/peek `side`, Brian 2026-11-23) the
// same handle sets how far off its card the 3D model is in that view
// (tiltStore sideFloatOf): that view's own, as the tilted view's lift is
// the tilted view's. Double-click there: back just clear of its card.
// Installed once when this module loads, ahead of the canvas's own
// listeners, so a press on the dot reaches nothing else.

import { isTilted, useTiltStore, useModelScaleStore } from '../store/tiltStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { useCanvasStore } from '../store/canvasStore'
import { useManip } from '../store/manipStore'
import { models, modelKey, soloFloat, setSoloFloat } from '../components/Canvas/tilt/TiltModels'
import { standsIn, dataKey } from './area3dScene'
import { usePeek } from './peek'
import { overQuarterRow } from './quarterHandle'

/** The dot's radius, and how near a press counts as on it (px). */
const DOT_R = 6
const HIT_R = 11
/** How long the handle stays after the cursor leaves the model (ms), so
 *  the dot can be reached. */
const LINGER_MS = 700
/** Two presses on the dot this close together: a double-click (ms). */
const DOUBLE_MS = 350
const ACCENT = '#3d7fd9'

type Pt = { x: number; y: number }

let shown: string | null = null
let linger = 0
let cursor: Pt | null = null
let hot = false
let drag: { key: string; dk: string; x0: number; y0: number; h0: number; up: Pt; moved: boolean; side: boolean } | null = null
let lastPress: { key: string; t: number } | null = null
let eatClick = false
let raf = 0

/** A model on its own card or tile, in the 3D view: not a person, a
 *  Viewer's model, or one in a 3D scene. */
function eligible(key: string | null | undefined): key is string {
  if (!key) return false
  // A model card's model alone in a scene card's section (Brian 2026-11-10).
  if (soloFloat(key) !== null) return true
  if (!(key.startsWith('card:') || key.startsWith('node:'))) return false
  // One attached to a 3D set but waiting on its own card has it too.
  return !standsIn(key)
}
/** How high model `key` floats, and setting it: a section's model keeps
 *  its own with the section; any other, with its card or tile. */
const floatOfKey = (key: string, dk: string) => soloFloat(key) ?? useModelScaleStore.getState().floatOf[dk] ?? 0
const setFloatOf = (key: string, dk: string, h: number | null) => {
  if (soloFloat(key) !== null) setSoloFloat(key, h); else useModelScaleStore.getState().setFloat(dk, h)
}
const live = () => isTilted(useTiltStore.getState()) && !useManip.getState().through && !!models.floatSpot
const sideOn = () => usePeek.getState().side

// ── Drawing ──
// Two layers: the mark and stem under the 3D view's canvas, so the model
// stands in front of them (drawn over it, the mark greyed the model's
// face); the dot over it, so it can always be seen and grabbed.
let svg: SVGSVGElement | null = null
let top: SVGSVGElement | null = null
let parts: { mark: SVGEllipseElement; stops: SVGStopElement[]; under: SVGLineElement; stem: SVGLineElement; pin: SVGCircleElement; dot: SVGCircleElement } | null = null
const NS = 'http://www.w3.org/2000/svg'
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag)
  for (const k in attrs) e.setAttribute(k, String(attrs[k]))
  parent.appendChild(e)
  return e
}
function ensureSvg(): boolean {
  const root = models.root
  if (!root) return false
  if (svg && svg.parentElement === root && top && top.parentElement === root) return true
  svg?.remove(); top?.remove()
  const layer = () => {
    const l = document.createElementNS(NS, 'svg')
    l.setAttribute('data-float-handle', '')
    Object.assign(l.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none', display: 'none' })
    return l
  }
  svg = layer(); top = layer()
  const defs = el('defs', {}, svg)
  const grad = el('radialGradient', { id: 'vb-float-mark' }, defs)
  const stops = [0, 0.5, 1].map(o => el('stop', { offset: o, 'stop-color': '#000' }, grad))
  const mark = el('ellipse', { cx: 0, cy: 0, rx: 1, ry: 1, fill: 'url(#vb-float-mark)' }, svg)
  const under = el('line', { stroke: 'rgba(0,0,0,0.55)', 'stroke-width': 3, 'stroke-linecap': 'round' }, svg)
  const stem = el('line', { stroke: '#fff', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, svg)
  const pin = el('circle', { r: 2, fill: '#fff', stroke: 'rgba(0,0,0,0.55)', 'stroke-width': 1 }, svg)
  const dot = el('circle', { r: DOT_R, 'stroke-width': 2 }, top)
  parts = { mark, stops, under, stem, pin, dot }
  root.prepend(svg)
  root.appendChild(top)
  return true
}
function hide() {
  if (svg) svg.style.display = 'none'
  if (top) top.style.display = 'none'
  if (hot) { hot = false; document.documentElement.style.cursor = '' }
}

const near = (a: Pt | null, b: Pt) => !!a && Math.hypot(a.x - b.x, a.y - b.y) <= HIT_R

function draw() {
  raf = 0
  const now = performance.now()
  if (!live()) { shown = null; hide(); return }
  let key: string | null = null
  if (drag) key = drag.key
  else {
    const h = modelKey(models.hovered)
    if (eligible(h)) { key = h; linger = now + LINGER_MS }
    else if (shown && (now < linger || (cursor && (() => { const s = models.floatSpot!(shown!); return !!s && near(cursor, s.foot) })()) || overQuarterRow())) key = shown
  }
  shown = key
  const s = key ? models.floatSpot!(key) : null
  if (!key || !s || !ensureSvg() || !parts) { hide(); if (key) raf = requestAnimationFrame(draw); return }
  const r0 = models.root!.getBoundingClientRect()
  const at = (p: Pt) => ({ x: p.x - r0.left, y: p.y - r0.top })
  const f = at(s.foot), g = at(s.ground)
  // How high it floats, against its footprint: the mark under it shrinks
  // and softens as it lifts.
  const upLen = Math.hypot(s.up.x, s.up.y)
  const lift = upLen > 1e-6 ? Math.hypot(f.x - g.x, f.y - g.y) / upLen : 0
  const t = Math.min(1, lift / Math.max(1, s.r * 3))
  const R = Math.max(2, s.r * (1 - 0.45 * t))
  const P = parts
  P.mark.setAttribute('transform', `matrix(${s.ax.x * R} ${s.ax.y * R} ${s.ay.x * R} ${s.ay.y * R} ${g.x} ${g.y})`)
  const dark = 0.38 * (1 - 0.6 * t)
  P.stops[0].setAttribute('stop-opacity', String(dark))
  P.stops[1].setAttribute('offset', String(0.5 * (1 - t)))
  P.stops[1].setAttribute('stop-opacity', String(dark * (0.85 - 0.35 * t)))
  P.stops[2].setAttribute('stop-opacity', '0')
  for (const l of [P.under, P.stem]) { l.setAttribute('x1', String(g.x)); l.setAttribute('y1', String(g.y)); l.setAttribute('x2', String(f.x)); l.setAttribute('y2', String(f.y)) }
  P.pin.setAttribute('cx', String(g.x)); P.pin.setAttribute('cy', String(g.y))
  P.dot.setAttribute('cx', String(f.x)); P.dot.setAttribute('cy', String(f.y))
  // Lit while pointed at or held; it never changes size.
  const on = !!drag || near(cursor, s.foot)
  P.dot.setAttribute('fill', on ? ACCENT : '#fff')
  P.dot.setAttribute('stroke', on ? '#fff' : ACCENT)
  svg!.style.display = ''
  top!.style.display = ''
  if (on !== hot) { hot = on; document.documentElement.style.cursor = on ? 'ns-resize' : '' }
  raf = requestAnimationFrame(draw)
}
const wake = () => { if (!raf) raf = requestAnimationFrame(draw) }

// ── Input ──
function onDown(e: PointerEvent) {
  if (!e.isTrusted || e.button !== 0 || e.altKey || !live()) return
  // The model under the cursor, if the handle has not drawn yet.
  if (!shown) { const h = modelKey(models.hovered); if (eligible(h)) shown = h }
  if (!shown) return
  const s = models.floatSpot!(shown)
  if (!s || !near({ x: e.clientX, y: e.clientY }, s.foot)) return
  e.preventDefault(); e.stopImmediatePropagation()
  eatClick = true
  const dk = dataKey(shown)
  const now = performance.now()
  // Double-click: back sitting on its card.
  if (lastPress && lastPress.key === shown && now - lastPress.t < DOUBLE_MS) {
    lastPress = null
    if (sideOn()) {
      if (useModelScaleStore.getState().sideFloatOf[dk] !== undefined) { useUndoCoordinator.getState().checkpoint(); useModelScaleStore.getState().setSideFloat(dk, null) }
    } else if (floatOfKey(shown, dk)) { useUndoCoordinator.getState().checkpoint(); setFloatOf(shown, dk, null) }
    return
  }
  lastPress = { key: shown, t: now }
  // The screen step of one canvas unit up, at the press. Looking straight
  // down it is nothing: then up the screen lifts it.
  const z = useCanvasStore.getState().zoom || 1
  let up = { x: s.up.x * z, y: s.up.y * z }
  if (Math.hypot(up.x, up.y) < 0.05) up = { x: 0, y: -0.5 * z }
  // (In the side view: from where it is now, off its card.)
  const upLen = Math.hypot(s.up.x, s.up.y)
  const side = sideOn()
  const h0 = side ? (upLen > 1e-6 ? Math.hypot(s.foot.x - s.ground.x, s.foot.y - s.ground.y) / upLen / z : 0) : floatOfKey(shown, dk)
  drag = { key: shown, dk, x0: e.clientX, y0: e.clientY, h0, up, moved: false, side }
  wake()
}

function onMove(e: PointerEvent) {
  cursor = { x: e.clientX, y: e.clientY }
  wake()
  if (!drag) return
  e.preventDefault(); e.stopImmediatePropagation()
  const mx = e.clientX - drag.x0, my = e.clientY - drag.y0
  if (!drag.moved) {
    if (Math.hypot(mx, my) < 3) return
    drag.moved = true
    lastPress = null
    useUndoCoordinator.getState().checkpoint()
  }
  // Along the stem: the model follows the cursor up or down.
  const u = drag.up
  const h = Math.max(0, drag.h0 + (mx * u.x + my * u.y) / (u.x * u.x + u.y * u.y))
  if (drag.side) useModelScaleStore.getState().setSideFloat(drag.dk, Math.round(h * 100) / 100)
  else setFloatOf(drag.key, drag.dk, h > 0.01 ? Math.round(h * 100) / 100 : null)
}

function onUp(e: PointerEvent) {
  if (!drag) return
  e.preventDefault(); e.stopImmediatePropagation()
  drag = null
  linger = performance.now() + LINGER_MS
  wake()
}

function onClick(e: MouseEvent) {
  if (!eatClick) return
  eatClick = false
  e.preventDefault(); e.stopImmediatePropagation()
}
function onDbl(e: MouseEvent) {
  if (!shown || !live()) return
  const s = models.floatSpot!(shown)
  if (s && near({ x: e.clientX, y: e.clientY }, s.foot)) { e.preventDefault(); e.stopImmediatePropagation() }
}

type Handlers = { onDown: typeof onDown; onMove: typeof onMove; onUp: typeof onUp; onClick: typeof onClick; onDbl: typeof onDbl }
const w = (typeof window !== 'undefined' ? window : undefined) as (Window & { __floatHandle?: Handlers }) | undefined
if (w) {
  const first = !w.__floatHandle
  w.__floatHandle = { onDown, onMove, onUp, onClick, onDbl }
  if (first) {
    const h = () => w.__floatHandle!
    w.addEventListener('pointerdown', e => h().onDown(e), true)
    w.addEventListener('pointermove', e => h().onMove(e), true)
    w.addEventListener('pointerup', e => h().onUp(e), true)
    w.addEventListener('pointercancel', e => h().onUp(e), true)
    w.addEventListener('click', e => h().onClick(e), true)
    w.addEventListener('dblclick', e => h().onDbl(e), true)
  }
}
