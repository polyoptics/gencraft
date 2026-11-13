// A card's tray (Brian 2026-11-13): "that tray-like interface could be
// pulled down from the bottom of a card, and inside of it ... all the linked
// cards and you could scroll-wheel through them, use the different view
// modes, and search through them", "sizeable along the bottom of the host
// card ... if you just want to see small card tops to flip through".
//
// It IS the Card Browser (CardRolodex), in a box under the card, listing
// what the card holds and the cards linked with it (utils/browserScope
// trayIds). The browser sizes its cards to the box's width, so a narrow
// tray is small card tops and a wide one big cards.
//
// TrayGrip (in the chip rail, beside the "+"): pull it down and the tray
// comes with the mouse and stays; click: open / shut. The tray's bottom
// edge pulls it longer or shorter, its bottom-right corner sizes both ways.
// How it is left is kept for the session (trayStore), not saved.

import React from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useTrayStore } from '../../store/trayStore'
import { trayIds } from '../../utils/browserScope'
import { useCardView } from '../Layers/cardView'
import { CardRolodex } from '../Rolodex/CardRolodex'

const CHIP_H = 24        // as the rail's chips
const OPEN_PX = 260      // how far a click opens it, screen px
const SHUT_PX = 24       // pulled shorter than this, it shuts
const MIN_W_PX = 70
const EDGE = 9           // the bottom edge's grip, px

/** How many cards card `id`'s tray would list. */
function useTrayCount(id: string): number {
  return useBoardsStore(s => trayIds(s.groups.find(g => g.id === id), s.groups).length)
}

/** Drag: the tray's height (and width) follow the pointer; let go, it stays. */
function dragTray(e: React.PointerEvent, cardId: string, zoom: number, from: { hPx: number; wPx?: number }, onClick?: () => void) {
  if (e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  const x0 = e.clientX, y0 = e.clientY
  let moved = false
  const onMove = (ev: PointerEvent) => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0
    if (!moved && Math.hypot(dx, dy) < 3) return
    moved = true
    const h = from.hPx + dy
    useTrayStore.getState().setSize(cardId, {
      h: h < SHUT_PX ? 0 : h / zoom,
      ...(from.wPx !== undefined ? { w: Math.max(MIN_W_PX, from.wPx + dx) / zoom } : {}),
    })
  }
  const done = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', done)
  }
  const onUp = () => { done(); if (!moved) onClick?.() }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', done)
}

/** The tray's grip, a chip in the card's rail: how many cards it lists.
 *  Only on a card that has any. Lit while the tray is out. */
export const TrayGrip: React.FC<{ cardId: string }> = ({ cardId }) => {
  const n = useTrayCount(cardId)
  const h = useTrayStore(s => s.trays[cardId]?.h ?? 0)
  const { zoom } = useCardView()
  if (!n) return null
  const open = h > 0
  return (
    <div
      data-tray-grip={cardId}
      title={`${n} card${n === 1 ? '' : 's'}: pull down for the tray, click to open or shut it`}
      onPointerDown={e => dragTray(e, cardId, zoom, { hPx: h * zoom },
        () => useTrayStore.getState().setSize(cardId, { h: open ? 0 : OPEN_PX / zoom }))}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      style={{
        height: CHIP_H, boxSizing: 'border-box', flex: '0 0 auto',
        display: 'flex', alignItems: 'center', gap: 4, padding: '0 8px 0 7px',
        borderRadius: 6,
        background: open ? 'rgba(120,170,255,0.32)' : 'rgba(255,255,255,0.1)',
        border: open ? '1.5px solid rgba(160,200,255,0.75)' : '1.5px solid rgba(255,255,255,0.35)',
        color: 'rgba(255,255,255,0.9)', fontSize: 11, fontWeight: 600,
        cursor: 'ns-resize', userSelect: 'none', touchAction: 'none',
      }}
    >
      <svg width="11" height="10" viewBox="0 0 11 10" style={{ flexShrink: 0 }}>
        <path d="M1 1h9v5.5a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z M3.5 4h4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      {n}
    </div>
  )
}

/** How far card `id`'s tray reaches below where it starts, screen px
 *  (0: shut, or nothing to list). */
export function useTrayReach(id: string, zoom: number): number {
  const h = useTrayStore(s => s.trays[id]?.h ?? 0)
  const n = useTrayCount(id)
  return n && h > 0 ? h * zoom + 6 : 0
}

/** The tray: the browser in its box, under the card (and under its feet).
 *  `left`/`top` are screen px, `cardWidth` the card's width there. */
export const CardTray: React.FC<{ cardId: string; left: number; top: number; cardWidth: number }> = ({ cardId, left, top, cardWidth }) => {
  const tray = useTrayStore(s => s.trays[cardId])
  const n = useTrayCount(cardId)
  const { pan, zoom } = useCardView()
  if (!tray || tray.h <= 0 || !n) return null
  const hPx = tray.h * zoom
  const wPx = Math.max(MIN_W_PX, tray.w !== undefined ? tray.w * zoom : cardWidth)
  return (
    <div
      data-card-tray={cardId}
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onContextMenu={e => e.stopPropagation()}
      style={{
        position: 'absolute', left, top, width: wPx, height: hPx, zIndex: 56,
        pointerEvents: 'auto', boxSizing: 'border-box',
        borderRadius: '0 0 10px 10px', overflow: 'hidden',
        background: 'rgba(18,20,30,0.97)',
        border: '1px solid rgba(255,255,255,0.22)', borderTop: 'none',
        boxShadow: 'inset 0 9px 8px -6px rgba(0,0,0,0.7), 0 6px 18px rgba(0,0,0,0.5)',
      }}
    >
      <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: EDGE, overflow: 'hidden' }}>
        <CardRolodex
          embedded={{ nodeId: `tray:${cardId}` }}
          tray={{ cardId, x: (left - pan.x) / zoom, y: (top - pan.y) / zoom, width: wPx / zoom, height: (hPx - EDGE) / zoom }}
        />
      </div>
      {/* Its bottom edge: longer or shorter. Its corner: wider too. */}
      <div
        data-tray-edge
        title="Drag to pull the tray longer or shorter"
        onPointerDown={e => dragTray(e, cardId, zoom, { hPx })}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: EDGE, cursor: 'ns-resize', touchAction: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.05)' }}
      >
        <div style={{ width: 26, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.35)' }} />
      </div>
      <div
        data-tray-corner
        title="Drag to size the tray"
        onPointerDown={e => dragTray(e, cardId, zoom, { hPx, wPx })}
        style={{ position: 'absolute', right: 0, bottom: 0, width: 14, height: 14, cursor: 'nwse-resize', touchAction: 'none' }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14"><path d="M12 5v7H5" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </div>
    </div>
  )
}
