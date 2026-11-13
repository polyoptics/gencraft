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
// A foot is a drawer (Brian 2026-11-13): pull it down and the card slides
// out from under with the mouse, as far as it is pulled, and stays there
// (a little to peek, all the way to read and to flip); a click brings it
// all the way out. That showing is the one a chip opens (CloneDeck); while
// it is out at all its foot is gone and its lip (DrawerLip) is the grip.
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
import { useCardView } from '../Layers/cardView'

const INSET = 8        // natural sizes: the wrapper scales them with the card
const STEP_IN = 5      // each further card is this much narrower a side
const SEAM = 13        // under the chips, which ride the card's bottom edge
const FOOT = 21        // what each card shows of itself
const MAX_SHOWN = 3
const SLOP = 3         // px before a press is a pull, not a click

const MEMBERSHIP = new Set(['faction', 'family', 'note'])

/** The cards tucked under `host`: the ones it links to, in link order. */
export function tuckedIds(host: ProjectGroup | undefined, groups: ProjectGroup[]): string[] {
  if (!host || MEMBERSHIP.has(cardTypeOf(host))) return []
  return (host.linkedGroupIds ?? []).filter(id => id !== host.id && groups.some(g => g.id === id))
}

/** Does this card tuck the cards it links to under it? All but the ones
 *  whose links are their members. */
export function tucks(host: ProjectGroup | undefined): boolean {
  return !!host && !MEMBERSHIP.has(cardTypeOf(host))
}

/** The cards `card` is tucked under (Brian 2026-11-13: "the effect has the
 *  list of its members under it"): its chips name them (PrimaryChipRail),
 *  as a faction's name its members. */
export function holderIds(card: ProjectGroup | undefined, groups: ProjectGroup[]): string[] {
  if (!card) return []
  return groups.filter(g => g.id !== card.id && tucks(g) && (g.linkedGroupIds ?? []).includes(card.id)).map(g => g.id)
}

/** Every card that can be shown under `card`: the ones it links to, and,
 *  where it tucks, the ones it is tucked under. */
export function shownIds(card: ProjectGroup | undefined, groups: ProjectGroup[]): string[] {
  if (!card) return []
  const own = (card.linkedGroupIds ?? []).filter(id => id !== card.id)
  return tucks(card) ? [...new Set([...own, ...holderIds(card, groups)])] : own
}

/** How far `n` feet reach below their card's bottom edge, natural units. */
export function tuckedReach(n: number): number {
  return n > 0 ? SEAM + FOOT * Math.min(n, MAX_SHOWN) : 0
}

/** A press on a drawer's grip: the showing at `path` follows the pointer
 *  up and down from `fromPx` (how far out it is now, screen px), and stays
 *  where it is let go; pushed all the way in, it is closed. No move: a click. */
export function dragPull(e: React.PointerEvent, path: string[], zoom: number, fromPx: number, onClick: () => void) {
  if (e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  const y0 = e.clientY
  let moved = false
  const onMove = (ev: PointerEvent) => {
    const dy = ev.clientY - y0
    if (!moved && Math.abs(dy) < SLOP) return
    moved = true
    useLinkingStore.getState().setPull(path, Math.max(0, fromPx + dy) / zoom)
  }
  const done = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', done)
  }
  const onUp = () => { done(); if (!moved) onClick() }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', done)
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
          <Tucked key={id} id={id} path={[...path, id]} step={i} width={width} scale={scale}
            more={i === shown.length - 1 && ids.length > MAX_SHOWN ? { n: ids.length - MAX_SHOWN, names: rest } : undefined} />
        ))}
      </div>
    </div>
  )
}

/** One tucked card: only its foot shows, below the card it is under (and
 *  below the ones tucked nearer). Flat on top, shaded where it goes under. */
const Tucked: React.FC<{ id: string; path: string[]; step: number; width: number; scale: number; more?: { n: number; names: string } }> = ({ id, path, step, width, scale, more }) => {
  const g = useBoardsStore(s => s.groups.find(x => x.id === id))
  const title = useBoardsStore(s => { const c = s.groups.find(x => x.id === id); return c ? cardTitle(s.groups, c) || c.name || 'card' : '' })
  const typeColors = useBoardsStore(s => s.typeColors)
  const img = useResolvedMedia(g?.cardHeroImage ?? null)
  const { zoom } = useCardView()
  if (!g) return null
  const color = g.color || typeColor(cardTypeOf(g), typeColors)
  const inset = INSET + STEP_IN * step
  // Pulled from where its foot is, so it does not jump as it is grabbed.
  const onDown = (e: React.PointerEvent) => dragPull(e, path, zoom, (SEAM + FOOT * step) * scale,
    () => useLinkingStore.getState().setExpanded(path, true))
  return (
    <div
      data-tucked-card={id}
      title={`${title}: pull down to slide it out, click to show it all`}
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

/** The grip of a card pulled part way out (CloneDeck): a foot, riding its
 *  bottom edge. Drag it to slide the card further out or back in; click:
 *  all the way out. `left`/`top`/`width` are screen px, `out` how far out
 *  the card is now. */
export const DrawerLip: React.FC<{ id: string; path: string[]; left: number; top: number; width: number; scale: number; out: number }> = ({ id, path, left, top, width, scale, out }) => {
  const g = useBoardsStore(s => s.groups.find(x => x.id === id))
  const title = useBoardsStore(s => { const c = s.groups.find(x => x.id === id); return c ? cardTitle(s.groups, c) || c.name || 'card' : '' })
  const typeColors = useBoardsStore(s => s.typeColors)
  const { zoom } = useCardView()
  if (!g) return null
  const color = g.color || typeColor(cardTypeOf(g), typeColors)
  const w = width / scale
  return (
    <div style={{ position: 'absolute', left, top, width: 0, height: 0, zIndex: 39, pointerEvents: 'auto' }}>
      <div
        data-drawer-lip={id}
        title={`${title}: drag to slide it out or back, click to show it all`}
        onPointerDown={e => dragPull(e, path, zoom, out, () => useLinkingStore.getState().setExpanded(path, true))}
        onClick={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
        style={{
          position: 'absolute', left: INSET, top: 0, width: Math.max(30, w - 2 * INSET), height: FOOT, boxSizing: 'border-box',
          transform: `scale(${scale})`, transformOrigin: `${-INSET}px 0`,
          display: 'flex', alignItems: 'center', padding: '0 8px 1px 6px',
          borderRadius: '0 0 9px 9px',
          background: `linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.18)), ${color}`,
          border: '1px solid rgba(255,255,255,0.28)', borderTop: 'none',
          boxShadow: 'inset 0 6px 6px -5px rgba(0,0,0,0.7), 0 2px 5px rgba(0,0,0,0.45)',
          color: '#fff', cursor: 'grab', userSelect: 'none', touchAction: 'none',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <span style={{ flex: '1 1 auto', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, textShadow: '0 1px 2px rgba(0,0,0,0.55)' }}>{title}</span>
      </div>
    </div>
  )
}
