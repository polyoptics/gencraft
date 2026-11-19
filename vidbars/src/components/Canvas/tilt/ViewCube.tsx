// ViewCube.tsx — the 3D view's cube, lens and Ortho (Brian 2026-11-18).
//
// In a corner of the 3D view: a small cube that turns as the view does, so
// it shows which way you are looking, with a side to click for each
// square-on view (altCamera jumpView). Under it the view's lens, typed in
// mm, and Ortho, its own on/off: a very long lens, near-flat (tiltStore
// lensMm / ortho).

import React, { useEffect, useRef, useState } from 'react'
import { useTiltStore, lensMmOf, LENS_MM_MIN, LENS_MM_MAX, ORTHO_MM } from '../../../store/tiltStore'
import { jumpView, type CubeFace } from './altCamera'

const SIZE = 54, HALF = SIZE / 2
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
        width: 44, boxSizing: 'border-box', padding: '3px 5px', borderRadius: 6, fontSize: 11, fontFamily: 'ui-monospace, monospace',
        textAlign: 'right', color: '#e8f0ff', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', outline: 'none',
      }} />
  )
}

export const ViewCube: React.FC = () => {
  const cubeRef = useRef<HTMLDivElement>(null)
  const ortho = useTiltStore(s => s.ortho)
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
      data-view-cube
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: 'absolute', left: 14, top: 14, width: 136, boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '8px 8px 7px',
        background: 'rgba(19,20,31,0.88)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10,
        color: 'rgba(255,255,255,0.5)', fontSize: 11, cursor: 'default', userSelect: 'none', pointerEvents: 'auto',
      }}
    >
      <div style={{ width: 96, height: 96, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div ref={cubeRef} style={{ width: SIZE, height: SIZE, position: 'relative', transformStyle: 'preserve-3d' }}>
          {FACES.map(f => (
            <button
              key={f.face}
              data-cube-face={f.face}
              title={f.face === 'TP' ? 'Top: straight down. Not locked into 3D, that is the flat canvas' : `${f.name}: jump to this view`}
              onClick={() => jumpView(f.face)}
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%' }}>
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
            fontSize: 11, padding: '3px 6px', cursor: 'pointer',
          }}
        >Ortho</button>
      </div>
    </div>
  )
}
