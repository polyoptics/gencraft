// useDockedModels.ts — DERIVE what's connected to a viewport window.
//
// Nothing is stored: connections are pure geometry.
//  - TILES cluster deck-style (computeTileClusters): tiles touching each
//    other join a cluster; the whole cluster is connected to a window when
//    any member touches it. One chip per tile.
//  - CARDS/DECKS connect by direct slot touch (groupSlot vs window rect).
//    One chip per card, exposing ALL its recursive models (traversal order).
// Each source binds to at most one window; models dedupe by url across the
// flattened list (first source wins).

import { useMemo } from 'react'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import type { ProjectGroup, BoardData } from '../store/boardsStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { useViewport3DStore } from '../store/viewport3dStore'
import type { ViewportWindow3D } from '../store/viewport3dStore'
import {
  computeAllDocks, computeTileClusters, rectsTouch, DOCK_TOLERANCE,
  type DockableItem, type WindowRect,
} from '../utils/viewportDocking'
import { collectDeckModels, groupHasModels } from '../utils/modelTraversal'
import { groupSlot } from '../utils/nlePush'
import { computeGroupLayout } from '../utils/nleRows'
import { isHiddenDeckMember, expandWithNestedMembers } from './useCardDecks'
import { getModelPoster } from '../three/posterService'
import { getFirstImageUrl } from '../types/bar'

export interface DockedSourceModel {
  url: string
  posterUrl?: string | null
  name: string
}

export interface DockedSource {
  kind: 'tile' | 'card'
  id: string                    // nodeId | groupId
  name: string
  /** Chip visual: tile → poster ref; card → hero image (any url form). */
  face: string | null
  models: DockedSourceModel[]   // tiles: exactly one
}

const GROUP_PREFIX = 'group:'

function windowRects(windows: Record<string, ViewportWindow3D>): WindowRect[] {
  return Object.values(windows).map(w => ({ id: w.id, x: w.x, y: w.y, width: w.width, height: w.height }))
}

function modelTileItems(nodes: Record<string, FreeNodeData>): DockableItem[] {
  return Object.values(nodes)
    .filter(n => n.type === 'model' && n.imageUrl)
    .map(n => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height }))
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

/** Model-bearing visible groups as dockable items (slot rects). */
function modelGroupItems(
  groups: ProjectGroup[],
  boards: Record<string, BoardData>,
): DockableItem[] {
  const items: DockableItem[] = []
  for (const g of groups) {
    if (isHiddenDeckMember(g)) continue
    if (!groupHasModels(g.id, groups, boards)) continue
    const slot = groupSlot(g.id, g.boardIds, boards, g.originX, g.originY, computeGroupLayout(g.boardIds, boards))
    if (!slot) continue
    items.push({ id: GROUP_PREFIX + g.id, x: slot.left, y: slot.top, width: slot.right - slot.left, height: slot.bottom - slot.top })
  }
  return items
}

/** Ordered sources connected to `windowId`. */
export function useDockedSources(windowId: string): DockedSource[] {
  const windows = useViewport3DStore(s => s.windows)
  const nodes = useFreeNodeStore(s => s.nodes)
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)

  return useMemo(() => {
    const winRects = windowRects(windows)
    if (!winRects.some(w => w.id === windowId)) return []

    const out: DockedSource[] = []

    // Tiles: cluster-connected, BFS order from the window
    const clusters = computeTileClusters(modelTileItems(nodes), winRects)
    for (const tid of clusters.byWindow.get(windowId) ?? []) {
      const n = nodes[tid]
      if (!n?.imageUrl) continue
      out.push({
        kind: 'tile', id: n.id, name: n.label || 'Model',
        face: n.posterUrl ?? getModelPoster(n.imageUrl),
        models: [{ url: n.imageUrl, posterUrl: n.posterUrl ?? getModelPoster(n.imageUrl), name: n.label || 'Model' }],
      })
    }

    // Cards/decks: direct slot touch, single-assignment partition
    const groupDocks = computeAllDocks(winRects, modelGroupItems(groups, boards)).get(windowId) ?? []
    for (const d of groupDocks) {
      const gid = d.id.slice(GROUP_PREFIX.length)
      const g = groups.find(x => x.id === gid)
      if (!g) continue
      const models = collectDeckModels(gid, groups, boards).map(m => ({
        url: m.url, posterUrl: m.posterUrl ?? getModelPoster(m.url), name: m.name,
      }))
      if (models.length === 0) continue
      out.push({ kind: 'card', id: gid, name: g.name || 'Card', face: cardFace(g, boards), models })
    }

    return out
  }, [windowId, windows, nodes, groups, boards])
}

/** Flattened, url-deduped model list (first source wins) — what the window
 *  can show; drives active-model reconciliation. */
export function flattenSourceModels(sources: DockedSource[]): DockedSourceModel[] {
  const seen = new Set<string>()
  const out: DockedSourceModel[] = []
  for (const s of sources) {
    for (const m of s.models) {
      if (seen.has(m.url)) continue
      seen.add(m.url)
      out.push(m)
    }
  }
  return out
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

  const clusters = computeTileClusters(modelTileItems(nodes), winRects)
  const tileIds = clusters.byWindow.get(windowId) ?? []

  const direct: string[] = []
  for (const g of bs.groups) {
    if (isHiddenDeckMember(g)) continue
    if (!groupHasModels(g.id, bs.groups, bs.boards)) continue
    const slot = groupSlot(g.id, g.boardIds, bs.boards, g.originX, g.originY, computeGroupLayout(g.boardIds, bs.boards))
    if (!slot) continue
    const rect = { x: slot.left, y: slot.top, width: slot.right - slot.left, height: slot.bottom - slot.top }
    if (rectsTouch(rect, win, DOCK_TOLERANCE)) direct.push(g.id)
  }
  const groupIds = expandWithNestedMembers(direct, bs.groups)
  return { tileIds, groupIds }
}
