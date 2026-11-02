import { useMemo } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { isTilted, useTiltStore } from '../store/tiltStore'

export interface ViewportRect {
  left: number
  top: number
  right: number
  bottom: number
}

const MARGIN = 200 // canvas-space px buffer to prevent pop-in

/**
 * Returns the visible canvas-space rectangle (with margin buffer).
 * Elements outside this rect can be safely skipped.
 */
export function useViewportBounds(): ViewportRect {
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const tilted = useTiltStore(s => isTilted(s))

  return useMemo(() => {
    // Tilted, the view reaches far past the flat screen (toward the
    // horizon, and round the sides as it turns), and a Viewer or tile
    // dragged out there was unmounted mid-drag: nothing is culled then.
    if (tilted) return { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity }
    const w = typeof window !== 'undefined' ? window.innerWidth : 1920
    const h = typeof window !== 'undefined' ? window.innerHeight : 1080
    return {
      left: -pan.x / zoom - MARGIN,
      top: -pan.y / zoom - MARGIN,
      right: -pan.x / zoom + w / zoom + MARGIN,
      bottom: -pan.y / zoom + h / zoom + MARGIN,
    }
  }, [pan.x, pan.y, zoom, tilted])
}

/** Check if a canvas-space rect intersects the viewport */
export function intersectsViewport(
  vp: ViewportRect,
  x: number, y: number, w: number, h: number,
): boolean {
  return x + w >= vp.left && x <= vp.right && y + h >= vp.top && y <= vp.bottom
}
