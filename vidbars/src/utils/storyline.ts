// ─── Storyline: points on lines that branch ───
//
// A storyline starts as one point. Dragging out from it grows its line;
// clicking on a line puts a point there; dragging from a point off to the
// side grows a new line from it (a branch), and branches branch the same
// way — story branches, family trees, a faction's leader to followers.
//
// Stored on its free node (FreeNodeData.storyline), RELATIVE to the node's
// x/y, which this module keeps the bounding box of the lines (normalized),
// so everything that moves or frames a node by its box (cabinet projects,
// F to frame) carries a storyline whole.
//
// A line is a straight segment. The first line is the ROOT: its start is
// stored (x, y). Every other line starts at the point it grew from (`from`)
// and goes along (dx, dy) from there, so moving that point takes the branch
// with it. A point sits `t` canvas units along its line from the start, with
// a stem `up` / `down` units across it each way.
//
// Cards linked to a point (`cards`, group ids) move with it when it is
// dragged. A link is made by dropping a card's link "+" on the point (the
// target owns the reference, as everywhere else — see LinkDragOverlay).
//
// Every dot is a point: each line's end has one, and so has the root's start
// (canonicalStoryline keeps it so, and turns older storylines' held spots and
// bare ends into points as they load).

export interface StoryLine {
  id: string
  /** The point this line grows from; null on the root line. */
  from: string | null
  /** Root line only: its start, relative to the node's x/y. */
  x: number
  y: number
  /** From its start to its end, canvas units. */
  dx: number
  dy: number
}

export interface StoryPoint {
  id: string
  line: string
  /** Canvas units along its line from the start. */
  t: number
  /** Stem lengths across the line, canvas units: `up` toward the title. */
  up: number
  down: number
  title: string
  /** Linked cards (group ids): they move with the point. */
  cards?: string[]
  /** Cards linked on a stem's tick end: which end each hangs from (its
   *  tether starts there). A card not listed hangs from the point. */
  hang?: Record<string, 'up' | 'down'>
  /** Older storylines: a deleted point still holding a branch. Read as a
   *  plain point (canonicalStoryline). */
  anchor?: boolean
}

export interface StorylineData {
  lines: StoryLine[]
  points: StoryPoint[]
  /** Snap to the dot grid. Absent means on. */
  snap?: boolean
  /** Its lines', ticks' and points' colour; absent, the default. */
  color?: string
  /** Line thickness, screen px (the same at every zoom); absent, the default. */
  weight?: number
  /** In the tilted view, stand up about the main line like a wall. */
  standUp?: boolean
  /** The line it stands up about (canvas units, absolute), kept from when
   *  it was flipped: moved afterwards, it moves along and up the wall. */
  wallFoot?: { x: number; y: number; ux: number; uy: number }
}

export function newStoryline(): StorylineData {
  const line = crypto.randomUUID()
  return {
    lines: [{ id: line, from: null, x: 0, y: 0, dx: 0, dy: 0 }],
    points: [{ id: crypto.randomUUID(), line, t: 0, up: 0, down: 0, title: '' }],
  }
}

export interface LineGeom {
  /** Start, relative to the node. */
  sx: number; sy: number
  /** Unit direction (along +x for a line of no length yet). */
  ux: number; uy: number
  len: number
}

export interface PointGeom {
  x: number; y: number
  /** Unit normal toward `up`: screen-up for a lying line, left for a
   *  standing one, whichever way the line was drawn. */
  nx: number; ny: number
}

export interface StoryGeom {
  lines: Record<string, LineGeom>
  points: Record<string, PointGeom>
}

export function upNormal(ux: number, uy: number): { nx: number; ny: number } {
  let nx = uy, ny = -ux
  if (ny > 1e-9 || (Math.abs(ny) <= 1e-9 && nx > 0)) { nx = -nx; ny = -ny }
  return { nx, ny }
}

/** Where every line and point is, relative to the node. A line whose `from`
 *  point is gone (or a cycle, which edits never make) is left out. */
export function storyGeom(d: StorylineData): StoryGeom {
  const lines: Record<string, LineGeom> = {}
  const points: Record<string, PointGeom> = {}
  const lineById = new Map(d.lines.map(l => [l.id, l]))
  const pointById = new Map(d.points.map(p => [p.id, p]))
  const busy = new Set<string>()
  const line = (id: string): LineGeom | null => {
    if (lines[id]) return lines[id]
    const l = lineById.get(id)
    if (!l || busy.has(id)) return null
    busy.add(id)
    let sx = l.x, sy = l.y
    if (l.from) {
      const p = point(l.from)
      if (!p) return null
      sx = p.x; sy = p.y
    }
    const len = Math.hypot(l.dx, l.dy)
    const g = { sx, sy, ux: len > 1e-9 ? l.dx / len : 1, uy: len > 1e-9 ? l.dy / len : 0, len }
    lines[id] = g
    return g
  }
  const point = (id: string): PointGeom | null => {
    if (points[id]) return points[id]
    const p = pointById.get(id)
    const g = p && line(p.line)
    if (!p || !g) return null
    const t = Math.max(0, Math.min(g.len, p.t))
    const pg = { x: g.sx + g.ux * t, y: g.sy + g.uy * t, ...upNormal(g.ux, g.uy) }
    points[id] = pg
    return pg
  }
  for (const l of d.lines) line(l.id)
  for (const p of d.points) point(p.id)
  return { lines, points }
}

/** Lines growing from point `pointId`, and from points on those, all the
 *  way down. */
export function branchesOf(d: StorylineData, pointId: string): { lines: Set<string>; points: Set<string> } {
  const lines = new Set<string>(), points = new Set<string>()
  const queue = [pointId]
  while (queue.length) {
    const pid = queue.pop()!
    for (const l of d.lines) {
      if (l.from !== pid || lines.has(l.id)) continue
      lines.add(l.id)
      for (const p of d.points) if (p.line === l.id && !points.has(p.id)) { points.add(p.id); queue.push(p.id) }
    }
  }
  return { lines, points }
}

/** The point and everything branching from it: what goes when it is
 *  deleted, whose cards move when it does. */
export function pointAndBranches(d: StorylineData, pointId: string): { lines: Set<string>; points: Set<string> } {
  const b = branchesOf(d, pointId)
  b.points.add(pointId)
  return b
}

const EPS = 1e-6

/** A plain point at `t` on `line`. */
const plainPoint = (line: string, t: number): StoryPoint => ({ id: crypto.randomUUID(), line, t, up: 0, down: 0, title: '' })

/** Points this close along one line (canvas units) are one spot. */
export const SAME_SPOT = 0.5

/** Every dot a point: older held spots read as plain points, points stacked
 *  on one spot of a line become one (their cards and titles kept, branches
 *  re-hung on it), and a point is put at each line's end (and the root's
 *  start) that has none. Returns `d` itself when nothing changes. */
export function canonicalStoryline(d: StorylineData): StorylineData {
  let points = d.points.some(p => p.anchor) ? d.points.map(p => (p.anchor ? { ...p, anchor: undefined } : p)) : d.points
  let lines = d.lines
  // Stacked points: on one spot of a line, and on a branch's very start
  // (which is the point it grows from). One keeps the spot — on a branch's
  // start, the point it grows from; else the first holding something — and
  // takes the others' cards and titles; branches from them hang on it.
  const byId = new Map(points.map(p => [p.id, p]))
  const gone = new Map<string, string>()
  const merge = (keepId: string, others: StoryPoint[]) => {
    const keep = byId.get(keepId)!
    const all = [keep, ...others]
    const cards = [...new Set(all.flatMap(p => p.cards ?? []))]
    const hang = Object.assign({}, ...all.map(p => p.hang ?? {}).reverse())
    byId.set(keepId, {
      ...keep,
      hang: Object.keys(hang).length ? hang : undefined,
      title: [...new Set(all.map(p => p.title).filter(Boolean))].join(' / '),
      up: Math.max(...all.map(p => p.up)), down: Math.max(...all.map(p => p.down)),
      ...(cards.length ? { cards } : {}),
    })
    for (const p of others) { gone.set(p.id, keepId); byId.delete(p.id) }
  }
  for (const l of d.lines) {
    const on = [...byId.values()].filter(p => p.line === l.id).sort((a, b) => a.t - b.t)
    for (let i = 0; i < on.length;) {
      let j = i + 1
      while (j < on.length && on[j].t - on[i].t < SAME_SPOT) j++
      if (j - i > 1) {
        const spot = on.slice(i, j)
        const keep = spot.find(pointHolds) ?? spot[0]
        merge(keep.id, spot.filter(p => p !== keep))
      }
      i = j
    }
  }
  const root = (id: string) => { while (gone.has(id)) id = gone.get(id)!; return id }
  for (const l of d.lines) {
    if (!l.from) continue
    const parent = root(l.from)
    const start = [...byId.values()].filter(p => p.line === l.id && p.t < SAME_SPOT && p.id !== parent)
    if (start.length && byId.has(parent)) merge(parent, start)
  }
  if (gone.size) {
    points = [...byId.values()]
    lines = lines.map(l => (l.from && gone.has(l.from) ? { ...l, from: root(l.from) } : l))
  }
  const add: StoryPoint[] = []
  for (const l of lines) {
    const len = Math.hypot(l.dx, l.dy)
    const on = points.filter(p => p.line === l.id)
    // Within a spot's width, so what is added is never itself a stack (and
    // a branch shorter than that is no line yet).
    if (!l.from && !on.some(p => p.t < SAME_SPOT)) add.push(plainPoint(l.id, 0))
    if (len >= SAME_SPOT && !on.some(p => p.t > len - SAME_SPOT)) add.push(plainPoint(l.id, len))
  }
  if (add.length) points = [...points, ...add]
  return points === d.points && lines === d.lines ? d : { ...d, points, lines }
}

/** Whether a point holds anything: a title or cards. */
export function pointHolds(p: StoryPoint): boolean {
  return !!p.title || (p.cards?.length ?? 0) > 0
}

/** Delete a point, keeping its line whole: the points either side stay on
 *  it and its linked cards are let go where they stand. One with branches
 *  growing from it stays, emptied, holding them (a plain one cannot go:
 *  Delete branch takes its branches). Deleting the point at a line's end
 *  shortens the line to the next point (on the root line, at its start
 *  too). The last point on a branch takes the branch with it; the root's
 *  last point shortens the root back to where it starts. */
export function deleteStoryPoint(d: StorylineData, pointId: string): StorylineData {
  const p = d.points.find(q => q.id === pointId)
  const l = p && d.lines.find(q => q.id === p.line)
  if (!p || !l) return d
  if (d.lines.some(q => q.from === pointId)) {
    if (!pointHolds(p)) return d
    return { ...d, points: d.points.map(q => (q.id === pointId ? { ...q, title: '', cards: undefined, hang: undefined } : q)) }
  }
  const points = d.points.filter(q => q.id !== pointId)
  const others = points.filter(q => q.line === l.id)
  if (!others.length) {
    if (l.from) return { ...d, points, lines: d.lines.filter(q => q.id !== l.id) }
    return { ...d, points, lines: d.lines.map(q => (q.id === l.id ? { ...q, dx: 0, dy: 0 } : q)) }
  }
  const len = Math.hypot(l.dx, l.dy)
  if (len < EPS) return { ...d, points }
  const ux = l.dx / len, uy = l.dy / len
  if (p.t >= len - EPS) {
    const to = Math.max(...others.map(q => q.t))
    return { ...d, points, lines: d.lines.map(q => (q.id === l.id ? { ...q, dx: ux * to, dy: uy * to } : q)) }
  }
  if (!l.from && p.t <= EPS) return trimStart({ ...d, points }, l.id, Math.min(...others.map(q => q.t)))
  return { ...d, points }
}

/** The root line `lineId` starting `k` further along: its points stay put. */
function trimStart(d: StorylineData, lineId: string, k: number): StorylineData {
  const l = d.lines.find(q => q.id === lineId)!
  const len = Math.hypot(l.dx, l.dy)
  if (len < EPS) return d
  const ux = l.dx / len, uy = l.dy / len
  return {
    ...d,
    lines: d.lines.map(q => (q.id === lineId ? { ...q, x: q.x + ux * k, y: q.y + uy * k, dx: ux * (len - k), dy: uy * (len - k) } : q)),
    points: d.points.map(q => (q.line === lineId ? { ...q, t: q.t - k } : q)),
  }
}

/** Slide point `pointId` to `t` along its line (in the line's units as it
 *  stands). A line's end point takes the end with it, and the root's start
 *  point its start: past them the line grows, back from them it shortens,
 *  never past its other points. Any other point stays between its
 *  neighbours. */
export function slideStoryPoint(d: StorylineData, pointId: string, t: number): StorylineData {
  const p = d.points.find(q => q.id === pointId)
  const l = p && d.lines.find(q => q.id === p.line)
  if (!p || !l) return d
  const len = Math.hypot(l.dx, l.dy)
  if (len < EPS) return d
  const ux = l.dx / len, uy = l.dy / len
  const others = d.points.filter(q => q.line === l.id && q.id !== pointId)
  if (!l.from && p.t <= EPS) {
    const k = Math.min(t, others.length ? Math.min(...others.map(q => q.t)) : len)
    return {
      ...d,
      lines: d.lines.map(q => (q.id === l.id ? { ...q, x: q.x + ux * k, y: q.y + uy * k, dx: ux * (len - k), dy: uy * (len - k) } : q)),
      points: d.points.map(q => (q.line === l.id && q.id !== pointId ? { ...q, t: q.t - k } : q)),
    }
  }
  if (p.t >= len - EPS) {
    const to = Math.max(t, others.length ? Math.max(...others.map(q => q.t)) : 0)
    return {
      ...d,
      lines: d.lines.map(q => (q.id === l.id ? { ...q, dx: ux * to, dy: uy * to } : q)),
      points: d.points.map(q => (q.id === pointId ? { ...q, t: to } : q)),
    }
  }
  // Between its neighbours: it can come to one (and merge into it), never
  // pass it.
  const lo = Math.max(0, ...others.filter(q => q.t <= p.t).map(q => q.t))
  const hi = Math.min(len, ...others.filter(q => q.t >= p.t).map(q => q.t))
  const at = Math.max(lo, Math.min(hi, t))
  return { ...d, points: d.points.map(q => (q.id === pointId ? { ...q, t: at } : q)) }
}

/** Delete a branch: the line, its points and everything branching from
 *  them. */
export function deleteStoryBranch(d: StorylineData, lineId: string): StorylineData {
  const line = d.lines.find(l => l.id === lineId)
  if (!line?.from) return d
  const lines = new Set<string>([lineId]), points = new Set<string>()
  for (const p of d.points) {
    if (p.line !== lineId) continue
    const b = pointAndBranches(d, p.id)
    b.lines.forEach(x => lines.add(x))
    b.points.forEach(x => points.add(x))
  }
  return { ...d, lines: d.lines.filter(l => !lines.has(l.id)), points: d.points.filter(p => !points.has(p.id)) }
}

/** Re-attach point `pointId`, with everything growing from it, at `t` on
 *  line `lineId`: it leaves its own line, which stays whole. Not onto its
 *  own line (that is a slide) or anything growing from it. */
export function reattachStoryPoint(d: StorylineData, pointId: string, lineId: string, t: number): StorylineData {
  const p = d.points.find(q => q.id === pointId)
  if (!p || p.line === lineId || branchesOf(d, pointId).lines.has(lineId)) return d
  return { ...d, points: d.points.map(q => (q.id === pointId ? { ...q, line: lineId, t } : q)) }
}

/** Let card `groupId` go from point `pointId`; it stays where it is. */
export function unlinkStoryCard(d: StorylineData, pointId: string, groupId: string): StorylineData {
  return { ...d, points: d.points.map(p => {
    if (p.id !== pointId || !p.cards) return p
    const { [groupId]: _was, ...hang } = p.hang ?? {}
    return { ...p, cards: p.cards.filter(c => c !== groupId), hang: Object.keys(hang).length ? hang : undefined }
  }) }
}

/** Nothing left to show: no point and no line of any length. */
export function storylineEmpty(d: StorylineData): boolean {
  return d.points.length === 0 && d.lines.every(l => Math.hypot(l.dx, l.dy) < EPS)
}

/** Keep the node's x/y/width/height the box round its lines and points,
 *  without moving anything on the canvas: what the box gains on the left
 *  or top, the root's start gives back. */
export function normalizeStoryline(x: number, y: number, d: StorylineData): { x: number; y: number; width: number; height: number; storyline: StorylineData } {
  const g = storyGeom(d)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const add = (px: number, py: number) => {
    x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py)
  }
  for (const l of Object.values(g.lines)) { add(l.sx, l.sy); add(l.sx + l.ux * l.len, l.sy + l.uy * l.len) }
  for (const p of Object.values(g.points)) add(p.x, p.y)
  if (x0 === Infinity) return { x, y, width: 0, height: 0, storyline: d }
  const lines = x0 === 0 && y0 === 0 ? d.lines
    : d.lines.map(l => (l.from ? l : { ...l, x: l.x - x0, y: l.y - y0 }))
  return { x: x + x0, y: y + y0, width: x1 - x0, height: y1 - y0, storyline: { ...d, lines } }
}
