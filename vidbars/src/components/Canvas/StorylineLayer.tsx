// StorylineLayer — draws every Storyline on the canvas and runs its gestures
// (data and geometry: utils/storyline).
//
//  - A point on a line of no length: drag out from it to grow the line.
//  - Hover a line: a glowing tick follows the mouse; click to make it a point.
//  - Drag a point along its line to move it earlier or later; drag it off
//    to the side to grow a branch from it.
//  - Drag a point's tick up or down: its stem above or below the line.
//  - Drag a line's end: longer or shorter (not past its points).
//  - Drag a line itself, or the grab handle left of where it starts (a
//    lone point too): the whole storyline moves.
//  - Click a point to select it; click it again quickly (or its title) to
//    name it. Delete takes the point off its line, which stays whole.
//    So with a line's end handle (shortens it) and the ring where a deleted
//    point still holds a branch, on any line of the tree.
//  - Click the grab handle to select the whole storyline (ringed, as tiles
//    are); Delete then removes it, as it does a tile.
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

import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useLinkDragStore } from '../../store/linkDragStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useMenuClamp } from '../../hooks/useMenuClamp'
import { useTiltStore, isTilted, unprojectTilt, TILT_FAR } from '../../store/tiltStore'
import { clientToCanvas } from '../../utils/fx/createEffect'
import { dotStep } from '../../utils/dotGrid'
import {
  deleteStoryAnchor, deleteStoryBranch, deleteStoryEnd, deleteStoryPoint, normalizeStoryline, pointAndBranches, storyGeom, storylineEmpty, unlinkStoryCard,
  type StoryGeom, type StorylineData,
} from '../../utils/storyline'

// Screen px — divided by the zoom where drawn.
const LINE_W = 2
const LINE_HIT = 14
const DOT_R = 5
const DOT_HIT = 10
/** A point's tick, each way across its line, before its stem outgrows it. */
const TICK = 10
const TIP_HIT = 10
const CAP_R = 3
const CAP_HIT = 9
const DRAG_PX = 4
/** Dragged closer to its line than this (cos of ~35°), a point slides
 *  along it; further off to the side, it grows a branch. */
const ALONG_COS = 0.82
const DOUBLE_MS = 400
const NONE: string[] = []
/** Screen px between the grab handle and the root line's start. */
const GRAB_GAP = 10

const C_LINE = 'rgba(196,208,255,0.78)'
const C_POINT = '#8fc2ff'
const C_GLOW = '#9fe0ff'
const C_SEL = '#ffd24a'
/** The selection ring tiles and cards get. */
const C_RING = 'rgba(120,180,255,0.9)'
const RING_W = 2.5

interface StoryUi {
  /** The selected point (or anchor). */
  sel: { node: string; point: string } | null
  /** The selected end handle of a line. */
  selEnd: { node: string; line: string; which: 'start' | 'end' } | null
  /** Points (and anchors) picked out by a selection box or Shift/Ctrl+click,
   *  by storyline: selected along with the cards and tiles around them. */
  parts: Record<string, string[]>
  /** The glowing tick under the mouse. */
  hover: { node: string; line: string; t: number } | null
  /** The point whose title is being typed. */
  editing: { node: string; point: string } | null
  set: (patch: Partial<Omit<StoryUi, 'set'>>) => void
}

const useStoryUi = create<StoryUi>(set => ({
  sel: null, selEnd: null, parts: {}, hover: null, editing: null,
  set: patch => set(patch),
}))

/** Client px → canvas units. A trusted event while tilted is where the
 *  cursor is on the tipped plane, laid flat here; a re-sent one (TiltLayer)
 *  is flat already. */
function toCanvas(e: { clientX: number; clientY: number; isTrusted: boolean }, el: Element): { x: number; y: number } | null {
  let cx = e.clientX, cy = e.clientY
  const ts = useTiltStore.getState()
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

function snapper(d: StorylineData, free: boolean) {
  const step = dotStep(useCanvasStore.getState().zoom)
  const on = d.snap !== false && !free
  return (v: number) => (on ? Math.round(v / step) * step : v)
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
  useStoryUi.getState().set({ sel: null, selEnd: null, parts: {} })
}

/** A point selected: the whole storyline is not. */
function selectStoryPoint(id: string, point: string, editing = false) {
  const fs = useFreeNodeStore.getState()
  if (fs.selectedIds.includes(id)) fs.setFreeSelection(fs.selectedIds.filter(x => x !== id))
  useStoryUi.getState().set({ sel: { node: id, point }, selEnd: null, parts: {}, ...(editing ? { editing: { node: id, point } } : {}) })
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
  ui.set({ sel: null, selEnd: null, parts })
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
    const pts = [...wrap.querySelectorAll<SVGElement>('[data-role="point"], [data-role="anchor"]')]
    const lines = [...wrap.querySelectorAll<SVGElement>('[data-role="line"]')]
    const hit = pts.filter(el => centreIn(el.getBoundingClientRect())).map(el => el.dataset.point!)
    if (hit.length === pts.length && lines.every(el => inside(el.getBoundingClientRect()))) {
      whole.push(id)
      delete parts[id]
    } else if (hit.length) {
      parts[id] = [...new Set([...(add ? parts[id] ?? [] : []), ...hit])]
    }
  }
  ui.set({ parts, sel: add ? ui.sel : null, selEnd: null })
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
      const t = Math.max(0, Math.min(q.len, (wx - q.sx) * q.ux + (wy - q.sy) * q.uy))
      const d = edits.get(q.node) ?? base.d
      edits.set(q.node, { ...d, points: d.points.map(p => (p.id === q.point ? { ...p, t } : p)) })
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

/** A line's end handle selected. */
function selectStoryEnd(id: string, line: string, which: 'start' | 'end') {
  const fs = useFreeNodeStore.getState()
  if (fs.selectedIds.includes(id)) fs.setFreeSelection(fs.selectedIds.filter(x => x !== id))
  useStoryUi.getState().set({ sel: null, selEnd: { node: id, line, which } })
}

/** Delete the points, anchors and end handle selected, each by its rule;
 *  one undo step (`checkpoint` false: the canvas's Delete took it). */
function deleteStorySelected(list: { node: string; point: string }[], end: { node: string; line: string; which: 'start' | 'end' } | null, checkpoint: boolean) {
  if (checkpoint) useUndoCoordinator.getState().checkpoint()
  for (const node of new Set([...list.map(q => q.node), ...(end ? [end.node] : [])])) {
    editStoryline(node, d => {
      for (const { point } of list.filter(q => q.node === node)) {
        const p = d.points.find(q => q.id === point)
        if (p) d = p.anchor ? deleteStoryAnchor(d, p.id) : deleteStoryPoint(d, p.id)
      }
      return end?.node === node ? deleteStoryEnd(d, end.line, end.which) : d
    }, false)
  }
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

/** Link card `groupId` to point `pointId` (a card's link "+" let go on
 *  it; LinkDragOverlay). A card follows one point: off any other first.
 *  The caller takes the undo checkpoint. */
export function linkCardToStoryPoint(nodeId: string, pointId: string, groupId: string) {
  const fs = useFreeNodeStore.getState()
  if (!fs.nodes[nodeId]?.storyline?.points.some(p => p.id === pointId)) return
  for (const n of Object.values(fs.nodes)) {
    if (!n.storyline) continue
    let changed = false
    const points = n.storyline.points.map(p => {
      const has = p.cards?.includes(groupId) ?? false
      const want = n.id === nodeId && p.id === pointId
      if (has === want) return p
      changed = true
      return { ...p, cards: want ? [...(p.cards ?? []), groupId] : p.cards!.filter(c => c !== groupId) }
    })
    if (changed) fs.updateFreeNode(n.id, { storyline: { ...n.storyline, points } })
  }
}

export const StorylineLayer: React.FC = React.memo(() => {
  const ids = useFreeNodeStore(useShallow(s =>
    Object.values(s.nodes).filter(n => n.type === 'storyline' && n.storyline && !n.pin).map(n => n.id)))
  useStoryKeys()
  useStoryFollow()
  return <>{ids.map(id => <Storyline key={id} id={id} />)}</>
})

/** Delete / Backspace takes the selected point off its line (see
 *  deleteStoryPoint). Esc lets go of it. A press anywhere else lets go of it
 *  too. A whole storyline selected is the canvas's Delete, as a tile. */
function useStoryKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useStoryUi.getState()
      const list = storyPartsList(), end = ui.selEnd
      if ((!list.length && !end) || ui.editing) return
      const tag = (document.activeElement as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'Escape') { ui.set({ sel: null, selEnd: null, parts: {} }); return }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      ui.set({ sel: null, selEnd: null, parts: {}, hover: null })
      // Selected along with cards or tiles: the canvas's Delete takes them,
      // and its checkpoint first, so the points go right after it, in the
      // same undo step.
      const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
      const cs = useCanvasStore.getState(), v3 = useViewport3DStore.getState()
      if (fs.selectedIds.length || bs.selectedGroupIds.length || v3.selectedIds.length || cs.selectedBlockBoardIds.length) {
        setTimeout(() => deleteStorySelected(list, end, false), 0)
        return
      }
      // Ours alone: the canvas's own Delete would otherwise fall through
      // to whatever board has the focus.
      e.preventDefault()
      e.stopImmediatePropagation()
      deleteStorySelected(list, end, true)
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
      if (ui.sel || ui.selEnd || Object.keys(ui.parts).length) ui.set({ sel: null, selEnd: null, parts: {} })
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
  | { kind: 'branch'; point: string; line: string }
  | { kind: 'slide'; point: string; cards: Map<string, { x: number; y: number }> }
  | { kind: 'tip'; point: string; side: 'up' | 'down' }
  | { kind: 'end'; line: string }
  | { kind: 'start'; line: string }
  | { kind: 'move'; cards: Map<string, { x: number; y: number }> }
  | { kind: 'group'; base: GroupBase; last: { dx: number; dy: number } }

const Storyline: React.FC<{ id: string }> = ({ id }) => {
  const node = useFreeNodeStore(s => s.nodes[id]) as FreeNodeData | undefined
  const zoom = useCanvasStore(s => s.zoom)
  const sel = useStoryUi(s => (s.sel?.node === id ? s.sel.point : null))
  const parts = useStoryUi(s => s.parts[id] ?? NONE)
  const selEnd = useStoryUi(s => (s.selEnd?.node === id ? `${s.selEnd.which}:${s.selEnd.line}` : null))
  const hover = useStoryUi(s => (s.hover?.node === id ? s.hover : null))
  const editing = useStoryUi(s => (s.editing?.node === id ? s.editing.point : null))
  const linking = useLinkDragStore(s => s.active && s.source?.kind === 'group')
  const busy = useRef(false)
  const lastClick = useRef<{ point: string; at: number } | null>(null)
  const picked = useFreeNodeStore(s => s.selectedIds.includes(id))
  const [menu, setMenu] = useState<{ x: number; y: number; point?: string; line?: string; end?: 'start' | 'end' } | null>(null)

  const d = node?.storyline
  if (!node || !d) return null
  const px = 1 / zoom
  const g = storyGeom(d)

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
    const near = DOT_HIT * px
    if (d.points.some(p => p.line === lineId && !p.anchor && Math.abs(p.t - t) < near)) return null
    if (t < near || lg.len - t < near) return null
    return t
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (busy.current) return
    const ui = useStoryUi.getState()
    const role = (e.target as Element).closest<HTMLElement | SVGElement>('[data-role]')
    const lineId = role?.dataset.role === 'line' ? role.dataset.line : undefined
    const c = lineId ? toCanvas(e.nativeEvent, e.currentTarget) : null
    const t = lineId && c ? tickAt(lineId, c, e.ctrlKey) : null
    if (lineId && t !== null) {
      if (ui.hover?.node !== id || ui.hover.line !== lineId || ui.hover.t !== t) ui.set({ hover: { node: id, line: lineId, t } })
    } else if (ui.hover?.node === id) ui.set({ hover: null })
  }
  const onPointerLeave = () => {
    if (!busy.current && useStoryUi.getState().hover?.node === id) useStoryUi.getState().set({ hover: null })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.altKey) return
    const el = (e.target as Element).closest<HTMLElement | SVGElement>('[data-role]')
    const role = el?.dataset.role
    if (!role || role === 'ui') return
    e.stopPropagation()
    e.preventDefault()
    const host = e.currentTarget
    const c0 = toCanvas(e.nativeEvent, host)
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
    const at = (lid: string) => {
      const lg = g0.lines[lid]
      return lg && { sx: x0 + lg.sx, sy: y0 + lg.sy, ux: lg.ux, uy: lg.uy, len: lg.len }
    }
    const pointsOn = (lid: string) => d0.points.filter(p => p.line === lid)

    const decide = (c: { x: number; y: number }): Gesture | null => {
      if (role === 'tip-up' || role === 'tip-down') return pointId ? { kind: 'tip', point: pointId, side: role === 'tip-up' ? 'up' : 'down' } : null
      if (role === 'start' && lineId) return { kind: 'start', line: lineId }
      if (role === 'end' && lineId) return pointsOn(lineId).length ? { kind: 'end', line: lineId } : { kind: 'grow', line: lineId }
      if (role === 'line' || role === 'grab') return { kind: 'move', cards: cardOrigins(d0, new Set(d0.points.map(p => p.id))) }
      if ((role === 'point' || role === 'title' || role === 'anchor') && pointId && lineId) {
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
        const vx = c.x - c0.x, vy = c.y - c0.y
        const along = Math.abs(vx * lg.ux + vy * lg.uy) / Math.max(1e-9, Math.hypot(vx, vy))
        if (along >= ALONG_COS) return { kind: 'slide', point: pointId, cards: cardOrigins(d0, pointAndBranches(d0, pointId).points) }
        return { kind: 'branch', point: pointId, line: crypto.randomUUID() }
      }
      return null
    }

    const apply = (c: { x: number; y: number }, free: boolean) => {
      if (!gesture) return
      const sn = snapper(d0, free)
      const snapPt = { x: sn(c.x), y: sn(c.y) }
      switch (gesture.kind) {
        case 'grow': case 'branch': {
          const lid = gesture.line
          let sx: number, sy: number
          let lines = d0.lines
          if (gesture.kind === 'branch') {
            const pg = g0.points[gesture.point]
            if (!pg) return
            sx = x0 + pg.x; sy = y0 + pg.y
            lines = [...lines, { id: lid, from: gesture.point, x: 0, y: 0, dx: 0, dy: 0 }]
          } else {
            const lg = at(lid)
            if (!lg) return
            sx = lg.sx; sy = lg.sy
          }
          const dx = snapPt.x - sx, dy = snapPt.y - sy
          writeStoryline(id, x0, y0, { ...d0, lines: lines.map(l => (l.id === lid ? { ...l, dx, dy } : l)) })
          return
        }
        case 'slide': {
          const pid = gesture.point
          const p = d0.points.find(q => q.id === pid)
          const lg = p && at(p.line)
          if (!p || !lg) return
          let t = (snapPt.x - lg.sx) * lg.ux + (snapPt.y - lg.sy) * lg.uy
          t = Math.max(0, Math.min(lg.len, t))
          writeStoryline(id, x0, y0, { ...d0, points: d0.points.map(q => (q.id === pid ? { ...q, t } : q)) })
          const was = Math.max(0, Math.min(lg.len, p.t))
          moveCards(gesture.cards, (t - was) * lg.ux, (t - was) * lg.uy)
          return
        }
        case 'tip': {
          const pid = gesture.point, side = gesture.side
          const pg = g0.points[pid]
          if (!pg) return
          const v = (c.x - x0 - pg.x) * pg.nx + (c.y - y0 - pg.y) * pg.ny
          const len = Math.max(0, sn(side === 'up' ? v : -v))
          writeStoryline(id, x0, y0, { ...d0, points: d0.points.map(q => (q.id === pid ? { ...q, [side]: len } : q)) })
          return
        }
        case 'end': {
          const lid = gesture.line
          const lg = at(lid)
          if (!lg) return
          const most = Math.max(0, ...pointsOn(lid).map(p => p.t))
          const len = Math.max(most, (snapPt.x - lg.sx) * lg.ux + (snapPt.y - lg.sy) * lg.uy)
          writeStoryline(id, x0, y0, { ...d0, lines: d0.lines.map(l => (l.id === lid ? { ...l, dx: lg.ux * len, dy: lg.uy * len } : l)) })
          return
        }
        case 'start': {
          const lid = gesture.line
          const lg = at(lid)
          if (!lg) return
          const on = pointsOn(lid)
          const least = on.length ? Math.min(...on.map(p => p.t)) : lg.len
          const k = Math.min(least, (snapPt.x - lg.sx) * lg.ux + (snapPt.y - lg.sy) * lg.uy)
          writeStoryline(id, x0, y0, {
            ...d0,
            lines: d0.lines.map(l => (l.id === lid ? { ...l, x: l.x + lg.ux * k, y: l.y + lg.uy * k, dx: lg.ux * (lg.len - k), dy: lg.uy * (lg.len - k) } : l)),
            points: d0.points.map(p => (p.line === lid ? { ...p, t: p.t - k } : p)),
          })
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
      const c = toCanvas(ev, host)
      if (!c) return
      if (!gesture) {
        if (Math.hypot(c.x - c0.x, c.y - c0.y) * zoom < DRAG_PX) return
        gesture = decide(c)
        if (!gesture) return
        useUndoCoordinator.getState().checkpoint()
      }
      apply(c, ev.ctrlKey)
    }
    const finish = (ev: PointerEvent, cancelled: boolean) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      busy.current = false
      if (gesture) {
        // A branch, or a line grown from a lone point, let go where it
        // started is no line at all.
        if (gesture.kind === 'branch' || gesture.kind === 'grow') {
          const now = useFreeNodeStore.getState().nodes[id]
          const l = now?.storyline?.lines.find(q => q.id === (gesture as { line: string }).line)
          if (now?.storyline && l && l.from && Math.hypot(l.dx, l.dy) < 1e-6) {
            writeStoryline(id, now.x, now.y, { ...now.storyline, lines: now.storyline.lines.filter(q => q.id !== l.id) })
          }
        }
        if (gesture.kind === 'slide' || gesture.kind === 'tip') selectStoryPoint(id, gesture.point)
        return
      }
      if (cancelled) return
      // A click.
      if (role === 'line' && lineId) {
        const c = toCanvas(ev, host) ?? c0
        const t = hover0?.node === id && hover0.line === lineId ? hover0.t : tickAt(lineId, c, ev.ctrlKey)
        if (t === null) return
        useUndoCoordinator.getState().checkpoint()
        // Where a deleted point still holds branches: it comes back.
        const anchor = d0.points.find(p => p.line === lineId && p.anchor && Math.abs(p.t - t) < DOT_HIT * px)
        const pid = anchor?.id ?? crypto.randomUUID()
        writeStoryline(id, x0, y0, anchor
          ? { ...d0, points: d0.points.map(p => (p.id === pid ? { ...p, anchor: undefined } : p)) }
          : { ...d0, points: [...d0.points, { id: pid, line: lineId, t, up: 0, down: 0, title: '' }] })
        selectStoryPoint(id, pid)
        return
      }
      if (role === 'grab') {
        selectStoryline(id)
        return
      }
      if ((role === 'point' || role === 'anchor') && pointId && (ev.shiftKey || ev.ctrlKey)) {
        toggleStoryPart(id, pointId)
        return
      }
      if ((role === 'point' || role === 'title' || role === 'anchor') && pointId) {
        const last = lastClick.current
        const now = performance.now()
        const again = role === 'title' || (last?.point === pointId && now - last.at < DOUBLE_MS)
        lastClick.current = { point: pointId, at: now }
        // An anchor named becomes a point again.
        if (again && role === 'anchor') {
          useUndoCoordinator.getState().checkpoint()
          writeStoryline(id, x0, y0, { ...d0, points: d0.points.map(p => (p.id === pointId ? { ...p, anchor: undefined } : p)) })
        }
        selectStoryPoint(id, pointId, again)
        return
      }
      if ((role === 'start' || role === 'end') && lineId) {
        selectStoryEnd(id, lineId, role)
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
      data-storyline={id}
      style={{ position: 'absolute', left: node.x, top: node.y, width: 0, height: 0, overflow: 'visible' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onContextMenu={e => {
        const el = (e.target as Element).closest<HTMLElement | SVGElement>('[data-role]')
        const role = el?.dataset.role
        if (!role || role === 'ui') return
        e.preventDefault(); e.stopPropagation()
        const point = el?.dataset.point
        const line = el?.dataset.line ?? (point ? d.points.find(p => p.id === point)?.line : undefined)
        const end = role === 'start' || role === 'end' ? role : undefined
        // What the menu acts on is selected first, as on tiles and cards.
        if (point) selectStoryPoint(id, point)
        else if (end && line) selectStoryEnd(id, line, end)
        else selectStoryline(id)
        setMenu({ x: e.clientX, y: e.clientY, point, line: role === 'grab' ? undefined : line, end })
      }}
    >
      <StorySvg id={id} d={d} g={g} w={node.width} h={node.height} px={px} sel={sel} parts={parts} selEnd={selEnd} hover={hover} linking={linking} picked={picked} />
      {(() => {
        const root = d.lines.find(l => !l.from)
        const lg = root && g.lines[root.id]
        return lg ? <StoryGrab x={lg.sx} y={lg.sy} px={px} picked={picked} /> : null
      })()}
      {menu && <StoryMenu id={id} d={d} at={menu} onClose={() => setMenu(null)} />}
      {d.points.map(p => {
        const pg = g.points[p.id]
        if (!pg || p.anchor) return null
        const isEditing = editing === p.id
        if (!p.title && !isEditing) return null
        const reach = Math.max(p.up, TICK * px) + 6 * px
        return (
          <StoryTitle
            key={p.id} nodeId={id} pointId={p.id} title={p.title} editing={isEditing}
            x={pg.x + pg.nx * reach} y={pg.y + pg.ny * reach} side={sideFor(pg.nx, pg.ny)} px={px} selected={sel === p.id}
          />
        )
      })}
      {sel && g.points[sel] && (() => {
        const pg = g.points[sel]
        const p = d.points.find(q => q.id === sel)!
        if (p.anchor) return null
        const reach = Math.max(p.down, TICK * px) + 10 * px
        return <StoryOptions nodeId={id} snap={d.snap !== false} x={pg.x - pg.nx * reach} y={pg.y - pg.ny * reach} side={sideFor(-pg.nx, -pg.ny)} px={px} />
      })()}
    </div>
  )
}

const StorySvg: React.FC<{
  id: string; d: StorylineData; g: StoryGeom; w: number; h: number; px: number
  sel: string | null; parts: string[]; selEnd: string | null; hover: { line: string; t: number } | null; linking: boolean; picked: boolean
}> = ({ id, d, g, w, h, px, sel, parts, selEnd, hover, linking, picked }) => {
  // Room round the box for handles and ticks, which reach past the lines.
  const M = 60 * px + Math.max(0, ...d.points.map(p => Math.max(p.up, p.down)))
  const hl = hover && g.lines[hover.line]
  return (
    <svg
      style={{ position: 'absolute', left: -M, top: -M, width: w + 2 * M, height: h + 2 * M, overflow: 'visible', pointerEvents: 'none' }}
    >
      <g transform={`translate(${M} ${M})`} strokeLinecap="round">
        {d.lines.map(l => {
          const lg = g.lines[l.id]
          if (!lg || lg.len < 1e-6) return null
          const ex = lg.sx + lg.ux * lg.len, ey = lg.sy + lg.uy * lg.len
          return (
            <g key={l.id}>
              {picked && <line x1={lg.sx} y1={lg.sy} x2={ex} y2={ey} stroke={C_RING} strokeWidth={(LINE_W + 2 * RING_W) * px} />}
              <line x1={lg.sx} y1={lg.sy} x2={ex} y2={ey} stroke={C_LINE} strokeWidth={LINE_W * px} />
              <line
                x1={lg.sx} y1={lg.sy} x2={ex} y2={ey} stroke="transparent" strokeWidth={LINE_HIT * px}
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
              <line x1={cx - nx * k} y1={cy - ny * k} x2={cx + nx * k} y2={cy + ny * k} stroke={C_GLOW} strokeWidth={LINE_W * px} />
            </g>
          )
        })()}
        {d.lines.map(l => {
          const lg = g.lines[l.id]
          if (!lg || lg.len < 1e-6) return null
          const ex = lg.sx + lg.ux * lg.len, ey = lg.sy + lg.uy * lg.len
          const on = d.points.filter(p => p.line === l.id)
          const startFree = !l.from && !on.some(p => p.t < DOT_HIT * px)
          const endFree = !on.some(p => lg.len - p.t < DOT_HIT * px)
          return (
            <g key={l.id}>
              {endFree && <Cap x={ex} y={ey} px={px} role="end" line={l.id} selected={selEnd === `end:${l.id}`} />}
              {startFree && <Cap x={lg.sx} y={lg.sy} px={px} role="start" line={l.id} selected={selEnd === `start:${l.id}`} />}
            </g>
          )
        })}
        {d.points.map(p => {
          const pg = g.points[p.id]
          if (!pg) return null
          if (p.anchor) {
            // Where a deleted point still holds a branch: a ring on the line,
            // selectable and deletable as a point is.
            return (
              <g key={p.id}>
                <circle cx={pg.x} cy={pg.y} r={CAP_R * px} fill="#12131f" stroke={sel === p.id ? C_SEL : parts.includes(p.id) || picked ? C_RING : C_LINE} strokeWidth={1.5 * px} pointerEvents="none" />
                <circle cx={pg.x} cy={pg.y} r={CAP_HIT * px} fill="transparent" pointerEvents="all" style={{ cursor: 'grab' }}
                        data-role="anchor" data-point={p.id} />
              </g>
            )
          }
          const up = Math.max(p.up, TICK * px), down = Math.max(p.down, TICK * px)
          const selected = sel === p.id
          const color = selected ? C_SEL : C_POINT
          const r0 = DOT_R * px
          return (
            <g key={p.id}>
              <line x1={pg.x - pg.nx * down} y1={pg.y - pg.ny * down} x2={pg.x + pg.nx * up} y2={pg.y + pg.ny * up}
                    stroke={color} strokeWidth={LINE_W * px} />
              <line x1={pg.x + pg.nx * r0} y1={pg.y + pg.ny * r0} x2={pg.x + pg.nx * (up + 3 * px)} y2={pg.y + pg.ny * (up + 3 * px)}
                    stroke="transparent" strokeWidth={TIP_HIT * px} pointerEvents="stroke" style={{ cursor: 'ns-resize' }}
                    data-role="tip-up" data-point={p.id} />
              <line x1={pg.x - pg.nx * r0} y1={pg.y - pg.ny * r0} x2={pg.x - pg.nx * (down + 3 * px)} y2={pg.y - pg.ny * (down + 3 * px)}
                    stroke="transparent" strokeWidth={TIP_HIT * px} pointerEvents="stroke" style={{ cursor: 'ns-resize' }}
                    data-role="tip-down" data-point={p.id} />
              {linking && <circle cx={pg.x} cy={pg.y} r={DOT_HIT * px} fill={C_GLOW} fillOpacity={0.25} pointerEvents="none" />}
              {(p.cards?.length ?? 0) > 0 && (
                <circle cx={pg.x} cy={pg.y} r={(DOT_R + 3) * px} fill="none" stroke={color} strokeWidth={1.5 * px} pointerEvents="none" />
              )}
              {(picked || parts.includes(p.id)) && <circle cx={pg.x} cy={pg.y} r={r0 + RING_W * px} fill={C_RING} pointerEvents="none" />}
              <circle cx={pg.x} cy={pg.y} r={r0} fill={color} stroke="#12131f" strokeWidth={1.5 * px} pointerEvents="none" />
              <circle
                cx={pg.x} cy={pg.y} r={DOT_HIT * px} fill="transparent" pointerEvents="all" style={{ cursor: 'grab' }}
                data-role="point" data-point={p.id} data-link-drop={`story:${id}:${p.id}`}
              />
            </g>
          )
        })}
      </g>
    </svg>
  )
}

const Cap: React.FC<{ x: number; y: number; px: number; role: 'start' | 'end'; line: string; selected: boolean }> = ({ x, y, px, role, line, selected }) => {
  const [hot, setHot] = useState(false)
  return (
    <g>
      <circle cx={x} cy={y} r={CAP_R * px} fill={selected ? C_SEL : hot ? C_GLOW : C_LINE} pointerEvents="none" />
      <circle
        cx={x} cy={y} r={CAP_HIT * px} fill="transparent" pointerEvents="all" style={{ cursor: 'grab' }}
        data-role={role} data-line={line}
        onPointerEnter={() => setHot(true)} onPointerLeave={() => setHot(false)}
      />
    </g>
  )
}

/** The grab handle: a small header tab, always just left of where the root
 *  line starts (where a storyline's first point was put down), at one size
 *  on screen. Dragging it moves the whole storyline, as a line drag does. */
const StoryGrab: React.FC<{ x: number; y: number; px: number; picked: boolean }> = ({ x, y, px, picked }) => {
  const dot = { width: 3, height: 3, borderRadius: '50%', background: 'rgba(196,208,255,0.7)' }
  return (
    <div
      data-role="grab"
      title="Drag to move the storyline"
      style={{
        position: 'absolute', left: x, top: y,
        transformOrigin: '0 0',
        // Its right edge GAP px left of the start, its middle on the line.
        transform: `scale(${px}) translate(calc(-100% - ${GRAB_GAP}px), -50%)`,
        display: 'grid', gridTemplateColumns: 'repeat(2, 3px)', gap: 3, padding: '5px 4px',
        background: 'rgba(24,27,46,0.9)', border: '1px solid rgba(140,170,255,0.35)', borderRadius: 4,
        cursor: 'grab',
        boxShadow: picked ? `0 0 0 ${RING_W}px ${C_RING}` : 'none',
      }}
    >
      {Array.from({ length: 6 }, (_, i) => <div key={i} style={dot} />)}
    </div>
  )
}

/** The right-click menu: on a point, a line or the grab handle. Laid out
 *  as a tile's menu (FreeNode). Each action is one undo step. */
const StoryMenu: React.FC<{
  id: string; d: StorylineData
  at: { x: number; y: number; point?: string; line?: string; end?: 'start' | 'end' }
  onClose: () => void
}> = ({ id, d, at, onClose }) => {
  const groups = useBoardsStore(s => s.groups)
  const point = at.point ? d.points.find(p => p.id === at.point) : undefined
  const line = at.line ? d.lines.find(l => l.id === at.line) : undefined
  const items: { label: string; icon: string; danger?: boolean; action: () => void }[] = []
  // Branches growing from the point: each can go from here.
  const grown = point ? d.lines.filter(l => l.from === point.id) : []
  const fromHere = () => grown.forEach((l, k) => items.push({
    label: grown.length > 1 ? `Delete branch from here ${k + 1}` : 'Delete branch from here', icon: '🗑️', danger: true,
    action: () => editStoryline(id, x => deleteStoryBranch(x, l.id)),
  }))
  if (point?.anchor) {
    // It goes only with nothing on what grows from it (deleteStoryAnchor).
    if (!grown.some(l => d.points.some(p => p.line === l.id))) {
      items.push({ label: 'Delete point', icon: '🗑️', danger: true, action: () => editStoryline(id, x => deleteStoryAnchor(x, point.id)) })
    }
    fromHere()
  } else if (point) {
    for (const gid of point.cards ?? []) {
      const g = groups.find(x => x.id === gid)
      const name = g?.cardHeaderText || g?.name || 'card'
      items.push({ label: `Unlink ${name}`, icon: '⛓️', action: () => editStoryline(id, x => unlinkStoryCard(x, point.id, gid)) })
    }
    items.push({ label: 'Delete point', icon: '🗑️', danger: true, action: () => editStoryline(id, x => deleteStoryPoint(x, point.id)) })
    fromHere()
  }
  if (at.end && line) {
    const end = at.end
    items.push({ label: 'Delete end', icon: '🗑️', danger: true, action: () => editStoryline(id, x => deleteStoryEnd(x, line.id, end)) })
  }
  if (line?.from) {
    items.push({ label: 'Delete branch', icon: '🗑️', danger: true, action: () => editStoryline(id, x => deleteStoryBranch(x, line.id)) })
  }
  items.push({ label: 'Delete storyline', icon: '🗑️', danger: true, action: () => {
    useUndoCoordinator.getState().checkpoint()
    useFreeNodeStore.getState().deleteFreeNode(id)
  } })
  const { ref, top } = useMenuClamp(at.y, items.length)
  return ReactDOM.createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={onClose} onContextMenu={e => { e.preventDefault(); onClose() }} />
      <div
        ref={ref}
        data-storyline={id}
        onPointerDown={e => e.stopPropagation()}
        style={{
          position: 'fixed', left: Math.min(at.x, window.innerWidth - 200), top,
          minWidth: 170, zIndex: 9999,
          background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
          padding: '5px 0', fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ padding: '4px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: 4 }}>
          <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{point ? point.title || 'Point' : at.end ? 'Line end' : line?.from ? 'Branch' : 'Storyline'}</span>
        </div>
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

type Side = 'above' | 'below' | 'left' | 'right'
const SIDE_SHIFT: Record<Side, string> = {
  above: 'translate(-50%, -100%)', below: 'translate(-50%, 0)',
  left: 'translate(-100%, -50%)', right: 'translate(0, -50%)',
}

/** Labels at a constant size on screen: laid out at natural size and scaled
 *  down by the zoom, lying on `side` of (`x`, `y`), centred along it. */
const atScreenSize = (x: number, y: number, px: number, side: Side): React.CSSProperties => ({
  position: 'absolute', left: x, top: y,
  transformOrigin: '0 0',
  transform: `scale(${px}) ${SIDE_SHIFT[side]}`,
  whiteSpace: 'nowrap',
})

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
      <div style={atScreenSize(x, y, px, side)} data-role="ui">
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
      </div>
    )
  }
  return (
    <div
      data-role="title" data-point={pointId}
      style={{ ...atScreenSize(x, y, px, side), ...font, cursor: 'text', userSelect: 'none', padding: '0 3px',
               color: selected ? C_SEL : '#fff' }}
    >{title}</div>
  )
}

/** The selected storyline's options, under its selected point. On/off
 *  switches, each with a label that never changes. */
const StoryOptions: React.FC<{ nodeId: string; snap: boolean; x: number; y: number; side: Side; px: number }> = ({ nodeId, snap, x, y, side, px }) => (
  <div
    data-role="ui"
    style={{ ...atScreenSize(x, y, px, side), display: 'flex', gap: 4, padding: 3, background: 'rgba(14,15,26,0.92)',
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
)
