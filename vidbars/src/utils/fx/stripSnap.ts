// stripSnap.ts — how an effect strip gets built by hand: an effect card let
// go near the left or right edge of an image/video/effect card, or of a
// Viewer, lines up flush against it, tops aligned. Flush is what makes
// cards TOUCH, and touching is what makes them one strip (useFxStrips).
//
// Collapsed tile decks: a hidden member is not on the canvas, so it is
// neither a target nor in the way. A face IS a strip tile whatever its own
// type — it reads as its whole deck (a collapsed strip, say, behind a note).
//
// Loop strips (utils/rail): a card docked on a rail is not a strip tile —
// lining up against one would put the new card ON the rail, where the rail
// lays it out over whatever the snap chose — so docked cards are never
// targets. Nor are they separately in the way: they lie inside their rail's
// box, and the RAIL is in the way, like any tile that is not a strip tile
// (a card never snaps into a slot that would land on a rail). A rail, or a
// card on one, being let go never snaps here at all: docking is the rail's
// gesture (FreeNode docks it before it would get this far).
//
// Cards (utils/fx/cardStrips): a card with a picture on its face is a
// target too, the way a picture tile is — an effect let go by its edge
// lines up flush and the card reads as the strip's picture. Only an
// EFFECT card snaps to a card: a picture tile or a video beside a card is
// just lying there.
//
// Along a card's right edge an effect slides like a bead on a rail: the
// first snap puts it at the card's top; one already on that edge when the
// drag began keeps the height it is let go at (staying on the edge), and
// clicks to the card's top, centre or bottom when let go near one. The
// effects chained after it line up to it, as they snap to its own top.

import type { FreeNodeData } from '../../store/freeNodeStore'
import type { ViewportWindow3D } from '../../store/viewport3dStore'
import { magnetRadiusForZoom, rectsTouch, viewportVisualRect, type Rect } from '../viewportDocking'
import { tileDeckIndex } from '../tileDecks'
import { isDocked } from '../rail'
import { stripCards } from './cardStrips'

const STRIP_TYPES = new Set(['image', 'video', 'effect'])

export function snapToStrip(
  n: FreeNodeData,
  nodes: Record<string, FreeNodeData>,
  windows: Record<string, ViewportWindow3D>,
  zoom: number,
  /** Where the dragged card stood when the drag began, to tell a slide
   *  along a card's edge from a first snap onto it. */
  from?: { x: number; y: number },
): { x: number; y: number } | null {
  // A little more generous than the Viewer magnet: lining cards up in a
  // row is the whole gesture here.
  const r = magnetRadiusForZoom(zoom) * 1.5
  if (n.type === 'rail' || isDocked(n, nodes)) return null
  const { faces, hidden } = tileDeckIndex(nodes)
  const isStripTile = (o: FreeNodeData) => STRIP_TYPES.has(o.type) || faces.has(o.id)
  const others = Object.values(nodes).filter(o =>
    o.id !== n.id && !o.pin && !hidden.has(o.id) && !isDocked(o, nodes))
  const wins = Object.values(windows).filter(w => !w.pin).map(w => viewportVisualRect(w, zoom))
  const cards: Rect[] = n.type === 'effect' ? stripCards(undefined, undefined, zoom).map(c => c.rect) : []
  const targets: Rect[] = [...others.filter(isStripTile), ...wins, ...cards]

  // Where n can go at (x, y), or null when that slot is taken. Landing ON
  // a card would tie the two in read order while only one shows. Going
  // right, strip cards in the way are passed — n goes in after them, which
  // is the order it then reads in. Anything else in the way (a Viewer, a
  // note), or anything at all going left, refuses: passing it would leave
  // n off the strip, or ahead of its image.
  // Only cards on the TARGET's row can be passed: n may be taller than the
  // card it lines up with, and its slot can then reach into the row below —
  // passing a card there would slide n past the end of this strip.
  const slotX = (x: number, y: number, passRight: boolean, row: Rect): number | null => {
    const onRow = (o: FreeNodeData) => o.y < row.y + row.height && o.y + o.height > row.y
    for (let i = 0; i <= others.length; i++) {
      const slot = { x, y, width: n.width, height: n.height }
      if (wins.some(w => rectsTouch(slot, w, -1))) return null       // strict overlap
      const hits = others.filter(o => rectsTouch(slot, o, -1))
      if (hits.length === 0) return x
      if (!passRight || hits.some(o => !isStripTile(o) || !onRow(o))) return null
      x = Math.max(...hits.map(o => o.x + o.width))
    }
    return null
  }

  /** The height n lands at on a card's right edge (see the header). */
  const railY = (c: Rect): number => {
    const onEdge = !!from && Math.abs(from.x - (c.x + c.width)) < 0.5
      && from.y < c.y + c.height && from.y + n.height > c.y
    if (!onEdge) return c.y
    const lo = c.y + Math.min(0, c.height - n.height)
    const hi = c.y + Math.max(0, c.height - n.height)
    const y = Math.max(lo, Math.min(hi, n.y))
    const detents = [c.y, c.y + (c.height - n.height) / 2, c.y + c.height - n.height]
    const near = detents.reduce((a, b) => (Math.abs(b - y) < Math.abs(a - y) ? b : a))
    // A click, not a grab: a third of the snap's reach, so the effect can
    // still rest anywhere along the edge between the three.
    return Math.abs(near - y) <= r / 3 ? near : y
  }

  let best: { x: number; y: number; d: number } | null = null
  for (const c of targets) {
    const overlapsY = n.y < c.y + c.height && n.y + n.height > c.y
    if (!overlapsY) continue
    const dRight = Math.abs(n.x - (c.x + c.width))       // n sits right of c
    if (dRight <= r && (!best || dRight < best.d)) {
      const y = cards.includes(c) ? railY(c) : c.y
      const x = slotX(c.x + c.width, y, true, { ...c, y })
      if (x !== null) best = { x, y, d: dRight }
    }
    const dLeft = Math.abs(n.x + n.width - c.x)          // n sits left of c
    // Never left of a card: an effect ahead of the picture reads as none.
    if (dLeft <= r && (!best || dLeft < best.d) && !cards.includes(c)) {
      const x = slotX(c.x - n.width, c.y, false, c)
      if (x !== null) best = { x, y: c.y, d: dLeft }
    }
  }
  return best ? { x: best.x, y: best.y } : null
}
