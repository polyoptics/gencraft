// DeckPeek — a stacked deck seen with an Alt-twist (utils/peek): the cards
// under its face pull back behind it and shuffle off to the side, like the
// fan, so a quick swing shows what is in the deck. Drawn on the layers stage
// under the tilted world (ExplodedStrip's StripLayersStage), so the deck's
// own face hides what is right behind it. Nothing here is stored or pressed.

import React from 'react'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useTiltStore } from '../../store/tiltStore'
import { cardFaceMedia } from '../../utils/cardGrid'
import { deckAreas } from '../../utils/peek'
import { HeroImageLayer } from '../Layers/HeroImageLayer'
import { layerFan } from './ExplodedStrip'

/** How far back each card steps, as a share of the card's height. */
const STEP_BACK = 0.18
/** How far to the side each card steps, as a share of the card's width. */
const STEP_SIDE = 0.3
/** However many cards, the whole fan reaches no further than this many card
 *  widths to the side. */
const MOST_SIDE = 1.6

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

export const DeckPeek: React.FC<{ anchorId: string }> = ({ anchorId }) => {
  const fan = useTiltStore(layerFan)
  const side = useTiltStore(s => (s.yaw < 0 ? 1 : -1))
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const groups = useBoardsStore(s => s.groups)
  const area = deckAreas.get(anchorId)
  if (!area || fan <= 0) return null
  const behind = area.memberIds.slice(1).map(id => groups.find(g => g.id === id)).filter(Boolean) as ProjectGroup[]
  if (!behind.length) return null
  const left = pan.x + area.x * zoom, top = pan.y + area.y * zoom
  const w = area.width * zoom, h = area.height * zoom
  const stepX = Math.min(STEP_SIDE, MOST_SIDE / behind.length) * w * fan * side
  const stepZ = Math.min(STEP_BACK, (MOST_SIDE * STEP_BACK / STEP_SIDE) / behind.length) * h * fan
  // The last card furthest back: drawn first.
  return (
    <>
      {behind.map((g, i) => ({ g, n: i + 1 })).reverse().map(({ g, n }) => (
        <div
          key={g.id}
          data-deck-peek={g.id}
          style={{
            position: 'absolute', left, top, width: w, height: h, boxSizing: 'border-box',
            transform: `translate3d(${n * stepX}px, 0, ${-n * stepZ}px)`,
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
