// State cards (Brian 2026-11-08). A State card is a workshop: its face
// lists the STATES a thing can be in (Whole, Chipped, Broken...) and the
// CHANGES that take it from one to another ("Hero drops it"). Each state is
// a MASTER deck on the canvas, where the real cards for it live (the cup's
// pattern, a shard's texture, the broken edge close up). The card's OUTPUT
// is one deck of linked cards (utils/linkedCards) that always shows the
// current state's master cards: pick another state and it reforms. That
// clean deck is the one used in charts, storylines and scene cards, and it
// keeps its front card (the same card id) through every reform, so
// whatever holds it keeps holding it.
//
// The current state is picked by name from a plain list in the card's
// header (StatePicker); states can be grouped under another state.
// Data: ProjectGroup.stateCard on the State card; ProjectGroup.stateOut on
// each card of its output deck (the State card's id).

import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { cardVisualRect } from '../hooks/useCardDecks'
import { rowOf } from './primaryCard'
import { makeLinkedCard, masterOf } from './linkedCards'
import { createCardOrBoardAt } from './canvasCreate'
import { newDetailId } from './cardTypes'
import { isShut, shownFront } from './deckTree'

export interface CardState {
  id: string
  name: string
  /** The front card of its master deck (any card of the deck will do). */
  deck?: string
  /** Grouped under this state, in the picker and on the face. */
  parent?: string
}

export interface StateChange {
  id: string
  name: string
  from?: string
  to?: string
}

export interface StateMachine {
  states: CardState[]
  changes: StateChange[]
  /** The state the output deck shows. */
  current?: string
  /** The output deck's front card. */
  output?: string
}

export const emptyStates = (): StateMachine => ({ states: [], changes: [] })

/** (utils/deckTree: the one test for a card closed up.) */
const closed = isShut
/** Gap between cards of a row so they touch (useCardDecks TOUCH_TOLERANCE 16). */
const TOUCH_GAP = 8

/** States in list order: each followed by the ones grouped under it. */
export function stateTree(m: StateMachine): { s: CardState; depth: number }[] {
  const out: { s: CardState; depth: number }[] = []
  const ids = new Set(m.states.map(s => s.id))
  const walk = (parent: string | undefined, depth: number) => {
    for (const s of m.states) {
      const p = s.parent && ids.has(s.parent) ? s.parent : undefined
      if (p !== parent) continue
      out.push({ s, depth })
      if (depth < 8) walk(s.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return out
}

/** The cards of the deck card `id` is in: the front first, then the rest
 *  in deck order. A card in no deck is a deck of one. Output cards and
 *  State cards never count. */
export function deckCards(groups: ProjectGroup[], id: string | undefined): string[] {
  if (!id) return []
  const byId = new Map(groups.map(g => [g.id, g]))
  let g = byId.get(id)
  for (let i = 0; g && closed(g) && g.deckAnchorId && g.deckAnchorId !== g.id && i < 32; i++) g = byId.get(g.deckAnchorId)
  if (!g) return []
  let ids: string[]
  if (closed(g)) {
    const set = new Set([g.id])
    let grew = true
    while (grew) {
      grew = false
      for (const o of groups) if (!set.has(o.id) && closed(o) && o.deckAnchorId && set.has(o.deckAnchorId)) { set.add(o.id); grew = true }
    }
    const front = g
    const off = (o: ProjectGroup) => [o.deckOffsetX ?? o.originX - front.originX, o.deckOffsetY ?? o.originY - front.originY]
    ids = [front.id, ...[...set].filter(x => x !== front.id).sort((a, b) => {
      const [ax, ay] = off(byId.get(a)!), [bx, by] = off(byId.get(b)!)
      return Math.abs(ax - bx) > 1 ? ax - bx : ay - by
    })]
  } else {
    const row = rowOf(g.id)
    ids = row && row.length > 1 ? row : [g.id]
  }
  return ids.filter(x => { const c = byId.get(x); return c && !c.stateOut && c.cardType !== 'state' })
}

/** The cards of a State card's output deck, its front first. */
export function outputCards(groups: ProjectGroup[], stateId: string): ProjectGroup[] {
  const sc = groups.find(g => g.id === stateId)
  const front = sc?.stateCard?.output
  const mine = groups.filter(g => g.stateOut === stateId)
  const f = mine.find(g => g.id === front)
  const rest = mine.filter(g => g !== f).sort((a, b) => {
    const ax = a.deckOffsetX ?? a.originX, bx = b.deckOffsetX ?? b.originX
    return Math.abs(ax - bx) > 1 ? ax - bx : (a.deckOffsetY ?? a.originY) - (b.deckOffsetY ?? b.originY)
  })
  return f ? [f, ...rest] : rest
}

/** The master cards the output deck should show now. */
function wanted(groups: ProjectGroup[], sc: ProjectGroup): string[] {
  const m = sc.stateCard
  const cur = m?.states.find(s => s.id === m.current)
  return deckCards(groups, cur?.deck).map(id => masterOf(groups, id))
}

const sig = (groups: ProjectGroup[], sc: ProjectGroup) => {
  const cur = sc.stateCard?.states.find(s => s.id === sc.stateCard?.current)
  return `${sc.stateCard?.current ?? ''}|${cur?.name ?? ''}|${wanted(groups, sc).join(',')}`
}

/** Does the output deck show what it should? */
function upToDate(groups: ProjectGroup[], sc: ProjectGroup): boolean {
  const want = wanted(groups, sc)
  const have = outputCards(groups, sc.id)
  if (want.length === 0) return have.length === 1 && !have[0].linkOf && have[0].stateBlank === sc.stateCard?.current
  return have.length === want.length && have.every((g, i) => g.linkOf === want[i])
}

export function setStates(id: string, m: StateMachine): void {
  useBoardsStore.setState(s => ({ groups: s.groups.map(g => g.id === id ? { ...g, stateCard: m } : g) }))
}
const machineOf = (id: string) => useBoardsStore.getState().groups.find(g => g.id === id)?.stateCard

/** Per-showing fields an output card keeps when it takes another master's
 *  face: where it is and which deck it is in. */
const KEEP = ['id', 'originX', 'originY', 'deckState', 'deckAnchorId', 'deckOffsetX', 'deckOffsetY',
  'deckLastFront', 'deckLock', 'ghostSlots', 'flipped', 'pin', 'home', 'pinnedLayer', 'wasOnStoryline'] as const

/** A card for the output: a linked card of `master`, or, with none, a
 *  blank card saying the state has no cards yet. */
function sourceCard(sc: ProjectGroup, master: string | undefined): string | null {
  if (master) return makeLinkedCard(master)
  const boardId = createCardOrBoardAt(undefined, { noCheckpoint: true })
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.boardIds.includes(boardId))
  if (!g) return null
  const cur = sc.stateCard?.states.find(s => s.id === sc.stateCard?.current)
  bs.renameGroup(g.id, sc.name)
  bs.setGroupCardHeaderText(g.id, sc.name)
  bs.setGroupCardText(g.id, cur ? `${cur.name}: no cards yet` : 'No state picked')
  useBoardsStore.setState(s => ({ groups: s.groups.map(x => x.id === g.id ? { ...x, stateBlank: sc.stateCard?.current ?? '' } : x) }))
  return g.id
}

/** Card `slot` takes on everything card `from` is (and its blocks), keeping
 *  its own place and deck; `from` is used up. Its old blocks go. */
function transplant(slot: string, from: string): void {
  const bs = useBoardsStore.getState()
  const old = bs.groups.find(g => g.id === slot)
  const src = bs.groups.find(g => g.id === from)
  if (!old || !src) return
  const keep: Record<string, unknown> = {}
  for (const k of KEEP) keep[k] = old[k]
  const next = { ...src, ...keep, stateOut: old.stateOut, stateBlank: src.stateBlank } as ProjectGroup
  useBoardsStore.setState(s => ({ groups: s.groups.filter(g => g.id !== from).map(g => g.id === slot ? next : g) }))
  const gone = old.boardIds.filter(b => !next.boardIds.includes(b))
  for (const b of gone) useBoardsStore.getState().deleteBoard(b)
}

/** Lay `ids` out as a row of touching cards from the first card's place,
 *  then, if it was closed (or is new), close it onto the first. */
function layRow(ids: string[], close: 'stacked' | 'fanned' | null): void {
  const zoom = useCanvasStore.getState().zoom
  const bs = useBoardsStore.getState()
  // Open first: every card on its own, with no deck.
  useBoardsStore.setState(s => ({ groups: s.groups.map(g => !ids.includes(g.id) ? g : {
    ...g, deckState: undefined, deckAnchorId: undefined, deckOffsetX: undefined, deckOffsetY: undefined, deckFaceCard: undefined, ghostSlots: undefined,
  }) }))
  const groups = () => useBoardsStore.getState().groups
  const front = groups().find(g => g.id === ids[0])
  const fr = front && cardVisualRect(front, bs.boards, zoom)?.rect
  if (!front || !fr) return
  let x = fr.right + TOUCH_GAP
  const moves: { groupId: string; originX: number; originY: number }[] = []
  for (const id of ids.slice(1)) {
    const g = groups().find(o => o.id === id)
    const r = g && cardVisualRect(g, useBoardsStore.getState().boards, zoom)?.rect
    if (!g || !r) continue
    moves.push({ groupId: id, originX: g.originX + (x - r.left), originY: g.originY + (fr.top - r.top) })
    x += (r.right - r.left) + TOUCH_GAP
  }
  if (moves.length) useBoardsStore.getState().setGroupPosBatch(moves)
  if (close && ids.length > 1) useBoardsStore.getState().setDeckState(ids, close, { asGiven: true })
}

/** Reforms State card `id`'s output deck to its current state. The front
 *  card stays the same card. No undo step of its own. */
export function reformOutput(id: string): void {
  const bs = useBoardsStore.getState()
  const sc = bs.groups.find(g => g.id === id)
  const m = sc?.stateCard
  if (!sc || !m?.output) return
  const front = bs.groups.find(g => g.id === m.output)
  if (!front) return
  if (upToDate(bs.groups, sc)) return
  const was = closed(front) ? (front.deckState as 'stacked' | 'fanned') : outputCards(bs.groups, id).length > 1 ? null : 'stacked'
  const want = wanted(bs.groups, sc)
  const slots = outputCards(bs.groups, id).map(g => g.id)
  const n = Math.max(1, want.length)
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const src = sourceCard(sc, want[i])
    if (!src) continue
    if (slots[i]) { transplant(slots[i], src); ids.push(slots[i]) }
    else {
      const f = useBoardsStore.getState().groups.find(g => g.id === m.output)!
      useBoardsStore.setState(s => ({ groups: s.groups.map(g => g.id === src ? { ...g, stateOut: id, originX: f.originX, originY: f.originY } : g) }))
      ids.push(src)
    }
  }
  // Cards it no longer needs go, blocks and all.
  for (const extra of slots.slice(n)) {
    const g = useBoardsStore.getState().groups.find(o => o.id === extra)
    for (const b of g?.boardIds ?? []) useBoardsStore.getState().deleteBoard(b)
    useBoardsStore.setState(s => ({ groups: s.groups.filter(o => o.id !== extra) }))
  }
  layRow(ids, was)
}

/** Pick state `stateId` on State card `id`: its output reforms. One undo. */
export function pickState(id: string, stateId: string): void {
  const m = machineOf(id)
  if (!m || m.current === stateId) return
  useUndoCoordinator.getState().checkpoint()
  setStates(id, { ...m, current: stateId })
  reformOutput(id)
}

/** Where the State card is on the canvas (visual rectangle). */
function rectOf(id: string) {
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.id === id)
  return g ? cardVisualRect(g, bs.boards, useCanvasStore.getState().zoom)?.rect ?? null : null
}

/** Makes the output deck, right of the State card. One undo. */
export function makeOutput(id: string): void {
  const sc = useBoardsStore.getState().groups.find(g => g.id === id)
  const m = sc?.stateCard
  if (!sc || !m) return
  if (m.output && useBoardsStore.getState().groups.some(g => g.id === m.output)) return
  useUndoCoordinator.getState().checkpoint()
  const r = rectOf(id)
  const boardId = createCardOrBoardAt(r ? { cx: r.right + (r.right - r.left) * 0.9, cy: (r.top + r.bottom) / 2 } : undefined, { noCheckpoint: true })
  const g = useBoardsStore.getState().groups.find(x => x.boardIds.includes(boardId))
  if (!g) return
  useBoardsStore.setState(s => ({ groups: s.groups.map(x => x.id === g.id ? { ...x, stateOut: id } : x) }))
  setStates(id, { ...m, current: m.current ?? m.states[0]?.id, output: g.id })
  // A blank stand-in until the reform gives it its face.
  reformOutput(id)
}

/** A new state, with a new blank card under the State card as its master
 *  deck (or `deck`, the deck a card was let go from). One undo. */
export function addState(id: string, opts: { parent?: string; deck?: string } = {}): string | null {
  const bs = useBoardsStore.getState()
  const sc = bs.groups.find(g => g.id === id)
  const m = sc?.stateCard
  if (!sc || !m) return null
  useUndoCoordinator.getState().checkpoint()
  const parent = opts.parent ? m.states.find(s => s.id === opts.parent) : undefined
  const fromDeck = opts.deck ? bs.groups.find(g => g.id === opts.deck) : undefined
  let name = fromDeck?.name || (parent ? `${parent.name} ${m.states.filter(s => s.parent === parent.id).length + 1}` : `State ${m.states.length + 1}`)
  if (m.states.some(s => s.name === name)) name = `${name} ${m.states.length + 1}`
  let deck = opts.deck
  if (!deck) {
    // Its master deck starts as one blank card, in the line of state decks
    // under the card: right of the last one (under the card when none).
    const r = rectOf(id)
    const w = r ? r.right - r.left : 300
    const decks = m.states.flatMap(s => { const d = s.deck ? rectOf(s.deck) : null; return d && r && d.top >= r.bottom ? [d] : [] })
    const last = decks.reduce<typeof decks[number] | null>((a, b) => (!a || b.right > a.right ? b : a), null)
    const at = last
      ? { cx: last.right + w * 0.6 + w / 2, cy: (last.top + last.bottom) / 2 }
      : r ? { cx: r.left + w / 2, cy: r.bottom + (r.bottom - r.top) * 0.75 } : undefined
    const boardId = createCardOrBoardAt(at, { noCheckpoint: true })
    const g = useBoardsStore.getState().groups.find(x => x.boardIds.includes(boardId))
    if (g) {
      useBoardsStore.getState().renameGroup(g.id, `${sc.name} · ${name}`)
      useBoardsStore.getState().setGroupCardHeaderText(g.id, name)
      deck = g.id
    }
  }
  const s: CardState = { id: newDetailId(), name, deck, parent: parent?.id }
  setStates(id, { ...m, states: [...m.states, s], current: m.current ?? s.id })
  reformOutput(id)
  return s.id
}

/** State `stateId` shows the deck card `deck` is in. One undo. */
export function setStateDeck(id: string, stateId: string, deck: string): void {
  const m = machineOf(id)
  if (!m) return
  useUndoCoordinator.getState().checkpoint()
  setStates(id, { ...m, states: m.states.map(s => s.id === stateId ? { ...s, deck } : s) })
  reformOutput(id)
}

/** Change State card `id`'s states/changes with one undo step. */
export function editStates(id: string, f: (m: StateMachine) => StateMachine): void {
  const m = machineOf(id)
  if (!m) return
  useUndoCoordinator.getState().checkpoint()
  setStates(id, f(m))
  reformOutput(id)
}

/** Takes a state off the card (its deck stays on the canvas), and the
 *  states grouped under it move up. */
export function removeState(m: StateMachine, stateId: string): StateMachine {
  const s = m.states.find(x => x.id === stateId)
  const states = m.states.filter(x => x.id !== stateId).map(x => x.parent === stateId ? { ...x, parent: s?.parent } : x)
  return {
    ...m, states,
    changes: m.changes.map(c => ({ ...c, from: c.from === stateId ? undefined : c.from, to: c.to === stateId ? undefined : c.to })),
    current: m.current === stateId ? states[0]?.id : m.current,
  }
}

/** Jump the canvas to a card (to its deck's front when it is hidden in one). */
export function goToCard(cardId: string): void {
  const gs = useBoardsStore.getState().groups
  const at = gs.find(g => g.id === cardId)
  const to = at && shownFront(at, gs)
  if (!to) return
  useCanvasStore.getState().jumpToGroup(to.id)
  useBoardsStore.getState().setSelectedGroup(to.id)
}

// ── Live: the output follows its state's master deck ──
// Cards put in (or taken out of) the current state's deck show up in the
// output a moment after the hand lets go. Never mid-drag.

let started = false
export function startStateOutputs(): void {
  if (started) return
  started = true
  let pressing = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const tried = new Map<string, string>()
  window.addEventListener('pointerdown', () => { pressing = true }, true)
  window.addEventListener('pointerup', () => { pressing = false; schedule() }, true)
  window.addEventListener('pointercancel', () => { pressing = false }, true)
  const run = () => {
    timer = null
    if (pressing) return
    const groups = useBoardsStore.getState().groups
    for (const sc of groups) {
      if (!sc.stateCard?.output || !groups.some(g => g.id === sc.stateCard!.output)) continue
      if (upToDate(groups, sc)) { tried.delete(sc.id); continue }
      // Once per change of what it should show: never a loop of retries.
      const k = sig(groups, sc)
      if (tried.get(sc.id) === k) continue
      tried.set(sc.id, k)
      reformOutput(sc.id)
    }
  }
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(run, 400) }
  let prev = useBoardsStore.getState().groups
  useBoardsStore.subscribe(s => {
    if (s.groups === prev) return
    prev = s.groups
    if (s.groups.some(g => g.stateCard?.output)) schedule()
  })
}

// ── Changes in the story (Brian 2026-11-08) ──
// A change can be put on a scene card (any card) or on a storyline dot:
// that is where in the story it happens. A storyline's time marker, dragged
// along its base, makes every change up to it in order (left to right), so
// the output decks reform as it passes scenes and dots; dragged back, they
// go back. Nothing is written into the cards: only which state is current.

/** A change put somewhere in the story: State card `state`, its change `change`. */
export interface StateMark { state: string; change: string }

/** Pick a state with no undo step of its own (the time marker's drag took one). */
export function applyState(id: string, stateId: string): void {
  const m = machineOf(id)
  if (!m || m.current === stateId || !m.states.some(s => s.id === stateId)) return
  setStates(id, { ...m, current: stateId })
  reformOutput(id)
}

/** The change a mark points at, with its State card. */
export function markChange(groups: ProjectGroup[], k: StateMark): { sc: ProjectGroup; change: StateChange } | null {
  const sc = groups.find(g => g.id === k.state)
  const change = sc?.stateCard?.changes.find(c => c.id === k.change)
  return sc && change ? { sc, change } : null
}

/** "Cup → Broken": what a mark's tag says. */
export function markLabel(groups: ProjectGroup[], k: StateMark): string | null {
  const hit = markChange(groups, k)
  if (!hit) return null
  const to = hit.sc.stateCard!.states.find(s => s.id === hit.change.to)?.name ?? '?'
  return `${hit.sc.name || 'State'} → ${to}`
}

/** Every change on every State card, for the list they are put on from. */
export function allChanges(groups: ProjectGroup[]): { sc: ProjectGroup; change: StateChange }[] {
  return groups.flatMap(sc => sc.cardType === 'state' && sc.stateCard ? sc.stateCard.changes.map(change => ({ sc, change })) : [])
}

export const hasMark = (list: StateMark[] | undefined, k: StateMark) => !!list?.some(x => x.state === k.state && x.change === k.change)
export function toggleMark(list: StateMark[] | undefined, k: StateMark): StateMark[] | undefined {
  const next = hasMark(list, k) ? list!.filter(x => !(x.state === k.state && x.change === k.change)) : [...(list ?? []), k]
  return next.length ? next : undefined
}

/** Put a change on card `cardId` or take it off. One undo. */
export function toggleCardMark(cardId: string, k: StateMark): void {
  useUndoCoordinator.getState().checkpoint()
  useBoardsStore.setState(s => ({ groups: s.groups.map(g => g.id === cardId ? { ...g, stateChanges: toggleMark(g.stateChanges, k) } : g) }))
}

/** Make the changes at or before `at` (story order: x, then as listed);
 *  before the first, each thing is in the state its first change starts
 *  from. Each State card involved picks its state. */
export function playMarks(events: { x: number; marks: StateMark[] }[], at: number): void {
  const groups = useBoardsStore.getState().groups
  const per = new Map<string, { x: number; change: StateChange }[]>()
  events.forEach(ev => ev.marks.forEach(k => {
    const hit = markChange(groups, k)
    if (!hit) return
    per.set(k.state, [...(per.get(k.state) ?? []), { x: ev.x, change: hit.change }])
  }))
  for (const [id, list] of per) {
    const sorted = list.map((e, i) => ({ ...e, i })).sort((a, b) => a.x - b.x || a.i - b.i)
    const done = sorted.filter(e => e.x <= at)
    const m = groups.find(g => g.id === id)?.stateCard
    const target = done.length ? done[done.length - 1].change.to : sorted[0].change.from ?? m?.states[0]?.id
    if (target) applyState(id, target)
  }
}
