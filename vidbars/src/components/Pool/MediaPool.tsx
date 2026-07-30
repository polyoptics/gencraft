// MediaPool.tsx — a real media pool: point it at a folder, get its files.
//
// No preview pane, deliberately. Previewing is what a Viewer does, and a
// Viewer magneted to a Rolodex magneted to this pool already gives you
// that — building it in here would be the same job done twice, and would
// argue against the modular idea rather than for it.
//
// Contents go into poolStore rather than component state, which is what
// lets a magneted Rolodex browse this pool without either component
// knowing the other exists.
//
// Three rules this panel earned the hard way, all of them measured:
//
//  1. NOTHING HEAVY HAPPENS BECAUSE A FILE EXISTS. The pool used to ask
//     for a 3D poster from every model in the listing the moment it
//     mounted. Opening it on a folder of 85 models fetched 1.08 GB across
//     173 requests — two of them 44 MB .glb files — and parsed all of it
//     through three.js to paint 72px squares. Frame time went 7.9 ms →
//     35.5 ms. Model posters are now strictly opt-in, per tile or per
//     visible page, and image/video thumbnails are asked for only once a
//     tile is actually on screen.
//
//  2. ONLY WHAT IS IN VIEW IS MOUNTED. A listing can be thousands of
//     files. Mounting them all costs DOM nodes, a live store subscription
//     per tile, and a full-resolution decode per tile. The grid is
//     windowed the way the Rolodex windows its rows.
//
//  3. CHROME IS MEASURED IN SCREEN PIXELS, NOT CANVAS PIXELS. The panel
//     lives inside a node scaled by the canvas zoom, so a 9px label is
//     2.7px on screen at block zoom — which is why none of this was
//     readable. Everything below the counter-scale wrapper is a screen
//     pixel.

import React, {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react'
import { usePoolStore, loadPoolDir, type PoolFile } from '../../store/poolStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useThumb, requestThumb, getThumb, isThumbPending, hasThumbFailed } from '../../utils/thumbService'
import { ContentScaled, panelContentScale, clampUiScale, UI_SCALE_MIN, UI_SCALE_MAX } from '../UI/PanelSurface'

/** Target tile size in SCREEN pixels. These used to be canvas pixels,
 *  which made "mid" 14 real pixels wide at block zoom. The grid fills the
 *  panel width regardless — the target only decides how many columns. */
const SIZES = [56, 84, 120, 168] as const
const SIZE_LABELS = ['sml', 'mid', 'lrg', 'xl'] as const

const KIND_GLYPH: Record<PoolFile['kind'], string> = {
  image: '🖼', video: '▶', audio: '♪', model: '◆',
}

const GAP = 6
const PAD = 8
/** Rows kept mounted above and below the viewport so a fast scroll does
 *  not expose blank space before React catches up. */
const OVERSCAN = 2
/** An original is only used as its own thumbnail when it is small enough
 *  that decoding it into a tile is free. Above this the tile waits for a
 *  real thumbnail or shows its glyph — a full-res 8.5 MB PNG decoded into
 *  a 120px box is the other half of what made this panel stutter. */
const RAW_FALLBACK_MAX = 300 * 1024

// ── One tile ───────────────────────────────────────────────────────

interface TileProps {
  file: PoolFile
  side: number
  selected: boolean
  /** Whether this server can produce thumbnails at all. Decides if a heavy
   *  original is worth waiting for or is the only picture there will be. */
  thumbsPossible: boolean
  onSelect: (id: string) => void
  onPlace: (f: PoolFile) => void
}

/** Memoised, because it is not. Before this, one keystroke in the filter
 *  box re-rendered every mounted tile, re-ran every thumbnail selector and
 *  rebuilt every image URL. The parent hands down stable callbacks so the
 *  memo actually holds. */
const FileTile = React.memo<TileProps>(({ file, side, selected, thumbsPossible, onSelect, onPlace }) => {
  const thumb = useThumb(file.url, file.kind)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [onScreen, setOnScreen] = useState(false)
  // Bumped on click so the button can re-read the (non-reactive) queue.
  const [renderTick, setRenderTick] = useState(0)
  const renderState: 'idle' | 'working' | 'failed' = (() => {
    void renderTick
    if (isThumbPending(file.url)) return 'working'
    return hasThumbFailed(file.url) ? 'failed' : 'idle'
  })()
  // While a job is in flight the queue never notifies, so poll gently just
  // for the label — stops when the tile leaves the screen with the effect.
  useEffect(() => {
    if (renderState !== 'working') return
    const t = setInterval(() => setRenderTick(v => v + 1), 900)
    return () => clearInterval(t)
  }, [renderState])
  const [thumbBroken, setThumbBroken] = useState(false)
  const [rawBroken, setRawBroken] = useState(false)

  // Visibility, not mere existence, is what authorises work. Windowing
  // already bounds this to a page of tiles; the observer bounds it again
  // to the tiles a human can actually see, so scrolling past a folder
  // does not queue thumbnails for everything it flew over.
  //
  // One-way on purpose: once seen, a tile keeps its picture until
  // virtualisation unmounts it. Flipping back to false at the window edge
  // would flicker, and unmounting is already the cheaper cancel.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const io = new IntersectionObserver(
      entries => { for (const e of entries) if (e.isIntersecting) setOnScreen(true) },
      { rootMargin: '80px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!onScreen) return
    // Models are never requested implicitly — see rule 1 at the top of
    // this file. They get a thumbnail when someone asks for one.
    if (file.kind === 'model' || file.kind === 'audio') return
    if (getThumb(file.url)) return
    requestThumb(file.url, file.kind)
  }, [onScreen, file.url, file.kind])

  // The dev server's downscaled copy, when there is one. Read structurally
  // rather than off PoolFile because the field arrives with the thumbnail
  // endpoint, and this panel has to stand on its own without it: a machine
  // whose server cannot encode thumbnails still gets a working pool.
  const serverThumb = (file as PoolFile & { thumb?: string | null }).thumb ?? null

  // Fallback ladder: server thumbnail → generated model poster → the
  // original, but only when it is small enough to decode for free → the
  // kind glyph. Nothing in this chain can leave a blank square.
  const best = serverThumb ?? thumb
  const usingThumb = !!best && !thumbBroken
  // The size gate is a WAIT, not a refusal: it holds a heavy original back
  // while a real thumbnail is on its way. When no thumbnail can ever come —
  // a server with no encoder — waiting forever means a grid of identical
  // glyphs, which is strictly worse than the slow grid this replaced. You
  // cannot pick media you cannot see. Windowing already bounds the decode
  // to a page of tiles, so showing the original is affordable here.
  const raw = file.kind === 'image' && file.size > 0
    && (thumbsPossible ? file.size <= RAW_FALLBACK_MAX : true)
  const src = usingThumb ? best : (raw && !rawBroken ? file.url : null)

  const captioned = side >= 78

  const dragStart = (e: React.DragEvent) => {
    const payload = JSON.stringify({ url: file.url, label: file.name, kind: file.kind })
    e.dataTransfer.setData('application/x-vidbars-pool', payload)
    // text/plain so the drag is legible to anything that is not this app
    // (a text field, another window) instead of silently doing nothing.
    e.dataTransfer.setData('text/plain', file.url)
    e.dataTransfer.effectAllowed = 'copy'
    const img = imgRef.current
    if (img && img.complete && img.naturalWidth > 0) {
      try { e.dataTransfer.setDragImage(img, img.width / 2, img.height / 2) } catch { /* not fatal */ }
    }
  }

  return (
    <div
      ref={rootRef}
      draggable
      onDragStart={dragStart}
      onClick={() => onSelect(file.id)}
      onDoubleClick={() => onPlace(file)}
      title={`${file.name}${file.size ? ` · ${Math.round(file.size / 1024)}KB` : ''}\ndrag onto the canvas, or double-click to place`}
      style={{
        position: 'relative', height: side, minWidth: 0,
        borderRadius: 5, overflow: 'hidden',
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.1)',
        // A ring, not a thicker border: a border that grows on selection
        // changes the tile's box and reflows the whole row on every click.
        boxShadow: selected ? '0 0 0 2px rgba(140,190,255,0.95)' : 'none',
        cursor: 'grab',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {/* The src is withheld until the tile is genuinely on screen. The
          overscan rows exist so scrolling does not flash blank, but they
          are not worth a decode — and for an original used as its own
          thumbnail that decode is a full-size PNG. */}
      {src && onScreen ? (
        <img
          ref={imgRef}
          src={src}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          onError={() => { if (usingThumb) setThumbBroken(true); else setRawBroken(true) }}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            objectFit: 'cover', background: '#0c0e18', pointerEvents: 'none',
          }}
        />
      ) : (
        <span style={{ fontSize: Math.max(16, side * 0.3), opacity: 0.5 }}>{KIND_GLYPH[file.kind]}</span>
      )}

      {file.kind !== 'image' && (
        <span style={{
          position: 'absolute', top: 3, right: 4, fontSize: 10, lineHeight: '14px',
          padding: '0 4px', borderRadius: 3, background: 'rgba(0,0,0,0.62)',
          color: 'rgba(180,215,255,0.9)', pointerEvents: 'none',
        }}>{file.kind === 'model' ? '3D' : KIND_GLYPH[file.kind]}</span>
      )}


      {/* Explicit, per-tile poster generation. This is the ONLY way a
          model gets rendered for a thumbnail — one file, because someone
          asked for that file. */}
      {file.kind === 'model' && !src && (
        <button
          title={renderState === 'working'
            ? 'Rendering — a large model can take a few seconds'
            : renderState === 'failed'
              ? 'That model could not be rendered. Click to try again.'
              : 'Render a 3D thumbnail for this model'}
          onClick={e => {
            e.stopPropagation()
            requestThumb(file.url, 'model', true)
            // Local, because the queue is not reactive. A click that starts
            // a multi-second GLB download used to look exactly like a click
            // that was thrown away.
            setRenderTick(t => t + 1)
          }}
          onDoubleClick={e => e.stopPropagation()}
          onDragStart={e => e.preventDefault()}
          style={{
            position: 'absolute', bottom: captioned ? 22 : 3, left: 3,
            fontSize: 10, lineHeight: '15px', padding: '0 6px', borderRadius: 3,
            background: 'rgba(0,0,0,0.62)',
            border: `1px solid ${renderState === 'failed' ? 'rgba(255,150,150,0.55)' : 'rgba(140,190,255,0.4)'}`,
            color: renderState === 'failed' ? 'rgba(255,190,190,0.95)' : 'rgba(200,225,255,0.95)',
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >{renderState === 'working' ? '…' : renderState === 'failed' ? 'retry' : 'render'}</button>
      )}

      {captioned && (
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          padding: '2px 5px', fontSize: 11, lineHeight: '15px',
          color: 'rgba(255,255,255,0.82)', background: 'rgba(6,8,16,0.72)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}>{file.name}</div>
      )}
    </div>
  )
})
FileTile.displayName = 'FileTile'

// ── Panel ──────────────────────────────────────────────────────────

export const MediaPool: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const node = useFreeNodeStore(s => s.nodes[nodeId])
  const updateFreeNode = useFreeNodeStore(s => s.updateFreeNode)
  const contents = usePoolStore(s => s.pools[nodeId])
  // Tile size and filter live on the NODE, not in component state. They were
  // useState, so every remount — a zoom-layer switch, a pin, a scroll that
  // culled the node — silently put the pool back to defaults while you were
  // working in it.
  const sizeIdx = node?.poolSizeIdx ?? 1
  const setSizeIdx = (i: number) => updateFreeNode(nodeId, { poolSizeIdx: i })
  const [selected, setSelected] = useState<string | null>(null)
  const filter = node?.poolFilter ?? ''
  const setFilter = (v: string) => updateFreeNode(nodeId, { poolFilter: v })
  const [pathDraft, setPathDraft] = useState('')
  const [editingPath, setEditingPath] = useState(false)

  // The multiplier the canvas applies to this node: the live zoom, or the
  // zoom FROZEN at pin time. Identical to FreeNode and Viewport3DFrame —
  // a pinned pool and a canvas pool must render the same.
  // NOTHING here reads the canvas zoom, deliberately. Counter-scaling made
  // the tile size and column count change as you zoomed, so the grid
  // re-wrapped under you and you lost your place — the one thing a pool
  // exists to keep. The panel now scales uniformly with the canvas like any
  // other object, and how big its contents are drawn is the USER's setting.
  const uiScale = panelContentScale(node)

  const dir = node?.poolDir ?? 'public/uploads'

  // Re-read on mount and whenever the folder changes: a listing is a
  // snapshot of something that moves.
  useEffect(() => { void loadPoolDir(nodeId, dir) }, [nodeId, dir])

  const files = useMemo(() => contents?.files ?? [], [contents])
  const dirs = contents?.dirs ?? []
  // Unknown until the first listing lands; assume yes so tiles do not flash
  // heavy originals during the round trip.
  const thumbsPossible = contents?.caps?.thumbs ?? true
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? files.filter(f => f.name.toLowerCase().includes(q)) : files
  }, [files, filter])

  const goTo = (d: string) => { updateFreeNode(nodeId, { poolDir: d }); setSelected(null) }

  const onSelect = useCallback((id: string) => setSelected(id), [])

  /** Double-click drops a file on the canvas as a tile of its own kind. */
  const onPlace = useCallback((f: PoolFile) => {
    const cs = useCanvasStore.getState()
    const fns = useFreeNodeStore.getState()
    useUndoCoordinator.getState().checkpoint()
    const cx = (window.innerWidth / 2 - cs.pan.x) / cs.zoom
    const cy = (window.innerHeight / 2 - cs.pan.y) / cs.zoom
    const id = fns.addFreeNode(cx, cy, f.kind)
    fns.updateFreeNode(id, { imageUrl: f.url, mediaType: f.kind, label: f.name })
    fns.setFreeSelection([id])
  }, [])

  // ── Windowed grid geometry ──
  // Measured in the counter-scaled surface, so every number here is a
  // screen pixel. Columns are derived from the measured width and the
  // tiles then take an equal share of it, which is what kills the ragged
  // dead gutter a fixed-width flex-wrap grid always leaves on the right.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [scrollTop, setScrollTop] = useState(0)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // uiScale is a dependency because changing it resizes this element
    // through an ANCESTOR's width, which the observer did not report:
    // measured on a live panel, the column count stayed at its pre-scale
    // value and the grid laid 5 columns into a 2-column space.
  }, [uiScale])

  // A new listing or a new filter is a new list: scrolled-into-nowhere is
  // indistinguishable from an empty folder.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setScrollTop(0)
  }, [dir, filter])

  const target = SIZES[sizeIdx]
  const inner = Math.max(0, box.w - PAD * 2)
  const cols = Math.max(1, Math.floor((inner + GAP) / (target + GAP)))
  const side = cols > 0 && inner > 0 ? (inner - GAP * (cols - 1)) / cols : target
  const rowH = side + GAP
  const rowCount = Math.ceil(shown.length / cols)
  const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN)
  const lastRow = Math.min(rowCount - 1, Math.floor((scrollTop + box.h) / rowH) + OVERSCAN)
  const startIdx = firstRow * cols
  const endIdx = Math.min(shown.length, (lastRow + 1) * cols)
  const slice = box.w > 0 ? shown.slice(startIdx, endIdx) : []
  const padTop = firstRow * rowH
  const padBottom = Math.max(0, (rowCount - 1 - lastRow) * rowH)

  /** Render posters for the models on this page only. Deliberately bound
   *  to the window rather than the listing: "build every thumbnail in
   *  this folder" is precisely the operation that made the pool unusable
   *  when it happened by itself. */
  const buildVisiblePosters = () => {
    for (const f of slice) if (f.kind === 'model' && !getThumb(f.url)) requestThumb(f.url, 'model', true)
  }
  const pageModels = slice.some(f => f.kind === 'model')

  // Below this the panel is too narrow for the full control strip; the
  // size chips are the first thing to go, since the grid still fills.
  const narrow = box.w > 0 && box.w < 250

  const chip = (on: boolean): React.CSSProperties => ({
    background: on ? 'rgba(120,170,255,0.28)' : 'rgba(255,255,255,0.05)',
    border: `1px solid ${on ? 'rgba(140,190,255,0.55)' : 'rgba(255,255,255,0.1)'}`,
    borderRadius: 4, color: on ? '#dce9ff' : 'rgba(255,255,255,0.62)',
    fontSize: 11, fontWeight: 700, letterSpacing: '0.2px',
    padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
    lineHeight: '15px',
  })

  return (
    <div
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      // A pool drag released back over the pool used to bubble to the canvas,
      // which happily made a node UNDER the opaque panel — invisible, plus an
      // undo step and a selection change for something you never saw. Letting
      // go over the panel you dragged from should simply do nothing.
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'none' }}
      onDrop={e => { e.preventDefault(); e.stopPropagation() }}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#12131f' }}
    >
      <ContentScaled factor={uiScale}>
        <div style={{
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
          overflow: 'hidden', fontFamily: 'system-ui, sans-serif',
        }}>
          {/* ── Path bar ── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '5px 7px',
            borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
          }}>
            <button style={chip(false)} title="Up one folder"
              onClick={() => contents?.parent && goTo(contents.parent)}>↑</button>
            {editingPath ? (
              <input
                autoFocus
                value={pathDraft}
                onChange={e => setPathDraft(e.target.value)}
                onKeyDown={e => {
                  e.stopPropagation()
                  if (e.key === 'Enter') { goTo(pathDraft.trim()); setEditingPath(false) }
                  if (e.key === 'Escape') setEditingPath(false)
                }}
                onBlur={() => setEditingPath(false)}
                style={{
                  flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(140,190,255,0.4)', borderRadius: 4,
                  color: 'rgba(255,255,255,0.9)', fontSize: 12, padding: '3px 6px',
                  fontFamily: 'ui-monospace, monospace', outline: 'none',
                }}
              />
            ) : (
              <div
                onClick={() => { setPathDraft(contents?.dir ?? dir); setEditingPath(true) }}
                title="Click to type a folder path"
                style={{
                  flex: 1, minWidth: 0, fontSize: 12, color: 'rgba(255,255,255,0.62)',
                  fontFamily: 'ui-monospace, monospace', cursor: 'text',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl',
                }}
              >{contents?.dir ?? dir}</div>
            )}
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>
              {contents?.loading ? '…' : `${files.length}`}
            </span>
          </div>

          {/* ── Controls ── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4, padding: '5px 7px',
            borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0, overflow: 'hidden',
          }}>
            {!narrow && SIZE_LABELS.map((lbl, i) => (
              <button key={lbl} style={chip(sizeIdx === i)} onClick={() => setSizeIdx(i)}>{lbl}</button>
            ))}
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              onKeyDown={e => e.stopPropagation()}
              placeholder="filter…"
              style={{
                flex: 1, minWidth: 0, marginLeft: narrow ? 0 : 4,
                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 4, color: 'rgba(255,255,255,0.85)', fontSize: 12,
                padding: '3px 7px', fontFamily: 'inherit', outline: 'none',
              }}
            />
            {pageModels && (
              <button style={chip(false)} title="Render 3D thumbnails for the models on this page"
                onClick={buildVisiblePosters}>3D</button>
            )}
            {/* Panel scale. This is the ONLY thing that changes how big the
                contents are drawn — the camera does not get a vote, which
                is what keeps your place while you zoom. */}
            <button
              style={{ ...chip(false), opacity: uiScale <= UI_SCALE_MIN ? 0.35 : 1 }}
              title="Smaller contents"
              onClick={() => updateFreeNode(nodeId, { uiScale: clampUiScale(uiScale / 1.15) })}
            >−</button>
            <button
              style={{ ...chip(false), opacity: uiScale >= UI_SCALE_MAX ? 0.35 : 1 }}
              title={`Larger contents (${Math.round(uiScale * 100)}%) — double-click to reset`}
              onClick={() => updateFreeNode(nodeId, { uiScale: clampUiScale(uiScale * 1.15) })}
              onDoubleClick={() => updateFreeNode(nodeId, { uiScale: 1 })}
            >+</button>
            <button style={chip(false)} title="Re-read this folder"
              onClick={() => void loadPoolDir(nodeId, dir)}>⟳</button>
          </div>

          {/* ── Subfolders ── one line that scrolls sideways, so a folder
              with fifty children cannot eat the file grid. */}
          {dirs.length > 0 && (
            <div style={{
              display: 'flex', gap: 5, padding: '5px 7px', flexShrink: 0,
              overflowX: 'auto', overflowY: 'hidden', whiteSpace: 'nowrap',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
            }}>
              {dirs.map(d => (
                <button key={d.path} onClick={() => goTo(d.path)} style={{
                  ...chip(false), fontWeight: 500, letterSpacing: 0,
                }}>📁 {d.name}</button>
              ))}
            </div>
          )}

          {contents?.error && (
            <div style={{
              color: 'rgba(255,150,150,0.85)', fontSize: 12, padding: '5px 7px', flexShrink: 0,
            }}>{contents.error}</div>
          )}

          {/* ── Grid ── */}
          <div
            ref={scrollRef}
            onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
            style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: PAD, minHeight: 0 }}
          >
            {shown.length > 0 ? (
              <div style={{ paddingTop: padTop, paddingBottom: padBottom }}>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${cols}, 1fr)`,
                  gridAutoRows: `${side}px`,
                  gap: GAP,
                  alignContent: 'start',
                }}>
                  {slice.map(f => (
                    <FileTile
                      key={f.id} file={f} side={side}
                      selected={selected === f.id}
                      thumbsPossible={thumbsPossible}
                      onSelect={onSelect}
                      onPlace={onPlace}
                    />
                  ))}
                </div>
              </div>
            ) : !contents?.loading && (
              <div style={{
                height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                textAlign: 'center', color: 'rgba(255,255,255,0.38)', fontSize: 12,
                lineHeight: 1.6, padding: 12,
              }}>
                {filter.trim()
                  ? `Nothing matches “${filter.trim()}”.`
                  : 'Nothing here. Click the path above to point at a folder — an absolute path works, or one relative to the project.'}
              </div>
            )}
          </div>

          <div style={{
            padding: '4px 7px', borderTop: '1px solid rgba(255,255,255,0.08)',
            fontSize: 11, color: 'rgba(255,255,255,0.38)', flexShrink: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {thumbsPossible
              ? 'drag a file to the canvas · double-click to place · magnet a Rolodex to browse this pool'
              : 'showing originals — install sharp for fast thumbnails · drag a file to the canvas'}
          </div>
        </div>
      </ContentScaled>
    </div>
  )
}
