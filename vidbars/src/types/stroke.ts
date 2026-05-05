/**
 * Vector stroke types for the annotation/sketch system.
 *
 * Strokes live on any "drawable surface" — free nodes, cards, blocks, or bars.
 * Each surface gets its own array of strokes (per-zoom-level model: a stroke
 * drawn at card zoom belongs to the card, not the underlying boards).
 *
 * Coordinates are NORMALIZED (0–1) relative to the surface's current size.
 * This keeps strokes locked to the surface even when it's resized or shown
 * at different zooms — render-time math multiplies by current dimensions.
 *
 * Strokes are pure data with no surface-bound IDs, so they can be copied and
 * pasted between surfaces freely.
 */

export interface StrokePoint {
  x: number          // normalized 0–1 across surface width
  y: number          // normalized 0–1 across surface height
  pressure: number   // 0–1, from PointerEvent.pressure (1 if not a pen)
}

export interface Stroke {
  id: string
  points: StrokePoint[]
  color: string      // hex or rgba
  size: number       // base thickness in CSS px at surface's natural size
  tool: 'pen' | 'marker' | 'highlighter'
}

/** A drawable surface anywhere in the app. */
export type DrawSurface =
  | { kind: 'freeNode'; nodeId: string }
  | { kind: 'card';     groupId: string }
  | { kind: 'block';    boardId: string }
  | { kind: 'bar';      boardId: string; barId: string }

export const DEFAULT_PEN_COLOR = '#ffffff'
export const DEFAULT_PEN_SIZE = 4              // CSS px at surface natural size
export const MIN_PEN_SIZE = 1
export const MAX_PEN_SIZE = 32

/** Helper: same surface? Used to guard pointer-event capture. */
export function sameSurface(a: DrawSurface | null, b: DrawSurface | null): boolean {
  if (!a || !b) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'freeNode' && b.kind === 'freeNode') return a.nodeId === b.nodeId
  if (a.kind === 'card'     && b.kind === 'card')     return a.groupId === b.groupId
  if (a.kind === 'block'    && b.kind === 'block')    return a.boardId === b.boardId
  if (a.kind === 'bar'      && b.kind === 'bar')      return a.boardId === b.boardId && a.barId === b.barId
  return false
}
