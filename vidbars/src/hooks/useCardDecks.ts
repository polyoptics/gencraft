// useCardDecks — spatial deck detection via union-find clustering
// Detects touching card clusters and manages deck state (open/fanned/stacked)

import { useMemo } from 'react'
import { useFreeNodeStore } from '../store/freeNodeStore'
import type { ProjectGroup, BoardData } from '../store/boardsStore'
import { type GroupSlot } from '../utils/nlePush'
import { computeGroupLayout, getRowY, getRowHeight } from '../utils/nleRows'
import { DEFAULT_H } from '../utils/barConstants'
import { nearer } from '../utils/deckAway'
import { primaryFirst } from '../utils/primaryCard'
import { liveLocks, lockOf } from '../utils/deckLock'
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
// The header band above a card is drawn with a screen-pixel floor, so in
// canvas units it grows as you zoom out. Touching is judged with the band
// at its own canvas size instead, so how near two cards must be to join a
// deck is the same at every zoom (Brian 2026-11-05: zoomed far out, open
// decks a little apart merged into one).
const TOUCH_HEADER = NLE_HEADER_CANVAS_H + 2
const headerExtendCanvasAt = (zoom: number) => (Math.max(NLE_HEADER_CANVAS_H * zoom, 20) + 2 * zoom) / zoom

/** The zoom the slack below is measured at. It was the farthest zoom; the
 *  view now pulls back further (canvasStore MIN_ZOOM), and the reach under a
 *  window stays what it was. */
const SLACK_ZOOM = 0.045

/** How much taller the drawn header band is at that zoom than its
 *  own canvas size: a card docked UNDER a card-back window sits with its
 *  drawn header below the window's foot (Brian 2026-11-07), so the window
 *  reaches this much further down for it, the same at every zoom. */
export const HEADER_BAND_SLACK = headerExtendCanvasAt(SLACK_ZOOM) - TOUCH_HEADER

/** A card's rect as touching judges it: its visual rect with the header
 *  band at its own canvas size, so the same at every zoom. Used by the
 *  card-back windows' docking (utils/deckDockDrag, utils/filmShots). */
export function cardTouchRect(g: ProjectGroup, boards: Record<string, BoardData>, zoom: number): { left: number; top: number; right: number; bottom: number } | null {
  const v = cardVisualRect(g, boards, zoom)
  if (!v) return null
  return { left: v.rect.left, right: v.rect.right, bottom: v.rect.bottom, top: v.rect.top + headerExtendCanvasAt(zoom) - TOUCH_HEADER }
}

/** Do cards `a` and `b` touch, as clustering judges it? */
export function cardsTouch(a: ProjectGroup, b: ProjectGroup, boards: Record<string, BoardData>, zoom: number): boolean {
  const ra = cardTouchRect(a, boards, zoom), rb = cardTouchRect(b, boards, zoom)
  return !!ra && !!rb && rectsTouch({ id: a.id, ...ra }, { id: b.id, ...rb }, TOUCH_TOLERANCE)
}

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
  const headerExtendCanvas = headerExtendCanvasAt(zoom)
  return {
    rect: { id: g.id, left, right: left + finalW, top: top - headerExtendCanvas, bottom: top + finalH },
    contentTop: top,
  }
}

export interface Deck {
  id: string              // sorted member group IDs joined with "|"
  memberIds: string[]     // group IDs, the front card first, then nearest it first (utils/deckAway nearer)
  anchorGroupId: string   // the front card (the row's primary card, utils/primaryCard)
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
  // Cards docked on a loop strip (utils/railCards), as a stable key: the
  // strip already says how they sit together, so they raise no touching
  // hints with their column neighbours.
  const dockedKey = useFreeNodeStore(s => Object.values(s.nodes)
    .filter(n => n.cardRef && n.railDock && !n.railDock.lifted).map(n => n.cardRef).sort().join('|'))
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
    // A locked deck (utils/deckLock) holds its own cards whatever touches
    // them, and no others: two cards join only when they carry the same
    // lock or none, and the cards of one lock always join.
    const live = liveLocks(groups)
    const ghostLock = new Map<string, string | undefined>()
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
        ghostLock.set(`ghost:${g.id}:${slot.cardId}`, lockOf(g, live))
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
    // Every rect here carries the zoom's header band; swap it for the
    // fixed one (TOUCH_HEADER) before testing touch.
    const headerSlack = headerExtendCanvasAt(zoom) - TOUCH_HEADER
    const touchRect = (r: GroupSlot): GroupSlot => ({ ...r, top: r.top + headerSlack })
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
      const nodeLock = (i: number): string | undefined =>
        i < groupCount ? lockOf(zoneGroups[i], live) : ghostLock.get(zoneGhosts[i - groupCount].id)
      const locks = Array.from({ length: totalNodes }, (_, i) => nodeLock(i))
      const lockFirst = new Map<string, number>()
      for (let i = 0; i < totalNodes; i++) {
        const l = locks[i]
        if (!l) continue
        const f = lockFirst.get(l)
        if (f === undefined) lockFirst.set(l, i)
        else uf.union(f, i)
      }
      for (let i = 0; i < totalNodes; i++) {
        for (let j = i + 1; j < totalNodes; j++) {
          if (locks[i] !== locks[j]) continue
          // A card that lay where a deck opened is under its row, not in
          // it (utils/deckUnder).
          if (i < groupCount && j < groupCount && (zoneGroups[i].rowUnder?.includes(zoneGroups[j].id) || zoneGroups[j].rowUnder?.includes(zoneGroups[i].id))) continue
          const ri = nodeRect(i)
          const rj = nodeRect(j)
          if (ri && rj && rectsTouch(touchRect(ri), touchRect(rj), TOUCH_TOLERANCE)) {
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
        // Joined to the row round the back (through a card touching both):
        // still under it, so out of it.
        .map(c => {
          const under = new Set(c.flatMap(i => zoneGroups[i].rowUnder ?? []))
          return under.size ? c.filter(i => !under.has(zoneGroups[i].id)) : c
        })
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
    // A docked card leaves its cluster; the rest stay together if they still
    // make two or more.
    const docked = new Set(dockedKey ? dockedKey.split('|') : [])
    const clusters = docked.size === 0 ? allClusters
      : allClusters.map(c => c.filter(id => !docked.has(id))).filter(c => c.length >= 2)
    // Each row leads with its primary card (utils/primaryCard): the leftmost,
    // or a card made primary. The row's controls sit on it.
    const touchingClusters = clusters.map(c => c.some(id => groupMap.get(id)?.deckLastFront) ? primaryFirst(groups, c) : c)

    // 5. Filter to decks: clusters where ALL members have deckState !== 'open'
    // (groupMap declared above for ghost-bridge construction).
    const decks: Deck[] = []
    const inSpatialDeck = new Set<string>()  // track groups handled by spatial clusters

    for (const cluster of clusters) {
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

      // The front card first, then the rest nearest it first (utils/deckAway
      // nearer): left to right for a deck laid out to the right, as before;
      // right to left, or out from it, when its primary card is on the right
      // or in the middle, or it opened away from a storyline.
      const sorted = fullMembers.sort((a, b) => (rects.get(a)?.left ?? 0) - (rects.get(b)?.left ?? 0))
      const aL = rects.get(anchorId)?.left ?? 0, aT = rects.get(anchorId)?.top ?? 0
      const dx = (id: string) => (rects.get(id)?.left ?? aL) - aL, dy = (id: string) => (rects.get(id)?.top ?? aT) - aT
      const others = sorted.filter(id => id !== anchorId)
      const up = others.length > 0 && others.every(id => dy(id) < -1)
      const rest = others.sort((a, b) => nearer(dx(a), dy(a), dx(b), dy(b), up))
      sorted.splice(0, sorted.length, anchorId, ...rest)

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
  }, [groups, boards, zoom, dockedKey])
}

/** The groups a canvas drag has to steer around.
 *
 *  Excludes what is being dragged, what a collapsed deck is already hiding,
 *  and — the part that is easy to forget — anything PINNED. A pinned card has
 *  left the canvas, but its originX/originY still point at the space it used
 *  to occupy, so without this a canvas card refuses to cross an empty patch
 *  where nothing is drawn. Four drag handlers built this same list by hand
 *  and all four had to agree; now they cannot disagree. */
export function canvasObstacleGroups(
  groups: ProjectGroup[], draggingSet: Set<string>,
): ProjectGroup[] {
  return groups.filter(g => !draggingSet.has(g.id) && !isHiddenDeckMember(g) && !g.pin)
}

/** A group is hidden because its deck is collapsed onto an anchor that ISN'T
 *  it. `selfContained` is for renders that draw one chosen group in its own
 *  frame — a pinned card. There, the deck it belongs to is not on screen, so
 *  "the anchor is showing this for you" is false and hiding it would erase
 *  the only thing the render exists to draw. A pinned deck ANCHOR still hides
 *  its members, because those ARE in the frame with it. */
function hiddenMember(
  g: ProjectGroup, groups: ProjectGroup[], selfContained: boolean,
): boolean {
  if (!(g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id)) return false
  return selfContained ? groups.some(x => x.id === g.deckAnchorId) : true
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
  selfContained = false,
): Set<string> {
  const hidden = new Set<string>()
  for (const g of groups) {
    // Hide boards of any non-anchor group that's in a stacked or fanned deck
    if (hiddenMember(g, groups, selfContained)) {
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
  selfContained = false,
): Set<string> {
  const hidden = new Set<string>()
  for (const g of groups) {
    if (hiddenMember(g, groups, selfContained)) hidden.add(g.id)
  }
  return hidden
}
