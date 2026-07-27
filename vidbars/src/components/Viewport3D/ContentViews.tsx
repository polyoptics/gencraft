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
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { useBoardsStore } from '../../store/boardsStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import {
  DEFAULT_HEADER_STYLE, DEFAULT_BODY_STYLE, type TextStyle,
} from '../../store/freeNodeStore'
import {
  ensureFontLoaded, hexToRgba, loadGoogleFont,
  FONT_LIST, FONT_SIZES, LINE_HEIGHTS, PRESET_COLORS,
} from '../UI/TextFormatToolbar'
import { useUndoCoordinator } from '../../store/undoCoordinator'

export const ContentView: React.FC<{ windowId: string; item: ActiveItem; zoom: number }> = ({ windowId, item, zoom }) => {
  if (item.kind === 'text') {
    return <CounterScaled zoom={zoom}><TextView windowId={windowId} sourceId={item.sourceId} name={item.name} /></CounterScaled>
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

// ── Image ── the Viewer's mini IMAGE EDITOR. Three modes:
//   view  — pan/zoom (wheel 1–8×, drag when zoomed, dblclick reset)
//   crop  — drag a marquee, Apply bakes the region to a new blob
//   paint — freehand brush (color + size), Apply bakes strokes in
// Bakes write a NEW blob to the media store and rewrite the old url at
// every source (replaceMediaUrl) after a checkpoint — undo restores the
// original everywhere. Crop/paint work in the CounterScaled plane so all
// coordinates are screen-true.
interface ImgViewState { scale: number; tx: number; ty: number }
const imgViews = new Map<string, ImgViewState>()

type ImgMode = 'view' | 'crop' | 'paint'
interface PaintStroke { color: string; size: number; pts: { x: number; y: number }[] }

const PAINT_COLORS = ['#ffffff', '#f87171', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#111318']

/** Contain-fit box of a natural iw×ih image inside a w×h container. */
function fitBox(w: number, h: number, iw: number, ih: number) {
  const s = Math.min(w / iw, h / ih)
  const dw = iw * s, dh = ih * s
  return { s, dw, dh, ox: (w - dw) / 2, oy: (h - dh) / 2 }
}

const ImageView: React.FC<{ windowId: string; url: string; zoom: number }> = ({ windowId, url, zoom }) => {
  // The editor lives in a CounterScaled plane so pointer math is 1:1
  // screen pixels regardless of canvas zoom.
  return (
    <CounterScaled zoom={zoom}>
      <ImageEditor windowId={windowId} url={url} />
    </CounterScaled>
  )
}

const ImageEditor: React.FC<{ windowId: string; url: string }> = ({ windowId, url }) => {
  const resolved = useResolvedMedia(url)
  const key = `${windowId}|${url}`
  const [, bump] = useState(0)
  const [mode, setMode] = useState<ImgMode>('view')
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [strokes, setStrokes] = useState<PaintStroke[]>([])
  const [brushColor, setBrushColor] = useState(PAINT_COLORS[1])
  const [brushSize, setBrushSize] = useState(6)
  const [busy, setBusy] = useState(false)
  const areaRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const dragLast = useRef<{ x: number; y: number } | null>(null)
  const cropStart = useRef<{ x: number; y: number } | null>(null)
  const painting = useRef(false)

  const view = imgViews.get(key) ?? { scale: 1, tx: 0, ty: 0 }
  const setView = (v: ImgViewState) => { imgViews.set(key, v); bump(n => n + 1) }

  const enterMode = (m: ImgMode) => {
    setView({ scale: 1, tx: 0, ty: 0 })   // crop/paint operate on the fitted image
    setCropRect(null)
    setStrokes([])
    setMode(m)
  }

  // Local coords relative to the image AREA (below the toolbar).
  const localPoint = (e: React.PointerEvent) => {
    const r = areaRef.current!.getBoundingClientRect()
    // getBoundingClientRect is in SCREEN px; the CounterScaled plane is
    // also screen-true, so divide by the on-screen scale of this plane:
    const sx = r.width / areaRef.current!.offsetWidth
    return { x: (e.clientX - r.left) / sx, y: (e.clientY - r.top) / sx }
  }

  const onDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const p = localPoint(e)
    if (mode === 'crop') {
      cropStart.current = p
      setCropRect({ x: p.x, y: p.y, w: 0, h: 0 })
    } else if (mode === 'paint') {
      painting.current = true
      setStrokes(s => [...s, { color: brushColor, size: brushSize, pts: [p] }])
    } else {
      dragLast.current = { x: e.clientX, y: e.clientY }
    }
  }, [mode, brushColor, brushSize])

  const onMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const p = localPoint(e)
    if (mode === 'crop' && cropStart.current) {
      const s = cropStart.current
      setCropRect({
        x: Math.min(s.x, p.x), y: Math.min(s.y, p.y),
        w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y),
      })
    } else if (mode === 'paint' && painting.current) {
      setStrokes(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        next[next.length - 1] = { ...last, pts: [...last.pts, p] }
        return next
      })
    } else if (mode === 'view' && dragLast.current) {
      setView({ ...view, tx: view.tx + (e.clientX - dragLast.current.x), ty: view.ty + (e.clientY - dragLast.current.y) })
      dragLast.current = { x: e.clientX, y: e.clientY }
    }
  }, [mode, view])

  const onUp = useCallback(() => {
    dragLast.current = null
    cropStart.current = null
    painting.current = false
  }, [])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()
    if (mode !== 'view') return
    const next = Math.min(8, Math.max(1, view.scale * (e.deltaY > 0 ? 1 / 1.1 : 1.1)))
    setView(next === 1 ? { scale: 1, tx: 0, ty: 0 } : { ...view, scale: next })
  }, [mode, view])

  /** Bake crop and/or strokes into a new blob and rewrite the url at
   *  every source. */
  const applyEdit = useCallback(async () => {
    const img = imgRef.current
    const area = areaRef.current
    if (!img || !area || !natural || busy) return
    const fit = fitBox(area.offsetWidth, area.offsetHeight, natural.w, natural.h)
    // Region in NATURAL pixels
    let sx = 0, sy = 0, sw = natural.w, sh = natural.h
    if (mode === 'crop') {
      if (!cropRect || cropRect.w < 4 || cropRect.h < 4) return
      sx = Math.max(0, Math.round((cropRect.x - fit.ox) / fit.s))
      sy = Math.max(0, Math.round((cropRect.y - fit.oy) / fit.s))
      sw = Math.min(natural.w - sx, Math.round(cropRect.w / fit.s))
      sh = Math.min(natural.h - sy, Math.round(cropRect.h / fit.s))
      if (sw < 2 || sh < 2) return
    }
    setBusy(true)
    try {
      const cnv = document.createElement('canvas')
      cnv.width = sw; cnv.height = sh
      const ctx = cnv.getContext('2d')!
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
      if (mode === 'paint' && strokes.length > 0) {
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        for (const st of strokes) {
          ctx.strokeStyle = st.color
          ctx.lineWidth = st.size / fit.s
          ctx.beginPath()
          st.pts.forEach((p, i) => {
            const nx = (p.x - fit.ox) / fit.s - sx
            const ny = (p.y - fit.oy) / fit.s - sy
            if (i === 0) ctx.moveTo(nx, ny); else ctx.lineTo(nx, ny)
          })
          ctx.stroke()
        }
      }
      const blob = await new Promise<Blob | null>(res => cnv.toBlob(res, 'image/png'))
      if (!blob) return
      const { putMedia } = await import('../../utils/mediaStore')
      const { makeMediaRef } = await import('../../utils/mediaRef')
      const { replaceMediaUrl } = await import('../../utils/mediaReplace')
      const newRef = makeMediaRef(await putMedia(blob))
      useUndoCoordinator.getState().checkpoint()
      replaceMediaUrl(url, newRef)
      // Point this window at the new item (same identity, new bytes)
      const win = useViewport3DStore.getState().windows[windowId]
      const prev = win?.activeItem
      useViewport3DStore.getState().setActiveItem(windowId, {
        kind: 'media', mediaType: 'image', url: newRef,
        name: prev?.kind === 'media' ? prev.name : undefined,
      })
      enterMode('view')
    } catch (err) {
      // e.g. a cross-origin image tainting the canvas — keep the edit
      // state so the user can Cancel; nothing was written.
      console.warn('[image-editor] apply failed', err)
    } finally {
      setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cropRect, strokes, natural, url, windowId, busy])

  if (!resolved) return <Centered>Loading…</Centered>

  const modeBtn = (m: ImgMode, label: string, title: string) => (
    <button key={m} style={tbBtn(mode === m)} title={title} onClick={() => enterMode(m)}>{label}</button>
  )

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div
        onPointerDown={e => e.stopPropagation()}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap',
          padding: '6px 10px', background: 'rgba(20,22,38,0.95)',
          borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
        }}
      >
        {modeBtn('view', '⤢', 'View: wheel zoom · drag pan · dblclick reset')}
        {modeBtn('crop', '⿻', 'Crop: drag a region, then Apply')}
        {modeBtn('paint', '✎', 'Paint: brush over the image, then Apply')}
        {mode === 'paint' && (
          <>
            <div style={{ display: 'flex', gap: 3, alignItems: 'center', marginLeft: 4 }}>
              {PAINT_COLORS.map(c => (
                <div key={c} onClick={() => setBrushColor(c)} title={c} style={{
                  width: 13, height: 13, borderRadius: '50%', background: c, cursor: 'pointer',
                  border: brushColor === c ? '2px solid rgba(140,190,255,0.9)' : '1px solid rgba(0,0,0,0.4)',
                }} />
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button style={tbBtn(false)} onClick={() => setBrushSize(s => Math.max(2, s - 2))}>−</button>
              <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.75)', minWidth: 16, textAlign: 'center' }}>{brushSize}</span>
              <button style={tbBtn(false)} onClick={() => setBrushSize(s => Math.min(40, s + 2))}>+</button>
            </div>
          </>
        )}
        {(mode === 'crop' || mode === 'paint') && (
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
            <button
              style={{ ...tbBtn(true), opacity: busy ? 0.5 : 1 }}
              disabled={busy}
              onClick={() => void applyEdit()}
              title={mode === 'crop' ? 'Bake the cropped region' : 'Bake the paint into the image'}
            >{busy ? '…' : 'Apply'}</button>
            <button style={tbBtn(false)} onClick={() => enterMode('view')} title="Discard">Cancel</button>
          </div>
        )}
      </div>
      {/* Image area */}
      <div
        ref={areaRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={onWheel}
        onDoubleClick={() => { if (mode === 'view') setView({ scale: 1, tx: 0, ty: 0 }) }}
        style={{
          flex: 1, position: 'relative', overflow: 'hidden',
          cursor: mode === 'crop' ? 'crosshair' : mode === 'paint' ? 'crosshair' : view.scale > 1 ? 'grab' : 'default',
          touchAction: 'none',
        }}
      >
        <img
          ref={imgRef}
          src={resolved}
          draggable={false}
          onLoad={e => {
            const el = e.currentTarget
            setNatural({ w: el.naturalWidth, h: el.naturalHeight })
          }}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            objectFit: 'contain',
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
          }}
        />
        {/* Paint overlay (SVG — crisp, cheap, screen-space coords) */}
        {mode === 'paint' && strokes.length > 0 && (
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            {strokes.map((st, i) => (
              <polyline
                key={i}
                points={st.pts.map(p => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke={st.color}
                strokeWidth={st.size}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </svg>
        )}
        {/* Crop marquee */}
        {mode === 'crop' && cropRect && (
          <div style={{
            position: 'absolute',
            left: cropRect.x, top: cropRect.y, width: cropRect.w, height: cropRect.h,
            border: '1.5px dashed rgba(140,190,255,0.9)',
            background: 'rgba(120,170,255,0.12)',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
            pointerEvents: 'none',
          }} />
        )}
      </div>
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
function textBlockCss(ts: TextStyle, scale = 1): React.CSSProperties {
  return {
    fontSize: ts.fontSize * scale,
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

/** The Viewer's mini TEXT EDITOR: both text blocks (header where the
 *  source has one, body) are directly editable, writing back LIVE to the
 *  source bar/card/tile; the toolbar styles whichever block was last
 *  focused. checkpoint() on focus = one undo step per editing session. */
const TextView: React.FC<{ windowId: string; sourceId: string; name?: string }> = ({ windowId, sourceId, name }) => {
  const [kind, a, b] = sourceId.split(':')
  const group = useBoardsStore(s => (kind === 'group' ? s.groups.find(g => g.id === a) : undefined))
  const bar = useBoardsStore(s => (kind === 'bar' ? s.boards[a]?.bars[b] : undefined))
  const tile = useFreeNodeStore(s => (kind === 'tile' ? s.nodes[a] : undefined))
  const [target, setTarget] = useState<'header' | 'body'>('body')
  // VIEW-only zoom: how big text renders in THIS window. Never written
  // back to the card.
  const textScale = useViewport3DStore(s => s.windows[windowId]?.textScale ?? 1)
  const setTextScale = useViewport3DStore(s => s.setTextScale)

  if (!group && !bar && !tile) return <Centered>(content removed)</Centered>

  const hasHeader = !!group || !!bar
  const headerText = group ? (group.cardHeaderText ?? '') : bar ? (bar.content?.headerText ?? '') : ''
  const bodyText = group ? (group.cardText ?? '') : bar ? (bar.content?.text ?? '') : (tile?.text ?? '')
  const headerStyle: TextStyle = {
    ...DEFAULT_HEADER_STYLE,
    ...(group ? group.cardHeaderTextStyle : bar?.content?.headerTextStyle),
  }
  const bodyStyle: TextStyle = {
    ...DEFAULT_BODY_STYLE,
    ...(group ? group.cardTextStyle : bar ? bar.content?.textStyle : tile?.textStyle),
  }
  ensureFontLoaded(headerStyle.fontFamily)
  ensureFontLoaded(bodyStyle.fontFamily)

  const writeText = (block: 'header' | 'body', text: string) => {
    const bs = useBoardsStore.getState()
    if (group) {
      if (block === 'header') bs.setGroupCardHeaderText(group.id, text)
      else bs.setGroupCardText(group.id, text)
    } else if (bar) {
      bs.setContent(a, b, block === 'header' ? { headerText: text } : { text })
    } else if (tile) {
      useFreeNodeStore.getState().updateFreeNode(tile.id, { text })
    }
  }
  const writeStyle = (patch: Partial<TextStyle>) => {
    const block = hasHeader ? target : 'body'
    const merged = { ...(block === 'header' ? headerStyle : bodyStyle), ...patch }
    const bs = useBoardsStore.getState()
    if (group) {
      if (block === 'header') bs.setGroupCardHeaderTextStyle(group.id, merged)
      else bs.setGroupCardTextStyle(group.id, merged)
    } else if (bar) {
      bs.setContent(a, b, block === 'header' ? { headerTextStyle: merged } : { textStyle: merged })
    } else if (tile) {
      useFreeNodeStore.getState().updateFreeNode(tile.id, { textStyle: merged })
    }
  }
  const activeStyle = (hasHeader && target === 'header') ? headerStyle : bodyStyle

  const areaCss = (ts: TextStyle, minH: number): React.CSSProperties => ({
    ...textBlockCss(ts, textScale),
    width: '100%', minHeight: minH,
    border: 'none', outline: 'none', resize: 'vertical',
    padding: '8px 10px', borderRadius: 6,
    background: hexToRgba(ts.bgColor, Math.max(ts.bgOpacity, 0.06)),
    cursor: 'text',
  })

  return (
    <div
      onWheel={e => e.stopPropagation()}
      style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#12131f' }}
    >
      <TextToolbar
        style={activeStyle}
        target={hasHeader ? target : null}
        setTarget={setTarget}
        onStyle={writeStyle}
        textScale={textScale}
        setTextScale={s => setTextScale(windowId, s)}
      />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', padding: '14px 22px 60px' }}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '1.2px', textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.32)', margin: '4px 0 10px',
          }}>{name ?? 'Text'}</div>
          {hasHeader && (
            <textarea
              value={headerText}
              placeholder="Header…"
              spellCheck={false}
              onFocus={() => { setTarget('header'); useUndoCoordinator.getState().checkpoint() }}
              onChange={e => writeText('header', e.target.value)}
              onPointerDown={e => e.stopPropagation()}
              onKeyDown={e => e.stopPropagation()}
              style={{ ...areaCss(headerStyle, 54), marginBottom: 12 }}
            />
          )}
          <textarea
            value={bodyText}
            placeholder="Write…"
            spellCheck={false}
            onFocus={() => { setTarget('body'); useUndoCoordinator.getState().checkpoint() }}
            onChange={e => writeText('body', e.target.value)}
            onPointerDown={e => e.stopPropagation()}
            onKeyDown={e => e.stopPropagation()}
            style={areaCss(bodyStyle, 220)}
          />
        </div>
      </div>
    </div>
  )
}

// ── Text toolbar — compact single row: block toggle, font, size, bold/
//    italic, align, color, line-height. Styles the focused block. ──
const tbBtn = (active: boolean): React.CSSProperties => ({
  background: active ? 'rgba(120,170,255,0.25)' : 'rgba(255,255,255,0.05)',
  border: `1px solid ${active ? 'rgba(140,190,255,0.5)' : 'rgba(255,255,255,0.1)'}`,
  borderRadius: 4, color: active ? '#fff' : 'rgba(255,255,255,0.6)',
  fontSize: 11, fontWeight: 700, lineHeight: 1,
  padding: '4px 7px', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
})

const TextToolbar: React.FC<{
  style: TextStyle
  target: 'header' | 'body' | null   // null → single-block source
  setTarget: (t: 'header' | 'body') => void
  onStyle: (patch: Partial<TextStyle>) => void
  textScale: number
  setTextScale: (s: number) => void
}> = ({ style, target, setTarget, onStyle, textScale, setTextScale }) => {
  const [showCardStyles, setShowCardStyles] = useState(false)
  const checkpointOnce = () => useUndoCoordinator.getState().checkpoint()
  const stepSize = (dir: 1 | -1) => {
    const cur = style.fontSize
    const idx = FONT_SIZES.findIndex(s => s >= cur)
    const at = idx < 0 ? FONT_SIZES.length - 1 : idx
    const next = FONT_SIZES[Math.max(0, Math.min(FONT_SIZES.length - 1, at + dir))]
    checkpointOnce(); onStyle({ fontSize: next })
  }
  const cycleAlign = () => {
    const order: TextStyle['align'][] = ['left', 'center', 'right']
    checkpointOnce()
    onStyle({ align: order[(order.indexOf(style.align) + 1) % order.length] })
  }
  const cycleLineHeight = () => {
    const cur = style.lineHeight ?? 1.55
    const idx = LINE_HEIGHTS.findIndex(l => l >= cur)
    const at = idx < 0 ? LINE_HEIGHTS.length - 1 : idx
    checkpointOnce()
    onStyle({ lineHeight: LINE_HEIGHTS[(at + 1) % LINE_HEIGHTS.length] })
  }
  return (
    <div
      onPointerDown={e => e.stopPropagation()}
      style={{
        display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap',
        padding: '6px 10px', background: 'rgba(20,22,38,0.95)',
        borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
      }}
    >
      {/* ── VIEW ZOOM — how big text renders HERE. Never edits the card. ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 3,
        padding: '2px 6px 2px 4px', borderRadius: 5,
        background: 'rgba(120,170,255,0.10)', border: '1px solid rgba(140,190,255,0.25)',
      }}>
        <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.4px', color: 'rgba(170,205,255,0.85)' }}>VIEW</span>
        <button style={tbBtn(false)} onClick={() => setTextScale(textScale / 1.15)} title="Show more text (view only)">A−</button>
        <span
          onClick={() => setTextScale(1)}
          title="Reset view zoom to 100%"
          style={{ fontSize: 10, color: 'rgba(255,255,255,0.8)', minWidth: 30, textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
        >{Math.round(textScale * 100)}%</span>
        <button style={tbBtn(false)} onClick={() => setTextScale(textScale * 1.15)} title="Bigger text (view only)">A+</button>
      </div>

      {/* ── Card-style editing — collapsed by default so the view zoom
             above is the easy reach and card fonts aren't changed by
             accident. ── */}
      <button
        style={tbBtn(showCardStyles)}
        onClick={() => setShowCardStyles(v => !v)}
        title="Edit the CARD's own fonts and styling (changes the card everywhere)"
      >✎ Card style</button>
      {!showCardStyles ? null : <>
      {target !== null && (
        <div style={{ display: 'flex', gap: 2, marginRight: 3 }}>
          <button style={{ ...tbBtn(target === 'header'), fontSize: 9.5 }} onClick={() => setTarget('header')} title="Style the header block">Hdr</button>
          <button style={{ ...tbBtn(target === 'body'), fontSize: 9.5 }} onClick={() => setTarget('body')} title="Style the body block">Body</button>
        </div>
      )}
      <select
        value={style.fontFamily || FONT_LIST[0].value}
        onChange={e => {
          const f = FONT_LIST.find(x => x.value === e.target.value)
          if (f?.google) loadGoogleFont(f.value)
          checkpointOnce(); onStyle({ fontFamily: e.target.value })
        }}
        style={{
          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 4, color: 'rgba(255,255,255,0.8)', fontSize: 10.5,
          padding: '3px 4px', maxWidth: 110, fontFamily: 'inherit',
        }}
      >
        {FONT_LIST.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <button style={tbBtn(false)} onClick={() => stepSize(-1)} title="Smaller">−</button>
        <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.75)', minWidth: 20, textAlign: 'center' }}>{style.fontSize}</span>
        <button style={tbBtn(false)} onClick={() => stepSize(1)} title="Bigger">+</button>
      </div>
      <button style={{ ...tbBtn(style.bold), fontWeight: 900 }} onClick={() => { checkpointOnce(); onStyle({ bold: !style.bold }) }} title="Bold">B</button>
      <button style={{ ...tbBtn(style.italic), fontStyle: 'italic' }} onClick={() => { checkpointOnce(); onStyle({ italic: !style.italic }) }} title="Italic">I</button>
      <button style={tbBtn(false)} onClick={cycleAlign} title={`Align: ${style.align}`}>
        {style.align === 'left' ? '⇤' : style.align === 'center' ? '⇔' : '⇥'}
      </button>
      <button style={tbBtn(false)} onClick={cycleLineHeight} title={`Line height: ${style.lineHeight ?? 1.55}`}>↕</button>
      <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
        {PRESET_COLORS.map(c => (
          <div
            key={c}
            onClick={() => { checkpointOnce(); onStyle({ color: c }) }}
            title={c}
            style={{
              width: 13, height: 13, borderRadius: '50%', background: c, cursor: 'pointer',
              border: style.color === c ? '2px solid rgba(140,190,255,0.9)' : '1px solid rgba(0,0,0,0.4)',
            }}
          />
        ))}
      </div>
      </>}
    </div>
  )
}
