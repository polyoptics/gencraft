import React, { useMemo, useState, useRef, useCallback } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useCardView } from '../Layers/cardView'
import { useNLEViewerStore } from '../../store/nleViewerStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { computeGroupLayout } from '../../utils/nleRows'
import { cardCornerOffset, snapCardToDots } from '../../utils/dotGrid'
import { groupSlot, clampGroupMove } from '../../utils/nlePush'
import type { GroupSlot } from '../../utils/nlePush'
import { expandWithNestedMembers, canvasObstacleGroups } from '../../hooks/useCardDecks'
import { hexToHsl, hslToHex } from '../../utils/colorUtils'
import { updateDeckMagnetPreview, finishDeckMagnetDock } from '../../utils/deckDockDrag'
import { groupHasBrowsableContent } from '../../utils/contentTraversal'

const BOARD_PADDING_X = 20
export const NLE_HEADER_CANVAS_H = 36
const GAP = 2

// ── Card-zoom "overview" scaling ──────────────────────────────────
// The card body + card text scale cleanly with zoom (zoom / 0.18, no
// clamp). The card CHROME (header band, badges, fonts, icons) uses
// fixed-pixel floors so it stops shrinking below ~0.18 and balloons
// relative to the cards when you zoom out far. To allow zooming out
// further while keeping the look coherent, we scale every chrome floor
// by `overviewScale`: it's 1 at/above CARD_FLOOR_ZOOM (today's look
// unchanged) and shrinks linearly below it, so the whole card — body
// and chrome — shrinks as one uniform unit. CARD_FLOOR_ZOOM is the
// "comfortable widest" reference (the historical MIN_ZOOM); MIN_ZOOM in
// canvasStore is the hard stop below it.
export const CARD_FLOOR_ZOOM = 0.11
export const overviewScale = (zoom: number) => Math.min(1, zoom / CARD_FLOOR_ZOOM)
// Card-top extension that fills behind the header: floored, overview-
// scaled header screen-height + a 2px gap. MUST be identical wherever a
// card top / outline / affordance is positioned (see CLAUDE.md).
export const headerExtend = (zoom: number) =>
  Math.max(NLE_HEADER_CANVAS_H * zoom, 20 * overviewScale(zoom)) + 2 * zoom
// The header bar's own rendered screen height (no +gap term).
export const headerScreenH = (zoom: number) =>
  Math.max(NLE_HEADER_CANVAS_H * zoom, 20 * overviewScale(zoom))

interface Segment {
  canvasLeft: number
  canvasWidth: number
  color: string
  boardId: string | null
}

/** Right-side header icon behavior:
 *  - 'viewer' (default): the up/down chevron toggle that opens the NLE timeline
 *    viewer for this group. Used at block & board zoom where viewing makes sense.
 *  - 'deckPreview': a small dashed-rectangle affordance. Hovering it sets
 *    `previewHoveredDeckId` in canvasStore so DeckOpenPreview renders the
 *    open-footprint outlines. Used at card zoom for stacked/fanned decks.
 *  - 'hidden': don't render the icon at all. Used at card zoom for open
 *    standalone cards (no viewer at this zoom, no deck to preview). */
type IconMode =
  | { kind: 'viewer' }
  | { kind: 'deckPreview'; deckId: string; count: number; onDoubleClick?: () => void }
  | { kind: 'hidden' }

interface Props {
  groupId?: string
  rightInset?: number  // screen px to trim from right edge (e.g. deck edge reserve)
  iconMode?: IconMode
}

const NLETimelineHeaderInner: React.FC<Props> = ({ groupId, rightInset = 0, iconMode }) => {
  const mode: IconMode = iconMode ?? { kind: 'viewer' }
  const previewHovered = useCanvasStore(s =>
    mode.kind === 'deckPreview' ? s.previewHoveredDeckId === mode.deckId : false
  )
  // Soft hint: deck card body is hovered but the icon itself isn't. Subtle
  // glow draws the eye to the affordance without committing to the full
  // open-preview. Suppressed when previewHovered is true so the active state
  // takes over cleanly.
  const cardHinted = useCanvasStore(s =>
    mode.kind === 'deckPreview' ? s.cardHoveredDeckId === mode.deckId : false
  )
  // The card's camera, not the canvas's. A pinned card's body draws with a
  // frozen view; reading the live one here made the header keep tracking the
  // canvas while the body stayed put, so the two visibly came apart the
  // moment anything moved. Header and body are one object and must share
  // one camera — see cardView.tsx.
  const { pan, zoom } = useCardView()

  const boards       = useBoardsStore(s => s.boards)
  // Subscribe only to THIS group — sibling groups changing during drags
  // won't invalidate this subscription, so the header doesn't re-render
  // for unrelated motion.
  const group = useBoardsStore(s => groupId ? s.groups.find(g => g.id === groupId) : undefined)
  // Legacy "no groupId" path (block/board level) needs all groups; subscribe
  // to that only when we're actually in that mode.
  const allGroupsFallback = useBoardsStore(s => groupId ? null : s.groups)
  const groupGone = !!groupId && !group // group was deleted (e.g. during grip-drag)

  const scopedBoardIds = useMemo(() => {
    if (groupGone) return [] // group deleted — render nothing
    if (group) return group.boardIds
    // No groupId → span all boards (legacy block/board level)
    const allBids: string[] = []
    allGroupsFallback?.forEach(g => g.boardIds.forEach(bid => allBids.push(bid)))
    return allBids
  }, [group, allGroupsFallback, groupGone])

  const defaultName = group?.name ?? 'Card'

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

  // ── Group drag: move group.originY / group.originX, and carry any
  // nested sub-deck members along so hidden members stay in sync ──
  const onTimelineDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if ((e.target as Element).closest('[data-viewer-toggle], [data-deck-preview-affordance]')) return
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

    // Expand to include any nested sub-deck members so hidden cards
    // stay locked to their anchor during a header drag.
    const dragIds = groupId ? expandWithNestedMembers([groupId], bs0.groups) : []
    const initialOrigins = new Map<string, { x: number; y: number }>()
    for (const gid of dragIds) {
      const gg = bs0.groups.find(gr => gr.id === gid)
      if (gg) initialOrigins.set(gid, { x: gg.originX, y: gg.originY })
    }
    const draggingSet = new Set(dragIds)
    const corner = g ? cardCornerOffset(g, bs0.boards) : null

    // Build collision slots — clamp against everything that isn't part
    // of the drag set (so nested members don't collide with themselves).
    let mySlot: GroupSlot | null = null
    let obstacles: GroupSlot[] = []
    if (groupId && g) {
      const myLayout = computeGroupLayout(g.boardIds, bs0.boards)
      mySlot = groupSlot(groupId, g.boardIds, bs0.boards, initialOriginX, initialOriginY, myLayout)
      // One unified work area — collide with every other visible group.
      obstacles = canvasObstacleGroups(bs0.groups, draggingSet)
        .map(og => groupSlot(og.id, og.boardIds, bs0.boards, og.originX, og.originY, computeGroupLayout(og.boardIds, bs0.boards)))
        .filter(Boolean) as GroupSlot[]
    }
    // Magnet gate: groups with ≥1 model in their recursive content can
    // dock to a 3D viewport window from the board-zoom header drag too.
    const canDock = groupId ? groupHasBrowsableContent(groupId, bs0.groups, bs0.boards) : false

    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      const dx = (ev.clientX - lastX) / z
      const dy = (ev.clientY - lastY) / z
      lastX = ev.clientX
      lastY = ev.clientY
      dyAccum += dy
      dxAccum += dx

      if (!groupId || initialOrigins.size === 0) return

      // Top-left corner onto the background dots (utils/dotGrid)
      const { x: preClampX, y: preClampY } = snapCardToDots(
        initialOriginX + dxAccum, initialOriginY + dyAccum, corner, z, headerExtend(z), ev.ctrlKey)
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
      useBoardsStore.getState().setGroupPosBatch(
        Array.from(initialOrigins, ([gid, origin]) => ({
          groupId: gid, originY: origin.y + finalDy, originX: origin.x + finalDx,
        }))
      )
      updateDeckMagnetPreview(canDock, groupId!)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setIsDragging(false)
      if (groupId && g) {
        finishDeckMagnetDock(canDock, groupId, groupId, dragIds)
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [groupId])

  // ── Geometry: segments + header position ──
  const { segments, globalCanvasLeft, globalCanvasRight, headerCanvasY } = useMemo(() => {
    const segs: Segment[] = []
    const groupOriginX = group?.originX ?? 0
    const groupOriginY = group?.originY ?? 0

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
    const contentRight = Math.max(...segs.map(s => s.canvasLeft + s.canvasWidth)) + 16

    // Match card width: apply cardWidthOverride (card extends right from left edge)
    const contentW = contentRight - globalCanvasLeft
    const globalCanvasRight = globalCanvasLeft + Math.max(contentW, group?.cardWidthOverride ?? 0)

    // Header Y = top of the group - header height - gap
    const topBoardY = groupOriginY  // group origin IS the top
    const headerCanvasY = topBoardY - NLE_HEADER_CANVAS_H - GAP

    const offsetSegs = segs.map(s => ({ ...s, canvasLeft: s.canvasLeft - globalCanvasLeft }))
    return { segments: offsetSegs, globalCanvasLeft, globalCanvasRight, headerCanvasY }
  }, [scopedBoardIds, boards, group])

  if (segments.length === 0) return null

  const screenLeft   = pan.x + globalCanvasLeft * zoom
  const screenWidth  = (globalCanvasRight - globalCanvasLeft) * zoom - rightInset

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
  // overview scale factor — 1 at/above the comfortable floor, shrinks
  // below it so the header chrome scales uniformly with the cards.
  const ov = overviewScale(zoom)
  const screenHeight = headerScreenH(zoom)
  const screenTop    = screenBottom - screenHeight
  const effectiveWidth = Math.max(screenWidth, 40)
  const isTiny = effectiveWidth < 50

  if (screenLeft + screenWidth < 0 || screenTop + screenHeight < 0) return null

  // Compute header fill: group color brightened 15%, at 25% opacity
  const groupColor = group?.color ?? '#5b8dd9'
  const { h, s, l } = hexToHsl(groupColor)
  const brighterHex = hslToHex(h, s, Math.min(1, l + 0.15))
  const n = parseInt(brighterHex.replace('#', ''), 16)
  const headerBg = `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},0.25)`

  // Right-side icon. Three flavors based on iconMode:
  // - 'viewer'  → chevron toggle for NLE viewer (block/board zoom).
  // - 'deckPreview' → dashed-rectangle affordance; hover triggers
  //                   DeckOpenPreview outlines (card zoom for decks).
  // - 'hidden'  → no icon (card zoom for open standalone cards).
  let headerIcon: React.ReactNode = null
  if (mode.kind === 'viewer') {
    headerIcon = (
      <div
        data-viewer-toggle
        onPointerDown={e => { e.stopPropagation(); toggleViewer() }}
        style={{
          padding: '1px 5px',
          borderRadius: 4,
          background: viewerOpen ? 'rgba(37,99,235,0.32)' : 'rgba(0,0,0,0.30)',
          border: viewerOpen ? '1px solid rgba(37,99,235,0.55)' : '1px solid rgba(255,255,255,0.14)',
          color: viewerOpen ? 'rgba(130,180,255,0.95)' : 'rgba(255,255,255,0.55)',
          fontSize: 9 * ov,
          fontWeight: 700,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          lineHeight: `${12 * ov}px`,
        }}
      >{viewerOpen ? '▼' : '▲'}</div>
    )
  } else if (mode.kind === 'deckPreview') {
    const deckId = mode.deckId
    const active = previewHovered
    const hint = cardHinted && !active
    // Size everything proportional to the header's rendered screenHeight, so
    // the icon scales with the card at all zooms above the header's 20px
    // clamp (i.e. the icon tracks zoom linearly while it visibly matters)
    // and freezes alongside the header at the lowest card zooms (so it
    // stays visible/clickable when the card is at its smallest). All
    // chrome lives in these few computed values — no fixed pixel sizes.
    const iconH    = screenHeight * 0.7              // tall enough to nearly fill header
    const iconW    = iconH * 1.45                    // 3:2-ish aspect — reads as a card
    // Floors scaled by ov so the icon chrome keeps shrinking below the
    // comfortable floor. Hit-zone pads keep a tiny absolute floor so the
    // affordance stays clickable even at the minimum zoom.
    const borderW  = Math.max(0.75 * ov, screenHeight * 0.055)
    const radius   = Math.max(1 * ov, screenHeight * 0.12)
    const hitPadX  = Math.max(0.5, Math.max(2 * ov, screenHeight * 0.1))
    const hitPadY  = Math.max(0.5, Math.max(1 * ov, screenHeight * 0.04))
    headerIcon = (
      <div
        data-deck-preview-affordance
        title="Hover: preview open layout · Double-click: toggle deck"
        // Hover writes/clears previewHoveredDeckId. Leave-clear is guarded by
        // an id check so a fast cross-deck hover doesn't clobber the new
        // deck's hover state with a stale clear from the previous one.
        onPointerEnter={() => useCanvasStore.getState().setPreviewHoveredDeckId(deckId)}
        onPointerLeave={() => {
          if (useCanvasStore.getState().previewHoveredDeckId === deckId) {
            useCanvasStore.getState().setPreviewHoveredDeckId(null)
          }
        }}
        // Don't trigger header drag on click.
        onPointerDown={e => e.stopPropagation()}
        // Double-click triggers the call-site-supplied transition (typically
        // "open the deck"). Clear both hover signals first — they're keyed
        // by deck.id (joined member ids), and re-stacking later produces the
        // same id, which would resurrect the preview outlines from a stale
        // hover state if we didn't reset.
        onDoubleClick={e => {
          e.stopPropagation()
          if (mode.kind === 'deckPreview' && mode.onDoubleClick) {
            useCanvasStore.getState().setPreviewHoveredDeckId(null)
            useCanvasStore.getState().setCardHoveredDeckId(null)
            mode.onDoubleClick()
          }
        }}
        style={{
          // No chrome on the wrapper — the dashed-rect glyph stands free in
          // the header. Padding is hit-zone only, invisible.
          padding: `${hitPadY}px ${hitPadX}px`,
          cursor: mode.kind === 'deckPreview' && mode.onDoubleClick ? 'pointer' : 'default',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {/* Dashed-rectangle glyph — a tiny card silhouette displaying the
            deck's MEANINGFUL-CONTENT count (authored pieces across all
            members: cards, blocks, bars — text, images, titles). The
            caller passes this via mode.count. Visually echoes the
            DeckOpenPreview outlines it summons. */}
        <div style={{
          width: iconW,
          height: iconH,
          border: `${borderW}px dashed ${
            active ? 'rgba(255,255,255,0.95)' :
            hint   ? 'rgba(255,255,255,0.85)' :
                     'rgba(255,255,255,0.7)'
          }`,
          background: active ? 'rgba(255,255,255,0.26)' :
                      hint   ? 'rgba(255,255,255,0.20)' :
                               'rgba(255,255,255,0.14)',
          borderRadius: radius,
          boxSizing: 'border-box',
          transition: 'border-color 0.12s, background 0.12s, filter 0.12s, color 0.12s',
          filter:
            active ? `drop-shadow(0 0 ${Math.max(2 * ov, borderW * 2)}px rgba(255,255,255,0.4))` :
            hint   ? `drop-shadow(0 0 ${Math.max(1.5 * ov, borderW * 1.4)}px rgba(255,255,255,0.22))` :
                     'none',
          // Count display
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Font size tracks the icon height so the digit always fits cleanly,
          // with an ov-scaled floor so it shrinks past the comfortable zoom.
          fontSize: Math.max(8 * ov, iconH * 0.62),
          fontWeight: 700,
          color: active ? 'rgba(255,255,255,0.98)' :
                 hint   ? 'rgba(255,255,255,0.88)' :
                          'rgba(255,255,255,0.78)',
          lineHeight: 1,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontVariantNumeric: 'tabular-nums',
          textShadow: '0 1px 2px rgba(0,0,0,0.4)',
          userSelect: 'none',
        }}>{mode.count}</div>
      </div>
    )
  }
  // mode.kind === 'hidden' → headerIcon stays null; the trailing flex slot is omitted.

  const nameEl = renaming ? (
    <input
      ref={inputRef}
      autoFocus
      value={renameVal}
      placeholder="Card"
      onChange={e => setRenameVal(e.target.value)}
      onBlur={commitRename}
      onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false) }}
      onPointerDown={e => e.stopPropagation()}
      style={{
        background: 'rgba(0,0,0,0.35)',
        border: '1px solid rgba(255,255,255,0.35)',
        borderRadius: 3,
        color: '#fff',
        fontSize: 10 * ov,
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
        color: headerName ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.35)',
        fontStyle: headerName ? 'normal' : 'italic',
        fontSize: 10 * ov,
        fontWeight: 700,
        letterSpacing: '0.2px',
        textShadow: '0 1px 4px rgba(0,0,0,0.6)',
        cursor: 'default',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flex: '1 1 0',
        minWidth: 0,
        lineHeight: `${14 * ov}px`,
      }}
    >{headerName || 'Card'}</span>
  )

  return (
    <div
      style={{
        position: 'absolute',
        left: screenLeft,
        top: screenTop,
        width: effectiveWidth,
        height: screenHeight,
        zIndex: 51,
        userSelect: 'none',
        pointerEvents: 'all',
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
      onPointerDown={onTimelineDown}
      onWheel={onWheel}
    >
      <div style={{
        position: 'absolute', inset: 0,
        background: headerBg,
        borderRadius: '12px 12px 0 0',
        overflow: 'hidden',
      }} />

      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        padding: '0 6px',
        zIndex: 2,
        gap: 4,
        overflow: 'hidden',
      }}>
        {!isTiny && nameEl}
        {headerIcon && <div style={{ flex: '0 0 auto', marginLeft: isTiny ? 0 : 'auto' }}>{headerIcon}</div>}
      </div>
    </div>
  )
}

// Memoized — renders one per group. When Overlay re-renders due to unrelated
// groups changing, headers with the same (groupId, rightInset) skip entirely.
// Their own store subscriptions still drive re-renders when pan/zoom/their
// group change.
export const NLETimelineHeader = React.memo(NLETimelineHeaderInner)
