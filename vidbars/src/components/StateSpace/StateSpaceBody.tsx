// StateSpaceBody — the state workspace's picture and hands (utils/stateSpace):
// nodes on a dotted ground, the wires between their ports, and a bar down the
// right side for the extras of whatever is picked. The bar never changes size.
//
// Hands, all on the ground itself:
//   - a card or deck dragged in becomes a node (CardLayer lets it go here;
//     the card goes back); a storyline dragged in by its handle becomes a
//     timeline node (StorylineLayer).
//   - Event, Blank and Any are dragged off the little shelf at the top left.
//   - drag from a port to a port to wire them; the ports a wire can go to
//     light up while it is drawn, and its end pulls onto the nearest. Let go
//     on bare ground and an event is made there, wired.
//   - drag a node by its body to move it (with everything else picked);
//     drag bare ground to pick with a box; Shift adds to what is picked.
//   - double-click a card to light it as now, an event to fire it, a change
//     to make it. Drag along a timeline to move its time marker.
//   - Delete removes what is picked.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { isTilted, useTiltStore } from '../../store/tiltStore'
import { ContentScaled } from '../UI/PanelSurface'
import { cardFaceSourceUrl, stackedDeckMembers } from '../../utils/cardGrid'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { cardTypeOf, typeColor } from '../../utils/cardTypes'
import { goToCard } from '../../utils/stateCard'
import { scrubStoryline } from '../Canvas/StorylineLayer'
import {
  EVENT_H, EVENT_W, ICON, PORT_SNAP, SPACE_BAR_W, SPACE_GRID, TL_H,
  addItem, addWire, editSpace, emptyStateSpace, fireEvent, itemPorts, itemSize, lineClock, looseCurve, makeChange,
  moveItems, normalizeSpace, outSpot, patchItem, patchWire, planeBox, portSpot, removeFromSpace, screenToCanvas, setNow, setStart,
  useSpaceLive, wireDist, wireGeom, wireKind, wireSources, wireTargets,
  type PortRef, type PortSpot, type SpaceItem, type SpaceKind, type SpaceWire, type StateSpaceData, type WireGeom,
} from '../../utils/stateSpace'

const GREEN = '#5fa86c', BLUE = '#6fb7e0', AMBER = '#d9a441', VIOLET = '#b08cf0', STEEL = 'rgb(160,180,190)'
const DIM = 'rgba(255,255,255,0.45)', INK = '#e4e9ea', GROUND = '#171b1e', PANEL = '#1f262b'
const FONT = 'Inter, system-ui, sans-serif'

const CSS = `
.vb-sp-node{transition:box-shadow .18s,border-color .18s,background-color .18s}
.vb-sp-port{transition:transform .12s,background-color .12s,border-color .12s,opacity .12s}
.vb-sp-port:hover{transform:scale(1.35)}
.vb-sp-chip:hover{background:rgba(255,255,255,0.12)}
.vb-sp-row:hover{color:#fff}
@keyframes vbSpPulse{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(1.35)}}
@keyframes vbSpFlow{to{stroke-dashoffset:-18}}
`

const snap = (v: number, free: boolean) => free ? v : Math.round(v / SPACE_GRID) * SPACE_GRID

function itemLabel(i: SpaceItem, cardName?: string, lineTitle?: string): string {
  if (i.name) return i.name
  if (i.kind === 'any') return 'Any'
  if (i.kind === 'timeline') return lineTitle || 'Timeline'
  if (i.card) return cardName || (i.kind === 'event' ? 'Event' : 'Card')
  return i.kind === 'event' ? 'Event' : 'State'
}

/** What colour a wire is, by what sends along it. */
function wireTone(d: StateSpaceData, w: SpaceWire): string {
  const k = wireKind(d, w)
  if (k !== 'signal') return STEEL
  const a = d.items.find(i => i.id === w.a)?.kind
  return a === 'timeline' ? AMBER : a === 'event' ? VIOLET : GREEN
}

// ── Nodes ──

const Pulse: React.FC<{ stamp: number | undefined; radius: number | string; tone: string }> = ({ stamp, radius, tone }) =>
  stamp && Date.now() - stamp < 700
    ? <div key={stamp} style={{ position: 'absolute', inset: -3, borderRadius: radius, border: `2px solid ${tone}`, pointerEvents: 'none', animation: 'vbSpPulse .55s ease-out forwards' }} />
    : null

const NodeView: React.FC<{ item: SpaceItem; picked: boolean; stamp?: number }> = ({ item, picked, stamp }) => {
  const card = useBoardsStore(s => item.card ? s.groups.find(g => g.id === item.card) : undefined)
  const boards = useBoardsStore(s => s.boards)
  const count = useBoardsStore(s => card && card.deckState && card.deckState !== 'open' ? stackedDeckMembers(card.id, s.groups).length : 0)
  const src = useResolvedMedia(card ? cardFaceSourceUrl(card, boards) : null)
  const gone = !!item.card && !card
  const { w, h } = itemSize(item)
  const box: React.CSSProperties = { position: 'absolute', left: item.x - w / 2, top: item.y - h / 2, width: w, height: h, boxSizing: 'border-box', cursor: 'grab', userSelect: 'none', fontFamily: FONT }
  const ring = picked ? `0 0 0 2px ${BLUE}` : ''
  if (item.kind === 'any') {
    return (
      <div data-sp-node={item.id} className="vb-sp-node" title="Any: an arrow out of it is a change that can be made from anywhere" style={{
        ...box, borderRadius: '50%', border: `2px solid ${STEEL}`, background: PANEL, boxShadow: ring || 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: INK, fontSize: 12,
      }}>{itemLabel(item)}</div>
    )
  }
  if (item.kind === 'event') {
    return (
      <div data-sp-node={item.id} className="vb-sp-node" title="Event: double-click to fire it" style={{
        ...box, borderRadius: EVENT_H / 2, border: `2px solid ${VIOLET}`, background: '#2a2438', boxShadow: ring || 'none',
        display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px', color: INK, fontSize: 12, opacity: gone ? 0.5 : 1,
      }}>
        <svg width="12" height="16" viewBox="0 0 12 16" style={{ flexShrink: 0 }}><path d="M7 0L0 9h5l-1 7 7-10H6z" fill={VIOLET} /></svg>
        <div style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{gone ? 'card gone' : itemLabel(item, card?.name)}</div>
        {card && <div title="Hooked to an Event card" style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: card.color || typeColor(cardTypeOf(card)) }} />}
        <Pulse stamp={stamp} radius={EVENT_H / 2} tone={VIOLET} />
      </div>
    )
  }
  const tint = card ? card.color || typeColor(cardTypeOf(card)) : '#3a444b'
  return (
    <div data-sp-node={item.id} className="vb-sp-node" style={{
      ...box, borderRadius: 12, border: `2px ${item.kind === 'blank' ? 'dashed' : 'solid'} ${item.now ? GREEN : 'rgba(255,255,255,0.22)'}`,
      background: item.now ? '#2c4a33' : PANEL, padding: 6,
      boxShadow: [ring, item.now ? '0 0 18px rgba(95,168,108,0.55)' : ''].filter(Boolean).join(', ') || 'none',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ flex: 1, minHeight: 0, borderRadius: 6, overflow: 'hidden', background: item.kind === 'blank' ? 'rgba(255,255,255,0.05)' : tint, position: 'relative', opacity: gone ? 0.4 : 1 }}>
        {src && <img src={src} draggable={false} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
        {count > 1 && <div title={`A deck of ${count}`} style={{
          position: 'absolute', right: 3, top: 3, minWidth: 16, height: 16, borderRadius: 8, padding: '0 4px', boxSizing: 'border-box',
          background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: 10, lineHeight: '16px', textAlign: 'center',
        }}>{count}</div>}
      </div>
      <div style={{
        height: 20, lineHeight: '22px', fontSize: 11, textAlign: 'center', color: INK, flexShrink: 0,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: item.now ? 600 : 400,
      }}>{gone ? 'card gone' : itemLabel(item, card?.name)}</div>
      {/* Its tags sit outside the box: always the same place, lit or not. */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: -17, textAlign: 'center', fontSize: 9, letterSpacing: '0.1em', color: GREEN, fontWeight: 600, pointerEvents: 'none', opacity: item.now ? 1 : 0, transition: 'opacity .18s' }}>NOW</div>
      {item.start && <div title="Where this machine starts" style={{ position: 'absolute', left: 0, right: 0, bottom: -16, textAlign: 'center', fontSize: 9, letterSpacing: '0.1em', color: DIM, pointerEvents: 'none' }}>START</div>}
      <Pulse stamp={stamp} radius={12} tone={GREEN} />
    </div>
  )
}

const TimelineView: React.FC<{ item: SpaceItem; picked: boolean; playing: boolean }> = ({ item, picked, playing }) => {
  const c = lineClock(item.line)
  const { w, h } = itemSize(item)
  return (
    <div data-sp-node={item.id} className="vb-sp-node" style={{
      position: 'absolute', left: item.x - w / 2, top: item.y - h / 2, width: w, height: h, boxSizing: 'border-box', cursor: 'grab', userSelect: 'none',
      fontFamily: FONT, background: '#262218', border: `2px solid ${c ? 'rgba(217,164,65,0.6)' : 'rgba(255,255,255,0.2)'}`, borderRadius: 10,
      boxShadow: picked ? `0 0 0 2px ${BLUE}` : 'none',
    }}>
      <div style={{ position: 'absolute', left: 30, right: 10, top: 5, fontSize: 9, letterSpacing: '0.1em', color: DIM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        TIMELINE  ·  {(item.name || c?.title || 'storyline gone').toUpperCase()}
      </div>
      {c && <div data-sp-play={item.id} className="vb-sp-chip" title="Play: the time marker runs through the story and everything wired to it happens as it passes. Lit while it plays; click again to stop" style={{
        position: 'absolute', left: 7, top: 3, width: 17, height: 15, borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: playing ? 'rgba(217,164,65,0.35)' : 'rgba(255,255,255,0.06)', border: `1px solid ${playing ? AMBER : 'rgba(255,255,255,0.18)'}`, boxSizing: 'border-box',
      }}><svg width="7" height="8" viewBox="0 0 7 8"><path d="M0 0L7 4L0 8z" fill={playing ? AMBER : 'rgba(255,255,255,0.7)'} /></svg></div>}
      {c && <>
        {/* Along it: its time marker, the storyline's own. */}
        <div data-sp-track={item.id} title="Drag along here to move the time marker" style={{ position: 'absolute', left: -2, right: -2, top: 20, height: 26, cursor: 'ew-resize' }}>
          <div style={{ position: 'absolute', left: 8, right: 8, top: 12, height: 2, borderRadius: 1, background: 'rgba(217,164,65,0.3)' }} />
          <div style={{ position: 'absolute', left: 8, width: Math.max(0, c.toFrac(c.at) * w - 8), top: 12, height: 2, borderRadius: 1, background: AMBER }} />
          {c.dots.map(p => <div key={p.id} style={{
            position: 'absolute', left: p.frac * w - 5, top: 8, width: 10, height: 10, borderRadius: '50%', boxSizing: 'border-box',
            background: p.at <= c.at ? AMBER : '#262218', border: `2px solid ${AMBER}`,
          }} />)}
          <div style={{ position: 'absolute', left: c.toFrac(c.at) * w - 6, top: 0, width: 12, height: 16, borderRadius: '3px 3px 6px 6px', background: '#9fe0ff', border: '2px solid #12131f', boxSizing: 'border-box' }} />
        </div>
        {c.dots.map(p => <div key={p.id} style={{
          position: 'absolute', left: p.frac * w - 41, width: 82, top: 48, textAlign: 'center', fontSize: 10, color: p.at <= c.at ? INK : DIM,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none',
        }}>{p.title}</div>)}
      </>}
    </div>
  )
}

// ── The side bar ──

const label: React.CSSProperties = { fontSize: 9, letterSpacing: '0.1em', color: DIM, fontFamily: FONT, marginBottom: 4 }
const field: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 4, color: INK, fontSize: 12, fontFamily: FONT, padding: '5px 7px', outline: 'none', flexShrink: 0,
}
const btn = (lit = false): React.CSSProperties => ({
  background: lit ? 'rgba(95,168,108,0.3)' : 'rgba(255,255,255,0.05)', border: `1px solid ${lit ? GREEN : 'rgba(255,255,255,0.14)'}`,
  borderRadius: 4, color: lit ? '#fff' : 'rgba(255,255,255,0.75)', fontSize: 11, fontFamily: FONT, padding: '5px 9px', cursor: 'pointer',
  alignSelf: 'flex-start', flexShrink: 0,
})
const row: React.CSSProperties = { fontSize: 12, fontFamily: FONT, color: INK, padding: '3px 0', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 }
const gap: React.CSSProperties = { ...label, marginTop: 14 }

/** A text box that writes on every change but takes one undo step a visit. */
const Text: React.FC<{ value: string; placeholder?: string; area?: boolean; onChange: (v: string, first: boolean) => void }> = ({ value, placeholder, area, onChange }) => {
  const fresh = useRef(true)
  const props = {
    value, placeholder, style: area ? { ...field, height: 72, resize: 'none' as const } : field,
    onFocus: () => { fresh.current = true },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { onChange(e.target.value, fresh.current); fresh.current = false },
    onKeyDown: (e: React.KeyboardEvent) => { e.stopPropagation(); if (e.key === 'Enter' && !area) (e.target as HTMLElement).blur() },
  }
  return area ? <textarea {...props} /> : <input {...props} />
}

const Bar: React.FC<{ id: string; d: StateSpaceData; sel: string[]; setSel: (s: string[]) => void }> = ({ id, d, sel, setSel }) => {
  const groups = useBoardsStore(s => s.groups)
  const nameOf = (itemId: string | undefined) => {
    const i = d.items.find(x => x.id === itemId)
    return i ? itemLabel(i, groups.find(g => g.id === i.card)?.name, lineClock(i.line)?.title) : '?'
  }
  /** One end of a wire, in words. */
  const fromName = (w: SpaceWire) => {
    const a = d.items.find(i => i.id === w.a)
    if (a?.kind !== 'timeline' || !w.ap) return nameOf(w.a)
    return `${lineClock(a.line)?.dots.find(p => 'pt:' + p.id === w.ap)?.title ?? 'point gone'}, ${nameOf(w.a)}`
  }
  const toName = (w: SpaceWire): string => {
    if (w.bp !== 'knob') return nameOf(w.b) + (w.bp === 'if' ? ' (only if)' : '')
    const c = d.wires.find(x => x.id === w.b)
    return c ? `${c.name || 'change'}: ${nameOf(c.a)} → ${nameOf(c.b)}` : '?'
  }
  const wireLine = (w: SpaceWire) => {
    const k = wireKind(d, w)
    return k === 'signal' ? `${fromName(w)} → ${toName(w)}` : `${w.name || (k === 'link' ? 'line' : 'change')}: ${nameOf(w.a)} ${k === 'link' ? '—' : '→'} ${nameOf(w.b)}`
  }
  const wireRows = (title: string, list: SpaceWire[]) => <>
    <div style={gap}>{title}</div>
    {list.length ? list.map(w => <div key={w.id} className="vb-sp-row" style={row} onClick={() => setSel([w.id])}>{wireLine(w)}</div>)
      : <div style={{ ...row, color: DIM, cursor: 'default' }}>none</div>}
  </>
  const remove = (what: string) => <>
    <div style={{ flex: 1 }} />
    <button style={btn()} onClick={() => { removeFromSpace(id, sel); setSel([]) }}>{what}</button>
  </>
  const item = sel.length === 1 ? d.items.find(i => i.id === sel[0]) : undefined
  const wire = sel.length === 1 ? d.wires.find(w => w.id === sel[0]) : undefined
  let head = 'STATES', body: React.ReactNode
  if (item) {
    const card = groups.find(g => g.id === item.card)
    const wiresIn = d.wires.filter(w => w.b === item.id), wiresOut = d.wires.filter(w => w.a === item.id)
    const state = item.kind === 'card' || item.kind === 'blank'
    head = item.kind === 'timeline' ? 'TIMELINE' : item.kind === 'event' ? 'EVENT' : item.kind === 'any' ? 'ANY' : 'NODE'
    body = <>
      <div style={label}>NAME</div>
      <Text value={item.name ?? ''} placeholder={nameOf(item.id)} onChange={(v, first) => patchItem(id, item.id, { name: v || undefined }, first)} />
      {item.card && <>
        <div style={gap}>CARD</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          <div style={{ ...row, flex: 1, cursor: 'default' }}>{card ? card.name || 'Card' : 'card gone'}</div>
          {card && <button style={btn()} onClick={() => goToCard(card.id)}>Go to</button>}
        </div>
        {item.kind === 'event' && !!card?.stateChanges?.length && <div style={{ ...row, color: DIM, cursor: 'default' }}>makes {card.stateChanges.length} State card change{card.stateChanges.length > 1 ? 's' : ''} when it fires</div>}
      </>}
      {item.kind === 'timeline' && <>
        <div style={gap}>STORYLINE</div>
        <button style={btn()} onClick={() => {
          const n = useFreeNodeStore.getState().nodes[item.line ?? '']
          const dots = n?.storyline?.dots ?? []
          if (n && dots.length) useCanvasStore.getState().jumpToPoint(n.x + (Math.min(...dots.map(p => p.x)) + Math.max(...dots.map(p => p.x))) / 2, n.y + (Math.min(...dots.map(p => p.y)) + Math.max(...dots.map(p => p.y))) / 2)
        }}>Go to</button>
      </>}
      {state && <>
        <div style={gap}>STATE</div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button style={btn(!!item.now)} title="Lit: this is how things are now" onClick={() => setNow(id, item.id, !item.now)}>Now</button>
          <button style={btn(!!item.start)} title="Lit: this is lit before anything on a timeline has happened" onClick={() => setStart(id, item.id, !item.start)}>Start</button>
        </div>
      </>}
      {item.kind === 'event' && <>
        <div style={gap}>RUN</div>
        <button style={btn()} title="Fire it now, as a double-click on it does" onClick={() => fireEvent(id, item.id)}>Fire</button>
      </>}
      {item.kind !== 'timeline' && item.kind !== 'any' && wireRows('WIRES IN', wiresIn)}
      {wireRows('WIRES OUT', wiresOut)}
      <div style={gap}>NOTE</div>
      <Text area value={item.note ?? ''} onChange={(v, first) => patchItem(id, item.id, { note: v || undefined }, first)} />
      {remove(item.kind === 'timeline' ? 'Take out (the storyline stays)' : 'Remove')}
    </>
  } else if (wire) {
    const k = wireKind(d, wire)
    head = k === 'change' ? 'CHANGE' : k === 'link' ? 'LINE' : 'WIRE'
    body = <>
      {k !== 'signal' && <>
        <div style={label}>NAME</div>
        <Text value={wire.name ?? ''} placeholder={k === 'link' ? 'line' : 'change'} onChange={(v, first) => patchWire(id, wire.id, { name: v || undefined }, first)} />
      </>}
      <div style={k === 'signal' ? label : gap}>{k === 'signal' ? 'WHEN' : 'FROM'}</div>
      <div className="vb-sp-row" style={row} onClick={() => setSel([wire.a])}>{fromName(wire)}</div>
      <div style={gap}>{k !== 'signal' ? 'TO' : wire.bp === 'knob' ? 'THIS CHANGE IS MADE' : wire.bp === 'if' ? 'THIS EVENT CAN GO THROUGH' : d.items.find(i => i.id === wire.b)?.kind === 'event' ? 'THIS EVENT FIRES' : 'THIS IS LIT'}</div>
      <div className="vb-sp-row" style={row} onClick={() => setSel([wire.b])}>{toName(wire)}</div>
      {k !== 'signal' && <>
        <div style={gap}>OPTIONS</div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button style={btn(!wire.plain)} title="Lit: an arrow, a change from one to the other. Unlit: a plain line, any other relationship" onClick={() => patchWire(id, wire.id, { plain: wire.plain ? undefined : true })}>Arrow</button>
          <button style={btn()} title="Swap its two ends" onClick={() => { editSpace(id, s => ({ ...s, wires: s.wires.map(w => w.id === wire.id ? { ...w, a: w.b, b: w.a } : w) })) }}>Turn round</button>
        </div>
      </>}
      {k === 'change' && <>
        <div style={gap}>RUN</div>
        <button style={btn()} title="Its far end becomes now, as a double-click on it does" onClick={() => makeChange(id, wire.id)}>Make this change</button>
        {wireRows('MADE WHEN', d.wires.filter(w => w.bp === 'knob' && w.b === wire.id))}
      </>}
      <div style={gap}>NOTE</div>
      <Text area value={wire.note ?? ''} onChange={(v, first) => patchWire(id, wire.id, { note: v || undefined }, first)} />
      {remove('Remove')}
    </>
  } else if (sel.length > 1) {
    head = `${sel.length} PICKED`
    body = <>
      <div style={{ ...row, cursor: 'default', color: DIM }}>Drag any of them to move them all.</div>
      {remove('Remove all')}
    </>
  } else {
    const hint: React.CSSProperties = { fontSize: 12, fontFamily: FONT, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5, marginBottom: 8 }
    body = <>
      <div style={hint}>Drag cards, decks and storylines in.</div>
      <div style={hint}>Drag from a port to a port to wire two things. Let go on bare ground to make an event there.</div>
      <div style={hint}>Card to card is a change. A wire onto a change's knob makes that change.</div>
      <div style={hint}>Double-click a card to light it, an event to fire it, a change to make it.</div>
      <div style={gap}>IN HERE</div>
      <div style={{ ...row, cursor: 'default', color: DIM }}>{d.items.length} nodes, {d.wires.length} wires</div>
    </>
  }
  return (
    <div data-sp-bar="" style={{
      width: SPACE_BAR_W, flexShrink: 0, boxSizing: 'border-box', borderLeft: '1px solid rgba(255,255,255,0.1)', background: '#1c2125',
      padding: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ ...label, marginBottom: 12 }}>{head}</div>
      {body}
    </div>
  )
}

// ── The workspace ──

const SHELF: { kind: SpaceKind; name: string; title: string }[] = [
  { kind: 'event', name: 'Event', title: 'Drag onto the ground: something that happens, between other nodes' },
  { kind: 'blank', name: 'Blank', title: 'Drag onto the ground: a node with no card yet' },
  { kind: 'any', name: 'Any', title: 'Drag onto the ground: stands for every node; an arrow out of it is a change from anywhere' },
]

type Draw = { from: PortRef; fromInput: boolean; spot: PortSpot; x: number; y: number; snap: PortRef | null; cands: { ref: PortRef; spot: PortSpot }[] }
const sameRef = (a: PortRef | null | undefined, b: PortRef) => !!a && a.node === b.node && a.wire === b.wire && a.port === b.port

export function StateSpaceBody({ id, node, bodyW, bodyH }: { id: string; node: FreeNodeData; bodyW: number; bodyH: number }) {
  const d = useMemo(() => normalizeSpace(node.stateSpace ?? EMPTY), [node.stateSpace])
  const ui = node.uiScale ?? 1
  const planeW = Math.max(0, bodyW / ui - SPACE_BAR_W), planeH = bodyH / ui
  // The storylines dragged in, as they are now (their points, their marker).
  const lines = useFreeNodeStore(useShallow(s => d.items.filter(i => i.kind === 'timeline').map(i => s.nodes[i.line ?? '']?.storyline)))
  const [sel, setSel] = useState<string[]>([])
  const [draw, setDraw] = useState<Draw | null>(null)
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [ghost, setGhost] = useState<{ kind: SpaceKind; name: string; x: number; y: number } | null>(null)
  const [pulse, setPulse] = useState<Record<string, number>>({})
  const [playing, setPlaying] = useState<string | null>(null)
  // What has just happened here (utils/stateSpace useSpaceLive): shown for a
  // moment as lights running along the wires it went by.
  const live = useSpaceLive(s => s[id])
  const [flow, setFlow] = useState<{ stamp: number; wires: string[] } | null>(null)
  useEffect(() => {
    if (!live || Date.now() - live.stamp > 500) return
    setFlow({ stamp: live.stamp, wires: live.wires })
    if (live.fired.length) setPulse(p => ({ ...p, ...Object.fromEntries(live.fired.map(f => [f, live.stamp])) }))
    const t = window.setTimeout(() => setFlow(f => f?.stamp === live.stamp ? null : f), 750)
    return () => window.clearTimeout(t)
  }, [live])
  // Play: a timeline's marker runs from where it is to the end, a point
  // every 1.4 seconds, however far apart the points are on the storyline.
  useEffect(() => {
    const tl = playing ? dRef.current.items.find(i => i.id === playing) : undefined
    const c0 = tl ? lineClock(tl.line) : null
    if (!tl || !c0) { if (playing) setPlaying(null); return }
    useUndoCoordinator.getState().checkpoint()
    // From where it is; from the beginning once it is past the last point.
    let f = c0.dots.every(p => p.at <= c0.at) ? 0 : c0.toFrac(c0.at)
    let last = performance.now(), raf = 0
    const per = 1400 * (c0.dots.length + 1)
    const tick = (t: number) => {
      const c = lineClock(tl.line)
      if (!c) { setPlaying(null); return }
      f = Math.min(1, f + (t - last) / per)
      last = t
      scrubStoryline(tl.line!, c.toValue(f))
      if (f >= 1) { setPlaying(null); return }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])
  const plane = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const selRef = useRef(sel)
  selRef.current = sel
  const dRef = useRef(d)
  dRef.current = d

  // A node that has just been lit, or an event just fired, rings once.
  const before = useRef<StateSpaceData | null>(null)
  useEffect(() => {
    const prev = before.current
    before.current = d
    if (!prev) return
    const was = new Set(prev.items.filter(i => i.now).map(i => i.id))
    const lit = d.items.filter(i => i.now && !was.has(i.id) && prev.items.some(p => p.id === i.id))
    if (lit.length) setPulse(p => ({ ...p, ...Object.fromEntries(lit.map(i => [i.id, Date.now()])) }))
  }, [d])

  /** A screen point on the ground, in the workspace's own units: through the
   *  tilt when the view is tipped (a re-sent event is flat already). */
  const local = (e: { clientX: number; clientY: number; isTrusted?: boolean }) => {
    const b = isTilted(useTiltStore.getState()) ? planeBox(id) : null
    const c = b ? screenToCanvas(e.clientX, e.clientY, e.isTrusted === false) : null
    if (b && c) return { x: (c.cx - b.x) / b.k, y: (c.cy - b.y) / b.k }
    const el = plane.current!
    const r = el.getBoundingClientRect()
    const k = r.width / Math.max(1, el.offsetWidth)
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
  }
  const inPlane = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0 && p.x <= planeW && p.y <= planeH
  const clampTo = (i: SpaceItem, x: number, y: number) => {
    const { w, h } = itemSize(i)
    return { x: Math.max(w / 2, Math.min(Math.max(w / 2, planeW - w / 2), x)), y: Math.max(h / 2, Math.min(Math.max(h / 2, planeH - h / 2), y)) }
  }
  const drag = (move: (ev: PointerEvent) => void, up: (ev: PointerEvent) => void) => {
    const end = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      up(ev)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  // Delete removes what is picked, while the hand is in here; a press
  // anywhere else lets go of it.
  useEffect(() => {
    const el = root.current
    if (!el) return
    let last = false
    const down = (e: PointerEvent) => { last = el.contains(e.target as Node); if (!last && selRef.current.length) setSel([]) }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (!last || !selRef.current.length || e.ctrlKey || e.metaKey || e.altKey) return
      const a = document.activeElement as HTMLElement | null
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return
      e.preventDefault()
      e.stopPropagation()
      removeFromSpace(id, selRef.current)
      setSel([])
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true) }
  }, [id])

  /** Draw a wire from a port: to an input from an output, or back from an input. */
  const startWire = (ref: PortRef, fromInput: boolean) => {
    const spot = portSpot(d, ref)
    if (!spot) return
    const cands = fromInput ? wireSources(d, ref) : wireTargets(d, ref)
    const nearest = (p: { x: number; y: number }) => {
      let best: PortRef | null = null, bd = PORT_SNAP
      for (const c of cands) { const dist = Math.hypot(c.spot.x - p.x, c.spot.y - p.y); if (dist < bd) { bd = dist; best = c.ref } }
      if (best) return best
      // Anywhere on a node counts as its input, when it has just the one.
      const over = [...dRef.current.items].reverse().find(i => { const s = itemSize(i); return Math.abs(i.x - p.x) <= s.w / 2 && Math.abs(i.y - p.y) <= s.h / 2 })
      const mine = over ? cands.filter(c => c.ref.node === over.id) : []
      return mine.length === 1 ? mine[0].ref : mine.find(c => c.ref.port === (fromInput ? 'out' : 'in'))?.ref ?? null
    }
    drag(ev => {
      const p = local(ev)
      const to = nearest(p)
      const toward = to ? portSpot(dRef.current, to)?.y ?? p.y : p.y
      setDraw({ from: ref, fromInput, spot: fromInput ? spot : outSpot(dRef.current, ref, toward) ?? spot, x: p.x, y: p.y, snap: to, cands })
    }, ev => {
      setDraw(null)
      const p = local(ev)
      const to = nearest(p)
      if (to) {
        const w = fromInput ? addWire(id, to, ref) : addWire(id, ref, to)
        if (w) setSel([w])
        return
      }
      // On bare ground: an event there, wired from this.
      const bare = !dRef.current.items.some(i => { const s = itemSize(i); return Math.abs(i.x - p.x) <= s.w / 2 + 6 && Math.abs(i.y - p.y) <= s.h / 2 + 6 })
      const a = dRef.current.items.find(i => i.id === ref.node)
      if (fromInput || !bare || !inPlane(p) || !a || a.kind === 'any' || Math.hypot(p.x - spot.x, p.y - spot.y) < 40) return
      const at = clampTo({ id: '', kind: 'event', x: 0, y: 0 }, snap(p.x + EVENT_W / 2, ev.ctrlKey), snap(p.y, ev.ctrlKey))
      const made = addItem(id, { kind: 'event', ...at })
      addWire(id, ref, { node: made, port: 'in' }, false)
      setSel([made])
    })
  }

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const t = e.target as HTMLElement
    if (t.closest('[data-sp-bar]')) return
    const shelf = t.closest('[data-sp-shelf]') as HTMLElement | null
    if (shelf) {
      // Off the shelf: it follows the hand and is set down where it is let go.
      const it = SHELF.find(s => s.kind === shelf.dataset.spShelf)!
      const p0 = local(e)
      let moved = false
      drag(ev => {
        const p = local(ev)
        if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) < 4) return
        moved = true
        setGhost({ kind: it.kind, name: it.name, x: p.x, y: p.y })
      }, ev => {
        setGhost(null)
        const p = moved ? local(ev) : freeSpot(dRef.current, planeW)
        if (!inPlane(p)) return
        const at = clampTo({ id: '', kind: it.kind, x: 0, y: 0 }, snap(p.x, ev.ctrlKey), snap(p.y, ev.ctrlKey))
        setSel([addItem(id, { kind: it.kind, ...at })])
      })
      return
    }
    const playEl = t.closest('[data-sp-play]') as HTMLElement | null
    if (playEl) { const who = playEl.dataset.spPlay!; setPlaying(p => p === who ? null : who); return }
    const portEl = t.closest('[data-sp-port]') as HTMLElement | null
    if (portEl) {
      const ref: PortRef = portEl.dataset.spWire ? { wire: portEl.dataset.spWire, port: 'knob' } : { node: portEl.dataset.spOf, port: portEl.dataset.spPort! }
      startWire(ref, portEl.dataset.spOut !== '1')
      return
    }
    const trackEl = t.closest('[data-sp-track]') as HTMLElement | null
    const tl = trackEl ? d.items.find(i => i.id === trackEl.dataset.spTrack) : undefined
    const clock = tl ? lineClock(tl.line) : null
    if (tl && clock) {
      // Along a timeline: its time marker, the storyline's own.
      const w = itemSize(tl).w
      setSel([tl.id])
      setPlaying(null)
      useUndoCoordinator.getState().checkpoint()
      const to = (ev: { clientX: number; clientY: number; isTrusted?: boolean }) =>
        scrubStoryline(tl.line!, clock.toValue(Math.max(0, Math.min(1, (local(ev).x - (dRef.current.items.find(i => i.id === tl.id)?.x ?? tl.x) + w / 2) / w))))
      to(e)
      drag(to, () => {})
      return
    }
    const nodeEl = t.closest('[data-sp-node]') as HTMLElement | null
    const it = nodeEl ? d.items.find(i => i.id === nodeEl.dataset.spNode) : undefined
    if (it) {
      // By its body: pick it, and move it with everything else picked.
      const was = sel.includes(it.id)
      const picked = e.shiftKey ? (was ? sel.filter(x => x !== it.id) : [...sel, it.id]) : was ? sel : [it.id]
      setSel(picked)
      if (e.shiftKey && was) return
      const p0 = local(e)
      const moving = d.items.filter(i => picked.includes(i.id))
      let moved = false
      drag(ev => {
        const p = local(ev)
        if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) < 3) return
        if (!moved) { moved = true; useUndoCoordinator.getState().checkpoint() }
        // The one held keeps to the grid; the rest keep their places by it.
        const lead = clampTo(it, snap(it.x + p.x - p0.x, ev.ctrlKey), snap(it.y + p.y - p0.y, ev.ctrlKey))
        const dx = lead.x - it.x, dy = lead.y - it.y
        moveItems(id, new Map(moving.map(i => [i.id, clampTo(i, i.x + dx, i.y + dy)])))
      }, () => { if (!moved && !e.shiftKey) setSel([it.id]) })
      return
    }
    // A wire, where the press is near enough to one.
    const p0 = local(e)
    let near: string | null = null, nd = 9
    for (const w of d.wires) { const g = wireGeom(d, w); const dist = g ? wireDist(g, p0.x, p0.y) : Infinity; if (dist < nd) { nd = dist; near = w.id } }
    if (near) { setSel(e.shiftKey ? (sel.includes(near) ? sel.filter(x => x !== near) : [...sel, near]) : [near]); return }
    // Bare ground: a box that picks what it crosses.
    const base = e.shiftKey ? sel : []
    if (!e.shiftKey) setSel([])
    drag(ev => {
      const p = local(ev)
      const b = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) }
      if (b.w < 4 && b.h < 4) return
      setBand(b)
      const hit = dRef.current.items.filter(i => { const s = itemSize(i); return i.x + s.w / 2 > b.x && i.x - s.w / 2 < b.x + b.w && i.y + s.h / 2 > b.y && i.y - s.h / 2 < b.y + b.h }).map(i => i.id)
      setSel([...new Set([...base, ...hit])])
    }, () => setBand(null))
  }

  const onDouble = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-sp-bar],[data-sp-shelf],[data-sp-track],[data-sp-port],[data-sp-play]')) return
    e.stopPropagation()
    const nodeEl = t.closest('[data-sp-node]') as HTMLElement | null
    const it = nodeEl ? d.items.find(i => i.id === nodeEl.dataset.spNode) : undefined
    if (it?.kind === 'event') { fireEvent(id, it.id); setPulse(p => ({ ...p, [it.id]: Date.now() })); return }
    if (it) { setNow(id, it.id, !it.now); return }
    const p = local(e)
    const w = d.wires.find(x => { const g = wireKind(d, x) === 'change' ? wireGeom(d, x) : null; return g && wireDist(g, p.x, p.y) < 9 })
    if (w) makeChange(id, w.id)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wires = useMemo(() => d.wires.map(w => ({ w, g: wireGeom(d, w), kind: wireKind(d, w), tone: wireTone(d, w) })).filter((x): x is { w: SpaceWire; g: WireGeom; kind: ReturnType<typeof wireKind>; tone: string } => !!x.g), [d, lines])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ports = useMemo(() => d.items.flatMap(i => itemPorts(i).map(p => ({ item: i, ...p }))), [d, lines])
  const marker = (tone: string) => `sp-${id}-${tone.replace(/[^a-z0-9]/gi, '')}`
  const tones = [STEEL, AMBER, VIOLET, GREEN, BLUE]

  return (
    <div ref={root} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <ContentScaled factor={ui}>
        <style>{CSS}</style>
        <div style={{ position: 'absolute', inset: 0, display: 'flex' }} onPointerDown={onDown} onDoubleClick={onDouble}>
          <div ref={plane} data-state-plane={id} style={{
            flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden', background: GROUND,
            backgroundImage: 'radial-gradient(rgba(255,255,255,0.09) 1px, transparent 1.2px)', backgroundSize: '20px 20px',
          }}>
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}>
              <defs>
                {tones.map(tone => (
                  <marker key={tone} id={marker(tone)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L10 5L0 10z" fill={tone} /></marker>
                ))}
              </defs>
              {wires.map(({ w, g, kind, tone }) => {
                const on = sel.includes(w.id)
                const c = on ? BLUE : tone
                return (
                  <g key={w.id} data-sp-wire={w.id}>
                    <path d={g.path} fill="none" stroke={c} strokeWidth={on ? 2.6 : kind === 'signal' ? 1.5 : 1.9} strokeLinecap="round"
                      strokeDasharray={kind === 'link' ? '2 6' : w.bp === 'if' ? '2 5' : kind === 'signal' ? '6 3' : undefined}
                      opacity={kind === 'signal' && !on ? 0.9 : 1}
                      markerEnd={kind === 'link' ? undefined : `url(#${marker(c)})`} />
                    {w.name && kind !== 'signal' && <text x={g.mx} y={g.my - 12} textAnchor="middle" fontSize={11} fontFamily={FONT}
                      fill={on ? BLUE : 'rgba(255,255,255,0.75)'} stroke={GROUND} strokeWidth={4} paintOrder="stroke" style={{ userSelect: 'none' }}>{w.name}</text>}
                    {w.bp === 'if' && <text x={g.x2 + 8} y={g.y2 - 8} fontSize={9} fontFamily={FONT} fill={on ? BLUE : GREEN} style={{ userSelect: 'none' }}>only if</text>}
                  </g>
                )
              })}
              {flow && wires.filter(x => flow.wires.includes(x.w.id)).map(({ w, g, tone }) => (
                <g key={flow.stamp + w.id}>
                  <path d={g.path} fill="none" stroke={tone} strokeWidth={4} strokeLinecap="round" opacity={0.5}>
                    <animate attributeName="opacity" from="0.7" to="0" dur="0.7s" fill="freeze" />
                  </path>
                  <circle r={5} fill="#fff" stroke={tone} strokeWidth={2}>
                    <animateMotion dur="0.55s" path={g.path} fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.4 0 0.2 1" />
                    <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.85;1" dur="0.6s" fill="freeze" />
                  </circle>
                </g>
              ))}
              {draw && (() => {
                const g = draw.snap ? (() => { const s = portSpot(d, draw.snap!); return s ? looseCurve(draw.spot, s.x, s.y, draw.fromInput) : null })() : looseCurve(draw.spot, draw.x, draw.y, draw.fromInput)
                return g && <path d={g.path} fill="none" stroke={BLUE} strokeWidth={2.2} strokeLinecap="round" strokeDasharray="6 4"
                  style={{ animation: 'vbSpFlow .5s linear infinite' }} markerEnd={`url(#${marker(BLUE)})`} />
              })()}
            </svg>
            {d.items.map(i => i.kind === 'timeline'
              ? <TimelineView key={i.id} item={i} picked={sel.includes(i.id)} playing={playing === i.id} />
              : <NodeView key={i.id} item={i} picked={sel.includes(i.id)} stamp={pulse[i.id]} />)}
            {/* A change's knob: where a wire that makes it lands. */}
            {wires.filter(x => x.kind === 'change').map(({ w, g }) => {
              const ref = { wire: w.id, port: 'knob' }
              const can = !draw || draw.cands.some(c => sameRef(c.ref, ref))
              const hot = sameRef(draw?.snap, ref)
              return <div key={w.id} data-sp-port="knob" data-sp-wire={w.id} className="vb-sp-port" title="A wire dragged onto here makes this change" style={{
                position: 'absolute', left: g.mx - 6, top: g.my - 6, width: 12, height: 12, boxSizing: 'border-box', transform: `rotate(45deg)${hot ? ' scale(1.5)' : ''}`,
                background: hot ? BLUE : GROUND, border: `2px solid ${sel.includes(w.id) || (draw && can) ? BLUE : STEEL}`, cursor: 'crosshair', opacity: draw && !can ? 0.25 : 1,
              }} />
            })}
            {ports.map(p => {
              const ref = { node: p.item.id, port: p.port }
              const own = draw && sameRef(draw.from, ref)
              const can = !draw || own || draw.cands.some(c => sameRef(c.ref, ref))
              const hot = sameRef(draw?.snap, ref)
              const tone = p.item.kind === 'timeline' ? AMBER : p.item.kind === 'event' ? VIOLET : p.port === 'if' ? GREEN : STEEL
              return <div key={p.item.id + p.port} data-sp-port={p.port} data-sp-of={p.item.id} data-sp-out={p.out ? '1' : '0'} className="vb-sp-port"
                title={p.port === 'if' ? 'Only if: wire a card here and this event only goes through while that card is lit' : p.out ? 'Out: drag from here to what follows' : 'In: drag a wire onto here'}
                style={{
                  position: 'absolute', left: p.spot.x - 7, top: p.spot.y - 7, width: 14, height: 14, borderRadius: p.port === 'if' ? 3 : '50%', boxSizing: 'border-box',
                  background: hot || own ? BLUE : p.out ? tone : GROUND, border: `2px solid ${hot || (draw && can && !own) ? BLUE : tone}`,
                  cursor: 'crosshair', opacity: draw && !can ? 0.2 : 1, transform: hot ? 'scale(1.5)' : undefined,
                }} />
            })}
            {/* A timeline's points have an output on the top edge too. */}
            {ports.filter(p => p.item.kind === 'timeline').map(p => {
              const ref = { node: p.item.id, port: p.port }
              const own = draw && sameRef(draw.from, ref)
              return <div key={p.item.id + p.port + 'top'} data-sp-port={p.port} data-sp-of={p.item.id} data-sp-out="1" data-sp-top="" className="vb-sp-port" title="Out: drag from here to what happens at this point" style={{
                position: 'absolute', left: p.spot.x - 7, top: p.item.y - TL_H / 2 - 7, width: 14, height: 14, borderRadius: '50%', boxSizing: 'border-box',
                background: own ? BLUE : AMBER, border: `2px solid ${AMBER}`, cursor: 'crosshair', opacity: draw && !own ? 0.2 : 1,
              }} />
            })}
            {band && <div style={{ position: 'absolute', left: band.x, top: band.y, width: band.w, height: band.h, border: `1px solid ${BLUE}`, background: 'rgba(111,183,224,0.1)', pointerEvents: 'none' }} />}
            {/* The shelf: what there is to drag in besides cards and storylines. */}
            <div style={{ position: 'absolute', left: 10, top: 10, display: 'flex', gap: 6, fontFamily: FONT }}>
              {SHELF.map(s => (
                <div key={s.kind} data-sp-shelf={s.kind} className="vb-sp-chip" title={s.title} style={{
                  height: 24, lineHeight: '22px', padding: '0 10px', boxSizing: 'border-box', borderRadius: s.kind === 'blank' ? 5 : 12, fontSize: 11, color: INK, cursor: 'grab', userSelect: 'none',
                  background: 'rgba(255,255,255,0.05)', border: `1px ${s.kind === 'blank' ? 'dashed' : 'solid'} ${s.kind === 'event' ? VIOLET : 'rgba(255,255,255,0.3)'}`,
                }}>{s.name}</div>
              ))}
            </div>
            {ghost && (() => {
              const s = itemSize({ id: '', kind: ghost.kind, x: 0, y: 0 })
              return <div style={{
                position: 'absolute', left: ghost.x - s.w / 2, top: ghost.y - s.h / 2, width: s.w, height: s.h, boxSizing: 'border-box', pointerEvents: 'none',
                borderRadius: ghost.kind === 'blank' ? 12 : s.h / 2, border: `2px dashed ${ghost.kind === 'event' ? VIOLET : STEEL}`, background: 'rgba(255,255,255,0.06)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: INK, fontSize: 12, fontFamily: FONT,
              }}>{ghost.name}</div>
            })()}
          </div>
          <Bar id={id} d={d} sel={sel} setSel={setSel} />
        </div>
      </ContentScaled>
    </div>
  )
}

/** A clear place for a new node: along the top, past the ones there. */
function freeSpot(d: StateSpaceData, planeW: number): { x: number; y: number } {
  const step = ICON + 26, cols = Math.max(1, Math.floor((planeW - 80) / step))
  for (let n = 0; n < 300; n++) {
    const x = 90 + (n % cols) * step, y = 110 + Math.floor(n / cols) * step
    if (!d.items.some(i => Math.abs(i.x - x) < ICON && Math.abs(i.y - y) < ICON)) return { x, y }
  }
  return { x: 90, y: 110 }
}

const EMPTY = emptyStateSpace()
