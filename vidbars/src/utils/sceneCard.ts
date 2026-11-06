// A SCENE card's face (Brian's storyMap, 2026-11-04): divisions, named and
// coloured rectangles that split the face into sections, resized by
// dragging the lines between them. Cards go into a division by letting
// their link "+" go on it; the division shows them. A division is a leaf
// of a tree of rows and columns, so dividing one never moves another's
// edges.

import { newDetailId } from './cardTypes'

export interface SceneDiv {
  id: string
  /** A division (leaf): its name, colour and the cards in it. */
  name?: string
  color?: string
  cards?: string[]
  /** The scene card this division opens into (its own scene: the scene tree). */
  opens?: string
  /** A split (container): its parts side by side ('row') or stacked
   *  ('col'), each its share of the space (sizes sum to 1). */
  dir?: 'row' | 'col'
  sizes?: number[]
  kids?: SceneDiv[]
}

/** The colours new divisions take in turn (from Brian's storyMap). */
const PALETTE = ['#5b8dd9', '#1f9ea6', '#6fa6a8', '#f2994a', '#8b6fd6', '#4fae6b']
let colorTurn = 1

const leaf = (name: string, color: string): SceneDiv => ({ id: newDetailId(), name, color, cards: [] })

/** A new scene's face: a title strip over one big section. */
export function newSceneLayout(title = 'Title', section?: { color?: string; cards?: string[] }): SceneDiv {
  const body = leaf('Section', section?.color ?? PALETTE[0])
  if (section?.cards) body.cards = [...section.cards]
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

/** Cards into a division: out of any other division of this scene first. */
export function putCards(root: SceneDiv, id: string, cardIds: string[]): SceneDiv {
  const walk = (d: SceneDiv): SceneDiv => isLeaf(d)
    ? { ...d, cards: d.id === id
        ? [...(d.cards ?? []).filter(c => !cardIds.includes(c)), ...cardIds]
        : (d.cards ?? []).filter(c => !cardIds.includes(c)) }
    : { ...d, kids: d.kids!.map(walk) }
  return walk(root)
}

export function takeCard(root: SceneDiv, id: string, cardId: string): SceneDiv {
  return edit(root, id, d => ({ ...d, cards: (d.cards ?? []).filter(c => c !== cardId) }))
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
