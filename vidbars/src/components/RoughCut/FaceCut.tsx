// FaceCut — a Rough Cut card's face: it plays the cut. Resting, the pointer
// scrubs through the whole cut, left edge to right; ▶ plays it, clip after
// clip with their trims. Along the bottom, the clips as a bar, each as long
// as it is in the cut, so even zoomed out you see the shape of the edit.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { CUT_ASPECT, clipLen, cutClips, cutTotal, layoutCutCard } from '../../utils/cutCard'
import { useCutPlay } from '../../utils/cutMedia'
import { CutMonitor } from './CutMonitor'

export const FaceCut: React.FC<{ group: ProjectGroup; scale: number }> = ({ group, scale }) => {
  const boards = useBoardsStore(s => s.boards)
  const clips = useMemo(() => cutClips(group, boards), [group, boards])
  const total = cutTotal(clips)
  const t = useCutPlay(s => s.t[group.id] ?? 0)
  const playing = useCutPlay(s => s.playing === group.id)
  const [muted, setMuted] = useState(true)
  const host = useRef<HTMLDivElement>(null)
  // The buttons and bar size with the face itself, so they stay readable
  // however far out the canvas is zoomed (the card is wide, not a small face).
  const [faceW, setFaceW] = useState(0)
  useEffect(() => {
    const el = host.current
    if (!el) return
    const ro = new ResizeObserver(() => setFaceW(el.getBoundingClientRect().width))
    ro.observe(el)
    setFaceW(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])
  // A frame out of shape (a width lost to an older resize): mend it.
  useEffect(() => {
    if (group.cardWidthOverride == null || Math.abs((group.cardHeightOverride ?? 0) - group.cardWidthOverride * CUT_ASPECT) > 1) layoutCutCard(group.id)
  }, [group.id, group.cardWidthOverride, group.cardHeightOverride])
  const k = faceW ? Math.max(1, Math.min(2.4, faceW / 300)) : Math.max(1, scale)

  const play = (on: boolean) => {
    const st = useCutPlay.getState()
    if (!on) { st.setPlaying(null); return }
    if ((st.t[group.id] ?? 0) >= total - 0.02) st.setT(group.id, 0)
    st.setPlaying(group.id)
  }

  // Hover-scrub while not playing: across the face is across the cut.
  useEffect(() => {
    const face = host.current?.parentElement
    if (!face) return
    const move = (e: PointerEvent) => {
      if (useCutPlay.getState().playing === group.id || e.buttons || !total) return
      if ((e.target as Element).closest('[data-face-cut-chrome]')) return
      const r = face.getBoundingClientRect()
      useCutPlay.getState().setT(group.id, Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))) * total)
    }
    face.addEventListener('pointermove', move)
    return () => face.removeEventListener('pointermove', move)
  }, [group.id, total])

  // Space, while this card is the one selected.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const a = document.activeElement as HTMLElement | null
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return
      const sel = useBoardsStore.getState().selectedGroupIds
      if (sel.length !== 1 || sel[0] !== group.id || useFreeNodeStore.getState().selectedIds.length) return
      e.preventDefault()
      play(useCutPlay.getState().playing !== group.id)
    }
    window.addEventListener('keyup', onKey)
    return () => window.removeEventListener('keyup', onKey)
  })

  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  const btn = (s: number): React.CSSProperties => ({
    width: s, height: s, padding: 0, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.35)',
    background: 'rgba(12,13,20,0.6)', color: 'rgba(255,255,255,0.92)', fontSize: s * 0.5, lineHeight: 1,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit',
  })
  const barH = 7 * k
  let a = 0
  return (
    <div ref={host} data-face-cut={group.id} style={{ position: 'absolute', inset: 0, borderRadius: 12, overflow: 'hidden' }}>
      <CutMonitor cardId={group.id} clips={clips} audio={group.cut?.audio} muted={muted} fit="cover" radius={12} />
      {!clips.length && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'rgba(255,255,255,0.45)', fontSize: 13 * k, background: '#1b1d27' }}>
          Rough Cut · drop cards on it
        </div>
      )}
      {clips.length > 0 && (
        <>
          <div data-face-cut-chrome="" style={{ position: 'absolute', zIndex: 3, right: 6 * k, bottom: barH + 8 * k, display: 'flex', gap: 4 * k }}>
            <button type="button" title="Play the cut (Space)" onPointerDown={stop} onDoubleClick={stop}
              onClick={e => { e.stopPropagation(); play(!playing) }} style={btn(22 * k)}>{playing ? '❚❚' : '▶'}</button>
            <button type="button" title="Sound on or off" onPointerDown={stop} onDoubleClick={stop}
              onClick={e => { e.stopPropagation(); setMuted(m => !m) }} style={btn(18 * k)}>{muted ? '🔇' : '🔊'}</button>
          </div>
          {/* The cut's shape: one segment per clip, the played part lit. */}
          <div data-face-cut-chrome="" style={{ position: 'absolute', zIndex: 3, left: 0, right: 0, bottom: 0, height: barH, display: 'flex', background: 'rgba(0,0,0,0.5)' }}>
            {clips.map((c, i) => {
              const s = a
              a += clipLen(c)
              const lit = Math.max(0, Math.min(1, (t - s) / clipLen(c)))
              return (
                <div key={c.boardId} style={{ flex: `${clipLen(c)} 0 0`, position: 'relative', borderRight: i < clips.length - 1 ? `${Math.max(1, k)}px solid rgba(0,0,0,0.85)` : undefined, background: i % 2 ? 'rgba(255,179,92,0.35)' : 'rgba(255,179,92,0.22)' }}>
                  <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${lit * 100}%`, background: 'rgba(255,200,140,0.95)' }} />
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
