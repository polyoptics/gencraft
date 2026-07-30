// cardView.tsx — where a card's geometry gets its camera.
//
// Every card computes its screen rect the same way: `pan + worldValue *
// zoom`. Pinning a card is therefore not a different kind of rendering, it
// is the SAME rendering handed a different camera — one that does not move
// when the canvas does.
//
// So instead of threading a placement flag through CardLayer's components
// (which read pan/zoom in a dozen places), the view itself becomes the
// injectable thing. Unpinned cards get the live canvas view, which is what
// the default does. A pinned card gets a frozen view chosen so that
// `pan + origin * zoom` lands exactly on its pin anchor at its pin scale —
// meaning not one line of the card's own geometry has to know about pins.
//
// The same trick extends to the block and board layers when those become
// pinnable: they use the identical idiom.

import React, { createContext, useContext, useMemo } from 'react'
import { useCanvasStore } from '../../store/canvasStore'

export interface CardView {
  pan: { x: number; y: number }
  zoom: number
}

const CardViewContext = createContext<CardView | null>(null)

/** The camera this card should draw with: the frozen one if an ancestor
 *  supplied it, otherwise the live canvas. */
export function useCardView(): CardView {
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const frozen = useContext(CardViewContext)
  return frozen ?? { pan, zoom }
}

/** Wrap a pinned card so its world-space maths resolves to a fixed screen
 *  rect. `anchor` is where the card's ORIGIN should land, in screen pixels. */
export const PinnedCardView: React.FC<{
  originX: number
  originY: number
  anchor: { x: number; y: number }
  scale: number
  children: React.ReactNode
}> = ({ originX, originY, anchor, scale, children }) => {
  // Solve pan from `anchor = pan + origin * scale`.
  const view = useMemo<CardView>(() => ({
    pan: { x: anchor.x - originX * scale, y: anchor.y - originY * scale },
    zoom: scale,
  }), [anchor.x, anchor.y, originX, originY, scale])
  return <CardViewContext.Provider value={view}>{children}</CardViewContext.Provider>
}
