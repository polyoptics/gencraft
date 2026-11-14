// stateScene.ts — where the state workspaces (utils/stateSpace) meet the
// board: paths and what rides them, and cards shown or hidden. (Kept apart
// from stateSpace so that file need not import the path code.)
//
// Nothing here changes a card, a path or a model. What a workspace asks for
// is laid over the board only for as long as it asks:
//   - a path that follows a timeline: its set's ride clock is put where that
//     timeline's marker is, so what rides it moves as the story is scrubbed
//     or played;
//   - a path told to play: its set's ride clock is started from the top;
//   - a path's riders standing at one of its points, a path taking its set's
//     other riders: utils/pathRide useRideOverride (where riders are drawn);
//   - a card hidden: a style rule, by the card's id.
// And the other way: as a ride clock runs by itself (a set's Play bar), a
// rider reaching a point of a path sends from that point of its path node.

import { useNotesStore } from '../store/notesStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { parentOf } from './curveParent'
import { rideSetOf, ridePointTime, rideTotal, rideTime, useRideClock, useRideOverride } from './pathRide'
import { scene, sceneState, pathPoint } from './stateSpace'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The cards hidden for now, as a style rule: nothing of a card is touched. */
let hiddenNow: string[] = []
function hide(ids: string[]): void {
  const next = [...new Set(ids)].sort()
  if (same(next, hiddenNow)) return
  hiddenNow = next
  let el = document.getElementById('vb-state-scene') as HTMLStyleElement | null
  if (!el) { el = document.createElement('style'); el.id = 'vb-state-scene'; document.head.appendChild(el) }
  const q = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '')
  el.textContent = next.map(id => `[data-layer-card="${q(id)}"],[data-group-card][data-id="${q(id)}"],[data-nle-card="${q(id)}"]{opacity:0!important;pointer-events:none!important;transition:opacity .25s}`).join('\n')
}
/** The cards a workspace hides for now. */
export const hiddenCards = (): string[] => hiddenNow

function sync(): void {
  const st = sceneState()
  const curves = useNotesStore.getState().curves
  // Paths that follow a timeline: their set's clock stands where its marker is.
  const clock = useRideClock.getState()
  for (const [id, frac] of Object.entries(st.follow)) {
    const c = curves[id]
    if (!c) continue
    const set = rideSetOf(c)
    const t = Math.max(0, Math.min(1, frac)) * rideTotal(set)
    if (clock.clocks[set]?.playing) clock.pause(set)
    if (Math.abs(rideTime(set) - t) > 1e-4) clock.seek(t, set)
  }
  // Riders held at a point; riders taken onto another path of their set.
  const take: Record<string, string> = {}
  for (const id of st.take) {
    const to = curves[id]
    if (!to || to.pts.length < 2) continue
    const set = rideSetOf(to)
    for (const c of Object.values(curves)) if (c.id !== id && rideSetOf(c) === set) for (const r of c.riders ?? []) take[r.key] = id
  }
  const over = useRideOverride.getState()
  if (!same(over.hold, st.hold) || !same(over.take, take)) useRideOverride.setState({ hold: st.hold, take })
  hide(st.hidden)
}

let started = false
export function startStateScene(): void {
  if (started) return
  started = true
  scene.path = id => {
    const c = id ? useNotesStore.getState().curves[id] : undefined
    if (!c || c.pts.length < 2) return null
    const nodes = useFreeNodeStore.getState().nodes
    const set = rideSetOf(c), parent = parentOf(c, nodes)
    const r = c.riders?.[0]
    return {
      name: c.name || 'Path', setName: parent ? nodes[parent]?.label || '3D set' : undefined, n: c.pts.length, labels: c.pts.map(q => q.label?.trim() ?? ''),
      times: r ? c.pts.map((_, i) => ridePointTime(c, r, i)) : [], total: rideTotal(set), now: rideTime(set),
    }
  }
  scene.play = id => {
    const c = useNotesStore.getState().curves[id]
    if (!c) return
    const set = rideSetOf(c)
    useRideClock.getState().seek(0, set)
    useRideClock.getState().play(set)
  }
  let due = 0
  scene.sync = () => { if (!due) due = window.setTimeout(() => { due = 0; sync() }, 0) }
  useNotesStore.subscribe((s, prev) => { if (s.curves !== prev.curves) scene.sync() })
  scene.sync()

  // As a clock runs by itself: a rider reaching a point of a path sends
  // from that point (once each time round).
  let timer = 0
  let last: Record<string, number> = {}
  const tick = (final = false) => {
    const wanted = new Set<string>()
    for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
      if (n.type === 'stateSpace') for (const i of n.stateSpace?.items ?? []) if (i.kind === 'path' && i.curve) wanted.add(i.curve)
    }
    const curves = useNotesStore.getState().curves
    const now: Record<string, number> = {}
    for (const id of wanted) {
      const c = curves[id], r = c?.riders?.[0]
      if (!c || !r) continue
      const set = rideSetOf(c)
      // (The last look, as a clock stops: what it passed on its way to where it stopped.)
      if (!useRideClock.getState().clocks[set]?.playing && !(final && set in last)) continue
      const t = now[set] ?? (now[set] = rideTime(set))
      const was = last[set] ?? (t < 0.3 ? -1 : t)
      if (t <= was) continue
      c.pts.forEach((_, i) => { const at = ridePointTime(c, r, i); if (at > was && at <= t + 1e-3) pathPoint(id, i) })
    }
    last = now
  }
  useRideClock.subscribe(s => {
    if (s.playing && !timer) { last = {}; timer = window.setInterval(() => tick(), 50) }
    else if (!s.playing && timer) { window.clearInterval(timer); timer = 0; tick(true); last = {} }
  })
}
