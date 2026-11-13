// LookThrough.tsx — cameras in a 3D scene (Brian 2026-11-09): a camera
// primitive's lens (focal length, frame shape), and looking through it.
// Looking through, the canvas is gone: the full 3D world as the camera
// sees it, framed by its gate. Drag to turn round its focal point, middle
// drag (or Shift-drag) to slide it, right drag or the wheel to move in and
// out; every move is the camera's own (kept with the scene, undoable).
// Esc or Exit goes back.

import React, { useEffect, useState } from 'react'
import { useManip } from '../../../store/manipStore'
import { useModelScaleStore, CAMERA_LENS, type CameraLens } from '../../../store/tiltStore'
import { useBoardsStore } from '../../../store/boardsStore'
import { useUndoCoordinator } from '../../../store/undoCoordinator'
import { useCanvasStore } from '../../../store/canvasStore'
import { CAMERA_URL } from '../../../three/primitives'
import { dataKey, placeNow } from '../../../utils/area3dScene'
import { useFreeNodeStore } from '../../../store/freeNodeStore'
import { models, cardModel, modelKey, selectModel } from './TiltModels'
import { useNotesStore, type Curve, type PathRider } from '../../../store/notesStore'
import { riderOf, rideSpots, rideTime, ridePointNow, ridePointTime, setRiderKey, useRideClock } from '../../../utils/pathRide'

/** The lens a new camera is made with (Brian 2026-11-12). One made before
 *  that, its lens never set, keeps tiltStore's CAMERA_LENS. */
export const NEW_CAMERA_MM = 80
/** The shortest and longest lens that can be typed in (mm). */
const MM_MIN = 4, MM_MAX = 2000
export const LENS_ASPECTS: [string, number][] = [['16:9', 16 / 9], ['2.39', 2.39], ['1.85', 1.85], ['4:3', 4 / 3], ['1:1', 1], ['9:16', 9 / 16]]

/** The selected camera's model key (as the 3D view keys it), if one is. */
export function useSelectedCamera(): string | null {
  const sel = useBoardsStore(s => s.selectedGroupIds)
  useBoardsStore(s => s.groups)
  const id = sel.find(i => cardModel(i)?.url === CAMERA_URL)
  return id ? `card:${id}` : null
}

const chip = (on: boolean): React.CSSProperties => ({
  padding: '3px 0', borderRadius: 6, fontSize: 11, cursor: 'pointer', textAlign: 'center',
  fontFamily: 'ui-monospace, monospace', color: on ? '#1b1e26' : 'rgba(255,255,255,0.75)',
  background: on ? '#ffe14a' : 'rgba(255,255,255,0.06)', border: `1px solid ${on ? '#ffe14a' : 'rgba(255,255,255,0.12)'}`,
})

const setLens = (key: string, l: Partial<CameraLens>) => {
  useUndoCoordinator.getState().checkpoint()
  useModelScaleStore.getState().setLens(dataKey(key), l)
}

/** A camera's focal length: a number typed in (Brian 2026-11-12: no
 *  preset buttons). Enter or clicking away sets it, Esc puts back what it
 *  was. */
export const LensField: React.FC<{ k: string; width?: number | string }> = ({ k, width = '100%' }) => {
  const mm = (useModelScaleStore(s => s.lensOf[dataKey(k)]) ?? CAMERA_LENS).mm
  const shown = String(Math.round(mm * 10) / 10)
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const v = draft === null ? NaN : parseFloat(draft.replace(',', '.'))
    setDraft(null)
    if (!Number.isFinite(v)) return
    const to = Math.max(MM_MIN, Math.min(MM_MAX, v))
    if (Math.abs(to - mm) > 1e-6) setLens(k, { mm: to })
  }
  return (
    <input type="text" inputMode="decimal" value={draft ?? shown} title="Lens, in mm: type a number"
      onChange={e => setDraft(e.target.value)} onFocus={e => e.target.select()} onBlur={commit}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        else if (e.key === 'Escape') { setDraft(null); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()) }
      }}
      style={{
        width, boxSizing: 'border-box', padding: '3px 6px', borderRadius: 6, fontSize: 11, fontFamily: 'ui-monospace, monospace',
        color: '#e8f0ff', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', outline: 'none',
      }} />
  )
}

/** A camera's lens: its focal length typed in, and its frame shape, one lit. */
export const LensChips: React.FC<{ k: string }> = ({ k }) => {
  const lens = useModelScaleStore(s => s.lensOf[dataKey(k)]) ?? CAMERA_LENS
  const view = Math.round((lens.view ?? 1) * 100)
  const label = (t: string) => <div style={{ fontSize: 10, letterSpacing: 1.3, color: 'rgba(255,255,255,0.4)', fontFamily: 'ui-monospace, monospace' }}>{t}</div>
  return (
    <>
      {label('LENS (MM)')}
      <LensField k={k} />
      {label('FRAME')}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
        {LENS_ASPECTS.map(([t, a]) => {
          const on = Math.abs(lens.aspect - a) < 1e-3
          return <button key={t} style={chip(on)} aria-pressed={on} onClick={() => setLens(k, { aspect: a })} title={`A ${t} frame`}>{t}</button>
        })}
      </div>
      {label(`VIEW SHAPE · ${view}%`)}
      <input type="range" min={5} max={100} step={5} value={view}
        title="How big the camera's yellow view shape is drawn. Only the drawing: the lens and what it sees stay the same"
        onPointerDown={() => useUndoCoordinator.getState().checkpoint()}
        onKeyDown={e => { if (!e.repeat) useUndoCoordinator.getState().checkpoint() }}
        onChange={e => useModelScaleStore.getState().setLens(dataKey(k), { view: +e.target.value / 100 })}
        style={{ width: '100%' }} />
    </>
  )
}

/** The Notes panel's camera controls, for the selected camera. */
export const CameraTools: React.FC = () => {
  const k = useSelectedCamera()
  const through = useManip(s => s.through)
  const target = useModelScaleStore(s => (k ? s.lensOf[dataKey(k)]?.target : undefined)) !== false
  if (!k) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
      <LensChips k={k} />
      <button style={{ ...chip(target), padding: '5px 0', fontFamily: 'inherit', fontSize: 12 }} aria-pressed={target}
        onClick={() => setLens(k, { target: !target })}
        title="Target: on or off. The yellow ball the camera looks at, and the line out to it, in the 3D view. Off only hides them: the camera looks where it did">Target</button>
      <button style={{ ...chip(through === k), padding: '5px 0', fontFamily: 'inherit', fontSize: 12 }} aria-pressed={through === k}
        onClick={() => useManip.getState().set({ through: through === k ? null : k })}
        title="See the 3D world through this camera (Esc comes back)">Look through</button>
    </div>
  )
}

/** The gate: where a frame of `aspect` sits in a W×H view (as tiltScene
 *  fits the camera: the whole frame, as big as it goes). */
function gateOf(W: number, H: number, aspect: number) {
  if (W / H >= aspect) { const w = H * aspect; return { x: (W - w) / 2, y: 0, w, h: H } }
  const h = W / aspect
  return { x: 0, y: (H - h) / 2, w: W, h }
}

// ── Moving the camera while looking through it ──

type Q = [number, number, number, number]
type V = { x: number; y: number; z: number }
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]
const qaxis = (ax: V, t: number): Q => { const s = Math.sin(t / 2); return [ax.x * s, ax.y * s, ax.z * s, Math.cos(t / 2)] }
const qrot = (q: Q, v: V): V => {
  const [x, y, z, w] = q
  const ix = w * v.x + y * v.z - z * v.y, iy = w * v.y + z * v.x - x * v.z, iz = w * v.z + x * v.y - y * v.x, iw = -x * v.x - y * v.y - z * v.z
  return { x: ix * w + iw * -x + iy * -z - iz * -y, y: iy * w + iw * -y + iz * -x - ix * -z, z: iz * w + iw * -z + ix * -y - iy * -x }
}

const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const mul = (a: V, t: number): V => ({ x: a.x * t, y: a.y * t, z: a.z * t })
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: V, b: V): V => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const UP: V = { x: 0, y: 1, z: 0 }

/** Radians of turn per px of drag: the 3D view's own rate (altCamera). */
const TURN_RAD = 0.25 * Math.PI / 180
/** How near straight up or down it tips: never over the top. */
const TIP_MAX = 85 * Math.PI / 180
/** The nearest its focal point comes (camera lengths). */
const FOCUS_MIN = 0.3

/** The camera as it stands: its middle P (what its place moves), its lens
 *  L, how it stands turned q, and its axes. Scene axes, ground px. */
type Cam = { P: V; L: V; q: Q; right: V; up: V; ahead: V }
type Start = Cam & {
  /** Riding a path, stopped on one of its points: moving the camera moves
   *  that point, turning it is its own turn there (utils/pathRide). */
  ride?: { curve: string; rider: string; i: number; T0: Q; pt: { x: number; y: number; z: number } }
  key: string; dk: string
  q0: Q; P0: V; p0: { dx: number; dy: number; h: number }; focus0: number; zoom: number
  F: V; k: number; floor: number
}
let held: (Start & { how: 'turn' | 'slide' | 'move'; x0: number; y0: number; button: number; moved: boolean }) | null = null
let wheelAt = 0

function start(key: string): Start | null {
  const cf = models.cameraFrame?.(key)
  const on = ridingAt(key)
  // (On a path it stands where the path has it, as high as the path is there.)
  const p0 = on ? { dx: 0, dy: 0, h: on.spot.z } : placeNow(key)
  if (!cf || !p0) return null
  const dk = dataKey(key)
  const ms = useModelScaleStore.getState()
  const q0 = (ms.poseOf[dk] as Q | undefined) ?? [0, 0, 0, 1]
  const pt = on ? on.curve.pts[on.i] : undefined
  return {
    ride: on && pt ? { curve: on.curve.id, rider: on.rider.key, i: on.i, T0: on.spot.q ?? [0, 0, 0, 1], pt: { x: pt.x, y: pt.y, z: pt.z ?? 0 } } : undefined,
    key, dk, q0, q: q0, p0, focus0: (ms.lensOf[dk] ?? CAMERA_LENS).focus,
    zoom: useCanvasStore.getState().zoom || 1,
    P: cf.pivot, P0: cf.pivot, L: cf.lens, F: cf.focal, right: cf.right, up: cf.up, ahead: cf.ahead, k: cf.k,
    // The floor: under its foot by how high it stands.
    floor: cf.base - p0.h * (useCanvasStore.getState().zoom || 1),
  }
}
/** The path camera `key` rides and the point of it it is stopped on, if
 *  it is on one. */
function ridingAt(key: string): { curve: Curve; rider: PathRider; i: number; spot: { x: number; y: number; z: number; q: Q | null } } | null {
  const r = riderOf(key) ?? riderOf(dataKey(key))
  if (!r) return null
  const at = ridePointNow(r.curve, r.rider)
  const spot = rideSpots().get(r.rider.key)
  return at.on && spot && !useRideClock.getState().playing ? { ...r, i: at.i, spot } : null
}
/** A camera on a path is reframed on its points: between two, or while it
 *  runs, the first touch stops it on the nearest one (true: it did, and
 *  that touch is spent). */
function parkOnPoint(key: string): boolean {
  const r = riderOf(key) ?? riderOf(dataKey(key))
  if (!r || ridingAt(key)) return false
  const clock = useRideClock.getState()
  clock.pause()
  clock.seek(ridePointTime(r.curve, r.rider, ridePointNow(r.curve, r.rider).i))
  return true
}
const qconj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]]

/** The camera turned by D about point F, all of a piece. */
const about = (c: Cam, F: V, D: Q): Cam => ({
  P: add(F, qrot(D, sub(c.P, F))), L: add(F, qrot(D, sub(c.L, F))), q: qmul(D, c.q),
  right: qrot(D, c.right), up: qrot(D, c.up), ahead: qrot(D, c.ahead),
})
/** Across its view, level with the floor. */
function levelRight(c: Cam): V {
  let r = cross(UP, c.ahead)
  if (dot(r, r) < 1e-6) r = { x: c.right.x, y: 0, z: c.right.z }
  const l = Math.hypot(r.x, r.y, r.z) || 1
  return mul(r, 1 / l)
}
/** Upside down (left that way by an earlier turn over the top): rolled
 *  back upright about the line it looks along. A lean it was given by
 *  hand, the right way up, is kept. */
function upright(c: Cam, F: V): Cam {
  const r = levelRight(c), u = cross(c.ahead, r)
  if (dot(c.up, u) >= 0) return c
  return about(c, F, qaxis(c.ahead, -Math.atan2(-dot(c.up, r), dot(c.up, u))))
}
/** Tipped by `tip` about F (+ looks further up, the camera coming down). */
const tipped = (c: Cam, F: V, tip: number) => about(c, F, qaxis(levelRight(c), -tip))
/** How high its foot stands (canvas units) with its middle at P. */
const footAt = (h: Start, P: V) => h.p0.h + (P.y - h.P0.y) / h.zoom
/** How far clear of the floor it is (ground px): its foot on or over it,
 *  its lens a little over it. Under 0 is into the floor. */
const clear = (h: Start, c: Cam) => Math.min(footAt(h, c.P) * h.zoom, c.L.y - h.floor - 0.08 * h.k)
/** Over the floor, or (one already into it) no further in than it was. */
const over = (h: Start, c: Cam) => clear(h, c) >= Math.min(0, clear(h, h)) - 1e-6
/** How far along a move (`at` 0 → 1) it can go and stay over the floor. */
function reach(h: Start, at: (t: number) => Cam) {
  if (over(h, at(1))) return 1
  let good = 0, bad = 1
  for (let i = 0; i < 18; i++) {
    const mid = (good + bad) / 2
    if (over(h, at(mid))) good = mid; else bad = mid
  }
  return good
}
/** The camera moved by `by` as it stands: down as far as the floor, and
 *  along it from there. */
function moved(h: Start, by: V): Cam {
  const c: Cam = { ...h, P: add(h.P, by), L: add(h.L, by) }
  const lift = Math.max(0, Math.min(0, clear(h, h)) - clear(h, c))
  return { ...c, P: { ...c.P, y: c.P.y + lift }, L: { ...c.L, y: c.L.y + lift } }
}
/** Put the camera where `c` has it. */
function put(h: Start, c: Cam, focus?: number) {
  const ms = useModelScaleStore.getState()
  const k = 1 / h.zoom
  if (h.ride) {
    // On a path: the point it stands on goes where it goes (scene axes:
    // y is up, z down the canvas), and how it is turned there is kept as
    // its own for that point.
    const ns = useNotesStore.getState()
    const cv = ns.curves[h.ride.curve]
    if (!cv) return
    const z = h.ride.pt.z + (c.P.y - h.P0.y) * k
    ns.updateCurve(cv.id, { pts: cv.pts.map((p, i) => i === h.ride!.i ? { ...p, x: h.ride!.pt.x + (c.P.x - h.P0.x) * k, y: h.ride!.pt.y + (c.P.z - h.P0.z) * k, z: Math.abs(z) > 1e-6 ? z : undefined } : p) })
    setRiderKey(cv.id, h.ride.rider, h.ride.i, qmul(qmul(c.q, qconj(h.q0)), h.ride.T0))
    // (The point moved, the path is another length: the clock goes to
    // where that point now is, so the camera stays stopped on it.)
    const now = riderOf(h.ride.rider)
    if (now) useRideClock.getState().seek(ridePointTime(now.curve, now.rider, h.ride.i))
    if (focus !== undefined) ms.setLens(h.dk, { focus })
    return
  }
  ms.setPlace(h.dk, { dx: h.p0.dx + (c.P.x - h.P0.x) * k, dy: h.p0.dy + (c.P.z - h.P0.z) * k, h: Math.max(0, footAt(h, c.P)) })
  ms.setPose(h.dk, c.q)
  if (focus !== undefined) ms.setLens(h.dk, { focus })
}
/** Ground px per screen px at the focal point. */
function pxScale(h: Start) {
  const lens = useModelScaleStore.getState().lensOf[h.dk] ?? CAMERA_LENS
  const r = models.root?.getBoundingClientRect()
  if (!r) return 1
  const g = gateOf(r.width, r.height, lens.aspect)
  // The frame's width at the focal point, over its width on screen.
  return (2 * h.focus0 * h.k * 18 / lens.mm) / g.w
}

const overView = (t: EventTarget | null) => {
  const el = t as Element | null
  return !!el?.closest?.('[data-zoom-bar-host]') && !el.closest('[data-look-hud],[data-notes-panel],[data-top-icon-bar]')
}

function onDown(e: PointerEvent) {
  const key = useManip.getState().through
  if (!key || !overView(e.target)) return
  e.preventDefault(); e.stopImmediatePropagation()
  if (parkOnPoint(key)) return
  const s = start(key)
  if (!s) return
  held = { ...s, how: e.button === 1 || (e.button === 0 && e.shiftKey) ? 'slide' : e.button === 2 ? 'move' : 'turn', x0: e.clientX, y0: e.clientY, button: e.button, moved: false }
}
function onMove(e: PointerEvent) {
  if (!held) return
  e.preventDefault(); e.stopImmediatePropagation()
  const h = held
  const dx = e.clientX - h.x0, dy = e.clientY - h.y0
  if (!h.moved) {
    // A press let go where it was is a click, not a move.
    if (Math.hypot(dx, dy) < 4) return
    h.moved = true
    useUndoCoordinator.getState().checkpoint()
  }
  if (h.how === 'turn') {
    // Round its focal point, as the 3D view turns (the near side of the
    // floor is what the drag holds): across swings it round the upright
    // through that point, up and down tips it. It stays the right way up,
    // stops short of straight up or down, and stops at the floor, so the
    // focal point never leaves where it is.
    const c = upright(h, h.F)
    const el0 = Math.asin(Math.max(-1, Math.min(1, c.ahead.y)))
    const el = Math.max(Math.min(-TIP_MAX, el0), Math.min(Math.max(TIP_MAX, el0), el0 - dy * TURN_RAD))
    const tip = (el - el0) * reach(h, t => tipped(c, h.F, (el - el0) * t))
    put(h, about(tipped(c, h.F, tip), h.F, qaxis(UP, -dx * TURN_RAD)))
  } else if (h.how === 'slide') {
    const s = pxScale(h)
    // What is under the cursor comes with it, across as well as up and
    // down (`right` is the camera's own right: the view's left).
    put(h, moved(h, add(mul(h.right, dx * s), mul(h.up, dy * s))))
  } else {
    dolly(h, 2 ** ((dy - dx) / 250))
  }
}
/** In or out along its view, its distance to the focal point × f. Up
 *  close the focal point goes on ahead of it, so it never sticks there;
 *  at the floor it goes on along it. */
function dolly(h: Start, f: number) {
  const go = Math.max(h.focus0, 1.5) * (1 - f)
  put(h, moved(h, mul(h.ahead, go * h.k)), Math.max(FOCUS_MIN, h.focus0 - go))
}
function onUp(e: PointerEvent) {
  if (!held) return
  e.preventDefault(); e.stopImmediatePropagation()
  const h = held
  held = null
  // A click on a model takes it (Shift adds), as in the 3D view: F then
  // frames it.
  if (h.moved || h.button !== 0 || e.altKey || e.type !== 'pointerup') return
  const key = modelKey(models.pick?.(e.clientX, e.clientY))
  if (key && key !== h.key && !key.startsWith('person|') && !key.startsWith('mini:')) selectModel(key, e.shiftKey)
}
/** F: the selected models (all of them when none is) in the middle of the
 *  frame, whole, the focal point at their middle, so turning is round
 *  them. It looks the way it was looking, lifted only if that would put
 *  it under the floor. */
function frame(key: string): boolean {
  if (parkOnPoint(key)) return false
  const h = start(key)
  if (!h) return false
  const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
  const sel = [...fs.selectedIds.map(id => `node:${id}`), ...bs.selectedGroupIds.map(id => `card:${id}`)].filter(k => k !== key)
  const b = (sel.length ? models.lookBounds?.(sel, key) : null) ?? models.lookBounds?.(null, key)
  if (!b) return false
  const lens = useModelScaleStore.getState().lensOf[h.dk] ?? CAMERA_LENS
  // Far enough back for the ball round them to sit inside the frame.
  const half = Math.atan(18 / lens.mm / Math.max(1, lens.aspect))
  const d = Math.max(FOCUS_MIN * h.k, b.r / Math.sin(half) * 1.1)
  const c0 = upright(h, h.F)
  const C: V = { x: b.centre.x, y: b.centre.y, z: b.centre.z }
  const shift = sub(sub(C, mul(c0.ahead, d)), c0.L)
  const c: Cam = { ...c0, P: add(c0.P, shift), L: add(c0.L, shift) }
  const el = Math.asin(Math.max(-1, Math.min(1, c.ahead.y)))
  // (Tipped from looking straight down, which is over the floor, back
  // toward the way it was looking.)
  const top = -TIP_MAX - el
  const tip = clear(h, c) >= 0 ? 0 : top * (1 - reach({ ...h, ...tipped(c, C, top) }, t => tipped(c, C, top * (1 - t))))
  useUndoCoordinator.getState().checkpoint()
  put(h, tip ? tipped(c, C, tip) : c, d / h.k)
  return true
}
function onWheel(e: WheelEvent) {
  const key = useManip.getState().through
  if (!key || !overView(e.target)) return
  e.preventDefault(); e.stopImmediatePropagation()
  if (parkOnPoint(key)) return
  const s = start(key)
  if (!s) return
  const now = performance.now()
  if (now - wheelAt > 600) useUndoCoordinator.getState().checkpoint()
  wheelAt = now
  dolly(s, 2 ** (Math.max(-120, Math.min(120, e.deltaY)) / 400))
}
function onEat(e: Event) {
  if (!useManip.getState().through || !overView(e.target)) return
  e.preventDefault(); e.stopImmediatePropagation()
}
function onKey(e: KeyboardEvent) {
  const key = useManip.getState().through
  if (!key) return
  // (A key typed into a field is the field's: Esc there puts its number back.)
  if ((e.target as Element | null)?.closest?.('input,textarea,select,[contenteditable="true"]')) return
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation()
    useManip.getState().set({ through: null })
    return
  }
  // F frames, as in the 3D view (not while typing).
  if ((e.key !== 'f' && e.key !== 'F') || e.ctrlKey || e.metaKey || e.altKey) return
  e.preventDefault(); e.stopImmediatePropagation()
  frame(key)
}

type Handlers = { onDown: typeof onDown; onMove: typeof onMove; onUp: typeof onUp; onWheel: typeof onWheel; onEat: typeof onEat; onKey: typeof onKey }
/** Installed once, ahead of the canvas's own listeners (main.tsx imports
 *  this first), so while looking through, a press is the camera's alone. */
export function installLookThrough() {
  const w = window as Window & { __lookThrough?: Handlers }
  const first = !w.__lookThrough
  w.__lookThrough = { onDown, onMove, onUp, onWheel, onEat, onKey }
  if (!first) return
  const h = () => w.__lookThrough!
  w.addEventListener('pointerdown', e => h().onDown(e), true)
  w.addEventListener('pointermove', e => h().onMove(e), true)
  w.addEventListener('pointerup', e => h().onUp(e), true)
  w.addEventListener('pointercancel', e => h().onUp(e), true)
  w.addEventListener('wheel', e => h().onWheel(e), { capture: true, passive: false })
  for (const t of ['click', 'dblclick', 'contextmenu', 'mousedown']) w.addEventListener(t, e => h().onEat(e), true)
  w.addEventListener('keydown', e => h().onKey(e), true)
}

/** Looking through a camera that rides a path (Brian 2026-11-12: "play
 *  through its animation, skip to the points, and then reposition the
 *  camera"): a bar to run its ride, step from point to point of the path
 *  and, stopped on one, set how the ride passes it. */
const RideBar: React.FC<{ k: string }> = ({ k }) => {
  const curves = useNotesStore(s => s.curves)
  const playing = useRideClock(s => s.playing)
  const base = useRideClock(s => s.base)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => tick(n => n + 1), 100)
    return () => window.clearInterval(id)
  }, [playing])
  void base
  const r = riderOf(k, curves) ?? riderOf(dataKey(k), curves)
  if (!r) return null
  const { curve: c, rider } = r
  const now = rideTime()
  const at = ridePointNow(c, rider, now)
  const on = at.on && !playing
  const n = c.pts.length
  const go = (i: number) => { const clock = useRideClock.getState(); clock.pause(); clock.seek(ridePointTime(c, rider, Math.max(0, Math.min(n - 1, i)))) }
  // Back: to the point it is on or has passed; on: to the next one.
  const tNear = ridePointTime(c, rider, at.i)
  const prev = on ? at.i - 1 : tNear < now ? at.i : at.i - 1
  const next = on ? at.i + 1 : tNear > now ? at.i : at.i + 1
  const pt = c.pts[at.i]
  const keyed = !!rider.keys?.[at.i]
  const step = () => useUndoCoordinator.getState().checkpoint()
  const b = (lit: boolean, dim = false): React.CSSProperties => ({ ...chip(lit), padding: '3px 9px', fontFamily: 'inherit', opacity: dim ? 0.4 : 1 })
  return (
    <div data-look-hud="" style={{
      position: 'absolute', top: 50, left: '50%', transform: 'translateX(-50%)', pointerEvents: 'auto',
      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 10, whiteSpace: 'nowrap',
      background: 'rgba(19,20,31,0.92)', border: '1px solid rgba(255,255,255,0.12)', color: '#e8f0ff', fontSize: 12,
    }}>
      <button style={b(playing)} aria-pressed={playing} title="Play: on or off. On, the camera rides its path (and everything else on a path rides too: one clock for all)."
        onClick={() => playing ? useRideClock.getState().pause() : useRideClock.getState().play()}>Play</button>
      <button style={b(false)} title="Back to the start of the ride" onClick={() => useRideClock.getState().seek(0)}>To start</button>
      <span style={{ width: 46, textAlign: 'right', fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'rgba(232,240,255,0.7)' }}>{now.toFixed(1)}s</span>
      <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.14)' }} />
      <button style={b(false, prev < 0)} disabled={prev < 0} title="Stop on the point before" onClick={() => go(prev)}>◀ Point</button>
      <span style={{ width: 78, textAlign: 'center', fontFamily: 'ui-monospace, monospace', fontSize: 11, color: on ? '#ffe14a' : 'rgba(232,240,255,0.45)' }}
        title={on ? 'Stopped on this point of the path: drag to reframe the camera here' : 'Between points: step to a point to reframe the camera there'}>{on ? `point ${at.i + 1} of ${n}` : 'between'}</span>
      <button style={b(false, next > n - 1)} disabled={next > n - 1} title="Stop on the next point" onClick={() => go(next)}>Point ▶</button>
      <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.14)' }} />
      <button style={b(on && !!pt?.slow, !on)} disabled={!on} aria-pressed={on && !!pt?.slow}
        title="Slow here: on or off, for the point it is stopped on. On, the ride slows into this point and gathers speed out of it."
        onClick={() => { step(); useNotesStore.getState().updateCurve(c.id, { pts: c.pts.map((p, i) => { if (i !== at.i) return p; const q = { ...p }; if (p.slow) delete q.slow; else q.slow = true; return q }) }) }}>Slow here</button>
      <button style={b(!!c.rideEase)} aria-pressed={!!c.rideEase} title="Ease: on or off, for the whole ride. On, it gathers speed leaving the start and slows into the end."
        onClick={() => { step(); useNotesStore.getState().updateCurve(c.id, { rideEase: c.rideEase ? undefined : true }) }}>Ease</button>
      <button style={b(false, !on || !keyed)} disabled={!on || !keyed} title="As the path has it: forget how the camera was turned by hand on this point, so it looks along the path here again"
        onClick={() => { step(); setRiderKey(c.id, rider.key, at.i, null) }}>Along path</button>
    </div>
  )
}

/** Looking through: the gate, and a bar with the lens and the way back. */
export const LookThrough: React.FC = () => {
  const key = useManip(s => s.through)
  const lens = useModelScaleStore(s => (key ? s.lensOf[dataKey(key)] : undefined)) ?? CAMERA_LENS
  const groups = useBoardsStore(s => s.groups)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    if (!key) return
    const el = models.root
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    // (It answers once as soon as it starts watching.)
    ro.observe(el)
    return () => ro.disconnect()
  }, [key])
  // Its card gone (deleted, folded away): back to the canvas.
  const id = key?.startsWith('card:') ? key.slice(5) : null
  const gone = !!id && !groups.some(g => g.id === id)
  useEffect(() => { if (gone) useManip.getState().set({ through: null }) }, [gone])
  if (!key || gone) return null
  const name = (id && groups.find(g => g.id === id)?.name) || 'Camera'
  const g = gateOf(box.w, box.h, lens.aspect)
  const shade = 'rgba(8,9,13,0.72)'
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 860, pointerEvents: 'none' }}>
      {/* The 3D bar is the canvas's: not while looking through. */}
      <style>{'[data-tilt-hud]{display:none !important}'}</style>
      {box.w > 0 && <>
        <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: g.y, background: shade }} />
        <div style={{ position: 'absolute', left: 0, top: g.y + g.h, width: '100%', bottom: 0, background: shade }} />
        <div style={{ position: 'absolute', left: 0, top: g.y, width: g.x, height: g.h, background: shade }} />
        <div style={{ position: 'absolute', left: g.x + g.w, top: g.y, right: 0, height: g.h, background: shade }} />
        <div style={{ position: 'absolute', left: g.x, top: g.y, width: g.w, height: g.h, boxShadow: 'inset 0 0 0 1px rgba(255,225,74,0.5)' }} />
      </>}
      <div data-look-hud="" style={{
        position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', pointerEvents: 'auto',
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 10,
        background: 'rgba(19,20,31,0.92)', border: '1px solid rgba(255,255,255,0.12)', color: '#e8f0ff', fontSize: 12,
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffe14a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="8" width="13" height="10" rx="2" /><path d="M15 11l6-3v10l-6-3" /><circle cx="6" cy="5" r="2.2" /><circle cx="12" cy="5" r="2.2" />
        </svg>
        <span style={{ fontWeight: 700, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'rgba(232,240,255,0.55)' }}>
          <LensField k={key} width={56} />mm
        </span>
        <span style={{ display: 'flex', gap: 3 }}>
          {LENS_ASPECTS.map(([t, a]) => {
            const on = Math.abs(lens.aspect - a) < 1e-3
            return <button key={t} style={{ ...chip(on), padding: '2px 6px' }} aria-pressed={on} onClick={() => setLens(key, { aspect: a })} title={`A ${t} frame`}>{t}</button>
          })}
        </span>
        <button style={{ ...chip(false), padding: '2px 10px', fontFamily: 'inherit' }} onClick={() => useManip.getState().set({ through: null })}
          title="Back to the canvas">Exit (Esc)</button>
      </div>
      <RideBar k={key} />
      <div style={{ position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)', fontSize: 11, color: 'rgba(232,240,255,0.55)', whiteSpace: 'nowrap' }}>
        Drag: turn round the focal point · Middle or Shift-drag: slide · Right-drag or wheel: in and out · Click a model, F frames it
        {(riderOf(key) ?? riderOf(dataKey(key))) ? ' · On a path: step to a point, then move the camera to set it there' : ''}
      </div>
    </div>
  )
}
