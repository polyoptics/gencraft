// StickMenu — the font list of a measuring stick's number (Brian
// 2026-11-18: "the number in a font I can pick by double-clicking the
// text"). Opened by utils/stickTool where the number was double-clicked;
// laid out as a curve's menu (PathMenu). Picking one is one undo step.

import React from 'react'
import ReactDOM from 'react-dom'
import { useNotesStore } from '../../store/notesStore'
import { useStickUi } from '../../store/pathLive'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { FONT_LIST, ensureFontLoaded } from '../UI/TextFormatToolbar'
import { DEFAULT_FONT } from '../../utils/stickGeom'

const H = 340

export const StickMenu: React.FC = () => {
  const at = useStickUi(s => s.fonts)
  const stick = useNotesStore(s => at ? s.sticks?.[at.id] : undefined)
  if (!at || !stick) return null
  const close = () => useStickUi.setState({ fonts: null })
  const now = stick.font ?? DEFAULT_FONT
  const pick = (value: string) => {
    close()
    useUndoCoordinator.getState().checkpoint()
    ensureFontLoaded(value)
    useNotesStore.getState().updateStick(stick.id, { font: value === DEFAULT_FONT ? undefined : value })
  }
  return ReactDOM.createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={close} onContextMenu={e => { e.preventDefault(); close() }} />
      <div
        data-path-menu=""
        onPointerDown={e => e.stopPropagation()}
        onWheel={e => e.stopPropagation()}
        style={{
          position: 'fixed', left: Math.min(at.x, window.innerWidth - 210), top: Math.max(8, Math.min(at.y, window.innerHeight - H - 8)),
          width: 190, maxHeight: H, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.25) transparent', zIndex: 9999, background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)', padding: '5px 0', fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ padding: '4px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: 4 }}>
          <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>Number · font</span>
        </div>
        {FONT_LIST.map(f => (
          <button key={f.value}
            onMouseEnter={e => { ensureFontLoaded(f.value); e.currentTarget.style.background = 'rgba(255,255,255,0.07)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
            onClick={() => pick(f.value)}
            style={{
              display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '6px 14px', background: 'none', border: 'none',
              cursor: 'pointer', color: '#e2e8f0', fontSize: 14, textAlign: 'left', whiteSpace: 'nowrap', fontFamily: f.value,
            }}>
            <span style={{ fontSize: 13, width: 14, textAlign: 'center', color: '#ffe14a', fontFamily: 'system-ui, sans-serif' }}>{now === f.value ? '✓' : ''}</span>
            {f.label}
          </button>
        ))}
      </div>
    </>,
    document.body,
  )
}
