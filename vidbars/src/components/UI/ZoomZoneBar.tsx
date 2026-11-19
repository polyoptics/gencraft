// ZoomZoneBar — a vertical bar down the right edge of the canvas that shows
// the whole zoom range, bottom (all the way out) to top (all the way in).
//
//  - Three coloured zones: Cards, Blocks, Boards. Their lengths are how much
//    of the scroll wheel each level gets (the bar is log-scale, so equal
//    lengths are equal numbers of wheel notches).
//  - The two edges between zones are grips: drag them to give a level more
//    or less of the zoom. Double-click a grip to put it back.
//  - The white tick is where the canvas is now. Press or drag anywhere on
//    the track to zoom there.
//  - Hovering opens a panel with each zone's notches and the time spent in
//    it, so the split can be tuned from how the canvas is actually used.
//
// The boundaries live in zoomZonesStore, which every zoom-dependent value
// reads — moving a grip moves all of them together.

import React, { useEffect, useRef, useState } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { useTiltStore } from '../../store/tiltStore'
import {
  useZoomZonesStore, useZoomZone, zoomToBar, barToZoom, notchesBetween, currentZone,
  DEFAULT_CARD_MAX, DEFAULT_BLOCK_MAX, type ZoomZone,
} from '../../store/zoomZonesStore'
import { MIN_ZOOM, MAX_ZOOM } from '../../store/canvasStore'
import { CAMERA_DOCK_H, CAMERA_DOCK_W, ZOOM_BAR_W, DOCK_LINE, DOCK_SLIDE } from '../Canvas/tilt/ViewCube'
import { useNotesUi } from '../../store/notesStore'

const ZONES: { key: ZoomZone; label: string; color: string }[] = [
  { key: 'card',  label: 'Cards',  color: '#FFD24A' },
  { key: 'block', label: 'Blocks', color: '#4FC3FF' },
  { key: 'board', label: 'Boards', color: '#A98BFF' },
]
const TRACK_W = 14
const GRIP_H = 10
const PANEL_W = 210
const BAR_W = ZOOM_BAR_W
/** Same as App's title bar, so the bar reads as hanging from it. */
const HEADER_BG = '#080910'

function fmtTime(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ${Math.round(sec % 60)}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Counts time spent at each level while the window is in use. Flushed to
 *  the store every few seconds so it does not write on every tick. */
function useZoneTimer() {
  useEffect(() => {
    const pending: Record<ZoomZone, number> = { card: 0, block: 0, board: 0 }
    let ticks = 0
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        pending[currentZone()] += 1
      }
      if (++ticks % 5 === 0) {
        const add = useZoomZonesStore.getState().addTime
        for (const z of ['card', 'block', 'board'] as ZoomZone[]) {
          if (pending[z] > 0) { add(z, pending[z]); pending[z] = 0 }
        }
      }
    }, 1000)
    return () => window.clearInterval(id)
  }, [])
}

/** Zoom the canvas to `zoom`, keeping the middle of the canvas still. */
function zoomCanvasTo(zoom: number, host: HTMLElement | null) {
  const cs = useCanvasStore.getState()
  const r = host?.getBoundingClientRect()
  const mx = r ? r.width / 2 : window.innerWidth / 2
  const my = r ? r.height / 2 : window.innerHeight / 2
  cs.zoomAtPoint(zoom / cs.zoom, mx, my)
}

export const ZoomZoneBar: React.FC = () => {
  useZoneTimer()
  const zoom = useCanvasStore(s => s.zoom)
  // A tilted wheel zoom glides the plane first and takes the zoom when the
  // wheel rests: the marker follows the glide, as flat it follows the wheel.
  const glideK = useTiltStore(s => s.glide?.k ?? 1)
  const cardMax = useZoomZonesStore(s => s.cardMax)
  const blockMax = useZoomZonesStore(s => s.blockMax)
  const open = useZoomZonesStore(s => s.barOpen)
  const timeIn = useZoomZonesStore(s => s.timeIn)
  const trackRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(false)
  const leaveTimer = useRef(0)
  const panelUnder = useNotesUi(s => s.open)
  const [dragging, setDragging] = useState<null | 'card' | 'block' | 'zoom'>(null)

  const tFromEvent = (e: React.PointerEvent | PointerEvent) => {
    const r = trackRef.current!.getBoundingClientRect()
    return 1 - (e.clientY - r.top) / r.height
  }

  const onGripDown = (which: 'card' | 'block') => (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDragging(which)
  }
  const onTrackDown = (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDragging('zoom')
    zoomCanvasTo(barToZoom(tFromEvent(e)), hostOf(trackRef.current))
  }
  const onMove = (e: React.PointerEvent) => {
    if (!dragging) return
    const z = barToZoom(tFromEvent(e))
    const st = useZoomZonesStore.getState()
    if (dragging === 'card') st.setBoundaries(z, st.blockMax)
    else if (dragging === 'block') st.setBoundaries(st.cardMax, z)
    else zoomCanvasTo(z, hostOf(trackRef.current))
  }
  const onUp = (e: React.PointerEvent) => {
    if (!dragging) return
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* not captured */ }
    setDragging(null)
  }

  const bounds: Record<ZoomZone, [number, number]> = {
    card: [MIN_ZOOM, cardMax], block: [cardMax, blockMax], board: [blockMax, MAX_ZOOM],
  }
  const totalNotches = notchesBetween(MIN_ZOOM, MAX_ZOOM)
  const here = currentZone()
  const totalTime = timeIn.card + timeIn.block + timeIn.board

  return (
    <div
      onPointerEnter={() => { window.clearTimeout(leaveTimer.current); setHover(true) }}
      // Its panel is across the view cube from it: time to get there.
      onPointerLeave={() => { window.clearTimeout(leaveTimer.current); leaveTimer.current = window.setTimeout(() => setHover(false), 450) }}
      onWheel={e => { e.stopPropagation(); zoomCanvasTo(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), hostOf(trackRef.current)) }}
      onContextMenu={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      style={{
        // Flush with the window's right frame, under the title bar's corner
        // button (ZoomZoneHeaderButton), and one piece with the view cube
        // and the camera's lens beside it (ViewCube): their height, a line
        // between. Folding squeezes it out to the frame as they move into
        // the corner, rather than unmounting.
        position: 'absolute', right: 0, top: 0, height: CAMERA_DOCK_H, width: BAR_W,
        zIndex: 900, userSelect: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center',
        background: 'rgba(12,13,22,0.94)', borderLeft: DOCK_LINE,
        borderBottom: panelUnder ? 'none' : '1px solid rgba(255,255,255,0.09)', backdropFilter: 'blur(6px)',
        padding: '6px 0 8px', boxSizing: 'border-box',
        transformOrigin: 'right', transform: open ? 'none' : 'scaleX(0)', opacity: open ? 1 : 0,
        transition: `transform ${DOCK_SLIDE}, opacity 120ms ease`,
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      <button
        title="Fold the zoom bar up into the corner"
        onClick={() => useZoomZonesStore.getState().setBarOpen(false)}
        style={{
          width: 22, height: 14, marginBottom: 4, padding: 0, cursor: 'pointer', lineHeight: '12px',
          background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.45)', fontSize: 11,
        }}
      >▲</button>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', marginBottom: 4, fontFamily: 'monospace' }}>in</div>

      {/* The track */}
      <div
        ref={trackRef}
        onPointerDown={onTrackDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        style={{
          position: 'relative', flex: 1, width: TRACK_W, borderRadius: 7,
          background: 'rgba(255,255,255,0.04)', cursor: 'ns-resize',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.1)',
        }}
      >
        <TrackFill bounds={bounds} here={here} />
        <Tick t={zoomToBar(zoom * glideK)} />
        {(['card', 'block'] as const).map(which => (
          <Grip
            key={which}
            t={zoomToBar(which === 'card' ? cardMax : blockMax)}
            active={dragging === which}
            title={which === 'card'
              ? 'Cards ↔ Blocks — drag to change where cards give way to blocks. Double-click to reset.'
              : 'Blocks ↔ Boards — drag to change where blocks give way to boards. Double-click to reset.'}
            onPointerDown={onGripDown(which)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onDoubleClick={e => {
              e.stopPropagation()
              const st = useZoomZonesStore.getState()
              if (which === 'card') st.setBoundaries(DEFAULT_CARD_MAX, st.blockMax)
              else st.setBoundaries(st.cardMax, DEFAULT_BLOCK_MAX)
            }}
          />
        ))}
      </div>

      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', marginTop: 4, fontFamily: 'monospace' }}>out</div>
      {/* Always in reach once the zones have been moved: one press puts all
          three back the way they came. */}
      {(cardMax !== DEFAULT_CARD_MAX || blockMax !== DEFAULT_BLOCK_MAX) && (
        <button
          title="Reset all zones to the default"
          onClick={() => useZoomZonesStore.getState().resetBoundaries()}
          style={{
            marginTop: 6, width: 34, height: 18, padding: 0, cursor: 'pointer',
            background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 4,
            color: 'rgba(255,255,255,0.75)', fontSize: 9, fontFamily: 'inherit', fontWeight: 700,
          }}
        >↺ Reset</button>
      )}

      {open && (hover || dragging) && (
        <div
          onPointerDown={e => e.stopPropagation()}
          style={{
            position: 'absolute', right: BAR_W + CAMERA_DOCK_W + 6, top: 6, width: PANEL_W,
            background: 'rgba(12,13,20,0.94)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8,
            padding: '10px 12px', color: 'rgba(255,255,255,0.8)', fontSize: 11, lineHeight: 1.5,
            boxShadow: '0 6px 24px rgba(0,0,0,0.5)', pointerEvents: dragging ? 'none' : 'auto',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontWeight: 700 }}>Zoom zones</span>
            <span style={{ fontFamily: 'monospace', color: 'rgba(255,255,255,0.5)' }}>
              {Math.round(zoomToBar(zoom) * 100)} · {Math.round(zoom * 100)}%
            </span>
          </div>
          {ZONES.slice().reverse().map(z => {
            const [lo, hi] = bounds[z.key]
            const n = notchesBetween(lo, hi)
            const share = totalTime > 0 ? Math.round((timeIn[z.key] / totalTime) * 100) : 0
            return (
              <div key={z.key} style={{
                display: 'grid', gridTemplateColumns: '10px 1fr auto', gap: 6, alignItems: 'center',
                padding: '2px 0', fontWeight: here === z.key ? 700 : 400,
              }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: z.color }} />
                <span>{z.label} <span style={{ color: 'rgba(255,255,255,0.4)' }}>
                  {Math.round(n)} notches · {Math.round((n / totalNotches) * 100)}%
                </span></span>
                <span style={{ fontFamily: 'monospace', color: 'rgba(255,255,255,0.55)' }}
                  title={`${share}% of your time`}>{fmtTime(timeIn[z.key])}</span>
              </div>
            )
          })}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <PanelButton onClick={() => useZoomZonesStore.getState().resetBoundaries()}>Reset all zones</PanelButton>
            <PanelButton onClick={() => useZoomZonesStore.getState().resetTime()}>Reset times</PanelButton>
          </div>
          <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.35)', fontSize: 10 }}>
            Drag the edges between colours. Press the bar to zoom there.
          </div>
        </div>
      )}
    </div>
  )
}

const hostOf = (el: HTMLElement | null) => el?.closest('[data-zoom-bar-host]') as HTMLElement | null

const TrackFill: React.FC<{ bounds: Record<ZoomZone, [number, number]>; here: ZoomZone }> = ({ bounds, here }) => (
  <>
    {ZONES.map(z => {
      const lo = zoomToBar(bounds[z.key][0]), hi = zoomToBar(bounds[z.key][1])
      const h = hi - lo
      return (
        <div key={z.key} style={{
          position: 'absolute', left: 2, right: 2,
          top: `${(1 - hi) * 100}%`, height: `${h * 100}%`,
          background: z.color, opacity: here === z.key ? 0.85 : 0.4,
          borderRadius: 5, transition: 'opacity 120ms',
          display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        }}>
          {h > 0.08 && (
            <span style={{
              writingMode: 'vertical-rl', transform: 'rotate(180deg)',
              fontSize: 8, fontWeight: 800, letterSpacing: 1, color: 'rgba(0,0,0,0.6)',
              pointerEvents: 'none', textTransform: 'uppercase',
            }}>{z.label}</span>
          )}
        </div>
      )
    })}
  </>
)

const Tick: React.FC<{ t: number }> = ({ t }) => (
  <div style={{
    position: 'absolute', left: -6, right: -6, top: `${(1 - t) * 100}%`, height: 0,
    pointerEvents: 'none',
  }}>
    <div style={{ position: 'absolute', left: 0, right: 0, top: -1, height: 2, background: '#fff', borderRadius: 1, boxShadow: '0 0 4px rgba(0,0,0,0.8)' }} />
    <div style={{
      position: 'absolute', left: -6, top: -5, width: 0, height: 0,
      borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: '6px solid #fff',
    }} />
  </div>
)

const Grip: React.FC<{
  t: number; active: boolean; title: string
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  onDoubleClick: (e: React.MouseEvent) => void
}> = ({ t, active, title, ...handlers }) => (
  <div
    title={title}
    {...handlers}
    style={{
      position: 'absolute', left: -5, right: -5, top: `calc(${(1 - t) * 100}% - ${GRIP_H / 2}px)`, height: GRIP_H,
      cursor: 'row-resize', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
  >
    <div style={{
      width: '100%', height: active ? 4 : 3, borderRadius: 2,
      background: active ? '#fff' : 'rgba(255,255,255,0.75)', boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
    }} />
  </div>
)

const PanelButton: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <button onClick={onClick} style={{
    flex: 1, height: 22, cursor: 'pointer', fontSize: 10, fontFamily: 'inherit',
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 5,
    color: 'rgba(255,255,255,0.7)',
  }}>{children}</button>
)

/** The zoom bar's home: the rightmost item of the title bar, in the window's
 *  top-right corner. The bar hangs straight down from it and folds back up
 *  into it. */
export const ZoomZoneHeaderButton: React.FC = () => {
  const open = useZoomZonesStore(s => s.barOpen)
  const zone = useZoomZone()
  return (
    <button
      title={open ? 'Fold the zoom bar up' : 'Show the zoom bar'}
      onClick={() => useZoomZonesStore.getState().setBarOpen(!open)}
      style={{
        // Out to the frame: cancels the title bar's right padding.
        alignSelf: 'stretch', width: BAR_W, marginRight: -16, padding: 0, cursor: 'pointer',
        background: open ? HEADER_BG : 'transparent',
        border: 'none', borderLeft: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 2,
      }}
    >
      {ZONES.slice().reverse().map(z => (
        <span key={z.key} style={{
          width: zone === z.key ? 14 : 10, height: 4, borderRadius: 2, background: z.color,
          opacity: zone === z.key ? 0.95 : 0.45, transition: 'width 120ms, opacity 120ms',
        }} />
      ))}
    </button>
  )
}
