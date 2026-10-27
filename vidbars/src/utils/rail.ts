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

/** Lay a column's cards out as a cascade starting at `top`. Each card shows
 *  `peekFrac` of itself above the next; a column taller than maxColH
 *  tightens every overlap evenly (down to minPeek) so a long column stays a
 *  column. */
function cascade(cards: FreeNodeData[], x: number, top: number, w: number, u: number): RailCardBox[] {
  const g = RAIL_GEOM
  const hs = cards.map(c => dockedHeight(c, w))
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
    out.push({ id: c.id, order: i, x, y, width: w, height: hs[i] })
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

  const columns: RailColumn[] = []
  for (const slot of rail.rail.slots) {
    const cards = members?.get(slot.id) ?? []
    if (slot.kind === 'card') {
      const card = cards[0]
      if (!card) continue                    // its card left; the slot is moot
      columns.push({
        slot, slotId: slot.id, kind: 'card', x, width: cardW,
        head: { x, y: rowTop, width: cardW, height: g.headH * u },
        bodyTop, bodyBottom: bodyTop + g.cardH * u,
        cards: [{ id: card.id, order: 0, x, y: bodyTop, width: cardW, height: g.cardH * u }],
        empty: false,
      })
    } else {
      const boxes = cascade(cards, x, bodyTop, picW, u)
      const last = boxes[boxes.length - 1]
      columns.push({
        slot, slotId: slot.id, kind: 'role', x, width: picW,
        head: { x, y: rowTop, width: picW, height: g.headH * u },
        bodyTop, bodyBottom: last ? last.y + last.height : bodyTop + g.emptyH * u,
        cards: boxes, empty: boxes.length === 0,
      })
    }
    x += columns[columns.length - 1].width + g.gap * u
  }

  const plusEnd: Rect = { x, y: bodyTop, width: g.plusW * u, height: g.emptyH * u }
  x += (g.plusW + g.trayGap) * u

  const trayCards = cascade(members?.get(RAIL_TRAY) ?? [], x, bodyTop, picW, u)
  const trayLast = trayCards[trayCards.length - 1]
  const tray: RailColumn = {
    slot: null, slotId: RAIL_TRAY, kind: 'tray', x, width: picW,
    head: { x, y: rowTop, width: picW, height: g.headH * u },
    bodyTop, bodyBottom: trayLast ? trayLast.y + trayLast.height : bodyTop + g.emptyH * u,
    cards: trayCards, empty: trayCards.length === 0,
  }

  const right = x + picW + g.pad * u
  const bottom = Math.max(tray.bodyBottom, plusEnd.y + plusEnd.height, ...columns.map(c => c.bodyBottom)) + g.pad * u
  return {
    railId: rail.id, unit: u,
    box: { x: rail.x, y: rail.y, width: right - rail.x, height: bottom - rail.y },
    arrow: { x: rail.x + g.pad * u, y: rail.y + g.pad * 0.6 * u, width: right - rail.x - 2 * g.pad * u, height: g.arrowH * u },
    plusStart, plusEnd, columns, tray,
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
    for (const col of [...L.columns, L.tray]) for (const c of col.cards) out.set(c.id, c)
  }
  return out
}

export type RailDropTarget =
  | { railId: string; kind: 'column'; slotId: string; index: number }
  | { railId: string; kind: 'row'; insertAt: number }

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
