// effectClipboard.ts — copy an effect, paste it somewhere else.
//
// Copy takes an effect as it is — kind, settings, phrases, on/off — from an
// effect tile (free, or docked on a loop strip) or an effect card. Paste
// puts a copy where the selection says:
//
//   a loop strip              → the end of its row
//   an effect on a strip      → right after it in that row
//   a free effect tile        → a new tile just to its right
//   a picture card            → the end of its effect stack
//   an effect card            → the end of the stack it is in
//   nothing                   → a new effect card mid-screen
//
// A pasted copy is never soloed: solo is one per chain, and the copy would
// take it from the one it was copied from.

import { useBoardsStore } from '../../store/boardsStore'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { createEffectCardGroup } from '../effectCards'
import { isRail } from '../rail'

type Effect = NonNullable<FreeNodeData['effect']>

let clip: Effect | null = null

/** Is there an effect to paste? */
export const hasEffectClip = (): boolean => !!clip

/** Copy the effect of tile `nodeId` or card `groupId`. True if it had one. */
export function copyEffect(from: { nodeId?: string; groupId?: string }): boolean {
  const e = from.nodeId
    ? useFreeNodeStore.getState().nodes[from.nodeId]?.effect
    : useBoardsStore.getState().groups.find(g => g.id === from.groupId)?.effect
  if (!e) return false
  clip = { ...e, params: { ...(e.params ?? {}) }, solo: undefined }
  return true
}

/** The one effect in the current selection, if the selection is exactly
 *  that — for Ctrl+C. */
export function selectedEffect(): { nodeId?: string; groupId?: string } | null {
  const tiles = useFreeNodeStore.getState().selectedIds
  const cards = useBoardsStore.getState().selectedGroupIds
  if (tiles.length === 1 && cards.length === 0 && useFreeNodeStore.getState().nodes[tiles[0]]?.effect) return { nodeId: tiles[0] }
  if (cards.length === 1 && tiles.length === 0 && useBoardsStore.getState().groups.find(g => g.id === cards[0])?.effect) return { groupId: cards[0] }
  return null
}

/** Paste the copied effect at `to` (see the top of the file), or by the
 *  current selection when `to` is omitted. One undo step. False when
 *  there is nothing to paste. */
export function pasteEffect(to?: { nodeId?: string; groupId?: string }): boolean {
  if (!clip) return false
  const e: Effect = { ...clip, params: { ...(clip.params ?? {}) } }
  const fs = useFreeNodeStore.getState()
  const bs = useBoardsStore.getState()
  const target = to ?? (fs.selectedIds.length === 1 ? { nodeId: fs.selectedIds[0] }
    : bs.selectedGroupIds.length === 1 ? { groupId: bs.selectedGroupIds[0] } : {})
  useUndoCoordinator.getState().checkpoint()
  const node = target.nodeId ? fs.nodes[target.nodeId] : undefined
  const newTile = () => {
    const id = fs.addFreeNode(0, 0, 'effect')
    useFreeNodeStore.getState().updateFreeNode(id, { effect: e })
    return id
  }
  if (node && isRail(node)) {
    useFreeNodeStore.getState().dockToRail([newTile()], { railId: node.id, kind: 'row', insertAt: node.rail.slots.length })
    return true
  }
  if (node?.type === 'effect' && node.railDock) {
    const rail = fs.nodes[node.railDock.railId]
    const at = isRail(rail) ? rail.rail.slots.findIndex(s => s.id === node.railDock!.slotId) + 1 : 0
    useFreeNodeStore.getState().dockToRail([newTile()], { railId: node.railDock.railId, kind: 'row', insertAt: at })
    return true
  }
  if (node?.type === 'effect') {
    const id = newTile()
    useFreeNodeStore.getState().updateFreeNode(id, { x: node.x + node.width, y: node.y, width: node.width, height: node.height })
    useFreeNodeStore.getState().setFreeSelection([id])
    return true
  }
  const gid = createEffectCardGroup(e.kind, target.groupId ? { after: target.groupId } : {})
  useBoardsStore.setState(st => ({ groups: st.groups.map(g => g.id === gid ? { ...g, effect: e } : g) }))
  return true
}
