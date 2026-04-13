// HeroImageLayer — shared hero image renderer with transform support
import React from 'react'
import type { HeroImageTransform } from '../../store/boardsStore'

interface Props {
  heroImage: string
  transform?: HeroImageTransform
  borderRadius?: number
  opacity?: number
}

export const HeroImageLayer: React.FC<Props> = ({ heroImage, transform, borderRadius = 12, opacity = 0.7 }) => {
  const t = transform
  const hasTransform = t && (t.scale !== 1 || t.offsetX !== 0 || t.offsetY !== 0 || t.flipH || t.flipV)

  const bgSize = hasTransform ? `${t.scale * 100}%` : 'cover'
  const bgPos = hasTransform ? `${50 + t.offsetX}% ${50 + t.offsetY}%` : 'center'

  const flipParts: string[] = []
  if (t?.flipH) flipParts.push('scaleX(-1)')
  if (t?.flipV) flipParts.push('scaleY(-1)')
  const cssTransform = flipParts.length > 0 ? flipParts.join(' ') : undefined

  return (
    <div style={{
      position: 'absolute', inset: 0,
      backgroundImage: `url(${heroImage})`,
      backgroundSize: bgSize,
      backgroundPosition: bgPos,
      backgroundRepeat: 'no-repeat',
      opacity,
      borderRadius,
      transform: cssTransform,
    }} />
  )
}
