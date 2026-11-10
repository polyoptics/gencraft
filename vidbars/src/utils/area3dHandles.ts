// area3dHandles.ts — the manipulator on a selected model in a 3D area's
// scene (three/tiltScene makeManip; Brian 2026-11-09: like Maya's). W
// move, E rotate, R scale (store/manipStore), on the world's axes or the
// model's own. Move: an arrow along its axis (up lifts it), the middle
// square on the camera's plane or, after a Ctrl-click on an arrow, on the
// plane across that axis. Rotate: a ring about its axis, the outer ring on
// the camera's plane. Scale: an axis box stretches, the middle sizes. All kept with the scene
// (tiltStore placeOf, poseOf, sizeOf) and undoable. Installed once when
// this module loads, so a press on a handle reaches nothing else (as
// utils/notesTool).

import { isTilted, useTiltStore, useModelScaleStore, type ScenePlace } from '../store/tiltStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { useCanvasStore } from '../store/canvasStore'
import { models } from '../components/Canvas/tilt/TiltModels'
import type { ManipHit } from '../three/tiltScene'
import { placeNow, dataKey, sceneOf } from './area3dScene'
import { useManip } from '../store/manipStore'

type Q = [number, number, number, number]
const mul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]

let drag: (ManipHit & { dk: string; x0: number; y0: number; a0: number; q0: Q; k0: number; s0: [number, number, number]; p0: ScenePlace; zoom: number }) | null = null
let hover: string | null = null
/** The click that ends a handle drag selects nothing. */
let eatClick = false
/** The release of a Ctrl-click on a handle reaches nothing either. */
let eatUp = false

function setCursor(c: string | null) {
  document.documentElement.style.cursor = c ?? ''
}
const cursorOf = (h: ManipHit) => h.part === 'f' ? 'crosshair' : h.part === 's' || h.part[0] === 's' ? 'nwse-resize' : h.part[0] === 'r' ? 'grab' : 'move'

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
  // Ctrl-click an arrow: the middle square moves on the plane across it.
  // Ctrl-click the square: back on the camera's plane.
  if (e.ctrlKey || e.metaKey) {
    if (g.part === 'mx' || g.part === 'my' || g.part === 'mz') useManip.getState().set({ plane: g.part[1] as 'x' | 'y' | 'z' })
    else if (g.part === 'mc') useManip.getState().set({ plane: 'cam' })
    eatUp = true
    return
  }
  const ms = useModelScaleStore.getState()
  const dk = dataKey(g.key)
  // Waiting on its card, not yet in the set: it can only be moved (onto it).
  if (!ms.placeOf[dk] && sceneOf(g.key)?.docked && g.part[0] !== 'm') { eatUp = true; return }
  useUndoCoordinator.getState().checkpoint()
  drag = {
    ...g, dk, x0: e.clientX, y0: e.clientY, a0: Math.atan2(e.clientY - g.c.y, e.clientX - g.c.x),
    q0: (ms.poseOf[dk] as Q | undefined) ?? [0, 0, 0, 1], k0: ms.setSizeOf[dk] ?? ms.sizeOf[dk] ?? 1,
    s0: ms.stretchOf[dk] ?? [1, 1, 1],
    p0: placeNow(g.key) ?? { dx: 0, dy: 0, h: 0 }, zoom: useCanvasStore.getState().zoom,
  }
  models.manipHot?.(g.key, g.part)
  setCursor(g.part[0] === 'r' ? 'grabbing' : cursorOf(g))
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
  if (p === 'f') {
    // A camera's focal point (Brian 2026-11-09): where it goes, the camera
    // looks, and its focus is how far that is. Across the floor; Shift
    // lifts or lowers it.
    const a = models.aimAt?.(d.key, e.clientX, e.clientY, e.shiftKey)
    if (a) { ms.setPose(d.dk, a.q); ms.setLens(d.dk, { focus: a.focus }) }
    return
  }
  if (p[0] === 'm') {
    // Along one axis, or on a plane: (mx, my) = a·dir1 + b·dir2.
    const ax = d.axes ?? []
    let co: number[] = []
    if (ax.length === 1) {
      const A = ax[0].dir, l2 = A.x * A.x + A.y * A.y
      co = [l2 > 1e-9 ? (mx * A.x + my * A.y) / l2 : 0]
    } else if (ax.length === 2) {
      const A = ax[0].dir, B = ax[1].dir
      const det = A.x * B.y - A.y * B.x
      if (Math.abs(det) < 1e-6) return
      co = [(mx * B.y - my * B.x) / det, (A.x * my - A.y * mx) / det]
    }
    const v = [0, 0, 0]
    ax.forEach((a, i) => { for (let j = 0; j < 3; j++) v[j] += a.v[j] * co[i] * k })
    ms.setPlace(d.dk, { dx: d.p0.dx + v[0], dy: d.p0.dy + v[2], h: Math.max(0, d.p0.h + v[1]) })
  } else if (p === 's') {
    // Right or up grows it, left or down shrinks it: twice as big per 120 px.
    ms.setSetSize(d.dk, Math.min(50, Math.max(0.02, d.k0 * 2 ** ((mx - my) / 120))))
  } else if (p[0] === 's') {
    // Stretch along one of its own axes: out along it grows, twice per 100 px.
    const t = mx * d.dir!.x + my * d.dir!.y
    const s: [number, number, number] = [...d.s0]
    s[d.k!] = Math.min(50, Math.max(0.02, d.s0[d.k!] * 2 ** (t / 100)))
    ms.setStretch(d.dk, s)
  } else {
    const ax = d.axis!
    let th = Math.atan2(e.clientY - d.c.y, e.clientX - d.c.x) - d.a0
    // Shift: in 15° steps.
    if (e.shiftKey) th = Math.round(th / (Math.PI / 12)) * (Math.PI / 12)
    th *= d.sign ?? 1
    const sn = Math.sin(th / 2)
    ms.setPose(d.dk, mul([ax[0] * sn, ax[1] * sn, ax[2] * sn, Math.cos(th / 2)], d.q0))
  }
}

/** W move, E rotate, R scale, in the 3D view (not while typing). */
function onKey(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
  const mode = e.code === 'KeyW' ? 'move' : e.code === 'KeyE' ? 'rotate' : e.code === 'KeyR' ? 'scale' : null
  if (!mode || !isTilted(useTiltStore.getState())) return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
  e.preventDefault(); e.stopImmediatePropagation()
  useManip.getState().set({ mode })
}

function onUp(e: PointerEvent) {
  if (eatUp) { eatUp = false; eatClick = true; e.preventDefault(); e.stopImmediatePropagation(); return }
  if (!drag) return
  e.preventDefault(); e.stopImmediatePropagation()
  // Moved back onto its own card (Brian 2026-11-10): out of the set, on
  // its card again, turning, as before it was put there.
  // (Let go with the pointer over that card, as it is seen.)
  if (drag.part[0] === 'm' && useModelScaleStore.getState().placeOf[drag.dk]) {
    const id = drag.key.slice(drag.key.indexOf(':') + 1)
    const el = document.querySelector(drag.key.startsWith('node:') ? `[data-freenode][data-id="${id}"]` : `[data-group-card][data-id="${id}"]`)
    const r = el?.getBoundingClientRect()
    if (r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) useModelScaleStore.getState().setPlace(drag.dk, null)
  }
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

type Handlers = { onDown: typeof onDown; onMove: typeof onMove; onUp: typeof onUp; onClick: typeof onClick; onKey: typeof onKey }
const w = (typeof window !== 'undefined' ? window : undefined) as (Window & { __area3dHandles?: Handlers }) | undefined
if (w) {
  const first = !w.__area3dHandles
  w.__area3dHandles = { onDown, onMove, onUp, onClick, onKey }
  if (first) {
    const h = () => w.__area3dHandles!
    w.addEventListener('pointerdown', e => h().onDown(e), true)
    w.addEventListener('pointermove', e => h().onMove(e), true)
    w.addEventListener('pointerup', e => h().onUp(e), true)
    w.addEventListener('pointercancel', e => h().onUp(e), true)
    w.addEventListener('click', e => h().onClick(e), true)
    w.addEventListener('keydown', e => h().onKey?.(e), true)
  }
}
