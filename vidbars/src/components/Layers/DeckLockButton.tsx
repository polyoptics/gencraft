// Lock on a deck's primary card (utils/deckLock): lit while the deck is
// locked. Same icon and words either way; it sits beside the card's Flip.

import React, { useState } from 'react'
import { edgeColorFromHex } from '../../utils/colorUtils'

export const DeckLockButton: React.FC<{
  locked: boolean
  onToggle: () => void
  baseColor: string
  size: number
  visible: boolean
  style?: React.CSSProperties
}> = ({ locked, onToggle, baseColor, size, visible, style }) => {
  const [hover, setHover] = useState(false)
  const lit = locked || hover
  const tint = edgeColorFromHex(baseColor, locked ? 0.95 : lit ? 0.85 : 0.55)
  const bg = edgeColorFromHex(baseColor, locked ? 0.30 : lit ? 0.22 : 0.10)
  const border = edgeColorFromHex(baseColor, locked ? 0.70 : lit ? 0.55 : 0.25)
  return (
    <button
      type="button"
      data-deck-lock
      title="Lock the deck: it keeps its cards and moves as one"
      onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}
      onDoubleClick={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onToggle() }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'absolute', zIndex: 60,
        width: size, height: size, padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: locked ? bg : `linear-gradient(${bg}, ${bg}), rgba(0,0,0,0.35)`,
        border: `1px solid ${border}`, borderRadius: 4, color: tint,
        opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none',
        cursor: 'pointer', boxSizing: 'border-box', lineHeight: 1,
        transition: 'opacity 0.12s, background 0.12s, border-color 0.12s, color 0.12s',
        ...style,
      }}
    >
      <svg width={size * 0.68} height={size * 0.68} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {/* A padlock. */}
        <rect x="3" y="7" width="10" height="7.5" rx="1.2" />
        <path d="M5.2 7 V4.8 a2.8 2.8 0 0 1 5.6 0 V7" />
        <path d="M8 10 v1.8" />
      </svg>
    </button>
  )
}
