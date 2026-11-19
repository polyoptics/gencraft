// stickDock.ts — a measuring stick docked to cards (Brian 2026-11-18:
// "make the measuring stick dockable... if that something has a scale
// associated with it (as a detail on its card, the character's height),
// then their size in the 3D view would measure up properly to the
// measuring stick's size"). Worked out from where things are, never
// stored (as every docking here): a stick whose feet stand on or touch a
// card is docked to it and to the cards touching that one (a deck).
//  - In 3D each of those cards' models stands as tall as the Height on
//    its card's back says, at the stick's scale: Shift-drag the stick's
//    board and they all size with it; change a card's Height and that
//    one does. A card with no Height keeps the size it has.
//  - A docked stick goes with its card when the card is moved.

import { useNotesStore, type Stick } from '../store/notesStore'
import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { dockedCards } from './filmShots'
import { detailShown } from './cardTypes'
import { BASE_R, parseHeight } from './stickGeom'

/** The cards a stick is docked to: under or touching its feet, and the
 *  deck they are in. */
export function stickCards(s: Stick): ProjectGroup[] {
  const bs = useBoardsStore.getState()
  const r = BASE_R * s.per
  return dockedCards({ x: s.x - r, y: s.y - r, width: r * 2, height: r * 2 } as FreeNodeData, bs.groups, bs.boards)
}

/** The Height on a card's back, feet (a linked card's is its master's). */
function cardHeight(g: ProjectGroup, groups: ProjectGroup[]): number | null {
  const m = (g.linkOf && groups.find(x => x.id === g.linkOf)) || g
  const d = m.details?.find(x => x.name.trim().toLowerCase() === 'height')
  return d ? parseHeight(detailShown(groups, d).text) : null
}

interface Measured {
  /** How tall each docked card's model stands, canvas units, by card id. */
  heights: Map<string, number>
  /** The sticks that are docked. */
  docked: Set<string>
  /** Changes when any of it does. */
  sig: number
}
let memo: { sticks: unknown; groups: unknown; boards: unknown; zoom: number; out: Measured } | null = null
let sigSeq = 0

/** Every docked stick's cards and how tall their models stand. */
export function stickMeasures(): Measured {
  const sticks = useNotesStore.getState().sticks ?? {}
  const bs = useBoardsStore.getState()
  const zoom = useCanvasStore.getState().zoom
  if (memo && memo.sticks === sticks && memo.groups === bs.groups && memo.boards === bs.boards && memo.zoom === zoom) return memo.out
  const heights = new Map<string, number>()
  const docked = new Set<string>()
  for (const s of Object.values(sticks)) {
    const cards = stickCards(s)
    if (cards.length) docked.add(s.id)
    for (const g of cards) {
      const ft = cardHeight(g, bs.groups)
      if (ft && !heights.has(g.id)) heights.set(g.id, ft * s.per)
    }
  }
  const was = memo?.out
  const same = !!was && was.docked.size === docked.size && was.heights.size === heights.size
    && [...docked].every(id => was.docked.has(id)) && [...heights].every(([id, h]) => was.heights.get(id) === h)
  const out = same ? was! : { heights, docked, sig: ++sigSeq }
  memo = { sticks, groups: bs.groups, boards: bs.boards, zoom, out }
  return out
}

// A docked stick goes with its card. What each stick stands on (the
// first of its cards) and where that card was, kept from the last look:
// when the card has moved and the stick has not, the stick moves as far.
const anchors = new Map<string, { card: string; x: number; y: number; sx: number; sy: number }>()
function anchor() {
  anchors.clear()
  const sticks = useNotesStore.getState().sticks ?? {}
  if (!Object.keys(sticks).length) return
  const groups = useBoardsStore.getState().groups
  for (const s of Object.values(sticks)) {
    // The card right under its feet: the nearest of those it is docked to.
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
  if (following || !anchors.size) return
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
if (typeof window !== 'undefined') {
  useNotesStore.subscribe(s => { if (s.sticks !== lastSticks) { lastSticks = s.sticks; if (!following) anchor() } })
  useBoardsStore.subscribe(s => {
    if (s.groups === lastGroups) return
    lastGroups = s.groups
    if (Object.keys(useNotesStore.getState().sticks ?? {}).length) follow()
  })
}
