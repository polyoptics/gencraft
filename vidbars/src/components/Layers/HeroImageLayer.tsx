// HeroImageLayer — shared hero image renderer with transform support
import React from 'react'
import type { HeroImageTransform } from '../../store/boardsStore'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { cssUrl } from '../../utils/diskUrl'

interface Props {
  heroImage: string
  transform?: HeroImageTransform
  borderRadius?: number
  opacity?: number
}

export const HeroImageLayer: React.FC<Props> = ({ heroImage, transform, borderRadius = 12, opacity }) => {
  // heroImage may be a plain URL or a `mediaref:` pointer into the blob
  // store — resolve it to a usable URL (null while loading / if missing).
  const resolved = useResolvedMedia(heroImage)
  // Use transform.opacity if set, then prop, then default 0.7
  const effectiveOpacity = opacity ?? transform?.opacity ?? 0.7
  const t = transform
  const hasTransform = t && (t.scale !== 1 || t.offsetX !== 0 || t.offsetY !== 0 || t.flipH || t.flipV)

  const bgSize = hasTransform ? `${t.scale * 100}%` : 'cover'
  const bgPos = hasTransform ? `${50 + t.offsetX}% ${50 + t.offsetY}%` : 'center'

  const flipParts: string[] = []
  if (t?.flipH) flipParts.push('scaleX(-1)')
  if (t?.flipV) flipParts.push('scaleY(-1)')
  const cssTransform = flipParts.length > 0 ? flipParts.join(' ') : undefined

  if (!resolved) return null

  return (
    <div style={{
      position: 'absolute', inset: 0,
      backgroundImage: cssUrl(resolved),
      backgroundSize: bgSize,
      backgroundPosition: bgPos,
      backgroundRepeat: 'no-repeat',
      opacity: effectiveOpacity,
      borderRadius,
      transform: cssTransform,
    }} />
  )
}
