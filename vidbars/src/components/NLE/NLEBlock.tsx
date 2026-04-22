// v3 — uses BoardContext
import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useCanvasStore } from '../../store/canvasStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useBoardCtx } from '../../contexts/BoardContext'
import { ContextMenu } from '../Bar/ContextMenu'
import { CircularColorPicker } from '../Bar/CircularColorPicker'
// ColorHoverWheel replaced by inline ear variants
// transferBar removed — reparenting is done via port wires, not cross-board drag
import { gripDragState } from '../../utils/gripDragState'
import { wireDragState } from '../../utils/wireDragState'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { uploadFile } from '../../utils/uploadFile'
import { getFirstImageUrl } from '../../types/bar'
import { HeroImageLayer } from '../Layers/HeroImageLayer'
import { HeroImageEditOverlay } from '../UI/HeroImageEditOverlay'
import { generateHoverVariants, selectionHighlight } from '../../utils/colorUtils'
import { TextFormatToolbar, ensureFontLoaded, hexToRgba } from '../UI/TextFormatToolbar'
import { DEFAULT_HEADER_STYLE, DEFAULT_BODY_STYLE } from '../../store/freeNodeStore'

const MIN_H = 90

interface Props {
  id: string
  top: number
  blockHeight: number
  offsetX: number
  rowTops: Record<number, number>
  rowHeights: Record<number, number>
}

function darken(hex: string, amt = 0.35): string {
  const n = parseInt(hex.replace('#', ''), 16)
  const r = Math.max(0, (n >> 16) - Math.round(255 * amt))
  const g = Math.max(0, ((n >> 8) & 0xff) - Math.round(255 * amt))
  const b = Math.max(0, (n & 0xff) - Math.round(255 * amt))
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

/** Draggable divider between header and body text in NLEBlock (board-level zoom ≥ 0.3) */
const NLETextSplitDivider: React.FC<{
  ratio: number; onRatioChange: (r: number) => void
}> = ({ ratio, onRatioChange }) => {
  const zoom = useCanvasStore(s => s.zoom)
  const [dragging, setDragging] = useState(false)
  const [hovered, setHovered] = useState(false)
  const onDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    setDragging(true)
    const container = (e.currentTarget as HTMLElement).parentElement
    if (!container) return
    const rect = container.getBoundingClientRect()
    const onMove = (ev: PointerEvent) => {
      const r = Math.max(0.1, Math.min(0.9, (ev.clientY - rect.top) / rect.height))
      onRatioChange(r)
    }
    const onUp = () => { setDragging(false); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp)
  }, [onRatioChange])
  // Board zoom ≥0.3, so scaling less aggressive here
  const grabPad = Math.round(4 / zoom)
  const lineH = Math.round(3 / zoom)
  const lineBg = dragging ? 'rgba(100,160,255,0.9)' : hovered ? 'rgba(100,160,255,0.7)' : 'rgba(130,180,255,0.4)'
  const zoneBg = dragging ? 'rgba(100,160,255,0.15)' : hovered ? 'rgba(100,160,255,0.12)' : 'transparent'
  return (
    <div
      style={{
        padding: `${grabPad}px ${Math.round(3 / zoom)}px`,
        cursor: 'row-resize', pointerEvents: 'auto',
        backgroundColor: zoneBg,
        borderRadius: Math.max(1, Math.round(1 / zoom)),
        transition: 'background-color 0.15s',
      }}
      onPointerDown={onDown}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => { if (!dragging) setHovered(false) }}
    >
      <div style={{
        height: lineH,
        borderRadius: Math.max(1, Math.round(1 / zoom)),
        backgroundColor: lineBg,
        transition: 'background-color 0.15s',
      }} />
    </div>
  )
}

export const NLEBlock: React.FC<Props> = React.memo(({ id, top, blockHeight, offsetX, rowTops, rowHeights }) => {
  const ctx = useBoardCtx()
  const {
    bars, selectedIds,
    moveBar, moveMultiple, resizeBarEdge, setBarHeight, renameBar,
    setSubtitle, setIcon, setColor, addChildToBar, addSiblingBar, addParentAbove,
    setContent, toggleCollapsed, toggleSelection, setSelection, reorderSiblings,
    changeBarRow, reparentBar,
    getSelectedIds, getBars,
  } = ctx

  const bar = bars[id]
  const isSelected = selectedIds.includes(id)
  const zoom = useCanvasStore(s => s.zoom)
  const boardScale = useBoardsStore(s => s.boards[ctx.boardId]?.boardScale ?? 1)
  // Effective zoom = canvas zoom × boardScale — used for counter-scaling text to stay readable
  // Sqrt-damped: pill grows as you zoom out, but not so aggressively that it dominates small bars
  const effZoom = zoom * boardScale
  const iz = 1 / Math.sqrt(Math.max(effZoom, 0.12))

  const [isHovered, setIsHovered] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [isRenamingSubtitle, setIsRenamingSubtitle] = useState(false)
  const [subtitleVal, setSubtitleVal] = useState('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [colorPickerPos, setColorPickerPos] = useState({ x: 0, y: 0 })
  const [isDraggingReorder, setIsDraggingReorder] = useState(false)
  const [gripOffsetY, setGripOffsetY] = useState(0)
  const [colorDragging, setColorDragging] = useState(false)
  const [colorDragPos, setColorDragPos] = useState({ x: 0, y: 0 })
  const colorDragHasMoved = useRef(false)
  const colorDragStart = useRef({ x: 0, y: 0 })
  const [showHoverWheel, setShowHoverWheel] = useState(false)
  const [showTextToolbar, setShowTextToolbar] = useState(false)
  const [isEditingText, setIsEditingText] = useState(false)
  const [isEditingImage, setIsEditingImage] = useState(false)
  const [editingTextField, setEditingTextField] = useState<'header' | 'body' | null>(null)
  const [activeTextField, setActiveTextField] = useState<'header' | 'body'>('header')
  const textEditRef = useRef<HTMLTextAreaElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const colorDotRef = useRef<HTMLDivElement>(null)

  const nameRef = useRef<HTMLInputElement>(null)
  const subtitleRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const iconInputRef = useRef<HTMLInputElement>(null)
  const mediaInputRef = useRef<HTMLInputElement>(null)

  const wireTargetRef = useRef<string | null>(null)
  const wireTargetBoardRef = useRef<string | null>(null)
  const isDragging = useRef(false)
  const dragLastX = useRef(0)
  const dragLastY = useRef(0)
  const gripRawY = useRef(0)
  const dragHasMoved = useRef(false)
  const isReorderMode = useRef(false)
  const leftEdgeLastX = useRef(0)
  const rightEdgeLastX = useRef(0)
  const cornerLastX = useRef(0)
  const cornerLastY = useRef(0)

  useEffect(() => { if (isRenaming) { nameRef.current?.focus(); nameRef.current?.select() } }, [isRenaming])
  useEffect(() => { if (isRenamingSubtitle) { subtitleRef.current?.focus(); subtitleRef.current?.select() } }, [isRenamingSubtitle])

  const startRename = useCallback(() => { setRenameVal(bar?.name ?? ''); setIsRenaming(true) }, [bar?.name])
  const commitRename = useCallback(() => {
    const name = renameVal.trim()
    if (!name) { setIsRenaming(false); return }
    const targets = isSelected && selectedIds.length > 1 ? selectedIds : [id]
    targets.forEach(tid => renameBar(tid, name))
    setIsRenaming(false)
  }, [id, renameVal, renameBar, isSelected, selectedIds])
  const commitSubtitle = useCallback(() => { setSubtitle(id, subtitleVal); setIsRenamingSubtitle(false) }, [id, subtitleVal, setSubtitle])

  const onGripDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    isReorderMode.current = true
    isDragging.current = true
    dragHasMoved.current = false
    dragLastX.current = e.clientX
    dragLastY.current = e.clientY
    gripRawY.current = 0
    setGripOffsetY(0)
    setIsDraggingReorder(true)
    wrapperRef.current?.setPointerCapture(e.pointerId)
  }, [])

  const onBodyDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return  // let middle/right bubble for canvas pan & context menu
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'TEXTAREA') return
    if ((e.target as Element).closest?.('[data-handle]')) return
    if (e.shiftKey) {
      toggleSelection(id)
      e.stopPropagation()
      return
    }
    // Note: checkpoint is deferred to onBodyMove's first actual motion so a
    // click / double-click (no drag) doesn't pay the ~20ms per-pointerdown
    // structuredClone cost that was choking text-edit entry.
    isDragging.current = true
    dragHasMoved.current = false
    dragLastX.current = e.clientX
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    e.stopPropagation()
  }, [id, toggleSelection])

  const onBodyMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return
    const dx = (e.clientX - dragLastX.current) / zoom
    const dy = (e.clientY - dragLastY.current) / zoom
    const actuallyMoved = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5
    // Lazy checkpoint — only when an actual drag is detected, not on every
    // pointerdown. This skips the clone cost for clicks and double-clicks.
    if (actuallyMoved && !dragHasMoved.current) {
      useUndoCoordinator.getState().checkpoint()
    }
    if (actuallyMoved) dragHasMoved.current = true
    dragLastX.current = e.clientX
    dragLastY.current = e.clientY
    const currentSelectedIds = getSelectedIds()
    if (isReorderMode.current) {
      moveMultiple([id], dx)
      // Track raw Y accumulation, then snap to nearest row
      const rawOffsetY = gripRawY.current + dy
      gripRawY.current = rawOffsetY

      const currentBar = getBars()[id]
      if (currentBar) {
        const currentRowTop = rowTops[currentBar.rowIndex] ?? 0
        const draggedTop = currentRowTop + rawOffsetY

        // Find nearest row to snap to (including virtual rows above & below)
        let bestRow = currentBar.rowIndex
        let bestDist = Infinity
        let bestTop = currentRowTop
        const sortedRows = Object.entries(rowTops)
          .map(([r, t]) => ({ row: Number(r), top: t as number }))
          .sort((a, b) => a.top - b.top)

        for (const { row, top: rTop } of sortedRows) {
          const dist = Math.abs(draggedTop - rTop)
          if (dist < bestDist) { bestDist = dist; bestRow = row; bestTop = rTop }
        }

        // Virtual rows ABOVE the first existing row (to allow dragging to row 0 or above)
        if (sortedRows.length > 0) {
          let prevRow = sortedRows[0]
          for (let i = 0; i < 3; i++) {
            const virtualRow = prevRow.row - 1
            if (virtualRow < 0) break
            const virtualTop = prevRow.top - (currentBar.height + 40)
            const dist = Math.abs(draggedTop - virtualTop)
            if (dist < bestDist) { bestDist = dist; bestRow = virtualRow; bestTop = virtualTop }
            prevRow = { row: virtualRow, top: virtualTop }
          }
        }

        // Virtual rows BELOW the last existing row
        if (sortedRows.length > 0) {
          let prevRow = sortedRows[sortedRows.length - 1]
          for (let i = 0; i < 5; i++) {
            const prevH = rowHeights[prevRow.row] ?? currentBar.height
            const virtualTop = prevRow.top + prevH + 40
            const virtualRow = prevRow.row + 1
            const dist = Math.abs(draggedTop - virtualTop)
            if (dist < bestDist) { bestDist = dist; bestRow = virtualRow; bestTop = virtualTop }
            if (virtualTop > draggedTop + 200) break
            prevRow = { row: virtualRow, top: virtualTop }
          }
        }

        const snappedOffset = bestTop - currentRowTop
        setGripOffsetY(snappedOffset)

        // Update shared drag state for wire rendering
        gripDragState.set({ blockId: id, offsetY: snappedOffset, snappedRow: bestRow })
      }

    } else if (isSelected && currentSelectedIds.length > 1) {
      moveMultiple(currentSelectedIds, dx)
    } else {
      moveBar(id, dx)
    }
  }, [id, moveBar, moveMultiple, isSelected, zoom, getSelectedIds])

  const onBodyUp = useCallback(() => {
    if (isDragging.current && !dragHasMoved.current && !isReorderMode.current) {
      setSelection([id])
    } else if (isDragging.current && dragHasMoved.current) {
      const currentSelectedIds = getSelectedIds()
      const isCurrentlySelected = currentSelectedIds.includes(id)

      if (isReorderMode.current) {
        // Check for row change based on snapped position
        const dragState = gripDragState.get()
        const currentBars = getBars()
        const bar = currentBars[id]
        if (bar && dragState && dragState.snappedRow !== bar.rowIndex) {
          const parent = bar.parentId ? currentBars[bar.parentId] : null
          // Detach when dragged to parent's row or above — child becomes independent
          const shouldDetach = !!parent && dragState.snappedRow <= parent.rowIndex
          changeBarRow(id, dragState.snappedRow, shouldDetach)
        } else {
          reorderSiblings(id)
        }
      } else {
        const ids = isCurrentlySelected && currentSelectedIds.length > 1
          ? currentSelectedIds : [id]
        ids.forEach(sid => reorderSiblings(sid))
      }
    }
    isDragging.current = false
    isReorderMode.current = false
    setIsDraggingReorder(false)
    setGripOffsetY(0)
    gripRawY.current = 0
    gripDragState.set(null)
  }, [id, isSelected, getSelectedIds, getBars, setSelection, reorderSiblings, changeBarRow, rowTops, rowHeights])

  const onLeftDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    leftEdgeLastX.current = e.clientX
    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom || 1
      resizeBarEdge(id, 'left', (ev.clientX - leftEdgeLastX.current) / z)
      leftEdgeLastX.current = ev.clientX
    }
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [id, resizeBarEdge])

  const onRightDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    rightEdgeLastX.current = e.clientX
    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom || 1
      resizeBarEdge(id, 'right', (ev.clientX - rightEdgeLastX.current) / z)
      rightEdgeLastX.current = ev.clientX
    }
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [id, resizeBarEdge])

  const SNAP_RATIOS = [9 / 16, 1, 16 / 9]
  const SNAP_THRESHOLD = 0.07

  const onCornerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    cornerLastX.current = e.clientX
    cornerLastY.current = e.clientY
    const boardId = ctx.boardId
    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom || 1
      const dx = (ev.clientX - cornerLastX.current) / z
      const dy = (ev.clientY - cornerLastY.current) / z
      const selIds = useBoardsStore.getState().boards[boardId]?.selectedIds ?? []
      const curBars = useBoardsStore.getState().boards[boardId]?.bars ?? {}
      const targets = selIds.includes(id) && selIds.length > 1 ? selIds : [id]
      if (dx !== 0) {
        targets.forEach(sid => useBoardsStore.getState().resizeBarEdge(boardId, sid, 'right', dx))
        cornerLastX.current = ev.clientX
      }
      if (dy !== 0) {
        targets.forEach(sid => {
          const b = curBars[sid]
          if (!b) return
          let newH = b.height + dy
          if (ev.shiftKey) {
            const ratio = newH / b.width
            const snapped = SNAP_RATIOS.find(r => Math.abs(ratio - r) / r < SNAP_THRESHOLD)
            if (snapped) newH = b.width * snapped
          }
          useBoardsStore.getState().setBarHeight(boardId, sid, newH)
        })
        cornerLastY.current = ev.clientY
      }
    }
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [id, ctx.boardId])

  const handleIconFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    uploadFile(file).then(({ url }) => setIcon(id, url))
    e.target.value = ''
  }, [id, setIcon])

  const handleMediaFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    Array.from(e.target.files ?? []).forEach(file => {
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/') && !file.type.startsWith('audio/')) return
      uploadFile(file).then(({ url, type }) => {
        const currentBars = getBars()
        const curMedia = currentBars[id]?.content.media ?? []
        setContent(id, { media: [...curMedia, { url, type: type as any, originalName: file.name }] })
      })
    })
    e.target.value = ''
  }, [id, setContent, getBars])

  const handleColorPickerOpen = useCallback(() => {
    useUndoCoordinator.getState().checkpoint()
    const rect = wrapperRef.current?.getBoundingClientRect()
    setColorPickerPos({ x: rect?.left ?? 0, y: (rect?.top ?? 0) + 50 })
    setShowColorPicker(true)
  }, [])

  const onColorDotDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    colorDragHasMoved.current = false
    colorDragStart.current = { x: e.clientX, y: e.clientY }
    setShowHoverWheel(false)
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - colorDragStart.current.x
      const dy = ev.clientY - colorDragStart.current.y
      if (dx * dx + dy * dy > 25) {
        colorDragHasMoved.current = true
        setColorDragging(true)
      }
      if (colorDragHasMoved.current) {
        setColorDragPos({ x: ev.clientX, y: ev.clientY })
        // Highlight target bar under cursor
        document.querySelectorAll('[data-color-drop-target]').forEach(el => el.removeAttribute('data-color-drop-target'))
        const el = document.elementFromPoint(ev.clientX, ev.clientY)
        const blockEl = el?.closest('[data-block][data-id]') as HTMLElement | null
        if (blockEl && (blockEl.dataset.id !== id || blockEl.dataset.boardId !== ctx.boardId)) {
          blockEl.setAttribute('data-color-drop-target', 'true')
        }
      }
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setColorDragging(false)
      document.querySelectorAll('[data-color-drop-target]').forEach(el => el.removeAttribute('data-color-drop-target'))
      if (!colorDragHasMoved.current) return // click handled by onClick
      // Drag — find target bar under pointer
      colorDragHasMoved.current = false
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const blockEl = el?.closest('[data-block][data-id]') as HTMLElement | null
      if (!blockEl) return
      const targetId = blockEl.dataset.id!
      const targetBoardId = blockEl.dataset.boardId ?? 'primary'
      if (targetId === id && targetBoardId === ctx.boardId) return
      useUndoCoordinator.getState().checkpoint()
      const srcColor = bar?.color ?? '#6B8AFF'
      useBoardsStore.getState().setBarColor(targetBoardId, targetId, srcColor)
      if (isSelected && selectedIds.length > 1) {
        selectedIds.filter(sid => sid !== id).forEach(sid => setColor(sid, srcColor))
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [id, bar?.color, isSelected, selectedIds, setColor, ctx.boardId])

  const onColorDotClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (colorDragHasMoved.current) return // was a drag, not a click
    handleColorPickerOpen()
  }, [handleColorPickerOpen])

  if (!bar) return null

  const compact = blockHeight < 72
  const medium  = blockHeight >= 72 && blockHeight < 105
  const iconSz  = compact ? 0 : medium ? 20 : 28
  const bg = bar.color
  const pillBg = darken(bg, 0.38)
  const nodeSelFx = isSelected ? selectionHighlight(bar.color, { ringWidthPx: 2.5, glowBlurPx: 22 }) : null

  const overlayPill: React.CSSProperties = {
    background: 'rgba(0,0,0,0.22)',
    border: '1px solid rgba(255,255,255,0.09)',
    borderRadius: 20,
    color: 'rgba(255,255,255,0.65)',
    fontSize: 10,
    fontWeight: 600,
    padding: '3px 11px',
    cursor: 'pointer',
    letterSpacing: '0.3px',
    userSelect: 'none',
    backdropFilter: 'blur(4px)',
    lineHeight: 1.4,
  }

  const smallHandle: React.CSSProperties = {
    background: 'rgba(0,0,0,0.20)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 5,
    color: 'rgba(255,255,255,0.45)',
    fontSize: 12,
    fontWeight: 900,
    width: 20, height: 20,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'ew-resize',
    userSelect: 'none',
    flexShrink: 0,
  }

  const smallPlus: React.CSSProperties = {
    background: 'rgba(0,0,0,0.20)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '50%',
    color: 'rgba(255,255,255,0.5)',
    fontSize: 14,
    fontWeight: 700,
    width: 20, height: 20,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer',
    userSelect: 'none',
    flexShrink: 0,
  }

  return (
    <>
      <input ref={iconInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleIconFile} />
      <input ref={mediaInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleMediaFile} />

      <div
        ref={wrapperRef}
        data-block="true"
        data-id={id}
        data-board-id={ctx.boardId}
        style={{
          position: 'absolute',
          left: bar.x + offsetX,
          top: top,
          width: bar.width,
          height: blockHeight,
          zIndex: isDraggingReorder ? 30 : isHovered ? 10 : isSelected ? 8 : 2,
          borderRadius: 12,
          opacity: isDraggingReorder ? 0.82 : 1,
          transition: isDraggingReorder ? 'none' : 'opacity 0.1s',
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onPointerDown={onBodyDown}
        onPointerMove={onBodyMove}
        onPointerUp={onBodyUp}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY }) }}
        onDoubleClick={(e) => {
          if (dragHasMoved.current) return
          e.stopPropagation()
          setShowTextToolbar(true)
          setIsEditingText(true)
          setEditingTextField('header')
          setActiveTextField('header')
        }}
        onDragOver={e => e.preventDefault()}
      >
        {/* ── Background layer ── */}
        <div style={{
          position: 'absolute', inset: 0, borderRadius: 12, background: bg, overflow: 'hidden', zIndex: 0,
          boxShadow: isDraggingReorder
            ? '0 0 0 2px rgba(255,210,80,0.9), 0 20px 50px rgba(0,0,0,0.7)'
            : nodeSelFx
            ? nodeSelFx.boxShadow
            : isHovered
            ? '0 8px 32px rgba(0,0,0,0.5), 0 0 0 2px rgba(255,255,255,0.25)'
            : '0 2px 10px rgba(0,0,0,0.4), 0 0 0 1px rgba(0,0,0,0.25)',
          transition: 'box-shadow 0.12s ease',
        }}>
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(160deg, rgba(255,255,255,0.10) 0%, rgba(0,0,0,0.10) 100%)' }} />
          {getFirstImageUrl(bar.content) && (
            <HeroImageLayer heroImage={getFirstImageUrl(bar.content)!} transform={bar.content.imageTransform} borderRadius={0} opacity={bar.content.imageTransform?.opacity ?? 0.82} />
          )}
          {(bar.content.text || bar.content.headerText || isEditingText) && (() => {
            const hts = { ...DEFAULT_HEADER_STYLE, ...bar.content.headerTextStyle }
            const bts = { ...DEFAULT_BODY_STYLE, ...bar.content.textStyle }
            ensureFontLoaded(hts.fontFamily); ensureFontLoaded(bts.fontFamily)
            const hasImage = !!getFirstImageUrl(bar.content)
            const containerStyle: React.CSSProperties = {
              position: 'absolute',
              top: compact ? 20 : medium ? 28 : 34,
              left: 0, right: 0, bottom: 0,
              padding: compact ? '2px 6px' : '6px 10px',
              background: 'none',
              overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
              zIndex: isEditingText ? 6 : 4,
            }
            const mkTextStyle = (ts: typeof hts): React.CSSProperties => {
              const bg = ts.bgOpacity > 0 ? hexToRgba(ts.bgColor, ts.bgOpacity) : null
              return {
                color: ts.color, fontSize: ts.fontSize, lineHeight: ts.lineHeight ?? 1.4,
                fontWeight: ts.fontWeight ?? (ts.bold ? 700 : 400), fontStyle: ts.italic ? 'italic' : 'normal',
                textAlign: ts.align, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                fontFamily: ts.fontFamily || 'inherit',
                letterSpacing: ts.letterSpacing ?? 0,
                textTransform: ts.textTransform ?? 'none',
                background: bg || 'transparent',
                borderRadius: bg ? 6 : 0,
                padding: bg ? 4 : 0,
                textShadow: hasImage && !bg ? '0 1px 6px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.7)' : 'none',
              }
            }
            const vAlignToJustify = (va?: string) => va === 'middle' ? 'center' : va === 'bottom' ? 'flex-end' : 'flex-start'
            if (isEditingText) {
              return (
                <div data-text-overlay style={containerStyle} tabIndex={-1}
                  onBlur={(e) => {
                    const related = e.relatedTarget as HTMLElement | null
                    if (related?.closest('[data-text-format-toolbar]')) return
                    if (related && e.currentTarget.contains(related)) return
                    // relatedTarget can be null when clicking non-focusable children — defer check
                    const container = e.currentTarget
                    requestAnimationFrame(() => {
                      if (container.contains(document.activeElement)) return
                      if (document.activeElement?.closest('[data-text-format-toolbar]')) return
                      setIsEditingText(false); setShowTextToolbar(false); setEditingTextField(null)
                    })
                  }}
                  onPointerDown={e => { if (!(e.target as HTMLElement).closest('textarea')) e.preventDefault() }}
                >
                  {/* Header field wrapper — independent vAlign */}
                  {(() => { const sr = bar.content.textSplitRatio ?? 0.5; return <>
                  <div style={{ flex: sr, display: 'flex', flexDirection: 'column', justifyContent: vAlignToJustify(hts.vAlign), minHeight: 0 }}>
                  {editingTextField === 'header' ? (
                    <textarea
                      ref={textEditRef}
                      autoFocus
                      value={bar.content.headerText ?? ''}
                      onChange={e => setContent(id, { headerText: e.target.value })}
                      onPointerDown={e => e.stopPropagation()}
                      onClick={() => setActiveTextField('header')}
                      onKeyDown={e => {
                        if (e.key === 'Escape') { setIsEditingText(false); setShowTextToolbar(false); setEditingTextField(null) }
                        if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); setEditingTextField('body'); setActiveTextField('body') }
                      }}
                      placeholder="Title…"
                      style={{
                        ...mkTextStyle(hts), width: '100%', boxSizing: 'border-box',
                        padding: 4, background: hts.bgOpacity > 0 ? hexToRgba(hts.bgColor, hts.bgOpacity) : 'rgba(0,0,0,0.2)',
                        border: '1px solid rgba(120,180,255,0.4)', borderRadius: 6,
                        outline: 'none', resize: 'none', cursor: 'text',
                      }}
                    />
                  ) : (
                    <div
                      style={{ ...mkTextStyle(hts), cursor: 'pointer', padding: bar.content.headerText ? 4 : 0 }}
                      onClick={() => { setEditingTextField('header'); setActiveTextField('header') }}
                    >{bar.content.headerText || null}</div>
                  )}
                  </div>
                  {/* Draggable divider between header and body */}
                  <NLETextSplitDivider ratio={sr} onRatioChange={r => setContent(id, { textSplitRatio: r })} />
                  {/* Body field wrapper — independent vAlign */}
                  <div style={{ flex: 1 - sr, display: 'flex', flexDirection: 'column', justifyContent: vAlignToJustify(bts.vAlign), minHeight: 0 }}>
                  {editingTextField === 'body' ? (
                    <textarea
                      autoFocus
                      value={bar.content.text}
                      onChange={e => setContent(id, { text: e.target.value })}
                      onPointerDown={e => e.stopPropagation()}
                      onClick={() => setActiveTextField('body')}
                      onKeyDown={e => {
                        if (e.key === 'Escape') { setIsEditingText(false); setShowTextToolbar(false); setEditingTextField(null) }
                        if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); setEditingTextField('header'); setActiveTextField('header') }
                      }}
                      placeholder="Body text…"
                      style={{
                        ...mkTextStyle(bts), flex: 1, width: '100%', boxSizing: 'border-box',
                        padding: 4, background: bts.bgOpacity > 0 ? hexToRgba(bts.bgColor, bts.bgOpacity) : 'rgba(0,0,0,0.2)',
                        border: '1px solid rgba(120,180,255,0.4)', borderRadius: 6,
                        outline: 'none', resize: 'none', cursor: 'text',
                      }}
                    />
                  ) : (
                    <div
                      style={{ ...mkTextStyle(bts), cursor: 'pointer', padding: bar.content.text ? 4 : 0 }}
                      onClick={() => { setEditingTextField('body'); setActiveTextField('body') }}
                    >{bar.content.text || null}</div>
                  )}
                  </div>
                  </> })()}
                </div>
              )
            }
            return (
              <div
                data-text-overlay
                style={{ ...containerStyle, cursor: 'pointer' }}
                onDoubleClick={e => {
                  e.stopPropagation()
                  setShowTextToolbar(true)
                  setIsEditingText(true)
                  setEditingTextField('header')
                  setActiveTextField('header')
                }}
              >
                {(() => { const sr = bar.content.textSplitRatio ?? 0.5; return <>
                <div style={{ flex: sr, display: 'flex', flexDirection: 'column', justifyContent: vAlignToJustify(hts.vAlign), minHeight: 0 }}>
                  {bar.content.headerText && <div style={mkTextStyle(hts)}>{bar.content.headerText}</div>}
                </div>
                <div style={{ flex: 1 - sr, display: 'flex', flexDirection: 'column', justifyContent: vAlignToJustify(bts.vAlign), minHeight: 0 }}>
                  {bar.content.text && <div style={mkTextStyle(bts)}>{bar.content.text}</div>}
                </div>
                </> })()}
              </div>
            )
          })()}
        </div>

        {/* ── Corner color ear (triangular, with color strip on card edges) ── */}
        {(() => {
          const earSz = 28
          const stripW = 6   // width of the color strip border
          const isEarActive = isHovered || showHoverWheel || showColorPicker || colorDragging
          const isExpanded = showHoverWheel && !colorDragging && !showColorPicker
          const { brighter1, brighter2, darker1, darker2 } = generateHoverVariants(bar.color)
          // 4 colors along top edge + left edge (card border only, not hypotenuse)
          // Top edge: right→left (brighter2, brighter1), Left edge: top→bottom (darker1, darker2)
          const topLen = earSz
          const leftLen = earSz
          const totalLen = topLen + leftLen
          const segLen = totalLen / 4
          // L-shaped path: along top edge then down left edge
          const sw2 = stripW / 2
          const pathD = `M ${earSz},${-sw2} L ${-sw2},${-sw2} L ${-sw2},${earSz}`
          const variants = [brighter2, brighter1, darker1, darker2]
          return (
            <div
              ref={colorDotRef}
              style={{
                position: 'absolute', top: 0, left: 0,
                width: earSz + stripW, height: earSz + stripW,
                zIndex: 25,
                cursor: colorDragging ? 'grabbing' : 'pointer',
              }}
              onPointerDown={onColorDotDown}
              onClick={onColorDotClick}
              onDoubleClick={e => { e.stopPropagation(); if (!isRenaming) startRename() }}
              onMouseEnter={() => {
                if (colorDragging) return
                hoverTimer.current = setTimeout(() => setShowHoverWheel(true), 250)
              }}
              onMouseLeave={() => {
                if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
                setTimeout(() => setShowHoverWheel(false), 300)
              }}
              title="Click to pick color · Drag to paint another node"
            >
              {/* Triangle ear fill — rounded top-left corner to match node */}
              <div style={{
                position: 'absolute', top: 0, left: 0,
                width: earSz, height: earSz,
                clipPath: 'polygon(12px 0, 100% 0, 0 100%, 0 12px)',
                background: bg,
                opacity: isEarActive ? 1 : 0.45,
                transition: 'opacity 0.2s',
                borderRadius: '12px 0 0 0',
              }} />
              {/* White edge highlight */}
              <div style={{
                position: 'absolute', top: 0, left: 0,
                width: earSz, height: earSz,
                clipPath: 'polygon(12px 0, 100% 0, 0 100%, 0 12px)',
                background: 'linear-gradient(135deg, rgba(255,255,255,0.25) 0%, transparent 50%)',
                opacity: isEarActive ? 1 : 0.5,
                transition: 'opacity 0.2s',
                pointerEvents: 'none',
                borderRadius: '12px 0 0 0',
              }} />
              {/* Color strip — 4 equal-length segments along L-path (top edge → corner arc → left edge) */}
              {isExpanded && (() => {
                const r = 12 // corner radius matching node border-radius
                const topStraight = earSz - r            // 16px
                const arcLen = Math.PI / 2 * r            // ~18.85px
                const leftStraight = earSz - r            // 16px
                const totalLen = topStraight + arcLen + leftStraight // ~50.85px
                const segLen = totalLen / 4
                const colors = [brighter2, brighter1, darker1, darker2]
                // SVG L-path: horizontal line right→left along top, arc at corner, vertical line down left edge
                // Origin at (earSz, 0) in SVG coords, stroke centered on path
                const svgW = earSz + stripW
                const svgH = earSz + stripW
                const pathD = `M ${earSz},${sw2} L ${r},${sw2} A ${r},${r} 0 0,0 ${sw2},${r} L ${sw2},${earSz}`
                return (
                  <svg
                    style={{ position: 'absolute', top: -sw2, left: -sw2, overflow: 'visible', zIndex: 26 }}
                    width={svgW} height={svgH}
                  >
                    {colors.map((c, i) => (
                      <path
                        key={i}
                        d={pathD}
                        fill="none"
                        stroke={c}
                        strokeWidth={stripW}
                        strokeLinecap="butt"
                        strokeDasharray={`${segLen} ${totalLen}`}
                        strokeDashoffset={-i * segLen}
                        style={{ cursor: 'pointer', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.2))' }}
                        onPointerDown={e => {
                          e.stopPropagation(); e.preventDefault()
                          useUndoCoordinator.getState().checkpoint()
                          const targets = isSelected && selectedIds.length > 1 ? selectedIds : [id]
                          targets.forEach(tid => setColor(tid, c))
                          setShowHoverWheel(false)
                        }}
                        onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(1.3) drop-shadow(0 1px 2px rgba(0,0,0,0.2))' }}
                        onMouseLeave={e => { e.currentTarget.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,0.2))' }}
                      />
                    ))}
                  </svg>
                )
              })()}
            </div>
          )
        })()}

        {/* ── Inline rename (shown on double-click or context menu) ── */}
        {isRenaming && (
          <div
            style={{
              position: 'absolute', top: 2, left: 32,
              zIndex: 12, pointerEvents: 'auto',
            }}
            onPointerDown={e => e.stopPropagation()}
          >
            <input ref={nameRef} value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onBlur={commitRename}
              onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setIsRenaming(false) }}
              onClick={e => e.stopPropagation()}
              style={{
                background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(100,160,255,0.5)',
                borderRadius: 6, outline: 'none', color: '#fff',
                fontSize: 12 * iz, fontWeight: 700, lineHeight: 1.2,
                padding: `${2 * iz}px ${6 * iz}px`,
                fontFamily: 'inherit', minWidth: 60 * iz,
                boxSizing: 'border-box',
                backdropFilter: 'blur(8px)',
              }}
            />
          </div>
        )}

        {/* ── Drag grip handle ── */}
        <div
          data-handle="grip"
          style={{
            position: 'absolute', top: 3, right: 34,
            width: 40, height: 28,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: isDraggingReorder ? 'grabbing' : 'grab',
            zIndex: 20,
          }}
          onPointerDown={onGripDown}
        >
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 4px)',
            gridTemplateRows: 'repeat(2, 4px)',
            gap: 2,
            opacity: isDraggingReorder ? 1 : isHovered ? 0.7 : 0.25,
            transition: 'opacity 0.12s',
          }}>
            {[0,1,2,3,4,5].map(i => (
              <div key={i} style={{ width: 3, height: 3, borderRadius: '50%', background: 'rgba(255,255,255,0.95)' }} />
            ))}
          </div>
        </div>

        {/* ── Ports (draggable for rewiring) ── */}
        {bar.rowIndex > 0 && (
          <div
            data-handle="port-top"
            data-port="top"
            data-port-block={id}
            style={{
              position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)',
              width: 20, height: 20, borderRadius: '50%',
              background: bar.color ?? 'rgba(140,175,255,0.65)', border: '2px solid rgba(255,255,255,0.35)',
              zIndex: 12, cursor: 'crosshair',
            }}
            onPointerDown={e => {
              e.stopPropagation()
              if (e.button !== 0) return
              useUndoCoordinator.getState().checkpoint()
              const portEl = e.currentTarget as HTMLElement
              const startX = bar.x + offsetX + bar.width / 2
              const startY = top
              const mouseStartX = e.clientX
              const mouseStartY = e.clientY
              const z = useCanvasStore.getState().zoom || 1
              wireTargetRef.current = null
              wireTargetBoardRef.current = null
              wireDragState.set({ fromBlockId: id, fromPort: 'top', startX, startY, currentX: startX, currentY: startY })
              const sourceBoardId = ctx.boardId
              const onMove = (ev: PointerEvent) => {
                const cx = startX + (ev.clientX - mouseStartX) / z
                const cy = startY + (ev.clientY - mouseStartY) / z
                wireDragState.set({ fromBlockId: id, fromPort: 'top', startX, startY, currentX: cx, currentY: cy })
                // Find target under cursor
                document.querySelectorAll('[data-drop-target]').forEach(el => el.removeAttribute('data-drop-target'))
                portEl.style.pointerEvents = 'none'
                const hit = document.elementFromPoint(ev.clientX, ev.clientY)
                portEl.style.pointerEvents = ''
                // Accept port OR block body as target
                const hitPort = hit?.closest?.('[data-port]') as HTMLElement | null
                const hitBlock = hit?.closest?.('[data-block]') as HTMLElement | null
                const targetId = hitPort?.dataset.portBlock ?? hitBlock?.dataset.id ?? null
                const targetBoardId = hitBlock?.dataset.boardId ?? null
                if (targetId && targetId !== id) {
                  wireTargetRef.current = targetId
                  wireTargetBoardRef.current = targetBoardId
                  ;(hitPort ?? hitBlock)?.setAttribute('data-drop-target', 'true')
                } else {
                  wireTargetRef.current = null
                  wireTargetBoardRef.current = null
                }
              }
              const onUp = () => {
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
                wireDragState.set(null)
                document.querySelectorAll('[data-drop-target]').forEach(el => el.removeAttribute('data-drop-target'))
                // Top port drag: "I want a new parent" → reparent this block under target
                const target = wireTargetRef.current
                const targetBoard = wireTargetBoardRef.current
                wireTargetRef.current = null
                wireTargetBoardRef.current = null
                if (target) {
                  if (targetBoard && targetBoard !== sourceBoardId) {
                    useBoardsStore.getState().crossBoardReparent(sourceBoardId, id, targetBoard, target)
                  } else {
                    reparentBar(id, target)
                  }
                }
              }
              window.addEventListener('pointermove', onMove)
              window.addEventListener('pointerup', onUp)
            }}
          />
        )}
        <div
          data-handle="port-bottom"
          data-port="bottom"
          data-port-block={id}
          style={{
            position: 'absolute', bottom: -10, left: '50%', transform: 'translateX(-50%)',
            width: 20, height: 20, borderRadius: '50%',
            background: bar.collapsed ? 'rgba(255,170,50,0.85)' : (bar.color ?? 'rgba(140,175,255,0.65)'),
            border: '2px solid rgba(255,255,255,0.35)',
            cursor: 'crosshair',
            zIndex: 12, transition: 'background 0.15s',
          }}
          onPointerDown={e => {
            e.stopPropagation()
            if (e.button !== 0) return
            useUndoCoordinator.getState().checkpoint()
            const portEl = e.currentTarget as HTMLElement
            const startX = bar.x + offsetX + bar.width / 2
            const startY = top + blockHeight
            const mouseStartX = e.clientX
            const mouseStartY = e.clientY
            const z = useCanvasStore.getState().zoom || 1
            wireTargetRef.current = null
            wireTargetBoardRef.current = null
            wireDragState.set({ fromBlockId: id, fromPort: 'bottom', startX, startY, currentX: startX, currentY: startY })
            const sourceBoardId = ctx.boardId
            const onMove = (ev: PointerEvent) => {
              const cx = startX + (ev.clientX - mouseStartX) / z
              const cy = startY + (ev.clientY - mouseStartY) / z
              wireDragState.set({ fromBlockId: id, fromPort: 'bottom', startX, startY, currentX: cx, currentY: cy })
              // Find target under cursor
              document.querySelectorAll('[data-drop-target]').forEach(el => el.removeAttribute('data-drop-target'))
              portEl.style.pointerEvents = 'none'
              const hit = document.elementFromPoint(ev.clientX, ev.clientY)
              portEl.style.pointerEvents = ''
              // Accept port OR block body as target
              const hitPort = hit?.closest?.('[data-port]') as HTMLElement | null
              const hitBlock = hit?.closest?.('[data-block]') as HTMLElement | null
              const targetId = hitPort?.dataset.portBlock ?? hitBlock?.dataset.id ?? null
              const targetBoardId = hitBlock?.dataset.boardId ?? null
              if (targetId && targetId !== id) {
                wireTargetRef.current = targetId
                wireTargetBoardRef.current = targetBoardId
                ;(hitPort ?? hitBlock)?.setAttribute('data-drop-target', 'true')
              } else {
                wireTargetRef.current = null
                wireTargetBoardRef.current = null
              }
            }
            const onUp = () => {
              window.removeEventListener('pointermove', onMove)
              window.removeEventListener('pointerup', onUp)
              wireDragState.set(null)
              document.querySelectorAll('[data-drop-target]').forEach(el => el.removeAttribute('data-drop-target'))
              // Bottom port drag: "I want to attach a child" → reparent target under this block
              const target = wireTargetRef.current
              const targetBoard = wireTargetBoardRef.current
              wireTargetRef.current = null
              wireTargetBoardRef.current = null
              if (target) {
                if (targetBoard && targetBoard !== sourceBoardId) {
                  // Target is in another board — transfer it to this board under this block
                  useBoardsStore.getState().crossBoardReparent(targetBoard, target, sourceBoardId, id)
                } else {
                  reparentBar(target, id)
                }
              }
            }
            window.addEventListener('pointermove', onMove)
            window.addEventListener('pointerup', onUp)
          }}
          onDoubleClick={e => {
            e.stopPropagation()
            if (bar.children.length > 0) toggleCollapsed(id)
          }}
          title={bar.children.length > 0 ? (bar.collapsed ? 'Expand children' : 'Collapse children') : undefined}
        />

        {/* ── Corner resize ── */}
        <div
          data-handle="corner"
          style={{
            position: 'absolute', bottom: 0, right: 0,
            width: 44, height: 44, cursor: 'nwse-resize', zIndex: 6,
            display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
            padding: '0 6px 6px 0',
          }}
          onPointerDown={onCornerDown}
        >
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 3px)', gridTemplateRows: 'repeat(3, 3px)', gap: '2px',
            opacity: isHovered ? 0.5 : 0.13, transition: 'opacity 0.12s',
          }}>
            {[...Array(9)].map((_, i) => (
              <div key={i} style={{
                width: 3, height: 3, borderRadius: '50%', background: 'rgba(255,255,255,0.95)',
                opacity: (i === 0 || i === 1 || i === 3) ? 0 : 1,
              }} />
            ))}
          </div>
        </div>

        {/* ── Hover overlay ── */}
        {isHovered && (
          <div style={{ position: 'absolute', inset: 0, borderRadius: 12, zIndex: 15, pointerEvents: 'none' }}>

            <button
              style={{
                position: 'absolute', top: 8, right: 8,
                width: 22, height: 22, borderRadius: '50%',
                background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)',
                color: 'rgba(255,255,255,0.75)', fontSize: 13, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 20, lineHeight: 1, pointerEvents: 'all',
              }}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); useUndoCoordinator.getState().checkpoint(); ctx.deleteBar(id) }}
              title="Delete"
            >×</button>

            <div style={{ position: 'absolute', top: 8, left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'all' }}>
              <button style={overlayPill} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); useUndoCoordinator.getState().checkpoint(); addParentAbove(id) }}>Parent</button>
            </div>

            <div style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, pointerEvents: 'all' }}>
              <div style={smallHandle} onPointerDown={onLeftDown} title="Drag to resize left">›</div>
              <button style={smallPlus} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); useUndoCoordinator.getState().checkpoint(); addSiblingBar(id, 'before') }} title="Add node to the left">+</button>
            </div>

            <div style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, pointerEvents: 'all' }}>
              <button style={smallPlus} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); useUndoCoordinator.getState().checkpoint(); addSiblingBar(id, 'after') }} title="Add node to the right">+</button>
              <div style={smallHandle} onPointerDown={onRightDown} title="Drag to resize right">‹</div>
            </div>

            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
              <button
                style={{ ...smallPlus, width: 28, height: 28, fontSize: 18, background: 'rgba(0,0,0,0.22)', pointerEvents: 'all' }}
                onPointerDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); mediaInputRef.current?.click() }}
                title="Add media"
              >+</button>
            </div>

            <div style={{ position: 'absolute', bottom: 8, left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'all' }}>
              <button style={overlayPill} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); useUndoCoordinator.getState().checkpoint(); addChildToBar(id) }}>Child</button>
            </div>

          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x} y={contextMenu.y} barId={id}
          onClose={() => setContextMenu(null)}
          onStartRename={startRename}
          onOpenColorPicker={handleColorPickerOpen}
          onEditImage={getFirstImageUrl(bar.content) ? () => setIsEditingImage(true) : undefined}
        />
      )}
      {isEditingImage && getFirstImageUrl(bar.content) && (() => {
        const blockEl = wrapperRef.current
        const r = blockEl?.getBoundingClientRect()
        if (!r) return null
        return (
          <HeroImageEditOverlay
            cardRect={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            heroImage={getFirstImageUrl(bar.content)!}
            initialTransform={bar.content.imageTransform ?? { scale: 1, offsetX: 0, offsetY: 0, flipH: false, flipV: false }}
            onDone={t => {
              useUndoCoordinator.getState().checkpoint()
              setContent(id, { imageTransform: t })
              setIsEditingImage(false)
            }}
            onCancel={() => setIsEditingImage(false)}
          />
        )
      })()}
      {showColorPicker && (
        <CircularColorPicker
          color={bar.color}
          anchorX={colorPickerPos.x} anchorY={colorPickerPos.y}
          onChange={c => {
            const targets = isSelected && selectedIds.length > 1 ? selectedIds : [id]
            targets.forEach(tid => setColor(tid, c))
          }}
          onClose={() => setShowColorPicker(false)}
        />
      )}
      {showTextToolbar && (bar.content.text || bar.content.headerText || isEditingText) && (
        <TextFormatToolbar
          headerStyle={bar.content.headerTextStyle as any}
          bodyStyle={bar.content.textStyle as any}
          onHeaderStyleChange={style => useBoardsStore.getState().setContent(ctx.boardId, id, { headerTextStyle: style as any })}
          onBodyStyleChange={style => useBoardsStore.getState().setContent(ctx.boardId, id, { textStyle: style as any })}
          activeField={activeTextField}
          onActiveFieldChange={f => { setActiveTextField(f); if (isEditingText) setEditingTextField(f) }}
          anchorRect={wrapperRef.current?.getBoundingClientRect() ?? null}
          onClose={() => {
            // Empty-canvas click = fully exit text editing, not just the toolbar
            setShowTextToolbar(false)
            setIsEditingText(false)
            setEditingTextField(null)
          }}
          heroImage={getFirstImageUrl(bar.content)}
          heroFlipH={bar.content.imageTransform?.flipH}
          heroFlipV={bar.content.imageTransform?.flipV}
          heroOpacity={bar.content.imageTransform?.opacity}
          onFlipH={() => {
            useUndoCoordinator.getState().checkpoint()
            const cur = bar.content.imageTransform ?? { scale: 1, offsetX: 0, offsetY: 0, flipH: false, flipV: false }
            setContent(id, { imageTransform: { ...cur, flipH: !cur.flipH } })
          }}
          onFlipV={() => {
            useUndoCoordinator.getState().checkpoint()
            const cur = bar.content.imageTransform ?? { scale: 1, offsetX: 0, offsetY: 0, flipH: false, flipV: false }
            setContent(id, { imageTransform: { ...cur, flipV: !cur.flipV } })
          }}
          onHeroOpacityChange={opacity => {
            const cur = bar.content.imageTransform ?? { scale: 1, offsetX: 0, offsetY: 0, flipH: false, flipV: false }
            setContent(id, { imageTransform: { ...cur, opacity } })
          }}
          onCropImage={() => setIsEditingImage(true)}
        />
      )}
      {colorDragging && createPortal(
        <div style={{ position: 'fixed', left: 0, top: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 99999 }}>
          {/* Floating color circle at cursor */}
          <div style={{
            position: 'absolute',
            left: colorDragPos.x - 14,
            top: colorDragPos.y - 14,
            width: 28, height: 28,
            borderRadius: '50%',
            background: bg,
            border: '2.5px solid rgba(255,255,255,0.7)',
            boxShadow: `0 0 12px ${bg}, 0 4px 16px rgba(0,0,0,0.5)`,
            transition: 'none',
          }} />
          {/* Line from source dot to cursor */}
          <svg style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', overflow: 'visible' }}>
            <line
              x1={colorDragStart.current.x} y1={colorDragStart.current.y}
              x2={colorDragPos.x} y2={colorDragPos.y}
              stroke={bg} strokeWidth={2} strokeDasharray="6 4" opacity={0.5}
            />
          </svg>
        </div>,
        document.body
      )}
    </>
  )
})

