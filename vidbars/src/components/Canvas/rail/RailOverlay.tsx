// RailOverlay — the loop strip's marks that belong ABOVE its cards.
//
// The rail tile sits below everything docked on it (FreeNode: rail z 2,
// docked cards 10 + order), and a cascade covers every column body edge to
// edge — so anything the rail tile draws there is hidden under the cards.
// Three marks must be seen over them:
//   - where a dragged card would land (the insertion line / bar),
//   - which pictures the run is making right now,
//   - the live preview — "this is what the run will make" — always at the
//     top of the results, its output decks below it; a Before / After
//     button on it shows the input picture it is made from instead.
// They are portalled into the world layer the tiles themselves live in (the
// rail tile's parent: canvas units, tiles at left = x), as a zero-size,
// pointer-transparent host with no z-index of its own, so each mark takes
// its own z among the tiles. The preview sits over the rail's face, under
// the result decks (cards, drawn above the tiles); the run highlight sits
// just under a peek-lifted
// card (z 60); the drop mark is over
// everything, the dragged card included — it is always under the pointer,
// so beneath the card it would always be hidden.

import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { RAIL_GEOM, clampAspect, type RailDropTarget, type RailLayout, type RailSlot } from '../../../utils/rail'
import { CanvasMirror } from '../../UI/CanvasMirror'
import { RAIL_COLORS as C } from './railStyle'
import { nextCascadeY } from './railView'

/** Peek-lifted docked cards are z 60 (FreeNode); the highlight stays under them. */
const Z_HIGHLIGHT = 59
const Z_DROP = 70
/** The ghost's copy of the preview: a card is ~180 canvas units wide, and
 *  even zoomed well in it stays under this on screen. */
const GHOST_SIDE = 512

export const RailOverlay: React.FC<{
  /** The world layer the rail tile is a child of. */
  host: HTMLElement
  railId: string
  layout: RailLayout
  slots: RailSlot[]
  drop: { target: RailDropTarget; draggedId: string } | null
  /** The pictures the run is making now, subject first. */
  busyIds: string[] | null
  /** The live preview to deal as a ghost, or null (running, or none yet). */
  ghost: { canvas: HTMLCanvasElement; stale: boolean; before: string | null } | null
}> = ({ host, railId, layout: L, slots, drop, busyIds, ghost }) => {
  /** The preview shows the input picture (Before) instead of the result. */
  const [before, setBefore] = useState(false)
  const u = L.unit

  // ── Drop mark ──
  let dropMark: React.ReactNode = null
  if (drop?.target.kind === 'column') {
    const t = drop.target
    const col = L.columns.find(c => c.kind === 'role' && c.slotId === t.slotId)
    if (col) {
      // The column closed up behind a lifted card already; a card dragged
      // before its lift is skipped here the way railDropTarget skips it.
      const others = col.cards.filter(c => c.id !== drop.draggedId)
      const y = t.index < others.length ? others[t.index].y : nextCascadeY(others, col.bodyTop)
      dropMark = <Bar dir="h" at={y} from={col.x - 8 * u} to={col.x + col.width + 8 * u} u={u} />
    }
  } else if (drop?.target.kind === 'row') {
    const t = drop.target
    const at = t.insertAt
    // The row it goes into: the strip's own, or look row `row` (utils/rail
    // RailData.rows), whose columns are its slots in order.
    const look = (t.row ?? 0) > 0 ? L.rows.find(r => r.index === t.row) : undefined
    const gap = RAIL_GEOM.gap * u
    let after: typeof L.columns[number] | undefined, last: typeof L.columns[number] | undefined
    if (look) {
      after = look.columns[at]
      last = look.columns[Math.min(at, look.columns.length) - 1]
    } else {
      const order = new Map(slots.map((s, i) => [s.id, i]))
      after = L.columns.find(c => (order.get(c.slotId) ?? -1) >= at)
      const before = L.columns.filter(c => (order.get(c.slotId) ?? Infinity) < at)
      last = before[before.length - 1]
    }
    // Halfway across the gap between the slots either side of the insert;
    // the "+" buttons (a look row's label) sit one gap outside the first
    // and last slot, so the ends land in those gaps too.
    const start = look ? look.label : L.plusStart
    const x = after ? after.x - gap / 2
      : last ? last.x + last.width + gap / 2
      : start.x + start.width + gap / 2
    const top = look ? look.band.y - 4 * u : L.tray.head.y - 4 * u
    const bodyTop = look ? look.label.y : L.plusStart.y
    dropMark = <Bar dir="v" at={x} from={top} to={bodyTop + RAIL_GEOM.cardH * u + 4 * u} u={u} split={top + (RAIL_GEOM.headH + 8) * u} />
  }

  // ── Run highlight: each busy picture's VISIBLE band (its whole card when
  // it is face-up), so the outline follows the cascade rather than drawing
  // a full card's rectangle across the cards stacked over it. ──
  const busy: React.ReactNode[] = []
  if (busyIds?.length) {
    busyIds.forEach((id, k) => {
      for (const col of L.columns) {
        const i = col.cards.findIndex(c => c.id === id)
        if (i < 0) continue
        const box = col.cards[i]
        const next = col.cards[i + 1]
        const bottom = next ? next.y : box.y + box.height
        const w = (k === 0 ? 3 : 2) * u
        busy.push(
          <div key={id} data-rail-busy={k === 0 ? 'subject' : 'partner'} style={{
            position: 'absolute', zIndex: Z_HIGHLIGHT,
            left: box.x - 2 * u, top: box.y - 2 * u, width: box.width + 4 * u, height: bottom - box.y + 4 * u,
            border: `${w}px solid ${k === 0 ? C.orangeHi : C.orange}`, borderRadius: 8 * u,
            boxShadow: `0 0 0 ${u}px rgba(0,0,0,0.45)`,
          }} />,
        )
        break
      }
    })
  }

  // ── The live preview: always at the top of the results, the run's
  // output decks cascading under it from just over its bottom edge
  // (utils/rail). Before / After flips it to the input picture it is made
  // from and back. ──
  let ghostCard: React.ReactNode = null
  if (ghost && ghost.canvas.width > 0 && ghost.canvas.height > 0) {
    const tray = L.tray
    const w = tray.width
    // The layout's clamp: the tray is laid out at this shape.
    const aspect = clampAspect(ghost.canvas.height / ghost.canvas.width)
    const showBefore = before && !!ghost.before
    ghostCard = (
      <div data-rail-ghost="top" style={{
        position: 'absolute', zIndex: 10,
        left: tray.x, top: tray.bodyTop, width: w, height: w * aspect,
        border: `${2 * u}px dashed ${C.orangeHi}`, borderRadius: 8 * u, overflow: 'hidden',
        background: 'rgba(22,23,31,0.6)', boxShadow: `0 ${3 * u}px ${12 * u}px rgba(0,0,0,0.45)`,
      }}>
        {showBefore
          ? <img src={ghost.before!} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          : <CanvasMirror source={ghost.canvas} maxSide={GHOST_SIDE} style={{
              width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none',
              // Full strength: "this is what the run will make" must look like
              // it. Dimmed only while it re-renders.
              objectFit: 'cover', opacity: ghost.stale ? 0.55 : 1, transition: 'opacity 160ms',
            }} />}
        {ghost.before && (
          <button
            type="button" data-rail-before={showBefore ? 'before' : 'after'}
            title={showBefore ? 'Showing the picture before the effects — click for after' : 'Showing the result — click for the picture before the effects'}
            onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}
            onDoubleClick={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setBefore(b => !b) }}
            style={{
              position: 'absolute', right: 4 * u, top: 4 * u, pointerEvents: 'auto', cursor: 'pointer',
              padding: `${1.5 * u}px ${6 * u}px`, borderRadius: 6 * u, border: `${u}px solid rgba(255,255,255,0.35)`,
              background: showBefore ? 'rgba(255,255,255,0.9)' : 'rgba(12,13,20,0.7)', color: showBefore ? '#111' : '#fff',
              fontSize: 9 * u, fontWeight: 700, lineHeight: 1.1, fontFamily: 'inherit',
            }}
          >{showBefore ? 'Before' : 'After'}</button>
        )}
      </div>
    )
  }

  if (!dropMark && busy.length === 0 && !ghostCard) return null
  // The drop mark in a host of its own: in 3D its parts stand up off the
  // strip (TiltLayer), which makes their host keep 3D, and the preview and
  // the run highlight sharing it then sank under the strip's face.
  const box: React.CSSProperties = { position: 'absolute', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none' }
  return <>
    {(ghostCard || busy.length > 0) && createPortal(<div data-rail-overlay={railId} style={box}>{ghostCard}{busy}</div>, host)}
    {dropMark && createPortal(<div data-rail-overlay={railId} style={box}>{dropMark}</div>, host)}
  </>
}

/** The insertion mark: a bright line with round ends, outlined dark so it
 *  reads over any picture. `dir` h — across a column at y = at; v — down
 *  the slot row at x = at. `split`: a row's mark is made in two parts, over
 *  its header bar (from..split) and down its cards (split..to), one line
 *  flat; the 3D console stands each up with what it lies on (TiltLayer). */
const Bar: React.FC<{ dir: 'h' | 'v'; at: number; from: number; to: number; u: number; split?: number }> = ({ dir, at, from, to, u, split }) => {
  const t = 4 * u, dot = 11 * u
  if (dir === 'v' && split !== undefined && split > from && split < to) {
    const ring = `0 0 0 ${u}px rgba(0,0,0,0.5)`
    // Each part a box down its stretch of the line, its own end's dot in
    // it; square and unringed where the two meet.
    const part = (p0: number, p1: number, which: 'band' | 'row') => (
      <div data-rail-drop-mark-part={which} style={{ position: 'absolute', zIndex: Z_DROP, left: at - dot / 2, top: p0, width: dot, height: p1 - p0 }}>
        <div style={{
          position: 'absolute', left: (dot - t) / 2, top: 0, width: t, height: p1 - p0, background: C.drop, boxShadow: ring,
          borderRadius: which === 'band' ? `${t / 2}px ${t / 2}px 0 0` : `0 0 ${t / 2}px ${t / 2}px`,
          clipPath: which === 'band' ? `inset(${-u}px ${-u}px 0 ${-u}px)` : `inset(0 ${-u}px ${-u}px ${-u}px)`,
        }} />
        <div style={{ position: 'absolute', left: 0, top: (which === 'band' ? 0 : p1 - p0) - dot / 2, width: dot, height: dot, borderRadius: '50%', background: C.drop, boxShadow: ring }} />
      </div>
    )
    return <div data-rail-drop-mark={dir}>{part(from, split, 'band')}{part(split, to, 'row')}</div>
  }
  const line: React.CSSProperties = dir === 'h'
    ? { left: from, top: at - t / 2, width: to - from, height: t }
    : { left: at - t / 2, top: from, width: t, height: to - from }
  const end = (p: number): React.CSSProperties => dir === 'h'
    ? { left: p - dot / 2, top: at - dot / 2 }
    : { left: at - dot / 2, top: p - dot / 2 }
  const ring = `0 0 0 ${u}px rgba(0,0,0,0.5)`
  return (
    <div data-rail-drop-mark={dir}>
      <div style={{ position: 'absolute', zIndex: Z_DROP, ...line, background: C.drop, borderRadius: t / 2, boxShadow: ring }} />
      {[from, to].map(p => (
        <div key={p} style={{ position: 'absolute', zIndex: Z_DROP, ...end(p), width: dot, height: dot, borderRadius: '50%', background: C.drop, boxShadow: ring }} />
      ))}
    </div>
  )
}
