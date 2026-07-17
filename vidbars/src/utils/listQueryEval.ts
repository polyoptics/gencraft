// listQueryEval.ts — evaluate a pinned list object's LIVE query against
// the current stores. Composed from the same predicates the Rolodex uses
// (utils/contentKinds.ts), so a pinned list's results ALWAYS equal what
// the Rolodex showed when it was pinned (modulo project changes — that's
// the point: the query is live).
//
// Ordering = rolodex order: groups first (sorted by the query's
// snapshotted sortMode), then matching free tiles as a tail. Lists never
// match lists (a list's results are content; another list is not).

import type { ProjectGroup, BoardData } from '../store/boardsStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import {
  type ListQuery, groupHasContentOfKind, freeNodeMatchesKind,
  hasRenderableContent, sortGroups, sortFreeNodes,
} from './contentKinds'

export interface ListQueryResult {
  groups: ProjectGroup[]
  freeNodes: FreeNodeData[]
}

export function evaluateListQuery(
  q: ListQuery,
  groups: ProjectGroup[],
  boards: Record<string, BoardData>,
  nodes: Record<string, FreeNodeData>,
): ListQueryResult {
  const query = q.query.trim().toLowerCase()

  const matchedGroups = groups.filter(g =>
    hasRenderableContent(g, boards) &&
    (!query || (g.name || '').toLowerCase().includes(query)) &&
    (q.kind === 'all' || groupHasContentOfKind(g, boards, q.kind)))

  const matchedNodes = q.includeCanvasItems
    ? Object.values(nodes).filter(n =>
        n.type !== 'list' &&   // lists never match lists
        freeNodeMatchesKind(n, q.kind) &&
        (!query || (n.label || '').toLowerCase().includes(query)))
    : []

  return {
    groups: sortGroups(matchedGroups, q.sortMode),
    freeNodes: sortFreeNodes(matchedNodes, q.sortMode),
  }
}
