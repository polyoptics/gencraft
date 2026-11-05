// BackRefChipRail — smaller, muted chips at the top-right of a card, showing
// which OTHER groups link TO this one (inbound references). These are derived
// from the store via `getBackRefs` — the storage itself is one-way.
//
// Clicking a back-ref chip pans the viewport to the referencing card (no
// ghost expansion — these are just breadcrumbs saying "I'm used here").
//
// Like PrimaryChipRail, the content is wrapped in a transform-scale container
// so the chips scale with the card.

import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { getBackRefs } from '../../utils/linkRefs'
import { cardTitle } from '../../utils/faceStyle'
import type { ProjectGroup } from '../../store/boardsStore'

interface Props {
  groupId: string
  hostRect: { left: number; top: number; width: number; height: number }
  scale: number
  /** Screen-px gap from the card's top edge (in screen px, pre-scale). */
  topOffsetScreenPx?: number
}

const CHIP_H = 16      // natural size — smaller than primary (24)
const CHIP_GAP = 4
const RAIL_RIGHT_INSET = 10
const MAX_CHIPS_VISIBLE = 5

export const BackRefChipRail: React.FC<Props> = ({ groupId, hostRect, scale, topOffsetScreenPx = 4 }) => {
  // Use shallow compare so we don't return a new array every time.
  // We still compute backrefs in the selector, but its result is an array of
  // group ids which will be stable when nothing actually changed.
  const refGroups = useBoardsStore(
    useShallow(s => {
      const ids = getBackRefs(groupId, s.groups)
      if (ids.length === 0) return [] as ProjectGroup[]
      return ids.map(id => s.groups.find(g => g.id === id)).filter(Boolean) as ProjectGroup[]
    })
  )

  const jumpToGroup = useCanvasStore(s => s.jumpToGroup)

  if (refGroups.length === 0) return null

  const visible = refGroups.slice(0, MAX_CHIPS_VISIBLE)
  const overflow = refGroups.length - visible.length

  // Anchor top-right of card. transformOrigin top-right so chips grow leftward.
  const right = window.innerWidth - (hostRect.left + hostRect.width) + RAIL_RIGHT_INSET * scale
  const top = hostRect.top + topOffsetScreenPx * scale

  return (
    <div
      style={{
        position: 'absolute',
        right, top,
        zIndex: 42,
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'top right',
          display: 'flex',
          gap: CHIP_GAP,
          alignItems: 'center',
          flexDirection: 'row-reverse',
        }}
      >
        {overflow > 0 && (
          <div style={{
            height: CHIP_H,
            padding: '0 6px',
            borderRadius: CHIP_H / 2,
            background: 'rgba(255,255,255,0.1)',
            color: 'rgba(255,255,255,0.75)',
            fontSize: 9,
            fontWeight: 700,
            display: 'flex', alignItems: 'center',
            border: '1px solid rgba(255,255,255,0.18)',
          }}>+{overflow}</div>
        )}
        {visible.map(g => (
          <BackRefChip key={g.id} ref_={g} onJump={() => jumpToGroup(g.id)} />
        ))}
      </div>
    </div>
  )
}

const BackRefChip: React.FC<{ ref_: ProjectGroup; onJump: () => void }> = ({ ref_, onJump }) => {
  const color = ref_.color || '#5b8dd9'
  const label = (useBoardsStore(s => cardTitle(s.groups, ref_)) || 'card').slice(0, 10)
  return (
    <div
      onClick={e => { e.stopPropagation(); onJump() }}
      title={`Referenced from: ${ref_.name}. Click to jump.`}
      style={{
        height: CHIP_H,
        padding: '0 6px 0 3px',
        borderRadius: CHIP_H / 2,
        background: 'rgba(255,255,255,0.06)',
        border: `1px solid ${color}55`,
        color: 'rgba(255,255,255,0.72)',
        fontSize: 9,
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <div style={{
        width: 9, height: 9, borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }} />
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  )
}
