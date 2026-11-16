import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { createMediaCard } from '../../utils/cardGrid'
import { clientToCanvas } from '../../utils/fx/createEffect'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { addFreeNodeCentered } from '../../utils/canvasCreate'
import { cardScreenRect } from '../Layers/CardLayer'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { useCutPlay } from '../../utils/cutMedia'
import { openRoughCutViewer, playRoughCut, RoughCutScreen } from './RoughCutScreen'
import { findCuts } from '../../utils/shotDetect'
import { clipOutMedia, deckOfPicks, shotFrameTime, togglePickAt } from '../../utils/roughCutPicks'
import { useClipFrame } from '../../utils/clipFrames'
import {
  appendCards, splitClipAt, FILM_FPS, clipAt, clipLength, clipRow, clipStart, clipEnd, cutLength, MIN_CLIP, placed, setRoughCut, type RoughClip,
} from '../../utils/roughCut'

/** The Rough Cut node: a preview on top, the timeline below: rows of clips,
 *  each as wide as it is long, placed freely in time. Its controls keep one
 *  size (set when it is made); stretching the node gives the timeline more
 *  length, and pulling it down gives it more rows. */
const DW = 1400
/** A new node's shape, height ÷ width, title bar included (one row). */
export const ROUGH_CUT_ASPECT = 562 / 1400
const PREVIEW_H = 300
const RULER_H = 26
const TRACK_H = 150
const LEFT = 20
const EDGE = 12
const SNAP = 12
const PPS_MIN = 6, PPS_MAX = 600

/** A new Rough Cut's size: about a sixth of the canvas across, whatever the zoom (like the
 *  Film Look mixer, not createScaleFor's clamped scale). */
export function roughCutSize(): { width: number; height: number } {
  const host = document.querySelector('[data-zoom-bar-host]')?.getBoundingClientRect()
  const w = host?.width ?? window.innerWidth, h = host?.height ?? window.innerHeight
  const width = Math.min(w, h / ROUGH_CUT_ASPECT) * 0.15 / useCanvasStore.getState().zoom
  return { width, height: width * ROUGH_CUT_ASPECT }
}

/** A new Rough Cut, centred on `at` (the toolbar places it where you click). */
export function openRoughCut(at?: { cx: number; cy: number }) {
  const id = addFreeNodeCentered('roughCut', at)
  const n = useFreeNodeStore.getState().nodes[id]
  const { width, height } = roughCutSize()
  useFreeNodeStore.getState().updateFreeNode(id, {
    width, height, x: n.x + n.width / 2 - width / 2, y: n.y + n.height / 2 - height / 2,
    roughCut: { clips: [], pps: 60, ...n.roughCut, ui: width / DW },
  })
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60), r = s - m * 60
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`
}

/** Screen px per design px of an element: the node is scaled and the canvas
 *  zoomed, and drags are measured in the design's own units. */
const scaleOf = (el: HTMLElement) => el.getBoundingClientRect().width / Math.max(1, el.offsetWidth)

export function RoughCutBody({ id, node, bodyW, bodyH }: { id: string; node: FreeNodeData; bodyW: number; bodyH: number }) {
  const cut = node.roughCut ?? { clips: [], pps: 60 }
  const clips = useMemo(() => placed(cut.clips), [cut.clips])
  const pps = cut.pps
  const total = cutLength(clips)
  // Older ones had no fixed control size: they keep the one they have now.
  const ui = Math.max(0.001, cut.ui ?? Math.min(bodyW / DW, bodyH / (DW * ROUGH_CUT_ASPECT - 22)))
  useEffect(() => {
    if (cut.ui == null && node.roughCut) useFreeNodeStore.getState().updateFreeNode(id, { roughCut: { ...node.roughCut, ui } })
  }, [id, cut.ui, ui, node.roughCut])
  const W = bodyW / ui, H = bodyH / ui
  const fitRows = Math.max(1, Math.floor((H - PREVIEW_H - RULER_H - 14) / TRACK_H))
  const usedRows = clips.reduce((a, c) => Math.max(a, clipRow(c) + 1), 1)
  const rows = Math.max(fitRows, usedRows)

  // The playhead is shared with a Viewer touching it (RoughCutScreen).
  const t = useCutPlay(s => s.t[id] ?? 0)
  const playing = useCutPlay(s => s.playing === id)
  const setT = (v: number | ((p: number) => number)) => {
    const st = useCutPlay.getState()
    st.setT(id, typeof v === 'function' ? v(st.t[id] ?? 0) : v)
  }
  const setPlaying = (on: boolean | ((p: boolean) => boolean)) =>
    playRoughCut(id, typeof on === 'function' ? on(useCutPlay.getState().playing === id) : on)
  const [selected, setSelected] = useState<string | null>(null)
  /** A trim or move in flight: drawn from this, written once on release. */
  const [live, setLive] = useState<RoughClip[] | null>(null)
  const [dropHover, setDropHover] = useState(false)
  /** A clip carried off the Rough Cut, drawn at the pointer. */
  const [carry, setCarry] = useState<{ clip: RoughClip; x: number; y: number } | null>(null)
  const shown = live ?? clips
  const scroller = useRef<HTMLDivElement>(null)

  /** Where a canvas point falls on the timeline: its time and row, or null off it. */
  const geo = useRef({ ui, pps, rows, bodyH })
  geo.current = { ui, pps, rows, bodyH }
  const timelineAt = (cx: number, cy: number): { t: number; row: number } | null => {
    const n = useFreeNodeStore.getState().nodes[id]
    const el = scroller.current
    if (!n || !el) return null
    const g = geo.current
    const x = (cx - n.x) / g.ui + el.scrollLeft
    const y = (cy - (n.y + n.height - g.bodyH)) / g.ui - PREVIEW_H + el.scrollTop
    const row = Math.floor((y - RULER_H) / TRACK_H)
    if (y < 0 || row >= g.rows) return null
    return { t: Math.max(0, (x - LEFT) / g.pps), row: Math.max(0, row) }
  }
  useCardDrops(id, node, setDropHover, timelineAt)

  /** Split at the playhead: the selected clip if it is there, else the one seen there. */
  const splitRef = useRef<() => void>(() => {})
  splitRef.current = () => {
    const tt = useCutPlay.getState().t[id] ?? 0
    const sel = clips.find(c => c.id === selected && tt > clipStart(c) && tt < clipEnd(c))
    const target = sel ?? clipAt(clips, tt)?.clip
    if (!target) return
    const next = splitClipAt(clips, target.id, tt)
    if (next) setRoughCut(id, { clips: next })
  }

  /** Find shots: look through the selected clip (else the one seen at the
   *  playhead) for its cuts, and split it at every one: one undo step. */
  const [scan, setScan] = useState<{ clipId: string; f: number } | null>(null)
  const [shotNote, setShotNote] = useState<string | null>(null)
  const scanning = useRef(false)
  const gone = useRef(false)
  useEffect(() => {
    gone.current = false
    return () => { gone.current = true }
  }, [])
  const findShots = async () => {
    if (scanning.current) return
    const tt = useCutPlay.getState().t[id] ?? 0
    const target = clips.find(c => c.id === selected) ?? clipAt(clips, tt)?.clip
    if (!target || target.kind !== 'video') { setShotNote('Click a video clip first.'); return }
    scanning.current = true
    setShotNote(null)
    setScan({ clipId: target.id, f: 0 })
    let cuts: number[] = []
    try {
      cuts = await findCuts(target.url, target.in, target.out, f => { if (!gone.current) setScan({ clipId: target.id, f }) }, () => gone.current)
    } catch (err) {
      if (!gone.current) setShotNote(err instanceof Error ? err.message : 'The video could not be read.')
    }
    scanning.current = false
    if (gone.current) return
    setScan(null)
    // Split the clip as it is now (it may have moved while being looked through).
    let cl = placed(useFreeNodeStore.getState().nodes[id]?.roughCut?.clips ?? [])
    let cur = cl.find(c => c.id === target.id)
    let n = 0
    for (const cut of cuts) {
      if (!cur) break
      const next = splitClipAt(cl, cur.id, clipStart(cur) + (cut - cur.in))
      if (!next) continue
      cur = next[next.findIndex(c => c.id === cur!.id) + 1]
      cl = next
      n++
    }
    if (n) setRoughCut(id, { clips: cl })
    setShotNote(n ? `Split into ${n + 1} shots.` : 'No cuts found in this clip.')
    window.setTimeout(() => { if (!gone.current) setShotNote(null) }, 4000)
  }

  /** Pick / drop: the clip being watched (at the playhead), else the clicked one. */
  const pickTarget = (): RoughClip | undefined => {
    const tt = useCutPlay.getState().t[id] ?? 0
    return clipAt(clips, tt)?.clip ?? clips.find(c => c.id === selected)
  }
  const pickRef = useRef<() => void>(() => {})
  pickRef.current = () => {
    const c = pickTarget()
    if (c) setRoughCut(id, { clips: clips.map(x => (x.id === c.id ? { ...x, pick: !x.pick } : x)) })
  }
  const dropRef = useRef<() => void>(() => {})
  dropRef.current = () => {
    const c = pickTarget()
    if (c) setRoughCut(id, { clips: clips.filter(x => x.id !== c.id) })
  }
  const outputPicks = () => {
    const n = deckOfPicks(id)
    setShotNote(n ? `${n} picked ${n === 1 ? 'shot' : 'shots'} out as a deck, below.` : 'Nothing picked yet: press P on the shots you like.')
    window.setTimeout(() => { if (!gone.current) setShotNote(null) }, 4000)
  }

  // ← / → step one frame, S splits, on the Rough Cut under the pointer or last clicked.
  const root = useRef<HTMLDivElement>(null)
  const totalRef = useRef(total)
  totalRef.current = total
  useEffect(() => {
    const el = root.current
    if (!el) return
    let over = false, last = false
    const enter = () => { over = true }
    const leave = () => { over = false }
    const down = (e: PointerEvent) => { last = el.contains(e.target as Node) }
    const key = (e: KeyboardEvent) => {
      const split = (e.key === 's' || e.key === 'S') && !e.shiftKey
      const pick = (e.key === 'p' || e.key === 'P') && !e.shiftKey
      const drop = e.key === 'Delete' || e.key === 'Backspace'
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && !split && !pick && !drop) return
      if (!(over || last) || e.ctrlKey || e.metaKey || e.altKey) return
      const a = document.activeElement as HTMLElement | null
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return
      e.preventDefault()
      e.stopPropagation()
      if (split) { splitRef.current(); return }
      if (pick) { pickRef.current(); return }
      if (drop) { dropRef.current(); return }
      const st = useCutPlay.getState()
      if (st.playing === id) st.setPlaying(null)
      const f = Math.round((st.t[id] ?? 0) * FILM_FPS) + (e.key === 'ArrowLeft' ? -1 : 1)
      st.setT(id, Math.max(0, Math.min(totalRef.current, f / FILM_FPS)))
    }
    el.addEventListener('pointerenter', enter)
    el.addEventListener('pointerleave', leave)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      el.removeEventListener('pointerenter', enter)
      el.removeEventListener('pointerleave', leave)
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [id])

  // Playback: the playhead runs on the clock, and stops at the end.
  useEffect(() => {
    if (!playing) return
    let last = performance.now(), raf = 0
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const st = useCutPlay.getState()
      const next = (st.t[id] ?? 0) + dt
      if (next >= total) { st.setT(id, total); st.setPlaying(null); return }
      st.setT(id, next)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, total, id])
  useEffect(() => { if (t > total) useCutPlay.getState().setT(id, total) }, [t, total, id])

  // The timeline's own zoom: the wheel over it, about the cursor. Native, so
  // it can stop the canvas zooming too.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const k = scaleOf(el)
      const x = (e.clientX - el.getBoundingClientRect().left) / k + el.scrollLeft
      const at = (x - LEFT) / pps
      const next = Math.max(PPS_MIN, Math.min(PPS_MAX, pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
      setRoughCut(id, { pps: next }, false)
      requestAnimationFrame(() => { el.scrollLeft = Math.max(0, at * next + LEFT - (x - el.scrollLeft)) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [id, pps])

  /** Times a moved or trimmed edge pulls to: other clips' edges, the start, the playhead. */
  const snapTo = (v: number, skip: string): number => {
    const edges = [0, t]
    for (const c of clips) if (c.id !== skip) edges.push(clipStart(c), clipEnd(c))
    let best = v, d = SNAP / pps
    for (const e of edges) if (Math.abs(e - v) < d) { d = Math.abs(e - v); best = e }
    return best
  }

  /** Edge drag: trim the clip. Its other end stays where it is. */
  const startTrim = (e: React.PointerEvent, index: number, side: 'in' | 'out') => {
    e.stopPropagation()
    e.preventDefault()
    const k = scaleOf(scroller.current!)
    const sx = e.clientX
    const c0 = clips[index]
    const s0 = clipStart(c0), end0 = clipEnd(c0)
    let next = clips
    const move = (m: PointerEvent) => {
      const dt = (m.clientX - sx) / k / pps
      let c: RoughClip
      if (side === 'in') {
        const lo = Math.max(c0.in - s0, -c0.in) // not past the timeline's start or the source's
        const d = Math.max(Math.max(lo, -c0.in), Math.min(c0.out - MIN_CLIP - c0.in, snapTo(s0 + dt, c0.id) - s0))
        c = { ...c0, in: c0.in + d, start: s0 + d }
      } else {
        const d = Math.max(c0.in + MIN_CLIP - c0.out, Math.min(c0.full - c0.out, snapTo(end0 + dt, c0.id) - end0))
        c = { ...c0, out: c0.out + d }
      }
      next = clips.map((x, i) => (i === index ? c : x))
      setLive(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setLive(null)
      if (next !== clips) setRoughCut(id, { clips: next })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Middle drag: carry the clip anywhere, any row; gaps stay gaps. A click: go to it. */
  const startMove = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const k = scaleOf(scroller.current!)
    const sx = e.clientX, sy = e.clientY
    const c0 = clips[index]
    const s0 = clipStart(c0), len = clipLength(c0), r0 = clipRow(c0)
    let moved = false, next = clips, outside = false
    const body = scroller.current!.closest('[data-rough-cut]')!
    const move = (m: PointerEvent) => {
      if (!moved && Math.hypot(m.clientX - sx, m.clientY - sy) < 5) return
      moved = true
      // Off the Rough Cut: a copy comes out as a card, trimmed, where let go
      // (with Alt held, the clip itself: it leaves the cut).
      const r = body.getBoundingClientRect()
      outside = m.clientX < r.left || m.clientX > r.right || m.clientY < r.top || m.clientY > r.bottom
      setCarry(outside ? { clip: c0, x: m.clientX, y: m.clientY } : null)
      if (outside) { next = clips; setLive(m.altKey ? clips.filter((_, i) => i !== index) : clips); return }
      let st = Math.max(0, s0 + (m.clientX - sx) / k / pps)
      // Either end pulls to a nearby edge.
      const a = snapTo(st, c0.id), b = snapTo(st + len, c0.id) - len
      st = Math.abs(a - st) <= Math.abs(b - st) ? a : Math.max(0, b)
      const row = Math.max(0, Math.min(rows - 1, r0 + Math.round((m.clientY - sy) / k / TRACK_H)))
      next = clips.map((x, i) => (i === index ? { ...c0, start: st, row } : x))
      setLive(next)
    }
    const up = (u: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setLive(null)
      setCarry(null)
      if (moved && outside) {
        useUndoCoordinator.getState().checkpoint()
        createMediaCard(clientToCanvas(u.clientX, u.clientY), [{ media: clipOutMedia(c0), label: c0.label }])
        if (u.altKey) setRoughCut(id, { clips: clips.filter(c => c.id !== c0.id) }, false)
        return
      }
      if (!moved) {
        setSelected(c0.id)
        setT(s0)
        setPlaying(false)
        return
      }
      if (next !== clips) setRoughCut(id, { clips: next })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** The ruler: press or drag to put the playhead there. */
  const startScrub = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const el = scroller.current!
    const k = scaleOf(el)
    const at = (clientX: number) => Math.max(0, Math.min(total, ((clientX - el.getBoundingClientRect().left) / k + el.scrollLeft - LEFT) / pps))
    setPlaying(false)
    setT(at(e.clientX))
    const move = (m: PointerEvent) => setT(at(m.clientX))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const remove = (clipId: string) => setRoughCut(id, { clips: clips.filter(c => c.id !== clipId) })
  const fitAll = () => {
    if (!total || !scroller.current) return
    setRoughCut(id, { pps: Math.max(PPS_MIN, Math.min(PPS_MAX, (W - LEFT * 2 - 40) / total)) }, false)
    scroller.current.scrollLeft = 0
  }
  const zoomBy = (f: number) => setRoughCut(id, { pps: Math.max(PPS_MIN, Math.min(PPS_MAX, pps * f)) }, false)

  const at = clipAt(shown, t)
  const btn: React.CSSProperties = {
    height: 30, minWidth: 30, padding: '0 12px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14,
    fontWeight: 600, color: 'rgba(255,255,255,0.85)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.16)',
    flexShrink: 0,
  }
  const stop = (e: React.PointerEvent) => e.stopPropagation()
  const rowW = Math.max(W, total * pps + 240)

  return (
    <div ref={root} data-rough-cut="" style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: '#121319' }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, width: W, height: H,
        transform: `scale(${ui})`, transformOrigin: '0 0', color: '#fff', fontSize: 14,
        display: 'flex', flexDirection: 'column',
      }}>
        {/* ── Preview and transport ── */}
        <div style={{ height: PREVIEW_H, flexShrink: 0, display: 'flex', gap: 20, padding: 16, boxSizing: 'border-box' }}>
          <Preview id={id} clips={shown} shot={at?.clip.shot ?? null} empty={!clips.length} />
          <div onPointerDown={stop} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0, maxWidth: 860 }}>
            {/* Name, size, and the timeline's zoom */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 22, fontWeight: 700, cursor: 'help' }}
                title={"Drop cards where their clips should go. Drag a clip's edge to trim it, its middle to move it anywhere, any row; "
                  + 'empty time plays black, and the top row is the one seen. Drag a clip off to copy it out as a card (Alt moves it out). '
                  + 'Stretch this longer for more timeline, taller for more rows. The wheel over the timeline zooms it. '
                  + 'Keys: ← → a frame, S split, P pick, Delete drop.'}>Rough Cut</span>
              <span style={{ color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums', marginLeft: 6 }}>
                {clips.length} {clips.length === 1 ? 'clip' : 'clips'} · {fmt(total)}
              </span>
              <span style={{ flex: 1 }} />
              <button style={btn} onClick={() => zoomBy(1 / 1.4)} title="Zoom the timeline out">−</button>
              <button style={btn} onClick={fitAll} title="Fit the whole cut">Fit</button>
              <button style={btn} onClick={() => zoomBy(1.4)} title="Zoom the timeline in">+</button>
            </div>
            {/* Play · Cut · Choose */}
            <div style={{ display: 'flex', gap: 22, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Group name="Play">
                <button data-rough-play="" style={{ ...btn, width: 70, ...(playing ? { background: 'rgba(255,179,92,0.35)', border: '1px solid rgba(255,179,92,0.9)' } : null) }}
                  disabled={!clips.length} onClick={() => setPlaying(!playing)} title="Play or pause the cut">Play</button>
                <button style={btn} onClick={() => { setPlaying(false); setT(0) }} title="To the start">⏮</button>
                <button data-rough-open-viewer="" style={btn} onClick={() => openRoughCutViewer(id)} title="A Viewer at its end that plays the movie">Viewer</button>
                <span style={{ fontVariantNumeric: 'tabular-nums', width: 112, flexShrink: 0, whiteSpace: 'nowrap', color: 'rgba(255,255,255,0.75)', marginLeft: 4 }}>{fmt(t)} / {fmt(total)}</span>
              </Group>
              <Group name="Cut">
                <button data-rough-split="" style={btn} onClick={() => splitRef.current()} title="Split the clip at the playhead (S)">Split</button>
                <button data-rough-find-shots="" style={{ ...btn, ...(scan ? { background: 'rgba(111,179,255,0.35)', border: '1px solid rgba(111,179,255,0.8)' } : null) }}
                  onClick={() => void findShots()} title="Find the cuts in the clicked clip and split it into its shots">Find shots</button>
              </Group>
              <Group name="Choose">
                <button data-rough-pick="" style={{ ...btn, ...(at?.clip.pick ? { background: 'rgba(255,200,80,0.35)', border: '1px solid rgba(255,200,80,0.9)' } : null) }}
                  onClick={() => pickRef.current()} title="Pick the shot at the playhead, or unpick it (P). Delete drops it.">Pick</button>
                <button data-rough-deck-picks="" style={btn} onClick={outputPicks}
                  title="Lay the picked shots out below as a deck of cards, in the order they play">Deck of picks</button>
                <span style={{ color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums', marginLeft: 4, whiteSpace: 'nowrap' }}>
                  {clips.filter(c => c.pick).length} picked
                </span>
              </Group>
            </div>
            {/* The shot at the playhead */}
            {(scan || shotNote) && (
              <div data-rough-shot-note="" style={{ color: '#9fcbff', fontWeight: 600 }}>
                {scan ? `Finding shots… ${Math.round(scan.f * 100)}%` : shotNote}
              </div>
            )}
            {at && (
              <div style={{ color: 'rgba(255,255,255,0.7)', lineHeight: 1.6, fontVariantNumeric: 'tabular-nums' }}>
                <div style={{ fontSize: 16, color: '#fff', fontWeight: 600 }}>{at.clip.label}</div>
                <div>in {fmt(at.clip.in)} · out {fmt(at.clip.out)} · {fmt(clipLength(at.clip))} of {fmt(at.clip.kind === 'image' ? clipLength(at.clip) : at.clip.full)}</div>
              </div>
            )}
          </div>
        </div>

        {/* ── The timeline ── */}
        <div
          ref={scroller}
          data-rough-row=""
          onPointerDown={stop}
          style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative', borderTop: '1px solid rgba(255,255,255,0.08)' }}
        >
          <div style={{ position: 'relative', width: rowW, height: RULER_H + rows * TRACK_H + 8 }}>
            <Ruler pps={pps} width={rowW} onPointerDown={startScrub} />
            {Array.from({ length: rows }, (_, r) => (
              <div key={r} data-rough-track={r} style={{
                position: 'absolute', left: 0, width: rowW, top: RULER_H + r * TRACK_H + 4, height: TRACK_H - 8,
                background: r % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.045)',
              }} />
            ))}
            {shown.map((c, i) => (
              <ClipBlock
                key={c.id} clip={c} x={clipStart(c) * pps + LEFT} y={RULER_H + clipRow(c) * TRACK_H} w={clipLength(c) * pps}
                selected={selected === c.id} lifted={!!live && live[i] !== clips[i]}
                scanning={scan?.clipId === c.id ? scan.f : null}
                onMove={e => startMove(e, i)}
                onTrimIn={e => startTrim(e, i, 'in')}
                onTrimOut={e => startTrim(e, i, 'out')}
                onRemove={() => remove(c.id)}
              />
            ))}
            {/* The playhead */}
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: t * pps + LEFT, width: 2, background: '#ff5a4f', pointerEvents: 'none', zIndex: 3 }}>
              <div style={{ position: 'absolute', top: 0, left: -6, width: 14, height: 10, background: '#ff5a4f', borderRadius: '2px 2px 7px 7px' }} />
            </div>
            {!clips.length && (
              <div style={{ position: 'absolute', left: 40, top: RULER_H + 50, color: 'rgba(255,255,255,0.45)', fontSize: 16 }}>
                Empty. Drop a card on this Rough Cut to add its clips.
              </div>
            )}
          </div>
        </div>
      </div>
      {carry && ReactDOM.createPortal(<CarriedClip {...carry} />, document.body)}
      {dropHover && (
        <div style={{ position: 'absolute', inset: 0, boxShadow: 'inset 0 0 0 4px rgba(111,179,255,0.8)', pointerEvents: 'none', background: 'rgba(111,179,255,0.08)' }} />
      )}
    </div>
  )
}

/** A few buttons that belong together, under a small name. */
const Group: React.FC<{ name: string; children: React.ReactNode }> = ({ name, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)' }}>{name}</span>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>{children}</div>
  </div>
)

const Ruler: React.FC<{ pps: number; width: number; onPointerDown: (e: React.PointerEvent) => void }> = ({ pps, width, onPointerDown }) => {
  // A tick every 1, 2, 5, 10... seconds, whichever leaves room for its label.
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find(s => s * pps >= 70) ?? 120
  const ticks: number[] = []
  for (let s = 0; s * pps < width; s += step) ticks.push(s)
  return (
    <div data-rough-ruler="" onPointerDown={onPointerDown} style={{ position: 'absolute', top: 0, left: 0, width, height: RULER_H, cursor: 'text', background: 'rgba(255,255,255,0.03)' }}>
      {ticks.map(s => (
        <div key={s} style={{ position: 'absolute', left: s * pps + 20, top: 0, height: RULER_H, borderLeft: '1px solid rgba(255,255,255,0.2)', paddingLeft: 4, fontSize: 11.5, color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums' }}>
          {fmt(s)}
        </div>
      ))}
    </div>
  )
}

/** A clip being taken out: a little card at the pointer. */
const CarriedClip: React.FC<{ clip: RoughClip; x: number; y: number }> = ({ clip, x, y }) => {
  const stored = useResolvedMedia(clip.poster ?? (clip.kind === 'image' ? clip.url : null))
  // A video shows its own first frame (a shot cut from a movie is not the movie's poster).
  const poster = useClipFrame(clip.kind === 'video' ? clip.url : null, shotFrameTime(clip)) ?? stored
  return (
    <div data-rough-carry="" style={{
      position: 'fixed', left: x - 80, top: y - 50, width: 160, height: 100, zIndex: 100000, pointerEvents: 'none',
      borderRadius: 8, overflow: 'hidden', border: '2px solid #fff', boxShadow: '0 12px 30px rgba(0,0,0,0.6)',
      background: poster ? `#000 url("${poster}") center / cover` : '#2a2c38', color: '#fff', fontSize: 12, fontWeight: 600,
    }}>
      <div style={{ padding: '4px 8px', background: 'linear-gradient(rgba(0,0,0,0.75), rgba(0,0,0,0))' }}>{clip.label} · {fmt(clipLength(clip))}</div>
    </div>
  )
}

const KIND_COLOR: Record<RoughClip['kind'], string> = { shot: '#ffb35c', video: '#6fb7ff', image: '#9fd49a' }

const ClipBlock: React.FC<{
  clip: RoughClip; x: number; y: number; w: number; selected: boolean; lifted?: boolean
  /** Being looked through for its shots: how far along, 0..1. */
  scanning?: number | null
  onMove: (e: React.PointerEvent) => void
  onTrimIn: (e: React.PointerEvent) => void
  onTrimOut: (e: React.PointerEvent) => void
  onRemove: () => void
}> = ({ clip, x, y, w, selected, lifted, scanning, onMove, onTrimIn, onTrimOut, onRemove }) => {
  const stored = useResolvedMedia(clip.poster ?? (clip.kind === 'image' ? clip.url : null))
  // A video shows its own first frame (a shot cut from a movie is not the movie's poster).
  const poster = useClipFrame(clip.kind === 'video' ? clip.url : null, shotFrameTime(clip)) ?? stored
  const [hover, setHover] = useState(false)
  const color = KIND_COLOR[clip.kind]
  return (
    <div
      data-rough-clip={clip.label}
      onPointerDown={onMove}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        position: 'absolute', left: x, top: y + 8, width: Math.max(4, w - 3), height: TRACK_H - 16, zIndex: lifted ? 2 : 1,
        boxShadow: lifted ? '0 10px 24px rgba(0,0,0,0.6)' : undefined,
        borderRadius: 8, overflow: 'hidden', cursor: 'grab', boxSizing: 'border-box',
        background: poster ? `#000 url("${poster}") left center / auto 100% repeat-x` : '#2a2c38',
        border: `2px solid ${selected ? '#fff' : color}`,
      }}
    >
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 0, padding: '4px 10px', fontSize: 13, fontWeight: 600,
        background: 'linear-gradient(rgba(0,0,0,0.75), rgba(0,0,0,0))', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{clip.label}</div>
      <div style={{ position: 'absolute', left: 10, bottom: 6, fontSize: 12, color: 'rgba(255,255,255,0.85)', textShadow: '0 1px 2px #000', fontVariantNumeric: 'tabular-nums' }}>
        {fmt(clipLength(clip))}
      </div>
      {hover && w > 60 && (
        <button
          title="Take this clip out of the cut"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onRemove() }}
          style={{ position: 'absolute', right: 16, top: 4, width: 22, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 14, lineHeight: '22px', padding: 0 }}
        >×</button>
      )}
      {clip.pick && (
        <div data-rough-picked="" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 8, background: '#ffc850', pointerEvents: 'none' }} />
      )}
      {scanning != null && (
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${scanning * 100}%`, background: 'rgba(111,179,255,0.35)', borderRight: '2px solid #9fcbff', pointerEvents: 'none' }} />
      )}
      {/* Trim handles, as wide as a fingertip, lit on hover */}
      <div data-rough-trim="in" onPointerDown={onTrimIn} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: EDGE, cursor: 'ew-resize', background: hover ? `${color}cc` : 'transparent' }} />
      <div data-rough-trim="out" onPointerDown={onTrimOut} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: EDGE, cursor: 'ew-resize', background: hover ? `${color}cc` : 'transparent' }} />
    </div>
  )
}

/** What is under the playhead (RoughCutScreen: black where nothing is).
 *  A film shot also sends the Film Look mixer, if one is up, to that shot. */
const Preview: React.FC<{ id: string; clips: RoughClip[]; shot: string | null; empty: boolean }> = ({ id, clips, shot, empty }) => {
  useEffect(() => {
    if (shot && Object.values(useFreeNodeStore.getState().nodes).some(n => n.type === 'filmMixer')) {
      void window.vidbarsDesktop?.mixerCall?.('go', [shot])
    }
  }, [shot])
  return (
    <div style={{ width: 476, height: PREVIEW_H - 32, flexShrink: 0, background: '#000', borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
      <RoughCutScreen cutId={id} clips={clips} muted />
      {empty && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'rgba(255,255,255,0.35)' }}>No clips yet</div>}
      {!empty && <PreviewBar id={id} clips={clips} />}
    </div>
  )
}

/** Play and Pick on the preview itself, to choose shots while watching there. */
const PreviewBar: React.FC<{ id: string; clips: RoughClip[] }> = ({ id, clips }) => {
  const playing = useCutPlay(s => s.playing === id)
  const t = useCutPlay(s => s.t[id] ?? 0)
  const picked = !!clipAt(clips, t)?.clip.pick
  const b = (lit: boolean, color: string): React.CSSProperties => ({
    height: 28, padding: '0 12px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
    color: '#fff', background: lit ? color : 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.25)',
  })
  return (
    <div onPointerDown={e => e.stopPropagation()} style={{ position: 'absolute', left: 8, bottom: 8, display: 'flex', gap: 6 }}>
      <button data-rough-preview-play="" style={b(playing, 'rgba(255,179,92,0.55)')} onClick={() => playRoughCut(id, !playing)}>Play</button>
      <button data-rough-preview-pick="" style={b(picked, 'rgba(255,200,80,0.55)')} title="Pick the shot playing now, or unpick it (P)"
        onClick={() => togglePickAt(id, useCutPlay.getState().t[id] ?? 0)}>Pick</button>
    </div>
  )
}

/** Cards let go over the Rough Cut join it: their clips go on the end, and the
 *  card goes back where it was picked up. The card drag is the canvas's own,
 *  so this watches it from outside: where every card was when the button went
 *  down, and which moved over the Rough Cut when it came up. */
function useCardDrops(id: string, node: FreeNodeData, setHover: (on: boolean) => void, timelineAt: (cx: number, cy: number) => { t: number; row: number } | null): void {
  const atRef = useRef(timelineAt)
  atRef.current = timelineAt
  const pinned = !!node.pin
  useEffect(() => {
    if (pinned) return
    let before: Map<string, { x: number; y: number }> | null = null
    const over = () => {
      const nodes = useFreeNodeStore.getState().nodes
      const n = nodes[id]
      if (!n || !before) return []
      // Rough Cuts overlapping: the card goes to the one drawn on top, the
      // later one in the canvas's order.
      const cuts = Object.values(nodes).filter(x => x.type === 'roughCut' && !x.pin)
      const above = cuts.slice(cuts.findIndex(x => x.id === id) + 1)
      const inside = (x: FreeNodeData, cx: number, cy: number) => cx > x.x && cx < x.x + x.width && cy > x.y && cy < x.y + x.height
      const { groups, boards } = useBoardsStore.getState()
      return groups.filter(g => {
        const was = before!.get(g.id)
        if (!was || (was.x === g.originX && was.y === g.originY)) return false
        const r = cardScreenRect(g, boards, { x: 0, y: 0 }, 1)
        if (!r) return false
        const cx = r.screenLeft + r.screenWidth / 2, cy = r.screenTop + r.screenHeight / 2
        return inside(n, cx, cy) && !above.some(x => inside(x, cx, cy))
      })
    }
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return
      before = new Map(useBoardsStore.getState().groups.map(g => [g.id, { x: g.originX, y: g.originY }]))
    }
    const moveCheck = () => { if (before) setHover(over().length > 0) }
    const up = () => {
      const hits = over()
      const was = before
      before = null
      setHover(false)
      if (!hits.length || !was) return
      // After the canvas has finished its own drop (snapping, decks).
      window.setTimeout(() => {
        // Where the first card was let go: its centre's time and row.
        const r = cardScreenRect(hits[0], useBoardsStore.getState().boards, { x: 0, y: 0 }, 1)
        const at = r ? atRef.current(r.screenLeft + r.screenWidth / 2, r.screenTop + r.screenHeight / 2) : null
        void appendCards(id, hits.map(g => g.id), at ?? undefined)
        useBoardsStore.setState(s => ({
          groups: s.groups.map(g => {
            const p = hits.some(h => h.id === g.id) ? was.get(g.id) : undefined
            return p ? { ...g, originX: p.x, originY: p.y } : g
          }),
        }))
      }, 60)
    }
    const unsub = useBoardsStore.subscribe(moveCheck)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    return () => {
      unsub()
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
    }
  }, [id, pinned, setHover])
}
