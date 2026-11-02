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
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useRailUiStore } from '../store/railUiStore'
import { isTilted, useTiltStore } from '../store/tiltStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { useViewport3DStore, VIEWPORT3D_MIN_H, VIEWPORT3D_MIN_W, type ViewportWindow3D } from '../store/viewport3dStore'
import { RAIL_GEOM, isRail } from './rail'
import { computeCarriedEntities } from '../hooks/useDockedContent'
import { DOCK_TOLERANCE, VIEWPORT_HEADER_SCREEN_H, magnetRadiusForZoom, viewportVisualRect } from './viewportDocking'

/** The app's top bar: the canvas starts under it. */
const APP_BAR_H = 38

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

const REVEAL_SETTLE_FRAMES = 8
const REVEAL_WAIT_MS = 1500
const REVEAL_GLIDE_MS = 320
/** Tilted, only the screen knows where a Viewer is: it stands up and leans.
 *  Wait for it to come to rest, then, unless it is all on screen, slide the
 *  camera by what it is off the middle (the camera shift moves everything
 *  alike on screen, px for px). Standing depends on where it is, so look
 *  again after each slide. */
function revealTilted(id: string, passes = 3, sliding = false): void {
  const start = performance.now()
  let last: DOMRect | null = null, still = 0
  const watch = () => {
    if (!isTilted(useTiltStore.getState())) return
    const r = document.querySelector(`[data-viewport3d="${id}"]`)?.getBoundingClientRect() ?? null
    still = r && last && Math.abs(r.left - last.left) + Math.abs(r.top - last.top) + Math.abs(r.width - last.width) + Math.abs(r.height - last.height) < 0.5 ? still + 1 : 0
    last = r
    const waited = performance.now() - start
    if (still < REVEAL_SETTLE_FRAMES && waited < REVEAL_WAIT_MS) { requestAnimationFrame(watch); return }
    if (!r) {
      // Not drawn at all: too far off to measure. Bring it near, then look.
      const w = useViewport3DStore.getState().windows[id]
      if (!w || passes <= 0) return
      const vr = viewportVisualRect(w, useCanvasStore.getState().zoom)
      useCanvasStore.getState().jumpToPoint(vr.x + vr.width / 2, vr.y + vr.height / 2)
      window.setTimeout(() => revealTilted(id, passes - 1, true), REVEAL_GLIDE_MS)
      return
    }
    const top = APP_BAR_H
    // All on screen at the first look: leave it. Once sliding, finish the job.
    if (!sliding && r.left >= 0 && r.top >= top && r.right <= window.innerWidth && r.bottom <= window.innerHeight) return
    if (passes <= 0) return
    const dx = window.innerWidth / 2 - (r.left + r.right) / 2
    const dy = (top + window.innerHeight) / 2 - (r.top + r.bottom) / 2
    if (Math.abs(dx) + Math.abs(dy) < 4) return
    const { shiftX, shiftY } = useTiltStore.getState()
    const from = performance.now()
    const glide = () => {
      const u = Math.min(1, (performance.now() - from) / REVEAL_GLIDE_MS)
      const k = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
      useTiltStore.getState().setShift(shiftX + dx * k, shiftY + dy * k)
      if (u < 1) requestAnimationFrame(glide); else revealTilted(id, passes - 1, true)
    }
    requestAnimationFrame(glide)
  }
  requestAnimationFrame(watch)
}

/** A strip's Viewer button. Its Viewer, if it has one, comes forward with
 *  this strip showing; otherwise a new one docks to its right end, as tall
 *  as the strip. Either way it is selected, and the view glides to it unless
 *  it is all on screen. */
export function openRailViewer(railId: string): void {
  const rail = useFreeNodeStore.getState().nodes[railId]
  if (!isRail(rail) || rail.pin) return
  const zoom = useCanvasStore.getState().zoom
  const v3 = useViewport3DStore.getState()
  let id = [...railViewerDocks(useFreeNodeStore.getState().nodes, v3.windows, zoom)]
    .find(([, docked]) => docked.includes(railId))?.[0]
  if (id) {
    v3.raiseWindow(id)
  } else {
    useUndoCoordinator.getState().checkpoint()
    const header = VIEWPORT_HEADER_SCREEN_H / Math.max(0.01, zoom)
    const height = Math.max(VIEWPORT3D_MIN_H, rail.height - header)
    id = v3.addWindow(rail.x + rail.width, rail.y + header)
    v3.updateWindow(id, { width: Math.max(VIEWPORT3D_MIN_W, height * 4 / 3), height })
  }
  touchRail(railId)
  const shown = useViewport3DStore.getState()
  shown.setViewerSelection([id])
  if (isTilted(useTiltStore.getState())) { revealTilted(id); return }
  const vr = viewportVisualRect(shown.windows[id], zoom)
  const { pan } = useCanvasStore.getState()
  const left = pan.x + vr.x * zoom, top = pan.y + vr.y * zoom
  if (left < 0 || top < 0 || left + vr.width * zoom > window.innerWidth || top + vr.height * zoom > window.innerHeight) {
    useCanvasStore.getState().jumpToPoint(vr.x + vr.width / 2, vr.y + vr.height / 2)
  }
}

/** The strip `railId` was just used: it becomes the active one. */
export function touchRail(railId: string | null | undefined): void {
  if (railId) useRailUiStore.getState().touch(railId)
}

/** Where a strip's HEADER ends, canvas units below its top: the run arrow
 *  band and the row of column headers. Grabbed above this, the strip takes
 *  its Viewer along; grabbed lower, in its body, it moves alone. */
export function railHeaderBottom(rail: FreeNodeData): number {
  const u = rail.rail?.unit ?? 1
  return (RAIL_GEOM.pad + RAIL_GEOM.arrowH + RAIL_GEOM.headH + 4) * u
}

/** What a strip grabbed by its header carries: the strip is the master, so
 *  the Viewer it is docked to comes along, with everything magneted to that
 *  Viewer (computeCarriedEntities, the same set the Viewer's own header
 *  drag carries) and any other strip docked to it. Null when the strip is
 *  on no Viewer. Snapshotted at the press; the same delta moves it all. */
export function railHeaderCarry(railId: string, zoom: number): { windowIds: string[]; tileIds: string[]; groupIds: string[] } | null {
  const nodes = useFreeNodeStore.getState().nodes
  const windows = useViewport3DStore.getState().windows
  const windowIds: string[] = []
  const tiles = new Set<string>()
  const groups = new Set<string>()
  for (const [wid, docked] of railViewerDocks(nodes, windows, zoom)) {
    if (!docked.includes(railId)) continue
    windowIds.push(wid)
    for (const r of docked) tiles.add(r)
    const c = computeCarriedEntities(wid)
    for (const t of c.tileIds) tiles.add(t)
    for (const g of c.groupIds) groups.add(g)
  }
  if (!windowIds.length) return null
  tiles.delete(railId)
  // Cards on a strip go where their strip goes (the sync host places them).
  const tileIds = [...tiles].filter(t => !!nodes[t] && !nodes[t].pin && !nodes[t].railDock)
  return { windowIds, tileIds, groupIds: [...groups] }
}
