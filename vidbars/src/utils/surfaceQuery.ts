/**
 * Find the DOM element for a draw surface so callers can read its screen
 * bounds — used by the floating DrawToolbar (to anchor next to the surface)
 * and by the click-outside-cancels handler.
 *
 * Every surface marks its drawable region with `data-draw-surface={id}`,
 * where `id` is `surfaceId(surface)` from types/stroke. The same query
 * therefore works across free nodes / cards / blocks / bars without each
 * caller having to know about the underlying render tree.
 */
import { surfaceId, type DrawSurface } from '../types/stroke'

export function querySurfaceElement(surface: DrawSurface): HTMLElement | null {
  const id = surfaceId(surface)
  // CSS.escape handles ids that contain colons, slashes, etc. (e.g.
  // bar:<boardUUID>:<barUUID>). Falls back to a manual escape if CSS.escape
  // isn't available in the runtime — should only matter for very old envs.
  const escaped = (typeof CSS !== 'undefined' && CSS.escape)
    ? CSS.escape(id)
    : id.replace(/["\\]/g, '\\$&')
  return document.querySelector<HTMLElement>(`[data-draw-surface="${escaped}"]`)
}
