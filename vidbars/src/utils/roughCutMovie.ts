// roughCutMovie.ts — the shots picked in a Rough Cut, out as one movie.
//
// Beside Deck of picks: the same picked shots, in the order they play, each
// with its trim, joined end to end into a single MP4 (a real file, in
// Videos\VidBars Movies) on a NEW card beside the Rough Cut. A picture is
// held for its length. The Rough Cut and its clips are not touched.
//
// The desktop side does the joining (electron/cutMovie.cjs, with ffmpeg),
// one shot at a time, so this can say how far along it is and stop.

import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { cardFaceSize, createMediaCard } from './cardGrid'
import { markNew } from './newCards'
import { placeCard } from './railCards'
import { diskFileUrl } from './diskUrl'
import { copyOf } from './sceneOut'
import { clipLength, clipRow, clipStart, placed, type RoughClip } from './roughCut'
import { findFreeSlotRightOf } from '../components/Viewport3D/ImageStudio'

export type MovieMade = { shots: number; path: string } | { error: string } | { stopped: true } | { none: true }

/** A clip's file on this computer, as a stored url: a file referenced in
 *  place as it is; media kept inside the project written out first. */
async function onDisk(c: RoughClip): Promise<string | null> {
  const url = c.kind === 'video' ? c.url : c.poster ?? c.url
  if (url.startsWith('/')) return url
  return copyOf(url, c.label, undefined)
}

/** Join the picked clips into one MP4 on a new card beside the Rough Cut.
 *  `note` says how it is going; `stopped` is asked between shots. */
export async function movieOfPicks(nodeId: string, stopped: () => boolean, note: (s: string) => void): Promise<MovieMade> {
  const node = useFreeNodeStore.getState().nodes[nodeId]
  if (!node?.roughCut) return { none: true }
  const picks = placed(node.roughCut.clips).filter(c => c.pick)
    .sort((a, b) => clipStart(a) - clipStart(b) || clipRow(a) - clipRow(b))
  if (!picks.length) return { none: true }
  const d = window.vidbarsDesktop
  if (!d?.cutMovieOpen || !d.cutMoviePart || !d.cutMovieClose) return { error: 'Movies are made in the VidBars desktop app (restart it if it is open)' }

  note('Opening the shots…')
  const parts: { url: string; still: boolean; in: number; len: number }[] = []
  for (let i = 0; i < picks.length; i++) {
    const c = picks[i]
    const url = await onDisk(c)
    if (!url) return { error: `Shot ${i + 1} (${c.label}) has no file on this computer` }
    const still = c.kind !== 'video'
    parts.push({ url, still, in: still ? 0 : c.in, len: clipLength(c) })
  }
  if (stopped()) return { stopped: true }
  const opened = await d.cutMovieOpen(parts)
  if ('error' in opened) return { error: opened.error }
  let closed = false
  try {
    for (let i = 0; i < parts.length; i++) {
      if (stopped()) return { stopped: true }
      note(`Making the movie: shot ${i + 1} of ${parts.length}…`)
      const r = await d.cutMoviePart(opened.id, i)
      // (Stopped while a shot was being made: its failing is the stop.)
      if (stopped()) return { stopped: true }
      if (r.error) return { error: `shot ${i + 1}: ${r.error}` }
    }
    note('Joining the shots…')
    closed = true
    const name = node.label?.trim() || 'Rough Cut'
    const out = await d.cutMovieClose(opened.id, name)
    if ('error' in out) return { error: out.error }

    // The movie on a new card in the first free spot right of the Rough Cut.
    const total = parts.reduce((a, p) => a + p.len, 0)
    const now = useFreeNodeStore.getState().nodes[nodeId] ?? node
    useUndoCoordinator.getState().checkpoint()
    const gid = createMediaCard({ cx: 0, cy: 0 }, [{ media: { url: diskFileUrl(out.path), type: 'video', duration: total }, label: name }])
    if (gid) {
      markNew([gid])
      const face = cardFaceSize()
      const slot = findFreeSlotRightOf({ x: now.x, y: now.y, width: now.width, height: now.height }, face.w, face.h)
      placeCard(gid, slot.x, slot.y)
      useBoardsStore.getState().setSelectedGroups([gid])
    }
    return { shots: parts.length, path: out.path }
  } finally {
    if (!closed) void d.cutMovieDrop?.(opened.id)
  }
}
