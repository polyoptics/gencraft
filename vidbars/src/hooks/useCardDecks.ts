// useCardDecks — spatial deck detection via union-find clustering
// Detects touching card clusters and manages deck state (open/fanned/stacked)

import { useMemo } from 'react'
import type { ProjectGroup, BoardData } from '../store/boardsStore'
import { groupSlot, type GroupSlot } from '../utils/nlePush'
import { computeGroupLayout } from '../utils/nleRows'

/** Returns true if this group is a non-anchor member of a stacked/fanned deck (visually hidden). */
export function isHiddenDeckMember(g: ProjectGroup): boolean {
  return !!(g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id)
}

/** Returns true if this group is an anchor of a sub-deck (other non-open groups point to it via deckAnchorId). */
export function isSubDeckAnchor(groupId: string, allGroups: ProjectGroup[]): boolean {
  return allGroups.some(g => g.id !== groupId && g.deckAnchorId === groupId
    && g.deckState !== undefined && g.deckState !== 'open')
}

const TOUCH_TOLERANCE = 16 // canvas units — slightly > DEFAULT_GAP (12)

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
  zoneLineY: number,
): CardDeckInfo {
  return useMemo(() => {
    if (groups.length < 2) {
      return { decks: [], touchingClusters: [], getDeckForGroup: () => null }
    }

    // 1. Build rects for all groups
    const rects = new Map<string, GroupSlot>()
    for (const g of groups) {
      const layout = computeGroupLayout(g.boardIds, boards)
      const slot = groupSlot(g.id, g.boardIds, boards, g.originX, g.originY, layout)
      if (slot) rects.set(g.id, slot)
    }

    // 2. Filter out hidden deck members from clustering — they're invisible and
    //    already tracked by the persisted-anchor fallback. Including them would
    //    corrupt clusters (e.g. sub-deck members inflating a parent cluster).
    const visibleGroups = groups.filter(g => !isHiddenDeckMember(g))

    // Partition by zone (only visible groups participate in clustering)
    const timelineGroups = visibleGroups.filter(g => {
      const r = rects.get(g.id)
      return r && r.top >= zoneLineY
    })
    const freeGroups = visibleGroups.filter(g => {
      const r = rects.get(g.id)
      return r && r.top < zoneLineY
    })

    // 3. Find touching clusters via union-find, per zone
    function findClusters(zoneGroups: ProjectGroup[]): string[][] {
      const n = zoneGroups.length
      if (n < 2) return []
      const uf = new UnionFind(n)
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const ri = rects.get(zoneGroups[i].id)
          const rj = rects.get(zoneGroups[j].id)
          if (ri && rj && rectsTouch(ri, rj, TOUCH_TOLERANCE)) {
            // Don't merge two separate stacked/fanned deck anchors —
            // they are independent decks that happen to be adjacent.
            const gi = zoneGroups[i], gj = zoneGroups[j]
            const iIsAnchor = gi.deckState && gi.deckState !== 'open' && gi.deckAnchorId === gi.id
            const jIsAnchor = gj.deckState && gj.deckState !== 'open' && gj.deckAnchorId === gj.id
            if (iIsAnchor && jIsAnchor) continue
            uf.union(i, j)
          }
        }
      }
      // Extract clusters
      const clusterMap = new Map<number, number[]>()
      for (let i = 0; i < n; i++) {
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

    const allClusters = [
      ...findClusters(timelineGroups),
      ...findClusters(freeGroups),
    ]

    // 4. Build touching clusters (all, regardless of state)
    const touchingClusters = allClusters

    // 5. Filter to decks: clusters where ALL members have deckState !== 'open'
    const groupMap = new Map(groups.map(g => [g.id, g]))
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
  }, [groups, boards, zoneLineY])
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
  _boards: Record<string, BoardData>,
  _zoneLineY: number,
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
  _boards: Record<string, BoardData>,
  _zoneLineY: number,
): Set<string> {
  const hidden = new Set<string>()
  for (const g of groups) {
    if (g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id) {
      hidden.add(g.id)
    }
  }
  return hidden
}
