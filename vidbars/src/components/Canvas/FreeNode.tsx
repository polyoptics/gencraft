import React, { useState, useRef, useCallback, useEffect } from 'react'
import { AnnotationCardBody } from '../Notes/AnnotationCardBody'
import { AreaBody } from '../Notes/AreaBody'
import ReactDOM from 'react-dom'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import type { FreeNodeData, TextStyle } from '../../store/freeNodeStore'
import { DEFAULT_TEXT_STYLE } from '../../store/freeNodeStore'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { useThumb, requestThumb, hasThumbFailed } from '../../utils/thumbService'
import {
  ensureFontLoaded, FONT_LIST, loadGoogleFont, hexToRgba,
  FONT_SIZES, FONT_WEIGHTS, LINE_HEIGHTS, LETTER_SPACINGS, TEXT_TRANSFORMS, PRESET_COLORS,
  hAlignIcons, vAlignIcons, AlignPopup, ColorSwatchPopup, BgPickerPopup,
} from '../UI/TextFormatToolbar'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useMagnetPreviewStore } from '../../store/magnetPreviewStore'
import { addMediaBlockToCard, cardHitAt, groupForCardHit } from '../../utils/cardContent'
import { EffectTileBody } from './EffectTileBody'
import { FxResultLayer, useFxDragUrl } from './FxResultLayer'
import { snapToStrip } from '../../utils/fx/stripSnap'
import { isTileDeckFace, tileDeckMembers, touchingTileCluster } from '../../utils/tileDecks'
import { edgeColorFromHex } from '../../utils/colorUtils'
import { findMagnetCandidate, magnetRadiusForZoom, viewportVisualRect, type WindowRect } from '../../utils/viewportDocking'
import { tileBrowseItem, isDockableTile } from '../../utils/contentTraversal'
import { snapPanelToPanel, isPanelType, adjacentPanels } from '../../utils/componentLinks'
import { panelContentScale, clampUiScale } from '../UI/PanelSurface'
import { CardRolodex } from '../Rolodex/CardRolodex'
import { RoughCutBody } from '../RoughCut/RoughCutBody'
import { FILM_MIXER_ASPECT, FilmLayersSpacing, FilmLayersToggle, FilmMixerBody } from '../FilmMixer/FilmMixerBody'
import { MediaPool } from '../Pool/MediaPool'
import { PromptPad } from '../Prompt/PromptPad'
import { AttributesWindow } from '../CardBacks/AttributesWindow'
import { CARD_READER_TYPES } from '../../utils/deckDockDrag'
import { dockedCards } from '../../utils/filmShots'
import { CardPromptPad } from '../CardBacks/CardPromptPad'
import { HistoryPanel } from '../History/HistoryPanel'
import { PinControl } from '../UI/PinControl'
import { DragOutGrip } from '../UI/DragOutGrip'
import { ensureModelPoster, getModelPoster, invalidateModelPoster, useModelPoster } from '../../three/posterService'
import { HeroImageEditOverlay } from '../UI/HeroImageEditOverlay'
import { DrawableSurface } from '../Annotation/DrawableSurface'
import { PenButton } from '../Annotation/PenButton'
import { currentPointerPos, useSeedHoverFromCursor } from '../../utils/pointerTracker'
import { useFileMenuItems } from '../../hooks/useFileMenu'
import { useMenuClamp } from '../../hooks/useMenuClamp'
import { RailBody } from './RailBody'
import { CabinetBody } from './cabinet/CabinetBody'
import { saveCanvasToDrawer } from '../../utils/cabinetProjects'
import { aimCabinet, addDrawer, cabinetDrawerAt, cabinetTargets, canStowTile, drawerName, emptyCabinet, itemCount, removeEmptyDrawer, stowSelection, stowTiles, toggleDrawer, useCabinetUi } from '../../utils/cabinet'
import { useRailUiStore } from '../../store/railUiStore'
import {
  RAIL_GEOM, RAIL_TRAY, isDocked, isRail, isRailPicture, railDropTarget, railLayout, railMembers,
  type RailDropTarget,
} from '../../utils/rail'
import { clientToCanvas } from '../../utils/fx/createEffect'
import { railAtPoint } from './rail/railHit'
import { copyEffect, hasEffectClip, pasteEffect } from '../../utils/fx/effectClipboard'
import { railHeaderBottom, railHeaderCarry, snapRailToViewer } from '../../utils/railViewer'
import { RenameInput } from '../UI/RenameInput'
import { CanvasUnits } from './CanvasUnits'
import { useFreshOnTop, FRESH_Z } from '../../utils/freshOnTop'
import { foldArea3dMoving } from '../../utils/area3dCard'


/** Node types whose corner resize keeps the current proportions. A
 *  Rolodex tile already has a length control — the drawer at the base of
 *  the cabinet — so the corner's job is only to grow the shape the drawer
 *  set, not to fight it. */
const LOCKS_ASPECT = new Set<FreeNodeData['type']>(['list'])

/** Node types held at a FIXED shape on resize: height ÷ width of the whole
 *  tile. Not LOCKS_ASPECT — that set keeps whatever shape the tile already
 *  has, and also gives it the Rolodex's drawer-safe handles. An effect card
 *  is a playing card (5:7) whatever it was before, so a card made at the
 *  old size takes the right shape on its first resize. */
const FIXED_ASPECT: Partial<Record<FreeNodeData['type'], number>> = { effect: 7 / 5, filmMixer: FILM_MIXER_ASPECT }

/** EffectTileBody's FACE_HEIGHT_U — the tallest face in its unit u, which
 *  it takes as min(width / 100, height / this). The resize grip has to
 *  keep to the face's margin in the SAME unit. Keep the two in step. */
const EFFECT_FACE_HEIGHT_U = 128

/** Node types whose `imageUrl` IS the media — the stored file itself, a
 *  model's .glb rather than its poster — so the context menu can offer
 *  the file on disk behind it. Panels and text tiles never hold one. */
const MEDIA_TILES = new Set<FreeNodeData['type']>(['image', 'video', 'audio', 'model'])

/** The poster to hand on when a model or video tile transfers its content.
 *
 *  LIVE map first, the node's stored copy only as a fallback. The stored
 *  `posterUrl` can point at a blob that no longer exists — a template or
 *  project load restores node records without the poster images — and the
 *  tile itself never reveals that, because it renders from the live map.
 *  Preferring the stored copy therefore wrote a DEAD reference into the
 *  card, and the model then rendered as nothing at every zoom level: no
 *  bar hero, no block thumbnail, no card hero. Which is exactly what
 *  "I dropped it in and it disappeared" looks like. */
function transferablePoster(node: FreeNodeData): string | null {
  if (!node.imageUrl) return node.posterUrl ?? null
  return getModelPoster(node.imageUrl) ?? node.posterUrl ?? null
}

type Nodes = Record<string, FreeNodeData>

/** One node's size and anchor when a resize drag began. */
type ResizeStart = { id: string; w: number; h: number; nx: number; ny: number; u: number; ru?: number }

function resizeStartOf(n: FreeNodeData): ResizeStart {
  return {
    id: n.id, w: n.width, h: n.height,
    nx: n.pin ? n.pin.x : n.x,
    ny: n.pin ? n.pin.y : n.y,
    u: panelContentScale(n),
    ru: n.roughCut?.ui,
  }
}

/** Whether a selected node joins when ANOTHER selected node's handle is
 *  dragged: only one that shows resize handles of its own (not a tile-deck
 *  face or member, a rail, or a card docked on one). */
function resizableAlongside(n: FreeNodeData | undefined, nodes: Nodes): n is FreeNodeData {
  return !!n && !n.tileDeck && n.type !== 'rail' && !isDocked(n, nodes)
}

/** The patch that resizes `node` from its drag-start `s` by a drag of
 *  (dx, dy) in its own layout units on handle `dir`. Pure, so one drag can
 *  resize every selected node as though each had been dragged alone. */
function resizePatch(node: FreeNodeData, s: ResizeStart, dir: string, dx: number, dy: number, shift: boolean): Partial<FreeNodeData> {
  // SCALE, as opposed to reshape. Two different intentions: the plain
  // handles change the panel's SHAPE, and Shift on a corner scales the
  // whole thing keeping the shape you already settled on — the thing that
  // was missing once you had the aspect right and just wanted it bigger.
  //
  // A Rolodex tile is always in this mode: the drawer at its base sets how
  // long the cabinet is, so its handles only grow the shape the drawer
  // chose rather than fighting it.
  //
  // An effect card is always in this mode too, at its FIXED playing-card
  // shape rather than whatever shape it starts the drag with.
  const fixedRatio = FIXED_ASPECT[node.type]
  const proportional = fixedRatio !== undefined || LOCKS_ASPECT.has(node.type) || (shift && dir.length === 2)
  const k = node.pin ? node.pin.scale : 1
  if (proportional) {
    const ratio = fixedRatio ?? s.h / s.w
    // Project the drag onto the diagonal (1, ratio) so both directions of
    // pointer travel contribute and the corner tracks the cursor. West and
    // north handles pull the other way, hence the sign.
    const sx = dir.includes('w') ? -1 : 1
    const sy = dir.includes('n') ? -1 : 1
    // A fixed-shape card's SIDE handles follow their own axis instead: on
    // the diagonal, a sideways pull moved the edge a third as far as the
    // hand and a vertical one two thirds, so the edge slid off the cursor.
    const t = fixedRatio !== undefined && dir.length === 1
      ? (dir === 'e' || dir === 'w' ? dx * sx : (dy * sy) / ratio)
      : (dx * sx + dy * sy * ratio) / (1 + ratio * ratio)
    const w = Math.max(120, 80 / ratio, s.w + t)
    const h = w * ratio
    const patch: Partial<FreeNodeData> = { width: w, height: h }
    // …and the CONTENTS scale with the box. Without this, a counter-scaled
    // panel just gained room at the same text size, which is "bigger
    // window, same squint" rather than "bigger panel". Growing uiScale by
    // the same factor is what makes the gesture feel like zooming the whole
    // component. Tiles have no uiScale and are unaffected.
    if (isPanelType(node.type) && s.w > 0) {
      patch.uiScale = clampUiScale(s.u * (w / s.w))
    }
    // A Rough Cut's controls keep their own size (roughCut.ui): scaled, they grow with it.
    if (node.roughCut && s.ru && s.w > 0) patch.roughCut = { ...node.roughCut, ui: s.ru * (w / s.w) }
    // Growing from a west/north handle has to move the opposite corner's
    // anchor, or the node grows away from the hand holding it.
    if (dir.includes('w') || dir.includes('n')) {
      const nx = dir.includes('w') ? s.nx - (w - s.w) * k : s.nx
      const ny = dir.includes('n') ? s.ny - (h - s.h) * k : s.ny
      if (node.pin) patch.pin = { ...node.pin, x: nx, y: ny }
      else { patch.x = nx; patch.y = ny }
    }
    return patch
  }

  const MIN_W = 120, MIN_H = 80
  let w = s.w, h = s.h, nx = s.nx, ny = s.ny
  if (dir.includes('e')) w = Math.max(MIN_W, s.w + dx)
  if (dir.includes('s')) h = Math.max(MIN_H, s.h + dy)
  if (dir.includes('w')) { w = Math.max(MIN_W, s.w - dx); nx = s.nx + (s.w - w) * k }
  if (dir.includes('n')) { h = Math.max(MIN_H, s.h - dy); ny = s.ny + (s.h - h) * k }

  const patch: Partial<FreeNodeData> = { width: w, height: h }
  if (nx !== s.nx || ny !== s.ny) {
    if (node.pin) patch.pin = { ...node.pin, x: nx, y: ny }
    else { patch.x = nx; patch.y = ny }
  }
  return patch
}

/** Can a drag of this tile dock on a loop strip (utils/rail)? A picture —
 *  or a collapsed deck whose face is one, which deals the deck's pictures
 *  into the column — or a single effect card, which takes a slot in the
 *  row. Not a deck of effect cards: a card slot holds ONE card, and the
 *  rest of the deck would be left hidden behind a face that went away. */
function railDockable(n: FreeNodeData, nodes: Nodes): boolean {
  if (n.pin || n.type === 'rail') return false
  if (n.type === 'effect') return !isTileDeckFace(n, nodes)
  return isRailPicture(n)
}

/** Where `dragged` would dock if let go with the pointer at (clientX,
 *  clientY): on the unpinned rail that is topmost under the pointer
 *  (railAtPoint — not one hidden under a panel), or null. The POINTER, not
 *  the tile's box — you aim a card into a column with your hand, and a big
 *  tile held by its corner would otherwise land somewhere you are not
 *  pointing. `skip` is the dragged tile's element, always under the hand. */
function railTargetAt(clientX: number, clientY: number, dragged: FreeNodeData, nodes: Nodes, skip: Element | null): RailDropTarget | null {
  const railId = railAtPoint(clientX, clientY, nodes, skip)
  const rail = railId ? nodes[railId] : undefined
  if (!rail || !isRail(rail) || rail.pin) return null
  const { cx, cy } = clientToCanvas(clientX, clientY)
  const L = railLayout(rail, railMembers(nodes).get(rail.id))
  return L ? railDropTarget(L, rail, { x: cx, y: cy }, dragged) : null
}

/** Put a card that is still LIFTED back in its column, and drop the drop
 *  preview it owns. For a drag that ended without a release this tile
 *  heard: the browser cancelled it, or a zoom-layer switch unmounted the
 *  tile mid-gesture. Without this the card would float off its column (and
 *  the rail keep drawing its insertion marker) until the next launch. */
function landLiftedCard(id: string): void {
  const rs = useRailUiStore.getState()
  if (rs.drop?.draggedId === id) rs.setDrop(null)
  const fns = useFreeNodeStore.getState()
  const d = fns.nodes[id]?.railDock
  if (d?.lifted) fns.updateFreeNode(id, { railDock: { ...d, lifted: undefined } })
}

/** How long the pointer rests on a docked card before it lifts above its
 *  column. Immediate, a lifted card covers the bands of the cards below it,
 *  so running the pointer down a cascade would stick on the first card it
 *  touched; with a short rest each band takes the hover in turn, and the
 *  one you stop on comes up. */
const PEEK_DWELL_MS = 250

interface Props {
  id: string
  /** When this model tile's cluster touches a 3D viewport window, the
   *  window's id — enables the connected affordance + click-to-load. */
  connectedWindowId?: string | null
}

export const FreeNode: React.FC<Props> = React.memo(({ id, connectedWindowId = null }) => {
  const node = useFreeNodeStore(s => s.nodes[id])
  const moveFreeNode = useFreeNodeStore(s => s.moveFreeNode)
  const moveManyFreeNodes = useFreeNodeStore(s => s.moveManyFreeNodes)
  // resizeFreeNode is no longer used here: it only ever grew from the SE
  // corner, and the eight-way handles need to move the anchor as well.
  const updateFreeNode = useFreeNodeStore(s => s.updateFreeNode)
  const deleteFreeNode = useFreeNodeStore(s => s.deleteFreeNode)
  const isSelected = useFreeNodeStore(s => s.selectedIds.includes(id))
  // How many tiles the collapsed deck this node is the FACE of holds, the
  // face included — 0 when it is not a face. A number, so this tile only
  // re-renders when its own deck changes size; and O(1) for every tile
  // that is not a face, which is nearly all of them.
  const deckCount = useFreeNodeStore(s => {
    if (s.nodes[id]?.tileDeck?.anchor !== id) return 0
    let c = 0
    for (const m of Object.values(s.nodes)) if (m.tileDeck?.anchor === id) c++
    return c
  })
  // ── Loop strips (utils/rail) ── docked on a rail that exists: the rail
  // decides where this tile sits and how big it is (the sync host writes
  // it), so it has no resize handles and stacks by its cascade order.
  const docked = useFreeNodeStore(s => isDocked(s.nodes[id], s.nodes))
  // In a 'pick' column only the FACE-UP card — the last one — is used; the
  // ones above it are dimmed. A boolean, so only a change of that re-renders;
  // the column walk only runs for a docked card in a pick column.
  const pickDimmed = useFreeNodeStore(s => {
    const d = s.nodes[id]?.railDock
    if (!d || d.lifted) return false
    const slot = s.nodes[d.railId]?.rail?.slots.find(sl => sl.id === d.slotId)
    if (slot?.kind !== 'role' || slot.mode !== 'pick') return false
    for (const m of Object.values(s.nodes)) {
      const md = m.railDock
      // A card further down the cascade still sits on this column (a lifted
      // one has left it: the column closes up behind it).
      if (m.id !== id && md && !md.lifted && md.railId === d.railId && md.slotId === d.slotId && md.order > d.order) return true
    }
    return false
  })
  /** This tile is being aimed at a rail right now — it floats over the
   *  docked cards it is about to go between. */
  const aimingAtRail = useRailUiStore(s => s.drop?.draggedId === id)
  const setFreeSelection = useFreeNodeStore(s => s.setFreeSelection)
  const toggleFreeSelection = useFreeNodeStore(s => s.toggleFreeSelection)
  const zoom = useCanvasStore(s => s.zoom)
  const movePinnedNodes = useFreeNodeStore(s => s.movePinnedNodes)
  // gz — the multiplier from this node's LAYOUT units to screen pixels.
  // Canvas-placed that is the world zoom; pinned it is the zoom FROZEN at
  // pin time, which is also the wrapper's own transform. Every `/ zoom`
  // in this component means "counter-scale so this stays a constant
  // screen size", and gz is that same quantity for either placement — so
  // the pinned subtree renders byte-identically to the canvas one.
  const gz = node?.pin ? node.pin.scale : zoom

  const [isHovered, setIsHovered] = useState(false)
  const isFresh = useFreshOnTop(s => s.id === id)
  /** A docked card the pointer has rested on (PEEK_DWELL_MS) — lifted above
   *  its column so all of it shows: the solitaire peek. */
  const [rested, setRested] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number } | null>(null)
  const [textEditing, setTextEditing] = useState(false)
  const [isEditingImage, setIsEditingImage] = useState(false)
  const closeMenu = useCallback(() => setNodeMenu(null), [])
  // Desktop "Show in Explorer / Copy path / Open" for the context menu.
  // The url goes in only while the menu is open, so a closed menu resolves
  // nothing; in a plain browser this is always [].
  const fileMenuUrl = nodeMenu && node && MEDIA_TILES.has(node.type) ? node.imageUrl : null
  const fileItems = useFileMenuItems(fileMenuUrl, closeMenu)
  const { ref: nodeMenuRef, top: nodeMenuTop } = useMenuClamp(nodeMenu?.y ?? 0, nodeMenu ? fileItems.length : -1)

  const renameRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const dragLastX = useRef(0)
  const dragLastY = useRef(0)
  const dragHasMoved = useRef(false)
  /** A press on this tile's body is in progress (onNodeDown → release). */
  const dragActive = useRef(false)
  /** This drag can dock on a loop strip — decided once, when it starts. */
  const railDragOk = useRef(false)
  /** Where the tile stood when the press began, canvas units. */
  const dragStart = useRef({ x: 0, y: 0 })
  /** Where the pointer pressed, client px — a drag is measured from here. */
  const dragPress = useRef({ x: 0, y: 0 })
  /** A loop strip grabbed by its header: the Viewer it is docked to and
   *  what that Viewer carries, moved with it (utils/railViewer). */
  const railCarry = useRef<ReturnType<typeof railHeaderCarry>>(null)
  const wasSelectedOnDown = useRef(false)
  const resizeLastX = useRef(0)
  const resizeLastY = useRef(0)
  /** Where the resize press began, and every node it resizes as it stood then. */
  const resizeStart = useRef<{ x: number; y: number; items: ResizeStart[] }>({ x: 0, y: 0, items: [] })
  /** Which handle is being dragged: any of n/s/e/w combined. */
  const resizeDir = useRef('se')

  useEffect(() => { if (isRenaming) renameRef.current?.select() }, [isRenaming])

  // Seed isHovered if the cursor is already over this node when it mounts —
  // covers the "swapped in under stationary cursor" case at zoom-layer
  // transitions (browsers don't fire mouseenter for elements that appear
  // under a cursor that hasn't moved).
  // Only when this tile is the one ON TOP under the cursor, as the browser
  // itself decides hover: cards in a loop-strip column overlap, and every
  // card whose box holds the cursor would otherwise seed as hovered — and,
  // never having been entered, never get the mouseleave that lowers its peek.
  const seedHover = useCallback((v: boolean) => {
    const p = v ? currentPointerPos() : null
    const under = p ? document.elementFromPoint(p.x, p.y) : null
    if (!v || (under && wrapperRef.current?.contains(under))) setIsHovered(v)
  }, [])
  useSeedHoverFromCursor(wrapperRef, seedHover)

  // The peek: a docked card lifts once the pointer has RESTED on it. It is
  // lowered by onMouseLeave, and means nothing while not hovered (see
  // `peeking`), so nothing needs resetting from inside this effect.
  const liftedNow = !!node?.railDock?.lifted
  useEffect(() => {
    if (!docked || !isHovered || liftedNow) return
    const t = setTimeout(() => setRested(true), PEEK_DWELL_MS)
    return () => clearTimeout(t)
  }, [docked, isHovered, liftedNow])

  // Unmounted in the middle of a drag — every canvas tile remounts at the
  // zoom-layer thresholds, and a wheel zoom can cross one mid-gesture — so
  // the release will never reach this tile. Land what the drag left open.
  useEffect(() => {
    const active = dragActive
    return () => { if (active.current) landLiftedCard(id) }
  }, [id])

  // A picture at the head of an effect strip SHOWS the processed result
  // (FxResultLayer), so its drag-out grip hands out that result: `active`
  // while it is showing one, `url` once the file has been written ahead
  // (on hover). Above the early return — it is a hook.
  const fxDrag = useFxDragUrl(id, isHovered)

  // Drag the whole card — anything except textarea/input/select/button/[data-resize]
  /** The drawer front a press landed on: a plain click there opens it. */
  const pressedDrawer = useRef<string | null>(null)
  const menuDrawer = useRef<string | null>(null)
  const pressedName = useRef(false)
  const lastNameClick = useRef<{ drawerId: string; timer: number } | null>(null)
  const onNodeDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    const tag = (e.target as HTMLElement).tagName
    // SELECT too: capturing the pointer on the wrapper would take the press
    // away from a native dropdown (an effect card's name is one).
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT') return
    if ((e.target as Element).closest('[data-resize]')) return
    if ((e.target as Element).closest('[data-pen-button]')) return
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    pressedDrawer.current = (e.target as Element).closest<HTMLElement>('[data-cabinet-front]')?.dataset.cabinetFront ?? null
    pressedName.current = !!(e.target as Element).closest('[data-cabinet-label]')
    dragLastX.current = e.clientX
    dragLastY.current = e.clientY
    dragPress.current = { x: e.clientX, y: e.clientY }
    dragHasMoved.current = false
    dragActive.current = true
    railDragOk.current = false
    const at = useFreeNodeStore.getState().nodes[id]
    dragStart.current = { x: at?.x ?? 0, y: at?.y ?? 0 }
    // A strip on a Viewer is the master: grabbed by its header (the run
    // arrow band and the column headers) it brings the Viewer and all that
    // hangs on it; grabbed by its body it goes alone.
    railCarry.current = null
    if (at && isRail(at) && !at.pin && clientToCanvas(e.clientX, e.clientY).cy < at.y + railHeaderBottom(at)) {
      railCarry.current = railHeaderCarry(id, useCanvasStore.getState().zoom)
    }
    // A card reader (Attributes, Card Prompts) brings what is magneted to
    // it: its docked cards (decks whole) and the panels touching it.
    if (at && !at.pin && CARD_READER_TYPES.has(at.type)) {
      const { groups, boards } = useBoardsStore.getState()
      const all = useFreeNodeStore.getState().nodes
      railCarry.current = {
        windowIds: [],
        groupIds: dockedCards(at, groups, boards).map(g => g.id),
        tileIds: adjacentPanels(at, all).map(n => n.id),
      }
    }
    wrapperRef.current?.setPointerCapture(e.pointerId)
  }, [id])

  const onNodeMove = useCallback((e: React.PointerEvent) => {
    if (!wrapperRef.current?.hasPointerCapture(e.pointerId)) return
    const dx = (e.clientX - dragLastX.current) / gz
    const dy = (e.clientY - dragLastY.current) / gz
    // A drag, by one big step or by the distance from the press: zoomed in,
    // a slow hand moves less than a canvas unit per event, and a docked card
    // would never be picked up (it does not move until it is lifted).
    const fromPress = Math.hypot(e.clientX - dragPress.current.x, e.clientY - dragPress.current.y)
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || fromPress > 3) {
      if (!dragHasMoved.current) {
        // The drag has really started. A card docked on a loop strip is
        // picked UP: its column closes up behind it and the rail stops
        // placing it, but it still belongs there until the release decides.
        // No checkpoint — onNodeDown took the one for this gesture.
        const fns = useFreeNodeStore.getState()
        const cur = fns.nodes[id]
        if (cur?.railDock && !cur.railDock.lifted && isRail(fns.nodes[cur.railDock.railId])) {
          fns.updateFreeNode(id, { railDock: { ...cur.railDock, lifted: true } })
          // It stood still until now: catch up with the hand, less this
          // event's own step, which the move below makes.
          moveFreeNode(id, (e.clientX - dragPress.current.x) / gz - dx, (e.clientY - dragPress.current.y) / gz - dy)
        }
        // Read after the lift, so a lifted card is judged as what it is.
        const now = useFreeNodeStore.getState().nodes
        railDragOk.current = !!now[id] && railDockable(now[id], now)
      }
      dragHasMoved.current = true
    }
    // Move all selected nodes together if this node is part of the
    // selection — but only same-placement siblings, since a canvas delta
    // and a screen delta are different quantities.
    const sel = useFreeNodeStore.getState().selectedIds
    const all = useFreeNodeStore.getState().nodes
    const self = all[id]
    if (self?.railDock) {
      // A card off a strip travels ALONE, and only once it is lifted: until
      // then the rail owns its box, and moving it would only fight the sync
      // host that puts it back.
      if (self.railDock.lifted) moveFreeNode(id, dx, dy)
    } else if (railCarry.current && !node?.pin) {
      // Viewer first, then the strip and the tiles in ONE move, so the
      // strip is never seen off its Viewer between the two.
      const carry = railCarry.current
      for (const wid of carry.windowIds) useViewport3DStore.getState().moveWindow(wid, dx, dy)
      if (carry.groupIds.length > 0) {
        const bs = useBoardsStore.getState()
        bs.setGroupPosBatch(carry.groupIds.flatMap(gid => {
          const g = bs.groups.find(x => x.id === gid)
          return g ? [{ groupId: gid, originX: g.originX + dx, originY: g.originY + dy }] : []
        }))
      }
      const inSel = sel.length > 1 && sel.includes(id)
        ? sel.filter(sid => !all[sid]?.pin && !all[sid]?.railDock) : [id]
      moveManyFreeNodes([...new Set([...inSel, ...carry.tileIds])], dx, dy)
    } else if (sel.length > 1 && sel.includes(id)) {
      // Docked tiles stay where their rails put them; a selected rail
      // carries its own cards along through the sync host.
      const same = sel.filter(sid => !!all[sid]?.pin === !!node?.pin && !all[sid]?.railDock)
      if (node?.pin) movePinnedNodes(same, e.clientX - dragLastX.current, e.clientY - dragLastY.current)
      else moveManyFreeNodes(same, dx, dy)
    } else if (node?.pin) {
      movePinnedNodes([id], e.clientX - dragLastX.current, e.clientY - dragLastY.current)
    } else {
      moveFreeNode(id, dx, dy)
    }
    dragLastX.current = e.clientX
    dragLastY.current = e.clientY
    // Magnet affordance: dockable tiles (content-bearing + lists) near a
    // browser window edge show a "will snap here" ghost.
    const n = useFreeNodeStore.getState().nodes[id]
    // Over a drawer: which one a release would put it in.
    if (n && !n.pin && canStowTile(n)) {
      const fs = useFreeNodeStore.getState()
      aimCabinet(e.clientX, e.clientY, fs.selectedIds.includes(id) ? fs.selectedIds : [id])
    }
    // LOOP STRIP drop preview: where a release would dock, under the
    // pointer. The tile writes it; the rail (RailBody) draws the marker.
    // Outranks the Viewer magnet below, as the release does.
    let railAim: RailDropTarget | null = null
    if (n && dragHasMoved.current && railDragOk.current) {
      railAim = railTargetAt(e.clientX, e.clientY, n, useFreeNodeStore.getState().nodes, wrapperRef.current)
    }
    {
      const rs = useRailUiStore.getState()
      if (railAim) rs.setDrop({ target: railAim, draggedId: id })
      else if (rs.drop?.draggedId === id) rs.setDrop(null)
    }
    if (railAim) {
      // A Viewer ghost from a moment ago would promise a landing that the
      // rail is about to take instead.
      const mp = useMagnetPreviewStore.getState()
      if (mp.preview) mp.setPreview(null)
    }
    // Magnet is canvas-only: cross-placement docking does not exist, and
    // snapping would write canvas coords into a node whose position is
    // screen-space. Never for a card that is (or was until this drag) on a
    // loop strip: the rail is where it lives.
    else if (n && !n.pin && !n.railDock && isDockableTile(n)) {
      // Canvas windows ONLY. A pinned window's x/y are its stale pre-pin
      // home; while it is pinned it lives on the screen, so letting a
      // canvas tile magnet to that ghost attaches two things that are
      // nowhere near each other. Same rule the docking reader uses.
      // Header-inclusive rects: docking against the bare win.y snapped
      // top-docked tiles UNDER the header instead of onto its top edge.
      const winRects: WindowRect[] = Object.values(useViewport3DStore.getState().windows)
        .filter(w => !w.pin)
        .map(w => viewportVisualRect(w, zoom))
      const cand = winRects.length > 0 ? findMagnetCandidate(n, winRects, magnetRadiusForZoom(zoom)) : null
      const mp = useMagnetPreviewStore.getState()
      if (cand) {
        const t = winRects.find(w => w.id === cand.windowId)!
        mp.setPreview({
          edge: cand.edge, space: 'canvas', windowId: cand.windowId,
          x: cand.snapped.x, y: cand.snapped.y, width: n.width, height: n.height,
          target: { x: t.x, y: t.y, width: t.width, height: t.height },
        })
      } else if (mp.preview) {
        mp.setPreview(null)
      }
    }
    // PANEL → PANEL, in either placement. This is the same gesture, so it
    // gets the same affordance: without it, panel snaps were the one magnet
    // where you only found out where it landed after letting go.
    if (n && isPanelType(n.type)) {
      const snap = snapPanelToPanel(
        n, useFreeNodeStore.getState().nodes, zoom,
        useViewport3DStore.getState().windows)
      const mp = useMagnetPreviewStore.getState()
      if (snap) {
        const scale = n.pin ? n.pin.scale : 1
        mp.setPreview({
          edge: snap.edge,
          space: n.pin ? 'screen' : 'canvas',
          x: snap.x, y: snap.y,
          width: n.width * scale, height: n.height * scale,
          target: snap.target,
        })
      } else if (mp.preview) {
        mp.setPreview(null)
      }
    }
  }, [id, moveFreeNode, moveManyFreeNodes, movePinnedNodes, node?.pin, gz, zoom])

  const onNodeUp = useCallback((e: React.PointerEvent) => {
    if (!wrapperRef.current?.hasPointerCapture(e.pointerId)) return
    // Fresh read up front — NOTE: this intentionally shadows the component-
    // scope `node`; declaring it lower created a temporal-dead-zone throw
    // for any reference above the declaration (broke no-drag clicks).
    const node = useFreeNodeStore.getState().nodes[id]
    dragActive.current = false
    // The drop preview belongs to the drag, which ends here whatever lands.
    {
      const rs = useRailUiStore.getState()
      if (rs.drop?.draggedId === id) rs.setDrop(null)
    }
    if (!node) return
    // Screen-placed nodes never take part in the canvas drop-transfer
    // scan below: it hit-tests with elementsFromPoint (screen space) and
    // ends by deleting the source, so a pinned tile nudged over a card
    // would hand over its media and destroy itself.
    if (node.pin && dragHasMoved.current) {
      // …but a pinned PANEL still magnets to its pinned neighbours, which
      // is how a pinned pool/rolodex/viewer row gets built on screen.
      useMagnetPreviewStore.getState().setPreview(null)
      const snap = snapPanelToPanel(
        node, useFreeNodeStore.getState().nodes, zoom,
        useViewport3DStore.getState().windows)
      if (snap && node.pin) updateFreeNode(id, { pin: { ...node.pin, x: snap.x, y: snap.y } })
      try { wrapperRef.current?.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
      dragHasMoved.current = false
      return
    }
    useCabinetUi.getState().setAim(null)
    if (!dragHasMoved.current) {
      if (pressedDrawer.current) {
        // On a drawer's name, a second click soon after edits it. So a single
        // click there waits to see, and the drawer does not flap open and shut.
        const drawerId = pressedDrawer.current
        const last = lastNameClick.current
        if (!pressedName.current) toggleDrawer(id, drawerId)
        else if (last && last.drawerId === drawerId) {
          clearTimeout(last.timer)
          lastNameClick.current = null
          useCabinetUi.getState().setRenaming(`${id}:${drawerId}`)
        } else {
          if (last) clearTimeout(last.timer)
          lastNameClick.current = {
            drawerId,
            timer: window.setTimeout(() => { lastNameClick.current = null; toggleDrawer(id, drawerId) }, 300),
          }
        }
      }
      if (e.shiftKey) toggleFreeSelection(id)
      else {
        // If text node was already selected before this click, single click on body → enter edit
        // Header clicks never reach here (stopPropagation on header div prevents pointer capture)
        if (node.type === 'text' && wasSelectedOnDown.current && !isRenaming) {
          setTextEditing(true)
        }
        setFreeSelection([id])
        // Connected content tile: a plain click also shows its item in
        // the browser window its cluster touches (alongside the strip).
        if (connectedWindowId) {
          const item = tileBrowseItem(node)
          if (item) useViewport3DStore.getState().setActiveItem(connectedWindowId, item)
        }
      }
    }
    // ── Project cabinet ── a tile let go over a drawer goes in, and so does
    // the selection it was dragged with. The press took the checkpoint.
    if (dragHasMoved.current && !node.pin && canStowTile(node)) {
      const sel = useFreeNodeStore.getState().selectedIds
      const ids = sel.includes(id) ? sel : [id]
      const drawer = cabinetDrawerAt(e.clientX, e.clientY, ids)
      if (drawer && stowTiles(ids, drawer)) {
        useMagnetPreviewStore.getState().setPreview(null)
        useRailUiStore.getState().setDrop(null)
        return
      }
    }
    // ── Loop strip ── FIRST, before the Viewer dock, the strip snap and the
    // transfer scan: a card let go over a rail docks there, where the
    // preview said. A deck of pictures is DEALT into the column, its
    // pictures in deck order.
    if (dragHasMoved.current && (railDragOk.current || node.railDock?.lifted)) {
      const fns = useFreeNodeStore.getState()
      const target = railDragOk.current ? railTargetAt(e.clientX, e.clientY, node, fns.nodes, wrapperRef.current) : null
      if (target) {
        if (useMagnetPreviewStore.getState().preview) useMagnetPreviewStore.getState().setPreview(null)
        // What goes in: this tile — and when it was dragged as part of a
        // selection, every selected picture that travelled with it, a hand
        // dealt into the column in reading order (left behind, they would
        // lie loose on top of the rail). A deck face goes in as its pictures.
        const sel = fns.selectedIds
        const movers = target.kind === 'column' && !node.railDock && sel.length > 1 && sel.includes(id)
          ? sel.map(s => fns.nodes[s])
              .filter((m): m is FreeNodeData => !!m && !m.pin && !m.railDock && m.type !== 'effect' && railDockable(m, fns.nodes))
              .sort((a, b) => (a.y - b.y) || (a.x - b.x))
          : [node]
        const ids: string[] = []
        const rest: FreeNodeData[] = []
        for (const m of movers) {
          if (!isTileDeckFace(m, fns.nodes)) { ids.push(m.id); continue }
          for (const dm of tileDeckMembers(m.id, fns.nodes)) {
            if (isRailPicture(dm)) ids.push(dm.id); else rest.push(dm)
          }
        }
        // The raw target: dockToRail itself allows for a card moving along
        // its own row (its old slot sat before the insert point).
        fns.dockToRail(ids, target)
        // A deck's other cards (its effect cards, a note) have no place in
        // a column. They open where the deck was picked up, in its open
        // layout — not left hidden behind a face that is no longer one.
        if (rest.length > 0) {
          const ddx = node.x - dragStart.current.x, ddy = node.y - dragStart.current.y
          useFreeNodeStore.setState(s => {
            const nodes = { ...s.nodes }
            for (const m of rest) {
              const cur = nodes[m.id]
              if (cur) nodes[m.id] = { ...cur, tileDeck: undefined, x: cur.x - ddx, y: cur.y - ddy }
            }
            return { nodes }
          })
        }
        return
      }
      if (node.railDock?.lifted) {
        // Let go ON a rail where nothing docks (a tray, a card slot, the
        // arrow): back to its column. Set down there as a free tile, it
        // would lie under the rail's cascades, out of sight.
        if (railAtPoint(e.clientX, e.clientY, fns.nodes, wrapperRef.current)) {
          landLiftedCard(id)
          if (useMagnetPreviewStore.getState().preview) useMagnetPreviewStore.getState().setPreview(null)
          return
        }
        // Pulled off its strip and let go elsewhere: a free tile again, at
        // its own size, still held at the same spot under the hand. An
        // effect card keeps the size it had on the strip (Brian 2026-11-05).
        const held = clientToCanvas(e.clientX, e.clientY)
        const fx = node.width > 0 ? Math.min(1, Math.max(0, (held.cx - node.x) / node.width)) : 0
        const fy = node.height > 0 ? Math.min(1, Math.max(0, (held.cy - node.y) / node.height)) : 0
        const stripSize = fns.nodes[id]
        fns.undockFromRail(id)
        if (node.type === 'effect' && stripSize) fns.updateFreeNode(id, { width: stripSize.width, height: stripSize.height })
        const free = useFreeNodeStore.getState().nodes[id]
        if (free) fns.updateFreeNode(id, { x: held.cx - fx * free.width, y: held.cy - fy * free.height })
        // An effect card still lines up with a strip it lands beside — it is
        // an ordinary card now. Nothing else applies: no Viewer dock (no
        // ghost was offered while it was on the strip), and never the
        // transfer scan, which ends by deleting the tile.
        const cur = useFreeNodeStore.getState().nodes[id]
        if (cur?.type === 'effect') {
          const snap = snapToStrip(cur, useFreeNodeStore.getState().nodes, useViewport3DStore.getState().windows, zoom)
          if (snap) moveFreeNode(id, snap.x - cur.x, snap.y - cur.y)
        }
        if (useMagnetPreviewStore.getState().preview) useMagnetPreviewStore.getState().setPreview(null)
        return
      }
    }
    // A loop strip let go by a Viewer's left edge docks to it, its right end
    // flush (utils/railViewer): the Viewer then shows its live result.
    if (dragHasMoved.current && node.type === 'rail' && !node.pin) snapRailToViewer(id, zoom)
    // A free tile let go on a rail where it does not dock (a note, a picture
    // on the tray): set down just under the rail, as 'Take off the strip'
    // does. Left there, it would lie beneath the rail's cascades.
    if (dragHasMoved.current && !node.pin && !node.railDock && node.type !== 'rail') {
      const fns = useFreeNodeStore.getState()
      const over = railAtPoint(e.clientX, e.clientY, fns.nodes, wrapperRef.current)
      const rail = over ? fns.nodes[over] : undefined
      if (rail) {
        moveFreeNode(id, 0, rail.y + rail.height + RAIL_GEOM.gap * (rail.rail?.unit ?? 1) - node.y)
        if (useMagnetPreviewStore.getState().preview) useMagnetPreviewStore.getState().setPreview(null)
        return
      }
    }
    // Transfer node content to a bar/card on drop
    // Magnet dock: a content tile released near a browser window edge
    // snaps flush and loads its item. The tile is KEPT (dock membership
    // stays derived from its position) — outranks the transfer scan below.
    {
      const preview = useMagnetPreviewStore.getState().preview
      if (preview) useMagnetPreviewStore.getState().setPreview(null)
      // Only a VIEWER preview docks — a panel-to-panel ghost has no window
      // and is handled by the panel magnet below. Never a docked card.
      if (dragHasMoved.current && !node.railDock && isDockableTile(node) && preview?.windowId) {
        const cur = useFreeNodeStore.getState().nodes[id]
        // As a DELTA through the move action, not an x/y write: a deck face
        // takes the tiles hidden behind it along, and a write would leave
        // them where the face was let go.
        if (cur) moveFreeNode(id, preview.x - cur.x, preview.y - cur.y)
        // Content tiles load their item; LIST tiles just snap — the
        // strip's reconciliation picks the default from their results.
        const dockItem = tileBrowseItem(node)
        if (dockItem) useViewport3DStore.getState().setActiveItem(preview.windowId, dockItem)
        return
      }
    }
    // Panel magnet: the modular apps snap flush to each other. This is what
    // actually forms the derived links (pool → rolodex → viewer) — the link
    // test is tight on purpose, so landing inside it is the magnet's job.
    // Runs AFTER the window magnet, so docking to a Viewer still wins.
    if (dragHasMoved.current && isPanelType(node.type)) {
      const cur = useFreeNodeStore.getState().nodes[id]
      const snap = cur
        ? snapPanelToPanel(cur, useFreeNodeStore.getState().nodes, zoom,
                           useViewport3DStore.getState().windows)
        : null
      if (snap) updateFreeNode(id, { x: snap.x, y: snap.y })
      // A card reader's carried cards and panels take the same last step.
      const carry = railCarry.current
      if (snap && cur && carry && CARD_READER_TYPES.has(cur.type) && (snap.x !== cur.x || snap.y !== cur.y)) {
        const ddx = snap.x - cur.x, ddy = snap.y - cur.y
        const bs = useBoardsStore.getState()
        bs.setGroupPosBatch(carry.groupIds.flatMap(gid => {
          const g = bs.groups.find(x => x.id === gid)
          return g ? [{ groupId: gid, originX: g.originX + ddx, originY: g.originY + ddy }] : []
        }))
        moveManyFreeNodes(carry.tileIds, ddx, ddy)
      }
    }
    // Effect strip: an effect card let go near a card's or a Viewer's left
    // or right edge lines up flush with it — how a strip gets built.
    // Not a card on a loop strip: the rail is its line.
    if (dragHasMoved.current && node.type === 'effect' && !node.pin && !node.railDock) {
      const cur = useFreeNodeStore.getState().nodes[id]
      const snap = cur
        ? snapToStrip(cur, useFreeNodeStore.getState().nodes, useViewport3DStore.getState().windows, zoom, dragStart.current)
        : null
      // A delta, for the same reason as the Viewer dock above.
      if (snap && cur) moveFreeNode(id, snap.x - cur.x, snap.y - cur.y)
    }
    // A deck FACE never transfers. The scan below hands over the face's own
    // media and then deletes the tile — which, for a face, is the deck. Nor
    // does a loop strip, or a card docked on one: the rail is its home, and
    // a slip over a bar behind the rail must not destroy it.
    if (dragHasMoved.current && node && node.type !== 'rail' && !node.railDock &&
        !isTileDeckFace(node, useFreeNodeStore.getState().nodes)) {
      const hasMedia = !!node.imageUrl
      const hasText = !!(node.text && (node.type === 'text' || node.type === 'note'))
      if (hasMedia || hasText) {
        wrapperRef.current!.style.pointerEvents = 'none'
        // …minus this tile's own children that re-enable pointer events
        // (its header buttons, the drag-out grip): the walks below stop at
        // the first tile they meet, and that must never be this one.
        const self = wrapperRef.current!
        const hits = document.elementsFromPoint(e.clientX, e.clientY).filter(el => !self.contains(el))
        wrapperRef.current!.style.pointerEvents = ''
        // Nothing passes THROUGH a loop strip. A tile let go on a rail where
        // it does not dock (its arrow band, its tray) stays where it was let
        // go; what lies under the rail is covered by it, and a transfer into
        // a bar hidden back there would delete the tile.
        const railAt = hits.findIndex(el => !!el.closest('[data-rail]'))
        const allEls = railAt >= 0 ? hits.slice(0, railAt) : hits

        const mediaType = node.mediaType ?? 'image'

        // Helper: transfer to a specific bar
        const transferToBar = (boardId: string, barId: string) => {
          if (hasMedia && node.imageUrl) {
            const curMedia = useBoardsStore.getState().boards[boardId]?.bars[barId]?.content.media ?? []
            const posterUrl = mediaType === 'model' || mediaType === 'video'
              ? transferablePoster(node) : node.posterUrl ?? null
            useBoardsStore.getState().setContent(boardId, barId, {
              media: [...curMedia, {
                url: node.imageUrl, type: mediaType,
                ...(posterUrl ? { posterUrl } : {}),
                ...(node.label ? { originalName: node.label } : {}),
              }],
            })
          }
          if (hasText) {
            const curText = useBoardsStore.getState().boards[boardId]?.bars[barId]?.content.text ?? ''
            const newText = curText ? curText + '\n' + node.text : node.text
            const patch: Record<string, any> = { text: newText }
            // Carry text formatting through if this node has a textStyle
            if (node.textStyle) {
              patch.textStyle = { ...node.textStyle }
            }
            useBoardsStore.getState().setContent(boardId, barId, patch)
          }
          useFreeNodeStore.getState().deleteFreeNode(id)
        }

        // Helper: media dropped on a CARD goes INTO it as a block of its
        // own, the media on that block's top bar (utils/cardContent) — the
        // same rule a file or Media Pool drop follows. Nothing on the card
        // is replaced; its face keeps showing the first picture it holds.
        const addMediaBlock = (groupId: string): boolean => {
          if (!node.imageUrl) return false
          const poster = mediaType === 'model' || mediaType === 'video' ? transferablePoster(node) : null
          const landed = addMediaBlockToCard(groupId, {
            url: node.imageUrl, type: mediaType,
            ...(poster ? { posterUrl: poster } : {}),
            ...(node.label ? { originalName: node.label } : {}),
          }, node.label || undefined)
          if (!landed) return false
          useFreeNodeStore.getState().deleteFreeNode(id)
          return true
        }

        // Priority: board-level blocks > block-layer blocks > cards
        let transferred = false

        // Board zoom (>= 0.3): transfer to specific bar
        for (const el of allEls) {
          const block = el.closest('[data-block][data-id]') as HTMLElement | null
          if (block && !block.dataset.layerBlock) {
            transferToBar(block.dataset.boardId ?? 'primary', block.dataset.id!)
            transferred = true
            break
          }
        }

        // Block zoom (0.17–0.3): transfer to block-level independent text.
        // An image becomes the block's thumbnail. Anything a thumbnail
        // cannot show — a model, a video, audio — transfers INTO the card's
        // content as a block of its own instead (an .mp4 or a .glb in an
        // <img> renders blank or broken).
        if (!transferred) {
          for (const el of allEls) {
            const block = el.closest('[data-layer-block]') as HTMLElement | null
            if (block) {
              const targetBoardId = block.getAttribute('data-layer-block')!
              if (hasMedia && mediaType !== 'image') {
                // The target board's group → own block there. The group
                // that holds the board wins — default-group too, it is a
                // real card; only a board no group holds is grouped.
                const targetGroupId = groupForCardHit({ boardId: targetBoardId })
                if (!targetGroupId) break   // nowhere to hold it — leave the tile
                if (!addMediaBlock(targetGroupId)) break
                transferred = true
                break
              }
              if (hasText) {
                const curText = useBoardsStore.getState().boards[targetBoardId]?.layers?.block?.text ?? ''
                const newText = curText ? curText + '\n' + node.text : node.text
                useBoardsStore.getState().setBlockText(targetBoardId, newText)
              }
              if (hasMedia && node.imageUrl) {
                useBoardsStore.getState().setBlockThumbnail(targetBoardId, node.imageUrl)
              }
              useFreeNodeStore.getState().deleteFreeNode(id)
              transferred = true
              break
            }
          }
        }

        // Card zoom (≤ 0.17): media of every kind transfers INTO the card's
        // content as a block of its own (enabling cards dense with
        // references, and decks of models). The card is found by cardHitAt,
        // the rule a file or Media Pool drop follows, so a stacked deck, a
        // fan strip or a clone takes it just as a plain card does. The hero
        // is never overwritten — a model only fills an empty one from its
        // POSTER.
        if (!transferred && hasMedia && node.imageUrl) {
          const hit = cardHitAt(allEls)
          const targetGroupId = hit ? groupForCardHit(hit) : null
          const targetGroup = targetGroupId
            ? useBoardsStore.getState().groups.find(g => g.id === targetGroupId)
            : undefined
          if (targetGroup) {
            if (mediaType === 'model') {
              const poster = transferablePoster(node)
              if (poster && !targetGroup.cardHeroImage) {
                useBoardsStore.getState().setGroupCardHeroImage(targetGroup.id, poster)
              }
            }
            if (addMediaBlock(targetGroup.id)) transferred = true
          }
        }

        // Card zoom, text: transfers to card-level independent text.
        if (!transferred && !hasMedia && hasText) {
          for (const el of allEls) {
            const card = el.closest('[data-nle-card]') as HTMLElement | null
            if (card) {
              const targetBoardId = card.dataset.nleCard!
              // Check if this is a group card or ungrouped
              const layerCard = card.closest('[data-layer-card]') as HTMLElement | null
              const groupId = layerCard?.getAttribute('data-layer-card')
              if (groupId) {
                const curText = useBoardsStore.getState().groups.find(g => g.id === groupId)?.cardText ?? ''
                const newText = curText ? curText + '\n' + node.text : node.text
                useBoardsStore.getState().setGroupCardText(groupId, newText)
              } else {
                const curText = useBoardsStore.getState().boards[targetBoardId]?.layers?.card?.text ?? ''
                const newText = curText ? curText + '\n' + node.text : node.text
                useBoardsStore.getState().setCardText(targetBoardId, newText)
              }
              useFreeNodeStore.getState().deleteFreeNode(id)
              transferred = true
              break
            }
          }
        }

        if (transferred) return
      }
    }
    // No transfer happened — user placed the node here intentionally, leave it.
  }, [id, node?.type, node?.imageUrl, connectedWindowId, isSelected, isRenaming, setFreeSelection, toggleFreeSelection, updateFreeNode, moveFreeNode, zoom])

  // A drag the browser ended without a release here: a pointercancel, or
  // the capture lost some other way. After a normal release onNodeUp has
  // already settled everything (dragActive is down), so this does nothing.
  const onNodeLostCapture = useCallback(() => {
    if (!dragActive.current) return
    dragActive.current = false
    landLiftedCard(id)
  }, [id])

  // Resize handles — eight of them, so a panel can be reshaped from any
  // edge or corner instead of only being dragged bigger from one corner.
  // With this node in a multi-selection, the drag resizes every selected
  // node that has handles of its own, each by the same amount from its own
  // corner, as if each had been dragged on its own. One undo step.
  const onResizeDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    resizeDir.current = (e.currentTarget as HTMLElement).dataset.resize || 'se'
    resizeLastX.current = e.clientX
    resizeLastY.current = e.clientY
    // Resizing works from the drag START, not incrementally: the width and
    // height floors clamp independently, so an incremental path lets one
    // axis stick at its floor while the other keeps going — the aspect
    // drifts, and a west/north drag walks the node sideways.
    const { nodes, selectedIds } = useFreeNodeStore.getState()
    const others = selectedIds.includes(id)
      ? selectedIds.filter(sid => sid !== id).map(sid => nodes[sid]).filter(n => resizableAlongside(n, nodes))
      : []
    resizeStart.current = {
      x: e.clientX, y: e.clientY,
      items: [resizeStartOf(node), ...others.map(resizeStartOf)],
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [id, node])

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const s = resizeStart.current
    const dir = resizeDir.current
    const nodes = useFreeNodeStore.getState().nodes
    for (const item of s.items) {
      const n = nodes[item.id]
      if (!n) continue
      // Each node measures the drag in its own layout units: a pinned one
      // at its frozen pin scale, a canvas one at the live zoom.
      const nz = n.pin ? n.pin.scale : zoom
      updateFreeNode(item.id, resizePatch(n, item, dir, (e.clientX - s.x) / nz, (e.clientY - s.y) / nz, e.shiftKey))
    }
  }, [updateFreeNode, zoom])

  const commitRename = useCallback(() => {
    if (renameVal.trim()) updateFreeNode(id, { label: renameVal.trim() })
    setIsRenaming(false)
  }, [id, renameVal, updateFreeNode])

  /** The tile-deck gesture (utils/tileDecks): opens the deck this tile is
   *  the face of, or collapses the tiles touching it into one. One undo
   *  step either way. Returns whether anything happened, so a double-click
   *  that did nothing is left to whatever else wants it. */
  const toggleTileDeck = useCallback((): boolean => {
    const fns = useFreeNodeStore.getState()
    const cur = fns.nodes[id]
    if (!cur) return false
    if (isTileDeckFace(cur, fns.nodes)) {
      useUndoCoordinator.getState().checkpoint()
      fns.expandTileDeck(id)
      return true
    }
    const cluster = touchingTileCluster(id, fns.nodes)
    if (cluster.length < 2) return false
    useUndoCoordinator.getState().checkpoint()
    return fns.collapseTiles(cluster) !== null
  }, [id])


  if (!node) return null

  // Inverse-zoom scaling: keep header text and controls readable at any canvas zoom.
  // At zoom 0.12, a canvas-space value of X appears as X*0.12 on screen,
  // so we scale up by 1/zoom to maintain roughly constant screen-pixel sizes.
  const iz = 1 / gz
  // Damped inverse-zoom: sqrt(1/zoom). Shrinks more gently than linear zoom,
  // grows more gently than full iz. Used for body content (text, icons, waveforms).
  const dz = 1 / Math.sqrt(gz)
  // Counter-scaled chrome has to be capped against the NODE'S OWN box, not
  // just against the screen. 20*iz and 40*iz are "constant screen pixels",
  // which is right while the tile is big — but zoomed out they grow past
  // the tile itself (at zoom 0.1 the 40*iz corner is 400 canvas units over
  // a ~220-unit tile), so the whole node becomes header + resize corner
  // with no body left to grab. Every interactive zone below therefore
  // takes a fraction of the node as a ceiling, which leaves ~70% of each
  // axis — ~91% of the area — as drag surface at ANY zoom.
  // 22, matching Viewport3DFrame's header exactly. A docked tile's top
  // already lined up with the Viewer's, but at 20 against 22 the two header
  // BOTTOMS were two pixels apart, so a row of docked things read as a
  // ragged band instead of one strip. The node cap still wins on small
  // tiles — a 40px tile has no business carrying a 22px header.
  const headerH = Math.min(22 * iz, node.height * 0.28)
  /** A loop strip (utils/rail): the whole tile is the rail's face, which
   *  RailBody paints — no title bar, no handles (it sizes itself to its
   *  layout), no pen, no pin. */
  const isRailTile = node.type === 'rail'
  const isCabinet = node.type === 'cabinet'
  /** The rail's own unit — every rail size scales by it, like a card made
   *  at that zoom. */
  const railU = node.rail?.unit && node.rail.unit > 0 ? node.rail.unit : 1
  /** Lifted off its column by a drag in flight. */
  const lifted = !!node.railDock?.lifted
  /** Resting under the pointer long enough to lift above its column. */
  const peeking = docked && isHovered && rested
  const dockOrder = node.railDock?.order ?? 0
  /** Effect cards wear no title bar: the whole tile is the card's face
   *  (EffectTileBody), its name banner included. A docked card keeps its
   *  bar: it is the band that shows in the cascade, like a card's rank. */
  const showHeader = node.type !== 'effect' && !isRailTile
  /** Where the body starts — the header's height, or 0 without one. */
  const bodyTop = showHeader ? headerH : 0
  // An effect card's sliders run nearly edge to edge, and a resize zone
  // lying over one takes its presses — the value would not move. Only the
  // SE grip can: it sits at z 20 AFTER the body, so it beats the face's
  // controls, which EffectTileBody lifts (CONTROL_Z 20) over the z-19
  // strips and corners. So only the grip keeps to the face's margin (the
  // rows sit 4u in, corner overlap 2u), in the face's OWN unit — u is
  // min(width/100, height/128) there, so a card squashed by an old free
  // resize has rows nearer its edge than width/100 alone would say.
  // Infinity elsewhere, i.e. no extra cap.
  const faceU = node.type === 'effect'
    ? Math.min(node.width / 100, node.height / EFFECT_FACE_HEIGHT_U) : Infinity
  const grabZone = Math.min(40 * iz, node.width * 0.3, node.height * 0.3, 6 * faceU)
  // Edge and corner zones follow the same rule as every other counter-scaled
  // hit target here: a constant screen size, capped against the node's own
  // box so that zooming out cannot turn the whole tile into handles.
  const cornerZone = Math.min(18 * iz, node.width * 0.22, node.height * 0.22)
  const edgeZone   = Math.min(9 * iz, node.width * 0.12, node.height * 0.12)
  // The grip's dots: a fixed minimum screen size on an effect card, not a
  // fraction of its capped square — 0.075 of 6u is under a pixel at any
  // normal zoom, which read as "this card cannot be resized".
  const gripDot = node.type === 'effect'
    ? Math.min(Math.max(1.5 * iz, grabZone * 0.075), grabZone * 0.22)
    : grabZone * 0.075
  const gripGap = node.type === 'effect' ? gripDot * 0.5 : grabZone * 0.05
  // Sides stop short of the corners so the corner always wins its own patch.
  const sideInset  = cornerZone
  /** This node's bottom edge is a drawer pull, so the resize zones there
   *  have to stay out of its way. */
  const drawerSafe = LOCKS_ASPECT.has(node.type)
  // Padding is counter-scaled too, so it needs the same ceiling — an
  // unclamped 6*iz is 100 canvas units at zoom 0.06 and, under content-box
  // sizing, lands OUTSIDE the capped header height and re-inflates it.
  const pad      = Math.min(6 * iz, node.width * 0.05, node.height * 0.05)
  const fontSize = Math.min(11 * iz, headerH * 0.55)
  const dotSize  = Math.min(5 * iz, headerH * 0.35)
  // Header buttons — the pen and the drag-out grip share one size.
  const headerBtn = Math.min(Math.max(14, 14 * iz), node.width * 0.16, headerH * 0.9)
  // Same disease as the zones above: an unclamped 2/zoom border is 33
  // canvas units at zoom 0.06, which is 4 of a 12-pixel tile — it shrinks
  // the content box until the corner zone starts a hair from the centre.
  const borderW  = Math.min(Math.max(1, 2 / gz), node.width * 0.04, node.height * 0.04)
  /** COMPONENT nodes are panels, not media tiles, so they wear the panel's
   *  chrome — identically in both placements. */
  const isPanel = isPanelType(node.type)

  // ── Collapsed tile deck ── a FACE draws the way a stacked card deck does
  // (CardLayer's StackedDeckCard): its own content, narrowed by an edge
  // reserve, with up to two edges peeking out on the right, so the deck
  // keeps exactly the face's footprint. World space, so every size is
  // counter-scaled by iz and capped against the tile, like the zones above.
  // Canvas only: a face cannot be pinned.
  const isDeckFace = deckCount >= 2 && !node.pin
  const peek = Math.min(3 * iz, node.width * 0.02)
  const deckReserve = isDeckFace ? peek * 2 + Math.min(4 * iz, node.width * 0.025) : 0
  /** The width the tile's own box is drawn at — narrower on a deck face. */
  const faceW = node.width - deckReserve
  /** The tile's border: none on a panel or a rail. */
  const edgeW = isPanel || isRailTile ? 0 : borderW
  /** As flat lays it out: a border is a whole number of screen pixels at
   *  the page's own zoom (at least one), so a 11.1 border takes 11. */
  const dpr = window.devicePixelRatio || 1
  const edgeSnap = !edgeW ? 0 : edgeW * dpr < 1 ? 1 / dpr : Math.floor(edgeW * dpr) / dpr
  /** The tile's corner radius, and the one inside its border. */
  const tileR = (isPanel ? 12 : 10) / gz
  const innerR = Math.max(0, tileR - edgeSnap)

  /** Drag-out carries the whole selection when this tile is part of it,
   *  this tile first. Read at dragstart rather than subscribed, so the grip
   *  does not re-render on every selection change. Shift on a deck face:
   *  every file in the deck, the face's first. */
  const dragOutUrls = ({ all }: { all: boolean }): string[] => {
    const own = node.imageUrl
    if (!own) return []
    const { selectedIds, nodes } = useFreeNodeStore.getState()
    if (all && isDeckFace) {
      return tileDeckMembers(id, nodes).flatMap(m => MEDIA_TILES.has(m.type) && m.imageUrl ? [m.imageUrl] : [])
    }
    if (!selectedIds.includes(id)) return [own]
    const rest = selectedIds.flatMap(sid => {
      const n = sid === id ? null : nodes[sid]
      return n && MEDIA_TILES.has(n.type) && n.imageUrl ? [n.imageUrl] : []
    })
    return [own, ...rest]
  }

  // The peeking edges — StackedDeckCard's recipe in tile units. Siblings of
  // the tile, not children: its box clips (overflow hidden). Drawn first at
  // the tile's own zIndex, so the face paints over the hairline they share.
  // Edge 1 always; edge 2 only for three tiles or more, as with cards.
  const deckEdges = isDeckFace ? (() => {
    const vIn = Math.min(5 * iz, node.height * 0.04)
    const sw = Math.min(2 * iz, node.width * 0.012)
    const r = 10 / gz
    const edge: React.CSSProperties = {
      position: 'absolute', boxSizing: 'border-box', width: peek + sw * 2,
      background: 'transparent', pointerEvents: 'none', zIndex: isHovered ? 50 : 5,
    }
    return (
      <>
        <div data-tile-deck-edge style={{
          ...edge, left: node.x + faceW - sw / 2, top: node.y + vIn, height: node.height - vIn * 2,
          borderRadius: `0 ${r}px ${r}px 0`, borderLeft: 'none',
          borderTop: `${sw}px solid ${edgeColorFromHex(node.color, 0.6)}`,
          borderRight: `${sw}px solid ${edgeColorFromHex(node.color, 0.6)}`,
          borderBottom: `${sw}px solid ${edgeColorFromHex(node.color, 0.6)}`,
        }} />
        {deckCount >= 3 && (
          <div data-tile-deck-edge style={{
            ...edge, left: node.x + faceW + peek, top: node.y + node.height * 0.05, height: node.height * 0.9,
            borderRadius: `0 ${r / 2}px ${r / 2}px 0`,
            borderRight: `${sw}px solid ${edgeColorFromHex(node.color, 0.42)}`,
          }} />
        )}
      </>
    )
  })() : null

  // The count — the card-deck header's dashed card glyph, holding how many
  // tiles the deck has. In the title bar where there is one, else in the
  // face's top-right corner. Double-clicking it opens the deck, like any
  // double-click on the face.
  const badgeW = Math.min(12 * iz, node.width * 0.1, headerH * 0.62)
  const deckBadge = isDeckFace ? (
    <div
      data-tile-deck-count={deckCount}
      title={`A deck of ${deckCount} tiles — double-click to open it`}
      style={{
        minWidth: badgeW, height: badgeW * 1.3, padding: `0 ${badgeW * 0.15}px`,
        boxSizing: 'border-box', flexShrink: 0,
        border: `${Math.min(1.2 * iz, badgeW * 0.12)}px dashed rgba(255,255,255,0.7)`,
        background: 'rgba(255,255,255,0.14)', borderRadius: badgeW * 0.2,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: badgeW * 1.3 * 0.62, fontWeight: 700, color: 'rgba(255,255,255,0.78)',
        lineHeight: 1, fontFamily: 'system-ui, -apple-system, sans-serif',
        fontVariantNumeric: 'tabular-nums', textShadow: '0 1px 2px rgba(0,0,0,0.4)',
        userSelect: 'none',
        ...(showHeader ? {} : { position: 'absolute' as const, top: pad, right: pad, zIndex: 21 }),
      }}
    >{deckCount}</div>
  ) : null

  const renameInput = (size: number) => (
    <RenameInput
      ref={renameRef}
      value={renameVal}
      onChange={e => setRenameVal(e.target.value)}
      onBlur={commitRename}
      onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setIsRenaming(false) }}
      onPointerDown={e => e.stopPropagation()}
      style={{
        flex: 1, background: 'rgba(255,255,255,0.06)', border: 'none',
        borderBottom: `${Math.max(1, borderW)}px solid rgba(255,255,255,0.3)`,
        borderRadius: 0, outline: 'none', color: '#fff',
        fontSize: size, fontWeight: 600, lineHeight: 1.2, padding: 0, fontFamily: 'inherit',
        boxSizing: 'border-box', minWidth: 0,
      }}
    />
  )

  // Deck gestures for the menu. The cluster walk reads every tile, so it
  // only runs while the menu is open. Never on a rail or a docked card:
  // neither stacks into a tile deck.
  const menuCluster = nodeMenu && !isDeckFace && !isRailTile && !docked
    ? touchingTileCluster(id, useFreeNodeStore.getState().nodes) : []
  // How many results the rail's tray holds — for its menu's Clear item.
  const trayCount = nodeMenu && isRailTile
    ? Object.values(useFreeNodeStore.getState().nodes)
        .filter(n => n.railDock?.railId === id && n.railDock.slotId === RAIL_TRAY).length
    : 0

  // Canvas stacking. A rail is the table the cards lie on: below them and
  // below free tiles (5), but over resting bars (2) and Viewer windows (1),
  // which would otherwise cover its controls while its cards float above.
  // Its chrome that must show over the docked cards (the drop mark, the run
  // highlight, the next-result ghost) is portalled out to the world layer by
  // rail/RailOverlay, where it takes its own z among the tiles. Docked cards
  // stack by cascade order, each over the one above it, in a band that
  // stops at 49 however long the column or the tray grows — under hovered
  // free tiles (50), the run highlight (59) and everything above it. The
  // card the pointer rests on comes up over its column (the peek: 60). A
  // card in flight — lifted off a column, or aimed at one — floats over the
  // cards it passes but stays UNDER the rail's drop mark (z 70): the mark is
  // always under the pointer, so beneath the card it would never show.
  // An Area card is the ground things are set down on: under every tile,
  // fresh or hovered (components/Notes/AreaBody).
  const canvasZ: number = node.type === 'area' ? 1
    : isRailTile ? (isHovered ? 4 : 3)
    : lifted || aimingAtRail ? 65
    : docked ? (peeking ? 60 : 10 + Math.min(dockOrder, 39))
    // The newest thing on the canvas is over its neighbours until moved.
    : isFresh ? FRESH_Z
    : isHovered ? 50
    // An open cabinet's tray lies over the tiles beside it.
    : isCabinet && node.cabinet?.open ? 6 : 5

  const tile = (
    <div
      ref={wrapperRef}
      data-freenode="true"
      data-id={id}
      data-pinned={node.pin ? 'true' : undefined}
      data-rail={isRailTile ? 'true' : undefined}
      data-sel-ring={isRailTile && isSelected ? 'true' : undefined}
      data-rail-docked={docked ? node.railDock!.slotId : undefined}
      data-rail-lifted={lifted ? 'true' : undefined}
      style={{
        position: 'absolute',
        ...(isRailTile ? { '--ring-w': `${2.5 / gz}px`, '--ring-r': `${14 * railU}px` } as React.CSSProperties : {}),
        // left/top come from whichever space this node lives in; width and
        // height ALWAYS come from node.width/height, which never change
        // basis. The pin's scale is applied as this wrapper's own
        // transform, so the entire subtree below is identical either way.
        ...(node.pin ? {
          left: node.pin.x,
          top: node.pin.y,
          transform: `scale(${node.pin.scale})`,
          transformOrigin: '0 0',
          pointerEvents: 'auto' as const,   // the PinLayer host is 'none'
          zIndex: isHovered ? 902 : isSelected ? 901 : 900,
        } : {
          left: node.x,
          top: node.y,
          zIndex: canvasZ,
        }),
        width: faceW,   // node.width, less the edge reserve on a deck face
        height: node.height,
        // A Rolodex keeps the panel's own silhouette — rounded corners, a
        // soft drop shadow, no tile border — and keeps it in BOTH
        // placements, so pinning it to the screen or setting it down on
        // the canvas never changes how it looks. A rail rounds like its
        // own frame (RailBody), so the selection ring hugs it.
        borderRadius: isRailTile ? 14 * railU : tileR,
        // An effect card paints its own face edge to edge; the tile's random
        // colour would only show through the translucent border as a ring.
        // A rail paints its own frame entirely.
        background: isRailTile ? 'transparent' : node.type === 'effect' ? '#15161f' : node.color,
        // Connected-to-viewport model tiles carry the accent tint — the
        // same "these things are linked" language as touching deck cards.
        border: !edgeW ? 'none' : `${edgeW}px solid ${connectedWindowId
          ? `rgba(120,170,255,${isHovered ? 0.65 : 0.45})`
          : `rgba(255,255,255,${isHovered ? 0.18 : 0.08})`}`,
        // A rail's ring when selected is laid under it as plain colour
        // (index.css, data-sel-ring): as a box-shadow round a whole strip,
        // the tilted view painted every pixel of the strip again.
        boxShadow: isRailTile
          ? 'none'
          : isPanel
          ? `${isSelected ? `0 0 0 ${2.5 / gz}px rgba(120,180,255,0.9), ` : ''}` +
            `0 ${10 / gz}px ${28 / gz}px rgba(0,0,0,0.6), 0 ${2 / gz}px ${6 / gz}px rgba(0,0,0,0.5)`
          : isSelected
          ? `0 0 0 ${2.5 / gz}px rgba(120,180,255,0.9), 0 ${8 / gz}px ${32 / gz}px rgba(0,0,0,0.55)`
          : isHovered ? `0 ${8 / gz}px ${32 / gz}px rgba(0,0,0,0.55)` : `0 ${2 / gz}px ${12 / gz}px rgba(0,0,0,0.4)`,
        display: 'flex',
        flexDirection: 'column',
        // Not on a rail: its chrome may reach a hair past the box (a marker
        // across a column edge), and there is no tile content to clip.
        overflow: isRailTile || isCabinet ? 'visible' : 'hidden',
        transition: 'border-color 0.12s, box-shadow 0.12s',
        cursor: 'grab',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => { setIsHovered(false); setRested(false) }}
      onPointerDownCapture={e => {
        // Select node in capture phase so children with stopPropagation (note textarea) don't block selection
        if (e.button !== 0) return
        if ((e.target as Element).closest('[data-resize]')) return
        // The drag-out grip must not select or deselect: the selection is
        // what the drag it starts carries.
        if ((e.target as Element).closest('[data-drag-out]')) return
        // A component's body is a full panel that owns its own clicks:
        // selecting the node on every control would flash the ring and arm
        // Delete on the whole thing. Only its header and corner select it.
        if (isPanelType(node.type) &&
            !(e.target as Element).closest('[data-freenode-header],[data-resize]')) return
        wasSelectedOnDown.current = isSelected
        if (e.shiftKey) { toggleFreeSelection(id) }
        else if (!isSelected) { setFreeSelection([id]) }
      }}
      onPointerDown={onNodeDown}
      onPointerMove={onNodeMove}
      onPointerUp={onNodeUp}
      onLostPointerCapture={onNodeLostCapture}
      onDoubleClick={e => {
        // Portalled children — the context menu, the Edit Image overlay —
        // still bubble here through the React tree, but they are not the
        // tile. Their presses never reach onNodeDown either, so the guard
        // below would hold whatever the last drag left in it.
        if (!wrapperRef.current?.contains(e.target as Node)) return
        if (dragHasMoved.current) return
        // A rail's double-clicks belong to its own controls (RailBody stops
        // them); on its bare frame there is nothing to do.
        // A cabinet counts its own clicks on a drawer's name (onNodeUp).
        if (isRailTile || isCabinet) return
        // While the crop editor is open the tile is its canvas: stacking or
        // opening the deck under it would unmount or remount the editor and
        // lose the crop in progress.
        if (isEditingImage) return
        // What was ACTUALLY double-clicked. A press anywhere but a control
        // captures the pointer on this wrapper (onNodeDown), and a click
        // after a capture is dispatched to the capturing element — so
        // e.target can be the wrapper itself whatever lies under the
        // pointer. The document still knows.
        const under = document.elementFromPoint(e.clientX, e.clientY)
        const t = (under && wrapperRef.current?.contains(under) ? under : e.target) as Element
        // The header label renames (it also has its own handler, for when
        // the event does reach it).
        if (t.closest('[data-freenode-label]')) {
          if (!isRenaming) { setRenameVal(node.label); setIsRenaming(true) }
          return
        }
        // Controls keep their own double-click: word selection in a note,
        // a slider row's reset, the drag-out grip, the resize handles. So
        // does an ARMED draw surface — two quick pen dots or eraser taps
        // are not a double-click on the tile. (Unarmed it is
        // pointer-events: none, so it is never what lies under the pointer.)
        if (t.closest('textarea, input, select, button, [contenteditable], [data-drag-out], [data-resize], [data-pen-button], [data-draw-surface]')) return
        const inHeader = !!t.closest('[data-freenode-header]')
        // A text tile's body keeps double-click-to-edit; it stacks from its
        // title bar or the context menu instead.
        if (node.type === 'text' && !inHeader) {
          if (!isRenaming) {
            setTextEditing(true)
            setFreeSelection([id])
          }
          return
        }
        // Panels are apps, not things you stack (canJoinTileDeck). Nor is a
        // card on a loop strip: its column is its stack.
        if (isPanel || docked) return
        // Everything else: open this deck, or stack the tiles touching
        // this one into a deck.
        if (toggleTileDeck()) e.stopPropagation()
      }}
      onContextMenu={e => {
        e.preventDefault(); e.stopPropagation()
        // Which drawer of a cabinet was clicked: its menu offers it a project.
        menuDrawer.current = (e.target as Element).closest<HTMLElement>('[data-cabinet-drawer]')?.dataset.cabinetDrawer?.split(':')[1] ?? node.cabinet?.open ?? null
        setNodeMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {/* ── Header ── */}
      {/* The header is the node's title bar, so it DRAGS the node. It used
          to only stopPropagation, which made it a dead zone: it neither
          moved the node nor panned the canvas, and on a Rolodex tile —
          where the body is a full panel that handles its own clicks —
          that left almost nowhere to grab. onNodeDown stops propagation
          itself and skips inputs/buttons, so rename and the header
          controls still work. A double-click on the LABEL renames; anywhere
          else on the bar it reaches the tile and opens or stacks its deck.
          Effect cards have none — the whole tile is the card's face. */}
      {showHeader && <div
        data-freenode-header
        onPointerDown={onNodeDown}
        style={{
        display: 'flex', alignItems: 'center', gap: pad,
        padding: `${pad * 0.6}px ${pad}px`,
        background: 'rgba(0,0,0,0.3)',
        borderBottom: `${borderW}px solid rgba(255,255,255,0.06)`,
        // border-box so `height` is the whole story: with content-box the
        // padding above stacks on top of it and the cap stops holding.
        boxSizing: 'border-box',
        flexShrink: 0, height: headerH, overflow: 'hidden',
        // Its own top corners: in 3D the tile stops clipping (a raised
        // header cannot stand out of a clipping box), and a square bar
        // showed past the tile's round corners.
        borderTopLeftRadius: innerR, borderTopRightRadius: innerR,
      }}>
        {node.type === 'text' ? (
          <span style={{ fontSize: fontSize * 0.9, fontWeight: 800, color: 'rgba(255,255,255,0.4)', lineHeight: 1, flexShrink: 0 }}>T</span>
        ) : node.type === 'video' ? (
          <span style={{ fontSize: fontSize * 0.75, color: 'rgba(255,255,255,0.35)', lineHeight: 1, flexShrink: 0 }}>▶</span>
        ) : node.type === 'audio' ? (
          <span style={{ fontSize: fontSize * 0.75, color: 'rgba(255,255,255,0.35)', lineHeight: 1, flexShrink: 0 }}>♪</span>
        ) : node.type === 'model' ? (
          <span style={{ fontSize: fontSize * 0.75, color: connectedWindowId ? 'rgba(140,190,255,0.9)' : 'rgba(255,255,255,0.35)', lineHeight: 1, flexShrink: 0 }}>◆</span>
        ) : node.type === 'list' ? (
          <span style={{ fontSize: fontSize * 0.75, color: connectedWindowId ? 'rgba(140,190,255,0.9)' : 'rgba(255,255,255,0.35)', lineHeight: 1, flexShrink: 0 }}>≔</span>
        ) : (
          <div style={{ width: dotSize, height: dotSize, borderRadius: '50%', background: 'rgba(255,255,255,0.22)', flexShrink: 0 }} />
        )}

        {/* Annotation toggle — placed LEFT of the label so it doesn't crowd
                the right-edge resize-corner zone or any future trailing
                affordances on the header. Hover-only reveal keeps the header
                clean by default; the button fades in once the node is
                pointer-engaged (matches X / grip patterns elsewhere). */}
        <span data-pen-button="true" style={{ display: 'inline-flex', flexShrink: 0 }}>
          <PenButton
            surface={{ kind: 'freeNode', nodeId: id }}
            baseColor={node.color}
            size={headerBtn}
            visible={isHovered}
          />
        </span>

        {/* Drag-out — hands the file behind this tile to another app or a
                website's upload box. The header is the move handle, so leaving
                the app needs its own grip; media tiles only, panels hold no
                file. Lifted over the n-resize strip, which otherwise covers
                its top few pixels. Not wrapped: it renders nothing in a plain
                browser, and an empty wrapper would still take a flex gap.
                A picture showing an effect result hands out THAT, alone —
                the processed file, written ahead on hover; until it exists
                there is no grip, rather than one that drags the original. */}
        {MEDIA_TILES.has(node.type) && (
          <DragOutGrip
            url={fxDrag.active ? fxDrag.url : node.imageUrl}
            getUrls={fxDrag.active ? () => [] : dragOutUrls}
            allLabel={!fxDrag.active && isDeckFace ? 'every file in this deck' : undefined}
            // Let go back on the canvas, the copy keeps this tile's size and
            // crop. Read fresh: a docked tile's size is the rail's to change.
            shape={() => {
              const n = useFreeNodeStore.getState().nodes[id]
              return n ? { width: n.width, height: n.height, imageTransform: n.imageTransform } : null
            }}
            size={headerBtn}
            visible={isHovered}
            style={{ position: 'relative', zIndex: 20 }}
          />
        )}

        {isRenaming ? renameInput(fontSize) : (
          <span
            data-freenode-label
            style={{
              flex: 1, color: 'rgba(255,255,255,0.65)', fontSize, fontWeight: 600,
              userSelect: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
            onDoubleClick={e => { e.stopPropagation(); setRenameVal(node.label); setIsRenaming(true) }}
          >{node.label}</span>
        )}

        {deckBadge}

        {/* ── Placement controls ── the apps all wear the same pair, so
                pinning a Media Pool is the same gesture as pinning the
                Rolodex or the Viewer. Media tiles keep using the context
                menu: a 20px tile has no room for header buttons. */}
        {node.type === 'filmMixer' && <FilmLayersSpacing fontSize={fontSize} />}
        {node.type === 'filmMixer' && <FilmLayersToggle fontSize={fontSize} />}
        {isPanel && (
          <PinControl
            pinned={!!node.pin}
            size={Math.max(11, Math.min(16 * iz, headerH * 0.8))}
            hit={headerH * 1.5}
            onToggle={() => {
              const cs = useCanvasStore.getState()
              useUndoCoordinator.getState().checkpoint()
              // Pinning is PER COMPONENT. Taking the neighbours along
              // sounded tidy and is wrong in the hand: you pin one thing
              // and three others leave the canvas with it.
              useFreeNodeStore.getState().setNodePlacement(
                [id], node.pin ? 'canvas' : 'screen', { pan: cs.pan, zoom: cs.zoom })
            }}
            onResetHome={node.pin ? () => {
              const cs = useCanvasStore.getState()
              useUndoCoordinator.getState().checkpoint()
              useFreeNodeStore.getState().rehomePinnedNode(id, { pan: cs.pan, zoom: cs.zoom })
            } : undefined}
          />
        )}
      </div>}

      {/* ── Body ── a rail's is the rail itself: arrow, slots, tray (RailBody,
              local coordinates, filling the tile — mounted directly in it, so
              its parent is this tile and the tile's is the world layer). Its
              controls stop their own presses; its bare frame passes them on,
              so pressing it moves the rail like any tile. */}
      {isRailTile ? (
        <RailBody id={id} node={node} hovered={isHovered} zoom={gz} />
      ) : isCabinet ? (
        <CabinetBody id={id} node={node} />
      ) : (
        <FreeNodeBody node={node} id={id} iz={iz} dz={dz} pad={pad} faceW={faceW} hovered={isHovered} updateFreeNode={updateFreeNode} isEditing={textEditing} setIsEditing={setTextEditing}
          bodyW={faceW - 2 * edgeSnap} bodyH={node.height - 2 * edgeSnap - bodyTop} bodyR={innerR} />
      )}

      {/* A rail has no title bar to type a name into: the rename field sits
          over the rail's label at the left of its arrow band. Sized in the
          rail's unit like the rest of its chrome, with a floor so it can
          still be read zoomed out, and a ceiling so it stays in the band. */}
      {isRailTile && isRenaming && (
        <div style={{
          position: 'absolute', zIndex: 30,
          left: RAIL_GEOM.pad * railU, top: RAIL_GEOM.pad * 0.6 * railU,
          width: Math.min(240 * railU, node.width * 0.45), height: RAIL_GEOM.arrowH * railU,
          padding: `0 ${8 * railU}px`, boxSizing: 'border-box',
          display: 'flex', alignItems: 'center',
          background: '#1b1c27', borderRadius: 8 * railU,
        }}>
          {renameInput(Math.min(Math.max(13 * railU, 10 * iz), RAIL_GEOM.arrowH * railU * 0.6))}
        </div>
      )}

      {/* ── Pick one ── in a 'pick' column only the face-up card (the last)
              is used; the cards above it are dimmed. Lighter under the
              pointer, so a peek still shows the picture. Over the header
              too — the whole card is out of play. */}
      {pickDimmed && (
        <div data-rail-dimmed style={{
          position: 'absolute', inset: 0, zIndex: 18, pointerEvents: 'none',
          background: `rgba(0,0,0,${isHovered ? 0.2 : 0.45})`,
          transition: 'background 0.12s',
        }} />
      )}

      {!showHeader && deckBadge}

      {/* ── Annotation layer — overlays the body region only (header excluded).
              Always renders saved strokes; captures pointer events only while
              draw mode targets THIS node. Not on a rail: it has no pen. */}
      {!isRailTile && <div style={{
        position: 'absolute',
        top: bodyTop,
        // On a deck face the picture under this is centre-CROPPED (cover)
        // to the narrowed face, not squashed. Strokes are stored as
        // fractions of the surface's width, so they keep the full tile
        // width and overhang the edge reserve equally on both sides — the
        // wrapper's overflow clips the overhang — and stay on what they
        // marked. 0 on any other tile.
        left: -deckReserve / 2,
        right: -deckReserve / 2,
        bottom: 0,
        pointerEvents: 'none',  // children opt-in via DrawableSurface's own gate
      }}>
        <DrawableSurface
          surface={{ kind: 'freeNode', nodeId: id }}
          width={node.width}
          height={Math.max(0, node.height - bodyTop)}
          strokes={node.strokes ?? []}
        />
      </div>}

      {/* ── Text format toolbar (shown when text node is selected) ── */}
      {node.type === 'text' && isSelected && (
        <TextFormatToolbar node={node} id={id} updateFreeNode={updateFreeNode} wrapperRef={wrapperRef} />
      )}

      {/* ── Reshape handles ── the other seven. A single grow-only corner
              made panels awkward to lay out next to each other: you could
              never pull an edge back, so every adjustment meant moving the
              node as well. Sides are thin strips, corners are squares, and
              they sit UNDER the visible SE grip in z-order so the familiar
              one still wins where they overlap. Rolodex tiles keep their
              locked aspect on all of them — the drawer still sets the shape,
              these only grow it. A deck face has none, like a stacked card
              deck: resizing the face would leave its hidden tiles behind.
              Nor does a rail (it sizes itself to its slots) or a card docked
              on one (the rail decides its size). */}
      {!isDeckFace && !isRailTile && !docked && ([
        ['n',  { top: 0, left: sideInset, right: sideInset, height: edgeZone }, 'ns-resize'],
        // The Rolodex's cabinet base IS its drawer pull, and it runs the full
        // width. A resize strip lying on top of it made the drawer a
        // coin-toss to grab, so on those the bottom handles keep to the right
        // third and the drawer owns the rest.
        ['s',  { bottom: 0, left: drawerSafe ? node.width * 0.667 : sideInset, right: sideInset, height: edgeZone }, 'ns-resize'],
        ['w',  { left: 0, top: sideInset, bottom: sideInset, width: edgeZone }, 'ew-resize'],
        ['e',  { right: 0, top: sideInset, bottom: sideInset, width: edgeZone }, 'ew-resize'],
        ['nw', { top: 0, left: 0, width: cornerZone, height: cornerZone }, 'nwse-resize'],
        ['ne', { top: 0, right: 0, width: cornerZone, height: cornerZone }, 'nesw-resize'],
        // sw sits at the far LEFT of the drawer — the worst possible place
        // for it — so it is simply absent when a drawer is present.
        ...(drawerSafe ? [] : [['sw', { bottom: 0, left: 0, width: cornerZone, height: cornerZone }, 'nesw-resize'] as const]),
      ] as const).map(([dir, pos, cursor]) => (
        <div
          key={dir}
          data-resize={dir}
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          style={{ position: 'absolute', ...pos, cursor, zIndex: 19 }}
        />
      ))}

      {/* ── Resize handle — large corner zone, present on all but a deck
              face, a rail and a docked card ── */}
      {!isDeckFace && !isRailTile && !docked && <div
        data-resize="se"
        style={{
          position: 'absolute', bottom: 0, right: 0,
          width: grabZone, height: grabZone,
          cursor: 'nwse-resize',
          zIndex: 20,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
          padding: `0 ${grabZone * 0.125}px ${grabZone * 0.125}px 0`,
        }}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
      >
        {/* Visual grip dots */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(3, ${gripDot}px)`,
          gridTemplateRows: `repeat(3, ${gripDot}px)`,
          gap: `${gripGap}px`,
          opacity: isHovered ? 0.5 : 0.15,
          transition: 'opacity 0.12s',
        }}>
          {[...Array(9)].map((_, i) => (
            <div key={i} style={{
              width: gripDot, height: gripDot, borderRadius: '50%',
              background: 'rgba(255,255,255,0.9)',
              opacity: (i === 4 || i < 3) ? 0 : 1,
            }} />
          ))}
        </div>
      </div>}

      {/* ── Context menu ── */}
      {nodeMenu && ReactDOM.createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={() => setNodeMenu(null)} />
          <div
            ref={nodeMenuRef}
            onPointerDown={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: Math.min(nodeMenu.x, window.innerWidth - 180),
              top: nodeMenuTop,
              width: 170, zIndex: 9999,
              background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
              padding: '5px 0', fontFamily: 'system-ui, sans-serif',
            }}
          >
            <div style={{ padding: '4px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: 4 }}>
              <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{node.label}</span>
            </div>
            {[
              // Not for an effect card: its face shows the EFFECT's name, so a
              // rename would never be seen (and choosing an effect resets it).
              // Nor does it have a title bar to type one into.
              ...(node.type !== 'effect' ? [
                { label: 'Rename', icon: '✏️', action: () => { setRenameVal(node.label); setIsRenaming(true); setNodeMenu(null) } },
              ] : []),
              ...(node.imageUrl && node.mediaType !== 'model' ? [
                { label: 'Edit Image', icon: '✂️', action: () => { setNodeMenu(null); setIsEditingImage(true) } },
                { label: 'Remove Image', icon: '🖼', action: () => { useUndoCoordinator.getState().checkpoint(); updateFreeNode(id, { imageUrl: null, imageTransform: undefined }); setNodeMenu(null) } },
              ] : []),
              // A 3D area folds into a card (utils/area3dCard), as a chart
              // does: its own card when it came out of one.
              ...(node.type === 'area' ? [
                { label: node.areaCard ? 'Fold into its card' : 'Fold into a 3D area card', icon: '▦', action: () => { setNodeMenu(null); foldArea3dMoving(id) } },
              ] : []),
              ...(node.imageUrl && node.mediaType === 'model' ? [
                { label: 'Remove Model', icon: '◆', action: () => { useUndoCoordinator.getState().checkpoint(); updateFreeNode(id, { imageUrl: null, posterUrl: undefined }); setNodeMenu(null) } },
              ] : []),
              // Tile decks — the menu twin of double-click, and the only
              // way for a text tile, whose body double-click edits. Icons
              // as on the card menu's Stack / Open Deck.
              ...(isDeckFace ? [
                { label: 'Open deck', icon: '📂', action: () => { toggleTileDeck(); setNodeMenu(null) } },
              ] : menuCluster.length >= 2 ? [
                { label: 'Stack touching tiles', icon: '📚', action: () => { toggleTileDeck(); setNodeMenu(null) } },
              ] : []),
              // An effect: copy it; a strip or an effect: paste a copied one
              // into its row, after it (utils/fx/effectClipboard; Ctrl+C/V).
              ...(node.type === 'effect' ? [
                { label: 'Copy effect', icon: '⧉', action: () => { copyEffect({ nodeId: id }); setNodeMenu(null) } },
              ] : []),
              ...((node.type === 'effect' || isRailTile) && hasEffectClip() ? [
                { label: isRailTile ? 'Paste effect into the row' : 'Paste effect after this', icon: '⎘', action: () => { pasteEffect({ nodeId: id }); setNodeMenu(null) } },
              ] : []),
              // Loop strip: empty its results tray onto the canvas, below the
              // strip (clearRailTray), in one undo step.
              ...(isRailTile ? [
                { label: trayCount > 0 ? `Results to canvas (${trayCount})` : 'Results to canvas', icon: '↓',
                  action: () => {
                    if (trayCount > 0) {
                      useUndoCoordinator.getState().checkpoint()
                      useFreeNodeStore.getState().clearRailTray(id)
                    }
                    setNodeMenu(null)
                  } },
              ] : []),
              // A docked card's twin of pulling it out of its column. It is
              // set down just under the rail, at its column — left where the
              // rail had it, it would look as if it were still docked.
              ...(docked ? [
                { label: 'Take off the strip', icon: '↑',
                  action: () => {
                    const fns = useFreeNodeStore.getState()
                    const cur = fns.nodes[id]
                    const rail = cur?.railDock ? fns.nodes[cur.railDock.railId] : undefined
                    useUndoCoordinator.getState().checkpoint()
                    fns.undockFromRail(id)
                    if (cur && rail) {
                      fns.updateFreeNode(id, { x: cur.x, y: rail.y + rail.height + RAIL_GEOM.gap * (rail.rail?.unit ?? 1) })
                    }
                    setNodeMenu(null)
                  } },
              ] : []),
              // Project cabinet: its drawers, and everything back on the canvas.
              ...(isCabinet ? [
                { label: 'Add drawer', icon: '＋', action: () => { useUndoCoordinator.getState().checkpoint(); addDrawer(id); setNodeMenu(null) } },
                { label: 'Remove an empty drawer', icon: '－', action: () => { useUndoCoordinator.getState().checkpoint(); removeEmptyDrawer(id); setNodeMenu(null) } },
                // For an empty drawer: a whole project instead of loose things.
                ...(() => {
                  const d = node.cabinet?.drawers.find(x => x.id === menuDrawer.current)
                  if (!d || d.project || d.items.length > 0) return []
                  const name = drawerName(d, node.cabinet!.drawers.indexOf(d)).text
                  const show = () => { const c = useFreeNodeStore.getState().nodes[id]?.cabinet; if (c && c.open !== d.id) toggleDrawer(id, d.id) }
                  return [
                    { label: `Save canvas to ${name}`, icon: '💾', action: () => { show(); saveCanvasToDrawer({ nodeId: id, drawerId: d.id }); setNodeMenu(null) } },
                    { label: `Choose a saved project for ${name}`, icon: '📁', action: () => { show(); useCabinetUi.getState().setChoosing(d.id); setNodeMenu(null) } },
                  ]
                })(),
                { label: `Empty all (${itemCount(node.cabinet)})`, icon: '↓', action: () => { useUndoCoordinator.getState().checkpoint(); emptyCabinet(id); setNodeMenu(null) } },
              ] : []),
              // Put this tile away, and the selection it is part of.
              ...(nodeMenu && canStowTile(node) ? cabinetTargets().map(t => ({
                label: `Put in ${t.label}`, icon: '🗄️',
                action: () => {
                  const fs = useFreeNodeStore.getState()
                  useUndoCoordinator.getState().checkpoint()
                  stowSelection([], fs.selectedIds.includes(id) ? fs.selectedIds : [id], t)
                  setNodeMenu(null)
                },
              })) : []),
              // The ONLY placement gesture. Dragging a pinned panel "off
              // the canvas" deliberately does NOT unpin — a mode should
              // never change by accident during a move. Not for a deck
              // face, as card decks do not pin: the tiles hidden behind
              // it would stay on the canvas. Not for a loop strip or a card
              // on one either (v1): a pinned rail would leave its cards on
              // the canvas, and a pinned card would leave its column.
              ...(isDeckFace || isRailTile || isCabinet || docked ? [] : [{ label: node.pin ? 'Drop on canvas' : 'Pin to screen',
                icon: node.pin ? '📤' : '📌',
                action: () => {
                  const cs = useCanvasStore.getState()
                  useUndoCoordinator.getState().checkpoint()
                  useFreeNodeStore.getState().setNodePlacement(
                    [id], node.pin ? 'canvas' : 'screen', { pan: cs.pan, zoom: cs.zoom })
                  setNodeMenu(null)
                } }]),
              ...(node.pin ? [
                { label: 'Set return spot here', icon: '⌖',
                  action: () => {
                    const cs = useCanvasStore.getState()
                    useUndoCoordinator.getState().checkpoint()
                    useFreeNodeStore.getState().rehomePinnedNode(id, { pan: cs.pan, zoom: cs.zoom })
                    setNodeMenu(null)
                  } },
              ] : []),
              // On a face this deletes the whole deck (deleteFreeNode), so it
              // says so; a rail likewise takes every card docked on it.
              // A cabinet sets down what it holds, below where it was.
              { label: isRailTile ? 'Delete strip' : isDeckFace ? 'Delete deck' : isCabinet && itemCount(node.cabinet) > 0 ? 'Delete (contents stay on the canvas)' : 'Delete', icon: '🗑️', danger: true, action: () => { useUndoCoordinator.getState().checkpoint(); emptyCabinet(id); deleteFreeNode(id); setNodeMenu(null) } },
              ...fileItems,
            ].map(item => (
              <React.Fragment key={item.label}>
                {/* Same rule as the header's: a divider above the file group. */}
                {('separator' in item && item.separator) && (
                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', margin: '4px 0' }} />
                )}
                <button
                  onClick={item.action}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9,
                    width: '100%', padding: '7px 14px',
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: ('danger' in item && item.danger) ? '#f87171' : '#e2e8f0',
                    fontSize: 13, textAlign: 'left', borderRadius: 4,
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
        </>,
        document.body
      )}
      {isEditingImage && node.imageUrl && (() => {
        const r = wrapperRef.current?.getBoundingClientRect()
        if (!r) return null
        return (
          <HeroImageEditOverlay
            cardRect={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            heroImage={node.imageUrl}
            initialTransform={node.imageTransform ?? { scale: 1, offsetX: 0, offsetY: 0, flipH: false, flipV: false }}
            onDone={t => {
              useUndoCoordinator.getState().checkpoint()
              updateFreeNode(id, { imageTransform: t })
              setIsEditingImage(false)
            }}
            onCancel={() => setIsEditingImage(false)}
          />
        )
      })()}
    </div>
  )

  // A deck face is the tile plus its edges, which sit beside it in the
  // world rather than inside its clipped box. ONE shape whether or not
  // this is a face — [edges | null, tile] — so the tile stays the second
  // child and React updates it in place on collapse and expand. Returning
  // the bare tile otherwise switched the root between a <div> and a
  // fragment, which remounted the whole subtree: the crop editor, the fx
  // result, a focused control and every <img>/<canvas> started over.
  return <>{deckEdges}{tile}</>
})

// ── Body renderer for each node type ──

const FreeNodeBody: React.FC<{
  node: FreeNodeData
  id: string
  iz: number
  dz: number
  pad: number
  /** The width the tile is drawn at (narrower on a deck face). */
  faceW: number
  /** The tile is hovered — reveals the fx result's chrome on a picture. */
  hovered: boolean
  /** The body's size in canvas units, flat, and its bottom corners'
   *  radius (for CanvasUnits). */
  bodyW: number
  bodyH: number
  bodyR: number
  updateFreeNode: (id: string, patch: Partial<FreeNodeData>) => void
  isEditing: boolean
  setIsEditing: (v: boolean) => void
}> = ({ node, id, iz, dz, pad, faceW, hovered, updateFreeNode, isEditing, setIsEditing, bodyW, bodyH, bodyR }) => {
  const textRef = useRef<HTMLTextAreaElement>(null)
  // node.imageUrl may be a `mediaref:` pointer — resolve to a usable URL
  // (null while loading / if missing). Called unconditionally before any
  // early return to keep hook order stable.
  const resolvedUrl = useResolvedMedia(node.imageUrl)

  useEffect(() => { if (isEditing) textRef.current?.focus() }, [isEditing])

  // ── Effect card: one operator on an effect strip ──
  if (node.type === 'effect') {
    return <EffectTileBody node={node} id={id} dz={dz} updateFreeNode={updateFreeNode} />
  }

  // ── Model type: poster thumbnail + 3D badge (never renders the .glb) ──
  if (node.type === 'model') {
    return <ModelTileBody node={node} id={id} dz={dz} updateFreeNode={updateFreeNode} />
  }

  // ── List type: a FULL embedded Rolodex — 100% the floating panel's
  //    functionality, state persisted on this node's listQuery. ──
  // ── Component bodies: a whole panel inside a node. Each is a plain
  //    component reading a shared store, so magneting two of them together
  //    is the only "wiring" the composition needs. ──
  //    In CanvasUnits: laid out the same in 2D and 3D.
  if (node.type === 'pool') {
    return (
      <CanvasUnits w={bodyW} h={bodyH} r={bodyR}><div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <MediaPool nodeId={id} />
      </div></CanvasUnits>
    )
  }
  if (node.type === 'prompt') {
    return (
      <CanvasUnits w={bodyW} h={bodyH} r={bodyR}><div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <PromptPad nodeId={id} />
      </div></CanvasUnits>
    )
  }
  if (node.type === 'attributes' || node.type === 'promptCards') {
    return (
      <CanvasUnits w={bodyW} h={bodyH} r={bodyR}><div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {node.type === 'attributes' ? <AttributesWindow nodeId={id} /> : <CardPromptPad nodeId={id} />}
      </div></CanvasUnits>
    )
  }
  if (node.type === 'annotations') {
    return (
      <CanvasUnits w={bodyW} h={bodyH} r={bodyR}><AnnotationCardBody node={node} bodyW={bodyW} bodyH={bodyH} /></CanvasUnits>
    )
  }
  if (node.type === 'area') {
    return (
      <CanvasUnits w={bodyW} h={bodyH} r={bodyR}><AreaBody node={node} bodyW={bodyW} bodyH={bodyH} /></CanvasUnits>
    )
  }
  if (node.type === 'roughCut') {
    return (
      <CanvasUnits w={bodyW} h={bodyH} r={bodyR}><RoughCutBody id={id} node={node} bodyW={bodyW} bodyH={bodyH} /></CanvasUnits>
    )
  }
  if (node.type === 'filmMixer') {
    return (
      <CanvasUnits w={bodyW} h={bodyH} r={bodyR}><FilmMixerBody nodeId={id} pinned={!!node.pin} bodyW={bodyW} bodyH={bodyH} /></CanvasUnits>
    )
  }
  if (node.type === 'history') {
    return (
      <CanvasUnits w={bodyW} h={bodyH} r={bodyR}><div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <HistoryPanel nodeId={id} />
      </div></CanvasUnits>
    )
  }
  if (node.type === 'list') {
    return (
      <CanvasUnits w={bodyW} h={bodyH} r={bodyR}><div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <CardRolodex embedded={{ nodeId: id }} />
      </div></CanvasUnits>
    )
  }

  // ── Note type: always-editable textarea ──
  if (node.type === 'note') {
    return (
      <CanvasUnits w={bodyW} h={bodyH} r={bodyR}><textarea
        value={node.text}
        onChange={e => updateFreeNode(id, { text: e.target.value })}
        onPointerDown={e => e.stopPropagation()}
        placeholder="Type a note…"
        style={{
          flex: 1, background: 'none', border: 'none', outline: 'none',
          color: 'rgba(255,255,255,0.8)',
          fontSize: 12 * iz, lineHeight: 1.55,
          padding: `${8 * iz}px ${pad}px ${28 * iz}px`,
          resize: 'none', fontFamily: 'inherit', cursor: 'text',
        }}
      /></CanvasUnits>
    )
  }

  // ── Text type: view/edit toggle with formatting ──
  if (node.type === 'text') {
    const ts = { ...DEFAULT_TEXT_STYLE, ...node.textStyle }
    ensureFontLoaded(ts.fontFamily)
    const bgRgba = hexToRgba(ts.bgColor, ts.bgOpacity)

    // Fixed canvas-space size: text scales 1:1 with the node box via the canvas
    // transform: scale(zoom). No inverse-zoom compensation — text never reflows.
    const renderFontSize = ts.fontSize
    const renderPad = 6

    const resolvedWeight = ts.fontWeight ?? (ts.bold ? 700 : 400)
    const resolvedLH = ts.lineHeight ?? 1.55
    const resolvedLS = ts.letterSpacing ?? 0
    const resolvedTT = ts.textTransform ?? 'none'

    const textCss: React.CSSProperties = {
      fontSize: renderFontSize,
      lineHeight: resolvedLH,
      fontWeight: resolvedWeight,
      fontStyle: ts.italic ? 'italic' : 'normal',
      textAlign: ts.align,
      fontFamily: ts.fontFamily || 'inherit',
      letterSpacing: resolvedLS,
      textTransform: resolvedTT,
      wordBreak: 'break-word',
    }

    // In CanvasUnits, both: the words break in the same places in 3D.
    if (isEditing) {
      return (
        <CanvasUnits w={bodyW} h={bodyH} r={bodyR}><div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <textarea
            ref={textRef}
            value={node.text}
            onChange={e => updateFreeNode(id, { text: e.target.value })}
            onPointerDown={e => e.stopPropagation()}
            onBlur={() => setIsEditing(false)}
            onKeyDown={e => { if (e.key === 'Escape') setIsEditing(false) }}
            placeholder="Type text content…"
            style={{
              ...textCss,
              flex: 1, background: bgRgba, border: 'none', outline: 'none',
              color: ts.color,
              padding: renderPad,
              resize: 'none', cursor: 'text',
            }}
          />
        </div></CanvasUnits>
      )
    }
    return (
      <CanvasUnits w={bodyW} h={bodyH} r={bodyR}><div
        style={{
          ...textCss,
          flex: 1, padding: renderPad,
          background: bgRgba,
          color: node.text ? ts.color : 'rgba(255,255,255,0.25)',
          whiteSpace: 'pre-wrap', overflow: 'hidden',
          cursor: 'pointer',
          display: 'flex', flexDirection: 'column',
          justifyContent: ts.vAlign === 'middle' ? 'center' : ts.vAlign === 'bottom' ? 'flex-end' : 'flex-start',
        }}
      >
        <div>{node.text || 'Double-click to edit…'}</div>
      </div></CanvasUnits>
    )
  }

  // ── Video type: poster frame with play overlay ──
  if (node.type === 'video') {
    return <VideoTileBody node={node} id={id} iz={iz} dz={dz} faceW={faceW} hovered={hovered} resolvedUrl={resolvedUrl} updateFreeNode={updateFreeNode} />
  }

  // ── Audio type: waveform skeleton + transport ──
  if (node.type === 'audio') {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: `${6 * dz}px ${pad}px`, gap: 4 * dz }}>
        {/* Filename */}
        <div style={{ fontSize: 10 * dz, color: 'rgba(255,255,255,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.label || 'Audio'}
        </div>
        {/* Fake waveform */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 1 * dz, minHeight: 24 * dz }}>
          {Array.from({ length: 40 }, (_, i) => {
            const h = (Math.sin(i * 0.7) * 0.4 + 0.5 + Math.sin(i * 1.9) * 0.2) * 100
            return (
              <div key={i} style={{
                flex: 1, height: `${Math.max(8, h)}%`,
                background: node.imageUrl ? 'rgba(100,200,255,0.5)' : 'rgba(255,255,255,0.15)',
                borderRadius: 1 * dz,
              }} />
            )
          })}
        </div>
        {/* Transport controls */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 * dz, padding: `${2 * dz}px 0` }}>
          <div style={{ fontSize: 10 * dz, color: 'rgba(255,255,255,0.35)', cursor: 'pointer' }}>⏮</div>
          <div style={{
            width: 22 * dz, height: 22 * dz, borderRadius: '50%',
            background: 'rgba(255,255,255,0.1)', border: `${1.5 * dz}px solid rgba(255,255,255,0.25)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}>
            <div style={{
              width: 0, height: 0,
              borderTop: `${4 * dz}px solid transparent`,
              borderBottom: `${4 * dz}px solid transparent`,
              borderLeft: `${7 * dz}px solid rgba(255,255,255,0.7)`,
              marginLeft: 2 * dz,
            }} />
          </div>
          <div style={{ fontSize: 10 * dz, color: 'rgba(255,255,255,0.35)', cursor: 'pointer' }}>⏭</div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 9 * dz, color: 'rgba(255,255,255,0.3)' }}>0:00 / 0:00</div>
        </div>
      </div>
    )
  }

  // ── Image type (default) ──
  const imgT = node.imageTransform
  const imgFlips: string[] = []
  if (imgT?.flipH) imgFlips.push('scaleX(-1)')
  if (imgT?.flipV) imgFlips.push('scaleY(-1)')
  const hasImgTransform = imgT && (imgT.scale !== 1 || imgT.offsetX !== 0 || imgT.offsetY !== 0 || imgT.flipH || imgT.flipV)
  const imgStyle: React.CSSProperties = hasImgTransform ? {
    width: `${imgT.scale * 100}%`, height: `${imgT.scale * 100}%`,
    objectFit: 'cover',
    objectPosition: `${50 + imgT.offsetX}% ${50 + imgT.offsetY}%`,
    transform: imgFlips.length > 0 ? imgFlips.join(' ') : undefined,
    position: 'absolute',
    left: `${50 - imgT.scale * 50}%`,
    top: `${50 - imgT.scale * 50}%`,
  } : { width: '100%', height: '100%', objectFit: 'cover' as const, transform: imgFlips.length > 0 ? imgFlips.join(' ') : undefined }

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
      {resolvedUrl ? (
        <img src={resolvedUrl} draggable={false} style={imgStyle} />
      ) : (
        <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.18)', pointerEvents: 'none' }}>
          <div style={{ fontSize: 22 * iz, marginBottom: 5 * iz, opacity: 0.5 }}>⬛</div>
          <div style={{ fontSize: 10 * iz }}>drop image here</div>
        </div>
      )}
      {/* The effect strip's RESULT, laid over the picture with the same
          geometry — the effect cards beside it show only their settings.
          Nothing unless this tile leads a strip with an output. */}
      <FxResultLayer nodeId={id} imgStyle={imgStyle} iz={iz} nodeW={faceW} nodeH={node.height} hovered={hovered} />
    </div>
  )
}

// ── Video tile body: a real frame from the video under a play overlay.
//    thumbService grabs it (a seek and one drawImage, no full download)
//    and files it in the shared poster map, keyed by the STORED url so
//    every surface showing this video finds it. The video itself is NEVER
//    fed to an <img> — that rendered as a broken-image icon. ──
/** The poster's geometry — shared with the fx result laid over it. */
const VIDEO_POSTER_STYLE: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' }
const VideoTileBody: React.FC<{
  node: FreeNodeData
  id: string
  iz: number
  dz: number
  faceW: number
  hovered: boolean
  resolvedUrl: string | null
  updateFreeNode: (id: string, patch: Partial<FreeNodeData>) => void
}> = ({ node, id, iz, dz, faceW, hovered, resolvedUrl, updateFreeNode }) => {
  // Mounting useThumb is also what keeps the request alive (see thumbService).
  const mapPoster = useThumb(node.imageUrl ?? null, 'video')
  const shownPoster = mapPoster ?? node.posterUrl ?? null
  const resolvedPoster = useResolvedMedia(shownPoster)
  /** The poster that failed to decode, if any — hidden, and re-grabbed. */
  const [brokenPoster, setBrokenPoster] = useState<string | null>(null)
  // Read from the RESOLVED url — a `mediaref:` is not streamable, its object
  // url is — but file the frame under the stored one. A failed grab is
  // retried while the tile is up (the service spaces attempts a minute
  // apart and gives up after its cap), so one slow disk read does not leave
  // a play glyph for the rest of the session.
  useEffect(() => {
    if (!node.imageUrl || mapPoster || !resolvedUrl) return
    const url = node.imageUrl
    requestThumb(url, 'video', false, resolvedUrl)
    const t = setInterval(() => {
      if (hasThumbFailed(url)) clearInterval(t)
      else requestThumb(url, 'video', false, resolvedUrl)
    }, 61_000)
    return () => clearInterval(t)
  }, [node.imageUrl, mapPoster, resolvedUrl])
  // The node keeps its own copy, as a model tile does: it is what travels
  // when the tile is dropped onto a card or bar, and what the Card Browser
  // shows for a tile that is off screen. Only when it has NONE: the load-time
  // media sweep rewrites a data: copy to an /uploads/ file, and writing the
  // map's data: url back over that would re-upload it on every launch.
  useEffect(() => {
    if (mapPoster && !node.posterUrl) updateFreeNode(id, { posterUrl: mapPoster })
  }, [mapPoster, node.posterUrl, id, updateFreeNode])
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
      {node.imageUrl ? (
        <>
          {resolvedPoster && shownPoster !== brokenPoster && (
            <img
              src={resolvedPoster}
              draggable={false}
              // A stored copy can outlive its bytes (an /uploads/ file that is
              // gone, a project imported elsewhere). Hide it — the play glyph
              // stands alone — and grab a fresh frame.
              onError={() => {
                setBrokenPoster(shownPoster)
                // A dead node copy is dropped so the fresh frame can replace it.
                if (shownPoster === node.posterUrl) updateFreeNode(id, { posterUrl: undefined })
                if (node.imageUrl && resolvedUrl) requestThumb(node.imageUrl, 'video', true, resolvedUrl)
              }}
              style={VIDEO_POSTER_STYLE}
            />
          )}
          {/* Play button overlay — also the whole picture until a frame lands */}
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.25)',
          }}>
            <div style={{
              width: 40 * dz, height: 40 * dz, borderRadius: '50%',
              background: 'rgba(0,0,0,0.6)', border: `${2 * dz}px solid rgba(255,255,255,0.5)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                width: 0, height: 0,
                borderTop: `${8 * dz}px solid transparent`,
                borderBottom: `${8 * dz}px solid transparent`,
                borderLeft: `${14 * dz}px solid rgba(255,255,255,0.9)`,
                marginLeft: 3 * dz,
              }} />
            </div>
          </div>
          {/* A video leads an effect strip through its poster frame, so
              the processed frame shows here exactly as on a picture — over
              the play glyph, which comes back with "original". */}
          <FxResultLayer nodeId={id} imgStyle={VIDEO_POSTER_STYLE} iz={iz} nodeW={faceW} nodeH={node.height} hovered={hovered} />
        </>
      ) : (
        <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.25)', pointerEvents: 'none' }}>
          <div style={{ fontSize: 28 * dz, marginBottom: 4 * dz }}>▶</div>
          <div style={{ fontSize: 10 * dz }}>drop video here</div>
        </div>
      )}
    </div>
  )
}

// ── Model tile body: poster image (mediaref:, lazily generated by the
//    poster service once a renderer exists) + "3D" corner badge; wireframe
//    cube + filename until a poster is available. The raw model URL is
//    NEVER fed to an <img>. ──
const ModelTileBody: React.FC<{
  node: FreeNodeData
  id: string
  dz: number
  updateFreeNode: (id: string, patch: Partial<FreeNodeData>) => void
}> = ({ node, id, dz, updateFreeNode }) => {
  // MAP-first poster: the persisted url→poster map is the source of truth
  // (its version bump invalidates stale renders); node.posterUrl is the
  // durable/transfer copy and the fallback while the map refills.
  const mapPoster = useModelPoster(node.imageUrl ?? null)
  const resolvedPoster = useResolvedMedia(mapPoster ?? node.posterUrl ?? null)
  /** One self-heal attempt per mount — see the <img> onError below. */
  const posterHealed = useRef(false)
  // Lazy generation whenever the MAP lacks this model (first ever render,
  // or after a poster-version migration cleared it); syncs the fresh ref
  // onto the node. Null result (renderer not ready / load failure) just
  // retries on a later mount.
  useEffect(() => {
    if (!node.imageUrl || mapPoster) return
    let live = true
    ensureModelPoster(node.imageUrl)
      .then(ref => { if (live && ref && ref !== node.posterUrl) updateFreeNode(id, { posterUrl: ref }) })
      .catch(() => {})
    return () => { live = false }
  }, [node.imageUrl, mapPoster, node.posterUrl, id, updateFreeNode])
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
      {resolvedPoster ? (
        <img
          src={resolvedPoster}
          draggable={false}
          // A poster whose blob no longer reads back (the browser can lose
          // the file behind an IndexedDB blob — the record survives with
          // the right size and type, but reading it throws
          // NotReadableError) decodes to nothing and the tile shows an
          // empty box forever. Regenerating writes a fresh blob, which
          // works, so heal instead of sitting there broken. Once per
          // mount, so a genuinely undecodable poster can't loop.
          onError={() => {
            if (!node.imageUrl || posterHealed.current) return
            posterHealed.current = true
            invalidateModelPoster(node.imageUrl)
            void ensureModelPoster(node.imageUrl)
              .then(ref => { if (ref) updateFreeNode(id, { posterUrl: ref }) })
              .catch(() => {})
          }}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.25)', pointerEvents: 'none', maxWidth: '90%' }}>
          {/* Wireframe cube */}
          <svg width={34 * dz} height={34 * dz} viewBox="0 0 24 24" fill="none" style={{ opacity: 0.6, marginBottom: 4 * dz }}>
            <path d="M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z" stroke="rgba(255,255,255,0.5)" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M12 2 L12 12 M12 12 L21 7 M12 12 L3 7 M12 12 L12 22" stroke="rgba(255,255,255,0.3)" strokeWidth="1" strokeLinejoin="round" />
          </svg>
          <div style={{ fontSize: 10 * dz, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {node.imageUrl ? (node.label || '3D model') : 'drop 3D model here'}
          </div>
        </div>
      )}
      {/* "3D" corner badge — mirrors the video play-overlay affordance */}
      {node.imageUrl && (
        <div style={{
          position: 'absolute', top: 5 * dz, right: 5 * dz,
          padding: `${2 * dz}px ${5 * dz}px`, borderRadius: 4 * dz,
          background: 'rgba(0,0,0,0.55)', border: `${1 * dz}px solid rgba(255,255,255,0.25)`,
          fontSize: 9 * dz, fontWeight: 700, letterSpacing: '0.5px',
          color: 'rgba(160,210,255,0.9)', pointerEvents: 'none',
        }}>3D</div>
      )}
    </div>
  )
}

// ── Text Format Toolbar (portalled above the node) ──

const TextFormatToolbar: React.FC<{
  node: FreeNodeData
  id: string
  updateFreeNode: (id: string, patch: Partial<FreeNodeData>) => void
  wrapperRef: React.RefObject<HTMLDivElement | null>
}> = ({ node, id, updateFreeNode, wrapperRef }) => {
  const selectedIds = useFreeNodeStore(s => s.selectedIds)
  const allNodes = useFreeNodeStore(s => s.nodes)
  const [showPopup, setShowPopup] = useState<'text' | 'bg' | 'hAlign' | 'vAlign' | 'font' | 'weight' | 'lineHeight' | 'spacing' | 'transform' | null>(null)

  const ts = { ...DEFAULT_TEXT_STYLE, ...node.textStyle }
  const setStyle = (patch: Partial<TextStyle>) => {
    // Apply to all selected text nodes, not just this one
    const textIds = selectedIds.filter(sid => allNodes[sid]?.type === 'text')
    if (textIds.length > 1) {
      for (const sid of textIds) {
        const sNode = allNodes[sid]
        if (sNode) {
          updateFreeNode(sid, { textStyle: { ...DEFAULT_TEXT_STYLE, ...sNode.textStyle, ...patch } })
        }
      }
    } else {
      updateFreeNode(id, { textStyle: { ...ts, ...patch } })
    }
  }

  // Position toolbar above the node in screen coordinates
  const rect = wrapperRef.current?.getBoundingClientRect()
  if (!rect) return null

  const toolbarLeft = rect.left
  const toolbarTop = rect.top - 38

  const btnStyle = (active?: boolean): React.CSSProperties => ({
    background: active ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)',
    border: active ? '1px solid rgba(255,255,255,0.3)' : '1px solid rgba(255,255,255,0.08)',
    borderRadius: 5,
    color: active ? '#fff' : 'rgba(255,255,255,0.6)',
    fontSize: 12, fontWeight: active ? 700 : 500,
    padding: '2px 7px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 24, height: 26,
    transition: 'all 0.1s',
  })

  const sepStyle: React.CSSProperties = {
    width: 1, height: 18, background: 'rgba(255,255,255,0.08)', margin: '0 3px', flexShrink: 0,
  }

  return ReactDOM.createPortal(
    <div
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: Math.max(4, Math.min(toolbarLeft, window.innerWidth - 460)),
        top: Math.max(4, toolbarTop),
        zIndex: 10000,
        display: 'flex', alignItems: 'center', gap: 3,
        background: '#1a1b2e',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 8, padding: '4px 6px',
        boxShadow: '0 8px 30px rgba(0,0,0,0.7)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Font size — editable input + steppers */}
      <button style={btnStyle()} onClick={() => {
        const cur = ts.fontSize
        const prev = FONT_SIZES.filter(s => s < cur).pop() ?? Math.max(1, cur - 1)
        setStyle({ fontSize: prev })
      }}>−</button>
      <input
        type="text"
        value={ts.fontSize}
        onChange={e => {
          const v = parseInt(e.target.value, 10)
          if (!isNaN(v) && v > 0 && v <= 999) setStyle({ fontSize: v })
        }}
        onPointerDown={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.key === 'ArrowUp') { e.preventDefault(); setStyle({ fontSize: Math.min(999, ts.fontSize + 1) }) }
          if (e.key === 'ArrowDown') { e.preventDefault(); setStyle({ fontSize: Math.max(1, ts.fontSize - 1) }) }
        }}
        style={{
          width: 30, textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.7)',
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 4, padding: '2px 2px', outline: 'none', fontFamily: 'inherit',
        }}
        title="Font size (px)"
      />
      <button style={btnStyle()} onClick={() => {
        const cur = ts.fontSize
        const next = FONT_SIZES.find(s => s > cur) ?? Math.min(999, cur + 1)
        setStyle({ fontSize: next })
      }}>+</button>

      {/* Font family */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'font'), fontSize: 10, padding: '2px 5px', maxWidth: 58, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          onClick={() => setShowPopup(showPopup === 'font' ? null : 'font')}
          title="Font family"
        >{FONT_LIST.find(f => f.value === (ts.fontFamily ?? FONT_LIST[0].value))?.label ?? 'System'}</button>
        {showPopup === 'font' && (
          <div
            onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}
            style={{
              position: 'absolute', top: 32, left: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'flex', flexDirection: 'column', gap: 1, width: 170, maxHeight: 320, overflowY: 'auto',
            }}
          >
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', padding: '4px 8px 2px', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' }}>System</div>
            {FONT_LIST.filter(f => !f.google).map(f => (
              <button
                key={f.value}
                onClick={() => { setStyle({ fontFamily: f.value }); setShowPopup(null) }}
                style={{
                  ...btnStyle((ts.fontFamily ?? FONT_LIST[0].value) === f.value),
                  fontFamily: f.value, fontSize: 12, padding: '4px 8px',
                  textAlign: 'left', width: '100%', justifyContent: 'flex-start',
                }}
              >{f.label}</button>
            ))}
            <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '4px 0' }} />
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', padding: '2px 8px 2px', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' }}>Google Fonts</div>
            {FONT_LIST.filter(f => f.google).map(f => (
              <button
                key={f.value}
                onMouseEnter={() => loadGoogleFont(f.label)}
                onClick={() => { loadGoogleFont(f.label); setStyle({ fontFamily: f.value }); setShowPopup(null) }}
                style={{
                  ...btnStyle((ts.fontFamily ?? FONT_LIST[0].value) === f.value),
                  fontFamily: f.value, fontSize: 12, padding: '4px 8px',
                  textAlign: 'left', width: '100%', justifyContent: 'flex-start',
                }}
              >{f.label}</button>
            ))}
          </div>
        )}
      </div>

      <div style={sepStyle} />

      {/* Font weight — popup with common weights */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'weight'), fontSize: 10, padding: '2px 5px', minWidth: 28 }}
          onClick={() => setShowPopup(showPopup === 'weight' ? null : 'weight')}
          title="Font weight"
        >
          <span style={{ fontWeight: ts.fontWeight ?? (ts.bold ? 700 : 400) }}>W</span>
        </button>
        {showPopup === 'weight' && (
          <div
            onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}
            style={{
              position: 'absolute', top: 32, left: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'flex', flexDirection: 'column', gap: 1, width: 120,
            }}
          >
            {FONT_WEIGHTS.map(w => (
              <button
                key={w.value}
                onClick={() => { setStyle({ fontWeight: w.value, bold: w.value >= 600 }); setShowPopup(null) }}
                style={{
                  ...btnStyle((ts.fontWeight ?? (ts.bold ? 700 : 400)) === w.value),
                  fontWeight: w.value, fontSize: 11, padding: '3px 8px',
                  textAlign: 'left', width: '100%', justifyContent: 'flex-start',
                }}
              >{w.label}</button>
            ))}
          </div>
        )}
      </div>

      {/* Italic */}
      <button style={{ ...btnStyle(ts.italic), fontStyle: 'italic', fontSize: 13 }} onClick={() => setStyle({ italic: !ts.italic })}>I</button>

      {/* Text transform */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'transform'), fontSize: 10, padding: '2px 5px' }}
          onClick={() => setShowPopup(showPopup === 'transform' ? null : 'transform')}
          title="Text transform"
        >Aa</button>
        {showPopup === 'transform' && (
          <div
            onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}
            style={{
              position: 'absolute', top: 32, left: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'flex', flexDirection: 'column', gap: 1, width: 110,
            }}
          >
            {TEXT_TRANSFORMS.map(t => (
              <button
                key={t.value}
                onClick={() => { setStyle({ textTransform: t.value as any }); setShowPopup(null) }}
                style={{
                  ...btnStyle((ts.textTransform ?? 'none') === t.value),
                  fontSize: 11, padding: '3px 8px',
                  textAlign: 'left', width: '100%', justifyContent: 'flex-start',
                }}
              >{t.label}</button>
            ))}
          </div>
        )}
      </div>

      <div style={sepStyle} />

      {/* Horizontal alignment — popup */}
      <div style={{ position: 'relative' }}>
        <button
          style={btnStyle(showPopup === 'hAlign')}
          onClick={() => setShowPopup(showPopup === 'hAlign' ? null : 'hAlign')}
          title="Horizontal align"
        >
          {hAlignIcons[ts.align]}
        </button>
        {showPopup === 'hAlign' && (
          <AlignPopup
            options={[
              { value: 'left', label: 'Left', icon: hAlignIcons.left },
              { value: 'center', label: 'Center', icon: hAlignIcons.center },
              { value: 'right', label: 'Right', icon: hAlignIcons.right },
            ]}
            selected={ts.align}
            onSelect={v => { setStyle({ align: v as any }); setShowPopup(null) }}
            onClose={() => setShowPopup(null)}
          />
        )}
      </div>

      {/* Vertical alignment — popup */}
      <div style={{ position: 'relative' }}>
        <button
          style={btnStyle(showPopup === 'vAlign')}
          onClick={() => setShowPopup(showPopup === 'vAlign' ? null : 'vAlign')}
          title="Vertical align"
        >
          {vAlignIcons[ts.vAlign]}
        </button>
        {showPopup === 'vAlign' && (
          <AlignPopup
            options={[
              { value: 'top', label: 'Top', icon: vAlignIcons.top },
              { value: 'middle', label: 'Middle', icon: vAlignIcons.middle },
              { value: 'bottom', label: 'Bottom', icon: vAlignIcons.bottom },
            ]}
            selected={ts.vAlign}
            onSelect={v => { setStyle({ vAlign: v as any }); setShowPopup(null) }}
            onClose={() => setShowPopup(null)}
          />
        )}
      </div>

      <div style={sepStyle} />

      {/* Line height */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'lineHeight'), fontSize: 10, padding: '2px 5px' }}
          onClick={() => setShowPopup(showPopup === 'lineHeight' ? null : 'lineHeight')}
          title="Line height"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 2h12M1 7h12M1 12h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <path d="M13 4.5L13 9.5M13 4.5l-1.5 1.5M13 4.5l1.5 1.5M13 9.5l-1.5-1.5M13 9.5l1.5-1.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        {showPopup === 'lineHeight' && (
          <div
            onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}
            style={{
              position: 'absolute', top: 32, left: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'flex', flexDirection: 'column', gap: 1, width: 80,
            }}
          >
            {LINE_HEIGHTS.map(lh => (
              <button
                key={lh}
                onClick={() => { setStyle({ lineHeight: lh }); setShowPopup(null) }}
                style={{
                  ...btnStyle(Math.abs((ts.lineHeight ?? 1.55) - lh) < 0.01),
                  fontSize: 11, padding: '3px 8px',
                  textAlign: 'left', width: '100%', justifyContent: 'flex-start',
                }}
              >{lh.toFixed(1)}</button>
            ))}
          </div>
        )}
      </div>

      {/* Letter spacing */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'spacing'), fontSize: 10, padding: '2px 5px' }}
          onClick={() => setShowPopup(showPopup === 'spacing' ? null : 'spacing')}
          title="Letter spacing"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 3L7 11M11 3L7 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <path d="M1 13l2-2M1 13l2 2M13 13l-2-2M13 13l-2 2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        {showPopup === 'spacing' && (
          <div
            onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}
            style={{
              position: 'absolute', top: 32, left: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'flex', flexDirection: 'column', gap: 1, width: 80,
            }}
          >
            {LETTER_SPACINGS.map(ls => (
              <button
                key={ls}
                onClick={() => { setStyle({ letterSpacing: ls }); setShowPopup(null) }}
                style={{
                  ...btnStyle((ts.letterSpacing ?? 0) === ls),
                  fontSize: 11, padding: '3px 8px',
                  textAlign: 'left', width: '100%', justifyContent: 'flex-start',
                }}
              >{ls === 0 ? '0' : ls > 0 ? `+${ls}` : `${ls}`}</button>
            ))}
          </div>
        )}
      </div>

      <div style={sepStyle} />

      {/* Text color */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'text'), gap: 4, padding: '2px 6px' }}
          onClick={() => setShowPopup(showPopup === 'text' ? null : 'text')}
          title="Text color"
        >
          <span style={{ fontSize: 13, fontWeight: 700 }}>A</span>
          <div style={{ width: 14, height: 4, borderRadius: 1, background: ts.color, border: '1px solid rgba(255,255,255,0.15)' }} />
        </button>
        {showPopup === 'text' && (
          <ColorSwatchPopup
            colors={PRESET_COLORS}
            selected={ts.color}
            onSelect={c => { setStyle({ color: c }); setShowPopup(null) }}
            onClose={() => setShowPopup(null)}
          />
        )}
      </div>

      {/* Background color + opacity */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'bg'), gap: 4, padding: '2px 6px' }}
          onClick={() => setShowPopup(showPopup === 'bg' ? null : 'bg')}
          title="Background"
        >
          <div style={{
            width: 16, height: 14, borderRadius: 3,
            background: ts.bgOpacity > 0 ? hexToRgba(ts.bgColor, ts.bgOpacity) : 'linear-gradient(135deg, rgba(255,255,255,0.1) 45%, transparent 45%, transparent 55%, rgba(255,255,255,0.1) 55%)',
            border: '1px solid rgba(255,255,255,0.15)',
          }} />
        </button>
        {showPopup === 'bg' && (
          <BgPickerPopup
            bgColor={ts.bgColor}
            bgOpacity={ts.bgOpacity}
            onColorSelect={c => setStyle({ bgColor: c })}
            onOpacityChange={o => setStyle({ bgOpacity: o })}
            onClose={() => setShowPopup(null)}
          />
        )}
      </div>
    </div>,
    document.body
  )
}

