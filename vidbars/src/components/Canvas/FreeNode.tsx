import React, { useState, useRef, useCallback, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { clampToNoParkZone } from '../../utils/nleZone'

interface Props { id: string }

export const FreeNode: React.FC<Props> = ({ id }) => {
  const node = useFreeNodeStore(s => s.nodes[id])
  const moveFreeNode = useFreeNodeStore(s => s.moveFreeNode)
  const resizeFreeNode = useFreeNodeStore(s => s.resizeFreeNode)
  const updateFreeNode = useFreeNodeStore(s => s.updateFreeNode)
  const deleteFreeNode = useFreeNodeStore(s => s.deleteFreeNode)
  const isSelected = useFreeNodeStore(s => s.selectedIds.includes(id))
  const setFreeSelection = useFreeNodeStore(s => s.setFreeSelection)
  const toggleFreeSelection = useFreeNodeStore(s => s.toggleFreeSelection)
  const zoom = useCanvasStore(s => s.zoom)

  const [isHovered, setIsHovered] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number } | null>(null)

  const renameRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const dragLastX = useRef(0)
  const dragLastY = useRef(0)
  const dragHasMoved = useRef(false)
  const resizeLastX = useRef(0)
  const resizeLastY = useRef(0)

  useEffect(() => { if (isRenaming) renameRef.current?.select() }, [isRenaming])

  // Drag the whole card — anything except textarea/input/button/[data-resize]
  const onNodeDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'BUTTON') return
    if ((e.target as Element).closest('[data-resize]')) return
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    dragLastX.current = e.clientX
    dragLastY.current = e.clientY
    dragHasMoved.current = false
    wrapperRef.current?.setPointerCapture(e.pointerId)
  }, [])

  const onNodeMove = useCallback((e: React.PointerEvent) => {
    if (!wrapperRef.current?.hasPointerCapture(e.pointerId)) return
    const dx = (e.clientX - dragLastX.current) / zoom
    const dy = (e.clientY - dragLastY.current) / zoom
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragHasMoved.current = true
    moveFreeNode(id, dx, dy)
    dragLastX.current = e.clientX
    dragLastY.current = e.clientY
  }, [id, moveFreeNode, zoom])

  const onNodeUp = useCallback((e: React.PointerEvent) => {
    if (!wrapperRef.current?.hasPointerCapture(e.pointerId)) return
    if (!dragHasMoved.current) {
      if (e.shiftKey) toggleFreeSelection(id)
      else setFreeSelection([id])
    }
    // If this is an image node, check all elements at point for a valid drop target
    const node = useFreeNodeStore.getState().nodes[id]
    if (node?.imageUrl && dragHasMoved.current) {
      wrapperRef.current!.style.pointerEvents = 'none'
      const allEls = document.elementsFromPoint(e.clientX, e.clientY)
      wrapperRef.current!.style.pointerEvents = ''
      // Priority: blocks > cards > boards (skip free nodes — that's us)
      for (const el of allEls) {
        const block = el.closest('[data-block][data-id]') as HTMLElement | null
        if (block) {
          const barId = block.dataset.id!
          const boardId = block.dataset.boardId ?? 'primary'
          const b = useBoardsStore.getState().boards[boardId]
          const cur = b?.bars[barId]?.content.images ?? []
          useBoardsStore.getState().setContent(boardId, barId, { images: [...cur, node.imageUrl] })
          useFreeNodeStore.getState().deleteFreeNode(id)
          return
        }
      }
      for (const el of allEls) {
        const card = el.closest('[data-nle-card]') as HTMLElement | null
        if (card) {
          const boardId = card.dataset.nleCard!
          const b = useBoardsStore.getState().boards[boardId]
          const firstRoot = b?.rootIds[0]
          if (firstRoot && b?.bars[firstRoot]) {
            const cur = b.bars[firstRoot].content.images ?? []
            useBoardsStore.getState().setContent(boardId, firstRoot, { images: [...cur, node.imageUrl] })
          }
          useFreeNodeStore.getState().deleteFreeNode(id)
          return
        }
      }
    }
    // No transfer happened — snap to row grid + clamp out of NLE no-park zone
    if (dragHasMoved.current) {
      const cur = useFreeNodeStore.getState().nodes[id]
      if (cur) {
        const clamped = clampToNoParkZone(cur.x, cur.y, cur.width, cur.height)
        if (clamped.x !== cur.x || clamped.y !== cur.y) {
          useFreeNodeStore.getState().updateFreeNode(id, { x: clamped.x, y: clamped.y })
        }
      }
    }
  }, [id, setFreeSelection, toggleFreeSelection])

  // Resize handle
  const onResizeDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    resizeLastX.current = e.clientX
    resizeLastY.current = e.clientY
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    resizeFreeNode(id, (e.clientX - resizeLastX.current) / zoom, (e.clientY - resizeLastY.current) / zoom)
    resizeLastX.current = e.clientX
    resizeLastY.current = e.clientY
  }, [id, resizeFreeNode, zoom])

  const commitRename = useCallback(() => {
    if (renameVal.trim()) updateFreeNode(id, { label: renameVal.trim() })
    setIsRenaming(false)
  }, [id, renameVal, updateFreeNode])


  if (!node) return null

  // Inverse-zoom scaling: keep header text and controls readable at any canvas zoom.
  // At zoom 0.12, a canvas-space value of X appears as X*0.12 on screen,
  // so we scale up by 1/zoom to maintain roughly constant screen-pixel sizes.
  const iz = 1 / zoom
  const headerH = 20 * iz
  const fontSize = 11 * iz               // ~11px on screen at any zoom
  const dotSize  = 5 * iz
  const pad      = 6 * iz
  const borderW  = Math.max(1, 2 / zoom)

  return (
    <div
      ref={wrapperRef}
      data-freenode="true"
      data-id={id}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        borderRadius: 10 / zoom,
        background: node.color,
        border: `${borderW}px solid rgba(255,255,255,${isHovered ? 0.18 : 0.08})`,
        boxShadow: isSelected
          ? `0 0 0 ${2.5 / zoom}px rgba(120,180,255,0.9), 0 ${8 / zoom}px ${32 / zoom}px rgba(0,0,0,0.55)`
          : isHovered ? `0 ${8 / zoom}px ${32 / zoom}px rgba(0,0,0,0.55)` : `0 ${2 / zoom}px ${12 / zoom}px rgba(0,0,0,0.4)`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'border-color 0.12s, box-shadow 0.12s',
        zIndex: isHovered ? 50 : 5,
        cursor: 'grab',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onPointerDown={onNodeDown}
      onPointerMove={onNodeMove}
      onPointerUp={onNodeUp}
      onContextMenu={e => {
        e.preventDefault(); e.stopPropagation()
        setNodeMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6 * iz,
        padding: `${pad * 0.6}px ${pad}px`,
        background: 'rgba(0,0,0,0.3)',
        borderBottom: `${borderW}px solid rgba(255,255,255,0.06)`,
        flexShrink: 0, height: headerH,
      }}>
        <div style={{ width: dotSize, height: dotSize, borderRadius: '50%', background: 'rgba(255,255,255,0.22)', flexShrink: 0 }} />

        {isRenaming ? (
          <input
            ref={renameRef}
            value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setIsRenaming(false) }}
            onPointerDown={e => e.stopPropagation()}
            style={{
              flex: 1, background: 'rgba(255,255,255,0.08)', border: `${borderW}px solid rgba(255,255,255,0.2)`,
              borderRadius: 4 / zoom, outline: 'none', color: '#fff',
              fontSize, fontWeight: 600, padding: `${2 * iz}px ${6 * iz}px`, fontFamily: 'inherit',
            }}
          />
        ) : (
          <span
            style={{
              flex: 1, color: 'rgba(255,255,255,0.65)', fontSize, fontWeight: 600,
              userSelect: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
            onDoubleClick={e => { e.stopPropagation(); setRenameVal(node.label); setIsRenaming(true) }}
          >{node.label}</span>
        )}
      </div>

      {/* ── Body ── */}
      {node.type === 'note' ? (
        <textarea
          value={node.text}
          onChange={e => updateFreeNode(id, { text: e.target.value })}
          onPointerDown={e => e.stopPropagation()}
          placeholder="Type a note…"
          style={{
            flex: 1, background: 'none', border: 'none', outline: 'none',
            color: 'rgba(255,255,255,0.8)',
            fontSize: 12 * iz,
            lineHeight: 1.55,
            padding: `${8 * iz}px ${pad}px ${28 * iz}px`,
            resize: 'none', fontFamily: 'inherit', cursor: 'text',
          }}
        />
      ) : (
        <div
          style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            position: 'relative', overflow: 'hidden',
          }}
          onPointerDown={e => e.stopPropagation()}
        >
          {node.imageUrl ? (
            <img src={node.imageUrl} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.18)', userSelect: 'none', pointerEvents: 'none' }}>
              <div style={{ fontSize: 22 * iz, marginBottom: 5 * iz, opacity: 0.5 }}>⬛</div>
              <div style={{ fontSize: 10 * iz }}>drop image here</div>
            </div>
          )}
        </div>
      )}

      {/* ── Resize handle — large corner zone, always present ── */}
      <div
        data-resize="true"
        style={{
          position: 'absolute', bottom: 0, right: 0,
          width: 40 * iz, height: 40 * iz,
          cursor: 'nwse-resize',
          zIndex: 20,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
          padding: `0 ${5 * iz}px ${5 * iz}px 0`,
        }}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
      >
        {/* Visual grip dots */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(3, ${3 * iz}px)`,
          gridTemplateRows: `repeat(3, ${3 * iz}px)`,
          gap: `${2 * iz}px`,
          opacity: isHovered ? 0.5 : 0.15,
          transition: 'opacity 0.12s',
        }}>
          {[...Array(9)].map((_, i) => (
            <div key={i} style={{
              width: 3 * iz, height: 3 * iz, borderRadius: '50%',
              background: 'rgba(255,255,255,0.9)',
              opacity: (i === 4 || i < 3) ? 0 : 1,
            }} />
          ))}
        </div>
      </div>

      {/* ── Context menu ── */}
      {nodeMenu && ReactDOM.createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={() => setNodeMenu(null)} />
          <div
            onPointerDown={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: Math.min(nodeMenu.x, window.innerWidth - 180),
              top: Math.min(nodeMenu.y, window.innerHeight - 200),
              width: 170, zIndex: 9999,
              background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
              padding: '5px 0', fontFamily: 'system-ui, sans-serif',
            }}
          >
            <div style={{ padding: '4px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: 4 }}>
              <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{node.label}</span>
            </div>
            {[
              { label: 'Rename', icon: '✏️', action: () => { setRenameVal(node.label); setIsRenaming(true); setNodeMenu(null) } },
              ...(node.imageUrl ? [{ label: 'Remove Image', icon: '🖼', action: () => { useUndoCoordinator.getState().checkpoint(); updateFreeNode(id, { imageUrl: null }); setNodeMenu(null) } }] : []),
              { label: 'Delete', icon: '🗑️', danger: true, action: () => { useUndoCoordinator.getState().checkpoint(); deleteFreeNode(id); setNodeMenu(null) } },
            ].map(item => (
              <button
                key={item.label}
                onClick={item.action}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  width: '100%', padding: '7px 14px',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: ('danger' in item && item.danger) ? '#f87171' : '#e2e8f0',
                  fontSize: 13, textAlign: 'left', borderRadius: 4,
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
