// areaFollow.ts — what is on an Area card moves with it (Brian 2026-11-07,
// components/Notes/AreaBody). When an Area moves (not resized), whatever lay
// on it and did not move itself goes the same way: tiles and models (other
// Areas too, with what is on them), cards and Viewers. "On it" is where it
// lies: its middle inside the Area. A curve goes with the Area it is
// parented to, wherever it lies (Brian 2026-11-12, utils/curveParent); one
// from before curves had parents, when it lies wholly on the Area.

import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import { useViewport3DStore } from '../store/viewport3dStore'
import { useNotesStore } from '../store/notesStore'
import { isUnder, laying, lyingIn, setCards } from './area3dScene'
import { isUndoRestoring } from '../store/undoCoordinator'

type R = { x: number; y: number; width: number; height: number }
const inside = (a: R, px: number, py: number) => px >= a.x && px <= a.x + a.width && py >= a.y && py <= a.y + a.height

/** The Area each thing lies on (the smallest, for nested ones), or null. */
export function areaAt(nodes: Record<string, FreeNodeData>, px: number, py: number, not?: string): FreeNodeData | null {
  let best: FreeNodeData | null = null
  for (const n of Object.values(nodes)) {
    if (n.type !== 'area' || n.id === not || n.pin || !inside(n, px, py)) continue
    if (!best || n.width * n.height < best.width * best.height) best = n
  }
  return best
}

let busy = false
if (typeof window !== 'undefined' && !(window as unknown as { __areaFollow?: boolean }).__areaFollow) {
  (window as unknown as { __areaFollow?: boolean }).__areaFollow = true
  useFreeNodeStore.subscribe((s, prev) => {
    if (busy || s.nodes === prev.nodes) return
    for (const a0 of Object.values(s.nodes)) {
      if (a0.type !== 'area' || a0.pin) continue
      const was = prev.nodes[a0.id]
      let a = a0
      // An area never collects what it comes to cover (Brian 2026-11-10:
      // "like a black hole"): made, moved or resized over things, they
      // are under it, not on it (area3dScene isUnder), until one is moved
      // by hand. Before anything on it is moved along, so what rides with
      // it is still where it lay.
      if (!laying.on && !isUndoRestoring() && (!was || was.x !== a.x || was.y !== a.y || was.width !== a.width || was.height !== a.height)) {
        const before = new Set(was ? lyingIn(was, a.areaCard, a.id) : [])
        const fresh = lyingIn(a, a.areaCard, a.id).filter(k => !before.has(k) && !isUnder(a, k))
        if (fresh.length) {
          a = { ...a, under: [...(a.under ?? []), ...fresh] }
          busy = true
          try { useFreeNodeStore.getState().updateFreeNode(a.id, { under: a.under }) } finally { busy = false }
        }
      }
      // (An undo or redo puts each thing back itself: moved along as well,
      // the cards on it landed a second move away.)
      if (!was || isUndoRestoring() || (was.x === a.x && was.y === a.y) || was.width !== a.width || was.height !== a.height) continue
      const dx = a.x - was.x, dy = a.y - was.y
      // What lay on it and stayed put (a selection dragged along with it
      // has already moved).
      const tiles = Object.values(prev.nodes).filter(n => {
        if (n.id === a.id || n.pin || n.railDock || n.tileDeck && n.tileDeck.anchor !== n.id) return false
        const now = s.nodes[n.id]
        if (!now || now.x !== n.x || now.y !== n.y) return false
        // It lay there before the area opened over it: it stays (isUnder).
        if (isUnder(a, `node:${n.id}`)) return false
        return inside(was, n.x + n.width / 2, n.y + n.height / 2)
      }).map(n => n.id)
      busy = true
      try {
        if (tiles.length) useFreeNodeStore.getState().moveManyFreeNodes(tiles, dx, dy)
        const bs = useBoardsStore.getState()
        // On it, and the model cards docked along its sides (utils/area3dScene).
        const cards = setCards({ x: was.x, y: was.y, width: was.width, height: was.height, under: a.under }, bs.groups, bs.boards)
        if (cards.length) bs.setGroupPosBatch(cards.map(g => ({ groupId: g.id, originY: g.originY + dy, originX: g.originX + dx })))
        const v3 = useViewport3DStore.getState()
        for (const w of Object.values(v3.windows)) {
          if (!isUnder(a, `viewer:${w.id}`) && inside(was, w.x + w.width / 2, w.y + w.height / 2)) v3.updateWindow(w.id, { x: w.x + dx, y: w.y + dy })
        }
        const ns = useNotesStore.getState()
        // Its own curves, and those of the Areas it carried along.
        const carried = new Set([a.id, ...tiles.filter(id => prev.nodes[id].type === 'area')])
        const curves = Object.values(ns.curves).filter(c => {
          if (c.parent === null) return false
          if (c.parent !== undefined) return carried.has(c.parent)
          return !isUnder(a, `curve:${c.id}`) && c.pts.length > 0 && c.pts.every(p => inside(was, p.x, p.y))
        }).map(c => c.id)
        if (curves.length) ns.moveCurves(curves, dx, dy)
      } finally { busy = false }
    }
  })
}
