// filmPlan.ts — which of the Film Look mixer's shots a video clip holds.
//
// The mixer mixes the film's own shots. A clip cut from the film's edit video
// (in a Rough Cut, with Find shots, or picked out as a card) is those shots:
// a video as long as the film is taken to be the film, and its in and out
// points, at the film's frame rate, say which shots it covers. Anything else
// holds no shot the mixer can mix.

import type { MediaItem } from '../types/bar'

export interface FilmShot { clip: string; start: number; end: number }

/** The film's frame rate. */
export const FILM_FPS = 30
/** How near a video's length must be to the film's to be the film: a few
 *  frames either way for how an export rounds its last frame. */
const SAME_LENGTH_FRAMES = 15

let plan: { frames: number; shots: FilmShot[] } | null = null
let asking: Promise<void> | null = null

/** Whether the mixer has said where its shots are yet. */
export const hasFilmPlan = () => !!plan

/** Ask the mixer for its shots once it is up; until then nothing maps. */
export function loadFilmPlan(): Promise<void> {
  if (plan) return Promise.resolve()
  if (asking) return asking
  asking = (async () => {
    // The film's whole length, graphics-only stretches included: the edit
    // video runs that long, not just to the last shot with a look.
    const film = await window.vidbarsDesktop?.mixerCall?.('film')
    if (film && film.frames > 0 && film.shots.length) plan = { frames: film.frames, shots: [...film.shots].sort((a, b) => a.start - b.start) }
  })().finally(() => { asking = null })
  return asking
}

/** The mixer's shots inside part of the film's edit video, in film order: those
 *  at least half inside the part, or that the part lies at least half inside. */
export function shotsInFilmRange(fullSeconds: number | undefined, inS: number, outS: number): string[] {
  if (!plan || !fullSeconds || Math.abs(fullSeconds * FILM_FPS - plan.frames) > SAME_LENGTH_FRAMES) return []
  const f0 = inS * FILM_FPS, f1 = outS * FILM_FPS
  return plan.shots.filter(s => {
    const overlap = Math.min(s.end, f1) - Math.max(s.start, f0)
    return overlap > 0 && (overlap >= (s.end - s.start) / 2 || overlap >= (f1 - f0) / 2)
  }).map(s => s.clip)
}

/** The shots a card's picture or video holds. */
export function mediaShots(m: MediaItem): string[] {
  if (m.filmShot) return [m.filmShot]
  if (m.type !== 'video') return []
  return shotsInFilmRange(m.duration, m.clipIn ?? 0, m.clipOut ?? m.duration ?? 0)
}
