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
  const [box, setBox] = React.useState<{ x: number; y: number } | null>(null)
  /** Which `${group}:${level}` has already been fitted — see the fit below. */
  const fittedRef = React.useRef<string | null>(null)

  // MEASURED, not derived. The pin anchor is where the group's ORIGIN lands,
  // and the visible content does not start there: a card is inset from its
  // origin, a deck's anchor sits differently again, and block and board
  // levels have their own extents entirely. Deriving the bar's position from
  // the anchor put it off to one side, differently per level — so it reads
  // the rendered content instead, which is right for every level by
  // construction.
  React.useLayoutEffect(() => {
    let raf = 0
    const tick = () => {
      const host = document.querySelector('[data-pin-host]')
      const own = host?.querySelector(`[data-pinned-group="${group.id}"]`) as HTMLElement | null
      if (own) {
        // Union of what this pinned group actually painted.
        let l = Infinity, t = Infinity, r2 = -Infinity, b2 = -Infinity
        for (const el of own.querySelectorAll<HTMLElement>(
          '[data-layer-card],[data-layer-block],[data-block][data-id],[data-nle-card]')) {
          const r = el.getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) continue
          l = Math.min(l, r.left); t = Math.min(t, r.top)
          r2 = Math.max(r2, r.right); b2 = Math.max(b2, r.bottom)
        }
        if (Number.isFinite(l)) {
          setBox({ x: Math.round(l), y: Math.round(t) })

          // FIT TO SCREEN, once per level change. A level's default scale is
          // what that view is normally READ at, which is the right starting
          // point for one card and hopeless for a deck of them — the Palesia
          // deck at board level is many screens wide. Rather than guess a
          // scale per deck, measure what it actually painted and shrink until
          // it fits. Once per level, guarded, so this cannot oscillate: the
          // measurement feeds a scale that changes the measurement.
          const key = `${group.id}:${current}`
          if (fittedRef.current !== key) {
            const w = r2 - l, h = b2 - t
            const availW = window.innerWidth * 0.86
            const availH = window.innerHeight * 0.86
            if (w > 4 && h > 4) {
              fittedRef.current = key
              const f = Math.min(availW / w, availH / h, 1)
              // Only shrink, and only when it is worth doing — a 2% trim is
              // not worth moving the user's card for.
              if (f < 0.97) {
                const g = useBoardsStore.getState().groups.find(x => x.id === group.id)
                if (g?.pin) {
                  useBoardsStore.getState().rescalePinnedGroup(group.id, g.pin.scale * f)
                }
              }
            }
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [group.id, current])

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
        // Just above whatever this level actually drew.
        left: box?.x ?? group.pin.x,
        top: (box?.y ?? group.pin.y) - 24,
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
