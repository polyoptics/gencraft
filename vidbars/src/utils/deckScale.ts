// deckScale.ts — a closed deck scaled from its corner (Brian 2026-11-23:
// "can I scale a deck, and that would, in turn, resize all of everything
// proportionally, including when we open up the deck, the cards would
// still all meet each other's physical borders and be able to close
// again?"). A closed deck is one card, so it has a card's corner; pulled,
// every card in it, at every depth (a deck of decks), takes the same
// factor, keeping its shape.
//
// Cards scale, the gaps between them do not: where its cards lie when the
// deck opens is worked out again, each lot of cards that open together
// about the card they open from, with the room cards take stretched by the
// factor and the room between them left as it is. So opened, every card
// meets the ones it met before, and the deck closes again.
//
// No card goes below what it holds (a card is never smaller than its
// blocks), so the whole deck stops at the factor its tightest card allows.
// Text on a face is not touched: it is sized on the screen, not by its
// card, exactly as when one card is resized.

import type { ProjectGroup } from '../store/boardsStore'

/** A card's face as it stands: where its top-left lies from its own origin,
 *  its size, and the size of what it holds (its floor). Canvas units. */
export interface FaceBox { dx: number; dy: number; w: number; h: number; minW: number; minH: number }

export interface DeckScaleStart {
  front: string
  /** Every card of the deck, the front card included, as it was. */
  cards: Map<string, ProjectGroup>
  boxes: Map<string, FaceBox>
  /** The factors it may take. */
  min: number
  max: number
}

const shut = (g: ProjectGroup) => !!g.deckState && g.deckState !== 'open'

/** The closed deck `frontId` fronts, ready to scale (null: not one). `box`
 *  gives a card's face (null: it has none). */
export function deckScaleStart(frontId: string, groups: ProjectGroup[], box: (g: ProjectGroup) => FaceBox | null): DeckScaleStart | null {
  const front = groups.find(g => g.id === frontId)
  if (!front) return null
  const cards = new Map<string, ProjectGroup>([[front.id, front]])
  for (let grew = true; grew;) {
    grew = false
    for (const g of groups) {
      if (cards.has(g.id) || g.pin || !shut(g) || !g.deckAnchorId || g.deckAnchorId === g.id || !cards.has(g.deckAnchorId)) continue
      cards.set(g.id, g)
      grew = true
    }
  }
  if (cards.size < 2) return null
  const boxes = new Map<string, FaceBox>()
  let min = 0.05
  for (const g of cards.values()) {
    const b = box(g)
    if (!b || b.w <= 0 || b.h <= 0) continue
    boxes.set(g.id, b)
    min = Math.max(min, b.minW / b.w, b.minH / b.h)
  }
  if (!boxes.has(front.id)) return null
  return { front: front.id, cards, boxes, min: Math.min(1, min), max: 8 }
}

/** Where `x` goes when the room the spans `spans` take is stretched by `k`
 *  and the room between them is kept, the point `from` staying put. */
function stretch(spans: [number, number][], k: number, from: number): (x: number) => number {
  const merged: [number, number][] = []
  for (const s of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1]
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1])
    else merged.push([s[0], s[1]])
  }
  const covered = (a: number, b: number) => merged.reduce((n, [l, r]) => n + Math.max(0, Math.min(b, r) - Math.max(a, l)), 0)
  return x => {
    const a = Math.min(from, x), b = Math.max(from, x)
    const c = covered(a, b)
    const len = (b - a - c) + c * k
    return x >= from ? from + len : from - len
  }
}

/** The deck at factor `k` of how it started: the cards that change. */
export function deckScaled(st: DeckScaleStart, k0: number): Map<string, ProjectGroup> {
  const k = Math.max(st.min, Math.min(st.max, k0))
  const out = new Map<string, ProjectGroup>()
  const kids = new Map<string, ProjectGroup[]>()
  for (const g of st.cards.values()) {
    if (g.id === st.front) continue
    const list = kids.get(g.deckAnchorId!)
    if (list) list.push(g); else kids.set(g.deckAnchorId!, [g])
  }
  // How far each card's place has moved, its own move and its front's.
  const moved = new Map<string, { x: number; y: number }>([[st.front, { x: 0, y: 0 }]])
  const queue = [st.front]
  const size = (g: ProjectGroup): Partial<ProjectGroup> => {
    const b = st.boxes.get(g.id)
    return b ? { cardWidthOverride: b.w * k, cardHeightOverride: b.h * k } : {}
  }
  while (queue.length) {
    const a = st.cards.get(queue.shift()!)!
    const am = moved.get(a.id)!
    const ab = st.boxes.get(a.id)
    const mine = kids.get(a.id) ?? []
    const off = (g: ProjectGroup) => ({ x: g.deckOffsetX ?? g.originX - a.originX, y: g.deckOffsetY ?? g.originY - a.originY })
    // The cards that open together: those with the same count of decks to
    // open before them (ProjectGroup.deckInside), each lot about this card.
    const lots = new Map<number, ProjectGroup[]>()
    for (const g of mine) {
      const n = g.deckInside ?? 0
      const l = lots.get(n)
      if (l) l.push(g); else lots.set(n, [g])
    }
    const maps = new Map<number, { fx: (x: number) => number; fy: (y: number) => number }>()
    for (const [n, lot] of lots) {
      const xs: [number, number][] = [], ys: [number, number][] = []
      if (ab) { xs.push([ab.dx, ab.dx + ab.w]); ys.push([ab.dy, ab.dy + ab.h]) }
      for (const g of lot) {
        const b = st.boxes.get(g.id)
        if (!b) continue
        const o = off(g)
        xs.push([o.x + b.dx, o.x + b.dx + b.w])
        ys.push([o.y + b.dy, o.y + b.dy + b.h])
      }
      maps.set(n, { fx: stretch(xs, k, ab ? ab.dx : 0), fy: stretch(ys, k, ab ? ab.dy : 0) })
    }
    for (const g of mine) {
      const b = st.boxes.get(g.id)
      const o = off(g)
      const m = maps.get(g.deckInside ?? 0)!
      const nx = b ? m.fx(o.x + b.dx) - b.dx : o.x
      const ny = b ? m.fy(o.y + b.dy) - b.dy : o.y
      const d = { x: am.x + nx - o.x, y: am.y + ny - o.y }
      moved.set(g.id, d)
      out.set(g.id, { ...g, ...size(g), deckOffsetX: nx, deckOffsetY: ny, originX: g.originX + d.x, originY: g.originY + d.y })
      queue.push(g.id)
    }
    // Its own size, and the places kept for cards taken out of it: they
    // lie with the cards that open first.
    const slotMap = maps.get(0)
    const slots = a.ghostSlots?.length && slotMap && ab
      ? a.ghostSlots.map(sl => ({ ...sl, deckOffsetX: slotMap.fx(sl.deckOffsetX + ab.dx) - ab.dx, deckOffsetY: slotMap.fy(sl.deckOffsetY + ab.dy) - ab.dy }))
      : undefined
    const base = out.get(a.id) ?? a
    out.set(a.id, { ...base, ...size(a), ...(slots ? { ghostSlots: slots } : {}) })
  }
  return out
}
