/**
 * Floating toolbar for annotation / draw mode.
 *
 * Positioning:
 *  - Anchored to the LEFT edge of the active drawable surface, vertically
 *    aligned with the surface's top. Re-measured on every pan/zoom change
 *    by querying the surface element via `querySurfaceElement`.
 *  - Renders in fixed (screen) space so it stays a constant size regardless
 *    of canvas zoom.
 *  - If the surface element isn't in the DOM (its zoom layer isn't active),
 *    nothing renders.
 *
 * Layout (vertical stack):
 *    [ Pen ]
 *    [ Eraser ]
 *      ────
 *    [ ●●● ]   color presets, 2×3
 *    [ ●●● ]
 *      ────
 *    [ size slider, vertical ]
 *      ────
 *    [ Copy ]
 *    [ Paste ]
 *    [ Clear ]
 *      ────
 *    [ Done ]
 *
 * Cancel:
 *  - Esc (handled in App.useEscapeDrawMode)
 *  - Done button (clears drawSurface)
 *  - Click outside the surface AND the toolbar — cancels via a document-
 *    level pointerdown listener installed while draw mode is active.
 */
import React, { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { MIN_PEN_SIZE, MAX_PEN_SIZE } from '../../types/stroke'
import {
  clearStrokes, copyStrokes, pasteStrokes,
  readStrokes, hasStrokeClipboard, strokeClipboardSize,
} from '../../utils/strokeActions'
import { querySurfaceElement } from '../../utils/surfaceQuery'

const COLOR_PRESETS = [
  '#ffffff',  // white — the dark-canvas default
  '#1a1b2e',  // canvas-near-black, useful over light hero images
  '#ffd45c',  // accent yellow
  '#ff6b8a',  // accent pink/red
  '#5cc8ff',  // accent cyan
  '#a8ff5c',  // accent green
]

// Toolbar dimensions — fixed screen px before per-surface scaling.
const TOOLBAR_W = 44
const ANCHOR_GAP = 10   // gap between toolbar's right edge and surface's left edge
const VIEWPORT_PAD = 4  // min distance the toolbar must keep from the viewport's left edge

/**
 * How much the toolbar should shrink at the current zoom for the current
 * surface kind. Returns 1.0 for "no scaling" (board-zoom feel).
 *
 *   bar / freeNode  → constant size at every zoom (their layers feel stable
 *                     across the board-zoom range; current behavior).
 *   block           → scales partly with zoom; 1.2× the prior range so the
 *                     bar feels bigger overall in block-zoom territory.
 *                     Linear in [0.18, 0.30].
 *   card            → scales fully with zoom (no counteraction); 1.2× the
 *                     prior multiplier so the toolbar lands ~20% bigger at
 *                     every card-zoom level (e.g. zoom 0.17 → 0.82).
 */
function toolbarScaleFor(kind: 'bar' | 'freeNode' | 'block' | 'card', zoom: number): number {
  switch (kind) {
    case 'bar':
    case 'freeNode':
      return 1.0
    case 'block': {
      // 1.2× the prior scale: 0.18 → 0.66, 0.30 → 1.2. Capped at 1.2.
      const t = Math.max(0, Math.min(1, (zoom - 0.18) / 0.12))
      return 0.66 + 0.54 * t
    }
    case 'card':
      // 1.2× the prior multiplier: zoom * 4.8.
      // At 0.17 → 0.82 (was 0.68). At 0.11 → 0.53 (was 0.44).
      // Floor 0.42, ceiling 1.2 to allow the 20% boost at the top end.
      return Math.max(0.42, Math.min(1.2, zoom * 4.8))
  }
}

export const DrawToolbar: React.FC = () => {
  const surface = useCanvasStore(s => s.drawSurface)
  const tool = useCanvasStore(s => s.drawTool)
  const color = useCanvasStore(s => s.drawColor)
  const size = useCanvasStore(s => s.drawSize)
  const setTool = useCanvasStore(s => s.setDrawTool)
  const setColor = useCanvasStore(s => s.setDrawColor)
  const setSize = useCanvasStore(s => s.setDrawSize)
  const setSurface = useCanvasStore(s => s.setDrawSurface)

  // Subscribe to pan/zoom — the surface's screen position changes when these
  // do, so we need to re-measure.
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)

  const toolbarRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)

  // Clipboard state isn't reactive (it's a module-level variable in
  // strokeActions), so poll it via a tick whenever the toolbar is mounted.
  const [clipboardCount, setClipboardCount] = useState(strokeClipboardSize())
  useEffect(() => {
    if (!surface) return
    const t = setInterval(() => setClipboardCount(strokeClipboardSize()), 250)
    return () => clearInterval(t)
  }, [surface])

  // ── Position math: re-measure surface element on every relevant change ──
  // Pre-compute the scale here too so the LEFT offset accounts for the
  // toolbar's POST-scale visible width.
  const scale = surface ? toolbarScaleFor(surface.kind, zoom) : 1
  useLayoutEffect(() => {
    if (!surface) { setAnchor(null); return }

    const measure = () => {
      const el = querySurfaceElement(surface)
      if (!el) { setAnchor(null); return }
      const rect = el.getBoundingClientRect()
      // Toolbar uses `transform: scale(scale)` with origin top-left, so the
      // visible width on screen is TOOLBAR_W * scale. Subtract that (plus
      // gap) from the surface's left edge to anchor the toolbar's right
      // edge to the surface. Clamp so the toolbar never disappears past
      // the viewport's left edge.
      const visibleW = TOOLBAR_W * scale
      const left = Math.max(VIEWPORT_PAD, rect.left - visibleW - ANCHOR_GAP)
      const top = Math.max(VIEWPORT_PAD, rect.top)
      setAnchor({ left, top })
    }

    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
    // pan/zoom + scale change → re-measure
  }, [surface, pan.x, pan.y, zoom, scale])

  // ── Click-outside cancels draw mode ──
  useEffect(() => {
    if (!surface) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target) return
      const surfaceEl = querySurfaceElement(surface)
      if (surfaceEl?.contains(target)) return            // click inside the drawing area
      if (toolbarRef.current?.contains(target)) return   // click on the toolbar itself
      // Pen buttons are toggles. Without this exemption, the outside-handler
      // would null drawSurface in capture phase, and then PenButton's
      // bubble-phase onClick would re-arm draw mode (since isActive checked
      // a now-null surface). Letting the pen button handle itself gives the
      // expected save+cancel behavior when the user clicks the pen they
      // armed draw mode with — and the natural transfer behavior when they
      // click a different surface's pen.
      if ((target as HTMLElement).closest('[data-pen-button]')) return
      setSurface(null)
    }
    // Capture phase fires before any inner handlers; we don't stop
    // propagation, so the click still does whatever it normally would
    // (select another card, click a different surface's pen, etc).
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [surface, setSurface])

  if (!surface) return null
  if (!anchor) return null

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
      ref={toolbarRef}
      data-draw-toolbar="true"
      // Stop pointer events from reaching the canvas under the toolbar.
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: anchor.left,
        top: anchor.top,
        width: TOOLBAR_W,
        background: 'rgba(20,22,38,0.96)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 10,
        padding: 6,
        boxShadow: '0 10px 30px rgba(0,0,0,0.55)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'inherit',
        zIndex: 1100,
        userSelect: 'none',
        // Per-surface scale — bar/freeNode stay at 1.0, block scales with
        // its zoom range, card scales fully with zoom (locked to the card's
        // visual size). Origin top-left so the toolbar shrinks INTO its
        // anchored corner rather than away from it.
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
      }}
    >
      {/* ── Pen / Eraser tools ── */}
      <ToolButton active={tool === 'pen'} onClick={() => setTool('pen')} label="Pen">
        <PenIcon />
      </ToolButton>
      <ToolButton active={tool === 'eraser'} onClick={() => setTool('eraser')} label="Eraser">
        <EraserIcon />
      </ToolButton>

      <Divider />

      {/* ── Color presets — 2 columns × 3 rows ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 14px)',
        gap: 4,
      }}>
        {COLOR_PRESETS.map(c => (
          <button
            key={c}
            onClick={() => setColor(c)}
            title={c}
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
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

      {/* ── Size slider — vertical, with a live size dot above the track ── */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
      }}>
        {/* Live size dot — shows current pen footprint */}
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
        <input
          type="range"
          min={MIN_PEN_SIZE}
          max={MAX_PEN_SIZE}
          step={1}
          value={size}
          onChange={e => setSize(parseInt(e.target.value, 10))}
          // Vertical orientation:
          //   writing-mode: vertical-lr  → block direction LTR, inline TTB
          //                                (slider min at TOP by default)
          //   direction: rtl             → flip inline direction, so min
          //                                lands at the BOTTOM and max at
          //                                the TOP (small ↓, big ↑)
          //   appearance: slider-vertical is the deprecated webkit fallback
          //                                for older Chrome/Safari builds.
          style={{
            writingMode: 'vertical-lr' as React.CSSProperties['writingMode'],
            direction: 'rtl',
            WebkitAppearance: 'slider-vertical',
            appearance: 'slider-vertical' as unknown as React.CSSProperties['appearance'],
            width: 8,
            height: 80,
            accentColor: '#7baed4',
            margin: 0,
          }}
          title={`Size: ${size}px`}
        />
      </div>

      <Divider />

      {/* ── Copy / Paste / Clear ── */}
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

      <Divider />

      {/* ── Done ── */}
      <button
        onClick={() => setSurface(null)}
        title="Exit annotation mode"
        style={{
          width: '100%',
          background: 'rgba(100,150,255,0.25)',
          border: '1px solid rgba(100,150,255,0.45)',
          borderRadius: 6,
          color: 'rgba(255,255,255,0.92)',
          fontSize: 10,
          fontWeight: 600,
          padding: '6px 0',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}
      >Done</button>
    </div>
  )
}

// ─── Subcomponents ────────────────────────────────────────────

const Divider: React.FC = () => (
  <div style={{
    width: '70%', height: 1, background: 'rgba(255,255,255,0.10)', flexShrink: 0,
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
    <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <path d="M3 11 L3 3 a1 1 0 0 1 1 -1 L11 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
  </svg>
)

const PasteIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="3" y="3" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <rect x="6" y="1.5" width="4" height="3" rx="0.8" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <line x1="6" y1="9" x2="10" y2="9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <line x1="6" y1="11.5" x2="10" y2="11.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
)

const TrashIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M2.5 4 L13.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M6 4 L6 2.5 a1 1 0 0 1 1 -1 L9 1.5 a1 1 0 0 1 1 1 L10 4" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <path d="M3.5 4 L4.5 13.5 a1 1 0 0 0 1 1 L10.5 14.5 a1 1 0 0 0 1 -1 L12.5 4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    <line x1="6.5" y1="6.5" x2="6.5" y2="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <line x1="9.5" y1="6.5" x2="9.5" y2="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
)
