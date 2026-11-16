// PrimaryChipRail — outbound link chips attached to the bottom-left edge of
// a card. The rail is rendered in screen space at the card's bottom edge but
// wrapped in a transform-scale container using the same `textScale` ratio as
// GroupCardText, so chips shrink/grow with the card.
//
// The trailing "+" chip is a link-drag source (pointerdown starts the drag).
// Individual chips toggle clone-card expansion on click, jump on double-click,
// and can be unlinked via a hover-revealed × button.

import React, { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useLinkingStore } from '../../store/linkingStore'
import { useLinkDragStore } from '../../store/linkDragStore'
import type { ProjectGroup } from '../../store/boardsStore'
import { RefChip } from './LinkChipRail'
import { refKey } from '../../utils/linkTargets'
import { cardTitle } from '../../utils/faceStyle'
import { CARD_TYPES, cardTypeOf, type CardType } from '../../utils/cardTypes'
import { holderIds, tucks } from '../../utils/tucked'
import { unlinkFromHolder } from '../../utils/sceneContent'
import { TrayLip, useTrayTucked } from './CardTray'
import { useTrayStore } from '../../store/trayStore'

interface Props {
  /** Group whose outbound link chips we're rendering. */
  groupId: string
  /** Host card's screen rect. */
  hostRect: { left: number; top: number; width: number; height: number }
  /** Full expansion path ending at groupId. Chips extend by one. */
  path: string[]
  /** Scale factor (matches GroupCardText textScale = zoom / CARD_MAX_ZOOM). */
  scale: number
}

const CHIP_H = 24      // natural size — scales via the transform wrapper
const CHIP_GAP = 6
const RAIL_INSET_X = 14
const RAIL_Y_OFFSET = -CHIP_H / 2   // half-in, half-out of the card bottom edge

export const PrimaryChipRail: React.FC<Props> = ({ groupId, hostRect, path, scale }) => {
  const host = useBoardsStore(s => s.groups.find(g => g.id === groupId))
  // What its chips name (Brian 2026-11-13). A card that tucks the cards it
  // links to lists those in its tray, not as chips too; its chips are
  // the cards IT is tucked under: the mutation lists its characters, each
  // character shows the mutation tucked. A faction's, a family's and a
  // note's chips are the cards they link to, as ever.
  const held = tucks(host)
  const linkedIdsStable = useBoardsStore(s => held ? holderIds(host, s.groups).join('|') : (host?.linkedGroupIds ?? []).join('|'))

  const linkedGroups = useBoardsStore(
    useShallow(s => {
      if (!linkedIdsStable) return [] as ProjectGroup[]
      const ids = linkedIdsStable.split('|')
      return ids.map(id => s.groups.find(g => g.id === id)).filter(Boolean) as ProjectGroup[]
    })
  )

  // Anchor the outer wrapper to the card's bottom-left; transformOrigin top-left
  // so the scaled content hangs off that point.
  const left = hostRect.left + RAIL_INSET_X * scale
  const top = hostRect.top + hostRect.height + RAIL_Y_OFFSET * scale

  // Its tray out: the chips ride over the tray's top, as over the card's edge.
  const trayTucked = useTrayTucked(groupId)
  const trayOut = useTrayStore(s => path.length === 1 && (s.trays[groupId]?.h ?? 0) > 0) && !trayTucked

  if (!host) return null

  return (
    <div
      // Whose chips: in 3D they ride up with their card (TiltLayer).
      data-primary-rail={groupId}
      style={{
        position: 'absolute',
        left, top,
        zIndex: trayOut ? 57 : 42,
        pointerEvents: 'auto',
      }}
    >
      {/* Its tray's lip, tucked under its bottom edge: the cards it holds
          and the cards linked with it. Placed from this rail's corner; the
          chips ride over it. The card itself only, not a showing of it. */}
      {path.length === 1 && <TrayLip
        cardId={groupId}
        left={-RAIL_INSET_X * scale}
        top={-RAIL_Y_OFFSET * scale}
        scale={scale}
        width={hostRect.width / scale}
      />}
      <div
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          display: 'flex',
          gap: CHIP_GAP,
          alignItems: 'center',
        }}
      >
        {/* A faction's or a family's members: one chip per kind of card
            (Brian 2026-11-05), each opening a list to pick one from; the
            ones opened show beside it as usual. Other cards: a chip each. */}
        {grouped(host) || (held && linkedGroups.length > MANY)
          ? byType(linkedGroups).map(([type, list]) => (
              <TypeChip key={type} host={host} type={type} list={list} path={path} />
            ))
          : linkedGroups.map(g => (
              <PrimaryChip
                key={g.id}
                host={host}
                linked={g}
                path={[...path, g.id]}
                held={held}
              />
            ))}
        {/* References to BLOCKS and ELEMENTS. Card-to-card chips above are
            expandable into clones and so have their own component; these
            share the chip the block and element rails use, so a reference
            looks the same wherever you meet it. zoom=1 because this rail is
            already inside a scale() wrapper. */}
        {(host.linkedRefs ?? []).map(r => (
          <RefChip key={refKey(r)} owner={{ kind: 'group', id: host.id }} target={r} zoom={1} />
        ))}
        <AddChip hostGroup={host} />
      </div>
    </div>
  )
}

// ── Members by kind (faction, family) ───────────────────────────────

const grouped = (host: ProjectGroup) => host.cardType === 'faction' || host.cardType === 'family'
/** More cards than this that a card is tucked under: a chip per kind, as a
 *  faction's members, not a chip each. */
const MANY = 3

/** The linked cards by type, in the usual type order. */
function byType(list: ProjectGroup[]): [CardType, ProjectGroup[]][] {
  const m = new Map<CardType, ProjectGroup[]>()
  for (const g of list) { const t = cardTypeOf(g); m.set(t, [...(m.get(t) ?? []), g]) }
  return (Object.keys(CARD_TYPES) as CardType[]).filter(t => m.has(t)).map(t => [t, m.get(t)!])
}

const plural = (label: string) => label.endsWith('y') ? label.slice(0, -1) + 'ies' : label.endsWith('o') ? label : label + 's'

/** One kind of member: "Characters 12". Click: a list of them; pick one to
 *  open it as its chip does. The open ones show beside it, to close. */
const TypeChip: React.FC<{ host: ProjectGroup; type: CardType; list: ProjectGroup[]; path: string[] }> = ({ host, type, list, path }) => {
  const [open, setOpen] = useState(false)
  const toggle = useLinkingStore(s => s.toggleExpanded)
  const jumpToGroup = useCanvasStore(s => s.jumpToGroup)
  const groups = useBoardsStore(s => s.groups)
  const expanded = useLinkingStore(useShallow(s => list.filter(g => s.isExpanded([...path, g.id])).map(g => g.id)))
  const color = CARD_TYPES[type].color
  return (
    <>
      <div
        data-link-type-chip={type}
        data-link-drop={`chip:${host.id}`}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        onPointerDown={e => e.stopPropagation()}
        title={`${plural(CARD_TYPES[type].label)}: click to pick one`}
        style={{
          position: 'relative', height: CHIP_H, display: 'flex', alignItems: 'center', gap: 5, padding: '0 9px 0 4px',
          borderRadius: 12, background: open ? color : `${color}d0`, color: '#fff', fontSize: 11, fontWeight: 600,
          letterSpacing: '0.2px', cursor: 'pointer', userSelect: 'none',
          boxShadow: open ? `0 2px 8px ${color}aa` : '0 1px 4px rgba(0,0,0,0.4)',
          border: open ? '1.5px solid rgba(255,255,255,0.55)' : '1.5px solid rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ width: 16, height: 16, borderRadius: '50%', background: color, border: '1.5px solid rgba(255,255,255,0.55)', flexShrink: 0 }} />
        <span style={{ whiteSpace: 'nowrap', textShadow: '0 1px 2px rgba(0,0,0,0.55)' }}>{plural(CARD_TYPES[type].label)}</span>
        <span style={{ opacity: 0.75, fontWeight: 500 }}>{list.length}</span>
        <span style={{ opacity: 0.7, fontSize: 8 }}>▾</span>
        {open && (
          <div
            data-link-type-list={type}
            onClick={e => e.stopPropagation()}
            onWheel={e => e.stopPropagation()}
            style={{
              position: 'absolute', top: CHIP_H + 4, left: 0, zIndex: 5, minWidth: 150, maxHeight: 260, overflowY: 'auto',
              background: 'rgba(22,24,38,0.97)', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 8,
              boxShadow: '0 6px 20px rgba(0,0,0,0.5)', padding: 4, display: 'flex', flexDirection: 'column', gap: 1,
            }}
          >
            {list.map(g => {
              const lit = expanded.includes(g.id)
              return (
                <div
                  key={g.id}
                  data-link-type-item={g.id}
                  onClick={e => { if (e.detail === 2) return; e.stopPropagation(); toggle([...path, g.id]); setOpen(false) }}
                  onDoubleClick={e => { e.stopPropagation(); jumpToGroup(g.id); setOpen(false) }}
                  title="Click to show it, double-click to jump"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', borderRadius: 5, cursor: 'pointer',
                    fontSize: 11, fontWeight: lit ? 700 : 500, whiteSpace: 'nowrap',
                    background: lit ? `${g.color || color}66` : undefined,
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: g.color || color, flexShrink: 0 }} />
                  {cardTitle(groups, g) || 'card'}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {list.filter(g => expanded.includes(g.id)).map(g => (
        <PrimaryChip key={g.id} host={host} linked={g} path={[...path, g.id]} />
      ))}
    </>
  )
}

// ── Individual primary chip ──────────────────────────────────────────

const PrimaryChip: React.FC<{ host: ProjectGroup; linked: ProjectGroup; path: string[]; held?: boolean }> = ({
  host, linked, path, held,
}) => {
  const [hovered, setHovered] = useState(false)
  const isExpanded = useLinkingStore(s => s.isExpanded(path))
  const toggle = useLinkingStore(s => s.toggleExpanded)
  const jumpToGroup = useCanvasStore(s => s.jumpToGroup)
  const unlink = useBoardsStore(s => s.unlinkGroups)
  const closeContaining = useLinkingStore(s => s.closeContaining)

  const label = (useBoardsStore(s => cardTitle(s.groups, linked)) || 'card').slice(0, 14)
  const color = linked.color || '#5b8dd9'

  return (
    <div
      data-link-drop={`chip:${host.id}`}
      onClick={e => {
        if (e.detail === 2) return
        e.stopPropagation()
        toggle(path)
      }}
      onDoubleClick={e => { e.stopPropagation(); jumpToGroup(linked.id) }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      title={`${linked.name} — click to expand, double-click to jump`}
      style={{
        height: CHIP_H,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '0 9px 0 4px',
        borderRadius: 12,
        background: isExpanded ? color : `${color}d0`,
        color: '#fff',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.2px',
        cursor: 'pointer',
        boxShadow: isExpanded
          ? `0 2px 8px ${color}aa, 0 0 0 1.5px rgba(255,255,255,0.35) inset`
          : '0 1px 4px rgba(0,0,0,0.4)',
        border: isExpanded
          ? '1.5px solid rgba(255,255,255,0.55)'
          : '1.5px solid rgba(0,0,0,0.25)',
        userSelect: 'none',
        transition: 'box-shadow 0.12s, background 0.12s',
      }}
    >
      <div style={{
        width: 16, height: 16, borderRadius: '50%',
        background: color,
        border: '1.5px solid rgba(255,255,255,0.55)',
        flexShrink: 0,
      }} />
      <span style={{
        whiteSpace: 'nowrap',
        textShadow: '0 1px 2px rgba(0,0,0,0.55)',
      }}>{label}</span>
      {hovered && (
        <div
          onClick={e => {
            e.stopPropagation()
            // The link is kept by the card the other is tucked under.
            if (held) unlinkFromHolder(linked.id, host.id)
            else unlink(host.id, linked.id)
            closeContaining(linked.id)
          }}
          title="Unlink"
          style={{
            width: 16, height: 16, borderRadius: '50%',
            background: 'rgba(0,0,0,0.6)',
            border: '1px solid rgba(255,255,255,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginLeft: 2,
            fontSize: 11, lineHeight: 1,
            color: 'rgba(255,255,255,0.95)',
          }}
        >×</div>
      )}
    </div>
  )
}

// ── Trailing "+" chip — starts a link-drag on pointerdown ────────────

const AddChip: React.FC<{ hostGroup: ProjectGroup }> = ({ hostGroup }) => {
  const beginDrag = useLinkDragStore(s => s.begin)
  const moveDrag = useLinkDragStore(s => s.move)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    beginDrag({ kind: 'group', id: hostGroup.id }, hostGroup.color || '#5b8dd9', e.clientX, e.clientY)
    // Global pointermove/up listeners are installed by the LinkDragTracker
    // hook mounted at the app root. This chip only begins the drag.
    // But to make sure the first move already registers, seed the position.
    moveDrag(e.clientX, e.clientY)
  }

  return (
    <div
      data-link-drop={`chip:${hostGroup.id}`}
      onPointerDown={onPointerDown}
      title="Drag to another card to link"
      style={{
        width: CHIP_H, height: CHIP_H,
        borderRadius: '50%',
        background: 'rgba(255,255,255,0.1)',
        border: '1.5px dashed rgba(255,255,255,0.45)',
        color: 'rgba(255,255,255,0.8)',
        fontSize: 15, lineHeight: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'crosshair',
        userSelect: 'none',
        touchAction: 'none',
      }}
    >+</div>
  )
}
