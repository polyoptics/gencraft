// DeckPeek — a stacked deck seen with an Alt-twist (utils/peek): the cards
// under its face fan out like a hand of cards held for poker, rising behind
// it: centred when the view is tipped, off to one side when it is swung
// (Brian 2026-11-04). Drawn on the layers stage
// under the tilted world (ExplodedStrip's StripLayersStage), so the deck's
// own face hides what is right behind it. Nothing here is stored or pressed.

import React from 'react'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useTiltStore } from '../../store/tiltStore'
import { cardFaceMedia } from '../../utils/cardGrid'
import { deckAreas } from '../../utils/peek'
import { HeroImageLayer } from '../Layers/HeroImageLayer'
import { headerExtend, overviewScale } from '../NLE/NLETimelineHeader'

/** The widest the hand opens, degrees from one edge card to the other,
 *  and how much of that each card adds (fewer cards, a narrower hand). */
const SPREAD = 50
const PER_CARD = 16
/** Where the hand is held: this far below the card's bottom, as a share of
 *  its height. The cards turn about it. */
const HOLD = 0.35
/** How far the cards rise up behind the front card, share of its height. */
const RISE = 0.16
/** Degrees of turn by which the hand has faded fully in. */
const FULL_AT = 25
/** Turning on past that, the hand opens a little more: at most this much
 *  wider, reached EXTRA_AT degrees further on. */
const EXTRA = 0.2
const EXTRA_AT = 40
/** How far back each card steps behind the one in front, as a share of the
 *  card's height. */
const DEPTH = 0.06
/** The mess: up to this much extra turn (degrees) per card, fixed for it. */
const MESS_TURN = 2

/** A steady number in -1..1 for this card, so its mess never changes. */
function jitter(id: string, salt: number): number {
  let h = salt
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return ((h >>> 0) % 2001) / 1000 - 1
}

/** A deck card as the deck draws it: its colour, its header with its name,
 *  its picture under that. */
const PeekCard: React.FC<{ group: ProjectGroup; head: number; zoom: number }> = ({ group, head, zoom }) => {
  const boards = useBoardsStore(s => s.boards)
  const face = cardFaceMedia(group, boards)
  const image = face ? (face.type === 'image' ? face.url : face.posterUrl ?? null) : null
  const k = overviewScale(zoom)
  return (
    <>
      <div style={{ position: 'absolute', top: head, left: 0, right: 0, bottom: 0, overflow: 'hidden', borderRadius: '0 0 12px 12px' }}>
        {image && <HeroImageLayer heroImage={image} transform={group.cardHeroTransform} />}
        <div style={{
          position: 'absolute', left: 8, right: 8, bottom: 6, color: 'rgba(255,255,255,.7)', fontSize: 11 * k, fontWeight: 600,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textShadow: '0 1px 4px rgba(0,0,0,.8)',
        }}>{group.cardSummary || group.name}</div>
      </div>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: head, display: 'flex', alignItems: 'center', padding: '0 6px',
        background: 'rgba(0,0,0,.18)', borderBottom: '1px solid rgba(255,255,255,.12)', color: '#fff', fontSize: 10 * k, fontWeight: 700,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', boxSizing: 'border-box',
      }}>{group.name}</div>
    </>
  )
}

/** A hand of cards, as held for poker (Brian 2026-11-04): the cards behind
 *  the deck's face turn about a point below it, spread to each side and rise
 *  up behind it. Tipped, the hand is centred on the face; swung sideways it
 *  goes all to one side (the opposite side to the swing); between, between. */
export const DeckPeek: React.FC<{ anchorId: string }> = ({ anchorId }) => {
  const yaw = useTiltStore(s => Math.round(s.yaw * 10) / 10)
  const tilt = useTiltStore(s => Math.round(s.tilt * 10) / 10)
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const groups = useBoardsStore(s => s.groups)
  const area = deckAreas.get(anchorId)
  const a = Math.hypot(yaw, tilt)
  const c = Math.min(1, a / FULL_AT), k = c * c * (3 - 2 * c)
  if (!area || k <= 0) return null
  const behind = area.memberIds.slice(1).map(id => groups.find(g => g.id === id)).filter(Boolean) as ProjectGroup[]
  if (!behind.length) return null
  const left = pan.x + area.x * zoom, top = pan.y + area.y * zoom
  const w = area.width * zoom, h = area.height * zoom
  const open = k * (1 + EXTRA * Math.min(1, Math.max(0, a - FULL_AT) / EXTRA_AT))
  // How far the hand leans to one side: 0 centred, -1 all left, 1 all right.
  const lean = -yaw / a
  const n = behind.length
  const spread = Math.min(SPREAD, PER_CARD * (n + 1)) * open
  const cards = behind.map((g, i) => {
    // Centred: either side of the face in turn, each pair further out, none
    // left hidden straight behind it. To one side: every card that side,
    // stepping out.
    const centred = (i % 2 ? -1 : 1) * (Math.floor(i / 2) + 1) / Math.ceil(n / 2) * 0.6
    const sided = Math.sign(lean || 1) * (i + 1) / n
    const at = centred * (1 - Math.abs(lean)) + sided * Math.abs(lean)
    return { g, turn: at * spread + jitter(g.id, 1) * MESS_TURN * open, out: Math.abs(at) }
  })
  // The outermost furthest back, as in a held hand.
  cards.sort((p, q) => q.out - p.out)
  return (
    <>
      {cards.map(({ g, turn, out }) => (
        <div
          key={g.id}
          data-deck-peek={g.id}
          style={{
            position: 'absolute', left, top, width: w, height: h, boxSizing: 'border-box',
            transform: `translate3d(0, ${-RISE * h * open}px, ${-(1 + out * n) * DEPTH * h * open}px) rotate(${turn}deg)`,
            transformOrigin: `50% ${(1 + HOLD) * 100}%`, opacity: k,
            borderRadius: 12, background: g.color, overflow: 'hidden',
            border: '1.5px solid rgba(255,255,255,.25)', boxShadow: '0 6px 32px rgba(0,0,0,.5)',
            pointerEvents: 'none',
          }}
        >
          <PeekCard group={g} head={headerExtend(zoom)} zoom={zoom} />
        </div>
      ))}
    </>
  )
}
