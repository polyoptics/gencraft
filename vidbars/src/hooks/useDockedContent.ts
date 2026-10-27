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
  // computeAllDocks is gone from here on purpose: cards used to get their
  // own single-assignment pass, which is exactly why they did not cluster.
  computeTileClusters,
  viewportVisualRect,
  type DockableItem, type WindowRect,
} from '../utils/viewportDocking'
import {
  collectDeckContent, collectGroupOwnContent, groupHasBrowsableContent,
  tileBrowseItem, isDockableTile, type BrowseItem,
} from '../utils/contentTraversal'
import { evaluateListQuery } from '../utils/listQueryEval'
import { poolFeedingList } from '../utils/componentLinks'
import { getPoolContents } from '../store/poolStore'
import { formatListQuerySummary } from '../utils/contentKinds'
import { useCanvasStore } from '../store/canvasStore'
import { isHiddenDeckMember, expandWithNestedMembers, cardVisualRect } from './useCardDecks'
import { getFirstImageUrl } from '../types/bar'
import { tileDeckIndex, tileDeckMembers } from '../utils/tileDecks'
import { isDocked } from '../utils/rail'

export interface DockedSource {
  kind: 'tile' | 'card' | 'list'
  id: string                    // nodeId | groupId
  name: string
  /** Chip visual: tile → poster/image ref; card → hero image; null → glyph. */
  face: string | null
  items: BrowseItem[]           // tiles: exactly one; lists: query results
}

const GROUP_PREFIX = 'group:'

/** Window rects within ONE placement. Cross-placement docking still does
 *  not exist — a canvas window and a pinned one are nowhere near each other
 *  in any sense the user can see — but WITHIN the pinned stratum things
 *  dock exactly as they do on the canvas, so a row composed on screen keeps
 *  working. A pinned window's x/y are the stale pre-pin position, so its
 *  live rect comes from `pin` instead.
 *
 *  Tolerance needs no adjustment between the two: DOCK_TOLERANCE is 16
 *  canvas units on the canvas, and the pinned stratum IS screen space, so
 *  the same number reads as 16 screen pixels there. Both are right for
 *  their own space, which is why callers leave the default alone —
 *  placementCarry relies on that agreement too. */
function windowRects(
  windows: Record<string, ViewportWindow3D>, pinned: boolean, zoom: number,
): WindowRect[] {
  return Object.values(windows)
    .filter(w => !!w.pin === pinned)
    // Header included — see viewportVisualRect. Docking against the bare
    // win.y put tiles under the header rather than level with its top.
    .map(w => viewportVisualRect(w, zoom))
}

/** Dockable tiles as cluster items — content-bearing tiles + list tiles
 *  (isDockableTile is THE shared predicate). `hidden`: tiles collapsed
 *  behind a deck face (tileDeckIndex) — not geometry, so they take no part;
 *  the face's rect stands for its deck, as a stacked card deck's does.
 *  Loop strips take no part either (utils/rail): a rail carries no content
 *  of its own, and its docked cards overlap and touch by design — one of
 *  them near a Viewer would hand the Viewer the whole rail's cast and tray
 *  as one cluster, and a dragging Viewer would carry cards the rail places
 *  (and would put straight back). */
function contentTileItems(
  nodes: Record<string, FreeNodeData>, pinned: boolean, hidden: Set<string>,
): DockableItem[] {
  return Object.values(nodes)
    // One placement at a time — a pinned tile's x/y are its stale pre-pin
    // position, so it contributes its screen rect instead. Guarding at this
    // one site keeps the two strata from ever seeing each other across the
    // ENTIRE docking graph: dock strips, cluster affordances, and
    // computeCarriedEntities, which decides what a dragging Viewer takes.
    .filter(n => !!n.pin === pinned && !hidden.has(n.id) && isDockableTile(n)
      && n.type !== 'rail' && !isDocked(n, nodes))
    .map(n => (n.pin
      ? { id: n.id, x: n.pin.x, y: n.pin.y, width: n.width * n.pin.scale, height: n.height * n.pin.scale }
      : { id: n.id, x: n.x, y: n.y, width: n.width, height: n.height }))
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

  // A Rolodex magneted to a Media Pool browses THAT POOL, so what it
  // contributes to a Viewer docked on its other side is the pool's files.
  // This is the middle link of the Pool | Rolodex | Viewer chain: none of
  // the three knows about the others, they are just adjacent.
  const pool = poolFeedingList(n, nodes)
  if (pool) {
    const files = getPoolContents(pool.id).files
    const search = q.query.trim().toLowerCase()
    return files
      .filter(f => q.kind === 'all' || f.kind === q.kind)
      .filter(f => !search || f.name.toLowerCase().includes(search))
      .map(f => ({
        kind: 'media' as const,
        mediaType: f.kind,
        url: f.url,
        name: f.name,
      }))
  }

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
    // This window's own placement picks the stratum everything is read in.
    const pinned = !!windows[windowId]?.pin
    const winRects = windowRects(windows, pinned, zoom)
    if (!winRects.some(w => w.id === windowId)) return []

    const out: DockedSource[] = []

    // ONE cluster graph over tiles AND cards.
    //
    // Tiles already clustered deck-style — touch one and the whole chain
    // connects — but cards were a separate pass that only saw DIRECT contact
    // with the window. So a card touching a docked tile was ignored, and a
    // card touching a docked card was ignored, which made the rule feel
    // arbitrary: the same gesture worked or didn't depending on what you had
    // bundled. Cards are in the same graph now, so a bundle of touching
    // things is browsable through whichever member the Viewer reaches.
    //
    // Cards are canvas content with world coordinates, so they can only
    // participate in the CANVAS stratum; a pinned Viewer sees tiles only.
    const deckIdx = tileDeckIndex(nodes)
    const clusterItems = pinned
      ? contentTileItems(nodes, pinned, deckIdx.hidden)
      : [...contentTileItems(nodes, pinned, deckIdx.hidden), ...contentGroupItems(groups, boards, zoom)]
    const clusters = computeTileClusters(clusterItems, winRects)
    const connected = clusters.byWindow.get(windowId) ?? []

    for (const tid of connected) {
      if (tid.startsWith(GROUP_PREFIX)) continue     // handled below
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
      // A collapsed tile deck docks by its face but offers EVERYTHING in
      // it, face first — the way a stacked card deck docked to a Viewer
      // browses every card, not just the one on top. Collapsing a row of
      // pictures beside a Viewer therefore changes nothing it can show.
      const tiles = deckIdx.faces.has(n.id) ? tileDeckMembers(n.id, nodes) : [n]
      for (const t of tiles) {
        const item = tileBrowseItem(t)
        if (!item) continue
        out.push({
          kind: 'tile', id: t.id,
          name: t.label || (item.kind === 'media' ? item.mediaType : 'Text'),
          face: tileFace(t),
          items: [item],
        })
      }
    }

    // Cards/decks, from the SAME cluster walk — BFS order, so the things
    // nearest the window come first regardless of kind.
    for (const cid of connected) {
      if (!cid.startsWith(GROUP_PREFIX)) continue
      const gid = cid.slice(GROUP_PREFIX.length)
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
  const pinned = !!windows[windowId]?.pin
  const carryZoom = useCanvasStore.getState().zoom
  const winRects = windowRects(windows, pinned, carryZoom)
  const win = winRects.find(w => w.id === windowId)
  if (!win) return { tileIds: [], groupIds: [] }

  // The SAME combined walk the browser uses. What a Viewer carries and what
  // it can show have to be the same set, or dragging one leaves behind
  // something it was displaying a moment ago.
  const zoom = useCanvasStore.getState().zoom
  // Visible tiles only. A carried FACE needs no expanding here: the move
  // itself (moveManyFreeNodes) brings the tiles hidden behind it.
  const { hidden } = tileDeckIndex(nodes)
  const clusterItems = pinned
    ? contentTileItems(nodes, pinned, hidden)
    : [...contentTileItems(nodes, pinned, hidden), ...contentGroupItems(bs.groups, bs.boards, zoom)]
  const clusters = computeTileClusters(clusterItems, winRects)
  const connected = clusters.byWindow.get(windowId) ?? []
  const tileIds = connected.filter(id => !id.startsWith(GROUP_PREFIX))

  // A pinned window drags across the screen and cannot take cards with it.
  if (pinned) return { tileIds, groupIds: [] }

  // Cards reached through the cluster — no separate direct-touch pass, which
  // is what used to make carrying and browsing disagree.
  const direct: string[] = connected
    .filter(id => id.startsWith(GROUP_PREFIX))
    .map(id => id.slice(GROUP_PREFIX.length))
  const groupIds = expandWithNestedMembers(direct, bs.groups)
  return { tileIds, groupIds }
}
