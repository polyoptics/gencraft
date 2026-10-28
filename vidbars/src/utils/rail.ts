// rail.ts — the LOOP STRIP: a rail of card slots that runs a workflow over
// whatever cards are docked under it.
//
// Two layers, kept apart on purpose:
//   - the RECIPE — the rail's slots, left to right: ROLE slots (a named
//     column such as "Pictures" or "Texture") and CARD slots (one effect card
//     each). Saved on the rail node as `rail`.
//   - the CAST — the cards docked under a role slot, and the results the run
//     deals into the tray at the end. Each docked card is an ordinary canvas
//     tile carrying `railDock`; the rail only decides where it sits.
//
// A column is a SOLITAIRE CASCADE, not a grid: cards overlap downward, each
// showing its top band (its title), the last one face-up. In 'pick' mode the
// face-up card is the one the run uses; in 'each' mode the run takes every
// card. A long column tightens its overlap instead of growing without end.
//
// Pure: reads the nodes it is given, never the store, so the store can use
// it without an import cycle. Geometry is canvas units; every size scales by
// the rail's `unit` (createScaleFor at creation), so a rail made zoomed out
// is a usable size there.

import type { FreeNodeData } from '../store/freeNodeStore'
import { EFFECTS, effectKindOf, type EffectKind } from './fx/effects'

// ── Side inputs ─────────────────────────────────────────────────────────
//
// An effect card's column holds the card itself (order 0) and, tucked under
// it solitaire-style, its INPUTS (order 1…): a Depth card gives its depth
// map, a Segment card its mask. What an input means depends on the card it
// feeds (aiEffects): a drawing card draws on what the Segment card names; a
// blend (Multiply, Screen, Overlay) takes the map as its second image; any
// other effect is limited to the Segment card's mask. Inputs override what
// the card would otherwise take from the strip (the Segment card before it).

/** What an input card gives: a Depth card its depth, a Segment card a mask. */
export type RailInput = 'depth' | 'mask'
const GIVES: Partial<Record<EffectKind, RailInput>> = { depth: 'depth', segment: 'mask' }

/** What this card gives as an input under another card, or null. */
export function inputGiven(n: FreeNodeData | undefined): RailInput | null {
  return n?.type === 'effect' ? GIVES[effectKindOf(n)] ?? null : null
}

/** What inputs an effect card takes from cards tucked under it: what its
 *  look needs (EffectDef.needs) that a card can give, or, for a blend, a
 *  second image (depth or mask), or, for any other effect, a mask to limit
 *  it to. A Depth or Segment card itself takes none. */
export function inputsTaken(card: FreeNodeData | undefined): RailInput[] {
  if (!card || card.type !== 'effect' || inputGiven(card)) return []
  const kind = effectKindOf(card)
  if (kind === 'linemix' || kind === 'shademix' || kind === 'combine') return []   // they mix what is before them
  const def = EFFECTS[kind]
  if (def.blend) return ['depth', 'mask']
  const needs = def.needs ?? []
  // A drawing card: what to draw on (a mask), and depth when its look uses it.
  if (needs.some(x => x === 'lines' || x === 'hatch' || x === 'look')) return needs.includes('depth') ? ['depth', 'mask'] : ['mask']
  return ['mask']
}

/** Slot id of the results column (the tray) at the rail's right end. */
export const RAIL_TRAY = 'tray'

export interface RailSlot {
  id: string
  /** role: a column of docked pictures (the cast); card: one effect card. */
  kind: 'role' | 'card'
  /** Role slots: the column's name — "Pictures", "Texture", … */
  name?: string
  /** Role slots: run every card in the column, or only the face-up one. */
  mode?: 'each' | 'pick'
}

export interface RailData {
  /** Size multiplier for every rail dimension (createScaleFor at creation). */
  unit: number
  /** Left to right. The first role slot is the SUBJECT; a role slot after a
   *  blend card (multiply, screen, overlay) is what that card mixes in. */
  slots: RailSlot[]
  /** What the run produces. 'process' = effect pictures; 'write' and
   *  'generate' are later output cards on the same rail. */
  output: 'process'
  /** How much bigger the results tray shows what is in it — its result
   *  cards and the "next" preview — than the rest of the strip. Absent: 1. */
  trayScale?: number
  /** LOOK ROWS under the strip: each another look on the same picture, a row
   *  of effect card slots (no picture columns: it takes the subject's
   *  picture). A Combine card in the first row lays them over its picture,
   *  each limited to its Segment mask (railChain, utils/fx/chain). Absent or
   *  empty: a one-row strip, exactly as before. */
  rows?: RailSlot[][]
}

/** Every row of slots: the strip's own (`slots`) first, then its look rows. */
export function railRows(r: RailData): RailSlot[][] {
  return [r.slots, ...(r.rows ?? [])]
}

/** The rail without a card slot, wherever it is (its own row or a look row). */
export function withoutCardSlot(r: RailData, slotId: string): RailData {
  const keep = (sl: RailSlot) => !(sl.kind === 'card' && sl.id === slotId)
  return { ...r, slots: r.slots.filter(keep), ...(r.rows ? { rows: r.rows.map(row => row.filter(keep)) } : {}) }
}

export interface RailDock {
  railId: string
  /** A role slot id, a card slot id, or RAIL_TRAY. */
  slotId: string
  /** Position in its column, 0 = top of the cascade. */
  order: number
  /** The tile's own size before docking — restored when it leaves. */
  prevW?: number
  prevH?: number
  /** Picked up by a drag that has not landed yet: the column closes up
   *  behind it and the sync host leaves its box alone, but it still belongs
   *  here until the release decides (re-dock elsewhere, or undock). */
  lifted?: boolean
}

type Nodes = Record<string, FreeNodeData>

/** Geometry at unit 1, canvas units. */
export const RAIL_GEOM = {
  pad: 16,
  arrowH: 46,       // the run arrow band across the top
  headH: 34,        // a column's header (name, each/pick, count)
  cardW: 180,       // an effect card's slot: a dropped effect card exactly, 5:7
  cardH: 252,
  // A picture column (and the tray) is a dropped picture's width — the
  // 200 addFreeNode and a file drop give it — so a picture docks at the
  // size it was dropped at, its own aspect for its height.
  picW: 200,
  gap: 14,          // between columns
  plusW: 30,        // the "+" that adds a role slot at either end
  trayGap: 40,      // the strip of rail between the last slot and the tray
  peekFrac: 0.3,    // how much of each card a cascade shows above the next
  minPeek: 0.12,    // the tightest a long column may overlap (fraction of card)
  maxColH: 820,     // a column taller than this tightens its overlap
  // An empty column's drop placeholder: a whole card, 5:7 at the picture
  // width — the strip opens with room for a full card in every column.
  emptyH: 280,
  needH: 40,        // an empty input spot under an effect card ("needs depth")
  rowGap: 26,       // between the strip's row and a look row, and between look rows
  addRowH: 30,      // the "+ Add a look" button under the rows
} as const

export interface Rect { x: number; y: number; width: number; height: number }

export interface RailCardBox extends Rect { id: string; order: number }

export interface RailColumn {
  /** The slot, or null for the tray. */
  slot: RailSlot | null
  slotId: string
  kind: 'role' | 'card' | 'tray'
  /** Column frame (header + body). */
  x: number
  width: number
  /** Header band (role and tray columns; card slots get a label band). */
  head: Rect
  /** Where the first card sits. */
  bodyTop: number
  /** Bottom of the last card, or of the empty placeholder. */
  bodyBottom: number
  cards: RailCardBox[]
  empty: boolean
  /** Card columns: the inputs its card takes from cards under it, and a spot
   *  under the card for each it has not been given (what to drop there). */
  takes?: RailInput[]
  needSpots?: { need: RailInput; box: Rect }[]
}

export interface RailLayout {
  railId: string
  unit: number
  /** The rail tile's own box — what its FreeNode should be sized to. */
  box: Rect
  /** The run arrow band. */
  arrow: Rect
  /** "+" buttons that add a role slot before the first / after the last slot. */
  plusStart: Rect
  plusEnd: Rect
  /** Role and card columns in slot order (card slots without a card skipped). */
  columns: RailColumn[]
  tray: RailColumn
  /** The look rows under the strip (RailData.rows), top to bottom. */
  rows: RailRowLayout[]
  /** "+ Add a look": a new empty look row. */
  addRow: Rect
}

export interface RailRowLayout {
  /** 1 for the first look row (0 is the strip's own). */
  index: number
  /** The row's band, and its label cell at the left (where the strip's "+" is). */
  band: Rect
  label: Rect
  columns: RailColumn[]
  /** Where an effect card dropped at the end of the row goes. */
  end: Rect
}

export function isRail(n: FreeNodeData | undefined): n is FreeNodeData & { rail: RailData } {
  return !!n && n.type === 'rail' && !!n.rail
}

/** A picture a role column can hold: an image tile, or a video with a poster. */
export function isRailPicture(n: FreeNodeData | undefined): boolean {
  return !!n && (n.type === 'image' || n.type === 'video') && !!n.imageUrl
}

/** Every rail's docked tiles, in ONE pass: railId → slotId → cards in
 *  cascade order. Docked tiles whose rail is gone are left out (the sync
 *  host releases them). */
export function railMembers(nodes: Nodes): Map<string, Map<string, FreeNodeData[]>> {
  const out = new Map<string, Map<string, FreeNodeData[]>>()
  for (const n of Object.values(nodes)) {
    const d = n.railDock
    if (!d || d.lifted || !isRail(nodes[d.railId])) continue
    let bySlot = out.get(d.railId)
    if (!bySlot) out.set(d.railId, bySlot = new Map())
    const col = bySlot.get(d.slotId)
    if (col) col.push(n); else bySlot.set(d.slotId, [n])
  }
  for (const bySlot of out.values()) {
    for (const col of bySlot.values()) col.sort((a, b) => a.railDock!.order - b.railDock!.order)
  }
  return out
}

/** Is this tile docked on a rail that exists? (One-off check; use
 *  railMembers in loops over all nodes.) */
export function isDocked(n: FreeNodeData | undefined, nodes: Nodes): boolean {
  return !!n?.railDock && isRail(nodes[n.railDock.railId])
}

/** A docked card's height at the column width: its own aspect (from the size
 *  it had before docking), or 5:7 for an effect card. */
function dockedHeight(n: FreeNodeData, w: number): number {
  if (n.type === 'effect') return w * (RAIL_GEOM.cardH / RAIL_GEOM.cardW)
  const pw = n.railDock?.prevW ?? n.width, ph = n.railDock?.prevH ?? n.height
  const aspect = pw > 0 && ph > 0 ? ph / pw : 0.75
  return w * Math.min(1.8, Math.max(0.35, aspect))
}

/** The shape (height / width) of each rail's live "next" preview, so an
 *  empty results tray is exactly as tall as the picture it shows. Set from
 *  the preview as it lands (useRailSync); absent until one has. */
const trayAspects = new Map<string, number>()

/** A preview's shape as the tray draws it: within 0.35 – 1.8, as a docked
 *  picture's is (dockedHeight). */
export function clampAspect(aspect: number): number {
  return Math.min(1.8, Math.max(0.35, aspect))
}

/** Record a rail's preview shape (null: none). True when it changed. */
export function setTrayAspect(railId: string, aspect: number | null): boolean {
  const was = trayAspects.get(railId)
  if (aspect === null || !(aspect > 0)) { trayAspects.delete(railId); return was !== undefined }
  const a = clampAspect(aspect)
  if (was !== undefined && Math.abs(was - a) < 1e-3) return false
  trayAspects.set(railId, a)
  return true
}

/** A column's width: its widest card when it holds cards (stand-ins,
 *  utils/railCards — a card keeps its own size, and the column fits it),
 *  else the picture width. */
function columnWidth(cards: FreeNodeData[], picW: number): number {
  const own = cards.filter(c => c.cardRef && (c.railDock?.prevW ?? 0) > 0).map(c => c.railDock!.prevW!)
  return own.length ? Math.max(...own) : picW
}

/** Lay a column's cards out as a cascade starting at `top`. Each card shows
 *  `peekFrac` of itself above the next; a column taller than maxColH
 *  tightens every overlap evenly (down to minPeek) so a long column stays a
 *  column. */
function cascade(cards: FreeNodeData[], x: number, top: number, w: number, u: number): RailCardBox[] {
  const g = RAIL_GEOM
  // A card (a stand-in, utils/railCards) keeps its own size: it is the
  // canvas card, drawn as it is anywhere.
  const own = (c: FreeNodeData) => !!c.cardRef && (c.railDock?.prevW ?? 0) > 0
  const hs = cards.map(c => own(c) ? c.railDock!.prevH ?? c.height : dockedHeight(c, w))
  const peeks = hs.map(h => h * g.peekFrac)
  if (cards.length > 1) {
    const natural = peeks.slice(0, -1).reduce((a, b) => a + b, 0) + hs[hs.length - 1]
    const max = g.maxColH * u
    if (natural > max) {
      const room = Math.max(0, max - hs[hs.length - 1])
      const want = peeks.slice(0, -1).reduce((a, b) => a + b, 0)
      const k = want > 0 ? room / want : 1
      for (let i = 0; i < peeks.length; i++) peeks[i] = Math.max(hs[i] * g.minPeek, peeks[i] * k)
    }
  }
  const out: RailCardBox[] = []
  let y = top
  cards.forEach((c, i) => {
    out.push({ id: c.id, order: i, x, y, width: own(c) ? c.railDock!.prevW! : w, height: hs[i] })
    y += peeks[i]
  })
  return out
}

/** Where everything on a rail goes. `members` is this rail's entry from
 *  railMembers (slotId → cards in order). */
export function railLayout(rail: FreeNodeData, members: Map<string, FreeNodeData[]> | undefined): RailLayout | null {
  if (!isRail(rail)) return null
  const g = RAIL_GEOM
  const u = rail.rail.unit > 0 ? rail.rail.unit : 1
  const cardW = g.cardW * u
  const picW = g.picW * u
  const rowTop = rail.y + (g.pad + g.arrowH) * u
  const bodyTop = rowTop + (g.headH + g.gap * 0.5) * u
  let x = rail.x + g.pad * u

  const plusStart: Rect = { x, y: bodyTop, width: g.plusW * u, height: g.emptyH * u }
  x += (g.plusW + g.gap) * u

  /** An effect card's column: the card, under it its inputs as a cascade,
   *  then a spot for each input it takes and has not been given. */
  const cardColumn = (slot: RailSlot, cards: FreeNodeData[], x: number, rowTop: number, bodyTop: number): RailColumn => {
    const card = cards[0]
    const takes = inputsTaken(card)
    const inputs = cards.slice(1)
    const inTop = bodyTop + (g.cardH + g.gap * 0.5) * u
    const inBoxes = cascade(inputs, x, inTop, cardW, u).map(b => ({ ...b, order: b.order + 1 }))
    const given = new Set(inputs.map(inputGiven))
    let y = inBoxes.length ? inBoxes[inBoxes.length - 1].y + inBoxes[inBoxes.length - 1].height + g.gap * 0.5 * u : inTop
    const needSpots = takes.filter(n => !given.has(n)).map(need => {
      const box = { x, y, width: cardW, height: g.needH * u }
      y += (g.needH + g.gap * 0.4) * u
      return { need, box }
    })
    return {
      slot, slotId: slot.id, kind: 'card', x, width: cardW,
      head: { x, y: rowTop, width: cardW, height: g.headH * u },
      bodyTop, bodyBottom: Math.max(bodyTop + g.cardH * u, y - g.gap * 0.4 * u),
      cards: [{ id: card.id, order: 0, x, y: bodyTop, width: cardW, height: g.cardH * u }, ...inBoxes],
      empty: false, takes, needSpots,
    }
  }

  const columns: RailColumn[] = []
  for (const slot of rail.rail.slots) {
    const cards = members?.get(slot.id) ?? []
    if (slot.kind === 'card') {
      if (!cards[0]) continue                 // its card left; the slot is moot
      columns.push(cardColumn(slot, cards, x, rowTop, bodyTop))
    } else {
      const w = columnWidth(cards, picW)
      const boxes = cascade(cards, x, bodyTop, w, u)
      const last = boxes[boxes.length - 1]
      columns.push({
        slot, slotId: slot.id, kind: 'role', x, width: w,
        head: { x, y: rowTop, width: w, height: g.headH * u },
        bodyTop, bodyBottom: last ? last.y + last.height : bodyTop + g.emptyH * u,
        cards: boxes, empty: boxes.length === 0,
      })
    }
    x += columns[columns.length - 1].width + g.gap * u
  }

  const plusEnd: Rect = { x, y: bodyTop, width: g.plusW * u, height: g.emptyH * u }
  x += (g.plusW + g.trayGap) * u

  // The tray at its own scale: an empty one, or one of loose pictures, is
  // that much wider; result cards are scaled themselves (useRailSync).
  const trayW = columnWidth(members?.get(RAIL_TRAY) ?? [], picW * (rail.rail.trayScale ?? 1))
  const trayCards = cascade(members?.get(RAIL_TRAY) ?? [], x, bodyTop, trayW, u)
  const trayLast = trayCards[trayCards.length - 1]
  const tray: RailColumn = {
    slot: null, slotId: RAIL_TRAY, kind: 'tray', x, width: trayW,
    head: { x, y: rowTop, width: trayW, height: g.headH * u },
    // Empty, it is as tall as the preview it shows, at the preview's shape.
    bodyTop, bodyBottom: trayLast ? trayLast.y + trayLast.height
      : bodyTop + (trayAspects.has(rail.id) ? trayW * trayAspects.get(rail.id)! : g.emptyH * u * (rail.rail.trayScale ?? 1)),
    cards: trayCards, empty: trayCards.length === 0,
  }

  // The look rows, each under the one before: a label cell where the
  // strip's "+" is, its effect columns from where the strip's columns
  // start, and a drop spot at its end. Then "+ Add a look".
  let top = Math.max(tray.bodyBottom, plusEnd.y + plusEnd.height, ...columns.map(c => c.bodyBottom)) + g.rowGap * u
  const x0 = plusStart.x + (g.plusW + g.gap) * u
  const rows: RailRowLayout[] = (rail.rail.rows ?? []).map((slots, k) => {
    const rTop = top, rBody = rTop + (g.headH + g.gap * 0.5) * u
    let cx = x0
    const cols: RailColumn[] = []
    for (const slot of slots) {
      const cards = members?.get(slot.id) ?? []
      if (slot.kind !== 'card' || !cards[0]) continue
      cols.push(cardColumn(slot, cards, cx, rTop, rBody))
      cx += cardW + g.gap * u
    }
    const end: Rect = { x: cx, y: rBody, width: cardW, height: g.cardH * u * 0.5 }
    const bottomOf = Math.max(end.y + end.height, ...cols.map(c => c.bodyBottom))
    const band: Rect = { x: plusStart.x, y: rTop, width: Math.max(cx + cardW, x) - plusStart.x, height: bottomOf - rTop }
    top = bottomOf + g.rowGap * u
    return { index: k + 1, band, label: { x: plusStart.x, y: rBody, width: g.plusW * u, height: bottomOf - rBody }, columns: cols, end }
  })
  const addRow: Rect = { x: x0, y: top - g.rowGap * u * 0.5, width: g.cardW * u, height: g.addRowH * u }

  const right = Math.max(x + trayW, ...rows.map(r => r.band.x + r.band.width)) + g.pad * u
  const bottom = addRow.y + addRow.height + g.pad * u
  return {
    railId: rail.id, unit: u,
    box: { x: rail.x, y: rail.y, width: right - rail.x, height: bottom - rail.y },
    arrow: { x: rail.x + g.pad * u, y: rail.y + g.pad * 0.6 * u, width: right - rail.x - 2 * g.pad * u, height: g.arrowH * u },
    plusStart, plusEnd, columns, tray, rows, addRow,
  }
}

/** Every docked tile's box and every rail's own box, for the sync host:
 *  nodeId → the rect it should have. Rails map to their layout box. */
export function railPlacements(nodes: Nodes): Map<string, Rect> {
  const out = new Map<string, Rect>()
  const members = railMembers(nodes)
  for (const n of Object.values(nodes)) {
    if (!isRail(n) || n.pin) continue
    const L = railLayout(n, members.get(n.id))
    if (!L) continue
    out.set(n.id, L.box)
    for (const col of [...L.columns, L.tray, ...L.rows.flatMap(r => r.columns)]) for (const c of col.cards) out.set(c.id, c)
  }
  return out
}

export type RailDropTarget =
  | { railId: string; kind: 'column'; slotId: string; index: number }
  /** Into a row of effect slots: the strip's own (row 0 or absent) or look
   *  row `row` (RailData.rows[row - 1]). */
  | { railId: string; kind: 'row'; insertAt: number; row?: number }
  /** Tucked under the effect card in this card slot, as its input. */
  | { railId: string; kind: 'input'; slotId: string }

/** Where a tile released at `p` (canvas units) would dock on this rail, or
 *  null. Pictures go into a role column at the cascade position under the
 *  pointer; effect cards go into the slot row, between the slots either side
 *  of the pointer. Nothing docks into the tray — the run deals results there. */
export function railDropTarget(L: RailLayout, rail: FreeNodeData, p: { x: number; y: number }, dragged: FreeNodeData): RailDropTarget | null {
  if (!isRail(rail)) return null
  const u = L.unit, m = RAIL_GEOM.gap * u
  const b = L.box
  if (p.x < b.x - m || p.x > b.x + b.width + m || p.y < b.y - m || p.y > b.y + b.height + m) return null
  if (dragged.type === 'effect') {
    // A Depth or Segment card released over the lower part of an effect
    // card that takes what it gives (or over the inputs under it) is tucked
    // under it as its input.
    const gives = inputGiven(dragged)
    if (gives) {
      const col = [...L.columns, ...L.rows.flatMap(r => r.columns)].find(c => c.kind === 'card' && c.cards[0]?.id !== dragged.id && c.takes?.includes(gives) &&
        p.x >= c.x && p.x <= c.x + c.width && p.y >= c.bodyTop + RAIL_GEOM.cardH * u * 0.6 && p.y <= c.bodyBottom + m)
      if (col) return { railId: rail.id, kind: 'input', slotId: col.slotId }
    }
    // Into a look row the point is over: between its slots.
    const lr = L.rows.find(r => p.y >= r.band.y - m / 2 && p.y <= r.band.y + r.band.height + m / 2)
    if (lr) {
      const rowSlots = rail.rail.rows?.[lr.index - 1] ?? []
      const rc = new Map(lr.columns.map(c => [c.slotId, c.x + c.width / 2]))
      let at = 0
      rowSlots.forEach((s, i) => { const cx = rc.get(s.id); if (cx !== undefined && cx < p.x) at = i + 1 })
      return { railId: rail.id, kind: 'row', insertAt: at, row: lr.index }
    }
    // Between the slots: count the slots whose middle lies left of the point.
    const slots = rail.rail.slots
    const centre = new Map(L.columns.map(c => [c.slotId, c.x + c.width / 2]))
    let insertAt = 0
    slots.forEach((s, i) => { const cx = centre.get(s.id); if (cx !== undefined && cx < p.x) insertAt = i + 1 })
    return { railId: rail.id, kind: 'row', insertAt }
  }
  if (!isRailPicture(dragged)) return null
  const col = L.columns.find(c => c.kind === 'role' && p.x >= c.x - m / 2 && p.x <= c.x + c.width + m / 2)
  if (!col) return null
  // Insert above the first card whose visible band starts below the point.
  const others = col.cards.filter(c => c.id !== dragged.id)
  let index = others.length
  for (let i = 0; i < others.length; i++) {
    const next = others[i + 1]
    const bandBottom = next ? next.y : others[i].y + others[i].height
    if (p.y < (others[i].y + bandBottom) / 2) { index = i; break }
  }
  return { railId: rail.id, kind: 'column', slotId: col.slotId, index }
}
