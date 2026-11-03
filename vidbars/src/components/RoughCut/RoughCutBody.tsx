import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { addFreeNodeCentered } from '../../utils/canvasCreate'
import { cardScreenRect } from '../Layers/CardLayer'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import {
  appendCards, clipAt, clipLength, cutLength, MIN_CLIP, ROW_FIT_W, setRoughCut, type RoughClip,
} from '../../utils/roughCut'

/** The Rough Cut node: a preview on top, the cut below as one row of clips,
 *  each as wide as it is long. Laid out at one design size and scaled to the
 *  node like the Film Look mixer, so it reads the same at every zoom. */
const DW = 1400
const DH = 540
/** The node's shape, height ÷ width, title bar included. It only ever scales. */
export const ROUGH_CUT_ASPECT = 562 / 1400
const PREVIEW_H = 300
const RULER_H = 26
const TRACK_H = 150
const EDGE = 12
const PPS_MIN = 6, PPS_MAX = 600

/** A new Rough Cut's size: most of the canvas, whatever the zoom (like the
 *  Film Look mixer, not createScaleFor's clamped scale). */
export function roughCutSize(): { width: number; height: number } {
  const host = document.querySelector('[data-zoom-bar-host]')?.getBoundingClientRect()
  const w = host?.width ?? window.innerWidth, h = host?.height ?? window.innerHeight
  const width = Math.min(w, h / ROUGH_CUT_ASPECT) * 0.85 / useCanvasStore.getState().zoom
  return { width, height: width * ROUGH_CUT_ASPECT }
}

/** A new Rough Cut, centred on `at` (the toolbar places it where you click). */
export function openRoughCut(at?: { cx: number; cy: number }) {
  const id = addFreeNodeCentered('roughCut', at)
  const n = useFreeNodeStore.getState().nodes[id]
  const { width, height } = roughCutSize()
  useFreeNodeStore.getState().updateFreeNode(id, {
    width, height, x: n.x + n.width / 2 - width / 2, y: n.y + n.height / 2 - height / 2,
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
  const clips = cut.clips
  const pps = cut.pps
  const total = cutLength(clips)
  const fit = Math.max(0.001, Math.min(bodyW / DW, bodyH / DH))

  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  /** A trim or move in flight: drawn from this, written once on release. */
  const [live, setLive] = useState<RoughClip[] | null>(null)
  const [insertAt, setInsertAt] = useState<number | null>(null)
  const [dropHover, setDropHover] = useState(false)
  const shown = live ?? clips
  const scroller = useRef<HTMLDivElement>(null)

  useCardDrops(id, node, setDropHover)

  // Playback: the playhead runs on the clock, and stops at the end.
  useEffect(() => {
    if (!playing) return
    let last = performance.now(), raf = 0
    const step = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      setT(prev => {
        const next = prev + dt
        if (next >= total) { setPlaying(false); return total }
        return next
      })
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, total])
  useEffect(() => { if (t > total) setT(total) }, [t, total])

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
      const at = x / pps
      const next = Math.max(PPS_MIN, Math.min(PPS_MAX, pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
      setRoughCut(id, { pps: next }, false)
      requestAnimationFrame(() => { el.scrollLeft = Math.max(0, at * next - (x - el.scrollLeft)) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [id, pps])

  const starts = useMemo(() => {
    let a = 0
    return shown.map(c => { const s = a; a += clipLength(c); return s })
  }, [shown])

  /** Edge drag: trim the clip; the ones after it ride along (ripple). */
  const startTrim = (e: React.PointerEvent, index: number, side: 'in' | 'out') => {
    e.stopPropagation()
    e.preventDefault()
    const k = scaleOf(scroller.current!)
    const sx = e.clientX
    const c0 = clips[index]
    let next = clips
    const move = (m: PointerEvent) => {
      const dt = (m.clientX - sx) / k / pps
      const c = side === 'in'
        ? { ...c0, in: Math.max(0, Math.min(c0.out - MIN_CLIP, c0.in + dt)) }
        : { ...c0, out: Math.max(c0.in + MIN_CLIP, Math.min(c0.full, c0.out + dt)) }
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

  /** Middle drag: move the clip to where it is let go. A click: go to it. */
  const startMove = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const el = scroller.current!
    const k = scaleOf(el)
    const sx = e.clientX
    let moved = false, to = index
    const timeAt = (clientX: number) => ((clientX - el.getBoundingClientRect().left) / k + el.scrollLeft) / pps
    const move = (m: PointerEvent) => {
      if (!moved && Math.abs(m.clientX - sx) < 5) return
      moved = true
      const at = timeAt(m.clientX)
      // The gap nearest the pointer: before the first clip whose middle is past it.
      let gap = clips.length
      for (let i = 0; i < clips.length; i++) if (at < starts[i] + clipLength(clips[i]) / 2) { gap = i; break }
      to = gap
      setInsertAt(gap)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setInsertAt(null)
      if (!moved) {
        setSelected(clips[index].id)
        setT(starts[index])
        setPlaying(false)
        return
      }
      if (to === index || to === index + 1) return
      const next = clips.filter((_, i) => i !== index)
      next.splice(to > index ? to - 1 : to, 0, clips[index])
      setRoughCut(id, { clips: next })
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
    const at = (clientX: number) => Math.max(0, Math.min(total, ((clientX - el.getBoundingClientRect().left) / k + el.scrollLeft) / pps))
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
    setRoughCut(id, { pps: Math.max(PPS_MIN, Math.min(PPS_MAX, ROW_FIT_W / total)) }, false)
    scroller.current.scrollLeft = 0
  }
  const zoomBy = (f: number) => setRoughCut(id, { pps: Math.max(PPS_MIN, Math.min(PPS_MAX, pps * f)) }, false)

  const at = clipAt(shown, t)
  const btn: React.CSSProperties = {
    height: 30, minWidth: 30, padding: '0 12px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14,
    fontWeight: 600, color: 'rgba(255,255,255,0.85)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.16)',
  }
  const stop = (e: React.PointerEvent) => e.stopPropagation()
  const rowW = Math.max(DW, total * pps + 240)

  return (
    <div data-rough-cut="" style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: '#121319' }}>
      <div style={{
        position: 'absolute', top: 0, left: (bodyW - DW * fit) / 2, width: DW, height: DH,
        transform: `scale(${fit})`, transformOrigin: '0 0', color: '#fff', fontSize: 14,
        display: 'flex', flexDirection: 'column',
      }}>
        {/* ── Preview and transport ── */}
        <div style={{ height: PREVIEW_H, display: 'flex', gap: 20, padding: 16, boxSizing: 'border-box' }}>
          <Preview clip={at?.clip ?? null} local={at?.local ?? 0} playing={playing} />
          <div onPointerDown={stop} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
              <span style={{ fontSize: 22, fontWeight: 700 }}>Rough Cut</span>
              <span style={{ color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums' }}>
                {clips.length} {clips.length === 1 ? 'clip' : 'clips'} · {fmt(total)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button data-rough-play="" style={{ ...btn, width: 86 }} disabled={!clips.length}
                onClick={() => { if (!playing && t >= total - 0.01) setT(0); setPlaying(p => !p) }}>
                {playing ? 'Pause' : 'Play'}
              </button>
              <button style={btn} onClick={() => { setPlaying(false); setT(0) }} title="To the start">⏮</button>
              <span style={{ fontVariantNumeric: 'tabular-nums', width: 120, color: 'rgba(255,255,255,0.75)' }}>{fmt(t)} / {fmt(total)}</span>
              <span style={{ flex: 1 }} />
              <button style={btn} onClick={() => zoomBy(1 / 1.4)} title="Zoom the row out">−</button>
              <button style={btn} onClick={fitAll} title="Fit the whole cut">Fit</button>
              <button style={btn} onClick={() => zoomBy(1.4)} title="Zoom the row in">+</button>
            </div>
            {at && (
              <div style={{ color: 'rgba(255,255,255,0.7)', lineHeight: 1.6, fontVariantNumeric: 'tabular-nums' }}>
                <div style={{ fontSize: 16, color: '#fff', fontWeight: 600 }}>{at.clip.label}</div>
                <div>in {fmt(at.clip.in)} · out {fmt(at.clip.out)} · {fmt(clipLength(at.clip))} of {fmt(at.clip.kind === 'image' ? clipLength(at.clip) : at.clip.full)}</div>
              </div>
            )}
            <div style={{ marginTop: 'auto', color: 'rgba(255,255,255,0.4)', fontSize: 12.5, lineHeight: 1.5 }}>
              Drop cards here to add their clips. Drag a clip's edge to trim it, drag its middle to move it.
              The wheel over the row zooms it. Docked to the Film Look mixer, it feeds the mixer its shots.
            </div>
          </div>
        </div>

        {/* ── The cut ── */}
        <div
          ref={scroller}
          data-rough-row=""
          onPointerDown={stop}
          style={{ flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'hidden', position: 'relative', borderTop: '1px solid rgba(255,255,255,0.08)' }}
        >
          <div style={{ position: 'relative', width: rowW, height: RULER_H + TRACK_H + 40 }}>
            <Ruler pps={pps} width={rowW} onPointerDown={startScrub} />
            {shown.map((c, i) => (
              <ClipBlock
                key={c.id} clip={c} x={starts[i] * pps + 20} w={clipLength(c) * pps}
                selected={selected === c.id}
                onMove={e => startMove(e, i)}
                onTrimIn={e => startTrim(e, i, 'in')}
                onTrimOut={e => startTrim(e, i, 'out')}
                onRemove={() => remove(c.id)}
              />
            ))}
            {insertAt !== null && (
              <div style={{
                position: 'absolute', top: RULER_H + 6, height: TRACK_H - 12, width: 4, borderRadius: 2, background: '#6fb3ff',
                left: (insertAt < starts.length ? starts[insertAt] : total) * pps + 18,
              }} />
            )}
            {/* The playhead */}
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: t * pps + 20, width: 2, background: '#ff5a4f', pointerEvents: 'none' }}>
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
      {dropHover && (
        <div style={{ position: 'absolute', inset: 0, boxShadow: 'inset 0 0 0 4px rgba(111,179,255,0.8)', pointerEvents: 'none', background: 'rgba(111,179,255,0.08)' }} />
      )}
    </div>
  )
}

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

const KIND_COLOR: Record<RoughClip['kind'], string> = { shot: '#ffb35c', video: '#6fb7ff', image: '#9fd49a' }

const ClipBlock: React.FC<{
  clip: RoughClip; x: number; w: number; selected: boolean
  onMove: (e: React.PointerEvent) => void
  onTrimIn: (e: React.PointerEvent) => void
  onTrimOut: (e: React.PointerEvent) => void
  onRemove: () => void
}> = ({ clip, x, w, selected, onMove, onTrimIn, onTrimOut, onRemove }) => {
  const poster = useResolvedMedia(clip.poster ?? (clip.kind === 'image' ? clip.url : null))
  const [hover, setHover] = useState(false)
  const color = KIND_COLOR[clip.kind]
  return (
    <div
      data-rough-clip={clip.label}
      onPointerDown={onMove}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        position: 'absolute', left: x, top: RULER_H + 8, width: Math.max(4, w - 3), height: TRACK_H - 16,
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
      {/* Trim handles, as wide as a fingertip, lit on hover */}
      <div data-rough-trim="in" onPointerDown={onTrimIn} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: EDGE, cursor: 'ew-resize', background: hover ? `${color}cc` : 'transparent' }} />
      <div data-rough-trim="out" onPointerDown={onTrimOut} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: EDGE, cursor: 'ew-resize', background: hover ? `${color}cc` : 'transparent' }} />
    </div>
  )
}

/** What is under the playhead. A video plays from its own file; a still or a
 *  film shot shows its picture (the Film Look mixer is where a shot's look is
 *  judged), and the mixer, if it is on the canvas, follows to that shot. */
const Preview: React.FC<{ clip: RoughClip | null; local: number; playing: boolean }> = ({ clip, local, playing }) => {
  const src = useResolvedMedia(clip ? (clip.kind === 'video' ? clip.url : clip.poster ?? clip.url) : null)
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = video.current
    if (!v || clip?.kind !== 'video') return
    if (!playing || Math.abs(v.currentTime - local) > 0.35) v.currentTime = local
    if (playing && v.paused) void v.play().catch(() => {})
    if (!playing && !v.paused) v.pause()
  }, [clip, local, playing])
  const shot = clip?.shot ?? null
  useEffect(() => {
    if (shot && Object.values(useFreeNodeStore.getState().nodes).some(n => n.type === 'filmMixer')) {
      void window.vidbarsDesktop?.mixerCall?.('go', [shot])
    }
  }, [shot])
  return (
    <div style={{ width: 476, height: PREVIEW_H - 32, flexShrink: 0, background: '#000', borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
      {clip && src && (clip.kind === 'video'
        ? <video ref={video} src={src} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        : <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />)}
      {!clip && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'rgba(255,255,255,0.35)' }}>No clips yet</div>}
    </div>
  )
}

/** Cards let go over the Rough Cut join it: their clips go on the end, and the
 *  card goes back where it was picked up. The card drag is the canvas's own,
 *  so this watches it from outside: where every card was when the button went
 *  down, and which moved over the Rough Cut when it came up. */
function useCardDrops(id: string, node: FreeNodeData, setHover: (on: boolean) => void): void {
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
        void appendCards(id, hits.map(g => g.id))
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
