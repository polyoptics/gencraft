// Creating things on the canvas, in one place.
//
// The canvas context menu and the top icon bar both "add a Media Pool" or
// "make a new card", and they must produce IDENTICAL results — same size,
// same zoom compensation, same undo checkpoint. Two copies of that sequence
// is how they drift, so both call these.

import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useViewport3DStore, VIEWPORT3D_DEFAULT_W, VIEWPORT3D_DEFAULT_H } from '../store/viewport3dStore'
import { INIT_W, INIT_H } from '../store/boardsStore'
import { freeNodeDefaultSize } from '../store/freeNodeStore'
import { NLE_HEADER_CANVAS_H } from '../components/NLE/NLETimelineHeader'
import type { FreeNodeType } from '../store/freeNodeStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { dotStep } from './dotGrid'
import { clampUiScale } from '../components/UI/PanelSurface'

/** A card's origin is its content corner; the drawn card starts this far left
 *  of it. Needed to centre a new card on a point rather than hang it off one. */
export const CARD_CONTENT_INSET = 20

/** Zoom-aware size multiplier. A thing created while zoomed out has to be big
 *  in CANVAS units to be a sensible size on SCREEN — without this, adding a
 *  node at card zoom drops a speck you then have to hunt for. Clamped so it
 *  stays sane at the extremes. */
export function createScaleFor(zoom: number): number {
  return Math.max(0.6, Math.min(10, 1 / zoom))
}

/** Canvas coords of the middle of the viewport — where a toolbar button, which
 *  has no cursor position of its own, should put what it creates. */
export function viewportCenterInCanvas(): { cx: number; cy: number } {
  const { pan, zoom } = useCanvasStore.getState()
  return {
    cx: (window.innerWidth / 2 - pan.x) / zoom,
    cy: (window.innerHeight / 2 - pan.y) / zoom,
  }
}

/** Add a free node centred on a canvas point, sized for the current zoom.
 *  Returns the new node's id.
 *
 *  The per-type default size belongs to freeNodeStore (freeNodeDefaultSize)
 *  — it is tuned there (a Media Pool needs a readable grid, a Prompt Pad
 *  needs its sections side by side). freeNodeFootprint applies the zoom
 *  compensation, and the placing outline reads the same function. */
export function addFreeNodeCentered(
  type: FreeNodeType,
  at?: { cx: number; cy: number },
): string {
  const { cx, cy } = at ?? viewportCenterInCanvas()
  const zoom = useCanvasStore.getState().zoom
  useUndoCoordinator.getState().checkpoint()
  const id = useFreeNodeStore.getState().addFreeNode(cx, cy, type)
  const { w, h } = freeNodeFootprint(type, zoom)
  useFreeNodeStore.getState().updateFreeNode(id, {
    width: w, height: h, x: cx - w / 2, y: cy - h / 2,
    ...(type === 'pool' ? { uiScale: poolUiScale(zoom) } : {}),
  })
  return id
}

/** How a new Media Pool's text compares with a loop strip made at the same
 *  zoom. Read off Brian's hand-set pool: 8.3x at 6% zoom, where a strip's
 *  unit is 10. */
const POOL_TEXT_VS_STRIP = 0.83

/** A Media Pool scales its contents and its window together, so it opens
 *  the way Brian set his by hand (2026-11-03): text about a loop strip's
 *  size at that zoom, the window just big enough for that content. */
function poolUiScale(zoom: number): number {
  return clampUiScale(createScaleFor(zoom) * POOL_TEXT_VS_STRIP)
}

/** What a create makes, as the placing outline draws it (utils/placeTool):
 *  a w x h box in canvas units whose middle sits `dy` above the point the
 *  create is centred on (a Viewer's and a card's header hang above the
 *  middle of their body). Each one is worked out the way its create sizes
 *  the thing, so the outline is what lands. */
export interface Footprint { w: number; h: number; dy: number }

/** addFreeNodeCentered's size: the type's default, zoom-compensated. The
 *  22/zoom on a pool is FreeNode's header, a constant 22 screen pixels. */
export function freeNodeFootprint(type: FreeNodeType, zoom: number): Footprint {
  const base = freeNodeDefaultSize(type)
  const s = type === 'pool' ? poolUiScale(zoom) : createScaleFor(zoom)
  return { w: base.width * s, h: base.height * s + (type === 'pool' ? 22 / zoom : 0), dy: 0 }
}

/** addViewerCentered's window, header (22 screen px) included. */
export function viewerFootprint(zoom: number): Footprint {
  const k = createScaleFor(zoom), hdr = 22 / zoom
  return { w: VIEWPORT3D_DEFAULT_W * k, h: VIEWPORT3D_DEFAULT_H * k + hdr, dy: hdr / 2 }
}

/** createCardOrBoardAt's card: its content, and the header band above it
 *  (cardVisualRect's headerExtend). */
export function cardFootprint(zoom: number): Footprint {
  const k = createScaleFor(zoom)
  const hdr = (Math.max(NLE_HEADER_CANVAS_H * zoom, 20) + 2 * zoom) / zoom
  return { w: INIT_W * k, h: INIT_H * k + hdr, dy: hdr / 2 }
}

/** A new Viewer centred on a canvas point, sized for the current zoom the
 *  same way addFreeNodeCentered sizes a node. The toolbar button and the
 *  canvas menu both use it, so they open the same Viewer. */
export function addViewerCentered(at?: { cx: number; cy: number }): string {
  const { cx, cy } = at ?? viewportCenterInCanvas()
  const k = createScaleFor(useCanvasStore.getState().zoom)
  useUndoCoordinator.getState().checkpoint()
  const w = VIEWPORT3D_DEFAULT_W * k, h = VIEWPORT3D_DEFAULT_H * k
  const v3 = useViewport3DStore.getState()
  const id = v3.addWindow(cx - w / 2, cy - h / 2)
  v3.updateWindow(id, { width: w, height: h })
  return id
}

/** The Rolodex node wants a query seeded or it opens empty. */
export function addBrowserNode(at?: { cx: number; cy: number }): string {
  const id = addFreeNodeCentered('list', at)
  useFreeNodeStore.getState().updateFreeNode(id, {
    listQuery: { query: '', kind: 'all', includeCanvasItems: false, sortMode: 'creation', view: 'flat' },
  })
  return id
}

/** New card (at card zoom) or new board (further in) — the same object either
 *  way; the zoom only decides what you are looking at when it appears.
 *  Centred on the given canvas point. Returns the new board's id. */
export function createCardOrBoardAt(at?: { cx: number; cy: number }): string {
  const { cx, cy } = at ?? viewportCenterInCanvas()
  const zoom = useCanvasStore.getState().zoom
  useUndoCoordinator.getState().checkpoint()
  const k = createScaleFor(zoom)
  const boardId = useBoardsStore.getState().createBoard(0, 0)
  useBoardsStore.getState().moveToNewGroup(boardId)
  const bs = useBoardsStore.getState()
  const group = bs.groups.find(g => g.boardIds.includes(boardId))
  const board = bs.boards[boardId]
  const rootId = board?.rootIds[0]
  // Scale the root bar so the card reads at a comfortable SCREEN size at the
  // zoom it was created from.
  if (rootId && k !== 1) {
    const bar = board.bars[rootId]
    bs.resizeBarEdge(boardId, rootId, 'right', bar.width * (k - 1))
    bs.setBarHeight(boardId, rootId, bar.height * k)
  }
  // Centre the card's footprint on the point. setGroupPos takes (y, x).
  const cardW = (board?.bars[rootId ?? '']?.width ?? 480) * k
  const cardH = (board?.bars[rootId ?? '']?.height ?? 270) * k
  if (group) {
    useBoardsStore.getState().setGroupPos(
      group.id,
      cy - cardH / 2,
      cx - cardW / 2 - CARD_CONTENT_INSET,
    )
  }
  return boardId
}

/** A new Storyline: one point, on the dot nearest the given canvas point
 *  (the viewport's middle by default). Dragging out from it grows its line
 *  (components/Canvas/StorylineLayer). Returns the node's id. */
export function createStorylineAt(at?: { cx: number; cy: number }): string {
  const { cx, cy } = at ?? viewportCenterInCanvas()
  const step = dotStep(useCanvasStore.getState().zoom)
  useUndoCoordinator.getState().checkpoint()
  const id = useFreeNodeStore.getState().addFreeNode(0, 0, 'storyline')
  useFreeNodeStore.getState().updateFreeNode(id, {
    x: Math.round(cx / step) * step, y: Math.round(cy / step) * step, width: 0, height: 0,
  })
  return id
}
