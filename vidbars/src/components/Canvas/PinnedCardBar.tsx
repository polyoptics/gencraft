// PinnedCardBar — the level selector on a pinned card.
//
// On the canvas, which representation you see is decided by the camera:
// LayerRouter swaps card → block → board as you zoom. A pinned card has
// detached from that camera, so the choice has to become explicit — and
// that is what makes pinning a card well-defined rather than a quirk. The
// bar is not decoration on top of the pin; it is the other half of it.
//
// Screen-space and constant size, because it belongs to the pinned object
// rather than to the world: it should not shrink when the card is pinned
// small, since picking a bigger level is exactly what you would want then.

import React from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import type { ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { PinControl } from '../UI/PinControl'

const LEVELS = [
  { key: 'card',  label: '1', title: 'Card — the whole thing as one face' },
  { key: 'block',  label: '2', title: 'Blocks — the boards inside it' },
  { key: 'board', label: '3', title: 'Board — the bars in full detail' },
] as const

export const PinnedCardBar: React.FC<{ group: ProjectGroup }> = ({ group }) => {
  const setPinnedLayer = useBoardsStore(s => s.setPinnedLayer)
  const current = group.pinnedLayer ?? 'card'
  if (!group.pin) return null

  const btn = (on: boolean): React.CSSProperties => ({
    width: 20, height: 18, lineHeight: '18px', textAlign: 'center',
    background: on ? 'rgba(120,170,255,0.32)' : 'rgba(255,255,255,0.06)',
    border: `1px solid ${on ? 'rgba(150,200,255,0.65)' : 'rgba(255,255,255,0.12)'}`,
    borderRadius: 4, color: on ? '#dbeaff' : 'rgba(255,255,255,0.55)',
    fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
    padding: 0, flexShrink: 0,
  })

  return (
    <div
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: 'absolute',
        // Sits just above the card's anchor, which is the top-left of its
        // header — so the bar reads as part of the card's chrome.
        left: group.pin.x,
        top: group.pin.y - 24,
        display: 'flex', alignItems: 'center', gap: 3,
        pointerEvents: 'auto', zIndex: 5,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {LEVELS.map(l => (
        <button
          key={l.key}
          title={l.title}
          style={btn(current === l.key)}
          onClick={() => {
            useUndoCoordinator.getState().checkpoint()
            setPinnedLayer(group.id, l.key)
          }}
        >{l.label}</button>
      ))}
      <PinControl
        pinned
        size={14}
        onToggle={() => {
          const cs = useCanvasStore.getState()
          useUndoCoordinator.getState().checkpoint()
          useBoardsStore.getState().setGroupPlacement(
            [group.id], 'canvas', { pan: cs.pan, zoom: cs.zoom })
        }}
        onResetHome={() => {
          const cs = useCanvasStore.getState()
          useUndoCoordinator.getState().checkpoint()
          useBoardsStore.getState().rehomePinnedGroup(group.id, { pan: cs.pan, zoom: cs.zoom })
        }}
      />
    </div>
  )
}
