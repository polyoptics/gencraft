// WorldClock — the world clock's control, in the canvas's bottom-left
// corner, and its bar out to its right along the bottom (utils/worldClock, Brian 2026-11-10).
//
// One storyline is the world's timeline. Drag a storyline by its handle onto
// the control and it is that storyline: the control says its name, the
// target button beside it jumps the canvas to it, and the bar mirrors its
// time marker. Drag the bar's knob (or the storyline's own marker: they are
// the same marker) and every State change on that storyline up to it is
// made, so the State cards' output decks reform; drag back and they go back.
// Only output decks change what they show. Nothing else moves.
//
// Compact (Brian 2026-11-19: "the world clock is going to be shrunk down
// to its clock face icon, and the text will be in mouse over"): the clock
// is its face alone, and what it said is in its hover text. To its left is
// the world scale's icon (utils/worldScale), "an icon and no text": a
// measuring stick dragged onto it gives the world its scale. Clicked, its
// lineup comes out of it, over this row (components/UI/WorldScaleLine).
//
// The control and the bar are a fixed size and never move: the same in the
// flat and the tilted view. The stops on the bar are spaced evenly, in story
// order, however far apart they are on the storyline.

import React from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { scrubStoryline, storyClock } from '../Canvas/StorylineLayer'
import { MarkTags } from '../Layers/StateFace'
import { useWorldClockUi } from '../../utils/worldClock'
import { useWorldScale } from '../../utils/worldScale'
import { WorldScaleLine } from './WorldScaleLine'
import type { StateMark } from '../../utils/stateCard'

const TONE = '#9fe0ff'
const SCALE_W = 40, FACE_W = 40, JUMP_W = 30, GAP = 6
const CONTROL_LEFT = 12 + SCALE_W + GAP, CONTROL_W = FACE_W + JUMP_W
/** The control and its bar are one row, above the hint line and the tilted
 *  view's bar, so nothing is covered in either view. */
const ROW_BOTTOM = 56, ROW_H = 50
/** The track's inset from the bar's ends, for the knob and the end tags. */
const PAD = 28

/** Marker value <-> place along the bar (0..1): the stops evenly spaced,
 *  straight between them. */
function scale(lo: number, hi: number, stops: number[]) {
  const pts: [number, number][] = [[lo, 0], ...stops.map((v, i): [number, number] => [v, (i + 1) / (stops.length + 1)]), [hi, 1]]
  const toFrac = (v: number) => {
    for (let i = 1; i < pts.length; i++) {
      const [v0, f0] = pts[i - 1], [v1, f1] = pts[i]
      if (v <= v1 || i === pts.length - 1) return v1 === v0 ? f1 : f0 + (f1 - f0) * Math.max(0, Math.min(1, (v - v0) / (v1 - v0)))
    }
    return 0
  }
  const toValue = (f: number) => {
    for (let i = 1; i < pts.length; i++) {
      const [v0, f0] = pts[i - 1], [v1, f1] = pts[i]
      if (f <= f1 || i === pts.length - 1) return v0 + (v1 - v0) * Math.max(0, Math.min(1, (f - f0) / (f1 - f0)))
    }
    return lo
  }
  return { toFrac, toValue }
}

export const WorldClock: React.FC = () => {
  const open = useCanvasStore(s => s.worldClockOpen)
  const lineId = useCanvasStore(s => s.worldClockLine)
  const node = useFreeNodeStore(s => (lineId ? s.nodes[lineId] : undefined))
  const groups = useBoardsStore(s => s.groups)
  const hot = useWorldClockUi(s => s.hot)
  const scaleHot = useWorldScale(s => s.hot)
  const scaleSet = useWorldScale(s => s.per !== null)
  const scaleOpen = useWorldScale(s => s.open)
  const d = node?.type === 'storyline' ? node.storyline : undefined
  const clock = d?.dots?.length ? storyClock(d, groups) : null
  const name = d ? (d.title?.trim() || 'Storyline') : ''

  const jump = () => {
    if (!node || !d?.dots?.length) return
    const xs = d.dots.map(p => p.x), ys = d.dots.map(p => p.y)
    useCanvasStore.getState().jumpToPoint(node.x + (Math.min(...xs) + Math.max(...xs)) / 2, node.y + (Math.min(...ys) + Math.max(...ys)) / 2)
  }

  const lit = open || hot
  return (
    <>
      <button data-world-scale-drop
        onClick={() => useWorldScale.getState().setOpen(!scaleOpen)}
        aria-pressed={scaleOpen}
        title={`World scale: how big a foot is on the canvas, for the whole world. ${scaleSet ? 'Set from a measuring stick.' : 'Not set yet.'} Drag a measuring stick onto here to use its scale; the stick goes back where it was. It is a copy: scaling that stick afterwards changes nothing here until it is dropped again. The 3D view's fade distance is measured in it. Click to show or hide the lineup, where the cards you click stand at their heights; lit while it is out.`}
        style={{
          position: 'absolute', left: 12, bottom: ROW_BOTTOM, width: SCALE_W, height: ROW_H, zIndex: 950, boxSizing: 'border-box', padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, userSelect: 'none', cursor: 'pointer', fontFamily: 'inherit',
          background: scaleOpen || scaleHot ? '#1b2a3f' : '#13141f',
          border: scaleHot ? `1px solid ${TONE}` : scaleOpen ? '1px solid rgba(98,160,217,0.5)' : '1px solid rgba(255,255,255,0.12)',
          boxShadow: scaleHot ? `0 0 10px ${TONE}` : '0 2px 8px rgba(0,0,0,0.45)',
        }}>
        <span style={{ fontSize: 17, lineHeight: 1, opacity: scaleOpen || scaleHot ? 1 : 0.6 }}>📏</span>
      </button>
      {scaleOpen && <WorldScaleLine bottom={ROW_BOTTOM + ROW_H + GAP} />}
      <div data-world-clock-drop style={{
        position: 'absolute', left: CONTROL_LEFT, bottom: ROW_BOTTOM, width: CONTROL_W, height: ROW_H, zIndex: 950,
        display: 'flex', borderRadius: 8, overflow: 'hidden', userSelect: 'none',
        background: '#13141f',
        border: hot ? `1px solid ${TONE}` : lit ? '1px solid rgba(98,160,217,0.5)' : '1px solid rgba(255,255,255,0.12)',
        boxShadow: hot ? `0 0 10px ${TONE}` : '0 2px 8px rgba(0,0,0,0.45)',
      }}>
        <button
          data-world-clock-toggle
          onClick={() => useCanvasStore.getState().setWorldClockOpen(!open)}
          aria-pressed={open}
          title={`World clock: ${d ? name : 'no storyline yet, drag a storyline here'}. One storyline is the world's timeline, and every State card follows its time marker. Drag a storyline by its handle onto here to use it. Click to show or hide the bar; lit while it is out.`}
          style={{
            width: FACE_W, height: '100%', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: lit ? 'rgba(98,160,217,0.22)' : 'transparent', border: 'none', cursor: 'pointer',
            color: lit ? '#9ecbff' : 'rgba(255,255,255,0.6)', fontFamily: 'inherit', textAlign: 'left',
          }}
        >
          <span style={{ fontSize: 17, lineHeight: 1 }}>🕰️</span>
        </button>
        <button
          data-world-clock-jump
          onClick={jump}
          disabled={!d}
          title={d ? `Go to the world's storyline on the canvas: ${name}` : "Go to the world's storyline on the canvas (none yet)"}
          style={{
            width: JUMP_W, height: '100%', padding: 0, background: 'transparent', border: 'none',
            borderLeft: '1px solid rgba(255,255,255,0.1)', cursor: d ? 'pointer' : 'default',
            color: d ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.2)', fontSize: 14, fontFamily: 'inherit',
          }}
        >◎</button>
      </div>
      {open && <ClockBar lineId={clock ? lineId : null} clock={clock} linked={!!d} />}
    </>
  )
}

const ClockBar: React.FC<{
  lineId: string | null
  clock: ReturnType<typeof storyClock>
  linked: boolean
}> = ({ lineId, clock, linked }) => {
  const track = React.useRef<HTMLDivElement>(null)
  // Stops at one place along the storyline are one stop.
  const stops: { at: number; marks: StateMark[] }[] = []
  if (clock) for (const s of clock.stops) {
    const at = Math.max(-clock.lead, Math.min(clock.len + clock.lead, s.at))
    const last = stops[stops.length - 1]
    if (last && Math.abs(last.at - at) < 1e-6) last.marks = [...last.marks, ...s.marks]
    else stops.push({ at, marks: [...s.marks] })
  }
  // A stop at either end keeps its own place on the bar.
  const inner = clock ? stops.filter(s => s.at > -clock.lead && s.at < clock.len + clock.lead) : []
  const sc = clock ? scale(-clock.lead, clock.len + clock.lead, inner.map(s => s.at)) : null
  const frac = clock && sc ? sc.toFrac(clock.at) : 0

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !lineId || !sc || !track.current) return
    e.preventDefault(); e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    const r = track.current.getBoundingClientRect()
    const to = (x: number) => scrubStoryline(lineId, sc.toValue(Math.max(0, Math.min(1, (x - r.left) / r.width))))
    to(e.clientX)
    const move = (ev: PointerEvent) => to(ev.clientX)
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const slot = 100 / (inner.length + 1)
  return (
    <div data-world-clock-bar style={{
      position: 'absolute', left: CONTROL_LEFT + CONTROL_W + 8, right: 60, bottom: ROW_BOTTOM, height: ROW_H, zIndex: 950, userSelect: 'none',
      background: '#13141f', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8,
      boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
    }}>
      <div ref={track} data-world-clock-track onPointerDown={onDown}
        style={{ position: 'absolute', left: PAD, right: PAD, top: 0, bottom: 0, cursor: lineId ? 'ew-resize' : 'default' }}>
        {/* The line of time. */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 13, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.16)' }} />
        {clock && <div style={{ position: 'absolute', left: 0, width: `${frac * 100}%`, bottom: 13, height: 3, borderRadius: 2, background: TONE, opacity: 0.7 }} />}
        {/* Where changes happen, in story order, with what they are. */}
        {clock && sc && inner.map((s, i) => {
          const f = sc.toFrac(s.at)
          const done = s.at <= clock.at
          return (
            <React.Fragment key={i}>
              <div style={{ position: 'absolute', left: `${f * 100}%`, bottom: 9, width: 2, height: 11, marginLeft: -1, borderRadius: 1,
                background: done ? TONE : 'rgba(255,255,255,0.45)' }} />
              <div style={{ position: 'absolute', left: `${f * 100 - slot / 2}%`, width: `${slot}%`, top: 5, height: 17, overflow: 'hidden',
                display: 'flex', justifyContent: 'center', opacity: done ? 1 : 0.55, pointerEvents: 'none' }}>
                <div style={{ flexShrink: 0, maxWidth: '100%' }}><MarkTags marks={s.marks} font={9} /></div>
              </div>
            </React.Fragment>
          )
        })}
        {/* The knob: the storyline's own time marker, from here. */}
        {clock && (
          <div data-world-clock-knob style={{ position: 'absolute', left: `${frac * 100}%`, bottom: 5, width: 14, height: 18, marginLeft: -7,
            borderRadius: '4px 4px 7px 7px', background: TONE, border: '2px solid #12131f', boxShadow: '0 1px 6px rgba(0,0,0,0.6)', pointerEvents: 'none' }} />
        )}
        {!clock && (
          <div style={{ position: 'absolute', left: 0, right: 0, top: 6, textAlign: 'center', pointerEvents: 'none',
            fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
            {linked ? 'This storyline has no dots' : 'No storyline yet: drag one by its handle onto World clock'}
          </div>
        )}
        {clock && inner.length === 0 && (
          <div style={{ position: 'absolute', left: 0, right: 0, top: 6, textAlign: 'center', pointerEvents: 'none', fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
            No State changes on this storyline yet: right-click one of its dots or scene cards, State changes
          </div>
        )}
      </div>
    </div>
  )
}
