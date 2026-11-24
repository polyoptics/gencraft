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
import { CARD_FLOOR_ZOOM } from '../components/NLE/NLETimelineHeader'
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
import { collectKeep } from './cardKeep'

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
  /** How deep in its deck: 0 a card on its own or a deck's front card, 1 a
   *  card of that deck, 2 a card of a deck inside it, and so on. */
  level: number
  /** On the front card of a deck, or of a deck inside a deck: every card of
   *  it, this one first. */
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

/** One card of a deck as the library lists it. */
interface DeckEntry {
  id: string
  /** How deep in the deck it lies: 0 its front card, 1 a card of the deck,
   *  2 a card of a deck inside that deck, and so on down. */
  level: number
  /** On a deck's or a deck-inside's front card: its cards, this one first. */
  deck?: string[]
}

/** A project's cards as its decks: each a list of cards, front card first;
 *  a card on its own is a list of one. Closed decks by what they record,
 *  open decks by their cards touching, as on the canvas. A deck inside a
 *  deck is listed under its own front card, to any depth (Brian 2026-11-24:
 *  "when i see decks in the card browser. i need to se sub decks now too"). */
function decksOf(p: LibraryProject): DeckEntry[][] {
  const cards = p.groups.filter(g => !g.linkOf && hasRenderableContent(g, p.boards))
  const byId = new Map(cards.map(g => [g.id, g]))
  // The cards folded away in a closed deck, each under the card it is put
  // away under: the deck's front card, or the front card of a deck inside.
  const under = new Map<string, ProjectGroup[]>()
  const shown: ProjectGroup[] = []
  for (const g of cards) {
    if (!isHiddenDeckMember(g)) { shown.push(g); continue }
    let top: ProjectGroup | undefined = g
    for (let i = 0; i < 20 && top && isHiddenDeckMember(top); i++) top = byId.get(top.deckAnchorId!)
    if (!top || isHiddenDeckMember(top)) { shown.push(g); continue }
    under.set(g.deckAnchorId!, [...(under.get(g.deckAnchorId!) ?? []), g])
  }
  // Nearest the front card first, as the deck fans.
  const reach = (g: ProjectGroup) => Math.hypot(g.deckOffsetX ?? 0, g.deckOffsetY ?? 0)
  /** A card and all that is put away under it, at `level` and below. */
  const tree = (g: ProjectGroup, level: number): DeckEntry[] => {
    const kids = [...(under.get(g.id) ?? [])].sort((a, b) => reach(a) - reach(b)).flatMap(k => tree(k, level + 1))
    return [{ id: g.id, level, deck: kids.length ? [g.id, ...kids.map(k => k.id)] : undefined }, ...kids]
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
    .map(m => {
      // One card showing: a card, or a closed deck with its own tree.
      if (m.length === 1) return tree(shown[m[0]], 0)
      // An open deck: its first card fronts all of it; a closed deck lying
      // in it is a deck inside, under its own front card.
      const [front, ...rest] = m.map(i => shown[i])
      const mine = tree(front, 1).slice(1)
      const others = rest.flatMap(g => tree(g, 1))
      return [{ id: front.id, level: 0, deck: [front.id, ...mine.map(e => e.id), ...others.map(e => e.id)] }, ...mine, ...others]
    })
}

const decksCache = new WeakMap<LibraryProject, DeckEntry[][]>()

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
    for (const entries of decks) {
      const fresh = entries.filter(e => {
        const g = byId.get(e.id)!
        // A new canvas's first card has the same id in every project: told
        // apart by how much is on it as well.
        const k = `${e.id}|${g.name}|${/^[0-9a-f-]{36}$/.test(e.id) ? '' : g.boardIds.map(b => Object.keys(p.boards[b]?.bars ?? {}).length).join(',')}`
        return seen.has(k) ? false : (seen.add(k), true)
      })
      const here = new Set(fresh.map(e => e.id))
      fresh.forEach((e, i) => {
        // The deck's front card was listed from a newer save: the next card
        // stands in front of what is left.
        const deck = (i === 0 ? fresh.map(x => x.id) : e.deck?.filter(id => here.has(id)))
        out.push({
          key: `${p.dir ?? ''}|${p.file}|${e.id}`, project: p, group: byId.get(e.id)!,
          level: i === 0 ? 0 : Math.max(1, e.level),
          deck: deck && deck.length > 1 ? deck : undefined,
        })
      })
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
const ALWAYS_DROPS = ['pin', 'home', 'pinnedLayer', 'isNew'] as const

// ── The cards linked to a card come with it ────────────────────────────────
// (Brian 2026-11-24: "if i drag out a parent card the children should follow
// -- if i grab a ship out, i need the model or w/e else too.") A card's
// children are the cards it points at: the ones linked onto it (the drop
// target owns the link, so they are in its own list), the card a detail
// stands on it, a faction's or family's members, a chart's cards, the cards
// in a scene card's sections and on a 3D set, and, for a linked copy, the
// card it is a copy of. Theirs come too, all the way down. Never the other
// way: a card does not bring the cards that point at IT.

const isId = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)

/** Under `v`, every card named by a `card`, `cards`, `links`, `deck` or
 *  `opens` entry: how a chart, a scene card's sections and a 3D set name the
 *  cards they hold. */
function namedCards(v: unknown, out: string[]): void {
  if (Array.isArray(v)) { for (const x of v) namedCards(x, out); return }
  if (!v || typeof v !== 'object') return
  for (const [k, x] of Object.entries(v)) {
    if (k === 'card' && typeof x === 'string') out.push(x)
    // A scene section's own scene card (`opens`) and every card of the deck
    // let go on it as its cast (`deck`, not its front alone) come as well.
    else if (k === 'opens' && typeof x === 'string') out.push(x)
    else if ((k === 'cards' || k === 'links' || k === 'deck') && Array.isArray(x)) { for (const y of x) { if (typeof y === 'string') out.push(y) } }
    else namedCards(x, out)
  }
}

const childrenCache = new WeakMap<LibraryProject, Map<string, string[]>>()

/** Each card of a saved project with the cards it points at. */
function childrenOf(p: LibraryProject): Map<string, string[]> {
  let all = childrenCache.get(p)
  if (!all) childrenCache.set(p, all = cardsPointedAt(p))
  return all
}

/** Each of these cards with the cards it points at: the one rule for what
 *  comes along with a card, out of a saved project or off the canvas
 *  (utils/exportSelection). */
export function cardsPointedAt(p: { groups: ProjectGroup[]; boards: Record<string, BoardData> }): Map<string, string[]> {
  const all = new Map<string, string[]>()
  const has = new Set(p.groups.map(g => g.id))
  const ownerOfBoard = new Map(p.groups.flatMap(g => (g.boardIds ?? []).map(b => [b, g.id] as const)))
  for (const g of p.groups) {
    const ids: string[] = [...(g.linkedGroupIds ?? [])]
    // A block or an element linked onto the card brings the card it is on.
    const refs = [
      ...(g.linkedRefs ?? []),
      ...(g.boardIds ?? []).flatMap(b => {
        const board = p.boards[b]
        return board ? [...(board.linkedRefs ?? []), ...Object.values(board.bars ?? {}).flatMap(bar => bar.linkedRefs ?? [])] : []
      }),
    ]
    for (const r of refs) {
      const id = r.kind === 'group' ? r.id : ownerOfBoard.get(r.kind === 'board' ? r.id : r.boardId)
      if (id) ids.push(id)
    }
    for (const d of g.details ?? []) { const c = (d as { link?: { card?: unknown } }).link?.card; if (typeof c === 'string') ids.push(c) }
    namedCards(g.chart, ids)
    namedCards(g.scene, ids)
    namedCards(g.area3d, ids)
    if (g.linkOf) ids.push(g.linkOf)
    all.set(g.id, [...new Set(ids)].filter(id => id !== g.id && has.has(id)))
  }
  return all
}

/** The cards that come along with `ids` and are not among them: everything
 *  those cards point at, and what those point at, nearest first. */
export function linkedAlong(p: LibraryProject, ids: string[]): string[] {
  const kids = childrenOf(p)
  const seen = new Set(ids)
  const out: string[] = []
  const line = [...ids]
  for (let i = 0; i < line.length; i++) {
    for (const k of kids.get(line[i]) ?? []) {
      if (seen.has(k)) continue
      seen.add(k); out.push(k); line.push(k)
    }
  }
  return out
}

/** `v` with every card id in `map` swapped for what it maps to, as a value
 *  and as an entry's name (who reports to whom is listed by card id). */
function swapIds<T>(v: T, map: Map<string, string>): T {
  if (typeof v === 'string') return (map.get(v) ?? v) as unknown as T
  if (Array.isArray(v)) {
    let same = true
    const out = v.map(x => { const y = swapIds(x, map); if (y !== x) same = false; return y })
    return same ? v : out as unknown as T
  }
  if (!v || typeof v !== 'object') return v
  let same = true
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) {
    const y = swapIds(x, map), nk = map.get(k) ?? k
    if (y !== x || nk !== k) same = false
    out[nk] = y
  }
  return same ? v : out as T
}

/** Clear of a card and of touching it: the space left between a brought-in
 *  card and the linked cards set beside it. */
const ALONG_GAP = 80
/** The same between one line of them and the next: a card's header strip
 *  counts as far up as it is ever drawn when cards are judged to touch
 *  (hooks/useCardDecks DECK_HEADER), so a line lies further off than that. */
const ALONG_LINE_GAP = 20 / CARD_FLOOR_ZOOM + ALONG_GAP
/** How many linked cards lie side by side before the next line of them. */
const ALONG_PER_LINE = 8

/** Bring cards of a saved project onto the canvas as copies, the first of
 *  them centred on `at` (canvas units), with the cards linked to them set
 *  beside them, or closed under them where they were saved so. One undo step. Returns the new cards, the dragged first. */
export async function bringIn(drag: LibraryDrag, at: { cx: number; cy: number }): Promise<string[]> {
  const project = useLibraryStore.getState().projects.find(p => idOf(p) === idOf(drag))
  const along = project ? linkedAlong(project, drag.ids) : []
  const res = await fetch(`/api/library/cards?${where(drag)}&v=${drag.v}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...drag.ids, ...along] }),
  })
  if (!res.ok) {
    // The project was saved again since it was listed: list it afresh.
    void useLibraryStore.getState().load()
    return []
  }
  const snapshot = await res.json() as ProjectSnapshot
  const dragged = new Set(drag.ids)
  const rank = new Map([...drag.ids, ...along].map((id, i) => [id, i]))
  const came = new Set((snapshot.groups ?? []).map(g => g.id))
  const saved = (snapshot.groups ?? [])
    // A linked copy comes only with the card it is a copy of.
    .filter(g => !g.linkOf || (!dragged.has(g.id) && came.has(g.linkOf)))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
  // A card put away under a card that is coming too stays put away under it
  // (Brian 2026-11-24: "so i can pull out a single ship card with its
  // model": the 3D model card closed under the ship comes closed under it).
  const savedIds = new Set(saved.map(g => g.id))
  const under = new Map(saved.flatMap(g => isHiddenDeckMember(g) && savedIds.has(g.deckAnchorId!) ? [[g.id, g.deckAnchorId!] as const] : []))
  const fronts = new Set(under.values())
  const groups = saved.map(g => {
    const own = { ...g } as Record<string, unknown>
    for (const k of ALWAYS_DROPS) delete own[k]
    if ((drag.deck && dragged.has(g.id)) || under.has(g.id) || fronts.has(g.id)) {
      // Still in its deck; out of the deck that one was in, if that stayed.
      if (!under.has(g.id) && g.deckAnchorId && g.deckAnchorId !== g.id && !savedIds.has(g.deckAnchorId)) for (const k of ['deckAnchorId', 'deckOffsetX', 'deckOffsetY'] as const) delete own[k]
      for (const k of ['deckLastFront', 'deckLock', 'deckFaceCard', 'railSource'] as const) {
        if (typeof own[k] === 'string' && !savedIds.has(own[k] as string)) delete own[k]
      }
    } else {
      // The rest come as loose cards, whatever deck they were in.
      for (const k of ALONE_DROPS) delete own[k]
    }
    return own as unknown as ProjectGroup
  })
  if (!groups.some(g => dragged.has(g.id))) return []
  useUndoCoordinator.getState().checkpoint()
  const made = insertProjectSnapshot({ ...snapshot, groups }, at.cy, { keepDecks: true })
  // The copies name one another, not the cards they were copied from. The
  // links were seen to already; this is every other way a card names a card
  // (a chart's cards, a scene's, who reports to whom, a copy's own card).
  const fresh = new Map(groups.map((g, i) => [g.id, made[i]]))
  const byName = new Map([...fresh].filter(([old]) => isId(old)))
  const mine = new Set(made)
  useBoardsStore.setState(s => ({
    groups: s.groups.map(g => {
      if (!mine.has(g.id)) return g
      const next = swapIds(g, byName)
      return next.linkOf && fresh.has(next.linkOf) ? { ...next, linkOf: fresh.get(next.linkOf) } : next
    }),
  }))
  const bs = useBoardsStore.getState()
  const rectOf = (id: string) => {
    const g = bs.groups.find(x => x.id === id)
    // A card with nothing on it yet has no face to measure: a card's worth.
    return g ? cardVisualRect(g, bs.boards, 1)?.rect ?? { left: g.originX, top: g.originY, right: g.originX + 400, bottom: g.originY + 300 } : null
  }
  const moves = new Map<string, { dx: number; dy: number }>()
  const rect = rectOf(made[0])
  if (rect) {
    const dx = at.cx - (rect.left + rect.right) / 2
    const dy = at.cy - (rect.top + rect.bottom) / 2
    // Cards that touched in the saved project are a deck there, and come as
    // one: each lot keeps its own arrangement (Brian 2026-11-24: "some decks
    // pull out as separated cards on the canvas too, we need to maintain the
    // deck/subdeck w/e relationship"). Cards put away under one go with it.
    const out = groups.flatMap((g, i) => {
      if (under.has(g.id)) return []
      const card = bs.groups.find(x => x.id === made[i])
      const r = rectOf(made[i])
      return card && r ? [{ id: g.id, r, touch: deckTouchRect(card, bs.boards, 1) }] : []
    })
    const lot = out.map((_, i) => i)
    const find = (i: number): number => (lot[i] === i ? i : (lot[i] = find(lot[i])))
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i].touch, b = out[j].touch
        if (a && b && rectsTouch(a, b, DECK_TOUCH_TOLERANCE)) lot[find(j)] = find(i)
      }
    }
    const lots = new Map<number, typeof out>()
    out.forEach((c, i) => { const k = find(i); lots.set(k, [...(lots.get(k) ?? []), c]) })
    const box = (cs: typeof out) => ({
      left: Math.min(...cs.map(c => c.r.left)), right: Math.max(...cs.map(c => c.r.right)),
      top: Math.min(...cs.map(c => c.r.top)), bottom: Math.max(...cs.map(c => c.r.bottom)),
    })
    // What was dragged, and what touched it, lies under the pointer.
    let right = -Infinity
    const beside: (typeof out)[] = []
    for (const cs of lots.values()) {
      if (!cs.some(c => dragged.has(c.id))) { beside.push(cs); continue }
      for (const c of cs) moves.set(c.id, { dx, dy })
      right = Math.max(right, box(cs).right + dx)
    }
    // The other linked cards, wherever they lay in the saved project, are
    // set out beside it: lot by lot, clear of it and of each other.
    const top0 = rect.top + dy
    let left = right + ALONG_GAP, top = top0, lineBottom = top0, n = 0
    for (const cs of beside) {
      const r = box(cs)
      if (n > 0 && n % ALONG_PER_LINE === 0) { left = right + ALONG_GAP; top = lineBottom + ALONG_LINE_GAP }
      n++
      for (const c of cs) moves.set(c.id, { dx: left - r.left, dy: top - r.top })
      left += r.right - r.left + ALONG_GAP
      lineBottom = Math.max(lineBottom, top + r.bottom - r.top)
    }
    // A card put away under another goes where that one goes.
    const moveOf = (id: string) => {
      let top = id
      for (let i = 0; i < 20 && !moves.has(top) && under.has(top); i++) top = under.get(top)!
      return moves.get(top)
    }
    const old = new Map(groups.map((g, i) => [made[i], g.id]))
    bs.setGroupPosBatch(bs.groups.flatMap(g => {
      const m = old.has(g.id) ? moveOf(old.get(g.id)!) : undefined
      return m ? [{ groupId: g.id, originX: g.originX + m.dx, originY: g.originY + m.dy }] : []
    }))
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
  const content = {
    name, id: crypto.randomUUID(), savedAt: Date.now(),
    projectName: primary?.projectName ?? '', bars: primary?.bars ?? {}, rootIds: primary?.rootIds ?? [],
    extraBoards: bs.boardOrder.map(id => bs.boards[id]).filter(Boolean).map(b => ({ ...b, selectedIds: [], viewerBarId: null })),
    boardOrder: bs.boardOrder,
    groups: bs.groups,
  }
  // What is kept beside the cards goes with them (utils/cardKeep).
  const doc = { ...content, keep: collectKeep(bs.groups.map(g => g.id), [], JSON.stringify(content)) }
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
