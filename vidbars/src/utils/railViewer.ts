// railViewer.ts — loop strips docked to a Viewer.
//
// A strip whose right end touches a Viewer's left edge is docked to it —
// derived from geometry, as everything docked to a Viewer is (utils/
// viewportDocking), never stored. Several strips stacked one above the
// other can dock to the same tall Viewer. The Viewer then shows the live
// "next" preview of the ACTIVE strip among them: the one last clicked,
// tweaked or stepped (railUiStore's `active`, most recent first). Moved
// away, the Viewer shows its own item again.

import type { FreeNodeData } from '../store/freeNodeStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useRailUiStore } from '../store/railUiStore'
import { useViewport3DStore, type ViewportWindow3D } from '../store/viewport3dStore'
import { isRail } from './rail'
import { DOCK_TOLERANCE, magnetRadiusForZoom, viewportVisualRect } from './viewportDocking'

type Nodes = Record<string, FreeNodeData>
type Windows = Record<string, ViewportWindow3D>

/** Does rail `r` touch window `w`'s left edge (canvas units)? Its right end
 *  within `tol` of the window's left, and the two overlapping in height. */
function touchesLeft(r: FreeNodeData, w: { x: number; y: number; width: number; height: number }, tol: number): boolean {
  return Math.abs(r.x + r.width - w.x) <= tol && r.y < w.y + w.height && r.y + r.height > w.y
}

/** Every Viewer's docked strips, top to bottom: windowId → rail ids. */
export function railViewerDocks(nodes: Nodes, windows: Windows, zoom: number): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const tol = Math.max(DOCK_TOLERANCE, 4 / Math.max(0.01, zoom))
  const rails = Object.values(nodes).filter(n => isRail(n) && !n.pin)
  for (const w of Object.values(windows)) {
    if (w.pin) continue
    const vr = viewportVisualRect(w, zoom)
    const docked = rails.filter(r => touchesLeft(r, vr, tol)).sort((a, b) => a.y - b.y).map(r => r.id)
    if (docked.length) out.set(w.id, docked)
  }
  return out
}

/** Is strip `rail` docked to any Viewer, and is it the one that Viewer
 *  shows? For the strip's own "this is on the Viewer" mark. */
export function railOnViewer(rail: FreeNodeData, nodes: Nodes, windows: Windows, zoom: number, active: string[]): boolean {
  for (const docked of railViewerDocks(nodes, windows, zoom).values()) {
    if (docked.includes(rail.id)) return viewerRail(docked, active) === rail.id
  }
  return false
}

/** The strip a Viewer shows: the most recently active of those docked to
 *  it, else the top one. */
export function viewerRail(docked: string[], active: string[]): string | null {
  return active.find(id => docked.includes(id)) ?? docked[0] ?? null
}

/** A strip let go near a Viewer's left edge: its right end flush against
 *  it, its height left where it was let go. True when it snapped. The
 *  caller holds the undo checkpoint (the drag's). */
export function snapRailToViewer(railId: string, zoom: number): boolean {
  const fs = useFreeNodeStore.getState()
  const r = fs.nodes[railId]
  if (!isRail(r) || r.pin) return false
  const radius = magnetRadiusForZoom(zoom)
  let best: { x: number; d: number } | null = null
  for (const w of Object.values(useViewport3DStore.getState().windows)) {
    if (w.pin) continue
    const vr = viewportVisualRect(w, zoom)
    if (!(r.y < vr.y + vr.height && r.y + r.height > vr.y)) continue
    const d = Math.abs(r.x + r.width - vr.x)
    if (d <= radius && (!best || d < best.d)) best = { x: vr.x - r.width, d }
  }
  if (!best || Math.abs(best.x - r.x) < 1e-3) return !!best
  fs.updateFreeNode(railId, { x: best.x })
  return true
}

/** The strip `railId` was just used: it becomes the active one. */
export function touchRail(railId: string | null | undefined): void {
  if (railId) useRailUiStore.getState().touch(railId)
}
