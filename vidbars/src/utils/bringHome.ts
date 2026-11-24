// Bringing a made card home (Brian 2026-11-19: "have the one I pick from
// the generation window end up in the character's card deck as a card.
// Have the character then get the model detail and fill it in with that
// model, or, if it's already got it... ask to override it").
//
// A card made from another (a model from a character's picture, a
// processed picture, a movie) joins the deck of the card it was made
// from, and that card's back gets a detail that shows it. General: any
// card, any kind of result, any detail name. Nothing here decides what
// the result is for.
//
//  - The deck: the made card goes BEHIND the card it was made from, as a
//    small closed deck of the two where that card stands (Brian
//    2026-11-20), or into the closed deck that card fronts already. A
//    card in a bigger deck keeps its place in it; no lock changes.
//  - The detail: named by the caller, else after what the made card holds.
//    A detail of that name that already shows another card is left as it
//    is unless `replace` is given: the caller asks the artist first.
import { detailLinked } from './linkEvents'
import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { cardVisualRect, expandWithNestedMembers, isHiddenDeckMember } from '../hooks/useCardDecks'
import { faceBlocks } from './cardGrid'
import { detailShown, newDetailId, type CardDetail } from './cardTypes'
import { getMediaItems } from '../types/bar'
import { modelOfCard } from './area3dScene'
import { putAwayUnder, isShut } from './deckTree'

const TOUCH_GAP = 8

/** A detail name for what card `g` holds. */
export function detailNameFor(g: ProjectGroup, boards: Record<string, BoardData>): string {
  // A card with a 3D model in it is that model's card, even with a
  // picture of it in front.
  if (modelOfCard(g, boards)) return 'Model'
  const bid = faceBlocks(g, boards)[0]
  const b = bid ? boards[bid] : undefined
  const m = b?.rootIds.flatMap(rid => getMediaItems(b.bars[rid]?.content)).find(it => it.type === 'model' || it.type === 'image' || it.type === 'video')
  return m?.type === 'model' ? 'Model' : m?.type === 'video' ? 'Movie' : m?.type === 'image' ? 'Image' : 'Result'
}

export interface BroughtHome {
  /** How the made cards joined: behind their card as a small closed deck of
   *  its own (new, or one it had inside a bigger deck), or into the closed
   *  deck that card already fronts. */
  deck: 'closed' | 'behind'
  detail: string
  /** filled: the detail now shows the made card. kept: it already showed
   *  another card and was left (ask, then call again with replace). same:
   *  it already showed this card. */
  did: 'filled' | 'replaced' | 'kept' | 'same'
  /** What the detail showed before, when it showed a card. */
  had?: string
}

/** Bring `madeIds` home to card `sourceId`. The caller takes the undo
 *  checkpoint. */
export function bringHome(sourceId: string, madeIds: string[], opts: { detail?: string; replace?: boolean; front?: boolean } = {}): BroughtHome | null {
  const bs = () => useBoardsStore.getState()
  const source = bs().groups.find(g => g.id === sourceId)
  const ids = madeIds.filter(id => id !== sourceId && bs().groups.some(g => g.id === id))
  if (!source || !ids.length) return null
  const zoom = useCanvasStore.getState().zoom
  const rectOf = (id: string) => {
    const g = bs().groups.find(x => x.id === id)
    return (g && cardVisualRect(g, bs().boards, zoom)?.rect) || null
  }
  // Out of whatever closed deck they were dealt in, to be put where they go.
  for (const id of ids) {
    const g = bs().groups.find(o => o.id === id)!
    if (isHiddenDeckMember(g)) { bs().extractFromDeck(id, g.originX, g.originY); bs().severDeckTether(id) }
    else if (g.deckState && g.deckState !== 'open') bs().setDeckState(expandWithNestedMembers([id], bs().groups), 'open')
  }
  const moveTo = (id: string, left: number, top: number) => {
    const g = bs().groups.find(o => o.id === id), r = rectOf(id)
    if (g && r) bs().setGroupPosBatch([{ groupId: id, originX: g.originX + left - r.left, originY: g.originY + top - r.top }])
  }

  // The deck: behind the card it was made from (Brian 2026-11-20). That
  // card's own closed deck takes it; a card with none becomes the front of
  // a small closed deck of the two, where it stands, also inside a bigger
  // deck, open or closed. Nothing else moves and no lock is touched: the
  // made card is simply held by the locks its card is held by.
  const shut = isShut
  const inner = putAwayUnder(source.id, bs().groups).map(g => g.id)
  const mine = rectOf(source.id)
  if (mine) {
    // Past the far end of where its cards lie when open, on its line, so
    // its deck opens as one clean row.
    let x = Math.max(mine.right, ...inner.map(rectOf).filter((m): m is NonNullable<typeof m> => !!m).map(m => m.right)) + TOUCH_GAP
    for (const id of ids) {
      moveTo(id, x, mine.top)
      const m = rectOf(id)
      x += (m ? m.right - m.left : 0) + TOUCH_GAP
    }
  }
  let deck: BroughtHome['deck'] = 'behind'
  if (isHiddenDeckMember(source)) {
    // Put away in a closed deck: it fronts a deck of its own inside that
    // one (a deck in a deck, as setDeckState leaves one), or has one
    // already. Written here, not through setDeckState, which would take
    // the card out of the deck it is in.
    const state = inner.length ? source.deckState! : 'stacked'
    const made = new Set(ids)
    useBoardsStore.setState(s => {
      const front = s.groups.find(g => g.id === source.id)!
      return { groups: s.groups.map(g => g.id === front.id ? { ...g, deckState: state, nestedDeck: true }
        : made.has(g.id) ? { ...g, deckState: state, deckAnchorId: front.id, nestedDeck: undefined, deckOffsetX: g.originX - front.originX, deckOffsetY: g.originY - front.originY, deckLastFront: undefined }
        : g) }
    })
  } else if (shut(source)) {
    // The front of a closed deck: into that deck.
    bs().setDeckState([source.id, ...inner, ...ids], source.deckState!, { asGiven: true })
    deck = 'closed'
  } else {
    // Open, alone or in a row: a small closed deck where it stands.
    bs().setDeckState([source.id, ...ids], 'stacked', { asGiven: true })
  }
  // Held by what holds its card: a locked or kept deck keeps the card made
  // from one of its cards, and stays as it was.
  if (source.deckLock || source.deckKeep) {
    const made = new Set(ids)
    useBoardsStore.setState(s => ({ groups: s.groups.map(g => made.has(g.id) ? { ...g, ...(source.deckLock ? { deckLock: source.deckLock } : {}), ...(source.deckKeep ? { deckKeep: source.deckKeep } : {}) } : g) }))
  }

  // The detail.
  const made = bs().groups.find(g => g.id === ids[0])!
  const name = (opts.detail ?? '').trim() || detailNameFor(made, bs().boards)
  const details: CardDetail[] = [...(bs().groups.find(g => g.id === sourceId)?.details ?? [])]
  const k = details.findIndex(d => d.name.trim().toLowerCase() === name.toLowerCase())
  const old = k >= 0 ? details[k] : undefined
  const oldCard = old?.link && !old.link.detail && !old.link.count && !old.link.rankOf ? detailShown(bs().groups, old).card : undefined
  const had = oldCard && oldCard.id !== made.id ? oldCard.name || 'Untitled' : undefined
  if (old?.link?.card === made.id && !old.link.detail) { ownModelUnlink(sourceId, made.id); return { deck, detail: old.name, did: 'same' } }
  if (had && !opts.replace) return { deck, detail: old!.name, did: 'kept', had }
  const front = opts.front ?? (old ? !!old.onFace || !old.link : true)
  const row: CardDetail = { ...(old ?? { id: newDetailId(), name, value: '' }), link: { card: made.id }, ...(front ? { onFace: true as const } : {}) }
  if (!front) delete row.onFace
  if (k >= 0) details[k] = row; else details.push(row)
  bs().setGroupDetails(sourceId, details)
  detailLinked(sourceId, made.id)
  ownModelUnlink(sourceId, made.id)
  return { deck, detail: row.name, did: had ? 'replaced' : 'filled', ...(had ? { had } : {}) }
}

/** A card's own 3D model is shown by its Model detail, not by a link chip
 *  on its face as well (Brian 2026-11-23: "since they are the model of the
 *  object, we don't need to see this sort of card-colored link on the
 *  front"). The card-to-card link between card `cardId` and the 3D model
 *  card its detail now shows is taken off, whichever of the two holds it.
 *  Only a card holding a 3D model: any other made card keeps its link. */
function ownModelUnlink(cardId: string, modelCardId: string) {
  const s = useBoardsStore.getState()
  const from = s.groups.find(g => g.id === modelCardId)
  if (!from || !modelOfCard(from, s.boards)) return
  s.unlinkGroups(cardId, modelCardId)
  s.unlinkGroups(modelCardId, cardId)
}

/** Card `cardId`'s Model detail shows the 3D model card `modelCardId`. */
export function showsAsModel(cardId: string, modelCardId: string): boolean {
  const card = useBoardsStore.getState().groups.find(g => g.id === cardId)
  return !!card?.details?.some(d => d.name.trim().toLowerCase() === 'model' && d.link?.card === modelCardId && !d.link.detail)
}

/** A 3D model card linked onto card `cardId` by hand (its "+" let go on the
 *  card): a card with no Model detail gets one, showing that 3D model and
 *  switched on for the front (Brian 2026-11-23: "If I link a model onto a
 *  card and it has no model slot, then it will get a model slot. That model
 *  will go into it, and that will go on front"). A Model detail that shows
 *  nothing yet is filled the same way; one that already shows a card is
 *  left as it is. The same detail bring_home fills for a generated one.
 *  The caller takes the undo step. True when the detail was written. */
export function fillModelDetail(cardId: string, modelCardId: string): boolean {
  const s = useBoardsStore.getState()
  const card = s.groups.find(g => g.id === cardId), from = s.groups.find(g => g.id === modelCardId)
  if (!card || !from || card.id === from.id || !modelOfCard(from, s.boards)) return false
  const details: CardDetail[] = [...(card.details ?? [])]
  const k = details.findIndex(d => d.name.trim().toLowerCase() === 'model')
  if (k >= 0 && details[k].link) return false
  const row: CardDetail = { ...(k >= 0 ? details[k] : { id: newDetailId(), name: 'Model', value: '' }), link: { card: from.id }, onFace: true }
  if (k >= 0) details[k] = row; else details.push(row)
  s.setGroupDetails(cardId, details)
  detailLinked(cardId, from.id)
  return true
}
