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

import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useViewport3DStore, type ViewportWindow3D } from '../../store/viewport3dStore'
import { addFreeNodeCentered, viewportCenterInCanvas } from '../canvasCreate'
import { DOCK_TOLERANCE, rectsTouch, viewportVisualRect, type Rect } from '../viewportDocking'
import { isTileDeckFace, tileDeckFaceOf, tileDeckIndex } from '../tileDecks'
import { EFFECTS, knownKind, type EffectKind } from './effects'
import { snapToStrip } from './stripSnap'

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
 *  it stands for every member behind it. */
function isStripTile(n: FreeNodeData | undefined, nodes: Nodes): n is FreeNodeData {
  return !!n && !n.pin && (STRIP_TYPES.has(n.type) || isTileDeckFace(n, nodes))
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
    n.id !== skipId && n.id !== start.id && !n.pin && !decks.hidden.has(n.id)
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
  const occupied: Rect[] = [
    ...Object.values(nodes).filter(n => n.id !== skipId && !n.pin && !hidden.has(n.id)),
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
 *  select === false. Returns the node id. */
export function createEffectCard(
  kind: EffectKind,
  opts: { at?: { cx: number; cy: number }; select?: boolean; onto?: string } = {},
): string {
  const k = knownKind(kind)
  const before = useFreeNodeStore.getState()
  // Which strip to join, if any — read BEFORE the card exists: the tile it
  // was dropped on, else (no point given) the selected one.
  const target = opts.onto
    ? stripTileFor(opts.onto, before.nodes)
    : opts.at ? null : effectAttachTarget(before.nodes, before.selectedIds)

  // Checkpoint + the store's default size × the zoom compensation, all in
  // canvasCreate — the size table lives in freeNodeStore and nowhere else.
  // Then the effect itself, under the same checkpoint: one undo removes
  // the whole card. Same payload as the face's kind switch.
  const id = addFreeNodeCentered('effect', opts.at ?? visibleCanvasCenter())
  useFreeNodeStore.getState().updateFreeNode(id, { effect: { kind: k, params: {} }, label: EFFECTS[k].label })

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
