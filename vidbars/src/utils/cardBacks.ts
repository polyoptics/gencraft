// cardBacks.ts — reading card backs, for the windows that work from them
// (Brian 2026-11-06): the Attributes window and the card Prompt Pad.
//
// A card's back is a list of name / value rows (utils/cardTypes). Both
// windows read the backs of the cards FED to them, and feeding is the same
// for both, worked out from where things are, never stored:
//  - cards docked on the window: touching it, and the cards touching those
//    (a deck), as the Film Look mixer reads its shot cards (filmShots);
//  - a Card Browser magneted to the window: every card its search shows,
//    so "character" in the browser feeds every character card.
// A linked card (a chart's copy) is its master shown again: it is read,
// and edited, as its master.

import { useEffect, useState } from 'react'
import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { adjacentPanels } from './componentLinks'
import { dockedCards } from './filmShots'
import { browserScope } from './browserScope'
import { groupMatchesQuery, groupMatchesTypes, groupHasContentOfKind, hasRenderableContent, sortGroups, formatListQuerySummary } from './contentKinds'
import { detailShown, newDetailId, type CardDetail } from './cardTypes'

/** What feeds a window. */
export interface CardFeed {
  /** Every card it reads, in order (docked first, then the browser's), once. */
  ids: string[]
  /** How many of those are docked on it. */
  docked: number
  /** The Card Browser magneted to it, if any: its node and what it shows. */
  browser: { nodeId: string; label: string; count: number } | null
}

const EMPTY_FEED: CardFeed = { ids: [], docked: 0, browser: null }

/** The card a card stands for: its master when it is a linked copy. */
function masterOf(g: ProjectGroup, byId: Map<string, ProjectGroup>): ProjectGroup {
  return (g.linkOf && byId.get(g.linkOf)) || g
}

/** The cards a Card Browser's search shows (not the decks it adds around a
 *  match to show where it lives: only the matches themselves). */
export function browserCards(list: FreeNodeData, groups: ProjectGroup[], boards: Record<string, BoardData>): ProjectGroup[] {
  const q = list.listQuery
  if (!q) return []
  const kind = q.kind
  // Cards docked on the browser scope what it shows (utils/browserScope).
  const scope = browserScope(list, groups, boards)
  const hits = groups.filter(g =>
    hasRenderableContent(g, boards) && !g.linkOf && (!scope || scope.ids.has(g.id)) &&
    groupMatchesQuery(g, q.query) && groupMatchesTypes(g, q.cardTypes) &&
    (kind === 'all' || groupHasContentOfKind(g, boards, kind)))
  return sortGroups(hits, q.sortMode)
}

/** Everything that feeds the window `node`, now. */
export function cardFeed(node: FreeNodeData, nodes: Record<string, FreeNodeData>, groups: ProjectGroup[], boards: Record<string, BoardData>): CardFeed {
  const byId = new Map(groups.map(g => [g.id, g]))
  const seen = new Set<string>()
  const ids: string[] = []
  const add = (g: ProjectGroup) => {
    const m = masterOf(g, byId)
    if (seen.has(m.id)) return
    seen.add(m.id)
    ids.push(m.id)
  }
  // Docked: only on the canvas (a pinned window has left the cards' canvas).
  if (!node.pin) dockedCards(node, groups, boards).forEach(add)
  const docked = ids.length
  let browser: CardFeed['browser'] = null
  const list = adjacentPanels(node, nodes).find(n => n.type === 'list')
  if (list) {
    const hits = browserCards(list, groups, boards)
    hits.forEach(add)
    browser = { nodeId: list.id, label: list.listQuery ? formatListQuerySummary(list.listQuery) : 'All', count: hits.length }
  }
  return { ids, docked, browser }
}

const sameFeed = (a: CardFeed, b: CardFeed) =>
  a.docked === b.docked && a.ids.length === b.ids.length && a.ids.every((id, i) => id === b.ids[i])
  && a.browser?.nodeId === b.browser?.nodeId && a.browser?.label === b.browser?.label && a.browser?.count === b.browser?.count

/** The feed of window `nodeId`, worked out again a beat after anything moves
 *  (not on every frame of a drag). */
export function useCardFeed(nodeId: string): CardFeed {
  const [feed, setFeed] = useState<CardFeed>(EMPTY_FEED)
  useEffect(() => {
    let t = 0
    const work = () => {
      const nodes = useFreeNodeStore.getState().nodes
      const node = nodes[nodeId]
      if (!node) return
      const { groups, boards } = useBoardsStore.getState()
      const next = cardFeed(node, nodes, groups, boards)
      setFeed(prev => (sameFeed(prev, next) ? prev : next))
    }
    const later = () => { window.clearTimeout(t); t = window.setTimeout(work, 120) }
    work()
    const a = useBoardsStore.subscribe(later)
    const b = useFreeNodeStore.subscribe(later)
    return () => { window.clearTimeout(t); a(); b() }
  }, [nodeId])
  return feed
}

// ── Fields: the same name on many backs ──

/** A detail name as fields are told apart: same letters, any case, spaces
 *  trimmed. Nothing cleverer: "Class" and "Role" are two fields until you
 *  merge them. */
export const fieldKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ')

export interface FieldUse {
  card: ProjectGroup
  detail: CardDetail
  /** What the back shows for it (a linked value followed). */
  shown: string
}

export interface Field {
  key: string
  /** How most cards spell it. */
  name: string
  /** Every other spelling in use (different case or spacing). */
  spellings: string[]
  uses: FieldUse[]
  /** Uses with something in them. */
  filled: number
}

/** Every field on the backs of `cards`, the most used first. */
export function fieldsOf(cards: ProjectGroup[], groups: ProjectGroup[]): Field[] {
  const map = new Map<string, { names: Map<string, number>; uses: FieldUse[] }>()
  for (const card of cards) {
    const mine = new Set<string>()
    for (const d of card.details ?? []) {
      const key = fieldKey(d.name)
      if (!key || mine.has(key)) continue
      mine.add(key)
      let f = map.get(key)
      if (!f) map.set(key, f = { names: new Map(), uses: [] })
      const nm = d.name.trim()
      f.names.set(nm, (f.names.get(nm) ?? 0) + 1)
      f.uses.push({ card, detail: d, shown: detailShown(groups, d).text })
    }
  }
  const out: Field[] = []
  for (const [key, f] of map) {
    const names = [...f.names.entries()].sort((a, b) => b[1] - a[1])
    out.push({
      key, name: names[0][0], spellings: names.slice(1).map(n => n[0]),
      uses: f.uses, filled: f.uses.filter(u => u.shown.trim()).length,
    })
  }
  return out.sort((a, b) => (b.uses.length - a.uses.length) || a.name.localeCompare(b.name))
}

/** Shared by most of the cards: on at least half of them (and more than one). */
export const isCommon = (f: Field, total: number) => f.uses.length > 1 && f.uses.length * 2 >= total

// ── Editing many backs at once (one undo each) ──

function editBacks(cardIds: string[], fn: (details: CardDetail[], card: ProjectGroup) => CardDetail[] | null): void {
  const bs = useBoardsStore.getState()
  const byId = new Map(bs.groups.map(g => [g.id, g]))
  const patches: [string, CardDetail[]][] = []
  for (const id of cardIds) {
    const g = byId.get(id)
    if (!g) continue
    const next = fn(g.details ?? [], g)
    if (next) patches.push([id, next])
  }
  if (!patches.length) return
  useUndoCoordinator.getState().checkpoint()
  for (const [id, d] of patches) bs.setGroupDetails(id, d)
}

/** One card's detail value. */
export function setDetailValue(cardId: string, detailId: string, value: string): void {
  editBacks([cardId], ds => {
    const d = ds.find(x => x.id === detailId)
    if (!d || d.value === value) return null
    return ds.map(x => x.id === detailId ? { ...x, value } : x)
  })
}

/** Field `key` called `name` on every card of `cardIds` that has it. */
export function renameField(cardIds: string[], key: string, name: string): void {
  const nm = name.trim()
  if (!nm) return
  editBacks(cardIds, ds => ds.some(d => fieldKey(d.name) === key && d.name !== nm)
    ? ds.map(d => fieldKey(d.name) === key ? { ...d, name: nm } : d) : null)
}

/** Field `from` folded into field `into` (named `intoName`) on every card:
 *  a card with only `from` has it renamed; a card with both keeps `into`
 *  and loses `from`, its value kept too: in `into` when that is empty,
 *  else after it ("Runner, Courier"), so nothing written is lost. */
export function mergeFields(cardIds: string[], from: string, into: string, intoName: string): void {
  if (from === into) return
  editBacks(cardIds, ds => {
    const a = ds.find(d => fieldKey(d.name) === from)
    if (!a) return null
    const b = ds.find(d => fieldKey(d.name) === into)
    if (!b) return ds.map(d => d === a ? { ...d, name: intoName } : d)
    const av = a.value.trim(), bv = b.value.trim()
    const next = b.link ? b
      : !bv ? { ...b, value: a.value, link: a.link }
      : av && av.toLowerCase() !== bv.toLowerCase() ? { ...b, value: `${bv}, ${av}` }
      : b
    return ds.filter(d => d !== a).map(d => d === b ? next : d)
  })
}

/** Field `name` added, empty, to every card of `cardIds` without it. */
export function addField(cardIds: string[], name: string): void {
  const nm = name.trim()
  const key = fieldKey(nm)
  if (!key) return
  editBacks(cardIds, ds => ds.some(d => fieldKey(d.name) === key) ? null
    : [...ds, { id: newDetailId(), name: nm, value: '' }])
}

/** Field `key` taken off every card of `cardIds`. */
export function removeField(cardIds: string[], key: string): void {
  editBacks(cardIds, ds => ds.some(d => fieldKey(d.name) === key)
    ? ds.filter(d => fieldKey(d.name) !== key) : null)
}

// ── Tags: a value read as a list ──

/** A value read as tags: each comma-separated phrase is one (Brian 2026-11-06), new lines too. */
export function tagsOf(value: string): string[] {
  return value.split(/[,\n]+/).map(s => s.trim()).filter(Boolean)
}
