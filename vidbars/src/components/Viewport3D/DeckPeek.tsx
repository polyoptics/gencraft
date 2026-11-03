// DeckPeek — a stacked deck seen with an Alt-twist (utils/peek): the cards
// under its face fan out to the side in one pose, a little turned and messy,
// eased in by a sideways swing (Brian 2026-11-03). Drawn on the layers stage
// under the tilted world (ExplodedStrip's StripLayersStage), so the deck's
// own face hides what is right behind it. Nothing here is stored or pressed.

import React from 'react'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useTiltStore } from '../../store/tiltStore'
import { cardFaceMedia } from '../../utils/cardGrid'
import { deckAreas } from '../../utils/peek'
import { HeroImageLayer } from '../Layers/HeroImageLayer'

/** How far each card sticks out past the one in front, as a share of the
 *  card's width, in the pose. */
const STEP = 0.32
/** However many cards, the pose reaches no further than this many card
 *  widths to the side. */
const MOST = 1.5
/** Degrees of sideways swing by which the pose has faded fully in. */
const FULL_AT = 25
/** Swinging on past that, the pose opens a little more: at most this much
 *  wider, reached EXTRA_AT degrees further on. */
const EXTRA = 0.2
const EXTRA_AT = 40
/** The little depth each card sits behind the one in front, px. */
const BACK = 3
/** How far each card turns, degrees, fanning like a hand of cards. */
const FAN_TURN = 3
/** The mess: up to this much extra turn (degrees) and drop (share of the
 *  card's height) per card, fixed for each card. */
const MESS_TURN = 2.5
const MESS_DROP = 0.035

/** A steady number in -1..1 for this card, so its mess never changes. */
function jitter(id: string, salt: number): number {
  let h = salt
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return ((h >>> 0) % 2001) / 1000 - 1
}

const PeekCard: React.FC<{ group: ProjectGroup }> = ({ group }) => {
  const boards = useBoardsStore(s => s.boards)
  const face = cardFaceMedia(group, boards)
  const image = face ? (face.type === 'image' ? face.url : face.posterUrl ?? null) : null
  return (
    <>
      {image && <HeroImageLayer heroImage={image} transform={group.cardHeroTransform} />}
      <div style={{
        position: 'absolute', left: 8, right: 8, bottom: 6, color: 'rgba(255,255,255,.85)', fontSize: 12, fontWeight: 600,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textShadow: '0 1px 4px rgba(0,0,0,.8)',
      }}>{group.cardSummary || group.name}</div>
    </>
  )
}

/** One pose: the cards fanned out to the side, a little turned and a
 *  little messy, every one sticking out (Brian 2026-11-03). A sideways swing
 *  fades into it and, swung further, opens it only slightly. They go out
 *  the opposite side to the swing. */
export const DeckPeek: React.FC<{ anchorId: string }> = ({ anchorId }) => {
  const yaw = useTiltStore(s => Math.round(s.yaw * 10) / 10)
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const groups = useBoardsStore(s => s.groups)
  const area = deckAreas.get(anchorId)
  const a = Math.abs(yaw)
  const c = Math.min(1, a / FULL_AT), k = c * c * (3 - 2 * c)
  if (!area || k <= 0) return null
  const behind = area.memberIds.slice(1).map(id => groups.find(g => g.id === id)).filter(Boolean) as ProjectGroup[]
  if (!behind.length) return null
  const left = pan.x + area.x * zoom, top = pan.y + area.y * zoom
  const w = area.width * zoom, h = area.height * zoom
  const side = yaw > 0 ? -1 : 1
  const open = k * (1 + EXTRA * Math.min(1, Math.max(0, a - FULL_AT) / EXTRA_AT))
  const step = Math.min(STEP, MOST / behind.length) * w * open
  return (
    <>
      {behind.map((g, i) => ({ g, n: i + 1 })).reverse().map(({ g, n }) => {
        const turn = (n * FAN_TURN + jitter(g.id, 1) * MESS_TURN) * side * open
        const drop = (jitter(g.id, 2) * MESS_DROP + n * 0.01) * h * open
        return (
          <div
            key={g.id}
            data-deck-peek={g.id}
            style={{
              position: 'absolute', left, top, width: w, height: h, boxSizing: 'border-box',
              transform: `translate3d(${n * step * side}px, ${drop}px, ${-n * BACK}px) rotate(${turn}deg)`,
              transformOrigin: '50% 100%', opacity: k,
              borderRadius: 12, background: g.color, overflow: 'hidden',
              border: '1.5px solid rgba(255,255,255,.3)', boxShadow: '0 6px 24px rgba(0,0,0,.45)',
              pointerEvents: 'none',
            }}
          >
            <PeekCard group={g} />
          </div>
        )
      })}
    </>
  )
}
