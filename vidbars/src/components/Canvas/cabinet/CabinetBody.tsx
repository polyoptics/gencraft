// CabinetBody — the project cabinet's face: a stack of drawer fronts, and the
// open drawer's tray below them. Pressing a front moves the cabinet like any
// tile; a plain click opens it (FreeNode's release, utils/cabinet toggleDrawer,
// since the press captures the pointer on the tile). The tray lies on the canvas
// just below the face, so it covers the same patch in the flat and tilted views.

import React, { useState } from 'react'
import ReactDOM from 'react-dom'
import type { FreeNodeData } from '../../../store/freeNodeStore'
import { useUndoCoordinator } from '../../../store/undoCoordinator'
import { cssUrl } from '../../../utils/diskUrl'
import { useResolvedMedia } from '../../../utils/useResolvedMedia'
import { cabinetDrawerAt, canvasPointAt, moveItem, renameDrawer, takeOutAt, useCabinetUi } from '../../../utils/cabinet'
import type { CabinetItem } from '../../../utils/cabinetData'

const TILE_RATIO = 2 / 3
/** The tile in a drag's hand, screen px: the same at any zoom. */
const GHOST_W = 132

const ItemFace: React.FC<{ item: CabinetItem; width: number; fontSize: number }> = ({ item, width, fontSize }) => {
  const thumb = useResolvedMedia(item.thumb)
  const count = item.kind === 'card' ? item.groups.length : item.nodes.length
  return (
    <div style={{
      position: 'relative', width, height: width * TILE_RATIO, boxSizing: 'border-box',
      borderRadius: width * 0.07, overflow: 'hidden', background: item.color,
      border: '1px solid rgba(255,255,255,0.18)', boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
    }}>
      {thumb && (
        <div style={{
          position: 'absolute', inset: 0, opacity: 0.72,
          backgroundImage: cssUrl(thumb), backgroundSize: 'cover', backgroundPosition: 'center top',
        }} />
      )}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, padding: `${fontSize * 0.25}px ${fontSize * 0.5}px`,
        background: 'rgba(0,0,0,0.5)', color: '#fff', fontSize, fontWeight: 600,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{count > 1 ? `${item.name} (${count})` : item.name}</div>
    </div>
  )
}

const TrayItem: React.FC<{ item: CabinetItem; nodeId: string; drawerId: string; width: number; fontSize: number }> = ({ item, nodeId, drawerId, width, fontSize }) => {
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const sx = e.clientX, sy = e.clientY
    let moved = false
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
      moved = true
      setGhost({ x: ev.clientX, y: ev.clientY })
      const d = cabinetDrawerAt(ev.clientX, ev.clientY)
      useCabinetUi.getState().setAim(d ? `${d.nodeId}:${d.drawerId}` : null)
    }
    const end = (ev: PointerEvent, drop: boolean) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      setGhost(null)
      useCabinetUi.getState().setAim(null)
      if (!moved || !drop) return
      const to = cabinetDrawerAt(ev.clientX, ev.clientY)
      if (to) {
        if (to.nodeId === nodeId && to.drawerId === drawerId) return
        useUndoCoordinator.getState().checkpoint()
        moveItem({ nodeId, drawerId }, item.id, to)
        return
      }
      const at = canvasPointAt(ev.clientX, ev.clientY, !ev.isTrusted)
      if (!at) return
      useUndoCoordinator.getState().checkpoint()
      takeOutAt(nodeId, drawerId, item.id, at.cx, at.cy)
    }
    const onUp = (ev: PointerEvent) => end(ev, true)
    const onCancel = (ev: PointerEvent) => end(ev, false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }
  return (
    <div
      data-cabinet-item={item.id}
      onPointerDown={onPointerDown}
      title={`${item.name}: drag onto the canvas to take it out`}
      style={{ cursor: 'grab', touchAction: 'none', opacity: ghost ? 0.35 : 1 }}
    >
      <ItemFace item={item} width={width} fontSize={fontSize} />
      {ghost && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', left: ghost.x - GHOST_W / 2, top: ghost.y - GHOST_W * TILE_RATIO / 2,
          zIndex: 9999, pointerEvents: 'none', transform: 'rotate(-2deg)',
        }}>
          <ItemFace item={item} width={GHOST_W} fontSize={11} />
        </div>,
        document.body,
      )}
    </div>
  )
}

export const CabinetBody: React.FC<{ id: string; node: FreeNodeData; hovered: boolean }> = ({ id, node, hovered }) => {
  const aim = useCabinetUi(s => s.aim)
  const [renaming, setRenaming] = useState<{ drawerId: string; value: string } | null>(null)
  const cabinet = node.cabinet
  if (!cabinet) return null
  // Everything is sized by the cabinet: it is an object on the canvas, and
  // grows and shrinks with it as a tile's contents do.
  const u = node.width / 320
  const open = cabinet.drawers.find(d => d.id === cabinet.open)
  const commit = () => {
    if (renaming?.value.trim()) {
      useUndoCoordinator.getState().checkpoint()
      renameDrawer(id, renaming.drawerId, renaming.value.trim())
    }
    setRenaming(null)
  }
  const tileW = 92 * u
  const gap = 8 * u
  return (
    <>
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 5 * u, padding: 7 * u,
        background: 'linear-gradient(180deg, #2a2c40 0%, #1d1f2f 100%)',
      }}>
        {cabinet.drawers.map(d => {
          const isOpen = d.id === cabinet.open
          const aimed = aim === `${id}:${d.id}`
          return (
            <div
              key={d.id}
              data-cabinet-front={d.id}
              data-cabinet-drawer={`${id}:${d.id}`}
              title={isOpen ? 'Click to close' : 'Click to open'}
              style={{
                flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', gap: 8 * u, padding: `0 ${10 * u}px`,
                boxSizing: 'border-box', borderRadius: 5 * u,
                background: aimed ? 'rgba(120,180,255,0.32)' : isOpen ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.06)',
                border: `${Math.max(1, 1.5 * u)}px solid ${aimed ? 'rgba(120,180,255,0.95)' : 'rgba(255,255,255,0.12)'}`,
                boxShadow: '0 1px 2px rgba(0,0,0,0.45)',
                transition: 'background 0.1s, border-color 0.1s',
              }}
            >
              {renaming?.drawerId === d.id ? (
                <input
                  autoFocus
                  value={renaming.value}
                  onChange={e => setRenaming({ drawerId: d.id, value: e.target.value })}
                  onBlur={commit}
                  onKeyDown={e => {
                    e.stopPropagation()
                    if (e.key === 'Enter') commit()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  onPointerDown={e => e.stopPropagation()}
                  style={{
                    flex: 1, minWidth: 0, background: 'rgba(0,0,0,0.3)', border: 'none', outline: 'none',
                    color: '#fff', fontSize: 14 * u, fontFamily: 'inherit', padding: `${2 * u}px ${4 * u}px`,
                  }}
                />
              ) : (
                <span style={{
                  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  color: 'rgba(255,255,255,0.86)', fontSize: 14 * u, fontWeight: 600, userSelect: 'none',
                }}>{d.label}</span>
              )}
              {hovered && !renaming && (
                <button
                  title="Rename this drawer"
                  onClick={() => setRenaming({ drawerId: d.id, value: d.label })}
                  style={{
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer', lineHeight: 1,
                    color: 'rgba(255,255,255,0.55)', fontSize: 12 * u,
                  }}
                >✎</button>
              )}
              {d.items.length > 0 && (
                <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 * u, fontVariantNumeric: 'tabular-nums', userSelect: 'none' }}>
                  {d.items.length}
                </span>
              )}
              {/* The pull. */}
              <span style={{ width: 34 * u, height: 5 * u, borderRadius: 3 * u, background: 'rgba(255,255,255,0.32)', flexShrink: 0 }} />
            </div>
          )
        })}
      </div>
      {open && (
        <div
          data-cabinet-tray
          data-cabinet-drawer={`${id}:${open.id}`}
          onWheel={e => e.stopPropagation()}
          style={{
            position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4 * u,
            boxSizing: 'border-box', minHeight: tileW * TILE_RATIO + gap * 2, maxHeight: node.height * 1.6,
            overflowY: 'auto', padding: gap, display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap,
            borderRadius: 7 * u,
            background: aim === `${id}:${open.id}` ? 'rgba(46,62,92,0.97)' : 'rgba(22,23,36,0.97)',
            border: `${Math.max(1, 1.5 * u)}px solid rgba(255,255,255,0.14)`,
            boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
          }}
        >
          {open.items.map(item => (
            <TrayItem key={item.id} item={item} nodeId={id} drawerId={open.id} width={tileW} fontSize={11 * u} />
          ))}
          {open.items.length === 0 && (
            <span style={{ margin: 'auto', color: 'rgba(255,255,255,0.4)', fontSize: 12 * u, userSelect: 'none' }}>
              Drag cards here to put them away
            </span>
          )}
        </div>
      )}
    </>
  )
}
