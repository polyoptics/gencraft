// AnnotationCardBody — a model's Annotation card (Brian 2026-11-07): made
// the first time the model is annotated, interface-style like Card Prompts.
// Shows the model it is for, every pin with the card it links to and its
// status, and the strokes drawn on it. Laid out at one size and scaled with
// the card, like a photograph, so it looks the same however big it is.

import { isShut } from '../../utils/deckTree'
import React from 'react'
import { useNotesStore, useNotesUi, type ModelPin } from '../../store/notesStore'
import { rowOf } from '../../utils/primaryCard'
import { useBoardsStore } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { makeNoteCard, renamePin, setPinDesc, setPinStatus, pinTitle } from '../../utils/annotations'
import type { FreeNodeData } from '../../store/freeNodeStore'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { CARD_TYPES, cardTypeOf, detailShown } from '../../utils/cardTypes'

const W = 760
const MONO = '"JetBrains Mono", "Consolas", ui-monospace, monospace'
const stop = (e: React.PointerEvent) => e.stopPropagation()
const checkpoint = () => useUndoCoordinator.getState().checkpoint()

const field: React.CSSProperties = {
  font: 'inherit', color: '#e8f0ff', background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '3px 6px', outline: 'none', minWidth: 0,
}
const toggle = (on: boolean, color = '120,170,255'): React.CSSProperties => ({
  font: 'inherit', fontSize: 11, cursor: 'pointer', borderRadius: 5, padding: '3px 8px', whiteSpace: 'nowrap',
  background: on ? `rgba(${color},0.22)` : 'rgba(255,255,255,0.04)',
  border: `1px solid ${on ? `rgba(${color},0.6)` : 'rgba(255,255,255,0.12)'}`,
  color: on ? '#eef4ff' : 'rgba(255,255,255,0.6)',
})

/** One pin in the list: click to look at it. */
const PinItem: React.FC<{ pin: ModelPin; on: boolean; onPick: () => void }> = ({ pin, on, onPick }) => {
  useBoardsStore(s => s.groups)   // its title is its card's name, live
  const resolved = pin.status === 'resolved'
  const ink = resolved ? '#5fe39b' : '#7fd4ff'
  return (
    <div onPointerDown={stop} onClick={onPick}
      style={{ display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: '0 8px', borderRadius: 6, cursor: 'pointer',
        background: on ? 'rgba(127,212,255,0.12)' : 'transparent', borderLeft: `2px solid ${on ? ink : 'transparent'}` }}>
      <span style={{ width: 7, height: 7, flexShrink: 0, background: resolved ? ink : 'transparent', border: `1px solid ${ink}` }} />
      <span style={{ fontFamily: MONO, fontSize: 10, color: ink }}>{String(pin.n0).padStart(2, '0')}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12,
        color: resolved ? 'rgba(232,240,255,0.55)' : '#e8f0ff' }}>{pinTitle(pin)}</span>
    </div>
  )
}

/** The card a pin links to, beside it: its picture, type, details, and the
 *  deck it is in — the context, without going to find it on the canvas. */
const LinkedCard: React.FC<{ cardId: string; whole?: boolean }> = ({ cardId, whole }) => {
  const groups = useBoardsStore(s => s.groups)
  const g = groups.find(x => x.id === cardId)
  const img = useResolvedMedia(g?.cardHeroImage ?? null)
  if (!g) return <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>Its card is gone.</div>
  const type = CARD_TYPES[cardTypeOf(g)]
  const details = (g.details ?? []).map(d => ({ d, v: detailShown(groups, d).text })).filter(x => x.v)
  const anchor = g.deckAnchorId ?? (whole || (isShut(g)) ? g.id : undefined)
  // An open deck linked whole: its cards are the open row it fronts.
  const row = whole ? rowOf(g.id) : undefined
  const deck = row && row.length >= 2
    ? row.filter(id => id !== g.id).map(id => groups.find(x => x.id === id)).filter((x): x is NonNullable<typeof x> => !!x)
    : anchor ? groups.filter(x => x.id !== g.id && (x.id === anchor || x.deckAnchorId === anchor)) : []
  const members = (g.linkedGroupIds ?? []).map(id => groups.find(x => x.id === id)).filter((x): x is NonNullable<typeof x> => !!x)
  const chip = (c: typeof g) => (
    <span key={c.id} onPointerDown={stop} onClick={() => useBoardsStore.getState().setSelectedGroups([c.id])} title="Select this card"
      style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, cursor: 'pointer', background: `${c.color}2a`, border: `1px solid ${c.color}99`, whiteSpace: 'nowrap' }}>{c.name || 'Untitled'}</span>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      <div onPointerDown={stop} onClick={() => useBoardsStore.getState().setSelectedGroups([g.id])} title="Select this card on the canvas"
        style={{ display: 'flex', gap: 10, padding: 8, borderRadius: 8, cursor: 'pointer', background: 'rgba(255,255,255,0.03)', borderLeft: `3px solid ${g.color}` }}>
        {img && <img src={img} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 5, flexShrink: 0 }} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1.2, color: type.color }}>{whole ? `DECK · ${deck.length + 1} CARDS` : `${type.label.toUpperCase()} CARD`}</span>
          <span style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name || 'Untitled'}</span>
          {g.cardText && <span style={{ fontSize: 11, color: 'rgba(232,240,255,0.6)', lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{g.cardText}</span>}
        </div>
      </div>
      {details.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 3, fontSize: 11 }}>
          {details.map(({ d, v }) => (
            <React.Fragment key={d.id}>
              <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1, color: 'rgba(255,255,255,0.42)', paddingTop: 2 }}>{d.name.toUpperCase()}</span>
              <span style={{ color: 'rgba(232,240,255,0.85)', overflowWrap: 'anywhere' }}>{v}</span>
            </React.Fragment>
          ))}
        </div>
      )}
      {deck.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1, color: 'rgba(255,255,255,0.42)', marginRight: 2 }}>{whole ? 'CARDS' : 'DECK'}</span>
          {deck.map(chip)}
        </div>
      )}
      {members.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1, color: 'rgba(255,255,255,0.42)', marginRight: 2 }}>LINKED</span>
          {members.map(chip)}
        </div>
      )}
    </div>
  )
}

/** The pin being looked at: its words and status, and its card. */
const PinDetail: React.FC<{ url: string; pin: ModelPin }> = ({ url, pin }) => {
  useBoardsStore(s => s.groups)
  const linking = useNotesUi(s => s.linking)
  const resolved = pin.status === 'resolved'
  const isLinking = linking?.pinId === pin.id
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      <input value={pinTitle(pin)} onPointerDown={stop} onFocus={checkpoint} onChange={e => renamePin(url, pin, e.target.value)}
        style={{ ...field, fontWeight: 700, fontSize: 15 }} />
      <input value={pin.desc} placeholder="Second line (optional)" onPointerDown={stop} onFocus={checkpoint} onChange={e => setPinDesc(url, pin, e.target.value)}
        style={{ ...field, fontSize: 12, color: 'rgba(232,240,255,0.75)' }} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button style={toggle(resolved, '95,227,155')} onPointerDown={stop}
          onClick={() => { checkpoint(); setPinStatus(url, pin, resolved ? 'open' : 'resolved') }} title="Resolved: on or off">Resolved</button>
        <button style={toggle(isLinking)} onPointerDown={stop}
          onClick={() => useNotesUi.setState({ linking: isLinking ? null : { url, pinId: pin.id }, tool: null })}
          title="Link a card or a deck: click this, then click it on the canvas. A closed deck links the whole deck (Esc cancels)">{isLinking ? 'Click a card…' : 'Link card'}</button>
        {!pin.cardId && (
          <button style={toggle(false)} onPointerDown={stop}
            onClick={() => { checkpoint(); const id = makeNoteCard(url, pin.title, pin.desc); if (id) useNotesStore.getState().updatePin(url, pin.id, { cardId: id }) }}
            title="Make a Note card for this pin">New note card</button>
        )}
        <span style={{ flex: 1 }} />
        <button style={toggle(false)} onPointerDown={stop}
          onClick={() => { checkpoint(); useNotesStore.getState().removePin(url, pin.id); useNotesUi.setState({ focus: null }) }}
          title="Remove this pin (its card stays)">Remove pin</button>
      </div>
      <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '2px 0' }} />
      {pin.cardId ? <LinkedCard cardId={pin.cardId} whole={pin.deck} /> : <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>No card linked.</div>}
    </div>
  )
}

export const AnnotationCardBody: React.FC<{ node: FreeNodeData; bodyW: number; bodyH: number }> = ({ node, bodyW, bodyH }) => {
  const url = node.annotUrl ?? ''
  const notes = useNotesStore(s => s.models[url])
  const focus = useNotesUi(s => s.focus)
  const k = Math.max(0.05, bodyW / W)
  const pins = notes?.pins ?? []
  const open = pins.filter(p => p.status === 'open').length
  const shown = pins.find(p => focus?.url === url && p.id === focus.pinId) ?? pins[0]
  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', left: 0, top: 0, width: W, height: bodyH / k, transform: `scale(${k})`, transformOrigin: '0 0',
        display: 'flex', flexDirection: 'column', gap: 10, padding: 14, boxSizing: 'border-box',
        color: '#e8f0ff', fontSize: 13, fontFamily: 'inherit',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 8, borderBottom: '1px solid rgba(127,212,255,0.25)' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7fd4ff" strokeWidth="1.6" strokeLinejoin="round">
            <path d="M12 2.8l7.5 4.2v8.4L12 19.6 4.5 15.4V7z" /><path d="M4.5 7L12 11.2 19.5 7M12 11.2v8.4" opacity="0.6" />
          </svg>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 9, letterSpacing: 1.4, color: 'rgba(127,212,255,0.85)', fontFamily: MONO }}>SOURCE MODEL</span>
            <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{notes?.name ?? 'Model'}</span>
          </div>
          <span style={{ fontFamily: MONO, fontSize: 10, color: 'rgba(255,255,255,0.55)', textAlign: 'right', lineHeight: 1.5 }}>
            {pins.length} PINS · {open} OPEN<br />{notes?.strokes.length ?? 0} STROKES
          </span>
          <button style={toggle(false)} onPointerDown={stop} disabled={!notes?.strokes.length}
            onClick={() => { checkpoint(); useNotesStore.getState().clearStrokes(url) }} title="Remove the strokes drawn on this model">Clear strokes</button>
        </div>
        {pins.length === 0 ? (
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, lineHeight: 1.6, padding: '6px 2px' }}>
            No pins yet. With the Pin tool (Notes panel), click the model in 3D to pin a note on it. Each pin gets a Note card; link it to any card instead with Link card. Click a pin here or its label in 3D to see its card beside it.
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 12 }}>
            <div data-wheel-own="" style={{ width: 230, flexShrink: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, borderRight: '1px solid rgba(255,255,255,0.06)', paddingRight: 8 }}>
              {pins.map(p => <PinItem key={p.id} pin={p} on={p.id === shown?.id} onPick={() => useNotesUi.setState({ focus: { url, pinId: p.id } })} />)}
            </div>
            <div data-wheel-own="" style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
              {shown && <PinDetail url={url} pin={shown} />}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
