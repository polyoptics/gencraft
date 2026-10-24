// useMenuClamp — keep a portal context menu inside the window.
//
// Measured, not guessed: a menu's rows vary (desktop file items arrive after
// an async lookup, labels wrap, image rows come and go), and a hard-coded
// height undercounts exactly where it matters — the bottom rows get pushed
// off screen. The measurement runs in a layout effect, so the corrected
// position is applied before the first paint.

import { useLayoutEffect, useRef, useState } from 'react'

/** `contentKey` must change whenever the menu opens or its rows change
 *  (e.g. `open ? items.length : -1`) — that is when it is re-measured. */
export function useMenuClamp(y: number, contentKey: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(0)
  useLayoutEffect(() => {
    if (ref.current) setH(ref.current.offsetHeight)
  }, [contentKey])
  return { ref, top: Math.max(4, Math.min(y, window.innerHeight - h - 8)) }
}
