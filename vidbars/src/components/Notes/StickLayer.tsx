// StickLayer — the measuring sticks (store/notesStore sticks) in the flat
// view (Brian 2026-11-19: "from the top view... it's a little tab now
// that's docked onto the side"): flat, a stick is its board alone, lying
// over its base on the edge of what it is docked to, with a short ticked
// line along that edge. The board says how tall the stick is; with a
// card of its group selected, how tall that card is (several: the
// shortest to the tallest). Drawn in the canvas's tilt stage in flat
// screen px (canvas x zoom + pan, as the curves are). In 3D the sticks
// are the 3D view's to draw (three/stickOverlay). The mouse is
// utils/stickTool, which asks where they are rather than being pressed
// through these shapes.

import React, { useEffect } from 'react'
import { useNotesStore, type Stick } from '../../store/notesStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useStickUi } from '../../store/pathLive'
import { useTiltStore, isTilted } from '../../store/tiltStore'
import { useManip } from '../../store/manipStore'
import { ensureFontLoaded } from '../UI/TextFormatToolbar'
import { stickMeasures, stickMarks, tabText } from '../../utils/stickDock'
import { DOCK_LINE, SIGN_W, SIGN_H, SIGN_CUT, SIGN_TEXT, CREAM, GREEN, ORANGE, DARK, ACCENT, DEFAULT_FONT, tabOut, tabDepth, type Side } from '../../utils/stickGeom'

/** The board's outline, its corners cut, `inset` in from its edge. */
const boardPath = (cy: number, inset: number) => {
  const w = SIGN_W - inset, h = SIGN_H - inset, c = SIGN_CUT
  return `M${-w + c} ${cy - h}L${w - c} ${cy - h}L${w} ${cy - h + c}L${w} ${cy + h - c}L${w - c} ${cy + h}L${-w + c} ${cy + h}L${-w} ${cy + h - c}L${-w} ${cy - h + c}Z`
}

/** One stick's tab, in feet from its own point (on the edge it is docked by). */
const StickTab: React.FC<{ s: Stick; at: { x: number; y: number }; line: { x: number; y: number }; selected: boolean; hot: boolean; docked: boolean; side: Side | null }> = ({ s, at, line, selected, hot, docked, side }) => {
  const marks = stickMarks(s)
  const { text, unit } = tabText(s, marks)
  const ink = s.color ?? ORANGE
  const out = tabOut(side), depth = tabDepth(side)
  const cx = out.x * depth, cy = out.y * depth
  // The number's box: the board's upper part, over the rule.
  const textH = SIGN_H * 2 * SIGN_TEXT
  const size = Math.min(textH * 0.72, (SIGN_W * 2 - 0.3) / Math.max(1, text.length) * 1.7)
  // Along the edge, and the ticks' way out from it.
  const tx = -out.y, ty = out.x, L = DOCK_LINE / 2
  return (
    <g transform={`translate(${at.x} ${at.y}) scale(${s.per})`}>
      <g transform={`translate(${cx} ${cy})`}>
        <path d={boardPath(0, 0)} fill={DARK} />
        <path d={boardPath(0, 0.014)} fill={selected || hot ? ACCENT : GREEN} />
        <path d={boardPath(0, 0.05)} fill={CREAM} />
        <text x={0} y={-SIGN_H + textH / 2 + 0.03} fontSize={size} fontWeight={700} fontFamily={s.font ?? DEFAULT_FONT} textAnchor="middle" dominantBaseline="central" fill={ink}>{text}</text>
        <rect x={-SIGN_W + 0.1} y={-SIGN_H + textH} width={SIGN_W * 2 - 0.2} height={0.03} fill={ink} />
        <text x={0} y={-SIGN_H + textH + (SIGN_H * 2 - textH) / 2} fontSize={(SIGN_H * 2 - textH) * 0.4} fontWeight={700} fontFamily={DEFAULT_FONT} letterSpacing={0.015} textAnchor="middle" dominantBaseline="central" fill={GREEN}>{unit}</text>
      </g>
      {docked && (
        <g transform={`translate(${(line.x - at.x) / s.per} ${(line.y - at.y) / s.per})`} stroke={ORANGE} strokeLinecap="butt">
          <line x1={-tx * L} y1={-ty * L} x2={tx * L} y2={ty * L} strokeWidth={0.04} />
          {[-4, -3, -2, -1, 0, 1, 2, 3, 4].map(i => {
            const a = i / 4 * L, k = i % 2 === 0 ? 0.13 : 0.07
            return <line key={i} x1={tx * a} y1={ty * a} x2={tx * a + out.x * k} y2={ty * a + out.y * k} strokeWidth={0.028} />
          })}
        </g>
      )}
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
  // (Docking is worked out from where the cards are; the tab reads the
  // selected card's height.)
  useBoardsStore(s => s.groups)
  useBoardsStore(s => s.selectedGroupIds)
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
  const { docked, sides, at, line } = stickMeasures()
  return (
    <svg data-stick-layer="" style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}>
      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {list.map(s => <StickTab key={s.id} s={s} at={at.get(s.id) ?? s} line={line.get(s.id) ?? at.get(s.id) ?? s} selected={selected === s.id} hot={!!hot && hot.startsWith(`${s.id}:`)} docked={docked.has(s.id)} side={sides.get(s.id) ?? null} />)}
      </g>
    </svg>
  )
}
