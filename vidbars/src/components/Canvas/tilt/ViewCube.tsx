// ViewCube.tsx — the view cube, and the camera's lens and Ortho under it
// (Brian 2026-11-18).
//
// Docked for good at the top right, over the Notes & 3D tools panel
// (Brian 2026-11-19: "in the top right above the menu. It can be in its
// own tight cube area, and then under it, we'll have a separate block
// that says "Camera Lens 50 mm" with the ortho button on/off. Then under
// that will be the expandable toolbar"). One column, the same in the flat
// view and in 3D, and of one size always, so nothing under it ever moves:
//  - the cube, in its own box: it turns as the view does, so it shows
//    which way you are looking, with a side to click for each square-on
//    view (altCamera jumpView); dragged, it is the camera in hand
//    (altCamera dragCube);
//  - Camera Lens: the view's lens, typed in mm, and Ortho, its own
//    on/off: a very long lens, near-flat (tiltStore lensMm / ortho);
//  - Fade distance: how much of the world stays round the middle of a
//    side view, in feet of the world scale (metres, the app in metric),
//    and Fade, its own on/off (utils/worldScale; Brian 2026-11-19);
//  - the panel (NotesPanel) hangs at CAMERA_DOCK_BOTTOM, open or folded.

import React, { useEffect, useRef, useState } from 'react'
import { useTiltStore, lensMmOf, LENS_MM_MIN, LENS_MM_MAX, ORTHO_MM } from '../../../store/tiltStore'
import { useWorldScale, FADE_FT_MIN, FADE_FT_MAX } from '../../../utils/worldScale'
import { useUnits } from '../../../store/unitsStore'
import { FT_PER_M } from '../../../utils/stickGeom'
import { jumpView, dragCube, cubeWasDragged, type CubeFace } from './altCamera'

const SIZE = 54, HALF = SIZE / 2
/** The column: where it is docked (the panel's own right edge, clear of
 *  the top bar), and its two boxes' sizes. */
const DOCK_TOP = 84, DOCK_RIGHT = 52, DOCK_W = 122, CUBE_H = 112, LENS_H = 58, FADE_H = 58, DOCK_GAP = 6
/** Where the panel docked under the column starts, from the window's top. */
export const CAMERA_DOCK_BOTTOM = DOCK_TOP + CUBE_H + DOCK_GAP + LENS_H + DOCK_GAP + FADE_H + DOCK_GAP
const BOX: React.CSSProperties = {
  width: DOCK_W, boxSizing: 'border-box', flexShrink: 0,
  background: 'rgba(12,13,22,0.94)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 12,
  boxShadow: '0 10px 30px rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)',
}
/** Each side on the cube, as the ground has it: the top faces the eye in
 *  the flat view, the front is the flat canvas's bottom edge. Its letters
 *  stand upright seen square on. */
const FACES: { face: CubeFace; name: string; at: string }[] = [
  { face: 'TP', name: 'Top', at: `translateZ(${HALF}px)` },
  { face: 'BT', name: 'Bottom', at: `rotateX(180deg) translateZ(${HALF}px)` },
  { face: 'FR', name: 'Front', at: `rotateX(-90deg) translateZ(${HALF}px)` },
  { face: 'BA', name: 'Back', at: `rotateZ(180deg) rotateX(-90deg) translateZ(${HALF}px)` },
  { face: 'RT', name: 'Right', at: `rotateZ(-90deg) rotateX(-90deg) translateZ(${HALF}px)` },
  { face: 'LF', name: 'Left', at: `rotateZ(90deg) rotateX(-90deg) translateZ(${HALF}px)` },
]

/** The view's lens, typed: Enter or clicking away sets it, Esc puts it back. */
const ViewLens: React.FC = () => {
  const mm = useTiltStore(lensMmOf)
  const shown = String(Math.round(mm * 10) / 10)
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const v = draft === null ? NaN : parseFloat(draft.replace(',', '.'))
    setDraft(null)
    if (!Number.isFinite(v) || draft!.trim() === shown) return
    useTiltStore.getState().setLensMm(v)
  }
  return (
    <input type="text" inputMode="decimal" value={draft ?? shown}
      title={`The 3D view's lens, in mm: type a number (${LENS_MM_MIN} to ${LENS_MM_MAX}). A long lens flattens the view, a short one deepens it`}
      onChange={e => setDraft(e.target.value)} onFocus={e => e.target.select()} onBlur={commit}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        else if (e.key === 'Escape') { setDraft(null); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()) }
      }}
      style={{
        width: 40, boxSizing: 'border-box', padding: '3px 5px', borderRadius: 6, fontSize: 11, fontFamily: 'ui-monospace, monospace',
        textAlign: 'right', color: '#e8f0ff', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', outline: 'none',
      }} />
  )
}

/** The fade distance, typed as the lens is: feet of the world scale, or
 *  metres with the app in metric. */
const FadeDistance: React.FC = () => {
  const ft = useWorldScale(s => s.fadeFt)
  const metric = useUnits(s => s.metric)
  const shown = String(Math.round((metric ? ft / FT_PER_M : ft) * 10) / 10)
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const v = draft === null ? NaN : parseFloat(draft.replace(',', '.'))
    setDraft(null)
    if (!Number.isFinite(v) || draft!.trim() === shown) return
    useWorldScale.getState().setFadeFt(metric ? v * FT_PER_M : v)
  }
  return (
    <input type="text" inputMode="decimal" value={draft ?? shown} data-fade-distance
      title={`How far round the middle of a side view stays in the 3D view, in ${metric ? 'metres' : 'feet'} of the world scale: type a number (${FADE_FT_MIN} to ${FADE_FT_MAX} ft). It is a size on the canvas: zooming does not change what is inside it. The world scale is set by dragging a measuring stick onto its icon, bottom left`}
      onChange={e => setDraft(e.target.value)} onFocus={e => e.target.select()} onBlur={commit}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        else if (e.key === 'Escape') { setDraft(null); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()) }
      }}
      style={{
        width: 40, boxSizing: 'border-box', padding: '3px 5px', borderRadius: 6, fontSize: 11, fontFamily: 'ui-monospace, monospace',
        textAlign: 'right', color: '#e8f0ff', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', outline: 'none',
      }} />
  )
}

export const ViewCube: React.FC = () => {
  const cubeRef = useRef<HTMLDivElement>(null)
  const ortho = useTiltStore(s => s.ortho)
  const fadeOn = useWorldScale(s => s.fadeOn)
  const metric = useUnits(s => s.metric)
  const [over, setOver] = useState<CubeFace | null>(null)
  // Turned straight on the element, every frame the view moves.
  useEffect(() => {
    const el = cubeRef.current!
    const turn = (s: { tilt: number; yaw: number; spin: number }) => {
      el.style.transform = `rotateX(${s.tilt}deg) rotateY(${s.yaw}deg) rotateZ(${s.spin}deg)`
    }
    turn(useTiltStore.getState())
    return useTiltStore.subscribe(turn)
  }, [])
  return (
    <div
      data-tilt-hud
      data-camera-dock
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onContextMenu={e => e.stopPropagation()}
      style={{
        position: 'fixed', top: DOCK_TOP, right: DOCK_RIGHT, width: DOCK_W, zIndex: 870,
        display: 'flex', flexDirection: 'column', gap: DOCK_GAP,
        color: 'rgba(255,255,255,0.5)', fontSize: 11, cursor: 'default', userSelect: 'none',
      }}
    >
      <div data-view-cube style={{ ...BOX, height: CUBE_H, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div onPointerDown={dragCube} title="Drag to turn the view; click a side to jump to it"
          style={{ width: 96, height: 96, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'grab', touchAction: 'none' }}>
          <div ref={cubeRef} style={{ width: SIZE, height: SIZE, position: 'relative', transformStyle: 'preserve-3d' }}>
            {FACES.map(f => (
              <button
                key={f.face}
                data-cube-face={f.face}
                title={f.face === 'TP' ? 'Top: click for straight down (not locked into 3D, that is the flat canvas). Drag the cube to turn the view' : `${f.name}: click to jump to this view. Drag the cube to turn the view`}
                onClick={() => { if (!cubeWasDragged()) jumpView(f.face) }}
                onPointerEnter={() => setOver(f.face)}
                onPointerLeave={() => setOver(o => (o === f.face ? null : o))}
                style={{
                  position: 'absolute', inset: 0, margin: 0, padding: 0, transform: f.at, backfaceVisibility: 'hidden',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
                  background: over === f.face ? '#4a6cb0' : '#2a2e42', border: '1px solid rgba(255,255,255,0.35)', borderRadius: 3,
                  color: over === f.face ? '#ffffff' : '#c9d3ee', fontSize: 15, fontWeight: 700, letterSpacing: 0.5,
                  fontFamily: 'ui-monospace, monospace', cursor: 'pointer',
                }}
              >{f.face}</button>
            ))}
          </div>
        </div>
      </div>
      <div data-camera-lens style={{ ...BOX, height: LENS_H, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5, padding: '0 7px' }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: 'rgba(255,255,255,0.62)', whiteSpace: 'nowrap' }}>CAMERA LENS</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <ViewLens />
          <span>mm</span>
          <span style={{ flex: 1 }} />
          <button
            aria-pressed={ortho}
            onClick={() => useTiltStore.getState().setOrtho(!ortho)}
            title={`Ortho: on or off. A near-flat view (a ${ORTHO_MM} mm lens): near and far the same size, for square-on views off the cube. Off, the lens typed here is back`}
            style={{
              background: ortho ? 'rgba(120,170,255,0.25)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6,
              color: ortho ? '#dfe8ff' : 'rgba(255,255,255,0.6)',
              fontSize: 11, padding: '3px 5px', cursor: 'pointer', flexShrink: 0,
            }}
          >Ortho</button>
        </div>
      </div>
      <div data-camera-fade style={{ ...BOX, height: FADE_H, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5, padding: '0 7px' }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: 'rgba(255,255,255,0.62)', whiteSpace: 'nowrap' }}>FADE DISTANCE</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <FadeDistance />
          <span style={{ width: 12 }}>{metric ? 'm' : 'ft'}</span>
          <span style={{ flex: 1 }} />
          <button
            aria-pressed={fadeOn}
            onClick={() => useWorldScale.getState().setFadeOn(!fadeOn)}
            title="Fade: on or off. On, coming round to a side view in 3D, what is further from the middle of the view than the distance typed here fades out. Off, everything stays"
            style={{
              background: fadeOn ? 'rgba(120,170,255,0.25)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6,
              color: fadeOn ? '#dfe8ff' : 'rgba(255,255,255,0.6)',
              fontSize: 11, padding: '3px 5px', cursor: 'pointer', flexShrink: 0,
            }}
          >Fade</button>
        </div>
      </div>
    </div>
  )
}
