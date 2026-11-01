// CabinetBody — the project cabinet's face: a stack of drawer fronts, and the
// open drawer's tray below them. Pressing a front moves the cabinet like any
// tile; a plain click opens it (FreeNode's release, utils/cabinet toggleDrawer,
// since the press captures the pointer on the tile). The tray lies on the canvas
// just below the face, so it covers the same patch in the flat and tilted views.

import React, { useLayoutEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import type { FreeNodeData } from '../../../store/freeNodeStore'
import { isTilted, useTiltStore } from '../../../store/tiltStore'
import { useFreeNodeStore } from '../../../store/freeNodeStore'
import { useCanvasStore } from '../../../store/canvasStore'
import { useUndoCoordinator } from '../../../store/undoCoordinator'
import { cssUrl } from '../../../utils/diskUrl'
import { useResolvedMedia } from '../../../utils/useResolvedMedia'
import { cabinetDrawerAt, canvasPointAt, drawerName, itemPicture, itemWords, moveDrawer, moveItem, renameDrawer, setDrawerLength, takeOutAt, useCabinetUi } from '../../../utils/cabinet'
import type { CabinetItem } from '../../../utils/cabinetData'
import { RenameInput } from '../../UI/RenameInput'
import { DrawerStatus, EmptyDrawerActions, FrontPicture, ProjectTray } from './ProjectTray'

/** The tile in a drag's hand, screen px high: the same at any zoom. */
const GHOST_H = 110

/** A tiny picture of what is put away, in its real shape: its image, or its
 *  words where it has none. Never just a name (Brian 2026-10-30). */
const ItemFace: React.FC<{ item: CabinetItem; height: number }> = ({ item, height }) => {
  const picture = useResolvedMedia(itemPicture(item))
  const words = itemWords(item)
  const count = item.kind === 'card' ? item.groups.length : item.nodes.length
  const aspect = Math.min(2.4, Math.max(0.4, item.w / Math.max(1, item.h)))
  const width = height * aspect
  const radius = height * 0.07
  const face: React.CSSProperties = {
    position: 'absolute', inset: 0, boxSizing: 'border-box', borderRadius: radius, background: item.color,
    border: '1px solid rgba(255,255,255,0.18)',
  }
  return (
    <div style={{ position: 'relative', width, height, flexShrink: 0 }}>
      {/* A deck shows as a deck: its edges peek out behind the face. */}
      {count > 1 && <div style={{ ...face, transform: `translate(${height * 0.05}px, ${height * 0.03}px)`, opacity: 0.55 }} />}
      <div style={{ ...face, overflow: 'hidden', boxShadow: '0 1px 5px rgba(0,0,0,0.5)' }}>
        {picture ? (
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage: cssUrl(picture), backgroundSize: 'cover', backgroundPosition: 'center',
          }} />
        ) : (
          <div style={{
            padding: height * 0.05, color: 'rgba(255,255,255,0.85)', fontSize: height * 0.085,
            lineHeight: 1.25, overflow: 'hidden', height: '100%', boxSizing: 'border-box', wordBreak: 'break-word',
          }}>{words || item.name}</div>
        )}
      </div>
    </div>
  )
}

/** A drawer slides out when it opens. The `scale` property, as the tilted view
 *  writes this element's transform. */
const slideOut = (el: HTMLDivElement | null) => {
  el?.animate({ scale: ['1 0', '1 1'], transformOrigin: ['50% 0%', '50% 0%'] }, { duration: 170, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' })
}

/** A press that follows the pointer until let go. */
function follow(e: React.PointerEvent, onMove: (ev: PointerEvent) => void) {
  e.stopPropagation()
  e.preventDefault()
  useUndoCoordinator.getState().checkpoint()
  const end = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
}

const TrayItem: React.FC<{ item: CabinetItem; nodeId: string; drawerId: string; height: number }> = ({ item, nodeId, drawerId, height }) => {
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
      <ItemFace item={item} height={height} />
      {ghost && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', left: ghost.x - GHOST_H * 0.4, top: ghost.y - GHOST_H / 2,
          zIndex: 9999, pointerEvents: 'none', transform: 'rotate(-2deg)',
        }}>
          <ItemFace item={item} height={GHOST_H} />
        </div>,
        document.body,
      )}
    </div>
  )
}

export const CabinetBody: React.FC<{ id: string; node: FreeNodeData }> = ({ id, node }) => {
  const aim = useCabinetUi(s => s.aim)
  // A double-click on a name asks for this (FreeNode, as the press captures
  // the pointer); the field keeps its own text while it is open.
  const renamingId = useCabinetUi(s => s.renaming?.startsWith(`${id}:`) ? s.renaming.slice(id.length + 1) : null)
  const [draft, setDraft] = useState<string | null>(null)
  const tilted = useTiltStore(s => isTilted(s.tilt))
  // Where the open drawer's front ends: its tray comes out from there, over the
  // drawers below it. Flat, that is this tray's top. Tilted, it keeps its place
  // in the layout and TiltLayer carries it up the standing face to the same spot.
  const facesRef = useRef<HTMLDivElement>(null)
  const [drawerEnd, setDrawerEnd] = useState<number | null>(null)
  useLayoutEffect(() => {
    const front = facesRef.current?.querySelector<HTMLElement>(`[data-cabinet-front="${node.cabinet?.open}"]`)
    const box = facesRef.current?.parentElement
    if (!front || !box) { setDrawerEnd(null); return }
    let top = front.offsetTop + front.offsetHeight
    for (let e = front.offsetParent as HTMLElement | null; e && e !== box && box.contains(e); e = e.offsetParent as HTMLElement | null) top += e.offsetTop
    setDrawerEnd(top)
  }, [node.cabinet?.open, node.height, node.width, node.cabinet?.drawers.length])
  const cabinet = node.cabinet
  if (!cabinet) return null
  // Everything is sized by the cabinet: it is an object on the canvas, and
  // grows and shrinks with it as a tile's contents do.
  const u = node.width / 320
  const open = cabinet.drawers.find(d => d.id === cabinet.open)
  const stopRenaming = () => { setDraft(null); useCabinetUi.getState().setRenaming(null) }
  const commit = (drawerId: string, greyDefault: string | null) => {
    // Left as its grey default, or left empty, it stays that grey default.
    if (draft !== null) {
      useUndoCoordinator.getState().checkpoint()
      renameDrawer(id, drawerId, draft.trim() === greyDefault ? '' : draft.trim())
    }
    stopRenaming()
  }
  const tileH = 62 * u
  // A drawer's handle moves it up and down the cabinet: it takes the place of
  // whichever drawer the pointer comes over.
  const onPullDown = (e: React.PointerEvent, drawerId: string) => {
    if (e.button !== 0) return
    follow(e, ev => {
      const over = document.elementsFromPoint(ev.clientX, ev.clientY)
        .map(el => el.closest<HTMLElement>('[data-cabinet-front]')?.dataset.cabinetFront).find(Boolean)
      const c = useFreeNodeStore.getState().nodes[id]?.cabinet
      const to = c?.drawers.findIndex(d => d.id === over) ?? -1
      if (to >= 0) moveDrawer(id, drawerId, to)
    })
  }
  // The bottom edge of the tray pulls the drawer out, as far as you like.
  const onLengthDown = (e: React.PointerEvent, drawerId: string) => {
    if (e.button !== 0) return
    const tray = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-cabinet-tray]')
    const start = tray?.offsetHeight ?? 0
    const y0 = e.clientY
    follow(e, ev => {
      const dy = (ev.clientY - y0) / useCanvasStore.getState().zoom
      setDrawerLength(id, drawerId, Math.max(tileH + 24 * u, start + dy))
    })
  }
  const gap = 8 * u
  return (
    <>
      <div ref={facesRef} style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 5 * u, padding: 7 * u,
        background: 'linear-gradient(180deg, #2a2c40 0%, #1d1f2f 100%)',
      }}>
        {cabinet.drawers.map((d, i) => {
          const name = drawerName(d, i)
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
                // An open drawer leaves a dark opening in the cabinet.
                background: aimed ? 'rgba(120,180,255,0.32)' : isOpen ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.06)',
                border: `${Math.max(1, 1.5 * u)}px solid ${aimed ? 'rgba(120,180,255,0.95)' : 'rgba(255,255,255,0.12)'}`,
                boxShadow: '0 1px 2px rgba(0,0,0,0.45)',
                transition: 'background 0.1s, border-color 0.1s',
              }}
            >
              {renamingId === d.id ? (
                <RenameInput
                  value={draft ?? name.text}
                  onChange={e => setDraft(e.target.value)}
                  onBlur={() => commit(d.id, name.ghost ? name.text : null)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commit(d.id, name.ghost ? name.text : null)
                    if (e.key === 'Escape') stopRenaming()
                  }}
                  style={{ flex: 1, minWidth: 0, height: 18 * u, fontSize: 14 * u, border: 'none', padding: 0 }}
                />
              ) : (
                <span data-cabinet-label={d.id} style={{
                  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  color: name.ghost ? 'rgba(255,255,255,0.38)' : 'rgba(255,255,255,0.86)',
                  fontSize: 14 * u, fontWeight: name.ghost ? 500 : 600, userSelect: 'none',
                }}>{name.text}</span>
              )}
              <span style={{ flex: 1 }} />
              {d.project && <FrontPicture map={d.project.map} height={24 * u} dim={!!d.project.out} />}
              {d.items.length > 0 && (
                <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 * u, fontVariantNumeric: 'tabular-nums', userSelect: 'none' }}>
                  {d.items.length}
                </span>
              )}
              {/* The pull. */}
              <span
                data-cabinet-pull
                onPointerDown={e => onPullDown(e, d.id)}
                title="Drag up or down to move this drawer"
                style={{ padding: `${8 * u}px ${4 * u}px`, cursor: 'ns-resize', flexShrink: 0, touchAction: 'none' }}
              >
                <span style={{ display: 'block', width: 34 * u, height: 5 * u, borderRadius: 3 * u, background: 'rgba(255,255,255,0.32)' }} />
              </span>
            </div>
          )
        })}
      </div>
      {open && (
        <div
          ref={slideOut}
          data-cabinet-tray
          data-cabinet-drawer={`${id}:${open.id}`}
          onWheel={e => e.stopPropagation()}
          style={{
            zIndex: 2, position: 'absolute', left: 0, right: 0, top: !tilted && drawerEnd !== null ? drawerEnd : '100%',
            boxSizing: 'border-box', minHeight: tileH + gap * 2,
            ...(open.trayH ? { height: open.trayH } : { maxHeight: node.height * 1.6 }),
            overflowY: 'auto', padding: gap, display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap,
            borderRadius: 7 * u,
            background: aim === `${id}:${open.id}` ? 'rgba(46,62,92,0.97)' : 'rgba(22,23,36,0.97)',
            border: `${Math.max(1, 1.5 * u)}px solid rgba(255,255,255,0.14)`,
            boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
          }}
        >
          {open.items.map(item => (
            <TrayItem key={item.id} item={item} nodeId={id} drawerId={open.id} height={tileH} />
          ))}
          {open.project
            ? <ProjectTray drawer={{ nodeId: id, drawerId: open.id }} project={open.project} u={u} height={tileH * 2.4} />
            : open.items.length === 0 && <EmptyDrawerActions key={open.id} drawer={{ nodeId: id, drawerId: open.id }} u={u} />}
          <DrawerStatus drawerId={open.id} u={u} />
          {/* Its bottom edge pulls it further out. */}
          <div
            data-cabinet-length
            onPointerDown={e => onLengthDown(e, open.id)}
            title="Drag to pull this drawer further open"
            style={{
              position: 'sticky', bottom: -gap, width: '100%', marginTop: 'auto', height: 12 * u, flexShrink: 0,
              cursor: 'ns-resize', touchAction: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <span style={{ width: 44 * u, height: 3 * u, borderRadius: 2 * u, background: 'rgba(255,255,255,0.28)' }} />
          </div>
        </div>
      )}
    </>
  )
}
