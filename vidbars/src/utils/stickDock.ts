// stickDock.ts — a measuring stick docked to cards (Brian 2026-11-18:
// "make the measuring stick dockable... if that something has a scale
// associated with it (as a detail on its card, the character's height),
// then their size in the 3D view would measure up properly to the
// measuring stick's size"). Worked out from where things are, never
// stored (as every docking here): a stick whose feet stand on or by a
// card (within about a foot of it, at the stick's size) is docked to it
// and to the cards touching that one (a deck, an open row of cards).
//  - In 3D each of those cards' models stands as tall as the Height on
//    its card's back says, at the stick's scale: Shift-drag the stick's
//    board and they all size with it; change a card's Height and that
//    one does.
//  - A card with no Height starts from the size its model has: the stick
//    remembers how tall that is against it (Stick.heights), so it sizes
//    with the others, until the stick leaves it.
//  - Sizing a docked card's model by hand (dragging it in 3D) changes
//    its height: written as the Height on its card's back (Brian
//    2026-11-18: "If I then click on a model and scale it up and down I
//    should be changing the model's height").
//  - A docked stick goes with its card when the card is moved.

import { useNotesStore, type Stick } from '../store/notesStore'
import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useModelScaleStore } from '../store/tiltStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { dockedCards } from './filmShots'
import { detailShown, newDetailId } from './cardTypes'
import { DOCK_LINE, SIGN_W, SIGN_H, parseHeight, heightText, unitText, heightWritten, isHeightName, type Side } from './stickGeom'
import { useUnits } from '../store/unitsStore'
import type { CardDetail } from './cardTypes'
import { cardScreenRect } from '../components/Layers/CardLayer'
import { isHiddenDeckMember } from '../hooks/useCardDecks'
import { dataKey } from './area3dScene'
import { useUndoCoordinator, isUndoRestoring } from '../store/undoCoordinator'
import { useWorldScale } from './worldScale'

/** How far round its foot a stick reaches for a card, feet. */
const REACH = 1.2

/** The cards a stick is docked to: under or by its feet, and the deck
 *  they are in. */
export function stickCards(s: Stick): ProjectGroup[] {
  const bs = useBoardsStore.getState()
  const r = REACH * s.per
  return dockedCards({ x: s.x - r, y: s.y - r, width: r * 2, height: r * 2 } as FreeNodeData, bs.groups, bs.boards)
}

type Box = { l: number; t: number; r: number; b: number }
/** A card's face, canvas units, at the zoom it is drawn at. */
function cardBox(g: ProjectGroup): Box | null {
  const zoom = useCanvasStore.getState().zoom || 1
  const r = cardScreenRect(g, useBoardsStore.getState().boards, { x: 0, y: 0 }, zoom)
  return r && { l: r.screenLeft / zoom, t: r.screenTop / zoom, r: (r.screenLeft + r.screenWidth) / zoom, b: (r.screenTop + r.screenHeight) / zoom }
}
/** The nearest place on a box's edge to a point, which side it is on,
 *  and how far. */
function nearEdge(b: Box, x: number, y: number): { x: number; y: number; side: Side; d: number } {
  const cx = Math.max(b.l, Math.min(b.r, x)), cy = Math.max(b.t, Math.min(b.b, y))
  const c: { x: number; y: number; side: Side; d: number }[] = [
    { x: cx, y: b.t, side: 'top', d: 0 }, { x: cx, y: b.b, side: 'bottom', d: 0 },
    { x: b.l, y: cy, side: 'left', d: 0 }, { x: b.r, y: cy, side: 'right', d: 0 },
  ]
  for (const p of c) p.d = Math.hypot(p.x - x, p.y - y)
  return c.reduce((a, p) => p.d < a.d ? p : a)
}

/** How near a card's edge (screen px) a stick being moved jumps onto it. */
const SNAP_PX = 22
/** Where a stick let go at (x, y) sits: on the nearest card edge within
 *  reach, its flat side to it; else where it is. */
export function snapTab(x: number, y: number): { x: number; y: number } {
  const zoom = useCanvasStore.getState().zoom || 1
  let best: { x: number; y: number; d: number } | null = null
  for (const g of useBoardsStore.getState().groups) {
    if (g.pin || isHiddenDeckMember(g)) continue
    const b = cardBox(g)
    if (!b) continue
    const e = nearEdge(b, x, y)
    if (e.d * zoom <= SNAP_PX && (!best || e.d < best.d)) best = e
  }
  return best ? { x: best.x, y: best.y } : { x, y }
}

/** The card a card's back is read from (a linked card's is its master's). */
const masterOf = (g: ProjectGroup, groups: ProjectGroup[]) => (g.linkOf && groups.find(x => x.id === g.linkOf)) || g
const heightRow = (g: ProjectGroup) => g.details?.find(x => isHeightName(x.name))
/** Where a card's height is kept: its own Height row, or, that row
 *  sharing another card's (linked to it, utils/detailMerge), that one. */
function heightSpot(g: ProjectGroup, groups: ProjectGroup[]): { card: ProjectGroup; row?: CardDetail } {
  let card = masterOf(g, groups), row = heightRow(card)
  const seen = new Set<string>()
  while (row?.link?.detail && !seen.has(row.id)) {
    seen.add(row.id)
    const c = groups.find(x => x.id === row!.link!.card)
    const r = c?.details?.find(x => x.id === row!.link!.detail)
    if (!c || !r) break
    card = c; row = r
  }
  return { card, row }
}
/** Write card `g`'s height (feet), where it is kept, in the app's units.
 *  A card with no Height row gets one. The caller takes the undo step. */
export function setCardHeight(g: ProjectGroup, ft: number) {
  const bs = useBoardsStore.getState()
  const { card, row } = heightSpot(g, bs.groups)
  const value = heightWritten(ft, useUnits.getState().metric)
  const details = row
    ? (card.details ?? []).map(d => d.id === row.id ? { ...d, value, link: undefined } : d)
    : [...(card.details ?? []), { id: newDetailId(), name: 'Height', value }]
  if (!row || row.value !== value || row.link) bs.setGroupDetails(card.id, details)
}
/** The Height on a card's back, feet. */
export function cardHeight(g: ProjectGroup, groups: ProjectGroup[]): number | null {
  const d = heightRow(masterOf(g, groups))
  return d ? parseHeight(detailShown(groups, d).text) : null
}

// ── Emphasis (Brian 2026-11-19: "we just make an `emphasis` attribute. And
// if I hand-scale a model outside of a distance tool, then that's going to
// make an emphasis attribute and put that scale adjustment as an offset
// of its height ... it's easy to clear because you can delete attributes
// simply on the back of the card"). A row on the card's back, a percent:
// +50% shows its model half as big again, its Height untouched. ──
export const isEmphasisName = (name: string | undefined) => (name ?? '').trim().toLowerCase() === 'emphasis'
/** What an Emphasis row says, as a size: "+50%" 1.5, "-20" 0.8. Unread: 1. */
export function parseEmphasis(text: string | undefined): number {
  const m = /^\s*([+-]?\d+(?:[.,]\d+)?)\s*%?\s*$/.exec(text ?? '')
  if (!m) return 1
  return Math.max(0.05, 1 + parseFloat(m[1].replace(',', '.')) / 100)
}
/** How much bigger than true a card's model shows (1: true size). */
export function cardEmphasis(g: ProjectGroup, groups: ProjectGroup[]): number {
  const d = masterOf(g, groups).details?.find(x => isEmphasisName(x.name))
  return d ? parseEmphasis(detailShown(groups, d).text) : 1
}
/** Write card `g`'s emphasis (a size, 1.5 = +50%) on its back; a card with
 *  no Emphasis row gets one. The caller takes the undo step. */
export function setCardEmphasis(g: ProjectGroup, k: number) {
  const bs = useBoardsStore.getState()
  const card = masterOf(g, bs.groups)
  const pct = Math.round((k - 1) * 100)
  const value = `${pct >= 0 ? '+' : ''}${pct}%`
  const row = card.details?.find(x => isEmphasisName(x.name))
  if (row && row.value === value && !row.link) return
  bs.setGroupDetails(card.id, row
    ? (card.details ?? []).map(d => d.id === row.id ? { ...d, value, link: undefined } : d)
    : [...(card.details ?? []), { id: newDetailId(), name: 'Emphasis', value }])
}

interface Measured {
  /** How tall each docked card's model stands, canvas units, by card id. */
  heights: Map<string, number>
  /** The docked cards with no height yet (none on their back, none
   *  remembered): the stick each is docked to. */
  bare: Map<string, string>
  /** Every docked card's stick. */
  owner: Map<string, string>
  /** The sticks that are docked. */
  docked: Set<string>
  /** The side of its card each docked stick is on, and its place on
   *  that edge (docked, a stick is drawn on the edge, wherever by it it
   *  was put down). */
  sides: Map<string, Side>
  at: Map<string, { x: number; y: number }>
  /** The middle of its mount line on that edge. The line keeps to the
   *  edge (it stops at the edge's ends); the stick slides along the line
   *  to its ends (Brian 2026-11-19). */
  line: Map<string, { x: number; y: number }>
  /** Changes when any of it does. */
  sig: number
}
let memo: { sticks: unknown; groups: unknown; boards: unknown; zoom: number; out: Measured } | null = null
let sigSeq = 0
const sameMap = <V,>(a: Map<string, V>, b: Map<string, V>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)

/** Every docked stick's cards and how tall their models stand. */
export function stickMeasures(): Measured {
  const sticks = useNotesStore.getState().sticks ?? {}
  const bs = useBoardsStore.getState()
  const zoom = useCanvasStore.getState().zoom
  if (memo && memo.sticks === sticks && memo.groups === bs.groups && memo.boards === bs.boards && memo.zoom === zoom) return memo.out
  const heights = new Map<string, number>(), bare = new Map<string, string>(), owner = new Map<string, string>()
  const docked = new Set<string>(), sides = new Map<string, Side>(), at = new Map<string, { x: number; y: number }>(), line = new Map<string, { x: number; y: number }>()
  for (const s of Object.values(sticks)) {
    const cards = stickCards(s)
    if (cards.length) docked.add(s.id)
    // The side of the nearest of them it is on.
    let near: { x: number; y: number; side: Side; d: number } | null = null, nearBox: Box | null = null
    const boxes: Box[] = []
    for (const g of cards) {
      if (isHiddenDeckMember(g)) continue
      const b = cardBox(g)
      if (!b) continue
      boxes.push(b)
      const e = nearEdge(b, s.x, s.y)
      if (!near || e.d < near.d) { near = e; nearBox = b }
    }
    if (near && nearBox) {
      const side = near.side, across = side === 'top' || side === 'bottom'
      sides.set(s.id, side)
      // The edge it is on, run on along the cards in line with that one.
      const edgeOf = (b: Box) => side === 'top' ? b.t : side === 'bottom' ? b.b : side === 'left' ? b.l : b.r
      const e0 = edgeOf(nearBox)
      let lo = across ? nearBox.l : nearBox.t, hi = across ? nearBox.r : nearBox.b
      for (const b of boxes) {
        if (Math.abs(edgeOf(b) - e0) > 1) continue
        lo = Math.min(lo, across ? b.l : b.t); hi = Math.max(hi, across ? b.r : b.b)
      }
      // The line goes along with the stick until its end is at the
      // edge's; the stick goes on to the line's end.
      const L = DOCK_LINE * s.per, half = (across ? SIGN_W : SIGN_H) * s.per
      const t = across ? s.x : s.y
      const c = hi - lo > L ? Math.max(lo + L / 2, Math.min(hi - L / 2, t)) : (lo + hi) / 2
      const tt = Math.max(c - L / 2 + half, Math.min(c + L / 2 - half, t))
      at.set(s.id, across ? { x: tt, y: e0 } : { x: e0, y: tt })
      line.set(s.id, across ? { x: c, y: e0 } : { x: e0, y: c })
    }
    for (const g of cards) {
      if (owner.has(g.id)) continue
      owner.set(g.id, s.id)
      const ft = cardHeight(g, bs.groups) ?? s.heights?.[g.id]
      if (ft) heights.set(g.id, ft * s.per); else bare.set(g.id, s.id)
    }
  }
  const was = memo?.out
  const same = !!was && was.docked.size === docked.size && [...docked].every(id => was.docked.has(id))
    && sameMap(was.heights, heights) && sameMap(was.bare, bare) && sameMap(was.owner, owner) && sameMap(was.sides, sides)
    && at.size === was.at.size && [...at].every(([k, p]) => was.at.get(k)?.x === p.x && was.at.get(k)?.y === p.y)
    && [...line].every(([k, p]) => was.line.get(k)?.x === p.x && was.line.get(k)?.y === p.y)
  const out = same ? was! : { heights, bare, owner, docked, sides, at, line, sig: ++sigSeq }
  memo = { sticks, groups: bs.groups, boards: bs.boards, zoom, out }
  return out
}

// ── How tall a card's 3D model stands: THE rule (Brian 2026-11-24, after
// the look back over the week: one drag meant a Height here, a hidden size
// there, and a stick set beside a card dropped its Emphasis). Asked by the
// 3D view to draw it (TiltModels frameState) and by the hand that sizes it
// (TiltedView), so what a drag writes is always what is drawn:
//  - 'stick': docked to a measuring stick with a height to go by (the
//    Height on its back, or what that stick remembers of it): that height
//    at the stick's scale. A hand's sizing writes its Height.
//  - 'world': a Height on its back and a world scale set: that height at
//    the world's scale. A hand's sizing writes its Emphasis.
//  - 'hand': neither: the size it was given by hand (tiltStore sizeOf).
// Its card's Emphasis is on top of all three alike, unless True size is on.
// Not a 3D model standing in a 3D set, nor a scene section's: those have
// sizes of their own there. ──
export interface Stand {
  by: 'stick' | 'world' | 'hand'
  /** How tall it stands at its true size, canvas units ('stick', 'world'). */
  tall?: number
  /** Its card's Emphasis (1: none). */
  emph: number
  /** The stick it is docked to, with or without a height to go by. */
  stick?: string
}
const lookCard = (id: string): { ft: number | null; emph: number } => {
  const groups = useBoardsStore.getState().groups, g = groups.find(x => x.id === id)
  return g ? { ft: cardHeight(g, groups), emph: cardEmphasis(g, groups) } : { ft: null, emph: 1 }
}
/** Card `shown`'s 3D model (a deck's front card `front` showing it: the
 *  stick may be docked to either). `look`: a card's Height (feet) and
 *  Emphasis, for a caller that keeps them worked out. */
export function standOf(shown: string, front: string = shown, look: (id: string) => { ft: number | null; emph: number } = lookCard): Stand {
  const m = stickMeasures()
  const stick = m.owner.get(shown) ?? m.owner.get(front)
  const l = look(shown)
  if (stick) {
    const tall = m.heights.get(shown) ?? m.heights.get(front)
    return tall ? { by: 'stick', tall, emph: l.emph, stick } : { by: 'hand', emph: l.emph, stick }
  }
  const per = useWorldScale.getState().per
  return per !== null && l.ft ? { by: 'world', tall: l.ft * per, emph: l.emph } : { by: 'hand', emph: l.emph }
}
/** A hand sizing docked card `id`'s 3D model: the height it began from,
 *  feet (null: it has none to go by). */
export function dockedHeight(id: string): number | null {
  const m = stickMeasures(), s = useNotesStore.getState().sticks?.[m.owner.get(id) ?? '']
  const units = m.heights.get(id)
  return s && units ? units / s.per : null
}

/** Where a stick is: docked, on the edge it is docked by. */
export const stickPoint = (s: Stick): { x: number; y: number } => stickMeasures().at.get(s.id) ?? { x: s.x, y: s.y }

/** The marks' colour (Brian 2026-11-19: "instead of being black, let's
 *  have them be yellow. So they fit in with the orange and the white
 *  theme"). They were each card's own colour. */
const MARK_YELLOW = '#ffd23f'

/** A selected card of a stick's group: how tall it is against the stick. */
export interface StickMark { id: string; ft: number; color: string; text: string
  /** No height yet: its mark waits at the stick's top to be dragged to one. */
  unset?: boolean }
/** The marks on a stick: one for each selected card docked to it that
 *  has a height (Brian 2026-11-19: "if you have a card selected... it'll
 *  show a mark on the measure stick"), shortest first. */
export function stickMarks(s: Stick): StickMark[] {
  const m = stickMeasures()
  const bs = useBoardsStore.getState()
  const out: StickMark[] = []
  const metric = useUnits.getState().metric
  for (const picked of bs.selectedGroupIds) {
    // (A deck's front card showing another of its cards: that card's height.)
    const id = dataKey(`card:${picked}`).slice(5)
    if (m.owner.get(id) !== s.id) continue
    const units = m.heights.get(id)
    // (Any card can have a height: one with none yet has its mark at the
    // stick's top, to be dragged to one. Brian 2026-11-19.)
    if (!units) { out.push({ id, ft: s.ft, color: MARK_YELLOW, text: '?', unset: true }); continue }
    const ft = units / s.per
    out.push({ id, ft, color: MARK_YELLOW, text: heightText({ ft, metric }) })
  }
  return out.sort((a, b) => a.ft - b.ft)
}
/** What a stick's tab says, flat: the height of the card picked in its
 *  group (of several, their average: Brian 2026-11-19); with none
 *  picked, its own. And the unit under it. */
export function tabText(s: Stick, all = stickMarks(s)): { text: string; unit: string } {
  const metric = useUnits.getState().metric
  const marks = all.filter(m => !m.unset)
  if (!marks.length) return { text: heightText({ ft: s.ft, metric }), unit: unitText({ metric }) }
  if (marks.length === 1) return { text: marks[0].text, unit: unitText({ metric }) }
  const ft = marks.reduce((a, m) => a + m.ft, 0) / marks.length
  return { text: heightText({ ft, metric }), unit: `${unitText({ metric })} AVG` }
}

// ── A card with no Height: where its model starts from ──
// The 3D view says how tall the model stands (canvas units) the first
// time it draws it docked; kept on the stick, in feet at its scale.
const seen = new Map<string, number>()
let settling = false
/** The 3D view: docked card `id`'s model stands `units` tall by itself. */
export function seenHeight(id: string, units: number) {
  if (!(units > 0)) return
  seen.set(id, units)
  if (settling) return
  settling = true
  queueMicrotask(() => { settling = false; settle() })
}
/** Keep what was seen, and let go of the cards a stick has left. */
function settle() {
  const m = stickMeasures()
  const sticks = useNotesStore.getState().sticks ?? {}
  for (const s of Object.values(sticks)) {
    let next: Record<string, number> | undefined
    for (const id of Object.keys(s.heights ?? {})) {
      if (m.owner.get(id) !== s.id) { next ??= { ...s.heights }; delete next[id] }
    }
    for (const [id, units] of seen) {
      if (m.bare.get(id) !== s.id) continue
      next ??= { ...s.heights }
      next[id] = units / s.per
    }
    if (next) useNotesStore.getState().updateStick(s.id, { heights: Object.keys(next).length ? next : undefined })
  }
  seen.clear()
}

// ── Sizing a docked model by hand changes its height ──
/** A hand's sizing in progress, by model key: the height and size it
 *  began from (so many small steps do not round away). */
const sizing = new Map<string, { ft0: number; k0: number; t: number }>()
function sized(key: string, was: number | undefined, now: number | undefined) {
  // (An undo putting a size back is not a hand sizing it.)
  if (!key.startsWith('card:') || !now || isUndoRestoring()) return
  const id = key.slice(5)
  const m = stickMeasures()
  const stick = useNotesStore.getState().sticks?.[m.owner.get(id) ?? '']
  if (!stick) return
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.id === id)
  if (!g) return
  const t = performance.now()
  let s = sizing.get(key)
  if (!s || t - s.t > 900) {
    const ft = cardHeight(g, bs.groups) ?? stick.heights?.[id]
    if (!ft) return
    s = { ft0: ft, k0: was ?? 1, t }
    // One sizing is one step back (Brian 2026-11-19: "need to be able to
    // undo a height change").
    useUndoCoordinator.getState().checkpoint()
    sizing.set(key, s)
  }
  s.t = t
  const ft = s.ft0 * now / s.k0
  setCardHeight(g, ft)
}

// A docked stick goes with its card. What each stick stands on (the
// nearest of its cards) and where that card was, kept from the last look:
// when the card has moved and the stick has not, the stick moves as far.
const anchors = new Map<string, { card: string; x: number; y: number; sx: number; sy: number }>()
function anchor() {
  anchors.clear()
  const sticks = useNotesStore.getState().sticks ?? {}
  if (!Object.keys(sticks).length) return
  const groups = useBoardsStore.getState().groups
  for (const s of Object.values(sticks)) {
    let best: ProjectGroup | null = null, bd = Infinity
    for (const g of stickCards(s)) {
      const d = Math.hypot(g.originX - s.x, g.originY - s.y)
      if (d < bd) { bd = d; best = g }
    }
    const g = best && groups.find(x => x.id === best!.id)
    if (g) anchors.set(s.id, { card: g.id, x: g.originX, y: g.originY, sx: s.x, sy: s.y })
  }
}
let following = false
function follow() {
  if (following) return
  const groups = useBoardsStore.getState().groups
  const sticks = useNotesStore.getState().sticks ?? {}
  const moves: { id: string; x: number; y: number }[] = []
  for (const [id, a] of anchors) {
    const s = sticks[id], g = groups.find(x => x.id === a.card)
    if (!s || !g) continue
    const dx = g.originX - a.x, dy = g.originY - a.y
    if ((dx || dy) && s.x === a.sx && s.y === a.sy) moves.push({ id, x: s.x + dx, y: s.y + dy })
  }
  if (moves.length) {
    following = true
    try { for (const m of moves) useNotesStore.getState().updateStick(m.id, { x: m.x, y: m.y }) } finally { following = false }
  }
  anchor()
}
let lastGroups: unknown = null, lastSticks: unknown = null
const w = (typeof window !== 'undefined' ? window : undefined) as (Window & { __stickDock?: { sized: typeof sized; follow: typeof follow; anchor: typeof anchor; settle: typeof settle } }) | undefined
if (w) {
  // Installed once; a reload of this module (dev) swaps the handlers in place.
  const first = !w.__stickDock
  w.__stickDock = { sized, follow, anchor, settle }
  if (first) {
    const h = () => w.__stickDock!
    useNotesStore.subscribe(s => {
      if (s.sticks === lastSticks) return
      lastSticks = s.sticks
      if (!following) h().anchor()
      // A stick moved off a card lets go of what it remembered of it.
      if (Object.values(s.sticks ?? {}).some(x => x.heights)) queueMicrotask(() => h().settle())
    })
    useBoardsStore.subscribe(s => {
      if (s.groups === lastGroups) return
      lastGroups = s.groups
      if (Object.keys(useNotesStore.getState().sticks ?? {}).length) h().follow()
    })
    useModelScaleStore.subscribe((s, prev) => {
      if (!Object.keys(useNotesStore.getState().sticks ?? {}).length) return
      for (const [now, was] of [[s.sizeOf, prev.sizeOf], [s.setSizeOf, prev.setSizeOf]] as const) {
        if (now === was) continue
        const changed = Object.keys(now).filter(k => now[k] !== was[k])
        // (One model sized by hand: not a whole project's sizes coming back.)
        if (changed.length === 1) h().sized(changed[0], was[changed[0]], now[changed[0]])
      }
    })
  }
}
