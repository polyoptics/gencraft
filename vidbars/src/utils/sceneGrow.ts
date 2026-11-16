// Making a scene card bigger by ADDING SPACE (Brian 2026-11-10: "resize
// the window, but by adding space instead of scaling things"). The
// sections already there keep their exact size and place:
//
//  - growStrip: the "+" on the card's outer edge adds a row or column and
//    the CARD grows by it (it used to squeeze every section).
//  - stretchStart: Shift-drag the card's right or bottom edge. Only that
//    edge moves; the sections touching it grow or shrink, the rest stay.
//
// The face's layout scale is "organic" (text and controls grow slower
// than the card), so a bigger card would by itself rescale everything a
// little. To keep sizes exact the scale is held: sceneView.fitK multiplies
// the organic fit so it is the same after the card grew as before. Plain
// resizing still scales everything, from there.

import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { addStripKeeping, divBoxes, edgeRoom, stretchEdge, type SceneDiv } from './sceneCard'

/** The card face a scene is laid out for (a card's natural size). */
export const NAT_W = 125, NAT_H = 184
export const SIZE_REF = 12
/** Between divisions, and around them, in layout units. */
export const GAP = 1.2, PAD = 1.6

/** The organic fit of a face `width` x `height` screen px at `zoom`. */
const organic = (width: number, height: number, zoom: number) => Math.max(0.01, Math.min(width / NAT_W, height / NAT_H) / zoom)

/** A scene face's layout: its scale (screen px per layout unit) and its
 *  size in layout units, inside its padding too. */
export function faceLayout(width: number, height: number, zoom: number, fitK = 1) {
  const fit = organic(width, height, zoom) * fitK
  const s = Math.sqrt(fit * SIZE_REF) * zoom
  const W = width / s, H = height / s
  return { fit, s, W, H, iw: W - PAD * 2, ih: H - PAD * 2 }
}

/** The fitK that keeps the scale `fit` on a face of this size. */
export const holdFit = (fit: number, width: number, height: number, zoom: number) => fit / organic(width, height, zoom)

type Face = { width: number; height: number }

/** A row or column added on the card's outer edge; the card grows by it.
 *  `face`: the face's size on screen now. One undo puts it back. */
export function growStrip(sceneId: string, side: 'top' | 'bottom' | 'left' | 'right', face: Face): void {
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.id === sceneId)
  const zoom = useCanvasStore.getState().zoom
  if (!g?.scene) return
  const L = faceLayout(face.width, face.height, zoom, g.sceneView?.fitK)
  const across = side === 'top' || side === 'bottom'
  // As thick as a seventh of the card that way, and never a sliver.
  const t = Math.max(across ? 16 : 24, (across ? L.ih : L.iw) * 0.16)
  const next = addStripKeeping(g.scene, side, L.iw, L.ih, GAP, t)
  const d = (t + GAP) * L.s  // screen px the card grows by
  const width = face.width + (across ? 0 : d), height = face.height + (across ? d : 0)
  useUndoCoordinator.getState().checkpoint()
  bs.setGroupScene(sceneId, next)
  bs.setGroupSceneView(sceneId, { ...(g.sceneView ?? {}), fitK: holdFit(L.fit, width, height, zoom) })
  bs.setGroupCardSize(sceneId, width / zoom, height / zoom)
  // On its top or left: the card grows that way, so what was there stays
  // where it is on the canvas.
  if (side === 'top') bs.setGroupPos(sceneId, g.originY - d / zoom, g.originX)
  if (side === 'left') bs.setGroupPos(sceneId, g.originY, g.originX - d / zoom)
}

/** Shift-drag of the card's right / bottom edge (or corner): returns the
 *  move for a drag of (dx, dy) canvas units from where it began, or null
 *  when this is not a scene card. The caller took the undo checkpoint. */
export function stretchStart(sceneId: string, edge: 'right' | 'bottom' | 'corner', face: Face): ((dx: number, dy: number) => void) | null {
  const g0 = useBoardsStore.getState().groups.find(x => x.id === sceneId)
  const zoom = useCanvasStore.getState().zoom
  if (!g0?.scene) return null
  const root0: SceneDiv = g0.scene
  const L = faceLayout(face.width, face.height, zoom, g0.sceneView?.fitK)
  const boxes = divBoxes(root0, L.iw, L.ih, GAP)
  // How far each edge can come in before a section there has no room.
  const minX = edge === 'bottom' ? 0 : -edgeRoom(root0, 'row', boxes, GAP)
  const minY = edge === 'right' ? 0 : -edgeRoom(root0, 'col', boxes, GAP)
  return (dx, dy) => {
    const ux = edge === 'bottom' ? 0 : Math.max(minX, dx * zoom / L.s)
    const uy = edge === 'right' ? 0 : Math.max(minY, dy * zoom / L.s)
    let next = root0
    if (ux) next = stretchEdge(next, 'row', boxes, GAP, ux)
    if (uy) next = stretchEdge(next, 'col', divBoxes(next, L.iw + ux, L.ih, GAP), GAP, uy)
    const width = face.width + ux * L.s, height = face.height + uy * L.s
    const bs = useBoardsStore.getState()
    bs.setGroupScene(sceneId, next)
    bs.setGroupSceneView(sceneId, { ...(g0.sceneView ?? {}), fitK: holdFit(L.fit, width, height, zoom) })
    bs.setGroupCardSize(sceneId, width / zoom, height / zoom)
  }
}
