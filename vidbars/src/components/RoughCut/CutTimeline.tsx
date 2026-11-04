// CutTimeline — a Rough Cut card at block zoom: its blocks are the clips of
// the cut, laid end to end, each as wide as it is long. Drawn over the card's
// frame on the canvas, at one design size scaled to the frame, so it reads the
// same at every zoom and the card never changes shape.
//
// Two drags do the editing: a clip's EDGE trims it (the rest of the cut
// closes up behind it), its MIDDLE carries it to another place in the cut
// (the others slide aside to make room), or, carried off the card, out of the
// cut as a card of its own, trims and all. Cards let go over the timeline go
// into the cut where they are let go.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import {
  addNote, clipAtTime, CUT_ASPECT, cutCardSize, layoutCutCard, clipLen, cutClips, cutTotal, fmtTime, insertCards, MIN_CLIP, pullOutDeck, removeClip, removeNote,
  reorderClips, setClipRange, setCut, setNoteText, splitClip, type CutAudio, type CutClip,
} from '../../utils/cutCard'
import { extractBlockToCard, cardFaceSize, layoutCardGrid } from '../../utils/cardGrid'
import { useCutPlay, useFilmstrip, useWaveform } from '../../utils/cutMedia'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { clientToCanvas } from '../../utils/fx/createEffect'
import { cardScreenRect } from '../Layers/CardLayer'
import { getMediaItems } from '../../types/bar'
import { CutMonitor, type MonitorPeek } from './CutMonitor'

/** The design: laid out at this size, then scaled to the card's frame. */
export const DW = 1200
const PAD = 18
const TOP_H = 400
const RULER_H = 28
const TRACK_TOP = TOP_H + RULER_H + 8
const TRACK_H = 140
const AUDIO_TOP = TRACK_TOP + TRACK_H + 14
const AUDIO_H = 76
const EDGE = 16
/** Within this many screen px a trim snaps to the playhead or a cut. */
const SNAP_PX = 9
const PPS_MIN = 4, PPS_MAX = 900

const ACCENT = '#ffb35c'
const NOTE = '#e8b04a'

type Drag =
  | { kind: 'trim'; boardId: string; side: 'in' | 'out' }
  | { kind: 'move'; boardId: string; x: number; y: number; gx: number; insertAt: number; out: boolean }
  | null

export const CutTimeline: React.FC<{ group: ProjectGroup }> = ({ group }) => {
  const boards = useBoardsStore(s => s.boards)
  const stored = useMemo(() => cutClips(group, boards), [group, boards])
  /** A trim in flight: drawn from this, written once on release. */
  const [live, setLive] = useState<CutClip[] | null>(null)
  const clips = live ?? stored
  const audio = group.cut?.audio ?? []
  const total = cutTotal(clips)
  const W = group.cardWidthOverride ?? cutCardSize().w
  const H = W * CUT_ASPECT
  // A frame out of shape (a width lost to an older resize): mend it.
  useEffect(() => {
    if (group.cardWidthOverride == null || Math.abs((group.cardHeightOverride ?? 0) - group.cardWidthOverride * CUT_ASPECT) > 1) layoutCutCard(group.id)
  }, [group.id, group.cardWidthOverride, group.cardHeightOverride])
  const DH = DW * (H / W)
  const k = W / DW

  const t = useCutPlay(s => s.t[group.id] ?? 0)
  const playing = useCutPlay(s => s.playing === group.id)
  const setT = useCallback((v: number) => useCutPlay.getState().setT(group.id, Math.max(0, v)), [group.id])
  const [selected, setSelected] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag>(null)
  const [peek, setPeek] = useState<MonitorPeek | null>(null)
  const [muted, setMuted] = useState(false)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [scroll, setScroll] = useState(0)
  const root = useRef<HTMLDivElement>(null)

  // The row's zoom: fitted to the frame unless zoomed by hand (pps > 0).
  const rowW = DW - PAD * 2
  const fitPps = total > 0 ? rowW / total : 60
  const pps = group.cut?.pps && group.cut.pps > 0 ? group.cut.pps : fitPps
  const fitted = !(group.cut?.pps && group.cut.pps > 0)
  const maxScroll = Math.max(0, total * pps - rowW)
  const sx = Math.min(scroll, maxScroll)
  const xOf = (time: number) => PAD + time * pps - sx

  const starts = useMemo(() => {
    let a = 0
    return clips.map(c => { const s = a; a += clipLen(c); return s })
  }, [clips])

  /** Screen px per design px, measured now (the canvas may have zoomed). */
  const scale = () => {
    const r = root.current?.getBoundingClientRect()
    return r && root.current ? r.width / DW : k * useCanvasStore.getState().zoom
  }
  const timeAtClient = (clientX: number) => {
    const r = root.current!.getBoundingClientRect()
    return ((clientX - r.left) / scale() - PAD + sx) / pps
  }

  useEffect(() => { if (t > total) setT(total) }, [t, total, setT])

  // ── Trim: an edge drag; everything after it rides along ──
  const startTrim = (e: React.PointerEvent, boardId: string, side: 'in' | 'out') => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    useCutPlay.getState().setPlaying(null)
    const index = stored.findIndex(c => c.boardId === boardId)
    const c0 = stored[index]
    if (!c0) return
    const s = scale()
    const x0 = e.clientX
    const clipStart = starts[index]
    // Snap targets, in cut time: the playhead and every other cut point.
    const targets = [t, ...starts, total]
    let next = stored
    setSelected(boardId)
    setDrag({ kind: 'trim', boardId, side })
    const move = (m: PointerEvent) => {
      let dt = (m.clientX - x0) / s / pps
      const snapT = SNAP_PX / s / pps
      if (side === 'out') {
        const end = clipStart + clipLen(c0) + dt
        const hit = targets.find(x => Math.abs(x - end) < snapT && Math.abs(x - (clipStart + clipLen(c0))) > 1e-3)
        if (hit !== undefined && !m.altKey) dt = hit - (clipStart + clipLen(c0))
      } else {
        // An in point moves the clip's start in its source; in the cut its
        // left edge stays put and the rest closes up, so snap its length.
        const hit = targets.find(x => Math.abs(x - (clipStart + clipLen(c0) - dt)) < snapT && Math.abs(dt) > 1e-3)
        if (hit !== undefined && !m.altKey) dt = clipStart + clipLen(c0) - hit
      }
      const c = side === 'in'
        ? { ...c0, in: Math.max(0, Math.min(c0.out - MIN_CLIP, c0.in + dt)) }
        : { ...c0, out: Math.max(c0.in + MIN_CLIP, Math.min(c0.full, c0.out + dt)) }
      next = stored.map(x => (x.boardId === boardId ? c : x))
      setLive(next)
      setPeek({ clip: c, local: side === 'in' ? c.in : Math.max(c.in, c.out - 1 / 30) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      setPeek(null)
      const c = next.find(x => x.boardId === boardId)
      if (c && (c.in !== c0.in || c.out !== c0.out)) setClipRange(boardId, c.in, c.out)
      setLive(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ── Move: a middle drag carries the clip; the others make room ──
  const startMove = (e: React.PointerEvent, boardId: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const index = stored.findIndex(c => c.boardId === boardId)
    const c0 = stored[index]
    if (!c0) return
    const s = scale()
    const r0 = root.current!.getBoundingClientRect()
    const x0 = e.clientX, y0 = e.clientY
    const grabT = timeAtClient(e.clientX) - starts[index]
    let moved = false, insertAt = index, out = false
    const others = stored.filter(c => c.boardId !== boardId)
    const move = (m: PointerEvent) => {
      if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return
      if (!moved) { moved = true; useCutPlay.getState().setPlaying(null) }
      // Off the card (well clear of its frame): it leaves the cut.
      const r = root.current!.getBoundingClientRect()
      const margin = 30
      out = m.clientY < r.top - margin || m.clientY > r.bottom + margin || m.clientX < r.left - margin || m.clientX > r.right + margin
      // Its new place: the gap nearest its left edge, among the others.
      const at = timeAtClient(m.clientX) - grabT + clipLen(c0) / 2
      let gap = others.length, a = 0
      for (let i = 0; i < others.length; i++) {
        const len = clipLen(others[i])
        if (at < a + len / 2) { gap = i; break }
        a += len
      }
      insertAt = gap
      setDrag({ kind: 'move', boardId, x: (m.clientX - r0.left) / s, y: (m.clientY - y0) / s, gx: grabT * pps, insertAt, out })
    }
    const up = (m: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      if (!moved) {
        // A click: select it, and the playhead goes where it was clicked.
        setSelected(boardId)
        const at = Math.max(0, Math.min(clipLen(c0) - 1e-3, timeAtClient(m.clientX) - starts[index]))
        setT(starts[index] + at)
        return
      }
      if (out) {
        // Out of the cut as a card of its own, where it was let go.
        const p = clientToCanvas(m.clientX, m.clientY)
        const face = cardFaceSize()
        useUndoCoordinator.getState().checkpoint()
        const id = extractBlockToCard(boardId, { x: p.cx - face.w / 2 - 20, y: p.cy - face.h / 2 })
        if (id) {
          useBoardsStore.setState(st => ({
            groups: st.groups.map(g => g.id === id ? { ...g, layout: 'grid' as const, cardWidthOverride: face.w, cardHeightOverride: face.h, cut: undefined } : g),
          }))
          layoutCardGrid(id)
          layoutCardGrid(group.id)
        }
        return
      }
      const order = others.map(c => c.boardId)
      order.splice(insertAt, 0, boardId)
      if (order.join() !== stored.map(c => c.boardId).join()) reorderClips(group.id, order)
      setSelected(boardId)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ── Resize: the corner grip, keeping the card's shape ──
  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    useUndoCoordinator.getState().checkpoint()
    const x0 = e.clientX, y0 = e.clientY
    const w0 = W, aspect = CUT_ASPECT
    const move = (m: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      // Along the diagonal: whichever way the pointer went further.
      const d = Math.max((m.clientX - x0) / z, (m.clientY - y0) / z / aspect)
      const w = Math.max(w0 * 0.25, Math.min(w0 * 6, w0 + d))
      useBoardsStore.getState().setGroupCardSize(group.id, w, w * aspect)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      layoutCardGrid(group.id)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ── The ruler and empty track: put the playhead there ──
  const startScrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    useCutPlay.getState().setPlaying(null)
    const at = (x: number) => Math.max(0, Math.min(total, timeAtClient(x)))
    setT(at(e.clientX))
    const move = (m: PointerEvent) => setT(at(m.clientX))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ── Wheel: Ctrl zooms the row about the pointer, Shift scrolls it. A
  //    plain wheel is the canvas's (zooming between Cards, Blocks, Boards). ──
  useEffect(() => {
    const el = root.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.shiftKey)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.shiftKey && !e.ctrlKey) {
        setScroll(v => Math.max(0, Math.min(maxScroll, v + (e.deltaY || e.deltaX) / Math.max(0.2, scale()))))
        return
      }
      const r = el.getBoundingClientRect()
      const px = (e.clientX - r.left) / scale() - PAD
      const atT = (px + sx) / pps
      const nextPps = Math.max(PPS_MIN, Math.min(PPS_MAX, pps * (e.deltaY < 0 ? 1.18 : 1 / 1.18)))
      if (nextPps <= fitPps * 1.001) { setCut(group.id, { pps: 0 }); setScroll(0); return }
      setCut(group.id, { pps: nextPps })
      setScroll(Math.max(0, atT * nextPps - px))
    }
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
  })

  // Keep the playhead in view while playing.
  useEffect(() => {
    if (!playing || fitted) return
    const x = t * pps - sx
    if (x > rowW * 0.9 || x < 0) setScroll(Math.max(0, Math.min(maxScroll, t * pps - rowW * 0.1)))
  }, [t, playing, fitted, pps, sx, rowW, maxScroll])

  // ── Keys, while the pointer is over this timeline ──
  const hover = useRef(false)
  const stateRef = useRef({ t, clips: stored, selected, total })
  stateRef.current = { t, clips: stored, selected, total }
  useEffect(() => {
    const typing = () => {
      const a = document.activeElement as HTMLElement | null
      return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)
    }
    const onKey = (e: KeyboardEvent) => {
      if (!hover.current || typing() || e.ctrlKey || e.metaKey) return
      const { t: now, clips: cs, selected: sel, total: tot } = stateRef.current
      const at = clipAtTime(cs, Math.min(now, Math.max(0, tot - 1e-3)))
      const key = e.key.toLowerCase()
      if (e.code === 'Space') {
        e.preventDefault()
        e.stopPropagation()
        togglePlay()
      } else if (key === 's' && at) {
        e.preventDefault()
        splitClip(at.clip.boardId, at.local)
      } else if ((key === 'i' || key === 'o') && at) {
        // Trim the clip under the playhead to it: I its in, O its out.
        e.preventDefault()
        if (key === 'i') setClipRange(at.clip.boardId, Math.min(at.local, at.clip.out - MIN_CLIP), at.clip.out)
        else setClipRange(at.clip.boardId, at.clip.in, Math.max(at.local, at.clip.in + MIN_CLIP))
        if (key === 'i') setT(at.start)
      } else if (key === 'n' && at) {
        e.preventDefault()
        const id = addNote(at.clip.boardId, at.local, '')
        if (id) setEditingNote(id)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault()
        e.stopPropagation()
        removeClip(sel)
        setSelected(null)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        const step = e.shiftKey ? 1 : 1 / 30
        setT(Math.max(0, Math.min(tot, now + (e.key === 'ArrowLeft' ? -step : step))))
      } else if (e.key === 'Home') setT(0)
      else if (e.key === 'End') setT(tot)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const togglePlay = () => {
    const st = useCutPlay.getState()
    if (st.playing === group.id) { st.setPlaying(null); return }
    if ((st.t[group.id] ?? 0) >= total - 0.02) st.setT(group.id, 0)
    st.setPlaying(group.id)
  }
  // Leaving block zoom (this unmounts) stops nothing: the face plays on.

  // ── Cards let go over the timeline join the cut there ──
  useCardDropsIntoCut(group, root, (clientX: number | null) => {
    if (clientX === null) { setDropAt(null); return null }
    const at = timeAtClient(clientX)
    let gap = stored.length
    for (let i = 0; i < stored.length; i++) if (at < starts[i] + clipLen(stored[i]) / 2) { gap = i; break }
    setDropAt(gap)
    return gap
  })

  const [editingNote, setEditingNote] = useState<string | null>(null)
  const at = clipAtTime(clips, Math.min(t, Math.max(0, total - 1e-3)))
  const cur = at?.clip ?? null
  const infoClip = drag?.kind === 'trim' ? clips.find(c => c.boardId === drag.boardId) ?? cur : cur

  // Where every clip is drawn: in place, or slid aside for one being moved.
  const layout = useMemo(() => {
    const out = new Map<string, number>()
    if (drag?.kind === 'move' && !drag.out) {
      const moving = clips.find(c => c.boardId === drag.boardId)
      let a = 0, i = 0
      for (const c of clips) {
        if (c.boardId === drag.boardId) continue
        if (i === drag.insertAt && moving) a += clipLen(moving)
        out.set(c.boardId, a)
        a += clipLen(c)
        i++
      }
    } else if (dropAt !== null) {
      // Room opens where dropped cards will go.
      let a = 0
      clips.forEach((c, i) => { if (i === dropAt) a += Math.min(2, total * 0.15 || 2); out.set(c.boardId, a); a += clipLen(c) })
    } else {
      clips.forEach((c, i) => out.set(c.boardId, starts[i]))
    }
    return out
  }, [clips, drag, starts, dropAt, total])

  const btn = (on = false): React.CSSProperties => ({
    height: 40, minWidth: 40, padding: '0 16px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit', fontSize: 17,
    fontWeight: 600, color: on ? '#16171f' : 'rgba(255,255,255,0.88)',
    background: on ? ACCENT : 'rgba(255,255,255,0.08)', border: `1px solid ${on ? ACCENT : 'rgba(255,255,255,0.16)'}`,
  })
  const stop = (e: React.PointerEvent) => { if (e.button === 0) e.stopPropagation() }
  const monW = 640, monH = TOP_H - PAD * 2

  return (
    <div
      ref={root}
      data-cut-timeline={group.id}
      onPointerEnter={() => { hover.current = true }}
      onPointerLeave={() => { hover.current = false }}
      style={{
        position: 'absolute', left: group.originX + 20, top: group.originY, width: DW, height: DH,
        transform: `scale(${k})`, transformOrigin: '0 0', color: '#fff', fontSize: 16, userSelect: 'none',
      }}
    >
      <div style={{
        position: 'absolute', inset: 0, background: '#14151c', borderRadius: 18, border: '2px solid rgba(255,255,255,0.1)',
        boxSizing: 'border-box', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
      }}>
      {/* ── Monitor and controls ── */}
      <div style={{ position: 'absolute', left: PAD, top: PAD, width: monW, height: monH, borderRadius: 12, overflow: 'hidden' }}>
        <CutMonitor cardId={group.id} clips={clips} audio={audio} muted={muted} peek={peek} radius={12} />
        <div style={{
          position: 'absolute', left: 14, bottom: 12, padding: '4px 10px', borderRadius: 6, background: 'rgba(0,0,0,0.6)',
          fontVariantNumeric: 'tabular-nums', fontSize: 18, fontWeight: 600, pointerEvents: 'none',
        }}>
          {peek ? `${drag?.kind === 'trim' && drag.side === 'in' ? 'IN' : 'OUT'} ${fmtTime(peek.local)}` : `${fmtTime(t)} / ${fmtTime(total)}`}
        </div>
      </div>
      <div onPointerDown={stop} style={{ position: 'absolute', left: PAD * 2 + monW, top: PAD, right: PAD, height: monH, display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span style={{ fontSize: 30, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{group.name || 'Rough Cut'}</span>
          <span style={{ color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums', fontSize: 18, whiteSpace: 'nowrap' }}>
            {clips.length} {clips.length === 1 ? 'clip' : 'clips'} · {fmtTime(total)}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button data-cut-play="" style={{ ...btn(playing), width: 96 }} disabled={!clips.length} onClick={togglePlay}>Play</button>
          <button style={btn()} onClick={() => { useCutPlay.getState().setPlaying(null); setT(0) }} title="To the start (Home)">⏮</button>
          <button style={btn(!muted)} onClick={() => setMuted(m => !m)} title="Sound on or off">Sound</button>
          <span style={{ flex: 1 }} />
          <button style={btn()} disabled={!cur} title="Cut the clip in two at the playhead (S)"
            onClick={() => { if (at) splitClip(at.clip.boardId, at.local) }}>Split</button>
          <button style={btn()} disabled={!cur} title="Add a note at the playhead (N)"
            onClick={() => { if (at) { const id = addNote(at.clip.boardId, at.local, ''); if (id) setEditingNote(id) } }}>Note</button>
        </div>
        {/* What is under the playhead (or being trimmed) */}
        {infoClip && (
          <div style={{ color: 'rgba(255,255,255,0.7)', lineHeight: 1.55, fontVariantNumeric: 'tabular-nums', fontSize: 16 }}>
            <div style={{ fontSize: 20, color: '#fff', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{infoClip.label}</div>
            <div>in {fmtTime(infoClip.in)} · out {fmtTime(infoClip.out)} · {fmtTime(clipLen(infoClip))}{infoClip.kind === 'video' ? ` of ${fmtTime(infoClip.full)}` : ' still'}</div>
          </div>
        )}
        {/* Its notes: kept on the node layer, under the clip's bar */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(infoClip?.notes ?? []).map(n => (
            <NoteRow key={n.barId} note={n} boardId={infoClip!.boardId} editing={editingNote === n.barId}
              onEdit={on => setEditingNote(on ? n.barId : null)}
              onGo={() => { const i = clips.findIndex(c => c.boardId === infoClip!.boardId); if (i >= 0) setT(starts[i] + (n.t - clips[i].in)) }}
            />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button data-cut-pull="" style={{ ...btn(), flex: 1 }} disabled={!clips.length}
            title="Make a deck of the clips as they are cut: one card per clip, trims and notes kept"
            onClick={() => pullOutDeck(group.id)}>Pull out as deck</button>
        </div>
      </div>

      {/* ── Ruler ── */}
      <div data-cut-ruler="" onPointerDown={startScrub} style={{ position: 'absolute', left: 0, right: 0, top: TOP_H, height: RULER_H, cursor: 'text', background: 'rgba(255,255,255,0.035)', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <Ruler pps={pps} from={sx} width={rowW} />
      </div>

      {/* ── The picture track: the clips ── */}
      <div data-cut-track="" onPointerDown={startScrub} style={{ position: 'absolute', left: 0, right: 0, top: TRACK_TOP, height: TRACK_H }}>
        {clips.map(c => {
          if (drag?.kind === 'move' && drag.boardId === c.boardId) return null
          const x = xOf(layout.get(c.boardId) ?? 0)
          return (
            <ClipBlock
              key={c.boardId} clip={c} pps={pps}
              x={x} w={clipLen(c) * pps}
              lifted={null}
              selected={selected === c.boardId}
              trimming={drag?.kind === 'trim' && drag.boardId === c.boardId ? drag.side : null}
              animate={drag?.kind === 'move' || dropAt !== null}
              onMove={e => startMove(e, c.boardId)}
              onTrimIn={e => startTrim(e, c.boardId, 'in')}
              onTrimOut={e => startTrim(e, c.boardId, 'out')}
              onRemove={() => { removeClip(c.boardId); if (selected === c.boardId) setSelected(null) }}
            />
          )
        })}
        {drag?.kind === 'move' && !drag.out && (
          <div style={{
            position: 'absolute', top: -6, height: TRACK_H + 12, width: 5, borderRadius: 3, background: ACCENT,
            left: xOf((() => { let a = 0, i = 0; for (const c of clips) { if (c.boardId === drag.boardId) continue; if (i === drag.insertAt) break; a += clipLen(c); i++ } return a })()) - 3,
            boxShadow: `0 0 14px ${ACCENT}`, pointerEvents: 'none',
          }} />
        )}
        {dropAt !== null && (
          <div style={{ position: 'absolute', top: -6, height: TRACK_H + 12, width: 5, borderRadius: 3, background: '#6fb3ff', left: xOf(dropAt < starts.length ? starts[dropAt] : total) - 3, boxShadow: '0 0 14px #6fb3ff', pointerEvents: 'none' }} />
        )}
        {!clips.length && (
          <div style={{ position: 'absolute', left: PAD, top: 0, height: TRACK_H, right: PAD, borderRadius: 12, border: '2px dashed rgba(255,255,255,0.18)', display: 'grid', placeItems: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 22 }}>
            Drop cards here to cut them together
          </div>
        )}
      </div>

      {/* ── The sound lane ── */}
      <AudioLane group={group} audio={audio} pps={pps} xOf={xOf} top={AUDIO_TOP} onScrub={startScrub} scale={scale} />

      {/* ── Playhead ── */}
      {clips.length > 0 && (
        <div style={{ position: 'absolute', top: TOP_H, height: AUDIO_TOP + AUDIO_H - TOP_H + 6, left: xOf(Math.min(t, total)) - 1, width: 3, background: '#ff5a4f', pointerEvents: 'none', zIndex: 20 }}>
          <div style={{ position: 'absolute', top: 0, left: -8, width: 19, height: 14, background: '#ff5a4f', borderRadius: '3px 3px 9px 9px' }} />
        </div>
      )}

      {/* ── Footer ── */}
      <div onPointerDown={stop} style={{ position: 'absolute', left: PAD, right: PAD, top: AUDIO_TOP + AUDIO_H + 16, display: 'flex', alignItems: 'center', gap: 10, color: 'rgba(255,255,255,0.42)', fontSize: 15 }}>
        <button style={btn(fitted)} onClick={() => { setCut(group.id, { pps: 0 }); setScroll(0) }} title="Fit the whole cut in the row">Fit</button>
        <button style={btn()} onClick={() => { setCut(group.id, { pps: Math.min(PPS_MAX, pps * 1.5) }); setScroll(Math.max(0, t * pps * 1.5 - rowW / 2)) }} title="Zoom the row in (Ctrl+wheel)">+</button>
        <button style={btn()} onClick={() => { const n = pps / 1.5; if (n <= fitPps) { setCut(group.id, { pps: 0 }); setScroll(0) } else setCut(group.id, { pps: n }) }} title="Zoom the row out (Ctrl+wheel)">−</button>
        <span style={{ marginLeft: 10, lineHeight: 1.35 }}>
          Edge: trim · Middle: move, or off the card to take it out · Drop cards in · Space play · S split · I / O trim to playhead · N note
        </span>
      </div>
      </div>
      {/* Resize: the corner grip scales the whole Rough Cut, keeping its shape. */}
      <div
        data-cut-resize=""
        title="Drag to make the Rough Cut bigger or smaller"
        onPointerDown={startResize}
        style={{
          position: 'absolute', right: -6, bottom: -6, width: 44, height: 44, cursor: 'nwse-resize', zIndex: 45,
          borderRadius: '0 0 18px 0', display: 'grid', placeItems: 'center',
        }}
      >
        <svg width="26" height="26" viewBox="0 0 26 26" style={{ pointerEvents: 'none' }}>
          <path d="M24 8 L8 24 M24 15 L15 24 M24 22 L22 24" stroke="rgba(255,255,255,0.7)" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </div>
      {/* The clip being carried: over everything, and off the card too. */}
      {drag?.kind === 'move' && (() => {
        const c = clips.find(x => x.boardId === drag.boardId)
        return c ? (
          <div style={{ position: 'absolute', left: 0, top: TRACK_TOP, width: 0, height: 0, zIndex: 40 }}>
            <ClipBlock clip={c} pps={pps} x={0} w={clipLen(c) * pps} lifted={{ x: drag.x - drag.gx, y: drag.y, out: drag.out }}
              selected={false} trimming={null} animate={false} onMove={() => {}} onTrimIn={() => {}} onTrimOut={() => {}} onRemove={() => {}} />
          </div>
        ) : null
      })()}
    </div>
  )
}

const Ruler: React.FC<{ pps: number; from: number; width: number }> = ({ pps, from, width }) => {
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find(s => s * pps >= 90) ?? 300
  const ticks: number[] = []
  for (let s = Math.floor(from / pps / step) * step; s * pps - from < width + 1; s += step) ticks.push(s)
  return (
    <>
      {ticks.map(s => (
        <div key={s} style={{
          position: 'absolute', left: PAD + s * pps - from, top: 0, height: RULER_H, borderLeft: '1px solid rgba(255,255,255,0.25)',
          paddingLeft: 5, fontSize: 14, lineHeight: `${RULER_H}px`, color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums', pointerEvents: 'none',
        }}>{fmtTime(s)}</div>
      ))}
    </>
  )
}

/** One clip in the cut: a strip of its own frames, from its in point to its
 *  out point, with handles at both edges. */
const ClipBlock: React.FC<{
  clip: CutClip; pps: number; x: number; w: number; selected: boolean
  lifted: { x: number; y: number; out: boolean } | null
  trimming: 'in' | 'out' | null
  animate: boolean
  onMove: (e: React.PointerEvent) => void
  onTrimIn: (e: React.PointerEvent) => void
  onTrimOut: (e: React.PointerEvent) => void
  onRemove: () => void
}> = ({ clip, pps, x, w, selected, lifted, trimming, animate, onMove, onTrimIn, onTrimOut, onRemove }) => {
  const [hover, setHover] = useState(false)
  const strip = useFilmstrip(clip.kind === 'video' ? clip.media.url : null)
  const still = useResolvedMedia(clip.kind === 'image' ? clip.media.url : clip.media.posterUrl ?? null)
  const h = TRACK_H
  const tileW = h * 16 / 9 * 0.62
  // Frames along the clip: each tile shows the source frame at its time.
  const tiles = useMemo(() => {
    const n = Math.max(1, Math.ceil(w / tileW))
    return Array.from({ length: n }, (_, i) => {
      const local = clip.in + ((i + 0.5) * tileW / pps)
      if (strip?.frames.length) {
        const fi = Math.max(0, Math.min(strip.frames.length - 1, Math.floor((local / strip.duration) * strip.frames.length)))
        return strip.frames[fi]
      }
      return still ?? null
    })
  }, [w, tileW, clip.in, pps, strip, still])
  const edgeOn = hover || trimming
  const border = selected ? '#ffffff' : lifted ? ACCENT : 'rgba(255,255,255,0.22)'
  const style: React.CSSProperties = lifted
    ? {
        position: 'absolute', left: lifted.x, top: lifted.y, width: Math.max(8, w - 4), height: h,
        transform: `rotate(${lifted.out ? -3 : -0.8}deg) scale(${lifted.out ? 0.9 : 1.04})`, zIndex: 30,
        boxShadow: '0 24px 48px rgba(0,0,0,0.6)', opacity: lifted.out ? 0.85 : 1, cursor: 'grabbing',
      }
    : {
        position: 'absolute', left: x, top: 0, width: Math.max(6, w - 4), height: h,
        transition: animate ? 'left 160ms cubic-bezier(.2,.8,.2,1)' : undefined, cursor: 'grab',
      }
  return (
    <div
      data-cut-clip={clip.label}
      data-cut-board={clip.boardId}
      onPointerDown={onMove}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{ ...style, borderRadius: 10, overflow: 'hidden', boxSizing: 'border-box', border: `3px solid ${border}`, background: '#23252f' }}
    >
      <div style={{ position: 'absolute', inset: 0, display: 'flex', pointerEvents: 'none' }}>
        {tiles.map((src, i) => (
          <div key={i} style={{ width: tileW, flexShrink: 0, height: '100%', background: src ? `#000 url("${src}") center / cover` : '#2a2c38', borderRight: '1px solid rgba(0,0,0,0.5)' }} />
        ))}
      </div>
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 0, padding: '6px 12px', fontSize: 16, fontWeight: 650,
        background: 'linear-gradient(rgba(0,0,0,0.78), rgba(0,0,0,0))', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none',
      }}>{clip.label}</div>
      <div style={{ position: 'absolute', left: 12, bottom: 8, fontSize: 15, color: 'rgba(255,255,255,0.92)', textShadow: '0 1px 3px #000', fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' }}>
        {fmtTime(clipLen(clip))}
      </div>
      {/* Notes: a flag at each one's time */}
      {clip.notes.map(n => (
        <div key={n.barId} title={n.text} style={{
          position: 'absolute', bottom: 0, left: ((n.t - clip.in) / clipLen(clip)) * w - 2, width: 4, height: 34, background: NOTE, pointerEvents: 'none',
        }}><div style={{ position: 'absolute', left: 4, top: 0, width: 14, height: 11, background: NOTE, clipPath: 'polygon(0 0, 100% 50%, 0 100%)' }} /></div>
      ))}
      {hover && !lifted && w > 90 && (
        <button
          title="Take this clip out of the cut"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onRemove() }}
          style={{ position: 'absolute', right: EDGE + 6, top: 6, width: 28, height: 28, borderRadius: 14, border: 'none', cursor: 'pointer', background: 'rgba(0,0,0,0.65)', color: '#fff', fontSize: 18, lineHeight: '28px', padding: 0 }}
        >×</button>
      )}
      {/* Trim handles: wide enough to find, lit when near */}
      <div data-cut-trim="in" onPointerDown={onTrimIn} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: EDGE, cursor: 'ew-resize', background: edgeOn ? (trimming === 'in' ? ACCENT : `${ACCENT}aa`) : 'transparent', borderRadius: '6px 0 0 6px' }} />
      <div data-cut-trim="out" onPointerDown={onTrimOut} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: EDGE, cursor: 'ew-resize', background: edgeOn ? (trimming === 'out' ? ACCENT : `${ACCENT}aa`) : 'transparent', borderRadius: '0 6px 6px 0' }} />
    </div>
  )
}

const NoteRow: React.FC<{ note: { barId: string; t: number; text: string }; boardId: string; editing: boolean; onEdit: (on: boolean) => void; onGo: () => void }> = ({ note, boardId, editing, onEdit, onGo }) => {
  const [val, setVal] = useState(note.text)
  useEffect(() => setVal(note.text), [note.text])
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 8, background: 'rgba(232,176,74,0.1)', borderLeft: `4px solid ${NOTE}` }}>
      <button onClick={onGo} title="Go to this note" style={{ background: 'none', border: 'none', color: NOTE, fontFamily: 'inherit', fontSize: 15, fontWeight: 700, cursor: 'pointer', padding: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtTime(note.t)}</button>
      {editing ? (
        <textarea
          autoFocus value={val} rows={2} placeholder="Note…"
          onChange={e => setVal(e.target.value)}
          onBlur={() => { if (val !== note.text) setNoteText(boardId, note.barId, val); onEdit(false) }}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() } if (e.key === 'Escape') { setVal(note.text); onEdit(false) } }}
          style={{ flex: 1, background: 'rgba(0,0,0,0.35)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, fontFamily: 'inherit', fontSize: 15, padding: 6, resize: 'none' }}
        />
      ) : (
        <div onDoubleClick={() => onEdit(true)} onClick={() => onEdit(true)} style={{ flex: 1, fontSize: 15, color: note.text ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.4)', cursor: 'text', whiteSpace: 'pre-wrap' }}>
          {note.text || 'Write a note…'}
        </div>
      )}
      <button onClick={() => removeNote(boardId, note.barId)} title="Delete this note" style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.45)', cursor: 'pointer', fontSize: 16, padding: 0 }}>×</button>
    </div>
  )
}

/** The sound under the picture: audio cards let go here join it at the
 *  time they are let go; a sound moves by its middle and trims by its edges. */
const AudioLane: React.FC<{
  group: ProjectGroup; audio: CutAudio[]; pps: number; xOf: (t: number) => number; top: number
  onScrub: (e: React.PointerEvent) => void; scale: () => number
}> = ({ group, audio, pps, xOf, top, onScrub, scale }) => {
  const [live, setLive] = useState<CutAudio[] | null>(null)
  const shown = live ?? audio
  const startDrag = (e: React.PointerEvent, id: string, mode: 'move' | 'in' | 'out') => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const s = scale()
    const x0 = e.clientX
    const a0 = audio.find(a => a.id === id)!
    let next = audio
    const move = (m: PointerEvent) => {
      const dt = (m.clientX - x0) / s / pps
      const a = mode === 'move' ? { ...a0, start: Math.max(0, a0.start + dt) }
        : mode === 'in' ? (() => { const d = Math.max(-a0.in, Math.min(a0.out - a0.in - MIN_CLIP, dt)); return { ...a0, in: a0.in + d, start: Math.max(0, a0.start + d) } })()
        : { ...a0, out: Math.max(a0.in + MIN_CLIP, Math.min(a0.full, a0.out + dt)) }
      next = audio.map(x => (x.id === id ? a : x))
      setLive(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setLive(null)
      if (next !== audio) setCut(group.id, { audio: next }, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div data-cut-audio="" onPointerDown={onScrub} style={{ position: 'absolute', left: 0, right: 0, top, height: AUDIO_H, background: 'rgba(255,255,255,0.025)', borderTop: '1px solid rgba(255,255,255,0.06)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      {!shown.length && (
        <div style={{ position: 'absolute', left: PAD, top: 0, height: AUDIO_H, display: 'flex', alignItems: 'center', color: 'rgba(255,255,255,0.32)', fontSize: 16, pointerEvents: 'none' }}>
          ♪ Drop a sound card here for music or sound under the picture
        </div>
      )}
      {shown.map(a => (
        <AudioClip key={a.id} a={a} x={xOf(a.start)} w={(a.out - a.in) * pps} pps={pps}
          onMove={e => startDrag(e, a.id, 'move')} onIn={e => startDrag(e, a.id, 'in')} onOut={e => startDrag(e, a.id, 'out')}
          onRemove={() => setCut(group.id, { audio: audio.filter(x => x.id !== a.id) }, true)}
        />
      ))}
    </div>
  )
}

const AudioClip: React.FC<{ a: CutAudio; x: number; w: number; pps: number; onMove: (e: React.PointerEvent) => void; onIn: (e: React.PointerEvent) => void; onOut: (e: React.PointerEvent) => void; onRemove: () => void }> = ({ a, x, w, pps, onMove, onIn, onOut, onRemove }) => {
  const wave = useWaveform(a.url)
  const [hover, setHover] = useState(false)
  const path = useMemo(() => {
    if (!wave) return ''
    const n = Math.max(2, Math.min(800, Math.round(w / 3)))
    const hh = (AUDIO_H - 12) / 2
    let d = ''
    for (let i = 0; i < n; i++) {
      const tt = a.in + (i / (n - 1)) * (a.out - a.in)
      const pi = Math.min(wave.peaks.length - 1, Math.floor((tt / wave.duration) * wave.peaks.length))
      const v = wave.peaks[pi] * hh
      const px = (i / (n - 1)) * w
      d += `M${px.toFixed(1)} ${(hh - v + 6).toFixed(1)}V${(hh + v + 6).toFixed(1)}`
    }
    return d
  }, [wave, w, a.in, a.out])
  void pps
  return (
    <div onPointerDown={onMove} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}
      style={{ position: 'absolute', left: x, top: 4, width: Math.max(6, w), height: AUDIO_H - 8, borderRadius: 8, background: 'rgba(92,190,140,0.22)', border: '2px solid rgba(92,190,140,0.7)', boxSizing: 'border-box', overflow: 'hidden', cursor: 'grab' }}>
      <svg width={Math.max(6, w)} height={AUDIO_H - 8} style={{ position: 'absolute', left: 0, top: -4, pointerEvents: 'none' }}>
        <path d={path} stroke="rgba(150,235,190,0.85)" strokeWidth={1.6} />
      </svg>
      <div style={{ position: 'absolute', left: 10, top: 4, fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.9)', pointerEvents: 'none', whiteSpace: 'nowrap' }}>♪ {a.label}</div>
      {hover && w > 70 && (
        <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onRemove() }} title="Take this sound out"
          style={{ position: 'absolute', right: EDGE + 4, top: 4, width: 24, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 15, padding: 0 }}>×</button>
      )}
      <div onPointerDown={onIn} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: EDGE, cursor: 'ew-resize', background: hover ? 'rgba(92,190,140,0.7)' : 'transparent' }} />
      <div onPointerDown={onOut} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: EDGE, cursor: 'ew-resize', background: hover ? 'rgba(92,190,140,0.7)' : 'transparent' }} />
    </div>
  )
}

/** Cards let go over the timeline go into the cut: picture and video cards
 *  where they are let go, sound cards onto the sound lane at that time. The
 *  card drag is the canvas's own, so this watches it from outside, the way
 *  a loop strip does: which cards moved, and where the pointer was let go. */
function useCardDropsIntoCut(group: ProjectGroup, root: React.RefObject<HTMLDivElement | null>, aim: (clientX: number | null) => number | null): void {
  const aimRef = useRef(aim)
  aimRef.current = aim
  useEffect(() => {
    let before: Map<string, { x: number; y: number }> | null = null
    let last = { x: 0, y: 0 }
    const moved = () => {
      if (!before) return []
      const { groups, boards } = useBoardsStore.getState()
      return groups.filter(g => {
        if (g.id === group.id) return false
        const was = before!.get(g.id)
        return !!was && (was.x !== g.originX || was.y !== g.originY) && !!cardScreenRect(g, boards, { x: 0, y: 0 }, 1)
      })
    }
    const over = (x: number, y: number) => {
      const r = root.current?.getBoundingClientRect()
      return !!r && x > r.left && x < r.right && y > r.top && y < r.bottom
    }
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || root.current?.contains(e.target as Node)) return
      before = new Map(useBoardsStore.getState().groups.map(g => [g.id, { x: g.originX, y: g.originY }]))
    }
    const move = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY }
      if (!before) return
      aimRef.current(over(e.clientX, e.clientY) && moved().length ? e.clientX : null)
    }
    const up = (e: PointerEvent) => {
      const hits = before ? moved() : []
      const was = before
      before = null
      const gap = over(e.clientX, e.clientY) && hits.length ? aimRef.current(e.clientX) : null
      aimRef.current(null)
      if (gap === null || !was) return
      void last
      const { boards } = useBoardsStore.getState()
      // Sound cards go onto the sound lane; the rest into the picture.
      const isSound = (g: ProjectGroup) => g.boardIds.every(bid => {
        const b = boards[bid]
        const items = b ? b.rootIds.flatMap(rid => getMediaItems(b.bars[rid]?.content)) : []
        return items.length > 0 && items.every(m => m.type === 'audio')
      })
      const sounds = hits.filter(isSound)
      const pictures = hits.filter(g => !isSound(g) && !g.effect && !g.cut)
      window.setTimeout(() => {
        // Back where they were first, so a cancelled merge leaves no trace.
        useBoardsStore.setState(st => ({
          groups: st.groups.map(g => {
            const p = hits.some(h => h.id === g.id) ? was.get(g.id) : undefined
            return p ? { ...g, originX: p.x, originY: p.y } : g
          }),
        }))
        if (pictures.length) void insertCards(group.id, pictures.map(g => g.id), gap)
        if (sounds.length) void addSounds(group.id, sounds, root.current, e.clientX)
      }, 60)
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
    }
  }, [group.id, root])
}

/** Sound cards onto a cut's sound lane, starting where they were let go. */
async function addSounds(groupId: string, cards: ProjectGroup[], el: HTMLDivElement | null, clientX: number): Promise<void> {
  const { mediaLength } = await import('../../utils/cutCard')
  const st = useBoardsStore.getState()
  const g = st.groups.find(x => x.id === groupId)
  if (!g?.cut || !el) return
  const total = cutTotal(cutClips(g, st.boards))
  const r = el.getBoundingClientRect()
  const pps = g.cut.pps > 0 ? g.cut.pps : (DW - PAD * 2) / Math.max(0.001, total || 10)
  let start = Math.max(0, ((clientX - r.left) / (r.width / DW) - PAD) / pps)
  const added: CutAudio[] = []
  for (const c of cards) {
    for (const bid of c.boardIds) {
      const b = st.boards[bid]
      for (const rid of b?.rootIds ?? []) {
        for (const m of getMediaItems(b.bars[rid]?.content)) {
          if (m.type !== 'audio') continue
          const full = m.duration ?? (await mediaLength(m.url, 'audio')) ?? 10
          added.push({ id: crypto.randomUUID(), url: m.url, label: m.originalName || c.name || 'Sound', start, in: 0, out: full, full })
          start += full
        }
      }
    }
  }
  if (!added.length) return
  useUndoCoordinator.getState().checkpoint()
  setCut(groupId, { audio: [...(g.cut.audio ?? []), ...added] })
}
