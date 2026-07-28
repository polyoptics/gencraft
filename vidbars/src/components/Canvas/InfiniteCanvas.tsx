import React, { useRef, useCallback, useEffect, useState, useDeferredValue, useMemo } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { PinLayer } from './PinLayer'
import { useBoardsStore } from '../../store/boardsStore'
import { uploadFile, classifyFile, isAcceptedMediaFile } from '../../utils/uploadFile'
import type { FreeNodeType } from '../../store/freeNodeStore'
import { computeGroupLayout, getRowY, getRowHeight, CARD_GRID_SPACING } from '../../utils/nleRows'
import { useViewport3DStore, VIEWPORT3D_DEFAULT_W, VIEWPORT3D_DEFAULT_H } from '../../store/viewport3dStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { nextFreeEdgeSlot } from '../../utils/viewportDocking'
import { GLCanvasHost } from '../Viewport3D/GLCanvasHost'

// A card's visual left edge sits this far right of its group origin
// (BOARD_PADDING_X in the shared card geometry) — used to center a
// newly created card on the cursor.
const CARD_CONTENT_INSET = 20

interface Props {
  children: React.ReactNode
  initialCenterW?: number
  initialCenterH?: number
}

export const InfiniteCanvas: React.FC<Props> = ({ children, initialCenterW = 1000 }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const shiftPan = useCanvasStore(s => s.shiftPan)
  const zoomAtPoint = useCanvasStore(s => s.zoomAtPoint)
  const setPan = useCanvasStore(s => s.setPan)


  const addFreeNode = useFreeNodeStore(s => s.addFreeNode)
  const updateFreeNode = useFreeNodeStore(s => s.updateFreeNode)
  const setFreeSelection = useFreeNodeStore(s => s.setFreeSelection)
  const clearFreeSelection = useFreeNodeStore(s => s.clearFreeSelection)
  const setFocusedBoard = useCanvasStore(s => s.setFocusedBoard)

  const isPanning = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })
  const spaceDown = useRef(false)
  const [spaceActive, setSpaceActive] = useState(false)
  const [addMenu, setAddMenu] = useState<{ sx: number; sy: number; cx: number; cy: number } | null>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const panRef = useRef(pan)
  panRef.current = pan

  // Rubber-band selection state (screen coords relative to container)
  const [rubberBand, setRubberBand] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null)
  const rubberBandRef = useRef<{ sx: number; sy: number; ex: number; ey: number } | null>(null)
  const rbStartCanvas = useRef<{ cx: number; cy: number } | null>(null)

  // Center on first launch only — skip if pan was restored from localStorage
  useEffect(() => {
    const saved = useCanvasStore.getState().pan
    if (saved.x !== 0 || saved.y !== 0) return
    const toolbarH = 40
    const canvasH = window.innerHeight - toolbarH
    setPan({
      x: Math.max(20, (window.innerWidth - initialCenterW) / 2),
      y: Math.round(canvasH * 0.18),
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Space key pan mode
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.target === document.body) {
        if (!spaceDown.current) { spaceDown.current = true; setSpaceActive(true) }
        e.preventDefault()
      }
      // Home/End: nothing in our code reads them, but the browser default
      // (scroll to top/bottom of document) is a trap on a canvas app —
      // hitting Home by accident snaps the page scroll and the visual
      // result reads as "everything went crazy" even though no app state
      // moved. Swallow the keys when focus is on the document body so
      // text-editing contexts (inputs, textareas, contenteditable) keep
      // their native Home/End behavior untouched.
      if ((e.key === 'Home' || e.key === 'End') && e.target === document.body) {
        e.preventDefault()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') { spaceDown.current = false; setSpaceActive(false) }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = containerRef.current!.getBoundingClientRect()
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    zoomAtPoint(factor, e.clientX - rect.left, e.clientY - rect.top)
  }, [zoomAtPoint])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Middle mouse or space+left-drag = pan
    if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      isPanning.current = true
      lastMouse.current = { x: e.clientX, y: e.clientY }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }
    // Left-click on bare canvas = rubber-band select
    if (e.button === 0) {
      const target = e.target as Element
      if (target.closest('[data-block],[data-board],[data-freenode],[data-viewport3d]')) return
      setFocusedBoard(null)
      const rect = containerRef.current!.getBoundingClientRect()
      const relX = e.clientX - rect.left
      const relY = e.clientY - rect.top
      rbStartCanvas.current = {
        cx: (relX - panRef.current.x) / zoomRef.current,
        cy: (relY - panRef.current.y) / zoomRef.current,
      }
      const initial = { sx: relX, sy: relY, ex: relX, ey: relY }
      rubberBandRef.current = initial
      setRubberBand(initial)
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      clearFreeSelection()
      // Clear selection on ALL boards + card groups — single batched update
      useBoardsStore.getState().clearGroupSelection()
      useBoardsStore.getState().clearAllSelections()
      // Click on empty canvas also releases any deck-portal previews —
      // bare-canvas-click is the universal "deselect everything" gesture.
      useCanvasStore.getState().clearAllDeckPortals()
    }
  }, [clearFreeSelection])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (isPanning.current) {
      shiftPan(e.clientX - lastMouse.current.x, e.clientY - lastMouse.current.y)
      lastMouse.current = { x: e.clientX, y: e.clientY }
    } else if (rbStartCanvas.current) {
      const rect = containerRef.current!.getBoundingClientRect()
      const updated = rubberBandRef.current
        ? { ...rubberBandRef.current, ex: e.clientX - rect.left, ey: e.clientY - rect.top }
        : null
      rubberBandRef.current = updated
      setRubberBand(updated)
    }
  }, [shiftPan])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  // ── Creation sizing ──────────────────────────────────────────────
  // New things are sized in CANVAS units, but the user judges them on
  // SCREEN. At card zoom a 200-unit tile is a 30-px speck. Scale the
  // creation size by 1/zoom so anything created lands at a comfortable
  // on-screen size whatever the zoom, clamped so the extremes stay sane.
  const createScale = useCallback(() => {
    const z = zoomRef.current
    return Math.max(0.6, Math.min(10, 1 / z))
  }, [])

  /** Create a free node CENTERED on the add-menu's canvas point, sized
   *  for the current zoom. */
  const addNodeAtCursor = useCallback((type: FreeNodeType, baseW: number, baseH: number) => {
    if (!addMenu) return
    useUndoCoordinator.getState().checkpoint()
    const k = createScale()
    const w = baseW * k, h = baseH * k
    const id = addFreeNode(addMenu.cx - w / 2, addMenu.cy - h / 2, type)
    if (k !== 1) useFreeNodeStore.getState().updateFreeNode(id, { width: w, height: h })
    useFreeNodeStore.getState().setFreeSelection([id])
  }, [addMenu, addFreeNode, createScale])

  // ── Layer-aware drop handlers ──

  /** Drop on bare canvas at any layer — create free node(s) */
  const dropOnBareCanvas = useCallback((e: React.DragEvent, files: File[]) => {
    const rect = containerRef.current!.getBoundingClientRect()
    const z = zoomRef.current
    const p = panRef.current
    // Zoom-aware size so a drop at card zoom isn't a speck (see createScale).
    const k = Math.max(0.6, Math.min(10, 1 / z))
    files.forEach((file, i) => {
      // Determine node type from the file (drives default size — must match freeNodeStore.addFreeNode)
      const nodeType = classifyFile(file)
      const mediaType = nodeType
      const nodeW = (nodeType === 'audio' ? 260 : 200) * k
      const nodeH = (nodeType === 'audio' ? 120 : 180) * k
      // Cursor position in canvas coordinates; multi-drops fan out by
      // one node-width so they never land on top of each other.
      const cursorCX = (e.clientX - rect.left - p.x) / z + i * (nodeW + 20 * k)
      const cursorCY = (e.clientY - rect.top - p.y) / z
      // Center the node on the cursor (store x/y = top-left)
      const nodeId = addFreeNode(cursorCX - nodeW / 2, cursorCY - nodeH / 2, nodeType)
      if (k !== 1) updateFreeNode(nodeId, { width: nodeW, height: nodeH })
      uploadFile(file).then(({ url }) => {
        updateFreeNode(nodeId, { imageUrl: url, mediaType, label: file.name.replace(/\.[^.]+$/, '') })
      })
    })
  }, [addFreeNode, updateFreeNode])

  /** Drop on a free node at any layer — set its media */
  const dropOnFreeNode = useCallback((allEls: Element[], files: File[]): boolean => {
    for (const el of allEls) {
      const freenode = el.closest('[data-freenode][data-id]') as HTMLElement | null
      if (freenode) {
        const nodeId = freenode.dataset.id!
        const target = useFreeNodeStore.getState().nodes[nodeId]
        // A pinned panel floats over the canvas, so a file dropped
        // anywhere near it would land ON it and overwrite its type. A
        // list tile isn't a media target in either placement.
        if (!target || target.pin || target.type === 'list') continue
        const file = files[0]
        const nodeType = classifyFile(file)
        uploadFile(file).then(({ url }) => {
          useFreeNodeStore.getState().updateFreeNode(nodeId, {
            type: nodeType,
            mediaType: nodeType,
            imageUrl: url,
            posterUrl: undefined,   // stale poster from any previous model
            label: file.name.replace(/\.[^.]+$/, ''),
          })
        })
        return true
      }
    }
    return false
  }, [])

  const handleCardDrop = useCallback((e: React.DragEvent, files: File[]) => {
    const allEls = document.elementsFromPoint(e.clientX, e.clientY)
    // 1. Card target — data-layer-card is now a group ID.
    // Card heroes are images by construction: model files skip this branch
    // (fall through to free-node/tile creation) so a .glb never lands in an <img>.
    const cardHeroFile = files.find(f => classifyFile(f) !== 'model')
    if (cardHeroFile) {
      for (const el of allEls) {
        const card = el.closest('[data-layer-card]') as HTMLElement | null
        if (card) {
          const groupId = card.dataset.layerCard!
          uploadFile(cardHeroFile).then(({ url }) => {
            useBoardsStore.getState().setGroupCardHeroImage(groupId, url)
          })
          return
        }
      }
    }
    // 2. Free node
    if (dropOnFreeNode(allEls, files)) return
    // 3. Bare canvas
    dropOnBareCanvas(e, files)
  }, [dropOnFreeNode, dropOnBareCanvas])

  const handleBlockDrop = useCallback((e: React.DragEvent, files: File[]) => {
    const allEls = document.elementsFromPoint(e.clientX, e.clientY)
    // 1. Block target — thumbnails are images by construction: model files
    // skip this branch (fall through to tile creation).
    const blockThumbFile = files.find(f => classifyFile(f) !== 'model')
    if (blockThumbFile) {
      for (const el of allEls) {
        const block = el.closest('[data-layer-block]') as HTMLElement | null
        if (block) {
          const boardId = block.dataset.layerBlock!
          uploadFile(blockThumbFile).then(({ url }) => {
            useBoardsStore.getState().setBlockThumbnail(boardId, url)
          })
          return
        }
      }
    }
    // 2. Free node
    if (dropOnFreeNode(allEls, files)) return
    // 3. Bare canvas
    dropOnBareCanvas(e, files)
  }, [dropOnFreeNode, dropOnBareCanvas])

  const handleBoardDrop = useCallback((e: React.DragEvent, files: File[]) => {
    const allEls = document.elementsFromPoint(e.clientX, e.clientY)

    // Replace a bar's media[] with the newly dropped files (one set call, not N appends).
    const replaceBarMedia = (boardId: string, barId: string) => {
      Promise.all(files.map(f => uploadFile(f))).then(results => {
        const media = results.map(r => ({ url: r.url, type: r.type, originalName: r.originalName }))
        useBoardsStore.getState().setContent(boardId, barId, { media })
      })
    }

    // 1. NLE block bar — try elementsFromPoint first
    for (const el of allEls) {
      const block = el.closest('[data-block][data-id]') as HTMLElement | null
      if (block) {
        const barId = block.dataset.id!
        const boardId = block.dataset.boardId ?? 'primary'
        replaceBarMedia(boardId, barId)
        return
      }
    }

    // 1b. Fallback: scan ALL bars by bounding rect. Handles the case where a
    // transparent overlay (text layer, hero image with opacity, etc.) sits above
    // the bar but elementsFromPoint walks past it. If the cursor is visually
    // inside any bar, drop there — pick the smallest (innermost) match.
    {
      const bars = Array.from(document.querySelectorAll('[data-block][data-id]')) as HTMLElement[]
      let best: { el: HTMLElement; area: number } | null = null
      for (const bar of bars) {
        const r = bar.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) continue
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue
        const area = r.width * r.height
        if (!best || area < best.area) best = { el: bar, area }
      }
      if (best) {
        const barId = best.el.dataset.id!
        const boardId = best.el.dataset.boardId ?? 'primary'
        replaceBarMedia(boardId, barId)
        return
      }
    }

    // 2. Board area (drop on board background → replace root bar media)
    for (const el of allEls) {
      const board = el.closest('[data-board]') as HTMLElement | null
      if (board) {
        const boardBlock = board.querySelector('[data-block][data-board-id]') as HTMLElement | null
        if (boardBlock) {
          const boardId = boardBlock.dataset.boardId ?? 'primary'
          const b = useBoardsStore.getState().boards[boardId]
          const rid = b?.rootIds[0]
          if (rid) {
            replaceBarMedia(boardId, rid)
            return
          }
        }
      }
    }

    // 3. Free node
    if (dropOnFreeNode(allEls, files)) return
    // 4. Bare canvas
    dropOnBareCanvas(e, files)
  }, [dropOnFreeNode, dropOnBareCanvas])

  /** ANY media files dropped ONTO a browser window: create content tiles
   *  docked flush at the window's right edge (stacking downward) and load
   *  the first one. Returns the files it did NOT consume (none when a
   *  window was hit). */
  const dropOnViewportWindow = useCallback((e: React.DragEvent, files: File[]): File[] => {
    const winEl = document.elementsFromPoint(e.clientX, e.clientY)
      .map(el => el.closest('[data-viewport3d]'))
      .find(Boolean) as HTMLElement | null
    const windowId = winEl?.dataset.viewport3d
    const win = windowId ? useViewport3DStore.getState().windows[windowId] : undefined
    if (!win || !windowId) return files
    useUndoCoordinator.getState().checkpoint()
    // Stack down the right edge past anything already parked there.
    const occupied = Object.values(useFreeNodeStore.getState().nodes)
      .filter(n => !n.pin)      // pinned nodes occupy no world space
      .map(n => ({ x: n.x, y: n.y, width: n.width, height: n.height }))
    files.forEach((file, i) => {
      const type = classifyFile(file)
      const tileW = type === 'audio' ? 260 : 200
      const tileH = type === 'audio' ? 120 : 180
      const slot = nextFreeEdgeSlot(win, 'right', tileW, tileH, occupied)
      occupied.push({ x: slot.x, y: slot.y, width: tileW, height: tileH })
      const nodeId = addFreeNode(slot.x, slot.y, type)
      uploadFile(file).then(({ url }) => {
        const label = file.name.replace(/\.[^.]+$/, '')
        useFreeNodeStore.getState().updateFreeNode(nodeId, {
          imageUrl: url, mediaType: type, label,
        })
        if (i === 0) {
          useViewport3DStore.getState().setActiveItem(windowId, {
            kind: 'media', mediaType: type, url, name: label,
          })
        }
      })
    })
    return []
  }, [addFreeNode])

  const handleDrop = useCallback((e: React.DragEvent) => {
    // Accepts image/video/audio AND 3D models (.glb/.gltf — MIME is often
    // empty on Windows, so filtering lives in isAcceptedMediaFile).
    let files = Array.from(e.dataTransfer.files).filter(isAcceptedMediaFile)
    if (files.length === 0) return
    e.preventDefault()

    // Pre-step: files aimed at a browser window dock + load there.
    files = dropOnViewportWindow(e, files)
    if (files.length === 0) return

    // Dispatch to the active layer's drop handler
    const zoom = useCanvasStore.getState().zoom
    if (zoom <= 0.18)      return handleCardDrop(e, files)
    if (zoom < 0.3)        return handleBlockDrop(e, files)
    return handleBoardDrop(e, files)
  }, [dropOnViewportWindow, handleCardDrop, handleBlockDrop, handleBoardDrop])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (isPanning.current) {
      isPanning.current = false
      return
    }
    // Clear card-level selection when clicking empty canvas (not on a card/node)
    const upTarget = e.target as Element
    if (!upTarget.closest('[data-group-card],[data-freenode]')) {
      useBoardsStore.getState().clearGroupSelection()
    }
    // Clear block-layer selection when clicking empty canvas (not on a block)
    if (!upTarget.closest('[data-layer-block]')) {
      useCanvasStore.getState().clearSelectedBlockBoardIds()
    }
    if (rbStartCanvas.current) {
      const containerRect = containerRef.current!.getBoundingClientRect()
      const rb = rubberBandRef.current
      if (rb) {
        const selLeft   = containerRect.left + Math.min(rb.sx, rb.ex)
        const selRight  = containerRect.left + Math.max(rb.sx, rb.ex)
        const selTop    = containerRect.top  + Math.min(rb.sy, rb.ey)
        const selBottom = containerRect.top  + Math.max(rb.sy, rb.ey)
        const w = selRight - selLeft
        const h = selBottom - selTop
        if (w > 5 || h > 5) {
          const hits = (el: Element) => {
            const r = el.getBoundingClientRect()
            return r.left < selRight && r.right > selLeft && r.top < selBottom && r.bottom > selTop
          }
          const currentZoom = useCanvasStore.getState().zoom
          const isBlockZoom = currentZoom > 0.18 && currentZoom < 0.3
          if (isBlockZoom) {
            // Block zoom: select whole blocks (boards) instead of bars
            const hitBlockBoardIds = Array.from(document.querySelectorAll('[data-layer-block]'))
              .filter(hits)
              .map(el => (el as HTMLElement).dataset.layerBlock!)
              .filter(Boolean)
            if (hitBlockBoardIds.length > 0) {
              useCanvasStore.getState().setSelectedBlockBoardIds(hitBlockBoardIds)
            }
          } else {
            // Board zoom: select individual bars, grouped by board
            const hitBlocks = Array.from(document.querySelectorAll('[data-block][data-id]'))
              .filter(el => !(el as HTMLElement).hasAttribute('data-layer-block'))
              .filter(hits)
            const perBoard = new Map<string, string[]>()
            hitBlocks.forEach(el => {
              const bid = (el as HTMLElement).dataset.boardId ?? 'primary'
              const id = (el as HTMLElement).dataset.id!
              if (!perBoard.has(bid)) perBoard.set(bid, [])
              perBoard.get(bid)!.push(id)
            })
            perBoard.forEach((ids, bid) => {
              useBoardsStore.getState().setSelection(bid, ids)
            })
          }
          // Pinned nodes are excluded: the band is a canvas-space gesture,
          // and a screen-fixed panel it merely happens to sweep across is
          // not something the user was selecting.
          const nodeIds = Array.from(document.querySelectorAll('[data-freenode][data-id]:not([data-pinned])'))
            .filter(hits).map(el => (el as HTMLElement).dataset.id!)
          if (nodeIds.length > 0) setFreeSelection(nodeIds)
          // Card group hit-test
          const hitGroups = Array.from(document.querySelectorAll('[data-group-card][data-id]'))
            .filter(hits).map(el => (el as HTMLElement).dataset.id!)
          if (hitGroups.length > 0) useBoardsStore.getState().setSelectedGroups(hitGroups)
        }
      }
      rbStartCanvas.current = null
      setRubberBand(null)
    }
  }, [setFreeSelection])

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: '#12131f',
        cursor: spaceActive ? 'grab' : 'default',
      }}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onContextMenu={e => {
        if ((e.target as Element).closest('[data-block],[data-board],[data-freenode],[data-viewport3d]')) return
        e.preventDefault()
        const rect = containerRef.current!.getBoundingClientRect()
        const cx = (e.clientX - rect.left - pan.x) / zoom
        const cy = (e.clientY - rect.top - pan.y) / zoom
        setAddMenu({ sx: e.clientX, sy: e.clientY, cx, cy })
      }}
    >
      <DotGrid panX={pan.x} panY={pan.y} />

      {/* ── NLE row lines (behind everything, in canvas space) ── */}
      <NLERowBands pan={pan} zoom={zoom} />

      {/* ── Shared WebGL canvas for 3D viewport windows — painted BEFORE the
             world transform container so GL pixels sit under all canvas
             content (windows live "under" nodes/bars). ── */}
      <GLCanvasHost containerRef={containerRef} />

      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          willChange: 'transform',
        }}
      >
        {children}
      </div>

      {/* ── Screen-pinned nodes — OUTSIDE the world transform, but the
             SAME origin `pan` is measured in, so the pin math needs no
             offset term. Not part of `children`, so LayerRouter never
             remounts them at a zoom threshold. ── */}
      <PinLayer />

      <div style={{
        position: 'absolute',
        bottom: 12,
        right: 16,
        color: 'rgba(255,255,255,0.22)',
        fontSize: 11,
        fontFamily: 'monospace',
        userSelect: 'none',
        pointerEvents: 'none',
      }}>
        {Math.round(zoom * 100)}% · {zoom <= 0.18 ? 'Cards' : zoom < 0.3 ? 'Blocks' : 'Boards'} · scroll to zoom · middle-drag or space+drag to pan
      </div>

      {/* ── Rubber-band selection overlay ── */}
      {rubberBand && (
        <div style={{
          position: 'absolute',
          left: Math.min(rubberBand.sx, rubberBand.ex),
          top: Math.min(rubberBand.sy, rubberBand.ey),
          width: Math.abs(rubberBand.ex - rubberBand.sx),
          height: Math.abs(rubberBand.ey - rubberBand.sy),
          border: '1.5px solid rgba(120,170,255,0.8)',
          background: 'rgba(100,150,255,0.08)',
          borderRadius: 3,
          pointerEvents: 'none',
          zIndex: 200,
        }} />
      )}

      {/* ── Add-node context menu ── */}
      {addMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 900 }} onPointerDown={() => setAddMenu(null)} />
          <div style={{
            position: 'fixed',
            left: addMenu.sx, top: addMenu.sy,
            zIndex: 901,
            background: '#13141f',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            padding: '4px 0',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            minWidth: 160,
          }}>
            {[
              { label: '📝  Add note',  action: () => { addNodeAtCursor('note',  200, 160); setAddMenu(null) } },
              { label: 'T   Add text',  action: () => { addNodeAtCursor('text',  200, 180); setAddMenu(null) } },
              { label: '🖼  Add image', action: () => { addNodeAtCursor('image', 200, 180); setAddMenu(null) } },
              { label: '◆  Add Viewer', action: () => {
                useUndoCoordinator.getState().checkpoint()
                const k = createScale()
                const w = VIEWPORT3D_DEFAULT_W * k, h = VIEWPORT3D_DEFAULT_H * k
                useViewport3DStore.getState().addWindow(addMenu.cx - w / 2, addMenu.cy - h / 2)
                const wins = useViewport3DStore.getState().windows
                const newest = Object.values(wins).reduce((a, b) => (a && a.createdAt >= b.createdAt ? a : b))
                if (newest) useViewport3DStore.getState().updateWindow(newest.id, { width: w, height: h })
                setAddMenu(null)
              } },
              { label: '─────────────', action: null },
              { label: zoom <= 0.18 ? '🎬  New Card' : '🎬  New Board',
                action: () => {
                useUndoCoordinator.getState().checkpoint()
                const k = createScale()
                const boardId = useBoardsStore.getState().createBoard(0, 0)
                useBoardsStore.getState().moveToNewGroup(boardId)
                const bs = useBoardsStore.getState()
                const group = bs.groups.find(g => g.boardIds.includes(boardId))
                const board = bs.boards[boardId]
                const rootId = board?.rootIds[0]
                // Scale the root bar so the card reads at a comfortable
                // SCREEN size at the zoom it was created from.
                if (rootId && k !== 1) {
                  const bar = board.bars[rootId]
                  bs.resizeBarEdge(boardId, rootId, 'right', bar.width * (k - 1))
                  bs.setBarHeight(boardId, rootId, bar.height * k)
                }
                // Center the card's footprint on the cursor (setGroupPos
                // takes y, x — origin is the card's top-left content corner).
                const cardW = (board?.bars[rootId ?? '']?.width ?? 480) * k
                const cardH = (board?.bars[rootId ?? '']?.height ?? 270) * k
                if (group) {
                  useBoardsStore.getState().setGroupPos(
                    group.id,
                    addMenu.cy - cardH / 2,
                    addMenu.cx - cardW / 2 - CARD_CONTENT_INSET,
                  )
                }
                setAddMenu(null)
              }},
            ].map((item, idx) => (
              item.action === null ? (
                <div key={idx} style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '3px 10px' }} />
              ) : (
                <div
                  key={item.label}
                  onPointerDown={e => { e.stopPropagation(); item.action!() }}
                  style={{ padding: '7px 14px', fontSize: 12, color: 'rgba(255,255,255,0.8)', cursor: 'pointer', borderRadius: 4, margin: '0 4px' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >{item.label}</div>
              )
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** NLE row bands scoped to group bounding boxes + card-level grid lines.
 *  Decorative background — can lag one frame behind a drag without the user
 *  noticing. Uses useDeferredValue so the heavy JSX work happens on idle time
 *  while the dragged card itself updates immediately. */
const NLERowBands: React.FC<{ pan: { x: number; y: number }; zoom: number }> = React.memo(({ pan, zoom }) => {
  const boards = useBoardsStore(s => s.boards)
  const groups = useBoardsStore(s => s.groups)
  // Defer the inputs so card drags don't block on rebuilding all band JSX.
  const deferredGroups = useDeferredValue(groups)
  const deferredBoards = useDeferredValue(boards)
  const BOARD_PADDING_X = 20
  const BAND_PAD = 30 // breathing room around content edges
  const isCardLevel = zoom <= 0.18

  // Memoize the expensive JSX build — it only needs to change when the
  // deferred inputs (or the card-level flag) change. During a pointermove
  // burst, deferredGroups holds its previous value, so this memo hits.
  const { cardGridLines, rowBands } = useMemo(() => {
    const cardGridLines: React.ReactNode[] = []
    if (isCardLevel) {
      let minY = Infinity, maxY = -Infinity
      deferredGroups.forEach(g => {
        const gl = computeGroupLayout(g.boardIds, deferredBoards)
        if (g.originY < minY) minY = g.originY
        const bottom = g.originY + gl.totalHeight
        if (bottom > maxY) maxY = bottom
      })
      if (minY === Infinity) { minY = 0; maxY = 2000 }
      const gridTop = Math.floor((minY - 500) / CARD_GRID_SPACING) * CARD_GRID_SPACING
      const gridBottom = maxY + 1000
      for (let y = gridTop; y <= gridBottom; y += CARD_GRID_SPACING) {
        cardGridLines.push(
          <div key={`cg-${y}`} style={{
            position: 'absolute',
            left: -8000, width: 20000,
            top: y, height: 1,
            background: 'rgba(130,180,255,0.06)',
          }} />
        )
      }
    }

    const rowBands: React.ReactNode[] = []
    deferredGroups
      .filter(g => !(g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id))
      .forEach(group => {
        const layout = computeGroupLayout(group.boardIds, deferredBoards)

        let groupLeft = Infinity, groupRight = -Infinity
        group.boardIds.forEach(bid => {
          const board = deferredBoards[bid]
          if (!board) return
          const bScale = board.boardScale ?? 1
          const rootBars = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
          if (rootBars.length === 0) return
          const bx = group.originX + (board.nleX ?? 0)
          const minX = Math.min(...rootBars.map(b => b.x))
          const maxX = Math.max(...rootBars.map(b => b.x + b.width))
          const l = bx + BOARD_PADDING_X + minX * bScale
          const r = bx + BOARD_PADDING_X + maxX * bScale
          if (l < groupLeft) groupLeft = l
          if (r > groupRight) groupRight = r
        })
        if (groupLeft === Infinity) return

        groupLeft -= BAND_PAD
        groupRight += BAND_PAD
        const bandWidth = groupRight - groupLeft

        const occupiedRows = new Set<number>()
        group.boardIds.forEach(bid => {
          const b = deferredBoards[bid]
          if (b) occupiedRows.add(b.nleRow ?? 0)
        })
        const minOccupied = Math.min(...occupiedRows)
        const maxOccupied = Math.max(...occupiedRows)

        for (let idx = 0; idx < maxOccupied - minOccupied + 1; idx++) {
          const i = minOccupied + idx
          const rowTop = group.originY + getRowY(i, layout)
          const rowH = getRowHeight(i, layout)
          rowBands.push(
            <React.Fragment key={`${group.id}-${i}`}>
              {i % 2 === 0 && (
                <div style={{
                  position: 'absolute',
                  left: groupLeft, width: bandWidth,
                  top: rowTop,
                  height: rowH,
                  background: 'rgba(255,255,255,0.008)',
                  borderRadius: 6,
                }} />
              )}
              <div style={{
                position: 'absolute',
                left: groupLeft, width: bandWidth,
                top: rowTop,
                height: 1,
                background: i === minOccupied ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.03)',
              }} />
            </React.Fragment>
          )
        }
      })
    return { cardGridLines, rowBands }
  }, [deferredGroups, deferredBoards, isCardLevel])

  return (
    <div style={{
      position: 'absolute', left: 0, top: 0,
      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
      transformOrigin: '0 0',
      pointerEvents: 'none',
      willChange: 'transform',
    }}>
      {cardGridLines}
      {rowBands}
    </div>
  )
})

const DotGrid: React.FC<{ panX: number; panY: number }> = ({ panX, panY }) => {
  const spacing = 40
  const ox = ((panX % spacing) + spacing) % spacing
  const oy = ((panY % spacing) + spacing) % spacing
  return (
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
      <defs>
        <pattern id="dot-grid" x={ox} y={oy} width={spacing} height={spacing} patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1.2" fill="rgba(120,120,180,0.22)" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#dot-grid)" />
    </svg>
  )
}
