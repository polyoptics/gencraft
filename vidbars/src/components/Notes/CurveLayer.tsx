// CurveLayer — the canvas's curves and arrows (store/notesStore), drawn in
// the canvas's tilt stage over the cards, in flat screen px (canvas x zoom
// + pan, as the cards' overlay is): flat they are on the canvas, tilted
// a pen line lies on the ground with everything else, and a curve (the
// Curve tool's) is drawn by the 3D view itself as a thing in the scene,
// its points at their heights (three/pathOverlay): here it is that curve
// seen from straight above. The mouse is utils/notesTool.

import React, { useEffect, useState } from 'react'
import { useNotesStore, useNotesUi, type Curve } from '../../store/notesStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useCurveDraft } from '../../store/pathLive'
import { useTiltStore, isTilted } from '../../store/tiltStore'
import { useManip } from '../../store/manipStore'
import { ptKey } from '../../utils/pathEdit'
import { curvePath, ownsHandles, shownLine, patternOf, ringTube, markSize, alongEvery, flowShift, type P3 } from '../../utils/curveGeom'

const SEL = 'rgba(120,180,255,0.95)'
/** A selected point (as its cube in 3D). */
const PICKED = '#ffe14a'

const f2 = (n: number) => Math.round(n * 100) / 100

/** The graphic at a point (Curve.mark), seen from above: the corners of
 *  a square, a crosshair, the line swelling. */
const MarkAt: React.FC<{ c: Curve; x: number; y: number }> = ({ c, x, y }) => {
  const m = markSize(c), t = Math.max(c.width * 0.3, m * 0.035)
  if (c.mark === 'bulge') return <circle cx={x} cy={y} r={Math.max(c.width * 1.5, 2.5)} fill={c.color} />
  if (c.mark === 'cross') return <path d={`M${f2(x - m / 2)} ${f2(y)}h${f2(m)}M${f2(x)} ${f2(y - m / 2)}v${f2(m)}`} fill="none" stroke={c.color} strokeWidth={t} />
  const h = m / 2, l = m * 0.26
  let d = ''
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) d += `M${f2(x + sx * (h - l))} ${f2(y + sy * h)}H${f2(x + sx * h)}V${f2(y + sy * (h - l))}`
  return <path d={d} fill="none" stroke={c.color} strokeWidth={t} strokeLinecap="square" strokeLinejoin="miter" />
}

/** Rings along a line, seen from above: each is edge on, a bar across the
 *  line. Each its own stroke, so one at a sharp turn stays a bar. */
const FlatRings: React.FC<{ c: Curve; line: P3[]; on: number; period: number }> = ({ c, line, on, period }) => {
  // Running, they step along thirty times a second (as in 3D).
  const [time, setTime] = useState(0)
  const runs = !!c.flow
  useEffect(() => {
    if (!runs) return
    const id = window.setInterval(() => setTime(performance.now() / 1000), 33)
    return () => window.clearInterval(id)
  }, [runs])
  let d = ''
  for (const s of alongEvery(line, period, (flowShift(c, period, time) + on / 2) % period)) {
    const l = Math.hypot(s.d.x, s.d.y)
    const nx = l > 1e-6 ? -s.d.y / l : 1, ny = l > 1e-6 ? s.d.x / l : 0
    d += `M${f2(s.p.x - nx * on / 2)} ${f2(s.p.y - ny * on / 2)}L${f2(s.p.x + nx * on / 2)} ${f2(s.p.y + ny * on / 2)}`
  }
  return <path d={d} fill="none" stroke={c.color} strokeWidth={ringTube(c, on) * 2} strokeLinecap="butt" />
}

const CurveShape: React.FC<{ c: Curve; zoom: number; hit: boolean; selected: boolean }> = React.memo(({ c, zoom, hit, selected }) => {
  const d = curvePath(c)
  // The line stops inside what stands on its ends; with nothing on them
  // it is the curve itself.
  const { line, ends } = shownLine(c, 24)
  const shown = ends.length ? (line.length > 1 ? 'M' + line.map(p => `${f2(p.x)} ${f2(p.y)}`).join('L') : '') : d
  const pat = patternOf(c)
  const period = pat ? pat.on + pat.gap : 0
  // The pattern, as lengths of the stroke: a ball is a round dot `on`
  // across. (Rings are FlatRings'.)
  const look = !pat ? { w: c.width, cap: 'round' as const, arr: undefined, off: 0 }
    : pat.unit === 'line' ? { w: c.width, cap: 'butt' as const, arr: `${pat.on} ${pat.gap}`, off: 0 }
    : { w: pat.on, cap: 'round' as const, arr: `0 ${period}`, off: -pat.on / 2 }
  const rings = pat?.unit === 'ring'
  const shaped = new Set(ends.map(e => e.end ? c.pts.length - 1 : 0))
  return (
    <g>
      {selected && <path d={d} fill="none" stroke={SEL} strokeWidth={c.width + 4 / zoom} strokeLinecap="round" strokeLinejoin="round" opacity={0.45} />}
      <g opacity={c.opacity ?? 1}>
        {rings && line.length > 1 && <FlatRings c={c} line={line} on={pat.on} period={period} />}
        {shown && !rings && (
          <path d={shown} fill="none" stroke={c.color} strokeWidth={look.w} strokeLinecap={look.cap} strokeLinejoin="round"
            strokeDasharray={look.arr} strokeDashoffset={look.off || undefined}>
            {/* The pattern runs along the line. */}
            {pat && !!c.flow && (
              <animate attributeName="stroke-dashoffset" from={c.flow > 0 ? look.off : look.off - period} to={c.flow > 0 ? look.off - period : look.off}
                dur={`${f2(Math.max(0.02, period / Math.abs(c.flow)))}s`} repeatCount="indefinite" />
            )}
          </path>
        )}
        {ends.map((e, i) => {
          const s = e.size
          if (e.kind === 'ball') return <circle key={i} cx={e.tip.x} cy={e.tip.y} r={s / 2} fill={c.color} />
          // Seen from above the shape points where the line runs on the canvas.
          const l = Math.hypot(e.dir.x, e.dir.y)
          const dx = l > 1e-6 ? e.dir.x / l : 1, dy = l > 1e-6 ? e.dir.y / l : 0
          const at = (u: number, v: number) => `${f2(e.tip.x + dx * u - dy * v)},${f2(e.tip.y + dy * u + dx * v)}`
          const pts = e.kind === 'arrow' ? `${at(0, 0)} ${at(-s, s * 0.46)} ${at(-s, -s * 0.46)}` : `${at(s / 2, s / 2)} ${at(-s / 2, s / 2)} ${at(-s / 2, -s / 2)} ${at(s / 2, -s / 2)}`
          return <polygon key={i} points={pts} fill={c.color} />
        })}
        {c.mark && c.kind === 'bezier' && c.pts.map((p, i) => p.mark === false || shaped.has(i) ? null : <MarkAt key={`m${i}`} c={c} x={p.x} y={p.y} />)}
      </g>
      {/* What the mouse grabs: wider than the line, so a thin one is easy to hit. */}
      <path
        d={d} fill="none" stroke="transparent" strokeWidth={Math.max(c.width, 12 / zoom)}
        data-curve-id={c.id}
        style={{ pointerEvents: hit ? 'stroke' : 'none', cursor: 'pointer' }}
      />
    </g>
  )
})

/** A selected bezier's points and handles, to drag. A point has handles
 *  to show when they are its own: on a curve set by hand, or broken off
 *  on a smooth one (the line finds the others itself); a corner has none. */
const Handles: React.FC<{ c: Curve; zoom: number; points: string[] }> = ({ c, zoom, points }) => {
  if (c.kind !== 'bezier') return null
  const r = 5 / zoom, hr = 3.8 / zoom, sw = 1.4 / zoom
  return (
    <g>
      {c.pts.map((p, i) => (
        <g key={i}>
          {(['in', 'out'] as const).map(side => {
            const h = side === 'in' ? p.hin : p.hout
            if (p.t === 'corner' || (c.smooth && !ownsHandles(p)) || !h || (!h.x && !h.y)) return null
            return (
              <g key={side}>
                <line x1={p.x} y1={p.y} x2={p.x + h.x} y2={p.y + h.y} stroke={SEL} strokeWidth={sw} />
                <circle cx={p.x + h.x} cy={p.y + h.y} r={hr} fill="#0d1020" stroke={SEL} strokeWidth={sw}
                  data-curve-handle={`${c.id}:${i}:${side}`} style={{ pointerEvents: 'all', cursor: 'move' }} />
              </g>
            )
          })}
          <rect x={p.x - r} y={p.y - r} width={r * 2} height={r * 2} fill={points.includes(ptKey(c.id, i)) ? PICKED : SEL} stroke="#0d1020" strokeWidth={sw}
            data-curve-anchor={`${c.id}:${i}`} style={{ pointerEvents: 'all', cursor: 'move' }} />
        </g>
      ))}
    </g>
  )
}

export const CurveLayer: React.FC = () => {
  const curves = useNotesStore(s => s.curves)
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const tool = useNotesUi(s => s.tool)
  const selected = useNotesUi(s => s.selected)
  const points = useNotesUi(s => s.points)
  // In 3D the curves are the 3D view's to draw; the pen lines stay here.
  const tilted = useTiltStore(s => isTilted(s))
  const through = useManip(s => s.through)
  const in3d = tilted || !!through
  const draftNow = useCurveDraft(s => s.curve)
  const draft = in3d && draftNow?.kind === 'bezier' ? null : draftNow
  const hover = useCurveDraft(s => s.hover)
  const list = Object.values(curves).filter(c => !in3d || c.kind !== 'bezier')
  // With a tool in the hand, presses go to the tool, not to the curves.
  const hit = !tool || tool === 'erase'
  // The next segment, to the cursor, while drawing.
  let preview: string | null = null
  if (draft && draft.kind === 'bezier' && hover && draft.pts.length && draft.smooth) {
    preview = curvePath({ ...draft, closed: false, pts: [...draft.pts, hover] })
  } else if (draft && draft.kind === 'bezier' && hover && draft.pts.length) {
    const l = draft.pts[draft.pts.length - 1]
    const c1 = { x: l.x + (l.hout?.x ?? 0), y: l.y + (l.hout?.y ?? 0) }
    preview = `M${l.x} ${l.y} C${c1.x} ${c1.y} ${hover.x} ${hover.y} ${hover.x} ${hover.y}`
  }
  if (!list.length && !draft) return null
  return (
    <svg
      data-curve-layer=""
      style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}
    >
      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {list.map(c => <CurveShape key={c.id} c={c} zoom={zoom} hit={hit} selected={selected.includes(c.id)} />)}
        {/* Points drag with any tool in the hand, except mid-drawing. */}
        {!draft && list.filter(c => selected.includes(c.id)).map(c => <Handles key={`h${c.id}`} c={c} zoom={zoom} points={points} />)}
        {draft && (
          <g opacity={0.95}>
            <CurveShape c={draft} zoom={zoom} hit={false} selected={false} />
            {preview && <path d={preview} fill="none" stroke={draft.color} strokeWidth={draft.width} strokeDasharray={`${6 / zoom} ${5 / zoom}`} opacity={0.7} />}
            {draft.kind === 'bezier' && draft.pts.map((p, i) => (
              <rect key={i} x={p.x - 4 / zoom} y={p.y - 4 / zoom} width={8 / zoom} height={8 / zoom} fill={i === 0 ? '#fff' : SEL} />
            ))}
          </g>
        )}
      </g>
    </svg>
  )
}
