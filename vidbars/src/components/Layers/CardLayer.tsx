// CardLayer — project/board-group overview (zoom ≤ 0.17)
// Renders one composite card per project group. Each group collapses its
// boards into a single draggable card with a hero image and summary.

import React, { useMemo, useState, useCallback, useRef, useLayoutEffect, useDeferredValue, Fragment } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore, getUngroupedBoardIds } from '../../store/boardsStore'
import type { ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useCardView } from './cardView'
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
import { useMagnetPreviewStore } from '../../store/magnetPreviewStore'
import { updateDeckMagnetPreview, finishDeckMagnetDock } from '../../utils/deckDockDrag'
import { groupHasBrowsableContent } from '../../utils/contentTraversal'
import { FreeCanvas } from '../Canvas/FreeCanvas'
import { Viewport3DLayer } from '../Viewport3D/Viewport3DLayer'
import { NLETimelineHeader, NLE_HEADER_CANVAS_H, headerExtend as computeHeaderExtend, headerScreenH, overviewScale } from '../NLE/NLETimelineHeader'
import { HeroImageLayer } from './HeroImageLayer'
import { HeroImageEditOverlay } from '../UI/HeroImageEditOverlay'
import { getFirstImageUrl } from '../../types/bar'
import { hexToHsl, hslToHex, selectionHighlight } from '../../utils/colorUtils'
import { DrawableSurface } from '../Annotation/DrawableSurface'
import { PenButton } from '../Annotation/PenButton'
import { useSeedHoverFromCursor } from '../../utils/pointerTracker'

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

  // (Deck-tether actions — "Go to deck" and "Check back in" — live on the
  // tether tint stripe in the header, not on the card-body context menu.
  // Right-click that stripe to access them.)

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

  // Placement — the same gesture tiles and panels have. A multi-selection
  // converts together, so "select a few cards and pin them" is one action.
  {
    const bsNow = useBoardsStore.getState()
    const sel = bsNow.selectedGroupIds
    const base = sel.includes(group.id) && sel.length > 1 ? sel : [group.id]
    // A deck pins as ONE object: pinning the anchor takes every member with
    // it, recursively through sub-decks. Leaving members behind would strand
    // them on the canvas as an invisible pile — they are hidden precisely
    // because the anchor represents them.
    const targets = expandWithNestedMembers(base, bsNow.groups)
    const many = targets.length > 1 ? ` (${targets.length})` : ''
    menuItems.push({
      label: group.pin ? `Drop on canvas${many}` : `Pin to screen${many}`,
      icon: group.pin ? '📤' : '📌',
      separator: true,
      action: () => {
        const cs = useCanvasStore.getState()
        useUndoCoordinator.getState().checkpoint()
        useBoardsStore.getState().setGroupPlacement(
          targets, group.pin ? 'canvas' : 'screen', { pan: cs.pan, zoom: cs.zoom })
        onClose()
      },
    })
    if (group.pin) {
      menuItems.push({
        label: 'Set return spot here', icon: '⌖',
        action: () => {
          const cs = useCanvasStore.getState()
          useUndoCoordinator.getState().checkpoint()
          useBoardsStore.getState().rehomePinnedGroup(group.id, { pan: cs.pan, zoom: cs.zoom })
          onClose()
        },
      })
    }
  }

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

/** Canvas-space content — free nodes + 3D viewports visible at all layers */
const Canvas: React.FC = () => <><Viewport3DLayer /><FreeCanvas /></>

// ── Per-group card (screen-space) ──

const GroupCardInner: React.FC<{ group: ProjectGroup }> = ({ group }) => {
  // The live canvas camera, or a frozen one when this card is pinned. All
  // the geometry below is `pan + world * zoom`, so swapping the camera is
  // the whole of what pinning does — see cardView.tsx.
  const { pan, zoom } = useCardView()

  const boards       = useBoardsStore(s => s.boards)
  const isSelected   = useBoardsStore(s => s.selectedGroupIds.includes(group.id))

  const [isDragging, setIsDragging] = useState(false)
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number } | null>(null)
  const [isEditingHero, setIsEditingHero] = useState(false)

  // ── Group drag: move group.originY / group.originX ──
  const onCardDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    // Belt-and-braces: skip drag init if the pointerdown originated on the
    // pen-button affordance (or any descendant of it). The button itself
    // already calls stopPropagation, but this guard catches any event-flow
    // edge case (capture phase, native bubbling, etc).
    if ((e.target as Element).closest('[data-pen-button]')) return
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
    // Magnet gate: only cards whose recursive content holds ≥1 model can
    // dock to a 3D viewport window (a card is a deck of one).
    const canDock = groupHasBrowsableContent(group.id, bs0.groups, bs0.boards)
    // One unified work area — collide with every other visible (non-dragging)
    // group, wherever it sits on the canvas.
    const draggingSet = new Set(draggingIds)
    const obstacles = bs0.groups
      .filter(g => !draggingSet.has(g.id) && !isHiddenDeckMember(g))
      .map(g => groupSlot(g.id, g.boardIds, bs0.boards, g.originX, g.originY, computeGroupLayout(g.boardIds, bs0.boards)))
      .filter(Boolean) as import('../../utils/nlePush').GroupSlot[]

    const onMove = (ev: PointerEvent) => {
      // A PINNED card lives in screen space: its position IS the pin anchor,
      // while originX/originY are the home it returns to. Moving the origin
      // would slide it away from its own anchor — and since the frozen camera
      // is solved FROM the origin, the body would drift while the header held
      // station. That is the "header separates from the body" report.
      if (group.pin) {
        const pdx = ev.clientX - lastX
        const pdy = ev.clientY - lastY
        lastX = ev.clientX
        lastY = ev.clientY
        const bs = useBoardsStore.getState()
        const pinnedDragging = Array.from(initialOrigins.keys())
          .filter(gid => bs.groups.find(g => g.id === gid)?.pin)
        bs.movePinnedGroups(pinnedDragging, pdx, pdy)
        return
      }
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
      updateDeckMagnetPreview(canDock, group.id)
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setIsDragging(false)
      // Drop-on-ghost-slot return: if the card was released over a
      // [data-deck-slot-drop="<anchorId>:<cardId>"] element AND that cardId
      // matches this card, snap it back into the deck.
      let returnedToDeck = false
      const els = document.elementsFromPoint(ev.clientX, ev.clientY)
      for (const el of els) {
        const drop = (el as HTMLElement).dataset?.deckSlotDrop
        if (!drop) continue
        const [, memberId] = drop.split(':')
        if (memberId === group.id) {
          useBoardsStore.getState().returnToDeck(group.id)
          returnedToDeck = true
        }
        break
      }
      // Magnet dock to a 3D viewport window (deck return outranks docking)
      if (!returnedToDeck) {
        finishDeckMagnetDock(canDock, group.id, group.id, draggingIds)
      } else {
        useMagnetPreviewStore.getState().setPreview(null)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [group.id])

  const [isHovered, setIsHovered] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  // Seed hover state if the cursor is already over this card when it mounts
  // (covers zoom-layer transitions where the card swaps in under a static
  // cursor — pointerenter wouldn't fire otherwise).
  useSeedHoverFromCursor(cardRef, setIsHovered)

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

    // Card visual bounds match the content exactly. Collision/push and deck
    // clustering use separate padded bounds (useCardDecks / nlePush).

    const cW = globalMaxX - globalMinX
    const cH = bottomY - topY
    const finalW = Math.max(cW, group.cardWidthOverride ?? 0)
    const finalH = Math.max(cH, group.cardHeightOverride ?? 0)

    // Extend card top upward to fill behind the timeline header (visual only)
    // Must match NLETimelineHeader's clamped screen height (Math.max(..., 20)) + gap
    const headerExtend = computeHeaderExtend(zoom)

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
        ref={cardRef}
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
          // Solid card color regardless of hero presence. Hero renders ON
          // TOP at its own opacity — fading the hero reveals the card
          // color underneath rather than the canvas behind.
          background: color,
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
            color: 'rgba(255,255,255,0.7)', fontSize: 11 * overviewScale(zoom), fontWeight: 600,
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

        {/* ── Annotation layer — body region only (excludes header extension).
                Renders saved cardStrokes always; pointer-event-active only when
                draw mode targets THIS card. */}
        <div style={{
          position: 'absolute',
          top: headerPad, left: 0, right: 0, bottom: 0,
          pointerEvents: 'none',
          borderRadius: '0 0 12px 12px',
          overflow: 'hidden',
        }}>
          <DrawableSurface
            surface={{ kind: 'card', groupId: group.id }}
            width={screenWidth}
            height={Math.max(0, cardHeight - headerPad)}
            strokes={group.cardStrokes ?? []}
          />
        </div>

        {/* Pen toggle — top-right corner of the card BODY (not the header).
                Sits just below the header band; size scales with the timeline
                header's screenHeight so it tracks zoom, slightly LARGER than
                the affordance icon (multiplier 0.85 vs. 0.7) per spec.
                zIndex 60 keeps it above the DrawableSurface that covers the
                same body region, so it remains clickable in or out of draw
                mode. Visible on card hover only (lit-up affordance) — active
                draw mode overrides for the exit-toggle case. */}
        {(() => {
          const screenHeight = headerScreenH(zoom)
          const penSize = Math.min(32, Math.max(8, 16 * overviewScale(zoom), screenHeight * 0.85))
          const PEN_INSET = 6   // distance from right edge and from header band
          return (
            <div
              data-pen-button="true"
              style={{
                position: 'absolute',
                top: headerPad + PEN_INSET,
                right: PEN_INSET,
                zIndex: 60,
                lineHeight: 0,
              }}
            >
              <PenButton
                surface={{ kind: 'card', groupId: group.id }}
                baseColor={color}
                size={penSize}
                visible={isHovered}
              />
            </div>
          )
        })()}
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
/** Exported so PinLayer can render the SAME card with a frozen camera — one
 *  card component, two placements, which is what keeps a pinned card from
 *  drifting into a second implementation. */
export const GroupCard = React.memo(GroupCardInner)

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

  // Card visual bounds match content exactly (no outer padding).
  const screenLeft = pan.x + (cx + BOARD_PADDING_X + minBarX * bScale) * zoom
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
        // Solid card color regardless of hero — hero opacity fades reveal
        // the color underneath, not the canvas.
        background: color,
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
        color: 'rgba(255,255,255,0.7)', fontSize: 11 * overviewScale(zoom), fontWeight: 600,
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

import { useCardDecks, isHiddenDeckMember, isSubDeckAnchor, expandWithNestedMembers, type Deck } from '../../hooks/useCardDecks'

// Placeholder names that carry no authored intention — a card/bar with
// only one of these (and no other content) is NOT counted as meaningful.
const PLACEHOLDER_NAMES = new Set(['', 'untitled', 'new card', 'new block', 'new vidbar'])
const isAuthoredName = (name?: string) =>
  !!name && !PLACEHOLDER_NAMES.has(name.trim().toLowerCase())
const hasText = (s?: string) => !!s && s.trim().length > 0
const barHasImage = (bar: { content?: unknown }) => {
  const c = bar?.content as Record<string, unknown> | undefined
  return !!c && (!!c.imageUrl || !!c.image || !!c.imageTransform)
}

/** Count "meaningful content" across a deck: every authored unit (a
 *  card with text/header/summary/hero/name, a block with a label or
 *  text, a bar with content/image/name) contributes 1 to a single
 *  overall total. An image or even a single word counts — anything
 *  that reflects user intention. Empty placeholders don't.
 *
 *  Recurses through nested sub-decks: a deck's `memberIds` lists only
 *  its TOP-LEVEL members, but a member can itself be a sub-deck anchor
 *  with its own members (and those can nest further). We expand the
 *  id set across the full deckAnchorId tree first, so the total covers
 *  every card/block/bar anywhere inside the deck — not just the front
 *  layer. */
function countMeaningfulContent(
  memberIds: string[],
  groups: ProjectGroup[],
  boards: Record<string, import('../../store/boardsStore').BoardData>,
): number {
  // Expand to all transitive descendants via deckAnchorId.
  const ids = new Set(memberIds)
  let added = true
  while (added) {
    added = false
    for (const g of groups) {
      if (g.deckAnchorId && g.deckAnchorId !== g.id && ids.has(g.deckAnchorId) && !ids.has(g.id)) {
        ids.add(g.id)
        added = true
      }
    }
  }
  let total = 0
  for (const gid of ids) {
    const g = groups.find(gr => gr.id === gid)
    if (!g) continue
    // Card-level intention — counted once per card (matches the
    // "this card means something" read, regardless of how many of
    // its fields are filled).
    const cardMeaningful =
      hasText(g.cardText) || hasText(g.cardHeaderText) || hasText(g.cardSummary) ||
      !!g.cardHeroImage || isAuthoredName(g.name)
    if (cardMeaningful) total += 1
    // Block-level + bar-level intention — counted per board / per bar
    // so a richly developed card scores higher than a one-liner.
    for (const bid of g.boardIds) {
      const board = boards[bid]
      if (!board) continue
      const blk = board.layers?.block
      if (blk && (hasText(blk.text) || hasText(blk.label) || hasText(blk.headerText) || !!blk.thumbnail)) {
        total += 1
      }
      for (const barId of Object.keys(board.bars || {})) {
        const bar = board.bars[barId]
        if (!bar) continue
        if (hasText(bar.content?.text) || barHasImage(bar) || isAuthoredName(bar.name)) {
          total += 1
        }
      }
    }
  }
  return total
}

/** Stacked deck — only anchor visible, peek tabs behind, badge + controls */
const StackedDeckCardInner: React.FC<{ deck: Deck; anchorGroup: ProjectGroup; isNested?: boolean }> = ({ deck, anchorGroup, isNested }) => {
  // Frozen inside a pinned deck — same camera as every other card piece.
  const { pan, zoom } = useCardView()
  const boards = useBoardsStore(s => s.boards)
  const groups = useBoardsStore(s => s.groups)
  const isSelected = useBoardsStore(s => s.selectedGroupIds.includes(anchorGroup.id))
  const [isHovered, setIsHovered] = useState(false)
  const stackedDeckHoverRef = useRef<HTMLDivElement>(null)
  // Seed hover from current cursor position so the pen icon appears
  // immediately when this deck card swaps in across a zoom-layer threshold.
  useSeedHoverFromCursor(stackedDeckHoverRef, setIsHovered)
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
    // Card visual bounds match the content exactly (no outer padding).
    const cW = globalMaxX - globalMinX, cH = bottomY - topY
    const finalW = Math.max(cW, anchorGroup.cardWidthOverride ?? 0)
    const finalH = Math.max(cH, anchorGroup.cardHeightOverride ?? 0)
    const headerExtend = computeHeaderExtend(zoom)
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
    // Don't initiate drag on the pen-button affordance.
    if ((e.target as Element).closest('[data-pen-button]')) return
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
    // Magnet gate: decks with ≥1 model anywhere in their recursive content
    // can dock to a 3D viewport window.
    const canDock = groupHasBrowsableContent(deck.anchorGroupId, bs0.groups, bs0.boards)

    const draggingSet = new Set(allDragIds)
    // One unified work area — collide with every other visible group.
    const obstacles = bs0.groups
      .filter(g => !draggingSet.has(g.id) && !isHiddenDeckMember(g))
      .map(g => groupSlot(g.id, g.boardIds, bs0.boards, g.originX, g.originY, computeGroupLayout(g.boardIds, bs0.boards)))
      .filter(Boolean) as import('../../utils/nlePush').GroupSlot[]

    const onMove = (ev: PointerEvent) => {
      // Pinned deck: screen delta to the pin, exactly as a pinned single card
      // does. Moving the ORIGIN instead is invisible — the frozen camera is
      // solved FROM the origin, so it compensates and the deck appears stuck
      // — while every canvas thing keyed off that origin (ghost slots,
      // affordances, push/collision) shuffles about behind it. That is both
      // "I can't move a pinned deck" and "ghost bits move on the canvas".
      if (anchorGroup.pin) {
        const pdx = ev.clientX - lastX
        const pdy = ev.clientY - lastY
        lastX = ev.clientX
        lastY = ev.clientY
        useBoardsStore.getState().movePinnedGroups(deck.memberIds, pdx, pdy)
        return
      }
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
      updateDeckMagnetPreview(canDock, deck.anchorGroupId)
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      // Drop-on-ghost-slot return for extracted sub-decks rendered as
      // StackedDeckCard: anchor might match a ghost slot on its former parent.
      let returnedToDeck = false
      const els = document.elementsFromPoint(ev.clientX, ev.clientY)
      for (const el of els) {
        const drop = (el as HTMLElement).dataset?.deckSlotDrop
        if (!drop) continue
        const [, memberId] = drop.split(':')
        if (memberId === anchorGroup.id) {
          useBoardsStore.getState().returnToDeck(anchorGroup.id)
          returnedToDeck = true
        }
        break
      }
      // Magnet dock to a 3D viewport window (deck return outranks docking)
      if (!returnedToDeck) {
        finishDeckMagnetDock(canDock, deck.anchorGroupId, deck.anchorGroupId, allDragIds)
      } else {
        useMagnetPreviewStore.getState().setPreview(null)
      }
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
        ref={stackedDeckHoverRef}
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
        onPointerEnter={() => {
          setIsHovered(true)
          // Soft "deck has an affordance" hint — drives a faint glow on the
          // dashed-rect icon in the header. NOT the full open-preview.
          useCanvasStore.getState().setCardHoveredDeckId(deck.id)
        }}
        onPointerLeave={() => {
          setIsHovered(false)
          if (useCanvasStore.getState().cardHoveredDeckId === deck.id) {
            useCanvasStore.getState().setCardHoveredDeckId(null)
          }
        }}
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
            background: anchorGroup.color,
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
              color: 'rgba(255,255,255,0.7)', fontSize: 11 * overviewScale(zoom), fontWeight: 600,
              textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            }}>
              {anchorGroup.cardSummary || anchorGroup.name}
            </div>
          </div>

          {/* ── Card-zoom annotation layer for the deck's primary card.
                  Draws on the anchor group's cardStrokes — same surface as
                  the open card uses, so leaving stack/fan state preserves
                  whatever was drawn. */}
          <div style={{
            position: 'absolute',
            top: headerPad, left: 0, right: 0, bottom: 0,
            pointerEvents: 'none',
            borderRadius: '0 0 12px 12px',
            overflow: 'hidden',
          }}>
            <DrawableSurface
              surface={{ kind: 'card', groupId: anchorGroup.id }}
              width={cardWidth}
              height={Math.max(0, screenHeight - headerPad)}
              strokes={anchorGroup.cardStrokes ?? []}
            />
          </div>

          {/* Pen toggle — top-right corner of body (matches GroupCard).
                See GroupCardInner for sizing/positioning notes. Hover-only. */}
          {(() => {
            const screenHeight = Math.max(NLE_HEADER_CANVAS_H * zoom, 20)
            const penSize = Math.min(32, Math.max(16, screenHeight * 0.85))
            const PEN_INSET = 6
            return (
              <div
                data-pen-button="true"
                style={{
                  position: 'absolute',
                  top: headerPad + PEN_INSET,
                  right: PEN_INSET,
                  zIndex: 60,
                  lineHeight: 0,
                }}
              >
                <PenButton
                  surface={{ kind: 'card', groupId: anchorGroup.id }}
                  baseColor={anchorGroup.color}
                  size={penSize}
                  visible={isHovered}
                />
              </div>
            )
          })()}

          {/* The deck-member count now lives inside the dashed-rect
              affordance in the header (one element, two jobs). */}
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
  // Frozen inside a pinned deck — same camera as every other card piece.
  const { pan, zoom } = useCardView()
  const boards = useBoardsStore(s => s.boards)
  const allGroups = useBoardsStore(s => s.groups)
  const isSelected = useBoardsStore(s => s.selectedGroupIds.includes(deck.anchorGroupId))
  const selectedGhostIds = useCanvasStore(s => s.selectedGhostGroupIds)
  const extractingCardId = useCanvasStore(s => s.extractingCardId)
  const fanTransition = useCanvasStore(s => s.fanTransition)
  const [, setIsHovered] = useState(false)
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number } | null>(null)
  const [surfacedId, setSurfacedId] = useState<string | null>(null)
  const [isEditingHero, setIsEditingHero] = useState(false)

  // Refs to each strip — used for imperative animation when this deck is in
  // an active fan ↔ stack transition. Keyed by strip id (member group id or
  // ghost cardId) so we can map secondaryItems → DOM nodes consistently.
  const stripRefs = useRef(new Map<string, HTMLDivElement>())

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
    // Card visual bounds match the content exactly (no outer padding).
    const cW = globalMaxX - globalMinX, cH = bottomY - topY
    const finalW = Math.max(cW, anchorGroup.cardWidthOverride ?? 0)
    const finalH = Math.max(cH, anchorGroup.cardHeightOverride ?? 0)
    const headerExtend = computeHeaderExtend(zoom)
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
  // Strip items combine real (non-anchor) deck members with the anchor's
  // ghostSlots (extracted cards).
  //
  // Order MUST match StackedDeckCard's secondaryCards (which uses
  // deck.memberIds — sorted by visual rect.left in useCardDecks). Re-sorting
  // by deckOffsetX would diverge from rect.left whenever cards have
  // different board.nleX or differing leftmost-bar offsets, so we sort by
  // each item's effective rect.left instead.
  //
  // For real members we use deck.rects directly. For ghosts (the card is no
  // longer in the deck), we compute the rect.left it WOULD have if it were
  // still slotted, using the card's intact boards plus its snapshotted
  // deckOffsetX. Same formula useCardDecks runs.
  type StripItem =
    | { kind: 'real'; group: ProjectGroup; deckOffsetX: number; sortKey: number }
    | { kind: 'ghost'; cardId: string; card: ProjectGroup | null; deckOffsetX: number; deckOffsetY: number; sortKey: number }
  // (allGroups already subscribed at the top of the component for sub-deck-anchor checks)
  const secondaryItems = useMemo<StripItem[]>(() => {
    // Compute the per-card delta between rect.left and originX. Mirrors the
    // useCardDecks rect formula: l = bx + BOARD_PADDING_X + minX*bScale - 16
    // where bx = originX + (board.nleX ?? 0). Delta is everything except originX.
    const contentLeftOffset = (g: ProjectGroup): number => {
      let leftDelta = Infinity
      for (const bid of g.boardIds) {
        const board = boards[bid]
        if (!board) continue
        const bScale = board.boardScale ?? 1
        const rootBars = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
        if (rootBars.length === 0) continue
        const minX = Math.min(...rootBars.map(b => b.x))
        const delta = (board.nleX ?? 0) + BOARD_PADDING_X + minX * bScale - 16
        if (delta < leftDelta) leftDelta = delta
      }
      return leftDelta === Infinity ? 0 : leftDelta
    }

    const real: StripItem[] = deck.memberIds
      .filter(id => id !== anchorGroup.id)
      .map(id => {
        const g = groups.find(gr => gr.id === id)
        if (!g) return null
        const sortKey = deck.rects.get(id)?.left ?? (anchorGroup.originX + (g.deckOffsetX ?? 0) + contentLeftOffset(g))
        return { kind: 'real' as const, group: g, deckOffsetX: g.deckOffsetX ?? 0, sortKey }
      })
      .filter(Boolean) as StripItem[]
    const ghosts: StripItem[] = (anchorGroup.ghostSlots ?? []).map(s => {
      const card = allGroups.find(g => g.id === s.cardId) ?? null
      // Reconstruct the ghost's would-be rect.left as if the card were still
      // a deck member at slot.deckOffsetX from the anchor.
      const sortKey = anchorGroup.originX + s.deckOffsetX + (card ? contentLeftOffset(card) : 0)
      return {
        kind: 'ghost' as const,
        cardId: s.cardId,
        card,
        deckOffsetX: s.deckOffsetX,
        deckOffsetY: s.deckOffsetY,
        sortKey,
      }
    })
    return [...real, ...ghosts].sort((a, b) => a.sortKey - b.sortKey)
  }, [deck.memberIds, deck.rects, anchorGroup.id, anchorGroup.originX, anchorGroup.ghostSlots, groups, allGroups, boards])

  // Fan-strip geometry is in SCREEN px (this overlay is screen-space), so
  // it normally stays a fixed size while the primary card scales by zoom.
  // Below the comfortable floor that makes the strips balloon relative to
  // the shrunken card. Scale them by overviewScale — identical at/above
  // CARD_FLOOR_ZOOM (0.11), shrinking in lockstep with the card below it —
  // so the whole fan stays proportional when zoomed way out.
  const fanOv = overviewScale(zoom)
  const FAN_STRIP_WIDTH = 40 * fanOv // px visible per secondary card strip
  // How far each strip extends LEFT under the piece in front of it, so the
  // piece in front's rounded outer corner shows the next strip through the
  // curve (and strip 0 merges under the primary card's corner).
  const STRIP_OVERLAP = 12 * fanOv
  const STRIP_RADIUS = 8 * fanOv
  const totalFanWidth = screenWidth + secondaryItems.length * FAN_STRIP_WIDTH

  const fanSelFx = isSelected ? selectionHighlight(anchorGroup.color) : null

  // Strip animation hook: when a fan ↔ stack transition is active for THIS
  // deck, slide each strip out from under the primary card (fanning) or
  // back into it (stacking). useLayoutEffect runs synchronously after DOM
  // mutations and before paint, so the "snap to tucked, then animate to
  // 0" pattern works without a visible flash.
  //
  // Tucked offset is -(i + 1) * FAN_STRIP_WIDTH so EVERY strip — including
  // strip 0 — starts fully behind the primary card and has to slide out
  // by at least one FAN_STRIP_WIDTH to reach its resting position. Each
  // strip lags the previous one by a small stagger for a cascade feel.
  useLayoutEffect(() => {
    const isThisDeck = fanTransition && fanTransition.deckId === anchorGroup.id
    secondaryItems.forEach((item, i) => {
      const key = item.kind === 'real' ? item.group.id : `ghost-${item.cardId}`
      const el = stripRefs.current.get(key)
      if (!el) return
      if (!isThisDeck) {
        el.style.transition = ''
        el.style.transform = ''
        return
      }
      const tuckOffset = -(i + 1) * FAN_STRIP_WIDTH
      // Stagger scales with deck size — small decks (≤5 strips) keep the
      // tight 8ms cascade, larger decks spread out so each strip is
      // individually readable. Capped at 20ms so the longest deck doesn't
      // feel sluggish. Mirrored in boardsStore.setDeckState's clearAfter
      // computation — keep both in sync.
      const N = secondaryItems.length
      const stripStagger = Math.max(8, Math.min(20, Math.floor(N * 1.5)))
      const stagger = i * stripStagger
      if (fanTransition!.phase === 'fanning') {
        el.style.transition = 'none'
        el.style.transform = `translateX(${tuckOffset}px)`
        void el.offsetWidth
        el.style.transition = `transform 0.1s cubic-bezier(0.16, 1, 0.3, 1) ${stagger}ms`
        el.style.transform = 'translateX(0)'
      } else {
        el.style.transition = `transform 0.09s cubic-bezier(0.4, 0, 0.6, 1) ${stagger}ms`
        el.style.transform = `translateX(${tuckOffset}px)`
      }
    })
  }, [fanTransition, anchorGroup.id, secondaryItems])

  // Refs to the two portal-connector bars so the transition effect can
  // animate their width in lockstep with the locked strip's slide.
  // lockedStripIdx is computed below, after portalMemberId is read.
  const connectorRefs = useRef<{ top: HTMLDivElement | null; bottom: HTMLDivElement | null }>({ top: null, bottom: null })

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

    const draggingSet = new Set(allDragIds)
    const anchorLayout = computeGroupLayout(anchorGroup.boardIds, bs0.boards)
    const mySlot = anchorOrigin
      ? groupSlot(deck.anchorGroupId, anchorGroup.boardIds, bs0.boards, anchorOrigin.x, anchorOrigin.y, anchorLayout)
      : null
    // One unified work area — collide with every other visible group.
    const obstacles = bs0.groups
      .filter(g => !draggingSet.has(g.id) && !isHiddenDeckMember(g))
      .map(g => groupSlot(g.id, g.boardIds, bs0.boards, g.originX, g.originY, computeGroupLayout(g.boardIds, bs0.boards)))
      .filter(Boolean) as import('../../utils/nlePush').GroupSlot[]

    const onMove = (ev: PointerEvent) => {
      if (!fanMoved && Math.abs(ev.clientX - fanStartX) + Math.abs(ev.clientY - fanStartY) > 5) fanMoved = true
      // Pinned fan: screen delta to the pin — see the stacked-deck handler.
      if (anchorGroup.pin) {
        const pdx = ev.clientX - lastX
        const pdy = ev.clientY - lastY
        lastX = ev.clientX
        lastY = ev.clientY
        useBoardsStore.getState().movePinnedGroups(deck.memberIds, pdx, pdy)
        return
      }
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
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!fanMoved) {
        useBoardsStore.getState().setDeckState(deck.memberIds, 'stacked')
        return
      }
      // Drop-on-ghost-slot return for extracted fanned sub-decks.
      const els = document.elementsFromPoint(ev.clientX, ev.clientY)
      for (const el of els) {
        const drop = (el as HTMLElement).dataset?.deckSlotDrop
        if (!drop) continue
        const [, memberId] = drop.split(':')
        if (memberId === anchorGroup.id) {
          useBoardsStore.getState().returnToDeck(anchorGroup.id)
        }
        break
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [deck.memberIds, deck.anchorGroupId, anchorGroup.id, anchorGroup.boardIds])

  // Drag a single card out of the fan (30px threshold to pull out).
  // On threshold cross, calls extractFromDeck — the card becomes free on
  // canvas and the parent gets a ghostSlots entry remembering the slot.
  // The card is positioned so the cursor lands ~10px inside its top-right
  // corner (we're "pulling it out" by the right edge of the strip).
  const onStripDown = useCallback((e: React.PointerEvent, groupId: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    // Clear any stale surfaced-strip state from the hover that immediately
    // preceded this click. Otherwise the primary card drops to z=5 during
    // the pre-threshold window and strip 0 (at z=N+1) sits in front of it
    // for the few frames before extraction kicks in.
    setSurfacedId(null)

    const startX = e.clientX
    const startY = e.clientY
    // Snapshot at pointer-down so cursor offset is stable through zoom.
    const bs0 = useBoardsStore.getState()
    const cs0 = useCanvasStore.getState()
    const z0 = cs0.zoom || 1
    const g0 = bs0.groups.find(gr => gr.id === groupId)
    if (!g0) return
    const rect = cardScreenRect(g0, bs0.boards, cs0.pan, z0)
    if (!rect) return
    // Visual edges relative to origin (varies per card due to bar layout).
    const visualLeftCanvas = (rect.screenLeft - cs0.pan.x) / z0
    const visualTopCanvas  = (rect.screenTop  - cs0.pan.y) / z0
    const widthCanvas      = rect.screenWidth / z0
    const deltaX = visualLeftCanvas - g0.originX
    const deltaY = visualTopCanvas  - g0.originY
    // Cursor's Y offset from the strip's visual top at pointer-down.
    const stripEl = e.currentTarget as HTMLElement
    const stripRect = stripEl.getBoundingClientRect()
    const vOffsetCanvas = (startY - stripRect.top) / z0
    // Grab-point: cursor lands ~1/3 of the way in from the card's left
    // edge. Pulling-from-the-strip-edge feels unnatural — the user expects
    // to be holding the card by its body, not pinching its corner.
    // 2/3 from the right == 1/3 from the left.
    const rightInsetCanvas = widthCanvas * (2 / 3)
    let dragged = false

    const computeOrigin = (clientX: number, clientY: number) => {
      const cs = useCanvasStore.getState()
      const cursorCanvasX = (clientX - cs.pan.x) / cs.zoom
      const cursorCanvasY = (clientY - cs.pan.y) / cs.zoom
      return {
        originX: cursorCanvasX - deltaX - widthCanvas + rightInsetCanvas,
        originY: cursorCanvasY - deltaY - vOffsetCanvas,
      }
    }

    const onMove = (ev: PointerEvent) => {
      const dist = Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY)
      if (dist > 8 && !dragged) {
        dragged = true
        useUndoCoordinator.getState().checkpoint()
        const { originX, originY } = computeOrigin(ev.clientX, ev.clientY)
        useBoardsStore.getState().extractFromDeck(groupId, originX, originY)
        // Hand off rendering of this card to the fan wrapper at strip
        // z-index, so it slides out from between the layers rather than
        // disappearing behind the entire fan stacking context.
        useCanvasStore.getState().setExtractingCardId(groupId)
        // Clear any surfaced strip state so the primary card's zIndex
        // doesn't drop to 5 during extraction — see the primary card's
        // zIndex below.
        setSurfacedId(null)
      }
      if (dragged) {
        const { originX, originY } = computeOrigin(ev.clientX, ev.clientY)
        // Move the anchor AND any tethered sub-members together. Without
        // this, only the anchor follows the cursor while sub-members stay
        // frozen at the threshold-cross position — leaving them stranded
        // far from the anchor when the user drops it elsewhere on the
        // canvas. Apply the same delta to each sub-tree member so the
        // whole sub-deck travels intact.
        const bs = useBoardsStore.getState()
        const currentAnchor = bs.groups.find(g => g.id === groupId)
        if (!currentAnchor) return
        const dxMove = originX - currentAnchor.originX
        const dyMove = originY - currentAnchor.originY
        const allDragIds = expandWithNestedMembers([groupId], bs.groups)
        const updates = allDragIds.map(id => {
          if (id === groupId) return { groupId: id, originX, originY }
          const sub = bs.groups.find(g => g.id === id)
          return sub
            ? { groupId: id, originX: sub.originX + dxMove, originY: sub.originY + dyMove }
            : null
        }).filter(Boolean) as { groupId: string; originX: number; originY: number }[]
        bs.setGroupPosBatch(updates)
      }
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      // Drop-on-original-slot returns the card to the fan — equivalent to
      // an "undo" of the extraction. Lets the user pull a card partway out
      // and put it back without the full extract→drag-back sequence.
      if (dragged) {
        const els = document.elementsFromPoint(ev.clientX, ev.clientY)
        for (const el of els) {
          const drop = (el as HTMLElement).dataset?.deckSlotDrop
          if (!drop) continue
          const [, memberId] = drop.split(':')
          if (memberId === groupId) {
            useBoardsStore.getState().returnToDeck(groupId)
          }
          break
        }
      } else {
        // No drag = click. Toggle the deck-portal for this anchor →
        // member. Clicking the same member again clears the portal;
        // clicking a different member swaps it.
        useCanvasStore.getState().toggleDeckPortal(deck.anchorGroupId, groupId)
      }
      // Always release the fan-render handoff. After this clear, the card
      // either stays where dropped (rendered by CardLayer's main loop at
      // z-index 40) or has been returned to the fan (no longer rendered as
      // a standalone at all).
      useCanvasStore.getState().setExtractingCardId(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  // Portal selection from the global store — a click on a fan member
  // sets this to the member's ID for THIS deck's anchor, locking the
  // member's content on the anchor's face even when the cursor moves
  // off. Hover (surfacedId, local) takes priority for responsiveness,
  // so the user can hover-preview different members while the portal
  // is locked — release the hover and the locked portal takes over.
  const portalMemberId = useCanvasStore(s => s.deckPortalSelections[deck.anchorGroupId])
  const effectiveSurfacedId = surfacedId ?? portalMemberId ?? null

  // Locked-strip index for portal connectors — used both in render and
  // in the connector-animation effect below so the bar tracks the same
  // strip during fan ↔ stack transitions.
  const lockedStripIdx = useMemo(() => {
    if (!portalMemberId) return -1
    return secondaryItems.findIndex(
      item => item.kind === 'real' && item.group.id === portalMemberId,
    )
  }, [portalMemberId, secondaryItems])

  // Animate the portal connectors in lockstep with the locked strip
  // during a fan ↔ stack transition. Without this they stay at full
  // width and only snap on transition end, looking "left behind" while
  // the strips slide. We animate transform:scaleX (not width) so React's
  // rendered width remains authoritative when no transition is active —
  // clearing an inline width would override the React style and not
  // get restored unless the width prop changed.
  // Tucked ratio = TUCK_W/FULL_W shrinks the bar to just the primary-
  // card wrap stub (locked strip fully tucked behind). Resting ratio is
  // 1 (full width). Same easing + the locked strip's own stagger so
  // bar and strip arrive together.
  useLayoutEffect(() => {
    const isThisDeck = fanTransition && fanTransition.deckId === anchorGroup.id
    const connectorEls = [connectorRefs.current.top, connectorRefs.current.bottom].filter(Boolean) as HTMLDivElement[]
    if (lockedStripIdx < 0 || !isThisDeck) {
      for (const el of connectorEls) {
        el.style.transition = ''
        el.style.transform = ''
        el.style.transformOrigin = ''
      }
      return
    }
    const FAN_PRIMARY_RADIUS = 12
    const FULL_W = FAN_PRIMARY_RADIUS + (lockedStripIdx + 1) * FAN_STRIP_WIDTH - STRIP_RADIUS
    const TUCK_W = FAN_PRIMARY_RADIUS - STRIP_RADIUS
    const tuckRatio = TUCK_W / FULL_W
    const N = secondaryItems.length
    const stripStagger = Math.max(8, Math.min(20, Math.floor(N * 1.5)))
    const stagger = lockedStripIdx * stripStagger
    for (const el of connectorEls) {
      el.style.transformOrigin = 'left center'
      if (fanTransition!.phase === 'fanning') {
        el.style.transition = 'none'
        el.style.transform = `scaleX(${tuckRatio})`
        void el.offsetWidth
        el.style.transition = `transform 0.1s cubic-bezier(0.16, 1, 0.3, 1) ${stagger}ms`
        el.style.transform = 'scaleX(1)'
      } else {
        el.style.transition = `transform 0.09s cubic-bezier(0.4, 0, 0.6, 1) ${stagger}ms`
        el.style.transform = `scaleX(${tuckRatio})`
      }
    }
  }, [fanTransition, anchorGroup.id, secondaryItems, lockedStripIdx])

  // When a secondary card is surfaced (hovered or portal-locked),
  // render it full-size on top of the primary card.
  const surfacedGroup = effectiveSurfacedId ? groups.find(g => g.id === effectiveSurfacedId) : null
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
      onPointerEnter={() => {
        setIsHovered(true)
        // Soft "deck has an affordance" hint — drives a faint glow on the
        // dashed-rect icon in the header. NOT the full open-preview.
        useCanvasStore.getState().setCardHoveredDeckId(deck.id)
      }}
      onPointerLeave={() => {
        setIsHovered(false)
        setSurfacedId(null)
        if (useCanvasStore.getState().cardHoveredDeckId === deck.id) {
          useCanvasStore.getState().setCardHoveredDeckId(null)
        }
      }}
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
      {/* Secondary strips — real members and ghost slots, sorted by visual rect.left */}
      {secondaryItems.map((item, i) => {
        const stripX = screenWidth + FAN_STRIP_WIDTH * i - STRIP_OVERLAP
        const stripW = FAN_STRIP_WIDTH + STRIP_OVERLAP
        const stripRadius = `0 ${STRIP_RADIUS}px ${STRIP_RADIUS}px 0`
        const stripZ = 1 + secondaryItems.length - i

        // ── Ghost slot (extracted card placeholder) ──
        if (item.kind === 'ghost') {
          const ghostColor = item.card?.color ?? '#5b8dd9'
          const hsl = hexToHsl(ghostColor)
          const darkFill = hslToHex(hsl.h, Math.max(0.15, hsl.s * 0.5), Math.max(0.08, hsl.l * 0.22))
          const isGhostSelected = selectedGhostIds.includes(item.cardId)
          // Resolve a hero image for the ghost: prefer the extracted card's
          // own cardHeroImage, fall back to the first image in any of its
          // boards. Same lookup as the regular strip render — just rendered
          // at lower opacity below so the slot reads as a placeholder.
          const ghostHero = (() => {
            if (!item.card) return null
            if (item.card.cardHeroImage) return item.card.cardHeroImage
            for (const bid of item.card.boardIds) {
              const board = boards[bid]
              if (!board) continue
              for (const rid of board.rootIds) {
                const img = getFirstImageUrl(board.bars[rid]?.content)
                if (img) return img
              }
            }
            return null
          })()
          const ghostName = item.card?.name || ''
          return (
            <div
              key={`ghost-${item.cardId}`}
              ref={el => {
                const k = `ghost-${item.cardId}`
                if (el) stripRefs.current.set(k, el)
                else stripRefs.current.delete(k)
              }}
              data-deck-slot-drop={`${anchorGroup.id}:${item.cardId}`}
              title={item.card ? `Extracted: ${ghostName} · double-click to jump` : 'Extracted card (deleted)'}
              onPointerDown={e => {
                if (e.button !== 0) return
                e.stopPropagation()
                useCanvasStore.getState().setSelectedGhostGroupIds([item.cardId])
                useCanvasStore.getState().clearSelectedBlockBoardIds()
                useBoardsStore.getState().clearGroupSelection()
              }}
              onDoubleClick={e => {
                e.stopPropagation()
                if (item.card) useCanvasStore.getState().jumpToGroup(item.cardId)
              }}
              style={{
                position: 'absolute',
                left: stripX,
                top: 0,
                width: stripW,
                height: screenHeight,
                borderRadius: stripRadius,
                background: darkFill,
                border: isGhostSelected
                  ? '2px solid rgba(255,255,255,0.85)'
                  : '1.5px dashed rgba(255,255,255,0.28)',
                overflow: 'hidden',
                zIndex: stripZ,
                cursor: 'pointer',
                userSelect: 'none',
                pointerEvents: 'all',
              }}
            >
              {/* Hero thumbnail at low opacity — barely visible but enough
                  to recognize the missing card. Mirrors the regular strip's
                  hero block, just at ~0.18 alpha vs 0.7 for live cards. */}
              {ghostHero && (
                <div style={{
                  position: 'absolute', inset: 0,
                  backgroundImage: `url(${ghostHero})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  opacity: 0.18,
                  borderRadius: stripRadius,
                  pointerEvents: 'none',
                }} />
              )}
              {/* Vertical card name + "CHECKED OUT" indicator. The state
                  label is the headline at full opacity; the name is dim,
                  acting as supporting info. Mirrors the canvas ghost slot's
                  flipped hierarchy. */}
              {ghostName && (
                <div style={{
                  position: 'absolute', top: 8, left: STRIP_OVERLAP + 4, right: 4, bottom: 8,
                  writingMode: 'vertical-rl', textOrientation: 'mixed',
                  textShadow: '0 1px 3px rgba(0,0,0,0.7)',
                  display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
                  gap: 8,
                  pointerEvents: 'none',
                }}>
                  <div style={{
                    color: 'rgba(255,255,255,0.42)',
                    fontSize: 10 * overviewScale(zoom), fontWeight: 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {ghostName}
                  </div>
                  <div style={{
                    color: 'rgba(255,255,255,1)',
                    fontSize: 9 * overviewScale(zoom), fontWeight: 700,
                    fontStyle: 'italic',
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    whiteSpace: 'nowrap',
                  }}>
                    Checked Out
                  </div>
                </div>
              )}
            </div>
          )
        }

        // ── Real member strip ──
        const sc = item.group
        // Strip is "surfaced" if hovered OR if it's the portal-selected
        // member — same brightness/drop-shadow base treatment.
        const isSurfaced = sc.id === effectiveSurfacedId
        // Additionally, "portal-locked" means the click-toggled lock is
        // on THIS strip. Gets a bright outline + a small pin dot to
        // tell it apart from a transient hover.
        const isPortalLocked = sc.id === portalMemberId
        // When a portal is locked on SOME strip but not this one, this
        // strip is "dimmed" — visually muted and unresponsive to hover.
        // The locked strip stays full-brightness; the user can still
        // click a dimmed strip to swap the selection (pointerDown stays
        // active), but hovering won't change the surfaced preview.
        const isPortalDimmed = portalMemberId != null && !isPortalLocked

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
            ref={el => {
              if (el) stripRefs.current.set(sc.id, el)
              else stripRefs.current.delete(sc.id)
            }}
            style={{
              position: 'absolute',
              left: stripX,
              top: 0,
              width: stripW,
              height: screenHeight,
              borderRadius: stripRadius,
              background: sc.color || '#5b8dd9',
              boxSizing: 'border-box',
              // The strip's OWN border properties carry the indicator.
              // When portal-locked, top/right/bottom upgrade from the
              // faint 1-px lines to 2-px bright lines that sit at the
              // strip's actual outer edges — co-linear with the primary
              // card's top/bottom edges, so they read as connected.
              // borderLeft stays absent so the strip's left side is
              // open onto the primary, no vertical wall.
              borderRight: isPortalLocked
                ? '2px solid rgba(255,255,255,0.92)'
                : '1px solid rgba(255,255,255,0.2)',
              borderTop: isPortalLocked
                ? '2px solid rgba(255,255,255,0.92)'
                : '1px solid rgba(255,255,255,0.12)',
              borderBottom: isPortalLocked
                ? '2px solid rgba(255,255,255,0.92)'
                : '1px solid rgba(255,255,255,0.12)',
              overflow: 'visible',
              zIndex: stripZ,
              cursor: 'pointer',
              userSelect: 'none',
              pointerEvents: 'all',
              transition: 'filter 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease',
              // Dimmed strips fade to near-black via brightness/saturate
              // rather than translucency. The hero image stays in place
              // (rendered below) so it adds a faint texture once crushed
              // by the filter — keeps the strips from reading as flat
              // dead rectangles. A touch of contrast deepens the shadows
              // so the inset vignette has something to bite into.
              filter: isSurfaced
                ? 'brightness(1.22) drop-shadow(4px 6px 10px rgba(0,0,0,0.55))'
                : isPortalDimmed
                  ? 'brightness(0.28) saturate(0.35) contrast(1.15)'
                  : 'none',
              // Locked: soft blue glow.
              // Dimmed: layered inset shadow — a tight inner ring darkens
              // the strip's edges (vignette), and a top-biased shadow
              // adds a subtle "in shadow from above" depth cue so each
              // strip reads as recessed rather than printed flat.
              boxShadow: isPortalLocked
                ? '0 0 12px 2px rgba(120,180,255,0.5)'
                : isPortalDimmed
                  ? 'inset 0 0 14px rgba(0,0,0,0.55), inset 0 14px 22px -10px rgba(0,0,0,0.7)'
                  : 'none',
            }}
            // Hover handlers gated by isPortalDimmed: a dimmed strip
            // doesn't respond to mouseover, so the locked-strip preview
            // stays put while the cursor passes over its siblings. Click
            // (onPointerDown) still works — that's how the user swaps the
            // portal selection to a different strip.
            onPointerEnter={() => { if (!isPortalDimmed) setSurfacedId(sc.id) }}
            onPointerLeave={() => { if (!isPortalDimmed) setSurfacedId(prev => prev === sc.id ? null : prev) }}
            onPointerDown={e => onStripDown(e, sc.id)}
          >
            {scHero && (
              <div style={{
                position: 'absolute', inset: 0,
                backgroundImage: `url(${scHero})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                opacity: 0.7,
                borderRadius: stripRadius,
              }} />
            )}
            <div style={{
              position: 'absolute', top: 8, left: STRIP_OVERLAP + 4, right: 4, bottom: 8,
              writingMode: 'vertical-rl', textOrientation: 'mixed',
              color: 'rgba(255,255,255,0.85)', fontSize: 10 * overviewScale(zoom), fontWeight: 600,
              textShadow: '0 1px 3px rgba(0,0,0,0.8)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            }}>
              {sc.name}
            </div>
            {isSubDeck && (
              <div style={{
                position: 'absolute',
                left: STRIP_OVERLAP, bottom: '100%',
                width: FAN_STRIP_WIDTH,
                height: 18,
                pointerEvents: 'none',
              }}>
                {/* Cascading fan-edge cues derived from the sub-deck anchor's
                    own color (sc is the sub-deck primary), matching the
                    edgeColor pattern used for stacked-deck right edges. */}
                <div style={{
                  position: 'absolute',
                  left: 0, bottom: 0,
                  width: '100%', height: 5,
                  borderTop: `2px solid ${edgeColor(sc.color, 0.6)}`,
                  borderLeft: `2px solid ${edgeColor(sc.color, 0.6)}`,
                  borderRight: `2px solid ${edgeColor(sc.color, 0.6)}`,
                  borderRadius: '6px 6px 0 0',
                }} />
                <div style={{
                  position: 'absolute',
                  left: '10%', bottom: 5,
                  width: '80%', height: 4,
                  borderTop: `2px solid ${edgeColor(sc.color, 0.42)}`,
                  borderRadius: '4px 4px 0 0',
                }} />
                <div style={{
                  position: 'absolute',
                  left: '25%', bottom: 9,
                  width: '50%', height: 4,
                  borderTop: `1.5px solid ${edgeColor(sc.color, 0.25)}`,
                  borderRadius: '3px 3px 0 0',
                }} />
                <div style={{
                  position: 'absolute',
                  left: '35%', bottom: 13,
                  width: '30%', height: 4,
                  borderTop: `1.5px solid ${edgeColor(sc.color, 0.15)}`,
                  borderRadius: '2px 2px 0 0',
                }} />
              </div>
            )}
          </div>
        )
      })}

      {/* Portal-lock CONNECTORS — two bright bars at the top and bottom
            of the strips area, spanning from INSIDE the primary card's
            rounded right corner (extended PRIMARY_RADIUS px leftward
            so the bar visibly tucks into the card's top-right / bottom-
            right corner) across the in-between strips and ending where
            the locked strip's straight top/bottom border ends (i.e.
            STRIP_RADIUS before the strip's rounded right corner). The
            strip's own rounded corner closes the bracket on the right,
            so the connectors don't poke out as little dots past the
            curve. z=30 keeps the bars above all strips AND above the
            surfaced overlay's bright border, so the leftward extension
            is actually visible against the primary card's corner zone. */}
      {(() => {
        if (lockedStripIdx < 0) return null
        const PRIMARY_RADIUS = 12 // matches the primary card's borderRadius
        // Width = wrap-in distance on the left + strips spanned − strip
        // radius on the right. The bar starts at (screenWidth - PRIMARY_RADIUS)
        // so its left end visually enters the primary card's rounded corner.
        // During a fan transition, the useLayoutEffect above overrides this
        // width imperatively so the bars track the locked strip's slide.
        const connectorWidth =
          PRIMARY_RADIUS + (lockedStripIdx + 1) * FAN_STRIP_WIDTH - STRIP_RADIUS
        const barStyle: React.CSSProperties = {
          position: 'absolute',
          left: screenWidth - PRIMARY_RADIUS,
          width: connectorWidth,
          height: 2,
          background: 'rgba(255,255,255,0.92)',
          zIndex: 30,
          pointerEvents: 'none',
        }
        return (
          <>
            <div
              ref={el => { connectorRefs.current.top = el }}
              style={{ ...barStyle, top: 0 }}
            />
            <div
              ref={el => { connectorRefs.current.bottom = el }}
              style={{ ...barStyle, top: screenHeight - 2 }}
            />
          </>
        )
      })()}

      {/* Surfaced card — full-size overlay when hovering a strip.
           Shows the card's own hero image + header/body text (GroupCardText),
           plus the card title at the bottom — same as how primary card renders. */}
      {surfacedGroup && (() => {
        // Distinguish PORTAL-LOCKED state from transient hover: when the
        // surfaced group matches the click-locked portal member, give
        // the overlay a brighter accent ring + outer glow. Hover-only
        // gets the subtler blue-tinted border.
        const isPortalRender = surfacedGroup.id === portalMemberId
        const overlayBorder = isPortalRender
          ? '2px solid rgba(255,255,255,0.92)'
          : '2px solid rgba(180,210,255,0.7)'
        const overlayShadow = isPortalRender
          ? '0 8px 32px rgba(0,0,0,0.6), 0 0 14px 2px rgba(120,180,255,0.45)'
          : '0 8px 32px rgba(0,0,0,0.6)'
        return (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: screenWidth,
            height: screenHeight,
            borderRadius: 12,
            background: surfacedGroup.color,
            border: overlayBorder,
            boxShadow: overlayShadow,
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
              color: 'rgba(255,255,255,0.7)', fontSize: 11 * overviewScale(zoom), fontWeight: 600,
              textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            }}>
              {surfacedGroup.cardSummary || surfacedGroup.name}
            </div>
          </div>
          {/* Sub-deck indicator — stacked edges on surfaced card. Derived from
              the surfaced group's own color so a non-blue sub-deck stays in
              its own color family (matches the fan-strip top-edge cue and the
              stacked-deck right-edge cue). */}
          {isSubDeckAnchor(surfacedGroup.id, allGroups) && (
            <>
              <div style={{
                position: 'absolute',
                right: -5, top: 0, width: 5, height: '100%',
                borderTop: `2px solid ${edgeColor(surfacedGroup.color, 0.6)}`,
                borderRight: `2px solid ${edgeColor(surfacedGroup.color, 0.6)}`,
                borderBottom: `2px solid ${edgeColor(surfacedGroup.color, 0.6)}`,
                borderRadius: '0 8px 8px 0',
                pointerEvents: 'none',
                zIndex: 21,
              }} />
              <div style={{
                position: 'absolute',
                right: -9, top: '3%', width: 4, height: '94%',
                borderRight: `2px solid ${edgeColor(surfacedGroup.color, 0.42)}`,
                borderRadius: '0 6px 6px 0',
                pointerEvents: 'none',
                zIndex: 21,
              }} />
            </>
          )}
        </div>
        )
      })()}

      {/* Primary card — front, identical to open state */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: screenWidth,
          height: screenHeight,
          borderRadius: 12,
          background: anchorGroup.color,
          border: fanSelFx ? fanSelFx.border : '1.5px solid rgba(255,255,255,0.25)',
          boxShadow: fanSelFx ? fanSelFx.boxShadow : '0 6px 32px rgba(0,0,0,0.5)',
          overflow: 'hidden',
          cursor: 'grab',
          userSelect: 'none',
          // Drop to z=5 only when a strip is being surface-hovered (so the
          // surfaced-card overlay at z=20 can render above), AND we're not
          // in the middle of an extraction. Otherwise the primary's z scales
          // with the fan size: stays above any possible strip-equivalent z
          // (max strip z is N+1). Without this scaling, fans with 9+
          // secondaries push slot 0's z to 10+, which ties or beats a
          // fixed primary at 10 — and the dragged card (sharing that z)
          // pops in front of primary instead of sliding under it.
          zIndex: (effectiveSurfacedId && !extractingCardId)
            ? 5
            : Math.max(10, secondaryItems.length + 2),
        }}
        onPointerDown={onFanDragDown}
      >
        {heroImage && <HeroImageLayer heroImage={heroImage} transform={anchorGroup.cardHeroTransform} />}
        {/* Content area — offset below header extension */}
        <div style={{ position: 'absolute', top: headerPad, left: 0, right: 0, bottom: 0, overflow: 'hidden', borderRadius: '0 0 12px 12px' }}>
          <GroupCardText groupId={anchorGroup.id} onCropImage={() => setIsEditingHero(true)} />
          <div style={{
            position: 'absolute', bottom: 6, left: 8, zIndex: 2,
            color: 'rgba(255,255,255,0.7)', fontSize: 11 * overviewScale(zoom), fontWeight: 600,
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
          }}>
            {anchorGroup.cardSummary || anchorGroup.name}
          </div>
        </div>
        {/* The deck-member count now lives inside the dashed-rect
            affordance in the header (one element, two jobs). */}
      </div>

      {/* Extracting card — while a fan strip is being dragged out, render the
          card here (inside the fan wrapper) at the same z-index its strip
          held. This puts the card "between layers" in the fan stacking
          context: cards to its LEFT in fan order cover it, cards to its
          RIGHT are behind. The visual is "sliding out from between layers"
          rather than the previous "popping out behind the entire fan".
          On pointerup, extractingCardId clears and the card transitions to
          CardLayer's normal main-loop render at zIndex 40 — at which point
          it's at cursor position (rest of the fan is to the left), so the
          stacking-context handoff is invisible in practice. */}
      {extractingCardId && (() => {
        const slotIdx = secondaryItems.findIndex(it => it.kind === 'ghost' && it.cardId === extractingCardId)
        if (slotIdx === -1) return null
        // Use the strip's natural z so the dragged card matches the ghost
        // slot (which sits beneath it in DOM order — dragged ends up on top
        // of its own ghost). Primary card's z scales above this — see the
        // primary's zIndex below.
        const slotZ = 1 + secondaryItems.length - slotIdx
        const card = allGroups.find(g => g.id === extractingCardId)
        if (!card) return null
        // The wrapper is at (screenLeft, screenTop). Negative offsets cancel
        // that out so children's absolute positions read as screen-absolute,
        // letting GroupCard render where its own cardScreenRect math says.
        return (
          <div
            key={`extracting-${card.id}`}
            style={{
              position: 'absolute',
              left: -screenLeft,
              top: -screenTop,
              zIndex: slotZ,
              // Suppress GroupCard's interactions during the drag — pointer
              // events are owned by the window-level handlers in onStripDown.
              pointerEvents: 'none',
            }}
          >
            <GroupCard group={card} />
          </div>
        )
      })()}

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
  // Card visual bounds match content exactly.
  const cW = gMaxX - gMinX, cH = bottomY - topY
  const finalW = Math.max(cW, g.cardWidthOverride ?? 0)
  const finalH = Math.max(cH, g.cardHeightOverride ?? 0)
  const headerExtend = computeHeaderExtend(zoom)
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

/** True if some other group is holding a ghostSlot for this card — i.e., the
 *  card is "extracted" out of that other group's deck. */
function findExtractionParent(cardId: string, allGroups: ProjectGroup[]): ProjectGroup | null {
  return allGroups.find(g => (g.ghostSlots ?? []).some(s => s.cardId === cardId)) ?? null
}

/** Card-shaped dotted-outline placeholder at a ghost slot's would-be position
 *  on canvas. Rendered when the parent is OPEN — so the extracted card can
 *  be dropped here to return. (When the parent is fanned/stacked the ghost
 *  appears as a strip inside the fan instead.)
 *
 *  Now shows muted card-identity (hero image at low opacity, card name) so
 *  collaborators opening the file can see WHICH card was checked out, not
 *  just that something was. Double-click pans the canvas to wherever the
 *  extracted card actually lives. */
const GhostCardSlot: React.FC<{ anchor: ProjectGroup; slot: { cardId: string; deckOffsetX: number; deckOffsetY: number } }> = ({ anchor, slot }) => {
  const boards = useBoardsStore(s => s.boards)
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const isSelected = useCanvasStore(s => s.selectedGhostGroupIds.includes(slot.cardId))
  const allGroups = useBoardsStore(s => s.groups)
  const card = allGroups.find(g => g.id === slot.cardId)
  // Compute the slot's canvas-space rect using the card's geometry projected
  // at the slot position (anchor.origin + offsets). If the card was deleted,
  // fall back to a generic small placeholder.
  const slotGroup: ProjectGroup | null = card ? {
    ...card,
    originX: anchor.originX + slot.deckOffsetX,
    originY: anchor.originY + slot.deckOffsetY,
  } : null
  const rect = slotGroup ? cardScreenRect(slotGroup, boards, pan, zoom) : null
  if (!rect) return null
  const ghostColor = card?.color ?? '#5b8dd9'
  const hsl = hexToHsl(ghostColor)
  const darkFill = hslToHex(hsl.h, Math.max(0.15, hsl.s * 0.5), Math.max(0.08, hsl.l * 0.22))
  // Hero image lookup — same fallback chain as live cards, just rendered
  // muted below so the slot still reads as a placeholder.
  const ghostHero = (() => {
    if (!card) return null
    if (card.cardHeroImage) return card.cardHeroImage
    for (const bid of card.boardIds) {
      const board = boards[bid]
      if (!board) continue
      for (const rid of board.rootIds) {
        const img = getFirstImageUrl(board.bars[rid]?.content)
        if (img) return img
      }
    }
    return null
  })()
  const ghostName = card?.name || ''
  return (
    <div
      data-deck-slot-drop={`${anchor.id}:${slot.cardId}`}
      title={card ? `Checked out: ${ghostName} · double-click to jump` : 'Extracted card (deleted)'}
      onPointerDown={e => {
        if (e.button !== 0) return
        e.stopPropagation()
        useCanvasStore.getState().setSelectedGhostGroupIds([slot.cardId])
        useCanvasStore.getState().clearSelectedBlockBoardIds()
        useBoardsStore.getState().clearGroupSelection()
      }}
      onDoubleClick={e => {
        e.stopPropagation()
        if (card) useCanvasStore.getState().jumpToGroup(slot.cardId)
      }}
      style={{
        position: 'absolute',
        left: rect.screenLeft,
        top: rect.screenTop,
        width: rect.screenWidth,
        height: rect.screenHeight,
        border: isSelected
          ? '2px solid rgba(255,255,255,0.85)'
          : '1.5px dashed rgba(255,255,255,0.28)',
        borderRadius: 12,
        background: darkFill,
        overflow: 'hidden',
        pointerEvents: 'all',
        cursor: 'pointer',
        zIndex: 30,
      }}
    >
      {/* Hero image at low opacity — recognizable but clearly muted. */}
      {ghostHero && (
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: `url(${ghostHero})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          opacity: 0.22,
          pointerEvents: 'none',
        }} />
      )}
      {/* "CHECKED OUT" is the headline; the card name is secondary. The
          state matters more than the identity here — third parties opening
          the file should immediately register "this slot is checked out"
          and find the card name as supporting info. */}
      {ghostName && (() => {
        const nameSize = Math.max(13 * overviewScale(zoom), Math.min(24, rect.screenHeight * 0.11))
        const subtitleSize = Math.max(9 * overviewScale(zoom), nameSize * 0.55)
        return (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            padding: '0 12px',
            textAlign: 'center',
            pointerEvents: 'none',
          }}>
            <div style={{
              color: 'rgba(255,255,255,0.5)',
              fontSize: nameSize,
              fontWeight: 600,
              textShadow: '0 1px 4px rgba(0,0,0,0.6)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              maxWidth: '100%',
            }}>
              {ghostName}
            </div>
            <div style={{
              color: 'rgba(255,255,255,0.95)',
              fontSize: subtitleSize,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              fontStyle: 'italic',
              marginTop: Math.max(2, subtitleSize * 0.25),
              textShadow: '0 1px 4px rgba(0,0,0,0.75)',
            }}>
              Checked Out
            </div>
          </div>
        )
      })()}
      {/* "Checked out" indicator in the top-right corner — visual cue that
          this isn't an empty slot, the card is somewhere on the canvas. */}
      {card && (
        <div style={{
          position: 'absolute', top: 6, right: 6,
          color: 'rgba(255,255,255,0.45)',
          fontSize: 13 * overviewScale(zoom), lineHeight: 1, fontWeight: 700,
          pointerEvents: 'none',
          textShadow: '0 1px 4px rgba(0,0,0,0.7)',
        }}>↗</div>
      )}
    </div>
  )
}

/** Open-footprint preview — when a stacked or fanned deck is hovered or
 *  selected, render a faint dashed outline at each non-anchor member's
 *  would-be open position. Lets the user see where members will land BEFORE
 *  committing to setDeckState('open'), avoiding surprise overlaps in the
 *  free-form layout zone.
 *
 *  Geometry uses the same virtual-group projection trick as GhostCardSlot:
 *  build {...member, originX/Y: anchor.origin + member.deckOffset} and feed
 *  it to cardScreenRect so the preview math is the SAME source of truth as
 *  the actual post-open render — no drift possible.
 *
 *  Sub-deck members preview as ONE card outline (the sub-deck anchor's own
 *  bounds at its spread position). That matches setDeckState('open'): only
 *  one nesting level opens, so a sub-deck stays closed inside its parent
 *  after the open. We do not recurse into nested members.
 *
 *  pointer-events: none, zIndex 25 — purely visual, sits above the canvas
 *  backdrop but below ghost slots (30) and far below all card surfaces (40+),
 *  so the deck always draws on top of any overlapping preview rect. */
const DeckOpenPreview: React.FC<{ deck: Deck }> = ({ deck }) => {
  const boards = useBoardsStore(s => s.boards)
  const allGroups = useBoardsStore(s => s.groups)
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  // Preview only fires when the dashed-rect affordance icon in the header is
  // hovered. Selection used to also trigger this, but selection is too sticky
  // for that to feel right — too many other interactions require selecting a
  // card, so the preview was constantly on. Hover-the-icon is the single
  // explicit gesture for the preview now.
  const active = useCanvasStore(s => s.previewHoveredDeckId === deck.id)

  // Project each non-anchor member at its would-be open position. Memoize so
  // we don't re-walk on every pan/zoom render that doesn't change membership.
  // The gate is *inside* the memo (rather than an early return) so all hooks
  // run unconditionally — keeps React's rules-of-hooks happy.
  const previews = useMemo(() => {
    if (!active) return []
    const anchor = allGroups.find(g => g.id === deck.anchorGroupId)
    if (!anchor) return []
    const out: { id: string; color: string; rect: NonNullable<ReturnType<typeof cardScreenRect>> }[] = []
    for (const memberId of deck.memberIds) {
      if (memberId === deck.anchorGroupId) continue // anchor doesn't move on open
      const member = allGroups.find(g => g.id === memberId)
      if (!member) continue
      // Build a virtual member at its post-open canvas position. Same trick
      // GhostCardSlot uses (lines ~2050-2054). cardScreenRect bakes in
      // BOARD_PADDING_X, minX*bScale, getRowY, cardWidthOverride, and the
      // headerExtend, so this matches the actual card render exactly.
      const virtualMember: ProjectGroup = {
        ...member,
        originX: anchor.originX + (member.deckOffsetX ?? 0),
        originY: anchor.originY + (member.deckOffsetY ?? 0),
      }
      const rect = cardScreenRect(virtualMember, boards, pan, zoom)
      if (!rect) continue
      out.push({ id: member.id, color: member.color, rect })
    }
    return out
  }, [active, deck.memberIds, deck.anchorGroupId, allGroups, boards, pan, zoom])

  if (previews.length === 0) return null

  return (
    <>
      {previews.map(p => (
        <div
          key={`preview-${deck.id}-${p.id}`}
          data-deck-preview={p.id}
          style={{
            position: 'absolute',
            left: p.rect.screenLeft,
            top: p.rect.screenTop,
            width: p.rect.screenWidth,
            height: p.rect.screenHeight,
            border: '1.5px dashed rgba(255,255,255,0.35)',
            borderRadius: 12,
            // Very faint color tint (~8% alpha) so the user can tell which
            // member each outline corresponds to without it dominating visuals.
            background: `${p.color}14`,
            pointerEvents: 'none',
            zIndex: 25,
          }}
        />
      ))}
    </>
  )
}

/** Tint stripe across the middle third of an extracted card's NLE header,
 *  colored with the parent deck's color. Replaces the older floating chip
 *  approach — by integrating into the header bar itself, the indicator
 *  reads as part of the card's own UI rather than something tacked on.
 *
 *  Hover → tooltip with deck name; double-click → pan to that deck. */
const TetherTab: React.FC<{ cardId: string; touchingClusters: string[][] }> = ({ cardId, touchingClusters }) => {
  const boards = useBoardsStore(s => s.boards)
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const allGroups = useBoardsStore(s => s.groups)
  const card = allGroups.find(g => g.id === cardId)
  const parent = card ? findExtractionParent(card.id, allGroups) : null
  // Context menu state. Stored as cursor position (or null for closed) so we
  // can render the menu via portal without blocking the early-return below.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // Hover state — surfaces a small ↗ arrow indicating the stripe is
  // interactive (jump-to-deck via double-click, menu via right-click).
  const [isHovered, setIsHovered] = useState(false)
  if (!card || !parent) return null
  const rect = cardScreenRect(card, boards, pan, zoom)
  if (!rect) return null
  const parentName = parent.name || parent.cardHeaderText || 'Untitled deck'
  // Header geometry — same formula NLETimelineHeader uses, mirrored here so
  // the tint stripe lines up exactly with the visible header bar.
  const headerExtend = computeHeaderExtend(zoom)
  // Use the CARD's own color (not the parent deck's), but brightened —
  // higher lightness and slightly higher saturation than the rest of the
  // header tint. Stays in the same color family while standing out as a
  // distinct band.
  const cardHsl = hexToHsl(card.color)
  const brightColor = hslToHex(
    cardHsl.h,
    Math.min(1, cardHsl.s + 0.1),
    Math.min(0.9, cardHsl.l + 0.25),
  )
  // Middle-third stripe: leaves the card's title (left side) and the
  // affordance icon (right side) visually unobstructed, while still being
  // wide enough to register as a deliberate tint rather than a thin band.
  const stripeLeft = rect.screenLeft + rect.screenWidth / 3
  const stripeWidth = rect.screenWidth / 3
  // Arrow size scales with the header — same proportion as the affordance
  // icon's font size so the visual weight matches.
  const arrowSize = Math.max(11 * overviewScale(zoom), headerExtend * 0.55)
  return (
    <>
      <div
        onPointerEnter={() => setIsHovered(true)}
        onPointerLeave={() => setIsHovered(false)}
        onPointerDown={e => e.stopPropagation()}
        // Double-click → check the card back in. If the card is currently
        // in a touching cluster with other cards on canvas (i.e., a deck
        // affordance is showing around them), re-form the cluster as
        // THIS card's sub-deck first — so the whole group goes back into
        // the parent's slot together rather than leaving the cluster
        // stranded. The "Go to deck" action is still reachable via
        // right-click for users who want to jump to the source instead.
        onDoubleClick={e => {
          e.stopPropagation()
          useUndoCoordinator.getState().checkpoint()
          const cluster = touchingClusters.find(c => c.includes(card.id))
          if (cluster && cluster.length >= 2) {
            // Reorder so this card is first → it becomes the sub-deck
            // anchor. Other cluster members get tethered to it.
            const ordered = [card.id, ...cluster.filter(id => id !== card.id)]
            useBoardsStore.getState().setDeckState(ordered, 'stacked')
          }
          useBoardsStore.getState().returnToDeck(card.id)
        }}
        // Right-click on the tether stripe → tether-specific menu
        // ("Go to deck" / "Check back in"). The card-body context menu no
        // longer carries these — they live here, where the visual cue
        // (dimmed band on the header) is.
        onContextMenu={e => {
          e.preventDefault()
          e.stopPropagation()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        title={`From deck: ${parentName} · double-click to check back in · right-click for actions`}
        style={{
          position: 'absolute',
          left: stripeLeft,
          top: rect.screenTop,
          width: stripeWidth,
          height: headerExtend,
          // Brightened card color: visibly lighter than the rest of the
          // header (which is already a card-color tint) but still in the
          // same family. Hover bumps alpha for an interaction signal
          // alongside the arrow appearing.
          background: isHovered ? `${brightColor}66` : `${brightColor}40`,
          // Dotted outline gives the stripe enough definition to be
          // recognizable without competing with the header content.
          border: `1px dotted rgba(255,255,255,${isHovered ? 0.35 : 0.22})`,
          boxSizing: 'border-box',
          transition: 'background 0.12s, border-color 0.12s',
          zIndex: 52, // above the header (z=51) so the tint lands on top
          pointerEvents: 'all',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Hover arrow — same ↗ glyph as the corner indicator on the
            canvas ghost slot, so the "this is a checked-out tether" visual
            language is consistent across the two surfaces. */}
        {isHovered && (
          <span style={{
            color: 'rgba(255,255,255,0.85)',
            fontSize: arrowSize,
            fontWeight: 700,
            lineHeight: 1,
            textShadow: '0 1px 3px rgba(0,0,0,0.6)',
            pointerEvents: 'none',
          }}>↗</span>
        )}
      </div>
      {/* Hover preview: outline every card in the touching cluster around
          this tether's card. Tells the user, before they double-click,
          which cards will be folded into the sub-deck and returned along
          with the anchor. Uses the same blue-dashed treatment as
          DeckAffordance's hover so it reads as "deck-ish." */}
      {isHovered && (() => {
        const cluster = touchingClusters.find(c => c.includes(card.id))
        if (!cluster || cluster.length < 2) return null
        return cluster.map(memberId => {
          const member = allGroups.find(g => g.id === memberId)
          if (!member) return null
          const r = cardScreenRect(member, boards, pan, zoom)
          if (!r) return null
          return (
            <div
              key={`tether-preview-${memberId}`}
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
          )
        })
      })()}
      {menu && ReactDOM.createPortal(
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onPointerDown={() => setMenu(null)}
          />
          <div
            onPointerDown={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: Math.min(menu.x, window.innerWidth - 220),
              top: Math.min(menu.y, window.innerHeight - 100),
              minWidth: 200, zIndex: 9999,
              background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
              padding: '5px 0', fontFamily: 'system-ui, sans-serif',
            }}
          >
            <div style={{ padding: '4px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: 4 }}>
              <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>Tether</span>
            </div>
            {[
              { label: `Go to deck: ${parentName.substring(0, 24)}`, icon: '↗', action: () => {
                useCanvasStore.getState().jumpToGroup(parent.id)
                setMenu(null)
              }},
              { label: 'Check back in', icon: '↩', action: () => {
                useUndoCoordinator.getState().checkpoint()
                // Same cluster-fold behavior as double-click: bring touching
                // cards along as a sub-deck so the whole group returns home.
                const cluster = touchingClusters.find(c => c.includes(card.id))
                if (cluster && cluster.length >= 2) {
                  const ordered = [card.id, ...cluster.filter(id => id !== card.id)]
                  useBoardsStore.getState().setDeckState(ordered, 'stacked')
                }
                useBoardsStore.getState().returnToDeck(card.id)
                setMenu(null)
              }},
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

/** Screen-space overlay — one card per group + per-group NLE headers + ungrouped board cards */
/** `only` renders JUST those groups, with everything else (previews,
 *  affordances, ungrouped boards) suppressed.
 *
 *  This is what lets PinLayer show a pinned card WITHOUT a second copy of
 *  this file's render branch: it mounts this same Overlay inside a frozen
 *  camera, scoped to one deck. Decks, stacks, fans and open/close therefore
 *  work while pinned because it is literally the same code — the alternative
 *  was duplicating the branch, which is the drift that has already produced
 *  three bugs in this project. */
const Overlay: React.FC<{ only?: string[] }> = ({ only }) => {
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  // Frozen when pinned, live otherwise — the same swap every card piece makes.
  const { pan, zoom } = useCardView()
  const scoped = !!only
  const onlySet = useMemo(() => (only ? new Set(only) : null), [only])
  // Defer boards (only) so the heavy derived work runs on idle time during
  // drags. We can't defer `groups` here: the render gate below uses live
  // `groups` to hide non-anchor deck members (via deckAnchorId), and useCardDecks
  // must agree on visibility — otherwise after returnToDeck, the gate hides A
  // (live) while useCardDecks's deferred data still lists A as a self-anchored
  // standalone deck and never adds A to its parent's memberIds. The strip never
  // renders until something else (like close+reopen) bumps deferredGroups.
  const deferredBoards = useDeferredValue(boards)
  const ungroupedIds = useMemo(
    () => getUngroupedBoardIds(groups, deferredBoards),
    [groups, deferredBoards]
  )
  const { decks, touchingClusters, getDeckForGroup } = useCardDecks(groups, deferredBoards, zoom)

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
        const g = groups.find(gr => gr.id === gid)
        if (!g) return false
        const isOpen = !g.deckState || g.deckState === 'open'
        // Visible sub-deck anchors are eligible for parent deck formation
        const isVisibleSubAnchor = !isHiddenDeckMember(g) && isSubDeckAnchor(g.id, groups)
        // Orphan deck state: group has deckState set but no other groups
        // actually reference it as their anchor — treat it as open so the
        // affordance can re-form it into a real deck with a neighbor.
        const hasRealMembers = groups.some(other =>
          other.id !== g.id && other.deckAnchorId === g.id
        )
        const isOrphanDeck = !isOpen && !isVisibleSubAnchor && !hasRealMembers
        return isOpen || isVisibleSubAnchor || isOrphanDeck
      }).length
      return eligibleCount >= 2
    })
  }, [touchingClusters, renderedByDeck, groups])

  const extractingCardId = useCanvasStore(s => s.extractingCardId)
  const fanTransition = useCanvasStore(s => s.fanTransition)
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} onPointerDown={startOverlayPan}>
      {groups.map(g => {
        // Hard gate: if this group is a non-anchor member of any deck, hide it completely.
        // This uses the persisted deckAnchorId — no spatial clustering needed.
        if (g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id) {
          return null
        }
        // While a fan strip is being dragged out, the FannedDeckOverlay owns
        // that card's render (at strip-equivalent z-index). Skip here so we
        // don't render it twice.
        if (g.id === extractingCardId) return null
        // Scoped render (a pinned deck): draw only its own groups.
        // Unscoped (the canvas): skip pinned ones, because PinLayer draws
        // them with a frozen camera and they must not appear twice.
        if (onlySet) { if (!onlySet.has(g.id)) return null }
        else if (g.pin) return null

        const deck = getDeckForGroup(g.id)

        // Treat the deck as "fanned for rendering purposes" when there's an
        // active stack-direction fan transition for it — keeps the
        // FannedDeckOverlay alive during the closing animation so its strips
        // can slide back into the primary card before the StackedDeckCard
        // takes over.
        const isStackingTransition =
          fanTransition?.deckId === g.id && fanTransition.phase === 'stacking'
        const treatAsFanned = deck?.state === 'fanned' || (deck && isStackingTransition)

        // If anchor of a stacked deck → render StackedDeckCard (unless mid-
        // stacking-transition, where we keep FannedDeckOverlay active).
        if (deck?.state === 'stacked' && deck.anchorGroupId === g.id && !isStackingTransition) {
          // isNested = this deck's anchor is in a touching cluster with cards outside the deck
          const nested = touchingClusters.some(c =>
            c.includes(g.id) && c.some(cid => !deck.memberIds.includes(cid))
          )
          // Stacked deck → double-click icon fully opens the deck. The icon
          // disappears in the open state, so there's no "close from icon" —
          // the body's existing UI handles re-stacking.
          const stackedDoubleClick = () => {
            useUndoCoordinator.getState().checkpoint()
            useBoardsStore.getState().setDeckState(deck.memberIds, 'open')
          }
          return (
            <Fragment key={g.id}>
              <NLETimelineHeader
                groupId={g.id}
                rightInset={deck.memberIds.length > 1 ? 10 : 0}
                iconMode={{ kind: 'deckPreview', deckId: deck.id, count: countMeaningfulContent(deck.memberIds, groups, boards), onDoubleClick: stackedDoubleClick }}
              />
              <StackedDeckCard deck={deck} anchorGroup={g} isNested={nested} />
            </Fragment>
          )
        }

        // If in a fanned deck → rendered by FannedDeckOverlay (only once for anchor)
        if (deck && treatAsFanned) {
          if (deck.anchorGroupId === g.id) {
            const memberGroups = deck.memberIds.map(id => groups.find(gr => gr.id === id)).filter(Boolean) as ProjectGroup[]
            // Wrap the anchor's header + fan overlay in a single stacking
            // context above the normal NLETimelineHeader z-index (51). Adjacent
            // cards' headers render underneath this bundle when the fan extends
            // horizontally over them. Internal z-order (primary > strips) is
            // preserved WITHIN this context, so the curve-merge effect stays.
            // Fanned deck → double-click icon fully opens the deck (same
            // semantic as the stacked-deck icon double-click: "open the
            // whole deck"). Body double-click on the fan still collapses to
            // stacked.
            const fannedDoubleClick = () => {
              useUndoCoordinator.getState().checkpoint()
              useBoardsStore.getState().setDeckState(deck.memberIds, 'open')
            }
            return (
              <div key={g.id} style={{ position: 'relative', zIndex: 55 }}>
                <NLETimelineHeader
                  groupId={g.id}
                  iconMode={{ kind: 'deckPreview', deckId: deck.id, count: countMeaningfulContent(deck.memberIds, groups, boards), onDoubleClick: fannedDoubleClick }}
                />
                <FannedDeckOverlay deck={deck} groups={memberGroups} />
              </div>
            )
          }
          return null // non-anchor fanned member — rendered by FannedDeckOverlay
        }

        // Normal open card
        return (
          <Fragment key={g.id}>
            <NLETimelineHeader groupId={g.id} iconMode={{ kind: 'hidden' }} />
            <GroupCard group={g} />
          </Fragment>
        )
      })}
      {/* Open-footprint previews — hover or select a stacked/fanned deck and
          a faint dashed outline appears at each non-anchor member's would-be
          open position. Self-gates on hover/selection state, so unconditional
          mapping is fine. */}
      {/* Canvas-only furniture. A scoped render is ONE pinned deck floating
          over the screen; footprint previews, cluster affordances and
          ungrouped boards all describe the canvas it is no longer part of. */}
      {!scoped && decks.map(d => (
        <DeckOpenPreview key={`preview-${d.id}`} deck={d} />
      ))}
      {!scoped && affordanceClusters.map(cluster => (
        <DeckAffordance key={cluster.join('|')} cluster={cluster} />
      ))}
      {!scoped && ungroupedIds.map(bid => (
        <UngroupedBoardCard key={bid} boardId={bid} />
      ))}

      {/* Tether tabs — one per extracted card (any group whose id appears in
          some other group's ghostSlots). Anchored to the card's top-left in
          the source deck's color. */}
      {!scoped && groups.map(g => {
        const parent = findExtractionParent(g.id, groups)
        if (!parent) return null
        return <TetherTab key={`tether-${g.id}`} cardId={g.id} touchingClusters={touchingClusters} />
      })}

      {/* Ghost-slot placeholders for OPEN parent decks. When the parent is
          stacked or fanned, the ghost appears as a strip in the fan render
          instead. */}
      {groups.flatMap(parent => {
        const isOpen = !parent.deckState || parent.deckState === 'open'
        if (!isOpen) return []
        // Same gate as everything else that draws per-group.
        if (onlySet) { if (!onlySet.has(parent.id)) return [] }
        else if (parent.pin) return []
        const slots = parent.ghostSlots ?? []
        return slots.map(slot => (
          <GhostCardSlot
            key={`ghost-${parent.id}-${slot.cardId}`}
            anchor={parent}
            slot={slot}
          />
        ))
      })}

      {/* ── Deck-linking layer: chip rails + parented ghost tree ── */}
      {groups.map(g => {
        // Skip hidden deck members — they aren't visible so they shouldn't
        // render chip rails either.
        if (g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id) {
          return null
        }
        // The SAME gate the card loop uses. Without it this map drew a rail
        // for every group in every Overlay instance: each pinned deck redrew
        // the whole canvas's chips through its own frozen camera, and the
        // canvas redrew the pinned card's. That is the scatter of stray "+"
        // circles — one rail per group per camera, all landing in the wrong
        // places because the camera did not match the card.
        if (onlySet) { if (!onlySet.has(g.id)) return null }
        else if (g.pin) return null
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
  // Renders INSIDE the card's rect, so it must size against the card's own
  // camera. Reading the live canvas zoom here is what made a pinned card's
  // chips and text balloon past the card while the card itself stayed small.
  const { zoom } = useCardView()

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
}> = ({ onRatioChange, visible }) => {
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
  // Frozen camera inside a pinned card, so its text scales with the CARD
  // rather than with a canvas it is no longer attached to.
  const { zoom } = useCardView()
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
