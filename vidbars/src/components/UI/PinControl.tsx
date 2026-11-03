// PinControl.tsx — one pin, drawn rather than typed.
//
// A PUSHPIN: rounded cap, narrow grip, wide flange, needle, leaning at an
// angle like the one on a corkboard. The drawing never changes. Pinned is
// lit (blue, full strength), unpinned is unlit (grey, dim), and hover does
// nothing to it.
//
// The hit box is larger than the drawing (`hit`) and sits above the tile's
// resize strips (zIndex 21). The pin lives in the header's top-right
// corner, exactly where the n/ne resize zones are, and those used to win:
// most clicks on the pin started a resize instead.
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
  /** Size of the drawn pin, in the caller's units. */
  size?: number
  /** Size of the square hit box, centred on the pin. It overhangs the
   *  layout box (negative margins) so it never pushes neighbours around.
   *  Defaults to 1.6 × size. */
  hit?: number
}

export const PinControl: React.FC<PinControlProps> = ({ pinned, onToggle, onResetHome, size = 15, hit }) => {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const box = Math.max(size, hit ?? size * 1.6)
  const overhang = (box - size) / 2
  const fill = pinned ? 'rgba(158,203,255,0.95)' : 'rgba(206,214,228,0.55)'
  const shine = pinned ? 'rgba(230,243,255,0.9)' : 'rgba(240,244,250,0.5)'

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
        title={pinned
          ? 'Pinned to the screen — click to set it back on the canvas\nRight-click for its return spot'
          : 'On the canvas — click to pin it to the screen\nRight-click for pin options'}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          width: box, height: box, margin: -overhang, flexShrink: 0, lineHeight: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative', zIndex: 21,
        }}
      >
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ pointerEvents: 'none' }}>
          <g transform="rotate(40 12 12)">
            <line x1="12" y1="15" x2="12" y2="23" stroke={fill} strokeWidth="1.6" strokeLinecap="round" />
            <rect x="6.5" y="1.2" width="11" height="4.6" rx="2.3" fill={fill} />
            <path d="M9.3 5.2 H14.7 L13.7 11.6 H10.3 Z" fill={fill} />
            <rect x="5.6" y="11.2" width="12.8" height="3.8" rx="1.9" fill={fill} />
            <rect x="8.2" y="2.3" width="3.2" height="1.6" rx="0.8" fill={shine} />
          </g>
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
