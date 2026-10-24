// DragOutGrip — drag the file behind a piece of media OUT of VidBars, into a
// website's upload box (Midjourney, ChatGPT…) or another program. Desktop
// app only.
//
// A normal drag on a tile moves it on the canvas, so leaving the app needs
// its own handle. Dragging this one hands Windows the real file: the page
// it lands on sees exactly what a drag out of Explorer gives it.
//
// Renders only when there is a file to give — the bridge is here and new
// enough (feature-detected: a hot reload can pair this with an older
// preload), and the url resolves to a file that exists — so hosts can
// mount it unconditionally.

import React from 'react'
import { useResolvedFile } from '../../hooks/useFileMenu'

const stop = (e: React.SyntheticEvent) => { e.stopPropagation() }
/** Only the primary button belongs to the grip: a middle-drag over it must
 *  still reach the canvas and pan. */
const stopPrimary = (e: React.PointerEvent | React.MouseEvent) => { if (e.button === 0) e.stopPropagation() }

export const DragOutGrip: React.FC<{
  /** The STORED url of this media — the file itself, never its poster. */
  url: string | null | undefined
  /** Every stored url to drag, read at dragstart (e.g. all selected tiles).
   *  `url` is always sent first, whatever this returns. */
  getUrls?: () => string[]
  /** Glyph size in px — the host scales it like its other chrome. */
  size: number
  /** Hover reveal. Hidden, it also stops taking the pointer. */
  visible?: boolean
  style?: React.CSSProperties
}> = ({ url, getUrls, size, visible = true, style }) => {
  const d = window.vidbarsDesktop
  const canDrag = !!d && typeof d.startMediaDrag === 'function'
  const { resolved } = useResolvedFile(canDrag ? url : null)
  if (!canDrag || !url || !resolved?.exists) return null

  return (
    <span
      draggable
      data-drag-out
      title="Drag out — drop into a website's upload box or another app"
      // The grip is not part of the tile: a press here must never start a
      // tile move, a selection, or a canvas pan.
      onPointerDown={stopPrimary}
      onMouseDown={stopPrimary}
      onClick={stop}
      onDoubleClick={stop}
      onPointerEnter={() => { if (typeof d.prepareDragIcon === 'function') void d.prepareDragIcon(url) }}
      onDragStart={e => {
        // Cancel the HTML drag and hand the gesture to the OS instead.
        e.preventDefault()
        e.stopPropagation()
        // The grabbed file always leads: it names the drag image (warmed on
        // hover for exactly this url) and is never the one cut by the cap.
        d.startMediaDrag!([url, ...(getUrls?.() ?? []).filter(u => u !== url)])
      }}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, width: size, height: size,
        cursor: 'grab', borderRadius: size * 0.2,
        color: 'rgba(255,255,255,0.75)',
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 120ms ease',
        ...style,
      }}
    >
      {/* Arrow leaving a tray: "take this out". */}
      <svg width={size * 0.8} height={size * 0.8} viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }}>
        <path d="M12 15V3" />
        <path d="M7 8l5-5 5 5" />
        <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
      </svg>
    </span>
  )
}
