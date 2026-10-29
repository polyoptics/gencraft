// effectDragOut.ts — pull a copy of an effect out by its ↑ handle.
//
// A picture card's ↑ hands its FILE to the OS (DragOutGrip). An effect has
// no file — its pass is a live render — so its ↑ works inside the app: the
// drag carries a copy of the effect (kind, settings, phrases, on/off; never
// soloed — solo is one per chain), and where it is let go decides what the
// copy becomes, as for an effect card dragged there:
//
//   on a loop strip       → wherever the strip takes it (railDropTarget):
//                           into a row, or tucked under an effect as its
//                           side input (a Depth or Segment pass as a matte)
//   on a picture card     → an effect card at the end of its effect stack
//   on bare canvas        → an effect card there (it lines up with a stack
//                           it lands beside)
//
// The original stays where it is. One undo step per drag.

import { useBoardsStore } from '../../store/boardsStore'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useRailUiStore } from '../../store/railUiStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { railAtPoint } from '../../components/Canvas/rail/railHit'
import { createEffectCardGroup } from '../effectCards'
import { isRail, railDropTarget, railLayout, railMembers, type RailDropTarget } from '../rail'
import { clientToCanvas } from './createEffect'
import { EFFECTS } from './effects'
import { effectOf } from './effectToggles'

type Effect = NonNullable<FreeNodeData['effect']>
const DRAG_ID = '__effect-drag-out'

/** The picture card (not an effect card) under client (x, y), if any. */
export function pictureCardAt(x: number, y: number): string | null {
  const groups = useBoardsStore.getState().groups
  for (const el of document.elementsFromPoint(x, y)) {
    const id = el.closest<HTMLElement>('[data-group-card]')?.dataset.id
    if (!id) continue
    const g = groups.find(gr => gr.id === id)
    return g && !g.effect ? id : null
  }
  return null
}

/** Where a copy of `effect` let go at client (x, y) on a loop strip goes. */
function railTarget(effect: Effect, x: number, y: number): RailDropTarget | null {
  const nodes = useFreeNodeStore.getState().nodes
  const railId = railAtPoint(x, y, nodes)
  const rail = railId ? nodes[railId] : undefined
  if (!isRail(rail)) return null
  const L = railLayout(rail, railMembers(nodes).get(rail.id))
  if (!L) return null
  const { cx, cy } = clientToCanvas(x, y)
  // A stand-in for the copy: the strip reads only its type and effect.
  const probe = { id: DRAG_ID, type: 'effect', effect, x: 0, y: 0, width: 0, height: 0, label: '', text: '', imageUrl: null, color: '' } as FreeNodeData
  return railDropTarget(L, rail, { x: cx, y: cy }, probe)
}

/** Press on an effect's ↑ (face id `id`: a tile's, or `card:<group>`):
 *  drag a copy of it out (see the top of the file). */
export function startEffectDragOut(e: React.PointerEvent, id: string): void {
  if (e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  const src = effectOf(id)
  if (!src) return
  const effect: Effect = { ...src, params: { ...(src.params ?? {}) }, solo: undefined }
  const x0 = e.clientX, y0 = e.clientY
  let moved = false
  let rail: RailDropTarget | null = null
  let card: string | null = null
  // A tag under the pointer: what is being carried.
  const tag = document.createElement('div')
  tag.textContent = `${EFFECTS[effect.kind]?.glyph ?? ''} ${EFFECTS[effect.kind]?.label ?? 'Effect'}`
  Object.assign(tag.style, {
    position: 'fixed', zIndex: '100000', pointerEvents: 'none', padding: '3px 8px', borderRadius: '6px',
    background: 'rgba(20,22,32,0.92)', color: '#fff', font: '600 12px system-ui, sans-serif',
    border: '1px solid rgba(255,255,255,0.3)', boxShadow: '0 4px 14px rgba(0,0,0,0.5)', display: 'none',
  })
  document.body.appendChild(tag)
  const ui = () => useRailUiStore.getState()
  const onMove = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
    moved = true
    tag.style.display = 'block'
    tag.style.left = `${ev.clientX + 12}px`
    tag.style.top = `${ev.clientY + 12}px`
    rail = railTarget(effect, ev.clientX, ev.clientY)
    card = rail ? null : pictureCardAt(ev.clientX, ev.clientY)
    if (rail) ui().setDrop({ target: rail, draggedId: DRAG_ID })
    else if (ui().drop?.draggedId === DRAG_ID) ui().setDrop(null)
  }
  const end = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    tag.remove()
    if (ui().drop?.draggedId === DRAG_ID) ui().setDrop(null)
    if (!moved || ev.type === 'pointercancel') return
    useUndoCoordinator.getState().checkpoint()
    const t = rail as RailDropTarget | null
    if (t) {
      const fs = useFreeNodeStore.getState()
      const tile = fs.addFreeNode(0, 0, 'effect')
      useFreeNodeStore.getState().updateFreeNode(tile, { effect, label: EFFECTS[effect.kind]?.label ?? 'Effect' })
      useFreeNodeStore.getState().dockToRail([tile], t)
      return
    }
    const gid = card
      ? createEffectCardGroup(effect.kind, { after: card })
      : createEffectCardGroup(effect.kind, { at: clientToCanvas(ev.clientX, ev.clientY) })
    useBoardsStore.setState(s => ({ groups: s.groups.map(g => g.id === gid ? { ...g, effect } : g) }))
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
}
