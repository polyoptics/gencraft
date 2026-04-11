import React, { useMemo, useState, useRef, useCallback } from 'react'
import { useBoardsStore, getGroupForBoard } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useNLEViewerStore } from '../../store/nleViewerStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { computeGroupLayout, getRowY, snapToCardGrid, CARD_GRID_SPACING } from '../../utils/nleRows'
import { groupSlot, clampGroupMove } from '../../utils/nlePush'
import type { GroupSlot } from '../../utils/nlePush'
import { isHiddenDeckMember } from '../../hooks/useCardDecks'

const BOARD_PADDING_X = 20
export const NLE_HEADER_CANVAS_H = 36
const GAP = 2

interface Segment {
  canvasLeft: number
  canvasWidth: number
  color: string
  boardId: string | null
}

interface Props {
  groupId?: string
}

export const NLETimelineHeader: React.FC<Props> = ({ groupId }) => {
  const pan          = useCanvasStore(s => s.pan)
  const zoom         = useCanvasStore(s => s.zoom)

  const boards       = useBoardsStore(s => s.boards)
  const groups       = useBoardsStore(s => s.groups)

  // Resolve which group this header covers
  const group = groupId ? groups.find(g => g.id === groupId) : undefined
  const scopedBoardIds = useMemo(() => {
    if (group) return group.boardIds
    // No groupId → span all boards (legacy block/board level)
    const allBids: string[] = []
    groups.forEach(g => g.boardIds.forEach(bid => allBids.push(bid)))
    return allBids
  }, [group, groups])

  const defaultName = group?.name ?? 'NLE Timeline'

  const [headerName, setHeaderName] = useState(defaultName)
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const effectiveGroupId = groupId ?? 'default-group'
  const viewerOpen = useNLEViewerStore(s => s.openGroupIds.has(effectiveGroupId))
  const toggleViewer = useCallback(() => useNLEViewerStore.getState().toggle(effectiveGroupId), [effectiveGroupId])

  const prevGroupName = useRef(defaultName)
  if (defaultName !== prevGroupName.current) {
    prevGroupName.current = defaultName
    setHeaderName(defaultName)
  }

  // ── Group drag: simply move group.originY / group.originX ──
  const onTimelineDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if ((e.target as Element).closest('[data-viewer-toggle]')) return
    e.stopPropagation()
    e.preventDefault()
    useUndoCoordinator.getState().checkpoint()
    let lastX = e.clientX
    let lastY = e.clientY
    setIsDragging(true)

    // Snapshot initial group origin + obstacle slots
    const bs0 = useBoardsStore.getState()
    const g = groupId ? bs0.groups.find(g => g.id === groupId) : undefined
    const initialOriginY = g?.originY ?? 0
    const initialOriginX = g?.originX ?? 0
    let dyAccum = 0
    let dxAccum = 0

    // Build collision slots for all other groups
    let mySlot: GroupSlot | null = null
    let obstacles: GroupSlot[] = []
    if (groupId && g) {
      const myLayout = computeGroupLayout(g.boardIds, bs0.boards)
      mySlot = groupSlot(groupId, g.boardIds, bs0.boards, initialOriginX, initialOriginY, myLayout)
      // Zone-aware collision: only collide with groups in the timeline zone
      const zly = useCanvasStore.getState().zoneLineY
      const inTimeline = initialOriginY >= zly
      obstacles = inTimeline
        ? bs0.groups
            .filter(og => og.id !== groupId && og.originY >= zly && !isHiddenDeckMember(og))
            .map(og => groupSlot(og.id, og.boardIds, bs0.boards, og.originX, og.originY, computeGroupLayout(og.boardIds, bs0.boards)))
            .filter(Boolean) as GroupSlot[]
        : []  // free zone: no collision
    }

    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      const dx = (ev.clientX - lastX) / z
      const dy = (ev.clientY - lastY) / z
      lastX = ev.clientX
      lastY = ev.clientY
      dyAccum += dy
      dxAccum += dx

      if (groupId) {
        const rawY = initialOriginY + dyAccum
        // Soft-snap to coarse grid
        const { y: snapY, snapped } = snapToCardGrid(rawY, CARD_GRID_SPACING, 80)
        const preClampY = snapped ? snapY : rawY
        const preClampX = initialOriginX + dxAccum
        // Clamp against other groups (only in timeline zone)
        if (mySlot && obstacles.length > 0) {
          const { dx: cdx, dy: cdy } = clampGroupMove(mySlot, preClampX - initialOriginX, preClampY - initialOriginY, obstacles)
          useBoardsStore.getState().setGroupPos(groupId, initialOriginY + cdy, initialOriginX + cdx)
        } else {
          useBoardsStore.getState().setGroupPos(groupId, preClampY, preClampX)
        }
      }
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setIsDragging(false)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [groupId])

  // ── Geometry: segments + header position ──
  const { segments, globalCanvasLeft, globalCanvasRight, headerCanvasY } = useMemo(() => {
    const segs: Segment[] = []
    const groupOriginX = group?.originX ?? 0
    const groupOriginY = group?.originY ?? 0
    const groupLayout = group
      ? computeGroupLayout(group.boardIds, boards)
      : computeGroupLayout(scopedBoardIds, boards)

    scopedBoardIds.forEach(bid => {
      const board = boards[bid]
      if (!board) return
      const rootBars = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
      if (rootBars.length === 0) return
      const bScale = board.boardScale ?? 1
      const minX = Math.min(...rootBars.map(b => b.x))
      const maxX = Math.max(...rootBars.map(b => b.x + b.width))
      // Board absolute X = group origin + board local X
      const bx = groupOriginX + (board.nleX ?? 0)
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

    // Header Y = top of the group - header height - gap
    const topBoardY = groupOriginY  // group origin IS the top
    const headerCanvasY = topBoardY - NLE_HEADER_CANVAS_H - GAP

    const offsetSegs = segs.map(s => ({ ...s, canvasLeft: s.canvasLeft - globalCanvasLeft }))
    return { segments: offsetSegs, globalCanvasLeft, globalCanvasRight, headerCanvasY }
  }, [scopedBoardIds, boards, group])

  if (segments.length === 0) return null

  const screenLeft   = pan.x + globalCanvasLeft * zoom
  const screenWidth  = (globalCanvasRight - globalCanvasLeft) * zoom

  const commitRename = () => {
    const trimmed = renameVal.trim()
    if (trimmed) {
      setHeaderName(trimmed)
      if (groupId) useBoardsStore.getState().renameGroup(groupId, trimmed)
    }
    setRenaming(false)
  }

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

  const screenBottom = pan.y + (headerCanvasY + NLE_HEADER_CANVAS_H) * zoom
  const screenHeight = Math.max(NLE_HEADER_CANVAS_H * zoom, 20)
  const screenTop    = screenBottom - screenHeight
  const effectiveWidth = Math.max(screenWidth, 40)
  const isNarrow = effectiveWidth < 90

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
      <div style={{
        position: 'absolute', inset: 0,
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 6,
        backdropFilter: 'blur(12px)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
        overflow: 'hidden',
      }}>
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
