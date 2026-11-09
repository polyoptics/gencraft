// A family shown as a tree on a storyline (Brian 2026-11-06): its own
// layout, not the faction's. One trunk runs straight down from the top of
// the family; the children hang on either side of it, side by side, each
// on a short level stub from the trunk, taking turns left and right going
// down. A child with children of its own gets its own small trunk the same
// way, and so on down. A partner stands beside the one they are with, the
// pair joined by a line, and their trunk drops from between them. Lines
// only ever run straight down or straight across.
//
// Like the faction tree it is a new storyline beside the card, each member
// card hung from its dot, and it bakes back into the family card (its
// chartCard), so double-clicking the family shows it or folds it in.

import { useBoardsStore } from '../store/boardsStore'
import { groupBounds } from '../store/canvasStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { familyTree } from './family'
import { linkedHeight, makeLinkedCard } from './linkedCards'
import { normalizeStoryline, type StoryDot, type StoryEdge, type StorylineData } from './storyline'

/** A card's face on the canvas (groupBounds less its docking margin). */
export function face(id: string) {
  const b = groupBounds(id)
  const g = useBoardsStore.getState().groups.find(x => x.id === id)
  // As the card is drawn: its content, or its own size when bigger.
  return b ? { x: b.x + 16, y: b.y, w: Math.max(1, b.w - 32, g?.cardWidthOverride ?? 0), h: Math.max(b.h, g?.cardHeightOverride ?? 0) } : null
}

/** One place in the tree: a member (or an unknown parent: no card), the
 *  partners beside them, and the children of them all. */
export interface Unit { card?: string; partners: string[]; kids: Unit[] }

/** A unit laid out, its own dot at 0,0: everything it holds, and the box
 *  it all takes (left, right, bottom). */
interface Laid { dots: StoryDot[]; edges: StoryEdge[]; l: number; r: number; b: number; attach: string; level: string[] }

/** Builds it; returns the storyline's node id (null: no members). */
export function showFamilyTree(familyId: string): string | null {
  const bs = useBoardsStore.getState()
  const family = bs.groups.find(g => g.id === familyId)
  if (!family) return null
  const rows = familyTree(bs.groups, family)
  const usable = (id: string, card?: { pin?: unknown }) => !!card && !card.pin && !!face(id)
  const faces = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (const r of rows) if (usable(r.id, r.card)) faces.set(r.id, face(r.id)!)
  if (!faces.size) return null
  // The rows (top down, each under its parents) as units.
  const tops: Unit[] = []
  const last: Unit[] = []
  for (const r of rows) {
    if (r.partnerOf) {
      if (faces.has(r.id)) last[r.depth]?.partners.push(r.id)
      continue
    }
    const u: Unit = { card: faces.has(r.id) ? r.id : undefined, partners: [], kids: [] }
    const up = r.depth > 0 ? last[r.depth - 1] : undefined
    if (up) up.kids.push(u)
    else tops.push(u)
    last[r.depth] = u
    last.length = r.depth + 1
  }

  return showSpine(familyId, tops, faces)
}

/** `tops` laid out as a spine on a new storyline beside card `cardId`,
 *  their cards (`faces`: as drawn) hung from its dots; bakes back into
 *  `cardId`. Returns the storyline's node id. Used for families and
 *  factions (utils/factionTree) alike. */
export function showSpine(cardId: string, tops: Unit[], faces: Map<string, { x: number; y: number; w: number; h: number }>): string | null {
  if (!faces.size) return null
  // Never the masters (Brian 2026-11-09): the tree is LINKED cards
  // (utils/linkedCards), all at one even width, the masters' middle width
  // (not the zoom's new-card size, which is huge zoomed out), each in its
  // master's shape; the masters stay exactly where they are.
  const ws = [...faces.values()].map(f => f.w).sort((a, b) => a - b)
  const cw = ws[Math.floor((ws.length - 1) / 2)]
  const sizes = new Map([...faces.keys()].map(m => [m, Math.min(cw * 2, linkedHeight(m, cw, faces.get(m)!.h) ?? cw * 1.4)]))
  const ch = Math.max(...sizes.values())
  // Gaps just wide enough that cards never touch (touching cards make a deck).
  const gapX = Math.max(cw * 0.3, 24), gapY = Math.max(ch * 0.45, 60), hang = Math.max(ch * 0.15, 44)

  // `dir`: the side its partners stand on (away from the trunk it hangs from).
  const lay = (u: Unit, dir: 1 | -1): Laid => {
    const dots: StoryDot[] = [], edges: StoryEdge[] = []
    const mk = (x: number, y: number, card?: string) => {
      const d: StoryDot = { id: crypto.randomUUID(), x, y, title: '', ...(card ? { cards: [card] } : {}) }
      dots.push(d)
      return d
    }
    const me = mk(0, 0, u.card)
    const level = [me.id]
    let l = -cw / 2, r = cw / 2, b = u.card ? hang + ch : 0
    let trunk = me, prev = me
    u.partners.forEach((q, i) => {
      const qx = dir * (i + 1) * (cw + gapX)
      if (i === 0) {
        // Their trunk drops from between them.
        const mid = mk(dir * (cw + gapX) / 2, 0)
        edges.push({ a: prev.id, b: mid.id })
        level.push(mid.id)
        prev = trunk = mid
      }
      const qd = mk(qx, 0, q)
      edges.push({ a: prev.id, b: qd.id })
      level.push(qd.id)
      prev = qd
      l = Math.min(l, qx - cw / 2); r = Math.max(r, qx + cw / 2); b = Math.max(b, hang + ch)
    })
    if (u.kids.some(k => k.card || k.partners.length || k.kids.length)) {
      const tx = trunk.x
      const first = b + gapY
      const down: Record<string, number> = { '-1': first, '1': first }
      const joins = new Map<number, StoryDot>()
      // Those without children of their own first, in pairs close under
      // their parents; then those with families, down the trunk.
      const shown = u.kids.filter(k => k.card || k.partners.length || k.kids.length)
      for (const k of [...shown.filter(k => !k.kids.length), ...shown.filter(k => k.kids.length)]) {
        // The side that reaches less far down takes the next child.
        const side: 1 | -1 = down['-1'] <= down['1'] ? -1 : 1
        const sub = lay(k, side)
        const kx = side === 1 ? tx + gapX - sub.l : tx - gapX - sub.r
        const ky = down[side]
        for (const d of sub.dots) dots.push({ ...d, x: d.x + kx, y: d.y + ky })
        edges.push(...sub.edges)
        let j = joins.get(ky)
        if (!j) { j = mk(tx, ky); joins.set(ky, j) }
        edges.push({ a: j.id, b: sub.attach })
        l = Math.min(l, kx + sub.l); r = Math.max(r, kx + sub.r); b = Math.max(b, ky + sub.b)
        down[side] = ky + sub.b + gapY
      }
      let s = trunk
      for (const y of [...joins.keys()].sort((p, q) => p - q)) {
        const j = joins.get(y)!
        edges.push({ a: s.id, b: j.id })
        s = j
      }
    }
    return { dots, edges, l, r, b, attach: me.id, level: dir === 1 ? level : [...level].reverse() }
  }

  // The tops side by side along the base line.
  const dots: StoryDot[] = [], edges: StoryEdge[] = [], base: string[] = []
  let right = -Infinity
  for (const t of tops) {
    const sub = lay(t, 1)
    const x = right === -Infinity ? 0 : right + gapX * 2 - sub.l
    for (const d of sub.dots) dots.push({ ...d, x: d.x + x })
    edges.push(...sub.edges)
    if (base.length) edges.push({ a: base[base.length - 1], b: sub.level[0] })
    base.push(...sub.level)
    right = x + sub.r
  }
  // Baked back in (utils/chartCard), it folds into this card.
  const data: StorylineData = { dots, edges, base, chartCard: cardId }

  // Beside the card, its top level with the card's top.
  const fb = face(cardId)
  const left = Math.min(...dots.map(d => d.x)) - cw / 2
  const ox = (fb ? fb.x + fb.w + cw * 0.75 : faces.values().next().value!.x) - left
  const oy = fb ? fb.y : faces.values().next().value!.y

  useUndoCoordinator.getState().checkpoint()
  // A linked card for each master on a dot, hung centred under it.
  const linkOf = new Map<string, string>()
  for (const d of dots) {
    const m = d.cards?.[0]
    if (!m) continue
    const l = makeLinkedCard(m)
    if (!l) { d.cards = undefined; continue }
    linkOf.set(m, l)
    d.cards = [l]
  }
  useBoardsStore.setState(s => ({
    groups: s.groups.map(g => {
      const m = g.linkOf && linkOf.get(g.linkOf) === g.id ? g.linkOf : null
      return m ? { ...g, cardWidthOverride: cw, cardHeightOverride: sizes.get(m), flipped: false,
        deckState: undefined, deckAnchorId: undefined, deckOffsetX: undefined, deckOffsetY: undefined, nestedDeck: undefined, deckLastFront: undefined, deckLock: undefined } : g
    }),
  }))
  const fs = useFreeNodeStore.getState()
  const id = fs.addFreeNode(0, 0, 'storyline')
  fs.updateFreeNode(id, normalizeStoryline(ox, oy, data))
  const groups = useBoardsStore.getState().groups
  useBoardsStore.getState().setGroupPosBatch(dots.flatMap(d => {
    const cid = d.cards?.[0]
    const f = cid ? face(cid) : null
    const g = cid ? groups.find(x => x.id === cid) : undefined
    if (!cid || !f || !g) return []
    const tx = ox + d.x - f.w / 2, ty = oy + d.y + hang
    return [{ groupId: cid, originX: g.originX + (tx - f.x), originY: g.originY + (ty - f.y) }]
  }))
  return id
}
