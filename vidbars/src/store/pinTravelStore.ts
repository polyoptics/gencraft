// pinTravelStore — the streak a card leaves when it stops being pinned.
//
// Unpinning moves a card from a screen position to a canvas one, and those
// two places are usually nowhere near each other: the card vanishes from
// under your cursor and reappears somewhere off in the world, or nowhere
// visible at all. The line is the only thing that says WHERE it went. It is
// pure feedback — nothing reads it back, nothing persists it, and losing one
// costs nothing, which is why it lives outside the boards store rather than
// becoming another field on the group.

import { create } from 'zustand'

export type TravelLine = {
  id: number
  /** Screen px — where the card was pinned. */
  from: { x: number; y: number }
  /** Screen px — where it landed on the canvas. May be off-screen; the line
   *  still points at it, which is the useful part. */
  to: { x: number; y: number }
  color: string
}

/** Long enough to follow, short enough not to sit on top of the next action. */
export const TRAVEL_MS = 650

type State = {
  lines: TravelLine[]
  emitTravel: (from: { x: number; y: number }, to: { x: number; y: number }, color: string) => void
}

let seq = 0

export const usePinTravelStore = create<State>((set) => ({
  lines: [],
  emitTravel: (from, to, color) => {
    // A card that lands within a few pixels of where it was pinned has not
    // travelled; drawing a stub there is noise, not feedback.
    if (Math.hypot(to.x - from.x, to.y - from.y) < 24) return
    const id = ++seq
    set(s => ({ lines: [...s.lines, { id, from, to, color }] }))
    setTimeout(() => set(s => ({ lines: s.lines.filter(l => l.id !== id) })), TRAVEL_MS)
  },
}))
