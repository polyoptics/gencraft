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
import { headerExtend } from '../NLE/NLETimelineHeader'

/** Control height — the buttons and the grip are all this tall. */
const BAR_H = 18
/** Inset from the card's edge, matching the header's own text inset. */
const RAIL_INSET_X = 4
/** Corner resize grip — natural size, scaled with the card like the bar. */
const GRIP = 20

const LEVELS = [
  { key: 'card',  label: '1', title: 'Card — the whole thing as one face' },
  { key: 'block',  label: '2', title: 'Blocks — the boards inside it' },
  { key: 'board', label: '3', title: 'Board — the bars in full detail' },
] as const

export const PinnedCardBar: React.FC<{ group: ProjectGroup }> = ({ group }) => {
  const setPinnedLayer = useBoardsStore(s => s.setPinnedLayer)
  const current = group.pinnedLayer ?? 'card'
  const [box, setBox] = React.useState<{ x: number; y: number; w: number; h: number } | null>(null)

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
          // getBoundingClientRect is VIEWPORT space; this bar is positioned
          // absolutely inside the pin host, whose own origin sits below the
          // app's top chrome. Using the viewport number directly offset the
          // bar by exactly the height of that chrome — which is why it kept
          // landing near the card instead of on it.
          const hostBox = (host as HTMLElement).getBoundingClientRect()
          setBox({
            x: Math.round(l - hostBox.left),
            y: Math.round(t - hostBox.top),
            w: Math.round(r2 - l),
            h: Math.round(b2 - t),
          })
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [group.id, current])

  // Nothing measured yet ⇒ nothing to attach to. Waiting a frame is better
  // than appearing somewhere that is not the card.
  if (!group.pin || !box) return null

  // READABLE FIRST, proportional second.
  //
  // Purely fixed broke on a big card (a speck lost in the corner) and purely
  // proportional broke on a small one: two cards pinned at different scales
  // grew visibly different chrome — 10px buttons on one, 18px on the other,
  // side by side. Neither is what a window's title bar does.
  //
  // So: never below natural size, because a control you cannot read is not a
  // control. Grow with the card past that, capped, so it does not get lost on
  // something huge. The ONE case that may shrink it is a card too narrow to
  // hold the bar at all — there, sized to the card beats hanging off its side.
  const NATURAL_W = 104
  const roomy = box.w > 0 ? box.w / NATURAL_W : 1
  const s = Math.min(Math.max(group.pin.scale / 0.18, 1), 3, Math.max(roomy, 0.5))
  // The band the controls sit in, in the bar's own (pre-scale) units. At card
  // level a card's rect INCLUDES the header extension above its body, and
  // that band is the card's chrome strip — the right home for controls that
  // belong to the card. Block and board levels have no such band, so the
  // controls sit against the top edge of what they drew.
  const bandH = current === 'card' ? headerExtend(group.pin.scale) / s : BAR_H

  const btn = (on: boolean): React.CSSProperties => ({
    width: 20, height: 18, lineHeight: '18px', textAlign: 'center',
    background: on ? 'rgba(120,170,255,0.32)' : 'rgba(255,255,255,0.06)',
    border: `1px solid ${on ? 'rgba(150,200,255,0.65)' : 'rgba(255,255,255,0.12)'}`,
    borderRadius: 4, color: on ? '#dbeaff' : 'rgba(255,255,255,0.55)',
    fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
    padding: 0, flexShrink: 0,
  })

  return (
    <>
    {/* RESIZE GRIP at the card's bottom-right corner, hanging half on and
        half off, the way the reference "+" hangs off a card. In the top bar
        it gave no clue what it was scaling ABOUT, which is what made the
        gesture feel unmoored: the scale is anchored at the top-left, so
        pulling from the bottom-right is the drag that matches it — the far
        corner follows your cursor and the near one stays put. */}
    <div
      data-pin-grip={group.id}
      title="Drag to resize this card"
      onPointerDown={e => {
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        const startX = e.clientX, startY = e.clientY
        const g0 = useBoardsStore.getState().groups.find(g => g.id === group.id)
        const startScale = g0?.pin?.scale ?? 1
        const startPin = { x: g0?.pin?.x ?? 0, y: g0?.pin?.y ?? 0 }
        // WHERE THE SCALE IS ANCHORED. rescalePinnedGroup holds the group's
        // ORIGIN still, but the card's visible corner is not its origin — it
        // sits at some offset that scales with it — so the card slid sideways
        // as it grew and the gesture felt unmoored. Capture that offset once,
        // in canvas units, and pull the pin back by it each step so the
        // TOP-LEFT corner is what stays put. Dragging the bottom-right grip
        // then does exactly what it looks like: the far corner follows the
        // cursor, the near one does not move.
        const host = document.querySelector('[data-pin-host]')?.getBoundingClientRect()
        const cardEl = document.querySelector(`[data-pinned-group="${group.id}"] [data-layer-card]`)
        const cr = cardEl?.getBoundingClientRect()
        const anchor = (cr && host)
          ? { x: cr.left - host.left, y: cr.top - host.top }
          : null
        const off = anchor
          ? { x: (anchor.x - startPin.x) / startScale, y: (anchor.y - startPin.y) / startScale }
          : null
        useUndoCoordinator.getState().checkpoint()
        const move = (ev: PointerEvent) => {
          // Out from the corner grows. 260px of travel doubles it.
          // Multiplicative, so the same drag distance feels the same whether
          // the card is tiny or huge, and one number driving both axes keeps
          // the aspect ratio by construction.
          const t = ((ev.clientX - startX) + (ev.clientY - startY)) / 260
          const next = startScale * Math.pow(2, t)
          const bs = useBoardsStore.getState()
          bs.rescalePinnedGroup(group.id, next)
          if (anchor && off) {
            // rescalePinnedGroup clamps, so read back what it actually set
            // rather than assuming `next` took effect.
            const applied = bs.groups.find(g => g.id === group.id)?.pin?.scale ?? next
            const want = { x: anchor.x - off.x * applied, y: anchor.y - off.y * applied }
            const now = useBoardsStore.getState().groups.find(g => g.id === group.id)?.pin
            if (now) useBoardsStore.getState().movePinnedGroups(
              [group.id], want.x - now.x, want.y - now.y)
          }
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
      style={{
        position: 'absolute',
        left: box.x + box.w - (GRIP / 2) * s,
        top: box.y + box.h - (GRIP / 2) * s,
        width: GRIP * s, height: GRIP * s,
        borderRadius: '50%',
        background: 'rgba(30,32,48,0.92)',
        border: `${Math.max(1, s)}px solid rgba(255,255,255,0.35)`,
        color: 'rgba(255,255,255,0.8)',
        fontSize: 11 * s, lineHeight: `${GRIP * s - 2}px`,
        textAlign: 'center', cursor: 'nwse-resize', userSelect: 'none',
        pointerEvents: 'auto', zIndex: 200,
      }}
    >⤢</div>
    <div
      // Ties this bar to the card it controls. There was no link between the
      // two in the DOM, so checking placement meant pairing bars to cards by
      // array index — which is not a link at all, and gave contradictory
      // readings that hid a real bug for a whole round.
      data-pin-bar={group.id}
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: 'absolute',
        // IN the card's header band, at its left edge — the same place the
        // card's own chrome lives, so the controls read as part of the card
        // rather than as something floating near it. Floating above the
        // content is what put the bar in a different apparent position at
        // every level, since each level's content starts at a different
        // offset from the card. No fallback to the pin anchor: the anchor is
        // the group's ORIGIN, which is not where the content starts. If the
        // content cannot be measured the bar waits (see the null return
        // above) rather than appearing somewhere misleading.
        // TOP RIGHT of the header band. The left is where the card writes its
        // own title, so controls put there collide with it — which is what
        // made them look shoved out of place. Window controls sit on the
        // right for the same reason.
        left: box.x + box.w - (NATURAL_W + RAIL_INSET_X) * s,
        top: box.y + Math.max(0, (bandH - BAR_H) / 2) * s,
        // One scale drives the whole bar, so the controls keep their
        // proportions to each other and to the card at any size.
        transform: `scale(${s})`,
        transformOrigin: 'top left',
        display: 'flex', alignItems: 'center', gap: 3,
        pointerEvents: 'auto',
        // Above the card's own chrome, not just above the wrapper. The
        // pinned card is rendered in a wrapper with z-index:auto, which does
        // NOT create a stacking context — so the card body (40), its header
        // (51) and the fan wrapper (55) all compete in the SAME context as
        // this bar. At z-index 5 it was present, correctly positioned, and
        // painted over by the card it belongs to.
        zIndex: 200,
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
    </>
  )
}
