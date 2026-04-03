// NLELayout — multi-row bar rendering with parent-child wires
import React, { useMemo, useRef, useState, useCallback, useSyncExternalStore } from 'react'
import ReactDOM from 'react-dom'
import type { Bar } from '../../types/bar'
import { DEFAULT_H } from '../../utils/barConstants'
import { useCanvasStore } from '../../store/canvasStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useBoardCtx } from '../../contexts/BoardContext'
import { NLEBlock } from './NLEBlock'
import { ColorPickerPopup } from '../Bar/ColorPickerPopup'
import { gripDragState } from '../../utils/gripDragState'
import { wireDragState } from '../../utils/wireDragState'
import { collectSubtree } from '../../utils/barOps'
import { useUndoCoordinator } from '../../store/undoCoordinator'

const ROW_GAP = 40

export const NLELayout: React.FC = () => {
  const ctx = useBoardCtx()
  const { bars, rootIds, setColor, setContent, collapseAllToggle } = ctx

  const zoom = useCanvasStore(s => s.zoom)

  // Subscribe to drag states for real-time wire updates
  const gripDrag = useSyncExternalStore(gripDragState.subscribe, gripDragState.get)
  const wireDrag = useSyncExternalStore(wireDragState.subscribe, wireDragState.get)

  // Compute subtree of the grip-dragged block (so children move with parent)
  const gripDragSubtree = useMemo(() => {
    if (!gripDrag) return new Set<string>()
    return new Set(collectSubtree(bars, gripDrag.blockId))
  }, [gripDrag?.blockId, bars])

  const rootColor = rootIds.length > 0 ? (bars[rootIds[0]]?.color ?? '#5b8dd9') : '#5b8dd9'
  const [solidColorPicker, setSolidColorPicker] = useState<{ x: number; y: number } | null>(null)
  const [solidMenu, setSolidMenu] = useState<{ x: number; y: number } | null>(null)
  const solidDragLastX = useRef(0)

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

    const result: { id: string; d: string }[] = []
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
      })
    })
    return result
  }, [allBars, bars, visibleIds, rowTops, gripDrag])

  const onContainerDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as Element).closest('[data-block]')) return
    collapseAllToggle()
  }, [collapseAllToggle])

  // ── Low-zoom overview: solid block ──
  if (zoom < 0.3) {
    const rootBars = Object.values(bars).filter(b => b.rowIndex === 0)
    if (rootBars.length > 0) {
      const left   = Math.min(...rootBars.map(b => b.x + offsetX))
      const right  = Math.max(...rootBars.map(b => b.x + offsetX + b.width))
      const width  = right - left
      const height = rowH[0] ?? DEFAULT_H
      const onSolidDown = (e: React.PointerEvent) => {
        if (e.button !== 0) return
        e.stopPropagation()
        useUndoCoordinator.getState().checkpoint()
        solidDragLastX.current = e.clientX
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }
      const onSolidMove = (e: React.PointerEvent) => {
        if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
        const dx = (e.clientX - solidDragLastX.current) / zoom
        solidDragLastX.current = e.clientX
        if (ctx.boardId === 'primary') {
          const cs = useCanvasStore.getState()
          useCanvasStore.getState().setBoardPos({ x: cs.boardPos.x + dx, y: cs.boardPos.y })
        } else {
          const board = useBoardsStore.getState().boards[ctx.boardId]
          if (board) useBoardsStore.getState().setBoardNlePos(ctx.boardId, board.nleRow, board.nleX + dx)
        }
      }
      const firstImg = rootBars.find(b => b.content?.images?.length > 0)?.content.images[0] ?? null
      return (
        <div style={{ position: 'relative', width: totalW, height: totalH }}>
          <div
            data-block="true"
            data-id={rootIds[0]}
            data-board-id={ctx.boardId}
            style={{
              position: 'absolute', left, top: 0, width, height,
              borderRadius: 12,
              background: firstImg
                ? `linear-gradient(160deg, ${rootColor}cc 0%, ${rootColor}aa 100%)`
                : rootColor,
              border: '1.5px solid rgba(255,255,255,0.25)',
              boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
              cursor: 'grab',
              overflow: 'hidden',
            }}
            onPointerDown={onSolidDown}
            onPointerMove={onSolidMove}
            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setSolidMenu({ x: e.clientX, y: e.clientY }) }}
          >
            {firstImg && (
              <div style={{
                position: 'absolute', inset: 0,
                backgroundImage: `url(${firstImg})`,
                backgroundSize: 'cover', backgroundPosition: 'center',
                opacity: 0.7, borderRadius: 12,
              }} />
            )}
          </div>
          {solidColorPicker && (
            <ColorPickerPopup
              color={rootColor}
              anchorX={solidColorPicker.x}
              anchorY={solidColorPicker.y}
              onChange={c => rootIds.forEach(rid => setColor(rid, c))}
              onClose={() => setSolidColorPicker(null)}
            />
          )}
          {solidMenu && ReactDOM.createPortal(
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={() => setSolidMenu(null)} />
              <div
                onPointerDown={e => e.stopPropagation()}
                style={{
                  position: 'fixed',
                  left: Math.min(solidMenu.x, window.innerWidth - 180),
                  top: Math.min(solidMenu.y, window.innerHeight - 160),
                  width: 170, zIndex: 9999,
                  background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
                  padding: '5px 0', fontFamily: 'system-ui, sans-serif',
                }}
              >
                {[
                  { label: 'Set Color', icon: '🎨', action: () => { setSolidColorPicker({ x: solidMenu.x, y: solidMenu.y }); setSolidMenu(null) } },
                  ...(firstImg ? [{ label: 'Remove Image', icon: '🖼', action: () => {
                    useUndoCoordinator.getState().checkpoint()
                    rootIds.forEach(rid => setContent(rid, { images: [] }))
                    setSolidMenu(null)
                  }}] : []),
                ].map(item => (
                  <button
                    key={item.label}
                    onClick={item.action}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 9,
                      width: '100%', padding: '7px 14px',
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: '#e2e8f0', fontSize: 13, textAlign: 'left', borderRadius: 4,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                  >
                    <span style={{ fontSize: 14, width: 18, textAlign: 'center' }}>{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </div>
            </>,
            document.body
          )}
        </div>
      )
    }
    return <div style={{ position: 'relative', width: totalW, height: totalH }} />
  }

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
          <defs>
            <filter id="wire-glow">
              <feGaussianBlur stdDeviation="1.5" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          {wires.map(w => (
            <g key={w.id}>
              <path d={w.d} stroke="rgba(140,170,255,0.18)" strokeWidth="4" fill="none" filter="url(#wire-glow)" />
              <path d={w.d} stroke="rgba(160,185,255,0.45)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
            </g>
          ))}
          {/* Temp wire while dragging from a port — only in the board that owns the block */}
          {wireDrag && bars[wireDrag.fromBlockId] && (() => {
            const sx = wireDrag.startX
            const sy = wireDrag.startY
            const ex = wireDrag.currentX
            const ey = wireDrag.currentY
            const midY = (sy + ey) / 2
            const d = `M ${sx} ${sy} C ${sx} ${midY}, ${ex} ${midY}, ${ex} ${ey}`
            return (
              <g key="temp-wire">
                <path d={d} stroke="rgba(80,220,120,0.25)" strokeWidth="4" fill="none" filter="url(#wire-glow)" />
                <path d={d} stroke="rgba(80,220,120,0.85)" strokeWidth="2" fill="none" strokeLinecap="round" strokeDasharray="6 4" />
              </g>
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
