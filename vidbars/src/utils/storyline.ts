// ─── Storyline: dots joined by straight lines ───
//
// A storyline is dots, each at a free position, joined by straight lines —
// a tree of polylines (story branches, family trees, a faction's leader to
// its followers). Nothing else: a dot is dragged anywhere and its lines
// follow; a line is split by putting a dot on it; a new dot is grown out of
// a dot's ring (from an end that extends the line, from a middle dot it
// starts a branch); two dots let go on each other become one.
//
// Stored on its free node (FreeNodeData.storyline), RELATIVE to the node's
// x/y, which this module keeps the bounding box of the dots (normalized),
// so everything that moves or frames a node by its box (cabinet projects,
// F to frame) carries a storyline whole.
//
// Its base line (`base`) anchors it: a straight horizontal line, dots in
// order left to right, all at one height, that its dots slide along. The
// base's first dot is the storyline's start (the root): the grab handle sits
// by it, "Delete branch" reads onward from it, and everything else hangs off
// the base as branches, freeform. (Room is kept under it for a time scale.)
//
// Cards linked to a dot (`cards`, group ids) move with it when it is
// dragged. A link is made by dropping a card's link "+" on the dot (the
// target owns the reference, as everywhere else — see LinkDragOverlay).

export interface StoryDot {
  id: string
  /** Relative to the node's x/y, canvas units. */
  x: number
  y: number
  title: string
  /** Linked cards (group ids): they move with the dot. */
  cards?: string[]
}

/** A straight line between two dots. */
export interface StoryEdge { a: string; b: string }

export interface StorylineData {
  dots: StoryDot[]
  edges: StoryEdge[]
  /** Snap to the dot grid. Absent means on. */
  snap?: boolean
  /** Its lines' and dots' colour; absent, the default. */
  color?: string
  /** Line thickness, screen px (the same at every zoom); absent, the default. */
  weight?: number
  /** In the tilted view, stand up about the main line like a wall. */
  standUp?: boolean
  /** The line it stands up about (canvas units, absolute), kept from when
   *  it was flipped: moved afterwards, it moves along and up the wall. */
  wallFoot?: { x: number; y: number; ux: number; uy: number }
  /** The base line: its dots, left to right, at one height. */
  base?: string[]
  /** A chart recalled from this card (utils/chartCard): baking it again
   *  folds it back into the same card. */
  chartCard?: string
  /** Before dots: lines with points along them (migrateStoryline reads them
   *  once, and they go). */
  lines?: LegacyLine[]
  points?: LegacyPoint[]
}

interface LegacyLine { id: string; from: string | null; x: number; y: number; dx: number; dy: number }
interface LegacyPoint { id: string; line: string; t: number; up?: number; down?: number; title?: string; cards?: string[]; hang?: Record<string, 'up' | 'down'> }

export function newStoryline(): StorylineData {
  const id = crypto.randomUUID()
  return { dots: [{ id, x: 0, y: 0, title: '' }], edges: [], base: [id] }
}

export function upNormal(ux: number, uy: number): { nx: number; ny: number } {
  let nx = uy, ny = -ux
  if (ny > 1e-9 || (Math.abs(ny) <= 1e-9 && nx > 0)) { nx = -nx; ny = -ny }
  return { nx, ny }
}

/** Dots this close (canvas units) are one spot. */
const SAME_SPOT = 0.5

/** A storyline as dots and lines: as stored, or — saved before dots — its
 *  lines' points made dots, in order along each line and joined there, each
 *  branch's first dot joined to the point it grew from, a stem drawn out a
 *  dot of its own off its point (its hung cards on it), points on one spot
 *  one dot. Every card link is kept. Returns `d` itself when it has dots. */
export function migrateStoryline(d: StorylineData): StorylineData {
  if (Array.isArray(d.dots) && d.base && !d.lines && !d.points) return d
  const m = toDots(d)
  return m.base ? m : withBase(m)
}

/** A storyline without a base line given one: its main line from the start,
 *  dot to dot along the first line from each, as long as it keeps going the
 *  one way across — straightened level at the start's height, each dot kept
 *  at its x. */
function withBase(d: StorylineData): StorylineData {
  const s = d.dots[0]
  if (!s) return { ...d, base: [] }
  const path = [s.id]
  const seen = new Set(path)
  let cur = s, dir = 0
  for (;;) {
    const nid = neighbours(d, cur.id).find(n => !seen.has(n))
    const nx = nid ? d.dots.find(p => p.id === nid) : undefined
    if (!nx) break
    const sgn = Math.sign(nx.x - cur.x)
    if (!sgn || (dir && sgn !== dir)) break
    dir = sgn
    path.push(nx.id); seen.add(nx.id); cur = nx
  }
  if (dir < 0) path.reverse()
  const on = new Set(path)
  return { ...d, base: path, dots: d.dots.map(p => (on.has(p.id) ? { ...p, y: s.y } : p)) }
}

function toDots(d: StorylineData): StorylineData {
  if (Array.isArray(d.dots) && !d.lines && !d.points) return d
  if (Array.isArray(d.dots)) { const { lines: _l, points: _p, ...rest } = d; return rest }
  const lines = d.lines ?? [], points = d.points ?? []
  const byLine = new Map<string, LegacyLine>(lines.map(l => [l.id, l]))
  const at = new Map<string, { x: number; y: number; nx: number; ny: number }>()
  const geom = (l: LegacyLine, seen = new Set<string>()): { sx: number; sy: number; ux: number; uy: number; len: number } | null => {
    if (seen.has(l.id)) return null
    seen.add(l.id)
    let sx = l.x, sy = l.y
    if (l.from) {
      const p = pointAt(l.from, seen)
      if (!p) return null
      sx = p.x; sy = p.y
    }
    const len = Math.hypot(l.dx, l.dy)
    return { sx, sy, ux: len > 1e-9 ? l.dx / len : 1, uy: len > 1e-9 ? l.dy / len : 0, len }
  }
  const pointAt = (id: string, seen = new Set<string>()): { x: number; y: number; nx: number; ny: number } | null => {
    const hit = at.get(id)
    if (hit) return hit
    const p = points.find(q => q.id === id)
    const l = p && byLine.get(p.line)
    const g = l && geom(l, seen)
    if (!p || !g) return null
    const t = Math.max(0, Math.min(g.len, p.t))
    const r = { x: g.sx + g.ux * t, y: g.sy + g.uy * t, ...upNormal(g.ux, g.uy) }
    at.set(id, r)
    return r
  }
  const dots: StoryDot[] = []
  const edges: StoryEdge[] = []
  const same = new Map<string, string>()   // legacy point id → dot id
  const root = lines.find(l => !l.from)
  // Each line after the line its branch grows from, so its first dot can
  // join the dot it grew from.
  const order: LegacyLine[] = root ? [root] : []
  for (let grew = true; grew;) {
    grew = false
    for (const l of lines) {
      if (order.includes(l)) continue
      const parent = l.from ? points.find(q => q.id === l.from)?.line : undefined
      if (!l.from || !parent || order.some(o => o.id === parent)) { order.push(l); grew = true }
    }
  }
  for (const l of order) {
    const on = points.filter(p => p.line === l.id).sort((a, b) => a.t - b.t)
    let prev: string | null = l.from ? same.get(l.from) ?? null : null
    let prevT = -Infinity
    for (const p of on) {
      const pos = pointAt(p.id)
      if (!pos) continue
      if (prev && p.t - prevT < SAME_SPOT && dots.find(x => x.id === prev)) {
        // On the same spot as the one before: one dot, holding both.
        const dot = dots.find(x => x.id === prev)!
        dot.cards = [...new Set([...(dot.cards ?? []), ...(p.cards ?? [])])]
        if (!dot.cards.length) delete dot.cards
        dot.title = [dot.title, p.title].filter(Boolean).join(' / ')
        same.set(p.id, prev)
        continue
      }
      const drawn = (side: 'up' | 'down') => (p[side] ?? 0) >= SAME_SPOT
      const hung = (side: 'up' | 'down') => (p.cards ?? []).filter(c => p.hang?.[c] === side)
      const own = (p.cards ?? []).filter(c => !p.hang?.[c] || !drawn(p.hang[c]))
      dots.push({ id: p.id, x: pos.x, y: pos.y, title: p.title ?? '', ...(own.length ? { cards: own } : {}) })
      same.set(p.id, p.id)
      if (prev) edges.push({ a: prev, b: p.id })
      for (const side of ['up', 'down'] as const) {
        const len = p[side] ?? 0
        if (!drawn(side)) continue
        const k = side === 'up' ? 1 : -1
        const id = crypto.randomUUID()
        const cards = hung(side)
        dots.push({ id, x: pos.x + pos.nx * len * k, y: pos.y + pos.ny * len * k, title: '', ...(cards.length ? { cards } : {}) })
        edges.push({ a: p.id, b: id })
      }
      prev = p.id
      prevT = p.t
    }
  }
  if (!dots.length) dots.push({ id: crypto.randomUUID(), x: root?.x ?? 0, y: root?.y ?? 0, title: '' })
  const { lines: _l, points: _p, ...rest } = d
  return { ...rest, dots, edges }
}

/** The dots joined to `id`. */
export function neighbours(d: StorylineData, id: string): string[] {
  const out: string[] = []
  for (const e of d.edges) {
    if (e.a === id) out.push(e.b)
    else if (e.b === id) out.push(e.a)
  }
  return out
}

/** The start: the base line's first dot. */
export function rootOf(d: StorylineData): string | undefined {
  return d.base?.[0] ?? d.dots[0]?.id
}

/** What moves with dot `id` when it is dragged: it and every dot further
 *  from the base that is reached only through it (with loops, only those
 *  whose every way back to the base passes it). A base dot brings its
 *  branches, not the rest of the base. */
export function downstream(d: StorylineData, id: string): Set<string> {
  const from = (d.base?.length ? d.base : [rootOf(d) ?? '']).filter(x => x && x !== id)
  const seen = new Set<string>(from)
  const queue = [...from]
  while (queue.length) {
    const cur = queue.pop()!
    for (const n of neighbours(d, cur)) if (n !== id && !seen.has(n)) { seen.add(n); queue.push(n) }
  }
  return new Set(d.dots.map(p => p.id).filter(x => !seen.has(x)))
}

/** Dots that can be reached from the start without passing `cut`. */
function reached(d: StorylineData, cut?: string): Set<string> {
  const start = rootOf(d)
  const seen = new Set<string>()
  if (!start || start === cut) return seen
  const queue = [start]
  seen.add(start)
  while (queue.length) {
    const id = queue.pop()!
    for (const n of neighbours(d, id)) if (n !== cut && !seen.has(n)) { seen.add(n); queue.push(n) }
  }
  return seen
}

/** The neighbour of `id` on the way back to the start (its "before"). */
function before(d: StorylineData, id: string): string | null {
  const start = rootOf(d)
  if (!start || start === id) return null
  const prev = new Map<string, string>([[start, start]])
  const queue = [start]
  while (queue.length) {
    const cur = queue.shift()!
    for (const n of neighbours(d, cur)) {
      if (prev.has(n)) continue
      prev.set(n, cur)
      if (n === id) return cur
      queue.push(n)
    }
  }
  return null
}

/** A line split at a new dot (x, y) between dots `a` and `b`. */
export function insertDot(d: StorylineData, a: string, b: string, x: number, y: number): { d: StorylineData; id: string } {
  const id = crypto.randomUUID()
  const edges = d.edges.filter(e => !((e.a === a && e.b === b) || (e.a === b && e.b === a)))
  // On the base line: a base dot, level with it, in its place along it.
  const base = d.base ?? []
  const ia = base.indexOf(a), ib = base.indexOf(b)
  const onBase = ia >= 0 && ib >= 0 && Math.abs(ia - ib) === 1
  const at = Math.max(ia, ib)
  const by = onBase ? d.dots.find(p => p.id === a)?.y ?? y : y
  return { id, d: {
    ...d, dots: [...d.dots, { id, x, y: by, title: '' }], edges: [...edges, { a, b: id }, { a: id, b }],
    ...(onBase ? { base: [...base.slice(0, at), id, ...base.slice(at)] } : {}),
  } }
}

/** Whether the line a–b is a stretch of the base. */
export function isBaseEdge(d: StorylineData, a: string, b: string): boolean {
  const base = d.base ?? []
  const ia = base.indexOf(a), ib = base.indexOf(b)
  return ia >= 0 && ib >= 0 && Math.abs(ia - ib) === 1
}

/** A new dot at (x, y) joined to dot `from`: a branch. From a storyline's
 *  one dot, its first line: the base. */
export function growDot(d: StorylineData, from: string, x: number, y: number): { d: StorylineData; id: string } {
  const id = crypto.randomUUID()
  const first = d.base?.length === 1 && d.base[0] === from
  const fy = first ? d.dots.find(p => p.id === from)?.y ?? y : y
  return { id, d: {
    ...d, dots: [...d.dots, { id, x, y: fy, title: '' }], edges: [...d.edges, { a: from, b: id }],
    ...(first ? { base: [from, id] } : {}),
  } }
}

/** The base kept in order left to right (a two-dot base may swap ends). */
export function sortBase(d: StorylineData): StorylineData {
  if (!d.base || d.base.length < 2) return d
  const x = new Map(d.dots.map(p => [p.id, p.x]))
  const base = [...d.base].sort((a, b) => (x.get(a) ?? 0) - (x.get(b) ?? 0))
  return base.every((id, i) => id === d.base![i]) ? d : { ...d, base }
}

/** Delete a dot, its lines closing up: between two lines they join
 *  directly; an end just goes; where three or more meet, the others join
 *  the dot before it (on the way back to the start). Its linked cards are
 *  let go where they stand. */
export function deleteDot(d: StorylineData, id: string): StorylineData {
  const ns = neighbours(d, id)
  const edges = d.edges.filter(e => e.a !== id && e.b !== id)
  const add: StoryEdge[] = []
  const base = d.base ?? []
  const i = base.indexOf(id)
  if (i >= 0) {
    // On the base: the base closes up, and its branches join the base dot
    // before it (after it, for the first).
    const prev = base[i - 1], next = base[i + 1]
    const hub = prev ?? next
    if (prev && next) add.push({ a: prev, b: next })
    for (const n of ns) if (n !== prev && n !== next && hub) add.push({ a: hub, b: n })
    const dots = d.dots.filter(x => x.id !== id)
    const left = base.filter(x => x !== id)
    return { ...d, dots, edges: dedupe([...edges, ...add]), base: left.length || !dots.length ? left : [dots[0].id] }
  }
  if (ns.length === 2) add.push({ a: ns[0], b: ns[1] })
  else if (ns.length > 2) {
    const hub = before(d, id) ?? ns[0]
    for (const n of ns) if (n !== hub) add.push({ a: hub, b: n })
  }
  const dots = d.dots.filter(x => x.id !== id)
  return { ...d, dots, edges: dedupe([...edges, ...add]) }
}

/** Delete the branch from dot `id` onward: it and everything that hangs off
 *  it, away from the start. From the start, the whole storyline. */
export function deleteBranchFrom(d: StorylineData, id: string): StorylineData {
  const keep = reached(d, id)
  return { ...d, dots: d.dots.filter(x => keep.has(x.id)), edges: d.edges.filter(e => keep.has(e.a) && keep.has(e.b)),
           ...(d.base ? { base: d.base.filter(x => keep.has(x)) } : {}) }
}

/** Dot `from` let go on dot `into`: one dot, at `into`, holding both's
 *  cards and titles, with both's lines. */
export function mergeDots(d: StorylineData, from: string, into: string): StorylineData {
  if (from === into) return d
  const a = d.dots.find(x => x.id === from), b = d.dots.find(x => x.id === into)
  if (!a || !b) return d
  const cards = [...new Set([...(b.cards ?? []), ...(a.cards ?? [])])]
  const title = [...new Set([b.title, a.title].filter(Boolean))].join(' / ')
  // A base dot let go on a dot off the base: that one takes its place on it.
  const base = d.base ?? []
  const swap = base.includes(from) && !base.includes(into)
  const dots = d.dots.filter(x => x.id !== from).map(x => (x.id === into ? { ...x, title, ...(swap ? { y: a.y } : {}), ...(cards.length ? { cards } : {}) } : x))
  const edges = d.edges.map(e => ({ a: e.a === from ? into : e.a, b: e.b === from ? into : e.b })).filter(e => e.a !== e.b)
  return { ...d, dots, edges: dedupe(edges),
           ...(d.base ? { base: swap ? base.map(x => (x === from ? into : x)) : base.filter(x => x !== from) } : {}) }
}

function dedupe(edges: StoryEdge[]): StoryEdge[] {
  const seen = new Set<string>()
  return edges.filter(e => {
    const k = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Let card `groupId` go from dot `dotId`; it stays where it is. */
export function unlinkStoryCard(d: StorylineData, dotId: string, groupId: string): StorylineData {
  return { ...d, dots: d.dots.map(x => {
    if (x.id !== dotId || !x.cards) return x
    const cards = x.cards.filter(c => c !== groupId)
    return { ...x, cards: cards.length ? cards : undefined }
  }) }
}

/** Nothing left to show. */
export function storylineEmpty(d: StorylineData): boolean {
  return d.dots.length === 0
}

/** The main line's way: along the base (+x); without one, from the start
 *  to the first dot joined to it. */
export function mainWay(d: StorylineData): { ux: number; uy: number } {
  if (d.base?.length) return { ux: 1, uy: 0 }
  const s = d.dots[0]
  const n = s && neighbours(d, s.id).map(id => d.dots.find(x => x.id === id)).find(Boolean)
  const len = s && n ? Math.hypot(n.x - s.x, n.y - s.y) : 0
  return s && n && len > 1e-6 ? { ux: (n.x - s.x) / len, uy: (n.y - s.y) / len } : { ux: 1, uy: 0 }
}

/** Keep the node's x/y/width/height the box round its dots, without moving
 *  anything on the canvas: what the box gains on the left or top, the dots
 *  give back. */
export function normalizeStoryline(x: number, y: number, d: StorylineData): { x: number; y: number; width: number; height: number; storyline: StorylineData } {
  if (!d.dots.length) return { x, y, width: 0, height: 0, storyline: d }
  const x0 = Math.min(...d.dots.map(p => p.x)), y0 = Math.min(...d.dots.map(p => p.y))
  const x1 = Math.max(...d.dots.map(p => p.x)), y1 = Math.max(...d.dots.map(p => p.y))
  const dots = x0 === 0 && y0 === 0 ? d.dots : d.dots.map(p => ({ ...p, x: p.x - x0, y: p.y - y0 }))
  return { x: x + x0, y: y + y0, width: x1 - x0, height: y1 - y0, storyline: { ...d, dots } }
}
