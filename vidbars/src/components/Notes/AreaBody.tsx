// AreaBody — an Area card (Brian 2026-11-07): the ground of a 3D set on the
// canvas. What is set down on it is on it: move the Area and its models,
// tiles, cards, Viewers and curves go with it (utils/areaFollow). Tilted,
// it is the ground the models stand on. Empty, it is a place for rough
// arrows and diagrams.
//
// Its look is thin and quiet (Brian 2026-11-13: "thick ... like a cheaply
// made toy"; the bare canvas "much cleaner"): hairline marks over a breath
// of tint, and a choice of ground per set (node.ground): lines, dots,
// crosses, or none at all, only the set's thin outline (FreeNode).

import React from 'react'
import type { AreaGround, FreeNodeData } from '../../store/freeNodeStore'

/** Grid cell, canvas units, and every how many cells a stronger mark. */
export const AREA_CELL = 40
const MAJOR = 5

/** The grounds, in the order they are offered, and their names. */
export const AREA_GROUNDS: { id: AreaGround; name: string }[] = [
  { id: 'lines', name: 'Lines' },
  { id: 'dots', name: 'Dots' },
  { id: 'cross', name: 'Crosses' },
  { id: 'none', name: 'None' },
]

const INK = '140,190,255'

/** One tile of a ground, MAJOR cells a side, as a picture: its marks sit
 *  half a cell in from the tile's edge, so none is cut by it. The first
 *  row and column are the stronger ones. */
function tile(ground: AreaGround): string {
  const c = AREA_CELL, M = c * MAJOR, h = c / 2
  let marks = ''
  for (let i = 0; i < MAJOR; i++) {
    const p = h + i * c
    if (ground === 'lines') {
      const a = i === 0 ? 0.24 : 0.09
      marks += `<path d="M${p} 0V${M}M0 ${p}H${M}" stroke="rgba(${INK},${a})" stroke-width="1"/>`
      continue
    }
    for (let j = 0; j < MAJOR; j++) {
      const q = h + j * c, major = i === 0 && j === 0
      if (ground === 'dots') {
        marks += `<circle cx="${p}" cy="${q}" r="${major ? 1.9 : 1.15}" fill="rgba(${INK},${major ? 0.5 : 0.26})"/>`
      } else {
        const r = major ? 7 : 3.5
        marks += `<path d="M${p - r} ${q}H${p + r}M${p} ${q - r}V${q + r}" stroke="rgba(${INK},${major ? 0.5 : 0.24})" stroke-width="1"/>`
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${M}" height="${M}" viewBox="0 0 ${M} ${M}" fill="none">${marks}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}
const TILES: Partial<Record<AreaGround, string>> = {}

export const AreaBody: React.FC<{ node: FreeNodeData; bodyW: number; bodyH: number }> = ({ node }) => {
  const c = AREA_CELL, M = c * MAJOR
  const ground = node.ground ?? 'lines'
  // (Where the grid begins: at the corner, till the top or left edge is pulled.)
  const gx = node.gridAt?.x ?? 0, gy = node.gridAt?.y ?? 0
  return (
    <div
      data-area-mat=""
      data-area-ground={ground}
      style={ground === 'none' ? { flex: 1, position: 'relative', overflow: 'hidden' } : {
        flex: 1, position: 'relative', overflow: 'hidden',
        backgroundColor: `rgba(${INK},0.025)`,
        backgroundImage: (TILES[ground] ??= tile(ground)),
        backgroundSize: `${M}px ${M}px`,
        backgroundPosition: `${gx - c / 2}px ${gy - c / 2}px`,
      }}
    />
  )
}
