// A chart folding into its card, and coming back out (Brian 2026-11-05:
// "Maybe all the points drop, and the line slides into the side"). Only how
// the storyline is DRAWN moves (StorylineLayer reads this); its saved dots
// stay as they are.
//
// drop  0..1: dots off the base line come down to it (1 = all on it).
// slide 0..1: the dropped line slides sideways into the card's side, at its
//   own height (1 = all at `to.x`).
// lead 0..1: the start dot's way to the card's side (1 = at `to.x`).
// tether 0..1: how far each card's tether reaches from its dot to the card.

import { create } from 'zustand'
import { rootOf, type StorylineData } from './storyline'

export interface ChartMotion { drop: number; slide: number; to: { x: number; y: number }; tether?: number; lead?: number }

export const useChartMotion = create<{ m: Record<string, ChartMotion> }>(() => ({ m: {} }))

export function setChartMotion(id: string, v: ChartMotion | null): void {
  useChartMotion.setState(s => {
    const m = { ...s.m }
    if (v) m[id] = v
    else delete m[id]
    return { m }
  })
}

/** The base line's height (node units). */
export function baseYOf(d: StorylineData): number {
  const start = d.base?.[0] ?? rootOf(d)
  return d.dots.find(p => p.id === start)?.y ?? d.dots[0]?.y ?? 0
}

/** The storyline as drawn part way through motion `m`. */
export function morphStoryline(d: StorylineData, m: ChartMotion | undefined): StorylineData {
  if (!m || (!m.drop && !m.slide && !m.lead)) return d
  const by = baseYOf(d)
  // Its start dot (and the grab handle beside it) pops out of the card's
  // side first, as one quick move (`lead`); then the rest grows out of it
  // sideways (`slide`), at the base line's own height (Brian 2026-11-05:
  // "it goes pop pop").
  const start = d.base?.[0] ?? rootOf(d)
  const s0 = d.dots.find(p => p.id === start)
  const sx = s0 ? s0.x + (m.to.x - s0.x) * (m.lead ?? m.slide) : m.to.x
  return {
    ...d,
    dots: d.dots.map(p => {
      const y = p.y + (by - p.y) * m.drop
      return { ...p, x: p.id === start ? sx : p.x + (sx - p.x) * m.slide, y }
    }),
  }
}

/** Runs `frame` with time 0..1 over `ms` (the first frame at once, so
 *  nothing shows a frame early; `at` in ms), then `done`. Timed by an animation clock,
 *  the same one the cards' own animations run on, so the line and the
 *  cards keep together. */
export function play(ms: number, frame: (t: number, at: number) => void, done?: () => void): void {
  frame(0, 0)
  const clock = document.documentElement.animate([], { duration: ms })
  let over = false
  const step = () => {
    if (over) return
    const at = Math.min(ms, Number(clock.currentTime ?? 0))
    frame(at / ms, at)
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
  clock.finished.then(() => { over = true; frame(1, ms); done?.() }, () => { over = true; done?.() })
}
