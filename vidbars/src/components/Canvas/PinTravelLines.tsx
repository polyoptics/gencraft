// PinTravelLines — draws the streak an unpinned card leaves behind it.
//
// Screen space, pointer-transparent, and gone in well under a second. It has
// no state of its own beyond what the store holds: each line mounts, plays
// one CSS animation, and is removed by the store's own timer. Nothing here
// needs to be cleaned up or cancelled, which is the point of doing it this
// way rather than with a rAF loop.

import React from 'react'
import { usePinTravelStore, TRAVEL_MS } from '../../store/pinTravelStore'

export const PinTravelLines: React.FC = () => {
  const lines = usePinTravelStore(s => s.lines)
  if (!lines.length) return null
  return (
    <svg
      style={{
        position: 'fixed', inset: 0, width: '100%', height: '100%',
        pointerEvents: 'none',
        // Above the pinned cards it is leaving, and above canvas chrome —
        // a trail you cannot see is not a trail.
        zIndex: 400,
      }}
    >
      <style>{`
        @keyframes pinTravelDraw {
          0%   { stroke-dashoffset: var(--len); opacity: 0.95; }
          55%  { stroke-dashoffset: 0;          opacity: 0.95; }
          100% { stroke-dashoffset: 0;          opacity: 0; }
        }
        @keyframes pinTravelLand {
          0%   { r: 2;  opacity: 0; }
          55%  { r: 2;  opacity: 0; }
          75%  { r: 11; opacity: 0.9; }
          100% { r: 16; opacity: 0; }
        }
      `}</style>
      {lines.map(l => {
        const len = Math.hypot(l.to.x - l.from.x, l.to.y - l.from.y)
        return (
          <g key={l.id}>
            <line
              x1={l.from.x} y1={l.from.y} x2={l.to.x} y2={l.to.y}
              stroke={l.color} strokeWidth={2.5} strokeLinecap="round"
              // The line draws itself from the pin toward the destination, so
              // the motion itself carries the direction — a static line would
              // leave you working out which end you came from.
              style={{
                ['--len' as string]: len,
                strokeDasharray: len,
                animation: `pinTravelDraw ${TRAVEL_MS}ms cubic-bezier(0.2,0.8,0.3,1) forwards`,
              }}
            />
            {/* Ring at the landing site: with the canvas zoomed out a card can
                arrive smaller than the line is thick, and the ring is what
                makes it findable. */}
            <circle
              cx={l.to.x} cy={l.to.y} fill="none"
              stroke={l.color} strokeWidth={2}
              style={{ animation: `pinTravelLand ${TRAVEL_MS}ms ease-out forwards` }}
            />
          </g>
        )
      })}
    </svg>
  )
}
