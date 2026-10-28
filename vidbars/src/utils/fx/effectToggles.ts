// effectToggles.ts — an effect's on/off and solo switches.
//
// An effect lives on a tile (a free effect tile, or one docked on a loop
// strip) or on a card (an effect card, utils/effectCards). Both keep its
// switches on the effect itself — `off` and `solo` — so they persist with
// it, copy with it and undo with it. The chain planner (utils/fx/chain
// planChain) does the rest: an effect off is skipped; a soloed one is the
// only effect its chain runs.
//
// Solo is one per chain: soloing an effect clears it on the others in the
// same chain — the same loop strip, or the same effect strip on the canvas
// (fxStore) — and soloing it again clears it.

import { useBoardsStore } from '../../store/boardsStore'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useFxStore } from '../../store/fxStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { cardStripId } from './cardStrips'

type Effect = NonNullable<FreeNodeData['effect']>
const CARD = cardStripId('')

/** The effect behind a face id: a tile's, or (`card:<id>`) a card's. */
export function effectOf(id: string): Effect | undefined {
  if (id.startsWith(CARD)) return useBoardsStore.getState().groups.find(g => g.id === id.slice(CARD.length))?.effect
  return useFreeNodeStore.getState().nodes[id]?.effect
}

function writeEffect(id: string, patch: Partial<Effect>): void {
  if (id.startsWith(CARD)) {
    const gid = id.slice(CARD.length)
    useBoardsStore.setState(s => ({ groups: s.groups.map(g => g.id === gid && g.effect ? { ...g, effect: { ...g.effect, ...patch } } : g) }))
    return
  }
  const n = useFreeNodeStore.getState().nodes[id]
  if (n?.effect) useFreeNodeStore.getState().updateFreeNode(id, { effect: { ...n.effect, ...patch } })
}

/** The other effects in `id`'s chain, by face id: those docked on the
 *  same loop strip, or in the same effect strip on the canvas. */
export function chainSiblings(id: string): string[] {
  const nodes = useFreeNodeStore.getState().nodes
  const dock = nodes[id]?.railDock
  if (dock) {
    return Object.values(nodes).filter(n => n.id !== id && n.type === 'effect' && n.railDock?.railId === dock.railId).map(n => n.id)
  }
  const fx = useFxStore.getState()
  const key = fx.byNode[id]
  const strip = key ? fx.strips[key] : undefined
  return strip ? strip.items.filter(it => it.kind === 'effect' && it.id !== id).map(it => it.id) : []
}

/** Is another effect in `id`'s chain soloed (so this one is not running)? */
export function soloedElsewhere(id: string): boolean {
  return chainSiblings(id).some(s => !!effectOf(s)?.solo)
}

/** Switch effect `id` on or off. One undo step. */
export function toggleEffectOff(id: string): void {
  const e = effectOf(id)
  if (!e) return
  useUndoCoordinator.getState().checkpoint()
  writeEffect(id, { off: e.off ? undefined : true })
}

/** Solo effect `id` — the only one its chain runs — or, soloed already,
 *  clear it. One undo step. */
export function toggleEffectSolo(id: string): void {
  const e = effectOf(id)
  if (!e) return
  useUndoCoordinator.getState().checkpoint()
  if (e.solo) { writeEffect(id, { solo: undefined }); return }
  for (const s of chainSiblings(id)) if (effectOf(s)?.solo) writeEffect(s, { solo: undefined })
  writeEffect(id, { solo: true })
}
