import { useEffect } from 'react'
import { flushSync } from 'react-dom'
import { useTiltStore, isTilted, offFlat, unprojectTilt, standRise, shiftKeeping, depthShare, centrePoint, TILT_SNAP, TILT_MAX, TILT_UNDER, tiltP, type Pivot } from '../../../store/tiltStore'
import { storyWallOf } from '../StorylineLayer'
import { peekAt, usePeek } from '../../../utils/peek'
import { useCanvasStore, groupBounds, MIN_ZOOM, MAX_ZOOM } from '../../../store/canvasStore'
import { useFreeNodeStore } from '../../../store/freeNodeStore'
import { useBoardsStore } from '../../../store/boardsStore'
import { models, modelKey } from './TiltModels'
import { sceneSpot, standsIn, sceneOf } from '../../../utils/area3dScene'
import { area3dOutOf } from '../../../utils/area3dCard'
import { padWheel } from '../../../utils/trackpad'

/** Degrees of tilt / turn per pixel of Alt+drag. */
const DRAG_DEG = 0.25
/** Sideways px an Alt+drag can wander before it starts turning the plane. */
const TURN_SLOP = 14
/** Px the drag that leaves the flat view moves before it picks the camera
 *  for that visit (see pickCamera). */
const LOCK_PX = 8
/** How far a model turns per px of Alt-drag on it (radians). */
export const SPIN_RAD = 0.6 * Math.PI / 180

export const hostOf = (el: Element | null) => el?.closest('[data-zoom-bar-host]') as HTMLElement | null

/** Ease the view's centre from `from` to `to` (canvas units) over
 *  GLIDE_MS, whatever the zoom does meanwhile. Slow in and out: moving
 *  your place on the canvas should never jolt. */
const GLIDE_MS = 1100
/** Tipping back from flat glides the view to the selection. Off for now:
 *  Brian found it didn't feel right (2026-10-30). F still frames. */
const GLIDE_ON_TILT = false
let glideRaf: number | null = null
function glideTo(from: { x: number; y: number }, to: { x: number; y: number }, W: number, H: number) {
  if (glideRaf !== null) cancelAnimationFrame(glideRaf)
  const start = performance.now()
  const tick = () => {
    const u = Math.min(1, (performance.now() - start) / GLIDE_MS)
    const k = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
    const z = useCanvasStore.getState().zoom
    const cx = from.x + (to.x - from.x) * k, cy = from.y + (to.y - from.y) * k
    useCanvasStore.getState().setPan({ x: W / 2 - cx * z, y: H / 2 - cy * z })
    glideRaf = u < 1 ? requestAnimationFrame(tick) : null
  }
  glideRaf = requestAnimationFrame(tick)
}

/** Alt+left-drag anywhere on the canvas host tilts it — over bare canvas
 *  or a card, a tile or a 3D Viewer, flat or already tilted. */
/** The two cameras (Brian's rules, 2026-11-04). The Alt-drag that leaves
 *  the flat view picks one, and it holds until the view is flat again:
 *  - '3d': started up or down. Up/down tips the view (all the way), side
 *    to side turns the ground like a turntable. Never swings, never peeks.
 *  - 'peek': started side to side over a deck or Viewer (utils/peek).
 *    Side to side swings round it, up/down tips a little (PEEK_TIP) to see
 *    over what is in the way on a crowded canvas, but never into the full
 *    tilted view, and the ground never turns. Alt on another deck or Viewer
 *    hops to it at the same turn.
 *  Started side to side over empty canvas: nothing, for now.
 *  Either way, let go near straight on and it settles flat (TILT_SNAP).
 *  Every Alt-drag goes through pickCamera and moveCamera, nothing else. */
type CamMode = '3d' | 'peek'
/** How far a peek can tip up or down, degrees. */
const PEEK_TIP = 20
function pickCamera(dx: number, dy: number, overPeek: boolean): CamMode | 'none' | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK_PX) return null
  if (Math.abs(dy) >= Math.abs(dx)) return '3d'
  return overPeek ? 'peek' : 'none'
}
/** Move the camera: `tilt` where the drag puts it, `d` degrees of turn. */
function moveCamera(mode: CamMode, tilt: number, d: number) {
  const s = useTiltStore.getState()
  if (mode === 'peek') s.setView(Math.max(-PEEK_TIP, Math.min(PEEK_TIP, tilt)), s.spin, s.yaw + d)
  else s.setView(tilt, s.spin - d, s.yaw)
}

// The camera picked by the drag that left the flat view (see above).
let camMode: CamMode | null = null

/** The six square-on views the view cube jumps to (Brian 2026-11-18),
 *  named by the side of the ground seen: its front is the bottom edge of
 *  the flat canvas, its top the flat view itself. */
export type CubeFace = 'TP' | 'FR' | 'BA' | 'LF' | 'RT' | 'BT'
/** Where each has the camera: tipped back to edge-on (TILT_MAX: exactly
 *  edge-on has no ground under the cursor) and the ground turned to bring
 *  that side round to the front. */
const FACE_VIEW: Record<Exclude<CubeFace, 'TP' | 'BT'>, number> = { FR: 0, RT: 90, BA: 180, LF: -90 }
let jumpRaf = 0
/** Jump the 3D view square on to a side: a short ease, about what the
 *  view turns about now. The top is the flat canvas: unlocked, that is
 *  the way home (as tipping up to it is); locked into 3D it is straight
 *  down with the models standing. */
export function jumpView(face: CubeFace) {
  cancelAnimationFrame(jumpRaf)
  const s0 = useTiltStore.getState()
  if (face === 'TP' && !s0.lock3d) { s0.flatten(); return }
  camMode = '3d'
  const tilt1 = face === 'TP' ? 0 : face === 'BT' ? TILT_UNDER : TILT_MAX
  const turn1 = face === 'TP' || face === 'BT' ? 0 : FACE_VIEW[face]
  const t0 = s0.tilt, y0 = s0.yaw
  // The short way round.
  const sp0 = s0.spin, dSpin = ((turn1 - sp0) % 360 + 540) % 360 - 180
  const start = performance.now()
  let last = { tilt: s0.tilt, spin: s0.spin }
  const tick = () => {
    const s = useTiltStore.getState()
    // The camera taken in hand meanwhile: it is the hand's.
    if (s.tilt !== last.tilt || s.spin !== last.spin) return
    const u = Math.min(1, (performance.now() - start) / 260)
    const k = 1 - Math.pow(1 - u, 3)
    s.setView(t0 + (tilt1 - t0) * k, u < 1 ? sp0 + dSpin * k : turn1, y0 * (1 - k), face === 'BT')
    const now = useTiltStore.getState()
    last = { tilt: now.tilt, spin: now.spin }
    if (u < 1) jumpRaf = requestAnimationFrame(tick)
  }
  jumpRaf = requestAnimationFrame(tick)
}

/** Degrees the view turns per px of a drag on the view cube: it is
 *  small, so across it is about a quarter turn. */
const CUBE_DEG = 1.2
/** Px a press on the cube moves before it is a drag, not a click. */
const CUBE_SLOP = 4
let cubeDragged = false
/** Did the press that just ended on the cube drag the camera? (Then its
 *  click is not a jump.) */
export const cubeWasDragged = () => cubeDragged
/** A press on the view cube that drags moves the camera (Brian
 *  2026-11-19: "If I drag the view cube, I should be dragging the
 *  camera"): the cube is held like the ground under an Alt-drag, so drag
 *  up tips the view back, drag sideways turns it. On the window, so it
 *  goes on through the flat view (where the cube is not shown) and back. */
export function dragCube(e: { clientX: number; clientY: number; button: number }) {
  cubeDragged = false
  if (e.button !== 0) return
  const x0 = e.clientX, y0 = e.clientY
  let last = { x: x0, y: y0 }
  const onMove = (ev: PointerEvent) => {
    if (!cubeDragged) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < CUBE_SLOP) return
      cubeDragged = true
      cancelAnimationFrame(jumpRaf)
      camMode = '3d'
      last = { x: ev.clientX, y: ev.clientY }
    }
    const s = useTiltStore.getState()
    s.setView(s.tilt - (ev.clientY - last.y) * CUBE_DEG, s.spin - (ev.clientX - last.x) * CUBE_DEG, 0)
    last = { x: ev.clientX, y: ev.clientY }
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onUp, true)
    if (!cubeDragged) return
    // Let go near straight on, it settles flat, as an Alt-drag does.
    const s = useTiltStore.getState()
    if (offFlat(s) < TILT_SNAP && !s.lock3d) s.flatten()
  }
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onUp, true)
}

/** Alt + a two-finger swipe on a trackpad moves the camera as an Alt-drag
 *  does (Brian 2026-11-22: no middle button on the laptop), by the same
 *  rules: the fingers stand in for the dragged mouse, the swipe for the
 *  drag, and it goes through pickCamera and moveCamera like every other.
 *  A swipe is over when the fingers have been still for SWIPE_END_MS, or
 *  Alt is let go. */
const SWIPE_END_MS = 220
type Swipe = {
  mode: CamMode | 'none' | null
  /** Where the fingers have got to since the swipe began, px. */
  x: number; y: number
  oy: number; t0: number; turned: number
  peek: ReturnType<typeof peekAt>
  pivoted: boolean
  timer: number
}
let swipe: Swipe | null = null
/** When the last wheel event of a camera swipe came: a trackpad goes on
 *  sending the swipe's coast after Alt is let go, and that tail is still
 *  the camera's, not a slide of the view. */
let swipeAt = -1e9
let altSwiped = false
const heard = new WeakSet<WheelEvent>()
function endSwipe() {
  if (!swipe) return
  clearTimeout(swipe.timer)
  swipe = null
  // Let go near straight on, it settles flat, as an Alt-drag does.
  const s = useTiltStore.getState()
  if (offFlat(s) < TILT_SNAP && !s.lock3d) s.flatten()
}
/** True when the wheel event was a camera swipe's (and is now spent). */
export function orbitWheel(e: WheelEvent): boolean {
  if (heard.has(e)) return true
  if (padWheel(e) !== 'pan') return false
  const eat = () => { heard.add(e); swipeAt = e.timeStamp; e.preventDefault(); e.stopImmediatePropagation() }
  if (!e.altKey) {
    // The coast of a swipe whose Alt was let go.
    if (e.timeStamp - swipeAt >= SWIPE_END_MS) return false
    eat()
    return true
  }
  const target = e.target as Element | null
  const host = hostOf(target)
  if (!host) return false
  if (target?.closest('input,textarea,select,[contenteditable="true"],[data-tilt-hud]')) return false
  eat()
  altSwiped = true
  if (!swipe) {
    const ts = useTiltStore.getState()
    // As a press: while flat it starts a new choice of camera.
    if (!isTilted(ts)) { camMode = null; ts.setPivot(null) }
    else if (!camMode) camMode = Math.abs(ts.yaw) > 0.5 ? 'peek' : '3d'
    const peek = camMode === '3d' ? null : peekAt(target, host)
    if (camMode === 'peek' && peek) usePeek.setState({ target: peek.target })
    swipe = { mode: camMode, x: 0, y: 0, oy: 0, t0: ts.tilt, turned: 0, peek, pivoted: false, timer: 0 }
  }
  const w = swipe
  clearTimeout(w.timer)
  w.timer = window.setTimeout(endSwipe, SWIPE_END_MS)
  // The view follows the fingers, as it follows the mouse.
  w.x -= e.deltaX; w.y -= e.deltaY
  if (w.mode === 'none') return true
  if (w.mode === null) {
    w.mode = pickCamera(w.x, w.y, !!w.peek)
    if (w.mode === null || w.mode === 'none') return true
    camMode = w.mode
    if (w.mode === 'peek' && w.peek) usePeek.setState({ target: w.peek.target })
    w.oy = w.y
  }
  const turnPx = Math.sign(w.x) * Math.max(0, Math.abs(w.x) - TURN_SLOP)
  const tilt = w.t0 - (w.y - w.oy) * DRAG_DEG
  const d = (turnPx - w.turned) * DRAG_DEG
  w.turned = turnPx
  if (w.mode === 'peek' && w.peek && !w.pivoted && (d || tilt !== w.t0)) { w.pivoted = true; useTiltStore.getState().setPivot(w.peek.g) }
  moveCamera(w.mode, tilt, d)
  return true
}

export function useAltTiltGesture() {
  useEffect(() => {
    let altUsed = false
    let swallowMenu = false
    let swallowClick = false
    // Alt is the camera and nothing else (Brian 2026-10-30): with it held,
    // a press anywhere on the canvas, cards and tiles included, only moves
    // the view. Nothing under it selects, drags or changes — 3D Viewers
    // included, whatever the button (Brian 2026-10-30: no outliers). The
    // HUD's buttons still work.
    const onDown = (e: PointerEvent) => {
      swallowClick = false
      if (!e.altKey) return
      const target = e.target as Element | null
      const host = hostOf(target)
      if (!host) return
      if (target?.closest('input,textarea,select,[contenteditable="true"],[data-tilt-hud]')) return
      if (e.button === 1) {
        // Tilted, Alt+middle is the 3D pan (TiltedView). Flat, a Viewer
        // would pan its own picture: the canvas pans instead, as it does
        // everywhere else.
        if (!target?.closest('[data-viewport3d]') || isTilted(useTiltStore.getState())) return
        e.preventDefault()
        e.stopImmediatePropagation()
        altUsed = true
        swallowClick = true
        let last = { x: e.clientX, y: e.clientY }
        const onMove = (ev: PointerEvent) => {
          ev.stopImmediatePropagation()
          useCanvasStore.getState().shiftPan(ev.clientX - last.x, ev.clientY - last.y)
          last = { x: ev.clientX, y: ev.clientY }
        }
        const onUp = (ev: PointerEvent) => {
          ev.stopImmediatePropagation()
          window.removeEventListener('pointermove', onMove, true)
          window.removeEventListener('pointerup', onUp, true)
        }
        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', onUp, true)
        return
      }
      if (e.button !== 0 && e.button !== 2) return
      e.preventDefault()
      e.stopImmediatePropagation()
      altUsed = true
      swallowClick = true
      if (e.button === 2) { dolly(e, host); swallowMenu = true; return }
      // Over a standing model, tilted, Alt+left turns the model itself,
      // freely, as a trackball (Brian 2026-11-04); the camera stays put.
      const onView = !!target?.closest('[data-tilt-stage]') || target === document.querySelector('[data-tilt-stage="world"]')?.parentElement
      const spun = isTilted(useTiltStore.getState()) && onView ? modelKey(models.pick?.(e.clientX, e.clientY)) : null
      // Not one standing in a 3D set (Brian 2026-11-12): there Alt is the
      // camera's alone, and a model is turned by its rotate handles.
      if (spun && !spun.startsWith('person|') && !standsIn(spun) && models.spin) {
        const spin = models.spin
        let last = { x: e.clientX, y: e.clientY }
        const onMove = (ev: PointerEvent) => {
          spin(spun, ev.clientX - last.x, ev.clientY - last.y, SPIN_RAD)
          last = { x: ev.clientX, y: ev.clientY }
        }
        // Let go, it drifts back to how it stood (Brian 2026-11-04).
        const onUp = () => {
          window.removeEventListener('pointermove', onMove, true)
          window.removeEventListener('pointerup', onUp, true)
          models.letGo?.(spun)
        }
        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', onUp, true)
        return
      }
      const { tilt: t0 } = useTiltStore.getState()
      let turned = 0
      const flat = !isTilted(useTiltStore.getState())
      // Which camera this drag moves: see pickCamera / moveCamera, the one
      // place the rules live. A press while flat starts a new choice.
      if (flat) { camMode = null; useTiltStore.getState().setPivot(null) }
      else if (!camMode) camMode = Math.abs(useTiltStore.getState().yaw) > 0.5 ? 'peek' : '3d'
      let mode: CamMode | 'none' | null = camMode
      // What under the press can be peeked into: from flat, a peek starts
      // there if the drag starts side to side; while peeking, pressing on
      // another deck or Viewer hops to it at the same turn. Never in 3D.
      const peek = mode === '3d' ? null : peekAt(target, host)
      if (mode === 'peek' && peek) usePeek.setState({ target: peek.target })
      let pivoted = false
      const x0 = e.clientX, y0 = e.clientY
      let oy = y0
      // Tipping back from flat with something selected makes it the pivot:
      // the view glides over to centre it while the plane tilts, wherever
      // on screen it was.
      const sel = GLIDE_ON_TILT && t0 < TILT_SNAP ? frameBox(true) : null
      const W = host.clientWidth, H = host.clientHeight
      const { pan, zoom } = useCanvasStore.getState()
      const cFrom = { x: (W / 2 - pan.x) / zoom, y: (H / 2 - pan.y) / zoom }
      const cTo = sel && { x: (sel.x0 + sel.x1) / 2, y: (sel.y0 + sel.y1) / 2 }
      let glideStarted = false
      // Orbit like Blender/Maya: you grab the near part of the ground —
      // drag up tips it away, drag right swings it right.
      const onMove = (ev: PointerEvent) => {
        if (mode === 'none') return
        if (mode === null) {
          mode = pickCamera(ev.clientX - x0, ev.clientY - y0, !!peek)
          if (mode === null || mode === 'none') return
          camMode = mode
          if (mode === 'peek' && peek) usePeek.setState({ target: peek.target })
          // Tilt counted from here, so nothing jumps when the camera is
          // picked (side to side already waits out TURN_SLOP from the press).
          oy = ev.clientY
        }
        // A little sideways slop while tipping must not turn the view:
        // turning starts only past a few px of real sideways drag.
        const dx = ev.clientX - x0
        const turnPx = Math.sign(dx) * Math.max(0, Math.abs(dx) - TURN_SLOP)
        const tilt = t0 - (ev.clientY - oy) * DRAG_DEG
        const d = (turnPx - turned) * DRAG_DEG
        turned = turnPx
        // A peek turns about the deck or Viewer it is into, taken when the
        // view first moves, so it stays put on screen.
        if (mode === 'peek' && peek && !pivoted && (d || tilt !== t0)) { pivoted = true; useTiltStore.getState().setPivot(peek.g) }
        moveCamera(mode, tilt, d)
        if (mode === '3d' && cTo && !glideStarted && useTiltStore.getState().tilt > 0.5) {
          glideStarted = true
          glideTo(cFrom, cTo, W, H)
        }
      }
      const onUp = (ev: PointerEvent) => {
        // The release is the camera's too: reaching the canvas, it took
        // the selection off (and the handles with it) when the press was
        // over bare ground, as it is under a model standing in a set.
        ev.stopImmediatePropagation()
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        // Locked into 3D it stays where it was let go (tiltStore lock3d).
        if (offFlat(useTiltStore.getState()) < TILT_SNAP && !useTiltStore.getState().lock3d) useTiltStore.getState().flatten()
      }
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
    }
    // Releasing Alt after a tilt must not pop the desktop app's menu bar.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') endSwipe()
      if (e.key === 'Alt' && (altUsed || altSwiped)) { e.preventDefault(); altUsed = false; altSwiped = false }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') { altUsed = false; altSwiped = false }
      if (e.key !== 'Escape' || !isTilted(useTiltStore.getState()) || useTiltStore.getState().lock3d) return
      const t = document.activeElement as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      useTiltStore.getState().flatten()
    }
    // Alt+right-drag zooms; the right button's context menu must not open
    // when it lets go.
    const onMenu = (e: MouseEvent) => {
      if (swallowMenu) { e.preventDefault(); e.stopPropagation(); swallowMenu = false }
    }
    // The click (and double-click) a camera press ends in reaches nothing;
    // the next press clears this.
    const onClick = (e: MouseEvent) => {
      if (!swallowClick) return
      e.preventDefault(); e.stopImmediatePropagation()
    }
    window.addEventListener('wheel', orbitWheel, { capture: true, passive: false })
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('contextmenu', onMenu, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('dblclick', onClick, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('wheel', orbitWheel, true)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('contextmenu', onMenu, true)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('dblclick', onClick, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])
}

/** How fast an Alt+right-drag zooms: the zoom's log per px. */
const DOLLY_RATE = 0.01
/** Alt+right-drag: zoom straight toward the middle of the view, flat or
 *  tilted (Maya's dolly) — right or up zooms in, left or down zooms out.
 *  Tilted, it scales the painted plane while the drag goes on, as the
 *  wheel does (tiltStore TiltGlide), and the canvas takes the zoom when
 *  the button is let go: changing the canvas zoom on every move painted
 *  every card again each time, far slower than the wheel (Brian
 *  2026-11-13). */
function dolly(e: PointerEvent, host: HTMLElement) {
  const c = viewCentre(host)
  if (!c) return
  const px = c.x, py = c.y
  let last = { x: e.clientX, y: e.clientY }
  // (A wheel zoom still easing owns the plane's scale: then as flat.)
  const ts0 = useTiltStore.getState()
  const glide = isTilted(ts0) && !ts0.glide
  const z0 = useCanvasStore.getState().zoom
  let k = 1, raf = 0
  const show = () => useTiltStore.getState().setGlide({ k, x: px - host.clientWidth / 2, y: py - host.clientHeight / 2 })
  const onMove = (ev: PointerEvent) => {
    const d = (ev.clientX - last.x) - (ev.clientY - last.y)
    last = { x: ev.clientX, y: ev.clientY }
    if (!d) return
    if (!glide) { useCanvasStore.getState().zoomAtPoint(Math.exp(d * DOLLY_RATE), px, py); return }
    k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z0 * k * Math.exp(d * DOLLY_RATE))) / z0
    // Once a frame, however many moves came in it.
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; show() })
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    if (!glide || (k === 1 && !useTiltStore.getState().glide)) return
    // The new zoom drawn now (flushSync), then the scale dropped, so the
    // same frame shows both and nothing jumps.
    flushSync(() => useCanvasStore.getState().zoomAtPoint(k, px, py))
    useTiltStore.getState().setGlide(null)
  }
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
}

/** Where the camera is looking: the flat-view point (px in the host) a
 *  zoom goes in and out about, straight along the middle of the view
 *  (Brian 2026-10-30), not toward the cursor. Tilted, it is the ground
 *  under the point the view turns about (tiltStore centrePoint: the middle
 *  of the screen, at the screen's own distance). It used to be the ground
 *  seen in the middle of the screen: from low down, after a small slide
 *  of the view, that is far off along the ground (or sky), and a click of
 *  the wheel about it threw the whole view (Brian 2026-11-12). */
export function viewCentre(host: HTMLElement): { x: number; y: number } | null {
  const W = host.clientWidth, H = host.clientHeight
  const ts = useTiltStore.getState()
  if (!isTilted(ts)) return { x: W / 2, y: H / 2 }
  const p = centrePoint(ts)
  return { x: p.x + W / 2, y: p.y + H / 2 }
}

type Rect = { x: number; y: number; w: number; h: number }

/** A card standing up on a storyline's wall (tilted): its foot (canvas
 *  y), how far up the wall its middle is (`d`, canvas units) and the
 *  wall's turn (`a`). Null on the floor. */
function onWall(id: string, r: Rect): { foot: number; d: number; a: number } | null {
  const ts = useTiltStore.getState()
  if (!isTilted(ts)) return null
  const g = useBoardsStore.getState().groups.find(x => x.id === id)
  const foot = storyWallOf(id) ?? (g?.deckAnchorId ? storyWallOf(g.deckAnchorId) : null)
  const a = Math.PI / 2 * standRise(ts)
  const d = foot === null ? 0 : foot - (r.y + r.h / 2)
  return foot !== null && a > 0 && d > 0 ? { foot, d, a } : null
}

/** Framed at `zoom`, the canvas rect the view centres on to show a card on
 *  a storyline's wall where it stands, not where it lies (Brian
 *  2026-11-05: F aimed at its spot on the floor): its middle, `h` up, is
 *  seen at the view's middle over the floor that far beyond it (tiltStore
 *  unprojectTilt at the middle, `h` up). */
function seenOnWall(id: string, r: Rect, zoom: number | undefined): Rect {
  const w = zoom === undefined ? null : onWall(id, r)
  if (!w || zoom === undefined) return r
  const ts = useTiltStore.getState()
  const q = unprojectTilt(0, 0, ts.tilt, ts.spin, 0, 0, w.d * Math.sin(w.a) * zoom)
  if (!q) return r
  return { ...r, x: r.x - q.x / zoom, y: w.foot - w.d * Math.cos(w.a) - r.h / 2 - q.y / zoom }
}

/** Canvas-unit bounds of the selected cards and tiles — or of everything
 *  on the canvas when nothing is selected. Pinned things never count.
 *  `zoom`: framed at that zoom, cards on a storyline's wall where seen. */
function frameBox(onlySelection = false, zoom?: number): { x0: number; y0: number; x1: number; y1: number; selected: boolean; near: number } | null {
  const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
  // How far toward the eye the nearest card up on a wall stands (canvas
  // units): seen nearer, it looks bigger, so it is framed a little wider.
  // Its middle is framed on the view's middle ray (seenOnWall), h up it
  // and so h / cos(tilt) along it toward the eye.
  let near = 0
  const ts0 = useTiltStore.getState()
  const along = Math.max(1e-3, Math.cos(ts0.tilt * Math.PI / 180) * Math.cos((ts0.yaw ?? 0) * Math.PI / 180))
  const pick = (nodeIds: string[], groupIds: string[]) => [
    ...nodeIds.map(id => fs.nodes[id]).filter(n => n && !n.pin).map(n => ({ x: n.x, y: n.y, w: n.width, h: n.height })),
    ...groupIds.filter(id => !bs.groups.find(g => g.id === id)?.pin).map(id => {
      const r = groupBounds(id)
      const w = r && onWall(id, r)
      if (w) near = Math.max(near, w.d * Math.sin(w.a) / along)
      return r && seenOnWall(id, r, zoom)
    }),
  ].filter((r): r is Rect => !!r)
  let rects = pick(fs.selectedIds, bs.selectedGroupIds)
  const selected = rects.length > 0
  if (!selected && !onlySelection) rects = pick(Object.keys(fs.nodes), bs.groups.map(g => g.id))
  if (!rects.length) return null
  return {
    x0: Math.min(...rects.map(r => r.x)), y0: Math.min(...rects.map(r => r.y)),
    x1: Math.max(...rects.map(r => r.x + r.w)), y1: Math.max(...rects.map(r => r.y + r.h)),
    selected, near,
  }
}

/** A framed model's orbit pivot (Brian 2026-11-07): F on a selected model
 *  card in 3D makes the model's middle the pivot (a point up off the
 *  ground, over where it stands), and it stays
 *  on that canvas point while the canvas pans or zooms under it. Let go
 *  when the view goes flat, on the next F, or when something else sets
 *  another pivot. */
let framed: { pivot: Pivot; unsub: () => void } | null = null
function dropFramed() {
  if (!framed) return
  framed.unsub()
  if (useTiltStore.getState().pivot === framed.pivot) useTiltStore.getState().setPivot(null)
  framed = null
}
/** `cz`: how far up, canvas units (it grows with the zoom, as the model does). */
function holdPivot(cx: number, cy: number, cz: number, W: number, H: number) {
  dropFramed()
  const place = (): Pivot => {
    const { pan, zoom } = useCanvasStore.getState()
    return { x: cx * zoom + pan.x - W / 2, y: cy * zoom + pan.y - H / 2, z: cz * zoom }
  }
  const pivot = place()
  useTiltStore.getState().setPivot(pivot)
  const f = { pivot, unsub: () => {} }
  const u1 = useCanvasStore.subscribe(() => {
    if (framed !== f) return
    const p = place()
    f.pivot = p
    useTiltStore.getState().setPivot(p)
  })
  const u2 = useTiltStore.subscribe(s => {
    if (framed !== f) return
    if (!isTilted(s) || s.pivot !== f.pivot) { framed.unsub(); framed = null }
  })
  f.unsub = () => { u1(); u2() }
  framed = f
}

/** The standing models of the selected cards and tiles, on screen (client
 *  px): the box round them all and the middle of the points they stand on. */
function selectedModelsBox() {
  if (!isTilted(useTiltStore.getState()) || !models.screenBox) return null
  const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
  const keys = [...fs.selectedIds.map(id => `node:${id}`), ...bs.selectedGroupIds.map(id => `card:${id}`)]
  const boxes = keys.map(k => models.screenBox!(k)).filter((b): b is NonNullable<typeof b> => !!b)
  if (!boxes.length) return null
  return {
    x0: Math.min(...boxes.map(b => b.x0)), y0: Math.min(...boxes.map(b => b.y0)),
    x1: Math.max(...boxes.map(b => b.x1)), y1: Math.max(...boxes.map(b => b.y1)),
    foot: { x: boxes.reduce((a, b) => a + b.foot.x, 0) / boxes.length, y: boxes.reduce((a, b) => a + b.foot.y, 0) / boxes.length },
  }
}

/** F on a selected model card in 3D: frame the MODEL, not its card: at
 *  the model's size, its middle (where it turns about, where its handles
 *  sit, lifted or not) in the middle of the view, and the orbit about that
 *  middle. Straight there (Brian 2026-11-09: the glide felt sluggish). */
function frameModel(host: HTMLElement): boolean {
  if (!isTilted(useTiltStore.getState()) || !models.pivotOf) return false
  const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
  const keys = [...fs.selectedIds.map(id => `node:${id}`), ...bs.selectedGroupIds.map(id => `card:${id}`)]
  const piv = keys.map(k => ({ k, p: models.pivotOf!(k) })).filter((x): x is { k: string; p: NonNullable<ReturnType<NonNullable<typeof models.pivotOf>>> } => !!x.p)
  const mb = selectedModelsBox()
  if (!piv.length || !mb) return false
  const W = host.clientWidth, H = host.clientHeight
  const { pan, zoom: zFrom } = useCanvasStore.getState()
  // Each model's middle: the canvas point under it and how high (canvas
  // units: the model grows with the zoom). One in a 3D scene stands where
  // the scene puts it, which can move with the zoom (a docked card's size
  // on screen), so that is read again at the new zoom.
  const mid = (zoom: number, p0: { x: number; y: number }) => piv.map(({ k, p }) => {
    const sp = sceneSpot(k)
    const up = (p.z - p.base) / zFrom
    return sp ? { x: sp.x, y: sp.y, h: sp.h + up } : { x: (p.u + W / 2 - p0.x) / zoom, y: (p.v + H / 2 - p0.y) / zoom, h: p.z / zFrom }
  })
  const avg = (l: { x: number; y: number; h: number }[]) => ({ x: l.reduce((a, q) => a + q.x, 0) / l.length, y: l.reduce((a, q) => a + q.y, 0) / l.length, h: l.reduce((a, q) => a + q.h, 0) / l.length })
  const m0 = avg(mid(zFrom, pan))
  // Framed, its foot is at the screen's own distance and its middle, `h`
  // up, stands `A` nearer the eye (per unit of zoom: it rises as the zoom
  // grows): h by how far the view is from side-on, where a thing's height
  // brings it no nearer. (It was h OVER that: nearly side-on the model
  // counted as a mile toward the eye and F backed far off to keep clear of
  // it, 16 times too far at the view cube's FR; Brian 2026-11-19, "it
  // zooms out super far".)
  const ts = useTiltStore.getState()
  const along = Math.max(0, Math.cos(ts.tilt * Math.PI / 180) * Math.cos((ts.yaw ?? 0) * Math.PI / 180))
  const P = tiltP(), A = m0.h * along
  // Its size now, canvas units, without what its distance does to it
  // where it stands now: near the eye it shows big and far off small, and
  // neither is its size.
  const grow = piv.reduce((a, { p }) => a + Math.max(0.05, depthShare({ x: p.u, y: p.v, z: p.z }, ts.tilt, ts.spin, ts.yaw)), 0) / piv.length
  const sw = (mb.x1 - mb.x0) / zFrom * grow, sh = (mb.y1 - mb.y0) / zFrom * grow
  // Shown at half the view (s·z·P/(P − A·z) = F), never past 0.6 of the
  // way to the eye.
  const fit = (F: number, sz: number) => F * P / (Math.max(sz, 1e-3) * P + F * A)
  const zTo = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, A > 0 ? 0.6 * P / A : Infinity, fit(W * 0.5, sw), fit(H * 0.5, sh)))
  dropFramed()
  // Card models keep their canvas point; scene models are read again at
  // the new zoom.
  const before = mid(zFrom, pan)
  useCanvasStore.setState({ zoom: zTo, pan: { x: W / 2 - m0.x * zTo, y: H / 2 - m0.y * zTo } })
  const after = mid(zTo, useCanvasStore.getState().pan)
  const m = avg(piv.map(({ k }, i) => (sceneSpot(k) ? after[i] : before[i])))
  const cx = m.x, cy = m.y, cz = m.h
  useCanvasStore.setState({ pan: { x: W / 2 - cx * zTo, y: H / 2 - cy * zTo } })
  holdPivot(cx, cy, cz, W, H)
  const to = shiftKeeping({ x: 0, y: 0, z: cz * zTo }, ts.tilt, ts.spin, ts.yaw)
  useTiltStore.getState().setShift(to.shiftX, to.shiftY)
  return true
}

/** The 3D sets among the selection: a set's ground selected, or its card
 *  while the set is out. With how high the tallest model standing in them
 *  reaches (canvas units), to frame a set with its models, not its ground
 *  alone (Brian 2026-11-12). */
function selectedSets(): { rects: Rect[]; top: number } | null {
  const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
  const ids = new Set<string>()
  for (const id of fs.selectedIds) if (fs.nodes[id]?.type === 'area' && !fs.nodes[id].pin) ids.add(id)
  for (const id of bs.selectedGroupIds) { const a = area3dOutOf(id); if (a && fs.nodes[a] && !fs.nodes[a].pin) ids.add(a) }
  if (!ids.size) return null
  const zoom = useCanvasStore.getState().zoom || 1
  let top = 0
  const keys = [...bs.groups.map(g => `card:${g.id}`), ...Object.values(fs.nodes).filter(n => n.type === 'model').map(n => `node:${n.id}`)]
  for (const k of keys) {
    const p = models.pivotOf?.(k)
    if (!p) continue
    const sc = sceneOf(k)
    if (!sc || !ids.has(sc.area.id)) continue
    // Its middle is (z - base) over its foot: its top as far again.
    const up = (p.z - p.base) / zoom
    top = Math.max(top, (sceneSpot(k)?.h ?? p.base / zoom) + 2 * up)
  }
  return { rects: [...ids].map(id => fs.nodes[id]).map(n => ({ x: n.x, y: n.y, w: n.width, h: n.height })), top }
}

/** F frames the selection — the cards and tiles selected — in the middle
 *  of the view, which is also the pivot the tilted view orbits about. With
 *  nothing selected, F frames everything on the canvas. Flat or tilted.
 *  Straight there, no glide (Brian 2026-11-09). */
export function useFrameKey() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'f' && e.key !== 'F') return
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      const t = document.activeElement as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const host = document.querySelector<HTMLElement>('[data-zoom-bar-host]')
      if (!host) return
      // (Tipped on past edge-on, looking up: framing is from over the
      // ground again.)
      const up = useTiltStore.getState()
      if (up.tilt > TILT_MAX) up.setView(80, up.spin, up.yaw)
      if (frameModel(host)) { e.preventDefault(); return }
      dropFramed()
      const box = frameBox()
      if (!box) return
      e.preventDefault()
      const W = host.clientWidth, H = host.clientHeight
      // A 3D set in 3D: the set with its models, aimed at the middle of
      // the box round them (half as high as the tallest), which the view
      // then turns about.
      const sets = isTilted(useTiltStore.getState()) && box.selected ? selectedSets() : null
      if (sets) {
        for (const r of sets.rects) { box.x0 = Math.min(box.x0, r.x); box.y0 = Math.min(box.y0, r.y); box.x1 = Math.max(box.x1, r.x + r.w); box.y1 = Math.max(box.y1, r.y + r.h) }
        const ts = useTiltStore.getState()
        const cz = sets.top / 2
        // (How much nearer the eye that middle is: see frameModel.)
        const along = Math.max(0, Math.cos(ts.tilt * Math.PI / 180) * Math.cos((ts.yaw ?? 0) * Math.PI / 180))
        const P = tiltP(), A = cz * along
        const fit = (F: number, sz: number) => F * P / (Math.max(sz, 1) * P + F * A)
        const zTo = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, A > 0 ? 0.6 * P / A : Infinity, fit(W * 0.38, box.x1 - box.x0), fit(H * 0.38, box.y1 - box.y0)))
        const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2
        useCanvasStore.setState({ zoom: zTo, pan: { x: W / 2 - cx * zTo, y: H / 2 - cy * zTo } })
        holdPivot(cx, cy, cz, W, H)
        const to = shiftKeeping({ x: 0, y: 0, z: cz * zTo }, ts.tilt, ts.spin, ts.yaw)
        useTiltStore.getState().setShift(to.shiftX, to.shiftY)
        return
      }
      const { x0, y0, x1, y1, selected } = box
      // Tilted, a model stands up out of its card: leave room above it.
      const fill = selected ? (isTilted(useTiltStore.getState()) ? 0.38 : 0.6) : 0.9
      // Seen `near` toward the eye, a size s shows s·z·P/(P − near·z): the
      // zoom that shows it at the size wanted (the plain W·fill/s at 0).
      const P = tiltP(), A = box.near
      const fit = (F: number, sz: number) => F * P / (Math.max(sz, 1) * P + F * A)
      // Never so near that the framed card reaches the eye.
      const zTo = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, A > 0 ? 0.95 * P / A : Infinity, Math.min(fit(W * fill, x1 - x0), fit(H * fill, y1 - y0))))
      // Aimed where the framed cards are seen at that zoom (seenOnWall).
      const at = frameBox(false, zTo) ?? box
      const cx = (at.x0 + at.x1) / 2, cy = (at.y0 + at.y1) / 2
      useCanvasStore.setState({ zoom: zTo, pan: { x: W / 2 - cx * zTo, y: H / 2 - cy * zTo } })
      // The camera comes back square on the framed thing too.
      const { shiftX, shiftY } = useTiltStore.getState()
      if (shiftX || shiftY) useTiltStore.getState().setShift(0, 0)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

/** The 3D view's lens is a focal length on the view's width (tiltStore
 *  lensMm): the store is told how wide the view is. */
export function useViewWidth() {
  useEffect(() => {
    const host = document.querySelector<HTMLElement>('[data-zoom-bar-host]')
    if (!host) return
    const tell = () => useTiltStore.getState().setViewW(host.clientWidth)
    tell()
    const ro = new ResizeObserver(tell)
    ro.observe(host)
    return () => ro.disconnect()
  }, [])
}

/** Back flat with the camera still moved sideways: that move is now just a
 *  slide of the flat canvas, so it becomes the canvas pan and the shift
 *  goes. The view does not move; nothing is remembered for next time. */
export function useShiftToPan() {
  useEffect(() => {
    // Handing over, the pan moving tells a framed model's pivot to follow
    // (holdPivot), which is heard here again before the shift is dropped:
    // the hand-over ran inside itself until the stack gave out, the pan
    // moved hundreds of times over (F on a model, then Esc: an error and
    // the canvas thrown far off). Once is all.
    let handing = false
    return useTiltStore.subscribe(s => {
    if (handing || s.tilt !== 0 || s.spin !== 0 || s.yaw !== 0 || (!s.shiftX && !s.shiftY)) return
    handing = true
    // The pan is drawn by React and the shift straight on the stage: draw
    // the new pan now (flushSync), then drop the shift, so the next frame
    // shows both changes together and the view does not move. Clearing the
    // shift here, not later, also stops a second store update moving the
    // pan twice.
    try {
      flushSync(() => useCanvasStore.getState().shiftPan(s.shiftX, s.shiftY))
      useTiltStore.getState().setShift(0, 0)
    } finally { handing = false }
    })
  }, [])
}
