// createEffect.ts — making an effect card, from anywhere.
//
// The Effects palette, the canvas right-click menu, a palette drag let go
// on the canvas and the card browser's "Add new" rows all make effect
// cards, and they must agree on size, undo and where the card lands — so
// they all come through here (the same reasoning as utils/canvasCreate,
// which this builds on for the checkpoint and the zoom sizing).
//
// Where it lands. An effect card only does anything ON a strip, and the
// picture you mean is nearly always the one you just clicked. So with one
// picture, video or effect card selected, the new card goes flush onto the
// RIGHT END of that tile's strip — the end it reads last at, i.e. it
// applies on top of what is already there. The new card is then selected,
// so clicking three effects in a row builds a three-card strip. If the end
// is blocked (both flush spots taken) it waits just below the end, touching
// nothing — never in the middle of the screen, which is where the picture
// you just clicked usually is. With nothing like that selected it lands in
// the middle of the canvas you can see, and lines up with a strip if it
// happens to be close to one.
//
// Loop strips (utils/rail) come first. With a rail selected — or a card
// docked on one, which is a spot ON that rail — the new card goes into the
// rail's slot row at its END, the last step the run applies: the rail's
// version of "the end of the strip". It is docked, not placed, so the rail
// lays it out. A palette drag let go over a rail docks into the row at the
// drop (the caller passes that target). A card on a rail is never a strip
// tile: nothing lines up against one, and it never counts as in the way —
// its rail does. The rail itself is made here too (createLoopStrip), for
// the palette and the canvas menu alike.

import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useViewport3DStore, type ViewportWindow3D } from '../../store/viewport3dStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { addFreeNodeCentered, createScaleFor, viewportCenterInCanvas } from '../canvasCreate'
import { DOCK_TOLERANCE, rectsTouch, viewportVisualRect, type Rect } from '../viewportDocking'
import { isTileDeckFace, tileDeckFaceOf, tileDeckIndex } from '../tileDecks'
import { isRail, railLayout, type RailData, type RailDropTarget } from '../rail'
import { EFFECTS, knownKind, type EffectKind } from './effects'
import { snapToStrip } from './stripSnap'
import { useBoardsStore } from '../../store/boardsStore'
import { createEffectCardGroup } from '../effectCards'

type Nodes = Record<string, FreeNodeData>

/** MIME for an in-app effect drag (palette item, Rolodex "Add new" row).
 *  Payload: JSON {kind}. Lower-case, because dataTransfer.types is — the
 *  canvas tests `types` during dragover, where getData is blacked out.
 *  Producers put NOTHING else on the drag (no text/plain): let go over a
 *  text field and it would type the payload in. */
export const EFFECT_DRAG_MIME = 'application/x-vidbars-effect'

/** The kind an effect drag carries. Defensive: a drag can carry anything,
 *  and a malformed payload or a kind this build lacks reads as Bloom
 *  (knownKind) rather than throwing in the middle of a drop. */
export function effectKindFromDrag(raw: string): EffectKind {
  try {
    const p = JSON.parse(raw) as { kind?: unknown } | null
    return knownKind(typeof p?.kind === 'string' ? p.kind : undefined)
  } catch {
    return knownKind(undefined)
  }
}

/** The canvas container's rect. PinLayer's host is `absolute; inset: 0`
 *  inside the InfiniteCanvas container, so its rect IS the container's —
 *  the box `pan` is measured from. NOT the window: that is off by the
 *  toolbar (and again by the storage banner when it shows). */
function canvasRect(): DOMRect | null {
  const r = document.querySelector('[data-pin-host]')?.getBoundingClientRect()
  return r && r.width > 0 && r.height > 0 ? r : null
}

/** Client px → canvas units, measured against the canvas container (the
 *  [data-pin-host] rect), not the window. */
export function clientToCanvas(clientX: number, clientY: number): { cx: number; cy: number } {
  const r = canvasRect()
  const { pan, zoom } = useCanvasStore.getState()
  return {
    cx: (clientX - (r?.left ?? 0) - pan.x) / zoom,
    cy: (clientY - (r?.top ?? 0) - pan.y) / zoom,
  }
}

/** The middle of the canvas you can see, in canvas units. */
function visibleCanvasCenter(): { cx: number; cy: number } {
  const r = canvasRect()
  return r ? clientToCanvas(r.left + r.width / 2, r.top + r.height / 2) : viewportCenterInCanvas()
}

const STRIP_TYPES = new Set<FreeNodeData['type']>(['image', 'video', 'effect'])

/** A tile an effect card can line up with: an unpinned picture, video or
 *  effect card — or a collapsed deck's face, whatever its own type, since
 *  it stands for every member behind it. Not a card docked on a loop strip:
 *  its rail places it (and runs it), so a card "after" it would land on the
 *  rail. (Rails are not strip types, and are never deck faces.) */
function isStripTile(n: FreeNodeData | undefined, nodes: Nodes): n is FreeNodeData {
  return !!n && !n.pin && !n.railDock && (STRIP_TYPES.has(n.type) || isTileDeckFace(n, nodes))
}

/** `id` as a strip tile, or null. A hidden deck member is not geometry
 *  any more; its face stands in for it. */
function stripTileFor(id: string, nodes: Nodes): FreeNodeData | null {
  const n = nodes[tileDeckFaceOf(id, nodes) ?? id]
  return isStripTile(n, nodes) ? n : null
}

/** The tile a new effect card would join the strip of: the ONE selected
 *  canvas tile, when it can be on a strip. Null otherwise. Exported so the
 *  palette can say where a click will put the card — by construction the
 *  same answer createEffectCard acts on. */
export function effectAttachTarget(nodes: Nodes, selectedIds: string[]): FreeNodeData | null {
  return selectedIds.length === 1 ? stripTileFor(selectedIds[0], nodes) : null
}

/** The loop strip a new effect card would go onto: the rail the selection
 *  is on, when ALL of it is on one rail — the rail itself, cards docked on
 *  it, or both (a rubber band over a rail sweeps up its docked cards with
 *  it). A card in a column stands for its rail: picking a card on the rail
 *  is picking the rail. Null otherwise, or for a pinned rail (it docks
 *  nothing). Exported so the palette can say where a click will put the
 *  card — the same answer createEffectCard acts on. Checked BEFORE
 *  effectAttachTarget. */
export function effectRailFor(nodes: Nodes, selectedIds: string[]): (FreeNodeData & { rail: RailData }) | null {
  let railId: string | null = null
  for (const id of selectedIds) {
    const n = nodes[id]
    const rid = n?.type === 'rail' ? n.id : n?.railDock?.railId
    if (!rid || (railId && rid !== railId)) return null
    railId = rid
  }
  const rail = railId ? nodes[railId] : undefined
  return isRail(rail) && !rail.pin ? rail : null
}

/** The END of a rail's slot row — after its last slot, before the tray. */
function railRowEnd(rail: FreeNodeData & { rail: RailData }): RailDropTarget {
  return { railId: rail.id, kind: 'row', insertAt: rail.rail.slots.length }
}

/** The visible strip tiles touching `start`, transitively — the strip it
 *  is on, read from where the tiles sit. Not from fxStore: a picture with
 *  no effect yet has no strip there, and a second card made in the same
 *  tick as the first would not be in it yet. `skipId` is the card being
 *  placed. `decks` is tileDeckIndex(nodes) — one pass, not one per tile. */
function stripRun(
  start: FreeNodeData,
  nodes: Nodes,
  decks: { faces: Set<string>; hidden: Set<string> },
  skipId: string,
): FreeNodeData[] {
  const pool = Object.values(nodes).filter(n =>
    n.id !== skipId && n.id !== start.id && !n.pin && !n.railDock && !decks.hidden.has(n.id)
    && (STRIP_TYPES.has(n.type) || decks.faces.has(n.id)))
  const run = [start]
  for (let i = 0; i < run.length; i++) {
    for (let j = pool.length - 1; j >= 0; j--) {
      if (!rectsTouch(run[i], pool[j], DOCK_TOLERANCE)) continue
      run.push(pool[j])
      pool.splice(j, 1)
    }
  }
  return run
}

/** Gap above a card parked below a strip's end (see stripEndSlot). MORE
 *  than DOCK_TOLERANCE, so the parked card touches nothing — and so each
 *  step of the walk is sure to move down. */
const PARK_GAP = DOCK_TOLERANCE * 2

/** Where a w×h card goes to join `target`'s strip: flush right of the
 *  tile the strip reads LAST (left to right, top to bottom on a tie —
 *  useFxStrips' order), tops aligned. When that spot is taken — typically
 *  by the Viewer the strip shows in, which sits flush at its end — straight
 *  below that last tile instead: the same x, so it still reads right after
 *  it. When both are taken, parked further down that column, clear of
 *  everything (off the strip, waiting to be pushed on). Null only if that
 *  walk gives up, which takes a column of 64 tiles. */
function stripEndSlot(
  target: FreeNodeData,
  size: { width: number; height: number },
  nodes: Nodes,
  windows: Record<string, ViewportWindow3D>,
  zoom: number,
  skipId: string,
): { x: number; y: number } | null {
  const decks = tileDeckIndex(nodes)
  const { hidden } = decks
  const run = stripRun(target, nodes, decks, skipId)
  const last = run.reduce((a, b) => ((b.x - a.x) || (b.y - a.y)) > 0 ? b : a)
  // Anything the card would land ON: visible tiles, Viewers (header
  // included). Touching is fine — that is the point — overlapping is not.
  // A loop strip occupies its own box; what is docked on it lies inside.
  const occupied: Rect[] = [
    ...Object.values(nodes).filter(n => n.id !== skipId && !n.pin && !n.railDock && !hidden.has(n.id)),
    ...Object.values(windows).filter(w => !w.pin).map(w => viewportVisualRect(w, zoom)),
  ]
  const free = (x: number, y: number) =>
    !occupied.some(o => rectsTouch({ x, y, ...size }, o, -1))     // strict overlap, as stripSnap
  for (const c of [
    { x: last.x + last.width, y: last.y },
    { x: last.x, y: last.y + last.height },
  ]) {
    if (free(c.x, c.y)) return c
  }
  // Both taken. NOT the visible-canvas centre: the tile was just clicked,
  // so it is usually right there, and a card made on top of it overlaps it
  // — which counts as touching, so the card joins its strip in x order,
  // possibly AHEAD of the picture. Instead walk down the last tile's column
  // past whatever is in the way. Clear of it by more than DOCK_TOLERANCE,
  // not flush: flush against what blocked the slot would put the card on
  // THAT tile's strip, or dock it to that Viewer.
  let y = last.y + last.height + PARK_GAP
  for (let i = 0; i < 64; i++) {
    const r = { x: last.x, y, ...size }
    const hits = occupied.filter(o => rectsTouch(r, o, DOCK_TOLERANCE))
    if (!hits.length) return { x: last.x, y }
    y = Math.max(...hits.map(o => o.y + o.height)) + PARK_GAP
  }
  return null
}

/** A card added to a strip that is off screen would appear to do nothing.
 *  Bring it into view when its centre is outside the visible canvas. */
function revealIfOffscreen(id: string): void {
  const n = useFreeNodeStore.getState().nodes[id]
  const r = canvasRect()
  if (!n || n.pin || !r) return
  const { pan, zoom } = useCanvasStore.getState()
  const sx = pan.x + (n.x + n.width / 2) * zoom
  const sy = pan.y + (n.y + n.height / 2) * zoom
  if (sx < 0 || sy < 0 || sx > r.width || sy > r.height) useCanvasStore.getState().jumpToFreeNode(id)
}

/** Create an effect card. Default placement: if exactly one canvas tile is
 *  selected and it is a picture/video/effect, the new card lands flush at
 *  the RIGHT END of that tile's strip (or right of that picture if it has
 *  none), top-aligned; otherwise centred in the visible canvas. `at`
 *  overrides placement (canvas units, the card's centre). `onto` (a tile
 *  id — what a palette drag was let go over) joins THAT tile's strip
 *  instead, and is ignored when it is not a strip tile, leaving `at`.
 *  Takes an undo checkpoint, sizes by the store default × createScaleFor
 *  (zoom), sets effect {kind, params:{}} and label EFFECTS[kind].label,
 *  snaps to a strip when close (snapToStrip), selects it unless
 *  select === false. Returns the node id.
 *
 *  Loop strips: `rail` (where a drag was let go over a rail — the caller's
 *  railDropTarget) docks the card there instead. Without `at`/`onto`/`rail`
 *  a selection on one rail (effectRailFor) docks it at the END of that
 *  rail's slot row. Either way under the same checkpoint, and selected
 *  like any new card — a card on the rail stands for its rail, so the next
 *  palette click goes onto the same rail, after this one. */
export function createEffectCard(
  kind: EffectKind,
  opts: { at?: { cx: number; cy: number }; select?: boolean; onto?: string; rail?: RailDropTarget } = {},
): string {
  const k = knownKind(kind)
  const before = useFreeNodeStore.getState()
  // A loop strip first: where it was let go, else (no point given) the rail
  // the selection is on. Read BEFORE the card exists, like the strip below.
  const selRail = opts.rail || opts.at || opts.onto ? null : effectRailFor(before.nodes, before.selectedIds)
  const railTarget = opts.rail ?? (selRail ? railRowEnd(selRail) : null)
  // Which strip to join, if any: the tile it was dropped on, else (no point
  // given) the selected one.
  const target = railTarget ? null : opts.onto
    ? stripTileFor(opts.onto, before.nodes)
    : opts.at ? null : effectAttachTarget(before.nodes, before.selectedIds)

  // Cards-first: going onto no loop strip and no picture tile's strip, an
  // effect is a CARD (utils/effectCards) — after the selected card when
  // exactly one is selected, else where it was let go (snapping onto a
  // card's edge), else in view. Effect tiles stay for loop strips and for
  // strips of picture tiles.
  if (!railTarget && !target) {
    useUndoCoordinator.getState().checkpoint()
    const selCards = useBoardsStore.getState().selectedGroupIds
    return createEffectCardGroup(k, {
      at: opts.at,
      after: !opts.at && selCards.length === 1 ? selCards[0] : null,
    })
  }

  // Checkpoint + the store's default size × the zoom compensation, all in
  // canvasCreate — the size table lives in freeNodeStore and nowhere else.
  // Then the effect itself, under the same checkpoint: one undo removes
  // the whole card. Same payload as the face's kind switch.
  const id = addFreeNodeCentered('effect', opts.at ?? visibleCanvasCenter())
  useFreeNodeStore.getState().updateFreeNode(id, { effect: { kind: k, params: {} }, label: EFFECTS[k].label })

  if (railTarget) {
    useFreeNodeStore.getState().dockToRail([id], railTarget)
    // Docked: the rail sync host has already laid it out (it runs on the
    // store change, synchronously) — no strip slot, no snap. A rail that
    // refused it (pinned, or gone since the drag began) leaves it free,
    // and it is placed below like any card made without a target.
    if (useFreeNodeStore.getState().nodes[id]?.railDock) {
      if (opts.select !== false) useFreeNodeStore.getState().setFreeSelection([id])
      revealIfOffscreen(id)
      return id
    }
  }

  const fs = useFreeNodeStore.getState()
  const made = fs.nodes[id]
  const zoom = useCanvasStore.getState().zoom
  const windows = useViewport3DStore.getState().windows
  const slot = target && made
    ? stripEndSlot(target, { width: made.width, height: made.height }, fs.nodes, windows, zoom, id)
    : null
  if (slot) {
    // Already flush; snapToStrip could only pull it off toward a
    // neighbour of the slot that happens to be equally close. Or parked
    // clear below the strip's end, where snapping could only put it on
    // some OTHER strip.
    fs.updateFreeNode(id, slot)
  } else if (made) {
    const s = snapToStrip(made, fs.nodes, windows, zoom)
    if (s) fs.updateFreeNode(id, s)
  }
  if (opts.select !== false) useFreeNodeStore.getState().setFreeSelection([id])
  revealIfOffscreen(id)
  return id
}

/** The size a new loop strip would be made at this zoom (its first
 *  layout), for the toolbar's outline (utils/placeTool). */
export function loopStripSize(zoom: number): { width: number; height: number } {
  const unit = createScaleFor(zoom)
  const probe: FreeNodeData = {
    id: '', x: 0, y: 0, width: 600 * unit, height: 360 * unit, type: 'rail', label: '', text: '', imageUrl: null, mediaType: null, color: '',
    rail: { unit, output: 'process', slots: [{ id: 'p', kind: 'role', name: 'Pictures', mode: 'each' }] },
  }
  const L = railLayout(probe, undefined)
  return L ? { width: L.box.width, height: L.box.height } : { width: probe.width, height: probe.height }
}

/** Make a loop strip (utils/rail): one empty "Pictures" column, the run
 *  arrow, the results tray. `at` is its TOP-LEFT corner in canvas units —
 *  the canvas menu hangs it from the cursor, the way a menu hangs from its
 *  click; without it the rail is centred on the visible canvas. Its unit is
 *  createScaleFor(zoom), so a rail made zoomed out is a usable size there,
 *  like any new card. Takes an undo checkpoint and selects the rail, so the
 *  Effects palette's next clicks go straight onto it. Returns its id. */
export function createLoopStrip(at?: { x: number; y: number }): string {
  const zoom = useCanvasStore.getState().zoom
  useUndoCoordinator.getState().checkpoint()
  const c = at ? null : visibleCanvasCenter()
  const id = useFreeNodeStore.getState().addRail(at?.x ?? c!.cx, at?.y ?? c!.cy, createScaleFor(zoom))
  if (c) {
    // Centred on its first layout: the box the rail sync host sizes it to
    // (addRail's own size is a placeholder until then).
    const L = railLayout(useFreeNodeStore.getState().nodes[id], undefined)
    if (L) useFreeNodeStore.getState().updateFreeNode(id, { x: c.cx - L.box.width / 2, y: c.cy - L.box.height / 2 })
  }
  useFreeNodeStore.getState().setFreeSelection([id])
  return id
}
