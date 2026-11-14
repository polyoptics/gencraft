// The state workspace (Brian 2026-11-14): a place on the canvas, like a 3D
// set, where states are worked out by eye and by hand instead of read as
// rows. Everything in it is a node with inputs and outputs, wired by
// dragging ("99.99999% of everything just by drag and drop").
//
// Nodes:
//   card      a card or a deck dragged in (the card goes back where it was
//             picked up: the node is a link, never the card itself). What it
//             stands for is Brian's to decide ("both, mixed freely"): a
//             thing, a state of a thing, a whole deck.
//   blank     the same with no card yet.
//   event     a small node between others: something that happens. Fired
//             through its input, it fires what its output is wired to, if
//             every card wired to its "only if" input is lit. An Event card
//             dragged in makes one hooked to that card.
//   any       stands for every node: an arrow out of it is a change that
//             can be made from anywhere.
//   timeline  a storyline dragged in by its handle: its points in story
//             order, each with an output, and its own time marker.
//
// Wires, by what they join:
//   card out -> card in      a CHANGE: the second can follow the first.
//                            Drawn as an arrow with a knob at its middle.
//                            (With `plain`: any other relationship, no arrow.)
//   anything -> a change's knob   that change is made then.
//   anything -> card in      that card is lit then.
//   anything -> event in     that event fires then.
//   card out -> event "only if"   the event only goes through while that
//                            card is lit.
// "Then" is: a timeline's point when the marker passes it, an event when it
// fires, a card when it becomes lit.
//
// A card node can be lit as "now". Among nodes joined by changes only one is
// lit at a time, so each joined-up cluster is one machine and a workspace can
// hold several. A machine can have a start: the node lit before anything has
// happened.
//
// Where a lit node's card is in a state's deck on a State card
// (utils/stateCard), that State card picks the state, so its output deck
// reforms as it always has. An event hooked to a card that carries State
// changes makes them when it fires.
//
// The data is the node's (FreeNodeData.stateSpace); the picture and the
// hands are components/StateSpace/StateSpaceBody.

import { create } from 'zustand'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { isTilted, unprojectTilt, useTiltStore } from '../store/tiltStore'
import { applyState, deckCards, markChange } from './stateCard'
import { rootOf } from './storyline'

export type SpaceKind = 'card' | 'blank' | 'event' | 'any' | 'timeline'

export interface SpaceItem {
  id: string
  /** Its middle, in the workspace's own units. */
  x: number
  y: number
  kind: SpaceKind
  /** card, event: the card it is linked to (a deck by its front card). */
  card?: string
  /** timeline: the storyline's node id. */
  line?: string
  /** Its own name; without one a linked node shows its card's. */
  name?: string
  note?: string
  /** Lit: this is how things are now. */
  now?: boolean
  /** Lit before anything has happened (one per machine). */
  start?: boolean
}

export type InPort = 'in' | 'if' | 'knob'

export interface SpaceWire {
  id: string
  /** From: a node, and for a timeline which point (`pt:<dot id>`). */
  a: string
  ap?: string
  /** To: a node's input ('in', or an event's 'if'), or with 'knob' a change (a wire's id). */
  b: string
  bp?: InPort
  name?: string
  note?: string
  /** card -> card only: a plain line (a relationship), not a change. */
  plain?: boolean
}

export interface StateSpaceData {
  items: SpaceItem[]
  wires: SpaceWire[]
  /** From before timelines were nodes (1754c0d): read once by normalizeSpace. */
  lines?: string[]
  ties?: { id: string; line: string; dot: string; wire?: string; item?: string }[]
}

export const emptyStateSpace = (): StateSpaceData => ({ items: [], wires: [] })

// ── Sizes ──
export const ICON = 104
export const ANY_R = 30
export const EVENT_W = 128
export const EVENT_H = 44
export const TL_STEP = 88
export const TL_H = 78
/** How near a port a wire's end snaps to it. */
export const PORT_SNAP = 24
/** Nodes keep to this grid as they are moved (Ctrl: freely). */
export const SPACE_GRID = 10

const uid = () => crypto.randomUUID().slice(0, 8)

// ── Reading ──

const normalized = new WeakMap<StateSpaceData, StateSpaceData>()
/** A workspace as it is read: one from before timelines were nodes has its
 *  strips made into timeline nodes and its ties into wires. */
export function normalizeSpace(d: StateSpaceData): StateSpaceData {
  if (!d.lines?.length && !d.ties?.length) return d
  const hit = normalized.get(d)
  if (hit) return hit
  const tl = new Map((d.lines ?? []).map((line, i) => [line, { id: 'tl' + i + line.slice(0, 5), kind: 'timeline' as const, line, x: 60 + lineSize(line).w / 2, y: 470 - i * (TL_H + 20) }]))
  const out: StateSpaceData = {
    items: [...d.items, ...tl.values()],
    wires: [...d.wires, ...(d.ties ?? []).flatMap(t => {
      const node = tl.get(t.line)
      const b = t.wire ?? t.item
      return node && b ? [{ id: t.id, a: node.id, ap: 'pt:' + t.dot, b, bp: (t.wire ? 'knob' : 'in') as InPort }] : []
    })],
  }
  // Each machine it had starts where its first change starts from, which is
  // what was lit before the first tied point then.
  for (const w of d.wires) {
    if (w.plain || [...machineOf(out, w.a)].some(m => out.items.find(i => i.id === m)?.start)) continue
    out.items = out.items.map(i => i.id === w.a && isState(i) ? { ...i, start: true } : i)
  }
  normalized.set(d, out)
  return out
}

export function spaceOf(nodeId: string): StateSpaceData | null {
  const n = useFreeNodeStore.getState().nodes[nodeId]
  return n?.type === 'stateSpace' ? normalizeSpace(n.stateSpace ?? emptyStateSpace()) : null
}

/** Change a workspace. One undo step unless the caller already took one. */
export function editSpace(nodeId: string, f: (d: StateSpaceData) => StateSpaceData, undo = true): void {
  const d = spaceOf(nodeId)
  if (!d) return
  const next = f(d)
  if (next === d) return
  if (undo) useUndoCoordinator.getState().checkpoint()
  useFreeNodeStore.getState().updateFreeNode(nodeId, { stateSpace: next })
}

const itemOf = (d: StateSpaceData, id: string | undefined) => d.items.find(i => i.id === id)
const wireOf = (d: StateSpaceData, id: string | undefined) => d.wires.find(w => w.id === id)
const isState = (i: SpaceItem | undefined) => i?.kind === 'card' || i?.kind === 'blank'

/** What a wire is: a change (or, plain, a link) between two cards, else a
 *  signal: "when this, then that". */
export function wireKind(d: StateSpaceData, w: SpaceWire): 'change' | 'link' | 'signal' {
  const a = itemOf(d, w.a)
  if ((w.bp ?? 'in') === 'in' && !w.ap && (isState(a) || a?.kind === 'any') && isState(itemOf(d, w.b))) return w.plain ? 'link' : 'change'
  return 'signal'
}

// ── Timelines ──

export interface LineClock {
  title: string
  /** The marker's range and where it is, along the base from its start. */
  lo: number
  hi: number
  at: number
  /** Its dots in story order: where each is along the base, and along the
   *  node (0..1, evenly spaced). */
  dots: { id: string; title: string; at: number; frac: number }[]
  toFrac: (v: number) => number
  toValue: (f: number) => number
}

/** A storyline as a timeline node reads it, or null when it is gone or empty. */
export function lineClock(lineId: string | undefined): LineClock | null {
  const n = lineId ? useFreeNodeStore.getState().nodes[lineId] : undefined
  const d = n?.type === 'storyline' ? n.storyline : undefined
  const start = d?.dots.find(p => p.id === rootOf(d))
  if (!d || !start) return null
  const xs = (d.base ?? []).map(b => d.dots.find(p => p.id === b)?.x).filter((x): x is number => x !== undefined)
  const len = xs.length ? Math.max(...xs) - start.x : 0
  const lead = Math.max(200, len * 0.04)   // StorylineLayer markerLead
  const lo = -lead, hi = len + lead
  const at = Math.max(lo, Math.min(hi, d.marker ?? lo))
  const sorted = d.dots.map((p, i) => ({ id: p.id, title: p.title?.trim() || `Point ${i + 1}`, at: Math.max(lo, Math.min(hi, p.x - start.x)) })).sort((a, b) => a.at - b.at)
  // Evenly spaced in story order, straight between (as the world clock's bar).
  const pts: [number, number][] = [[lo, 0], ...sorted.map((p, i): [number, number] => [p.at, (i + 1) / (sorted.length + 1)]), [hi, 1]]
  const toFrac = (v: number) => {
    for (let i = 1; i < pts.length; i++) {
      const [v0, f0] = pts[i - 1], [v1, f1] = pts[i]
      if (v <= v1 || i === pts.length - 1) return v1 === v0 ? f1 : f0 + (f1 - f0) * Math.max(0, Math.min(1, (v - v0) / (v1 - v0)))
    }
    return 0
  }
  const toValue = (f: number) => {
    for (let i = 1; i < pts.length; i++) {
      const [v0, f0] = pts[i - 1], [v1, f1] = pts[i]
      if (f <= f1 || i === pts.length - 1) return v0 + (v1 - v0) * Math.max(0, Math.min(1, (f - f0) / (f1 - f0)))
    }
    return lo
  }
  return { title: d.title?.trim() || n!.label || 'Storyline', lo, hi, at, toFrac, toValue, dots: sorted.map((p, i) => ({ ...p, frac: (i + 1) / (sorted.length + 1) })) }
}

/** A timeline node's size: a step per point. */
function lineSize(lineId: string | undefined): { w: number; h: number } {
  const n = lineClock(lineId)?.dots.length ?? 0
  return { w: (Math.max(1, n) + 1) * TL_STEP, h: TL_H }
}

// ── Geometry (shared by the picture and the hands) ──

export function itemSize(i: SpaceItem): { w: number; h: number } {
  if (i.kind === 'any') return { w: ANY_R * 2, h: ANY_R * 2 }
  if (i.kind === 'event') return { w: EVENT_W, h: EVENT_H }
  if (i.kind === 'timeline') return lineSize(i.line)
  return { w: ICON, h: ICON }
}

export interface PortRef { node?: string; wire?: string; port: string }
export interface PortSpot { x: number; y: number; dx: number; dy: number }

/** A node's ports: which, and where (with the way a wire leaves or arrives). */
export function itemPorts(i: SpaceItem): { port: string; out: boolean; spot: PortSpot }[] {
  const { w, h } = itemSize(i)
  const L = { x: i.x - w / 2, y: i.y, dx: -1, dy: 0 }, R = { x: i.x + w / 2, y: i.y, dx: 1, dy: 0 }
  if (i.kind === 'any') return [{ port: 'out', out: true, spot: R }]
  if (i.kind === 'event') return [{ port: 'in', out: false, spot: L }, { port: 'out', out: true, spot: R }, { port: 'if', out: false, spot: { x: i.x, y: i.y - h / 2, dx: 0, dy: -1 } }]
  if (i.kind === 'timeline') {
    const c = lineClock(i.line)
    return (c?.dots ?? []).map(p => ({ port: 'pt:' + p.id, out: true, spot: { x: i.x - w / 2 + p.frac * w, y: i.y + h / 2, dx: 0, dy: 1 } }))
  }
  return [{ port: 'in', out: false, spot: L }, { port: 'out', out: true, spot: R }]
}

export interface WireGeom { x1: number; y1: number; c1x: number; c1y: number; c2x: number; c2y: number; x2: number; y2: number; mx: number; my: number; path: string }

function curve(p: PortSpot, q: PortSpot): WireGeom {
  const k = Math.max(36, Math.min(130, Math.hypot(q.x - p.x, q.y - p.y) * 0.45))
  const c1x = p.x + p.dx * k, c1y = p.y + p.dy * k, c2x = q.x + q.dx * k, c2y = q.y + q.dy * k
  const mx = (p.x + 3 * c1x + 3 * c2x + q.x) / 8, my = (p.y + 3 * c1y + 3 * c2y + q.y) / 8
  return { x1: p.x, y1: p.y, c1x, c1y, c2x, c2y, x2: q.x, y2: q.y, mx, my, path: `M${p.x} ${p.y}C${c1x} ${c1y} ${c2x} ${c2y} ${q.x} ${q.y}` }
}

/** A loose end: a wire being drawn to (x, y) arrives from wherever it came. */
export function looseCurve(p: PortSpot, x: number, y: number, fromInput = false): WireGeom {
  const q = { x, y, dx: fromInput ? 1 : -p.dx * 0.5, dy: fromInput ? 0 : -p.dy * 0.5 }
  return fromInput ? curve(q, p) : curve(p, q)
}

export function portSpot(d: StateSpaceData, ref: PortRef): PortSpot | null {
  if (ref.wire) {
    const g = wireGeom(d, wireOf(d, ref.wire))
    return g ? { x: g.mx, y: g.my, dx: 0, dy: 1 } : null
  }
  const i = itemOf(d, ref.node)
  return i ? itemPorts(i).find(p => p.port === ref.port)?.spot ?? null : null
}

/** Where a wire leaves an output for a place at height `y`: a timeline's
 *  point has an output on its top edge and one on its bottom, and the wire
 *  takes the one on the side it is going to. */
export function outSpot(d: StateSpaceData, ref: PortRef, y: number): PortSpot | null {
  const p = portSpot(d, ref)
  const i = itemOf(d, ref.node)
  if (!p || i?.kind !== 'timeline' || y >= i.y) return p
  return { x: p.x, y: i.y - TL_H / 2, dx: 0, dy: -1 }
}

export function wireGeom(d: StateSpaceData, w: SpaceWire | undefined): WireGeom | null {
  if (!w) return null
  const from = { node: w.a, port: w.ap ?? 'out' }
  let p = portSpot(d, from)
  if (!p) return null
  if (w.bp === 'knob') {
    const g = wireGeom(d, d.wires.find(x => x.id === w.b && x.bp !== 'knob'))
    if (!g) return null
    p = outSpot(d, from, g.my) ?? p
    // It comes to the knob from the side it is on.
    return curve(p, { x: g.mx, y: g.my + (p.y >= g.my ? 7 : -7), dx: 0, dy: p.y >= g.my ? 1 : -1 })
  }
  const q = portSpot(d, { node: w.b, port: w.bp ?? 'in' })
  return q ? curve(outSpot(d, from, q.y) ?? p, q) : null
}

/** How far (x, y) is from a wire. */
export function wireDist(g: WireGeom, x: number, y: number): number {
  let best = Infinity, px = g.x1, py = g.y1
  for (let n = 1; n <= 20; n++) {
    const t = n / 20, u = 1 - t
    const qx = u * u * u * g.x1 + 3 * u * u * t * g.c1x + 3 * u * t * t * g.c2x + t * t * t * g.x2
    const qy = u * u * u * g.y1 + 3 * u * u * t * g.c1y + 3 * u * t * t * g.c2y + t * t * t * g.y2
    const dx = qx - px, dy = qy - py
    const s = Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(x - px - dx * s, y - py - dy * s))
    px = qx; py = qy
  }
  return best
}

// ── What can be wired to what ──

/** Can a wire go from output `from` to input `to`? */
export function canWire(d: StateSpaceData, from: PortRef, to: PortRef): boolean {
  const a = itemOf(d, from.node)
  if (!a || !itemPorts(a).some(p => p.out && p.port === from.port)) return false
  if (to.wire) {
    const w = wireOf(d, to.wire)
    return !!w && wireKind(d, w) === 'change' && a.kind !== 'any'
  }
  const b = itemOf(d, to.node)
  if (!b || b.id === a.id) return false
  if (isState(b)) return to.port === 'in'
  if (b.kind !== 'event' || a.kind === 'any') return false
  if (to.port === 'if') return isState(a)
  return to.port === 'in'
}

/** Every input a wire from `from` could go to, with where it is. */
export function wireTargets(d: StateSpaceData, from: PortRef): { ref: PortRef; spot: PortSpot }[] {
  const out: { ref: PortRef; spot: PortSpot }[] = []
  for (const i of d.items) for (const p of itemPorts(i)) {
    const ref = { node: i.id, port: p.port }
    if (!p.out && canWire(d, from, ref)) out.push({ ref, spot: p.spot })
  }
  for (const w of d.wires) {
    const ref = { wire: w.id, port: 'knob' }
    if (!canWire(d, from, ref)) continue
    const spot = portSpot(d, ref)
    if (spot) out.push({ ref, spot })
  }
  return out
}

/** Every output a wire into `to` could come from. */
export function wireSources(d: StateSpaceData, to: PortRef): { ref: PortRef; spot: PortSpot }[] {
  const out: { ref: PortRef; spot: PortSpot }[] = []
  for (const i of d.items) for (const p of itemPorts(i)) {
    const ref = { node: i.id, port: p.port }
    if (p.out && canWire(d, ref, to)) out.push({ ref, spot: p.spot })
  }
  return out
}

// ── Machines ──

/** The nodes joined to `itemId` by changes, itself included: one machine.
 *  An "any" node joins nothing together: it only points. */
export function machineOf(d: StateSpaceData, itemId: string): Set<string> {
  const out = new Set([itemId])
  if (!isState(itemOf(d, itemId))) return out
  let grew = true
  while (grew) {
    grew = false
    for (const w of d.wires) {
      if (wireKind(d, w) !== 'change' || !isState(itemOf(d, w.a))) continue
      if (out.has(w.a) !== out.has(w.b)) { out.add(w.a); out.add(w.b); grew = true }
    }
  }
  return out
}

// ── The engine ──

interface Run { lit: Set<string>; touched: Set<string>; fired: string[]; used: string[]; steps: number }

function runner(d: StateSpaceData, lit: Set<string>) {
  const r: Run = { lit, touched: new Set(), fired: [], used: [], steps: 0 }
  const machines = new Map<string, Set<string>>()
  const machine = (id: string) => { let m = machines.get(id); if (!m) { m = machineOf(d, id); for (const x of m) machines.set(x, m) } return m }
  const go = (w: SpaceWire) => {
    if (w.bp === 'if') return
    r.used.push(w.id)
    if (w.bp === 'knob') change(w.b)
    else if (itemOf(d, w.b)?.kind === 'event') fire(w.b)
    else light(w.b)
  }
  const signals = (from: string, port?: string) => {
    for (const w of d.wires) if (w.a === from && (port === undefined || w.ap === port) && wireKind(d, w) === 'signal') go(w)
  }
  /** Light a node: its machine's others go out, and what it is wired to follows. */
  const light = (id: string) => {
    if (++r.steps > 600 || !isState(itemOf(d, id))) return
    const m = machine(id)
    for (const x of m) r.touched.add(x)
    if (r.lit.has(id)) return
    for (const x of m) r.lit.delete(x)
    r.lit.add(id)
    signals(id)
  }
  /** Fire an event, if every card wired to its "only if" is lit. */
  const fire = (id: string) => {
    if (++r.steps > 600) return
    if (d.wires.some(w => w.b === id && w.bp === 'if' && !r.lit.has(w.a))) return
    r.fired.push(id)
    signals(id)
  }
  /** Make a change: only from where it starts (or from anywhere, or when
   *  nothing of that machine is lit yet). */
  const change = (wireId: string) => {
    const w = wireOf(d, wireId)
    if (!w || wireKind(d, w) !== 'change') return
    const from = itemOf(d, w.a)
    if (r.lit.has(w.b)) return
    if (from?.kind === 'any' || r.lit.has(w.a) || ![...machine(w.b)].some(x => r.lit.has(x))) { r.used.push(w.id); light(w.b) }
  }
  return { r, light, fire, change, point: (tl: string, dot: string) => signals(tl, 'pt:' + dot), machine }
}

/** The nodes a timeline can reach, through wires, events and changes. */
function driven(d: StateSpaceData): Set<string> {
  const out = new Set<string>()
  const seen = new Set<string>()
  const visit = (w: SpaceWire) => {
    if (seen.has(w.id)) return
    seen.add(w.id)
    const target = w.bp === 'knob' ? wireOf(d, w.b)?.b : w.bp === 'if' ? undefined : w.b
    const t = itemOf(d, target)
    if (!t) return
    if (t.kind === 'event') { for (const x of d.wires) if (x.a === t.id && wireKind(d, x) === 'signal') visit(x); return }
    for (const m of machineOf(d, t.id)) {
      if (out.has(m)) continue
      out.add(m)
      for (const x of d.wires) if (x.a === m && wireKind(d, x) === 'signal') visit(x)
    }
  }
  for (const w of d.wires) if (itemOf(d, w.a)?.kind === 'timeline') visit(w)
  return out
}

/** What has just happened in a workspace, for its picture to show: the wires
 *  something went along and the events that fired, stamped with when. */
export const useSpaceLive = create<Record<string, { stamp: number; wires: string[]; fired: string[] }>>(() => ({}))
function show(nodeId: string, wires: string[], fired: string[]): void {
  if (wires.length || fired.length) useSpaceLive.setState({ [nodeId]: { stamp: Date.now(), wires, fired } })
}
/** What the last replay of each workspace went along: the next one shows
 *  only what is new (the marker passing one more point). */
const lastRun = new Map<string, Set<string>>()

/** Write what is lit, and let the State cards follow. */
function settle(nodeId: string, d: StateSpaceData, lit: Set<string>, fired: string[], undo: boolean): void {
  const newly = d.items.filter(i => lit.has(i.id) && !i.now)
  if (newly.length || d.items.some(i => i.now && !lit.has(i.id))) {
    editSpace(nodeId, s => ({ ...s, items: s.items.map(i => lit.has(i.id) === !!i.now ? i : { ...i, now: lit.has(i.id) || undefined }) }), undo)
  }
  const groups = useBoardsStore.getState().groups
  // State cards whose state decks hold a newly lit node's card pick that state.
  for (const i of newly) {
    if (!i.card) continue
    for (const sc of groups) {
      const st = sc.stateCard?.states.find(s => s.deck && deckCards(groups, s.deck).includes(i.card!))
      if (st && sc.stateCard!.current !== st.id) applyState(sc.id, st.id)
    }
  }
  // An event hooked to a card that carries State changes makes them.
  for (const id of fired) {
    const card = groups.find(g => g.id === itemOf(d, id)?.card)
    for (const k of card?.stateChanges ?? []) {
      const hit = markChange(groups, k)
      if (hit?.change.to) applyState(hit.sc.id, hit.change.to)
    }
  }
}

/** Play the workspace's timelines from the beginning up to their markers:
 *  the machines they reach start from their start node and take every
 *  change up to now. The others stay as they are. No undo step of its own. */
export function replaySpace(nodeId: string): void {
  const d = spaceOf(nodeId)
  if (!d) return
  const reach = driven(d)
  if (!reach.size) return
  const lit = new Set(d.items.filter(i => reach.has(i.id) ? i.start : i.now).map(i => i.id))
  const run = runner(d, lit)
  for (const tl of d.items) {
    if (tl.kind !== 'timeline') continue
    const c = lineClock(tl.line)
    for (const p of c?.dots ?? []) if (p.at <= c!.at) run.point(tl.id, p.id)
  }
  const all = new Set([...run.r.used, ...run.r.fired])
  const was = lastRun.get(nodeId)
  lastRun.set(nodeId, all)
  if (was) show(nodeId, run.r.used.filter(x => !was.has(x)), run.r.fired.filter(x => !was.has(x)))
  following = true
  try { settle(nodeId, d, run.r.lit, run.r.fired, false) } finally { following = false }
}
/** Set while a workspace is making State cards follow it, so that their
 *  change is not read back as news (startStateSpaces). */
let following = false

/** Light a node by hand (or put it out). */
export function setNow(nodeId: string, itemId: string, on: boolean): void {
  const d = spaceOf(nodeId)
  const it = itemOf(d ?? emptyStateSpace(), itemId)
  if (!d || !isState(it) || !!it!.now === on) return
  const lit = new Set(d.items.filter(i => i.now).map(i => i.id))
  useUndoCoordinator.getState().checkpoint()
  if (!on) { lit.delete(itemId); settle(nodeId, d, lit, [], false); return }
  const run = runner(d, lit)
  // Shown coming along the change that leads to it from what was lit.
  const by = d.wires.find(w => w.b === itemId && wireKind(d, w) === 'change' && lit.has(w.a))
  run.light(itemId)
  show(nodeId, [...(by ? [by.id] : []), ...run.r.used], run.r.fired)
  following = true
  try { settle(nodeId, d, run.r.lit, run.r.fired, false) } finally { following = false }
}

/** Fire an event by hand. */
export function fireEvent(nodeId: string, itemId: string): void {
  const d = spaceOf(nodeId)
  if (!d || itemOf(d, itemId)?.kind !== 'event') return
  useUndoCoordinator.getState().checkpoint()
  const run = runner(d, new Set(d.items.filter(i => i.now).map(i => i.id)))
  run.fire(itemId)
  show(nodeId, run.r.used, run.r.fired)
  following = true
  try { settle(nodeId, d, run.r.lit, run.r.fired, false) } finally { following = false }
}

/** Make a change by hand: its far end becomes "now". */
export function makeChange(nodeId: string, wireId: string): void {
  const w = wireOf(spaceOf(nodeId) ?? emptyStateSpace(), wireId)
  if (w) setNow(nodeId, w.b, true)
}

// ── Editing ──

/** Add a node. Returns its id. */
export function addItem(nodeId: string, item: Omit<SpaceItem, 'id'>, undo = true): string {
  const id = uid()
  editSpace(nodeId, d => ({ ...d, items: [...d.items, { ...item, id }] }), undo)
  return id
}

/** Take nodes and wires out, with every wire that hung on them. */
export function removeFromSpace(nodeId: string, ids: string[]): void {
  const gone = new Set(ids)
  editSpace(nodeId, d => {
    let wires = d.wires
    // A wire goes with either of its ends, and a wire to a knob with its change.
    for (let grew = true; grew;) {
      grew = false
      for (const w of wires) if (!gone.has(w.id) && (gone.has(w.a) || gone.has(w.b))) { gone.add(w.id); grew = true }
      wires = wires.filter(w => !gone.has(w.id))
    }
    return { items: d.items.filter(i => !gone.has(i.id)), wires }
  })
  replaySpace(nodeId)
}

/** A wire from output `from` to input `to`. Returns its id (the one already
 *  there, if any), or null when the two cannot be wired. */
export function addWire(nodeId: string, from: PortRef, to: PortRef, undo = true): string | null {
  const d = spaceOf(nodeId)
  if (!d || !canWire(d, from, to)) return null
  const w: SpaceWire = { id: uid(), a: from.node!, b: (to.wire ?? to.node)!, bp: to.port as InPort }
  if (from.port !== 'out') w.ap = from.port
  const old = d.wires.find(x => x.a === w.a && x.ap === w.ap && x.b === w.b && (x.bp ?? 'in') === w.bp)
  if (old) return old.id
  editSpace(nodeId, s => {
    const next = { ...s, wires: [...s.wires, w] }
    // The first change of a machine: where it starts is where it began.
    if (wireKind(next, w) !== 'change' || !isState(itemOf(next, w.a))) return next
    const m = machineOf(next, w.a)
    return next.items.some(i => m.has(i.id) && i.start) ? next : { ...next, items: next.items.map(i => i.id === w.a ? { ...i, start: true } : i) }
  }, undo)
  replaySpace(nodeId)
  return w.id
}

export function patchItem(nodeId: string, itemId: string, p: Partial<SpaceItem>, undo = true): void {
  editSpace(nodeId, d => ({ ...d, items: d.items.map(i => i.id === itemId ? { ...i, ...p } : i) }), undo)
}
export function patchWire(nodeId: string, wireId: string, p: Partial<SpaceWire>, undo = true): void {
  editSpace(nodeId, d => ({ ...d, wires: d.wires.map(w => w.id === wireId ? { ...w, ...p } : w) }), undo)
  replaySpace(nodeId)
}

/** Make a node its machine's start (or not). */
export function setStart(nodeId: string, itemId: string, on: boolean): void {
  const d = spaceOf(nodeId)
  if (!d) return
  const m = machineOf(d, itemId)
  editSpace(nodeId, s => ({ ...s, items: s.items.map(i => i.id === itemId ? { ...i, start: on || undefined } : on && m.has(i.id) && i.start ? { ...i, start: undefined } : i) }))
  replaySpace(nodeId)
}

/** Move nodes to new middles. */
export function moveItems(nodeId: string, to: Map<string, { x: number; y: number }>): void {
  editSpace(nodeId, d => ({ ...d, items: d.items.map(i => { const p = to.get(i.id); return p ? { ...i, x: p.x, y: p.y } : i }) }), false)
}

// ── Things let go over a workspace ──

/** Client px to canvas units, measured against the canvas container (as
 *  utils/fx/createEffect clientToCanvas, which cannot be imported here: it
 *  would close a ring of imports). */
function clientToCanvas(clientX: number, clientY: number): { cx: number; cy: number } {
  const r = document.querySelector('[data-pin-host]')?.getBoundingClientRect()
  const { pan, zoom } = useCanvasStore.getState()
  return { cx: (clientX - (r?.left ?? 0) - pan.x) / zoom, cy: (clientY - (r?.top ?? 0) - pan.y) / zoom }
}

/** A point on screen, in canvas units, seen through the tilt when tilted.
 *  `flat`: already a flat one, as the tilted view's re-sent events carry. */
export function screenToCanvas(clientX: number, clientY: number, flat = false): { cx: number; cy: number } | null {
  const t = useTiltStore.getState()
  const host = document.querySelector('[data-tilt-stage="world"]')?.parentElement
  if (flat || !isTilted(t) || !host) return clientToCanvas(clientX, clientY)
  const r = host.getBoundingClientRect()
  const mx = r.left + r.width / 2, my = r.top + r.height / 2
  const g = unprojectTilt(clientX - mx, clientY - my, t.tilt, t.spin, t.shiftX, t.shiftY)
  return g ? clientToCanvas(mx + g.x, my + g.y) : null
}

/** The side bar's width, in the workspace's own units. */
export const SPACE_BAR_W = 250

/** Where a workspace's ground is on the canvas: its corner, its size in its
 *  own units, and how many canvas units one of those is. */
export function planeBox(nodeId: string): { x: number; y: number; k: number; w: number; h: number } | null {
  const n = useFreeNodeStore.getState().nodes[nodeId]
  if (!n || n.type !== 'stateSpace' || n.pin) return null
  const k = n.uiScale ?? 1
  // FreeNode's header: 22 screen pixels, never more than 28% of the tile.
  const head = Math.min(22 / useCanvasStore.getState().zoom, n.height * 0.28)
  return { x: n.x, y: n.y + head, k, w: n.width / k - SPACE_BAR_W, h: (n.height - head) / k }
}

/** The workspace whose ground is under a screen point, and the point on it. */
export function spaceAt(clientX: number, clientY: number, flat = false): { nodeId: string; x: number; y: number } | null {
  const c = screenToCanvas(clientX, clientY, flat)
  if (!c) return null
  let best: { nodeId: string; x: number; y: number } | null = null
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    const b = n.type === 'stateSpace' ? planeBox(n.id) : null
    if (!b) continue
    const x = (c.cx - b.x) / b.k, y = (c.cy - b.y) / b.k
    if (x >= 0 && y >= 0 && x <= b.w && y <= b.h) best = { nodeId: n.id, x, y }
  }
  return best
}

const snap = (v: number) => Math.round(v / SPACE_GRID) * SPACE_GRID

/** Cards let go at a screen point: over a workspace they become nodes there,
 *  one each, side by side (an Event card becomes an event). True when it
 *  took them: the caller then puts the cards back where they were picked up.
 *  The press that began the drag took the undo checkpoint. */
export function dropOnStateSpace(clientX: number, clientY: number, cards: string[], flat = false): boolean {
  const at = spaceAt(clientX, clientY, flat)
  if (!at || !cards.length) return false
  const groups = useBoardsStore.getState().groups
  const ok = cards.map(c => groups.find(g => g.id === c)).filter((g): g is NonNullable<typeof g> => !!g && !g.effect)
  if (!ok.length) return false
  editSpace(at.nodeId, d => {
    const have = new Set(d.items.map(i => i.card))
    const fresh = ok.filter(g => !have.has(g.id))
    if (!fresh.length) return d
    let x = snap(at.x)
    return { ...d, items: [...d.items, ...fresh.map(g => {
      const kind: SpaceKind = g.cardType === 'event' ? 'event' : 'card'
      const item = { id: uid(), kind, card: g.id, x, y: snap(at.y) }
      x += (kind === 'event' ? EVENT_W : ICON) + 30
      return item
    })] }
  }, false)
  return true
}

/** A storyline let go at a screen point: over a workspace it becomes a
 *  timeline node there. True when it took it. */
export function dropLineOnStateSpace(clientX: number, clientY: number, lineId: string, flat = false): boolean {
  const at = spaceAt(clientX, clientY, flat)
  if (!at) return false
  editSpace(at.nodeId, d => d.items.some(i => i.line === lineId) ? d : { ...d, items: [...d.items, { id: uid(), kind: 'timeline', line: lineId, x: snap(at.x), y: snap(at.y) }] }, false)
  return true
}

/** Live: a workspace follows the time markers of its timelines, wherever
 *  they are moved from (the storyline, the world clock, its own node), and
 *  the points of a storyline as they are added, moved or taken away. */
let started = false
export function startStateSpaces(): void {
  if (started) return
  started = true
  let busy = false
  useFreeNodeStore.subscribe((s, prev) => {
    if (busy || s.nodes === prev.nodes) return
    const moved: string[] = []
    for (const n of Object.values(s.nodes)) {
      if (n.type !== 'stateSpace' || !n.stateSpace) continue
      for (const i of normalizeSpace(n.stateSpace).items) {
        if (i.kind !== 'timeline' || !i.line) continue
        const a = s.nodes[i.line]?.storyline, b = prev.nodes[i.line]?.storyline
        if (a !== b && (a?.marker !== b?.marker || a?.dots !== b?.dots)) { moved.push(n.id); break }
      }
    }
    if (!moved.length) return
    busy = true
    try { for (const id of moved) replaySpace(id) } finally { busy = false }
  })
  // The other way round: a State card that picks a state anywhere (its own
  // face, its picker, a time marker) lights the node of a card in that
  // state's deck, so the workspace shows where the thing is, live.
  useBoardsStore.subscribe((s, prev) => {
    if (following || busy || s.groups === prev.groups) return
    const before = new Map(prev.groups.filter(g => g.stateCard).map(g => [g.id, g.stateCard!.current]))
    const cards = new Set<string>()
    for (const g of s.groups) {
      const cur = g.stateCard?.current
      if (!cur || before.get(g.id) === cur) continue
      for (const c of deckCards(s.groups, g.stateCard!.states.find(st => st.id === cur)?.deck)) cards.add(c)
    }
    if (!cards.size) return
    busy = true
    try {
      for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
        const d = n.type === 'stateSpace' && n.stateSpace ? normalizeSpace(n.stateSpace) : null
        const hit = d?.items.filter(i => i.card && cards.has(i.card) && !i.now && isState(i))
        if (!d || !hit?.length) continue
        const lit = new Set(d.items.filter(i => i.now).map(i => i.id))
        const run = runner(d, lit)
        for (const i of hit) {
          const by = d.wires.find(w => w.b === i.id && wireKind(d, w) === 'change' && lit.has(w.a))
          if (by) run.r.used.push(by.id)
          run.light(i.id)
        }
        show(n.id, run.r.used, run.r.fired)
        following = true
        try { settle(n.id, d, run.r.lit, run.r.fired, false) } finally { following = false }
      }
    } finally { busy = false }
  })
}
