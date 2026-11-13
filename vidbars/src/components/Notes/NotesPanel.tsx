// NotesPanel — the 3D notes and drawing tools (Brian 2026-11-07), in a
// panel locked to the SCREEN at the right edge: not on a card, not in the
// 3D space, it stays put while the canvas moves under it, flat or tilted.
// Opened from the top bar's Notes button; its fold button folds it to an
// icon strip (anchored at the right, so the fold button never moves).
//
// Every tool is its own on/off button, lit while in the hand (picking one
// puts the others down: the mouse holds one tool). The arrowheads are two
// independent toggles. The outliner lists the Areas and what lies on each:
// drag a row onto an Area to put it there, onto "Canvas" to take it off.
// A curve is listed under the Area it is parented to (utils/curveParent):
// its row dropped on an Area parents it to that one, on "Canvas" unparents
// it, and it stays where it is drawn. A model card in an Area's scene is
// listed under it as a model, wherever its card is: on the Area, docked
// along it, or in a row with the Area's card (Brian 2026-11-12).

import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { useNotesStore, useNotesUi, toggleTool, NOTE_COLORS, type NotesTool, type CurveEnd, type CurveUnit, type CurveMark, type CurveEase, type Curve, type PathRider, type RideAfter, type CurveLayerLook } from '../../store/notesStore'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { areaAt } from '../../utils/areaFollow'
import { ensureAnnotated, modelName } from '../../utils/annotations'
import { models, cardModel } from '../Canvas/tilt/TiltModels'
import { curveBounds, curvePoints } from '../../utils/curveGeom'
import { tangentState, setBroken, setCorner, setLook, lookFrom, markState, setPointMarks, twistState, setPointTwist, resetPointTurn, labelState, setPointLabel } from '../../utils/pathEdit'
import { useCanvasStore } from '../../store/canvasStore'
import { ColorPickerPopup } from '../Bar/ColorPickerPopup'
import { useCurveDraft } from '../../utils/notesTool'
import { useModelScaleStore, useTiltStore } from '../../store/tiltStore'
import { useManip } from '../../store/manipStore'
import { usePeek } from '../../utils/peek'
import { createMediaCard } from '../../utils/cardGrid'
import { visibleCanvasCenter } from '../../utils/fx/createEffect'
import { PRIMITIVES, PRIM_NAMES, primitiveUrl, type Primitive } from '../../three/primitives'
import { dataKey, sceneOf, cardHoldsModel } from '../../utils/area3dScene'
import { pieceName, pieceRiders, pieceRides } from '../../utils/scenePieces'
import { isHiddenDeckMember } from '../../hooks/useCardDecks'
import { parentOf, parentCurves } from '../../utils/curveParent'
import { CameraTools, NEW_CAMERA_MM } from '../Canvas/tilt/LookThrough'
import { useRideClock, rideTime, rideSpan, rideTotal, parentToPath, unparentFromPath, setRider } from '../../utils/pathRide'

const S = 'rgba(228,234,255,0.92)'
const W_OPEN = 252, W_FOLDED = 52

type Ic = React.FC<{ size?: number; color?: string }>
const svg = (size: number) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const })
const IcCurve: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M4 18C6 8 12 5 20 6" stroke={S} /><circle cx="4" cy="18" r="1.8" fill="#4fc3ff" stroke="none" /><circle cx="20" cy="6" r="1.8" fill="#4fc3ff" stroke="none" /><path d="M10 10.5l3.6-3.4" stroke="#4fc3ff" strokeWidth="1.4" /></svg>
)
const IcSelect: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M6 3.5l11.5 9-5.2.9 3 5.6-2.4 1.3-3-5.6-3.9 3.6z" stroke={S} strokeWidth="1.6" /></svg>
)
const IcSmooth: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M3 16c3-9 6-9 9-4s6 5 9-4" stroke={S} /><circle cx="3" cy="16" r="1.8" fill="#4fc3ff" stroke="none" /><circle cx="12" cy="12" r="1.8" fill="#4fc3ff" stroke="none" /><circle cx="21" cy="8" r="1.8" fill="#4fc3ff" stroke="none" /></svg>
)
const IcBreak: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M3 18c2-6 5-9 9-9" stroke={S} /><path d="M12 9c2 5 5 8 9 9" stroke={S} /><path d="M12 9L6.5 4.5" stroke="#4fc3ff" strokeWidth="1.4" /><path d="M12 9l6.5-3" stroke="#4fc3ff" strokeWidth="1.4" /><rect x="10.2" y="7.2" width="3.6" height="3.6" fill="#ffe14a" stroke="none" /><circle cx="6.5" cy="4.5" r="1.6" fill="#4fc3ff" stroke="none" /><circle cx="18.5" cy="6" r="1.6" fill="#4fc3ff" stroke="none" /></svg>
)
const IcCorner: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M3 18L12 7l9 11" stroke={S} strokeLinejoin="miter" /><rect x="10.2" y="5.2" width="3.6" height="3.6" fill="#ffe14a" stroke="none" /></svg>
)
const IcPen: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M4 20c3-1 4-4 6-4s2 3 5 2 4-5 5-7" stroke="#ff8fd1" /><path d="M14.5 4.5l3 3L10 15l-3.6.6.6-3.6z" stroke={S} strokeWidth="1.6" /></svg>
)
const IcPin: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><circle cx="8" cy="16" r="2.4" fill="#ffb23f" stroke="none" /><path d="M9.6 14.4L14 10" stroke={S} strokeWidth="1.4" /><rect x="13" y="4" width="8" height="6" rx="1" stroke={S} strokeWidth="1.6" /></svg>
)
const IcErase: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M14.5 4.5l5 5-8.5 8.5H6l-2.5-2.5z" stroke={S} strokeWidth="1.6" /><path d="M9.5 9.5l5 5" stroke="#ff8fd1" strokeWidth="1.6" /><path d="M11 18h9" stroke={S} strokeWidth="1.4" /></svg>
)
const IcArrowStart: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M5 12h15" stroke={S} /><path d="M10 7l-5 5 5 5" stroke="#4fc3ff" /></svg>
)
const IcArrowEnd: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M4 12h15" stroke={S} /><path d="M14 7l5 5-5 5" stroke="#4fc3ff" /></svg>
)
/** What stands on a curve's end: drawn on the right of a short line. */
const IcEnd: React.FC<{ kind: CurveEnd | null; flip?: boolean; size?: number }> = ({ kind, flip, size = 18 }) => (
  <svg {...svg(size)} style={flip ? { transform: 'scaleX(-1)' } : undefined}>
    <path d={kind ? 'M3 12h10' : 'M3 12h17'} stroke={S} />
    {kind === 'arrow' && <path d="M13 6.5l8 5.5-8 5.5z" fill="#4fc3ff" stroke="none" />}
    {kind === 'cube' && <rect x="13" y="7.5" width="9" height="9" fill="#4fc3ff" stroke="none" />}
    {kind === 'ball' && <circle cx="17.5" cy="12" r="4.8" fill="#4fc3ff" stroke="none" />}
  </svg>
)
const ENDS: { kind: CurveEnd | null; name: string }[] = [{ kind: null, name: 'Nothing' }, { kind: 'arrow', name: 'Arrowhead' }, { kind: 'cube', name: 'Cube' }, { kind: 'ball', name: 'Ball' }]
/** The pieces a pattern can repeat, and what its two numbers are for each. */
const UNITS: { unit: CurveUnit; name: string; a: string; aTip: string; b: string; bTip: string }[] = [
  { unit: 'line', name: 'Line', a: 'Solid', aTip: 'The length of each solid section of the line', b: 'Gap', bTip: 'The length of the empty section after each solid one. 0: one solid line' },
  { unit: 'ball', name: 'Balls', a: 'Size', aTip: 'How far across each ball is (a sphere in 3D)', b: 'Gap', bTip: 'The empty length between one ball and the next' },
  { unit: 'ring', name: 'Rings', a: 'Size', aTip: 'How far across each ring round the line is', b: 'Gap', bTip: 'The empty length between one ring and the next' },
  { unit: 'plus', name: '3D plus signs', a: 'Size', aTip: 'How far across each plus sign is: a bar along the path, one across it and one up, crossing in the middle. They sit square to the path, so they show the twist', b: 'Gap', bTip: 'The empty length between one plus sign and the next' },
  { unit: 'hatch', name: 'Road', a: 'Width', aTip: 'How wide the road is: two edges with chevrons between. It lies flat to the path, so it shows the twist', b: 'Spacing', bTip: 'How far apart the chevrons are. 0: as far apart as the road is wide' },
  { unit: 'cube', name: 'Wire cubes', a: 'Size', aTip: 'How far across each wire cube is. They sit square to the path, so they show the twist', b: 'Gap', bTip: 'The empty length between one cube and the next' },
]
const MARKS: { mark: CurveMark; name: string; tip: string }[] = [
  { mark: 'corners', name: 'Corners', tip: 'A cube at each point of which only the corners show' },
  { mark: 'cross', name: 'Cross', tip: 'A crosshair at each point, in all three directions' },
  { mark: 'bulge', name: 'Bulge', tip: 'The line and the pieces of its pattern grow or shrink as they pass each point' },
]
/** How a bulge falls away from its point, gentle to extreme. */
const EASES: { value: CurveEase; name: string }[] = [
  { value: 'linear', name: 'Linear' }, { value: 'in', name: 'Ease in' }, { value: 'out', name: 'Ease out' }, { value: 'inout', name: 'Ease in and out' },
  { value: 'log', name: 'Log' }, { value: 'exp', name: 'Exponential' }, { value: 'spike', name: 'Spike' }, { value: 'step', name: 'Step' }, { value: 'bounce', name: 'Bounce' },
]
const IcFold: React.FC<{ folded: boolean }> = ({ folded }) => (
  <svg {...svg(16)}><path d={folded ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} stroke={S} /></svg>
)

const btnStyle = (on: boolean, wide = false): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', justifyContent: wide ? 'flex-start' : 'center', gap: 8,
  height: 36, width: wide ? '100%' : 36, padding: wide ? '0 10px' : 0, boxSizing: 'border-box',
  background: on ? 'rgba(120,170,255,0.22)' : 'rgba(255,255,255,0.035)',
  border: `1px solid ${on ? 'rgba(120,170,255,0.55)' : 'rgba(255,255,255,0.08)'}`,
  borderRadius: 9, cursor: 'pointer', color: on ? '#eef4ff' : 'rgba(255,255,255,0.72)', fontSize: 12, flexShrink: 0,
})

const TOOLS: { id: NotesTool; Icon: Ic; name: string; tip: string }[] = [
  { id: 'curve', Icon: IcCurve, name: 'Curve', tip: 'Curve: click for corners, click-drag for smooth points. Double-click, Enter or Esc finishes; click the first point to close it. Click a selected curve’s end point to carry on from it. Works flat and in 3D.' },
  { id: 'pen', Icon: IcPen, name: 'Pen', tip: 'Pen: freehand. Over a model in 3D it draws on the model’s surface; anywhere else on the canvas.' },
  { id: 'pin', Icon: IcPin, name: 'Pin', tip: 'Pin: click a model in 3D to pin a note on it. Each pin gets a Note card, and the model gets an Annotation card.' },
  { id: 'erase', Icon: IcErase, name: 'Erase', tip: 'Erase: click or drag over a stroke on a model, a pin’s dot or a curve to remove just that. Models and cards are never touched.' },
]

const SELECT_TIP = "Select: click a curve to select it (Shift adds), drag it to move it. Click one of its points to select it (Shift adds; double-click for all of them), drag points and handles to reshape it; in 3D, Shift-drag lifts and lowers. Double-click the line for a new point. Delete removes the selected points, or the curve. Esc also puts any tool down."
const SMOOTH_TIP = 'Smooth: on or off. On, a curve runs smoothly through its points by itself, no handles to set; drag the points to reshape it. Also sets the selected curves.'

/** One of three switches sharing a row of the open panel. */
const THIRD: React.CSSProperties = { flex: '1 1 0', minWidth: 0, width: 'auto', padding: '0 5px', gap: 4, fontSize: 11.5, justifyContent: 'center' }
const BREAK_TIP = 'Break: on or off, for the selected points. On, a point’s two tangent handles are each their own, so the line can turn sharply through it with bent sides. Off, they stay in one line and the curve runs smoothly through. Ctrl-drag a handle breaks its point too.'
const CORNER_TIP = 'Corner: on or off, for the selected points. On, a point has no handles: the line turns sharply there. Off, it gets its handles back.'

/** The selected points' tangents: Break and Corner, each its own switch.
 *  Always here, dim until a point is selected. */
const PointTools: React.FC<{ folded: boolean }> = ({ folded }) => {
  // Read again when the selection or the curves change.
  useNotesUi(s => s.points)
  useNotesStore(s => s.curves)
  const st = tangentState()
  const set = (f: (on: boolean) => void, on: boolean) => {
    if (!st.any) return
    useUndoCoordinator.getState().checkpoint()
    f(on)
  }
  const dim = st.any ? 1 : 0.4
  const third = folded ? {} : THIRD
  const brk = (
    <button style={{ ...btnStyle(st.broken, !folded), ...third, opacity: dim }} aria-pressed={st.broken} aria-disabled={!st.any}
      title={BREAK_TIP} onClick={() => set(setBroken, !st.broken)}><IcBreak size={folded ? 20 : 16} />{!folded && <span>Break</span>}</button>
  )
  const cnr = (
    <button style={{ ...btnStyle(st.corner, !folded), ...third, opacity: dim }} aria-pressed={st.corner} aria-disabled={!st.any}
      title={CORNER_TIP} onClick={() => set(setCorner, !st.corner)}><IcCorner size={folded ? 20 : 16} />{!folded && <span>Corner</span>}</button>
  )
  return <>{brk}{cnr}</>
}

/** Motion as the panel shows it (Brian 2026-11-13: the speed "needs to
 *  be able to go at least 5 or 10 times higher... reset the scale a
 *  little bit so it makes sense"): 0 to 100, where 100 is 2000 px a
 *  second and the speed goes with the square of the number, so the slow
 *  end stays fine and the fast end reaches far. The line keeps px a
 *  second, as before. */
const MOTION_K = 0.2
const motionOf = (flow: number) => Math.sign(flow) * Math.round(Math.sqrt(Math.abs(flow) / MOTION_K))
const flowOf = (v: number) => Math.round(Math.sign(v) * v * v * MOTION_K * 10) / 10

/** A slider that is dragged, not jumped to (Brian 2026-11-13: "when I
 *  drag them with the mouse, they jump by like fives and tens"): a short
 *  slider over a wide range has several values under each pixel, so
 *  pressing it never moves the value, and dragging changes it by the
 *  distance dragged, at a rate that gives every value its own place
 *  (the drag carries on past the slider's ends). Shift: ten times finer.
 *  Arrow keys step by one. */
const Slide: React.FC<{ val: number; min: number; max: number; begin: () => void; set: (v: number) => void }> = ({ val, min, max, begin, set }) => {
  const drag = useRef<{ x: number; v: number; last: number } | null>(null)
  const at = Math.max(min, Math.min(max, val))
  const share = max > min ? (at - min) / (max - min) : 0
  const put = (v: number) => { const n = Math.max(min, Math.min(max, Math.round(v))); if (n !== drag.current?.last) { if (drag.current) drag.current.last = n; set(n) } }
  return (
    <div role="slider" tabIndex={0} aria-valuemin={min} aria-valuemax={max} aria-valuenow={at}
      onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); begin(); drag.current = { x: e.clientX, v: at, last: at } }}
      onPointerMove={e => {
        const d = drag.current
        if (!d) return
        // Never more than one value to the pixel, nor so slow that the whole range is out of reach.
        const rate = Math.max(0.08, Math.min(1, (max - min) / 320)) * (e.shiftKey ? 0.1 : 1)
        d.v += (e.clientX - d.x) * rate
        d.x = e.clientX
        put(d.v)
      }}
      onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
      onKeyDown={e => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
        if (!step) return
        e.preventDefault(); e.stopPropagation(); begin(); set(Math.max(min, Math.min(max, at + step)))
      }}
      style={{ position: 'relative', width: '100%', height: 16, cursor: 'ew-resize', touchAction: 'none', outline: 'none' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 6, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.14)' }} />
      <div style={{ position: 'absolute', left: 0, width: `${share * 100}%`, top: 6, height: 4, borderRadius: 2, background: '#3b82f6' }} />
      <div style={{ position: 'absolute', left: `calc(${share} * (100% - 14px))`, top: 1, width: 14, height: 14, borderRadius: 7, background: '#3b82f6', boxShadow: '0 0 0 1px rgba(0,0,0,0.45)' }} />
    </div>
  )
}

/** A number: typed, or slid. `max` is the slider's; typed it can go to `top`. */
const NumSlide: React.FC<{ name: string; val: number; min: number; max: number; top?: number; tip: string; begin: () => void; set: (v: number) => void }> = ({ name, val, min, max, top = max, tip, begin, set }) => (
  <div title={tip} style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
    <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4, fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
      <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
      <input type="number" min={min} max={top} step={1} value={val}
        onPointerDown={begin} onKeyDown={e => { e.stopPropagation(); if (e.key !== 'Tab') begin() }}
        onChange={e => set(Math.max(min, Math.min(top, Math.round(+e.target.value || 0))))}
        style={{ flex: '0 0 auto', width: 42, height: 20, boxSizing: 'border-box', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 5, color: '#e8f0ff', fontSize: 11, textAlign: 'right', padding: '0 3px' }} />
    </span>
    <Slide val={val} min={min} max={max} begin={begin} set={set} />
  </div>
)

/** The curve's point graphic on or off at the selected points: always
 *  here, dim until a point is selected. */
const PointMarkSwitch: React.FC = () => {
  useNotesUi(s => s.points)
  useNotesStore(s => s.curves)
  const st = markState()
  return (
    <button style={{ ...btnStyle(st.on, true), height: 30, justifyContent: 'center', fontSize: 11.5, opacity: st.any ? 1 : 0.4 }} aria-pressed={st.on} aria-disabled={!st.any}
      title="On or off, for the selected points: whether each shows its curve's point graphic. Off leaves that point bare."
      onClick={() => { if (!st.any) return; useUndoCoordinator.getState().checkpoint(); setPointMarks(!st.on) }}>
      Show at the selected points
    </button>
  )
}

/** What rides the path slows through the selected points: on or off. */
const PointSlow: React.FC = () => {
  const points = useNotesUi(s => s.points)
  const curves = useNotesStore(s => s.curves)
  const picked = points.map(k => { const j = k.lastIndexOf(':'); return { id: k.slice(0, j), i: +k.slice(j + 1) } }).filter(x => curves[x.id]?.pts[x.i])
  const on = picked.length > 0 && picked.every(x => curves[x.id].pts[x.i].slow)
  return (
    <button style={{ ...btnStyle(on, true), height: 30, justifyContent: 'center', fontSize: 11.5, opacity: picked.length ? 1 : 0.4 }} aria-pressed={on} aria-disabled={!picked.length}
      title="Slow here: on or off, for the selected points. On, a model or camera riding the path slows into the point and gathers speed out of it."
      onClick={() => {
        if (!picked.length) return
        useUndoCoordinator.getState().checkpoint()
        const ns = useNotesStore.getState()
        for (const id of new Set(picked.map(x => x.id))) {
          const idx = picked.filter(x => x.id === id).map(x => x.i)
          ns.updateCurve(id, { pts: ns.curves[id].pts.map((p, i) => { if (!idx.includes(i)) return p; const q = { ...p }; if (on) delete q.slow; else q.slow = true; return q }) })
        }
      }}>
      Slow here (what rides the path)
    </button>
  )
}

/** The selected points' twist: how far the path is rolled about its own
 *  line there. */
const PointTwist: React.FC = () => {
  useNotesUi(s => s.points)
  useNotesStore(s => s.curves)
  const st = twistState()
  const begin = () => useUndoCoordinator.getState().checkpoint()
  return <NumSlide name="Twist" val={st.twist} min={-180} max={180} top={3600} tip="Rolls the path about its own line at the selected points, in degrees. It blends along the line to the next point. The road, wire cubes, plus signs and the points' cubes show it. Typed, it can go past a full turn."
    begin={begin} set={v => setPointTwist(v)} />
}

/** A few words by the selected points. */
const PointLabel: React.FC = () => {
  useNotesUi(s => s.points)
  useNotesStore(s => s.curves)
  const st = labelState()
  return (
    <label title="A few words shown by the selected points, flat and in 3D. Empty: none." style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
      Label
      <input type="text" value={st.label} maxLength={60} data-point-label=""
        onFocus={() => useUndoCoordinator.getState().checkpoint()}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur() }}
        onChange={e => setPointLabel(e.target.value)}
        style={{ flex: 1, minWidth: 0, height: 24, boxSizing: 'border-box', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 5, color: '#e8f0ff', fontSize: 12, padding: '0 6px', userSelect: 'text' }} />
    </label>
  )
}

/** One part of the panel (Brian 2026-11-13: "a giant list of attributes.
 *  I can't tell where one part stops and another begins"): a lit heading
 *  bar across the panel starts it, and a wider gap ends it. */
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingBottom: 8 }}>
    <div style={{
      margin: '0 -4px', padding: '5px 8px', borderRadius: 5, fontSize: 10.5, fontWeight: 700, letterSpacing: 1.3, fontFamily: 'ui-monospace, monospace',
      color: 'rgba(214,228,255,0.92)', background: 'rgba(120,150,255,0.13)', borderLeft: '3px solid rgba(140,170,255,0.75)',
    }}>{title}</div>
    {children}
  </div>
)

/** One big block of the panel holding everything of one thing (Brian
 *  2026-11-13: "everything for the lines is kind of in one bit, and
 *  inside of it, there are all the options"): its heading bar, then its
 *  options in a frame of their own. */
const Block: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', margin: '0 -4px 8px', borderRadius: 7, border: '1px solid rgba(140,170,255,0.28)', background: 'rgba(120,150,255,0.035)' }}>
    <div style={{
      padding: '5px 8px', borderRadius: '6px 6px 0 0', fontSize: 10.5, fontWeight: 700, letterSpacing: 1.3, fontFamily: 'ui-monospace, monospace',
      color: 'rgba(214,228,255,0.92)', background: 'rgba(120,150,255,0.16)', borderLeft: '3px solid rgba(140,170,255,0.75)',
    }}>{title}</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 5px 8px' }}>{children}</div>
  </div>
)
/** A few options of a block that go together, under a small name. */
const Part: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <div style={{ fontSize: 9.5, letterSpacing: 1.2, color: 'rgba(255,255,255,0.42)', fontFamily: 'ui-monospace, monospace' }}>{title}</div>
    {children}
  </div>
)
/** A part of a block set in from it: a thing of its own inside the block. */
const Inset: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginLeft: 1, marginTop: 2, padding: '6px 0 2px 7px', borderLeft: '2px solid rgba(140,170,255,0.4)' }}>
    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.3, color: 'rgba(200,216,255,0.8)', fontFamily: 'ui-monospace, monospace' }}>{title}</div>
    {children}
  </div>
)

// ── The selected model's notes ──

/** The models of the selected tiles and cards that have notes: their key
 *  (as the 3D view knows them) and file. */
function useSelectedModels(): { key: string; url: string }[] {
  const selNodes = useFreeNodeStore(s => s.selectedIds)
  const selCards = useBoardsStore(s => s.selectedGroupIds)
  const nodes = useFreeNodeStore(s => s.nodes)
  const notes = useNotesStore(s => s.models)
  return useMemo(() => {
    const out: { key: string; url: string }[] = []
    const keys = [...selNodes.map(id => `node:${id}`), ...selCards.map(id => `card:${id}`)]
    for (const key of keys) {
      const n = key.startsWith('node:') ? nodes[key.slice(5)] : undefined
      const url = models.info?.(key)?.url ?? (n?.type === 'model' ? n.imageUrl : undefined)
      if (url && notes[url] && !out.some(o => o.url === url)) out.push({ key, url })
    }
    return out
  }, [selNodes, selCards, nodes, notes])
}

/** Clear its strokes, or bring its Annotation card back (made again if it
 *  was deleted): without going near the model itself. */
const ModelNotesRow: React.FC<{ k: string; url: string }> = ({ k, url }) => {
  const m = useNotesStore(s => s.models[url])
  const nodes = useFreeNodeStore(s => s.nodes)
  if (!m) return null
  const has = !!(m.cardNodeId && nodes[m.cardNodeId])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name || modelName(k, url)}</span>
        <span style={{ color: 'rgba(255,255,255,0.45)', fontFamily: 'ui-monospace, monospace', fontSize: 11, flexShrink: 0 }}>{m.strokes.length} strokes · {m.pins.length} pins</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={{ ...btnStyle(false, true), flex: 1, justifyContent: 'center', opacity: m.strokes.length ? 1 : 0.45 }} disabled={!m.strokes.length}
          title="Remove every stroke drawn on this model (Ctrl+Z brings them back). The Erase tool removes one at a time."
          onClick={() => { useUndoCoordinator.getState().checkpoint(); useNotesStore.getState().clearStrokes(url) }}>Clear strokes</button>
        <button style={{ ...btnStyle(false, true), flex: 1, justifyContent: 'center' }}
          title={has ? 'Select its Annotation card' : 'Its Annotation card was deleted: make it again, with all its pins'}
          onClick={() => {
            const id = ensureAnnotated(url, k)
            useFreeNodeStore.getState().setFreeSelection([id])
            useBoardsStore.getState().clearGroupSelection()
          }}>{'Annotation card'}</button>
      </div>
    </div>
  )
}

const SelectedModels: React.FC = () => {
  const list = useSelectedModels()
  if (!list.length) return null
  return <Section title="SELECTED MODEL">{list.map(m => <ModelNotesRow key={m.key} k={m.key} url={m.url} />)}</Section>
}

// ── 3D area: primitives and model colour (Brian 2026-11-08) ──

const PRIM_ICON: Record<Primitive, React.ReactNode> = {
  cube: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" stroke={S} /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" stroke={S} /></>,
  sphere: <><circle cx="12" cy="12" r="8.5" stroke={S} /><ellipse cx="12" cy="12" rx="8.5" ry="3.2" stroke={S} /></>,
  cylinder: <><ellipse cx="12" cy="5.5" rx="7" ry="2.5" stroke={S} /><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13" stroke={S} /></>,
  cone: <><path d="M12 3L5 18.5M12 3l7 15.5" stroke={S} /><ellipse cx="12" cy="18.5" rx="7" ry="2.5" stroke={S} /></>,
  plane: <path d="M7 8h14l-4 8H3z" stroke={S} />,
  camera: <><rect x="2.5" y="9" width="12" height="9" rx="1.5" stroke={S} /><path d="M14.5 12l6-3v9l-6-3" stroke={S} /><circle cx="6" cy="6" r="2.4" stroke={S} /><circle cx="11.5" cy="6" r="2.4" stroke={S} /></>,
}

/** Model colours: plain, readable over the dark ground. */
const MODEL_COLORS = ['#e8e8e8', '#7a7f8a', '#2b2d33', '#d9534f', '#f0a742', '#f2d64b', '#6fbf73', '#4aa3df', '#8a6fd1', '#c98a5a']

/** The selected models (cards and tiles), as the 3D view keys them. */
function useSelectedModelKeys(): string[] {
  const selNodes = useFreeNodeStore(s => s.selectedIds)
  const selCards = useBoardsStore(s => s.selectedGroupIds)
  const nodes = useFreeNodeStore(s => s.nodes)
  const groups = useBoardsStore(s => s.groups)
  return useMemo(() => [
    ...selNodes.filter(id => nodes[id]?.type === 'model').map(id => `node:${id}`),
    // (groups: a card's face can change to or from a model.)
    // A closed deck's colour goes with the member on its face (dataKey).
    ...selCards.filter(id => !!cardModel(id)).map(id => dataKey(`card:${id}`)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [selNodes, selCards, nodes, groups])
}

let made = 0
/** A primitive, as a model card: on the selected 3D area, else the one in
 *  the middle of the view, else in the middle of the view. */
function makePrimitive(p: Primitive) {
  const fn = useFreeNodeStore.getState()
  const sel = fn.selectedIds.map(id => fn.nodes[id]).find(n => n?.type === 'area')
  const mid = visibleCanvasCenter()
  const area = sel ?? areaAt(fn.nodes, mid.cx, mid.cy)
  // Each new one a step along, so they don't stack up.
  const i = made++ % 5
  const at = area
    ? { cx: area.x + area.width * (0.3 + 0.1 * i), cy: area.y + area.height * 0.5 }
    : { cx: mid.cx + i * 40, cy: mid.cy }
  useUndoCoordinator.getState().checkpoint()
  const id = createMediaCard(at, [{ media: { url: primitiveUrl(p), type: 'model', originalName: PRIM_NAMES[p] }, label: PRIM_NAMES[p] }])
  // A new camera's lens (one made before keeps the lens it had).
  if (id && p === 'camera') useModelScaleStore.getState().setLens(dataKey(`card:${id}`), { mm: NEW_CAMERA_MM })
  // Sized to the scene, not the zoom: made zoomed out, a card came out
  // bigger than the whole scene and lay half off it (Brian 2026-11-09).
  if (id && area) {
    const g = useBoardsStore.getState().groups.find(x => x.id === id)
    const w = g?.cardWidthOverride, h = g?.cardHeightOverride
    const k = w && h ? Math.min(1, area.width * 0.14 / w) : 1
    if (g && w && h && k < 1) {
      useBoardsStore.setState(st => ({
        groups: st.groups.map(x => x.id === id ? { ...x, cardWidthOverride: w * k, cardHeightOverride: h * k, originX: at.cx - w * k / 2 - 20, originY: at.cy - h * k / 2 } : x),
      }))
    }
  }
  if (id) useBoardsStore.getState().setSelectedGroup(id)
}

/** The selected models' pieces in the flat view (Brian 2026-11-12: "use
 *  this view for its piece"; utils/scenePieces): from straight above,
 *  turning with the model, or as the model is seen in 3D right now, kept
 *  that way and standing upright. Two buttons, the one in use lit; "This
 *  view" pressed again takes the view again. For models placed in a 3D
 *  set, or riding a path: those are the ones with a piece. */
const PieceTools: React.FC = () => {
  const selNodes = useFreeNodeStore(s => s.selectedIds)
  const selCards = useBoardsStore(s => s.selectedGroupIds)
  const nodes = useFreeNodeStore(s => s.nodes)
  const groups = useBoardsStore(s => s.groups)
  const placeOf = useModelScaleStore(s => s.placeOf)
  const pieceOf = useModelScaleStore(s => s.pieceOf)
  const riders = useNotesStore(() => pieceRiders())
  // The models standing in the 3D view (three/tiltScene frame): the 3D
  // look locked on, or tipped back past 4° and not swung round to the side.
  const standing = useTiltStore(s => s.lock3d || (s.tilt > 4 && Math.abs(s.yaw) < 35))
  const through = useManip(s => s.through)
  // (Peeking tips the view too, and no model stands.)
  const peeking = usePeek(s => !!s.target)
  // As the 3D view knows them, and where their settings are kept.
  const list = useMemo(() => [
    ...selNodes.filter(id => nodes[id]?.type === 'model').map(id => `node:${id}`),
    ...selCards.filter(id => !!cardModel(id)).map(id => `card:${id}`),
  ].map(key => ({ key, dk: dataKey(key) })).filter(k => pieceRides(k.key, k.dk) || (!!placeOf[k.dk] && !!sceneOf(k.key))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [selNodes, selCards, nodes, groups, placeOf, riders])
  const any = list.length > 0
  const own = any && list.every(k => !!pieceOf[k.dk])
  const top = any && list.every(k => !pieceOf[k.dk])
  // A view to take: the models standing in the 3D view on screen.
  const can = any && !peeking && (standing || !!through)
  const fromTop = () => {
    if (!any || top) return
    useUndoCoordinator.getState().checkpoint()
    const ms = useModelScaleStore.getState()
    for (const k of list) ms.setPiece(k.dk, null)
  }
  const fromHere = () => {
    if (!can) return
    // (A closed deck's front card and the member on its face are one piece:
    // whichever of the two stands in the 3D view.)
    const views = list.map(k => ({ dk: k.dk, v: models.pieceView?.(k.key) ?? models.pieceView?.(k.dk) ?? null })).filter(x => !!x.v)
    if (!views.length) return
    useUndoCoordinator.getState().checkpoint()
    const ms = useModelScaleStore.getState()
    for (const x of views) ms.setPiece(x.dk, x.v)
  }
  const b = (on: boolean, live: boolean): React.CSSProperties => ({ ...btnStyle(on, true), flex: 1, height: 30, justifyContent: 'center', opacity: live ? 1 : 0.45, cursor: live ? 'pointer' : 'default' })
  return (
    <>
      <div style={{ fontSize: 10, letterSpacing: 1.3, color: 'rgba(255,255,255,0.4)', fontFamily: 'ui-monospace, monospace' }}>PIECE</div>
      <div style={{ display: 'flex', gap: 6 }} title={any ? undefined : 'A model placed in a 3D set, or riding a path, shows as a piece in the flat view'}>
        <button data-piece-view="top" style={b(top, any)} disabled={!any} aria-pressed={top} onClick={fromTop}
          title="Top view: in the flat view its piece is its shape from straight above, and turns as the model turns">Top view</button>
        <button data-piece-view="this" style={b(own, can)} disabled={!can} aria-pressed={own} onClick={fromHere}
          title="This view: in the flat view its piece is the model as you see it in 3D right now, upright, standing on its spot. Tip into 3D, turn to the side you want, then press; press again to take the view again">This view</button>
      </div>
    </>
  )
}

const Area3dTools: React.FC<{ part: 'make' | 'selected' }> = ({ part }) => {
  const keys = useSelectedModelKeys()
  const tintOf = useModelScaleStore(s => s.tintOf)
  const cur = keys.length ? tintOf[keys[0]] ?? null : null
  const paint = (c: string | null) => {
    if (!keys.length) return
    useUndoCoordinator.getState().checkpoint()
    const ms = useModelScaleStore.getState()
    for (const k of keys) ms.setTint(k, c)
  }
  const sw = (c: string | null, on: boolean): React.CSSProperties => ({
    height: 20, borderRadius: 10, padding: 0, cursor: keys.length ? 'pointer' : 'default',
    background: c ?? 'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 3px, transparent 3px 6px)',
    border: on ? '2px solid #fff' : '2px solid rgba(255,255,255,0.15)', boxShadow: on ? '0 0 0 1px rgba(0,0,0,0.6)' : 'none',
  })
  // Making things for the set is one part of the panel; what is for the
  // selected model (its colour, a camera's options) is with the selection's.
  if (part === 'make') return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
      {PRIMITIVES.map(p => (
        <button key={p} style={{ ...btnStyle(false), width: '100%' }} onClick={() => makePrimitive(p)}
          title={`${PRIM_NAMES[p]}: a new model card, set on the selected 3D set (or the one in view)`}>
          <svg {...svg(20)}>{PRIM_ICON[p]}</svg>
        </button>
      ))}
    </div>
  )
  return (
    <>
      <div style={{ fontSize: 10, letterSpacing: 1.3, color: 'rgba(255,255,255,0.4)', fontFamily: 'ui-monospace, monospace' }}>MODEL COLOUR</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(11, 1fr)', gap: 4, opacity: keys.length ? 1 : 0.4 }}
        title={keys.length ? undefined : 'Select a model to colour it'}>
        <button style={sw(null, !!keys.length && !cur)} disabled={!keys.length} onClick={() => paint(null)} title="Its own colours" aria-pressed={!!keys.length && !cur} />
        {MODEL_COLORS.map(c => (
          <button key={c} style={sw(c, cur === c)} disabled={!keys.length} onClick={() => paint(c)} title={c} aria-pressed={cur === c} />
        ))}
      </div>
      <PieceTools />
      <CameraTools />
    </>
  )
}

// ── Models riding the selected path ──

const AFTERS: { value: RideAfter; name: string }[] = [
  { value: 'loop', name: 'Go round again' }, { value: 'stop', name: 'Stop at the end' }, { value: 'pingpong', name: 'Come back the way it went' },
]

/** Seconds, typed: to a tenth. */
const Secs: React.FC<{ name: string; val: number; tip: string; set: (v: number) => void }> = ({ name, val, tip, set }) => (
  <label title={tip} style={{ flex: '1 1 0', minWidth: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
    {name}
    <input type="number" min={0} max={36000} step={0.1} value={val}
      onKeyDown={e => e.stopPropagation()}
      onChange={e => set(Math.max(0, Math.round((+e.target.value || 0) * 10) / 10))}
      style={{ width: 58, height: 22, boxSizing: 'border-box', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 5, color: '#e8f0ff', fontSize: 11, textAlign: 'right', padding: '0 3px' }} />
  </label>
)

/** The ride clock: one for every path, so models on several stay in step. */
const RideClockRow: React.FC = () => {
  const playing = useRideClock(s => s.playing)
  const base = useRideClock(s => s.base)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => tick(n => n + 1), 100)
    return () => window.clearInterval(id)
  }, [playing])
  void base
  const now = rideTime()
  const top = Math.max(10, Math.ceil(rideTotal()), Math.ceil(now))
  const wide: React.CSSProperties = { flex: '1 1 0', width: 'auto', height: 30, justifyContent: 'center', fontSize: 11.5 }
  return (
    <>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <button style={{ ...btnStyle(playing, true), ...wide }} aria-pressed={playing}
          title="Play: on or off. On, the clock runs and every model on a path rides it. One clock for all the paths, so they stay in step."
          onClick={() => playing ? useRideClock.getState().pause() : useRideClock.getState().play()}>Play</button>
        <button style={{ ...btnStyle(false, true), ...wide }} title="Back to the start: the clock goes to 0, every model to where its path begins"
          onClick={() => useRideClock.getState().seek(0)}>To start</button>
        <span style={{ width: 54, textAlign: 'right', fontSize: 11.5, fontFamily: 'ui-monospace, monospace', color: 'rgba(235,240,255,0.85)', flexShrink: 0 }}>{now.toFixed(1)}s</span>
      </div>
      <input type="range" min={0} max={top} step={0.05} value={Math.min(top, now)} title="The clock: drag to any moment"
        onChange={e => useRideClock.getState().seek(+e.target.value)} style={{ width: '100%' }} />
    </>
  )
}

/** The line's layers (Brian 2026-11-13: "it would still be nice to be
 *  able to layer them"): more designs drawn along the same line, over its
 *  own. Each has its own on/off, design, sizes, thickness, colour and
 *  motion. They are the selected curves' (all of them take the same). */
const LineLayers: React.FC<{ c: Curve; ids: string[] }> = ({ c, ids }) => {
  const zoom = useCanvasStore(s => s.zoom)
  const layers = c.layers ?? []
  const step = () => useUndoCoordinator.getState().checkpoint()
  const put = (next: CurveLayerLook[]) => {
    const ns = useNotesStore.getState()
    for (const id of ids) if (ns.curves[id]?.kind === 'bezier') ns.updateCurve(id, { layers: next.length ? next : undefined })
  }
  const set = (i: number, patch: Partial<CurveLayerLook>) => put(layers.map((l, k) => {
    if (k !== i) return l
    const q: CurveLayerLook = { ...l, ...patch }
    for (const key of ['width', 'color', 'flow', 'off'] as const) if (!q[key]) delete q[key]
    return q
  }))
  const small: React.CSSProperties = { ...btnStyle(false, true), width: 'auto', height: 22, padding: '0 8px', fontSize: 11, flex: '0 0 auto' }
  const dot = (on: boolean): React.CSSProperties => ({ height: 18, borderRadius: 9, cursor: 'pointer', padding: 0, border: on ? '2px solid #fff' : '2px solid rgba(255,255,255,0.15)', boxShadow: on ? '0 0 0 1px rgba(0,0,0,0.6)' : 'none' })
  return (
    <Inset title="LAYERS">
      {layers.map((l, i) => {
        const o = UNITS.find(u => u.unit === l.unit) ?? UNITS[0]
        return (
          <div key={i} data-line-layer={i} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 7, borderRadius: 7, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <button style={{ ...small, ...btnStyle(!l.off, true), width: 'auto', height: 22, padding: '0 8px', fontSize: 11 }} aria-pressed={!l.off}
                title={`Layer ${i + 1}: on or off. Off, it is kept but not drawn.`} onClick={() => { step(); set(i, { off: !l.off }) }}>Layer {i + 1}</button>
              <span style={{ flex: 1 }} />
              <button style={small} title="Take this layer off the line" onClick={() => { step(); put(layers.filter((_, k) => k !== i)) }}>Remove</button>
            </div>
            <PickList value={l.unit} options={UNITS.map(u => ({ value: u.unit, name: u.name }))} title="What this layer repeats along the line" onPick={v => { step(); set(i, { unit: v as CurveUnit }) }} />
            <div style={{ display: 'flex', gap: 10 }}>
              <NumSlide name={o.a} val={Math.round(l.on * zoom)} min={1} max={120} top={400} tip={`${o.aTip}.`} begin={step} set={v => set(i, { on: v / zoom })} />
              <NumSlide name={o.b} val={Math.round(l.gap * zoom)} min={0} max={120} top={400} tip={`${o.bTip}.`} begin={step} set={v => set(i, { gap: v / zoom })} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <NumSlide name="Thick" val={Math.round((l.width ?? 0) * zoom)} min={0} max={24} top={200} tip="How thick this layer's own strokes are. 0: as thick as the line."
                begin={step} set={v => set(i, { width: v ? v / zoom : undefined })} />
              <NumSlide name="Motion" val={motionOf((l.flow ?? 0) * zoom)} min={-100} max={100} top={300} tip="How fast this layer runs along the line. 0: still. Below 0: towards the line's start."
                begin={step} set={v => set(i, { flow: v ? flowOf(v) / zoom : undefined })} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 3 }}>
              <button onClick={() => { step(); set(i, { color: undefined }) }} title="This layer: the line's colour" aria-pressed={!l.color}
                style={{ ...dot(!l.color), background: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 3px, transparent 3px 6px)' }} />
              {NOTE_COLORS.map(col => (
                <button key={col} onClick={() => { step(); set(i, { color: col }) }} title={`This layer: ${col}`} aria-pressed={col === l.color} style={{ ...dot(col === l.color), background: col }} />
              ))}
            </div>
          </div>
        )
      })}
      <button style={{ ...btnStyle(false, true), height: 30, justifyContent: 'center', fontSize: 11.5 }}
        title="Add a layer: another design drawn along this same line, over its own"
        onClick={() => { step(); put([...layers, { unit: 'ring', on: c.width * 3, gap: c.width * 3 }]) }}>+ Add layer</button>
    </Inset>
  )
}

/** The selected path as a ride (Brian 2026-11-12): when its models set
 *  off and arrive on the shared clock, and each model's own way of
 *  sitting on it. */
const PathRiders: React.FC<{ c: Curve }> = ({ c }) => {
  const zoom = useCanvasStore(s => s.zoom)
  const nodes = useFreeNodeStore(s => s.nodes)
  const groups = useBoardsStore(s => s.groups)
  const step = () => useUndoCoordinator.getState().checkpoint()
  const patch = (p: Partial<Curve>) => { step(); useNotesStore.getState().updateCurve(c.id, p) }
  const span = rideSpan(c)
  const list = (c.riders ?? []).map(r => {
    const id = r.key.slice(5)
    const name = r.key.startsWith('node:') ? nodes[id]?.label || (nodes[id] ? 'Model' : null) : groups.find(g => g.id === id)?.name || (groups.some(g => g.id === id) ? 'Card' : null)
    return { r, name }
  }).filter(x => x.name !== null)
  const tog = (r: PathRider, k: 'aim' | 'slope' | 'twist' | 'centre', name: string, tip: string) => {
    const on = k === 'centre' ? !!r.centre : r[k] !== false
    return <button style={{ ...btnStyle(on, true), flex: '1 1 0', width: 'auto', minWidth: 0, padding: '0 4px', height: 30, justifyContent: 'center', fontSize: 11.5 }} aria-pressed={on}
      title={`${name}: on or off. ${tip}`} onClick={() => { step(); setRider(c.id, r.key, { [k]: !on }) }}>{name}</button>
  }
  return (
    <Section title="RIDING THIS PATH">
      {!list.length && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', lineHeight: 1.5 }}>Drag a model onto this path in the Outliner and it rides the path in the 3D view.</div>}
      {!!list.length && (
        <>
          <RideClockRow />
          <div style={{ display: 'flex', gap: 10 }}>
            <Secs name="Sets off" val={c.rideStart ?? 0} tip="When on the clock this path's models set off, in seconds. Until then they wait at its start." set={v => patch({ rideStart: v || undefined })} />
            <Secs name="Arrives" val={c.rideEnd ?? 0} tip="When on the clock they reach the end, in seconds. 0: they go at the speed of the line's own Motion." set={v => patch({ rideEnd: v || undefined })} />
          </div>
          <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.4)' }}>{span.timed ? `${span.dur.toFixed(1)}s from start to end` : c.flow ? `At the line's Motion speed: ${span.dur.toFixed(1)}s from start to end` : 'No Motion on the line and no arrival time: 4s from start to end'}</div>
          <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            <div style={{ flex: '1 1 0', minWidth: 0 }}>
              <PickList value={c.rideAfter ?? 'loop'} options={AFTERS} title="What its models do when they reach the end" onPick={v => patch({ rideAfter: v === 'loop' ? undefined : v as RideAfter })} />
            </div>
            <button style={{ ...btnStyle(!!c.rideEase, true), flex: '0 0 auto', width: 'auto', height: 30, padding: '0 10px', justifyContent: 'center', fontSize: 11.5 }} aria-pressed={!!c.rideEase}
              title="Ease: on or off. On, they gather speed leaving the start and slow into the end." onClick={() => patch({ rideEase: c.rideEase ? undefined : true })}>Ease</button>
          </div>
          {list.map(({ r, name }) => (
            <div key={r.key} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 7, borderRadius: 7, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <span style={{ color: 'rgba(160,200,255,0.8)' }}>◆</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                <button style={{ ...btnStyle(false, true), width: 'auto', height: 22, padding: '0 8px', fontSize: 11 }} title="Reset rotation: undo any turn you gave this model yourself, so it stands on the path as the path has it"
                  onClick={() => { step(); useModelScaleStore.getState().setPose(dataKey(r.key), null) }}>Reset rotation</button>
                <button style={{ ...btnStyle(false, true), width: 'auto', height: 22, padding: '0 8px', fontSize: 11 }} title="Take this model off the path: it stands where it stood before"
                  onClick={() => { step(); unparentFromPath(r.key) }}>Take off</button>
              </div>
              <div style={{ display: 'flex', gap: 5 }}>
                {tog(r, 'aim', 'Aim', 'On, it faces the way the path runs.')}
                {tog(r, 'slope', 'Slope', 'On, it tips up and down with the path as it climbs and falls. Off, it stays level.')}
                {tog(r, 'twist', 'Twist', "On, it rolls with the path's twist.")}
                {tog(r, 'centre', 'Center', 'On, the center of its bounding box keeps to the path and it turns about that center. Off, its feet do.')}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <NumSlide name="Bank" val={r.bank ?? 0} min={-300} max={300} top={1000} tip="How much it leans into the path's turns, in percent. 0: none. Below 0: it leans out of them."
                  begin={step} set={v => setRider(c.id, r.key, { bank: v || undefined })} />
                <NumSlide name="Heading" val={r.heading ?? 0} min={-180} max={180} tip="Turned from the way the path runs, in degrees: for a model whose front is not where the path expects it, or one that travels sideways."
                  begin={step} set={v => setRider(c.id, r.key, { heading: v || undefined })} />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <NumSlide name="Lift" val={Math.round((r.lift ?? 0) * zoom)} min={-200} max={400} top={5000} tip="Carried this far above the path (below 0: under it)."
                  begin={step} set={v => setRider(c.id, r.key, { lift: v ? v / zoom : undefined })} />
                <NumSlide name="Side" val={Math.round((r.side ?? 0) * zoom)} min={-300} max={300} top={5000} tip="Carried this far to the side of the path: two models side by side on one path."
                  begin={step} set={v => setRider(c.id, r.key, { side: v ? v / zoom : undefined })} />
              </div>
              <NumSlide name="Ahead" val={Math.round((r.lead ?? 0) * 100)} min={0} max={100} tip="How far along the path it is ahead of the clock, in percent of the path: several models on one path follow each other."
                begin={step} set={v => setRider(c.id, r.key, { lead: v ? v / 100 : undefined })} />
            </div>
          ))}
        </>
      )}
    </Section>
  )
}

// ── Outliner ──
type Item = { kind: 'node' | 'card' | 'viewer' | 'curve'; id: string; name: string; icon: string; cx: number; cy: number; /** A curve a model can ride. */ path?: boolean; /** A model listed under its set by its scene (area3dScene sceneOf), not by where its corner is. */ scene?: boolean }

/** A row's model, as the 3D view knows it, if it is one: what can ride a path. */
function modelKeyOf(it: Item): string | null {
  if (it.kind === 'node') return useFreeNodeStore.getState().nodes[it.id]?.type === 'model' ? `node:${it.id}` : null
  return it.kind === 'card' && cardModel(it.id) ? `card:${it.id}` : null
}

function useOutline() {
  const nodes = useFreeNodeStore(s => s.nodes)
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const windows = useViewport3DStore(s => s.windows)
  const curves = useNotesStore(s => s.curves)
  // What a model card is in the scene of goes by its box, which can change
  // with the zoom (its header), and by which of a closed deck's models
  // are placed: looked at again a few times an octave, not at every step.
  const zoomStep = useCanvasStore(s => Math.round(Math.log2(s.zoom) * 4))
  const placeOf = useModelScaleStore(s => s.placeOf)
  const portals = useCanvasStore(s => s.deckPortalSelections)
  return useMemo(() => {
    const areas = Object.values(nodes).filter(n => n.type === 'area' && !n.pin)
    const kids = new Map<string, Item[]>()
    const root: Item[] = []
    const under = (areaId: string, it: Item) => { if (!kids.has(areaId)) kids.set(areaId, []); kids.get(areaId)!.push(it) }
    const put = (it: Item, not?: string) => {
      const a = areaAt(nodes, it.cx, it.cy, not)
      if (a) under(a.id, it)
      else if (it.kind === 'node' || it.kind === 'curve') root.push(it)
    }
    const icon = (n: FreeNodeData) => n.type === 'model' ? '◆' : n.type === 'area' ? '▦' : n.type === 'image' ? '▣' : n.type === 'video' ? '▶' : '▢'
    for (const n of Object.values(nodes)) {
      if (n.pin || n.railDock || n.type === 'storyline' || (n.tileDeck && n.tileDeck.anchor !== n.id)) continue
      if (n.type !== 'area' && n.type !== 'model') {
        // Loose tiles are only listed on an Area; at the root, models only.
        const a = areaAt(nodes, n.x + n.width / 2, n.y + n.height / 2)
        if (!a) continue
      }
      const it: Item = { kind: 'node', id: n.id, name: n.label || n.type, icon: icon(n), cx: n.x + n.width / 2, cy: n.y + n.height / 2 }
      // A model tile docked along a 3D set is in its scene: under it.
      const sc = n.type === 'model' && areas.length ? sceneOf(`node:${n.id}`) : null
      if (sc) under(sc.area.id, { ...it, scene: true })
      else put(it, n.type === 'area' ? n.id : undefined)
    }
    // A closed deck shows one member's model on its face: that member is
    // listed by the deck's front card, not a second time by itself.
    const faces = new Set<string>()
    if (areas.length) {
      for (const g of groups) {
        if (g.pin || isHiddenDeckMember(g) || (g.deckState !== 'stacked' && g.deckState !== 'fanned')) continue
        const dk = dataKey(`card:${g.id}`)
        if (dk !== `card:${g.id}`) faces.add(dk)
      }
    }
    for (const g of groups) {
      if (g.pin) continue
      // A model in a 3D set's scene: under that set, as a model, wherever
      // its card is (on the set, docked along it, in a row with its
      // card). A card put away in a closed deck: once its model is placed
      // in the set, where its piece is to be seen.
      const key = `card:${g.id}`
      const hidden = isHiddenDeckMember(g)
      if (areas.length && !g.hideModel3d && (hidden ? !!placeOf[key] && !faces.has(key) : cardHoldsModel(g, boards) || !!g.deckState)) {
        const model = cardModel(g.id)
        const sc = model && sceneOf(key)
        if (model && sc) {
          const dk = dataKey(key)
          const face = dk === key ? g : groups.find(x => x.id === dk.slice(5)) ?? g
          under(sc.area.id, { kind: 'card', id: g.id, name: pieceName(face.name, model.name), icon: '◆', cx: g.originX + 20, cy: g.originY + 20, scene: true })
          continue
        }
      }
      const a = areaAt(nodes, g.originX + 20, g.originY + 20)
      // A card showing a model is listed wherever it is (Brian 2026-11-12:
      // "I don't see models in the outliner"): under the 3D set it is on,
      // docked to or in a row with, or else at the root. It is what is
      // dragged onto a path to ride it.
      const model = !isHiddenDeckMember(g) && !!cardModel(g.id)
      const it: Item = { kind: 'card', id: g.id, name: g.name || 'Card', icon: model ? '◆' : '▭', cx: g.originX + 20, cy: g.originY + 20 }
      if (a) put(it)
      else if (model) {
        const set = sceneOf(`card:${g.id}`)?.area
        if (set) { if (!kids.has(set.id)) kids.set(set.id, []); kids.get(set.id)!.push({ ...it, scene: true }) }
        else root.push(it)
      }
    }
    for (const w of Object.values(windows)) put({ kind: 'viewer', id: w.id, name: 'Viewer', icon: '◳', cx: w.x + w.width / 2, cy: w.y + w.height / 2 })
    for (const c of Object.values(curves)) {
      const b = curveBounds(c)
      // Under the 3D set it is parented to, wherever it lies.
      const p = parentOf(c, nodes)
      const inA = p ? areas.find(a => a.id === p) : undefined
      const it: Item = { kind: 'curve', id: c.id, name: c.name || (c.arrowEnd || c.arrowStart ? 'Arrow' : c.kind === 'free' ? 'Pen line' : 'Curve'), icon: '∿', cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, path: c.kind === 'bezier' }
      if (inA) { if (!kids.has(inA.id)) kids.set(inA.id, []); kids.get(inA.id)!.push(it) }
      else root.push(it)
    }
    // The models riding each path (utils/pathRide) are listed under it,
    // and nowhere else.
    const riders = new Map<string, Item[]>()
    const riding = new Set<string>()
    for (const c of Object.values(curves)) for (const r of c.riders ?? []) {
      const id = r.key.slice(5)
      const n = r.key.startsWith('node:') ? nodes[id] : undefined
      const g = r.key.startsWith('card:') ? groups.find(x => x.id === id) : undefined
      const it: Item | null = n ? { kind: 'node', id, name: n.label || n.type, icon: '◆', cx: n.x + n.width / 2, cy: n.y + n.height / 2 }
        : g ? { kind: 'card', id, name: g.name || 'Card', icon: '◆', cx: g.originX + 20, cy: g.originY + 20 } : null
      if (!it) continue
      riding.add(`${it.kind}${it.id}`)
      if (!riders.has(c.id)) riders.set(c.id, [])
      riders.get(c.id)!.push(it)
    }
    const off = (list: Item[]) => list.filter(it => !riding.has(`${it.kind}${it.id}`))
    for (const [k, list] of kids) kids.set(k, off(list))
    return { areas, kids, root: off(root), riders, riding }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, groups, boards, windows, curves, zoomStep, placeOf, portals])
}

/** Move an outliner item so its middle is at (x, y). */
function moveItemTo(it: Item, x: number, y: number) {
  const dx = x - it.cx, dy = y - it.cy
  if (it.kind === 'node') useFreeNodeStore.getState().moveManyFreeNodes([it.id], dx, dy)
  else if (it.kind === 'card') {
    const g = useBoardsStore.getState().groups.find(x => x.id === it.id)
    if (g) useBoardsStore.getState().setGroupPos(g.id, g.originY + dy, g.originX + dx)
  } else if (it.kind === 'viewer') {
    const w = useViewport3DStore.getState().windows[it.id]
    if (w) useViewport3DStore.getState().updateWindow(w.id, { x: w.x + dx, y: w.y + dy })
  } else useNotesStore.getState().moveCurves([it.id], dx, dy)
}

/** Call an Outliner row something else (Brian 2026-11-12: "rename objects
 *  in the Outliner, including the paths"). */
function renameItem(it: Item, name: string) {
  const to = name.trim()
  if (to === it.name || it.kind === 'viewer') return
  useUndoCoordinator.getState().checkpoint()
  if (it.kind === 'node') useFreeNodeStore.getState().updateFreeNode(it.id, { label: to })
  else if (it.kind === 'card') { if (to) useBoardsStore.getState().renameGroup(it.id, to) }
  else useNotesStore.getState().updateCurve(it.id, { name: to || undefined })
}

function selectItem(it: Item) {
  const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
  if (it.kind === 'node') { fs.setFreeSelection([it.id]); bs.clearGroupSelection() }
  else if (it.kind === 'card') { bs.setSelectedGroups([it.id]); fs.setFreeSelection([]) }
  else if (it.kind === 'curve') useNotesUi.setState({ selected: [it.id], points: [] })
}

const Outliner: React.FC = () => {
  const { areas, kids, root, riders, riding } = useOutline()
  const selNodes = useFreeNodeStore(s => s.selectedIds)
  const selCards = useBoardsStore(s => s.selectedGroupIds)
  const selCurves = useNotesUi(s => s.selected)
  const [dragging, setDragging] = useState<Item | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [naming, setNaming] = useState<string | null>(null)
  const drag = useRef<{ it: Item; x0: number; y0: number; live: boolean } | null>(null)
  const isSel = (it: Item) => it.kind === 'node' ? selNodes.includes(it.id) : it.kind === 'card' ? selCards.includes(it.id) : it.kind === 'curve' ? selCurves.includes(it.id) : false

  const down = (e: React.PointerEvent, it: Item) => {
    if (e.button !== 0) return
    drag.current = { it, x0: e.clientX, y0: e.clientY, live: false }
    const move = (ev: PointerEvent) => {
      const d = drag.current
      if (!d) return
      if (!d.live && Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) > 5) { d.live = true; setDragging(d.it) }
      if (!d.live) return
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-outline-drop]')
      setOver(el?.dataset.outlineDrop ?? null)
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const d = drag.current
      drag.current = null
      setDragging(null); setOver(null)
      if (!d) return
      if (!d.live) { selectItem(d.it); return }
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-outline-drop]')?.dataset.outlineDrop
      if (!target || target === d.it.id) return
      const nodes = useFreeNodeStore.getState().nodes
      const key = modelKeyOf(d.it)
      // Onto a path: the model rides it (Brian 2026-11-12: "parent the
      // models to the paths"). Nothing but a model does.
      if (target.startsWith('curve:')) {
        if (!key) return
        useUndoCoordinator.getState().checkpoint()
        parentToPath(key, target.slice(6))
        return
      }
      // A curve's row: parented to the set it is dropped on, to nothing on
      // "Canvas". It stays where it is drawn.
      if (d.it.kind === 'curve') {
        if (target === 'root') parentCurves([d.it.id], null)
        else if (nodes[target]?.type === 'area') parentCurves([d.it.id], target)
        return
      }
      // Off its path: dropped anywhere else it is back where it stood.
      if (key && riding.has(`${d.it.kind}${d.it.id}`)) { useUndoCoordinator.getState().checkpoint(); unparentFromPath(key); return }
      if (target === 'root') {
        // Off the set it lies on: out past its right side. A model listed
        // by its scene lies on the set its row is under by its card's
        // middle (its scene's rule), anything else by where it is listed
        // from. (A model listed under a set its card is only docked along,
        // or in a row with the set's card, does not lie on the set to be
        // taken off it: its card is moved on the canvas.)
        const sc = key && d.it.scene ? sceneOf(key) : null
        const a = sc && !sc.docked ? sc.area : areaAt(nodes, d.it.cx, d.it.cy, d.it.kind === 'node' && nodes[d.it.id]?.type === 'area' ? d.it.id : undefined)
        if (!a) return
        useUndoCoordinator.getState().checkpoint()
        moveItemTo(d.it, a.x + a.width + a.width * 0.15, d.it.cy)
        return
      }
      const a = nodes[target]
      if (!a) return
      useUndoCoordinator.getState().checkpoint()
      // Into the Area: set down in its middle, a little apart from what is
      // already there.
      const n = (kids.get(a.id)?.length ?? 0)
      const step = Math.min(a.width, a.height) * 0.08
      moveItemTo(d.it, a.x + a.width / 2 + (n % 5 - 2) * step, a.y + a.height / 2 + (Math.floor(n / 5) % 5 - 2) * step)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const Row = ({ it, depth, drop: onSet }: { it: Item; depth: number; drop?: boolean }): React.ReactElement => {
    // A path takes models: lit only while a model is dragged over it.
    const dropId = onSet ? it.id : it.path ? `curve:${it.id}` : undefined
    const drop = !!dropId && over === dropId && (onSet || (!!dragging && !!modelKeyOf(dragging)))
    return (
    <div
      data-outline-drop={dropId}
      onPointerDown={e => down(e, it)}
      onDoubleClick={() => { if (it.kind !== 'viewer') setNaming(`${it.kind}${it.id}`) }}
      title={onSet ? 'Drag rows onto a 3D set to put them on it · double-click to rename' : it.path ? 'Click to select · double-click to rename · drag a model onto it and the model rides this path' : 'Click to select · double-click to rename · drag onto a 3D set, or a model onto a path to ride it'}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, height: 24, paddingLeft: 6 + depth * 14, paddingRight: 6,
        borderRadius: 5, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden',
        background: drop ? 'rgba(95,227,155,0.18)' : isSel(it) ? 'rgba(120,170,255,0.16)' : 'transparent',
        outline: drop ? '1px solid rgba(95,227,155,0.6)' : 'none',
        color: dragging?.id === it.id ? 'rgba(255,255,255,0.35)' : 'rgba(235,240,255,0.85)',
        userSelect: 'none',
      }}
    >
      <span style={{ width: 12, textAlign: 'center', color: it.kind === 'node' && it.icon === '▦' ? '#5fe39b' : 'rgba(160,200,255,0.8)' }}>{it.icon}</span>
      {naming === `${it.kind}${it.id}` ? (
        <input autoFocus defaultValue={it.name} onFocus={e => e.currentTarget.select()}
          onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') { e.currentTarget.value = it.name; e.currentTarget.blur() }
          }}
          onBlur={e => { renameItem(it, e.currentTarget.value); setNaming(null) }}
          style={{ flex: 1, minWidth: 0, height: 20, boxSizing: 'border-box', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(120,170,255,0.6)', borderRadius: 4, color: '#e8f0ff', fontSize: 12, padding: '0 4px', outline: 'none' }} />
      ) : <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</span>}
    </div>
    )
  }
  /** A row, and under a path the models riding it. */
  const rowOf = (it: Item, depth: number): React.ReactNode => (
    <React.Fragment key={`${it.kind}${it.id}`}>
      {Row({ it, depth })}
      {it.kind === 'curve' && (riders.get(it.id) ?? []).map(r => <React.Fragment key={`r${r.kind}${r.id}`}>{Row({ it: r, depth: depth + 1 })}</React.Fragment>)}
    </React.Fragment>
  )

  const tree = (a: FreeNodeData, depth: number): React.ReactNode => {
    const it: Item = { kind: 'node', id: a.id, name: !a.label || a.label === 'Area' ? '3D set' : a.label, icon: '▦', cx: a.x + a.width / 2, cy: a.y + a.height / 2 }
    const list = kids.get(a.id) ?? []
    return (
      <React.Fragment key={a.id}>
        {Row({ it, depth, drop: true })}
        {list.map(k => {
          const sub = k.kind === 'node' ? areas.find(x => x.id === k.id) : undefined
          return sub ? tree(sub, depth + 1) : rowOf(k, depth + 1)
        })}
      </React.Fragment>
    )
  }
  const topAreas = areas.filter(a => !areaAt(useFreeNodeStore.getState().nodes, a.x + a.width / 2, a.y + a.height / 2, a.id))
  const rootItems = root.filter(it => !(it.kind === 'node' && areas.some(a => a.id === it.id)))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <div data-outline-drop="root" style={{
        fontSize: 11, color: 'rgba(255,255,255,0.45)', padding: '2px 6px', borderRadius: 5,
        background: over === 'root' ? 'rgba(95,227,155,0.18)' : 'transparent',
      }}>Canvas</div>
      {topAreas.map(a => tree(a, 0))}
      {rootItems.map(it => rowOf(it, 0))}
      {!topAreas.length && !rootItems.length && (
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', padding: '2px 6px', lineHeight: 1.5 }}>3D sets, models and curves show here.</div>
      )}
    </div>
  )
}

/** A choice from a list: a button showing the one in use; pressed, the
 *  list opens under it, in the panel's own colours. */
const PickList: React.FC<{ value: string; options: { value: string; name: string }[]; title: string; onPick: (v: string) => void }> = ({ value, options, title, onPick }) => {
  const [at, setAt] = useState<{ x: number; y: number; w: number } | null>(null)
  const now = options.find(o => o.value === value) ?? options[0]
  return (
    <>
      <button data-pick-list="" title={title} aria-haspopup="listbox" aria-expanded={!!at}
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setAt(at ? null : { x: r.left, y: r.bottom + 4, w: r.width }) }}
        style={{ ...btnStyle(false, true), height: 30, justifyContent: 'space-between', color: '#e8f0ff' }}>
        <span>{now.name}</span>
        <svg {...svg(14)}><path d="M6 9l6 6 6-6" stroke={S} /></svg>
      </button>
      {at && ReactDOM.createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={() => setAt(null)} />
          <div role="listbox" data-pick-options="" onPointerDown={e => e.stopPropagation()}
            style={{ position: 'fixed', left: at.x, top: Math.min(at.y, window.innerHeight - options.length * 30 - 18), width: at.w, boxSizing: 'border-box', zIndex: 9999,
              background: '#1e1f30', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 9, boxShadow: '0 12px 40px rgba(0,0,0,0.6)', padding: '4px 0', fontFamily: 'system-ui, sans-serif' }}>
            {options.map(o => (
              <button key={o.value} role="option" aria-selected={o.value === value}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
                onMouseLeave={e => { e.currentTarget.style.background = o.value === value ? 'rgba(120,170,255,0.22)' : 'none' }}
                onClick={() => { setAt(null); if (o.value !== value) onPick(o.value) }}
                style={{ display: 'flex', alignItems: 'center', width: '100%', height: 30, padding: '0 12px', boxSizing: 'border-box', border: 'none', cursor: 'pointer', textAlign: 'left',
                  background: o.value === value ? 'rgba(120,170,255,0.22)' : 'none', color: '#e8f0ff', fontSize: 12 }}>
                {o.name}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}

const OUTLINE_H_KEY = 'vidbars.notesOutlineH'
/** The Outliner in a box of a height you set: drag its bottom edge. The
 *  list scrolls inside, so what is under it stays where it is. The height
 *  is remembered. */
const OutlinerBox: React.FC = () => {
  const [h, setH] = useState(() => {
    try { const v = +(localStorage.getItem(OUTLINE_H_KEY) ?? ''); return v >= 48 ? v : 132 } catch { return 132 }
  })
  const drag = useRef<{ y: number; h: number } | null>(null)
  const clamp = (v: number) => Math.max(48, Math.min(900, Math.round(v)))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
      <div data-outline-box="" style={{ height: h, overflowY: 'auto' }}><Outliner /></div>
      <div data-outline-size="" title="Drag to set the Outliner's height"
        onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { y: e.clientY, h } }}
        onPointerMove={e => { if (drag.current) setH(clamp(drag.current.h + e.clientY - drag.current.y)) }}
        onPointerUp={e => {
          if (!drag.current) return
          const v = clamp(drag.current.h + e.clientY - drag.current.y)
          drag.current = null
          setH(v)
          try { localStorage.setItem(OUTLINE_H_KEY, String(v)) } catch { /* private window */ }
        }}
        style={{ height: 10, cursor: 'ns-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none' }}>
        <div style={{ width: 34, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.22)' }} />
      </div>
    </div>
  )
}

export const NotesPanel: React.FC = () => {
  const open = useNotesUi(s => s.open)
  const folded = useNotesUi(s => s.collapsed)
  const tool = useNotesUi(s => s.tool)
  const color = useNotesUi(s => s.color)
  const width = useNotesUi(s => s.width)
  const endStart = useNotesUi(s => s.endStart)
  const endEnd = useNotesUi(s => s.endEnd)
  const unit = useNotesUi(s => s.unit)
  const opacity = useNotesUi(s => s.opacity)
  const flow = useNotesUi(s => s.flow)
  const mark = useNotesUi(s => s.mark)
  const smooth = useNotesUi(s => s.smooth)
  const dashOn = useNotesUi(s => s.dashOn)
  const dashGap = useNotesUi(s => s.dashGap)
  const selected = useNotesUi(s => s.selected)
  const [picker, setPicker] = useState<{ x: number; y: number; key: 'color' | 'markColor' | 'endColor' } | null>(null)
  const chev = useNotesUi(s => s.chev)
  const pulse = useNotesUi(s => s.pulse)
  const ping = useNotesUi(s => s.ping)
  const markColor = useNotesUi(s => s.markColor)
  const markSize = useNotesUi(s => s.markSize)
  const endColor = useNotesUi(s => s.endColor)
  const endSize = useNotesUi(s => s.endSize)
  const pingSpeed = useNotesUi(s => s.pingSpeed)
  const pingSize = useNotesUi(s => s.pingSize)
  const pingRings = useNotesUi(s => s.pingRings)
  const bulge = useNotesUi(s => s.bulge)
  const bulgeReach = useNotesUi(s => s.bulgeReach)
  const bulgeEase = useNotesUi(s => s.bulgeEase)
  const pulseSize = useNotesUi(s => s.pulseSize)
  const pulseColor = useNotesUi(s => s.pulseColor)
  const startScale = useNotesUi(s => s.startScale)
  const endScale = useNotesUi(s => s.endScale)
  const endReach = useNotesUi(s => s.endReach)
  const drawing = useCurveDraft(s => !!s.curve)
  const picked = useNotesUi(s => s.points.length > 0)
  // What the options at the top are for: a curve (one selected, or the
  // Curve tool in the hand), a pen line, the selected points.
  const kinds = useNotesStore(s => selected.map(id => s.curves[id]?.kind).filter(Boolean).join(','))
  const forCurve = tool === 'curve' || drawing || kinds.includes('bezier')
  const forLine = forCurve || tool === 'pen' || kinds.includes('free')
  const modelKeys = useSelectedModelKeys()
  const modelNotes = useSelectedModels()
  // The settings show the selected curve's own (the first, of several),
  // and follow it as the selection or the curve changes.
  const shownCurve = useNotesStore(s => selected.length ? s.curves[selected[0]] : undefined)
  const zoomNow = useCanvasStore(s => s.zoom)
  useEffect(() => { if (shownCurve) useNotesUi.setState(lookFrom(shownCurve, zoomNow)) }, [shownCurve, zoomNow])
  if (!open) return null

  /** A setting, and the same on the selected curves. */
  const apply = (patch: Parameters<typeof setLook>[0]) => {
    if (selected.some(id => useNotesStore.getState().curves[id])) useUndoCoordinator.getState().checkpoint()
    setLook(patch, useCanvasStore.getState().zoom)
  }
  /** The same without an undo step of its own (a slider's drag is one). */
  const slide = (patch: Parameters<typeof setLook>[0]) => setLook(patch, useCanvasStore.getState().zoom)
  /** One undo step for a whole drag of a slider. */
  const stepOnce = () => { if (selected.some(id => useNotesStore.getState().curves[id])) useUndoCoordinator.getState().checkpoint() }
  /** A colour of your own (the picker): one undo step for the whole pick. */
  const openPicker = (e: React.MouseEvent, key: 'color' | 'markColor' | 'endColor' = 'color') => {
    // Beside the panel, not over it.
    const r = e.currentTarget.getBoundingClientRect()
    const panel = e.currentTarget.closest('[data-notes-panel]')?.getBoundingClientRect()
    if (selected.some(id => useNotesStore.getState().curves[id])) useUndoCoordinator.getState().checkpoint()
    setPicker({ x: (panel?.left ?? r.left) - 232, y: Math.min(r.top - 60, window.innerHeight - 420), key })
  }
  const pickColor = (c: string) => { if (picker) slide({ [picker.key]: c }) }
  const pickerColor = picker ? (picker.key === 'color' ? color : (picker.key === 'markColor' ? markColor : endColor) ?? color) : color
  const unitOpts = UNITS.find(u => u.unit === unit) ?? UNITS[0]
  const custom = !NOTE_COLORS.includes(color)
  /** A part's own colour and size (the points' graphics, the ends):
   *  apart from the line's. */
  const partLook = (what: string, colorKey: 'markColor' | 'endColor', sizeKey: 'markSize' | 'endSize', col: string | null, size: number) => {
    const own = !!col && !NOTE_COLORS.includes(col)
    const ring = (on: boolean): React.CSSProperties => ({ height: 18, borderRadius: 9, cursor: 'pointer', padding: 0, border: on ? '2px solid #fff' : '2px solid rgba(255,255,255,0.15)', boxShadow: on ? '0 0 0 1px rgba(0,0,0,0.6)' : 'none' })
    return (
      <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(11, 1fr)', gap: 3 }}>
          <button onClick={() => apply({ [colorKey]: null })} title={`${what}: the line's colour`} aria-pressed={!col}
            style={{ ...ring(!col), background: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 3px, transparent 3px 6px)' }} />
          {NOTE_COLORS.map(c => (
            <button key={c} onClick={() => apply({ [colorKey]: c })} title={`${what}: ${c}`} aria-pressed={c === col} style={{ ...ring(c === col), background: c }} />
          ))}
          <button onClick={e => openPicker(e, colorKey)} title={`${what}: any colour, pick your own`} aria-pressed={own}
            style={{ ...ring(own), background: own ? col! : 'conic-gradient(#ff5a5a, #ffe14a, #5fe39b, #4fc3ff, #a98bff, #ff8fd1, #ff5a5a)' }} />
        </div>
        <NumSlide name="Size" val={size} min={0} max={120} top={600} tip={`${what}: how far across. 0: it goes with the line's thickness.`}
          begin={stepOnce} set={v => slide({ [sizeKey]: v })} />
      </>
    )
  }

  /** Smooth on or off, and the same on the selected curves (turned off, a
   *  curve keeps its shape: the handles it ran on become its own). */
  const setSmooth = (on: boolean) => {
    useNotesUi.setState({ smooth: on })
    const ns = useNotesStore.getState()
    const ids = selected.filter(id => ns.curves[id]?.kind === 'bezier' && !!ns.curves[id].smooth !== on)
    if (!ids.length) return
    useUndoCoordinator.getState().checkpoint()
    for (const id of ids) {
      const c = ns.curves[id]
      ns.updateCurve(id, on ? { smooth: true } : { smooth: false, pts: curvePoints(c) })
    }
  }
  const selectBtn = (
    <button key="select" style={btnStyle(!tool, !folded)} aria-pressed={!tool}
      title={SELECT_TIP}
      onClick={() => useNotesUi.setState({ tool: null, linking: null })}>
      <IcSelect />{!folded && <span>Select</span>}
    </button>
  )
  const toolBtns = [selectBtn, ...TOOLS.map(t => (
    <button key={t.id} style={btnStyle(tool === t.id, !folded)} title={t.tip} aria-pressed={tool === t.id}
      onClick={() => toggleTool(t.id)}>
      <t.Icon />{!folded && <span>{t.name}{t.id === 'curve' && drawing ? ' · drawing' : ''}</span>}
    </button>
  ))]

  return (
    <div
      data-notes-panel=""
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      style={{
        position: 'fixed', top: 64, right: 52, width: folded ? W_FOLDED : W_OPEN, maxHeight: 'calc(100vh - 96px)',
        display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
        background: 'rgba(12,13,22,0.94)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 14,
        boxShadow: '0 10px 30px rgba(0,0,0,0.55)', zIndex: 870, color: '#e8f0ff', userSelect: 'none',
        backdropFilter: 'blur(6px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: folded ? 'center' : 'space-between', height: 38, padding: folded ? 0 : '0 8px 0 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        {!folded && <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4 }}>Notes &amp; 3D tools</span>}
        <button style={{ ...btnStyle(false), width: 28, height: 28, borderRadius: 7 }} onClick={() => useNotesUi.setState({ collapsed: !folded })}
          title={folded ? 'Open the panel out' : 'Fold to an icon strip'}>
          <IcFold folded={folded} />
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: folded ? 6 : 14, padding: folded ? 7 : 12, overflowY: 'auto', alignItems: folded ? 'center' : 'stretch' }}>
        {folded ? (
          <>
            {toolBtns}
            <div style={{ width: 24, height: 1, background: 'rgba(255,255,255,0.1)' }} />
            <button style={btnStyle(!!endStart)} aria-pressed={!!endStart} title="Something on the start: on or off (open the panel to choose what)" onClick={() => apply({ endStart: endStart ? null : 'arrow' })}><IcArrowStart /></button>
            <button style={btnStyle(!!endEnd)} aria-pressed={!!endEnd} title="Something on the end: on or off (open the panel to choose what)" onClick={() => apply({ endEnd: endEnd ? null : 'arrow' })}><IcArrowEnd /></button>
            <button style={btnStyle(smooth)} aria-pressed={smooth} title={SMOOTH_TIP} onClick={() => setSmooth(!smooth)}><IcSmooth /></button>
            <PointTools folded />
            <div style={{ width: 20, height: 20, borderRadius: 10, background: color, border: '2px solid rgba(255,255,255,0.25)' }} title="Colour (open the panel to change)" />
          </>
        ) : (
          <>
            {/* The top stays put, an anchor: the tools, then the Outliner in a box of one height (it scrolls inside). What changes with the selection is underneath. */}
            <Section title="TOOLS">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 5 }}>
                {[{ id: null, Icon: IcSelect, name: 'Select', tip: SELECT_TIP }, ...TOOLS].map(t => {
                  const on = t.id ? tool === t.id : !tool
                  return (
                    <button key={t.name} title={t.tip} aria-pressed={on}
                      style={{ ...btnStyle(on), width: '100%', height: 46, flexDirection: 'column', gap: 2, fontSize: 9.5 }}
                      onClick={() => t.id ? toggleTool(t.id) : useNotesUi.setState({ tool: null, linking: null })}>
                      <t.Icon size={18} /><span>{t.name}</span>
                    </button>
                  )
                })}
              </div>
            </Section>
            <Section title="3D SET"><Area3dTools part="make" /></Section>
            <Section title="OUTLINER"><OutlinerBox /></Section>
            <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />
            {/* Underneath: the options of what is selected (or of the tool in the hand), and nothing else. */}
            {forLine && (
              <Block title="LINE">
              <Part title="COLOUR">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 3 }}>
                  {NOTE_COLORS.map(c => (
                    <button key={c} onClick={() => apply({ color: c })} title={c} aria-pressed={c === color}
                      style={{ height: 20, borderRadius: 10, background: c, cursor: 'pointer', padding: 0,
                        border: c === color ? '2px solid #fff' : '2px solid rgba(255,255,255,0.15)', boxShadow: c === color ? '0 0 0 1px rgba(0,0,0,0.6)' : 'none' }} />
                  ))}
                  {/* Any colour: the picker. Lit, showing it, while the colour in use is one of your own. */}
                  <button onClick={e => openPicker(e)} title="Any colour: pick your own" aria-pressed={custom}
                    style={{ height: 20, borderRadius: 10, cursor: 'pointer', padding: 0,
                      background: custom ? color : 'conic-gradient(#ff5a5a, #ffe14a, #5fe39b, #4fc3ff, #a98bff, #ff8fd1, #ff5a5a)',
                      border: custom ? '2px solid #fff' : '2px solid rgba(255,255,255,0.15)', boxShadow: custom ? '0 0 0 1px rgba(0,0,0,0.6)' : 'none' }} />
                </div>
                {forCurve && <NumSlide name="Opacity" val={opacity} min={5} max={100} tip="How solid the line is, in percent: lower lets what is behind it show through."
                  begin={stepOnce} set={v => slide({ opacity: v })} />}
                {picker && <ColorPickerPopup color={pickerColor} anchorX={picker.x} anchorY={picker.y} onChange={pickColor} onClose={() => setPicker(null)} />}
              </Part>
              <Part title={`THICKNESS · ${width}px`}>
                <Slide val={width} min={1} max={24} begin={stepOnce} set={v => slide({ width: v })} />
              </Part>
                {forCurve && (
              <Part title="PATTERN">
                <PickList value={unit} options={UNITS.map(u => ({ value: u.unit, name: u.name }))} title="What the line's pattern repeats" onPick={v => apply({ unit: v as CurveUnit })} />
                {/* That piece's own options. */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 9px', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 9, background: 'rgba(255,255,255,0.025)' }}>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <NumSlide name={unitOpts.a} val={dashOn} min={1} max={120} top={400} tip={`${unitOpts.aTip}.`} begin={stepOnce} set={v => slide({ dashOn: v })} />
                    <NumSlide name={unitOpts.b} val={dashGap} min={0} max={120} top={400} tip={`${unitOpts.bTip}.`} begin={stepOnce} set={v => slide({ dashGap: v })} />
                  </div>
                  {/* A road's own: its chevrons. */}
                  {unit === 'hatch' && (
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                      <NumSlide name="Point" val={chev} min={0} max={200} top={400} tip="How far each chevron points ahead, in percent of the road's width. 0: straight bars across."
                        begin={stepOnce} set={v => slide({ chev: v })} />
                      <button style={{ ...btnStyle(pulse, true), flex: '1 1 0', width: 'auto', height: 30, justifyContent: 'center', fontSize: 11.5 }} aria-pressed={pulse}
                        title="Pulse: on or off. On, a swell runs down the chevrons one after another." onClick={() => apply({ pulse: !pulse })}>Pulse</button>
                    </div>
                  )}
                  <NumSlide name="Motion" val={motionOf(flow)} min={-100} max={100} top={300} tip="How fast the pattern runs along the line towards its end, and how fast what rides the path goes when it has no arrival time. 0: still. 100: very fast (ten times what it could do before). It gains speed faster the higher it goes, so low numbers stay fine. Below 0: towards its start."
                    begin={stepOnce} set={v => slide({ flow: flowOf(v) })} />
                </div>
              </Part>
                )}
                {shownCurve?.kind === 'bezier' && <LineLayers c={shownCurve} ids={selected} />}
                {forCurve && (
              <Inset title="ENDS">
                {([['Start', 'endStart', endStart], ['End', 'endEnd', endEnd]] as const).map(([name, key, now]) => (
                  <div key={key} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                    <span style={{ width: 30, fontSize: 11, color: 'rgba(255,255,255,0.6)', flexShrink: 0 }}>{name}</span>
                    {ENDS.map(e => (
                      <button key={e.name} style={{ ...btnStyle(now === e.kind), flex: '1 1 0', width: 'auto', height: 30 }} aria-pressed={now === e.kind}
                        title={`${e.name} on the ${name.toLowerCase()}`} onClick={() => apply({ [key]: e.kind })}>
                        <IcEnd kind={e.kind} flip={key === 'endStart'} />
                      </button>
                    ))}
                  </div>
                ))}
                {partLook('The ends', 'endColor', 'endSize', endColor, endSize)}
                {/* The line and its pattern towards each end: growing or shrinking into it. */}
                <div style={{ display: 'flex', gap: 10 }}>
                  <NumSlide name="Line at start" val={startScale} min={0} max={400} top={2000} tip="How big the line and the pieces of its pattern are at the start of the line, in percent. 100: as everywhere else. Below: they shrink into the start (0: to nothing). Above: they grow."
                    begin={stepOnce} set={v => slide({ startScale: v })} />
                  <NumSlide name="Line at end" val={endScale} min={0} max={400} top={2000} tip="How big the line and the pieces of its pattern are at the end of the line, in percent. 100: as everywhere else. Below: they shrink into the end (0: to nothing). Above: they grow."
                    begin={stepOnce} set={v => slide({ endScale: v })} />
                </div>
                <NumSlide name="Over" val={endReach} min={0} max={600} top={5000} tip="How much of the line, from each end, changes size. 0: a length that goes with the line's thickness."
                  begin={stepOnce} set={v => slide({ endReach: v })} />
              </Inset>
                )}
                {forCurve && (
              <Inset title="POINTS">
                <div style={{ display: 'flex', gap: 5 }}>
                  <button style={{ ...btnStyle(smooth, true), ...THIRD, height: 30, flex: '0 0 auto', padding: '0 9px' }} aria-pressed={smooth} onClick={() => setSmooth(!smooth)} title={SMOOTH_TIP}><IcSmooth size={16} /><span>Smooth</span></button>
                  <button style={{ ...btnStyle(ping, true), ...THIRD, height: 30, flex: '0 0 auto', padding: '0 12px' }} aria-pressed={ping}
                    title="Ping: on or off. On, the points ping one after another along the path, a ring spreading from each. A point with its graphic switched off stays quiet." onClick={() => apply({ ping: !ping })}>Ping</button>
                  {shownCurve?.kind === 'bezier' && (
                    <button style={{ ...btnStyle(shownCurve.stems !== false, true), ...THIRD, height: 30, flex: '0 0 auto', padding: '0 9px' }} aria-pressed={shownCurve.stems !== false}
                      title="Heights: on or off, for this line. On, in 3D a thin line drops from each point off the ground down to the ground, showing how high the path runs there."
                      onClick={() => { useUndoCoordinator.getState().checkpoint(); const on = shownCurve.stems !== false; const ns = useNotesStore.getState(); for (const id of selected) if (ns.curves[id]?.kind === 'bezier') ns.updateCurve(id, { stems: on ? false : undefined }) }}>Heights</button>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 5 }}>
                  {MARKS.map(m => (
                    <button key={m.mark} style={{ ...btnStyle(mark === m.mark, true), ...THIRD, height: 30 }} aria-pressed={mark === m.mark}
                      title={`${m.tip}: on or off. It sits as the path runs there, twist and all.`} onClick={() => apply({ mark: mark === m.mark ? null : m.mark })}>{m.name}</button>
                  ))}
                </div>
                {partLook("The points' graphics", 'markColor', 'markSize', markColor, markSize)}
                {ping && (
                  <>
                    <span style={{ fontSize: 10.5, letterSpacing: 1, color: 'rgba(255,255,255,0.45)' }}>PING</span>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <NumSlide name="Speed" val={pingSpeed} min={10} max={400} top={1000} tip="How fast the points ping, in percent."
                        begin={stepOnce} set={v => slide({ pingSpeed: v })} />
                      <NumSlide name="Rings" val={pingRings} min={1} max={4} tip="How many rings each ping sends out, one after another."
                        begin={stepOnce} set={v => slide({ pingRings: v })} />
                    </div>
                    <NumSlide name="Size" val={pingSize} min={0} max={400} top={3000} tip="How far across a ping's rings spread. 0: it goes with the points' size."
                      begin={stepOnce} set={v => slide({ pingSize: v })} />
                  </>
                )}
                {mark === 'bulge' && (
                  <>
                    <span style={{ fontSize: 10.5, letterSpacing: 1, color: 'rgba(255,255,255,0.45)' }}>BULGE</span>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <NumSlide name="Size" val={bulge} min={0} max={500} top={3000} tip="How big the line and the pieces of its pattern are at each point, in percent. 100: no change. Above: they grow as they near the point. Below: they shrink (0: to nothing)."
                        begin={stepOnce} set={v => slide({ bulge: v })} />
                      <NumSlide name="Reach" val={bulgeReach} min={0} max={400} top={5000} tip="How far along the line, either side of each point, the size changes. 0: as far as the point's tangent handles reach, so longer handles give a longer bulge."
                        begin={stepOnce} set={v => slide({ bulgeReach: v })} />
                    </div>
                    <PickList value={bulgeEase} options={EASES} title="How the size falls away from the point" onPick={v => apply({ bulgeEase: v as CurveEase })} />
                    <div style={{ display: 'flex', gap: 5 }}>
                      <button style={{ ...btnStyle(pulseSize, true), flex: '1 1 0', width: 'auto', height: 30, justifyContent: 'center', fontSize: 11.5 }} aria-pressed={pulseSize}
                        title="Pulse size: on or off. On, the bulge beats: the size at the points swells and settles." onClick={() => apply({ pulseSize: !pulseSize })}>Pulse size</button>
                      <button style={{ ...btnStyle(pulseColor, true), flex: '1 1 0', width: 'auto', height: 30, justifyContent: 'center', fontSize: 11.5 }} aria-pressed={pulseColor}
                        title="Pulse colour: on or off. On, the line's colour beats towards white at the points." onClick={() => apply({ pulseColor: !pulseColor })}>Pulse colour</button>
                    </div>
                  </>
                )}
              </Inset>
                )}
                {picked && (
              <Inset title="SELECTED POINTS">
                <div style={{ display: 'flex', gap: 5 }}><PointTools folded={false} /></div>
                <PointMarkSwitch />
                <PointTwist />
                <button style={{ ...btnStyle(false, true), height: 30, justifyContent: 'center', fontSize: 11.5 }}
                  title="Reset rotation, for the selected points: no twist, and anything riding the path is turned there as the path has it (a camera's reframing at the point is forgotten)"
                  onClick={() => { useUndoCoordinator.getState().checkpoint(); resetPointTurn() }}>Reset rotation</button>
                <PointLabel />
                <PointSlow />
              </Inset>
                )}
              </Block>
            )}
            {!forLine && picked && (
              <Section title="SELECTED POINTS">
                <div style={{ display: 'flex', gap: 5 }}><PointTools folded={false} /></div>
                <PointMarkSwitch />
                <PointTwist />
                <button style={{ ...btnStyle(false, true), height: 30, justifyContent: 'center', fontSize: 11.5 }}
                  title="Reset rotation, for the selected points: no twist, and anything riding the path is turned there as the path has it (a camera's reframing at the point is forgotten)"
                  onClick={() => { useUndoCoordinator.getState().checkpoint(); resetPointTurn() }}>Reset rotation</button>
                <PointLabel />
                <PointSlow />
              </Section>
            )}
            {shownCurve?.kind === 'bezier' && <PathRiders c={shownCurve} />}
            {modelKeys.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Area3dTools part="selected" /></div>}
            <SelectedModels />
            {!forLine && !picked && !modelKeys.length && !modelNotes.length && (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 }}>Select something to see its options here.</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
