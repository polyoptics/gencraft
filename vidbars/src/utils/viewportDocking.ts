// viewportDocking.ts — pure geometry for magnet-docking tiles/decks to 3D
// viewport windows.
//
// Dock membership is DERIVED, never stored: a model tile (or deck) is
// "docked" to a window iff its rect touches the window's rect within
// DOCK_TOLERANCE — the same philosophy (and tolerance) as deck clustering
// in useCardDecks. Snapping places rects flush (gap 0), so a snapped rect
// always passes the dock test afterwards. All coordinates are canvas units.

export type DockEdge = 'top' | 'right' | 'bottom' | 'left'

/** Attraction radius while dragging (canvas units) — the zoomed-in floor. */
export const MAGNET_RADIUS = 20
/** Screen-space attraction radius: the magnet should FEEL the same at any
 *  zoom. In pure canvas units it shrinks to a few pixels when zoomed out
 *  (undiscoverable), so the effective radius is the larger of the two.
 *  Kept deliberately TIGHT — a generous reach made windows grab every
 *  nearby card/tile while being repositioned. */
export const MAGNET_RADIUS_PX = 26
export function magnetRadiusForZoom(zoom: number): number {
  return Math.max(MAGNET_RADIUS, MAGNET_RADIUS_PX / Math.max(0.01, zoom))
}
/** Derived-dock test tolerance — MUST equal useCardDecks' TOUCH_TOLERANCE
 *  so the two spatial systems agree about "touching". Zoom-independent by
 *  design (persistent state can't depend on the camera); the magnet SNAP
 *  closes placements to flush so dragged docks always pass this. */
export const DOCK_TOLERANCE = 16

export interface Rect { x: number; y: number; width: number; height: number }
export interface WindowRect extends Rect { id: string }

/** A Viewer's header is 22 SCREEN px and is drawn ABOVE win.y — the frame
 *  mounts at `top: win.y - headerH`, so win.y is the top of the GL body,
 *  not the top of the window you can see. */
export const VIEWPORT_HEADER_SCREEN_H = 22

/** The rect a Viewer actually OCCUPIES, header included.
 *
 *  Every docking and magnet test has to use this. Using the bare win.y made
 *  a top-docked tile land with its bottom at the header's BOTTOM — i.e.
 *  covering the whole header — and made side-docked tiles start below the
 *  header instead of level with it. Both were visible on screen.
 *
 *  Zoom-aware because the header is counter-scaled to stay 22 screen px, so
 *  its height in CANVAS units grows as you zoom out. Same reasoning as
 *  cardVisualRect, and the same requirement from CLAUDE.md: screen-space
 *  geometry helpers must include the header extension. */
export function viewportVisualRect(
  w: { id: string; x: number; y: number; width: number; height: number;
       pin?: { x: number; y: number; scale: number } },
  zoom: number,
): WindowRect {
  if (w.pin) {
    // Pinned: already screen pixels, so the header is a flat 22.
    return {
      id: w.id,
      x: w.pin.x,
      y: w.pin.y - VIEWPORT_HEADER_SCREEN_H,
      width: w.width * w.pin.scale,
      height: w.height * w.pin.scale + VIEWPORT_HEADER_SCREEN_H,
    }
  }
  const headerCanvas = VIEWPORT_HEADER_SCREEN_H / Math.max(0.01, zoom)
  return {
    id: w.id,
    x: w.x,
    y: w.y - headerCanvas,
    width: w.width,
    height: w.height + headerCanvas,
  }
}

export interface MagnetCandidate {
  windowId: string
  edge: DockEdge
  distance: number
  snapped: { x: number; y: number }
}

/** Inflated-AABB touch test — same semantics as useCardDecks.rectsTouch
 *  (private to that hook): true when the rects overlap or are within
 *  `tol` on every axis. */
export function rectsTouch(a: Rect, b: Rect, tol: number): boolean {
  return !(
    a.x + a.width + tol < b.x || b.x + b.width + tol < a.x ||
    a.y + a.height + tol < b.y || b.y + b.height + tol < a.y
  )
}

/** Flush-snap `rect` onto `edge` of `win`. The along-edge coordinate is
 *  PRESERVED (clamped into the window's span) — users order docked tiles
 *  by physically sliding them along an edge. */
export function snapToEdge(
  rect: Rect, win: Rect, edge: DockEdge,
  /** Within this, the along-edge coordinate snaps FLUSH to the window's
   *  leading edge instead of being preserved. Docked things carry headers
   *  of their own, and a tile dropped a few pixels low left the two header
   *  bands ragged; landing near the top now means landing ON it, so the
   *  strip reads as one line. Sliding further along still orders freely. */
  alignTol = 0,
): { x: number; y: number } {
  const clampAlongY = Math.abs(rect.y - win.y) <= alignTol
    ? win.y
    : Math.max(win.y, Math.min(rect.y, win.y + win.height - rect.height))
  const clampAlongX = Math.abs(rect.x - win.x) <= alignTol
    ? win.x
    : Math.max(win.x, Math.min(rect.x, win.x + win.width - rect.width))
  switch (edge) {
    case 'left':   return { x: win.x - rect.width, y: clampAlongY }
    case 'right':  return { x: win.x + win.width, y: clampAlongY }
    case 'top':    return { x: clampAlongX, y: win.y - rect.height }
    case 'bottom': return { x: clampAlongX, y: win.y + win.height }
  }
}

/** Distance from `rect` to each edge of `win`, measured edge-to-edge and
 *  meaningful even when the rect is INSIDE the window (so a tile dropped
 *  onto a window snaps OUT to its nearest edge). Returns the best edge. */
function nearestEdge(rect: Rect, win: Rect): { edge: DockEdge; distance: number } {
  // Signed gaps: positive when outside beyond that edge, negative inside.
  const gapLeft = win.x - (rect.x + rect.width)         // rect fully left of win
  const gapRight = rect.x - (win.x + win.width)          // rect fully right
  const gapTop = win.y - (rect.y + rect.height)          // rect above
  const gapBottom = rect.y - (win.y + win.height)        // rect below
  // Off-axis overlap requirement: to magnet to the left/right edge the rect
  // must overlap the window's Y-span (within tolerance), and vice versa.
  const overlapsY = rect.y < win.y + win.height + DOCK_TOLERANCE && rect.y + rect.height > win.y - DOCK_TOLERANCE
  const overlapsX = rect.x < win.x + win.width + DOCK_TOLERANCE && rect.x + rect.width > win.x - DOCK_TOLERANCE

  const cands: Array<{ edge: DockEdge; distance: number }> = []
  if (overlapsY) {
    cands.push({ edge: 'left', distance: Math.abs(gapLeft) })
    cands.push({ edge: 'right', distance: Math.abs(gapRight) })
  }
  if (overlapsX) {
    cands.push({ edge: 'top', distance: Math.abs(gapTop) })
    cands.push({ edge: 'bottom', distance: Math.abs(gapBottom) })
  }
  if (cands.length === 0) return { edge: 'left', distance: Infinity }
  return cands.reduce((best, c) => (c.distance < best.distance ? c : best))
}

/** Best (window, edge) for a dragged rect, or null when nothing within
 *  `radius`. Nearest window wins; ties break to the smaller window id so
 *  a tile between two windows resolves deterministically. */
export function findMagnetCandidate(
  rect: Rect,
  windows: WindowRect[],
  radius: number = MAGNET_RADIUS,
): MagnetCandidate | null {
  let best: MagnetCandidate | null = null
  for (const win of windows) {
    const { edge, distance } = nearestEdge(rect, win)
    if (distance > radius) continue
    if (!best || distance < best.distance ||
        (distance === best.distance && win.id < best.windowId)) {
      // Same reach for the flush-align as for the magnet itself: if you got
      // close enough to dock, you got close enough to line up.
      best = { windowId: win.id, edge, distance, snapped: snapToEdge(rect, win, edge, radius) }
    }
  }
  return best
}

export interface DockableItem extends Rect { id: string }
export interface DockedItem { id: string; edge: DockEdge; along: number }

const EDGE_RANK: Record<DockEdge, number> = { top: 0, right: 1, bottom: 2, left: 3 }

/** Partition dockable items among windows — each item docks to at most ONE
 *  window (min edge distance, tie → smaller window id), ordered per window
 *  by edge rank (top→right→bottom→left) then position along the edge. */
export function computeAllDocks(
  windows: WindowRect[],
  items: DockableItem[],
  tol: number = DOCK_TOLERANCE,
): Map<string, DockedItem[]> {
  const result = new Map<string, DockedItem[]>()
  for (const win of windows) result.set(win.id, [])
  for (const item of items) {
    let best: { winId: string; edge: DockEdge; distance: number } | null = null
    for (const win of windows) {
      if (!rectsTouch(item, win, tol)) continue
      const { edge, distance } = nearestEdge(item, win)
      if (!best || distance < best.distance ||
          (distance === best.distance && win.id < best.winId)) {
        best = { winId: win.id, edge, distance }
      }
    }
    if (best) {
      const along = best.edge === 'left' || best.edge === 'right' ? item.y : item.x
      result.get(best.winId)!.push({ id: item.id, edge: best.edge, along })
    }
  }
  for (const list of result.values()) {
    list.sort((a, b) => (EDGE_RANK[a.edge] - EDGE_RANK[b.edge]) || (a.along - b.along))
  }
  return result
}

export interface TileClusterResult {
  /** windowId → cluster tile ids, BFS-ordered from the window outward. */
  byWindow: Map<string, string[]>
  /** tileId → the window its cluster is connected to. */
  tileToWindow: Map<string, string>
}

/** Deck-style tile clustering: union-find over tiles touching each other
 *  (within tol), where a whole cluster is CONNECTED to a window when any
 *  member touches it. A cluster binds to exactly one window (min edge
 *  distance among touching members; tie → smaller window id).
 *
 *  Ordering (per window): BFS from the window — tiles touching the window
 *  directly come first (edge rank top→right→bottom→left, then position
 *  along the edge, same as computeAllDocks), then their neighbors layer by
 *  layer (within a layer: y, then x). Sliding tiles reorders naturally.
 *
 *  Callers pass VISIBLE tiles only: a tile collapsed behind a deck face is
 *  not geometry (utils/tileDecks) — where it would sit if opened is empty
 *  canvas now, and counting it there would connect the deck to whatever
 *  lies beside that empty spot. The face's own rect stands for its deck.
 *  Nor loop strips or the cards docked on them (utils/rail — `isDocked`,
 *  `n.type === 'rail'`): a rail's columns overlap and touch by design, so
 *  passing them here would make the whole rail one cluster the moment a
 *  Viewer touched any of it. This file stays import-free (the stores use
 *  it), so the filtering is the callers' — useDockedContent, FreeCanvas. */
export function computeTileClusters(
  tiles: DockableItem[],
  windows: WindowRect[],
  tol: number = DOCK_TOLERANCE,
): TileClusterResult {
  const byWindow = new Map<string, string[]>()
  const tileToWindow = new Map<string, string>()
  for (const w of windows) byWindow.set(w.id, [])
  if (tiles.length === 0 || windows.length === 0) return { byWindow, tileToWindow }

  // Union-find over touching tiles
  const parent = tiles.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra }
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      if (rectsTouch(tiles[i], tiles[j], tol)) union(i, j)
    }
  }
  const clusters = new Map<number, number[]>()
  for (let i = 0; i < tiles.length; i++) {
    const r = find(i)
    if (!clusters.has(r)) clusters.set(r, [])
    clusters.get(r)!.push(i)
  }

  for (const members of clusters.values()) {
    // Which window is this cluster connected to? Judge only by members that
    // actually TOUCH a window; nearest edge distance wins.
    let best: { winId: string; distance: number } | null = null
    for (const mi of members) {
      for (const win of windows) {
        if (!rectsTouch(tiles[mi], win, tol)) continue
        const d = edgeDistance(tiles[mi], win)
        if (!best || d < best.distance || (d === best.distance && win.id < best.winId)) {
          best = { winId: win.id, distance: d }
        }
      }
    }
    if (!best) continue
    const win = windows.find(w => w.id === best!.winId)!

    // BFS from the window: layer 0 = members touching the window (sorted by
    // edge rank + along), then touch-neighbors layer by layer (y, then x).
    const memberSet = new Set(members)
    const layer0 = members.filter(mi => rectsTouch(tiles[mi], win, tol))
    layer0.sort((a, b) => {
      const ea = nearestEdge(tiles[a], win), eb = nearestEdge(tiles[b], win)
      const ra = EDGE_RANK[ea.edge], rb = EDGE_RANK[eb.edge]
      if (ra !== rb) return ra - rb
      const alongA = ea.edge === 'left' || ea.edge === 'right' ? tiles[a].y : tiles[a].x
      const alongB = eb.edge === 'left' || eb.edge === 'right' ? tiles[b].y : tiles[b].x
      return alongA - alongB
    })
    const ordered: number[] = []
    const seen = new Set<number>()
    let frontier = layer0
    while (frontier.length > 0) {
      for (const mi of frontier) { if (!seen.has(mi)) { seen.add(mi); ordered.push(mi) } }
      const next = members.filter(mi => !seen.has(mi) &&
        frontier.some(fi => rectsTouch(tiles[mi], tiles[fi], tol)))
      next.sort((a, b) => (tiles[a].y - tiles[b].y) || (tiles[a].x - tiles[b].x))
      frontier = next
    }
    // Disconnected-from-layer0 members can't happen (same union-find set ⇒
    // touch-path exists), but keep the guard cheap: append any stragglers.
    for (const mi of members) if (!seen.has(mi) && memberSet.has(mi)) ordered.push(mi)

    const ids = ordered.map(mi => tiles[mi].id)
    byWindow.get(best.winId)!.push(...ids)
    for (const tid of ids) tileToWindow.set(tid, best.winId)
  }
  return { byWindow, tileToWindow }
}

/** Min edge distance from rect to window (finite only when axis-overlapping). */
function edgeDistance(rect: Rect, win: Rect): number {
  return nearestEdge(rect, win).distance
}

/** Next free slot flush against `edge` of `win` for an item of tileW×tileH,
 *  stacking along the edge past `occupied` rects (used by direct file drops
 *  onto a window). */
export function nextFreeEdgeSlot(
  win: Rect,
  edge: DockEdge,
  tileW: number,
  tileH: number,
  occupied: Rect[],
  gap = 12,
): { x: number; y: number } {
  const isVertical = edge === 'left' || edge === 'right'
  const base = snapToEdge(
    { x: win.x, y: win.y, width: tileW, height: tileH },
    win, edge,
  )
  const slot = { x: base.x, y: base.y, width: tileW, height: tileH }
  for (let i = 0; i < 100; i++) {
    const overlaps = occupied.some(o => rectsTouch(slot, o, -1))  // strict overlap
    if (!overlaps) return { x: slot.x, y: slot.y }
    if (isVertical) slot.y += tileH + gap
    else slot.x += tileW + gap
  }
  return { x: slot.x, y: slot.y }
}
