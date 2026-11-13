// A card's tray (Brian 2026-11-13): "that tray-like interface could be
// pulled down from the bottom of a card, and inside of it ... all the linked
// cards and you could scroll-wheel through them ... and search through
// them", "sizeable along the bottom of the host card ... if you just want
// to see small card tops to flip through".
//
// It IS the Card Browser (CardRolodex), listing what the card holds and
// the cards linked with it (utils/browserScope trayIds). The browser sizes
// its cards to the box's width, so a narrow tray is small card tops and a
// wide one big cards.
//
// The tray is the one thing tucked under a card ("The tuck is what we want
// to do with the card browser"), and on a card it is SLIM ("super bulky
// with so much clunk ... trim the sides down to next to nothing ... the tab
// that says Mutation should be on the drawer part that I pull down"):
//   - TrayLip, the one handle. Shut, it sticks out under the card's bottom
//     edge, naming what is in the tray. Pulled, it goes down with the mouse
//     and stays; the tray's cards show between the card and it, the first
//     right up against the card. Out, it carries the search field. Click
//     (not in the field): open / shut. Its corner sizes the tray both ways.
//   - CardTray, the cards: the browser's slots alone. Its own header, side
//     rails and bottom bar are left out of view; the sides are 2px.
// The lip is in the chip rail's wrapper, so in 3D it rides with the card.
// How a tray is left is kept for the session (trayStore), not saved.

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
/** How far the shut lip reaches below its card's bottom edge, natural units. */
export const TRAY_LIP = SEAM + FOOT
/** How far in from the card's sides the lip (and the tray) sits, natural units. */
export const TRAY_INSET = INSET
const OPEN_PX = 260      // how far a click opens it, screen px
const SHUT_PX = 24       // pulled shorter than this, it shuts
const MIN_W_PX = 70
const SIDE = 2           // the tray's sides, px
const NAMED = 4          // names on the lip
// The browser's own frame, in its native units (CardRolodex SLOT_W, WING_W,
// CABINET_BAR_H): the slots are what a tray shows of it.
const SLOT_W = 180, WING_W = 8, BAR_H = 32

/** How many cards card `id`'s tray lists. */
export function useTrayCount(id: string): number {
  return useBoardsStore(s => trayIds(s.groups.find(g => g.id === id), s.groups).length)
}

/** The tray's width on screen: as it was sized, else its lip's. */
function trayWidthPx(w: number | undefined, zoom: number, lipWidthPx: number): number {
  return Math.max(MIN_W_PX, w !== undefined ? w * zoom : lipWidthPx)
}

/** Drag: the tray's height (and width) follow the pointer; let go, it stays.
 *  `soft`: the press began in the search field, which keeps its click. */
function dragTray(e: React.PointerEvent, cardId: string, zoom: number, from: { hPx: number; wPx?: number }, onClick?: () => void, soft?: boolean) {
  if (e.button !== 0) return
  e.stopPropagation()
  if (!soft) e.preventDefault()
  const x0 = e.clientX, y0 = e.clientY
  let moved = false
  const onMove = (ev: PointerEvent) => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0
    if (!moved && Math.hypot(dx, dy) < 3) return
    if (!moved && soft) (document.activeElement as HTMLElement | null)?.blur?.()
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

/** The tray's lip. `left`/`top`: the card's bottom-left corner from the
 *  rail's own corner; `width`: the card's width in the lip's natural units. */
export const TrayLip: React.FC<{ cardId: string; left: number; top: number; scale: number; width: number }> = ({ cardId, left, top, scale, width }) => {
  const n = useTrayCount(cardId)
  const names = useBoardsStore(s => trayIds(s.groups.find(g => g.id === cardId), s.groups).slice(0, NAMED)
    .map(id => { const g = s.groups.find(x => x.id === id); return g ? cardTitle(s.groups, g) || g.name || 'card' : '' }).filter(Boolean).join(', '))
  const h = useTrayStore(s => s.trays[cardId]?.h ?? 0)
  const w = useTrayStore(s => s.trays[cardId]?.w)
  const query = useTrayStore(s => s.trays[cardId]?.query.query ?? '')
  const { zoom } = useCardView()
  if (!n) return null
  const open = h > 0
  const hPx = h * zoom
  const lipW = Math.max(30, width - 2 * INSET)
  // Out, it is as wide as the tray it closes.
  const wPx = trayWidthPx(w, zoom, lipW * scale)
  const toggle = () => useTrayStore.getState().setSize(cardId, { h: open ? 0 : OPEN_PX / zoom })
  return (
    <div style={{ position: 'absolute', left, top: top + (open ? hPx - 1 : 0), width: 0, height: 0 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        <div
          data-tray-lip={cardId}
          title={open ? 'Drag to pull the tray longer or shorter; click to shut it' : `${n} card${n === 1 ? '' : 's'} in its tray: pull down to slide it out, click to open it`}
          onPointerDown={e => {
            const inField = (e.target as Element).tagName === 'INPUT'
            dragTray(e, cardId, zoom, { hPx }, inField ? undefined : toggle, inField)
          }}
          onClick={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          style={{
            position: 'absolute', left: INSET, top: 0, width: open ? wPx / scale : lipW, height: open ? FOOT : TRAY_LIP, boxSizing: 'border-box',
            display: 'flex', alignItems: 'flex-end',
            borderRadius: '0 0 9px 9px',
            background: 'linear-gradient(#11131c, #1d2030)',
            border: `1px solid ${open ? 'rgba(160,200,255,0.5)' : 'rgba(255,255,255,0.28)'}`, borderTop: 'none',
            boxShadow: open ? '0 3px 8px rgba(0,0,0,0.5)' : 'inset 0 9px 8px -5px rgba(0,0,0,0.75), 0 2px 5px rgba(0,0,0,0.45)',
            color: 'rgba(255,255,255,0.9)', cursor: open ? 'ns-resize' : 'grab', userSelect: 'none', touchAction: 'none',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <div style={{ height: FOOT, width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 5, padding: `0 ${open ? 14 : 8}px 1px 7px`, minWidth: 0 }}>
            <svg width="11" height="10" viewBox="0 0 11 10" style={{ flexShrink: 0, opacity: 0.8 }}>
              <path d="M1 1h9v5.5a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z M3.5 4h4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            {open ? (
              // The tray's search: names what is in it until something is typed.
              <input
                data-tray-search
                type="text"
                value={query}
                placeholder={names}
                spellCheck={false}
                onChange={e => useTrayStore.getState().patchQuery(cardId, { query: e.target.value })}
                onKeyDown={e => {
                  e.stopPropagation()
                  if (e.key === 'Escape') { useTrayStore.getState().patchQuery(cardId, { query: '' }); (e.target as HTMLInputElement).blur() }
                }}
                style={{
                  flex: '1 1 auto', minWidth: 0, height: FOOT - 4, padding: 0, border: 'none', outline: 'none', background: 'transparent',
                  color: '#fff', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', cursor: 'text',
                }}
              />
            ) : (
              <span style={{ flex: '1 1 auto', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{names}</span>
            )}
            <span style={{ flex: '0 0 auto', fontSize: 10, fontWeight: 600, opacity: 0.7 }}>{n}</span>
          </div>
          {/* Its corner: the tray wider or narrower too. */}
          {open && (
            <div
              data-tray-corner
              title="Drag to size the tray"
              onPointerDown={e => dragTray(e, cardId, zoom, { hPx, wPx })}
              style={{ position: 'absolute', right: 0, bottom: 0, width: 13, height: 13, cursor: 'nwse-resize', touchAction: 'none' }}
            >
              <svg width="13" height="13" viewBox="0 0 13 13"><path d="M10.5 4.5v6h-6" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </div>
          )}
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
  return n ? (h > 0 ? h * zoom + FOOT * scale + 4 : TRAY_LIP * scale) : 0
}

/** The tray's cards: the browser's slots, from the card's bottom edge down
 *  to the lip. `left`/`top` are screen px, `lipWidth` the shut lip's width
 *  there (the tray's, until it is sized). */
export const CardTray: React.FC<{ cardId: string; left: number; top: number; lipWidth: number }> = ({ cardId, left, top, lipWidth }) => {
  const tray = useTrayStore(s => s.trays[cardId])
  const n = useTrayCount(cardId)
  const { pan, zoom } = useCardView()
  if (!tray || tray.h <= 0 || !n) return null
  const hPx = tray.h * zoom
  const wPx = trayWidthPx(tray.w, zoom, lipWidth)
  // The browser is laid out wider and longer than the tray, by its side
  // rails and its bottom bar, and the tray shows the slots between them.
  const k = (wPx - 2 * SIDE) / SLOT_W
  const boxW = (SLOT_W + 2 * WING_W) * k
  const boxH = hPx + BAR_H * k
  return (
    <div
      data-card-tray={cardId}
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onContextMenu={e => e.stopPropagation()}
      style={{
        position: 'absolute', left, top, width: wPx, height: hPx, zIndex: 56,
        pointerEvents: 'auto', boxSizing: 'border-box', overflow: 'hidden',
        background: 'rgba(18,20,30,0.97)',
        boxShadow: 'inset 1px 0 0 rgba(160,200,255,0.4), inset -1px 0 0 rgba(160,200,255,0.4), 0 6px 18px rgba(0,0,0,0.5)',
      }}
    >
      <div style={{ position: 'absolute', left: SIDE - WING_W * k, top: 0, width: boxW, height: boxH, overflow: 'hidden' }}>
        <CardRolodex
          embedded={{ nodeId: `tray:${cardId}` }}
          tray={{ cardId, x: (left - pan.x) / zoom, y: (top - pan.y) / zoom, width: wPx / zoom, height: hPx / zoom }}
        />
      </div>
    </div>
  )
}
