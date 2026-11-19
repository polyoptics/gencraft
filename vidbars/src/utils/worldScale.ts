// The world scale (Brian 2026-11-19: "beside the world clock on the
// bottom, we want to keep a world scale too. And that can be me just
// taking one of my distance timelines and dragging it over that icon in
// the bottom left. Then I sort of have an overall scene scale").
//
// How big a foot is on the canvas, for the whole world. A measuring stick
// dragged onto the icon left of the world clock (components/UI/WorldClock)
// gives it: the stick's own scale as it is at that moment is copied, and
// the stick goes back where it was. It is a copy, never a link: scaling
// that stick afterwards changes nothing here, until it is dropped again.
//
// What reads it: the 3D view's far fade (TiltModels farNow), which keeps
// `fadeFt` feet of the world round the middle of the view, a fixed size on
// the canvas whatever the zoom ("I always wanted to have that
// original-sized zone"). Its distance and its on/off are under Camera Lens
// (ViewCube). Kept with the browser, as the units are (store/unitsStore).

import { create } from 'zustand'

const KEY = 'vidbars.worldScale'
/** Canvas units a foot with no world scale set yet. */
export const WORLD_PER_DEFAULT = 200
export const FADE_FT_DEFAULT = 15, FADE_FT_MIN = 1, FADE_FT_MAX = 5000

interface Kept { per: number | null; fadeFt: number; fadeOn: boolean }
function load(): Kept {
  const k: Kept = { per: null, fadeFt: FADE_FT_DEFAULT, fadeOn: true }
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Kept> | null
    if (p) {
      if (typeof p.per === 'number' && Number.isFinite(p.per) && p.per > 0) k.per = p.per
      if (typeof p.fadeFt === 'number' && Number.isFinite(p.fadeFt)) k.fadeFt = Math.max(FADE_FT_MIN, Math.min(FADE_FT_MAX, p.fadeFt))
      if (typeof p.fadeOn === 'boolean') k.fadeOn = p.fadeOn
    }
  } catch { /* private window, or not ours */ }
  return k
}

interface WorldScale extends Kept {
  /** A measuring stick is being dragged over the icon: it lights to take it. */
  hot: boolean
  setHot: (hot: boolean) => void
  /** The world's scale, canvas units a foot (a stick's `per`, copied). */
  setPer: (per: number) => void
  setFadeFt: (ft: number) => void
  setFadeOn: (on: boolean) => void
}
export const useWorldScale = create<WorldScale>((set, get) => {
  const keep = (p: Partial<Kept>) => {
    set(p)
    const { per, fadeFt, fadeOn } = get()
    try { localStorage.setItem(KEY, JSON.stringify({ per, fadeFt, fadeOn })) } catch { /* private window */ }
  }
  return {
    ...load(),
    hot: false,
    setHot: hot => { if (get().hot !== hot) set({ hot }) },
    setPer: per => { if (Number.isFinite(per) && per > 0) keep({ per }) },
    setFadeFt: ft => { if (Number.isFinite(ft)) keep({ fadeFt: Math.max(FADE_FT_MIN, Math.min(FADE_FT_MAX, ft)) }) },
    setFadeOn: fadeOn => keep({ fadeOn }),
  }
})

/** Canvas units a foot of the world. */
export const worldPer = (s: { per: number | null }) => s.per ?? WORLD_PER_DEFAULT

/** Is screen point (x, y) on the world scale's icon? */
export function overWorldScale(x: number, y: number): boolean {
  const el = document.querySelector('[data-world-scale-drop]')
  if (!el) return false
  const r = el.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}
