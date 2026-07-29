// PinControl.tsx — one pin, drawn rather than typed.
//
// The emoji could only say "pinned" by changing colour, which reads as a
// status light rather than as a pin. Drawing it lets the ICON carry the
// state the way the real object does: a thumbtack lying at an angle is
// loose, a thumbtack pressed straight down is holding something. The
// transition between those is the animation, and it is the same gesture
// you just made with the mouse.
//
// A THUMBTACK, not a nail: the head is a disc you press with a thumb, wider
// than it is tall and clearly the part you touch. A nail is all shaft, and
// that is what the first attempt looked like.
//
// The menu is PORTALLED to document.body, and that is load-bearing. This
// control renders inside the canvas world transform, and a transform
// ancestor becomes the containing block for `position: fixed` descendants —
// measured here, a fixed box asking for (100,100) landed at (-1496, 874)
// at 0.6px wide. Rendered in place, the menu was invisible off-screen.

import React, { useState } from 'react'
import ReactDOM from 'react-dom'

export interface PinControlProps {
  pinned: boolean
  onToggle: () => void
  /** Sets the spot this returns to when unpinned. Offered while pinned. */
  onResetHome?: () => void
  /** Screen px. The control is square at this size. */
  size?: number
}

export const PinControl: React.FC<PinControlProps> = ({ pinned, onToggle, onResetHome, size = 15 }) => {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [hover, setHover] = useState(false)

  // Loose tacks lie back off the surface; a pressed tack stands upright and
  // sits down into it. Same drawing, different transform — which is what
  // makes it read as one object moving rather than two icons swapping.
  const tilt = pinned ? 0 : -38
  const sink = pinned ? 2 : -0.5
  const body = pinned ? 'rgba(158,203,255,0.95)' : 'rgba(206,214,228,0.62)'
  const headTop = pinned ? 'rgba(196,226,255,0.98)' : 'rgba(232,238,248,0.72)'

  return (
    <>
      <button
        onPointerDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onToggle() }}
        onContextMenu={e => {
          // Always opens, even unpinned — a menu that silently does nothing
          // is indistinguishable from one that does not exist.
          e.preventDefault(); e.stopPropagation()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={pinned
          ? 'Pinned to the screen — click to set it back on the canvas\nRight-click for its return spot'
          : 'On the canvas — click to pin it to the screen\nRight-click for pin options'}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          width: size, height: size, flexShrink: 0, lineHeight: 0,
          opacity: pinned ? 1 : (hover ? 1 : 0.55), transition: 'opacity 0.12s',
        }}
      >
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
          <g
            style={{
              transform: `translateY(${sink}px) rotate(${tilt}deg)`,
              transformOrigin: '12px 15px',
              // Spring overshoot is what sells "pressed in" over "recoloured".
              transition: 'transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1)',
            }}
          >
            {/* head disc — wide and shallow: the bit you press */}
            <ellipse cx="12" cy="6.2" rx="6.4" ry="3.4" fill={body} />
            <ellipse cx="12" cy="5.4" rx="4.6" ry="2.2" fill={headTop} />
            {/* collar under the head, so the disc reads as raised */}
            <path d="M8.4 8.1 q3.6 1.7 7.2 0 l-1.2 2.1 q-2.4 1 -4.8 0 Z" fill={body} opacity={0.85} />
            {/* short barrel + point */}
            <path d="M10.9 10.1 h2.2 l-1.1 9.4 Z" fill={body} />
          </g>
          {/* The surface it presses into — appears only once pinned, so the
              tack has something to be IN rather than floating. */}
          <rect x="3.5" y="19.6" width="17" height="1.7" rx="0.85"
            fill={body}
            style={{ opacity: pinned ? 0.5 : 0, transition: 'opacity 200ms ease-out' }} />
        </svg>
      </button>

      {menu && ReactDOM.createPortal(
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99998 }}
            onPointerDown={() => setMenu(null)}
            onContextMenu={e => { e.preventDefault(); setMenu(null) }}
          />
          <div style={{
            position: 'fixed',
            left: Math.min(menu.x, window.innerWidth - 210),
            top: Math.min(menu.y, window.innerHeight - 96),
            zIndex: 99999,
            background: '#1b1e2b', border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 6, padding: 4, minWidth: 200,
            boxShadow: '0 8px 28px rgba(0,0,0,0.6)',
            fontFamily: 'system-ui, sans-serif',
          }}>
            <MenuItem
              label={pinned ? 'Drop on canvas' : 'Pin to screen'}
              onClick={() => { onToggle(); setMenu(null) }}
            />
            <MenuItem
              label="Reset home to this location"
              hint={pinned
                ? 'Where this lands when you unpin it.'
                : 'Available while pinned.'}
              disabled={!pinned || !onResetHome}
              onClick={() => { onResetHome?.(); setMenu(null) }}
            />
          </div>
        </>,
        document.body,
      )}
    </>
  )
}

const MenuItem: React.FC<{
  label: string
  hint?: string
  disabled?: boolean
  onClick: () => void
}> = ({ label, hint, disabled, onClick }) => {
  const [hover, setHover] = useState(false)
  return (
    <div>
      <button
        onPointerDown={e => e.stopPropagation()}
        onClick={() => { if (!disabled) onClick() }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        disabled={disabled}
        style={{
          display: 'block', width: '100%', textAlign: 'left',
          background: hover && !disabled ? 'rgba(120,170,255,0.16)' : 'none',
          border: 'none', cursor: disabled ? 'default' : 'pointer',
          color: disabled ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.88)',
          fontSize: 12, padding: '6px 8px', borderRadius: 4, fontFamily: 'inherit',
        }}
      >{label}</button>
      {hint && (
        <div style={{
          fontSize: 10, color: 'rgba(255,255,255,0.3)', padding: '0 8px 5px',
          lineHeight: 1.45,
        }}>{hint}</div>
      )}
    </div>
  )
}
