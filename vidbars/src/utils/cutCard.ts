// cutCard.ts — the ROUGH CUT as a card.
//
// A Rough Cut card is a grid card (utils/cardGrid) carrying `cut`. Its blocks
// are its clips, in cut order (their reading order), and each block's picture
// or video carries its own trim: `clipIn` / `clipOut` on the media item, in
// seconds of its source. Nothing else holds the cut, so everything a block
// can do it still does: pulled out of the card it is a card of that trimmed
// clip, and any card dropped on the Rough Cut joins it as clips.
//
// Notes made in the cut are bars under the clip's own bar (`Bar.cutNote`):
// they live on the node layer, and show there when zoomed all the way in.
//
// Zoomed out the card's face plays the cut; at block zoom the card is a
// timeline (components/RoughCut/CutTimeline).

import { NEW_CARD_FACE, useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { useZoomZonesStore } from '../store/zoomZonesStore'
import { getMediaItems, type Bar, type MediaItem } from '../types/bar'
import { makeBar } from './barOps'
import { cardFaceSize, createMediaCard, gridOrder } from './cardGrid'
import { markNew } from './newCards'
import { resolveMediaUrl } from './useResolvedMedia'

export interface CutAudio {
  id: string
  url: string
  label: string
  /** Where it starts in the cut, and the part of its source it plays (s). */
  start: number
  in: number
  out: number
  full: number
}

export interface CutCardData {
  /** The timeline's own zoom: design px per second. */
  pps: number
  /** Sound under the picture, on its own lane. */
  audio?: CutAudio[]
}

/** The shortest a clip can be trimmed to, seconds. */
export const MIN_CLIP = 0.2
/** A still picture comes in held this long, and stretches up to IMAGE_MAX. */
export const IMAGE_HOLD = 2
export const IMAGE_MAX = 60
/** A video whose length could not be read yet. */
const UNKNOWN_LEN = 5
export const CUT_ASPECT = 0.6

export const isCutCard = (g: ProjectGroup | undefined | null): boolean => !!g?.cut

export interface CutNote { barId: string; t: number; text: string }

export interface CutClip {
  boardId: string
  barId: string
  media: MediaItem
  label: string
  kind: 'video' | 'image'
  in: number
  out: number
  /** The source's own length (a still: how far it may stretch). */
  full: number
  notes: CutNote[]
}

/** A media item's trim, with the defaults filled in. */
export function mediaRange(m: MediaItem): { in: number; out: number; full: number } {
  if (m.type === 'video' || m.type === 'audio') {
    const full = m.duration ?? Math.max(m.clipOut ?? 0, UNKNOWN_LEN)
    const i = Math.max(0, Math.min(full - MIN_CLIP, m.clipIn ?? 0))
    const o = Math.max(i + MIN_CLIP, Math.min(full, m.clipOut ?? full))
    return { in: i, out: o, full }
  }
  const o = Math.max(MIN_CLIP, Math.min(IMAGE_MAX, m.clipOut ?? IMAGE_HOLD))
  return { in: 0, out: o, full: IMAGE_MAX }
}

export const clipLen = (c: { in: number; out: number }) => Math.max(MIN_CLIP, c.out - c.in)
export const cutTotal = (clips: { in: number; out: number }[]) => clips.reduce((a, c) => a + clipLen(c), 0)

/** The clip a block holds: its first picture or video. */
function blockClip(b: BoardData): { barId: string; media: MediaItem; bar: Bar } | null {
  for (const rid of b.rootIds) {
    const bar = b.bars[rid]
    const m = getMediaItems(bar?.content).find(x => x.type === 'video' || x.type === 'image')
    if (bar && m) return { barId: rid, media: m, bar }
  }
  return null
}

/** The clips of a Rough Cut card, in cut order. Blocks with no picture or
 *  video in them are not clips. */
export function cutClips(g: ProjectGroup, boards: Record<string, BoardData>): CutClip[] {
  const out: CutClip[] = []
  for (const bid of gridOrder(g, boards)) {
    const b = boards[bid]
    const c = b && blockClip(b)
    if (!c) continue
    const r = mediaRange(c.media)
    const notes = c.bar.children
      .map(id => b.bars[id])
      .filter((x): x is Bar => !!x?.cutNote)
      .map(x => ({ barId: x.id, t: x.cutNote!.t, text: x.content.text ?? '' }))
      .sort((a, z) => a.t - z.t)
    out.push({
      boardId: bid, barId: c.barId, media: c.media, kind: c.media.type === 'video' ? 'video' : 'image',
      label: b.layers?.block?.label || c.bar.name || c.media.originalName || 'Clip', ...r, notes,
    })
  }
  return out
}

/** The clip at time t of the cut, with where t falls in its source. */
export function clipAtTime<C extends { in: number; out: number }>(clips: C[], t: number): { index: number; clip: C; local: number; start: number } | null {
  let start = 0
  for (const [index, clip] of clips.entries()) {
    const len = clipLen(clip)
    if (t < start + len || index === clips.length - 1) return { index, clip, local: clip.in + Math.max(0, Math.min(len, t - start)), start }
    start += len
  }
  return null
}

/** Lay a Rough Cut card's blocks out in cut order, one row across its
 *  frame, each as wide as its share of the cut: what you see at the node
 *  layer, and the order every reader of the card agrees on. Notes sit under
 *  their clip's bar at their time. `order`: the clips' new order (board ids),
 *  else the current one. Blocks that hold no clip go, once there are clips.
 *  The caller takes the undo checkpoint. */
export function layoutCutCard(groupId: string, order?: string[]): void {
  const s = useBoardsStore.getState()
  const g = s.groups.find(x => x.id === groupId)
  if (!g?.cut) return
  const current = gridOrder(g, s.boards)
  const ids = order ? [...order.filter(id => current.includes(id)), ...current.filter(id => !order.includes(id))] : current
  const clipIds = ids.filter(id => s.boards[id] && blockClip(s.boards[id]))
  const empty = clipIds.length ? ids.filter(id => !clipIds.includes(id)) : []
  const keep = clipIds.length ? clipIds : ids
  const frameW = g.cardWidthOverride ?? cutCardSize().w
  const lens = keep.map(id => { const c = blockClip(s.boards[id]); return c ? clipLen(mediaRange(c.media)) : 1 })
  const total = Math.max(0.001, lens.reduce((a, b) => a + b, 0))
  const gap = frameW * 0.004
  const minW = frameW * 0.02
  const avail = frameW - gap * Math.max(0, keep.length - 1)
  const widths = lens.map(l => Math.max(minW, (l / total) * avail))
  const k = Math.min(1, avail / Math.max(1, widths.reduce((a, b) => a + b, 0)))
  useBoardsStore.setState(st => {
    const boards = { ...st.boards }
    let x = 0
    keep.forEach((bid, i) => {
      const b = boards[bid]
      if (!b) return
      const w = widths[i] * k
      const c = blockClip(b)
      const placed: BoardData = { ...b, nleRow: 0, nleX: x, boardScale: 1 }
      if (c) {
        const r = mediaRange(c.media)
        const h = Math.min(w * 0.5625, frameW * 0.06)
        const bars = { ...b.bars, [c.barId]: { ...c.bar, x: 0, width: w, height: Math.max(h, frameW * 0.03) } }
        // Notes: in a row under their clip, each at its time.
        const notes = c.bar.children.map(id => bars[id]).filter((n): n is Bar => !!n?.cutNote)
        const nw = Math.max(minW * 0.8, Math.min(w, frameW * 0.05))
        for (const n of notes) {
          const at = (n.cutNote!.t - r.in) / clipLen(r)
          bars[n.id] = { ...n, rowIndex: c.bar.rowIndex + 1, x: Math.max(0, Math.min(w - nw, at * w - nw / 2)), width: nw, height: Math.max(frameW * 0.02, nw * 0.5) }
        }
        placed.bars = bars
      }
      boards[bid] = placed
      x += w + gap
    })
    for (const bid of empty) delete boards[bid]
    // A Rough Cut always has its one shape: as wide as its row, CUT_ASPECT
    // tall (this also mends a frame whose width was lost).
    const groups = st.groups.map(gr => gr.id === groupId
      ? { ...gr, cardWidthOverride: frameW, cardHeightOverride: frameW * CUT_ASPECT, boardIds: [...keep, ...gr.boardIds.filter(b => !keep.includes(b) && !empty.includes(b))] }
      : gr)
    return { boards, groups, boardOrder: empty.length ? st.boardOrder.filter(id => !empty.includes(id)) : st.boardOrder }
  })
}

/** A new Rough Cut card's frame, canvas units: whatever the zoom it is made
 *  at, about CUT_SCREEN_W screen px wide in the middle of the Blocks zone,
 *  where its timeline is worked in, so the timeline is big enough to use. */
const CUT_SCREEN_W = 1150
export function cutCardSize(_zoom?: number): { w: number; h: number } {
  const { cardMax, blockMax } = useZoomZonesStore.getState()
  const w = CUT_SCREEN_W / Math.sqrt(Math.max(0.01, cardMax) * Math.max(0.01, blockMax))
  return { w, h: w * CUT_ASPECT }
}

/** A new, empty Rough Cut card centred on (cx, cy). Returns its id. */
export function createCutCard(at: { cx: number; cy: number }, name = 'Rough Cut'): string {
  const { w, h } = cutCardSize()
  const bs = useBoardsStore.getState()
  useUndoCoordinator.getState().checkpoint()
  const boardId = bs.createBoard(0, 0)
  const groupId = bs.createGroup(name, [boardId])
  useBoardsStore.setState(st => ({
    groups: st.groups.map(gr => gr.id === groupId ? {
      ...gr, layout: 'grid' as const, cut: { pps: 0 }, color: '#2a2f45',
      cardWidthOverride: w, cardHeightOverride: h, cardHeroTransform: { ...NEW_CARD_FACE },
      originX: at.cx - w / 2 - 20, originY: at.cy - h / 2,
    } : { ...gr, boardIds: gr.id === groupId ? gr.boardIds : gr.boardIds.filter(b => b !== boardId) }),
  }))
  useBoardsStore.getState().setSelectedGroup(groupId)
  return groupId
}

/** Change one clip's media (its trim, its length once read). */
function patchClipMedia(boardId: string, patch: (m: MediaItem) => MediaItem): void {
  const st = useBoardsStore.getState()
  const b = st.boards[boardId]
  const c = b && blockClip(b)
  if (!c) return
  const media = getMediaItems(c.bar.content).map(m => (m === c.media ? patch(m) : m))
  st.setContent(boardId, c.barId, { media })
}

function cardOf(boardId: string): ProjectGroup | undefined {
  return useBoardsStore.getState().groups.find(g => g.boardIds.includes(boardId))
}

/** Set a clip's in and out points. One undo step unless `checkpoint` is false. */
export function setClipRange(boardId: string, i: number, o: number, checkpoint = true): void {
  if (checkpoint) useUndoCoordinator.getState().checkpoint()
  patchClipMedia(boardId, m => ({ ...m, clipIn: i, clipOut: o }))
  const g = cardOf(boardId)
  if (g?.cut) layoutCutCard(g.id)
}

/** Several clips' trims at once (a roll edit, a multi-trim): one undo step. */
export function setClipRanges(ranges: { boardId: string; in: number; out: number }[]): void {
  if (!ranges.length) return
  useUndoCoordinator.getState().checkpoint()
  for (const r of ranges) patchClipMedia(r.boardId, m => ({ ...m, clipIn: r.in, clipOut: r.out }))
  const g = cardOf(ranges[0].boardId)
  if (g?.cut) layoutCutCard(g.id)
}

/** Put the clips in this order (board ids). One undo step. */
export function reorderClips(groupId: string, order: string[]): void {
  useUndoCoordinator.getState().checkpoint()
  layoutCutCard(groupId, order)
}

export function setCut(groupId: string, patch: Partial<CutCardData>, checkpoint = false): void {
  if (checkpoint) useUndoCoordinator.getState().checkpoint()
  useBoardsStore.setState(st => ({
    groups: st.groups.map(g => g.id === groupId && g.cut ? { ...g, cut: { ...g.cut, ...patch } } : g),
  }))
}

/** Read the length of every video clip on the card that has none yet, and
 *  open its trim to all of it. Not an undo step: it only finishes an add. */
export async function readClipLengths(groupId: string): Promise<void> {
  const st = useBoardsStore.getState()
  const g = st.groups.find(x => x.id === groupId)
  if (!g?.cut) return
  let changed = false
  for (const c of cutClips(g, st.boards)) {
    if (c.kind !== 'video' || c.media.duration) continue
    const d = await mediaLength(c.media.url)
    if (!d) continue
    patchClipMedia(c.boardId, m => ({ ...m, duration: d, clipIn: Math.min(m.clipIn ?? 0, d - MIN_CLIP), clipOut: Math.min(m.clipOut ?? d, d) }))
    changed = true
  }
  if (changed) layoutCutCard(groupId)
}

/** A video's or a sound's length in seconds, or null. */
export function mediaLength(url: string, kind: 'video' | 'audio' = 'video'): Promise<number | null> {
  return new Promise(resolve => {
    void resolveMediaUrl(url).then(src => {
      if (!src) { resolve(null); return }
      const v = document.createElement(kind)
      v.preload = 'metadata'
      v.muted = true
      let settled = false
      const done = (d: number | null) => { if (settled) return; settled = true; v.removeAttribute('src'); v.load(); resolve(d) }
      v.onloadedmetadata = () => done(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null)
      v.onerror = () => done(null)
      window.setTimeout(() => done(null), 8000)
      v.src = src
    })
  })
}

/** Cut a clip in two at `local` (seconds of its source): the second half is
 *  a new block right after it, the same media trimmed to the rest. Notes go
 *  with the half they fall in. One undo step. Returns the new block. */
export function splitClip(boardId: string, local: number): string | null {
  const st = useBoardsStore.getState()
  const g = cardOf(boardId)
  const b = st.boards[boardId]
  const c = b && blockClip(b)
  if (!g?.cut || !c) return null
  const r = mediaRange(c.media)
  if (local <= r.in + MIN_CLIP || local >= r.out - MIN_CLIP) return null
  useUndoCoordinator.getState().checkpoint()
  const nid = st.duplicateBoard(boardId)
  useBoardsStore.setState(s => ({
    // duplicateBoard files the copy under the same card; keep it there only.
    groups: s.groups.map(gr => gr.id === g.id
      ? { ...gr, boardIds: [...gr.boardIds.filter(x => x !== nid)].flatMap(x => (x === boardId ? [x, nid] : [x])) }
      : { ...gr, boardIds: gr.boardIds.filter(x => x !== nid) }),
  }))
  patchClipMedia(boardId, m => ({ ...m, clipIn: r.in, clipOut: local }))
  patchClipMedia(nid, m => ({ ...m, clipIn: local, clipOut: r.out }))
  // Notes: each half keeps those in its own part.
  const drop = (bid: string, keep: (t: number) => boolean) => {
    const bb = useBoardsStore.getState().boards[bid]
    const cc = bb && blockClip(bb)
    if (!cc) return
    for (const id of cc.bar.children) {
      const n = bb.bars[id]
      if (n?.cutNote && !keep(n.cutNote.t)) useBoardsStore.getState().deleteSubtree(bid, id)
    }
  }
  drop(boardId, t => t < local)
  drop(nid, t => t >= local)
  const order = gridOrder(useBoardsStore.getState().groups.find(x => x.id === g.id)!, useBoardsStore.getState().boards)
  const without = order.filter(x => x !== nid)
  without.splice(without.indexOf(boardId) + 1, 0, nid)
  layoutCutCard(g.id, without)
  return nid
}

/** Take a clip out of the cut. One undo step. */
export function removeClip(boardId: string): void {
  const g = cardOf(boardId)
  if (!g?.cut) return
  useUndoCoordinator.getState().checkpoint()
  if (g.boardIds.length === 1) {
    // The card's last block: keep the block, empty, so the card stays.
    const b = useBoardsStore.getState().boards[boardId]
    const c = b && blockClip(b)
    if (c) useBoardsStore.getState().setContent(boardId, c.barId, { media: [] })
  } else {
    useBoardsStore.getState().deleteBoard(boardId)
  }
  layoutCutCard(g.id)
}

/** Drop cards into the cut at `index` (in cut order; past the end appends):
 *  their blocks join as clips, in their own order, and the cards are gone
 *  into it (mergeCardsInto). One undo step. */
export async function insertCards(groupId: string, cardIds: string[], index: number): Promise<void> {
  const { mergeCardsInto } = await import('./cardGrid')
  const st = useBoardsStore.getState()
  const g = st.groups.find(x => x.id === groupId)
  if (!g?.cut) return
  const before = cutClips(g, st.boards).map(c => c.boardId)
  useUndoCoordinator.getState().checkpoint()
  if (!mergeCardsInto(groupId, cardIds)) return
  const after = useBoardsStore.getState()
  const g2 = after.groups.find(x => x.id === groupId)!
  const added = gridOrder(g2, after.boards).filter(id => !before.includes(id) && after.boards[id] && blockClip(after.boards[id]))
  const order = [...before]
  order.splice(Math.max(0, Math.min(order.length, index)), 0, ...added)
  layoutCutCard(groupId, order)
  await readClipLengths(groupId)
}

/** Add a note to a clip at `t` (seconds of its source): a bar under the
 *  clip's bar. One undo step. Returns the note's bar id. */
export function addNote(boardId: string, t: number, text: string): string | null {
  const st = useBoardsStore.getState()
  const b = st.boards[boardId]
  const c = b && blockClip(b)
  if (!c) return null
  useUndoCoordinator.getState().checkpoint()
  const id = crypto.randomUUID()
  const note = makeBar({
    id, parentId: c.barId, rowIndex: c.bar.rowIndex + 1, x: 0, width: 60,
    name: `Note ${fmtTime(t)}`, color: '#e8b04a', cutNote: { t },
    content: { text, images: [], media: [], mentions: [] },
  })
  useBoardsStore.setState(s => {
    const bb = s.boards[boardId]
    return {
      boards: {
        ...s.boards,
        [boardId]: { ...bb, bars: { ...bb.bars, [id]: note, [c.barId]: { ...bb.bars[c.barId], children: [...bb.bars[c.barId].children, id], collapsed: false } } },
      },
    }
  })
  const g = cardOf(boardId)
  if (g?.cut) layoutCutCard(g.id)
  return id
}

export function setNoteText(boardId: string, barId: string, text: string): void {
  useUndoCoordinator.getState().checkpoint()
  useBoardsStore.getState().setContent(boardId, barId, { text })
}

export function removeNote(boardId: string, barId: string): void {
  useUndoCoordinator.getState().checkpoint()
  useBoardsStore.getState().deleteSubtree(boardId, barId)
  const g = cardOf(boardId)
  if (g?.cut) layoutCutCard(g.id)
}

/** The finished cut as a deck: one card per clip, each holding that clip
 *  trimmed (its notes too), in a row of touching cards below the Rough Cut,
 *  so they are one deck, ready to dock to the Film Look mixer or a loop
 *  strip. The Rough Cut stays as it is. One undo step. Returns the cards. */
export function pullOutDeck(groupId: string): string[] {
  const st = useBoardsStore.getState()
  const g = st.groups.find(x => x.id === groupId)
  if (!g?.cut) return []
  const clips = cutClips(g, st.boards)
  if (!clips.length) return []
  useUndoCoordinator.getState().checkpoint()
  const face = cardFaceSize()
  const frameH = g.cardHeightOverride ?? face.h * 2
  // Their row starts under the Rough Cut's left edge, a card's height clear
  // of it, so the deck is its own and not docked to the Rough Cut.
  const x0 = g.originX + 20 + face.w / 2
  const y0 = g.originY + frameH + face.h + face.h / 2
  const made: string[] = []
  clips.forEach((c, n) => {
    const media: MediaItem = { ...c.media }
    const id = createMediaCard({ cx: x0 + n * face.w, cy: y0 }, [{ media, label: c.label }])
    if (!id) return
    made.push(id)
    // The clip's notes go with it, under its bar on the node layer.
    if (c.notes.length) {
      const s2 = useBoardsStore.getState()
      const card = s2.groups.find(x => x.id === id)
      const bid = card?.boardIds[0]
      const nb = bid ? s2.boards[bid] : undefined
      const root = nb?.rootIds[0]
      if (bid && nb && root) {
        const src = s2.boards[c.boardId]
        const bars = { ...nb.bars }
        const kids: string[] = []
        for (const note of c.notes) {
          const orig = src.bars[note.barId]
          const nid = crypto.randomUUID()
          bars[nid] = { ...orig, id: nid, parentId: root, children: [] }
          kids.push(nid)
        }
        bars[root] = { ...bars[root], children: [...bars[root].children, ...kids] }
        useBoardsStore.setState(s => ({ boards: { ...s.boards, [bid]: { ...s.boards[bid], bars } } }))
      }
    }
  })
  markNew(made)
  useBoardsStore.getState().setSelectedGroups(made)
  return made
}

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60), r = s - m * 60
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`
}
