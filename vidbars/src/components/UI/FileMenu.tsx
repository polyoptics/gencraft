// FileMenu — the standalone "Show in Explorer / Copy path / Open" menu, for
// media inside something whose own menu is about something else (a Media
// Pool tile, a Rolodex slot, the Viewer). Desktop app only. The items, the
// gate (mayHaveDiskFile) and the hook for existing menus live in
// hooks/useFileMenu.ts.

import React, { useEffect } from 'react'
import ReactDOM from 'react-dom'
import { fileMenuItemsFor, useResolvedFile } from '../../hooks/useFileMenu'

const stop = (e: React.SyntheticEvent) => { e.stopPropagation() }

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/** Styled like the app's other context menus. Closes itself when the url
 *  turns out to have no file behind it. */
export const FileContextMenu: React.FC<{
  x: number
  y: number
  url: string
  onClose: () => void
}> = ({ x, y, url, onClose }) => {
  const { resolved, done } = useResolvedFile(url)
  const items = fileMenuItemsFor(resolved, onClose)

  useEffect(() => {
    if (done && !resolved) onClose()
  }, [done, resolved, onClose])

  if (!resolved || items.length === 0) return null

  // Both layers swallow every pointer, mouse, click and wheel event: React
  // bubbles portal events to the component that RENDERED them, so without
  // this a click here would select the tile underneath, a double-click
  // would place it, and a wheel would scroll its panel. (An ancestor's
  // capture-phase handler still sees them first — the Viewer renders this
  // as a sibling for that reason.)
  const swallow = {
    onPointerUp: stop, onMouseDown: stop, onMouseUp: stop,
    onClick: stop, onDoubleClick: stop, onWheel: stop,
  }
  const menuH = 36 + items.length * 32
  return ReactDOM.createPortal(
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
        {...swallow}
        onPointerDown={e => { e.stopPropagation(); onClose() }}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onClose() }}
      />
      <div
        {...swallow}
        onPointerDown={stop}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation() }}
        style={{
          position: 'fixed',
          left: Math.max(4, Math.min(x, window.innerWidth - 210)),
          top: Math.max(4, Math.min(y, window.innerHeight - menuH - 8)),
          width: 200, zIndex: 9999,
          background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
          padding: '5px 0', fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div
          title={resolved.path}
          style={{
            padding: '4px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: 4,
            color: 'rgba(255,255,255,0.4)', fontSize: 11,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {fileName(resolved.path)}
        </div>
        {items.map(item => (
          <button
            key={item.label}
            onClick={e => { e.stopPropagation(); item.action() }}
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
    document.body,
  )
}
