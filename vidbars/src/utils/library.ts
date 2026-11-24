// library.ts — every saved project's cards and decks, to look through and
// bring in without opening the projects (Brian 2026-11-23: "start a new
// project, and then open a deck browser and look through all the cards and
// decks of all the projects, and be able to search and then bring assets in
// that way").
//
// The server (libraryApi.ts) hands out a LIGHT copy of each saved project:
// the same cards and blocks, with the pictures written into the file swapped
// for short addresses. Light copies are the app's own shapes, so a card here
// is found, typed, pictured and judged to be in a deck by the very functions
// the canvas uses. Bringing a card in reads it whole from the saved file and
// makes a copy: the saved projects are only ever read.

import { create } from 'zustand'
import { useBoardsStore } from '../store/boardsStore'
import type { BoardData, ProjectGroup } from '../store/boardsStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { cardVisualRect, deckTouchRect, isHiddenDeckMember, rectsTouch, DECK_TOUCH_TOLERANCE } from '../hooks/useCardDecks'
import { cardFaceMedia } from './cardGrid'
import type { CardType } from './cardTypes'
import {
  hasRenderableContent, groupMatchesQuery, groupMatchesTags, groupMatchesTypes, groupHasContentOfKind, parseQueryTags,
  type ContentKind,
} from './contentKinds'
import type { ActiveItem } from '../store/viewport3dStore'
import { hasLegacyInlineMedia, runInlineMediaMigration } from './migrateInlineMedia'
import { mediaRefId } from './mediaRef'
import { getMedia } from './mediaStore'
import { insertProjectSnapshot, type ProjectSnapshot } from './projectInsert'

export interface LibraryProject {
  file: string
  /** The added folder it lies in; absent for the app's own saves. */
  dir?: string
  /** The saved file's version: its light copy and addresses are of this one. */
  v: string
  name: string
  savedAt: number
  groups: ProjectGroup[]
  boards: Record<string, BoardData>
}

/** One row of the library: a card of a saved project. */
export interface LibraryCard {
  key: string
  project: LibraryProject
  group: ProjectGroup
  /** 1: a card of the deck whose front card is the row above it. */
  level: 0 | 1
  /** On a deck's front card: every card of the deck, this one first. */
  deck?: string[]
}

interface LibraryState {
  projects: LibraryProject[]
  /** Saved projects still being read (0: all in). */
  left: number
  loading: boolean
  /** Read the list again; only new and changed projects are fetched. */
  load: () => Promise<void>
  /** The folders added to the library, besides the app's own saves. */
  folders: string[]
  /** Add or take away a folder. Returns what was wrong with it, if anything. */
  addFolder: (dir: string) => Promise<string | null>
  removeFolder: (dir: string) => Promise<void>
}

/** A saved project's place, as the server's addresses name it. */
const where = (p: { file: string; dir?: string }) =>
  `f=${encodeURIComponent(p.file)}${p.dir ? `&d=${encodeURIComponent(p.dir)}` : ''}`
const idOf = (p: { file: string; dir?: string; v: string }) => `${p.dir ?? ''}|${p.file}@${p.v}`

async function postFolders(body: { add?: string; remove?: string }): Promise<{ folders?: string[]; error?: string }> {
  try {
    const res = await fetch('/api/library/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json() as string[] | { error?: string }
    return Array.isArray(data) ? { folders: data } : { error: data.error ?? 'Could not do that' }
  } catch { return { error: 'Could not reach the app' } }
}

let again = false

export const useLibraryStore = create<LibraryState>((set, get) => ({
  projects: [],
  left: 0,
  loading: false,
  folders: [],
  async addFolder(dir) {
    const r = await postFolders({ add: dir })
    if (!r.folders) return r.error ?? 'Could not do that'
    set({ folders: r.folders })
    void get().load()
    return null
  },
  async removeFolder(dir) {
    const r = await postFolders({ remove: dir })
    if (r.folders) set({ folders: r.folders })
    void get().load()
  },
  async load() {
    if (get().loading) { again = true; return }
    set({ loading: true })
    try {
      fetch('/api/library/folders').then(r => r.json()).then(f => { if (Array.isArray(f)) set({ folders: f }) }).catch(() => {})
      const list = await (await fetch('/api/library/list')).json() as { file: string; dir?: string; v: string }[]
      const have = new Map(get().projects.map(p => [idOf(p), p]))
      // What is still current stays in view while the rest comes in.
      const done: LibraryProject[] = list.flatMap(f => have.get(idOf(f)) ?? [])
      const missing = list.filter(f => !have.has(idOf(f)))
      set({ projects: done, left: missing.length })
      // One at a time: the first look at a big save takes the server a moment.
      for (const [i, f] of missing.entries()) {
        try {
          const res = await fetch(`/api/library/light?${where(f)}&v=${f.v}`)
          if (res.ok) {
            done.push(await res.json() as LibraryProject)
            done.sort((a, b) => b.savedAt - a.savedAt)
          }
        } catch { /* a save that cannot be read is left out */ }
        set({ projects: [...done], left: missing.length - i - 1 })
      }
    } catch { /* no server (a built copy): nothing to list */ }
    set({ loading: false, left: 0 })
    // Asked again while this ran (a folder added): once more, for what is new.
    if (again) { again = false; void get().load() }
  },
}))

/** A project's cards as its decks: each a list of card ids, front card
 *  first; a card on its own is a list of one. Closed decks by what they
 *  record, open decks by their cards touching, as on the canvas. */
function decksOf(p: LibraryProject): string[][] {
  const cards = p.groups.filter(g => !g.linkOf && hasRenderableContent(g, p.boards))
  const byId = new Map(cards.map(g => [g.id, g]))
  // The cards folded away in a closed deck, under the card that shows.
  const folded = new Map<string, string[]>()
  const shown: ProjectGroup[] = []
  for (const g of cards) {
    if (!isHiddenDeckMember(g)) { shown.push(g); continue }
    let top: ProjectGroup | undefined = g
    for (let i = 0; i < 20 && top && isHiddenDeckMember(top); i++) top = byId.get(top.deckAnchorId!)
    if (!top || isHiddenDeckMember(top)) { shown.push(g); continue }
    folded.set(top.id, [...(folded.get(top.id) ?? []), g.id])
  }
  const rects = shown.map(g => deckTouchRect(g, p.boards, 1))
  const parent = shown.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < shown.length; i++) {
    const a = rects[i]
    if (!a) continue
    for (let j = i + 1; j < shown.length; j++) {
      const b = rects[j]
      if (b && rectsTouch(a, b, DECK_TOUCH_TOLERANCE)) parent[find(i)] = find(j)
    }
  }
  const sets = new Map<number, number[]>()
  shown.forEach((_, i) => { const r = find(i); sets.set(r, [...(sets.get(r) ?? []), i]) })
  // Left to right, then down: the order an open deck reads in.
  const place = (i: number) => rects[i] ?? { left: shown[i].originX, top: shown[i].originY }
  const order = (a: number, b: number) => place(a).left - place(b).left || place(a).top - place(b).top
  return [...sets.values()]
    .map(m => m.sort(order))
    .sort((a, b) => place(a[0]).top - place(b[0]).top || place(a[0]).left - place(b[0]).left)
    .map(m => m.flatMap(i => [shown[i].id, ...(folded.get(shown[i].id) ?? [])]))
}

const decksCache = new WeakMap<LibraryProject, string[][]>()

/** Every card of every saved project, newest project first, decks kept
 *  together. A card saved in several projects (the same card, under the same
 *  name: a project saved again under a new name) is listed once, from the
 *  newest. */
export function libraryCards(projects: LibraryProject[]): LibraryCard[] {
  const out: LibraryCard[] = []
  const seen = new Set<string>()
  for (const p of projects) {
    let decks = decksCache.get(p)
    if (!decks) {
      // A save too old to read as cards is left out, not in the way.
      try { decks = decksOf(p) } catch { decks = [] }
      decksCache.set(p, decks)
    }
    const byId = new Map(p.groups.map(g => [g.id, g]))
    for (const ids of decks) {
      const fresh = ids.filter(id => {
        const g = byId.get(id)!
        // A new canvas's first card has the same id in every project: told
        // apart by how much is on it as well.
        const k = `${id}|${g.name}|${/^[0-9a-f-]{36}$/.test(id) ? '' : g.boardIds.map(b => Object.keys(p.boards[b]?.bars ?? {}).length).join(',')}`
        return seen.has(k) ? false : (seen.add(k), true)
      })
      fresh.forEach((id, i) => out.push({
        key: `${p.dir ?? ''}|${p.file}|${id}`, project: p, group: byId.get(id)!,
        level: i === 0 ? 0 : 1,
        deck: i === 0 && fresh.length > 1 ? fresh : undefined,
      }))
    }
  }
  return out
}

/** The library's cards that answer the browser's search and chips, as the
 *  canvas's cards do. A project's name finds all of its cards. */
export function filterLibrary(
  cards: LibraryCard[],
  f: { query: string; kind: ContentKind | 'all'; types: CardType[] | undefined },
): LibraryCard[] {
  const q = f.query.trim().toLowerCase()
  const tags = parseQueryTags(q)
  return cards.filter(c => {
    const b = c.project.boards
    if (!groupMatchesTypes(c.group, f.types)) return false
    if (f.kind !== 'all' && !groupHasContentOfKind(c.group, b, f.kind)) return false
    return !q || groupMatchesQuery(c.group, q) || groupMatchesTags(c.group, b, tags) || c.project.name.toLowerCase().includes(q)
  })
}

/** What a Viewer shows for a library card: its face, straight out of the
 *  saved file. The project is never opened for it. */
export function libraryBrowseItem(c: LibraryCard): ActiveItem | null {
  const m = cardFaceMedia(c.group, c.project.boards)
  return m ? { kind: 'media', mediaType: m.type, url: m.url, posterUrl: m.posterUrl, name: c.group.name } : null
}

/** What a library row's drag carries. */
export const LIBRARY_DRAG_MIME = 'application/x-vidbars-library'
export interface LibraryDrag { file: string; dir?: string; v: string; ids: string[]; deck: boolean }

export function parseLibraryDrag(raw: string): LibraryDrag | null {
  try {
    const p = JSON.parse(raw) as Partial<LibraryDrag>
    if (typeof p?.file !== 'string' || typeof p.v !== 'string' || !Array.isArray(p.ids) || !p.ids.length) return null
    return { file: p.file, dir: typeof p.dir === 'string' ? p.dir : undefined, v: p.v, ids: p.ids.filter(x => typeof x === 'string'), deck: !!p.deck }
  } catch { return null }
}

/** What ties a card to the deck, the screen or the cards it was saved
 *  among: a card brought in on its own leaves these behind. */
const ALONE_DROPS = ['deckState', 'deckAnchorId', 'deckOffsetX', 'deckOffsetY', 'deckFaceCard', 'deckInside',
  'nestedDeck', 'ghostSlots', 'deckLastFront', 'deckLock', 'deckKeep', 'railSource', 'railBase'] as const
const ALWAYS_DROPS = ['pin', 'home', 'pinnedLayer', 'linkOf', 'isNew'] as const

/** Bring cards of a saved project onto the canvas as copies, the first of
 *  them centred on `at` (canvas units). One undo step. Returns the new cards. */
export async function bringIn(drag: LibraryDrag, at: { cx: number; cy: number }): Promise<string[]> {
  const res = await fetch(`/api/library/cards?${where(drag)}&v=${drag.v}&ids=${drag.ids.map(encodeURIComponent).join(',')}`)
  if (!res.ok) {
    // The project was saved again since it was listed: list it afresh.
    void useLibraryStore.getState().load()
    return []
  }
  const snapshot = await res.json() as ProjectSnapshot
  const rank = new Map(drag.ids.map((id, i) => [id, i]))
  const groups = (snapshot.groups ?? [])
    .filter(g => !g.linkOf)
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    .map(g => {
      const own = { ...g } as Record<string, unknown>
      for (const k of ALWAYS_DROPS) delete own[k]
      if (!drag.deck) for (const k of ALONE_DROPS) delete own[k]
      return own as unknown as ProjectGroup
    })
  if (!groups.length) return []
  useUndoCoordinator.getState().checkpoint()
  const made = insertProjectSnapshot({ ...snapshot, groups }, at.cy, { keepDecks: true })
  const bs = useBoardsStore.getState()
  const front = bs.groups.find(g => g.id === made[0])
  const rect = front && cardVisualRect(front, bs.boards, 1)?.rect
  if (rect) {
    const dx = at.cx - (rect.left + rect.right) / 2
    const dy = at.cy - (rect.top + rect.bottom) / 2
    const ids = new Set(made)
    bs.setGroupPosBatch(bs.groups.filter(g => ids.has(g.id)).map(g => ({ groupId: g.id, originX: g.originX + dx, originY: g.originY + dy })))
  }
  bs.setSelectedGroup(made[0])
  // Pictures written into the saved file go where this canvas keeps its own.
  if (hasLegacyInlineMedia()) void runInlineMediaMigration().catch(() => {})
  return made
}

// ── A package: this canvas's cards and their files, in one folder ──────────
// (Brian 2026-11-24: "can we set up a package for me to grab when I'm on my
// laptop that has the new cards in this session? I want to copy them on my
// laptop, and then I can at least browse through them.") The folder holds a
// project file and, in `media/`, every picture, video and 3D model its cards
// use, so it reads the same on any machine: copy the folder over, add it to
// the browser's folders there. Nothing on the canvas is changed by it.

export interface PackageResult { dir: string; file: string; cards: number; files: number; missing: number }

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
  'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'model/gltf-binary': 'glb',
}

/** Write every card on the canvas, with its files, to `dir` as `name`. */
export async function packageCanvas(dir: string, name: string, onStep?: (word: string) => void): Promise<PackageResult> {
  const bs = useBoardsStore.getState()
  const primary = bs.boards.primary
  const doc = {
    name, id: crypto.randomUUID(), savedAt: Date.now(),
    projectName: primary?.projectName ?? '', bars: primary?.bars ?? {}, rootIds: primary?.rootIds ?? [],
    extraBoards: bs.boardOrder.map(id => bs.boards[id]).filter(Boolean).map(b => ({ ...b, selectedIds: [], viewerBarId: null })),
    boardOrder: bs.boardOrder,
    groups: bs.groups,
  }
  // Pictures this window holds itself go into the package as files first;
  // the server then gathers the ones that are on disk.
  let text = JSON.stringify(doc)
  const refs = [...new Set(text.match(/mediaref:[\w-]+/g) ?? [])]
  let files = 0, missing = 0
  const d = `d=${encodeURIComponent(dir)}`
  for (const [i, ref] of refs.entries()) {
    onStep?.(`Copying ${i + 1} of ${refs.length}`)
    const blob = await getMedia(mediaRefId(ref)!).catch(() => null)
    if (!blob) { missing++; continue }
    const file = `${mediaRefId(ref)}.${EXT[blob.type] ?? (blob.type.startsWith('video/') ? 'mp4' : blob.type.startsWith('audio/') ? 'mp3' : 'png')}`
    const res = await fetch(`/api/library/package-media?${d}&m=${encodeURIComponent(file)}`, { method: 'POST', body: blob })
    if (!res.ok) {
      if (i === 0) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not write there')
      missing++
      continue
    }
    files++
    text = text.split(`"${ref}"`).join(JSON.stringify(`libmedia:${file}`))
  }
  onStep?.('Writing')
  const res = await fetch(`/api/library/package?${d}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text })
  const out = await res.json().catch(() => ({})) as { dir?: string; file?: string; copied?: number; missing?: number; error?: string }
  if (!res.ok || !out.dir || !out.file) throw new Error(out.error ?? 'Could not write there')
  void useLibraryStore.getState().load()
  return { dir: out.dir, file: out.file, cards: bs.groups.length, files: files + (out.copied ?? 0), missing: missing + (out.missing ?? 0) }
}
