// The outline of what a toolbar button is about to place (utils/placeTool),
// on the mouse. Drawn in the canvas's tilt stage, over the cards' overlay,
// in flat screen px (canvas x zoom + pan, as the overlay draws): flat it is
// where the cursor is, tilted it lies on the ground under the cursor. Its
// line is a constant screen width at every zoom.

import React from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { usePlacing, placeBox, placesPoint } from '../../utils/placeTool'

const LINE = 'rgba(150,200,255,0.95)'

export const PlaceGhost: React.FC = () => {
  const kind = usePlacing(s => s.kind)
  const at = usePlacing(s => s.at)
  const free = usePlacing(s => s.free)
  // An effect over a loop strip: the strip marks where it goes in.
  const onRail = usePlacing(s => !!s.rail)
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  if (!kind || !at || onRail) return null
  const b = placeBox(kind, at, zoom, free)
  const left = b.left * zoom + pan.x, top = b.top * zoom + pan.y
  if (placesPoint(kind)) {
    const r = 7
    return (
      <div style={{
        position: 'absolute', left: left - r, top: top - r, width: r * 2, height: r * 2,
        borderRadius: '50%', border: `2px solid ${LINE}`, background: 'rgba(120,170,255,0.25)',
        pointerEvents: 'none', boxSizing: 'border-box',
      }} />
    )
  }
  return (
    <div style={{
      position: 'absolute', left, top, width: b.w * zoom, height: b.h * zoom,
      border: `1.5px dashed ${LINE}`, borderRadius: 6, background: 'rgba(120,170,255,0.08)',
      boxShadow: '0 0 0 1px rgba(0,0,0,0.35)',
      pointerEvents: 'none', boxSizing: 'border-box',
    }} />
  )
}
