// While the view is dragged, the cards are carried, not redrawn.
//
// Every card on the canvas works out where it is on screen from the view's
// position (`pan + place * zoom`, components/Layers/cardView), so a drag of
// the view had every card, with its header, face, chips and tray, worked
// out again on every frame. With a full canvas that was most of a frame's
// time and the view dragged in jerks (Brian 2026-11-16: "it's also become
// pretty sluggish on the canvas").
//
// So, while a pointer is down and the view is only sliding (no zoom, flat):
// the cards keep the view position they were last drawn with (`held`), and
// the one box they are all drawn in is slid by how far the view has moved
// since. The picture is the same; nothing in it is worked out again. The
// moment the pointer lets go (or presses again, or the zoom changes) the
// cards are drawn once at where the view came to rest and the box goes
// back to nothing.

import { flushSync } from 'react-dom'
import { useCanvasStore } from '../store/canvasStore'
import { isTilted, useTiltStore } from '../store/tiltStore'

type Pan = { x: number; y: number }

let held: Pan | null = null
let pointerDown = false
const subs = new Set<() => void>()
const boxes = new Set<HTMLElement>()

function slide(dx: number, dy: number) {
  for (const el of boxes) {
    el.style.left = `${dx}px`; el.style.top = `${dy}px`
    el.style.right = `${-dx}px`; el.style.bottom = `${-dy}px`
  }
}

/** Whole px: the cards stay on the pixels they were drawn on. */
function place() {
  if (!held) return
  const pan = useCanvasStore.getState().pan
  slide(Math.round(pan.x - held.x), Math.round(pan.y - held.y))
}

function tell() { for (const f of [...subs]) f() }

/** Draw the cards where the view is now. `now`: before anything else
 *  happens (a press is about to be handled with what the cards last drew). */
function letGo(now = false) {
  if (!held) return
  held = null
  slide(0, 0)
  if (now) { try { flushSync(tell) } catch { tell() } } else tell()
}

useCanvasStore.subscribe((s, prev) => {
  if (s.zoom !== prev.zoom) letGo()
  else if (s.pan !== prev.pan) {
    if (held && isTilted(useTiltStore.getState())) letGo()
    else if (!held && pointerDown && boxes.size > 0 && !isTilted(useTiltStore.getState())) held = prev.pan
    place()
  }
  tell()
})

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => { letGo(true); pointerDown = true }, true)
  const up = (e: PointerEvent) => { pointerDown = e.buttons !== 0; if (!pointerDown) letGo() }
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', up, true)
  window.addEventListener('blur', () => { pointerDown = false; letGo() })
}

/** For useSyncExternalStore. */
export const subscribeView = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
/** The view's position, as it is. */
export const livePan = (): Pan => useCanvasStore.getState().pan
/** The view's position as the carried cards were last drawn with. */
export const carriedPan = (): Pan => held ?? useCanvasStore.getState().pan

/** The box the carried cards are drawn in (a ref): it must be laid out
 *  with left, top, right and bottom all 0. */
export const carryBox = (el: HTMLElement | null) => {
  if (!el) return
  boxes.add(el)
  return () => { boxes.delete(el) }
}
