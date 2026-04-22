// CardLayer — project/board-group overview (zoom ≤ 0.17)
// Renders one composite card per project group. Each group collapses its
// boards into a single draggable card with a hero image and summary.

import React, { useMemo, useState, useCallback, useRef, useDeferredValue, Fragment } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore, getUngroupedBoardIds } from '../../store/boardsStore'
import type { ProjectGroup, BoardData } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { DEFAULT_HEADER_STYLE, DEFAULT_BODY_STYLE } from '../../store/freeNodeStore'
import type { TextStyle } from '../../store/freeNodeStore'
import type { TextFieldMode } from '../UI/TextFormatToolbar'
import { TextFormatToolbar, hexToRgba, ensureFontLoaded } from '../UI/TextFormatToolbar'
import { ColorPickerPopup } from '../Bar/ColorPickerPopup'
import { computeGroupLayout, getRowY, getRowHeight, snapToCardGrid, CARD_GRID_SPACING } from '../../utils/nleRows'
import { PrimaryChipRail } from '../Linking/PrimaryChipRail'
import { BackRefChipRail } from '../Linking/BackRefChipRail'
import { CloneDeck } from '../Linking/CloneDeck'
import { useLinkingStore } from '../../store/linkingStore'
import { DEFAULT_H } from '../../utils/barConstants'
import { groupSlot, clampGroupMove } from '../../utils/nlePush'
import { FreeCanvas } from '../Canvas/FreeCanvas'
import { NLETimelineHeader, NLE_HEADER_CANVAS_H } from '../NLE/NLETimelineHeader'
import { HeroImageLayer } from './HeroImageLayer'
import { HeroImageEditOverlay } from '../UI/HeroImageEditOverlay'
import { getFirstImageUrl } from '../../types/bar'
import { hexToHsl, hslToHex, selectionHighlight } from '../../utils/colorUtils'

const BOARD_PADDING_X = 20

/** Derive a deck-edge border color from a card's base color at a given alpha */
function edgeColor(baseHex: string, alpha: number): string {
  const { h, s, l } = hexToHsl(baseHex)
  const hex = hslToHex(h, Math.min(1, s + 0.1), Math.min(1, l + 0.25))
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${alpha})`
}

/** Start a middle-mouse pan from overlay elements (which are siblings of InfiniteCanvas, not children) */
function startOverlayPan(e: React.PointerEvent) {
  if (e.button !== 1) return
  e.preventDefault()
  e.stopPropagation()
  let lastX = e.clientX
  let lastY = e.clientY
  const onMove = (ev: PointerEvent) => {
    useCanvasStore.getState().shiftPan(ev.clientX - lastX, ev.clientY - lastY)
    lastX = ev.clientX
    lastY = ev.clientY
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

/** Shared context menu for all card types (GroupCard, StackedDeckCard, FannedDeckOverlay) */
const CardContextMenu: React.FC<{
  pos: { x: number; y: number }
  group: ProjectGroup
  heroImage: string | null
  deckMemberIds?: string[]   // if this card is part of a deck
  deckState?: 'open' | 'fanned' | 'stacked'
  onClose: () => void
  onEditHeroImage?: () => void
}> = ({ pos, group, heroImage, deckMemberIds, deckState, onClose, onEditHeroImage }) => {
  const groups = useBoardsStore(s => s.groups)
  const [colorPicker, setColorPicker] = useState<{ x: number; y: number } | null>(null)

  const menuItems: { label: string; icon: string; action: () => void; danger?: boolean; separator?: boolean }[] = []

  // Rename
  menuItems.push({ label: 'Rename', icon: '✏️', action: () => {
    const val = prompt('Card name:', group.name)
    if (val !== null) useBoardsStore.getState().renameGroup(group.id, val)
    onClose()
  }})

  // Edit Summary
  menuItems.push({ label: 'Edit Summary', icon: '📝', action: () => {
    const val = prompt('Card summary:', group.cardSummary)
    if (val !== null) useBoardsStore.getState().setGroupCardSummary(group.id, val)
    onClose()
  }})

  // Color — opens full color picker
  menuItems.push({ label: 'Card Color', icon: '🎨', action: () => setColorPicker(colorPicker ? null : { x: pos.x + 200, y: pos.y }) })

  // Separator before deck actions
  if (deckMemberIds && deckMemberIds.length >= 2) {
    if (deckState !== 'stacked') menuItems.push({ label: 'Stack', icon: '📚', separator: true, action: () => {
      useUndoCoordinator.getState().checkpoint()
      useBoardsStore.getState().setDeckState(deckMemberIds, 'stacked')
      onClose()
    }})
    if (deckState !== 'fanned') menuItems.push({ label: 'Fan', icon: '🃏', separator: !deckState || deckState === 'stacked' ? false : true, action: () => {
      useUndoCoordinator.getState().checkpoint()
      useBoardsStore.getState().setDeckState(deckMemberIds, 'fanned')
      onClose()
    }})
    if (deckState && deckState !== 'open') menuItems.push({ label: 'Open Deck', icon: '📂', action: () => {
      useUndoCoordinator.getState().checkpoint()
      useBoardsStore.getState().setDeckState(deckMemberIds, 'open')
      onClose()
    }})
  }

  // Duplicate
  menuItems.push({ label: 'Duplicate', icon: '📋', action: () => {
    useUndoCoordinator.getState().checkpoint()
    useBoardsStore.getState().duplicateGroup(group.id)
    onClose()
  }})

  // Hero image actions
  if (heroImage && onEditHeroImage) menuItems.push({ label: 'Edit Hero Image', icon: '✂️', action: () => {
    onClose()
    onEditHeroImage()
  }})
  if (heroImage) menuItems.push({ label: 'Remove Hero Image', icon: '🖼', action: () => {
    useUndoCoordinator.getState().checkpoint()
    useBoardsStore.getState().setGroupCardHeroImage(group.id, null)
    onClose()
  }})

  // Delete
  if (groups.length > 1) menuItems.push({ label: 'Delete Card', icon: '🗑', danger: true, separator: true, action: () => {
    useUndoCoordinator.getState().checkpoint()
    group.boardIds.forEach(bid => {
      if (bid !== 'primary') useBoardsStore.getState().deleteBoard(bid)
    })
    useBoardsStore.getState().deleteGroup(group.id)
    onClose()
  }})

  return ReactDOM.createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={onClose} />
      <div
        onPointerDown={e => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: Math.min(pos.x, window.innerWidth - 200),
          top: Math.min(pos.y, window.innerHeight - 300),
          width: 200, zIndex: 9999,
          background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
          padding: '5px 0', fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ padding: '4px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: 4 }}>
          <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{group.name}</span>
        </div>
        {menuItems.map((item, i) => (
          <React.Fragment key={item.label}>
            {item.separator && i > 0 && (
              <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '4px 0' }} />
            )}
            <button
              onClick={item.action}
              style={{
                display: 'flex', alignItems: 'center', gap: 9,
                width: '100%', padding: '7px 14px',
                background: 'none', border: 'none', cursor: 'pointer',
                color: item.danger ? '#f87171' : '#e2e8f0', fontSize: 13, textAlign: 'left', borderRadius: 4,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              <span style={{ fontSize: 14, width: 18, textAlign: 'center' }}>{item.icon}</span>
              {item.label}
            </button>
          </React.Fragment>
        ))}
      </div>
      {colorPicker && (
        <ColorPickerPopup
          color={group.color}
          anchorX={colorPicker.x}
          anchorY={colorPicker.y}
          onChange={c => {
            useUndoCoordinator.getState().checkpoint()
            useBoardsStore.getState().setGroupColor(group.id, c)
          }}
          onClose={() => { setColorPicker(null); onClose() }}
        />
      )}
    </>,
    document.body
  )
}

/** Canvas-space content — free nodes visible at all layers */
const Canvas: React.FC = () => <FreeCanvas />

// ── Per-group card (screen-space) ──

const GroupCardInner: React.FC<{ group: ProjectGroup }> = ({ group }) => {
  const pan          = useCanvasStore(s => s.pan)
  const zoom         = useCanvasStore(s => s.zoom)

  const boards       = useBoardsStore(s => s.boards)
  const isSelected   = useBoardsStore(s => s.selectedGroupIds.includes(group.id))

  const [isDragging, setIsDragging] = useState(false)
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number } | null>(null)
  const [isEditingHero, setIsEditingHero] = useState(false)

  // ── Group drag: move group.originY / group.originX ──
  const onCardDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    e.stopPropagation()
    e.preventDefault()

    // Shift+click: toggle multi-selection, no drag
    if (e.shiftKey) {
      useBoardsStore.getState().toggleGroupSelection(group.id)
      return
    }

    // If this card is already in selection, drag all selected. Otherwise single-select + drag.
    const bs0 = useBoardsStore.getState()
    const alreadySelected = bs0.selectedGroupIds.includes(group.id)
    if (!alreadySelected) {
      bs0.setSelectedGroup(group.id)
    }
    useUndoCoordinator.getState().checkpoint()

    // Expand to include nested sub-deck members
    const draggingIds = expandWithNestedMembers(
      alreadySelected ? [...bs0.selectedGroupIds] : [group.id],
      bs0.groups,
    )

    let lastX = e.clientX
    let lastY = e.clientY
    let dyAccum = 0
    let dxAccum = 0
    setIsDragging(true)

    // Snapshot initial origins for all dragging groups
    const initialOrigins = new Map<string, { x: number; y: number }>()
    for (const gid of draggingIds) {
      const g = bs0.groups.find(gr => gr.id === gid)
      if (g) initialOrigins.set(gid, { x: g.originX, y: g.originY })
    }
    const initialOriginY = initialOrigins.get(group.id)?.y ?? 0
    const initialOriginX = initialOrigins.get(group.id)?.x ?? 0

    const myLayout = computeGroupLayout(group.boardIds, bs0.boards)
    const mySlot = groupSlot(group.id, group.boardIds, bs0.boards, initialOriginX, initialOriginY, myLayout)
    // Zone-aware collision: only collide with groups in the timeline zone
    const zly = useCanvasStore.getState().zoneLineY
    const inTimeline = initialOriginY >= zly
    const draggingSet = new Set(draggingIds)
    const obstacles = inTimeline
      ? bs0.groups
          .filter(g => !draggingSet.has(g.id) && g.originY >= zly && !isHiddenDeckMember(g))
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
      let finalDx: number, finalDy: number
      if (mySlot && obstacles.length > 0) {
        const { dx: cdx, dy: cdy } = clampGroupMove(mySlot, preClampX - initialOriginX, preClampY - initialOriginY, obstacles)
        finalDx = cdx
        finalDy = cdy
      } else {
        finalDx = preClampX - initialOriginX
        finalDy = preClampY - initialOriginY
      }
      // Move all dragging groups by the same delta — single batched store update
      const updates = Array.from(initialOrigins, ([gid, origin]) => ({
        groupId: gid, originY: origin.y + finalDy, originX: origin.x + finalDx,
      }))
      useBoardsStore.getState().setGroupPosBatch(updates)
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
  const { screenLeft, screenTop, screenWidth, cardHeight, headerPad, contentCanvasW, contentCanvasH, color } = useMemo(() => {
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
      const rootH = Math.max(...rootBars.map(b => b.height), DEFAULT_H) * bScale
      const visualH = Math.max(rowH, rootH)
      const minX = Math.min(...rootBars.map(b => b.x))
      const maxX = Math.max(...rootBars.map(b => b.x + b.width))
      const left = bx + BOARD_PADDING_X + minX * bScale
      const right = bx + BOARD_PADDING_X + maxX * bScale

      if (left < globalMinX) globalMinX = left
      if (right > globalMaxX) globalMaxX = right
      if (by < topY) topY = by
      if (by + visualH > bottomY) bottomY = by + visualH
    })

    if (globalMinX === Infinity) return { screenLeft: 0, screenTop: 0, screenWidth: 0, cardHeight: 0, headerPad: 0, contentCanvasW: 0, contentCanvasH: 0, color: group.color }

    globalMinX -= 16
    globalMaxX += 16

    const cW = globalMaxX - globalMinX
    const cH = bottomY - topY
    const finalW = Math.max(cW, group.cardWidthOverride ?? 0)
    const finalH = Math.max(cH, group.cardHeightOverride ?? 0)

    // Extend card top upward to fill behind the timeline header (visual only)
    // Must match NLETimelineHeader's clamped screen height (Math.max(..., 20)) + gap
    const headerExtend = Math.max(NLE_HEADER_CANVAS_H * zoom, 20) + 2 * zoom

    return {
      screenLeft: pan.x + globalMinX * zoom,
      screenTop: pan.y + topY * zoom - headerExtend,
      screenWidth: finalW * zoom,
      cardHeight: finalH * zoom + headerExtend,
      headerPad: headerExtend,
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
    const startH = (cardHeight - headerPad) / zoom  // exclude header extension from canvas-space height

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
  }, [group.id, screenWidth, cardHeight, headerPad, contentCanvasW, contentCanvasH, zoom])

  if (screenWidth === 0) return null
  if (screenLeft + screenWidth < 0 || screenTop + cardHeight < 0) return null

  const selFx = isSelected ? selectionHighlight(color) : null

  return (
    <>
      <div
        data-layer-card={group.id}
        data-nle-card={group.boardIds[0] ?? ''}
        data-group-card="true"
        data-link-drop={`card:${group.id}`}
        data-id={group.id}
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
          border: selFx ? selFx.border : '1.5px solid rgba(255,255,255,0.25)',
          boxShadow: selFx ? selFx.boxShadow : '0 4px 24px rgba(0,0,0,0.4)',
          overflow: 'hidden',
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
        {heroImage && <HeroImageLayer heroImage={heroImage} transform={group.cardHeroTransform} />}
        {/* Content area — offset below header extension */}
        <div style={{ position: 'absolute', top: headerPad, left: 0, right: 0, bottom: 0, overflow: 'hidden', borderRadius: '0 0 12px 12px' }}>
          <GroupCardText groupId={group.id} onCropImage={() => setIsEditingHero(true)} heroImage={heroImage} />
          <div style={{
            position: 'absolute', bottom: 6, left: 8, zIndex: 2,
            color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600,
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {group.cardSummary || `${group.boardIds.length} board${group.boardIds.length !== 1 ? 's' : ''}`}
          </div>
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

      {cardMenu && (
        <CardContextMenu pos={cardMenu} group={group} heroImage={heroImage} onClose={() => setCardMenu(null)} onEditHeroImage={() => setIsEditingHero(true)} />
      )}

      {isEditingHero && heroImage && (
        <HeroImageEditOverlay
          cardRect={{ left: screenLeft, top: screenTop, width: screenWidth, height: cardHeight }}
          heroImage={heroImage}
          initialTransform={group.cardHeroTransform ?? { scale: 1, offsetX: 0, offsetY: 0, flipH: false, flipV: false }}
          onDone={t => {
            useUndoCoordinator.getState().checkpoint()
            useBoardsStore.getState().setGroupCardHeroTransform(group.id, t)
            setIsEditingHero(false)
          }}
          onCancel={() => setIsEditingHero(false)}
        />
      )}
    </>
  )
}

// Wrap in memo so unmoved cards don't re-render every frame during sibling drags.
// The `group` prop reference is preserved by setGroupPosBatch for untouched groups,
// so a shallow prop compare correctly skips them.
const GroupCard = React.memo(GroupCardInner)

// ── Ungrouped board card (free canvas) ──

const UngroupedBoardCardInner: React.FC<{ boardId: string }> = ({ boardId }) => {
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
    // Focus this ungrouped board so Del/Backspace can target it
    useCanvasStore.getState().setFocusedBoard(boardId)
    useBoardsStore.getState().setSelectedGroup(null)
    useBoardsStore.getState().clearAllSelections()
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
  const rawContentH = Math.max(...rootBars.map(b => b.height), DEFAULT_H) * bScale
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
      data-group-card="true"
      data-id={boardId}
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
      {heroImage && <HeroImageLayer heroImage={heroImage} />}
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

const UngroupedBoardCard = React.memo(UngroupedBoardCardInner)

// ── Deck components ──

import { useCardDecks, isHiddenDeckMember, isSubDeckAnchor, type Deck } from '../../hooks/useCardDecks'

/** Expand a set of group IDs to include nested sub-deck members.
 *  Any group whose deckAnchorId points to a member of the set is added (recursively). */
function expandWithNestedMembers(baseIds: string[], allGroups: ProjectGroup[]): string[] {
  const result = new Set(baseIds)
  let added = true
  while (added) {
    added = false
    for (const g of allGroups) {
      if (!result.has(g.id) && g.deckAnchorId && result.has(g.deckAnchorId)) {
        result.add(g.id)
        added = true
      }
    }
  }
  return Array.from(result)
}

/** Stacked deck — only anchor visible, peek tabs behind, badge + controls */
const StackedDeckCardInner: React.FC<{ deck: Deck; anchorGroup: ProjectGroup; isNested?: boolean }> = ({ deck, anchorGroup, isNested }) => {
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const boards = useBoardsStore(s => s.boards)
  const groups = useBoardsStore(s => s.groups)
  const isSelected = useBoardsStore(s => s.selectedGroupIds.includes(anchorGroup.id))
  const [isHovered, setIsHovered] = useState(false)
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number } | null>(null)
  const [isEditingHero, setIsEditingHero] = useState(false)

  // Compute anchor card geometry — identical to GroupCard so it looks exactly the same
  const { screenLeft, screenTop, screenWidth, screenHeight, headerPad } = useMemo(() => {
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
      const rootH = Math.max(...rootBars.map(b => b.height), DEFAULT_H) * bScale
      const visualH = Math.max(rowH, rootH)
      const minX = Math.min(...rootBars.map(b => b.x))
      const maxX = Math.max(...rootBars.map(b => b.x + b.width))
      const left = bx + BOARD_PADDING_X + minX * bScale
      const right = bx + BOARD_PADDING_X + maxX * bScale
      if (left < globalMinX) globalMinX = left
      if (right > globalMaxX) globalMaxX = right
      if (by < topY) topY = by
      if (by + visualH > bottomY) bottomY = by + visualH
    })

    if (globalMinX === Infinity) return { screenLeft: 0, screenTop: 0, screenWidth: 0, screenHeight: 0, headerPad: 0 }
    globalMinX -= 16; globalMaxX += 16
    const cW = globalMaxX - globalMinX, cH = bottomY - topY
    const finalW = Math.max(cW, anchorGroup.cardWidthOverride ?? 0)
    const finalH = Math.max(cH, anchorGroup.cardHeightOverride ?? 0)
    const headerExtend = Math.max(NLE_HEADER_CANVAS_H * zoom, 20) + 2 * zoom
    return {
      screenLeft: pan.x + globalMinX * zoom,
      screenTop: pan.y + topY * zoom - headerExtend,
      screenWidth: finalW * zoom,
      screenHeight: finalH * zoom + headerExtend,
      headerPad: headerExtend,
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

    // Shift+click: toggle multi-selection, no drag
    if (e.shiftKey) {
      useBoardsStore.getState().toggleGroupSelection(anchorGroup.id)
      return
    }

    const bs0 = useBoardsStore.getState()
    const alreadySelected = bs0.selectedGroupIds.includes(anchorGroup.id)
    if (!alreadySelected) {
      bs0.setSelectedGroup(anchorGroup.id)
    }
    useUndoCoordinator.getState().checkpoint()

    // Collect all groups to drag: deck members + other selected groups
    const otherSelected = alreadySelected
      ? bs0.selectedGroupIds.filter(id => !deck.memberIds.includes(id))
      : []

    let lastX = e.clientX
    let lastY = e.clientY
    let dyAccum = 0
    let dxAccum = 0

    // Expand to include nested sub-deck members (hidden groups anchored to any member)
    const allDragIds = expandWithNestedMembers([...deck.memberIds, ...otherSelected], bs0.groups)

    const initialOrigins = new Map<string, { x: number; y: number }>()
    for (const gid of allDragIds) {
      const g = bs0.groups.find(gr => gr.id === gid)
      if (g) initialOrigins.set(gid, { x: g.originX, y: g.originY })
    }

    const anchorOrigin = initialOrigins.get(deck.anchorGroupId)
    const anchorLayout = computeGroupLayout(anchorGroup.boardIds, bs0.boards)
    const mySlot = anchorOrigin
      ? groupSlot(deck.anchorGroupId, anchorGroup.boardIds, bs0.boards, anchorOrigin.x, anchorOrigin.y, anchorLayout)
      : null

    const draggingSet = new Set(allDragIds)
    const zly = useCanvasStore.getState().zoneLineY
    const inTimeline = (anchorOrigin?.y ?? 0) >= zly
    const obstacles = inTimeline
      ? bs0.groups
          .filter(g => !draggingSet.has(g.id) && g.originY >= zly && !isHiddenDeckMember(g))
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

      useBoardsStore.getState().setGroupPosBatch(
        Array.from(initialOrigins, ([gid, origin]) => ({
          groupId: gid, originY: origin.y + finalDy, originX: origin.x + finalDx,
        }))
      )
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [deck.memberIds, deck.anchorGroupId, anchorGroup.id, anchorGroup.boardIds])

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

  // Stacked card outlines — right-side only, max 2 edges to keep primary card wide.
  const PEEK_RIGHT = 3  // px each edge step
  const showCount  = Math.min(secondaryCards.length, 1) // always show max 2 edges (1 = has secondaries)
  const EDGE_RESERVE = showCount >= 1 ? PEEK_RIGHT * 2 + 4 : 0 // space reserved for 2 edges on right
  const cardWidth = screenWidth - EDGE_RESERVE // primary card is slimmer
  const edgeBaseX = cardWidth - 1 // edges start at right edge of slimmed card

  const stackSelFx = isSelected ? selectionHighlight(anchorGroup.color) : null

  return (
    <>
      {/* Hover wrapper — covers card + edges area (all within original bounding box) */}
      <div
        data-group-card="true"
        data-link-drop={`card:${anchorGroup.id}`}
        data-id={anchorGroup.id}
        style={{
          position: 'absolute',
          left: screenLeft,
          top: screenTop,
          width: screenWidth,
          height: screenHeight,
          zIndex: 40,
          pointerEvents: 'all',
        }}
        onPointerEnter={() => setIsHovered(true)}
        onPointerLeave={() => setIsHovered(false)}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setCardMenu({ x: e.clientX, y: e.clientY }) }}
        onWheel={e => {
          e.stopPropagation()
          const f = e.deltaY < 0 ? 1.12 : 1 / 1.12
          let container = (e.currentTarget as HTMLElement).parentElement
          while (container && container.style.overflow !== 'hidden') container = container.parentElement
          const rect = container?.getBoundingClientRect()
          const mx = rect ? e.clientX - rect.left : e.clientX
          const my = rect ? e.clientY - rect.top : e.clientY
          useCanvasStore.getState().zoomAtPoint(f, mx, my)
        }}
      >
        {/* Edge 1 — content-height right edge, beyond card face */}
        {showCount >= 1 && (
          <div
            key="stack-edge-0"
            style={{
              position: 'absolute',
              left: edgeBaseX,
              top: 5,
              width: PEEK_RIGHT + 2,
              height: screenHeight - 10,
              borderRadius: '0 12px 12px 0',
              background: 'transparent',
              borderTop: `2px solid ${edgeColor(anchorGroup.color, 0.6)}`,
              borderRight: `2px solid ${edgeColor(anchorGroup.color, 0.6)}`,
              borderBottom: `2px solid ${edgeColor(anchorGroup.color, 0.6)}`,
              zIndex: 37,
              pointerEvents: 'none',
            }}
          />
        )}
        {/* Edge 2 — 90% of content height, centered */}
        {showCount >= 1 && secondaryCards.length >= 2 && (
          <div
            key="stack-edge-1"
            style={{
              position: 'absolute',
              left: edgeBaseX + PEEK_RIGHT + 1,
              top: screenHeight * 0.05,
              width: PEEK_RIGHT + 2,
              height: screenHeight * 0.9,
              borderRadius: '0 6px 6px 0',
              background: 'transparent',
              borderRight: `2px solid ${edgeColor(anchorGroup.color, 0.42)}`,
              borderTop: 'none',
              borderBottom: 'none',
              borderLeft: 'none',
              zIndex: 36,
              pointerEvents: 'none',
            }}
          />
        )}
        {/* Invisible hit area covering edges — click to fan */}
        {showCount >= 1 && (
          <div
            key="stack-hit-area"
            style={{
              position: 'absolute',
              left: edgeBaseX,
              top: 0,
              width: EDGE_RESERVE + 4,
              height: screenHeight,
              zIndex: 45,
              pointerEvents: 'all',
              cursor: 'pointer',
            }}
            onClick={e => {
              e.stopPropagation()
              useUndoCoordinator.getState().checkpoint()
              useBoardsStore.getState().setDeckState(deck.memberIds, 'fanned')
            }}
            onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}
          />
        )}
        {/* Primary card — front, slightly narrower to fit edges within bounding box */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: cardWidth,
            height: screenHeight,
            borderRadius: 12,
            background: heroImage
              ? `linear-gradient(160deg, ${anchorGroup.color}cc 0%, ${anchorGroup.color}aa 100%)`
              : anchorGroup.color,
            border: stackSelFx ? stackSelFx.border : '1.5px solid rgba(255,255,255,0.25)',
            boxShadow: stackSelFx ? stackSelFx.boxShadow : '0 6px 32px rgba(0,0,0,0.5)',
            overflow: 'hidden',
            cursor: 'grab',
            userSelect: 'none',
          }}
          onPointerDown={onDeckDown}
          onDoubleClick={e => {
            e.stopPropagation()
            useUndoCoordinator.getState().checkpoint()
            // Sub-decks that are currently nested inside a parent cluster → fan.
            // Standalone decks (or sub-decks dragged out) → open.
            const isSubDeck = !!anchorGroup.nestedDeck && !!isNested
            useBoardsStore.getState().setDeckState(deck.memberIds, isSubDeck ? 'fanned' : 'open')
          }}
        >
          {heroImage && <HeroImageLayer heroImage={heroImage} transform={anchorGroup.cardHeroTransform} />}
          {/* Content area — offset below header extension */}
          <div style={{ position: 'absolute', top: headerPad, left: 0, right: 0, bottom: 0, overflow: 'hidden', borderRadius: '0 0 12px 12px' }}>
            <GroupCardText groupId={anchorGroup.id} onCropImage={() => setIsEditingHero(true)} heroImage={heroImage} />
            <div style={{
              position: 'absolute', bottom: 6, left: 8, zIndex: 2,
              color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600,
              textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            }}>
              {anchorGroup.cardSummary || anchorGroup.name}
            </div>
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
      </div>
      {cardMenu && (
        <CardContextMenu
          pos={cardMenu}
          group={anchorGroup}
          heroImage={heroImage}
          deckMemberIds={deck.memberIds}
          deckState={deck.state}
          onClose={() => setCardMenu(null)}
          onEditHeroImage={() => setIsEditingHero(true)}
        />
      )}
      {isEditingHero && heroImage && (
        <HeroImageEditOverlay
          cardRect={{ left: screenLeft, top: screenTop, width: screenWidth, height: screenHeight }}
          heroImage={heroImage}
          initialTransform={anchorGroup.cardHeroTransform ?? { scale: 1, offsetX: 0, offsetY: 0, flipH: false, flipV: false }}
          onDone={t => {
            useUndoCoordinator.getState().checkpoint()
            useBoardsStore.getState().setGroupCardHeroTransform(anchorGroup.id, t)
            setIsEditingHero(false)
          }}
          onCancel={() => setIsEditingHero(false)}
        />
      )}
    </>
  )
}

const StackedDeckCard = React.memo(StackedDeckCardInner)

/** Fanned deck — primary card unchanged, secondary cards as ~40px strips peeking right.
 *  Hover a strip to surface that card fully; mouse away to slide it back. */
const FannedDeckOverlayInner: React.FC<{ deck: Deck; groups: ProjectGroup[] }> = ({ deck, groups }) => {
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const boards = useBoardsStore(s => s.boards)
  const allGroups = useBoardsStore(s => s.groups)
  const isSelected = useBoardsStore(s => s.selectedGroupIds.includes(deck.anchorGroupId))
  const [isHovered, setIsHovered] = useState(false)
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number } | null>(null)
  const [surfacedId, setSurfacedId] = useState<string | null>(null)
  const [isEditingHero, setIsEditingHero] = useState(false)

  const anchorGroup = groups.find(g => g.id === deck.anchorGroupId)
  if (!anchorGroup) return null

  // Compute primary card geometry — identical to GroupCard / StackedDeckCard
  const { screenLeft, screenTop, screenWidth, screenHeight, headerPad } = useMemo(() => {
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
      const rootH = Math.max(...rootBars.map(b => b.height), DEFAULT_H) * bScale
      const visualH = Math.max(rowH, rootH)
      const minX = Math.min(...rootBars.map(b => b.x))
      const maxX = Math.max(...rootBars.map(b => b.x + b.width))
      const left = bx + BOARD_PADDING_X + minX * bScale
      const right = bx + BOARD_PADDING_X + maxX * bScale
      if (left < globalMinX) globalMinX = left
      if (right > globalMaxX) globalMaxX = right
      if (by < topY) topY = by
      if (by + visualH > bottomY) bottomY = by + visualH
    })

    if (globalMinX === Infinity) return { screenLeft: 0, screenTop: 0, screenWidth: 0, screenHeight: 0, headerPad: 0 }
    globalMinX -= 16; globalMaxX += 16
    const cW = globalMaxX - globalMinX, cH = bottomY - topY
    const finalW = Math.max(cW, anchorGroup.cardWidthOverride ?? 0)
    const finalH = Math.max(cH, anchorGroup.cardHeightOverride ?? 0)
    const headerExtend = Math.max(NLE_HEADER_CANVAS_H * zoom, 20) + 2 * zoom
    return {
      screenLeft: pan.x + globalMinX * zoom,
      screenTop: pan.y + topY * zoom - headerExtend,
      screenWidth: finalW * zoom,
      screenHeight: finalH * zoom + headerExtend,
      headerPad: headerExtend,
    }
  }, [anchorGroup, boards, pan, zoom])

  if (screenWidth === 0) return null

  // Secondary groups (non-anchor members)
  const secondaryCards = useMemo(() => {
    return deck.memberIds
      .filter(id => id !== anchorGroup.id)
      .map(id => {
        const g = groups.find(gr => gr.id === id)
        if (!g) return null
        return g
      })
      .filter(Boolean) as ProjectGroup[]
  }, [deck.memberIds, anchorGroup.id, groups])

  const FAN_STRIP_WIDTH = 40 // px visible per secondary card strip
  const totalFanWidth = screenWidth + secondaryCards.length * FAN_STRIP_WIDTH

  const fanSelFx = isSelected ? selectionHighlight(anchorGroup.color) : null

  // Hero image for anchor
  const heroImage = (() => {
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
  })()

  // Drag entire fan — move all members together. Click (no drag) → stack.
  const onFanDragDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()

    // Shift+click: toggle multi-selection, no drag
    if (e.shiftKey) {
      useBoardsStore.getState().toggleGroupSelection(anchorGroup.id)
      return
    }

    const bs0 = useBoardsStore.getState()
    const alreadySelected = bs0.selectedGroupIds.includes(anchorGroup.id)
    if (!alreadySelected) {
      bs0.setSelectedGroup(anchorGroup.id)
    }
    useUndoCoordinator.getState().checkpoint()

    // Other selected groups not in this deck
    const otherSelected = alreadySelected
      ? bs0.selectedGroupIds.filter(id => !deck.memberIds.includes(id))
      : []

    const fanStartX = e.clientX
    const fanStartY = e.clientY
    let lastX = e.clientX
    let lastY = e.clientY
    let dyAccum = 0
    let dxAccum = 0
    let fanMoved = false

    // Expand to include nested sub-deck members
    const allDragIds = expandWithNestedMembers([...deck.memberIds, ...otherSelected], bs0.groups)

    const initialOrigins = new Map<string, { x: number; y: number }>()
    for (const gid of allDragIds) {
      const g = bs0.groups.find(gr => gr.id === gid)
      if (g) initialOrigins.set(gid, { x: g.originX, y: g.originY })
    }
    const anchorOrigin = initialOrigins.get(deck.anchorGroupId)

    const zly = useCanvasStore.getState().zoneLineY
    const inTimeline = (anchorOrigin?.y ?? 0) >= zly
    const draggingSet = new Set(allDragIds)
    const anchorLayout = computeGroupLayout(anchorGroup.boardIds, bs0.boards)
    const mySlot = anchorOrigin
      ? groupSlot(deck.anchorGroupId, anchorGroup.boardIds, bs0.boards, anchorOrigin.x, anchorOrigin.y, anchorLayout)
      : null
    const obstacles = inTimeline
      ? bs0.groups
          .filter(g => !draggingSet.has(g.id) && g.originY >= zly && !isHiddenDeckMember(g))
          .map(g => groupSlot(g.id, g.boardIds, bs0.boards, g.originX, g.originY, computeGroupLayout(g.boardIds, bs0.boards)))
          .filter(Boolean) as import('../../utils/nlePush').GroupSlot[]
      : []

    const onMove = (ev: PointerEvent) => {
      if (!fanMoved && Math.abs(ev.clientX - fanStartX) + Math.abs(ev.clientY - fanStartY) > 5) fanMoved = true
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

      useBoardsStore.getState().setGroupPosBatch(
        Array.from(initialOrigins, ([gid, origin]) => ({
          groupId: gid, originY: origin.y + finalDy, originX: origin.x + finalDx,
        }))
      )
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!fanMoved) {
        useBoardsStore.getState().setDeckState(deck.memberIds, 'stacked')
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [deck.memberIds, deck.anchorGroupId, anchorGroup.id, anchorGroup.boardIds])

  // Drag a single card out of the fan (30px threshold to pull out)
  const onStripDown = useCallback((e: React.PointerEvent, groupId: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()

    const startX = e.clientX
    const startY = e.clientY
    const bs0 = useBoardsStore.getState()
    const g0 = bs0.groups.find(gr => gr.id === groupId)
    const initX = g0?.originX ?? 0
    const initY = g0?.originY ?? 0
    let dragged = false

    const onMove = (ev: PointerEvent) => {
      const dist = Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY)
      if (dist > 30 && !dragged) {
        dragged = true
        useUndoCoordinator.getState().checkpoint()
        useBoardsStore.getState().setDeckState([groupId], 'open')
      }
      if (dragged) {
        const z = useCanvasStore.getState().zoom
        const dx = (ev.clientX - startX) / z
        const dy = (ev.clientY - startY) / z
        useBoardsStore.getState().setGroupPos(groupId, initY + dy, initX + dx)
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  // When a secondary card is surfaced, render it full-size on top
  const surfacedGroup = surfacedId ? groups.find(g => g.id === surfacedId) : null
  const surfacedHero = useMemo(() => {
    if (!surfacedGroup) return null
    if (surfacedGroup.cardHeroImage) return surfacedGroup.cardHeroImage
    for (const bid of surfacedGroup.boardIds) {
      const board = boards[bid]
      if (!board) continue
      for (const rid of board.rootIds) {
        const img = getFirstImageUrl(board.bars[rid]?.content)
        if (img) return img
      }
    }
    return null
  }, [surfacedGroup, boards])

  return (
    <>
      {/* Single hover wrapper — primary card + strips + controls */}
      <div
      data-group-card="true"
      data-link-drop={`card:${anchorGroup.id}`}
      data-id={anchorGroup.id}
      style={{
        position: 'absolute',
        left: screenLeft,
        top: screenTop,
        width: totalFanWidth,
        height: screenHeight,
        zIndex: 50,
        pointerEvents: 'all',
      }}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => { setIsHovered(false); setSurfacedId(null) }}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setCardMenu({ x: e.clientX, y: e.clientY }) }}
      onWheel={e => {
        e.stopPropagation()
        const f = e.deltaY < 0 ? 1.12 : 1 / 1.12
        let container = (e.currentTarget as HTMLElement).parentElement
        while (container && container.style.overflow !== 'hidden') container = container.parentElement
        const rect = container?.getBoundingClientRect()
        const mx = rect ? e.clientX - rect.left : e.clientX
        const my = rect ? e.clientY - rect.top : e.clientY
        useCanvasStore.getState().zoomAtPoint(f, mx, my)
      }}
    >
      {/* Secondary card strips — 40px each, peeking right of primary */}
      {secondaryCards.map((sc, i) => {
        const stripX = screenWidth + FAN_STRIP_WIDTH * i
        const isSurfaced = sc.id === surfacedId

        const scHero = (() => {
          if (sc.cardHeroImage) return sc.cardHeroImage
          for (const bid of sc.boardIds) {
            const board = boards[bid]
            if (!board) continue
            for (const rid of board.rootIds) {
              const img = getFirstImageUrl(board.bars[rid]?.content)
              if (img) return img
            }
          }
          return null
        })()

        const isSubDeck = isSubDeckAnchor(sc.id, allGroups)

        return (
          <div
            key={sc.id}
            style={{
              position: 'absolute',
              left: stripX,
              top: 0,
              width: FAN_STRIP_WIDTH,
              height: screenHeight,
              borderRadius: '0 8px 8px 0',
              background: scHero
                ? `linear-gradient(160deg, ${sc.color}cc 0%, ${sc.color}aa 100%)`
                : sc.color || '#5b8dd9',
              borderRight: '1px solid rgba(255,255,255,0.2)',
              borderTop: '1px solid rgba(255,255,255,0.12)',
              borderBottom: '1px solid rgba(255,255,255,0.12)',
              overflow: 'visible',
              zIndex: 2 + secondaryCards.length - i, // behind primary but ordered among strips
              cursor: 'pointer',
              userSelect: 'none',
              pointerEvents: 'all',
              transition: 'opacity 0.15s',
              opacity: isSurfaced ? 0.4 : 1,
            }}
            onPointerEnter={() => setSurfacedId(sc.id)}
            onPointerLeave={() => setSurfacedId(prev => prev === sc.id ? null : prev)}
            onPointerDown={e => onStripDown(e, sc.id)}
          >
            {scHero && (
              <div style={{
                position: 'absolute', inset: 0,
                backgroundImage: `url(${scHero})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                opacity: 0.7,
                borderRadius: '0 8px 8px 0',
              }} />
            )}
            {/* Vertical name label along the strip */}
            <div style={{
              position: 'absolute', top: 8, left: 4, right: 4, bottom: 8,
              writingMode: 'vertical-rl', textOrientation: 'mixed',
              color: 'rgba(255,255,255,0.85)', fontSize: 10, fontWeight: 600,
              textShadow: '0 1px 3px rgba(0,0,0,0.8)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            }}>
              {sc.name}
            </div>
            {/* Sub-deck indicator — horizontal tab above the strip with tapering edges */}
            {isSubDeck && (
              <div style={{
                position: 'absolute',
                left: 0, bottom: '100%',
                width: FAN_STRIP_WIDTH,
                height: 18,
                pointerEvents: 'none',
              }}>
                {/* Edge 1: full width, bright, rounded top */}
                <div style={{
                  position: 'absolute',
                  left: 0, bottom: 0,
                  width: '100%', height: 5,
                  borderTop: '2px solid rgba(120,170,255,0.6)',
                  borderLeft: '2px solid rgba(120,170,255,0.6)',
                  borderRight: '2px solid rgba(120,170,255,0.6)',
                  borderRadius: '6px 6px 0 0',
                }} />
                {/* Edge 2: 80% width centered, medium */}
                <div style={{
                  position: 'absolute',
                  left: '10%', bottom: 5,
                  width: '80%', height: 4,
                  borderTop: '2px solid rgba(130,170,255,0.42)',
                  borderRadius: '4px 4px 0 0',
                }} />
                {/* Edge 3: 50% width centered, faint */}
                <div style={{
                  position: 'absolute',
                  left: '25%', bottom: 9,
                  width: '50%', height: 4,
                  borderTop: '1.5px solid rgba(120,160,255,0.25)',
                  borderRadius: '3px 3px 0 0',
                }} />
                {/* Edge 4: 30% width centered, very faint */}
                <div style={{
                  position: 'absolute',
                  left: '35%', bottom: 13,
                  width: '30%', height: 4,
                  borderTop: '1.5px solid rgba(110,150,255,0.15)',
                  borderRadius: '2px 2px 0 0',
                }} />
              </div>
            )}
          </div>
        )
      })}

      {/* Surfaced card — full-size overlay when hovering a strip.
           Shows the card's own hero image + header/body text (GroupCardText),
           plus the card title at the bottom — same as how primary card renders. */}
      {surfacedGroup && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: screenWidth,
            height: screenHeight,
            borderRadius: 12,
            background: surfacedHero
              ? `linear-gradient(160deg, ${surfacedGroup.color}cc 0%, ${surfacedGroup.color}aa 100%)`
              : surfacedGroup.color,
            border: '2px solid rgba(180,210,255,0.7)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            overflow: 'hidden',
            zIndex: 20,
            pointerEvents: 'none',
            transition: 'opacity 0.12s ease-in',
          }}
        >
          {surfacedHero && <HeroImageLayer heroImage={surfacedHero} transform={surfacedGroup.cardHeroTransform} />}
          {/* Content area — offset below header extension */}
          <div style={{ position: 'absolute', top: headerPad, left: 0, right: 0, bottom: 0, overflow: 'hidden', borderRadius: '0 0 12px 12px' }}>
            <GroupCardText groupId={surfacedGroup.id} />
            <div style={{
              position: 'absolute', bottom: 6, left: 8, zIndex: 2,
              color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600,
              textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            }}>
              {surfacedGroup.cardSummary || surfacedGroup.name}
            </div>
          </div>
          {/* Sub-deck indicator — stacked edges on surfaced card */}
          {isSubDeckAnchor(surfacedGroup.id, allGroups) && (
            <>
              <div style={{
                position: 'absolute',
                right: -5, top: 0, width: 5, height: '100%',
                borderTop: '2px solid rgba(120,170,255,0.6)',
                borderRight: '2px solid rgba(120,170,255,0.6)',
                borderBottom: '2px solid rgba(120,170,255,0.6)',
                borderRadius: '0 8px 8px 0',
                pointerEvents: 'none',
                zIndex: 21,
              }} />
              <div style={{
                position: 'absolute',
                right: -9, top: '3%', width: 4, height: '94%',
                borderRight: '2px solid rgba(130,170,255,0.42)',
                borderRadius: '0 6px 6px 0',
                pointerEvents: 'none',
                zIndex: 21,
              }} />
            </>
          )}
        </div>
      )}

      {/* Primary card — front, identical to open state */}
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
          border: fanSelFx ? fanSelFx.border : '1.5px solid rgba(255,255,255,0.25)',
          boxShadow: fanSelFx ? fanSelFx.boxShadow : '0 6px 32px rgba(0,0,0,0.5)',
          overflow: 'hidden',
          cursor: 'grab',
          userSelect: 'none',
          zIndex: surfacedId ? 5 : 10, // drop below surfaced card when one is active
        }}
        onPointerDown={onFanDragDown}
      >
        {heroImage && <HeroImageLayer heroImage={heroImage} transform={anchorGroup.cardHeroTransform} />}
        {/* Content area — offset below header extension */}
        <div style={{ position: 'absolute', top: headerPad, left: 0, right: 0, bottom: 0, overflow: 'hidden', borderRadius: '0 0 12px 12px' }}>
          <GroupCardText groupId={anchorGroup.id} onCropImage={() => setIsEditingHero(true)} />
          <div style={{
            position: 'absolute', bottom: 6, left: 8, zIndex: 2,
            color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600,
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
          }}>
            {anchorGroup.cardSummary || anchorGroup.name}
          </div>
        </div>
        {/* Badge */}
        {isHovered && (
          <div style={{
            position: 'absolute', top: 6, right: 6, zIndex: 50,
            display: 'flex', gap: 4,
          }}>
            <DeckBadge count={deck.memberIds.length} />
          </div>
        )}
      </div>

    </div>
    {cardMenu && (
      <CardContextMenu
        pos={cardMenu}
        group={anchorGroup}
        heroImage={heroImage}
        deckMemberIds={deck.memberIds}
        deckState={deck.state}
        onClose={() => setCardMenu(null)}
        onEditHeroImage={() => setIsEditingHero(true)}
      />
    )}
    {isEditingHero && heroImage && (
      <HeroImageEditOverlay
        cardRect={{ left: screenLeft, top: screenTop, width: screenWidth, height: screenHeight }}
        heroImage={heroImage}
        initialTransform={anchorGroup.cardHeroTransform ?? { scale: 1, offsetX: 0, offsetY: 0, flipH: false, flipV: false }}
        onDone={t => {
          useUndoCoordinator.getState().checkpoint()
          useBoardsStore.getState().setGroupCardHeroTransform(anchorGroup.id, t)
          setIsEditingHero(false)
        }}
        onCancel={() => setIsEditingHero(false)}
      />
    )}
    </>
  )
}

const FannedDeckOverlay = React.memo(FannedDeckOverlayInner)

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
          onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}>Fan</button>
      )}
      {mode === 'stacked' && onOpen && (
        <button style={btnStyle} onClick={e => { e.stopPropagation(); onOpen() }}
          onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}>Open</button>
      )}
      {mode === 'fanned' && onStack && (
        <button style={btnStyle} onClick={e => { e.stopPropagation(); onStack() }}
          onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}>Stack</button>
      )}
      {mode === 'fanned' && onOpen && (
        <button style={btnStyle} onClick={e => { e.stopPropagation(); onOpen() }}
          onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}>Open</button>
      )}
      {mode === 'affordance' && onStack && (
        <button style={btnStyle} onClick={e => { e.stopPropagation(); onStack() }}
          onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}>Stack</button>
      )}
      {mode === 'affordance' && onFan && (
        <button style={btnStyle} onClick={e => { e.stopPropagation(); onFan() }}
          onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}>Fan</button>
      )}
    </div>
  )
}

/** Compute card screen rect using the same geometry as GroupCard */
export function cardScreenRect(g: ProjectGroup, boards: Record<string, import('../../store/boardsStore').BoardData>, pan: { x: number; y: number }, zoom: number) {
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
    const rootH = Math.max(...rootBars.map(b => b.height), DEFAULT_H) * bScale
    const visualH = Math.max(rowH, rootH)
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
  const headerExtend = Math.max(NLE_HEADER_CANVAS_H * zoom, 20) + 2 * zoom
  return {
    screenLeft: pan.x + gMinX * zoom,
    screenTop: pan.y + topY * zoom - headerExtend,
    screenWidth: finalW * zoom,
    screenHeight: finalH * zoom + headerExtend,
  }
}

/** Affordance shown when open cards are touching — hover on primary shows outline + stack/fan */
const DeckAffordance: React.FC<{ cluster: string[] }> = ({ cluster }) => {
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const [isHovered, setIsHovered] = useState(false)

  // Drag all cluster members together
  const onClusterDragDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    useUndoCoordinator.getState().checkpoint()

    let lastX = e.clientX
    let lastY = e.clientY
    let dyAccum = 0
    let dxAccum = 0

    const bs0 = useBoardsStore.getState()
    // Expand cluster to include hidden sub-deck members
    const allDragIds = expandWithNestedMembers(cluster, bs0.groups)
    const initialOrigins = new Map<string, { x: number; y: number }>()
    for (const gid of allDragIds) {
      const g = bs0.groups.find(gr => gr.id === gid)
      if (g) initialOrigins.set(gid, { x: g.originX, y: g.originY })
    }
    const primaryOrigin = initialOrigins.get(cluster[0])

    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      const dx = (ev.clientX - lastX) / z
      const dy = (ev.clientY - lastY) / z
      lastX = ev.clientX
      lastY = ev.clientY
      dyAccum += dy
      dxAccum += dx

      const anchorInitY = primaryOrigin?.y ?? 0
      const rawY = anchorInitY + dyAccum
      const { y: snapY, snapped } = snapToCardGrid(rawY, CARD_GRID_SPACING, 80)
      const finalDy = (snapped ? snapY : rawY) - anchorInitY
      const finalDx = dxAccum

      useBoardsStore.getState().setGroupPosBatch(
        Array.from(initialOrigins, ([gid, origin]) => ({
          groupId: gid, originY: origin.y + finalDy, originX: origin.x + finalDx,
        }))
      )
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [cluster])

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
          height: primary.screenHeight,
          zIndex: 41,
          pointerEvents: 'all',
          cursor: 'grab',
        }}
        onPointerEnter={() => setIsHovered(true)}
        onPointerLeave={() => setIsHovered(false)}
        onPointerDown={onClusterDragDown}
        onDoubleClick={e => {
          e.stopPropagation()
          useUndoCoordinator.getState().checkpoint()
          useBoardsStore.getState().setDeckState(cluster, 'stacked')
        }}
        onWheel={e => {
          e.stopPropagation()
          const f = e.deltaY < 0 ? 1.12 : 1 / 1.12
          let container = (e.currentTarget as HTMLElement).parentElement
          while (container && container.style.overflow !== 'hidden') container = container.parentElement
          const rect = container?.getBoundingClientRect()
          const mx = rect ? e.clientX - rect.left : e.clientX
          const my = rect ? e.clientY - rect.top : e.clientY
          useCanvasStore.getState().zoomAtPoint(f, mx, my)
        }}
      >
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
  const zoom = useCanvasStore(s => s.zoom)
  const pan = useCanvasStore(s => s.pan)
  // Defer groups/boards so the heavy derived work (deck clustering, ungrouped
  // board-id computation, affordance filtering) runs on idle time during drags.
  // The Overlay's child props (group refs) still come from the urgent `groups`,
  // so the dragged card's position updates without delay.
  const deferredGroups = useDeferredValue(groups)
  const deferredBoards = useDeferredValue(boards)
  const ungroupedIds = useMemo(
    () => getUngroupedBoardIds(deferredGroups, deferredBoards),
    [deferredGroups, deferredBoards]
  )
  const { decks, touchingClusters, getDeckForGroup } = useCardDecks(deferredGroups, deferredBoards, zoneLineY, zoom)

  // Track which groups are rendered by decks so we skip them
  const renderedByDeck = useMemo(() => {
    const set = new Set<string>()
    for (const d of decks) {
      for (const gid of d.memberIds) set.add(gid)
    }
    return set
  }, [decks])

  // Affordance clusters: touching clusters where at least 2 eligible members exist
  // (open cards or visible sub-deck anchors count as eligible)
  const affordanceClusters = useMemo(() => {
    return touchingClusters.filter(cluster => {
      // Skip if this cluster is fully handled by a deck
      const allInDeck = cluster.every(gid => renderedByDeck.has(gid))
      if (allInDeck) return false
      // Show affordance if at least 2 eligible cards are touching
      const eligibleCount = cluster.filter(gid => {
        const g = deferredGroups.find(gr => gr.id === gid)
        if (!g) return false
        const isOpen = !g.deckState || g.deckState === 'open'
        // Visible sub-deck anchors are eligible for parent deck formation
        const isVisibleSubAnchor = !isHiddenDeckMember(g) && isSubDeckAnchor(g.id, deferredGroups)
        // Orphan deck state: group has deckState set but no other groups
        // actually reference it as their anchor — treat it as open so the
        // affordance can re-form it into a real deck with a neighbor.
        const hasRealMembers = deferredGroups.some(other =>
          other.id !== g.id && other.deckAnchorId === g.id
        )
        const isOrphanDeck = !isOpen && !isVisibleSubAnchor && !hasRealMembers
        return isOpen || isVisibleSubAnchor || isOrphanDeck
      }).length
      return eligibleCount >= 2
    })
  }, [touchingClusters, renderedByDeck, deferredGroups])

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} onPointerDown={startOverlayPan}>
      {groups.map(g => {
        // Hard gate: if this group is a non-anchor member of any deck, hide it completely.
        // This uses the persisted deckAnchorId — no spatial clustering needed.
        if (g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id) {
          return null
        }

        const deck = getDeckForGroup(g.id)

        // If anchor of a stacked deck → render StackedDeckCard
        if (deck?.state === 'stacked' && deck.anchorGroupId === g.id) {
          // isNested = this deck's anchor is in a touching cluster with cards outside the deck
          const nested = touchingClusters.some(c =>
            c.includes(g.id) && c.some(cid => !deck.memberIds.includes(cid))
          )
          return (
            <Fragment key={g.id}>
              <NLETimelineHeader groupId={g.id} rightInset={deck.memberIds.length > 1 ? 10 : 0} />
              <StackedDeckCard deck={deck} anchorGroup={g} isNested={nested} />
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

      {/* ── Deck-linking layer: chip rails + parented ghost tree ── */}
      {groups.map(g => {
        // Skip hidden deck members — they aren't visible so they shouldn't
        // render chip rails either.
        if (g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id) {
          return null
        }
        const rect = cardScreenRect(g, boards, pan, zoom)
        if (!rect) return null
        return <CardLinkingLayer key={g.id} group={g} rect={rect} />
      })}
    </div>
  )
}

// ── Per-card chip rails + clone expansion tree ─────────────────────────

const CardLinkingLayer: React.FC<{
  group: ProjectGroup
  rect: { screenLeft: number; screenTop: number; screenWidth: number; screenHeight: number }
}> = ({ group, rect }) => {
  const expandedPaths = useLinkingStore(s => s.expandedPaths)
  const zoom = useCanvasStore(s => s.zoom)

  const hostRect = {
    left: rect.screenLeft,
    top: rect.screenTop,
    width: rect.screenWidth,
    height: rect.screenHeight,
  }

  // Same scale ratio the card text uses, so chips scale with the card.
  // Min clamp prevents chips disappearing at very low zoom.
  const textScale = Math.max(zoom / 0.18, 0.25)

  // Find any chips of THIS card whose clone is currently expanded (paths of
  // length 2 that start with this group id).
  const expandedChildIds: string[] = []
  const linkedIds = group.linkedGroupIds ?? []
  for (const gid of linkedIds) {
    if (expandedPaths.has([group.id, gid].join('>'))) expandedChildIds.push(gid)
  }

  return (
    <>
      <PrimaryChipRail
        groupId={group.id}
        hostRect={hostRect}
        path={[group.id]}
        scale={textScale}
      />
      <BackRefChipRail
        groupId={group.id}
        hostRect={hostRect}
        scale={textScale}
      />
      {expandedChildIds.map((cid, i) => (
        <CloneDeck
          key={cid}
          targetGroupId={cid}
          hostRect={hostRect}
          path={[group.id, cid]}
          childIndex={i}
          hostGroupId={group.id}
        />
      ))}
    </>
  )
}

// ── Card-level independent text with full formatting (header + body) ──

// Shared helpers for card text styling
const cardTextareaStyle = (ts: TextStyle, bg: string): React.CSSProperties => ({
  width: '100%', padding: 6, boxSizing: 'border-box',
  background: bg || 'transparent',
  color: ts.color, fontSize: ts.fontSize, lineHeight: ts.lineHeight ?? 1.4,
  fontWeight: ts.fontWeight ?? (ts.bold ? 700 : 400), fontStyle: ts.italic ? 'italic' : 'normal',
  textAlign: ts.align,
  letterSpacing: ts.letterSpacing ?? 0,
  textTransform: ts.textTransform ?? 'none',
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
  color: ts.color, fontSize: ts.fontSize, lineHeight: ts.lineHeight ?? 1.4,
  fontWeight: ts.fontWeight ?? (ts.bold ? 700 : 400), fontStyle: ts.italic ? 'italic' : 'normal',
  textAlign: ts.align, fontFamily: ts.fontFamily || 'inherit',
  letterSpacing: ts.letterSpacing ?? 0,
  textTransform: ts.textTransform ?? 'none',
  overflow: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  textShadow: hasText ? '0 1px 3px rgba(0,0,0,0.8)' : 'none',
  cursor: 'text',
})

/** Draggable divider between header and body text areas */
const TextSplitDivider: React.FC<{
  ratio: number
  onRatioChange: (r: number) => void
  visible: boolean
}> = ({ ratio, onRatioChange, visible }) => {
  const zoom = useCanvasStore(s => s.zoom)
  const [dragging, setDragging] = useState(false)
  const [hovered, setHovered] = useState(false)

  const onDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    setDragging(true)
    const parent = (e.currentTarget as HTMLElement).parentElement
    if (!parent) return
    const parentRect = parent.getBoundingClientRect()
    const parentH = parentRect.height

    const onMove = (ev: PointerEvent) => {
      const localY = ev.clientY - parentRect.top
      const newRatio = Math.max(0.1, Math.min(0.9, localY / parentH))
      onRatioChange(newRatio)
    }
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [onRatioChange])

  if (!visible && !dragging) return null

  // CardLayer renders in screen space (overlay) — use fixed pixel sizes
  const lineBg = dragging ? 'rgba(100,160,255,0.9)' : hovered ? 'rgba(100,160,255,0.7)' : 'rgba(130,180,255,0.4)'
  const zoneBg = dragging ? 'rgba(100,160,255,0.15)' : hovered ? 'rgba(100,160,255,0.12)' : 'transparent'
  return (
    <div
      style={{
        padding: '4px 6px',
        cursor: 'row-resize',
        pointerEvents: 'auto',
        backgroundColor: zoneBg,
        borderRadius: 4,
        transition: 'background-color 0.15s',
      }}
      onPointerDown={onDown}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => { if (!dragging) setHovered(false) }}
    >
      <div style={{
        height: dragging ? 3 : 2,
        borderRadius: 2,
        backgroundColor: lineBg,
        transition: 'background-color 0.15s',
      }} />
    </div>
  )
}

export const GroupCardText: React.FC<{ groupId: string; onCropImage?: () => void; heroImage?: string | null }> = ({ groupId, onCropImage, heroImage: heroImageProp }) => {
  const zoom = useCanvasStore(s => s.zoom)
  const group = useBoardsStore(s => s.groups.find(g => g.id === groupId))
  const heroImage = heroImageProp ?? group?.cardHeroImage ?? null
  const heroTransform = group?.cardHeroTransform
  const bodyText = group?.cardText ?? ''
  const rawBodyStyle = group?.cardTextStyle
  const bodyTs: TextStyle = useMemo(() => ({ ...DEFAULT_BODY_STYLE, ...rawBodyStyle }), [rawBodyStyle])

  const headerText = group?.cardHeaderText ?? ''
  const rawHeaderStyle = group?.cardHeaderTextStyle
  const headerTs: TextStyle = useMemo(() => ({ ...DEFAULT_HEADER_STYLE, ...rawHeaderStyle }), [rawHeaderStyle])
  const splitRatio = group?.textSplitRatio ?? 0.5
  ensureFontLoaded(headerTs.fontFamily); ensureFontLoaded(bodyTs.fontFamily)
  // Text locked to card — scales proportionally with the card (no screen-size compensation)
  const CARD_MAX_ZOOM = 0.18
  const textScale = zoom / CARD_MAX_ZOOM

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

  // Handler passed to the format toolbar when the user clicks H / P.
  // Commits the current field's buffer immediately (without waiting for the
  // activeField effect) so toolbar-driven switches never drop typed text.
  const handleToolbarFieldChange = useCallback((newField: TextFieldMode) => {
    if (newField === activeField) return
    if (editingField === 'header' && newField !== 'header') {
      useBoardsStore.getState().setGroupCardHeaderText(groupId, headerVal)
    } else if (editingField === 'body' && newField !== 'body') {
      useBoardsStore.getState().setGroupCardText(groupId, bodyVal)
    }
    setActiveField(newField)
  }, [activeField, editingField, headerVal, bodyVal, groupId])

  // Called when the toolbar's outside-click handler fires — a click on empty
  // canvas should unwind all editing state in one shot: commit pending buffer,
  // drop the toolbar, exit edit mode, deselect.
  const exitEditing = useCallback(() => {
    if (editingField === 'header') {
      useBoardsStore.getState().setGroupCardHeaderText(groupId, headerVal)
    } else if (editingField === 'body') {
      useBoardsStore.getState().setGroupCardText(groupId, bodyVal)
    }
    setEditingField(null)
    setSelected(false)
  }, [editingField, headerVal, bodyVal, groupId])

  React.useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const handler = () => startEditHeader()
    el.addEventListener('start-edit', handler)
    return () => el.removeEventListener('start-edit', handler)
  }, [startEditHeader])

  React.useEffect(() => {
    if (!selected) return
    if (activeField === 'header' && editingField !== 'header') {
      // Commit the outgoing field before switching so typed text isn't lost
      if (editingField === 'body') useBoardsStore.getState().setGroupCardText(groupId, bodyVal)
      startEditHeader()
    } else if (activeField === 'body' && editingField !== 'body') {
      if (editingField === 'header') useBoardsStore.getState().setGroupCardHeaderText(groupId, headerVal)
      startEditBody()
    }
  }, [activeField]) // eslint-disable-line react-hooks/exhaustive-deps

  // On unmount, flush any in-progress edit so leaving the card never loses text
  React.useEffect(() => {
    return () => {
      if (editingFieldRef.current === 'header') {
        useBoardsStore.getState().setGroupCardHeaderText(groupId, headerValRef.current)
      } else if (editingFieldRef.current === 'body') {
        useBoardsStore.getState().setGroupCardText(groupId, bodyValRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refs mirror the latest values so the unmount cleanup has them
  const editingFieldRef = useRef(editingField)
  const headerValRef = useRef(headerVal)
  const bodyValRef = useRef(bodyVal)
  React.useEffect(() => { editingFieldRef.current = editingField }, [editingField])
  React.useEffect(() => { headerValRef.current = headerVal }, [headerVal])
  React.useEffect(() => { bodyValRef.current = bodyVal }, [bodyVal])

  return (
    <div ref={wrapperRef} data-card-text style={{ position: 'absolute', inset: 0, zIndex: 1, transform: `scale(${textScale})`, transformOrigin: 'top left', width: `${100 / textScale}%`, height: `${100 / textScale}%` }}>
      {selected && (
        <TextFormatToolbar
          headerStyle={headerTs}
          bodyStyle={bodyTs}
          onHeaderStyleChange={style => useBoardsStore.getState().setGroupCardHeaderTextStyle(groupId, style)}
          onBodyStyleChange={style => useBoardsStore.getState().setGroupCardTextStyle(groupId, style)}
          activeField={activeField}
          onActiveFieldChange={handleToolbarFieldChange}
          onClose={exitEditing}
          anchorRect={rect}
          preferBelow
          heroImage={heroImage}
          heroFlipH={heroTransform?.flipH}
          heroFlipV={heroTransform?.flipV}
          heroOpacity={heroTransform?.opacity}
          onFlipH={() => {
            useUndoCoordinator.getState().checkpoint()
            const cur = useBoardsStore.getState().groups.find(g => g.id === groupId)?.cardHeroTransform ?? { scale: 1, offsetX: 0, offsetY: 0, flipH: false, flipV: false }
            useBoardsStore.getState().setGroupCardHeroTransform(groupId, { ...cur, flipH: !cur.flipH })
          }}
          onFlipV={() => {
            useUndoCoordinator.getState().checkpoint()
            const cur = useBoardsStore.getState().groups.find(g => g.id === groupId)?.cardHeroTransform ?? { scale: 1, offsetX: 0, offsetY: 0, flipH: false, flipV: false }
            useBoardsStore.getState().setGroupCardHeroTransform(groupId, { ...cur, flipV: !cur.flipV })
          }}
          onHeroOpacityChange={opacity => {
            const cur = useBoardsStore.getState().groups.find(g => g.id === groupId)?.cardHeroTransform ?? { scale: 1, offsetX: 0, offsetY: 0, flipH: false, flipV: false }
            useBoardsStore.getState().setGroupCardHeroTransform(groupId, { ...cur, opacity })
          }}
          onCropImage={onCropImage}
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
        {/* Header area */}
        <div style={{ flex: splitRatio, display: 'flex', flexDirection: 'column', justifyContent: vAlignToJustify(headerTs.vAlign), minHeight: 0, overflow: 'hidden' }}>
          {editingField === 'header' ? (
            <textarea autoFocus value={headerVal} onChange={e => setHeaderVal(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { commitHeader(); setSelected(false) }
                if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); commitHeader(); startEditBody() }
              }}
              onPointerDown={e => e.stopPropagation()}
              onDoubleClick={e => e.stopPropagation()}
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
        {/* Draggable divider */}
        <TextSplitDivider ratio={splitRatio} onRatioChange={r => useBoardsStore.getState().setGroupTextSplitRatio(groupId, r)} visible={selected} />
        {/* Body area */}
        <div style={{ flex: 1 - splitRatio, display: 'flex', flexDirection: 'column', justifyContent: vAlignToJustify(bodyTs.vAlign), minHeight: 0, overflow: 'hidden' }}>
          {editingField === 'body' ? (
            <textarea autoFocus value={bodyVal} onChange={e => setBodyVal(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { commitBody(); setSelected(false) }
                if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); commitBody(); startEditHeader() }
              }}
              onPointerDown={e => e.stopPropagation()}
              onDoubleClick={e => e.stopPropagation()}
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
  const zoom = useCanvasStore(s => s.zoom)
  const bodyText = useBoardsStore(s => s.boards[boardId]?.layers?.card?.text ?? '')
  const rawBodyStyle = useBoardsStore(s => s.boards[boardId]?.layers?.card?.textStyle)
  const bodyTs: TextStyle = useMemo(() => ({ ...DEFAULT_BODY_STYLE, ...rawBodyStyle }), [rawBodyStyle])

  const headerText = useBoardsStore(s => s.boards[boardId]?.layers?.card?.headerText ?? '')
  const rawHeaderStyle = useBoardsStore(s => s.boards[boardId]?.layers?.card?.headerTextStyle)
  const headerTs: TextStyle = useMemo(() => ({ ...DEFAULT_HEADER_STYLE, ...rawHeaderStyle }), [rawHeaderStyle])
  const splitRatio = useBoardsStore(s => s.boards[boardId]?.layers?.card?.textSplitRatio ?? 0.5)
  ensureFontLoaded(headerTs.fontFamily); ensureFontLoaded(bodyTs.fontFamily)
  // Text locked to card — scales proportionally with the card
  const CARD_MAX_ZOOM = 0.18
  const textScale = zoom / CARD_MAX_ZOOM

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

  // Commit on toolbar-driven field switch, synchronously
  const handleToolbarFieldChange = useCallback((newField: TextFieldMode) => {
    if (newField === activeField) return
    if (editingField === 'header' && newField !== 'header') {
      useBoardsStore.getState().setCardHeaderText(boardId, headerVal)
    } else if (editingField === 'body' && newField !== 'body') {
      useBoardsStore.getState().setCardText(boardId, bodyVal)
    }
    setActiveField(newField)
  }, [activeField, editingField, headerVal, bodyVal, boardId])

  // Empty-canvas click = full unwind: commit, drop toolbar, exit edit mode.
  const exitEditing = useCallback(() => {
    if (editingField === 'header') {
      useBoardsStore.getState().setCardHeaderText(boardId, headerVal)
    } else if (editingField === 'body') {
      useBoardsStore.getState().setCardText(boardId, bodyVal)
    }
    setEditingField(null)
    setSelected(false)
  }, [editingField, headerVal, bodyVal, boardId])

  React.useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const handler = () => startEditHeader()
    el.addEventListener('start-edit', handler)
    return () => el.removeEventListener('start-edit', handler)
  }, [startEditHeader])

  React.useEffect(() => {
    if (!selected) return
    if (activeField === 'header' && editingField !== 'header') {
      if (editingField === 'body') useBoardsStore.getState().setCardText(boardId, bodyVal)
      startEditHeader()
    } else if (activeField === 'body' && editingField !== 'body') {
      if (editingField === 'header') useBoardsStore.getState().setCardHeaderText(boardId, headerVal)
      startEditBody()
    }
  }, [activeField]) // eslint-disable-line react-hooks/exhaustive-deps

  // Flush pending edit on unmount so leaving the card never loses text
  const editingFieldRef = useRef(editingField)
  const headerValRef = useRef(headerVal)
  const bodyValRef = useRef(bodyVal)
  React.useEffect(() => { editingFieldRef.current = editingField }, [editingField])
  React.useEffect(() => { headerValRef.current = headerVal }, [headerVal])
  React.useEffect(() => { bodyValRef.current = bodyVal }, [bodyVal])
  React.useEffect(() => {
    return () => {
      if (editingFieldRef.current === 'header') {
        useBoardsStore.getState().setCardHeaderText(boardId, headerValRef.current)
      } else if (editingFieldRef.current === 'body') {
        useBoardsStore.getState().setCardText(boardId, bodyValRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div ref={wrapperRef} data-card-text style={{ position: 'absolute', inset: 0, zIndex: 1, transform: `scale(${textScale})`, transformOrigin: 'top left', width: `${100 / textScale}%`, height: `${100 / textScale}%` }}>
      {selected && (
        <TextFormatToolbar
          headerStyle={headerTs}
          bodyStyle={bodyTs}
          onHeaderStyleChange={style => useBoardsStore.getState().setCardHeaderTextStyle(boardId, style)}
          onBodyStyleChange={style => useBoardsStore.getState().setCardTextStyle(boardId, style)}
          activeField={activeField}
          onActiveFieldChange={handleToolbarFieldChange}
          onClose={exitEditing}
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
        {/* Header area */}
        <div style={{ flex: splitRatio, display: 'flex', flexDirection: 'column', justifyContent: vAlignToJustify(headerTs.vAlign), minHeight: 0, overflow: 'hidden' }}>
          {editingField === 'header' ? (
            <textarea autoFocus value={headerVal} onChange={e => setHeaderVal(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { commitHeader(); setSelected(false) }
                if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); commitHeader(); startEditBody() }
              }}
              onPointerDown={e => e.stopPropagation()}
              onDoubleClick={e => e.stopPropagation()}
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
        {/* Draggable divider */}
        <TextSplitDivider ratio={splitRatio} onRatioChange={r => useBoardsStore.getState().setCardTextSplitRatio(boardId, r)} visible={selected} />
        {/* Body area */}
        <div style={{ flex: 1 - splitRatio, display: 'flex', flexDirection: 'column', justifyContent: vAlignToJustify(bodyTs.vAlign), minHeight: 0, overflow: 'hidden' }}>
          {editingField === 'body' ? (
            <textarea autoFocus value={bodyVal} onChange={e => setBodyVal(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { commitBody(); setSelected(false) }
                if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); commitBody(); startEditHeader() }
              }}
              onPointerDown={e => e.stopPropagation()}
              onDoubleClick={e => e.stopPropagation()}
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
