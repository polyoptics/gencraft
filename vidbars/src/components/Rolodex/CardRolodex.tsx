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
import { useLinkDragStore } from '../../store/linkDragStore'
import { HeroImageLayer } from '../Layers/HeroImageLayer'
import { edgeColorFromHex } from '../../utils/colorUtils'
import { getFirstImageUrl } from '../../types/bar'
import {
  DEFAULT_HEADER_STYLE,
  DEFAULT_BODY_STYLE,
  type TextStyle,
} from '../../store/freeNodeStore'
import { ensureFontLoaded, hexToRgba } from '../UI/TextFormatToolbar'

// Card width — uniform across active and tucked cards. The active card
// "rises" only via vertical growth (expansion); it's never wider than
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
// Anticipation bell peak amplitude on cards just below the active slot.
// Both BASE and GROWTH are scaled by expansionFraction in the slot
// formula, so the bell fully VANISHES at super-collapsed (expansion = 0).
// That keeps the super-collapsed look strictly uniform — all tabs at
// SLOT_PEEK_H, no growth anywhere — while still letting the bell reach
// a substantial PEEK_BONUS + PEEK_BONUS_GROWTH = 45 px amplitude at
// full expansion. BASE is 0 so super-collapsed is clean; GROWTH = 45
// is the full-expansion target.
const PEEK_BONUS = 0
const PEEK_BONUS_GROWTH = 45
// Bell radius for the anticipation effect, in slot units. Radius 1 =
// the bell fades to 0 by offset 2 (only the first below-card affected).
// At full expansion the radius grows to BELOW_BELL_RADIUS_BASE +
// BELOW_BELL_RADIUS_GROWTH so the bell stretches across more cards —
// 3 total when the panel is fully expanded. Top-stack behaviour is
// unchanged (no bell there).
const BELOW_BELL_RADIUS_BASE = 1
const BELOW_BELL_RADIUS_GROWTH = 2
// How far the below stack overlaps into the active card's visible
// bottom, in pixels. The first below-card's top sits BELOW_OVERLAP px
// HIGHER than the active card's full visible bottom would put it,
// reading visually as the lower list "stepping up" onto the active
// card's lower edge.
const BELOW_OVERLAP = 15
// Per-frame easing factor for the rAF tween toward target center.
// 0.065 settles in ~550–650ms — between snappy and drawn-out.
// Lower = more languorous; higher = snappier. This is the COMPACT-mode
// baseline; the actual easing used per-frame divides this by an
// expansion-dependent slowdown (see EXPANSION_SLOWDOWN_FACTOR) so the
// tween takes longer when the active card is large — the transit card
// has to cover activeSize px per integer step (up to 255 at full
// expansion vs 64 compact), and slowing the tween proportionally keeps
// its visible pixel velocity in a comfortable range.
const TWEEN_EASE = 0.065
// Cap on per-frame motion (in slot units). Easing alone produces big
// per-frame jumps when the diff is large (rapid wheel input puts target
// many slots ahead of position) — the catch-up reads as choppy because
// each frame visibly snaps ~15+ pixels. Capping the step keeps active
// scroll smooth without affecting the settle phase, where diff is small
// enough that easing*diff is well below the cap. Like TWEEN_EASE this
// is the compact baseline; the actual per-frame cap shrinks
// proportionally with expansion.
const MAX_STEP_PER_FRAME = 0.35
// How much to slow the tween at MAX_EXPANSION, relative to compact.
// At expansion = 0 the slowdown is 1 (no change). At MAX_EXPANSION the
// effective easing is TWEEN_EASE / EXPANSION_SLOWDOWN_FACTOR and the
// step cap is MAX_STEP_PER_FRAME / EXPANSION_SLOWDOWN_FACTOR, so the
// integer-to-integer tween takes EXPANSION_SLOWDOWN_FACTOR× longer.
// 1.6 is "a little bit longer" — at full expansion the integer-step
// tween settles in ~1.15 s vs ~720 ms compact. Bigger values feel
// sluggish; activeSize quadruples from compact (64) to full (255) so a
// full proportional slowdown would be 4× and read as molasses.
const EXPANSION_SLOWDOWN_FACTOR = 1.6
// Padding between the outer panel border and the leftColumn content.
// 0 lets the FRAME (header + side rails + cabinet base) touch the
// panel's rounded outer edges directly — they ARE the panel's visible
// silhouette, no separate border line needed.
const PANEL_PAD = 0
// Colors for the rolodex "frame" — the dark casing that wraps the
// cards on all four sides (header at top, side rails on the left/
// right, cabinet at bottom). Lifted a few notches from pure dark so
// the frame reads as a real surface rather than a hole, and the
// inset highlights become genuinely visible against it.
const FRAME_COLOR  = 'rgba(28,33,52,1)'
const PANEL_BG     = 'rgba(20,22,38,0.97)'
const PANEL_RADIUS = 8
// Frame-edge accents. The inset HIGHLIGHT is a 1-px warm-light line
// on each frame piece's inner edge — a small bevel that makes the
// cabinet read as a constructed surface, not a flat fill. The outer
// SHADOW lets the frame drop softly onto the cards behind it so
// they sit "sunken" into the casing. Each piece composes its own
// shadow direction (header → down, rails → inward, cabinet → up).
const FRAME_HIGHLIGHT = 'rgba(255,255,255,0.12)'
const FRAME_SHADOW    = 'rgba(0,0,0,0.50)'
// Header strip height was previously used as a marginTop on a separate
// preview pane. The pane has been folded into the in-row expansion
// (cards grow via the drag handle), so that constant is no longer
// needed. If the preview pane ever returns, the derivation was:
// 2px padding-top + 18px (close button tallest child) + 4px
// padding-bottom + 1px borderBottom = 25.
// Tree-mode indent per level. Each step pushes the card's LEFT edge
// inward by this many pixels. The card keeps its full SLOT_W width —
// so its RIGHT edge overhangs past the panel into the canvas area for
// any non-zero indent. The slot-list wrapper uses clip-path to allow
// horizontal overflow specifically for this overhang.
const INDENT_STEP = 12
// How far cards can overhang past the slot-list wrapper's right edge,
// in pixels. Sets the clip-path's right inset (negative value =
// extends the visible region rightward). 500 covers anything reasonable
// — even at 40 indent levels (way more than ever happens) cards stay
// within this allowance.
const OVERHANG_ALLOWANCE = 500
// LIST area is the visible viewport over the stack. Cards extend below it
// (clipped by overflow) so the bottom of the stack reads as "more cards
// continuing down" rather than ending abruptly. The compact value is the
// list area when rolodexExpansion = 0. The actual height in the component
// = LIST_AREA_H_COMPACT + rolodexExpansion (panel grows downward when the
// user drags the bottom).
const LIST_AREA_H_COMPACT = SLOT_PEEK_H * (VISIBLE_RADIUS * 2 + 1)
// Small permanent height bonus on the active card even at the
// "super-collapsed" end of the expansion range, so the user can
// always tell which row is selected without an image / size jump.
// 4 px gives a clear "lift" while keeping the list reading as
// uniform tabs.
const COLLAPSED_BONUS = 4
// Maximum expansion in pixels that affects the ACTIVE CARD's height.
// At rolodexExpansion = MAX_EXPANSION, activeSize equals CARD_H — the
// active fills its full height and can't reveal more content.
// activeSize = SLOT_PEEK_H + COLLAPSED_BONUS + clamp(0, MAX_EXPANSION,
// rolodexExpansion).
const MAX_EXPANSION = CARD_H - SLOT_PEEK_H - COLLAPSED_BONUS
// Past MAX_EXPANSION the cabinet keeps moving down (LIST_AREA_H keeps
// growing), but only to REVEAL MORE BELOW-STACK CARDS — bell amplitude,
// image fade, and active size all stay at their MAX_EXPANSION values.
// This caps how far the user can drag past full so the panel never
// gets absurdly tall.
const PANEL_GROWTH_MAX = LIST_AREA_H_COMPACT
const MAX_EXPANSION_TOTAL = MAX_EXPANSION + PANEL_GROWTH_MAX
// Negative expansion = drag-to-CLOSE: the panel shrinks toward zero
// height, eventually leaving just the header above the cabinet base.
// LIST_AREA_H clamps at 0 when rolodexExpansion reaches MIN_EXPANSION.
const MIN_EXPANSION = -LIST_AREA_H_COMPACT

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
function buildTreeList(
  groups: ProjectGroup[],
  sortMode: 'creation' | 'alphabetical',
  collapsedDeckIds: Set<string>,
): RolodexRow[] {
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
    // Collapsed deck — emit the deck row itself but skip its children.
    // Sub-decks deeper inside a collapsed deck are also skipped via
    // this short-circuit (no recursion).
    if (collapsedDeckIds.has(g.id)) return
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

  // Safety net — emit any truly orphaned member (its anchor is NOT
  // present in `groups`, so the main pass had no way to reach it).
  // Crucially, we do NOT emit children of decks that ARE present
  // but happen to be collapsed — the main pass deliberately skipped
  // them, and re-emitting at level 0 would flatten the hierarchy
  // every time the user collapsed a deck.
  const groupIdSet = new Set(groups.map(g => g.id))
  for (const g of groups) {
    if (visited.has(g.id)) continue
    const hasPresentAnchor =
      g.deckAnchorId && g.deckAnchorId !== g.id && groupIdSet.has(g.deckAnchorId)
    if (hasPresentAnchor) continue
    emit(g, 0)
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
  const displayMode = useCanvasStore(s => s.rolodexDisplayMode)
  const setDisplayMode = useCanvasStore(s => s.setRolodexDisplayMode)
  const setRolodexOpen = useCanvasStore(s => s.setRolodexOpen)
  const rolodexPos = useCanvasStore(s => s.rolodexPos)
  const setRolodexPos = useCanvasStore(s => s.setRolodexPos)
  const rolodexExpansion = useCanvasStore(s => s.rolodexExpansion)
  const setRolodexExpansion = useCanvasStore(s => s.setRolodexExpansion)

  // List-area height grows / shrinks linearly with rolodexExpansion,
  // clamped to 0 at the closed extreme. The drag handle moves the
  // bottom of the panel by exactly the drag delta — drag UP past
  // super-collapsed and the panel shrinks toward closed; drag DOWN
  // past MAX_EXPANSION and the panel keeps growing to reveal more
  // below-stack cards.
  const LIST_AREA_H = Math.max(0, LIST_AREA_H_COMPACT + rolodexExpansion)
  // activeGrowth + expansionFraction are computed AFTER rows is built
  // so we can scale the phase-2 threshold to the list's actual row
  // count (see compactThreshold below). For long lists that fully
  // fill the compact view, the threshold is 0 — same as before. For
  // short lists, the threshold is negative so the active card starts
  // growing earlier (the moment the panel is tall enough to show all
  // tabs at peek height).
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const jumpToGroup = useCanvasStore(s => s.jumpToGroup)

  // Search filter — controls the header input. Filters the list by
  // group name. Tree-mode preserves ancestry: if any descendant matches,
  // its anchor chain is kept too so the user sees the full deck context.
  const [searchQuery, setSearchQuery] = useState('')

  // Skip phantom groups whose boardIds all resolve to missing/empty
  // boards — the canvas already hides them (rendered as 0×0), so the
  // Rolodex would otherwise show entries that don't pan when
  // double-clicked. The boardsStore v12 migration prunes these on
  // load, but this filter stays as a runtime safety net for any
  // phantom produced after load.
  const renderableGroups = useMemo(
    () => groups.filter(g => hasRenderableContent(g, boards)),
    [groups, boards],
  )

  // Apply the search filter on top of renderableGroups. A group is
  // kept if (a) its own name matches, or (b) any of its descendants
  // match — so a search for a child still surfaces the parent deck.
  const visibleGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return renderableGroups
    const nameMatch = (g: ProjectGroup) => (g.name || '').toLowerCase().includes(q)
    // Set of group ids whose own name matches the query.
    const matched = new Set<string>()
    for (const g of renderableGroups) {
      if (nameMatch(g)) matched.add(g.id)
    }
    if (matched.size === 0) return [] as ProjectGroup[]
    // For each match, walk up its anchor chain and include each
    // ancestor so the deck/sub-deck hierarchy survives the filter.
    const byId = new Map(renderableGroups.map(g => [g.id, g] as const))
    const keep = new Set<string>(matched)
    for (const id of matched) {
      let cur = byId.get(id)
      while (cur && cur.deckAnchorId && cur.deckAnchorId !== cur.id) {
        const parent = byId.get(cur.deckAnchorId)
        if (!parent || keep.has(parent.id)) break
        keep.add(parent.id)
        cur = parent
      }
    }
    return renderableGroups.filter(g => keep.has(g.id))
  }, [renderableGroups, searchQuery])

  // Pre-resolve hero images for every renderable group so slots can
  // show a thumbnail-sized version of the actual card image in the
  // tab area (fades in with `lit`/centerness). Same fallback chain
  // the canvas + preview use: explicit `group.cardHeroImage` first,
  // then the first image found in any of the group's boards' root
  // bars. One pass over the (small) groups list per groups/boards
  // change keeps this cheap.
  const heroImageMap = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const g of visibleGroups) {
      if (g.cardHeroImage) { map.set(g.id, g.cardHeroImage); continue }
      let img: string | null = null
      for (const bid of g.boardIds) {
        const board = boards[bid]
        if (!board) continue
        for (const rid of board.rootIds) {
          const found = getFirstImageUrl(board.bars[rid]?.content)
          if (found) { img = found; break }
        }
        if (img) break
      }
      map.set(g.id, img)
    }
    return map
  }, [visibleGroups, boards])

  // ── Header drag — moves the panel by setting rolodexPos ───────
  // Panel-wide drag. Pointerdown anywhere on the panel — header empty
  // space, side rails, panel background between/below cards — moves the
  // window. Skipped targets: buttons (own clicks), cards (their handlers
  // stopPropagation), cabinet handle (stopPropagation), the search
  // input (special-cased so click-to-focus still works and click-and-
  // drag still moves the panel). Persists position via canvasStore so
  // it survives reloads.
  const onPanelPointerDown = useCallback((e: React.PointerEvent) => {
    // Don't leak to the canvas behind the panel.
    e.stopPropagation()
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('button')) return

    const startX = e.clientX
    const startY = e.clientY
    const startPanelX = rolodexPos.x
    const startPanelY = rolodexPos.y
    const isInput = target.tagName === 'INPUT'
    let dragging = false

    if (!isInput) {
      // Non-input target: start drag immediately. preventDefault keeps
      // the cursor from selecting text on side rails or panel bg.
      e.preventDefault()
      dragging = true
    }
    // For input: don't preventDefault — let focus and text-selection
    // work normally. We escalate to drag only after the cursor moves
    // past a 4-px threshold, at which point we blur the input.

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        const dxAbs = Math.abs(ev.clientX - startX)
        const dyAbs = Math.abs(ev.clientY - startY)
        if (dxAbs * dxAbs + dyAbs * dyAbs <= 16) return
        if (isInput) target.blur()
        dragging = true
      }
      const x = Math.max(0, Math.min(window.innerWidth - 40, startPanelX + ev.clientX - startX))
      const y = Math.max(0, Math.min(window.innerHeight - 40, startPanelY + ev.clientY - startY))
      setRolodexPos({ x, y })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [rolodexPos, setRolodexPos])

  // Double-click the header to toggle the panel between CLOSED
  // (rolodexExpansion = MIN_EXPANSION; only header + cabinet visible)
  // and a previous open state. If there's no previous state stored,
  // restore to the default "compact" expansion (= 34, the historical
  // popped-active no-images point).
  const previousExpansionRef = useRef<number | null>(null)
  const DEFAULT_OPEN_EXPANSION = 34
  const onHeaderDoubleClick = useCallback((e: React.MouseEvent) => {
    // Buttons + the search input own their own clicks (toggle view /
    // sort / close, text-select inside the search field).
    const target = e.target as HTMLElement
    if (target.closest('button')) return
    if (target.tagName === 'INPUT') return
    const current = useCanvasStore.getState().rolodexExpansion
    if (current <= MIN_EXPANSION) {
      // Re-open: restore last open state, or fall back to compact.
      setRolodexExpansion(previousExpansionRef.current ?? DEFAULT_OPEN_EXPANSION)
    } else {
      // Close: remember current, then collapse to MIN.
      previousExpansionRef.current = current
      setRolodexExpansion(MIN_EXPANSION)
    }
  }, [setRolodexExpansion])

  // ── Bottom-edge expansion drag ─────────────────────────────────
  // The cabinet base doubles as a vertical-resize handle. Pointer-down
  // captures the start Y + start expansion value; pointer-move computes
  // delta and updates rolodexExpansion (clamped to [0, MAX_EXPANSION]).
  // The panel grows DOWNWARD with the user's pointer — the cabinet base
  // visually tracks the cursor, like grabbing a drawer pull.
  //
  const expandDragRef = useRef<{ startY: number; startExpansion: number } | null>(null)
  const onExpandPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    // Block bubble so the panel-level pan drag doesn't also engage.
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    expandDragRef.current = { startY: e.clientY, startExpansion: rolodexExpansion }
  }, [rolodexExpansion])
  const onExpandPointerMove = useCallback((e: React.PointerEvent) => {
    if (!expandDragRef.current) return
    e.preventDefault()
    const dy = e.clientY - expandDragRef.current.startY
    // Clamp range:
    //   MIN_EXPANSION (drag UP to close the panel) →
    //   contentMaxExpansionRef.current (drag DOWN limit).
    // The DOWN limit is dynamic — for short lists it locks at "all
    // cards visible + active fully grown" so the cabinet doesn't keep
    // pulling into empty space. For long lists it falls back to the
    // original MAX_EXPANSION_TOTAL ceiling.
    const next = Math.max(MIN_EXPANSION, Math.min(contentMaxExpansionRef.current, expandDragRef.current.startExpansion + dy))
    setRolodexExpansion(next)
  }, [setRolodexExpansion])
  const onExpandPointerUp = useCallback((e: React.PointerEvent) => {
    if (!expandDragRef.current) return
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    expandDragRef.current = null
  }, [])

  // Build the visible row list. In 'flat' mode every group is a level-0
  // row sorted by sortMode. In 'tree' mode decks come first with their
  // members nested by indent level, then standalones at the end. The
  // sortMode is applied to siblings within each branch. Operates on
  // visibleGroups so phantom groups never reach the builders.
  const collapsedDeckIds = useCanvasStore(s => s.rolodexCollapsedDeckIds)
  const toggleDeckCollapsed = useCanvasStore(s => s.toggleRolodexDeckCollapsed)
  const collapsedDeckIdSet = useMemo(() => new Set(collapsedDeckIds), [collapsedDeckIds])
  const rows = useMemo(() => (
    view === 'tree'
      ? buildTreeList(visibleGroups, sortMode, collapsedDeckIdSet)
      : buildFlatList(visibleGroups, sortMode)
  ), [visibleGroups, sortMode, view, collapsedDeckIdSet])

  // ── Phase-scaling + display mode ──────────────────────────────
  // compactThreshold = the expansion value at which Phase 2 (active
  // grows) begins. Per-mode:
  //   auto    → keep today's rule: 0 for long lists, negative for
  //             short ones (so all tabs fit before active grows).
  //   compact → +Infinity (never enter Phase 2 — active stays at peek
  //             no matter how far the panel is dragged).
  //   full    → as low as MIN_EXPANSION territory so active starts
  //             growing immediately as the panel opens from closed.
  //             The clamp into [0, MAX_EXPANSION] still caps active
  //             at full once there's enough room.
  const autoCompactThreshold = Math.min(0, rows.length * SLOT_PEEK_H - LIST_AREA_H_COMPACT)
  const compactThreshold =
    displayMode === 'compact' ? Number.POSITIVE_INFINITY
    : displayMode === 'full'  ? SLOT_PEEK_H + COLLAPSED_BONUS - LIST_AREA_H_COMPACT
    : autoCompactThreshold
  // activeGrowth = how much of rolodexExpansion contributes to the
  // active card's height. Clamped to [0, MAX_EXPANSION]. The
  // compactThreshold offset is what defines each mode's "when does
  // the active start growing?" rule.
  const activeGrowth = displayMode === 'compact'
    ? 0
    : Math.max(0, Math.min(MAX_EXPANSION, rolodexExpansion - compactThreshold))
  // 0 (compact) → 1 (active fully grown). Drives image opacity,
  // bell amplitude/radius, below-stack overlap, tween slowdown.
  const expansionFraction = MAX_EXPANSION > 0 ? activeGrowth / MAX_EXPANSION : 0

  // Max expansion the user can drag to. Mode-aware:
  //   compact → all rows visible as peek tabs, no Phase 2.
  //             cap = rows*peek + COLLAPSED_BONUS - LIST_AREA_H_COMPACT.
  //   full / auto → all rows + active at full hero size, same as the
  //             previous content cap. Falls back to MAX_EXPANSION_TOTAL
  //             for very long lists where Phase 3 (extra below-cards
  //             reveal) is the real ceiling.
  const naturalContentMaxExpansion = displayMode === 'compact'
    ? rows.length * SLOT_PEEK_H + COLLAPSED_BONUS - LIST_AREA_H_COMPACT
    : rows.length * SLOT_PEEK_H + COLLAPSED_BONUS + MAX_EXPANSION - LIST_AREA_H_COMPACT
  const contentMaxExpansion = Math.min(naturalContentMaxExpansion, MAX_EXPANSION_TOTAL)
  // Refs let the imperative drag/tween paths read the current values
  // without needing to be inside the render function.
  const compactThresholdRef = useRef(0)
  const contentMaxExpansionRef = useRef(MAX_EXPANSION_TOTAL)
  compactThresholdRef.current = compactThreshold
  contentMaxExpansionRef.current = contentMaxExpansion

  // Auto-clamp rolodexExpansion when row count or display mode
  // changes so the panel never persists a size larger than the
  // current mode's content cap. The drag handler also clamps to
  // contentMaxExpansion live, so the store stays consistent.
  useEffect(() => {
    if (rows.length === 0) return
    if (rolodexExpansion > contentMaxExpansion) {
      setRolodexExpansion(contentMaxExpansion)
    }
    // Intentionally not depending on rolodexExpansion: we only shrink
    // when the row count or display mode changes, not on every drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, displayMode])

  // Max indent depth across the ENTIRE list (not just visible rows).
  // Drives the panel's right-edge extension so the header / outer
  // border / cabinet base all share one stable width that never
  // shifts during scroll — even if the currently visible window
  // contains only shallow cards, the panel still reserves room for
  // the deepest card in the list.
  const maxListLevel = useMemo(
    () => rows.reduce((m, r) => (r.level > m ? r.level : m), 0),
    [rows],
  )

  // Deck-boundary spacing — in TREE view, add a small extra gap each
  // time the list crosses from one top-level deck/standalone into
  // the next. boundaryShifts[i] is the cumulative extra Y added by
  // all boundaries between row 0 and row i, used as a per-row offset
  // on top of the two-stack positionForOffset value.
  const DECK_BOUNDARY_GAP = 8
  const boundaryShifts = useMemo(() => {
    const shifts: number[] = []
    let cum = 0
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && view === 'tree' && rows[i].level === 0) {
        cum += DECK_BOUNDARY_GAP
      }
      shifts.push(cum)
    }
    return shifts
  }, [rows, view])

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
    // Expansion-aware slowdown — at full expansion the transit card has
    // to cover activeSize ≈ 255 px per integer step (vs 64 in compact),
    // so we slow the tween proportionally to keep its visible pixel
    // velocity comfortable. Read live from the store inside tick so the
    // slowdown reacts immediately when the user drags the cabinet
    // handle to resize. expansionFraction = 0 (compact) → slowdown = 1
    // (unchanged); = 1 (full) → slowdown = EXPANSION_SLOWDOWN_FACTOR.
    const expansion = useCanvasStore.getState().rolodexExpansion
    // Use the ACTIVE-GROWTH fraction (clamped 0..1) so negative
    // expansion (panel closing) and post-MAX_EXPANSION (panel growth
    // past full) both freeze the slowdown at the same value rather
    // than feeding the formula a value outside [0, 1]. The
    // compactThresholdRef shift matches the render-side activeGrowth
    // so the slowdown engages from Phase 2 start regardless of list
    // length.
    const activeGrowth = Math.max(0, Math.min(MAX_EXPANSION, expansion - compactThresholdRef.current))
    const expansionFraction = MAX_EXPANSION > 0 ? activeGrowth / MAX_EXPANSION : 0
    const slowdown = 1 + (EXPANSION_SLOWDOWN_FACTOR - 1) * expansionFraction
    const easing = TWEEN_EASE / slowdown
    const cap = MAX_STEP_PER_FRAME / slowdown
    // Easing — dominates the settle phase (small diff → tiny step).
    // For rapid wheel input the diff can be many slots, which would
    // produce big per-frame jumps without the cap. The cap limits the
    // motion to a smooth visible delta.
    const easedStep = diff * easing
    const step = Math.sign(easedStep) * Math.min(Math.abs(easedStep), cap)
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

  // ── Hover-to-preview ─────────────────────────────────────────
  // Which row in the list the user is currently hovering. When non-null,
  // that row pops up below-stack cards push down to make room, and the
  // hovered card's preview overlay appears at hoverPreviewOpacity. The
  // hover effect strength scales with expansion: full at compact (so
  // tucked cards burst into full previews on hover), half at full
  // expansion (the active card already shows everything, so hover is
  // a subtler peek).
  const [hoveredRowIdx, setHoveredRowIdx] = useState<number | null>(null)
  const setHoveredRowIdxStable = useCallback((idx: number | null) => {
    setHoveredRowIdx(prev => (prev === idx ? prev : idx))
  }, [])

  if (!isOpen) return null

  // Round the float position to pick the preview card. Snaps at 0.5 between
  // adjacent indices, which is the natural moment for the preview to swap.
  const centerPosition = positionRef.current
  // previewIndex retained for end-of-list cabinet logic / future preview
  // re-introduction; previously also fed CardPreview but that component
  // is no longer mounted here.
  const previewIndex = Math.round(centerPosition)

  // ── Lay out the visible stack via prefix-sums ─────────────
  // Each card's "size" (visible height of its top tab) is a bell-bonus around
  // the fractional center. We prefix-sum sizes to get card top positions.
  // Then we shift the whole stack so that the FRACTIONAL center P lands at
  // a fixed Y in the list area — this is what gives "during a tween, the
  // active card grows toward center" since multiple cards' sizes are in
  // partial bonus simultaneously.
  // TOP_BUFFER + BOTTOM_BUFFER both expand DYNAMICALLY with LIST_AREA_H —
  // when the user drags the panel taller (into the "panel growth"
  // range past MAX_EXPANSION), more cards become visible above AND
  // below the active, so the compact-mode static buffers can't cover
  // them. Symptom without this: the last-rendered card has nothing
  // covering its body and pops out as a fully-expanded card at the
  // panel edge; as the user scrolls, the cutoff shifts and cards
  // flicker in/out at that edge. We compute how many SLOT_PEEK_H-tall
  // tabs fit in the panel area and use that as a floor for each
  // buffer.
  const cardsThatFitInPanel = SLOT_PEEK_H > 0
    ? Math.ceil(Math.max(0, LIST_AREA_H + CABINET_BAR_H) / SLOT_PEEK_H)
    : 0
  const effectiveTopBuffer    = Math.max(TOP_BUFFER,    cardsThatFitInPanel + 2)
  const effectiveBottomBuffer = Math.max(BOTTOM_BUFFER, cardsThatFitInPanel + 2)
  const visibleStart = Math.max(0, Math.floor(centerPosition - VISIBLE_RADIUS - effectiveTopBuffer))
  const visibleEnd   = Math.min(rows.length - 1, Math.ceil(centerPosition + VISIBLE_RADIUS + effectiveBottomBuffer))
  const visibleIndices: number[] = []
  for (let k = visibleStart; k <= visibleEnd; k++) visibleIndices.push(k)

  // (cabinet right-edge tracking is computed below, after the per-card
  // tops are known — see "cabinetEdgeLevel" further down.)

  // ── Two-stack positioning ──────────────────────────────────────
  // Cards before and after the active card are treated as TWO separate
  // uniform stacks, with a fixed "active slot" gap between them:
  //
  //   ABOVE STACK (offset ≤ 0): cards uniformly spaced SLOT_PEEK_H apart,
  //                              extending upward from the active card.
  //   ACTIVE SLOT (gap of activeSize): occupied by the card at offset 0.
  //                                     During a fractional tween the
  //                                     slot is "shared" — see below.
  //   BELOW STACK (offset ≥ 1): cards uniformly spaced SLOT_PEEK_H apart,
  //                              starting at activeSize below the active.
  //
  // activeSize = SLOT_PEEK_H + rolodexExpansion. At super-collapsed
  // (expansion = 0) the active card is the same SLOT_PEEK_H tab as the
  // others — all uniform. At full expansion the active occupies the
  // entire CARD_H, so the lower list sits VISIBLY BELOW it (not hidden
  // behind it) — the gap between the two stacks always equals the
  // visible height of the active card.
  //
  // TRANSIT (0 < offset < 1): the position function is piecewise linear
  // and continuous at offset = 0 and offset = 1. As the user scrolls
  // through an integer, the card transiting through the slot grows
  // smoothly from peek-height to full active-height. Both stacks slide
  // uniformly upward by SLOT_PEEK_H per unit of centerPosition advance,
  // so neighbours of the transit card never bob or stutter — only the
  // transit card itself crosses the active gap.
  //
  // ANTICIPATION (offset 1 → 1 + belowBellRadius): a half-cosine bell
  // shift adds up to PEEK_BONUS px to the first below-card's tab,
  // fading to 0 by the end of the bell zone. Radius widens with
  // expansion — compact covers just one card (radius=1), full
  // expansion stretches it across three (radius=3) so the taper down
  // the below stack reads as a longer, gentler ramp. Cards beyond the
  // bell zone stay uniformly spaced because the bell has fully
  // integrated by then.
  // SLOT_PEEK_H baseline + permanent COLLAPSED_BONUS (so the active
  // is always at least 2 px taller than peeks even at super-collapsed)
  // + activeGrowth (capped at MAX_EXPANSION). Total maxes at CARD_H.
  const activeSize = SLOT_PEEK_H + COLLAPSED_BONUS + activeGrowth

  // Anticipation bell parameters — both the RADIUS and the AMPLITUDE
  // widen linearly with expansion so the swell at full expansion is
  // both broader and taller. Super-collapsed: radius=1, amplitude=0
  // (bell vanishes — all tabs uniform). Full expansion: radius=3,
  // amplitude=PEEK_BONUS_GROWTH (three cards, full bell per card).
  const belowBellRadius = BELOW_BELL_RADIUS_BASE + BELOW_BELL_RADIUS_GROWTH * expansionFraction
  const belowBellAmplitude = PEEK_BONUS + PEEK_BONUS_GROWTH * expansionFraction

  // Half-cosine bell's CUMULATIVE INTEGRAL starting at offset=1, with
  // dynamic radius `belowBellRadius` and amplitude `belowBellAmplitude`.
  // Smooth ramp from 0 at offset=1 to amplitude · radius / 2 at
  // offset=(1 + radius), staying flat at that maximum for any deeper
  // offset. Used to add an "anticipation" swell to the first
  // below-card(s) while keeping cards past the bell zone uniformly
  // spaced — they all inherit the same maximum shift. Bell shape:
  // (cos(π · t / r) + 1) / 2 with t = o − 1 over [0, r]; its integral
  // is (r / (2π)) · sin(π · t / r) + t / 2, which collapses to the
  // radius-1 case (sin(π·t) / (2π) + t/2) when r=1.
  const belowBellShift = (o: number): number => {
    const r = belowBellRadius
    if (o <= 1) return 0
    if (o >= 1 + r) return belowBellAmplitude * r * 0.5
    const t = o - 1
    return belowBellAmplitude * (
      (r / (2 * Math.PI)) * Math.sin(Math.PI * t / r) + t / 2
    )
  }

  // Effective visible size of the active slot — the active card body
  // itself is still rendered CARD_H tall, but the lower stack steps up
  // by up to BELOW_OVERLAP px so it visually overlaps the active card's
  // bottom edge. Scaled by expansionFraction so super-collapsed has no
  // overlap (clean uniform tabs) and full expansion gets the full
  // BELOW_OVERLAP step. Used as the transit-zone length and the
  // below-stack starting offset so the position function stays
  // continuous at o = 1.
  const effectiveBelowOverlap = BELOW_OVERLAP * expansionFraction
  const visibleActiveSize = activeSize - effectiveBelowOverlap

  // Position of a card with offset (= idx - centerPosition), measured
  // from the active card's anchor TOP. Piecewise linear with a small
  // bell-curve anticipation bump on the first below-card:
  //   o ≤ 0:  o * SLOT_PEEK_H                                              (above stack)
  //   0 < o < 1:  o * visibleActiveSize                                    (transit through slot)
  //   o ≥ 1:  visibleActiveSize + (o − 1) * SLOT_PEEK_H + belowBellShift(o) (below stack)
  // Continuous at o = 0 (both branches yield 0) and at o = 1 (transit
  // yields visibleActiveSize; below-stack adds 0 from belowBellShift).
  const positionForOffset = (o: number): number => {
    if (o <= 0) return o * SLOT_PEEK_H
    if (o < 1) return o * visibleActiveSize
    return visibleActiveSize + (o - 1) * SLOT_PEEK_H + belowBellShift(o)
  }

  // Anchor: the active card's TOP sits at this Y. Uses LIST_AREA_H_COMPACT
  // (not the dynamic LIST_AREA_H) so the active card stays vertically
  // pinned when the user drags to expand the panel — expansion goes
  // entirely to growing the active card downward, not to shifting it.
  // ACTIVE_LIFT_SLOTS lifts the active above mid-panel so there's room
  // to see context above without burying the cards below.
  //
  // Two CLAMPS pull the anchor away from anchorYBase at the list's
  // extremes:
  //
  //   TOP CLAMP (engaged when topTarget < anchorYBase, i.e. fewer than
  //   ~ACTIVE_LIFT_SLOTS cards exist above): pulls anchorY UP so the
  //   above-stack cards stack tightly between the header and the
  //   active, with no empty region. anchorY = numCardsAbove × peek.
  //
  //   BOTTOM CLAMP (engaged when bottomTarget > anchorYBase, i.e.
  //   fewer than ~(LIST_AREA_H − anchorYBase − activeSize)/peek cards
  //   exist below): pushes anchorY DOWN so the below-stack and active
  //   sit tightly above the cabinet, no empty region below.
  //
  // For long lists the two clamps are mutually exclusive — only the
  // relevant one engages near each end, and the middle just uses
  // anchorYBase. For VERY short lists where both can engage at once,
  // we lerp between top and bottom targets by scroll fraction so the
  // active glides smoothly from top → bottom as the user scrolls.
  const anchorYBase = LIST_AREA_H_COMPACT / 2 - SLOT_PEEK_H / 2 - ACTIVE_LIFT_SLOTS * SLOT_PEEK_H
  const numCardsAbove = Math.max(0, centerPosition)
  const numCardsBelow = Math.max(0, (rows.length - 1) - centerPosition)
  const topTarget    = numCardsAbove * SLOT_PEEK_H
  const bottomTarget = LIST_AREA_H - activeSize - numCardsBelow * SLOT_PEEK_H
  const topClampEngaged    = topTarget < anchorYBase
  const bottomClampEngaged = bottomTarget > anchorYBase
  let anchorY: number
  if (topClampEngaged && bottomClampEngaged) {
    // Short list — interpolate between targets so the transition
    // through the list stays continuous, no jumps.
    const fraction = rows.length > 1 ? centerPosition / (rows.length - 1) : 0
    anchorY = topTarget + fraction * (bottomTarget - topTarget)
  } else if (topClampEngaged) {
    anchorY = topTarget
  } else if (bottomClampEngaged) {
    anchorY = bottomTarget
  } else {
    anchorY = anchorYBase
  }

  // Interpolated deck-boundary shift at the fractional centerPosition,
  // used as the reference point so the ACTIVE card's effective shift
  // is 0 (stays at anchorY) while other cards get +/− adjusted by the
  // number of deck boundaries that lie between them and the active.
  // Linear interpolation keeps the shift continuous through scroll
  // transits across boundaries (no jumps).
  const Pfloor_for_shift = Math.max(0, Math.min(rows.length - 1, Math.floor(centerPosition)))
  const Pfrac_for_shift = Math.max(0, Math.min(1, centerPosition - Pfloor_for_shift))
  const centerBoundaryShift = (() => {
    const lo = boundaryShifts[Pfloor_for_shift] ?? 0
    const hi = boundaryShifts[Pfloor_for_shift + 1] ?? lo
    return lo + Pfrac_for_shift * (hi - lo)
  })()

  // Hover pop — always the compact-mode "tiny peek" effect regardless
  // of expansion. The hovered card raises by exactly COLLAPSED_BONUS
  // (4 px) above peek (matching the active card's lift at compact)
  // and swaps its tab title for the preview header text. No hero
  // image fade, no scaled pop. Hover stays a small, predictable
  // affordance even when the panel is fully expanded.
  const hoverPopBonus = COLLAPSED_BONUS
  const activeRowIdx = Math.round(centerPosition)
  const isHoverActive = hoveredRowIdx != null && hoveredRowIdx !== activeRowIdx

  // Final top position for each visible card — base two-stack position
  // plus this card's deck-boundary delta relative to the active, plus
  // hover-pop bonus for cards below the hovered row.
  const tops = visibleIndices.map(k => {
    const cardShift = boundaryShifts[k] ?? 0
    let pos = anchorY + positionForOffset(k - centerPosition) + (cardShift - centerBoundaryShift)
    if (isHoverActive && hoveredRowIdx != null && k > hoveredRowIdx) {
      pos += hoverPopBonus
    }
    return pos
  })

  // "Sizes" array — the visible tab height of each card (= gap to the
  // next card's top, since cards stack tucked-under each other). Kept
  // in this shape so the cabinet floor logic below can use sizes[i] to
  // get each card's effective bottom edge without recomputing the
  // piecewise function. The last visible card has no successor
  // rendered; default it to SLOT_PEEK_H (matches the below-stack
  // uniform spacing).
  const sizes = tops.map((t, i) => (i + 1 < tops.length ? tops[i + 1] - t : SLOT_PEEK_H))

  // Cabinet right-edge extension: cover the rightmost overhang of any
  // card whose render-box intersects the cabinet's y-range. That
  // includes the bottom-most visible card AND cards sliding under
  // the cabinet (whose tabs are between LIST_AREA_H and
  // LIST_AREA_H + CABINET_BAR_H), but EXCLUDES off-screen buffer
  // cards above (their bodies are too high to reach the cabinet)
  // and far-below buffer cards (already past it). Take the max
  // indent level among those — the cabinet rectangle needs to be
  // wide enough to cover whichever card's right edge sits highest
  // within the cabinet zone.
  // Panel right-edge extension — derived from the LIST-WIDE max indent
  // (maxListLevel, memoized over rows). Stable through scroll: header
  // and cabinet stay one consistent width regardless of which cards
  // happen to be in the visible window. Reserves room for the deepest
  // card in the list even if the currently-visible window contains
  // only shallow ones, so the panel silhouette doesn't "breathe" as
  // the wheel scrolls.
  const CABINET_CARD_OVERLAP = 1
  const panelRightmostCardRight = WING_W + maxListLevel * INDENT_STEP + SLOT_W
  const panelRightExtension = Math.max(0, panelRightmostCardRight + CABINET_CARD_OVERLAP - LEFTCOL_W)

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
    const cardBottom = tops[i] + sizes[i]
    if (cardBottom > bottomMostCardBottom) bottomMostCardBottom = cardBottom
  }
  const cardsBelowVisible = Math.max(0, (rows.length - 1) - visibleEnd)
  const effectiveBottom = bottomMostCardBottom + cardsBelowVisible * SLOT_PEEK_H
  // Floor minimum sits at the active card's visible bottom MINUS the
  // notch radius, so when the cabinet rises (end-of-list), its rounded
  // bar top OVERLAPS the active card by exactly CABINET_NOTCH_RADIUS
  // px. The bar's rounded top corners (same radius) then read as
  // curves carved into the card's bottom — the card appears to have
  // matching rounded bottom corners poking through the cabinet's slot.
  // Clamped so the overlap never exceeds half of activeSize (avoids
  // hiding most of a tiny super-collapsed tab).
  const cabinetOverlap = Math.min(CABINET_NOTCH_RADIUS, activeSize / 2)
  const floorTopMin = anchorY + activeSize - cabinetOverlap
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
      {/* Dock anchors to the panel like an attached piece of the frame:
          - Fully closed: dock fades out (opacity 0) — invisible.
          - As the panel opens: dock pops in (opacity 1), top edge
            flush with the header top.
          - As the panel grows past the dock height: the dock slides
            down with the panel bottom (kept flush) until it reaches
            its final position (≈ 116 px below the top, beside the
            active card row), then locks there.
          The 'pseudo-cabinet' colors in the dock's styles make it read
          as a small detachable piece of the same frame. */}
      {(() => {
        const APPROX_HEADER_H = 26
        const DOCK_H = 82
        const FINAL_OFFSET = 26 + 3 * SLOT_PEEK_H // 116 — beside active row
        // panel_height = header + list area + cabinet bar.
        const approxPanelH = APPROX_HEADER_H + LIST_AREA_H + CABINET_BAR_H
        const dockOffset = Math.max(0, Math.min(FINAL_OFFSET, approxPanelH - DOCK_H))
        // Fade out when fully collapsed; pop in as soon as any list
        // area appears.
        const fade = LIST_AREA_H > 0 ? 1 : 0
        return (
          <DisplayModeDock
            mode={displayMode}
            setMode={setDisplayMode}
            left={rolodexPos.x - 30}
            top={rolodexPos.y}
            slideOffset={dockOffset}
            fade={fade}
            onPointerDownBg={onPanelPointerDown}
            onWheel={onWheel}
          />
        )
      })()}
      <div
        data-rolodex
        onWheel={onWheel}
        // Whole-panel drag — pointerdown anywhere except buttons/cards/
        // cabinet/input(click) moves the window. See onPanelPointerDown
        // for the per-target rules.
        onPointerDown={onPanelPointerDown}
        style={{
          position: 'fixed',
          left: rolodexPos.x,
          top: rolodexPos.y,
          // Panel-bg fills the card area (visible between cards). The
          // FRAME (header + side rails + cabinet) sits in front of this
          // and forms the panel's visible silhouette.
          background: PANEL_BG,
          borderRadius: PANEL_RADIUS,
          padding: PANEL_PAD,
          // overflow:hidden lets the FRAME's square corners be clipped
          // by the panel's rounded outer corners. Removes the need for
          // a separate outer border line.
          overflow: 'hidden',
          // Drop shadow replaces the role the old hairline border was
          // playing — separates the panel from the canvas behind it.
          boxShadow: '0 10px 28px rgba(0,0,0,0.6), 0 2px 6px rgba(0,0,0,0.5)',
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
              Base width is LEFTCOL_W (SLOT_W + 2*WING_W) so cards can
              sit centered with the cabinet's side wings (WING_W each
              side) flanking them. Extended by panelRightExtension so
              the header (and outer panel border) stretches to cover
              every overhanging card in the visible window — otherwise
              indented cards poke past the header on the top right. */}
        <div style={{
          width: LEFTCOL_W + panelRightExtension,
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
        }}>
          {/* Header — top of the FRAME. Solid frame color. The panel-
              wide drag handler on the outer container handles dragging
              (see onPanelPointerDown). Double-click toggles between
              closed (MIN_EXPANSION) and a previous open state. */}
          <div
            onDoubleClick={onHeaderDoubleClick}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              // Horizontal padding = WING_W so the title's left edge and the
              // icons' right edge line up with the cards' left/right edges
              // below (cards are inset by WING_W inside the leftColumn).
              padding: `4px ${WING_W}px 5px`,
              background: FRAME_COLOR,
              // Inset highlight on the bottom inside edge (warm hairline
              // separating header from cards) + outer drop shadow
              // pointing down so the header casts onto the cards below.
              boxShadow: `inset 0 -1px 0 ${FRAME_HIGHLIGHT}, 0 3px 6px -1px ${FRAME_SHADOW}`,
              cursor: 'move',
              touchAction: 'none',
              position: 'relative',
              zIndex: 1,
            }}
          >
            {/* Search input — replaces the static "CARDS" label so the
                header doubles as a filter field. Placeholder ALL-CAPS
                "CARDS" preserves the original label vibe when empty.
                Pointer-events override the parent's drag/double-click
                via the tag check in onHeaderPointerDown above. */}
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  setSearchQuery('')
                  ;(e.target as HTMLInputElement).blur()
                }
                // Stop arrow keys from triggering canvas pan / nav.
                e.stopPropagation()
              }}
              placeholder="SEARCH"
              spellCheck={false}
              autoComplete="off"
              style={{
                flex: 1,
                minWidth: 0,
                marginRight: 6,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'rgba(255,255,255,0.92)',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: searchQuery ? '0.2px' : '0.5px',
                fontFamily: 'inherit',
                padding: 0,
                cursor: 'text',
              }}
            />
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
              hides any cards passing behind.
              clip-path replaces overflow:hidden + borderRadius:
                - clips top/bottom at the wrapper edges (rounded BL/BR
                  corners give the panel its rounded bottom)
                - clips left at the wrapper's left edge
                - EXTENDS the right edge by OVERHANG_ALLOWANCE so
                  tree-mode indented cards can overhang past the panel
                  width without being clipped at the right side. */}
          <div style={{
            position: 'relative',
            width: LEFTCOL_W,
            height: LIST_AREA_H + CABINET_BAR_H,
            overflow: 'visible',
            clipPath: `inset(0px -${OVERHANG_ALLOWANCE}px 0px 0px round 0px 0px ${CABINET_OUTER_RADIUS}px ${CABINET_OUTER_RADIUS}px)`,
          }}>
            {/* Side rails — vertical FRAME strips on the left and right
                  of the card column, running the full panel height (under
                  the header, down to the cabinet base). Same color as the
                  header and cabinet so the four pieces read as one frame
                  wrapping the cards. Each rail has an inset highlight on
                  its INNER edge (the side facing the cards) plus a
                  subtle outward shadow so the rail casts a drop onto
                  the card area. The right rail sits at the FAR right of
                  the extended panel via right:-panelRightExtension. */}
            <div style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: WING_W,
              height: LIST_AREA_H + CABINET_BAR_H,
              background: FRAME_COLOR,
              boxShadow: `inset -1px 0 0 ${FRAME_HIGHLIGHT}, 3px 0 6px -1px ${FRAME_SHADOW}`,
              zIndex: 150,
              pointerEvents: 'none',
            }} />
            <div style={{
              position: 'absolute',
              right: -panelRightExtension,
              top: 0,
              width: WING_W,
              height: LIST_AREA_H + CABINET_BAR_H,
              background: FRAME_COLOR,
              boxShadow: `inset 1px 0 0 ${FRAME_HIGHLIGHT}, -3px 0 6px -1px ${FRAME_SHADOW}`,
              zIndex: 150,
              pointerEvents: 'none',
            }} />
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
                      top={tops[i]}
                      zIndex={idx + 1}
                      heroImage={heroImageMap.get(row.group.id) ?? null}
                      expansionFraction={expansionFraction}
                      isCollapsed={collapsedDeckIdSet.has(row.group.id)}
                      showCaret={view === 'tree' && row.isDeck}
                      isHovered={isHoverActive && hoveredRowIdx === idx}
                      onHoverEnter={() => setHoveredRowIdxStable(idx)}
                      onHoverLeave={() => {
                        // Only clear if this slot is still the hovered one;
                        // avoids races when the pointer crosses rapidly to
                        // the next card (its enter fires before this leave).
                        setHoveredRowIdx(prev => prev === idx ? null : prev)
                      }}
                      onClick={() => onSlotClick(idx)}
                      onDoubleClick={() => onSlotDoubleClick(row.group)}
                      onToggleCollapsed={() => toggleDeckCollapsed(row.group.id)}
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
                      background: FRAME_COLOR,
                      borderTopLeftRadius: CABINET_OUTER_RADIUS,
                      zIndex: 200,
                      pointerEvents: 'none',
                    }} />
                    {/* Right wing — mirrors the footer's bottom-right.
                          Stays WING_W wide and sits at the FAR right of
                          the extended panel (right: -panelRightExtension
                          places it past the slot list wrapper's right
                          edge by panelRightExtension px). The bar below
                          fills the space between the two wings. */}
                    <div style={{
                      position: 'absolute',
                      right: -panelRightExtension,
                      top: cabinetFloorTop,
                      width: WING_W,
                      height: cabinetH,
                      background: FRAME_COLOR,
                      borderTopRightRadius: CABINET_OUTER_RADIUS,
                      zIndex: 200,
                      pointerEvents: 'none',
                    }} />
                    {/* Bottom bar — fills the space between the two
                          wings, extending right by panelRightExtension
                          so the rising cabinet reads as one continuous
                          shape spanning the full panel width. Its top
                          sits ~CABINET_NOTCH_RADIUS px ABOVE where the
                          card's body ends, so the rounded top corners
                          overlap into the card. The card's flat bottom
                          is hidden behind the bar; the curves that bite
                          out of the bar's top corners read as the
                          card's OWN rounded bottom corners poking up
                          through the cabinet slot. Bar height grows
                          with the cabinet to fill all the way to the
                          listArea bottom with no gap. */}
                    {barH > 0 && (
                      <div style={{
                        position: 'absolute',
                        left: WING_W,
                        top: cabinetFloorTop + notchH,
                        width: SLOT_W + panelRightExtension,
                        height: barH,
                        background: FRAME_COLOR,
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
                wrapper. Higher z-index than any card (cards top out
                around 60) but compatible with the cabinet wings/bar
                at z=200. Cards traveling past LIST_AREA_H are still
                rendered (until they're clipped at LIST_AREA_H +
                CABINET_BAR_H) but visually hidden behind this strip
                — that's the slide-under effect.
                ALSO doubles as the drag handle that controls
                rolodexExpansion — grab it and drag DOWN to grow the
                active card slot (and the panel) so the card's hero
                image / content reveals; drag UP to collapse back to
                the compact tab-list view.
                Width extends rightward by panelRightExtension so the
                base fills the full panel width (matching the header /
                outer border), with no gap on the right between the
                cabinet and the panel border. Plain rectangle (no
                bevel), always flat. */}
            <div
              onPointerDown={onExpandPointerDown}
              onPointerMove={onExpandPointerMove}
              onPointerUp={onExpandPointerUp}
              onPointerCancel={onExpandPointerUp}
              title="Drag down to expand the selected card · drag up to collapse"
              style={{
                position: 'absolute',
                left: 0,
                top: LIST_AREA_H,
                width: LEFTCOL_W + panelRightExtension,
                height: CABINET_BAR_H,
                background: FRAME_COLOR,
                // Inset highlight on the TOP inside edge of the base
                // (a warm hairline picking up the bar's top edge) +
                // outer shadow pointing UP so the base casts onto the
                // cards above it.
                boxShadow: `inset 0 1px 0 ${FRAME_HIGHLIGHT}, 0 -3px 6px -1px ${FRAME_SHADOW}`,
                zIndex: 200,
                cursor: 'ns-resize',
                touchAction: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                // Keep the grip pill centered on the ORIGINAL panel
                // width (not the extended width) so it stays where
                // it always sits regardless of indent depth.
                paddingRight: panelRightExtension,
              }}
            >
              {/* Visible grip — a small horizontal pill so the user
                  knows the cabinet base is grabbable. */}
              <div style={{
                width: 28,
                height: 3,
                borderRadius: 2,
                background: 'rgba(255,255,255,0.22)',
                pointerEvents: 'none',
              }} />
            </div>
          </div>

          {/* + Place new card — temporarily hidden per spec; placement
              mode wiring (PlacementGhost, isPlacing, etc.) is left in
              place and can be re-enabled by restoring this footer
              with the original button.
              <div style={{ ... }}><button onClick={startPlacement}>+</button></div>
          */}
        </div>

        {/* Preview pane removed — its role is now served by expanding
            the active row card via the drag handle at the bottom of
            the panel. CardPreview component is kept around in the
            file (below) in case we want to reintroduce it as an
            optional mode. */}
      </div>

      {/* Cursor-follow ghost card during placement mode (rendered globally) */}
      {isPlacing && (
        <PlacementGhost onDone={() => setIsPlacing(false)} />
      )}
    </>
  )
}

// ─── Active card preview overlay ─────────────────────────────
// Read-only render of the group's saved cardHeaderText + cardText with
// their respective text styles, laid out the same way a canvas card
// shows them at card-zoom: header on top, body below, split by the
// group's textSplitRatio. Used inside RolodexSlot to give the active
// card a full preview of the canvas card's content — not just the
// hero image. Opacity is driven by the parent (same imageCenterness
// that fades the hero image), so the overlay only materialises on the
// active card at sufficient expansion. Pointer-events disabled so the
// overlay doesn't intercept slot clicks.
const RolodexCardPreview: React.FC<{
  group: ProjectGroup
  opacity: number
}> = ({ group, opacity }) => {
  const headerText = group.cardHeaderText ?? ''
  const bodyText   = group.cardText ?? ''
  const headerStyle: TextStyle = useMemo(
    () => ({ ...DEFAULT_HEADER_STYLE, ...(group.cardHeaderTextStyle ?? {}) }),
    [group.cardHeaderTextStyle],
  )
  const bodyStyle: TextStyle = useMemo(
    () => ({ ...DEFAULT_BODY_STYLE, ...(group.cardTextStyle ?? {}) }),
    [group.cardTextStyle],
  )
  const splitRatio = group.textSplitRatio ?? 0.5

  // Load any Google fonts referenced by the saved styles so the overlay
  // renders with the correct typography rather than falling back to
  // inherit. No-op for system fonts.
  ensureFontLoaded(headerStyle.fontFamily)
  ensureFontLoaded(bodyStyle.fontFamily)

  if (opacity < 0.01) return null

  const headerBg = hexToRgba(headerStyle.bgColor, headerStyle.bgOpacity)
  const bodyBg   = hexToRgba(bodyStyle.bgColor,   bodyStyle.bgOpacity)

  // Text-area display style — mirrors cardDisplayStyle in CardLayer.tsx.
  const textBlockStyle = (ts: TextStyle, bg: string, hasText: boolean): React.CSSProperties => ({
    padding: hasText ? 6 : 0,
    background: bg || 'transparent',
    borderRadius: 6,
    color: ts.color,
    fontSize: ts.fontSize,
    lineHeight: ts.lineHeight ?? 1.4,
    fontWeight: ts.fontWeight ?? (ts.bold ? 700 : 400),
    fontStyle: ts.italic ? 'italic' : 'normal',
    textAlign: ts.align,
    fontFamily: ts.fontFamily || 'inherit',
    letterSpacing: ts.letterSpacing ?? 0,
    textTransform: ts.textTransform ?? 'none',
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    textShadow: hasText ? '0 1px 3px rgba(0,0,0,0.8)' : 'none',
  })

  const vAlignToJustify = (va: string) =>
    va === 'middle' ? 'center' : va === 'bottom' ? 'flex-end' : 'flex-start'

  // The rolodex slot is SLOT_W × CARD_H = 180 × 255. A canvas card at
  // its base card-zoom rendering is roughly ~280 px wide, so scale the
  // text down to ~64% to keep proportions consistent with what the
  // canvas shows. transformOrigin top-left + inflated child dimensions
  // preserve correct layout under the scale.
  const TEXT_SCALE = 0.64

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      opacity,
      overflow: 'hidden',
      zIndex: 2,
    }}>
      <div style={{
        position: 'absolute',
        inset: 0,
        padding: '4px 4px 10px 4px',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        transform: `scale(${TEXT_SCALE})`,
        transformOrigin: 'top left',
        width:  `${100 / TEXT_SCALE}%`,
        height: `${100 / TEXT_SCALE}%`,
      }}>
        <div style={{
          flex: splitRatio,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: vAlignToJustify(headerStyle.vAlign),
          minHeight: 0,
          overflow: 'hidden',
        }}>
          <div style={textBlockStyle(headerStyle, headerBg, !!headerText)}>
            {headerText || null}
          </div>
        </div>
        <div style={{
          flex: 1 - splitRatio,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: vAlignToJustify(bodyStyle.vAlign),
          minHeight: 0,
          overflow: 'hidden',
        }}>
          <div style={textBlockStyle(bodyStyle, bodyBg, !!bodyText)}>
            {bodyText || null}
          </div>
        </div>
      </div>
    </div>
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
  /** Resolved hero image URL for this group (or null if none). Faded in
   *  by lit/centerness so the active card shows a clear thumbnail of
   *  its actual image and tucked cards stay color-only. Pre-resolved
   *  by the parent so each slot doesn't need its own boards
   *  subscription. */
  heroImage: string | null
  /** 0 (compact, peek-tab list) → 1 (fully expanded, active slot reveals
   *  the whole card). Used to scale up the hero image's opacity so the
   *  image is more visible at higher expansion, and to fade in the
   *  preview-style header text + summary overlays. */
  expansionFraction: number
  /** True if this deck-row's children are currently hidden (caret-collapsed
   *  in the tree view). Only meaningful when isDeck && in tree view. */
  isCollapsed: boolean
  /** True if a caret toggle should be rendered (only for deck rows in tree
   *  view). Click toggles isCollapsed for this deck. */
  showCaret: boolean
  /** True when the user is hovering this row (and it isn't the active
   *  card). Drives a SOLID hover state: preview text and hero image
   *  snap to full opacity, tab title hides. Pop-up height (handled by
   *  parent positioning) scales smaller at higher expansions, but the
   *  content shown inside the popped area stays at full opacity — no
   *  half-fade intermediate states. */
  isHovered: boolean
  onClick: () => void
  onDoubleClick: () => void
  onToggleCollapsed: () => void
  onHoverEnter: () => void
  onHoverLeave: () => void
}> = ({ group, level, isDeck, offset, top, zIndex, heroImage, expansionFraction, isCollapsed, showCaret, isHovered: isHoverActive, onClick, onDoubleClick, onToggleCollapsed, onHoverEnter, onHoverLeave }) => {
  const [isHovered, setIsHovered] = useState(false)

  // Continuous "centerness" used to tween visual emphasis (rim, shadow,
  // glow) from "lit center" → "tucked tab". 1.0 at exact center, 0.0 at
  // |offset| ≥ 1.0. Independent of the size bell so the visual treatment
  // has a tighter peak than the geometric growth.
  const centerness = Math.max(0, 1 - Math.abs(offset))

  // Hero image opacity — single-card asymmetric scroll fade, gated by
  // expansion. EXPERIMENT: only the ACTIVE card shows its image, with
  // a "fade up fast, stay long, fade out fast" curve during scroll
  // transit. Below stack and far above stack stay color-only.
  //
  //    offset ≥ 1.0:        opacity 0 (card too far below, hasn't started
  //                          its transit toward active)
  //    0.5 ≤ offset < 1.0:  fade IN  (linear, 0 → 1) — begins when the
  //                          card starts moving toward active, reaches
  //                          full opacity at the halfway point of the
  //                          transit (twice as fast as a full-transit
  //                          fade so the image lands quickly without
  //                          feeling lazy).
  //    0.0 ≤ offset < 0.5:  plateau (full opacity through second half
  //                          of the inbound transit + landing).
  //   −1.0 ≤ offset < 0.0:  fade OUT (linear, 1 → 0) — begins as the
  //                          card starts leaving active, fully gone by
  //                          the time it lands at first-above.
  //    offset < −1.0:       opacity 0 (gone)
  //
  // Then multiplied by an expansion factor so super-collapsed shows no
  // image and the active image fades in over expansionFraction 0.15 → 0.35.
  const SCROLL_FADE_IN_START  =  1.0
  const SCROLL_FADE_IN_END    =  0.5
  const SCROLL_PLATEAU_END    =  0.0
  const SCROLL_FADE_OUT_END   = -1.0
  const IMAGE_FADE_WINDOW     =  0.2
  const IMAGE_FADE_START_BASE =  0.15

  let scrollFactor: number
  if (offset >= SCROLL_FADE_IN_START) scrollFactor = 0
  else if (offset >= SCROLL_FADE_IN_END) {
    scrollFactor = 1 - (offset - SCROLL_FADE_IN_END) / (SCROLL_FADE_IN_START - SCROLL_FADE_IN_END)
  } else if (offset >= SCROLL_PLATEAU_END) {
    scrollFactor = 1
  } else if (offset >= SCROLL_FADE_OUT_END) {
    scrollFactor = (offset - SCROLL_FADE_OUT_END) / (SCROLL_PLATEAU_END - SCROLL_FADE_OUT_END)
  } else {
    scrollFactor = 0
  }

  const fadeStart = IMAGE_FADE_START_BASE
  const fadeEnd = fadeStart + IMAGE_FADE_WINDOW
  let expansionFactor: number
  if (expansionFraction <= fadeStart) expansionFactor = 0
  else if (expansionFraction >= fadeEnd) expansionFactor = 1
  else expansionFactor = (expansionFraction - fadeStart) / IMAGE_FADE_WINDOW

  const imageCenterness = scrollFactor * expansionFactor


  // ── Visual emphasis (scales with centerness) ─────────────────
  // Single multiplier, used to tween every center-related visual cue. With
  // `centerness` updating each rAF frame, every effect interpolates per
  // frame — no CSS transitions needed and the lift / shadow / glow / rim
  // all "grow into" the center together.
  const lit = centerness

  // Border highlight — uses an ASYMMETRIC centerness with a quick
  // fade-in, a long plateau, and a quick fade-out. Reads as "the rim
  // flips on early when scrolling toward a card, stays lit through
  // active and a bit past, then snaps over to the next card." During
  // a rapid scroll two adjacent cards briefly have their rims partly
  // lit (one coming in, one going out) so the eye gets continuous
  // feedback rather than a single fade.
  //   offset ≥ 0.50:  borderLit = 0
  //   0.20 ≤ off < 0.50: linear 0 → 1 (quick fade-in)
  //   −0.50 ≤ off < 0.20: borderLit = 1 (full)
  //   −0.80 ≤ off < −0.50: linear 1 → 0 (quick fade-out)
  //   offset < −0.80: borderLit = 0
  const BORDER_IN_START  =  0.5
  const BORDER_IN_END    =  0.2
  const BORDER_OUT_START = -0.5
  const BORDER_OUT_END   = -0.8
  let borderLit: number
  if (offset >= BORDER_IN_START) borderLit = 0
  else if (offset >= BORDER_IN_END) {
    borderLit = 1 - (offset - BORDER_IN_END) / (BORDER_IN_START - BORDER_IN_END)
  } else if (offset >= BORDER_OUT_START) borderLit = 1
  else if (offset >= BORDER_OUT_END) {
    borderLit = (offset - BORDER_OUT_END) / (BORDER_OUT_START - BORDER_OUT_END)
  } else borderLit = 0

  // Border lerps from dark hairline (tucked) to bright white rim
  // (centered). Color, alpha, and width all grow with borderLit so the
  // rim asymmetry above applies uniformly to the whole rim treatment.
  const borderRGB = Math.round(255 * borderLit)
  const borderAlpha = 0.28 + (0.92 - 0.28) * borderLit
  const borderWidth = 1 + 0.5 * borderLit
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

  // Drag-to-link: pointerdown + small move starts a link-drag operation
  // (mirroring the canvas chip / plus-affordance behaviour). If the
  // pointer is released without moving past the threshold, the normal
  // onClick fires; if a drag started, draggedRef suppresses the click
  // that the browser may still synthesize.
  const draggedRef = useRef(false)
  const onSlotPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    // The card owns its pointer-down: short clicks are slot selection,
    // drags spawn a link-drag to the canvas. Stop the bubble so the
    // panel-wide drag handler doesn't steal the gesture (its 4-px
    // threshold beats the card's 5-px otherwise).
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const DRAG_THRESHOLD_PX = 5
    let dragStarted = false
    const onMove = (ev: PointerEvent) => {
      if (dragStarted) return
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        dragStarted = true
        draggedRef.current = true
        useLinkDragStore.getState().begin(group.id, group.color, ev.clientX, ev.clientY)
        // Cleanup our temporary listeners — LinkDragOverlay's window
        // listeners take over from here.
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [group.id, group.color])
  const handleSlotClick = useCallback(() => {
    if (draggedRef.current) {
      draggedRef.current = false
      return
    }
    onClick()
  }, [onClick])

  return (
    <div
      onPointerDown={onSlotPointerDown}
      onClick={handleSlotClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => { setIsHovered(true); onHoverEnter() }}
      onMouseLeave={() => { setIsHovered(false); onHoverLeave() }}
      title={lit > 0.5
        ? `${group.name || 'Untitled'} — double-click to pan canvas · drag to link to another card`
        : `${group.name || 'Untitled'} — click to view · drag to link to another card`}
      style={{
        position: 'absolute',
        // Cards sit centered inside the leftColumn — offset by WING_W so
        // the cabinet wings flank them on both sides. In tree mode each
        // indent level pushes the LEFT edge inward by INDENT_STEP while
        // keeping full SLOT_W width — so the card's RIGHT edge overhangs
        // past the panel into the canvas area. The slot-list wrapper's
        // clip-path allows that overhang (see OVERHANG_ALLOWANCE).
        left: WING_W + level * INDENT_STEP,
        top,
        width: SLOT_W,
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
      {/* Hero image — rendered BEFORE the gradient + content so it
            sits at the back. Opacity = imageCenterness multiplied by
            the user's saved cardHeroTransform.opacity (or HeroImageLayer's
            default 0.7) so a card whose canvas representation blends
            the image with its color at, say, 20 % renders the same
            blend in the rolodex. Otherwise we'd whitewash the card
            color with a full-opacity image. */}
      {heroImage && imageCenterness > 0.01 && (() => {
        // Hover NEVER touches the hero image — the hover effect is
        // always the compact "tiny peek" (4 px pop + text swap),
        // never revealing the card image. Image is driven solely by
        // imageCenterness (scroll + expansion) for the active card.
        const userOpacity = group.cardHeroTransform?.opacity ?? 0.7
        return (
          <HeroImageLayer
            heroImage={heroImage}
            transform={group.cardHeroTransform}
            opacity={imageCenterness * userOpacity}
            borderRadius={6}
          />
        )
      })()}
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
      {/* Quick CROSSFADE between the small tab title and the full
            preview. Both texts have NARROW fade windows (0.15 of
            imageCenterness each) with only a small overlap in the
            middle (~10 % of the range) so during scroll there's no
            long "both at 50%" moment where the two headers double up
            and neither reads. The tab fades 1 → 0 over
            imageCenterness 0.40 → 0.55; the preview fades 0 → 1 over
            0.45 → 0.60. */}
      {(() => {
        const TAB_FADE_START   = 0.40
        const TAB_FADE_END     = 0.55
        const PREV_FADE_START  = 0.45
        const PREV_FADE_END    = 0.60
        const ic = imageCenterness
        const scrollTabOpacity     = ic <= TAB_FADE_START ? 1
                                   : ic >= TAB_FADE_END ? 0
                                   : 1 - (ic - TAB_FADE_START) / (TAB_FADE_END - TAB_FADE_START)
        const scrollPreviewOpacity = ic <= PREV_FADE_START ? 0
                                   : ic >= PREV_FADE_END ? 1
                                   : (ic - PREV_FADE_START) / (PREV_FADE_END - PREV_FADE_START)
        // Hover OVERRIDES the scroll crossfade with a SOLID swap —
        // preview snaps to full opacity, tab title snaps to 0. No
        // half-fade intermediate state. The card pops up by less
        // than the active at high expansions (parent positioning),
        // but whatever IS revealed reads at full strength.
        const previewOpacity = isHoverActive ? 1 : scrollPreviewOpacity
        const tabOpacity     = isHoverActive ? 0 : scrollTabOpacity
        return (
          <>
            {/* Tab title — text only. Fades on its own opacity so the
                  CARET (rendered separately below) stays visible even
                  when the active card's preview takes over. */}
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: SLOT_PEEK_H,
              display: 'flex',
              alignItems: 'center',
              padding: isDeck
                ? `0 18px 0 ${showCaret ? 24 : 10}px`
                : '0 10px',
              boxSizing: 'border-box',
              opacity: tabOpacity,
              pointerEvents: 'none',
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
            {/* Full canvas-style card preview — renders the group's saved
                  cardHeaderText + cardText with their styles. Quick
                  fade so it doesn't double up with the tab title. */}
            <RolodexCardPreview group={group} opacity={previewOpacity} />
          </>
        )
      })()}
      {/* Caret toggle — rendered LAST so it stays on top of the tab
            text AND the preview overlay. Stays at full opacity at all
            scroll positions: even when this card is the active one and
            the preview takes over the tab area, the deck's
            collapse/expand control remains operable. */}
      {showCaret && (
        <div
          onClick={e => {
            e.stopPropagation()
            onToggleCollapsed()
          }}
          onPointerDown={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          title={isCollapsed ? 'Expand deck' : 'Collapse deck'}
          style={{
            position: 'absolute',
            top: (SLOT_PEEK_H - 14) / 2,
            left: 4,
            width: 14,
            height: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            borderRadius: 2,
            transition: 'background 0.1s',
            pointerEvents: 'auto',
            zIndex: 3,
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.18)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          {/* Caret SVG — points right when collapsed, down when expanded. */}
          <svg
            width="8" height="8" viewBox="0 0 8 8"
            style={{
              transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
              transition: 'transform 0.12s ease',
            }}
          >
            <path
              d="M2 1 L6 4 L2 7 Z"
              fill="rgba(255,255,255,0.85)"
            />
          </svg>
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

// Side dock attached to the LEFT edge of the Rolodex panel. Three
// buttons toggle the active-card display mode (see canvasStore's
// rolodexDisplayMode). The dock's background reuses the panel's own
// drag handler so clicking the empty area still moves the window —
// buttons stop propagation in their onPointerDown to suppress that.
// Wheel events forward to the panel's onWheel so scrolling over the
// dock advances the list, like a side control box.
const DisplayModeDock: React.FC<{
  mode: 'auto' | 'compact' | 'full'
  setMode: (m: 'auto' | 'compact' | 'full') => void
  left: number
  /** Absolute screen Y of the panel's top — this is the un-transitioned
   *  anchor, so dragging the whole window keeps the dock locked 1:1
   *  with the panel. */
  top: number
  /** Vertical offset (in px) of the dock relative to `top`. Animated
   *  via transform so the open/close slide is smooth without lagging
   *  the panel-drag motion. */
  slideOffset: number
  /** 0 = invisible, 1 = visible. Fades the dock out when the panel
   *  is fully collapsed and back in as soon as it starts opening. */
  fade: number
  onPointerDownBg: (e: React.PointerEvent) => void
  onWheel: (e: React.WheelEvent) => void
}> = ({ mode, setMode, left, top, slideOffset, fade, onPointerDownBg, onWheel }) => {
  const Btn: React.FC<{ value: 'auto' | 'compact' | 'full'; label: string; title: string }> = ({ value, label, title }) => {
    const isActive = mode === value
    return (
      <button
        title={title}
        // Stop propagation on pointerdown too — the dock background
        // is draggable, and we don't want a click on the button to
        // also initiate a panel drag.
        onPointerDown={e => e.stopPropagation()}
        onClick={() => setMode(value)}
        style={{
          width: 22, height: 22,
          background: isActive ? 'rgba(255,255,255,0.18)' : 'transparent',
          border: `1px solid rgba(255,255,255,${isActive ? 0.45 : 0.14})`,
          color: `rgba(255,255,255,${isActive ? 0.95 : 0.55})`,
          borderRadius: 3,
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 11,
          fontWeight: 700,
          lineHeight: 1,
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >{label}</button>
    )
  }
  return (
    <div
      data-rolodex-dock
      onPointerDown={onPointerDownBg}
      onWheel={onWheel}
      style={{
        position: 'fixed',
        left,
        // top tracks the panel anchor 1:1 — NO transition here, so
        // when the user drags the whole window the dock stays glued
        // to the panel without any lag.
        top,
        // The slide between "beside header" (closed) and "beside
        // active row" (open) rides on transform, not top, so it
        // animates independently of panel-drag. Pointer-events stay
        // inside the dock since the transform doesn't shift the
        // hit-test bounds anywhere weird.
        transform: `translateY(${slideOffset}px)`,
        opacity: fade,
        width: 30,
        // Frame color matches the panel's header / side rails / cabinet
        // so the dock reads as a detachable extension of the same
        // chassis. Inset highlight on the right side echoes the side-
        // rail trim; drop shadow biases left so the dock looks lifted
        // off the canvas like the panel itself.
        background: FRAME_COLOR,
        borderRadius: '6px 0 0 6px',
        padding: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        zIndex: 900,
        boxShadow: `inset -1px 0 0 ${FRAME_HIGHLIGHT}, -3px 0 6px -1px ${FRAME_SHADOW}, 0 4px 10px rgba(0,0,0,0.4)`,
        userSelect: 'none',
        // transform → slide animation. opacity → fade when fully
        // collapsed. Neither affects `top`, so the panel-drag stays
        // synchronous and 1:1.
        transition: 'transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease',
        // Don't capture pointer events while invisible — otherwise
        // the user could still click an invisible dock by accident.
        pointerEvents: fade < 0.05 ? 'none' : 'auto',
      }}
    >
      <Btn value="compact" label="≡" title="Compact — all rows as peek tabs, active never grows" />
      <Btn value="full" label="▣" title="Full — active card always at hero size when possible" />
      <Btn value="auto" label="A" title="Auto — drag the cabinet to control active growth" />
    </div>
  )
}

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
