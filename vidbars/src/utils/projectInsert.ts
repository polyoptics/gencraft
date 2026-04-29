/**
 * Insert a saved project (snapshot) into the current canvas without replacing
 * existing work. Generates fresh UUIDs across boards/bars/groups/free-nodes
 * and shifts the inserted content vertically so it lands at `targetY`.
 *
 * Cross-group references that depend on the project's old IDs (deck anchors,
 * ghost slots, linked groups) are cleared on the inserted copy. The user can
 * re-establish those relationships after insertion. Bar parent/child refs are
 * remapped (those are intra-board so they're trivial).
 */
import type { Bar } from '../types/bar'
import type { BoardData, ProjectGroup } from '../store/boardsStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import { useFreeNodeStore } from '../store/freeNodeStore'

/**
 * Snapshot shape — matches what `getCurrentSnapshot` produces in TemplateMenu.
 * Loosely typed because the source is a JSON file written by a possibly-older
 * version of the app.
 */
export interface ProjectSnapshot {
  projectName?: string
  bars?: Record<string, Bar>          // primary board's bars
  rootIds?: string[]                  // primary board's rootIds
  extraBoards?: BoardData[]
  boardOrder?: string[]
  groups?: ProjectGroup[]
  freeNodes?: Record<string, FreeNodeData>
  // Other fields (pan/zoom/etc) intentionally ignored for insert.
}

/**
 * Remap parent/child IDs inside a single board's bars using the given map.
 * Returns a NEW bars object — does not mutate input.
 */
function remapBars(
  bars: Record<string, Bar>,
  barIdMap: Map<string, string>,
): Record<string, Bar> {
  const out: Record<string, Bar> = {}
  for (const [oldId, bar] of Object.entries(bars)) {
    const newId = barIdMap.get(oldId) ?? oldId
    out[newId] = {
      ...bar,
      id: newId,
      parentId: bar.parentId ? (barIdMap.get(bar.parentId) ?? null) : null,
      children: bar.children.map(cid => barIdMap.get(cid) ?? cid),
    }
  }
  return out
}

/**
 * Insert the given snapshot below all existing groups. Returns the IDs of the
 * inserted top-level groups (caller can use this to scroll to / select them).
 */
export function insertProjectSnapshot(
  snapshot: ProjectSnapshot,
  targetY: number,
): string[] {
  // ── 1. Build ID maps ────────────────────────────────────────
  const boardIdMap = new Map<string, string>()
  const barIdMap = new Map<string, string>()
  const groupIdMap = new Map<string, string>()

  // The snapshot's "primary" content needs a fresh board ID — primary is
  // a reserved slot we don't want to overwrite during insert.
  boardIdMap.set('primary', crypto.randomUUID())

  // Remap bars from primary
  for (const bid of Object.keys(snapshot.bars ?? {})) {
    barIdMap.set(bid, crypto.randomUUID())
  }

  // Remap extra boards + their bars
  for (const board of snapshot.extraBoards ?? []) {
    boardIdMap.set(board.id, crypto.randomUUID())
    for (const bid of Object.keys(board.bars ?? {})) {
      barIdMap.set(bid, crypto.randomUUID())
    }
  }

  // Remap groups
  for (const g of snapshot.groups ?? []) {
    groupIdMap.set(g.id, crypto.randomUUID())
  }

  // ── 2. Compute Y offset ─────────────────────────────────────
  // Find the topmost source group; everything shifts down by (targetY - that).
  const sourceGroups = snapshot.groups ?? []
  const sourceMinY = sourceGroups.length > 0
    ? Math.min(...sourceGroups.map(g => g.originY ?? 0))
    : 0
  const dy = targetY - sourceMinY

  // ── 3. Build new boards ─────────────────────────────────────
  const newBoards: BoardData[] = []

  // Primary → becomes a fresh extra board
  if (snapshot.bars && Object.keys(snapshot.bars).length > 0) {
    const primaryNewId = boardIdMap.get('primary')!
    const remappedBars = remapBars(snapshot.bars, barIdMap)
    const remappedRootIds = (snapshot.rootIds ?? []).map(rid => barIdMap.get(rid) ?? rid)
    newBoards.push({
      id: primaryNewId,
      projectName: snapshot.projectName ?? '',
      color: '#5b8dd9',
      nleRow: 0,
      nleX: 0,
      bars: remappedBars,
      rootIds: remappedRootIds,
      viewerBarId: null,
      selectedIds: [],
      savedCollapsedState: null,
      pristine: true,
      boardScale: 1,
      layers: {
        card: { heroImage: null, summary: '', text: '' },
        block: { thumbnail: null, label: '', text: '' },
      },
    })
  }

  // Extra boards → fresh IDs, fresh bar IDs, transient state cleared
  for (const board of snapshot.extraBoards ?? []) {
    const newId = boardIdMap.get(board.id)!
    newBoards.push({
      ...board,
      id: newId,
      bars: remapBars(board.bars ?? {}, barIdMap),
      rootIds: (board.rootIds ?? []).map(rid => barIdMap.get(rid) ?? rid),
      viewerBarId: null,
      selectedIds: [],
      savedCollapsedState: null,
    })
  }

  // ── 4. Build new groups ─────────────────────────────────────
  const newGroups: ProjectGroup[] = sourceGroups.map(g => ({
    ...g,
    id: groupIdMap.get(g.id)!,
    // Remap board IDs — including the snapshot's "primary" → its new UUID.
    boardIds: g.boardIds.map(bid => boardIdMap.get(bid) ?? bid),
    originY: (g.originY ?? 0) + dy,
    // Clear cross-group state that may not survive remap cleanly. Inserted
    // groups start as fresh standalone copies; user can re-link manually.
    deckState: undefined,
    deckAnchorId: undefined,
    deckOffsetX: undefined,
    deckOffsetY: undefined,
    nestedDeck: undefined,
    ghostSlots: undefined,
    linkedGroupIds: [],
  }))

  // If the snapshot had no groups but did have boards, wrap them in a default
  // group so they don't end up orphaned.
  if (newGroups.length === 0 && newBoards.length > 0) {
    newGroups.push({
      id: crypto.randomUUID(),
      name: snapshot.projectName || 'Imported',
      color: '#5b8dd9',
      boardIds: newBoards.map(b => b.id),
      cardHeroImage: null,
      cardSummary: '',
      cardText: '',
      cardHeaderText: snapshot.projectName || '',
      originX: 0,
      originY: targetY,
    })
  }

  // ── 5. Apply to stores ──────────────────────────────────────
  useBoardsStore.setState(s => {
    const updatedBoards = { ...s.boards }
    for (const b of newBoards) updatedBoards[b.id] = b
    return {
      boards: updatedBoards,
      boardOrder: [...s.boardOrder, ...newBoards.map(b => b.id)],
      groups: [...s.groups, ...newGroups],
    }
  })

  // ── 6. Free nodes (Y-shifted, fresh IDs) ────────────────────
  if (snapshot.freeNodes) {
    useFreeNodeStore.setState(s => {
      const updated = { ...s.nodes }
      for (const node of Object.values(snapshot.freeNodes!)) {
        const newId = crypto.randomUUID()
        updated[newId] = { ...node, id: newId, y: (node.y ?? 0) + dy }
      }
      return { nodes: updated }
    })
  }

  return newGroups.map(g => g.id)
}
