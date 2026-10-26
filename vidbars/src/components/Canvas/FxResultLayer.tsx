// FxResultLayer — an effect strip's result, shown ON its picture.
//
// A strip reads left to right: the picture (or pictures), then the effect
// cards. The processed picture is drawn over the picture tile's own <img>,
// with the SAME geometry — crop, zoom, flips (the tile's imgStyle) — so the
// tile simply shows its picture with the effects applied, and the effect
// cards are left to be all sliders. A small "fx" pill flips the tile back
// to the original and forth again; on hover a Save keeps the full-size
// result as a real file.
//
// Also here, the other half of "drag the result out": useFxDragUrl writes a
// copy of the processed picture to the Drag Cache WHILE the tile is
// hovered, so the header's ordinary drag-out grip can hand Windows that
// file. A drag cannot wait for a render — the OS drag has to start inside
// the dragstart, with the button still down (see DragOutGrip and the
// preload's arming window) — so the file must exist before the press.
//
// Nothing here is stored: the result is the strip's (fxStore), and the
// fx/original choice is fxStore's transient `bypass`.

import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useFxStore } from '../../store/fxStore'
import { itemsForSource, runChain, type ChainItem } from '../../utils/fx/chain'
import { EFFECTS } from '../../utils/fx/effects'
import { resultName, saveFailure, saveStripResult } from '../../utils/fx/saveStrip'
import { saveCanvasImage } from '../../utils/saveImage'
import { diskFileUrl } from '../../utils/diskUrl'
import { CanvasMirror } from '../UI/CanvasMirror'

const stop = (e: React.SyntheticEvent) => { e.stopPropagation() }
/** Only the primary button belongs to the controls: a middle-drag over
 *  them must still reach the canvas and pan (as on DragOutGrip). */
const stopPrimary = (e: React.PointerEvent | React.MouseEvent) => { if (e.button === 0) e.stopPropagation() }

export const FxResultLayer: React.FC<{
  nodeId: string
  /** The tile's <img> style — the overlay copies it to land pixel for pixel. */
  imgStyle: React.CSSProperties
  /** 1 / the tile's camera zoom: chrome holds a constant screen size. */
  iz: number
  nodeW: number
  nodeH: number
  hovered: boolean
}> = ({ nodeId, imgStyle, iz, nodeW, nodeH, hovered }) => {
  const key = useFxStore(s => s.sources[nodeId])
  const strip = useFxStore(s => (key ? s.strips[key] : undefined))
  const bypassed = useFxStore(s => !!s.bypass[nodeId])
  const [save, setSave] = useState<{ state: 'saving' | 'saved' | 'failed'; note: string } | null>(null)
  // "Saved" / "Not saved" are a moment's acknowledgement, not a status.
  useEffect(() => {
    if (!save || save.state === 'saving') return
    const t = window.setTimeout(() => setSave(null), save.state === 'saved' ? 2500 : 5000)
    return () => window.clearTimeout(t)
  }, [save])
  if (!strip) return null

  // By source id, not position: outputs only list the pictures that read.
  const out = strip.result?.outputs.find(o => o.sourceId === nodeId) ?? null
  const showFx = !!out && !bypassed
  const error = out || strip.running ? null
    : strip.result?.unreadable?.includes(nodeId) ? 'This picture could not be read.'
    : strip.result?.error ?? null
  const lastFx = strip.items.findLast(i => i.kind === 'effect')
  const color = lastFx?.kind === 'effect' ? EFFECTS[lastFx.effect].color : '#f2b84b'
  const chainName = strip.items.flatMap(i => i.kind === 'effect' ? [EFFECTS[i.effect].label] : []).join(' → ')

  // Counter-scaled chrome, capped against the tile's own box (FreeNode's
  // rule): zoomed far out, a constant-screen-size pill would outgrow the
  // picture it sits on.
  const f = Math.min(10 * iz, nodeW * 0.08, nodeH * 0.1)
  const m = Math.min(6 * iz, nodeW * 0.04, nodeH * 0.04)
  const chip: React.CSSProperties = {
    pointerEvents: 'auto', flexShrink: 0,
    fontSize: f, lineHeight: 1.25, fontWeight: 700, fontFamily: 'inherit',
    padding: `${f * 0.12}px ${f * 0.55}px`, borderRadius: f,
    background: 'rgba(12,13,20,0.72)', color: 'rgba(255,255,255,0.88)',
    border: `${f * 0.1}px solid rgba(255,255,255,0.32)`,
    textShadow: '0 1px 2px rgba(0,0,0,0.6)', whiteSpace: 'nowrap', cursor: 'pointer',
  }

  const doSave = async () => {
    if (save?.state === 'saving') return
    setSave({ state: 'saving', note: '' })
    // This picture alone through the strip, at full size — not its batch
    // neighbours, which have pills of their own.
    const r = await saveStripResult(itemsForSource(strip.items, nodeId))
    const mine = r.saved[0]
    const failure = mine ? saveFailure(mine) : (r.error ?? 'Could not save this result.')
    setSave(failure
      ? { state: 'failed', note: failure }
      : { state: 'saved', note: mine?.path ?? 'Downloaded' })
  }

  // The copy's size: the long edge the picture is drawn at on screen (in
  // canvas units, × the camera, × the display's pixel ratio, × a zoomed
  // crop's own scale), rounded UP to a power of two so a wheel tick does
  // not redraw it. A full-size copy shrunk by the compositor reads grainy
  // (CanvasMirror); one smaller than drawn reads soft next to the original.
  // objectFit: cover scales the picture by the LARGER of the two fits, so
  // one whose shape differs from the tile's overhangs it on its long axis —
  // a 16:9 picture in a square tile is drawn 1.78× the tile's width. nodeH
  // counts the header too: a slight overestimate, the safe side.
  const cropScale = typeof imgStyle.width === 'string' && imgStyle.width.endsWith('%')
    ? Math.max(1, parseFloat(imgStyle.width) / 100) : 1
  const sw = out?.canvas.width || 1, sh = out?.canvas.height || 1
  const drawnLong = Math.max(nodeW / sw, nodeH / sh) * Math.max(sw, sh)
  const onScreen = drawnLong / iz * (window.devicePixelRatio || 1) * cropScale
  const mirrorSide = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, onScreen))))

  return (
    <>
      {showFx && (
        <CanvasMirror
          source={out.canvas}
          maxSide={mirrorSide}
          // The <img>'s own box and fit, then its crop/zoom/flips on top.
          // No max size: a zoomed-in crop is wider than the tile on purpose.
          style={{
            position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
            objectFit: 'cover', maxWidth: 'none', maxHeight: 'none',
            ...imgStyle,
            pointerEvents: 'none',
          }}
        />
      )}
      <div
        data-fx-result
        style={{
          position: 'absolute', left: m, right: m, bottom: m,
          // Over the tile's resize zones (19/20) where they overlap — only
          // the controls themselves take the pointer, so the rest of the
          // corner still resizes.
          zIndex: 21, pointerEvents: 'none',
          display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: f * 0.35,
        }}
      >
        {hovered && error && (
          <div
            title={error}
            style={{
              maxWidth: '100%', fontSize: f * 0.9, lineHeight: 1.3,
              padding: `${f * 0.15}px ${f * 0.45}px`, borderRadius: f * 0.4,
              background: 'rgba(12,13,20,0.8)', color: '#ff9b9b',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >{error}</div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: f * 0.4, maxWidth: '100%' }}>
          {/* The pill — always there, small: the one sign a picture is
              showing a result rather than itself, and the before/after flip. */}
          <button
            onPointerDown={stopPrimary} onMouseDown={stopPrimary} onDoubleClick={stop}
            onClick={e => {
              e.stopPropagation()
              if (out) useFxStore.getState().setBypass(nodeId, !bypassed)
            }}
            title={!out
              ? (error ?? (strip.running ? 'Applying the effects…' : 'Waiting for the effects'))
              : bypassed
                ? 'Showing the original — click to show the result'
                : `Showing the result of ${chainName} — click to show the original`}
            style={{
              ...chip,
              ...(showFx ? { color, border: `${f * 0.1}px solid ${color}99` } : null),
              ...(out ? null : { opacity: 0.75, cursor: 'default' }),
            }}
          >
            {error ? '⚠ ' : ''}{bypassed && out ? 'original' : 'fx'}{strip.running ? ' …' : ''}
          </button>
          {/* Save — what you see, at full size, as a real file. Not while the
              original is showing: it would save something not on screen. */}
          {hovered && showFx && (
            <button
              onPointerDown={stopPrimary} onMouseDown={stopPrimary} onDoubleClick={stop}
              onClick={e => { e.stopPropagation(); void doSave() }}
              disabled={save?.state === 'saving'}
              title={save?.state === 'saved' ? save.note
                : save?.state === 'failed' ? save.note
                : 'Save this result at full size'}
              style={{
                ...chip, fontWeight: 600,
                color: save?.state === 'failed' ? '#ff9b9b' : 'rgba(255,255,255,0.88)',
                cursor: save?.state === 'saving' ? 'default' : 'pointer',
              }}
            >
              {save?.state === 'saving' ? 'Saving…' : save?.state === 'saved' ? 'Saved' : save?.state === 'failed' ? 'Not saved' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}

// ── Drag-out copy ──────────────────────────────────────────────────────

/** Drag-out copies are rendered up to this long edge: more than any upload
 *  box keeps, and quick enough to make on hover. (Save renders full size.) */
const DRAG_SIDE = 4096

// Shared by every tile and kept across remounts — LayerRouter remounts the
// whole canvas at each zoom threshold. Keyed by signature: the strip as this
// picture reads it (itemsForSource, stringified), so a moved slider or a
// relabelled picture is a new file, and coming back to an earlier setting
// finds the old one. The files themselves are main's: it keeps the Drag
// Cache to a budget, but never prunes its newest files — more of them than
// this map holds (DRAG_FILES_MAX), so every url here still has its file.
const dragFiles = new Map<string, string>()          // signature → url
const DRAG_FILES_MAX = 32
const preparing = new Map<string, Promise<string | null>>()
/** Signature → when it last failed. Retried after a while, not never: a
 *  failure can be passing (a GPU reset mid-run, a full disk since cleared),
 *  and while a result shows, its tile has no grip without a file. */
const failed = new Map<string, number>()
const RETRY_SIG_MS = 30_000
/** Main has no 'drag' kind (it is older than this page, and only restarts
 *  with the window): say nothing more to it this session. */
let refused = false
/** Failures in a row. A few, and preparing pauses for a minute — a lost
 *  GPU or a GPU too small for DRAG_SIDE must not become a 4096 render on
 *  every hover, but it must not switch drag-out off for the session
 *  either. */
let failures = 0
let pausedUntil = 0

function canPrepare(): boolean {
  const d = window.vidbarsDesktop
  // Both halves: without the drag there is nothing to prepare for, and
  // without the save there is nowhere to put it.
  return !refused && performance.now() >= pausedUntil && !!d
    && typeof d.saveImage === 'function' && typeof d.startMediaDrag === 'function'
}

/** Failed lately: not worth another render yet. The next hover after the
 *  cooldown retries — the effect re-runs on every hover change. */
function recentlyFailed(sig: string): boolean {
  const t = failed.get(sig)
  if (t === undefined) return false
  if (performance.now() - t < RETRY_SIG_MS) return true
  failed.delete(sig)
  return false
}

function prepareDragFile(sig: string, items: ChainItem[], sourceId: string): Promise<string | null> {
  const known = dragFiles.get(sig)
  if (known) return Promise.resolve(known)
  const pending = preparing.get(sig)
  if (pending) return pending
  const p = (async (): Promise<string | null> => {
    try {
      const result = await runChain(items, DRAG_SIDE, false)
      const out = result.outputs.find(o => o.sourceId === sourceId)
      if (!out) return null
      // Rendered for this file alone (never a live result from fxStore,
      // which a remounting tile may still draw), so it is released once
      // encoded.
      const r = await saveCanvasImage(out.canvas, 'drag', resultName(out.label, items), 'jpeg', 0.92, true)
      if (r.error === 'Not allowed') refused = true
      return r.path ? diskFileUrl(r.path) : null
    } catch {
      return null
    }
  })().then(url => {
    preparing.delete(sig)
    if (url) {
      failures = 0
      failed.delete(sig)
      dragFiles.set(sig, url)
      if (dragFiles.size > DRAG_FILES_MAX) dragFiles.delete(dragFiles.keys().next().value!)
    } else {
      failed.set(sig, performance.now())
      if (++failures >= 3) {
        pausedUntil = performance.now() + 60_000
        failures = 0
      }
    }
    return url
  })
  preparing.set(sig, p)
  return p
}

/** For the tile header's drag-out grip. `active` ⇒ this tile SHOWS a
 *  processed result right now (a strip's source, not flipped to the
 *  original, with an output), so the grip must carry that, not the
 *  tile's own file. While active and hovered it prepares (debounced) a
 *  file of the result, and `url` is that file's once it is WRITTEN — never
 *  before: DragOutGrip remembers "missing" for 10 s. Until then (and in a
 *  plain browser, or with a main too old to write one) `url` is null, and
 *  the tile shows no grip rather than one that drags the original. When
 *  !active the caller uses the tile's own imageUrl as before. */
// Lives with FxResultLayer, which it mirrors (same strip, same flip); fast
// refresh of this file just remounts the tiles.
// eslint-disable-next-line react-refresh/only-export-components
export function useFxDragUrl(nodeId: string, hovered: boolean): { active: boolean; url: string | null } {
  // Narrow selectors: FreeNode calls this for every tile, and a whole-strip
  // subscription would re-render each one as every run starts and lands.
  const key = useFxStore(s => s.sources[nodeId])
  const items = useFxStore(s => (key ? s.strips[key]?.items : undefined))
  const bypassed = useFxStore(s => !!s.bypass[nodeId])
  const hasOut = useFxStore(s => !!(key && s.strips[key]?.result?.outputs.some(o => o.sourceId === nodeId)))
  // Still a narrow boolean: true only while this tile's own strip runs.
  const running = useFxStore(s => !!(key && s.strips[key]?.running))
  const active = !!items && !bypassed && hasOut
  const sig = useMemo(() => (active && items ? JSON.stringify(itemsForSource(items, nodeId)) : ''), [active, items, nodeId])
  // Re-render when this tile's file lands (the cache is not React state).
  const [, landed] = useReducer((n: number) => n + 1, 0)
  const wasHovered = useRef(false)

  useEffect(() => {
    // The settings changed under a pointer already resting here: keyboard
    // steps on a slider row, undo/redo.
    const inPlace = wasHovered.current && hovered
    wasHovered.current = hovered
    // Not while the strip is running: the live result the user is watching
    // comes first, and a setting still changing would make this file stale
    // before it lands.
    if (!sig || !hovered || running || !canPrepare() || dragFiles.has(sig) || recentlyFailed(sig)) return
    let live = true
    // Debounced: a pointer crossing the canvas must not render every
    // picture it passes over. A change made in place waits longer, for the
    // steps to settle — each prepare is a 4096 render, a JPEG encode on
    // this thread and a multi-MB file, not something to do per keypress.
    const t = window.setTimeout(() => {
      void prepareDragFile(sig, JSON.parse(sig) as ChainItem[], nodeId)
        .then(url => { if (live && url) landed() })
    }, inPlace ? 1000 : 300)
    return () => { live = false; window.clearTimeout(t) }
  }, [sig, hovered, running, nodeId])

  return { active, url: sig ? dragFiles.get(sig) ?? null : null }
}
