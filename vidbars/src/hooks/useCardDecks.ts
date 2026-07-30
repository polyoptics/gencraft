// useCardDecks — spatial deck detection via union-find clustering
// Detects touching card clusters and manages deck state (open/fanned/stacked)

import { useMemo } from 'react'
import type { ProjectGroup, BoardData } from '../store/boardsStore'
import { type GroupSlot } from '../utils/nlePush'
import { computeGroupLayout, getRowY, getRowHeight } from '../utils/nleRows'
import { DEFAULT_H } from '../utils/barConstants'
import { NLE_HEADER_CANVAS_H } from '../components/NLE/NLETimelineHeader'

/** Returns true if this group is a non-anchor member of a stacked/fanned deck (visually hidden). */
export function isHiddenDeckMember(g: ProjectGroup): boolean {
  return !!(g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id)
}

/** Returns true if this group is an anchor of a sub-deck (other non-open groups point to it via deckAnchorId). */
export function isSubDeckAnchor(groupId: string, allGroups: ProjectGroup[]): boolean {
  return allGroups.some(g => g.id !== groupId && g.deckAnchorId === groupId
    && g.deckState !== undefined && g.deckState !== 'open')
}

/** Expand a set of group IDs to include nested sub-deck members (transitively).
 *  Any group whose deckAnchorId points to any member of the set is added.
 *  Used by drag handlers so moving a deck anchor also moves its hidden members. */
export function expandWithNestedMembers(baseIds: string[], allGroups: ProjectGroup[]): string[] {
  const result = new Set(baseIds)
  let added = true
  while (added) {
    added = false
    for (const g of allGroups) {
      if (!result.has(g.id) && g.deckAnchorId && result.has(g.deckAnchorId)) {
        result.add(g.id)
        added = true
      }
    }
  }
  return Array.from(result)
}

const TOUCH_TOLERANCE = 16 // canvas units — slightly > DEFAULT_GAP (12)

/** THE card-geometry authority: a group's VISUAL card rect in canvas
 *  units — mirrors CardLayer's GroupCard exactly (per-board visual
 *  heights, card size overrides, and the zoom-dependent header extend
 *  above the content). Deck clustering, 3D-viewport magnet/snap, and
 *  derived docking all share this so "card level" geometry is one
 *  definition. Also returns the pre-inflated content top (zone logic
 *  needs it zoom-invariant). */
export function cardVisualRect(
  g: ProjectGroup,
  boards: Record<string, BoardData>,
  zoom: number,
): { rect: GroupSlot; contentTop: number } | null {
  const BOARD_PADDING_X = 20
  const layout = computeGroupLayout(g.boardIds, boards)
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
  g.boardIds.forEach(bid => {
    const board = boards[bid]
    if (!board) return
    const bScale = board.boardScale ?? 1
    const rootBars = board.rootIds.map((rid: string) => board.bars[rid]).filter(Boolean)
    if (rootBars.length === 0) return
    const bx = g.originX + (board.nleX ?? 0)
    const localRow = board.nleRow ?? 0
    const by = g.originY + getRowY(localRow, layout)
    const rowH = getRowHeight(localRow, layout)
    const rootH = Math.max(...rootBars.map(b => b.height), DEFAULT_H) * bScale
    const visualH = Math.max(rowH, rootH)
    const minX = Math.min(...rootBars.map(b => b.x))
    const maxX = Math.max(...rootBars.map(b => b.x + b.width))
    const l = bx + BOARD_PADDING_X + minX * bScale - 16
    const r = bx + BOARD_PADDING_X + maxX * bScale + 16
    if (l < left) left = l
    if (r > right) right = r
    if (by < top) top = by
    if (by + visualH > bottom) bottom = by + visualH
  })
  if (left === Infinity) return null
  const finalW = Math.max(right - left, g.cardWidthOverride ?? 0)
  const finalH = Math.max(bottom - top, g.cardHeightOverride ?? 0)
  const headerExtendCanvas = (Math.max(NLE_HEADER_CANVAS_H * zoom, 20) + 2 * zoom) / zoom
  return {
    rect: { id: g.id, left, right: left + finalW, top: top - headerExtendCanvas, bottom: top + finalH },
    contentTop: top,
  }
}

export interface Deck {
  id: string              // sorted member group IDs joined with "|"
  memberIds: string[]     // group IDs sorted left-to-right by card rect
  anchorGroupId: string   // leftmost = primary card
  state: 'fanned' | 'stacked'
  rects: Map<string, GroupSlot> // per-member rects for rendering
}

export interface CardDeckInfo {
  decks: Deck[]
  touchingClusters: string[][]   // ALL touching clusters (2+), regardless of deckState
  getDeckForGroup: (groupId: string) => Deck | null
}

// ── Union-Find ──

class UnionFind {
  parent: number[]
  rank: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
    this.rank = new Array(n).fill(0)
  }
  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x])
    return this.parent[x]
  }
  union(a: number, b: number) {
    const ra = this.find(a), rb = this.find(b)
    if (ra === rb) return
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra
    else { this.parent[rb] = ra; this.rank[ra]++ }
  }
}

function rectsTouch(a: GroupSlot, b: GroupSlot, tol: number): boolean {
  return !(a.right + tol < b.left || b.right + tol < a.left ||
           a.bottom + tol < b.top || b.bottom + tol < a.top)
}

export function useCardDecks(
  groups: ProjectGroup[],
  boards: Record<string, BoardData>,
  zoom: number,
): CardDeckInfo {
  return useMemo(() => {
    if (groups.length < 2) {
      return { decks: [], touchingClusters: [], getDeckForGroup: () => null }
    }

    // 1. Build rects for all groups via the shared card-geometry authority
    // (cardVisualRect — visual bounds incl. header extend, so clustering
    // compares what's on screen, not content bounds).
    const rects = new Map<string, GroupSlot>()
    // Logical (zoom-independent) content top per group. Used for zone partitioning
    // — see step 2 below for why this MUST stay separate from rect.top.
    const logicalTops = new Map<string, number>()
    for (const g of groups) {
      const v = cardVisualRect(g, boards, zoom)
      if (!v) continue
      rects.set(g.id, v.rect)
      // Stash the pre-inflated content top — zone classification uses this so
      // it stays zoom-invariant.
      logicalTops.set(g.id, v.contentTop)
    }

    // 2. Filter out hidden deck members from clustering — they're invisible and
    //    already tracked by the persisted-anchor fallback. Including them would
    //    corrupt clusters (e.g. sub-deck members inflating a parent cluster).
    // A PINNED card has left the canvas. It is not near anything out there
    // any more, so it must not cluster with canvas cards, form decks with
    // them, or raise affordances joining the two — and dragging it must not
    // push canvas cards around. Excluding it HERE, at the one place
    // clustering is derived, removes it from every consumer at once:
    // decks, touching clusters, affordances and the push/collision
    // obstacle lists that read from them. Patching those one at a time is
    // what produced a pinned card that still tugged at its old neighbours.
    const visibleGroups = groups.filter(g => !isHiddenDeckMember(g) && !g.pin)
    // The whole canvas is one work area — clustering runs over a single
    // pool of all visible groups, so decks form among any touching cards
    // regardless of vertical position. (The old free/timeline zone split
    // was retired; logicalTops is still computed above for the rect/ghost
    // geometry but no longer partitions clustering.)

    // 2b. Ghost-slot BRIDGE rects. When a parent deck is open and one or more
    // of its members have been extracted, the parent renders a placeholder at
    // each empty slot (`GhostCardSlot`). Without anything more, those
    // placeholders are spatially invisible to the union-find — so cards on
    // either side of an empty slot can read as separate clusters and the
    // re-close affordance only catches part of the original deck. Project
    // each ghost slot's rect (using the extracted card's geometry shifted to
    // the slot's canvas position) and use them as VIRTUAL bridge nodes in
    // clustering. They union groups they connect, but never become deck
    // members themselves. Same treatment for sub-deck extractions: the
    // parent's ghost slot bridges identically regardless of whether the
    // extracted thing was a single card or a sub-deck anchor with members.
    const groupMap = new Map(groups.map(g => [g.id, g]))
    type GhostBridge = { rect: GroupSlot; logicalTop: number }
    const ghostBridges: GhostBridge[] = []
    for (const g of groups) {
      // Only OPEN parents have visible ghost-slot placeholders on canvas.
      // For fanned/stacked parents, the ghost slot is part of the fan render
      // and the parent itself is the cluster — no bridging needed.
      if (g.deckState && g.deckState !== 'open') continue
      const slots = g.ghostSlots ?? []
      if (slots.length === 0) continue
      for (const slot of slots) {
        const card = groupMap.get(slot.cardId)
        if (!card) continue
        const cardRect = rects.get(slot.cardId)
        const cardLogicalTop = logicalTops.get(slot.cardId)
        if (!cardRect || cardLogicalTop === undefined) continue
        // Translate the extracted card's rect by the offset between its
        // current origin and where the slot sits in the parent.
        const dx = (g.originX + slot.deckOffsetX) - card.originX
        const dy = (g.originY + slot.deckOffsetY) - card.originY
        ghostBridges.push({
          rect: {
            id: `ghost:${g.id}:${slot.cardId}`,
            left: cardRect.left + dx,
            right: cardRect.right + dx,
            top: cardRect.top + dy,
            bottom: cardRect.bottom + dy,
          },
          logicalTop: cardLogicalTop + dy,
        })
      }
    }
    // All ghost bridges participate in the single clustering pool.
    const allGhosts = ghostBridges.map(b => b.rect)

    // 3. Find touching clusters via union-find. Ghost bridges
    // participate as virtual nodes — they help union groups across an
    // extracted-card gap, but are filtered out before cluster IDs are
    // returned (only real groups become deck members).
    function findClusters(zoneGroups: ProjectGroup[], zoneGhosts: GroupSlot[]): string[][] {
      const groupCount = zoneGroups.length
      const totalNodes = groupCount + zoneGhosts.length
      if (groupCount < 2) return [] // need at least 2 real groups to form a cluster
      if (totalNodes < 2) return []
      const uf = new UnionFind(totalNodes)
      // Helper: rect for node i, where 0..groupCount-1 are groups and
      // groupCount..totalNodes-1 are ghost bridges.
      const nodeRect = (i: number): GroupSlot | undefined =>
        i < groupCount ? rects.get(zoneGroups[i].id) : zoneGhosts[i - groupCount]
      for (let i = 0; i < totalNodes; i++) {
        for (let j = i + 1; j < totalNodes; j++) {
          const ri = nodeRect(i)
          const rj = nodeRect(j)
          if (ri && rj && rectsTouch(ri, rj, TOUCH_TOLERANCE)) {
            uf.union(i, j)
          }
        }
      }
      // Extract clusters — only real groups, not ghost bridges. Multi-ghost
      // chains transit cleanly: ghosts in the same union root just don't
      // contribute to the result.
      const clusterMap = new Map<number, number[]>()
      for (let i = 0; i < groupCount; i++) {
        const root = uf.find(i)
        if (!clusterMap.has(root)) clusterMap.set(root, [])
        clusterMap.get(root)!.push(i)
      }
      return Array.from(clusterMap.values())
        .filter(c => c.length >= 2)
        .map(indices => {
          // Sort by left edge
          return indices
            .map(i => zoneGroups[i].id)
            .sort((a, b) => (rects.get(a)?.left ?? 0) - (rects.get(b)?.left ?? 0))
        })
    }

    const allClusters = findClusters(visibleGroups, allGhosts)

    // 4. Build touching clusters (all, regardless of state)
    const touchingClusters = allClusters

    // 5. Filter to decks: clusters where ALL members have deckState !== 'open'
    // (groupMap declared above for ghost-bridge construction).
    const decks: Deck[] = []
    const inSpatialDeck = new Set<string>()  // track groups handled by spatial clusters

    for (const cluster of allClusters) {
      const allNonOpen = cluster.every(gid => {
        const g = groupMap.get(gid)
        return g && g.deckState && g.deckState !== 'open'
      })
      if (!allNonOpen) continue

      // Deck state = tightest among members (stacked > fanned)
      const hasStacked = cluster.some(gid => groupMap.get(gid)?.deckState === 'stacked')
      const state: 'fanned' | 'stacked' = hasStacked ? 'stacked' : 'fanned'

      const memberRects = new Map<string, GroupSlot>()
      for (const gid of cluster) {
        const r = rects.get(gid)
        if (r) memberRects.set(gid, r)
        inSpatialDeck.add(gid)
      }

      decks.push({
        id: cluster.join('|'),
        memberIds: cluster,
        anchorGroupId: cluster[0], // leftmost
        state,
        rects: memberRects,
      })
    }

    // 5b. Persisted-anchor fallback: groups with deckAnchorId that weren't
    //     caught by spatial clustering (e.g. stacked groups far apart).
    //     Group them by deckAnchorId to form decks.
    const anchorBuckets = new Map<string, string[]>()
    for (const g of groups) {
      if (g.deckState && g.deckState !== 'open' && g.deckAnchorId && !inSpatialDeck.has(g.id)) {
        if (!anchorBuckets.has(g.deckAnchorId)) anchorBuckets.set(g.deckAnchorId, [])
        anchorBuckets.get(g.deckAnchorId)!.push(g.id)
      }
    }
    for (const [anchorId, memberIds] of anchorBuckets) {
      // Need at least the anchor + 1 member (or at least 2 members)
      // Also include the anchor itself if it's non-open with matching deckAnchorId
      const fullMembers = memberIds.includes(anchorId) ? memberIds : [anchorId, ...memberIds]
      // Only form a deck if the anchor group exists
      // (anchor may be 'open' if it's a sub-deck anchor visible after parent opened)
      const anchorGroup = groupMap.get(anchorId)
      if (!anchorGroup) continue
      if (fullMembers.length < 2) continue

      // Sort by left edge (anchor first by convention)
      const sorted = fullMembers.sort((a, b) => (rects.get(a)?.left ?? 0) - (rects.get(b)?.left ?? 0))

      // Derive deck state: anchor's deckState is authoritative when non-open.
      // Fall back to member analysis only when anchor is 'open' (sub-deck anchor case,
      // where the anchor's deckState doesn't represent this deck's state).
      let state: 'fanned' | 'stacked'
      if (anchorGroup.deckState === 'stacked' || anchorGroup.deckState === 'fanned') {
        state = anchorGroup.deckState
      } else {
        const hasStacked = sorted.some(gid => groupMap.get(gid)?.deckState === 'stacked')
        state = hasStacked ? 'stacked' : 'fanned'
      }

      const memberRects = new Map<string, GroupSlot>()
      for (const gid of sorted) {
        const r = rects.get(gid)
        if (r) memberRects.set(gid, r)
      }

      decks.push({
        id: sorted.join('|'),
        memberIds: sorted,
        anchorGroupId: anchorId,
        state,
        rects: memberRects,
      })
    }

    // 6. Build lookup
    const groupToDeck = new Map<string, Deck>()
    for (const d of decks) {
      for (const gid of d.memberIds) {
        groupToDeck.set(gid, d)
      }
    }

    return {
      decks,
      touchingClusters,
      getDeckForGroup: (gid: string) => groupToDeck.get(gid) ?? null,
    }
  }, [groups, boards, zoom])
}

/**
 * Returns board IDs that should be hidden at block/board levels because they
 * belong to non-anchor groups in a stacked or fanned deck.
 *
 * Uses the persisted deckAnchorId field — no spatial clustering needed.
 * Pure function (no hooks) — can be called from any component via useMemo.
 */
export function getHiddenBoardIds(
  groups: ProjectGroup[],
): Set<string> {
  const hidden = new Set<string>()
  for (const g of groups) {
    // Hide boards of any non-anchor group that's in a stacked or fanned deck
    if (g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id) {
      for (const bid of g.boardIds) hidden.add(bid)
    }
  }
  return hidden
}

/**
 * Returns group IDs that should be hidden at block/board levels
 * (non-anchor members of stacked/fanned decks).
 *
 * Uses the persisted deckAnchorId field — no spatial clustering needed.
 */
export function getHiddenGroupIds(
  groups: ProjectGroup[],
): Set<string> {
  const hidden = new Set<string>()
  for (const g of groups) {
    if (g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id) {
      hidden.add(g.id)
    }
  }
  return hidden
}
