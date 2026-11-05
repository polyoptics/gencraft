// LayerRouter — selects which layer component to render based on zoom level.
// This is the single entry point for all canvas content: cards, blocks, and boards.
// Each layer is a self-contained component with its own data, interactions, and context menu.

import React from 'react'
import { useZoomZone } from '../../store/zoomZonesStore'
import { CardLayer } from './CardLayer'
import { BlockLayer } from './BlockLayer'
import { BoardLayer } from './BoardLayer'

// Where each level begins and ends lives in zoomZonesStore (dragged on the
// ZoomZoneBar); this file only picks the layer for the level.

/** Canvas-space content: rendered inside the transform container */
export const LayerContent: React.FC = () => {
  const zone = useZoomZone()

  if (zone === 'card') return <CardLayer.Canvas />
  if (zone === 'block') return <BlockLayer.Canvas />
  return <BoardLayer.Canvas />
}

/** Screen-space overlay: rendered outside the transform container (fixed position) */
export const LayerOverlay: React.FC = () => {
  const zone = useZoomZone()

  // The rows of touching cards, known at every zoom (utils/primaryCard).
  return <>{zone === 'card' ? <CardLayer.Overlay /> : zone === 'block' ? <BlockLayer.Overlay /> : <BoardLayer.Overlay />}<CardLayer.Rows /></>
}
