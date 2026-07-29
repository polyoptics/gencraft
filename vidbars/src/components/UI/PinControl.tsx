// PinControl.tsx — one pin, drawn rather than typed.
//
// The emoji 📌 could only say "pinned" by changing colour, which reads as a
// status light, not as a pin. Drawing it means the ICON can carry the state
// the way the real object does: a pin lying at an angle is loose, a pin
// driven straight down is holding something. The transition between those
// two is the whole animation, and it is the same gesture you just made.
//
// Right-click opens the home menu. "Reset home to this location" is a
// mouthful, but the alternatives tested worse: a second always-visible
// button competed with the pin for meaning, and shorter labels ("Set home")
// did not say that the thing being changed is where UNPINNING will land.

import React, { useState } from 'react'

export interface PinControlProps {
  pinned: boolean
  onToggle: () => void
  /** Present ⇒ right-click offers the home menu. */
  onResetHome?: () => void
  /** Screen px. The control is square at this size. */
  size?: number
}

export const PinControl: React.FC<PinControlProps> = ({ pinned, onToggle, onResetHome, size = 15 }) => {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [hover, setHover] = useState(false)

  // Loose pins lie back; a driven pin stands up and sinks slightly into the
  // header. Both are the same drawing — only the transform differs, which
  // is what makes the change read as one object moving.
  const tilt = pinned ? 0 : -45
  const sink = pinned ? 1.5 : 0
  const colour = pinned ? 'rgba(150,200,255,0.98)' : 'rgba(255,255,255,0.45)'

  return (
    <>
      <button
        onPointerDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onToggle() }}
        onContextMenu={e => {
          if (!onResetHome) return
          e.preventDefault(); e.stopPropagation()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={pinned
          ? 'Pinned to the screen — click to set it back on the canvas' +
            (onResetHome ? '\nRight-click for its return spot' : '')
          : 'On the canvas — click to pin it to the screen'}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          width: size, height: size, flexShrink: 0, lineHeight: 0,
          opacity: pinned ? 1 : (hover ? 1 : 0.5), transition: 'opacity 0.12s',
        }}
      >
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
          <g
            style={{
              transform: `translateY(${sink}px) rotate(${tilt}deg)`,
              transformOrigin: '12px 13px',
              // The spring overshoot is what sells "driven in" over
              // "faded to a different colour".
              transition: 'transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1)',
            }}
          >
            {/* head */}
            <rect x="7.5" y="2.5" width="9" height="4.4" rx="1.6"
              fill={colour} />
            {/* shaft collar */}
            <rect x="9.8" y="6.9" width="4.4" height="6.2"
              fill={colour} opacity={0.92} />
            {/* point */}
            <path d="M12 21.5 L10.1 13.1 h3.8 Z" fill={colour} />
          </g>
          {/* The surface it drives into — only visible once pinned, so the
              pin has something to be stuck IN rather than floating. */}
          <rect x="4" y="20.4" width="16" height="1.6" rx="0.8"
            fill={colour}
            style={{
              opacity: pinned ? 0.55 : 0,
              transition: 'opacity 200ms ease-out',
            }} />
        </svg>
      </button>

      {menu && onResetHome && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onPointerDown={() => setMenu(null)}
            onContextMenu={e => { e.preventDefault(); setMenu(null) }}
          />
          <div style={{
            position: 'fixed', left: menu.x, top: menu.y, zIndex: 9999,
            background: '#1b1e2b', border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 6, padding: 4, minWidth: 190,
            boxShadow: '0 8px 28px rgba(0,0,0,0.6)',
            fontFamily: 'system-ui, sans-serif',
          }}>
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={() => { onResetHome(); setMenu(null) }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'rgba(255,255,255,0.85)', fontSize: 12,
                padding: '6px 8px', borderRadius: 4, fontFamily: 'inherit',
              }}
            >Reset home to this location</button>
            <div style={{
              fontSize: 10, color: 'rgba(255,255,255,0.32)', padding: '2px 8px 5px',
              lineHeight: 1.45,
            }}>Where this lands when you unpin it.</div>
          </div>
        </>
      )}
    </>
  )
}
