/** Keep zoomed layers crisp.
 *
 *  A layer with `will-change: transform` is rastered once, at the scale it
 *  had then, and Chromium keeps stretching that bitmap as the zoom changes:
 *  card text (FX cards most of all) went grainy at many zooms until another
 *  zoom happened to re-raster it (Brian 2026-10-31). So the hint is only on
 *  while the view is moving, which keeps a pan or zoom cheap, and comes off
 *  once it rests: the layer is then painted again at the scale on screen.
 *
 *  `markMoving(el)` sets `data-moving` on `el` and clears it SETTLE_MS after
 *  the last call; index.css turns will-change on only under `data-moving`
 *  (the world layers marked `data-raster-layer`, and a tilted stage). */
export const SETTLE_MS = 160

const timers = new WeakMap<HTMLElement, number>()

export function markMoving(el: HTMLElement | null | undefined) {
  if (!el) return
  const t = timers.get(el)
  if (t !== undefined) clearTimeout(t)
  else el.setAttribute('data-moving', '')
  timers.set(el, window.setTimeout(() => {
    timers.delete(el)
    el.removeAttribute('data-moving')
  }, SETTLE_MS))
}
