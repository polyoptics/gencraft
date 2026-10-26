// EffectPalette — every effect, as a hand of little playing cards, under
// the top bar's Effects button.
//
// Click a card to add that effect — utils/fx/createEffect decides where:
// onto the end of the selected picture's strip, else mid-canvas. Drag one
// to put it where you let go (on a picture: onto that picture's strip).
// The palette STAYS OPEN while you click: each new card is selected, so the
// next click lines up after it and a strip takes a few clicks to build.
//
// Screen space and a fixed size: this is a menu, not a thing on the
// canvas, so it does not follow the zoom.
//
// Portalled to <body>. The bar is position:fixed with a transform, which
// makes it the containing block for anything fixed inside it, and its
// z 700 a stacking context that would put the palette under pinned panels
// (900). No backdrop either: one would sit under the cursor for the whole
// of an HTML5 drag and swallow the canvas's dragover.

import React from 'react'
import ReactDOM from 'react-dom'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { EFFECTS, EFFECT_ORDER, type EffectKind } from '../../utils/fx/effects'
import { EFFECT_DRAG_MIME, createEffectCard, effectAttachTarget } from '../../utils/fx/createEffect'

/** A palette card: 5:7, like the card it makes. */
const CARD_W = 84
const CARD_H = 118
const GAP = 8
const PAD = 10
const COLS = 6
const PANEL_W = COLS * CARD_W + (COLS - 1) * GAP + PAD * 2

/** The dark the effect colours are mixed into — near the canvas's own. */
const BASE = '#15161f'

/** `a` mixed into `b` by t (0 = all b). Flat colours, no alpha: a tint
 *  that stays the same over whatever is behind the palette. */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16)
  const ch = (p: number, s: number) => (p >> s) & 0xff
  const c = (s: number) => Math.round(ch(pa, s) * t + ch(pb, s) * (1 - t))
  return `rgb(${c(16)},${c(8)},${c(0)})`
}

const PaletteCard: React.FC<{ kind: EffectKind; onDropped: () => void }> = ({ kind, onDropped }) => {
  const d = EFFECTS[kind]
  const [hover, setHover] = React.useState(false)
  const add = () => createEffectCard(kind)
  return (
    <div
      role="button"
      tabIndex={0}
      title={`${d.label} — ${d.blurb}${d.blend ? '\nMixes in the next picture on its strip' : ''}\nClick to add · drag onto the canvas`}
      draggable
      onClick={add}
      onKeyDown={e => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        add()
      }}
      onDragStart={e => {
        // The kind and nothing else — see EFFECT_DRAG_MIME.
        e.dataTransfer.setData(EFFECT_DRAG_MIME, JSON.stringify({ kind }))
        e.dataTransfer.effectAllowed = 'copy'
      }}
      // Close once a drag has MADE something; a refused drop leaves the
      // palette up to try again. Not on dragstart: unmounting the source
      // mid-drag would lose this event.
      onDragEnd={e => { if (e.dataTransfer.dropEffect !== 'none') onDropped() }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: CARD_W, height: CARD_H, boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column',
        background: mixHex(d.color, BASE, hover ? 0.26 : 0.18),
        border: `1px solid ${mixHex(d.color, BASE, hover ? 0.85 : 0.4)}`,
        borderRadius: 8,
        overflow: 'hidden',
        cursor: 'grab',
        userSelect: 'none',
        transform: hover ? 'translateY(-2px)' : 'none',
        transition: 'transform 0.1s, background 0.1s, border-color 0.1s',
      }}
    >
      {/* Art — the glyph on a flat tint, the same art the card's face has. */}
      <div style={{
        flex: '1 1 auto', minHeight: 0, margin: 4, borderRadius: 5,
        background: mixHex(d.color, BASE, 0.34),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 28, lineHeight: 1, color: d.color,
        pointerEvents: 'none',
      }}>{d.glyph}</div>
      <div style={{
        padding: '0 6px', fontSize: 11, fontWeight: 600, color: '#fff',
        textShadow: '0 1px 2px rgba(0,0,0,0.6)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        pointerEvents: 'none',
      }}>{d.label}</div>
      <div style={{
        margin: '2px 6px 6px', fontSize: 8.5, lineHeight: '11px', height: 22,
        color: 'rgba(255,255,255,0.62)',
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        pointerEvents: 'none',
      }}>{d.blurb}</div>
    </div>
  )
}

/** The palette. Rendered by TopIconBar; open state lives there because the
 *  button that toggles it does. */
export const EffectPalette = React.memo(function EffectPalette({ open, anchorRef, onClose }: {
  open: boolean
  /** The toggle button: the palette hangs under it, and a press on it is
   *  not an "outside" press — its own click does the toggling. */
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const boxRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null)

  // Under the button, centred on it, kept on screen.
  React.useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect()
      if (!r) return
      const left = r.left + r.width / 2 - PANEL_W / 2
      setPos({ left: Math.max(8, Math.min(window.innerWidth - PANEL_W - 8, left)), top: r.bottom + 6 })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, anchorRef])

  // Escape, or a press anywhere else, closes it. Capture phase: the canvas
  // and its tiles preventDefault their pointerdowns (which kills the
  // compatibility mousedown) and some stop propagation.
  React.useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && (boxRef.current?.contains(t) || anchorRef.current?.contains(t))) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, anchorRef, onClose])

  // Where a click will put the card — the same test createEffectCard acts
  // on. A string, so this re-renders when the answer changes, not on every
  // tile drag frame.
  const attachTo = useFreeNodeStore(s => {
    if (!open) return null
    const t = effectAttachTarget(s.nodes, s.selectedIds)
    return t ? (t.label || 'the selected tile') : null
  })

  if (!open || !pos) return null
  return ReactDOM.createPortal(
    <div
      ref={boxRef}
      data-effect-palette
      role="dialog"
      aria-label="Effects"
      style={{
        position: 'fixed', left: pos.left, top: pos.top, width: PANEL_W, boxSizing: 'border-box',
        padding: PAD, zIndex: 1000,
        background: '#13141f',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 12,
        boxShadow: '0 10px 32px rgba(0,0,0,0.6)',
        color: 'rgba(255,255,255,0.85)',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 2px 8px' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>Effects</span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: 10.5, color: 'rgba(255,255,255,0.5)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {attachTo
            ? <>Click to add to the end of <span style={{ color: 'rgba(255,255,255,0.8)' }}>{attachTo}</span>’s strip — or drag onto the canvas</>
            : 'Click to add — or drag onto the canvas'}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLS}, ${CARD_W}px)`, gap: GAP }}>
        {EFFECT_ORDER.map(k => <PaletteCard key={k} kind={k} onDropped={onClose} />)}
      </div>
    </div>,
    document.body,
  )
})
