// DeckPeek — a stacked deck seen with an Alt-twist (utils/peek): the cards
// under its face fan out of it, a little turned, messy and stepping back,
// the opposite way to the turn: swung sideways they fan to the side, tipped
// they fan out above or below it, and between, between (Brian 2026-11-03). Drawn on the layers stage
// under the tilted world (ExplodedStrip's StripLayersStage), so the deck's
// own face hides what is right behind it. Nothing here is stored or pressed.

import React from 'react'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { standRise, useTiltStore } from '../../store/tiltStore'
import { cardFaceMedia } from '../../utils/cardGrid'
import { deckAreas } from '../../utils/peek'
import { HeroImageLayer } from '../Layers/HeroImageLayer'
import { headerExtend, overviewScale } from '../NLE/NLETimelineHeader'
import { storyWallOf } from '../Canvas/StorylineLayer'

/** How far each card sticks out past the one in front, as a share of the
 *  card's size along the fan, in the pose. */
const STEP = 0.36
/** However many cards, the pose reaches no further than this many card
 *  sizes out. */
const MOST = 1.5
/** Degrees of turn by which the pose has faded fully in. */
const FULL_AT = 25
/** Turning on past that, the pose opens a little more: at most this much
 *  wider, reached EXTRA_AT degrees further on. */
const EXTRA = 0.2
const EXTRA_AT = 40
/** How far back each card steps behind the one in front, as a share of the
 *  card's height, in the pose. */
const DEPTH = 0.06
/** How far each card turns, degrees, fanning like a hand of cards. */
const FAN_TURN = 6
/** The mess: up to this much extra turn (degrees) per card, and how far
 *  cards step off the line across the fan, alternately one way and the
 *  other (share of the card's size), so more of each picture shows (Brian
 *  2026-11-03: side by side, character art hid at the edges). Fixed for
 *  each card. */
const MESS_TURN = 3
const MESS_DRIFT = 0.1

/** Fanning up or down (looking from above or below), every other card
 *  also goes out to one side and the next to the other, each pair further
 *  out, so the room either side is used too (Brian 2026-11-04). As a share
 *  of the card's width per pair. */
const SPLIT = 0.35

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

export const DeckPeek: React.FC<{ anchorId: string }> = ({ anchorId }) => {
  const yaw = useTiltStore(s => Math.round(s.yaw * 10) / 10)
  const tilt = useTiltStore(s => Math.round(s.tilt * 10) / 10)
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const groups = useBoardsStore(s => s.groups)
  const area = deckAreas.get(anchorId)
  // Stood up on a storyline flipped up (TiltLayer stands the deck about the
  // wall's foot), the fan stands with it, turned up about the same line.
  const rise = useTiltStore(s => Math.round(standRise(s) * 200) / 200)
  const footY = storyWallOf(anchorId)
  const standing = footY !== null && rise > 0
  // Which way the fan goes: the opposite way to the turn on screen (swung
  // right, out to the left; tipped back, out below; tipped up, out above).
  // Standing, below is the floor: it fans out above instead.
  const vx = -yaw, vy = standing ? -Math.abs(tilt) : tilt
  const a = Math.hypot(vx, vy)
  const c = Math.min(1, a / FULL_AT), k = c * c * (3 - 2 * c)
  if (!area || k <= 0) return null
  const behind = area.memberIds.slice(1).map(id => groups.find(g => g.id === id)).filter(Boolean) as ProjectGroup[]
  if (!behind.length) return null
  const ux = vx / a, uy = vy / a
  const left = pan.x + area.x * zoom, top = pan.y + area.y * zoom
  const w = area.width * zoom, h = area.height * zoom
  // The card's size along the fan and across it.
  const along = Math.abs(ux) * w + Math.abs(uy) * h, across = Math.abs(uy) * w + Math.abs(ux) * h
  const open = k * (1 + EXTRA * Math.min(1, Math.max(0, a - FULL_AT) / EXTRA_AT))
  const step = Math.min(STEP, MOST / behind.length) * along * open
  const fan = (
    <>
      {behind.map((g, i) => ({ g, n: i + 1 })).reverse().map(({ g, n }) => {
        const alt = n % 2 ? 1 : -1, pair = Math.ceil(n / 2)
        const vert = Math.abs(uy)
        const turn = (n * FAN_TURN * ux + alt * pair * FAN_TURN * vert + jitter(g.id, 1) * MESS_TURN) * open
        const drift = ((n % 2 ? -1 : 1) * (0.6 + 0.4 * Math.abs(jitter(g.id, 2))) * MESS_DRIFT) * across * open
        const split = alt * pair * SPLIT * w * vert * open
        const x = n * step * ux - drift * uy + split, y = n * step * uy + drift * ux
        return (
          <div
            key={g.id}
            data-deck-peek={g.id}
            style={{
              position: 'absolute', left, top, width: w, height: h, boxSizing: 'border-box',
              transform: `translate3d(${x}px, ${y}px, ${-n * DEPTH * h * open}px) rotate(${turn}deg)`,
              transformOrigin: '50% 50%', opacity: k,
              borderRadius: 12, background: g.color, overflow: 'hidden',
              border: '1.5px solid rgba(255,255,255,.25)', boxShadow: '0 6px 32px rgba(0,0,0,.5)',
              pointerEvents: 'none',
            }}
          >
            <PeekCard group={g} head={headerExtend(zoom)} zoom={zoom} />
          </div>
        )
      })}
    </>
  )
  if (!standing) return fan
  return (
    <div style={{
      position: 'absolute', inset: 0, transformStyle: 'preserve-3d', pointerEvents: 'none',
      rotate: `x ${(-90 * rise).toFixed(2)}deg`, transformOrigin: `50% ${pan.y + footY! * zoom}px`,
    }}>{fan}</div>
  )
}
