// RailViewerOverlay — a Viewer with loop strips docked to its left edge
// (utils/railViewer) shows the live "next" preview of the active one,
// over whatever the window holds. It follows the strip as it changes: a
// slider moved, an input stepped. Nothing here is stored: move the strips
// away and the window shows its own item again.

import React from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useRailRunStore } from '../../store/railRunStore'
import { useRailUiStore } from '../../store/railUiStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { railViewerDocks, viewerRail } from '../../utils/railViewer'
import { CanvasMirror } from '../UI/CanvasMirror'

const stop = (e: React.SyntheticEvent) => e.stopPropagation()

export const RailViewerOverlay: React.FC<{ windowId: string; fontSize: number }> = ({ windowId, fontSize }) => {
  const zoom = useCanvasStore(s => s.zoom)
  const nodes = useFreeNodeStore(s => s.nodes)
  const windows = useViewport3DStore(s => s.windows)
  const active = useRailUiStore(s => s.active)
  const docked = railViewerDocks(nodes, windows, zoom).get(windowId) ?? []
  const railId = viewerRail(docked, active)
  const preview = useRailRunStore(s => (railId ? s.preview[railId] : undefined))
  if (!railId) return null
  const rail = nodes[railId]
  const canvas = preview?.canvas ?? null
  return (
    <div
      data-rail-viewer={railId}
      onPointerDown={stop} onWheel={stop} onDoubleClick={stop}
      style={{ position: 'absolute', inset: 0, zIndex: 5, background: '#0c0d14', display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', fontSize, color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.05)', flexShrink: 0 }}>
        <span style={{ color: '#d85a30' }}>⟳</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rail?.label || 'Loop strip'}</span>
        {docked.length > 1 && <span style={{ opacity: 0.55 }}>· {docked.indexOf(railId) + 1} of {docked.length} strips</span>}
        {preview?.running && <span style={{ marginLeft: 'auto', opacity: 0.55 }}>updating…</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {canvas
          ? <CanvasMirror source={canvas} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          : <span style={{ fontSize, color: 'rgba(255,255,255,0.45)' }}>{preview?.error ?? 'Dock pictures under the first column'}</span>}
      </div>
    </div>
  )
}
