// RoughCutScreen — what a Rough Cut shows at its playhead: the clip on the
// top row there, or black where there is none. Used by the Rough Cut's own
// preview and by a Viewer touching it (RoughCutViewerOverlay), which play the
// same playhead (useCutPlay, keyed by the Rough Cut's id).
//
// Each video near the playhead has its own <video>, loaded and waiting at its
// in point, so a cut lands on time instead of stalling while a file opens.

import React, { useEffect, useRef, useState } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useViewport3DStore, VIEWPORT3D_MIN_H, VIEWPORT3D_MIN_W, type ViewportWindow3D } from '../../store/viewport3dStore'
import { viewerAdjacentTo } from '../../utils/componentLinks'
import { useCutPlay } from '../../utils/cutMedia'
import { clipAt, clipEnd, clipStart, cutLength, placed, setRoughCut, type RoughClip, type RoughCutData } from '../../utils/roughCut'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { placeInFrame, tidyView, VIEW_ZOOM_MAX, type ShotView } from '../../utils/shotFrame'
import { togglePickAt } from '../../utils/roughCutPicks'
import { VIEWPORT_HEADER_SCREEN_H, viewportVisualRect } from '../../utils/viewportDocking'

/** The frame a Rough Cut's screens show: its frame, unless they are showing whole shots. */
export const shownFrame = (cut: RoughCutData | undefined) => (cut?.frame && cut.frameShown !== false ? cut.frame : undefined)

/** `frame`: every shot is shown in this one frame (the largest of its shape
 *  the screen holds, outlined), filling it or fitted inside it. There the
 *  shot on screen can be slid about (drag) and zoomed (wheel) inside the
 *  frame; a double-click puts it back. */
export const RoughCutScreen: React.FC<{ cutId: string; clips: RoughClip[]; muted: boolean; volume?: number; frame?: RoughCutData['frame'] }> = ({ cutId, clips, muted, volume = 1, frame }) => {
  const t = useCutPlay(s => s.t[cutId] ?? 0)
  const playing = useCutPlay(s => s.playing === cutId)
  const at = clipAt(clips, t)
  const videos = useRef(new Map<string, HTMLVideoElement>())

  // The one on screen plays (or holds its frame); the others wait at their in point.
  useEffect(() => {
    for (const [id, v] of videos.current) {
      const c = clips.find(x => x.id === id)
      if (!c) continue
      if (at && at.clip.id === id) {
        if (playing) {
          if (Math.abs(v.currentTime - at.local) > 0.3) v.currentTime = at.local
          if (v.paused) void v.play().catch(() => {})
        } else {
          if (!v.paused) v.pause()
          if (Math.abs(v.currentTime - at.local) > 0.02) v.currentTime = at.local
        }
      } else {
        if (!v.paused) v.pause()
        if (Math.abs(v.currentTime - c.in) > 0.05 && !v.seeking) v.currentTime = c.in
      }
    }
  })

  // Videos near the playhead: on screen now, or starting within ten seconds.
  const near = clips.filter(c => c.kind === 'video' && clipEnd(c) > t - 1 && clipStart(c) < t + 10)
  if (at && at.clip.kind === 'video' && !near.includes(at.clip)) near.push(at.clip)
  // Each shot's own size, as its picture reports it: what sliding and zooming are worked out from.
  const sizes = useRef(new Map<string, { w: number; h: number }>())
  const onSize = (id: string, w: number, h: number) => { if (w > 0 && h > 0) sizes.current.set(id, { w, h }) }
  const shots = (
    <>
      {near.map(c => (
        <ScreenVideo key={c.id} clip={c} visible={at?.clip.id === c.id} muted={muted} volume={volume} frame={frame} onSize={onSize}
          bind={el => { if (el) videos.current.set(c.id, el); else videos.current.delete(c.id) }} />
      ))}
      {at && at.clip.kind !== 'video' && <ScreenStill key={at.clip.id} clip={at.clip} frame={frame} onSize={onSize} />}
    </>
  )

  // Slide and zoom the shot on screen inside the frame.
  const box = useRef<HTMLDivElement>(null)
  const live = useRef({ clips, at, frame })
  live.current = { clips, at, frame }
  /** Give the shot on screen a new view (kept inside its slack). `checkpoint`: an undo step of its own. */
  const setView = (change: (v: ShotView) => ShotView, checkpoint: boolean) => {
    const { clips: cl, at: now, frame: f } = live.current
    const size = now && sizes.current.get(now.clip.id)
    if (!now || !f || !size) return
    const view = tidyView(size.w, size.h, f.aspect, f.fill, change(now.clip.view ?? {}))
    setRoughCut(cutId, { clips: cl.map(c => (c.id === now.clip.id ? { ...c, view } : c)) }, checkpoint)
  }
  const slide = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !live.current.at) return
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    const from = { x: e.clientX, y: e.clientY, v: live.current.at.clip.view ?? {} }
    let moved = false
    const move = (m: PointerEvent) => {
      const dx = (m.clientX - from.x) / Math.max(1, r.width), dy = (m.clientY - from.y) / Math.max(1, r.height)
      if (!moved && Math.abs(m.clientX - from.x) + Math.abs(m.clientY - from.y) < 3) return
      setView(() => ({ ...from.v, x: (from.v.x ?? 0) + dx, y: (from.v.y ?? 0) + dy }), !moved)
      moved = true
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // The wheel over the frame zooms the shot, not the canvas. Native, so it
  // can stop the page's own zoom; one undo step per run of the wheel.
  const hasFrame = !!frame
  useEffect(() => {
    const el = box.current
    if (!el) return
    let last = 0
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const fresh = e.timeStamp - last > 600
      last = e.timeStamp
      setView(v => ({ ...v, zoom: Math.max(1, Math.min(VIEW_ZOOM_MAX, (v.zoom ?? 1) * Math.exp(-e.deltaY * 0.0015))) }), fresh)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFrame, cutId])
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#000', overflow: 'hidden', containerType: 'size' }}>
      {frame ? (
        // The largest box of the frame's shape the screen holds, in its middle.
        <div data-rough-frame="" ref={box} onPointerDown={slide}
          onDoubleClick={e => { e.stopPropagation(); setView(() => ({}), true) }}
          title="Drag to slide this shot in the frame, wheel to zoom it, double-click to put it back"
          style={{
          cursor: 'grab', position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', overflow: 'hidden',
          width: `min(100cqw, calc(100cqh * ${frame.aspect}))`, height: `min(100cqh, calc(100cqw / ${frame.aspect}))`,
          outline: '1px solid rgba(255,255,255,0.35)', outlineOffset: -1,
        }}>{shots}</div>
      ) : shots}
    </div>
  )
}

/** Where a shot's picture goes: the whole screen (no frame), or its place
 *  in the frame once its own size is known (until then, filled or fitted). */
function shotStyle(clip: RoughClip, frame: RoughCutData['frame'], size: { w: number; h: number } | null): React.CSSProperties {
  if (!frame || !size) return { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: frame?.fill ? 'cover' : 'contain' }
  const p = placeInFrame(size.w, size.h, frame.aspect, 1, frame.fill, clip.view)
  return {
    position: 'absolute', left: `${(p.x / frame.aspect) * 100}%`, top: `${p.y * 100}%`,
    width: `${(p.w / frame.aspect) * 100}%`, height: `${p.h * 100}%`, objectFit: 'fill', maxWidth: 'none',
  }
}
type ShotProps = { clip: RoughClip; frame: RoughCutData['frame']; onSize: (id: string, w: number, h: number) => void }

const ScreenVideo: React.FC<ShotProps & { visible: boolean; muted: boolean; volume: number; bind: (el: HTMLVideoElement | null) => void }> = ({ clip, visible, muted, volume, frame, onSize, bind }) => {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const src = useResolvedMedia(clip.url)
  const el = useRef<HTMLVideoElement | null>(null)
  useEffect(() => { if (el.current) el.current.volume = Math.max(0, Math.min(1, volume)) }, [volume, src])
  return (
    <video
      ref={v => { el.current = v; bind(v) }} src={src ?? undefined} muted={muted} playsInline preload="auto"
      onLoadedMetadata={e => {
        const v = e.currentTarget
        v.currentTime = clip.in
        if (v.videoWidth && v.videoHeight) { setSize({ w: v.videoWidth, h: v.videoHeight }); onSize(clip.id, v.videoWidth, v.videoHeight) }
      }}
      style={{ ...shotStyle(clip, frame, size), visibility: visible ? 'visible' : 'hidden' }}
    />
  )
}

const ScreenStill: React.FC<ShotProps> = ({ clip, frame, onSize }) => {
  const src = useResolvedMedia(clip.poster ?? clip.url)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  return src ? <img src={src} alt="" draggable={false}
    onLoad={e => { const i = e.currentTarget; if (i.naturalWidth && i.naturalHeight) { setSize({ w: i.naturalWidth, h: i.naturalHeight }); onSize(clip.id, i.naturalWidth, i.naturalHeight) } }}
    style={shotStyle(clip, frame, size)} /> : null
}

/** The Rough Cut a Viewer touches (magneted to any of its edges), if any. */
export function roughCutOnViewer(win: ViewportWindow3D, nodes: Record<string, FreeNodeData>, windows: Record<string, ViewportWindow3D>, zoom: number): FreeNodeData | null {
  for (const n of Object.values(nodes)) {
    if (n.type === 'roughCut' && viewerAdjacentTo(n, windows, zoom)?.id === win.id) return n
  }
  return null
}

/** Start or stop a Rough Cut playing (from its start again once at its end). */
export function playRoughCut(cutId: string, on: boolean): void {
  const st = useCutPlay.getState()
  if (!on) { if (st.playing === cutId) st.setPlaying(null); return }
  const n = useFreeNodeStore.getState().nodes[cutId]
  const total = cutLength(placed(n?.roughCut?.clips ?? []))
  if ((st.t[cutId] ?? 0) >= total - 0.01) st.setT(cutId, 0)
  st.setPlaying(cutId)
}

/** A Viewer touching a Rough Cut plays the movie: the cut at its playhead. */
/** `corner` and `edge`: the Viewer's resize grips (its size, in its units), which its player bar keeps clear of. */
export const RoughCutViewerOverlay: React.FC<{ windowId: string; fontSize: number; corner?: number; edge?: number }> = ({ windowId, fontSize, corner = 0, edge = 0 }) => {
  const zoom = useCanvasStore(s => s.zoom)
  const nodes = useFreeNodeStore(s => s.nodes)
  const windows = useViewport3DStore(s => s.windows)
  const win = windows[windowId]
  const cut = win ? roughCutOnViewer(win, nodes, windows, zoom) : null
  const playing = useCutPlay(s => !!cut && s.playing === cut.id)
  const t = useCutPlay(s => (cut ? s.t[cut.id] ?? 0 : 0))
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  if (!cut) return null
  const clips = placed(cut.roughCut?.clips ?? [])
  const total = cutLength(clips)
  const picked = !!clipAt(clips, t)?.clip.pick
  const barBtn = (lit: boolean, color: string): React.CSSProperties => ({
    fontSize, padding: `0 ${fontSize * 0.6}px`, height: fontSize * 1.8, borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
    color: '#fff', background: lit ? color : 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)',
  })
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  // The scrub line: press or drag to put the playhead there.
  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const at = (x: number) => Math.max(0, Math.min(total, ((x - r.left) / Math.max(1, r.width)) * total))
    playRoughCut(cut.id, false)
    useCutPlay.getState().setT(cut.id, at(e.clientX))
    const move = (m: PointerEvent) => useCutPlay.getState().setT(cut.id, at(m.clientX))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // The volume line: press or drag to set how loud.
  const loud = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const at = (x: number) => Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width)))
    setVolume(at(e.clientX))
    setMuted(false)
    const move = (m: PointerEvent) => setVolume(at(m.clientX))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const barH = Math.round(fontSize * 2.6)
  return (
    <div data-rough-viewer={cut.id} onPointerDown={stop} onWheel={stop} onDoubleClick={stop}
      style={{ position: 'absolute', inset: 0, zIndex: 5, background: '#000', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 6px', height: Math.round(fontSize * 2.2), boxSizing: 'border-box', flexShrink: 0, fontSize, color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.05)', whiteSpace: 'nowrap', overflow: 'hidden' }}>
        <span style={{ color: '#ffb35c' }}>✂</span>
        <span>{cut.label || 'Rough Cut'}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <RoughCutScreen cutId={cut.id} clips={clips} muted={muted} volume={volume} frame={shownFrame(cut.roughCut)} />
      </div>
      {/* The player's bar: play, where it is, how loud, and Pick. */}
      <div data-rough-viewer-bar="" style={{ display: 'flex', alignItems: 'center', gap: fontSize * 0.6, padding: `0 ${Math.max(fontSize * 0.5, corner)}px ${edge}px ${Math.max(fontSize * 0.5, edge)}px`, height: barH + edge, boxSizing: 'border-box', flexShrink: 0, fontSize, color: 'rgba(255,255,255,0.85)', background: 'rgba(255,255,255,0.06)', whiteSpace: 'nowrap' }}>
        <button data-rough-viewer-play="" onClick={() => playRoughCut(cut.id, !playing)} title="Play or pause"
          style={barBtn(playing, 'rgba(255,179,92,0.45)')}>Play</button>
        <div data-rough-viewer-scrub="" onPointerDown={scrub} title="Drag to move through the cut"
          style={{ flex: 1, minWidth: fontSize * 3, height: barH, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
          <div style={{ position: 'relative', width: '100%', height: Math.max(3, fontSize * 0.3), borderRadius: 3, background: 'rgba(255,255,255,0.2)' }}>
            {/* The picked shots, gold, along the line */}
            {total > 0 && clips.filter(c => c.pick).map(c => (
              <div key={c.id} style={{ position: 'absolute', top: 0, bottom: 0, left: `${(clipStart(c) / total) * 100}%`, width: `${((clipEnd(c) - clipStart(c)) / total) * 100}%`, background: 'rgba(255,200,80,0.7)' }} />
            ))}
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${total ? (t / total) * 100 : 0}%`, background: '#ff5a4f', borderRadius: 3 }} />
            <div style={{ position: 'absolute', top: '50%', left: `${total ? (t / total) * 100 : 0}%`, width: fontSize * 0.8, height: fontSize * 0.8, marginLeft: -fontSize * 0.4, marginTop: -fontSize * 0.4, borderRadius: '50%', background: '#fff' }} />
          </div>
        </div>
        <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtTime(t)} / {fmtTime(total)}</span>
        <button data-rough-viewer-mute="" onClick={() => setMuted(m => !m)} title="Sound off / on"
          style={barBtn(muted, 'rgba(255,90,79,0.45)')}>Mute</button>
        <div data-rough-viewer-volume="" onPointerDown={loud} title="Volume"
          style={{ width: fontSize * 5, flexShrink: 0, height: barH, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
          <div style={{ position: 'relative', width: '100%', height: Math.max(3, fontSize * 0.3), borderRadius: 3, background: 'rgba(255,255,255,0.2)' }}>
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${(muted ? 0 : volume) * 100}%`, background: '#ffb35c', borderRadius: 3 }} />
          </div>
        </div>
        <button data-rough-viewer-frame="" onClick={() => { if (cut.roughCut?.frame) setRoughCut(cut.id, { frameShown: cut.roughCut.frameShown === false }, false) }}
          title="Show the shots in the Rough Cut's frame, or whole (set the frame on the Rough Cut)"
          style={{ ...barBtn(!!shownFrame(cut.roughCut), 'rgba(111,179,255,0.45)'), opacity: cut.roughCut?.frame ? 1 : 0.45 }}>Frame</button>
        <button data-rough-viewer-pick="" onClick={() => togglePickAt(cut.id, useCutPlay.getState().t[cut.id] ?? 0)}
          title="Pick the shot playing now, or unpick it"
          style={barBtn(picked, 'rgba(255,200,80,0.45)')}>Pick</button>
      </div>
    </div>
  )
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60), r = s - m * 60
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`
}

/** The Rough Cut's Viewer button: the Viewer touching it comes forward, or a
 *  new one is made flush against its right end, as tall as it. */
export function openRoughCutViewer(cutId: string): void {
  const n = useFreeNodeStore.getState().nodes[cutId]
  if (!n || n.type !== 'roughCut') return
  const zoom = useCanvasStore.getState().zoom
  const v3 = useViewport3DStore.getState()
  let id = viewerAdjacentTo(n, v3.windows, zoom)?.id
  if (id) { v3.raiseWindow(id) } else {
    useUndoCoordinator.getState().checkpoint()
    const header = VIEWPORT_HEADER_SCREEN_H / Math.max(0.01, zoom)
    const height = Math.max(VIEWPORT3D_MIN_H, n.height - header)
    id = v3.addWindow(n.x + n.width, n.y + header)
    v3.updateWindow(id, { width: Math.max(VIEWPORT3D_MIN_W, height * 16 / 9), height })
  }
  const shown = useViewport3DStore.getState()
  shown.setViewerSelection([id])
  const vr = viewportVisualRect(shown.windows[id], zoom)
  const { pan } = useCanvasStore.getState()
  const left = pan.x + vr.x * zoom, top = pan.y + vr.y * zoom
  if (left < 0 || top < 0 || left + vr.width * zoom > window.innerWidth || top + vr.height * zoom > window.innerHeight) {
    useCanvasStore.getState().jumpToPoint(vr.x + vr.width / 2, vr.y + vr.height / 2)
  }
}
