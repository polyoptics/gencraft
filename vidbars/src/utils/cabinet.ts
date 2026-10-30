// cabinet.ts — putting things away in a project cabinet, and taking them out.
//
// Loose cards MOVE: what goes in leaves the canvas stores altogether and is
// kept on the cabinet node (utils/cabinetData), with its own ids, so nothing
// else in the app needs to learn to skip a stowed card. Callers take the undo
// checkpoint: one undo brings back the canvas and the drawer together.
//
// Everything here works in screen space through elementsFromPoint, like link
// drags, so it needs no knowledge of the zoom level or the tilted view.

import { create } from 'zustand'
import { useBoardsStore } from '../store/boardsStore'
import type { BoardData, ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { isTilted, unprojectTilt, useTiltStore } from '../store/tiltStore'
import { canJoinTileDeck, expandTileIds } from './tileDecks'
import { insertProjectSnapshot } from './projectInsert'
import { clientToCanvas } from './fx/createEffect'
import { newCabinetDrawer } from './cabinetData'
import type { CabinetCardItem, CabinetData, CabinetDrawer, CabinetItem, CabinetTileItem } from './cabinetData'
import { getFirstImageUrl } from '../types/bar'

const ENABLED_KEY = 'vidbars.cabinets'
function readEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) !== '0' } catch { return true }
}

interface CabinetUi {
  /** The Cabinets switch: off hides them all and deletes nothing. */
  enabled: boolean
  setEnabled: (on: boolean) => void
  /** The drawer a drag in flight would land in, 'nodeId:drawerId'. */
  aim: string | null
  setAim: (aim: string | null) => void
  /** The drawer whose name is being edited, 'nodeId:drawerId'. */
  renaming: string | null
  setRenaming: (renaming: string | null) => void
  /** A slow step's word on a drawer, or why it failed, by drawer id. */
  busy: Record<string, string>
  setBusy: (drawerId: string, word: string | null) => void
}

export const useCabinetUi = create<CabinetUi>()(set => ({
  enabled: readEnabled(),
  setEnabled: enabled => {
    set({ enabled })
    try { localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0') } catch { /* private window */ }
  },
  aim: null,
  setAim: aim => set(s => (s.aim === aim ? s : { aim })),
  renaming: null,
  setRenaming: renaming => set({ renaming }),
  busy: {},
  setBusy: (drawerId, word) => set(s => {
    const { [drawerId]: _was, ...busy } = s.busy
    return { busy: word ? { ...busy, [drawerId]: word } : busy }
  }),
}))

/** What a drawer is called, and whether that is only its grey default, which
 *  stays until a name is typed over it. */
export function drawerName(d: CabinetDrawer, index: number): { text: string; ghost: boolean } {
  return d.label && !/^Drawer \d+$/.test(d.label)
    ? { text: d.label, ghost: false }
    : { text: `Drawer ${index + 1}`, ghost: true }
}

/** The picture to draw an item by: never a raw video or model url. */
export function itemPicture(item: CabinetItem): string | null {
  if (item.kind === 'tile') {
    const n = item.nodes.find(m => m.id === item.nodes[0].tileDeck?.anchor) ?? item.nodes[0]
    return n.mediaType === 'video' || n.mediaType === 'model' || n.type === 'video' || n.type === 'model' || n.type === 'audio'
      ? n.posterUrl ?? null
      : n.imageUrl
  }
  if (item.thumb) return item.thumb
  for (const b of item.boards) {
    for (const bar of Object.values(b.bars)) {
      const url = getFirstImageUrl(bar.content)
      if (url) return url
    }
  }
  return null
}

/** The words to draw an item by when it has no picture. */
export function itemWords(item: CabinetItem): string {
  if (item.kind === 'tile') return item.nodes[0].text
  const g = item.groups[0]
  if (g.cardSummary || g.cardText) return g.cardText || g.cardSummary || ''
  for (const b of item.boards) {
    for (const bar of Object.values(b.bars)) if (bar.content?.text) return bar.content.text
  }
  return ''
}

// A standing cabinet is not on the flat plane, so a drop on it cannot be judged
// by the flat point the tilted view re-sends (TiltLayer flatHit): that is the
// ground under the ray. It is judged by what the cursor really shows: the real
// pointer, tracked ahead of TiltLayer's listeners, and the browser's own hit
// test, kept before TiltLayer answers it from the flat view.
const nativeHits = document.elementsFromPoint.bind(document)
const realPointer = { x: 0, y: 0 }
for (const type of ['pointerdown', 'pointermove', 'pointerup'] as const) {
  window.addEventListener(type, e => {
    if (e.isTrusted) { realPointer.x = e.clientX; realPointer.y = e.clientY }
  }, true)
}

export interface DrawerRef { nodeId: string; drawerId: string }

/** The drawer under the pointer, or null. The topmost thing wins, as with link
 *  drops: a tile lying over a cabinet takes the release. What is being dragged
 *  (`dragged`, card or tile ids) is always under the hand, so it is skipped. */
export function cabinetDrawerAt(clientX: number, clientY: number, dragged: string[] = []): DrawerRef | null {
  if (!useCabinetUi.getState().enabled) return null
  const hits = isTilted(useTiltStore.getState().tilt)
    ? nativeHits(realPointer.x, realPointer.y)
    : document.elementsFromPoint(clientX, clientY)
  for (const el of hits) {
    const owner = el.closest<HTMLElement>('[data-freenode],[data-group-card]')
    if (owner?.dataset.id && dragged.includes(owner.dataset.id)) continue
    const hit = el.closest<HTMLElement>('[data-cabinet-drawer]')?.dataset.cabinetDrawer
    if (hit) {
      const [nodeId, drawerId] = hit.split(':')
      // A project's drawer takes no loose things.
      return cabinetOf(nodeId)?.drawers.find(d => d.id === drawerId)?.project ? null : { nodeId, drawerId }
    }
    if (owner) return null
  }
  return null
}

/** Show which drawer a drag would land in. */
export function aimCabinet(clientX: number, clientY: number, dragged: string[]) {
  const d = cabinetDrawerAt(clientX, clientY, dragged)
  useCabinetUi.getState().setAim(d ? `${d.nodeId}:${d.drawerId}` : null)
}

function cabinetOf(nodeId: string): CabinetData | undefined {
  return useFreeNodeStore.getState().nodes[nodeId]?.cabinet
}

function writeCabinet(nodeId: string, cabinet: CabinetData) {
  useFreeNodeStore.getState().updateFreeNode(nodeId, { cabinet })
}

function addItems(ref: DrawerRef, items: CabinetItem[]) {
  const c = cabinetOf(ref.nodeId)
  if (!c || items.length === 0) return
  writeCabinet(ref.nodeId, {
    ...c,
    drawers: c.drawers.map(d => d.id === ref.drawerId ? { ...d, items: [...d.items, ...items] } : d),
  })
}

/** A card's box as drawn, in canvas units (CLAUDE.md invariant 3: measure the
 *  render and divide out the camera). Null when it is not on screen. */
function drawnCardSize(id: string): { w: number; h: number } | null {
  const el = document.querySelector(`[data-group-card][data-id="${id}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  const { zoom } = useCanvasStore.getState()
  return r.width > 0 ? { w: r.width / zoom, h: r.height / zoom } : null
}

/** The deck a card belongs to, by its root: a collapsed deck goes in whole. */
function deckRoot(g: ProjectGroup, groups: ProjectGroup[]): string {
  let cur = g
  const seen = new Set<string>()
  while (cur.deckState && cur.deckState !== 'open' && cur.deckAnchorId && cur.deckAnchorId !== cur.id && !seen.has(cur.id)) {
    seen.add(cur.id)
    const next = groups.find(x => x.id === cur.deckAnchorId)
    if (!next) break
    cur = next
  }
  return cur.id
}

/** Put cards away, each with its collapsed deck. Pinned cards and cards held
 *  on a loop strip stay out. At least one card stays on the canvas, as Delete
 *  Card keeps one. Returns whether anything went in. */
export function stowCards(groupIds: string[], ref: DrawerRef): boolean {
  const bs = useBoardsStore.getState()
  const held = new Set(Object.values(useFreeNodeStore.getState().nodes).flatMap(n => n.cardRef ? [n.cardRef] : []))
  const roots = new Set(groupIds.flatMap(id => {
    const g = bs.groups.find(x => x.id === id)
    return g ? [deckRoot(g, bs.groups)] : []
  }))
  const byRoot = new Map<string, ProjectGroup[]>()
  for (const g of bs.groups) {
    const r = deckRoot(g, bs.groups)
    if (roots.has(r)) byRoot.set(r, [...(byRoot.get(r) ?? []), g])
  }
  for (const [r, members] of byRoot) {
    if (members.some(g => g.pin || held.has(g.id))) byRoot.delete(r)
  }
  const going = new Set([...byRoot.values()].flat().map(g => g.id))
  if (going.size === 0 || going.size >= bs.groups.length) return false

  const items: CabinetCardItem[] = [...byRoot.entries()].map(([rootId, members]) => {
    const face = members.find(g => g.id === rootId) ?? members[0]
    const boardIds = members.flatMap(g => g.boardIds)
    const size = drawnCardSize(face.id) ?? { w: 400, h: 240 }
    return {
      id: crypto.randomUUID(),
      kind: 'card',
      name: face.cardHeaderText || face.name || 'Card',
      color: face.color || '#5b8dd9',
      thumb: face.cardHeroImage ?? null,
      x: face.originX, y: face.originY, ...size,
      groups: members,
      boards: boardIds.flatMap(id => bs.boards[id] ? [{ ...bs.boards[id], selectedIds: [], viewerBarId: null }] : []),
      orderedBoardIds: boardIds.filter(id => bs.boardOrder.includes(id)),
    }
  })
  const goingBoards = new Set(items.flatMap(i => i.boards.map(b => b.id)))
  useBoardsStore.setState(s => ({
    boards: Object.fromEntries(Object.entries(s.boards).filter(([id]) => !goingBoards.has(id))),
    boardOrder: s.boardOrder.filter(id => !goingBoards.has(id)),
    groups: s.groups.filter(g => !going.has(g.id)),
    selectedGroupIds: s.selectedGroupIds.filter(id => !going.has(id)),
  }))
  addItems(ref, items)
  return true
}

/** Can this tile go in a drawer? The same tiles that can join a deck: never a
 *  panel, a loop strip, a card on one, or another cabinet. */
export const canStowTile = (n: FreeNodeData | undefined): n is FreeNodeData => canJoinTileDeck(n) && !n.cardRef

/** Put tiles away; a deck face takes what is hidden behind it. */
export function stowTiles(ids: string[], ref: DrawerRef): boolean {
  const fns = useFreeNodeStore.getState()
  const faces = ids.filter(id => canStowTile(fns.nodes[id]))
  if (faces.length === 0) return false
  const taken = new Set<string>()
  const items: CabinetTileItem[] = faces.flatMap(id => {
    if (taken.has(id)) return []
    const n = fns.nodes[id]
    const nodes = expandTileIds([id], fns.nodes).flatMap(m => fns.nodes[m] ? [fns.nodes[m]] : [])
    nodes.forEach(m => taken.add(m.id))
    return [{
      id: crypto.randomUUID(),
      kind: 'tile' as const,
      name: n.label || 'Tile',
      color: n.color,
      thumb: (n.mediaType === 'model' ? n.posterUrl : n.imageUrl) ?? null,
      x: n.x, y: n.y, w: n.width, h: n.height,
      nodes,
    }]
  })
  useFreeNodeStore.setState(s => ({
    nodes: Object.fromEntries(Object.entries(s.nodes).filter(([id]) => !taken.has(id))),
    selectedIds: s.selectedIds.filter(id => !taken.has(id)),
  }))
  addItems(ref, items)
  return true
}

/** Put a selection away: `groupIds` and `nodeIds` are what the menu was opened
 *  on; a selection it is part of goes along. */
export function stowSelection(groupIds: string[], nodeIds: string[], ref: DrawerRef) {
  const fromNode = stowTiles(nodeIds, ref)
  const fromCards = groupIds.length > 0 && stowCards(groupIds, ref)
  return fromNode || fromCards
}

/** Every drawer on the canvas, for the "Put in" menu items. */
export function cabinetTargets(): (DrawerRef & { label: string })[] {
  if (!useCabinetUi.getState().enabled) return []
  const cabinets = Object.values(useFreeNodeStore.getState().nodes).filter(n => n.type === 'cabinet' && !n.pin && n.cabinet)
  return cabinets.flatMap(n => n.cabinet!.drawers.flatMap((d, i) => d.project ? [] : [{
    nodeId: n.id,
    drawerId: d.id,
    label: cabinets.length > 1 ? `${n.label}: ${drawerName(d, i).text}` : drawerName(d, i).text,
  }]))
}

function takeFrom(nodeId: string, drawerId: string, itemId: string): CabinetItem | null {
  const c = cabinetOf(nodeId)
  const item = c?.drawers.find(d => d.id === drawerId)?.items.find(i => i.id === itemId)
  if (!c || !item) return null
  writeCabinet(nodeId, {
    ...c,
    drawers: c.drawers.map(d => d.id === drawerId ? { ...d, items: d.items.filter(i => i.id !== itemId) } : d),
  })
  return item
}

/** Back onto the canvas with its top-left at (x, y). */
function placeItem(item: CabinetItem, x: number, y: number) {
  const dx = x - item.x, dy = y - item.y
  if (item.kind === 'tile') {
    const fns = useFreeNodeStore.getState()
    // Its ids may be taken: a cabinet can be copied, or loaded from a project
    // that is on the canvas too. A copy then comes out under fresh ids.
    const clash = item.nodes.some(n => fns.nodes[n.id])
    const ids = new Map(item.nodes.map(n => [n.id, clash ? crypto.randomUUID() : n.id]))
    useFreeNodeStore.setState(s => {
      const nodes = { ...s.nodes }
      for (const n of item.nodes) {
        const id = ids.get(n.id)!
        nodes[id] = {
          ...n, id, x: n.x + dx, y: n.y + dy,
          ...(n.tileDeck ? { tileDeck: { ...n.tileDeck, anchor: ids.get(n.tileDeck.anchor) ?? n.tileDeck.anchor } } : {}),
        }
      }
      return { nodes }
    })
    return
  }
  const bs = useBoardsStore.getState()
  const clash = item.groups.some(g => bs.groups.some(o => o.id === g.id)) || item.boards.some(b => bs.boards[b.id])
  if (clash) {
    const made = insertProjectSnapshot({ groups: item.groups, extraBoards: item.boards, boardOrder: item.orderedBoardIds }, y)
    useBoardsStore.getState().setGroupPosBatch(useBoardsStore.getState().groups
      .filter(g => made.includes(g.id))
      .map(g => ({ groupId: g.id, originX: g.originX + dx, originY: g.originY })))
    return
  }
  const boards: Record<string, BoardData> = Object.fromEntries(item.boards.map(b => [b.id, b]))
  useBoardsStore.setState(s => ({
    boards: { ...s.boards, ...boards },
    boardOrder: [...s.boardOrder, ...item.orderedBoardIds],
    groups: [...s.groups, ...item.groups.map(g => ({ ...g, originX: g.originX + dx, originY: g.originY + dy }))],
  }))
}

/** A point on screen, in canvas units, seen through the tilt when tilted.
 *  Null off the canvas, or above the horizon. `flat`: the point is already a
 *  flat one, as TiltLayer's re-sent events carry. */
export function canvasPointAt(clientX: number, clientY: number, flat = false): { cx: number; cy: number } | null {
  const host = document.querySelector('[data-tilt-stage="world"]')?.parentElement
  const under = document.elementFromPoint(clientX, clientY)
  // Cards are in their own overlay stage, beside the world's.
  if (!host || !under || !(host.contains(under) || under.closest('[data-tilt-stage]'))) return null
  const t = useTiltStore.getState()
  if (flat || !isTilted(t.tilt)) return clientToCanvas(clientX, clientY)
  const r = host.getBoundingClientRect()
  const mx = r.left + r.width / 2, my = r.top + r.height / 2
  const g = unprojectTilt(clientX - mx, clientY - my, t.tilt, t.spin, t.shiftX, t.shiftY)
  return g ? clientToCanvas(mx + g.x, my + g.y) : null
}

/** Take one thing out, centred on a canvas point. */
export function takeOutAt(nodeId: string, drawerId: string, itemId: string, cx: number, cy: number) {
  const item = takeFrom(nodeId, drawerId, itemId)
  if (item) placeItem(item, cx - item.w / 2, cy - item.h / 2)
}

/** Move one thing to another drawer, in this cabinet or another. */
export function moveItem(from: DrawerRef, itemId: string, to: DrawerRef) {
  if (from.nodeId === to.nodeId && from.drawerId === to.drawerId) return
  const item = takeFrom(from.nodeId, from.drawerId, itemId)
  if (item) addItems(to, [item])
}

export function itemCount(c: CabinetData | undefined): number {
  return c?.drawers.reduce((sum, d) => sum + d.items.length, 0) ?? 0
}

/** Everything back on the canvas, in rows just below the cabinet. */
export function emptyCabinet(nodeId: string) {
  const node = useFreeNodeStore.getState().nodes[nodeId]
  if (!node?.cabinet) return
  const gap = 24
  const rowEnd = node.x + Math.max(node.width * 4, 1600)
  let x = node.x, y = node.y + node.height + gap, rowH = 0
  for (const item of node.cabinet.drawers.flatMap(d => d.items)) {
    if (x > node.x && x + item.w > rowEnd) { x = node.x; y += rowH + gap; rowH = 0 }
    placeItem(item, x, y)
    x += item.w + gap
    rowH = Math.max(rowH, item.h)
  }
  writeCabinet(nodeId, { open: null, drawers: node.cabinet.drawers.map(d => ({ ...d, items: [] })) })
}

/** A plain click on a drawer front opens it, or closes it if open. */
export function toggleDrawer(nodeId: string, drawerId: string) {
  const c = cabinetOf(nodeId)
  if (!c) return
  writeCabinet(nodeId, { ...c, open: c.open === drawerId ? null : drawerId })
}

export function renameDrawer(nodeId: string, drawerId: string, label: string) {
  const c = cabinetOf(nodeId)
  if (c) writeCabinet(nodeId, { ...c, drawers: c.drawers.map(d => d.id === drawerId ? { ...d, label } : d) })
}

export function addDrawer(nodeId: string) {
  const c = cabinetOf(nodeId)
  if (c) writeCabinet(nodeId, { ...c, drawers: [...c.drawers, newCabinetDrawer('')] })
}

/** The last empty drawer goes; one always stays. */
export function removeEmptyDrawer(nodeId: string) {
  const c = cabinetOf(nodeId)
  if (!c || c.drawers.length <= 1) return
  const last = [...c.drawers].reverse().find(d => d.items.length === 0 && !d.project)
  if (last) writeCabinet(nodeId, { ...c, drawers: c.drawers.filter(d => d.id !== last.id), open: c.open === last.id ? null : c.open })
}
