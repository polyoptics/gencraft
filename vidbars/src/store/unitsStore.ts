// unitsStore.ts — the units heights are written and shown in, for the
// whole app (Brian 2026-11-19: "The heights on the model cards are also
// in feet. And the character card height is in centimeters. I think we
// should have a metric, not metric mode"). One switch: feet and inches,
// or metric. A Height on a card's back is shown in it however it was
// typed (utils/stickGeom heightAsUnit), a measuring stick reads in it,
// and a height a tool writes is written in it. Kept with the browser
// (not the project): it is how he reads, not what the cards say.

import { create } from 'zustand'

const KEY = 'vidbars.units.metric'
function load(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

interface Units { metric: boolean; setMetric: (metric: boolean) => void }
export const useUnits = create<Units>(set => ({
  metric: load(),
  setMetric: metric => {
    try { localStorage.setItem(KEY, metric ? '1' : '0') } catch { /* private window */ }
    set({ metric })
  },
}))
