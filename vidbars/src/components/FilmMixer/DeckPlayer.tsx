import React, { useEffect, useRef, useState } from 'react'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import type { DockedClip } from '../../utils/filmShots'

/** The mixer with a deck docked that it cannot mix yet: a MOCKUP of the mixer
 *  around the deck, so it can be seen as it will be worked on. The looks row,
 *  the colour bar of the film, the shot strip and the side panel of controls
 *  are laid out like the mixer's own; the picture plays the deck, shot after
 *  shot, each from its in point to its out point. The controls move, and a
 *  look can be given to a shot, but nothing is mixed, saved or processed:
 *  it all lives in this view and is gone when the deck is undocked.
 *
 *  Laid out at the mixer page's own size (PAGE_W × PAGE_H) and scaled like it. */

const W = 1240, H = 838
const ASIDE = 330

/** The mixer page's colours (mixer.html :root), so the mockup reads as it. */
const C = {
  bg: '#0f1113', panel: '#171a1d', panel2: '#1f2327', line: '#2a2f34', text: '#d8dde2', dim: '#8a939b', accent: '#e0703a', warn: '#e8b44a',
}

interface MockLook { name: string; colour: string }

/** Looks to show when the mixer has none to say (or is not up). */
const FALLBACK_LOOKS: MockLook[] = [
  { name: 'Light', colour: '#5fb3e8' }, { name: 'Medium', colour: '#e0a040' }, { name: 'Heavy', colour: '#d95f5f' },
  { name: 'Clean', colour: '#7fc98b' }, { name: 'Ink', colour: '#b58ae6' },
]

/** The mixer's own groups of controls, as its side panel lists them. */
const GROUPS: { group: string; items: { key: string; label: string; max: number; start: number }[] }[] = [
  { group: 'Background', items: [{ key: 'bg', label: 'lines', max: 2.5, start: 0.6 }, { key: 'bg_stipple', label: 'stipple', max: 2.5, start: 0 }, { key: 'bg_halftone', label: 'halftone', max: 2.5, start: 0 }] },
  { group: 'Figure shading', items: [{ key: 'hatch', label: 'lines', max: 2, start: 0.8 }, { key: 'hatch_stipple', label: 'stipple', max: 2, start: 0 }, { key: 'hatch_halftone', label: 'halftone', max: 2, start: 0 }] },
  { group: 'Figure outlines', items: [{ key: 'subject', label: 'outline', max: 1.5, start: 1 }, { key: 'interior', label: 'inside lines', max: 1.5, start: 0.6 }, { key: 'pencil', label: 'red pencil', max: 3, start: 1 }, { key: 'ink', label: 'ink', max: 3, start: 1 }] },
  { group: 'Line weight', items: [{ key: 'curve_bg', label: 'background', max: 4, start: 1 }, { key: 'curve_lines', label: 'outlines', max: 4, start: 1 }] },
]
const START: Record<string, number> = Object.fromEntries(GROUPS.flatMap(g => g.items.map(i => [i.key, i.start])))

const fmt = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${(s % 60 < 10 ? '0' : '') + (s % 60).toFixed(1)}` : '—')
const lenOf = (c: DockedClip) => (Number.isFinite(c.out) ? Math.max(0.1, c.out - c.in) : 4)

export function DeckPlayer({ clips, fit, width }: { clips: DockedClip[]; fit: number; width: number; height: number }) {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [looks, setLooks] = useState<MockLook[]>(FALLBACK_LOOKS)
  /** Mock state: the look given to each shot, and each shot's slider values. */
  const [lookOf, setLookOf] = useState<Record<string, string>>({})
  const [values, setValues] = useState<Record<string, Record<string, number>>>({})
  const i = Math.min(index, clips.length - 1)
  const clip = clips[i]

  useEffect(() => { if (index >= clips.length) { setIndex(0); setPlaying(false) } }, [index, clips.length])
  // The mixer's own looks, by name and colour, when it can say them.
  useEffect(() => {
    void window.vidbarsDesktop?.mixerCall?.('looks').then(l => {
      if (Array.isArray(l) && l.length) setLooks(l.slice(0, 14))
    })
  }, [])

  const next = () => {
    if (i + 1 < clips.length) { setIndex(i + 1); setTime(0) } else { setPlaying(false); setIndex(0); setTime(0) }
  }
  const go = (k: number) => { setIndex(k); setTime(0) }
  const stop = (e: React.PointerEvent) => e.stopPropagation()
  const colourOf = (name?: string) => looks.find(l => l.name === name)?.colour ?? '#3a4046'
  const total = clips.reduce((a, c) => a + lenOf(c), 0) || 1
  const current = clip ? lookOf[clip.key] : undefined
  const vals = clip ? { ...START, ...(values[clip.key] ?? {}) } : START
  const setVal = (key: string, v: number) => clip && setValues(s => ({ ...s, [clip.key]: { ...(s[clip.key] ?? {}), [key]: v } }))

  const btn: React.CSSProperties = {
    height: 26, padding: '0 10px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
    color: C.text, background: C.panel2, border: `1px solid ${C.line}`,
  }

  return (
    <div data-film-deck-player="" onPointerDown={stop} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: C.bg }}>
      <div style={{
        position: 'absolute', top: 0, left: (width - W * fit) / 2, width: W, height: H, transform: `scale(${fit})`, transformOrigin: '0 0',
        display: 'grid', gridTemplateColumns: `1fr ${ASIDE}px`, gridTemplateRows: 'auto auto 1fr', color: C.text,
        fontFamily: 'system-ui, sans-serif', fontSize: 13,
      }}>
        {/* ── Header ── */}
        <header style={{ gridColumn: '1 / 3', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', height: 43, boxSizing: 'border-box', borderBottom: `1px solid ${C.line}`, background: C.panel }}>
          <b style={{ fontSize: 14 }}>Look mixer</b><span style={{ color: C.dim }}>mockup</span>
          <span style={{ ...btn, display: 'inline-flex', alignItems: 'center' }}>setup <b style={{ marginLeft: 6 }}>Mockup</b></span>
          <span style={{ marginLeft: 'auto', color: C.warn, fontSize: 12, border: `1px solid ${C.warn}66`, borderRadius: 4, padding: '3px 8px' }}>
            plays the docked deck · nothing is mixed or saved
          </span>
        </header>

        {/* ── Looks, the film's colour bar, the strip ── */}
        <div style={{ gridColumn: '1 / 3', borderBottom: `1px solid ${C.line}`, background: C.panel, padding: '6px 12px 4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ color: C.dim, fontSize: 11, letterSpacing: '.08em', marginRight: 4 }}>LOOKS</span>
            {looks.map(l => (
              <button key={l.name} data-film-mock-look={l.name}
                title="Give this look to the shot on screen (mockup: nothing is saved)"
                onClick={() => clip && setLookOf(s => ({ ...s, [clip.key]: l.name }))}
                style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, border: `1px solid ${current === l.name ? '#fff' : C.line}` }}>
                <i style={{ width: 10, height: 10, borderRadius: 2, background: l.colour, display: 'inline-block' }} />{l.name}
              </button>
            ))}
          </div>
          {/* the deck as a film: a colour per look, each shot as long as it plays */}
          <div style={{ display: 'flex', height: 16, borderRadius: 3, overflow: 'hidden', background: C.panel2, marginBottom: 6 }}>
            {clips.map((c, k) => (
              <div key={c.key} onClick={() => go(k)} title={c.label} style={{
                width: `${(lenOf(c) / total) * 100}%`, cursor: 'pointer', boxSizing: 'border-box',
                background: lookOf[c.key] ? colourOf(lookOf[c.key]) : '#3a4046', borderRight: `1px solid ${C.bg}`,
                outline: k === i ? '2px solid #fff' : 'none', outlineOffset: -2,
              }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 4 }}>
            {clips.map((c, k) => <Tile key={c.key} clip={c} on={k === i} look={lookOf[c.key]} colour={colourOf(lookOf[c.key])} onClick={() => go(k)} />)}
          </div>
        </div>

        {/* ── The picture and its transport ── */}
        <section style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#0a0b0c' }}>
            {clip && <Shot key={clip.key} clip={clip} playing={playing} onTime={setTime} onEnd={next} />}
            {clip && (
              <div style={{ position: 'absolute', left: 10, top: 8, fontFamily: 'ui-monospace, monospace', fontSize: 12, textShadow: '0 1px 2px #000' }}>
                A · {clip.label}{current ? ` · ${current}` : ''}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderTop: `1px solid ${C.line}`, background: C.panel, fontVariantNumeric: 'tabular-nums' }}>
            <button style={btn} onClick={() => go(Math.max(0, i - 1))} title="The shot before">▲ shot</button>
            <button data-film-deck-play="" style={{ ...btn, width: 64 }} onClick={() => setPlaying(p => !p)}>{playing ? 'Pause' : 'Play'}</button>
            <button style={btn} onClick={() => { go(0); setPlaying(false) }} title="To the first shot">|◀</button>
            <button style={btn} onClick={() => go(Math.min(clips.length - 1, i + 1))} title="The shot after">shot ▼</button>
            <div style={{ flex: 1, height: 18, background: C.panel2, borderRadius: 3, position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${clip ? Math.min(100, (time / lenOf(clip)) * 100) : 0}%`, background: '#4a90c8' }} />
            </div>
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{clip?.label} · {fmt(Math.max(0, time))} / {fmt(clip ? lenOf(clip) : 0)}</span>
            <span style={{ color: C.dim, fontSize: 12 }}>{i + 1} / {clips.length}</span>
          </div>
        </section>

        {/* ── The side panel: the shot, and its controls (mock) ── */}
        <aside style={{ borderLeft: `1px solid ${C.line}`, background: C.panel, overflowY: 'auto', padding: '8px 12px', minHeight: 0 }}>
          <div style={{ color: C.dim, fontSize: 11, letterSpacing: '.08em' }}>SHOT <b style={{ color: C.text, letterSpacing: 0 }}>{clip?.label}</b></div>
          <div style={{ margin: '8px 0 10px', padding: 8, border: `1px solid ${C.line}`, borderRadius: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            <i style={{ width: 10, height: 10, borderRadius: 2, background: colourOf(current), display: 'inline-block' }} />
            <b>{current ?? 'no look yet'}</b>
            <span style={{ marginLeft: 'auto', color: C.dim, fontSize: 11 }}>mockup</span>
          </div>
          {GROUPS.map(g => (
            <div key={g.group} style={{ marginBottom: 10 }}>
              <div style={{ color: C.dim, fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', margin: '6px 0 4px' }}>{g.group}</div>
              {g.items.map(it => (
                <div key={it.key} style={{ display: 'grid', gridTemplateColumns: '1fr 48px 16px', gap: '2px 6px', alignItems: 'center', padding: '2px 0' }}>
                  <span style={{ gridColumn: '1 / 4' }}>{it.label}</span>
                  <input type="range" min={0} max={it.max} step={0.01} value={vals[it.key]}
                    onChange={e => setVal(it.key, Number(e.target.value))} style={{ accentColor: C.accent, width: '100%' }} />
                  <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, textAlign: 'right' }}>{vals[it.key].toFixed(2)}</span>
                  <span title="Back to where it started" onClick={() => setVal(it.key, it.start)} style={{ cursor: 'pointer', color: C.dim }}>↺</span>
                </div>
              ))}
            </div>
          ))}
        </aside>
      </div>
    </div>
  )
}

const Tile: React.FC<{ clip: DockedClip; on: boolean; look?: string; colour: string; onClick: () => void }> = ({ clip, on, look, colour, onClick }) => {
  const src = useResolvedMedia(clip.poster ?? (clip.kind === 'image' ? clip.url : null))
  return (
    <div data-film-deck-thumb={clip.label} onClick={onClick} title={clip.label} style={{
      width: 120, flexShrink: 0, cursor: 'pointer', borderRadius: 4, overflow: 'hidden', boxSizing: 'border-box',
      border: `2px solid ${on ? '#fff' : 'transparent'}`, background: C.panel2,
    }}>
      <div style={{ height: 62, background: src ? `#222 url("${src}") center / cover` : '#2a2c38' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 5px', fontSize: 11 }}>
        <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{clip.label}</b>
        <span style={{ color: C.dim, fontFamily: 'ui-monospace, monospace' }}>{fmt(lenOf(clip))}</span>
      </div>
      <div style={{ height: 4, background: look ? colour : 'transparent' }} />
    </div>
  )
}

/** One shot: a video from its in point to its out point, or a still held. */
const Shot: React.FC<{ clip: DockedClip; playing: boolean; onTime: (t: number) => void; onEnd: () => void }> = ({ clip, playing, onTime, onEnd }) => {
  const src = useResolvedMedia(clip.url)
  const video = useRef<HTMLVideoElement>(null)
  const ended = useRef(false)
  const done = () => { if (!ended.current) { ended.current = true; onEnd() } }

  // A still: the clock runs while playing.
  useEffect(() => {
    if (clip.kind !== 'image' || !playing) return
    const t0 = performance.now()
    let raf = 0
    const step = () => {
      const t = (performance.now() - t0) / 1000
      onTime(t)
      if (t >= clip.out - clip.in) { done(); return }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [clip, playing])

  // A video: start at its in point, stop at its out point.
  useEffect(() => {
    const v = video.current
    if (!v || clip.kind !== 'video') return
    if (playing) void v.play().catch(() => {})
    else v.pause()
  }, [clip, playing, src])

  if (!src) return null
  return clip.kind === 'video'
    ? <video
        ref={video}
        src={src}
        muted
        playsInline
        onLoadedMetadata={e => { e.currentTarget.currentTime = clip.in; if (playing) void e.currentTarget.play().catch(() => {}) }}
        onTimeUpdate={e => {
          const t = e.currentTarget.currentTime
          onTime(t - clip.in)
          if (t >= clip.out - 0.02) { e.currentTarget.pause(); done() }
        }}
        onEnded={done}
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      />
    : <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
}
