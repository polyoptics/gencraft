// A storyline flipped up in the tilted view stands as a wall on its foot,
// a level line fixed while it stands (StorylineLayer frozenFeet). Its dots
// are never dragged below that foot; nor are the cards standing on it:
// dragged below, a card was drawn sunk into the floor (2026-11-05 check of
// card and deck actions on a stood-up storyline).

import { useBoardsStore } from '../store/boardsStore'
import { boundsOf } from '../store/canvasStore'
import { useTiltStore, isTilted, standRise } from '../store/tiltStore'
import { isHiddenDeckMember } from '../hooks/useCardDecks'

/** The canvas y of the foot of the wall a card stands on, or null
 *  (StorylineLayer storyWallOf, which hands itself in here: imported from
 *  there, a card's name band module pulled the whole storyline layer in
 *  early and the app failed to load). */
let storyWallOf: (groupId: string) => number | null = () => null
export function setStoryWallOf(f: (groupId: string) => number | null) { storyWallOf = f }

/** How far down (canvas units) the cards being dragged can move together,
 *  from where they were pressed (`origins`), before one standing on a
 *  storyline's wall would go below its foot: Infinity when none stands on
 *  one (flat, every card), and never less than 0 (one already lower is not
 *  pulled up). Asked on every move: a card pulled off the wall (out of its
 *  row) is free on the floor from then on, as flat; one that joins a row on
 *  the wall is held at its foot. */
export function wallRoom(origins: Map<string, { x: number; y: number }>): number {
  const ts = useTiltStore.getState()
  if (!isTilted(ts) || standRise(ts) <= 0) return Infinity
  const { groups, boards } = useBoardsStore.getState()
  const byId = new Map(groups.map(g => [g.id, g]))
  let room = Infinity
  for (const [id, o] of origins) {
    const g = byId.get(id)
    // A card hidden in a closed deck is not drawn: its deck's front is.
    if (!g || g.pin || isHiddenDeckMember(g)) continue
    const foot = storyWallOf(id)
    if (foot === null) continue
    const b = boundsOf({ ...g, originX: o.x, originY: o.y }, boards)
    if (!b) continue
    room = Math.min(room, foot - (b.y + Math.max(b.h, g.cardHeightOverride ?? 0)))
  }
  return Math.max(0, room)
}
