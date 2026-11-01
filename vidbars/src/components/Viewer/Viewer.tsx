import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { computeGroupLayout, getRowY } from '../../utils/nleRows'
import { getGroupForBoard } from '../../store/boardsStore'
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
  barName: string
  duration: number
  model: string
}

const TOOLS_W = 72
const APP_TOOLBAR_H = 38
const BOARD_PADDING_X = 20
/** One shared empty map: a selector must return the SAME object for a board
 *  that is gone ('primary' is deleted with its card), or every store read
 *  sees a change and React re-renders forever. */
const NO_BARS: Record<string, never> = {}

interface Props {
  boardId: string   // 'primary' for the primary board
}

export const Viewer: React.FC<Props> = ({ boardId }) => {
  const board        = useBoardsStore(s => s.boards[boardId])
  const viewerBarId  = useBoardsStore(s => s.boards[boardId]?.viewerBarId ?? null)
  const bars         = useBoardsStore(s => s.boards[boardId]?.bars ?? NO_BARS)

  const pan           = useCanvasStore(s => s.pan)
  const zoom          = useCanvasStore(s => s.zoom)
  const zoomAtPoint   = useCanvasStore(s => s.zoomAtPoint)
  const shiftPan      = useCanvasStore(s => s.shiftPan)
  const groups        = useBoardsStore(s => s.groups)

  // Forward wheel-zoom through the viewer to the canvas
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    zoomAtPoint(factor, e.clientX, e.clientY - APP_TOOLBAR_H)
  }, [zoomAtPoint])

  // Forward middle-mouse pan through the viewer
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

  const closeViewer = useCallback(() => useBoardsStore.getState().closeViewer(boardId), [boardId])
  const renameBar   = useCallback((id: string, name: string) => useBoardsStore.getState().renameBar(boardId, id, name), [boardId])

  const [firstFrame, setFirstFrame]       = useState<string | null>(null)
  const [lastFrame, setLastFrame]         = useState<string | null>(null)
  const [keyframes, setKeyframes]         = useState<Frame[]>([])
  const [duration, setDuration]           = useState(5)
  const [model, setModel]                 = useState<'kling' | 'luma' | 'runway'>('kling')
  const [generating, setGenerating]       = useState(false)
  const [activeFrameId, setActiveFrameId] = useState<string>('first')
  const [framesOpen, setFramesOpen]       = useState(true)
  const [history, setHistory]             = useState<GenerationResult[]>([])
  const [renamingTitle, setRenamingTitle] = useState(false)
  const [titleVal, setTitleVal]           = useState('')

  const fileInputRef  = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const titleLastX    = useRef(0)
  const titleLastY    = useRef(0)
  const [pendingFrameTarget, setPendingFrameTarget] = useState<string | null>(null)

  useEffect(() => { if (renamingTitle) titleInputRef.current?.select() }, [renamingTitle])

  useEffect(() => {
    setFirstFrame(null); setLastFrame(null); setKeyframes([])
    setActiveFrameId('first'); setGenerating(false)
  }, [viewerBarId])

  const onTitleDragDown = useCallback((e: React.PointerEvent) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT') return
    e.stopPropagation()
    titleLastX.current = e.clientX
    titleLastY.current = e.clientY
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const onTitleDragMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const dx = (e.clientX - titleLastX.current) / zoom
    const dy = (e.clientY - titleLastY.current) / zoom
    // Move the board's group
    const bs = useBoardsStore.getState()
    const group = getGroupForBoard(bs.groups, boardId)
    if (group) {
      useBoardsStore.getState().setGroupPos(group.id, group.originY + dy, group.originX + dx)
    }
    titleLastX.current = e.clientX
    titleLastY.current = e.clientY
  }, [boardId, zoom])

  const onTitleDragUp = useCallback(() => {}, [])

  const commitTitleRename = useCallback(() => {
    if (viewerBarId && titleVal.trim()) renameBar(viewerBarId, titleVal.trim())
    setRenamingTitle(false)
  }, [viewerBarId, titleVal, renameBar])

  const loadImageFile = useCallback((file: File, target: string) => {
    if (!file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string
      if (target === 'first') setFirstFrame(dataUrl)
      else if (target === 'last') setLastFrame(dataUrl)
      else setKeyframes(kfs => kfs.map(kf => kf.id === target ? { ...kf, dataUrl } : kf))
    }
    reader.readAsDataURL(file)
  }, [])

  if (!viewerBarId) return null
  const bar = bars[viewerBarId]
  if (!bar) return null

  // Compute anchor position
  let headerScreenLeft: number
  let headerScreenTop: number
  let naturalWidth: number

  const bScale = board?.boardScale ?? 1

  {
    const topRow = Object.values(bars).filter(b => b.rowIndex === 0)
    const minX = topRow.length > 0 ? Math.min(...topRow.map(b => b.x)) : 0
    const maxX = topRow.length > 0 ? Math.max(...topRow.map(b => b.x + b.width)) : 480
    naturalWidth = (maxX - minX) * bScale
    const group = getGroupForBoard(groups, boardId)
    const groupOriginX = group?.originX ?? 0
    const groupOriginY = group?.originY ?? 0
    const nleRow = board?.nleRow ?? 0
    const nleX   = board?.nleX   ?? 0
    const groupLayout = group ? computeGroupLayout(group.boardIds, useBoardsStore.getState().boards) : computeGroupLayout([boardId], useBoardsStore.getState().boards)
    const absX = groupOriginX + nleX
    const absY = groupOriginY + getRowY(nleRow, groupLayout)
    headerScreenLeft = pan.x + (absX + BOARD_PADDING_X + minX * bScale) * zoom
    headerScreenTop  = APP_TOOLBAR_H + pan.y + absY * zoom
  }

  const canvasNaturalH = Math.round((naturalWidth - TOOLS_W) * 9 / 16)
  // Compute the viewer's natural (unscaled) height so we can position in screen pixels
  const topBarH = 38
  const frameStripHeaderH = 26
  const frameStripContentH = framesOpen ? 110 : 0
  const viewerNaturalH = topBarH + canvasNaturalH + 1 + frameStripHeaderH + frameStripContentH
  const barColor = bar.color

  const handleFrameUpload = (target: string) => {
    setPendingFrameTarget(target)
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !pendingFrameTarget) return
    loadImageFile(file, pendingFrameTarget)
    e.target.value = ''
  }

  const addKeyframe = () =>
    setKeyframes(kfs => [...kfs, { id: crypto.randomUUID(), dataUrl: null, label: `KF${kfs.length + 1}` }])

  const removeKeyframe = (id: string) =>
    setKeyframes(kfs => kfs.filter(kf => kf.id !== id))

  const handleGenerate = async () => {
    setGenerating(true)
    await new Promise(r => setTimeout(r, 2200))
    const result: GenerationResult = {
      id: crypto.randomUUID(),
      thumbnail: firstFrame,
      timestamp: new Date().toLocaleTimeString(),
      barName: bar.name,
      duration,
      model,
    }
    setHistory(h => [result, ...h])
    setGenerating(false)
  }

  const currentDataUrl =
    activeFrameId === 'first' ? firstFrame
    : activeFrameId === 'last' ? lastFrame
    : keyframes.find(kf => kf.id === activeFrameId)?.dataUrl ?? null

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

  return (
    <>
      {/* Outer: screen-pixel positioning — no transform, no drift */}
      <div
        onWheel={onWheel}
        onPointerDown={onPanDown}
        onPointerMove={onPanMove}
        onPointerUp={onPanUp}
        style={{
          position: 'fixed',
          left: headerScreenLeft,
          top: headerScreenTop - viewerNaturalH * zoom,
          width: naturalWidth * zoom,
          height: viewerNaturalH * zoom,
          zIndex: 500,
          overflow: 'hidden',
          pointerEvents: 'auto',
          borderRadius: `${10 * zoom}px ${10 * zoom}px 0 0`,
        }}
      >
      {/* Inner: natural size, scaled to fit the outer container */}
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
          onPointerDown={onTitleDragDown}
          onPointerMove={onTitleDragMove}
          onPointerUp={onTitleDragUp}
        >
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: barColor, flexShrink: 0 }} />
          {renamingTitle ? (
            <RenameInput
              ref={titleInputRef}
              value={titleVal}
              onChange={e => setTitleVal(e.target.value)}
              onBlur={commitTitleRename}
              onKeyDown={e => { if (e.key === 'Enter') commitTitleRename(); if (e.key === 'Escape') setRenamingTitle(false) }}
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
              onDoubleClick={e => { e.stopPropagation(); setTitleVal(bar.name); setRenamingTitle(true) }}
            >{bar.name}</span>
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
            onClick={closeViewer}
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
              background: `linear-gradient(160deg, ${barColor}22 0%, ${barColor}10 100%)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
            }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => {
              const file = e.dataTransfer.files?.[0]
              if (!file) return
              e.preventDefault()
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
                <div style={{ fontSize: 12 }}>{bar.name}</div>
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
                  <div style={{ height: '100%', background: '#2563eb', borderRadius: 2, animation: 'vb-progress 2.2s ease-in-out forwards' }} />
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
              <FrameSlot label="FIRST" id="first" dataUrl={firstFrame} active={activeFrameId === 'first'} color={barColor}
                onSelect={() => setActiveFrameId('first')} onUpload={() => handleFrameUpload('first')}
                onClear={() => setFirstFrame(null)} onDrop={f => loadImageFile(f, 'first')} width={90} />

              <div style={{ flex: 1, display: 'flex', gap: 5, alignItems: 'stretch', overflowX: 'auto' }}>
                {keyframes.map(kf => (
                  <FrameSlot key={kf.id} label={kf.label} id={kf.id} dataUrl={kf.dataUrl} active={activeFrameId === kf.id} color={barColor}
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

              <FrameSlot label="LAST" id="last" dataUrl={lastFrame} active={activeFrameId === 'last'} color={barColor}
                onSelect={() => setActiveFrameId('last')} onUpload={() => handleFrameUpload('last')}
                onClear={() => setLastFrame(null)} onDrop={f => loadImageFile(f, 'last')} width={90} />
            </div>
          )}
        </div>
      </div>
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />

      <style>{`
        @keyframes vb-progress {
          from { width: 0% }
          to { width: 100% }
        }
      `}</style>
    </>
  )
}

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
