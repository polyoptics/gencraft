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
import { useViewport3DStore, textItemKey } from '../../store/viewport3dStore'
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
import { useTextVersionStore, type TextVersion } from '../../store/textVersionStore'
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
export const CounterScaled: React.FC<{ zoom: number; children: React.ReactNode }> = ({ zoom, children }) => {
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
  const [showVersions, setShowVersions] = useState(false)
  // VIEW-only zoom, remembered PER PAGE: a page you have adjusted keeps
  // its own size, the rest follow this window's reading size. Never
  // written back to the card. Keyed off the RENDERED sourceId rather than
  // the store's live activeItem — strip reconciliation can swap that
  // under us, and this is the page actually on screen.
  const itemKey = textItemKey(sourceId)
  const textScale = useViewport3DStore(s => {
    const w = s.windows[windowId]
    return w?.textScales?.[itemKey] ?? w?.defaultTextScale ?? 1
  })
  const pinned = useViewport3DStore(s => s.windows[windowId]?.textScales?.[itemKey] !== undefined)
  const setTextScale = useViewport3DStore(s => s.setTextScale)
  const clearTextScale = useViewport3DStore(s => s.clearTextScale)

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

  // The page IS the window: blocks are edge-to-edge and transparent, and
  // they auto-grow so the WINDOW is the only scroller — scrolling the
  // viewer scrolls the document, with no inner text box.
  const blockCss = (ts: TextStyle): React.CSSProperties => ({
    ...textBlockCss(ts, textScale),
    display: 'block', width: '100%',
    border: 'none', outline: 'none', resize: 'none', overflow: 'hidden',
    padding: 0, margin: 0,
    background: ts.bgOpacity > 0 ? hexToRgba(ts.bgColor, ts.bgOpacity) : 'transparent',
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
        pinned={pinned}
        setTextScale={s => setTextScale(windowId, itemKey, s)}
        unpin={() => clearTextScale(windowId, itemKey)}
        showVersions={showVersions}
        toggleVersions={() => setShowVersions(v => !v)}
      />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* The page — one scroll surface, full width of the window */}
        <div style={{ flex: 1, overflowY: 'auto', minWidth: 0 }}>
          <div style={{ padding: '16px 26px 64px' }}>
            <div style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '1.2px', textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.28)', marginBottom: 12,
            }}>{name ?? 'Text'}</div>
            {hasHeader && (
              <AutoTextarea
                value={headerText}
                placeholder="Header…"
                grow={[textScale, headerStyle.fontSize, showVersions]}
                onFocus={() => { setTarget('header'); useUndoCoordinator.getState().checkpoint() }}
                onChange={v => writeText('header', v)}
                style={{ ...blockCss(headerStyle), marginBottom: 14 }}
              />
            )}
            <AutoTextarea
              value={bodyText}
              placeholder="Write…"
              grow={[textScale, bodyStyle.fontSize, showVersions]}
              onFocus={() => { setTarget('body'); useUndoCoordinator.getState().checkpoint() }}
              onChange={v => writeText('body', v)}
              style={blockCss(bodyStyle)}
            />
          </div>
        </div>
        {showVersions && (
          <VersionsRail
            sourceId={sourceId}
            headerText={headerText}
            bodyText={bodyText}
            hasHeader={hasHeader}
            onRestore={(v) => {
              useUndoCoordinator.getState().checkpoint()
              if (hasHeader) writeText('header', v.headerText)
              writeText('body', v.text)
            }}
          />
        )}
      </div>
    </div>
  )
}

/** A textarea that grows to fit its content, so the page scrolls as ONE
 *  document instead of nesting a scrollbar inside the window. */
const AutoTextarea: React.FC<{
  value: string
  placeholder: string
  style: React.CSSProperties
  grow: unknown[]           // extra deps that change the rendered height
  onFocus: () => void
  onChange: (v: string) => void
}> = ({ value, placeholder, style, grow, onFocus, onChange }) => {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, ...grow])
  return (
    <textarea
      ref={ref}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onFocus={onFocus}
      onChange={e => onChange(e.target.value)}
      onPointerDown={e => e.stopPropagation()}
      onKeyDown={e => e.stopPropagation()}
      style={style}
    />
  )
}

/** Right-hand pop-out: saved drafts of this text source. Save snapshots
 *  as you go; click one to restore it into the card (undoable). */
const VersionsRail: React.FC<{
  sourceId: string
  headerText: string
  bodyText: string
  hasHeader: boolean
  onRestore: (v: TextVersion) => void
}> = ({ sourceId, headerText, bodyText, hasHeader, onRestore }) => {
  const versions = useTextVersionStore(s => s.versions[sourceId] ?? EMPTY_VERSIONS)
  const saveVersion = useTextVersionStore(s => s.saveVersion)
  const deleteVersion = useTextVersionStore(s => s.deleteVersion)
  const current = (hasHeader ? headerText + '\n' : '') + bodyText
  const isSaved = versions.some(v => (hasHeader ? v.headerText + '\n' : '') + v.text === current)

  return (
    <div
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      style={{
        width: 210, flexShrink: 0, display: 'flex', flexDirection: 'column',
        background: 'rgba(16,18,32,0.96)', borderLeft: '1px solid rgba(255,255,255,0.10)',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '7px 9px',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        <span style={{ flex: 1, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.6px', color: 'rgba(255,255,255,0.4)' }}>
          DOCUMENTS
        </span>
        <button
          onClick={() => saveVersion(sourceId, { headerText, text: bodyText })}
          disabled={isSaved}
          title={isSaved ? 'This exact text is already saved' : 'Save the current text as a new document'}
          style={{
            background: isSaved ? 'rgba(255,255,255,0.05)' : 'rgba(120,170,255,0.28)',
            border: `1px solid ${isSaved ? 'rgba(255,255,255,0.1)' : 'rgba(140,190,255,0.55)'}`,
            borderRadius: 4, color: isSaved ? 'rgba(255,255,255,0.35)' : '#fff',
            fontSize: 10, fontWeight: 700, padding: '3px 8px',
            cursor: isSaved ? 'default' : 'pointer', fontFamily: 'inherit',
          }}
        >＋ Save</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '5px 0' }}>
        {versions.length === 0 && (
          <div style={{ padding: '10px 10px', fontSize: 9.5, color: 'rgba(255,255,255,0.3)', lineHeight: 1.5 }}>
            No saved documents yet. Hit <strong>＋ Save</strong> to keep this draft, then keep editing — the card always shows the latest.
          </div>
        )}
        {versions.map(v => {
          const active = (hasHeader ? v.headerText + '\n' : '') + v.text === current
          return (
            <div
              key={v.id}
              onClick={() => onRestore(v)}
              title="Restore this document into the card (undoable)"
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 6,
                padding: '6px 9px', cursor: 'pointer',
                background: active ? 'rgba(120,170,255,0.14)' : 'transparent',
                borderLeft: `2px solid ${active ? 'rgba(140,190,255,0.8)' : 'transparent'}`,
              }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 10.5, color: 'rgba(255,255,255,0.85)', fontWeight: 600,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{v.label}</div>
                <div style={{ fontSize: 8.5, color: 'rgba(255,255,255,0.35)', marginTop: 1 }}>
                  {new Date(v.savedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  {active ? ' · current' : ''}
                </div>
              </div>
              <button
                onClick={e => { e.stopPropagation(); deleteVersion(sourceId, v.id) }}
                title="Delete this document"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
                  color: 'rgba(255,255,255,0.3)', fontSize: 12, lineHeight: 1, flexShrink: 0,
                }}
              >×</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const EMPTY_VERSIONS: TextVersion[] = []

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
  pinned: boolean
  setTextScale: (s: number) => void
  unpin: () => void
  showVersions: boolean
  toggleVersions: () => void
}> = ({ style, target, setTarget, onStyle, textScale, pinned, setTextScale, unpin, showVersions, toggleVersions }) => {
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
        {/* Not a reset — the way OUT of a pin. A page you have adjusted
            keeps its size forever; clicking here hands it back to the
            window's reading size, which is the only route back. */}
        <span
          onClick={unpin}
          title={pinned
            ? `This page is pinned at ${Math.round(textScale * 100)}% — click to follow the window's reading size`
            : "Following the window's reading size — A− / A+ pins this page"}
          style={{
            fontSize: 10, minWidth: 30, textAlign: 'center', userSelect: 'none',
            color: pinned ? 'rgba(180,212,255,0.95)' : 'rgba(255,255,255,0.55)',
            fontWeight: pinned ? 700 : 400,
            textDecoration: pinned ? 'underline dotted' : 'none',
            cursor: pinned ? 'pointer' : 'default',
          }}
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
      <button
        style={{ ...tbBtn(showVersions), marginLeft: 'auto' }}
        onClick={toggleVersions}
        title="Documents — save and restore drafts of this text"
      >▤ Docs</button>
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
