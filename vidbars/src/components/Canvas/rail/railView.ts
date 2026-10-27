// railView — everything a rail's face draws, read once per change.
//
// The face subscribes to its rail and the cards docked on it ONLY
// (railNodesOf, through useShallow): an array of node objects that stays the
// same array while none of them changes, so dragging an unrelated tile — or
// a card lifted off this rail — re-renders no rail. Lifted cards are left
// out on purpose: they belong to the drag in flight, and their column has
// already closed up behind them (railMembers skips them too).

import type { FreeNodeData } from '../../../store/freeNodeStore'
import { RAIL_GEOM, railLayout, railMembers, type RailCardBox, type RailLayout } from '../../../utils/rail'
import { railColumns, railComboCount, railWarnings } from '../../../utils/fx/railChain'

/** The rail and every card docked on it (lifted ones excepted), in store
 *  order. Feed through useShallow: the result is a new array each call. */
export function railNodesOf(nodes: Record<string, FreeNodeData>, railId: string): FreeNodeData[] {
  const out: FreeNodeData[] = []
  for (const n of Object.values(nodes)) {
    if (n.id === railId || (n.railDock?.railId === railId && !n.railDock.lifted)) out.push(n)
  }
  return out
}

export interface RailView {
  rail: FreeNodeData
  /** slotId → cards in cascade order (railMembers' entry for this rail). */
  members: Map<string, FreeNodeData[]> | undefined
  layout: RailLayout
  /** Results a run would make now (railComboCount). */
  count: number
  /** slotId → why that slot does nothing (railWarnings). */
  warnings: Record<string, string>
  /** Which role slot is the subject, which feed which blend card. */
  roles: { subject: string | null; partners: Record<string, string>; ignored: string[] }
}

let warned = false
/** The run engine is another module; a throw in it must cost the rail its
 *  count or its warnings, never the canvas (a render error unmounts the
 *  whole tree). Reported once, so a bad state does not flood the console. */
function safe<T>(f: () => T, fallback: T): T {
  try { return f() } catch (err) {
    if (!warned) { warned = true; console.warn('[rail] reading the rail failed', err) }
    return fallback
  }
}

export function buildRailView(railId: string, list: FreeNodeData[]): RailView | null {
  const byId: Record<string, FreeNodeData> = {}
  for (const n of list) byId[n.id] = n
  const rail = byId[railId]
  if (!rail) return null
  const members = railMembers(byId).get(railId)
  const layout = railLayout(rail, members)
  if (!layout) return null
  return {
    rail, members, layout,
    count: safe(() => railComboCount(rail, members), 0),
    warnings: safe(() => railWarnings(rail, members), {}),
    roles: safe(() => railColumns(rail, members), { subject: null, partners: {}, ignored: [] }),
  }
}

/** Where the NEXT card of a cascade would sit: the column's top when it is
 *  empty, else one band below its last card — a band of the LAST card's own
 *  height, as rail.ts's cascade() steps. A tightened column keeps its
 *  tightening (the factor read off the last two cards), so the mark matches
 *  where the card will actually land once the layout re-flows. */
export function nextCascadeY(cards: RailCardBox[], bodyTop: number): number {
  const g = RAIL_GEOM
  const last = cards[cards.length - 1]
  if (!last) return bodyTop
  const prev = cards[cards.length - 2]
  const k = prev && prev.height > 0 ? (last.y - prev.y) / (prev.height * g.peekFrac) : 1
  return last.y + Math.max(last.height * g.minPeek, last.height * g.peekFrac * Math.min(1, k))
}
