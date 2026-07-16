// GLCanvasHost.tsx — mounts the single shared WebGL canvas inside the
// InfiniteCanvas root, BEFORE the world transform container, so GL pixels
// paint under every piece of canvas-space content (the "windows sit under
// other nodes" guarantee). Screen-space, non-interactive; all input goes
// through the Viewport3DFrame chrome divs in the world.

import React, { useRef, useEffect } from 'react'
import { attachRenderer } from '../../three/viewportRenderer'

export const GLCanvasHost: React.FC<{ containerRef: React.RefObject<HTMLDivElement | null> }> = ({ containerRef }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return
    return attachRenderer(canvasRef.current, containerRef.current)
  }, [containerRef])

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
