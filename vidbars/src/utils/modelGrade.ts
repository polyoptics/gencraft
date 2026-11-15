// modelGrade.ts — which pictures a model wears in place of its colour maps
// (Brian 2026-11-15: a model card on a loop strip is processed as its
// colour map; "one result card linked back to the master model").
//
// A loop strip's result card made from a model's maps carries `mapOf` (which
// model and map each of its pictures came from) and `railSource` (the
// model's card). That is the whole tie: while the result card is there, the
// model wears its pictures wherever it is drawn (three/modelMaps gradeLook),
// on its own card and on every linked card of it. The model's file and its
// card are never changed; delete the result card and the model is as it
// came. With several result cards for one model, the newest is worn.
//
// Read from the cards on every change, never stored anywhere else.

import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { getMediaItems } from '../types/bar'
import { gridOrder } from './cardGrid'
import { grades, type Grade } from '../three/modelMaps'

interface Index { byCard: Map<string, Map<string, Grade>>; byUrl: Map<string, Grade>; master: Map<string, string> }

let memo: { groups: ProjectGroup[]; boards: Record<string, BoardData>; index: Index } | null = null

function build(groups: ProjectGroup[], boards: Record<string, BoardData>): Index {
  const byCard = new Map<string, Map<string, Grade>>()
  const byUrl = new Map<string, Grade>()
  const ids = new Set(groups.map(g => g.id))
  const master = new Map<string, string>()
  for (const g of groups) master.set(g.id, g.linkOf && ids.has(g.linkOf) ? g.linkOf : g.id)
  // In store order: a later (newer) result card's pictures take the place
  // of an earlier one's.
  for (const g of groups) {
    if (!g.mapOf || !g.railSource || !ids.has(g.railSource) || g.linkOf) continue
    const order = gridOrder(g, boards)
    const made = new Map<string, Record<number, string>>()
    g.mapOf.forEach((m, i) => {
      const b = m ? boards[order[i]] : undefined
      if (!m || !b) return
      for (const rid of b.rootIds) {
        const pic = getMediaItems(b.bars[rid]?.content).find(x => x.type === 'image')
        if (!pic) continue
        let slots = made.get(m.model)
        if (!slots) made.set(m.model, slots = {})
        slots[m.slot] = pic.url
        break
      }
    })
    for (const [model, bySlot] of made) {
      const grade: Grade = { sig: `${g.id}|${Object.entries(bySlot).map(([k, u]) => `${k}=${u.length > 200 ? `${u.length}:${u.slice(-48)}` : u}`).join('|')}`, bySlot }
      let ofCard = byCard.get(g.railSource)
      if (!ofCard) byCard.set(g.railSource, ofCard = new Map())
      ofCard.set(model, grade)
      byUrl.set(model, grade)
    }
  }
  return { byCard, byUrl, master }
}

function index(): Index {
  const { groups, boards } = useBoardsStore.getState()
  if (!memo || memo.groups !== groups || memo.boards !== boards) memo = { groups, boards, index: build(groups, boards) }
  return memo.index
}

/** The pictures the model at `url` wears, drawn for `key` (`card:<id>` for a
 *  card's model: its master's result; anything else, a Viewer included, the
 *  result made from that model file). Null: its own maps. */
export function gradeFor(key: string | null | undefined, url: string): Grade | null {
  const ix = index()
  if (ix.byUrl.size === 0) return null
  if (key?.startsWith('card:')) {
    const id = key.slice(5)
    const own = ix.master.has(id) ? ix.byCard.get(ix.master.get(id)!)?.get(url) : undefined
    if (own) return own
  }
  return ix.byUrl.get(url) ?? null
}

/** Let the 3D views ask (three/modelMaps `grades`), and tell them when what
 *  any model wears has changed. Once, from main.tsx. */
let started = false
export function startModelGrade(): void {
  if (started) return
  started = true
  grades.for = gradeFor
  let was = ''
  useBoardsStore.subscribe((s, prev) => {
    if (s.groups === prev.groups && s.boards === prev.boards) return
    // Only cards made from a model's maps count: nothing to read without one.
    if (!s.groups.some(g => g.mapOf) && !was) return
    const now = [...index().byCard].map(([card, of]) => `${card}:${[...of.values()].map(g => g.sig).join(',')}`).join(';')
    if (now === was) return
    was = now
    for (const f of grades.changed) f()
  })
}
