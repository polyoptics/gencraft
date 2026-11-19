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
//  - The deck: a closed or fanned deck takes the made cards in; an open
//    row, or a card lying alone, gets them touching its right end (cards
//    that touch are a deck).
//  - The detail: named by the caller, else after what the made card holds.
//    A detail of that name that already shows another card is left as it
//    is unless `replace` is given: the caller asks the artist first.
import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { cardVisualRect, expandWithNestedMembers, isHiddenDeckMember } from '../hooks/useCardDecks'
import { faceBlocks } from './cardGrid'
import { detailShown, newDetailId, type CardDetail } from './cardTypes'
import { rowOf } from './primaryCard'
import { getMediaItems } from '../types/bar'

const TOUCH_GAP = 8

/** A detail name for what card `g` holds on its face. */
export function detailNameFor(g: ProjectGroup, boards: Record<string, BoardData>): string {
  const bid = faceBlocks(g, boards)[0]
  const b = bid ? boards[bid] : undefined
  const m = b?.rootIds.flatMap(rid => getMediaItems(b.bars[rid]?.content)).find(it => it.type === 'model' || it.type === 'image' || it.type === 'video')
  return m?.type === 'model' ? 'Model' : m?.type === 'video' ? 'Movie' : m?.type === 'image' ? 'Image' : 'Result'
}

export interface BroughtHome {
  /** How the made cards joined: into the closed deck, or beside the open row / lone card. */
  deck: 'closed' | 'beside'
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

  // The deck.
  const anchorId = source.deckState && source.deckState !== 'open' ? (isHiddenDeckMember(source) ? source.deckAnchorId! : source.id) : null
  const anchor = anchorId ? bs().groups.find(g => g.id === anchorId) : undefined
  let deck: BroughtHome['deck'] = 'beside'
  if (anchor && anchor.deckState && anchor.deckState !== 'open') {
    // Into the closed deck.
    const state = anchor.deckState
    const members = bs().groups.filter(g => g.id !== anchor.id && g.deckAnchorId === anchor.id && g.deckState && g.deckState !== 'open').map(g => g.id)
    // Past the far end of where its cards lie when open, on the front
    // card's line, so the deck opens as one clean row.
    const r = rectOf(anchor.id)
    if (r) {
      let x = Math.max(r.right, ...members.map(rectOf).filter((m): m is NonNullable<typeof m> => !!m).map(m => m.right)) + TOUCH_GAP
      for (const id of ids) {
        moveTo(id, x, r.top)
        const m = rectOf(id)
        x += (m ? m.right - m.left : 0) + TOUCH_GAP
      }
    }
    bs().setDeckState([anchor.id, ...members, ...ids], state, { asGiven: true })
    deck = 'closed'
  } else {
    // Touching the right end of its row (or of the card alone), on its line.
    const row = (rowOf(source.id) ?? [source.id]).map(rectOf).filter((r): r is NonNullable<typeof r> => !!r)
    const mine = rectOf(source.id)
    if (mine) {
      let x = Math.max(mine.right, ...row.filter(r => r.top < mine.bottom && r.bottom > mine.top).map(r => r.right)) + TOUCH_GAP
      for (const id of ids) {
        moveTo(id, x, mine.top)
        const r = rectOf(id)
        x += (r ? r.right - r.left : 0) + TOUCH_GAP
      }
    }
  }

  // The detail.
  const made = bs().groups.find(g => g.id === ids[0])!
  const name = (opts.detail ?? '').trim() || detailNameFor(made, bs().boards)
  const details: CardDetail[] = [...(bs().groups.find(g => g.id === sourceId)?.details ?? [])]
  const k = details.findIndex(d => d.name.trim().toLowerCase() === name.toLowerCase())
  const old = k >= 0 ? details[k] : undefined
  const oldCard = old?.link && !old.link.detail && !old.link.count && !old.link.rankOf ? detailShown(bs().groups, old).card : undefined
  const had = oldCard && oldCard.id !== made.id ? oldCard.name || 'Untitled' : undefined
  if (old?.link?.card === made.id && !old.link.detail) return { deck, detail: old.name, did: 'same' }
  if (had && !opts.replace) return { deck, detail: old!.name, did: 'kept', had }
  const front = opts.front ?? (old ? !!old.onFace || !old.link : true)
  const row: CardDetail = { ...(old ?? { id: newDetailId(), name, value: '' }), link: { card: made.id }, ...(front ? { onFace: true as const } : {}) }
  if (!front) delete row.onFace
  if (k >= 0) details[k] = row; else details.push(row)
  bs().setGroupDetails(sourceId, details)
  return { deck, detail: row.name, did: had ? 'replaced' : 'filled', ...(had ? { had } : {}) }
}
