// Pure helpers for deriving back-references (inbound links) from the
// one-way `linkedGroupIds` storage on ProjectGroup.

import type { ProjectGroup } from '../store/boardsStore'

/** Return ids of all groups that have `groupId` in their linkedGroupIds. */
export function getBackRefs(groupId: string, groups: ProjectGroup[]): string[] {
  const out: string[] = []
  for (const g of groups) {
    if (g.id === groupId) continue
    const list = g.linkedGroupIds ?? []
    if (list.includes(groupId)) out.push(g.id)
  }
  return out
}

/** Join back-ref ids into a stable string for use in store selector keys
 *  (so shallow-equal selectors work with `useShallow`). */
export function backRefKey(groupId: string, groups: ProjectGroup[]): string {
  return getBackRefs(groupId, groups).join('|')
}
