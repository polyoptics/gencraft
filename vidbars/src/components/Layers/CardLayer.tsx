// CardLayer — project/board-group overview (zoom ≤ 0.17)
// Renders one composite card per project group. Each group collapses its
// boards into a single draggable card with a hero image and summary.

import React, { useMemo, useState, useCallback, useRef, Fragment } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore, getUngroupedBoardIds } from '../../store/boardsStore'
import type { ProjectGroup, BoardData } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { DEFAULT_HEADER_STYLE, DEFAULT_BODY_STYLE } from '../../store/freeNodeStore'
import type { TextStyle } from '../../store/freeNodeStore'
import type { TextFieldMode } from '../UI/TextFormatToolbar'
import { TextFormatToolbar, hexToRgba, ensureFontLoaded } from '../UI/TextFormatToolbar'
import { computeGroupLayout, getRowY, getRowHeight, boardContentHeight, snapToCardGrid, CARD_GRID_SPACING } from '../../utils/nleRows'
import { groupSlot, clampGroupMove } from '../../utils/nlePush'
import { FreeCanvas } from '../Canvas/FreeCanvas'
import { NLETimelineHeader } from '../NLE/NLETimelineHeader'
import { getFirstImageUrl } from '../../types/bar'

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

  const [isHovered, setIsHovered] = useState(false)

  // ── Geometry: compute bounding box from group layout ──
  const { screenLeft, screenTop, screenWidth, cardHeight, contentCanvasW, contentCanvasH, color } = useMemo(() => {
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

    if (globalMinX === Infinity) return { screenLeft: 0, screenTop: 0, screenWidth: 0, cardHeight: 0, contentCanvasW: 0, contentCanvasH: 0, color: group.color }

    globalMinX -= 16
    globalMaxX += 16

    const cW = globalMaxX - globalMinX
    const cH = bottomY - topY
    const finalW = Math.max(cW, group.cardWidthOverride ?? 0)
    const finalH = Math.max(cH, group.cardHeightOverride ?? 0)

    return {
      screenLeft: pan.x + globalMinX * zoom,
      screenTop: pan.y + topY * zoom,
      screenWidth: finalW * zoom,
      cardHeight: finalH * zoom,
      contentCanvasW: cW,
      contentCanvasH: cH,
      color: group.color,
    }
  }, [group.boardIds, group.originX, group.originY, group.cardWidthOverride, group.cardHeightOverride, boards, pan, zoom, group.color])

  // Hero image
  const heroImage = useMemo(() => {
    if (group.cardHeroImage) return group.cardHeroImage
    for (const bid of group.boardIds) {
      const board = boards[bid]
      if (!board) continue
      for (const rid of board.rootIds) {
        const img = getFirstImageUrl(board.bars[rid]?.content)
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

  const onResizeDown = useCallback((e: React.PointerEvent, edge: 'right' | 'bottom' | 'corner') => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    useUndoCoordinator.getState().checkpoint()

    const startX = e.clientX
    const startY = e.clientY
    const startW = screenWidth / zoom
    const startH = cardHeight / zoom

    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      const dx = (ev.clientX - startX) / z
      const dy = (ev.clientY - startY) / z
      const newW = edge === 'bottom' ? startW : Math.max(contentCanvasW, startW + dx)
      const newH = edge === 'right' ? startH : Math.max(contentCanvasH, startH + dy)
      useBoardsStore.getState().setGroupCardSize(
        group.id,
        newW > contentCanvasW ? newW : undefined,
        newH > contentCanvasH ? newH : undefined,
      )
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [group.id, screenWidth, cardHeight, contentCanvasW, contentCanvasH, zoom])

  if (screenWidth === 0) return null
  if (screenLeft + screenWidth < 0 || screenTop + cardHeight < 0) return null

  return (
    <>
      <div
        data-layer-card={group.id}
        data-nle-card={group.boardIds[0] ?? ''}
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
        onPointerDownCapture={e => {
          if (e.button !== 0) return
          useBoardsStore.getState().setSelectedGroup(group.id)
        }}
        onPointerDown={onCardDown}
        onPointerEnter={() => setIsHovered(true)}
        onPointerLeave={() => setIsHovered(false)}
        onWheel={onWheel}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setCardMenu({ x: e.clientX, y: e.clientY }) }}
        onDoubleClick={e => {
          e.stopPropagation()
          const el = e.currentTarget.querySelector('[data-card-text]') as HTMLElement | null
          el?.dispatchEvent(new CustomEvent('start-edit', { bubbles: false }))
        }}
      >
        {heroImage && (
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage: `url(${heroImage})`,
            backgroundSize: 'cover', backgroundPosition: 'center',
            opacity: 0.7, borderRadius: 12,
          }} />
        )}
        {/* Independent card-level text */}
        <GroupCardText groupId={group.id} />
        <div style={{
          position: 'absolute', bottom: 6, left: 8, zIndex: 2,
          color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600,
          textShadow: '0 1px 4px rgba(0,0,0,0.8)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {group.cardSummary || `${group.boardIds.length} board${group.boardIds.length !== 1 ? 's' : ''}`}
        </div>
        {/* ── Resize handles ── */}
        {isHovered && (
          <>
            <div
              style={{
                position: 'absolute', top: 8, right: 0, width: 6,
                height: cardHeight - 16, cursor: 'col-resize', zIndex: 50,
                background: 'rgba(130,180,255,0.4)', borderRadius: 3, opacity: 0.7,
              }}
              onPointerDown={e => onResizeDown(e, 'right')}
            />
            <div
              style={{
                position: 'absolute', bottom: 0, left: 8, height: 6,
                width: screenWidth - 16, cursor: 'row-resize', zIndex: 50,
                background: 'rgba(130,180,255,0.4)', borderRadius: 3, opacity: 0.7,
              }}
              onPointerDown={e => onResizeDown(e, 'bottom')}
            />
            <div
              style={{
                position: 'absolute', bottom: 0, right: 0, width: 12, height: 12,
                cursor: 'nwse-resize', zIndex: 51,
                background: 'rgba(130,180,255,0.6)', borderRadius: '3px 0 3px 0',
              }}
              onPointerDown={e => onResizeDown(e, 'corner')}
            />
          </>
        )}
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
  const [isHovered, setIsHovered] = useState(false)

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
  const rawContentW = (maxBarX - minBarX) * bScale + 32
  const rawContentH = boardContentHeight(board.bars, board.rootIds, bScale)
  const cardWOverride = board.layers?.card?.widthOverride
  const cardHOverride = board.layers?.card?.heightOverride
  const contentW = Math.max(rawContentW, cardWOverride ?? 0)
  const contentH = Math.max(rawContentH, cardHOverride ?? 0)

  const screenLeft = pan.x + (cx + BOARD_PADDING_X + minBarX * bScale - 16) * zoom
  const screenTop = pan.y + cy * zoom
  const screenWidth = contentW * zoom
  const screenHeight = contentH * zoom
  const color = board.color ?? '#5b8dd9'

  const heroImage = rootBars.reduce<string | null>((found, b) => found || getFirstImageUrl(b.content), null)

  const onResizeDown = useCallback((e: React.PointerEvent, edge: 'right' | 'bottom' | 'corner') => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    useUndoCoordinator.getState().checkpoint()

    const startX = e.clientX
    const startY = e.clientY
    const startW = contentW
    const startH = contentH

    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      const dx = (ev.clientX - startX) / z
      const dy = (ev.clientY - startY) / z
      const newW = edge === 'bottom' ? startW : Math.max(rawContentW, startW + dx)
      const newH = edge === 'right' ? startH : Math.max(rawContentH, startH + dy)
      useBoardsStore.getState().setCardSize(
        boardId,
        newW > rawContentW ? newW : undefined,
        newH > rawContentH ? newH : undefined,
      )
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [boardId, contentW, contentH, rawContentW, rawContentH])

  return (
    <div
      data-nle-card={boardId}
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
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      onWheel={onWheel}
      onDoubleClick={e => {
        e.stopPropagation()
        const el = e.currentTarget.querySelector('[data-card-text]') as HTMLElement | null
        el?.dispatchEvent(new CustomEvent('start-edit', { bubbles: false }))
      }}
    >
      {heroImage && (
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: `url(${heroImage})`,
          backgroundSize: 'cover', backgroundPosition: 'center',
          opacity: 0.7, borderRadius: 12,
        }} />
      )}
      {/* Independent card-level text */}
      <UngroupedCardText boardId={boardId} />
      <div style={{
        position: 'absolute', bottom: 6, left: 8, zIndex: 2,
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
      {/* ── Resize handles ── */}
      {isHovered && (
        <>
          <div
            style={{
              position: 'absolute', top: 8, right: 0, width: 6,
              height: screenHeight - 16, cursor: 'col-resize', zIndex: 50,
              background: 'rgba(130,180,255,0.4)', borderRadius: 3, opacity: 0.7,
            }}
            onPointerDown={e => onResizeDown(e, 'right')}
          />
          <div
            style={{
              position: 'absolute', bottom: 0, left: 8, height: 6,
              width: screenWidth - 16, cursor: 'row-resize', zIndex: 50,
              background: 'rgba(130,180,255,0.4)', borderRadius: 3, opacity: 0.7,
            }}
            onPointerDown={e => onResizeDown(e, 'bottom')}
          />
          <div
            style={{
              position: 'absolute', bottom: 0, right: 0, width: 12, height: 12,
              cursor: 'nwse-resize', zIndex: 51,
              background: 'rgba(130,180,255,0.6)', borderRadius: '3px 0 3px 0',
            }}
            onPointerDown={e => onResizeDown(e, 'corner')}
          />
        </>
      )}
    </div>
  )
}

// ── Deck components ──

import { useCardDecks, type Deck } from '../../hooks/useCardDecks'

/** Stacked deck — only anchor visible, peek tabs behind, badge + controls */
const StackedDeckCard: React.FC<{ deck: Deck; anchorGroup: ProjectGroup }> = ({ deck, anchorGroup }) => {
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const boards = useBoardsStore(s => s.boards)
  const groups = useBoardsStore(s => s.groups)
  const [isHovered, setIsHovered] = useState(false)

  // Compute anchor card geometry — identical to GroupCard so it looks exactly the same
  const { screenLeft, screenTop, screenWidth, screenHeight } = useMemo(() => {
    const groupLayout = computeGroupLayout(anchorGroup.boardIds, boards)
    let globalMinX = Infinity, globalMaxX = -Infinity, topY = Infinity, bottomY = -Infinity

    anchorGroup.boardIds.forEach(bid => {
      const board = boards[bid]
      if (!board) return
      const bScale = board.boardScale ?? 1
      const rootBars = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
      if (rootBars.length === 0) return
      const bx = anchorGroup.originX + (board.nleX ?? 0)
      const localRow = board.nleRow ?? 0
      const by = anchorGroup.originY + getRowY(localRow, groupLayout)
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

    if (globalMinX === Infinity) return { screenLeft: 0, screenTop: 0, screenWidth: 0, screenHeight: 0 }
    globalMinX -= 16; globalMaxX += 16
    const cW = globalMaxX - globalMinX, cH = bottomY - topY
    const finalW = Math.max(cW, anchorGroup.cardWidthOverride ?? 0)
    const finalH = Math.max(cH, anchorGroup.cardHeightOverride ?? 0)
    return {
      screenLeft: pan.x + globalMinX * zoom,
      screenTop: pan.y + topY * zoom,
      screenWidth: finalW * zoom,
      screenHeight: finalH * zoom,
    }
  }, [anchorGroup, boards, pan, zoom])

  if (screenWidth === 0) return null

  // Secondary groups with their own rects for aspect-ratio scaling
  const secondaryCards = useMemo(() => {
    return deck.memberIds
      .filter(id => id !== anchorGroup.id)
      .map(id => {
        const g = groups.find(gr => gr.id === id)
        const rect = deck.rects.get(id)
        if (!g || !rect) return null
        const w = rect.right - rect.left
        const h = rect.bottom - rect.top
        return { group: g, aspectRatio: w / h, origW: w, origH: h }
      })
      .filter(Boolean) as { group: ProjectGroup; aspectRatio: number; origW: number; origH: number }[]
  }, [deck.memberIds, deck.rects, anchorGroup.id, groups])

  // Drag handler: move all members together with grid snap + collision
  const onDeckDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    useUndoCoordinator.getState().checkpoint()

    let lastX = e.clientX
    let lastY = e.clientY
    let dyAccum = 0
    let dxAccum = 0

    const bs0 = useBoardsStore.getState()
    const initialOrigins = new Map<string, { x: number; y: number }>()
    for (const gid of deck.memberIds) {
      const g = bs0.groups.find(gr => gr.id === gid)
      if (g) initialOrigins.set(gid, { x: g.originX, y: g.originY })
    }

    const anchorOrigin = initialOrigins.get(deck.anchorGroupId)
    const anchorLayout = computeGroupLayout(anchorGroup.boardIds, bs0.boards)
    const mySlot = anchorOrigin
      ? groupSlot(deck.anchorGroupId, anchorGroup.boardIds, bs0.boards, anchorOrigin.x, anchorOrigin.y, anchorLayout)
      : null

    const deckSet = new Set(deck.memberIds)
    const zly = useCanvasStore.getState().zoneLineY
    const inTimeline = (anchorOrigin?.y ?? 0) >= zly
    const obstacles = inTimeline
      ? bs0.groups
          .filter(g => !deckSet.has(g.id) && g.originY >= zly)
          .map(g => groupSlot(g.id, g.boardIds, bs0.boards, g.originX, g.originY, computeGroupLayout(g.boardIds, bs0.boards)))
          .filter(Boolean) as import('../../utils/nlePush').GroupSlot[]
      : []

    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      const dx = (ev.clientX - lastX) / z
      const dy = (ev.clientY - lastY) / z
      lastX = ev.clientX
      lastY = ev.clientY
      dyAccum += dy
      dxAccum += dx

      const anchorInitY = anchorOrigin?.y ?? 0
      const anchorInitX = anchorOrigin?.x ?? 0
      const rawY = anchorInitY + dyAccum
      const { y: snapY, snapped } = snapToCardGrid(rawY, CARD_GRID_SPACING, 80)
      const preClampY = snapped ? snapY : rawY
      const preClampX = anchorInitX + dxAccum

      let finalDx: number, finalDy: number
      if (mySlot && obstacles.length > 0) {
        const { dx: cdx, dy: cdy } = clampGroupMove(mySlot, preClampX - anchorInitX, preClampY - anchorInitY, obstacles)
        finalDx = cdx
        finalDy = cdy
      } else {
        finalDx = preClampX - anchorInitX
        finalDy = preClampY - anchorInitY
      }

      for (const [gid, origin] of initialOrigins) {
        useBoardsStore.getState().setGroupPos(gid, origin.y + finalDy, origin.x + finalDx)
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [deck.memberIds, deck.anchorGroupId, anchorGroup.boardIds])

  const heroImage = useMemo(() => {
    if (anchorGroup.cardHeroImage) return anchorGroup.cardHeroImage
    for (const bid of anchorGroup.boardIds) {
      const board = boards[bid]
      if (!board) continue
      for (const rid of board.rootIds) {
        const img = getFirstImageUrl(board.bars[rid]?.content)
        if (img) return img
      }
    }
    return null
  }, [anchorGroup, boards])

  // Secondary cards: tucked behind primary, only a thin edge visible to the right
  const EDGE_PEEK = 6 // px each secondary card edge peeks out to the right

  return (
    <>
      {/* Secondary card edges — thin slivers peeking right of primary to show it's a deck */}
      {secondaryCards.map((sc, i) => {
        const peekX = screenLeft + screenWidth + EDGE_PEEK * i
        return (
          <div
            key={sc.group.id}
            style={{
              position: 'absolute',
              left: peekX,
              top: screenTop,
              width: EDGE_PEEK,
              height: screenHeight,
              borderRadius: '0 4px 4px 0',
              background: sc.group.color || '#5b8dd9',
              borderRight: '1px solid rgba(255,255,255,0.15)',
              borderTop: '1px solid rgba(255,255,255,0.10)',
              borderBottom: '1px solid rgba(255,255,255,0.10)',
              zIndex: 38 - i,
              pointerEvents: 'none',
            }}
          />
        )
      })}
      {/* Hover wrapper — covers card + controls area so hover persists while moving to buttons */}
      <div
        style={{
          position: 'absolute',
          left: screenLeft,
          top: screenTop,
          width: screenWidth,
          height: screenHeight + 30, // extra space for controls below
          zIndex: 40,
          pointerEvents: 'all',
        }}
        onPointerEnter={() => setIsHovered(true)}
        onPointerLeave={() => setIsHovered(false)}
      >
        {/* Primary card — front, identical to open state, defines deck shape */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: screenWidth,
            height: screenHeight,
            borderRadius: 12,
            background: heroImage
              ? `linear-gradient(160deg, ${anchorGroup.color}cc 0%, ${anchorGroup.color}aa 100%)`
              : anchorGroup.color,
            border: '2px solid rgba(180,210,255,0.5)',
            boxShadow: '0 6px 32px rgba(0,0,0,0.5)',
            overflow: 'hidden',
            cursor: 'grab',
            userSelect: 'none',
          }}
          onPointerDown={onDeckDown}
        >
          {heroImage && (
            <div style={{
              position: 'absolute', inset: 0,
              backgroundImage: `url(${heroImage})`,
              backgroundSize: 'cover', backgroundPosition: 'center',
              opacity: 0.7, borderRadius: 12,
            }} />
          )}
          <GroupCardText groupId={anchorGroup.id} />
          <div style={{
            position: 'absolute', bottom: 6, left: 8, zIndex: 2,
            color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600,
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
          }}>
            {anchorGroup.cardSummary || anchorGroup.name}
          </div>
          {/* Badge on primary card */}
          {isHovered && (
            <div style={{
              position: 'absolute', top: 6, right: 6, zIndex: 50,
              display: 'flex', gap: 4,
            }}>
              <DeckBadge count={deck.memberIds.length} />
            </div>
          )}
        </div>
        {/* Fan/Open controls — shown on hover, below primary */}
        {isHovered && (
          <div style={{
            position: 'absolute',
            left: '50%',
            top: screenHeight + 4,
            transform: 'translateX(-50%)',
            display: 'flex', gap: 4,
            zIndex: 60,
          }}>
            {(['Fan', 'Open'] as const).map(label => (
              <button
                key={label}
                style={{
                  background: 'rgba(30,31,48,0.95)', color: '#e2e8f0',
                  border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6,
                  padding: '3px 8px', fontSize: 10, fontWeight: 600,
                  cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
                }}
                onClick={e => {
                  e.stopPropagation()
                  useUndoCoordinator.getState().checkpoint()
                  if (label === 'Fan') useBoardsStore.getState().setDeckState(deck.memberIds, 'fanned')
                  else useBoardsStore.getState().setDeckState(deck.memberIds, 'open')
                }}
                onPointerDown={e => e.stopPropagation()}
              >{label}</button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/** Fanned deck — cards spread with overlap from anchor position */
const FannedDeckOverlay: React.FC<{ deck: Deck; groups: ProjectGroup[] }> = ({ deck, groups }) => {
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const boards = useBoardsStore(s => s.boards)
  const [frontId, setFrontId] = useState<string | null>(null)

  const anchorRect = deck.rects.get(deck.anchorGroupId)
  if (!anchorRect) return null

  const anchorScreenLeft = pan.x + anchorRect.left * zoom
  const anchorScreenTop = pan.y + anchorRect.top * zoom
  const cardW = (anchorRect.right - anchorRect.left) * zoom
  const cardH = (anchorRect.bottom - anchorRect.top) * zoom
  const fanOffset = cardW * 0.35 // 35% overlap

  // Drag single card out of fan
  const onFannedCardDown = useCallback((e: React.PointerEvent, groupId: string, index: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()

    const startX = e.clientX
    const startY = e.clientY
    let dragged = false

    const onMove = (ev: PointerEvent) => {
      const dist = Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY)
      if (dist > 30 && !dragged) {
        dragged = true
        // Pull card out — set it to 'open', rest stay fanned
        useUndoCoordinator.getState().checkpoint()
        useBoardsStore.getState().setDeckState([groupId], 'open')
      }
      if (dragged) {
        // Move the now-open card
        const z = useCanvasStore.getState().zoom
        const g = useBoardsStore.getState().groups.find(gr => gr.id === groupId)
        if (g) {
          const dx = (ev.clientX - startX) / z
          const dy = (ev.clientY - startY) / z
          // Don't accumulate — use offset from start
          const rect = deck.rects.get(groupId)
          if (rect) {
            useBoardsStore.getState().setGroupPos(groupId, g.originY + dy * 0.05, g.originX + dx * 0.05)
          }
        }
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!dragged) {
        // Just a click — bring to front
        setFrontId(prev => prev === groupId ? null : groupId)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [deck])

  // Drag entire fan
  const onFanDragDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    useUndoCoordinator.getState().checkpoint()

    let lastX = e.clientX
    let lastY = e.clientY
    let dyAccum = 0
    let dxAccum = 0

    // Snapshot initial origins
    const bs0 = useBoardsStore.getState()
    const initialOrigins = new Map<string, { x: number; y: number }>()
    for (const gid of deck.memberIds) {
      const g = bs0.groups.find(gr => gr.id === gid)
      if (g) initialOrigins.set(gid, { x: g.originX, y: g.originY })
    }
    const anchorOrigin = initialOrigins.get(deck.anchorGroupId)

    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      const dx = (ev.clientX - lastX) / z
      const dy = (ev.clientY - lastY) / z
      lastX = ev.clientX
      lastY = ev.clientY
      dyAccum += dy
      dxAccum += dx

      const anchorInitY = anchorOrigin?.y ?? 0
      const rawY = anchorInitY + dyAccum
      const { y: snapY, snapped } = snapToCardGrid(rawY, CARD_GRID_SPACING, 80)
      const finalDy = (snapped ? snapY : rawY) - anchorInitY
      const finalDx = dxAccum

      for (const [gid, origin] of initialOrigins) {
        useBoardsStore.getState().setGroupPos(gid, origin.y + finalDy, origin.x + finalDx)
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [deck.memberIds])

  // Reorder: front card first
  const orderedIds = useMemo(() => {
    if (!frontId || !deck.memberIds.includes(frontId)) return deck.memberIds
    return [...deck.memberIds.filter(id => id !== frontId), frontId]
  }, [deck.memberIds, frontId])

  return (
    <>
      {orderedIds.map((gid, renderIdx) => {
        const memberIndex = deck.memberIds.indexOf(gid)
        const g = groups.find(gr => gr.id === gid)
        if (!g) return null

        const heroImage = (() => {
          if (g.cardHeroImage) return g.cardHeroImage
          for (const bid of g.boardIds) {
            const board = boards[bid]
            if (!board) continue
            for (const rid of board.rootIds) {
              const img = getFirstImageUrl(board.bars[rid]?.content)
              if (img) return img
            }
          }
          return null
        })()

        const isFront = gid === frontId
        const left = anchorScreenLeft + memberIndex * fanOffset
        const top = anchorScreenTop

        return (
          <div
            key={gid}
            style={{
              position: 'absolute',
              left, top,
              width: cardW, height: cardH,
              borderRadius: 12,
              background: heroImage
                ? `linear-gradient(160deg, ${g.color}cc 0%, ${g.color}aa 100%)`
                : g.color,
              border: isFront ? '2px solid rgba(180,210,255,0.7)' : '1.5px solid rgba(255,255,255,0.2)',
              boxShadow: isFront ? '0 8px 32px rgba(0,0,0,0.6)' : '0 4px 16px rgba(0,0,0,0.4)',
              overflow: 'hidden',
              zIndex: 38 + renderIdx,
              cursor: 'pointer',
              userSelect: 'none',
              pointerEvents: 'all',
              transition: 'box-shadow 0.15s, border 0.15s',
            }}
            onPointerDown={e => onFannedCardDown(e, gid, memberIndex)}
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
              position: 'absolute', bottom: 6, left: 8, right: 8, zIndex: 2,
              color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: 600,
              textShadow: '0 1px 4px rgba(0,0,0,0.8)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {g.name}
            </div>
          </div>
        )
      })}
      {/* Fan drag handle — bottom bar */}
      <div
        style={{
          position: 'absolute',
          left: anchorScreenLeft,
          top: anchorScreenTop + cardH + 2,
          width: cardW + (deck.memberIds.length - 1) * fanOffset,
          height: 4,
          background: 'rgba(130,180,255,0.3)',
          borderRadius: 2,
          cursor: 'grab',
          zIndex: 50,
          pointerEvents: 'all',
        }}
        onPointerDown={onFanDragDown}
      />
      <DeckControls
        left={anchorScreenLeft + (cardW + (deck.memberIds.length - 1) * fanOffset) / 2}
        top={anchorScreenTop + cardH + 10}
        onStack={() => {
          useUndoCoordinator.getState().checkpoint()
          useBoardsStore.getState().setDeckState(deck.memberIds, 'stacked')
        }}
        onOpen={() => {
          useUndoCoordinator.getState().checkpoint()
          useBoardsStore.getState().setDeckState(deck.memberIds, 'open')
        }}
        mode="fanned"
      />
    </>
  )
}

/** Badge pill showing deck card count */
const DeckBadge: React.FC<{ count: number }> = ({ count }) => (
  <div style={{
    background: 'rgba(60,100,200,0.9)', color: '#fff',
    fontSize: 10, fontWeight: 700, padding: '2px 6px',
    borderRadius: 10, minWidth: 16, textAlign: 'center',
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
    pointerEvents: 'none',
  }}>
    {count}
  </div>
)

/** Deck state transition buttons */
const DeckControls: React.FC<{
  left: number; top: number
  onFan?: () => void
  onStack?: () => void
  onOpen?: () => void
  mode: 'stacked' | 'fanned' | 'affordance'
}> = ({ left, top, onFan, onStack, onOpen, mode }) => {
  const btnStyle: React.CSSProperties = {
    background: 'rgba(30,31,48,0.95)', color: '#e2e8f0',
    border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6,
    padding: '3px 8px', fontSize: 10, fontWeight: 600,
    cursor: 'pointer', pointerEvents: 'all',
    boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
  }
  return (
    <div
      style={{
        position: 'absolute',
        left, top,
        transform: 'translateX(-50%)',
        display: 'flex', gap: 4,
        zIndex: 60,
        pointerEvents: 'all',
      }}
    >
      {mode === 'stacked' && onFan && (
        <button style={btnStyle} onClick={e => { e.stopPropagation(); onFan() }}
          onPointerDown={e => e.stopPropagation()}>Fan</button>
      )}
      {mode === 'stacked' && onOpen && (
        <button style={btnStyle} onClick={e => { e.stopPropagation(); onOpen() }}
          onPointerDown={e => e.stopPropagation()}>Open</button>
      )}
      {mode === 'fanned' && onStack && (
        <button style={btnStyle} onClick={e => { e.stopPropagation(); onStack() }}
          onPointerDown={e => e.stopPropagation()}>Stack</button>
      )}
      {mode === 'fanned' && onOpen && (
        <button style={btnStyle} onClick={e => { e.stopPropagation(); onOpen() }}
          onPointerDown={e => e.stopPropagation()}>Open</button>
      )}
      {mode === 'affordance' && onStack && (
        <button style={btnStyle} onClick={e => { e.stopPropagation(); onStack() }}
          onPointerDown={e => e.stopPropagation()}>Stack</button>
      )}
      {mode === 'affordance' && onFan && (
        <button style={btnStyle} onClick={e => { e.stopPropagation(); onFan() }}
          onPointerDown={e => e.stopPropagation()}>Fan</button>
      )}
    </div>
  )
}

/** Compute card screen rect using the same geometry as GroupCard */
function cardScreenRect(g: ProjectGroup, boards: Record<string, import('../../store/boardsStore').BoardData>, pan: { x: number; y: number }, zoom: number) {
  const groupLayout = computeGroupLayout(g.boardIds, boards)
  let gMinX = Infinity, gMaxX = -Infinity, topY = Infinity, bottomY = -Infinity
  g.boardIds.forEach(bid => {
    const board = boards[bid]
    if (!board) return
    const bScale = board.boardScale ?? 1
    const rootBars = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
    if (rootBars.length === 0) return
    const bx = g.originX + (board.nleX ?? 0)
    const localRow = board.nleRow ?? 0
    const by = g.originY + getRowY(localRow, groupLayout)
    const rowH = getRowHeight(localRow, groupLayout)
    const contentH = boardContentHeight(board.bars, board.rootIds, bScale)
    const visualH = Math.max(rowH, contentH)
    const minX = Math.min(...rootBars.map(b => b.x))
    const maxX = Math.max(...rootBars.map(b => b.x + b.width))
    const left = bx + BOARD_PADDING_X + minX * bScale
    const right = bx + BOARD_PADDING_X + maxX * bScale
    if (left < gMinX) gMinX = left
    if (right > gMaxX) gMaxX = right
    if (by < topY) topY = by
    if (by + visualH > bottomY) bottomY = by + visualH
  })
  if (gMinX === Infinity) return null
  gMinX -= 16; gMaxX += 16
  const cW = gMaxX - gMinX, cH = bottomY - topY
  const finalW = Math.max(cW, g.cardWidthOverride ?? 0)
  const finalH = Math.max(cH, g.cardHeightOverride ?? 0)
  return {
    screenLeft: pan.x + gMinX * zoom,
    screenTop: pan.y + topY * zoom,
    screenWidth: finalW * zoom,
    screenHeight: finalH * zoom,
  }
}

/** Affordance shown when open cards are touching — hover on primary shows outline + stack/fan */
const DeckAffordance: React.FC<{ cluster: string[] }> = ({ cluster }) => {
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const [isHovered, setIsHovered] = useState(false)

  // Build screen rects using same geometry as GroupCard
  const memberRects = useMemo(() => {
    return cluster.map(gid => {
      const g = groups.find(gr => gr.id === gid)
      if (!g) return null
      const rect = cardScreenRect(g, boards, pan, zoom)
      if (!rect) return null
      return { gid, ...rect }
    }).filter(Boolean) as { gid: string; screenLeft: number; screenTop: number; screenWidth: number; screenHeight: number }[]
  }, [cluster, groups, boards, pan, zoom])

  const primary = memberRects[0]
  if (!primary) return null

  return (
    <>
      {/* Invisible hover zone over the primary card — extends down to cover button area */}
      <div
        style={{
          position: 'absolute',
          left: primary.screenLeft,
          top: primary.screenTop,
          width: primary.screenWidth,
          height: primary.screenHeight + 34,
          zIndex: 41,
          pointerEvents: 'all',
          cursor: 'default',
        }}
        onPointerEnter={() => setIsHovered(true)}
        onPointerLeave={() => setIsHovered(false)}
      >
        {/* Stack/Fan buttons below the primary card — only on hover */}
        {isHovered && (
          <div style={{
            position: 'absolute',
            left: '50%',
            top: primary.screenHeight + 4,
            transform: 'translateX(-50%)',
            display: 'flex', gap: 4,
            zIndex: 60,
          }}>
            {(['Stack', 'Fan'] as const).map(label => (
              <button
                key={label}
                style={{
                  background: 'rgba(30,31,48,0.95)', color: '#e2e8f0',
                  border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6,
                  padding: '3px 8px', fontSize: 10, fontWeight: 600,
                  cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
                }}
                onClick={e => {
                  e.stopPropagation()
                  useUndoCoordinator.getState().checkpoint()
                  if (label === 'Stack') useBoardsStore.getState().setDeckState(cluster, 'stacked')
                  else useBoardsStore.getState().setDeckState(cluster, 'fanned')
                }}
                onPointerDown={e => e.stopPropagation()}
              >{label}</button>
            ))}
          </div>
        )}
      </div>
      {/* Outline borders around all cluster members on hover — outside hover zone for correct positioning */}
      {isHovered && memberRects.map(r => (
        <div
          key={r.gid}
          style={{
            position: 'absolute',
            left: r.screenLeft - 3,
            top: r.screenTop - 3,
            width: r.screenWidth + 6,
            height: r.screenHeight + 6,
            border: '2px dashed rgba(130,180,255,0.6)',
            borderRadius: 14,
            zIndex: 39,
            pointerEvents: 'none',
          }}
        />
      ))}
    </>
  )
}

// Alias to avoid name conflict with component-level import
import { groupSlot as __groupSlot } from '../../utils/nlePush'

/** Screen-space overlay — one card per group + per-group NLE headers + ungrouped board cards */
const Overlay: React.FC = () => {
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const zoneLineY = useCanvasStore(s => s.zoneLineY)
  const ungroupedIds = useMemo(() => getUngroupedBoardIds(groups, boards), [groups, boards])
  const { decks, touchingClusters, getDeckForGroup } = useCardDecks(groups, boards, zoneLineY)

  // Track which groups are rendered by decks so we skip them
  const renderedByDeck = useMemo(() => {
    const set = new Set<string>()
    for (const d of decks) {
      for (const gid of d.memberIds) set.add(gid)
    }
    return set
  }, [decks])

  // Affordance clusters: touching clusters where at least one member is 'open'
  const affordanceClusters = useMemo(() => {
    return touchingClusters.filter(cluster => {
      // Skip if this cluster is fully handled by a deck
      const allInDeck = cluster.every(gid => renderedByDeck.has(gid))
      if (allInDeck) return false
      // Show affordance if at least 2 open cards are touching
      const openCount = cluster.filter(gid => {
        const g = groups.find(gr => gr.id === gid)
        return !g?.deckState || g.deckState === 'open'
      }).length
      return openCount >= 2
    })
  }, [touchingClusters, renderedByDeck, groups])

  return (
    <>
      {groups.map(g => {
        // Hard gate: if this group is a non-anchor member of any deck, hide it completely.
        // This uses the persisted deckAnchorId — no spatial clustering needed.
        if (g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id) {
          return null
        }

        const deck = getDeckForGroup(g.id)

        // If anchor of a stacked deck → render StackedDeckCard
        if (deck?.state === 'stacked' && deck.anchorGroupId === g.id) {
          return (
            <Fragment key={g.id}>
              <NLETimelineHeader groupId={g.id} />
              <StackedDeckCard deck={deck} anchorGroup={g} />
            </Fragment>
          )
        }

        // If in a fanned deck → rendered by FannedDeckOverlay (only once for anchor)
        if (deck?.state === 'fanned') {
          if (deck.anchorGroupId === g.id) {
            const memberGroups = deck.memberIds.map(id => groups.find(gr => gr.id === id)).filter(Boolean) as ProjectGroup[]
            return (
              <Fragment key={g.id}>
                <NLETimelineHeader groupId={g.id} />
                <FannedDeckOverlay deck={deck} groups={memberGroups} />
              </Fragment>
            )
          }
          return null // non-anchor fanned member — rendered by FannedDeckOverlay
        }

        // Normal open card
        return (
          <Fragment key={g.id}>
            <NLETimelineHeader groupId={g.id} />
            <GroupCard group={g} />
          </Fragment>
        )
      })}
      {/* Affordance buttons for open touching clusters */}
      {affordanceClusters.map(cluster => (
        <DeckAffordance key={cluster.join('|')} cluster={cluster} />
      ))}
      {ungroupedIds.map(bid => (
        <UngroupedBoardCard key={bid} boardId={bid} />
      ))}
    </>
  )
}

// ── Card-level independent text with full formatting (header + body) ──

// Shared helpers for card text styling
const cardTextareaStyle = (ts: TextStyle, bg: string): React.CSSProperties => ({
  width: '100%', padding: 6, boxSizing: 'border-box',
  background: bg || 'transparent',
  color: ts.color, fontSize: ts.fontSize, lineHeight: 1.4,
  fontWeight: ts.bold ? 700 : 400, fontStyle: ts.italic ? 'italic' : 'normal',
  textAlign: ts.align,
  border: '1px solid rgba(100,160,255,0.5)', borderRadius: 8,
  outline: 'none', resize: 'none', fontFamily: ts.fontFamily || 'inherit',
  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  cursor: 'text',
})

const vAlignToJustify = (va: string) => va === 'middle' ? 'center' : va === 'bottom' ? 'flex-end' : 'flex-start'

const cardDisplayStyle = (ts: TextStyle, bg: string, hasText: boolean): React.CSSProperties => ({
  padding: hasText ? 6 : 0,
  background: bg || 'transparent',
  borderRadius: 6,
  color: ts.color, fontSize: ts.fontSize, lineHeight: 1.4,
  fontWeight: ts.bold ? 700 : 400, fontStyle: ts.italic ? 'italic' : 'normal',
  textAlign: ts.align, fontFamily: ts.fontFamily || 'inherit',
  overflow: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  textShadow: hasText ? '0 1px 3px rgba(0,0,0,0.8)' : 'none',
  cursor: 'text',
})

const GroupCardText: React.FC<{ groupId: string }> = ({ groupId }) => {
  const bodyText = useBoardsStore(s => s.groups.find(g => g.id === groupId)?.cardText ?? '')
  const rawBodyStyle = useBoardsStore(s => s.groups.find(g => g.id === groupId)?.cardTextStyle)
  const bodyTs: TextStyle = useMemo(() => ({ ...DEFAULT_BODY_STYLE, ...rawBodyStyle }), [rawBodyStyle])

  const headerText = useBoardsStore(s => s.groups.find(g => g.id === groupId)?.cardHeaderText ?? '')
  const rawHeaderStyle = useBoardsStore(s => s.groups.find(g => g.id === groupId)?.cardHeaderTextStyle)
  const headerTs: TextStyle = useMemo(() => ({ ...DEFAULT_HEADER_STYLE, ...rawHeaderStyle }), [rawHeaderStyle])
  ensureFontLoaded(headerTs.fontFamily); ensureFontLoaded(bodyTs.fontFamily)

  const [editingField, setEditingField] = useState<'header' | 'body' | null>(null)
  const [activeField, setActiveField] = useState<TextFieldMode>('header')
  const [selected, setSelected] = useState(false)
  const [headerVal, setHeaderVal] = useState('')
  const [bodyVal, setBodyVal] = useState('')
  const wrapperRef = useRef<HTMLDivElement>(null)

  const headerBg = hexToRgba(headerTs.bgColor, headerTs.bgOpacity)
  const bodyBg = hexToRgba(bodyTs.bgColor, bodyTs.bgOpacity)
  const rect = selected && wrapperRef.current ? wrapperRef.current.getBoundingClientRect() : null
  const hasContent = !!(headerText || bodyText)

  const commitHeader = useCallback(() => {
    useBoardsStore.getState().setGroupCardHeaderText(groupId, headerVal)
    setEditingField(null)
  }, [groupId, headerVal])

  const commitBody = useCallback(() => {
    useBoardsStore.getState().setGroupCardText(groupId, bodyVal)
    setEditingField(null)
  }, [groupId, bodyVal])

  const startEditHeader = useCallback(() => {
    setHeaderVal(headerText); setEditingField('header'); setActiveField('header'); setSelected(true)
  }, [headerText])

  const startEditBody = useCallback(() => {
    setBodyVal(bodyText); setEditingField('body'); setActiveField('body'); setSelected(true)
  }, [bodyText])

  React.useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const handler = () => startEditHeader()
    el.addEventListener('start-edit', handler)
    return () => el.removeEventListener('start-edit', handler)
  }, [startEditHeader])

  React.useEffect(() => {
    if (!selected) return
    if (activeField === 'header' && editingField !== 'header') startEditHeader()
    else if (activeField === 'body' && editingField !== 'body') startEditBody()
  }, [activeField]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={wrapperRef} data-card-text style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
      {selected && (
        <TextFormatToolbar
          headerStyle={headerTs}
          bodyStyle={bodyTs}
          onHeaderStyleChange={style => useBoardsStore.getState().setGroupCardHeaderTextStyle(groupId, style)}
          onBodyStyleChange={style => useBoardsStore.getState().setGroupCardTextStyle(groupId, style)}
          activeField={activeField}
          onActiveFieldChange={setActiveField}
          anchorRect={rect}
          preferBelow
        />
      )}
      <div
        style={{
          position: 'absolute', inset: 0, padding: '4px 4px 10px 4px',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          pointerEvents: editingField ? 'auto' : 'none',
        }}
        onPointerDown={e => { if (editingField) e.stopPropagation() }}
        onBlur={e => {
          const related = e.relatedTarget as HTMLElement | null
          if (related?.closest('[data-text-format-toolbar]')) return
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          if (editingField === 'header') commitHeader()
          if (editingField === 'body') commitBody()
          setSelected(false); setEditingField(null)
        }}
        tabIndex={0}
      >
        {/* Header area — owns top half, positions content by its vAlign */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: vAlignToJustify(headerTs.vAlign), minHeight: 0 }}>
          {editingField === 'header' ? (
            <textarea autoFocus value={headerVal} onChange={e => setHeaderVal(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { commitHeader(); setSelected(false) }
                if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); commitHeader(); startEditBody() }
              }}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setActiveField('header') }}
              placeholder="Title…"
              style={{ ...cardTextareaStyle(headerTs, headerBg || 'rgba(0,0,0,0.3)'), flex: 1 }}
            />
          ) : (
            <div
              onDoubleClick={e => { e.stopPropagation(); startEditHeader() }}
              style={{ ...cardDisplayStyle(headerTs, headerBg, !!headerText), pointerEvents: 'auto' }}
            >{headerText || null}</div>
          )}
        </div>
        {/* Body area — owns bottom half, positions content by its vAlign */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: vAlignToJustify(bodyTs.vAlign), minHeight: 0 }}>
          {editingField === 'body' ? (
            <textarea autoFocus value={bodyVal} onChange={e => setBodyVal(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { commitBody(); setSelected(false) }
                if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); commitBody(); startEditHeader() }
              }}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setActiveField('body') }}
              placeholder="Body text…"
              style={{ ...cardTextareaStyle(bodyTs, bodyBg || 'rgba(0,0,0,0.3)'), flex: 1 }}
            />
          ) : (
            <div
              onDoubleClick={e => { e.stopPropagation(); startEditBody() }}
              style={{ ...cardDisplayStyle(bodyTs, bodyBg, !!bodyText), pointerEvents: 'auto' }}
            >{bodyText || null}</div>
          )}
        </div>
      </div>
    </div>
  )
}

const UngroupedCardText: React.FC<{ boardId: string }> = ({ boardId }) => {
  const bodyText = useBoardsStore(s => s.boards[boardId]?.layers?.card?.text ?? '')
  const rawBodyStyle = useBoardsStore(s => s.boards[boardId]?.layers?.card?.textStyle)
  const bodyTs: TextStyle = useMemo(() => ({ ...DEFAULT_BODY_STYLE, ...rawBodyStyle }), [rawBodyStyle])

  const headerText = useBoardsStore(s => s.boards[boardId]?.layers?.card?.headerText ?? '')
  const rawHeaderStyle = useBoardsStore(s => s.boards[boardId]?.layers?.card?.headerTextStyle)
  const headerTs: TextStyle = useMemo(() => ({ ...DEFAULT_HEADER_STYLE, ...rawHeaderStyle }), [rawHeaderStyle])
  ensureFontLoaded(headerTs.fontFamily); ensureFontLoaded(bodyTs.fontFamily)

  const [editingField, setEditingField] = useState<'header' | 'body' | null>(null)
  const [activeField, setActiveField] = useState<TextFieldMode>('header')
  const [selected, setSelected] = useState(false)
  const [headerVal, setHeaderVal] = useState('')
  const [bodyVal, setBodyVal] = useState('')
  const wrapperRef = useRef<HTMLDivElement>(null)

  const headerBg = hexToRgba(headerTs.bgColor, headerTs.bgOpacity)
  const bodyBg = hexToRgba(bodyTs.bgColor, bodyTs.bgOpacity)
  const rect = selected && wrapperRef.current ? wrapperRef.current.getBoundingClientRect() : null
  const hasContent = !!(headerText || bodyText)

  const commitHeader = useCallback(() => {
    useBoardsStore.getState().setCardHeaderText(boardId, headerVal)
    setEditingField(null)
  }, [boardId, headerVal])

  const commitBody = useCallback(() => {
    useBoardsStore.getState().setCardText(boardId, bodyVal)
    setEditingField(null)
  }, [boardId, bodyVal])

  const startEditHeader = useCallback(() => {
    setHeaderVal(headerText); setEditingField('header'); setActiveField('header'); setSelected(true)
  }, [headerText])

  const startEditBody = useCallback(() => {
    setBodyVal(bodyText); setEditingField('body'); setActiveField('body'); setSelected(true)
  }, [bodyText])

  React.useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const handler = () => startEditHeader()
    el.addEventListener('start-edit', handler)
    return () => el.removeEventListener('start-edit', handler)
  }, [startEditHeader])

  React.useEffect(() => {
    if (!selected) return
    if (activeField === 'header' && editingField !== 'header') startEditHeader()
    else if (activeField === 'body' && editingField !== 'body') startEditBody()
  }, [activeField]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={wrapperRef} data-card-text style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
      {selected && (
        <TextFormatToolbar
          headerStyle={headerTs}
          bodyStyle={bodyTs}
          onHeaderStyleChange={style => useBoardsStore.getState().setCardHeaderTextStyle(boardId, style)}
          onBodyStyleChange={style => useBoardsStore.getState().setCardTextStyle(boardId, style)}
          activeField={activeField}
          onActiveFieldChange={setActiveField}
          anchorRect={rect}
          preferBelow
        />
      )}
      <div
        style={{
          position: 'absolute', inset: 0, padding: '4px 4px 10px 4px',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          pointerEvents: editingField ? 'auto' : 'none',
        }}
        onPointerDown={e => { if (editingField) e.stopPropagation() }}
        onBlur={e => {
          const related = e.relatedTarget as HTMLElement | null
          if (related?.closest('[data-text-format-toolbar]')) return
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          if (editingField === 'header') commitHeader()
          if (editingField === 'body') commitBody()
          setSelected(false); setEditingField(null)
        }}
        tabIndex={0}
      >
        {/* Header area — owns top half, positions content by its vAlign */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: vAlignToJustify(headerTs.vAlign), minHeight: 0 }}>
          {editingField === 'header' ? (
            <textarea autoFocus value={headerVal} onChange={e => setHeaderVal(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { commitHeader(); setSelected(false) }
                if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); commitHeader(); startEditBody() }
              }}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setActiveField('header') }}
              placeholder="Title…"
              style={{ ...cardTextareaStyle(headerTs, headerBg || 'rgba(0,0,0,0.3)'), flex: 1 }}
            />
          ) : (
            <div
              onDoubleClick={e => { e.stopPropagation(); startEditHeader() }}
              style={{ ...cardDisplayStyle(headerTs, headerBg, !!headerText), pointerEvents: 'auto' }}
            >{headerText || null}</div>
          )}
        </div>
        {/* Body area — owns bottom half, positions content by its vAlign */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: vAlignToJustify(bodyTs.vAlign), minHeight: 0 }}>
          {editingField === 'body' ? (
            <textarea autoFocus value={bodyVal} onChange={e => setBodyVal(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { commitBody(); setSelected(false) }
                if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); commitBody(); startEditHeader() }
              }}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setActiveField('body') }}
              placeholder="Body text…"
              style={{ ...cardTextareaStyle(bodyTs, bodyBg || 'rgba(0,0,0,0.3)'), flex: 1 }}
            />
          ) : (
            <div
              onDoubleClick={e => { e.stopPropagation(); startEditBody() }}
              style={{ ...cardDisplayStyle(bodyTs, bodyBg, !!bodyText), pointerEvents: 'auto' }}
            >{bodyText || null}</div>
          )}
        </div>
      </div>
    </div>
  )
}

export const CardLayer = { Canvas, Overlay }
