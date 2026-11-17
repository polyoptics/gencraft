// roughCut.ts — a Rough Cut: clips laid out freely on rows, each trimmed.
//
// Each clip remembers how long its source is, its in and out points, and
// where it sits: its start on the timeline (seconds) and its row. Clips move
// freely; empty time plays as black. Where clips on several rows overlap,
// the top row is the one seen. Clips come from cards: drop a card on the
// Rough Cut and each picture, video or film shot on it is added where it
// was let go (or after the last clip on the top row).

import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { getMediaItems, type MediaItem } from '../types/bar'
import { gridOrder } from './cardGrid'
import { resolveMediaUrl } from './useResolvedMedia'
import { shotsInFilmRange } from './filmPlan'
import type { ShotView } from './shotFrame'

export interface RoughClip {
  id: string
  label: string
  kind: 'video' | 'image' | 'shot'
  /** The media as the card stores it (often a mediaref:). */
  url: string
  /** What the block shows: the picture, or a video's poster. */
  poster?: string
  /** A film shot the Film Look mixer can mix. */
  shot?: string
  /** The source's own length, and the part of it in the cut (seconds). */
  full: number
  in: number
  out: number
  /** Where it sits: seconds from the start of the timeline, and its row (0 = top). */
  start?: number
  row?: number
  /** Picked while playing through (P): goes out with Deck of picks. */
  pick?: boolean
  /** Its own zoom and place inside the Rough Cut's frame (utils/shotFrame). */
  view?: ShotView
}

export interface RoughCutData {
  clips: RoughClip[]
  /** Canvas units per second in its row: its own zoom. */
  pps: number
  /** Its controls' size: canvas units per design unit, fixed when it is made,
   *  so resizing it gives it more timeline and rows, not bigger buttons. */
  ui?: number
  /** One frame for every shot, whatever its own shape: the frame's shape
   *  (width ÷ height), and whether a shot fills it (its overhang cut off) or
   *  is fitted inside it. Goes out with the shots (MediaItem.frame). Absent:
   *  each shot keeps its own shape. */
  frame?: { aspect: number; fill?: boolean }
  /** false: the screens show whole shots, not the frame (a look only). */
  frameShown?: boolean
}

/** The frame shapes a Rough Cut offers. */
export const FRAME_SHAPES: { label: string; aspect: number }[] = [
  { label: '16:9', aspect: 16 / 9 }, { label: '4:3', aspect: 4 / 3 }, { label: '1:1', aspect: 1 },
  { label: '9:16', aspect: 9 / 16 }, { label: '2.39:1', aspect: 2.39 },
]

/** The shortest a clip can be trimmed to, seconds. */
export const MIN_CLIP = 0.2
/** How long a still picture is held when it comes in; it can be stretched to IMAGE_MAX. */
const IMAGE_HOLD = 2
const IMAGE_MAX = 60
/** The film's frame rate, for the mixer's shots. */
export const FILM_FPS = 30
/** The row's width in its own units, less a margin: what "fit" fills. */
export const ROW_FIT_W = 1320

export const clipLength = (c: RoughClip) => Math.max(MIN_CLIP, c.out - c.in)
export const clipStart = (c: RoughClip) => c.start ?? 0
export const clipEnd = (c: RoughClip) => clipStart(c) + clipLength(c)
export const clipRow = (c: RoughClip) => c.row ?? 0
/** The whole timeline's length: to the end of the last clip. */
export const cutLength = (clips: RoughClip[]) => clips.reduce((a, c) => Math.max(a, clipEnd(c)), 0)

/** Clips from before they had places (end to end on the top row) get them. */
export function placed(clips: RoughClip[]): RoughClip[] {
  if (clips.every(c => c.start != null)) return clips
  let a = 0
  return clips.map(c => {
    if (c.start != null) return c
    const p = { ...c, start: a, row: c.row ?? 0 }
    a += clipLength(c)
    return p
  })
}

/** What is seen at time t: the clip on the topmost row there (null: black). */
export function clipAt(clips: RoughClip[], t: number): { clip: RoughClip; local: number; start: number } | null {
  let best: RoughClip | null = null
  for (const c of clips) {
    if (t < clipStart(c) || t >= clipEnd(c)) continue
    if (!best || clipRow(c) < clipRow(best) || (clipRow(c) === clipRow(best) && clipStart(c) > clipStart(best))) best = c
  }
  if (!best) return null
  return { clip: best, local: best.in + (t - clipStart(best)), start: clipStart(best) }
}

/** The end of the last clip on a row. */
export const rowEnd = (clips: RoughClip[], row: number) =>
  clips.filter(c => clipRow(c) === row).reduce((a, c) => Math.max(a, clipEnd(c)), 0)

function videoLength(url: string): Promise<number | null> {
  return new Promise(resolve => {
    void resolveMediaUrl(url).then(src => {
      if (!src) { resolve(null); return }
      const v = document.createElement('video')
      v.preload = 'metadata'
      v.muted = true
      const done = (d: number | null) => { v.removeAttribute('src'); v.load(); resolve(d) }
      v.onloadedmetadata = () => done(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null)
      v.onerror = () => done(null)
      window.setTimeout(() => done(null), 8000)
      v.src = src
    })
  })
}

let shotFrames: Promise<Map<string, number>> | null = null
/** How many frames each of the mixer's shots has, asked once. */
function filmShotFrames(): Promise<Map<string, number>> {
  if (!shotFrames) {
    shotFrames = (window.vidbarsDesktop?.mixerCall?.('shots') ?? Promise.resolve(null)).then(list => {
      const m = new Map<string, number>()
      for (const s of (Array.isArray(list) ? list : [])) m.set(s.clip, s.n)
      if (!m.size) shotFrames = null   // the mixer was not up: ask again next time
      return m
    })
  }
  return shotFrames
}

async function clipFrom(m: MediaItem, label: string): Promise<RoughClip | null> {
  const id = crypto.randomUUID()
  if (m.filmShot) {
    const n = (await filmShotFrames()).get(m.filmShot)
    const full = n ? n / FILM_FPS : 4
    return { id, label: m.filmShot, kind: 'shot', url: m.url, poster: m.url, shot: m.filmShot, full, in: 0, out: full }
  }
  if (m.type === 'video') {
    const full = m.duration ?? (await videoLength(m.url)) ?? 5
    // A card that was trimmed (pulled out of a Rough Cut) comes in trimmed.
    const cin = Math.max(0, Math.min(full - MIN_CLIP, m.clipIn ?? 0))
    const cout = Math.max(cin + MIN_CLIP, Math.min(full, m.clipOut ?? full))
    return { id, label, kind: 'video', url: m.url, poster: m.posterUrl, full, in: cin, out: cout }
  }
  if (m.type === 'image') {
    const hold = m.clipOut != null ? Math.max(MIN_CLIP, Math.min(IMAGE_MAX, m.clipOut - (m.clipIn ?? 0))) : IMAGE_HOLD
    return { id, label, kind: 'image', url: m.url, poster: m.url, full: IMAGE_MAX, in: 0, out: hold }
  }
  return null
}

/** Every picture, video and shot on a card, in its blocks' reading order. */
async function cardClips(g: ProjectGroup, boards: Record<string, BoardData>): Promise<RoughClip[]> {
  const out: RoughClip[] = []
  for (const bid of gridOrder(g, boards)) {
    const b = boards[bid]
    for (const rid of b.rootIds) {
      const bar = b.bars[rid]
      for (const m of getMediaItems(bar?.content)) {
        const c = await clipFrom(m, bar?.name || g.name || 'Clip')
        if (c) out.push(c)
      }
    }
  }
  return out
}

/** Add the clips of these cards to a Rough Cut, end to end from `at` (or
 *  after the last clip on the top row), in the order given. */
export async function appendCards(nodeId: string, groupIds: string[], at?: { t: number; row: number }): Promise<number> {
  const { groups, boards } = useBoardsStore.getState()
  const added: RoughClip[] = []
  for (const gid of groupIds) {
    const g = groups.find(x => x.id === gid)
    if (g) added.push(...await cardClips(g, boards))
  }
  const node = useFreeNodeStore.getState().nodes[nodeId]
  if (!node?.roughCut || !added.length) return 0
  useUndoCoordinator.getState().checkpoint()
  const have = placed(node.roughCut.clips)
  const row = at?.row ?? 0
  let a = at ? Math.max(0, at.t) : rowEnd(have, 0)
  // Each goes in at the next free time on its row: never on top of a clip already there.
  const put: RoughClip[] = []
  for (const c of added) {
    const len = clipLength(c)
    for (let hit = true; hit;) {
      hit = false
      for (const o of [...have, ...put]) {
        if (clipRow(o) === row && a < clipEnd(o) - 1e-6 && a + len > clipStart(o) + 1e-6) { a = clipEnd(o); hit = true }
      }
    }
    put.push({ ...c, start: a, row })
    a += len
  }
  const clips = [...have, ...put]
  // Zoomed out as far as it takes to keep the whole cut in view; never in.
  const pps = Math.min(node.roughCut.pps, Math.max(6, ROW_FIT_W / cutLength(clips)))
  useFreeNodeStore.getState().updateFreeNode(nodeId, { roughCut: { ...node.roughCut, clips, pps } })
  return added.length
}

/** Change a Rough Cut's clips or zoom. One undo step per call. */
export function setRoughCut(nodeId: string, patch: Partial<RoughCutData>, checkpoint = true): void {
  const node = useFreeNodeStore.getState().nodes[nodeId]
  if (!node?.roughCut) return
  if (checkpoint) useUndoCoordinator.getState().checkpoint()
  useFreeNodeStore.getState().updateFreeNode(nodeId, { roughCut: { ...node.roughCut, ...patch } })
}

/** The film shots of a Rough Cut, in cut order: what the mixer mixes when the
 *  Rough Cut is docked to it. */
export function roughCutShots(node: FreeNodeData): string[] {
  const clips = [...placed(node.roughCut?.clips ?? [])].sort((a, b) => clipStart(a) - clipStart(b) || clipRow(a) - clipRow(b))
  return clips.flatMap(c => (c.shot ? [c.shot] : c.kind === 'video' ? shotsInFilmRange(c.full, c.in, c.out) : []))
}

/** A clip as a card's media, its trim kept: what a clip dragged out becomes.
 *  `frame`: its Rough Cut's frame, which goes with it. */
export function clipMedia(c: RoughClip, frame?: RoughCutData['frame']): MediaItem {
  const f = frame ? { frame: { aspect: frame.aspect, ...(frame.fill ? { fill: true } : null), ...c.view } } : null
  if (c.kind === 'video') return { url: c.url, type: 'video', posterUrl: c.poster, clipIn: c.in, clipOut: c.out, duration: c.full, ...f }
  if (c.kind === 'shot') return { url: c.url, type: 'image', filmShot: c.shot, ...f }
  return { url: c.url, type: 'image', clipIn: 0, clipOut: clipLength(c), ...f }
}

/** Split one clip at timeline time t into two, end to end, each with its own
 *  trim; null when t is not inside it with at least MIN_CLIP on both sides. */
export function splitClipAt(clips: RoughClip[], clipId: string, t: number): RoughClip[] | null {
  const i = clips.findIndex(c => c.id === clipId)
  const c = clips[i]
  if (!c) return null
  const local = c.in + (t - clipStart(c))
  if (local - c.in < MIN_CLIP || c.out - local < MIN_CLIP) return null
  const a: RoughClip = { ...c, out: local }
  const b: RoughClip = { ...c, id: crypto.randomUUID(), in: local, start: clipStart(c) + (local - c.in) }
  return [...clips.slice(0, i), a, b, ...clips.slice(i + 1)]
}
