import React, { useRef, useCallback, useEffect, useState } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useBoardsStore } from '../../store/boardsStore'

interface Props {
  children: React.ReactNode
  initialCenterW?: number
  initialCenterH?: number
}

export const InfiniteCanvas: React.FC<Props> = ({ children, initialCenterW = 1000, initialCenterH = 300 }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const shiftPan = useCanvasStore(s => s.shiftPan)
  const zoomAtPoint = useCanvasStore(s => s.zoomAtPoint)
  const setPan = useCanvasStore(s => s.setPan)
  const nleRowHeight = useCanvasStore(s => s.nleRowHeight)

  const addFreeNode = useFreeNodeStore(s => s.addFreeNode)
  const updateFreeNode = useFreeNodeStore(s => s.updateFreeNode)
  const setFreeSelection = useFreeNodeStore(s => s.setFreeSelection)
  const clearFreeSelection = useFreeNodeStore(s => s.clearFreeSelection)
  const setFocusedBoard = useCanvasStore(s => s.setFocusedBoard)

  const isPanning = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })
  const spaceDown = useRef(false)
  const [spaceActive, setSpaceActive] = useState(false)
  const [addMenu, setAddMenu] = useState<{ sx: number; sy: number; cx: number; cy: number } | null>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const panRef = useRef(pan)
  panRef.current = pan

  // Rubber-band selection state (screen coords relative to container)
  const [rubberBand, setRubberBand] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null)
  const rubberBandRef = useRef<{ sx: number; sy: number; ex: number; ey: number } | null>(null)
  const rbStartCanvas = useRef<{ cx: number; cy: number } | null>(null)

  // Center on first launch only — skip if pan was restored from localStorage
  useEffect(() => {
    const saved = useCanvasStore.getState().pan
    if (saved.x !== 0 || saved.y !== 0) return
    const toolbarH = 40
    const canvasH = window.innerHeight - toolbarH
    setPan({
      x: Math.max(20, (window.innerWidth - initialCenterW) / 2),
      y: Math.round(canvasH * 0.18),
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Space key pan mode
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.target === document.body) {
        if (!spaceDown.current) { spaceDown.current = true; setSpaceActive(true) }
        e.preventDefault()
      }
      // Home key: reset zoom and pan to default
      if (e.code === 'Home' && e.target === document.body) {
        e.preventDefault()
        useCanvasStore.getState().setPan({ x: 200, y: 100 })
        useCanvasStore.getState().setZoom(0.35)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') { spaceDown.current = false; setSpaceActive(false) }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = containerRef.current!.getBoundingClientRect()
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    zoomAtPoint(factor, e.clientX - rect.left, e.clientY - rect.top)
  }, [zoomAtPoint])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Middle mouse or space+left-drag = pan
    if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      isPanning.current = true
      lastMouse.current = { x: e.clientX, y: e.clientY }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }
    // Left-click on bare canvas = rubber-band select
    if (e.button === 0) {
      const target = e.target as Element
      if (target.closest('[data-block],[data-board],[data-freenode]')) return
      setFocusedBoard(null)
      const rect = containerRef.current!.getBoundingClientRect()
      const relX = e.clientX - rect.left
      const relY = e.clientY - rect.top
      rbStartCanvas.current = {
        cx: (relX - panRef.current.x) / zoomRef.current,
        cy: (relY - panRef.current.y) / zoomRef.current,
      }
      const initial = { sx: relX, sy: relY, ex: relX, ey: relY }
      rubberBandRef.current = initial
      setRubberBand(initial)
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      clearFreeSelection()
      // Clear selection on ALL boards
      const allBoards = useBoardsStore.getState().boards
      for (const bid of Object.keys(allBoards)) {
        useBoardsStore.getState().clearSelection(bid)
      }
    }
  }, [clearFreeSelection])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (isPanning.current) {
      shiftPan(e.clientX - lastMouse.current.x, e.clientY - lastMouse.current.y)
      lastMouse.current = { x: e.clientX, y: e.clientY }
    } else if (rbStartCanvas.current) {
      const rect = containerRef.current!.getBoundingClientRect()
      const updated = rubberBandRef.current
        ? { ...rubberBandRef.current, ex: e.clientX - rect.left, ey: e.clientY - rect.top }
        : null
      rubberBandRef.current = updated
      setRubberBand(updated)
    }
  }, [shiftPan])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()

    // Check ALL elements at the drop point — use priority order:
    // blocks/cards > boards > free nodes > bare canvas
    const allEls = document.elementsFromPoint(e.clientX, e.clientY)

    // 1. NLE block bar (any zoom level that renders them)
    for (const el of allEls) {
      const block = el.closest('[data-block][data-id]') as HTMLElement | null
      if (block) {
        const barId = block.dataset.id!
        const boardId = block.dataset.boardId ?? 'primary'
        files.forEach(file => {
          const reader = new FileReader()
          reader.onload = () => {
            const b = useBoardsStore.getState().boards[boardId]
            const cur = b?.bars[barId]?.content.images ?? []
            useBoardsStore.getState().setContent(boardId, barId, { images: [...cur, reader.result as string] })
          }
          reader.readAsDataURL(file)
        })
        return
      }
    }

    // 2. Collapsed NLE card
    for (const el of allEls) {
      const card = el.closest('[data-nle-card]') as HTMLElement | null
      if (card) {
        const boardId = card.dataset.nleCard!
        files.forEach(file => {
          const reader = new FileReader()
          reader.onload = () => {
            const b = useBoardsStore.getState().boards[boardId]
            const rid = b?.rootIds[0]
            if (!rid) return
            const cur = b.bars[rid]?.content.images ?? []
            useBoardsStore.getState().setContent(boardId, rid, { images: [...cur, reader.result as string] })
          }
          reader.readAsDataURL(file)
        })
        return
      }
    }

    // 3. Board area (drop on board padding, not a specific block)
    for (const el of allEls) {
      const board = el.closest('[data-board]') as HTMLElement | null
      if (board) {
        const boardBlock = board.querySelector('[data-block][data-board-id]') as HTMLElement | null
        if (boardBlock) {
          const boardId = boardBlock.dataset.boardId ?? 'primary'
          const b = useBoardsStore.getState().boards[boardId]
          const rid = b?.rootIds[0]
          if (rid) {
            files.forEach(file => {
              const reader = new FileReader()
              reader.onload = () => {
                const cur = useBoardsStore.getState().boards[boardId]?.bars[rid]?.content.images ?? []
                useBoardsStore.getState().setContent(boardId, rid, { images: [...cur, reader.result as string] })
              }
              reader.readAsDataURL(file)
            })
            return
          }
        }
      }
    }

    // 4. Free node (only if nothing above matched)
    for (const el of allEls) {
      const freenode = el.closest('[data-freenode][data-id]') as HTMLElement | null
      if (freenode) {
        const nodeId = freenode.dataset.id!
        const file = files[0]
        const reader = new FileReader()
        reader.onload = () => {
          useFreeNodeStore.getState().updateFreeNode(nodeId, {
            type: 'image',
            imageUrl: reader.result as string,
            label: file.name.replace(/\.[^.]+$/, ''),
          })
        }
        reader.readAsDataURL(file)
        return
      }
    }

    // Dropped on bare canvas — create new image nodes
    const rect = containerRef.current!.getBoundingClientRect()
    const z = zoomRef.current
    const p = panRef.current
    files.forEach((file, i) => {
      const cx = (e.clientX - rect.left - p.x) / z + i * 220
      const cy = (e.clientY - rect.top - p.y) / z
      const nodeId = addFreeNode(cx, cy, 'image')
      const reader = new FileReader()
      reader.onload = () => {
        updateFreeNode(nodeId, { imageUrl: reader.result as string, label: file.name.replace(/\.[^.]+$/, '') })
      }
      reader.readAsDataURL(file)
    })
  }, [addFreeNode, updateFreeNode])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (isPanning.current) {
      isPanning.current = false
      return
    }
    if (rbStartCanvas.current) {
      const containerRect = containerRef.current!.getBoundingClientRect()
      const rb = rubberBandRef.current
      if (rb) {
        const selLeft   = containerRect.left + Math.min(rb.sx, rb.ex)
        const selRight  = containerRect.left + Math.max(rb.sx, rb.ex)
        const selTop    = containerRect.top  + Math.min(rb.sy, rb.ey)
        const selBottom = containerRect.top  + Math.max(rb.sy, rb.ey)
        const w = selRight - selLeft
        const h = selBottom - selTop
        if (w > 5 || h > 5) {
          const hits = (el: Element) => {
            const r = el.getBoundingClientRect()
            return r.left < selRight && r.right > selLeft && r.top < selBottom && r.bottom > selTop
          }
          // Group selected bars by their board
          const hitBlocks = Array.from(document.querySelectorAll('[data-block][data-id]'))
            .filter(hits)
          const perBoard = new Map<string, string[]>()
          hitBlocks.forEach(el => {
            const bid = (el as HTMLElement).dataset.boardId ?? 'primary'
            const id = (el as HTMLElement).dataset.id!
            if (!perBoard.has(bid)) perBoard.set(bid, [])
            perBoard.get(bid)!.push(id)
          })
          perBoard.forEach((ids, bid) => {
            useBoardsStore.getState().setSelection(bid, ids)
          })
          const nodeIds = Array.from(document.querySelectorAll('[data-freenode][data-id]'))
            .filter(hits).map(el => (el as HTMLElement).dataset.id!)
          if (nodeIds.length > 0) setFreeSelection(nodeIds)
        }
      }
      rbStartCanvas.current = null
      setRubberBand(null)
    }
  }, [setFreeSelection])

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: '#12131f',
        cursor: spaceActive ? 'grab' : 'default',
      }}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onContextMenu={e => {
        if ((e.target as Element).closest('[data-block],[data-board],[data-freenode]')) return
        e.preventDefault()
        const rect = containerRef.current!.getBoundingClientRect()
        const cx = (e.clientX - rect.left - pan.x) / zoom
        const cy = (e.clientY - rect.top - pan.y) / zoom
        setAddMenu({ sx: e.clientX, sy: e.clientY, cx, cy })
      }}
    >
      <DotGrid panX={pan.x} panY={pan.y} />

      {/* ── NLE row lines (behind everything, in canvas space) ── */}
      <div style={{
        position: 'absolute', left: 0, top: 0,
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: '0 0',
        pointerEvents: 'none',
        willChange: 'transform',
      }}>
        {Array.from({ length: 16 }, (_, i) => (
          <React.Fragment key={i}>
            {/* Row band fill (alternating) */}
            {i % 2 === 0 && (
              <div style={{
                position: 'absolute',
                left: -8000, width: 20000,
                top: i * nleRowHeight,
                height: nleRowHeight,
                background: 'rgba(255,255,255,0.008)',
              }} />
            )}
            {/* Row separator line */}
            <div style={{
              position: 'absolute',
              left: -8000, width: 20000,
              top: i * nleRowHeight,
              height: 1,
              background: i === 0 ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.03)',
            }} />
          </React.Fragment>
        ))}
      </div>

      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          willChange: 'transform',
        }}
      >
        {children}
      </div>

      <div style={{
        position: 'absolute',
        bottom: 12,
        right: 16,
        color: 'rgba(255,255,255,0.22)',
        fontSize: 11,
        fontFamily: 'monospace',
        userSelect: 'none',
        pointerEvents: 'none',
      }}>
        {Math.round(zoom * 100)}% · scroll to zoom · middle-drag or space+drag to pan · left-drag to select · right-click to add
      </div>

      {/* ── Rubber-band selection overlay ── */}
      {rubberBand && (
        <div style={{
          position: 'absolute',
          left: Math.min(rubberBand.sx, rubberBand.ex),
          top: Math.min(rubberBand.sy, rubberBand.ey),
          width: Math.abs(rubberBand.ex - rubberBand.sx),
          height: Math.abs(rubberBand.ey - rubberBand.sy),
          border: '1.5px solid rgba(120,170,255,0.8)',
          background: 'rgba(100,150,255,0.08)',
          borderRadius: 3,
          pointerEvents: 'none',
          zIndex: 200,
        }} />
      )}

      {/* ── Add-node context menu ── */}
      {addMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 900 }} onPointerDown={() => setAddMenu(null)} />
          <div style={{
            position: 'fixed',
            left: addMenu.sx, top: addMenu.sy,
            zIndex: 901,
            background: '#13141f',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            padding: '4px 0',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            minWidth: 160,
          }}>
            {[
              { label: '📝  Add note',    action: () => { addFreeNode(addMenu.cx, addMenu.cy, 'note');  setAddMenu(null) } },
              { label: '🖼  Add image',   action: () => { addFreeNode(addMenu.cx, addMenu.cy, 'image'); setAddMenu(null) } },
              { label: '─────────────', action: null },
              { label: '🎬  New VidBar', action: () => {
                const rowH = useCanvasStore.getState().nleRowHeight
                const nleRow = Math.max(0, Math.round(addMenu.cy / rowH))
                useBoardsStore.getState().createBoard(nleRow, addMenu.cx)
                setAddMenu(null)
              }},
            ].map((item, idx) => (
              item.action === null ? (
                <div key={idx} style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '3px 10px' }} />
              ) : (
                <div
                  key={item.label}
                  onPointerDown={e => { e.stopPropagation(); item.action!() }}
                  style={{ padding: '7px 14px', fontSize: 12, color: 'rgba(255,255,255,0.8)', cursor: 'pointer', borderRadius: 4, margin: '0 4px' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >{item.label}</div>
              )
            ))}
          </div>
        </>
      )}
    </div>
  )
}

const DotGrid: React.FC<{ panX: number; panY: number }> = ({ panX, panY }) => {
  const spacing = 40
  const ox = ((panX % spacing) + spacing) % spacing
  const oy = ((panY % spacing) + spacing) % spacing
  return (
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
      <defs>
        <pattern id="dot-grid" x={ox} y={oy} width={spacing} height={spacing} patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1.2" fill="rgba(120,120,180,0.22)" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#dot-grid)" />
    </svg>
  )
}
