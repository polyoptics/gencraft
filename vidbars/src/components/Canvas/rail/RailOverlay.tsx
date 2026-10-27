// RailOverlay — the loop strip's marks that belong ABOVE its cards.
//
// The rail tile sits below everything docked on it (FreeNode: rail z 2,
// docked cards 10 + order), and a cascade covers every column body edge to
// edge — so anything the rail tile draws there is hidden under the cards.
// Three marks must be seen over them:
//   - where a dragged card would land (the insertion line / bar),
//   - which pictures the run is making right now,
//   - the live preview, as a ghost card at the NEXT place on the results
//     pile — "this is what the run will make".
// They are portalled into the world layer the tiles themselves live in (the
// rail tile's parent: canvas units, tiles at left = x), as a zero-size,
// pointer-transparent host with no z-index of its own, so each mark takes
// its own z among the tiles. The ghost tops an empty tray and tucks under
// a pile (z 9 — over the rail's face, under every result), so the face-up
// result is never covered; the run highlight sits just under a peek-lifted
// card (z 60); the drop mark is over
// everything, the dragged card included — it is always under the pointer,
// so beneath the card it would always be hidden.

import React from 'react'
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
  ghost: { canvas: HTMLCanvasElement; stale: boolean } | null
}> = ({ host, railId, layout: L, slots, drop, busyIds, ghost }) => {
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
    const at = drop.target.insertAt
    const order = new Map(slots.map((s, i) => [s.id, i]))
    const gap = RAIL_GEOM.gap * u
    const after = L.columns.find(c => (order.get(c.slotId) ?? -1) >= at)
    const before = L.columns.filter(c => (order.get(c.slotId) ?? Infinity) < at)
    const last = before[before.length - 1]
    // Halfway across the gap between the slots either side of the insert;
    // the "+" buttons sit one gap outside the first and last slot, so the
    // ends land in those gaps too.
    const x = after ? after.x - gap / 2
      : last ? last.x + last.width + gap / 2
      : L.plusStart.x + L.plusStart.width + gap / 2
    const top = L.tray.head.y - 4 * u
    dropMark = <Bar dir="v" at={x} from={top} to={L.plusStart.y + RAIL_GEOM.cardH * u + 4 * u} u={u} />
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

  // ── Ghost: where the next result lands. On an empty tray it IS the pile.
  // Once results are there it tucks UNDER them: the face-up result must
  // stay fully visible (solitaire), so the ghost shows only as the dashed
  // edge peeking out below the last card, its tag on that edge. ──
  let ghostCard: React.ReactNode = null
  if (ghost && ghost.canvas.width > 0 && ghost.canvas.height > 0) {
    const tray = L.tray
    const tucked = tray.cards.length > 0
    // Tucked, as wide as the card it tucks under (a card keeps its own size).
    const w = tucked ? Math.min(tray.width, tray.cards[tray.cards.length - 1].width) : tray.width
    // dockedHeight's clamp: the result tile will be laid out the same way.
    const aspect = clampAspect(ghost.canvas.height / ghost.canvas.width)
    ghostCard = (
      <div data-rail-ghost={tucked ? 'tucked' : 'top'} style={{
        position: 'absolute', zIndex: tucked ? 9 : 10,
        left: tray.x, top: nextCascadeY(tray.cards, tray.bodyTop), width: w, height: w * aspect,
        border: `${2 * u}px dashed ${C.orangeHi}`, borderRadius: 8 * u, overflow: 'hidden',
        background: 'rgba(22,23,31,0.6)', boxShadow: `0 ${3 * u}px ${12 * u}px rgba(0,0,0,0.45)`,
      }}>
        <CanvasMirror source={ghost.canvas} maxSide={GHOST_SIDE} style={{
          width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none',
          // Full strength: "this is what the run will make" must look like
          // it. Faded over the dark backing it read darker and punchier than
          // the result that then landed. Dimmed only while it re-renders.
          objectFit: 'cover', opacity: ghost.stale ? 0.55 : 1, transition: 'opacity 160ms',
        }} />
        <span style={{
          position: 'absolute', left: 4 * u, ...(tucked ? { bottom: 4 * u } : { top: 4 * u }), padding: `${1.5 * u}px ${5 * u}px`,
          borderRadius: 6 * u, background: C.orange, color: '#fff',
          fontSize: 9 * u, fontWeight: 700, lineHeight: 1.1, letterSpacing: 0.3 * u,
        }}>{ghost.stale ? 'next …' : 'next'}</span>
      </div>
    )
  }

  if (!dropMark && busy.length === 0 && !ghostCard) return null
  return createPortal(
    <div data-rail-overlay={railId} style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none' }}>
      {ghostCard}
      {busy}
      {dropMark}
    </div>,
    host,
  )
}

/** The insertion mark: a bright line with round ends, outlined dark so it
 *  reads over any picture. `dir` h — across a column at y = at; v — down
 *  the slot row at x = at. */
const Bar: React.FC<{ dir: 'h' | 'v'; at: number; from: number; to: number; u: number }> = ({ dir, at, from, to, u }) => {
  const t = 4 * u, dot = 11 * u
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
