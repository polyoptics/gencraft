// linkEvents.ts — "this card's detail was just pointed at that card", said
// by the action that did it (Brian 2026-11-24, after the look back over the
// week: "background watchers that guess what you did ... ones that I care a
// lot about fixing").
//
// What follows a link (two linked cards agreeing on a Height:
// utils/detailMerge) used to be worked out by watching every change to the
// cards and guessing, from what looked different, that one link had just
// been made: so one link shared the Height and several made together did
// not. Now whatever makes the link says so here, once for each link, and
// what follows is done for every one of them alike.
//
// No imports: the card store itself says it (linkGroupDetail).

type Heard = (card: string, to: string) => void
const w = (typeof window !== 'undefined' ? window : {}) as { __linkHeard?: Map<string, Heard> }
/** Kept on the window so a reload of a listener's module (dev) swaps it in
 *  place instead of adding a second one. */
const heard = (w.__linkHeard ??= new Map<string, Heard>())

/** Listen for links being made. `name`: one listener to a name. */
export function onDetailLinked(name: string, f: Heard): void { heard.set(name, f) }

/** A row on card `card`'s back now shows the whole card `to`. Called by
 *  the action that wrote it, after the write, inside its undo step. */
export function detailLinked(card: string, to: string): void {
  if (card === to) return
  for (const f of heard.values()) f(card, to)
}
