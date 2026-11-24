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
//   path      a path drawn with the Curve tool (in a 3D set or not): its
//             points along it like a timeline's. A timeline's "time" wired to
//             its "time" makes what rides it follow that timeline; "play"
//             sets it going. Each point has an output (when a rider gets
//             there) and an input (while true, its riders stand there); its
//             "take" input, while true, has the other models of its set ride
//             it. Nothing of the path is changed: only where riders are drawn.
//   act       while what is wired into it is true, a card is hidden (or
//             only then shown) on the board. Nothing of the card is changed.
//   choice    stops and asks: it goes on along the option that is clicked.
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

import { isShut } from './deckTree'
import { create } from 'zustand'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { isTilted, unprojectTilt, useTiltStore } from '../store/tiltStore'
import { applyState, deckCards, markChange } from './stateCard'
import { rootOf } from './storyline'

export type SpaceKind = 'card' | 'blank' | 'event' | 'any' | 'timeline' | 'value' | 'and' | 'or' | 'fact' | 'wait' | 'pick' | 'space' | 'path' | 'act' | 'choice' | 'calc' | 'gen' | 'send' | 'recv' | 'switch' | 'dial' | 'count' | 'timer' | 'dice' | 'meter'

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
  /** Lit because a condition wired into it is true (held for as long as it is). */
  held?: boolean
  /** What its machine goes back to when the condition holding another of its states lets go. */
  under?: boolean
  /** path: the curve's id (store/notesStore). */
  curve?: string
  /** act: what it does to its card while true (without: hides it). */
  do?: 'hide' | 'show'
  /** choice: its options, the one last chosen, and whether it is waiting to be answered. */
  opts?: { id: string; name: string }[]
  chose?: string
  asking?: boolean
  /** space: the other workspace's node id. */
  space?: string
  /** timeline: the world clock's storyline, whichever it is, not `line`. */
  world?: boolean
  /** value: what it is now, and what it is before anything has happened. */
  val?: number
  init?: number
  /** value: shown and kept as yes / no. */
  flag?: boolean
  /** wait: how many points later. calc: its second number, when nothing is
   *  wired there. gen: how many seconds one round takes. */
  n?: number
  /** calc: what it works out from its two numbers (without: adds them). */
  calc?: CalcOp
  /** gen: what it gives out (without: a pulse each round). */
  shape?: GenShape
  /** gen: stopped by hand. */
  off?: boolean
  /** gen: how high it goes (without: 1). */
  amp?: number
  /** gen, shape "draw": its round, as levels from 0 to 1 at even steps. */
  pts?: number[]
  /** calc: the limits it is kept within, or measured against. meter: where its zones meet. */
  lo?: number
  hi?: number
  /** calc: toggles on what it has worked out. */
  round?: boolean
  abs?: boolean
  clamp?: boolean
  unit?: boolean
  /** calc: it glides to what it works out, taking about this many seconds. */
  smooth?: number
  /** count: it starts over when it is full. */
  wrap?: boolean
  /** pick: what its chances hang on; a new one is a new roll. */
  seed?: number
}

export type Compare = '<' | '<=' | '=' | '!=' | '>=' | '>'

export type InPort = 'in' | 'if' | 'knob' | 'a' | 'b' | 'time' | 'play' | 'take' | `in:${string}` | `hold:${string}`

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
export const CALC_W = 176
export const GEN_W = 116
export const RADIO_W = 104
export type CalcOp = 'add' | 'sub' | 'mul' | 'div' | 'min' | 'max' | 'avg' | 'gt' | 'lt' | 'ge' | 'le' | 'eq' | 'ne'
/** The calculations that ask something (their answer is yes or no). */
export const calcAsks = (op: CalcOp | undefined) => op === 'gt' || op === 'lt' || op === 'ge' || op === 'le' || op === 'eq' || op === 'ne'
export type GenShape = 'pulse' | 'wave' | 'square' | 'ramp' | 'tri' | 'noise' | 'draw'
export const SWITCH_W = 96
export const DIAL_W = 170
export const DIAL_HEAD = 46
export const COUNT_W = 132
export const TIMER_W = 112
export const DICE_W = 70
export const METER_W = 150
export const GADGET_H = 56
export const SCOPE_W = 190
export const SCOPE_H = 84
export const FACT_H = 62
export const WAIT_W = 108
export const SPACE_W = 190
export const ACT_W = 138
export const CHOICE_W = 150
export const CHOICE_HEAD = 26
export const CHOICE_ROW = 24
export const SPACE_ROW = 22
export const SPACE_HEAD = 28
export const SMALL_W = 84
export const SMALL_H = 40
/** How near a port a wire's end snaps to it. */
export const PORT_SNAP = 24
/** Nodes keep to this grid as they are moved (Ctrl: freely). */
export const SPACE_GRID = 10

const uid = () => crypto.randomUUID().slice(0, 8)

// ── The scene, as it is handed in ──
// What a workspace needs to know of paths, and what it asks of the board,
// comes through here (utils/stateScene fills it in at startup): importing
// the path code into this file would close a ring of imports.

export interface ScenePath {
  name: string
  /** Its 3D set's name, when it is in one. */
  setName?: string
  /** How many points it has. */
  n: number
  /** A few words for each point, where it has any (the point's own label). */
  labels: string[]
  /** When on its ride clock a rider is at each point (empty: nothing rides it). */
  times: number[]
  /** How long its set's rides take, and where the clock is now. */
  total: number
  now: number
}
export const scene: {
  path: (curveId: string | undefined) => ScenePath | null
  /** Called when what is lit or true may have changed: the board follows. */
  sync: () => void
  /** Set a path's riders going from the start. */
  play: (curveId: string) => void
} = { path: () => null, sync: () => {}, play: () => {} }

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

/** What is looked up over and over in a workspace's data, kept for as long
 *  as that data stands (it is never changed in place: a change is new data). */
interface Index {
  items: SpaceItem[]; wires: SpaceWire[]
  item: Map<string, SpaceItem>; wire: Map<string, SpaceWire>
  kind: Map<SpaceWire, WireKind>
  machine: Map<string, Set<string>> | null
}
const indexes = new WeakMap<StateSpaceData, Index>()
function indexOf(d: StateSpaceData): Index {
  let x = indexes.get(d)
  if (x && x.items === d.items && x.wires === d.wires) return x
  x = { items: d.items, wires: d.wires, item: new Map(), wire: new Map(), kind: new Map(), machine: null }
  for (const i of d.items) if (!x.item.has(i.id)) x.item.set(i.id, i)
  for (const w of d.wires) if (!x.wire.has(w.id)) x.wire.set(w.id, w)
  indexes.set(d, x)
  return x
}
const itemOf = (d: StateSpaceData, id: string | undefined) => id === undefined ? undefined : indexOf(d).item.get(id)
const wireOf = (d: StateSpaceData, id: string | undefined) => id === undefined ? undefined : indexOf(d).wire.get(id)
const isState = (i: SpaceItem | undefined) => i?.kind === 'card' || i?.kind === 'blank'
/** True or not at any moment: can be a condition. */
export const isLevel = (i: SpaceItem | undefined) => isState(i) || i?.kind === 'value' || i?.kind === 'and' || i?.kind === 'or' || i?.kind === 'fact' || i?.kind === 'act' || i?.kind === 'calc' || (i?.kind === 'gen' && isWave(i))
  || i?.kind === 'switch' || i?.kind === 'dial' || i?.kind === 'count' || i?.kind === 'timer' || i?.kind === 'dice' || i?.kind === 'meter'
/** Reads conditions through its inputs, never signals. */
const readsLevels = (i: SpaceItem | undefined) => i?.kind === 'and' || i?.kind === 'or' || i?.kind === 'fact' || i?.kind === 'act' || i?.kind === 'calc' || i?.kind === 'gen' || i?.kind === 'meter'
/** Is a number, not only true or not: a wire out of it can carry a compare. */
export const isNumber = (i: SpaceItem | undefined) => i?.kind === 'value' || i?.kind === 'calc' || (i?.kind === 'gen' && isWave(i))
  || i?.kind === 'dial' || i?.kind === 'count' || i?.kind === 'timer' || i?.kind === 'dice' || i?.kind === 'meter'
/** A signal node giving a level that rises and falls (not pulses). */
const isWave = (i: SpaceItem | undefined) => !!i?.shape && i.shape !== 'pulse'
/** Keeps a number of its own that things change: a value, and the gadgets that remember. */
export const hasVal = (i: SpaceItem | undefined) => i?.kind === 'value' || i?.kind === 'gen' || i?.kind === 'switch' || i?.kind === 'dial' || i?.kind === 'count' || i?.kind === 'timer' || i?.kind === 'dice' || (i?.kind === 'calc' && !!i.smooth)
/** The outputs of a gadget that are things that happen (the rest are true or not). */
/** A timer's length in seconds, how many fills a counter, a dice's sides, how high a signal goes. */
export const timerLen = (i: SpaceItem) => Math.max(0.1, i.n ?? 3)
export const countFull = (i: SpaceItem) => Math.max(1, Math.round(i.n ?? 5))
export const diceSides = (i: SpaceItem) => Math.max(2, Math.round(i.n ?? 6))
export const genAmp = (i: SpaceItem) => i.amp ?? 1
export const calcLo = (i: SpaceItem) => i.lo ?? 0
export const calcHi = (i: SpaceItem) => i.hi ?? 10
export const meterLo = (i: SpaceItem) => i.lo ?? 3
export const meterHi = (i: SpaceItem) => i.hi ?? 7
/** A signal's shape, from 0 to 1, at a point along its rounds (1 = one round). */
export function shapeAt(i: SpaceItem, turn: number): number {
  const f = turn - Math.floor(turn)
  if (i.shape === 'ramp') return f
  if (i.shape === 'square') return f < 0.5 ? 1 : 0
  if (i.shape === 'tri') return f < 0.5 ? f * 2 : 2 - f * 2
  if (i.shape === 'noise') {
    const k = Math.floor(turn), e = f * f * (3 - 2 * f)
    const at = (n: number) => chance((n | 0) + (i.seed ?? 0) * 7919, 10000) / 10000
    return at(k) + (at(k + 1) - at(k)) * e
  }
  if (i.shape === 'draw' && i.pts && i.pts.length > 1) {
    const m = i.pts.length, at = f * m, k = Math.floor(at)
    return i.pts[k % m] + (i.pts[(k + 1) % m] - i.pts[k % m]) * (at - k)
  }
  return 0.5 - 0.5 * Math.cos(f * 2 * Math.PI)
}
/** Is an output of a node true or not at any moment (and not something that happens)? */
export function outLevel(d: StateSpaceData, i: SpaceItem | undefined, port?: string): boolean {
  if (!i) return false
  const p = port ?? 'out'
  if (i.kind === 'recv') return levelOf(d, i)
  if (i.kind === 'dial') return p === 'out' || p.startsWith('pos:')
  if (i.kind === 'meter') return p === 'out' || p.startsWith('z:')
  return p === 'out' && isLevel(i)
}
/** Does an output carry a number (so that a wire out of it can carry a compare)? */
export const outNumber = (i: SpaceItem | undefined, port?: string) => (port ?? 'out') === 'out' && isNumber(i)
const srcLevel = (d: StateSpaceData, w: SpaceWire) => outLevel(d, itemOf(d, w.a), w.ap)
/** The name a send and a receive share. */
const channel = (i: SpaceItem | undefined) => (i?.name ?? '').trim().toLowerCase()
/** True or not, as things are wired: a receive is, when something true or
 *  not is wired into a send of its name. */
function levelOf(d: StateSpaceData, i: SpaceItem | undefined): boolean {
  if (i?.kind !== 'recv') return isLevel(i)
  const name = channel(i)
  return d.wires.some(w => { const b = itemOf(d, w.b), a = itemOf(d, w.a); return w.bp !== 'knob' && b?.kind === 'send' && channel(b) === name && a?.kind !== 'recv' && outLevel(d, a, w.ap) })
}
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
/** What a wire is. change: an arrow between two states of one thing.
 *  link: a plain line. signal: something that happens (once, when its
 *  source does). cond: read by what it goes into. hold: a condition into a
 *  state, which is lit for as long as the condition is true. */
export type WireKind = 'change' | 'link' | 'signal' | 'cond' | 'hold'
export function wireKind(d: StateSpaceData, w: SpaceWire): WireKind {
  const x = indexOf(d)
  let k = x.kind.get(w)
  if (!k) { k = kindOfWire(d, w); x.kind.set(w, k) }
  return k
}
function kindOfWire(d: StateSpaceData, w: SpaceWire): WireKind {
  const a = itemOf(d, w.a)
  const lvl = a?.kind === 'recv' ? levelOf(d, a) : outLevel(d, a, w.ap)
  const b = w.bp === 'knob' ? undefined : itemOf(d, w.b)
  // Into a signal: what is true or not runs it while it is; something that happens sends it once.
  if (b?.kind === 'gen') return lvl ? 'cond' : 'signal'
  if (w.bp === 'if' || w.ap === 'time' || readsLevels(b)) return 'cond'
  // Into a send: what is true or not is read by it; the rest passes through.
  if (b?.kind === 'send' && lvl && a?.kind !== 'recv') return 'cond'
  // Into a path: only "play" is something that happens; the rest holds while true.
  if (w.bp !== 'knob' && w.bp !== 'play' && itemOf(d, w.b)?.kind === 'path') return 'cond'
  // Something true or not (a value's compare, an And, a card that is NOT
  // lit) into a state: the state is lit while it is true.
  if ((w.bp ?? 'in') === 'in' && lvl && (!isState(a) || !!w.not) && isState(itemOf(d, w.b))) return 'hold'
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
  if (i.kind === 'path') return { w: (Math.max(1, scene.path(i.curve)?.n ?? 0) + 1) * pathStep(i), h: TL_H }
  if (i.kind === 'act') return { w: ACT_W, h: EVENT_H }
  if (i.kind === 'choice') return { w: CHOICE_W, h: CHOICE_HEAD + Math.max(1, i.opts?.length ?? 0) * CHOICE_ROW + 5 }
  if (i.kind === 'space') return { w: SPACE_W, h: SPACE_HEAD + Math.max(1, exposed(i.space).length) * SPACE_ROW + 6 }
  if (i.kind === 'calc') return { w: CALC_W, h: FACT_H }
  if (i.kind === 'gen') return { w: SCOPE_W, h: SCOPE_H }
  if (i.kind === 'switch') return { w: SWITCH_W, h: GADGET_H }
  if (i.kind === 'dial') return { w: DIAL_W, h: DIAL_HEAD + Math.max(1, i.opts?.length ?? 0) * CHOICE_ROW + 5 }
  if (i.kind === 'count') return { w: COUNT_W, h: GADGET_H }
  if (i.kind === 'timer') return { w: TIMER_W, h: GADGET_H + 10 }
  if (i.kind === 'dice') return { w: DICE_W, h: GADGET_H + 10 }
  if (i.kind === 'meter') return { w: METER_W, h: GADGET_H }
  if (i.kind === 'send' || i.kind === 'recv') return { w: RADIO_W, h: SMALL_H }
  if (i.kind === 'wait') return { w: WAIT_W, h: SMALL_H }
  if (i.kind === 'pick') return { w: SMALL_W, h: SMALL_H }
  return { w: ICON, h: ICON }
}

/** A path node's step from point to point: a timeline's, less for a path of many points. */
export const pathStep = (i: SpaceItem): number => Math.max(34, Math.min(TL_STEP, 880 / ((scene.path(i.curve)?.n ?? 0) + 1)))

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
    return [...(c?.dots ?? []).map(p => ({ port: 'pt:' + p.id, out: true, spot: { x: i.x - w / 2 + p.frac * w, y: i.y + h / 2, dx: 0, dy: 1 } })), { port: 'time', out: true, spot: R }]
  }
  if (i.kind === 'path') {
    const n = scene.path(i.curve)?.n ?? 0
    const at = (k: number) => i.x - w / 2 + (k + 1) / (n + 1) * w
    return [
      { port: 'time', out: false, spot: { ...L, y: i.y - 22 } }, { port: 'play', out: false, spot: L }, { port: 'take', out: false, spot: { ...L, y: i.y + 22 } },
      ...Array.from({ length: n }, (_, k) => ({ port: 'hold:' + k, out: false, spot: { x: at(k), y: i.y - h / 2, dx: 0, dy: -1 } })),
      ...Array.from({ length: n }, (_, k) => ({ port: 'pp:' + k, out: true, spot: { x: at(k), y: i.y + h / 2, dx: 0, dy: 1 } })),
    ]
  }
  if (i.kind === 'act') return [{ port: 'in', out: false, spot: L }]
  if (i.kind === 'choice') {
    return [{ port: 'in', out: false, spot: { ...L, y: i.y - h / 2 + CHOICE_HEAD / 2 } },
      ...(i.opts ?? []).map((o, k) => ({ port: 'opt:' + o.id, out: true, spot: { ...R, y: i.y - h / 2 + CHOICE_HEAD + (k + 0.5) * CHOICE_ROW } }))]
  }
  if (i.kind === 'space') {
    return exposed(i.space).flatMap((x, k) => {
      const y = i.y - h / 2 + SPACE_HEAD + (k + 0.5) * SPACE_ROW
      return [{ port: 'in:' + x.id, out: false, spot: { ...L, y } }, { port: 'out:' + x.id, out: true, spot: { ...R, y } }]
    })
  }
  if (i.kind === 'fact' || i.kind === 'calc') return [{ port: 'a', out: false, spot: { ...L, y: i.y - 19 } }, { port: 'b', out: false, spot: { ...L, y: i.y + 19 } }, { port: 'out', out: true, spot: R }]
  const left = (port: string, k: number, n: number) => ({ port, out: false, spot: { ...L, y: i.y - h / 2 + (k + 1) * h / (n + 1) } })
  const right = (port: string, k: number, n: number) => ({ port, out: true, spot: { ...R, y: i.y - h / 2 + (k + 1) * h / (n + 1) } })
  if (i.kind === 'gen') return [left('in', 0, 1), right('out', 0, 3), right('peak', 1, 3), right('cross', 2, 3)]
  if (i.kind === 'switch') return [left('in', 0, 3), left('on', 1, 3), left('off', 2, 3), right('out', 0, 1)]
  if (i.kind === 'count') return [left('in', 0, 2), left('reset', 1, 2), right('out', 0, 2), right('full', 1, 2)]
  if (i.kind === 'timer') return [left('in', 0, 3), left('pause', 1, 3), left('reset', 2, 3), right('out', 0, 2), right('done', 1, 2)]
  if (i.kind === 'dice') return [left('in', 0, 1), right('out', 0, 2), right('roll', 1, 2)]
  if (i.kind === 'meter') return [left('in', 0, 1), right('z:2', 0, 3), right('z:1', 1, 3), right('z:0', 2, 3)]
  if (i.kind === 'dial') {
    const row = (k: number) => i.y - h / 2 + DIAL_HEAD + (k + 0.5) * CHOICE_ROW
    return [{ port: 'next', out: false, spot: { ...L, y: i.y - h / 2 + 14 } }, { port: 'prev', out: false, spot: { ...L, y: i.y - h / 2 + 32 } }, { port: 'out', out: true, spot: { ...R, y: i.y - h / 2 + 23 } },
      ...(i.opts ?? []).flatMap((o, k) => [{ port: 'to:' + o.id, out: false, spot: { ...L, y: row(k) } }, { port: 'pos:' + o.id, out: true, spot: { ...R, y: row(k) } }])]
  }
  if (i.kind === 'send') return [{ port: 'in', out: false, spot: L }]
  if (i.kind === 'recv') return [{ port: 'out', out: true, spot: R }]
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
  if (!p || i?.kind !== 'timeline' || !ref.port.startsWith('pt:') || y >= i.y) return p
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
    // It comes to the knob square on to the arrow, from the side it is on,
    // so it plainly lands on that arrow and not on one that runs beside it.
    const tx = g.x2 + g.c2x - g.c1x - g.x1, ty = g.y2 + g.c2y - g.c1y - g.y1
    const tl = Math.hypot(tx, ty)
    let nx = tl ? -ty / tl : 0, ny = tl ? tx / tl : 1
    if ((p.x - g.mx) * nx + (p.y - g.my) * ny < 0) { nx = -nx; ny = -ny }
    return curve(p, { x: g.mx + nx * 7, y: g.my + ny * 7, dx: nx, dy: ny })
  }
  const q = portSpot(d, { node: w.b, port: w.bp ?? 'in' })
  if (!q) return null
  const g = curve(outSpot(d, from, q.y) ?? p, q)
  // Two changes the opposite way between the same two states are bowed
  // apart, each to its own side, so their arrows and knobs stand apart.
  if (!d.wires.some(x => x.id !== w.id && x.a === w.b && x.b === w.a && x.bp !== 'knob') || wireKind(d, w) !== 'change') return g
  const cx = g.x2 - g.x1, cy = g.y2 - g.y1, cl = Math.hypot(cx, cy) || 1
  const bow = Math.max(40, Math.min(90, cl * 0.3)), ox = (-cy / cl) * bow, oy = (cx / cl) * bow
  const c1x = g.c1x + ox, c1y = g.c1y + oy, c2x = g.c2x + ox, c2y = g.c2y + oy
  return { ...g, c1x, c1y, c2x, c2y, mx: g.mx + ox * 0.75, my: g.my + oy * 0.75, path: `M${g.x1} ${g.y1}C${c1x} ${c1y} ${c2x} ${c2y} ${g.x2} ${g.y2}` }
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
    return !!w && wireKind(d, w) === 'change' && a.kind !== 'any' && from.port !== 'time'
  }
  const b = itemOf(d, to.node)
  if (!b || b.id === A.id) return false
  // A timeline's time goes only to a path's, and a path's time takes only that.
  if (from.port === 'time' || to.port === 'time') return from.port === 'time' && to.port === 'time' && b.kind === 'path'
  if (isState(b)) return to.port === 'in'
  if (a.kind === 'any') return false
  const lvl = outLevel(d, a, from.port) || a.kind === 'recv'
  const has = (port: string) => itemPorts(b).some(p => !p.out && p.port === port)
  if (b.kind === 'gen' || b.kind === 'switch' || b.kind === 'dial' || b.kind === 'count' || b.kind === 'timer' || b.kind === 'dice') return has(to.port)
  if (b.kind === 'meter') return to.port === 'in' && lvl
  if (b.kind === 'path') return to.port === 'play' || ((to.port === 'take' || to.port.startsWith('hold:')) && lvl)
  if (b.kind === 'act') return to.port === 'in' && lvl
  if (b.kind === 'calc') return (to.port === 'a' || to.port === 'b') && lvl
  if (b.kind === 'send') return to.port === 'in'
  if (b.kind === 'choice') return to.port === 'in'
  if (b.kind === 'space') return to.port.startsWith('in:') && !!endOf(d, b.id, to.port)
  if (b.kind === 'fact') return (to.port === 'a' || to.port === 'b') && a.kind === 'card' && !!a.card
  if (b.kind === 'and' || b.kind === 'or') return to.port === 'in' && lvl
  if (b.kind === 'event' && to.port === 'if') return lvl
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

/** The nodes joined to `itemId`, itself included: one machine, of which one
 *  state is lit at a time. States joined by changes; and, where no changes
 *  are drawn between them, states that follow one another through events
 *  (a card that fires an event that lights a card). An "any" node joins
 *  nothing together: it only points. */
export function machineOf(d: StateSpaceData, itemId: string): Set<string> {
  if (!isState(itemOf(d, itemId))) return new Set([itemId])
  const x = indexOf(d)
  if (!x.machine) {
    // Every machine at once: the states joined by changes.
    const m = new Map<string, Set<string>>()
    const join = (p: string, q: string) => {
      const a = m.get(p) ?? new Set([p]), b = m.get(q) ?? new Set([q])
      m.set(p, a); m.set(q, b)
      if (a === b) return
      const [big, small] = a.size >= b.size ? [a, b] : [b, a]
      for (const id of small) { big.add(id); m.set(id, big) }
    }
    for (const w of d.wires) if (wireKind(d, w) === 'change' && isState(itemOf(d, w.a))) join(w.a, w.b)
    // Then the states with no changes of their own that follow one another
    // through what happens: a state, the events (waits, picks, choices) it
    // sets off, the states those light. Never across into another workspace.
    const drawn = new Set(m.keys())
    const outs = new Map<string, SpaceWire[]>()
    for (const w of d.wires) if (!w.x && w.bp !== 'knob' && wireKind(d, w) === 'signal') { const l = outs.get(w.a); if (l) l.push(w); else outs.set(w.a, [w]) }
    for (const s of d.items) {
      if (!isState(s) || drawn.has(s.id)) continue
      const seen = new Set<string>(), queue = [s.id]
      while (queue.length) {
        for (const w of outs.get(queue.pop()!) ?? []) {
          const t = itemOf(d, w.b)
          if (!t || seen.has(t.id)) continue
          seen.add(t.id)
          if (isState(t)) { if (!drawn.has(t.id) && t.id !== s.id) join(s.id, t.id) }
          else if (t.kind === 'event' || t.kind === 'wait' || t.kind === 'pick' || t.kind === 'choice') queue.push(t.id)
        }
      }
    }
    x.machine = m
  }
  return new Set(x.machine.get(itemId) ?? [itemId])
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
  /** Paths told to play (by the wire that told them). */
  plays: { wire: string; node: string }[]
  /** Choices reached and not answered. */
  asking: Set<string>
  /** Machines a condition is holding, by any of their states: what each
   *  goes back to when the condition lets go (none: nothing lit). */
  base: Map<Set<string>, string | null>
  steps: number
}
interface RunOpts {
  /** A replay: chances fall the same way every time (by each pick's seed). */
  replay?: boolean
  /** What the facts were before the board changed: one that has become true sends. */
  factWas?: Map<string, boolean>
  /** Wires to take as not having been true yet, so that one that is true
   *  sends: all that a replay starts over, a wire just drawn or just changed. */
  fresh?: (w: SpaceWire) => boolean
  /** States whose held / under marks are not to be taken up (a replay starts them over). */
  over?: Set<string>
  /** The time it is, in seconds (for signal nodes; without: now). */
  at?: number
}

function runner(d: StateSpaceData, lit: Set<string>, vals: Map<string, number>, opts: RunOpts = {}) {
  const r: Run = { lit, vals, touched: new Set(), fired: [], used: [], later: [], plays: [], asking: new Set(), base: new Map(), steps: 0 }
  const machines = new Map<string, Set<string>>()
  const machine = (id: string) => { let m = machines.get(id); if (!m) { m = machineOf(d, id); for (const x of m) machines.set(x, m) } return m }
  // Machines held as things stand: each with what lies under its held state.
  for (const i of d.items) {
    if (!i.held || !lit.has(i.id) || opts.over?.has(i.id)) continue
    const m = machine(i.id)
    r.base.set(m, d.items.find(o => o.under && m.has(o.id))?.id ?? null)
  }
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
    if (i.kind === 'timer') { const v = r.vals.get(id) ?? 0; return v > 0 && clock - v < timerLen(i) }
    if (i.kind === 'calc' || i.kind === 'gen' || i.kind === 'switch' || i.kind === 'dial' || i.kind === 'count' || i.kind === 'dice' || i.kind === 'meter') return num(id, seen) !== 0
    if (i.kind === 'recv') {
      // What is true or not wired into a send of its name.
      const name = channel(i)
      seen.add(id)
      const t = d.wires.some(w => { const b = itemOf(d, w.b); return w.bp !== 'knob' && b?.kind === 'send' && channel(b) === name && wireKind(d, w) === 'cond' && wireTruth(w, seen) })
      seen.delete(id)
      return t
    }
    if (i.kind !== 'and' && i.kind !== 'or' && i.kind !== 'act') return false
    seen.add(id)
    const ins = d.wires.filter(w => w.b === id && w.bp !== 'knob')
    const t = i.kind === 'and' ? ins.length > 0 && ins.every(w => wireTruth(w, seen)) : ins.some(w => wireTruth(w, seen))
    seen.delete(id)
    return t
  }
  const clock = opts.at ?? Date.now() / 1000
  /** Is a signal node running: not stopped by hand, and (when something is wired in) while that is true. */
  const running = (i: SpaceItem, seen = new Set<string>()): boolean => {
    if (i.off || seen.has(i.id)) return false
    const ins = d.wires.filter(w => w.b === i.id && w.bp !== 'knob')
    if (!ins.length) return true
    // Only what is true or not runs it; things that happen send one round each.
    seen.add(i.id)
    const t = ins.some(w => wireKind(d, w) === 'cond' && wireTruth(w, seen))
    seen.delete(i.id)
    return t
  }
  /** The number a node is now: a value's, a calculation's, a signal's level; anything else 1 while true. */
  const num = (id: string, seen = new Set<string>()): number => {
    const i = itemOf(d, id)
    if (!i || seen.has(id)) return 0
    if (i.kind === 'value') return r.vals.get(id) ?? 0
    if (i.kind === 'gen') {
      if (!isWave(i) || i.off) return 0
      const len = Math.max(0.05, i.n ?? 1), shot = r.vals.get(id) ?? 0
      // One round, set off by something that happened.
      if (shot > 0 && clock >= shot && clock - shot < len) return genAmp(i) * shapeAt(i, (clock - shot) / len)
      return running(i, seen) ? genAmp(i) * shapeAt(i, clock / len) : 0
    }
    if (i.kind === 'calc') return i.smooth ? r.vals.get(id) ?? 0 : raw(i, seen)
    if (i.kind === 'switch' || i.kind === 'count' || i.kind === 'dice') return r.vals.get(id) ?? 0
    if (i.kind === 'dial') return i.opts?.length ? dialAt(i) + 1 : 0
    if (i.kind === 'timer') {
      const v = r.vals.get(id) ?? 0, len = timerLen(i)
      return v > 0 ? Math.max(0, len - (clock - v)) : v < 0 ? Math.max(0, len + v) : 0
    }
    if (i.kind === 'meter') {
      seen.add(id)
      const v = d.wires.filter(x => x.b === id && x.bp !== 'knob').reduce((t, w) => t + carried(w, seen), 0)
      seen.delete(id)
      return v
    }
    return truth(id, seen) ? 1 : 0
  }
  /** A selector's position, from 0. */
  const dialAt = (i: SpaceItem) => Math.min((i.opts?.length ?? 1) - 1, Math.max(0, Math.round(r.vals.get(i.id) ?? 0)))
  /** A calculation's two sides: all that is wired to each, added up. */
  const sides = (i: SpaceItem, seen = new Set<string>()) => {
    seen.add(i.id)
    const of = (port: InPort) => d.wires.filter(x => x.b === i.id && x.bp === port).map(w => carried(w, seen))
    const as = of('a'), bs = of('b')
    seen.delete(i.id)
    return { as: as.length ? as : [0], bs: bs.length ? bs : [i.n ?? 0] }
  }
  /** What a calculation works out (before any gliding). */
  const raw = (i: SpaceItem, seen = new Set<string>()): number => {
    const { as, bs } = sides(i, seen)
    const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0)
    const a = sum(as), b = sum(bs), all = [...as, ...bs]
    let v = i.calc === 'sub' ? a - b : i.calc === 'mul' ? all.reduce((t, x) => t * x, 1) : i.calc === 'div' ? (b ? a / b : 0)
      : i.calc === 'min' ? Math.min(...all) : i.calc === 'max' ? Math.max(...all) : i.calc === 'avg' ? sum(all) / all.length
      : i.calc === 'gt' ? +(a > b) : i.calc === 'lt' ? +(a < b) : i.calc === 'ge' ? +(a >= b) : i.calc === 'le' ? +(a <= b) : i.calc === 'eq' ? +(a === b) : i.calc === 'ne' ? +(a !== b) : a + b
    if (i.abs) v = Math.abs(v)
    const lo = calcLo(i), hi = calcHi(i)
    if (i.clamp) v = Math.min(Math.max(v, Math.min(lo, hi)), Math.max(lo, hi))
    if (i.unit) v = hi !== lo ? (v - lo) / (hi - lo) : 0
    if (i.round) v = Math.round(v)
    return Number.isFinite(v) ? v : 0
  }
  /** The number a wire carries: its source's own (with no compare on it), else 1 while it is true. */
  const carried = (w: SpaceWire, seen?: Set<string>): number =>
    outNumber(itemOf(d, w.a), w.ap) && !w.cmp && !w.not ? num(w.a, seen) : wireTruth(w, seen) ? 1 : 0
  /** Is what a wire carries true now: its source (or the output of it the wire leaves by), by its compare, or not. */
  const wireTruth = (w: SpaceWire, seen?: Set<string>): boolean => {
    const a = itemOf(d, w.a), p = w.ap ?? 'out'
    let base: boolean
    if (a?.kind === 'dial' && p.startsWith('pos:')) base = a.opts?.[dialAt(a)]?.id === p.slice(4)
    else if (a?.kind === 'meter' && p.startsWith('z:')) { const v = num(a.id, seen); base = (v < meterLo(a) ? 0 : v < meterHi(a) ? 1 : 2) === +p.slice(2) }
    else base = outNumber(a, w.ap) && w.cmp ? compare(num(a!.id, seen), w.cmp, w.cn ?? 0) : truth(w.a, seen)
    return w.not ? !base : base
  }
  // Wires that send when what they carry BECOMES true (a lit card's plain
  // wires are sent by light itself).
  const watch = d.wires.filter(w => wireKind(d, w) === 'signal' && srcLevel(d, w) && (!isState(itemOf(d, w.a)) || !!w.not))
  // What moves with time by itself (a signal's level, and what is worked out
  // from one) is remembered from run to run: between two runs it can have
  // become true with nothing having happened.
  const timed = timedOf(d)
  const was = new Map(watch.map(w => [w.id, !opts.fresh?.(w) && (timed.has(w.a) ? timedWas.get(w.id) ?? wireTruth(w) : wireTruth(w))]))
  // Conditions into states: each machine shows the state whose condition is
  // true (of several, the one wired last), over whatever it was showing.
  const holds = d.wires.filter(w => wireKind(d, w) === 'hold')
  const heldMachines = [...new Set([...holds.map(w => machine(w.b)), ...r.base.keys()])]
  // Events with an "only if": one whose gate opens while a state wired to
  // fire it is lit fires then.
  const gated = d.items.filter(i => i.kind === 'event' && d.wires.some(w => w.b === i.id && w.bp === 'if'))
  const open = (id: string) => d.wires.every(w => w.b !== id || w.bp !== 'if' || wireTruth(w))
  const gateWas = new Map(gated.map(i => [i.id, open(i.id)]))
  facts.clear()
  let holding = false
  const hold = () => {
    if (holding || !heldMachines.length) return
    holding = true
    for (let pass = 0, moved = true; moved && pass < 8; pass++) {
      moved = false
      const win = new Map<Set<string>, SpaceWire>()
      for (const w of holds) if (wireTruth(w)) win.set(machine(w.b), w)
      for (const m of heldMachines) {
        const w = win.get(m), cur = [...m].find(x => r.lit.has(x)) ?? null
        if (w) {
          if (!r.base.has(m)) r.base.set(m, cur)
          if (cur === w.b) continue
          for (const x of m) { r.lit.delete(x); r.touched.add(x) }
          r.lit.add(w.b)
          r.used.push(w.id)
          signals(w.b)
          moved = true
        } else if (r.base.has(m)) {
          const back = r.base.get(m) ?? null
          r.base.delete(m)
          if (cur === back) continue
          for (const x of m) { r.lit.delete(x); r.touched.add(x) }
          if (back) r.lit.add(back)
          moved = true
        }
      }
    }
    holding = false
  }
  const recheck = () => {
    hold()
    for (const w of watch) {
      const t = wireTruth(w)
      const before = was.get(w.id)
      was.set(w.id, t)
      if (timed.has(w.a)) timedWas.set(w.id, t)
      if (t && !before) go(w)
    }
    for (const e of gated) {
      const t = open(e.id)
      const before = gateWas.get(e.id)
      gateWas.set(e.id, t)
      if (t && !before && d.wires.some(w => w.b === e.id && w.bp !== 'if' && wireKind(d, w) === 'signal' && isState(itemOf(d, w.a)) && !w.not && r.lit.has(w.a))) fire(e.id)
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
    else if (t?.kind === 'send') {
      // Out of every receive of its name.
      r.fired.push(t.id)
      const name = channel(t)
      for (const o of d.items) if (o.kind === 'recv' && channel(o) === name) { r.fired.push(o.id); signals(o.id) }
    }
    else if (t?.kind === 'wait') wait(t)
    else if (t?.kind === 'pick') pick(t)
    else if (t?.kind === 'choice') choice(t)
    else if (t?.kind === 'path') r.plays.push({ wire: w.id, node: t.id })
    else if (t && (t.kind === 'gen' || t.kind === 'switch' || t.kind === 'dial' || t.kind === 'count' || t.kind === 'timer' || t.kind === 'dice')) arrive(t.id, w.bp ?? 'in')
    else light(w.b)
  }
  /** Send along every wire out of a node (a timeline: out of one point). */
  const signals = (from: string, port?: string) => {
    const out = d.wires.filter(w => w.a === from && (port === undefined || (w.ap ?? 'out') === port) && wireKind(d, w) === 'signal' && !(w.not && srcLevel(d, w)))
    // Numbers first, so that nothing set off alongside reads a stale one.
    const num = (w: SpaceWire) => w.bp !== 'knob' && itemOf(d, w.b)?.kind === 'value'
    for (const w of out) if (num(w)) go(w)
    for (const w of out) if (!num(w)) go(w)
  }
  /** Light a node: its machine's others go out, and what it is wired to follows. */
  const light = (id: string) => {
    if (++r.steps > 600 || !isState(itemOf(d, id))) return
    const m = machine(id)
    for (const x of m) r.touched.add(x)
    if (r.lit.has(id)) return
    // Held by a condition: this is what it shows when the condition lets go.
    if (r.base.has(m)) { r.base.set(m, id); return }
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
  /** Give a gadget that remembers its number. */
  const put = (id: string, v: number) => {
    if ((r.vals.get(id) ?? 0) === v) return
    r.vals.set(id, v)
    recheck()
  }
  /** Something that happens arrives at one of a gadget's inputs. */
  const arrive = (id: string, port: string) => {
    const t = itemOf(d, id)
    if (!t || ++r.steps > 600) return
    const v = r.vals.get(id) ?? 0
    if (t.kind === 'gen') {
      if (t.off) return
      r.fired.push(id)
      // A level plays one round from now; a pulse is sent.
      if (isWave(t)) put(id, clock)
      else signals(id)
    } else if (t.kind === 'switch') put(id, port === 'on' ? 1 : port === 'off' ? 0 : v ? 0 : 1)
    else if (t.kind === 'dial') {
      const n = t.opts?.length ?? 0
      if (!n) return
      const cur = dialAt(t)
      put(id, port === 'next' || port === 'in' ? (cur + 1) % n : port === 'prev' ? (cur + n - 1) % n : Math.max(0, t.opts!.findIndex(o => 'to:' + o.id === port)))
    } else if (t.kind === 'count') {
      if (port === 'reset') { put(id, 0); return }
      const full = countFull(t)
      const next = v >= full ? (t.wrap ? 1 : v) : v + 1
      if (next === v && !(t.wrap && full === 1)) return
      put(id, next)
      if (next === full) { r.fired.push(id); signals(id, 'full') }
    } else if (t.kind === 'timer') {
      const len = timerLen(t)
      if (port === 'reset') put(id, 0)
      else if (port === 'pause') { if (v > 0 && clock - v < len) put(id, -Math.max(0.001, clock - v)); else if (v < 0) put(id, clock + v) }
      else put(id, clock)
    } else if (t.kind === 'dice') {
      const n = diceSides(t)
      r.vals.set(id, 1 + (opts.replay ? chance((t.seed ?? 1) + rolls++ * 7919, n) : Math.floor(Math.random() * n)))
      r.fired.push(id)
      recheck()
      signals(id, 'roll')
    }
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
  /** A choice: as a timeline plays, on along the option chosen (asking,
   *  when none is yet); reached by hand, it asks every time. */
  const choice = (t: SpaceItem) => {
    if (opts.replay && t.chose && t.opts?.some(o => o.id === t.chose)) { r.fired.push(t.id); signals(t.id, 'opt:' + t.chose) }
    else r.asking.add(t.id)
  }
  /** Something along a timeline that is not one of its points (a rider
   *  reaching a point of a path that follows it), after its `idx`th point. */
  const spot = (node: string, port: string, tl: string | null, idx: number) => {
    ctx = tl ? { tl, idx } : null
    signals(node, port)
    ctx = null
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
  return { r, light, fire, change, set, put, arrive, point, spot, resume, signals, recheck, truth, wireTruth, machine, num, raw, sides, running }
}

/** What a watched wire out of something that moves with time last carried (by the wire's id). */
const timedWas = new Map<string, boolean>()
/** The nodes that move with time by themselves: signal nodes, and what reads them. */
function timedOf(d: StateSpaceData): Set<string> {
  const out = new Set(d.items.filter(i => i.kind === 'gen' || i.kind === 'timer' || (i.kind === 'calc' && !!i.smooth)).map(i => i.id))
  if (!out.size) return out
  for (let grew = true; grew;) {
    grew = false
    for (const w of d.wires) if (w.bp !== 'knob' && out.has(w.a) && !out.has(w.b) && readsLevels(itemOf(d, w.b))) { out.add(w.b); grew = true }
  }
  return out
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
      // Through a send, out of the receives of its name.
      if (t?.kind === 'send') for (const o of d.items) if (o.kind === 'recv' && channel(o) === channel(t)) add(o.id)
    }
  }
  return out
}

const litOf = (d: StateSpaceData) => new Set(d.items.filter(i => i.now).map(i => i.id))
const valsOf = (d: StateSpaceData) => new Map(d.items.filter(hasVal).map(i => [i.id, valOf(i)]))

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
    // A send in one and a receive of its name in another join them too.
    for (const [ws, d] of data) {
      if (group.has(ws)) continue
      const air = (x: StateSpaceData, kind: 'send' | 'recv') => x.items.filter(i => i.kind === kind).map(channel)
      const tx = air(d, 'send'), rx = air(d, 'recv')
      if (!tx.length && !rx.length) continue
      if ([...group].some(g => { const o = data.get(g)!; return air(o, 'recv').some(n => tx.includes(n)) || air(o, 'send').some(n => rx.includes(n)) })) { group.add(ws); grew = true }
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

const GADGETS = new Set<SpaceKind>(['calc', 'gen', 'switch', 'dial', 'count', 'timer', 'dice', 'meter'])
/** The numbers of a workspace's gadgets as things stand (a signal also says
 *  whether it runs, as `<id>:run`; a calculation gives its two sides, as
 *  `<id>:a` and `<id>:b`), and
 *  the wires out of what is true or not that are true (`wire:<id>`: 1). */
export function spaceNumbers(nodeId: string): Map<string, number> {
  const w = worldOf(nodeId)
  const out = new Map<string, number>()
  if (!w) return out
  const run = runner(w.d, litOf(w.d), valsOf(w.d))
  const pre = nodeId + SEP
  const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0)
  for (const i of w.d.items) {
    if (!GADGETS.has(i.kind) || !i.id.startsWith(pre)) continue
    const id = i.id.slice(pre.length)
    const v = run.num(i.id)
    out.set(id, v)
    if (i.kind === 'gen') out.set(id + ':run', run.running(i) ? 1 : 0)
    if (i.kind === 'calc') { const s = run.sides(i); out.set(id + ':a', sum(s.as)); out.set(id + ':b', sum(s.bs)); out.set(id + ':raw', run.raw(i)) }
  }
  for (const x of w.d.wires) if (x.id.startsWith(pre) && x.bp !== 'knob' && srcLevel(w.d, x) && wireKind(w.d, x) !== 'change' && wireKind(w.d, x) !== 'link' && run.wireTruth(x)) out.set('wire:' + x.id.slice(pre.length), 1)
  return out
}

/** Something that happens arrives at a gadget's input, by hand: a switch is
 *  flipped, a selector turned, a counter counts, a timer starts, a dice rolls. */
export function poke(nodeId: string, itemId: string, port = 'in', undo = true): void {
  if (undo) useUndoCoordinator.getState().checkpoint()
  hand(nodeId, (run, k) => run.arrive(k(itemId), port))
}

/** What moves with real time: ten times a second each workspace that has a
 *  signal, a timer or a gliding calculation is read again (a pulse sends once
 *  each round; a level may have crossed what a wire compares it with, passed
 *  its top or come up through its middle; a timer may have run out). */
const turns = new Map<string, number>()
const levels = new Map<string, [number, number]>()
const moves = (i: SpaceItem) => i.kind === 'gen' || i.kind === 'timer' || (i.kind === 'calc' && !!i.smooth)
function tickSignals(): void {
  if (document.hidden) return
  const now = Date.now() / 1000
  const done = new Set<string>()
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    if (n.type !== 'stateSpace' || done.has(n.id)) continue
    done.add(n.id)
    if (!n.stateSpace?.items.some(moves)) continue
    hand(n.id, (run, _k, d) => {
      for (const i of d.items) {
        done.add(i.id.slice(0, i.id.indexOf(SEP)))
        if (i.kind === 'timer') {
          const v = run.r.vals.get(i.id) ?? 0
          if (v > 0 && now - v >= timerLen(i)) { run.put(i.id, 0); run.r.fired.push(i.id); run.signals(i.id, 'done') }
        } else if (i.kind === 'calc' && i.smooth) {
          const to = run.raw(i), cur = run.r.vals.get(i.id) ?? 0
          const next = cur + (to - cur) * (1 - Math.exp(-0.3 / Math.max(0.05, i.smooth)))
          run.put(i.id, Math.abs(to - next) < 0.002 ? to : next)
        } else if (i.kind === 'gen' && isWave(i)) {
          const v = run.num(i.id), m = levels.get(i.id), half = genAmp(i) / 2
          levels.set(i.id, [m?.[1] ?? v, v])
          if (!m) continue
          if (m[1] > m[0] && v <= m[1] && m[1] > half) run.signals(i.id, 'peak')
          if (m[1] < half && v >= half) run.signals(i.id, 'cross')
        } else if (i.kind === 'gen') {
          const turn = Math.floor(now / Math.max(0.05, i.n ?? 1)), last = turns.get(i.id)
          turns.set(i.id, turn)
          if (last !== undefined && turn !== last && run.running(i)) { run.r.fired.push(i.id); run.signals(i.id) }
        }
      }
      run.recheck()
    })
  }
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
function settle(nodeId: string, lit: Set<string>, vals: Map<string, number>, fired: string[], asking: Set<string>, replay: boolean, held: Set<string>, under: Set<string>): void {
  const d = spaceOf(nodeId)
  if (!d) return
  const newly = d.items.filter(i => lit.has(i.id) && !i.now)
  // A choice asks from when it is reached until it is answered; a replay knows afresh which ask.
  const asks = (i: SpaceItem) => i.kind === 'choice' && (asking.has(i.id) || (!replay && !!i.asking))
  const same = (i: SpaceItem) => lit.has(i.id) === !!i.now && held.has(i.id) === !!i.held && under.has(i.id) === !!i.under
    && (!hasVal(i) || (vals.get(i.id) ?? 0) === valOf(i)) && (i.kind !== 'choice' || asks(i) === !!i.asking)
  if (!d.items.every(same)) {
    editSpace(nodeId, s => ({ ...s, items: s.items.map(i => same(i) ? i : { ...i, now: lit.has(i.id) || undefined, held: held.has(i.id) || undefined, under: under.has(i.id) || undefined, ...(hasVal(i) ? { val: vals.get(i.id) ?? 0 } : {}), ...(i.kind === 'choice' ? { asking: asks(i) || undefined } : {}) }) }), false)
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
  // What conditions hold lit, and what lies under each.
  const held: string[] = [], under: string[] = []
  for (const [m, back] of r.base) {
    const cur = [...m].find(x => r.lit.has(x))
    if (cur) held.push(cur)
    if (back && back !== cur) under.push(back)
  }
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
      settle(ws, new Set(own(ws, r.lit)), vals, own(ws, r.fired), new Set(own(ws, r.asking)), onlyNew, new Set(own(ws, held)), new Set(own(ws, under)))
      // Paths told to play: only by what has newly happened.
      const d = spaceOf(ws)
      for (const pl of r.plays) {
        const wire = own(ws, [pl.wire])[0]
        const node = wire && used.includes(wire) ? itemOf(d ?? emptyStateSpace(), pl.node.slice(pl.node.indexOf(SEP) + 1)) : undefined
        if (node?.curve) scene.play(node.curve)
      }
    }
  } finally { following = false }
  scene.sync()
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
  // No timeline in it: nothing to play again, but what conditions hold is read afresh.
  if (!reach.size) { hand(nodeId, run => run.recheck()); return w.ids }
  const lit = new Set(d.items.filter(i => reach.has(i.id) ? i.start : i.now).map(i => i.id))
  const vals = new Map(d.items.filter(hasVal).map(i => [i.id, reach.has(i.id) && i.kind !== 'timer' && i.kind !== 'gen' && i.kind !== 'calc' ? i.init ?? 0 : valOf(i)]))
  // What is true from the very start sends from the start (to what starts over).
  const run = runner(d, lit, vals, { replay: true, over: reach, fresh: x => reach.has((x.bp === 'knob' ? wireOf(d, x.b)?.b : x.b) ?? '') })
  run.recheck()
  for (const tl of d.items) {
    if (tl.kind !== 'timeline') continue
    const c = lineClock(lineOf(tl))
    if (!c) continue
    // What happens along it, in order: its own points, and for each path
    // that follows its time, a rider reaching each of that path's points.
    const here = c.toFrac(c.at)
    const plan: { frac: number; go: (idx: number) => void; dot: boolean }[] = c.dots.filter(p => p.at <= c.at).map(p => ({ frac: p.frac, dot: true, go: idx => run.point(tl.id, p.id, idx) }))
    for (const t of d.wires) {
      if (t.a !== tl.id || t.ap !== 'time' || t.bp !== 'time') continue
      const path = itemOf(d, t.b), sp = scene.path(path?.curve)
      if (!path || !sp || sp.total <= 0) continue
      sp.times.forEach((when, k) => { const frac = when / sp.total; if (frac <= here) plan.push({ frac, dot: false, go: idx => run.spot(path.id, 'pp:' + k, tl.id, idx) }) })
    }
    plan.sort((m, n) => m.frac - n.frac || (m.dot === n.dot ? 0 : m.dot ? -1 : 1))
    let idx = -1
    for (const e of plan) { if (e.dot) idx++; e.go(idx) }
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

/** The conditions that hold the states of a node's machine lit, the one
 *  that wins first (the one wired last). */
export function holdsOf(d: StateSpaceData, itemId: string): SpaceWire[] {
  const m = machineOf(d, itemId)
  return d.wires.filter(w => wireKind(d, w) === 'hold' && m.has(w.b)).reverse()
}
/** Put one of those conditions where another is in that order. */
export function orderHold(nodeId: string, wireId: string, overId: string): void {
  const d = spaceOf(nodeId)
  const w = d?.wires.find(x => x.id === wireId)
  if (!d || !w) return
  const list = holdsOf(d, w.b).map(x => x.id)
  const from = list.indexOf(wireId), to = list.indexOf(overId)
  if (from < 0 || to < 0 || from === to) return
  list.splice(to, 0, ...list.splice(from, 1))
  // The same places among the wires, in the new order (the last is the top).
  const next = [...list].reverse().map(id => d.wires.find(x => x.id === id)!)
  const mine = new Set(list)
  let k = 0
  editSpace(nodeId, s => ({ ...s, wires: s.wires.map(x => mine.has(x.id) ? next[k++] : x) }))
  replaySpace(nodeId)
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
  if (kind !== 'event' && kind !== 'wait' && kind !== 'pick' && kind !== 'gen') return
  useUndoCoordinator.getState().checkpoint()
  hand(nodeId, (run, k) => { if (kind === 'event') run.fire(k(itemId)); else if (kind === 'gen') run.arrive(k(itemId), 'in'); else run.resume(k(itemId)) })
}

/** Make a change by hand: its far end becomes "now". */
export function makeChange(nodeId: string, wireId: string): void {
  const w = wireOf(spaceOf(nodeId) ?? emptyStateSpace(), wireId)
  if (w) setNow(nodeId, w.b, true)
}

/** Answer a choice: it goes on along that option. Where a timeline drives
 *  it the story is played again with that answer (so another can be tried);
 *  otherwise it goes on from here. */
export function choose(nodeId: string, itemId: string, optId: string): void {
  const it = itemOf(spaceOf(nodeId) ?? emptyStateSpace(), itemId)
  if (it?.kind !== 'choice' || !it.opts?.some(o => o.id === optId)) return
  useUndoCoordinator.getState().checkpoint()
  const w = worldOf(nodeId)
  const timed = !!w && driven(w.d).has(keyOf(nodeId, itemId))
  editSpace(nodeId, d => ({ ...d, items: d.items.map(i => i.id === itemId ? { ...i, chose: optId, asking: undefined } : i) }), false)
  if (timed) replaySpace(nodeId)
  else hand(nodeId, (run, k) => { run.r.fired.push(k(itemId)); run.signals(k(itemId), 'opt:' + optId) })
}

/** A rider has reached point `i` of a path as its clock runs by itself:
 *  every path node of that path sends from that point (those that follow a
 *  timeline's time do so as that timeline plays instead). */
export function pathPoint(curveId: string, i: number): void {
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    const d = n.type === 'stateSpace' && n.stateSpace ? normalizeSpace(n.stateSpace) : null
    for (const node of d?.items ?? []) {
      if (node.kind !== 'path' || node.curve !== curveId || d!.wires.some(w => w.b === node.id && w.bp === 'time')) continue
      if (d!.wires.some(w => w.a === node.id && w.ap === 'pp:' + i)) hand(n.id, (run, k) => run.spot(k(node.id), 'pp:' + i, null, 0))
    }
  }
}

/** What the workspaces ask of the board as things stand: paths whose riders
 *  stand at a point, paths that take their set's other riders, paths that
 *  follow a timeline (and how far along it is), cards hidden. */
export function sceneState(): { hold: Record<string, number>; take: string[]; follow: Record<string, number>; hidden: string[] } {
  const out = { hold: {} as Record<string, number>, take: [] as string[], follow: {} as Record<string, number>, hidden: [] as string[] }
  const done = new Set<string>()
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    if (n.type !== 'stateSpace' || done.has(n.id)) continue
    const w = worldOf(n.id)
    if (!w) continue
    for (const id of w.ids) done.add(id)
    if (!w.d.items.some(i => i.kind === 'path' || i.kind === 'act')) continue
    const run = runner(w.d, litOf(w.d), valsOf(w.d))
    for (const i of w.d.items) {
      if (i.kind === 'act' && i.card && run.truth(i.id) === (i.do !== 'show')) {
        // A closed deck goes with all its cards; a card of an open deck goes alone.
        const groups = useBoardsStore.getState().groups, g = groups.find(x => x.id === i.card)
        out.hidden.push(i.card, ...(isShut(g) ? deckCards(groups, i.card) : []))
      }
      if (i.kind !== 'path' || !i.curve) continue
      for (const t of w.d.wires) {
        if (t.b !== i.id || t.bp === 'knob') continue
        if (t.bp === 'time') { const c = lineClock(lineOf(itemOf(w.d, t.a))); if (c) out.follow[i.curve] = c.toFrac(c.at) }
        else if (t.bp === 'take') { if (run.wireTruth(t)) out.take.push(i.curve) }
        else if (t.bp?.startsWith('hold:') && run.wireTruth(t)) out.hold[i.curve] = Number(t.bp.slice(5))
      }
    }
  }
  return out
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
    const kept = (w.bp === 'a' || w.bp === 'b') && itemOf(s, w.b)?.kind === 'fact' ? s.wires.filter(x => !(x.b === w.b && x.bp === w.bp)) : s.wires
    const next = { ...s, wires: [...kept, w] }
    // The first change of a machine: where it starts is where it began.
    if (wireKind(next, w) !== 'change' || !isState(itemOf(next, w.a))) return next
    const m = machineOf(next, w.a)
    return next.items.some(i => m.has(i.id) && i.start) ? next : { ...next, items: next.items.map(i => i.id === w.a ? { ...i, start: true } : i) }
  }, undo)
  replaySpace(nodeId)
  sendIfTrue(nodeId, w.id)
  return w.id
}

/** A wire just drawn or just changed, carrying something already true, sends
 *  (one a replay starts over has been sent by the replay). */
function sendIfTrue(nodeId: string, wireId: string): void {
  const w = worldOf(nodeId)
  if (!w) return
  const id = keyOf(nodeId, wireId), x = wireOf(w.d, id)
  if (!x || driven(w.d).has((x.bp === 'knob' ? wireOf(w.d, x.b)?.b : x.b) ?? '')) return
  hand(nodeId, run => run.recheck(), { fresh: y => y.id === id })
}

export function patchItem(nodeId: string, itemId: string, p: Partial<SpaceItem>, undo = true): void {
  editSpace(nodeId, d => ({ ...d, items: d.items.map(i => i.id === itemId ? { ...i, ...p } : i) }), undo)
}
export function patchWire(nodeId: string, wireId: string, p: Partial<SpaceWire>, undo = true): void {
  editSpace(nodeId, d => ({ ...d, wires: d.wires.map(w => w.id === wireId ? { ...w, ...p } : w) }), undo)
  replaySpace(nodeId)
  if ('cmp' in p || 'cn' in p || 'not' in p) sendIfTrue(nodeId, wireId)
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

/** Where the pointer really is on the screen (startStateSpaces keeps it). */
let realAt: { x: number; y: number } | null = null

/** The workspace whose ground is under a screen point, and the point on it. */
export function spaceAt(clientX: number, clientY: number, flat = false, skip?: string): { nodeId: string; x: number; y: number } | null {
  // One pinned to the screen lies flat over everything, as it is drawn: by
  // where the pointer really is (the tilted view re-sends its events flat).
  const px = flat && realAt ? realAt.x : clientX, py = flat && realAt ? realAt.y : clientY
  for (const el of document.querySelectorAll<HTMLElement>('[data-pinned] [data-state-plane]')) {
    const id = el.dataset.statePlane!, r = el.getBoundingClientRect()
    if (id === skip || !r.width || !r.height || px < r.left || py < r.top || px > r.right || py > r.bottom) continue
    return { nodeId: id, x: (px - r.left) / r.width * el.offsetWidth, y: (py - r.top) / r.height * el.offsetHeight }
  }
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
  // Onto a show / hide node: that is the card it shows or hides.
  const onto = spaceOf(at.nodeId)?.items.find(i => i.kind === 'act' && Math.abs(i.x - at.x) <= ACT_W / 2 + 8 && Math.abs(i.y - at.y) <= EVENT_H / 2 + 8)
  if (onto) {
    editSpace(at.nodeId, d => ({ ...d, items: d.items.map(i => i.id === onto.id ? { ...i, card: ok[0].id } : i) }), false)
    scene.sync()
    return true
  }
  editSpace(at.nodeId, d => {
    const have = new Set(d.items.filter(i => i.kind !== 'act').map(i => i.card))
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
  window.setInterval(tickSignals, 100)
  const real = (e: PointerEvent) => { if (e.isTrusted) realAt = { x: e.clientX, y: e.clientY } }
  for (const type of ['pointerdown', 'pointermove', 'pointerup'] as const) window.addEventListener(type, real, true)
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
