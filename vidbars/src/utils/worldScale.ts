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
//
// Clicked, the icon opens the lineup (components/UI/WorldScaleLine; Brian
// 2026-11-19: "If I click the world scale, it should pop up on the bottom
// of the screen, like growing right out from its icon. Then, if I was to
// click cards on the canvas ... the height would show up there. The
// models could line up"): `open`, the cards standing on it (`line`, card
// ids, for this sitting only) and how many feet tall it shows (`lineFt`).
//
// Once it is set, a model on a card with a Height stands that tall by it
// in the 3D view (TiltModels frameState), times its card's Emphasis
// (utils/stickDock), unless `trueSize` is on: every emphasis ignored
// (Brian 2026-11-19: "its display should be linked to that, to whatever
// that global height stick is"). Not one docked to a measuring stick,
// which goes by that stick, nor one standing in a 3D set.

import { create } from 'zustand'

const KEY = 'vidbars.worldScale'
/** Canvas units a foot with no world scale set yet. */
export const WORLD_PER_DEFAULT = 200
export const FADE_FT_DEFAULT = 15, FADE_FT_MIN = 1, FADE_FT_MAX = 5000
export const LINE_FT_DEFAULT = 8, LINE_FT_MIN = 1, LINE_FT_MAX = 5000

interface Kept { per: number | null; fadeFt: number; fadeOn: boolean; lineFt: number; trueSize: boolean }
function load(): Kept {
  const k: Kept = { per: null, fadeFt: FADE_FT_DEFAULT, fadeOn: true, lineFt: LINE_FT_DEFAULT, trueSize: false }
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Kept> | null
    if (p) {
      if (typeof p.per === 'number' && Number.isFinite(p.per) && p.per > 0) k.per = p.per
      if (typeof p.fadeFt === 'number' && Number.isFinite(p.fadeFt)) k.fadeFt = Math.max(FADE_FT_MIN, Math.min(FADE_FT_MAX, p.fadeFt))
      if (typeof p.fadeOn === 'boolean') k.fadeOn = p.fadeOn
      if (typeof p.trueSize === 'boolean') k.trueSize = p.trueSize
      if (typeof p.lineFt === 'number' && Number.isFinite(p.lineFt)) k.lineFt = Math.max(LINE_FT_MIN, Math.min(LINE_FT_MAX, p.lineFt))
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
  /** The lineup: out or not, the cards standing on it, in the order they
   *  came, and how many feet tall it shows. */
  open: boolean
  line: string[]
  setOpen: (open: boolean) => void
  join: (ids: string[]) => void
  leave: (id: string) => void
  setLineFt: (ft: number) => void
  /** Every model at its true height: emphasis ignored. */
  setTrueSize: (on: boolean) => void
}
export const useWorldScale = create<WorldScale>((set, get) => {
  const keep = (p: Partial<Kept>) => {
    set(p)
    const { per, fadeFt, fadeOn, lineFt, trueSize } = get()
    try { localStorage.setItem(KEY, JSON.stringify({ per, fadeFt, fadeOn, lineFt, trueSize })) } catch { /* private window */ }
  }
  return {
    ...load(),
    hot: false,
    setHot: hot => { if (get().hot !== hot) set({ hot }) },
    setPer: per => { if (Number.isFinite(per) && per > 0) keep({ per }) },
    setFadeFt: ft => { if (Number.isFinite(ft)) keep({ fadeFt: Math.max(FADE_FT_MIN, Math.min(FADE_FT_MAX, ft)) }) },
    setFadeOn: fadeOn => keep({ fadeOn }),
    open: false,
    line: [],
    setOpen: open => set({ open }),
    join: ids => { const add = ids.filter((id, i) => !get().line.includes(id) && ids.indexOf(id) === i); if (add.length) set({ line: [...get().line, ...add] }) },
    leave: id => set({ line: get().line.filter(x => x !== id) }),
    setTrueSize: trueSize => keep({ trueSize }),
    setLineFt: ft => { if (Number.isFinite(ft)) keep({ lineFt: Math.max(LINE_FT_MIN, Math.min(LINE_FT_MAX, ft)) }) },
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
