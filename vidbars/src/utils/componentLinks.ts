// componentLinks.ts — which components are touching which.
//
// The whole modular idea rests on this: magneting two panels together is
// the ONLY wiring. So "what is this component connected to" has to be
// DERIVED from geometry, never stored — exactly like deck membership and
// viewer docking already are. Move a panel away and the link is gone; no
// state to clean up, nothing to get out of sync.
//
// A link is meaningful only in one direction per pair, and the direction
// is fixed by what each component IS:
//
//   pool  →  list    a Rolodex touching a pool browses THE POOL, not the canvas
//   list  →  viewer  a Viewer touching a Rolodex shows what the Rolodex holds
//
// which composes into the chain from the design: Pool | Rolodex | Viewer.

import type { FreeNodeData } from '../store/freeNodeStore'
import { DOCK_TOLERANCE, MAGNET_RADIUS_PX, magnetRadiusForZoom } from './viewportDocking'

/** Touching, with a little slack so a hand-dragged panel that lands a
 *  pixel short still counts. Deliberately the SAME constant as docking and
 *  deck clustering, and deliberately zoom-INDEPENDENT: what is connected to
 *  what must not change because you zoomed. Landing inside this slack is
 *  the magnet's job (snapPanelToPanel), not the reader's. */
const TOUCH_SLACK = DOCK_TOLERANCE

interface Rect { x: number; y: number; width: number; height: number }

function rectOf(n: FreeNodeData): Rect {
  return { x: n.x, y: n.y, width: n.width, height: n.height }
}

/** Do two rects touch or overlap, within slack? */
export function rectsAdjacent(a: Rect, b: Rect, slack = TOUCH_SLACK): boolean {
  return !(
    a.x + a.width + slack < b.x ||
    b.x + b.width + slack < a.x ||
    a.y + a.height + slack < b.y ||
    b.y + b.height + slack < a.y
  )
}

/** Screen-space rect for a node in EITHER placement, so a pinned panel and
 *  a pinned neighbour link up the same way canvas ones do. Pinned and
 *  canvas nodes never link to each other: they do not share a space, and
 *  pretending otherwise would connect things that are nowhere near each
 *  other on screen. */
function comparableRect(n: FreeNodeData): Rect | null {
  if (n.pin) {
    return { x: n.pin.x, y: n.pin.y, width: n.width * n.pin.scale, height: n.height * n.pin.scale }
  }
  return rectOf(n)
}

function sameSpace(a: FreeNodeData, b: FreeNodeData): boolean {
  return !!a.pin === !!b.pin
}

/** The pool a Rolodex is docked to, if any. When present the Rolodex
 *  should list that pool's files instead of the canvas's contents. */
export function poolFeedingList(
  listNode: FreeNodeData,
  nodes: Record<string, FreeNodeData>,
): FreeNodeData | null {
  const a = comparableRect(listNode)
  if (!a) return null
  const slack = TOUCH_SLACK
  let best: FreeNodeData | null = null
  for (const n of Object.values(nodes)) {
    if (n.type !== 'pool' || !sameSpace(listNode, n)) continue
    const b = comparableRect(n)
    if (!b || !rectsAdjacent(a, b, slack)) continue
    // Nearest wins, so a Rolodex wedged between two pools picks a side
    // rather than flickering.
    if (!best) { best = n; continue }
    const d = (r: Rect) => Math.abs(r.x - a.x) + Math.abs(r.y - a.y)
    if (d(comparableRect(n)!) < d(comparableRect(best)!)) best = n
  }
  return best
}

/** The panel types that magnet to each other — the modular apps. */
const PANEL_TYPES = new Set(['list', 'pool', 'prompt', 'history'])

export function isPanelType(t: string): boolean {
  return PANEL_TYPES.has(t)
}

/** Where a dragged panel should LAND so it reads as attached: flush against
 *  the nearest edge of the nearest other panel, aligned on the cross axis.
 *
 *  This is what makes the derived links usable. The link test is a tight,
 *  zoom-independent "are they touching"; without a snap you have to hit that
 *  by hand, and at low zoom the target is a couple of screen pixels wide.
 *  The magnet reaches in SCREEN pixels (discoverable at any zoom) and closes
 *  the gap to zero, so the reader's tight test always passes.
 *
 *  Coordinates are in the dragged panel's OWN space — canvas x/y for a
 *  canvas panel, pin x/y for a pinned one — so the caller writes the result
 *  straight back to whichever it owns. Returns null when nothing is in
 *  reach; the caller then keeps the raw drop. */
export function snapPanelToPanel(
  dragged: FreeNodeData,
  nodes: Record<string, FreeNodeData>,
  zoom: number,
): { x: number; y: number } | null {
  if (!isPanelType(dragged.type)) return null
  const a = comparableRect(dragged)
  if (!a) return null
  // A pinned panel is already screen-space, so its reach is raw pixels.
  const reach = dragged.pin ? MAGNET_RADIUS_PX : magnetRadiusForZoom(zoom)

  interface Landing { x: number; y: number; d: number }
  const cands: Landing[] = []
  for (const n of Object.values(nodes)) {
    if (n.id === dragged.id || !isPanelType(n.type)) continue
    // Only panels in the same space are candidates — a canvas panel and a
    // pinned one are never near each other in any meaningful sense.
    if (!sameSpace(dragged, n)) continue
    const b = comparableRect(n)
    if (!b) continue

    // Overlap on each axis decides which edges are even candidates: you can
    // only sit on someone's left if you also share some vertical extent.
    const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
    const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)

    const consider = (nx: number, ny: number, d: number): void => {
      if (d <= reach) cands.push({ x: nx, y: ny, d })
    }

    if (overlapY > -reach) {
      // Left/right of b, keeping the vertical offset the user dragged to
      // unless it is close to flush-top, which is the common intent.
      const ny = Math.abs(a.y - b.y) <= reach ? b.y : a.y
      consider(b.x - a.width, ny, Math.abs(a.x + a.width - b.x))
      consider(b.x + b.width, ny, Math.abs(a.x - (b.x + b.width)))
    }
    if (overlapX > -reach) {
      const nx = Math.abs(a.x - b.x) <= reach ? b.x : a.x
      consider(nx, b.y - a.height, Math.abs(a.y + a.height - b.y))
      consider(nx, b.y + b.height, Math.abs(a.y - (b.y + b.height)))
    }
  }
  if (cands.length === 0) return null
  // Nearest edge wins, so a panel dropped in a corner picks one side
  // instead of splitting the difference between two.
  const best = cands.reduce((m, c) => (c.d < m.d ? c : m))
  return { x: best.x, y: best.y }
}

/** Every panel touching this one, nearest first. A History window uses this
 *  to decide WHICH history it is: docked to a Prompt Pad it shows prompts,
 *  to a Media Pool it shows folders, to a Viewer's Rolodex it shows what was
 *  opened. Free-standing, it shows everything. */
export function adjacentPanels(
  node: FreeNodeData,
  nodes: Record<string, FreeNodeData>,
): FreeNodeData[] {
  const a = comparableRect(node)
  if (!a) return []
  const out: Array<{ n: FreeNodeData; d: number }> = []
  for (const n of Object.values(nodes)) {
    if (n.id === node.id || !isPanelType(n.type) || !sameSpace(node, n)) continue
    const b = comparableRect(n)
    if (!b || !rectsAdjacent(a, b, TOUCH_SLACK)) continue
    out.push({ n, d: Math.abs(b.x - a.x) + Math.abs(b.y - a.y) })
  }
  return out.sort((x, y) => x.d - y.d).map(x => x.n)
}

/** Every list node touching this rect — used by a Viewer to find the
 *  Rolodex feeding it. */
export function listsAdjacentTo(
  rect: Rect,
  nodes: Record<string, FreeNodeData>,
  pinned: boolean,
): FreeNodeData[] {
  const out: FreeNodeData[] = []
  const slack = TOUCH_SLACK
  for (const n of Object.values(nodes)) {
    if (n.type !== 'list') continue
    if (!!n.pin !== pinned) continue
    const b = comparableRect(n)
    if (b && rectsAdjacent(rect, b, slack)) out.push(n)
  }
  return out
}
