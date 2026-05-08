/**
 * Card Rolodex — a vertical index of every ProjectGroup on the canvas,
 * presented as a wheel-scrollable stack of colored bars with a live preview
 * pane to the right.
 *
 * Mechanics:
 *   - 11 visible slots (5 above, 1 center, 5 below) clipped to a fixed area.
 *   - The CENTER slot is elevated and shown as the full preview card.
 *   - Mouse wheel scrolls the stack a slot at a time; CSS transitions tween
 *     translateY so cards smoothly slide up or down.
 *   - Hover on a slot only highlights its border (no preview swap).
 *   - Single-click on a slot animates the stack so that slot becomes center.
 *   - Double-click on a slot pans the canvas to the underlying card.
 *   - A `+` button enters placement mode: a mini ghost card follows the
 *     cursor; click on the canvas places it; Esc cancels.
 *
 * Toggle visibility via canvasStore.rolodexOpen. Sort mode persists.
 */
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore } from '../../store/boardsStore'
import type { ProjectGroup, BoardData } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { HeroImageLayer } from '../Layers/HeroImageLayer'
import { edgeColorFromHex } from '../../utils/colorUtils'
import { getFirstImageUrl } from '../../types/bar'

// Card width — uniform across active and tucked cards. The active card
// "rises" only via screen-Y lift (CENTER_BONUS); it's never wider than
// the others. Visual connection to the preview pane is purely via color
// (preview frame matches the active card's hue).
const SLOT_W = 180
// Width of the "wings" — vertical floor strips on the left and right of
// the card column. They form the sides of the cabinet's cutout where
// the active card's body pokes through.
const WING_W = 8
// Total left-column width: card column + wings on each side.
const LEFTCOL_W = SLOT_W + 2 * WING_W
// Each card is a TALL rectangle with a rounded top; only its top ~SLOT_PEEK_H
// shows when tucked under the next card down (the visible "tab"). The full
// CARD_H extends below into the territory the next card covers.
//
// CARD_H matches the preview pane's aspect ratio (PREVIEW_W:PREVIEW_H ≈
// 1:1.417): 180 × 1.417 ≈ 255. This makes each row feel like a real
// card-shaped object instead of a flat tab. In TREE mode the practical
// effect is dramatic — when a child indents, the parent's left strip
// (= CARD_H - sizes[i] tall) is now ~225 px instead of ~60 px, so the
// parent reads as a card sitting BEHIND the child rather than as a
// sliver of color.
const CARD_H = 255
const SLOT_PEEK_H = 30
const VISIBLE_RADIUS = 5         // slots above/below center → 11 total visible
// How far the active card's tab sits ABOVE the list area's vertical
// center, measured in SLOT_PEEK_H units. 0 = exact center, 1 = one
// tab-height above center, 2 = two. The list still scrolls smoothly
// around the float center; only the resting Y of "selected" shifts.
const ACTIVE_LIFT_SLOTS = 2.5
// Extra buffer cards rendered ABOVE visibleStart so their full body
// (CARD_H tall, but tucked tabs are only SLOT_PEEK_H) sits entirely
// above the viewport. Without this, a parent card entering the
// rendered set in tree mode would suddenly drop ~225 px of body color
// into the visible area — visible as a left-strip "pop" behind any
// indented child. With ceil(CARD_H/SLOT_PEEK_H)+1 buffer cards, the
// new card always enters above y=0 and scrolls in continuously.
// Re-derived from CARD_H so this stays correct if heights change.
const TOP_BUFFER = Math.ceil(CARD_H / SLOT_PEEK_H) + 1
// Extra buffer cards rendered BELOW visibleEnd so the slide-under
// region (where cards travel behind the cabinet base) is always
// filled. Without enough cards rendered down here, you'd see cards
// "pop in" at the bottom edge of the visible card area instead of
// sliding up smoothly from beneath the cabinet base.
const BOTTOM_BUFFER = 6
// Cabinet floor's bottom-bar height — a solid panel-floor strip that
// always sits at the very bottom of the panel. The bar's rounded top
// corners form the rounded INNER corners of the cabinet's cutout (the
// "slot" the card pokes through).
const CABINET_BAR_H = 32
// Inner radius of the cabinet's cutout — applied to the bottom bar's
// top-left + top-right corners.
const CABINET_NOTCH_RADIUS = 14
// Outer radius for the cabinet's top corners — mirror of the
// always-visible base footer's bottom-corner radius so the rising
// cabinet reads as a smaller mirrored version of that same shape.
const CABINET_OUTER_RADIUS = 6
// At its peak (the float center), each card gets this much extra height
// added to its tucked SLOT_PEEK_H. So the centered card's visible height
// reads as SLOT_PEEK_H + CENTER_BONUS, and the cards a couple of slots
// either side smoothly trail off back to plain SLOT_PEEK_H.
const CENTER_BONUS = 34
// Bell-curve falloff radius (in slot units). Asymmetric on purpose: the
// effect lasts LONGER on the below-center side so the third, fourth cards
// down are already growing toward the middle as the wheel approaches them.
// Above center the effect stays tight — cards leaving the active zone
// settle back into tucked size quickly.
const FALLOFF_RADIUS_ABOVE = 2.0
const FALLOFF_RADIUS_BELOW = 1.0
// Per-frame easing factor for the rAF tween toward target center.
// 0.065 settles in ~550–650ms — between snappy and drawn-out.
// Lower = more languorous; higher = snappier.
const TWEEN_EASE = 0.065
// Cap on per-frame motion (in slot units). Easing alone produces big
// per-frame jumps when the diff is large (rapid wheel input puts target
// many slots ahead of position) — the catch-up reads as choppy because
// each frame visibly snaps ~15+ pixels. Capping the step keeps active
// scroll smooth without affecting the settle phase, where diff is small
// enough that easing*diff is well below the cap.
const MAX_STEP_PER_FRAME = 0.35
const PREVIEW_W = 240
const PREVIEW_H = 340
const PANEL_PAD = 4
// Header strip height (CARDS title + sort/close icons + borderBottom).
// Used as a marginTop on the preview pane so its TOP aligns with the
// slot list's top (i.e., where the FIRST card's top edge sits) rather
// than the panel's top. Derived: 2px padding-top + 18px (close button is
// the tallest child) + 4px padding-bottom + 1px borderBottom = 25.
const HEADER_H = 25
// Tree-mode indent per level. Each step pushes the card's LEFT edge
// inward by this many pixels, leaving the right edge fixed — so cards
// appear to tuck under their parent as depth increases. The leftColumn
// width itself never changes; only the card narrows.
const INDENT_STEP = 12
// LIST area is the visible viewport over the stack. Cards extend below it
// (clipped by overflow) so the bottom of the stack reads as "more cards
// continuing down" rather than ending abruptly.
const LIST_AREA_H = SLOT_PEEK_H * (VISIBLE_RADIUS * 2 + 1)

/** Half-cosine bell, asymmetric: the radius below center is wider than the
 *  one above so the lift effect "trails down" the stack — cards a few slots
 *  below the active one already have a small bonus, so when the user
 *  scrolls down they appear to be growing toward the middle from earlier
 *  rather than waiting until they hit the center. 1.0 at offset 0, 0.0 at
 *  the radius edge, smooth at both endpoints. */
function bellFraction(offset: number): number {
  const radius = offset >= 0 ? FALLOFF_RADIUS_BELOW : FALLOFF_RADIUS_ABOVE
  const x = Math.abs(offset)
  if (x >= radius) return 0
  return (Math.cos(x * Math.PI / radius) + 1) / 2
}

/** Each card K, given the float center P, has a "size" — the vertical
 *  span between this card's top and the next card's top (= visible height
 *  of this card's tab when tucked). At the exact center, size peaks at
 *  SLOT_PEEK_H + CENTER_BONUS; symmetrically falls back to SLOT_PEEK_H
 *  beyond the falloff radius. The card's TOP position is the prefix-sum of
 *  sizes from card 0 up to itself, anchored so position(P) lands at the
 *  list area's center. */
function cardSize(offsetFromCenter: number): number {
  return SLOT_PEEK_H + CENTER_BONUS * bellFraction(offsetFromCenter)
}

// ─── Tree / flat list builders ─────────────────────────────────

/** A row in the rolodex list. `level` is the indent depth (0 in flat
 *  mode for everything; in tree mode 0 for root decks/standalones, 1
 *  for direct deck members or sub-deck anchors, 2+ for deeper nesting).
 *  `isDeck` flags rows that anchor at least one other group, so the
 *  renderer can paint deck-stripe indicators on the slot edge. */
type RolodexRow = { group: ProjectGroup; level: number; isDeck: boolean }

/** Defensive filter — true iff the group has at least one board with at
 *  least one valid root bar. Mirrors the canvas's validity check in
 *  CardLayer's GroupCard bounds calc; phantom groups (boardIds all
 *  resolve to missing/empty boards) are invisible on canvas, so we
 *  shouldn't list them in the Rolodex either. The boardsStore migration
 *  prunes these on load, but this check stays in place so a phantom
 *  produced at runtime — or by a future code path we haven't audited —
 *  doesn't desync the two views. */
function hasRenderableContent(g: ProjectGroup, boards: Record<string, BoardData>): boolean {
  for (const bid of g.boardIds) {
    const board = boards[bid]
    if (!board) continue
    for (const rid of board.rootIds) {
      if (board.bars[rid]) return true
    }
  }
  return false
}

/** Sort an array of groups by the active sort mode. Mutates a copy. */
function sortGroups(arr: ProjectGroup[], sortMode: 'creation' | 'alphabetical'): ProjectGroup[] {
  if (sortMode === 'alphabetical') {
    return [...arr].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }
  // 'creation' — preserve existing array order (boardsStore appends new
  // groups at the end, so this is creation order by construction).
  return [...arr]
}

/** Sort by deck-fan order: deckOffsetX ascending. The canvas's
 *  useCardDecks hook orders members by their visual rect.left, which —
 *  since every member of a deck shares the same anchor's originX —
 *  comes out the same as ordering by each member's deckOffsetX. So
 *  this matches what you see when the deck is fanned on canvas, and
 *  it stays stable regardless of the user's flat-mode sort choice. */
function sortByFanOrder(arr: ProjectGroup[]): ProjectGroup[] {
  return [...arr].sort((a, b) => (a.deckOffsetX ?? 0) - (b.deckOffsetX ?? 0))
}

/** Flat list — every group as a level-0 row, sorted by sortMode. The
 *  `isDeck` flag still tracks whether a group anchors others (so flat
 *  mode can also show deck indicators on those rows if we want). */
function buildFlatList(groups: ProjectGroup[], sortMode: 'creation' | 'alphabetical'): RolodexRow[] {
  // Build "is anchor for at least one other group" set in a single pass.
  const hasMembers = new Set<string>()
  for (const g of groups) {
    if (g.deckAnchorId && g.deckAnchorId !== g.id) hasMembers.add(g.deckAnchorId)
  }
  return sortGroups(groups, sortMode).map(g => ({
    group: g,
    level: 0,
    isDeck: hasMembers.has(g.id),
  }))
}

/** Tree list — decks (and their nested members) emitted first in DFS
 *  order, standalones at the end.
 *
 *  Sort axes (independent):
 *   - ROOTS (top-level decks + standalones) sort by `sortMode`
 *     (creation or alphabetical). This is what the user toggles via
 *     SortToggle in the header.
 *   - CHILDREN inside a deck always sort by deck-fan order
 *     (deckOffsetX ascending) regardless of sortMode, so the list
 *     matches what the user sees when fanning the deck on canvas.
 *     Sub-decks recurse with the same rule.
 *
 *  Membership model (per data-model research): each group stores a
 *  `deckAnchorId` pointing at its parent deck's anchor (or undefined /
 *  self for standalone). Sub-decks are just members that themselves
 *  anchor further members. Recursion is unbounded.
 *
 *  Edge cases handled:
 *   - Self-anchored groups (`deckAnchorId === g.id`) — treated as roots.
 *   - Cycles — `visited` guards against pathological data.
 *   - Extracted cards — keep `deckAnchorId`, so they still appear under
 *     their tethered deck in the tree. (An extracted sub-deck whose
 *     anchor was rewired to itself shows up as a fresh root deck —
 *     correct behavior, since the canvas treats it as standalone.)
 */
function buildTreeList(groups: ProjectGroup[], sortMode: 'creation' | 'alphabetical'): RolodexRow[] {
  const childMap = new Map<string, ProjectGroup[]>()
  for (const g of groups) {
    if (!g.deckAnchorId || g.deckAnchorId === g.id) continue
    const arr = childMap.get(g.deckAnchorId) ?? []
    arr.push(g)
    childMap.set(g.deckAnchorId, arr)
  }

  const visited = new Set<string>()
  const out: RolodexRow[] = []

  const emit = (g: ProjectGroup, level: number) => {
    if (visited.has(g.id)) return
    visited.add(g.id)
    const children = childMap.get(g.id) ?? []
    out.push({ group: g, level, isDeck: children.length > 0 })
    if (children.length === 0) return
    // Children inside a deck always render in deck-fan order
    // (deckOffsetX ascending), so the Rolodex slot list mirrors what
    // the user sees when they fan the deck on canvas. The user's
    // flat-mode sort mode (creation / alphabetical) only affects the
    // order of ROOTS — primary decks and standalones — never the
    // ordering of members within a deck or sub-deck.
    for (const c of sortByFanOrder(children)) emit(c, level + 1)
  }

  // Roots = groups with no parent (or self-anchored). Partition into
  // root decks (have members) vs standalones, decks first.
  const roots = groups.filter(g => !g.deckAnchorId || g.deckAnchorId === g.id)
  const rootDecks: ProjectGroup[] = []
  const standalones: ProjectGroup[] = []
  for (const g of roots) {
    if ((childMap.get(g.id) ?? []).length > 0) rootDecks.push(g)
    else standalones.push(g)
  }

  for (const d of sortGroups(rootDecks, sortMode)) emit(d, 0)
  for (const s of sortGroups(standalones, sortMode)) emit(s, 0)

  // Safety net — anything visited.has missed (e.g. orphaned member
  // whose anchor doesn't exist in `groups`). Append at level 0.
  for (const g of groups) {
    if (!visited.has(g.id)) emit(g, 0)
  }

  return out
}

// ─── Main panel ────────────────────────────────────────────────

export const CardRolodex: React.FC = () => {
  const isOpen = useCanvasStore(s => s.rolodexOpen)
  const sortMode = useCanvasStore(s => s.rolodexSortMode)
  const setSortMode = useCanvasStore(s => s.setRolodexSortMode)
  const view = useCanvasStore(s => s.rolodexView)
  const setView = useCanvasStore(s => s.setRolodexView)
  const setRolodexOpen = useCanvasStore(s => s.setRolodexOpen)
  const rolodexPos = useCanvasStore(s => s.rolodexPos)
  const setRolodexPos = useCanvasStore(s => s.setRolodexPos)
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const jumpToGroup = useCanvasStore(s => s.jumpToGroup)

  // Skip phantom groups whose boardIds all resolve to missing/empty
  // boards — the canvas already hides them (rendered as 0×0), so the
  // Rolodex would otherwise show entries that don't pan when
  // double-clicked. The boardsStore v12 migration prunes these on
  // load, but this filter stays as a runtime safety net for any
  // phantom produced after load.
  const visibleGroups = useMemo(
    () => groups.filter(g => hasRenderableContent(g, boards)),
    [groups, boards],
  )

  // ── Header drag — moves the panel by setting rolodexPos ───────
  // dragOffsetRef captures the cursor's offset from the panel's top-left
  // at pointerdown, then on pointermove we set the panel's left/top so
  // that offset is preserved (cursor stays anchored to the same spot in
  // the header). Persists via canvasStore so position survives reloads.
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null)
  const onHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    // Buttons (sort, close) own their own clicks — don't treat
    // pointerdown on them as the start of a drag.
    if ((e.target as HTMLElement).closest('button')) return
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragOffsetRef.current = {
      dx: e.clientX - rolodexPos.x,
      dy: e.clientY - rolodexPos.y,
    }
  }, [rolodexPos])
  const onHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragOffsetRef.current) return
    e.preventDefault()
    // Clamp loosely to viewport so the user can't drag the panel fully
    // offscreen and lose access to it.
    const x = Math.max(0, Math.min(window.innerWidth - 40, e.clientX - dragOffsetRef.current.dx))
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragOffsetRef.current.dy))
    setRolodexPos({ x, y })
  }, [setRolodexPos])
  const onHeaderPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragOffsetRef.current) return
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    dragOffsetRef.current = null
  }, [])

  // Build the visible row list. In 'flat' mode every group is a level-0
  // row sorted by sortMode. In 'tree' mode decks come first with their
  // members nested by indent level, then standalones at the end. The
  // sortMode is applied to siblings within each branch. Operates on
  // visibleGroups so phantom groups never reach the builders.
  const rows = useMemo(() => (
    view === 'tree'
      ? buildTreeList(visibleGroups, sortMode)
      : buildFlatList(visibleGroups, sortMode)
  ), [visibleGroups, sortMode, view])

  // ── Smooth-scroll center model ─────────────────────────────────
  //
  // Two pieces of state, neither in React proper:
  //   targetRef    — the integer index the rolodex wants to land on. Each
  //                  wheel tick or click bumps this. Always an integer
  //                  (snapped) so the preview pane has a definite target.
  //   positionRef  — the FLOAT center position currently rendered. An rAF
  //                  loop eases it toward targetRef each frame.
  //
  // Float offset (per card) = idx - positionRef.current. Lift bell-curves
  // off that float, so cards near the moving center are at partial lift
  // values during the tween — that's the "growing toward middle" feel.
  //
  // We force-render via a counter ref so React picks up positionRef
  // changes without copying the float into reactive state on every frame.
  const targetRef = useRef(0)
  const positionRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const [, forceRender] = useState(0)
  const bumpRender = useCallback(() => forceRender(n => (n + 1) & 0xffff), [])

  const tick = useCallback(() => {
    rafRef.current = null
    const diff = targetRef.current - positionRef.current
    if (Math.abs(diff) < 0.005) {
      // Snap to target — rounding error pile-up makes the float never
      // exactly equal the target without this nudge.
      if (positionRef.current !== targetRef.current) {
        positionRef.current = targetRef.current
        bumpRender()
      }
      return
    }
    // Easing — dominates the settle phase (small diff → tiny step).
    // For rapid wheel input the diff can be many slots, which would
    // produce big per-frame jumps without the cap. MAX_STEP_PER_FRAME
    // limits the motion to a smooth visible delta.
    const easedStep = diff * TWEEN_EASE
    const step = Math.sign(easedStep) * Math.min(Math.abs(easedStep), MAX_STEP_PER_FRAME)
    positionRef.current += step
    bumpRender()
    rafRef.current = requestAnimationFrame(tick)
  }, [bumpRender])

  const startTween = useCallback(() => {
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tick)
    }
  }, [tick])

  // Cancel any in-flight rAF on unmount so we don't leak frames after close.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  // Clamp target if the list shrinks beneath us.
  useEffect(() => {
    if (rows.length === 0) {
      targetRef.current = 0
      positionRef.current = 0
      bumpRender()
      return
    }
    const max = rows.length - 1
    if (targetRef.current > max) {
      targetRef.current = max
      startTween()
    }
  }, [rows.length, bumpRender, startTween])

  // ── Wheel scroll ──
  // One wheel tick = one row of TARGET advance. The eased rAF loop handles
  // the visual smoothness, so no throttle needed: even rapid spins read as
  // a fluid roll because the position keeps chasing whatever target the
  // wheel last landed on.
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (rows.length === 0) return
    const dir = e.deltaY > 0 ? 1 : -1
    const max = rows.length - 1
    targetRef.current = Math.max(0, Math.min(max, targetRef.current + dir))
    startTween()
  }, [rows.length, startTween])

  const onSlotClick = useCallback((idx: number) => {
    targetRef.current = idx
    startTween()
  }, [startTween])

  const onSlotDoubleClick = useCallback((g: ProjectGroup) => {
    jumpToGroup(g.id)
  }, [jumpToGroup])

  // ── Placement mode ──
  const [isPlacing, setIsPlacing] = useState(false)
  const startPlacement = useCallback(() => setIsPlacing(true), [])

  if (!isOpen) return null

  // Round the float position to pick the preview card. Snaps at 0.5 between
  // adjacent indices, which is the natural moment for the preview to swap.
  const centerPosition = positionRef.current
  const previewIndex = Math.round(centerPosition)
  const centerGroup = rows[previewIndex]?.group ?? null

  // ── Lay out the visible stack via prefix-sums ─────────────
  // Each card's "size" (visible height of its top tab) is a bell-bonus around
  // the fractional center. We prefix-sum sizes to get card top positions.
  // Then we shift the whole stack so that the FRACTIONAL center P lands at
  // a fixed Y in the list area — this is what gives "during a tween, the
  // active card grows toward center" since multiple cards' sizes are in
  // partial bonus simultaneously.
  // TOP_BUFFER extra cards above so their bodies sit above the viewport;
  // BOTTOM_BUFFER extra cards below so the slide-under-cabinet region
  // is populated and cards smoothly emerge from / disappear behind the
  // cabinet base instead of popping at the visible edge.
  const visibleStart = Math.max(0, Math.floor(centerPosition - VISIBLE_RADIUS - TOP_BUFFER))
  const visibleEnd   = Math.min(rows.length - 1, Math.ceil(centerPosition + VISIBLE_RADIUS + BOTTOM_BUFFER))
  const visibleIndices: number[] = []
  for (let k = visibleStart; k <= visibleEnd; k++) visibleIndices.push(k)

  const sizes = visibleIndices.map(k => cardSize(k - centerPosition))

  // Cumulative card-top positions, anchor-pending.
  const rawTops: number[] = []
  let acc = 0
  for (const s of sizes) {
    rawTops.push(acc)
    acc += s
  }

  // Where the FRACTIONAL center P sits in raw coordinates: between two
  // integer indices, interpolated by frac.
  const Pfloor = Math.floor(centerPosition)
  const Pfrac = centerPosition - Pfloor
  const PfloorIdxInVisible = Pfloor - visibleStart
  let PfracRawY = 0
  if (PfloorIdxInVisible >= 0 && PfloorIdxInVisible < rawTops.length) {
    PfracRawY = rawTops[PfloorIdxInVisible] + Pfrac * sizes[PfloorIdxInVisible]
  }

  // Anchor: put P's center-of-tab at LIST_AREA_H / 2 - SLOT_PEEK_H / 2 so
  // the tab itself is centered in the visible viewport — then shift the
  // active card UP by ACTIVE_LIFT_SLOTS * SLOT_PEEK_H so it sits a bit
  // above center, leaving more of the upcoming stack visible below.
  const anchorY = LIST_AREA_H / 2 - SLOT_PEEK_H / 2 - ACTIVE_LIFT_SLOTS * SLOT_PEEK_H
  const yShift = anchorY - PfracRawY

  // ── Cabinet "floor" geometry ─────────────────────────────────
  // The cabinet is rendered as wings (left, right) + a bottom bar with
  // rounded top corners. Together they form a cutout in the middle where
  // the active card's body shows through. When cards run out below the
  // active, the cabinet rises into the listArea so the wings + cutout
  // become visible above the bar.
  //
  // Geometry:
  //   - Notch height (the empty wing-only band above the bar) is small —
  //     just CABINET_NOTCH_RADIUS. That puts the bar's top INTO the
  //     active card's body region so its rounded corners visually "carve"
  //     rounded bottoms into the card. The card peeks up through the
  //     curve, sells the illusion that the slot has a rounded inside
  //     edge that the card protrudes through.
  //   - Bar height = whatever remains of the cabinet's total height after
  //     the notch — grows tall when the cabinet is tall (end of list),
  //     shrinks to 0 when there's no cabinet rise (mid-list).
  //
  // The floor's TOP smoothly tracks the bottom-most visible card. At the
  // end of the list, that bottom is the active's lifted-tab bottom, so
  // the floor rises high. When many cards are below the active, the
  // bottom-most card's bottom is near LIST_AREA_H, so the floor stays
  // near the bottom.
  //
  // Important: ACTIVE_LIFT_SLOTS pulls the active card up, which means
  // mid-list the bottom-most VISIBLE card's tab bottom can fall ABOVE
  // LIST_AREA_H (there are unrendered cards continuing below the visible
  // window — they just live past the buffer). Without correction, the
  // cabinet would render mid-list and bob with each scroll tick as the
  // bell-curve tween shifts the visible rows. We virtually extend the
  // bottom by `cardsBelow * SLOT_PEEK_H` so the cabinet only triggers
  // when there's nothing left to scroll into view from below.
  let bottomMostCardBottom = 0
  for (let i = 0; i < visibleIndices.length; i++) {
    const cardBottom = (rawTops[i] + yShift) + sizes[i]
    if (cardBottom > bottomMostCardBottom) bottomMostCardBottom = cardBottom
  }
  const cardsBelowVisible = Math.max(0, (rows.length - 1) - visibleEnd)
  const effectiveBottom = bottomMostCardBottom + cardsBelowVisible * SLOT_PEEK_H
  const floorTopMin = anchorY + SLOT_PEEK_H + CENTER_BONUS
  const cabinetFloorTop = Math.max(floorTopMin, Math.min(LIST_AREA_H, effectiveBottom))
  const cabinetH = LIST_AREA_H - cabinetFloorTop
  // Notch height = just enough wing-only band that the bar's rounded
  // corners (radius CABINET_NOTCH_RADIUS) are exposed; the bar then sits
  // ~CABINET_NOTCH_RADIUS pixels INSIDE the card's body so its rounded
  // top corners overlap and "round off" the card's bottom.
  const notchH = Math.min(CABINET_NOTCH_RADIUS, cabinetH)
  const barH = cabinetH - notchH
  const isAtEndOfList = rows.length > 0 && previewIndex === rows.length - 1

  return (
    <>
      <div
        data-rolodex
        onWheel={onWheel}
        // Stop pan/clicks from leaking to the canvas behind the panel.
        onPointerDown={e => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: rolodexPos.x,
          top: rolodexPos.y,
          background: 'rgba(20,22,38,0.96)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 8,
          padding: PANEL_PAD,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 4,
          fontFamily: 'inherit',
          zIndex: 900,
          userSelect: 'none',
        }}
      >
        {/* ── Left column: header + slot list + cabinet floor ──
              Width is LEFTCOL_W (SLOT_W + 2*WING_W) so cards can sit
              centered with the cabinet's side wings (WING_W each side)
              flanking them. The visual link to the preview pane comes
              from matching colors (preview frame uses the active card's
              color). */}
        <div style={{
          width: LEFTCOL_W,
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
        }}>
          {/* Header — also acts as the drag handle for the whole panel.
              Pointer events on buttons short-circuit the drag (see
              onHeaderPointerDown), so the close + sort icons still click
              normally. */}
          <div
            onPointerDown={onHeaderPointerDown}
            onPointerMove={onHeaderPointerMove}
            onPointerUp={onHeaderPointerUp}
            onPointerCancel={onHeaderPointerUp}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              // Horizontal padding = WING_W so the title's left edge and the
              // icons' right edge line up with the cards' left/right edges
              // below (cards are inset by WING_W inside the leftColumn).
              padding: `2px ${WING_W}px 4px`,
              borderBottom: '1px solid rgba(255,255,255,0.05)',
              cursor: 'move',
              touchAction: 'none',
            }}
          >
            <span style={{
              color: 'rgba(255,255,255,0.85)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.5px',
            }}>CARDS</span>
            <div style={{ display: 'flex', gap: 3 }}>
              <ViewToggle mode={view} setMode={setView} />
              <SortToggle mode={sortMode} setMode={setSortMode} />
              <CloseButton onClick={() => setRolodexOpen(false)} />
            </div>
          </div>

          {/* Slot list. Cards live inside; cabinet-floor wings + bar are
              also positioned absolute on top, forming the cutout the
              active card pokes through. The wrapper height is extended
              by CABINET_BAR_H to include the always-visible base — that
              way cards rendered past LIST_AREA_H are clipped at the
              panel's actual bottom (LIST_AREA_H + CABINET_BAR_H),
              giving us the slide-under-cabinet effect when cards
              travel through the bottom edge. The base itself sits
              absolute inside, with a high z-index so it visually
              hides any cards passing behind. */}
          <div style={{
            position: 'relative',
            width: LEFTCOL_W,
            height: LIST_AREA_H + CABINET_BAR_H,
            overflow: 'hidden',
            borderBottomLeftRadius: CABINET_OUTER_RADIUS,
            borderBottomRightRadius: CABINET_OUTER_RADIUS,
          }}>
            {rows.length === 0 ? (
              <EmptyState onAdd={startPlacement} />
            ) : (
              <>
                {visibleIndices.map((idx, i) => {
                  const row = rows[idx]
                  const offset = idx - centerPosition
                  return (
                    <RolodexSlot
                      key={row.group.id}
                      group={row.group}
                      level={row.level}
                      isDeck={row.isDeck}
                      offset={offset}
                      top={rawTops[i] + yShift}
                      zIndex={idx + 1}
                      onClick={() => onSlotClick(idx)}
                      onDoubleClick={() => onSlotDoubleClick(row.group)}
                    />
                  )
                })}

                {/* ── Cabinet floor ──────────────────────────────────
                      Wings on each side (full cabinet height) + a bottom
                      bar with rounded top corners that forms the rounded
                      INNER edge of the cutout. The active card's body
                      shows through the empty notch between the wings,
                      above the bar.
                      cabinetFloorTop is computed from the bottom-most
                      visible card, so this whole block smoothly rises
                      as cards run out below the active. */}
                {cabinetH > 0 && (
                  <>
                    {/* Left wing — rounded TOP-OUTER corner mirrors the
                          panel-base footer's rounded BOTTOM-LEFT corner so
                          the rising cabinet reads as a smaller version of
                          the same shape, peeking up from below. */}
                    <div style={{
                      position: 'absolute',
                      left: 0,
                      top: cabinetFloorTop,
                      width: WING_W,
                      height: cabinetH,
                      background: 'rgba(8,9,16,1)',
                      borderTopLeftRadius: CABINET_OUTER_RADIUS,
                      zIndex: 200,
                      pointerEvents: 'none',
                    }} />
                    {/* Right wing — mirrors the footer's bottom-right. */}
                    <div style={{
                      position: 'absolute',
                      right: 0,
                      top: cabinetFloorTop,
                      width: WING_W,
                      height: cabinetH,
                      background: 'rgba(8,9,16,1)',
                      borderTopRightRadius: CABINET_OUTER_RADIUS,
                      zIndex: 200,
                      pointerEvents: 'none',
                    }} />
                    {/* Bottom bar — its top sits ~CABINET_NOTCH_RADIUS px
                          ABOVE where the card's body ends, so the rounded
                          top corners overlap into the card. The card's
                          flat bottom is hidden behind the bar; the curves
                          that bite out of the bar's top corners read as
                          the card's OWN rounded bottom corners poking up
                          through the cabinet slot. Bar height grows with
                          the cabinet to fill all the way to the listArea
                          bottom with no gap. */}
                    {barH > 0 && (
                      <div style={{
                        position: 'absolute',
                        left: WING_W,
                        top: cabinetFloorTop + notchH,
                        width: SLOT_W,
                        height: barH,
                        background: 'rgba(8,9,16,1)',
                        borderTopLeftRadius: notchH > 0 ? CABINET_NOTCH_RADIUS : 0,
                        borderTopRightRadius: notchH > 0 ? CABINET_NOTCH_RADIUS : 0,
                        boxShadow: 'inset 0 6px 10px -6px rgba(0,0,0,0.7)',
                        zIndex: 200,
                        pointerEvents: 'none',
                      }} />
                    )}
                  </>
                )}
              </>
            )}
            {/* Cabinet base — sits at the bottom of the slot-list
                wrapper, full LEFTCOL_W width. Higher z-index than any
                card (cards top out around 60) but compatible with the
                cabinet wings/bar at z=200. Cards traveling past
                LIST_AREA_H are still rendered (until they're clipped
                at LIST_AREA_H + CABINET_BAR_H) but visually hidden
                behind this strip — that's the slide-under effect. */}
            <div style={{
              position: 'absolute',
              left: 0,
              top: LIST_AREA_H,
              width: LEFTCOL_W,
              height: CABINET_BAR_H,
              background: 'rgba(8,9,16,1)',
              zIndex: 200,
              pointerEvents: 'none',
            }} />
          </div>

          {/* + Place new card — temporarily hidden per spec; placement
              mode wiring (PlacementGhost, isPlacing, etc.) is left in
              place and can be re-enabled by restoring this footer
              with the original button.
              <div style={{ ... }}><button onClick={startPlacement}>+</button></div>
          */}
        </div>

        {/* ── Right column: preview pane (only when there's a center card) ──
              Wrapped so we can push the preview's TOP down by HEADER_H,
              keeping it aligned with the slot list (which sits beneath
              the leftColumn's header). Without this margin, the preview
              would sit flush with the panel top and look "ahead" of the
              first card. */}
        {centerGroup && (
          <div style={{ marginTop: HEADER_H }}>
            <CardPreview group={centerGroup} />
          </div>
        )}
      </div>

      {/* Cursor-follow ghost card during placement mode (rendered globally) */}
      {isPlacing && (
        <PlacementGhost onDone={() => setIsPlacing(false)} />
      )}
    </>
  )
}

// ─── Slot ─────────────────────────────────────────────────────

const RolodexSlot: React.FC<{
  group: ProjectGroup
  /** Tree depth — 0 in flat mode for everything, and in tree mode 0 for
   *  root decks/standalones, 1 for direct deck members or sub-deck
   *  anchors, 2+ for cards inside sub-decks. Each step pushes the card's
   *  LEFT edge inward by INDENT_STEP and narrows the card by the same
   *  amount; the right edge stays put. */
  level: number
  /** True if this row anchors at least one other group (deck or sub-deck).
   *  Drives the "deck-stripe" indicators on the right edge of the tab. */
  isDeck: boolean
  /** Fractional offset against the live float center, used only for
   *  visual-emphasis math (rim brightness, shadow strength, glow). The
   *  actual TOP position is computed by the parent via prefix-sum so the
   *  card-stack spacing comes out correct. */
  offset: number
  /** Final screen-Y top position of this card, post-shift. */
  top: number
  /** Stacking order — higher index = higher z so each card down covers
   *  the previous card's bottom (the "tucked under" look). */
  zIndex: number
  onClick: () => void
  onDoubleClick: () => void
}> = ({ group, level, isDeck, offset, top, zIndex, onClick, onDoubleClick }) => {
  const [isHovered, setIsHovered] = useState(false)

  // Continuous "centerness" used to tween visual emphasis (rim, shadow,
  // glow) from "lit center" → "tucked tab". 1.0 at exact center, 0.0 at
  // |offset| ≥ 1.0. Independent of the size bell so the visual treatment
  // has a tighter peak than the geometric growth.
  const centerness = Math.max(0, 1 - Math.abs(offset))


  // ── Visual emphasis (scales with centerness) ─────────────────
  // Single multiplier, used to tween every center-related visual cue. With
  // `centerness` updating each rAF frame, every effect interpolates per
  // frame — no CSS transitions needed and the lift / shadow / glow / rim
  // all "grow into" the center together.
  const lit = centerness

  // Border lerps from dark hairline (tucked) to bright white rim (centered).
  // Both the color and the width grow with lit.
  const borderRGB = Math.round(255 * lit)
  const borderAlpha = 0.28 + (0.92 - 0.28) * lit
  const borderWidth = 1 + 0.5 * lit
  const borderStyle = isHovered
    ? '1.5px solid rgba(255,255,255,0.85)'
    : `${borderWidth}px solid rgba(${borderRGB},${borderRGB},${borderRGB},${borderAlpha})`

  // Composite shadows. Each component has a base value (always present) and
  // a center-only addition that scales with lit. So the center has the full
  // elevated treatment; tucked cards still have the subtle overlap+contact
  // pair; everything in between is a smooth blend.
  const glowAlpha = 0.30 * lit
  const glowSpread = 2 * lit
  const upShadowBlur = 6 + 8 * lit
  const upShadowAlpha = 0.45 + 0.10 * lit
  const downShadowOffset = 1 + 5 * lit
  const downShadowBlur = 2 + 16 * lit
  const downShadowAlpha = 0.30 + 0.20 * lit
  const contactAlpha = 0.30 + 0.05 * lit
  const shadows: string[] = []
  if (lit > 0.01) {
    shadows.push(`0 0 0 ${glowSpread}px ${edgeColorFromHex(group.color, glowAlpha)}`)
  }
  shadows.push(`0 -2px ${upShadowBlur}px -2px rgba(0,0,0,${upShadowAlpha})`)
  shadows.push(`0 ${downShadowOffset}px ${downShadowBlur}px -1px rgba(0,0,0,${downShadowAlpha})`)
  shadows.push(`0 2px 4px rgba(0,0,0,${contactAlpha})`)

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={lit > 0.5
        ? `${group.name || 'Untitled'} — double-click to pan canvas`
        : `${group.name || 'Untitled'} — click to view`}
      style={{
        position: 'absolute',
        // Cards sit centered inside the leftColumn — offset by WING_W so
        // the cabinet wings flank them on both sides. In tree mode each
        // indent level pushes the LEFT edge inward by INDENT_STEP and
        // narrows the card by the same amount (right edge stays fixed),
        // so deeper-nested cards visually tuck under their parents.
        left: WING_W + level * INDENT_STEP,
        top,
        width: SLOT_W - level * INDENT_STEP,
        height: CARD_H,
        background: group.color,
        // Rounded on all four corners — now that CARD_H is tall enough
        // for the bottom to read as a real card edge in tree mode (the
        // indented child reveals it), matching the rounded TOP keeps the
        // card-shaped silhouette consistent. The cabinet still hides
        // bottoms at end-of-list and the next card hides them mid-list,
        // so rounding the bottom is purely a tree-mode visual win.
        borderRadius: 7,
        border: borderStyle,
        boxShadow: shadows.join(', '),
        cursor: 'pointer',
        // No CSS transition on `top` / shadows: the rAF tween drives
        // centerness + top per frame, so each render already shows the
        // smoothed value. Doubling that with CSS transitions would lag the
        // motion. We keep a tiny border transition for the snap-on hover.
        transition: 'border-color 0.10s linear',
        zIndex,
        overflow: 'hidden',
      }}
    >
      {/* Subtle top→bottom highlight gradient. The center version (lit=1)
            shows a slightly stronger top sheen + faint bottom darkening so
            the exposed body looks 3D; tucked cards get a fainter version. */}
      <div style={{
        position: 'absolute',
        inset: 0,
        background: `linear-gradient(180deg,
          rgba(255,255,255,${0.06 + 0.04 * lit}) 0%,
          rgba(255,255,255,${0.02 * lit}) 30%,
          rgba(0,0,0,${0.04 + 0.02 * lit}) 100%)`,
        pointerEvents: 'none',
      }} />
      {/* Deck-stripe indicators — two thin vertical bars on the inner
            right edge of the tab, mimicking the layered "cards behind"
            look on canvas decks. Only rendered when this row anchors at
            least one other group. */}
      {isDeck && (
        <div style={{
          position: 'absolute',
          top: 5,
          right: 5,
          height: SLOT_PEEK_H - 10,
          display: 'flex',
          gap: 1.5,
          pointerEvents: 'none',
        }}>
          <div style={{ width: 2.5, height: '100%', background: 'rgba(0,0,0,0.42)', borderRadius: '1.5px 1.5px 0 0' }} />
          <div style={{ width: 2.5, height: '100%', background: 'rgba(0,0,0,0.26)', borderRadius: '1.5px 1.5px 0 0' }} />
        </div>
      )}
      {/* Content lives in the top SLOT_PEEK_H "tab" region. Right-pad
            extra when deck-stripes are showing so the title's ellipsis
            doesn't run under them. */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: SLOT_PEEK_H,
        display: 'flex',
        alignItems: 'center',
        padding: isDeck ? '0 18px 0 10px' : '0 10px',
        boxSizing: 'border-box',
      }}>
        <span style={{
          color: 'rgba(255,255,255,0.97)',
          fontSize: 11,
          fontWeight: 600,
          textShadow: '0 1px 2px rgba(0,0,0,0.55)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}>{group.name || 'Untitled'}</span>
      </div>
    </div>
  )
}

// ─── Preview pane ──────────────────────────────────────────────

const CardPreview: React.FC<{ group: ProjectGroup }> = ({ group }) => {
  // Resolve the hero image with the same fallback chain CardLayer uses on
  // canvas: prefer group.cardHeroImage, otherwise scan the group's boards
  // and their root bars for the first image embedded in bar content. Many
  // cards (e.g. deck anchors like "Location" inside Pelagia IX) keep their
  // image at the bar level rather than as an explicit group.cardHeroImage,
  // and without this fallback the preview pane would render empty.
  const boards = useBoardsStore(s => s.boards)
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

  return (
    <div
      key={group.id}                                          // key swap → fade-in on change
      style={{
        width: PREVIEW_W,
        height: PREVIEW_H,
        background: group.color,
        borderRadius: 10,
        boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
        position: 'relative',
        overflow: 'hidden',
        animation: 'rolodex-fade-in 0.18s ease-out',
      }}
    >
      <style>{`
        @keyframes rolodex-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      {/* Hero image at low-ish opacity so the color tint shows. Uses the
            resolved heroImage (group OR bar-content fallback), matching
            how the canvas card resolves its hero in CardLayer.tsx. */}
      {heroImage && (
        <HeroImageLayer
          heroImage={heroImage}
          transform={group.cardHeroTransform}
          borderRadius={10}
        />
      )}
      {/* Header band — group name */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        padding: '14px 14px 10px',
        background: `linear-gradient(180deg, rgba(0,0,0,0.35), transparent)`,
        zIndex: 2,
      }}>
        {group.cardHeaderText && (
          <div style={{
            color: 'rgba(255,255,255,0.6)',
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: '0.6px',
            textTransform: 'uppercase',
            marginBottom: 4,
          }}>{group.cardHeaderText}</div>
        )}
        <div style={{
          color: 'rgba(255,255,255,0.97)',
          fontSize: 22,
          fontWeight: 800,
          textShadow: '0 2px 6px rgba(0,0,0,0.6)',
          lineHeight: 1.05,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{group.name || 'Untitled'}</div>
      </div>
      {/* Bottom band — summary */}
      {group.cardSummary && (
        <div style={{
          position: 'absolute',
          bottom: 0, left: 0, right: 0,
          padding: '10px 14px 12px',
          background: `linear-gradient(0deg, rgba(0,0,0,0.55), transparent)`,
          color: 'rgba(255,255,255,0.92)',
          fontSize: 11,
          fontWeight: 600,
          textShadow: '0 1px 4px rgba(0,0,0,0.7)',
          zIndex: 2,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {group.cardSummary}
        </div>
      )}
    </div>
  )
}

// ─── Placement-mode ghost card ────────────────────────────────

const PlacementGhost: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const armedRef = useRef(false)

  // Group-creation effect callback runs on placement-confirm (click on canvas).
  const placeAt = useCallback((clientX: number, clientY: number) => {
    const cs = useCanvasStore.getState()
    const canvasX = (clientX - cs.pan.x) / cs.zoom
    const canvasY = (clientY - cs.pan.y) / cs.zoom

    // Create a fresh group at the canvas position. Reuses createGroup with
    // a default board so the new group has something to anchor to.
    const bs = useBoardsStore.getState()
    useUndoCoordinator.getState().checkpoint()
    const newBoardId = bs.createBoard(0, 0)
    const newGroupId = bs.createGroup('New Card', [newBoardId])
    bs.setGroupPos(newGroupId, canvasY, canvasX)
  }, [])

  useEffect(() => {
    // Arm on next frame so the click that opened placement mode (the +
    // button click) doesn't immediately re-trigger placement.
    const id = requestAnimationFrame(() => { armedRef.current = true })
    const onMove = (e: PointerEvent) => {
      setPos({ x: e.clientX, y: e.clientY })
    }
    const onClick = (e: PointerEvent) => {
      if (!armedRef.current) return
      // Cancel if the click is on the rolodex panel itself.
      const t = e.target as Element | null
      if (t?.closest('[data-rolodex]')) {
        onDone()
        return
      }
      e.stopPropagation()
      e.preventDefault()
      placeAt(e.clientX, e.clientY)
      onDone()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onDone()
      }
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('click', onClick, true)   // capture so we land first
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(id)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onDone, placeAt])

  if (!pos) return null

  return ReactDOM.createPortal(
    <>
      {/* Cursor-following ghost card */}
      <div
        style={{
          position: 'fixed',
          left: pos.x + 6,
          top: pos.y + 6,
          width: 90,
          height: 60,
          background: 'rgba(91, 141, 217, 0.4)',
          border: '1.5px dashed rgba(180, 210, 255, 0.85)',
          borderRadius: 6,
          pointerEvents: 'none',
          zIndex: 9999,
          boxShadow: '0 4px 16px rgba(0,0,0,0.45)',
          transition: 'left 0.04s linear, top 0.04s linear',
        }}
      />
      {/* Hint label */}
      <div style={{
        position: 'fixed',
        left: pos.x + 102,
        top: pos.y + 30,
        background: 'rgba(20,22,38,0.92)',
        color: 'rgba(255,255,255,0.85)',
        padding: '4px 9px',
        borderRadius: 4,
        fontSize: 10,
        fontFamily: 'inherit',
        pointerEvents: 'none',
        zIndex: 9999,
        whiteSpace: 'nowrap',
      }}>Click to place · Esc to cancel</div>
    </>,
    document.body,
  )
}

// ─── Misc subcomponents ────────────────────────────────────────

/** Tiny toggle that flips the rolodex between flat list and tree view.
 *  Sits to the LEFT of SortToggle in the header. Same shape/sizing as
 *  the sort + close buttons so the three icons read as a row. */
const ViewToggle: React.FC<{
  mode: 'flat' | 'tree'
  setMode: (m: 'flat' | 'tree') => void
}> = ({ mode, setMode }) => (
  <button
    onClick={() => setMode(mode === 'flat' ? 'tree' : 'flat')}
    title={mode === 'flat' ? 'View: flat list — click to switch to tree' : 'View: deck tree — click to switch to flat'}
    style={{
      background: 'transparent',
      border: '1px solid rgba(255,255,255,0.16)',
      color: 'rgba(255,255,255,0.7)',
      borderRadius: 3,
      padding: '1px 5px',
      fontSize: 10,
      fontWeight: 700,
      cursor: 'pointer',
      fontFamily: 'inherit',
      lineHeight: 1,
    }}
  >{mode === 'flat' ? '≡' : '⊽'}</button>
)

const SortToggle: React.FC<{
  mode: 'creation' | 'alphabetical'
  setMode: (m: 'creation' | 'alphabetical') => void
}> = ({ mode, setMode }) => (
  <button
    onClick={() => setMode(mode === 'creation' ? 'alphabetical' : 'creation')}
    title={mode === 'creation' ? 'Sort: creation order — click to switch' : 'Sort: alphabetical — click to switch'}
    style={{
      background: 'transparent',
      border: '1px solid rgba(255,255,255,0.16)',
      color: 'rgba(255,255,255,0.7)',
      borderRadius: 3,
      padding: '1px 5px',
      fontSize: 8,
      fontWeight: 700,
      letterSpacing: '0.4px',
      cursor: 'pointer',
      fontFamily: 'inherit',
      lineHeight: 1.4,
    }}
  >{mode === 'creation' ? '#' : 'A→Z'}</button>
)

const CloseButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    onClick={onClick}
    title="Hide Cards panel"
    style={{
      background: 'transparent',
      border: '1px solid rgba(255,255,255,0.16)',
      color: 'rgba(255,255,255,0.7)',
      borderRadius: 3,
      width: 18,
      height: 18,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 11,
      lineHeight: 1,
      cursor: 'pointer',
      fontFamily: 'inherit',
    }}
  >×</button>
)

const EmptyState: React.FC<{ onAdd: () => void }> = ({ onAdd }) => (
  <div style={{
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
    textAlign: 'center',
    padding: 16,
    gap: 6,
  }}>
    <div>No cards yet</div>
    <button
      onClick={onAdd}
      style={{
        background: 'rgba(120,170,255,0.18)',
        border: '1px solid rgba(120,170,255,0.4)',
        color: 'rgba(255,255,255,0.85)',
        borderRadius: 6,
        padding: '4px 12px',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >Place your first card</button>
  </div>
)
