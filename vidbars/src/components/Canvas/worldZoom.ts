import { createContext, useContext } from 'react'

/** The zoom the canvas is laid out at while the tilted view lays it out at
 *  screen scale (CSS zoom, InfiniteCanvas worldStyle); null otherwise: flat,
 *  or not on the canvas (a pinned panel). In there, a box that scales its
 *  contents up with a transform is drawn at its laid-out size and blown up,
 *  soft: it zooms its contents instead (CounterScaled, ContentScaled). */
export const WorldZoom = createContext<number | null>(null)

export const useWorldZoom = (): number | null => useContext(WorldZoom)
