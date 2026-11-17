// roughCutPicks.ts — the shots picked in a Rough Cut, out as a deck.
//
// Play through, press P on the shots worth keeping (clip.pick), and Deck of
// picks lays them out as cards in the order they play, closed into a locked
// deck docked along the Rough Cut's foot: touching it, in the first free
// spot from its left, so it is found where it was made and goes where the
// Rough Cut goes (Brian 2026-11-17). Each card keeps its clip's trim.

import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { cardFaceSize, createMediaCard } from './cardGrid'
import { markNew } from './newCards'
import { placeCard } from './railCards'
import { isHiddenDeckMember } from '../hooks/useCardDecks'
import { drawnRect } from './effectCards'
import { viewportVisualRect } from './viewportDocking'
import { useCanvasStore } from '../store/canvasStore'
import { useViewport3DStore } from '../store/viewport3dStore'
import { clipAt, clipMedia, clipRow, clipStart, placed, setRoughCut, type RoughClip, type RoughCutData } from './roughCut'
import { getClipFrame } from './clipFrames'
import type { MediaItem } from '../types/bar'

type Box = { x: number; y: number; width: number; height: number }

/** Lay the picked clips out as a deck docked under the Rough Cut. Returns how many cards were made. */
export function deckOfPicks(nodeId: string): number {
  const node = useFreeNodeStore.getState().nodes[nodeId]
  if (!node?.roughCut) return 0
  const picks = placed(node.roughCut.clips).filter(c => c.pick)
    .sort((a, b) => clipStart(a) - clipStart(b) || clipRow(a) - clipRow(b))
  if (!picks.length) return 0
  useUndoCoordinator.getState().checkpoint()
  const face = cardFaceSize()
  // Made below the Rough Cut, then docked (below).
  const x0 = node.x + face.w / 2
  const y0 = node.y + node.height + face.h + face.h / 2
  // What is in the way along the foot: the cards and Viewers there now.
  const zoom = useCanvasStore.getState().zoom
  const before = useBoardsStore.getState()
  const taken: Box[] = [
    // (Not a card put away in a closed deck: it is in that deck, wherever it lies.)
    ...before.groups.flatMap(g => { const r = g.pin || isHiddenDeckMember(g) ? null : drawnRect(g, before.boards, zoom); return r ? [r] : [] }),
    ...Object.values(useViewport3DStore.getState().windows).filter(w => !w.pin).map(w => viewportVisualRect(w, zoom)),
  ]
  const made: string[] = []
  picks.forEach((c, n) => {
    const id = createMediaCard({ cx: x0 + n * face.w, cy: y0 }, [{ media: clipOutMedia(c, node.roughCut?.frame), label: c.label }])
    if (id) made.push(id)
  })
  // Closed and locked, so it is its own deck: nothing snaps onto it or joins it where it lands.
  if (made.length > 1) {
    useBoardsStore.getState().setDeckState(made, 'stacked')
    useBoardsStore.getState().setRowPrimary(made[0], made)
    useBoardsStore.getState().setDeckLock(made[0], made)
  }
  // Docked: its top on the Rough Cut's foot, in the first free spot from the left.
  if (made[0]) {
    const now = useBoardsStore.getState()
    const g = now.groups.find(x => x.id === made[0])
    const r = g ? drawnRect(g, now.boards, zoom) : null
    if (r) {
      const top = node.y + node.height
      const gap = Math.max(16, r.width * 0.08)
      const hits = (x: number) => taken.some(o => !(x + r.width + gap <= o.x || o.x + o.width + gap <= x || top + r.height <= o.y || o.y + o.height <= top))
      let x = node.x
      for (let i = 0; i < 40 && hits(x); i++) x += r.width + gap
      if (hits(x)) x = node.x
      placeCard(made[0], x, top)
    }
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
export function clipOutMedia(c: RoughClip, cutFrame?: RoughCutData['frame']): MediaItem {
  const m = clipMedia(c, cutFrame)
  if (c.kind !== 'video') return m
  const frame = getClipFrame(c.url, shotFrameTime(c))
  return frame ? { ...m, posterUrl: frame } : m
}
