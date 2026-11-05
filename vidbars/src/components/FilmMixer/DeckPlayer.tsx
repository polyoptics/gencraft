import React, { useEffect, useRef, useState } from 'react'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import type { DockedClip } from '../../utils/filmShots'

/** The mixer with a deck docked that it cannot mix yet: it plays the deck, shot
 *  after shot in the deck's order, each from its in point to its out point, to
 *  see the sequence as a whole. Nothing is mixed or baked. Laid out in the
 *  mixer page's own units (fit scales it), so it sits where the page would. */
export function DeckPlayer({ clips, fit, width, height }: { clips: DockedClip[]; fit: number; width: number; height: number }) {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const i = Math.min(index, clips.length - 1)
  const clip = clips[i]
  useEffect(() => { if (index >= clips.length) { setIndex(0); setPlaying(false) } }, [index, clips.length])

  const next = () => {
    if (i + 1 < clips.length) { setIndex(i + 1); setTime(0) } else { setPlaying(false); setIndex(0); setTime(0) }
  }
  const go = (k: number) => { setIndex(k); setTime(0) }
  const stop = (e: React.PointerEvent) => e.stopPropagation()
  const u = (n: number) => n * fit * 1.6
  const btn: React.CSSProperties = {
    height: u(26), padding: `0 ${u(12)}px`, borderRadius: u(6), cursor: 'pointer', fontFamily: 'inherit', fontSize: u(13),
    fontWeight: 600, color: 'rgba(255,255,255,0.85)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.16)',
  }
  const len = clip ? clip.out - clip.in : 0
  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60 < 10 ? '0' : '') + (s % 60).toFixed(1)}`
  const stripH = u(64)

  return (
    <div data-film-deck-player="" onPointerDown={stop} style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#0c0d12', color: '#fff',
      width, height,
    }}>
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#000' }}>
        {clip && <Shot key={clip.key} clip={clip} playing={playing} onTime={setTime} onEnd={next} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: u(8), padding: `${u(6)}px ${u(10)}px`, fontSize: u(13), fontVariantNumeric: 'tabular-nums' }}>
        <button data-film-deck-play="" style={{ ...btn, width: u(70) }} onClick={() => setPlaying(p => !p)}>{playing ? 'Pause' : 'Play'}</button>
        <button style={btn} title="To the first shot" onClick={() => { go(0); setPlaying(false) }}>⏮</button>
        <span style={{ color: 'rgba(255,255,255,0.6)' }}>{i + 1} / {clips.length}</span>
        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{clip?.label}</span>
        <span style={{ marginLeft: 'auto', color: 'rgba(255,255,255,0.6)' }}>{fmt(Math.max(0, time))} / {Number.isFinite(len) ? fmt(len) : '—'}</span>
        <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: u(11) }}>playing the docked deck · not mixed</span>
      </div>
      <div style={{ height: stripH, display: 'flex', gap: u(4), padding: `0 ${u(10)}px ${u(8)}px`, overflowX: 'auto', flexShrink: 0 }}>
        {clips.map((c, k) => <Thumb key={c.key} clip={c} on={k === i} h={stripH - u(8)} onClick={() => go(k)} />)}
      </div>
    </div>
  )
}

const Thumb: React.FC<{ clip: DockedClip; on: boolean; h: number; onClick: () => void }> = ({ clip, on, h, onClick }) => {
  const src = useResolvedMedia(clip.poster ?? (clip.kind === 'image' ? clip.url : null))
  return (
    <div data-film-deck-thumb={clip.label} onClick={onClick} title={clip.label} style={{
      height: h, aspectRatio: '16 / 9', flexShrink: 0, borderRadius: 4, cursor: 'pointer', boxSizing: 'border-box',
      background: src ? `#222 url("${src}") center / cover` : '#2a2c38', border: `2px solid ${on ? '#fff' : 'transparent'}`,
      opacity: on ? 1 : 0.7,
    }} />
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
