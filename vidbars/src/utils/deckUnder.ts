// deckUnder.ts — a deck that opens owns the cards it brought out, and the
// cards set down against it afterwards (Brian 2026-11-10, as a 3D scene
// does: utils/area3dScene isUnder). A card that already lay where the
// deck's cards open is UNDER the row, not in it: it does not join the row,
// so closing the row leaves it where it is. Moved by hand, it is under the
// row no more: set down against it, it joins, as any card does.
//
// The row's cards carry the list (ProjectGroup.rowUnder); clustering reads
// it (hooks/useCardDecks). Nothing is ever moved here.

import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { isUndoRestoring } from '../store/undoCoordinator'
import { cardsTouch, isHiddenDeckMember } from '../hooks/useCardDecks'
import { primaryFirst } from './primaryCard'
import { keptDeck } from './deckLock'
import { isShut } from './deckTree'

/** (utils/deckTree: the one test for a card closed up.) */
const closed = isShut

export function startDeckUnder(): () => void {
  let busy = false
  return useBoardsStore.subscribe((s, prev) => {
    if (busy || s.groups === prev.groups || isUndoRestoring()) return
    const was = new Map(prev.groups.map(g => [g.id, g]))
    // Cards of a closed deck, now open.
    const opened = s.groups.filter(g => !closed(g) && closed(was.get(g.id)))
    const listed = s.groups.some(g => g.rowUnder)
    if (!opened.length && !listed) return
    const patch = new Map<string, string[] | undefined>()
    if (opened.length) {
      const zoom = useCanvasStore.getState().zoom
      const openedIds = new Set(opened.map(g => g.id))
      // The row the deck sat in before it opened (its front card and the
      // open cards touching it, on from there): those are its row still.
      const seen = prev.groups.filter(g => !isHiddenDeckMember(g) && !g.pin)
      const row = new Set(seen.filter(g => openedIds.has(g.id)).map(g => g.id))
      for (let grew = true; grew;) {
        grew = false
        for (const g of seen) {
          if (row.has(g.id)) continue
          if (seen.some(o => row.has(o.id) && cardsTouch(g, o, prev.boards, zoom))) { row.add(g.id); grew = true }
        }
      }
      // What lies where its cards opened, and was in sight there before.
      const under = s.groups.filter(g => {
        if (openedIds.has(g.id) || row.has(g.id) || g.pin || isHiddenDeckMember(g)) return false
        const w = was.get(g.id)
        if (!w || isHiddenDeckMember(w)) return false
        return opened.some(o => cardsTouch(g, o, s.boards, zoom))
      }).map(g => g.id)
      if (under.length) for (const g of opened) patch.set(g.id, [...new Set([...(g.rowUnder ?? []), ...under])])
    }
    if (listed) {
      // Moved by hand (or gone): under no row any more.
      const moved = new Set(s.groups.filter(g => { const w = was.get(g.id); return !!w && (w.originX !== g.originX || w.originY !== g.originY) }).map(g => g.id))
      const here = new Set(s.groups.map(g => g.id))
      for (const g of s.groups) {
        if (!g.rowUnder) continue
        // Closed again: the list goes; it is made anew when it next opens.
        if (closed(g)) { patch.set(g.id, undefined); continue }
        const keep = g.rowUnder.filter(id => here.has(id) && !moved.has(id))
        if (keep.length !== g.rowUnder.length) patch.set(g.id, keep.length ? keep : undefined)
      }
    }
    if (!patch.size) return
    busy = true
    try {
      useBoardsStore.setState(st => ({ groups: st.groups.map(g => (patch.has(g.id) ? { ...g, rowUnder: patch.get(g.id) } : g)) }))
    } finally { busy = false }
  })
}

// ── An open deck stays that deck (Brian 2026-11-10) ──
// While a deck is open, its cards carry its tag (ProjectGroup.deckHome: its
// front card's id). The tag is the deck a card is in NOW: one a card, never
// a history. It comes when the deck opens and goes when it closes (a closed
// deck is its own record). A card set down against an open deck takes its
// tag there and then; dragged away from its deck, it drops it; set against
// another open deck, it takes that one's. Rearranging changes nothing: the
// tag says which deck, not where in it. A row closing does not read the
// tags: it closes as one deck (boardsStore setDeckState). Nothing is ever
// moved here.

export function startDeckHome(): () => void {
  let busy = false
  return useBoardsStore.subscribe((s, prev) => {
    if (busy || s.groups === prev.groups || isUndoRestoring()) return
    const was = new Map(prev.groups.map(g => [g.id, g]))
    const patch = new Map<string, string | undefined>()
    const front = new Map<string, string>()
    // Cards of a closed deck, now open: its tag (two or more of them).
    const opened = s.groups.filter(g => !closed(g) && closed(was.get(g.id)))
    const tagFor = (g: ProjectGroup) => was.get(g.id)!.deckAnchorId ?? g.id
    const n = new Map<string, number>()
    for (const g of opened) n.set(tagFor(g), (n.get(tagFor(g)) ?? 0) + 1)
    for (const g of opened) if ((n.get(tagFor(g)) ?? 0) >= 2) patch.set(g.id, tagFor(g))
    // Opened inside a row: the row keeps the primary card it had (a deck
    // opening made its own front the whole row's, and the row then closed
    // onto it, the row's own card with it). The opened cards and that card
    // remember it (utils/primaryCard).
    if (patch.size) {
      const zoom = useCanvasStore.getState().zoom
      const seen = prev.groups.filter(g => !isHiddenDeckMember(g) && !g.pin)
      for (const t of new Set(patch.values())) {
        const f = t ? seen.find(g => g.id === t) : undefined
        if (!f) continue
        const row = [f]
        for (let i = 0; i < row.length; i++) {
          for (const g of seen) {
            if (row.includes(g) || !!g.rowUnder?.includes(row[i].id) || !!row[i].rowUnder?.includes(g.id) || !cardsTouch(g, row[i], prev.boards, zoom)) continue
            row.push(g)
          }
        }
        if (row.length < 2) continue
        const lead = primaryFirst(prev.groups, [...row].sort((a, b) => a.originX - b.originX).map(g => g.id))[0]
        if (lead !== t) front.set(t!, lead)
      }
    }
    // Closed: the tag goes.
    for (const g of s.groups) if (g.deckHome && closed(g)) patch.set(g.id, undefined)
    const tagOf = (g: ProjectGroup) => (patch.has(g.id) ? patch.get(g.id) : g.deckHome)
    const open = s.groups.filter(g => !closed(g) && !g.pin)
    if (open.some(g => tagOf(g))) {
      const zoom = useCanvasStore.getState().zoom
      const apart = (a: ProjectGroup, b: ProjectGroup) => !!a.rowUnder?.includes(b.id) || !!b.rowUnder?.includes(a.id)
      const mid = (g: ProjectGroup) => ({ x: g.originX, y: g.originY })
      for (const g of open) {
        // Moved (or made) by hand, not just opened.
        const w = was.get(g.id)
        if (patch.has(g.id) || (w && w.originX === g.originX && w.originY === g.originY)) continue
        const own = tagOf(g)
        // Still against its own deck: it stays in it.
        if (own && open.some(o => o.id !== g.id && tagOf(o) === own && cardsTouch(g, o, s.boards, zoom))) continue
        // Against another open deck: that one's (the nearest card's).
        const near = open.filter(o => o.id !== g.id && !!tagOf(o) && tagOf(o) !== own && !apart(g, o) && cardsTouch(g, o, s.boards, zoom))
          .sort((a, b) => Math.hypot(mid(a).x - mid(g).x, mid(a).y - mid(g).y) - Math.hypot(mid(b).x - mid(g).x, mid(b).y - mid(g).y))
        const next = near.length ? tagOf(near[0]) : undefined
        if (next !== own) patch.set(g.id, next)
      }
    }
    // Who remembers which primary card: the opened cards, and that card.
    const lead = new Map<string, string>()
    for (const g of opened) { const l = front.get(patch.get(g.id) ?? ''); if (l) { lead.set(g.id, l); lead.set(l, l) } }
    for (const [id, t] of [...patch]) if (s.groups.find(g => g.id === id)?.deckHome === t) patch.delete(id)
    if (!patch.size && !lead.size) return
    busy = true
    try {
      useBoardsStore.setState(st => ({
        groups: st.groups.map(g => (patch.has(g.id) || lead.has(g.id)
          ? { ...g, ...(patch.has(g.id) ? { deckHome: patch.get(g.id) } : {}), ...(lead.has(g.id) ? { deckLastFront: lead.get(g.id) } : {}) }
          : g)),
      }))
    } finally { busy = false }
  })
}

// ── A kept deck settles when it closes (Brian 2026-11-19) ──
// Open, a kept deck (the lock's first stage, utils/deckLock) is whichever
// of its kept cards touch: they can be pulled off and put back. Closing
// settles it: the cards that close with it are the deck, and every other
// card kept under it lets go, for good. A kept card that closes into
// something else lets go too. So no card goes on remembering a deck it is
// not in. Nothing is ever moved here.

export function startDeckKeep(): () => void {
  let busy = false
  return useBoardsStore.subscribe((s, prev) => {
    if (busy || s.groups === prev.groups || isUndoRestoring()) return
    if (!prev.groups.some(g => g.deckKeep)) return
    const was = new Map(prev.groups.map(g => [g.id, g]))
    // Open cards, now closed.
    const shut = new Set(s.groups.filter(g => closed(g) && !!was.get(g.id) && !closed(was.get(g.id))).map(g => g.id))
    if (!shut.size) return
    const zoom = useCanvasStore.getState().zoom
    const touch = (a: ProjectGroup, b: ProjectGroup) => cardsTouch(a, b, prev.boards, zoom)
    const drop = new Set<string>()
    for (const k of new Set(prev.groups.filter(g => g.deckKeep && shut.has(g.id)).map(g => g.deckKeep!))) {
      const all = prev.groups.filter(g => g.deckKeep === k)
      // The deck as it stood, open: closing, the cards of it that close.
      const deck = keptDeck(k, prev.groups, touch)
      // A deck already closed inside it goes with it (Brian 2026-11-20).
      const went = deck && !closed(deck[0]) ? deck.filter(g => shut.has(g.id)) : []
      const stay = went.length >= 2 ? deck!.filter(g => shut.has(g.id) || closed(g)) : went
      if (stay.length >= 2) { for (const g of all) if (!stay.includes(g)) drop.add(g.id) }
      // Not the deck closing: the kept cards that closed are in another.
      else if (deck && !deck.some(g => shut.has(g.id))) { for (const g of all) if (shut.has(g.id)) drop.add(g.id) }
      else for (const g of all) drop.add(g.id)
    }
    if (!drop.size) return
    busy = true
    try {
      useBoardsStore.setState(st => ({ groups: st.groups.map(g => (drop.has(g.id) && g.deckKeep ? { ...g, deckKeep: undefined } : g)) }))
    } finally { busy = false }
  })
}
