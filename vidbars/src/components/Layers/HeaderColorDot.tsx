// A card's colour, as a small circle on its header (Brian 2026-11-16: "have
// it have its own little circle that shows its color there, and then I can
// drag its color around too"). It shows the colour and how see-through it
// is. A click opens the colour and transparency; dragged off and let go on
// another card, that card takes the colour (on a section of a scene card,
// that section does).

import React, { useState } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { cardFill } from '../../utils/colorUtils'
import { patchDiv } from '../../utils/sceneCard'

const CHECKER = 'repeating-conic-gradient(#666 0% 25%, #333 0% 50%) 0 0 / 6px 6px'

/** The cards a colour change on this card is made on: every selected card
 *  when it is one of several selected. */
export function colorTargets(groupId: string): string[] {
  const sel = useBoardsStore.getState().selectedGroupIds
  return sel.length > 1 && sel.includes(groupId) ? sel : [groupId]
}

/** The colour let go at a point of the screen: onto what is there. */
function giveColor(from: string, x: number, y: number): void {
  const bs = useBoardsStore.getState()
  const me = bs.groups.find(g => g.id === from)
  if (!me) return
  for (const el of document.elementsFromPoint(x, y)) {
    const h = el as HTMLElement
    if (h.closest?.('[data-color-ghost]')) continue
    // A section of a scene card: the section.
    const div = h.closest?.('[data-scene-div]') as HTMLElement | null
    const face = div?.closest('[data-scene-face]') as HTMLElement | null
    if (div && face) {
      const sc = bs.groups.find(g => g.id === face.dataset.sceneFace)
      if (!sc?.scene || !div.dataset.sceneDiv) return
      useUndoCoordinator.getState().checkpoint()
      bs.setGroupScene(sc.id, patchDiv(sc.scene, div.dataset.sceneDiv, { color: me.color }))
      return
    }
    // A card, or its header: the card (every selected one, when it is one of them).
    const id = (h.closest?.('[data-layer-card]') as HTMLElement | null)?.dataset.layerCard
      ?? (h.closest?.('[data-card-header]') as HTMLElement | null)?.dataset.cardHeader
    if (!id) continue
    if (id === from || !bs.groups.some(g => g.id === id)) return
    useUndoCoordinator.getState().checkpoint()
    for (const t of colorTargets(id)) {
      bs.setGroupColor(t, me.color)
      bs.setGroupOwnColor(t, true)
      if (me.colorOpacity !== undefined) bs.setGroupColorOpacity(t, me.colorOpacity)
    }
    return
  }
}

export const HeaderColorDot: React.FC<{
  groupId: string
  size: number
  /** It was clicked: where its panel opens (screen px). */
  onOpen: (x: number, y: number) => void
  lit?: boolean
}> = ({ groupId, size, onOpen, lit }) => {
  const color = useBoardsStore(s => s.groups.find(g => g.id === groupId)?.color ?? '#5b8dd9')
  const opacity = useBoardsStore(s => s.groups.find(g => g.id === groupId)?.colorOpacity)
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null)
  const fill = `linear-gradient(${cardFill(color, opacity)}, ${cardFill(color, opacity)}), ${CHECKER}`

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    const x0 = e.clientX, y0 = e.clientY
    let moved = false
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
      moved = true
      setGhost({ x: ev.clientX, y: ev.clientY })
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setGhost(null)
      if (moved) { giveColor(groupId, ev.clientX, ev.clientY); return }
      // Beside the card, so the card stays in view while its colour changes
      // (under the circle when there is no room either side).
      const r = el.getBoundingClientRect()
      const h = (el.closest('[data-card-header]') as HTMLElement | null)?.getBoundingClientRect()
      if (h && h.left - 226 >= 4) onOpen(h.left - 226, h.top)
      else if (h && h.right + 6 + 225 <= window.innerWidth) onOpen(h.right + 6, h.top)
      else onOpen(r.left, r.bottom + 6)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <>
      <div
        data-header-color={groupId}
        title="Card color and transparency. Drag it onto another card to give it this color"
        onPointerDown={onDown}
        onDoubleClick={e => e.stopPropagation()}
        style={{
          flex: '0 0 auto', width: size, height: size, borderRadius: '50%', boxSizing: 'border-box', cursor: 'pointer',
          background: fill, border: `${Math.max(0.75, size * 0.09)}px solid rgba(255,255,255,${lit ? 1 : 0.8})`,
          boxShadow: lit ? '0 0 0 1px rgba(255,214,102,0.95)' : '0 1px 2px rgba(0,0,0,0.5)',
        }}
      />
      {ghost && ReactDOM.createPortal(
        <div data-color-ghost style={{
          position: 'fixed', left: ghost.x - 9, top: ghost.y - 9, width: 18, height: 18, borderRadius: '50%', boxSizing: 'border-box',
          background: fill, border: '1.5px solid #fff', boxShadow: '0 2px 7px rgba(0,0,0,0.6)', pointerEvents: 'none', zIndex: 10001,
        }} />,
        document.body,
      )}
    </>
  )
}
