// The cards this card is used in (its back-refs: factions, families and any
// card that links to it), as one dot in its header bar (Brian 2026-11-05:
// the chips crowded the bar's icons). Click: a list of them; click one to
// jump to it.

import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { getBackRefs } from '../../utils/linkRefs'
import { cardTitle } from '../../utils/faceStyle'

export const BackRefDot: React.FC<{ groupId: string; size: number }> = ({ groupId, size }) => {
  const refs = useBoardsStore(useShallow(s => getBackRefs(groupId, s.groups)
    .map(id => s.groups.find(g => g.id === id))
    .filter(Boolean)
    .map(g => ({ id: g!.id, color: g!.color || '#5b8dd9', title: cardTitle(s.groups, g!) || g!.name || 'card' }))
    .map(r => `${r.id}\u0000${r.color}\u0000${r.title}`)))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: PointerEvent) => { if (!(e.target as Element).closest?.('[data-backref-menu]')) setMenu(null) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', esc) }
  }, [menu])
  if (!refs.length) return null
  const list = refs.map(r => { const [id, color, title] = r.split('\u0000'); return { id, color, title } })
  const d = size * 0.55
  return (
    <>
      <div
        data-backref-dot
        title={`Used in: ${list.map(r => r.title).join(', ')}`}
        onPointerDown={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); setMenu(menu ? null : { x: e.clientX, y: e.clientY }) }}
        style={{
          flex: '0 0 auto', width: size, height: size,
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}
      >
        <div style={{ width: d, height: d, borderRadius: '50%', background: list[0].color, boxShadow: '0 0 0 1px rgba(0,0,0,0.35)' }} />
      </div>
      {menu && ReactDOM.createPortal(
        <div
          data-backref-menu
          onPointerDown={e => e.stopPropagation()}
          onWheel={e => e.stopPropagation()}
          style={{
            position: 'fixed', left: menu.x + 6, top: menu.y + 8, zIndex: 10000,
            minWidth: 140, maxHeight: 320, overflowY: 'auto', padding: 4,
            background: 'rgba(24,26,36,0.97)', border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 8, boxShadow: '0 8px 28px rgba(0,0,0,0.55)',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <div style={{ padding: '4px 8px 6px', fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: 'rgba(255,255,255,0.45)' }}>USED IN</div>
          {list.map(r => (
            <div
              key={r.id}
              onClick={() => { setMenu(null); useCanvasStore.getState().jumpToGroup(r.id) }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 12, color: 'rgba(255,255,255,0.88)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <div style={{ width: 9, height: 9, borderRadius: '50%', background: r.color, flexShrink: 0 }} />
              <span style={{ whiteSpace: 'nowrap' }}>{r.title}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
