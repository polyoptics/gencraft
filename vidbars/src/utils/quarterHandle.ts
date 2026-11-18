// quarterHandle.ts — the row of buttons that squares a model up, in the 3D
// view (Brian 2026-11-18: "shift by 90° and flip the model around the
// axis ... when we see the model above the card, on the card face, we
// could have some flip buttons"). Hover a model standing on its card: a
// small row under its foot, below the lift handle's dot. Turn left, turn
// right (a quarter about upright), tip forward, tip sideways (a quarter
// over), mirror, and back as it came. Each is its own button; none moves,
// resizes or changes its picture: Mirror is lit while the model is
// mirrored, and "as it came" is dim while there is nothing to take back.
// What they set is kept with the model's file (three/modelQuarter), so it
// shows on every card, deck, 3D set and Viewer the model is on, and in the
// flat pictures of it. Shown where the lift handle is (utils/floatHandle):
// a model on its own card or tile, or alone in a scene card's section; a
// deck's row acts on the model on its face. Shapes made here (a cube, a
// camera) have none: every card of one shares it.
// Installed once when this module loads, ahead of the canvas's own
// listeners, so a press on a button reaches nothing else.

import { isTilted, useTiltStore, useModelScaleStore } from '../store/tiltStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { useManip } from '../store/manipStore'
import { models, modelKey, soloFloat } from '../components/Canvas/tilt/TiltModels'
import { standsIn } from './area3dScene'
import { quarterable, stepQuarter, type QuarterStep } from '../three/modelQuarter'

type Act = QuarterStep | 'reset'
const BUTTONS: { act: Act; label: string; icon: string; dot?: [number, number]; solid?: string }[] = [
  // A turntable's near edge, its arrow going round to the left / the right.
  { act: 'left', label: 'Turn left', icon: 'M 6.5 -1 A 6.5 3.2 0 0 1 -6.5 -1 M -6.5 -1 l -0.4 4 M -6.5 -1 l 3.8 1.4 M 0 -7 V -3' },
  { act: 'right', label: 'Turn right', icon: 'M -6.5 -1 A 6.5 3.2 0 0 0 6.5 -1 M 6.5 -1 l 0.4 4 M 6.5 -1 l -3.8 1.4 M 0 -7 V -3' },
  // Over the top towards you; over to the side.
  { act: 'forward', label: 'Tip forward', icon: 'M 1 -6.5 A 3.2 6.5 0 0 0 1 6.5 M 1 6.5 l -4 0.4 M 1 6.5 l -1.4 -3.8 M 3 0 H 7' },
  { act: 'side', label: 'Tip sideways', icon: 'M -5 -5.5 A 10 10 0 0 1 5 4.5 M 5 4.5 l -4 -0.6 M 5 4.5 l 0.6 -4', dot: [-5, 4.5] },
  { act: 'mirror', label: 'Mirror', icon: 'M 0 -7 V 7 M 2.5 -4.5 L 7 4.5 H 2.5 Z', solid: 'M -2.5 -4.5 L -7 4.5 H -2.5 Z' },
  { act: 'reset', label: 'As it came', icon: 'M -4.2 -3.6 A 5.5 5.5 0 1 1 -5.4 1.2 M -4.2 -3.6 l -0.3 -3.6 M -4.2 -3.6 l 3.6 -0.2' },
]
/** A button's radius, the gap between two, the wider gap before "as it
 *  came", and how far under the model's foot mark the row sits (px). */
const R = 11
const GAP = 5
const GAP_RESET = 11
const DROP = 32
/** How long the row stays after the cursor leaves the model (ms), so it
 *  can be reached. */
const LINGER_MS = 700
const ACCENT = '#3d7fd9'
const DARK = 'rgba(22,24,32,0.92)'

type Pt = { x: number; y: number }

let shown: string | null = null
let linger = 0
let cursor: Pt | null = null
/** The button under the cursor (its index), or -1. */
let over = -1
let held = false
let eatClick = false
let raf = 0
/** Where the row's buttons are now, client px. */
let spots: Pt[] = []

/** The buttons' middles along the row, from its own middle. */
const XS = (() => {
  const xs: number[] = []
  let x = 0
  BUTTONS.forEach((b, i) => { if (i) x += 2 * R + (b.act === 'reset' ? GAP_RESET : GAP); xs.push(x) })
  return xs.map(v => v - x / 2)
})()

const urlOf = (key: string) => models.info?.(key)?.url ?? null
/** A model on its own card or tile (or alone in a scene card's section),
 *  from a file: where the lift handle shows. */
function eligible(key: string | null | undefined): key is string {
  if (!key) return false
  if (soloFloat(key) === null && (!(key.startsWith('card:') || key.startsWith('node:')) || standsIn(key))) return false
  return quarterable(urlOf(key))
}
const live = () => isTilted(useTiltStore.getState()) && !useManip.getState().through && !!models.floatSpot

/** Whether the cursor is on the row (or just round it): the lift handle
 *  stays with it then. */
export function overQuarterRow(): boolean {
  if (!shown || !cursor || !spots.length) return false
  const a = spots[0], b = spots[spots.length - 1]
  return cursor.x >= a.x - R - 8 && cursor.x <= b.x + R + 8 && cursor.y >= a.y - R - 14 && cursor.y <= a.y + R + 8
}

// ── Drawing ──
let svg: SVGSVGElement | null = null
let parts: { g: SVGGElement; disc: SVGCircleElement; glyph: SVGPathElement; solid: SVGPathElement | null; pip: SVGCircleElement | null }[] = []
let tip: { box: SVGRectElement; text: SVGTextElement } | null = null
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
  if (svg && svg.parentElement === root) return true
  svg?.remove()
  svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('data-quarter-handle', '')
  Object.assign(svg.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none', display: 'none' })
  parts = BUTTONS.map(b => {
    const g = el('g', {}, svg!)
    const disc = el('circle', { r: R, 'stroke-width': 1.5 }, g)
    const glyph = el('path', { d: b.icon, fill: 'none', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g)
    const solid = b.solid ? el('path', { d: b.solid, stroke: 'none' }, g) : null
    const pip = b.dot ? el('circle', { cx: b.dot[0], cy: b.dot[1], r: 1.6, stroke: 'none' }, g) : null
    return { g, disc, glyph, solid, pip }
  })
  const tg = el('g', {}, svg)
  const box = el('rect', { height: 18, rx: 4, fill: DARK }, tg)
  const text = el('text', { 'font-size': 11, 'font-family': 'system-ui, sans-serif', fill: '#fff', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, tg)
  tip = { box, text }
  root.appendChild(svg)
  return true
}
function hide() {
  if (svg) svg.style.display = 'none'
  spots = []
  if (over >= 0) { over = -1; document.documentElement.style.cursor = '' }
}

function draw() {
  raf = 0
  const now = performance.now()
  if (!live()) { shown = null; hide(); return }
  let key: string | null = shown
  // (While a button of the mouse is down, it stays as it is: a drag of the
  // lift handle's dot, or of anything else, never takes the row away.)
  if (!held) {
    const h = modelKey(models.hovered)
    if (eligible(h)) { key = h; linger = now + LINGER_MS }
    else if (!(shown && (now < linger || overQuarterRow()))) key = null
  }
  shown = key
  const s = key ? models.floatSpot!(key) : null
  const url = key ? urlOf(key) : null
  if (!key || !s || !url || !ensureSvg() || !tip) { hide(); if (key) raf = requestAnimationFrame(draw); return }
  const r0 = models.root!.getBoundingClientRect()
  // Under the mark on its card, not under the model: it stays put as the
  // model is lifted, turned or tipped.
  const cx = s.ground.x, cy = s.ground.y + DROP
  spots = XS.map(x => ({ x: cx + x, y: cy }))
  const hit = cursor ? spots.findIndex(p => Math.hypot(cursor!.x - p.x, cursor!.y - p.y) <= R + 1) : -1
  const q = useModelScaleStore.getState().quarterOf[url]
  BUTTONS.forEach((b, i) => {
    const P = parts[i]
    P.g.setAttribute('transform', `translate(${spots[i].x - r0.left} ${spots[i].y - r0.top})`)
    // Lit: pointed at, or (Mirror) on. Dim: nothing for it to do.
    const lit = i === hit || (b.act === 'mirror' && !!q?.mirror)
    const dim = b.act === 'reset' && !q
    const ink = lit ? '#fff' : ACCENT
    P.disc.setAttribute('fill', lit ? ACCENT : DARK)
    P.disc.setAttribute('stroke', i === hit ? '#fff' : ACCENT)
    P.glyph.setAttribute('stroke', lit ? '#fff' : '#e8ecf4')
    P.solid?.setAttribute('fill', lit ? '#fff' : '#e8ecf4')
    P.pip?.setAttribute('fill', ink)
    P.g.setAttribute('opacity', dim ? '0.4' : '1')
  })
  // What the one pointed at does, said under it.
  if (hit >= 0) {
    const label = BUTTONS[hit].label
    if (tip.text.textContent !== label) tip.text.textContent = label
    const w = label.length * 6.2 + 14
    const tx = spots[hit].x - r0.left, ty = spots[hit].y - r0.top + R + 13
    tip.box.setAttribute('x', String(tx - w / 2)); tip.box.setAttribute('y', String(ty - 9)); tip.box.setAttribute('width', String(w))
    tip.text.setAttribute('x', String(tx)); tip.text.setAttribute('y', String(ty))
  }
  tip.box.parentElement!.setAttribute('display', hit >= 0 ? '' : 'none')
  svg!.style.display = ''
  if (hit !== over) {
    if ((hit >= 0) !== (over >= 0)) document.documentElement.style.cursor = hit >= 0 ? 'pointer' : ''
    over = hit
  }
  raf = requestAnimationFrame(draw)
}
const wake = () => { if (!raf) raf = requestAnimationFrame(draw) }

// ── Input ──
function press(key: string, act: Act) {
  const url = urlOf(key)
  if (!quarterable(url)) return
  const ms = useModelScaleStore.getState()
  const now = ms.quarterOf[url]
  if (act === 'reset') {
    if (now) { useUndoCoordinator.getState().checkpoint(); ms.setQuarter(url, null) }
    return
  }
  useUndoCoordinator.getState().checkpoint()
  ms.setQuarter(url, stepQuarter(now, act))
}

function onDown(e: PointerEvent) {
  held = true
  if (!e.isTrusted || e.button !== 0 || e.altKey || !live() || !shown || !spots.length) return
  const i = spots.findIndex(p => Math.hypot(e.clientX - p.x, e.clientY - p.y) <= R + 1)
  if (i < 0) return
  e.preventDefault(); e.stopImmediatePropagation()
  eatClick = true
  press(shown, BUTTONS[i].act)
  linger = performance.now() + LINGER_MS
  wake()
}
function onMove(e: PointerEvent) {
  cursor = { x: e.clientX, y: e.clientY }
  if (!e.buttons) held = false
  wake()
}
function onUp(e: PointerEvent) {
  held = false
  if (eatClick) { e.preventDefault(); e.stopImmediatePropagation() }
  wake()
}
function onClick(e: MouseEvent) {
  if (!eatClick) return
  eatClick = false
  e.preventDefault(); e.stopImmediatePropagation()
}
function onDbl(e: MouseEvent) {
  // Two quick presses are two presses (a half turn), and nothing else's
  // double-click.
  if (!shown || !live() || !spots.some(p => Math.hypot(e.clientX - p.x, e.clientY - p.y) <= R + 1)) return
  e.preventDefault(); e.stopImmediatePropagation()
}

type Handlers = { onDown: typeof onDown; onMove: typeof onMove; onUp: typeof onUp; onClick: typeof onClick; onDbl: typeof onDbl }
const w = (typeof window !== 'undefined' ? window : undefined) as (Window & { __quarterHandle?: Handlers }) | undefined
if (w) {
  const first = !w.__quarterHandle
  w.__quarterHandle = { onDown, onMove, onUp, onClick, onDbl }
  if (first) {
    const h = () => w.__quarterHandle!
    w.addEventListener('pointerdown', e => h().onDown(e), true)
    w.addEventListener('pointermove', e => h().onMove(e), true)
    w.addEventListener('pointerup', e => h().onUp(e), true)
    w.addEventListener('pointercancel', e => h().onUp(e), true)
    w.addEventListener('click', e => h().onClick(e), true)
    w.addEventListener('dblclick', e => h().onDbl(e), true)
  }
}
