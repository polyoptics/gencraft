/**
 * Pure bar-mutation functions.
 * All operate on (bars, rootIds) and return new state — no store dependency.
 */
import type { Bar } from '../types/bar'

// ── Constants ──────────────────────────────────────────────
export const DEFAULT_CHILD_W = 240
export const MIN_W = 60
export const BLOCK_GAP = 8

// ── Helpers ────────────────────────────────────────────────

export function makeBar(
  overrides: Partial<Bar> & { id: string; parentId: string | null; rowIndex: number; x: number; width: number },
): Bar {
  return {
    name: 'Untitled', subtitle: '', icon: null, color: '#5b8dd9',
    children: [], height: 135,
    content: { text: '', images: [], media: [], mentions: [] },
    ...overrides,
  }
}

export function collectSubtree(bars: Record<string, Bar>, id: string): string[] {
  const bar = bars[id]
  if (!bar) return []
  return [id, ...bar.children.flatMap(cid => collectSubtree(bars, cid))]
}

function getBlocksAtRow(bars: Record<string, Bar>, rowIndex: number, excludeId?: string): Bar[] {
  return Object.values(bars).filter(b => b.rowIndex === rowIndex && b.id !== excludeId)
}

function clampDxSiblings(bar: Bar, dx: number, rowBlocks: Bar[]): number {
  if (dx === 0) return 0
  if (dx < 0) {
    const leftNeighbors = rowBlocks.filter(b => b.x + b.width <= bar.x)
    if (leftNeighbors.length === 0) return dx
    const maxLeftEdge = Math.max(...leftNeighbors.map(b => b.x + b.width))
    return Math.max(dx, maxLeftEdge - bar.x)
  } else {
    const rightNeighbors = rowBlocks.filter(b => b.x >= bar.x + bar.width)
    if (rightNeighbors.length === 0) return dx
    const minRightEdge = Math.min(...rightNeighbors.map(b => b.x))
    return Math.min(dx, minRightEdge - (bar.x + bar.width))
  }
}

// ── Return type for mutations that change bars + optionally rootIds ──
export interface BarMutResult {
  bars: Record<string, Bar>
  rootIds?: string[]
  savedCollapsedState?: Record<string, boolean> | null
}

// ── Mutations ──────────────────────────────────────────────

export function addChild(
  bars: Record<string, Bar>, _rootIds: string[], barId: string,
): BarMutResult | null {
  const bar = bars[barId]; if (!bar) return null
  const newId = crypto.randomUUID()
  const existing = bar.children.map(cid => bars[cid]).filter(Boolean) as Bar[]
  let childX = existing.length === 0 ? bar.x
    : existing.reduce((m, b) => b.x + b.width > m.x + m.width ? b : m, existing[0]).x + existing[existing.length - 1].width + BLOCK_GAP
  const childW = Math.min(DEFAULT_CHILD_W, bar.width)
  const childH = Math.round(childW * 9 / 16)
  childX = Math.max(bar.x, Math.min(childX, bar.x + bar.width - childW))
  const newChild = makeBar({ id: newId, parentId: barId, rowIndex: bar.rowIndex + 1, x: childX, width: childW, height: childH, color: bar.color })
  return {
    bars: { ...bars, [barId]: { ...bar, children: [...bar.children, newId] }, [newId]: newChild },
  }
}

export function addSibling(
  bars: Record<string, Bar>, rootIds: string[], barId: string, position: 'before' | 'after',
): BarMutResult | null {
  const bar = bars[barId]; if (!bar) return null
  const newId = crypto.randomUUID()
  const newW = Math.min(DEFAULT_CHILD_W, bar.width)
  const newH = Math.round(newW * 9 / 16)
  const newX = position === 'after' ? bar.x + bar.width + BLOCK_GAP : bar.x - newW - BLOCK_GAP
  const newBar = makeBar({ id: newId, parentId: bar.parentId, rowIndex: bar.rowIndex, x: newX, width: newW, height: newH, color: bar.color })
  const updatedBars: Record<string, Bar> = { ...bars, [newId]: newBar }
  const rowSiblings = Object.values(bars).filter(b => b.rowIndex === bar.rowIndex && b.id !== barId)
  if (position === 'after') {
    const toShift = rowSiblings.filter(b => b.x >= newX - BLOCK_GAP / 2).sort((a, b) => a.x - b.x)
    let cursor = newX + newW + BLOCK_GAP
    toShift.forEach(b => { const px = Math.max(b.x, cursor); updatedBars[b.id] = { ...b, x: px }; cursor = px + b.width + BLOCK_GAP })
  } else {
    // Only push LEFT bars that actually overlap with the new bar's space
    const toShift = rowSiblings
      .filter(b => b.x < bar.x && b.x + b.width > newX)
      .sort((a, b) => b.x - a.x) // right-to-left
    let cursor = newX - BLOCK_GAP
    toShift.forEach(b => { const px = Math.min(b.x, cursor - b.width); updatedBars[b.id] = { ...b, x: px }; cursor = px - BLOCK_GAP })
  }
  if (bar.parentId && updatedBars[bar.parentId]) {
    const parent = updatedBars[bar.parentId]
    const idx = parent.children.indexOf(barId)
    const nc = [...parent.children]; nc.splice(position === 'after' ? idx + 1 : idx, 0, newId)
    updatedBars[bar.parentId] = { ...parent, children: nc }
  }
  const newRootIds = bar.parentId ? rootIds : [...rootIds, newId]
  return { bars: updatedBars, rootIds: newRootIds }
}

export function moveBarOp(
  bars: Record<string, Bar>, barId: string, dx: number,
): BarMutResult | null {
  if (dx === 0) return null
  const bar = bars[barId]; if (!bar) return null
  const rowBlocks = getBlocksAtRow(bars, bar.rowIndex, barId)
  const clampedDx = clampDxSiblings(bar, dx, rowBlocks)
  if (clampedDx === 0) return null
  const subtree = collectSubtree(bars, barId)
  const updatedBars = { ...bars }
  subtree.forEach(sid => { updatedBars[sid] = { ...updatedBars[sid], x: updatedBars[sid].x + clampedDx } })
  return { bars: updatedBars }
}

export function moveMultipleOp(
  bars: Record<string, Bar>, ids: string[], dx: number,
): BarMutResult | null {
  if (ids.length === 0 || dx === 0) return null
  const idSet = new Set(ids)
  const roots = ids.filter(id => {
    const bar = bars[id]
    return bar && (!bar.parentId || !idSet.has(bar.parentId))
  })
  const updatedBars = { ...bars }
  roots.forEach(id => {
    collectSubtree(bars, id).forEach(sid => {
      updatedBars[sid] = { ...updatedBars[sid], x: updatedBars[sid].x + dx }
    })
  })
  return { bars: updatedBars }
}

export function resizeEdge(
  bars: Record<string, Bar>, barId: string, edge: 'left' | 'right', delta: number,
): BarMutResult | null {
  if (delta === 0) return null
  const bar = bars[barId]; if (!bar) return null
  const rowBlocks = getBlocksAtRow(bars, bar.rowIndex, barId)
  if (edge === 'right') {
    const rightNeighbors = rowBlocks.filter(b => b.x >= bar.x + bar.width)
    const maxW = rightNeighbors.length > 0 ? Math.min(...rightNeighbors.map(b => b.x)) - bar.x : Infinity
    const newW = Math.max(MIN_W, Math.min(bar.width + delta, maxW))
    return { bars: { ...bars, [barId]: { ...bar, width: newW } } }
  } else {
    const leftNeighbors = rowBlocks.filter(b => b.x + b.width <= bar.x)
    const minX = leftNeighbors.length > 0 ? Math.max(...leftNeighbors.map(b => b.x + b.width)) : -Infinity
    const newX = Math.max(minX, Math.min(bar.x + delta, bar.x + bar.width - MIN_W))
    const newW = bar.width - (newX - bar.x)
    return { bars: { ...bars, [barId]: { ...bar, x: newX, width: newW } } }
  }
}

export function deleteBarOp(
  bars: Record<string, Bar>, rootIds: string[], barId: string,
): BarMutResult | null {
  if (Object.keys(bars).length <= 1) return null
  const bar = bars[barId]; if (!bar) return null
  const newBars = { ...bars }
  delete newBars[barId]
  bar.children.forEach(cid => { if (newBars[cid]) newBars[cid] = { ...newBars[cid], parentId: bar.parentId } })
  if (bar.parentId && newBars[bar.parentId]) {
    const gp = newBars[bar.parentId]
    const idx = gp.children.indexOf(barId)
    const nc = [...gp.children]; nc.splice(idx, 1, ...bar.children)
    newBars[bar.parentId] = { ...gp, children: nc }
  }
  let newRootIds = rootIds.filter(r => r !== barId)
  if (!bar.parentId) {
    const idx = rootIds.indexOf(barId)
    newRootIds = [...rootIds]; newRootIds.splice(idx, 1, ...bar.children)
  }
  return { bars: newBars, rootIds: newRootIds }
}

export function deleteSubtreeOp(
  bars: Record<string, Bar>, rootIds: string[], barId: string,
): BarMutResult | null {
  if (Object.keys(bars).length <= 1) return null
  const bar = bars[barId]; if (!bar) return null
  const toDelete = collectSubtree(bars, barId)
  const newBars = { ...bars }
  toDelete.forEach(did => delete newBars[did])
  const newRootIds = rootIds.filter(r => r !== barId)
  if (bar.parentId && newBars[bar.parentId]) {
    const parent = newBars[bar.parentId]
    newBars[bar.parentId] = { ...parent, children: parent.children.filter(cid => cid !== barId) }
  }
  return { bars: newBars, rootIds: newRootIds }
}

export function addParentAboveOp(
  bars: Record<string, Bar>, rootIds: string[], barId: string,
): BarMutResult | null {
  const bar = bars[barId]; if (!bar) return null
  const newParentId = crypto.randomUUID()
  const grandParentRow = bar.parentId ? (bars[bar.parentId]?.rowIndex ?? -1) : -1
  const hasGap = bar.rowIndex > grandParentRow + 1
  const newParentRow = hasGap ? bar.rowIndex - 1 : bar.rowIndex
  const newParent = makeBar({ id: newParentId, parentId: bar.parentId, rowIndex: newParentRow, x: bar.x, width: bar.width, color: bar.color, name: 'parent', children: [barId] })
  const updatedBars = { ...bars }
  if (!hasGap) {
    collectSubtree(bars, barId).forEach(sid => { updatedBars[sid] = { ...updatedBars[sid], rowIndex: updatedBars[sid].rowIndex + 1 } })
  }
  updatedBars[barId] = { ...updatedBars[barId], parentId: newParentId }
  updatedBars[newParentId] = newParent
  let newRootIds = rootIds
  if (bar.parentId && updatedBars[bar.parentId]) {
    const gp = bars[bar.parentId]
    updatedBars[bar.parentId] = { ...gp, children: gp.children.map(cid => cid === barId ? newParentId : cid) }
  } else {
    newRootIds = rootIds.map(rid => rid === barId ? newParentId : rid)
  }
  return { bars: updatedBars, rootIds: newRootIds }
}

export function reorderSiblingsOp(
  bars: Record<string, Bar>, barId: string,
): BarMutResult | null {
  const bar = bars[barId]; if (!bar?.parentId) return null
  const parent = bars[bar.parentId]; if (!parent) return null
  const sorted = [...parent.children].sort((a, b) => (bars[a]?.x ?? 0) - (bars[b]?.x ?? 0))
  if (sorted.join(',') === parent.children.join(',')) return null
  return { bars: { ...bars, [bar.parentId]: { ...parent, children: sorted } } }
}

export function collapseAllToggleOp(
  bars: Record<string, Bar>, savedCollapsedState: Record<string, boolean> | null,
): BarMutResult {
  if (savedCollapsedState !== null) {
    const newBars = { ...bars }
    Object.keys(bars).forEach(id => {
      newBars[id] = { ...bars[id], collapsed: savedCollapsedState[id] ?? false }
    })
    return { bars: newBars, savedCollapsedState: null }
  } else {
    const saved: Record<string, boolean> = {}
    Object.values(bars).forEach(b => { saved[b.id] = b.collapsed ?? false })
    const newBars = { ...bars }
    Object.values(bars).forEach(b => {
      if (b.children.length > 0) newBars[b.id] = { ...b, collapsed: true }
    })
    return { bars: newBars, savedCollapsedState: saved }
  }
}

/** Move bar (+ subtree) to a different rowIndex. Detaches from parent only if detach=true. */
export function changeRowOp(
  bars: Record<string, Bar>, rootIds: string[], barId: string, newRow: number, detach = true,
): BarMutResult | null {
  const bar = bars[barId]; if (!bar) return null
  const rowDelta = newRow - bar.rowIndex
  if (rowDelta === 0) return null

  // Don't allow child to move above its parent row (parent.rowIndex)
  if (!detach && bar.parentId && bars[bar.parentId]) {
    const parent = bars[bar.parentId]
    if (newRow <= parent.rowIndex) return null
  }

  const subtree = collectSubtree(bars, barId)
  const updatedBars = { ...bars }

  // Shift all subtree bars by rowDelta
  subtree.forEach(sid => {
    updatedBars[sid] = { ...updatedBars[sid], rowIndex: Math.max(0, updatedBars[sid].rowIndex + rowDelta) }
  })

  let newRootIds = rootIds

  if (detach) {
    // Detach from old parent
    if (bar.parentId && updatedBars[bar.parentId]) {
      const oldParent = updatedBars[bar.parentId]
      updatedBars[bar.parentId] = { ...oldParent, children: oldParent.children.filter(c => c !== barId) }
    }
    updatedBars[barId] = { ...updatedBars[barId], parentId: null }
    if (!rootIds.includes(barId)) {
      newRootIds = [...rootIds, barId]
    }
  }

  return { bars: updatedBars, rootIds: newRootIds }
}

/** Reparent bar (+ subtree) under a new parent */
export function reparentBarOp(
  bars: Record<string, Bar>, rootIds: string[], barId: string, newParentId: string,
): BarMutResult | null {
  const bar = bars[barId]; if (!bar) return null
  const newParent = bars[newParentId]; if (!newParent) return null
  if (barId === newParentId) return null
  if (bar.parentId === newParentId) return null
  // Can't reparent to own descendant
  if (collectSubtree(bars, barId).includes(newParentId)) return null

  const updatedBars = { ...bars }

  // Remove from old parent's children
  if (bar.parentId && updatedBars[bar.parentId]) {
    const oldParent = updatedBars[bar.parentId]
    updatedBars[bar.parentId] = { ...oldParent, children: oldParent.children.filter(c => c !== barId) }
  }

  // Add to new parent's children
  updatedBars[newParentId] = { ...updatedBars[newParentId], children: [...updatedBars[newParentId].children, barId] }

  // Adjust rowIndex: only move if the bar is at or above the new parent's row
  // If already below the parent, keep current position (no jump)
  const minChildRow = newParent.rowIndex + 1
  const subtree = collectSubtree(bars, barId)
  if (bar.rowIndex < minChildRow) {
    const rowDelta = minChildRow - bar.rowIndex
    subtree.forEach(sid => {
      updatedBars[sid] = { ...updatedBars[sid], rowIndex: Math.max(0, updatedBars[sid].rowIndex + rowDelta) }
    })
  }
  // Keep bar's x position as-is — no horizontal jumping
  updatedBars[barId] = { ...updatedBars[barId], parentId: newParentId }

  // Update rootIds — remove barId if it was a root
  const newRootIds = rootIds.filter(r => r !== barId)

  return { bars: updatedBars, rootIds: newRootIds }
}

export function importBarsOp(
  bars: Record<string, Bar>, rootIds: string[],
  newBars: Record<string, Bar>, newRootIds: string[], xOffset: number,
): BarMutResult {
  const translated: Record<string, Bar> = {}
  Object.values(newBars).forEach(b => { translated[b.id] = { ...b, x: b.x + xOffset } })
  return {
    bars: { ...bars, ...translated },
    rootIds: [...rootIds, ...newRootIds],
  }
}
