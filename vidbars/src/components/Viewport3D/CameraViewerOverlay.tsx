// CameraViewerOverlay — a Viewer set beside a 3D set (on it, or touching
// its side) can show what any of that set's cameras sees (Brian
// 2026-11-12: "if I put a 2D viewer beside a 3D set, I should be able to
// look through any active cameras there. And maybe with the Alt button,
// move around"). A chip per camera, each its own on/off: lit, the Viewer
// shows that camera's view over whatever it holds; none lit, the Viewer is
// as it was. The picture is drawn by the 3D view (Canvas/tilt/TiltModels
// cameraViews) a few times a second, flat or tilted; Alt-drag and
// Alt-wheel over it move the camera as when looking through it
// (Canvas/tilt/LookThrough). Nothing is stored: move the Viewer away and
// it shows its own item again.

import React, { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useModelScaleStore, CAMERA_LENS } from '../../store/tiltStore'
import { areaOfBox, sceneOf, dataKey } from '../../utils/area3dScene'
import { cardModel, cameraViews } from '../Canvas/tilt/TiltModels'
import { CAMERA_URL } from '../../three/primitives'
import { useRideClock, riderOf, rideSetOf } from '../../utils/pathRide'
import { useNotesStore } from '../../store/notesStore'

/** Which camera each Viewer shows, by Viewer id (not kept: a pick for now). */
const useCameraPick = create<{ of: Record<string, string> }>(() => ({ of: {} }))

const stop = (e: React.SyntheticEvent) => e.stopPropagation()

export const CameraViewerOverlay: React.FC<{ windowId: string; fontSize: number }> = ({ windowId, fontSize }) => {
  const win = useViewport3DStore(s => s.windows[windowId])
  const nodes = useFreeNodeStore(s => s.nodes)
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const picked = useCameraPick(s => s.of[windowId])
  const curves = useNotesStore(s => s.curves)
  const ref = useRef<HTMLCanvasElement>(null)
  const [, bump] = useState(0)
  void boards
  // The 3D set it is on or beside, and that set's cameras.
  const set = win && !win.pin ? areaOfBox({ x: win.x, y: win.y, width: win.width, height: win.height }, nodes)?.area : null
  const cameras = set
    ? groups.filter(g => !g.pin && cardModel(g.id)?.url === CAMERA_URL && sceneOf(`card:${g.id}`)?.area.id === set.id).map(g => ({ key: `card:${g.id}`, name: g.name || 'Camera' }))
    : []
  const key = cameras.some(c => c.key === picked) ? picked : null
  const lens = useModelScaleStore(s => (key ? s.lensOf[dataKey(key)] : undefined)) ?? CAMERA_LENS
  // The path its camera rides, and the clock of the set that path is in.
  const ride = key ? riderOf(key, curves) ?? riderOf(dataKey(key), curves) : null
  const clock = ride ? rideSetOf(ride.curve) : ''
  const playing = useRideClock(s => !!s.clocks[clock]?.playing)
  useEffect(() => {
    const canvas = ref.current
    if (!key || !canvas) return
    cameraViews.set(windowId, { key, canvas })
    bump(n => n + 1)
    return () => { cameraViews.delete(windowId) }
  }, [key, windowId])
  if (!cameras.length) return null
  const chip = (on: boolean): React.CSSProperties => ({
    fontSize, padding: `${fontSize * 0.12}px ${fontSize * 0.6}px`, borderRadius: fontSize * 0.4, cursor: 'pointer', whiteSpace: 'nowrap',
    background: on ? '#ffe14a' : 'rgba(19,20,31,0.85)', color: on ? '#1a1a1a' : 'rgba(232,240,255,0.85)',
    border: on ? '1px solid #ffe14a' : '1px solid rgba(255,255,255,0.22)', fontWeight: on ? 700 : 500,
  })
  const rides = !!ride
  return (
    <>
      {key && (
        <div data-camera-view={key} onWheel={e => { if (e.altKey) e.stopPropagation() }} onDoubleClick={stop}
          style={{ position: 'absolute', inset: 0, zIndex: 5, background: '#0c0d14', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          <canvas ref={ref} style={{ maxWidth: '100%', maxHeight: '100%', aspectRatio: String(lens.aspect), width: '100%', objectFit: 'contain', boxShadow: 'inset 0 0 0 1px rgba(255,225,74,0.5)' }} />
          <div style={{ position: 'absolute', left: fontSize * 0.5, bottom: fontSize * 0.4, fontSize: fontSize * 0.85, color: 'rgba(232,240,255,0.5)', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
            Alt-drag: turn · Alt+Shift-drag: slide · Alt+wheel: in and out
          </div>
        </div>
      )}
      <div onPointerDown={stop} onDoubleClick={stop}
        style={{ position: 'absolute', left: fontSize * 0.5, top: fontSize * 0.4, zIndex: 6, display: 'flex', gap: fontSize * 0.3, alignItems: 'center', maxWidth: '96%', overflow: 'hidden' }}>
        {cameras.map(c => (
          <button key={c.key} style={chip(c.key === key)} aria-pressed={c.key === key}
            title={`${c.name}: on or off. On, this Viewer shows what that camera of the 3D set sees.`}
            onClick={() => useCameraPick.setState(s => { const of = { ...s.of }; if (of[windowId] === c.key) delete of[windowId]; else of[windowId] = c.key; return { of } })}>
            {c.name}
          </button>
        ))}
        {rides && (
          <button style={chip(playing)} aria-pressed={playing} title="Play: on or off. On, the camera rides its path, and so does everything else on a path in its 3D set (one clock for the set)."
            onClick={() => playing ? useRideClock.getState().pause(clock) : useRideClock.getState().play(clock)}>Play</button>
        )}
      </div>
    </>
  )
}
