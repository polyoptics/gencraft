// makeMovie.ts — a run of shots, end to end, as one MP4 on a NEW card.
//
// A deck's shots (right-click, as a looping GIF is made: utils/makeGif):
// each movie plays its trimmed part, each picture is held, in order, joined
// into a single
// MP4 — a real file, in Videos\VidBars Movies — on a new card in the first
// free spot right of where it came from. What it was made from is not touched.
//
// The desktop side does the joining (electron/cutMovie.cjs, with ffmpeg),
// one shot at a time, so this can say how far along it is and stop.

import { useBoardsStore } from '../store/boardsStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import type { MediaItem } from '../types/bar'
import { cardFaceSize, createMediaCard } from './cardGrid'
import { markNew } from './newCards'
import { placeCard } from './railCards'
import { diskFileUrl } from './diskUrl'
import { copyOf } from './sceneOut'
import { findFreeSlotRightOf } from '../components/Viewport3D/ImageStudio'

export type MovieMade = { shots: number; path: string } | { error: string } | { stopped: true } | { none: true }
export type Box = { x: number; y: number; width: number; height: number }

/** How long a still picture is held when it has no length of its own (as in a GIF). */
const STILL_SECONDS = 1.5

/** A shot's file on this computer, as a stored url: a file referenced in
 *  place as it is; media kept inside the project written out first. */
async function onDisk(m: MediaItem, label: string): Promise<string | null> {
  if (m.url.startsWith('/')) return m.url
  return copyOf(m.url, label, m.originalName)
}

/** Join `shots` (movies and pictures, in order) into one MP4 named `name`, on
 *  a new card in the first free spot right of `beside()` (asked when it is
 *  done). `note` says how it is going; `stopped` is asked between shots. */
export async function makeMovie(shots: MediaItem[], name: string, beside: () => Box | null,
  stopped: () => boolean, note: (s: string) => void): Promise<MovieMade> {
  const use = shots.filter(m => m.type === 'video' || m.type === 'image')
  if (!use.length) return { none: true }
  const d = window.vidbarsDesktop
  if (!d?.cutMovieOpen || !d.cutMoviePart || !d.cutMovieClose) return { error: 'Movies are made in the VidBars desktop app (restart it if it is open)' }

  note('Opening the shots…')
  const parts: { url: string; still: boolean; in: number; len: number; fill?: boolean }[] = []
  for (let i = 0; i < use.length; i++) {
    const m = use[i]
    const url = await onDisk(m, name)
    if (!url) return { error: `shot ${i + 1} has no file on this computer` }
    if (m.type === 'video') {
      const from = Math.max(0, m.clipIn ?? 0)
      const to = m.clipOut ?? m.duration
      // (No length known: 0, the rest of the file.)
      parts.push({ url, still: false, in: from, len: to != null ? Math.max(0.04, to - from) : 0, fill: !!m.frame?.fill })
    } else {
      const held = m.clipOut != null ? m.clipOut - (m.clipIn ?? 0) : STILL_SECONDS
      parts.push({ url, still: true, in: 0, len: Math.max(0.2, Math.min(60, held)), fill: !!m.frame?.fill })
    }
  }
  if (stopped()) return { stopped: true }
  // Shots with a frame (a Rough Cut's): the first one's is the movie's shape.
  const opened = await d.cutMovieOpen(parts, use.find(m => m.frame)?.frame?.aspect)
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
    const out = await d.cutMovieClose(opened.id, name)
    if ('error' in out) return { error: out.error }

    useUndoCoordinator.getState().checkpoint()
    const gid = createMediaCard({ cx: 0, cy: 0 }, [{ media: { url: diskFileUrl(out.path), type: 'video', ...(opened.length ? { duration: opened.length } : null) }, label: name }])
    if (gid) {
      markNew([gid])
      const face = cardFaceSize()
      const box = beside()
      if (box) {
        const slot = findFreeSlotRightOf(box, face.w, face.h)
        placeCard(gid, slot.x, slot.y)
      }
      useBoardsStore.getState().setSelectedGroups([gid])
    }
    return { shots: parts.length, path: out.path }
  } finally {
    if (!closed) void d.cutMovieDrop?.(opened.id)
  }
}
