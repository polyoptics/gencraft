// Card on card (Brian 2026-11-12): a card whose link "+" was dropped on
// this one shows TUCKED under this card's bottom edge, its foot sticking
// out with its picture and name (several: each a step further out), the
// way a trait card is tucked under the card it describes. So a card that
// is an effect on others (his mutation card), dragged onto each character
// that has it, reads on every one of them.
//
// The drop target owns the link (LinkDragOverlay), so these are the card's
// OWN links, the ones its chips list; nothing more is stored.
//
// A foot is a drawer (Brian 2026-11-13): click it, or pull it down, and
// the card comes out below, face up, to read and to flip. That showing is
// the one a chip opens (CloneDeck); while it is out its foot is gone.
//
// Factions, families and notes tuck nothing: their links are members.
//
// Drawn inside the chip rail's wrapper (PrimaryChipRail), so in 3D it rides
// with its card exactly as the chips do.

import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useLinkingStore } from '../../store/linkingStore'
import { cardTitle } from '../../utils/faceStyle'
import { cardTypeOf, typeColor } from '../../utils/cardTypes'
import { useResolvedMedia } from '../../utils/useResolvedMedia'

const INSET = 8        // natural sizes: the wrapper scales them with the card
const STEP_IN = 5      // each further card is this much narrower a side
const SEAM = 13        // under the chips, which ride the card's bottom edge
const FOOT = 21        // what each card shows of itself
const MAX_SHOWN = 3
const PULL = 6         // px a foot is dragged down before it comes out

const MEMBERSHIP = new Set(['faction', 'family', 'note'])

/** The cards tucked under `host`: the ones it links to, in link order. */
export function tuckedIds(host: ProjectGroup | undefined, groups: ProjectGroup[]): string[] {
  if (!host || MEMBERSHIP.has(cardTypeOf(host))) return []
  return (host.linkedGroupIds ?? []).filter(id => id !== host.id && groups.some(g => g.id === id))
}

/** How far `n` feet reach below their card's bottom edge, natural units. */
export function tuckedReach(n: number): number {
  return n > 0 ? SEAM + FOOT * Math.min(n, MAX_SHOWN) : 0
}

export const TuckedCards: React.FC<{
  groupId: string
  /** The showing's path ending at this card (a foot opens path + its id). */
  path: string[]
  /** The card's bottom-left corner, from the rail's own corner. */
  left: number
  top: number
  scale: number
  /** The card's width, in the feet's natural units. */
  width: number
}> = ({ groupId, path, left, top, scale, width }) => {
  const all = useBoardsStore(useShallow(s => tuckedIds(s.groups.find(g => g.id === groupId), s.groups)))
  // The ones pulled out are out: no foot.
  const expanded = useLinkingStore(s => s.expandedPaths)
  const ids = all.filter(id => !expanded.has([...path, id].join('>')))
  const rest = useBoardsStore(s => ids.slice(MAX_SHOWN).map(id => { const g = s.groups.find(x => x.id === id); return g ? cardTitle(s.groups, g) || g.name || 'card' : '' }).join(', '))
  if (!ids.length) return null
  const shown = ids.slice(0, MAX_SHOWN)
  return (
    <div data-tucked-cards={groupId} style={{ position: 'absolute', left, top, width: 0, height: 0 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        {shown.map((id, i) => (
          <Tucked key={id} id={id} path={[...path, id]} step={i} width={width}
            more={i === shown.length - 1 && ids.length > MAX_SHOWN ? { n: ids.length - MAX_SHOWN, names: rest } : undefined} />
        ))}
      </div>
    </div>
  )
}

/** One tucked card: only its foot shows, below the card it is under (and
 *  below the ones tucked nearer). Flat on top, shaded where it goes under. */
const Tucked: React.FC<{ id: string; path: string[]; step: number; width: number; more?: { n: number; names: string } }> = ({ id, path, step, width, more }) => {
  const g = useBoardsStore(s => s.groups.find(x => x.id === id))
  const title = useBoardsStore(s => { const c = s.groups.find(x => x.id === id); return c ? cardTitle(s.groups, c) || c.name || 'card' : '' })
  const typeColors = useBoardsStore(s => s.typeColors)
  const img = useResolvedMedia(g?.cardHeroImage ?? null)
  if (!g) return null
  const color = g.color || typeColor(cardTypeOf(g), typeColors)
  const inset = INSET + STEP_IN * step
  /** A click, or a pull down: out it comes. */
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const y0 = e.clientY
    const open = () => { done(); useLinkingStore.getState().setExpanded(path, true) }
    const onMove = (ev: PointerEvent) => { if (ev.clientY - y0 >= PULL) open() }
    const onUp = (ev: PointerEvent) => { if (Math.abs(ev.clientY - y0) < PULL) open(); else done() }
    const done = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', done)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', done)
  }
  return (
    <div
      data-tucked-card={id}
      title={`${title}: click or pull down to show it`}
      onPointerDown={onDown}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      style={{
        position: 'absolute', left: inset, top: 0, width: Math.max(30, width - 2 * inset), height: SEAM + FOOT * (step + 1),
        zIndex: MAX_SHOWN - step, boxSizing: 'border-box',
        display: 'flex', alignItems: 'flex-end',
        borderRadius: '0 0 9px 9px',
        background: `linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.18)), ${color}`,
        border: '1px solid rgba(255,255,255,0.28)', borderTop: 'none',
        boxShadow: 'inset 0 9px 8px -5px rgba(0,0,0,0.7), 0 2px 5px rgba(0,0,0,0.45)',
        color: '#fff', cursor: 'grab', userSelect: 'none', touchAction: 'none',
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
