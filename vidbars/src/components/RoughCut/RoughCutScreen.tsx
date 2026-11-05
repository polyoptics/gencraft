// RoughCutScreen — what a Rough Cut shows at its playhead: the clip on the
// top row there, or black where there is none. Used by the Rough Cut's own
// preview and by a Viewer touching it (RoughCutViewerOverlay), which play the
// same playhead (useCutPlay, keyed by the Rough Cut's id).
//
// Each video near the playhead has its own <video>, loaded and waiting at its
// in point, so a cut lands on time instead of stalling while a file opens.

import React, { useEffect, useRef } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useViewport3DStore, VIEWPORT3D_MIN_H, VIEWPORT3D_MIN_W, type ViewportWindow3D } from '../../store/viewport3dStore'
import { viewerAdjacentTo } from '../../utils/componentLinks'
import { useCutPlay } from '../../utils/cutMedia'
import { clipAt, clipEnd, clipStart, cutLength, placed, type RoughClip } from '../../utils/roughCut'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { togglePickAt } from '../../utils/roughCutPicks'
import { VIEWPORT_HEADER_SCREEN_H, viewportVisualRect } from '../../utils/viewportDocking'

export const RoughCutScreen: React.FC<{ cutId: string; clips: RoughClip[]; muted: boolean }> = ({ cutId, clips, muted }) => {
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
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#000', overflow: 'hidden' }}>
      {near.map(c => (
        <ScreenVideo key={c.id} clip={c} visible={at?.clip.id === c.id} muted={muted}
          bind={el => { if (el) videos.current.set(c.id, el); else videos.current.delete(c.id) }} />
      ))}
      {at && at.clip.kind !== 'video' && <ScreenStill clip={at.clip} />}
    </div>
  )
}

const ScreenVideo: React.FC<{ clip: RoughClip; visible: boolean; muted: boolean; bind: (el: HTMLVideoElement | null) => void }> = ({ clip, visible, muted, bind }) => {
  const src = useResolvedMedia(clip.url)
  return (
    <video
      ref={bind} src={src ?? undefined} muted={muted} playsInline preload="auto"
      onLoadedMetadata={e => { e.currentTarget.currentTime = clip.in }}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', visibility: visible ? 'visible' : 'hidden' }}
    />
  )
}

const ScreenStill: React.FC<{ clip: RoughClip }> = ({ clip }) => {
  const src = useResolvedMedia(clip.poster ?? clip.url)
  return src ? <img src={src} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} /> : null
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
export const RoughCutViewerOverlay: React.FC<{ windowId: string; fontSize: number }> = ({ windowId, fontSize }) => {
  const zoom = useCanvasStore(s => s.zoom)
  const nodes = useFreeNodeStore(s => s.nodes)
  const windows = useViewport3DStore(s => s.windows)
  const win = windows[windowId]
  const cut = win ? roughCutOnViewer(win, nodes, windows, zoom) : null
  const playing = useCutPlay(s => !!cut && s.playing === cut.id)
  const t = useCutPlay(s => (cut ? s.t[cut.id] ?? 0 : 0))
  if (!cut) return null
  const clips = placed(cut.roughCut?.clips ?? [])
  const picked = !!clipAt(clips, t)?.clip.pick
  const barBtn = (lit: boolean, color: string): React.CSSProperties => ({
    fontSize, padding: `0 ${fontSize * 0.6}px`, height: fontSize * 1.7, borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
    color: '#fff', background: lit ? color : 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)',
  })
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <div data-rough-viewer={cut.id} onPointerDown={stop} onWheel={stop} onDoubleClick={stop}
      style={{ position: 'absolute', inset: 0, zIndex: 5, background: '#000', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 6px', height: Math.round(fontSize * 2.2), boxSizing: 'border-box', flexShrink: 0, fontSize, color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.05)', whiteSpace: 'nowrap', overflow: 'hidden' }}>
        <span style={{ color: '#ffb35c' }}>✂</span>
        <span>{cut.label || 'Rough Cut'}</span>
        <button data-rough-viewer-play="" onClick={() => playRoughCut(cut.id, !playing)}
          style={{ ...barBtn(playing, 'rgba(255,179,92,0.45)'), marginLeft: 'auto' }}>
          Play
        </button>
        <button data-rough-viewer-pick="" onClick={() => togglePickAt(cut.id, useCutPlay.getState().t[cut.id] ?? 0)}
          title="Pick the shot playing now, or unpick it"
          style={barBtn(picked, 'rgba(255,200,80,0.45)')}>
          Pick
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <RoughCutScreen cutId={cut.id} clips={clips} muted={false} />
      </div>
    </div>
  )
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
