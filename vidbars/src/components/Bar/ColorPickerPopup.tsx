import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { HexColorPicker } from 'react-colorful'

const PALETTE = [
  '#5b8dd9', '#3b82f6', '#0ea5e9', '#06b6d4',
  '#14b8a6', '#22c55e', '#84cc16', '#f59e0b',
  '#f97316', '#ef4444', '#ec4899', '#8b5cf6',
  '#6366f1', '#64748b', '#475569', '#334155',
]

interface Props {
  color: string
  anchorX: number
  anchorY: number
  onChange: (color: string) => void
  onClose: () => void
}

export const ColorPickerPopup: React.FC<Props> = ({ color, anchorX, anchorY, onChange, onClose }) => {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const tid = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => { clearTimeout(tid); document.removeEventListener('mousedown', handler) }
  }, [onClose])

  const x = Math.min(anchorX, window.innerWidth - 225)
  const y = Math.min(anchorY, window.innerHeight - 360)

  return createPortal(
    <div
      ref={ref}
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
      <HexColorPicker color={color} onChange={onChange} style={{ width: '100%' }} />
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        marginTop: 12,
      }}>
        {PALETTE.map(c => (
          <button
            key={c}
            onClick={() => { onChange(c); onClose() }}
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
    </div>,
    document.body
  )
}
