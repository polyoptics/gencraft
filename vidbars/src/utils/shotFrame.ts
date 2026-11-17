// shotFrame.ts — where a shot sits in a frame of another shape.
//
// A Rough Cut's frame (roughCut.ts) holds shots of any shape: each fills it
// (its overhang cut off) or is fitted inside it, and can then be zoomed in
// and slid about inside the frame. The Rough Cut's screens, a GIF and a
// movie all place a shot with the same sums (electron/cutMovie.cjs keeps a
// copy of placeInFrame: keep them in step).

/** A shot's own zoom and place in its frame: `zoom` 1 and up, over its fill
 *  or fit; `x`, `y` how far its middle is from the frame's, in frame widths
 *  and heights. */
export interface ShotView { zoom?: number; x?: number; y?: number }

export const VIEW_ZOOM_MAX = 8

/** Where a shot sw × sh is drawn in a frame W × H: its size, and its top-left
 *  corner. It slides only as far as its slack: a shot larger than the frame
 *  never shows a gap, a smaller one never leaves it. */
export function placeInFrame(sw: number, sh: number, W: number, H: number, fill: boolean | undefined, v?: ShotView): { w: number; h: number; x: number; y: number } {
  const zoom = Math.max(1, Math.min(VIEW_ZOOM_MAX, v?.zoom || 1))
  const s = (fill ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh)) * zoom
  const w = sw * s, h = sh * s
  const mx = Math.abs(w - W) / 2, my = Math.abs(h - H) / 2
  const cx = Math.max(-mx, Math.min(mx, (v?.x || 0) * W))
  const cy = Math.max(-my, Math.min(my, (v?.y || 0) * H))
  return { w, h, x: (W - w) / 2 + cx, y: (H - h) / 2 + cy }
}

/** A view kept inside its slack, as placeInFrame would draw it; undefined when it is no change at all. */
export function tidyView(sw: number, sh: number, aspect: number, fill: boolean | undefined, v: ShotView): ShotView | undefined {
  const zoom = Math.max(1, Math.min(VIEW_ZOOM_MAX, v.zoom || 1))
  const p = placeInFrame(sw, sh, aspect, 1, fill, { ...v, zoom })
  const x = (p.x + p.w / 2 - aspect / 2) / aspect, y = p.y + p.h / 2 - 0.5
  if (zoom === 1 && Math.abs(x) < 1e-4 && Math.abs(y) < 1e-4) return undefined
  return { zoom, x, y }
}
