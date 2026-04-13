// Shared text formatting toolbar — used by FreeNode, CardLayer, BlockLayer
import React, { useState, useEffect, useRef } from 'react'
import ReactDOM from 'react-dom'
import type { TextStyle } from '../../store/freeNodeStore'
import { DEFAULT_HEADER_STYLE, DEFAULT_BODY_STYLE } from '../../store/freeNodeStore'

export type TextFieldMode = 'header' | 'body'

export const FONT_SIZES = [8, 10, 12, 14, 18, 24, 32, 48, 64, 96]
export const PRESET_COLORS = ['#ffffff', '#e2e8f0', '#fbbf24', '#f87171', '#34d399', '#60a5fa', '#a78bfa', '#fb923c']

export const FONT_LIST: { label: string; value: string; google?: boolean }[] = [
  // ── System fonts ──
  { label: 'System', value: 'system-ui, sans-serif' },
  { label: 'Sans', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Serif', value: 'Georgia, Times New Roman, serif' },
  { label: 'Mono', value: 'Consolas, Courier New, monospace' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Trebuchet', value: 'Trebuchet MS, sans-serif' },
  { label: 'Impact', value: 'Impact, Haettenschweiler, sans-serif' },
  { label: 'Comic', value: 'Comic Sans MS, cursive' },
  { label: 'Tahoma', value: 'Tahoma, Geneva, sans-serif' },
  { label: 'Palatino', value: 'Palatino Linotype, Book Antiqua, serif' },
  { label: 'Garamond', value: 'Garamond, serif' },
  { label: 'Lucida', value: 'Lucida Console, Monaco, monospace' },
  // ── Google Fonts ──
  { label: 'Roboto', value: 'Roboto, sans-serif', google: true },
  { label: 'Open Sans', value: 'Open Sans, sans-serif', google: true },
  { label: 'Lato', value: 'Lato, sans-serif', google: true },
  { label: 'Montserrat', value: 'Montserrat, sans-serif', google: true },
  { label: 'Poppins', value: 'Poppins, sans-serif', google: true },
  { label: 'Inter', value: 'Inter, sans-serif', google: true },
  { label: 'Raleway', value: 'Raleway, sans-serif', google: true },
  { label: 'Nunito', value: 'Nunito, sans-serif', google: true },
  { label: 'Playfair Display', value: 'Playfair Display, serif', google: true },
  { label: 'Merriweather', value: 'Merriweather, serif', google: true },
  { label: 'Lora', value: 'Lora, serif', google: true },
  { label: 'PT Serif', value: 'PT Serif, serif', google: true },
  { label: 'Oswald', value: 'Oswald, sans-serif', google: true },
  { label: 'Bebas Neue', value: 'Bebas Neue, sans-serif', google: true },
  { label: 'Anton', value: 'Anton, sans-serif', google: true },
  { label: 'Archivo Black', value: 'Archivo Black, sans-serif', google: true },
  { label: 'Fira Code', value: 'Fira Code, monospace', google: true },
  { label: 'JetBrains Mono', value: 'JetBrains Mono, monospace', google: true },
  { label: 'Space Mono', value: 'Space Mono, monospace', google: true },
  { label: 'Dancing Script', value: 'Dancing Script, cursive', google: true },
  { label: 'Pacifico', value: 'Pacifico, cursive', google: true },
  { label: 'Caveat', value: 'Caveat, cursive', google: true },
  { label: 'Permanent Marker', value: 'Permanent Marker, cursive', google: true },
  { label: 'Bangers', value: 'Bangers, cursive', google: true },
  { label: 'Press Start 2P', value: 'Press Start 2P, monospace', google: true },
  { label: 'Orbitron', value: 'Orbitron, sans-serif', google: true },
]

// ── Google Font loader ──
const loadedGoogleFonts = new Set<string>()
const googleFontLabels = new Set(FONT_LIST.filter(f => f.google).map(f => f.label))
const fontValueToLabel = new Map(FONT_LIST.filter(f => f.google).map(f => [f.value, f.label]))

export function loadGoogleFont(label: string) {
  if (loadedGoogleFonts.has(label)) return
  loadedGoogleFonts.add(label)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(label).replace(/%20/g, '+')}:wght@400;700&display=swap`
  document.head.appendChild(link)
}

/** Call with a fontFamily CSS value — if it maps to a Google Font, ensures it's loaded */
export function ensureFontLoaded(fontFamily?: string) {
  if (!fontFamily) return
  const label = fontValueToLabel.get(fontFamily)
  if (label) loadGoogleFont(label)
}

// ── Alignment icons ──

export const hAlignIcons: Record<string, React.ReactNode> = {
  left: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 2h12M1 5h8M1 8h10M1 11h6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
  center: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 2h12M3 5h8M2 8h10M4 11h6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
  right: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 2h12M5 5h8M3 8h10M7 11h6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
}

export const vAlignIcons: Record<string, React.ReactNode> = {
  top: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 1h12M4 4h6M3 7h8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
  middle: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M4 3h6M3 7h8M4 11h6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
  bottom: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7h8M4 10h6M1 13h12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
}

// ── Helper ──

export function hexToRgba(hex: string, opacity: number): string {
  const n = parseInt(hex.replace('#', ''), 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return `rgba(${r},${g},${b},${opacity})`
}

// ── Shared sub-popups ──

export const AlignPopup: React.FC<{
  options: { value: string; label: string; icon: React.ReactNode }[]
  selected: string
  onSelect: (v: string) => void
  onClose: () => void
}> = ({ options, selected, onSelect }) => (
  <div
    onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}
    style={{
      position: 'absolute', top: 32, left: -4, zIndex: 10001,
      background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
      display: 'flex', gap: 2,
    }}
  >
    {options.map(o => (
      <button
        key={o.value}
        onClick={() => onSelect(o.value)}
        title={o.label}
        style={{
          background: o.value === selected ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.03)',
          border: o.value === selected ? '1px solid rgba(255,255,255,0.3)' : '1px solid rgba(255,255,255,0.06)',
          borderRadius: 5, color: o.value === selected ? '#fff' : 'rgba(255,255,255,0.5)',
          width: 28, height: 28, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 0,
        }}
      >
        {o.icon}
      </button>
    ))}
  </div>
)

export const ColorSwatchPopup: React.FC<{
  colors: string[]
  selected: string
  onSelect: (c: string) => void
  onClose: () => void
}> = ({ colors, selected, onSelect }) => (
  <div
    onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}
    style={{
      position: 'absolute', top: 32, left: -4, zIndex: 10001,
      background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 8, padding: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4,
      width: 120,
    }}
  >
    {colors.map(c => (
      <button
        key={c}
        onClick={() => onSelect(c)}
        style={{
          width: 24, height: 24, borderRadius: 5,
          background: c, border: c === selected ? '2px solid #fff' : '1px solid rgba(255,255,255,0.15)',
          cursor: 'pointer', padding: 0,
        }}
      />
    ))}
    <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
      <input
        type="color"
        value={selected}
        onChange={e => onSelect(e.target.value)}
        style={{ width: 24, height: 24, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
      />
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>Custom</span>
    </label>
  </div>
)

export const BgPickerPopup: React.FC<{
  bgColor: string
  bgOpacity: number
  onColorSelect: (c: string) => void
  onOpacityChange: (o: number) => void
  onClose: () => void
}> = ({ bgColor, bgOpacity, onColorSelect, onOpacityChange }) => (
  <div
    onPointerDown={e => {
      const tag = (e.target as HTMLElement).tagName
      const type = (e.target as HTMLInputElement).type
      if (!(tag === 'INPUT' && (type === 'range' || type === 'color'))) e.preventDefault()
      e.stopPropagation()
    }}
    onMouseDown={e => {
      const tag = (e.target as HTMLElement).tagName
      const type = (e.target as HTMLInputElement).type
      if (!(tag === 'INPUT' && (type === 'range' || type === 'color'))) e.preventDefault()
      e.stopPropagation()
    }}
    style={{
      position: 'absolute', top: 32, right: -4, zIndex: 10001,
      background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 8, padding: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
      width: 150,
    }}
  >
    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>Background Color</div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginBottom: 8 }}>
      {['#000000', '#1e1b4b', '#1e3a2f', '#3b1520', '#1e293b', '#2d1b0e', '#1a1a1a', '#0f172a'].map(c => (
        <button
          key={c}
          onClick={() => onColorSelect(c)}
          style={{
            width: 24, height: 24, borderRadius: 5,
            background: c, border: c === bgColor ? '2px solid #fff' : '1px solid rgba(255,255,255,0.15)',
            cursor: 'pointer', padding: 0,
          }}
        />
      ))}
    </div>
    <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
      <input
        type="color"
        value={bgColor}
        onChange={e => onColorSelect(e.target.value)}
        style={{ width: 24, height: 24, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
      />
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>Custom</span>
    </label>
    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 6, marginBottom: 4 }}>Opacity</div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type="range"
        min={0} max={1} step={0.05}
        value={bgOpacity}
        onChange={e => onOpacityChange(parseFloat(e.target.value))}
        onPointerDown={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        style={{ flex: 1, height: 4, accentColor: '#60a5fa', cursor: 'pointer' }}
      />
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', minWidth: 28, textAlign: 'right' }}>
        {Math.round(bgOpacity * 100)}%
      </span>
    </div>
    <div style={{
      marginTop: 6, height: 20, borderRadius: 4,
      background: hexToRgba(bgColor, bgOpacity),
      border: '1px solid rgba(255,255,255,0.08)',
    }} />
  </div>
)

// ── Main toolbar component ──

interface TextFormatToolbarProps {
  headerStyle?: TextStyle
  bodyStyle?: TextStyle
  onHeaderStyleChange: (style: TextStyle) => void
  onBodyStyleChange: (style: TextStyle) => void
  activeField: TextFieldMode
  onActiveFieldChange: (field: TextFieldMode) => void
  anchorRect: { left: number; top: number; right: number; bottom: number } | null
  preferBelow?: boolean  // true for block/card layer text where headers sit above
  onClose?: () => void   // if provided, renders a backdrop that closes toolbar on outside click
  // Hero image editing (optional — shown only when heroImage is set)
  heroImage?: string | null
  heroFlipH?: boolean
  heroFlipV?: boolean
  onFlipH?: () => void
  onFlipV?: () => void
  onCropImage?: () => void
}

export const TextFormatToolbar: React.FC<TextFormatToolbarProps> = ({
  headerStyle, bodyStyle, onHeaderStyleChange, onBodyStyleChange,
  activeField, onActiveFieldChange, anchorRect, preferBelow, onClose,
  heroImage, heroFlipH, heroFlipV, onFlipH, onFlipV, onCropImage,
}) => {
  const [showPopup, setShowPopup] = useState<'text' | 'bg' | 'hAlign' | 'vAlign' | 'font' | null>(null)

  const defaultForField = activeField === 'header' ? DEFAULT_HEADER_STYLE : DEFAULT_BODY_STYLE
  const activeStyle = activeField === 'header' ? headerStyle : bodyStyle
  const ts = { ...defaultForField, ...activeStyle }
  const setStyle = (patch: Partial<TextStyle>) => {
    const merged = { ...ts, ...patch }
    if (activeField === 'header') onHeaderStyleChange(merged)
    else onBodyStyleChange(merged)
  }

  // Close toolbar on outside click — replaces the blocking backdrop div
  const toolbarRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!onClose) return
    const handler = (e: PointerEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-text-format-toolbar]')) return
      onClose()
    }
    window.addEventListener('pointerdown', handler)
    return () => window.removeEventListener('pointerdown', handler)
  }, [onClose])

  if (!anchorRect) return null

  const TOOLBAR_H = 36
  const GAP = 6
  const aboveY = anchorRect.top - TOOLBAR_H - GAP
  const belowY = anchorRect.bottom + GAP
  // For block/card text, always go below to avoid NLE headers; otherwise prefer above
  const toolbarTop = preferBelow
    ? (belowY + TOOLBAR_H < window.innerHeight ? belowY : aboveY)
    : (aboveY >= 42 ? aboveY : belowY)
  const toolbarLeft = anchorRect.left

  const btnStyle = (active?: boolean): React.CSSProperties => ({
    background: active ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)',
    border: active ? '1px solid rgba(255,255,255,0.3)' : '1px solid rgba(255,255,255,0.08)',
    borderRadius: 5,
    color: active ? '#fff' : 'rgba(255,255,255,0.6)',
    fontSize: 12, fontWeight: active ? 700 : 500,
    padding: '2px 7px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 24, height: 26,
    transition: 'all 0.1s',
  })

  const sepStyle: React.CSSProperties = {
    width: 1, height: 18, background: 'rgba(255,255,255,0.08)', margin: '0 3px', flexShrink: 0,
  }

  return ReactDOM.createPortal(
    <>
    {/* Close-on-outside-click handled by useEffect listener above */}
    <div
      data-text-format-toolbar
      onPointerDown={e => {
        // Don't preventDefault on range inputs — it kills native drag for sliders
        const tag = (e.target as HTMLElement).tagName
        const type = (e.target as HTMLInputElement).type
        if (!(tag === 'INPUT' && (type === 'range' || type === 'color'))) e.preventDefault()
        e.stopPropagation()
      }}
      onPointerUp={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onMouseDown={e => {
        const tag = (e.target as HTMLElement).tagName
        const type = (e.target as HTMLInputElement).type
        if (!(tag === 'INPUT' && (type === 'range' || type === 'color'))) e.preventDefault()
        e.stopPropagation()
      }}
      onDoubleClick={e => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: Math.max(4, Math.min(toolbarLeft, window.innerWidth - 460)),
        top: Math.max(4, toolbarTop),
        zIndex: 10000,
        display: 'flex', alignItems: 'center', gap: 3,
        background: '#1a1b2e',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 8, padding: '4px 6px',
        boxShadow: '0 8px 30px rgba(0,0,0,0.7)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Font size — hold shift for ±5 */}
      <button style={btnStyle()} onClick={e => {
        const step = e.shiftKey ? 5 : 1
        setStyle({ fontSize: Math.max(4, ts.fontSize - step) })
      }}>−</button>
      <input
        type="number"
        value={ts.fontSize}
        onChange={e => {
          const v = parseInt(e.target.value)
          if (!isNaN(v) && v >= 4 && v <= 200) setStyle({ fontSize: v })
        }}
        onPointerDown={e => e.stopPropagation()}
        style={{
          width: 36, textAlign: 'center', background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.12)', borderRadius: 4,
          color: 'rgba(255,255,255,0.7)', fontSize: 11, padding: '2px 2px',
          fontFamily: 'inherit', outline: 'none',
          MozAppearance: 'textfield', WebkitAppearance: 'none',
        } as React.CSSProperties}
      />
      <button style={btnStyle()} onClick={e => {
        const step = e.shiftKey ? 5 : 1
        setStyle({ fontSize: Math.min(200, ts.fontSize + step) })
      }}>+</button>

      {/* Font family */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'font'), fontSize: 10, padding: '2px 5px', maxWidth: 58, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          onClick={() => setShowPopup(showPopup === 'font' ? null : 'font')}
          title="Font family"
        >{FONT_LIST.find(f => f.value === (ts.fontFamily ?? FONT_LIST[0].value))?.label ?? 'System'}</button>
        {showPopup === 'font' && (
          <div
            onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}
            style={{
              position: 'absolute', top: 32, left: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'flex', flexDirection: 'column', gap: 1, width: 170, maxHeight: 320, overflowY: 'auto',
            }}
          >
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', padding: '4px 8px 2px', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' }}>System</div>
            {FONT_LIST.filter(f => !f.google).map(f => (
              <button
                key={f.value}
                onClick={() => { setStyle({ fontFamily: f.value }); setShowPopup(null) }}
                style={{
                  ...btnStyle((ts.fontFamily ?? FONT_LIST[0].value) === f.value),
                  fontFamily: f.value, fontSize: 12, padding: '4px 8px',
                  textAlign: 'left', width: '100%', justifyContent: 'flex-start',
                }}
              >{f.label}</button>
            ))}
            <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '4px 0' }} />
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', padding: '2px 8px 2px', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' }}>Google Fonts</div>
            {FONT_LIST.filter(f => f.google).map(f => (
              <button
                key={f.value}
                onMouseEnter={() => loadGoogleFont(f.label)}
                onClick={() => { loadGoogleFont(f.label); setStyle({ fontFamily: f.value }); setShowPopup(null) }}
                style={{
                  ...btnStyle((ts.fontFamily ?? FONT_LIST[0].value) === f.value),
                  fontFamily: f.value, fontSize: 12, padding: '4px 8px',
                  textAlign: 'left', width: '100%', justifyContent: 'flex-start',
                }}
              >{f.label}</button>
            ))}
          </div>
        )}
      </div>

      {/* Header / Body mode switches */}
      <button
        style={{ ...btnStyle(activeField === 'header'), fontSize: 12, fontWeight: 800, padding: '2px 5px' }}
        onClick={() => onActiveFieldChange('header')}
        title="Edit header style"
      >H</button>
      <button
        style={{ ...btnStyle(activeField === 'body'), fontSize: 11, fontWeight: 500, padding: '2px 5px' }}
        onClick={() => onActiveFieldChange('body')}
        title="Edit body style"
      >P</button>

      <div style={sepStyle} />

      {/* Bold / Italic */}
      <button style={{ ...btnStyle(ts.bold), fontWeight: 800, fontSize: 13 }} onClick={() => setStyle({ bold: !ts.bold })}>B</button>
      <button style={{ ...btnStyle(ts.italic), fontStyle: 'italic', fontSize: 13 }} onClick={() => setStyle({ italic: !ts.italic })}>I</button>

      <div style={sepStyle} />

      {/* Horizontal alignment */}
      <div style={{ position: 'relative' }}>
        <button style={btnStyle(showPopup === 'hAlign')} onClick={() => setShowPopup(showPopup === 'hAlign' ? null : 'hAlign')} title="Horizontal align">
          {hAlignIcons[ts.align]}
        </button>
        {showPopup === 'hAlign' && (
          <AlignPopup
            options={[
              { value: 'left', label: 'Left', icon: hAlignIcons.left },
              { value: 'center', label: 'Center', icon: hAlignIcons.center },
              { value: 'right', label: 'Right', icon: hAlignIcons.right },
            ]}
            selected={ts.align}
            onSelect={v => { setStyle({ align: v as any }); setShowPopup(null) }}
            onClose={() => setShowPopup(null)}
          />
        )}
      </div>

      {/* Vertical alignment */}
      <div style={{ position: 'relative' }}>
        <button style={btnStyle(showPopup === 'vAlign')} onClick={() => setShowPopup(showPopup === 'vAlign' ? null : 'vAlign')} title="Vertical align">
          {vAlignIcons[ts.vAlign]}
        </button>
        {showPopup === 'vAlign' && (
          <AlignPopup
            options={[
              { value: 'top', label: 'Top', icon: vAlignIcons.top },
              { value: 'middle', label: 'Middle', icon: vAlignIcons.middle },
              { value: 'bottom', label: 'Bottom', icon: vAlignIcons.bottom },
            ]}
            selected={ts.vAlign}
            onSelect={v => { setStyle({ vAlign: v as any }); setShowPopup(null) }}
            onClose={() => setShowPopup(null)}
          />
        )}
      </div>

      <div style={sepStyle} />

      {/* Text color */}
      <div style={{ position: 'relative' }}>
        <button style={{ ...btnStyle(showPopup === 'text'), gap: 4, padding: '2px 6px' }} onClick={() => setShowPopup(showPopup === 'text' ? null : 'text')} title="Text color">
          <span style={{ fontSize: 13, fontWeight: 700 }}>A</span>
          <div style={{ width: 14, height: 4, borderRadius: 1, background: ts.color, border: '1px solid rgba(255,255,255,0.15)' }} />
        </button>
        {showPopup === 'text' && (
          <ColorSwatchPopup colors={PRESET_COLORS} selected={ts.color} onSelect={c => { setStyle({ color: c }); setShowPopup(null) }} onClose={() => setShowPopup(null)} />
        )}
      </div>

      {/* Background color + opacity */}
      <div style={{ position: 'relative' }}>
        <button style={{ ...btnStyle(showPopup === 'bg'), gap: 4, padding: '2px 6px' }} onClick={() => setShowPopup(showPopup === 'bg' ? null : 'bg')} title="Background">
          <div style={{
            width: 16, height: 14, borderRadius: 3,
            background: ts.bgOpacity > 0 ? hexToRgba(ts.bgColor, ts.bgOpacity) : 'linear-gradient(135deg, rgba(255,255,255,0.1) 45%, transparent 45%, transparent 55%, rgba(255,255,255,0.1) 55%)',
            border: '1px solid rgba(255,255,255,0.15)',
          }} />
        </button>
        {showPopup === 'bg' && (
          <BgPickerPopup bgColor={ts.bgColor} bgOpacity={ts.bgOpacity} onColorSelect={c => setStyle({ bgColor: c })} onOpacityChange={o => setStyle({ bgOpacity: o })} onClose={() => setShowPopup(null)} />
        )}
      </div>

      {/* Hero image editing buttons — only shown when a hero image exists */}
      {heroImage && (
        <>
          <div style={sepStyle} />
          <button style={btnStyle(heroFlipH)} onClick={onFlipH} title="Flip horizontal">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 1v12" strokeDasharray="2 1.5"/>
              <path d="M4.5 4L2 7l2.5 3"/>
              <path d="M9.5 4L12 7l-2.5 3"/>
            </svg>
          </button>
          <button style={btnStyle(heroFlipV)} onClick={onFlipV} title="Flip vertical">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 7h12" strokeDasharray="2 1.5"/>
              <path d="M4 4.5L7 2l3 2.5"/>
              <path d="M4 9.5L7 12l3-2.5"/>
            </svg>
          </button>
          <button style={btnStyle()} onClick={onCropImage} title="Crop / reposition image">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.5 0.5v10h10"/>
              <path d="M0.5 3.5h10v10"/>
            </svg>
          </button>
        </>
      )}
    </div>
    </>,
    document.body
  )
}
