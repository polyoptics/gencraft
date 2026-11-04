// FAMILY cards (Brian 2026-11-04): a family is a card whose members are
// the cards it links to (a card's link "+" let go on it), like a faction,
// but tied by kin, not command. Only two links are stored: who is whose
// PARENT and who is whose PARTNER. Siblings, cousins, grandparents, aunts
// and uncles, in-laws: all worked out from those, so nothing is said
// twice and nothing can disagree. Siblings whose parents are not cards
// share an UNKNOWN parent ('?…' ids), which a real one replaces when
// it is given. The family's back shows it as a tree, by generation.

import type { ProjectGroup } from '../store/boardsStore'
import { newDetailId } from './cardTypes'

export interface Kin {
  /** Member → its parents (members, or '?…' unknown ones). */
  parents?: Record<string, string[]>
  /** Partners, each pair once. */
  partners?: [string, string][]
}

export const isUnknown = (id: string) => id.startsWith('?')

function view(groups: ProjectGroup[], family: ProjectGroup) {
  const byId = new Map(groups.map(g => [g.id, g]))
  const ids = [...new Set(family.linkedGroupIds ?? [])].filter(id => byId.has(id))
  const members = new Set(ids)
  const kin = family.kin ?? {}
  const par = (id: string) => [...new Set(kin.parents?.[id] ?? [])].filter(p => p !== id && (members.has(p) || isUnknown(p)))
  const partners = (id: string) => (kin.partners ?? []).flatMap(([a, b]) => a === id && members.has(b) ? [b] : b === id && members.has(a) ? [a] : [])
  const kids = (id: string) => ids.filter(c => par(c).includes(id))
  return { byId, ids, members, par, partners, kids }
}

/** One line of a family's tree. `partnerOf`: a partner from outside the
 *  family's blood, shown just after the one they are with. */
export interface FamilyRow {
  id: string
  card?: ProjectGroup
  depth: number
  partnerOf?: string
  /** Partners shown at their own place in the tree. */
  partners: ProjectGroup[]
}

/** A family as its tree reads: each line under its parents, a partner
 *  from outside just after the one they are with, top down. */
export function familyTree(groups: ProjectGroup[], family: ProjectGroup): FamilyRow[] {
  const { byId, ids, par, partners, kids } = view(groups, family)
  const rows: FamilyRow[] = []
  const placed = new Set<string>()
  const marriedIn = (id: string) => !par(id).length && partners(id).some(q => par(q).length > 0)
  const place = (id: string, depth: number) => {
    if (placed.has(id)) return
    placed.add(id)
    const inl = partners(id).filter(q => !placed.has(q) && !par(q).length)
    inl.forEach(q => placed.add(q))
    rows.push({ id, card: byId.get(id), depth, partners: partners(id).filter(q => !inl.includes(q)).map(q => byId.get(q)!) })
    for (const q of inl) rows.push({ id: q, card: byId.get(q), depth, partnerOf: id, partners: partners(q).filter(x => x !== id).map(x => byId.get(x)!) })
    const unit = [id, ...inl]
    const children = isUnknown(id) ? ids.filter(c => par(c).includes(id)) : [...new Set(unit.flatMap(kids))]
    for (const c of children) place(c, depth + 1)
  }
  // The tops: no parents (an unknown one comes where its first child does).
  const tops: string[] = []
  for (const id of ids) {
    for (const u of par(id).filter(isUnknown)) if (!tops.includes(u)) tops.push(u)
    if (!par(id).length && !marriedIn(id)) tops.push(id)
  }
  tops.forEach(t => place(t, 0))
  ids.forEach(id => place(id, 0))
  return rows
}

/** The kin of `id` in a family, worked out from parents and partners. */
export function relationsOf(groups: ProjectGroup[], family: ProjectGroup, id: string): { label: string; cards: ProjectGroup[] }[] {
  const { byId, ids, par, partners, kids } = view(groups, family)
  const real = (xs: Iterable<string>) => [...new Set(xs)].filter(x => x !== id && !isUnknown(x) && byId.has(x)).map(x => byId.get(x)!)
  const sibs = (x: string) => ids.filter(y => y !== x && par(y).some(p => par(x).includes(p)))
  const full = (x: string, y: string) => { const a = par(x), b = par(y); return a.length === b.length && a.every(p => b.includes(p)) }
  const parents = par(id)
  const s = sibs(id)
  const auntsUncles = parents.flatMap(sibs)
  const out: [string, ProjectGroup[]][] = [
    ['Parents', real(parents)],
    ['Partner', real(partners(id))],
    ['Children', real(kids(id))],
    ['Siblings', real(s.filter(y => full(id, y)))],
    ['Half-siblings', real(s.filter(y => !full(id, y)))],
    ['Grandparents', real(parents.flatMap(par))],
    ['Grandchildren', real(kids(id).flatMap(kids))],
    ['Aunts & uncles', real(auntsUncles)],
    ['Cousins', real(auntsUncles.flatMap(kids))],
    ['Nieces & nephews', real(s.flatMap(kids))],
    ['In-laws', real([...partners(id).flatMap(q => [...par(q), ...sibs(q)]), ...s.flatMap(partners)])],
  ]
  return out.filter(([, cards]) => cards.length).map(([label, cards]) => ({ label, cards }))
}

/** The families a card is in. */
export function familiesOf(groups: ProjectGroup[], cardId: string): ProjectGroup[] {
  return groups.filter(g => g.cardType === 'family' && (g.linkedGroupIds ?? []).includes(cardId))
}

/** Whether `a` is an ancestor of `b`: a parent of theirs, or of a parent… */
export function isAncestor(kin: Kin, a: string, b: string): boolean {
  const seen = new Set<string>()
  const up = (x: string): boolean => {
    if (seen.has(x)) return false
    seen.add(x)
    return (kin.parents?.[x] ?? []).some(p => p === a || up(p))
  }
  return up(b)
}

const withParents = (kin: Kin, id: string, ps: string[]): Kin => {
  const { [id]: _old, ...rest } = kin.parents ?? {}
  return { ...kin, parents: ps.length ? { ...rest, [id]: ps } : rest }
}
const parentsIn = (kin: Kin, id: string) => kin.parents?.[id] ?? []

/** `child` a child of `parent` (on), or not (off). An unknown parent it
 *  had becomes this one, for its siblings too: they learn who it was. */
export function setChildOf(kin: Kin, child: string, parent: string, on: boolean): Kin {
  const ps = parentsIn(kin, child)
  if (!on) return withParents(kin, child, ps.filter(p => p !== parent))
  if (ps.includes(parent) || child === parent || isAncestor(kin, child, parent)) return kin
  const unknown = ps.find(isUnknown)
  if (!unknown) return withParents(kin, child, [...ps, parent])
  const parents: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(kin.parents ?? {})) parents[k] = [...new Set(v.map(p => p === unknown ? parent : p))].filter(p => p !== k)
  return { ...kin, parents }
}

export const arePartners = (kin: Kin, a: string, b: string) => (kin.partners ?? []).some(([x, y]) => (x === a && y === b) || (x === b && y === a))

export function setPartners(kin: Kin, a: string, b: string, on: boolean): Kin {
  const rest = (kin.partners ?? []).filter(([x, y]) => !((x === a && y === b) || (x === b && y === a)))
  return { ...kin, partners: on && a !== b ? [...rest, [a, b]] : rest }
}

export const areSiblings = (kin: Kin, a: string, b: string) => a !== b && parentsIn(kin, a).some(p => parentsIn(kin, b).includes(p))

/** `a` a sibling of `b` (on: the same parents; an unknown one if neither
 *  has any), or not (off: `a` no longer shares theirs). */
export function setSiblings(kin: Kin, a: string, b: string, on: boolean): Kin {
  const pa = parentsIn(kin, a), pb = parentsIn(kin, b)
  if (!on) return withParents(kin, a, pa.filter(p => !pb.includes(p)))
  if (a === b || isAncestor(kin, a, b) || isAncestor(kin, b, a)) return kin
  if (pb.length) return withParents(kin, a, [...pb])
  if (pa.length) return withParents(kin, b, [...pa])
  const u = '?' + newDetailId()
  return withParents(withParents(kin, a, [u]), b, [u])
}

/** `id` out of the family. Its children keep each other: if it was the
 *  parent of more than one, they share an unknown parent in its place. */
export function removeFromKin(kin: Kin, id: string): Kin {
  const { [id]: _own, ...rest } = kin.parents ?? {}
  const children = Object.entries(rest).filter(([, ps]) => ps.includes(id)).length
  const stand = children > 1 ? '?' + newDetailId() : null
  const parents: Record<string, string[]> = {}
  for (const [k, ps] of Object.entries(rest)) {
    const next = ps.flatMap(p => p === id ? (stand ? [stand] : []) : [p])
    if (next.length) parents[k] = next
  }
  return { parents, partners: (kin.partners ?? []).filter(([x, y]) => x !== id && y !== id) }
}
