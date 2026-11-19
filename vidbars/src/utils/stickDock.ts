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
import { FT_PER_M, parseHeight } from './stickGeom'

/** How far round its foot a stick reaches for a card, feet. */
const REACH = 1.2

/** The cards a stick is docked to: under or by its feet, and the deck
 *  they are in. */
export function stickCards(s: Stick): ProjectGroup[] {
  const bs = useBoardsStore.getState()
  const r = REACH * s.per
  return dockedCards({ x: s.x - r, y: s.y - r, width: r * 2, height: r * 2 } as FreeNodeData, bs.groups, bs.boards)
}

/** The card a card's back is read from (a linked card's is its master's). */
const masterOf = (g: ProjectGroup, groups: ProjectGroup[]) => (g.linkOf && groups.find(x => x.id === g.linkOf)) || g
const heightRow = (g: ProjectGroup) => g.details?.find(x => x.name.trim().toLowerCase() === 'height')
/** The Height on a card's back, feet. */
function cardHeight(g: ProjectGroup, groups: ProjectGroup[]): number | null {
  const d = heightRow(masterOf(g, groups))
  return d ? parseHeight(detailShown(groups, d).text) : null
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
  const docked = new Set<string>()
  for (const s of Object.values(sticks)) {
    const cards = stickCards(s)
    if (cards.length) docked.add(s.id)
    for (const g of cards) {
      if (owner.has(g.id)) continue
      owner.set(g.id, s.id)
      const ft = cardHeight(g, bs.groups) ?? s.heights?.[g.id]
      if (ft) heights.set(g.id, ft * s.per); else bare.set(g.id, s.id)
    }
  }
  const was = memo?.out
  const same = !!was && was.docked.size === docked.size && [...docked].every(id => was.docked.has(id))
    && sameMap(was.heights, heights) && sameMap(was.bare, bare) && sameMap(was.owner, owner)
  const out = same ? was! : { heights, bare, owner, docked, sig: ++sigSeq }
  memo = { sticks, groups: bs.groups, boards: bs.boards, zoom, out }
  return out
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
/** A height as it is written on a card's back: as the one there is
 *  written, else in the stick's unit. */
function writeHeight(ft: number, like: string | undefined, metric: boolean | undefined): string {
  const t = (like ?? '').toLowerCase()
  const cm = /cm/.test(t), m = !cm && /\d\s*m\b|met/.test(t), feet = /'|′|’|ft|feet|foot|"|″|\bin/.test(t)
  if (cm || (!m && !feet && metric)) return `${Math.round(ft / FT_PER_M * 100)} cm`
  if (m) return `${(ft / FT_PER_M).toFixed(2)} m`
  const inches = Math.max(1, Math.round(ft * 12))
  return `${Math.floor(inches / 12)}'${inches % 12}"`
}
/** A hand's sizing in progress, by model key: the height and size it
 *  began from (so many small steps do not round away). */
const sizing = new Map<string, { ft0: number; k0: number; t: number }>()
function sized(key: string, was: number | undefined, now: number | undefined) {
  if (!key.startsWith('card:') || !now) return
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
    sizing.set(key, s)
  }
  s.t = t
  const ft = s.ft0 * now / s.k0
  const master = masterOf(g, bs.groups)
  const row = heightRow(master)
  const value = writeHeight(ft, row?.value, stick.metric)
  const details = row
    ? (master.details ?? []).map(d => d.id === row.id ? { ...d, value, link: undefined } : d)
    : [...(master.details ?? []), { id: newDetailId(), name: 'Height', value }]
  if (!row || row.value !== value || row.link) bs.setGroupDetails(master.id, details)
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
