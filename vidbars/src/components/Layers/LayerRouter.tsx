// LayerRouter — selects which layer component to render based on zoom level.
// This is the single entry point for all canvas content: cards, blocks, and boards.
// Each layer is a self-contained component with its own data, interactions, and context menu.

import React from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { CardLayer } from './CardLayer'
import { BlockLayer } from './BlockLayer'
import { BoardLayer } from './BoardLayer'

const CARD_THRESHOLD = 0.18
const BLOCK_THRESHOLD = 0.3

/** Canvas-space content: rendered inside the transform container */
export const LayerContent: React.FC = () => {
  const zoom = useCanvasStore(s => s.zoom)

  if (zoom <= CARD_THRESHOLD) return <CardLayer.Canvas />
  if (zoom < BLOCK_THRESHOLD) return <BlockLayer.Canvas />
  return <BoardLayer.Canvas />
}

/** Screen-space overlay: rendered outside the transform container (fixed position) */
export const LayerOverlay: React.FC = () => {
  const zoom = useCanvasStore(s => s.zoom)

  if (zoom <= CARD_THRESHOLD) return <CardLayer.Overlay />
  if (zoom < BLOCK_THRESHOLD) return <BlockLayer.Overlay />
  return <BoardLayer.Overlay />
}
