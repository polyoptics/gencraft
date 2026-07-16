// Viewport3DFrame.tsx — the canvas-space chrome for one 3D viewport
// window. The GL pixels paint on the shared screen-space canvas BELOW the
// world transform (see GLCanvasHost); this frame is a transparent-bodied
// div at z=1 (under free nodes z=5 and bars z≥2) providing: header
// (drag-move / rename-lite title / close), resize corner, orbit input on
// the body, and the loading/error/poster states.
//
// Interaction rules (FreeNode parity):
//  - header/body pointerdown button-0 stopPropagation (canvas never pans
//    from a window gesture); middle-mouse falls through → canvas pan.
//  - body onWheel MUST stopPropagation — dolly, not canvas zoom.
//  - orbit mutates the module OrbitState per move + requestRender();
//    flushed to the store once per gesture end (no store churn at 120 Hz).

import React, { useRef, useState, useCallback } from 'react'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useBoardsStore } from '../../store/boardsStore'
import { computeCarriedEntities } from '../../hooks/useDockedModels'
import { useViewStatus } from '../../hooks/useViewStatus'
import { getViewRuntime, requestRender, MIN_GL_PX } from '../../three/viewportRenderer'
import { clampPhi, panOrbit } from '../../three/orbitState'
import { useSeedHoverFromCursor } from '../../utils/pointerTracker'
import { ViewportSwitcherStrip } from './ViewportSwitcherStrip'

export const Viewport3DFrame: React.FC<{ id: string }> = React.memo(({ id }) => {
  const win = useViewport3DStore(s => s.windows[id])
  const moveWindow = useViewport3DStore(s => s.moveWindow)
  const resizeWindow = useViewport3DStore(s => s.resizeWindow)
  const removeWindow = useViewport3DStore(s => s.removeWindow)
  const saveCamera = useViewport3DStore(s => s.saveCamera)
  const zoom = useCanvasStore(s => s.zoom)
  const status = useViewStatus(id)

  const [isHovered, setIsHovered] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const dragLast = useRef({ x: 0, y: 0 })
  const resizeLast = useRef({ x: 0, y: 0 })
  const orbitLast = useRef({ x: 0, y: 0 })
  const orbitActive = useRef(false)
  const wheelSaveTimer = useRef<number | null>(null)

  useSeedHoverFromCursor(wrapperRef, setIsHovered)

  // ── Header drag-move — carries everything connected to the window
  //    (tile clusters + docked cards/decks), snapshotted at drag start so
  //    the whole assembly moves as one. ──
  const carried = useRef<{ tileIds: string[]; groupIds: string[] }>({ tileIds: [], groupIds: [] })
  const onHeaderDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as Element).closest('button')) return
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    carried.current = computeCarriedEntities(id)
    dragLast.current = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [id])
  const onHeaderMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const dx = (e.clientX - dragLast.current.x) / zoom
    const dy = (e.clientY - dragLast.current.y) / zoom
    moveWindow(id, dx, dy)
    if (carried.current.tileIds.length > 0) {
      useFreeNodeStore.getState().moveManyFreeNodes(carried.current.tileIds, dx, dy)
    }
    if (carried.current.groupIds.length > 0) {
      const bs = useBoardsStore.getState()
      bs.setGroupPosBatch(carried.current.groupIds.flatMap(gid => {
        const g = bs.groups.find(x => x.id === gid)
        return g ? [{ groupId: gid, originX: g.originX + dx, originY: g.originY + dy }] : []
      }))
    }
    dragLast.current = { x: e.clientX, y: e.clientY }
  }, [id, moveWindow, zoom])

  // ── Resize corner ──
  const onResizeDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    resizeLast.current = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])
  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    resizeWindow(id, (e.clientX - resizeLast.current.x) / zoom, (e.clientY - resizeLast.current.y) / zoom)
    resizeLast.current = { x: e.clientX, y: e.clientY }
  }, [id, resizeWindow, zoom])

  // ── Orbit / pan (body) — normalize by VISUAL height so feel is
  //    zoom-invariant. Left-drag orbits; Shift+left-drag or right-drag
  //    pans (trucks the orbit target). Middle-mouse falls through →
  //    canvas pan. ──
  const gestureMode = useRef<'orbit' | 'pan'>('orbit')
  const onBodyDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 2) return
    e.stopPropagation()
    if (status.status !== 'ready') return
    gestureMode.current = (e.button === 2 || e.shiftKey) ? 'pan' : 'orbit'
    orbitActive.current = true
    orbitLast.current = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [status.status])
  const onBodyMove = useCallback((e: React.PointerEvent) => {
    if (!orbitActive.current || !(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const view = getViewRuntime(id)
    if (!view) return
    const w = useViewport3DStore.getState().windows[id]
    if (!w) return
    const screenH = Math.max(40, w.height * zoom)
    const o = view.orbit
    const dx = e.clientX - orbitLast.current.x
    const dy = e.clientY - orbitLast.current.y
    if (gestureMode.current === 'pan') {
      panOrbit(o, view.camera, dx, dy, screenH)
    } else {
      o.theta -= dx * (Math.PI / screenH)
      o.phi = clampPhi(o.phi - dy * (Math.PI / screenH))
    }
    orbitLast.current = { x: e.clientX, y: e.clientY }
    requestRender()
  }, [id, zoom])
  const onBodyUp = useCallback(() => {
    if (!orbitActive.current) return
    orbitActive.current = false
    const view = getViewRuntime(id)
    if (view && view.status === 'ready') saveCamera(id, { ...view.orbit })
  }, [id, saveCamera])
  const onBodyWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()   // MANDATORY — else the canvas zooms mid-dolly
    const view = getViewRuntime(id)
    if (!view || view.status !== 'ready') return
    const o = view.orbit
    o.radius = Math.min(view.dollyMax, Math.max(view.dollyMin, o.radius * (e.deltaY > 0 ? 1.1 : 1 / 1.1)))
    requestRender()
    if (wheelSaveTimer.current !== null) window.clearTimeout(wheelSaveTimer.current)
    wheelSaveTimer.current = window.setTimeout(() => {
      const v = getViewRuntime(id)
      if (v && v.status === 'ready') useViewport3DStore.getState().saveCamera(id, { ...v.orbit })
    }, 400)
  }, [id])

  if (!win) return null

  const iz = 1 / zoom
  const headerH = 22 * iz
  const fontSize = 11 * iz
  const borderW = Math.max(1, 2 / zoom)
  const glTooSmall = win.width * zoom < MIN_GL_PX
  // Body message states — GL paints beneath; these overlay when GL isn't showing.
  const showEmpty = status.status === 'empty'
  const showLoading = status.status === 'loading'
  const showError = status.status === 'error'
  const showBodyOverlay = showEmpty || showLoading || showError || (glTooSmall && !showEmpty)

  return (
    <div
      ref={wrapperRef}
      data-viewport3d={id}
      style={{
        position: 'absolute',
        left: win.x,
        top: win.y - headerH,        // header sits ABOVE the GL body rect
        width: win.width,
        height: win.height + headerH,
        zIndex: 1,                    // under free nodes (5) and bars (≥2)
        display: 'flex',
        flexDirection: 'column',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* ── Header (rounded top; body corners stay square — CSS radius can't clip GL) ── */}
      <div
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        style={{
          display: 'flex', alignItems: 'center', gap: 6 * iz,
          height: headerH, flexShrink: 0,
          padding: `0 ${8 * iz}px`,
          background: isHovered ? 'rgba(30,34,58,0.95)' : 'rgba(24,27,46,0.9)',
          borderTop: `${borderW}px solid rgba(140,170,255,${isHovered ? 0.35 : 0.18})`,
          borderLeft: `${borderW}px solid rgba(140,170,255,${isHovered ? 0.35 : 0.18})`,
          borderRight: `${borderW}px solid rgba(140,170,255,${isHovered ? 0.35 : 0.18})`,
          borderRadius: `${8 * iz}px ${8 * iz}px 0 0`,
          cursor: 'grab',
          transition: 'background 0.12s, border-color 0.12s',
        }}
      >
        <span style={{ fontSize: fontSize * 0.8, color: 'rgba(140,190,255,0.7)', lineHeight: 1, flexShrink: 0 }}>◆</span>
        <span style={{
          flex: 1, color: 'rgba(255,255,255,0.7)', fontSize, fontWeight: 600,
          userSelect: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{win.title}</span>
        <button
          onClick={() => { useUndoCoordinator.getState().checkpoint(); removeWindow(id) }}
          onPointerDown={e => e.stopPropagation()}
          title="Close viewport"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.45)', fontSize: fontSize * 1.1,
            padding: 0, lineHeight: 1, flexShrink: 0,
            opacity: isHovered ? 1 : 0.3, transition: 'opacity 0.12s',
          }}
        >×</button>
      </div>

      {/* ── Body: transparent — the shared GL canvas paints beneath. ── */}
      <div
        onPointerDown={onBodyDown}
        onPointerMove={onBodyMove}
        onPointerUp={onBodyUp}
        onWheel={onBodyWheel}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation() }}
        style={{
          flex: 1, position: 'relative',
          background: 'transparent',
          borderBottom: `${borderW}px solid rgba(140,170,255,${isHovered ? 0.35 : 0.18})`,
          borderLeft: `${borderW}px solid rgba(140,170,255,${isHovered ? 0.35 : 0.18})`,
          borderRight: `${borderW}px solid rgba(140,170,255,${isHovered ? 0.35 : 0.18})`,
          cursor: status.status === 'ready' ? 'grab' : 'default',
          overflow: 'hidden',
        }}
      >
        {showBodyOverlay && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 6 * iz,
            background: showEmpty || showLoading || showError ? 'rgba(13,14,26,0.92)' : 'transparent',
            pointerEvents: 'none',
          }}>
            <svg width={36 * iz} height={36 * iz} viewBox="0 0 24 24" fill="none" style={{ opacity: 0.45 }}>
              <path d="M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z" stroke="rgba(160,200,255,0.6)" strokeWidth="1.2" strokeLinejoin="round" />
              <path d="M12 2 L12 12 M12 12 L21 7 M12 12 L3 7 M12 12 L12 22" stroke="rgba(160,200,255,0.35)" strokeWidth="1" strokeLinejoin="round" />
            </svg>
            <div style={{ fontSize: 10 * iz, color: showError ? 'rgba(255,150,150,0.8)' : 'rgba(255,255,255,0.35)', textAlign: 'center', maxWidth: '85%' }}>
              {showError ? (status.errorMsg ?? 'Failed to load model')
                : showLoading ? 'Loading model…'
                : showEmpty ? 'Drop a 3D model here, or magnet a model tile to an edge · drag orbit · shift-drag pan · scroll zoom'
                : null}
            </div>
          </div>
        )}

        {/* Model playlist — appears when ≥2 models are docked; also owns
            active-model reconciliation, so it mounts unconditionally. */}
        <ViewportSwitcherStrip windowId={id} />
      </div>

      {/* ── Resize corner ── */}
      <div
        data-resize="true"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        style={{
          position: 'absolute', bottom: 0, right: 0,
          width: 36 * iz, height: 36 * iz,
          cursor: 'nwse-resize',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
          padding: `0 ${5 * iz}px ${5 * iz}px 0`,
        }}
      >
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(3, ${3 * iz}px)`,
          gridTemplateRows: `repeat(3, ${3 * iz}px)`,
          gap: `${2 * iz}px`,
          opacity: isHovered ? 0.5 : 0.12,
          transition: 'opacity 0.12s',
        }}>
          {[...Array(9)].map((_, i) => (
            <div key={i} style={{
              width: 3 * iz, height: 3 * iz, borderRadius: '50%',
              background: 'rgba(255,255,255,0.9)',
              opacity: (i === 4 || i < 3) ? 0 : 1,
            }} />
          ))}
        </div>
      </div>
    </div>
  )
})
