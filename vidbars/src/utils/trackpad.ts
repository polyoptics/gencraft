import { useCanvasStore } from '../store/canvasStore'
import { WHEEL_ZOOM_FACTOR } from '../store/zoomZonesStore'

/** Trackpad gestures reach the page as wheel events, as a mouse wheel's
 *  clicks do (Brian 2026-11-22, on a laptop with no middle button: "its
 *  almost impossible to control the camera"). Told apart here, in the one
 *  place, so the mouse wheel goes on exactly as it was:
 *  - 'pan': a two-finger swipe. The view slides with the fingers.
 *  - 'pinch': a two-finger pinch (the browser sends it as a wheel with
 *    Ctrl held and small steps). The view zooms with the fingers.
 *  - null: a mouse wheel. Whatever it did before. */
export type PadKind = 'pan' | 'pinch' | null

/** A trackpad's wheel events come in a run, a few ms apart: inside this
 *  long after one, the next is the trackpad's too, whatever it looks like. */
const RUN_MS = 150
let padAt = -1e9
let padCtrl = false
const seen = new WeakMap<WheelEvent, PadKind>()

/** One whole click of a mouse wheel: the browser's old wheelDelta counts
 *  120 a click, on one axis (Shift turns it sideways). A trackpad's steps
 *  are fingers' px, on both axes at once and almost never a whole 120. */
function isClick(e: WheelEvent): boolean {
  const w = e as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number }
  const wx = w.wheelDeltaX, wy = w.wheelDeltaY
  if (wx === undefined || wy === undefined) {
    // No wheelDelta to go by: a whole step, big, straight up or down.
    return e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 100
  }
  if ((wx === 0) === (wy === 0)) return false
  return (wx || wy) % 120 === 0
}

/** Which gesture a wheel event is. Asked any number of times about the
 *  same event, the answer is the same. */
export function padWheel(e: WheelEvent): PadKind {
  const had = seen.get(e)
  if (had !== undefined) return had
  let kind: PadKind = null
  // Lines or pages (not px) are a wheel's; a made-up event is nobody's.
  if (e.isTrusted && e.deltaMode === 0 && (e.deltaX !== 0 || e.deltaY !== 0)) {
    const inRun = e.timeStamp - padAt < RUN_MS && e.ctrlKey === padCtrl
    if (inRun || !isClick(e)) kind = e.ctrlKey ? 'pinch' : 'pan'
  }
  if (kind) { padAt = e.timeStamp; padCtrl = e.ctrlKey }
  seen.set(e, kind)
  return kind
}

/** How much a pinch step zooms: the browser sends -100 x the log of the
 *  fingers' spread, so this follows them exactly. */
export const pinchFactor = (e: WheelEvent) => Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) / 100)

/** The wheel over the flat canvas, at the host point (mx, my): a mouse
 *  wheel zooms a step there, as it always has; a two-finger swipe slides
 *  the view, a pinch zooms it there. Every place the wheel zooms the
 *  canvas calls this, so they all take the trackpad alike. */
export function wheelCanvas(ev: WheelEvent | { nativeEvent: WheelEvent }, mx: number, my: number) {
  const e = 'nativeEvent' in ev ? ev.nativeEvent : ev
  const cs = useCanvasStore.getState()
  const pad = padWheel(e)
  if (pad === 'pan') cs.shiftPan(-e.deltaX, -e.deltaY)
  else if (pad === 'pinch') cs.zoomAtPoint(pinchFactor(e), mx, my)
  else cs.zoomAtPoint(e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR, mx, my)
}

/** A pinch is the canvas's alone: unprevented, the browser zooms the
 *  whole page with it as well. (React's own wheel listeners are passive
 *  and cannot prevent it.) A real Ctrl + mouse wheel is left as it was. */
export function installTrackpad() {
  window.addEventListener('wheel', e => {
    if (padWheel(e) === 'pinch') e.preventDefault()
  }, { capture: true, passive: false })
}
