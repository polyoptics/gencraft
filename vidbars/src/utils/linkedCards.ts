// Linked cards (Brian 2026-11-05): one card shown in more than one place.
// A linked card (ProjectGroup.linkOf) is another showing of its master: its
// name, colour, type, face and details are the master's, and an edit on any
// showing (the master too) is made on all of them. Where each sits, its
// size, its deck and whether it is turned over stay its own. Its header is
// hatched with stripes (CardLayer), the mark of a linked card.
//
// Kept by watching the store rather than by every edit: whatever changes a
// card's shared fields, on whichever showing, is copied to the rest.

import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'

/** What a linked card shares with its master. */
const SHARED = [
  'name', 'color', 'ownColor', 'cardType', 'details',
  'cardHeroImage', 'cardHeroTransform', 'cardSummary',
  'cardText', 'cardTextStyle', 'cardHeaderText', 'cardHeaderTextStyle',
  'textSplitRatio', 'cardStrokes',
] as const satisfies readonly (keyof ProjectGroup)[]

type Shared = Pick<ProjectGroup, typeof SHARED[number]>

function sharedOf(g: ProjectGroup): Shared {
  const out: Record<string, unknown> = {}
  for (const k of SHARED) out[k] = g[k]
  return out as Shared
}

const differs = (a: ProjectGroup | undefined, b: ProjectGroup | undefined) =>
  !a || !b || SHARED.some(k => a[k] !== b[k])

/** The master card `id` shows (itself when it is not a linked card). */
export function masterOf(groups: ProjectGroup[], id: string): string {
  const g = groups.find(x => x.id === id)
  return g?.linkOf && groups.some(x => x.id === g.linkOf) ? g.linkOf : id
}

/** A new linked card showing `masterId`, with its own blocks (a copy of the
 *  master's), where the master is. The caller places it and takes the undo
 *  checkpoint. Returns its id. */
export function makeLinkedCard(masterId: string): string | null {
  const bs = useBoardsStore.getState()
  const m = bs.groups.find(g => g.id === masterId)
  if (!m) return null
  const id = bs.duplicateGroup(masterId)
  if (!id) return null
  useBoardsStore.setState(s => ({
    groups: s.groups.map(g => g.id !== id ? g : {
      ...g, ...sharedOf(m), linkOf: masterId,
      linkedGroupIds: undefined, linkedRefs: undefined, chart: undefined,
      reportsTo: undefined, kin: undefined,
    }),
  }))
  return id
}

let prev = new Map<string, ProjectGroup>()
let prevArr: ProjectGroup[] | null = null
let started = false

/** Copies each change on one showing of a card to the others. Once, at start. */
export function startLinkedCardSync(): void {
  if (started) return
  started = true
  const take = (groups: ProjectGroup[]) => { prevArr = groups; prev = new Map(groups.map(g => [g.id, g])) }
  take(useBoardsStore.getState().groups)
  useBoardsStore.subscribe(s => {
    const groups = s.groups
    if (groups === prevArr) return
    const families = new Map<string, string[]>()
    for (const g of groups) if (g.linkOf) families.set(g.linkOf, [...(families.get(g.linkOf) ?? []), g.id])
    if (families.size === 0) { take(groups); return }
    const byId = new Map(groups.map(g => [g.id, g]))
    const patch = new Map<string, Shared>()
    for (const [root, links] of families) {
      // The master first: when it and a showing both changed, it wins.
      const all = [root, ...links].filter(id => byId.has(id))
      if (all.length < 2) continue
      const src = all.find(id => prev.get(id) !== byId.get(id) && differs(prev.get(id), byId.get(id)))
      if (!src) continue
      const from = byId.get(src)!
      for (const id of all) if (id !== src && differs(byId.get(id), from)) patch.set(id, sharedOf(from))
    }
    take(groups)
    if (patch.size === 0) return
    useBoardsStore.setState(st => ({ groups: st.groups.map(g => patch.has(g.id) ? { ...g, ...patch.get(g.id)! } : g) }))
  })
}
