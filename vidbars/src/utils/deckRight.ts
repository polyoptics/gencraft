// A deck off every storyline opens to the right (Brian 2026-11-05).
// On a storyline a deck opens away from the line (utils/deckAway), and that
// turn is kept in its cards' offsets. Once none of its cards is linked to a
// storyline any more, the turn is undone: the cards that lie left of the
// front card are mirrored back to its right, so it opens to the right and
// its fan and edges show on the right. A card remembers it was on a
// storyline (ProjectGroup.wasOnStoryline) until its deck is closed off
// every line, so a deck laid left on purpose (Make primary) that was never
// on a storyline keeps its shape. Decks already stuck turned before this
// existed are put right once, at start.

import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { boundsOf } from '../store/canvasStore'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { linkedLines, lyingLeft } from './deckAway'

const ONCE_KEY = 'vidbars.decksOpenRight.v1'
const isClosed = (g: ProjectGroup) => !!g.deckState && g.deckState !== 'open'

let linkedOf: { nodes: Record<string, FreeNodeData> | null; ids: Set<string> } = { nodes: null, ids: new Set() }
/** Every card linked to a storyline dot. */
function linkedIds(nodes: Record<string, FreeNodeData>): Set<string> {
  if (linkedOf.nodes === nodes) return linkedOf.ids
  const ids = new Set<string>()
  for (const n of linkedLines(nodes)) for (const p of n.storyline!.dots) for (const c of p.cards ?? []) ids.add(c)
  linkedOf = { nodes, ids }
  return ids
}

type Patch = Partial<Pick<ProjectGroup, 'deckOffsetX' | 'ghostSlots' | 'wasOnStoryline'>>

/** Deck `a`'s cards (and checked-out slots) that lie wholly left of it,
 *  mirrored about its middle to its right, past the cards already there. */
function toRight(a: ProjectGroup, members: ProjectGroup[], byId: Map<string, ProjectGroup>,
                 boards: Record<string, BoardData>, out: Map<string, Patch>): void {
  const A = boundsOf(a, boards)
  if (!A) return
  type Item = { off: number; box: { x: number; w: number }; put: (off: number) => void }
  const boxAt = (g: ProjectGroup, offX: number) => {
    const b = boundsOf(g, boards)
    return b && { x: b.x - g.originX + a.originX + offX, w: b.w }
  }
  const ghosts = a.ghostSlots ? a.ghostSlots.map(sl => ({ ...sl })) : undefined
  const items: Item[] = []
  for (const g of members) {
    const box = boxAt(g, g.deckOffsetX ?? 0)
    if (box) items.push({ off: g.deckOffsetX ?? 0, box, put: off => out.set(g.id, { ...out.get(g.id), deckOffsetX: off }) })
  }
  for (const sl of ghosts ?? []) {
    const box = boxAt(byId.get(sl.cardId) ?? a, sl.deckOffsetX)
    if (box) items.push({ off: sl.deckOffsetX, box, put: off => { sl.deckOffsetX = off } })
  }
  const left = items.filter(it => it.box.x + it.box.w <= A.x + 1)
  if (!left.length) return
  const cx = A.x + A.w / 2
  const reach = Math.max(0, ...items.filter(it => !left.includes(it)).map(it => it.box.x + it.box.w - (A.x + A.w)))
  for (const it of left) it.put(it.off + 2 * cx - it.box.w - 2 * it.box.x + reach)
  if (ghosts) out.set(a.id, { ...out.get(a.id), ghostSlots: ghosts })
}

/** One pass over the cards: mark the ones on a storyline, and turn back
 *  the closed decks that left every line. `once`: also every closed deck
 *  off the lines whose cards all lie left of its front card. */
function sweep(once: boolean): void {
  const { groups, boards } = useBoardsStore.getState()
  const linked = linkedIds(useFreeNodeStore.getState().nodes)
  const out = new Map<string, Patch>()
  let members: Map<string, ProjectGroup[]> | null = null
  const deckOf = (id: string) => {
    if (!members) {
      members = new Map()
      for (const g of groups) if (isClosed(g) && g.deckAnchorId && g.deckAnchorId !== g.id) {
        members.set(g.deckAnchorId, [...(members.get(g.deckAnchorId) ?? []), g])
      }
    }
    return members.get(id) ?? []
  }
  for (const g of groups) {
    if (linked.has(g.id)) { if (!g.wasOnStoryline) out.set(g.id, { wasOnStoryline: true }); continue }
    if (!isClosed(g) || (!g.wasOnStoryline && !once)) continue
    // A card closed inside another deck: its own deck is gone.
    if (g.deckAnchorId && g.deckAnchorId !== g.id) { if (g.wasOnStoryline) out.set(g.id, { wasOnStoryline: undefined }); continue }
    const cards = deckOf(g.id)
    if (cards.some(c => linked.has(c.id))) continue
    const done = () => { if (g.wasOnStoryline) out.set(g.id, { ...out.get(g.id), wasOnStoryline: undefined }) }
    // Left as laid, like deckAway: effect chains read left to right, and a
    // deck holding a deck of its own hangs its cards off that one.
    if (!cards.length || g.effect || cards.some(c => c.effect || deckOf(c.id).length)) { done(); continue }
    if (!g.wasOnStoryline && !lyingLeft([...cards, ...(g.ghostSlots ?? [])])) continue
    const byId = new Map(groups.map(c => [c.id, c]))
    toRight(g, cards, byId, boards, out)
    done()
  }
  if (!out.size) return
  useBoardsStore.setState(s => ({ groups: s.groups.map(g => out.has(g.id) ? { ...g, ...out.get(g.id)! } : g) }))
}

let started = false
/** Keeps decks off the storylines opening to the right. Once, at start. */
export function startDecksOpenRight(): void {
  if (started) return
  started = true
  const ready = () => useBoardsStore.persist.hasHydrated() && useFreeNodeStore.persist.hasHydrated()
  let live = false
  const go = () => {
    if (live || !ready()) return
    live = true
    let once = false
    try { once = !localStorage.getItem(ONCE_KEY) } catch { /* no storage: skip the one-time pass */ }
    sweep(once)
    if (once) try { localStorage.setItem(ONCE_KEY, '1') } catch { /* ignore */ }
    let groups = useBoardsStore.getState().groups, nodes = useFreeNodeStore.getState().nodes
    useBoardsStore.subscribe(s => { if (s.groups !== groups) { groups = s.groups; sweep(false) } })
    useFreeNodeStore.subscribe(s => { if (s.nodes !== nodes) { nodes = s.nodes; sweep(false) } })
  }
  useBoardsStore.persist.onFinishHydration(go)
  useFreeNodeStore.persist.onFinishHydration(go)
  go()
}
