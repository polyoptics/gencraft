// liveTop.ts — a 3D set seen in the flat view as live 3D (Brian
// 2026-11-13: "having it be the real 3D top view is really cool too").
// Each 3D set has its own choice of how its models show looking straight
// down (FreeNodeData.flatView; the set's right-click menu, beside its
// Ground): as pieces, pictures from above (utils/scenePieces, as it
// always was), or live: the models themselves, drawn by the 3D view from
// straight above each frame, so one banking along a curving path shows it
// as it goes. A live set's models have no piece; they stand whole at any
// tilt (three/tiltScene `full`), so tipping into 3D nothing of theirs
// changes.
//
// Live, they are worked as in the 3D view: a click selects, the selected
// one wears the handles (W move, E rotate, R scale; utils/area3dHandles),
// and with the rotate handles out a drag on the model turns it. Any other
// drag on a model moves it in its set, as a drag on its piece does
// (components/Canvas/PieceLayer). Installed once when this module loads,
// after the handles: a press on a handle is theirs.

import './area3dHandles'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import { useTiltStore, isTilted } from '../store/tiltStore'
import { useManip } from '../store/manipStore'
import { useNotesUi } from '../store/notesStore'
import { scenePieces, pieceSelected, type ScenePiece } from './scenePieces'
import { models, modelKey } from '../components/Canvas/tilt/TiltModels'
import { SPIN_RAD } from '../components/Canvas/tilt/altCamera'

/** What of a press a piece goes by. */
export type PiecePress = Pick<PointerEvent, 'button' | 'altKey' | 'shiftKey' | 'clientX' | 'clientY' | 'preventDefault' | 'stopPropagation'>
/** A press on a piece (components/Canvas/PieceLayer, which sets it): it
 *  selects its model, and dragged, moves it in its set. */
export const piecePress: { fn: ((e: PiecePress, p: ScenePiece) => void) | null } = { fn: null }

let memo: { list: ScenePiece[]; nodes: unknown; keys: Set<string> } | null = null
const NONE = new Set<string>()

/** The models of the sets shown live in the flat view, as the 3D view
 *  knows them and as their settings are kept (both keys of each). The
 *  same set (by identity) while nothing it is worked out from changed. */
export function liveKeys(): Set<string> {
  const nodes = useFreeNodeStore.getState().nodes
  const list = scenePieces()
  if (memo && memo.list === list && memo.nodes === nodes) return memo.keys
  let keys = NONE
  for (const p of list) {
    if (!p.areaId || nodes[p.areaId]?.flatView !== 'live') continue
    if (keys === NONE) keys = new Set()
    keys.add(p.key); keys.add(p.dk)
  }
  memo = { list, nodes, keys }
  return keys
}

/** Looking straight down with a live set's models to draw: the 3D view
 *  draws them over the flat canvas. (Not looking through a camera, which
 *  is the 3D view's own.) */
export function flatLive(): boolean {
  if (isTilted(useTiltStore.getState()) || useManip.getState().through) return false
  return liveKeys().size > 0
}

/** The 3D view's handles and keys are in reach: tipped into 3D, or flat
 *  with a live set's models showing. */
export const handlesLive = (): boolean => isTilted(useTiltStore.getState()) || flatLive()

/** Is a live set's model selected, looking straight down? (The handles'
 *  keys, W E R + -, are for it then.) */
export function flatLiveSelected(): boolean {
  if (!flatLive()) return false
  const live = liveKeys()
  return useFreeNodeStore.getState().selectedIds.some(id => live.has(`node:${id}`)) || useBoardsStore.getState().selectedGroupIds.some(id => live.has(`card:${id}`))
}

// ── Presses on a live model, looking straight down ──

/** On the canvas itself: not a pinned panel, a menu or a bar over it. */
function onCanvas(t: EventTarget | null): boolean {
  const el = t as Element | null
  return !!el?.closest && !!el.closest('[data-tilt-stage]') && !el.closest('[data-pin-host],[data-notes-panel],[data-top-icon-bar],[data-ride-bar]')
}

/** The live model under a client point, as its piece (where it stands,
 *  what it rides). */
function liveAt(x: number, y: number): ScenePiece | null {
  const key = modelKey(models.pick?.(x, y))
  if (!key) return null
  const live = liveKeys()
  return scenePieces().find(p => (p.key === key || p.dk === key) && live.has(p.key)) ?? null
}

function onDown(e: PointerEvent) {
  if (!e.isTrusted || e.button !== 0 || e.altKey || !flatLive() || !onCanvas(e.target)) return
  // With a tool in the hand a press is that tool's.
  const tool = useNotesUi.getState().tool
  if (tool === 'pen' || tool === 'pin' || tool === 'erase' || tool === 'curve') return
  // (A handle is the handles' own, whichever of the two hears it first.)
  if (models.gizmoAt?.(e.clientX, e.clientY)) return
  const p = liveAt(e.clientX, e.clientY)
  if (!p) return
  e.stopImmediatePropagation()
  models.at = null
  // The rotate handles out: a drag on the model itself turns it, and the
  // turn is kept, as in the 3D view.
  if (useManip.getState().mode === 'rotate' && models.spin && !p.riding) {
    e.preventDefault()
    const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
    const keep = !e.shiftKey && pieceSelected(p.key, fs.selectedIds, bs.selectedGroupIds)
    if (!keep) selectKey(p.key, e.shiftKey)
    let last = { x: e.clientX, y: e.clientY }, moved = false
    const x0 = e.clientX, y0 = e.clientY
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
      moved = true
      models.spin?.(p.key, ev.clientX - last.x, ev.clientY - last.y, SPIN_RAD)
      last = { x: ev.clientX, y: ev.clientY }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (moved) models.letGo?.(p.key)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return
  }
  piecePress.fn?.(e, p)
}

/** Select what a model stands for (TiltModels selectModel, come to
 *  through the piece's press so the two never part). */
function selectKey(key: string, add: boolean) {
  const id = key.slice(key.indexOf(':') + 1)
  const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
  if (key.startsWith('node:')) {
    fs.setFreeSelection(add ? [...new Set([...fs.selectedIds, id])] : [id])
    if (!add) bs.clearGroupSelection()
  } else {
    bs.setSelectedGroups(add ? [...new Set([...bs.selectedGroupIds, id])] : [id])
    if (!add) fs.setFreeSelection([])
  }
}

/** The model under the cursor lights up, as in the 3D view (which asks
 *  again each frame from `models.at`). */
function onMove(e: PointerEvent) {
  if (isTilted(useTiltStore.getState())) return
  if (!flatLive()) { if (models.at) { models.at = null; models.hovered = null } return }
  models.at = e.buttons === 0 && !e.altKey && onCanvas(e.target) ? { x: e.clientX, y: e.clientY } : null
  if (!models.at) models.hovered = null
}

type Handlers = { onDown: typeof onDown; onMove: typeof onMove }
const w = (typeof window !== 'undefined' ? window : undefined) as (Window & { __liveTop?: Handlers }) | undefined
if (w) {
  const first = !w.__liveTop
  w.__liveTop = { onDown, onMove }
  if (first) {
    w.addEventListener('pointerdown', e => w.__liveTop!.onDown(e), true)
    w.addEventListener('pointermove', e => w.__liveTop!.onMove(e), true)
  }
}
