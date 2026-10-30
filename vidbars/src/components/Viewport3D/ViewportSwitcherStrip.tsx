// ViewportSwitcherStrip.tsx — the source "playlist" in the footer of a
// browser window. One chip per connected SOURCE: tiles show their poster/
// image (or a kind glyph); cards/decks show the card's FACE (hero) with a
// ×N badge when they hold several items — clicking a card chip shows its
// first item, clicking again cycles through them. Also owns the
// active-item RECONCILIATION: default to the first available media item
// (defaultBrowseItem — text pages don't hijack fresh docks), fall back
// when the active one disconnects, clear when nothing is connected —
// debounced (300ms) so a tile mid-drag crossing the boundary doesn't
// thrash loads.

import React, { useEffect, useRef } from 'react'
import { useViewport3DStore, activeItemKey } from '../../store/viewport3dStore'
import type { ActiveItem } from '../../store/viewport3dStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useDockedSources, flattenSourceItems, type DockedSource } from '../../hooks/useDockedContent'
import { defaultBrowseItem } from '../../utils/contentTraversal'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { applyAnimationFromUrl, setViewFooterInset } from '../../three/viewportRenderer'

/** The strip's height in SCREEN px. It is the Viewer's footer: it sits in
 *  its own row under the work area, and the GL rect is shortened by this
 *  much, so neither an image nor a model is ever drawn underneath it. */
export const SWITCHER_STRIP_SCREEN_H = 46

/** Glyph per item kind for chips without a face image. */
function chipGlyph(source: DockedSource): string {
  if (source.kind === 'list') return '≔'
  if (source.kind === 'card') return '▮'
  const it = source.items[0]
  if (!it) return '◆'
  if (it.kind === 'text') return 'T'
  switch (it.mediaType) {
    case 'video': return '▶'
    case 'audio': return '♪'
    case 'image': return '🖼'
    default: return '◆'
  }
}

export const ViewportSwitcherStrip: React.FC<{
  windowId: string
  /** Width of the resize grip's hit zone in the bottom-right corner, in screen
   *  px. The strip spans the full width at the bottom of the window, so its
   *  last control — the next-item arrow — sat directly under that grip, which
   *  is a 36px square at zIndex 20 against the strip's 2. The grip took every
   *  hover and click, making the arrow unusable exactly when you are cycling
   *  through models. Reserve the corner instead of fighting over it. */
  reserveRight?: number
  /** Same problem at the other end: the SW reshape corner (zIndex 19) sat
   *  over the previous-item arrow. Width of that corner's hit zone. */
  reserveLeft?: number
  /** Height of the S reshape edge, which runs along the strip's bottom
   *  between the two corners. Without a card face the strip is short enough
   *  for that edge to clip the arrows' lower half. */
  reserveBottom?: number
}> = ({ windowId, reserveRight = 0, reserveLeft = 0, reserveBottom = 0 }) => {
  const win = useViewport3DStore(s => s.windows[windowId])
  const setActiveItem = useViewport3DStore(s => s.setActiveItem)
  const canvasZoom = useCanvasStore(s => s.zoom)
  // gz, not the live canvas zoom — the same rule as Viewport3DFrame. This
  // strip counter-scales its chips against the scale of its ANCESTOR, and a
  // pinned window's ancestor transform is frozen at pin time. Reading the
  // live zoom made the chips grow and shrink under the mouse wheel on a
  // window that was standing perfectly still.
  const zoom = win?.pin ? win.pin.scale : canvasZoom
  const sources = useDockedSources(windowId)
  const reconcileTimer = useRef<number | null>(null)

  const active = win?.activeItem ?? null
  const activeKey = activeItemKey(active)
  const flat = flattenSourceItems(sources)

  // ── Reconciliation (debounced for drag-transition stability) ──
  useEffect(() => {
    if (!win) return
    const desired: ActiveItem | null = flat.length === 0
      ? null
      : (active && flat.some(i => activeItemKey(i) === activeKey)) ? active : defaultBrowseItem(flat)
    if (activeItemKey(desired) === activeKey) {
      if (reconcileTimer.current !== null) { window.clearTimeout(reconcileTimer.current); reconcileTimer.current = null }
      return
    }
    if (reconcileTimer.current !== null) window.clearTimeout(reconcileTimer.current)
    reconcileTimer.current = window.setTimeout(() => {
      reconcileTimer.current = null
      const liveWin = useViewport3DStore.getState().windows[windowId]
      if (liveWin && activeItemKey(liveWin.activeItem) === activeKey) {
        setActiveItem(windowId, desired)
      }
    }, 300)
    return () => {
      if (reconcileTimer.current !== null) { window.clearTimeout(reconcileTimer.current); reconcileTimer.current = null }
    }
  }, [win, flat, active, activeKey, windowId, setActiveItem])

  // Show whenever something is connected and showing — this is the
  // "now viewing" provenance card, not a picker.
  const shown = !!win && !!active && flat.length > 0
  useEffect(() => {
    setViewFooterInset(windowId, shown ? SWITCHER_STRIP_SCREEN_H : 0)
  }, [windowId, shown])
  useEffect(() => () => setViewFooterInset(windowId, 0), [windowId])
  if (!win || !active || !shown) return null

  const iz = 1 / zoom
  // The SOURCE the active item belongs to (first source containing it).
  const activeSource = sources.find(s => s.items.some(i => activeItemKey(i) === activeKey)) ?? null
  const flatIdx = flat.findIndex(i => activeItemKey(i) === activeKey)
  const step = (dir: 1 | -1) => {
    if (flat.length === 0) return
    const cur = flatIdx < 0 ? 0 : flatIdx
    setActiveItem(windowId, flat[(cur + dir + flat.length) % flat.length])
  }

  const navBtn: React.CSSProperties = {
    background: 'rgba(255,255,255,0.06)', border: `${Math.max(1, iz)}px solid rgba(255,255,255,0.12)`,
    borderRadius: 4 * iz, color: 'rgba(255,255,255,0.7)',
    fontSize: 11 * iz, fontWeight: 700, lineHeight: 1,
    padding: `${3 * iz}px ${7 * iz}px`, cursor: 'pointer', fontFamily: 'inherit',
    flexShrink: 0, userSelect: 'none' as const,
  }

  return (
    <div
      onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}
      onWheel={e => e.stopPropagation()}
      style={{
        // A footer ROW under the work area, not an overlay on it.
        position: 'relative', flexShrink: 0, boxSizing: 'border-box',
        height: SWITCHER_STRIP_SCREEN_H * iz,
        display: 'flex', alignItems: 'center', gap: 6 * iz,
        padding: `0 ${8 * iz + reserveRight}px ${reserveBottom}px ${8 * iz + reserveLeft}px`,
        background: 'rgba(13,14,26,0.88)',
        borderTop: `${Math.max(1, 1 / zoom)}px solid rgba(140,170,255,0.15)`,
        zIndex: 2,
      }}
    >
      <button style={navBtn} onClick={() => step(-1)} title="Previous item">‹</button>
      {activeSource && <NowViewingCard windowId={windowId} source={activeSource} activeKey={activeKey} iz={iz} />}
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 9 * iz, color: 'rgba(255,255,255,0.4)', flexShrink: 0, userSelect: 'none' }}>
        {flatIdx >= 0 ? flatIdx + 1 : '–'} / {flat.length}
      </span>
      <button style={navBtn} onClick={() => step(1)} title="Next item">›</button>
    </div>
  )
}

/** The card face + name of the source being viewed right now. Clicking it
 *  cycles within THAT source's items. */
const NowViewingCard: React.FC<{
  windowId: string
  source: DockedSource
  activeKey: string | null
  iz: number
}> = ({ windowId, source, activeKey, iz }) => {
  const resolvedFace = useResolvedMedia(source.face)
  const idxInSource = activeKey ? source.items.findIndex(i => activeItemKey(i) === activeKey) : -1
  const activeItem = idxInSource >= 0 ? source.items[idxInSource] : null
  const cycle = () => {
    if (source.items.length < 2 || idxInSource < 0) return
    const next = source.items[(idxInSource + 1) % source.items.length]
    useViewport3DStore.getState().setActiveItem(windowId, next)
  }
  /** Shift-click DONATES this source's animation to whatever rig the
   *  window is already showing, instead of replacing it. That is the
   *  "magnet an animation onto a character" move: the clip file rides in
   *  as an ordinary docked tile, and shift says use it, don't open it. */
  const donateAnimation = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const item = source.items.find(i => i.kind === 'media' && i.mediaType === 'model')
    if (item?.kind !== 'media') return
    const matched = await applyAnimationFromUrl(windowId, item.url)
    if (matched === 0) {
      // Silence here would read as "the app is broken"; skeletons that
      // don't share bone names genuinely can't drive each other.
      console.warn('[anim] no bone names matched — these rigs are not compatible')
    }
  }

  return (
    <div
      onClick={e => { if (e.shiftKey) void donateAnimation(e); else cycle() }}
      title={source.items.length > 1
        ? `${source.name} — item ${idxInSource + 1} of ${source.items.length} (click to cycle · shift-click to drive the current rig with its animation)`
        : `${source.name} (shift-click to drive the current rig with its animation)`}
      style={{
        display: 'flex', alignItems: 'center', gap: 6 * iz,
        minWidth: 0, cursor: source.items.length > 1 ? 'pointer' : 'default',
      }}
    >
      {resolvedFace ? (
        <img
          src={resolvedFace}
          draggable={false}
          style={{
            width: 26 * iz, height: 32 * iz,   // portrait card face
            objectFit: 'cover', borderRadius: 3 * iz, flexShrink: 0,
            border: `${Math.max(1, iz)}px solid rgba(140,190,255,0.4)`,
          }}
        />
      ) : (
        <span style={{
          width: 26 * iz, height: 32 * iz, borderRadius: 3 * iz, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(255,255,255,0.06)', border: `${Math.max(1, iz)}px solid rgba(255,255,255,0.15)`,
          fontSize: 12 * iz, color: 'rgba(160,200,255,0.7)',
        }}>{chipGlyph(source)}</span>
      )}
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 * iz }}>
        <span style={{
          fontSize: 10 * iz, fontWeight: 700, color: 'rgba(255,255,255,0.9)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'none',
        }}>{source.name}</span>
        <span style={{
          fontSize: 8.5 * iz, color: 'rgba(255,255,255,0.45)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'none',
        }}>
          {activeItem?.name ?? ''}{source.items.length > 1 ? `  ·  ${idxInSource + 1}/${source.items.length}` : ''}
        </span>
      </div>
    </div>
  )
}
