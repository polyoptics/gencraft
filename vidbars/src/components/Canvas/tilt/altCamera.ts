import { useEffect } from 'react'
import { flushSync } from 'react-dom'
import { useTiltStore, isTilted, offFlat, unprojectTilt, standRise, TILT_SNAP, TILT_PERSPECTIVE } from '../../../store/tiltStore'
import { storyWallOf } from '../StorylineLayer'
import { peekAt, usePeek } from '../../../utils/peek'
import { useCanvasStore, groupBounds, MIN_ZOOM, MAX_ZOOM } from '../../../store/canvasStore'
import { useFreeNodeStore } from '../../../store/freeNodeStore'
import { useBoardsStore } from '../../../store/boardsStore'
import { models, modelKey } from './TiltModels'

/** Degrees of tilt / turn per pixel of Alt+drag. */
const DRAG_DEG = 0.25
/** Sideways px an Alt+drag can wander before it starts turning the plane. */
const TURN_SLOP = 14
/** Px the drag that leaves the flat view moves before it picks the camera
 *  for that visit (see pickCamera). */
const LOCK_PX = 8
/** How far a model turns per px of Alt-drag on it (radians). */
const SPIN_RAD = 0.6 * Math.PI / 180

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

export function useAltTiltGesture() {
  useEffect(() => {
    let altUsed = false
    let swallowMenu = false
    let swallowClick = false
    // The camera picked by the drag that left the flat view (see below).
    let camMode: CamMode | null = null
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
      if (spun && !spun.startsWith('person|') && models.spin) {
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
      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        if (offFlat(useTiltStore.getState()) < TILT_SNAP) useTiltStore.getState().flatten()
      }
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
    }
    // Releasing Alt after a tilt must not pop the desktop app's menu bar.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && altUsed) { e.preventDefault(); altUsed = false }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altUsed = false
      if (e.key !== 'Escape' || !isTilted(useTiltStore.getState())) return
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
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('contextmenu', onMenu, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('dblclick', onClick, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('contextmenu', onMenu, true)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('dblclick', onClick, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])
}

/** Alt+right-drag: zoom straight toward the middle of the view, flat or
 *  tilted (Maya's dolly) — right or up zooms in, left or down zooms out. */
function dolly(e: PointerEvent, host: HTMLElement) {
  const c = viewCentre(host)
  if (!c) return
  const px = c.x, py = c.y
  let last = { x: e.clientX, y: e.clientY }
  const onMove = (ev: PointerEvent) => {
    const d = (ev.clientX - last.x) - (ev.clientY - last.y)
    last = { x: ev.clientX, y: ev.clientY }
    if (d) useCanvasStore.getState().zoomAtPoint(Math.exp(d * 0.006), px, py)
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
  }
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
}

/** Where the camera is looking: the flat-view point (px in the host) at the
 *  middle of the screen. Zooming goes straight in and out along that line
 *  (Brian 2026-10-30), not toward the cursor. */
export function viewCentre(host: HTMLElement): { x: number; y: number } | null {
  const W = host.clientWidth, H = host.clientHeight
  const { tilt, yaw, spin, shiftX, shiftY } = useTiltStore.getState()
  if (!isTilted({ tilt, yaw })) return { x: W / 2, y: H / 2 }
  const p = unprojectTilt(0, 0, tilt, spin, shiftX, shiftY)
  return p && { x: p.x + W / 2, y: p.y + H / 2 }
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

/** F frames the selection — the cards and tiles selected — in the middle
 *  of the view, which is also the pivot the tilted view orbits about. With
 *  nothing selected, F frames everything on the canvas. Flat or tilted. */
export function useFrameKey() {
  useEffect(() => {
    let raf: number | null = null
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'f' && e.key !== 'F') return
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      const t = document.activeElement as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const host = document.querySelector<HTMLElement>('[data-zoom-bar-host]')
      if (!host) return
      const box = frameBox()
      if (!box) return
      e.preventDefault()
      const { x0, y0, x1, y1, selected } = box
      const W = host.clientWidth, H = host.clientHeight
      // Tilted, a model stands up out of its card: leave room above it.
      const fill = selected ? (isTilted(useTiltStore.getState()) ? 0.38 : 0.6) : 0.9
      // Seen `near` toward the eye, a size s shows s·z·P/(P − near·z): the
      // zoom that shows it at the size wanted (the plain W·fill/s at 0).
      const P = TILT_PERSPECTIVE, A = box.near
      const fit = (F: number, sz: number) => F * P / (Math.max(sz, 1) * P + F * A)
      // Never so near that the framed card reaches the eye.
      const zTo = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, A > 0 ? 0.95 * P / A : Infinity, Math.min(fit(W * fill, x1 - x0), fit(H * fill, y1 - y0))))
      // Aimed where the framed cards are seen at that zoom (seenOnWall).
      const at = frameBox(false, zTo) ?? box
      const cTo = { x: (at.x0 + at.x1) / 2, y: (at.y0 + at.y1) / 2 }
      const { pan, zoom: zFrom } = useCanvasStore.getState()
      const cFrom = { x: (W / 2 - pan.x) / zFrom, y: (H / 2 - pan.y) / zFrom }
      // The camera comes back square on the framed thing too.
      const { shiftX: sx0, shiftY: sy0 } = useTiltStore.getState()
      // Glide: the centre moves straight, the zoom evenly in notches.
      if (raf !== null) cancelAnimationFrame(raf)
      const start = performance.now()
      const tick = () => {
        const u = Math.min(1, (performance.now() - start) / GLIDE_MS)
        const k = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
        const z = Math.exp(Math.log(zFrom) + (Math.log(zTo) - Math.log(zFrom)) * k)
        const cx = cFrom.x + (cTo.x - cFrom.x) * k, cy = cFrom.y + (cTo.y - cFrom.y) * k
        useCanvasStore.setState({ zoom: z, pan: { x: W / 2 - cx * z, y: H / 2 - cy * z } })
        if (sx0 || sy0) useTiltStore.getState().setShift(sx0 * (1 - k), sy0 * (1 - k))
        raf = u < 1 ? requestAnimationFrame(tick) : null
      }
      raf = requestAnimationFrame(tick)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown); if (raf !== null) cancelAnimationFrame(raf) }
  }, [])
}

/** Back flat with the camera still moved sideways: that move is now just a
 *  slide of the flat canvas, so it becomes the canvas pan and the shift
 *  goes. The view does not move; nothing is remembered for next time. */
export function useShiftToPan() {
  useEffect(() => useTiltStore.subscribe(s => {
    if (s.tilt !== 0 || s.spin !== 0 || s.yaw !== 0 || (!s.shiftX && !s.shiftY)) return
    // The pan is drawn by React and the shift straight on the stage: draw
    // the new pan now (flushSync), then drop the shift, so the next frame
    // shows both changes together and the view does not move. Clearing the
    // shift here, not later, also stops a second store update moving the
    // pan twice.
    flushSync(() => useCanvasStore.getState().shiftPan(s.shiftX, s.shiftY))
    useTiltStore.getState().setShift(0, 0)
  }), [])
}
