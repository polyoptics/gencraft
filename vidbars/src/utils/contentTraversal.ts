// contentTraversal.ts — enumerate ALL browsable content inside a card/
// deck's recursive tree (models, images, video, audio, text), in a
// stable, author-meaningful order. Generalizes the former
// modelTraversal.ts (models only) for the content-browser windows.
//
// Order: root group first, then deck descendants breadth-first (siblings
// sorted left→right by deck offset / origin, then id for determinism);
// per group: the group's card-text page first (if any), then boards in
// boardIds order; within a board: DFS from rootIds via bar.children (the
// AUTHORED order); within a bar: media[] items in order, then ONE text
// item if the bar has text/headerText.
//
// A card's HERO is browsable content — it is the face of the card, and
// docking a card to a Viewer that showed everything except its face read as
// a bug. contentKinds.ts counts it as image content for the same reason;
// the two must agree or a list filtered to images will refuse to match a
// card whose only image is the one you can see.
//
// Block thumbnails remain decoration: a block is a layout element, not
// something you browse.

import type { ProjectGroup, BoardData } from '../store/boardsStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import type { MediaType } from '../types/bar'
import { getMediaItems } from '../types/bar'
import type { ActiveItem } from '../store/viewport3dStore'
import { getModelPoster } from '../three/posterService'

/** Browse items ARE storable actives — no separate shape. */
export type BrowseItem = ActiveItem

/** Root + transitive deckAnchorId descendants, breadth-first. Same
 *  fixed-point expansion as boardsStore.getTransitiveDescendantIds. */
function expandDeckTree(rootGroupId: string, groups: ProjectGroup[]): ProjectGroup[] {
  const byId = new Map(groups.map(g => [g.id, g]))
  const root = byId.get(rootGroupId)
  if (!root) return []
  const result: ProjectGroup[] = [root]
  const seen = new Set([rootGroupId])
  let frontier = [rootGroupId]
  while (frontier.length > 0) {
    const children = groups
      .filter(g => g.deckAnchorId && frontier.includes(g.deckAnchorId) && !seen.has(g.id))
      .sort((a, b) =>
        ((a.deckOffsetX ?? a.originX ?? 0) - (b.deckOffsetX ?? b.originX ?? 0)) ||
        a.id.localeCompare(b.id))
    for (const c of children) { seen.add(c.id); result.push(c) }
    frontier = children.map(c => c.id)
  }
  return result
}

/** One group's OWN browsable content (no deck expansion): card-text page
 *  first, then boards → bars in authored order. Used per-group by the
 *  pinned-list evaluator, and by collectDeckContent for the full tree. */
export function collectGroupOwnContent(
  g: ProjectGroup,
  boards: Record<string, BoardData>,
): BrowseItem[] {
  const out: BrowseItem[] = []
  // The card's FACE, first. It used to be treated as decoration and skipped,
  // so docking a card to a Viewer showed everything inside the card except
  // the picture the card actually looks like — which is the one image you
  // point at when you say "that card". It leads because it is the card's
  // identity, and defaultBrowseItem opens on the first MEDIA item.
  if (g.cardHeroImage) {
    out.push({
      kind: 'media', mediaType: 'image', url: g.cardHeroImage,
      name: g.name ? `${g.name} — face` : 'Card face',
    })
  }
  if (g.cardText || g.cardHeaderText) {
    out.push({ kind: 'text', sourceId: `group:${g.id}`, name: g.name || 'Card' })
  }
  for (const boardId of g.boardIds) {
    const board = boards[boardId]
    if (!board) continue
    // Authored DFS over the bar tree
    const stack = [...(board.rootIds ?? [])]
    const visited = new Set<string>()
    while (stack.length > 0) {
      const barId = stack.shift()!
      if (visited.has(barId)) continue
      visited.add(barId)
      const bar = board.bars[barId]
      if (!bar) continue
      for (const m of getMediaItems(bar.content)) {
        out.push({
          kind: 'media', mediaType: m.type, url: m.url,
          posterUrl: m.posterUrl ?? (m.type === 'model' ? getModelPoster(m.url) : null),
          name: m.originalName ?? bar.name ?? m.type,
        })
      }
      if (bar.content?.text || bar.content?.headerText) {
        out.push({ kind: 'text', sourceId: `bar:${boardId}:${barId}`, name: bar.name || 'Text' })
      }
      // Children next, before later roots — insert at the front (DFS)
      stack.unshift(...(bar.children ?? []))
    }
  }
  return out
}

/** All browsable content in `rootGroupId`'s recursive deck tree. */
export function collectDeckContent(
  rootGroupId: string,
  groups: ProjectGroup[],
  boards: Record<string, BoardData>,
): BrowseItem[] {
  const out: BrowseItem[] = []
  for (const g of expandDeckTree(rootGroupId, groups)) {
    out.push(...collectGroupOwnContent(g, boards))
  }
  return out
}

/** Widened magnet/dock gate: any media OR any text anywhere in the tree. */
export function groupHasBrowsableContent(
  rootGroupId: string,
  groups: ProjectGroup[],
  boards: Record<string, BoardData>,
): boolean {
  for (const g of expandDeckTree(rootGroupId, groups)) {
    // The face counts, same as in collectGroupOwnContent and contentKinds.
    // Missing it here was worse than missing it there: this decides whether
    // a card is a dock TARGET at all, so a card whose only content is the
    // picture on its front could not be docked to a Viewer in the first
    // place. Three functions describe "what is in a card"; they agree now.
    if (g.cardHeroImage) return true
    if (g.cardText || g.cardHeaderText) return true
    for (const boardId of g.boardIds) {
      const board = boards[boardId]
      if (!board) continue
      for (const bar of Object.values(board.bars)) {
        if (getMediaItems(bar.content).length > 0) return true
        if (bar.content?.text || bar.content?.headerText) return true
      }
    }
  }
  return false
}

/** A free tile's browsable item, or null for content-less tiles. THE
 *  single predicate for cluster membership, magnet gates, click-to-load. */
export function tileBrowseItem(n: FreeNodeData): BrowseItem | null {
  if (n.imageUrl) {
    const mt: MediaType = n.mediaType
      ?? (n.type === 'video' || n.type === 'audio' || n.type === 'model' ? n.type : 'image')
    return {
      kind: 'media', mediaType: mt, url: n.imageUrl,
      posterUrl: n.posterUrl ?? (mt === 'model' ? getModelPoster(n.imageUrl) : null),
      name: n.label || mt,
    }
  }
  if ((n.type === 'text' || n.type === 'note') && n.text.trim()) {
    return { kind: 'text', sourceId: `tile:${n.id}`, name: n.label || 'Text' }
  }
  return null
}

/** What a dock/first-load shows: first MEDIA item, else the first item —
 *  keeps captioned decks from opening on a text page. */
export function defaultBrowseItem(items: BrowseItem[]): BrowseItem | null {
  return items.find(i => i.kind === 'media') ?? items[0] ?? null
}

/** Cluster/magnet membership for tiles: content-bearing tiles PLUS list
 *  tiles (whose "content" is their query results). */
export function isDockableTile(n: FreeNodeData): boolean {
  if (n.type === 'list') return !!n.listQuery
  return tileBrowseItem(n) !== null
}
