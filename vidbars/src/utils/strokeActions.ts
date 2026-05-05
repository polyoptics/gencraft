/**
 * Unified stroke mutation helpers — components dispatch by `DrawSurface` kind
 * without needing to know which store backs which surface.
 *
 *   addStroke(surface, stroke)           // append
 *   deleteStroke(surface, strokeId)      // remove by id
 *   clearStrokes(surface)                // wipe all
 *   setStrokes(surface, strokes)         // replace (used by paste)
 *   readStrokes(surface)                 // current array
 *
 * Each call reads the current strokes for the surface, computes the next array,
 * and dispatches the appropriate setter on the host store. That gives undo a
 * single mutation per change while keeping the API uniform.
 */
import type { Stroke, DrawSurface } from '../types/stroke'
import { useBoardsStore } from '../store/boardsStore'
import { useFreeNodeStore } from '../store/freeNodeStore'

/** Read the current strokes array for a surface (empty if none). */
export function readStrokes(surface: DrawSurface): Stroke[] {
  if (surface.kind === 'freeNode') {
    return useFreeNodeStore.getState().nodes[surface.nodeId]?.strokes ?? []
  }
  const bs = useBoardsStore.getState()
  if (surface.kind === 'card') {
    return bs.groups.find(g => g.id === surface.groupId)?.cardStrokes ?? []
  }
  if (surface.kind === 'block') {
    return bs.boards[surface.boardId]?.layers?.block?.strokes ?? []
  }
  // bar
  return bs.boards[surface.boardId]?.bars[surface.barId]?.strokes ?? []
}

/** Replace the strokes array for a surface. */
export function setStrokes(surface: DrawSurface, strokes: Stroke[]): void {
  if (surface.kind === 'freeNode') {
    useFreeNodeStore.getState().updateFreeNode(surface.nodeId, { strokes })
    return
  }
  const bs = useBoardsStore.getState()
  if (surface.kind === 'card') {
    bs.setCardStrokes(surface.groupId, strokes)
  } else if (surface.kind === 'block') {
    bs.setBlockStrokes(surface.boardId, strokes)
  } else {
    bs.setBarStrokes(surface.boardId, surface.barId, strokes)
  }
}

/** Append a single stroke. */
export function addStroke(surface: DrawSurface, stroke: Stroke): void {
  setStrokes(surface, [...readStrokes(surface), stroke])
}

/** Delete a stroke by id. No-op if not found. */
export function deleteStroke(surface: DrawSurface, strokeId: string): void {
  const current = readStrokes(surface)
  const next = current.filter(s => s.id !== strokeId)
  if (next.length !== current.length) setStrokes(surface, next)
}

/** Wipe every stroke on a surface. */
export function clearStrokes(surface: DrawSurface): void {
  if (readStrokes(surface).length === 0) return
  setStrokes(surface, [])
}

// ── Cross-surface clipboard ────────────────────────────────
//
// Strokes are pure data with no surface-bound IDs, so they paste between
// surfaces freely. The clipboard lives at module scope (transient — does NOT
// persist across reloads) and is shared by all callers.

let _strokeClipboard: Stroke[] | null = null

/** Copy all strokes from the surface into the annotation clipboard.
 *  Returns true if anything was copied (false on an empty surface). */
export function copyStrokes(surface: DrawSurface): boolean {
  const strokes = readStrokes(surface)
  if (strokes.length === 0) return false
  // Deep-copy so future edits to the source don't mutate clipboard contents.
  _strokeClipboard = strokes.map(s => ({
    ...s,
    points: s.points.map(p => ({ ...p })),
  }))
  return true
}

/** Append the clipboard strokes onto the surface. Each pasted stroke gets a
 *  fresh UUID so it's an independent copy (you can paste repeatedly without
 *  ID collisions). Returns true if anything was pasted. */
export function pasteStrokes(surface: DrawSurface): boolean {
  if (!_strokeClipboard || _strokeClipboard.length === 0) return false
  const fresh: Stroke[] = _strokeClipboard.map(s => ({
    ...s,
    id: crypto.randomUUID(),
    points: s.points.map(p => ({ ...p })),
  }))
  setStrokes(surface, [...readStrokes(surface), ...fresh])
  return true
}

/** Anything currently in the annotation clipboard? */
export function hasStrokeClipboard(): boolean {
  return _strokeClipboard !== null && _strokeClipboard.length > 0
}

/** How many strokes are sitting in the clipboard (0 if empty). */
export function strokeClipboardSize(): number {
  return _strokeClipboard?.length ?? 0
}
