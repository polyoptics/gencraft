import React from 'react'
import { generateHoverVariants } from '../../utils/colorUtils'

interface Props {
  color: string
  size: number  // the dot's CSS size (iconSz), before zoom
  onSelect: (color: string) => void
}

export const ColorHoverWheel: React.FC<Props> = ({ color, size, onSelect }) => {
  const { brighter1, brighter2, darker1, darker2 } = generateHoverVariants(color)

  const dotR = size / 2
  const gap = 4  // px gap between dot edge and variant dot
  const varSz = Math.max(8, size * 0.45)
  const offset = dotR + gap + varSz / 2

  // N = lightest, E = brighter, S = darker, W = deepest
  const positions = [
    { dx: 0,       dy: -offset, c: brighter2 },
    { dx: offset,  dy: 0,       c: brighter1 },
    { dx: 0,       dy: offset,  c: darker1 },
    { dx: -offset, dy: 0,       c: darker2 },
  ]

  return (
    <>
      {positions.map((p, i) => (
        <div
          key={i}
          onPointerDown={e => { e.stopPropagation(); e.preventDefault(); onSelect(p.c) }}
          style={{
            position: 'absolute',
            left: dotR + p.dx - varSz / 2,
            top: dotR + p.dy - varSz / 2,
            width: varSz,
            height: varSz,
            borderRadius: '50%',
            background: p.c,
            border: '2px solid rgba(255,255,255,0.35)',
            cursor: 'pointer',
            boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
            zIndex: 20,
            transition: 'transform 0.1s ease-out',
          }}
          onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.3)')}
          onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
        />
      ))}
    </>
  )
}
