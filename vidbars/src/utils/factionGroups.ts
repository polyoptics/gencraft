// A faction's GROUPS (Brian 2026-11-05): its members in groups, top to
// bottom; the order is the rank (group 1 at the top). Inside a group, who
// reports to whom (faction.reportsTo) shows as its own little hierarchy.
// A deck dropped on a faction's back is a group, its front card leading the
// rest; a baked chart (utils/chartCard) writes one group per dot. A faction
// without groups works as before. A member that is in no group (it joined
// by its link "+") shows as a group of its own at the bottom.

import type { ProjectGroup } from '../store/boardsStore'

export interface FactionGroup {
  id: string
  /** Shown as the group's name; empty: its first card's name. */
  title?: string
  cards: string[]
}

export const newGroupId = () => 'fg-' + Math.random().toString(36).slice(2, 10)

/** The faction's groups as shown: stored ones (members only, empty ones
 *  dropped), then each member in none on its own. Null: it has no groups. */
export function factionGroupsOf(faction: ProjectGroup): FactionGroup[] | null {
  // A chart baked before groups were stored: its dots' groups.
  const src = faction.factionGroups ?? faction.chart?.tiers.map(t => ({ id: 't:' + t.dot, title: t.title, cards: t.cards }))
  if (!src) return null
  const members = new Set(faction.linkedGroupIds ?? [])
  const seen = new Set<string>()
  const out: FactionGroup[] = []
  for (const g of src) {
    const cards = g.cards.filter(c => members.has(c) && !seen.has(c))
    cards.forEach(c => seen.add(c))
    if (cards.length) out.push({ ...g, cards })
  }
  for (const c of faction.linkedGroupIds ?? []) if (!seen.has(c)) { seen.add(c); out.push({ id: 'solo:' + c, cards: [c] }) }
  return out
}

type Shape = Pick<ProjectGroup, 'factionGroups' | 'reportsTo' | 'linkedGroupIds'>

/** `memberId` out of its group: it reports to no one there, and those who
 *  reported to it report to its bosses instead. */
function lift(tree: Record<string, string[]>, memberId: string): Record<string, string[]> {
  const { [memberId]: theirs = [], ...rest } = tree
  const out: Record<string, string[]> = {}
  for (const [id, bosses] of Object.entries(rest)) {
    const left = bosses.filter(b => b !== memberId)
    const next = bosses.includes(memberId) && !left.length ? theirs.filter(b => b !== id) : left
    if (next.length) out[id] = next
  }
  return out
}

/** `cardIds` as a new group at the bottom (out of any group they were in),
 *  members now; the first leads: the others report to it unless they
 *  report to someone in the group already. A faction getting its first
 *  group keeps its members so far as one group at the top. */
export function withGroupAdded(faction: ProjectGroup, cardIds: string[], ordered?: string[]): Shape {
  const ids = [...new Set(cardIds)].filter(c => c !== faction.id)
  const before = faction.factionGroups ?? ((ordered ?? faction.linkedGroupIds ?? []).length
    ? [{ id: newGroupId(), cards: (ordered ?? faction.linkedGroupIds ?? []).filter(c => !ids.includes(c)) }] : [])
  let tree = { ...(faction.reportsTo ?? {}) }
  for (const c of ids) if (tree[c] || Object.values(tree).some(b => b.includes(c))) tree = lift(tree, c)
  const lead = ids[0]
  for (const c of ids.slice(1)) if (!(tree[c] ?? []).some(b => ids.includes(b))) tree[c] = [lead]
  return {
    factionGroups: [...before.map(g => ({ ...g, cards: g.cards.filter(c => !ids.includes(c)) })).filter(g => g.cards.length), { id: newGroupId(), cards: ids }],
    reportsTo: tree,
    linkedGroupIds: [...new Set([...(faction.linkedGroupIds ?? []), ...ids])],
  }
}

/** The groups as shown, stored (so a member on its own becomes a real group). */
function stored(faction: ProjectGroup): FactionGroup[] {
  return (factionGroupsOf(faction) ?? []).map(g => /^(solo|t):/.test(g.id) ? { ...g, id: newGroupId() } : g)
}

/** `memberId` into group `toId` (at its end), out of its group so far. */
export function withMemberMoved(faction: ProjectGroup, memberId: string, toId: string): Shape {
  const gs = stored(faction)
  const from = gs.find(g => g.cards.includes(memberId))
  const shown = factionGroupsOf(faction) ?? []
  const toIndex = shown.findIndex(g => g.id === toId)
  if (toIndex < 0 || shown[toIndex].cards.includes(memberId)) return { factionGroups: faction.factionGroups, reportsTo: faction.reportsTo, linkedGroupIds: faction.linkedGroupIds }
  const next = gs.map((g, i) => ({ ...g, cards: i === toIndex ? [...g.cards.filter(c => c !== memberId), memberId] : g.cards.filter(c => c !== memberId) }))
  return {
    factionGroups: next.filter(g => g.cards.length),
    reportsTo: from ? lift({ ...(faction.reportsTo ?? {}) }, memberId) : faction.reportsTo,
    linkedGroupIds: faction.linkedGroupIds,
  }
}

/** Group `id` moved to just above group `beforeId` (null: to the bottom). */
export function withGroupMoved(faction: ProjectGroup, id: string, beforeId: string | null): Shape {
  const shown = factionGroupsOf(faction) ?? []
  const gs = stored(faction)
  const i = shown.findIndex(g => g.id === id)
  if (i < 0) return { factionGroups: faction.factionGroups, reportsTo: faction.reportsTo, linkedGroupIds: faction.linkedGroupIds }
  const moving = gs[i]
  const rest = gs.filter((_, k) => k !== i)
  const j = beforeId == null ? rest.length : shown.filter((_, k) => k !== i).findIndex(g => g.id === beforeId)
  rest.splice(j < 0 ? rest.length : j, 0, moving)
  return { factionGroups: rest, reportsTo: faction.reportsTo, linkedGroupIds: faction.linkedGroupIds }
}

/** The group `memberId` is in, counted from the top (1). */
export function groupRankOf(faction: ProjectGroup, memberId: string): number | null {
  const i = (factionGroupsOf(faction) ?? []).findIndex(g => g.cards.includes(memberId))
  return i < 0 ? null : i + 1
}
