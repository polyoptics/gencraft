// PathMenu — the right-click menu of a curve (Brian 2026-11-12: "in the
// view, when I'm using it, I should be able to flip the tangent mode on
// any point"). On a point: its tangent mode (the one it is in is
// ticked), for every selected point when it is one of several, and
// Delete. On the line: a new point there, all its points, Delete. Opened
// by utils/notesTool, flat and in 3D alike; laid out as a storyline's
// menu. Each action is one undo step.

import React from 'react'
import ReactDOM from 'react-dom'
import { useNotesStore, useNotesUi } from '../../store/notesStore'
import { usePathMenu } from '../../store/pathLive'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { pickedPoints, modeOf, setTangentMode, deletePickedPoints, insertPoint, selectAllPoints, type TangentMode } from '../../utils/pathEdit'

const MODES: { mode: TangentMode; label: string; tip: string }[] = [
  { mode: 'auto', label: 'Auto', tip: 'The line finds its own way through the point' },
  { mode: 'unified', label: 'Unified', tip: 'Handles set by hand, kept in one line: smooth through the point' },
  { mode: 'broken', label: 'Broken', tip: 'Each handle its own: a sharp turn with bent sides' },
  { mode: 'corner', label: 'Corner', tip: 'No handles: the line turns sharply' },
]

export const PathMenu: React.FC = () => {
  const at = usePathMenu(s => s.at)
  const curves = useNotesStore(s => s.curves)
  const points = useNotesUi(s => s.points)
  if (!at) return null
  const c = curves[at.id]
  const close = () => usePathMenu.setState({ at: null })
  if (!c) return null
  const step = (f: () => void) => () => { close(); useUndoCoordinator.getState().checkpoint(); f() }
  const onPoint = at.point !== undefined
  const p = onPoint ? c.pts[at.point!] : undefined
  const now = p && c.kind === 'bezier' ? modeOf(c, p) : null
  const many = points.length > 1
  const row: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 14px',
    background: 'none', border: 'none', cursor: 'pointer', color: '#e2e8f0',
    fontSize: 13, textAlign: 'left', borderRadius: 4, whiteSpace: 'nowrap',
  }
  const hover = {
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)' },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = 'none' },
  }
  const rows = (onPoint ? (c.kind === 'bezier' ? MODES.length : 0) + 1 : 3)
  const h = 34 + rows * 31 + (onPoint && c.kind === 'bezier' ? 9 : 0)
  return ReactDOM.createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={close} onContextMenu={e => { e.preventDefault(); close() }} />
      <div
        data-path-menu=""
        onPointerDown={e => e.stopPropagation()}
        style={{
          position: 'fixed', left: Math.min(at.x, window.innerWidth - 200), top: Math.max(8, Math.min(at.y, window.innerHeight - h - 8)),
          minWidth: 170, zIndex: 9999, background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)', padding: '5px 0', fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ padding: '4px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: 4 }}>
          <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{onPoint ? (many ? `${points.length} points · tangents` : 'Point · tangent') : 'Curve'}</span>
        </div>
        {onPoint && c.kind === 'bezier' && MODES.filter(m => m.mode !== 'auto' || c.smooth).map(m => (
          <button key={m.mode} title={m.tip} style={row} {...hover} onClick={step(() => setTangentMode(m.mode, pickedPoints()))}>
            <span style={{ fontSize: 13, width: 18, textAlign: 'center', color: '#ffe14a' }}>{!many && now === m.mode ? '✓' : ''}</span>
            {m.label}
          </button>
        ))}
        {onPoint && c.kind === 'bezier' && <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '4px 0' }} />}
        {onPoint && (
          <button style={{ ...row, color: '#f87171' }} {...hover} onClick={step(() => { deletePickedPoints() })}>
            <span style={{ fontSize: 14, width: 18, textAlign: 'center' }}>🗑️</span>{many ? `Delete ${points.length} points` : 'Delete point'}
          </button>
        )}
        {!onPoint && c.kind === 'bezier' && (
          <button style={row} {...hover} onClick={step(() => { insertPoint(at.id, at.seg ?? 0, at.t ?? 0.5) })}>
            <span style={{ fontSize: 14, width: 18, textAlign: 'center' }}>＋</span>Add point here
          </button>
        )}
        {!onPoint && c.kind === 'bezier' && (
          <button style={row} {...hover} onClick={() => { close(); selectAllPoints(at.id) }}>
            <span style={{ fontSize: 14, width: 18, textAlign: 'center' }}>▣</span>Select all points
          </button>
        )}
        {!onPoint && (
          <button style={{ ...row, color: '#f87171' }} {...hover} onClick={step(() => {
            useNotesStore.getState().deleteCurves([at.id])
            useNotesUi.setState(u => ({ selected: u.selected.filter(x => x !== at.id), points: [] }))
          })}>
            <span style={{ fontSize: 14, width: 18, textAlign: 'center' }}>🗑️</span>Delete curve
          </button>
        )}
      </div>
    </>,
    document.body,
  )
}
