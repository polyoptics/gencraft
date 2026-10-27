// cardStrips.ts — cards (project groups) as the head of an effect strip.
//
// An effect card let go against a card's edge snaps flush to it, the way it
// does to a picture tile (stripSnap), and the card then reads as the
// strip's picture (useFxStrips): its FACE picture runs through the effects
// and the face shows the result (CardLayer). The face picture is whatever
// the card shows — its hero image, else the first picture in its blocks —
// so when the face changes, the strip follows it.
//
// A card is not a free tile, so it joins strips as a stand-in: an id that
// cannot collide with a tile's (`card:<group id>`), the card's footprint in
// canvas units, and its face picture as a source item. Nothing is stored;
// like the rest of the strip it is derived on every change.

import { useBoardsStore, type BoardData, type ProjectGroup } from '../../store/boardsStore'
import { getFirstImageUrl } from '../../types/bar'
import { getHiddenGroupIds } from '../../hooks/useCardDecks'
import { cardScreenRect } from '../../components/Layers/CardLayer'
import type { WindowRect } from '../viewportDocking'
import type { ChainItem } from './chain'

const PREFIX = 'card:'

/** The strip id a card goes by (its fx result and bypass are keyed by it). */
export const cardStripId = (groupId: string): string => PREFIX + groupId

/** The picture a card's face shows — what goes through its effects. The
 *  same choice as GroupCard's hero: the hero image, else the first picture
 *  in its blocks. */
export function cardFacePicture(g: ProjectGroup, boards: Record<string, BoardData>): string | null {
  if (g.cardHeroImage) return g.cardHeroImage
  for (const bid of g.boardIds) {
    const board = boards[bid]
    if (!board) continue
    for (const rid of board.rootIds) {
      const img = getFirstImageUrl(board.bars[rid]?.content)
      if (img) return img
    }
  }
  return null
}

export interface StripCard {
  id: string
  /** The card's footprint, canvas units. */
  rect: WindowRect
  item: Extract<ChainItem, { kind: 'source' }>
}

/** Every card that can head a strip: on the canvas (not pinned, not tucked
 *  inside a stacked deck) and showing a picture. */
export function stripCards(
  groups: ProjectGroup[] = useBoardsStore.getState().groups,
  boards: Record<string, BoardData> = useBoardsStore.getState().boards,
): StripCard[] {
  const hidden = getHiddenGroupIds(groups)
  const out: StripCard[] = []
  for (const g of groups) {
    if (g.pin || hidden.has(g.id)) continue
    const url = cardFacePicture(g, boards)
    if (!url) continue
    // The camera that draws canvas units 1:1 — what cardScreenRect gives
    // in canvas units (CLAUDE.md, invariant 3).
    const r = cardScreenRect(g, boards, { x: 0, y: 0 }, 1)
    if (!r || r.screenWidth <= 0) continue
    const id = cardStripId(g.id)
    out.push({
      id,
      rect: { id, x: r.screenLeft, y: r.screenTop, width: r.screenWidth, height: r.screenHeight },
      item: { id, kind: 'source', url, label: g.name || 'Card' },
    })
  }
  return out
}
