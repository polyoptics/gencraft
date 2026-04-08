// v3 — uses BoardContext
import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useCanvasStore } from '../../store/canvasStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useBoardCtx } from '../../contexts/BoardContext'
import { ContextMenu } from '../Bar/ContextMenu'
import { CircularColorPicker } from '../Bar/CircularColorPicker'
import { ColorHoverWheel } from '../Bar/ColorHoverWheel'
// transferBar removed — reparenting is done via port wires, not cross-board drag
import { gripDragState } from '../../utils/gripDragState'
import { wireDragState } from '../../utils/wireDragState'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { uploadFile } from '../../utils/uploadFile'
import { getFirstImageUrl, getMediaItems, DEFAULT_BAR_TEXT_STYLE } from '../../types/bar'
import type { BarTextStyle } from '../../types/bar'

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

export const NLEBlock: React.FC<Props> = ({ id, top, blockHeight, offsetX, rowTops, rowHeights }) => {
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
    useUndoCoordinator.getState().checkpoint()
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
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) dragHasMoved.current = true
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
          // Double-click on name pill → rename; anywhere else in body → edit text
          const onPill = (e.target as HTMLElement).closest('[data-name-pill]')
          if (onPill) {
            startRename()
          } else {
            e.stopPropagation()
            setShowTextToolbar(true)
            setIsEditingText(true)
          }
        }}
        onDragOver={e => e.preventDefault()}
      >
        {/* ── Background layer ── */}
        <div style={{
          position: 'absolute', inset: 0, borderRadius: 12, background: bg, overflow: 'hidden',
          boxShadow: isDraggingReorder
            ? '0 0 0 2px rgba(255,210,80,0.9), 0 20px 50px rgba(0,0,0,0.7)'
            : isSelected
            ? '0 0 0 2.5px rgba(120,180,255,0.9), 0 8px 32px rgba(0,0,0,0.5)'
            : isHovered
            ? '0 8px 32px rgba(0,0,0,0.5), 0 0 0 2px rgba(255,255,255,0.25)'
            : '0 2px 10px rgba(0,0,0,0.4), 0 0 0 1px rgba(0,0,0,0.25)',
          transition: 'box-shadow 0.12s ease',
        }}>
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(160deg, rgba(255,255,255,0.10) 0%, rgba(0,0,0,0.10) 100%)' }} />
          {getFirstImageUrl(bar.content) && (
            <div style={{
              position: 'absolute', inset: 0,
              backgroundImage: `url(${getFirstImageUrl(bar.content)})`,
              backgroundSize: 'cover', backgroundPosition: 'center',
              opacity: 0.82,
            }} />
          )}
          {(bar.content.text || isEditingText) && (() => {
            const bts = { ...DEFAULT_BAR_TEXT_STYLE, ...bar.content.textStyle }
            const bgRgba = `rgba(${parseInt(bts.bgColor.slice(1,3),16)},${parseInt(bts.bgColor.slice(3,5),16)},${parseInt(bts.bgColor.slice(5,7),16)},${bts.bgOpacity})`
            const hasImage = !!getFirstImageUrl(bar.content)
            const effectiveBg = bts.bgOpacity > 0 ? bgRgba : hasImage ? 'rgba(0,0,0,0.45)' : 'none'
            const baseStyle: React.CSSProperties = {
              position: 'absolute',
              top: compact ? 20 : medium ? 28 : 34,
              left: 0, right: 0, bottom: 0,
              padding: compact ? '2px 6px' : '6px 10px',
              background: effectiveBg,
              color: bts.color,
              fontSize: bts.fontSize,
              lineHeight: 1.4,
              fontWeight: bts.bold ? 700 : 400,
              fontStyle: bts.italic ? 'italic' : 'normal',
              textAlign: bts.align,
              overflow: 'hidden',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              backdropFilter: hasImage && bts.bgOpacity === 0 ? 'blur(4px)' : 'none',
            }
            if (isEditingText) {
              return (
                <textarea
                  ref={textEditRef}
                  data-text-overlay
                  autoFocus
                  value={bar.content.text}
                  onChange={e => setContent(id, { text: e.target.value })}
                  onPointerDown={e => e.stopPropagation()}
                  onBlur={(e) => {
                    // Don't close if clicking the format toolbar
                    const related = e.relatedTarget as HTMLElement | null
                    if (related?.closest('[data-bar-text-toolbar]')) return
                    setIsEditingText(false); setShowTextToolbar(false)
                  }}
                  onKeyDown={e => { if (e.key === 'Escape') { setIsEditingText(false); setShowTextToolbar(false) } }}
                  placeholder="Type text…"
                  style={{
                    ...baseStyle,
                    border: '1px solid rgba(120,180,255,0.4)',
                    outline: 'none',
                    resize: 'none',
                    fontFamily: 'inherit',
                    cursor: 'text',
                    zIndex: 6,
                  }}
                />
              )
            }
            return (
              <div
                data-text-overlay
                style={{
                  ...baseStyle,
                  display: 'flex', flexDirection: 'column',
                  justifyContent: bts.vAlign === 'middle' ? 'center' : bts.vAlign === 'bottom' ? 'flex-end' : 'flex-start',
                  cursor: 'pointer',
                  zIndex: 4,
                }}
                onDoubleClick={e => {
                  e.stopPropagation()
                  setShowTextToolbar(true)
                  setIsEditingText(true)
                }}
              >
                <div>{bar.content.text}</div>
              </div>
            )
          })()}
        </div>

        {/* ── Icon + name pill ── */}
        <div
          data-name-pill
          style={{
            position: 'absolute', top: 0, left: 0,
            display: 'flex', alignItems: 'center',
            background: 'rgba(0,0,0,0.35)',
            backdropFilter: 'blur(8px)',
            borderRadius: '12px 0 12px 0',
            padding: compact ? '3px 8px' : medium ? '3px 9px 3px 3px' : '3px 10px 3px 3px',
            gap: compact ? 0 : 6,
            maxWidth: 'calc(100% - 36px)',
            zIndex: 5, cursor: 'default',
          }}
          onPointerDown={e => e.stopPropagation()}
        >
          {iconSz > 0 && (
            <div
              ref={colorDotRef}
              style={{
                position: 'relative',
                width: iconSz + 4, height: iconSz + 4,
                flexShrink: 0,
              }}
            >
              <div style={{
                position: 'absolute', left: 2, top: 2,
                width: iconSz, height: iconSz, borderRadius: '50%',
                background: bar.icon ? 'none' : bg,
                border: `1.5px solid rgba(255,255,255,${colorDragging ? '0.6' : '0.25'})`,
                boxShadow: colorDragging ? `0 0 8px ${bg}` : 'none',
                transition: 'border-color 0.1s, box-shadow 0.1s',
                pointerEvents: 'none',
                overflow: 'hidden',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {bar.icon
                  ? <img src={bar.icon} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : null
                }
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
            {isRenaming ? (
              <input ref={nameRef} value={renameVal}
                onChange={e => setRenameVal(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setIsRenaming(false) }}
                onClick={e => e.stopPropagation()}
                style={{
                  background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.3)',
                  borderRadius: 4, outline: 'none', color: '#fff',
                  fontSize: compact ? 10 : 12, fontWeight: 700, padding: '1px 5px',
                  fontFamily: 'inherit', width: 80,
                }}
              />
            ) : (
              <span
                style={{
                  color: '#fff', fontSize: (compact ? 10 : 12) / Math.max(zoom, 0.5), fontWeight: 700,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  textShadow: '0 1px 3px rgba(0,0,0,0.5)', cursor: 'text',
                }}
                onDoubleClick={e => { e.stopPropagation(); startRename() }}
              >{bar.name}</span>
            )}

            {!compact && !medium && (
              isRenamingSubtitle ? (
                <input ref={subtitleRef} value={subtitleVal}
                  onChange={e => setSubtitleVal(e.target.value)}
                  onBlur={commitSubtitle}
                  onKeyDown={e => { if (e.key === 'Enter') commitSubtitle(); if (e.key === 'Escape') setIsRenamingSubtitle(false) }}
                  onClick={e => e.stopPropagation()}
                  placeholder="subtitle…"
                  style={{
                    background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.2)',
                    borderRadius: 4, outline: 'none', color: 'rgba(255,255,255,0.75)',
                    fontSize: 10, padding: '1px 5px',
                    fontFamily: 'inherit', width: 90, fontStyle: 'italic',
                  }}
                />
              ) : (
                <span
                  style={{
                    color: 'rgba(255,255,255,0.55)', fontSize: 10, fontStyle: 'italic',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text',
                  }}
                  onDoubleClick={e => { e.stopPropagation(); setSubtitleVal(bar.subtitle ?? ''); setIsRenamingSubtitle(true) }}
                >{bar.subtitle || <span style={{ opacity: 0.4 }}>subtitle…</span>}</span>
              )
            )}
          </div>
        </div>

        {/* ── Color dot hit zone (outside pill stacking context) ── */}
        {iconSz > 0 && (() => {
          const dotR = iconSz / 2
          const wheelGap = 4
          const wheelVarSz = Math.max(8, iconSz * 0.45)
          const wheelOffset = dotR + wheelGap + wheelVarSz / 2
          const expandedSize = (wheelOffset + wheelVarSz / 2) * 2 + 4
          const expandShift = (expandedSize - (iconSz + 4)) / 2
          const isExpanded = showHoverWheel && !colorDragging && !showColorPicker
          return (
            <div
              style={{
                position: 'absolute',
                left: isExpanded ? 3 - expandShift : 3,
                top: isExpanded ? 3 - expandShift : 3,
                width: isExpanded ? expandedSize : iconSz + 4,
                height: isExpanded ? expandedSize : iconSz + 4,
                zIndex: 25,
                cursor: colorDragging ? 'grabbing' : 'grab',
                borderRadius: isExpanded ? 0 : '50%',
              }}
              onPointerDown={onColorDotDown}
              onClick={onColorDotClick}
              onMouseEnter={() => {
                if (colorDragging) return
                hoverTimer.current = setTimeout(() => setShowHoverWheel(true), 250)
              }}
              onMouseLeave={() => {
                if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
                setTimeout(() => setShowHoverWheel(false), 300)
              }}
              title="Click to pick color · Drag to paint another bar"
            >
              {isExpanded && (
                <div style={{ position: 'absolute', left: expandShift, top: expandShift, width: iconSz + 4, height: iconSz + 4 }}>
                  <ColorHoverWheel
                    color={bar.color}
                    size={iconSz}
                    onSelect={c => {
                      useUndoCoordinator.getState().checkpoint()
                      const targets = isSelected && selectedIds.length > 1 ? selectedIds : [id]
                      targets.forEach(tid => setColor(tid, c))
                      setShowHoverWheel(false)
                    }}
                  />
                </div>
              )}
            </div>
          )
        })()}

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
              <button style={smallPlus} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); useUndoCoordinator.getState().checkpoint(); addSiblingBar(id, 'before') }} title="Add block to the left">+</button>
            </div>

            <div style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, pointerEvents: 'all' }}>
              <button style={smallPlus} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); useUndoCoordinator.getState().checkpoint(); addSiblingBar(id, 'after') }} title="Add block to the right">+</button>
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
        />
      )}
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
      {showTextToolbar && bar.content.text && createPortal(
        <BarTextFormatToolbar
          barId={id}
          boardId={ctx.boardId}
          content={bar.content}
          wrapperRef={wrapperRef}
          onClose={() => setShowTextToolbar(false)}
        />,
        document.body
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
}

// ── Bar Text Format Toolbar ──

const FONT_SIZES = [8, 10, 12, 14, 18, 24, 32, 48, 64, 96]
const PRESET_COLORS = ['#ffffff', '#e2e8f0', '#fbbf24', '#f87171', '#34d399', '#60a5fa', '#a78bfa', '#fb923c']

function hexToRgba(hex: string, opacity: number): string {
  const n = parseInt(hex.replace('#', ''), 16)
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff
  return `rgba(${r},${g},${b},${opacity})`
}

const hAlignIcons: Record<string, React.ReactNode> = {
  left: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 2h12M1 5h8M1 8h10M1 11h6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
  center: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 2h12M3 5h8M2 8h10M4 11h6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
  right: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 2h12M5 5h8M3 8h10M7 11h6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
}
const vAlignIcons: Record<string, React.ReactNode> = {
  top: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 1h12M4 4h6M3 7h8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
  middle: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M4 3h6M3 7h8M4 11h6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
  bottom: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7h8M4 10h6M1 13h12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
}

const BarTextFormatToolbar: React.FC<{
  barId: string
  boardId: string
  content: import('../../types/bar').BarContent
  wrapperRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
}> = ({ barId, boardId, content, wrapperRef, onClose }) => {
  const setContent = useBoardsStore(s => s.setContent)
  const [showPopup, setShowPopup] = useState<'text' | 'bg' | 'hAlign' | 'vAlign' | null>(null)

  const ts: BarTextStyle = { ...DEFAULT_BAR_TEXT_STYLE, ...content.textStyle }
  const setStyle = (patch: Partial<BarTextStyle>) => {
    setContent(boardId, barId, { textStyle: { ...ts, ...patch } })
  }

  const rect = wrapperRef.current?.getBoundingClientRect()
  if (!rect) return null

  const btnStyle = (active?: boolean): React.CSSProperties => ({
    background: active ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)',
    border: active ? '1px solid rgba(255,255,255,0.3)' : '1px solid rgba(255,255,255,0.08)',
    borderRadius: 5,
    color: active ? '#fff' : 'rgba(255,255,255,0.6)',
    fontSize: 12, fontWeight: active ? 700 : 500,
    padding: '2px 7px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 24, height: 26,
    transition: 'all 0.1s',
  })

  const sepStyle: React.CSSProperties = {
    width: 1, height: 18, background: 'rgba(255,255,255,0.08)', margin: '0 3px', flexShrink: 0,
  }

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={onClose} />
      <div
        data-bar-text-toolbar
        tabIndex={-1}
        onPointerDown={e => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: Math.max(4, Math.min(rect.left, window.innerWidth - 380)),
          top: Math.max(4, rect.top - 40),
          zIndex: 10000,
          display: 'flex', alignItems: 'center', gap: 3,
          background: '#1a1b2e',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 8, padding: '4px 6px',
          boxShadow: '0 8px 30px rgba(0,0,0,0.7)',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {/* Font size */}
        <button style={btnStyle()} onClick={() => {
          const prev = FONT_SIZES.filter(s => s < ts.fontSize).pop() ?? FONT_SIZES[0]
          setStyle({ fontSize: prev })
        }}>−</button>
        <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, minWidth: 22, textAlign: 'center', userSelect: 'none' }}>{ts.fontSize}</span>
        <button style={btnStyle()} onClick={() => {
          const next = FONT_SIZES.find(s => s > ts.fontSize) ?? FONT_SIZES[FONT_SIZES.length - 1]
          setStyle({ fontSize: next })
        }}>+</button>

        <div style={sepStyle} />

        {/* Bold / Italic */}
        <button style={{ ...btnStyle(ts.bold), fontWeight: 800, fontSize: 13 }} onClick={() => setStyle({ bold: !ts.bold })}>B</button>
        <button style={{ ...btnStyle(ts.italic), fontStyle: 'italic', fontSize: 13 }} onClick={() => setStyle({ italic: !ts.italic })}>I</button>

        <div style={sepStyle} />

        {/* Horizontal alignment */}
        <div style={{ position: 'relative' }}>
          <button style={btnStyle(showPopup === 'hAlign')} onClick={() => setShowPopup(showPopup === 'hAlign' ? null : 'hAlign')}>
            {hAlignIcons[ts.align]}
          </button>
          {showPopup === 'hAlign' && (
            <div onPointerDown={e => e.stopPropagation()} style={{
              position: 'absolute', top: 32, left: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'flex', gap: 2,
            }}>
              {(['left', 'center', 'right'] as const).map(v => (
                <button key={v} title={v} onClick={() => { setStyle({ align: v }); setShowPopup(null) }} style={{
                  background: v === ts.align ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.03)',
                  border: v === ts.align ? '1px solid rgba(255,255,255,0.3)' : '1px solid rgba(255,255,255,0.06)',
                  borderRadius: 5, color: v === ts.align ? '#fff' : 'rgba(255,255,255,0.5)',
                  width: 28, height: 28, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                }}>{hAlignIcons[v]}</button>
              ))}
            </div>
          )}
        </div>

        {/* Vertical alignment */}
        <div style={{ position: 'relative' }}>
          <button style={btnStyle(showPopup === 'vAlign')} onClick={() => setShowPopup(showPopup === 'vAlign' ? null : 'vAlign')}>
            {vAlignIcons[ts.vAlign]}
          </button>
          {showPopup === 'vAlign' && (
            <div onPointerDown={e => e.stopPropagation()} style={{
              position: 'absolute', top: 32, left: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'flex', gap: 2,
            }}>
              {(['top', 'middle', 'bottom'] as const).map(v => (
                <button key={v} title={v} onClick={() => { setStyle({ vAlign: v }); setShowPopup(null) }} style={{
                  background: v === ts.vAlign ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.03)',
                  border: v === ts.vAlign ? '1px solid rgba(255,255,255,0.3)' : '1px solid rgba(255,255,255,0.06)',
                  borderRadius: 5, color: v === ts.vAlign ? '#fff' : 'rgba(255,255,255,0.5)',
                  width: 28, height: 28, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                }}>{vAlignIcons[v]}</button>
              ))}
            </div>
          )}
        </div>

        <div style={sepStyle} />

        {/* Text color */}
        <div style={{ position: 'relative' }}>
          <button style={{ ...btnStyle(showPopup === 'text'), gap: 4, padding: '2px 6px' }} onClick={() => setShowPopup(showPopup === 'text' ? null : 'text')}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>A</span>
            <div style={{ width: 14, height: 4, borderRadius: 1, background: ts.color, border: '1px solid rgba(255,255,255,0.15)' }} />
          </button>
          {showPopup === 'text' && (
            <div onPointerDown={e => e.stopPropagation()} style={{
              position: 'absolute', top: 32, left: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, width: 120,
            }}>
              {PRESET_COLORS.map(c => (
                <button key={c} onClick={() => { setStyle({ color: c }); setShowPopup(null) }} style={{
                  width: 24, height: 24, borderRadius: 5, background: c,
                  border: c === ts.color ? '2px solid #fff' : '1px solid rgba(255,255,255,0.15)',
                  cursor: 'pointer', padding: 0,
                }} />
              ))}
              <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <input type="color" value={ts.color} onChange={e => setStyle({ color: e.target.value })}
                  style={{ width: 24, height: 24, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>Custom</span>
              </label>
            </div>
          )}
        </div>

        {/* Background color + opacity */}
        <div style={{ position: 'relative' }}>
          <button style={{ ...btnStyle(showPopup === 'bg'), gap: 4, padding: '2px 6px' }} onClick={() => setShowPopup(showPopup === 'bg' ? null : 'bg')}>
            <div style={{
              width: 16, height: 14, borderRadius: 3,
              background: ts.bgOpacity > 0 ? hexToRgba(ts.bgColor, ts.bgOpacity) : 'linear-gradient(135deg, rgba(255,255,255,0.1) 45%, transparent 45%, transparent 55%, rgba(255,255,255,0.1) 55%)',
              border: '1px solid rgba(255,255,255,0.15)',
            }} />
          </button>
          {showPopup === 'bg' && (
            <div onPointerDown={e => e.stopPropagation()} style={{
              position: 'absolute', top: 32, right: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.6)', width: 150,
            }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>Background Color</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginBottom: 8 }}>
                {['#000000', '#1e1b4b', '#1e3a2f', '#3b1520', '#1e293b', '#2d1b0e', '#1a1a1a', '#0f172a'].map(c => (
                  <button key={c} onClick={() => setStyle({ bgColor: c })} style={{
                    width: 24, height: 24, borderRadius: 5, background: c,
                    border: c === ts.bgColor ? '2px solid #fff' : '1px solid rgba(255,255,255,0.15)',
                    cursor: 'pointer', padding: 0,
                  }} />
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                <input type="color" value={ts.bgColor} onChange={e => setStyle({ bgColor: e.target.value })}
                  style={{ width: 24, height: 24, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>Custom</span>
              </label>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 6, marginBottom: 4 }}>Opacity</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="range" min={0} max={1} step={0.05} value={ts.bgOpacity}
                  onChange={e => setStyle({ bgOpacity: parseFloat(e.target.value) })}
                  onPointerDown={e => e.stopPropagation()}
                  style={{ flex: 1, height: 4, accentColor: '#60a5fa', cursor: 'pointer' }} />
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', minWidth: 28, textAlign: 'right' }}>
                  {Math.round(ts.bgOpacity * 100)}%
                </span>
              </div>
              <div style={{ marginTop: 6, height: 20, borderRadius: 4, background: hexToRgba(ts.bgColor, ts.bgOpacity), border: '1px solid rgba(255,255,255,0.08)' }} />
            </div>
          )}
        </div>
      </div>
    </>
  )
}
