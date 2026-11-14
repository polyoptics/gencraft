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
//             order, each with an output, and its own time marker. With
//             `world` it is the world clock: whichever storyline that is.
//   value     a number (or, as a flag, yes / no) that wires change.
//   and, or   true while all (any) of what is wired into it is true.
//   fact      true while its first card is in its second on the board: in
//             its deck, or linked to it (a faction's members are its links).
//   wait      passes what reaches it on, a number of points later.
//   pick      passes what reaches it on along one of its wires, by chance.
//   space     another workspace, dragged in by its header: a machine as one
//             node. Its states, events and values each have an input (light
//             it, fire it, change it) and an output (when it is lit, when
//             it fires, what it is), so machines drive and read each other.
//
// Some nodes are true or not at any moment (a card: lit; a value: by the
// compare its wire carries; and, or, fact): these can be CONDITIONS, wired
// into an event's "only if" or into an and / or. Wired into anything else
// they send when they BECOME true. A wire from one can carry "not".
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
import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { isTilted, unprojectTilt, useTiltStore } from '../store/tiltStore'
import { applyState, deckCards, markChange } from './stateCard'
import { rootOf } from './storyline'

export type SpaceKind = 'card' | 'blank' | 'event' | 'any' | 'timeline' | 'value' | 'and' | 'or' | 'fact' | 'wait' | 'pick' | 'space'

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
  /** space: the other workspace's node id. */
  space?: string
  /** timeline: the world clock's storyline, whichever it is, not `line`. */
  world?: boolean
  /** value: what it is now, and what it is before anything has happened. */
  val?: number
  init?: number
  /** value: shown and kept as yes / no. */
  flag?: boolean
  /** wait: how many points later. */
  n?: number
  /** pick: what its chances hang on; a new one is a new roll. */
  seed?: number
}

export type Compare = '<' | '<=' | '=' | '!=' | '>=' | '>'

export type InPort = 'in' | 'if' | 'knob' | 'a' | 'b' | `in:${string}`

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
  /** From a value: what makes it true (without: it is not zero). */
  cmp?: Compare
  cn?: number
  /** From anything true-or-not: true when that is not. */
  not?: boolean
  /** Into a value: what it does to it (without: adds 1). */
  op?: 'add' | 'set'
  on?: number
  /** Never saved: set where workspaces are read joined together (worldOf),
   *  on a wire that crosses from one into another. It is never a change. */
  x?: boolean
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
export const VALUE_W = 112
export const VALUE_H = 60
export const GATE_W = 64
export const GATE_H = 40
export const FACT_W = 124
export const FACT_H = 62
export const WAIT_W = 108
export const SPACE_W = 190
export const SPACE_ROW = 22
export const SPACE_HEAD = 28
export const SMALL_W = 84
export const SMALL_H = 40
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
/** True or not at any moment: can be a condition. */
export const isLevel = (i: SpaceItem | undefined) => isState(i) || i?.kind === 'value' || i?.kind === 'and' || i?.kind === 'or' || i?.kind === 'fact'
/** Reads conditions through its inputs, never signals. */
const readsLevels = (i: SpaceItem | undefined) => i?.kind === 'and' || i?.kind === 'or' || i?.kind === 'fact'
/** What a workspace shows of itself as a node in another: its states, its
 *  events and its values. */
export function exposed(spaceId: string | undefined): SpaceItem[] {
  const d = spaceId ? spaceOf(spaceId) : null
  return d ? d.items.filter(i => isState(i) || i.kind === 'event' || i.kind === 'value') : []
}
/** The node at an end of a wire: for a workspace node's port, the node
 *  inside that workspace it stands for. */
export function endOf(d: StateSpaceData, node: string | undefined, port: string | undefined): SpaceItem | undefined {
  const i = itemOf(d, node)
  if (i?.kind !== 'space') return i
  const inner = port?.startsWith('in:') ? port.slice(3) : port?.startsWith('out:') ? port.slice(4) : undefined
  return inner ? exposed(i.space).find(x => x.id === inner) : undefined
}
/** A timeline node's storyline. */
export const lineOf = (i: SpaceItem | undefined): string | undefined => i?.world ? useCanvasStore.getState().worldClockLine ?? undefined : i?.line

/** What a wire is: a change (or, plain, a link) between two cards, else a
 *  signal: "when this, then that". */
export function wireKind(d: StateSpaceData, w: SpaceWire): 'change' | 'link' | 'signal' | 'cond' {
  const a = itemOf(d, w.a)
  if (w.bp === 'if' || (w.bp !== 'knob' && readsLevels(itemOf(d, w.b)))) return 'cond'
  if (w.x) return 'signal'
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
  if (i.kind === 'timeline') return lineSize(lineOf(i))
  if (i.kind === 'value') return { w: VALUE_W, h: VALUE_H }
  if (i.kind === 'and' || i.kind === 'or') return { w: GATE_W, h: GATE_H }
  if (i.kind === 'fact') return { w: FACT_W, h: FACT_H }
  if (i.kind === 'space') return { w: SPACE_W, h: SPACE_HEAD + Math.max(1, exposed(i.space).length) * SPACE_ROW + 6 }
  if (i.kind === 'wait') return { w: WAIT_W, h: SMALL_H }
  if (i.kind === 'pick') return { w: SMALL_W, h: SMALL_H }
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
    const c = lineClock(lineOf(i))
    return (c?.dots ?? []).map(p => ({ port: 'pt:' + p.id, out: true, spot: { x: i.x - w / 2 + p.frac * w, y: i.y + h / 2, dx: 0, dy: 1 } }))
  }
  if (i.kind === 'space') {
    return exposed(i.space).flatMap((x, k) => {
      const y = i.y - h / 2 + SPACE_HEAD + (k + 0.5) * SPACE_ROW
      return [{ port: 'in:' + x.id, out: false, spot: { ...L, y } }, { port: 'out:' + x.id, out: true, spot: { ...R, y } }]
    })
  }
  if (i.kind === 'fact') return [{ port: 'a', out: false, spot: { ...L, y: i.y - 19 } }, { port: 'b', out: false, spot: { ...L, y: i.y + 19 } }, { port: 'out', out: true, spot: R }]
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
  const A = itemOf(d, from.node)
  if (!A || !itemPorts(A).some(p => p.out && p.port === from.port)) return false
  // What sends: for a workspace node, the node inside it that the port stands for.
  const a = endOf(d, from.node, from.port)
  if (!a) return false
  if (to.wire) {
    const w = wireOf(d, to.wire)
    return !!w && wireKind(d, w) === 'change' && a.kind !== 'any'
  }
  const b = itemOf(d, to.node)
  if (!b || b.id === A.id) return false
  if (isState(b)) return to.port === 'in'
  if (a.kind === 'any') return false
  if (b.kind === 'space') return to.port.startsWith('in:') && !!endOf(d, b.id, to.port)
  if (b.kind === 'fact') return (to.port === 'a' || to.port === 'b') && a.kind === 'card' && !!a.card
  if (b.kind === 'and' || b.kind === 'or') return to.port === 'in' && isLevel(a)
  if (b.kind === 'event' && to.port === 'if') return isLevel(a)
  return to.port === 'in' && (b.kind === 'event' || b.kind === 'value' || b.kind === 'wait' || b.kind === 'pick')
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

/** A value node's number as it stands. */
export const valOf = (i: SpaceItem | undefined): number => i?.val ?? i?.init ?? 0

const compare = (v: number, c: Compare, n: number): boolean =>
  c === '<' ? v < n : c === '<=' ? v <= n : c === '=' ? v === n : c === '!=' ? v !== n : c === '>=' ? v >= n : v > n

/** Is card `a` in card `b` on the board: in its deck, or linked with it (a
 *  faction's members are its links). A linked card stands for its master. */
function cardIsIn(groups: ProjectGroup[], a: string, b: string): boolean {
  const byId = new Map(groups.map(g => [g.id, g]))
  const A = byId.get(a), B = byId.get(b)
  if (!A || !B) return false
  const master = (id: string) => byId.get(id)?.linkOf ?? id
  const am = master(a), bm = master(b)
  if (am === bm) return false
  if (deckCards(groups, b).some(c => c !== b && master(c) === am)) return true
  const linked = (x: string, y: string) => (byId.get(x)?.linkedGroupIds ?? []).some(l => master(l) === y)
  return linked(bm, am) || linked(am, bm) || linked(b, am) || linked(a, bm)
}

interface Run {
  lit: Set<string>
  vals: Map<string, number>
  touched: Set<string>
  fired: string[]
  used: string[]
  /** Waits reached with no timeline behind them: they go on in real time. */
  later: { id: string; n: number }[]
  steps: number
}
interface RunOpts {
  /** A replay: chances fall the same way every time (by each pick's seed). */
  replay?: boolean
  /** What the facts were before the board changed: one that has become true sends. */
  factWas?: Map<string, boolean>
}

function runner(d: StateSpaceData, lit: Set<string>, vals: Map<string, number>, opts: RunOpts = {}) {
  const r: Run = { lit, vals, touched: new Set(), fired: [], used: [], later: [], steps: 0 }
  const machines = new Map<string, Set<string>>()
  const machine = (id: string) => { let m = machines.get(id); if (!m) { m = machineOf(d, id); for (const x of m) machines.set(x, m) } return m }
  const groups = d.items.some(i => i.kind === 'fact') ? useBoardsStore.getState().groups : []
  const facts = new Map<string, boolean>(opts.factWas ?? [])

  /** Is a node true now? */
  const truth = (id: string, seen = new Set<string>()): boolean => {
    const i = itemOf(d, id)
    if (!i || seen.has(id)) return false
    if (isState(i)) return r.lit.has(id)
    if (i.kind === 'value') return (r.vals.get(id) ?? 0) !== 0
    if (i.kind === 'fact') {
      let t = facts.get(id)
      if (t === undefined) {
        const end = (p: InPort) => itemOf(d, d.wires.find(w => w.b === id && w.bp === p)?.a)?.card
        const a = end('a'), b = end('b')
        t = !!a && !!b && cardIsIn(groups, a, b)
        facts.set(id, t)
      }
      return t
    }
    if (i.kind !== 'and' && i.kind !== 'or') return false
    seen.add(id)
    const ins = d.wires.filter(w => w.b === id && w.bp !== 'knob')
    const t = i.kind === 'and' ? ins.length > 0 && ins.every(w => wireTruth(w, seen)) : ins.some(w => wireTruth(w, seen))
    seen.delete(id)
    return t
  }
  /** Is what a wire carries true now: its source, by its compare, or not. */
  const wireTruth = (w: SpaceWire, seen?: Set<string>): boolean => {
    const a = itemOf(d, w.a)
    const base = a?.kind === 'value' && w.cmp ? compare(r.vals.get(a.id) ?? 0, w.cmp, w.cn ?? 0) : truth(w.a, seen)
    return w.not ? !base : base
  }
  // Wires that send when what they carry BECOMES true (a lit card's plain
  // wires are sent by light itself).
  const watch = d.wires.filter(w => { const a = itemOf(d, w.a); return wireKind(d, w) === 'signal' && isLevel(a) && (!isState(a) || !!w.not) })
  const was = new Map(watch.map(w => [w.id, wireTruth(w)]))
  facts.clear()
  const recheck = () => {
    for (const w of watch) {
      const t = wireTruth(w)
      const before = was.get(w.id)
      was.set(w.id, t)
      if (t && !before) go(w)
    }
  }

  let ctx: { tl: string; idx: number } | null = null
  const pending: { tl: string; due: number; id: string }[] = []
  let rolls = 0

  const go = (w: SpaceWire) => {
    if (++r.steps > 600 || wireKind(d, w) !== 'signal') return
    r.used.push(w.id)
    if (w.bp === 'knob') { change(w.b); return }
    const t = itemOf(d, w.b)
    if (t?.kind === 'event') fire(t.id)
    else if (t?.kind === 'value') set(t.id, w.op === 'set' ? w.on ?? 0 : (r.vals.get(t.id) ?? 0) + (w.on ?? 1))
    else if (t?.kind === 'wait') wait(t)
    else if (t?.kind === 'pick') pick(t)
    else light(w.b)
  }
  /** Send along every wire out of a node (a timeline: out of one point). */
  const signals = (from: string, port?: string) => {
    const a = itemOf(d, from)
    for (const w of d.wires) if (w.a === from && (port === undefined || w.ap === port) && wireKind(d, w) === 'signal' && !(w.not && isLevel(a))) go(w)
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
    recheck()
  }
  /** Fire an event, if everything wired to its "only if" is true. */
  const fire = (id: string) => {
    if (++r.steps > 600) return
    if (d.wires.some(w => w.b === id && w.bp === 'if' && !wireTruth(w))) return
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
  /** Give a value a number. */
  const set = (id: string, v: number) => {
    const i = itemOf(d, id)
    if (i?.kind !== 'value') return
    const next = i.flag ? (v > 0 ? 1 : 0) : v
    if ((r.vals.get(id) ?? 0) === next) return
    r.vals.set(id, next)
    recheck()
  }
  /** A wait: on again so many points later along the timeline this came
   *  from; with no timeline behind it, after as many beats of real time. */
  const wait = (t: SpaceItem) => {
    const n = Math.max(0, Math.round(t.n ?? 1))
    if (!n) { r.fired.push(t.id); signals(t.id) }
    else if (ctx) pending.push({ tl: ctx.tl, due: ctx.idx + n, id: t.id })
    else r.later.push({ id: t.id, n })
  }
  /** A pick: on along one of its wires. */
  const pick = (t: SpaceItem) => {
    const outs = d.wires.filter(w => w.a === t.id && wireKind(d, w) === 'signal')
    if (!outs.length) return
    r.fired.push(t.id)
    go(outs[opts.replay ? chance((t.seed ?? 1) + rolls++ * 7919, outs.length) : Math.floor(Math.random() * outs.length)])
  }
  /** A timeline's marker passes its `idx`th point. */
  const point = (tl: string, dot: string, idx: number) => {
    ctx = { tl, idx }
    signals(tl, 'pt:' + dot)
    for (let k = pending.findIndex(p => p.tl === tl && p.due === idx); k >= 0; k = pending.findIndex(p => p.tl === tl && p.due === idx)) {
      const [p] = pending.splice(k, 1)
      r.fired.push(p.id)
      signals(p.id)
    }
    ctx = null
  }
  /** A wait's time is up. */
  const resume = (id: string) => { const t = itemOf(d, id); if (t?.kind === 'pick') pick(t); else { r.fired.push(id); signals(id) } }
  return { r, light, fire, change, set, point, resume, recheck, truth, wireTruth, machine }
}

/** 0..n-1 from a seed, the same every time. */
function chance(seed: number, n: number): number {
  let t = (seed + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
}

/** The nodes a timeline can reach, through wires, events, changes and the rest. */
function driven(d: StateSpaceData): Set<string> {
  const out = new Set<string>()
  const queue = d.items.filter(i => i.kind === 'timeline').map(i => i.id)
  const seen = new Set(queue)
  const add = (id: string | undefined) => { if (id && !seen.has(id)) { seen.add(id); out.add(id); queue.push(id) } }
  while (queue.length) {
    const x = queue.pop()!
    for (const w of d.wires) {
      if (w.a !== x || w.bp === 'if') continue
      const k = wireKind(d, w)
      if (k === 'change' || k === 'link') continue
      const t = itemOf(d, w.bp === 'knob' ? wireOf(d, w.b)?.b : w.b)
      if (isState(t)) for (const m of machineOf(d, t!.id)) add(m)
      else add(t?.id)
    }
  }
  return out
}

const litOf = (d: StateSpaceData) => new Set(d.items.filter(i => i.now).map(i => i.id))
const valsOf = (d: StateSpaceData) => new Map(d.items.filter(i => i.kind === 'value').map(i => [i.id, valOf(i)]))

// ── Workspaces joined together ──
// A workspace that is a node in another runs with it as one: the engine
// reads every workspace joined that way as a single one, each node and wire
// named by its workspace, and a wire through a workspace node's port going
// straight to the node inside that the port stands for.

const SEP = '|'
const keyOf = (ws: string, id: string) => ws + SEP + id

interface World { d: StateSpaceData; ids: string[] }

function worldOf(nodeId: string): World | null {
  const data = new Map<string, StateSpaceData>()
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) if (n.type === 'stateSpace') data.set(n.id, normalizeSpace(n.stateSpace ?? emptyStateSpace()))
  if (!data.has(nodeId)) return null
  const group = new Set([nodeId])
  for (let grew = true; grew;) {
    grew = false
    for (const [ws, d] of data) for (const i of d.items) {
      if (i.kind !== 'space' || !i.space || !data.has(i.space) || group.has(ws) === group.has(i.space)) continue
      group.add(ws); group.add(i.space); grew = true
    }
  }
  const items: SpaceItem[] = [], wires: SpaceWire[] = []
  for (const ws of group) {
    const d = data.get(ws)!
    for (const i of d.items) if (i.kind !== 'space') items.push({ ...i, id: keyOf(ws, i.id) })
    for (const w of d.wires) {
      let a = keyOf(ws, w.a), ap = w.ap, b = keyOf(ws, w.b), bp = w.bp, x = false
      const A = itemOf(d, w.a)
      if (A?.kind === 'space') {
        const inner = ap?.startsWith('out:') && A.space && group.has(A.space) ? itemOf(data.get(A.space)!, ap.slice(4)) : undefined
        if (!inner) continue
        a = keyOf(A.space!, inner.id); ap = undefined; x = true
      }
      const B = bp === 'knob' ? undefined : itemOf(d, w.b)
      if (B?.kind === 'space') {
        const inner = bp?.startsWith('in:') && B.space && group.has(B.space) ? itemOf(data.get(B.space)!, bp.slice(3)) : undefined
        if (!inner) continue
        b = keyOf(B.space!, inner.id); bp = 'in'; x = true
      }
      wires.push({ ...w, id: keyOf(ws, w.id), a, ap, b, bp, ...(x ? { x: true } : {}) })
    }
  }
  return { d: { items, wires }, ids: [...group] }
}

/** One workspace's share of ids named by workspace, by their own names. */
const own = (ws: string, ids: Iterable<string>): string[] => {
  const pre = ws + SEP, out: string[] = []
  for (const id of ids) if (id.startsWith(pre)) out.push(id.slice(pre.length))
  return out
}

/** The and, or and fact nodes of a workspace that are true as things stand. */
export function spaceTruths(nodeId: string): Set<string> {
  const w = worldOf(nodeId)
  if (!w) return new Set()
  const run = runner(w.d, litOf(w.d), valsOf(w.d))
  return new Set(own(nodeId, w.d.items.filter(i => readsLevels(i) && run.truth(i.id)).map(i => i.id)))
}

/** What has just happened in a workspace, for its picture to show: the wires
 *  something went along and the nodes that fired, stamped with when. */
export const useSpaceLive = create<Record<string, { stamp: number; wires: string[]; fired: string[] }>>(() => ({}))
function show(nodeId: string, wires: string[], fired: string[]): void {
  if (wires.length || fired.length) useSpaceLive.setState({ [nodeId]: { stamp: Date.now(), wires, fired } })
}
/** What the last replay of each workspace went along: the next one shows
 *  only what is new (the marker passing one more point). */
const lastRun = new Map<string, Set<string>>()

/** Write what is lit and what the values are, and let the State cards follow. */
function settle(nodeId: string, lit: Set<string>, vals: Map<string, number>, fired: string[]): void {
  const d = spaceOf(nodeId)
  if (!d) return
  const newly = d.items.filter(i => lit.has(i.id) && !i.now)
  const same = (i: SpaceItem) => lit.has(i.id) === !!i.now && (i.kind !== 'value' || (vals.get(i.id) ?? 0) === valOf(i))
  if (!d.items.every(same)) {
    editSpace(nodeId, s => ({ ...s, items: s.items.map(i => same(i) ? i : { ...i, now: lit.has(i.id) || undefined, ...(i.kind === 'value' ? { val: vals.get(i.id) ?? 0 } : {}) }) }), false)
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

/** Write a run back to every workspace it ran through, and show it.
 *  `onlyNew`: show only what the last replay did not already go along. */
function finish(w: World, r: Run, pre: string[], onlyNew: boolean): void {
  following = true
  try {
    for (const ws of w.ids) {
      let used = own(ws, [...pre, ...r.used]), fired = own(ws, r.fired)
      if (onlyNew) {
        const was = lastRun.get(ws)
        lastRun.set(ws, new Set([...used, ...fired]))
        if (was) { used = used.filter(x => !was.has(x)); fired = fired.filter(x => !was.has(x)) } else { used = []; fired = [] }
      }
      show(ws, used, fired)
      const pfx = ws + SEP
      const vals = new Map<string, number>()
      for (const [k, v] of r.vals) if (k.startsWith(pfx)) vals.set(k.slice(pfx.length), v)
      settle(ws, new Set(own(ws, r.lit)), vals, own(ws, r.fired))
    }
  } finally { following = false }
}
/** Set while a workspace is making State cards follow it, so that their
 *  change is not read back as news (startStateSpaces). */
let following = false

/** Play the timelines of a workspace (and of those joined to it) from the
 *  beginning up to their markers: what they reach starts over (machines from
 *  their start node, values from what they start at) and takes everything up
 *  to now. The rest stays as it is. No undo step of its own. Returns the
 *  workspaces it played. */
export function replaySpace(nodeId: string): string[] {
  const w = worldOf(nodeId)
  if (!w) return []
  const d = w.d
  const reach = driven(d)
  if (!reach.size) return w.ids
  const lit = new Set(d.items.filter(i => reach.has(i.id) ? i.start : i.now).map(i => i.id))
  const vals = new Map(d.items.filter(i => i.kind === 'value').map(i => [i.id, reach.has(i.id) ? i.init ?? 0 : valOf(i)]))
  const run = runner(d, lit, vals, { replay: true })
  for (const tl of d.items) {
    if (tl.kind !== 'timeline') continue
    const c = lineClock(lineOf(tl))
    c?.dots.forEach((p, idx) => { if (p.at <= c.at) run.point(tl.id, p.id, idx) })
  }
  finish(w, run.r, [], true)
  return w.ids
}

/** Something done by hand (or by the board): run it from how things stand,
 *  show it, write it. `f` is given the run, how this workspace's ids are
 *  named in it, and the joined-up workspace; it may return wires to show
 *  ahead of what the run used. */
function hand(nodeId: string, f: (run: ReturnType<typeof runner>, k: (id: string) => string, d: StateSpaceData) => string[] | void, opts?: RunOpts): void {
  const w = worldOf(nodeId)
  if (!w) return
  const run = runner(w.d, litOf(w.d), valsOf(w.d), opts)
  const pre = f(run, id => keyOf(nodeId, id), w.d) ?? []
  finish(w, run.r, pre, false)
  // Waits with no timeline behind them: a beat of real time for each point.
  for (const l of run.r.later) window.setTimeout(() => hand(nodeId, again => again.resume(l.id)), l.n * 700)
}

/** Light a node by hand (or put it out). */
export function setNow(nodeId: string, itemId: string, on: boolean): void {
  const it = itemOf(spaceOf(nodeId) ?? emptyStateSpace(), itemId)
  if (!isState(it) || !!it!.now === on) return
  useUndoCoordinator.getState().checkpoint()
  hand(nodeId, (run, k, d) => {
    const id = k(itemId)
    if (!on) { run.r.lit.delete(id); run.recheck(); return }
    // Shown coming along the change that leads to it from what was lit.
    const by = d.wires.find(w => w.b === id && wireKind(d, w) === 'change' && run.r.lit.has(w.a))
    run.light(id)
    return by ? [by.id] : []
  })
}

/** Fire an event by hand (a wait or a pick: send it on). */
export function fireEvent(nodeId: string, itemId: string): void {
  const kind = itemOf(spaceOf(nodeId) ?? emptyStateSpace(), itemId)?.kind
  if (kind !== 'event' && kind !== 'wait' && kind !== 'pick') return
  useUndoCoordinator.getState().checkpoint()
  hand(nodeId, (run, k) => { if (kind === 'event') run.fire(k(itemId)); else run.resume(k(itemId)) })
}

/** Make a change by hand: its far end becomes "now". */
export function makeChange(nodeId: string, wireId: string): void {
  const w = wireOf(spaceOf(nodeId) ?? emptyStateSpace(), wireId)
  if (w) setNow(nodeId, w.b, true)
}

/** Give a value a number by hand. */
export function setValue(nodeId: string, itemId: string, v: number, undo = true): void {
  if (!Number.isFinite(v)) return
  if (undo) useUndoCoordinator.getState().checkpoint()
  hand(nodeId, (run, k) => run.set(k(itemId), v))
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
    return { ...d, items: d.items.filter(i => !gone.has(i.id)), wires }
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
    // A fact's two inputs hold one card each: a new wire takes the old one's place.
    const kept = w.bp === 'a' || w.bp === 'b' ? s.wires.filter(x => !(x.b === w.b && x.bp === w.bp)) : s.wires
    const next = { ...s, wires: [...kept, w] }
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
export function spaceAt(clientX: number, clientY: number, flat = false, skip?: string): { nodeId: string; x: number; y: number } | null {
  const c = screenToCanvas(clientX, clientY, flat)
  if (!c) return null
  let best: { nodeId: string; x: number; y: number } | null = null
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    const b = n.type === 'stateSpace' && n.id !== skip ? planeBox(n.id) : null
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
  editSpace(at.nodeId, d => d.items.some(i => !i.world && i.line === lineId) ? d : { ...d, items: [...d.items, { id: uid(), kind: 'timeline', line: lineId, x: snap(at.x), y: snap(at.y) }] }, false)
  return true
}

/** A workspace let go (held by its header) at a screen point: over another
 *  workspace's ground it becomes a node there, standing for the whole of it.
 *  True when it took it: the caller puts the workspace back where it was. */
export function dropSpaceOnStateSpace(clientX: number, clientY: number, spaceId: string, flat = false): boolean {
  const at = spaceAt(clientX, clientY, flat, spaceId)
  if (!at) return false
  editSpace(at.nodeId, d => d.items.some(i => i.space === spaceId) ? d : { ...d, items: [...d.items, { id: uid(), kind: 'space', space: spaceId, x: snap(at.x), y: snap(at.y) }] }, false)
  replaySpace(at.nodeId)
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
        const line = i.kind === 'timeline' ? lineOf(i) : undefined
        if (!line) continue
        const a = s.nodes[line]?.storyline, b = prev.nodes[line]?.storyline
        if (a !== b && (a?.marker !== b?.marker || a?.dots !== b?.dots)) { moved.push(n.id); break }
      }
    }
    if (!moved.length) return
    busy = true
    // Once for each set of workspaces joined together.
    const played = new Set<string>()
    try { for (const id of moved) if (!played.has(id)) for (const x of replaySpace(id)) played.add(x) } finally { busy = false }
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
        hand(n.id, (run, k, all) => hit.flatMap(i => {
          const by = all.wires.find(w => w.b === k(i.id) && wireKind(all, w) === 'change' && run.r.lit.has(w.a))
          run.light(k(i.id))
          return by ? [by.id] : []
        }))
      }
    } finally { busy = false }
  })
  // The world clock given another storyline: its nodes are that one now.
  useCanvasStore.subscribe((s, prev) => {
    if (s.worldClockLine === prev.worldClockLine) return
    for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
      if (n.type === 'stateSpace' && n.stateSpace && normalizeSpace(n.stateSpace).items.some(i => i.world)) { lastRun.delete(n.id); replaySpace(n.id) }
    }
  })
  // Facts read the board: when it changes, a fact that has become true sends.
  const factWas = new Map<string, Map<string, boolean>>()
  let due = 0
  const readFacts = () => {
    due = 0
    for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
      const d = n.type === 'stateSpace' && n.stateSpace ? normalizeSpace(n.stateSpace) : null
      if (!d?.items.some(i => i.kind === 'fact')) { factWas.delete(n.id); continue }
      const all = worldOf(n.id)!.d
      const run = runner(all, litOf(all), valsOf(all))
      const now = new Map(d.items.filter(i => i.kind === 'fact').map(i => [keyOf(n.id, i.id), run.truth(keyOf(n.id, i.id))]))
      const was = factWas.get(n.id)
      factWas.set(n.id, now)
      if (!was || ![...now].some(([k, v]) => was.has(k) && was.get(k) !== v)) continue
      hand(n.id, again => again.recheck(), { factWas: was })
    }
  }
  useBoardsStore.subscribe((s, prev) => { if (s.groups !== prev.groups && !due) due = window.setTimeout(readFacts, 200) })
  readFacts()
}
