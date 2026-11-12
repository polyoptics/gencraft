// Card on card (Brian 2026-11-12): a card whose link was dropped on this
// one shows TUCKED under this card's bottom edge, its foot sticking out
// with its picture and name (several: each a step further out), the way a trait card is tucked under the card
// it describes. So a card that is an effect on others (his mutation card)
// reads on every card that has it. Nothing is stored: these are the card's
// back-refs (utils/linkRefs), the same ones the header's USED IN dot lists.
//
// Factions, families and notes are left out: their links are memberships,
// which the member's back already shows (FACTION, RANK...).
//
// Drawn inside the chip rail's wrapper (PrimaryChipRail), so in 3D it rides
// with its card exactly as the chips do.

import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { getBackRefs } from '../../utils/linkRefs'
import { cardTitle } from '../../utils/faceStyle'
import { cardTypeOf, typeColor } from '../../utils/cardTypes'
import { useResolvedMedia } from '../../utils/useResolvedMedia'

const INSET = 8        // natural sizes: the wrapper scales them with the card
const STEP_IN = 5      // each further card is this much narrower a side
const SEAM = 13        // under the chips, which ride the card's bottom edge
const FOOT = 21        // what each card shows of itself
const MAX_SHOWN = 3

const MEMBERSHIP = new Set(['faction', 'family', 'note'])

export const TuckedCards: React.FC<{
  groupId: string
  /** The card's bottom-left corner, from the rail's own corner. */
  left: number
  top: number
  scale: number
  /** The card's width, in the feet's natural units. */
  width: number
}> = ({ groupId, left, top, scale, width }) => {
  const ids = useBoardsStore(useShallow(s => getBackRefs(groupId, s.groups)
    .filter(id => { const g = s.groups.find(x => x.id === id); return !!g && !MEMBERSHIP.has(cardTypeOf(g)) })))
  const rest = useBoardsStore(s => ids.slice(MAX_SHOWN).map(id => { const g = s.groups.find(x => x.id === id); return g ? cardTitle(s.groups, g) || g.name || 'card' : '' }).join(', '))
  if (!ids.length) return null
  const shown = ids.slice(0, MAX_SHOWN)
  return (
    <div data-tucked-cards={groupId} style={{ position: 'absolute', left, top, width: 0, height: 0 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        {shown.map((id, i) => (
          <Tucked key={id} id={id} step={i} width={width}
            more={i === shown.length - 1 && ids.length > MAX_SHOWN ? { n: ids.length - MAX_SHOWN, names: rest } : undefined} />
        ))}
      </div>
    </div>
  )
}

/** One tucked card: only its foot shows, below the card it is under (and
 *  below the ones tucked nearer). Flat on top, shaded where it goes under. */
const Tucked: React.FC<{ id: string; step: number; width: number; more?: { n: number; names: string } }> = ({ id, step, width, more }) => {
  const g = useBoardsStore(s => s.groups.find(x => x.id === id))
  const title = useBoardsStore(s => { const c = s.groups.find(x => x.id === id); return c ? cardTitle(s.groups, c) || c.name || 'card' : '' })
  const typeColors = useBoardsStore(s => s.typeColors)
  const img = useResolvedMedia(g?.cardHeroImage ?? null)
  if (!g) return null
  const color = g.color || typeColor(cardTypeOf(g), typeColors)
  const inset = INSET + STEP_IN * step
  return (
    <div
      data-tucked-card={id}
      title={`${title} is on this card. Double-click to go to it.`}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => { e.stopPropagation(); useCanvasStore.getState().jumpToGroup(id) }}
      style={{
        position: 'absolute', left: inset, top: 0, width: Math.max(30, width - 2 * inset), height: SEAM + FOOT * (step + 1),
        zIndex: MAX_SHOWN - step, boxSizing: 'border-box',
        display: 'flex', alignItems: 'flex-end',
        borderRadius: '0 0 9px 9px',
        background: `linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.18)), ${color}`,
        border: '1px solid rgba(255,255,255,0.28)', borderTop: 'none',
        boxShadow: 'inset 0 9px 8px -5px rgba(0,0,0,0.7), 0 2px 5px rgba(0,0,0,0.45)',
        color: '#fff', cursor: 'pointer', userSelect: 'none',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div style={{ height: FOOT, width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px 1px 6px', minWidth: 0 }}>
        {img && <img src={img} alt="" draggable={false} style={{ width: 15, height: 15, objectFit: 'cover', borderRadius: 3, flexShrink: 0 }} />}
        <span style={{ flex: '1 1 auto', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, textShadow: '0 1px 2px rgba(0,0,0,0.55)' }}>{title}</span>
        {more && <span title={more.names} style={{ flex: '0 0 auto', fontSize: 10, fontWeight: 600, opacity: 0.8 }}>+{more.n}</span>}
      </div>
    </div>
  )
}
