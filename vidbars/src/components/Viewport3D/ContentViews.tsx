// ContentViews.tsx — the DOM renderers a content-browser window uses for
// non-model items: image (fit + wheel-zoom/drag-pan), video (<video>
// playback), audio (<audio>), and text (readable styled page resolved
// LIVE from the stores). Models render via the shared GL path and never
// reach these views.
//
// Video/audio/text are wrapped in CounterScaled so native controls and
// text render at screen-pixel size at any canvas zoom. The image view
// stays plain canvas-space (browsers rescale <img> crisply under the
// transform; pan/zoom is manual anyway).

import React, { useRef, useState, useEffect, useCallback } from 'react'
import type { ActiveItem } from '../../store/viewport3dStore'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { useBoardsStore } from '../../store/boardsStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import {
  DEFAULT_HEADER_STYLE, DEFAULT_BODY_STYLE, type TextStyle,
} from '../../store/freeNodeStore'
import { ensureFontLoaded, hexToRgba } from '../UI/TextFormatToolbar'

export const ContentView: React.FC<{ windowId: string; item: ActiveItem; zoom: number }> = ({ windowId, item, zoom }) => {
  if (item.kind === 'text') {
    return <CounterScaled zoom={zoom}><TextView sourceId={item.sourceId} name={item.name} /></CounterScaled>
  }
  switch (item.mediaType) {
    case 'image':
      return <ImageView windowId={windowId} url={item.url} zoom={zoom} />
    case 'video':
      return <CounterScaled zoom={zoom}><VideoView url={item.url} posterUrl={item.posterUrl ?? null} /></CounterScaled>
    case 'audio':
      return <CounterScaled zoom={zoom}><AudioView url={item.url} name={item.name} /></CounterScaled>
    default:
      return null   // 'model' — GL path owns it
  }
}

/** Child CSS px == screen px at any canvas zoom. Layout box still fills
 *  the body exactly. Factor clamped so extreme zoom-out doesn't create
 *  absurdly large layout surfaces. */
const CounterScaled: React.FC<{ zoom: number; children: React.ReactNode }> = ({ zoom, children }) => {
  const z = Math.max(zoom, 0.1)
  return (
    <div style={{
      position: 'absolute', left: 0, top: 0,
      width: `${z * 100}%`, height: `${z * 100}%`,
      transform: `scale(${1 / z})`, transformOrigin: 'top left',
    }}>{children}</div>
  )
}

const Centered: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
    justifyContent: 'center', color: 'rgba(255,255,255,0.35)', fontSize: 13,
  }}>{children}</div>
)

// ── Image ── fit-in-frame + wheel-zoom + drag-pan; transient module view
// state keyed per window+url (survives zoom-layer remounts, auto-resets
// per item, session-only).
interface ImgViewState { scale: number; tx: number; ty: number }
const imgViews = new Map<string, ImgViewState>()

const ImageView: React.FC<{ windowId: string; url: string; zoom: number }> = ({ windowId, url, zoom }) => {
  const resolved = useResolvedMedia(url)
  const key = `${windowId}|${url}`
  const [, bump] = useState(0)
  const view = imgViews.get(key) ?? { scale: 1, tx: 0, ty: 0 }
  const dragLast = useRef<{ x: number; y: number } | null>(null)

  const onDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    dragLast.current = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])
  const onMove = useCallback((e: React.PointerEvent) => {
    if (!dragLast.current || !(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const v = imgViews.get(key) ?? { scale: 1, tx: 0, ty: 0 }
    imgViews.set(key, {
      ...v,
      tx: v.tx + (e.clientX - dragLast.current.x) / zoom,
      ty: v.ty + (e.clientY - dragLast.current.y) / zoom,
    })
    dragLast.current = { x: e.clientX, y: e.clientY }
    bump(n => n + 1)
  }, [key, zoom])
  const onUp = useCallback(() => { dragLast.current = null }, [])
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()
    const v = imgViews.get(key) ?? { scale: 1, tx: 0, ty: 0 }
    const next = Math.min(8, Math.max(1, v.scale * (e.deltaY > 0 ? 1 / 1.1 : 1.1)))
    imgViews.set(key, next === 1 ? { scale: 1, tx: 0, ty: 0 } : { ...v, scale: next })
    bump(n => n + 1)
  }, [key])
  const onDoubleClick = useCallback(() => {
    imgViews.set(key, { scale: 1, tx: 0, ty: 0 })
    bump(n => n + 1)
  }, [key])

  if (!resolved) return <Centered>Loading…</Centered>
  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', cursor: view.scale > 1 ? 'grab' : 'default' }}
    >
      <img
        src={resolved}
        draggable={false}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          objectFit: 'contain',
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
        }}
      />
    </div>
  )
}

// ── Video ── native controls; key-forced teardown per item; explicit
// decode-pipeline release on unmount. No autoplay.
const VideoView: React.FC<{ url: string; posterUrl: string | null }> = ({ url, posterUrl }) => {
  const resolved = useResolvedMedia(url)
  const poster = useResolvedMedia(posterUrl)
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => () => {
    const v = ref.current
    if (v) { v.pause(); v.removeAttribute('src'); v.load() }
  }, [resolved])
  if (!resolved) return <Centered>Loading…</Centered>
  return (
    <video
      key={resolved}
      ref={ref}
      src={resolved}
      poster={poster ?? undefined}
      controls
      preload="metadata"
      playsInline
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        objectFit: 'contain', background: '#000',
      }}
    />
  )
}

// ── Audio ──
const AudioView: React.FC<{ url: string; name?: string }> = ({ url, name }) => {
  const resolved = useResolvedMedia(url)
  const ref = useRef<HTMLAudioElement>(null)
  useEffect(() => () => {
    const a = ref.current
    if (a) { a.pause(); a.removeAttribute('src'); a.load() }
  }, [resolved])
  if (!resolved) return <Centered>Loading…</Centered>
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 14,
    }}>
      <div style={{ fontSize: 44, color: 'rgba(160,200,255,0.5)' }}>♪</div>
      <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', maxWidth: '85%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {name ?? 'Audio'}
      </div>
      <audio key={resolved} ref={ref} src={resolved} controls style={{ width: '85%' }} />
    </div>
  )
}

// ── Text ── readable page, content resolved LIVE from the stores. Style
// merge mirrors RolodexCardPreview (defaults + saved styles + fonts).
function textBlockCss(ts: TextStyle): React.CSSProperties {
  return {
    fontSize: ts.fontSize,
    lineHeight: ts.lineHeight ?? 1.55,
    fontWeight: ts.fontWeight ?? (ts.bold ? 700 : 400),
    fontStyle: ts.italic ? 'italic' : 'normal',
    textAlign: ts.align,
    fontFamily: ts.fontFamily || 'inherit',
    letterSpacing: ts.letterSpacing ?? 0,
    textTransform: ts.textTransform ?? 'none',
    color: ts.color,
    background: hexToRgba(ts.bgColor, ts.bgOpacity),
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  }
}

const TextView: React.FC<{ sourceId: string; name?: string }> = ({ sourceId, name }) => {
  const [kind, a, b] = sourceId.split(':')
  const group = useBoardsStore(s => (kind === 'group' ? s.groups.find(g => g.id === a) : undefined))
  const bar = useBoardsStore(s => (kind === 'bar' ? s.boards[a]?.bars[b] : undefined))
  const tile = useFreeNodeStore(s => (kind === 'tile' ? s.nodes[a] : undefined))

  let headerText = '', bodyText = ''
  let headerStyle: TextStyle = DEFAULT_HEADER_STYLE
  let bodyStyle: TextStyle = DEFAULT_BODY_STYLE
  if (group) {
    headerText = group.cardHeaderText ?? ''
    bodyText = group.cardText ?? ''
    headerStyle = { ...DEFAULT_HEADER_STYLE, ...group.cardHeaderTextStyle }
    bodyStyle = { ...DEFAULT_BODY_STYLE, ...group.cardTextStyle }
  } else if (bar) {
    headerText = bar.content?.headerText ?? ''
    bodyText = bar.content?.text ?? ''
    headerStyle = { ...DEFAULT_HEADER_STYLE, ...bar.content?.headerTextStyle }
    bodyStyle = { ...DEFAULT_BODY_STYLE, ...bar.content?.textStyle }
  } else if (tile) {
    bodyText = tile.text
    bodyStyle = { ...DEFAULT_BODY_STYLE, ...tile.textStyle }
  } else {
    return <Centered>(content removed)</Centered>
  }
  ensureFontLoaded(headerStyle.fontFamily)
  ensureFontLoaded(bodyStyle.fontFamily)

  return (
    <div
      onWheel={e => e.stopPropagation()}
      style={{ position: 'absolute', inset: 0, overflowY: 'auto', background: '#12131f' }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '26px 30px 46px' }}>
        <div style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '1.2px', textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.32)', marginBottom: 14,
        }}>{name ?? 'Text'}</div>
        {headerText && (
          <div style={{ ...textBlockCss(headerStyle), marginBottom: 16 }}>{headerText}</div>
        )}
        {bodyText
          ? <div style={textBlockCss(bodyStyle)}>{bodyText}</div>
          : !headerText && <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 13 }}>(empty)</div>}
      </div>
    </div>
  )
}
