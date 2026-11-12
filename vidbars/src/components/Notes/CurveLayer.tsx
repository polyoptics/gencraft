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
import { curvePath, ownsHandles, shownLine, patternOf, ringTube, markSize, markBar, alongEvery, flowShift, pointFrames, unitBars, markBars, barOf, dashPieces, fieldOf, fineLine, tintCss, pingSize, pingRings, PING, PING_ECHO, type P3, type Bar, type PathFrame3, type LineField } from '../../utils/curveGeom'

const SEL = 'rgba(120,180,255,0.95)'
/** A selected point (as its cube in 3D). */
const PICKED = '#ffe14a'

const f2 = (n: number) => Math.round(n * 100) / 100

/** Bars (canvas units, z up) seen from above, as one SVG path. */
const barsPath = (bars: Bar[]) => bars.map(b => `M${f2(b[0].x)} ${f2(b[0].y)}L${f2(b[1].x)} ${f2(b[1].y)}`).join('')

/** The graphic at a point (Curve.mark), seen from above, set to the path
 *  there: the corners of a cube, a crosshair, the line swelling. */
const MarkAt: React.FC<{ c: Curve; p: P3; f: PathFrame3 }> = ({ c, p, f }) => {
  // (A bulge is no shape of its own: it is the line's size there.)
  if (c.mark === 'bulge') return null
  return <path d={barsPath(markBars(c.mark as 'corners' | 'cross', p, f, markSize(c)))} fill="none" stroke={c.markColor ?? c.color} strokeWidth={markBar(c)} strokeLinecap="round" />
}

/** The pieces of a pattern that are things along the line (rings, wire
 *  cubes, a band of crossed lines), seen from above: a ring is edge on,
 *  a bar across the line. Each its own stroke. */
/** The time, thirty times a second while `runs` (as the 3D view steps). */
function useRunTime(runs: boolean): number {
  const [time, setTime] = useState(0)
  useEffect(() => {
    if (!runs) return
    const id = window.setInterval(() => setTime(performance.now() / 1000), 33)
    return () => window.clearInterval(id)
  }, [runs])
  return runs ? time : 0
}

const FlatUnits: React.FC<{ c: Curve; line: P3[]; unit: 'ring' | 'hatch' | 'cube' | 'plus'; on: number; period: number; field: LineField | null }> = ({ c, line, unit, on, period, field }) => {
  // Running, they step along thirty times a second (as in 3D).
  const time = useRunTime(!!c.flow || (!!c.pulse && unit === 'hatch') || !!field?.moves)
  const shift = flowShift(c, period, time)
  // Bars of one thickness and colour are one stroke.
  const groups = new Map<string, { w: number; col: string; d: string }>()
  const add = (w: number, tint: number, d: string) => {
    const key = `${Math.round(w * 16)}|${Math.round(tint * 16)}`
    const g = groups.get(key)
    if (g) g.d += d; else groups.set(key, { w, col: tintCss(c.color, tint), d })
  }
  if (unit !== 'ring') {
    const t = barOf(c)
    // (A pulsing road's chevrons are each as thick as the pulse makes them.)
    for (const b of unitBars(c, line, unit, on, period, shift, time, field)) add(t * (b[2] ?? 1), b[3] ?? 0, barsPath([b]))
    return <>{[...groups].map(([k, g]) => <path key={k} d={g.d} fill="none" stroke={g.col} strokeWidth={g.w} strokeLinecap="round" />)}</>
  }
  const tw = ringTube(c, on) * 2
  for (const s of alongEvery(line, period, (shift + on / 2) % period)) {
    const l = Math.hypot(s.d.x, s.d.y)
    const nx = l > 1e-6 ? -s.d.y / l : 1, ny = l > 1e-6 ? s.d.x / l : 0
    const k = field ? field.k(s.p.s ?? 0, time) : 1
    const h = on / 2 * k
    add(tw * Math.min(1, Math.max(0.3, k)), field ? field.tint(s.p.s ?? 0, time) : 0, `M${f2(s.p.x - nx * h)} ${f2(s.p.y - ny * h)}L${f2(s.p.x + nx * h)} ${f2(s.p.y + ny * h)}`)
  }
  return <>{[...groups].map(([k, g]) => <path key={k} d={g.d} fill="none" stroke={g.col} strokeWidth={g.w} strokeLinecap="butt" />)}</>
}

/** A line whose size changes along it (a bulge at its points, its ends
 *  growing or shrinking), seen from above: the line itself or its
 *  dashes as a band as wide as each place makes it, or its balls each
 *  as big as where it is. */
const FieldLine: React.FC<{ c: Curve; line: P3[]; field: LineField; pat: ReturnType<typeof patternOf>; closed: boolean }> = ({ c, line, field, pat, closed }) => {
  const time = useRunTime((!!c.flow && !!pat) || field.moves)
  const shift = pat ? flowShift(c, pat.period, time) : 0
  const tinted = !!c.pulseColor && c.mark === 'bulge'
  if (pat && pat.unit === 'ball') {
    return <>{alongEvery(line, pat.period, (shift + pat.on / 2) % pat.period).map((s, i) => (
      <circle key={i} cx={f2(s.p.x)} cy={f2(s.p.y)} r={f2(pat.on / 2 * field.k(s.p.s ?? 0, time))} fill={tinted ? tintCss(c.color, field.tint(s.p.s ?? 0, time)) : c.color} />
    ))}</>
  }
  const pieces = pat ? dashPieces(line, pat.on, pat.gap, shift, 600).filter(p => p.length > 1) : [line]
  const h = c.width / 2
  let whole = ''
  const quads: { d: string; col: string }[] = []
  const caps: { x: number; y: number; r: number; col: string }[] = []
  for (const piece of pieces) {
    const L: string[] = [], R: string[] = []
    const n = piece.length
    piece.forEach((p, i) => {
      const a = piece[Math.max(0, i - 1)], b = piece[Math.min(n - 1, i + 1)]
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1
      const g = h * field.k(p.s ?? 0, time)
      L.push(`${f2(p.x - dy / l * g)} ${f2(p.y + dx / l * g)}`)
      R.push(`${f2(p.x + dy / l * g)} ${f2(p.y - dx / l * g)}`)
    })
    if (tinted) {
      // Each stretch its own colour, a few places long.
      const span = 3
      for (let i = 0; i < n - 1; i += span) {
        const j = Math.min(n - 1, i + span)
        const mid = piece[Math.min(n - 1, i + 1)]
        const col = tintCss(c.color, field.tint(mid.s ?? 0, time))
        quads.push({ d: 'M' + L.slice(i, j + 1).join('L') + 'L' + R.slice(i, j + 1).reverse().join('L') + 'Z', col })
      }
    } else whole += 'M' + L.join('L') + 'L' + R.reverse().join('L') + 'Z'
    // The whole line's ends are round, as it is without a size along it.
    if (!pat && !closed) for (const p of [piece[0], piece[n - 1]]) caps.push({ x: p.x, y: p.y, r: h * field.k(p.s ?? 0, time), col: tinted ? tintCss(c.color, field.tint(p.s ?? 0, time)) : c.color })
  }
  return (
    <>
      {whole && <path d={whole} fill={c.color} stroke={c.color} strokeWidth={0.01} />}
      {quads.map((q, i) => <path key={i} d={q.d} fill={q.col} stroke={q.col} strokeWidth={Math.max(0.2, c.width * 0.04)} strokeLinejoin="round" />)}
      {caps.map((q, i) => <circle key={`c${i}`} cx={f2(q.x)} cy={f2(q.y)} r={f2(q.r)} fill={q.col} />)}
    </>
  )
}

const CurveShape: React.FC<{ c: Curve; zoom: number; hit: boolean; selected: boolean }> = React.memo(({ c, zoom, hit, selected }) => {
  const d = curvePath(c)
  // The line stops inside what stands on its ends; with nothing on them
  // it is the curve itself.
  const whole = shownLine(c, 24)
  const { ends } = whole
  // Its size along it (a bulge at its points, its ends growing or shrinking).
  const field = c.kind === 'bezier' ? fieldOf(c, whole.at, whole.len) : null
  const line = field ? fineLine(whole.line, Math.max(c.width * 0.75, whole.len / 400)) : whole.line
  const shown = ends.length ? (line.length > 1 ? 'M' + line.map(p => `${f2(p.x)} ${f2(p.y)}`).join('L') : '') : d
  const pat = patternOf(c)
  const period = pat ? pat.period : 0
  // The pattern, as lengths of the stroke: a ball is a round dot `on`
  // across. (Rings are FlatRings'.)
  const look = !pat ? { w: c.width, cap: 'round' as const, arr: undefined, off: 0 }
    : pat.unit === 'line' ? { w: c.width, cap: 'butt' as const, arr: `${pat.on} ${pat.gap}`, off: 0 }
    : { w: pat.on, cap: 'round' as const, arr: `0 ${period}`, off: -pat.on / 2 }
  const things = pat && pat.unit !== 'line' && pat.unit !== 'ball' ? pat.unit : null
  const frames = c.mark && c.kind === 'bezier' ? pointFrames(c) : []
  const shaped = new Set(ends.map(e => e.end ? c.pts.length - 1 : 0))
  return (
    <g>
      {selected && <path d={d} fill="none" stroke={SEL} strokeWidth={c.width + 4 / zoom} strokeLinecap="round" strokeLinejoin="round" opacity={0.45} />}
      <g opacity={c.opacity ?? 1}>
        {things && pat && line.length > 1 && <FlatUnits c={c} line={line} unit={things} on={pat.on} period={period} field={field} />}
        {field && !things && line.length > 1 && <FieldLine c={c} line={line} field={field} pat={pat} closed={!!c.closed && c.pts.length > 2} />}
        {shown && !things && !field && (
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
          if (e.kind === 'ball') return <circle key={i} cx={e.tip.x} cy={e.tip.y} r={s / 2} fill={c.endColor ?? c.color} />
          // Seen from above the shape points where the line runs on the canvas.
          const l = Math.hypot(e.dir.x, e.dir.y)
          const dx = l > 1e-6 ? e.dir.x / l : 1, dy = l > 1e-6 ? e.dir.y / l : 0
          const at = (u: number, v: number) => `${f2(e.tip.x + dx * u - dy * v)},${f2(e.tip.y + dy * u + dx * v)}`
          const pts = e.kind === 'arrow' ? `${at(0, 0)} ${at(-s, s * 0.46)} ${at(-s, -s * 0.46)}` : `${at(s / 2, s / 2)} ${at(-s / 2, s / 2)} ${at(-s / 2, -s / 2)} ${at(s / 2, -s / 2)}`
          return <polygon key={i} points={pts} fill={c.endColor ?? c.color} />
        })}
        {/* Its points ping one after another: a ring spreading from each, fading. */}
        {c.ping && c.kind === 'bezier' && (() => {
          const n = c.pts.length, sp = c.pingSpeed && c.pingSpeed > 0 ? c.pingSpeed : 1
          const cycle = (Math.max(n * PING.slot, PING.dur) + 0.5) / sp, far = pingSize(c), f = f2(PING.dur / sp / cycle), count = pingRings(c)
          return c.pts.map((p, i) => p.mark === false ? null : Array.from({ length: count }, (_, j) => {
            const begin = `${f2((i * PING.slot + j * PING_ECHO) / sp)}s`
            return (
              <circle key={`g${i}.${j}.${sp}.${count}`} cx={p.x} cy={p.y} r={0} fill="none" stroke={c.markColor ?? c.color} strokeWidth={far * 0.07} opacity={0}>
                <animate attributeName="r" values={`0;${f2(far)};${f2(far)}`} keyTimes={`0;${f};1`} dur={`${f2(cycle)}s`} begin={begin} repeatCount="indefinite" />
                <animate attributeName="opacity" values="1;0;0" keyTimes={`0;${f};1`} dur={`${f2(cycle)}s`} begin={begin} repeatCount="indefinite" />
              </circle>
            )
          }))
        })()}
        {/* The words by its points. */}
        {c.kind === 'bezier' && c.pts.map((p, i) => p.label ? (
          <text key={`t${i}`} x={p.x} y={p.y - 14 / zoom} textAnchor="middle" fontSize={13 / zoom} fontWeight={600} fontFamily="system-ui, sans-serif"
            fill={c.markColor ?? c.color} stroke="rgba(8,10,20,0.9)" strokeWidth={3 / zoom} strokeLinejoin="round" style={{ paintOrder: 'stroke', pointerEvents: 'none', userSelect: 'none' }}>{p.label}</text>
        ) : null)}
        {c.mark && c.kind === 'bezier' && c.pts.map((p, i) => p.mark === false || shaped.has(i) ? null : <MarkAt key={`m${i}`} c={c} p={{ x: p.x, y: p.y, z: p.z ?? 0 }} f={frames[i]} />)}
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
  // Each point's square sits as the path runs there.
  const frames = pointFrames(c)
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
            transform={`rotate(${f2(Math.atan2(frames[i].d.y, frames[i].d.x) * 180 / Math.PI)} ${p.x} ${p.y})`}
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
