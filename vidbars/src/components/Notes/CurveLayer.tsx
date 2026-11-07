// CurveLayer — the canvas's curves and arrows (store/notesStore), drawn in
// the canvas's tilt stage over the cards, in flat screen px (canvas x zoom
// + pan, as the cards' overlay is): flat they are on the canvas, tilted
// they lie on the ground with everything else. The same drawing in 2D and
// 3D. The mouse is utils/notesTool.

import React from 'react'
import { useNotesStore, useNotesUi, type Curve } from '../../store/notesStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useCurveDraft } from '../../utils/notesTool'
import { curvePath, arrowHeads } from '../../utils/curveGeom'

const SEL = 'rgba(120,180,255,0.95)'

const CurveShape: React.FC<{ c: Curve; zoom: number; hit: boolean; selected: boolean }> = React.memo(({ c, zoom, hit, selected }) => {
  const d = curvePath(c)
  const heads = arrowHeads(c)
  return (
    <g>
      {selected && <path d={d} fill="none" stroke={SEL} strokeWidth={c.width + 4 / zoom} strokeLinecap="round" strokeLinejoin="round" opacity={0.45} />}
      <path d={d} fill="none" stroke={c.color} strokeWidth={c.width} strokeLinecap="round" strokeLinejoin="round" />
      {heads.map((h, i) => <polygon key={i} points={h} fill={c.color} stroke={c.color} strokeWidth={c.width * 0.5} strokeLinejoin="round" />)}
      {/* What the mouse grabs: wider than the line, so a thin one is easy to hit. */}
      <path
        d={d} fill="none" stroke="transparent" strokeWidth={Math.max(c.width, 12 / zoom)}
        data-curve-id={c.id}
        style={{ pointerEvents: hit ? 'stroke' : 'none', cursor: 'pointer' }}
      />
      {hit && heads.map((h, i) => <polygon key={`h${i}`} points={h} fill="transparent" data-curve-id={c.id} style={{ pointerEvents: 'all', cursor: 'pointer' }} />)}
    </g>
  )
})

/** A selected bezier's points and handles, to drag (a smooth one has
 *  points only: the line finds its own way through them). */
const Handles: React.FC<{ c: Curve; zoom: number }> = ({ c, zoom }) => {
  if (c.kind !== 'bezier') return null
  const r = 5 / zoom, hr = 3.8 / zoom, sw = 1.4 / zoom
  return (
    <g>
      {c.pts.map((p, i) => (
        <g key={i}>
          {(['in', 'out'] as const).map(side => {
            const h = side === 'in' ? p.hin : p.hout
            if (c.smooth || !h || (!h.x && !h.y)) return null
            return (
              <g key={side}>
                <line x1={p.x} y1={p.y} x2={p.x + h.x} y2={p.y + h.y} stroke={SEL} strokeWidth={sw} />
                <circle cx={p.x + h.x} cy={p.y + h.y} r={hr} fill="#0d1020" stroke={SEL} strokeWidth={sw}
                  data-curve-handle={`${c.id}:${i}:${side}`} style={{ pointerEvents: 'all', cursor: 'move' }} />
              </g>
            )
          })}
          <rect x={p.x - r} y={p.y - r} width={r * 2} height={r * 2} fill={SEL} stroke="#0d1020" strokeWidth={sw}
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
  const draft = useCurveDraft(s => s.curve)
  const hover = useCurveDraft(s => s.hover)
  const list = Object.values(curves)
  // With a tool in the hand, presses go to the tool, not to the curves.
  const hit = !tool
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
        {!draft && list.filter(c => selected.includes(c.id)).map(c => <Handles key={`h${c.id}`} c={c} zoom={zoom} />)}
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
