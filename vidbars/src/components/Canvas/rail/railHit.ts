// railHit — which loop strip the pointer is really over.
//
// railDropTarget (utils/rail) is pure geometry in canvas units: it knows
// where a rail's columns are, not what is drawn on top of them. A rail can
// lie under a pinned panel, a Viewer or the card layer's chrome, and a drop
// aimed at THAT would be stolen by the rail hidden beneath. So a drop is
// offered to a rail only where the rail — its own tile, or a card resting
// on it — is the topmost thing under the pointer ("the topmost hit wins",
// as everywhere else in the app).

import type { FreeNodeData } from '../../../store/freeNodeStore'
import { isRail } from '../../../utils/rail'

/** The id of the rail whose tile, or one of whose docked cards, is topmost
 *  at client (x, y), skipping anything inside `skip` (the tile being
 *  dragged, which is always under the hand). Null when something else is on
 *  top there. Rail chrome portalled into the world layer (RailOverlay) takes
 *  no pointer events, so it never hides its own rail. */
export function railAtPoint(
  x: number, y: number, nodes: Record<string, FreeNodeData>, skip?: Element | null,
): string | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (skip?.contains(el)) continue
    const tile = el.closest<HTMLElement>('[data-freenode]')
    const n = tile?.dataset.id ? nodes[tile.dataset.id] : undefined
    if (!n) return null
    if (isRail(n)) return n.id
    return n.railDock && !n.railDock.lifted ? n.railDock.railId : null
  }
  return null
}
