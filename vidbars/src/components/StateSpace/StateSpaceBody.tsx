// StateSpaceBody — the state workspace's picture (utils/stateSpace): icons
// on a dotted ground, the lines between them, and a bar down the right
// side for whatever is picked. The bar never changes size.
//
// Hands: drag a card or a deck in to make an icon (CardLayer lets it go
// here; the card goes back). Drag an icon by its middle to move it; drag
// from its rim to another icon to draw a line. Click picks; double-click an
// icon lights it as "now". Delete removes what is picked.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { FreeNodeData } from '../../store/freeNodeStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { ContentScaled } from '../UI/PanelSurface'
import { cardFaceSourceUrl, stackedDeckMembers } from '../../utils/cardGrid'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { cardTypeOf, typeColor } from '../../utils/cardTypes'
import { goToCard } from '../../utils/stateCard'
import { useShallow } from 'zustand/react/shallow'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useCanvasStore } from '../../store/canvasStore'
import { scrubStoryline } from '../Canvas/StorylineLayer'
import {
  ANY_R, ICON, RIM, STRIP_GAP, STRIP_H, STRIP_INSET, STRIP_PAD, addItem, addTie, addWire, editSpace, emptyStateSpace, lineClock,
  makeChange, patchItem, patchWire, removeItem, removeLine, removeTie, removeWire, setNow,
  type LineClock, type SpaceItem, type SpaceTie, type SpaceWire, type StateSpaceData,
} from '../../utils/stateSpace'

const BAR_W = 250
const GREEN = '#5fa86c', BLUE = '#6fb7e0', AMBER = '#d9a441', LINE = 'rgba(160,180,190,0.75)', DIM = 'rgba(255,255,255,0.45)'
const FONT = 'Inter, system-ui, sans-serif'

type Pick = { kind: 'item' | 'wire' | 'tie'; id: string } | null

/** A timeline as laid out in the workspace: its strip's box and where its
 *  dots and marker are, in the workspace's own units. */
interface Strip { line: string; clock: LineClock | null; left: number; top: number; width: number; y: number; knob: number; dots: { id: string; title: string; x: number; done: boolean }[] }

const half = (i: SpaceItem) => i.kind === 'any' ? ANY_R : ICON / 2

/** Where the line from `a` towards `b` leaves a's edge. */
function edgePoint(a: SpaceItem, bx: number, by: number, gap = 4): { x: number; y: number } {
  const dx = bx - a.x, dy = by - a.y
  const len = Math.hypot(dx, dy) || 1
  const h = half(a) + gap
  if (a.kind === 'any') return { x: a.x + dx / len * h, y: a.y + dy / len * h }
  const t = h / Math.max(Math.abs(dx), Math.abs(dy), 0.001)
  return { x: a.x + dx * t, y: a.y + dy * t }
}

/** A line's two ends and its middle; a pair of lines going both ways between
 *  the same two icons sit side by side. */
function wireGeom(d: StateSpaceData, w: SpaceWire) {
  const a = d.items.find(i => i.id === w.a), b = d.items.find(i => i.id === w.b)
  if (!a || !b) return null
  const twin = d.wires.some(o => o.a === w.b && o.b === w.a)
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1
  const ox = twin ? -dy / len * 12 : 0, oy = twin ? dx / len * 12 : 0
  const p = edgePoint(a, b.x, b.y), q = edgePoint(b, a.x, a.y, w.plain ? 4 : 8)
  return { x1: p.x + ox, y1: p.y + oy, x2: q.x + ox, y2: q.y + oy, mx: (p.x + q.x) / 2 + ox, my: (p.y + q.y) / 2 + oy }
}

function useCardOf(id: string | undefined) {
  return useBoardsStore(s => id ? s.groups.find(g => g.id === id) : undefined)
}

function itemLabel(i: SpaceItem, cardName?: string): string {
  if (i.name) return i.name
  if (i.kind === 'any') return 'Any'
  if (i.kind === 'card') return cardName || 'Card'
  return 'State'
}

const IconView: React.FC<{ item: SpaceItem; picked: boolean; aim: boolean }> = ({ item, picked, aim }) => {
  const card = useCardOf(item.card)
  const boards = useBoardsStore(s => s.boards)
  const count = useBoardsStore(s => card && card.deckState && card.deckState !== 'open' ? stackedDeckMembers(card.id, s.groups).length : 0)
  const src = useResolvedMedia(card ? cardFaceSourceUrl(card, boards) : null)
  const gone = item.kind === 'card' && !card
  const edge = picked ? BLUE : aim ? '#fff' : item.now ? GREEN : 'rgba(255,255,255,0.22)'
  if (item.kind === 'any') {
    return (
      <div data-space-item={item.id} data-space-rim="" className="vb-space-rim" style={{
        position: 'absolute', left: item.x - ANY_R, top: item.y - ANY_R, width: ANY_R * 2, height: ANY_R * 2,
        borderRadius: '50%', border: `2px solid ${edge}`, background: '#1c2125', boxSizing: 'border-box', cursor: 'crosshair',
      }}>
        <div data-space-body="" style={{
          position: 'absolute', inset: RIM, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#e4e9ea', fontSize: 12, fontFamily: FONT, cursor: 'grab', userSelect: 'none',
        }}>{itemLabel(item)}</div>
      </div>
    )
  }
  const tint = card ? card.color || typeColor(cardTypeOf(card)) : '#3a444b'
  return (
    <div data-space-item={item.id} data-space-rim="" className="vb-space-rim" style={{
      position: 'absolute', left: item.x - ICON / 2, top: item.y - ICON / 2, width: ICON, height: ICON,
      borderRadius: 12, border: `2px ${item.kind === 'blank' ? 'dashed' : 'solid'} ${edge}`, boxSizing: 'border-box',
      background: item.now ? 'rgba(95,168,108,0.28)' : '#232a2f', cursor: 'crosshair',
      boxShadow: item.now ? `0 0 18px rgba(95,168,108,0.55)` : 'none',
    }}>
      <div data-space-body="" style={{
        position: 'absolute', inset: RIM - 2, borderRadius: 6, overflow: 'hidden', cursor: 'grab', userSelect: 'none',
        display: 'flex', flexDirection: 'column', background: '#1a1f23', opacity: gone ? 0.45 : 1,
      }}>
        <div style={{ flex: 1, minHeight: 0, background: tint, position: 'relative' }}>
          {src && <img src={src} draggable={false} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
          {count > 1 && <div style={{
            position: 'absolute', right: 3, top: 3, minWidth: 16, height: 16, borderRadius: 8, padding: '0 4px', boxSizing: 'border-box',
            background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: 10, lineHeight: '16px', textAlign: 'center', fontFamily: FONT,
          }}>{count}</div>}
        </div>
        <div style={{
          height: 20, lineHeight: '20px', padding: '0 5px', fontSize: 11, fontFamily: FONT, textAlign: 'center',
          color: '#e4e9ea', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: item.now ? 600 : 400,
        }}>{gone ? 'card gone' : itemLabel(item, card?.name)}</div>
      </div>
      {item.now && <div style={{
        position: 'absolute', left: 0, right: 0, top: -17, textAlign: 'center', fontSize: 9, letterSpacing: '0.1em',
        color: GREEN, fontFamily: FONT, fontWeight: 600, pointerEvents: 'none',
      }}>NOW</div>}
    </div>
  )
}

const label: React.CSSProperties = { fontSize: 9, letterSpacing: '0.1em', color: DIM, fontFamily: FONT, marginBottom: 4 }
const field: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 4, color: '#e4e9ea', fontSize: 12, fontFamily: FONT, padding: '5px 7px', outline: 'none',
}
const btn = (lit = false): React.CSSProperties => ({
  background: lit ? 'rgba(95,168,108,0.3)' : 'rgba(255,255,255,0.05)', border: `1px solid ${lit ? GREEN : 'rgba(255,255,255,0.14)'}`,
  borderRadius: 4, color: lit ? '#fff' : 'rgba(255,255,255,0.75)', fontSize: 11, fontFamily: FONT, padding: '5px 9px', cursor: 'pointer', alignSelf: 'flex-start', flexShrink: 0,
})
const row: React.CSSProperties = { fontSize: 12, fontFamily: FONT, color: '#e4e9ea', padding: '3px 0', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }

/** A text box that writes on every change but takes one undo step a visit. */
const Text: React.FC<{ value: string; placeholder?: string; area?: boolean; onChange: (v: string, first: boolean) => void }> = ({ value, placeholder, area, onChange }) => {
  const fresh = useRef(true)
  const props = {
    value, placeholder, style: area ? { ...field, height: 86, resize: 'none' as const } : field,
    onFocus: () => { fresh.current = true },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { onChange(e.target.value, fresh.current); fresh.current = false },
    onKeyDown: (e: React.KeyboardEvent) => { e.stopPropagation(); if (e.key === 'Enter' && !area) (e.target as HTMLElement).blur() },
  }
  return area ? <textarea {...props} /> : <input {...props} />
}

const Bar: React.FC<{ id: string; d: StateSpaceData; pick: Pick; setPick: (p: Pick) => void; strips: Strip[] }> = ({ id, d, pick, setPick, strips }) => {
  const groups = useBoardsStore(s => s.groups)
  const nameOf = (itemId: string) => {
    const i = d.items.find(x => x.id === itemId)
    return i ? itemLabel(i, groups.find(g => g.id === i.card)?.name) : '?'
  }
  const item = pick?.kind === 'item' ? d.items.find(i => i.id === pick.id) : undefined
  const wire = pick?.kind === 'wire' ? d.wires.find(w => w.id === pick.id) : undefined
  const tie = pick?.kind === 'tie' ? d.ties?.find(t => t.id === pick.id) : undefined
  const dotName = (t: SpaceTie) => {
    const st = strips.find(x => x.line === t.line)
    return `${st?.dots.find(p => p.id === t.dot)?.title ?? 'dot gone'}  ·  ${st?.clock?.title ?? 'timeline gone'}`
  }
  /** Where in a timeline this happens: the dots tied to it. */
  const happens = (mine: SpaceTie[]) => <>
    <div style={{ ...label, marginTop: 14 }}>HAPPENS AT</div>
    {mine.length ? mine.map(t => <div key={t.id} style={row} onClick={() => setPick({ kind: 'tie', id: t.id })}><span style={{ color: AMBER }}>●</span> {dotName(t)}</div>)
      : <div style={{ ...row, color: DIM, cursor: 'default' }}>no dot yet</div>}
  </>
  const wireName = (w: SpaceWire) => `${w.name || (w.plain ? 'line' : 'change')}  ·  ${nameOf(w.a)} ${w.plain ? '—' : '→'} ${nameOf(w.b)}`
  let body: React.ReactNode
  if (item) {
    const card = groups.find(g => g.id === item.card)
    const out = d.wires.filter(w => w.a === item.id), inn = d.wires.filter(w => w.b === item.id)
    body = <>
      <div style={label}>NAME</div>
      <Text value={item.name ?? ''} placeholder={itemLabel({ ...item, name: undefined }, card?.name)} onChange={(v, first) => patchItem(id, item.id, { name: v || undefined }, first)} />
      {item.kind === 'card' && <>
        <div style={{ ...label, marginTop: 14 }}>CARD</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={{ ...row, flex: 1, cursor: 'default' }}>{card ? card.name || 'Card' : 'card gone'}</div>
          {card && <button style={btn()} onClick={() => goToCard(card.id)}>Go to</button>}
        </div>
      </>}
      {item.kind !== 'any' && <>
        <div style={{ ...label, marginTop: 14 }}>STATE</div>
        <button style={btn(!!item.now)} onClick={() => setNow(id, item.id, !item.now)}>Now</button>
      </>}
      {item.kind !== 'any' && happens((d.ties ?? []).filter(t => t.item === item.id))}
      <div style={{ ...label, marginTop: 14 }}>LINES OUT</div>
      {out.length ? out.map(w => <div key={w.id} style={row} onClick={() => setPick({ kind: 'wire', id: w.id })}>{wireName(w)}</div>) : <div style={{ ...row, color: DIM, cursor: 'default' }}>none</div>}
      <div style={{ ...label, marginTop: 14 }}>LINES IN</div>
      {inn.length ? inn.map(w => <div key={w.id} style={row} onClick={() => setPick({ kind: 'wire', id: w.id })}>{wireName(w)}</div>) : <div style={{ ...row, color: DIM, cursor: 'default' }}>none</div>}
      <div style={{ flex: 1 }} />
      <button style={btn()} onClick={() => { removeItem(id, item.id); setPick(null) }}>Remove icon</button>
    </>
  } else if (wire) {
    body = <>
      <div style={label}>NAME</div>
      <Text value={wire.name ?? ''} placeholder={wire.plain ? 'line' : 'change'} onChange={(v, first) => patchWire(id, wire.id, { name: v || undefined }, first)} />
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={label}>FROM</div>
          <div style={row} onClick={() => setPick({ kind: 'item', id: wire.a })}>{nameOf(wire.a)}</div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={label}>TO</div>
          <div style={row} onClick={() => setPick({ kind: 'item', id: wire.b })}>{nameOf(wire.b)}</div>
        </div>
      </div>
      <div style={{ ...label, marginTop: 14 }}>OPTIONS</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={btn(!wire.plain)} title="Lit: an arrow, a change from one to the other. Unlit: a plain line, any other relationship" onClick={() => patchWire(id, wire.id, { plain: wire.plain ? undefined : true })}>Arrow</button>
        <button style={btn()} title="Swap its two ends" onClick={() => editSpace(id, s => ({ ...s, wires: s.wires.map(w => w.id === wire.id ? { ...w, a: w.b, b: w.a } : w) }))}>Turn round</button>
      </div>
      {!wire.plain && <>
        <div style={{ ...label, marginTop: 14 }}>RUN</div>
        <button style={btn()} title="Its far end becomes now" onClick={() => makeChange(id, wire.id)}>Make this change</button>
      </>}
      {!wire.plain && happens((d.ties ?? []).filter(t => t.wire === wire.id))}
      <div style={{ ...label, marginTop: 14 }}>NOTE</div>
      <Text area value={wire.note ?? ''} onChange={(v, first) => patchWire(id, wire.id, { note: v || undefined }, first)} />
      <div style={{ flex: 1 }} />
      <button style={btn()} onClick={() => { removeWire(id, wire.id); setPick(null) }}>Remove line</button>
    </>
  } else if (tie) {
    const w = tie.wire ? d.wires.find(x => x.id === tie.wire) : undefined
    body = <>
      <div style={label}>AT</div>
      <div style={{ ...row, cursor: 'default' }}><span style={{ color: AMBER }}>●</span> {dotName(tie)}</div>
      <div style={{ ...label, marginTop: 14 }}>{w ? 'THIS CHANGE IS MADE' : 'THIS IS LIT'}</div>
      {w ? <div style={row} onClick={() => setPick({ kind: 'wire', id: w.id })}>{wireName(w)}</div>
        : <div style={row} onClick={() => tie.item && setPick({ kind: 'item', id: tie.item })}>{tie.item ? nameOf(tie.item) : '?'}</div>}
      <div style={{ flex: 1 }} />
      <button style={btn()} onClick={() => { removeTie(id, tie.id); setPick(null) }}>Remove tie</button>
    </>
  } else {
    const hint: React.CSSProperties = { fontSize: 12, fontFamily: FONT, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5, marginBottom: 8 }
    body = <>
      <div style={hint}>Drag a card or a deck in to make an icon.</div>
      <div style={hint}>Drag from an icon's rim to another icon to draw a line.</div>
      <div style={hint}>Double-click an icon to light it as now.</div>
      <div style={hint}>Drag a storyline in by its handle for a timeline, then drag from one of its dots to a line or an icon.</div>
      <div style={{ ...label, marginTop: 10 }}>ADD</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={btn()} title="An icon with no card yet" onClick={() => setPick({ kind: 'item', id: addItem(id, { kind: 'blank', ...freeSpot(d) }) })}>Blank</button>
        <button style={btn()} title="Stands for every icon: an arrow out of it is a change that can happen from anywhere" onClick={() => setPick({ kind: 'item', id: addItem(id, { kind: 'any', ...freeSpot(d) }) })}>Any</button>
      </div>
      <div style={{ ...label, marginTop: 14 }}>IN HERE</div>
      <div style={{ ...row, cursor: 'default', color: DIM }}>{d.items.length} icons, {d.wires.length} lines</div>
    </>
  }
  return (
    <div data-space-bar="" style={{
      width: BAR_W, flexShrink: 0, boxSizing: 'border-box', borderLeft: '1px solid rgba(255,255,255,0.1)', background: '#1c2125',
      padding: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ ...label, marginBottom: 12 }}>{item ? 'ICON' : wire ? (wire.plain ? 'LINE' : 'CHANGE') : tie ? 'TIE' : 'STATES'}</div>
      {body}
    </div>
  )
}

/** A clear place for a new icon: along the top, past the ones there. */
function freeSpot(d: StateSpaceData): { x: number; y: number } {
  const step = ICON + 24
  for (let n = 0; n < 200; n++) {
    const x = 80 + (n % 6) * step, y = 80 + Math.floor(n / 6) * step
    if (!d.items.some(i => Math.abs(i.x - x) < ICON && Math.abs(i.y - y) < ICON)) return { x, y }
  }
  return { x: 80, y: 80 }
}

/** How far (x, y) is from the segment a-b. */
function segDist(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(x - x1 - dx * t, y - y1 - dy * t)
}

export function StateSpaceBody({ id, node, bodyW, bodyH }: { id: string; node: FreeNodeData; bodyW: number; bodyH: number }) {
  const d = node.stateSpace ?? EMPTY
  const ui = node.uiScale ?? 1
  const planeW = Math.max(0, bodyW / ui - BAR_W), planeH = bodyH / ui
  // The storylines dragged in, as they are now (their dots, their marker).
  const lineNodes = useFreeNodeStore(useShallow(s => (d.lines ?? []).map(l => s.nodes[l]?.storyline)))
  const strips = useMemo<Strip[]>(() => (d.lines ?? []).map((line, i) => {
    const clock = lineClock(line)
    const left = STRIP_PAD, width = Math.max(0, planeW - 2 * STRIP_PAD)
    const top = planeH - STRIP_PAD - (i + 1) * STRIP_H - i * STRIP_GAP
    const span = Math.max(0, width - 2 * STRIP_INSET)
    const x = (f: number) => left + STRIP_INSET + f * span
    return { line, clock, left, top, width, y: top + 44, knob: clock ? x(clock.toFrac(clock.at)) : 0,
      dots: clock ? clock.dots.map(p => ({ id: p.id, title: p.title, x: x(p.frac), done: p.at <= clock.at })) : [] }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [d.lines, lineNodes, planeW, planeH])
  const [tieDraw, setTieDraw] = useState<{ x1: number; y1: number; x: number; y: number } | null>(null)
  const [pick, setPick] = useState<Pick>(null)
  const [draw, setDraw] = useState<{ from: string; x: number; y: number; over: string | null } | null>(null)
  const plane = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const pickRef = useRef(pick)
  pickRef.current = pick

  const local = (e: { clientX: number; clientY: number }) => {
    const el = plane.current!
    const r = el.getBoundingClientRect()
    const k = r.width / Math.max(1, el.offsetWidth)
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
  }
  const itemAt = (x: number, y: number, not?: string) =>
    [...d.items].reverse().find(i => i.id !== not && Math.abs(i.x - x) <= half(i) && Math.abs(i.y - y) <= half(i))

  // Delete removes what is picked, while the hand is in here.
  useEffect(() => {
    const el = root.current
    if (!el) return
    let last = false
    const down = (e: PointerEvent) => { last = el.contains(e.target as Node); if (!last && pickRef.current) setPick(null) }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const p = pickRef.current
      if (!last || !p || e.ctrlKey || e.metaKey || e.altKey) return
      const a = document.activeElement as HTMLElement | null
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return
      e.preventDefault()
      e.stopPropagation()
      if (p.kind === 'item') removeItem(id, p.id); else if (p.kind === 'wire') removeWire(id, p.id); else removeTie(id, p.id)
      setPick(null)
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true) }
  }, [id])

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const t = e.target as HTMLElement
    if (t.closest('[data-space-bar],[data-space-button]')) return
    const tieEl = t.closest('[data-space-tie]') as HTMLElement | null
    if (tieEl) { setPick({ kind: 'tie', id: tieEl.dataset.spaceTie! }); return }
    const dotEl = t.closest('[data-space-dot]') as HTMLElement | null
    if (dotEl) {
      // From a timeline's dot: a tie, to the line or icon it is let go on.
      const [line, dot] = dotEl.dataset.spaceDot!.split(' ')
      const st = strips.find(x => x.line === line), sd = st?.dots.find(x => x.id === dot)
      if (!st || !sd) return
      const move = (ev: PointerEvent) => { const p = local(ev); setTieDraw({ x1: sd.x, y1: st.y, x: p.x, y: p.y }) }
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        setTieDraw(null)
        const p = local(ev)
        const it = itemAt(p.x, p.y)
        const w = it ? undefined : d.wires.find(x => { const g = wireGeom(d, x); return !x.plain && g && segDist(p.x, p.y, g.x1, g.y1, g.x2, g.y2) < 14 })
        const made = it && it.kind !== 'any' ? addTie(id, line, dot, { item: it.id }) : w ? addTie(id, line, dot, { wire: w.id }) : null
        if (made) setPick({ kind: 'tie', id: made })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      return
    }
    const trackEl = t.closest('[data-space-track]') as HTMLElement | null
    if (trackEl) {
      // Along a timeline: its time marker, the storyline's own.
      const st = strips.find(x => x.line === trackEl.dataset.spaceTrack)
      if (!st?.clock) return
      const c = st.clock, span = Math.max(1, st.width - 2 * STRIP_INSET)
      useUndoCoordinator.getState().checkpoint()
      const to = (ev: { clientX: number; clientY: number }) => scrubStoryline(st.line, c.toValue(Math.max(0, Math.min(1, (local(ev).x - st.left - STRIP_INSET) / span))))
      to(e)
      const move = (ev: PointerEvent) => to(ev)
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      return
    }
    const wireEl = t.closest('[data-space-wire]') as HTMLElement | null
    if (wireEl) { setPick({ kind: 'wire', id: wireEl.dataset.spaceWire! }); return }
    const itemEl = t.closest('[data-space-item]') as HTMLElement | null
    if (!itemEl) { setPick(null); return }
    const itemId = itemEl.dataset.spaceItem!
    const it = d.items.find(i => i.id === itemId)
    if (!it) return
    setPick({ kind: 'item', id: itemId })
    const p0 = local(e)
    if (!t.closest('[data-space-body]')) {
      // From the rim: a line, to whichever icon it is let go on.
      const move = (ev: PointerEvent) => {
        const p = local(ev)
        setDraw({ from: itemId, x: p.x, y: p.y, over: itemAt(p.x, p.y, itemId)?.id ?? null })
      }
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        setDraw(null)
        const p = local(ev)
        const to = itemAt(p.x, p.y, itemId)
        if (!to) return
        const w = addWire(id, itemId, to.id)
        if (w) setPick({ kind: 'wire', id: w })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      return
    }
    // By its middle: move it. The first move takes the undo step.
    let moved = false
    const el = plane.current!
    const move = (ev: PointerEvent) => {
      const p = local(ev)
      if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) < 3) return
      if (!moved) { moved = true; useUndoCoordinator.getState().checkpoint() }
      const h = half(it)
      const x = Math.max(h, Math.min(el.offsetWidth - h, it.x + p.x - p0.x))
      const y = Math.max(h, Math.min(el.offsetHeight - h, it.y + p.y - p0.y))
      patchItem(id, itemId, { x, y }, false)
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onDouble = (e: React.MouseEvent) => {
    const itemEl = (e.target as HTMLElement).closest('[data-space-item]') as HTMLElement | null
    if (!itemEl) return
    e.stopPropagation()
    const it = d.items.find(i => i.id === itemEl.dataset.spaceItem)
    if (it) setNow(id, it.id, !it.now)
  }

  const wires = useMemo(() => d.wires.map(w => ({ w, g: wireGeom(d, w) })).filter(x => x.g), [d])
  const from = draw ? d.items.find(i => i.id === draw.from) : undefined
  const fromPt = from && draw ? edgePoint(from, draw.x, draw.y) : null

  return (
    <div ref={root} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <ContentScaled factor={node.uiScale ?? 1}>
        <style>{`.vb-space-rim:hover{outline:2px solid rgba(255,255,255,0.35);outline-offset:1px}`}</style>
        <div style={{ position: 'absolute', inset: 0, display: 'flex' }} onPointerDown={onDown} onDoubleClick={onDouble}>
          <div ref={plane} data-state-plane={id} style={{
            flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden', background: '#171b1e',
            backgroundImage: 'radial-gradient(rgba(255,255,255,0.09) 1px, transparent 1.2px)', backgroundSize: '20px 20px',
          }}>
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
              <defs>
                <marker id={`sa-${id}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L10 5L0 10z" fill="rgb(160,180,190)" /></marker>
                <marker id={`sb-${id}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="11" markerHeight="11" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L10 5L0 10z" fill={BLUE} /></marker>
              </defs>
              {wires.map(({ w, g }) => {
                const on = pick?.kind === 'wire' && pick.id === w.id
                return (
                  <g key={w.id} data-space-wire={w.id} style={{ cursor: 'pointer' }}>
                    <line x1={g!.x1} y1={g!.y1} x2={g!.x2} y2={g!.y2} stroke="transparent" strokeWidth={16} />
                    <line x1={g!.x1} y1={g!.y1} x2={g!.x2} y2={g!.y2} stroke={on ? BLUE : LINE} strokeWidth={on ? 2.6 : 1.7}
                      strokeDasharray={w.plain ? '2 5' : undefined} strokeLinecap="round"
                      markerEnd={w.plain ? undefined : `url(#${on ? 'sb' : 'sa'}-${id})`} />
                    {w.name && <text x={g!.mx} y={g!.my - 7} textAnchor="middle" fontSize={11} fontFamily={FONT}
                      fill={on ? BLUE : 'rgba(255,255,255,0.7)'} stroke="#171b1e" strokeWidth={4} paintOrder="stroke" style={{ userSelect: 'none' }}>{w.name}</text>}
                  </g>
                )
              })}
              {(d.ties ?? []).map(t => {
                const st = strips.find(x => x.line === t.line), sd = st?.dots.find(x => x.id === t.dot)
                const w = t.wire ? d.wires.find(x => x.id === t.wire) : undefined
                const g = w ? wireGeom(d, w) : null
                const it = t.item ? d.items.find(x => x.id === t.item) : undefined
                const end = g ? { x: g.mx, y: g.my } : it ? { x: it.x, y: it.y + half(it) + 3 } : null
                if (!st || !sd || !end) return null
                const on = pick?.kind === 'tie' && pick.id === t.id
                const path = `M${sd.x} ${st.y - 7}C${sd.x} ${(st.y + end.y) / 2} ${end.x} ${(st.y + end.y) / 2} ${end.x} ${end.y}`
                return (
                  <g key={t.id} data-space-tie={t.id} style={{ cursor: 'pointer' }}>
                    <path d={path} fill="none" stroke="transparent" strokeWidth={14} />
                    <path d={path} fill="none" stroke={on ? BLUE : AMBER} strokeWidth={on ? 2.2 : 1.4} strokeDasharray="4 4" opacity={on ? 1 : 0.85} />
                    <circle cx={end.x} cy={end.y} r={3.5} fill={on ? BLUE : AMBER} />
                  </g>
                )
              })}
              {tieDraw && <line x1={tieDraw.x1} y1={tieDraw.y1} x2={tieDraw.x} y2={tieDraw.y} stroke={AMBER} strokeWidth={2} strokeDasharray="4 4" style={{ pointerEvents: 'none' }} />}
              {fromPt && draw && <line x1={fromPt.x} y1={fromPt.y} x2={draw.x} y2={draw.y} stroke={BLUE} strokeWidth={2} strokeDasharray="6 4" markerEnd={`url(#sb-${id})`} style={{ pointerEvents: 'none' }} />}
            </svg>
            {strips.map(st => (
              <div key={st.line} data-space-strip={st.line} style={{
                position: 'absolute', left: st.left, top: st.top, width: st.width, height: STRIP_H, boxSizing: 'border-box',
                background: '#1c2125', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6, fontFamily: FONT, userSelect: 'none',
              }}>
                <div style={{ position: 'absolute', left: 10, top: 6, right: 70, fontSize: 9, letterSpacing: '0.1em', color: DIM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  TIMELINE  ·  {(st.clock?.title ?? 'storyline gone').toUpperCase()}
                </div>
                <div style={{ position: 'absolute', right: 6, top: 3, display: 'flex', gap: 4 }}>
                  {st.clock && <button data-space-button="" title="Go to this storyline on the canvas" style={{ ...btn(), padding: '1px 6px' }} onClick={() => {
                    const n = useFreeNodeStore.getState().nodes[st.line]
                    const dots = n?.storyline?.dots ?? []
                    if (n && dots.length) useCanvasStore.getState().jumpToPoint(n.x + (Math.min(...dots.map(p => p.x)) + Math.max(...dots.map(p => p.x))) / 2, n.y + (Math.min(...dots.map(p => p.y)) + Math.max(...dots.map(p => p.y))) / 2)
                  }}>◎</button>}
                  <button data-space-button="" title="Take this timeline out of the workspace (the storyline itself stays)" style={{ ...btn(), padding: '1px 6px' }} onClick={() => removeLine(id, st.line)}>×</button>
                </div>
                {st.clock && <>
                  <div data-space-track={st.line} style={{ position: 'absolute', left: STRIP_INSET - 20, right: STRIP_INSET - 20, top: 30, height: 30, cursor: 'ew-resize' }}>
                    <div style={{ position: 'absolute', left: 20, right: 20, top: 13, height: 2, background: 'rgba(217,164,65,0.35)' }} />
                    <div style={{ position: 'absolute', left: 20, width: Math.max(0, st.knob - st.left - STRIP_INSET), top: 13, height: 2, background: AMBER }} />
                  </div>
                  {st.dots.map(p => (
                    <React.Fragment key={p.id}>
                      <div data-space-dot={`${st.line} ${p.id}`} className="vb-space-rim" title="Drag from here to a line or an icon: it happens at this dot" style={{
                        position: 'absolute', left: p.x - st.left - 7, top: 44 - 7 - 1, width: 14, height: 14, borderRadius: '50%', boxSizing: 'border-box',
                        background: p.done ? AMBER : '#1c2125', border: `2px solid ${AMBER}`, cursor: 'crosshair',
                      }} />
                      <div style={{ position: 'absolute', left: p.x - st.left - 50, width: 100, top: 53, textAlign: 'center', fontSize: 10, color: p.done ? '#e4e9ea' : DIM,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{p.title}</div>
                    </React.Fragment>
                  ))}
                  <div style={{ position: 'absolute', left: st.knob - st.left - 6, top: 22, width: 12, height: 15, borderRadius: '3px 3px 6px 6px',
                    background: '#9fe0ff', border: '2px solid #12131f', boxSizing: 'border-box', pointerEvents: 'none' }} />
                </>}
              </div>
            ))}
            {d.items.map(i => <IconView key={i.id} item={i} picked={pick?.kind === 'item' && pick.id === i.id} aim={draw?.over === i.id} />)}
          </div>
          <Bar id={id} d={d} pick={pick} setPick={setPick} strips={strips} />
        </div>
      </ContentScaled>
    </div>
  )
}

const EMPTY = emptyStateSpace()
