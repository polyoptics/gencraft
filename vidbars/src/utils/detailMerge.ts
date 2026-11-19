// detailMerge.ts — two cards linked together agree on what they both say
// (Brian 2026-11-19: "I take that model, and I dock it with a character
// card... and I'm going to link it. When I link it to the model whose
// height wins?... let's do that for the heights and everything").
//
// Linking is a row on one card's back pointed at another card (the row's
// menu, a card dropped on it, utils/bringHome). When that happens, the
// two cards' rows of the same name are looked at:
//  - Both say something and it differs: he is asked which to keep
//    (components/UI/MergeDialog), row by row. The one not kept becomes a
//    link to the other's row, so from then on there is one value, shown
//    on both, changed from either.
//  - Height is shared without asking when there is nothing to choose:
//    both the same, or only one card has one (the other gets it, a row
//    added if it has none). Heights are compared as heights (183 cm is
//    6'0"), other rows as text.
// Watched from the cards themselves, so every way of linking is covered.
// Never on an undo, a project loading, or many links made at once.

import { create } from 'zustand'
import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useUndoCoordinator, isUndoRestoring } from '../store/undoCoordinator'
import { detailShown, isChartRank, isOwnCount, newDetailId, type CardDetail } from './cardTypes'
import { isHeightName, parseHeight } from './stickGeom'

/** One row the two cards disagree on. */
export interface MergeRow { name: string; aRow: string; bRow: string; aText: string; bText: string }
/** The question put to him: card `a` was linked to card `b`. */
export interface MergeAsk { a: string; b: string; rows: MergeRow[] }
export const useMergeAsk = create<{ ask: MergeAsk | null }>(() => ({ ask: null }))

const groupsNow = () => useBoardsStore.getState().groups
const masterOf = (g: ProjectGroup, groups: ProjectGroup[]) => (g.linkOf && groups.find(x => x.id === g.linkOf)) || g
/** A row that says something of its own (not a link to a whole card, a
 *  count or a rank). */
const plain = (d: CardDetail, card: ProjectGroup) =>
  !!d.name.trim() && !isOwnCount(d, card.id) && !isChartRank(d) && !(d.link && !d.link.detail)
/** Row `d` already shows card `to`'s row `row`. */
const shares = (d: CardDetail, to: ProjectGroup, row: CardDetail) => d.link?.card === to.id && d.link.detail === row.id

/** Row `from` on card `on` shows card `to`'s row `row` from now on. */
function share(on: ProjectGroup, from: CardDetail | null, to: ProjectGroup, row: CardDetail) {
  const cur = groupsNow().find(g => g.id === on.id)
  if (!cur) return
  const link = { card: to.id, detail: row.id }
  const details = from
    ? (cur.details ?? []).map(d => d.id === from.id ? { ...d, link } : d)
    : [...(cur.details ?? []), { id: newDetailId(), name: row.name, value: '', link }]
  useBoardsStore.getState().setGroupDetails(on.id, details)
}

/** Card `aId` has just been linked to card `bId`. */
function linked(aId: string, bId: string) {
  const groups = groupsNow()
  const a0 = groups.find(g => g.id === aId), b0 = groups.find(g => g.id === bId)
  if (!a0 || !b0) return
  const a = masterOf(a0, groups), b = masterOf(b0, groups)
  if (a.id === b.id) return
  const rows: MergeRow[] = []
  const text = (d: CardDetail) => detailShown(groups, d).text.trim()
  for (const ra of a.details ?? []) {
    if (!plain(ra, a)) continue
    const key = ra.name.trim().toLowerCase()
    const rb = (b.details ?? []).find(x => x.name.trim().toLowerCase() === key && plain(x, b))
    if (!rb || shares(ra, b, rb) || shares(rb, a, ra)) continue
    const ta = text(ra), tb = text(rb)
    if (isHeightName(ra.name)) {
      const fa = parseHeight(ta), fb = parseHeight(tb)
      if (fa && fb && Math.abs(fa - fb) > 1 / 24) rows.push({ name: ra.name, aRow: ra.id, bRow: rb.id, aText: ta, bText: tb })
      else if (fb) share(a, ra, b, rb)
      else if (fa) share(b, rb, a, ra)
    } else if (ta && tb && ta.toLowerCase() !== tb.toLowerCase()) {
      rows.push({ name: ra.name, aRow: ra.id, bRow: rb.id, aText: ta, bText: tb })
    }
  }
  // A height only one of them has a row for: the other gets it.
  const ha = (a.details ?? []).find(d => isHeightName(d.name) && plain(d, a))
  const hb = (b.details ?? []).find(d => isHeightName(d.name) && plain(d, b))
  if (ha && !hb && parseHeight(text(ha))) share(b, null, a, ha)
  if (hb && !ha && parseHeight(text(hb))) share(a, null, b, hb)
  if (rows.length) useMergeAsk.setState({ ask: { a: a.id, b: b.id, rows } })
}

/** His answer: of each row, the card whose value is kept ('a' or 'b');
 *  a row with none stays as it is on both. One undo step. */
export function answerMerge(ask: MergeAsk, keep: Record<string, 'a' | 'b' | undefined>) {
  useMergeAsk.setState({ ask: null })
  const picked = ask.rows.filter(r => keep[r.aRow])
  if (!picked.length) return
  useUndoCoordinator.getState().checkpoint()
  for (const r of picked) {
    const groups = groupsNow()
    const a = groups.find(g => g.id === ask.a), b = groups.find(g => g.id === ask.b)
    const ra = a?.details?.find(d => d.id === r.aRow), rb = b?.details?.find(d => d.id === r.bRow)
    if (!a || !b || !ra || !rb) continue
    if (keep[r.aRow] === 'a') share(b, rb, a, ra); else share(a, ra, b, rb)
  }
}

// ── Watching for a card being linked to another ──
/** A card's rows that point at a whole card: `${row}>${card}`. */
const wholeLinks = (g: ProjectGroup) => {
  const out = new Set<string>()
  for (const d of g.details ?? []) if (d.link && !d.link.detail && !d.link.count && !d.link.rankOf && !d.link.favorite) out.add(`${d.id}>${d.link.card}`)
  return out
}
let before = new Map<string, { details: unknown; links: Set<string> }>()
function look() {
  const next = new Map<string, { details: unknown; links: Set<string> }>()
  const fresh: [string, string][] = []
  for (const g of groupsNow()) {
    const was = before.get(g.id)
    if (was && was.details === g.details) { next.set(g.id, was); continue }
    const links = wholeLinks(g)
    next.set(g.id, { details: g.details, links })
    // (A card that was not here before came with its links: pasted, loaded.)
    if (was) for (const k of links) if (!was.links.has(k)) fresh.push([g.id, k.slice(k.indexOf('>') + 1)])
  }
  before = next
  if (fresh.length !== 1 || isUndoRestoring() || useMergeAsk.getState().ask) return
  const [a, b] = fresh[0]
  queueMicrotask(() => w?.__detailMerge?.linked(a, b))
}

const w = (typeof window !== 'undefined' ? window : undefined) as (Window & { __detailMerge?: { look: typeof look; linked: typeof linked } }) | undefined
if (w) {
  // Installed once; a reload of this module (dev) swaps the handlers in place.
  const first = !w.__detailMerge
  w.__detailMerge = { look, linked }
  if (first) {
    let last: unknown = null
    useBoardsStore.subscribe(s => {
      if (s.groups === last) return
      last = s.groups
      w.__detailMerge!.look()
    })
  }
  look()
}
