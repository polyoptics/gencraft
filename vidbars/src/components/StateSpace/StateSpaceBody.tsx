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
import { useNotesStore } from '../../store/notesStore'
import { useRideClock } from '../../utils/pathRide'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { isTilted, useTiltStore } from '../../store/tiltStore'
import { ContentScaled } from '../UI/PanelSurface'
import { cardFaceSourceUrl, stackedDeckMembers } from '../../utils/cardGrid'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { cardTypeOf, typeColor } from '../../utils/cardTypes'
import { goToCard } from '../../utils/stateCard'
import { scrubStoryline } from '../Canvas/StorylineLayer'
import { snapshotSpace } from '../../utils/stateScene'
import {
  EVENT_H, EVENT_W, ICON, PORT_SNAP, SPACE_BAR_W, SPACE_GRID, TL_H,
  CHOICE_HEAD, CHOICE_ROW, SPACE_HEAD, SPACE_ROW, addItem, choose, pathStep, scene, addWire, editSpace, emptyStateSpace, endOf, exposed, fireEvent, isLevel, itemPorts, itemSize, lineClock, lineOf, looseCurve, makeChange, replaySpace, setValue, spaceTruths, valOf,
  moveItems, holdsOf, normalizeSpace, orderHold, outSpot, patchItem, patchWire, planeBox, portSpot, removeFromSpace, screenToCanvas, setNow, setStart,
  useSpaceLive, wireDist, wireGeom, wireKind, wireSources, wireTargets,
  type Compare, type PortRef, type PortSpot, type SpaceItem, type SpaceKind, type SpaceWire, type StateSpaceData, type WireGeom,
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
  if (i.kind === 'space') return lineTitle || 'Workspace'
  if (i.kind === 'path') return scene.path(i.curve)?.name || 'Path'
  if (i.card) return cardName || (i.kind === 'event' ? 'Event' : 'Card')
  return KIND_NAME[i.kind]
}
const KIND_NAME: Record<SpaceKind, string> = { card: 'State', blank: 'State', event: 'Event', any: 'Any', timeline: 'Timeline', value: 'Value', and: 'And', or: 'Or', fact: 'Is in', wait: 'Wait', pick: 'Pick one', space: 'Workspace', path: 'Path', act: 'Show / hide', choice: 'Choose' }

// One colour for each kind of thing, everywhere: steel for states and the
// changes between them, amber for time, violet for what happens, green for
// what is true.
const kindTone = (k: SpaceKind | undefined): string =>
  k === 'timeline' || k === 'wait' || k === 'path' ? AMBER : k === 'event' || k === 'pick' || k === 'choice' ? VIOLET : k === 'value' || k === 'and' || k === 'or' || k === 'fact' || k === 'act' ? GREEN : STEEL

/** What colour a wire is, by what sends along it. */
function wireTone(d: StateSpaceData, w: SpaceWire): string {
  const k = wireKind(d, w)
  if (k === 'cond') return GREEN
  if (k !== 'signal') return STEEL
  const a = endOf(d, w.a, w.ap)?.kind
  return a === 'card' || a === 'blank' ? GREEN : kindTone(a)
}

/** A place along a wire (0 its start, 1 its end). */
function along(g: WireGeom, t: number): { x: number; y: number } {
  const u = 1 - t
  return { x: u * u * u * g.x1 + 3 * u * u * t * g.c1x + 3 * u * t * t * g.c2x + t * t * t * g.x2, y: u * u * u * g.y1 + 3 * u * u * t * g.c1y + 3 * u * t * t * g.c2y + t * t * t * g.y2 }
}

const PORT_TITLE: Record<string, string> = {
  time: 'Time: drag from a timeline\'s time to a path\'s time, and what rides the path follows that timeline',
  play: 'Play: a wire onto here sets what rides this path going from the start',
  take: 'Take: while what is wired here is true, the other models of this path\'s set ride this path',
  hold: 'Hold: while what is wired here is true, what rides this path stands at this point',
  pp: 'Out: when a rider reaches this point',
  opt: 'Out: drag from here to what follows this option',
}

/** Bring a workspace into view. */
function goToSpace(spaceId: string | undefined): void {
  const n = useFreeNodeStore.getState().nodes[spaceId ?? '']
  if (n) useCanvasStore.getState().jumpToPoint(n.x + n.width / 2, n.y + n.height / 2)
}

const CMP_WORD: Record<Compare, string> = { '<': 'below', '<=': 'at most', '=': 'is', '!=': 'is not', '>=': 'at least', '>': 'above' }
const CMPS: Compare[] = ['<', '<=', '=', '!=', '>=', '>']
const yesNo = (n: number) => n ? 'yes' : 'no'
/** What a wire carries from its source, in a word or two (shown by its start). */
function wireSays(d: StateSpaceData, w: SpaceWire): string {
  const a = endOf(d, w.a, w.ap)
  if (!isLevel(a) || wireKind(d, w) === 'change' || wireKind(d, w) === 'link') return ''
  const what = a!.kind !== 'value' ? '' : !w.cmp ? (a!.flag ? 'yes' : 'not 0') : a!.flag && (w.cmp === '=' || w.cmp === '!=') ? `${CMP_WORD[w.cmp]} ${yesNo(w.cn ?? 0)}` : `${CMP_WORD[w.cmp]} ${w.cn ?? 0}`
  return [w.not ? 'not' : '', what].filter(Boolean).join(' ')
}
/** What a wire does to the value it goes into (shown by its end). */
function wireDoes(d: StateSpaceData, w: SpaceWire): string {
  const b = w.bp === 'knob' ? undefined : endOf(d, w.b, w.bp)
  if (wireKind(d, w) === 'hold') return 'while'
  if (b?.kind !== 'value') return ''
  if (w.op === 'set') return '= ' + (b.flag ? yesNo(w.on ?? 0) : w.on ?? 0)
  const n = w.on ?? 1
  return n < 0 ? '− ' + -n : '+ ' + n
}

// ── Nodes ──

const Pulse: React.FC<{ stamp: number | undefined; radius: number | string; tone: string }> = ({ stamp, radius, tone }) =>
  stamp && Date.now() - stamp < 700
    ? <div key={stamp} style={{ position: 'absolute', inset: -3, borderRadius: radius, border: `2px solid ${tone}`, pointerEvents: 'none', animation: 'vbSpPulse .55s ease-out forwards' }} />
    : null

const NodeView: React.FC<{ item: SpaceItem; picked: boolean; stamp?: number; on?: boolean; says?: [string, string] }> = ({ item, picked, stamp, on, says }) => {
  const card = useBoardsStore(s => item.card ? s.groups.find(g => g.id === item.card) : undefined)
  const boards = useBoardsStore(s => s.boards)
  const count = useBoardsStore(s => card && card.deckState && card.deckState !== 'open' ? stackedDeckMembers(card.id, s.groups).length : 0)
  const src = useResolvedMedia(card ? cardFaceSourceUrl(card, boards) : null)
  const gone = !!item.card && !card
  // A workspace node: the other workspace, and what it shows of itself.
  const inner = useFreeNodeStore(s => item.kind === 'space' ? s.nodes[item.space ?? ''] : undefined)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => item.kind === 'space' ? exposed(item.space) : [], [item.kind, item.space, inner?.stateSpace])
  const rowNames = useBoardsStore(useShallow(s => rows.map(r => r.card ? s.groups.find(g => g.id === r.card)?.name ?? '' : '')))
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
  if (item.kind === 'space') {
    return (
      <div data-sp-node={item.id} className="vb-sp-node" title="Another workspace, as one node: each of its states, events and values has an input and an output. Double-click to go to it" style={{
        ...box, borderRadius: 10, border: `2px solid ${inner ? STEEL : 'rgba(255,255,255,0.2)'}`, background: '#20272c', boxShadow: ring || 'none', color: INK, overflow: 'hidden',
      }}>
        <div style={{ height: SPACE_HEAD - 2, lineHeight: `${SPACE_HEAD - 2}px`, padding: '0 10px', fontSize: 10, letterSpacing: '0.1em', color: DIM, background: 'rgba(255,255,255,0.04)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {(item.name || inner?.label || (inner ? 'Workspace' : 'workspace gone')).toUpperCase()}
        </div>
        {rows.map((r, k) => {
          const lit = r.kind === 'value' ? valOf(r) !== 0 : !!r.now
          const tone = kindTone(r.kind)
          return (
            <div key={r.id} data-sp-row={r.id} data-sp-lit={lit ? '1' : '0'} style={{ height: SPACE_ROW, display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px', fontSize: 11 }}>
              <div style={{ width: 8, height: 8, flexShrink: 0, boxSizing: 'border-box', borderRadius: r.kind === 'event' ? 1 : '50%', transform: r.kind === 'event' ? 'rotate(45deg)' : undefined, border: `1.5px solid ${r.kind === 'event' ? VIOLET : lit ? GREEN : tone === STEEL ? 'rgba(255,255,255,0.4)' : tone}`, background: lit ? GREEN : 'transparent', transition: 'background-color .18s' }} />
              <div style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: lit ? '#fff' : INK, fontWeight: lit ? 600 : 400 }}>{itemLabel(r, rowNames[k])}</div>
              {r.kind === 'value' && <div style={{ color: lit ? '#dff5e3' : DIM, flexShrink: 0 }}>{r.flag ? (valOf(r) ? 'yes' : 'no') : Math.round(valOf(r) * 100) / 100}</div>}
            </div>
          )
        })}
        {!rows.length && <div style={{ height: SPACE_ROW, lineHeight: `${SPACE_ROW}px`, padding: '0 14px', fontSize: 11, color: DIM }}>{inner ? 'nothing in it yet' : ''}</div>}
      </div>
    )
  }
  if (item.kind === 'act') {
    const show = item.do === 'show'
    return (
      <div data-sp-node={item.id} data-sp-true={on ? '1' : '0'} className="vb-sp-node" title={show ? 'Show: its card is on the board only while what is wired into this is true. Drop a card on it to say which' : 'Hide: its card is off the board while what is wired into this is true. Drop a card on it to say which'} style={{
        ...box, borderRadius: EVENT_H / 2, border: `2px ${item.card ? 'solid' : 'dashed'} ${on ? GREEN : 'rgba(95,168,108,0.45)'}`, background: on ? '#2c4a33' : '#1d2a22',
        boxShadow: [ring, on ? '0 0 14px rgba(95,168,108,0.5)' : ''].filter(Boolean).join(', ') || 'none',
        display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', color: INK, fontSize: 12, opacity: gone ? 0.5 : 1,
      }}>
        <svg width="16" height="12" viewBox="0 0 16 12" style={{ flexShrink: 0 }}>
          <path d="M1 6C3 2.5 5.5 1 8 1s5 1.5 7 5c-2 3.5-4.500 5-7 5S3 9.500 1 6z" fill="none" stroke={GREEN} strokeWidth="1.4" />
          <circle cx="8" cy="6" r="2" fill={GREEN} />
          {!show && <path d="M2 11L14 1" stroke={GREEN} strokeWidth="1.6" strokeLinecap="round" />}
        </svg>
        <div style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.name || (gone ? 'card gone' : `${show ? 'show' : 'hide'} ${card ? card.name || 'card' : '(drop a card)'}`)}
        </div>
      </div>
    )
  }
  if (item.kind === 'choice') {
    return (
      <div data-sp-node={item.id} data-sp-asking={item.asking ? '1' : '0'} className="vb-sp-node" title="Choose: it stops here and asks. Click an option and it goes on along that one" style={{
        ...box, borderRadius: 10, border: `2px solid ${item.asking ? AMBER : VIOLET}`, background: '#2a2438', color: INK, overflow: 'hidden',
        boxShadow: [ring, item.asking ? '0 0 16px rgba(217,164,65,0.6)' : ''].filter(Boolean).join(', ') || 'none',
      }}>
        <div style={{ height: CHOICE_HEAD - 2, lineHeight: `${CHOICE_HEAD - 2}px`, padding: '0 10px', fontSize: 10, letterSpacing: '0.1em', color: item.asking ? AMBER : DIM, fontWeight: item.asking ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {(item.name || 'Choose').toUpperCase()}
        </div>
        {(item.opts ?? []).map(o => {
          const lit = item.chose === o.id && !item.asking
          return <div key={o.id} data-sp-opt={o.id} data-sp-of={item.id} className="vb-sp-chip" title="Click to go on along this one" style={{
            height: CHOICE_ROW - 4, lineHeight: `${CHOICE_ROW - 6}px`, margin: '0 8px 4px', padding: '0 8px', boxSizing: 'border-box', borderRadius: 5, fontSize: 11, cursor: 'pointer',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            background: lit ? 'rgba(176,140,240,0.35)' : 'rgba(255,255,255,0.05)', border: `1px solid ${lit ? VIOLET : item.asking ? 'rgba(217,164,65,0.7)' : 'rgba(255,255,255,0.16)'}`, color: lit ? '#fff' : INK,
          }}>{o.name || 'option'}</div>
        })}
        <Pulse stamp={stamp} radius={10} tone={VIOLET} />
      </div>
    )
  }
  const step = (by: number, title: string) => (
    <div data-sp-step={by} data-sp-of={item.id} className="vb-sp-chip" title={title} style={{
      width: 18, height: 18, borderRadius: 4, flexShrink: 0, cursor: 'pointer', boxSizing: 'border-box', textAlign: 'center', lineHeight: '15px', fontSize: 13,
      color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.18)',
    }}>{by < 0 ? '−' : '+'}</div>
  )
  if (item.kind === 'value') {
    const v = valOf(item)
    return (
      <div data-sp-node={item.id} className="vb-sp-node" title="A value: wires into it change it; a wire out of it carries a compare" style={{
        ...box, borderRadius: 10, border: `2px solid ${v ? GREEN : 'rgba(95,168,108,0.45)'}`, background: '#1d2a22', boxShadow: ring || 'none',
        display: 'flex', flexDirection: 'column', padding: '4px 8px 6px', color: INK,
      }}>
        <div style={{ fontSize: 10, color: DIM, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', height: 14, lineHeight: '14px', flexShrink: 0 }}>{itemLabel(item)}</div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
          {step(-1, item.flag ? 'No' : 'One less')}
          <div data-sp-val={item.id} style={{ flex: 1, minWidth: 0, textAlign: 'center', fontSize: item.flag ? 15 : 18, fontWeight: 600, letterSpacing: item.flag ? '0.06em' : 0, whiteSpace: 'nowrap', overflow: 'hidden', color: v ? '#dff5e3' : INK }}>
            {item.flag ? (v ? 'YES' : 'NO') : Math.round(v * 100) / 100}
          </div>
          {step(1, item.flag ? 'Yes' : 'One more')}
        </div>
        <Pulse stamp={stamp} radius={10} tone={GREEN} />
      </div>
    )
  }
  if (item.kind === 'and' || item.kind === 'or') {
    return (
      <div data-sp-node={item.id} data-sp-true={on ? '1' : '0'} className="vb-sp-node" title={item.kind === 'and' ? 'And: true while everything wired into it is true' : 'Or: true while anything wired into it is true'} style={{
        ...box, borderRadius: item.kind === 'and' ? '6px 20px 20px 6px' : 20, border: `2px solid ${on ? GREEN : 'rgba(95,168,108,0.45)'}`, background: on ? '#2c4a33' : '#1d2a22',
        boxShadow: [ring, on ? '0 0 14px rgba(95,168,108,0.5)' : ''].filter(Boolean).join(', ') || 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: on ? '#fff' : INK, fontSize: 11, letterSpacing: '0.1em', fontWeight: 600,
      }}>{(item.name || KIND_NAME[item.kind]).toUpperCase()}</div>
    )
  }
  if (item.kind === 'fact') {
    const line: React.CSSProperties = { fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', height: 16, lineHeight: '16px', paddingLeft: 6 }
    return (
      <div data-sp-node={item.id} data-sp-true={on ? '1' : '0'} className="vb-sp-node" title="Is in: true while the first card is in the second on the board, in its deck or linked to it (a faction's members are its links)" style={{
        ...box, borderRadius: 10, border: `2px solid ${on ? GREEN : 'rgba(95,168,108,0.45)'}`, background: on ? '#2c4a33' : '#1d2a22',
        boxShadow: [ring, on ? '0 0 14px rgba(95,168,108,0.5)' : ''].filter(Boolean).join(', ') || 'none',
        display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 8px', color: INK,
      }}>
        <div style={{ ...line, color: says?.[0] ? INK : DIM }}>{says?.[0] || 'a card'}</div>
        <div style={{ ...line, fontSize: 9, letterSpacing: '0.1em', color: on ? '#dff5e3' : GREEN, fontWeight: 600 }}>{(item.name || 'is in').toUpperCase()}</div>
        <div style={{ ...line, color: says?.[1] ? INK : DIM }}>{says?.[1] || 'a card'}</div>
      </div>
    )
  }
  if (item.kind === 'wait' || item.kind === 'pick') {
    const tone = kindTone(item.kind)
    return (
      <div data-sp-node={item.id} className="vb-sp-node" title={item.kind === 'wait' ? 'Wait: passes on what reaches it, this many points later. Double-click to send it on now' : 'Pick one: passes on what reaches it along one of its wires, by chance. Double-click to send it on now'} style={{
        ...box, borderRadius: 8, border: `2px solid ${tone}`, background: item.kind === 'wait' ? '#262218' : '#2a2438', boxShadow: ring || 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '0 6px', color: INK, fontSize: 12,
      }}>
        {item.kind === 'wait' ? <>
          {step(-1, 'One point sooner')}
          <div style={{ flex: 1, textAlign: 'center', whiteSpace: 'nowrap' }}>{item.name || 'wait'} <b data-sp-val={item.id}>{Math.max(0, Math.round(item.n ?? 1))}</b></div>
          {step(1, 'One point later')}
        </> : <>
          <svg width="13" height="13" viewBox="0 0 13 13" style={{ flexShrink: 0 }}><rect x="1" y="1" width="11" height="11" rx="2.5" fill="none" stroke={VIOLET} strokeWidth="1.5" /><circle cx="4.3" cy="4.3" r="1.1" fill={VIOLET} /><circle cx="8.7" cy="8.7" r="1.1" fill={VIOLET} /></svg>
          <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name || 'pick one'}</div>
        </>}
        <Pulse stamp={stamp} radius={8} tone={tone} />
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
      <div style={{ position: 'absolute', left: 0, right: 0, top: -17, textAlign: 'center', fontSize: 9, letterSpacing: '0.1em', color: GREEN, fontWeight: 600, pointerEvents: 'none', opacity: item.now || item.under ? 1 : 0, transition: 'opacity .18s' }}
        title={item.under && !item.now ? 'A condition is holding another of its states lit. This one comes back when the condition lets go' : undefined}>{item.under && !item.now ? <span style={{ color: DIM }}>UNDER</span> : 'NOW'}</div>
      {item.start && <div title="Where this machine starts" style={{ position: 'absolute', left: 0, right: 0, bottom: -16, textAlign: 'center', fontSize: 9, letterSpacing: '0.1em', color: DIM, pointerEvents: 'none' }}>START</div>}
      <Pulse stamp={stamp} radius={12} tone={GREEN} />
    </div>
  )
}

/** The id of a workspace's arrowhead in one colour. */
const markerId = (space: string, tone: string) => `sp-${space}-${tone.replace(/[^a-z0-9]/gi, '')}`

/** One node, drawn again only when something of it has changed (a big
 *  workspace has a hundred of them, and one is moved at a time). */
const NodeViewMemo = React.memo(NodeView, (a, b) => a.item === b.item && a.picked === b.picked && a.stamp === b.stamp && a.on === b.on
  && a.says?.[0] === b.says?.[0] && a.says?.[1] === b.says?.[1])

/** One wire, drawn again only when it has changed. */
const WireG = React.memo<{ w: SpaceWire; g: WireGeom; kind: ReturnType<typeof wireKind>; tone: string; on: boolean; says: string; does: string; space: string }>(
  ({ w, g, kind, tone, on, says, does, space }) => {
    const c = on ? BLUE : tone
    const marker = (t: string) => markerId(space, t)
    return (
      <g data-sp-wire={w.id}>
        <path d={g.path} fill="none" stroke={c} strokeWidth={on ? 2.6 : kind === 'signal' ? 1.5 : 1.9} strokeLinecap="round"
          strokeDasharray={kind === 'link' ? '2 6' : kind === 'cond' || kind === 'hold' ? '2 5' : kind === 'signal' ? '6 3' : undefined}
          opacity={kind === 'signal' && !on ? 0.9 : 1}
          markerEnd={kind === 'link' ? undefined : `url(#${marker(c)})`} />
        {w.name && kind !== 'signal' && <text x={g.mx} y={g.my - 12} textAnchor="middle" fontSize={11} fontFamily={FONT}
          fill={on ? BLUE : 'rgba(255,255,255,0.75)'} stroke={GROUND} strokeWidth={4} paintOrder="stroke" style={{ userSelect: 'none' }}>{w.name}</text>}
        {w.bp === 'if' && <text x={g.x2 + 8} y={g.y2 - 8} fontSize={9} fontFamily={FONT} fill={on ? BLUE : GREEN} style={{ userSelect: 'none' }}>only if</text>}
        {/* What it carries, by its start; what it does, by its end. */}
        {says && <text data-sp-says={w.id} x={along(g, 0.24).x} y={along(g, 0.24).y - 6} textAnchor="middle" fontSize={10} fontFamily={FONT} fill={on ? BLUE : '#bfe6c6'} stroke={GROUND} strokeWidth={3} paintOrder="stroke" style={{ userSelect: 'none' }}>{says}</text>}
        {does && <text data-sp-does={w.id} x={along(g, 0.8).x} y={along(g, 0.8).y - 6} textAnchor="middle" fontSize={10} fontFamily={FONT} fill={on ? BLUE : '#bfe6c6'} stroke={GROUND} strokeWidth={3} paintOrder="stroke" style={{ userSelect: 'none' }}>{does}</text>}
      </g>
    )
  },
  (a, b) => a.w === b.w && a.g.path === b.g.path && a.kind === b.kind && a.tone === b.tone && a.on === b.on && a.says === b.says && a.does === b.does && a.space === b.space,
)

const TimelineView: React.FC<{ item: SpaceItem; picked: boolean; playing: boolean }> = ({ item, picked, playing }) => {
  const c = lineClock(lineOf(item))
  const { w, h } = itemSize(item)
  return (
    <div data-sp-node={item.id} className="vb-sp-node" style={{
      position: 'absolute', left: item.x - w / 2, top: item.y - h / 2, width: w, height: h, boxSizing: 'border-box', cursor: 'grab', userSelect: 'none',
      fontFamily: FONT, background: '#262218', border: `2px solid ${c ? 'rgba(217,164,65,0.6)' : 'rgba(255,255,255,0.2)'}`, borderRadius: 10,
      boxShadow: picked ? `0 0 0 2px ${BLUE}` : 'none',
    }}>
      <div style={{ position: 'absolute', left: 30, right: 10, top: 5, fontSize: 9, letterSpacing: '0.1em', color: DIM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {item.world ? 'WORLD CLOCK' : 'TIMELINE'}  ·  {(item.name || c?.title || (item.world ? 'empty' : 'gone')).toUpperCase()}
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
      {!c && <div style={{ position: 'absolute', left: 12, right: 12, top: 25, fontSize: 10, lineHeight: 1.3, color: DIM, textAlign: 'center', pointerEvents: 'none' }}>
        {item.world ? 'Drag a storyline onto the World clock (bottom left). Its points show here.' : 'Its storyline is gone.'}
      </div>}
    </div>
  )
}

/** A path as a node: its points along it like a timeline's, and where its rider is. */
const PathView: React.FC<{ item: SpaceItem; picked: boolean }> = ({ item, picked }) => {
  useNotesStore(s => item.curve ? s.curves[item.curve] : undefined)
  useRideClock(s => s.clocks)
  const playing = useRideClock(s => s.playing)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!playing) return
    const t = window.setInterval(() => tick(n => n + 1), 60)
    return () => window.clearInterval(t)
  }, [playing])
  const sp = scene.path(item.curve)
  const { w, h } = itemSize(item)
  const n = sp?.n ?? 0
  const at = (k: number) => (k + 1) / (n + 1) * w
  // Where its rider is, between the points either side of it in time.
  let mark: number | null = null
  if (sp && sp.times.length) {
    let k = 0
    while (k + 1 < n && sp.times[k + 1] <= sp.now) k++
    const a = sp.times[k], b = sp.times[Math.min(n - 1, k + 1)]
    mark = sp.now <= sp.times[0] ? at(0) : at(k) + (b > a ? Math.max(0, Math.min(1, (sp.now - a) / (b - a))) : 0) * (at(Math.min(n - 1, k + 1)) - at(k))
  }
  const tag: React.CSSProperties = { position: 'absolute', left: 9, fontSize: 8, letterSpacing: '0.06em', color: DIM, pointerEvents: 'none', lineHeight: '10px' }
  return (
    <div data-sp-node={item.id} className="vb-sp-node" title="A path: what rides it follows a timeline wired to its time, or goes when it is told to play" style={{
      position: 'absolute', left: item.x - w / 2, top: item.y - h / 2, width: w, height: h, boxSizing: 'border-box', cursor: 'grab', userSelect: 'none',
      fontFamily: FONT, background: '#262218', border: `2px ${sp ? 'solid' : 'dashed'} ${sp ? 'rgba(217,164,65,0.6)' : 'rgba(255,255,255,0.25)'}`, borderRadius: 10,
      boxShadow: picked ? `0 0 0 2px ${BLUE}` : 'none', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', left: 38, right: 8, top: 5, fontSize: 9, letterSpacing: '0.1em', color: DIM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        PATH  ·  {(item.name || (sp ? [sp.name, sp.setName].filter(Boolean).join(', ') : item.curve ? 'path gone' : 'pick a path in the bar')).toUpperCase()}
      </div>
      <div style={{ ...tag, top: h / 2 - 22 - 7 }}>time</div>
      <div style={{ ...tag, top: h / 2 - 7 }}>play</div>
      <div style={{ ...tag, top: h / 2 + 22 - 7 }}>take</div>
      {sp && <>
        <div style={{ position: 'absolute', left: at(0), width: Math.max(0, at(n - 1) - at(0)), top: h / 2 - 3, height: 2, borderRadius: 1, background: 'rgba(217,164,65,0.3)' }} />
        {mark !== null && <div style={{ position: 'absolute', left: at(0), width: Math.max(0, mark - at(0)), top: h / 2 - 3, height: 2, borderRadius: 1, background: AMBER }} />}
        {Array.from({ length: n }, (_, k) => <div key={k} style={{
          position: 'absolute', left: at(k) - 5, top: h / 2 - 7, width: 10, height: 10, borderRadius: '50%', boxSizing: 'border-box',
          background: mark !== null && mark >= at(k) - 0.5 ? AMBER : '#262218', border: `2px solid ${AMBER}`,
        }} />)}
        {Array.from({ length: n }, (_, k) => <div key={'n' + k} style={{ position: 'absolute', left: at(k) - pathStep(item) / 2 + 2, width: pathStep(item) - 4, top: h / 2 + 8, textAlign: 'center', fontSize: 9, color: DIM, pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sp.labels[k] || k + 1}</div>)}
        {mark !== null && <div data-sp-rider={item.id} style={{ position: 'absolute', left: mark - 5, top: h / 2 - 12, width: 10, height: 10, transform: 'rotate(45deg)', background: '#9fe0ff', border: '2px solid #12131f', boxSizing: 'border-box' }} />}
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

/** A number box: what is typed is kept as it is typed, and written when it is a number. */
const Num: React.FC<{ value: number; onChange: (v: number, first: boolean) => void }> = ({ value, onChange }) => {
  const [text, setText] = useState<string | null>(null)
  const fresh = useRef(true)
  return <input data-sp-num="" value={text ?? String(value)} style={{ ...field, width: 64 }}
    onFocus={() => { fresh.current = true }}
    onBlur={() => setText(null)}
    onChange={e => {
      setText(e.target.value)
      const v = Number(e.target.value)
      if (e.target.value.trim() !== '' && Number.isFinite(v)) { onChange(v, fresh.current); fresh.current = false }
    }}
    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLElement).blur() }} />
}
const chips: React.CSSProperties = { display: 'flex', gap: 4, flexWrap: 'wrap', flexShrink: 0, alignItems: 'center' }

const Bar: React.FC<{ id: string; d: StateSpaceData; sel: string[]; setSel: (s: string[]) => void }> = ({ id, d, sel, setSel }) => {
  const groups = useBoardsStore(s => s.groups)
  const curves = useNotesStore(s => s.curves)
  const paths = useMemo(() => Object.values(curves).filter(c => c.kind === 'bezier' && c.pts.length >= 2), [curves])
  const nameOf = (itemId: string | undefined) => {
    const i = d.items.find(x => x.id === itemId)
    return i ? itemLabel(i, groups.find(g => g.id === i.card)?.name, i.kind === 'space' ? useFreeNodeStore.getState().nodes[i.space ?? '']?.label : lineClock(lineOf(i))?.title) : '?'
  }
  /** One end of a wire, in words. */
  const innerName = (node: string, port: string | undefined) => {
    const i = endOf(d, node, port)
    return i ? nameOf(node) + ': ' + itemLabel(i, groups.find(g => g.id === i.card)?.name) : nameOf(node) + ': gone'
  }
  const fromName = (w: SpaceWire) => {
    const a = d.items.find(i => i.id === w.a)
    if (a?.kind === 'space') return innerName(w.a, w.ap)
    if (a?.kind === 'path' && w.ap?.startsWith('pp:')) return nameOf(w.a) + ', ' + (scene.path(a.curve)?.labels[Number(w.ap.slice(3))] || 'point ' + (Number(w.ap.slice(3)) + 1))
    if (a?.kind === 'choice' && w.ap) return nameOf(w.a) + ': ' + (a.opts?.find(o => 'opt:' + o.id === w.ap)?.name || 'option')
    if (a?.kind === 'timeline' && w.ap === 'time') return nameOf(w.a) + ' (its time)'
    if (a?.kind !== 'timeline' || !w.ap) return nameOf(w.a)
    return `${lineClock(lineOf(a))?.dots.find(p => 'pt:' + p.id === w.ap)?.title ?? 'point gone'}, ${nameOf(w.a)}`
  }
  const toName = (w: SpaceWire): string => {
    if (w.bp !== 'knob' && d.items.find(i => i.id === w.b)?.kind === 'space') return innerName(w.b, w.bp)
    if (w.bp !== 'knob') return nameOf(w.b) + (w.bp === 'if' ? ' (only if)' : w.bp === 'a' ? ' (the card)' : w.bp === 'b' ? ' (what it is in)' : w.bp === 'time' ? ' (follows it)' : w.bp === 'play' ? ' (play)' : w.bp === 'take' ? ' (takes the riders)' : w.bp?.startsWith('hold:') ? ' (riders stand at point ' + (Number(w.bp.slice(5)) + 1) + ')' : '')
    const c = d.wires.find(x => x.id === w.b)
    return c ? `${c.name || 'change'}: ${nameOf(c.a)} → ${nameOf(c.b)}` : '?'
  }
  const wireLine = (w: SpaceWire) => {
    const k = wireKind(d, w)
    if (k === 'hold') return `${toName(w)}, while ${[fromName(w), wireSays(d, w)].filter(Boolean).join(' ')}`
    return k === 'signal' || k === 'cond' ? `${[fromName(w), wireSays(d, w)].filter(Boolean).join(' ')} → ${[toName(w), wireDoes(d, w)].filter(Boolean).join(' ')}` : `${w.name || (k === 'link' ? 'line' : 'change')}: ${nameOf(w.a)} ${k === 'link' ? '—' : '→'} ${nameOf(w.b)}`
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
    head = item.kind === 'timeline' ? (item.world ? 'WORLD CLOCK' : 'TIMELINE') : item.kind === 'card' || item.kind === 'blank' ? 'NODE' : KIND_NAME[item.kind].toUpperCase()
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
          const n = useFreeNodeStore.getState().nodes[lineOf(item) ?? '']
          const dots = n?.storyline?.dots ?? []
          if (n && dots.length) useCanvasStore.getState().jumpToPoint(n.x + (Math.min(...dots.map(p => p.x)) + Math.max(...dots.map(p => p.x))) / 2, n.y + (Math.min(...dots.map(p => p.y)) + Math.max(...dots.map(p => p.y))) / 2)
        }}>Go to</button>
      </>}
      {item.kind === 'path' && <>
        <div style={gap}>WHICH PATH</div>
        <div data-sp-paths="" style={{ flexShrink: 1, minHeight: 24, maxHeight: 150, overflowY: 'auto' }}>
          {paths.length ? paths.map(c => {
            const sp = scene.path(c.id)
            return <div key={c.id} className="vb-sp-row" data-sp-pick-path={c.id} style={{ ...row, color: item.curve === c.id ? '#fff' : 'rgba(255,255,255,0.65)', fontWeight: item.curve === c.id ? 600 : 400 }}
              onClick={() => { patchItem(id, item.id, { curve: c.id }); replaySpace(id) }}>
              {item.curve === c.id ? '● ' : '○ '}{[sp?.name ?? 'Path', sp?.setName].filter(Boolean).join(', ')}{c.riders?.length ? `  (${c.riders.length} riding)` : ''}
            </div>
          }) : <div style={{ ...row, color: DIM, cursor: 'default', whiteSpace: 'normal', lineHeight: 1.4 }}>No paths yet. Draw one with the Curve tool.</div>}
        </div>
      </>}
      {item.kind === 'act' && <>
        <div style={gap}>WHILE TRUE, THE CARD IS</div>
        <div style={chips}>
          <button style={btn(item.do !== 'show')} title="Off the board while true, on it otherwise" onClick={() => { patchItem(id, item.id, { do: undefined }); replaySpace(id) }}>Hidden</button>
          <button style={btn(item.do === 'show')} title="On the board while true, off it otherwise" onClick={() => { patchItem(id, item.id, { do: 'show' }); replaySpace(id) }}>Shown</button>
        </div>
        {!item.card && <div style={{ ...row, color: DIM, cursor: 'default', whiteSpace: 'normal', lineHeight: 1.4, marginTop: 6 }}>Drop a card on it to say which card.</div>}
      </>}
      {item.kind === 'choice' && <>
        <div style={gap}>OPTIONS</div>
        {(item.opts ?? []).map(o => (
          <div key={o.id} style={{ display: 'flex', gap: 4, marginBottom: 4, flexShrink: 0 }}>
<div style={{ flex: 1, minWidth: 0 }}><Text value={o.name} placeholder="option" onChange={(v, first) => patchItem(id, item.id, { opts: item.opts!.map(x => x.id === o.id ? { ...x, name: v } : x) }, first)} /></div>
            <button style={{ ...btn(), alignSelf: 'stretch', padding: '0 8px' }} title="Take this option away" onClick={() => {
              editSpace(id, s => ({ ...s, items: s.items.map(i => i.id === item.id ? { ...i, opts: i.opts!.filter(x => x.id !== o.id), chose: i.chose === o.id ? undefined : i.chose } : i), wires: s.wires.filter(w => !(w.a === item.id && w.ap === 'opt:' + o.id)) }))
              replaySpace(id)
            }}>×</button>
          </div>
        ))}
        <div style={chips}>
          <button style={btn()} onClick={() => patchItem(id, item.id, { opts: [...(item.opts ?? []), { id: Math.random().toString(36).slice(2, 8), name: '' }] })}>Add an option</button>
          <button style={btn()} title="Forget the answer: it asks again when it is next reached" onClick={() => { patchItem(id, item.id, { chose: undefined }); replaySpace(id) }}>Ask again</button>
        </div>
      </>}
      {item.kind === 'space' && <>
        <div style={gap}>WORKSPACE</div>
        <button style={btn()} title="Go to that workspace, as a double-click on this does" onClick={() => goToSpace(item.space)}>Go to</button>
      </>}
      {state && <>
        <div style={gap}>STATE</div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button style={btn(!!item.now)} title="Lit: this is how things are now" onClick={() => setNow(id, item.id, !item.now)}>Now</button>
          <button style={btn(!!item.start)} title="Lit: this is lit before anything on a timeline has happened" onClick={() => setStart(id, item.id, !item.start)}>Start</button>
        </div>
        {(() => {
          // The conditions that hold this thing's states lit: the top one that is true wins.
          const list = holdsOf(d, item.id)
          if (!list.length) return null
          return <>
            <div style={gap} title="Conditions wired into this thing's states. Each holds its state lit while it is true. When several are true the top one wins: drag to change the order">LIT WHILE (TOP WINS)</div>
            {list.map(w => <div key={w.id} data-sp-hold={w.id} className="vb-sp-row" style={{ ...row, cursor: 'grab', touchAction: 'none' }}
              onPointerDown={e => {
                const from = w.id, x0 = e.clientX, y0 = e.clientY
                let moved = false
                const move = (ev: PointerEvent) => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) moved = true }
                const up = (ev: PointerEvent) => {
                  window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
                  const over = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('[data-sp-hold]') as HTMLElement | null
                  if (moved && over && over.dataset.spHold !== from) orderHold(id, from, over.dataset.spHold!)
                  else if (!moved) setSel([from])
                }
                window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
              }}>{wireLine(w)}</div>)}
          </>
        })()}
      </>}
      {item.kind === 'event' && <>
        <div style={gap}>RUN</div>
        <button style={btn()} title="Fire it now, as a double-click on it does" onClick={() => fireEvent(id, item.id)}>Fire</button>
      </>}
      {item.kind === 'value' && <>
        <div style={gap}>NOW</div>
        <div style={chips}>
          {item.flag ? <>
            <button style={btn(valOf(item) !== 0)} onClick={() => setValue(id, item.id, 1)}>Yes</button>
            <button style={btn(valOf(item) === 0)} onClick={() => setValue(id, item.id, 0)}>No</button>
          </> : <Num value={valOf(item)} onChange={(v, first) => setValue(id, item.id, v, first)} />}
        </div>
        <div style={gap}>BEFORE ANYTHING HAS HAPPENED</div>
        <div style={chips}>
          {item.flag ? <>
            <button style={btn(!!item.init)} onClick={() => { patchItem(id, item.id, { init: 1 }); replaySpace(id) }}>Yes</button>
            <button style={btn(!item.init)} onClick={() => { patchItem(id, item.id, { init: 0 }); replaySpace(id) }}>No</button>
          </> : <Num value={item.init ?? 0} onChange={(v, first) => { patchItem(id, item.id, { init: v }, first); replaySpace(id) }} />}
        </div>
        <div style={gap}>OPTIONS</div>
        <button style={btn(!!item.flag)} title="Lit: it is a yes or a no. Unlit: a number" onClick={() => {
          patchItem(id, item.id, { flag: item.flag ? undefined : true, ...(item.flag ? {} : { val: valOf(item) ? 1 : 0, init: item.init ? 1 : 0 }) })
          replaySpace(id)
        }}>Yes / no</button>
      </>}
      {item.kind === 'wait' && <>
        <div style={gap}>HOW MANY POINTS LATER</div>
        <Num value={Math.max(0, Math.round(item.n ?? 1))} onChange={(v, first) => { patchItem(id, item.id, { n: Math.max(0, Math.round(v)) }, first); replaySpace(id) }} />
        <div style={{ ...row, color: DIM, cursor: 'default', whiteSpace: 'normal', lineHeight: 1.4, marginTop: 6 }}>Counted along the timeline it was reached from. Reached by hand, each point is a beat.</div>
      </>}
      {item.kind === 'pick' && <>
        <div style={gap}>CHANCE</div>
        <button style={btn()} title="As a timeline plays, a pick falls the same way every time, until it is rolled again" onClick={() => { patchItem(id, item.id, { seed: Math.floor(Math.random() * 1e9) }); replaySpace(id) }}>Roll again</button>
      </>}
      {(item.kind === 'wait' || item.kind === 'pick') && <>
        <div style={gap}>RUN</div>
        <button style={btn()} title="Send it on now, as a double-click on it does" onClick={() => fireEvent(id, item.id)}>Send on</button>
      </>}
      {item.kind !== 'timeline' && item.kind !== 'any' && wireRows('WIRES IN', wiresIn)}
      {wireRows('WIRES OUT', wiresOut)}
      <div style={gap}>NOTE</div>
      <Text area value={item.note ?? ''} onChange={(v, first) => patchItem(id, item.id, { note: v || undefined }, first)} />
      {remove(item.kind === 'timeline' ? 'Take out (the storyline stays)' : 'Remove')}
    </>
  } else if (wire) {
    const k = wireKind(d, wire)
    head = k === 'change' ? 'CHANGE' : k === 'link' ? 'LINE' : k === 'cond' || k === 'hold' ? 'CONDITION' : 'WIRE'
    const sig = k === 'signal' || k === 'cond' || k === 'hold'
    const a = endOf(d, wire.a, wire.ap), b = wire.bp === 'knob' ? undefined : endOf(d, wire.b, wire.bp)
    const lvl = sig && isLevel(a)
    const then = k === 'hold' ? 'THIS IS LIT, FOR AS LONG AS IT IS' : k === 'cond' ? (b?.kind === 'event' ? 'THIS EVENT CAN GO THROUGH' : b?.kind === 'fact' ? (wire.bp === 'a' ? 'IS THE CARD LOOKED FOR' : 'IS WHAT IT IS LOOKED FOR IN') : b?.kind === 'path' ? (wire.bp === 'time' ? 'WHAT RIDES THIS FOLLOWS IT' : wire.bp === 'take' ? "THIS TAKES ITS SET'S RIDERS" : 'WHAT RIDES THIS STANDS THERE') : b?.kind === 'act' ? 'THIS ACTS' : 'COUNTS TOWARDS')
      : wire.bp === 'knob' ? 'THIS CHANGE IS MADE' : b?.kind === 'event' ? 'THIS EVENT FIRES' : b?.kind === 'value' ? 'THIS VALUE CHANGES' : b?.kind === 'wait' ? 'THIS WAIT BEGINS' : b?.kind === 'pick' ? 'THIS PICKS ONE' : b?.kind === 'choice' ? 'THIS ASKS' : b?.kind === 'path' ? 'WHAT RIDES THIS SETS OFF' : 'THIS IS LIT'
    body = <>
      {!sig && <>
        <div style={label}>NAME</div>
        <Text value={wire.name ?? ''} placeholder={k === 'link' ? 'line' : 'change'} onChange={(v, first) => patchWire(id, wire.id, { name: v || undefined }, first)} />
      </>}
      <div style={sig ? label : gap}>{!sig ? 'FROM' : k === 'cond' ? (b?.kind === 'fact' ? 'THIS' : 'WHILE') : lvl ? 'WHEN THIS BECOMES TRUE' : 'WHEN'}</div>
      <div className="vb-sp-row" style={row} onClick={() => setSel([wire.a])}>{[fromName(wire), wireSays(d, wire)].filter(Boolean).join(' ')}</div>
      {lvl && b?.kind !== 'fact' && wire.ap !== 'time' && <>
        {a!.kind === 'value' && <>
          <div style={gap}>TRUE WHEN IT IS</div>
          <div style={chips}>
            <button style={btn(!wire.cmp)} title={a!.flag ? 'Yes' : 'Anything but 0'} onClick={() => patchWire(id, wire.id, { cmp: undefined, cn: undefined })}>{a!.flag ? 'yes' : 'not 0'}</button>
            {(a!.flag ? (['=', '!='] as Compare[]) : CMPS).map(c => <button key={c} style={btn(wire.cmp === c)} onClick={() => patchWire(id, wire.id, { cmp: c, cn: wire.cn ?? 0 })}>{CMP_WORD[c]}</button>)}
          </div>
          {<div style={{ ...chips, marginTop: 6, opacity: wire.cmp ? 1 : 0.3, pointerEvents: wire.cmp ? 'auto' : 'none' }}>
            {a!.flag ? <>
              <button style={btn(!!wire.cn)} onClick={() => patchWire(id, wire.id, { cn: 1 })}>Yes</button>
              <button style={btn(!wire.cn)} onClick={() => patchWire(id, wire.id, { cn: 0 })}>No</button>
            </> : <Num value={wire.cn ?? 0} onChange={(v, first) => patchWire(id, wire.id, { cn: v }, first)} />}
          </div>}
        </>}
        <div style={gap}>OPTIONS</div>
        <button style={btn(!!wire.not)} title="Lit: it is true when that is not" onClick={() => patchWire(id, wire.id, { not: wire.not ? undefined : true })}>Not</button>
      </>}
      <div style={gap}>{sig ? then : 'TO'}</div>
      <div className="vb-sp-row" style={row} onClick={() => setSel([wire.b])}>{toName(wire)}</div>
      {sig && b?.kind === 'value' && <>
        <div style={gap}>WHAT IT DOES TO IT</div>
        <div style={chips}>
          <button style={btn(wire.op !== 'set')} onClick={() => patchWire(id, wire.id, { op: undefined, on: wire.op === 'set' ? undefined : wire.on })}>Add</button>
          <button style={btn(wire.op === 'set')} onClick={() => patchWire(id, wire.id, { op: 'set', on: wire.op === 'set' ? wire.on : b.flag ? 1 : 0 })}>Set to</button>
          {b.flag && wire.op === 'set' ? <>
            <button style={btn(!!wire.on)} onClick={() => patchWire(id, wire.id, { on: 1 })}>Yes</button>
            <button style={btn(!wire.on)} onClick={() => patchWire(id, wire.id, { on: 0 })}>No</button>
          </> : <Num value={wire.on ?? (wire.op === 'set' ? 0 : 1)} onChange={(v, first) => patchWire(id, wire.id, { on: v }, first)} />}
        </div>
      </>}
      {!sig && <>
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
      <div style={hint}>Cards, values, And, Or and Is in are true or not: wire them into an event's "only if" to make a condition.</div>
      <div style={gap}>IN HERE</div>
      <div style={{ ...row, cursor: 'default', color: DIM }}>{d.items.length} nodes, {d.wires.length} wires</div>
      <div style={gap}>SNAPSHOT</div>
      <button data-sp-snapshot="" style={btn()} title="A closed deck beside this workspace: a card that says what is lit and what the values are, then a linked card for each lit card. Nothing that is there is moved" onClick={() => snapshotSpace(id)}>Make a deck of how things stand</button>
    </>
  }
  return (
    <div data-sp-bar="" style={{
      width: SPACE_BAR_W, flexShrink: 0, boxSizing: 'border-box', borderLeft: '1px solid rgba(255,255,255,0.1)', background: '#1c2125',
      padding: 14, display: 'flex', flexDirection: 'column', overflowX: 'hidden', overflowY: 'auto',
    }}>
      <div style={{ ...label, marginBottom: 12 }}>{head}</div>
      {body}
    </div>
  )
}

// ── The workspace ──

const SHELF: { key: string; kind: SpaceKind; name: string; title: string; more?: Partial<SpaceItem> }[] = [
  { key: 'blank', kind: 'blank', name: 'Blank', title: 'Drag onto the ground: a node with no card yet' },
  { key: 'any', kind: 'any', name: 'Any', title: 'Drag onto the ground: stands for every node; an arrow out of it is a change from anywhere' },
  { key: 'event', kind: 'event', name: 'Event', title: 'Drag onto the ground: something that happens, between other nodes' },
  { key: 'pick', kind: 'pick', name: 'Pick one', title: 'Drag onto the ground: passes on what reaches it along one of its wires, by chance' },
  { key: 'value', kind: 'value', name: 'Value', title: 'Drag onto the ground: a number, or a yes / no, that wires change and conditions read' },
  { key: 'and', kind: 'and', name: 'And', title: 'Drag onto the ground: true while everything wired into it is true' },
  { key: 'or', kind: 'or', name: 'Or', title: 'Drag onto the ground: true while anything wired into it is true' },
  { key: 'fact', kind: 'fact', name: 'Is in', title: 'Drag onto the ground: true while one card is in another on the board, in its deck or linked to it' },
  { key: 'wait', kind: 'wait', name: 'Wait', title: 'Drag onto the ground: passes on what reaches it, some points later' },
  { key: 'choice', kind: 'choice', name: 'Choose', title: 'Drag onto the ground: stops and asks; it goes on along the option that is clicked', more: { opts: [{ id: 'a', name: 'Yes' }, { id: 'b', name: 'No' }] } },
  { key: 'act', kind: 'act', name: 'Show / hide', title: 'Drag onto the ground: hides a card on the board (or only then shows it) while what is wired into it is true. Drop a card on it to say which' },
  { key: 'path', kind: 'path', name: 'Path', title: 'Drag onto the ground: a path drawn with the Curve tool, its points like a timeline\'s. What rides it can follow a timeline, and its points can send and hold' },
  { key: 'world', kind: 'timeline', name: 'World clock', title: 'Drag onto the ground: the world clock, as a timeline with an output for each of its points', more: { world: true } },
]

type Draw = { from: PortRef; fromInput: boolean; spot: PortSpot; x: number; y: number; snap: PortRef | null; cands: { ref: PortRef; spot: PortSpot }[] }
const sameRef = (a: PortRef | null | undefined, b: PortRef) => !!a && a.node === b.node && a.wire === b.wire && a.port === b.port

export function StateSpaceBody({ id, node, bodyW, bodyH }: { id: string; node: FreeNodeData; bodyW: number; bodyH: number }) {
  const d = useMemo(() => normalizeSpace(node.stateSpace ?? EMPTY), [node.stateSpace])
  const ui = node.uiScale ?? 1
  const planeW = Math.max(0, bodyW / ui - SPACE_BAR_W), planeH = bodyH / ui
  // The storylines dragged in, as they are now (their points, their marker).
  const lines = useFreeNodeStore(useShallow(s => d.items.filter(i => i.kind === 'timeline').map(i => s.nodes[lineOf(i) ?? '']?.storyline)))
  const worldLine = useCanvasStore(s => s.worldClockLine)
  // The paths drawn on the board, only where something in here is one.
  const curves = useNotesStore(s => d.items.some(i => i.kind === 'path') ? s.curves : null)
  // The workspaces that are nodes in here, as they are now (what they show, what is lit in them).
  const inners = useFreeNodeStore(useShallow(s => d.items.filter(i => i.kind === 'space').map(i => s.nodes[i.space ?? '']?.stateSpace)))
  // The board, only where something in here reads it (a fact).
  const board = useBoardsStore(s => d.items.some(i => i.kind === 'fact') ? s.groups : null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const truths = useMemo(() => spaceTruths(id), [d, board, inners])
  const says = useMemo(() => {
    const out: Record<string, [string, string]> = {}
    for (const f of d.items) {
      if (f.kind !== 'fact') continue
      const end = (p: string) => { const i = d.items.find(x => x.id === d.wires.find(w => w.b === f.id && w.bp === p)?.a); return i ? itemLabel(i, board?.find(g => g.id === i.card)?.name) : '' }
      out[f.id] = [end('a'), end('b')]
    }
    return out
  }, [d, board])
  const [sel, setSel] = useState<string[]>([])
  const [draw, setDraw] = useState<Draw | null>(null)
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [ghost, setGhost] = useState<{ kind: SpaceKind; more?: Partial<SpaceItem>; name: string; x: number; y: number } | null>(null)
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
    const c0 = tl ? lineClock(lineOf(tl)) : null
    if (!tl || !c0) { if (playing) setPlaying(null); return }
    useUndoCoordinator.getState().checkpoint()
    // From where it is; from the beginning once it is past the last point.
    let f = c0.dots.every(p => p.at <= c0.at) ? 0 : c0.toFrac(c0.at)
    let last = performance.now(), raf = 0
    const per = 1400 * (c0.dots.length + 1)
    const tick = (t: number) => {
      const c = lineClock(lineOf(tl))
      if (!c) { setPlaying(null); return }
      f = Math.min(1, f + (t - last) / per)
      last = t
      scrubStoryline(lineOf(tl)!, c.toValue(f))
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
      return mine.length === 1 ? mine[0].ref : mine.find(c => c.ref.port === (fromInput ? 'out' : 'in'))?.ref
        ?? [...mine].sort((m, n) => Math.hypot(m.spot.x - p.x, m.spot.y - p.y) - Math.hypot(n.spot.x - p.x, n.spot.y - p.y))[0]?.ref ?? null
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
      const it = SHELF.find(s => s.key === shelf.dataset.spShelf)!
      const p0 = local(e)
      let moved = false
      drag(ev => {
        const p = local(ev)
        if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) < 4) return
        moved = true
        setGhost({ kind: it.kind, more: it.more, name: it.name, x: p.x, y: p.y })
      }, ev => {
        setGhost(null)
        const p = moved ? local(ev) : freeSpot(dRef.current, planeW)
        if (!inPlane(p)) return
        const at = clampTo({ id: '', kind: it.kind, ...it.more, x: 0, y: 0 }, snap(p.x, ev.ctrlKey), snap(p.y, ev.ctrlKey))
        setSel([addItem(id, { kind: it.kind, ...it.more, ...at })])
      })
      return
    }
    const optEl = t.closest('[data-sp-opt]') as HTMLElement | null
    if (optEl && optEl.dataset.spOf) {
      // An option of a choice: a click answers it; a drag moves the node as anywhere else on it.
      const p0 = local(e)
      let far = false
      const who = optEl.dataset.spOf, opt = optEl.dataset.spOpt!
      window.addEventListener('pointermove', function seen(ev) { if (Math.hypot(local(ev).x - p0.x, local(ev).y - p0.y) > 3) { far = true; window.removeEventListener('pointermove', seen) } })
      window.addEventListener('pointerup', () => { if (!far) choose(id, who, opt) }, { once: true })
    }
    const stepEl = t.closest('[data-sp-step]') as HTMLElement | null
    const stepped = stepEl ? d.items.find(i => i.id === stepEl.dataset.spOf) : undefined
    if (stepped) {
      // The little − and + on a value or a wait.
      const by = Number(stepEl!.dataset.spStep)
      setSel([stepped.id])
      if (stepped.kind === 'value') setValue(id, stepped.id, stepped.flag ? (by > 0 ? 1 : 0) : valOf(stepped) + by)
      else { patchItem(id, stepped.id, { n: Math.max(0, Math.round(stepped.n ?? 1) + by) }); replaySpace(id) }
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
    const clock = tl ? lineClock(lineOf(tl)) : null
    if (tl && clock) {
      // Along a timeline: its time marker, the storyline's own.
      const w = itemSize(tl).w
      setSel([tl.id])
      setPlaying(null)
      useUndoCoordinator.getState().checkpoint()
      const to = (ev: { clientX: number; clientY: number; isTrusted?: boolean }) =>
        scrubStoryline(lineOf(tl)!, clock.toValue(Math.max(0, Math.min(1, (local(ev).x - (dRef.current.items.find(i => i.id === tl.id)?.x ?? tl.x) + w / 2) / w))))
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
    if (t.closest('[data-sp-bar],[data-sp-shelf],[data-sp-track],[data-sp-port],[data-sp-play],[data-sp-step],[data-sp-opt]')) return
    e.stopPropagation()
    const nodeEl = t.closest('[data-sp-node]') as HTMLElement | null
    const it = nodeEl ? d.items.find(i => i.id === nodeEl.dataset.spNode) : undefined
    if (it?.kind === 'space') { goToSpace(it.space); return }
    if (it?.kind === 'event' || it?.kind === 'wait' || it?.kind === 'pick') { fireEvent(id, it.id); setPulse(p => ({ ...p, [it.id]: Date.now() })); return }
    if (it) { setNow(id, it.id, !it.now); return }
    const p = local(e)
    const w = d.wires.find(x => { const g = wireKind(d, x) === 'change' ? wireGeom(d, x) : null; return g && wireDist(g, p.x, p.y) < 9 })
    if (w) makeChange(id, w.id)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wires = useMemo(() => d.wires.map(w => ({ w, g: wireGeom(d, w), kind: wireKind(d, w), tone: wireTone(d, w) })).filter((x): x is { w: SpaceWire; g: WireGeom; kind: ReturnType<typeof wireKind>; tone: string } => !!x.g), [d, lines, worldLine, inners, curves])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ports = useMemo(() => d.items.flatMap(i => itemPorts(i).map(p => ({ item: i, ...p }))), [d, lines, worldLine, inners, curves])
  const marker = (tone: string) => markerId(id, tone)
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
              {wires.map(({ w, g, kind, tone }) => <WireG key={w.id} w={w} g={g} kind={kind} tone={tone} on={sel.includes(w.id)} says={wireSays(d, w)} does={wireDoes(d, w)} space={id} />)}
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
            {d.items.map(i => i.kind === 'path' ? <PathView key={i.id} item={i} picked={sel.includes(i.id)} /> : i.kind === 'timeline'
              ? <TimelineView key={i.id} item={i} picked={sel.includes(i.id)} playing={playing === i.id} />
              : <NodeViewMemo key={i.id} item={i} picked={sel.includes(i.id)} stamp={pulse[i.id]} on={truths.has(i.id)} says={says[i.id]} />)}
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
              const tone = p.port === 'if' || p.port.startsWith('hold:') || p.port === 'take' ? GREEN : kindTone(p.item.kind === 'space' ? endOf(d, p.item.id, p.port)?.kind : p.item.kind)
              return <div key={p.item.id + p.port} data-sp-port={p.port} data-sp-of={p.item.id} data-sp-out={p.out ? '1' : '0'} className="vb-sp-port"
                title={PORT_TITLE[p.port.split(':')[0]] ?? (p.port === 'if' ? 'Only if: wire anything that is true or not here (a card, a value, And, Or, Is in) and this event only goes through while it is true' : p.port === 'a' ? 'The card looked for: wire a card node here' : p.port === 'b' ? 'What it is looked for in: wire a card node here' : p.out ? 'Out: drag from here to what follows' : 'In: drag a wire onto here')}
                style={{
                  position: 'absolute', left: p.spot.x - 7, top: p.spot.y - 7, width: 14, height: 14, borderRadius: p.port === 'if' || p.port.startsWith('hold:') || p.port === 'take' ? 3 : '50%', boxSizing: 'border-box',
                  background: hot || own ? BLUE : p.out ? tone : GROUND, border: `2px solid ${hot || (draw && can && !own) ? BLUE : tone}`,
                  cursor: 'crosshair', opacity: draw && !can ? 0.2 : 1, transform: hot ? 'scale(1.5)' : undefined,
                }} />
            })}
            {/* A timeline's points have an output on the top edge too. */}
            {ports.filter(p => p.item.kind === 'timeline' && p.port.startsWith('pt:')).map(p => {
              const ref = { node: p.item.id, port: p.port }
              const own = draw && sameRef(draw.from, ref)
              return <div key={p.item.id + p.port + 'top'} data-sp-port={p.port} data-sp-of={p.item.id} data-sp-out="1" data-sp-top="" className="vb-sp-port" title="Out: drag from here to what happens at this point" style={{
                position: 'absolute', left: p.spot.x - 7, top: p.item.y - TL_H / 2 - 7, width: 14, height: 14, borderRadius: '50%', boxSizing: 'border-box',
                background: own ? BLUE : AMBER, border: `2px solid ${AMBER}`, cursor: 'crosshair', opacity: draw && !own ? 0.2 : 1,
              }} />
            })}
            {band && <div style={{ position: 'absolute', left: band.x, top: band.y, width: band.w, height: band.h, border: `1px solid ${BLUE}`, background: 'rgba(111,183,224,0.1)', pointerEvents: 'none' }} />}
            {/* The shelf: what there is to drag in besides cards and storylines. */}
            <div style={{ position: 'absolute', left: 10, right: 10, top: 10, display: 'flex', flexWrap: 'wrap', gap: 6, fontFamily: FONT, pointerEvents: 'none' }}>
              {SHELF.map(s => (
                <div key={s.key} data-sp-shelf={s.key} className="vb-sp-chip" title={s.title} style={{
                  height: 24, lineHeight: '22px', padding: '0 10px', boxSizing: 'border-box', borderRadius: s.kind === 'blank' ? 5 : 12, fontSize: 11, color: INK, cursor: 'grab', userSelect: 'none', whiteSpace: 'nowrap', pointerEvents: 'auto',
                  background: 'rgba(255,255,255,0.05)', border: `1px ${s.kind === 'blank' ? 'dashed' : 'solid'} ${kindTone(s.kind) === STEEL ? 'rgba(255,255,255,0.3)' : kindTone(s.kind)}`,
                }}>{s.name}</div>
              ))}
            </div>
            {ghost && (() => {
              const s = itemSize({ id: '', kind: ghost.kind, ...ghost.more, x: 0, y: 0 })
              return <div style={{
                position: 'absolute', left: ghost.x - s.w / 2, top: ghost.y - s.h / 2, width: s.w, height: s.h, boxSizing: 'border-box', pointerEvents: 'none',
                borderRadius: ghost.kind === 'blank' ? 12 : Math.min(20, s.h / 2), border: `2px dashed ${kindTone(ghost.kind)}`, background: 'rgba(255,255,255,0.06)',
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
