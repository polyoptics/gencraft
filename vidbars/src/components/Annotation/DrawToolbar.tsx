/**
 * Floating toolbar for annotation / draw mode.
 *
 * Renders in fixed (screen) space so it stays a constant size regardless of
 * canvas zoom. Only visible when canvasStore.drawSurface is non-null.
 *
 * Lives at the top of the viewport, centered horizontally. Picking a top-of-
 * viewport position avoids overlapping any of the four surfaces (cards, blocks,
 * bars, free nodes) regardless of where they live on the canvas.
 *
 * Contents:
 *  [ Pen ][ Eraser ]  |  [ ● ● ● ● ]  |  [ size slider ]  |  [ Done ]
 *
 * Esc / click-outside (handled at the App level) and the Done button all clear
 * drawSurface.
 */
import React, { useState, useEffect } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { MIN_PEN_SIZE, MAX_PEN_SIZE } from '../../types/stroke'
import {
  clearStrokes, copyStrokes, pasteStrokes,
  readStrokes, hasStrokeClipboard, strokeClipboardSize,
} from '../../utils/strokeActions'

const COLOR_PRESETS = [
  '#ffffff',  // white — the dark-canvas default
  '#1a1b2e',  // canvas-near-black, useful over light hero images
  '#ffd45c',  // accent yellow
  '#ff6b8a',  // accent pink/red
  '#5cc8ff',  // accent cyan
  '#a8ff5c',  // accent green
]

export const DrawToolbar: React.FC = () => {
  const surface = useCanvasStore(s => s.drawSurface)
  const tool = useCanvasStore(s => s.drawTool)
  const color = useCanvasStore(s => s.drawColor)
  const size = useCanvasStore(s => s.drawSize)
  const setTool = useCanvasStore(s => s.setDrawTool)
  const setColor = useCanvasStore(s => s.setDrawColor)
  const setSize = useCanvasStore(s => s.setDrawSize)
  const setSurface = useCanvasStore(s => s.setDrawSurface)

  // Clipboard state isn't reactive (it's a module-level variable in
  // strokeActions), so poll it via a tick whenever the toolbar is mounted.
  // Cheap — a handful of refs read every 250ms while the toolbar is open.
  const [clipboardCount, setClipboardCount] = useState(strokeClipboardSize())
  useEffect(() => {
    if (!surface) return
    const t = setInterval(() => setClipboardCount(strokeClipboardSize()), 250)
    return () => clearInterval(t)
  }, [surface])

  if (!surface) return null

  // Surface-aware action handlers — re-read from the live store each call so
  // we always operate on the current draw target.
  const onCopy = () => {
    if (copyStrokes(surface)) setClipboardCount(strokeClipboardSize())
  }
  const onPaste = () => { pasteStrokes(surface) }
  const onClear = () => { clearStrokes(surface) }
  const surfaceHasStrokes = readStrokes(surface).length > 0
  const canPaste = hasStrokeClipboard()

  return (
    <div
      // Stop pointer events from reaching the canvas under the toolbar.
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: 50,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(20,22,38,0.96)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 10,
        padding: '8px 12px',
        boxShadow: '0 10px 30px rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontFamily: 'inherit',
        zIndex: 1100,
        userSelect: 'none',
      }}
    >
      {/* ── Pen / Eraser tool group ── */}
      <div style={{ display: 'flex', gap: 4 }}>
        <ToolButton active={tool === 'pen'} onClick={() => setTool('pen')} label="Pen">
          <PenIcon />
        </ToolButton>
        <ToolButton active={tool === 'eraser'} onClick={() => setTool('eraser')} label="Eraser">
          <EraserIcon />
        </ToolButton>
      </div>

      <Divider />

      {/* ── Color presets ── */}
      <div style={{ display: 'flex', gap: 5 }}>
        {COLOR_PRESETS.map(c => (
          <button
            key={c}
            onClick={() => setColor(c)}
            title={c}
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              background: c,
              border: color === c
                ? '2px solid rgba(255,255,255,0.95)'
                : '1px solid rgba(255,255,255,0.18)',
              cursor: 'pointer',
              padding: 0,
              boxSizing: 'border-box',
            }}
          />
        ))}
      </div>

      <Divider />

      {/* ── Size slider ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="range"
          min={MIN_PEN_SIZE}
          max={MAX_PEN_SIZE}
          step={1}
          value={size}
          onChange={e => setSize(parseInt(e.target.value, 10))}
          style={{
            width: 110,
            accentColor: '#7baed4',
          }}
          title={`Size: ${size}px`}
        />
        {/* Live size dot for visual feedback */}
        <span style={{
          width: 22,
          height: 22,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}>
          <span style={{
            width: Math.max(2, Math.min(20, size)),
            height: Math.max(2, Math.min(20, size)),
            borderRadius: '50%',
            background: tool === 'eraser' ? 'rgba(255,255,255,0.3)' : color,
            boxShadow: '0 0 0 1px rgba(255,255,255,0.2)',
          }} />
        </span>
      </div>

      <Divider />

      {/* ── Annotation actions: copy / paste / clear ── */}
      <div style={{ display: 'flex', gap: 4 }}>
        <ToolButton
          active={false}
          onClick={onCopy}
          label={surfaceHasStrokes ? 'Copy annotations' : 'No annotations to copy'}
          disabled={!surfaceHasStrokes}
        >
          <CopyIcon />
        </ToolButton>
        <ToolButton
          active={false}
          onClick={onPaste}
          label={canPaste
            ? `Paste ${clipboardCount} stroke${clipboardCount === 1 ? '' : 's'}`
            : 'Clipboard empty'}
          disabled={!canPaste}
        >
          <PasteIcon />
        </ToolButton>
        <ToolButton
          active={false}
          onClick={onClear}
          label={surfaceHasStrokes ? 'Clear all annotations' : 'Nothing to clear'}
          disabled={!surfaceHasStrokes}
          danger
        >
          <TrashIcon />
        </ToolButton>
      </div>

      <Divider />

      {/* ── Done ── */}
      <button
        onClick={() => setSurface(null)}
        style={{
          background: 'rgba(100,150,255,0.25)',
          border: '1px solid rgba(100,150,255,0.45)',
          borderRadius: 6,
          color: 'rgba(255,255,255,0.92)',
          fontSize: 11,
          fontWeight: 600,
          padding: '5px 14px',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >Done</button>
    </div>
  )
}

// ─── Subcomponents ────────────────────────────────────────────

const Divider: React.FC = () => (
  <div style={{
    width: 1, height: 22, background: 'rgba(255,255,255,0.10)', flexShrink: 0,
  }} />
)

const ToolButton: React.FC<{
  active: boolean
  onClick: () => void
  label: string
  children: React.ReactNode
  disabled?: boolean
  /** Tinted red on hover/active — used for destructive actions (clear). */
  danger?: boolean
}> = ({ active, onClick, label, children, disabled, danger }) => (
  <button
    onClick={onClick}
    title={label}
    disabled={disabled}
    style={{
      width: 30,
      height: 30,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 6,
      background: disabled
        ? 'transparent'
        : active
          ? 'rgba(120,170,255,0.22)'
          : 'transparent',
      border: active
        ? '1px solid rgba(120,170,255,0.5)'
        : '1px solid rgba(255,255,255,0.10)',
      color: disabled
        ? 'rgba(255,255,255,0.18)'
        : danger
          ? 'rgba(255,140,140,0.85)'
          : active
            ? 'rgba(255,255,255,0.95)'
            : 'rgba(255,255,255,0.6)',
      cursor: disabled ? 'not-allowed' : 'pointer',
      padding: 0,
      fontFamily: 'inherit',
      opacity: disabled ? 0.5 : 1,
      transition: 'background 0.1s, color 0.1s',
    }}
  >
    {children}
  </button>
)

const PenIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path
      d="M11 2.5 L13.5 5 L5 13.5 L2 14 L2.5 11 L11 2.5 Z"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
)

const EraserIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path
      d="M9 2 L14 7 L7 14 L2 14 L2 11 L9 2 Z"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
    <path d="M5 14 L8 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)

const CopyIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    {/* Two stacked rounded squares — the back one peeks out top-right */}
    <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <path d="M3 11 L3 3 a1 1 0 0 1 1 -1 L11 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
  </svg>
)

const PasteIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    {/* Clipboard with a small clip on top */}
    <rect x="3" y="3" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <rect x="6" y="1.5" width="4" height="3" rx="0.8" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <line x1="6" y1="9" x2="10" y2="9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <line x1="6" y1="11.5" x2="10" y2="11.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
)

const TrashIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    {/* Lid + body + 2 vertical lines */}
    <path d="M2.5 4 L13.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M6 4 L6 2.5 a1 1 0 0 1 1 -1 L9 1.5 a1 1 0 0 1 1 1 L10 4" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <path d="M3.5 4 L4.5 13.5 a1 1 0 0 0 1 1 L10.5 14.5 a1 1 0 0 0 1 -1 L12.5 4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    <line x1="6.5" y1="6.5" x2="6.5" y2="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <line x1="9.5" y1="6.5" x2="9.5" y2="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
)
