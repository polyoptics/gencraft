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
//   - TrayLip, the one handle. Shut, it is a small handle alone under the
//     middle of the card's bottom edge (Brian 2026-11-18: "it goes down to
//     just the handle. Then, when we pull it down, it first pops wide into
//     the shape, and then, with a smooth go, it just continues to pull
//     down"): the pull widens it into the bar, and it stays the bar until
//     let go. Pulled, it goes down with the mouse
//     FROM THE FIRST PIXEL ("it doesn't really move, and then it flips ...
//     popped on ... definitely don't want that when I'm opening it. Maybe
//     on the close"): the lip is the same size and shape shut or out, so
//     nothing jumps; only letting go of it nearly shut shuts it. The tray's
//     cards show between the card and it, the first right up against the
//     card. Out, it carries a little handle, the search field and the three
//     view modes (compact, full, auto: the browser's own, lit = the one in
//     use). Click (not in the field or on a mode): open / shut. Its corner
//     sizes the tray both ways. The pull STOPS where the cards end ("stop
//     the pull open when we hit the bottom edge of the card. Flush with the
//     bottom"): the lip against the last card's bottom edge, no empty tray.
//   - CardTray, the cards: the browser's slots alone. Its own header, side
//     rails and bottom bar are left out of view; the sides are 2px.
// The lip is in the chip rail's wrapper, so in 3D it rides with the card.
// A SCENE card's tray is tucked away (Brian 2026-11-16: "there's no way to
// make it disappear. And then, because it sticks out, the cards can't touch
// each other as closely ... tucked away under a '...' at the bottom of the
// scene card"): nothing of it shows until the "..." at the bottom centre of
// its face (SceneFace) brings it out, at the size it was left.
// How a tray is left is kept for the session (trayStore), not saved.

import React from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useTrayStore } from '../../store/trayStore'
import { trayIds } from '../../utils/browserScope'
import { cardTitle } from '../../utils/faceStyle'
import { useCardView } from '../Layers/cardView'
import { CardRolodex, listAreaMax } from '../Rolodex/CardRolodex'

const INSET = 8          // natural sizes: the lip's wrapper scales them with the card
const SEAM = 13          // under the chips, which ride the card's bottom edge
const FOOT = 21          // what the lip shows of itself
/** How tall the lip is (shut: how far it reaches below its card), natural units. */
export const TRAY_LIP = SEAM + FOOT
const HANDLE_W = 46      // shut: the handle alone, natural units
const HANDLE_H = 12
const POP_MS = 110       // the handle widening into the bar (and back)
/** How far in from the card's sides the lip (and the tray) sits, natural units. */
export const TRAY_INSET = INSET
const OPEN_PX = 260      // how far a click opens it, screen px
const SHUT_PX = 24       // LET GO shorter than this, it shuts (never while pulling)
const MIN_W_PX = 70
const SIDE = 2           // the tray's sides, px
const NAMED = 4          // names on the lip
// The browser's own frame, in its native units (CardRolodex SLOT_W, WING_W,
// CABINET_BAR_H): the slots are what a tray shows of it.
const SLOT_W = 180, WING_W = 8, BAR_H = 32

/** The browser's view modes, with its own marks (CardRolodex DisplayModeDock). */
const MODES = [
  { value: 'compact', label: '≡', title: 'Compact: every card as a tab' },
  { value: 'full', label: '▣', title: 'Full: the picked card at full size' },
  { value: 'auto', label: 'A', title: 'Auto: the picked card grows with the tray' },
] as const

/** How many cards card `id`'s tray lists. */
export function useTrayCount(id: string): number {
  return useBoardsStore(s => trayIds(s.groups.find(g => g.id === id), s.groups).length)
}

/** A scene card's tray, not brought out by its "...": nothing of it shows. */
export function useTrayTucked(id: string): boolean {
  const scene = useBoardsStore(s => { const g = s.groups.find(x => x.id === id); return !!g?.scene && g.cardType === 'scene' })
  const out = useTrayStore(s => !!s.trays[id]?.out)
  return scene && !out
}

/** A scene card's "...": its tray out, or tucked away again. First out, it
 *  opens as a click on its lip would. `lipWidthPx`: about its lip's width. */
export function toggleSceneTray(cardId: string, zoom: number, lipWidthPx: number): void {
  const ts = useTrayStore.getState()
  const t = ts.trays[cardId]
  if (t?.out) { ts.setOut(cardId, false); return }
  if (t && t.h > 0) { ts.setOut(cardId, true); return }
  const bs = useBoardsStore.getState()
  const n = trayIds(bs.groups.find(g => g.id === cardId), bs.groups).length
  const wPx = trayWidthPx(t?.w, zoom, lipWidthPx)
  ts.setOut(cardId, true, Math.min(OPEN_PX, trayMaxPx(n, t?.query.displayMode ?? 'auto', wPx)) / zoom)
}

/** The tray's width on screen: as it was sized, else its lip's. */
function trayWidthPx(w: number | undefined, zoom: number, lipWidthPx: number): number {
  return Math.max(MIN_W_PX, w !== undefined ? w * zoom : lipWidthPx)
}

/** How long a tray `wPx` wide is with its lip flush against the bottom edge
 *  of its last card, screen px. No cards listed (a search with no match):
 *  no stop. */
function trayMaxPx(rows: number, mode: 'auto' | 'compact' | 'full', wPx: number): number {
  return rows > 0 ? listAreaMax(rows, mode) * (wPx - 2 * SIDE) / SLOT_W : Infinity
}

/** Drag: the tray's height (and width) follow the pointer; let go, it stays.
 *  `maxAt`: how long the tray may be at a width (where its cards end).
 *  `soft`: the press began in the search field, which keeps its click. */
function dragTray(e: React.PointerEvent, cardId: string, zoom: number, from: { hPx: number; wPx?: number }, maxAt: (wPx: number) => number, wNow: number, onClick?: () => void, soft?: boolean, onHold?: (held: boolean) => void) {
  if (e.button !== 0) return
  e.stopPropagation()
  if (!soft) e.preventDefault()
  const x0 = e.clientX, y0 = e.clientY
  let moved = false
  // Where the pull began to count (past the click's slop), so that the
  // tray starts from exactly where it was: no hop as it starts to move.
  let sx = 0, sy = 0
  const onMove = (ev: PointerEvent) => {
    let dx = ev.clientX - x0, dy = ev.clientY - y0
    if (!moved && Math.hypot(dx, dy) < 3) return
    if (!moved) { sx = dx; sy = dy }
    dx -= sx; dy -= sy
    if (!moved && soft) (document.activeElement as HTMLElement | null)?.blur?.()
    if (!moved) onHold?.(true)
    moved = true
    // Every pixel of the pull is a pixel of tray: no threshold on the way out.
    const w = from.wPx !== undefined ? Math.max(MIN_W_PX, from.wPx + dx) : wNow
    // Out to where the cards end and no further. (Already longer than that,
    // after a view change: it does not hop back as the pull starts.)
    const stop = from.hPx > maxAt(wNow) + 0.5 ? Math.max(maxAt(w), from.hPx) : maxAt(w)
    useTrayStore.getState().setSize(cardId, {
      h: Math.max(0, Math.min(stop, from.hPx + dy)) / zoom,
      ...(from.wPx !== undefined ? { w: w / zoom } : {}),
    })
  }
  const done = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', done)
    if (moved) onHold?.(false)
  }
  const onUp = () => {
    if (!moved) { done(); onClick?.(); return }
    // Let go nearly shut: shut.
    const ts = useTrayStore.getState()
    if ((ts.trays[cardId]?.h ?? 0) * zoom < SHUT_PX) ts.setSize(cardId, { h: 0 })
    done()
  }
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
  const mode = useTrayStore(s => s.trays[cardId]?.query.displayMode ?? 'auto')
  const listed = useTrayStore(s => s.trays[cardId]?.rows)
  const { zoom } = useCardView()
  const tucked = useTrayTucked(cardId)
  // Being pulled: it is the bar from the pull's first pixel until let go.
  const [held, setHeld] = React.useState(false)
  const wide = h > 0 || held
  // The handle widens into the bar (and back) over a moment; nothing else
  // of the lip is eased, so a pull or a sizing follows the mouse exactly.
  const was = React.useRef({ wide, at: -1e9 })
  if (was.current.wide !== wide) was.current = { wide, at: performance.now() }
  const popping = performance.now() - was.current.at < POP_MS + 40
  const [, settle] = React.useState(0)
  React.useEffect(() => {
    const t = window.setTimeout(() => settle(v => v + 1), POP_MS + 60)
    return () => window.clearTimeout(t)
  }, [wide])
  if (!n || tucked) return null
  const open = h > 0
  const hPx = h * zoom
  const lipW = Math.max(30, width - 2 * INSET)
  // As wide as the tray it closes, shut or out (so opening widens nothing).
  const wPx = trayWidthPx(w, zoom, lipW * scale)
  // Where the cards end, at a width (what the browser lists just now; shut,
  // everything in the tray).
  const maxAt = (px: number) => trayMaxPx(open && listed !== undefined ? listed : n, mode, px)
  const toggle = () => useTrayStore.getState().setSize(cardId, { h: open ? 0 : Math.min(OPEN_PX, maxAt(wPx)) / zoom })
  return (
    <div style={{ position: 'absolute', left, top: top + hPx, width: 0, height: 0 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        <div
          data-tray-lip={cardId}
          title={open ? 'Drag to pull the tray longer or shorter; click to shut it' : `${n} card${n === 1 ? '' : 's'} in its tray: pull down to slide it out, click to open it`}
          onPointerDown={e => {
            if ((e.target as Element).closest('[data-tray-mode]')) { e.stopPropagation(); return }
            const inField = (e.target as Element).tagName === 'INPUT'
            dragTray(e, cardId, zoom, { hPx }, maxAt, wPx, inField ? undefined : toggle, inField, setHeld)
          }}
          onClick={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          style={{
            position: 'absolute', boxSizing: 'border-box', top: 0, overflow: 'hidden',
            // Shut: the handle alone, under the middle of the card's bottom edge.
            left: wide ? INSET : (width - HANDLE_W) / 2,
            width: wide ? wPx / scale : HANDLE_W,
            height: wide ? TRAY_LIP : HANDLE_H,
            transition: popping ? `left ${POP_MS}ms ease-out, width ${POP_MS}ms ease-out, height ${POP_MS}ms ease-out` : 'none',
            display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
            borderRadius: wide ? '0 0 9px 9px' : '0 0 6px 6px',
            background: 'linear-gradient(#11131c, #1d2030)',
            border: `1px solid ${open ? 'rgba(160,200,255,0.5)' : 'rgba(255,255,255,0.28)'}`, borderTop: 'none',
            boxShadow: wide ? 'inset 0 9px 8px -5px rgba(0,0,0,0.75), 0 2px 5px rgba(0,0,0,0.45)' : '0 2px 5px rgba(0,0,0,0.45)',
            color: 'rgba(255,255,255,0.9)', cursor: open ? 'ns-resize' : 'grab', userSelect: 'none', touchAction: 'none',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          {/* The little handle, in the middle of the bar's top. */}
          <div style={{ flex: '0 0 auto', height: wide ? SEAM : HANDLE_H, display: 'flex', alignItems: wide ? 'flex-end' : 'center', justifyContent: 'center', paddingBottom: wide ? 2 : 0, boxSizing: 'border-box' }}>
            <div style={{ width: 26, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.45)' }} />
          </div>
          {wide && <div style={{ flex: '0 0 auto', height: FOOT, width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 5, padding: '0 14px 1px 7px', minWidth: 0 }}>
            <svg width="11" height="10" viewBox="0 0 11 10" style={{ flexShrink: 0, opacity: 0.8 }}>
              <path d="M1 1h9v5.5a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z M3.5 4h4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            {(
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
            )}
            {/* The view modes, left to right: the browser's own three. */}
            {MODES.map(m => (
              <div
                key={m.value}
                data-tray-mode={m.value}
                title={m.title}
                onClick={e => { e.stopPropagation(); useTrayStore.getState().patchQuery(cardId, { displayMode: m.value }) }}
                style={{
                  flex: '0 0 auto', width: 15, height: 15, boxSizing: 'border-box', borderRadius: 3,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 9, fontWeight: 700, lineHeight: 1, cursor: 'pointer',
                  background: mode === m.value ? 'rgba(255,255,255,0.18)' : 'transparent',
                  border: `1px solid rgba(255,255,255,${mode === m.value ? 0.5 : 0.16})`,
                  color: `rgba(255,255,255,${mode === m.value ? 0.95 : 0.55})`,
                }}
              >{m.label}</div>
            ))}
            <span style={{ flex: '0 0 auto', fontSize: 10, fontWeight: 600, opacity: 0.7 }}>{n}</span>
          </div>}
          {/* Its corner: the tray wider or narrower too. */}
          {wide && (
            <div
              data-tray-corner
              title="Drag to size the tray"
              onPointerDown={e => dragTray(e, cardId, zoom, { hPx, wPx }, maxAt, wPx)}
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
  const tucked = useTrayTucked(id)
  return n && !tucked ? (h > 0 ? TRAY_LIP * scale + h * zoom + 4 : HANDLE_H * scale) : 0
}

/** The tray's cards: the browser's slots, from the card's bottom edge down
 *  to the lip. `left`/`top` are screen px, `lipWidth` the shut lip's width
 *  there (the tray's, until it is sized). */
export const CardTray: React.FC<{ cardId: string; left: number; top: number; lipWidth: number }> = ({ cardId, left, top, lipWidth }) => {
  const tray = useTrayStore(s => s.trays[cardId])
  const n = useTrayCount(cardId)
  const { pan, zoom } = useCardView()
  const tucked = useTrayTucked(cardId)
  if (!tray || tray.h <= 0 || !n || tucked) return null
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
