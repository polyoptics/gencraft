// A faction shown as a tree on a storyline (Brian 2026-11-04, the optional
// storyline test): a new storyline beside the faction card, a dot for each
// member, each joined to the member it reports to, the top rank along the
// base line. Each member's card hangs from its dot (linked, so it moves
// with it), laid out like a family tree: the top at the top, each crew
// under its boss. Someone with two bosses hangs under the one it sits
// under in the faction's list. A one-off: changing the faction later does
// not redraw it.

import { useBoardsStore } from '../store/boardsStore'
import { groupBounds } from '../store/canvasStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { factionMembers } from './cardTypes'
import { normalizeStoryline, type StoryDot, type StoryEdge, type StorylineData } from './storyline'

/** A card's face on the canvas (groupBounds less its docking margin). */
function face(id: string) {
  const b = groupBounds(id)
  return b ? { x: b.x + 16, y: b.y, w: Math.max(1, b.w - 32), h: b.h } : null
}

/** Builds it; returns the storyline's node id (null: no members). */
export function showFactionTree(factionId: string): string | null {
  const bs = useBoardsStore.getState()
  const faction = bs.groups.find(g => g.id === factionId)
  if (!faction) return null
  const list = factionMembers(bs.groups, faction).filter(m => !m.card.pin && face(m.card.id))
  if (!list.length) return null
  const faces = new Map(list.map(m => [m.card.id, face(m.card.id)!]))
  const cw = Math.max(...[...faces.values()].map(f => f.w))
  const ch = Math.max(...[...faces.values()].map(f => f.h))
  const colW = cw * 1.25, rowH = ch * 1.5

  // Each under the boss it sits under (the list's tree).
  const kids = new Map<string | null, string[]>()
  for (const m of list) {
    const up = m.depth > 0 ? m.bosses[0]?.id ?? null : null
    kids.set(up, [...(kids.get(up) ?? []), m.card.id])
  }
  const width = new Map<string, number>()
  const span = (id: string): number => {
    const ks = kids.get(id) ?? []
    const v = ks.length ? ks.reduce((s, k) => s + span(k), 0) : 1
    width.set(id, v)
    return v
  }
  const at = new Map<string, { col: number; depth: number }>()
  const lay = (id: string, depth: number, start: number) => {
    let c = start
    for (const k of kids.get(id) ?? []) { lay(k, depth + 1, c); c += width.get(k)! }
    at.set(id, { col: start + (width.get(id)! - 1) / 2, depth })
  }
  const tops = kids.get(null) ?? []
  let col = 0
  for (const t of tops) { span(t); lay(t, 0, col); col += width.get(t)! }

  // Beside the faction card, its top level with the card's top.
  const fb = face(factionId)
  const ox = fb ? fb.x + fb.w + cw * 0.75 : faces.values().next().value!.x
  const oy = fb ? fb.y : faces.values().next().value!.y
  const dotOf = new Map<string, StoryDot>()
  for (const m of list) {
    const p = at.get(m.card.id)
    if (!p) continue
    dotOf.set(m.card.id, { id: crypto.randomUUID(), x: p.col * colW + cw / 2, y: p.depth * rowH, title: '', cards: [m.card.id] })
  }
  const base = tops.map(t => dotOf.get(t)!.id)
  const edges: StoryEdge[] = []
  for (let i = 1; i < base.length; i++) edges.push({ a: base[i - 1], b: base[i] })
  for (const m of list) {
    const up = m.depth > 0 ? m.bosses[0]?.id : undefined
    if (up && dotOf.has(up)) edges.push({ a: dotOf.get(up)!.id, b: dotOf.get(m.card.id)!.id })
  }
  // Baked back in (utils/chartCard), it folds into this faction card.
  const data: StorylineData = { dots: [...dotOf.values()], edges, base, chartCard: factionId }

  useUndoCoordinator.getState().checkpoint()
  const fs = useFreeNodeStore.getState()
  const id = fs.addFreeNode(0, 0, 'storyline')
  fs.updateFreeNode(id, normalizeStoryline(ox, oy, data))
  // Each card hangs from its dot: centred under it, just below.
  bs.setGroupPosBatch(list.flatMap(m => {
    const d = dotOf.get(m.card.id), f = faces.get(m.card.id)
    if (!d || !f) return []
    const tx = ox + d.x - f.w / 2, ty = oy + d.y + ch * 0.12
    return [{ groupId: m.card.id, originX: m.card.originX + (tx - f.x), originY: m.card.originY + (ty - f.y) }]
  }))
  return id
}
