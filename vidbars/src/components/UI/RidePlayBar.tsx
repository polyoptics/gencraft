// RidePlayBar — play and pause for what rides the paths of a 3D set, along
// the set's bottom (Brian 2026-11-13: "once there's motion and paths,
// things to play, then I think the canvas area needs to have some
// play/pause controls on the bottom of it. And a timeline, don't have any
// numbers on it. It just plays to the end of the longest-playing thing in
// the 3D scene. And we can pause it"; then: "I want along the bottom of
// each 3D set and I want it to play the stuff that's in its 3D set").
//
// Each set has its own clock (utils/pathRide): its bar plays the paths
// that belong to it (utils/curveParent), and no other set's. The bar is
// there while anything rides a path of the set, inside the set's bottom
// edge and as wide as the set, a fixed height on the screen; what is
// docked under the set (its card) is below it. Drawn in the overlay
// stage with the pieces, so tipped into 3D it lies on the set's ground.
// The line is the whole of the play: from the start to where the set's
// longest ride ends. Played to there it stops; Play again goes from the
// start. A press or a drag on the line goes to that moment.

import React, { useEffect, useRef } from 'react'
import { useNotesStore } from '../../store/notesStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useRideClock, rideTime, rideTotal, rideSetIds } from '../../utils/pathRide'

const H = 26, INSET = 6
/** Too narrow to hold a bar under `GONE` px; all there from `FULL`. */
const GONE = 90, FULL = 130
const TONE = '#ffe14a'
/** Short of the very end: a ride that goes round again is back at its
 *  start at the end itself. */
const SHY = 0.001

const SetBar: React.FC<{ id: string }> = ({ id }) => {
  const a = useFreeNodeStore(s => s.nodes[id])
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const playing = useRideClock(s => !!s.clocks[id]?.playing)
  // (The paths as they are edited, and the clock set by hand: the line is
  // drawn again.)
  useNotesStore(s => s.curves)
  useRideClock(s => { const c = s.clocks[id]; return c ? `${c.base} ${c.stamp}` : '' })
  const track = useRef<HTMLDivElement>(null)
  const done = useRef<HTMLDivElement>(null)
  const knob = useRef<HTMLDivElement>(null)
  const total = Math.max(0.05, rideTotal(id))

  // Where the clock is on the line: set straight on it, each frame while
  // it plays.
  const show = () => {
    const f = Math.max(0, Math.min(1, rideTime(id) / total))
    if (done.current) done.current.style.width = `${f * 100}%`
    if (knob.current) knob.current.style.left = `${f * 100}%`
  }
  useEffect(show)
  useEffect(() => {
    if (!playing) return
    let raf = requestAnimationFrame(function beat() {
      // The end of the set's longest ride: it stops there.
      if (rideTime(id) >= total - SHY) { const c = useRideClock.getState(); c.pause(id); c.seek(total - SHY, id) }
      show()
      raf = requestAnimationFrame(beat)
    })
    return () => cancelAnimationFrame(raf)
  }, [id, playing, total])

  if (!a || a.type !== 'area' || a.pin) return null
  const w = a.width * zoom - INSET * 2
  if (w < GONE) return null
  const toggle = () => {
    const c = useRideClock.getState()
    if (c.clocks[id]?.playing) { c.pause(id); return }
    if (rideTime(id) >= total - SHY * 2) c.seek(0, id)
    c.play(id)
  }
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const to = (x: number) => {
      const r = track.current?.getBoundingClientRect()
      if (!r || r.width <= 0) return
      useRideClock.getState().seek(Math.max(0, Math.min(1, (x - r.left) / r.width)) * (total - SHY), id)
    }
    to(e.clientX)
    const move = (ev: PointerEvent) => to(ev.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  return (
    // (data-piece-set: folding into its card, and coming out, the set
    // takes the bar along as it does its pieces: utils/area3dCard.)
    <div data-ride-bar={id} data-piece-set={id} onPointerDown={e => e.stopPropagation()} style={{
      position: 'absolute', left: pan.x + a.x * zoom + INSET, top: pan.y + (a.y + a.height) * zoom - H - INSET, width: w, height: H,
      zIndex: 55, boxSizing: 'border-box', opacity: Math.min(1, (w - GONE) / (FULL - GONE)),
      display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px 0 4px', userSelect: 'none', pointerEvents: 'auto',
      background: 'rgba(19,20,31,0.92)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7,
    }}>
      <button data-ride-play="" aria-pressed={playing} onClick={toggle}
        title="Play: on or off. On, everything on a path in this 3D set rides it, to the end of the set's longest ride. Off, it holds where it is."
        style={{
          flex: '0 0 auto', width: 52, height: 18, borderRadius: 5, cursor: 'pointer', font: '11px system-ui, sans-serif',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: 0,
          color: playing ? '#1a1608' : 'rgba(235,240,255,0.85)',
          background: playing ? TONE : 'rgba(255,255,255,0.06)',
          border: playing ? `1px solid ${TONE}` : '1px solid rgba(255,255,255,0.14)',
        }}>
        <svg width="7" height="9" viewBox="0 0 8 10" aria-hidden="true"><path d="M0 0 L8 5 L0 10 Z" fill="currentColor" /></svg>
        Play
      </button>
      <div ref={track} data-ride-track="" onPointerDown={scrub} title="The whole play of this 3D set, start to end: press or drag to go to a moment"
        style={{ position: 'relative', flex: '1 1 0', minWidth: 0, height: '100%', cursor: 'ew-resize' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 3, marginTop: -1.5, borderRadius: 2, background: 'rgba(255,255,255,0.16)' }} />
        <div ref={done} style={{ position: 'absolute', left: 0, width: 0, top: '50%', height: 3, marginTop: -1.5, borderRadius: 2, background: TONE, opacity: 0.75 }} />
        <div ref={knob} data-ride-knob="" style={{ position: 'absolute', left: 0, top: '50%', width: 12, height: 12, margin: '-6px 0 0 -6px', borderRadius: '50%', background: TONE, border: '2px solid #12131f', boxSizing: 'border-box', boxShadow: '0 1px 4px rgba(0,0,0,0.6)', pointerEvents: 'none' }} />
      </div>
    </div>
  )
}

/** A Play bar along the bottom of every 3D set with something riding a
 *  path in it. */
export const SetPlayBars: React.FC = () => {
  // (rideSetIds reads the stores itself; these bring this round.)
  useNotesStore(s => s.curves)
  useFreeNodeStore(s => s.nodes)
  const ids = rideSetIds().filter(Boolean)
  if (!ids.length) return null
  return <>{ids.map(id => <SetBar key={id} id={id} />)}</>
}
