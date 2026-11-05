// Viewport3DFrame.tsx — the canvas-space chrome for one content-browser
// window ("Viewer"). For MODEL items the GL pixels paint on the shared
// screen-space canvas BELOW the world transform (see GLCanvasHost) and
// the body stays transparent with orbit input; for image/video/audio/
// text items a DOM ContentView fills the body (opaque). This frame is a
// div at z=1 (under free nodes z=5 and bars z≥2) providing: header
// (drag-move + carry / title / drag-out / close), resize corner, type-gated body
// input, and the loading/error/poster states.
//
// Interaction rules (FreeNode parity):
//  - header/body pointerdown button-0 stopPropagation (canvas never pans
//    from a window gesture); middle-mouse falls through → canvas pan.
//  - body onWheel MUST stopPropagation in every mode — dolly for models,
//    no-op/scroll for DOM views; the canvas never zooms from the body.
//  - orbit mutates the module OrbitState per move + requestRender();
//    flushed to the store once per gesture end (no store churn at 120 Hz).

import React, { useRef, useState, useCallback } from 'react'
import { DEFAULT_LOOK } from '../../three/modelLook'
import { useViewport3DStore } from '../../store/viewport3dStore'
import type { ViewportWindow3D } from '../../store/viewport3dStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { PinControl } from '../UI/PinControl'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useBoardsStore } from '../../store/boardsStore'
import { computeCarriedEntities } from '../../hooks/useDockedContent'
import { useViewStatus } from '../../hooks/useViewStatus'
import {
  getViewRuntime, requestRender, MIN_GL_PX, captureViewPoster, getModelStats,
  getAnimInfo, playClip, pauseClip, stopClip,
} from '../../three/viewportRenderer'
import { usePosterMapStore } from '../../three/posterService'
import { clampPhi, panOrbit } from '../../three/orbitState'
import { useSeedHoverFromCursor } from '../../utils/pointerTracker'
import { ViewportSwitcherStrip } from './ViewportSwitcherStrip'
import { ContentView } from './ContentViews'
import { snapWindowToComponents } from '../../utils/componentLinks'
import { useMagnetPreviewStore } from '../../store/magnetPreviewStore'
import { viewportVisualRect, VIEWPORT_HEADER_SCREEN_H } from '../../utils/viewportDocking'
import { FileContextMenu } from '../UI/FileMenu'
import { mayHaveDiskFile } from '../../hooks/useFileMenu'
import { DragOutGrip } from '../UI/DragOutGrip'
import { FxViewerOverlay } from './FxViewerOverlay'
import { RailViewerOverlay } from './RailViewerOverlay'
import { PoppedLayerSheets } from './ExplodedStrip'
import { RoughCutViewerOverlay } from '../RoughCut/RoughCutScreen'
import { useFreshOnTop, FRESH_Z } from '../../utils/freshOnTop'

/** Selecting a Viewer takes over the canvas selection outright, so the
 *  Delete key's priority chain is never asked to arbitrate between two lit
 *  selections. focusedBoardId is included because it is that chain's
 *  last-resort target — without clearing it, Delete-then-Delete would
 *  remove the window and then silently remove a whole board. Bare-canvas
 *  pointerdown already nulls it for exactly that reason. */
function claimCanvasSelection(): void {
  const fs = useFreeNodeStore.getState()
  if (fs.selectedIds.length > 0) fs.clearFreeSelection()
  const bs = useBoardsStore.getState()
  if (bs.selectedGroupIds.length > 0) bs.clearGroupSelection()
  bs.clearAllSelections()
  const cs = useCanvasStore.getState()
  if (cs.selectedBlockBoardIds.length > 0) cs.clearSelectedBlockBoardIds()
  if (cs.selectedGhostGroupIds.length > 0) cs.clearSelectedGhostGroupIds()
  if (cs.focusedBoardId !== null) cs.setFocusedBoard(null)
}

export const Viewport3DFrame: React.FC<{ id: string }> = React.memo(({ id }) => {
  const win = useViewport3DStore(s => s.windows[id])
  const moveWindow = useViewport3DStore(s => s.moveWindow)
  // resizeWindow only ever grew from the SE corner; the eight-way handles
  // move the anchor too, so they patch the window directly.
  const removeWindow = useViewport3DStore(s => s.removeWindow)
  const saveCamera = useViewport3DStore(s => s.saveCamera)
  const zoom = useCanvasStore(s => s.zoom)
  const status = useViewStatus(id)
  const isSelected = useViewport3DStore(s => s.selectedIds.includes(id))
  const movePinnedWindow = useViewport3DStore(s => s.movePinnedWindow)
  // Same one-symbol substitution as a free node: the multiplier from this
  // window's LAYOUT units to screen pixels — the frozen scale when pinned,
  // the world zoom otherwise. Every `/ zoom` below means "counter-scale to
  // a constant screen size", so all of them become `/ gz`.
  const gz = win?.pin ? win.pin.scale : zoom
  const setPoster = usePosterMapStore(s => s.setPoster)

  const [isHovered, setIsHovered] = useState(false)
  // Newest on the canvas: over the tiles and bars beside it until moved.
  const isFresh = useFreshOnTop(s => s.id === id)
  /** Transport state lives in the view registry (it changes at frame rate,
   *  not React rate); this just forces a re-read after a button press. */
  const [, setAnimTick] = useState(0)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const dragLast = useRef({ x: 0, y: 0 })
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0, nx: 0, ny: 0 })
  const resizeDir = useRef('se')
  const orbitLast = useRef({ x: 0, y: 0 })
  const orbitActive = useRef(false)
  const wheelSaveTimer = useRef<number | null>(null)

  useSeedHoverFromCursor(wrapperRef, setIsHovered)

  // ── Click-to-select ────────────────────────────────────────────────
  // CAPTURE phase is mandatory: the header, the body, the switcher strip
  // and every editor toolbar stopPropagation on pointerdown, so a
  // bubble-phase handler on this wrapper would never fire.
  //
  // Calls NEITHER preventDefault NOR stopPropagation — it is a pure store
  // write, so onHeaderDown / onBodyDown / onResizeDown all still run and
  // still setPointerCapture. No `closest('button')` exemption on purpose:
  // a press on the ×, the strip's ‹ ›, or a toolbar selects THIS window,
  // which is what makes it impossible to leave a DIFFERENT window
  // selected while poking at this one.
  const onSelectDownCapture = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return   // 1 → canvas pan, 2 → body orbit-pan
    // The one exemption: a press on the drag-out grip is the file leaving
    // the app, not a gesture on this window — it must not select it (or
    // clear the canvas selection) any more than it may start a move.
    if ((e.target as Element).closest('[data-drag-out]')) return
    // Shift toggles only on the window's own CHROME. In the body that
    // modifier is already taken twice: Shift+left-drag pans the model,
    // and Shift+click extends a text selection.
    const onChrome = !!(e.target as Element).closest('[data-viewer-chrome],[data-resize]')
    const st = useViewport3DStore.getState()
    if (e.shiftKey && onChrome) st.toggleViewerSelection(id)
    else if (!st.selectedIds.includes(id)) st.setViewerSelection([id])
    // else: a plain press on an ALREADY-selected window leaves the
    // selection alone, so a multi-select survives the press that starts
    // a drag — same rule as tiles, blocks and cards.
    claimCanvasSelection()
  }, [id])

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
  // ── Magnet ghost while dragging the Viewer ───────────────────────────
  // A Viewer used to be the only component you could drag with NO warning
  // of where it would land: it was always the magnet's TARGET, never the
  // thing being magneted. Same gesture, same affordance.
  const showMagnetGhost = useCallback(() => {
    const st = useViewport3DStore.getState()
    const w = st.windows[id]
    if (!w) return
    const z = useCanvasStore.getState().zoom
    const snap = snapWindowToComponents(
      w, useFreeNodeStore.getState().nodes, st.windows, z)
    const mp = useMagnetPreviewStore.getState()
    if (!snap) { if (mp.preview) mp.setPreview(null); return }
    // The snap is for the VISUAL rect, so the ghost is drawn on that too —
    // it is the shape the user will actually see land.
    const v = viewportVisualRect(w, z)
    mp.setPreview({
      edge: snap.edge,
      space: w.pin ? 'screen' : 'canvas',
      x: snap.x, y: snap.y, width: v.width, height: v.height,
      target: snap.target,
    })
  }, [id])

  /** Land the Viewer on its ghost. The snap is in VISUAL-rect coordinates,
   *  so the header height comes back off to get the stored y. */
  const applyMagnetSnap = useCallback(() => {
    const st = useViewport3DStore.getState()
    const w = st.windows[id]
    useMagnetPreviewStore.getState().setPreview(null)
    if (!w) return
    const z = useCanvasStore.getState().zoom
    const snap = snapWindowToComponents(
      w, useFreeNodeStore.getState().nodes, st.windows, z)
    if (!snap) return
    const headerOffset = w.pin
      ? VIEWPORT_HEADER_SCREEN_H
      : VIEWPORT_HEADER_SCREEN_H / Math.max(0.01, z)
    if (w.pin) {
      st.updateWindow(id, { pin: { ...w.pin, x: snap.x, y: snap.y + headerOffset } })
    } else {
      st.updateWindow(id, { x: snap.x, y: snap.y + headerOffset })
    }
  }, [id])

  const onHeaderUp = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    applyMagnetSnap()
  }, [applyMagnetSnap])

  const onHeaderMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const dx = (e.clientX - dragLast.current.x) / gz
    const dy = (e.clientY - dragLast.current.y) / gz
    if (win?.pin) {
      // Screen-space move; a pinned window carries nothing, because what
      // it was docked to is canvas geometry it no longer shares a space
      // with.
      movePinnedWindow(id, e.clientX - dragLast.current.x, e.clientY - dragLast.current.y)
      dragLast.current = { x: e.clientX, y: e.clientY }
      showMagnetGhost()
      return
    }
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
    showMagnetGhost()
  }, [id, moveWindow, movePinnedWindow, win?.pin, gz, showMagnetGhost])

  // ── Reshape handles ── eight, matching FreeNode. Growing only from the
  //    SE corner meant a Viewer could never be pulled back from the left or
  //    top without also moving it, which makes laying one out beside a row
  //    of panels needlessly fiddly.
  const onResizeDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    const w = useViewport3DStore.getState().windows[id]
    if (!w) return
    resizeDir.current = (e.currentTarget as HTMLElement).dataset.resize || 'se'
    // From the drag START, so an axis parked at its floor cannot let the
    // opposite edge creep — see FreeNode for the same reasoning.
    resizeStart.current = {
      x: e.clientX, y: e.clientY, w: w.width, h: w.height,
      nx: w.pin ? w.pin.x : w.x, ny: w.pin ? w.pin.y : w.y,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [id])

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const w = useViewport3DStore.getState().windows[id]
    if (!w) return
    const s = resizeStart.current
    const dir = resizeDir.current
    const dx = (e.clientX - s.x) / gz
    const dy = (e.clientY - s.y) / gz
    const k = w.pin ? w.pin.scale : 1
    const MIN_W = 160, MIN_H = 120

    let width = s.w, height = s.h, nx = s.nx, ny = s.ny

    // Shift on a corner SCALES instead of reshaping — same gesture as the
    // panels, for when the aspect is already right and you only want it
    // bigger.
    if (e.shiftKey && dir.length === 2) {
      const ratio = s.h / s.w
      const sx = dir.includes('w') ? -1 : 1
      const sy = dir.includes('n') ? -1 : 1
      const t = (dx * sx + dy * sy * ratio) / (1 + ratio * ratio)
      width = Math.max(MIN_W, MIN_H / ratio, s.w + t)
      height = width * ratio
      if (dir.includes('w')) nx = s.nx - (width - s.w) * k
      if (dir.includes('n')) ny = s.ny - (height - s.h) * k
      const scaled: Partial<ViewportWindow3D> = { width, height }
      if (nx !== s.nx || ny !== s.ny) {
        if (w.pin) scaled.pin = { ...w.pin, x: nx, y: ny }
        else { scaled.x = nx; scaled.y = ny }
      }
      useViewport3DStore.getState().updateWindow(id, scaled)
      return
    }

    if (dir.includes('e')) width = Math.max(MIN_W, s.w + dx)
    if (dir.includes('s')) height = Math.max(MIN_H, s.h + dy)
    if (dir.includes('w')) { width = Math.max(MIN_W, s.w - dx); nx = s.nx + (s.w - width) * k }
    if (dir.includes('n')) { height = Math.max(MIN_H, s.h - dy); ny = s.ny + (s.h - height) * k }

    const patch: Partial<ViewportWindow3D> = { width, height }
    if (nx !== s.nx || ny !== s.ny) {
      if (w.pin) patch.pin = { ...w.pin, x: nx, y: ny }
      else { patch.x = nx; patch.y = ny }
    }
    useViewport3DStore.getState().updateWindow(id, patch)
  }, [id, gz])

  // ── Orbit / pan (body) — normalize by VISUAL height so feel is
  //    zoom-invariant. Left-drag orbits; Shift+left-drag or right-drag
  //    pans (trucks the orbit target). Middle-mouse falls through →
  //    canvas pan. ──
  const gestureMode = useRef<'orbit' | 'pan'>('orbit')
  const modelActiveRef = useRef(false)

  // ── Right-click → file menu (desktop app) ── right-DRAG pans the model,
  //    so a right press only counts as a click if it never strays past
  //    4px. Windows fires contextmenu on RELEASE and decides on the spot;
  //    macOS/Linux fire it on PRESS, so there it waits for the pointerup.
  const rightPress = useRef<{
    x: number; y: number; dragged: boolean; released: boolean; pending: boolean
  } | null>(null)
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; url: string } | null>(null)
  const closeFileMenu = useCallback(() => setFileMenu(null), [])
  const openFileMenuIfClick = useCallback((x: number, y: number) => {
    const p = rightPress.current
    rightPress.current = null
    if (!p || p.dragged || Math.hypot(x - p.x, y - p.y) > 4) return
    // The item's SOURCE url — for a model that is the file, not its poster.
    const a = useViewport3DStore.getState().windows[id]?.activeItem
    if (a?.kind === 'media' && mayHaveDiskFile(a.url)) setFileMenu({ x, y, url: a.url })
  }, [id])
  const onBodyContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()    // never the browser's menu — right-drag is a gesture here
    e.stopPropagation()
    const p = rightPress.current
    if (p && !p.released && (e.buttons & 2)) { p.pending = true; return }   // fired at press
    openFileMenuIfClick(e.clientX, e.clientY)
  }, [openFileMenuIfClick])

  const onBodyDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 2) return
    e.stopPropagation()   // canvas never pans from a body gesture, any mode
    rightPress.current = e.button === 2
      ? { x: e.clientX, y: e.clientY, dragged: false, released: false, pending: false } : null
    if (!modelActiveRef.current || status.status !== 'ready') return
    gestureMode.current = (e.button === 2 || e.shiftKey) ? 'pan' : 'orbit'
    orbitActive.current = true
    orbitLast.current = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [status.status])
  const onBodyMove = useCallback((e: React.PointerEvent) => {
    const p = rightPress.current
    if (p && !p.dragged && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) p.dragged = true
    if (!orbitActive.current || !(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const view = getViewRuntime(id)
    if (!view) return
    const w = useViewport3DStore.getState().windows[id]
    if (!w) return
    const screenH = Math.max(40, w.height * (w.pin ? w.pin.scale : zoom))
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
  const onBodyUp = useCallback((e: React.PointerEvent) => {
    const p = rightPress.current
    if (e.button === 2 && p) {
      if (p.pending) openFileMenuIfClick(e.clientX, e.clientY)
      else p.released = true
    }
    if (!orbitActive.current) return
    orbitActive.current = false
    const view = getViewRuntime(id)
    if (view && view.status === 'ready') saveCamera(id, { ...view.orbit })
  }, [id, saveCamera, openFileMenuIfClick])
  const onBodyWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()   // MANDATORY — else the canvas zooms mid-dolly
    if (!modelActiveRef.current) return   // DOM views own their wheel
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

  const active = win.activeItem
  const modelActive = active?.kind === 'media' && active.mediaType === 'model'
  modelActiveRef.current = modelActive

  const iz = 1 / gz
  const headerH = 22 * iz
  const fontSize = 11 * iz
  const borderW = Math.min(Math.max(1, 2 / gz), win.width * 0.04, win.height * 0.04)
  const grabZone = Math.min(36 * iz, win.width * 0.3, win.height * 0.3)
  // Same rule as FreeNode's: constant screen size, capped against the
  // window's own box so zooming out cannot make it all handles.
  const cornerZone = Math.min(18 * iz, win.width * 0.22, win.height * 0.22)
  const edgeZone   = Math.min(9 * iz, win.width * 0.12, win.height * 0.12)
  // One alpha for all six chrome borders. Brightening them on selection is
  // a SECOND signal, and the one that survives occlusion: the outer ring
  // is a box-shadow on a zIndex:1 wrapper, so a flush-docked tile (docking
  // snaps to gap 0) or an overlapping card paints over it. These borders
  // are inside the frame's own box.
  const edge = isSelected ? 0.7 : isHovered ? 0.35 : 0.18
  // Uses gz, so a PINNED window does not drop to poster mode just because
  // the world zoomed out underneath it — its own size never changed.
  const glTooSmall = win.width * gz < MIN_GL_PX
  // Body states — GL statuses only mean anything while a MODEL is active;
  // DOM content views own the body otherwise (no MIN_GL fallback needed —
  // DOM scales down natively).
  const showEmpty = !active
  const showLoading = modelActive && status.status === 'loading'
  const showError = modelActive && status.status === 'error'
  const glPoster = modelActive && status.status === 'ready' && glTooSmall
  const showBodyOverlay = showEmpty || showLoading || showError || glPoster

  const frame = (
    <div
      ref={wrapperRef}
      data-viewport3d={id}
      data-pinned={win.pin ? 'true' : undefined}
      style={{
        position: 'absolute',
        // Pinned: anchor + frozen scale as the wrapper's own transform, so
        // the whole subtree renders identically to the canvas-placed case.
        ...(win.pin ? {
          left: win.pin.x,
          top: win.pin.y - headerH * win.pin.scale,
          transform: `scale(${win.pin.scale})`,
          transformOrigin: '0 0',
          pointerEvents: 'auto' as const,
          zIndex: 880,               // under the Rolodex (900), over the canvas
        } : {
          left: win.x,
          top: win.y - headerH,      // header sits ABOVE the GL body rect
          zIndex: isFresh ? FRESH_Z : 1,   // under free nodes (5) and bars (≥2), unless newest
        }),
        width: win.width,
        height: win.height + headerH,
        display: 'flex',
        flexDirection: 'column',
        // Cosmetic only — this wrapper has no background and no overflow,
        // so the radius clips nothing; it just shapes the ring to the
        // header's rounded top and the body's square bottom.
        borderRadius: `${8 * iz}px ${8 * iz}px 0 0`,
        // The project's selection ring, counter-scaled to a constant 2.5
        // SCREEN px. box-shadow paints outside the border box, so it can
        // neither cover a GL pixel nor take a pointer event.
        boxShadow: isSelected ? `0 0 0 ${2.5 * iz}px rgba(120,180,255,0.9)` : undefined,
        transition: 'box-shadow 0.12s',
      }}
      onPointerDownCapture={onSelectDownCapture}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* ── Header (rounded top; body corners stay square — CSS radius can't clip GL) ── */}
      <div
        data-viewer-chrome=""
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        style={{
          display: 'flex', alignItems: 'center', gap: 6 * iz,
          height: headerH, flexShrink: 0,
          padding: `0 ${8 * iz}px`,
          background: isHovered ? 'rgba(30,34,58,0.95)' : 'rgba(24,27,46,0.9)',
          borderTop: `${borderW}px solid rgba(140,170,255,${edge})`,
          borderLeft: `${borderW}px solid rgba(140,170,255,${edge})`,
          borderRight: `${borderW}px solid rgba(140,170,255,${edge})`,
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

        {/* ── Model controls — only meaningful while a model is loaded ── */}
        {modelActive && (() => {
          const btn = (active: boolean): React.CSSProperties => ({
            background: active ? 'rgba(120,170,255,0.28)' : 'rgba(255,255,255,0.06)',
            border: `1px solid ${active ? 'rgba(140,190,255,0.6)' : 'rgba(255,255,255,0.12)'}`,
            borderRadius: 3 * iz,
            color: active ? '#cfe2ff' : 'rgba(255,255,255,0.55)',
            fontSize: fontSize * 0.72, fontWeight: 700, letterSpacing: '0.3px',
            padding: `${1 * iz}px ${4 * iz}px`, cursor: 'pointer',
            fontFamily: 'inherit', lineHeight: 1.5, flexShrink: 0,
          })
          const look = win.look ?? DEFAULT_LOOK
          const v3 = useViewport3DStore.getState()
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 * iz, flexShrink: 0 }}
                 onPointerDown={e => e.stopPropagation()}>
              <button style={btn(look.texture)} onClick={() => v3.setLook(id, { ...look, texture: !look.texture })}
                title="The model's own textures; off is plain grey">Texture</button>
              <button style={btn(look.shade === 'flat')} onClick={() => v3.setLook(id, { ...look, shade: look.shade === 'flat' ? null : 'flat' })}
                title="Flat shading: every face shows">Flat</button>
              <button style={btn(look.shade === 'smooth')} onClick={() => v3.setLook(id, { ...look, shade: look.shade === 'smooth' ? null : 'smooth' })}
                title="Smooth shading. With Flat and Smooth both off the model is unshaded: its bare texture, or hollow with Texture off">Smooth</button>
              <button style={btn(look.wire)} onClick={() => v3.setLook(id, { ...look, wire: !look.wire })}
                title="The wireframe, over whatever else shows">Wireframe</button>
              <button style={btn(win.showSkin === false)} onClick={() => v3.toggleShowSkin(id)}
                title="Hide the skinned mesh and show the skeleton">SKEL</button>
              <button style={btn(!!win.showStats)} onClick={() => v3.toggleShowStats(id)}
                title="Vertex / triangle counts">#</button>
              <button
                style={btn(false)}
                title="Use this view as the model's thumbnail"
                onClick={() => {
                  const active = win.activeItem
                  if (active?.kind !== 'media' || active.mediaType !== 'model') return
                  const shot = captureViewPoster(id)
                  if (shot) setPoster(active.url, shot)
                }}
              >SNAP</button>
            </div>
          )
        })()}

        {/* ── Drag-out — the ACTIVE item's file, the same url the right-click
               file menu offers (a model's file, never its poster). The grip
               stops its own pointerdown, so onHeaderDown never sees the
               press and no window move starts. Lifted over the reshape
               handles (19/20): the unpositioned header is painted under the
               north strip, which would otherwise take the grip's top edge
               as a resize. Hidden, it takes no pointer, so the strip does. ── */}
        <DragOutGrip
          url={active?.kind === 'media' ? active.url : null}
          size={Math.max(11, fontSize * 1.15)}
          visible={isHovered}
          style={{ position: 'relative', zIndex: 21 }}
        />
        <PinControl
          pinned={!!win.pin}
          size={Math.max(11, fontSize * 1.15)}
          onToggle={() => {
            const cs = useCanvasStore.getState()
            useUndoCoordinator.getState().checkpoint()
            // Per component: pinning a Viewer does not drag its neighbours
            // off the canvas with it.
            useViewport3DStore.getState().setWindowPlacement(
              id, win.pin ? 'canvas' : 'screen', { pan: cs.pan, zoom: cs.zoom })
          }}
          onResetHome={win.pin ? () => {
            const cs = useCanvasStore.getState()
            useUndoCoordinator.getState().checkpoint()
            useViewport3DStore.getState().rehomePinnedWindow(id, { pan: cs.pan, zoom: cs.zoom })
          } : undefined}
        />
        {/* Lifted over the reshape handles too, as the grip is: the x sits
            inside the NE corner's zone, which took every press on it as a
            resize, so it never closed the window. */}
        <button
          onClick={() => { useUndoCoordinator.getState().checkpoint(); removeWindow(id) }}
          onPointerDown={e => e.stopPropagation()}
          title="Close viewport"
          style={{
            position: 'relative', zIndex: 21,
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
        data-wheel-own=""
        onContextMenu={onBodyContextMenu}
        data-viewer-body=""
        style={{
          flex: 1, position: 'relative',
          // Transparent for GL/empty (grid shows around, GL beneath);
          // opaque for DOM content views.
          background: modelActive || !active ? 'transparent' : '#0d0e1a',
          borderBottom: `${borderW}px solid rgba(140,170,255,${edge})`,
          borderLeft: `${borderW}px solid rgba(140,170,255,${edge})`,
          borderRight: `${borderW}px solid rgba(140,170,255,${edge})`,
          overflow: 'hidden',
          // Work area on top, switcher strip as a footer row under it, so
          // the strip never covers the image (the GL rect is shortened by
          // the same amount — setViewFooterInset).
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{
          flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden',
          cursor: modelActive && status.status === 'ready' ? 'grab' : 'default',
        }}>
        {/* DOM content views (image/video/audio/text) — models paint via GL.
            zoom={gz}, NOT the live canvas zoom: ContentView counter-scales
            its controls and text against its ANCESTOR's scale, and for a
            pinned window that ancestor is frozen at pin time. The live zoom
            made a pinned Viewer's video controls and text resize as the
            canvas zoomed underneath it, while the window itself stood
            perfectly still. */}
        {active && !modelActive && (
          <div data-viewer-content="" style={{ display: 'contents' }}><ContentView windowId={id} item={active} zoom={gz} /></div>
        )}
        {/* An effect strip touching this window shows its output here,
            over whatever the window holds (utils/fx, useFxStrips). */}
        <FxViewerOverlay windowId={id} fontSize={fontSize} />
        {/* Loop strips docked to its left edge: the active one's live
            result (utils/railViewer). */}
        <RailViewerOverlay windowId={id} fontSize={fontSize} />
        {/* A Rough Cut touching it: the movie, at the cut's playhead. */}
        <RoughCutViewerOverlay windowId={id} fontSize={fontSize} />
        {showBodyOverlay && (
          <div data-viewer-content="" style={{
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
                : showEmpty ? 'Drop content here, or magnet cards and tiles to an edge'
                : null}
            </div>
          </div>
        )}

        {/* ── Stats HUD ── read from the view registry, which is where the
               loaded instance actually lives. Keyed on status so it fills
               in the moment the model becomes ready. */}
        {win.showStats && modelActive && status.status === 'ready' && (() => {
          const st = getModelStats(id)
          if (!st) return null
          const n = (x: number) => x >= 1e6 ? `${(x / 1e6).toFixed(2)}M`
            : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : String(x)
          const rows: Array<[string, string]> = [
            ['verts', n(st.vertices)],
            ['tris', n(st.triangles)],
            ['meshes', String(st.meshes)],
            ['mats', String(st.materials)],
            ['tex', String(st.textures)],
          ]
          if (st.bones) rows.push(['bones', String(st.bones)])
          if (st.animations) rows.push(['clips', String(st.animations)])
          return (
            <div style={{
              position: 'absolute', top: 6 * iz, left: 6 * iz,
              padding: `${4 * iz}px ${6 * iz}px`, borderRadius: 4 * iz,
              background: 'rgba(8,10,20,0.72)', border: `${1 * iz}px solid rgba(140,190,255,0.22)`,
              pointerEvents: 'none', fontFamily: 'ui-monospace, monospace',
              fontSize: 9 * iz, lineHeight: 1.5, color: 'rgba(200,225,255,0.9)',
            }}>
              {rows.map(([k, v]) => (
                <div key={k} style={{ display: 'flex', gap: 6 * iz, justifyContent: 'space-between' }}>
                  <span style={{ opacity: 0.6 }}>{k}</span><span>{v}</span>
                </div>
              ))}
            </div>
          )
        })()}

        {/* ── Animation transport — only when the model brought clips ── */}
        {modelActive && status.status === 'ready' && (() => {
          const anim = getAnimInfo(id)
          if (!anim) return null
          const btn: React.CSSProperties = {
            background: 'rgba(10,14,26,0.8)', border: `${1 * iz}px solid rgba(140,190,255,0.3)`,
            borderRadius: 3 * iz, color: 'rgba(200,225,255,0.92)',
            fontSize: 10 * iz, padding: `${2 * iz}px ${7 * iz}px`,
            cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1.3,
          }
          return (
            <div
              onPointerDown={e => e.stopPropagation()}
              style={{
                position: 'absolute', left: 6 * iz, bottom: 6 * iz,
                display: 'flex', alignItems: 'center', gap: 4 * iz,
                padding: `${3 * iz}px ${4 * iz}px`, borderRadius: 4 * iz,
                background: 'rgba(8,10,20,0.72)', border: `${1 * iz}px solid rgba(140,190,255,0.22)`,
              }}
            >
              <button style={btn} title={anim.playing ? 'Pause' : 'Play'}
                onClick={() => { anim.playing ? pauseClip(id) : playClip(id); setAnimTick(t => t + 1) }}
              >{anim.playing ? '❚❚' : '▶'}</button>
              <button style={btn} title="Stop and return to the rest pose"
                onClick={() => { stopClip(id); setAnimTick(t => t + 1) }}
              >■</button>
              {anim.clipNames.length > 1 ? (
                <select
                  value={anim.clipIndex}
                  onChange={e => { playClip(id, Number(e.target.value)); setAnimTick(t => t + 1) }}
                  style={{ ...btn, maxWidth: 120 * iz }}
                >
                  {anim.clipNames.map((n, i) => <option key={i} value={i}>{n}</option>)}
                </select>
              ) : (
                <span style={{ fontSize: 9 * iz, color: 'rgba(200,225,255,0.7)', maxWidth: 120 * iz,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {anim.clipNames[0]}
                </span>
              )}
              <span style={{ fontSize: 8.5 * iz, color: 'rgba(200,225,255,0.45)', fontFamily: 'ui-monospace, monospace' }}>
                {anim.duration.toFixed(1)}s
              </span>
            </div>
          )
        })()}

        </div>

        {/* Content playlist — the footer; also owns active-item
            reconciliation, so it mounts unconditionally. */}
        <ViewportSwitcherStrip windowId={id}
          reserveRight={grabZone} reserveLeft={cornerZone} reserveBottom={edgeZone} />
      </div>

      {/* ── Reshape handles ── the other seven, under the visible SE grip. */}
      {([
        ['n',  { top: 0, left: cornerZone, right: cornerZone, height: edgeZone }, 'ns-resize'],
        ['s',  { bottom: 0, left: cornerZone, right: cornerZone, height: edgeZone }, 'ns-resize'],
        ['w',  { left: 0, top: cornerZone, bottom: cornerZone, width: edgeZone }, 'ew-resize'],
        ['e',  { right: 0, top: cornerZone, bottom: cornerZone, width: edgeZone }, 'ew-resize'],
        ['nw', { top: 0, left: 0, width: cornerZone, height: cornerZone }, 'nwse-resize'],
        ['ne', { top: 0, right: 0, width: cornerZone, height: cornerZone }, 'nesw-resize'],
        ['sw', { bottom: 0, left: 0, width: cornerZone, height: cornerZone }, 'nesw-resize'],
      ] as const).map(([dir, pos, cursor]) => (
        <div
          key={dir}
          data-resize={dir}
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          style={{ position: 'absolute', ...pos, cursor, zIndex: 19 }}
        />
      ))}

      {/* ── Resize corner ── */}
      <div
        data-resize="se"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        style={{
          position: 'absolute', bottom: 0, right: 0, zIndex: 20,
          // Capped against the window's own box — see FreeNode: a constant
          // screen-pixel corner outgrows the window when zoomed out and
          // swallows the body.
          width: grabZone, height: grabZone,
          cursor: 'nwse-resize',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
          padding: `0 ${grabZone * 0.14}px ${grabZone * 0.14}px 0`,
        }}
      >
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(3, ${grabZone * 0.083}px)`,
          gridTemplateRows: `repeat(3, ${grabZone * 0.083}px)`,
          gap: `${grabZone * 0.055}px`,
          opacity: isHovered ? 0.5 : 0.12,
          transition: 'opacity 0.12s',
        }}>
          {[...Array(9)].map((_, i) => (
            <div key={i} style={{
              width: grabZone * 0.083, height: grabZone * 0.083, borderRadius: '50%',
              background: 'rgba(255,255,255,0.9)',
              opacity: (i === 4 || i < 3) ? 0 : 1,
            }} />
          ))}
        </div>
      </div>
    </div>
  )

  // The menu is a SIBLING of the frame, not a child: portal events bubble
  // through the React tree, and inside the wrapper a press on its backdrop
  // would hit onSelectDownCapture and select this window. Always the same
  // fragment shape, so opening it never remounts the frame (or its video).
  return (
    <>
      {frame}
      <PoppedLayerSheets windowId={id} />
      {fileMenu && (
        <FileContextMenu x={fileMenu.x} y={fileMenu.y} url={fileMenu.url} onClose={closeFileMenu} />
      )}
    </>
  )
})
