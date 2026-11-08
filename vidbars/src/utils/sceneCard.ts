// A SCENE card's face (Brian's storyMap, 2026-11-04): divisions, named and
// coloured rectangles that split the face into sections, resized by
// dragging the lines between them. A division is a leaf of a tree of rows
// and columns, so dividing one never moves another's edges.
//
// The media sheet (Brian 2026-11-07): each division has a card's face of
// its own: a header (its name), text (its notes) and a picture. A card let
// go on it COPIES its header, text and picture in; from then on the
// division's face is free to edit (text, its size, the picture's crop) and
// never touches that card, which it only links back to (`card`). Content
// vs look: if the card's content changes later, the division shows a small
// mark; refreshing takes the new content and keeps its own look and crop.
// More cards let go at once split it side by side, one each.

import { newDetailId } from './cardTypes'
import type { TextStyle } from '../store/freeNodeStore'

export interface SceneDiv {
  id: string
  /** A division (leaf): its header, colour, and the card its face came
   *  from (a link back, nothing more). */
  name?: string
  color?: string
  card?: string
  /** Before 2026-11-07 a division held a list; the first is its card. */
  cards?: string[]
  /** Its text (the card's paragraph text, when one was let go on it). */
  notes?: string
  /** Its picture, and where it sits: x/y the point shown in the middle
   *  (0..100 %), z the zoom past filling the box. */
  image?: string
  crop?: { x: number; y: number; z: number }
  /** Its look: header and text size (x the size it would have). */
  hs?: number
  ts?: number
  /** It has a card face of its own (a card was let go on it, or its text
   *  was written): drawn and edited as a card's face is (GroupCardText),
   *  with these styles, split and picture settings. Without one it shows
   *  just its name, in the middle. */
  face?: boolean
  hstyle?: Partial<TextStyle>
  bstyle?: Partial<TextStyle>
  split?: number
  hero?: { flipH?: boolean; flipV?: boolean; opacity?: number }
  /** The card's content when it was copied in (its header, text, picture):
   *  differs from the card's now = the card changed since. */
  copied?: string
  /** Its label: in the middle (on unless false) and/or a small tab on its
   *  top-right edge. Separate on/off switches. */
  mid?: boolean
  tab?: boolean
  /** Stands taller than its slot, over the row above (a bump-out). */
  bump?: boolean
  /** The scene card this division opens into (its own scene: the scene tree). */
  opens?: string
  /** A split (container): its parts side by side ('row') or stacked
   *  ('col'), each its share of the space (sizes sum to 1). */
  dir?: 'row' | 'col'
  /** A section folded to its heading: one strip (Brian 2026-11-08). */
  fold?: boolean
  sizes?: number[]
  kids?: SceneDiv[]
}

/** A scene card's view modes (Brian 2026-11-07), each its own switch.
 *  Focus: picked divisions (and their sections) lit, the rest faded.
 *  Bump-outs: divisions marked bump stand taller (on unless false).
 *  Trace: only divisions whose card or text matches stay lit. */
export interface SceneView {
  focus?: boolean
  picked?: string[]
  bumps?: boolean
  trace?: boolean
  traceText?: string
}

/** The colours new divisions take in turn (from Brian's storyMap). */
const PALETTE = ['#5b8dd9', '#1f9ea6', '#6fa6a8', '#f2994a', '#8b6fd6', '#4fae6b']
let colorTurn = 1

export const leaf = (name: string, color: string, more?: Partial<SceneDiv>): SceneDiv => ({ id: newDetailId(), name, color, ...more })

/** The card a division holds. */
export const heldCard = (d: SceneDiv): string | undefined => d.card ?? d.cards?.[0]

/** A new scene's face: a title strip over one big section. */
export function newSceneLayout(title = 'Title', section?: { color?: string; card?: string }): SceneDiv {
  const body = leaf('Section', section?.color ?? PALETTE[0], section?.card ? { card: section.card } : undefined)
  return { id: newDetailId(), dir: 'col', sizes: [0.13, 0.87], kids: [leaf(title, '#87a7e0'), body] }
}

export function findDiv(root: SceneDiv, id: string): SceneDiv | null {
  if (root.id === id) return root
  for (const k of root.kids ?? []) { const f = findDiv(k, id); if (f) return f }
  return null
}

export const isLeaf = (d: SceneDiv) => !d.kids || d.kids.length === 0

export function leaves(d: SceneDiv): SceneDiv[] {
  return isLeaf(d) ? [d] : d.kids!.flatMap(leaves)
}

/** Copy `root` with `fn` applied to the node `id` (returning its
 *  replacement, or null to drop it). Splits left with one part fold into it. */
function edit(root: SceneDiv, id: string, fn: (d: SceneDiv) => SceneDiv | null): SceneDiv {
  const walk = (d: SceneDiv): SceneDiv | null => {
    if (d.id === id) return fn(d)
    if (isLeaf(d)) return d
    const kids: SceneDiv[] = [], sizes: number[] = []
    let freed = 0
    d.kids!.forEach((k, i) => {
      const n = walk(k)
      const sz = d.sizes?.[i] ?? 1 / d.kids!.length
      if (n) { kids.push(n); sizes.push(sz + freed); freed = 0 }
      else if (sizes.length) sizes[sizes.length - 1] += sz
      else freed += sz
    })
    if (kids.length === 0) return null
    if (kids.length === 1) return { ...kids[0], id: kids[0].id }
    return { ...d, kids, sizes: normal(sizes) }
  }
  return walk(root) ?? root
}

const normal = (s: number[]) => { const t = s.reduce((a, b) => a + b, 0) || 1; return s.map(x => x / t) }

/** Divide a division in two: side by side ('row') or one above the other
 *  ('col'). The new half comes after it, in the next colour. */
export function splitDiv(root: SceneDiv, id: string, dir: 'row' | 'col'): SceneDiv {
  const color = PALETTE[colorTurn++ % PALETTE.length]
  const fresh = leaf('Section', color)
  // Inside a split the same way: a new part next to it, halving its share.
  const parent = findParent(root, id)
  if (parent && parent.dir === dir) {
    return edit(root, parent.id, p => {
      const i = p.kids!.findIndex(k => k.id === id)
      const kids = [...p.kids!], sizes = [...(p.sizes ?? p.kids!.map(() => 1 / p.kids!.length))]
      const half = sizes[i] / 2
      sizes.splice(i, 1, half, half)
      kids.splice(i + 1, 0, fresh)
      return { ...p, kids, sizes }
    })
  }
  return edit(root, id, d => ({ id: newDetailId(), dir, sizes: [0.5, 0.5], kids: [d, fresh] }))
}

/** Take a division away; its neighbour takes its space. The last one stays. */
export function removeDiv(root: SceneDiv, id: string): SceneDiv {
  if (leaves(root).length <= 1) return root
  return edit(root, id, () => null)
}

export function patchDiv(root: SceneDiv, id: string, patch: Partial<SceneDiv>): SceneDiv {
  return edit(root, id, d => ({ ...d, ...patch }))
}

/** The line between part i and i+1 of a split, moved: their shares. */
export function resizeSplit(root: SceneDiv, id: string, i: number, a: number, b: number): SceneDiv {
  return edit(root, id, d => {
    const sizes = [...(d.sizes ?? [])]
    sizes[i] = a; sizes[i + 1] = b
    return { ...d, sizes }
  })
}

/** Cards into a division: the first is the card it holds (the one it held
 *  goes); each other one gets a division of its own beside it. Out of any
 *  other division of this scene first. */
export function putCards(root: SceneDiv, id: string, cardIds: string[], content?: (cardId: string) => Partial<SceneDiv>): SceneDiv {
  if (!cardIds.length) return root
  const clear = (d: SceneDiv): SceneDiv => isLeaf(d)
    ? (heldCard(d) && cardIds.includes(heldCard(d)!) && d.id !== id ? { ...d, card: undefined, cards: undefined } : d)
    : { ...d, kids: d.kids!.map(clear) }
  const fill = (c: string): Partial<SceneDiv> => ({ card: c, cards: undefined, crop: undefined, ...(content?.(c) ?? {}) })
  let next = patchDiv(clear(root), id, fill(cardIds[0]))
  let at = id
  for (const c of cardIds.slice(1)) {
    next = splitDiv(next, at, 'row')
    const parent = findParent(next, at)!
    const i = parent.kids!.findIndex(k => k.id === at)
    at = parent.kids![i + 1].id
    next = patchDiv(next, at, { name: '', ...fill(c) })
  }
  return next
}

export function takeCard(root: SceneDiv, id: string): SceneDiv {
  return edit(root, id, d => ({ ...d, card: undefined, cards: undefined, copied: undefined }))
}

export function findParent(root: SceneDiv, id: string): SceneDiv | null {
  if (isLeaf(root)) return null
  for (const k of root.kids!) {
    if (k.id === id) return root
    const p = findParent(k, id)
    if (p) return p
  }
  return null
}

/** The divisions lit by a pick (Focus / Trace): a division picked; a
 *  section's first division (its heading) picked lights the whole section;
 *  every division lit lights the headings of the sections it is in (the
 *  path to it). Null: nothing picked, all lit. */
export function litDivisions(root: SceneDiv, picked: string[]): Set<string> | null {
  if (!picked.length) return null
  const lit = new Set<string>()
  const walk = (d: SceneDiv, heads: string[]) => {
    if (isLeaf(d)) {
      if (picked.includes(d.id)) { lit.add(d.id); heads.forEach(h => lit.add(h)) }
      return
    }
    const head = d.dir === 'col' && isLeaf(d.kids![0]) ? d.kids![0].id : null
    if (head && picked.includes(head)) leaves(d).forEach(l => lit.add(l.id))
    d.kids!.forEach(k => walk(k, head && k.id !== head ? [...heads, head] : heads))
  }
  walk(root, [])
  return lit
}

/** How thick a folded section's strip is (layout units). */
export const FOLD_STRIP = 9

/** A section that can fold: a column of parts whose first is a division
 *  (its heading). */
export const canFold = (d: SceneDiv): boolean => !isLeaf(d) && d.dir === 'col' && d.kids!.length > 1 && isLeaf(d.kids![0])

/** The section a division heads, if it is one's heading. */
export function sectionOf(root: SceneDiv, leafId: string): SceneDiv | null {
  const p = findParent(root, leafId)
  return p && canFold(p) && p.kids![0].id === leafId ? p : null
}

/** A split's room for its parts that are not folded, and their shares:
 *  what one share is worth in layout units (for dragging a seam). */
export function shareUnits(d: SceneDiv, box: { w: number; h: number }, gap: number): number {
  const n = d.kids!.length
  const sizes = d.sizes ?? d.kids!.map(() => 1 / n)
  const room = (d.dir === 'row' ? box.w : box.h) - gap * (n - 1)
  let fixed = 0, share = 0
  d.kids!.forEach((k, i) => { if (k.fold && canFold(k)) fixed += FOLD_STRIP; else share += sizes[i] })
  return Math.max(0, room - fixed) / (share || 1)
}

/** Below this room (layout units) a part is too small to read: the
 *  section holding it tucks in to its heading. */
export const TUCK_W = 14, TUCK_H = 8

/** Each division's box, in the face's layout units, for a face of w x h.
 *  A folded section takes a strip (its heading only; its other parts get
 *  no box); the parts beside it share the rest. A section with no room for
 *  its parts tucks in: its heading fills it (added to `tucked`). Inner
 *  sections tuck first, so a shrinking face steps down a level at a time. */
export function divBoxes(root: SceneDiv, w: number, h: number, gap: number, tucked?: Set<string>): Map<string, { x: number; y: number; w: number; h: number }> {
  type B = { x: number; y: number; w: number; h: number }
  const out = new Map<string, B>()
  const walk = (d: SceneDiv, x: number, y: number, bw: number, bh: number, into: Map<string, B>) => {
    into.set(d.id, { x, y, w: bw, h: bh })
    if (isLeaf(d)) return
    if (d.fold && canFold(d)) {
      // Folded: the heading fills it (the whole face folded: a strip on top).
      walk(d.kids![0], x, y, bw, d === root ? Math.min(bh, FOLD_STRIP * 1.6) : bh, into)
      return
    }
    const n = d.kids!.length
    const sizes = d.sizes ?? d.kids!.map(() => 1 / n)
    const row = d.dir === 'row'
    const unit = shareUnits(d, { w: bw, h: bh }, gap)
    const lay = (to: Map<string, B>) => {
      let at = 0
      d.kids!.forEach((k, i) => {
        const len = k.fold && canFold(k) ? FOLD_STRIP : Math.max(0, unit * sizes[i])
        if (row) walk(k, x + at, y, len, bh, to)
        else walk(k, x, y + at, bw, len, to)
        at += len + gap
      })
    }
    if (!canFold(d)) { lay(into); return }
    const tmp = new Map<string, B>()
    lay(tmp)
    const head = d.kids![0].id
    let tight = false
    tmp.forEach((b, id) => {
      if (id === head) return
      const k = findDiv(d, id)
      if (!k || !isLeaf(k)) return
      // A heading is a thin strip by nature: only its width counts.
      const sec = sectionOf(d, id)
      if (sec?.fold) return  // folded on purpose: a strip is what it asked for
      const isHead = !!sec
      if (b.w < TUCK_W || b.h < (isHead ? 3 : TUCK_H)) tight = true
    })
    if (tight) {
      tucked?.add(d.id)
      walk(d.kids![0], x, y, bw, bh, into)
      return
    }
    tmp.forEach((b, id) => into.set(id, b))
  }
  walk(root, 0, 0, w, h, out)
  return out
}
