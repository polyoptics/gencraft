// A Viewer collapses against what it is attached to, and pops back out
// (Brian 2026-11-14: "it would be a nice feature of the viewer to be able
// to pop in and out of things that it's magneted to, so it can collapse
// depending on the side of what it's magneted to ... That way, I can keep
// a bunch of viewers for different cameras attached to the 3D set without
// having them playing and being big all the time"; and, for any tool, "the
// viewer ends up parented to those things. So it should collapse into
// those things").
//
// Attached by its left or right edge, it collapses sideways into an
// upright bar along that edge; by its top or bottom (or attached to
// nothing), into its own title bar. Collapsed, it shows nothing, so
// nothing in it plays (Viewport3DFrame draws the bar only; the 3D picture
// is skipped in three/viewportRenderer). What it is attached to can be
// anything it lies against: a 3D set, a panel, a tile, a card (a loop
// strip's, a deck's), another Viewer.

import { useViewport3DStore, type ViewportWindow3D } from '../store/viewport3dStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { isHiddenDeckMember } from '../hooks/useCardDecks'
import { cardBox } from './area3dScene'
import { DOCK_TOLERANCE, magnetRadiusForZoom, viewportVisualRect, type DockEdge, type Rect } from './viewportDocking'

const TUCK_MS = 150

/** The edge of Viewer `w` that lies against something (the nearest, as
 *  near as the magnet reaches); 'top' when it lies against nothing: it
 *  collapses into its own title bar. */
export function tuckSide(w: ViewportWindow3D): DockEdge {
  if (w.pin) return 'top'
  const zoom = useCanvasStore.getState().zoom
  const v = viewportVisualRect(w, zoom)
  const reach = Math.max(DOCK_TOLERANCE, magnetRadiusForZoom(zoom))
  const hosts: Rect[] = []
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) if (!n.pin && n.type !== 'storyline') hosts.push(n)
  const wins = useViewport3DStore.getState().windows
  for (const o of Object.values(wins)) if (o.id !== w.id && !o.pin) hosts.push(viewportVisualRect(o, zoom))
  const bs = useBoardsStore.getState()
  for (const g of bs.groups) { if (g.pin || isHiddenDeckMember(g)) continue; const r = cardBox(g, bs.boards); if (r) hosts.push(r) }
  let best: DockEdge = 'top', d = Infinity
  const take = (edge: DockEdge, gap: number) => { if (gap <= reach && gap < d) { best = edge; d = gap } }
  for (const b of hosts) {
    const overY = Math.min(v.y + v.height, b.y + b.height) - Math.max(v.y, b.y)
    const overX = Math.min(v.x + v.width, b.x + b.width) - Math.max(v.x, b.x)
    if (overY > 0) { take('left', Math.abs(v.x - (b.x + b.width))); take('right', Math.abs(v.x + v.width - b.x)) }
    if (overX > 0) { take('top', Math.abs(v.y - (b.y + b.height))); take('bottom', Math.abs(v.y + v.height - b.y)) }
  }
  return best
}

/** Viewer `w`'s box when it is `k` (0..1) of the way from collapsed
 *  against `side` to its whole size `full`, the attached edge kept where
 *  it is. `at` = its box collapsed. */
function boxAt(at: { x: number; y: number }, side: DockEdge, full: { width: number; height: number }, k: number) {
  const w = side === 'left' || side === 'right' ? Math.max(1, full.width * k) : full.width
  const h = side === 'top' || side === 'bottom' ? Math.max(1, full.height * k) : full.height
  return { x: side === 'right' ? at.x - (w - 1) : at.x, y: side === 'bottom' ? at.y - (h - 1) : at.y, width: w, height: h }
}

const busy = new Set<string>()
function play(id: string, step: (k: number) => void, done: () => void) {
  let over = false
  const end = () => { if (over) return; over = true; clearTimeout(late); busy.delete(id); done() }
  const late = setTimeout(end, TUCK_MS + 400)
  const t0 = performance.now()
  busy.add(id)
  const tick = () => {
    if (over) return
    const t = Math.min(1, (performance.now() - t0) / TUCK_MS)
    // Ease out: quick away, soft landing.
    try { step(1 - (1 - t) * (1 - t)) } catch { end(); return }
    if (t >= 1) end(); else requestAnimationFrame(tick)
  }
  tick()
}

/** Collapse Viewer `id` against what it is attached to, or pop it back
 *  out. One undo step. */
export function toggleTuck(id: string): void {
  const st = useViewport3DStore.getState()
  const w = st.windows[id]
  if (!w || busy.has(id)) return
  useUndoCoordinator.getState().checkpoint()
  const set = (patch: Partial<ViewportWindow3D>) => useViewport3DStore.getState().updateWindow(id, patch)
  if (w.tuck) {
    // Out: whole again first (it shows as it grows), from the bar.
    const { side, width, height } = w.tuck
    const at = { x: w.x, y: w.y }
    set({ tuck: undefined, ...boxAt(at, side, { width, height }, 0) })
    play(id, k => set(boxAt(at, side, { width, height }, k)), () => set(boxAt(at, side, { width, height }, 1)))
    return
  }
  const side = tuckSide(w)
  const full = { width: w.width, height: w.height }
  // Where it lies collapsed: its attached edge stays put.
  const at = { x: side === 'right' ? w.x + w.width - 1 : w.x, y: side === 'bottom' ? w.y + w.height - 1 : w.y }
  play(id, k => set(boxAt(at, side, full, 1 - k)), () => set({ ...boxAt(at, side, full, 0), tuck: { side, ...full } }))
}
