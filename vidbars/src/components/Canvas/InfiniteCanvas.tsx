import React, { useRef, useCallback, useEffect, useState, useDeferredValue, useMemo } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { useTiltStage } from '../../store/tiltStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { PinLayer } from './PinLayer'
import { useBoardsStore } from '../../store/boardsStore'
import { uploadFile, classifyFile, isAcceptedMediaFile } from '../../utils/uploadFile'
import type { FreeNodeType, FreeNodeData } from '../../store/freeNodeStore'
import type { MediaType } from '../../types/bar'
import { computeGroupLayout, getRowY, getRowHeight, CARD_GRID_SPACING } from '../../utils/nleRows'
import { DOT_SPACING, dotStep } from '../../utils/dotGrid'
import { useViewport3DStore, VIEWPORT3D_DEFAULT_W, VIEWPORT3D_DEFAULT_H } from '../../store/viewport3dStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { nextFreeEdgeSlot } from '../../utils/viewportDocking'
import { isPanelType } from '../../utils/componentLinks'
import { createCardOrBoardAt } from '../../utils/canvasCreate'
import { GLCanvasHost } from '../Viewport3D/GLCanvasHost'
import { addMediaBlockToCard, cardHitOf, groupForCardHit, type CardHit } from '../../utils/cardContent'
import { EFFECT_DRAG_MIME, clientToCanvas, createEffectCard, createLoopStrip, effectKindFromDrag } from '../../utils/fx/createEffect'
import { takeDragOutCard, takeDragOutShape } from '../../utils/dragOutSource'
import { placeCard } from '../../utils/railCards'
import { drawnRect } from '../../utils/effectCards'
import { cardFaceSize, createMediaCard } from '../../utils/cardGrid'
import { tileDeckIndex } from '../../utils/tileDecks'
import { RAIL_GEOM, isRail, railDropTarget, railLayout, railMembers, type RailDropTarget } from '../../utils/rail'
import { railAtPoint } from './rail/railHit'
import { currentZone, useZoomZone } from '../../store/zoomZonesStore'

// ── Media Pool drag-out ──────────────────────────────────────────────
// A pool tile and a pool-fed Rolodex slot put this exact payload on the
// wire at dragstart, so ONE reader here serves both producers. The file
// already lives on the server, which is why nothing on this path uploads:
// the url is the whole transfer.
const POOL_DRAG_MIME = 'application/x-vidbars-pool'

interface PoolDragPayload {
  url: string
  label: string
  kind: MediaType
}

const POOL_KINDS: readonly MediaType[] = ['image', 'video', 'audio', 'model']
/** Media that comes in as a card of its own (dropAsCards). */
const CARD_KINDS: readonly MediaType[] = ['image', 'video', 'model']

/** Parse a pool payload defensively — a drag can carry text from anywhere,
 *  and a malformed one must fall through to the file path rather than
 *  create a node pointing at nothing. */
function parsePoolDrag(raw: string): PoolDragPayload | null {
  try {
    const p = JSON.parse(raw) as Partial<PoolDragPayload>
    if (typeof p?.url !== 'string' || !p.url) return null
    if (!POOL_KINDS.includes(p.kind as MediaType)) return null
    return {
      url: p.url,
      label: typeof p.label === 'string' ? p.label : '',
      kind: p.kind as MediaType,
    }
  } catch {
    return null
  }
}

// ── Where a drop lands ───────────────────────────────────────────────
// ONE target per drop: the topmost thing under the cursor that takes it,
// the rule the link drag follows too. Fixed-priority passes that each
// scanned the whole stack let a drop fall through onto whatever lay behind
// — a Viewer or a tile hidden under a card at card zoom, a canvas block
// hidden under a pinned card.

type DropLevel = 'card' | 'block' | 'board'

type DropTarget =
  | { kind: 'viewer'; windowId: string }
  | { kind: 'tile'; nodeId: string }
  | { kind: 'card'; hit: CardHit }
  | { kind: 'block'; boardId: string }
  | { kind: 'bar'; boardId: string; barId: string }

interface DropAim {
  /** The topmost target under the cursor, or null. */
  target: DropTarget | null
  /** What lies under the cursor is the canvas itself, so a drop that finds
   *  no target (or one that cannot take it) may make a tile there. False
   *  over anything floating above the canvas — a pinned card's frame, a
   *  pinned panel, the level bar: a tile made there would be hidden. */
  onCanvas: boolean
}

/** A tile whose media a dropped file or pool item replaces. Not a pinned
 *  node — it floats over everything, so a drop near it would land ON it —
 *  and not a panel or an effect card: those are tools, not media, and a
 *  drop would overwrite one into an image tile. Not a loop strip either
 *  (the drop would turn the rail itself into an image tile), nor a card
 *  docked on one: a picture let go on a column is dealt INTO it, at that
 *  spot in the cascade (see railDropAt), the way a dragged tile is — not
 *  swapped for the card it landed on. */
function takesMedia(n: FreeNodeData): boolean {
  return !n.pin && !isPanelType(n.type) && n.type !== 'effect' && n.type !== 'rail' && !n.railDock
}

/** A stand-in for something not made yet — railDropTarget judges a drop
 *  by the dragged node's type (picture or effect card), nothing else. */
function railProbe(type: FreeNodeType): FreeNodeData {
  return { id: '', x: 0, y: 0, width: 0, height: 0, type, label: '', text: '', imageUrl: 'probe', color: '' }
}

/** Where something let go at client (x, y) would dock on a loop strip, or
 *  null: a picture into the role column under the point (at its place in
 *  the cascade), an effect card into the slot row. Only on the rail that is
 *  topmost under the point (railAtPoint): one hidden under a panel or a
 *  Viewer must not take a drop aimed at what covers it. Pinned rails dock
 *  nothing. */
function railDropAt(x: number, y: number, type: FreeNodeType): RailDropTarget | null {
  const nodes = useFreeNodeStore.getState().nodes
  const railId = railAtPoint(x, y, nodes)
  const rail = railId ? nodes[railId] : undefined
  if (!rail || !isRail(rail) || rail.pin) return null
  const { cx, cy } = clientToCanvas(x, y)
  const L = railLayout(rail, railMembers(nodes).get(rail.id))
  return L ? railDropTarget(L, rail, { x: cx, y: cy }, railProbe(type)) : null
}

/** Tiles a drop just made on the canvas at client (x, y): the pictures
 *  among them go INTO the loop-strip column under the point, in drop
 *  order — a hand dealt into a column. Same undo step as the drop (it took
 *  the checkpoint). A picture still uploading docks too; its face fills in
 *  when the upload lands. Whatever does not dock, dropped on a rail (its
 *  tray, an effect card, a note), is set down just under that rail: left
 *  there it would lie beneath the rail's cascades. Anywhere else, tiles stay
 *  where the drop made them. */
function dealOntoRail(ids: string[], x: number, y: number): void {
  const fns = useFreeNodeStore.getState()
  const pics = ids.filter(id => fns.nodes[id]?.type === 'image' || fns.nodes[id]?.type === 'video')
  const t = pics.length > 0 ? railDropAt(x, y, 'image') : null
  if (t?.kind === 'column') fns.dockToRail(pics, t)
  const railId = railAtPoint(x, y, useFreeNodeStore.getState().nodes)
  const rail = railId ? useFreeNodeStore.getState().nodes[railId] : undefined
  if (!rail || !isRail(rail) || rail.pin) return
  ids.forEach((id, i) => {
    const n = useFreeNodeStore.getState().nodes[id]
    if (!n || n.railDock) return
    fns.updateFreeNode(id, { y: rail.y + rail.height + RAIL_GEOM.gap * rail.rail.unit + i * 20 / Math.max(0.01, useCanvasStore.getState().zoom) })
  })
}

/** A board background's target: its root bar. */
function boardRootTarget(board: HTMLElement): DropTarget | null {
  const boardBlock = board.querySelector('[data-block][data-board-id]') as HTMLElement | null
  if (!boardBlock) return null
  const boardId = boardBlock.dataset.boardId ?? 'primary'
  const rid = useBoardsStore.getState().boards[boardId]?.rootIds[0]
  return rid ? { kind: 'bar', boardId, barId: rid } : null
}

/** The smallest bar in `scope` whose rect holds the point. Catches a bar
 *  under a transparent overlay (text layer, hero image with opacity…) that
 *  the element walk passed by. */
function barByRect(scope: ParentNode, x: number, y: number, skipPinned: boolean): DropTarget | null {
  let best: { el: HTMLElement; area: number } | null = null
  for (const bar of Array.from(scope.querySelectorAll<HTMLElement>('[data-block][data-id]'))) {
    if (bar.dataset.layerBlock || (skipPinned && bar.closest('[data-pin-host]'))) continue
    const r = bar.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue
    const area = r.width * r.height
    if (!best || area < best.area) best = { el: bar, area }
  }
  return best ? { kind: 'bar', boardId: best.el.dataset.boardId ?? 'primary', barId: best.el.dataset.id! } : null
}

/** Aim a drop at (x, y). Walks the stack topmost first, past chrome that
 *  carries no identity (headers, a deck's hover zone, chips), and stops at
 *  the first real surface — taking it if it is a target, refusing to look
 *  behind it if not. Pure: reads the DOM and the stores, changes nothing,
 *  so dragover can ask it too. */
function aimDrop(x: number, y: number): DropAim {
  let els = document.elementsFromPoint(x, y)
  const z = useCanvasStore.getState().zoom
  let level: DropLevel = z <= 0.18 ? 'card' : z < 0.3 ? 'block' : 'board'
  // A pinned card is a frame of its own. A drop in it goes by the level the
  // frame shows, not the canvas zoom, and reaches only what is drawn in it
  // — never the canvas hidden behind the frame.
  const frame = els[0]?.closest('[data-pinned-group]') as HTMLElement | null
  if (frame) {
    const g = useBoardsStore.getState().groups.find(gr => gr.id === frame.dataset.pinnedGroup)
    level = g?.pinnedLayer ?? 'card'
    els = els.filter(el => frame.contains(el))
  }
  const hit = (target: DropTarget): DropAim => ({ target, onCanvas: !frame })
  const miss = (floating: boolean): DropAim => ({ target: null, onCanvas: !frame && !floating })

  for (const el of els) {
    // Viewers and tiles, at every level.
    const winEl = el.closest('[data-viewport3d]') as HTMLElement | null
    if (winEl) {
      const windowId = winEl.dataset.viewport3d
      return windowId && useViewport3DStore.getState().windows[windowId]
        ? hit({ kind: 'viewer', windowId })
        : miss(!!winEl.closest('[data-pin-host]'))
    }
    const nodeEl = el.closest('[data-freenode][data-id]') as HTMLElement | null
    if (nodeEl) {
      const nodeId = nodeEl.dataset.id!
      const node = useFreeNodeStore.getState().nodes[nodeId]
      return node && takesMedia(node) ? hit({ kind: 'tile', nodeId }) : miss(!!node?.pin)
    }
    if (level === 'card') {
      const card = cardHitOf(el)
      if (card) return hit({ kind: 'card', hit: card })
    } else if (level === 'block') {
      const block = el.closest('[data-layer-block]') as HTMLElement | null
      if (block) return hit({ kind: 'block', boardId: block.dataset.layerBlock! })
    } else {
      const bar = el.closest('[data-block][data-id]') as HTMLElement | null
      if (bar && !bar.dataset.layerBlock) {
        return hit({ kind: 'bar', boardId: bar.dataset.boardId ?? 'primary', barId: bar.dataset.id! })
      }
      // A board's background: a bar it passed over, else the root bar.
      const board = el.closest('[data-board]') as HTMLElement | null
      const t = board && (barByRect(board, x, y, false) ?? boardRootTarget(board))
      if (t) return hit(t)
    }
    // Anything else pinned floats over the canvas: the level bar, a pinned
    // panel's chrome. (Inside a frame, everything is pinned — skip that.)
    if (!frame && el.closest('[data-pin-host]')) return miss(true)
  }
  if (level === 'board') {
    const t = barByRect(frame ?? document, x, y, !frame)
    if (t) return hit(t)
  }
  return miss(false)
}

// ── Effect drags ─────────────────────────────────────────────────────
// An effect from the Effects palette or the card browser (payload:
// utils/fx/createEffect) MAKES a card where it is let go — it fills
// nothing — so it only needs somewhere on the canvas to put one.

/** May an effect drag be let go at (x, y)? Wherever aimDrop finds the
 *  canvas itself, except on a Viewer, where the card would land on the
 *  window. */
function effectDropAllowed(x: number, y: number): boolean {
  const aim = aimDrop(x, y)
  return aim.onCanvas && aim.target?.kind !== 'viewer'
}

/** The tile an effect was let go on, if any — dropped on a picture, the
 *  card joins that picture's strip rather than landing on top of it
 *  (createEffectCard ignores a tile that cannot be on a strip). Topmost
 *  first; a bar or board drawn over the point hides what lies behind. */
function effectDropTile(x: number, y: number): string | undefined {
  for (const el of document.elementsFromPoint(x, y)) {
    const nodeEl = el.closest('[data-freenode][data-id]') as HTMLElement | null
    if (nodeEl) return nodeEl.dataset.id
    if (el.closest('[data-block],[data-board]')) return undefined
  }
  return undefined
}

/** The loop strip an effect let go at (x, y) docks onto, or null. Only
 *  when nothing else is on top there: over a rail's own face, a card on
 *  it, or the rail's margin of bare canvas — a free tile lying over the
 *  rail takes the drop itself (its strip), as it would anywhere. */
function effectDropRail(x: number, y: number, onto: string | undefined): RailDropTarget | null {
  const top = onto ? useFreeNodeStore.getState().nodes[onto] : undefined
  if (top && top.type !== 'rail' && !top.railDock) return null
  return railDropAt(x, y, 'effect')
}

interface Props {
  children: React.ReactNode
  initialCenterW?: number
  initialCenterH?: number
}

export const InfiniteCanvas: React.FC<Props> = ({ children, initialCenterW = 1000 }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const zone = useZoomZone()
  const shiftPan = useCanvasStore(s => s.shiftPan)
  const zoomAtPoint = useCanvasStore(s => s.zoomAtPoint)
  const setPan = useCanvasStore(s => s.setPan)


  const addFreeNode = useFreeNodeStore(s => s.addFreeNode)
  const updateFreeNode = useFreeNodeStore(s => s.updateFreeNode)
  const setFreeSelection = useFreeNodeStore(s => s.setFreeSelection)
  const clearFreeSelection = useFreeNodeStore(s => s.clearFreeSelection)
  const setFocusedBoard = useCanvasStore(s => s.setFocusedBoard)

  const isPanning = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })
  const spaceDown = useRef(false)
  const [spaceActive, setSpaceActive] = useState(false)
  const [addMenu, setAddMenu] = useState<{ sx: number; sy: number; cx: number; cy: number } | null>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const panRef = useRef(pan)
  panRef.current = pan

  // Rubber-band selection state (screen coords relative to container)
  // Tilt is applied straight to the stage element (useTiltStage), so a
  // tilting frame does not re-render this component.
  const tiltStageRef = useTiltStage()
  const [rubberBand, setRubberBand] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null)
  const rubberBandRef = useRef<{ sx: number; sy: number; ex: number; ey: number } | null>(null)
  const rbStartCanvas = useRef<{ cx: number; cy: number } | null>(null)

  // Center on first launch only — skip if pan was restored from localStorage
  useEffect(() => {
    const saved = useCanvasStore.getState().pan
    if (saved.x !== 0 || saved.y !== 0) return
    const toolbarH = 40
    const canvasH = window.innerHeight - toolbarH
    setPan({
      x: Math.max(20, (window.innerWidth - initialCenterW) / 2),
      y: Math.round(canvasH * 0.18),
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Space key pan mode
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.target === document.body) {
        if (!spaceDown.current) { spaceDown.current = true; setSpaceActive(true) }
        e.preventDefault()
      }
      // Home/End: nothing in our code reads them, but the browser default
      // (scroll to top/bottom of document) is a trap on a canvas app —
      // hitting Home by accident snaps the page scroll and the visual
      // result reads as "everything went crazy" even though no app state
      // moved. Swallow the keys when focus is on the document body so
      // text-editing contexts (inputs, textareas, contenteditable) keep
      // their native Home/End behavior untouched.
      if ((e.key === 'Home' || e.key === 'End') && e.target === document.body) {
        e.preventDefault()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') { spaceDown.current = false; setSpaceActive(false) }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = containerRef.current!.getBoundingClientRect()
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    zoomAtPoint(factor, e.clientX - rect.left, e.clientY - rect.top)
  }, [zoomAtPoint])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Middle mouse or space+left-drag = pan
    if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      isPanning.current = true
      lastMouse.current = { x: e.clientX, y: e.clientY }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }
    // Left-click on bare canvas = rubber-band select
    if (e.button === 0) {
      const target = e.target as Element
      if (target.closest('[data-block],[data-board],[data-freenode],[data-viewport3d]')) return
      setFocusedBoard(null)
      const rect = containerRef.current!.getBoundingClientRect()
      const relX = e.clientX - rect.left
      const relY = e.clientY - rect.top
      rbStartCanvas.current = {
        cx: (relX - panRef.current.x) / zoomRef.current,
        cy: (relY - panRef.current.y) / zoomRef.current,
      }
      const initial = { sx: relX, sy: relY, ex: relX, ey: relY }
      rubberBandRef.current = initial
      setRubberBand(initial)
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      clearFreeSelection()
      // Clear selection on ALL boards + card groups — single batched update
      useBoardsStore.getState().clearGroupSelection()
      useBoardsStore.getState().clearAllSelections()
      // Click on empty canvas also releases any deck-portal previews —
      // bare-canvas-click is the universal "deselect everything" gesture.
      useCanvasStore.getState().clearAllDeckPortals()
    }
  }, [clearFreeSelection])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (isPanning.current) {
      shiftPan(e.clientX - lastMouse.current.x, e.clientY - lastMouse.current.y)
      lastMouse.current = { x: e.clientX, y: e.clientY }
    } else if (rbStartCanvas.current) {
      const rect = containerRef.current!.getBoundingClientRect()
      const updated = rubberBandRef.current
        ? { ...rubberBandRef.current, ex: e.clientX - rect.left, ey: e.clientY - rect.top }
        : null
      rubberBandRef.current = updated
      setRubberBand(updated)
    }
  }, [shiftPan])

  /** `floating`: the drag is over LayerOverlay chrome (see the host
   *  listener below) — there is no bare canvas under it to make a tile on. */
  const handleDragOver = useCallback((e: React.DragEvent, floating = false) => {
    // preventDefault here is what tells the browser the canvas ACCEPTS the
    // drag — without it no drop event is ever dispatched. The pool payload
    // has to be admitted alongside 'Files' or dragging a tile out of a
    // Media Pool is silently dead. getData is blacked out during dragover
    // for security, but `types` is not, which is all this test needs.
    // Our own drag-out passing back over the canvas: taken over BARE canvas
    // only (a loop strip counts — its column takes it), where letting go
    // makes a duplicate of what was dragged, as it looks now. Over its own
    // tile, or any other target, it is refused: a slip back onto the source
    // must not replace or append anything.
    if (window.vidbarsDesktop?.isDraggingOut?.()) {
      const aim = aimDrop(e.clientX, e.clientY)
      if (floating || aim.target || !aim.onCanvas) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      return
    }
    // An effect drag makes a card where it lands, so it is taken over the
    // canvas only — never through the overlay listener (`floating`: card
    // faces and headers, no canvas under them to put a card on).
    // Decided here EITHER way, the refusal included: NLEBlock and the
    // Viewers preventDefault every drag, so a bare return left a refused
    // effect drop looking accepted — the drop fired, made nothing, and the
    // palette (which closes on a dragend reporting 'copy') shut anyway.
    // preventDefault + 'none' is a refusal their bare preventDefault cannot
    // undo: it never resets dropEffect, whichever of us runs first.
    if (e.dataTransfer.types.includes(EFFECT_DRAG_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect =
        floating || !effectDropAllowed(e.clientX, e.clientY) ? 'none' : 'copy'
      return
    }
    if (!e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(POOL_DRAG_MIME)) return
    // Accepted only where letting go would do something: over a target, or
    // over bare canvas to make a tile on. Over a pinned panel, or over a
    // header with nothing that takes it beneath, the drag is refused.
    const aim = aimDrop(e.clientX, e.clientY)
    if (!aim.target && !(aim.onCanvas && !floating)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  // ── Creation sizing ──────────────────────────────────────────────
  // New things are sized in CANVAS units, but the user judges them on
  // SCREEN. At card zoom a 200-unit tile is a 30-px speck. Scale the
  // creation size by 1/zoom so anything created lands at a comfortable
  // on-screen size whatever the zoom, clamped so the extremes stay sane.
  const createScale = useCallback(() => {
    const z = zoomRef.current
    return Math.max(0.6, Math.min(10, 1 / z))
  }, [])

  /** Create a free node CENTERED on the add-menu's canvas point, sized
   *  for the current zoom. */
  const addNodeAtCursor = useCallback((type: FreeNodeType, baseW: number, baseH: number) => {
    if (!addMenu) return
    useUndoCoordinator.getState().checkpoint()
    const k = createScale()
    const w = baseW * k, h = baseH * k
    const id = addFreeNode(addMenu.cx - w / 2, addMenu.cy - h / 2, type)
    if (k !== 1) useFreeNodeStore.getState().updateFreeNode(id, { width: w, height: h })
    useFreeNodeStore.getState().setFreeSelection([id])
    return id
  }, [addMenu, addFreeNode, createScale])

  // ── Drop handlers — one per kind of target (see aimDrop) ──

  /** Drop on bare canvas at any layer — create free node(s). Returns their
   *  ids (a drop over a loop strip deals the pictures into it). */
  const dropOnBareCanvas = useCallback((e: React.DragEvent, files: File[]): string[] => {
    const rect = containerRef.current!.getBoundingClientRect()
    const z = zoomRef.current
    const p = panRef.current
    // Zoom-aware size so a drop at card zoom isn't a speck (see createScale).
    const k = Math.max(0.6, Math.min(10, 1 / z))
    useUndoCoordinator.getState().checkpoint()
    const made: string[] = []
    files.forEach((file, i) => {
      // Determine node type from the file (drives default size — must match freeNodeStore.addFreeNode)
      const nodeType = classifyFile(file)
      const mediaType = nodeType
      const nodeW = (nodeType === 'audio' ? 260 : 200) * k
      const nodeH = (nodeType === 'audio' ? 120 : 180) * k
      // Cursor position in canvas coordinates; multi-drops fan out by
      // one node-width so they never land on top of each other.
      const cursorCX = (e.clientX - rect.left - p.x) / z + i * (nodeW + 20 * k)
      const cursorCY = (e.clientY - rect.top - p.y) / z
      // Center the node on the cursor (store x/y = top-left)
      const nodeId = addFreeNode(cursorCX - nodeW / 2, cursorCY - nodeH / 2, nodeType)
      if (k !== 1) updateFreeNode(nodeId, { width: nodeW, height: nodeH })
      uploadFile(file).then(({ url }) => {
        updateFreeNode(nodeId, { imageUrl: url, mediaType, label: file.name.replace(/\.[^.]+$/, '') })
      })
      made.push(nodeId)
    })
    return made
  }, [addFreeNode, updateFreeNode])

  /** Drop of a Media Pool tile. The file is already server-served, so this
   *  never uploads — it is purely "make a node that points at that url".
   *  Produces the SAME node the pool's own double-click place produces
   *  (checkpoint → node → media → select), but lands at the cursor with
   *  the zoom-aware sizing an OS file drop gets, so a drop at card zoom
   *  isn't a speck. */
  const dropPoolItem = useCallback((e: React.DragEvent, p: PoolDragPayload): string => {
    const rect = containerRef.current!.getBoundingClientRect()
    const z = zoomRef.current
    const pn = panRef.current
    const k = Math.max(0.6, Math.min(10, 1 / z))
    const nodeW = (p.kind === 'audio' ? 260 : 200) * k
    const nodeH = (p.kind === 'audio' ? 120 : 180) * k
    // Cursor position in canvas coordinates; store x/y is top-left, so
    // offset by half the node to center it under the pointer.
    const cursorCX = (e.clientX - rect.left - pn.x) / z
    const cursorCY = (e.clientY - rect.top - pn.y) / z
    useUndoCoordinator.getState().checkpoint()
    const nodeId = addFreeNode(cursorCX - nodeW / 2, cursorCY - nodeH / 2, p.kind)
    updateFreeNode(nodeId, {
      imageUrl: p.url,
      mediaType: p.kind,
      ...(p.label ? { label: p.label } : {}),
      ...(k !== 1 ? { width: nodeW, height: nodeH } : {}),
    })
    setFreeSelection([nodeId])
    return nodeId
  }, [addFreeNode, updateFreeNode, setFreeSelection])

  /** Cards-first: what comes in onto bare canvas becomes a CARD — a picture,
   *  a video or a 3D model, one card each (utils/cardGrid), side by side from
   *  the drop point, the first centred on it. Audio is still a tile. One undo step for the lot. Files upload first: a card is made
   *  around the media it holds. Returns nothing to deal onto a rail — a drop
   *  over a loop strip keeps making tiles (see handleDrop). */
  const dropAsCards = useCallback((e: React.DragEvent, files: File[], pool?: PoolDragPayload) => {
    const at = clientToCanvas(e.clientX, e.clientY)
    const step = cardFaceSize().w * 1.08
    if (pool) {
      if (!CARD_KINDS.includes(pool.kind)) { dropPoolItem(e, pool); return }
      useUndoCoordinator.getState().checkpoint()
      const label = pool.label.replace(/\.[^.]+$/, '')
      const gid = createMediaCard(at, [{ media: { url: pool.url, type: pool.kind, originalName: pool.label }, label }])
      if (gid) useBoardsStore.getState().setSelectedGroup(gid)
      return
    }
    const media = files.filter(f => CARD_KINDS.includes(classifyFile(f)))
    const rest = files.filter(f => !media.includes(f))
    if (rest.length) dropOnBareCanvas(e, rest)
    if (media.length === 0) return
    useUndoCoordinator.getState().checkpoint()
    void (async () => {
      const made: string[] = []
      // In order, each card right of the one before.
      for (const [i, file] of media.entries()) {
        const { url, type, originalName } = await uploadFile(file)
        const gid = createMediaCard({ cx: at.cx + i * step, cy: at.cy },
          [{ media: { url, type, originalName }, label: file.name.replace(/\.[^.]+$/, '') }])
        if (gid) made.push(gid)
      }
      if (made.length === 1) useBoardsStore.getState().setSelectedGroup(made[0])
    })()
  }, [dropOnBareCanvas, dropPoolItem])

  /** A pool item dropped ON something, rather than on bare canvas.
   *
   *  The file path already fills cards, blocks, bars, tiles and Viewers; the
   *  pool path used to answer first and return, so the pool was the only
   *  media source in the app that could not fill anything — drag an image
   *  from the pool onto a card and you got a floating node lying on top of
   *  it. Same targets, aimed the same way (aimDrop), as the file path. The
   *  only difference is that there is nothing to upload: the url already
   *  points at something the server is serving.
   *
   *  Returns true when it consumed the drop. */
  const dropPoolOnTarget = useCallback((p: PoolDragPayload, t: DropTarget): boolean => {
    const label = p.label.replace(/\.[^.]+$/, '')
    switch (t.kind) {
      // A Viewer — show it, and park a tile on the window's edge so the
      // thing you dropped still exists as an object you can move.
      case 'viewer': {
        const win = useViewport3DStore.getState().windows[t.windowId]
        if (!win) return false
        useUndoCoordinator.getState().checkpoint()
        const tileW = p.kind === 'audio' ? 260 : 200
        const tileH = p.kind === 'audio' ? 120 : 180
        const fnNodes = useFreeNodeStore.getState().nodes
        const { hidden } = tileDeckIndex(fnNodes)   // a collapsed deck occupies its face only
        const occupied = Object.values(fnNodes)
          // …and a loop strip its own box: what is docked on it lies inside.
          .filter(n => !n.pin && !hidden.has(n.id) && !n.railDock)
          .map(n => ({ x: n.x, y: n.y, width: n.width, height: n.height }))
        const slot = nextFreeEdgeSlot(win, 'right', tileW, tileH, occupied)
        const nodeId = addFreeNode(slot.x, slot.y, p.kind)
        updateFreeNode(nodeId, { imageUrl: p.url, mediaType: p.kind, label })
        useViewport3DStore.getState().setActiveItem(t.windowId, {
          kind: 'media', mediaType: p.kind, url: p.url, name: label,
        })
        return true
      }
      // A media tile — replace what it holds.
      case 'tile':
        useUndoCoordinator.getState().checkpoint()
        updateFreeNode(t.nodeId, {
          type: p.kind, mediaType: p.kind, imageUrl: p.url,
          posterUrl: undefined,       // stale poster from whatever was here before
          label,
        })
        return true
      // A card takes ANY kind, as a block of its own (utils/cardContent).
      // Grouping an ungrouped board's card is part of the edit, so it comes
      // after the checkpoint.
      case 'card': {
        useUndoCoordinator.getState().checkpoint()
        const groupId = groupForCardHit(t.hit)
        if (!groupId) return false
        addMediaBlockToCard(groupId, { url: p.url, type: p.kind, originalName: p.label }, label)
        return true
      }
      // Thumbnails are images by construction, so a model falls through to
      // become a tile instead of landing in an <img>.
      case 'block':
        if (p.kind !== 'image') return false
        useUndoCoordinator.getState().checkpoint()
        useBoardsStore.getState().setBlockThumbnail(t.boardId, p.url)
        return true
      case 'bar':
        useUndoCoordinator.getState().checkpoint()
        useBoardsStore.getState().setContent(t.boardId, t.barId, {
          media: [{ url: p.url, type: p.kind, originalName: p.label }],
        })
        return true
    }
  }, [addFreeNode, updateFreeNode])

  /** ANY media files dropped ONTO a browser window: create content tiles
   *  docked flush at the window's right edge (stacking downward) and load
   *  the first one. */
  const dropOnViewportWindow = useCallback((windowId: string, files: File[]): boolean => {
    const win = useViewport3DStore.getState().windows[windowId]
    if (!win) return false
    useUndoCoordinator.getState().checkpoint()
    // Stack down the right edge past anything already parked there.
    const fnNodes = useFreeNodeStore.getState().nodes
    const { hidden } = tileDeckIndex(fnNodes)
    const occupied = Object.values(fnNodes)
      // Pinned nodes occupy no world space; nor do hidden deck members. A
      // loop strip occupies its own box — what is docked on it lies inside.
      .filter(n => !n.pin && !hidden.has(n.id) && !n.railDock)
      .map(n => ({ x: n.x, y: n.y, width: n.width, height: n.height }))
    files.forEach((file, i) => {
      const type = classifyFile(file)
      const tileW = type === 'audio' ? 260 : 200
      const tileH = type === 'audio' ? 120 : 180
      const slot = nextFreeEdgeSlot(win, 'right', tileW, tileH, occupied)
      occupied.push({ x: slot.x, y: slot.y, width: tileW, height: tileH })
      const nodeId = addFreeNode(slot.x, slot.y, type)
      uploadFile(file).then(({ url }) => {
        const label = file.name.replace(/\.[^.]+$/, '')
        useFreeNodeStore.getState().updateFreeNode(nodeId, {
          imageUrl: url, mediaType: type, label,
        })
        if (i === 0) {
          useViewport3DStore.getState().setActiveItem(windowId, {
            kind: 'media', mediaType: type, url, name: label,
          })
        }
      })
    })
    return true
  }, [addFreeNode])

  /** Files dropped ON something. Returns true when it consumed the drop. */
  const dropFilesOnTarget = useCallback((t: DropTarget, files: File[]): boolean => {
    switch (t.kind) {
      case 'viewer':
        return dropOnViewportWindow(t.windowId, files)
      // A media tile — the first file replaces what it holds.
      case 'tile': {
        const file = files[0]
        const nodeType = classifyFile(file)
        useUndoCoordinator.getState().checkpoint()
        uploadFile(file).then(({ url }) => {
          useFreeNodeStore.getState().updateFreeNode(t.nodeId, {
            type: nodeType,
            mediaType: nodeType,
            imageUrl: url,
            posterUrl: undefined,   // stale poster from any previous model
            label: file.name.replace(/\.[^.]+$/, ''),
          })
        })
        return true
      }
      // A card — every file goes INTO it, a block of its own, in drop order
      // (utils/cardContent). Nothing on the card is replaced: its face keeps
      // showing the first picture it holds, so dropping ten references on a
      // character card collects ten references. Grouping an ungrouped
      // board's card is part of the edit, so it comes after the checkpoint.
      case 'card': {
        useUndoCoordinator.getState().checkpoint()
        const groupId = groupForCardHit(t.hit)
        if (!groupId) return false
        void (async () => {
          // In order, awaited: each block is placed after the one before.
          for (const file of files) {
            const { url, type, originalName } = await uploadFile(file)
            addMediaBlockToCard(groupId, { url, type, originalName }, file.name.replace(/\.[^.]+$/, ''))
          }
        })()
        return true
      }
      // A block — thumbnails are images by construction: model, video and
      // audio files skip this (fall through to tile creation).
      case 'block': {
        const thumbFile = files.find(f => classifyFile(f) === 'image')
        if (!thumbFile) return false
        useUndoCoordinator.getState().checkpoint()
        uploadFile(thumbFile).then(({ url }) => {
          useBoardsStore.getState().setBlockThumbnail(t.boardId, url)
        })
        return true
      }
      // A bar — its media[] becomes the dropped files (one set call, not N appends).
      case 'bar':
        useUndoCoordinator.getState().checkpoint()
        Promise.all(files.map(f => uploadFile(f))).then(results => {
          const media = results.map(r => ({ url: r.url, type: r.type, originalName: r.originalName }))
          useBoardsStore.getState().setContent(t.boardId, t.barId, { media })
        })
        return true
    }
  }, [dropOnViewportWindow])

  /** `floating`: dropped on LayerOverlay chrome (see the host listener
   *  below) — no bare canvas under it, so a drop that takes nothing does
   *  nothing rather than leave a stray tile under a header. */
  const handleDrop = useCallback((e: React.DragEvent, floating = false) => {
    // Our own drag-out, released back over the canvas (see handleDragOver):
    // on bare canvas, a duplicate of the file it carried — the picture as
    // it showed, effects and all, since the grip hands out that render. A
    // card, block or bar dragged out the same way gets out without first
    // duplicating it in place. Anywhere else, nothing.
    if (window.vidbarsDesktop?.isDraggingOut?.()) {
      e.preventDefault()
      const aim = aimDrop(e.clientX, e.clientY)
      const own = Array.from(e.dataTransfer.files).filter(isAcceptedMediaFile)
      if (floating || aim.target || !aim.onCanvas || own.length === 0) return
      // Taken even when unused, so a later drag can never inherit it.
      const shape = takeDragOutShape()
      const fromCard = takeDragOutCard()
      // Out of a card (on the canvas or in the card browser): a duplicate
      // of that card as it is, centred where it was let go.
      if (fromCard && useBoardsStore.getState().groups.some(g => g.id === fromCard)) {
        useUndoCoordinator.getState().checkpoint()
        const copy = useBoardsStore.getState().duplicateGroup(fromCard)
        const bs = useBoardsStore.getState()
        const g = copy ? bs.groups.find(x => x.id === copy) : undefined
        const r = g ? drawnRect(g, bs.boards, useCanvasStore.getState().zoom) : null
        if (copy && r) {
          const at = clientToCanvas(e.clientX, e.clientY)
          placeCard(copy, at.cx - r.width / 2, at.cy - r.height / 2)
          bs.setSelectedGroup(copy)
        }
        return
      }
      // Out of a card, block or bar (no tile shape), and not over a loop
      // strip: it lands the way an import does — a card of its own.
      if (!shape && !railAtPoint(e.clientX, e.clientY, useFreeNodeStore.getState().nodes)) {
        dropAsCards(e, own)
        return
      }
      const made = dropOnBareCanvas(e, own)
      // One file back from a tile: the copy looks like the tile did — its
      // size and crop, centred where it was let go — not a default import.
      if (shape && made.length === 1) {
        const at = clientToCanvas(e.clientX, e.clientY)
        useFreeNodeStore.getState().updateFreeNode(made[0], {
          width: shape.width, height: shape.height,
          x: at.cx - shape.width / 2, y: at.cy - shape.height / 2,
          ...(shape.imageTransform ? { imageTransform: { ...shape.imageTransform } } : {}),
        })
      }
      dealOntoRail(made, e.clientX, e.clientY)
      return
    }
    // An effect drag (see handleDragOver). Like a pool drag it carries no
    // files, so it has to be read before the empty-files bail below.
    const fxRaw = e.dataTransfer.getData(EFFECT_DRAG_MIME)
    if (fxRaw) {
      // A refusal is left UNcancelled: that resets the drag operation to
      // 'none', so dragend reports nothing dropped and the palette stays
      // open. (handleDragOver refuses these already; this covers a release
      // the last dragover judged differently.)
      if (floating || !effectDropAllowed(e.clientX, e.clientY)) return
      e.preventDefault()
      // Over a loop strip it goes INTO the slot row, between the slots
      // either side of the drop — what dragging a card onto the rail does.
      const onto = effectDropTile(e.clientX, e.clientY)
      createEffectCard(effectKindFromDrag(fxRaw), {
        at: clientToCanvas(e.clientX, e.clientY),
        onto,
        rail: effectDropRail(e.clientX, e.clientY, onto) ?? undefined,
      })
      return
    }
    // A pool drag carries ZERO .files, so it has to be read before the
    // empty-files bail below. A malformed payload falls through to the file
    // path rather than create a node pointing at nothing.
    const poolRaw = e.dataTransfer.getData(POOL_DRAG_MIME)
    const payload = poolRaw ? parsePoolDrag(poolRaw) : null
    // Accepts image/video/audio AND 3D models (.glb/.gltf — MIME is often
    // empty on Windows, so filtering lives in isAcceptedMediaFile).
    const files = payload ? [] : Array.from(e.dataTransfer.files).filter(isAcceptedMediaFile)
    if (!payload && files.length === 0) return
    e.preventDefault()

    // Fill whatever it landed on; only make a new node if it landed on
    // bare canvas. Bare canvas is the fallback, not the only outcome.
    const aim = aimDrop(e.clientX, e.clientY)
    const bare = aim.onCanvas && !floating
    // Bare canvas includes a loop strip and its cards (takesMedia): the
    // tiles are made there, then dealt into the column under the drop.
    // Over a loop strip a drop still makes tiles — its columns deal
    // tiles. Anywhere else on bare canvas, a picture or video is a card.
    const overRail = !!railAtPoint(e.clientX, e.clientY, useFreeNodeStore.getState().nodes)
    if (payload) {
      if (!(aim.target && dropPoolOnTarget(payload, aim.target)) && bare) {
        if (overRail) dealOntoRail([dropPoolItem(e, payload)], e.clientX, e.clientY)
        else dropAsCards(e, [], payload)
      }
      return
    }
    if (!(aim.target && dropFilesOnTarget(aim.target, files)) && bare) {
      if (overRail) dealOntoRail(dropOnBareCanvas(e, files), e.clientX, e.clientY)
      else dropAsCards(e, files)
    }
  }, [dropPoolItem, dropPoolOnTarget, dropFilesOnTarget, dropOnBareCanvas, dropAsCards])

  // Card faces, block and bar headers render in App's LayerOverlay, NEXT TO
  // this container rather than inside it — so a file dropped on a card at
  // card zoom never reached the handlers above, and did nothing at all.
  // Catch drag-over/drop on the shared parent for targets OUTSIDE the
  // container and route them through the same handlers; everything inside
  // the container is React's (onDragOver/onDrop below), so it is skipped
  // here and nothing is handled twice. The native events carry the same
  // dataTransfer / clientX / preventDefault the handlers use. They come in
  // `floating`: only a real target under the overlay takes the drop.
  const dragOverRef = useRef(handleDragOver)
  dragOverRef.current = handleDragOver
  const dropRef = useRef(handleDrop)
  dropRef.current = handleDrop
  useEffect(() => {
    const host = containerRef.current?.parentElement
    if (!host) return
    const outside = (e: Event) => !containerRef.current?.contains(e.target as Node)
    const over = (e: DragEvent) => { if (outside(e)) dragOverRef.current(e as unknown as React.DragEvent, true) }
    const drop = (e: DragEvent) => { if (outside(e)) dropRef.current(e as unknown as React.DragEvent, true) }
    host.addEventListener('dragover', over)
    host.addEventListener('drop', drop)
    return () => {
      host.removeEventListener('dragover', over)
      host.removeEventListener('drop', drop)
    }
  }, [])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (isPanning.current) {
      isPanning.current = false
      return
    }
    // Clear card-level selection when clicking empty canvas (not on a card/node)
    const upTarget = e.target as Element
    if (!upTarget.closest('[data-group-card],[data-freenode]')) {
      useBoardsStore.getState().clearGroupSelection()
    }
    // Clear block-layer selection when clicking empty canvas (not on a block)
    if (!upTarget.closest('[data-layer-block]')) {
      useCanvasStore.getState().clearSelectedBlockBoardIds()
    }
    if (rbStartCanvas.current) {
      const containerRect = containerRef.current!.getBoundingClientRect()
      const rb = rubberBandRef.current
      if (rb) {
        const selLeft   = containerRect.left + Math.min(rb.sx, rb.ex)
        const selRight  = containerRect.left + Math.max(rb.sx, rb.ex)
        const selTop    = containerRect.top  + Math.min(rb.sy, rb.ey)
        const selBottom = containerRect.top  + Math.max(rb.sy, rb.ey)
        const w = selRight - selLeft
        const h = selBottom - selTop
        if (w > 5 || h > 5) {
          const hits = (el: Element) => {
            const r = el.getBoundingClientRect()
            return r.left < selRight && r.right > selLeft && r.top < selBottom && r.bottom > selTop
          }
          const isBlockZoom = currentZone() === 'block'
          if (isBlockZoom) {
            // Block zoom: select whole blocks (boards) instead of bars
            const hitBlockBoardIds = Array.from(document.querySelectorAll('[data-layer-block]'))
              .filter(hits)
              .map(el => (el as HTMLElement).dataset.layerBlock!)
              .filter(Boolean)
            if (hitBlockBoardIds.length > 0) {
              useCanvasStore.getState().setSelectedBlockBoardIds(hitBlockBoardIds)
            }
          } else {
            // Board zoom: select individual bars, grouped by board
            const hitBlocks = Array.from(document.querySelectorAll('[data-block][data-id]'))
              .filter(el => !(el as HTMLElement).hasAttribute('data-layer-block'))
              .filter(hits)
            const perBoard = new Map<string, string[]>()
            hitBlocks.forEach(el => {
              const bid = (el as HTMLElement).dataset.boardId ?? 'primary'
              const id = (el as HTMLElement).dataset.id!
              if (!perBoard.has(bid)) perBoard.set(bid, [])
              perBoard.get(bid)!.push(id)
            })
            perBoard.forEach((ids, bid) => {
              useBoardsStore.getState().setSelection(bid, ids)
            })
          }
          // Pinned nodes are excluded: the band is a canvas-space gesture,
          // and a screen-fixed panel it merely happens to sweep across is
          // not something the user was selecting.
          const nodeIds = Array.from(document.querySelectorAll('[data-freenode][data-id]:not([data-pinned])'))
            .filter(hits).map(el => (el as HTMLElement).dataset.id!)
          if (nodeIds.length > 0) setFreeSelection(nodeIds)
          // Card group hit-test
          const hitGroups = Array.from(document.querySelectorAll('[data-group-card][data-id]'))
            .filter(hits).map(el => (el as HTMLElement).dataset.id!)
          if (hitGroups.length > 0) useBoardsStore.getState().setSelectedGroups(hitGroups)
        }
      }
      rbStartCanvas.current = null
      setRubberBand(null)
    }
  }, [setFreeSelection])

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: '#12131f',
        cursor: spaceActive ? 'grab' : 'default',
      }}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onContextMenu={e => {
        if ((e.target as Element).closest('[data-block],[data-board],[data-freenode],[data-viewport3d]')) return
        e.preventDefault()
        const rect = containerRef.current!.getBoundingClientRect()
        const cx = (e.clientX - rect.left - pan.x) / zoom
        const cy = (e.clientY - rect.top - pan.y) / zoom
        setAddMenu({ sx: e.clientX, sy: e.clientY, cx, cy })
      }}
    >
      {/* ── Tilt stage: the world layers tip back together when the canvas is
             tilted (store/tiltStore). 'none' when flat — no change at all. ── */}
      <div ref={tiltStageRef} data-tilt-stage="world" style={{ position: 'absolute', inset: 0, transformOrigin: '50% 50%' }}>
      <DotGrid panX={pan.x} panY={pan.y} zoom={zoom} />

      {/* ── NLE row lines (behind everything, in canvas space) ── */}
      <NLERowBands pan={pan} zoom={zoom} />

      {/* ── Shared WebGL canvas for 3D viewport windows — painted BEFORE the
             world transform container so GL pixels sit under all canvas
             content (windows live "under" nodes/bars). ── */}
      <GLCanvasHost containerRef={containerRef} />

      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          willChange: 'transform',
        }}
      >
        {children}
      </div>
      </div>

      {/* ── Screen-pinned nodes — OUTSIDE the world transform, but the
             SAME origin `pan` is measured in, so the pin math needs no
             offset term. Not part of `children`, so LayerRouter never
             remounts them at a zoom threshold. ── */}
      <PinLayer />

      <div style={{
        position: 'absolute',
        bottom: 12,
        right: 16,
        color: 'rgba(255,255,255,0.22)',
        fontSize: 11,
        fontFamily: 'monospace',
        userSelect: 'none',
        pointerEvents: 'none',
      }}>
        {Math.round(zoom * 100)}% · {zone === 'card' ? 'Cards' : zone === 'block' ? 'Blocks' : 'Boards'} · scroll to zoom · middle-drag or space+drag to pan
      </div>

      {/* ── Rubber-band selection overlay ── */}
      {rubberBand && (
        <div style={{
          position: 'absolute',
          left: Math.min(rubberBand.sx, rubberBand.ex),
          top: Math.min(rubberBand.sy, rubberBand.ey),
          width: Math.abs(rubberBand.ex - rubberBand.sx),
          height: Math.abs(rubberBand.ey - rubberBand.sy),
          border: '1.5px solid rgba(120,170,255,0.8)',
          background: 'rgba(100,150,255,0.08)',
          borderRadius: 3,
          pointerEvents: 'none',
          zIndex: 200,
        }} />
      )}

      {/* ── Add-node context menu ── */}
      {addMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 900 }} onPointerDown={() => setAddMenu(null)} />
          <div style={{
            position: 'fixed',
            left: addMenu.sx, top: addMenu.sy,
            zIndex: 901,
            background: '#13141f',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            padding: '4px 0',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            minWidth: 160,
          }}>
            {[
              { label: '📝  Add note',  action: () => { addNodeAtCursor('note',  200, 160); setAddMenu(null) } },
              { label: 'T   Add text',  action: () => { addNodeAtCursor('text',  200, 180); setAddMenu(null) } },
              { label: '🖼  Add image', action: () => { addNodeAtCursor('image', 200, 180); setAddMenu(null) } },
              // An effect card starts as Bloom; its face switches the kind.
              // Line it up right of an image card to start a strip. Made
              // by utils/fx/createEffect, like the Effects palette's, so the
              // size lives in one table (freeNodeStore), not a copy here.
              { label: '✦  Add effect card', action: () => {
                createEffectCard('bloom', { at: { cx: addMenu.cx, cy: addMenu.cy } })
                setAddMenu(null)
              } },
              // A rail to run effect cards over docked pictures. Hung from
              // the cursor by its top-left corner — it grows right and down
              // as slots and cards go on, so that corner is the stable one.
              { label: '⟳  Add loop strip', action: () => {
                createLoopStrip({ x: addMenu.cx, y: addMenu.cy })
                setAddMenu(null)
              } },
              { label: '◆  Add Viewer', action: () => {
                useUndoCoordinator.getState().checkpoint()
                const k = createScale()
                const w = VIEWPORT3D_DEFAULT_W * k, h = VIEWPORT3D_DEFAULT_H * k
                useViewport3DStore.getState().addWindow(addMenu.cx - w / 2, addMenu.cy - h / 2)
                const wins = useViewport3DStore.getState().windows
                const newest = Object.values(wins).reduce((a, b) => (a && a.createdAt >= b.createdAt ? a : b))
                if (newest) useViewport3DStore.getState().updateWindow(newest.id, { width: w, height: h })
                setAddMenu(null)
              } },
              { label: '▦  Add Media Pool', action: () => { addNodeAtCursor('pool', 520, 420); setAddMenu(null) } },
              { label: '✎  Add Prompt Pad', action: () => { addNodeAtCursor('prompt', 460, 360); setAddMenu(null) } },
              { label: '⟲  Add History', action: () => { addNodeAtCursor('history', 260, 400); setAddMenu(null) } },
              { label: '≔  Add List', action: () => {
                const nid = addNodeAtCursor('list', 240, 440)
                if (nid) useFreeNodeStore.getState().updateFreeNode(nid, {
                  listQuery: { query: '', kind: 'all', includeCanvasItems: false, sortMode: 'creation', view: 'flat' },
                })
                setAddMenu(null)
              } },
              { label: '─────────────', action: null },
              { label: zone === 'card' ? '🎬  New Card' : '🎬  New Block',
                action: () => {
                // Shared with the top icon bar's + button — see
                // utils/canvasCreate. Two copies of this sequence would drift.
                createCardOrBoardAt({ cx: addMenu.cx, cy: addMenu.cy })
                setAddMenu(null)
              }},
            ].map((item, idx) => (
              item.action === null ? (
                <div key={idx} style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '3px 10px' }} />
              ) : (
                <div
                  key={item.label}
                  onPointerDown={e => { e.stopPropagation(); item.action!() }}
                  style={{ padding: '7px 14px', fontSize: 12, color: 'rgba(255,255,255,0.8)', cursor: 'pointer', borderRadius: 4, margin: '0 4px' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >{item.label}</div>
              )
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** NLE row bands scoped to group bounding boxes + card-level grid lines.
 *  Decorative background — can lag one frame behind a drag without the user
 *  noticing. Uses useDeferredValue so the heavy JSX work happens on idle time
 *  while the dragged card itself updates immediately. */
const NLERowBands: React.FC<{ pan: { x: number; y: number }; zoom: number }> = React.memo(({ pan, zoom }) => {
  const boards = useBoardsStore(s => s.boards)
  const groups = useBoardsStore(s => s.groups)
  // Defer the inputs so card drags don't block on rebuilding all band JSX.
  const deferredGroups = useDeferredValue(groups)
  const deferredBoards = useDeferredValue(boards)
  const BOARD_PADDING_X = 20
  const BAND_PAD = 30 // breathing room around content edges
  const isCardLevel = useZoomZone() === 'card'

  // Memoize the expensive JSX build — it only needs to change when the
  // deferred inputs (or the card-level flag) change. During a pointermove
  // burst, deferredGroups holds its previous value, so this memo hits.
  const { cardGridLines, rowBands } = useMemo(() => {
    const cardGridLines: React.ReactNode[] = []
    if (isCardLevel) {
      let minY = Infinity, maxY = -Infinity
      deferredGroups.forEach(g => {
        const gl = computeGroupLayout(g.boardIds, deferredBoards)
        if (g.originY < minY) minY = g.originY
        const bottom = g.originY + gl.totalHeight
        if (bottom > maxY) maxY = bottom
      })
      if (minY === Infinity) { minY = 0; maxY = 2000 }
      const gridTop = Math.floor((minY - 500) / CARD_GRID_SPACING) * CARD_GRID_SPACING
      const gridBottom = maxY + 1000
      for (let y = gridTop; y <= gridBottom; y += CARD_GRID_SPACING) {
        cardGridLines.push(
          <div key={`cg-${y}`} style={{
            position: 'absolute',
            left: -8000, width: 20000,
            top: y, height: 1,
            background: 'rgba(130,180,255,0.06)',
          }} />
        )
      }
    }

    const rowBands: React.ReactNode[] = []
    deferredGroups
      .filter(g => !(g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id))
      .forEach(group => {
        const layout = computeGroupLayout(group.boardIds, deferredBoards)

        let groupLeft = Infinity, groupRight = -Infinity
        group.boardIds.forEach(bid => {
          const board = deferredBoards[bid]
          if (!board) return
          const bScale = board.boardScale ?? 1
          const rootBars = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
          if (rootBars.length === 0) return
          const bx = group.originX + (board.nleX ?? 0)
          const minX = Math.min(...rootBars.map(b => b.x))
          const maxX = Math.max(...rootBars.map(b => b.x + b.width))
          const l = bx + BOARD_PADDING_X + minX * bScale
          const r = bx + BOARD_PADDING_X + maxX * bScale
          if (l < groupLeft) groupLeft = l
          if (r > groupRight) groupRight = r
        })
        if (groupLeft === Infinity) return

        groupLeft -= BAND_PAD
        groupRight += BAND_PAD
        const bandWidth = groupRight - groupLeft

        const occupiedRows = new Set<number>()
        group.boardIds.forEach(bid => {
          const b = deferredBoards[bid]
          if (b) occupiedRows.add(b.nleRow ?? 0)
        })
        const minOccupied = Math.min(...occupiedRows)
        const maxOccupied = Math.max(...occupiedRows)

        for (let idx = 0; idx < maxOccupied - minOccupied + 1; idx++) {
          const i = minOccupied + idx
          const rowTop = group.originY + getRowY(i, layout)
          const rowH = getRowHeight(i, layout)
          rowBands.push(
            <React.Fragment key={`${group.id}-${i}`}>
              {i % 2 === 0 && (
                <div style={{
                  position: 'absolute',
                  left: groupLeft, width: bandWidth,
                  top: rowTop,
                  height: rowH,
                  background: 'rgba(255,255,255,0.008)',
                  borderRadius: 6,
                }} />
              )}
              <div style={{
                position: 'absolute',
                left: groupLeft, width: bandWidth,
                top: rowTop,
                height: 1,
                background: i === minOccupied ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.03)',
              }} />
            </React.Fragment>
          )
        }
      })
    return { cardGridLines, rowBands }
  }, [deferredGroups, deferredBoards, isCardLevel])

  return (
    <div style={{
      position: 'absolute', left: 0, top: 0,
      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
      transformOrigin: '0 0',
      pointerEvents: 'none',
      willChange: 'transform',
    }}>
      {cardGridLines}
      {rowBands}
    </div>
  )
})

// World-space dots: one every DOT_SPACING canvas units, fainter in-between
// dots once zoomed in far enough (utils/dotGrid). Cards snap to them.
const DotGrid: React.FC<{ panX: number; panY: number; zoom: number }> = ({ panX, panY, zoom }) => {
  const layer = (id: string, step: number, r: number, fill: string) => {
    const s = step * zoom
    const ox = ((panX % s) + s) % s
    const oy = ((panY % s) + s) % s
    return (
      <pattern id={id} x={ox - s / 2} y={oy - s / 2} width={s} height={s} patternUnits="userSpaceOnUse">
        <circle cx={s / 2} cy={s / 2} r={r} fill={fill} />
      </pattern>
    )
  }
  const sub = dotStep(zoom)
  return (
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
      <defs>
        {layer('dot-grid', DOT_SPACING, 1.2, 'rgba(120,120,180,0.22)')}
        {sub < DOT_SPACING && layer('dot-grid-sub', sub, 0.9, 'rgba(120,120,180,0.11)')}
      </defs>
      {sub < DOT_SPACING && <rect width="100%" height="100%" fill="url(#dot-grid-sub)" />}
      <rect width="100%" height="100%" fill="url(#dot-grid)" />
    </svg>
  )
}
