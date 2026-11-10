// The world clock (Brian 2026-11-10). One storyline is the world's
// timeline: its time marker (utils/stateCard, StorylineLayer StoryMarker)
// is the world's time, and every State card follows it. The control in the
// canvas's bottom-left corner (components/UI/WorldClock) names that
// storyline, jumps to it, and holds a bar that mirrors its marker, so the
// story can be scrubbed from anywhere. A storyline becomes the world's by
// being dragged (by its handle) onto the control.
// Which storyline, and whether the bar is out: canvasStore worldClockLine /
// worldClockOpen.

import { create } from 'zustand'

/** A storyline is being dragged over the control: it lights to take it. */
export const useWorldClockUi = create<{ hot: boolean; set: (p: { hot: boolean }) => void }>(set => ({
  hot: false,
  set: p => set(p),
}))

/** Is screen point (x, y) on the World clock control? */
export function overWorldClock(x: number, y: number): boolean {
  const el = document.querySelector('[data-world-clock-drop]')
  if (!el) return false
  const r = el.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}
