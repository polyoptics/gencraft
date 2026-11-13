// AreaBody — an Area card (Brian 2026-11-07): a mat with a grid on the
// canvas. What is set down on it is on it: move the Area and its models,
// tiles, cards, Viewers and curves go with it (utils/areaFollow). Tilted,
// it is a tray with a rim (TiltModels), a workspace the models stand in.
// Empty, it is a place for rough arrows and diagrams.

import React from 'react'
import type { FreeNodeData } from '../../store/freeNodeStore'

/** Grid cell, canvas units, and every how many cells a stronger line. */
export const AREA_CELL = 40
const MAJOR = 5

export const AreaBody: React.FC<{ node: FreeNodeData; bodyW: number; bodyH: number }> = ({ node, bodyW, bodyH }) => {
  const c = AREA_CELL, M = c * MAJOR
  // (Where the grid begins: at the corner, till the top or left edge is pulled.)
  const gx = node.gridAt?.x ?? 0, gy = node.gridAt?.y ?? 0
  return (
    <div
      data-area-mat=""
      style={{
        flex: 1, position: 'relative', overflow: 'hidden',
        background: [
          `linear-gradient(rgba(140,190,255,0.16) 1.5px, transparent 1.5px)`,
          `linear-gradient(90deg, rgba(140,190,255,0.16) 1.5px, transparent 1.5px)`,
          `linear-gradient(rgba(140,190,255,0.07) 1px, transparent 1px)`,
          `linear-gradient(90deg, rgba(140,190,255,0.07) 1px, transparent 1px)`,
          'radial-gradient(ellipse at 50% 40%, rgba(40,52,84,0.55), rgba(16,19,32,0.75))',
        ].join(','),
        backgroundSize: `${M}px ${M}px, ${M}px ${M}px, ${c}px ${c}px, ${c}px ${c}px, 100% 100%`,
        backgroundPosition: `${gx - 1}px ${gy - 1}px`,
      }}
    >
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: Math.min(bodyH, bodyW) * 0.03,
        textAlign: 'center', pointerEvents: 'none',
        fontSize: Math.max(10, Math.min(bodyW, bodyH) * 0.025), letterSpacing: 2,
        color: 'rgba(160,200,255,0.22)', fontFamily: 'ui-monospace, monospace',
      }}>3D SET</div>
    </div>
  )
}
