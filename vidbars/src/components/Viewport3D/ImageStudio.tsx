// ImageStudio.tsx — the Viewer's image tools. NON-DESTRUCTIVE by design:
// the source image is never modified. Every "stamp" mints a NEW image
// and drops it on the canvas as a tile in the first free space to the
// RIGHT of the window, so you can rattle off a series of derivatives.
//
//   view  — pan/zoom (wheel 1–8×, drag when zoomed, dblclick reset)
//   snip  — drag a box; RELEASING stamps it immediately and clears the
//           box. The mode stays active: zop, zop, zop.
//   crop  — drag once to place a persistent frame with 8 resize handles
//           and a draggable interior; Stamp saves the current frame and
//           the frame STAYS, so you can nudge/resize and stamp again.
//   paint — freehand brush; Stamp mints image+strokes (source untouched).
//
// Escape leaves any mode. Everything runs inside the CounterScaled plane
// (see ContentViews) so pointer math is screen-true at any canvas zoom.

import React, { useRef, useState, useEffect, useCallback } from 'react'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { putMedia } from '../../utils/mediaStore'
import { makeMediaRef } from '../../utils/mediaRef'

interface ImgViewState { scale: number; tx: number; ty: number }
const imgViews = new Map<string, ImgViewState>()

export type ImgMode = 'view' | 'snip' | 'crop' | 'paint'
interface PaintStroke { color: string; size: number; pts: { x: number; y: number }[] }
interface Box { x: number; y: number; w: number; h: number }
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move'

const PAINT_COLORS = ['#ffffff', '#f87171', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#111318']
const MIN_BOX = 10

const tbBtn = (active: boolean): React.CSSProperties => ({
  background: active ? 'rgba(120,170,255,0.25)' : 'rgba(255,255,255,0.05)',
  border: `1px solid ${active ? 'rgba(140,190,255,0.5)' : 'rgba(255,255,255,0.1)'}`,
  borderRadius: 4, color: active ? '#fff' : 'rgba(255,255,255,0.6)',
  fontSize: 11, fontWeight: 700, lineHeight: 1,
  padding: '4px 7px', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
})

/** Contain-fit box of a natural iw×ih image inside a w×h container. */
function fitBox(w: number, h: number, iw: number, ih: number) {
  const s = Math.min(w / iw, h / ih)
  const dw = iw * s, dh = ih * s
  return { s, dw, dh, ox: (w - dw) / 2, oy: (h - dh) / 2 }
}

/** AREA point → NATURAL image pixel, undoing the view transform (the img
 *  is scaled about the area's CENTER, then translated) and then the
 *  contain-fit. This is what lets snip/crop honour the current zoom+pan
 *  instead of assuming an untransformed image. */
function areaToNatural(
  p: { x: number; y: number },
  aw: number, ah: number,
  view: ImgViewState,
  nat: { w: number; h: number },
): { x: number; y: number } {
  const cx = aw / 2, cy = ah / 2
  const ux = cx + (p.x - cx - view.tx) / view.scale
  const uy = cy + (p.y - cy - view.ty) / view.scale
  const fit = fitBox(aw, ah, nat.w, nat.h)
  return { x: (ux - fit.ox) / fit.s, y: (uy - fit.oy) / fit.s }
}

/** Area px → natural px scale factor under the current view. */
function areaToNaturalScale(aw: number, ah: number, view: ImgViewState, nat: { w: number; h: number }): number {
  return 1 / (fitBox(aw, ah, nat.w, nat.h).s * view.scale)
}

/** First free spot to the RIGHT of the window that fits w×h, scanning
 *  down then wrapping to the next column. Avoids existing tiles AND
 *  windows so stamps never land on top of anything. */
function findFreeSlotRightOf(
  win: { x: number; y: number; width: number; height: number },
  w: number, h: number,
): { x: number; y: number } {
  type R = { x: number; y: number; width: number; height: number }
  const occupied: R[] = [
    ...Object.values(useFreeNodeStore.getState().nodes)
      .map(n => ({ x: n.x, y: n.y, width: n.width, height: n.height })),
    ...Object.values(useViewport3DStore.getState().windows)
      .map(v => ({ x: v.x, y: v.y, width: v.width, height: v.height })),
  ]
  const gap = Math.max(16, w * 0.08)
  const hits = (a: R, b: R) => !(
    a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y
  )
  for (let col = 0; col < 12; col++) {
    const x = win.x + win.width + gap + col * (w + gap)
    for (let row = 0; row < 24; row++) {
      const y = win.y + row * (h + gap)
      const cand = { x, y, width: w, height: h }
      if (!occupied.some(o => hits(cand, o))) return { x, y }
    }
  }
  return { x: win.x + win.width + gap, y: win.y }
}

export const ImageStudio: React.FC<{ windowId: string; url: string; name?: string }> = ({ windowId, url, name }) => {
  const resolved = useResolvedMedia(url)
  const key = `${windowId}|${url}`
  const [, bump] = useState(0)
  const [mode, setMode] = useState<ImgMode>('view')
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [cropBox, setCropBox] = useState<Box | null>(null)
  const [snipBox, setSnipBox] = useState<Box | null>(null)
  const [strokes, setStrokes] = useState<PaintStroke[]>([])
  const [brushColor, setBrushColor] = useState(PAINT_COLORS[1])
  const [brushSize, setBrushSize] = useState(6)
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState(0)          // stamp counter → toast
  const areaRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const dragLast = useRef<{ x: number; y: number } | null>(null)
  const boxStart = useRef<{ x: number; y: number } | null>(null)
  const painting = useRef(false)
  const panning = useRef(false)
  // Mirror of the in-progress snip box. pointerup must read the LIVE box,
  // not a possibly-stale render closure (fast drags can deliver move+up
  // inside one React batch).
  const snipBoxRef = useRef<Box | null>(null)
  // Crop-widget gesture: which handle, plus the box + pointer at grab.
  const gesture = useRef<{ handle: Handle; box: Box; from: { x: number; y: number } } | null>(null)

  const view = imgViews.get(key) ?? { scale: 1, tx: 0, ty: 0 }
  const setView = (v: ImgViewState) => { imgViews.set(key, v); bump(n => n + 1) }

  // Switching tools KEEPS the current zoom/pan — you frame the shot by
  // zooming in, then snip/crop exactly what you see.
  const enterMode = useCallback((m: ImgMode) => {
    setSnipBox(null)
    snipBoxRef.current = null
    if (m !== 'crop') setCropBox(null)
    if (m !== 'paint') setStrokes([])
    setMode(m)
  }, [])

  // Escape leaves any tool.
  useEffect(() => {
    if (mode === 'view') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      enterMode('view')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [mode, enterMode])

  /** Pointer → coordinates inside the image AREA. The CounterScaled
   *  plane is screen-true, so divide out its on-screen scale. */
  const localPoint = (e: React.PointerEvent) => {
    const el = areaRef.current!
    const r = el.getBoundingClientRect()
    const s = r.width / el.offsetWidth || 1
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s }
  }

  /** Mint a new image from a region (area coords; null = whole image),
   *  optionally with the paint strokes burned in, and drop it as a tile
   *  to the right of the window. The SOURCE IS NEVER TOUCHED. */
  const stamp = useCallback(async (region: Box | null, withStrokes: boolean) => {
    const img = imgRef.current, area = areaRef.current
    if (!img || !area || !natural || busy) return
    const aw = area.offsetWidth, ah = area.offsetHeight
    const v = imgViews.get(key) ?? { scale: 1, tx: 0, ty: 0 }
    let sx = 0, sy = 0, sw = natural.w, sh = natural.h
    if (region) {
      if (region.w < MIN_BOX || region.h < MIN_BOX) return
      // Region is in AREA coords — map through the live zoom/pan, then
      // clamp to the image so a box hanging off the edge still works.
      const tl = areaToNatural({ x: region.x, y: region.y }, aw, ah, v, natural)
      const br = areaToNatural({ x: region.x + region.w, y: region.y + region.h }, aw, ah, v, natural)
      const x0 = Math.max(0, Math.min(natural.w, Math.round(tl.x)))
      const y0 = Math.max(0, Math.min(natural.h, Math.round(tl.y)))
      const x1 = Math.max(0, Math.min(natural.w, Math.round(br.x)))
      const y1 = Math.max(0, Math.min(natural.h, Math.round(br.y)))
      sx = Math.min(x0, x1); sy = Math.min(y0, y1)
      sw = Math.abs(x1 - x0); sh = Math.abs(y1 - y0)
      if (sw < 2 || sh < 2) return
    }
    setBusy(true)
    try {
      const cnv = document.createElement('canvas')
      cnv.width = sw; cnv.height = sh
      const ctx = cnv.getContext('2d')!
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
      if (withStrokes && strokes.length > 0) {
        const k = areaToNaturalScale(aw, ah, v, natural)
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'
        for (const st of strokes) {
          ctx.strokeStyle = st.color
          ctx.lineWidth = st.size * k
          ctx.beginPath()
          st.pts.forEach((p, i) => {
            const n = areaToNatural(p, aw, ah, v, natural)
            const nx = n.x - sx, ny = n.y - sy
            if (i === 0) ctx.moveTo(nx, ny); else ctx.lineTo(nx, ny)
          })
          ctx.stroke()
        }
      }
      const blob = await new Promise<Blob | null>(res => cnv.toBlob(res, 'image/png'))
      if (!blob) return
      const ref = makeMediaRef(await putMedia(blob))

      const win = useViewport3DStore.getState().windows[windowId]
      if (!win) return
      // Tile sized for a comfortable on-screen read at the current zoom,
      // preserving the stamped aspect ratio.
      const z = useCanvasStore.getState().zoom
      const k = Math.max(0.6, Math.min(10, 1 / z))
      const tileW = 200 * k
      const tileH = Math.max(60 * k, tileW * (sh / sw))
      const slot = findFreeSlotRightOf(win, tileW, tileH)

      useUndoCoordinator.getState().checkpoint()
      const fns = useFreeNodeStore.getState()
      const nid = fns.addFreeNode(slot.x, slot.y, 'image')
      fns.updateFreeNode(nid, {
        width: tileW, height: tileH,
        imageUrl: ref, mediaType: 'image',
        label: `${name ?? 'Image'} ✂`,
      })
      setFlash(f => f + 1)
    } catch (err) {
      // e.g. a cross-origin image tainting the canvas — nothing written.
      console.warn('[image-studio] stamp failed', err)
    } finally {
      setBusy(false)
    }
  }, [natural, busy, strokes, windowId, name, key])

  // Toast fades on its own.
  useEffect(() => {
    if (flash === 0) return
    const t = window.setTimeout(() => setFlash(0), 900)
    return () => window.clearTimeout(t)
  }, [flash])

  // ── Area pointer handling ──
  const onDown = useCallback((e: React.PointerEvent) => {
    // PAN in any mode: middle-drag or Alt+drag. Keeps the tool armed
    // while you move around a zoomed-in image.
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.stopPropagation()
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      panning.current = true
      dragLast.current = { x: e.clientX, y: e.clientY }
      return
    }
    if (e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const p = localPoint(e)
    if (mode === 'snip') {
      boxStart.current = p
      snipBoxRef.current = { x: p.x, y: p.y, w: 0, h: 0 }
      setSnipBox(snipBoxRef.current)
    } else if (mode === 'crop') {
      // Starting a fresh frame (handles/interior have their own handlers).
      boxStart.current = p
      setCropBox({ x: p.x, y: p.y, w: 0, h: 0 })
    } else if (mode === 'paint') {
      painting.current = true
      setStrokes(s => [...s, { color: brushColor, size: brushSize, pts: [p] }])
    } else {
      dragLast.current = { x: e.clientX, y: e.clientY }
    }
  }, [mode, brushColor, brushSize])

  const onMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    if (panning.current && dragLast.current) {
      setView({ ...view, tx: view.tx + (e.clientX - dragLast.current.x), ty: view.ty + (e.clientY - dragLast.current.y) })
      dragLast.current = { x: e.clientX, y: e.clientY }
      return
    }
    const p = localPoint(e)
    const marquee = (s: { x: number; y: number }): Box => ({
      x: Math.min(s.x, p.x), y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y),
    })
    if (mode === 'snip' && boxStart.current) {
      snipBoxRef.current = marquee(boxStart.current)
      setSnipBox(snipBoxRef.current)
    } else if (mode === 'crop' && boxStart.current) {
      setCropBox(marquee(boxStart.current))
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, view])

  const onUp = useCallback(() => {
    if (panning.current) { panning.current = false; dragLast.current = null; return }
    // SNIP: releasing IS the save. Box clears; mode stays for the next one.
    if (mode === 'snip' && snipBoxRef.current) {
      const b = snipBoxRef.current
      snipBoxRef.current = null
      setSnipBox(null)
      boxStart.current = null
      void stamp(b, false)
      return
    }
    dragLast.current = null
    boxStart.current = null
    painting.current = false
  }, [mode, stamp])

  // Wheel zooms in EVERY mode, anchored on the cursor so the pixel under
  // the pointer stays put — you zoom to what you're about to snip.
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()
    const area = areaRef.current
    if (!area) return
    const next = Math.min(12, Math.max(1, view.scale * (e.deltaY > 0 ? 1 / 1.1 : 1.1)))
    if (next === view.scale) return
    if (next === 1) { setView({ scale: 1, tx: 0, ty: 0 }); return }
    const p = localPoint(e as unknown as React.PointerEvent)
    const cx = area.offsetWidth / 2, cy = area.offsetHeight / 2
    // Image-space point under the cursor, held invariant across the zoom.
    const ux = cx + (p.x - cx - view.tx) / view.scale
    const uy = cy + (p.y - cy - view.ty) / view.scale
    setView({
      scale: next,
      tx: p.x - cx - (ux - cx) * next,
      ty: p.y - cy - (uy - cy) * next,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  // ── Crop-widget handles ──
  const onHandleDown = (handle: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0 || !cropBox) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    gesture.current = { handle, box: cropBox, from: localPoint(e) }
  }
  const onHandleMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g || !(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const p = localPoint(e)
    const dx = p.x - g.from.x, dy = p.y - g.from.y
    const b = g.box
    let { x, y, w, h } = b
    const H = g.handle
    if (H === 'move') { x = b.x + dx; y = b.y + dy }
    else {
      if (H.includes('w')) { x = b.x + dx; w = b.w - dx }
      if (H.includes('e')) { w = b.w + dx }
      if (H.includes('n')) { y = b.y + dy; h = b.h - dy }
      if (H.includes('s')) { h = b.h + dy }
      // Flip-safe + minimum size
      if (w < MIN_BOX) { x = H.includes('w') ? b.x + b.w - MIN_BOX : x; w = MIN_BOX }
      if (h < MIN_BOX) { y = H.includes('n') ? b.y + b.h - MIN_BOX : y; h = MIN_BOX }
    }
    setCropBox({ x, y, w, h })
  }
  const onHandleUp = (e: React.PointerEvent) => {
    gesture.current = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
  }

  if (!resolved) {
    return (
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
        justifyContent: 'center', color: 'rgba(255,255,255,0.35)', fontSize: 13,
      }}>Loading…</div>
    )
  }

  const modeBtn = (m: ImgMode, label: string, title: string) => (
    <button key={m} style={tbBtn(mode === m)} title={title} onClick={() => enterMode(m)}>{label}</button>
  )
  const activeBox = mode === 'snip' ? snipBox : mode === 'crop' ? cropBox : null
  const hasCropFrame = mode === 'crop' && cropBox && cropBox.w >= MIN_BOX && cropBox.h >= MIN_BOX
  // Live px readout for the frame badge (area px → source px).
  const naturalPerArea = natural && areaRef.current
    ? areaToNaturalScale(areaRef.current.offsetWidth, areaRef.current.offsetHeight, view, natural)
    : 1

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
        {modeBtn('view', '⤢', 'View — wheel zoom · drag pan · double-click reset')}
        {modeBtn('snip', '✂', 'Snip — drag a box; releasing saves it out. Keep snipping. (Esc to exit)')}
        {modeBtn('crop', '⛶', 'Crop — place a frame, resize/move it, Stamp as many as you like. (Esc to exit)')}
        {modeBtn('paint', '✎', 'Paint — brush, then Stamp a painted copy. (Esc to exit)')}

        {mode === 'snip' && (
          <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.45)', marginLeft: 4 }}>
            drag a box — release saves it →
          </span>
        )}

        {mode === 'crop' && (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 'auto' }}>
            {!hasCropFrame && (
              <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.45)' }}>drag to place a frame</span>
            )}
            <button
              style={{ ...tbBtn(true), opacity: hasCropFrame && !busy ? 1 : 0.4 }}
              disabled={!hasCropFrame || busy}
              onClick={() => cropBox && void stamp(cropBox, false)}
              title="Save this frame as a new image (the frame stays put)"
            >{busy ? '…' : '⎘ Stamp'}</button>
            <button style={tbBtn(false)} onClick={() => setCropBox(null)} title="Clear the frame">Clear</button>
          </div>
        )}

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
            <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
              <button
                style={{ ...tbBtn(true), opacity: strokes.length && !busy ? 1 : 0.4 }}
                disabled={!strokes.length || busy}
                onClick={() => void stamp(null, true)}
                title="Save a painted copy as a new image"
              >{busy ? '…' : '⎘ Stamp'}</button>
              <button style={tbBtn(false)} onClick={() => setStrokes([])} title="Clear strokes">Clear</button>
            </div>
          </>
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
          cursor: mode === 'snip' || mode === 'crop' || mode === 'paint'
            ? 'crosshair'
            : view.scale > 1 ? 'grab' : 'default',
          touchAction: 'none',
        }}
      >
        <img
          ref={imgRef}
          src={resolved}
          draggable={false}
          onLoad={e => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            objectFit: 'contain',
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
          }}
        />

        {/* Paint overlay */}
        {mode === 'paint' && strokes.length > 0 && (
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            {strokes.map((st, i) => (
              <polyline
                key={i}
                points={st.pts.map(p => `${p.x},${p.y}`).join(' ')}
                fill="none" stroke={st.color} strokeWidth={st.size}
                strokeLinecap="round" strokeLinejoin="round"
              />
            ))}
          </svg>
        )}

        {/* Snip marquee (transient) + crop frame (persistent widget) */}
        {activeBox && activeBox.w > 0 && activeBox.h > 0 && (
          <div style={{
            position: 'absolute',
            left: activeBox.x, top: activeBox.y, width: activeBox.w, height: activeBox.h,
            border: `1.5px ${mode === 'crop' ? 'solid' : 'dashed'} rgba(140,190,255,0.95)`,
            background: 'rgba(120,170,255,0.10)',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
            pointerEvents: mode === 'crop' ? 'auto' : 'none',
            cursor: mode === 'crop' ? 'move' : 'crosshair',
          }}
            onPointerDown={mode === 'crop' ? onHandleDown('move') : undefined}
            onPointerMove={mode === 'crop' ? onHandleMove : undefined}
            onPointerUp={mode === 'crop' ? onHandleUp : undefined}
          >
            {/* Rule-of-thirds guides */}
            {mode === 'crop' && (
              <>
                {[1, 2].map(i => (
                  <div key={`v${i}`} style={{ position: 'absolute', left: `${(i * 100) / 3}%`, top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.18)', pointerEvents: 'none' }} />
                ))}
                {[1, 2].map(i => (
                  <div key={`h${i}`} style={{ position: 'absolute', top: `${(i * 100) / 3}%`, left: 0, right: 0, height: 1, background: 'rgba(255,255,255,0.18)', pointerEvents: 'none' }} />
                ))}
              </>
            )}
            {/* Floating stamp — rides with the frame so you can move,
                resize and fire off copies without going back to the
                toolbar. Sits below the frame, flipping above when the
                frame is near the bottom edge. */}
            {mode === 'crop' && cropBox && cropBox.w >= MIN_BOX && cropBox.h >= MIN_BOX && (
              <div
                onPointerDown={e => { e.stopPropagation(); e.preventDefault() }}
                onClick={e => { e.stopPropagation(); void stamp(cropBox, false) }}
                title="Save this frame as a new image (frame stays — move it and stamp again)"
                style={{
                  position: 'absolute',
                  left: '50%', transform: 'translateX(-50%)',
                  ...(cropBox.y + cropBox.h + 42 < (areaRef.current?.offsetHeight ?? 0)
                    ? { top: 'calc(100% + 8px)' }
                    : { bottom: 'calc(100% + 8px)' }),
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '5px 11px', borderRadius: 6, whiteSpace: 'nowrap',
                  background: busy ? 'rgba(90,110,160,0.9)' : 'rgba(120,170,255,0.92)',
                  border: '1px solid rgba(190,220,255,0.9)',
                  color: '#0b1020', fontSize: 11, fontWeight: 800,
                  cursor: busy ? 'default' : 'pointer',
                  boxShadow: '0 4px 14px rgba(0,0,0,0.55)',
                  userSelect: 'none',
                }}
              >
                {busy ? '…' : '⎘ Stamp'}
                <span style={{ fontSize: 9, fontWeight: 600, opacity: 0.65 }}>
                  {Math.max(1, Math.round(cropBox.w * naturalPerArea))}×{Math.max(1, Math.round(cropBox.h * naturalPerArea))}
                </span>
              </div>
            )}
            {/* 8 resize handles */}
            {mode === 'crop' && (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map(h => {
              const pos: React.CSSProperties = { position: 'absolute' }
              const S = 11, HALF = S / 2
              if (h.includes('n')) pos.top = -HALF
              if (h.includes('s')) pos.bottom = -HALF
              if (h.includes('w')) pos.left = -HALF
              if (h.includes('e')) pos.right = -HALF
              if (h === 'n' || h === 's') { pos.left = `calc(50% - ${HALF}px)` }
              if (h === 'e' || h === 'w') { pos.top = `calc(50% - ${HALF}px)` }
              const cursor =
                h === 'n' || h === 's' ? 'ns-resize'
                : h === 'e' || h === 'w' ? 'ew-resize'
                : h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize'
              return (
                <div
                  key={h}
                  onPointerDown={onHandleDown(h)}
                  onPointerMove={onHandleMove}
                  onPointerUp={onHandleUp}
                  style={{
                    ...pos, width: S, height: S, cursor,
                    background: 'rgba(20,24,40,0.95)',
                    border: '1.5px solid rgba(160,200,255,0.95)',
                    borderRadius: 2, boxSizing: 'border-box',
                  }}
                />
              )
            })}
          </div>
        )}

        {/* Stamp confirmation */}
        {flash > 0 && (
          <div style={{
            position: 'absolute', right: 10, bottom: 10,
            padding: '5px 10px', borderRadius: 5,
            background: 'rgba(120,170,255,0.28)', border: '1px solid rgba(160,200,255,0.6)',
            color: '#fff', fontSize: 10.5, fontWeight: 700, pointerEvents: 'none',
          }}>saved →</div>
        )}
      </div>
    </div>
  )
}
