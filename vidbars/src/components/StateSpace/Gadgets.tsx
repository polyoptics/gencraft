// Gadgets — the faces of the state workspace's working parts (utils/stateSpace):
// a signal's scope, a calculation's readout, a switch, a selector, a counter,
// a timer, a dice and a meter. Each one shows what it is doing as it does it.
// They only draw: the hands are in StateSpaceBody (a part marked data-sp-poke
// is clicked there, one marked data-sp-knob is dragged there).

import React, { useEffect, useRef, useState } from 'react'
import {
  calcAsks, calcHi, calcLo, countFull, diceSides, genAmp, itemPorts, itemSize, meterHi, meterLo, shapeAt, timerLen, valOf,
  type CalcOp, type GenShape, type SpaceItem, type SpaceKind,
} from '../../utils/stateSpace'

const GREEN = '#5fa86c', BLUE = '#6fb7e0', AMBER = '#d9a441', VIOLET = '#b08cf0'
const DIM = 'rgba(255,255,255,0.45)', INK = '#e4e9ea'
const FONT = 'Inter, system-ui, sans-serif'
export const ZONE = ['#6f9fc0', GREEN, '#e07a5f']

export const GADGET_KINDS = new Set<SpaceKind>(['calc', 'gen', 'switch', 'dial', 'count', 'timer', 'dice', 'meter'])

export const SHAPE_WORD: Record<GenShape, string> = { pulse: 'pulse', wave: 'sine', square: 'square', ramp: 'saw', tri: 'triangle', noise: 'noise', draw: 'drawn' }
export const CALC_SIGN: Record<CalcOp, string> = { add: '+', sub: '−', mul: '×', div: '÷', min: 'min', max: 'max', avg: 'avg', gt: '>', lt: '<', ge: '≥', le: '≤', eq: '=', ne: '≠' }

/** The word beside each port of a gadget, by kind (a kind's own first, then any). */
const PORT_WORD: Record<string, string> = {
  'gen:in': 'run', 'gen:out': 'level', peak: 'top', cross: 'half',
  'switch:in': 'flip', on: 'on', off: 'off',
  'count:in': '+1', reset: 'reset', full: 'full',
  'timer:in': 'start', pause: 'pause', done: 'done', 'timer:out': 'on',
  next: 'next', prev: 'back',
  'z:2': 'high', 'z:1': 'mid', 'z:0': 'low',
}

/** Draw again about thirty times a second, for as long as `on`. */
function useFrames(on: boolean): void {
  const [, set] = useState(0)
  useEffect(() => {
    if (!on) return
    let raf = 0, last = 0
    const loop = (t: number) => { if (t - last > 32) { last = t; set(n => (n + 1) % 1e6) } raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [on])
}

const fmt = (v: number) => {
  const a = Math.abs(v)
  return String(a >= 100 ? Math.round(v) : a >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100)
}

export interface GadgetProps { item: SpaceItem; picked: boolean; stamp?: number; num?: number; aux?: [number, number]; says?: [string, string] }

const Ring: React.FC<{ stamp: number | undefined; radius: number | string; tone: string }> = ({ stamp, radius, tone }) =>
  stamp && Date.now() - stamp < 700
    ? <div key={stamp} style={{ position: 'absolute', inset: -3, borderRadius: radius, border: `2px solid ${tone}`, pointerEvents: 'none', animation: 'vbSpPulse .55s ease-out forwards' }} />
    : null

/** The little words beside a gadget's ports. */
const Tags: React.FC<{ item: SpaceItem; tone?: (port: string) => string | undefined }> = ({ item, tone }) => {
  const { w, h } = itemSize(item)
  return <>
    {itemPorts(item).map(p => {
      const word = PORT_WORD[item.kind + ':' + p.port] ?? PORT_WORD[p.port]
      if (!word) return null
      return <div key={p.port} style={{
        position: 'absolute', top: p.spot.y - (item.y - h / 2) - 6, height: 12, lineHeight: '12px', fontSize: 8, letterSpacing: '0.04em', pointerEvents: 'none',
        color: tone?.(p.port) ?? DIM, ...(p.out ? { right: 9, textAlign: 'right' as const } : { left: 9 }), maxWidth: w / 2,
      }}>{word}</div>
    })}
  </>
}

const boxOf = (item: SpaceItem): React.CSSProperties => {
  const { w, h } = itemSize(item)
  return { position: 'absolute', left: item.x - w / 2, top: item.y - h / 2, width: w, height: h, boxSizing: 'border-box', cursor: 'grab', userSelect: 'none', fontFamily: FONT, color: INK }
}
const ringOf = (picked: boolean, glow?: string) => [picked ? `0 0 0 2px ${BLUE}` : '', glow ?? ''].filter(Boolean).join(', ') || 'none'
const nameLine: React.CSSProperties = { fontSize: 9, letterSpacing: '0.08em', color: DIM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none' }

// ── Signal: a scope ──

const SCREEN_W = 100, SCREEN_H = 52, SPAN = 3

/** A small picture of a signal's shape. */
export const ShapeGlyph: React.FC<{ shape: GenShape; tone?: string; pts?: number[] }> = ({ shape, tone = AMBER, pts }) => {
  const d = shape === 'pulse' ? 'M1 12H6V2H9V12H19' : shape === 'ramp' ? 'M1 12L10 2V12L19 2' : shape === 'square' ? 'M1 12V2H6V12H11V2H16V12H19' : shape === 'tri' ? 'M1 12L5.500 2L10 12L14.500 2L19 12'
    : shape === 'noise' ? 'M1 8L3 4L5 10L7 3L9 9L11 6L13 11L15 2L17 7L19 5'
    : shape === 'draw' ? 'M1 12' + Array.from({ length: 10 }, (_, k) => `L${1 + k * 2} ${12 - 10 * (pts && pts.length > 1 ? pts[Math.floor(k / 10 * pts.length)] : shapeAt({ shape: 'draw' } as SpaceItem, k / 10))}`).join('')
    : 'M1 7C4 -1 7 -1 10 7S16 15 19 7'
  return <svg width="20" height="14" viewBox="0 0 20 14" style={{ flexShrink: 0, display: 'block' }}><path d={d} fill="none" stroke={tone} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg>
}

const Knob: React.FC<{ of: string; what: 'n' | 'amp'; value: number; title: string; top: number; left: number }> = ({ of, what, value, title, top, left }) => {
  // A quarter turn for each doubling, about straight up at 1.
  const turn = Math.max(-135, Math.min(135, Math.log2(Math.max(0.01, value)) * 45))
  return (
    <div data-sp-knob={what} data-sp-of={of} title={title} style={{
      position: 'absolute', left, top, width: 20, height: 20, borderRadius: '50%', boxSizing: 'border-box', cursor: 'ns-resize',
      background: 'radial-gradient(circle at 35% 30%, #5a4a22, #2a2314)', border: `1.5px solid ${AMBER}`,
    }}>
      <div style={{ position: 'absolute', left: 8, top: 1.500, width: 1.500, height: 7, borderRadius: 1, background: '#ffe2a0', transformOrigin: '0.75px 7.5px', transform: `rotate(${turn}deg)` }} />
    </div>
  )
}

const Scope: React.FC<GadgetProps> = ({ item, picked, stamp, aux }) => {
  const shape = item.shape ?? 'pulse'
  const len = Math.max(0.05, item.n ?? 1), amp = genAmp(item)
  const run = !item.off && aux?.[0] === 1
  const hist = useRef<{ t: number; v: number }[]>([])
  useFrames(true)
  const now = Date.now() / 1000
  const shot = valOf(item)
  let v = 0
  if (!item.off) {
    if (shape === 'pulse') v = (run && now % len < Math.min(0.12, len / 2)) || (!!stamp && Date.now() - stamp < 120) ? 1 : 0
    else if (shot > 0 && now >= shot && now - shot < len) v = shapeAt(item, (now - shot) / len)
    else if (run) v = shapeAt(item, now / len)
  }
  const h = hist.current
  h.push({ t: now, v })
  while (h.length && now - h[0].t > SPAN + 0.2) h.shift()
  const X = (t: number) => SCREEN_W - (now - t) / SPAN * SCREEN_W, Y = (l: number) => SCREEN_H - 5 - Math.max(0, Math.min(1, l)) * (SCREEN_H - 10)
  const trace = h.map((s, k) => `${k ? 'L' : 'M'}${X(s.t).toFixed(1)} ${Y(s.v).toFixed(1)}`).join('')
  const live = run || v > 0
  return (
    <div data-sp-node={item.id} className="vb-sp-node" title="Signal: runs in real time and shows what it gives out. Something true or not wired in runs it while it is true; something that happens wired in sends one round. Double-click to send one round now" style={{
      ...boxOf(item), borderRadius: 10, border: `2px solid ${live ? AMBER : 'rgba(217,164,65,0.4)'}`, background: '#221e14', boxShadow: ringOf(picked, live ? '0 0 14px rgba(217,164,65,0.28)' : ''),
    }}>
      <div style={{ position: 'absolute', left: 10, right: 10, top: 3, height: 14, display: 'flex', alignItems: 'center', gap: 5 }}>
        <ShapeGlyph shape={shape} pts={item.pts} />
        <div style={{ ...nameLine, flex: 1 }}>{(item.name || SHAPE_WORD[shape]).toUpperCase()}</div>
        <div style={{ ...nameLine, flexShrink: 0 }}>{fmt(len)}s{shape !== 'pulse' ? ` · ${fmt(amp)}` : ''}</div>
      </div>
      <svg width={SCREEN_W} height={SCREEN_H} style={{ position: 'absolute', left: 30, top: 21, borderRadius: 5, background: '#110f09', border: '1px solid rgba(217,164,65,0.25)', boxSizing: 'content-box', overflow: 'hidden' }}>
        {[0.25, 0.5, 0.75].map(f => <line key={f} x1={SCREEN_W * f} x2={SCREEN_W * f} y1={0} y2={SCREEN_H} stroke="rgba(217,164,65,0.09)" />)}
        <line x1={0} x2={SCREEN_W} y1={Y(0.5)} y2={Y(0.5)} stroke="rgba(217,164,65,0.22)" strokeDasharray="2 4" />
        <path d={trace} fill="none" stroke={AMBER} strokeWidth={4} strokeLinejoin="round" opacity={live ? 0.22 : 0.08} />
        <path d={trace} fill="none" stroke={live ? '#ffd27a' : 'rgba(217,164,65,0.7)'} strokeWidth={1.500} strokeLinejoin="round" />
        <circle cx={SCREEN_W - 2} cy={Y(v)} r={live ? 3 : 2} fill={live ? '#fff3d0' : 'rgba(217,164,65,0.5)'} />
      </svg>
      <Knob of={item.id} what="n" value={1 / len} title="Speed: drag up for faster, down for slower" left={137} top={22} />
      <Knob of={item.id} what="amp" value={amp} title="Height: drag up for higher, down for lower" left={137} top={50} />
      <Tags item={item} tone={p => p === 'peak' || p === 'cross' ? VIOLET : undefined} />
      <Ring stamp={stamp} radius={10} tone={AMBER} />
    </div>
  )
}

// ── Calculate: a readout ──

const Readout: React.FC<GadgetProps> = ({ item, picked, num, aux, says }) => {
  const op = item.calc ?? 'add', asks = calcAsks(op)
  const v = num ?? 0, a = aux?.[0] ?? 0, b = aux?.[1] ?? 0
  const sign = CALC_SIGN[op]
  const sum = op === 'min' || op === 'max' || op === 'avg' ? `${sign}(${fmt(a)}, ${fmt(b)})` : `${fmt(a)} ${sign} ${fmt(b)}`
  const names = op === 'min' || op === 'max' || op === 'avg' ? `${sign} of ${says?.[0] || 'a'}, ${says?.[1] || 'b'}` : `${says?.[0] || 'a'} ${sign} ${says?.[1] || 'b'}`
  const lo = calcLo(item), hi = calcHi(item)
  const fill = asks ? (v ? 1 : 0) : item.unit ? Math.max(0, Math.min(1, v)) : hi !== lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0
  const extras = [item.abs && 'abs', item.clamp && `${fmt(lo)}..${fmt(hi)}`, item.unit && '0..1', item.round && 'round', item.smooth && 'glide'].filter(Boolean).join(' · ')
  const yes = asks && v !== 0
  return (
    <div data-sp-node={item.id} className="vb-sp-node" title="Calculate: works a number out of what is wired into its two inputs, all the time, or asks whether one is greater than, less than or equal to the other. Any number of wires go into each input (they are added up). A wire out of it carries a compare, like a value's" style={{
      ...boxOf(item), borderRadius: 10, border: `2px solid ${v ? GREEN : 'rgba(95,168,108,0.45)'}`, background: yes ? '#274230' : '#1a251e', boxShadow: ringOf(picked, yes ? '0 0 14px rgba(95,168,108,0.45)' : ''),
    }}>
      <div style={{ ...nameLine, position: 'absolute', left: 14, right: 12, top: 5, letterSpacing: '0.03em' }}>{item.name || names}{extras ? <span style={{ color: 'rgba(95,168,108,0.9)' }}>{'  ' + extras}</span> : null}</div>
      <div style={{ position: 'absolute', left: 14, right: 12, top: 19, height: 26, display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 15, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'rgba(228,233,234,0.85)' }}>{sum}{asks ? '' : ' ='}</div>
        <div data-sp-val={item.id} style={{
          flexShrink: 0, minWidth: 40, height: 24, lineHeight: '24px', padding: '0 7px', boxSizing: 'border-box', borderRadius: 5, textAlign: 'center', fontSize: asks ? 13 : 17, fontWeight: 700, fontVariantNumeric: 'tabular-nums', letterSpacing: asks ? '0.06em' : 0,
          background: '#0f1612', border: `1px solid ${v ? GREEN : 'rgba(95,168,108,0.3)'}`, color: v ? '#c9f5d2' : 'rgba(228,233,234,0.6)', textShadow: v ? '0 0 8px rgba(95,168,108,0.8)' : 'none',
        }}>{asks ? (v ? 'YES' : 'NO') : fmt(v)}</div>
      </div>
      <div style={{ position: 'absolute', left: 14, right: 12, bottom: 6, height: 4, borderRadius: 2, background: 'rgba(95,168,108,0.16)', overflow: 'hidden' }}>
        <div style={{ width: `${fill * 100}%`, height: '100%', background: GREEN, borderRadius: 2, transition: 'width .12s linear' }} />
      </div>
    </div>
  )
}

// ── Switch ──

const Switch: React.FC<GadgetProps> = ({ item, picked, stamp }) => {
  const on = valOf(item) !== 0
  return (
    <div data-sp-node={item.id} data-sp-true={on ? '1' : '0'} className="vb-sp-node" title="Switch: on or off, and it stays that way. Click it to flip it. Wires in flip it, turn it on, or turn it off" style={{
      ...boxOf(item), borderRadius: 10, border: `2px solid ${on ? GREEN : 'rgba(95,168,108,0.45)'}`, background: on ? '#274230' : '#1a251e', boxShadow: ringOf(picked, on ? '0 0 14px rgba(95,168,108,0.5)' : ''),
    }}>
      <div style={{ ...nameLine, position: 'absolute', left: 34, right: 10, top: 5, textAlign: 'center' }}>{(item.name || 'switch').toUpperCase()}</div>
      <div data-sp-poke="in" data-sp-of={item.id} title="Click to flip" style={{
        position: 'absolute', left: 38, top: 23, width: 42, height: 22, borderRadius: 11, boxSizing: 'border-box', cursor: 'pointer',
        background: on ? 'rgba(95,168,108,0.55)' : '#0f1612', border: `1.5px solid ${on ? '#9fe0ad' : 'rgba(255,255,255,0.25)'}`, transition: 'background-color .15s,border-color .15s',
      }}>
        <div style={{ position: 'absolute', top: 2, left: on ? 22 : 2, width: 15, height: 15, borderRadius: '50%', background: on ? '#eafff0' : 'rgba(255,255,255,0.55)', boxShadow: on ? '0 0 8px #9fe0ad' : 'none', transition: 'left .15s' }} />
      </div>
      <Tags item={item} />
      <Ring stamp={stamp} radius={10} tone={GREEN} />
    </div>
  )
}

// ── Selector: a dial ──

const Dial: React.FC<GadgetProps> = ({ item, picked, stamp }) => {
  const opts = item.opts ?? []
  const at = Math.min(opts.length - 1, Math.max(0, Math.round(valOf(item))))
  const ang = (k: number) => opts.length > 1 ? -130 + 260 * k / (opts.length - 1) : 0
  const { h } = itemSize(item)
  const rowTop = (k: number) => itemPorts(item).find(p => p.port === 'pos:' + opts[k].id)!.spot.y - (item.y - h / 2) - 10
  return (
    <div data-sp-node={item.id} className="vb-sp-node" title="Selector: one of its positions is lit at a time. Click a position to turn to it. Wires in turn it on to the next, back, or straight to a position; each position has an output that is true while it is the one" style={{
      ...boxOf(item), borderRadius: 10, border: `2px solid ${GREEN}`, background: '#1a251e', boxShadow: ringOf(picked),
    }}>
      <svg width="38" height="38" viewBox="-19 -19 38 38" style={{ position: 'absolute', left: 38, top: 4 }}>
        {opts.map((o, k) => { const r = (ang(k) - 90) * Math.PI / 180; return <circle key={o.id} cx={Math.cos(r) * 16} cy={Math.sin(r) * 16} r={k === at ? 2.4 : 1.5} fill={k === at ? '#c9f5d2' : 'rgba(255,255,255,0.35)'} /> })}
        <circle r="11" fill="#0f1612" stroke={GREEN} strokeWidth="1.5" />
        <line x1="0" y1="0" x2="0" y2="-9" stroke="#c9f5d2" strokeWidth="2.2" strokeLinecap="round" style={{ transform: `rotate(${ang(at)}deg)`, transition: 'transform .18s' }} />
      </svg>
      <div style={{ ...nameLine, position: 'absolute', left: 82, right: 14, top: 9 }}>{(item.name || 'selector').toUpperCase()}</div>
      <div style={{ position: 'absolute', left: 82, right: 14, top: 22, fontSize: 12, fontWeight: 600, color: '#c9f5d2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{opts[at]?.name || (opts.length ? 'position ' + (at + 1) : '')}</div>
      {opts.map((o, k) => {
        const lit = k === at
        return <div key={o.id} data-sp-poke={'to:' + o.id} data-sp-of={item.id} className="vb-sp-chip" title="Click to turn to this position" style={{
          position: 'absolute', left: 14, right: 14, top: rowTop(k), height: 20, lineHeight: '18px', padding: '0 8px 0 22px', boxSizing: 'border-box', borderRadius: 5, fontSize: 11, cursor: 'pointer',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          background: lit ? 'rgba(95,168,108,0.35)' : 'rgba(255,255,255,0.05)', border: `1px solid ${lit ? GREEN : 'rgba(255,255,255,0.16)'}`, color: lit ? '#fff' : INK,
        }}>
          <div style={{ position: 'absolute', left: 7, top: 5, width: 8, height: 8, borderRadius: '50%', background: lit ? '#c9f5d2' : 'rgba(255,255,255,0.14)', boxShadow: lit ? '0 0 7px #9fe0ad' : 'none' }} />
          {o.name || 'position ' + (k + 1)}
        </div>
      })}
      <Tags item={item} />
      <Ring stamp={stamp} radius={10} tone={GREEN} />
    </div>
  )
}

// ── Counter ──

const Counter: React.FC<GadgetProps> = ({ item, picked, stamp }) => {
  const full = countFull(item), v = Math.max(0, Math.round(valOf(item)))
  const done = v >= full
  const room = 68, pip = full <= 12 ? Math.min(9, (room - (full - 1) * 3) / full) : 0
  return (
    <div data-sp-node={item.id} data-sp-true={v ? '1' : '0'} className="vb-sp-node" title="Counter: counts what reaches it, and fires when it is full. Click it to count one. A wire to reset empties it" style={{
      ...boxOf(item), borderRadius: 10, border: `2px solid ${done ? '#9fe0ad' : v ? GREEN : 'rgba(95,168,108,0.45)'}`, background: done ? '#274230' : '#1a251e', boxShadow: ringOf(picked, done ? '0 0 14px rgba(95,168,108,0.5)' : ''),
    }}>
      <div style={{ ...nameLine, position: 'absolute', left: 32, right: 32, top: 4, textAlign: 'center' }}>{(item.name || 'counter').toUpperCase()}</div>
      <div data-sp-poke="in" data-sp-of={item.id} title="Click to count one" style={{ position: 'absolute', left: 32, width: room, top: 18, height: 32, cursor: 'pointer' }}>
        <div style={{ height: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
          {pip ? Array.from({ length: full }, (_, k) => <div key={k} style={{ width: pip, height: pip, borderRadius: '50%', boxSizing: 'border-box', background: k < v ? '#c9f5d2' : 'transparent', border: `1px solid ${k < v ? '#c9f5d2' : 'rgba(255,255,255,0.3)'}`, boxShadow: k < v ? '0 0 5px #9fe0ad' : 'none' }} />)
            : <div style={{ width: room, height: 5, borderRadius: 3, background: 'rgba(95,168,108,0.18)', overflow: 'hidden' }}><div style={{ width: `${Math.min(1, v / full) * 100}%`, height: '100%', background: '#c9f5d2' }} /></div>}
        </div>
        <div data-sp-val={item.id} style={{ textAlign: 'center', fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: '18px', color: v ? '#c9f5d2' : 'rgba(228,233,234,0.6)' }}>{v}<span style={{ color: DIM, fontWeight: 400, fontSize: 11 }}> / {full}</span></div>
      </div>
      <Tags item={item} tone={p => p === 'full' ? VIOLET : undefined} />
      <Ring stamp={stamp} radius={10} tone={GREEN} />
    </div>
  )
}

// ── Timer ──

const Timer: React.FC<GadgetProps> = ({ item, picked, stamp }) => {
  const len = timerLen(item), v = valOf(item)
  const now = Date.now() / 1000
  const running = v > 0 && now - v < len, paused = v < 0
  useFrames(running)
  const left = running ? len - (now - v) : paused ? Math.max(0, len + v) : len
  const frac = Math.max(0, Math.min(1, left / len)), R = 17, C = 2 * Math.PI * R
  return (
    <div data-sp-node={item.id} data-sp-true={running ? '1' : '0'} className="vb-sp-node" title="Timer: counts down in real time. True while it runs, and fires when it is done. Click the ring to start it" style={{
      ...boxOf(item), borderRadius: 10, border: `2px solid ${running ? AMBER : 'rgba(217,164,65,0.45)'}`, background: '#221e14', boxShadow: ringOf(picked, running ? '0 0 14px rgba(217,164,65,0.35)' : ''),
    }}>
      <div style={{ ...nameLine, position: 'absolute', left: 36, right: 30, top: 3, textAlign: 'center' }}>{(item.name || 'timer').toUpperCase()}</div>
      <svg data-sp-poke="in" data-sp-of={item.id} width="44" height="44" viewBox="-22 -22 44 44" style={{ position: 'absolute', left: 37, top: 17, cursor: 'pointer' }}>
        <title>Click to start it from the top</title>
        <circle r={R} fill="#110f09" stroke="rgba(217,164,65,0.2)" strokeWidth="4" />
        <circle r={R} fill="none" stroke={running ? '#ffd27a' : paused ? AMBER : 'rgba(217,164,65,0.45)'} strokeWidth="4" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - frac)} transform="rotate(-90)" />
        <text data-sp-val={item.id} y="4" textAnchor="middle" fontSize="11" fontWeight="700" fontFamily={FONT} fill={running ? '#fff3d0' : 'rgba(228,233,234,0.7)'} style={{ fontVariantNumeric: 'tabular-nums' }}>{left >= 10 ? Math.ceil(left) : left.toFixed(1)}</text>
      </svg>
      <Tags item={item} tone={p => p === 'done' ? VIOLET : undefined} />
      <Ring stamp={stamp} radius={10} tone={AMBER} />
    </div>
  )
}

// ── Dice ──

const PIPS: Record<number, [number, number][]> = {
  1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
}
const Dice: React.FC<GadgetProps> = ({ item, picked, stamp }) => {
  const sides = diceSides(item), v = Math.round(valOf(item))
  const since = stamp ? Date.now() - stamp : 1e9
  const rolling = since < 420
  useFrames(rolling)
  // While it tumbles it shows other faces; it lands on its own.
  const face = rolling ? 1 + Math.floor(Date.now() / 60) % sides : v
  const turn = rolling ? (1 - since / 420) * 300 : 0
  return (
    <div data-sp-node={item.id} className="vb-sp-node" title="Dice: rolls a number from 1 to its sides when something reaches it, and fires when it has rolled. Click it to roll. As a timeline plays it falls the same way every time" style={{
      ...boxOf(item), borderRadius: 10, border: `2px solid ${VIOLET}`, background: '#241f31', boxShadow: ringOf(picked),
    }}>
      <div style={{ ...nameLine, position: 'absolute', left: 6, right: 6, top: 3, textAlign: 'center' }}>{(item.name || `1 to ${sides}`).toUpperCase()}</div>
      <svg data-sp-poke="in" data-sp-of={item.id} width="40" height="40" viewBox="-20 -20 40 40" style={{ position: 'absolute', left: 13, top: 19, cursor: 'pointer', transform: `rotate(${turn}deg) scale(${rolling ? 0.86 : 1})` }}>
        <title>Click to roll</title>
        <rect x="-17" y="-17" width="34" height="34" rx="7" fill={face ? '#efe9ff' : '#3a3352'} stroke={VIOLET} strokeWidth="1.5" />
        {face > 0 && sides <= 6 ? PIPS[face].map(([x, y], k) => <circle key={k} cx={x * 9} cy={y * 9} r="3.200" fill="#3b2a66" />)
          : <text data-sp-val={item.id} y="6" textAnchor="middle" fontSize="17" fontWeight="700" fontFamily={FONT} fill={face ? '#3b2a66' : 'rgba(255,255,255,0.5)'}>{face || '?'}</text>}
      </svg>
      <Ring stamp={stamp} radius={10} tone={VIOLET} />
    </div>
  )
}

// ── Meter ──

/** The span a meter's gauge shows, about its two marks. */
export function meterSpan(item: SpaceItem): [number, number] {
  const lo = Math.min(meterLo(item), meterHi(item)), hi = Math.max(meterLo(item), meterHi(item))
  const gap = Math.max(hi - lo, 0.001)
  const from = lo >= 0 && lo <= gap * 2 ? 0 : lo - gap
  return [from, hi + Math.max(gap * 0.75, lo - from > gap ? gap : lo - from)]
}
const Meter: React.FC<GadgetProps> = ({ item, picked, num }) => {
  const v = num ?? 0, lo = Math.min(meterLo(item), meterHi(item)), hi = Math.max(meterLo(item), meterHi(item))
  const [from, to] = meterSpan(item)
  const f = (x: number) => Math.max(0, Math.min(1, (x - from) / (to - from)))
  const zone = v < meterLo(item) ? 0 : v < meterHi(item) ? 1 : 2
  const R = 32, pt = (t: number, r = R) => { const a = Math.PI * (1 - t); return `${(Math.cos(a) * r).toFixed(2)} ${(-Math.sin(a) * r).toFixed(2)}` }
  const arc = (a: number, b: number) => `M${pt(a)}A${R} ${R} 0 0 1 ${pt(b)}`
  const cuts = [0, f(lo), f(hi), 1]
  return (
    <div data-sp-node={item.id} className="vb-sp-node" title="Meter: shows the number wired into it against two marks. Each of its three zones has an output that is true while the needle is in it" style={{
      ...boxOf(item), borderRadius: 10, border: `2px solid ${ZONE[zone]}`, background: '#1a2026', boxShadow: ringOf(picked, `0 0 12px ${ZONE[zone]}55`),
    }}>
      <div style={{ ...nameLine, position: 'absolute', left: 10, width: 60, top: 3 }}>{(item.name || 'meter').toUpperCase()}</div>
      <svg width="76" height="44" viewBox="-38 -37 76 44" style={{ position: 'absolute', left: 26, top: 9 }}>
        {[0, 1, 2].map(z => cuts[z + 1] > cuts[z] && <path key={z} d={arc(cuts[z], cuts[z + 1])} fill="none" stroke={ZONE[z]} strokeWidth={z === zone ? 6 : 4} opacity={z === zone ? 1 : 0.4} />)}
        <line x1="0" y1="0" x2={pt(f(v), R - 6).split(' ')[0]} y2={pt(f(v), R - 6).split(' ')[1]} stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        <circle r="3.500" fill="#fff" />
      </svg>
      <div data-sp-val={item.id} style={{ position: 'absolute', left: 98, width: 26, top: 22, textAlign: 'center', fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: ZONE[zone] }}>{fmt(v)}</div>
      <Tags item={item} tone={p => p.startsWith('z:') ? ZONE[+p.slice(2)] : undefined} />
    </div>
  )
}

export const GadgetView: React.FC<GadgetProps> = p =>
  p.item.kind === 'gen' ? <Scope {...p} /> : p.item.kind === 'calc' ? <Readout {...p} /> : p.item.kind === 'switch' ? <Switch {...p} /> : p.item.kind === 'dial' ? <Dial {...p} />
    : p.item.kind === 'count' ? <Counter {...p} /> : p.item.kind === 'timer' ? <Timer {...p} /> : p.item.kind === 'dice' ? <Dice {...p} /> : <Meter {...p} />

// ── Draw your own shape ──

/** A pad to draw one round of a signal on, by dragging across it. */
export const DrawPad: React.FC<{ pts: number[] | undefined; live: boolean; onChange: (pts: number[], first: boolean) => void }> = ({ pts, live, onChange }) => {
  const N = 32, W = 220, H = 70
  const cur = pts && pts.length === N ? pts : Array.from({ length: N }, (_, k) => shapeAt({ shape: 'wave' } as SpaceItem, k / N))
  const ref = useRef<SVGSVGElement>(null)
  const down = (e: React.PointerEvent) => {
    if (!live) return
    e.stopPropagation()
    let next = [...cur], last = -1, first = true
    const put = (ev: { clientX: number; clientY: number }) => {
      const r = ref.current!.getBoundingClientRect()
      const k = Math.max(0, Math.min(N - 1, Math.floor((ev.clientX - r.left) / r.width * N)))
      const v = Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height))
      next = [...next]
      // Every step passed over since the last, so that a quick stroke leaves no gaps.
      const a = last < 0 ? k : Math.min(last, k), b = last < 0 ? k : Math.max(last, k)
      for (let j = a; j <= b; j++) next[j] = v
      last = k
      onChange(next, first)
      first = false
    }
    put(e)
    const move = (ev: PointerEvent) => put(ev)
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <svg ref={ref} data-sp-pad="" width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerDown={down} style={{
      flexShrink: 0, borderRadius: 5, background: '#110f09', border: `1px solid ${live ? AMBER : 'rgba(217,164,65,0.25)'}`, cursor: live ? 'crosshair' : 'default', opacity: live ? 1 : 0.35, touchAction: 'none',
    }}>
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="rgba(217,164,65,0.22)" strokeDasharray="2 4" />
      <path d={cur.map((v, k) => `${k ? 'L' : 'M'}${(k + 0.5) / N * W} ${H - 4 - v * (H - 8)}`).join('')} fill="none" stroke="#ffd27a" strokeWidth={1.800} strokeLinejoin="round" />
    </svg>
  )
}
