// CardLayer — project/board-group overview (zoom ≤ 0.15)
// Renders one composite card per project group. Each group collapses its
// boards into a single draggable card with a hero image and summary.

import React, { useMemo, useState, useCallback, Fragment } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore } from '../../store/boardsStore'
import type { ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { groupSlot, clampGroupMove } from '../../utils/nlePush'
import type { GroupSlot } from '../../utils/nlePush'
import { computeRowLayout, getRowY, yToRow, getRowHeight, dyToRowDelta, boardContentHeight } from '../../utils/nleRows'
import { FreeCanvas } from '../Canvas/FreeCanvas'
import { NLETimelineHeader } from '../NLE/NLETimelineHeader'

const BOARD_PADDING_X = 20

/** Canvas-space content — free nodes visible at all layers */
const Canvas: React.FC = () => <FreeCanvas />

// ── Per-group card (screen-space) ──

const GroupCard: React.FC<{ group: ProjectGroup }> = ({ group }) => {
  const pan          = useCanvasStore(s => s.pan)
  const zoom         = useCanvasStore(s => s.zoom)
  const boardPos     = useCanvasStore(s => s.boardPos)

  const boards       = useBoardsStore(s => s.boards)
  const groups       = useBoardsStore(s => s.groups)
  const isSelected   = useBoardsStore(s => s.selectedGroupId === group.id)

  const [isDragging, setIsDragging] = useState(false)
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number } | null>(null)

  // Drag logic — moves only this group's boards
  const onCardDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    e.stopPropagation()
    e.preventDefault()
    // Select this card
    useBoardsStore.getState().setSelectedGroup(group.id)
    useUndoCoordinator.getState().checkpoint()
    let lastX = e.clientX
    let lastY = e.clientY
    let dyAccum = 0
    let xAccum = 0
    setIsDragging(true)

    const groupBoardIds = group.boardIds.slice()
    const cs0 = useCanvasStore.getState()
    const bs0 = useBoardsStore.getState()
    const layout0 = computeRowLayout(bs0.boards, 0)

    // Capture initial positions
    const initialRows: Record<string, number> = {}
    const initialXs: Record<string, number> = {}
    const initialPrimaryY = cs0.boardPos.y
    groupBoardIds.forEach(bid => {
      if (bid === 'primary') {
        initialRows[bid] = Math.max(0, yToRow(cs0.boardPos.y, layout0))
        initialXs[bid] = cs0.boardPos.x
      } else {
        const b = bs0.boards[bid]
        if (b) { initialRows[bid] = b.nleRow; initialXs[bid] = b.nleX }
      }
    })
    const refBid = groupBoardIds.includes('primary') ? 'primary' : groupBoardIds[0]
    const refInitialRow = initialRows[refBid] ?? 0

    // Collision: snapshot initial rect of this group + obstacle rects of all other groups
    const initialRect = groupSlot(group.id, groupBoardIds, bs0.boards, cs0.boardPos, layout0)
    const obstacleRects: GroupSlot[] = []
    bs0.groups.forEach(g => {
      if (g.id === group.id) return
      const slot = groupSlot(g.id, g.boardIds, bs0.boards, cs0.boardPos, layout0)
      if (slot) obstacleRects.push(slot)
    })

    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      const dx = (ev.clientX - lastX) / z
      const dy = (ev.clientY - lastY) / z
      lastX = ev.clientX
      lastY = ev.clientY
      dyAccum += dy
      xAccum += dx

      // Clamp movement against other cards (same module as board-level collision)
      let clampedX = xAccum
      let clampedY = dyAccum
      if (initialRect) {
        const clamped = clampGroupMove(initialRect, xAccum, dyAccum, obstacleRects)
        clampedX = clamped.dx
        clampedY = clamped.dy
      }

      // Soft-snap: find nearest row top and snap when within threshold
      const SNAP_THRESHOLD = 80
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

      groupBoardIds.forEach(bid => {
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
  }, [group.boardIds])

  // Geometry: compute bounding box in canvas space, then multiply by zoom for screen.
  // No fixed screen-pixel sizes — everything scales uniformly with zoom.
  const { screenLeft, screenTop, screenWidth, cardHeight, color } = useMemo(() => {
    const pRow = Math.max(0, yToRow(boardPos.y, computeRowLayout(boards, 0)))
    const layout = computeRowLayout(boards, pRow)

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

      const bx = bid === 'primary' ? boardPos.x : board.nleX
      const row = bid === 'primary' ? pRow : board.nleRow
      const by = bid === 'primary' ? boardPos.y : getRowY(row, layout)
      const rowH = getRowHeight(row, layout)
      // Card hangs below grid line when content is taller than the row
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
  }, [group.boardIds, boards, boardPos, pan, zoom, group.color])

  // Hero image: group-level, then scan boards
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

  // Forward wheel events to canvas zoom
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
        {/* Hero image background */}
        {heroImage && (
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage: `url(${heroImage})`,
            backgroundSize: 'cover', backgroundPosition: 'center',
            opacity: 0.7, borderRadius: 12,
          }} />
        )}
        {/* Label overlay */}
        <div style={{
          position: 'absolute', bottom: 6, left: 8,
          color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600,
          textShadow: '0 1px 4px rgba(0,0,0,0.8)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {group.cardSummary || `${group.boardIds.length} board${group.boardIds.length !== 1 ? 's' : ''}`}
        </div>
      </div>

      {/* Card-layer context menu */}
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
                // Delete all non-primary boards, then delete the group
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

/** Screen-space overlay — one card per group + per-group NLE headers */
const Overlay: React.FC = () => {
  const groups = useBoardsStore(s => s.groups)
  return (
    <>
      {groups.map(g => (
        <Fragment key={g.id}>
          <NLETimelineHeader groupId={g.id} />
          <GroupCard group={g} />
        </Fragment>
      ))}
    </>
  )
}

export const CardLayer = { Canvas, Overlay }
