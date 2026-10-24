// HeroImageEditOverlay — fullscreen crop/zoom/flip overlay for card hero images
import React, { useState, useCallback, useEffect, useRef } from 'react'
import ReactDOM from 'react-dom'
import type { HeroImageTransform } from '../../store/boardsStore'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { cssUrl } from '../../utils/diskUrl'

interface Props {
  cardRect: { left: number; top: number; width: number; height: number }
  heroImage: string
  initialTransform: HeroImageTransform
  onDone: (transform: HeroImageTransform) => void
  onCancel: () => void
}

const DEFAULT_TRANSFORM: HeroImageTransform = { scale: 1, offsetX: 0, offsetY: 0, flipH: false, flipV: false }

export const HeroImageEditOverlay: React.FC<Props> = ({ cardRect, heroImage, initialTransform, onDone, onCancel }) => {
  // heroImage may be a `mediaref:` pointer — resolve to a usable URL.
  const resolvedHero = useResolvedMedia(heroImage) ?? heroImage
  const [t, setT] = useState<HeroImageTransform>({ ...initialTransform })
  const dragging = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onDone(t)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [t, onDone, onCancel])

  // Drag to reposition
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragging.current = true
    lastPos.current = { x: e.clientX, y: e.clientY }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    const dx = e.clientX - lastPos.current.x
    const dy = e.clientY - lastPos.current.y
    lastPos.current = { x: e.clientX, y: e.clientY }
    // Convert screen px to background-position % shift.
    // Dragging right should move the image right (i.e. the crop window moves left over the image).
    // background-position 50+X% shifts the image right, so drag direction matches naturally
    // BUT the visible crop shifts the opposite way — negate to make it feel like dragging the image.
    setT(prev => ({
      ...prev,
      offsetX: prev.offsetX - (dx / cardRect.width) * (100 / prev.scale),
      offsetY: prev.offsetY - (dy / cardRect.height) * (100 / prev.scale),
    }))
  }, [cardRect.width, cardRect.height])

  const onPointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  // Scroll to zoom
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08
    setT(prev => {
      const newScale = Math.max(1, Math.min(5, prev.scale * factor))
      return { ...prev, scale: newScale }
    })
  }, [])

  const flipH = () => setT(prev => ({ ...prev, flipH: !prev.flipH }))
  const flipV = () => setT(prev => ({ ...prev, flipV: !prev.flipV }))
  const reset = () => setT({ ...DEFAULT_TRANSFORM })

  // Compute CSS for the image
  const bgSize = t.scale === 1 && t.offsetX === 0 && t.offsetY === 0 ? 'cover' : `${t.scale * 100}%`
  const bgPos = t.scale === 1 && t.offsetX === 0 && t.offsetY === 0 ? 'center' : `${50 + t.offsetX}% ${50 + t.offsetY}%`
  const flipParts: string[] = []
  if (t.flipH) flipParts.push('scaleX(-1)')
  if (t.flipV) flipParts.push('scaleY(-1)')
  const cssTransform = flipParts.length > 0 ? flipParts.join(' ') : undefined

  const btnStyle = (active?: boolean): React.CSSProperties => ({
    background: active ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)',
    border: active ? '1px solid rgba(255,255,255,0.4)' : '1px solid rgba(255,255,255,0.15)',
    borderRadius: 6, color: active ? '#fff' : 'rgba(255,255,255,0.7)',
    fontSize: 11, fontWeight: 600, padding: '4px 10px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
  })

  const TOOLBAR_H = 36
  const GAP = 8
  const toolbarTop = cardRect.top - TOOLBAR_H - GAP
  const toolbarAbove = toolbarTop > 10

  return ReactDOM.createPortal(
    <>
      {/* Backdrop */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 9990, background: 'rgba(0,0,0,0.55)' }}
        onPointerDown={e => { e.stopPropagation(); onCancel() }}
      />

      {/* Uncropped image preview (context) */}
      <div style={{
        position: 'fixed',
        left: cardRect.left - cardRect.width * 0.25,
        top: cardRect.top - cardRect.height * 0.25,
        width: cardRect.width * 1.5,
        height: cardRect.height * 1.5,
        backgroundImage: cssUrl(resolvedHero),
        backgroundSize: bgSize,
        backgroundPosition: bgPos,
        backgroundRepeat: 'no-repeat',
        transform: cssTransform,
        opacity: 0.2,
        borderRadius: 16,
        zIndex: 9991,
        pointerEvents: 'none',
      }} />

      {/* Crop window (card frame) */}
      <div
        style={{
          position: 'fixed',
          left: cardRect.left,
          top: cardRect.top,
          width: cardRect.width,
          height: cardRect.height,
          overflow: 'hidden',
          borderRadius: 12,
          border: '2px solid rgba(130,180,255,0.8)',
          boxShadow: '0 0 0 4000px rgba(0,0,0,0.35)',
          zIndex: 9992,
          cursor: dragging.current ? 'grabbing' : 'grab',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
      >
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: cssUrl(resolvedHero),
          backgroundSize: bgSize,
          backgroundPosition: bgPos,
          backgroundRepeat: 'no-repeat',
          transform: cssTransform,
        }} />
      </div>

      {/* Mini toolbar */}
      <div
        onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}
        style={{
          position: 'fixed',
          left: cardRect.left,
          top: toolbarAbove ? toolbarTop : cardRect.top + cardRect.height + GAP,
          zIndex: 9993,
          display: 'flex', alignItems: 'center', gap: 4,
          background: '#1a1b2e',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 8, padding: '4px 6px',
          boxShadow: '0 8px 30px rgba(0,0,0,0.7)',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <button style={btnStyle(t.flipH)} onClick={flipH} title="Flip horizontal">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 1v12" strokeDasharray="2 1.5"/><path d="M4.5 4L2 7l2.5 3"/><path d="M9.5 4L12 7l-2.5 3"/>
          </svg>
        </button>
        <button style={btnStyle(t.flipV)} onClick={flipV} title="Flip vertical">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 7h12" strokeDasharray="2 1.5"/><path d="M4 4.5L7 2l3 2.5"/><path d="M4 9.5L7 12l3-2.5"/>
          </svg>
        </button>
        <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.1)', margin: '0 2px' }} />
        <button style={btnStyle()} onClick={reset} title="Reset">Reset</button>
        <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.1)', margin: '0 2px' }} />
        <button style={{ ...btnStyle(), color: 'rgba(255,120,120,0.9)' }} onClick={onCancel}>Cancel</button>
        <button style={{ ...btnStyle(), background: 'rgba(37,99,235,0.4)', border: '1px solid rgba(37,99,235,0.6)', color: '#fff' }} onClick={() => onDone(t)}>Done</button>
      </div>
    </>,
    document.body
  )
}
