// CutMonitor — plays a Rough Cut card: its clips one after another, with
// their trims, and the sound on its audio lane under them. Whichever view of
// the card is on screen (its face, or its timeline at block zoom) mounts one,
// and that one runs the card's playhead (utils/cutMedia useCutPlay).
//
// Each clip near the playhead has its own <video>, so the next one is loaded
// and waiting at its in point before the cut reaches it: cuts land on time
// instead of stalling while a new file opens.

import React, { useEffect, useRef } from 'react'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { clipAtTime, clipLen, cutTotal, type CutAudio, type CutClip } from '../../utils/cutCard'
import { useCutPlay } from '../../utils/cutMedia'

/** A frame to show instead of the playhead's: an edge being trimmed. */
export interface MonitorPeek { clip: CutClip; local: number }

export const CutMonitor: React.FC<{
  cardId: string
  clips: CutClip[]
  audio?: CutAudio[]
  muted: boolean
  peek?: MonitorPeek | null
  fit?: 'contain' | 'cover'
  radius?: number
}> = ({ cardId, clips, audio = [], muted, peek, fit = 'contain', radius = 0 }) => {
  const t = useCutPlay(s => s.t[cardId] ?? 0)
  const playing = useCutPlay(s => s.playing === cardId)
  const total = cutTotal(clips)
  const at = clipAtTime(clips, Math.min(t, Math.max(0, total - 1e-3)))
  const videos = useRef(new Map<string, HTMLVideoElement>())
  const sounds = useRef(new Map<string, HTMLAudioElement>())
  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const audioRef = useRef(audio)
  audioRef.current = audio

  // The clock: while playing, the active video sets the time (so picture and
  // playhead never drift); a still, or a video still loading, runs on the
  // wall clock / holds.
  useEffect(() => {
    if (!playing) return
    let last = performance.now(), raf = 0, held = 0
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const st = useCutPlay.getState()
      const cs = clipsRef.current
      const tot = cutTotal(cs)
      const cur = st.t[cardId] ?? 0
      const a = clipAtTime(cs, cur)
      let next = cur + dt
      if (a?.clip.kind === 'video') {
        const v = videos.current.get(a.clip.boardId)
        if (v && v.readyState >= 2 && !v.seeking) {
          if (v.paused) void v.play().catch(() => {})
          const vt = a.start + (v.currentTime - a.clip.in)
          // Follow the video, unless it is still at its in point: then step.
          next = Math.abs(vt - cur) < 0.25 ? Math.max(cur, vt) : cur + dt
          if (v.currentTime >= a.clip.out - 0.02) next = Math.max(next, a.start + clipLen(a.clip))
          held = 0
        } else {
          // Loading: hold, but not forever (a file that will not play).
          held += dt
          next = held < 1.5 ? cur : cur + dt
        }
      }
      if (next >= tot) { st.setT(cardId, tot); st.setPlaying(null); return }
      st.setT(cardId, next)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, cardId])

  // Every nearby video: the active one plays (or shows its frame), the
  // others wait at their in point.
  const shown = peek ?? (at ? { clip: at.clip, local: at.local } : null)
  useEffect(() => {
    for (const [id, v] of videos.current) {
      const c = clips.find(x => x.boardId === id)
      if (!c) continue
      if (shown && c.boardId === shown.clip.boardId) {
        const want = shown.local
        if (playing && !peek) {
          if (Math.abs(v.currentTime - want) > 0.3) v.currentTime = want
          if (v.paused) void v.play().catch(() => {})
        } else {
          if (!v.paused) v.pause()
          if (Math.abs(v.currentTime - want) > 0.02) v.currentTime = want
        }
      } else {
        if (!v.paused) v.pause()
        if (Math.abs(v.currentTime - c.in) > 0.05 && !v.seeking) v.currentTime = c.in
      }
    }
  })

  // The audio lane follows the playhead.
  useEffect(() => {
    for (const [id, el] of sounds.current) {
      const a = audio.find(x => x.id === id)
      if (!a) continue
      const len = Math.max(0, a.out - a.in)
      const inside = t >= a.start && t < a.start + len
      if (playing && inside && !peek) {
        const want = a.in + (t - a.start)
        if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want
        if (el.paused) void el.play().catch(() => {})
      } else if (!el.paused) el.pause()
    }
  })

  // Near the playhead: the clip on screen, the one before and two after.
  const idx = shown ? clips.findIndex(c => c.boardId === shown.clip.boardId) : 0
  const near = clips.filter((c, i) => c.kind === 'video' && i >= idx - 1 && i <= idx + 2)
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#000', overflow: 'hidden', borderRadius: radius }}>
      {near.map(c => (
        <ClipVideo
          key={c.boardId} clip={c} visible={!!shown && shown.clip.boardId === c.boardId} muted={muted} fit={fit}
          bind={el => { if (el) videos.current.set(c.boardId, el); else videos.current.delete(c.boardId) }}
        />
      ))}
      {shown?.clip.kind === 'image' && <ClipImage clip={shown.clip} fit={fit} />}
      {audio.map(a => (
        <ClipAudio key={a.id} a={a} muted={muted} bind={el => { if (el) sounds.current.set(a.id, el); else sounds.current.delete(a.id) }} />
      ))}
      {!clips.length && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'rgba(255,255,255,0.35)', fontSize: 18 }}>
          No clips yet
        </div>
      )}
    </div>
  )
}

const ClipVideo: React.FC<{ clip: CutClip; visible: boolean; muted: boolean; fit: string; bind: (el: HTMLVideoElement | null) => void }> = ({ clip, visible, muted, fit, bind }) => {
  const src = useResolvedMedia(clip.media.url)
  return (
    <video
      ref={bind}
      src={src ?? undefined}
      muted={muted}
      playsInline
      preload="auto"
      poster={clip.media.posterUrl}
      onLoadedMetadata={e => { e.currentTarget.currentTime = clip.in }}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit as 'contain',
        visibility: visible ? 'visible' : 'hidden',
      }}
    />
  )
}

const ClipImage: React.FC<{ clip: CutClip; fit: string }> = ({ clip, fit }) => {
  const src = useResolvedMedia(clip.media.url)
  return src ? <img src={src} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit as 'contain' }} /> : null
}

const ClipAudio: React.FC<{ a: CutAudio; muted: boolean; bind: (el: HTMLAudioElement | null) => void }> = ({ a, muted, bind }) => {
  const src = useResolvedMedia(a.url)
  return <audio ref={bind} src={src ?? undefined} muted={muted} preload="auto" />
}
