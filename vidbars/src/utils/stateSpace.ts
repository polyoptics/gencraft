// The state workspace (Brian 2026-11-14): a place on the canvas, like a 3D
// set, where states are worked out by eye instead of read as rows. Cards
// and decks dragged in become small icons (the cards go back where they
// were picked up: an icon is a link, never the card itself). Icons are
// joined by lines drawn from one's rim to another; a line with an arrow is
// a change, a plain line is any other relationship. An icon can be lit as
// "now"; among icons joined by arrows only one is lit at a time, so each
// joined-up cluster is one machine and a workspace can hold several.
//
// What an icon stands for is Brian's to decide ("both, mixed freely"): a
// thing, a state of a thing, a whole deck. Nothing here says which.
//
// Where a lit icon's card is in a state's deck on a State card
// (utils/stateCard), that State card picks the state, so its output deck
// reforms as it always has.
//
// The data is the node's (FreeNodeData.stateSpace); the picture is
// components/StateSpace/StateSpaceBody.

import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { deckCards, pickState, applyState } from './stateCard'
import { rootOf } from './storyline'

export interface SpaceItem {
  id: string
  /** Its middle, in the workspace's own units. */
  x: number
  y: number
  /** 'card': linked to a card (or a deck, by its front card). 'any': stands
   *  for every icon it is joined to by arrows going out of it. 'blank': an
   *  icon with no card yet. */
  kind: 'card' | 'any' | 'blank'
  card?: string
  /** Its own name; without one a card icon shows its card's. */
  name?: string
  /** Lit: this is how things are now. */
  now?: boolean
}

export interface SpaceWire {
  id: string
  a: string
  b: string
  name?: string
  note?: string
  /** A plain line (a relationship), not an arrow (a change). */
  plain?: boolean
}

/** "This happens here": a dot of a timeline joined to a line (its change is
 *  made there) or to an icon (it is lit there). */
export interface SpaceTie {
  id: string
  /** The storyline (its node id) and its dot. */
  line: string
  dot: string
  wire?: string
  item?: string
}

export interface StateSpaceData {
  items: SpaceItem[]
  wires: SpaceWire[]
  /** Timelines dragged in: storylines, by node id, bottom one first. */
  lines?: string[]
  ties?: SpaceTie[]
}

export const emptyStateSpace = (): StateSpaceData => ({ items: [], wires: [] })

/** An icon's box, and the width of the rim a line is drawn from. */
export const ICON = 104
export const RIM = 10
export const ANY_R = 34

const uid = () => crypto.randomUUID().slice(0, 8)

export function spaceOf(nodeId: string): StateSpaceData | null {
  const n = useFreeNodeStore.getState().nodes[nodeId]
  return n?.type === 'stateSpace' ? n.stateSpace ?? emptyStateSpace() : null
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

/** Add an icon. Returns its id. */
export function addItem(nodeId: string, item: Omit<SpaceItem, 'id'>, undo = true): string {
  const id = uid()
  editSpace(nodeId, d => ({ ...d, items: [...d.items, { ...item, id }] }), undo)
  return id
}

/** Icons for cards let go at (x, y): one each, side by side. A card that
 *  already has an icon here is not given a second. */
export function addCardItems(nodeId: string, cards: string[], x: number, y: number, undo = true): void {
  editSpace(nodeId, d => {
    const have = new Set(d.items.map(i => i.card))
    const fresh = cards.filter(c => !have.has(c))
    if (!fresh.length) return d
    return { ...d, items: [...d.items, ...fresh.map((card, i) => ({ id: uid(), kind: 'card' as const, card, x: x + i * (ICON + 24), y }))] }
  }, undo)
}

export function removeItem(nodeId: string, itemId: string): void {
  editSpace(nodeId, d => {
    const wires = d.wires.filter(w => w.a !== itemId && w.b !== itemId)
    const kept = new Set(wires.map(w => w.id))
    return { ...d, items: d.items.filter(i => i.id !== itemId), wires, ties: d.ties?.filter(t => t.item !== itemId && (!t.wire || kept.has(t.wire))) }
  })
}

/** A line from `a` to `b`. Returns its id (the one already there, if any). */
export function addWire(nodeId: string, a: string, b: string): string | null {
  const d = spaceOf(nodeId)
  if (!d || a === b) return null
  const old = d.wires.find(w => w.a === a && w.b === b)
  if (old) return old.id
  const id = uid()
  editSpace(nodeId, s => ({ ...s, wires: [...s.wires, { id, a, b }] }))
  return id
}

export function removeWire(nodeId: string, wireId: string): void {
  editSpace(nodeId, d => ({ ...d, wires: d.wires.filter(w => w.id !== wireId), ties: d.ties?.filter(t => t.wire !== wireId) }))
}

export function patchItem(nodeId: string, itemId: string, p: Partial<SpaceItem>, undo = true): void {
  editSpace(nodeId, d => ({ ...d, items: d.items.map(i => i.id === itemId ? { ...i, ...p } : i) }), undo)
}
export function patchWire(nodeId: string, wireId: string, p: Partial<SpaceWire>, undo = true): void {
  editSpace(nodeId, d => ({ ...d, wires: d.wires.map(w => w.id === wireId ? { ...w, ...p } : w) }), undo)
}

/** The icons joined to `itemId` by arrows, itself included: one machine.
 *  An "any" icon joins nothing together: it only points. */
export function machineOf(d: StateSpaceData, itemId: string): Set<string> {
  const any = new Set(d.items.filter(i => i.kind === 'any').map(i => i.id))
  const out = new Set([itemId])
  if (any.has(itemId)) return out
  let grew = true
  while (grew) {
    grew = false
    for (const w of d.wires) {
      if (w.plain || any.has(w.a) || any.has(w.b)) continue
      if (out.has(w.a) !== out.has(w.b)) { out.add(w.a); out.add(w.b); grew = true }
    }
  }
  return out
}

/** Light an icon as "now" (or put it out). Lit, the others of its machine
 *  go out, and any State card holding its card as a state picks that state. */
export function setNow(nodeId: string, itemId: string, on: boolean): void {
  const d = spaceOf(nodeId)
  const it = d?.items.find(i => i.id === itemId)
  if (!d || !it || it.kind === 'any' || !!it.now === on) return
  const mates = on ? machineOf(d, itemId) : new Set<string>()
  editSpace(nodeId, s => ({
    ...s,
    items: s.items.map(i => i.id === itemId ? { ...i, now: on || undefined } : mates.has(i.id) && i.now ? { ...i, now: undefined } : i),
  }))
  if (on && it.card) followOnStateCards(it.card)
}

/** State cards whose state decks hold `card` pick that state. `quiet`: no
 *  undo step of its own (a time marker's drag took one). */
function followOnStateCards(card: string, quiet = false): void {
  const groups = useBoardsStore.getState().groups
  for (const sc of groups) {
    const m = sc.stateCard
    if (!m) continue
    const st = m.states.find(s => s.deck && deckCards(groups, s.deck).includes(card))
    if (st && m.current !== st.id) (quiet ? applyState : pickState)(sc.id, st.id)
  }
}

/** Make a change: its far end becomes "now". */
export function makeChange(nodeId: string, wireId: string): void {
  const w = spaceOf(nodeId)?.wires.find(x => x.id === wireId)
  if (w) setNow(nodeId, w.b, true)
}

/** Cards let go at screen point (x, y): if that is over a state workspace
 *  they become icons there. True when it took them (the caller then puts
 *  the cards back where they were picked up). */
export function dropOnStateSpace(clientX: number, clientY: number, cards: string[]): boolean {
  let plane: HTMLElement | null = null
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    plane = (el as HTMLElement).closest?.('[data-state-plane]') as HTMLElement | null
    if (plane) break
  }
  const nodeId = plane?.dataset.statePlane
  if (!plane || !nodeId || !cards.length) return false
  const groups = useBoardsStore.getState().groups
  // A State card's own output cards are made things, not material.
  const ok = cards.filter(c => { const g = groups.find(x => x.id === c); return g && !g.effect })
  if (!ok.length) return false
  const r = plane.getBoundingClientRect()
  const k = r.width / Math.max(1, plane.offsetWidth)
  // The press that began the drag took the undo checkpoint.
  addCardItems(nodeId, ok, (clientX - r.left) / k, (clientY - r.top) / k, false)
  return true
}

// ── Timelines ──
// A storyline dragged in lies along the bottom as a strip: its dots in
// story order, evenly spaced, and its time marker (the storyline's own, the
// one the world clock moves). A dot is tied to a line or an icon by
// dragging from it; as the marker passes the dot, that change is made (or
// that icon lit). Before the first tied dot of a machine, the icon its
// first change starts from is lit.

export const STRIP_H = 70
export const STRIP_GAP = 10
export const STRIP_PAD = 16
export const STRIP_INSET = 44

/** The workspace under screen point (x, y), or null. */
export function stateSpaceAt(clientX: number, clientY: number): string | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const plane = (el as HTMLElement).closest?.('[data-state-plane]') as HTMLElement | null
    if (plane) return plane.dataset.statePlane ?? null
  }
  return null
}

export function addLine(nodeId: string, lineId: string, undo = true): void {
  editSpace(nodeId, d => d.lines?.includes(lineId) ? d : { ...d, lines: [...(d.lines ?? []), lineId] }, undo)
}
export function removeLine(nodeId: string, lineId: string): void {
  editSpace(nodeId, d => ({ ...d, lines: d.lines?.filter(l => l !== lineId), ties: d.ties?.filter(t => t.line !== lineId) }))
}

/** Tie a timeline's dot to a line or an icon. Returns the tie's id. */
export function addTie(nodeId: string, line: string, dot: string, to: { wire?: string; item?: string }): string | null {
  const d = spaceOf(nodeId)
  if (!d || (!to.wire && !to.item)) return null
  const old = d.ties?.find(t => t.line === line && t.dot === dot && t.wire === to.wire && t.item === to.item)
  if (old) return old.id
  const id = uid()
  editSpace(nodeId, s => ({ ...s, ties: [...(s.ties ?? []), { id, line, dot, ...to }] }))
  playSpace(nodeId, line)
  return id
}
export function removeTie(nodeId: string, tieId: string): void {
  editSpace(nodeId, d => ({ ...d, ties: d.ties?.filter(t => t.id !== tieId) }))
}

export interface LineClock {
  title: string
  /** The marker's range and where it is, along the base from its start. */
  lo: number
  hi: number
  at: number
  /** Its dots in story order: where each is along the base, and along the
   *  strip (0..1, evenly spaced). */
  dots: { id: string; title: string; at: number; frac: number }[]
  toFrac: (v: number) => number
  toValue: (f: number) => number
}

/** A storyline as a strip reads it, or null when it is gone or empty. */
export function lineClock(lineId: string): LineClock | null {
  const n = useFreeNodeStore.getState().nodes[lineId]
  const d = n?.type === 'storyline' ? n.storyline : undefined
  const start = d?.dots.find(p => p.id === rootOf(d))
  if (!d || !start) return null
  const xs = (d.base ?? []).map(b => d.dots.find(p => p.id === b)?.x).filter((x): x is number => x !== undefined)
  const len = xs.length ? Math.max(...xs) - start.x : 0
  const lead = Math.max(200, len * 0.04)   // StorylineLayer markerLead
  const lo = -lead, hi = len + lead
  const at = Math.max(lo, Math.min(hi, d.marker ?? lo))
  const sorted = d.dots.map((p, i) => ({ id: p.id, title: p.title?.trim() || `Dot ${i + 1}`, at: Math.max(lo, Math.min(hi, p.x - start.x)) })).sort((a, b) => a.at - b.at)
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

/** Make what timeline `lineId` says is so at its marker, in workspace
 *  `nodeId`. No undo step of its own. */
export function playSpace(nodeId: string, lineId: string): void {
  const d = spaceOf(nodeId)
  const c = lineClock(lineId)
  if (!d || !c || !d.ties?.length) return
  const dotAt = new Map(c.dots.map(p => [p.id, p.at]))
  const isAny = (id: string | undefined) => d.items.find(i => i.id === id)?.kind === 'any'
  // Each tie: when, the icon lit then, and the icon lit before it.
  const events = d.ties.flatMap((t, i) => {
    if (t.line !== lineId || !dotAt.has(t.dot)) return []
    const w = t.wire ? d.wires.find(x => x.id === t.wire) : undefined
    const to = w ? w.b : t.item
    if (!to || !d.items.some(x => x.id === to) || isAny(to)) return []
    return [{ at: dotAt.get(t.dot)!, i, to, from: w && !isAny(w.a) ? w.a : undefined }]
  }).sort((a, b) => a.at - b.at || a.i - b.i)
  const lit = new Map<string, string>()   // machine (its first icon's id) -> the icon lit
  const sets = new Map<string, Set<string>>()
  const seen = new Set<string>()
  for (const e of events) {
    const set = machineOf(d, e.to)
    const key = [...set].sort()[0]
    sets.set(key, set)
    if (e.at <= c.at) lit.set(key, e.to)
    else if (!seen.has(key) && e.from) lit.set(key, e.from)
    seen.add(key)
  }
  if (!lit.size) return
  const on = new Set(lit.values())
  const off = new Set([...lit.keys()].flatMap(k => [...sets.get(k)!]).filter(id => !on.has(id)))
  const changed = d.items.filter(i => (on.has(i.id) && !i.now) || (off.has(i.id) && i.now))
  if (!changed.length) return
  editSpace(nodeId, s => ({ ...s, items: s.items.map(i => on.has(i.id) ? { ...i, now: true } : off.has(i.id) && i.now ? { ...i, now: undefined } : i) }), false)
  for (const i of changed) if (on.has(i.id) && i.card) followOnStateCards(i.card, true)
}

/** Live: a workspace follows the time markers of its timelines, wherever
 *  they are moved from (the storyline, the world clock, its own strip). */
let started = false
export function startStateSpaces(): void {
  if (started) return
  started = true
  let busy = false
  useFreeNodeStore.subscribe((s, prev) => {
    if (busy || s.nodes === prev.nodes) return
    const moved = new Set<string>()
    for (const n of Object.values(s.nodes)) {
      if (n.type !== 'stateSpace' || !n.stateSpace?.lines?.length) continue
      for (const l of n.stateSpace.lines) {
        const a = s.nodes[l]?.storyline, b = prev.nodes[l]?.storyline
        if (a && b && a !== b && a.marker !== b.marker) moved.add(n.id + ' ' + l)
      }
    }
    if (!moved.size) return
    busy = true
    try { for (const k of moved) { const [nodeId, l] = k.split(' '); playSpace(nodeId, l) } } finally { busy = false }
  })
}
