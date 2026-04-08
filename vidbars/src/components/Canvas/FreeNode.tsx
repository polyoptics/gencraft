import React, { useState, useRef, useCallback, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import type { FreeNodeData, TextStyle } from '../../store/freeNodeStore'
import { DEFAULT_TEXT_STYLE } from '../../store/freeNodeStore'
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
  const textEditTrigger = useRef(0)

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
    // Transfer node content to a bar/card on drop
    const node = useFreeNodeStore.getState().nodes[id]
    if (dragHasMoved.current && node) {
      const hasMedia = !!node.imageUrl
      const hasText = !!(node.text && (node.type === 'text' || node.type === 'note'))
      if (hasMedia || hasText) {
        wrapperRef.current!.style.pointerEvents = 'none'
        const allEls = document.elementsFromPoint(e.clientX, e.clientY)
        wrapperRef.current!.style.pointerEvents = ''

        const mediaType = node.mediaType ?? 'image'

        // Helper: transfer to a specific bar
        const transferToBar = (boardId: string, barId: string) => {
          if (hasMedia && node.imageUrl) {
            const curMedia = useBoardsStore.getState().boards[boardId]?.bars[barId]?.content.media ?? []
            useBoardsStore.getState().setContent(boardId, barId, { media: [...curMedia, { url: node.imageUrl, type: mediaType }] })
          }
          if (hasText) {
            const curText = useBoardsStore.getState().boards[boardId]?.bars[barId]?.content.text ?? ''
            const newText = curText ? curText + '\n' + node.text : node.text
            const patch: Record<string, any> = { text: newText }
            // Carry text formatting through if this node has a textStyle
            if (node.textStyle) {
              patch.textStyle = { ...node.textStyle }
            }
            useBoardsStore.getState().setContent(boardId, barId, patch)
          }
          useFreeNodeStore.getState().deleteFreeNode(id)
        }

        // Priority: blocks > cards > boards
        for (const el of allEls) {
          const block = el.closest('[data-block][data-id]') as HTMLElement | null
          if (block) {
            transferToBar(block.dataset.boardId ?? 'primary', block.dataset.id!)
            return
          }
        }
        for (const el of allEls) {
          const card = el.closest('[data-nle-card]') as HTMLElement | null
          if (card) {
            const boardId = card.dataset.nleCard!
            const b = useBoardsStore.getState().boards[boardId]
            const firstRoot = b?.rootIds[0]
            if (firstRoot) transferToBar(boardId, firstRoot)
            return
          }
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
      onDoubleClick={e => {
        if (dragHasMoved.current) return
        // Header label has its own dblclick handler for rename.
        // For text nodes, double-click on body → trigger text edit via ref.
        if (node.type === 'text' && !isRenaming) {
          const onHeader = (e.target as HTMLElement).closest('[data-freenode-header]')
          if (!onHeader) {
            textEditTrigger.current++
            // force re-render to pick up the new trigger value
            setFreeSelection([id])
          }
        }
      }}
      onContextMenu={e => {
        e.preventDefault(); e.stopPropagation()
        setNodeMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {/* ── Header ── */}
      <div data-freenode-header style={{
        display: 'flex', alignItems: 'center', gap: 6 * iz,
        padding: `${pad * 0.6}px ${pad}px`,
        background: 'rgba(0,0,0,0.3)',
        borderBottom: `${borderW}px solid rgba(255,255,255,0.06)`,
        flexShrink: 0, height: headerH,
      }}>
        {node.type === 'text' ? (
          <span style={{ fontSize: fontSize * 0.9, fontWeight: 800, color: 'rgba(255,255,255,0.4)', lineHeight: 1, flexShrink: 0 }}>T</span>
        ) : node.type === 'video' ? (
          <span style={{ fontSize: fontSize * 0.75, color: 'rgba(255,255,255,0.35)', lineHeight: 1, flexShrink: 0 }}>▶</span>
        ) : node.type === 'audio' ? (
          <span style={{ fontSize: fontSize * 0.75, color: 'rgba(255,255,255,0.35)', lineHeight: 1, flexShrink: 0 }}>♪</span>
        ) : (
          <div style={{ width: dotSize, height: dotSize, borderRadius: '50%', background: 'rgba(255,255,255,0.22)', flexShrink: 0 }} />
        )}

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
      <FreeNodeBody node={node} id={id} iz={iz} pad={pad} updateFreeNode={updateFreeNode} editTrigger={textEditTrigger.current} />

      {/* ── Text format toolbar (shown when text node is selected) ── */}
      {node.type === 'text' && isSelected && (
        <TextFormatToolbar node={node} id={id} updateFreeNode={updateFreeNode} wrapperRef={wrapperRef} />
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

// ── Body renderer for each node type ──

const FreeNodeBody: React.FC<{
  node: FreeNodeData
  id: string
  iz: number
  pad: number
  updateFreeNode: (id: string, patch: Partial<FreeNodeData>) => void
  editTrigger: number
}> = ({ node, id, iz, pad, updateFreeNode, editTrigger }) => {
  const [isEditing, setIsEditing] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const lastTrigger = useRef(0)

  useEffect(() => { if (isEditing) textRef.current?.focus() }, [isEditing])

  // Wrapper double-click triggers edit mode for text nodes
  useEffect(() => {
    if (editTrigger > lastTrigger.current && node.type === 'text') {
      setIsEditing(true)
    }
    lastTrigger.current = editTrigger
  }, [editTrigger, node.type])

  // ── Note type: always-editable textarea ──
  if (node.type === 'note') {
    return (
      <textarea
        value={node.text}
        onChange={e => updateFreeNode(id, { text: e.target.value })}
        onPointerDown={e => e.stopPropagation()}
        placeholder="Type a note…"
        style={{
          flex: 1, background: 'none', border: 'none', outline: 'none',
          color: 'rgba(255,255,255,0.8)',
          fontSize: 12 * iz, lineHeight: 1.55,
          padding: `${8 * iz}px ${pad}px ${28 * iz}px`,
          resize: 'none', fontFamily: 'inherit', cursor: 'text',
        }}
      />
    )
  }

  // ── Text type: view/edit toggle with formatting ──
  if (node.type === 'text') {
    const ts = { ...DEFAULT_TEXT_STYLE, ...node.textStyle }
    const bgRgba = hexToRgba(ts.bgColor, ts.bgOpacity)

    // Damped zoom: text scales with node but clamped to stay readable.
    // screenPx = fontSize * zoom  →  clamp to [8, 60] screen-px  →  convert back to canvas-space.
    const curZoom = 1 / iz
    const screenPx = ts.fontSize * curZoom
    const clampedScreenPx = Math.max(8, Math.min(60, screenPx))
    const renderFontSize = clampedScreenPx / curZoom
    const renderPad = Math.max(4, 6 * iz * Math.min(1, curZoom * 2))

    if (isEditing) {
      return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <textarea
            ref={textRef}
            value={node.text}
            onChange={e => updateFreeNode(id, { text: e.target.value })}
            onPointerDown={e => e.stopPropagation()}
            onBlur={() => setIsEditing(false)}
            onKeyDown={e => { if (e.key === 'Escape') setIsEditing(false) }}
            placeholder="Type text content…"
            style={{
              flex: 1, background: bgRgba, border: 'none', outline: 'none',
              color: ts.color,
              fontSize: renderFontSize, lineHeight: 1.55,
              fontWeight: ts.bold ? 700 : 400,
              fontStyle: ts.italic ? 'italic' : 'normal',
              textAlign: ts.align,
              padding: renderPad,
              resize: 'none', fontFamily: 'inherit', cursor: 'text',
              wordBreak: 'break-word',
            }}
          />
        </div>
      )
    }
    return (
      <div
        style={{
          flex: 1, padding: renderPad,
          background: bgRgba,
          color: node.text ? ts.color : 'rgba(255,255,255,0.25)',
          fontSize: renderFontSize, lineHeight: 1.55,
          fontWeight: ts.bold ? 700 : 400,
          fontStyle: ts.italic ? 'italic' : 'normal',
          textAlign: ts.align,
          whiteSpace: 'pre-wrap', overflow: 'hidden',
          wordBreak: 'break-word',
          cursor: 'pointer',
          display: 'flex', flexDirection: 'column',
          justifyContent: ts.vAlign === 'middle' ? 'center' : ts.vAlign === 'bottom' ? 'flex-end' : 'flex-start',
        }}
      >
        <div>{node.text || 'Double-click to edit…'}</div>
      </div>
    )
  }

  // ── Video type: image with play overlay ──
  if (node.type === 'video') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}
           onPointerDown={e => e.stopPropagation()}>
        {node.imageUrl ? (
          <>
            <img src={node.imageUrl} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            {/* Play button overlay */}
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,0,0,0.25)',
            }}>
              <div style={{
                width: 40 * iz, height: 40 * iz, borderRadius: '50%',
                background: 'rgba(0,0,0,0.6)', border: `${2 * iz}px solid rgba(255,255,255,0.5)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{
                  width: 0, height: 0,
                  borderTop: `${8 * iz}px solid transparent`,
                  borderBottom: `${8 * iz}px solid transparent`,
                  borderLeft: `${14 * iz}px solid rgba(255,255,255,0.9)`,
                  marginLeft: 3 * iz,
                }} />
              </div>
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.25)', pointerEvents: 'none' }}>
            <div style={{ fontSize: 28 * iz, marginBottom: 4 * iz }}>▶</div>
            <div style={{ fontSize: 10 * iz }}>drop video here</div>
          </div>
        )}
      </div>
    )
  }

  // ── Audio type: waveform skeleton + transport ──
  if (node.type === 'audio') {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: `${6 * iz}px ${pad}px`, gap: 4 * iz }}
           onPointerDown={e => e.stopPropagation()}>
        {/* Filename */}
        <div style={{ fontSize: 10 * iz, color: 'rgba(255,255,255,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.label || 'Audio'}
        </div>
        {/* Fake waveform */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 1 * iz, minHeight: 24 * iz }}>
          {Array.from({ length: 40 }, (_, i) => {
            const h = (Math.sin(i * 0.7) * 0.4 + 0.5 + Math.sin(i * 1.9) * 0.2) * 100
            return (
              <div key={i} style={{
                flex: 1, height: `${Math.max(8, h)}%`,
                background: node.imageUrl ? 'rgba(100,200,255,0.5)' : 'rgba(255,255,255,0.15)',
                borderRadius: 1 * iz,
              }} />
            )
          })}
        </div>
        {/* Transport controls */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 * iz, padding: `${2 * iz}px 0` }}>
          <div style={{ fontSize: 10 * iz, color: 'rgba(255,255,255,0.35)', cursor: 'pointer' }}>⏮</div>
          <div style={{
            width: 22 * iz, height: 22 * iz, borderRadius: '50%',
            background: 'rgba(255,255,255,0.1)', border: `${1.5 * iz}px solid rgba(255,255,255,0.25)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}>
            <div style={{
              width: 0, height: 0,
              borderTop: `${4 * iz}px solid transparent`,
              borderBottom: `${4 * iz}px solid transparent`,
              borderLeft: `${7 * iz}px solid rgba(255,255,255,0.7)`,
              marginLeft: 2 * iz,
            }} />
          </div>
          <div style={{ fontSize: 10 * iz, color: 'rgba(255,255,255,0.35)', cursor: 'pointer' }}>⏭</div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 9 * iz, color: 'rgba(255,255,255,0.3)' }}>0:00 / 0:00</div>
        </div>
      </div>
    )
  }

  // ── Image type (default) ──
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}
         onPointerDown={e => e.stopPropagation()}>
      {node.imageUrl ? (
        <img src={node.imageUrl} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.18)', pointerEvents: 'none' }}>
          <div style={{ fontSize: 22 * iz, marginBottom: 5 * iz, opacity: 0.5 }}>⬛</div>
          <div style={{ fontSize: 10 * iz }}>drop image here</div>
        </div>
      )}
    </div>
  )
}

// ── Helpers ──

function hexToRgba(hex: string, opacity: number): string {
  const n = parseInt(hex.replace('#', ''), 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return `rgba(${r},${g},${b},${opacity})`
}

// ── Text Format Toolbar (portalled above the node) ──

const FONT_SIZES = [8, 10, 12, 14, 18, 24, 32, 48, 64, 96]
const PRESET_COLORS = ['#ffffff', '#e2e8f0', '#fbbf24', '#f87171', '#34d399', '#60a5fa', '#a78bfa', '#fb923c']
const PRESET_BG_COLORS = ['#000000', '#1e1b4b', '#1e3a2f', '#3b1520', '#1e293b', '#transparent']

const TextFormatToolbar: React.FC<{
  node: FreeNodeData
  id: string
  updateFreeNode: (id: string, patch: Partial<FreeNodeData>) => void
  wrapperRef: React.RefObject<HTMLDivElement | null>
}> = ({ node, id, updateFreeNode, wrapperRef }) => {
  const zoom = useCanvasStore(s => s.zoom)
  const pan = useCanvasStore(s => s.pan)
  const [showPopup, setShowPopup] = useState<'text' | 'bg' | 'hAlign' | 'vAlign' | null>(null)

  const ts = { ...DEFAULT_TEXT_STYLE, ...node.textStyle }
  const setStyle = (patch: Partial<TextStyle>) => {
    updateFreeNode(id, { textStyle: { ...ts, ...patch } })
  }

  // Position toolbar above the node in screen coordinates
  const rect = wrapperRef.current?.getBoundingClientRect()
  if (!rect) return null

  const toolbarLeft = rect.left
  const toolbarTop = rect.top - 38

  const btnStyle = (active?: boolean): React.CSSProperties => ({
    background: active ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)',
    border: active ? '1px solid rgba(255,255,255,0.3)' : '1px solid rgba(255,255,255,0.08)',
    borderRadius: 5,
    color: active ? '#fff' : 'rgba(255,255,255,0.6)',
    fontSize: 12, fontWeight: active ? 700 : 500,
    padding: '2px 7px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 24, height: 26,
    transition: 'all 0.1s',
  })

  const sepStyle: React.CSSProperties = {
    width: 1, height: 18, background: 'rgba(255,255,255,0.08)', margin: '0 3px', flexShrink: 0,
  }

  return ReactDOM.createPortal(
    <div
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: Math.max(4, Math.min(toolbarLeft, window.innerWidth - 460)),
        top: Math.max(4, toolbarTop),
        zIndex: 10000,
        display: 'flex', alignItems: 'center', gap: 3,
        background: '#1a1b2e',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 8, padding: '4px 6px',
        boxShadow: '0 8px 30px rgba(0,0,0,0.7)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Font size */}
      <button style={btnStyle()} onClick={() => {
        const cur = ts.fontSize
        const prev = FONT_SIZES.filter(s => s < cur).pop() ?? FONT_SIZES[0]
        setStyle({ fontSize: prev })
      }}>−</button>
      <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, minWidth: 22, textAlign: 'center', userSelect: 'none' }}>{ts.fontSize}</span>
      <button style={btnStyle()} onClick={() => {
        const cur = ts.fontSize
        const next = FONT_SIZES.find(s => s > cur) ?? FONT_SIZES[FONT_SIZES.length - 1]
        setStyle({ fontSize: next })
      }}>+</button>

      <div style={sepStyle} />

      {/* Bold / Italic */}
      <button style={{ ...btnStyle(ts.bold), fontWeight: 800, fontSize: 13 }} onClick={() => setStyle({ bold: !ts.bold })}>B</button>
      <button style={{ ...btnStyle(ts.italic), fontStyle: 'italic', fontSize: 13 }} onClick={() => setStyle({ italic: !ts.italic })}>I</button>

      <div style={sepStyle} />

      {/* Horizontal alignment — popup */}
      <div style={{ position: 'relative' }}>
        <button
          style={btnStyle(showPopup === 'hAlign')}
          onClick={() => setShowPopup(showPopup === 'hAlign' ? null : 'hAlign')}
          title="Horizontal align"
        >
          {hAlignIcons[ts.align]}
        </button>
        {showPopup === 'hAlign' && (
          <AlignPopup
            options={[
              { value: 'left', label: 'Left', icon: hAlignIcons.left },
              { value: 'center', label: 'Center', icon: hAlignIcons.center },
              { value: 'right', label: 'Right', icon: hAlignIcons.right },
            ]}
            selected={ts.align}
            onSelect={v => { setStyle({ align: v as any }); setShowPopup(null) }}
            onClose={() => setShowPopup(null)}
          />
        )}
      </div>

      {/* Vertical alignment — popup */}
      <div style={{ position: 'relative' }}>
        <button
          style={btnStyle(showPopup === 'vAlign')}
          onClick={() => setShowPopup(showPopup === 'vAlign' ? null : 'vAlign')}
          title="Vertical align"
        >
          {vAlignIcons[ts.vAlign]}
        </button>
        {showPopup === 'vAlign' && (
          <AlignPopup
            options={[
              { value: 'top', label: 'Top', icon: vAlignIcons.top },
              { value: 'middle', label: 'Middle', icon: vAlignIcons.middle },
              { value: 'bottom', label: 'Bottom', icon: vAlignIcons.bottom },
            ]}
            selected={ts.vAlign}
            onSelect={v => { setStyle({ vAlign: v as any }); setShowPopup(null) }}
            onClose={() => setShowPopup(null)}
          />
        )}
      </div>

      <div style={sepStyle} />

      {/* Text color */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'text'), gap: 4, padding: '2px 6px' }}
          onClick={() => setShowPopup(showPopup === 'text' ? null : 'text')}
          title="Text color"
        >
          <span style={{ fontSize: 13, fontWeight: 700 }}>A</span>
          <div style={{ width: 14, height: 4, borderRadius: 1, background: ts.color, border: '1px solid rgba(255,255,255,0.15)' }} />
        </button>
        {showPopup === 'text' && (
          <ColorSwatchPopup
            colors={PRESET_COLORS}
            selected={ts.color}
            onSelect={c => { setStyle({ color: c }); setShowPopup(null) }}
            onClose={() => setShowPopup(null)}
          />
        )}
      </div>

      {/* Background color + opacity */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'bg'), gap: 4, padding: '2px 6px' }}
          onClick={() => setShowPopup(showPopup === 'bg' ? null : 'bg')}
          title="Background"
        >
          <div style={{
            width: 16, height: 14, borderRadius: 3,
            background: ts.bgOpacity > 0 ? hexToRgba(ts.bgColor, ts.bgOpacity) : 'linear-gradient(135deg, rgba(255,255,255,0.1) 45%, transparent 45%, transparent 55%, rgba(255,255,255,0.1) 55%)',
            border: '1px solid rgba(255,255,255,0.15)',
          }} />
        </button>
        {showPopup === 'bg' && (
          <BgPickerPopup
            bgColor={ts.bgColor}
            bgOpacity={ts.bgOpacity}
            onColorSelect={c => setStyle({ bgColor: c })}
            onOpacityChange={o => setStyle({ bgOpacity: o })}
            onClose={() => setShowPopup(null)}
          />
        )}
      </div>
    </div>,
    document.body
  )
}

// ── Alignment icons ──

const hAlignIcons: Record<string, React.ReactNode> = {
  left: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 2h12M1 5h8M1 8h10M1 11h6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
  center: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 2h12M3 5h8M2 8h10M4 11h6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
  right: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 2h12M5 5h8M3 8h10M7 11h6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
}

const vAlignIcons: Record<string, React.ReactNode> = {
  top: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 1h12M4 4h6M3 7h8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
  middle: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M4 3h6M3 7h8M4 11h6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
  bottom: <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7h8M4 10h6M1 13h12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>,
}

// ── Alignment popup (shared for both h and v) ──

const AlignPopup: React.FC<{
  options: { value: string; label: string; icon: React.ReactNode }[]
  selected: string
  onSelect: (v: string) => void
  onClose: () => void
}> = ({ options, selected, onSelect, onClose }) => (
  <div
    onPointerDown={e => e.stopPropagation()}
    style={{
      position: 'absolute', top: 32, left: -4, zIndex: 10001,
      background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
      display: 'flex', gap: 2,
    }}
  >
    {options.map(o => (
      <button
        key={o.value}
        onClick={() => onSelect(o.value)}
        title={o.label}
        style={{
          background: o.value === selected ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.03)',
          border: o.value === selected ? '1px solid rgba(255,255,255,0.3)' : '1px solid rgba(255,255,255,0.06)',
          borderRadius: 5, color: o.value === selected ? '#fff' : 'rgba(255,255,255,0.5)',
          width: 28, height: 28, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 0,
        }}
      >
        {o.icon}
      </button>
    ))}
  </div>
)

// ── Color swatch popup ──
const ColorSwatchPopup: React.FC<{
  colors: string[]
  selected: string
  onSelect: (c: string) => void
  onClose: () => void
}> = ({ colors, selected, onSelect, onClose }) => (
  <div
    onPointerDown={e => e.stopPropagation()}
    style={{
      position: 'absolute', top: 32, left: -4, zIndex: 10001,
      background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 8, padding: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4,
      width: 120,
    }}
  >
    {colors.map(c => (
      <button
        key={c}
        onClick={() => onSelect(c)}
        style={{
          width: 24, height: 24, borderRadius: 5,
          background: c, border: c === selected ? '2px solid #fff' : '1px solid rgba(255,255,255,0.15)',
          cursor: 'pointer', padding: 0,
        }}
      />
    ))}
    {/* Custom color input */}
    <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
      <input
        type="color"
        value={selected}
        onChange={e => onSelect(e.target.value)}
        style={{ width: 24, height: 24, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
      />
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>Custom</span>
    </label>
  </div>
)

// ── Background color + opacity popup ──
const BgPickerPopup: React.FC<{
  bgColor: string
  bgOpacity: number
  onColorSelect: (c: string) => void
  onOpacityChange: (o: number) => void
  onClose: () => void
}> = ({ bgColor, bgOpacity, onColorSelect, onOpacityChange, onClose }) => (
  <div
    onPointerDown={e => e.stopPropagation()}
    style={{
      position: 'absolute', top: 32, right: -4, zIndex: 10001,
      background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 8, padding: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
      width: 150,
    }}
  >
    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>Background Color</div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginBottom: 8 }}>
      {['#000000', '#1e1b4b', '#1e3a2f', '#3b1520', '#1e293b', '#2d1b0e', '#1a1a1a', '#0f172a'].map(c => (
        <button
          key={c}
          onClick={() => onColorSelect(c)}
          style={{
            width: 24, height: 24, borderRadius: 5,
            background: c, border: c === bgColor ? '2px solid #fff' : '1px solid rgba(255,255,255,0.15)',
            cursor: 'pointer', padding: 0,
          }}
        />
      ))}
    </div>
    <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
      <input
        type="color"
        value={bgColor}
        onChange={e => onColorSelect(e.target.value)}
        style={{ width: 24, height: 24, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
      />
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>Custom</span>
    </label>
    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 6, marginBottom: 4 }}>Opacity</div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type="range"
        min={0} max={1} step={0.05}
        value={bgOpacity}
        onChange={e => onOpacityChange(parseFloat(e.target.value))}
        onPointerDown={e => e.stopPropagation()}
        style={{ flex: 1, height: 4, accentColor: '#60a5fa', cursor: 'pointer' }}
      />
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', minWidth: 28, textAlign: 'right' }}>
        {Math.round(bgOpacity * 100)}%
      </span>
    </div>
    {/* Preview */}
    <div style={{
      marginTop: 6, height: 20, borderRadius: 4,
      background: hexToRgba(bgColor, bgOpacity),
      border: '1px solid rgba(255,255,255,0.08)',
    }} />
  </div>
)
