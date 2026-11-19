// StickLayer — the measuring sticks (store/notesStore sticks) in the flat
// view: each lies on the canvas pointing up it, seen from straight above,
// as the 3D view (three/stickOverlay) has it lying before it stands up.
// Drawn in the canvas's tilt stage in flat screen px (canvas x zoom + pan,
// as the curves are). In 3D the sticks are the 3D view's to draw. The
// mouse is utils/stickTool, which asks where they are rather than being
// pressed through these shapes.

import React from 'react'
import { useNotesStore, type Stick } from '../../store/notesStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useStickUi } from '../../store/pathLive'
import { useTiltStore, isTilted } from '../../store/tiltStore'
import { useManip } from '../../store/manipStore'
import { STICK_FT, POLE_R, SIGN_R, BASE_R, BASE_H, MARK_R, MARK_H, NUM_H, RED, WHITE, MARK, DARK, ACCENT, feetText, stickBands, stickNumbers } from '../../utils/stickGeom'

/** One stick, in feet from its foot (y runs down the canvas: up it is −y). */
const StickShape: React.FC<{ s: Stick; selected: boolean; hotTop: boolean }> = ({ s, selected, hotTop }) => {
  const text = feetText(s.ft)
  const cy = -(s.ft + SIGN_R)
  return (
    <g transform={`translate(${s.x} ${s.y}) scale(${s.per})`}>
      {stickBands(s.ft).map(b => <rect key={b.from} x={-POLE_R} y={-b.to} width={POLE_R * 2} height={b.to - b.from} fill={b.red ? RED : WHITE} />)}
      <rect x={-BASE_R} y={-BASE_H} width={BASE_R * 2} height={BASE_H} fill={selected ? ACCENT : DARK} />
      {s.ft >= STICK_FT - 1e-6 && <rect x={-MARK_R} y={-(STICK_FT + MARK_H / 2)} width={MARK_R * 2} height={MARK_H} fill={MARK} />}
      {stickNumbers(s.ft).map(n => (
        <text key={n} x={POLE_R + 0.12} y={-n} fontSize={NUM_H * 0.8} fontWeight={700} fontFamily="system-ui, sans-serif" dominantBaseline="central"
          fill="#fff" stroke="rgba(8,10,20,0.9)" strokeWidth={NUM_H * 0.16} strokeLinejoin="round" paintOrder="stroke">{n}</text>
      ))}
      <circle cx={0} cy={cy} r={SIGN_R * 124 / 128} fill={DARK} />
      <circle cx={0} cy={cy} r={SIGN_R * 116 / 128} fill={selected || hotTop ? ACCENT : RED} />
      <circle cx={0} cy={cy} r={SIGN_R * 94 / 128} fill={WHITE} />
      <text x={0} y={cy} fontSize={SIGN_R * Math.min(0.8, 2.4 / text.length)} fontWeight={700} fontFamily="system-ui, sans-serif" textAnchor="middle" dominantBaseline="central" fill={DARK}>{text}</text>
    </g>
  )
}

export const StickLayer: React.FC = () => {
  const sticks = useNotesStore(s => s.sticks)
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const selected = useStickUi(s => s.selected)
  const hot = useStickUi(s => s.hot)
  const tilted = useTiltStore(s => isTilted(s))
  const through = useManip(s => s.through)
  const list = Object.values(sticks ?? {})
  if (!list.length || tilted || through) return null
  return (
    <svg data-stick-layer="" style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}>
      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {list.map(s => <StickShape key={s.id} s={s} selected={selected === s.id} hotTop={hot === `${s.id}:top`} />)}
      </g>
    </svg>
  )
}
