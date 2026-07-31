// LinkDragOverlay — renders the dashed line + floating circle that trails
// the cursor while a link-drag is in progress. Also owns the global
// pointermove/pointerup listeners that drive the drag. Mounted once at the
// App root. Motion matches the NLEBlock color drag-out pattern.

import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useLinkDragStore } from '../../store/linkDragStore'
import { useBoardsStore } from '../../store/boardsStore'
import { parseRef, sameRef, type LinkRef } from '../../utils/linkTargets'

export const LinkDragOverlay: React.FC = () => {
  const active = useLinkDragStore(s => s.active)
  const start = useLinkDragStore(s => s.startScreenPos)
  const pos = useLinkDragStore(s => s.currentPos)
  const color = useLinkDragStore(s => s.sourceColor)
  const move = useLinkDragStore(s => s.move)
  const end = useLinkDragStore(s => s.end)

  // Install global listeners while a drag is active
  useEffect(() => {
    if (!active) return

    const onMove = (e: PointerEvent) => move(e.clientX, e.clientY)
    const onUp = (e: PointerEvent) => {
      const source = useLinkDragStore.getState().source
      if (!source) { end(); return }
      // Find drop target: look for [data-link-drop] ancestor at release point
      const els = document.elementsFromPoint(e.clientX, e.clientY)
      let target: LinkRef | null = null
      for (const el of els) {
        const attr = (el as HTMLElement).closest?.('[data-link-drop]')?.getAttribute('data-link-drop')
        if (!attr) continue
        // "group:<id>" / "board:<id>" / "bar:<boardId>:<barId>", plus the
        // legacy "card:"/"chip:" spellings the card layer still emits.
        const hit = parseRef(attr)
        if (!hit) continue
        // THE TOPMOST TARGET WINS, whatever it is. elementsFromPoint returns
        // the whole stack, not just the top hit, so skipping the source and
        // continuing meant the search fell THROUGH the thing you released on
        // and linked whatever happened to lie behind it. Harmless while cards
        // never overlapped; with a pinned card floating over the canvas it
        // fired on every plain click of that card's own "+" chip, and with
        // nested bars almost every release is over a stack. Releasing over
        // the source now cancels, which is what releasing where you started
        // should do anyway.
        if (!sameRef(hit, source)) target = hit
        break
      }
      if (target) {
        // Direction convention: the DROP TARGET owns the reference. Dropping
        // A onto B means "B references A" — B gets a prominent primary chip
        // pointing at A, A gets a small back-ref chip pointing at B.
        useBoardsStore.getState().linkRefs(target, source)
      }
      end()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [active, move, end])

  if (!active || !start || !pos) return null

  return createPortal(
    <div
      style={{
        position: 'fixed', left: 0, top: 0,
        width: '100vw', height: '100vh',
        pointerEvents: 'none',
        zIndex: 99998,
      }}
    >
      {/* Floating circle at cursor */}
      <div style={{
        position: 'absolute',
        left: pos.x - 14,
        top: pos.y - 14,
        width: 28, height: 28,
        borderRadius: '50%',
        background: color,
        border: '2.5px solid rgba(255,255,255,0.8)',
        boxShadow: `0 0 12px ${color}, 0 4px 16px rgba(0,0,0,0.55)`,
        transition: 'none',
      }} />
      {/* Dashed line from source to cursor */}
      <svg style={{
        position: 'absolute', left: 0, top: 0,
        width: '100%', height: '100%',
        overflow: 'visible',
      }}>
        <line
          x1={start.x} y1={start.y}
          x2={pos.x} y2={pos.y}
          stroke={color}
          strokeWidth={2}
          strokeDasharray="6 4"
          opacity={0.55}
        />
      </svg>
    </div>,
    document.body
  )
}
