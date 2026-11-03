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
 *  The per-type default size belongs to `addFreeNode` — it is tuned there
 *  (a Media Pool needs a readable grid, a Prompt Pad needs its sections side
 *  by side). So create the node first, read back what the store chose, and
 *  only apply the zoom compensation. Passing our own base sizes in would be a
 *  second table to keep in step with that one. */
export function addFreeNodeCentered(
  type: FreeNodeType,
  at?: { cx: number; cy: number },
): string {
  const { cx, cy } = at ?? viewportCenterInCanvas()
  const zoom = useCanvasStore.getState().zoom
  useUndoCoordinator.getState().checkpoint()
  const k = createScaleFor(zoom)
  const fs = useFreeNodeStore.getState()
  const id = fs.addFreeNode(cx, cy, type)
  const made = useFreeNodeStore.getState().nodes[id]
  // A Media Pool scales its contents and its window together, so it opens
  // the way Brian set his by hand (2026-11-03): text about a loop strip's
  // size at that zoom, the window just big enough for that content. The
  // 22/zoom is FreeNode's header, which is a constant 22 screen pixels.
  const s = type === 'pool' ? clampUiScale(k * POOL_TEXT_VS_STRIP) : k
  const w = (made?.width ?? 200) * s
  const h = (made?.height ?? 160) * s + (type === 'pool' ? 22 / zoom : 0)
  useFreeNodeStore.getState().updateFreeNode(id, {
    width: w, height: h, x: cx - w / 2, y: cy - h / 2,
    ...(type === 'pool' ? { uiScale: s } : {}),
  })
  return id
}

/** How a new Media Pool's text compares with a loop strip made at the same
 *  zoom. Read off Brian's hand-set pool: 8.3x at 6% zoom, where a strip's
 *  unit is 10. */
const POOL_TEXT_VS_STRIP = 0.83

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
