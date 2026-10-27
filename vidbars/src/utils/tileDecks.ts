// tileDecks.ts — collapsing touching canvas tiles into a deck, and back.
//
// The tile counterpart of card decks (boardsStore.setDeckState). Touching
// is DERIVED — the same rectsTouch + DOCK_TOLERANCE that effect strips and
// Viewer docking use, so "touching" means one thing everywhere. Only the
// collapsed state is STORED (FreeNodeData.tileDeck), on every member, the
// face included: a hidden member is no longer geometry, so where it goes
// back to cannot be re-derived.
//
// One level only: collapsing a cluster that already holds a deck flattens
// it into the new one. No fan, no nesting — nesting is most of the
// complexity in the card version.
//
// The FACE is the cluster's first picture in reading order (left to right,
// top to bottom), else its first tile — so a collapsed strip's face is its
// source picture, the tile that shows the processed result. Members keep
// the open layout's reading order, so a strip reads the same collapsed.
//
// Pure: reads the nodes it is given, never the store, so the store itself
// can use it without an import cycle.

import type { FreeNodeData } from '../store/freeNodeStore'
import { isPanelType } from './componentLinks'
import { DOCK_TOLERANCE, rectsTouch } from './viewportDocking'

type Nodes = Record<string, FreeNodeData>

/** Can this tile be part of a deck at all? Canvas tiles only: a pinned
 *  node lives on the screen, and panels (lists, pools, prompt pads,
 *  history) are apps, not things you stack. Nor a loop strip, or a card
 *  docked on one (utils/rail): the rail already stacks its cards — as a
 *  cascade, with an order the run reads — and its docked cards overlap and
 *  touch each other by design, so to the touch test every column would
 *  look like a cluster waiting to be collapsed. Read from the node alone
 *  (no `nodes` here): a railDock whose rail is gone is cleared by the rail
 *  sync host within the same change. */
export function canJoinTileDeck(n: FreeNodeData | undefined): n is FreeNodeData {
  return !!n && !n.pin && !isPanelType(n.type) && n.type !== 'rail' && !n.railDock
}

/** The face of a collapsed deck: anchors itself, and at least one other
 *  node still points at it. A face whose members are all gone is just a
 *  tile again. */
export function isTileDeckFace(n: FreeNodeData | undefined, nodes: Nodes): boolean {
  if (!n?.tileDeck || n.tileDeck.anchor !== n.id) return false
  for (const m of Object.values(nodes)) {
    if (m.id !== n.id && m.tileDeck?.anchor === n.id) return true
  }
  return false
}

/** Hidden behind a face. Orphan-safe: a member whose face is gone (or no
 *  longer a face) shows again, rather than vanishing for good. */
export function isHiddenTile(n: FreeNodeData | undefined, nodes: Nodes): boolean {
  if (!n?.tileDeck || n.tileDeck.anchor === n.id) return false
  const face = nodes[n.tileDeck.anchor]
  return !!face && face.tileDeck?.anchor === face.id
}

/** Faces and hidden members of every collapsed deck, in ONE pass — for
 *  loops over all nodes (render filters, strip and dock computations),
 *  where calling isTileDeckFace / isHiddenTile per node would be O(n²).
 *  Same rules as those two, orphan-safe included. */
export function tileDeckIndex(nodes: Nodes): { faces: Set<string>; hidden: Set<string> } {
  const claimed = new Set<string>()          // anchors some OTHER node points at
  for (const m of Object.values(nodes)) {
    const a = m.tileDeck?.anchor
    if (a && a !== m.id) claimed.add(a)
  }
  const faces = new Set<string>()
  for (const a of claimed) {
    const f = nodes[a]
    if (f?.tileDeck?.anchor === f?.id) faces.add(a)
  }
  const hidden = new Set<string>()
  for (const m of Object.values(nodes)) {
    const a = m.tileDeck?.anchor
    if (a && a !== m.id && faces.has(a)) hidden.add(m.id)
  }
  return { faces, hidden }
}

/** The face a node belongs to: itself when it is a face, its anchor when
 *  it is hidden, otherwise null. */
export function tileDeckFaceOf(id: string, nodes: Nodes): string | null {
  const n = nodes[id]
  if (!n) return null
  if (isTileDeckFace(n, nodes)) return n.id
  return isHiddenTile(n, nodes) ? n.tileDeck!.anchor : null
}

/** Every member of a face's deck, the face included, in the OPEN layout's
 *  reading order (by offset: left to right, top to bottom). The face need
 *  not come first — it is the deck's first picture, not its leftmost tile
 *  — and keeping the open order is what lets a collapsed effect strip read
 *  exactly as it did open. */
export function tileDeckMembers(faceId: string, nodes: Nodes): FreeNodeData[] {
  const face = nodes[faceId]
  if (!face) return []
  const offset = (m: FreeNodeData) => m.id === faceId ? { dx: 0, dy: 0 } : m.tileDeck!
  return Object.values(nodes)
    .filter(m => m.id === faceId || m.tileDeck?.anchor === faceId)
    .sort((a, b) => (offset(a).dx - offset(b).dx) || (offset(a).dy - offset(b).dy))
}

const isPicture = (n: FreeNodeData) => (n.type === 'image' || n.type === 'video') && !!n.imageUrl
/** Tiles an effect strip is made of. Mirrors useFxStrips' stripItem closely
 *  enough to tell which picture LEADS a strip (a video without a poster
 *  counts here; the strip just reads it as unreadable). */
const isStripTile = (n: FreeNodeData) => isPicture(n) || n.type === 'effect'

/** The tile a collapsed cluster shows. First choice: the first picture (in
 *  reading order) that starts an effect strip in the OPEN layout — the
 *  source picture, which carries the processed result. Then the first
 *  picture, then the first tile. A note, or a picture that merely touches
 *  the cluster through a note, must not become the face and hide the
 *  result behind it. `visible` is in reading order. */
function pickFace(visible: FreeNodeData[]): FreeNodeData {
  const strip = visible.filter(isStripTile)
  for (const p of strip) {
    if (!isPicture(p)) continue
    // p's strip component (strip tiles only — a note does not join strips)
    const seen = new Set([p.id])
    const queue = [p]
    let hasEffect = false
    while (queue.length) {
      const cur = queue.pop()!
      if (cur.type === 'effect') hasEffect = true
      for (const o of strip) {
        if (seen.has(o.id) || !rectsTouch(cur, o, DOCK_TOLERANCE)) continue
        seen.add(o.id)
        queue.push(o)
      }
    }
    // It LEADS only if nothing in its component reads before it.
    const leads = [...seen].every(id => id === p.id || visible.findIndex(v => v.id === id) > visible.indexOf(p))
    if (hasEffect && leads) return p
  }
  return visible.find(isPicture) ?? visible[0]
}

/** `ids` plus every hidden member of any face among them, de-duplicated —
 *  what a move or a delete of those ids must also apply to. The analogue
 *  of useCardDecks' expandWithNestedMembers. */
export function expandTileIds(ids: string[], nodes: Nodes): string[] {
  const out = new Set(ids)
  for (const id of ids) {
    if (!isTileDeckFace(nodes[id], nodes)) continue
    for (const m of tileDeckMembers(id, nodes)) out.add(m.id)
  }
  return [...out]
}

/** The visible, deck-able tiles touching `id` (transitively), sorted into
 *  reading order — the cluster a double-click would collapse. Includes
 *  `id` itself; fewer than 2 means there is nothing to collapse. Hidden
 *  members are not geometry, so a collapsed deck takes part through its
 *  face's rect only. A loop strip and its docked cards are never pulled in
 *  (canJoinTileDeck), so a free tile parked against a rail's edge does not
 *  drag the rail's columns into its deck. */
export function touchingTileCluster(id: string, nodes: Nodes): string[] {
  const start = nodes[id]
  if (!canJoinTileDeck(start) || isHiddenTile(start, nodes)) return []
  const pool = Object.values(nodes).filter(n => canJoinTileDeck(n) && !isHiddenTile(n, nodes))
  const seen = new Set([start.id])
  const queue = [start]
  while (queue.length) {
    const cur = queue.pop()!
    for (const o of pool) {
      if (seen.has(o.id) || !rectsTouch(cur, o, DOCK_TOLERANCE)) continue
      seen.add(o.id)
      queue.push(o)
    }
  }
  return [...seen]
    .map(i => nodes[i])
    .sort((a, b) => (a.x - b.x) || (a.y - b.y))
    .map(n => n.id)
}

/** The tileDeck patches that collapse `clusterIds` (in reading order; the
 *  face is chosen by pickFace). A face already in the cluster is flattened:
 *  its hidden members join the new deck with offsets from the new face,
 *  measured from where they WOULD be if opened. Returns id → tileDeck for
 *  every member, or null when there is nothing to collapse. */
export function collapsePatches(
  clusterIds: string[],
  nodes: Nodes,
): Record<string, NonNullable<FreeNodeData['tileDeck']>> | null {
  const visible = clusterIds.map(i => nodes[i]).filter(canJoinTileDeck)
  if (visible.length < 2) return null
  const face = pickFace(visible)
  const out: Record<string, NonNullable<FreeNodeData['tileDeck']>> = {}
  for (const m of visible) {
    out[m.id] = { anchor: face.id, dx: m.x - face.x, dy: m.y - face.y }
    if (!isTileDeckFace(m, nodes)) continue
    for (const h of tileDeckMembers(m.id, nodes)) {
      if (h.id === m.id) continue
      const hx = m.x + h.tileDeck!.dx, hy = m.y + h.tileDeck!.dy
      out[h.id] = { anchor: face.id, dx: hx - face.x, dy: hy - face.y }
    }
  }
  return out
}

/** Where each member of a face's deck goes back to on expand: id → x/y.
 *  The face stays put. */
export function expandPositions(faceId: string, nodes: Nodes): Record<string, { x: number; y: number }> {
  const face = nodes[faceId]
  const out: Record<string, { x: number; y: number }> = {}
  if (!face) return out
  for (const m of tileDeckMembers(faceId, nodes)) {
    out[m.id] = { x: face.x + (m.tileDeck?.dx ?? 0), y: face.y + (m.tileDeck?.dy ?? 0) }
  }
  return out
}
