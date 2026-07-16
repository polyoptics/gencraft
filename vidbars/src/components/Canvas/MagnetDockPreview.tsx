// MagnetDockPreview.tsx — the "will snap here" affordance while dragging
// a model tile (or model-bearing deck) within MAGNET_RADIUS of a viewport
// window edge: a dashed ghost outline at the snapped rect + a bright
// accent line along the target edge. DeckOpenPreview's visual language,
// rendered as two cheap canvas-space divs. Mounted once in FreeCanvas.

import React from 'react'
import { useMagnetPreviewStore } from '../../store/magnetPreviewStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useCanvasStore } from '../../store/canvasStore'

export const MagnetDockPreview: React.FC = () => {
  const preview = useMagnetPreviewStore(s => s.preview)
  const win = useViewport3DStore(s => (preview ? s.windows[preview.windowId] : undefined))
  const zoom = useCanvasStore(s => s.zoom)
  if (!preview || !win) return null

  const lineTh = Math.max(1.5, 3 / zoom)
  const edgeLine: React.CSSProperties =
    preview.edge === 'left' ? { left: win.x - lineTh / 2, top: win.y, width: lineTh, height: win.height }
    : preview.edge === 'right' ? { left: win.x + win.width - lineTh / 2, top: win.y, width: lineTh, height: win.height }
    : preview.edge === 'top' ? { left: win.x, top: win.y - lineTh / 2, width: win.width, height: lineTh }
    : { left: win.x, top: win.y + win.height - lineTh / 2, width: win.width, height: lineTh }

  return (
    <>
      {/* Ghost outline at the snapped position */}
      <div style={{
        position: 'absolute',
        left: preview.x, top: preview.y,
        width: preview.width, height: preview.height,
        border: `${Math.max(1, 1.5 / zoom)}px dashed rgba(140,190,255,0.55)`,
        borderRadius: 10 / zoom,
        background: 'rgba(120,170,255,0.07)',
        pointerEvents: 'none',
        zIndex: 60,
      }} />
      {/* Accent line on the target window edge */}
      <div style={{
        position: 'absolute',
        ...edgeLine,
        background: 'rgba(140,190,255,0.8)',
        borderRadius: lineTh,
        boxShadow: `0 0 ${8 / zoom}px rgba(140,190,255,0.5)`,
        pointerEvents: 'none',
        zIndex: 60,
      }} />
    </>
  )
}
