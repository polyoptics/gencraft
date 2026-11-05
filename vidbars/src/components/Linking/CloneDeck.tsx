// CloneDeck — a linked card's showing under its host (Brian 2026-11-05):
// the master card itself, shown again. Its header is hatched like any linked
// card's (utils/linkedCards); its text is edited in place and its back
// (flip) too, and every edit is the master's. Go to master jumps to it;
// dragging it out leaves a plain copy of it on the canvas.
//
// Before: a read-only, in-sync visual of a linked group, rendered as a
// parented "clone" of its host. Visually matches the canonical card (same
// hero, text, geometry) with a small CLONE badge and coral accent stripe to
// make its status obvious. Double-clicking the title or the jump button pans
// to the canonical card; the × closes this expansion instance only.
//
// v1 scope: read-only. v2: clones may gain their own local additions.
// Recursion: clones carry their own PrimaryChipRail so users can drill deeper.

import React, { useState } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useLinkingStore } from '../../store/linkingStore'
import { HeroImageLayer } from '../Layers/HeroImageLayer'
import { PrimaryChipRail } from './PrimaryChipRail'
import { cardScreenRect, GroupCardText } from '../Layers/CardLayer'
import { useCardView } from '../Layers/cardView'
import { NLE_HEADER_CANVAS_H } from '../NLE/NLETimelineHeader'
import { getFirstImageUrl } from '../../types/bar'
import { CARD_TEXT_REF_ZOOM } from '../../store/zoomZonesStore'
import { CardBack, FlipButton } from '../Layers/CardBack'
import { useUndoCoordinator } from '../../store/undoCoordinator'

interface Props {
  /** Group this clone represents. */
  targetGroupId: string
  /** Host rect (in screen coords) this clone sits relative to. */
  hostRect: { left: number; top: number; width: number; height: number }
  /** Full expansion path ending at targetGroupId. */
  path: string[]
  /** Stacking index among siblings of the same host (vertical tiling). */
  childIndex: number
  /** Host's group id (the card whose chip was clicked). */
  hostGroupId: string
  /** Optional explicit (left, top) override — used by deck-member clones so
   *  they reproduce the canonical deck's spatial layout instead of tiling
   *  vertically under the anchor. */
  positionOverride?: { left: number; top: number }
}

const GAP = 24                // space between host and first clone
const CLEARANCE = 44          // room below for the clone's own primary rail

export const CloneDeck: React.FC<Props> = ({
  targetGroupId, hostRect, path, childIndex, hostGroupId, positionOverride,
}) => {
  const [jumpHovered, setJumpHovered] = useState(false)
  // Turned over here only: the master on the canvas stays as it is.
  const [flipped, setFlipped] = useState(false)

  const target = useBoardsStore(s => s.groups.find(g => g.id === targetGroupId))
  const hostGroupName = useBoardsStore(s => s.groups.find(g => g.id === hostGroupId)?.name ?? null)
  const boards = useBoardsStore(s => s.boards)
  // Live deck-member detection (used to decide whether the ⊞ button is shown
  // and as the snapshot source when opening). Stable '|'-joined selector so
  // we don't churn the component on unrelated store updates.
  const liveMemberIds = useBoardsStore(s =>
    s.groups
      .filter(g => g.id !== targetGroupId && g.deckAnchorId === targetGroupId)
      .map(g => g.id)
      .join('|')
  )
  const jumpToGroup = useCanvasStore(s => s.jumpToGroup)
  const setExpanded = useLinkingStore(s => s.setExpanded)
  const unlink = useBoardsStore(s => s.unlinkGroups)
  const expandedPaths = useLinkingStore(s => s.expandedPaths)
  const deckSnapshots = useLinkingStore(s => s.deckSnapshots)
  const openDeck = useLinkingStore(s => s.openDeck)
  const closeDeck = useLinkingStore(s => s.closeDeck)
  // The HOST card's camera, not the canvas's. A clone hangs off its host and
  // is positioned from `hostRect`, which the linking layer already computed
  // with the host's camera — so sizing it from the live canvas meant the box
  // and its position were drawn by two different cameras. On a pinned host
  // that is visible immediately: the position stays put while the box grows
  // and shrinks with every canvas zoom, and the text inside it (which reads
  // this same context) disagrees with the box it sits in.
  const { pan, zoom } = useCardView()

  if (!target) return null

  // Clone matches the canonical card's own dimensions — "we see it exactly as
  // it was created." cardScreenRect returns { screenLeft, screenTop,
  // screenWidth, screenHeight } at the canonical's REAL canvas position, but
  // we only borrow the width/height and re-position below the host.
  const canonicalRect = cardScreenRect(target, boards, pan, zoom)
  const width = canonicalRect?.screenWidth ?? hostRect.width
  const height = canonicalRect?.screenHeight ?? hostRect.height

  // Position: align to host's left edge (so the clone "hangs off" like a child);
  // stack vertically if multiple siblings are expanded under the same host.
  // When `positionOverride` is provided (deck-member expansions), use that
  // explicit (left, top) instead — preserves the canonical deck's spatial
  // layout.
  const perChildH = height + CLEARANCE + GAP
  const left = positionOverride
    ? positionOverride.left
    : hostRect.left
  const top = positionOverride
    ? positionOverride.top
    : hostRect.top + hostRect.height + GAP + childIndex * perChildH

  const color = target.color || '#5b8dd9'
  // Match GroupCard's hero-resolution fallback: prefer the group's cardHeroImage,
  // otherwise walk into boards' root bars for the first image in their content.
  // (Pelagia-9 and similar cards store their hero on a bar rather than on the group.)
  let heroImage: string | null = target.cardHeroImage ?? null
  if (!heroImage) {
    outer: for (const bid of target.boardIds) {
      const board = boards[bid]
      if (!board) continue
      for (const rid of board.rootIds) {
        const img = getFirstImageUrl(board.bars[rid]?.content)
        if (img) { heroImage = img; break outer }
      }
    }
  }
  const myRect = { left, top, width, height }

  // Match the canonical card's layout: the card box extends upward into the
  // space where the NLE timeline header would sit. On the canonical, that
  // space is filled by the real header; here we paint a coral-accented
  // surrogate with the CLONE badge + controls, then position the text
  // content below it using the same headerPad offset GroupCard uses.
  const headerPad = Math.max(NLE_HEADER_CANVAS_H * zoom, 20) + 2 * zoom

  // At card-zoom, textScale = zoom / CARD_TEXT_REF_ZOOM. Same ratio so chips match
  // the card text's scale — but clamp minimum so chips don't vanish when the
  // canvas is scrolled far out.
  const textScale = Math.max(zoom / CARD_TEXT_REF_ZOOM, 0.25)

  // Nested expansions: clone's own outbound links whose path is active.
  const nestedExpanded: string[] = []
  const linkedIds = target.linkedGroupIds ?? []
  for (const gid of linkedIds) {
    const childPath = [...path, gid].join('>')
    if (expandedPaths.has(childPath)) nestedExpanded.push(gid)
  }

  // Deck members: whether this target is a deck anchor right now.
  const liveMembers = liveMemberIds ? liveMemberIds.split('|') : []
  const hasMembers = liveMembers.length > 0

  // "Deck open" state for a clone is independent of the master's current
  // deckState — we snapshot the member list when the user opens the clone's
  // deck, so toggling the master later doesn't collapse the clone. The path
  // + '__members__' suffix keeps the snapshot key distinct from link paths.
  const membersPath = [...path, '__members__']
  const snapshotKey = membersPath.join('>')
  const membersOpen = deckSnapshots.has(snapshotKey)
  const snapshotMemberIds = deckSnapshots.get(snapshotKey) ?? []

  const onClose = () => setExpanded(path, false)
  const onJump = () => jumpToGroup(targetGroupId)
  void unlink
  /** Dragged out (past a few pixels): a plain copy of the card, made where
   *  this showing is and carried under the pointer until let go. */
  const onCopyDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as Element).closest('button, textarea, input, [data-card-back] [data-detail-row], [contenteditable="true"]')) return
    e.stopPropagation()
    const x0 = e.clientX, y0 = e.clientY
    let copy: string | null = null
    let o = { x: 0, y: 0 }
    const onMove = (ev: PointerEvent) => {
      const bs = useBoardsStore.getState()
      if (!copy) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return
        useUndoCoordinator.getState().checkpoint()
        const m = bs.groups.find(g => g.id === targetGroupId)
        const mr = m && cardScreenRect(m, bs.boards, pan, zoom)
        copy = bs.duplicateGroup(targetGroupId)
        if (!copy || !m || !mr) return
        o = { x: m.originX + (left - mr.screenLeft) / zoom, y: m.originY + (top - mr.screenTop) / zoom }
        bs.setSelectedGroup(copy)
      }
      useBoardsStore.getState().setGroupPos(copy, o.y + (ev.clientY - y0) / zoom, o.x + (ev.clientX - x0) / zoom)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const onToggleMembers = () => {
    if (membersOpen) closeDeck(membersPath)
    else openDeck(membersPath, liveMembers)
  }

  const hostLabel = hostGroupName ?? 'linked from'

  return (
    <>
      {/* The clone card — rendered to closely mirror GroupCard */}
      <div
        data-clone-deck={targetGroupId}
        data-link-drop={`card:${targetGroupId}`}
        onPointerDown={onCopyDown}
        title="Drag out to leave a copy of this card"
        style={{
          position: 'absolute',
          left, top, width, height,
          zIndex: 39,     // just below canonical cards (40)
          borderRadius: 12,
          background: heroImage
            ? `linear-gradient(160deg, ${color}cc 0%, ${color}aa 100%)`
            : color,
          border: `1.5px solid rgba(255,255,255,0.25)`,
          boxShadow: `0 6px 22px rgba(0,0,0,0.45)`,
          overflow: 'hidden',
          pointerEvents: 'auto',
        }}
      >
        {heroImage && (
          <HeroImageLayer
            heroImage={heroImage}
            transform={target.cardHeroTransform}
            borderRadius={10}
          />
        )}

        {/* Content area — mirrors GroupCard's inner layout so the embedded
            GroupCardText renders exactly like the canonical (same fonts, same
            header/body styles, same split ratio). pointerEvents:none keeps
            the clone strictly read-only. */}
        <div
          style={{
            position: 'absolute',
            top: headerPad, left: 0, right: 0, bottom: 0,
            overflow: 'hidden',
            borderRadius: '0 0 12px 12px',
          }}
        >
          {flipped ? (
            <CardBack groupId={targetGroupId} color={color} width={width} height={Math.max(1, height - headerPad)} hovered reserve={4} />
          ) : (<>
          <GroupCardText groupId={targetGroupId} heroImage={heroImage} />
          <div style={{
            position: 'absolute', bottom: 6, left: 8, zIndex: 2,
            color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600,
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {target.cardSummary || `${target.boardIds.length} block${target.boardIds.length !== 1 ? 's' : ''}`}
          </div>
          </>)}
        </div>

        {/* Its header band, hatched as a linked card's is (CardLayer
            data-linked-mark): flip, its name, and its controls. */}
        <div data-linked-mark style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          height: headerPad,
          background: `repeating-linear-gradient(135deg, rgba(0,0,0,0.16) 0 ${Math.max(1.5, headerPad * 0.18)}px, rgba(255,255,255,0.05) ${Math.max(1.5, headerPad * 0.18)}px ${Math.max(3, headerPad * 0.36)}px)`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4,
          padding: '0 6px',
          zIndex: 5,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
            <FlipButton flipped={flipped} onFlip={() => setFlipped(f => !f)} baseColor={color} size={16} visible style={{ position: 'relative', left: 0, top: 0, flexShrink: 0 }} />
            <span
              title={`${target.name} — linked from ${hostLabel}. Edits here are the card's own.`}
              style={{ color: '#fff', fontSize: 10, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}
            >{target.name}</span>
          </div>
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            {(hasMembers || membersOpen) && (
              <button
                onClick={onToggleMembers}
                title={membersOpen
                  ? `Close deck (${snapshotMemberIds.length} cards)`
                  : `Open deck (${liveMembers.length} cards)`}
                style={cornerBtn(membersOpen)}
              >{membersOpen ? '⊟' : '⊞'}</button>
            )}
            <button
              onClick={onJump}
              onPointerEnter={() => setJumpHovered(true)}
              onPointerLeave={() => setJumpHovered(false)}
              title="Go to the master card"
              style={cornerBtn(jumpHovered)}
            >⤤</button>
            <button onClick={onClose} title="Close" style={cornerBtn(false)}>×</button>
          </div>
        </div>
      </div>

      {/* The clone's own primary rail so users can keep drilling in */}
      <PrimaryChipRail
        groupId={targetGroupId}
        hostRect={myRect}
        path={path}
        scale={textScale}
      />
      {/* Back-refs not shown on clones in v1 — avoids visual clutter in the tree */}

      {/* Nested link-expansion clones (outbound chip expansion) */}
      {nestedExpanded.map((cid, i) => (
        <CloneDeck
          key={`link:${cid}`}
          targetGroupId={cid}
          hostRect={myRect}
          path={[...path, cid]}
          childIndex={i}
          hostGroupId={targetGroupId}
        />
      ))}

      {/* Deck-member clones — rendered from the SNAPSHOT taken when the user
          opened the clone's deck. The member list is frozen to that moment
          so toggling the master deck's state on the canvas (stacked <-> open)
          doesn't make these disappear. Each member is placed at its
          canonical screen offset from the anchor so the spatial arrangement
          exactly mirrors the master's layout — horizontal decks expand
          horizontally, etc. */}
      {membersOpen && snapshotMemberIds.map((mid) => {
        const offset = computeMemberScreenOffset(mid, target, useBoardsStore.getState().groups, boards, pan, zoom)
        if (!offset) return null
        return (
          <CloneDeck
            key={`member:${mid}`}
            targetGroupId={mid}
            hostRect={myRect}
            path={[...membersPath, mid]}
            childIndex={0}
            hostGroupId={targetGroupId}
            positionOverride={{
              left: left + offset.dx,
              top: top + offset.dy,
            }}
          />
        )
      })}
    </>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Compute a deck-member clone's screen offset from its anchor clone. Uses
 *  the SAME `cardScreenRect` math that the canonical cards are rendered with,
 *  so the clone expansion reproduces the master deck's visual layout pixel-
 *  for-pixel (accounting for bar extents, padding, and header extension).
 *
 *  Returns null if either rect can't be computed.
 */
function computeMemberScreenOffset(
  memberId: string,
  anchor: import('../../store/boardsStore').ProjectGroup,
  groups: import('../../store/boardsStore').ProjectGroup[],
  boards: Record<string, import('../../store/boardsStore').BoardData>,
  pan: { x: number; y: number },
  zoom: number,
): { dx: number; dy: number } | null {
  const member = groups.find(g => g.id === memberId)
  if (!member) return null
  const anchorRect = cardScreenRect(anchor, boards, pan, zoom)
  const memberRect = cardScreenRect(member, boards, pan, zoom)
  if (!anchorRect || !memberRect) return null
  return {
    dx: memberRect.screenLeft - anchorRect.screenLeft,
    dy: memberRect.screenTop - anchorRect.screenTop,
  }
}

const cornerBtn = (hovered: boolean): React.CSSProperties => ({
  width: 18, height: 18,
  border: '1px solid rgba(255,255,255,0.18)',
  background: hovered ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.38)',
  color: 'rgba(255,255,255,0.92)',
  fontSize: 11, lineHeight: 1,
  borderRadius: 4,
  cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 0,
  fontFamily: 'inherit',
  transition: 'background 0.12s',
})
