// fxStore — the live state of every effect strip on the canvas. Transient
// (never persisted): it is all derived from tile positions, so it is
// recomputed rather than saved (CLAUDE.md: derived links are never stored).
// useFxStrips writes it; effect cards, source pictures and Viewers read it.

import { create } from 'zustand'
import { planChain, type ChainItem, type ChainResult } from '../utils/fx/chain'

export interface FxStrip {
  /** Stable while the strip keeps its members: the id of its first ITEM
   *  in read order (not of the first tile — a collapsed deck's face can be
   *  a note that adds no item, and collapsing must not re-key the strip). */
  key: string
  /** Left to right, as read (sources, effects, blend partners). Hidden
   *  members of a collapsed deck read at their face's place. */
  items: ChainItem[]
  /** Every tile on the strip: each item's tile — hidden deck members
   *  included — plus any deck face that adds no item of its own. NOT
   *  index-aligned with `items`. */
  memberIds: string[]
  /** The Viewer this strip touches, which shows its output. */
  windowId: string | null
  /** The last effect card in read order (possibly a hidden deck member). */
  lastEffectId: string | null
  result: ChainResult | null
  running: boolean
}

interface FxState {
  strips: Record<string, FxStrip>
  /** Which strip each member tile belongs to. */
  byNode: Record<string, string>
  /** Source picture node id → key of the strip it is the SOURCE of (leading
   *  batch only — not blend partners, not ignored tiles): the pictures that
   *  show a processed result. Rebuilt in setStrips from planChain. */
  sources: Record<string, string>
  /** Per source picture: true ⇒ show (and drag) the ORIGINAL instead of the
   *  processed result. Transient like the rest, but kept here rather than in
   *  the tile: a zoom-layer switch remounts every FreeNode, and the choice
   *  must survive that. Not cleared when a picture leaves its strip, so
   *  nudging it off and back does not lose it. */
  bypass: Record<string, boolean>
  setStrips: (strips: Record<string, FxStrip>) => void
  patchStrip: (key: string, patch: Partial<FxStrip>) => void
  setBypass: (nodeId: string, on: boolean) => void
}

export const useFxStore = create<FxState>(set => ({
  strips: {},
  byNode: {},
  sources: {},
  bypass: {},
  setStrips: strips => {
    const byNode: Record<string, string> = {}
    const sources: Record<string, string> = {}
    for (const s of Object.values(strips)) {
      for (const id of s.memberIds) byNode[id] = s.key
      // planChain is pure and cheap; this runs only when a strip's makeup
      // changed, not per drag frame.
      for (const src of planChain(s.items).sources) sources[src.id] = s.key
    }
    set({ strips, byNode, sources })
  },
  patchStrip: (key, patch) => set(s => s.strips[key] ? { strips: { ...s.strips, [key]: { ...s.strips[key], ...patch } } } : s),
  setBypass: (nodeId, on) => set(s => {
    if (!!s.bypass[nodeId] === on) return s
    const bypass = { ...s.bypass }
    if (on) bypass[nodeId] = true
    else delete bypass[nodeId]
    return { bypass }
  }),
}))
