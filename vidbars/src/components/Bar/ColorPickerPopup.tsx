import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HexColorPicker } from 'react-colorful'

const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window

const PALETTE = [
  '#5b8dd9', '#3b82f6', '#0ea5e9', '#06b6d4',
  '#14b8a6', '#22c55e', '#84cc16', '#f59e0b',
  '#f97316', '#ef4444', '#ec4899', '#8b5cf6',
  '#6366f1', '#64748b', '#475569', '#334155',
]

interface BodyProps {
  color: string
  onChange: (color: string) => void
  /** How solid the colour is drawn, 0 to 1. Given with onOpacityChange, a
   *  slider for it sits under the colours. */
  opacity?: number
  onOpacityChange?: (opacity: number) => void
}

interface Props extends BodyProps {
  anchorX: number
  anchorY: number
  onClose: () => void
}

/** The picker itself: the colour field, eyedropper, the ready colours and,
 *  when asked for, how solid the colour is. In ColorPickerPopup, or set
 *  into another panel (the text toolbar's card colour). */
export const ColorPickerBody: React.FC<BodyProps> = ({ color, onChange, opacity, onOpacityChange }) => {
  const [picking, setPicking] = useState(false)

  const openEyeDropper = async () => {
    if (!hasEyeDropper) return
    setPicking(true)
    try {
      const dropper = new (window as any).EyeDropper()
      const result = await dropper.open()
      if (result?.sRGBHex) onChange(result.sRGBHex)
    } catch { /* user cancelled */ }
    setPicking(false)
  }

  const solid = opacity ?? 1
  return (
    <>
      <HexColorPicker color={color} onChange={onChange} style={{ width: '100%' }} />
      {hasEyeDropper && (
        <button
          onClick={openEyeDropper}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            width: '100%', marginTop: 10, padding: '6px 0',
            background: picking ? 'rgba(59,130,246,0.25)' : 'rgba(255,255,255,0.06)',
            border: picking ? '1px solid rgba(59,130,246,0.5)' : '1px solid rgba(255,255,255,0.1)',
            borderRadius: 7, cursor: 'pointer',
            color: picking ? '#93c5fd' : 'rgba(255,255,255,0.7)',
            fontSize: 12, fontWeight: 600,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 22l1-1h3l9-9" /><path d="M3 21v-3l9-9" />
            <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9" /><path d="m15 6 3 3" />
            <path d="m9 12 3 3" />
          </svg>
          {picking ? 'Picking…' : 'Eyedropper'}
        </button>
      )}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        marginTop: 10,
      }}>
        {PALETTE.map(c => (
          <button
            key={c}
            onClick={() => onChange(c)}
            style={{
              width: 28,
              height: 28,
              background: c,
              border: c.toLowerCase() === color.toLowerCase() ? '2.5px solid #fff' : '2px solid rgba(255,255,255,0.15)',
              borderRadius: 7,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          />
        ))}
      </div>
      {onOpacityChange && (
        <div data-color-opacity style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.55)', marginBottom: 5 }}>
            <span>Transparency</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right' }}>{Math.round((1 - solid) * 100)}%</span>
          </div>
          <input
            type="range"
            min={0} max={1} step={0.01}
            value={1 - solid}
            onChange={e => onOpacityChange(1 - parseFloat(e.target.value))}
            onPointerDown={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
            style={{ display: 'block', width: '100%', height: 4, margin: 0, accentColor: '#60a5fa', cursor: 'pointer' }}
          />
        </div>
      )}
    </>
  )
}

export const ColorPickerPopup: React.FC<Props> = ({ color, anchorX, anchorY, onChange, onClose, opacity, onOpacityChange }) => {
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click (pointerdown — robust to touch/pen) and on Escape.
  // Capture phase ensures no descendant can stopPropagation before we see it.
  useEffect(() => {
    const outside = (e: Event) => {
      const t = e.target as Node | null
      if (ref.current && t && !ref.current.contains(t)) onClose()
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    const tid = setTimeout(() => {
      document.addEventListener('pointerdown', outside, true)
      document.addEventListener('keydown', esc, true)
    }, 0)
    return () => {
      clearTimeout(tid)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', esc, true)
    }
  }, [onClose])

  const x = Math.min(anchorX, window.innerWidth - 225)
  const y = Math.max(4, Math.min(anchorY, window.innerHeight - (onOpacityChange ? 460 : 360)))

  return createPortal(
    <div
      ref={ref}
      data-color-picker-popup
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 10000,
        background: '#1e1f30',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 12,
        padding: 14,
        boxShadow: '0 12px 40px rgba(0,0,0,0.7)',
        width: 210,
      }}
    >
      <ColorPickerBody color={color} onChange={onChange} opacity={opacity} onOpacityChange={onOpacityChange} />
    </div>,
    document.body
  )
}
