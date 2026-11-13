// RidePlayBar — play and pause for what rides the paths, along the bottom
// of the canvas (Brian 2026-11-13: "once there's motion and paths, things
// to play, then I think the canvas area needs to have some play/pause
// controls on the bottom of it. And a timeline, don't have any numbers on
// it. It just plays to the end of the longest-playing thing in the 3D
// scene. And we can pause it").
//
// The one ride clock (utils/pathRide), which every path's riders go by.
// It is here while anything rides a path, the same size and in the same
// place flat or in 3D. The line is the whole of the play: from the start
// to where the longest ride ends. Played to there it stops; Play again
// goes from the start. A press or a drag on the line goes to that moment.

import React, { useEffect, useRef } from 'react'
import { useNotesStore } from '../../store/notesStore'
import { useRideClock, rideTime, rideTotal } from '../../utils/pathRide'

const W = 420, H = 34
/** Over the world clock's row (components/UI/WorldClock: 56 up, 50 high). */
const BOTTOM = 56 + 50 + 8
const TONE = '#ffe14a'
/** Short of the very end: a ride that goes round again is back at its
 *  start at the end itself. */
const SHY = 0.001

export const RidePlayBar: React.FC = () => {
  const any = useNotesStore(s => Object.values(s.curves).some(c => c.pts.length > 1 && !!c.riders?.length))
  const playing = useRideClock(s => s.playing)
  // (The paths as they are edited, and the clock set by hand: the line is
  // drawn again.)
  useNotesStore(s => any ? s.curves : null)
  useRideClock(s => any ? `${s.base} ${s.stamp}` : '')
  const track = useRef<HTMLDivElement>(null)
  const done = useRef<HTMLDivElement>(null)
  const knob = useRef<HTMLDivElement>(null)
  const total = any ? Math.max(0.05, rideTotal()) : 1

  // Where the clock is on the line: set straight on it, each frame while
  // it plays.
  const show = () => {
    const f = Math.max(0, Math.min(1, rideTime() / total))
    if (done.current) done.current.style.width = `${f * 100}%`
    if (knob.current) knob.current.style.left = `${f * 100}%`
  }
  useEffect(show)
  useEffect(() => {
    if (!any || !playing) return
    let raf = requestAnimationFrame(function beat() {
      // The end of the longest ride: it stops there.
      if (rideTime() >= total - SHY) { const c = useRideClock.getState(); c.pause(); c.seek(total - SHY) }
      show()
      raf = requestAnimationFrame(beat)
    })
    return () => cancelAnimationFrame(raf)
  }, [any, playing, total])

  if (!any) return null
  const toggle = () => {
    const c = useRideClock.getState()
    if (c.playing) { c.pause(); return }
    if (rideTime() >= total - SHY * 2) c.seek(0)
    c.play()
  }
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const to = (x: number) => {
      const r = track.current?.getBoundingClientRect()
      if (!r || r.width <= 0) return
      useRideClock.getState().seek(Math.max(0, Math.min(1, (x - r.left) / r.width)) * (total - SHY))
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
    <div data-ride-bar="" onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()} style={{
      position: 'absolute', left: '50%', bottom: BOTTOM, width: W, height: H, marginLeft: -W / 2, zIndex: 950, boxSizing: 'border-box',
      display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px 0 6px', userSelect: 'none',
      background: '#13141f', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
    }}>
      <button data-ride-play="" aria-pressed={playing} onClick={toggle}
        title="Play: on or off. On, everything on a path rides it, to the end of the longest ride. Off, it holds where it is."
        style={{
          flex: '0 0 auto', width: 54, height: 22, borderRadius: 6, cursor: 'pointer', font: '11.5px system-ui, sans-serif',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: 0,
          color: playing ? '#1a1608' : 'rgba(235,240,255,0.85)',
          background: playing ? TONE : 'rgba(255,255,255,0.06)',
          border: playing ? `1px solid ${TONE}` : '1px solid rgba(255,255,255,0.14)',
        }}>
        <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true"><path d="M0 0 L8 5 L0 10 Z" fill="currentColor" /></svg>
        Play
      </button>
      <div ref={track} data-ride-track="" onPointerDown={scrub} title="The whole play, start to end: press or drag to go to a moment"
        style={{ position: 'relative', flex: '1 1 0', height: '100%', cursor: 'ew-resize' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 3, marginTop: -1.5, borderRadius: 2, background: 'rgba(255,255,255,0.16)' }} />
        <div ref={done} style={{ position: 'absolute', left: 0, width: 0, top: '50%', height: 3, marginTop: -1.5, borderRadius: 2, background: TONE, opacity: 0.75 }} />
        <div ref={knob} data-ride-knob="" style={{ position: 'absolute', left: 0, top: '50%', width: 12, height: 12, margin: '-6px 0 0 -6px', borderRadius: '50%', background: TONE, border: '2px solid #12131f', boxSizing: 'border-box', boxShadow: '0 1px 4px rgba(0,0,0,0.6)', pointerEvents: 'none' }} />
      </div>
    </div>
  )
}
