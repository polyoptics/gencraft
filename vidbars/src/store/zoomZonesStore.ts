// zoomZonesStore — the ONE source for where the three zoom levels begin and
// end: Cards (zoomed out) ≤ cardMax < Blocks < blockMax ≤ Boards (zoomed in).
//
// Every value that depends on which level you are looking at — which layer
// LayerRouter mounts, the "New card / block / node" button, rubber-band
// selection, copy, drop targets, the block toolbar's scale ramp, the zoom
// targets of link chips and templates — reads the boundaries from here. The
// ZoomZoneBar drags them, so moving a boundary moves all of those together.
//
// What deliberately does NOT follow the boundaries: card text and chip
// scaling (zoom / CARD_TEXT_REF_ZOOM). That ratio is a unit conversion that
// keeps a card's words in proportion to the card itself; tying it to the
// boundary would shrink the words inside the card whenever the card zone
// grows. Screen-pixel floors (headerExtend, overviewScale) stay as they are
// for the same reason: they are about legibility on screen, not about level.
//
// The bar is drawn on a log scale because a wheel notch multiplies zoom by
// a fixed factor: equal lengths on the bar are equal numbers of notches.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'
import { MIN_ZOOM, MAX_ZOOM, useCanvasStore } from './canvasStore'

export type ZoomZone = 'card' | 'block' | 'board'

export const DEFAULT_CARD_MAX = 0.18
export const DEFAULT_BLOCK_MAX = 0.3
/** The zoom at which card text and chips are drawn at their design size.
 *  Fixed on purpose — see the header. */
export const CARD_TEXT_REF_ZOOM = 0.18
/** One wheel notch (InfiniteCanvas). */
export const WHEEL_ZOOM_FACTOR = 1.12
/** Each zone keeps at least this much room, as a zoom ratio (~1.5 notches). */
const MIN_ZONE_RATIO = 1.18

interface ZoomZonesState {
  cardMax: number
  blockMax: number
  barOpen: boolean
  /** Seconds spent looking at each level, while the window has focus. */
  timeIn: Record<ZoomZone, number>
  setBoundaries: (cardMax: number, blockMax: number) => void
  resetBoundaries: () => void
  setBarOpen: (open: boolean) => void
  addTime: (zone: ZoomZone, seconds: number) => void
  resetTime: () => void
}

/** Keep both boundaries inside the zoom range and every zone at least
 *  MIN_ZONE_RATIO wide. `moved` says which one the user is dragging, so the
 *  other one is the one that gets pushed. */
export function clampBoundaries(cardMax: number, blockMax: number, moved: 'card' | 'block' = 'card') {
  const lo = MIN_ZOOM * MIN_ZONE_RATIO
  const hi = MAX_ZOOM / MIN_ZONE_RATIO
  if (moved === 'card') {
    cardMax = Math.min(Math.max(cardMax, lo), hi / MIN_ZONE_RATIO)
    blockMax = Math.min(Math.max(blockMax, cardMax * MIN_ZONE_RATIO), hi)
  } else {
    blockMax = Math.min(Math.max(blockMax, lo * MIN_ZONE_RATIO), hi)
    cardMax = Math.max(Math.min(cardMax, blockMax / MIN_ZONE_RATIO), lo)
  }
  return { cardMax, blockMax }
}

export const useZoomZonesStore = create<ZoomZonesState>()(persist((set) => ({
  cardMax: DEFAULT_CARD_MAX,
  blockMax: DEFAULT_BLOCK_MAX,
  barOpen: true,
  timeIn: { card: 0, block: 0, board: 0 },
  setBoundaries: (c, b) => set(s => {
    const moved = c !== s.cardMax ? 'card' : 'block'
    return clampBoundaries(c, b, moved)
  }),
  resetBoundaries: () => set({ cardMax: DEFAULT_CARD_MAX, blockMax: DEFAULT_BLOCK_MAX }),
  setBarOpen: barOpen => set({ barOpen }),
  addTime: (zone, seconds) => set(s => ({ timeIn: { ...s.timeIn, [zone]: s.timeIn[zone] + seconds } })),
  resetTime: () => set({ timeIn: { card: 0, block: 0, board: 0 } }),
}), {
  name: 'vidbars-zoom-zones',
  storage: createDebouncedIDBStorage(400),
  partialize: s => ({ cardMax: s.cardMax, blockMax: s.blockMax, barOpen: s.barOpen, timeIn: s.timeIn }),
}))

// ── Reading the zones ───────────────────────────────────────────────

/** Which level a zoom value falls in. Cards include their top boundary;
 *  Boards include theirs (matches the original LayerRouter). */
export function zoneOf(zoom: number): ZoomZone {
  const { cardMax, blockMax } = useZoomZonesStore.getState()
  if (zoom <= cardMax) return 'card'
  if (zoom < blockMax) return 'block'
  return 'board'
}

/** The level the canvas is showing right now (non-React callers). */
export const currentZone = (): ZoomZone => zoneOf(useCanvasStore.getState().zoom)

/** The level the canvas is showing. Re-renders only when the level changes
 *  (or a boundary moves across the current zoom). */
export function useZoomZone(): ZoomZone {
  const cardMax = useZoomZonesStore(s => s.cardMax)
  const blockMax = useZoomZonesStore(s => s.blockMax)
  return useCanvasStore(s => (s.zoom <= cardMax ? 'card' : s.zoom < blockMax ? 'block' : 'board'))
}

/** 0 at the bottom of a zone, 1 at its top (log scale, like the wheel). */
export function progressInZone(zoom: number, zone: ZoomZone): number {
  const [lo, hi] = zoneRange(zone)
  const t = Math.log(zoom / lo) / Math.log(hi / lo)
  return Math.max(0, Math.min(1, t))
}

export function zoneRange(zone: ZoomZone): [number, number] {
  const { cardMax, blockMax } = useZoomZonesStore.getState()
  return zone === 'card' ? [MIN_ZOOM, cardMax] : zone === 'block' ? [cardMax, blockMax] : [blockMax, MAX_ZOOM]
}

/** A zoom inside `zone` for jumps that should land on that level.
 *  `preferred` is used when it is already inside; otherwise the point
 *  `at` of the way up the zone (log scale). */
export function zoomInZone(zone: ZoomZone, preferred?: number, at = 0.5): number {
  if (preferred !== undefined && zoneOf(preferred) === zone) return preferred
  const [lo, hi] = zoneRange(zone)
  // Stay strictly inside: the card zone's top and the board zone's bottom
  // are inclusive, the block zone's ends are not.
  return lo * Math.pow(hi / lo, Math.max(0.05, Math.min(0.95, at)))
}

// ── Bar geometry (log scale, 0 = MIN_ZOOM, 1 = MAX_ZOOM) ────────────

const LOG_SPAN = Math.log(MAX_ZOOM / MIN_ZOOM)
export const zoomToBar = (zoom: number) => Math.max(0, Math.min(1, Math.log(zoom / MIN_ZOOM) / LOG_SPAN))
export const barToZoom = (t: number) => MIN_ZOOM * Math.exp(Math.max(0, Math.min(1, t)) * LOG_SPAN)
/** Wheel notches between two zooms. */
export const notchesBetween = (a: number, b: number) => Math.abs(Math.log(b / a)) / Math.log(WHEEL_ZOOM_FACTOR)

/** The level a hard-coded zoom was written for (templates, saved jumps),
 *  judged by the default boundaries it was tuned against. Pair it with
 *  zoomInZone so the jump still lands on that level after the bar moves. */
export function designZone(zoom: number): ZoomZone {
  if (zoom <= DEFAULT_CARD_MAX) return 'card'
  if (zoom < DEFAULT_BLOCK_MAX) return 'block'
  return 'board'
}

/** A zoom written for the default boundaries, moved onto the same level
 *  under the current ones (unchanged when it is already there). */
export const keepDesignZone = (zoom: number) => zoomInZone(designZone(zoom), zoom)
