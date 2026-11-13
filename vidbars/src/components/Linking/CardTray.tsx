// A card's tray (Brian 2026-11-13): "that tray-like interface could be
// pulled down from the bottom of a card, and inside of it ... all the linked
// cards and you could scroll-wheel through them ... and search through
// them", "sizeable along the bottom of the host card ... if you just want
// to see small card tops to flip through".
//
// It IS the Card Browser (CardRolodex), in a box under the card, listing
// what the card holds and the cards linked with it (utils/browserScope
// trayIds). The browser sizes its cards to the box's width, so a narrow
// tray is small card tops and a wide one big cards.
//
// The tray is the one thing tucked under a card (Brian: "The tuck is what
// we want to do with the card browser"): shut, its LIP sticks out below the
// card's bottom edge, naming what is in it (TrayLip, in the chip rail's
// wrapper so it rides with the card in 3D). Pull the lip down and the tray
// comes out as far as it is pulled and stays; click: open / shut. The
// tray's bottom edge pulls it longer or shorter, its bottom-right corner
// sizes both ways. How it is left is kept for the session (trayStore).

import React from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useTrayStore } from '../../store/trayStore'
import { trayIds } from '../../utils/browserScope'
import { cardTitle } from '../../utils/faceStyle'
import { useCardView } from '../Layers/cardView'
import { CardRolodex } from '../Rolodex/CardRolodex'

const INSET = 8          // natural sizes: the lip's wrapper scales them with the card
const SEAM = 13          // under the chips, which ride the card's bottom edge
const FOOT = 21          // what the lip shows of itself
/** How far the lip reaches below its card's bottom edge, natural units. */
export const TRAY_LIP = SEAM + FOOT
/** How far in from the card's sides the lip (and the tray) sits, natural units. */
export const TRAY_INSET = INSET
const OPEN_PX = 260      // how far a click opens it, screen px
const SHUT_PX = 24       // pulled shorter than this, it shuts
const MIN_W_PX = 70
const EDGE = 9           // the bottom edge's grip, px
const NAMED = 4          // names on the lip

/** How many cards card `id`'s tray lists. */
export function useTrayCount(id: string): number {
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

/** The tray's lip: the foot of the tray, sticking out under the card's
 *  bottom edge, flat on top and shaded where it goes under. It names the
 *  first cards in the tray and says how many. Only on a card that lists
 *  any. `left`/`top`: the card's bottom-left corner from the rail's own
 *  corner; `width`: the card's width in the lip's natural units. */
export const TrayLip: React.FC<{ cardId: string; left: number; top: number; scale: number; width: number }> = ({ cardId, left, top, scale, width }) => {
  const n = useTrayCount(cardId)
  const names = useBoardsStore(s => trayIds(s.groups.find(g => g.id === cardId), s.groups).slice(0, NAMED)
    .map(id => { const g = s.groups.find(x => x.id === id); return g ? cardTitle(s.groups, g) || g.name || 'card' : '' }).filter(Boolean).join(', '))
  const h = useTrayStore(s => s.trays[cardId]?.h ?? 0)
  const { zoom } = useCardView()
  if (!n) return null
  const open = h > 0
  return (
    <div style={{ position: 'absolute', left, top, width: 0, height: 0 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        <div
          data-tray-lip={cardId}
          title={`${n} card${n === 1 ? '' : 's'} in its tray: pull down to slide it out, click to open or shut it`}
          onPointerDown={e => dragTray(e, cardId, zoom, { hPx: h * zoom },
            () => useTrayStore.getState().setSize(cardId, { h: open ? 0 : OPEN_PX / zoom }))}
          onClick={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          style={{
            position: 'absolute', left: INSET, top: 0, width: Math.max(30, width - 2 * INSET), height: TRAY_LIP, boxSizing: 'border-box',
            display: 'flex', alignItems: 'flex-end',
            borderRadius: open ? 0 : '0 0 9px 9px',
            background: 'linear-gradient(#11131c, #1d2030)',
            border: `1px solid ${open ? 'rgba(160,200,255,0.6)' : 'rgba(255,255,255,0.28)'}`, borderTop: 'none',
            boxShadow: 'inset 0 9px 8px -5px rgba(0,0,0,0.75), 0 2px 5px rgba(0,0,0,0.45)',
            color: 'rgba(255,255,255,0.9)', cursor: 'grab', userSelect: 'none', touchAction: 'none',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <div style={{ height: FOOT, width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px 1px 7px', minWidth: 0 }}>
            <svg width="11" height="10" viewBox="0 0 11 10" style={{ flexShrink: 0, opacity: 0.8 }}>
              <path d="M1 1h9v5.5a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z M3.5 4h4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <span style={{ flex: '1 1 auto', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{names}</span>
            <span style={{ flex: '0 0 auto', fontSize: 10, fontWeight: 600, opacity: 0.7 }}>{n}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/** How far card `id`'s tray and its lip reach below the card, screen px
 *  (`scale`: the lip's). 0: nothing to list. */
export function useTrayReach(id: string, zoom: number, scale: number): number {
  const h = useTrayStore(s => s.trays[id]?.h ?? 0)
  const n = useTrayCount(id)
  return n ? TRAY_LIP * scale + (h > 0 ? h * zoom + 6 : 0) : 0
}

/** The tray: the browser in its box, under its lip. `left`/`top` are screen
 *  px, `lipWidth` the lip's width there (the tray's, until it is sized). */
export const CardTray: React.FC<{ cardId: string; left: number; top: number; lipWidth: number }> = ({ cardId, left, top, lipWidth }) => {
  const tray = useTrayStore(s => s.trays[cardId])
  const n = useTrayCount(cardId)
  const { pan, zoom } = useCardView()
  if (!tray || tray.h <= 0 || !n) return null
  const hPx = tray.h * zoom
  const wPx = Math.max(MIN_W_PX, tray.w !== undefined ? tray.w * zoom : lipWidth)
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
        border: '1px solid rgba(160,200,255,0.45)', borderTop: 'none',
        boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
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
