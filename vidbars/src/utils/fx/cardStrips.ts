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
import { useCanvasStore } from '../../store/canvasStore'
import { cardFaceMedia } from '../cardGrid'
import { getHiddenGroupIds } from '../../hooks/useCardDecks'
import { cardScreenRect } from '../../components/Layers/CardLayer'
import type { WindowRect } from '../viewportDocking'
import type { ChainItem } from './chain'
import { knownKind } from './effects'

const PREFIX = 'card:'

/** The strip id a card goes by (its fx result and bypass are keyed by it). */
export const cardStripId = (groupId: string): string => PREFIX + groupId

/** The picture a card's face shows — what goes through its effects: the
 *  face GroupCard draws (utils/cardGrid's cardFaceMedia), a video face as
 *  its poster frame. Step the face and the effects follow. */
export function cardFacePicture(g: ProjectGroup, boards: Record<string, BoardData>): string | null {
  const m = cardFaceMedia(g, boards)
  return m ? (m.type === 'image' ? m.url : m.posterUrl ?? null) : null
}

export interface StripCard {
  id: string
  /** The card's footprint, canvas units. */
  rect: WindowRect
  /** A picture card's face as a source; an effect card (utils/effectCards)
   *  as its effect. */
  item: ChainItem
}

/** Every card on a strip: a picture card (its face picture as the source)
 *  or an effect card (its effect), on the canvas and not pinned. A card
 *  tucked inside a collapsed deck counts only with `tucked`: still read in
 *  place — a deck's members keep their open layout as it moves — so a
 *  collapsed row keeps processing, but never a target to snap onto. */
export function stripCards(
  groups: ProjectGroup[] = useBoardsStore.getState().groups,
  boards: Record<string, BoardData> = useBoardsStore.getState().boards,
  zoom: number = useCanvasStore.getState().zoom,
  tucked = false,
): StripCard[] {
  const hidden = tucked ? new Set<string>() : getHiddenGroupIds(groups)
  const out: StripCard[] = []
  for (const g of groups) {
    if (g.pin || hidden.has(g.id)) continue
    const url = g.effect ? null : cardFacePicture(g, boards)
    if (!url && !g.effect) continue
    // The card as it is DRAWN at this zoom, in canvas units: its title band
    // is a screen-px band (headerExtend), so it is taller in canvas units
    // the further out the camera is. Measured at zoom 1 instead, an effect
    // snapped to the card's top sat below the top that shows.
    const r = cardScreenRect(g, boards, { x: 0, y: 0 }, zoom)
    if (!r || r.screenWidth <= 0 || zoom <= 0) continue
    const id = cardStripId(g.id)
    out.push({
      id,
      rect: { id, x: r.screenLeft / zoom, y: r.screenTop / zoom, width: r.screenWidth / zoom, height: r.screenHeight / zoom },
      item: g.effect
        ? { id, kind: 'effect', effect: knownKind(g.effect.kind), params: g.effect.params, text: g.effect.text }
        : { id, kind: 'source', url: url!, label: g.name || 'Card' },
    })
  }
  return out
}
