// Favourites. A card can be hearted, in two grades (Brian 2026-11-19): a
// heart says "in the running", a second heart on top says "the standout".
// The heart is the card's own: it goes wherever the card goes.
//
// What reads it:
//  - A closed deck's face and arrows show only its hearted cards, once any
//    card in it has a heart (utils/cardGrid deckFaceSteps). A deck with no
//    heart in it steps through every card, as it always did.
//  - favoriteOf(): the card that stands for a deck to whatever points at
//    the deck: its standout, else its first hearted card, else its front.
import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { isUndoRestoring, useUndoCoordinator } from '../store/undoCoordinator'
import { stackedDeckMembers } from './cardGrid'

export type Fav = 0 | 1 | 2

export function favOf(g: ProjectGroup | undefined): Fav {
  return g?.fav === 2 ? 2 : g?.fav === 1 ? 1 : 0
}

/** Give cards a grade (0 takes the heart off). The caller takes the undo
 *  checkpoint. */
export function setFav(ids: string[], level: Fav): void {
  const set = new Set(ids)
  useBoardsStore.setState(s => ({
    groups: s.groups.map(g => set.has(g.id) && !g.effect && favOf(g) !== level ? { ...g, fav: level || undefined } : g),
  }))
}

/** A press on a card's heart: none, a heart, the standout, none. Pressed on
 *  one of several selected cards, they all take the grade that card gets.
 *  One undo step. */
export function stepFav(id: string): void {
  const s = useBoardsStore.getState()
  const g = s.groups.find(x => x.id === id)
  if (!g) return
  const next = ((favOf(g) + 1) % 3) as Fav
  const sel = s.selectedGroupIds
  useUndoCoordinator.getState().checkpoint()
  setFav(sel.length > 1 && sel.includes(id) ? sel : [id], next)
}

/** The card that stands for a deck, of `ids` in deck order (front first):
 *  its first standout, else its first hearted card, else its front. */
export function favoriteOf(ids: string[], groups: ProjectGroup[]): ProjectGroup | undefined {
  const cards = ids.map(id => groups.find(g => g.id === id)).filter((g): g is ProjectGroup => !!g)
  return cards.find(g => favOf(g) === 2) ?? cards.find(g => favOf(g) === 1) ?? cards[0]
}

// A closed deck with hearts in it rests on a hearted card: when the card
// its face is on has none (a heart was just given elsewhere or taken off,
// or the deck has just closed), the face goes to the deck's first hearted
// card. Kept in the store, not worked out at each reader, because the 3D
// set, the Viewer and the loop strip all read the face card from there.
let settling = false
function settleDeckFaces(groups: ProjectGroup[]): void {
  if (settling || isUndoRestoring() || !groups.some(g => g.fav)) return
  const patch = new Map<string, string>()
  for (const a of groups) {
    if (a.deckState !== 'stacked' || (a.deckAnchorId && a.deckAnchorId !== a.id)) continue
    const members = stackedDeckMembers(a.id, groups).map(id => groups.find(g => g.id === id)!).filter(g => g && !g.effect)
    const hearted = members.filter(g => g.fav)
    if (!hearted.length) continue
    const on = members.find(g => g.id === a.deckFaceCard) ?? a
    if (!on.fav) patch.set(a.id, hearted[0].id)
  }
  if (!patch.size) return
  settling = true
  try {
    useBoardsStore.setState(s => ({ groups: s.groups.map(g => patch.has(g.id) ? { ...g, deckFaceCard: patch.get(g.id) } : g) }))
  } finally { settling = false }
}

let lastGroups: ProjectGroup[] | null = null
useBoardsStore.subscribe(s => {
  if (s.groups === lastGroups) return
  lastGroups = s.groups
  settleDeckFaces(s.groups)
})
