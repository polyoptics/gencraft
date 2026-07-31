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

  // Counter-scaled: every number below is screen pixels at any zoom.
  const px = (n: number) => n / zoom
  const H = px(18)

  return (
    <div
      data-link-rail={refKey(owner)}
      // Half-in, half-out of the owner's bottom edge, matching the card rail's
      // look. pointerEvents re-enabled here because some owners render their
      // chrome pass-through.
      style={{
        position: 'absolute',
        left: px(6),
        top: `calc(100% - ${H / 2}px + ${px(offsetY)}px)`,
        display: 'flex',
        alignItems: 'center',
        gap: px(4),
        pointerEvents: 'auto',
        zIndex: 6,
      }}
      onPointerDown={e => e.stopPropagation()}
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
      data-link-drop={refAttr(target)}
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
        useUndoCoordinator.getState().checkpoint()
        onBegin(e.clientX, e.clientY)
      }}
      style={{
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
  cs.setZoom(r.kind === 'board' ? 0.25 : 0.6)
  cs.jumpToGroup(owner.id)
}
