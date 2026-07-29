// placementCarry.ts — pinning a host takes its attachments with it.
//
// Magneting things together is the only wiring in this app, so a pin that
// grabbed just the one panel would tear a composed interface in half: pin
// the Viewer and its Rolodex stays behind on the canvas, still "connected"
// to nothing. Whatever is touching travels together.
//
// The set is walked, not stored — same rule as every other link here. It
// is recomputed at the moment of the flip from where things actually are.
//
// Cards (ProjectGroups) are deliberately NOT carried. A card is canvas
// content with world coordinates, not a node; it has no screen placement
// to move into, and inventing one would be a much larger change than this.
// A card docked to a Viewer therefore stays put when that Viewer is pinned.

import { useFreeNodeStore } from '../store/freeNodeStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { useViewport3DStore } from '../store/viewport3dStore'
import type { ViewportWindow3D } from '../store/viewport3dStore'
import { rectsTouch, DOCK_TOLERANCE } from './viewportDocking'
import { isDockableTile } from './contentTraversal'
import { isPanelType } from './componentLinks'

interface Rect { x: number; y: number; width: number; height: number }

/** A thing's rect in whichever space it currently lives in. Pinned rects
 *  are screen pixels, canvas rects are world units — never compared across
 *  the two, because only same-placement things are ever walked together. */
function placedRect(e: FreeNodeData | ViewportWindow3D): Rect {
  if (e.pin) {
    return { x: e.pin.x, y: e.pin.y, width: e.width * e.pin.scale, height: e.height * e.pin.scale }
  }
  return { x: e.x, y: e.y, width: e.width, height: e.height }
}

export interface CarrySet {
  nodeIds: string[]
  windowIds: string[]
}

/** Everything that should change placement along with the seed: touching
 *  panels, touching content tiles, and touching Viewers — transitively, so
 *  a Pool | Rolodex | Viewer row travels as one object. */
export function computeCarrySet(seed: { nodeId?: string; windowId?: string }): CarrySet {
  const nodes = useFreeNodeStore.getState().nodes
  const windows = useViewport3DStore.getState().windows

  const seedEntity: FreeNodeData | ViewportWindow3D | undefined =
    seed.nodeId ? nodes[seed.nodeId] : seed.windowId ? windows[seed.windowId] : undefined
  if (!seedEntity) return { nodeIds: [], windowIds: [] }

  const pinned = !!seedEntity.pin
  // The SAME constant in both spaces, deliberately — 16 canvas units on the
  // canvas, 16 screen pixels in the pinned stratum. useDockedContent reads
  // touching the same way, and the two must agree or the set that travels
  // would differ from the set that is docked.
  const tol = DOCK_TOLERANCE

  // Only same-placement things can be in reach of each other.
  const candNodes = Object.values(nodes).filter(
    n => !!n.pin === pinned && (isPanelType(n.type) || isDockableTile(n)),
  )
  const candWins = Object.values(windows).filter(w => !!w.pin === pinned)

  const nodeIds = new Set<string>()
  const windowIds = new Set<string>()
  const queue: Array<FreeNodeData | ViewportWindow3D> = [seedEntity]
  if (seed.nodeId) nodeIds.add(seed.nodeId)
  if (seed.windowId) windowIds.add(seed.windowId)

  while (queue.length) {
    const cur = queue.shift()!
    const r = placedRect(cur)
    for (const n of candNodes) {
      if (nodeIds.has(n.id)) continue
      if (!rectsTouch(r, placedRect(n), tol)) continue
      nodeIds.add(n.id)
      queue.push(n)
    }
    for (const w of candWins) {
      if (windowIds.has(w.id)) continue
      if (!rectsTouch(r, placedRect(w), tol)) continue
      windowIds.add(w.id)
      queue.push(w)
    }
  }

  return { nodeIds: [...nodeIds], windowIds: [...windowIds] }
}

/** Flip a seed and everything attached to it between placements.
 *
 *  Relative geometry survives for free: pinning maps every member through
 *  the same `pan + v * zoom`, which is affine, so a row that looked flush
 *  stays flush. Unpinning sends each member to its OWN recorded home —
 *  which is the point of homes, and does mean a group assembled ON screen
 *  from separately-pinned parts will return to where each part came from.
 *  The re-home control is how you say "here is where this lives now". */
export function setPlacementWithCarry(
  seedId: string,
  to: 'screen' | 'canvas',
  view: { pan: { x: number; y: number }; zoom: number },
  kind: 'node' | 'window' = 'node',
): CarrySet {
  const set = computeCarrySet(kind === 'node' ? { nodeId: seedId } : { windowId: seedId })
  if (set.nodeIds.length) {
    useFreeNodeStore.getState().setNodePlacement(set.nodeIds, to, view)
  }
  const ws = useViewport3DStore.getState()
  for (const wid of set.windowIds) ws.setWindowPlacement(wid, to, view)
  return set
}
