/**
 * Wraps any drawable surface (card, block, bar, free node) and routes pointer
 * events to the annotation system *only* when this surface is the active
 * draw target (canvasStore.drawSurface). Otherwise it's an inert pass-through.
 *
 * Responsibilities:
 *  - Capture pointerdown/move/up while in draw mode for THIS surface.
 *  - Buffer in-flight points; render the live stroke as it's being drawn.
 *  - On pointerup, append the finalized stroke to the host's strokes array.
 *  - In eraser mode, treat the pointer as a hit-test that deletes any stroke
 *    it crosses.
 *  - Always render saved strokes (whether or not in draw mode).
 *
 * The SVG renders ABOVE the surface's normal content but BELOW any chrome
 * that needs to remain interactive (selection handles, etc). Caller controls
 * that via z-index of its own children.
 *
 * Coordinates are normalized to [0, 1] across the surface's measured bounds,
 * so the same stroke data reads correctly across resizes and zoom changes.
 */
import React, { useRef, useState, useCallback, useEffect } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { sameSurface, surfaceId, type Stroke, type StrokePoint, type DrawSurface } from '../../types/stroke'
import { addStroke, deleteStroke, readStrokes } from '../../utils/strokeActions'
import { StrokeLayer } from './StrokeLayer'

interface Props {
  surface: DrawSurface
  /** Width / height of the drawable bounds in CSS pixels (post-zoom). */
  width: number
  height: number
  /** Saved strokes for this surface — caller passes them in so subscriptions
   *  belong to the parent (avoids re-subscribing inside this generic wrapper). */
  strokes: Stroke[]
  /** Optional rounded-corner radius matching the host surface. */
  borderRadius?: number
  /** Z-index for the SVG / hit layer. Defaults to a high value. */
  zIndex?: number
}

export const DrawableSurface: React.FC<Props> = ({
  surface,
  width,
  height,
  strokes,
  borderRadius = 0,
  zIndex = 50,
}) => {
  const activeSurface = useCanvasStore(s => s.drawSurface)
  const tool = useCanvasStore(s => s.drawTool)
  const color = useCanvasStore(s => s.drawColor)
  const size = useCanvasStore(s => s.drawSize)

  const isActive = sameSurface(activeSurface, surface)

  // ── In-flight stroke buffer ─────────────────────────────────
  // Backed by a ref (mutated in-place) rather than React state, to avoid
  // allocating a new array on every pointermove. With high-frequency input
  // (modern tablets, fast mouse moves) the old `[...prev, p]` approach
  // generated huge GC pressure, which produced periodic main-thread
  // pauses — and during those pauses the browser coalesced incoming
  // pointer events, leaving visible straight-line "interrupts" in the
  // stroke. We now mutate the ref and only force a render via a tiny
  // counter, keeping allocations to a single array per stroke.
  const livePointsRef = useRef<StrokePoint[]>([])
  const [, forceRender] = useState(0)
  const bumpRender = useCallback(() => forceRender(n => (n + 1) & 0xffff), [])

  const drawingRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  // Track strokes already erased during this drag so we don't fire repeated
  // delete dispatches for the same victim.
  const erasedThisDragRef = useRef<Set<string>>(new Set())

  const finishStroke = useCallback(() => {
    if (!drawingRef.current) return
    drawingRef.current = false
    const points = livePointsRef.current
    livePointsRef.current = []
    bumpRender()
    if (points.length < 2) return
    const stroke: Stroke = {
      id: crypto.randomUUID(),
      points,
      color,
      size,
      tool: 'pen',
    }
    addStroke(surface, stroke)
  }, [color, size, surface, bumpRender])

  // Convert clientX/Y (screen) to normalized coords [0,1] across surface
  const normalize = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current
    if (!el) return { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    return {
      x: (clientX - rect.left) / Math.max(1, rect.width),
      y: (clientY - rect.top) / Math.max(1, rect.height),
    }
  }, [])

  // Hit-test for eraser: find a stroke whose point is within `tolerance` of
  // the pointer (normalized space), return its id or null.
  const hitTestStroke = useCallback((nx: number, ny: number): string | null => {
    // Tolerance scales loosely with the current pen size, but stays generous
    // enough that the eraser feels forgiving even for thin strokes.
    const tol = Math.max(0.012, size / 200)
    for (const s of strokes) {
      if (erasedThisDragRef.current.has(s.id)) continue
      for (const p of s.points) {
        const dx = p.x - nx
        const dy = p.y - ny
        if (dx * dx + dy * dy <= tol * tol) return s.id
      }
    }
    return null
  }, [strokes, size])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!isActive) return
    if (e.button !== 0) return  // primary only
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)

    if (tool === 'eraser') {
      erasedThisDragRef.current.clear()
      const { x, y } = normalize(e.clientX, e.clientY)
      const hit = hitTestStroke(x, y)
      if (hit) {
        erasedThisDragRef.current.add(hit)
        deleteStroke(surface, hit)
      }
      drawingRef.current = true
      return
    }

    // Pen mode — start a fresh live buffer.
    drawingRef.current = true
    const { x, y } = normalize(e.clientX, e.clientY)
    const pressure = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5
    livePointsRef.current = [{ x, y, pressure }]
    bumpRender()
  }, [isActive, tool, normalize, hitTestStroke, surface, bumpRender])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isActive || !drawingRef.current) return
    e.stopPropagation()

    // Coalesced events: when the browser collapses multiple pointer samples
    // into one delivered `pointermove` (high input rate, or a main-thread
    // block), getCoalescedEvents() returns the FULL underlying stream.
    // Capturing all of them eliminates the straight-line "interrupt" you
    // see otherwise, since the actual stylus / mouse path is recovered.
    const native = e.nativeEvent
    const samples: PointerEvent[] = (typeof native.getCoalescedEvents === 'function')
      ? native.getCoalescedEvents()
      : []
    // Some browsers return [] instead of [event] when there's no coalescing —
    // fall back to the headline event in that case so we always record at
    // least one point per move.
    const events: PointerEvent[] = samples.length > 0 ? samples : [native]

    if (tool === 'eraser') {
      // Hit-test ALL coalesced sample points so a fast erase swipe doesn't
      // skip strokes between samples.
      for (const ev of events) {
        const { x, y } = normalize(ev.clientX, ev.clientY)
        const hit = hitTestStroke(x, y)
        if (hit) {
          erasedThisDragRef.current.add(hit)
          deleteStroke(surface, hit)
        }
      }
      return
    }

    // Pen mode — push every sample into the live buffer.
    const buf = livePointsRef.current
    for (const ev of events) {
      const { x, y } = normalize(ev.clientX, ev.clientY)
      const pressure = ev.pointerType === 'pen' ? (ev.pressure || 0.5) : 0.5
      buf.push({ x, y, pressure })
    }
    bumpRender()
  }, [isActive, tool, normalize, hitTestStroke, surface, bumpRender])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!isActive) return
    e.stopPropagation()
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    if (tool === 'eraser') {
      drawingRef.current = false
      erasedThisDragRef.current.clear()
      return
    }
    finishStroke()
  }, [isActive, tool, finishStroke])

  // Safety: if the surface deactivates mid-stroke (toolbar closed, etc),
  // commit whatever has been drawn so far rather than dropping it on the floor.
  useEffect(() => {
    if (!isActive && drawingRef.current) {
      finishStroke()
    }
  }, [isActive, finishStroke])

  // Live preview stroke (renders on top of saved strokes while drawing).
  // Read straight from the ref — bumpRender() triggers re-render after
  // every push, so this stays in sync without copying the array.
  const liveBuf = livePointsRef.current
  const liveStroke: Stroke | null = liveBuf.length > 1
    ? { id: '__live__', points: liveBuf, color, size, tool: 'pen' }
    : null

  return (
    <div
      ref={containerRef}
      // Stable ID consumed by DrawToolbar (anchor positioning) and the
      // global click-outside handler. Always present so the toolbar can
      // find the drawable region whether or not draw mode is active.
      data-draw-surface={surfaceId(surface)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: 'absolute',
        inset: 0,
        // While active we want pointer events; otherwise the layer is purely
        // visual and lets clicks pass through to underlying UI.
        pointerEvents: isActive ? 'all' : 'none',
        cursor: isActive
          ? (tool === 'eraser' ? 'cell' : 'crosshair')
          : 'default',
        zIndex,
        borderRadius,
        // Faint outline cue when armed for drawing (so the user sees what
        // surface they're about to mark up).
        boxShadow: isActive
          ? `inset 0 0 0 2px rgba(255,255,255,0.4)`
          : 'none',
        overflow: 'hidden',
      }}
    >
      <StrokeLayer strokes={strokes} width={width} height={height} />
      {liveStroke && (
        <StrokeLayer strokes={[liveStroke]} width={width} height={height} />
      )}
    </div>
  )
}
