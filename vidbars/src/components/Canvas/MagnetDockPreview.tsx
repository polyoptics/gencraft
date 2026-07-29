// MagnetDockPreview.tsx — the "will snap here" affordance, for EVERY magnet.
//
// A dashed ghost at the rect the dragged thing will land on, plus a bright
// line along the edge of whatever it is meeting. It used to appear only
// when a tile approached a Viewer, so panels snapping to each other gave no
// warning at all — you found out where it went by letting go. The magnet is
// one gesture, so it gets one affordance.
//
// Mounted twice: once in canvas space (FreeCanvas) and once in screen space
// (PinLayer). Each renders only its own `space`, because a pinned rect in
// canvas coordinates would be drawn somewhere else entirely.

import React from 'react'
import { useMagnetPreviewStore } from '../../store/magnetPreviewStore'
import { useCanvasStore } from '../../store/canvasStore'

export const MagnetDockPreview: React.FC<{ space?: 'canvas' | 'screen' }> = ({ space = 'canvas' }) => {
  const preview = useMagnetPreviewStore(s => s.preview)
  const zoom = useCanvasStore(s => s.zoom)
  if (!preview || preview.space !== space) return null

  // Screen-space previews are already in pixels; canvas ones counter-scale
  // so the ghost keeps a constant visual weight at any zoom.
  const k = space === 'screen' ? 1 : zoom
  const t = preview.target
  const lineTh = Math.max(1.5, 3 / k)

  const edgeLine: React.CSSProperties =
    preview.edge === 'left'
      ? { left: t.x - lineTh / 2, top: t.y, width: lineTh, height: t.height }
    : preview.edge === 'right'
      ? { left: t.x + t.width - lineTh / 2, top: t.y, width: lineTh, height: t.height }
    : preview.edge === 'top'
      ? { left: t.x, top: t.y - lineTh / 2, width: t.width, height: lineTh }
      : { left: t.x, top: t.y + t.height - lineTh / 2, width: t.width, height: lineTh }

  return (
    <>
      {/* Ghost outline at the landing rect */}
      <div style={{
        position: 'absolute',
        left: preview.x, top: preview.y,
        width: preview.width, height: preview.height,
        border: `${Math.max(1, 1.5 / k)}px dashed rgba(140,190,255,0.55)`,
        borderRadius: 10 / k,
        background: 'rgba(120,170,255,0.07)',
        pointerEvents: 'none',
        zIndex: 60,
      }} />
      {/* Accent line on the edge it will meet */}
      <div style={{
        position: 'absolute',
        ...edgeLine,
        background: 'rgba(140,190,255,0.8)',
        borderRadius: lineTh,
        boxShadow: `0 0 ${8 / k}px rgba(140,190,255,0.5)`,
        pointerEvents: 'none',
        zIndex: 60,
      }} />
    </>
  )
}
