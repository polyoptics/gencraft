// StorylineLayer — draws every Storyline on the canvas and runs its gestures
// (data and geometry: utils/storyline).
//
//  - Every dot is a point, line ends and the root's start included. A point
//    on a line of no length: drag out from it to grow the line.
//  - Hover an empty spot on a line: a glowing tick follows the mouse; click
//    to make it a point there, or drag sideways from it to grow a branch.
//    Never within a point's own grab zones: grabbing a point and adding one
//    do not compete.
//  - A point has three grab zones, each lit on hover. Its centre dot: drag it
//    along its line to move it earlier or later (a line's end point takes
//    the end with it: the line grows or shortens); let go on another line, it
//    hops what it holds (title and cards) to a new point there, leaving a
//    plain dot behind. Off to the side it stays on its line. Its outer ring:
//    the point with everything growing from it (lit as you hover); along its
//    line it slides, onto another line it re-attaches there. Its tick ends:
//    drag up or down to grow a branch straight across its line from it (a
//    real line, with an end point, that takes points and branches as any
//    line does).
//  - Drag the grab handle beside where it starts: the whole storyline moves.
//  - A linked card hangs off its point by a thin tether, drawn behind the
//    cards to the card's nearest edge; hover lights it, right-click unlinks.
//  - Click a point to select it; double-click it (or click its title) to
//    name it. Delete takes the point off its line, which stays whole.
//  - Click the grab handle to select the whole storyline (ringed, as tiles
//    are); Delete then removes it, as it does a tile. Right-click it for the
//    storyline's options: its line colour and thickness.
//  - Right-click a point, line or the handle: delete the point, the branch
//    or the storyline, or unlink a card from the point.
//  - The canvas's selection box picks out the points it covers, or the whole
//    storyline when it covers all of it, along with cards and tiles; Shift or
//    Ctrl+click adds a point. Delete takes each by the rules above, and a
//    drag moves the selected points along their lines with the rest.
//
// World space (CLAUDE.md invariant 4): it lives inside the canvas transform,
// so every stroke, handle and label is divided by the zoom and stays the
// same size on screen. Everything snaps to the dot grid's finest visible
// step (utils/dotGrid) unless the storyline's Snap is off or Ctrl is held.
//
// Tilted (TiltLayer): a press here is re-sent at the flat point under the
// cursor, so drags read their events as they do flat. Plain hovering is not
// re-sent: a trusted move while tilted is laid down on the plane here
// (toCanvas), so the tick sits under the cursor in 3D too.
//
// "Flip up in 3D view" (StorylineData.standUp, from the grab handle's menu):
// tilted, the storyline stands up about its main line like a wall, as the
// standing cards do (TiltLayer stand). TiltLayer re-sends presses at the
// ground's flat point, which is not where a wall is, so a standing storyline
// takes its own presses (data-layer-pane) and reads the cursor on the wall's
// plane (wallPoint). Tethers there run in 3D from the raised points down to
// the cards (Tether3D).

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { HexColorPicker } from 'react-colorful'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useCanvasStore, groupBounds } from '../../store/canvasStore'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useLinkDragStore } from '../../store/linkDragStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useMenuClamp } from '../../hooks/useMenuClamp'
import { useTiltStore, isTilted, standRise, unprojectTilt, TILT_FAR } from '../../store/tiltStore'
import { useWorldZoom } from './worldZoom'
import { useZoomZone, currentZone } from '../../store/zoomZonesStore'
import { clientToCanvas } from '../../utils/fx/createEffect'
import { snapToDots } from '../../utils/dotGrid'
import { PRESET_COLORS } from '../UI/TextFormatToolbar'
import {
  branchesOf, canonicalStoryline, deleteStoryBranch, deleteStoryPoint, normalizeStoryline, pointAndBranches, pointHolds,
  reattachStoryPoint, slideStoryPoint, storyGeom, storylineEmpty, unlinkStoryCard, upNormal, SAME_SPOT,
  type StoryGeom, type StorylineData,
} from '../../utils/storyline'

// Screen px — divided by the zoom where drawn.
/** Line thickness choices, screen px; a storyline without one has the
 *  default. Its ticks and point rings follow, a little lighter. */
const WEIGHTS = [2, 3.5, 5, 8]
const DEFAULT_WEIGHT = 3.5
const LINE_HIT = 14
const DOT_R = 5
/** A point's two grab zones: its centre dot, out to DOT_ZONE, and its outer
 *  ring (drawn at RING_R) out to RING_HIT. */
const DOT_ZONE = 6
const RING_R = 9
const RING_HIT = 13
/** A point's tick, each way across its line, before its stem outgrows it:
 *  its ends clear of the ring, so the tick ends are a grab zone of their own
 *  (TIP_R round each end). */
const TICK = 20
const TIP_R = 6
const DRAG_PX = 4
/** Dragged closer to its line than this (cos of ~35°), a ring slides its
 *  point along it, and a drag from a line does nothing; further off to the
 *  side, a ring carries and a line grows a branch. */
const ALONG_COS = 0.82
const DOUBLE_MS = 400
const NONE: string[] = []
const NO_GROUPS: ProjectGroup[] = []
const NO_TETHERS: Tether[] = []
/** World layers holding a standing storyline, and how many. */
const standingWalls = new Map<HTMLElement, number>()

/** A linked card's tether: from its point to the nearest spot on the card's
 *  face, relative to the storyline's node. */
interface Tether { point: string; card: string; x1: number; y1: number; x2: number; y2: number }

/** Every linked card's tether. Not for a card pinned off the canvas, or one
 *  its tether's start sits on. It starts at the point, or — a card linked
 *  on a stem's tick end (StoryPoint.hang) — at that end, wherever the stem
 *  is drawn to (`px`: one screen px, for the tick's least length). The face:
 *  the card's block extent (groupBounds, less its 16-unit docking margin)
 *  at least its set size. */
function storyTethers(d: StorylineData, g: StoryGeom, ox: number, oy: number, groups: ProjectGroup[], px: number): Tether[] {
  const out: Tether[] = []
  for (const p of d.points) {
    const pg = g.points[p.id]
    if (!pg || !p.cards?.length) continue
    for (const card of p.cards) {
      const grp = groups.find(x => x.id === card)
      const b = grp && !grp.pin ? groupBounds(card) : null
      if (!grp || !b) continue
      const side = p.hang?.[card]
      const k = side === 'up' ? Math.max(p.up, TICK * px) : side === 'down' ? -Math.max(p.down, TICK * px) : 0
      const sx = pg.x + pg.nx * k, sy = pg.y + pg.ny * k
      const x0 = b.x + 16, w = Math.max(b.w - 32, grp.cardWidthOverride ?? 0), h = Math.max(b.h, grp.cardHeightOverride ?? 0)
      const px0 = ox + sx, py0 = oy + sy
      const cx = Math.max(x0, Math.min(x0 + w, px0)), cy = Math.max(b.y, Math.min(b.y + h, py0))
      if (cx === px0 && cy === py0) continue
      out.push({ point: p.id, card, x1: sx, y1: sy, x2: cx - ox, y2: cy - oy })
    }
  }
  return out
}
/** Screen px from the root line's start to the grab handle's middle, across
 *  the line: clear of the start point's ring and tick. */
const GRAB_OFF = 40

/** A storyline's colour, unless it has its own (StorylineData.color):
 *  lines, ticks and points alike. */
const C_DEFAULT = '#8fc2ff'
const C_POINT = '#8fc2ff'
const C_GLOW = '#9fe0ff'
const C_SEL = '#ffd24a'
/** The selection ring tiles and cards get. */
const C_RING = 'rgba(120,180,255,0.9)'
const RING_W = 2.5

interface StoryUi {
  /** The selected point. */
  sel: { node: string; point: string } | null
  /** Points picked out by a selection box or Shift/Ctrl+click,
   *  by storyline: selected along with the cards and tiles around them. */
  parts: Record<string, string[]>
  /** The glowing tick under the mouse. */
  hover: { node: string; line: string; t: number } | null
  /** The point whose title is being typed. */
  editing: { node: string; point: string } | null
  /** The grab zone under the mouse: a point's centre dot, its ring, or one
   *  of its tick ends. */
  zone: { node: string; point: string; ring: boolean; tip?: 'up' | 'down' } | null
  /** The point a drag let go now would merge into, lit. */
  merge: { node: string; point: string } | null
  /** A point that would not go (a plain one holding branches), flashed. */
  flash: { node: string; point: string; at: number } | null
  /** Where a point dragged onto a line would land, lit while it is over it. */
  drop: { node: string; line: string; t: number } | null
  set: (patch: Partial<Omit<StoryUi, 'set'>>) => void
}

const useStoryUi = create<StoryUi>(set => ({
  sel: null, parts: {}, hover: null, editing: null, zone: null, drop: null, flash: null, merge: null,
  set: patch => set(patch),
}))

/** Client px → canvas units. A trusted event while tilted is where the
 *  cursor is on the tipped plane, laid flat here; a re-sent one (TiltLayer)
 *  is flat already. */
function toCanvas(e: { clientX: number; clientY: number; isTrusted: boolean }, el: Element, wall?: Wall | null): { x: number; y: number } | null {
  let cx = e.clientX, cy = e.clientY
  const ts = useTiltStore.getState()
  if (wall && isTilted(ts)) return wallPoint(cx, cy, el, wall)
  if (e.isTrusted && isTilted(ts)) {
    const host = el.closest('[data-zoom-bar-host]')
    if (!host) return null
    const r = host.getBoundingClientRect()
    const p = unprojectTilt(cx - r.left - r.width / 2, cy - r.top - r.height / 2, ts.tilt, ts.spin, ts.shiftX, ts.shiftY, 0, TILT_FAR)
    if (!p) return null
    cx = p.x + r.left + r.width / 2
    cy = p.y + r.top + r.height / 2
  }
  const c = clientToCanvas(cx, cy)
  return { x: c.cx, y: c.cy }
}

/** Snapping as a card's corner snaps (utils/dotGrid snapToDots): pulled onto
 *  a dot only when close to one, so zoomed far out it stays as tight as the
 *  cards it is composed with. */
/** A standing storyline's wall: its foot line (canvas units), its up normal
 *  (the side that rises), and how far it is up (`a`, radians from flat). */
interface Wall { x0: number; y0: number; ux: number; uy: number; nx: number; ny: number; a?: number }

/** The canvas container's rect (the [data-pin-host] box `pan` is measured
 *  from), as clientToCanvas reads it. */
const canvasBox = () => document.querySelector('[data-pin-host]')?.getBoundingClientRect() ?? null

/** Where the cursor meets a standing wall, as the canvas point it shows
 *  (flat, before it stood): the height at which the cursor's ray meets the
 *  wall (a point d up it lies d·cos a out from its foot, d·sin a high), then
 *  that far up it from its foot. */
function wallPoint(clientX: number, clientY: number, el: Element, w: Wall): { x: number; y: number } | null {
  const host = el.closest('[data-zoom-bar-host]')
  const box = canvasBox()
  if (!host || !box) return null
  const r = host.getBoundingClientRect()
  const ts = useTiltStore.getState()
  const { pan, zoom } = useCanvasStore.getState()
  const sx = clientX - r.left - r.width / 2, sy = clientY - r.top - r.height / 2
  const ground = (h: number) => {
    const q = unprojectTilt(sx, sy, ts.tilt, ts.spin, ts.shiftX, ts.shiftY, h, TILT_FAR)
    return q && { x: (q.x + r.left + r.width / 2 - box.left - pan.x) / zoom, y: (q.y + r.top + r.height / 2 - box.top - pan.y) / zoom }
  }
  const a = w.a ?? Math.PI / 2
  const cot = Math.cos(a) / Math.max(1e-6, Math.sin(a))
  // Out from the wall's foot (along its up normal) at height h (screen px),
  // less where the wall is at that height.
  const off = (h: number) => { const q = ground(h); return q ? (q.x - w.x0) * w.nx + (q.y - w.y0) * w.ny - h * cot / zoom : NaN }
  // As high (and as deep) as the cursor's ray still meets the ground: past
  // that the eye is passed or the view's far limit (TILT_FAR) is.
  let lo = -4000, hi = 4000
  while (hi > 1 && Number.isNaN(off(hi))) hi /= 2
  while (lo < -1 && Number.isNaN(off(lo))) lo /= 2
  const flo = off(lo), fhi = off(hi)
  if (!(flo * fhi < 0)) return null
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2, f = off(mid)
    if (Number.isNaN(f)) return null
    if ((f < 0) === (flo < 0)) lo = mid; else hi = mid
  }
  const h = (lo + hi) / 2
  const q = ground(h)
  if (!q) return null
  const along = (q.x - w.x0) * w.ux + (q.y - w.y0) * w.uy
  const up = h / zoom / Math.max(1e-6, Math.sin(a))
  return { x: w.x0 + w.ux * along + w.nx * up, y: w.y0 + w.uy * along + w.ny * up }
}

/** The card-link drop a standing storyline's point (or tick end) is under
 *  the cursor, read as the cursor moves. TiltLayer re-sends the drop at the
 *  ground's flat point, where a wall is not (LinkDragOverlay asks here). */
let wallDrop: string | null = null
export function standingStoryDrop(): string | null { return wallDrop }

/** Where a storyline flipped up stands: the line it turns up about (canvas
 *  units), kept from when it was flipped so moving the storyline moves it
 *  along and up its wall; else its main line as it lies. */
function wallFootOf(n: FreeNodeData): Wall | null {
  const d = n.storyline
  if (!d) return null
  const f = d.wallFoot
  if (f) {
    const { nx, ny } = upNormal(f.ux, f.uy)
    return { x0: f.x, y0: f.y, ux: f.ux, uy: f.uy, nx, ny }
  }
  const root = d.lines.find(l => !l.from)
  const lg = root && storyGeom(d).lines[root.id]
  if (!lg) return null
  const { nx, ny } = upNormal(lg.ux, lg.uy)
  return { x0: n.x + lg.sx, y0: n.y + lg.sy, ux: lg.ux, uy: lg.uy, nx, ny }
}

/** For TiltLayer: the canvas y of the wall a linked card stands up on with
 *  its storyline (flipped up, its foot lying across the view, as standing
 *  cards stand), or null. */
let wallCards: { nodes: unknown; map: Map<string, number> } | null = null
export function storyWallOf(groupId: string): number | null {
  const nodes = useFreeNodeStore.getState().nodes
  if (wallCards?.nodes !== nodes) {
    const map = new Map<string, number>()
    for (const n of Object.values(nodes)) {
      if (!n.storyline?.standUp || n.pin) continue
      const w = wallFootOf(n)
      if (!w || Math.abs(w.uy) > 1e-6) continue
      for (const p of n.storyline.points) for (const c of p.cards ?? []) map.set(c, w.y0)
    }
    wallCards = { nodes, map }
  }
  // Only cards are turned with it: zoomed in, they are blocks and boards.
  return currentZone() === 'card' ? wallCards.map.get(groupId) ?? null : null
}

function snapper(d: StorylineData, free: boolean) {
  const zoom = useCanvasStore.getState().zoom
  const on = d.snap !== false && !free
  return (v: number) => (on ? snapToDots(v, zoom) : v)
}

/** Every write keeps every dot a point (canonicalStoryline). */
function writeStoryline(id: string, x: number, y: number, d: StorylineData) {
  useFreeNodeStore.getState().updateFreeNode(id, normalizeStoryline(x, y, canonicalStoryline(d)))
}

/** Edit a storyline as one undo step; one left with nothing to show goes. */
function editStoryline(id: string, edit: (d: StorylineData) => StorylineData, checkpoint = true) {
  const fs = useFreeNodeStore.getState()
  const n = fs.nodes[id]
  if (!n?.storyline) return
  if (checkpoint) useUndoCoordinator.getState().checkpoint()
  const d = edit(n.storyline)
  if (storylineEmpty(d)) fs.deleteFreeNode(n.id)
  else writeStoryline(n.id, n.x, n.y, d)
}

/** Select the whole storyline as a tile is selected: it takes the canvas
 *  selection, so the canvas's Delete removes it (App useKeyboardDelete). */
function selectStoryline(id: string) {
  const bs = useBoardsStore.getState()
  if (bs.selectedGroupIds.length > 0) bs.clearGroupSelection()
  bs.clearAllSelections()
  const cs = useCanvasStore.getState()
  if (cs.selectedBlockBoardIds.length > 0) cs.clearSelectedBlockBoardIds()
  if (cs.selectedGhostGroupIds.length > 0) cs.clearSelectedGhostGroupIds()
  if (cs.focusedBoardId !== null) cs.setFocusedBoard(null)
  const v3 = useViewport3DStore.getState()
  if (v3.selectedIds.length > 0) v3.setViewerSelection([])
  useFreeNodeStore.getState().setFreeSelection([id])
  useStoryUi.getState().set({ sel: null, parts: {} })
}

/** A point selected: the whole storyline is not. */
function selectStoryPoint(id: string, point: string, editing = false) {
  const fs = useFreeNodeStore.getState()
  if (fs.selectedIds.includes(id)) fs.setFreeSelection(fs.selectedIds.filter(x => x !== id))
  useStoryUi.getState().set({ sel: { node: id, point }, parts: {}, ...(editing ? { editing: { node: id, point } } : {}) })
}

/** Shift/Ctrl+click: a point in or out of the selection, the rest kept. */
function toggleStoryPart(id: string, point: string) {
  const fs = useFreeNodeStore.getState()
  if (fs.selectedIds.includes(id)) fs.setFreeSelection(fs.selectedIds.filter(x => x !== id))
  const ui = useStoryUi.getState()
  const parts = { ...ui.parts }
  const mine = new Set(parts[id] ?? [])
  if (ui.sel) mine.add(ui.sel.point)
  if (ui.sel && ui.sel.node !== id) parts[ui.sel.node] = [...new Set([...(parts[ui.sel.node] ?? []), ui.sel.point])]
  if (mine.has(point)) mine.delete(point); else mine.add(point)
  parts[id] = [...mine]
  if (!parts[id].length) delete parts[id]
  ui.set({ sel: null, parts })
}

/** Every point selected: the one clicked and those picked out. */
function storyPartsList(): { node: string; point: string }[] {
  const ui = useStoryUi.getState()
  const out = Object.entries(ui.parts).flatMap(([node, ps]) => ps.map(point => ({ node, point })))
  if (ui.sel && !out.some(q => q.node === ui.sel!.node && q.point === ui.sel!.point)) out.push(ui.sel)
  return out
}

/** The canvas's selection box, in client px: picks out the points whose
 *  middles it covers, or — covering all of a storyline — returns it to be
 *  selected whole, as a tile is. `add` keeps what was picked before. */
export function selectStorylinesInBox(l: number, t: number, r: number, b: number, add: boolean): string[] {
  const ui = useStoryUi.getState()
  const parts: Record<string, string[]> = add ? { ...ui.parts } : {}
  const whole: string[] = []
  const centreIn = (rc: DOMRect) => {
    const x = rc.left + rc.width / 2, y = rc.top + rc.height / 2
    return x >= l && x <= r && y >= t && y <= b
  }
  // A line's box is its hit stroke's, a few px fatter than the line.
  const inside = (rc: DOMRect) => rc.left >= l - LINE_HIT && rc.right <= r + LINE_HIT && rc.top >= t - LINE_HIT && rc.bottom <= b + LINE_HIT
  for (const wrap of document.querySelectorAll<HTMLElement>('[data-world] [data-storyline]')) {
    const id = wrap.dataset.storyline!
    const pts = [...wrap.querySelectorAll<SVGElement>('[data-role="point"]')]
    const lines = [...wrap.querySelectorAll<SVGElement>('[data-role="line"]')]
    const hit = pts.filter(el => centreIn(el.getBoundingClientRect())).map(el => el.dataset.point!)
    if (hit.length === pts.length && lines.every(el => inside(el.getBoundingClientRect()))) {
      whole.push(id)
      delete parts[id]
    } else if (hit.length) {
      parts[id] = [...new Set([...(add ? parts[id] ?? [] : []), ...hit])]
    }
  }
  ui.set({ parts, sel: add ? ui.sel : null })
  return whole
}

/** Set while a storyline gesture writes cards and tiles, so the follower
 *  (useStoryFollow) does not move the selection a second time. */
let ownMove = false

/** What a drag of the selection moves, as it was when the drag began. */
interface GroupBase {
  pts: { node: string; point: string; t0: number; sx: number; sy: number; ux: number; uy: number; len: number }[]
  /** Storylines with points moving: where they were, and every linked card
   *  of theirs by point (not those carried anyway, selected themselves). */
  nodes: Map<string, { x: number; y: number; d: StorylineData; cards: Map<string, Map<string, { x: number; y: number }>> }>
  stories: { node: string; x: number; y: number; rx: number; ry: number; cards: Map<string, { x: number; y: number }> }[]
  groups: Map<string, { x: number; y: number }>
  tiles: string[]
}

function captureGroupBase(): GroupBase {
  const fs = useFreeNodeStore.getState()
  const bs = useBoardsStore.getState()
  const groupIds = new Set(bs.selectedGroupIds)
  let grew = true
  while (grew) {
    grew = false
    for (const g of bs.groups) if (!groupIds.has(g.id) && g.deckAnchorId && groupIds.has(g.deckAnchorId)) { groupIds.add(g.id); grew = true }
  }
  const groups = new Map<string, { x: number; y: number }>()
  for (const g of bs.groups) if (groupIds.has(g.id) && !g.pin) groups.set(g.id, { x: g.originX, y: g.originY })
  const notCarried = (m: Map<string, { x: number; y: number }>) => { for (const k of groups.keys()) m.delete(k); return m }
  const nodes: GroupBase['nodes'] = new Map()
  const pts: GroupBase['pts'] = []
  for (const { node, point } of storyPartsList()) {
    const n = fs.nodes[node]
    if (!n?.storyline) continue
    if (!nodes.has(node)) {
      const d = n.storyline
      nodes.set(node, { x: n.x, y: n.y, d, cards: new Map(d.points.map(q => [q.id, notCarried(cardOrigins(d, new Set([q.id])))])) })
    }
    const p = n.storyline.points.find(q => q.id === point)
    const lg = p && storyGeom(n.storyline).lines[p.line]
    if (!p || !lg) continue
    pts.push({ node, point, t0: Math.max(0, Math.min(lg.len, p.t)), sx: n.x + lg.sx, sy: n.y + lg.sy, ux: lg.ux, uy: lg.uy, len: lg.len })
  }
  const stories: GroupBase['stories'] = []
  const tiles: string[] = []
  for (const sid of fs.selectedIds) {
    const n = fs.nodes[sid]
    if (!n || n.pin) continue
    if (n.storyline) {
      const root = n.storyline.lines.find(l => !l.from)
      stories.push({ node: sid, x: n.x, y: n.y, rx: n.x + (root?.x ?? 0), ry: n.y + (root?.y ?? 0),
        cards: notCarried(cardOrigins(n.storyline, new Set(n.storyline.points.map(q => q.id)))) })
    } else tiles.push(sid)
  }
  return { pts, nodes, stories, groups, tiles }
}

/** The selected points slid along their lines by the drag (dx, dy), each
 *  by the rule a single point's drag follows, their cards with them; and
 *  whole storylines moved as by their grab handle. `sn` snaps (identity
 *  when following a drag made elsewhere). `own`: this drag is ours, so the
 *  selected cards and tiles move here too; else they moved already, and a
 *  storyline that moved with them only brings its cards. */
function applyGroupDelta(b: GroupBase, dx: number, dy: number, sn: (v: number) => number, own: boolean, last: { dx: number; dy: number }) {
  ownMove = true
  try {
    const moves: { groupId: string; originX: number; originY: number }[] = []
    const edits = new Map<string, StorylineData>()
    for (const q of b.pts) {
      const base = b.nodes.get(q.node)!
      const wx = sn(q.sx + q.ux * q.t0 + dx), wy = sn(q.sy + q.uy * q.t0 + dy)
      const d = edits.get(q.node) ?? base.d
      edits.set(q.node, slideStoryPoint(d, q.point, (wx - q.sx) * q.ux + (wy - q.sy) * q.uy))
    }
    // Each linked card goes as far as its point went, which counts the
    // points it hangs from down the tree too.
    for (const [node, d] of edits) {
      const base = b.nodes.get(node)!
      writeStoryline(node, base.x, base.y, d)
      const was = storyGeom(base.d).points, now = storyGeom(d).points
      for (const [pid, cards] of base.cards) {
        const a = was[pid], z = now[pid]
        if (!a || !z) continue
        for (const [groupId, o] of cards) moves.push({ groupId, originX: o.x + z.x - a.x, originY: o.y + z.y - a.y })
      }
    }
    const fs = useFreeNodeStore.getState()
    for (const st of b.stories) {
      const n = fs.nodes[st.node]
      if (!n) continue
      let mx = n.x - st.x, my = n.y - st.y
      if (own || (mx === 0 && my === 0)) {
        mx = sn(st.rx + dx) - st.rx; my = sn(st.ry + dy) - st.ry
        fs.updateFreeNode(st.node, { x: st.x + mx, y: st.y + my })
      }
      for (const [groupId, o] of st.cards) moves.push({ groupId, originX: o.x + mx, originY: o.y + my })
    }
    if (own) {
      for (const [groupId, o] of b.groups) moves.push({ groupId, originX: o.x + dx, originY: o.y + dy })
      if (b.tiles.length) fs.moveManyFreeNodes(b.tiles, dx - last.dx, dy - last.dy)
      last.dx = dx; last.dy = dy
    }
    if (moves.length) useBoardsStore.getState().setGroupPosBatch(moves)
  } finally { ownMove = false }
}

/** Selected points (and whole storylines) come along when the selected
 *  cards or tiles round them are dragged, by the same amount: read off the
 *  first of those that moved since the press. */
function useStoryFollow() {
  useEffect(() => {
    let base: GroupBase | null = null
    let ref: { kind: 'group' | 'tile'; id: string; x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => {
      base = null; ref = null
      if (e.button !== 0 || (e.target as Element | null)?.closest?.('[data-storyline]')) return
      const ui = useStoryUi.getState()
      const fs = useFreeNodeStore.getState()
      const anyStory = Object.keys(ui.parts).length > 0 || !!ui.sel || fs.selectedIds.some(x => fs.nodes[x]?.storyline)
      if (!anyStory) return
      base = captureGroupBase()
      const g = [...base.groups][0]
      const tile = base.tiles.map(x => fs.nodes[x]).find(Boolean)
      ref = g ? { kind: 'group', id: g[0], x: g[1].x, y: g[1].y } : tile ? { kind: 'tile', id: tile.id, x: tile.x, y: tile.y } : null
      if (!ref) base = null
    }
    const onUp = () => { base = null; ref = null }
    const follow = () => {
      if (!base || !ref || ownMove) return
      const now = ref.kind === 'group'
        ? useBoardsStore.getState().groups.find(x => x.id === ref!.id)
        : useFreeNodeStore.getState().nodes[ref.id]
      if (!now) return
      const x = 'originX' in now ? now.originX : now.x, y = 'originY' in now ? now.originY : now.y
      applyGroupDelta(base, x - ref.x, y - ref.y, v => v, false, { dx: 0, dy: 0 })
    }
    const offA = useBoardsStore.subscribe(follow)
    const offB = useFreeNodeStore.subscribe(follow)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    return () => {
      offA(); offB()
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
    }
  }, [])
}

/** Delete the points selected, each by its rule; one undo step
 *  (`checkpoint` false: the canvas's Delete took it). */
function deleteStorySelected(list: { node: string; point: string }[], checkpoint: boolean) {
  // A plain point holding branches does not go: it flashes instead.
  const fs = useFreeNodeStore.getState()
  const stays = list.find(({ node, point }) => {
    const d = fs.nodes[node]?.storyline
    const p = d?.points.find(q => q.id === point)
    return !!d && !!p && !pointHolds(p) && d.lines.some(l => l.from === point)
  })
  if (stays) {
    useStoryUi.getState().set({ flash: { ...stays, at: Date.now() } })
    setTimeout(() => { if (useStoryUi.getState().flash?.point === stays.point) useStoryUi.getState().set({ flash: null }) }, 700)
    if (list.length === 1) return
  }
  if (checkpoint) useUndoCoordinator.getState().checkpoint()
  for (const node of new Set(list.map(q => q.node))) {
    editStoryline(node, d => {
      for (const { point } of list.filter(q => q.node === node)) d = deleteStoryPoint(d, point)
      return d
    }, false)
  }
}

/** A storyline line under client point (x, y), other than those `skip`
 *  rules out: the drop target of a point dragged onto a line. Read through
 *  everything there (points and cards lie on lines). */
function lineUnder(x: number, y: number, skip: (node: string, line: string) => boolean): { node: string; line: string } | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.getAttribute('data-role') !== 'line') continue
    const line = el.getAttribute('data-line')
    const node = el.closest<HTMLElement>('[data-storyline]')?.dataset.storyline
    if (line && node && !skip(node, line)) return { node, line }
  }
  return null
}

/** Where on line `line` of storyline `node` canvas point `c` lands: the
 *  dot nearest it (`sn`), along the line, kept on it. `n`: the storyline as
 *  it was (a drag's own, before its preview moved anything); else as now. */
function tOnLine(node: string, line: string, c: { x: number; y: number }, sn: (v: number) => number,
                 n: { x: number; y: number; storyline?: StorylineData } | undefined = useFreeNodeStore.getState().nodes[node]): number | null {
  const lg = n?.storyline && storyGeom(n.storyline).lines[line]
  if (!n || !lg) return null
  const sx = n.x + lg.sx, sy = n.y + lg.sy
  return Math.max(0, Math.min(lg.len, (sn(c.x) - sx) * lg.ux + (sn(c.y) - sy) * lg.uy))
}

/** Hop what point `pointId` holds — its title and cards — to a new point
 *  at `to`, on this storyline or another: the point stays, a plain dot, so
 *  no line moves. The cards go as far as the contents did. */
function hopStoryContents(id: string, pointId: string, to: { node: string; line: string; t: number }) {
  const fs = useFreeNodeStore.getState()
  const src = fs.nodes[id], dst = fs.nodes[to.node]
  const p = src?.storyline?.points.find(q => q.id === pointId)
  if (!src?.storyline || !dst?.storyline || !p) return
  const from = storyGeom(src.storyline).points[pointId]
  const cards = cardOrigins(src.storyline, new Set([pointId]))
  // Its stems go with it; the dot left behind has the default.
  const q = { id: crypto.randomUUID(), line: to.line, t: to.t, up: p.up, down: p.down, title: p.title, cards: p.cards, hang: p.hang }
  const stripped = { ...src.storyline, points: src.storyline.points.map(x => (x.id === pointId ? { ...x, title: '', cards: undefined, hang: undefined, up: 0, down: 0 } : x)) }
  if (to.node === id) writeStoryline(id, src.x, src.y, { ...stripped, points: [...stripped.points, q] })
  else {
    writeStoryline(id, src.x, src.y, stripped)
    writeStoryline(to.node, dst.x, dst.y, { ...dst.storyline, points: [...dst.storyline.points, q] })
  }
  const now = useFreeNodeStore.getState().nodes[to.node]
  const there = now?.storyline && storyGeom(now.storyline).points[q.id]
  if (from && there) moveCards(cards, now.x + there.x - (src.x + from.x), now.y + there.y - (src.y + from.y))
  selectStoryPoint(to.node, q.id)
}

/** Which way a label sits off the spot it hangs from, given the way out
 *  (dx, dy): beyond it, so it never covers the point it belongs to. */
function sideFor(dx: number, dy: number): Side {
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? 'below' : 'above'
  return dx > 0 ? 'right' : 'left'
}

/** The cards linked to these points, with the cards stacked in their decks,
 *  where each one is now. Pinned cards have left the canvas: they stay. */
function cardOrigins(d: StorylineData, pointIds: Set<string>): Map<string, { x: number; y: number }> {
  const groups = useBoardsStore.getState().groups
  const ids = new Set<string>()
  for (const p of d.points) if (pointIds.has(p.id)) for (const c of p.cards ?? []) ids.add(c)
  let grew = true
  while (grew) {
    grew = false
    for (const g of groups) if (!ids.has(g.id) && g.deckAnchorId && ids.has(g.deckAnchorId)) { ids.add(g.id); grew = true }
  }
  const out = new Map<string, { x: number; y: number }>()
  for (const g of groups as ProjectGroup[]) if (ids.has(g.id) && !g.pin) out.set(g.id, { x: g.originX, y: g.originY })
  return out
}

function moveCards(from: Map<string, { x: number; y: number }>, dx: number, dy: number) {
  if (from.size === 0) return
  useBoardsStore.getState().setGroupPosBatch(
    [...from].map(([groupId, o]) => ({ groupId, originX: o.x + dx, originY: o.y + dy })))
}

/** The storyline point card `groupId` is linked to, if any. */
export function storyLinkOf(groupId: string): { node: string; point: string } | null {
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    const p = n.storyline?.points.find(q => q.cards?.includes(groupId))
    if (p) return { node: n.id, point: p.id }
  }
  return null
}

/** Let card `groupId` go from whatever storyline point holds it; it stays
 *  where it is. The caller takes the undo checkpoint. */
export function unlinkCardFromStorylines(groupId: string) {
  const at = storyLinkOf(groupId)
  if (!at) return
  const n = useFreeNodeStore.getState().nodes[at.node]
  if (n?.storyline) useFreeNodeStore.getState().updateFreeNode(at.node, { storyline: unlinkStoryCard(n.storyline, at.point, groupId) })
}

/** Link card `groupId` to point `pointId` (a card's link "+" let go on
 *  it; LinkDragOverlay), hanging from its stem's tick end `side` if it was
 *  let go there. A card follows one point: off any other first. The caller
 *  takes the undo checkpoint. */
export function linkCardToStoryPoint(nodeId: string, pointId: string, groupId: string, side?: string) {
  const hangs = side === 'up' || side === 'down' ? side : undefined
  const fs = useFreeNodeStore.getState()
  if (!fs.nodes[nodeId]?.storyline?.points.some(p => p.id === pointId)) return
  for (const n of Object.values(fs.nodes)) {
    if (!n.storyline) continue
    let changed = false
    const points = n.storyline.points.map(p => {
      const has = p.cards?.includes(groupId) ?? false
      const want = n.id === nodeId && p.id === pointId
      if (has === want && (!want || p.hang?.[groupId] === hangs)) return p
      changed = true
      const { [groupId]: _was, ...hang } = p.hang ?? {}
      if (want && hangs) hang[groupId] = hangs
      return {
        ...p,
        cards: want ? (has ? p.cards : [...(p.cards ?? []), groupId]) : p.cards!.filter(c => c !== groupId),
        hang: Object.keys(hang).length ? hang : undefined,
      }
    })
    if (changed) fs.updateFreeNode(n.id, { storyline: { ...n.storyline, points } })
  }
}

export const StorylineLayer: React.FC = React.memo(() => {
  const ids = useFreeNodeStore(useShallow(s =>
    Object.values(s.nodes).filter(n => n.type === 'storyline' && n.storyline && !n.pin).map(n => n.id)))
  useStoryKeys()
  useStoryFollow()
  useWallDrops()
  return <>{ids.map(id => <Storyline key={id} id={id} />)}</>
})

/** While a card's link "+" is dragged over the tilted view: which standing
 *  storyline point (or tick end) is under the cursor, from the real (tipped)
 *  view, so a drop there finds it (standingStoryDrop). */
function useWallDrops() {
  const linking = useLinkDragStore(s => s.active)
  useEffect(() => {
    wallDrop = null
    if (!linking) return
    const onMove = (e: PointerEvent) => {
      if (!e.isTrusted) return
      wallDrop = null
      for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
        const attr = el.getAttribute('data-link-drop')
        if (attr === null) continue
        if (attr.startsWith('story:') && el.closest('[data-story-wall="up"]')) wallDrop = attr
        break
      }
    }
    window.addEventListener('pointermove', onMove, true)
    return () => { window.removeEventListener('pointermove', onMove, true); wallDrop = null }
  }, [linking])
}

/** Delete / Backspace takes the selected point off its line (see
 *  deleteStoryPoint). Esc lets go of it. A press anywhere else lets go of it
 *  too. A whole storyline selected is the canvas's Delete, as a tile. */
function useStoryKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useStoryUi.getState()
      const list = storyPartsList()
      if (!list.length || ui.editing) return
      const tag = (document.activeElement as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'Escape') { ui.set({ sel: null, parts: {} }); return }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      ui.set({ sel: null, parts: {}, hover: null })
      // Selected along with cards or tiles: the canvas's Delete takes them,
      // and its checkpoint first, so the points go right after it, in the
      // same undo step.
      const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
      const cs = useCanvasStore.getState(), v3 = useViewport3DStore.getState()
      if (fs.selectedIds.length || bs.selectedGroupIds.length || v3.selectedIds.length || cs.selectedBlockBoardIds.length) {
        setTimeout(() => deleteStorySelected(list, false), 0)
        return
      }
      // Ours alone: the canvas's own Delete would otherwise fall through
      // to whatever board has the focus.
      e.preventDefault()
      e.stopImmediatePropagation()
      deleteStorySelected(list, true)
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (t?.closest?.('[data-storyline]')) return
      // Shift / Ctrl add to a selection, and a press on something already
      // selected (to drag it) keeps it: as for cards and tiles.
      if (e.shiftKey || e.ctrlKey) return
      const card = t?.closest?.<HTMLElement>('[data-group-card][data-id]')?.dataset.id
      const tile = t?.closest?.<HTMLElement>('[data-freenode][data-id]')?.dataset.id
      if ((card && useBoardsStore.getState().selectedGroupIds.includes(card)) ||
          (tile && useFreeNodeStore.getState().selectedIds.includes(tile))) return
      const ui = useStoryUi.getState()
      if (ui.sel || Object.keys(ui.parts).length) ui.set({ sel: null, parts: {} })
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [])
}

type Gesture =
  | { kind: 'grow'; line: string }
  | { kind: 'sprout'; line: string; t: number; point: string; branch: string }
  /** A point along its line. Let go over another line: `hop`, its contents
   *  go there (the dot); `carry`, it goes there with all below it (the ring). */
  | { kind: 'slide'; point: string; cards: Map<string, { x: number; y: number }>; hop: boolean; carry: boolean }
  | { kind: 'tip'; point: string; side: 'up' | 'down'; line: string }
  | { kind: 'move'; cards: Map<string, { x: number; y: number }> }
  | { kind: 'group'; base: GroupBase; last: { dx: number; dy: number } }

const Storyline: React.FC<{ id: string }> = ({ id }) => {
  const node = useFreeNodeStore(s => s.nodes[id]) as FreeNodeData | undefined
  const zoom = useCanvasStore(s => s.zoom)
  const sel = useStoryUi(s => (s.sel?.node === id ? s.sel.point : null))
  const parts = useStoryUi(s => s.parts[id] ?? NONE)
  const zone = useStoryUi(s => (s.zone?.node === id ? s.zone : null))
  const drop = useStoryUi(s => (s.drop?.node === id ? s.drop : null))
  const flash = useStoryUi(s => (s.flash?.node === id ? s.flash : null))
  const merge = useStoryUi(s => (s.merge?.node === id ? s.merge.point : null))
  const hover = useStoryUi(s => (s.hover?.node === id ? s.hover : null))
  const editing = useStoryUi(s => (s.editing?.node === id ? s.editing.point : null))
  const linking = useLinkDragStore(s => s.active && s.source?.kind === 'group')
  const busy = useRef(false)
  const lastClick = useRef<{ point: string; at: number } | null>(null)
  const picked = useFreeNodeStore(s => s.selectedIds.includes(id))
  const [menu, setMenu] = useState<{ x: number; y: number; point?: string; line?: string; grab?: boolean; tether?: string } | null>(null)
  // Saved before every dot was a point: made so once, as it loads.
  const raw = node?.storyline
  useEffect(() => {
    if (raw && canonicalStoryline(raw) !== raw) {
      const n = useFreeNodeStore.getState().nodes[id]
      if (n) writeStoryline(id, n.x, n.y, raw)
    }
  }, [id, raw])

  // Linked cards, followed where they sit (their tethers).
  const hasCards = !!raw?.points.some(p => p.cards?.length)
  const groups = useBoardsStore(s => (hasCards ? s.groups : NO_GROUPS))
  useBoardsStore(s => (hasCards ? s.boards : null))

  // Flipped up, in the tilted view: a wall standing on its main line.
  const tilted = useTiltStore(s => isTilted(s))
  const zone3 = useZoomZone()
  // Up as far as the standing cards are, following the tilt.
  const rise = useTiltStore(s => (raw?.standUp ? standRise(s) : 0))
  const standing = tilted && !!raw?.standUp && rise > 0
  const worldRef = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    // The world layer and its tilt stage pass the wall's turn on into the 3D
    // view, as TiltLayer's lifts make them (index.css data-tilt-3d): only
    // while one stands, so a flat stage still paints as one layer.
    const world = worldRef.current
    const stage = world?.closest<HTMLElement>('[data-tilt-stage]')
    if (!standing || !world || !stage) return
    standingWalls.set(world, (standingWalls.get(world) ?? 0) + 1)
    world.style.transformStyle = 'preserve-3d'
    stage.style.transformStyle = 'preserve-3d'
    return () => {
      const k = (standingWalls.get(world) ?? 1) - 1
      if (k > 0) standingWalls.set(world, k)
      else { standingWalls.delete(world); world.style.transformStyle = ''; stage.style.transformStyle = '' }
    }
  }, [standing])

  const d = node?.storyline
  if (!node || !d) return null
  const px = 1 / zoom
  const g = storyGeom(d)
  const tethers = hasCards ? storyTethers(d, g, node.x, node.y, groups, px) : NO_TETHERS
  // It stands on its foot (kept from when it was flipped), relative to the
  // node; the up side rises: a quarter turn about it, the way that takes its
  // up normal to the viewer (+z).
  const foot = wallFootOf(node)
  const turn = foot && foot.ux * foot.ny - foot.uy * foot.nx < 0 ? -90 : 90
  const wall: Wall | null = standing && foot ? { ...foot, a: Math.PI / 2 * rise } : null
  // Its cards stand on the wall too, at card zoom (where they are cards)
  // while its foot lies across the view: TiltLayer turns them about the same
  // foot by the same angle, so they stay at their offsets from their points.
  // Their tethers then run on the wall, with it.
  const cardsStand = !!wall && Math.abs(wall.uy) <= 1e-6 && zone3 === 'card'

  /** The tick for a hover at canvas point `c` over line `lineId`, or null
   *  where a point or a line's end already is. */
  const tickAt = (lineId: string, c: { x: number; y: number }, free: boolean): number | null => {
    const lg = g.lines[lineId]
    if (!lg || lg.len < 1e-6) return null
    const sn = snapper(d, free)
    const sx = node.x + lg.sx, sy = node.y + lg.sy
    let t = (sn(c.x) - sx) * lg.ux + (sn(c.y) - sy) * lg.uy
    // Snapped across the line, a dot can project past its point: the
    // unsnapped spot along it is the fallback that still lands on the line.
    if (t < 0 || t > lg.len) t = (c.x - sx) * lg.ux + (c.y - sy) * lg.uy
    t = Math.max(0, Math.min(lg.len, t))
    // Not on a point, nor on a line's ends (a branch starts on its point).
    const near = RING_HIT * px
    if (d.points.some(p => p.line === lineId && Math.abs(p.t - t) < near)) return null
    if (t < near || lg.len - t < near) return null
    return t
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (busy.current) return
    const ui = useStoryUi.getState()
    const role = (e.target as Element).closest<HTMLElement | SVGElement>('[data-role]')
    // The grab zone under the mouse, lit.
    const r = role?.dataset.role
    const zp = r === 'point' || r === 'ring' || r === 'tip-up' || r === 'tip-down' ? role!.dataset.point : undefined
    const ring = r === 'ring'
    const tip = r === 'tip-up' ? 'up' as const : r === 'tip-down' ? 'down' as const : undefined
    if (zp ? ui.zone?.node !== id || ui.zone.point !== zp || ui.zone.ring !== ring || ui.zone.tip !== tip : ui.zone?.node === id) {
      ui.set({ zone: zp ? { node: id, point: zp, ring, tip } : null })
    }
    const lineId = role?.dataset.role === 'line' ? role.dataset.line : undefined
    const c = lineId ? toCanvas(e.nativeEvent, e.currentTarget, wall) : null
    const t = lineId && c ? tickAt(lineId, c, e.ctrlKey) : null
    if (lineId && t !== null) {
      if (ui.hover?.node !== id || ui.hover.line !== lineId || ui.hover.t !== t) ui.set({ hover: { node: id, line: lineId, t } })
    } else if (ui.hover?.node === id) ui.set({ hover: null })
  }
  const onPointerLeave = () => {
    if (busy.current) return
    const ui = useStoryUi.getState()
    if (ui.hover?.node === id || ui.zone?.node === id) ui.set({ hover: null, zone: null })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.altKey) return
    const el = (e.target as Element).closest<HTMLElement | SVGElement>('[data-role]')
    const role = el?.dataset.role
    // A tether takes only its menu: a press on it is the canvas's.
    if (!role || role === 'ui' || role === 'tether') return
    e.stopPropagation()
    e.preventDefault()
    const host = e.currentTarget
    const c0 = toCanvas(e.nativeEvent, host, wall)
    if (!c0) return
    const d0 = d
    const x0 = node.x, y0 = node.y
    const g0 = g
    const pointId = el?.dataset.point
    const lineId = el?.dataset.line ?? (pointId ? d0.points.find(p => p.id === pointId)?.line : undefined)
    const hover0 = useStoryUi.getState().hover
    useStoryUi.getState().set({ hover: null })
    busy.current = true
    let gesture: Gesture | null = null
    /** Moved past a click's slop: whatever came of it, it was no click. */
    let moved = false
    const at = (lid: string) => {
      const lg = g0.lines[lid]
      return lg && { sx: x0 + lg.sx, sy: y0 + lg.sy, ux: lg.ux, uy: lg.uy, len: lg.len }
    }

    /** A line under the cursor to let point `pid` go on, and where on it:
     *  only a spot clear of where the point is now, so a press at a junction
     *  (where lines meet at the point) never lands on itself. */
    const dropAt = (client: { x: number; y: number }, c: { x: number; y: number }, sn: (v: number) => number,
                    pid: string, skip: (node: string, line: string) => boolean) => {
      const hit = lineUnder(client.x, client.y, skip)
      // This storyline as the drag found it: its preview may have moved lines.
      const n = hit?.node === id ? { x: x0, y: y0, storyline: d0 } : hit ? useFreeNodeStore.getState().nodes[hit.node] : undefined
      const t = hit && tOnLine(hit.node, hit.line, c, sn, n)
      if (!hit || t === null) return null
      const lg = n?.storyline && storyGeom(n.storyline).lines[hit.line]
      const pg = g0.points[pid]
      if (!n || !lg || !pg) return null
      const far = Math.hypot(n.x + lg.sx + lg.ux * t - (x0 + pg.x), n.y + lg.sy + lg.uy * t - (y0 + pg.y)) * zoom
      return far > RING_HIT ? { ...hit, t } : null
    }

    /** The point already at `t` on that line, other than `self`. */
    const pointAt = (node: string, line: string, t: number, self: string) => {
      const n = node === id ? d0 : useFreeNodeStore.getState().nodes[node]?.storyline
      const q = n?.points.find(x => x.id !== self && x.line === line && Math.abs(x.t - t) < SAME_SPOT)
      return q ? { node, point: q.id } : null
    }

    const decide = (c: { x: number; y: number }): Gesture | null => {
      if (role === 'tip-up' || role === 'tip-down') return pointId ? { kind: 'tip', point: pointId, side: role === 'tip-up' ? 'up' : 'down', line: crypto.randomUUID() } : null
      if (role === 'grab') return { kind: 'move', cards: cardOrigins(d0, new Set(d0.points.map(p => p.id))) }
      if (role === 'line' && lineId) {
        // Sideways from an empty spot on the line: a branch grows from a new
        // point there. Along the line, nothing.
        const lg = at(lineId)
        const t = hover0?.node === id && hover0.line === lineId ? hover0.t : tickAt(lineId, c0, false)
        if (!lg || t === null) return null
        const vx = c.x - c0.x, vy = c.y - c0.y
        if (Math.abs(vx * lg.ux + vy * lg.uy) / Math.max(1e-9, Math.hypot(vx, vy)) >= ALONG_COS) return null
        return { kind: 'sprout', line: lineId, t, point: crypto.randomUUID(), branch: crypto.randomUUID() }
      }
      if ((role === 'point' || role === 'title' || role === 'ring') && pointId && lineId) {
        // One of several things selected: they all go, this one as ever.
        const ui = useStoryUi.getState()
        const mine = ui.sel?.node === id && ui.sel.point === pointId || (ui.parts[id] ?? []).includes(pointId)
        const bs = useBoardsStore.getState(), fs = useFreeNodeStore.getState()
        if (mine && storyPartsList().length + bs.selectedGroupIds.length + fs.selectedIds.length > 1) {
          return { kind: 'group', base: captureGroupBase(), last: { dx: 0, dy: 0 } }
        }
        const lg = at(lineId)
        if (!lg) return null
        if (lg.len < 1e-6) return { kind: 'grow', line: lineId }
        // Along its line either way; over another line, the dot (or the
        // title) hops its contents there, the ring carries the point with all
        // below it — whichever way the drag set off.
        const cards = cardOrigins(d0, pointAndBranches(d0, pointId).points)
        const ring = role === 'ring'
        return { kind: 'slide', point: pointId, cards, hop: !ring, carry: ring }
      }
      return null
    }

    const apply = (c: { x: number; y: number }, free: boolean, client: { x: number; y: number }) => {
      if (!gesture) return
      const sn = snapper(d0, free)
      const snapPt = { x: sn(c.x), y: sn(c.y) }
      switch (gesture.kind) {
        case 'grow': {
          const lg = at(gesture.line)
          if (!lg) return
          const lid = gesture.line
          const dx = snapPt.x - lg.sx, dy = snapPt.y - lg.sy
          writeStoryline(id, x0, y0, { ...d0, lines: d0.lines.map(l => (l.id === lid ? { ...l, dx, dy } : l)) })
          return
        }
        case 'sprout': {
          // A new point at the spot pressed, and a branch from it to the
          // cursor's dot. Back at the spot, nothing at all.
          const lg = at(gesture.line)
          if (!lg) return
          const sx = lg.sx + lg.ux * gesture.t, sy = lg.sy + lg.uy * gesture.t
          const dx = snapPt.x - sx, dy = snapPt.y - sy
          if (Math.hypot(dx, dy) * zoom < RING_HIT) { writeStoryline(id, x0, y0, d0); return }
          writeStoryline(id, x0, y0, {
            ...d0,
            points: [...d0.points, { id: gesture.point, line: gesture.line, t: gesture.t, up: 0, down: 0, title: '' }],
            lines: [...d0.lines, { id: gesture.branch, from: gesture.point, x: 0, y: 0, dx, dy }],
          })
          return
        }
        case 'slide': {
          const pid = gesture.point
          const p = d0.points.find(q => q.id === pid)
          const lg = p && at(p.line)
          if (!p || !lg) return
          // Over another line, away from this point: the dot's contents would
          // hop there (only if it holds any: a plain dot shows no target), or
          // the ring's point would re-attach there (on this storyline, not
          // onto what grows from it). The line is lit, the point waits.
          const below = gesture.carry ? branchesOf(d0, pid).lines : null
          const target = gesture.hop && pointHolds(p)
            ? dropAt(client, c, sn, pid, (n, l) => n === id && (l === p.line || d0.lines.some(q => q.id === l && q.from === pid)))
            : below ? dropAt(client, c, sn, pid, (n, l) => n !== id || l === p.line || below.has(l))
            : null
          if (target) {
            useStoryUi.getState().set({ drop: target, merge: pointAt(target.node, target.line, target.t, pid) })
            writeStoryline(id, x0, y0, d0); moveCards(gesture.cards, 0, 0)
            return
          }
          const next = slideStoryPoint(d0, pid, (snapPt.x - lg.sx) * lg.ux + (snapPt.y - lg.sy) * lg.uy)
          // Landing on a neighbour merges into it: lit before it is let go.
          const t1 = next.points.find(q => q.id === pid)?.t ?? p.t
          const on = next.points.find(q => q.id !== pid && q.line === p.line && Math.abs(q.t - t1) < SAME_SPOT)
          useStoryUi.getState().set({ drop: null, merge: on ? { node: id, point: on.id } : null })
          // Both stay drawn till it is let go (the merge is made then).
          if (on) useFreeNodeStore.getState().updateFreeNode(id, normalizeStoryline(x0, y0, next))
          else writeStoryline(id, x0, y0, next)
          // Its cards, and those down the tree from it, go as far as it did.
          const a = g0.points[pid], z = storyGeom(next).points[pid]
          if (a && z) moveCards(gesture.cards, z.x - a.x, z.y - a.y)
          return
        }
        case 'tip': {
          // A branch straight across the line from the point, as long as the
          // drag (onto a dot's distance when snapping); short of its tick, none.
          const pid = gesture.point, side = gesture.side
          const pg = g0.points[pid]
          if (!pg) return
          const k = side === 'up' ? 1 : -1
          const len = sn(((c.x - x0 - pg.x) * pg.nx + (c.y - y0 - pg.y) * pg.ny) * k)
          if (len * zoom < TICK) { writeStoryline(id, x0, y0, d0); return }
          writeStoryline(id, x0, y0, { ...d0, lines: [...d0.lines, { id: gesture.line, from: pid, x: 0, y: 0, dx: pg.nx * len * k, dy: pg.ny * len * k }] })
          return
        }
        case 'group': {
          applyGroupDelta(gesture.base, c.x - c0.x, c.y - c0.y, sn, true, gesture.last)
          return
        }
        case 'move': {
          // Its root's start onto a dot: the whole storyline keeps to the grid.
          const root = d0.lines.find(l => !l.from)
          const rx = x0 + (root?.x ?? 0), ry = y0 + (root?.y ?? 0)
          const dx = sn(rx + c.x - c0.x) - rx, dy = sn(ry + c.y - c0.y) - ry
          useFreeNodeStore.getState().updateFreeNode(id, { x: x0 + dx, y: y0 + dy })
          moveCards(gesture.cards, dx, dy)
          return
        }
      }
    }

    const onMove = (ev: PointerEvent) => {
      const c = toCanvas(ev, host, wall)
      if (!c) return
      if (!gesture) {
        if (Math.hypot(c.x - c0.x, c.y - c0.y) * zoom < DRAG_PX) return
        moved = true
        gesture = decide(c)
        if (!gesture) return
        useUndoCoordinator.getState().checkpoint()
      }
      apply(c, ev.ctrlKey, { x: ev.clientX, y: ev.clientY })
    }
    const finish = (ev: PointerEvent, cancelled: boolean) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      busy.current = false
      const drop = useStoryUi.getState().drop
      useStoryUi.getState().set({ drop: null, merge: null })
      if (gesture?.kind === 'slide' && gesture.carry && drop && !cancelled) {
        const next = reattachStoryPoint(d0, gesture.point, drop.line, drop.t)
        writeStoryline(id, x0, y0, next)
        const a = g0.points[gesture.point], z = storyGeom(next).points[gesture.point]
        if (a && z) moveCards(cardOrigins(d0, pointAndBranches(d0, gesture.point).points), z.x - a.x, z.y - a.y)
        selectStoryPoint(id, gesture.point)
        return
      }
      if (gesture?.kind === 'slide' && gesture.hop && drop && !cancelled) {
        // Let go over another line: the contents hop, the point stays.
        writeStoryline(id, x0, y0, d0)
        hopStoryContents(id, gesture.point, drop)
        return
      }
      if (gesture) {
        // A drag is no click: it never starts a double-click.
        lastClick.current = null
        // A slide let go on a neighbour: the merge it showed is made.
        if (gesture.kind === 'slide') {
          const now = useFreeNodeStore.getState().nodes[id]
          if (now?.storyline) writeStoryline(id, now.x, now.y, now.storyline)
        }
        if (gesture.kind === 'slide') selectStoryPoint(id, gesture.point)
        if (gesture.kind === 'sprout' && useFreeNodeStore.getState().nodes[id]?.storyline?.points.some(q => q.id === (gesture as { point: string }).point)) {
          selectStoryPoint(id, gesture.point)
        }
        return
      }
      if (cancelled) return
      // A drag that came to nothing (along a line from an empty spot) is no
      // click either: it adds nothing.
      if (moved) { lastClick.current = null; return }
      // A click.
      if (role === 'line' && lineId) {
        const c = toCanvas(ev, host, wall) ?? c0
        const t = hover0?.node === id && hover0.line === lineId ? hover0.t : tickAt(lineId, c, ev.ctrlKey)
        if (t === null) return
        useUndoCoordinator.getState().checkpoint()
        const pid = crypto.randomUUID()
        writeStoryline(id, x0, y0, { ...d0, points: [...d0.points, { id: pid, line: lineId, t, up: 0, down: 0, title: '' }] })
        selectStoryPoint(id, pid)
        return
      }
      if (role === 'grab') {
        selectStoryline(id)
        return
      }
      if ((role === 'point' || role === 'ring') && pointId && (ev.shiftKey || ev.ctrlKey)) {
        toggleStoryPart(id, pointId)
        return
      }
      if ((role === 'point' || role === 'title' || role === 'ring') && pointId) {
        const last = lastClick.current
        const now = performance.now()
        // A double-click, on the dot or the title, names it; one click selects.
        const again = last?.point === pointId && now - last.at < DOUBLE_MS
        lastClick.current = again ? null : { point: pointId, at: now }
        selectStoryPoint(id, pointId, again)
        return
      }
      if (role === 'tip-up' || role === 'tip-down') {
        if (pointId) selectStoryPoint(id, pointId)
      }
    }
    const onUp = (ev: PointerEvent) => finish(ev, false)
    const onCancel = (ev: PointerEvent) => finish(ev, true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  return (
    <div
      ref={el => { worldRef.current = el?.closest<HTMLElement>('[data-world]') ?? null }}
      data-storyline={id}
      // Standing, its presses are its own (read on the wall, wallPoint).
      data-layer-pane={standing ? '' : undefined}
      style={{ position: 'absolute', left: node.x, top: node.y, width: 0, height: 0, overflow: 'visible',
               transformStyle: standing ? 'preserve-3d' : undefined }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onContextMenu={e => {
        const el = (e.target as Element).closest<HTMLElement | SVGElement>('[data-role]')
        const role = el?.dataset.role
        if (!role || role === 'ui') return
        e.preventDefault(); e.stopPropagation()
        const point = el?.dataset.point
        if (role === 'tether') {
          setMenu({ x: e.clientX, y: e.clientY, point, tether: el?.dataset.card })
          return
        }
        const line = el?.dataset.line ?? (point ? d.points.find(p => p.id === point)?.line : undefined)
        // What the menu acts on is selected first, as on tiles and cards.
        if (point) selectStoryPoint(id, point)
        else selectStoryline(id)
        setMenu({ x: e.clientX, y: e.clientY, point, line: role === 'grab' ? undefined : line, grab: role === 'grab' })
      }}
    >
      {/* The storyline itself: lying flat, or turned up about its foot as
          far as the view's tilt stands things up (standRise), so it rises
          and lies down with the standing cards; nothing else changes size
          or place. */}
      <div
        data-story-wall={standing ? 'up' : 'flat'}
        style={{
          position: 'absolute', left: 0, top: 0, width: 0, height: 0, overflow: 'visible',
          transformOrigin: foot ? `${foot.x0 - node.x}px ${foot.y0 - node.y}px` : '0 0',
          rotate: foot ? `${foot.ux} ${foot.uy} 0 ${standing ? turn * rise : 0}deg` : undefined,
        }}
      >
      <StorySvg id={id} d={d} g={g} w={node.width} h={node.height} px={px} sel={sel} parts={parts} zone={zone} drop={drop} flash={flash} merge={merge} hover={hover} linking={linking} picked={picked} tethers={standing && !cardsStand ? NO_TETHERS : tethers} />
      {(() => {
        const root = d.lines.find(l => !l.from)
        const lg = root && g.lines[root.id]
        if (!lg) return null
        // Off the start, across the main line on its down side (its tick and
        // title go up), a fixed distance on screen: a line grown either way
        // never runs under it.
        const n = upNormal(lg.ux, lg.uy)
        return <StoryGrab x={lg.sx - n.nx * GRAB_OFF * px} y={lg.sy - n.ny * GRAB_OFF * px} px={px} picked={picked} />
      })()}
      {d.points.map(p => {
        const pg = g.points[p.id]
        if (!pg) return null
        const isEditing = editing === p.id
        if (!p.title && !isEditing) return null
        const reach = Math.max(p.up, TICK * px) + 6 * px
        // A title sits up from its point, unless a branch grows that way: it
        // would lie across the branch and take its presses. Then it sits off
        // to the side, back along its line.
        const lg = g.lines[p.line]
        const upward = d.lines.some(l => l.from === p.id && (l.dx * pg.nx + l.dy * pg.ny) > 0.7 * Math.hypot(l.dx, l.dy))
        const aside = upward && lg
        const tx = aside ? pg.x - lg.ux * (RING_HIT + 4) * px : pg.x + pg.nx * reach
        const ty = aside ? pg.y - lg.uy * (RING_HIT + 4) * px : pg.y + pg.ny * reach
        return (
          <StoryTitle
            key={p.id} nodeId={id} pointId={p.id} title={p.title} editing={isEditing}
            x={tx} y={ty} side={aside ? sideFor(-lg.ux, -lg.uy) : sideFor(pg.nx, pg.ny)} px={px} selected={sel === p.id}
          />
        )
      })}
      {sel && g.points[sel] && (() => {
        const pg = g.points[sel]
        const p = d.points.find(q => q.id === sel)!
        const reach = Math.max(p.down, TICK * px) + 10 * px
        return <StoryOptions nodeId={id} snap={d.snap !== false} x={pg.x - pg.nx * reach} y={pg.y - pg.ny * reach} side={sideFor(-pg.nx, -pg.ny)} px={px} />
      })()}
      </div>
      {wall && !cardsStand && tethers.map(t => {
        // From the raised point down to the card on the ground.
        const fx = wall.x0 - node.x, fy = wall.y0 - node.y
        const along = (t.x1 - fx) * wall.ux + (t.y1 - fy) * wall.uy
        const up = (t.x1 - fx) * wall.nx + (t.y1 - fy) * wall.ny
        return <Tether3D key={`${t.point}:${t.card}`} t={t} sx={fx + wall.ux * along} sy={fy + wall.uy * along} sz={up} px={px} tone={d.color ?? C_DEFAULT} />
      })}
      {menu && <StoryMenu id={id} d={d} at={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** A tether in 3D: a thin bar from the card's edge on the ground (t.x2,
 *  t.y2) up to a standing point (sx, sy at height sz), canvas units. */
const Tether3D: React.FC<{ t: Tether; sx: number; sy: number; sz: number; px: number; tone: string }> = ({ t, sx, sy, sz, px, tone }) => {
  const [on, setOn] = useState(false)
  const vx = sx - t.x2, vy = sy - t.y2
  const flat = Math.hypot(vx, vy)
  const len = Math.hypot(flat, sz)
  const yaw = Math.atan2(vy, vx), pitch = Math.atan2(sz, flat)
  const w = 10 * px
  return (
    <div
      data-role="tether" data-point={t.point} data-card={t.card}
      onPointerEnter={() => setOn(true)} onPointerLeave={() => setOn(false)}
      style={{
        position: 'absolute', left: t.x2, top: t.y2 - w / 2, width: len, height: w,
        transformOrigin: `0 ${w / 2}px`, transform: `rotateZ(${yaw}rad) rotateY(${-pitch}rad)`,
        display: 'flex', alignItems: 'center', pointerEvents: 'auto',
      }}
    >
      <div style={{ width: '100%', height: 1.5 * px, background: on ? C_GLOW : tone, opacity: on ? 1 : 0.75,
                    boxShadow: `0 0 ${(on ? 6 : 4) * px}px ${tone}` }} />
    </div>
  )
}

const StorySvg: React.FC<{
  id: string; d: StorylineData; g: StoryGeom; w: number; h: number; px: number
  sel: string | null; parts: string[]; hover: { line: string; t: number } | null; linking: boolean; picked: boolean
  zone: { point: string; ring: boolean; tip?: 'up' | 'down' } | null; drop: { line: string; t: number } | null
  flash: { point: string; at: number } | null; merge: string | null; tethers: Tether[]
}> = ({ id, d, g, w, h, px, sel, parts, zone, drop, flash, merge, hover, linking, picked, tethers }) => {
  const [lit, setLit] = useState<string | null>(null)
  // Room round the box for handles and ticks, which reach past the lines,
  // and out to every tether's card: the box is what takes the pointer.
  const M = 60 * px + Math.max(0, ...d.points.map(p => Math.max(p.up, p.down)))
  const bx0 = Math.min(0, ...tethers.map(t => t.x2)) - M, by0 = Math.min(0, ...tethers.map(t => t.y2)) - M
  const bx1 = Math.max(w, ...tethers.map(t => t.x2)) + M, by1 = Math.max(h, ...tethers.map(t => t.y2)) + M
  const hl = hover && g.lines[hover.line]
  // Hovering a ring: the part of the tree that moves with it, lit.
  const chain = zone?.ring ? pointAndBranches(d, zone.point) : null
  const dl = drop && g.lines[drop.line]
  const tone = d.color ?? C_DEFAULT
  const LINE_W = d.weight ?? DEFAULT_WEIGHT
  // Ticks and point rings, lighter than the line at its heavier weights.
  const TICK_W = Math.min(LINE_W, 2 + LINE_W / 4)
  return (
    <svg
      style={{ position: 'absolute', left: bx0, top: by0, width: bx1 - bx0, height: by1 - by0, overflow: 'visible', pointerEvents: 'none' }}
    >
      <g transform={`translate(${-bx0} ${-by0})`} strokeLinecap="round">
        {/* Tethers: behind the lines and points, as the cards are in front. */}
        {tethers.map(t => {
          const key = `${t.point}:${t.card}`
          const on = lit === key
          return (
            <g key={key}>
              <line x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={tone} strokeOpacity={on ? 0.4 : 0.15} strokeWidth={(on ? 7 : 5) * px} pointerEvents="none" />
              <line x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={on ? C_GLOW : tone} strokeOpacity={on ? 1 : 0.7} strokeWidth={1.5 * px} pointerEvents="none" />
              <circle cx={t.x2} cy={t.y2} r={2.5 * px} fill={on ? C_GLOW : tone} pointerEvents="none" />
              <line x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke="transparent" strokeWidth={10 * px} pointerEvents="stroke"
                    data-role="tether" data-point={t.point} data-card={t.card}
                    onPointerEnter={() => setLit(key)} onPointerLeave={() => setLit(x => (x === key ? null : x))} />
            </g>
          )
        })}
        {/* The tick ends' grab zones, under the lines: where a line runs
            across one (a branch passing by), the line takes the press. */}
        {d.points.map(p => {
          const pg = g.points[p.id]
          if (!pg) return null
          return (['up', 'down'] as const).map(side => {
            const k = (side === 'up' ? 1 : -1) * Math.max(side === 'up' ? p.up : p.down, TICK * px)
            return (
              <circle key={`${p.id}:${side}`} cx={pg.x + pg.nx * k} cy={pg.y + pg.ny * k} r={TIP_R * px} fill="transparent"
                      pointerEvents="all" style={{ cursor: 'ns-resize' }}
                      data-role={`tip-${side}`} data-point={p.id} data-link-drop={`story:${id}:${p.id}:${side}`} />
            )
          })
        })}
        {d.lines.map(l => {
          const lg = g.lines[l.id]
          if (!lg || lg.len < 1e-6) return null
          const ex = lg.sx + lg.ux * lg.len, ey = lg.sy + lg.uy * lg.len
          return (
            <g key={l.id}>
              {picked && <line x1={lg.sx} y1={lg.sy} x2={ex} y2={ey} stroke={C_RING} strokeWidth={(LINE_W + 2 * RING_W) * px} />}
              {/* A soft glow of its own colour round the line. */}
              <line x1={lg.sx} y1={lg.sy} x2={ex} y2={ey} stroke={tone} strokeOpacity={0.18} strokeWidth={(LINE_W + 6) * px} />
              {(chain?.lines.has(l.id) || drop?.line === l.id) && (
                <line x1={lg.sx} y1={lg.sy} x2={ex} y2={ey} stroke={C_GLOW} strokeOpacity={0.45} strokeWidth={(LINE_W + 6) * px} pointerEvents="none" />
              )}
              <line x1={lg.sx} y1={lg.sy} x2={ex} y2={ey} stroke={tone} strokeOpacity={0.9} strokeWidth={LINE_W * px} />
              <line
                x1={lg.sx} y1={lg.sy} x2={ex} y2={ey} stroke="transparent" strokeWidth={Math.max(LINE_HIT, LINE_W + 8) * px}
                pointerEvents="stroke" style={{ cursor: 'pointer' }} data-role="line" data-line={l.id}
              />
            </g>
          )
        })}
        {hl && (() => {
          const { nx, ny } = { nx: -hl.uy, ny: hl.ux }
          const cx = hl.sx + hl.ux * hover!.t, cy = hl.sy + hl.uy * hover!.t
          const k = TICK * px
          return (
            <g pointerEvents="none">
              <line x1={cx - nx * k} y1={cy - ny * k} x2={cx + nx * k} y2={cy + ny * k} stroke={C_GLOW} strokeOpacity={0.3} strokeWidth={7 * px} />
              <line x1={cx - nx * k} y1={cy - ny * k} x2={cx + nx * k} y2={cy + ny * k} stroke={C_GLOW} strokeWidth={TICK_W * px} />
            </g>
          )
        })()}
        {dl && (
          // Where it would land: a dot ringed on the lit line.
          <circle cx={dl.sx + dl.ux * drop!.t} cy={dl.sy + dl.uy * drop!.t} r={RING_R * px} fill="none" stroke={C_GLOW} strokeWidth={2 * px} pointerEvents="none" />
        )}
        {d.points.map(p => {
          const pg = g.points[p.id]
          if (!pg) return null
          const up = Math.max(p.up, TICK * px), down = Math.max(p.down, TICK * px)
          const selected = sel === p.id
          const color = selected ? C_SEL : tone
          const r0 = DOT_R * px
          return (
            <g key={p.id}>
              <line x1={pg.x - pg.nx * down} y1={pg.y - pg.ny * down} x2={pg.x + pg.nx * up} y2={pg.y + pg.ny * up}
                    stroke={color} strokeWidth={TICK_W * px} />
              {/* The tick ends: a grab zone each, clear of the ring, lit on hover.
                  A card's link "+" let go on one links the card to this point,
                  so a raised stem takes cards as the point does. */}
              {(['up', 'down'] as const).map(side => {
                const k = side === 'up' ? up : -down
                const tx = pg.x + pg.nx * k, ty = pg.y + pg.ny * k
                return (
                  <g key={side}>
                    {linking && <circle cx={tx} cy={ty} r={TIP_R * px} fill={C_GLOW} fillOpacity={0.25} pointerEvents="none" />}
                    {zone?.point === p.id && zone.tip === side && (
                      <circle cx={tx} cy={ty} r={(TIP_R - 2) * px} fill={C_GLOW} fillOpacity={0.85} pointerEvents="none" />
                    )}
                  </g>
                )
              })}
              {linking && <circle cx={pg.x} cy={pg.y} r={RING_HIT * px} fill={C_GLOW} fillOpacity={0.25} pointerEvents="none" />}
              {(picked || parts.includes(p.id)) && <circle cx={pg.x} cy={pg.y} r={r0 + RING_W * px} fill={C_RING} pointerEvents="none" />}
              {/* The outer ring: its own grab zone. Bolder when it holds cards. */}
              <circle cx={pg.x} cy={pg.y} r={RING_R * px} fill="none" stroke={color}
                      strokeOpacity={(p.cards?.length ?? 0) > 0 ? 1 : 0.45} strokeWidth={1.5 * px} pointerEvents="none" />
              <circle cx={pg.x} cy={pg.y} r={r0} fill={color} stroke="#12131f" strokeWidth={1.5 * px} pointerEvents="none" />
              {/* Hover lights, on top: the zone the mouse is in; for the ring,
                  every point down the chain from it too. */}
              {merge === p.id && (
                // Let go now and the dragged point merges into this one.
                <circle cx={pg.x} cy={pg.y} r={RING_R * px} fill="none" stroke={C_SEL} strokeOpacity={0.9} strokeWidth={4 * px} pointerEvents="none" />
              )}
              {flash?.point === p.id && (
                // Would not go: a brief flash, nothing moved or resized.
                <circle key={flash.at} cx={pg.x} cy={pg.y} r={RING_R * px} fill={C_SEL} fillOpacity={0.7} pointerEvents="none">
                  <animate attributeName="opacity" from="1" to="0" dur="0.6s" fill="freeze" />
                </circle>
              )}
              {(zone?.ring ? chain?.points.has(p.id) : zone?.point === p.id && !zone.ring && !zone.tip) && (zone?.ring ? (
                <circle cx={pg.x} cy={pg.y} r={RING_R * px} fill="none" stroke={C_GLOW} strokeOpacity={0.8} strokeWidth={4 * px} pointerEvents="none" />
              ) : (
                <circle cx={pg.x} cy={pg.y} r={(DOT_R + 2) * px} fill={C_GLOW} fillOpacity={0.5} pointerEvents="none" />
              ))}
              <circle
                cx={pg.x} cy={pg.y} r={RING_HIT * px} fill="transparent" pointerEvents="all" style={{ cursor: 'move' }}
                data-role="ring" data-point={p.id} data-link-drop={`story:${id}:${p.id}`}
              />
              <circle
                cx={pg.x} cy={pg.y} r={DOT_ZONE * px} fill="transparent" pointerEvents="all" style={{ cursor: 'grab' }}
                data-role="point" data-point={p.id} data-link-drop={`story:${id}:${p.id}`}
              />
            </g>
          )
        })}
      </g>
    </svg>
  )
}

/** The grab handle: a small header tab beside where the root line starts
 *  (where a storyline's first point was put down), at one size on screen.
 *  Dragging it moves the whole storyline. */
const StoryGrab: React.FC<{ x: number; y: number; px: number; picked: boolean }> = ({ x, y, px, picked }) => {
  const dot = { width: 3, height: 3, borderRadius: '50%', background: 'rgba(196,208,255,0.7)' }
  return (
    <AtScreen x={x} y={y} px={px} side="centre">
    <div
      data-role="grab"
      title="Drag to move the storyline"
      style={{
        display: 'grid', gridTemplateColumns: 'repeat(2, 3px)', gap: 3, padding: '5px 4px',
        background: 'rgba(24,27,46,0.9)', border: '1px solid rgba(140,170,255,0.35)', borderRadius: 4,
        cursor: 'grab',
        boxShadow: picked ? `0 0 0 ${RING_W}px ${C_RING}` : 'none',
      }}
    >
      {Array.from({ length: 6 }, (_, i) => <div key={i} style={dot} />)}
    </div>
    </AtScreen>
  )
}

/** The right-click menu: on a point, a line or the grab handle. Laid out
 *  as a tile's menu (FreeNode). Each action is one undo step. */
const StoryMenu: React.FC<{
  id: string; d: StorylineData
  at: { x: number; y: number; point?: string; line?: string; grab?: boolean; tether?: string }
  onClose: () => void
}> = ({ id, d, at, onClose }) => {
  const [custom, setCustom] = useState(false)
  const groups = useBoardsStore(s => s.groups)
  const point = at.point ? d.points.find(p => p.id === at.point) : undefined
  const line = at.line ? d.lines.find(l => l.id === at.line) : undefined
  const items: { label: string; icon: string; danger?: boolean; disabled?: boolean; note?: string; action: () => void }[] = []
  // Branches growing from the point: each can go from here.
  const grown = point ? d.lines.filter(l => l.from === point.id) : []
  const fromHere = () => grown.forEach((l, k) => items.push({
    label: grown.length > 1 ? `Delete branch from here ${k + 1}` : 'Delete branch from here', icon: '🗑️', danger: true,
    action: () => editStoryline(id, x => deleteStoryBranch(x, l.id)),
  }))
  if (point && at.tether) {
    // A tether's own menu: just this card's link.
    const gid = at.tether
    const g = groups.find(x => x.id === gid)
    items.push({ label: `Unlink ${g?.cardHeaderText || g?.name || 'card'}`, icon: '⛓️', action: () => editStoryline(id, x => unlinkStoryCard(x, point.id, gid)) })
  } else if (point) {
    for (const gid of point.cards ?? []) {
      const g = groups.find(x => x.id === gid)
      const name = g?.cardHeaderText || g?.name || 'card'
      items.push({ label: `Unlink ${name}`, icon: '⛓️', action: () => editStoryline(id, x => unlinkStoryCard(x, point.id, gid)) })
    }
    // A plain point with branches growing from it holds them: it cannot go,
    // and says why, beside the way to take them.
    const stuck = grown.length > 0 && !pointHolds(point)
    items.push({ label: 'Delete point', icon: '🗑️', danger: true, disabled: stuck, note: stuck ? 'has branches' : undefined,
      action: () => editStoryline(id, x => deleteStoryPoint(x, point.id)) })
    fromHere()
  }
  if (line?.from) {
    items.push({ label: 'Delete branch', icon: '🗑️', danger: true, action: () => editStoryline(id, x => deleteStoryBranch(x, line.id)) })
  }
  if (!at.tether) items.push({ label: 'Delete storyline', icon: '🗑️', danger: true, action: () => {
    useUndoCoordinator.getState().checkpoint()
    useFreeNodeStore.getState().deleteFreeNode(id)
  } })
  const { ref, top } = useMenuClamp(at.y, `${items.length}:${custom}`)
  return ReactDOM.createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={onClose} onContextMenu={e => { e.preventDefault(); onClose() }} />
      <div
        ref={ref}
        data-storyline={id}
        onPointerDown={e => e.stopPropagation()}
        style={{
          position: 'fixed', left: Math.min(at.x, window.innerWidth - (at.grab ? 230 : 200)), top,
          minWidth: at.grab ? 220 : 170, zIndex: 9999,
          background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
          padding: '5px 0', fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ padding: '4px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: 4 }}>
          <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{at.tether ? 'Tether' : point ? point.title || 'Point' : line?.from ? 'Branch' : 'Storyline'}</span>
        </div>
        {at.grab && <StoryLook id={id} d={d} custom={custom} setCustom={setCustom} />}
        {items.map(item => (
          <button
            key={item.label}
            disabled={item.disabled}
            onClick={() => { onClose(); item.action() }}
            style={{
              display: 'flex', alignItems: 'center', gap: 9,
              width: '100%', padding: '7px 14px',
              background: 'none', border: 'none', cursor: item.disabled ? 'default' : 'pointer',
              color: item.danger ? '#f87171' : '#e2e8f0', opacity: item.disabled ? 0.4 : 1,
              fontSize: 13, textAlign: 'left', borderRadius: 4, whiteSpace: 'nowrap',
            }}
            onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = 'rgba(255,255,255,0.07)' }}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            <span style={{ fontSize: 14, width: 18, textAlign: 'center' }}>{item.icon}</span>
            {item.label}
            {item.note && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginLeft: 'auto', paddingLeft: 8 }}>{item.note}</span>}
          </button>
        ))}
      </div>
    </>,
    document.body,
  )
}

/** Set a storyline's look (colour, thickness). `checkpoint` false while a
 *  picker drag goes on: its press took the one undo step. */
function setStoryLook(id: string, patch: Pick<StorylineData, 'color' | 'weight' | 'standUp' | 'wallFoot'>, checkpoint = true) {
  const n = useFreeNodeStore.getState().nodes[id]
  if (!n?.storyline) return
  if (checkpoint) useUndoCoordinator.getState().checkpoint()
  useFreeNodeStore.getState().updateFreeNode(id, { storyline: { ...n.storyline, ...patch } })
}

/** The grab handle's options: line colour (swatches, and a custom picker
 *  behind its own switch) and thickness. Each change is one undo step. */
const StoryLook: React.FC<{ id: string; d: StorylineData; custom: boolean; setCustom: (on: boolean) => void }> = ({ id, d, custom, setCustom }) => {
  const tone = d.color ?? C_DEFAULT
  const weight = d.weight ?? DEFAULT_WEIGHT
  const label: React.CSSProperties = { color: 'rgba(255,255,255,0.55)', fontSize: 11, padding: '2px 14px 4px' }
  const chip = (on: boolean): React.CSSProperties => ({
    border: `1px solid ${on ? '#e2e8f0' : 'rgba(255,255,255,0.15)'}`, borderRadius: 5, cursor: 'pointer',
    background: on ? 'rgba(255,255,255,0.1)' : 'none', padding: 0,
  })
  return (
    <div style={{ paddingBottom: 6, marginBottom: 4, borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
      <div style={label}>Line colour</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 14px 6px' }}>
        {[C_DEFAULT, ...PRESET_COLORS].map(c => (
          <button key={c} title={c} onClick={() => setStoryLook(id, { color: c })}
                  style={{ ...chip(tone.toLowerCase() === c.toLowerCase()), width: 20, height: 20, padding: 2 }}>
            <span style={{ display: 'block', width: '100%', height: '100%', borderRadius: 3, background: c }} />
          </button>
        ))}
        <button title="Pick any colour" aria-pressed={custom} onClick={() => setCustom(!custom)}
                style={{ ...chip(custom), height: 20, padding: '0 6px', color: '#e2e8f0', fontSize: 11 }}>Custom</button>
      </div>
      {custom && (
        <div style={{ padding: '0 14px 8px' }} onPointerDownCapture={() => useUndoCoordinator.getState().checkpoint()}>
          <HexColorPicker color={tone} onChange={c => setStoryLook(id, { color: c }, false)} style={{ width: '100%', height: 120 }} />
        </div>
      )}
      <div style={label}>Thickness</div>
      <div style={{ display: 'flex', gap: 6, padding: '0 14px' }}>
        {WEIGHTS.map(w => (
          <button key={w} title={`${w}px`} onClick={() => setStoryLook(id, { weight: w })}
                  style={{ ...chip(weight === w), flex: 1, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ display: 'block', width: '70%', height: w, borderRadius: w, background: tone }} />
          </button>
        ))}
      </div>
      {/* An on/off box; its label never changes. */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px 0', color: '#e2e8f0', fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={!!d.standUp} onChange={e => {
          // Flipped up, it stands on its main line as it lies now; moved
          // afterwards it moves along and up that wall.
          const n = useFreeNodeStore.getState().nodes[id]
          const w = e.target.checked && n ? wallFootOf(n) : null
          setStoryLook(id, { standUp: e.target.checked || undefined, wallFoot: w ? { x: w.x0, y: w.y0, ux: w.ux, uy: w.uy } : undefined })
        }} />
        Flip up in 3D view
      </label>
    </div>
  )
}

type Side = 'above' | 'below' | 'left' | 'right' | 'centre'
const SIDE_SHIFT: Record<Side, string> = {
  above: 'translate(-50%, -100%)', below: 'translate(-50%, 0)',
  left: 'translate(-100%, -50%)', right: 'translate(0, -50%)',
  centre: 'translate(-50%, -50%)',
}

/** Chrome at a constant size on screen, lying on `side` of (`x`, `y`),
 *  centred along it. Flat it is laid out at natural size and scaled down by
 *  the zoom; on the tilted canvas, laid out at the zoom (worldZoom), it is
 *  zoomed back up instead, as CounterScaled does: scaled, it was drawn far
 *  too big there. */
const AtScreen: React.FC<{ x: number; y: number; px: number; side: Side; children: React.ReactNode }> = ({ x, y, px, side, children }) => {
  const z = useWorldZoom()
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: 0, height: 0 }}>
      <div style={z !== null
        ? { position: 'absolute', left: 0, top: 0, zoom: 1 / z, transform: SIDE_SHIFT[side], whiteSpace: 'nowrap' }
        : { position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', transform: `scale(${px}) ${SIDE_SHIFT[side]}`, whiteSpace: 'nowrap' }}>
        {children}
      </div>
    </div>
  )
}

const StoryTitle: React.FC<{
  nodeId: string; pointId: string; title: string; editing: boolean
  x: number; y: number; side: Side; px: number; selected: boolean
}> = ({ nodeId, pointId, title, editing, x, y, side, px, selected }) => {
  const [text, setText] = useState(title)
  const done = useRef(false)
  useEffect(() => { if (editing) { setText(title); done.current = false } }, [editing, title])
  const commit = (keep: boolean) => {
    if (done.current) return
    done.current = true
    useStoryUi.getState().set({ editing: null })
    const v = text.trim().slice(0, 80)
    const n = useFreeNodeStore.getState().nodes[nodeId]
    if (!keep || !n?.storyline || v === title) return
    useUndoCoordinator.getState().checkpoint()
    useFreeNodeStore.getState().updateFreeNode(nodeId, {
      storyline: { ...n.storyline, points: n.storyline.points.map(p => (p.id === pointId ? { ...p, title: v } : p)) },
    })
  }
  const font: React.CSSProperties = {
    fontSize: 12, lineHeight: '16px', fontFamily: 'system-ui, sans-serif',
    color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.9)',
  }
  if (editing) {
    return (
      <AtScreen x={x} y={y} px={px} side={side}><div data-role="ui">
        <input
          autoFocus value={text} maxLength={80} placeholder="Title"
          onChange={e => setText(e.target.value)}
          onPointerDown={e => e.stopPropagation()}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.key === 'Enter') commit(true)
            if (e.key === 'Escape') commit(false)
          }}
          onBlur={() => commit(true)}
          style={{
            ...font, width: 140, padding: '1px 5px', background: '#1a1c2c', textShadow: 'none',
            border: '1px solid rgba(143,194,255,0.6)', borderRadius: 4, outline: 'none', textAlign: 'center',
          }}
        />
      </div></AtScreen>
    )
  }
  return (
    <AtScreen x={x} y={y} px={px} side={side}>
      <div
        data-role="title" data-point={pointId}
        style={{ ...font, cursor: 'text', userSelect: 'none', padding: '0 3px', color: selected ? C_SEL : '#fff' }}
      >{title}</div>
    </AtScreen>
  )
}

/** The selected storyline's options, under its selected point. On/off
 *  switches, each with a label that never changes. */
const StoryOptions: React.FC<{ nodeId: string; snap: boolean; x: number; y: number; side: Side; px: number }> = ({ nodeId, snap, x, y, side, px }) => (
  <AtScreen x={x} y={y} px={px} side={side}>
  <div
    data-role="ui"
    style={{ display: 'flex', gap: 4, padding: 3, background: 'rgba(14,15,26,0.92)',
             border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6 }}
    onPointerDown={e => e.stopPropagation()}
  >
    <button
      title="Snap points and lines to the dot grid (hold Ctrl to place freely)"
      aria-pressed={snap}
      onClick={() => {
        const n = useFreeNodeStore.getState().nodes[nodeId]
        if (!n?.storyline) return
        useUndoCoordinator.getState().checkpoint()
        useFreeNodeStore.getState().updateFreeNode(nodeId, { storyline: { ...n.storyline, snap: !snap } })
      }}
      style={{
        fontSize: 11, lineHeight: '14px', padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
        fontFamily: 'system-ui, sans-serif',
        color: snap ? '#12131f' : 'rgba(255,255,255,0.75)',
        background: snap ? C_POINT : 'transparent',
        border: `1px solid ${snap ? C_POINT : 'rgba(255,255,255,0.25)'}`,
      }}
    >Snap</button>
  </div>
  </AtScreen>
)
