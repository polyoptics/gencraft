import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useBoardCtx } from '../../contexts/BoardContext'
import { useBoardsStore } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { getFirstMediaSource } from '../../types/bar'
import { useFileMenuItems } from '../../hooks/useFileMenu'
import { useMenuClamp } from '../../hooks/useMenuClamp'

interface Props {
  x: number
  y: number
  barId: string
  onClose: () => void
  onStartRename: () => void
  onOpenColorPicker: () => void
  onEditImage?: () => void
}

export const ContextMenu: React.FC<Props> = ({
  x, y, barId, onClose, onStartRename, onOpenColorPicker, onEditImage,
}) => {
  const ctx = useBoardCtx()
  const bar = ctx.bars[barId]
  // The file behind the bar's picture (desktop only; [] in a browser).
  const fileItems = useFileMenuItems(getFirstMediaSource(bar?.content), onClose)
  const { ref: menuRef, top: ay } = useMenuClamp(y, `${barId}:${fileItems.length}`)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const tid = setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => { clearTimeout(tid); document.removeEventListener('mousedown', close) }
  }, [onClose, menuRef])

  if (!bar) return null

  const items = [
    {
      label: 'Rename', icon: '✏️',
      action: () => { onStartRename(); onClose() },
    },
    {
      label: 'Set Color', icon: '🎨',
      action: () => { onOpenColorPicker(); onClose() },
    },
    {
      label: 'Add Parent Above', icon: '↑',
      action: () => { useUndoCoordinator.getState().checkpoint(); ctx.addParentAbove(barId); onClose() },
    },
    ...(bar.content.images.length > 0 || (bar.content.media && bar.content.media.length > 0) ? [
      ...(onEditImage ? [{ label: 'Edit Image', icon: '✂️', action: () => { onClose(); onEditImage() } }] : []),
      { label: 'Remove Image', icon: '🖼', action: () => { useUndoCoordinator.getState().checkpoint(); ctx.setContent(barId, { images: [], media: [] }); onClose() } },
    ] : []),
    { sep: true },
    {
      label: 'Extract to Block', icon: '📤',
      action: () => { useUndoCoordinator.getState().checkpoint(); useBoardsStore.getState().extractBarToBoard(ctx.boardId, barId); onClose() },
    },
    {
      label: 'Open Viewer', icon: '▶️',
      action: () => { ctx.openViewer(barId); onClose() },
    },
    { sep: true },
    {
      label: 'Delete Node', icon: '🗑️',
      action: () => { useUndoCoordinator.getState().checkpoint(); ctx.deleteBar(barId); onClose() },
      danger: true,
    },
    {
      label: 'Delete + Children', icon: '⛔',
      action: () => { useUndoCoordinator.getState().checkpoint(); ctx.deleteSubtree(barId); onClose() },
      danger: true,
    },
    ...fileItems.flatMap(({ separator, label, icon, action }) =>
      separator ? [{ sep: true }, { label, icon, action }] : [{ label, icon, action }]),
  ]

  const menuW = 200
  const ax = Math.min(x, window.innerWidth - menuW - 8)

  return createPortal(
    <div
      ref={menuRef}
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: 'fixed', left: ax, top: ay, width: menuW,
        background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
        zIndex: 9999, padding: '5px 0', fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ padding: '4px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: 4 }}>
        <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{bar.name}</span>
      </div>

      {items.map((item, i) => {
        if ('sep' in item && item.sep) {
          return <div key={i} style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '4px 0' }} />
        }
        if (!('label' in item)) return null
        return (
          <button
            key={item.label}
            onClick={item.action}
            style={{
              display: 'flex', alignItems: 'center', gap: 9,
              width: '100%', padding: '7px 14px',
              background: 'none', border: 'none', cursor: 'pointer',
              color: item.danger ? '#f87171' : '#e2e8f0',
              fontSize: 13, textAlign: 'left', borderRadius: 4,
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            <span style={{ fontSize: 14, width: 18, textAlign: 'center' }}>{item.icon}</span>
            {item.label}
          </button>
        )
      })}
    </div>,
    document.body
  )
}
