// StickLayer — the measuring sticks (store/notesStore sticks) in the flat
// view: each lies on the canvas pointing up it, seen from its side, as
// the 3D view (three/stickOverlay) has it lying before it stands up.
// Drawn in the canvas's tilt stage in flat screen px (canvas x zoom + pan,
// as the curves are). In 3D the sticks are the 3D view's to draw. The
// mouse is utils/stickTool, which asks where they are rather than being
// pressed through these shapes.

import React, { useEffect } from 'react'
import { useNotesStore, type Stick } from '../../store/notesStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useStickUi } from '../../store/pathLive'
import { useTiltStore, isTilted } from '../../store/tiltStore'
import { useManip } from '../../store/manipStore'
import { ensureFontLoaded } from '../UI/TextFormatToolbar'
import { stickMeasures } from '../../utils/stickDock'
import { POLE_R, LOWER_R, LOWER_TOP, BASE_R, BASE_H, SIGN_W, SIGN_H, SIGN_CUT, SIGN_TEXT, NUM_H, CREAM, GREEN, ORANGE, DARK, ACCENT, DEFAULT_FONT, TICK, heightText, unitText, stickTicks } from '../../utils/stickGeom'

/** A tube seen from its side, `from` to `to` up the stick. */
const Tube: React.FC<{ r: number; from: number; to: number; fill: string }> = ({ r, from, to, fill }) =>
  <rect x={-r} y={-to} width={r * 2} height={to - from} fill={fill} />

/** The board's outline, its corners cut, `inset` in from its edge. */
const boardPath = (cy: number, inset: number) => {
  const w = SIGN_W - inset, h = SIGN_H - inset, c = SIGN_CUT
  return `M${-w + c} ${cy - h}L${w - c} ${cy - h}L${w} ${cy - h + c}L${w} ${cy + h - c}L${w - c} ${cy + h}L${-w + c} ${cy + h}L${-w} ${cy + h - c}L${-w} ${cy - h + c}Z`
}

/** One stick, in feet from its foot (y runs down the canvas: up it is −y). */
const StickShape: React.FC<{ s: Stick; selected: boolean; hotTop: boolean; docked: boolean }> = ({ s, selected, hotTop, docked }) => {
  const text = heightText(s)
  const cy = -(s.ft + 0.05 + SIGN_H)
  const ticks = stickTicks(s)
  const j = BASE_H + 0.08
  const top = LOWER_R + 0.035
  // The number's box: the board's upper part, over the rule.
  const textH = SIGN_H * 2 * SIGN_TEXT
  const size = Math.min(textH * 0.72, (SIGN_W * 2 - 0.3) / Math.max(1, text.length) * 1.7)
  return (
    <g transform={`translate(${s.x} ${s.y}) scale(${s.per})`}>
      {docked && <rect x={-BASE_R - 0.11} y={-0.025} width={BASE_R * 2 + 0.22} height={0.05} fill={ORANGE} />}
      <path d={`M${-BASE_R} 0L${BASE_R} 0L${top} ${-BASE_H}L${-top} ${-BASE_H}Z`} fill={selected ? ACCENT : GREEN} />
      <Tube r={LOWER_R + 0.03} from={BASE_H} to={j} fill={GREEN} />
      <Tube r={LOWER_R} from={j} to={LOWER_TOP - 0.07} fill={CREAM} />
      <Tube r={LOWER_R + 0.004} from={0.46} to={0.6} fill={ORANGE} />
      <Tube r={LOWER_R + 0.022} from={LOWER_TOP - 0.07} to={LOWER_TOP + 0.03} fill={GREEN} />
      <Tube r={POLE_R} from={LOWER_TOP + 0.03} to={s.ft - 0.05} fill={CREAM} />
      {ticks.map(t => <Tube key={t.at} r={TICK[t.k].r} from={t.at - TICK[t.k].h / 2} to={t.at + TICK[t.k].h / 2} fill={TICK[t.k].color} />)}
      <Tube r={POLE_R + 0.03} from={s.ft - 0.05} to={s.ft + 0.05} fill={GREEN} />
      {ticks.filter(t => t.label).map(t => (
        <text key={t.at} x={POLE_R + 0.14} y={-t.at} fontSize={NUM_H * 0.8} fontWeight={700} fontFamily={DEFAULT_FONT} dominantBaseline="central"
          fill="#fff" stroke="rgba(8,10,20,0.9)" strokeWidth={NUM_H * 0.16} strokeLinejoin="round" paintOrder="stroke">{t.label}</text>
      ))}
      <path d={boardPath(cy, 0)} fill={DARK} />
      <path d={boardPath(cy, 0.014)} fill={selected || hotTop ? ACCENT : GREEN} />
      <path d={boardPath(cy, 0.05)} fill={CREAM} />
      <text x={0} y={cy - SIGN_H + textH / 2 + 0.03} fontSize={size} fontWeight={700} fontFamily={s.font ?? DEFAULT_FONT} textAnchor="middle" dominantBaseline="central" fill={ORANGE}>{text}</text>
      <rect x={-SIGN_W + 0.1} y={cy - SIGN_H + textH} width={SIGN_W * 2 - 0.2} height={0.03} fill={ORANGE} />
      <text x={0} y={cy - SIGN_H + textH + (SIGN_H * 2 - textH) / 2} fontSize={(SIGN_H * 2 - textH) * 0.4} fontWeight={700} fontFamily={DEFAULT_FONT} letterSpacing={0.015} textAnchor="middle" dominantBaseline="central" fill={GREEN}>{unitText(s)}</text>
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
  // (Docking is worked out from where the cards are.)
  useBoardsStore(s => s.groups)
  const list = Object.values(sticks ?? {})
  // A number's font is fetched if it is not on the machine; the 3D view's
  // boards are drawn again when it has come.
  const fonts = [...new Set(list.map(s => s.font).filter(Boolean) as string[])].join('|')
  useEffect(() => {
    for (const f of fonts ? fonts.split('|') : []) {
      ensureFontLoaded(f)
      document.fonts?.load(`700 48px ${f}`).then(() => useStickUi.setState(u => ({ fontRev: u.fontRev + 1 })), () => {})
    }
  }, [fonts])
  if (!list.length || tilted || through) return null
  const docked = stickMeasures().docked
  return (
    <svg data-stick-layer="" style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}>
      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {list.map(s => <StickShape key={s.id} s={s} selected={selected === s.id} hotTop={hot === `${s.id}:top`} docked={docked.has(s.id)} />)}
      </g>
    </svg>
  )
}
