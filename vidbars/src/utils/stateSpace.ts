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
import { deckCards, pickState } from './stateCard'

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

export interface StateSpaceData {
  items: SpaceItem[]
  wires: SpaceWire[]
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
  editSpace(nodeId, d => ({ items: d.items.filter(i => i.id !== itemId), wires: d.wires.filter(w => w.a !== itemId && w.b !== itemId) }))
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
  editSpace(nodeId, d => ({ ...d, wires: d.wires.filter(w => w.id !== wireId) }))
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

/** State cards whose state decks hold `card` pick that state. */
function followOnStateCards(card: string): void {
  const groups = useBoardsStore.getState().groups
  for (const sc of groups) {
    const m = sc.stateCard
    if (!m) continue
    const st = m.states.find(s => s.deck && deckCards(groups, s.deck).includes(card))
    if (st && m.current !== st.id) pickState(sc.id, st.id)
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
