import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'
import { useBoardsStore } from './boardsStore'
import { useFreeNodeStore } from './freeNodeStore'
import { computeGroupLayout, getRowY, getRowHeight } from '../utils/nleRows'
import { DEFAULT_H } from '../utils/barConstants'
import {
  type DrawSurface,
  DEFAULT_PEN_COLOR,
  DEFAULT_PEN_SIZE,
} from '../types/stroke'

// Hard zoom-out stop. Note this is BELOW CARD_FLOOR_ZOOM (0.11, in
// NLETimelineHeader) — that's the "comfortable widest" reference where
// the card chrome looks today; between MIN_ZOOM and CARD_FLOOR_ZOOM the
// chrome scales down uniformly (via overviewScale) so the whole card
// shrinks coherently instead of the headers/badges ballooning.
export const MIN_ZOOM = 0.045
export const MAX_ZOOM = 4
const APP_TOOLBAR_H = 38
const BOARD_PADDING_X = 20

// ── Animated camera jumps ────────────────────────────────────────
// Module-level rAF handle for the in-flight jump animation. Pan-
// affecting setters (setPan, shiftPan, setZoom, zoomAtPoint) call
// cancelJumpAnim() before applying their change so a user gesture
// always interrupts an animation cleanly. The animation itself
// writes pan via `set` directly (NOT via setPan) to avoid cancelling
// itself.
let jumpAnimRaf: number | null = null
function cancelJumpAnim() {
  if (jumpAnimRaf !== null) {
    cancelAnimationFrame(jumpAnimRaf)
    jumpAnimRaf = null
  }
}
// Standard cubic ease-in-out — smoothstep curve. Slow start, faster
// middle, slow end. 0 at t=0, 1 at t=1.
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}
const JUMP_ANIM_MS = 420

type CanvasSetFn = {
  (partial: object): void
}

function animatePanTo(
  target: { x: number; y: number },
  set: CanvasSetFn,
  get: () => { pan: { x: number; y: number } },
) {
  cancelJumpAnim()
  const start = get().pan
  const dx = target.x - start.x
  const dy = target.y - start.y
  // Already there (or close enough) — snap and skip the animation.
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
    set({ pan: target })
    return
  }
  const startedAt = performance.now()
  const tick = () => {
    const t = Math.min(1, (performance.now() - startedAt) / JUMP_ANIM_MS)
    const k = easeInOutCubic(t)
    set({ pan: { x: start.x + dx * k, y: start.y + dy * k } })
    if (t < 1) {
      jumpAnimRaf = requestAnimationFrame(tick)
    } else {
      jumpAnimRaf = null
    }
  }
  jumpAnimRaf = requestAnimationFrame(tick)
}

/** A card's bounds in canvas units — mirrors GroupCard's geometry math.
 *  Null when the card has nothing in it to measure. */
export function groupBounds(groupId: string): { x: number; y: number; w: number; h: number } | null {
  const bs = useBoardsStore.getState()
  const group = bs.groups.find(g => g.id === groupId)
  if (!group) return null
  const layout = computeGroupLayout(group.boardIds, bs.boards)
  let minX = Infinity, maxX = -Infinity, topY = Infinity, bottomY = -Infinity
  for (const bid of group.boardIds) {
    const board = bs.boards[bid]
    if (!board) continue
    const bScale = board.boardScale ?? 1
    const roots = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
    if (roots.length === 0) continue
    const bx = group.originX + (board.nleX ?? 0)
    const by = group.originY + getRowY(board.nleRow ?? 0, layout)
    const rowH = getRowHeight(board.nleRow ?? 0, layout)
    const rootH = Math.max(...roots.map(b => b.height), DEFAULT_H) * bScale
    const visualH = Math.max(rowH, rootH)
    const lo = Math.min(...roots.map(b => b.x))
    const hi = Math.max(...roots.map(b => b.x + b.width))
    const l = bx + BOARD_PADDING_X + lo * bScale - 16
    const r = bx + BOARD_PADDING_X + hi * bScale + 16
    if (l < minX) minX = l
    if (r > maxX) maxX = r
    if (by < topY) topY = by
    if (by + visualH > bottomY) bottomY = by + visualH
  }
  if (minX === Infinity) return null

  const finalW = Math.max(maxX - minX, group.cardWidthOverride ?? 0)
  const finalH = Math.max(bottomY - topY, group.cardHeightOverride ?? 0)
  return { x: minX, y: topY, w: finalW, h: finalH }
}

interface CanvasStore {
  pan: { x: number; y: number }
  zoom: number
  boardPos: { x: number; y: number }
  nleRowHeight: number
  dynamicRowHeights: boolean
  focusedBoardId: string | null
  selectedBlockBoardIds: string[]
  /** IDs of extracted cards whose ghost slot is currently selected. Pressing
   *  Delete/Backspace severs each one (parent's ghostSlots entry removed). */
  selectedGhostGroupIds: string[]
  /** Deck.id whose preview affordance icon is currently hovered. Drives the
   *  open-footprint preview outlines AND the icon's full "active" highlight.
   *  Set/cleared by the dashed-rect icon's own enter/leave handlers. */
  previewHoveredDeckId: string | null
  /** Deck.id whose card body is currently hovered (any surface other than
   *  the affordance icon). Drives a SOFT hint glow on the affordance icon —
   *  a subtle nudge that the affordance is there. Distinct from
   *  previewHoveredDeckId so the soft hint and the full open-preview never
   *  fire from the same hover. */
  cardHoveredDeckId: string | null
  /** Group.id of a card that's currently being dragged out of a fanned deck
   *  (between the 30px threshold and pointerup). While set:
   *   - The fan wrapper renders the card itself at strip-equivalent z-index
   *     so it slides out from between the layers instead of disappearing
   *     behind the entire fan.
   *   - CardLayer's main loop skips rendering this card, since the fan
   *     owns it during the drag.
   *  Cleared on pointerup, after which the card transitions to its normal
   *  z-index 40 standalone render. */
  extractingCardId: string | null
  /** Active stack ↔ fan transition. While set, FannedDeckOverlay's strips
   *  imperatively animate (sliding out from the primary card on 'fanning',
   *  collapsing back into it on 'stacking'). For 'stacking', CardLayer
   *  keeps rendering the FannedDeckOverlay even though deck.state has
   *  already flipped to 'stacked' — the overlay needs to stay alive for
   *  the closing animation duration. */
  fanTransition: {
    deckId: string                   // id of the transitioning deck
    phase: 'fanning' | 'stacking'    // direction
  } | null
  /** When non-null, the user is in draw / annotation mode on this surface.
   *  Pointer events on the surface paint strokes; the floating DrawToolbar
   *  is visible. Click-outside / Esc / Done button clears it. */
  drawSurface: DrawSurface | null
  drawTool: 'pen' | 'eraser'
  drawColor: string
  drawSize: number
  /** Card Rolodex panel visibility — toggleable, persisted. */
  rolodexOpen: boolean
  /** Sort mode for the rolodex list. Persisted across sessions. */
  rolodexSortMode: 'creation' | 'alphabetical'
  /** View mode for the rolodex list — 'flat' shows every group as a row,
   *  'tree' nests decks → sub-decks → cards with indentation. Each deck
   *  level adds an indent step. Independent from rolodexSortMode (sort
   *  applies to roots in 'flat', and to siblings within each tree branch
   *  in 'tree'). Persisted. */
  rolodexView: 'flat' | 'tree'
  /** Display mode for the active card in the Rolodex.
   *  - 'auto':    today's behavior — active stays compact until the
   *    panel passes the "all tabs fit" threshold, then it grows.
   *  - 'compact': active never grows past its peek tab; dragging the
   *    panel just reveals more rows as tabs.
   *  - 'full':    active grows immediately as the panel opens and
   *    locks at full hero size once there's room for it. Further
   *    panel growth past that reveals additional peek tabs. */
  rolodexDisplayMode: 'auto' | 'compact' | 'full'
  /** Extra pixels added to the active card's visible tab in the Rolodex.
   *  0 = compact (just-the-name, peek-tab view); when larger, the active
   *  slot grows downward to reveal more of the card content (hero image,
   *  header text, summary). The bottom of the panel becomes a drag
   *  handle that adjusts this value. Capped at CARD_H - SLOT_PEEK_H -
   *  CENTER_BONUS so the active slot tops out at the full card size. */
  rolodexExpansion: number
  /** Top-left position of the floating rolodex panel (screen px), persisted
   *  so it stays where the user dragged it across reloads. Header acts as
   *  the drag handle. */
  rolodexPos: { x: number; y: number }
  /** Set of group IDs whose children are hidden in the Rolodex tree view.
   *  Toggled by the caret on deck rows. Only meaningful in 'tree' view. */
  rolodexCollapsedDeckIds: string[]
  /** The one `list` free node the toolbar's Cards button drives. A
   *  POINTER, not a flag on the node: a flag gets DUPLICATED by paste and
   *  by project insert, and two homes is unrecoverable. A DANGLING
   *  pointer self-heals via ensureRolodexHome(), which is why the
   *  wholesale node-map replacements need no knowledge of it. */
  homeRolodexId: string | null
  setHomeRolodexId: (id: string | null) => void
  /** Deck-portal selections: anchorId → memberId. When set, a click on a
   *  fanned member "locks" that member's content onto the anchor's face,
   *  so the primary card acts as a view-only portal for the member. The
   *  selection is session-only (not persisted) — it's an editor view
   *  state, not data. Cleared on Esc, click-empty-canvas, or selecting
   *  the same member again (toggle off). */
  deckPortalSelections: Record<string, string>

  setPan: (pan: { x: number; y: number }) => void
  setZoom: (zoom: number) => void
  shiftPan: (dx: number, dy: number) => void
  zoomAtPoint: (factor: number, mx: number, my: number) => void
  setBoardPos: (pos: { x: number; y: number }) => void
  shiftBoardPos: (dx: number, dy: number) => void
  setNleRowHeight: (h: number) => void
  toggleDynamicRowHeights: () => void
  setFocusedBoard: (id: string | null) => void
  setSelectedBlockBoardIds: (ids: string[]) => void
  clearSelectedBlockBoardIds: () => void
  setSelectedGhostGroupIds: (ids: string[]) => void
  clearSelectedGhostGroupIds: () => void
  setPreviewHoveredDeckId: (id: string | null) => void
  setCardHoveredDeckId: (id: string | null) => void
  setExtractingCardId: (id: string | null) => void
  setFanTransition: (t: CanvasStore['fanTransition']) => void
  /** Pan (keeping current zoom) so the given group is centered in the viewport. */
  jumpToGroup: (groupId: string) => void
  jumpToFreeNode: (nodeId: string) => void
  /** Glide so this canvas point lands in the middle of the view. */
  jumpToPoint: (x: number, y: number) => void
  // ── Annotation / draw mode ──
  setDrawSurface: (s: DrawSurface | null) => void
  setDrawTool: (t: 'pen' | 'eraser') => void
  setDrawColor: (c: string) => void
  setDrawSize: (n: number) => void
  // ── Card Rolodex ──
  toggleRolodex: () => void
  setRolodexOpen: (open: boolean) => void
  setRolodexSortMode: (mode: 'creation' | 'alphabetical') => void
  setRolodexView: (mode: 'flat' | 'tree') => void
  setRolodexDisplayMode: (mode: 'auto' | 'compact' | 'full') => void
  setRolodexPos: (pos: { x: number; y: number }) => void
  setRolodexExpansion: (px: number) => void
  toggleRolodexDeckCollapsed: (groupId: string) => void
  setDeckPortal: (anchorId: string, memberId: string) => void
  clearDeckPortal: (anchorId: string) => void
  clearAllDeckPortals: () => void
  toggleDeckPortal: (anchorId: string, memberId: string) => void
}

export const useCanvasStore = create<CanvasStore>()(persist((set, get) => ({
  pan: { x: 0, y: 0 },
  zoom: 1,
  boardPos: { x: 0, y: 0 },
  nleRowHeight: 300,
  dynamicRowHeights: false,
  focusedBoardId: null,
  selectedBlockBoardIds: [],
  selectedGhostGroupIds: [],
  previewHoveredDeckId: null,
  cardHoveredDeckId: null,
  extractingCardId: null,
  fanTransition: null,
  drawSurface: null,
  drawTool: 'pen',
  drawColor: DEFAULT_PEN_COLOR,
  drawSize: DEFAULT_PEN_SIZE,
  rolodexOpen: false,
  rolodexSortMode: 'creation',
  rolodexView: 'flat',
  rolodexDisplayMode: 'auto',
  rolodexPos: { x: 12, y: 60 },
  // Default to 34 — the historical "compact, popped active, no images" look.
  // Drag up to reach super-collapsed (expansion = 0, all tabs uniform); drag
  // down to see the active card grow and below-stack images fade in.
  rolodexExpansion: 34,
  rolodexCollapsedDeckIds: [],
  homeRolodexId: null,
  deckPortalSelections: {},

  setPan: (pan) => { cancelJumpAnim(); set({ pan }) },

  setZoom: (zoom) => { cancelJumpAnim(); set({ zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)) }) },

  shiftPan: (dx, dy) => {
    cancelJumpAnim()
    set(s => ({ pan: { x: s.pan.x + dx, y: s.pan.y + dy } }))
  },

  zoomAtPoint: (factor, mx, my) => {
    cancelJumpAnim()
    const { zoom, pan } = get()
    let newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor))
    if (Math.abs(newZoom - zoom) < 1e-8) return
    const ratio = newZoom / zoom
    set({
      zoom: newZoom,
      pan: {
        x: mx - (mx - pan.x) * ratio,
        y: my - (my - pan.y) * ratio,
      },
    })
  },

  setBoardPos: (boardPos) => set({ boardPos }),

  shiftBoardPos: (dx, dy) =>
    set(s => ({ boardPos: { x: s.boardPos.x + dx, y: s.boardPos.y + dy } })),

  setNleRowHeight: (nleRowHeight) => set({ nleRowHeight }),

  toggleDynamicRowHeights: () => set(s => ({ dynamicRowHeights: !s.dynamicRowHeights })),

  setFocusedBoard: (focusedBoardId) => set({ focusedBoardId }),

  setSelectedBlockBoardIds: (selectedBlockBoardIds) => set({ selectedBlockBoardIds }),
  clearSelectedBlockBoardIds: () => set({ selectedBlockBoardIds: [] }),

  setSelectedGhostGroupIds: (selectedGhostGroupIds) => set({ selectedGhostGroupIds }),
  clearSelectedGhostGroupIds: () => set({ selectedGhostGroupIds: [] }),

  setPreviewHoveredDeckId: (previewHoveredDeckId) => set({ previewHoveredDeckId }),

  setCardHoveredDeckId: (cardHoveredDeckId) => set({ cardHoveredDeckId }),

  setExtractingCardId: (extractingCardId) => set({ extractingCardId }),

  setFanTransition: (fanTransition) => set({ fanTransition }),

  setDrawSurface: (drawSurface) => set({ drawSurface }),
  setDrawTool: (drawTool) => set({ drawTool }),
  setDrawColor: (drawColor) => set({ drawColor }),
  setDrawSize: (drawSize) => set({ drawSize }),

  toggleRolodex: () => set(s => ({ rolodexOpen: !s.rolodexOpen })),
  setRolodexOpen: (rolodexOpen) => set({ rolodexOpen }),
  setRolodexSortMode: (rolodexSortMode) => set({ rolodexSortMode }),
  setRolodexView: (rolodexView) => set({ rolodexView }),
  setRolodexDisplayMode: (rolodexDisplayMode) => set({ rolodexDisplayMode }),
  setRolodexPos: (rolodexPos) => set({ rolodexPos }),
  setHomeRolodexId: (homeRolodexId) => set({ homeRolodexId }),
  setRolodexExpansion: (rolodexExpansion) => set({ rolodexExpansion }),
  toggleRolodexDeckCollapsed: (groupId) => set(s => {
    const set_ = new Set(s.rolodexCollapsedDeckIds)
    if (set_.has(groupId)) set_.delete(groupId)
    else set_.add(groupId)
    return { rolodexCollapsedDeckIds: [...set_] }
  }),
  setDeckPortal: (anchorId, memberId) => set(s => ({
    deckPortalSelections: { ...s.deckPortalSelections, [anchorId]: memberId },
  })),
  clearDeckPortal: (anchorId) => set(s => {
    if (!(anchorId in s.deckPortalSelections)) return s
    const next = { ...s.deckPortalSelections }
    delete next[anchorId]
    return { deckPortalSelections: next }
  }),
  clearAllDeckPortals: () => set(s => (
    Object.keys(s.deckPortalSelections).length === 0
      ? s
      : { deckPortalSelections: {} }
  )),
  toggleDeckPortal: (anchorId, memberId) => set(s => {
    const current = s.deckPortalSelections[anchorId]
    const next = { ...s.deckPortalSelections }
    if (current === memberId) {
      delete next[anchorId]
    } else {
      next[anchorId] = memberId
    }
    return { deckPortalSelections: next }
  }),

  jumpToGroup: (groupId) => {
    const bs = useBoardsStore.getState()
    const group = bs.groups.find(g => g.id === groupId)
    if (!group) return
    // A pinned card is already on screen and its originX/originY still point
    // at the empty spot it left behind, so panning there would fly the canvas
    // to nothing while the card the user asked to see sat where it always
    // was. Select it instead — "go to it" is already satisfied.
    if (group.pin) {
      bs.setSelectedGroup(groupId)
      return
    }

    const b = groupBounds(groupId)
    if (!b) return // nothing to center on
    const centerCX = b.x + b.w / 2
    const centerCY = b.y + b.h / 2

    const z = get().zoom
    const vpW = window.innerWidth
    const vpH = window.innerHeight - APP_TOOLBAR_H
    const targetPan = {
      x: vpW / 2 - centerCX * z,
      y: vpH / 2 - centerCY * z,
    }
    animatePanTo(targetPan, set, get)
  },

  jumpToFreeNode: (nodeId) => {
    // Lazy import avoids a module cycle at load (freeNodeStore has no
    // canvasStore import, but keep the dependency one-directional at
    // module-eval time anyway).
    const n = useFreeNodeStore.getState().nodes[nodeId]
    // Panning the world so a SCREEN coordinate lands centred is a jump to
    // nowhere — and this is reachable straight from a Rolodex row click.
    if (!n || n.pin) return
    const z = get().zoom
    const vpW = window.innerWidth
    const vpH = window.innerHeight - APP_TOOLBAR_H
    animatePanTo({
      x: vpW / 2 - (n.x + n.width / 2) * z,
      y: vpH / 2 - (n.y + n.height / 2) * z,
    }, set, get)
  },

  jumpToPoint: (x, y) => {
    const z = get().zoom
    animatePanTo({
      x: window.innerWidth / 2 - x * z,
      y: (window.innerHeight - APP_TOOLBAR_H) / 2 - y * z,
    }, set, get)
  },
}), {
  name: 'vidbars-canvas',
  storage: createDebouncedIDBStorage(400),
  partialize: (s) => ({
    pan: s.pan,
    zoom: s.zoom,
    boardPos: s.boardPos,
    nleRowHeight: s.nleRowHeight,
    dynamicRowHeights: s.dynamicRowHeights,
    // Tool preferences persist across reloads; the active drawSurface does not.
    drawColor: s.drawColor,
    drawSize: s.drawSize,
    rolodexOpen: s.rolodexOpen,
    rolodexSortMode: s.rolodexSortMode,
    rolodexView: s.rolodexView,
    rolodexDisplayMode: s.rolodexDisplayMode,
    rolodexPos: s.rolodexPos,
    rolodexExpansion: s.rolodexExpansion,
    rolodexCollapsedDeckIds: s.rolodexCollapsedDeckIds,
    homeRolodexId: s.homeRolodexId,
  }),
  version: 2,
  migrate: (persisted: any, version: number) => {
    if (version < 2) {
      // Rolodex CENTER_BONUS folded into the expansion range. Old
      // rolodexExpansion = 0 meant "active popped up by 34 px (compact)";
      // new rolodexExpansion = 0 means "super-collapsed, active flat with
      // peeks". Shift persisted values up by 34 to preserve appearance.
      if (typeof persisted.rolodexExpansion === 'number') {
        persisted.rolodexExpansion += 34
      }
    }
    return persisted
  },
}))

// Dev-only: expose the running store on `window` so debugging tooling
// (preview_eval, devtools console) can reach the SAME instance the app
// uses. Same reasoning + production-guard as window.useBoardsStore.
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  ;(window as unknown as { useCanvasStore: typeof useCanvasStore }).useCanvasStore = useCanvasStore
}
