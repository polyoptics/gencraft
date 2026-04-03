import React, { useRef, useState } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useNLEViewerStore } from '../../store/nleViewerStore'
import { NLE_HEADER_CANVAS_H } from './NLETimelineHeader'

interface Frame {
  id: string
  dataUrl: string | null
  label: string
}

interface GenerationResult {
  id: string
  thumbnail: string | null
  timestamp: string
}

const APP_TOOLBAR_H   = 38
const NLE_HEADER_GAP  = 2   // must match GAP in NLETimelineHeader
const BOARD_PADDING_X = 20
const TOOLS_W         = 80  // canvas units
const TOPBAR_H        = 40  // canvas units
const TIMESLIDER_H    = 110 // canvas units
const RULER_H         = 18  // canvas units (within time slider)

export const NLETimelineViewer: React.FC = () => {
  // ── All hooks unconditionally ──────────────────────────────────────────────
  const open         = useNLEViewerStore(s => s.open)
  const onClose      = useNLEViewerStore(s => s.close)
  const primaryBars  = useBoardsStore(s => s.boards['primary']?.bars ?? {})
  const primaryRoots = useBoardsStore(s => s.boards['primary']?.rootIds ?? [])
  const primaryName  = useBoardsStore(s => s.boards['primary']?.projectName ?? 'storyMap')
  const boardOrder   = useBoardsStore(s => s.boardOrder)
  const boards       = useBoardsStore(s => s.boards)
  const pan          = useCanvasStore(s => s.pan)
  const zoom         = useCanvasStore(s => s.zoom)
  const boardPos     = useCanvasStore(s => s.boardPos)
  const nleRowHeight = useCanvasStore(s => s.nleRowHeight)

  const [firstFrame, setFirstFrame]       = useState<string | null>(null)
  const [lastFrame, setLastFrame]         = useState<string | null>(null)
  const [keyframes, setKeyframes]         = useState<Frame[]>([])
  const [duration]                        = useState(5)
  const [generating, setGenerating]       = useState(false)
  const [activeFrameId, setActiveFrameId] = useState<string>('first')
  const [history, setHistory]             = useState<GenerationResult[]>([])
  const [headerName, setHeaderName]       = useState('NLE Timeline')
  const [renaming, setRenaming]           = useState(false)
  const [renameVal, setRenameVal]         = useState('')
  const [pendingTarget, setPendingTarget] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Board pills ────────────────────────────────────────────────────────────
  const pills: { name: string; color: string }[] = []
  if (primaryRoots.length > 0) pills.push({ name: primaryName, color: '#5b8dd9' })
  boardOrder.forEach(id => {
    const b = boards[id]
    if (b && b.rootIds.length > 0) pills.push({ name: b.projectName, color: b.color })
  })

  // ── Canvas geometry — mirrors NLETimelineHeader exactly ───────────────────
  const allEdges: number[] = []
  const pRootBars = primaryRoots.map(id => primaryBars[id]).filter(Boolean)
  if (pRootBars.length > 0) {
    allEdges.push(boardPos.x + BOARD_PADDING_X + Math.min(...pRootBars.map(b => b.x)) - 16)
    allEdges.push(boardPos.x + BOARD_PADDING_X + Math.max(...pRootBars.map(b => b.x + b.width)) + 16)
  }
  boardOrder.forEach(id => {
    const board = boards[id]
    if (!board) return
    const rb = board.rootIds.map(rid => board.bars[rid]).filter(Boolean)
    if (rb.length === 0) return
    allEdges.push(board.nleX + BOARD_PADDING_X + Math.min(...rb.map(b => b.x)) - 16)
    allEdges.push(board.nleX + BOARD_PADDING_X + Math.max(...rb.map(b => b.x + b.width)) + 16)
  })
  const globalLeft  = allEdges.length > 0 ? Math.min(...allEdges) : 0
  const globalRight = allEdges.length > 0 ? Math.max(...allEdges) : 200

  // NLE header bottom in screen space — viewer's bottom edge (opens upward)
  const rowYs     = boardOrder.map(id => (boards[id]?.nleRow ?? 0) * nleRowHeight)
  const topBoardY = rowYs.length > 0 ? Math.min(boardPos.y, ...rowYs) : boardPos.y

  // NLE header TOP in screen (fixed) coords — viewer bottom anchors here
  const nleHeaderTopScreen = APP_TOOLBAR_H + pan.y + (topBoardY - NLE_HEADER_CANVAS_H - NLE_HEADER_GAP) * zoom

  // Viewer: same width as NLE header, 16:9, opens upward — no capping
  const viewerW    = (globalRight - globalLeft) * zoom
  const viewerH    = Math.round(viewerW * 9 / 16)
  const screenLeft = pan.x + globalLeft * zoom
  const screenTop  = nleHeaderTopScreen - viewerH

  // ── Early exit ─────────────────────────────────────────────────────────────
  if (!open) return null

  // ── Helpers ────────────────────────────────────────────────────────────────
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

  const addKeyframe = () =>
    setKeyframes(kfs => [...kfs, { id: crypto.randomUUID(), dataUrl: null, label: `KF${kfs.length + 1}` }])

  const removeKeyframe = (id: string) => setKeyframes(kfs => kfs.filter(kf => kf.id !== id))

  const handleGenerate = async () => {
    setGenerating(true)
    await new Promise(r => setTimeout(r, 2200))
    setHistory(h => [{ id: crypto.randomUUID(), thumbnail: firstFrame, timestamp: new Date().toLocaleTimeString() }, ...h])
    setGenerating(false)
  }

  const commitRename = () => {
    if (renameVal.trim()) setHeaderName(renameVal.trim())
    setRenaming(false)
  }

  const currentDataUrl =
    activeFrameId === 'first' ? firstFrame
    : activeFrameId === 'last' ? lastFrame
    : keyframes.find(kf => kf.id === activeFrameId)?.dataUrl ?? null

  const kfPositions  = keyframes.map((_, i) => (i + 1) / (keyframes.length + 1))
  // Scale layout constants proportionally to actual viewer height
  const scale        = viewerH / 400   // reference height 400px
  const topBarH      = Math.round(TOPBAR_H * scale)
  const timeSliderH  = Math.round(TIMESLIDER_H * scale)
  const rulerH       = Math.round(RULER_H * scale)
  const toolsW       = Math.round(TOOLS_W * scale)
  const monitorH     = viewerH - topBarH - timeSliderH
  const SLOT_W       = Math.round(68 * scale)
  const SLOT_H       = timeSliderH - rulerH - Math.round(10 * scale)

  return (
    <>
      {/* Viewer opens DOWNWARD from the NLE header bottom edge, scales with canvas zoom */}
      <div
        style={{
          position: 'fixed',
          left: screenLeft,
          top: screenTop,
          width: viewerW,
          height: viewerH,
          zIndex: 490,
          display: 'flex',
          flexDirection: 'column',
          background: '#0b0c1a',
          borderTop: '1px solid rgba(255,255,255,0.09)',
          borderLeft: '1px solid rgba(255,255,255,0.09)',
          borderRight: '1px solid rgba(255,255,255,0.09)',
          borderBottom: 'none',
          borderRadius: '10px 10px 0 0',
          boxShadow: '0 -8px 40px rgba(0,0,0,0.65)',
          overflow: 'hidden',
        }}
        onPointerDown={e => e.stopPropagation()}
      >
        {/* ── Top bar ── */}
        <div style={{
          height: topBarH, flexShrink: 0,
          display: 'flex', alignItems: 'center', padding: '0 14px', gap: 10,
          background: '#080910', borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}>
          <div style={{ width: 8, height: 8, borderRadius: 2, background: '#5b8dd9', flexShrink: 0 }} />
          {renaming ? (
            <input autoFocus value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onBlur={commitRename}
              onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false) }}
              onPointerDown={e => e.stopPropagation()}
              style={{
                background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: 5, outline: 'none', color: '#fff',
                fontSize: 13, fontWeight: 700, padding: '2px 7px', fontFamily: 'inherit', width: 150,
              }}
            />
          ) : (
            <span onDoubleClick={() => { setRenameVal(headerName); setRenaming(true) }}
              style={{ color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'text', whiteSpace: 'nowrap', flexShrink: 0 }}>
              {headerName}
            </span>
          )}

          {/* Board pills */}
          <div style={{ display: 'flex', gap: 5, flex: 1, overflow: 'hidden', alignItems: 'center' }}>
            {pills.map((p, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
                padding: '2px 7px', borderRadius: 20,
                background: `${p.color}16`, border: `1px solid ${p.color}40`,
              }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: p.color }} />
                <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, whiteSpace: 'nowrap' }}>{p.name}</span>
              </div>
            ))}
          </div>

          {/* Generate (compact, no controls) */}
          <button onClick={handleGenerate} disabled={generating} style={{
            padding: '5px 14px', flexShrink: 0,
            background: generating ? 'rgba(255,255,255,0.07)' : '#2563eb',
            color: generating ? 'rgba(255,255,255,0.35)' : '#fff',
            border: 'none', borderRadius: 6, cursor: generating ? 'not-allowed' : 'pointer',
            fontSize: 11, fontWeight: 700, fontFamily: 'inherit',
            boxShadow: generating ? 'none' : '0 2px 10px rgba(37,99,235,0.4)',
          }}>{generating ? 'Generating…' : '▶ Generate'}</button>

          <button onClick={onClose} style={{
            width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
            color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 14, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>×</button>
        </div>

        {/* ── Monitor + Tools ── */}
        <div style={{ display: 'flex', height: monitorH, flex: 1, minHeight: 0 }}>
          {/* Program monitor */}
          <div style={{
            flex: 1, position: 'relative', background: '#060710',
            display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
          }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); loadImageFile(f, activeFrameId) } }}
          >
            <div style={{
              position: 'absolute', inset: 0, pointerEvents: 'none',
              backgroundImage: 'repeating-linear-gradient(rgba(255,255,255,0.013) 0 1px, transparent 1px 100%), repeating-linear-gradient(90deg, rgba(255,255,255,0.013) 0 1px, transparent 1px 100%)',
              backgroundSize: '80px 45px',
            }} />
            <div style={{ position: 'absolute', top: 8, left: 12, color: 'rgba(255,255,255,0.14)', fontSize: 10, fontWeight: 700, letterSpacing: 1, pointerEvents: 'none' }}>
              PROGRAM
            </div>

            {currentDataUrl ? (
              <img src={currentDataUrl} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 3 }} />
            ) : (
              <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.1)', pointerEvents: 'none' }}>
                <div style={{ fontSize: 40, marginBottom: 8, opacity: 0.35 }}>▶</div>
                <div style={{ fontSize: 12, fontWeight: 600 }}>No frame selected</div>
                <div style={{ fontSize: 10, marginTop: 4, opacity: 0.6 }}>Select a frame on the timeline below</div>
              </div>
            )}

            {generating && (
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
                <div style={{ color: '#fff', fontSize: 14, fontWeight: 600 }}>Generating…</div>
                <div style={{ width: 220, height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: '#2563eb', borderRadius: 2, animation: 'vb-nle-prog 2.2s ease-in-out forwards' }} />
                </div>
              </div>
            )}

            {history.length > 0 && (
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, padding: '5px 10px',
                background: 'linear-gradient(0deg, rgba(0,0,0,0.5) 0%, transparent 100%)',
                display: 'flex', gap: 5, alignItems: 'center',
              }}>
                <span style={{ color: 'rgba(255,255,255,0.28)', fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>HISTORY</span>
                {history.slice(0, 10).map(r => (
                  <div key={r.id} title={r.timestamp} style={{
                    width: 38, height: 24, borderRadius: 3, overflow: 'hidden', flexShrink: 0,
                    border: '1px solid rgba(255,255,255,0.1)', cursor: 'pointer',
                    background: r.thumbnail ? 'transparent' : 'rgba(255,255,255,0.05)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {r.thumbnail
                      ? <img src={r.thumbnail} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <span style={{ fontSize: 7, color: 'rgba(255,255,255,0.25)' }}>GEN</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Tools sidebar */}
          <div style={{
            width: toolsW, flexShrink: 0, background: '#080910',
            borderLeft: '1px solid rgba(255,255,255,0.05)',
            display: 'flex', flexDirection: 'column', padding: '10px 6px', gap: 6,
          }}>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)', fontWeight: 700, letterSpacing: 1, textAlign: 'center', marginBottom: 2 }}>TOOLS</div>
            {(['✏️', '⬜', '🔤', '🪄', '🎨'] as const).map((icon, i) => (
              <button key={i} style={{
                padding: '7px 4px', borderRadius: 7,
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)',
                cursor: 'pointer', fontSize: 15,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{icon}</button>
            ))}
          </div>
        </div>

        {/* ── Time slider ── */}
        <div style={{ height: timeSliderH, flexShrink: 0, background: '#080910', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', flexDirection: 'column' }}>
          {/* Ruler */}
          <div style={{
            height: rulerH, flexShrink: 0, position: 'relative', overflow: 'visible',
            background: '#06060f', borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex', alignItems: 'flex-end',
          }}>
            <button onClick={addKeyframe} style={{
              position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 4, color: 'rgba(255,255,255,0.4)', fontSize: 10, cursor: 'pointer',
              padding: '0 5px', height: 14, display: 'flex', alignItems: 'center', fontFamily: 'inherit',
            }}>+ KF</button>

            {Array.from({ length: duration + 1 }).map((_, i) => (
              <div key={i} style={{
                position: 'absolute',
                left: `${(i / duration) * 100}%`,
                bottom: 0, height: 6, width: 1,
                background: 'rgba(255,255,255,0.18)',
              }}>
                <span style={{ position: 'absolute', bottom: 8, left: 3, color: 'rgba(255,255,255,0.28)', fontSize: 8, whiteSpace: 'nowrap' }}>{i}s</span>
              </div>
            ))}
          </div>

          {/* Frame track */}
          <div style={{ flex: 1, position: 'relative' }}>
            {/* Track line */}
            <div style={{
              position: 'absolute', top: '50%', left: SLOT_W / 2, right: SLOT_W / 2,
              height: 1, background: 'rgba(255,255,255,0.1)',
            }} />

            <TimeFrameSlot label="FIRST" id="first" dataUrl={firstFrame} active={activeFrameId === 'first'} fraction={0}
              slotW={SLOT_W} slotH={SLOT_H}
              onSelect={() => setActiveFrameId('first')}
              onUpload={() => { setPendingTarget('first'); fileInputRef.current?.click() }}
              onClear={() => setFirstFrame(null)}
              onDrop={f => loadImageFile(f, 'first')} />

            {keyframes.map((kf, i) => (
              <TimeFrameSlot key={kf.id} label={kf.label} id={kf.id} dataUrl={kf.dataUrl} active={activeFrameId === kf.id} fraction={kfPositions[i]}
                slotW={SLOT_W} slotH={SLOT_H}
                onSelect={() => setActiveFrameId(kf.id)}
                onUpload={() => { setPendingTarget(kf.id); fileInputRef.current?.click() }}
                onClear={() => removeKeyframe(kf.id)}
                onDrop={f => loadImageFile(f, kf.id)} />
            ))}

            <TimeFrameSlot label="LAST" id="last" dataUrl={lastFrame} active={activeFrameId === 'last'} fraction={1}
              slotW={SLOT_W} slotH={SLOT_H}
              onSelect={() => setActiveFrameId('last')}
              onUpload={() => { setPendingTarget('last'); fileInputRef.current?.click() }}
              onClear={() => setLastFrame(null)}
              onDrop={f => loadImageFile(f, 'last')} />
          </div>
        </div>
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
      <style>{`@keyframes vb-nle-prog { from { width: 0% } to { width: 100% } }`}</style>
    </>
  )
}

// ── Time-positioned frame slot ─────────────────────────────────────────────

interface TimeFrameSlotProps {
  label: string; id: string; dataUrl: string | null; active: boolean
  fraction: number; slotW: number; slotH: number
  onSelect: () => void; onUpload: () => void; onClear: () => void; onDrop: (f: File) => void
}

const TimeFrameSlot: React.FC<TimeFrameSlotProps> = ({ label, dataUrl, active, fraction, slotW, slotH, onSelect, onUpload, onClear, onDrop }) => (
  <div
    style={{
      position: 'absolute',
      left: `calc(${fraction * 100}% - ${slotW / 2}px)`,
      top: '50%', transform: 'translateY(-50%)',
      width: slotW, height: slotH, borderRadius: 6,
      border: active ? '2px solid rgba(91,141,217,0.85)' : '1.5px solid rgba(255,255,255,0.1)',
      background: active ? 'rgba(91,141,217,0.12)' : 'rgba(255,255,255,0.04)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden', cursor: 'pointer',
    }}
    onClick={onSelect}
    onDragOver={e => e.preventDefault()}
    onDrop={e => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); e.stopPropagation(); onDrop(f) } }}
  >
    <div style={{ position: 'absolute', bottom: -5, left: '50%', width: 1, height: 7, background: active ? 'rgba(91,141,217,0.6)' : 'rgba(255,255,255,0.15)' }} />
    <div style={{ background: active ? 'rgba(91,141,217,0.65)' : 'rgba(255,255,255,0.06)', color: active ? '#fff' : 'rgba(255,255,255,0.4)', fontSize: 8, fontWeight: 700, letterSpacing: 0.6, padding: '2px 5px', textAlign: 'center', flexShrink: 0 }}>{label}</div>
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      {dataUrl ? (
        <>
          <img src={dataUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          <button onClick={e => { e.stopPropagation(); onClear() }} style={{ position: 'absolute', top: 2, right: 2, width: 13, height: 13, background: 'rgba(0,0,0,0.75)', border: 'none', borderRadius: '50%', cursor: 'pointer', color: '#fff', fontSize: 9, lineHeight: 1 }}>×</button>
        </>
      ) : (
        <button onClick={e => { e.stopPropagation(); onUpload() }} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.2)', fontSize: 18, cursor: 'pointer' }}>+</button>
      )}
    </div>
  </div>
)
