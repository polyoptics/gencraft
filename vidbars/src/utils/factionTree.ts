// A faction shown as a tree on a storyline (Brian 2026-11-04, the optional
// storyline test): a new storyline beside the faction card, a dot for each
// member, each member's card hung from its dot. Laid out as a spine, like a
// family (Brian 2026-11-09, utils/familySpine): one trunk down from the
// top, each crew hanging either side of its boss's trunk on short stubs,
// a member with a crew of their own getting their own small trunk.
// Someone with two bosses hangs under the one it sits under in the
// faction's list. A one-off: changing the faction later does not redraw it.

import { useBoardsStore } from '../store/boardsStore'
import { factionMembers } from './cardTypes'
import { face, showSpine, type Unit } from './familySpine'

/** Builds it; returns the storyline's node id (null: no members). */
export function showFactionTree(factionId: string): string | null {
  const bs = useBoardsStore.getState()
  const faction = bs.groups.find(g => g.id === factionId)
  if (!faction) return null
  const list = factionMembers(bs.groups, faction).filter(m => !m.card.pin && face(m.card.id))
  if (!list.length) return null
  const faces = new Map(list.map(m => [m.card.id, face(m.card.id)!]))

  // Each under the boss it sits under (the list's tree).
  const units = new Map<string, Unit>(list.map(m => [m.card.id, { card: m.card.id, partners: [], kids: [] }]))
  const tops: Unit[] = []
  for (const m of list) {
    const up = m.depth > 0 ? m.bosses[0]?.id : undefined
    const boss = up ? units.get(up) : undefined
    if (boss) boss.kids.push(units.get(m.card.id)!)
    else tops.push(units.get(m.card.id)!)
  }
  return showSpine(factionId, tops, faces)
}
