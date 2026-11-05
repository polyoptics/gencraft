// roughCutPicks.ts — the shots picked in a Rough Cut, out as a deck.
//
// Play through, press P on the shots worth keeping (clip.pick), and Deck of
// picks lays them out under the Rough Cut as cards side by side, touching,
// in the order they play: a deck. Each card keeps its clip's trim.

import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { cardFaceSize, createMediaCard } from './cardGrid'
import { clipAt, clipMedia, clipRow, clipStart, placed, setRoughCut } from './roughCut'

/** Lay the picked clips out as a deck under the Rough Cut. Returns how many cards were made. */
export function deckOfPicks(nodeId: string): number {
  const node = useFreeNodeStore.getState().nodes[nodeId]
  if (!node?.roughCut) return 0
  const picks = placed(node.roughCut.clips).filter(c => c.pick)
    .sort((a, b) => clipStart(a) - clipStart(b) || clipRow(a) - clipRow(b))
  if (!picks.length) return 0
  useUndoCoordinator.getState().checkpoint()
  const face = cardFaceSize()
  // A card's height clear of the Rough Cut, so the deck is its own.
  const x0 = node.x + face.w / 2
  const y0 = node.y + node.height + face.h + face.h / 2
  const made: string[] = []
  picks.forEach((c, n) => {
    const id = createMediaCard({ cx: x0 + n * face.w, cy: y0 }, [{ media: clipMedia(c), label: c.label }])
    if (id) made.push(id)
  })
  useBoardsStore.getState().setSelectedGroups(made)
  return made.length
}

/** Pick or unpick the shot being watched: the one seen at time t. */
export function togglePickAt(nodeId: string, t: number): void {
  const node = useFreeNodeStore.getState().nodes[nodeId]
  if (!node?.roughCut) return
  const clips = placed(node.roughCut.clips)
  const c = clipAt(clips, t)?.clip
  if (!c) return
  setRoughCut(nodeId, { clips: clips.map(x => (x.id === c.id ? { ...x, pick: !x.pick } : x)) })
}
