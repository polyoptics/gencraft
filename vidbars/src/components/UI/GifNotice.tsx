import React from 'react'
import { useGifJob } from '../../utils/makeGif'

/** A small note at the bottom of the screen while a looping GIF is being
 *  made (utils/makeGif), and for a few seconds if one could not be. A fixed
 *  size, so the count going up moves nothing. */
export const GifNotice: React.FC = () => {
  const text = useGifJob(s => s.text)
  if (!text) return null
  return (
    <div data-gif-notice style={{
      position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)', zIndex: 9998,
      minWidth: 170, maxWidth: 420, padding: '7px 14px', borderRadius: 8, boxSizing: 'border-box',
      background: 'rgba(24,24,28,0.92)', border: '1px solid rgba(255,255,255,0.14)',
      color: '#fff', fontSize: 12, textAlign: 'center', pointerEvents: 'none',
      fontVariantNumeric: 'tabular-nums',
    }}>{text}</div>
  )
}
