// RailViewerOverlay — a Viewer with loop strips docked to its left edge
// (utils/railViewer) shows the live "next" preview of the active one,
// over whatever the window holds. It follows the strip as it changes: a
// slider moved, an input stepped. Nothing here is stored: move the strips
// away and the window shows its own item again. FX off (the switch first in
// the image toolbar, and on the strip's preview) shows the picture before the
// effects instead.

import React, { useEffect, useLayoutEffect, useRef } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useRailRunStore } from '../../store/railRunStore'
import { useRailUiStore } from '../../store/railUiStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { railMembers } from '../../utils/rail'
import { railViewerDocks, viewerRail } from '../../utils/railViewer'
import { railBeforePicture } from '../../utils/fx/railChain'
import { railFullFrame } from '../../utils/fx/railFullFrame'
import { CounterScaled } from './ContentViews'
import { ImageStudio, tbBtn } from './ImageStudio'
import { pictureAreas, useLayersOut, useStripLayers } from './ExplodedStrip'
import { isTilted, useTiltStore } from '../../store/tiltStore'

const stop = (e: React.SyntheticEvent) => e.stopPropagation()


export const RailViewerOverlay: React.FC<{ windowId: string; fontSize: number }> = ({ windowId, fontSize }) => {
  const zoom = useCanvasStore(s => s.zoom)
  const nodes = useFreeNodeStore(s => s.nodes)
  const windows = useViewport3DStore(s => s.windows)
  const active = useRailUiStore(s => s.active)
  const docked = railViewerDocks(nodes, windows, zoom).get(windowId) ?? []
  const railId = viewerRail(docked, active)
  const fxOff = useRailUiStore(s => (railId ? !!s.fxOff[railId] : false))
  const preview = useRailRunStore(s => (railId ? s.preview[railId] : undefined))
  const layersOn = useStripLayers(s => s.on)
  // Exploded, the result has gone back into the stack behind this window,
  // which is left an open frame to see it through.
  const out = useLayersOut(s => (railId ? !!s[railId] : false))
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const frame = root.current?.closest<HTMLElement>('[data-viewport3d]')
    frame?.toggleAttribute('data-layers-out', out)
    return () => frame?.removeAttribute('data-layers-out')
  }, [out])
  // Where the picture sits, for the stack behind it. Read while flat: tilted,
  // the DOM's rects are the tilted ones.
  useLayoutEffect(() => {
    const measure = () => {
      if (isTilted(useTiltStore.getState())) return
      const area = root.current?.querySelector('canvas, img')?.parentElement
      const host = document.querySelector('[data-tilt-layers]')?.parentElement
      const w = useViewport3DStore.getState().windows[windowId]
      if (!area || !host || !w) return
      const r = area.getBoundingClientRect(), h = host.getBoundingClientRect()
      const { pan, zoom } = useCanvasStore.getState()
      pictureAreas.set(windowId, { x: (r.x - h.x - pan.x) / zoom - w.x, y: (r.y - h.y - pan.y) / zoom - w.y, width: r.width / zoom, height: r.height / zoom })
    }
    measure()
    const el = root.current
    if (!el) return
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    // The picture's own area too: its toolbar arriving resizes it, not the overlay.
    const area = el.querySelector('canvas, img')?.parentElement
    if (area) watch.observe(area)
    return () => watch.disconnect()
  })
  if (!railId) return null
  const rail = nodes[railId]
  const before = railBeforePicture(rail, railMembers(nodes).get(railId))
  const showBefore = fxOff ? before : null
  // The same switch as the one on the strip's preview.
  const fx = before && (
    <>
      <button
        data-rail-viewer-fx={fxOff ? 'off' : 'on'}
        style={tbBtn(!fxOff)}
        title="Effects: lit shows the result, dimmed the picture before them"
        onClick={() => useRailUiStore.getState().toggleFx(railId)}
      >FX</button>
      <button
        data-rail-viewer-layers=""
        style={tbBtn(layersOn)}
        title="Layers: lit, swinging sideways shows the strip's layers behind the Viewer"
        onClick={() => useStripLayers.getState().toggle()}
      >Layers</button>
    </>
  )
  const canvas = preview?.canvas ?? null
  const full = () => railFullFrame(railId)
  return (
    <div
      ref={root}
      data-rail-viewer={railId}
      onPointerDown={stop} onWheel={stop} onDoubleClick={stop}
      style={{ position: 'absolute', inset: 0, zIndex: 5, background: out ? 'transparent' : '#0c0d14', display: 'flex', flexDirection: 'column', pointerEvents: out ? 'none' : undefined }}
    >
      {/* Fixed height, one line: what it says changes while you work
          ("updating…", a save, a grip), and the picture under it must not
          move when it does. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 6px', height: Math.round(fontSize * 2.2), boxSizing: 'border-box', overflow: 'hidden', whiteSpace: 'nowrap', fontSize, color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.05)', flexShrink: 0 }}>
        <span style={{ color: '#d85a30' }}>⟳</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rail?.label || 'Loop strip'}</span>
        {docked.length > 1 && <span style={{ opacity: 0.55 }}>· {docked.indexOf(railId) + 1} of {docked.length} strips</span>}
        {preview?.running && <span style={{ marginLeft: 'auto', opacity: 0.55 }}>updating…</span>}
        {out && <button style={{ ...tbBtn(true), marginLeft: 'auto', pointerEvents: 'auto' }} title="Layers: lit, swinging sideways shows the strip's layers behind the Viewer" onClick={() => useStripLayers.getState().toggle()}>Layers</button>}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', visibility: out ? 'hidden' : undefined }}>
        {showBefore
          ? (
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
              <CounterScaled zoom={zoom}>
                <ImageStudio key="before" windowId={windowId} url={showBefore} name={rail?.label || 'Loop strip'} toolbarStart={fx} />
              </CounterScaled>
            </div>
          )
          : canvas
          ? (
            // The image tools stay on: pieces are cut straight from this
            // frame, at the size a Run would make (railFullFrame).
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
              <CounterScaled zoom={zoom}>
                <ImageStudio
                  key="live"
                  windowId={windowId}
                  url={`rail:${railId}`}
                  name={rail?.label || 'Loop strip'}
                  live={{ canvas, full }}
                  toolbarStart={fx}
                />
              </CounterScaled>
            </div>
          )
          : <span style={{ fontSize, color: 'rgba(255,255,255,0.45)' }}>{preview?.error ?? 'Dock pictures under the first column'}</span>}
      </div>
    </div>
  )
}
