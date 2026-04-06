import React, { useMemo, useState, useRef, useCallback } from 'react'
import { useBoardsStore, getGroupForBoard } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useNLEViewerStore } from '../../store/nleViewerStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { groupSlot, clampGroupMove } from '../../utils/nlePush'
import type { GroupSlot } from '../../utils/nlePush'
import { computeRowLayout, getRowY, yToRow, getRowHeight, dyToRowDelta } from '../../utils/nleRows'

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

interface Props {
  /** When provided, header scopes to one group (card level).
   *  Without it, spans all boards (block/board level). */
  groupId?: string
}

export const NLETimelineHeader: React.FC<Props> = ({ groupId }) => {
  const pan          = useCanvasStore(s => s.pan)
  const zoom         = useCanvasStore(s => s.zoom)
  const boardPos     = useCanvasStore(s => s.boardPos)

  const primaryBars  = useBoardsStore(s => s.boards['primary']?.bars ?? {})
  const primaryRoots = useBoardsStore(s => s.boards['primary']?.rootIds ?? [])
  const boardOrder   = useBoardsStore(s => s.boardOrder)
  const boards       = useBoardsStore(s => s.boards)
  const groups       = useBoardsStore(s => s.groups)

  // Resolve which boards this header covers
  const scopedBoardIds = useMemo(() => {
    if (groupId) {
      const group = groups.find(g => g.id === groupId)
      return group?.boardIds ?? []
    }
    return ['primary', ...boardOrder]
  }, [groupId, groups, boardOrder])

  // Resolve the name for this header
  const group = groupId ? groups.find(g => g.id === groupId) : undefined
  const defaultName = group?.name ?? 'NLE Timeline'

  const [headerName, setHeaderName] = useState(defaultName)
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const effectiveGroupId = groupId ?? 'default-group'
  const viewerOpen = useNLEViewerStore(s => s.openGroupIds.has(effectiveGroupId))
  const toggleViewer = useCallback(() => useNLEViewerStore.getState().toggle(effectiveGroupId), [effectiveGroupId])

  // Keep headerName in sync if the group name changes externally
  const prevGroupName = useRef(defaultName)
  if (defaultName !== prevGroupName.current) {
    prevGroupName.current = defaultName
    setHeaderName(defaultName)
  }

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
    let xAccum = 0
    setIsDragging(true)

    // Determine which boards to drag
    const bIds = groupId
      ? (useBoardsStore.getState().groups.find(g => g.id === groupId)?.boardIds ?? [])
      : ['primary', ...useBoardsStore.getState().boardOrder]

    const cs0 = useCanvasStore.getState()
    const bs0 = useBoardsStore.getState()
    const layout0 = computeRowLayout(bs0.boards, 0)

    // Snapshot initial positions
    const initialRows: Record<string, number> = {}
    const initialXs: Record<string, number> = {}
    const initialPrimaryY = cs0.boardPos.y
    bIds.forEach(bid => {
      if (bid === 'primary') {
        initialRows[bid] = Math.max(0, yToRow(cs0.boardPos.y, layout0))
        initialXs[bid] = cs0.boardPos.x
      } else {
        const b = bs0.boards[bid]
        if (b) { initialRows[bid] = b.nleRow; initialXs[bid] = b.nleX }
      }
    })
    // Pick a reference board for computing a single uniform row delta
    const refBid = bIds.includes('primary') ? 'primary' : bIds[0]
    const refInitialRow = initialRows[refBid] ?? 0

    // Collision: snapshot group rects for clamping (only when scoped to a group)
    let initialRect: GroupSlot | null = null
    const obstacleRects: GroupSlot[] = []
    if (groupId) {
      initialRect = groupSlot(groupId, bIds, bs0.boards, cs0.boardPos, layout0)
      bs0.groups.forEach(g => {
        if (g.id === groupId) return
        const slot = groupSlot(g.id, g.boardIds, bs0.boards, cs0.boardPos, layout0)
        if (slot) obstacleRects.push(slot)
      })
    }

    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      const dx = (ev.clientX - lastX) / z
      const dy = (ev.clientY - lastY) / z
      lastX = ev.clientX
      lastY = ev.clientY
      dyAccum += dy
      xAccum += dx

      // Clamp against other groups when scoped
      let clampedX = xAccum
      let clampedY = dyAccum
      if (initialRect) {
        const clamped = clampGroupMove(initialRect, xAccum, dyAccum, obstacleRects)
        clampedX = clamped.dx
        clampedY = clamped.dy
      }

      // Soft-snap: find nearest row top and snap when within threshold
      const SNAP_THRESHOLD = 80 // canvas units
      const refInitialY = refBid === 'primary' ? initialPrimaryY : getRowY(refInitialRow, layout0)
      const refRawY = refInitialY + clampedY
      // Check current row and neighbor rows for closest row top
      const candidateRow = Math.max(0, yToRow(refRawY, layout0))
      let bestRow = candidateRow
      let bestDist = Math.abs(refRawY - getRowY(candidateRow, layout0))
      for (const r of [candidateRow - 1, candidateRow + 1]) {
        if (r < 0) continue
        const d = Math.abs(refRawY - getRowY(r, layout0))
        if (d < bestDist) { bestDist = d; bestRow = r }
      }
      const snapped = bestDist < SNAP_THRESHOLD
      const rowDelta = (snapped ? bestRow : candidateRow) - refInitialRow
      const primaryOffset = initialPrimaryY - refInitialY

      bIds.forEach(bid => {
        const newX = (initialXs[bid] ?? 0) + clampedX
        if (bid === 'primary') {
          const rawY = Math.max(0, initialPrimaryY + clampedY)
          const snapY = getRowY(bestRow, layout0) + primaryOffset
          useCanvasStore.getState().setBoardPos({ x: newX, y: Math.max(0, snapped ? snapY : rawY) })
        } else {
          const newRow = Math.max(0, (initialRows[bid] ?? 0) + rowDelta)
          useBoardsStore.getState().setBoardNlePos(bid, newRow, newX)
        }
      })
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setIsDragging(false)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [groupId])

  const { segments, globalCanvasLeft, globalCanvasRight, headerCanvasY } = useMemo(() => {
    const segs: Segment[] = []

    scopedBoardIds.forEach(bid => {
      const board = boards[bid]
      if (!board) return
      const rootBars = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
      if (rootBars.length === 0) return
      const bScale = board.boardScale ?? 1
      const minX = Math.min(...rootBars.map(b => b.x))
      const maxX = Math.max(...rootBars.map(b => b.x + b.width))
      const bx = bid === 'primary' ? boardPos.x : board.nleX
      segs.push({
        canvasLeft:  bx + BOARD_PADDING_X + minX * bScale,
        canvasWidth: (maxX - minX) * bScale,
        color: rootBars[0]?.color ?? '#5b8dd9',
        boardId: bid === 'primary' ? null : bid,
      })
    })

    if (segs.length === 0) return { segments: [], globalCanvasLeft: 0, globalCanvasRight: 200, headerCanvasY: -NLE_HEADER_CANVAS_H }

    const globalCanvasLeft  = Math.min(...segs.map(s => s.canvasLeft)) - 16
    const globalCanvasRight = Math.max(...segs.map(s => s.canvasLeft + s.canvasWidth)) + 16

    // Compute top of the group's boards using dynamic row layout
    const pRow = Math.max(0, yToRow(boardPos.y, computeRowLayout(boards, 0)))
    const layout = computeRowLayout(boards, pRow)
    const boardYs = scopedBoardIds.map(bid => {
      if (bid === 'primary') return boardPos.y
      return getRowY(boards[bid]?.nleRow ?? 0, layout)
    })
    const topBoardY = Math.min(...boardYs)
    const headerCanvasY = topBoardY - NLE_HEADER_CANVAS_H - GAP

    const offsetSegs = segs.map(s => ({ ...s, canvasLeft: s.canvasLeft - globalCanvasLeft }))
    return { segments: offsetSegs, globalCanvasLeft, globalCanvasRight, headerCanvasY }
  }, [scopedBoardIds, boardPos, boards])

  if (segments.length === 0) return null

  // Screen-space geometry
  const screenLeft   = pan.x + globalCanvasLeft * zoom
  const screenWidth  = (globalCanvasRight - globalCanvasLeft) * zoom

  const commitRename = () => {
    const trimmed = renameVal.trim()
    if (trimmed) {
      setHeaderName(trimmed)
      // If scoped to a group, also update the group name in the store
      if (groupId) useBoardsStore.getState().renameGroup(groupId, trimmed)
    }
    setRenaming(false)
  }

  // Forward wheel events to canvas zoom so scrolling over the header still zooms
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12
    let container = (e.currentTarget as HTMLElement).parentElement
    while (container && container.style.overflow !== 'hidden') container = container.parentElement
    const rect = container?.getBoundingClientRect()
    const mx = rect ? e.clientX - rect.left : e.clientX
    const my = rect ? e.clientY - rect.top : e.clientY
    useCanvasStore.getState().zoomAtPoint(f, mx, my)
  }, [])

  // ── Compact header bar ──
  const screenBottom = pan.y + (headerCanvasY + NLE_HEADER_CANVAS_H) * zoom
  // Tight height: 20px min (hugs the 12px font), scales with zoom at larger sizes
  const screenHeight = Math.max(NLE_HEADER_CANVAS_H * zoom, 20)
  const screenTop    = screenBottom - screenHeight
  const effectiveWidth = Math.max(screenWidth, 40)
  // When too narrow for name + viewer side by side, stack them
  const isNarrow = effectiveWidth < 90

  // Only render when on screen
  if (screenLeft + screenWidth < 0 || screenTop + screenHeight < 0) return null

  const viewerToggle = (
    <div
      data-viewer-toggle
      onPointerDown={e => { e.stopPropagation(); toggleViewer() }}
      style={{
        padding: '1px 5px',
        borderRadius: 4,
        background: viewerOpen ? 'rgba(37,99,235,0.32)' : 'rgba(0,0,0,0.30)',
        border: viewerOpen ? '1px solid rgba(37,99,235,0.55)' : '1px solid rgba(255,255,255,0.14)',
        color: viewerOpen ? 'rgba(130,180,255,0.95)' : 'rgba(255,255,255,0.55)',
        fontSize: 9,
        fontWeight: 700,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        lineHeight: '12px',
      }}
    >{viewerOpen ? '▼' : '▲'}</div>
  )

  const nameEl = renaming ? (
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
        borderRadius: 3,
        color: '#fff',
        fontSize: 10,
        fontWeight: 700,
        padding: '1px 6px',
        outline: 'none',
        fontFamily: 'inherit',
        width: 120,
        flexShrink: 1,
        minWidth: 40,
      }}
    />
  ) : (
    <span
      onDoubleClick={e => { e.stopPropagation(); setRenameVal(headerName); setRenaming(true) }}
      style={{
        color: 'rgba(255,255,255,0.92)',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.2px',
        textShadow: '0 1px 4px rgba(0,0,0,0.6)',
        cursor: 'default',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flex: '1 1 0',
        minWidth: 0,
        lineHeight: '14px',
      }}
    >{headerName}</span>
  )

  return (
    <div
      style={{
        position: 'absolute',
        left: screenLeft,
        top: isNarrow ? screenTop - 14 : screenTop,
        width: effectiveWidth,
        height: isNarrow ? screenHeight + 14 : screenHeight,
        zIndex: 40,
        userSelect: 'none',
        pointerEvents: 'all',
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
      onPointerDown={onTimelineDown}
      onWheel={onWheel}
    >
      {/* Background */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 6,
        backdropFilter: 'blur(12px)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
        overflow: 'hidden',
      }}>
        {/* Segment dividers */}
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

      {/* Content — stacked when narrow, row when wide */}
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex',
        flexDirection: isNarrow ? 'column' : 'row',
        alignItems: isNarrow ? 'flex-start' : 'center',
        justifyContent: isNarrow ? 'center' : 'flex-start',
        padding: isNarrow ? '2px 6px' : '0 8px 0 8px',
        zIndex: 2,
        gap: isNarrow ? 1 : 6,
      }}>
        {isNarrow ? (
          <>
            <div style={{ flex: '0 0 auto' }}>{viewerToggle}</div>
            {nameEl}
          </>
        ) : (
          <>
            {nameEl}
            <div style={{ flex: '0 0 auto' }}>{viewerToggle}</div>
          </>
        )}
      </div>
    </div>
  )
}
