// RailResizeGrip — the loop strip's corner grip. A rail is not resized like
// a panel (a box whose contents reflow): it is SCALED, like a playing card
// held closer. The grip changes the rail's `unit`, the one number every rail
// size is measured in, so the arrow, the headers, every slot and every card
// docked on it grow and shrink together, the top-left corner staying put.
// The rail sync host re-lays the cards out on the change, as on any other.

import React, { useRef } from 'react'
import { useFreeNodeStore } from '../../../store/freeNodeStore'
import { useCanvasStore } from '../../../store/canvasStore'
import { checkpoint, stop } from './railStyle'

/** How far a rail can be scaled, as a unit. A rail made at zoom 1 is unit 1. */
const MIN_UNIT = 0.3
const MAX_UNIT = 12
/** How far the results tray can be scaled against the rest of the strip. */
const MIN_TRAY = 0.5
const MAX_TRAY = 6

export const RailResizeGrip: React.FC<{
  railId: string
  /** The rail's whole box, canvas units — what the drag is measured against. */
  width: number
  height: number
  u: number
  hovered: boolean
  /** 'tray': the grip on the results tray, scaling only the tray
   *  (RailData.trayScale), placed just outside `at` — the tray's corner,
   *  canvas units, rail-local — clear of the result card's own grip. */
  scales?: 'rail' | 'tray'
  at?: { left: number; top: number }
}> = ({ railId, width, height, u, hovered, scales = 'rail', at }) => {
  const drag = useRef<{ x: number; y: number; unit: number; w: number; h: number; zoom: number; moved: boolean } | null>(null)

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    // The grip owns the press: no rail move, no marquee, no pan.
    e.stopPropagation()
    e.preventDefault()
    const r = useFreeNodeStore.getState().nodes[railId]?.rail
    const unit = (scales === 'tray' ? r?.trayScale : r?.unit) ?? 1
    drag.current = {
      x: e.clientX, y: e.clientY, unit, w: width, h: height,
      // A rail is never pinned, so the canvas camera is its camera.
      zoom: useCanvasStore.getState().zoom, moved: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x) / d.zoom, dy = (e.clientY - d.y) / d.zoom
    if (!d.moved) {
      if (Math.hypot(dx, dy) * d.zoom < 3) return
      // One undo step for the whole gesture, taken once it is one.
      checkpoint()
      d.moved = true
    }
    // The pointer's travel along the box's diagonal: dragging the corner
    // straight out or in scales by exactly how far it went, and a sideways
    // wobble does not flicker the size.
    const ratio = 1 + (dx * d.w + dy * d.h) / (d.w * d.w + d.h * d.h)
    const fs = useFreeNodeStore.getState()
    const rail = fs.nodes[railId]?.rail
    if (!rail) return
    if (scales === 'tray') {
      const s = Math.min(MAX_TRAY, Math.max(MIN_TRAY, d.unit * ratio))
      if (Math.abs((rail.trayScale ?? 1) - s) > 1e-4) fs.updateFreeNode(railId, { rail: { ...rail, trayScale: s } })
      return
    }
    const unit = Math.min(MAX_UNIT, Math.max(MIN_UNIT, d.unit * ratio))
    if (Math.abs(rail.unit - unit) > 1e-4) fs.updateFreeNode(railId, { rail: { ...rail, unit } })
  }

  const onUp = (e: React.PointerEvent) => {
    if (!drag.current) return
    drag.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  }

  const zone = 26 * u, dot = 3 * u, gap = 3 * u
  return (
    <div
      data-rail-resize={scales}
      title={scales === 'tray' ? 'Drag to scale the results' : 'Drag to scale the strip and everything on it'}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onLostPointerCapture={() => { drag.current = null }}
      onDoubleClick={stop}
      style={{
        position: 'absolute', ...(at ? { left: at.left - zone * 0.3, top: at.top - zone * 0.3 } : { right: 0, bottom: 0 }), width: zone, height: zone, zIndex: at ? 60 : undefined,
        cursor: 'nwse-resize', touchAction: 'none',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
        padding: `0 ${5 * u}px ${5 * u}px 0`, boxSizing: 'border-box',
      }}
    >
      {/* FreeNode's grip: the lower-right triangle of a 3×3 of dots. */}
      <div style={{
        display: 'grid', gridTemplateColumns: `repeat(3, ${dot}px)`, gridTemplateRows: `repeat(3, ${dot}px)`,
        gap, opacity: hovered ? 0.55 : 0.18, transition: 'opacity 0.12s',
      }}>
        {[...Array(9)].map((_, i) => (
          <div key={i} style={{
            width: dot, height: dot, borderRadius: '50%', background: 'rgba(255,255,255,0.9)',
            opacity: i % 3 + Math.floor(i / 3) >= 2 ? 1 : 0,
          }} />
        ))}
      </div>
    </div>
  )
}
