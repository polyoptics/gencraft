// contentKinds.ts — the shared vocabulary for content-kind filtering.
//
// Used by the Rolodex's kind-filter chips, the pinned list objects'
// query evaluation, and (indirectly) the content browser: one definition
// of "does this group/tile hold content of kind K" so a filtered Rolodex,
// a pinned list, and a browser playlist always agree.
//
// Semantics notes:
//  - Group matching inspects the group's OWN boards only (not its deck
//    tree) — the Rolodex lists every group individually, so recursive
//    matching would light up a whole deck for one member's model.
//  - Card hero images do NOT count as 'image' content (decoration; the
//    browser enumeration doesn't browse them either).

import type { ProjectGroup, BoardData } from '../store/boardsStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { getMediaItems } from '../types/bar'

export type ContentKind = 'model' | 'image' | 'video' | 'audio' | 'text'

export const KIND_LABELS: Record<ContentKind | 'all', string> = {
  all: 'All', model: '3D', image: 'Img', video: 'Vid', audio: 'Aud', text: 'Txt',
}

export interface ListQuery {
  query: string
  kind: ContentKind | 'all'
  includeCanvasItems: boolean
  /** Snapshot of the Rolodex sort at pin time; the EMBEDDED rolodex on a
   *  pinned tile edits this in place (its own sort toggle). */
  sortMode: 'creation' | 'alphabetical'
  /** Embedded-rolodex view state, persisted per pinned tile. */
  view?: 'flat' | 'tree'
  collapsedDeckIds?: string[]
}

/** Human summary for list-tile headers, e.g. `3D · “mech”` or `All`. */
export function formatListQuerySummary(q: ListQuery): string {
  const kind = q.kind === 'all' ? 'All' : KIND_LABELS[q.kind]
  const query = q.query.trim()
  return query ? `${kind} · “${query}”` : kind
}

/** True iff the group's OWN boards hold content of `kind`. */
export function groupHasContentOfKind(
  g: ProjectGroup,
  boards: Record<string, BoardData>,
  kind: ContentKind,
): boolean {
  if (kind === 'text' && (g.cardText || g.cardHeaderText)) return true
  for (const bid of g.boardIds) {
    const board = boards[bid]
    if (!board) continue
    for (const bar of Object.values(board.bars)) {
      if (kind === 'text') {
        if (bar.content?.text || bar.content?.headerText) return true
      } else if (getMediaItems(bar.content).some(m => m.type === kind)) {
        return true
      }
    }
  }
  return false
}

/** True iff the free node matches `kind`. Lists index things — they are
 *  not content themselves, so they only appear under 'all'. Media tiles
 *  need real content (imageUrl); empty drop targets only show under 'all'. */
export function freeNodeMatchesKind(n: FreeNodeData, kind: ContentKind | 'all'): boolean {
  if (n.type === 'list') return kind === 'all'
  if (kind === 'all') return true
  if (kind === 'text') return (n.type === 'text' || n.type === 'note') && n.text.trim() !== ''
  return n.type === kind && !!n.imageUrl
}

/** Defensive filter — true iff the group has at least one board with at
 *  least one valid root bar. Mirrors the canvas's validity check in
 *  CardLayer's GroupCard bounds calc; phantom groups are invisible on
 *  canvas, so lists shouldn't show them either. (Moved here from
 *  CardRolodex so the pinned-list evaluator shares it.) */
export function hasRenderableContent(g: ProjectGroup, boards: Record<string, BoardData>): boolean {
  for (const bid of g.boardIds) {
    const board = boards[bid]
    if (!board) continue
    for (const rid of board.rootIds) {
      if (board.bars[rid]) return true
    }
  }
  return false
}

/** Sort groups by the Rolodex sort mode. Returns a copy. 'creation'
 *  preserves array order (boardsStore appends new groups at the end).
 *  (Moved here from CardRolodex so the pinned-list evaluator shares it.) */
export function sortGroups(arr: ProjectGroup[], sortMode: 'creation' | 'alphabetical'): ProjectGroup[] {
  if (sortMode === 'alphabetical') {
    return [...arr].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }
  return [...arr]
}

/** Sort free nodes by the Rolodex sort mode (labels ↔ names). */
export function sortFreeNodes(arr: FreeNodeData[], sortMode: 'creation' | 'alphabetical'): FreeNodeData[] {
  if (sortMode === 'alphabetical') {
    return [...arr].sort((a, b) => (a.label || '').localeCompare(b.label || ''))
  }
  return [...arr]
}
