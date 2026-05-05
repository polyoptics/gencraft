/**
 * Module-level "where is the cursor right now?" tracker.
 *
 * Used by drawable surfaces (cards / blocks / bars / free nodes) to seed
 * their `isHovered` state on mount. Without this, a surface that mounts
 * with the cursor already inside its bounds never receives a synthetic
 * `pointerenter` / `mouseenter` — the browser only fires those when the
 * cursor MOVES into an element, not when an element appears under it.
 * That mostly bites when you cross a zoom-layer threshold and the new
 * layer's component swaps in under a stationary cursor.
 *
 * Footprint: one passive `pointermove` listener on the window, two
 * numbers in module scope. Idempotent install — safe to call from any
 * surface's mount effect.
 */

let _x = -1
let _y = -1
let _installed = false

function onPointerMove(e: PointerEvent) {
  _x = e.clientX
  _y = e.clientY
}

/** Call once (idempotent) to start listening. */
export function ensurePointerTracker(): void {
  if (_installed) return
  _installed = true
  window.addEventListener('pointermove', onPointerMove, { passive: true, capture: true })
}

/** Current cursor position in viewport coords, or null if no movement seen yet. */
export function currentPointerPos(): { x: number; y: number } | null {
  if (_x < 0 || _y < 0) return null
  return { x: _x, y: _y }
}

/** Is the cursor currently inside the given element's bounding rect? */
export function isPointerInside(el: Element | null): boolean {
  if (!el) return false
  const pos = currentPointerPos()
  if (!pos) return false
  const r = el.getBoundingClientRect()
  return pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom
}

import { useEffect, type RefObject } from 'react'

/**
 * Mount hook: ensures the pointer tracker is running, and on mount checks
 * whether the cursor is currently inside the element. If so, calls
 * `setHovered(true)` so the component can show its hover-revealed UI
 * immediately after a zoom-layer swap drops it under a stationary cursor.
 */
export function useSeedHoverFromCursor(
  ref: RefObject<HTMLElement | null>,
  setHovered: (v: boolean) => void,
): void {
  useEffect(() => {
    ensurePointerTracker()
    // After mount, the element might not have its final bounds yet —
    // checking on the next frame avoids a race with layout.
    const id = requestAnimationFrame(() => {
      if (isPointerInside(ref.current)) setHovered(true)
    })
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
