// DeckPeek — a stacked deck seen with an Alt-twist (utils/peek): the cards
// under its face spread out on the canvas, the way the view is turned and
// further the more it turns (Brian 2026-11-03), so a peek can look past
// whatever is beside the deck. Drawn on the layers stage
// under the tilted world (ExplodedStrip's StripLayersStage), so the deck's
// own face hides what is right behind it. Nothing here is stored or pressed.

import React from 'react'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useTiltStore } from '../../store/tiltStore'
import { cardFaceMedia } from '../../utils/cardGrid'
import { deckAreas } from '../../utils/peek'
import { HeroImageLayer } from '../Layers/HeroImageLayer'

/** How far each card steps out from the one in front, as a share of the
 *  card's size, at a full peek. */
const STEP = 0.45
/** However many cards, the whole spread reaches no further than this many
 *  card sizes at a full peek. */
const MOST = 2.4
/** Degrees of turn for a full peek; twisting further spreads them on, up to
 *  FURTHEST times as wide. */
const FULL_AT = 30
const FURTHEST = 2.2
/** The little depth each card sits behind the one in front, px. */
const BACK = 3

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

/** How far the view is turned, as a screen direction: swung right spreads
 *  left, tipped back spreads down (Brian 2026-11-03: the other way read
 *  backwards). The spread goes that way, so a peek can look past whatever
 *  is on that side of the deck. */
function turned(s: { tilt: number; yaw: number }): { x: number; y: number; k: number } {
  const x = -s.yaw, y = s.tilt
  const a = Math.hypot(x, y)
  if (a < 0.01) return { x: 0, y: 0, k: 0 }
  return { x: x / a, y: y / a, k: Math.min(FURTHEST, a / FULL_AT) }
}

export const DeckPeek: React.FC<{ anchorId: string }> = ({ anchorId }) => {
  const tilt = useTiltStore(s => Math.round(s.tilt * 10) / 10)
  const yaw = useTiltStore(s => Math.round(s.yaw * 10) / 10)
  const turn = turned({ tilt, yaw })
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const groups = useBoardsStore(s => s.groups)
  const area = deckAreas.get(anchorId)
  if (!area || turn.k <= 0) return null
  const behind = area.memberIds.slice(1).map(id => groups.find(g => g.id === id)).filter(Boolean) as ProjectGroup[]
  if (!behind.length) return null
  const left = pan.x + area.x * zoom, top = pan.y + area.y * zoom
  const w = area.width * zoom, h = area.height * zoom
  // On the canvas plane, along the turn: each card a step further out.
  const step = Math.min(STEP, MOST / behind.length) * turn.k
  const dx = turn.x * w * step, dy = turn.y * h * step
  return (
    <>
      {behind.map((g, i) => ({ g, n: i + 1 })).reverse().map(({ g, n }) => (
        <div
          key={g.id}
          data-deck-peek={g.id}
          style={{
            position: 'absolute', left, top, width: w, height: h, boxSizing: 'border-box',
            transform: `translate3d(${n * dx}px, ${n * dy}px, ${-n * BACK}px)`,
            borderRadius: 12, background: g.color, overflow: 'hidden',
            border: '1.5px solid rgba(255,255,255,.3)', boxShadow: '0 6px 24px rgba(0,0,0,.45)',
            pointerEvents: 'none',
          }}
        >
          <PeekCard group={g} />
        </div>
      ))}
    </>
  )
}
