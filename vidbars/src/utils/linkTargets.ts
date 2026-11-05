// linkTargets — what a link is allowed to point at, and how to name it.
//
// Links used to run card-to-card only, which made "a link" and "a group id"
// the same thing. They are not: a reference can point at a whole card, at one
// block inside it, or at a single element on a board — the three things the
// three zoom layers show. This module is the one place that knows the set,
// so adding a fourth kind later is an edit here plus its renderer, not a
// hunt through every consumer.
//
// The DROP TARGET owns the reference (dropping A onto B means B references
// A). That convention predates this file and is unchanged; all that widens
// is what A and B may be.

import type { ProjectGroup, BoardData } from '../store/boardsStore'
import type { Bar } from '../types/bar'
import { cardTitle } from './faceStyle'

export type LinkRef =
  | { kind: 'group'; id: string }
  | { kind: 'board'; id: string }
  /** Bars are only unique WITHIN a board, so a bar reference is a pair.
   *  Storing just the barId would silently resolve to a different element
   *  after a board duplicate. */
  | { kind: 'bar'; id: string; boardId: string }

/** Stable identity for dedupe, React keys, and equality — never parse this
 *  back apart, use the object. */
export function refKey(r: LinkRef): string {
  return r.kind === 'bar' ? `bar:${r.boardId}:${r.id}` : `${r.kind}:${r.id}`
}

export function sameRef(a: LinkRef, b: LinkRef): boolean {
  return refKey(a) === refKey(b)
}

/** The `data-link-drop` attribute value for a target. The drag pipeline reads
 *  these off the DOM, so this and `parseRef` are a matched pair and must stay
 *  that way — see LinkDragOverlay. */
export function refAttr(r: LinkRef): string {
  return refKey(r)
}

/** Inverse of refAttr. Returns null for anything unrecognised rather than
 *  guessing, so a stale attribute can never resolve to a real entity. */
export function parseRef(attr: string | null | undefined): LinkRef | null {
  if (!attr) return null
  const parts = attr.split(':')
  if (parts[0] === 'group' && parts[1]) return { kind: 'group', id: parts[1] }
  if (parts[0] === 'board' && parts[1]) return { kind: 'board', id: parts[1] }
  if (parts[0] === 'bar' && parts[1] && parts[2]) {
    return { kind: 'bar', id: parts[2], boardId: parts[1] }
  }
  // Legacy: "card:<groupId>" and "chip:<groupId>" both mean a group. The card
  // layer has emitted these since before blocks and bars were linkable.
  if ((parts[0] === 'card' || parts[0] === 'chip') && parts[1]) {
    return { kind: 'group', id: parts[1] }
  }
  return null
}

/** What the chip says and what colour it is. Returns null when the referent
 *  no longer exists — callers render nothing rather than a chip pointing at
 *  a deleted thing. */
export function resolveRef(
  r: LinkRef,
  groups: ProjectGroup[],
  boards: Record<string, BoardData>,
): { label: string; color: string; kind: LinkRef['kind'] } | null {
  if (r.kind === 'group') {
    const g = groups.find(x => x.id === r.id)
    if (!g) return null
    return { label: cardTitle(groups, g) || 'card', color: g.color || '#5b8dd9', kind: 'group' }
  }
  if (r.kind === 'board') {
    const b = boards[r.id]
    if (!b) return null
    return {
      label: b.layers?.block?.label || b.projectName || 'block',
      color: b.color || '#5b8dd9',
      kind: 'board',
    }
  }
  const board = boards[r.boardId]
  const bar = board?.bars?.[r.id]
  if (!bar) return null
  return {
    label: bar.name || bar.content?.headerText || 'element',
    color: bar.color || '#5b8dd9',
    kind: 'bar',
  }
}

/** Every reference an owner holds, as one list.
 *
 *  Groups keep their original `linkedGroupIds` — card-to-card links have been
 *  written there since before other kinds existed, and a dozen consumers read
 *  it directly. Rewriting that into `linkedRefs` would have meant a store
 *  migration over the user's saved work to buy nothing, so group referents
 *  stay where they are and `linkedRefs` carries the kinds that had nowhere to
 *  live. Reading is the union; nothing downstream needs to know. */
export function ownerRefs(owner: ProjectGroup | BoardData | Bar): LinkRef[] {
  const legacy: LinkRef[] = 'linkedGroupIds' in owner && Array.isArray(owner.linkedGroupIds)
    ? owner.linkedGroupIds.map(id => ({ kind: 'group' as const, id }))
    : []
  const modern: LinkRef[] = (owner as { linkedRefs?: LinkRef[] }).linkedRefs ?? []
  // Dedupe defensively: a group referent could in principle reach both fields
  // through an import, and a doubled chip reads as a bug.
  const seen = new Set<string>()
  return [...legacy, ...modern].filter(r => {
    const k = refKey(r)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Rewrite a reference onto freshly-minted ids when a project is inserted.
 *
 *  Returns null for anything pointing OUTSIDE the snapshot. That is the whole
 *  point: an inserted copy carries ids that mean nothing in this document, and
 *  a stale id is not merely dead — ids like 'primary' and 'root-bar' are
 *  reused, so an unremapped reference silently re-attaches to unrelated
 *  content that happens to share the name. Dropping is the only safe answer
 *  for a referent that did not come along. */
export function remapRef(
  r: LinkRef,
  maps: { groupIdMap: Map<string, string>; boardIdMap: Map<string, string>; barIdMap: Map<string, string> },
): LinkRef | null {
  if (r.kind === 'group') {
    const id = maps.groupIdMap.get(r.id)
    return id ? { kind: 'group', id } : null
  }
  if (r.kind === 'board') {
    const id = maps.boardIdMap.get(r.id)
    return id ? { kind: 'board', id } : null
  }
  const boardId = maps.boardIdMap.get(r.boardId)
  const id = maps.barIdMap.get(r.id)
  return boardId && id ? { kind: 'bar', id, boardId } : null
}

/** remapRef over a list, dropping what did not survive. */
export function remapRefs(
  list: LinkRef[] | undefined,
  maps: { groupIdMap: Map<string, string>; boardIdMap: Map<string, string>; barIdMap: Map<string, string> },
): LinkRef[] {
  return (list ?? []).map(r => remapRef(r, maps)).filter((r): r is LinkRef => !!r)
}

/** Icon shown on a chip so the three kinds are tellable apart at a glance
 *  without reading the label. */
export const REF_GLYPH: Record<LinkRef['kind'], string> = {
  group: '◆',
  board: '▤',
  bar: '▬',
}
