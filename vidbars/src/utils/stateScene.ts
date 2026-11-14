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
import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { cardVisualRect } from '../hooks/useCardDecks'
import { createTextCard } from './cardGrid'
import { makeLinkedCard, masterOf } from './linkedCards'
import { markNew } from './newCards'
import { scene, sceneState, pathPoint, spaceOf, lineClock, lineOf, valOf, type SpaceItem } from './stateSpace'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The cards hidden for now, as a style rule: nothing of a card is touched. */
let hiddenNow: string[] = []
function hide(ids: string[]): void {
  const next = [...new Set(ids)].sort()
  if (same(next, hiddenNow)) return
  hiddenNow = next
  useRideOverride.setState({ hidden: next })
  let el = document.getElementById('vb-state-scene') as HTMLStyleElement | null
  if (!el) { el = document.createElement('style'); el.id = 'vb-state-scene'; document.head.appendChild(el) }
  const q = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '')
  el.textContent = next.map(id => `[data-layer-card="${q(id)}"],[data-group-card][data-id="${q(id)}"],[data-nle-card="${q(id)}"],[data-card-header="${q(id)}"],[data-row-band="${q(id)}"],[data-primary-rail="${q(id)}"]{opacity:0!important;pointer-events:none!important;transition:opacity .25s}`).join('\n')
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
  // A project opened, a workspace changed or taken away: the board follows.
  useFreeNodeStore.subscribe((s, prev) => {
    if (s.nodes === prev.nodes) return
    const spaces = (nodes: typeof s.nodes) => Object.values(nodes).filter(n => n.type === 'stateSpace')
    const now = spaces(s.nodes), was = spaces(prev.nodes)
    if (now.length !== was.length || now.some(n => n.stateSpace !== prev.nodes[n.id]?.stateSpace)) scene.sync()
  })
  useCanvasStore.subscribe((s, prev) => { if (s.worldClockLine !== prev.worldClockLine) scene.sync() })
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

// ── A snapshot ──

/** How things stand in a workspace, as a closed deck beside it: a card that
 *  says what is lit and what the values are (and where the timelines are),
 *  then a linked card for each lit node's card. New cards only: nothing
 *  that is there is moved. One undo. Returns the front card, or null when
 *  there is nothing to show. */
export function snapshotSpace(nodeId: string): string | null {
  const n = useFreeNodeStore.getState().nodes[nodeId]
  const d = spaceOf(nodeId)
  if (!n || !d) return null
  const groups = useBoardsStore.getState().groups
  const nameOf = (i: SpaceItem) => i.name || groups.find(g => g.id === i.card)?.name || 'State'
  const lit = d.items.filter(i => (i.kind === 'card' || i.kind === 'blank') && i.now)
  const vals = d.items.filter(i => i.kind === 'value')
  if (!lit.length && !vals.length) return null
  // The moment: each timeline, by the last of its points the marker is past.
  const when = d.items.filter(i => i.kind === 'timeline').flatMap(i => {
    const c = lineClock(lineOf(i))
    if (!c) return []
    const past = c.dots.filter(p => p.at <= c.at)
    return [`${i.name || c.title}: ${past.length ? 'after ' + past[past.length - 1].title : 'before ' + (c.dots[0]?.title ?? 'the start')}`]
  })
  const body = [
    ...when, when.length ? '' : null,
    ...lit.map(i => nameOf(i)),
    lit.length && vals.length ? '' : null,
    ...vals.map(i => `${i.name || 'Value'}: ${i.flag ? (valOf(i) ? 'yes' : 'no') : Math.round(valOf(i) * 100) / 100}`),
  ].filter((x): x is string => x !== null).join('\n')
  useUndoCoordinator.getState().checkpoint()
  const zoom = useCanvasStore.getState().zoom
  const front = createTextCard({ cx: n.x + n.width + 60 / zoom, cy: n.y }, { title: `${n.label || 'States'}: snapshot`, body })
  const ids = [front]
  const seen = new Set<string>()
  for (const i of lit) {
    const master = i.card && groups.some(g => g.id === i.card) ? masterOf(groups, i.card) : null
    if (!master || seen.has(master)) continue
    seen.add(master)
    const l = makeLinkedCard(master)
    if (l) ids.push(l)
  }
  // A row of touching cards from the front one, closed onto it.
  const rect = (id: string) => { const bs = useBoardsStore.getState(); const g = bs.groups.find(x => x.id === id); return g ? { g, r: cardVisualRect(g, bs.boards, zoom)?.rect } : null }
  const f = rect(front)
  if (f?.r && ids.length > 1) {
    let x = f.r.right + 8
    const moves: { groupId: string; originX: number; originY: number }[] = []
    for (const id of ids.slice(1)) {
      const c = rect(id)
      if (!c?.r) continue
      moves.push({ groupId: id, originX: c.g.originX + (x - c.r.left), originY: c.g.originY + (f.r.top - c.r.top) })
      x += c.r.right - c.r.left + 8
    }
    if (moves.length) useBoardsStore.getState().setGroupPosBatch(moves)
    useBoardsStore.getState().setDeckState(ids, 'stacked', { asGiven: true })
  }
  markNew(ids)
  return front
}
