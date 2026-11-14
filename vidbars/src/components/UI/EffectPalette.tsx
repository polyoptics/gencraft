// EffectPalette — every effect, as a hand of little playing cards, under
// the top bar's Effects button.
//
// The cards are laid out by what they are (effects.ts EFFECT_GROUPS): each
// group has its name and a line on what its cards have in common — which
// are instant and which the drawing tool takes a second or two over.
//
// Click a card to PICK IT UP (utils/placeTool): the palette closes, the
// card's dashed outline follows the mouse, and the next click sets it down
// — on the canvas, or into a loop strip where the strip marks: between two
// of its cards, at either end, in a look row, under a card as its input.
// Esc puts it back. Or drag one out and let go where it should be.
//
// Screen space and a fixed size: this is a menu, not a thing on the
// canvas, so it does not follow the zoom.
//
// Portalled to <body>. The bar is position:fixed with a transform, which
// makes it the containing block for anything fixed inside it, and its
// z 700 a stacking context that would put the palette under pinned panels
// (900). No backdrop either: one would sit under the cursor for the whole
// of an HTML5 drag and swallow the canvas's dragover.
//
// One item is not an effect: it makes a LOOP STRIP (utils/rail), the rail
// a workflow is laid out on, picked up and set down the same way.

import React from 'react'
import ReactDOM from 'react-dom'
import { EFFECTS, EFFECT_GROUPS, type EffectKind } from '../../utils/fx/effects'
import { EFFECT_DRAG_MIME } from '../../utils/fx/createEffect'
import { startPlacing, startPlacingEffect } from '../../utils/placeTool'

/** A palette card: 5:7, like the card it makes. */
const CARD_W = 84
const CARD_H = 118
const GAP = 8
const PAD = 10
/** Between two groups side by side, and between rows of groups. */
const GROUP_GAP = 16
/** A group's heading: its name, and under it the line about its cards. */
const HEAD_H = 30
/** The widest row is the nine line-and-shading cards. */
const COLS = 9
const PANEL_W = COLS * CARD_W + (COLS - 1) * GAP + PAD * 2
/** The groups in the rows they sit in ('strip' is the loop-strip item). A
 *  fixed layout: every card is always in the same place. */
const ROWS: string[][] = [['light', 'stylize'], ['blend', 'find', 'strip'], ['drawlines'], ['drawlight', 'mix']]

/** The run arrow's orange (RailBody) — the loop strip's own colour. */
const RAIL_COLOR = '#D85A30'

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
  // Picked up: the palette gets out of the way of where it is going.
  const add = () => { startPlacingEffect(kind); onDropped() }
  return (
    <div
      role="button"
      tabIndex={0}
      title={`${d.label} — ${d.blurb}${d.blend ? '\nMixes in the next picture card after it — on a loop strip, the column after it' : ''}\nClick to pick it up, then click where it goes · or drag it there`}
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

/** The loop-strip item: makes a rail in the middle of the canvas you can
 *  see, selected (createLoopStrip). Click only — the rail is made where
 *  you are looking, then moved by its own background like any tile. Its
 *  art is what a rail IS: the run arrow over a column of cards dealt as a
 *  cascade. */
const LoopStripItem: React.FC<{ onPicked: () => void }> = ({ onPicked }) => {
  const [hover, setHover] = React.useState(false)
  // Picked up like the toolbar's own loop strip button (utils/placeTool).
  const add = () => { startPlacing('loopStrip'); onPicked() }
  // The cascade in the art: each card shows its top band, the last one whole.
  const cards = [0, 1, 2].map(i => ({ y: 40 + i * 17, t: 0.3 + i * 0.12 }))
  return (
    <div
      role="button"
      tabIndex={0}
      title={'Loop strip — a rail of slots that runs its effect cards over every picture docked under it\nClick to pick it up, then click where it goes'}
      onClick={add}
      onKeyDown={e => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        add()
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: CARD_W, height: CARD_H, boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column',
        background: mixHex(RAIL_COLOR, BASE, hover ? 0.2 : 0.13),
        border: `1px solid ${mixHex(RAIL_COLOR, BASE, hover ? 0.85 : 0.4)}`,
        borderRadius: 8,
        overflow: 'hidden',
        cursor: 'pointer',
        userSelect: 'none',
        transform: hover ? 'translateY(-2px)' : 'none',
        transition: 'transform 0.1s, background 0.1s, border-color 0.1s',
      }}
    >
      <div style={{
        flex: '1 1 auto', minHeight: 0, margin: 4, borderRadius: 5,
        background: mixHex(RAIL_COLOR, BASE, 0.2),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none',
      }}>
        <svg viewBox="0 0 76 130" width="100%" height={62} preserveAspectRatio="xMidYMid meet" aria-hidden>
          {/* The run arrow across the top. */}
          <rect x={6} y={12} width={52} height={11} rx={2} fill={RAIL_COLOR} />
          <polygon points="57,5 71,17.5 57,30" fill={RAIL_COLOR} />
          {/* A column, dealt as a cascade. */}
          {cards.map((c, i) => (
            <g key={i}>
              <rect x={16} y={c.y} width={44} height={56} rx={4}
                fill={mixHex('#ffffff', BASE, c.t)} stroke={mixHex('#ffffff', BASE, 0.62)} strokeWidth={1} />
              <rect x={16.5} y={c.y + 0.5} width={43} height={8} rx={3.5} fill="rgba(0,0,0,0.3)" />
            </g>
          ))}
        </svg>
      </div>
      <div style={{
        padding: '0 6px', fontSize: 11, fontWeight: 600, color: '#fff',
        textShadow: '0 1px 2px rgba(0,0,0,0.6)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        pointerEvents: 'none',
      }}>⟳ Loop strip</div>
      <div style={{
        margin: '2px 6px 6px', fontSize: 8.5, lineHeight: '11px', height: 22,
        color: 'rgba(255,255,255,0.62)',
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        pointerEvents: 'none',
      }}>Runs its cards over every picture</div>
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
        // A short window: the groups scroll inside it.
        maxHeight: `calc(100vh - ${pos.top + 8}px)`, overflowY: 'auto',
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
        }}>Click a card to pick it up, then click where it goes: the canvas, or between two cards on a loop strip. Or drag it there.</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: GROUP_GAP - 4 }}>
        {ROWS.map((row, r) => (
          <div key={r} style={{ display: 'flex', gap: GROUP_GAP }}>
            {row.map(id => {
              const g = EFFECT_GROUPS.find(x => x.id === id)
              const n = g ? g.kinds.length : 1
              return (
                <div key={id} data-effect-group={id} style={{ width: n * CARD_W + (n - 1) * GAP, flex: '0 0 auto' }}>
                  <div style={{ height: HEAD_H, boxSizing: 'border-box', padding: '0 2px', overflow: 'hidden' }}>
                    <div style={{
                      fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.92)', lineHeight: '14px',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{g ? g.title : 'Strip'}</div>
                    <div title={g?.note} style={{
                      fontSize: 9.5, color: 'rgba(255,255,255,0.5)', lineHeight: '12px',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{g ? g.note : 'What they go on'}</div>
                  </div>
                  <div style={{ display: 'flex', gap: GAP }}>
                    {g ? g.kinds.map(k => <PaletteCard key={k} kind={k} onDropped={onClose} />) : <LoopStripItem onPicked={onClose} />}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  )
})
