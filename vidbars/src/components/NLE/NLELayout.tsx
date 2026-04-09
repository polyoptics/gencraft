// NLELayout — multi-row bar rendering with parent-child wires
// This component always renders the full bar tree (board layer, zoom ≥ 0.3).
// The block-level solid view is now handled by BlockLayer.
import React, { useMemo, useCallback, useSyncExternalStore } from 'react'
import type { Bar } from '../../types/bar'
import { DEFAULT_H } from '../../utils/barConstants'
import { useBoardCtx } from '../../contexts/BoardContext'
import { NLEBlock } from './NLEBlock'
import { gripDragState } from '../../utils/gripDragState'
import { wireDragState } from '../../utils/wireDragState'
import { collectSubtree } from '../../utils/barOps'

const ROW_GAP = 40

/** Lighten a hex color by blending with white — mimics the port border highlight */
function lighten(hex: string, amount = 0.45): string {
  const n = parseInt(hex.replace('#', ''), 16)
  const r = Math.min(255, ((n >> 16) & 0xff) + Math.round((255 - ((n >> 16) & 0xff)) * amount))
  const g = Math.min(255, (((n >> 8) & 0xff)) + Math.round((255 - ((n >> 8) & 0xff)) * amount))
  const b = Math.min(255, ((n & 0xff)) + Math.round((255 - (n & 0xff)) * amount))
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

export const NLELayout: React.FC = () => {
  const ctx = useBoardCtx()
  const { bars, rootIds, collapseAllToggle } = ctx

  // Subscribe to drag states for real-time wire updates
  const gripDrag = useSyncExternalStore(gripDragState.subscribe, gripDragState.get)
  const wireDrag = useSyncExternalStore(wireDragState.subscribe, wireDragState.get)

  // Compute subtree of the grip-dragged block (so children move with parent)
  const gripDragSubtree = useMemo(() => {
    if (!gripDrag) return new Set<string>()
    return new Set(collectSubtree(bars, gripDrag.blockId))
  }, [gripDrag?.blockId, bars])

  const { allBars, visibleIds, rowTops, rowH, totalH, totalW, offsetX, row0 } = useMemo(() => {
    const allBarsArr = Object.values(bars)
    if (allBarsArr.length === 0) {
      return { allBars: [] as Bar[], visibleIds: new Set<string>(), rowTops: {} as Record<number, number>, rowH: {} as Record<number, number>, totalH: DEFAULT_H, totalW: 200, offsetX: 0, row0: null as { left: number; width: number; top: number; height: number } | null }
    }

    // Collect visible bars: respect collapsed state
    const visibleIds = new Set<string>()
    function collectVisible(barId: string) {
      const bar = bars[barId]
      if (!bar) return
      visibleIds.add(barId)
      if (!bar.collapsed) {
        bar.children.forEach(cid => collectVisible(cid))
      }
    }
    rootIds.forEach(rid => collectVisible(rid))

    const visibleBars = allBarsArr.filter(b => visibleIds.has(b.id))

    // Compute row heights (max height per rowIndex)
    const rowH: Record<number, number> = {}
    visibleBars.forEach(b => {
      rowH[b.rowIndex] = Math.max(rowH[b.rowIndex] ?? DEFAULT_H, b.height)
    })

    // Compute row top positions — include empty rows between min and max
    // so that moving a bar to a lower row creates visible space
    const rowTops: Record<number, number> = {}
    const occupiedRows = Object.keys(rowH).map(Number).sort((a, b) => a - b)
    const minRow = occupiedRows[0] ?? 0
    const maxRow = occupiedRows[occupiedRows.length - 1] ?? 0
    let y = 0
    for (let r = minRow; r <= maxRow; r++) {
      rowTops[r] = y
      y += (rowH[r] ?? DEFAULT_H) + ROW_GAP
    }

    const totalH = Math.max(y - ROW_GAP, DEFAULT_H)
    const maxX = visibleBars.length > 0 ? Math.max(...visibleBars.map(b => b.x + b.width)) : 200
    const offsetX = 0
    const totalW = Math.max(maxX, 200)

    // Row-0 background strip
    const row0Bars = visibleBars.filter(b => b.rowIndex === 0)
    const row0 = row0Bars.length > 0 ? {
      left: Math.min(...row0Bars.map(b => b.x)),
      width: Math.max(...row0Bars.map(b => b.x + b.width)) - Math.min(...row0Bars.map(b => b.x)),
      top: rowTops[0] ?? 0,
      height: rowH[0] ?? DEFAULT_H,
    } : null

    return { allBars: visibleBars, visibleIds, rowTops, rowH, totalH, totalW, offsetX, row0 }
  }, [bars, rootIds])

  // ── Wires: recomputed every render to track grip-drag offset in real time ──
  const wires = useMemo(() => {
    // Build set of dragging IDs + offset
    const draggingIds = new Set<string>()
    let dragOffsetY = 0
    let dragSnappedRow = -1
    let dragRootId = ''
    if (gripDrag) {
      dragRootId = gripDrag.blockId
      collectSubtree(bars, gripDrag.blockId).forEach(sid => draggingIds.add(sid))
      dragOffsetY = gripDrag.offsetY
      dragSnappedRow = gripDrag.snappedRow
    }

    const result: { id: string; d: string; color: string }[] = []
    allBars.forEach(bar => {
      if (!bar.parentId) return
      const parent = bars[bar.parentId]
      if (!parent || !visibleIds.has(parent.id)) return

      // Wire break rule: only break when dragged ABOVE the parent row
      if (bar.id === dragRootId && dragSnappedRow < parent.rowIndex) return

      const px = parent.x + parent.width / 2
      let py = (rowTops[parent.rowIndex] ?? 0) + parent.height
      const cx = bar.x + bar.width / 2
      let cy = rowTops[bar.rowIndex] ?? 0

      // Shift wire endpoints when parent or child is being grip-dragged
      if (draggingIds.has(parent.id)) py += dragOffsetY
      if (draggingIds.has(bar.id)) cy += dragOffsetY

      const midY = (py + cy) / 2
      result.push({
        id: `${parent.id}-${bar.id}`,
        d: `M ${px} ${py} C ${px} ${midY}, ${cx} ${midY}, ${cx} ${cy}`,
        color: parent.color ?? '#5b8dd9',
      })
    })
    return result
  }, [allBars, bars, visibleIds, rowTops, gripDrag])

  const onContainerDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as Element).closest('[data-block]')) return
    collapseAllToggle()
  }, [collapseAllToggle])

  return (
    <div
      style={{ position: 'relative', width: totalW, height: totalH }}
      onDoubleClick={onContainerDoubleClick}
    >
      {/* ── Background strip for row 0 ── */}
      {row0 && (
        <div style={{
          position: 'absolute',
          left: row0.left, top: row0.top, width: row0.width, height: row0.height,
          background: 'rgba(80,120,255,0.13)',
          border: '1px solid rgba(100,150,255,0.28)',
          borderRadius: 14, pointerEvents: 'none', zIndex: 1,
        }} />
      )}

      {/* ── Wire layer ── */}
      {(wires.length > 0 || wireDrag) && (
        <svg style={{ position: 'absolute', left: 0, top: 0, width: totalW, height: totalH, overflow: 'visible', pointerEvents: 'none', zIndex: 0 }}>
          <defs />
          {wires.map(w => {
            const bright = lighten(w.color, 0.45)
            return (
              <path key={w.id} d={w.d} stroke={bright} strokeWidth="1.5" fill="none" strokeLinecap="round" />
            )
          })}
          {/* Temp wire while dragging from a port — only in the board that owns the block */}
          {wireDrag && bars[wireDrag.fromBlockId] && (() => {
            const sx = wireDrag.startX
            const sy = wireDrag.startY
            const ex = wireDrag.currentX
            const ey = wireDrag.currentY
            const midY = (sy + ey) / 2
            const d = `M ${sx} ${sy} C ${sx} ${midY}, ${ex} ${midY}, ${ex} ${ey}`
            return (
              <path key="temp-wire" d={d} stroke="rgba(80,220,120,0.85)" strokeWidth="2" fill="none" strokeLinecap="round" strokeDasharray="6 4" />
            )
          })()}
        </svg>
      )}

      {/* ── Blocks at their actual row positions ── */}
      {allBars.map(bar => {
        // If this block is part of the grip-drag subtree, apply the drag offset
        const dragOffset = (gripDrag && gripDragSubtree.has(bar.id)) ? gripDrag.offsetY : 0
        return (
          <NLEBlock
            key={bar.id}
            id={bar.id}
            top={(rowTops[bar.rowIndex] ?? 0) + dragOffset}
            blockHeight={bar.height}
            offsetX={offsetX}
            rowTops={rowTops}
            rowHeights={rowH}
          />
        )
      })}
    </div>
  )
}
