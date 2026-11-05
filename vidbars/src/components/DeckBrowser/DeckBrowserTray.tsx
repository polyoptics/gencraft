// DeckBrowserTray — a horizontal pulldown anchored below the app header that
// shows every deck (project group) as a compressed "top-slice" tile. Tiles
// are draggable: pointerdown on a tile starts a link-drag whose source is
// that tile's group. Drop on any card or any "+" chip creates a link.
//
// Tile visual: color strip + header text + top slice of hero image. ~1/5 of
// a normal card's height so many decks fit in a small footprint.

import React, { useState } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useLinkDragStore } from '../../store/linkDragStore'
import { cssUrl } from '../../utils/diskUrl'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { cardTitle } from '../../utils/faceStyle'

const APP_TOOLBAR_H = 38
const TRAY_HEIGHT = 150
const TILE_W = 180
const TILE_H = 96       // roughly top 1/5 of a card
const TILE_GAP = 10
const TILE_RADIUS = 10

interface Props {
  open: boolean
  onClose: () => void
}

export const DeckBrowserTray: React.FC<Props> = ({ open, onClose }) => {
  const groups = useBoardsStore(s => s.groups)
  const jumpToGroup = useCanvasStore(s => s.jumpToGroup)
  const [liftedId, setLiftedId] = useState<string | null>(null)

  if (!open) return null

  // Skip groups that are hidden deck members (they render as part of a stack).
  const visible = groups.filter(g =>
    !(g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id)
  )

  return (
    <div
      // Outside click closes the tray
      onPointerDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        left: 0,
        top: APP_TOOLBAR_H,
        right: 0,
        height: TRAY_HEIGHT,
        zIndex: 550,
        background: 'linear-gradient(180deg, #12141e 0%, #0a0c14 100%)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: TILE_GAP,
        overflowX: 'auto',
        overflowY: 'hidden',
      }}
    >
      <div style={{
        flexShrink: 0,
        width: 90,
        paddingRight: 12,
        borderRight: '1px solid rgba(255,255,255,0.05)',
        color: 'rgba(255,255,255,0.45)',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '1px',
        paddingTop: 4,
      }}>
        DECKS
        <div style={{ fontSize: 9, fontWeight: 500, marginTop: 3, color: 'rgba(255,255,255,0.3)' }}>
          drag onto a card
        </div>
      </div>

      {visible.map(g => {
        const lifted = liftedId === g.id
        return (
          <DeckTile
            key={g.id}
            group={g}
            lifted={lifted}
            onEnter={() => setLiftedId(g.id)}
            onLeave={() => setLiftedId(prev => prev === g.id ? null : prev)}
            onDoubleClick={() => { jumpToGroup(g.id); onClose() }}
          />
        )
      })}

      {visible.length === 0 && (
        <div style={{
          alignSelf: 'center',
          color: 'rgba(255,255,255,0.35)',
          fontSize: 12,
        }}>No decks yet.</div>
      )}
    </div>
  )
}

// ── Tile ────────────────────────────────────────────────────────────

const DeckTile: React.FC<{
  group: import('../../store/boardsStore').ProjectGroup
  lifted: boolean
  onEnter: () => void
  onLeave: () => void
  onDoubleClick: () => void
}> = ({ group, lifted, onEnter, onLeave, onDoubleClick }) => {
  const beginDrag = useLinkDragStore(s => s.begin)
  const moveDrag = useLinkDragStore(s => s.move)

  const color = group.color || '#5b8dd9'
  // Resolved: a `mediaref:` hero (every browser drop) is not a loadable
  // CSS url, so the tile showed nothing.
  const hero = useResolvedMedia(group.cardHeroImage ?? null)
  const name = useBoardsStore(s => cardTitle(s.groups, group)) || 'Card'
  const board1 = group.boardIds.length

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    beginDrag({ kind: 'group', id: group.id }, color, e.clientX, e.clientY)
    moveDrag(e.clientX, e.clientY)
  }

  return (
    <div
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      title={`${group.name} · ${board1} block${board1 !== 1 ? 's' : ''} · drag to link, double-click to jump`}
      style={{
        flexShrink: 0,
        width: TILE_W,
        height: TILE_H,
        borderRadius: TILE_RADIUS,
        background: hero
          ? `linear-gradient(160deg, ${color}cc 0%, ${color}aa 100%)`
          : color,
        border: lifted
          ? '2px solid rgba(255,255,255,0.7)'
          : '1.5px solid rgba(255,255,255,0.15)',
        boxShadow: lifted
          ? '0 10px 22px rgba(0,0,0,0.55), 0 0 0 2px rgba(217,122,98,0.35)'
          : '0 3px 10px rgba(0,0,0,0.4)',
        cursor: 'grab',
        overflow: 'hidden',
        position: 'relative',
        transform: lifted ? 'translateY(-8px)' : 'translateY(0)',
        transition: 'transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease',
        userSelect: 'none',
        touchAction: 'none',
      }}
    >
      {hero && (
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: cssUrl(hero),
          backgroundSize: 'cover',
          // show the top slice of the hero since a canonical card shows hero
          // starting from its top
          backgroundPosition: 'center top',
          opacity: 0.72,
          pointerEvents: 'none',
        }} />
      )}

      {/* Color strip / mini NLE header on top */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        height: 22,
        background: `${color}ee`,
        borderBottom: '1px solid rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'center', padding: '0 8px',
        zIndex: 2,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: '#fff', opacity: 0.7,
          marginRight: 6,
        }} />
        <div style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '0.5px',
          color: 'rgba(255,255,255,0.85)',
          textShadow: '0 1px 2px rgba(0,0,0,0.5)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          flex: 1,
        }}>
          {(group.name || '').toUpperCase()}
        </div>
      </div>

      {/* Card title */}
      <div style={{
        position: 'absolute',
        top: 28, left: 10, right: 10,
        zIndex: 2,
        color: '#fff',
        fontFamily: 'Georgia, serif',
        fontSize: 15,
        fontWeight: 700,
        textShadow: '0 1px 3px rgba(0,0,0,0.7)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {name}
      </div>

      {/* Footer: board count */}
      <div style={{
        position: 'absolute',
        bottom: 6, left: 10,
        zIndex: 2,
        fontSize: 9,
        fontWeight: 600,
        color: 'rgba(255,255,255,0.65)',
        textShadow: '0 1px 2px rgba(0,0,0,0.6)',
      }}>
        {board1} block{board1 !== 1 ? 's' : ''}
      </div>
    </div>
  )
}
