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
import type { ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { HeroImageLayer } from '../Layers/HeroImageLayer'
import { edgeColorFromHex } from '../../utils/colorUtils'

const SLOT_W = 180
// Each card is a TALL rectangle with a rounded top; only its top ~SLOT_PEEK_H
// shows when tucked under the next card down (the visible "tab"). The full
// CARD_H extends below into the territory the next card covers.
const CARD_H = 90
const SLOT_PEEK_H = 30
const VISIBLE_RADIUS = 5         // slots above/below center → 11 total visible
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
const PREVIEW_W = 240
const PREVIEW_H = 340
const PANEL_PAD = 12
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

// ─── Main panel ────────────────────────────────────────────────

export const CardRolodex: React.FC = () => {
  const isOpen = useCanvasStore(s => s.rolodexOpen)
  const sortMode = useCanvasStore(s => s.rolodexSortMode)
  const setSortMode = useCanvasStore(s => s.setRolodexSortMode)
  const setRolodexOpen = useCanvasStore(s => s.setRolodexOpen)
  const groups = useBoardsStore(s => s.groups)
  const jumpToGroup = useCanvasStore(s => s.jumpToGroup)

  // Sort the groups based on mode. Creation order is the natural order of the
  // groups array (newest at the end); alphabetical is by name.
  const sortedGroups = useMemo(() => {
    const list = [...groups]
    if (sortMode === 'alphabetical') {
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    }
    return list
  }, [groups, sortMode])

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
    positionRef.current += diff * TWEEN_EASE
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
    if (sortedGroups.length === 0) {
      targetRef.current = 0
      positionRef.current = 0
      bumpRender()
      return
    }
    const max = sortedGroups.length - 1
    if (targetRef.current > max) {
      targetRef.current = max
      startTween()
    }
  }, [sortedGroups.length, bumpRender, startTween])

  // ── Wheel scroll ──
  // One wheel tick = one row of TARGET advance. The eased rAF loop handles
  // the visual smoothness, so no throttle needed: even rapid spins read as
  // a fluid roll because the position keeps chasing whatever target the
  // wheel last landed on.
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (sortedGroups.length === 0) return
    const dir = e.deltaY > 0 ? 1 : -1
    const max = sortedGroups.length - 1
    targetRef.current = Math.max(0, Math.min(max, targetRef.current + dir))
    startTween()
  }, [sortedGroups.length, startTween])

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
  const centerGroup = sortedGroups[previewIndex] ?? null

  // ── Lay out the visible stack via prefix-sums ─────────────
  // Each card's "size" (visible height of its top tab) is a bell-bonus around
  // the fractional center. We prefix-sum sizes to get card top positions.
  // Then we shift the whole stack so that the FRACTIONAL center P lands at
  // a fixed Y in the list area — this is what gives "during a tween, the
  // active card grows toward center" since multiple cards' sizes are in
  // partial bonus simultaneously.
  const visibleStart = Math.max(0, Math.floor(centerPosition - VISIBLE_RADIUS - 1))
  const visibleEnd   = Math.min(sortedGroups.length - 1, Math.ceil(centerPosition + VISIBLE_RADIUS + 1))
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
  // the tab itself is centered in the visible viewport.
  const anchorY = LIST_AREA_H / 2 - SLOT_PEEK_H / 2
  const yShift = anchorY - PfracRawY

  return (
    <>
      <div
        data-rolodex
        onWheel={onWheel}
        // Stop pan/clicks from leaking to the canvas behind the panel.
        onPointerDown={e => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: 12,
          top: 60,
          background: 'rgba(20,22,38,0.96)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 12,
          padding: PANEL_PAD,
          boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 10,
          fontFamily: 'inherit',
          zIndex: 900,
          userSelect: 'none',
        }}
      >
        {/* ── Left column: header + slot list + footer ── */}
        <div style={{
          width: SLOT_W,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}>
          {/* Header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 4px 6px',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
          }}>
            <span style={{
              color: 'rgba(255,255,255,0.85)',
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: '0.6px',
            }}>CARDS</span>
            <div style={{ display: 'flex', gap: 4 }}>
              <SortToggle mode={sortMode} setMode={setSortMode} />
              <CloseButton onClick={() => setRolodexOpen(false)} />
            </div>
          </div>

          {/* Slot list — fixed height, slots positioned absolutely so they
              animate via translateY when centerIndex changes */}
          <div style={{
            position: 'relative',
            width: '100%',
            height: LIST_AREA_H,
            overflow: 'hidden',
          }}>
            {sortedGroups.length === 0 ? (
              <EmptyState onAdd={startPlacement} />
            ) : (
              visibleIndices.map((idx, i) => {
                const g = sortedGroups[idx]
                const offset = idx - centerPosition
                return (
                  <RolodexSlot
                    key={g.id}
                    group={g}
                    offset={offset}
                    top={rawTops[i] + yShift}
                    zIndex={idx + 1}
                    onClick={() => onSlotClick(idx)}
                    onDoubleClick={() => onSlotDoubleClick(g)}
                  />
                )
              })
            )}
          </div>

          {/* Footer: + new card button */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            paddingTop: 6,
            borderTop: '1px solid rgba(255,255,255,0.1)',
          }}>
            <button
              onClick={startPlacement}
              title="Place a new card on the canvas"
              style={{
                background: 'rgba(120,170,255,0.18)',
                border: '1px solid rgba(120,170,255,0.4)',
                color: 'rgba(255,255,255,0.85)',
                borderRadius: 6,
                padding: '4px 14px',
                fontSize: 14,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >+</button>
          </div>
        </div>

        {/* ── Right column: preview pane (only when there's a center card) ── */}
        {centerGroup && (
          <CardPreview group={centerGroup} />
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
}> = ({ group, offset, top, zIndex, onClick, onDoubleClick }) => {
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
        left: '50%',
        top,
        transform: 'translateX(-50%)',
        width: SLOT_W,
        height: CARD_H,
        background: group.color,
        // Rounded TOP only — bottom is tucked under the next card and never
        // visible (except for the bottommost card, which gets clipped by
        // the LIST_AREA_H overflow).
        borderRadius: '7px 7px 0 0',
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
      {/* Content lives in the top SLOT_PEEK_H "tab" region — that's the
            part visible when this card is tucked. */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        height: SLOT_PEEK_H,
        display: 'flex',
        alignItems: 'center',
        padding: '0 10px',
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
  return (
    <div
      key={group.id}                                          // key swap → fade-in on change
      style={{
        width: PREVIEW_W,
        height: PREVIEW_H,
        background: group.color,
        borderRadius: 12,
        border: '1.5px solid rgba(255,255,255,0.25)',
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
      {/* Hero image at low-ish opacity so the color tint shows */}
      {group.cardHeroImage && (
        <HeroImageLayer
          heroImage={group.cardHeroImage}
          transform={group.cardHeroTransform}
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

const SortToggle: React.FC<{
  mode: 'creation' | 'alphabetical'
  setMode: (m: 'creation' | 'alphabetical') => void
}> = ({ mode, setMode }) => (
  <button
    onClick={() => setMode(mode === 'creation' ? 'alphabetical' : 'creation')}
    title={mode === 'creation' ? 'Sort: creation order — click to switch' : 'Sort: alphabetical — click to switch'}
    style={{
      background: 'transparent',
      border: '1px solid rgba(255,255,255,0.18)',
      color: 'rgba(255,255,255,0.7)',
      borderRadius: 4,
      padding: '2px 6px',
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.5px',
      cursor: 'pointer',
      fontFamily: 'inherit',
    }}
  >{mode === 'creation' ? '#' : 'A→Z'}</button>
)

const CloseButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    onClick={onClick}
    title="Hide Cards panel"
    style={{
      background: 'transparent',
      border: '1px solid rgba(255,255,255,0.18)',
      color: 'rgba(255,255,255,0.7)',
      borderRadius: 4,
      width: 22,
      height: 22,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 13,
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
