// The heart on a card (utils/favorites): none, a heart, the standout.
// Lit while the card has one, and then always there; with none it shows
// with the card's other tools, on hover. Same spot, size and words always.
import React, { useState } from 'react'
import type { Fav } from '../../utils/favorites'

const HEART = 'M8 13.6 C3.2 10.2 1.6 7.9 1.6 5.6 C1.6 3.7 3.1 2.4 4.8 2.4 C6.1 2.4 7.3 3.1 8 4.3 C8.7 3.1 9.9 2.4 11.2 2.4 C12.9 2.4 14.4 3.7 14.4 5.6 C14.4 7.9 12.8 10.2 8 13.6 Z'
const RED = 'rgb(240, 62, 82)'
const GOLD = 'rgb(255, 200, 64)'

export const HeartButton: React.FC<{
  level: Fav
  onStep: () => void
  size: number
  visible: boolean
  /** Over a card's back: shown on hover only, lit or not, so it never
   *  sits on the back's words. */
  quiet?: boolean
  style?: React.CSSProperties
}> = ({ level, onStep, size, visible, quiet, style }) => {
  const [hover, setHover] = useState(false)
  const shown = visible || (level > 0 && !quiet)
  return (
    <button
      type="button"
      data-card-heart={level}
      title="Heart: click for a heart, again for a standout, again for none"
      onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}
      onDoubleClick={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onStep() }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'absolute', zIndex: 60,
        width: size, height: size, padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: level === 2 ? 'rgba(60,42,0,0.72)' : 'rgba(0,0,0,0.45)',
        border: `1px solid ${level === 2 ? GOLD : level === 1 ? 'rgba(240,62,82,0.75)' : hover ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.25)'}`,
        borderRadius: 4,
        boxShadow: level === 2 ? `0 0 0 1px ${GOLD}` : 'none',
        opacity: shown ? 1 : 0, pointerEvents: shown ? 'auto' : 'none',
        cursor: 'pointer', boxSizing: 'border-box', lineHeight: 1,
        transition: 'opacity 0.12s, background 0.12s, border-color 0.12s',
        ...style,
      }}
    >
      <svg width={size * 0.74} height={size * 0.74} viewBox="0 0 16 16" strokeLinejoin="round">
        {level === 2
          ? <>
              {/* The standout: a heart on a heart. */}
              <path d={HEART} transform="translate(2.6 -1.6) scale(0.78)" fill={GOLD} stroke={GOLD} strokeWidth="1" />
              <path d={HEART} transform="translate(0 2.6) scale(0.82)" fill={RED} stroke="rgba(40,0,0,0.85)" strokeWidth="1.1" />
            </>
          : <path d={HEART} fill={level === 1 ? RED : 'none'} stroke={level === 1 ? RED : hover ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.6)'} strokeWidth="1.4" />}
      </svg>
    </button>
  )
}
