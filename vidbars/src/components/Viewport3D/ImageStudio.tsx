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
//   paint — freehand brush, or a basic shape (rectangle, ellipse, line,
//           arrow; Fill on or off); Stamp mints image+strokes (source
//           untouched).
//   annotate — the same brush and shapes, and an eraser, as LASTING marks
//           on the picture (store/notesStore pictures, by its url, in its
//           own pixels): shown whenever the picture is, in any Viewer,
//           moving with zoom and pan. Never burned into a stamp.
//
// Escape leaves any mode. Everything runs inside the CounterScaled plane
// (see ContentViews) so pointer math is screen-true at any canvas zoom.

import React, { useRef, useState, useEffect, useCallback } from 'react'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useBoardsStore } from '../../store/boardsStore'
import { tileDeckIndex } from '../../utils/tileDecks'
import { cardFaceSize } from '../../utils/cardGrid'
import { drawnRect } from '../../utils/effectCards'
import { landSnip } from '../../utils/snipCards'
import { markNew } from '../../utils/newCards'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useNotesStore, newNoteId, type PictureMark } from '../../store/notesStore'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { CanvasMirror } from '../UI/CanvasMirror'
import type { FullFrame } from '../../utils/fx/railFullFrame'

interface ImgViewState { scale: number; tx: number; ty: number }
const imgViews = new Map<string, ImgViewState>()

export type ImgMode = 'view' | 'snip' | 'crop' | 'paint' | 'annotate'
/** What Paint draws with: the brush, or a shape dragged corner to corner
 *  (a line or arrow start to end). Brian 2026-11-08. */
export type PaintTool = 'brush' | 'rect' | 'ellipse' | 'line' | 'arrow'
type Shape = Exclude<PaintTool, 'brush'>
export interface PaintStroke { color: string; size: number; pts: { x: number; y: number }[]; shape?: Shape; fill?: boolean }

export const PAINT_TOOLS: { id: PaintTool; icon: React.ReactNode; tip: string }[] = [
  { id: 'brush', icon: <path d="M3 13c2-1 3-4 5-4s1 3 3 3 2-5 2-5" />, tip: 'Brush: paint freehand' },
  { id: 'rect', icon: <rect x="2.5" y="4" width="11" height="8" />, tip: 'Rectangle: drag corner to corner' },
  { id: 'ellipse', icon: <ellipse cx="8" cy="8" rx="5.5" ry="4" />, tip: 'Ellipse: drag corner to corner' },
  { id: 'line', icon: <path d="M3 13L13 3" />, tip: 'Line: drag start to end' },
  { id: 'arrow', icon: <><path d="M3 13L13 3" /><path d="M7.5 3H13v5.5" /></>, tip: 'Arrow: drag start to end' },
]

/** Annotate's tools: Paint's, and an eraser. */
type AnnoTool = PaintTool | 'erase'
export const ERASE_ICON = <><path d="M9.5 3.5l3 3-6 6H4l-1.5-1.5z" /><path d="M7 13h6.5" /></>
const NO_MARKS: PictureMark[] = []

/** Is natural point n on mark m (within tol natural px)? */
export function hitMark(m: PictureMark, n: { x: number; y: number }, tol: number): boolean {
  const t = tol + m.size / 2
  const seg = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy
    const u = l2 ? Math.max(0, Math.min(1, ((n.x - a.x) * dx + (n.y - a.y) * dy) / l2)) : 0
    return Math.hypot(n.x - a.x - dx * u, n.y - a.y - dy * u) <= t
  }
  const a = m.pts[0], b = m.pts[m.pts.length - 1]
  if (!m.shape) return m.pts.length === 1 ? seg(a, a) : m.pts.some((p, i) => i > 0 && seg(m.pts[i - 1], p))
  if (m.shape === 'line' || m.shape === 'arrow') return seg(a, b)
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y)
  if (m.shape === 'rect') {
    if (m.fill && n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1) return true
    const c = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
    return c.some((p, i) => seg(p, c[(i + 1) % 4]))
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max((x1 - x0) / 2, 1e-6), ry = Math.max((y1 - y0) / 2, 1e-6)
  const q = Math.hypot((n.x - cx) / rx, (n.y - cy) / ry)
  if (m.fill && q <= 1) return true
  return Math.abs(q - 1) * Math.min(rx, ry) <= t
}

/** A shape's arrowhead: its two barbs' ends, for a line from a to b. */
export function arrowBarbs(a: { x: number; y: number }, b: { x: number; y: number }, size: number) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x)
  const len = Math.min(Math.max(10, size * 3.2), Math.hypot(b.x - a.x, b.y - a.y) * 0.6)
  return [ang + Math.PI * 0.82, ang - Math.PI * 0.82].map(t => ({ x: b.x + Math.cos(t) * len, y: b.y + Math.sin(t) * len }))
}

/** Draw a Paint stroke on a 2D canvas, `at` taking a point to its pixel
 *  there and `k` a width (the Stamp). */
export function drawStroke(ctx: CanvasRenderingContext2D, st: PaintStroke, at: (p: { x: number; y: number }) => { x: number; y: number }, k: number) {
  ctx.strokeStyle = st.color
  ctx.fillStyle = st.color
  ctx.lineWidth = st.size * k
  ctx.beginPath()
  if (!st.shape) {
    st.pts.forEach((p, i) => { const n = at(p); if (i === 0) ctx.moveTo(n.x, n.y); else ctx.lineTo(n.x, n.y) })
    ctx.stroke()
    return
  }
  const a = at(st.pts[0]), b = at(st.pts[st.pts.length - 1])
  if (st.shape === 'rect') ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
  else if (st.shape === 'ellipse') ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2)
  else {
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y)
    if (st.shape === 'arrow') {
      const [l, rr] = arrowBarbs(a, b, st.size * k)
      ctx.moveTo(l.x, l.y); ctx.lineTo(b.x, b.y); ctx.lineTo(rr.x, rr.y)
    }
  }
  if (st.fill && (st.shape === 'rect' || st.shape === 'ellipse')) ctx.fill()
  else ctx.stroke()
}

/** The same stroke as SVG, in the image area's px. */
export const StrokeSvg: React.FC<{ st: PaintStroke }> = ({ st }) => {
  const line = { stroke: st.color, strokeWidth: st.size, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (!st.shape) return <polyline points={st.pts.map(p => `${p.x},${p.y}`).join(' ')} fill="none" {...line} />
  const a = st.pts[0], b = st.pts[st.pts.length - 1]
  const filled = st.fill ? { fill: st.color, stroke: 'none' } : { fill: 'none', ...line }
  if (st.shape === 'rect') return <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} {...filled} />
  if (st.shape === 'ellipse') return <ellipse cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} rx={Math.abs(b.x - a.x) / 2} ry={Math.abs(b.y - a.y) / 2} {...filled} />
  const barbs = st.shape === 'arrow' ? arrowBarbs(a, b, st.size) : null
  return <path d={`M${a.x},${a.y}L${b.x},${b.y}${barbs ? `M${barbs[0].x},${barbs[0].y}L${b.x},${b.y}L${barbs[1].x},${barbs[1].y}` : ''}`} fill="none" {...line} />
}
interface Box { x: number; y: number; w: number; h: number }
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move'

export const PAINT_COLORS = ['#ffffff', '#f87171', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#111318']
const MIN_BOX = 10

/** The tool row's fixed height. It never changes, so the image area under
 *  it never moves while a tool is in use. */
const TOOLBAR_H = 32
/** Stamp keeps its width while it reads "…" (a cut in flight). */
const STAMP_SLOT: React.CSSProperties = { minWidth: 58, textAlign: 'center' }

export const tbBtn = (active: boolean): React.CSSProperties => ({
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

function cardRects(): { x: number; y: number; width: number; height: number }[] {
  const { groups, boards } = useBoardsStore.getState()
  const zoom = useCanvasStore.getState().zoom
  return groups.flatMap(g => {
    if (g.pin) return []
    const r = drawnRect(g, boards, zoom)
    return r ? [r] : []
  })
}

/** First free spot to the RIGHT of the window that fits w×h, scanning
 *  down then wrapping to the next column. Avoids existing tiles AND
 *  windows so stamps never land on top of anything. */
export function findFreeSlotRightOf(
  win: { x: number; y: number; width: number; height: number },
  w: number, h: number,
): { x: number; y: number } {
  type R = { x: number; y: number; width: number; height: number }
  const nodes = useFreeNodeStore.getState().nodes
  const { hidden } = tileDeckIndex(nodes)
  const occupied: R[] = [
    ...Object.values(nodes)
      // A pinned node reserves no world space — counting it would
      // displace stamped tiles around wherever it used to sit. Nor does a
      // tile hidden behind a deck face: it is not geometry.
      .filter(n => !n.pin && !hidden.has(n.id))
      .map(n => ({ x: n.x, y: n.y, width: n.width, height: n.height })),
    ...Object.values(useViewport3DStore.getState().windows)
      .map(v => ({ x: v.x, y: v.y, width: v.width, height: v.height })),
    // Pieces land as cards, so cards are in the way too.
    ...cardRects(),
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

/** Cut from a live canvas instead of a stored picture: `canvas` is what the
 *  Viewer shows, `full` renders the same frame at full size for the cut. */
export interface ImageStudioLive {
  canvas: HTMLCanvasElement
  full: () => Promise<FullFrame | null>
}

export const ImageStudio: React.FC<{ windowId: string; url: string; name?: string; live?: ImageStudioLive; toolbarStart?: React.ReactNode }> = ({ windowId, url, name, live, toolbarStart }) => {
  const resolved = useResolvedMedia(live ? null : url)
  const key = `${windowId}|${url}`
  const [, bump] = useState(0)
  const [mode, setMode] = useState<ImgMode>('view')
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [cropBox, setCropBox] = useState<Box | null>(null)
  const [snipBox, setSnipBox] = useState<Box | null>(null)
  const [strokes, setStrokes] = useState<PaintStroke[]>([])
  const [brushColor, setBrushColor] = useState(PAINT_COLORS[1])
  const [brushSize, setBrushSize] = useState(6)
  const [paintTool, setPaintTool] = useState<PaintTool>('brush')
  const [fill, setFill] = useState(false)
  const [annoTool, setAnnoTool] = useState<AnnoTool>('brush')
  const marks = useNotesStore(s => s.pictures[url]) ?? NO_MARKS
  // The mark being drawn, or erasing, in Annotate.
  const annoId = useRef<string | null>(null)
  const erasing = useRef(false)
  const [busy, setBusy] = useState(false)
  // Full-size px per shown px of a live canvas, once a cut has measured it.
  const [liveK, setLiveK] = useState<number | null>(null)
  // Stamps in flight. A live cut can wait on a render: later cuts queue on
  // it rather than being dropped, so busy is a count, not a gate.
  const inFlight = useRef(0)
  const liveRef = useRef(live)
  liveRef.current = live
  const [flash, setFlash] = useState(0)          // stamp counter → toast
  const areaRef = useRef<HTMLDivElement>(null)
  const liveW = live?.canvas.width, liveH = live?.canvas.height
  useEffect(() => {
    if (liveW && liveH) setNatural({ w: liveW, h: liveH })
  }, [liveW, liveH])
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
    const img = imgRef.current, area = areaRef.current, live = liveRef.current
    if ((!live && !img) || !area || !natural) return
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
    inFlight.current++
    setBusy(true)
    let frame: FullFrame | null = null
    try {
      if (live) {
        frame = await live.full()
        if (!frame) console.warn('[image-studio] no full-size frame; cutting from the preview')
      }
      const src: HTMLCanvasElement | HTMLImageElement = frame?.canvas ?? live?.canvas ?? img!
      // Region and strokes are in shown pixels; the frame may hold more.
      const r = frame ? frame.canvas.width / natural.w : 1
      if (live) setLiveK(r)
      const outW = Math.max(1, Math.round(sw * r)), outH = Math.max(1, Math.round(sh * r))
      const cnv = document.createElement('canvas')
      cnv.width = outW; cnv.height = outH
      const ctx = cnv.getContext('2d')!
      ctx.drawImage(src, sx * r, sy * r, sw * r, sh * r, 0, 0, outW, outH)
      ctx.scale(r, r)
      if (withStrokes && strokes.length > 0) {
        const k = areaToNaturalScale(aw, ah, v, natural)
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'
        const at = (p: { x: number; y: number }) => {
          const n = areaToNatural(p, aw, ah, v, natural)
          return { x: n.x - sx, y: n.y - sy }
        }
        for (const st of strokes) drawStroke(ctx, st, at, k)
      }
      // A DATA URL, not a blob. Measured in this runtime: canvas.toBlob
      // produces a blob whose arrayBuffer() throws NotReadableError and
      // whose object URL will not decode in an <img> at all — so every
      // snip and stamp landed on the canvas as an empty tile. Files picked
      // from disk are fine (they are disk-backed); anything MANUFACTURED in
      // the browser has to be a data URL. Do not "optimise" this back.
      //
      // PNG while the region is modest, JPEG above that: a 4K snip as PNG
      // is a multi-megabyte string that then rides every persist of this
      // node. The source pixels are already composited onto an opaque
      // canvas by the drawImage above, so dropping alpha costs nothing.
      const px = outW * outH
      const ref = px <= 1_200_000
        ? cnv.toDataURL('image/png')
        : cnv.toDataURL('image/jpeg', 0.92)
      if (!ref || ref.length < 32) return

      const win = useViewport3DStore.getState().windows[windowId]
      if (!win) return
      useUndoCoordinator.getState().checkpoint()
      const face = cardFaceSize()
      markNew([landSnip(
        { url: ref, aspect: outH / outW, label: `${name ?? 'Image'} ✂`, source: url },
        () => findFreeSlotRightOf(win, face.w, face.h),
      )])
      setFlash(f => f + 1)
    } catch (err) {
      // e.g. a cross-origin image tainting the canvas — nothing written.
      console.warn('[image-studio] stamp failed', err)
    } finally {
      frame?.release()
      if (--inFlight.current === 0) setBusy(false)
    }
  }, [natural, strokes, windowId, name, key, url])

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
    } else if (mode === 'annotate') {
      const area = areaRef.current
      if (!natural || live || !area) return
      useUndoCoordinator.getState().checkpoint()
      const aw = area.offsetWidth, ah = area.offsetHeight
      const v = imgViews.get(key) ?? { scale: 1, tx: 0, ty: 0 }
      const n = areaToNatural(p, aw, ah, v, natural)
      const k = areaToNaturalScale(aw, ah, v, natural)
      if (annoTool === 'erase') {
        erasing.current = true
        const hit = marks.filter(m => hitMark(m, n, 6 * k)).map(m => m.id)
        if (hit.length) useNotesStore.getState().removeMarks(url, hit)
        return
      }
      const id = newNoteId('mk')
      annoId.current = id
      useNotesStore.getState().addMark(url, annoTool === 'brush'
        ? { id, color: brushColor, size: brushSize * k, pts: [n] }
        : { id, color: brushColor, size: brushSize * k, pts: [n, n], shape: annoTool, fill })
    } else if (mode === 'paint') {
      painting.current = true
      setStrokes(s => [...s, paintTool === 'brush'
        ? { color: brushColor, size: brushSize, pts: [p] }
        : { color: brushColor, size: brushSize, pts: [p, p], shape: paintTool, fill }])
    } else {
      dragLast.current = { x: e.clientX, y: e.clientY }
    }
  }, [mode, brushColor, brushSize, paintTool, fill, annoTool, natural, live, url, marks, key])

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
    } else if (mode === 'annotate' && (annoId.current || erasing.current) && natural && areaRef.current) {
      const aw = areaRef.current.offsetWidth, ah = areaRef.current.offsetHeight
      const n = areaToNatural(p, aw, ah, view, natural)
      const ns = useNotesStore.getState()
      if (erasing.current) {
        const k = areaToNaturalScale(aw, ah, view, natural)
        const hit = (ns.pictures[url] ?? []).filter(m => hitMark(m, n, 6 * k)).map(m => m.id)
        if (hit.length) ns.removeMarks(url, hit)
        return
      }
      const m = ns.pictures[url]?.find(x => x.id === annoId.current)
      if (m) ns.updateMark(url, m.id, { pts: m.shape ? [m.pts[0], n] : [...m.pts, n] })
    } else if (mode === 'paint' && painting.current) {
      setStrokes(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        next[next.length - 1] = { ...last, pts: last.shape ? [last.pts[0], p] : [...last.pts, p] }
        return next
      })
    } else if (mode === 'view' && dragLast.current) {
      setView({ ...view, tx: view.tx + (e.clientX - dragLast.current.x), ty: view.ty + (e.clientY - dragLast.current.y) })
      dragLast.current = { x: e.clientX, y: e.clientY }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, view, natural, url])

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
    annoId.current = null
    erasing.current = false
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

  if (!resolved && !live) {
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
      {/* Toolbar — ONE fixed-height row, never wrapping. Its contents change
          with the tool and mid-gesture (hints come and go, Stamp turns to
          "…" while a cut is in flight); a wrapping row grew and shrank with
          them and bumped the image up and down under the pointer. Whatever
          does not fit scrolls sideways (no scrollbar, so it adds no height). */}
      <div
        onPointerDown={e => e.stopPropagation()}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'nowrap',
          height: TOOLBAR_H, boxSizing: 'border-box', whiteSpace: 'nowrap',
          overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none',
          padding: '0 10px', background: 'rgba(20,22,38,0.95)',
          borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
        }}
      >
        {toolbarStart}
        {modeBtn('view', '⤢', 'View — wheel zoom · drag pan · double-click reset')}
        {/* Zoomed or panned into, the picture is cut off at its edges: one click
            shows all of it again (double-click does too). */}
        {(view.scale !== 1 || view.tx !== 0 || view.ty !== 0) && (
          <button style={tbBtn(true)} title="Zoomed in: show the whole picture (double-click does too)" onClick={() => setView({ scale: 1, tx: 0, ty: 0 })}>Fit</button>
        )}
        {modeBtn('snip', '✂', 'Snip — drag a box; releasing saves it out. Keep snipping. (Esc to exit)')}
        {modeBtn('crop', '⛶', 'Crop — place a frame, resize/move it, Stamp as many as you like. (Esc to exit)')}
        {modeBtn('paint', '✎', 'Paint — brush or shapes (rectangle, ellipse, line, arrow), then Stamp a painted copy. (Esc to exit)')}
        {!live && modeBtn('annotate', '✐', 'Annotate — brush, shapes and eraser as lasting marks on this picture: they stay on it wherever it is shown. Never stamped in. (Esc to exit)')}

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
              style={{ ...tbBtn(true), ...STAMP_SLOT, opacity: hasCropFrame && !busy ? 1 : 0.4 }}
              disabled={!hasCropFrame || busy}
              onClick={() => cropBox && void stamp(cropBox, false)}
              title="Save this frame as a new image (the frame stays put)"
            >{busy ? '…' : '⎘ Stamp'}</button>
            <button style={tbBtn(false)} onClick={() => setCropBox(null)} title="Clear the frame">Clear</button>
          </div>
        )}

        {mode === 'annotate' && (
          <>
            <div style={{ display: 'flex', gap: 2, alignItems: 'center', marginLeft: 4 }}>
              {[...PAINT_TOOLS, { id: 'erase' as const, icon: ERASE_ICON, tip: 'Erase: click or drag over a mark to remove it' }].map(t => (
                <button key={t.id} style={{ ...tbBtn(annoTool === t.id), padding: '3px 4px' }} aria-pressed={annoTool === t.id} title={t.tip} onClick={() => setAnnoTool(t.id)}>
                  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>{t.icon}</svg>
                </button>
              ))}
              <button style={{ ...tbBtn(fill), padding: '3px 4px' }} aria-pressed={fill} onClick={() => setFill(f => !f)}
                title="Fill: on or off. On, rectangles and ellipses are solid colour.">
                <svg width={14} height={14} viewBox="0 0 16 16" style={{ display: 'block' }}><rect x="3" y="3" width="10" height="10" rx="2" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.6} /></svg>
              </button>
            </div>
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
              <button style={{ ...tbBtn(false), opacity: marks.length ? 1 : 0.4 }} disabled={!marks.length}
                onClick={() => { useUndoCoordinator.getState().checkpoint(); useNotesStore.getState().clearMarks(url) }}
                title="Remove every mark on this picture (Ctrl+Z brings them back)">Clear</button>
            </div>
          </>
        )}

        {mode === 'paint' && (
          <>
            <div style={{ display: 'flex', gap: 2, alignItems: 'center', marginLeft: 4 }}>
              {PAINT_TOOLS.map(t => (
                <button key={t.id} style={{ ...tbBtn(paintTool === t.id), padding: '3px 4px' }} aria-pressed={paintTool === t.id} title={t.tip} onClick={() => setPaintTool(t.id)}>
                  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>{t.icon}</svg>
                </button>
              ))}
              <button style={{ ...tbBtn(fill), padding: '3px 4px' }} aria-pressed={fill} onClick={() => setFill(f => !f)}
                title="Fill: on or off. On, rectangles and ellipses are solid colour.">
                <svg width={14} height={14} viewBox="0 0 16 16" style={{ display: 'block' }}><rect x="3" y="3" width="10" height="10" rx="2" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.6} /></svg>
              </button>
            </div>
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
                style={{ ...tbBtn(true), ...STAMP_SLOT, opacity: strokes.length && !busy ? 1 : 0.4 }}
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
          cursor: mode === 'snip' || mode === 'crop' || mode === 'paint' || mode === 'annotate'
            ? 'crosshair'
            : view.scale > 1 ? 'grab' : 'default',
          touchAction: 'none',
        }}
      >
        {live ? (
          <CanvasMirror
            source={live.canvas}
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              maxWidth: 'none', maxHeight: 'none', objectFit: 'contain',
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
            }}
          />
        ) : (
          <img
            ref={imgRef}
            src={resolved ?? undefined}
            draggable={false}
            onLoad={e => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              objectFit: 'contain',
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
            }}
          />
        )}

        {/* Lasting marks: on the picture, so they zoom and pan with it. */}
        {!live && marks.length > 0 && natural && areaRef.current && (() => {
          const fit = fitBox(areaRef.current.offsetWidth, areaRef.current.offsetHeight, natural.w, natural.h)
          return (
            <div data-picture-marks="" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}>
              <svg viewBox={`0 0 ${natural.w} ${natural.h}`} style={{ position: 'absolute', left: fit.ox, top: fit.oy, width: fit.dw, height: fit.dh, overflow: 'visible' }}>
                {marks.map(m => <StrokeSvg key={m.id} st={m} />)}
              </svg>
            </div>
          )
        })()}

        {/* Paint overlay */}
        {mode === 'paint' && strokes.length > 0 && (
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            {strokes.map((st, i) => <StrokeSvg key={i} st={st} />)}
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
                  {(!live || liveK) && <>{Math.max(1, Math.round(cropBox.w * naturalPerArea * (liveK ?? 1)))}×{Math.max(1, Math.round(cropBox.h * naturalPerArea * (liveK ?? 1)))}</>}
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
