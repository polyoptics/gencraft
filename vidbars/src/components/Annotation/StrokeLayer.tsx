/**
 * Renders a list of strokes as an SVG overlay sized to the host surface.
 *
 * Coords in `Stroke.points` are normalized 0–1; we multiply by `width`/`height`
 * when generating the SVG path. Each stroke becomes one perfect-freehand polygon.
 *
 * Used in two places:
 *  - As the static layer showing a surface's saved strokes (always visible).
 *  - As the live preview while a stroke is in progress (DrawableSurface).
 *
 * Pure presentational — no event handlers, no store reads.
 */
import React from 'react'
import { getStroke } from 'perfect-freehand'
import type { Stroke } from '../../types/stroke'

interface Props {
  strokes: Stroke[]
  width: number
  height: number
  /** Optional opacity for the whole layer (e.g. to dim while erasing). */
  opacity?: number
}

/** Convert perfect-freehand's polygon output into an SVG path string. */
function toSvgPath(points: number[][]): string {
  if (points.length < 2) return ''
  const d = points.reduce(
    (acc, [x, y], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length]
      acc += `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)},${y.toFixed(2)} Q ${x.toFixed(2)},${y.toFixed(2)} ${((x + x1) / 2).toFixed(2)},${((y + y1) / 2).toFixed(2)} `
      return acc
    },
    '',
  )
  return d + ' Z'
}

/** Tool-specific tuning fed into perfect-freehand. */
function getStrokeOptions(stroke: Stroke) {
  // Higher streamline = smoother lines but more lag; thinning controls how
  // much pressure modulates width. Tuned for a "pen feel" by default.
  const base = {
    size: stroke.size,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    easing: (t: number) => t,
    last: true,
  }
  if (stroke.tool === 'highlighter') {
    return { ...base, thinning: 0.0, smoothing: 0.4, streamline: 0.5 }
  }
  if (stroke.tool === 'marker') {
    return { ...base, thinning: 0.3, smoothing: 0.6, streamline: 0.5 }
  }
  return base
}

export const StrokeLayer: React.FC<Props> = ({ strokes, width, height, opacity = 1 }) => {
  if (strokes.length === 0) return null
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        opacity,
        overflow: 'visible',
      }}
    >
      {strokes.map(stroke => {
        const denormalized = stroke.points.map(p => [
          p.x * width,
          p.y * height,
          p.pressure,
        ] as [number, number, number])
        const polygon = getStroke(denormalized, getStrokeOptions(stroke))
        const d = toSvgPath(polygon)
        const fill = stroke.tool === 'highlighter'
          ? hexToRgba(stroke.color, 0.35)
          : stroke.color
        return <path key={stroke.id} d={d} fill={fill} stroke="none" />
      })}
    </svg>
  )
}

/** Cheap hex → rgba(...) for highlighter alpha. Accepts #rgb, #rrggbb, or rgba already. */
function hexToRgba(color: string, alpha: number): string {
  if (color.startsWith('rgba(') || color.startsWith('rgb(')) return color
  const hex = color.replace('#', '')
  const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex
  const n = parseInt(full, 16)
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${alpha})`
}
