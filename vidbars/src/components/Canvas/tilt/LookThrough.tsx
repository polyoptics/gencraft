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
import { models, cardModel } from './TiltModels'

export const LENS_MM = [18, 24, 35, 50, 85, 135] as const
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

/** A camera's lens: focal length and frame shape, one lit of each. */
export const LensChips: React.FC<{ k: string }> = ({ k }) => {
  const lens = useModelScaleStore(s => s.lensOf[dataKey(k)]) ?? CAMERA_LENS
  const label = (t: string) => <div style={{ fontSize: 10, letterSpacing: 1.3, color: 'rgba(255,255,255,0.4)', fontFamily: 'ui-monospace, monospace' }}>{t}</div>
  return (
    <>
      {label('LENS (MM)')}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
        {LENS_MM.map(mm => <button key={mm} style={chip(lens.mm === mm)} aria-pressed={lens.mm === mm} onClick={() => setLens(k, { mm })} title={`${mm} mm lens`}>{mm}</button>)}
      </div>
      {label('FRAME')}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
        {LENS_ASPECTS.map(([t, a]) => {
          const on = Math.abs(lens.aspect - a) < 1e-3
          return <button key={t} style={chip(on)} aria-pressed={on} onClick={() => setLens(k, { aspect: a })} title={`A ${t} frame`}>{t}</button>
        })}
      </div>
    </>
  )
}

/** The Notes panel's camera controls, for the selected camera. */
export const CameraTools: React.FC = () => {
  const k = useSelectedCamera()
  const through = useManip(s => s.through)
  if (!k) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
      <LensChips k={k} />
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

type Start = {
  key: string; dk: string
  q0: Q; p0: { dx: number; dy: number; h: number }; focus0: number; zoom: number
  P: V; F: V; right: V; up: V; ahead: V; k: number
}
let held: (Start & { how: 'turn' | 'slide' | 'move'; x0: number; y0: number }) | null = null
let wheelAt = 0

function start(key: string): Start | null {
  const cf = models.cameraFrame?.(key)
  const p0 = placeNow(key)
  if (!cf || !p0) return null
  const dk = dataKey(key)
  const ms = useModelScaleStore.getState()
  return {
    key, dk, q0: (ms.poseOf[dk] as Q | undefined) ?? [0, 0, 0, 1], p0, focus0: (ms.lensOf[dk] ?? CAMERA_LENS).focus,
    zoom: useCanvasStore.getState().zoom || 1,
    P: cf.pivot, F: cf.focal, right: cf.right, up: cf.up, ahead: cf.ahead, k: cf.k,
  }
}
/** Put the camera at pivot P (scene axes, ground px), turned q. */
function put(h: Start, P: V, q: Q, focus?: number) {
  const ms = useModelScaleStore.getState()
  const k = 1 / h.zoom
  ms.setPlace(h.dk, { dx: h.p0.dx + (P.x - h.P.x) * k, dy: h.p0.dy + (P.z - h.P.z) * k, h: Math.max(0, h.p0.h + (P.y - h.P.y) * k) })
  ms.setPose(h.dk, q)
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
  const s = start(key)
  if (!s) return
  useUndoCoordinator.getState().checkpoint()
  held = { ...s, how: e.button === 1 || (e.button === 0 && e.shiftKey) ? 'slide' : e.button === 2 ? 'move' : 'turn', x0: e.clientX, y0: e.clientY }
}
function onMove(e: PointerEvent) {
  if (!held) return
  e.preventDefault(); e.stopImmediatePropagation()
  const h = held
  const dx = e.clientX - h.x0, dy = e.clientY - h.y0
  if (h.how === 'turn') {
    // Round its focal point: across turns it about the up, up and down
    // tips it (never over the top).
    const yaw = qaxis({ x: 0, y: 1, z: 0 }, -dx * 0.006)
    let pitch: Q = qaxis(h.right, -dy * 0.006)
    const a = qrot(qmul(yaw, pitch), h.ahead)
    if (Math.abs(a.y) > 0.985) pitch = [0, 0, 0, 1]
    const D = qmul(yaw, pitch)
    const r = qrot(D, { x: h.P.x - h.F.x, y: h.P.y - h.F.y, z: h.P.z - h.F.z })
    put(h, { x: h.F.x + r.x, y: h.F.y + r.y, z: h.F.z + r.z }, qmul(D, h.q0))
  } else if (h.how === 'slide') {
    const s = pxScale(h)
    const m = (v: V, t: number) => ({ x: v.x * t, y: v.y * t, z: v.z * t })
    const a = m(h.right, -dx * s), b = m(h.up, dy * s)
    put(h, { x: h.P.x + a.x + b.x, y: h.P.y + a.y + b.y, z: h.P.z + a.z + b.z }, h.q0)
  } else {
    dolly(h, 2 ** ((dy - dx) / 250))
  }
}
/** In or out along its view: the focal point stays, its distance × f. */
function dolly(h: Start, f: number) {
  const focus = Math.max(0.3, h.focus0 * f)
  const go = (h.focus0 - focus) * h.k
  put(h, { x: h.P.x + h.ahead.x * go, y: h.P.y + h.ahead.y * go, z: h.P.z + h.ahead.z * go }, h.q0, focus)
}
function onUp(e: PointerEvent) {
  if (!held) return
  e.preventDefault(); e.stopImmediatePropagation()
  held = null
}
function onWheel(e: WheelEvent) {
  const key = useManip.getState().through
  if (!key || !overView(e.target)) return
  e.preventDefault(); e.stopImmediatePropagation()
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
  if (e.key !== 'Escape' || !useManip.getState().through) return
  e.preventDefault(); e.stopImmediatePropagation()
  useManip.getState().set({ through: null })
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
        <span style={{ display: 'flex', gap: 3 }}>
          {LENS_MM.map(mm => <button key={mm} style={{ ...chip(lens.mm === mm), padding: '2px 6px' }} aria-pressed={lens.mm === mm} onClick={() => setLens(key, { mm })} title={`${mm} mm lens`}>{mm}</button>)}
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
      <div style={{ position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)', fontSize: 11, color: 'rgba(232,240,255,0.55)', whiteSpace: 'nowrap' }}>
        Drag: turn round the focal point · Middle or Shift-drag: slide · Right-drag or wheel: in and out
      </div>
    </div>
  )
}
