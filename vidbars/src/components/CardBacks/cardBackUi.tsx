// cardBackUi.tsx — the pieces the card-back windows share (Attributes, card
// Prompt Pad): what feeds the window, a card drawn small, and a card drawn
// large that you leaf through and turn over.

import React, { useEffect, useRef, useState } from 'react'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { cardFaceMedia } from '../../utils/cardGrid'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { CARD_TYPES, cardTypeOf, detailShown } from '../../utils/cardTypes'
import { cardTitle } from '../../utils/faceStyle'
import { fieldKey, type CardFeed } from '../../utils/cardBacks'
import { backColor } from '../Layers/CardBack'

export const INK = 'rgba(232,238,255,0.92)'
export const DIM = 'rgba(232,238,255,0.5)'
export const FAINT = 'rgba(232,238,255,0.28)'
export const LINE = 'rgba(255,255,255,0.08)'
export const PANEL_BG = '#10121b'

/** The picture on a card's face, ready to draw, or null. */
export function useFaceUrl(g: ProjectGroup | undefined): string | null {
  const boards = useBoardsStore(s => s.boards)
  const m = g ? cardFaceMedia(g, boards) : null
  const ref = !m ? null : m.type === 'image' ? m.url : (m.posterUrl ?? null)
  return useResolvedMedia(ref)
}

/** Its type's word, e.g. "Character". */
export const typeLabel = (g: ProjectGroup) => CARD_TYPES[cardTypeOf(g)].label

/** What feeds the window, as a strip across its top: how many cards, how
 *  many docked, and the Card Browser's search when one is magneted on. */
export const FeedBar: React.FC<{ feed: CardFeed; cards: ProjectGroup[]; right?: React.ReactNode }> = ({ feed, cards, right }) => {
  // The types fed, each a dot in its colour with its count.
  const types = new Map<string, { color: string; n: number }>()
  for (const g of cards) {
    const t = typeLabel(g)
    const e = types.get(t)
    if (e) e.n++
    else types.set(t, { color: g.color, n: 1 })
  }
  const pill: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5, height: 20, padding: '0 8px',
    borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: `1px solid ${LINE}`,
    fontSize: 11, color: DIM, whiteSpace: 'nowrap',
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderBottom: `1px solid ${LINE}`, flexShrink: 0, minWidth: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: INK, whiteSpace: 'nowrap' }}>
        {cards.length} {cards.length === 1 ? 'card' : 'cards'}
      </span>
      {feed.docked > 0 && <span style={pill} title="Cards touching this window, and the cards touching those">
        <DeckGlyph /> {feed.docked} docked</span>}
      {feed.browser && <span style={{ ...pill, color: '#cdbbff', borderColor: 'rgba(169,139,255,0.35)', background: 'rgba(169,139,255,0.10)' }}
        title="Every card the magneted Card Browser shows (type a card type there, e.g. character, to feed that type)">
        <BrowserGlyph /> Browser · {feed.browser.label} · {feed.browser.count}</span>}
      <div style={{ display: 'flex', gap: 8, marginLeft: 6, overflow: 'hidden', minWidth: 0 }}>
        {[...types].map(([t, e]) => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: DIM, whiteSpace: 'nowrap' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: e.color }} />{t} {e.n}
          </span>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      {right}
    </div>
  )
}

const DeckGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="2" y="4" width="8" height="10" rx="1.3" /><path d="M5 2h7.5a1.5 1.5 0 0 1 1.5 1.5V12" />
  </svg>
)
const BrowserGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="2.5" y="2" width="7" height="10" rx="1.3" /><circle cx="11" cy="10.5" r="3" /><path d="M13.2 12.7l1.6 1.6" />
  </svg>
)

/** With nothing fed, what to do about it. */
export const EmptyFeed: React.FC<{ what: string }> = ({ what }) => (
  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
    <div style={{ maxWidth: 380, textAlign: 'center', color: DIM, fontSize: 13, lineHeight: 1.6 }}>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 14, opacity: 0.7 }}>
        {[-8, 0, 8].map(r => (
          <div key={r} style={{ width: 34, height: 50, borderRadius: 5, border: '1.5px dashed rgba(232,238,255,0.35)', transform: `rotate(${r}deg)` }} />
        ))}
      </div>
      <div style={{ color: INK, fontWeight: 600, marginBottom: 4 }}>No cards yet</div>
      Dock a card or a deck against this window, or magnet a Card Browser to it and search it
      (a card type works, e.g. <i>character</i>). {what}
    </div>
  </div>
)

/** A card drawn small: its colour, its face picture, its name. */
export const MiniCard: React.FC<{ g: ProjectGroup; w: number; lit?: boolean; dim?: boolean; onClick?: () => void; title?: string }> = ({ g, w, lit, dim, onClick, title }) => {
  const url = useFaceUrl(g)
  const h = Math.round(w * 184 / 125)
  return (
    <div
      onClick={onClick}
      title={title ?? cardTitle(useBoardsStore.getState().groups, g)}
      style={{
        width: w, height: h, borderRadius: Math.max(3, w * 0.08), flexShrink: 0, position: 'relative', overflow: 'hidden',
        background: url ? `center / cover no-repeat url("${url}")` : `linear-gradient(160deg, ${g.color}, ${backColor(g.color)})`,
        boxShadow: lit ? `0 0 0 2px ${g.color}, 0 0 10px ${g.color}88` : `inset 0 0 0 1px ${g.color}`,
        opacity: dim ? 0.38 : 1, cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow 0.12s, opacity 0.12s',
      }}
    >
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: Math.max(3, h * 0.12), background: g.color, opacity: 0.95 }} />
    </div>
  )
}

/** A card drawn large, to look at: face up its picture, turned over its
 *  back with `field` lit. Arrows step through `list`; Go to takes you to
 *  the card on the canvas. */
export const CardPreview: React.FC<{
  list: ProjectGroup[]
  at: number
  onAt: (i: number) => void
  field?: string | null
  width: number
}> = ({ list, at, onAt, field, width }) => {
  const groups = useBoardsStore(s => s.groups)
  const g = list[Math.max(0, Math.min(at, list.length - 1))]
  const url = useFaceUrl(g)
  const [back, setBack] = useState(true)
  const [turn, setTurn] = useState(0)
  // The lit row in view on the back.
  // Scrolled by hand: scrollIntoView would scroll every box around it too,
  // the canvas's included.
  const litRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = litRef.current, box = backRef.current
    if (!row || !box) return
    const top = row.offsetTop, bottom = top + row.offsetHeight
    if (top < box.scrollTop) box.scrollTop = top - 4
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 4
  }, [g?.id, field, back])
  if (!g) return null
  const h = Math.round(width * 184 / 125)
  const title = cardTitle(groups, g)
  const flip = () => { setTurn(t => t + 1); window.setTimeout(() => setBack(b => !b), 140) }
  const step = (d: number) => list.length > 1 && onAt((at + d + list.length) % list.length)
  const btn: React.CSSProperties = {
    height: 24, minWidth: 28, padding: '0 8px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
    background: 'rgba(255,255,255,0.06)', border: `1px solid ${LINE}`, color: INK, fontSize: 12,
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <div style={{ perspective: 900 }}>
        <div
          key={turn}
          onClick={flip}
          title="Click to turn it over"
          style={{
            width, height: h, borderRadius: 10, overflow: 'hidden', position: 'relative', cursor: 'pointer',
            boxShadow: `0 10px 30px rgba(0,0,0,0.55), 0 0 0 1px ${g.color}`,
            background: back ? backColor(g.color) : url ? `center / cover no-repeat url("${url}"), #000` : `linear-gradient(160deg, ${g.color}, ${backColor(g.color)})`,
            animation: turn ? 'cbFlip 280ms ease-in-out' : undefined,
          }}
        >
          <div style={{
            height: 30, background: g.color, display: 'flex', alignItems: 'center', padding: '0 10px', gap: 6,
            color: '#fff', fontSize: 13, fontWeight: 700, textShadow: '0 1px 2px rgba(0,0,0,0.4)',
          }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title || 'Untitled'}</span>
            <span style={{ fontSize: 10, fontWeight: 600, opacity: 0.85, textTransform: 'uppercase', letterSpacing: 0.6 }}>{typeLabel(g)}</span>
          </div>
          {back && (
            <div ref={backRef} style={{ position: 'absolute', inset: '30px 0 0 0', overflowY: 'auto', padding: '8px 12px' }} data-wheel-own="">
              {(g.details ?? []).length === 0 && <div style={{ color: DIM, fontSize: 12, marginTop: 8 }}>Nothing on its back yet.</div>}
              {(g.details ?? []).map(d => {
                const on = !!field && fieldKey(d.name) === field
                const shown = detailShown(groups, d).text
                return (
                  <div key={d.id} ref={on ? litRef : undefined} style={{
                    padding: '4px 6px', margin: '0 -6px 2px', borderRadius: 5,
                    background: on ? 'rgba(255,255,255,0.14)' : 'transparent',
                    boxShadow: on ? `inset 2px 0 0 ${g.color}` : undefined,
                  }}>
                    <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: on ? '#fff' : 'rgba(255,255,255,0.55)' }}>{d.name || '—'}</div>
                    <div style={{ fontSize: 12.5, color: shown ? '#fff' : 'rgba(255,255,255,0.3)', lineHeight: 1.35, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{shown || 'empty'}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button style={btn} onClick={() => step(-1)} disabled={list.length < 2} title="Previous card (←)">◀</button>
        <span style={{ fontSize: 12, color: DIM, minWidth: 54, textAlign: 'center' }}>{at + 1} / {list.length}</span>
        <button style={btn} onClick={() => step(1)} disabled={list.length < 2} title="Next card (→)">▶</button>
        <button style={btn} onClick={flip} title="Turn it over">{back ? 'Face' : 'Back'}</button>
        <button
          style={btn}
          title="Go to this card on the canvas"
          onClick={() => { useCanvasStore.getState().jumpToGroup(g.id); useBoardsStore.getState().setSelectedGroup(g.id) }}
        >Go to</button>
      </div>
    </div>
  )
}

/** The flip keyframes, once. */
export const CardBackStyles: React.FC = () => (
  <style>{`@keyframes cbFlip { 0% { transform: rotateY(0) } 50% { transform: rotateY(90deg) } 51% { transform: rotateY(-90deg) } 100% { transform: rotateY(0) } }`}</style>
)
