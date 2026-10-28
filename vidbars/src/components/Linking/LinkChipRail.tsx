// LinkChipRail — the reference chips for a block or an element.
//
// Cards got these first (PrimaryChipRail), and they read as part of the card:
// a row of small named tiles along the bottom edge, plus a "+" you drag from
// to make a new one. Blocks and elements now carry the same rail, because a
// reference is the same idea wherever it hangs — this card builds on that
// one, this block is the video I am cutting, this element is the shot that
// pays it off.
//
// WORLD SPACE, counter-scaled. Cards draw their rails in a screen-space
// overlay because cards themselves are drawn there; blocks and bars live
// inside the canvas transform, so this rail renders inside its owner and
// divides every dimension by the camera's zoom. That is the same trick the
// block and bar chrome already uses, and it means the rail needs no geometry
// of its own — it inherits its owner's position by being a child of it.

import React, { useState } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useLinkDragStore } from '../../store/linkDragStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import {
  ownerRefs, resolveRef, refKey, refAttr, REF_GLYPH, type LinkRef,
} from '../../utils/linkTargets'
import { keepDesignZone } from '../../store/zoomZonesStore'

interface Props {
  /** What these chips belong to. Also the drag source for the "+" chip. */
  owner: LinkRef
  /** The owner's own colour, used for the "+" and the drag line. */
  color: string
  /** The camera the owner is drawn with — pass useCardView().zoom, never the
   *  raw canvas zoom, or the rail balloons on a pinned card. */
  zoom: number
  /** Nudge the rail down past chrome that already occupies the bottom edge. */
  offsetY?: number
}

export const LinkChipRail: React.FC<Props> = ({ owner, color, zoom, offsetY = 0 }) => {
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const beginDrag = useLinkDragStore(s => s.begin)
  const moveDrag = useLinkDragStore(s => s.move)

  const entity = owner.kind === 'group'
    ? groups.find(g => g.id === owner.id)
    : owner.kind === 'board'
      ? boards[owner.id]
      : boards[owner.boardId]?.bars[owner.id]
  if (!entity) return null

  const refs = ownerRefs(entity)

  // Counter-scaled: every number below is screen pixels at any zoom. The
  // divisor is floored because the board layer has no zoom ceiling — past
  // 1.5 the chip would keep shrinking in world units until its borders fell
  // below a pixel.
  const px = (n: number) => n / Math.min(zoom, 1.5)

  return (
    <div
      data-link-rail={refKey(owner)}
      style={{
        position: 'absolute',
        // THE CARD'S PLACEMENT, exactly: bottom-left, hanging half on and
        // half off the owner's edge. PrimaryChipRail's RAIL_INSET_X = 14 and
        // RAIL_Y_OFFSET = -CHIP_H/2 are the numbers being copied, in screen
        // px, so a block and a node read the same as a card.
        //
        // The bottom edge already has chrome — resize strips, corner grips, a
        // bar's output port — and the rail must win it rather than move out
        // of the way: sitting below the owner detaches the chips from the
        // thing they belong to, and a "+" you have to hunt for below the box
        // is not the same affordance. Hence the z-index rather than an
        // offset; it clears the bar's hover overlay (15) and the block's edge
        // handles (50).
        left: px(14),
        top: `calc(100% - ${px(9)}px + ${px(offsetY)}px)`,
        display: 'flex',
        alignItems: 'center',
        gap: px(4),
        // Bounded to the owner's width so a rail on a narrow block cannot run
        // out over its neighbours — the chips are drop targets, so overflow
        // would steal drops aimed at the block next door. Horizontal only;
        // it does not affect the vertical straddle above.
        maxWidth: '100%',
        overflow: 'hidden',
        pointerEvents: 'auto',
        zIndex: 60,
      }}
      // pointerdown alone is not enough: dblclick and contextmenu are
      // separate events that would otherwise reach the bar underneath and
      // open its text editor or its menu.
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onContextMenu={e => e.stopPropagation()}
    >
      {refs.map(r => (
        <RefChip key={refKey(r)} owner={owner} target={r} zoom={zoom} />
      ))}
      <AddChip owner={owner} color={color} zoom={zoom}
               onBegin={(x, y) => { beginDrag(owner, color, x, y); moveDrag(x, y) }} />
    </div>
  )
}

/** Exported so the CARD rail can show block and element references with the
 *  same chip the block and element rails use — one chip, three owners. Pass
 *  zoom=1 from a rail that is already inside a scaled wrapper. */
export const RefChip: React.FC<{ owner: LinkRef; target: LinkRef; zoom: number }> = ({ owner, target, zoom }) => {
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const [hovered, setHovered] = useState(false)
  const resolved = resolveRef(target, groups, boards)
  // A referent that no longer exists renders nothing rather than a chip
  // pointing at a hole. The stored ref stays put — deleting the chip on the
  // reader's behalf would throw away a link that a re-import could restore.
  if (!resolved) return null

  const px = (n: number) => n / zoom
  const label = resolved.label.slice(0, 16)

  return (
    <div
      // The OWNER, not the target. A chip is part of its host's furniture, so
      // dropping on it means "link this to the host" — the same thing the
      // card rail's chips have always meant. Stamping the target here made
      // two chips sitting side by side in one row mean opposite things, and
      // made releasing on your own rail link you to your own referent instead
      // of cancelling.
      data-link-drop={refAttr(owner)}
      title={`${resolved.label} — double-click to go there`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onDoubleClick={e => {
        e.stopPropagation()
        goToRef(target)
      }}
      style={{
        height: px(18), display: 'flex', alignItems: 'center', gap: px(4),
        padding: `0 ${px(7)}px 0 ${px(4)}px`,
        borderRadius: px(9),
        background: `${resolved.color}d0`,
        border: `${px(1.5)}px solid rgba(0,0,0,0.25)`,
        boxShadow: `0 ${px(1)}px ${px(4)}px rgba(0,0,0,0.4)`,
        color: '#fff', fontSize: px(10), fontWeight: 600,
        whiteSpace: 'nowrap', userSelect: 'none', cursor: 'pointer',
      }}
    >
      <span style={{ opacity: 0.85, fontSize: px(9) }}>{REF_GLYPH[resolved.kind]}</span>
      <span style={{ textShadow: `0 ${px(1)}px ${px(2)}px rgba(0,0,0,0.55)` }}>{label}</span>
      {hovered && (
        <div
          onClick={e => {
            e.stopPropagation()
            useUndoCoordinator.getState().checkpoint()
            useBoardsStore.getState().unlinkRefs(owner, target)
          }}
          title="Unlink"
          style={{
            width: px(13), height: px(13), borderRadius: '50%',
            background: 'rgba(0,0,0,0.6)',
            border: `${px(1)}px solid rgba(255,255,255,0.35)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginLeft: px(1), fontSize: px(9), lineHeight: 1,
            color: 'rgba(255,255,255,0.95)',
          }}
        >×</div>
      )}
    </div>
  )
}

const AddChip: React.FC<{
  owner: LinkRef; color: string; zoom: number
  onBegin: (x: number, y: number) => void
}> = ({ owner, color, zoom, onBegin }) => {
  const px = (n: number) => n / zoom
  return (
    <div
      data-link-drop={refAttr(owner)}
      title="Drag onto a card, block or element to link it here"
      onPointerDown={e => {
        if (e.button !== 0) return
        e.stopPropagation()
        // No checkpoint here — most drags are abandoned, and one undo entry
        // per abandoned gesture buries the edit you actually want back. The
        // checkpoint fires in LinkDragOverlay, once, only when a link is
        // really made.
        onBegin(e.clientX, e.clientY)
      }}
      style={{
        // Without this the browser claims the gesture for panning on touch
        // and pen, no pointerup ever arrives, and the drag overlay hangs.
        touchAction: 'none',
        width: px(18), height: px(18), borderRadius: '50%',
        background: `${color}66`,
        border: `${px(1.5)}px dashed rgba(255,255,255,0.5)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'rgba(255,255,255,0.85)', fontSize: px(12), lineHeight: 1,
        cursor: 'crosshair', userSelect: 'none', flexShrink: 0,
      }}
    >+</div>
  )
}

/** Navigate to whatever a chip points at, at the zoom that shows it. Jumping
 *  to a bar from card zoom and landing on a card you cannot read the bar in
 *  would be a non-answer, so each kind sets the zoom its own layer lives at. */
function goToRef(r: LinkRef) {
  const cs = useCanvasStore.getState()
  const bs = useBoardsStore.getState()
  if (r.kind === 'group') { cs.jumpToGroup(r.id); return }
  const boardId = r.kind === 'board' ? r.id : r.boardId
  const owner = bs.groups.find(g => g.boardIds.includes(boardId))
  if (!owner) return
  // Inside the level's zone wherever the zoom bar has put it.
  cs.setZoom(r.kind === 'board' ? keepDesignZone(0.25) : keepDesignZone(0.6))
  cs.jumpToGroup(owner.id)
}
