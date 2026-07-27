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

import React, { useRef, useState, useEffect } from 'react'
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
import { ImageStudio } from './ImageStudio'

export const ContentView: React.FC<{ windowId: string; item: ActiveItem; zoom: number }> = ({ windowId, item, zoom }) => {
  if (item.kind === 'text') {
    return <CounterScaled zoom={zoom}><TextView windowId={windowId} sourceId={item.sourceId} name={item.name} /></CounterScaled>
  }
  switch (item.mediaType) {
    case 'image':
      return (
        <CounterScaled zoom={zoom}>
          <ImageStudio windowId={windowId} url={item.url} name={item.name} />
        </CounterScaled>
      )
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
