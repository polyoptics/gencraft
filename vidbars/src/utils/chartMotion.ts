// A chart folding into its card, and coming back out (Brian 2026-11-05:
// "Maybe all the points drop, and the line slides into the side"). Only how
// the storyline is DRAWN moves (StorylineLayer reads this); its saved dots
// stay as they are.
//
// drop  0..1: dots off the base line come down to it (1 = all on it).
// slide 0..1: the dropped line slides into the card's side (1 = all at `to`).

import { create } from 'zustand'
import { rootOf, type StorylineData } from './storyline'

export interface ChartMotion { drop: number; slide: number; to: { x: number; y: number } }

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
  if (!m || (!m.drop && !m.slide)) return d
  const by = baseYOf(d)
  return {
    ...d,
    dots: d.dots.map(p => {
      const x = p.x, y = p.y + (by - p.y) * m.drop
      return { ...p, x: x + (m.to.x - x) * m.slide, y: y + (m.to.y - y) * m.slide }
    }),
  }
}

export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** Runs `frame` with eased 0..1 over `ms` (the first frame at once, so
 *  nothing shows a frame early), then `done`. */
export function play(ms: number, frame: (k: number) => void, done?: () => void): void {
  frame(0)
  const t0 = performance.now()
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / ms)
    frame(ease(t))
    if (t < 1) requestAnimationFrame(step)
    else done?.()
  }
  requestAnimationFrame(step)
}
