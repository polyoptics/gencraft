// useDockedContent.ts — DERIVE what's connected to a content-browser
// window (renamed from useDockedModels; the browser now carries ALL
// content kinds, not just models).
//
// Nothing is stored: connections are pure geometry.
//  - TILES cluster deck-style (computeTileClusters): content-bearing tiles
//    touching each other join a cluster; the whole cluster is connected to
//    a window when any member touches it. One chip per tile.
//  - CARDS/DECKS connect by direct slot touch (cardVisualRect vs window
//    rect). One chip per card, exposing ALL its recursive browsable
//    content (traversal order).
// Each source binds to at most one window; items dedupe by activeItemKey
// across the flattened list (first source wins).

import { useMemo } from 'react'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import type { ProjectGroup, BoardData } from '../store/boardsStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { useViewport3DStore, activeItemKey } from '../store/viewport3dStore'
import type { ViewportWindow3D } from '../store/viewport3dStore'
import {
  computeAllDocks, computeTileClusters, rectsTouch, DOCK_TOLERANCE,
  type DockableItem, type WindowRect,
} from '../utils/viewportDocking'
import {
  collectDeckContent, collectGroupOwnContent, groupHasBrowsableContent,
  tileBrowseItem, isDockableTile, type BrowseItem,
} from '../utils/contentTraversal'
import { evaluateListQuery } from '../utils/listQueryEval'
import { formatListQuerySummary } from '../utils/contentKinds'
import { useCanvasStore } from '../store/canvasStore'
import { isHiddenDeckMember, expandWithNestedMembers, cardVisualRect } from './useCardDecks'
import { getFirstImageUrl } from '../types/bar'

export interface DockedSource {
  kind: 'tile' | 'card' | 'list'
  id: string                    // nodeId | groupId
  name: string
  /** Chip visual: tile → poster/image ref; card → hero image; null → glyph. */
  face: string | null
  items: BrowseItem[]           // tiles: exactly one; lists: query results
}

const GROUP_PREFIX = 'group:'

function windowRects(windows: Record<string, ViewportWindow3D>): WindowRect[] {
  return Object.values(windows)
    // A screen-pinned window is not canvas geometry: its x/y are the stale
    // pre-pin position, so leaving it in would dock tiles to where it used
    // to be. Cross-placement docking does not exist.
    .filter(w => !w.pin)
    .map(w => ({ id: w.id, x: w.x, y: w.y, width: w.width, height: w.height }))
}

/** Dockable tiles as cluster items — content-bearing tiles + list tiles
 *  (isDockableTile is THE shared predicate). */
function contentTileItems(nodes: Record<string, FreeNodeData>): DockableItem[] {
  return Object.values(nodes)
    // Screen-pinned tiles are not canvas geometry. Guarding at this one
    // site keeps a pinned panel's stale rect out of the ENTIRE docking
    // graph — dock strips, cluster affordances, and computeCarriedEntities,
    // which decides what a dragging Viewer takes with it.
    .filter(n => !n.pin && isDockableTile(n))
    .map(n => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height }))
}

/** A list tile's contribution: matched groups' OWN content (no deck
 *  expansion — the list enumerates every matched group individually, so
 *  recursive collection would double-count matched members) + matched
 *  tiles' items; the list's kind filter applies to the contributed items
 *  (a "3D objects" list contributes only models). */
function listSourceItems(
  n: FreeNodeData,
  groups: ProjectGroup[],
  boards: Record<string, BoardData>,
  nodes: Record<string, FreeNodeData>,
): BrowseItem[] {
  const q = n.listQuery
  if (!q) return []
  const res = evaluateListQuery(q, groups, boards, nodes)
  const kindAccepts = (it: BrowseItem): boolean => {
    if (q.kind === 'all') return true
    if (q.kind === 'text') return it.kind === 'text'
    return it.kind === 'media' && it.mediaType === q.kind
  }
  const out: BrowseItem[] = []
  for (const g of res.groups) {
    for (const it of collectGroupOwnContent(g, boards)) {
      if (kindAccepts(it)) out.push(it)
    }
  }
  for (const t of res.freeNodes) {
    const it = tileBrowseItem(t)
    if (it && kindAccepts(it)) out.push(it)
  }
  return out
}

/** Chip face for a tile: model poster / image url / video-audio poster;
 *  text tiles get null (glyph fallback). */
function tileFace(n: FreeNodeData): string | null {
  const item = tileBrowseItem(n)
  if (!item || item.kind === 'text') return null
  if (item.mediaType === 'image') return item.url
  return item.posterUrl ?? null
}

/** Card face for chips — same fallback chain as CardLayer's heroImage. */
function cardFace(g: ProjectGroup, boards: Record<string, BoardData>): string | null {
  if (g.cardHeroImage) return g.cardHeroImage
  for (const bid of g.boardIds) {
    const board = boards[bid]
    if (!board) continue
    for (const rid of board.rootIds) {
      const img = getFirstImageUrl(board.bars[rid]?.content)
      if (img) return img
    }
  }
  return null
}

/** Content-bearing visible groups as dockable items — the shared CARD-
 *  level visual rect (cardVisualRect), matching the snap geometry exactly
 *  so a card that looks flush IS docked. Zoom-aware like deck clustering. */
function contentGroupItems(
  groups: ProjectGroup[],
  boards: Record<string, BoardData>,
  zoom: number,
): DockableItem[] {
  const items: DockableItem[] = []
  for (const g of groups) {
    if (isHiddenDeckMember(g)) continue
    if (!groupHasBrowsableContent(g.id, groups, boards)) continue
    const v = cardVisualRect(g, boards, zoom)
    if (!v) continue
    items.push({
      id: GROUP_PREFIX + g.id,
      x: v.rect.left, y: v.rect.top,
      width: v.rect.right - v.rect.left, height: v.rect.bottom - v.rect.top,
    })
  }
  return items
}

/** Ordered sources connected to `windowId`. */
export function useDockedSources(windowId: string): DockedSource[] {
  const windows = useViewport3DStore(s => s.windows)
  const nodes = useFreeNodeStore(s => s.nodes)
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  // Zoom-reactive like useCardDecks: card dock geometry follows the
  // visual card bounds, which include the zoom-dependent header extend.
  const zoom = useCanvasStore(s => s.zoom)

  return useMemo(() => {
    const winRects = windowRects(windows)
    if (!winRects.some(w => w.id === windowId)) return []

    const out: DockedSource[] = []

    // Tiles: cluster-connected, BFS order from the window
    const clusters = computeTileClusters(contentTileItems(nodes), winRects)
    for (const tid of clusters.byWindow.get(windowId) ?? []) {
      const n = nodes[tid]
      if (!n) continue
      if (n.type === 'list' && n.listQuery) {
        const items = flattenDedupe(listSourceItems(n, groups, boards, nodes))
        out.push({
          kind: 'list', id: n.id,
          name: n.label || formatListQuerySummary(n.listQuery),
          face: null,
          items,
        })
        continue
      }
      const item = tileBrowseItem(n)
      if (!item) continue
      out.push({
        kind: 'tile', id: n.id,
        name: n.label || (item.kind === 'media' ? item.mediaType : 'Text'),
        face: tileFace(n),
        items: [item],
      })
    }

    // Cards/decks: direct slot touch, single-assignment partition
    const groupDocks = computeAllDocks(winRects, contentGroupItems(groups, boards, zoom)).get(windowId) ?? []
    for (const d of groupDocks) {
      const gid = d.id.slice(GROUP_PREFIX.length)
      const g = groups.find(x => x.id === gid)
      if (!g) continue
      const items = collectDeckContent(gid, groups, boards)
      if (items.length === 0) continue
      out.push({ kind: 'card', id: gid, name: g.name || 'Card', face: cardFace(g, boards), items })
    }

    return out
  }, [windowId, windows, nodes, groups, boards, zoom])
}

/** Key-dedupe within one item list (a list source can match a card that
 *  contributes the same media twice via legacy fields, etc.). */
function flattenDedupe(items: BrowseItem[]): BrowseItem[] {
  const seen = new Set<string>()
  const out: BrowseItem[] = []
  for (const it of items) {
    const key = activeItemKey(it)!
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

/** Flattened, key-deduped item list (first source wins) — what the window
 *  can show; drives active-item reconciliation. */
export function flattenSourceItems(sources: DockedSource[]): BrowseItem[] {
  return flattenDedupe(sources.flatMap(s => s.items))
}

/** Non-hook: everything a moving window must CARRY — its connected tile
 *  cluster(s) plus docked groups (expanded with nested deck members).
 *  Snapshotted at header-drag start; the same dx/dy applies to all. */
export function computeCarriedEntities(windowId: string): { tileIds: string[]; groupIds: string[] } {
  const windows = useViewport3DStore.getState().windows
  const nodes = useFreeNodeStore.getState().nodes
  const bs = useBoardsStore.getState()
  const winRects = windowRects(windows)
  const win = winRects.find(w => w.id === windowId)
  if (!win) return { tileIds: [], groupIds: [] }

  const clusters = computeTileClusters(contentTileItems(nodes), winRects)
  const tileIds = clusters.byWindow.get(windowId) ?? []

  const zoom = useCanvasStore.getState().zoom
  const direct: string[] = []
  for (const g of bs.groups) {
    if (isHiddenDeckMember(g)) continue
    if (!groupHasBrowsableContent(g.id, bs.groups, bs.boards)) continue
    const v = cardVisualRect(g, bs.boards, zoom)
    if (!v) continue
    const rect = { x: v.rect.left, y: v.rect.top, width: v.rect.right - v.rect.left, height: v.rect.bottom - v.rect.top }
    if (rectsTouch(rect, win, DOCK_TOLERANCE)) direct.push(g.id)
  }
  const groupIds = expandWithNestedMembers(direct, bs.groups)
  return { tileIds, groupIds }
}
