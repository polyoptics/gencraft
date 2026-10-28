// CardLayer — project/board-group overview (zoom ≤ 0.17)
// Renders one composite card per project group. Each group collapses its
// boards into a single draggable card with a hero image and summary.

import React, { useMemo, useState, useCallback, useRef, useLayoutEffect, useEffect, useDeferredValue, Fragment } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore, getUngroupedBoardIds } from '../../store/boardsStore'
import type { ProjectGroup, BoardData } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useCardView } from './cardView'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { DEFAULT_HEADER_STYLE, DEFAULT_BODY_STYLE, useFreeNodeStore } from '../../store/freeNodeStore'
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
import { useFxStore } from '../../store/fxStore'
import { cardStripId } from '../../utils/fx/cardStrips'
import { cardHitAt } from '../../utils/cardContent'
import { cardFaceMedia, deckFaceSteps, faceSteps, mergeCardsInto, setFaceThumbnail, stepDeckFace, stepFace } from '../../utils/cardGrid'
import { drawnRect, effectChain, snapEffectCard } from '../../utils/effectCards'
import { cardRailTarget, dockCardsOnRail, endDockedDrag, liftDockedCards, previewCardRail } from '../../utils/railCards'
import { EffectTileBody } from '../Canvas/EffectTileBody'
import { knownKind } from '../../utils/fx/effects'
import type { FreeNodeData } from '../../store/freeNodeStore'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import type { MediaItem } from '../../types/bar'
import { HeroImageEditOverlay } from '../UI/HeroImageEditOverlay'
import { getFirstImageUrl } from '../../types/bar'
import { groupFaceSource, groupImageSources, deckFaceSources, deckImageSources, cardGripUrl as cardGripUrlOf } from '../../utils/mediaSources'
import { DragOutGrip } from '../UI/DragOutGrip'
import { hexToHsl, hslToHex, selectionHighlight } from '../../utils/colorUtils'
import { cssUrl } from '../../utils/diskUrl'
import { useFileMenuItems, mayHaveDiskFile } from '../../hooks/useFileMenu'
import { useMenuClamp } from '../../hooks/useMenuClamp'
import { DrawableSurface } from '../Annotation/DrawableSurface'
import { PenButton } from '../Annotation/PenButton'
import { useSeedHoverFromCursor } from '../../utils/pointerTracker'
import { useContextSheetStore } from '../../store/contextSheetStore'

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
  mediaSource: string | null // file behind the picture shown — see groupFaceSource
  deckMemberIds?: string[]   // if this card is part of a deck
  deckState?: 'open' | 'fanned' | 'stacked'
  onClose: () => void
  onEditHeroImage?: () => void
}> = ({ pos, group, heroImage, mediaSource, deckMemberIds, deckState, onClose, onEditHeroImage }) => {
  const groups = useBoardsStore(s => s.groups)
  const [colorPicker, setColorPicker] = useState<{ x: number; y: number } | null>(null)
  const fileItems = useFileMenuItems(mediaSource, onClose)

  const menuItems: { label: string; icon: string; action: () => void; danger?: boolean; separator?: boolean }[] = []

  // (Deck-tether actions — "Go to deck" and "Check back in" — live on the
  // tether tint stripe in the header, not on the card-body context menu.
  // Right-click that stripe to access them.)

  // A video face: the frame it shows now becomes its thumbnail (FaceVideo).
  {
    const faceOf = group.deckState === 'stacked' && group.deckFaceCard && faceVideoEls.has(group.deckFaceCard) ? group.deckFaceCard : group.id
    const v = faceVideoEls.get(faceOf)
    const snap = faceVideoSnap.get(faceOf)
    const st = useBoardsStore.getState()
    const fg = st.groups.find(g => g.id === faceOf)
    const fm = fg ? cardFaceMedia(fg, st.boards) : null
    if (v && fm?.type === 'video') {
      if (snap) menuItems.push({ label: 'Set as thumbnail', icon: '🖼', action: () => {
        useUndoCoordinator.getState().checkpoint()
        setFaceThumbnail(faceOf, snap)
        onClose()
      }})
      if (fm.posterTime !== undefined) menuItems.push({ label: 'Reset thumbnail', icon: '↺', action: () => {
        useUndoCoordinator.getState().checkpoint()
        setFaceThumbnail(faceOf, null)
        onClose()
      }})
    }
  }

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

  // Context sheet — one image of the card (or the whole deck) for an AI:
  // pictures, name, summary and notes, sized in the dialog before it is made.
  menuItems.push({ label: 'Context sheet…', icon: '🗂', action: () => {
    onClose()
    useContextSheetStore.getState().openSheet([group.id])
  }})
  if (deckMemberIds && deckMemberIds.length >= 2) menuItems.push({ label: 'Context sheet: whole deck…', icon: '🗂', action: () => {
    onClose()
    // This card first, then the rest in deck order, then the cards of any
    // sub-deck nested in it — they are inside it, and travel with it (the
    // deck's drag-out takes them too). Set order keeps the cards you can
    // see leading.
    const ids = [group.id, ...deckMemberIds.filter(id => id !== group.id)]
    useContextSheetStore.getState().openSheet(expandWithNestedMembers(ids, useBoardsStore.getState().groups))
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
    // SINGLE CARDS ONLY. A deck is not just several cards: stacking, fanning,
    // extraction, ghost slots and per-member layout all assume the canvas
    // they sit on. Pinning one produced a deck that could be opened and not
    // closed, buttons that vanished when the deck state changed underneath
    // them, and a level switch that scattered the members. Rather than teach
    // every one of those about a second placement, a deck simply does not
    // pin — pin its cards.
    const isDeck = (g: ProjectGroup) => expandWithNestedMembers([g.id], bsNow.groups).length > 1
    const targets = base.filter(id => {
      const g = bsNow.groups.find(x => x.id === id)
      return g && !isDeck(g)
    })
    const blockedByDeck = isDeck(group)
    const many = targets.length > 1 ? ` (${targets.length})` : ''
    // Unpinning is always allowed — a pinned card must never be strandable,
    // whatever it has since joined on the canvas.
    if (group.pin || !blockedByDeck) {
      menuItems.push({
        label: group.pin ? `Drop on canvas${many}` : `Pin to screen${many}`,
        icon: group.pin ? '📤' : '📌',
        separator: true,
        action: () => {
          const cs = useCanvasStore.getState()
          useUndoCoordinator.getState().checkpoint()
          useBoardsStore.getState().setGroupPlacement(
            group.pin ? base : targets,
            group.pin ? 'canvas' : 'screen',
            { pan: cs.pan, zoom: cs.zoom })
          onClose()
        },
      })
    } else {
      // Say why, rather than leaving a missing item to be puzzled over.
      menuItems.push({
        label: 'Pin to screen — not for decks',
        icon: '📌',
        separator: true,
        action: () => onClose(),
      })
    }
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
    // Every board on the card goes with it — 'primary' too. Sparing it left
    // it behind for deleteGroup to re-home into the FIRST card, so a deleted
    // card's block reappeared inside another card. Nothing needs 'primary'
    // to exist: the canvases skip a missing board, and loading a project or
    // a template makes a fresh one.
    group.boardIds.forEach(bid => useBoardsStore.getState().deleteBoard(bid))
    useBoardsStore.getState().deleteGroup(group.id)
    onClose()
  }})

  // File on disk behind the hero — desktop app only, empty in a browser
  menuItems.push(...fileItems)
  const { ref: menuRef, top: menuTop } = useMenuClamp(pos.y, menuItems.length)

  return ReactDOM.createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={onClose} />
      <div
        ref={menuRef}
        onPointerDown={e => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: Math.min(pos.x, window.innerWidth - 200),
          top: menuTop,
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

// ── Drag-out grip on a card face ──
//
// Hands the file(s) behind a card to another app or a website's upload box.
// The face is the card's move handle, so leaving the app needs its own grip.
// You hold what you see — the face's file, then a deck's other faces; Shift
// hands every image inside instead. Desktop only: DragOutGrip renders
// nothing in a plain browser, so hosts mount this unconditionally.
//
// Top-right of the BODY, just left of the pen and at its size, so the two
// read as one pair of hover tools: below the header band, clear of the
// resize strips and the stacked deck's fan edge on the right, and of the
// summary label and chip rail along the bottom. The same spot on an open
// card, a stacked deck and a fan (which has no pen), so it does not jump
// when a deck changes state.

const CARD_TOOL_INSET = 6   // the pen's inset from the face's right edge and the header band
const CARD_TOOL_GAP = 4

const CardFaceDragOut: React.FC<{
  url: string | null
  getUrls: (o: { all: boolean }) => string[]
  allLabel: string
  visible: boolean
  /** The pen's size where it is not GroupCard's (the stacked deck's). */
  size?: number
  /** Container's right edge to the face's — non-zero only where the face
   *  does not end its container (a fan, whose strips run on past it). */
  faceRightOffset?: number
  zIndex?: number
  /** The card it is on: dropped back on the canvas, a duplicate of it. */
  card?: string
}> = ({ url, getUrls, allLabel, visible, size: sizeProp, faceRightOffset = 0, zIndex = 60, card }) => {
  // The card's camera — frozen inside a pinned card — so the grip sizes
  // with the card it is on, not with the canvas it left.
  const { zoom } = useCardView()
  // GroupCard's pen size: ~17px across card zoom, shrinking with the rest
  // of the card's chrome below CARD_FLOOR_ZOOM.
  const size = sizeProp ?? Math.min(32, Math.max(8, 16 * overviewScale(zoom), headerScreenH(zoom) * 0.85))
  return (
    <DragOutGrip
      url={url}
      getUrls={getUrls}
      allLabel={allLabel}
      size={size}
      visible={visible}
      card={card}
      style={{
        position: 'absolute',
        top: computeHeaderExtend(zoom) + CARD_TOOL_INSET,
        right: faceRightOffset + CARD_TOOL_INSET + size + CARD_TOOL_GAP,
        zIndex,
        // Dark-backed: it sits on the hero image.
        background: 'rgba(0,0,0,0.45)',
      }}
    />
  )
}

/** A deck's drag-out urls, read from the live store at dragstart. `ids` in
 *  hand-over order, front card first. Shift reaches into nested sub-decks
 *  too (after the cards you can see) — they are inside it, and travel
 *  with it; the faces are only the cards the deck shows. */
function deckDragOutUrls(ids: string[], all: boolean): string[] {
  const { groups, boards } = useBoardsStore.getState()
  const members = (all ? expandWithNestedMembers(ids, groups) : ids)
    .map(id => groups.find(g => g.id === id)).filter(Boolean) as ProjectGroup[]
  return all ? deckImageSources(members, boards) : deckFaceSources(members, boards)
}

/** The url a deck's grip leads with: the first face that can be a file on
 *  disk, else the first such image inside any of its cards. So the grip is
 *  there whenever the deck has anything to give — not only when its front
 *  card shows a picture of its own (a text card, or a poster hero, shows
 *  none) — and the front face still leads when it has one. */
function deckGripUrl(ids: string[]): string | null {
  // No desktop bridge, no grip — and no reason to walk every member's bars
  // on each pan/zoom render to find out.
  if (!mayHaveDiskFile('/')) return null
  return deckDragOutUrls(ids, false).find(mayHaveDiskFile)
    ?? deckDragOutUrls(ids, true).find(mayHaveDiskFile)
    ?? null
}

/** The url a card's grip leads with — deckGripUrl's rule for one card. */
function cardGripUrl(g: ProjectGroup, boards: Record<string, BoardData>): string | null {
  return cardGripUrlOf(g, boards, mayHaveDiskFile)
}

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

    // Expand to include nested sub-deck members — and the effect cards lined
    // up to the right of each card dragged (utils/effectCards): they travel
    // with the card they process, and those after a dragged effect card
    // travel with it.
    const picked = alreadySelected ? [...bs0.selectedGroupIds] : [group.id]
    const chains = picked.flatMap(id => effectChain(id, bs0.groups, bs0.boards))
    const draggingIds = expandWithNestedMembers([...new Set([...picked, ...chains])], bs0.groups)
    // An effect card's own box at the press: let go, it slides along the
    // edge it was already on rather than jumping back to the top.
    const startRect = group.effect ? drawnRect(group, bs0.boards, useCanvasStore.getState().zoom) : null

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
    const obstacles = canvasObstacleGroups(bs0.groups, draggingSet)
      .map(g => groupSlot(g.id, g.boardIds, bs0.boards, g.originX, g.originY, computeGroupLayout(g.boardIds, bs0.boards)))
      .filter(Boolean) as import('../../utils/nlePush').GroupSlot[]

    // A card on a loop strip is lifted off its column as the drag starts
    // (utils/railCards), so the strip stops holding it in place.
    let railLifted = false
    const onMove = (ev: PointerEvent) => {
      if (!railLifted) { railLifted = true; liftDockedCards(draggingIds) }
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
      // Over a loop strip: where it would go (utils/railCards).
      previewCardRail(cardRailTarget(draggingIds, ev.clientX, ev.clientY), group.id)
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setIsDragging(false)
      // Let go over a loop strip (utils/railCards): picture cards go into
      // the column as themselves, left to right as they lay — the strip
      // places them; effect cards move into the row (the strip keeps their
      // effect, settings and switches; the cards go). The press took the
      // checkpoint: one undo puts it all back.
      const railT = !group.pin && (dxAccum !== 0 || dyAccum !== 0) ? cardRailTarget(draggingIds, ev.clientX, ev.clientY) : null
      previewCardRail(null, group.id)
      if (railT) {
        useBoardsStore.getState().setGroupPosBatch(Array.from(initialOrigins, ([gid, o]) => ({ groupId: gid, originY: o.y, originX: o.x })))
        const at = (id: string) => initialOrigins.get(id) ?? { x: 0, y: 0 }
        const order = [...draggingIds].sort((a, b) => (at(a).x - at(b).x) || (at(a).y - at(b).y))
        const before = new Set(Object.keys(useFreeNodeStore.getState().nodes))
        dockCardsOnRail(order, railT)
        // Effect cards let go on a strip's row MOVE there: the strip's new
        // steps take their switches too (in the same order), and the cards go.
        if (railT.kind === 'row') {
          const bs = useBoardsStore.getState()
          const fx = order.map(gid => bs.groups.find(x => x.id === gid)).filter((g): g is ProjectGroup => !!g?.effect)
          const fns = useFreeNodeStore.getState()
          const made = Object.values(fns.nodes)
            .filter(n => !before.has(n.id) && n.type === 'effect' && n.railDock?.railId === railT.railId)
            .sort((a, b) => (fns.nodes[railT.railId]?.rail?.slots.findIndex(s => s.id === a.railDock!.slotId) ?? 0)
              - (fns.nodes[railT.railId]?.rail?.slots.findIndex(s => s.id === b.railDock!.slotId) ?? 0))
          made.forEach((n, i) => {
            const src = fx[i]?.effect
            if (src && (src.off || src.solo)) fns.updateFreeNode(n.id, { effect: { ...n.effect!, off: src.off, solo: src.solo } })
          })
          for (const g of fx) {
            g.boardIds.forEach(bid => useBoardsStore.getState().deleteBoard(bid))
            useBoardsStore.getState().deleteGroup(g.id)
          }
        }
        useMagnetPreviewStore.getState().setPreview(null)
        return
      }
      // Off a strip: a docked card stays where it was let go.
      endDockedDrag(draggingIds, dxAccum !== 0 || dyAccum !== 0)
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
      // Cards-first: let go with the pointer over ANOTHER card and what was
      // dragged merges into it as blocks (utils/cardGrid). Cards never
      // overlap while dragged — the drag is clamped against them — so the
      // pointer reaching into a card is the gesture. One undo step: the
      // press took the checkpoint. A click, or a release over the dragged
      // card itself, is just a move.
      // An effect card let go by a card's right edge snaps flush there and
      // rides the edge (utils/effectCards) — and is never merged as a block.
      if (!returnedToDeck && !group.pin && group.effect) {
        if (dxAccum !== 0 || dyAccum !== 0) {
          const after = effectChain(group.id).filter(id => draggingIds.includes(id))
          snapEffectCard(group.id, startRect, after, new Set(draggingIds))
        }
        useMagnetPreviewStore.getState().setPreview(null)
        return
      }
      if (!returnedToDeck && !group.pin && (dxAccum !== 0 || dyAccum !== 0)) {
        const own = new Set(draggingIds)
        const under = els.filter(el => {
          const c = (el as HTMLElement).closest?.('[data-layer-card]') as HTMLElement | null
          return !(c && own.has(c.dataset.layerCard ?? ''))
        })
        const hit = cardHitAt(under)
        const into = hit && 'groupId' in hit ? hit.groupId : null
        if (into && !own.has(into) && mergeCardsInto(into, draggingIds)) {
          useMagnetPreviewStore.getState().setPreview(null)
          return
        }
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

  // The face (utils/cardGrid): the block it has been stepped to, else the
  // hero, else the first picture or video — the same choice effects on
  // the card process. A video face scrubs under the pointer (FaceVideo);
  // its poster stands in wherever a picture is needed.
  const faceItem = useMemo(() => cardFaceMedia(group, boards), [group, boards])
  const heroImage = faceItem?.type === 'image' ? faceItem.url : (faceItem?.posterUrl ?? null)
  const faceVideo = faceItem?.type === 'video' ? faceItem : null
  const steps = useMemo(() => faceSteps(group, boards), [group, boards])
  // Effects snapped to the card (utils/fx/cardStrips): the face shows its
  // picture through them, the way a picture tile does. The result goes in
  // as the hero's own image, so the face's crop, zoom and flips apply to
  // it unchanged. Re-encoded only when the strip's result changes — small,
  // for a face — never per pan or zoom frame.
  const { fxId, fxStrip, fxOff, fxFace } = useCardFxFace(group.id)
  const shownHero = fxFace && !fxOff ? fxFace : heroImage
  // Memoised: when the face is not a file this walks every bar, and the
  // card re-renders on every pan and zoom frame.
  const gripUrl = useMemo(() => cardGripUrl(group, boards), [group, boards])

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
        {group.effect ? (
          <div style={{ position: 'absolute', top: headerPad, left: 0, right: 0, bottom: 0, overflow: 'hidden', borderRadius: '0 0 12px 12px', display: 'flex', flexDirection: 'column' }}>
            <EffectCardFace group={group} width={screenWidth} height={Math.max(1, cardHeight - headerPad)} />
          </div>
        ) : (<>
        {faceVideo && !(fxFace && !fxOff)
          ? <FaceVideo key={faceVideo.url} media={faceVideo} cardId={group.id} scale={overviewScale(zoom)} />
          : shownHero && <HeroImageLayer heroImage={shownHero} transform={group.cardHeroTransform} />}
        {/* Step the face through the card's blocks, in reading order. */}
        {isHovered && steps.count > 1 && (
          <>
            <FaceArrow side="left" scale={overviewScale(zoom)} onStep={() => stepFace(group.id, -1)} />
            <FaceArrow side="right" scale={overviewScale(zoom)} onStep={() => stepFace(group.id, 1)} />
            <div data-card-face-count style={{
              position: 'absolute', zIndex: 3, left: 0, right: 0, bottom: 6, textAlign: 'center', pointerEvents: 'none',
              fontSize: 10 * overviewScale(zoom), fontWeight: 700, color: 'rgba(255,255,255,0.85)',
              textShadow: '0 1px 3px rgba(0,0,0,0.85)',
            }}>{steps.index + 1} / {steps.count}</div>
          </>
        )}
        {/* Effects on this card: flip to the original and back. */}
        {fxStrip && fxFace && (
          <button
            type="button"
            data-card-fx-toggle
            title={fxOff ? 'Showing the original — click to show the effects' : 'Showing the effects — click for the original'}
            onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}
            onDoubleClick={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); useFxStore.getState().setBypass(fxId, !fxOff) }}
            style={{
              position: 'absolute', zIndex: 3, right: 8, bottom: 6,
              fontSize: 10 * overviewScale(zoom), lineHeight: 1.25, fontWeight: 700, fontFamily: 'inherit',
              padding: '1px 7px', borderRadius: 10, cursor: 'pointer',
              background: fxOff ? 'rgba(12,13,20,0.55)' : 'rgba(12,13,20,0.72)',
              color: fxOff ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.92)',
              border: `1px solid rgba(255,255,255,${fxOff ? 0.22 : 0.38})`,
              textShadow: '0 1px 2px rgba(0,0,0,0.6)', whiteSpace: 'nowrap',
            }}
          >{fxOff ? 'original' : 'fx'}</button>
        )}
        {/* Content area — offset below header extension */}
        <div style={{ position: 'absolute', top: headerPad, left: 0, right: 0, bottom: 0, overflow: 'hidden', borderRadius: '0 0 12px 12px' }}>
          <GroupCardText groupId={group.id} onCropImage={() => setIsEditingHero(true)} heroImage={heroImage} />
          <div style={{
            position: 'absolute', bottom: 6, left: 8, zIndex: 2,
            color: 'rgba(255,255,255,0.7)', fontSize: 11 * overviewScale(zoom), fontWeight: 600,
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {group.cardSummary || `${group.boardIds.length} block${group.boardIds.length !== 1 ? 's' : ''}`}
          </div>
        </div>
        </>)}
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

        {/* Drag-out — this card's face; Shift, every image in it. */}
        <CardFaceDragOut
          card={group.id}
          url={gripUrl}
          getUrls={({ all }) => {
            if (!all) return []
            const bs = useBoardsStore.getState()
            const g = bs.groups.find(gr => gr.id === group.id)
            return g ? groupImageSources(g, bs.boards) : []
          }}
          allLabel="every image in this card"
          visible={isHovered}
        />
      </div>

      {cardMenu && (
        <CardContextMenu pos={cardMenu} group={group} heroImage={heroImage} mediaSource={groupFaceSource(group, boards)} onClose={() => setCardMenu(null)} onEditHeroImage={() => setIsEditingHero(true)} />
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

import { useCardDecks, isHiddenDeckMember, isSubDeckAnchor, expandWithNestedMembers, cardVisualRect, canvasObstacleGroups, type Deck } from '../../hooks/useCardDecks'

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
  // The deck's face steps through every picture of every card in it
  // (utils/cardGrid deckFaceSteps); `deckFace.card` is the one it shows.
  const deckFace = useMemo(() => deckFaceSteps(anchorGroup, deck.memberIds, groups, boards), [anchorGroup, deck.memberIds, groups, boards])
  // Effects on that card show on the deck's face too — hooked here, above
  // the early return, so the hook order never changes.
  const deckFx = useCardFxFace(deckFace.card.id)

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
    const obstacles = canvasObstacleGroups(bs0.groups, draggingSet)
      .map(g => groupSlot(g.id, g.boardIds, bs0.boards, g.originX, g.originY, computeGroupLayout(g.boardIds, bs0.boards)))
      .filter(Boolean) as import('../../utils/nlePush').GroupSlot[]

    // A deck on a loop strip is lifted off its column as the drag starts.
    let railLifted = false
    const onMove = (ev: PointerEvent) => {
      if (!railLifted) { railLifted = true; liftDockedCards([deck.anchorGroupId]) }
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
      // Over a loop strip: where the deck would go (utils/railCards).
      previewCardRail(cardRailTarget(allDragIds, ev.clientX, ev.clientY), deck.anchorGroupId)
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      // A deck let go over a loop strip goes into the column as ONE deck,
      // by its front card (utils/railCards). One undo puts it back.
      {
        const railT = (dxAccum !== 0 || dyAccum !== 0) ? cardRailTarget(allDragIds, ev.clientX, ev.clientY) : null
        previewCardRail(null, deck.anchorGroupId)
        if (railT) {
          useBoardsStore.getState().setGroupPosBatch(Array.from(initialOrigins, ([gid, o]) => ({ groupId: gid, originY: o.y, originX: o.x })))
          dockCardsOnRail([deck.anchorGroupId], railT)
          useMagnetPreviewStore.getState().setPreview(null)
          return
        }
        endDockedDrag([deck.anchorGroupId], dxAccum !== 0 || dyAccum !== 0)
      }
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

  // The shown card's face, by the face rule (utils/cardGrid): the block it
  // was stepped to, else its hero, else its first picture (a video by its
  // poster). Effects on it draw over this (deckFx).
  const faceCard = deckFace.card
  const faceItem = useMemo(() => cardFaceMedia(faceCard, boards), [faceCard, boards])
  const heroImage = faceItem ? (faceItem.type === 'image' ? faceItem.url : faceItem.posterUrl ?? null) : null
  // A video face plays here as on the card itself (FaceVideo).
  const faceVideo = faceItem?.type === 'video' && !deckFx.shown ? faceItem : null

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
          {faceVideo
            ? <FaceVideo key={faceVideo.url} media={faceVideo} cardId={anchorGroup.id} faceOf={faceCard.id} scale={overviewScale(zoom)} />
            : (deckFx.shown ?? heroImage) && <HeroImageLayer heroImage={(deckFx.shown ?? heroImage)!} transform={faceCard.cardHeroTransform} />}
          {/* Step the face through every card's pictures, in deck order. */}
          {isHovered && deckFace.entries.length > 1 && (
            <>
              <FaceArrow side="left" scale={overviewScale(zoom)} onStep={() => stepDeckFace(anchorGroup.id, deck.memberIds, -1)} />
              <FaceArrow side="right" scale={overviewScale(zoom)} onStep={() => stepDeckFace(anchorGroup.id, deck.memberIds, 1)} />
              <div data-deck-face-count style={{
                position: 'absolute', zIndex: 3, left: 0, right: 0, bottom: 22 * overviewScale(zoom), textAlign: 'center', pointerEvents: 'none',
                fontSize: 10 * overviewScale(zoom), fontWeight: 700, color: 'rgba(255,255,255,0.85)',
                textShadow: '0 1px 3px rgba(0,0,0,0.85)',
              }}>{deckFace.index + 1} / {deckFace.entries.length}</div>
            </>
          )}
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

          {/* Drag-out — ONE grip for the whole deck: the front face, then
              the faces behind it; Shift, every image in every card. Sized to
              this pen, which keeps its own (unscaled) formula above. Inside
              the face, so its stopped press never reaches onDeckDown. */}
          {(() => {
            const ids = [anchorGroup.id, ...deck.memberIds.filter(id => id !== anchorGroup.id)]
            return (
              <CardFaceDragOut
                url={deckGripUrl(ids)}
                getUrls={({ all }) => deckDragOutUrls(ids, all)}
                allLabel="every image in every card of this deck"
                visible={isHovered}
                size={Math.min(32, Math.max(16, Math.max(NLE_HEADER_CANVAS_H * zoom, 20) * 0.85))}
              />
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
          mediaSource={groupFaceSource(anchorGroup, boards)}
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
  const [isHovered, setIsHovered] = useState(false)
  const fanHoverRef = useRef<HTMLDivElement>(null)
  // Seed hover as the stacked card does, so the drag-out grip is there when
  // the fan swaps in under a still cursor (a click on the stack's edge).
  useSeedHoverFromCursor(fanHoverRef, setIsHovered)
  // faceId: whose picture was under the cursor — see faceUnderCursor
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; faceId: string } | null>(null)
  const [surfacedId, setSurfacedId] = useState<string | null>(null)
  const [isEditingHero, setIsEditingHero] = useState(false)

  // Refs to each strip — used for imperative animation when this deck is in
  // an active fan ↔ stack transition. Keyed by strip id (member group id or
  // ghost cardId) so we can map secondaryItems → DOM nodes consistently.
  const stripRefs = useRef(new Map<string, HTMLDivElement>())

  const anchorGroup = groups.find(g => g.id === deck.anchorGroupId)
  // Effects on the front card show on the fan's face too — hooked here,
  // above every early return, so the hook order never changes.
  const deckFx = useCardFxFace(anchorGroup?.id ?? '')
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
  // The front card's face, by the face rule (see StackedDeckCard).
  const heroImage = (() => {
    const m = cardFaceMedia(anchorGroup, boards)
    return m ? (m.type === 'image' ? m.url : m.posterUrl ?? null) : null
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
    const obstacles = canvasObstacleGroups(bs0.groups, draggingSet)
      .map(g => groupSlot(g.id, g.boardIds, bs0.boards, g.originX, g.originY, computeGroupLayout(g.boardIds, bs0.boards)))
      .filter(Boolean) as import('../../utils/nlePush').GroupSlot[]

    const onMove = (ev: PointerEvent) => {
      if (!fanMoved && Math.abs(ev.clientX - fanStartX) + Math.abs(ev.clientY - fanStartY) > 5) {
        fanMoved = true
        // A fan on a loop strip is lifted off its column (utils/railCards).
        liftDockedCards([deck.anchorGroupId])
      }
      if (fanMoved) previewCardRail(cardRailTarget(allDragIds, ev.clientX, ev.clientY), deck.anchorGroupId)
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
      // Let go over a loop strip: the fan goes into the column as one deck,
      // as a closed deck does; anywhere else it stays where it was let go.
      {
        const railT = cardRailTarget(allDragIds, ev.clientX, ev.clientY)
        previewCardRail(null, deck.anchorGroupId)
        if (railT) {
          useBoardsStore.getState().setGroupPosBatch(Array.from(initialOrigins, ([gid, o]) => ({ groupId: gid, originY: o.y, originX: o.x })))
          dockCardsOnRail([deck.anchorGroupId], railT)
          return
        }
        endDockedDrag([deck.anchorGroupId], true)
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

  // Whose picture a right-click landed on. The card menu's own actions all
  // act on the anchor, but its file items should name the picture under
  // the cursor: a strip shows its own card (ghosts included); anywhere else
  // is the face, which is the surfaced member while one is up. Use
  // surfacedGroup, not effectiveSurfacedId: a portal lock can outlive its
  // member leaving the deck, and the face then falls back to the anchor.
  const faceUnderCursor = (target: EventTarget): string => {
    for (const item of secondaryItems) {
      const el = stripRefs.current.get(item.kind === 'ghost' ? `ghost-${item.cardId}` : item.group.id)
      if (el?.contains(target as Node)) return item.kind === 'ghost' ? item.cardId : item.group.id
    }
    return surfacedGroup?.id ?? anchorGroup.id
  }
  // A deleted ghost's card resolves to nothing — no file items, not the anchor's.
  const menuFace = cardMenu ? allGroups.find(g => g.id === cardMenu.faceId) ?? null : null

  return (
    <>
      {/* Single hover wrapper — primary card + strips + controls */}
      <div
      ref={fanHoverRef}
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
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setCardMenu({ x: e.clientX, y: e.clientY, faceId: faceUnderCursor(e.target) }) }}
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
                  backgroundImage: cssUrl(ghostHero),
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
            // Media dropped here goes into the card this strip SHOWS, not
            // the deck's anchor (utils/cardContent). Not data-link-drop:
            // linking onto a fan still means the deck.
            data-card-drop={sc.id}
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
                backgroundImage: cssUrl(scHero),
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
        // The surfaced overlay above takes no pointer, so a drop on the
        // face lands HERE — and goes into the card the face is showing:
        // the surfaced (portal-locked) member while one is up.
        data-card-drop={(surfacedGroup ?? anchorGroup).id}
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
        {(deckFx.shown ?? heroImage) && <HeroImageLayer heroImage={(deckFx.shown ?? heroImage)!} transform={anchorGroup.cardHeroTransform} />}
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

      {/* Drag-out — the same deck grip as the stacked card, on the face as
          it rests: the portal-locked member while one is locked (the face
          shows it), else the anchor; then the rest in fan order. Not the
          hovered strip's — the cursor has left the strip to reach the grip.
          A SIBLING of the primary, not a child: the primary drops beneath
          the surfaced overlay (20) while a portal is locked, and would take
          the grip under with it. So it sits above both, and is offset past
          the strips that run on to the wrapper's right edge. */}
      {(() => {
        const fanIds = [anchorGroup.id, ...secondaryItems.flatMap(it => it.kind === 'real' ? [it.group.id] : [])]
        const frontId = portalMemberId && fanIds.includes(portalMemberId) ? portalMemberId : anchorGroup.id
        const ids = [frontId, ...fanIds.filter(id => id !== frontId)]
        return (
          <CardFaceDragOut
            url={deckGripUrl(ids)}
            getUrls={({ all }) => deckDragOutUrls(ids, all)}
            allLabel="every image in every card of this deck"
            visible={isHovered}
            faceRightOffset={totalFanWidth - screenWidth}
            zIndex={Math.max(21, secondaryItems.length + 3)}
          />
        )
      })()}

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
        mediaSource={menuFace ? groupFaceSource(menuFace, boards) : null}
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

/** An effect card's face (utils/effectCards): the effect's sliders, the
 *  same face an effect tile has. Its values live on the card. */
const EffectCardFace: React.FC<{ group: ProjectGroup; width: number; height: number }> = ({ group, width, height }) => {
  const id = cardStripId(group.id)
  const kind = knownKind(group.effect?.kind)
  // The face reads a tile; an effect card hands it one made of the card.
  const node = useMemo(() => ({
    id, type: 'effect', x: 0, y: 0, width, height, label: group.name,
    effect: { kind, params: group.effect?.params ?? {}, text: group.effect?.text, off: group.effect?.off, solo: group.effect?.solo },
  }) as unknown as FreeNodeData, [id, width, height, group.name, kind, group.effect?.params, group.effect?.text, group.effect?.off, group.effect?.solo])
  const read = useCallback(() => {
    const g = useBoardsStore.getState().groups.find(x => x.id === group.id)
    return g?.effect ? { kind: knownKind(g.effect.kind), stored: g.effect.params, text: g.effect.text, off: g.effect.off, solo: g.effect.solo } : null
  }, [group.id])
  const update = useCallback((_: string, patch: Partial<FreeNodeData>) => {
    if (!patch.effect && patch.label === undefined) return
    useBoardsStore.setState(st => ({
      groups: st.groups.map(g => g.id !== group.id ? g : {
        ...g,
        ...(patch.effect ? { effect: { kind: knownKind(patch.effect.kind), params: patch.effect.params ?? {}, text: patch.effect.text, off: patch.effect.off, solo: patch.effect.solo } } : {}),
        ...(patch.label !== undefined ? { name: patch.label } : {}),
      }),
    }))
  }, [group.id])
  return <EffectTileBody node={node} id={id} updateFreeNode={update} read={read} />
}

/** A video on a card's face — an open card, a closed deck's front, a card
 *  on a loop strip: the same player everywhere. It shows its first frame
 *  with ▶ (no autoplay), loops, starts muted (🔇 toggles), and has a thin
 *  bar along the bottom to click or drag through it. Paused, the pointer
 *  scrubs it as it moves; playing, it does not. Space plays and pauses it
 *  while its card (`cardId`) is the one selected. It pauses itself when it
 *  goes off-screen or the zoom makes it tiny, so many faces never all
 *  decode at once. Keyed by its url where it is used: stepping to another
 *  block mounts a fresh, paused one. */
const FACE_VIDEO_MIN_PX = 48
/** Screen px the progress bar starts in from the face's left edge: past
 *  the reference chips there. */
const FACE_BAR_INSET = 40
/** The video on each card's face, by the card whose face it is, and the
 *  frame it showed when the card was last right-clicked — for the card
 *  menu's "Set as thumbnail" (by the time the menu is used, the pointer
 *  has left the face and it is back at rest). */
const faceVideoEls = new Map<string, HTMLVideoElement>()
const faceVideoSnap = new Map<string, { time: number; url: string }>()

/** The frame a video shows now, as a small JPEG data: url (CLAUDE.md §6). */
function videoFrameUrl(v: HTMLVideoElement): string | null {
  const w = v.videoWidth, h = v.videoHeight
  if (!(w > 0 && h > 0)) return null
  const k = Math.min(1, 1024 / Math.max(w, h))
  const c = document.createElement('canvas')
  c.width = Math.round(w * k)
  c.height = Math.round(h * k)
  const g = c.getContext('2d')
  if (!g) return null
  g.drawImage(v, 0, 0, c.width, c.height)
  try {
    const url = c.toDataURL('image/jpeg', 0.9)
    return url.length > 64 ? url : null
  } catch { return null }
}

export const FaceVideo: React.FC<{
  media: MediaItem; cardId: string; faceOf?: string; scale: number
  /** Where the buttons and the bar sit: along the bottom (a card face), or
   *  along the top where the bottom is covered (the card browser, whose
   *  next card lies over this one's lower half). */
  chrome?: 'bottom' | 'top'
  /** Space past the left end of a top bar (the browser's own chrome). */
  topInset?: number
}> = ({ media, cardId, faceOf, scale, chrome = 'bottom', topInset = 0 }) => {
  const src = useResolvedMedia(media.url)
  const ref = useRef<HTMLVideoElement>(null)
  const owner = faceOf ?? cardId
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(true)
  const [progress, setProgress] = useState(0)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    faceVideoEls.set(owner, v)
    return () => { if (faceVideoEls.get(owner) === v) faceVideoEls.delete(owner) }
  }, [owner])
  // At rest it shows its thumbnail's frame (or the first).
  const rest = media.posterTime ?? 0
  const toRest = () => {
    const v = ref.current
    if (v && v.paused && v.duration > 0 && Math.abs(v.currentTime - rest) > 0.01) {
      v.currentTime = Math.min(rest, v.duration)
      setProgress(v.currentTime / v.duration)
    }
  }
  const toRestRef = useRef(toRest)
  const ownerRef = useRef(owner)
  useLayoutEffect(() => { toRestRef.current = toRest; ownerRef.current = owner })
  // A new thumbnail chosen: show it now.
  useEffect(() => { toRestRef.current() }, [rest])
  const k = Math.max(0.7, scale)

  const play = useCallback((on: boolean) => {
    const v = ref.current
    if (!v) return
    if (on) {
      const r = v.getBoundingClientRect()
      if (r.width < FACE_VIDEO_MIN_PX) return
      void v.play().catch(() => setPlaying(false))
    } else v.pause()
  }, [])

  // Space, while this card is the one selected — on release, and only if
  // the space was not held to pan the canvas (InfiniteCanvas: space+drag).
  useEffect(() => {
    let down = false, dragged = false
    const typing = () => {
      const t = document.activeElement as HTMLElement | null
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
    }
    const mine = () => {
      const sel = useBoardsStore.getState().selectedGroupIds
      return sel.length === 1 && sel[0] === cardId && useFreeNodeStore.getState().selectedIds.length === 0
    }
    const onDown = (e: KeyboardEvent) => { if (e.code === 'Space' && !e.repeat && !typing() && mine()) { down = true; dragged = false } }
    const onPtr = () => { if (down) dragged = true }
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !down) return
      down = false
      if (dragged || !mine()) return
      const v = ref.current
      if (v) play(v.paused)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('pointerdown', onPtr, true)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('pointerdown', onPtr, true)
    }
  }, [cardId, play])

  // Hover-scrub while not playing: left edge the start, right edge the end.
  // Listened for on the face, not the video — the card's text layer lies
  // over the video and takes the pointer. Leaving goes back to the rest.
  useEffect(() => {
    const v = ref.current
    const face = v?.parentElement
    if (!v || !face) return
    const move = (e: PointerEvent) => {
      if (!v.paused || !(v.duration > 0) || e.buttons) return
      if ((e.target as Element).closest('[data-face-video-bar],[data-face-video-play],[data-face-video-sound],[data-card-face-arrow]')) return
      const r = v.getBoundingClientRect()
      v.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))) * v.duration
      setProgress(v.currentTime / v.duration)
    }
    const leave = () => toRestRef.current()
    const snap = () => {
      const url = videoFrameUrl(v)
      if (url) faceVideoSnap.set(ownerRef.current, { time: v.currentTime, url })
    }
    face.addEventListener('pointermove', move)
    face.addEventListener('pointerleave', leave)
    face.addEventListener('contextmenu', snap, true)
    return () => {
      face.removeEventListener('pointermove', move)
      face.removeEventListener('pointerleave', leave)
      face.removeEventListener('contextmenu', snap, true)
    }
  }, [])

  // Off-screen, or too small to see: paused.
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const io = new IntersectionObserver(([en]) => { if (!en.isIntersecting && !v.paused) v.pause() })
    io.observe(v)
    const ro = new ResizeObserver(() => { if (v.getBoundingClientRect().width < FACE_VIDEO_MIN_PX && !v.paused) v.pause() })
    ro.observe(v)
    return () => { io.disconnect(); ro.disconnect() }
  }, [])

  const seekTo = (clientX: number, bar: HTMLElement) => {
    const v = ref.current
    if (!v || !(v.duration > 0)) return
    const r = bar.getBoundingClientRect()
    v.currentTime = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))) * v.duration
    setProgress(v.currentTime / v.duration)
  }
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  const btn = (s: number): React.CSSProperties => ({
    width: s, height: s, padding: 0, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.35)',
    background: 'rgba(12,13,20,0.6)', color: 'rgba(255,255,255,0.92)', fontSize: s * 0.5, lineHeight: 1,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit',
  })
  const barH = 4 * k
  return (
    <>
      <video
        ref={ref}
        data-card-face-video
        src={src ?? undefined}
        muted={muted}
        loop
        playsInline
        preload="metadata"
        poster={media.posterUrl}
        onLoadedMetadata={toRest}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={e => { const v = e.currentTarget; if (v.duration > 0) setProgress(v.currentTime / v.duration) }}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', borderRadius: 12, opacity: 0.85 }}
      />
      <div style={{ position: 'absolute', zIndex: 3, right: 6 * k, ...(chrome === 'top' ? { top: barH + 6 * k + topInset } : { bottom: barH + 6 * k }), display: 'flex', gap: 4 * k }}>
        <button
          type="button" data-face-video-play title={playing ? 'Pause (Space)' : 'Play (Space)'}
          onPointerDown={stop} onDoubleClick={stop}
          onClick={e => { e.stopPropagation(); play(!playing) }}
          style={btn(22 * k)}
        >{playing ? '❚❚' : '▶'}</button>
        <button
          type="button" data-face-video-sound title={muted ? 'Sound on' : 'Mute'}
          onPointerDown={stop} onDoubleClick={stop}
          onClick={e => { e.stopPropagation(); setMuted(m => !m) }}
          style={btn(18 * k)}
        >{muted ? '🔇' : '🔊'}</button>
      </div>
      <div
        data-face-video-bar
        onPointerDown={e => {
          if (e.button !== 0) return
          e.stopPropagation()
          e.currentTarget.setPointerCapture(e.pointerId)
          seekTo(e.clientX, e.currentTarget)
        }}
        onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seekTo(e.clientX, e.currentTarget) }}
        onDoubleClick={stop}
        style={{
          // Starts clear of the reference chips hanging off the card's
          // bottom-left edge (PrimaryChipRail), so 0% can be clicked.
          position: 'absolute', zIndex: 3, height: barH + 6 * k, cursor: 'pointer', display: 'flex',
          ...(chrome === 'top'
            ? { left: 0, right: 0, top: 0, alignItems: 'flex-start' }
            : { left: FACE_BAR_INSET * k, right: 0, bottom: 0, alignItems: 'flex-end' }),
        }}
      >
        <div style={{ width: '100%', height: barH, background: 'rgba(255,255,255,0.18)', borderRadius: chrome === 'top' ? '6px 6px 0 0' : '0 0 12px 0', overflow: 'hidden' }}>
          <div style={{ width: `${progress * 100}%`, height: '100%', background: 'rgba(255,255,255,0.85)' }} />
        </div>
      </div>
    </>
  )
}

/** ‹ / › on a card's face: the previous or next block. Its own press — it
 *  neither drags nor selects the card. */
const FaceArrow: React.FC<{ side: 'left' | 'right'; scale: number; onStep: () => void }> = ({ side, scale, onStep }) => {
  const s = 22 * Math.max(0.7, scale)
  return (
    <button
      type="button"
      data-card-face-arrow={side}
      title={side === 'left' ? 'Previous block (←)' : 'Next block (→)'}
      onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}
      onDoubleClick={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onStep() }}
      style={{
        position: 'absolute', zIndex: 3, top: '50%', [side]: 4, width: s, height: s, marginTop: -s / 2,
        borderRadius: '50%', border: '1px solid rgba(255,255,255,0.35)', background: 'rgba(12,13,20,0.6)',
        color: 'rgba(255,255,255,0.92)', fontSize: s * 0.7, lineHeight: 1, padding: 0, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit',
      }}
    >{side === 'left' ? '‹' : '›'}</button>
  )
}

/** Effects on a card (utils/fx/cardStrips): its face picture as processed,
 *  as a small data url, and whether its fx toggle shows the original.
 *  `shown` is what a face should draw instead of its picture, or null.
 *  Every face of the card — open, at the front of a stacked deck, at the
 *  front of a fan — draws the same. */
function useCardFxFace(groupId: string) {
  const fxId = cardStripId(groupId)
  const fxKey = useFxStore(s => s.sources[fxId])
  const fxStrip = useFxStore(s => (fxKey ? s.strips[fxKey] : undefined))
  const fxOff = useFxStore(s => !!s.bypass[fxId])
  const fxCanvas = fxStrip?.result?.outputs.find(o => o.sourceId === fxId)?.canvas ?? null
  const fxFace = useMemo(() => (fxCanvas ? faceDataUrl(fxCanvas) : null), [fxCanvas])
  return { fxId, fxStrip, fxOff, fxFace, shown: fxFace && !fxOff ? fxFace : null }
}

/** A card face's copy of its effect result: a JPEG no larger than a face
 *  is ever drawn (a card face, not a full-size render). Generated media is
 *  a data: url (CLAUDE.md, invariant 6). */
function faceDataUrl(src: HTMLCanvasElement): string | null {
  const MAX = 1024
  const k = Math.min(1, MAX / Math.max(src.width, src.height, 1))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(src.width * k))
  c.height = Math.max(1, Math.round(src.height * k))
  const g = c.getContext('2d')
  if (!g) return null
  g.drawImage(src, 0, 0, c.width, c.height)
  const url = c.toDataURL('image/jpeg', 0.9)
  return url.length > 64 ? url : null
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

/** Affordance shown when open cards are touching — hover on primary shows outline + stack/fan.
 *  `front` is what the primary is drawn as (see Overlay's affordanceFront):
 *  a plain card, a stacked deck it anchors, or null for anything drawn
 *  above this zone. */
const DeckAffordance: React.FC<{ cluster: string[]; front: Deck | 'card' | null }> = ({ cluster, front }) => {
  // Frozen inside a pinned deck — this control travels WITH the deck, so it
  // has to be measured by the deck's own camera or it lands elsewhere.
  const { pan, zoom } = useCardView()
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
  const primaryGroup = groups.find(gr => gr.id === primary.gid)

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
        {/* Drag-out for the face under this zone. The zone covers it (41
            over the card's 40), so that face's own grip never gets the
            hover, and a press on it lands here as a cluster move — so the
            grip lives here, where the hover is. The zone's rect is the
            card's, header band included, so it lands in the same spot. It
            stops its own press, click and double-click: neither the
            cluster drag nor stack-on-double-click fires from it. */}
        {primaryGroup && front === 'card' && (
          <CardFaceDragOut
            url={isHovered ? cardGripUrl(primaryGroup, boards) : null}
            getUrls={({ all }) => {
              if (!all) return []
              const bs = useBoardsStore.getState()
              const g = bs.groups.find(gr => gr.id === primaryGroup.id)
              return g ? groupImageSources(g, bs.boards) : []
            }}
            allLabel="every image in this card"
            visible={isHovered}
          />
        )}
        {primaryGroup && front && front !== 'card' && (
          <CardFaceDragOut
            url={deckGripUrl([front.anchorGroupId, ...front.memberIds.filter(id => id !== front.anchorGroupId)])}
            getUrls={({ all }) => deckDragOutUrls(
              [front.anchorGroupId, ...front.memberIds.filter(id => id !== front.anchorGroupId)], all)}
            allLabel="every image in every card of this deck"
            visible={isHovered}
            // StackedDeckCard's pen size, and its EDGE_RESERVE: the face
            // stops short of the zone's right edge by the peek edges.
            size={Math.min(32, Math.max(16, Math.max(NLE_HEADER_CANVAS_H * zoom, 20) * 0.85))}
            faceRightOffset={front.memberIds.length > 1 ? 3 * 2 + 4 : 0}
          />
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
  // Frozen inside a pinned deck — the empty slot sits in that deck's layout.
  const { pan, zoom } = useCardView()
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
          backgroundImage: cssUrl(ghostHero),
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
  // Frozen inside a pinned deck — the footprint belongs to that deck.
  const { pan, zoom } = useCardView()
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
  // Frozen when pinned, live otherwise — the same swap every card piece
  // makes, and the reason the tab lands on the card rather than beside it.
  const { pan, zoom } = useCardView()
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
  // The touching cluster a check-in folds in with this card — none when it
  // holds the deck the card came FROM, even tucked inside another deck in
  // the cluster: folding that under the card and then returning the card
  // into it put each deck inside the other, and every card in the loop was
  // hidden for good. A card touching its own deck just goes back to its
  // slot. The hover preview, double-click and "Check back in" all use this,
  // so what is outlined is what folds.
  const touching = touchingClusters.find(c => c.includes(card.id))
  const foldCluster = touching && touching.length >= 2
    && !expandWithNestedMembers(touching, allGroups).includes(parent.id) ? touching : null
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
        data-tether-tab={card.id}
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
          if (foldCluster) {
            // Reorder so this card is first → it becomes the sub-deck
            // anchor. Other cluster members get tethered to it.
            const ordered = [card.id, ...foldCluster.filter(id => id !== card.id)]
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
      {isHovered && foldCluster && (() => {
        return foldCluster.map(memberId => {
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
                if (foldCluster) {
                  const ordered = [card.id, ...foldCluster.filter(id => id !== card.id)]
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
  // What a cluster's primary is drawn as below — DeckAffordance's hover
  // zone covers it and hosts its drag-out grip. Mirrors the render branch:
  // a plain card, or a stacked deck it anchors. A fan (or a stack still
  // closing) renders above the zone and keeps its own; a hidden member or
  // a card mid-extraction shows no face here.
  const affordanceFront = (gid: string): Deck | 'card' | null => {
    if (gid === extractingCardId) return null
    const deck = getDeckForGroup(gid)
    if (!deck) return 'card'
    const stacking = fanTransition?.deckId === gid && fanTransition.phase === 'stacking'
    return deck.state === 'stacked' && deck.anchorGroupId === gid && !stacking ? deck : null
  }
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} onPointerDown={startOverlayPan}>
      {groups.map(g => {
        // Hard gate: if this group is a non-anchor member of any deck, hide it completely.
        // This uses the persisted deckAnchorId — no spatial clustering needed.
        // …unless it is PINNED. Deck state persists from before the pin, and
        // no anchor on the canvas represents a card that has left it, so a
        // pinned card must never be hidden as "someone else's member".
        if (!g.pin && g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id) {
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

        // A PINNED card renders as a plain card, whatever its stored deck
        // state says. Decks no longer pin, but `deckState` persists from
        // before it was pinned — and clustering now excludes pinned groups,
        // so the card would take the stacked/fanned branch while
        // getDeckForGroup returns nothing for it. That mismatch is what put
        // the level bar in the wrong place: it measured whatever that branch
        // painted.
        const deck = g.pin ? null : getDeckForGroup(g.id)

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
      {/* A pinned deck is still a deck: the controls that act ON it have to
          come with it, or you can open one and then have no way to close it.
          So these are filtered to the scoped set rather than suppressed —
          only the things describing the WIDER canvas (ungrouped boards, and
          the tether tabs below, which point at cards elsewhere) are dropped.
          Same rule stated once: does this belong to this deck, or to the
          canvas it is floating above? */}
      {decks.filter(d => !onlySet || d.memberIds.some(id => onlySet.has(id))).map(d => (
        <DeckOpenPreview key={`preview-${d.id}`} deck={d} />
      ))}
      {affordanceClusters.filter(c => !onlySet || c.some(id => onlySet.has(id))).map(cluster => (
        <DeckAffordance key={cluster.join('|')} cluster={cluster} front={affordanceFront(cluster[0])} />
      ))}
      {!scoped && ungroupedIds.map(bid => (
        <UngroupedBoardCard key={bid} boardId={bid} />
      ))}

      {/* Where a pinned card USED to be. A pin means the card left the
          canvas — it does not cluster, push, or raise affordances out here
          any more — so all that should remain is the hole it left, enough to
          find your way back to it. */}
      {!scoped && groups.filter(g => g.pin).map(g => {
        const v = cardVisualRect(g, boards, zoom)
        if (!v) return null
        const home = g.home ?? { x: g.originX, y: g.originY }
        // The rect is measured at the card's CURRENT origin; the outline
        // belongs at its home, so shift by the difference.
        const dx = (home.x - g.originX) * zoom
        const dy = (home.y - g.originY) * zoom
        return (
          <div
            key={`pinned-ghost-${g.id}`}
            title={`${g.name || 'Card'} — pinned to the screen`}
            style={{
              position: 'absolute',
              left: v.rect.left + dx,
              top: v.rect.top + dy,
              width: v.rect.right - v.rect.left,
              height: v.rect.bottom - v.rect.top,
              border: `${Math.max(1, 1.5)}px dashed ${edgeColor(g.color, 0.5)}`,
              borderRadius: 12,
              background: 'rgba(255,255,255,0.015)',
              pointerEvents: 'none',
              zIndex: 1,
            }}
          />
        )
      })}

      {/* Tether tabs — one per extracted card (any group whose id appears in
          some other group's ghostSlots). Anchored to the card's top-left in
          the source deck's color. */}
      {groups.filter(g => !onlySet || onlySet.has(g.id)).map(g => {
        const parent = findExtractionParent(g.id, groups)
        if (!parent) return null
        // The tab belongs to the card, so it renders wherever the card is:
        // out here while the card is on the canvas, inside the pinned render
        // once it is pinned. Getting this wrong either strands the tab on the
        // canvas pointing at a card that is no longer there, or — as it did —
        // drops it entirely, leaving a checked-out card with no way back into
        // its deck for as long as it stays pinned.
        if (!!g.pin !== scoped) return null
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
        // …unless it is PINNED. Deck state persists from before the pin, and
        // no anchor on the canvas represents a card that has left it, so a
        // pinned card must never be hidden as "someone else's member".
        if (!g.pin && g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id) {
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
