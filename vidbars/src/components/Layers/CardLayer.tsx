// CardLayer — project/board-group overview (zoom ≤ 0.15)
// Renders one composite card per project group. Each group collapses its
// boards into a single draggable card with a hero image and summary.

import React, { useMemo, useState, useCallback, Fragment } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore, getUngroupedBoardIds } from '../../store/boardsStore'
import type { ProjectGroup, BoardData } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { computeGroupLayout, getRowY, getRowHeight, boardContentHeight, snapToCardGrid, CARD_GRID_SPACING } from '../../utils/nleRows'
import { groupSlot, clampGroupMove } from '../../utils/nlePush'
import { FreeCanvas } from '../Canvas/FreeCanvas'
import { NLETimelineHeader } from '../NLE/NLETimelineHeader'

const BOARD_PADDING_X = 20

/** Canvas-space content — free nodes visible at all layers */
const Canvas: React.FC = () => <FreeCanvas />

// ── Per-group card (screen-space) ──

const GroupCard: React.FC<{ group: ProjectGroup }> = ({ group }) => {
  const pan          = useCanvasStore(s => s.pan)
  const zoom         = useCanvasStore(s => s.zoom)

  const boards       = useBoardsStore(s => s.boards)
  const groups       = useBoardsStore(s => s.groups)
  const isSelected   = useBoardsStore(s => s.selectedGroupId === group.id)

  const [isDragging, setIsDragging] = useState(false)
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number } | null>(null)

  // ── Group drag: move group.originY / group.originX ──
  const onCardDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    e.stopPropagation()
    e.preventDefault()
    useBoardsStore.getState().setSelectedGroup(group.id)
    useUndoCoordinator.getState().checkpoint()
    let lastX = e.clientX
    let lastY = e.clientY
    let dyAccum = 0
    let dxAccum = 0
    setIsDragging(true)

    // Snapshot initial group origin + obstacle slots
    const bs0 = useBoardsStore.getState()
    const g0 = bs0.groups.find(g => g.id === group.id)
    const initialOriginY = g0?.originY ?? 0
    const initialOriginX = g0?.originX ?? 0
    const myLayout = computeGroupLayout(group.boardIds, bs0.boards)
    const mySlot = groupSlot(group.id, group.boardIds, bs0.boards, initialOriginX, initialOriginY, myLayout)
    // Zone-aware collision: only collide with groups in the timeline zone
    const zly = useCanvasStore.getState().zoneLineY
    const inTimeline = initialOriginY >= zly
    const obstacles = inTimeline
      ? bs0.groups
          .filter(g => g.id !== group.id && g.originY >= zly)
          .map(g => groupSlot(g.id, g.boardIds, bs0.boards, g.originX, g.originY, computeGroupLayout(g.boardIds, bs0.boards)))
          .filter(Boolean) as import('../../utils/nlePush').GroupSlot[]
      : []  // free zone: no collision

    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      const dx = (ev.clientX - lastX) / z
      const dy = (ev.clientY - lastY) / z
      lastX = ev.clientX
      lastY = ev.clientY
      dyAccum += dy
      dxAccum += dx

      const rawY = initialOriginY + dyAccum
      // Soft-snap to coarse grid
      const { y: snapY, snapped } = snapToCardGrid(rawY, CARD_GRID_SPACING, 80)
      const preClampY = snapped ? snapY : rawY
      const preClampX = initialOriginX + dxAccum
      // Clamp against other groups (only in timeline zone)
      if (mySlot && obstacles.length > 0) {
        const { dx: cdx, dy: cdy } = clampGroupMove(mySlot, preClampX - initialOriginX, preClampY - initialOriginY, obstacles)
        useBoardsStore.getState().setGroupPos(group.id, initialOriginY + cdy, initialOriginX + cdx)
      } else {
        useBoardsStore.getState().setGroupPos(group.id, preClampY, preClampX)
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setIsDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [group.id])

  // ── Geometry: compute bounding box from group layout ──
  const { screenLeft, screenTop, screenWidth, cardHeight, color } = useMemo(() => {
    const groupLayout = computeGroupLayout(group.boardIds, boards)

    let globalMinX = Infinity
    let globalMaxX = -Infinity
    let topY = Infinity
    let bottomY = -Infinity

    group.boardIds.forEach(bid => {
      const board = boards[bid]
      if (!board) return
      const bScale = board.boardScale ?? 1
      const rootBars = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
      if (rootBars.length === 0) return

      const bx = group.originX + (board.nleX ?? 0)
      const localRow = board.nleRow ?? 0
      const by = group.originY + getRowY(localRow, groupLayout)
      const rowH = getRowHeight(localRow, groupLayout)
      const contentH = boardContentHeight(board.bars, board.rootIds, bScale)
      const visualH = Math.max(rowH, contentH)
      const minX = Math.min(...rootBars.map(b => b.x))
      const maxX = Math.max(...rootBars.map(b => b.x + b.width))
      const left = bx + BOARD_PADDING_X + minX * bScale
      const right = bx + BOARD_PADDING_X + maxX * bScale

      if (left < globalMinX) globalMinX = left
      if (right > globalMaxX) globalMaxX = right
      if (by < topY) topY = by
      if (by + visualH > bottomY) bottomY = by + visualH
    })

    if (globalMinX === Infinity) return { screenLeft: 0, screenTop: 0, screenWidth: 0, cardHeight: 0, color: group.color }

    globalMinX -= 16
    globalMaxX += 16

    return {
      screenLeft: pan.x + globalMinX * zoom,
      screenTop: pan.y + topY * zoom,
      screenWidth: (globalMaxX - globalMinX) * zoom,
      cardHeight: (bottomY - topY) * zoom,
      color: group.color,
    }
  }, [group.boardIds, group.originX, group.originY, boards, pan, zoom, group.color])

  // Hero image
  const heroImage = useMemo(() => {
    if (group.cardHeroImage) return group.cardHeroImage
    for (const bid of group.boardIds) {
      const board = boards[bid]
      if (!board) continue
      for (const rid of board.rootIds) {
        const img = board.bars[rid]?.content?.images?.[0]
        if (img) return img
      }
    }
    return null
  }, [group.cardHeroImage, group.boardIds, boards])

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

  if (screenWidth === 0) return null
  if (screenLeft + screenWidth < 0 || screenTop + cardHeight < 0) return null

  return (
    <>
      <div
        data-layer-card={group.id}
        style={{
          position: 'absolute',
          left: screenLeft,
          top: screenTop,
          width: screenWidth,
          height: cardHeight,
          zIndex: 40,
          userSelect: 'none',
          pointerEvents: 'all',
          cursor: isDragging ? 'grabbing' : 'grab',
          borderRadius: 12,
          background: heroImage
            ? `linear-gradient(160deg, ${color}cc 0%, ${color}aa 100%)`
            : color,
          touchAction: 'none',
          border: isSelected ? '2px solid rgba(130,180,255,0.8)' : '1.5px solid rgba(255,255,255,0.25)',
          boxShadow: isSelected ? '0 4px 24px rgba(37,99,235,0.4)' : '0 4px 24px rgba(0,0,0,0.4)',
          overflow: 'hidden',
        }}
        onPointerDown={onCardDown}
        onWheel={onWheel}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setCardMenu({ x: e.clientX, y: e.clientY }) }}
      >
        {heroImage && (
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage: `url(${heroImage})`,
            backgroundSize: 'cover', backgroundPosition: 'center',
            opacity: 0.7, borderRadius: 12,
          }} />
        )}
        <div style={{
          position: 'absolute', bottom: 6, left: 8,
          color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600,
          textShadow: '0 1px 4px rgba(0,0,0,0.8)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {group.cardSummary || `${group.boardIds.length} board${group.boardIds.length !== 1 ? 's' : ''}`}
        </div>
      </div>

      {cardMenu && ReactDOM.createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={() => setCardMenu(null)} />
          <div
            onPointerDown={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: Math.min(cardMenu.x, window.innerWidth - 180),
              top: Math.min(cardMenu.y, window.innerHeight - 200),
              width: 180, zIndex: 9999,
              background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
              padding: '5px 0', fontFamily: 'system-ui, sans-serif',
            }}
          >
            <div style={{ padding: '4px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: 4 }}>
              <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{group.name}</span>
            </div>
            {[
              { label: 'Rename', icon: '✏️', action: () => {
                const val = prompt('Card name:', group.name)
                if (val !== null) useBoardsStore.getState().renameGroup(group.id, val)
                setCardMenu(null)
              }},
              { label: 'Set Color', icon: '🎨', action: () => {
                const val = prompt('Color hex:', group.color)
                if (val !== null) useBoardsStore.getState().setGroupColor(group.id, val)
                setCardMenu(null)
              }},
              { label: 'Edit Summary', icon: '📝', action: () => {
                const val = prompt('Card summary:', group.cardSummary)
                if (val !== null) useBoardsStore.getState().setGroupCardSummary(group.id, val)
                setCardMenu(null)
              }},
              { label: 'Duplicate', icon: '📋', action: () => {
                useUndoCoordinator.getState().checkpoint()
                useBoardsStore.getState().duplicateGroup(group.id)
                setCardMenu(null)
              }},
              ...(heroImage ? [{ label: 'Remove Hero Image', icon: '🖼', action: () => {
                useUndoCoordinator.getState().checkpoint()
                useBoardsStore.getState().setGroupCardHeroImage(group.id, null)
                setCardMenu(null)
              }}] : []),
              ...(groups.length > 1 ? [{ label: 'Delete Card', icon: '🗑', action: () => {
                useUndoCoordinator.getState().checkpoint()
                group.boardIds.forEach(bid => {
                  if (bid !== 'primary') useBoardsStore.getState().deleteBoard(bid)
                })
                useBoardsStore.getState().deleteGroup(group.id)
                setCardMenu(null)
              }}] : []),
            ].map(item => (
              <button
                key={item.label}
                onClick={item.action}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  width: '100%', padding: '7px 14px',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: '#e2e8f0', fontSize: 13, textAlign: 'left', borderRadius: 4,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}
              >
                <span style={{ fontSize: 14, width: 18, textAlign: 'center' }}>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </>
  )
}

// ── Ungrouped board card (free canvas) ──

const UngroupedBoardCard: React.FC<{ boardId: string }> = ({ boardId }) => {
  const pan    = useCanvasStore(s => s.pan)
  const zoom   = useCanvasStore(s => s.zoom)
  const board  = useBoardsStore(s => s.boards[boardId])
  const [isDragging, setIsDragging] = useState(false)

  const onDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    useUndoCoordinator.getState().checkpoint()
    setIsDragging(true)
    let lastX = e.clientX, lastY = e.clientY
    let dxAccum = 0, dyAccum = 0
    const startCX = board?.canvasX ?? 0
    const startCY = board?.canvasY ?? 0

    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      dxAccum += (ev.clientX - lastX) / z
      dyAccum += (ev.clientY - lastY) / z
      lastX = ev.clientX; lastY = ev.clientY
      useBoardsStore.getState().setUngroupedBoardPos(boardId, startCX + dxAccum, startCY + dyAccum)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setIsDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [boardId, board?.canvasX, board?.canvasY])

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

  if (!board) return null

  const bScale = board.boardScale ?? 1
  const rootBars = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
  if (rootBars.length === 0) return null

  const cx = board.canvasX ?? 0
  const cy = board.canvasY ?? 0
  const minBarX = Math.min(...rootBars.map(b => b.x))
  const maxBarX = Math.max(...rootBars.map(b => b.x + b.width))
  const contentW = (maxBarX - minBarX) * bScale + 32
  const contentH = boardContentHeight(board.bars, board.rootIds, bScale)

  const screenLeft = pan.x + (cx + BOARD_PADDING_X + minBarX * bScale - 16) * zoom
  const screenTop = pan.y + cy * zoom
  const screenWidth = contentW * zoom
  const screenHeight = contentH * zoom
  const color = board.color ?? '#5b8dd9'

  const heroImage = rootBars.find(b => b.content?.images?.length > 0)?.content.images[0] ?? null

  return (
    <div
      style={{
        position: 'absolute',
        left: screenLeft, top: screenTop,
        width: screenWidth, height: screenHeight,
        zIndex: 40, userSelect: 'none', pointerEvents: 'all',
        cursor: isDragging ? 'grabbing' : 'grab',
        borderRadius: 12,
        background: heroImage ? `linear-gradient(160deg, ${color}cc 0%, ${color}aa 100%)` : color,
        touchAction: 'none',
        border: '1.5px solid rgba(255,255,255,0.25)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        overflow: 'hidden',
      }}
      onPointerDown={onDown}
      onWheel={onWheel}
    >
      {heroImage && (
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: `url(${heroImage})`,
          backgroundSize: 'cover', backgroundPosition: 'center',
          opacity: 0.7, borderRadius: 12,
        }} />
      )}
      <div style={{
        position: 'absolute', bottom: 6, left: 8,
        color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600,
        textShadow: '0 1px 4px rgba(0,0,0,0.8)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {board.projectName}
      </div>
      {/* Dashed border to distinguish ungrouped */}
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 12,
        border: '1.5px dashed rgba(255,255,255,0.3)',
        pointerEvents: 'none',
      }} />
    </div>
  )
}

/** Screen-space overlay — one card per group + per-group NLE headers + ungrouped board cards */
const Overlay: React.FC = () => {
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const ungroupedIds = useMemo(() => getUngroupedBoardIds(groups, boards), [groups, boards])
  return (
    <>
      {groups.map(g => (
        <Fragment key={g.id}>
          <NLETimelineHeader groupId={g.id} />
          <GroupCard group={g} />
        </Fragment>
      ))}
      {ungroupedIds.map(bid => (
        <UngroupedBoardCard key={bid} boardId={bid} />
      ))}
    </>
  )
}

export const CardLayer = { Canvas, Overlay }
