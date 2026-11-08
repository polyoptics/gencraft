// area3dHandles.ts — the handles round a selected model standing on a 3D
// area (three/tiltScene makeGizmo): drag the ring to turn it about its up
// axis, drag the knob on the ring out or in to size it. Both are kept (the
// area's layout) and undoable. Installed once when this module loads, so a
// press on a handle reaches nothing else (as utils/notesTool).

import { isTilted, useTiltStore, useModelScaleStore } from '../store/tiltStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { models } from '../components/Canvas/tilt/TiltModels'

type Q = [number, number, number, number]
const mul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]

let drag: { key: string; part: 'turn' | 'size'; foot: { x: number; y: number }; sign: number; a0: number; d0: number; q0: Q; k0: number } | null = null
let hoverCursor = false
/** The click that ends a handle drag selects nothing. */
let eatClick = false

function setCursor(c: string | null) {
  document.documentElement.style.cursor = c ?? ''
}

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
  const dx = e.clientX - g.foot.x, dy = e.clientY - g.foot.y
  drag = { ...g, a0: Math.atan2(dy, dx), d0: Math.max(4, Math.hypot(dx, dy)), q0: (ms.poseOf[g.key] as Q | undefined) ?? [0, 0, 0, 1], k0: ms.sizeOf[g.key] ?? 1 }
  setCursor(g.part === 'turn' ? 'grabbing' : 'nwse-resize')
}

function onMove(e: PointerEvent) {
  if (!drag) {
    // Over a handle: say so with the cursor.
    const g = e.buttons ? null : hit(e)
    if (g) { setCursor(g.part === 'turn' ? 'grab' : 'nwse-resize'); hoverCursor = true }
    else if (hoverCursor) { setCursor(null); hoverCursor = false }
    return
  }
  e.preventDefault(); e.stopImmediatePropagation()
  const dx = e.clientX - drag.foot.x, dy = e.clientY - drag.foot.y
  const ms = useModelScaleStore.getState()
  if (drag.part === 'turn') {
    const th = (Math.atan2(dy, dx) - drag.a0) * drag.sign
    const r: Q = [0, Math.sin(th / 2), 0, Math.cos(th / 2)]
    ms.setPose(drag.key, mul(r, drag.q0))
  } else {
    const k = drag.k0 * Math.max(4, Math.hypot(dx, dy)) / drag.d0
    ms.setSize(drag.key, Math.min(50, Math.max(0.02, k)))
  }
}

function onUp(e: PointerEvent) {
  if (!drag) return
  e.preventDefault(); e.stopImmediatePropagation()
  drag = null
  setCursor(null); hoverCursor = false
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
