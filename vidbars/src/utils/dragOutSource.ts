// dragOutSource — the shape of the tile a drag-out (DragOutGrip) began on.
//
// A drag-out hands Windows a FILE, and a file carries no size or crop. When
// that drag comes back and is let go on the canvas (InfiniteCanvas), the
// duplicate should look like what was dragged — same size, same crop — not
// a fresh import at the default size. So the grip notes the tile's shape as
// the drag starts, and the canvas takes it (once) when the drop lands.
// Drops from outside the app never see it: it is only read while the
// page's own drag is out (vidbarsDesktop.isDraggingOut).

import type { HeroImageTransform } from '../store/boardsStore'

export interface DragOutShape {
  width: number
  height: number
  imageTransform?: HeroImageTransform
}

let current: { shape: DragOutShape; at: number } | null = null

/** Note the shape of the tile a drag-out starts on (null: none to keep). */
export function noteDragOutShape(shape: DragOutShape | null): void {
  current = shape ? { shape, at: performance.now() } : null
}

let card: { id: string; at: number } | null = null

/** Note the CARD a drag-out starts on (null: none). Dropped back on the
 *  canvas, the drag makes a duplicate of that card as it is — its blocks,
 *  face, shape and size — not a card made from the file. */
export function noteDragOutCard(id: string | null): void {
  card = id ? { id, at: performance.now() } : null
}

/** The noted card, once, as takeDragOutShape. */
export function takeDragOutCard(): string | null {
  const c = card
  card = null
  return c && performance.now() - c.at < 60_000 ? c.id : null
}

/** The noted shape, once: a later drag, from a grip with no shape to give,
 *  must never inherit it. Stale after a minute — no drag lasts that long. */
export function takeDragOutShape(): DragOutShape | null {
  const c = current
  current = null
  return c && performance.now() - c.at < 60_000 ? c.shape : null
}
