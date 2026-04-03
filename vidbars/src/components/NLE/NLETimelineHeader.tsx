import React, { useMemo, useState, useRef, useCallback } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useNLEViewerStore } from '../../store/nleViewerStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'

const BOARD_PADDING_X = 20
// Canvas-space height of the NLE header — scales with zoom so it stacks
// neatly on top of the board headers at any zoom level.
export const NLE_HEADER_CANVAS_H = 36
const GAP = 2   // canvas units between NLE header bottom and board header top

interface Segment {
  canvasLeft: number  // canvas units from header left edge
  canvasWidth: number
  color: string
  boardId: string | null
}

export const NLETimelineHeader: React.FC = () => {
  const pan          = useCanvasStore(s => s.pan)
  const zoom         = useCanvasStore(s => s.zoom)
  const boardPos     = useCanvasStore(s => s.boardPos)
  const nleRowHeight = useCanvasStore(s => s.nleRowHeight)
  const primaryBars  = useBoardsStore(s => s.boards['primary']?.bars ?? {})
  const primaryRoots = useBoardsStore(s => s.boards['primary']?.rootIds ?? [])
  const boardOrder   = useBoardsStore(s => s.boardOrder)
  const boards       = useBoardsStore(s => s.boards)

  const [headerName, setHeaderName] = useState('NLE Timeline')
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const viewerOpen = useNLEViewerStore(s => s.open)
  const toggleViewer = useNLEViewerStore(s => s.toggle)

  const onTimelineDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if ((e.target as Element).closest('[data-viewer-toggle]')) return
    e.stopPropagation()
    e.preventDefault()
    useUndoCoordinator.getState().checkpoint()
    let lastX = e.clientX
    let lastY = e.clientY
    let dyAccum = 0
    setIsDragging(true)

    const boardIds = useBoardsStore.getState().boardOrder.slice()
    const cs0 = useCanvasStore.getState()
    const initialPrimaryRow = Math.round(cs0.boardPos.y / cs0.nleRowHeight)
    const initialPrimaryX = cs0.boardPos.x
    let xAccum = 0

    // Capture initial positions for each extra board
    const initialRows: Record<string, number> = {}
    const initialXs: Record<string, number> = {}
    boardIds.forEach(bid => {
      const b = useBoardsStore.getState().boards[bid]
      if (b) { initialRows[bid] = b.nleRow; initialXs[bid] = b.nleX }
    })

    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      const dx = (ev.clientX - lastX) / z
      const dy = (ev.clientY - lastY) / z
      lastX = ev.clientX
      lastY = ev.clientY
      dyAccum += dy
      xAccum += dx

      const cs = useCanvasStore.getState()
      const rowDelta = Math.round(dyAccum / cs.nleRowHeight)

      // Snap primary board Y to row grid, smooth X
      const newPrimaryRow = Math.max(0, initialPrimaryRow + rowDelta)
      useCanvasStore.getState().setBoardPos({
        x: initialPrimaryX + xAccum,
        y: newPrimaryRow * cs.nleRowHeight,
      })

      // Move all extra boards: same row delta, same X delta
      boardIds.forEach(bid => {
        const newRow = Math.max(0, (initialRows[bid] ?? 0) + rowDelta)
        useBoardsStore.getState().setBoardNlePos(bid, newRow, (initialXs[bid] ?? 0) + xAccum)
      })
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setIsDragging(false)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const { segments, globalCanvasLeft, globalCanvasRight, headerCanvasY, groupCanvasBottom } = useMemo(() => {
    const segs: Segment[] = []

    const pRootBars = primaryRoots.map(id => primaryBars[id]).filter(Boolean)
    if (pRootBars.length > 0) {
      const minX = Math.min(...pRootBars.map(b => b.x))
      const maxX = Math.max(...pRootBars.map(b => b.x + b.width))
      segs.push({
        canvasLeft:  boardPos.x + BOARD_PADDING_X + minX,
        canvasWidth: maxX - minX,
        color: pRootBars[0]?.color ?? '#5b8dd9',
        boardId: null,
      })
    }

    boardOrder.forEach(id => {
      const board = boards[id]
      if (!board) return
      const rootBars = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
      if (rootBars.length === 0) return
      const minX = Math.min(...rootBars.map(b => b.x))
      const maxX = Math.max(...rootBars.map(b => b.x + b.width))
      segs.push({
        canvasLeft:  board.nleX + BOARD_PADDING_X + minX,
        canvasWidth: maxX - minX,
        color: board.color,
        boardId: id,
      })
    })

    if (segs.length === 0) return { segments: [], globalCanvasLeft: 0, globalCanvasRight: 200, headerCanvasY: -NLE_HEADER_CANVAS_H, groupCanvasBottom: 0 }

    const globalCanvasLeft  = Math.min(...segs.map(s => s.canvasLeft)) - 16
    const globalCanvasRight = Math.max(...segs.map(s => s.canvasLeft + s.canvasWidth)) + 16

    const topBoardY = Math.min(
      boardPos.y,
      ...boardOrder.map(id => (boards[id]?.nleRow ?? 0) * nleRowHeight),
    )
    // Sit directly above the board header with a tiny canvas gap
    const headerCanvasY = topBoardY - NLE_HEADER_CANVAS_H - GAP

    // Compute bottom extent of all boards for collapsed view
    const allBoardYs = [boardPos.y, ...boardOrder.map(id => (boards[id]?.nleRow ?? 0) * nleRowHeight)]
    const groupCanvasBottom = Math.max(...allBoardYs) + nleRowHeight

    const offsetSegs = segs.map(s => ({ ...s, canvasLeft: s.canvasLeft - globalCanvasLeft }))
    return { segments: offsetSegs, globalCanvasLeft, globalCanvasRight, headerCanvasY, groupCanvasBottom }
  }, [boardPos, primaryBars, primaryRoots, boardOrder, boards, nleRowHeight])

  // Find first image from any root bar for the collapsed card background
  const firstBarImage = useMemo(() => {
    for (const rid of primaryRoots) {
      const img = primaryBars[rid]?.content?.images?.[0]
      if (img) return img
    }
    for (const bid of boardOrder) {
      const b = boards[bid]
      if (!b) continue
      for (const rid of b.rootIds) {
        const img = b.bars[rid]?.content?.images?.[0]
        if (img) return img
      }
    }
    return null
  }, [primaryBars, primaryRoots, boardOrder, boards])

  if (segments.length === 0) return null

  const COLLAPSE_ZOOM = 0.15
  const collapsed = zoom <= COLLAPSE_ZOOM

  // Screen-space geometry
  const screenLeft   = pan.x + globalCanvasLeft * zoom
  const screenWidth  = (globalCanvasRight - globalCanvasLeft) * zoom

  const commitRename = () => {
    if (renameVal.trim()) setHeaderName(renameVal.trim())
    setRenaming(false)
  }

  // Forward wheel events to canvas zoom so scrolling over the header/card still zooms
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12
    // Walk up to the canvas container (the overflow:hidden div)
    let container = (e.currentTarget as HTMLElement).parentElement
    while (container && container.style.overflow !== 'hidden') container = container.parentElement
    const rect = container?.getBoundingClientRect()
    const mx = rect ? e.clientX - rect.left : e.clientX
    const my = rect ? e.clientY - rect.top : e.clientY
    useCanvasStore.getState().zoomAtPoint(f, mx, my)
  }, [])

  // ── Collapsed view: single card covering entire group ──
  if (collapsed) {
    const screenTop    = pan.y + headerCanvasY * zoom
    const screenBottom = pan.y + groupCanvasBottom * zoom
    const cardHeight   = Math.max(screenBottom - screenTop, 40)
    if (screenLeft + screenWidth < 0 || screenTop + cardHeight < 0) return null

    return (
      <div
        data-nle-card="primary"
        style={{
          position: 'absolute',
          left: screenLeft,
          top: screenTop,
          width: Math.max(screenWidth, 60),
          height: cardHeight,
          zIndex: 40,
          userSelect: 'none',
          pointerEvents: 'all',
          cursor: isDragging ? 'grabbing' : 'grab',
          borderRadius: 8,
          background: firstBarImage
            ? `linear-gradient(160deg, rgba(40,55,95,0.65) 0%, rgba(30,38,65,0.60) 100%), url(${firstBarImage}) center/cover`
            : 'linear-gradient(160deg, rgba(40,55,95,0.85) 0%, rgba(30,38,65,0.80) 100%)',
          touchAction: 'none',
          border: '1.5px solid rgba(255,255,255,0.12)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
        onPointerDown={onTimelineDown}
        onWheel={onWheel}
      >
        {/* Color strip at top */}
        <div style={{ display: 'flex', height: 6 }}>
          {segments.map((seg, i) => (
            <div key={seg.boardId ?? 'primary'} style={{
              flex: seg.canvasWidth,
              background: seg.color,
              opacity: 0.7,
            }} />
          ))}
        </div>
        {/* Name */}
        <div style={{
          padding: '6px 10px',
          color: 'rgba(255,255,255,0.9)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.3px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {headerName}
        </div>
        {/* Board count badge */}
        <div style={{
          position: 'absolute', bottom: 6, right: 8,
          color: 'rgba(255,255,255,0.4)',
          fontSize: 9,
          fontWeight: 600,
        }}>
          {segments.length} board{segments.length !== 1 ? 's' : ''}
        </div>
      </div>
    )
  }

  // ── Normal view: thin header bar ──
  const screenBottom = pan.y + (headerCanvasY + NLE_HEADER_CANVAS_H) * zoom
  const screenHeight = Math.max(NLE_HEADER_CANVAS_H * zoom, 28)
  const screenTop    = screenBottom - screenHeight

  // Only render when on screen
  if (screenLeft + screenWidth < 0 || screenTop + screenHeight < 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        left: screenLeft,
        top: screenTop,
        width: Math.max(screenWidth, 60),
        height: screenHeight,
        zIndex: 40,
        userSelect: 'none',
        pointerEvents: 'all',
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
      onPointerDown={onTimelineDown}
      onWheel={onWheel}
    >
      {/* Continuous bar */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(180deg, rgba(40,50,80,0.72) 0%, rgba(30,38,65,0.68) 100%)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: 7,
        backdropFilter: 'blur(12px)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
        overflow: 'hidden',
      }}>
        {/* Scanline */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.008) 0 1px, transparent 1px 60px)',
          pointerEvents: 'none',
        }} />
        {/* Top shine */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 1,
          background: 'rgba(255,255,255,0.08)', pointerEvents: 'none',
        }} />

        {/* Segment dividers — proportional to screen width */}
        {segments.map((seg, i) => i > 0 && (
          <div
            key={seg.boardId ?? 'primary'}
            style={{
              position: 'absolute',
              left: (seg.canvasLeft / (globalCanvasRight - globalCanvasLeft)) * 100 + '%',
              top: '20%', bottom: '20%',
              width: 1,
              background: 'rgba(255,255,255,0.10)',
            }}
          />
        ))}
      </div>

      {/* Name — left, double-click to rename */}
      <div style={{
        position: 'absolute', top: 0, bottom: 0, left: 0,
        display: 'flex', alignItems: 'center', paddingLeft: 12,
        zIndex: 2,
      }}>
        {renaming ? (
          <input
            ref={inputRef}
            autoFocus
            value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false) }}
            onPointerDown={e => e.stopPropagation()}
            style={{
              background: 'rgba(0,0,0,0.35)',
              border: '1px solid rgba(255,255,255,0.35)',
              borderRadius: 4,
              color: '#fff',
              fontSize: 12,
              fontWeight: 700,
              padding: '2px 8px',
              outline: 'none',
              fontFamily: 'inherit',
              width: 160,
            }}
          />
        ) : (
          <span
            onDoubleClick={e => { e.stopPropagation(); setRenameVal(headerName); setRenaming(true) }}
            style={{
              color: 'rgba(255,255,255,0.92)',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.2px',
              textShadow: '0 1px 4px rgba(0,0,0,0.6)',
              cursor: 'default',
              whiteSpace: 'nowrap',
            }}
          >{headerName}</span>
        )}
      </div>

      {/* Viewer toggle — right */}
      <div style={{
        position: 'absolute', top: 0, bottom: 0, right: 0,
        display: 'flex', alignItems: 'center', paddingRight: 10,
        zIndex: 2,
      }}>
        <div
          onPointerDown={e => { e.stopPropagation(); toggleViewer() }}
          style={{
            padding: '3px 10px',
            borderRadius: 5,
            background: viewerOpen ? 'rgba(37,99,235,0.32)' : 'rgba(0,0,0,0.30)',
            border: viewerOpen ? '1px solid rgba(37,99,235,0.55)' : '1px solid rgba(255,255,255,0.14)',
            color: viewerOpen ? 'rgba(130,180,255,0.95)' : 'rgba(255,255,255,0.55)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.4px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >{viewerOpen ? '▼ Viewer' : '▲ Viewer'}</div>
      </div>
    </div>
  )
}
