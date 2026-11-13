// curveParent.ts — what a curve belongs to (Brian 2026-11-12: "if an arrow
// is drawn and any part of it is inside of the 3D area, then it moves with
// the 3D set area, by a parent relationship"). A curve parented to a 3D set
// goes where the set goes (utils/areaFollow) and folds into its card and
// comes back out with it (utils/area3dCard), wherever it lies; one with no
// parent stays where it is. The parent is given when the curve is drawn
// and changed only by hand: select the curve, then the set, and P parents
// it, Shift-P unparents it (utils/notesTool); in the Outliner, its row
// dropped on a set, or on Canvas (components/Notes/NotesPanel).

import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { useNotesStore, type Curve } from '../store/notesStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { areaAt } from './areaFollow'
import { isUnder } from './area3dScene'
import { curveSamples } from './curveGeom'

type Nodes = Record<string, FreeNodeData>
type Line = Pick<Curve, 'kind' | 'pts' | 'closed' | 'smooth'>

/** The 3D set curve `c` belongs to (its ground's node id), or null. */
export function parentOf(c: Curve, nodes: Nodes = useFreeNodeStore.getState().nodes): string | null {
  if (c.parent === null) return null
  if (c.parent !== undefined) return nodes[c.parent]?.type === 'area' ? c.parent : null
  // Drawn before curves had parents: it went with the set it lay wholly on
  // (the smallest, for nested ones), unless it lay there before that set
  // opened over it (area3dScene isUnder). As it was, till it is parented
  // or unparented by hand.
  if (!c.pts.length) return null
  let best: FreeNodeData | null = null
  for (const a of Object.values(nodes)) {
    if (a.type !== 'area' || a.pin || isUnder(a, `curve:${c.id}`)) continue
    if (!c.pts.every(p => p.x >= a.x && p.x <= a.x + a.width && p.y >= a.y && p.y <= a.y + a.height)) continue
    if (!best || a.width * a.height < best.width * best.height) best = a
  }
  return best?.id ?? null
}

/** The curves that belong to 3D set `areaId`. */
export function curvesOf(areaId: string, nodes: Nodes = useFreeNodeStore.getState().nodes): Curve[] {
  return Object.values(useNotesStore.getState().curves).filter(c => parentOf(c, nodes) === areaId)
}

/** Does the straight line a to b pass through box `r`? */
function crosses(r: FreeNodeData, ax: number, ay: number, bx: number, by: number): boolean {
  let t0 = 0, t1 = 1
  const dx = bx - ax, dy = by - ay
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t }
    else { if (t < t0) return false; if (t < t1) t1 = t }
    return true
  }
  return clip(-dx, ax - r.x) && clip(dx, r.x + r.width - ax) && clip(-dy, ay - r.y) && clip(dy, r.y + r.height - ay)
}

/** The parent a curve just drawn gets: the 3D set any part of it lies on
 *  (where it lies on several, the one most of it is on; the smallest, for
 *  nested ones), else nothing. Its line as seen from above: a point's
 *  height does not count. */
export function drawnParent(c: Line, nodes: Nodes = useFreeNodeStore.getState().nodes): string | null {
  const line = curveSamples(c)
  if (!line.length) return null
  // Along the line in even steps, so a long stretch counts for more.
  let total = 0
  for (let i = 1; i < line.length; i++) total += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y)
  const step = total / 240
  const on = new Map<string, number>()
  const count = (x: number, y: number) => {
    const a = areaAt(nodes, x, y)
    if (a) on.set(a.id, (on.get(a.id) ?? 0) + 1)
  }
  count(line[0].x, line[0].y)
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i]
    const n = step > 0 ? Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step)) : 1
    for (let k = 1; k <= n; k++) count(a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n)
  }
  let best: string | null = null, most = 0
  for (const [id, n] of on) if (n > most) { best = id; most = n }
  if (best) return best
  // It only clips a corner, between two steps: still a part of it.
  let clipped: FreeNodeData | null = null
  for (const a of Object.values(nodes)) {
    if (a.type !== 'area' || a.pin) continue
    let hit = false
    for (let i = 1; i < line.length && !hit; i++) hit = crosses(a, line[i - 1].x, line[i - 1].y, line[i].x, line[i].y)
    if (hit && (!clipped || a.width * a.height < clipped.width * clipped.height)) clipped = a
  }
  return clipped?.id ?? null
}

/** Parents curves `ids` to 3D set `areaId` (null: to nothing), as one undo
 *  step. False when they all were already. */
export function parentCurves(ids: string[], areaId: string | null): boolean {
  const ns = useNotesStore.getState()
  const todo = ids.filter(id => ns.curves[id] && ns.curves[id].parent !== areaId)
  if (!todo.length) return false
  useUndoCoordinator.getState().checkpoint()
  for (const id of todo) ns.updateCurve(id, { parent: areaId })
  return true
}
