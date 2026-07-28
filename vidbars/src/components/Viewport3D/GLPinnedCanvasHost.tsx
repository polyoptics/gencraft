// GLPinnedCanvasHost.tsx — the second WebGL canvas, for SCREEN-PINNED
// viewer windows.
//
// The world stratum's canvas is mounted BEFORE the world transform so GL
// pixels sit under every piece of canvas content — that is the "windows
// live under nodes" guarantee. A PINNED window is the opposite: it floats
// over the canvas like the Rolodex does, so its model has to paint above
// that content too. A canvas has exactly one z-position, so the two
// strata cannot share one.
//
// The cost is a second WebGL context, which is affordable (browsers cap
// around 8-16) and bounded at exactly two no matter how many windows are
// pinned — the renderer draws every pinned window into this one canvas
// via scissor rects, the same way the world stratum does. Both strata
// share the view registry, so a window keeps its scene, camera and loaded
// model across a placement flip.

import React, { useRef, useEffect } from 'react'
import { attachPinRenderer } from '../../three/viewportRenderer'

export const GLPinnedCanvasHost: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    return attachPinRenderer(canvasRef.current)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute', inset: 0,
        width: '100%', height: '100%',
        pointerEvents: 'none',
        display: 'block',
      }}
    />
  )
}
