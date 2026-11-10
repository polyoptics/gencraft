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

const closed = (g: ProjectGroup | undefined) => !!g?.deckState && g.deckState !== 'open'

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
