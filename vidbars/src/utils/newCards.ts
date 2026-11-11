// New items. A card that a process puts on the canvas (a loop strip's
// results, a made GIF, a deck of shots out of a Rough Cut, a deal) wears a
// border until it is grabbed, so on a busy canvas what was just made does
// not lump in with what was already lying there (Brian 2026-11-11). It
// never fades by itself: only a press on the card takes it off. A press on
// one of several selected cards takes it off them all, as they move as one.
import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'

/** Mark cards a process has just made. Part of the caller's undo step. */
export function markNew(ids: (string | null | undefined)[]): void {
  const set = new Set(ids.filter(Boolean) as string[])
  if (!set.size) return
  useBoardsStore.setState(s => ({ groups: s.groups.map(g => set.has(g.id) && !g.isNew ? { ...g, isNew: true } : g) }))
}

/** No longer new. */
export function clearNew(ids: string[]): void {
  const set = new Set(ids)
  const st = useBoardsStore.getState()
  if (!st.groups.some(g => g.isNew && set.has(g.id))) return
  useBoardsStore.setState(s => ({ groups: s.groups.map(g => g.isNew && set.has(g.id) ? { ...g, isNew: undefined } : g) }))
}

/** The new cards among `ids`, as the value of data-new-card (undefined when
 *  none): a deck wears the border while any card in it is new. */
export function newIdsOf(ids: string[], groups: ProjectGroup[]): string | undefined {
  const set = new Set(ids)
  const out = groups.filter(g => g.isNew && set.has(g.id)).map(g => g.id)
  return out.length ? out.join(',') : undefined
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    const el = (e.target as Element | null)?.closest?.('[data-new-card]')
    const ids = el?.getAttribute('data-new-card')?.split(',').filter(Boolean)
    if (!ids?.length) return
    const sel = useBoardsStore.getState().selectedGroupIds
    clearNew(ids.some(id => sel.includes(id)) ? [...ids, ...sel] : ids)
  }, true)
}
