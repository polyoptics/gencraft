/**
 * Tiny pen-icon toggle button — appears on every drawable surface (card,
 * block, bar, free node) and arms / disarms draw mode for that surface.
 *
 * Color is brightened from the host element's base color via edgeColor() so
 * the button sits in the visual family of its container instead of feeling
 * like a generic chrome button.
 */
import React from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { sameSurface, type DrawSurface } from '../../types/stroke'
import { edgeColorFromHex } from '../../utils/colorUtils'

interface Props {
  surface: DrawSurface
  /** Base color of the host element — used to tint the button. */
  baseColor: string
  /** Optional pixel size; defaults to 18. */
  size?: number
  /** Optional className for layout/positioning by the host. */
  style?: React.CSSProperties
  /** Reveal-on-hover gate. When false the button fades out and stops
   *  receiving pointer events. Active draw mode on this surface overrides
   *  it so the toggle stays clickable to exit draw mode. Defaults to true
   *  for callers that want the old always-visible behavior. */
  visible?: boolean
}

export const PenButton: React.FC<Props> = ({
  surface, baseColor, size = 18, style, visible = true,
}) => {
  const activeSurface = useCanvasStore(s => s.drawSurface)
  const setSurface = useCanvasStore(s => s.setDrawSurface)
  const isActive = sameSurface(activeSurface, surface)

  // Track direct hover on the button itself for the "lit up" emphasis,
  // mirroring the existing X / grip pattern on bars at board zoom (default
  // → host hovered → button hovered = three brightness steps).
  const [isButtonHovered, setIsButtonHovered] = React.useState(false)

  // Active state always wins for visibility — the user needs the button to
  // exit draw mode even when their mouse leaves the host briefly.
  const shouldShow = visible || isActive

  // Color tints scale across three states:
  //   inactive + not direct-hover → faint (matches the dim default of
  //                                         the X/grip on a bar)
  //   inactive + direct-hover     → "lit up" — fuller saturation
  //   active                      → full brightness, marker for armed state
  const lit = isActive || isButtonHovered
  const tint   = edgeColorFromHex(baseColor, isActive ? 0.95 : lit ? 0.85 : 0.55)
  const bg     = edgeColorFromHex(baseColor, isActive ? 0.30 : lit ? 0.22 : 0.10)
  const border = edgeColorFromHex(baseColor, isActive ? 0.70 : lit ? 0.55 : 0.25)

  return (
    <button
      title={isActive ? 'Exit draw mode' : 'Annotate (draw on this surface)'}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation()
        setSurface(isActive ? null : surface)
      }}
      onMouseEnter={() => setIsButtonHovered(true)}
      onMouseLeave={() => setIsButtonHovered(false)}
      style={{
        width: size,
        height: size,
        // 'flex' (not inline-flex) so the button doesn't sit on a text
        // baseline and pick up descender space below it. lineHeight: 1
        // and verticalAlign: 'top' eliminate any inherited line-box that
        // could shift the rendered button below where 'top' positions it.
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 4,
        color: tint,
        // Hidden by default; opacity-fade in/out on hover. pointer-events
        // gates clickability so the invisible button never absorbs clicks
        // meant for whatever's underneath.
        opacity: shouldShow ? 1 : 0,
        pointerEvents: shouldShow ? 'auto' : 'none',
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
        boxSizing: 'border-box',
        lineHeight: 1,
        verticalAlign: 'top',
        transition: 'opacity 0.12s, background 0.12s, border-color 0.12s, color 0.12s',
        ...style,
      }}
    >
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 16 16" fill="none">
        <path
          d="M11 2.5 L13.5 5 L5 13.5 L2 14 L2.5 11 L11 2.5 Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </button>
  )
}
