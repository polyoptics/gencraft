import React, { useRef, useState, useMemo, useCallback } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useNLEViewerStore } from '../../store/nleViewerStore'
import { NLE_HEADER_CANVAS_H } from './NLETimelineHeader'
import { computeGroupLayout, getRowY } from '../../utils/nleRows'
import { RenameInput } from '../UI/RenameInput'

interface Frame {
  id: string
  dataUrl: string | null
  label: string
}

interface GenerationResult {
  id: string
  thumbnail: string | null
  timestamp: string
  duration: number
  model: string
}

const APP_TOOLBAR_H   = 38
const NLE_HEADER_GAP  = 2
const BOARD_PADDING_X = 20
const TOOLS_W         = 72

interface Props {
  /** Either a real group id OR a single-board scope via `board:<id>` */
  scopeKey: string
}

const sel: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  color: 'rgba(255,255,255,0.75)',
  fontSize: 12,
  padding: '3px 8px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  outline: 'none',
}

const NLEGroupViewer: React.FC<Props> = ({ scopeKey }) => {
  const isBoardScope = scopeKey.startsWith('board:')
  const singleBoardId = isBoardScope ? scopeKey.slice('board:'.length) : null
  const groupId = isBoardScope ? '' : scopeKey
  const isOpen       = useNLEViewerStore(s => s.openGroupIds.has(scopeKey))
  const onClose      = useCallback(() => useNLEViewerStore.getState().close(scopeKey), [scopeKey])
  const groups       = useBoardsStore(s => s.groups)
  const boards       = useBoardsStore(s => s.boards)
  const pan          = useCanvasStore(s => s.pan)
  const zoom         = useCanvasStore(s => s.zoom)
  const zoomAtPoint  = useCanvasStore(s => s.zoomAtPoint)
  const shiftPan     = useCanvasStore(s => s.shiftPan)

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    zoomAtPoint(factor, e.clientX, e.clientY - APP_TOOLBAR_H)
  }, [zoomAtPoint])

  const panLast = useRef({ x: 0, y: 0 })
  const onPanDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 1) return
    e.preventDefault(); e.stopPropagation()
    panLast.current = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])
  const onPanMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    shiftPan(e.clientX - panLast.current.x, e.clientY - panLast.current.y)
    panLast.current = { x: e.clientX, y: e.clientY }
  }, [shiftPan])
  const onPanUp = useCallback((_e: React.PointerEvent) => {}, [])

  const [firstFrame, setFirstFrame]       = useState<string | null>(null)
  const [lastFrame, setLastFrame]         = useState<string | null>(null)
  const [keyframes, setKeyframes]         = useState<Frame[]>([])
  const [duration, setDuration]           = useState(5)
  const [model, setModel]                 = useState<'kling' | 'luma' | 'runway'>('kling')
  const [generating, setGenerating]       = useState(false)
  const [activeFrameId, setActiveFrameId] = useState<string>('first')
  const [framesOpen, setFramesOpen]       = useState(true)
  const [history, setHistory]             = useState<GenerationResult[]>([])
  const [renaming, setRenaming]           = useState(false)
  const [renameVal, setRenameVal]         = useState('')
  const [pendingTarget, setPendingTarget] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Resolve scope: either a group (scopedBoardIds = group.boardIds) or a single board
  const group = isBoardScope
    ? groups.find(g => g.boardIds.includes(singleBoardId!))
    : groups.find(g => g.id === groupId)
  const scopedBoard = isBoardScope ? boards[singleBoardId!] : null
  const scopedBoardIds = isBoardScope
    ? (scopedBoard ? [singleBoardId!] : [])
    : (group?.boardIds ?? [])
  const rootColorFromBoard = scopedBoard
    ? (scopedBoard.rootIds.map(rid => scopedBoard.bars[rid]).filter(Boolean)[0]?.color ?? scopedBoard.color ?? '#5b8dd9')
    : '#5b8dd9'
  const groupColor = isBoardScope ? rootColorFromBoard : (group?.color ?? '#5b8dd9')
  const groupName = isBoardScope
    ? (scopedBoard?.layers?.block?.label || scopedBoard?.projectName || 'Block')
    : (group?.name ?? 'Card')

  // Canvas geometry — scoped to this group's boards (for group scope) OR
  // locked to the single block's header bounds (for board scope).
  const geom = useMemo(() => {
    // ── BOARD SCOPE: match the block header exactly ─────────────────────
    if (isBoardScope) {
      const board = scopedBoard
      if (!board) return { naturalWidth: 200, canvasLeft: 0, canvasBottom: 0 }
      const rb = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
      if (rb.length === 0) return { naturalWidth: 200, canvasLeft: 0, canvasBottom: 0 }
      const bScale = board.boardScale ?? 1
      const minX = Math.min(...rb.map(b => b.x))
      const maxX = Math.max(...rb.map(b => b.x + b.width))
      const contentW = (maxX - minX) * bScale
      const wOverride = board.layers?.block?.widthOverride
      const blockW = Math.max(contentW, wOverride ?? 0)

      const groupLayout = group ? computeGroupLayout(group.boardIds, boards) : null
      const bx = group
        ? group.originX + (board.nleX ?? 0)
        : (board.canvasX ?? 0)
      const by = group && groupLayout
        ? group.originY + getRowY(board.nleRow ?? 0, groupLayout)
        : (board.canvasY ?? 0)

      // Block header left edge in canvas (mirrors BlockItem's `left`)
      const canvasLeft = bx + BOARD_PADDING_X + minX * bScale
      // Block header top in canvas = boardY (header occupies top: 0 within the block item)
      const canvasBottom = by
      return { naturalWidth: blockW, canvasLeft, canvasBottom }
    }

    // ── GROUP SCOPE: span all boards in the group (legacy behavior) ─────
    const allEdges: number[] = []
    const boardYs: number[] = []
    const groupOriginX = group?.originX ?? 0
    const groupOriginY = group?.originY ?? 0
    const groupLayout = computeGroupLayout(scopedBoardIds, boards)

    scopedBoardIds.forEach(bid => {
      const board = boards[bid]
      if (!board) return
      const bScale = board.boardScale ?? 1
      const rb = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
      if (rb.length === 0) return
      const bx = group
        ? groupOriginX + (board.nleX ?? 0)
        : (board.canvasX ?? 0)
      const by = group
        ? groupOriginY + getRowY(board.nleRow ?? 0, groupLayout)
        : (board.canvasY ?? 0)
      allEdges.push(bx + BOARD_PADDING_X + Math.min(...rb.map(b => b.x)) * bScale - 16)
      allEdges.push(bx + BOARD_PADDING_X + Math.max(...rb.map(b => b.x + b.width)) * bScale + 16)
      boardYs.push(by)
    })

    const globalLeft = allEdges.length > 0 ? Math.min(...allEdges) : 0
    const globalRight = allEdges.length > 0 ? Math.max(...allEdges) : 200
    const topBoardY = boardYs.length > 0 ? Math.min(...boardYs) : (group?.originY ?? 0)
    // For group scope, the viewer's bottom sits at the NLE header TOP, not the board top.
    // Back that out so downstream math can treat it uniformly.
    // canvasBottom here is a *canvas-space* y that, after pan/zoom, lands at the NLE header top.
    const nleHeaderBottomCanvas = topBoardY - NLE_HEADER_GAP
    // We'll handle the clamped-header subtraction in screen space below.
    return {
      naturalWidth: globalRight - globalLeft,
      canvasLeft: globalLeft,
      canvasBottom: nleHeaderBottomCanvas,
      _groupHeaderAdjust: true as const,
    }
  }, [isBoardScope, scopedBoard, scopedBoardIds, boards, group])

  const naturalWidth = geom.naturalWidth
  const screenLeft = pan.x + geom.canvasLeft * zoom
  // Viewer bottom edge: for board scope sits at block-header top.
  // For group scope sits at NLE-header top (with clamped min-height subtraction).
  let anchorBottomScreen = APP_TOOLBAR_H + pan.y + geom.canvasBottom * zoom
  if ('_groupHeaderAdjust' in geom && geom._groupHeaderAdjust) {
    const headerScreenHeight = Math.max(NLE_HEADER_CANVAS_H * zoom, 20)
    anchorBottomScreen = anchorBottomScreen - headerScreenHeight
  }
  const canvasNaturalH = Math.round((naturalWidth - TOOLS_W) * 9 / 16)
  const topBarH = 38
  const frameStripHeaderH = 26
  const frameStripContentH = framesOpen ? 110 : 0
  const viewerNaturalH = topBarH + canvasNaturalH + 1 + frameStripHeaderH + frameStripContentH

  if (!isOpen || scopedBoardIds.length === 0) return null

  // Helpers
  const loadImageFile = (file: File, target: string) => {
    if (!file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = ev => {
      const url = ev.target?.result as string
      if (target === 'first') setFirstFrame(url)
      else if (target === 'last') setLastFrame(url)
      else setKeyframes(kfs => kfs.map(kf => kf.id === target ? { ...kf, dataUrl: url } : kf))
    }
    reader.readAsDataURL(file)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file || !pendingTarget) return
    loadImageFile(file, pendingTarget); e.target.value = ''
  }

  const handleFrameUpload = (target: string) => {
    setPendingTarget(target)
    fileInputRef.current?.click()
  }

  const addKeyframe = () =>
    setKeyframes(kfs => [...kfs, { id: crypto.randomUUID(), dataUrl: null, label: `KF${kfs.length + 1}` }])

  const removeKeyframe = (id: string) => setKeyframes(kfs => kfs.filter(kf => kf.id !== id))

  const handleGenerate = async () => {
    setGenerating(true)
    await new Promise(r => setTimeout(r, 2200))
    setHistory(h => [{ id: crypto.randomUUID(), thumbnail: firstFrame, timestamp: new Date().toLocaleTimeString(), duration, model }, ...h])
    setGenerating(false)
  }

  const commitRename = () => {
    const trimmed = renameVal.trim()
    if (trimmed) {
      if (isBoardScope && singleBoardId) {
        useBoardsStore.getState().setBlockLabel(singleBoardId, trimmed)
      } else if (groupId) {
        useBoardsStore.getState().renameGroup(groupId, trimmed)
      }
    }
    setRenaming(false)
  }

  const currentDataUrl =
    activeFrameId === 'first' ? firstFrame
    : activeFrameId === 'last' ? lastFrame
    : keyframes.find(kf => kf.id === activeFrameId)?.dataUrl ?? null

  return (
    <>
      {/* Outer: screen-pixel positioning — no drift */}
      <div
        onWheel={onWheel}
        onPointerDown={onPanDown}
        onPointerMove={onPanMove}
        onPointerUp={onPanUp}
        style={{
          position: 'fixed',
          left: screenLeft,
          top: anchorBottomScreen - viewerNaturalH * zoom,
          width: naturalWidth * zoom,
          height: viewerNaturalH * zoom,
          zIndex: 500,
          overflow: 'hidden',
          pointerEvents: 'auto',
          borderRadius: `${10 * zoom}px ${10 * zoom}px 0 0`,
        }}
      >
      {/* Inner: natural size, scaled */}
      <div
        style={{
          width: naturalWidth,
          height: viewerNaturalH,
          transformOrigin: 'bottom left',
          transform: `scale(${zoom})`,
          position: 'absolute',
          bottom: 0,
          left: 0,
          background: '#0d0e1a',
          borderRadius: '10px 10px 0 0',
          border: '1px solid rgba(255,255,255,0.10)',
          borderBottom: 'none',
          boxShadow: '0 -8px 40px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* ── Top bar ── */}
        <div
          style={{
            display: 'flex', alignItems: 'center',
            padding: '6px 14px', gap: 10,
            background: '#080910',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
            height: 38, flexShrink: 0, cursor: 'grab',
          }}
          onPointerDown={e => e.stopPropagation()}
        >
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: groupColor, flexShrink: 0 }} />
          {renaming ? (
            <RenameInput
              ref={titleInputRef}
              autoFocus
              value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onBlur={commitRename}
              onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false) }}
              onPointerDown={e => e.stopPropagation()}
              style={{
                background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: 5, outline: 'none', color: '#fff',
                fontSize: 12, fontWeight: 700, padding: '2px 6px',
                fontFamily: 'inherit', width: 140,
              }}
            />
          ) : (
            <span
              style={{ color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'text' }}
              onDoubleClick={e => { e.stopPropagation(); setRenameVal(groupName); setRenaming(true) }}
            >{groupName}</span>
          )}
          <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.1)' }} />
          <div style={{ flex: 1 }} />

          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
            Duration
            <select value={duration} onChange={e => setDuration(Number(e.target.value))} style={sel}>
              {[3, 5, 8, 10].map(d => <option key={d} value={d}>{d}s</option>)}
            </select>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
            Model
            <select value={model} onChange={e => setModel(e.target.value as typeof model)} style={sel}>
              <option value="kling">Kling</option>
              <option value="luma">Luma</option>
              <option value="runway">Runway</option>
            </select>
          </label>

          <button
            onClick={handleGenerate}
            disabled={generating}
            style={{
              padding: '5px 16px',
              background: generating ? 'rgba(255,255,255,0.08)' : '#2563eb',
              color: generating ? 'rgba(255,255,255,0.4)' : '#fff',
              border: 'none', borderRadius: 7,
              cursor: generating ? 'not-allowed' : 'pointer',
              fontSize: 12, fontWeight: 700,
              boxShadow: generating ? 'none' : '0 2px 10px rgba(37,99,235,0.4)',
              fontFamily: 'inherit',
            }}
          >
            {generating ? 'Generating…' : '▶ Generate'}
          </button>

          <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.1)' }} />

          <button
            onClick={onClose}
            style={{
              width: 24, height: 24, borderRadius: '50%',
              background: 'rgba(255,255,255,0.07)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'rgba(255,255,255,0.6)',
              cursor: 'pointer', fontSize: 14, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
          >×</button>
        </div>

        {/* ── Main area ── */}
        <div style={{ display: 'flex', height: canvasNaturalH, flexShrink: 0 }}>
          <div
            style={{
              flex: 1, position: 'relative',
              background: `linear-gradient(160deg, ${groupColor}22 0%, ${groupColor}10 100%)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
            }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => {
              const file = e.dataTransfer.files?.[0]
              if (!file) return
              e.preventDefault()
              e.stopPropagation()
              loadImageFile(file, activeFrameId)
            }}
          >
            <div style={{
              position: 'absolute', inset: 0,
              backgroundImage: 'repeating-linear-gradient(rgba(255,255,255,0.02) 0 1px, transparent 1px 100%), repeating-linear-gradient(90deg, rgba(255,255,255,0.02) 0 1px, transparent 1px 100%)',
              backgroundSize: '60px 34px', pointerEvents: 'none',
            }} />

            {currentDataUrl ? (
              <img src={currentDataUrl} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 4 }} />
            ) : (
              <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.18)', userSelect: 'none' }}>
                <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.5 }}>▶</div>
                <div style={{ fontSize: 12 }}>{groupName}</div>
                <div style={{ fontSize: 10, marginTop: 4, opacity: 0.6 }}>select a frame below to preview</div>
              </div>
            )}

            {generating && (
              <div style={{
                position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14,
              }}>
                <div style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>Generating…</div>
                <div style={{ width: 180, height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: '#2563eb', borderRadius: 2, animation: 'vb-nle-prog 2.2s ease-in-out forwards' }} />
                </div>
                <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{model} · {duration}s</div>
              </div>
            )}
          </div>

          {/* Tools sidebar */}
          <div style={{
            width: TOOLS_W, background: '#080910',
            borderLeft: '1px solid rgba(255,255,255,0.05)',
            display: 'flex', flexDirection: 'column', padding: '10px 6px', gap: 6, flexShrink: 0,
          }}>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', fontWeight: 700, letterSpacing: 1, textAlign: 'center', marginBottom: 2 }}>TOOLS</div>
            {['✏️', '⬜', '🔤', '🪄'].map((icon, i) => (
              <button key={i} style={{
                padding: '7px 4px', borderRadius: 6,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.06)',
                cursor: 'pointer', fontSize: 14, color: 'rgba(255,255,255,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{icon}</button>
            ))}
          </div>
        </div>

        {/* ── Frame strip ── */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
          <button
            onClick={() => setFramesOpen(o => !o)}
            style={{
              width: '100%', background: 'none', border: 'none',
              display: 'flex', alignItems: 'center',
              padding: '5px 14px', gap: 8, cursor: 'pointer',
              color: 'rgba(255,255,255,0.35)', fontSize: 11, fontWeight: 600,
              fontFamily: 'inherit', letterSpacing: '0.3px',
            }}
          >
            <span style={{ display: 'inline-block', transform: framesOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s', fontSize: 9 }}>▼</span>
            FRAMES
            {history.length > 0 && (
              <span style={{ color: 'rgba(255,255,255,0.18)', fontSize: 10 }}>· {history.length} generated</span>
            )}
          </button>

          {framesOpen && (
            <div style={{ display: 'flex', gap: 6, padding: '0 12px 10px', alignItems: 'stretch', height: 100 }}>
              <FrameSlot label="FIRST" id="first" dataUrl={firstFrame} active={activeFrameId === 'first'} color={groupColor}
                onSelect={() => setActiveFrameId('first')} onUpload={() => handleFrameUpload('first')}
                onClear={() => setFirstFrame(null)} onDrop={f => loadImageFile(f, 'first')} width={90} />

              <div style={{ flex: 1, display: 'flex', gap: 5, alignItems: 'stretch', overflowX: 'auto' }}>
                {keyframes.map(kf => (
                  <FrameSlot key={kf.id} label={kf.label} id={kf.id} dataUrl={kf.dataUrl} active={activeFrameId === kf.id} color={groupColor}
                    onSelect={() => setActiveFrameId(kf.id)} onUpload={() => handleFrameUpload(kf.id)}
                    onClear={() => removeKeyframe(kf.id)} onDrop={f => loadImageFile(f, kf.id)} width={74} />
                ))}
                <button
                  onClick={addKeyframe}
                  style={{
                    minWidth: 44, background: 'rgba(255,255,255,0.03)',
                    border: '1.5px dashed rgba(255,255,255,0.12)',
                    borderRadius: 7, cursor: 'pointer',
                    color: 'rgba(255,255,255,0.25)', fontSize: 20,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}
                >+</button>
              </div>

              <FrameSlot label="LAST" id="last" dataUrl={lastFrame} active={activeFrameId === 'last'} color={groupColor}
                onSelect={() => setActiveFrameId('last')} onUpload={() => handleFrameUpload('last')}
                onClear={() => setLastFrame(null)} onDrop={f => loadImageFile(f, 'last')} width={90} />
            </div>
          )}
        </div>
      </div>
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
      <style>{`@keyframes vb-nle-prog { from { width: 0% } to { width: 100% } }`}</style>
    </>
  )
}

/** Renders one NLE viewer per open group */
export const NLETimelineViewer: React.FC = () => {
  const openGroupIds = useNLEViewerStore(s => s.openGroupIds)
  return (
    <>
      {Array.from(openGroupIds).map(gid => (
        <NLEGroupViewer key={gid} scopeKey={gid} />
      ))}
    </>
  )
}

// ── Frame slot (matches Viewer.tsx FrameSlot exactly) ────────────────────────

interface FrameSlotProps {
  label: string; id: string; dataUrl: string | null; active: boolean; color: string
  onSelect: () => void; onUpload: () => void; onClear: () => void; onDrop: (file: File) => void; width: number
}

const FrameSlot: React.FC<FrameSlotProps> = ({ label, dataUrl, active, color, onSelect, onUpload, onClear, onDrop, width }) => (
  <div
    style={{
      width, borderRadius: 7,
      border: active ? `2px solid ${color}` : '1.5px solid rgba(255,255,255,0.08)',
      background: `${color}18`,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      cursor: 'pointer', flexShrink: 0, position: 'relative', transition: 'border-color 0.12s',
    }}
    onClick={onSelect}
    onDragOver={e => e.preventDefault()}
    onDrop={e => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); e.stopPropagation(); onDrop(f) } }}
  >
    <div style={{
      background: active ? color : 'rgba(255,255,255,0.05)',
      color: active ? '#fff' : 'rgba(255,255,255,0.35)',
      fontSize: 9, fontWeight: 700, letterSpacing: 0.8, padding: '3px 6px', textAlign: 'center', flexShrink: 0,
    }}>{label}</div>
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      {dataUrl ? (
        <>
          <img src={dataUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          <button
            onClick={e => { e.stopPropagation(); onClear() }}
            style={{
              position: 'absolute', top: 2, right: 2,
              width: 16, height: 16, background: 'rgba(0,0,0,0.7)', border: 'none',
              borderRadius: '50%', cursor: 'pointer', color: '#fff', fontSize: 10, lineHeight: 1,
            }}
          >×</button>
        </>
      ) : (
        <button
          onClick={e => { e.stopPropagation(); onUpload() }}
          style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.2)', fontSize: 20, cursor: 'pointer' }}
          title="Upload image"
        >+</button>
      )}
    </div>
  </div>
)
