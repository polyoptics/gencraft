// Detail chips on a card's face (Brian 2026-11-19: "poke through the
// details on the face card by the detail names"). A detail on the card's
// back that shows another card, and is switched on for the front, is a
// small chip along the bottom of the face, named as the detail is. Click
// a chip and the face shows that card (lit); click it again and the card's
// own face is back. The card's own face is never changed: what a chip
// shows is laid over it. Which chip is lit is a view, not an undo step.
import React from 'react'
import { useBoardsStore, type ProjectGroup, type BoardData } from '../../store/boardsStore'
import { cardFaceMedia } from '../../utils/cardGrid'
import { detailShown } from '../../utils/cardTypes'
import { HeroImageLayer } from './HeroImageLayer'

interface FaceChip { id: string; name: string; card: ProjectGroup }

/** A card's chips: its details that show a card and are on for the front. */
function faceChips(groups: ProjectGroup[], g: ProjectGroup): FaceChip[] {
  const out: FaceChip[] = []
  for (const d of g.details ?? []) {
    if (!d.onFace || !d.link || d.link.detail || d.link.count || d.link.rankOf) continue
    const card = detailShown(groups, d).card
    if (card && card.id !== g.id) out.push({ id: d.id, name: d.name.trim() || 'Detail', card })
  }
  return out
}

const NONE: ProjectGroup[] = []
/** Every card, for a card that has chips; nothing (and no re-render as
 *  other cards change) for the many that have none. */
function useChipGroups(g: ProjectGroup): ProjectGroup[] {
  const has = !!g.details?.some(d => d.onFace)
  return useBoardsStore(s => has ? s.groups : NONE)
}

/** Light a chip, or (the lit one) put it out. */
function toggleFaceChip(groupId: string, detailId: string): void {
  useBoardsStore.setState(s => ({
    groups: s.groups.map(g => g.id === groupId ? { ...g, faceDetail: g.faceDetail === detailId ? undefined : detailId } : g),
  }))
}

/** What the lit chip shows, over the card's own face. Draws nothing, and
 *  takes no presses, when no chip is lit. */
export const DetailFace: React.FC<{
  group: ProjectGroup
  boards: Record<string, BoardData>
  scale: number
  /** How far down the face its header band reaches, where it has one. */
  top?: number
}> = ({ group, boards, scale, top = 0 }) => {
  const groups = useChipGroups(group)
  if (!group.faceDetail) return null
  const chip = faceChips(groups, group).find(c => c.id === group.faceDetail)
  if (!chip) return null
  const m = cardFaceMedia(chip.card, boards)
  const picture = m ? (m.type === 'image' ? m.url : m.posterUrl ?? null) : null
  return (
    <div data-detail-face={chip.id} style={{ position: 'absolute', inset: 0, zIndex: 2, borderRadius: 'inherit', overflow: 'hidden', background: chip.card.color || '#222', pointerEvents: 'none' }}>
      {picture
        ? <HeroImageLayer heroImage={picture} transform={chip.card.cardHeroTransform} opacity={1} />
        : <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8 * scale, textAlign: 'center', fontSize: 12 * scale, fontWeight: 700, color: 'rgba(255,255,255,0.92)' }}>{chip.card.name || 'Untitled'}</div>}
      {/* Whose face this is, so it is never taken for the card's own. */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top, padding: `${3 * scale}px ${6 * scale}px`, textAlign: 'center',
        fontSize: 9 * scale, fontWeight: 700, color: 'rgba(255,255,255,0.92)', textShadow: '0 1px 3px rgba(0,0,0,0.9)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{chip.card.name || 'Untitled'}</div>
    </div>
  )
}

/** The chips, along the bottom of the face. Shown with the card's other
 *  tools, on hover; the lit one stays. They never move or change words. */
export const DetailChips: React.FC<{
  group: ProjectGroup
  scale: number
  visible: boolean
  style?: React.CSSProperties
}> = ({ group, scale, visible, style }) => {
  const groups = useChipGroups(group)
  const chips = faceChips(groups, group)
  if (!chips.length) return null
  const lit = group.faceDetail
  return (
    <div data-detail-chips={group.id} style={{
      position: 'absolute', left: 6, right: 6, bottom: 38 * scale, zIndex: 61,
      display: 'flex', flexWrap: 'wrap-reverse', gap: 3 * scale, pointerEvents: 'none', ...style,
    }}>
      {chips.map(c => {
        const on = c.id === lit
        const shown = visible || on
        return (
          <button
            key={c.id}
            type="button"
            data-detail-chip={c.id}
            data-lit={on ? '' : undefined}
            title={`Show this detail's card on the face (lit: showing)`}
            onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}
            onDoubleClick={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); toggleFaceChip(group.id, c.id) }}
            style={{
              padding: `${1.5 * scale}px ${5 * scale}px`, maxWidth: '100%',
              fontSize: 8.5 * scale, fontWeight: 800, letterSpacing: 0.4 * scale, textTransform: 'uppercase', lineHeight: 1.3,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'inherit',
              borderRadius: 4 * scale, cursor: 'pointer', boxSizing: 'border-box',
              border: `1px solid ${on ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)'}`,
              background: on ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.55)',
              color: on ? '#14161f' : 'rgba(255,255,255,0.85)',
              opacity: shown ? 1 : 0, pointerEvents: shown ? 'auto' : 'none',
              transition: 'opacity 0.12s',
            }}
          >{c.name}</button>
        )
      })}
    </div>
  )
}
