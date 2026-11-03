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
  /** Deleted, but branches still grow from it: not drawn, only holding
   *  their place on the line (deleteStoryPoint). Clicking there on the line
   *  makes it a point again. */
  anchor?: boolean
}

export interface StorylineData {
  lines: StoryLine[]
  points: StoryPoint[]
  /** Snap to the dot grid. Absent means on. */
  snap?: boolean
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

/** Delete a point, keeping its line whole: the points either side stay on
 *  it, its linked cards are let go where they stand, and branches growing
 *  from it stay where they are on the line (it becomes an anchor). Deleting
 *  the point at a line's end shortens the line to the next point (on the
 *  root line, at its start too). Nothing else goes. */
export function deleteStoryPoint(d: StorylineData, pointId: string): StorylineData {
  const p = d.points.find(q => q.id === pointId)
  const l = p && d.lines.find(q => q.id === p.line)
  if (!p || !l) return d
  if (d.lines.some(q => q.from === pointId)) {
    return { ...d, points: d.points.map(q => (q.id === pointId ? { id: q.id, line: q.line, t: q.t, up: 0, down: 0, title: '', anchor: true } : q)) }
  }
  const points = d.points.filter(q => q.id !== pointId)
  const others = points.filter(q => q.line === l.id)
  const len = Math.hypot(l.dx, l.dy)
  if (!others.length || len < EPS) return { ...d, points }
  const ux = l.dx / len, uy = l.dy / len
  if (p.t >= len - EPS) {
    const to = Math.max(...others.map(q => q.t))
    return { ...d, points, lines: d.lines.map(q => (q.id === l.id ? { ...q, dx: ux * to, dy: uy * to } : q)) }
  }
  if (!l.from && p.t <= EPS) {
    const k = Math.min(...others.map(q => q.t))
    return {
      ...d,
      lines: d.lines.map(q => (q.id === l.id ? { ...q, x: q.x + ux * k, y: q.y + uy * k, dx: ux * (len - k), dy: uy * (len - k) } : q)),
      points: points.map(q => (q.line === l.id ? { ...q, t: q.t - k } : q)),
    }
  }
  return { ...d, points }
}

/** Delete a branch: the line, its points and everything branching from
 *  them. An anchor left holding nothing goes too. */
export function deleteStoryBranch(d: StorylineData, lineId: string): StorylineData {
  const line = d.lines.find(l => l.id === lineId)
  if (!line?.from) return d
  const lines = new Set([lineId]), points = new Set<string>()
  for (const p of d.points) {
    if (p.line !== lineId) continue
    const b = pointAndBranches(d, p.id)
    b.lines.forEach(x => lines.add(x))
    b.points.forEach(x => points.add(x))
  }
  const left = d.lines.filter(l => !lines.has(l.id))
  const from = d.points.find(p => p.id === line.from)
  if (from?.anchor && !left.some(l => l.from === from.id)) points.add(from.id)
  return { ...d, lines: left, points: d.points.filter(p => !points.has(p.id)) }
}

/** Let card `groupId` go from point `pointId`; it stays where it is. */
export function unlinkStoryCard(d: StorylineData, pointId: string, groupId: string): StorylineData {
  return { ...d, points: d.points.map(p => (p.id === pointId && p.cards ? { ...p, cards: p.cards.filter(c => c !== groupId) } : p)) }
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
