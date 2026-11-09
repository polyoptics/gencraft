// area3dHandles.ts — the manipulator on a selected model in a 3D area's
// scene (three/tiltScene makeManip; Brian 2026-11-09: like Maya's). Drag
// an arrow to move the model along that axis (up lifts it off the
// ground), the square to move it on the ground, a ring to turn it about
// that axis, the middle box to size it. All kept with the scene
// (tiltStore placeOf, poseOf, sizeOf) and undoable. Installed once when
// this module loads, so a press on a handle reaches nothing else (as
// utils/notesTool).

import { isTilted, useTiltStore, useModelScaleStore, type ScenePlace } from '../store/tiltStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { useCanvasStore } from '../store/canvasStore'
import { models } from '../components/Canvas/tilt/TiltModels'
import type { ManipHit } from '../three/tiltScene'
import { placeNow } from './area3dScene'

type Q = [number, number, number, number]
const mul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]
const AXIS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as const

let drag: (ManipHit & { x0: number; y0: number; a0: number; d0: number; q0: Q; k0: number; p0: ScenePlace; zoom: number }) | null = null
let hover: string | null = null
/** The click that ends a handle drag selects nothing. */
let eatClick = false

function setCursor(c: string | null) {
  document.documentElement.style.cursor = c ?? ''
}
const cursorOf = (h: ManipHit) => h.part === 's' ? 'nwse-resize' : h.part.startsWith('r') ? 'grab' : 'move'

function hit(e: PointerEvent) {
  if (!models.gizmoAt || !isTilted(useTiltStore.getState())) return null
  return models.gizmoAt(e.clientX, e.clientY)
}

function onDown(e: PointerEvent) {
  if (!e.isTrusted || e.button !== 0 || e.altKey) return
  const t = e.target as Element | null
  if (t?.closest?.('[data-notes-panel],[data-top-icon-bar],[data-tilt-hud]')) return
  const g = hit(e)
  if (!g) return
  e.preventDefault(); e.stopImmediatePropagation()
  useUndoCoordinator.getState().checkpoint()
  const ms = useModelScaleStore.getState()
  const dx = e.clientX - g.c.x, dy = e.clientY - g.c.y
  drag = {
    ...g, x0: e.clientX, y0: e.clientY, a0: Math.atan2(dy, dx), d0: Math.max(4, Math.hypot(dx, dy)),
    q0: (ms.poseOf[g.key] as Q | undefined) ?? [0, 0, 0, 1], k0: ms.sizeOf[g.key] ?? 1,
    p0: placeNow(g.key) ?? { dx: 0, dy: 0, h: 0 }, zoom: useCanvasStore.getState().zoom,
  }
  models.manipHot?.(g.key, g.part)
  setCursor(g.part.startsWith('r') ? 'grabbing' : cursorOf(g))
}

/** How far a screen move (mx, my) goes along screen direction `d` (px per
 *  ground px): ground px. */
const along = (mx: number, my: number, d: { x: number; y: number }) => {
  const l2 = d.x * d.x + d.y * d.y
  return l2 > 1e-9 ? (mx * d.x + my * d.y) / l2 : 0
}

function onMove(e: PointerEvent) {
  if (!drag) {
    // Over a handle: light it, and say so with the cursor.
    const g = e.buttons ? null : hit(e)
    const k = g ? `${g.key}|${g.part}` : null
    if (k !== hover) {
      hover = k
      models.manipHot?.(g?.key ?? null, g?.part ?? null)
      setCursor(g ? cursorOf(g) : null)
    }
    return
  }
  e.preventDefault(); e.stopImmediatePropagation()
  const d = drag
  const ms = useModelScaleStore.getState()
  const mx = e.clientX - d.x0, my = e.clientY - d.y0
  // Ground px → canvas units.
  const k = 1 / (d.zoom || 1)
  const p = d.part
  if (p === 'mx' || p === 'my' || p === 'mz') {
    const t = along(mx, my, d.dir!) * k
    ms.setPlace(d.key, {
      dx: d.p0.dx + (p === 'mx' ? t : 0),
      dy: d.p0.dy + (p === 'mz' ? t : 0),
      h: Math.max(0, d.p0.h + (p === 'my' ? t : 0)),
    })
  } else if (p === 'mxz') {
    // Solve (mx, my) = a·dir + b·dir2.
    const A = d.dir!, B = d.dir2!
    const det = A.x * B.y - A.y * B.x
    if (Math.abs(det) < 1e-9) return
    const a = (mx * B.y - my * B.x) / det, b = (A.x * my - A.y * mx) / det
    ms.setPlace(d.key, { dx: d.p0.dx + a * k, dy: d.p0.dy + b * k, h: d.p0.h })
  } else if (p === 's') {
    // Right or up grows it, left or down shrinks it: twice as big per 120 px.
    ms.setSize(d.key, Math.min(50, Math.max(0.02, d.k0 * 2 ** ((mx - my) / 120))))
  } else {
    const ax = AXIS[p[1] as 'x' | 'y' | 'z']
    let th = Math.atan2(e.clientY - d.c.y, e.clientX - d.c.x) - d.a0
    // Shift: in 15° steps.
    if (e.shiftKey) th = Math.round(th / (Math.PI / 12)) * (Math.PI / 12)
    th *= d.sign ?? 1
    const sn = Math.sin(th / 2)
    ms.setPose(d.key, mul([ax[0] * sn, ax[1] * sn, ax[2] * sn, Math.cos(th / 2)], d.q0))
  }
}

function onUp(e: PointerEvent) {
  if (!drag) return
  e.preventDefault(); e.stopImmediatePropagation()
  drag = null
  hover = null
  models.manipHot?.(null, null)
  setCursor(null)
  eatClick = true
}

function onClick(e: MouseEvent) {
  if (!eatClick) return
  eatClick = false
  e.preventDefault(); e.stopImmediatePropagation()
}

type Handlers = { onDown: typeof onDown; onMove: typeof onMove; onUp: typeof onUp; onClick: typeof onClick }
const w = (typeof window !== 'undefined' ? window : undefined) as (Window & { __area3dHandles?: Handlers }) | undefined
if (w) {
  const first = !w.__area3dHandles
  w.__area3dHandles = { onDown, onMove, onUp, onClick }
  if (first) {
    const h = () => w.__area3dHandles!
    w.addEventListener('pointerdown', e => h().onDown(e), true)
    w.addEventListener('pointermove', e => h().onMove(e), true)
    w.addEventListener('pointerup', e => h().onUp(e), true)
    w.addEventListener('pointercancel', e => h().onUp(e), true)
    w.addEventListener('click', e => h().onClick(e), true)
  }
}
