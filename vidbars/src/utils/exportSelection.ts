// Export to new project (Brian 2026-11-24: "take a bunch of nodes from the
// canvas and export them to their own project ... draw a big box around
// everything for selecting them ... and then say 'Export to new project'").
//
// ONE RULE: you get what you boxed, plus everything it points at, all the
// way down. Never the other way round: a card does not bring the chart,
// scene or faction that points at IT. The same rule as a card dragged out of
// the Card Browser's SAVED list (utils/library cardsPointedAt).
//
// What points at what:
//  - a card: the cards linked onto it, its members, the cards its chart,
//    scene sections and 3D set name, the card a detail stands on it, and,
//    for a linked card, its master (cardsPointedAt);
//  - a closed deck is one card: its front brings every card closed under it;
//  - a tile: every card it names (a storyline's dots and its chart card, a
//    3D set's card), and, for a loop strip, what is docked on it.
// Sitting in an open deck is not a link: only the cards boxed go.
//
// The new project is a saved project of COPIES with the same ids, written
// beside the others; the canvas and its cards are not touched.

import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { zoomZonesSnapshot } from '../store/zoomZonesStore'
import { isHiddenDeckMember } from '../hooks/useCardDecks'
import { cardsPointedAt, useLibraryStore } from './library'
import { collectKeep } from './cardKeep'

export interface ExportPick { cards: string[]; tiles: string[] }
export interface ExportPlan { picked: ExportPick; linked: ExportPick }

/** What a menu's "Export to new project" acts on: everything selected, cards
 *  and tiles, when the thing right-clicked is among it; else that thing. */
export function exportPickFor(kind: 'card' | 'tile', id: string): ExportPick {
  const cards = useBoardsStore.getState().selectedGroupIds
  const tiles = useFreeNodeStore.getState().selectedIds
  if ((kind === 'card' ? cards : tiles).includes(id)) return { cards: [...cards], tiles: [...tiles] }
  return kind === 'card' ? { cards: [id], tiles: [] } : { cards: [], tiles: [id] }
}

/** The cards a tile names, anywhere in it. Not what a 3D set opened over
 *  (`under`): that lay there before it and is not on it. */
function cardsNamedBy(n: FreeNodeData, isCard: Set<string>): string[] {
  const out = new Set<string>()
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { if (isCard.has(v)) out.add(v); return }
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (!v || typeof v !== 'object') return
    for (const [k, x] of Object.entries(v)) if (k !== 'under') walk(x)
  }
  walk(n)
  return [...out]
}

/** What `pick` takes with it under the one rule: itself (a closed deck
 *  whole), and everything it points at, nearest first. */
export function exportPlan(pick: ExportPick): ExportPlan {
  const { groups, boards } = useBoardsStore.getState()
  const nodes = useFreeNodeStore.getState().nodes
  const isCard = new Set(groups.map(g => g.id))
  const points = cardsPointedAt({ groups, boards })
  // The cards closed under each card: a closed deck is one card.
  const closedUnder = new Map<string, string[]>()
  for (const g of groups) if (isHiddenDeckMember(g)) closedUnder.set(g.deckAnchorId!, [...(closedUnder.get(g.deckAnchorId!) ?? []), g.id])
  const dockedOn = new Map<string, string[]>()
  for (const n of Object.values(nodes)) { const r = n.railDock?.railId; if (r) dockedOn.set(r, [...(dockedOn.get(r) ?? []), n.id]) }

  const cards = new Set<string>(), tiles = new Set<string>()
  const line: ['card' | 'tile', string][] = []
  const add = (kind: 'card' | 'tile', id: string) => {
    const seen = kind === 'card' ? cards : tiles
    if (seen.has(id) || !(kind === 'card' ? isCard.has(id) : nodes[id])) return
    seen.add(id); line.push([kind, id])
  }
  const run = (from: number) => {
    for (let i = from; i < line.length; i++) {
      const [kind, id] = line[i]
      if (kind === 'card') {
        for (const c of closedUnder.get(id) ?? []) add('card', c)
        for (const c of points.get(id) ?? []) add('card', c)
      } else {
        for (const c of cardsNamedBy(nodes[id], isCard)) add('card', c)
        for (const t of dockedOn.get(id) ?? []) add('tile', t)
      }
    }
  }
  // What was boxed, each closed deck whole: that is "picked".
  pick.cards.forEach(id => add('card', id))
  pick.tiles.forEach(id => add('tile', id))
  for (let i = 0; i < line.length; i++) if (line[i][0] === 'card') for (const c of closedUnder.get(line[i][1]) ?? []) add('card', c)
  const picked: ExportPick = { cards: [...cards], tiles: [...tiles] }
  run(0)
  const was = { cards: new Set(picked.cards), tiles: new Set(picked.tiles) }
  return { picked, linked: { cards: [...cards].filter(id => !was.cards.has(id)), tiles: [...tiles].filter(id => !was.tiles.has(id)) } }
}

/** What ties a card to a deck whose front stayed behind. */
const DECK_TIES = ['deckState', 'deckAnchorId', 'deckOffsetX', 'deckOffsetY', 'deckFaceCard', 'deckInside',
  'nestedDeck', 'deckLastFront', 'deckLock', 'deckKeep'] as const

/** The file a project named `name` is saved as (the save's own rule). */
export const projectFileOf = (name: string) => `${(name || 'snapshot').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`

/** The saved projects there are, by file: a name already used is refused,
 *  never written over. */
export async function savedProjectFiles(): Promise<Set<string>> {
  const list = await fetch('/api/snapshots/list').then(r => r.json()) as { file: string }[]
  return new Set(list.map(s => s.file.toLowerCase()))
}

/** The project document for `plan`: the save's own shape (TemplateMenu
 *  getCurrentSnapshot), holding only these cards and tiles. */
export function exportDocument(plan: ExportPlan, name: string) {
  const bs = useBoardsStore.getState()
  const cs = useCanvasStore.getState()
  const nodes = useFreeNodeStore.getState().nodes
  const cards = new Set([...plan.picked.cards, ...plan.linked.cards])
  const tiles = new Set([...plan.picked.tiles, ...plan.linked.tiles])
  const fronts = new Set(bs.groups.flatMap(g => cards.has(g.id) && isHiddenDeckMember(g) && cards.has(g.deckAnchorId!) ? [g.deckAnchorId!] : []))
  const groups = bs.groups.filter(g => cards.has(g.id)).map(g => {
    // Its deck's front stayed behind (it came as a linked card): it is out
    // of that deck, a loose card, still the front of what is closed under it.
    if (!g.deckAnchorId || g.deckAnchorId === g.id || cards.has(g.deckAnchorId)) return g
    const own = { ...g } as Record<string, unknown>
    for (const k of fronts.has(g.id) ? ['deckAnchorId', 'deckOffsetX', 'deckOffsetY'] as const : DECK_TIES) delete own[k]
    return own as unknown as ProjectGroup
  })
  const used = new Set(groups.flatMap(g => g.boardIds))
  const primary = used.has('primary') ? bs.boards.primary : undefined
  const bars = primary?.bars ?? {}
  const allBars = Object.values(bars)
  const boardOrder = bs.boardOrder.filter(id => used.has(id) && bs.boards[id])
  const content = {
    projectName: primary?.projectName ?? name,
    bars,
    rootIds: primary?.rootIds ?? [],
    pan: cs.pan,
    boardPos: cs.boardPos,
    zoom: cs.zoom,
    canvasWidth: allBars.length > 0 ? Math.max(...allBars.map(b => b.x + b.width)) : 800,
    nleRowHeight: cs.nleRowHeight,
    extraBoards: boardOrder.map(id => ({ ...bs.boards[id], selectedIds: [], viewerBarId: null })) as BoardData[],
    boardOrder,
    groups,
    freeNodes: Object.fromEntries(Object.entries(nodes).filter(([id]) => tiles.has(id))),
    zoomZones: zoomZonesSnapshot(),
  }
  return { name, id: crypto.randomUUID(), savedAt: Date.now(), ...content, keep: collectKeep(cards, tiles, JSON.stringify(content)) }
}

/** Save `plan` as a new project named `name`. The canvas is not changed.
 *  Refused when a project of that name is already saved. */
export async function exportToNewProject(plan: ExportPlan, name: string): Promise<{ file: string } | { error: string }> {
  const clean = name.trim()
  if (!clean) return { error: 'Give it a name' }
  try {
    if ((await savedProjectFiles()).has(projectFileOf(clean).toLowerCase())) return { error: 'A saved project already has that name' }
    const res = await fetch('/api/snapshots/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportDocument(plan, clean)),
    })
    const out = await res.json().catch(() => ({})) as { file?: string }
    if (!res.ok || !out.file) return { error: 'Could not save it' }
    // The Card Browser's SAVED list shows it at once.
    void useLibraryStore.getState().load()
    return { file: out.file }
  } catch {
    return { error: 'Could not save it' }
  }
}
