import React, { useMemo, useState, useRef, useCallback, useSyncExternalStore } from 'react'
import { withLockMates, keptReach } from '../../utils/deckLock'
import { BackRefDot } from '../Linking/BackRefDot'
import { StatePicker } from '../Layers/StateFace'
import { getBackRefs } from '../../utils/linkRefs'
import { onRows, rowOf, rowsSeen } from '../../utils/primaryCard'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { isTilted, useTiltStore } from '../../store/tiltStore'
import { useCardView } from '../Layers/cardView'
import { useNLEViewerStore } from '../../store/nleViewerStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { computeGroupLayout } from '../../utils/nleRows'
import { cardCornerOffset, snapCardToDots } from '../../utils/dotGrid'
import { cardEdgeSnapFor } from '../../utils/cardEdgeSnap'
import { groupSlot, clampGroupMove } from '../../utils/nlePush'
import { wallRoom } from '../../utils/wallRoom'
import type { GroupSlot } from '../../utils/nlePush'
import { expandWithNestedMembers, canvasObstacleGroups, cardsTouch } from '../../hooks/useCardDecks'
import { hexToHsl, hslToHex } from '../../utils/colorUtils'
import { updateDeckMagnetPreview, finishDeckMagnetDock } from '../../utils/deckDockDrag'
import { dropOnStateSpace } from '../../utils/stateSpace'
import { useMagnetPreviewStore } from '../../store/magnetPreviewStore'
import { groupHasBrowsableContent } from '../../utils/contentTraversal'
import { RenameInput } from '../UI/RenameInput'
import { SceneViewButton } from '../Layers/SceneFace'
import { HeaderColorDot, colorTargets } from '../Layers/HeaderColorDot'
import { ColorPickerPopup } from '../Bar/ColorPickerPopup'

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
  | { kind: 'deckPreview'; deckId: string; count: number; onDoubleClick?: () => void
      /** On (e.g. a card's chart is out): drawn lit. */
      lit?: boolean
      /** A press on the icon: it moves what it stands for (a row). */
      onDragDown?: (e: React.PointerEvent) => void }
  | { kind: 'hidden' }

interface Props {
  groupId?: string
  rightInset?: number  // screen px to trim from right edge (e.g. deck edge reserve)
  leftInset?: number   // the same off the left edge (a deck whose edges are on its left)
  iconMode?: IconMode
}

const NLETimelineHeaderInner: React.FC<Props> = ({ groupId, rightInset = 0, leftInset = 0, iconMode }) => {
  const mode: IconMode = iconMode ?? { kind: 'viewer' }
  // Tilted, the ground past the screen's top and side edges is in view.
  const tilted = useTiltStore(st => isTilted(st))
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

  // Lock (utils/deckLock): on a deck's face card, open or closed, always
  // shown in the bar, lit while the deck is locked.
  useSyncExternalStore(onRows, rowsSeen)
  const locked = useBoardsStore(s => {
    const l = groupId ? s.groups.find(g => g.id === groupId)?.deckLock : undefined
    return !!l && s.groups.some(o => o.id !== groupId && o.deckLock === l)
  })
  // Kept (the lock's first stage): its cards are remembered as a deck.
  // Lit on the deck itself: the card it was kept under, the front of the
  // row that card is in, or the closed deck it is hidden in. A kept card
  // off on its own is in no deck while it is away.
  const kept = useBoardsStore(s => {
    const k = groupId ? s.groups.find(g => g.id === groupId)?.deckKeep : undefined
    if (!k || !s.groups.some(o => o.id !== groupId && o.deckKeep === k)) return false
    if (k === groupId || rowOf(groupId!)?.includes(k)) return true
    let at = s.groups.find(g => g.id === k)
    for (let i = 0; at?.deckAnchorId && at.deckAnchorId !== at.id && i < 32; i++) {
      if (at.deckAnchorId === groupId) return true
      at = s.groups.find(g => g.id === at!.deckAnchorId)
    }
    return false
  })
  // A scene card: its view modes (Focus, Bump-outs, Trace) from a "⋯" here.
  const isScene = useBoardsStore(s => !!groupId && s.groups.find(g => g.id === groupId)?.cardType === 'scene')
  // Its colour panel, opened from the header (a scene card): its circle or
  // a double-click, with the transparency; a right-click, the colour alone.
  const [colorAt, setColorAt] = useState<{ x: number; y: number; clear: boolean } | null>(null)
  const openRow = groupId ? rowOf(groupId) : undefined
  const isFace = !!groupId && (mode.kind === 'deckPreview' || (!!openRow && openRow.length > 1 && openRow[0] === groupId))
  // A State card, or its output deck's front card: the current state,
  // picked by name (utils/stateCard). Always there, at a fixed width.
  const stateOf = useBoardsStore(s => {
    if (!group) return undefined
    if (group.cardType === 'state' && group.stateCard) return group.id
    if (group.stateOut && s.groups.find(g => g.id === group.stateOut)?.stateCard?.output === group.id) return group.stateOut
    return undefined
  })
  const hasRefs = useBoardsStore(s => !!groupId && getBackRefs(groupId, s.groups).length > 0)
  // A linked card's master (utils/linkedCards), while it is still there.
  const linkMasterId = useBoardsStore(s => {
    const l = group?.linkOf
    return l && s.groups.some(o => o.id === l) ? l : undefined
  })

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
  // A scene card in front of a row of touching cards (Brian 2026-11-12):
  // its face is its sections', so its header is where the row is moved
  // from, all together. Shift: this card alone, out of the row.
  const rowDrag = useRef<((e: React.PointerEvent) => void) | undefined>(undefined)
  rowDrag.current = mode.kind === 'deckPreview' ? mode.onDragDown : undefined
  const onTimelineDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if ((e.target as Element).closest('[data-viewer-toggle], [data-deck-preview-affordance]')) return
    if (rowDrag.current && !e.shiftKey) { rowDrag.current(e); return }
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
    const dragIds = groupId ? expandWithNestedMembers(withLockMates([groupId], bs0.groups), bs0.groups) : []
    const initialOrigins = new Map<string, { x: number; y: number }>()
    for (const gid of dragIds) {
      const gg = bs0.groups.find(gr => gr.id === gid)
      if (gg) initialOrigins.set(gid, { x: gg.originX, y: gg.originY })
    }
    const draggingSet = new Set(dragIds)
    const corner = g ? cardCornerOffset(g, bs0.boards) : null
    // Side edges onto neighbouring cards (utils/cardEdgeSnap)
    const edges = groupId ? cardEdgeSnapFor(groupId, dragIds, bs0.groups, bs0.boards, useCanvasStore.getState().zoom) : null

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
        initialOriginX + dxAccum, initialOriginY + dyAccum, corner, z, headerExtend(z), ev.ctrlKey, edges)
      // Clamp against other groups (only in timeline zone)
      // Nothing standing on a storyline's wall goes below its foot, into
      // the floor (utils/wallRoom).
      const room = wallRoom(initialOrigins)
      let finalDx: number, finalDy: number
      if (mySlot && obstacles.length > 0) {
        const { dx: cdx, dy: cdy } = clampGroupMove(mySlot, preClampX - initialOriginX, Math.min(preClampY - initialOriginY, room), obstacles, undefined, room)
        finalDx = cdx
        finalDy = cdy
      } else {
        finalDx = preClampX - initialOriginX
        finalDy = Math.min(preClampY - initialOriginY, room)
      }
      // Move all dragging groups by the same delta — single batched store update
      useBoardsStore.getState().setGroupPosBatch(
        Array.from(initialOrigins, ([gid, origin]) => ({
          groupId: gid, originY: origin.y + finalDy, originX: origin.x + finalDx,
        }))
      )
      updateDeckMagnetPreview(canDock, groupId!)
    }

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setIsDragging(false)
      // Let go over a state workspace: the card becomes a node there (a link),
      // and goes back to where it was picked up (utils/stateSpace).
      const was = groupId ? initialOrigins.get(groupId) : undefined
      const is = useBoardsStore.getState().groups.find(x => x.id === groupId)
      if (groupId && g && was && is && (is.originX !== was.x || is.originY !== was.y) && dropOnStateSpace(ev.clientX, ev.clientY, [groupId], !ev.isTrusted)) {
        useBoardsStore.getState().setGroupPosBatch(Array.from(initialOrigins, ([gid, origin]) => ({ groupId: gid, originY: origin.y, originX: origin.x })))
        useMagnetPreviewStore.getState().setPreview(null)
        return
      }
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

  const screenLeft   = pan.x + globalCanvasLeft * zoom + leftInset
  const screenWidth  = (globalCanvasRight - globalCanvasLeft) * zoom - rightInset - leftInset

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
  // Never wider than a small card by more than the chrome shrinks: a flat
  // 40px floor stuck out past the card zoomed far out, further the further
  // out (at 1% a strip three cards wide, each over its neighbours: Brian
  // 2026-11-13, "really broken and extreme with the scaling").
  const effectiveWidth = Math.max(screenWidth, 40 * ov)
  // The name: as large as its strip holds, up to its size at the
  // comfortable zoom, so it stays readable as the strip thins instead of
  // shrinking twice (with the strip and by `ov`); too small to read, it
  // fades out rather than lie there as specks.
  // A scene card's: larger, most of the band (Brian 2026-11-16: "The
  // header text is pretty small").
  const nameFont = isScene ? Math.min(14, Math.max(14 * ov, screenHeight * 0.7)) : Math.min(10, Math.max(10 * ov, screenHeight * 0.62))
  const nameShown = Math.max(0, Math.min(1, (nameFont - 4.5) / 1.5))
  const isTiny = effectiveWidth < 50

  if (!tilted && (screenLeft + screenWidth < 0 || screenTop + screenHeight < 0)) return null

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
        onPointerDown={e => { e.stopPropagation(); if (mode.kind === 'deckPreview') mode.onDragDown?.(e) }}
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
          cursor: mode.kind === 'deckPreview' && mode.onDragDown ? 'grab' : mode.kind === 'deckPreview' && mode.onDoubleClick ? 'pointer' : 'default',
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
            mode.lit ? 'rgba(127,209,255,0.95)' :
            active ? 'rgba(255,255,255,0.95)' :
            hint   ? 'rgba(255,255,255,0.85)' :
                     'rgba(255,255,255,0.7)'
          }`,
          background: mode.lit ? 'rgba(127,209,255,0.32)' :
                      active ? 'rgba(255,255,255,0.26)' :
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

  const lockH = screenHeight * 0.7
  const sceneOn = isScene && !!groupId && !isTiny
  const openColor = (x: number, y: number, clear: boolean) => setColorAt({ x, y, clear })
  const stateEl = stateOf && !isTiny ? (
    <StatePicker stateCardId={stateOf} height={lockH} width={Math.max(30, effectiveWidth * 0.42)} font={9 * ov} />
  ) : null
  // Go to master (Brian 2026-11-05): on a linked card, an arrow that takes
  // the canvas to its master card, centred and selected. Always shown on a
  // linked card, so the bar never shifts. A master hidden in a closed deck
  // is shown by its deck's face card.
  const goEl = linkMasterId ? (
    <div
      data-go-to-master
      title="Go to the master card"
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation()
        const gs = useBoardsStore.getState().groups
        let to = gs.find(g => g.id === linkMasterId)
        for (let i = 0; to?.deckAnchorId && i < 32; i++) {
          const up = gs.find(g => g.id === to!.deckAnchorId)
          if (!up) break
          to = up
        }
        if (!to) return
        useCanvasStore.getState().jumpToGroup(to.id)
        useBoardsStore.getState().setSelectedGroup(to.id)
      }}
      style={{
        flex: '0 0 auto', marginLeft: hasRefs || sceneOn || isTiny ? 0 : 'auto',
        width: lockH, height: lockH,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: Math.max(1 * ov, screenHeight * 0.12),
        color: 'rgba(255,255,255,0.55)',
        cursor: 'pointer',
      }}
    >
      <svg width={lockH * 0.8} height={lockH * 0.8} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {/* An arrow out of a box: off to the card this one shows. */}
        <path d="M7 3.5 H3.5 a1 1 0 0 0 -1 1 V12.5 a1 1 0 0 0 1 1 H11.5 a1 1 0 0 0 1 -1 V9" />
        <path d="M8 8 L13.5 2.5" />
        <path d="M9.5 2.5 H13.5 V6.5" />
      </svg>
    </div>
  ) : null
  const lockEl = isFace && groupId ? (
    <div
      data-deck-lock
      title="Lock the deck. Once: its cards stay this deck, and it still joins others. Twice: it keeps its cards and moves as one"
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation()
        useUndoCoordinator.getState().checkpoint()
        const bs = useBoardsStore.getState()
        // Off, kept, locked, off (Brian 2026-11-19).
        if (locked) { bs.setDeckLock(groupId, null); return }
        if (kept) {
          // Kept to locked: the cards it keeps, with the cards hidden in them.
          const k = bs.groups.find(g => g.id === groupId)?.deckKeep
          // Those with it now: in its row, or hidden in it (closed).
          // (Open, those that reach the card it was kept under through
          // one another, as the deck is read: utils/deckLock keptIn.)
          const here = new Set(expandWithNestedMembers(rowOf(groupId) ?? [groupId], bs.groups))
          const with_ = bs.groups.filter(g => g.deckKeep === k && here.has(g.id))
          const front = with_.find(g => g.id === k)
          const zoom = useCanvasStore.getState().zoom
          const open_ = (g: { deckState?: string }) => !g.deckState || g.deckState === 'open'
          const reach = front && open_(front)
            ? new Set(keptReach(front, with_.filter(open_), (a, b) => cardsTouch(a, b, bs.boards, zoom)).map(g => g.id))
            : null
          const ids = expandWithNestedMembers([groupId, ...with_.filter(g => g.id !== groupId && (!reach || !open_(g) || reach.has(g.id))).map(g => g.id)], bs.groups)
          if (ids.length < 2) { bs.setDeckKeep(groupId, null); return }
          bs.setDeckKeep(groupId, null)
          bs.setRowPrimary(groupId, ids)
          bs.setDeckLock(groupId, ids)
          return
        }
        // The open row, or the closed deck, with the cards hidden in it; an
        // open deck's front card inside a row of other cards, that deck.
        const row = rowOf(groupId)
        const own = !(row && row[0] === groupId) && mode.kind === 'deckPreview' && row
          ? row.filter(id => bs.groups.find(g => g.id === id)?.deckHome === groupId) : []
        // A closed deck: its own cards, whatever it lies against.
        const me = bs.groups.find(g => g.id === groupId)
        const closedDeck = !!me?.deckState && me.deckState !== 'open' && bs.groups.some(g => g.id !== groupId && g.deckAnchorId === groupId && !!g.deckState && g.deckState !== 'open')
        const ids = expandWithNestedMembers(closedDeck ? [groupId] : row && row[0] === groupId ? row : own.length >= 2 ? own : [groupId], bs.groups)
        if (ids.length < 2) return
        bs.setDeckKeep(groupId, ids)
      }}
      style={{
        flex: '0 0 auto', marginLeft: goEl || hasRefs || sceneOn || isTiny ? 0 : 'auto',
        width: lockH, height: lockH,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: Math.max(1 * ov, screenHeight * 0.12),
        // Off: grey. Kept: blue, not filled. Locked: blue on a blue ground.
        background: locked ? 'rgba(127,209,255,0.32)' : 'transparent',
        color: locked || kept ? 'rgba(127,209,255,0.98)' : 'rgba(255,255,255,0.55)',
        cursor: 'pointer',
        transition: 'background 0.12s, color 0.12s',
      }}
    >
      <svg width={lockH * 0.8} height={lockH * 0.8} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {/* A padlock: same glyph locked or not, only lit when locked. */}
        <rect x="3" y="7" width="10" height="7.5" rx="1.2" />
        <path d="M5.2 7 V4.8 a2.8 2.8 0 0 1 5.6 0 V7" />
        <path d="M8 10 v1.8" />
      </svg>
    </div>
  ) : null

  const nameEl = renaming ? (
    <RenameInput
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
        fontSize: nameFont,
        opacity: nameShown,
        fontWeight: 700,
        letterSpacing: '0.2px',
        textShadow: '0 1px 4px rgba(0,0,0,0.6)',
        cursor: 'default',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flex: '1 1 0',
        minWidth: 0,
        lineHeight: `${Math.min(screenHeight, nameFont * 1.4)}px`,
      }}
    >{headerName || 'Card'}</span>
  )

  return (
    <div
      data-card-header={groupId}
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
      onContextMenu={sceneOn ? e => { e.preventDefault(); e.stopPropagation(); openColor(e.clientX, e.clientY, false) } : undefined}
      onDoubleClick={sceneOn ? e => { e.stopPropagation(); openColor(e.clientX, e.clientY + 8, true) } : undefined}
    >
      {colorAt && group && groupId && (
        <div data-color-picker onPointerDownCapture={() => useUndoCoordinator.getState().checkpoint()} onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()}>
          <ColorPickerPopup
            color={group.color}
            anchorX={colorAt.x}
            anchorY={colorAt.y}
            onChange={c => { const bs = useBoardsStore.getState(); for (const id of colorTargets(groupId)) { bs.setGroupColor(id, c); bs.setGroupOwnColor(id, true) } }}
            {...(colorAt.clear ? { opacity: group.colorOpacity ?? 1, onOpacityChange: (o: number) => { const bs = useBoardsStore.getState(); for (const id of colorTargets(groupId)) bs.setGroupColorOpacity(id, o) } } : {})}
            onClose={() => setColorAt(null)}
          />
        </div>
      )}
      <div style={{
        position: 'absolute', inset: 0,
        background: headerBg,
        borderRadius: `${12 * ov}px ${12 * ov}px 0 0`,
        overflow: 'hidden',
      }} />

      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        padding: `0 ${6 * ov}px`,
        zIndex: 2,
        gap: 4 * ov,
        overflow: 'hidden',
      }}>
        {sceneOn && <HeaderColorDot groupId={groupId!} size={lockH} lit={!!colorAt} onOpen={(x, y) => colorAt ? setColorAt(null) : openColor(x, y, true)} />}
        {!isTiny && nameEl}
        {stateEl}
        {hasRefs && groupId && !isTiny && (
          <div style={{ flex: '0 0 auto', marginLeft: 'auto', display: 'flex' }}><BackRefDot groupId={groupId} size={lockH} /></div>
        )}
        {sceneOn && (
          <div style={{ flex: '0 0 auto', marginLeft: hasRefs ? 0 : 'auto', display: 'flex' }}><SceneViewButton groupId={groupId!} size={lockH} /></div>
        )}
        {goEl}
        {lockEl}
        {headerIcon && <div style={{ flex: '0 0 auto', marginLeft: lockEl || goEl || hasRefs || sceneOn || isTiny ? 0 : 'auto' }}>{headerIcon}</div>}
      </div>
    </div>
  )
}

// Memoized — renders one per group. When Overlay re-renders due to unrelated
// groups changing, headers with the same (groupId, rightInset) skip entirely.
// Their own store subscriptions still drive re-renders when pan/zoom/their
// group change.
export const NLETimelineHeader = React.memo(NLETimelineHeaderInner)
