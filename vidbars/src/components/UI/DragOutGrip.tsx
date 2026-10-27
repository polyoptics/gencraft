// DragOutGrip — drag the file behind a piece of media OUT of VidBars, into a
// website's upload box (Midjourney, ChatGPT…) or another program. Desktop
// app only.
//
// A normal drag on a tile moves it on the canvas, so leaving the app needs
// its own handle. Dragging this one hands Windows the real file: the page
// it lands on sees exactly what a drag out of Explorer gives it.
//
// Renders only when there may be a file to give — the bridge is here and
// new enough (feature-detected: a hot reload can pair this with an older
// preload), and the url could name a file on disk — and drops out once it
// is known not to exist, so hosts can mount it unconditionally. Whether it
// exists is asked only once the grip is first shown (see below).

import React, { useState } from 'react'
import { mayHaveDiskFile, useResolvedFile } from '../../hooks/useFileMenu'
import { noteDragOutShape, type DragOutShape } from '../../utils/dragOutSource'

const stop = (e: React.SyntheticEvent) => { e.stopPropagation() }
/** Only the primary button belongs to the grip: a middle-drag over it must
 *  still reach the canvas and pan. */
const stopPrimary = (e: React.PointerEvent | React.MouseEvent) => { if (e.button === 0) e.stopPropagation() }
/** What ends a press on the grip — dragend, too, for the drag it started. */
const PRESS_ENDS = ['pointerup', 'pointercancel', 'dragend'] as const

export const DragOutGrip: React.FC<{
  /** The STORED url of this media — the file itself, never its poster. */
  url: string | null | undefined
  /** The stored urls to drag, read at dragstart. `all` is true when Shift
   *  is held as the drag starts: the host returns EVERY image inside it (a
   *  card's references, a deck's cards…) instead of what it shows.
   *  Otherwise `url` always leads, whatever this returns (e.g. the other
   *  selected tiles). */
  getUrls?: (o: { all: boolean }) => string[]
  /** What Shift adds, for the tooltip — e.g. "every image in this card".
   *  Omit for hosts that have nothing more to give. */
  allLabel?: string
  /** Glyph size in px — the host scales it like its other chrome. */
  size: number
  /** Hover reveal. Hidden, it also stops taking the pointer. */
  visible?: boolean
  /** The tile's size and crop, read at dragstart: dropped back on the
   *  canvas, the duplicate takes it (utils/dragOutSource). Omit to have
   *  it land like an imported file. */
  shape?: () => DragOutShape | null
  style?: React.CSSProperties
}> = ({ url, getUrls, allLabel, size, visible = true, shape, style }) => {
  const d = window.vidbarsDesktop
  const canDrag = !!d && typeof d.startMediaDrag === 'function'
  // Ask main about the file only once the grip is wanted. Hosts mount one
  // on every card, block and bar, and LayerRouter remounts a whole layer at
  // each zoom threshold — asking at mount was hundreds of synchronous
  // realpath calls on main's thread per threshold. Once asked, keep asking
  // for that url: letting go of the hover must not pull the grip back out
  // of a host's flex row.
  const [askedFor, setAskedFor] = useState<string | null>(null)
  // A press keeps the grip live until it ends, whatever the host's hover
  // says. The pointer can leave the host before the drag begins — a deck's
  // header is not part of the deck, so a drag heading up from the grip
  // crosses out of it — and hiding the grip also took it out of hit-
  // testing. The browser looks for the draggable under the PRESS point only
  // once the pointer has moved past its threshold, so it found nothing.
  const [pressed, setPressed] = useState(false)
  const live = visible || pressed
  if (canDrag && visible && url && askedFor !== url) setAskedFor(url)
  const asked = canDrag && !!url && (visible || askedFor === url)
  const { resolved, done } = useResolvedFile(asked ? url : null)
  if (!canDrag || !url || !mayHaveDiskFile(url)) return null
  if (asked && done && !resolved?.exists) return null
  // Not asked yet, or the answer is on its way: keep the place, hidden.
  // It takes the pointer as soon as it is revealed — main resolves the urls
  // itself at drag time, so a press need not wait for the answer.
  const shown = live && !!resolved?.exists

  return (
    <span
      draggable
      data-drag-out
      title={"Drag out — drop into a website's upload box or another app"
        + (allLabel ? `\nHold Shift as you start dragging to take ${allLabel}` : '')}
      // The grip is not part of the tile: a press here must never start a
      // tile move, a selection, or a canvas pan.
      onPointerDown={e => {
        stopPrimary(e)
        if (e.button !== 0) return
        setPressed(true)
        const end = () => {
          setPressed(false)
          for (const t of PRESS_ENDS) window.removeEventListener(t, end, true)
        }
        for (const t of PRESS_ENDS) window.addEventListener(t, end, true)
      }}
      onMouseDown={stopPrimary}
      onClick={stop}
      onDoubleClick={stop}
      onPointerEnter={() => { if (typeof d.prepareDragIcon === 'function') void d.prepareDragIcon(url) }}
      onDragStart={e => {
        // Cancel the HTML drag and hand the gesture to the OS instead.
        e.preventDefault()
        e.stopPropagation()
        // Shift: everything inside, as the host lists it. Not Alt: on
        // Windows, Alt held over a drop asks for a SHORTCUT, so a user who
        // kept it down would get .lnk files instead of the images.
        // Otherwise the grabbed file leads — it names the drag image
        // (warmed on hover for exactly this url) and is never the one cut
        // by the cap.
        const all = e.shiftKey && !!getUrls
        const inside = all ? getUrls!({ all: true }) : []
        // One file of this tile: its shape goes with it. Several (Shift)
        // land as plain imports — whose shape would they take?
        noteDragOutShape(inside.length ? null : shape?.() ?? null)
        d.startMediaDrag!(inside.length
          ? inside
          : [url, ...(getUrls?.({ all: false }) ?? []).filter(u => u !== url)])
      }}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, width: size, height: size,
        cursor: 'grab', borderRadius: size * 0.2,
        color: 'rgba(255,255,255,0.75)',
        opacity: shown ? 1 : 0,
        pointerEvents: live ? 'auto' : 'none',
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
