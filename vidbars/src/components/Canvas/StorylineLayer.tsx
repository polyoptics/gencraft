// StorylineLayer — draws every Storyline on the canvas and runs its editing
// (data: utils/storyline). A storyline is dots joined by straight lines, and
// editing it is as plain as that:
//
//  - Its base line: straight and level, a little stronger than the rest.
//    Its dots slide along it only; drag an end dot outward to lengthen it.
//    Everything else hangs off it as branches, freeform.
//  - Drag a dot's centre: it goes anywhere (snapped as cards are) with
//    everything downstream of it — the dots further from the base reached
//    through it, and their cards (lit as the mouse is over it); a base dot
//    slides with its branches. Shift+drag: that dot alone, its cards left where
//    they are. Let go on another dot (lit first), the two become one.
//  - Click a line: a dot goes in there, splitting it. Press on a line and
//    drag: the dot goes in and is dragged at once, bending the line.
//  - Drag out from a dot's outer ring: a new dot, joined to it, is dragged
//    out — from an end it extends the line, from a middle dot it branches.
//  - Click a dot to select it; double-click it (or its title) to name it.
//    Delete takes it out, its lines closing up (see deleteDot). Right-click a
//    dot or line: Delete, Delete branch (from a dot onward), Unlink a card.
//  - Each base dot has a decks button (StoryDecks), away from its branches:
//    click it to open every deck on its chain (the dot and the branches
//    hanging off it), again to close them all. Lit while they are open.
//  - Its label (title and description) sits under the base line from its
//    start, in canvas units, so it scales with the cards round it. Right-click
//    the grab handle (or the label): Title and description; double-click the
//    label to edit it. Pressed, the label acts as the grab handle: a click
//    selects the storyline, a drag moves it. Its corner handle scales all
//    its text (drag down to grow). Editing it shows the card face's text
//    toolbar, for the title and the description.
//  - The grab handle at the base's start moves the whole storyline (flipped
//    up, across the floor); right-click it for colour, thickness and Flip up
//    in 3D view. Click it to select the
//    storyline whole (ringed, as tiles are): Delete removes it.
//  - The canvas's selection box picks out the dots it covers (or the whole
//    storyline), with cards and tiles; a drag moves them all.
//  - A linked card hangs off its dot by a thin tether, behind the cards to
//    the card's nearest edge; hover lights it, right-click unlinks.
//
// World space (CLAUDE.md invariant 4): it lives inside the canvas transform,
// so every stroke, handle and label is divided by the zoom and stays the
// same size on screen.
//
// Tilted (TiltLayer): a press here is re-sent at the flat point under the
// cursor, so drags read their events as they do flat. Plain hovering is not
// re-sent: a trusted move while tilted is laid down on the plane here
// (toCanvas).
//
// "Flip up in 3D view" (StorylineData.standUp): tilted, the storyline stands
// up like a wall about its foot — a level line on the floor through its
// lowest point (dots and linked cards), fixed from when it starts to rise
// until it lies flat again, and below which nothing on the wall is dragged.
// Its 2D layout is the only truth: standing up and lying down moves nothing, rising with the tilt as the standing cards do (tiltStore standRise).
// TiltLayer re-sends presses at the ground's flat point, which is not where
// a wall is, so a standing storyline takes its own presses (data-layer-pane)
// and reads the cursor on the wall's plane (wallPoint). Its linked cards
// stand with it at card zoom (TiltLayer, storyWallOf); otherwise tethers run
// in 3D from the raised dots down to them (Tether3D).

import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import ReactDOM from 'react-dom'
import { HexColorPicker } from 'react-colorful'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { useFreeNodeStore, type FreeNodeData, type TextStyle, DEFAULT_HEADER_STYLE, DEFAULT_BODY_STYLE } from '../../store/freeNodeStore'
import { useCanvasStore, groupBounds } from '../../store/canvasStore'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { cardTitle } from '../../utils/faceStyle'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useExportProjectStore } from '../../store/exportProjectStore'
import { exportPickFor } from '../../utils/exportSelection'
import { useLinkDragStore } from '../../store/linkDragStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useMenuClamp } from '../../hooks/useMenuClamp'
import { useTiltStore, isTilted, standRise, unprojectTilt, TILT_FAR } from '../../store/tiltStore'
import { useWorldZoom } from './worldZoom'
import { clientToCanvas } from '../../utils/fx/createEffect'
import { snapToDots } from '../../utils/dotGrid'
import { bakeStoryline, chartOfStoryline, chartOutOf } from '../../utils/chartCard'
import { setLiveChartReader } from '../../utils/cardTypes'
import { morphStoryline, useChartMotion } from '../../utils/chartMotion'
import { onRows, openDeckOf, rowOf, rowsSeen } from '../../utils/primaryCard'
import { liveLocks, lockOf } from '../../utils/deckLock'
import { chainDecks, chainLocks, shownAs } from '../../utils/chainLock'
import { setStoryWallOf } from '../../utils/wallRoom'
import { ChangeMenu, MarkTags } from '../Layers/StateFace'
import { playMarks, toggleMark, type StateMark } from '../../utils/stateCard'
import { overWorldClock, useWorldClockUi } from '../../utils/worldClock'
import { dropLineOnStateSpace } from '../../utils/stateSpace'
import { PRESET_COLORS, TextFormatToolbar, ensureFontLoaded, hexToRgba, type TextFieldMode } from '../UI/TextFormatToolbar'
import {
  deleteBranchFrom, deleteDot, downstream, growDot, insertDot, isBaseEdge, mergeDots, migrateStoryline,
  normalizeStoryline, rootOf, sortBase, storylineEmpty, unlinkStoryCard, upNormal, type StoryDot, type StorylineData,
} from '../../utils/storyline'

// Screen px — divided by the zoom where drawn.
/** Line thickness choices, screen px; a storyline without one has the
 *  default. Its dot rings follow, a little lighter. */
const WEIGHTS = [2, 3.5, 5, 8]
const DEFAULT_WEIGHT = 3.5
const LINE_HIT = 14
const DOT_R = 5
/** A dot's two grab zones: its centre, out to DOT_ZONE (moves it), and its
 *  outer ring (drawn at RING_R) out to RING_HIT (grows a new dot from it). */
const DOT_ZONE = 6
const RING_R = 9
const RING_HIT = 13
const DRAG_PX = 4
const DOUBLE_MS = 400
const NONE: string[] = []
const NO_GROUPS: ProjectGroup[] = []
const NO_TETHERS: Tether[] = []
/** Screen px from the base's start leftward to the grab handle's middle:
 *  on the base's own height, clear of the start dot's ring, title and
 *  options and of the room under the base, whatever its lines do. */
const GRAB_OFF = 34
/** World layers holding a standing storyline, and how many. */
const standingWalls = new Map<HTMLElement, number>()

/** A storyline's colour, unless it has its own (StorylineData.color). */
const C_DEFAULT = '#8fc2ff'
const C_POINT = '#8fc2ff'
const C_GLOW = '#9fe0ff'
const C_SEL = '#ffd24a'
/** The selection ring tiles and cards get. */
const C_RING = 'rgba(120,180,255,0.9)'
const RING_W = 2.5

interface StoryUi {
  /** The selected dot. */
  sel: { node: string; point: string } | null
  /** Dots picked out by a selection box or Shift/Ctrl+click, by storyline. */
  parts: Record<string, string[]>
  /** Where a click on a line would put a dot (canvas units, the node's). */
  hover: { node: string; x: number; y: number } | null
  /** The dot whose title is being typed. */
  editing: { node: string; point: string } | null
  /** The storyline whose label (title and description) is being typed. */
  labelEditing: string | null
  /** The grab zone under the mouse: a dot's centre, or its ring. */
  zone: { node: string; point: string; ring: boolean } | null
  /** The dot a dragged dot let go now would merge into, lit. */
  merge: { node: string; point: string } | null
  /** Shift held: a drag moves its dot alone. */
  shift: boolean
  set: (patch: Partial<Omit<StoryUi, 'set'>>) => void
}

const useStoryUi = create<StoryUi>(set => ({
  sel: null, parts: {}, hover: null, editing: null, labelEditing: null, zone: null, merge: null, shift: false,
  set: patch => set(patch),
}))

/** A linked card's tether: from its dot to the nearest spot on the card's
 *  face, relative to the storyline's node. */
interface Tether { point: string; card: string; x1: number; y1: number; x2: number; y2: number }

/** Every linked card's tether. Not for a card pinned off the canvas, or one
 *  its dot sits on. The face: the card's block extent (groupBounds, less its
 *  16-unit docking margin) at least its set size. A card hidden in a closed
 *  deck hangs by its deck's front card, as the deck goes with its dot. */
function storyTethers(d: StorylineData, ox: number, oy: number, groups: ProjectGroup[]): Tether[] {
  const out: Tether[] = []
  const byId = new Map(groups.map(g => [g.id, g]))
  for (const p of d.dots) {
    for (const card of p.cards ?? []) {
      const grp = byId.get(shownAs(card, byId))
      const b = grp && !grp.pin ? groupBounds(grp.id) : null
      if (!grp || !b) continue
      const x0 = b.x + 16, w = Math.max(b.w - 32, grp.cardWidthOverride ?? 0), h = Math.max(b.h, grp.cardHeightOverride ?? 0)
      const px0 = ox + p.x, py0 = oy + p.y
      const cx = Math.max(x0, Math.min(x0 + w, px0)), cy = Math.max(b.y, Math.min(b.y + h, py0))
      if (cx === px0 && cy === py0) continue
      out.push({ point: p.id, card, x1: p.x, y1: p.y, x2: cx - ox, y2: cy - oy })
    }
  }
  return out
}

/** A standing storyline's wall: its foot line (canvas units), its up normal
 *  (the side that rises), and how far it is up (`a`, radians from flat). */
interface Wall { x0: number; y0: number; ux: number; uy: number; nx: number; ny: number; a?: number }

/** Client px → canvas units. A trusted event while tilted is where the
 *  cursor is on the tipped plane, laid flat here; a re-sent one (TiltLayer)
 *  is flat already; on a standing storyline, where it meets the wall. */
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

/** The card-link drop a standing storyline's dot is under the cursor, read
 *  as the cursor moves. TiltLayer re-sends the drop at the ground's flat
 *  point, where a wall is not (LinkDragOverlay asks here). */
let wallDrop: string | null = null
export function standingStoryDrop(): string | null { return wallDrop }

/** While a storyline stands (from when it starts to rise until it lies
 *  flat again): its foot, as how far below its base line it lies. Fixed
 *  then, so nothing done on the wall tips it about another line; moving the
 *  whole storyline moves it along. */
const frozenFeet = new Map<string, number>()
let feetVersion = 0


/** The cards linked to a storyline dot (`linked`: each goes with its own
 *  dot), and each card on the canvas that is one or holds some hidden in
 *  its closed deck, with how many (`held`). */
interface Links { linked: Set<string>; held: Map<string, number> }
function linksOf(byId: Map<string, ProjectGroup>, nodes: Record<string, FreeNodeData> = useFreeNodeStore.getState().nodes): Links {
  const linked = new Set<string>()
  for (const n of Object.values(nodes)) for (const p of n.storyline?.dots ?? []) for (const c of p.cards ?? []) linked.add(c)
  const held = new Map<string, number>()
  for (const c of linked) { const f = shownAs(c, byId); held.set(f, (held.get(f) ?? 0) + 1) }
  return { linked, held }
}

/** The cards linked card `c` goes with its dot as: itself, or, hidden in a
 *  closed deck, that deck's front card (the deck goes with the dot, unless
 *  its front card is linked to a dot of its own or it holds another linked
 *  card); then the open deck that card is the primary card of
 *  (utils/primaryCard openDeckOf), less any card that is or holds a card
 *  linked to a dot of its own, which goes with that dot. */
function withDeck(c: string, byId: Map<string, ProjectGroup>, k: Links): string[] {
  const id = shownAs(c, byId)
  if (id !== c && (k.linked.has(id) || (k.held.get(id) ?? 0) > 1)) return [c]
  return [id, ...openDeckOf(id).filter(m => !k.held.has(m))]
}

/** The lowest point (canvas y) of storyline `n`'s dots — `only` those —
 *  and the bottoms of the cards linked to them, as they go with their dots
 *  (withDeck: their decks, open or closed). */
function lowestOf(n: FreeNodeData, only?: Set<string>): number {
  let y = -Infinity
  const groups = useBoardsStore.getState().groups
  const byId = new Map(groups.map(g => [g.id, g]))
  const links = linksOf(byId)
  for (const p of n.storyline?.dots ?? []) {
    if (only && !only.has(p.id)) continue
    y = Math.max(y, n.y + p.y)
    for (const c of p.cards ?? []) for (const id of withDeck(c, byId, links)) {
      const g = byId.get(id)
      const b = g && !g.pin ? groupBounds(id) : null
      if (g && b) y = Math.max(y, b.y + Math.max(b.h, g.cardHeightOverride ?? 0))
    }
  }
  return y
}

/** Where a storyline flipped up stands: a level line through its lowest
 *  point, on the floor just where it lies flat (canvas units), so it stands
 *  up from the same 2D place it lies down in. */
function wallFootOf(n: FreeNodeData): Wall | null {
  const d = n.storyline
  if (!d?.dots?.length) return null
  const rid = rootOf(d)
  const s = d.dots.find(p => p.id === rid) ?? d.dots[0]
  const by = n.y + s.y
  const off = frozenFeet.get(n.id) ?? lowestOf(n) - by
  const { nx, ny } = upNormal(1, 0)
  return { x0: n.x + s.x, y0: by + off, ux: 1, uy: 0, nx, ny }
}

/** For TiltLayer: each storyline standing up in the tilted view, as it
 *  lies flat (canvas units): the y of its foot, how far up it is (0..1, as
 *  StorylineLayer stands it), its lines (x1, y1, x2, y2), its dots and the
 *  lines' thickness (screen px). TiltLayer lays a depth-only plate under
 *  each on the wall, so the 3D slabs' sides stand in front of it or behind
 *  it by real depth instead of painting over it. */
export function standingStories(): { footY: number; rise: number; segs: [number, number, number, number][]; dots: [number, number][]; weight: number }[] {
  const ts = useTiltStore.getState()
  if (!isTilted(ts)) return []
  const rise = standRise(ts)
  if (rise <= 0) return []
  const out: ReturnType<typeof standingStories> = []
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    const d = n.storyline
    if (!d?.standUp || n.pin || !d.dots?.length) continue
    const w = wallFootOf(n)
    if (!w) continue
    const at = new Map(d.dots.map(p => [p.id, p]))
    const segs: [number, number, number, number][] = []
    for (const e of d.edges) {
      const a = at.get(e.a), b = at.get(e.b)
      if (a && b) segs.push([n.x + a.x, n.y + a.y, n.x + b.x, n.y + b.y])
    }
    out.push({ footY: w.y0, rise, segs, dots: d.dots.map(p => [n.x + p.x, n.y + p.y]), weight: d.weight ?? DEFAULT_WEIGHT })
  }
  return out
}

/** For TiltLayer: the canvas y of the wall a linked card stands up on with
 *  its storyline (flipped up, its foot lying across the view, as standing
 *  cards stand), or null. */
let wallCards: { nodes: unknown; groups: unknown; feet: number; rows: number; map: Map<string, number> } | null = null
export function storyWallOf(groupId: string): number | null {
  const nodes = useFreeNodeStore.getState().nodes
  const groups = useBoardsStore.getState().groups
  if (wallCards?.nodes !== nodes || wallCards.groups !== groups || wallCards.feet !== feetVersion || wallCards.rows !== rowsSeen()) {
    const map = new Map<string, number>()
    // A linked card's deck stands with it, open or closed (withDeck).
    const decks: [string, number][] = []
    for (const n of Object.values(nodes)) {
      if (!n.storyline?.standUp || n.pin || !n.storyline.dots) continue
      const w = wallFootOf(n)
      if (!w || Math.abs(w.uy) > 1e-6) continue
      for (const p of n.storyline.dots) for (const c of p.cards ?? []) { map.set(c, w.y0); decks.push([c, w.y0]) }
    }
    if (decks.length) {
      const byId = new Map(groups.map(g => [g.id, g]))
      const links = linksOf(byId, nodes)
      for (const [c, y0] of decks) for (const id of withDeck(c, byId, links)) if (!map.has(id)) map.set(id, y0)
    }
    wallCards = { nodes, groups, feet: feetVersion, rows: rowsSeen(), map }
  }
  // At every zoom: a card, or zoomed in its outline with its blocks or
  // boards, all of it as one piece.
  return wallCards.map.get(groupId) ?? null
}
setStoryWallOf(storyWallOf)

/** Snapping as a card's corner snaps (utils/dotGrid snapToDots): pulled onto
 *  a dot only when close to one, so zoomed far out it stays as tight as the
 *  cards it is composed with. Ctrl, or the storyline's Snap off: free. */
function snapper(d: StorylineData, free: boolean) {
  const zoom = useCanvasStore.getState().zoom
  const on = d.snap !== false && !free
  return (v: number) => (on ? snapToDots(v, zoom) : v)
}

function writeStoryline(id: string, x: number, y: number, d: StorylineData) {
  useFreeNodeStore.getState().updateFreeNode(id, normalizeStoryline(x, y, d))
}

/** Edit a storyline as one undo step; one left with nothing to show goes. */
function editStoryline(id: string, edit: (d: StorylineData) => StorylineData, checkpoint = true) {
  const fs = useFreeNodeStore.getState()
  const n = fs.nodes[id]
  if (!n?.storyline) return
  if (checkpoint) useUndoCoordinator.getState().checkpoint()
  const d = edit(migrateStoryline(n.storyline))
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

/** A dot selected: the whole storyline is not. */
function selectStoryPoint(id: string, point: string, editing = false) {
  const fs = useFreeNodeStore.getState()
  if (fs.selectedIds.includes(id)) fs.setFreeSelection(fs.selectedIds.filter(x => x !== id))
  useStoryUi.getState().set({ sel: { node: id, point }, parts: {}, ...(editing ? { editing: { node: id, point } } : {}) })
}

/** Shift/Ctrl+click: a dot in or out of the selection, the rest kept. */
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

/** Every dot selected: the one clicked and those picked out. */
function storyPartsList(): { node: string; point: string }[] {
  const ui = useStoryUi.getState()
  const out = Object.entries(ui.parts).flatMap(([node, ps]) => ps.map(point => ({ node, point })))
  if (ui.sel && !out.some(q => q.node === ui.sel!.node && q.point === ui.sel!.point)) out.push(ui.sel)
  return out
}

/** The canvas's selection box, in client px: picks out the dots whose
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
  for (const wrap of document.querySelectorAll<HTMLElement>('[data-world] [data-storyline]')) {
    const id = wrap.dataset.storyline!
    const pts = [...wrap.querySelectorAll<SVGElement>('[data-role="point"]')]
    const hit = pts.filter(el => centreIn(el.getBoundingClientRect())).map(el => el.dataset.point!)
    if (pts.length && hit.length === pts.length) {
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
  /** Storylines with dots moving: where they were, which dots, and those
   *  dots' cards (not those carried anyway, selected themselves). */
  nodes: Map<string, { x: number; y: number; d: StorylineData; dots: Set<string>; cards: Map<string, { x: number; y: number }> }>
  stories: { node: string; x: number; y: number; rx: number; ry: number; cards: Map<string, { x: number; y: number }> }[]
  groups: Map<string, { x: number; y: number }>
  /** Cards a dot carries that share a row with a selected card: they go
   *  as the selected cards go, so the row stays together. */
  decks: Map<string, { x: number; y: number }>
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
  // A dot's cards in a row with a selected card (its open deck) go by the
  // selection's own amount, not snapped with the dot, so the row stays
  // together. Cards linked to a dot of their own go with their dots.
  const links = linksOf(new Map(bs.groups.map(g => [g.id, g])), fs.nodes)
  const sameRow = new Set<string>()
  for (const id of groups.keys()) for (const m of rowOf(id) ?? []) if (!links.held.has(m) && !groups.has(m)) sameRow.add(m)
  const decks: GroupBase['decks'] = new Map()
  const notCarried = (m: Map<string, { x: number; y: number }>) => {
    for (const k of groups.keys()) m.delete(k)
    for (const [k, o] of m) if (sameRow.has(k)) { decks.set(k, o); m.delete(k) }
    return m
  }
  const nodes: GroupBase['nodes'] = new Map()
  for (const { node, point } of storyPartsList()) {
    const n = fs.nodes[node]
    if (!n?.storyline?.dots) continue
    const e = nodes.get(node) ?? { x: n.x, y: n.y, d: n.storyline, dots: new Set<string>(), cards: new Map() }
    e.dots.add(point)
    nodes.set(node, e)
  }
  for (const e of nodes.values()) e.cards = notCarried(cardOrigins(e.d, e.dots))
  const stories: GroupBase['stories'] = []
  const tiles: string[] = []
  for (const sid of fs.selectedIds) {
    const n = fs.nodes[sid]
    if (!n || n.pin) continue
    if (n.storyline) {
      const s = n.storyline.dots?.[0]
      stories.push({ node: sid, x: n.x, y: n.y, rx: n.x + (s?.x ?? 0), ry: n.y + (s?.y ?? 0),
        cards: notCarried(cardOrigins(n.storyline, new Set((n.storyline.dots ?? []).map(q => q.id)))) })
    } else tiles.push(sid)
  }
  return { nodes, stories, groups, decks, tiles }
}

/** The selection moved by the drag (dx, dy): its dots, their cards with
 *  them, and whole storylines as by their grab handle. `sn` snaps (identity
 *  when following a drag made elsewhere). `own`: this drag is ours, so the
 *  selected cards and tiles move here too; else they moved already, and a
 *  storyline that moved with them only brings its cards. */
function applyGroupDelta(b: GroupBase, dx: number, dy: number, sn: (v: number) => number, own: boolean, last: { dx: number; dy: number }) {
  ownMove = true
  try {
    const moves: { groupId: string; originX: number; originY: number }[] = []
    for (const [node, e] of b.nodes) {
      // Its first selected dot onto a dot of the grid; the rest as far.
      const lead = e.d.dots.find(p => e.dots.has(p.id))
      const mx = lead ? sn(e.x + lead.x + dx) - (e.x + lead.x) : dx, my = lead ? sn(e.y + lead.y + dy) - (e.y + lead.y) : dy
      // Base dots keep to the base, unless all of it moves.
      const base = new Set(e.d.base ?? [])
      const level = [...base].every(b => e.dots.has(b))
      writeStoryline(node, e.x, e.y, sortBase({ ...e.d, dots: e.d.dots.map(p => (e.dots.has(p.id)
        ? { ...p, x: p.x + mx, y: p.y + (base.has(p.id) && !level ? 0 : my) } : p)) }))
      for (const [groupId, o] of e.cards) moves.push({ groupId, originX: o.x + mx, originY: o.y + my })
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
    for (const [groupId, o] of b.decks) moves.push({ groupId, originX: o.x + dx, originY: o.y + dy })
    if (own) {
      for (const [groupId, o] of b.groups) moves.push({ groupId, originX: o.x + dx, originY: o.y + dy })
      if (b.tiles.length) fs.moveManyFreeNodes(b.tiles, dx - last.dx, dy - last.dy)
      last.dx = dx; last.dy = dy
    }
    if (moves.length) useBoardsStore.getState().setGroupPosBatch(moves)
  } finally { ownMove = false }
}

/** The cards the story follower moves with a drag begun by this press (it
 *  captures them first): a card drag does not bump into them. */
let followCarried = new Set<string>()
export const storyCarried = (): Set<string> => followCarried

/** Selected dots (and whole storylines) come along when the selected cards
 *  or tiles round them are dragged, by the same amount: read off the first
 *  of those that moved since the press. */
function useStoryFollow() {
  useEffect(() => {
    let base: GroupBase | null = null
    let ref: { kind: 'group' | 'tile'; id: string; x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => {
      base = null; ref = null; followCarried = new Set()
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
      if (base) followCarried = new Set([...base.decks.keys(), ...[...base.nodes.values()].flatMap(n => [...n.cards.keys()]), ...base.stories.flatMap(st => [...st.cards.keys()])])
    }
    const onUp = () => { base = null; ref = null; followCarried = new Set() }
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

/** Delete the dots selected, each by deleteDot; one undo step
 *  (`checkpoint` false: the canvas's Delete took it). */
function deleteStorySelected(list: { node: string; point: string }[], checkpoint: boolean) {
  if (checkpoint) useUndoCoordinator.getState().checkpoint()
  for (const node of new Set(list.map(q => q.node))) {
    editStoryline(node, d => {
      for (const { point } of list.filter(q => q.node === node)) d = deleteDot(d, point)
      return d
    }, false)
  }
}

/** The cards linked to these dots, with their decks' cards (closed, or
 *  open with the linked card as primary: withDeck), where each one is now.
 *  Pinned cards have left the canvas: they stay. */
export function cardOrigins(d: StorylineData, dotIds: Set<string>): Map<string, { x: number; y: number }> {
  const groups = useBoardsStore.getState().groups
  const byId = new Map(groups.map(g => [g.id, g]))
  const links = linksOf(byId)
  const ids = new Set<string>()
  for (const p of d.dots ?? []) if (dotIds.has(p.id)) for (const c of p.cards ?? []) for (const m of withDeck(c, byId, links)) ids.add(m)
  let grew = true
  while (grew) {
    grew = false
    for (const g of groups) if (!ids.has(g.id) && g.deckAnchorId && ids.has(g.deckAnchorId)) { ids.add(g.id); grew = true }
  }
  const out = new Map<string, { x: number; y: number }>()
  for (const g of groups as ProjectGroup[]) if (ids.has(g.id) && !g.pin) out.set(g.id, { x: g.originX, y: g.originY })
  return out
}

// A chart out on the canvas: ranks on it (card backs) read it as it stands.
setLiveChartReader(cardId => { const n = chartOutOf(cardId); return n ? chartOfStoryline(n, cardOrigins) : null })

function moveCards(from: Map<string, { x: number; y: number }>, dx: number, dy: number) {
  if (from.size === 0) return
  useBoardsStore.getState().setGroupPosBatch(
    [...from].map(([groupId, o]) => ({ groupId, originX: o.x + dx, originY: o.y + dy })))
}

/** The storyline dot card `groupId` is linked to, if any. */
export function storyLinkOf(groupId: string): { node: string; point: string } | null {
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    const p = n.storyline?.dots?.find(q => q.cards?.includes(groupId))
    if (p) return { node: n.id, point: p.id }
  }
  return null
}

/** Let card `groupId` go from whatever storyline dot holds it; it stays
 *  where it is. The caller takes the undo checkpoint. */
export function unlinkCardFromStorylines(groupId: string) {
  const at = storyLinkOf(groupId)
  if (!at) return
  const n = useFreeNodeStore.getState().nodes[at.node]
  if (n?.storyline) useFreeNodeStore.getState().updateFreeNode(at.node, { storyline: unlinkStoryCard(n.storyline, at.point, groupId) })
}

/** Link card `groupId` to dot `dotId` (a card's link "+" let go on it;
 *  LinkDragOverlay). A card follows one dot: off any other first. The caller
 *  takes the undo checkpoint. */
export function linkCardToStoryPoint(nodeId: string, dotId: string, groupId: string, _side?: unknown) {
  const fs = useFreeNodeStore.getState()
  if (!fs.nodes[nodeId]?.storyline?.dots?.some(p => p.id === dotId)) return
  for (const n of Object.values(fs.nodes)) {
    if (!n.storyline?.dots) continue
    let changed = false
    const dots = n.storyline.dots.map(p => {
      const has = p.cards?.includes(groupId) ?? false
      const want = n.id === nodeId && p.id === dotId
      if (has === want) return p
      changed = true
      const cards = want ? [...(p.cards ?? []), groupId] : p.cards!.filter(c => c !== groupId)
      return { ...p, cards: cards.length ? cards : undefined }
    })
    if (changed) fs.updateFreeNode(n.id, { storyline: { ...n.storyline, dots } })
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
 *  storyline dot is under the cursor, from the real (tipped) view, so a drop
 *  there finds it (standingStoryDrop). */
/** The standing storyline's dot under the cursor (client px, as seen
 *  tilted), as a card's link "+" is dragged: TiltedView asks with each
 *  move it takes, as it keeps the move from listeners after it. */
export function seeWallDrop(clientX: number, clientY: number) {
  wallDrop = null
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const attr = el.getAttribute('data-link-drop')
    if (attr === null) continue
    if (attr.startsWith('story:') && el.closest('[data-story-wall="up"]')) wallDrop = attr
    break
  }
}
function useWallDrops() {
  const linking = useLinkDragStore(s => s.active)
  useEffect(() => {
    wallDrop = null
    if (!linking) return
    const onMove = (e: PointerEvent) => { if (e.isTrusted) seeWallDrop(e.clientX, e.clientY) }
    window.addEventListener('pointermove', onMove, true)
    return () => { window.removeEventListener('pointermove', onMove, true); wallDrop = null }
  }, [linking])
}

/** Delete / Backspace takes the selected dots out (deleteDot). Esc lets go
 *  of them. A press anywhere else lets go of them too. A whole storyline
 *  selected is the canvas's Delete, as a tile. */
function useStoryKeys() {
  useEffect(() => {
    const onShift = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && useStoryUi.getState().shift !== (e.type === 'keydown')) useStoryUi.getState().set({ shift: e.type === 'keydown' })
    }
    const onBlur = () => { if (useStoryUi.getState().shift) useStoryUi.getState().set({ shift: false }) }
    const onKey = (e: KeyboardEvent) => {
      onShift(e)
      const ui = useStoryUi.getState()
      const list = storyPartsList()
      if (!list.length || ui.editing) return
      const tag = (document.activeElement as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'Escape') { ui.set({ sel: null, parts: {} }); return }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      ui.set({ sel: null, parts: {}, hover: null })
      // Selected along with cards or tiles: the canvas's Delete takes them,
      // and its checkpoint first, so the dots go right after it, in the same
      // undo step.
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
    window.addEventListener('keyup', onShift, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onShift, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [])
}

/** The nearest spot on line a–b to (x, y), and how far along it (0..1). */
function onSegment(a: StoryDot, b: StoryDot, x: number, y: number): { x: number; y: number; k: number } {
  const vx = b.x - a.x, vy = b.y - a.y
  const L = vx * vx + vy * vy
  const k = L > 1e-9 ? Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / L)) : 0
  return { x: a.x + vx * k, y: a.y + vy * k, k }
}

/** Per dot, its two grab zones' outlines (SVG points, node units). */
type ScreenHits = Record<string, { ring: string; point: string }>

/** Tilted, each dot's grab zones as circles on screen: round the dot's
 *  middle as drawn (its box's centre, as the view projects it), at the
 *  zones' radii in screen px, laid back on the plane — or, standing, the
 *  wall — point by point (toCanvas). A dot not on screen keeps its circles. */
function screenHits(host: HTMLElement, n: FreeNodeData, wall: Wall | null): ScreenHits {
  const out: ScreenHits = {}
  const ring = (cx: number, cy: number, r: number): string | null => {
    const pts: string[] = []
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2
      const c = toCanvas({ clientX: cx + Math.cos(a) * r, clientY: cy + Math.sin(a) * r, isTrusted: true }, host, wall)
      if (!c) return null
      pts.push(`${(c.x - n.x).toFixed(2)},${(c.y - n.y).toFixed(2)}`)
    }
    return pts.join(' ')
  }
  for (const el of host.querySelectorAll<SVGElement>('[data-dot-centre]')) {
    const r = el.getBoundingClientRect()
    if (!r.width && !r.height) continue
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    const a = ring(cx, cy, RING_HIT), b = ring(cx, cy, DOT_ZONE)
    if (a && b) out[el.dataset.dotCentre!] = { ring: a, point: b }
  }
  return out
}

/** A drag in hand: a dot moving with the dots it brings (`moves`, it among
 *  them; `cards` theirs, where they were; `slide` along the base), or the
 *  whole storyline, or the selection. */
type Gesture =
  | { kind: 'dot'; dot: string; d: StorylineData; moves: Set<string>; slide: boolean; cards: Map<string, { x: number; y: number }>; low?: number }
  | { kind: 'move'; cards: Map<string, { x: number; y: number }> }
  | { kind: 'group'; base: GroupBase; last: { dx: number; dy: number } }

const Storyline: React.FC<{ id: string }> = ({ id }) => {
  const node = useFreeNodeStore(s => s.nodes[id]) as FreeNodeData | undefined
  const zoom = useCanvasStore(s => s.zoom)
  const sel = useStoryUi(s => (s.sel?.node === id ? s.sel.point : null))
  const parts = useStoryUi(s => s.parts[id] ?? NONE)
  const zone = useStoryUi(s => (s.zone?.node === id ? s.zone : null))
  const merge = useStoryUi(s => (s.merge?.node === id ? s.merge.point : null))
  const hover = useStoryUi(s => (s.hover?.node === id ? s.hover : null))
  const editing = useStoryUi(s => (s.editing?.node === id ? s.editing.point : null))
  const labelEditing = useStoryUi(s => s.labelEditing === id)
  const shift = useStoryUi(s => s.shift)
  const linking = useLinkDragStore(s => s.active && s.source?.kind === 'group')
  const busy = useRef(false)
  const lastClick = useRef<{ point: string; at: number } | null>(null)
  const picked = useFreeNodeStore(s => s.selectedIds.includes(id))
  // Folding into its card or coming out of it (utils/chartMotion).
  const motion = useChartMotion(s => s.m[id])
  const [menu, setMenu] = useState<{ x: number; y: number; point?: string; line?: [string, string]; grab?: boolean; tether?: string } | null>(null)
  // State changes put on a dot (utils/stateCard): their list, beside it.
  const [changeMenu, setChangeMenu] = useState<{ x: number; y: number; point: string } | null>(null)
  // Saved before dots: made dots once, as it loads.
  const raw = node?.storyline
  useEffect(() => {
    if (raw && migrateStoryline(raw) !== raw) {
      const n = useFreeNodeStore.getState().nodes[id]
      if (!n) return
      const m = migrateStoryline(raw)
      // Dots its base straightened bring their cards.
      for (const p of m.dots) {
        const was = raw.dots?.find(q => q.id === p.id)
        if (was && p.cards?.length && (was.x !== p.x || was.y !== p.y)) moveCards(cardOrigins(raw, new Set([p.id])), p.x - was.x, p.y - was.y)
      }
      writeStoryline(id, n.x, n.y, m)
    }
  }, [id, raw])

  // Linked cards, followed where they sit (their tethers).
  const hasCards = !!raw?.dots?.some(p => p.cards?.length)
  const groups = useBoardsStore(s => (hasCards ? s.groups : NO_GROUPS))
  useBoardsStore(s => (hasCards ? s.boards : null))

  // Flipped up, in the tilted view: a wall standing on its main line.
  const tilted = useTiltStore(s => isTilted(s))
  // Up as far as the standing cards are, following the tilt.
  const rise = useTiltStore(s => (raw?.standUp ? standRise(s) : 0))
  const standing = tilted && !!raw?.standUp && rise > 0
  // Its foot fixed as it starts to rise, let go once it lies flat again.
  if (standing && !frozenFeet.has(id) && node?.storyline?.dots) {
    const f = wallFootOf(node)
    const s = node.storyline.dots.find(p => p.id === rootOf(node.storyline!))
    if (f && s) { frozenFeet.set(id, f.y0 - (node.y + s.y)); feetVersion++ }
  }
  useEffect(() => {
    if (!standing && frozenFeet.delete(id)) feetVersion++
  }, [standing, id])
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

  // Tilted: each dot's grab zones as the shapes on the plane (or wall) that
  // show as circles on screen, round its dot as drawn, so its ring is as
  // easy to take from any side. Remeasured as the view moves.
  const [hits, setHits] = useState<ScreenHits | null>(null)
  const outerRef = useRef<HTMLDivElement | null>(null)
  const view = useTiltStore(s => (isTilted(s) ? `${s.tilt}|${s.spin}|${s.shiftX}|${s.shiftY}|${rise}` : ''))
  useCanvasStore(s => s.pan)
  useLayoutEffect(() => {
    // Measured just after, not here: a press TiltLayer re-sends lays the
    // view's boxes flat while it runs, and this can run inside one.
    const t = setTimeout(() => {
      const host = outerRef.current
      const n = useFreeNodeStore.getState().nodes[id]
      if (!view || !host || !n?.storyline?.dots) { setHits(h => (h ? null : h)); return }
      const f = wallFootOf(n)
      const w: Wall | null = standing && f ? { ...f, a: Math.PI / 2 * rise } : null
      const next = screenHits(host, n, w)
      setHits(h => (h && JSON.stringify(h) === JSON.stringify(next) ? h : next))
    }, 0)
    return () => clearTimeout(t)
  })

  if (!node || !raw?.dots) return null
  const d = morphStoryline(raw, motion)
  const px = 1 / zoom
  const byId = new Map(d.dots.map(p => [p.id, p]))
  const baseSet = new Set(d.base ?? [])
  // Folding or showing, they grow out of the dots and pull back in
  // (utils/chartMotion tether).
  const k = motion ? motion.tether ?? 0 : 1
  const tethers = hasCards && k > 0
    ? (k < 1 ? storyTethers(d, node.x, node.y, groups).map(t => ({ ...t, x2: t.x1 + (t.x2 - t.x1) * k, y2: t.y1 + (t.y2 - t.y1) * k })) : storyTethers(d, node.x, node.y, groups))
    : NO_TETHERS
  // It stands on its foot (kept from when it was flipped), relative to the
  // node; the up side rises: a quarter turn about it, the way that takes its
  // up normal to the viewer (+z).
  const foot = wallFootOf(node)
  const turn = foot && foot.ux * foot.ny - foot.uy * foot.nx < 0 ? -90 : 90
  const wall: Wall | null = standing && foot ? { ...foot, a: Math.PI / 2 * rise } : null
  // Its cards stand on the wall too, at card zoom (where they are cards)
  // while its foot lies across the view: TiltLayer turns them about the same
  // foot by the same angle, so they stay at their offsets from their dots.
  const cardsStand = !!wall && Math.abs(wall.uy) <= 1e-6
  // Over a dot's centre: what a drag of it moves, lit.
  const lit = zone && !zone.ring && byId.has(zone.point) ? (shift ? new Set([zone.point]) : downstream(d, zone.point)) : null

  /** A dot under client point (x, y) other than `self` (in this storyline),
   *  read off the view: what a dragged dot let go there merges into. */
  const dotUnder = (x: number, y: number, self: Set<string>): string | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      const r = el.getAttribute('data-role')
      if (r !== 'point' && r !== 'ring') continue
      const p = el.getAttribute('data-point')
      if (p && !self.has(p) && el.closest<HTMLElement>('[data-storyline]')?.dataset.storyline === id) return p
    }
    return null
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (busy.current) return
    const ui = useStoryUi.getState()
    if (e.shiftKey && !ui.shift) ui.set({ shift: true })
    const role = (e.target as Element).closest<HTMLElement | SVGElement>('[data-role]')
    // The grab zone under the mouse, lit.
    const r = role?.dataset.role
    const zp = r === 'point' || r === 'ring' ? role!.dataset.point : undefined
    const ring = r === 'ring'
    if (zp ? ui.zone?.node !== id || ui.zone.point !== zp || ui.zone.ring !== ring : ui.zone?.node === id) {
      ui.set({ zone: zp ? { node: id, point: zp, ring } : null })
    }
    // Over a line: where a click would put a dot.
    const a = r === 'line' ? byId.get(role!.dataset.a!) : undefined, b = r === 'line' ? byId.get(role!.dataset.b!) : undefined
    const c = a && b ? toCanvas(e.nativeEvent, e.currentTarget, wall) : null
    if (a && b && c) {
      const q = onSegment(a, b, c.x - node.x, c.y - node.y)
      ui.set({ hover: { node: id, x: q.x, y: q.y } })
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
    // The grab handle (and the label, which acts as it) moves it across the
    // floor, flipped up or not; all else is read on the wall.
    const plane = role === 'grab' || role === 'label' ? null : wall
    const one = e.shiftKey || useStoryUi.getState().shift
    const c0 = toCanvas(e.nativeEvent, host, plane)
    if (!c0) return
    const d0 = d
    const x0 = node.x, y0 = node.y
    const pointId = el?.dataset.point
    const ea = el?.dataset.a, eb = el?.dataset.b
    useStoryUi.getState().set({ hover: null })
    busy.current = true
    let gesture: Gesture | null = null
    let moved = false

    /** What the press becomes once it moves: the dot pressed moving, a new
     *  dot grown from a ring or put into a line and moving, the selection,
     *  or the whole storyline. */
    const decide = (): Gesture | null => {
      if (role === 'grab' || role === 'label') return { kind: 'move', cards: cardOrigins(d0, new Set(d0.dots.map(p => p.id))) }
      if ((role === 'point' || role === 'title') && pointId) {
        const ui = useStoryUi.getState()
        const mine = ui.sel?.node === id && ui.sel.point === pointId || (ui.parts[id] ?? []).includes(pointId)
        const bs = useBoardsStore.getState(), fs = useFreeNodeStore.getState()
        if (mine && storyPartsList().length + bs.selectedGroupIds.length + fs.selectedIds.length > 1) {
          return { kind: 'group', base: captureGroupBase(), last: { dx: 0, dy: 0 } }
        }
        // Shift: that dot alone, its cards staying where they are.
        const moves = one ? new Set([pointId]) : downstream(d0, pointId)
        return { kind: 'dot', dot: pointId, d: d0, moves, slide: !!d0.base?.includes(pointId), cards: one ? new Map() : cardOrigins(d0, moves),
                 low: wall && !one ? lowestOf(node, moves) : undefined }
      }
      if (role === 'ring' && pointId) {
        const p = byId.get(pointId)!
        const grown = growDot(d0, pointId, p.x, p.y)
        return { kind: 'dot', dot: grown.id, d: grown.d, moves: new Set([grown.id]), slide: !!grown.d.base?.includes(grown.id), cards: new Map() }
      }
      if (role === 'line' && ea && eb) {
        const a = byId.get(ea), b = byId.get(eb)
        if (!a || !b) return null
        const q = onSegment(a, b, c0.x - x0, c0.y - y0)
        const put = insertDot(d0, ea, eb, q.x, q.y)
        return { kind: 'dot', dot: put.id, d: put.d, moves: new Set([put.id]), slide: !!put.d.base?.includes(put.id), cards: new Map() }
      }
      return null
    }

    const apply = (c: { x: number; y: number }, free: boolean, client: { x: number; y: number }) => {
      if (!gesture) return
      const sn = snapper(d0, free)
      if (gesture.kind === 'group') { applyGroupDelta(gesture.base, c.x - c0.x, c.y - c0.y, sn, true, gesture.last); return }
      if (gesture.kind === 'move') {
        // Its start onto a dot of the grid: the whole storyline keeps to it.
        const s = d0.dots.find(q => q.id === rootOf(d0))
        const rx = x0 + (s?.x ?? 0), ry = y0 + (s?.y ?? 0)
        const dx = sn(rx + c.x - c0.x) - rx, dy = sn(ry + c.y - c0.y) - ry
        useFreeNodeStore.getState().updateFreeNode(id, { x: x0 + dx, y: y0 + dy })
        moveCards(gesture.cards, dx, dy)
        // Over the World clock: it lights, to take the storyline.
        const hot = overWorldClock(client.x, client.y)
        if (useWorldClockUi.getState().hot !== hot) useWorldClockUi.getState().set({ hot })
        return
      }
      // A dot, to the cursor's spot (snapped), with what it brings, its
      // lines following; a base dot along the base, passing the base dots
      // either side to reorder it (sortBase). Over another dot: that one is
      // lit, and letting go merges them.
      const g = gesture
      const p = g.d.dots.find(q => q.id === g.dot)
      if (!p) return
      let nx = sn(c.x) - x0, ny = sn(c.y) - y0
      if (g.slide) ny = p.y
      // Standing: the floor is as low as it goes.
      const low = g.low ?? (wall ? y0 + p.y : undefined)
      if (wall && low !== undefined) ny = Math.min(ny, p.y + wall.y0 - low)
      const dx = nx - p.x, dy = ny - p.y
      writeStoryline(id, x0, y0, sortBase({ ...g.d, dots: g.d.dots.map(q => (g.moves.has(q.id) ? { ...q, x: q.x + dx, y: q.y + dy } : q)) }))
      moveCards(g.cards, dx, dy)
      const over = dotUnder(client.x, client.y, g.moves)
      const ui = useStoryUi.getState()
      if ((ui.merge?.point ?? null) !== over) ui.set({ merge: over ? { node: id, point: over } : null })
    }

    const onMove = (ev: PointerEvent) => {
      const c = toCanvas(ev, host, plane)
      if (!c) return
      if (!gesture) {
        if (Math.hypot(c.x - c0.x, c.y - c0.y) * zoom < DRAG_PX) return
        moved = true
        gesture = decide()
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
      const into = useStoryUi.getState().merge
      useStoryUi.getState().set({ merge: null })
      if (gesture?.kind === 'dot') {
        const g = gesture
        const now = useFreeNodeStore.getState().nodes[id]
        if (!now?.storyline?.dots) return
        if (into && !cancelled) {
          // Let go on another dot: the two become one, there.
          writeStoryline(id, now.x, now.y, mergeDots(now.storyline, g.dot, into.point))
          selectStoryPoint(id, into.point)
        } else {
          // A grown dot let go on the dot it grew from is no dot at all.
          const p = now.storyline.dots.find(q => q.id === g.dot)
          const from = role === 'ring' && pointId ? now.storyline.dots.find(q => q.id === pointId) : undefined
          if (p && from && Math.hypot(p.x - from.x, p.y - from.y) * zoom < RING_HIT) {
            writeStoryline(id, now.x, now.y, deleteDot(now.storyline, g.dot))
          } else selectStoryPoint(id, g.dot)
        }
        lastClick.current = null
        return
      }
      // Let go on the World clock (bottom left): it goes back where it was
      // and becomes the world's timeline (components/UI/WorldClock).
      if (gesture?.kind === 'move') {
        const onClock = !cancelled && overWorldClock(ev.clientX, ev.clientY)
        useWorldClockUi.getState().set({ hot: false })
        if (onClock) {
          useFreeNodeStore.getState().updateFreeNode(id, { x: x0, y: y0 })
          moveCards(gesture.cards, 0, 0)
          useCanvasStore.getState().setWorldClockLine(id)
          useCanvasStore.getState().setWorldClockOpen(true)
        }
        // Let go over a state workspace: it goes back where it was and is a
        // timeline node there (utils/stateSpace).
        if (!cancelled && !onClock && moved && dropLineOnStateSpace(ev.clientX, ev.clientY, id, !ev.isTrusted)) {
          useFreeNodeStore.getState().updateFreeNode(id, { x: x0, y: y0 })
          moveCards(gesture.cards, 0, 0)
        }
      }
      if (gesture) { lastClick.current = null; return }
      if (cancelled || moved) { lastClick.current = null; return }
      // A click.
      if (role === 'line' && ea && eb) {
        const a = byId.get(ea), b = byId.get(eb)
        if (!a || !b) return
        const q = onSegment(a, b, c0.x - x0, c0.y - y0)
        useUndoCoordinator.getState().checkpoint()
        const put = insertDot(d0, ea, eb, q.x, q.y)
        writeStoryline(id, x0, y0, put.d)
        selectStoryPoint(id, put.id)
        return
      }
      if (role === 'grab') { selectStoryline(id); return }
      if (role === 'label') {
        // One click selects the storyline; a double-click edits the label.
        const last = lastClick.current
        const t = performance.now()
        const again = last?.point === LABEL_CLICK && t - last.at < DOUBLE_MS
        lastClick.current = again ? null : { point: LABEL_CLICK, at: t }
        selectStoryline(id)
        if (again) useStoryUi.getState().set({ labelEditing: id })
        return
      }
      if ((role === 'point' || role === 'ring') && pointId && (ev.shiftKey || ev.ctrlKey)) { toggleStoryPart(id, pointId); return }
      if ((role === 'point' || role === 'title' || role === 'ring') && pointId) {
        // A double-click, on the dot or its title, names it; one click selects.
        const last = lastClick.current
        const t = performance.now()
        const again = last?.point === pointId && t - last.at < DOUBLE_MS
        lastClick.current = again ? null : { point: pointId, at: t }
        selectStoryPoint(id, pointId, again)
      }
    }
    const onUp = (ev: PointerEvent) => finish(ev, false)
    const onCancel = (ev: PointerEvent) => finish(ev, true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  const start = byId.get(rootOf(d) ?? '')

  return (
    <div
      ref={el => { outerRef.current = el; worldRef.current = el?.closest<HTMLElement>('[data-world]') ?? null }}
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
        if (role === 'tether') { setMenu({ x: e.clientX, y: e.clientY, point, tether: el?.dataset.card }); return }
        const line = role === 'line' && el?.dataset.a && el.dataset.b ? [el.dataset.a, el.dataset.b] as [string, string] : undefined
        // What the menu acts on is selected first, as on tiles and cards.
        if (point) selectStoryPoint(id, point)
        else selectStoryline(id)
        setMenu({ x: e.clientX, y: e.clientY, point, line, grab: role === 'grab' || role === 'label' })
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
        <StorySvg id={id} d={d} w={node.width} h={node.height} px={px} sel={sel} parts={parts} zone={zone} merge={merge} hover={hover} moving={lit}
                  linking={linking} picked={picked} tethers={standing && !cardsStand ? NO_TETHERS : tethers} hits={hits} />
        {start && (
          // Left of the base's start, on its line (titles go above, the room
          // under the base is kept clear), a fixed distance on screen.
          <StoryGrab x={start.x - GRAB_OFF * px} y={start.y} px={px} picked={picked} />
        )}
        {d.dots.map(p => {
          const isEditing = editing === p.id
          if (!p.title && !isEditing) return null
          // Above its dot, unless a line leaves it upward: then to its left.
          const up = leaves(d, byId, p, -1)
          const reach = (RING_HIT + 4) * px
          // Over a base dot's decks button, when that sits above it.
          const lift = baseSet.has(p.id) && decksAbove(d, byId, p) ? DECKS_H * px : 0
          return (
            <StoryTitle
              key={p.id} nodeId={id} pointId={p.id} title={p.title} editing={isEditing}
              x={up ? p.x - reach : p.x} y={up ? p.y : p.y - reach - lift} side={up ? 'left' : 'above'} px={px} selected={sel === p.id}
            />
          )
        })}
        {(d.base ?? []).map(b => {
          // A base dot's decks button: below it, or above it when its
          // branches go down only.
          const p = byId.get(b)
          if (!p) return null
          const above = decksAbove(d, byId, p)
          const reach = (RING_HIT + 3) * px
          return (
            <React.Fragment key={b}>
              <StoryDecks nodeId={id} dotId={b} x={p.x} y={above ? p.y - reach : p.y + reach} side={above ? 'above' : 'below'} px={px} />
              {/* Beside it, to its right: lock the chain (StoryLock). */}
              <StoryLock nodeId={id} dotId={b} x={p.x + 24 * px} y={above ? p.y - reach : p.y + reach} side={above ? 'above' : 'below'} px={px} />
            </React.Fragment>
          )
        })}
        {d.dots.map(p => p.changes?.length ? (
          // What changes happen at this dot ("Cup → Broken").
          // Above it, over its title when it has one.
          <AtScreen key={`chg:${p.id}`} x={p.x} y={p.y - (RING_HIT + 4 + (p.title ? 20 : 0)) * px} px={px} side="above">
            <MarkTags marks={p.changes} font={10} />
          </AtScreen>
        ) : null)}
        {start && hasStoryMarks(d, groups) && <StoryMarker id={id} d={d} start={start} px={px} />}
        {sel && byId.get(sel) && (() => {
          const p = byId.get(sel)!
          // Under a base dot's decks button, when that sits below it.
          const drop = baseSet.has(p.id) && !decksAbove(d, byId, p) ? DECKS_H * px : 0
          return <StoryOptions nodeId={id} snap={d.snap !== false} x={p.x} y={p.y + (RING_HIT + 8) * px + drop} side="below" px={px} />
        })()}
      </div>
        {start && (labelEditing || d.title || d.description) && (() => {
          // Under the base from its start, clear of the decks buttons, as
          // wide as the base (a short base, a little wider), whatever its
          // scale: the text wraps there. Outside the
          // wall: flipped up, it stays lying on the floor in front of it.
          const xs = (d.base ?? []).map(b => byId.get(b)?.x).filter((x): x is number => x !== undefined)
          const len = xs.length ? Math.max(...xs) - start.x : 0
          const k = d.labelScale ?? LABEL_SCALE
          return (
            <StoryLabel nodeId={id} d={d} editing={labelEditing}
                        x={start.x} y={start.y + LABEL_GAP * px} k={k} px={px}
                        w={Math.max(LABEL_MIN_W * LABEL_SCALE, len) / k} />
          )
        })()}
      {wall && !cardsStand && tethers.map(t => {
        // From the raised dot down to the card on the ground.
        const fx = wall.x0 - node.x, fy = wall.y0 - node.y
        const along = (t.x1 - fx) * wall.ux + (t.y1 - fy) * wall.uy
        const up = (t.x1 - fx) * wall.nx + (t.y1 - fy) * wall.ny
        return <Tether3D key={`${t.point}:${t.card}`} t={t} sx={fx + wall.ux * along} sy={fy + wall.uy * along} sz={up} px={px} tone={d.color ?? C_DEFAULT} />
      })}
      {menu && <StoryMenu id={id} d={d} at={menu} onClose={() => setMenu(null)} onChanges={(x, y, point) => setChangeMenu({ x, y, point })} />}
      {changeMenu && (
        <ChangeMenu x={changeMenu.x} y={changeMenu.y} marks={d.dots.find(p => p.id === changeMenu.point)?.changes}
          onToggle={k => editStoryline(id, x => ({ ...x, dots: x.dots.map(p => p.id === changeMenu.point ? { ...p, changes: toggleMark(p.changes, k) } : p) }))}
          onClose={() => setChangeMenu(null)} />
      )}
    </div>
  )
}

/** A tether in 3D: a thin bar from the card's edge on the ground (t.x2,
 *  t.y2) up to a standing dot (sx, sy at height sz), canvas units. */
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
  id: string; d: StorylineData; w: number; h: number; px: number
  sel: string | null; parts: string[]; hover: { x: number; y: number } | null; linking: boolean; picked: boolean
  zone: { point: string; ring: boolean } | null; merge: string | null; tethers: Tether[]
  hits: ScreenHits | null; moving: Set<string> | null
}> = ({ id, d, w, h, px, sel, parts, zone, merge, hover, linking, picked, tethers, hits, moving }) => {
  const [lit, setLit] = useState<string | null>(null)
  // Room round the box for rings and handles, and out to every tether's
  // card: the box is what takes the pointer.
  const M = 60 * px
  const bx0 = Math.min(0, ...tethers.map(t => t.x2)) - M, by0 = Math.min(0, ...tethers.map(t => t.y2)) - M
  const bx1 = Math.max(w, ...tethers.map(t => t.x2)) + M, by1 = Math.max(h, ...tethers.map(t => t.y2)) + M
  const byId = new Map(d.dots.map(p => [p.id, p]))
  const tone = d.color ?? C_DEFAULT
  const LINE_W = d.weight ?? DEFAULT_WEIGHT
  return (
    <svg
      style={{ position: 'absolute', left: bx0, top: by0, width: bx1 - bx0, height: by1 - by0, overflow: 'visible', pointerEvents: 'none' }}
    >
      <g transform={`translate(${-bx0} ${-by0})`} strokeLinecap="round">
        {/* Tethers: behind the lines and dots, as the cards are in front. */}
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
        {d.edges.map(e => {
          const a = byId.get(e.a), b = byId.get(e.b)
          if (!a || !b) return null
          // The base line a little stronger than the rest.
          const lw = isBaseEdge(d, e.a, e.b) ? LINE_W * 1.6 : LINE_W
          return (
            <g key={`${e.a}|${e.b}`}>
              {picked && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={C_RING} strokeWidth={(lw + 2 * RING_W) * px} />}
              {moving?.has(e.a) && moving.has(e.b) && (
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={C_GLOW} strokeOpacity={0.35} strokeWidth={(lw + 8) * px} />
              )}
              {/* A soft glow of its own colour round the line. */}
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={tone} strokeOpacity={0.18} strokeWidth={(lw + 6) * px} />
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={tone} strokeOpacity={lw > LINE_W ? 1 : 0.9} strokeWidth={lw * px} />
              <line
                x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={Math.max(LINE_HIT, LINE_W + 8) * px}
                pointerEvents="stroke" style={{ cursor: 'copy' }} data-role="line" data-a={e.a} data-b={e.b}
              />
            </g>
          )
        })}
        {hover && (
          // Where a click puts a dot.
          <g pointerEvents="none">
            <circle cx={hover.x} cy={hover.y} r={(DOT_R + 3) * px} fill={C_GLOW} fillOpacity={0.3} />
            <circle cx={hover.x} cy={hover.y} r={(DOT_R - 1) * px} fill={C_GLOW} />
          </g>
        )}
        {d.dots.map(p => {
          const selected = sel === p.id
          const color = selected ? C_SEL : tone
          const r0 = DOT_R * px
          return (
            <g key={p.id}>
              {/* What a drag of the dot under the mouse moves, lit. */}
              {moving?.has(p.id) && <circle cx={p.x} cy={p.y} r={(RING_R + 3) * px} fill={C_GLOW} fillOpacity={0.22} pointerEvents="none" />}
              {linking && <circle cx={p.x} cy={p.y} r={RING_HIT * px} fill={C_GLOW} fillOpacity={0.25} pointerEvents="none" />}
              {(picked || parts.includes(p.id)) && <circle cx={p.x} cy={p.y} r={r0 + RING_W * px} fill={C_RING} pointerEvents="none" />}
              {/* The outer ring: grows a new dot. Bolder when it holds cards. */}
              <circle cx={p.x} cy={p.y} r={RING_R * px} fill="none" stroke={color}
                      strokeOpacity={(p.cards?.length ?? 0) > 0 ? 1 : 0.45} strokeWidth={1.5 * px} pointerEvents="none" />
              <circle cx={p.x} cy={p.y} r={r0} fill={color} stroke="#12131f" strokeWidth={1.5 * px} pointerEvents="none" data-dot-centre={p.id} />
              {merge === p.id && (
                // Let go now and the dragged dot merges into this one.
                <circle cx={p.x} cy={p.y} r={RING_R * px} fill="none" stroke={C_SEL} strokeOpacity={0.9} strokeWidth={4 * px} pointerEvents="none" />
              )}
              {zone?.point === p.id && (zone.ring ? (
                <circle cx={p.x} cy={p.y} r={RING_R * px} fill="none" stroke={C_GLOW} strokeOpacity={0.8} strokeWidth={4 * px} pointerEvents="none" />
              ) : (
                <circle cx={p.x} cy={p.y} r={(DOT_R + 2) * px} fill={C_GLOW} fillOpacity={0.5} pointerEvents="none" />
              ))}
              {/* Its two grab zones: tilted, the shapes on the plane that
                  look round on screen (screenHits). */}
              {hits?.[p.id] ? (
                <polygon points={hits[p.id].ring} fill="transparent" pointerEvents="all" style={{ cursor: 'crosshair' }}
                         data-role="ring" data-point={p.id} data-link-drop={`story:${id}:${p.id}`} />
              ) : (
                <circle
                  cx={p.x} cy={p.y} r={RING_HIT * px} fill="transparent" pointerEvents="all" style={{ cursor: 'crosshair' }}
                  data-role="ring" data-point={p.id} data-link-drop={`story:${id}:${p.id}`}
                />
              )}
              {hits?.[p.id] ? (
                <polygon points={hits[p.id].point} fill="transparent" pointerEvents="all" style={{ cursor: 'grab' }}
                         data-role="point" data-point={p.id} data-link-drop={`story:${id}:${p.id}`} />
              ) : (
                <circle
                  cx={p.x} cy={p.y} r={DOT_ZONE * px} fill="transparent" pointerEvents="all" style={{ cursor: 'grab' }}
                  data-role="point" data-point={p.id} data-link-drop={`story:${id}:${p.id}`}
                />
              )}
            </g>
          )
        })}
      </g>
    </svg>
  )
}

/** Whether a line leaves dot `p` mostly upward (`way` -1) or downward (1). */
function leaves(d: StorylineData, byId: Map<string, StoryDot>, p: StoryDot, way: 1 | -1): boolean {
  return d.edges.some(e => {
    const o = e.a === p.id ? byId.get(e.b) : e.b === p.id ? byId.get(e.a) : undefined
    return !!o && (o.y - p.y) * way > 0 && Math.abs(o.x - p.x) < Math.abs(o.y - p.y)
  })
}
/** A base dot's decks button sits above it only when its branches go down
 *  and none goes up; else below it. */
const decksAbove = (d: StorylineData, byId: Map<string, StoryDot>, p: StoryDot) => leaves(d, byId, p, 1) && !leaves(d, byId, p, -1)
/** Screen px a base dot's decks button takes up (with its gap). */
const DECKS_H = 22
/** Screen px from the base line down to its label: past the decks buttons. */
const LABEL_GAP = RING_HIT + 3 + DECKS_H + 8
/** The label's narrowest, its title's and description's sizes: canvas units. */
const LABEL_MIN_W = 320
/** The label's title and description as they start (the card face's). */
const LABEL_TITLE_STYLE: TextStyle = { ...DEFAULT_HEADER_STYLE, fontSize: 28, align: 'left', lineHeight: 1.2, fontWeight: 600 }
const LABEL_TEXT_STYLE: TextStyle = { ...DEFAULT_BODY_STYLE, fontSize: 15, color: '#dce4ff', lineHeight: 1.4 }
/** A new label's scale, times the sizes above. */
const LABEL_SCALE = 10
/** The label's resize handle: screen px. */
const LABEL_GRIP = 14
/** lastClick's key for the label (no dot has it). */
const LABEL_CLICK = '\u0000label'

/** A base dot's lock button (Brian 2026-11-05): locks every deck and card
 *  on its chain, so dragged over other cards the chart picks none up and
 *  nothing snaps to it; again to unlock them. One label and icon; lit
 *  while all of them are locked. Faint when its chain has no cards. */
const StoryLock: React.FC<{ nodeId: string; dotId: string; x: number; y: number; side: Side; px: number }> = ({ nodeId, dotId, x, y, side, px }) => {
  const groups = useBoardsStore(s => s.groups)
  useFreeNodeStore(s => s.nodes)
  useSyncExternalStore(onRows, rowsSeen)
  const locks = chainLocks(nodeId, dotId)
  const byId = new Map(groups.map(g => [g.id, g]))
  const live = liveLocks(groups)
  const ids = [...locks.values()].flat()
  const lit = ids.length > 0 && ids.every(id => !!lockOf(byId.get(id), live))
  const none = !ids.length
  return (
    <AtScreen x={x} y={y} px={px} side={side}>
    <button
      data-role="ui"
      data-story-lock={dotId}
      title="Lock every deck and card on this chain; click again to unlock them"
      aria-pressed={lit}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation()
        const now = chainLocks(nodeId, dotId)
        if (!now.size) return
        useUndoCoordinator.getState().checkpoint()
        const bs = useBoardsStore.getState()
        if (lit) { for (const all of now.values()) for (const id of all) bs.setDeckLock(id, null); return }
        for (const [front, all] of now) {
          if (all.length > 1) bs.setRowPrimary(front, all)
          bs.setDeckLock(front, all)
        }
      }}
      style={{
        display: 'block', width: 20, height: 16, padding: 0, borderRadius: 4, cursor: 'pointer',
        background: lit ? C_POINT : 'rgba(14,15,26,0.92)',
        border: `1px solid ${lit ? C_POINT : 'rgba(140,170,255,0.4)'}`,
        opacity: none ? 0.4 : 1,
      }}
    >
      <svg width={18} height={14} viewBox="0 0 18 14" style={{ display: 'block' }}>
        {/* A padlock, drawn like the decks button's cards. */}
        <rect x={5} y={6} width={8} height={6} rx={1} fill="none" stroke={lit ? '#12131f' : 'rgba(196,208,255,0.85)'} strokeWidth={1.2} />
        <path d="M6.8 6 V4.4 a2.2 2.2 0 0 1 4.4 0 V6" fill="none" stroke={lit ? '#12131f' : 'rgba(196,208,255,0.85)'} strokeWidth={1.2} />
      </svg>
    </button>
    </AtScreen>
  )
}

/** A base dot's decks button: opens every deck on its chain, or — with all
 *  of them open — closes them all. One label and icon; lit while its
 *  chain's decks are all open. Faint when its chain has none. */
const StoryDecks: React.FC<{ nodeId: string; dotId: string; x: number; y: number; side: Side; px: number }> = ({ nodeId, dotId, x, y, side, px }) => {
  useBoardsStore(s => s.groups)
  useFreeNodeStore(s => s.nodes)
  useSyncExternalStore(onRows, rowsSeen)
  const { closed, open } = chainDecks(nodeId, dotId)
  const lit = !closed.length && open.length > 0
  const none = !closed.length && !open.length
  return (
    <AtScreen x={x} y={y} px={px} side={side}>
    <button
      data-role="ui"
      data-story-decks={dotId}
      title="Open all decks on this chain; click again to close them"
      aria-pressed={lit}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation()
        const now = chainDecks(nodeId, dotId)
        if (!now.closed.length && !now.open.length) return
        useUndoCoordinator.getState().checkpoint()
        const set = useBoardsStore.getState().setDeckState
        if (now.closed.length) for (const m of now.closed) set(m, 'open')
        else for (const r of now.open) set(r, 'stacked')
      }}
      style={{
        display: 'block', width: 20, height: 16, padding: 0, borderRadius: 4, cursor: 'pointer',
        background: lit ? C_POINT : 'rgba(14,15,26,0.92)',
        border: `1px solid ${lit ? C_POINT : 'rgba(140,170,255,0.4)'}`,
        opacity: none ? 0.4 : 1,
      }}
    >
      <svg width={18} height={14} viewBox="0 0 18 14" style={{ display: 'block' }}>
        {/* Three cards laid out side by side: a deck opened. */}
        {[2, 7, 12].map(cx => (
          <rect key={cx} x={cx - 1.5} y={3} width={5} height={8} rx={1} fill="none"
                stroke={lit ? '#12131f' : 'rgba(196,208,255,0.85)'} strokeWidth={1.2} />
        ))}
      </svg>
    </button>
    </AtScreen>
  )
}

/** The grab handle: a small header tab by the first dot, at one size on
 *  screen. Dragging it moves the whole storyline. */
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

/** The right-click menu: on a dot, a line, a tether or the grab handle.
 *  Laid out as a tile's menu (FreeNode). Each action is one undo step. */
/** The changes in a storyline's story, where they happen: on its dots, and
 *  on the cards hung on them (scene cards), at their dot's place along it. */
function storyMarks(d: StorylineData, groups: ProjectGroup[]): { x: number; marks: StateMark[] }[] {
  const byId = new Map(groups.map(g => [g.id, g]))
  return d.dots.flatMap(p => {
    const marks = [...(p.changes ?? []), ...(p.cards ?? []).flatMap(c => byId.get(c)?.stateChanges ?? [])]
    return marks.length ? [{ x: p.x, marks }] : []
  })
}
const hasStoryMarks = (d: StorylineData, groups: ProjectGroup[]) => storyMarks(d, groups).length > 0

/** How far before the base's start the time marker can go: there, no change
 *  is made yet. */
const markerLead = (len: number) => Math.max(200, len * 0.04)

/** A storyline's clock: where its time marker is and can go (canvas units
 *  along the base from its start), and the places changes happen along it.
 *  The world clock (components/UI/WorldClock) reads the same. */
export function storyClock(d: StorylineData, groups: ProjectGroup[]): { startX: number; len: number; lead: number; at: number; stops: { at: number; marks: StateMark[] }[] } | null {
  const start = d.dots.find(p => p.id === rootOf(d))
  if (!start) return null
  const xs = (d.base ?? []).map(b => d.dots.find(p => p.id === b)?.x).filter((x): x is number => x !== undefined)
  const len = xs.length ? Math.max(...xs) - start.x : 0
  const lead = markerLead(len)
  const at = Math.max(-lead, Math.min(len + lead, d.marker ?? -lead))
  const stops = storyMarks(d, groups).map(e => ({ at: e.x - start.x, marks: e.marks })).sort((a, b) => a.at - b.at)
  return { startX: start.x, len, lead, at, stops }
}

/** Put storyline `id`'s time marker at `next` along its base: every change
 *  up to it is made. No undo step of its own (the drag took one). */
export function scrubStoryline(id: string, next: number): void {
  const n = useFreeNodeStore.getState().nodes[id]
  if (!n?.storyline) return
  const c = storyClock(n.storyline, useBoardsStore.getState().groups)
  if (!c) return
  const at = Math.max(-c.lead, Math.min(c.len + c.lead, next))
  useFreeNodeStore.getState().updateFreeNode(id, { storyline: { ...n.storyline, marker: at } })
  playMarks(storyMarks(n.storyline, useBoardsStore.getState().groups), c.startX + at)
}

/** The time marker (Brian 2026-11-08): a line across the storyline at a
 *  point along its base, with a knob on the base. Dragged along, every
 *  change up to it is made, so the State cards' output decks reform as it
 *  passes the scenes and dots. One undo step for the whole drag. */
const StoryMarker: React.FC<{ id: string; d: StorylineData; start: StoryDot; px: number }> = ({ id, d, start, px }) => {
  const xs = (d.base ?? []).map(b => d.dots.find(p => p.id === b)?.x).filter((x): x is number => x !== undefined)
  const len = xs.length ? Math.max(...xs) - start.x : 0
  const lead = markerLead(len)
  const at = Math.max(-lead, Math.min(len + lead, d.marker ?? -lead))
  const ys = d.dots.map(p => p.y)
  const top = Math.min(...ys) - 60 * px, bottom = Math.max(...ys) + 60 * px
  const x = start.x + at
  const tone = '#9fe0ff'
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    useUndoCoordinator.getState().checkpoint()
    const x0 = e.clientX, m0 = at
    const move = (ev: PointerEvent) => scrubStoryline(id, m0 + (ev.clientX - x0) / useCanvasStore.getState().zoom)
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <>
      <div data-role="ui" data-story-marker style={{ position: 'absolute', left: x - px, top, width: 2 * px, height: bottom - top,
        background: tone, opacity: 0.8, boxShadow: `0 0 ${6 * px}px ${tone}`, pointerEvents: 'none' }} />
      {/* Its knob at the top of the line, like a playhead's, clear of the
          grab handle and the dots' buttons. */}
      <AtScreen x={x} y={top} px={px} side="above">
        <div data-role="ui" data-story-marker-knob title="Time marker: drag it through the story; the changes up to it are made"
          onPointerDown={onDown} onDoubleClick={e => e.stopPropagation()}
          style={{ width: 14, height: 18, borderRadius: '4px 4px 7px 7px', background: tone, border: '2px solid #12131f', cursor: 'ew-resize',
            boxShadow: '0 1px 6px rgba(0,0,0,0.6)', pointerEvents: 'auto' }} />
      </AtScreen>
    </>
  )
}

const StoryMenu: React.FC<{
  id: string; d: StorylineData
  at: { x: number; y: number; point?: string; line?: [string, string]; grab?: boolean; tether?: string }
  onClose: () => void
  /** Open the list of State changes for a dot, at (x, y) on screen. */
  onChanges?: (x: number, y: number, point: string) => void
}> = ({ id, d, at, onClose, onChanges }) => {
  const [custom, setCustom] = useState(false)
  const groups = useBoardsStore(s => s.groups)
  const point = at.point ? d.dots.find(p => p.id === at.point) : undefined
  const items: { label: string; icon: string; danger?: boolean; action: () => void }[] = []
  const name = (gid: string) => { const g = groups.find(x => x.id === gid); return (g && cardTitle(groups, g)) || 'card' }
  if (point && at.tether) {
    const gid = at.tether
    items.push({ label: `Unlink ${name(gid)}`, icon: '⛓️', action: () => editStoryline(id, x => unlinkStoryCard(x, point.id, gid)) })
  } else if (point) {
    for (const gid of point.cards ?? []) {
      items.push({ label: `Unlink ${name(gid)}`, icon: '⛓️', action: () => editStoryline(id, x => unlinkStoryCard(x, point.id, gid)) })
    }
    // Where in the story a State card's change happens (utils/stateCard).
    if (onChanges && groups.some(g => g.cardType === 'state' && g.stateCard?.changes.length)) items.push({ label: 'State changes', icon: '🔀', action: () => onChanges(at.x, at.y, point.id) })
    items.push({ label: 'Delete', icon: '🗑️', danger: true, action: () => editStoryline(id, x => deleteDot(x, point.id)) })
    items.push({ label: 'Delete branch', icon: '🗑️', danger: true, action: () => editStoryline(id, x => deleteBranchFrom(x, point.id)) })
  } else if (at.line) {
    // A line: its far end, away from the start, is where its branch begins.
    const [a, b] = at.line
    const far = d.dots[0]?.id === a ? b : d.dots[0]?.id === b ? b : b
    // The base stays whole: only branch lines come out on their own.
    if (!isBaseEdge(d, a, b)) items.push({ label: 'Delete', icon: '🗑️', danger: true, action: () => editStoryline(id, x => ({ ...x, edges: x.edges.filter(e => !((e.a === a && e.b === b) || (e.a === b && e.b === a))) }) ) })
    items.push({ label: 'Delete branch', icon: '🗑️', danger: true, action: () => editStoryline(id, x => deleteBranchFrom(x, far)) })
  }
  // Fold it into a card: its title, groups and layout (utils/chartCard).
  if (at.grab && d.dots.some(p => p.cards?.length)) items.push({ label: d.chartCard ? 'Fold into its card' : 'Bake into a card', icon: '📥', action: () => {
    bakeStoryline(id, cardOrigins)
  } })
  if (at.grab) items.push({ label: 'Title and description', icon: '✏️', action: () => useStoryUi.getState().set({ labelEditing: id }) })
  if (at.grab) items.push({ label: 'Export to new project…', icon: '📦', action: () => useExportProjectStore.getState().openExport(exportPickFor('tile', id)) })
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
          <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{at.tether ? 'Tether' : point ? point.title || 'Dot' : at.line ? 'Line' : 'Storyline'}</span>
        </div>
        {at.grab && <StoryLook id={id} d={d} custom={custom} setCustom={setCustom} />}
        {items.map(item => (
          <button
            key={item.label}
            onClick={() => { onClose(); item.action() }}
            style={{
              display: 'flex', alignItems: 'center', gap: 9,
              width: '100%', padding: '7px 14px',
              background: 'none', border: 'none', cursor: 'pointer',
              color: item.danger ? '#f87171' : '#e2e8f0',
              fontSize: 13, textAlign: 'left', borderRadius: 4, whiteSpace: 'nowrap',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            <span style={{ fontSize: 14, width: 18, textAlign: 'center' }}>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>
    </>,
    document.body,
  )
}

/** Set a storyline's look (colour, thickness, flip). `checkpoint` false
 *  while a picker drag goes on: its press took the one undo step. */
function setStoryLook(id: string, patch: Pick<StorylineData, 'color' | 'weight' | 'standUp' | 'wallFoot'>, checkpoint = true) {
  const n = useFreeNodeStore.getState().nodes[id]
  if (!n?.storyline) return
  if (checkpoint) useUndoCoordinator.getState().checkpoint()
  useFreeNodeStore.getState().updateFreeNode(id, { storyline: { ...n.storyline, ...patch } })
}

/** The grab handle's options: line colour (swatches, and a custom picker
 *  behind its own switch), thickness, and Flip up in 3D view. */
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
          // Flipped up, it stands on its base line, where the base lies.
          setStoryLook(id, { standUp: e.target.checked || undefined, wallFoot: undefined })
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
 *  zoomed back up instead, as CounterScaled does. */
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
    if (!keep || !n?.storyline?.dots || v === title) return
    useUndoCoordinator.getState().checkpoint()
    useFreeNodeStore.getState().updateFreeNode(nodeId, {
      storyline: { ...n.storyline, dots: n.storyline.dots.map(p => (p.id === pointId ? { ...p, title: v } : p)) },
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

/** Presses, for a label being edited: listened for as this module loads,
 *  before the tilted view's own listener (TiltedView), which swallows a
 *  press on the floor and would leave the label editing. */
const labelPress = new Set<(e: PointerEvent) => void>()
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', e => { for (const f of [...labelPress]) f(e) }, true)
}

/** A storyline's label: its title, and a description under it, left-aligned
 *  at (`x`, `y`), `w` wide before its scale `k`, canvas units. In canvas
 *  units, not at one size on screen: it is part of the picture, as the cards
 *  are. Laid out at canvas size when tilted too (as CanvasUnits does), so its
 *  lines break the same in 2D and 3D. Editing, the same box takes the
 *  typing, at the same size and place, with the card face's text toolbar
 *  (font, size, weight, colour, alignment...) for the title and the
 *  description. Its corner handle scales all of it (drag down to grow). */
const StoryLabel: React.FC<{
  nodeId: string; d: StorylineData; editing: boolean; x: number; y: number
  w: number; k: number; px: number
}> = ({ nodeId, d, editing, x, y, w, k, px }) => {
  const title = d.title ?? '', description = d.description ?? ''
  const titleTs: TextStyle = { ...LABEL_TITLE_STYLE, ...d.titleStyle }
  const textTs: TextStyle = { ...LABEL_TEXT_STYLE, ...d.descriptionStyle }
  ensureFontLoaded(titleTs.fontFamily); ensureFontLoaded(textTs.fontFamily)
  const z = useWorldZoom()
  const zoomed = z !== null && z !== 1
  const [t, setT] = useState(title)
  const [text, setText] = useState(description)
  const [field, setField] = useState<TextFieldMode>('header')
  const done = useRef(false)
  const box = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef<HTMLTextAreaElement | null>(null)
  const textRef = useRef<HTMLTextAreaElement | null>(null)
  const [rect, setRect] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null)
  useEffect(() => { if (editing) { setT(title); setText(description); setField('header'); done.current = false } }, [editing]) // eslint-disable-line react-hooks/exhaustive-deps
  // Where the toolbar goes: under the label as it shows on screen.
  useLayoutEffect(() => {
    if (!editing || !box.current) { if (rect) setRect(null); return }
    const r = box.current.getBoundingClientRect()
    if (!rect || rect.left !== r.left || rect.top !== r.top || rect.right !== r.right || rect.bottom !== r.bottom) {
      setRect({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
    }
  })
  const commit = (keep: boolean) => {
    if (done.current) return
    done.current = true
    useStoryUi.getState().set({ labelEditing: null })
    const nt = t.trim().slice(0, 120), nd = text.replace(/\s+$/, '').slice(0, 2000)
    const n = useFreeNodeStore.getState().nodes[nodeId]
    if (!keep || !n?.storyline || (nt === title && nd === description)) return
    useUndoCoordinator.getState().checkpoint()
    const { title: _t, description: _d, ...rest } = n.storyline
    useFreeNodeStore.getState().updateFreeNode(nodeId, {
      storyline: { ...rest, ...(nt ? { title: nt } : {}), ...(nd ? { description: nd } : {}) },
    })
  }
  // A press anywhere else ends the editing, kept (labelPress: seen before
  // the tilted view takes presses for itself).
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => {
    if (!editing) return
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null
      if (box.current?.contains(el) || el?.closest?.('[data-text-format-toolbar]')) return
      commitRef.current(true)
    }
    labelPress.add(onDown)
    return () => { labelPress.delete(onDown) }
  }, [editing])
  const setStyle = (key: 'titleStyle' | 'descriptionStyle', s: TextStyle) => {
    const n = useFreeNodeStore.getState().nodes[nodeId]
    if (!n?.storyline) return
    useUndoCoordinator.getState().checkpoint()
    useFreeNodeStore.getState().updateFreeNode(nodeId, { storyline: { ...n.storyline, [key]: s } })
  }
  const css = (ts: TextStyle, pre: boolean): React.CSSProperties => ({
    fontSize: ts.fontSize, lineHeight: ts.lineHeight ?? 1.3,
    fontWeight: ts.fontWeight ?? (ts.bold ? 700 : 400), fontStyle: ts.italic ? 'italic' : 'normal',
    fontFamily: ts.fontFamily || 'system-ui, sans-serif', textAlign: ts.align,
    letterSpacing: ts.letterSpacing ?? 0, textTransform: ts.textTransform ?? 'none',
    color: ts.color, background: ts.bgOpacity > 0 ? hexToRgba(ts.bgColor, ts.bgOpacity) : 'transparent',
    textShadow: '0 1px 4px rgba(0,0,0,0.85)', overflowWrap: 'anywhere', whiteSpace: pre ? 'pre-wrap' : 'normal',
  })
  const titleFont = css(titleTs, false), textFont = css(textTs, true)
  // Fields with no chrome of their own, so typing shows as the label does.
  const plain: React.CSSProperties = {
    display: 'block', width: '100%', boxSizing: 'border-box', margin: 0, padding: 0,
    border: 'none', outline: 'none', resize: 'none', textShadow: 'none', fieldSizing: 'content',
  } as React.CSSProperties
  const [over, setOver] = useState(false)
  const [sizing, setSizing] = useState(false)
  // Its corner handle: a drag scales the whole label from its top-left
  // corner, by how far the corner goes down (and up to shrink). One undo step.
  const onGrip = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const el = box.current ?? (e.currentTarget.parentElement as HTMLElement)
    const h0 = Math.max(8, el.getBoundingClientRect().height)
    const cy = e.clientY
    if (!useFreeNodeStore.getState().nodes[nodeId]?.storyline) return
    useUndoCoordinator.getState().checkpoint()
    setSizing(true)
    const move = (ev: PointerEvent) => {
      const n = useFreeNodeStore.getState().nodes[nodeId]
      if (!n?.storyline) return
      const nk = Math.max(0.5, Math.min(100, k * (h0 + ev.clientY - cy) / h0))
      useFreeNodeStore.getState().updateFreeNode(nodeId, { storyline: { ...n.storyline, labelScale: nk } })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setSizing(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  // The handle at one size on screen, on the label's bottom-right corner.
  const gripPx = LABEL_GRIP * px / k
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: 0, height: 0 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', transform: `scale(${k})` }}>
      <div
        onPointerEnter={() => setOver(true)} onPointerLeave={() => setOver(false)}
        style={zoomed
        ? { position: 'absolute', left: 0, top: 0, width: w, zoom: 1 / z, transform: `scale(${z})`, transformOrigin: '0 0' }
        : { position: 'absolute', left: 0, top: 0, width: w }}>
        {editing ? (
          <div
            ref={box} data-role="ui" data-story-label={nodeId}
            onPointerDown={e => e.stopPropagation()}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Escape') commit(false)
              else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit(true)
            }}
            style={{ outline: `${1.5 * px / k}px solid rgba(143,194,255,0.6)`, outlineOffset: 4, borderRadius: 2, background: 'rgba(18,19,31,0.6)' }}
          >
            <textarea
              ref={titleRef} autoFocus value={t} maxLength={120} placeholder="Title" rows={1}
              onChange={e => setT(e.target.value.replace(/\n/g, ' '))}
              onFocus={() => setField('header')}
              onKeyDown={e => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); textRef.current?.focus() } }}
              style={{ ...titleFont, ...plain, color: titleTs.color }}
            />
            <textarea
              ref={textRef} value={text} maxLength={2000} placeholder="Description" rows={1}
              onChange={e => setText(e.target.value)}
              onFocus={() => setField('body')}
              style={{ ...textFont, ...plain, color: textTs.color, minHeight: '1.4em', marginTop: 4 }}
            />
            <TextFormatToolbar
              headerStyle={titleTs} bodyStyle={textTs}
              onHeaderStyleChange={s => setStyle('titleStyle', s)}
              onBodyStyleChange={s => setStyle('descriptionStyle', s)}
              activeField={field}
              onActiveFieldChange={f => { setField(f); (f === 'header' ? titleRef : textRef).current?.focus() }}
              anchorRect={rect} preferBelow onClose={() => commit(true)}
            />
          </div>
        ) : (
          <div ref={box} data-role="label" data-story-label={nodeId}
               style={{ position: 'relative', cursor: 'grab', userSelect: 'none',
                        outline: over || sizing ? `${1.5 * px / k}px dashed rgba(143,194,255,0.5)` : 'none', outlineOffset: 4 }}>
            {title && <div style={titleFont}>{title}</div>}
            {description && <div style={{ ...textFont, marginTop: title ? 4 : 0 }}>{description}</div>}
            {/* Drag to scale it all. Shown while the mouse is over it. */}
            <div
              data-role="ui" data-story-label-grip={nodeId}
              title="Drag to scale the title and description"
              onPointerDown={onGrip}
              style={{
                position: 'absolute', right: -gripPx / 2 - 4, bottom: -gripPx / 2 - 4, width: gripPx, height: gripPx,
                borderRadius: gripPx * 0.25, cursor: 'nwse-resize',
                background: 'rgba(14,15,26,0.92)', border: `${1.5 * px / k}px solid rgba(143,194,255,0.8)`,
                opacity: over || sizing ? 1 : 0,
              }}
            />
          </div>
        )}
      </div>
      </div>
    </div>
  )
}

/** The selected dot's options, under it. On/off switches, each with a label
 *  that never changes. */
const StoryOptions: React.FC<{ nodeId: string; snap: boolean; x: number; y: number; side: Side; px: number }> = ({ nodeId, snap, x, y, side, px }) => (
  <AtScreen x={x} y={y} px={px} side={side}>
  <div
    data-role="ui"
    style={{ display: 'flex', gap: 4, padding: 3, background: 'rgba(14,15,26,0.92)',
             border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6 }}
    onPointerDown={e => e.stopPropagation()}
  >
    <button
      title="Snap dots to the dot grid (hold Ctrl to place freely)"
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
