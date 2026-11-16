// NewCardPalette — the kinds of card there are to make, as a hand of little
// playing cards, under the top bar's New button. The Effects palette's
// look and manners (EffectPalette): groups with a name and a line on what
// their cards have in common, every card always in the same place.
//
// Two groups (Brian 2026-11-16): cards that are a face and a back of
// details of their own, and cards that do something of their own.
//
// Click a card to PICK IT UP (utils/placeTool): the palette closes, the
// card's outline follows the mouse, and the next click sets it down. Esc
// puts it back.
//
// Portalled to <body> and screen size, for EffectPalette's reasons.

import React from 'react'
import ReactDOM from 'react-dom'
import { CARD_TYPES, typeColor, type CardType } from '../../utils/cardTypes'
import { useBoardsStore } from '../../store/boardsStore'
import { startPlacing, startPlacingCard } from '../../utils/placeTool'

const CARD_W = 84
const CARD_H = 118
const GAP = 8
const PAD = 10
const GROUP_GAP = 16
const HEAD_H = 30
const COLS = 7
const PANEL_W = COLS * CARD_W + (COLS - 1) * GAP + PAD * 2
const BASE = '#15161f'

/** One card in the palette: a card type, or the 3D set (a tool that comes
 *  with its card, made as its own toolbar button makes it). */
type Item = CardType | 'area3d'

const ART: Record<Item, { glyph: string; blurb: string }> = {
  element:   { glyph: '▭', blurb: 'A plain card: any details you give it' },
  character: { glyph: '☺', blurb: 'ID, body, age, role, stats' },
  location:  { glyph: '⌂', blurb: 'Place, building, use, floors' },
  prop:      { glyph: '⚒', blurb: 'Kind, ammo, capacity, owner' },
  audio:     { glyph: '♪', blurb: 'Artist, length, tempo, key, mood' },
  event:     { glyph: '⚡', blurb: 'When, where, who, cause, outcome' },
  note:      { glyph: '✎', blurb: 'A note and its status' },
  faction:   { glyph: '⚑', blurb: 'Holds member cards, with ranks' },
  family:    { glyph: '❦', blurb: 'Holds member cards as kin' },
  scene:     { glyph: '▦', blurb: 'A face of sections that hold cards' },
  state:     { glyph: '◐', blurb: 'The states a thing can be in' },
  prompt:    { glyph: '❝', blurb: 'Rows of words for Card Prompts' },
  area3d:    { glyph: '◈', blurb: 'A mat that becomes a 3D workspace' },
  style:     { glyph: '✦', blurb: '' },
}

const GROUPS: { id: string; title: string; note: string; items: Item[] }[] = [
  { id: 'attributes', title: 'Attribute cards', note: 'A face, and a back of details of their own to fill in',
    items: ['element', 'character', 'location', 'prop', 'audio', 'event', 'note'] },
  { id: 'special', title: 'Special cards', note: 'Cards that do something of their own',
    items: ['faction', 'family', 'scene', 'state', 'prompt', 'area3d'] },
]

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16)
  const ch = (p: number, s: number) => (p >> s) & 0xff
  const c = (s: number) => Math.round(ch(pa, s) * t + ch(pb, s) * (1 - t))
  return `rgb(${c(16)},${c(8)},${c(0)})`
}

const PaletteCard: React.FC<{ item: Item; color: string; onPicked: () => void }> = ({ item, color, onPicked }) => {
  const [hover, setHover] = React.useState(false)
  const label = CARD_TYPES[item].label
  const { glyph, blurb } = ART[item]
  const add = () => { if (item === 'area3d') startPlacing('area'); else startPlacingCard(item); onPicked() }
  return (
    <div
      role="button"
      tabIndex={0}
      data-new-card-item={item}
      title={`${label} — ${blurb}\nClick to pick it up, then click where it goes`}
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
        background: mixHex(color, BASE, hover ? 0.26 : 0.18),
        border: `1px solid ${mixHex(color, BASE, hover ? 0.85 : 0.4)}`,
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
        background: mixHex(color, BASE, 0.34),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 28, lineHeight: 1, color: mixHex(color, '#ffffff', 0.55),
        pointerEvents: 'none',
      }}>{glyph}</div>
      <div style={{
        padding: '0 6px', fontSize: 11, fontWeight: 600, color: '#fff',
        textShadow: '0 1px 2px rgba(0,0,0,0.6)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        pointerEvents: 'none',
      }}>{label}</div>
      <div style={{
        margin: '2px 6px 6px', fontSize: 8.5, lineHeight: '11px', height: 22,
        color: 'rgba(255,255,255,0.62)',
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        pointerEvents: 'none',
      }}>{blurb}</div>
    </div>
  )
}

export const NewCardPalette = React.memo(function NewCardPalette({ open, anchorRef, onClose }: {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const boxRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null)
  // The colours chosen for the types, so a card here is the colour it makes.
  const typeColors = useBoardsStore(s => s.typeColors)

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
      data-new-card-palette
      role="dialog"
      aria-label="New card"
      style={{
        position: 'fixed', left: pos.left, top: pos.top, width: PANEL_W, boxSizing: 'border-box',
        padding: PAD, zIndex: 1000,
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
        <span style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>New card</span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: 10.5, color: 'rgba(255,255,255,0.5)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>Click a card to pick it up, then click where it goes.</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: GROUP_GAP - 4 }}>
        {GROUPS.map(g => (
          <div key={g.id} data-new-card-group={g.id}>
            <div style={{ height: HEAD_H, boxSizing: 'border-box', padding: '0 2px', overflow: 'hidden' }}>
              <div style={{
                fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.92)', lineHeight: '14px',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{g.title}</div>
              <div style={{
                fontSize: 9.5, color: 'rgba(255,255,255,0.5)', lineHeight: '12px',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{g.note}</div>
            </div>
            <div style={{ display: 'flex', gap: GAP }}>
              {g.items.map(it => <PaletteCard key={it} item={it} color={typeColor(it, typeColors)} onPicked={onClose} />)}
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  )
})
