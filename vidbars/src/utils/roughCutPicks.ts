// roughCutPicks.ts — the shots picked in a Rough Cut, out as a deck.
//
// Play through, press P on the shots worth keeping (clip.pick), and Deck of
// picks lays them out under the Rough Cut as cards in the order they play,
// closed into a locked deck. Each card keeps its clip's trim.

import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { cardFaceSize, createMediaCard } from './cardGrid'
import { markNew } from './newCards'
import { clipAt, clipMedia, clipRow, clipStart, placed, setRoughCut, type RoughClip } from './roughCut'
import { getClipFrame } from './clipFrames'
import type { MediaItem } from '../types/bar'

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
    const id = createMediaCard({ cx: x0 + n * face.w, cy: y0 }, [{ media: clipOutMedia(c), label: c.label }])
    if (id) made.push(id)
  })
  // Closed and locked, so it is its own deck: nothing snaps onto it or joins it where it lands.
  if (made.length > 1) {
    useBoardsStore.getState().setDeckState(made, 'stacked')
    useBoardsStore.getState().setRowPrimary(made[0], made)
    useBoardsStore.getState().setDeckLock(made[0], made)
  }
  markNew(made)
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

/** Where a clip's picture is taken: just inside its in point. */
export const shotFrameTime = (c: RoughClip) => Math.min(c.in + 0.02, Math.max(c.in, c.out - 0.02))

/** A clip as a card's media (its trim kept), with its own first frame as the
 *  card's poster when that has been made. */
export function clipOutMedia(c: RoughClip): MediaItem {
  const m = clipMedia(c)
  if (c.kind !== 'video') return m
  const frame = getClipFrame(c.url, shotFrameTime(c))
  return frame ? { ...m, posterUrl: frame } : m
}
