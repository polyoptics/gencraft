// modelTraversal.ts — enumerate the 3D models inside a card/deck's
// recursive content, in a stable, author-meaningful order.
//
// Order: root group first, then deck descendants breadth-first (siblings
// sorted left→right by deck offset / origin, then id for determinism);
// within a group: boardIds order; within a board: DFS from rootIds via
// bar.children (the AUTHORED order — Object.keys(bars) is insertion-
// order noise); within a bar: content.media order, type === 'model'.
//
// ONLY bar media can hold models — card heroes and block thumbnails are
// images by construction (Phase-1 ingestion routes model files away from
// them), which keeps this traversal complete.

import type { ProjectGroup, BoardData } from '../store/boardsStore'
import { getMediaItems } from '../types/bar'

export interface DeckModelRef {
  url: string
  posterUrl?: string
  name: string
  groupId: string
  boardId: string
  barId: string
}

/** Root + transitive deckAnchorId descendants, breadth-first. Same
 *  fixed-point expansion as boardsStore.getTransitiveDescendantIds /
 *  countMeaningfulContent (both private to their modules). */
function expandDeckTree(rootGroupId: string, groups: ProjectGroup[]): ProjectGroup[] {
  const byId = new Map(groups.map(g => [g.id, g]))
  const root = byId.get(rootGroupId)
  if (!root) return []
  const result: ProjectGroup[] = [root]
  const seen = new Set([rootGroupId])
  let frontier = [rootGroupId]
  while (frontier.length > 0) {
    const children = groups
      .filter(g => g.deckAnchorId && frontier.includes(g.deckAnchorId) && !seen.has(g.id))
      .sort((a, b) =>
        ((a.deckOffsetX ?? a.originX ?? 0) - (b.deckOffsetX ?? b.originX ?? 0)) ||
        a.id.localeCompare(b.id))
    for (const c of children) { seen.add(c.id); result.push(c) }
    frontier = children.map(c => c.id)
  }
  return result
}

/** All models inside `rootGroupId`'s recursive content, in stable order. */
export function collectDeckModels(
  rootGroupId: string,
  groups: ProjectGroup[],
  boards: Record<string, BoardData>,
): DeckModelRef[] {
  const out: DeckModelRef[] = []
  for (const g of expandDeckTree(rootGroupId, groups)) {
    for (const boardId of g.boardIds) {
      const board = boards[boardId]
      if (!board) continue
      // Authored DFS over the bar tree
      const stack = [...(board.rootIds ?? [])]
      const visited = new Set<string>()
      while (stack.length > 0) {
        const barId = stack.shift()!
        if (visited.has(barId)) continue
        visited.add(barId)
        const bar = board.bars[barId]
        if (!bar) continue
        for (const m of getMediaItems(bar.content)) {
          if (m.type === 'model') {
            out.push({
              url: m.url,
              posterUrl: m.posterUrl,
              name: m.originalName ?? bar.name ?? 'Model',
              groupId: g.id, boardId, barId,
            })
          }
        }
        // Children next, before later roots — insert at the front (DFS)
        stack.unshift(...(bar.children ?? []))
      }
    }
  }
  return out
}

/** Fast-exit predicate for gating deck-drag magnet work. */
export function groupHasModels(
  rootGroupId: string,
  groups: ProjectGroup[],
  boards: Record<string, BoardData>,
): boolean {
  for (const g of expandDeckTree(rootGroupId, groups)) {
    for (const boardId of g.boardIds) {
      const board = boards[boardId]
      if (!board) continue
      for (const bar of Object.values(board.bars)) {
        if (getMediaItems(bar.content).some(m => m.type === 'model')) return true
      }
    }
  }
  return false
}
