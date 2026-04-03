import React, { useRef, useState, useCallback, useMemo, useEffect } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { BoardProvider } from '../../contexts/BoardContext'
import type { BoardCtx } from '../../contexts/BoardContext'
import { ColorPickerPopup } from '../Bar/ColorPickerPopup'
import { NLELayout } from './NLELayout'
import { primarySlot, extraSlots, clampBoardX } from '../../utils/nlePush'
import type { BoardSlot } from '../../utils/nlePush'
import { useUndoCoordinator } from '../../store/undoCoordinator'

interface Props { boardId: string }

const BOARD_PADDING_X = 20
const BOARD_PADDING_TOP = 36
const BOARD_PADDING_BOT = 24
const HEADER_H = 44

export const Board: React.FC<Props> = ({ boardId }) => {
  const isPrimary = boardId === 'primary'

  const board        = useBoardsStore(s => s.boards[boardId])
  const setBoardNlePos    = useBoardsStore(s => s.setBoardNlePos)
  const setBoardColor     = useBoardsStore(s => s.setBoardColor)
  const setBoardProjectName = useBoardsStore(s => s.setBoardProjectName)
  const deleteBoard       = useBoardsStore(s => s.deleteBoard)
  const viewerBarId       = useBoardsStore(s => s.boards[boardId]?.viewerBarId ?? null)

  const boardPos        = useCanvasStore(s => s.boardPos)   // primary position
  const setBoardPos     = useCanvasStore(s => s.setBoardPos)
  const setFocusedBoard = useCanvasStore(s => s.setFocusedBoard)
  const zoom            = Math.max(useCanvasStore(s => s.zoom) || 1, 0.01)
  const nleRowHeight    = useCanvasStore(s => s.nleRowHeight)

  const clearFreeSelection = useFreeNodeStore(s => s.clearFreeSelection)

  const [renaming, setRenaming]               = useState(false)
  const [renameVal, setRenameVal]             = useState('')
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [colorPickerPos, setColorPickerPos]   = useState({ x: 0, y: 0 })
  const [contextMenu, setContextMenu]         = useState<{ x: number; y: number } | null>(null)
  const boardScale = useBoardsStore(s => s.boards[boardId]?.boardScale ?? 1)
  const [rubberBand, setRubberBand]           = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null)

  const wrapperRef    = useRef<HTMLDivElement>(null)
  const nameInputRef  = useRef<HTMLInputElement>(null)
  const rbRef         = useRef<{ sx: number; sy: number; ex: number; ey: number } | null>(null)
  const lastX         = useRef(0)
  const lastY         = useRef(0)
  const dragStartRow  = useRef(0)
  const totalDY       = useRef(0)
  const dragSlots     = useRef<BoardSlot[]>([])
  const gripLastX     = useRef(0)
  const gripLastY     = useRef(0)
  const gripStartRow  = useRef(0)
  const gripTotalDY   = useRef(0)
  const resizeLastY   = useRef(0)
  const headerDragMoved = useRef(false)
  const headerShift = useRef(false)

  useEffect(() => {
    if (renaming) nameInputRef.current?.select()
  }, [renaming])

  const getCurrentRow = useCallback(() => {
    if (isPrimary) {
      const cs = useCanvasStore.getState()
      return Math.max(0, Math.round(cs.boardPos.y / cs.nleRowHeight))
    }
    const b = useBoardsStore.getState().boards[boardId]
    return Math.max(0, Math.round(b?.nleRow ?? 0))
  }, [isPrimary, boardId])

  const setPosition = useCallback((row: number, x: number) => {
    if (isPrimary) {
      const rowH = useCanvasStore.getState().nleRowHeight
      setBoardPos({ x, y: row * rowH })
    } else {
      setBoardNlePos(boardId, row, x)
    }
  }, [isPrimary, boardId, setBoardPos, setBoardNlePos])

  // ── Clamped header drag ──
  const onHeaderDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return  // let middle bubble for canvas pan
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if ((e.target as Element).closest('[data-viewer-toggle],[data-grip],[data-name]')) return
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    setFocusedBoard(boardId)
    headerDragMoved.current = false
    headerShift.current = e.shiftKey
    dragStartRow.current = getCurrentRow()
    totalDY.current = 0
    lastX.current = e.clientX
    lastY.current = e.clientY
    const csState = useCanvasStore.getState()
    const bsState = useBoardsStore.getState()
    const pRow = Math.max(0, Math.round(csState.boardPos.y / csState.nleRowHeight))
    const primaryBars = bsState.boards['primary']?.bars ?? {}
    dragSlots.current = [
      primarySlot(csState.boardPos.x, pRow, primaryBars),
      ...extraSlots(bsState.boards),
    ]
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [getCurrentRow])

  const onHeaderMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const dx = (e.clientX - lastX.current) / zoom
    const dy = (e.clientY - lastY.current) / zoom
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) headerDragMoved.current = true
    lastX.current = e.clientX
    lastY.current = e.clientY
    totalDY.current += dy
    const rowH = useCanvasStore.getState().nleRowHeight
    const targetRow = Math.max(0, dragStartRow.current + Math.round(totalDY.current / rowH))
    if (isPrimary) {
      const rawX = useCanvasStore.getState().boardPos.x + dx
      const clampedX = clampBoardX(dragSlots.current, 'primary', rawX, targetRow)
      setBoardPos({ x: clampedX, y: targetRow * rowH })
    } else {
      const b = useBoardsStore.getState().boards[boardId]
      if (!b) return
      const rawX = b.nleX + dx
      const clampedX = clampBoardX(dragSlots.current, boardId, rawX, targetRow)
      setBoardNlePos(boardId, targetRow, clampedX)
    }
  }, [boardId, zoom, isPrimary, setBoardPos, setBoardNlePos])

  const onHeaderUp = useCallback(() => {
    if (!headerDragMoved.current) {
      // Click without drag → select all bars in this board
      const b = useBoardsStore.getState().boards[boardId]
      if (b) {
        const allBarIds = Object.keys(b.bars)
        if (!headerShift.current) {
          // Clear selections on all OTHER boards first
          const boards = useBoardsStore.getState().boards
          for (const bid of Object.keys(boards)) {
            if (bid !== boardId) useBoardsStore.getState().clearSelection(bid)
          }
          useFreeNodeStore.getState().clearFreeSelection()
        }
        useBoardsStore.getState().setSelection(boardId, allBarIds)
      }
    }
    totalDY.current = 0
    dragSlots.current = []
  }, [boardId])

  // ── Free grip drag (no clamp — passes through other boards) ──
  const onGripDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    setFocusedBoard(boardId)
    gripStartRow.current = getCurrentRow()
    gripTotalDY.current = 0
    gripLastX.current = e.clientX
    gripLastY.current = e.clientY
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [getCurrentRow])

  const onGripMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const dx = (e.clientX - gripLastX.current) / zoom
    const dy = (e.clientY - gripLastY.current) / zoom
    gripLastX.current = e.clientX
    gripLastY.current = e.clientY
    gripTotalDY.current += dy
    const rowH = useCanvasStore.getState().nleRowHeight
    const targetRow = Math.max(0, gripStartRow.current + Math.round(gripTotalDY.current / rowH))
    if (isPrimary) {
      const cs = useCanvasStore.getState()
      setBoardPos({ x: cs.boardPos.x + dx, y: targetRow * rowH })
    } else {
      const b = useBoardsStore.getState().boards[boardId]
      if (b) setBoardNlePos(boardId, targetRow, b.nleX + dx)
    }
  }, [boardId, zoom, isPrimary, setBoardPos, setBoardNlePos])

  const onGripUp = useCallback(() => { gripTotalDY.current = 0 }, [])

  // ── Scale resize (primary only) ──
  const onResizeDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    resizeLastY.current = e.clientY
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const dy = e.clientY - resizeLastY.current
    const current = useBoardsStore.getState().boards[boardId]?.boardScale ?? 1
    useBoardsStore.getState().setBoardScale(boardId, current + dy * 0.004)
    resizeLastY.current = e.clientY
  }, [boardId])

  const commitRename = useCallback(() => {
    if (renameVal.trim()) {
      useUndoCoordinator.getState().checkpoint()
      setBoardProjectName(boardId, renameVal.trim())
    }
    setRenaming(false)
  }, [boardId, renameVal, setBoardProjectName])

  const toggleViewer = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    if (viewerBarId) {
      useBoardsStore.getState().closeViewer(boardId)
    } else {
      const b = useBoardsStore.getState().boards[boardId]
      const firstId = b?.rootIds[0]
      if (firstId) useBoardsStore.getState().openViewer(boardId, firstId)
    }
  }, [boardId, viewerBarId])

  // ── Board-level rubber-band selection ──
  const onBoardDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return  // let middle/right bubble up for canvas pan & context menu
    e.stopPropagation()
    setFocusedBoard(boardId)
    const target = e.target as Element
    if (target.closest('[data-block]')) return
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (!rect) return
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    rbRef.current = { sx, sy, ex: sx, ey: sy }
    setRubberBand({ sx, sy, ex: sx, ey: sy })
    useBoardsStore.getState().clearSelection(boardId)
    clearFreeSelection()

    const onMove = (ev: PointerEvent) => {
      const r = wrapperRef.current?.getBoundingClientRect()
      if (!r) return
      const rb = { sx, sy, ex: ev.clientX - r.left, ey: ev.clientY - r.top }
      rbRef.current = rb
      setRubberBand({ ...rb })
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      rbRef.current = null
      setRubberBand(null)
      const r = wrapperRef.current?.getBoundingClientRect()
      if (!r) return
      const ex = ev.clientX - r.left
      const ey = ev.clientY - r.top
      const selLeft   = r.left + Math.min(sx, ex)
      const selRight  = r.left + Math.max(sx, ex)
      const selTop    = r.top  + Math.min(sy, ey)
      const selBottom = r.top  + Math.max(sy, ey)
      if (selRight - selLeft < 4 && selBottom - selTop < 4) return
      const hits = (el: Element) => {
        const er = el.getBoundingClientRect()
        return er.left < selRight && er.right > selLeft && er.top < selBottom && er.bottom > selTop
      }
      const ids = Array.from(document.querySelectorAll(`[data-block][data-board-id="${boardId}"]`))
        .filter(hits).map(el => (el as HTMLElement).dataset.id!)
      if (ids.length > 0) useBoardsStore.getState().setSelection(boardId, ids)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [boardId, clearFreeSelection])

  // ── BoardCtx ──
  const boardCtx = useMemo<BoardCtx | null>(() => {
    if (!board) return null
    const { bars, rootIds, selectedIds, viewerBarId, projectName } = board
    return {
      boardId,
      bars,
      rootIds,
      selectedIds,
      viewerBarId,
      projectName,
      addChildToBar:   id          => useBoardsStore.getState().addChildToBar(boardId, id),
      addSiblingBar:   (id, pos)   => useBoardsStore.getState().addSiblingBar(boardId, id, pos),
      addParentAbove:  id          => useBoardsStore.getState().addParentAbove(boardId, id),
      moveBar:         (id, dx)    => useBoardsStore.getState().moveBar(boardId, id, dx),
      moveMultiple:    (ids, dx)   => useBoardsStore.getState().moveMultiple(boardId, ids, dx),
      resizeBarEdge:   (id, e, d)  => useBoardsStore.getState().resizeBarEdge(boardId, id, e, d),
      setBarHeight:    (id, h)     => useBoardsStore.getState().setBarHeight(boardId, id, h),
      renameBar:       (id, name)  => useBoardsStore.getState().renameBar(boardId, id, name),
      setSubtitle:     (id, sub)   => useBoardsStore.getState().setSubtitle(boardId, id, sub),
      setIcon:         (id, icon)  => useBoardsStore.getState().setIcon(boardId, id, icon),
      setColor:        (id, c)     => useBoardsStore.getState().setBarColor(boardId, id, c),
      deleteBar:       id          => useBoardsStore.getState().deleteBar(boardId, id),
      deleteSubtree:   id          => useBoardsStore.getState().deleteSubtree(boardId, id),
      toggleCollapsed: id          => useBoardsStore.getState().toggleCollapsed(boardId, id),
      reorderSiblings: id          => useBoardsStore.getState().reorderSiblings(boardId, id),
      changeBarRow:    (id, row, det) => useBoardsStore.getState().changeBarRow(boardId, id, row, det),
      reparentBar:     (id, pid)   => useBoardsStore.getState().reparentBar(boardId, id, pid),
      setContent:      (id, p)     => useBoardsStore.getState().setContent(boardId, id, p),
      openViewer:      id          => useBoardsStore.getState().openViewer(boardId, id),
      closeViewer:     ()          => useBoardsStore.getState().closeViewer(boardId),
      setSelection:    ids         => useBoardsStore.getState().setSelection(boardId, ids),
      toggleSelection: id          => useBoardsStore.getState().toggleSelection(boardId, id),
      clearSelection:  ()          => useBoardsStore.getState().clearSelection(boardId),
      collapseAllToggle: ()        => useBoardsStore.getState().collapseAllToggle(boardId),
      getSelectedIds:  ()          => useBoardsStore.getState().boards[boardId]?.selectedIds ?? [],
      getBars:         ()          => useBoardsStore.getState().boards[boardId]?.bars ?? {},
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, board?.bars, board?.rootIds, board?.selectedIds, board?.viewerBarId, board?.projectName])

  if (!board || !boardCtx) return null

  const canvasX = isPrimary ? boardPos.x : board.nleX
  const canvasY = isPrimary ? boardPos.y : board.nleRow * nleRowHeight

  const topRow = Object.values(board.bars).filter(b => b.rowIndex === 0)
  const minX = topRow.length > 0 ? Math.min(...topRow.map(b => b.x)) : 0
  const maxX = topRow.length > 0 ? Math.max(...topRow.map(b => b.x + b.width)) : 480
  const projectName = board.projectName

  return (
    <>
      <div
        ref={wrapperRef}
        data-board="true"
        style={{ position: 'absolute', left: canvasX, top: canvasY, userSelect: 'none' }}
        onPointerDown={onBoardDown}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY }) }}
      >
        {/* ── Header ── */}
        <div
          style={{
            position: 'absolute', top: 0,
            left: BOARD_PADDING_X + minX,
            width: maxX - minX,
            height: HEADER_H,
            boxSizing: 'border-box',
            display: 'flex', alignItems: 'center', gap: 8, padding: `0 ${12 / zoom}px`,
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8, backdropFilter: 'blur(12px)',
            cursor: 'grab', zIndex: 30,
          }}
          onPointerDown={onHeaderDown}
          onPointerMove={onHeaderMove}
          onPointerUp={onHeaderUp}
        >
          {renaming ? (
            <input
              ref={nameInputRef}
              autoFocus
              value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onBlur={commitRename}
              onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false) }}
              onPointerDown={e => e.stopPropagation()}
              style={{
                background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: 4, color: '#fff', fontSize: 11, fontWeight: 700,
                padding: '1px 6px', outline: 'none', fontFamily: 'inherit', width: 140,
              }}
            />
          ) : (
            <span
              data-name="true"
              style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11 / zoom, fontWeight: 700, letterSpacing: '0.3px', cursor: 'text', whiteSpace: 'nowrap' }}
              onDoubleClick={e => { e.stopPropagation(); setRenameVal(projectName); setRenaming(true) }}
            >{projectName}</span>
          )}

          <div style={{ flex: 1 }} />

          {/* Viewer toggle */}
          <div
            data-viewer-toggle="true"
            onPointerDown={toggleViewer}
            style={{
              padding: `${2 / zoom}px ${9 / zoom}px`, borderRadius: 6,
              background: viewerBarId ? 'rgba(37,99,235,0.22)' : 'rgba(255,255,255,0.06)',
              border: viewerBarId ? '1px solid rgba(37,99,235,0.45)' : '1px solid rgba(255,255,255,0.08)',
              color: viewerBarId ? 'rgba(130,180,255,0.9)' : 'rgba(255,255,255,0.35)',
              fontSize: 10 / zoom, fontWeight: 700, letterSpacing: '0.3px',
              cursor: 'pointer', userSelect: 'none', flexShrink: 0,
            }}
          >
            {viewerBarId ? '▼ viewer' : '▲ viewer'}
          </div>

          <BlockCount boardId={boardId} zoom={zoom} />

          {/* Grip — free drag, bypasses clamp */}
          <div
            data-grip="true"
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            title="Free drag — pass through other boards"
            style={{ cursor: 'grab', flexShrink: 0, padding: '4px 8px', marginRight: -4 }}
          >
            <svg width="14" height="16" viewBox="0 0 14 16" style={{ opacity: 0.35, display: 'block' }}>
              {[0, 5, 10].map(cx => [0, 5, 10].map(cy => (
                <circle key={`${cx}-${cy}`} cx={cx + 2} cy={cy + 2} r="1.4" fill="white" />
              )))}
            </svg>
          </div>
        </div>

        {/* ── NLE content ── */}
        <div style={{
          paddingTop: HEADER_H + BOARD_PADDING_TOP,
          paddingBottom: BOARD_PADDING_BOT,
          paddingLeft: BOARD_PADDING_X,
          paddingRight: BOARD_PADDING_X,
          position: 'relative',
        }}>
          <div style={{ zoom: boardScale }}>
            <BoardProvider value={boardCtx}>
              <NLELayout />
            </BoardProvider>
          </div>

          <div
            style={{
              position: 'absolute', bottom: 0, left: '50%',
              transform: 'translateX(-50%)',
              width: 60, height: 16, cursor: 'ns-resize',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            title="Drag to scale"
          >
            <div style={{ width: 36, height: 3, background: 'rgba(255,255,255,0.14)', borderRadius: 2 }} />
          </div>
        </div>

        {/* ── Rubber-band overlay (screen coords → CSS canvas coords via /zoom) ── */}
        {rubberBand && (
          <div style={{
            position: 'absolute',
            left:   Math.min(rubberBand.sx, rubberBand.ex) / zoom,
            top:    Math.min(rubberBand.sy, rubberBand.ey) / zoom,
            width:  Math.abs(rubberBand.ex - rubberBand.sx) / zoom,
            height: Math.abs(rubberBand.ey - rubberBand.sy) / zoom,
            border: '1.5px solid rgba(120,170,255,0.8)',
            background: 'rgba(100,150,255,0.08)',
            borderRadius: 3, pointerEvents: 'none', zIndex: 100,
          }} />
        )}
      </div>

      {/* ── Extra board context menu ── */}
      {contextMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 900 }} onPointerDown={() => setContextMenu(null)} />
          <div style={{
            position: 'fixed', left: contextMenu.x, top: contextMenu.y,
            zIndex: 901, background: '#13141f',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8, padding: '4px 0',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)', minWidth: 150,
          }}>
            {([
              { label: 'Rename', action: () => { setRenameVal(projectName); setRenaming(true); setContextMenu(null) } },
              { label: 'Set color…', action: () => {
                useUndoCoordinator.getState().checkpoint()
                const r = wrapperRef.current?.getBoundingClientRect()
                setColorPickerPos({ x: r?.left ?? 0, y: (r?.top ?? 0) + 40 })
                setShowColorPicker(true); setContextMenu(null)
              }},
              { label: 'Duplicate board', action: () => { useUndoCoordinator.getState().checkpoint(); useBoardsStore.getState().duplicateBoard(boardId); setContextMenu(null) } },
              ...(!isPrimary ? [
                null as null,
                { label: 'Delete board', action: () => { useUndoCoordinator.getState().checkpoint(); deleteBoard(boardId); setContextMenu(null) }, danger: true },
              ] : []),
            ] as const).map((item, idx) => item === null ? (
              <div key={idx} style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '3px 10px' }} />
            ) : (
              <div
                key={(item as { label: string }).label}
                onPointerDown={e => { e.stopPropagation(); (item as { action: () => void }).action() }}
                style={{
                  padding: '7px 14px', fontSize: 12,
                  color: (item as { danger?: boolean }).danger ? 'rgba(255,100,100,0.85)' : 'rgba(255,255,255,0.8)',
                  cursor: 'pointer', borderRadius: 4, margin: '0 4px',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}
              >{(item as { label: string }).label}</div>
            ))}
          </div>
        </>
      )}

      {showColorPicker && board && (
        <ColorPickerPopup
          color={board.color}
          anchorX={colorPickerPos.x}
          anchorY={colorPickerPos.y}
          onChange={c => setBoardColor(boardId, c)}
          onClose={() => setShowColorPicker(false)}
        />
      )}
    </>
  )
}

const BlockCount: React.FC<{ boardId: string; zoom: number }> = ({ boardId, zoom }) => {
  const count = useBoardsStore(s => Object.keys(s.boards[boardId]?.bars ?? {}).length)
  return (
    <span style={{
      fontSize: 10 / zoom, color: 'rgba(255,255,255,0.18)', fontWeight: 600,
      background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.05)',
      borderRadius: 10, padding: `${2 / zoom}px ${7 / zoom}px`,
    }}>
      {count} block{count !== 1 ? 's' : ''}
    </span>
  )
}
