// CanvasMirror — show an off-DOM canvas (an effect result) without encoding
// it: copy its pixels into this component's own canvas whenever it changes.
// A canvas element can only live in one place in the DOM, and the same
// result is shown by a card AND a Viewer, so each gets a copy.
//
// `maxSide` keeps the copy no larger than it is drawn. A canvas shown much
// smaller than its pixels is shrunk by the compositor with plain bilinear
// sampling — no mipmaps, unlike an <img> — so a 1400-px result in a 200-px
// tile comes out grainy and aliased. Halving step by step with high-quality
// smoothing gives the same clean downscale an image gets.

import React, { useEffect, useRef } from 'react'

/** Draw `source` into `dest` at most `maxSide` on its long edge, halving in
 *  steps so each draw shrinks by at most 2× (bilinear stays clean at 2×). */
function drawDownscaled(dest: HTMLCanvasElement, source: HTMLCanvasElement, maxSide: number) {
  const long = Math.max(source.width, source.height)
  const k = Math.min(1, maxSide / long)
  const w = Math.max(1, Math.round(source.width * k))
  const h = Math.max(1, Math.round(source.height * k))
  let cur: HTMLCanvasElement = source
  while (cur.width / 2 >= w * 1.0001 && cur.height / 2 >= h * 1.0001) {
    const half = document.createElement('canvas')
    half.width = Math.ceil(cur.width / 2)
    half.height = Math.ceil(cur.height / 2)
    const hc = half.getContext('2d')!
    hc.imageSmoothingQuality = 'high'
    hc.drawImage(cur, 0, 0, half.width, half.height)
    cur = half
  }
  dest.width = w
  dest.height = h
  const ctx = dest.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(cur, 0, 0, w, h)
}

export const CanvasMirror: React.FC<{
  source: HTMLCanvasElement | null
  style?: React.CSSProperties
  /** Long edge, in pixels, of the copy. Omit for a full-size copy. Callers
   *  that track zoom should round it (to a power of two, say) so a wheel
   *  tick does not redraw. */
  maxSide?: number
}> = ({ source, style, maxSide }) => {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c || !source || source.width === 0 || source.height === 0) return
    if (maxSide && maxSide < Math.max(source.width, source.height)) {
      drawDownscaled(c, source, maxSide)
      return
    }
    c.width = source.width
    c.height = source.height
    c.getContext('2d')!.drawImage(source, 0, 0)
  }, [source, maxSide])
  if (!source) return null
  return <canvas ref={ref} style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', ...style }} />
}
