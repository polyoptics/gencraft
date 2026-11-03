// roughCut.ts — a Rough Cut: clips in one row, each trimmed, in order.
//
// Each clip remembers how long its source is, and its in and out points in
// seconds. The row is just those durations end to end, so trimming one moves
// every clip after it (a ripple) without anything else to keep in step.
// Clips come from cards: drop a card on the Rough Cut and each picture, video
// or film shot on it is added at the end, at its full length.

import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { getMediaItems, type MediaItem } from '../types/bar'
import { gridOrder } from './cardGrid'
import { resolveMediaUrl } from './useResolvedMedia'

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
}

export interface RoughCutData {
  clips: RoughClip[]
  /** Canvas units per second in its row: its own zoom. */
  pps: number
}

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
export const cutLength = (clips: RoughClip[]) => clips.reduce((a, c) => a + clipLength(c), 0)

/** The clip at time t in the cut, with where t falls inside its source. */
export function clipAt(clips: RoughClip[], t: number): { index: number; clip: RoughClip; local: number; start: number } | null {
  let start = 0
  for (const [index, clip] of clips.entries()) {
    const len = clipLength(clip)
    if (t < start + len || index === clips.length - 1) return { index, clip, local: clip.in + Math.max(0, Math.min(len, t - start)), start }
    start += len
  }
  return null
}

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
    const full = (await videoLength(m.url)) ?? 5
    return { id, label, kind: 'video', url: m.url, poster: m.posterUrl, full, in: 0, out: full }
  }
  if (m.type === 'image') {
    return { id, label, kind: 'image', url: m.url, poster: m.url, full: IMAGE_MAX, in: 0, out: IMAGE_HOLD }
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

/** Add the clips of these cards to the end of a Rough Cut, in the order given. */
export async function appendCards(nodeId: string, groupIds: string[]): Promise<number> {
  const { groups, boards } = useBoardsStore.getState()
  const added: RoughClip[] = []
  for (const gid of groupIds) {
    const g = groups.find(x => x.id === gid)
    if (g) added.push(...await cardClips(g, boards))
  }
  const node = useFreeNodeStore.getState().nodes[nodeId]
  if (!node?.roughCut || !added.length) return 0
  useUndoCoordinator.getState().checkpoint()
  const clips = [...node.roughCut.clips, ...added]
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
  return (node.roughCut?.clips ?? []).flatMap(c => (c.shot ? [c.shot] : []))
}
