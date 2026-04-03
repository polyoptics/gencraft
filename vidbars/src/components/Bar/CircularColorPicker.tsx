import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { hexToHsv, hsvToHex } from '../../utils/colorUtils'

interface Props {
  color: string
  anchorX: number
  anchorY: number
  onChange: (color: string) => void
  onClose: () => void
}

const CANVAS_SIZE = 200
const RING_OUTER = 96
const RING_INNER = 76
const SQ_HALF = 52  // half-size of the SV square

const SAVED_KEY = 'vidbars-saved-colors'
const MAX_SAVED = 10

function loadSaved(): string[] {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]') } catch { return [] }
}
function storeSaved(colors: string[]) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(colors.slice(0, MAX_SAVED)))
}

export const CircularColorPicker: React.FC<Props> = ({ color, anchorX, anchorY, onChange, onClose }) => {
  const ref = useRef<HTMLDivElement>(null)
  const hueCanvasRef = useRef<HTMLCanvasElement>(null)
  const svCanvasRef = useRef<HTMLCanvasElement>(null)
  const dragging = useRef<'hue' | 'sv' | null>(null)

  const initial = hexToHsv(color)
  const [hue, setHue] = useState(initial.h)
  const [sat, setSat] = useState(initial.s)
  const [val, setVal] = useState(initial.v)
  const [hexInput, setHexInput] = useState(color)
  const [saved, setSaved] = useState(loadSaved)

  // Sync hex input when HSV changes
  const currentHex = hsvToHex(hue, sat, val)
  useEffect(() => { setHexInput(currentHex) }, [currentHex])

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const tid = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => { clearTimeout(tid); document.removeEventListener('mousedown', handler) }
  }, [onClose])

  // Draw hue ring
  useEffect(() => {
    const canvas = hueCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const cx = CANVAS_SIZE / 2, cy = CANVAS_SIZE / 2
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)

    // Draw ring using arc segments
    for (let deg = 0; deg < 360; deg++) {
      const rad = (deg - 90) * Math.PI / 180
      const rad2 = (deg - 89) * Math.PI / 180
      ctx.beginPath()
      ctx.arc(cx, cy, RING_OUTER, rad, rad2)
      ctx.arc(cx, cy, RING_INNER, rad2, rad, true)
      ctx.closePath()
      ctx.fillStyle = hsvToHex(deg, 1, 1)
      ctx.fill()
    }

    // Hue indicator
    const hRad = (hue - 90) * Math.PI / 180
    const midR = (RING_OUTER + RING_INNER) / 2
    const ix = cx + Math.cos(hRad) * midR
    const iy = cy + Math.sin(hRad) * midR
    ctx.beginPath()
    ctx.arc(ix, iy, 7, 0, Math.PI * 2)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2.5
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(ix, iy, 5, 0, Math.PI * 2)
    ctx.fillStyle = hsvToHex(hue, 1, 1)
    ctx.fill()
  }, [hue])

  // Draw SV square
  useEffect(() => {
    const canvas = svCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const size = SQ_HALF * 2
    ctx.clearRect(0, 0, size, size)

    // Saturation gradient (left white → right hue)
    const gradH = ctx.createLinearGradient(0, 0, size, 0)
    gradH.addColorStop(0, '#fff')
    gradH.addColorStop(1, hsvToHex(hue, 1, 1))
    ctx.fillStyle = gradH
    ctx.fillRect(0, 0, size, size)

    // Value gradient (top transparent → bottom black)
    const gradV = ctx.createLinearGradient(0, 0, 0, size)
    gradV.addColorStop(0, 'rgba(0,0,0,0)')
    gradV.addColorStop(1, '#000')
    ctx.fillStyle = gradV
    ctx.fillRect(0, 0, size, size)

    // SV indicator
    const ix = sat * size
    const iy = (1 - val) * size
    ctx.beginPath()
    ctx.arc(ix, iy, 6, 0, Math.PI * 2)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(ix, iy, 4, 0, Math.PI * 2)
    ctx.fillStyle = currentHex
    ctx.fill()
  }, [hue, sat, val, currentHex])

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>, zone: 'hue' | 'sv') => {
    e.stopPropagation()
    dragging.current = zone
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    handlePointerMove(e, zone)
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>, zoneOverride?: 'hue' | 'sv') => {
    const zone = zoneOverride || dragging.current
    if (!zone) return

    if (zone === 'hue') {
      const canvas = hueCanvasRef.current!
      const rect = canvas.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      let angle = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI + 90
      if (angle < 0) angle += 360
      setHue(angle)
      onChange(hsvToHex(angle, sat, val))
    } else {
      const canvas = svCanvasRef.current!
      const rect = canvas.getBoundingClientRect()
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
      setSat(x)
      setVal(1 - y)
      onChange(hsvToHex(hue, x, 1 - y))
    }
  }, [hue, sat, val, onChange])

  const handlePointerUp = useCallback(() => {
    dragging.current = null
  }, [])

  const commitHexInput = useCallback(() => {
    const clean = hexInput.trim().replace(/^#?/, '#')
    if (/^#[0-9a-fA-F]{6}$/.test(clean)) {
      const hsv = hexToHsv(clean)
      setHue(hsv.h); setSat(hsv.s); setVal(hsv.v)
      onChange(clean)
    }
    setHexInput(currentHex)
  }, [hexInput, currentHex, onChange])

  const addSaved = useCallback(() => {
    const next = [currentHex, ...saved.filter(c => c.toLowerCase() !== currentHex.toLowerCase())].slice(0, MAX_SAVED)
    setSaved(next)
    storeSaved(next)
  }, [currentHex, saved])

  const removeSaved = useCallback((idx: number) => {
    const next = saved.filter((_, i) => i !== idx)
    setSaved(next)
    storeSaved(next)
  }, [saved])

  const x = Math.min(anchorX, window.innerWidth - 240)
  const y = Math.min(anchorY, window.innerHeight - 340)

  return createPortal(
    <div
      ref={ref}
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: 'fixed', left: x, top: y, zIndex: 10000,
        background: '#1a1b2e',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 14,
        padding: 16,
        boxShadow: '0 12px 40px rgba(0,0,0,0.7)',
        width: 232,
      }}
    >
      {/* Hue ring + SV square */}
      <div style={{ position: 'relative', width: CANVAS_SIZE, height: CANVAS_SIZE, margin: '0 auto' }}>
        <canvas
          ref={hueCanvasRef}
          width={CANVAS_SIZE} height={CANVAS_SIZE}
          style={{ position: 'absolute', left: 0, top: 0, cursor: 'crosshair', borderRadius: '50%' }}
          onPointerDown={e => {
            const rect = e.currentTarget.getBoundingClientRect()
            const dx = e.clientX - rect.left - CANVAS_SIZE / 2
            const dy = e.clientY - rect.top - CANVAS_SIZE / 2
            const dist = Math.sqrt(dx * dx + dy * dy)
            if (dist >= RING_INNER && dist <= RING_OUTER) handlePointerDown(e, 'hue')
          }}
          onPointerMove={e => { if (dragging.current === 'hue') handlePointerMove(e) }}
          onPointerUp={handlePointerUp}
        />
        <canvas
          ref={svCanvasRef}
          width={SQ_HALF * 2} height={SQ_HALF * 2}
          style={{
            position: 'absolute',
            left: CANVAS_SIZE / 2 - SQ_HALF,
            top: CANVAS_SIZE / 2 - SQ_HALF,
            cursor: 'crosshair',
            borderRadius: 4,
          }}
          onPointerDown={e => handlePointerDown(e, 'sv')}
          onPointerMove={e => { if (dragging.current === 'sv') handlePointerMove(e) }}
          onPointerUp={handlePointerUp}
        />
      </div>

      {/* Hex input */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
        <div style={{
          width: 24, height: 24, borderRadius: 6,
          background: currentHex,
          border: '2px solid rgba(255,255,255,0.15)',
          flexShrink: 0,
        }} />
        <input
          value={hexInput}
          onChange={e => setHexInput(e.target.value)}
          onBlur={commitHexInput}
          onKeyDown={e => { if (e.key === 'Enter') commitHexInput() }}
          style={{
            flex: 1, background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6, color: 'rgba(255,255,255,0.7)',
            fontSize: 11, fontFamily: 'monospace',
            padding: '4px 8px', outline: 'none',
          }}
        />
      </div>

      {/* Saved colors */}
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        <div
          onClick={addSaved}
          title="Save current color"
          style={{
            width: 18, height: 18, borderRadius: '50%',
            border: '1.5px dashed rgba(255,255,255,0.2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: 'rgba(255,255,255,0.3)', fontSize: 12,
            lineHeight: 1, flexShrink: 0,
          }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.5)')}
          onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)')}
        >+</div>
        {saved.map((c, i) => (
          <div
            key={`${c}-${i}`}
            onClick={() => { onChange(c); const hsv = hexToHsv(c); setHue(hsv.h); setSat(hsv.s); setVal(hsv.v) }}
            onContextMenu={e => { e.preventDefault(); removeSaved(i) }}
            title={`${c} · right-click to remove`}
            style={{
              width: 18, height: 18, borderRadius: '50%',
              background: c,
              border: c.toLowerCase() === currentHex.toLowerCase()
                ? '2px solid rgba(255,255,255,0.7)'
                : '1.5px solid rgba(255,255,255,0.15)',
              cursor: 'pointer', flexShrink: 0,
              transition: 'border-color 0.1s',
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.5)')}
            onMouseLeave={e => (e.currentTarget.style.borderColor =
              c.toLowerCase() === currentHex.toLowerCase() ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.15)'
            )}
          />
        ))}
      </div>
    </div>,
    document.body
  )
}
