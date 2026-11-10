// Placing something from the top icon bar where you click.
//
// A toolbar button used to drop what it makes in the middle of the view,
// often on top of (or under) whatever was already there. Now the button
// picks the thing up: an outline of it, at the size it will be, follows the
// mouse over the canvas, and the next left click sets it down there (Brian
// 2026-11-03). Esc, or the lit button again, puts it back. Middle-drag and
// the wheel still move the camera while you aim.
//
// The outline is drawn by components/Canvas/PlaceGhost, inside the canvas's
// tilt stage, so tilted it lies on the ground like everything else; the
// cursor is read through the tilt (unprojectTilt), as a drag is. Its corner
// pulls onto the dot grid the way a dragged card's does; Ctrl places freely.
// At card zoom the cards are drawn over every tile and Viewer, so a box
// aimed onto a card rises clear of it: it shows, and lands, above.

import { bundleArea3dCard } from './area3dCard'
import { create } from 'zustand'
import { useCanvasStore } from '../store/canvasStore'
import { useBoardsStore } from '../store/boardsStore'
import { isTilted, unprojectTilt, useTiltStore, TILT_FAR } from '../store/tiltStore'
import { currentZone } from '../store/zoomZonesStore'
import { cardVisualRect, canvasObstacleGroups } from '../hooks/useCardDecks'
import { dotStep } from './dotGrid'
import { clientToCanvas } from './fx/createEffect'
import {
  addFreeNodeCentered, addBrowserNode, addViewerCentered, createCardOrBoardAt, createStorylineAt,
  freeNodeFootprint, viewerFootprint, cardFootprint, type Footprint,
} from './canvasCreate'
import { openFilmMixer, filmMixerSize } from '../components/FilmMixer/FilmMixerBody'
import { openRoughCut, roughCutSize } from '../components/RoughCut/RoughCutBody'
import { createLoopStrip, loopStripSize } from './fx/createEffect'

export type PlaceKind = 'viewer' | 'pool' | 'prompt' | 'history' | 'browser' | 'filmMixer' | 'storyline' | 'cabinet' | 'roughCut' | 'loopStrip' | 'attributes' | 'promptCards' | 'area' | 'new'

interface PlaceState {
  /** What is being placed, or null. */
  kind: PlaceKind | null
  /** The cursor on the canvas, in canvas units; null off it. */
  at: { cx: number; cy: number } | null
  /** Ctrl held: no snapping. */
  free: boolean
}

export const usePlacing = create<PlaceState>(() => ({ kind: null, at: null, free: false }))

export function startPlacing(kind: PlaceKind) {
  usePlacing.setState({ kind, at: null, free: false })
}
export function cancelPlacing() {
  if (usePlacing.getState().kind) usePlacing.setState({ kind: null, at: null, free: false })
}
/** The toolbar button: pick it up, or (lit) put it back. */
export function togglePlacing(kind: PlaceKind) {
  if (usePlacing.getState().kind === kind) cancelPlacing()
  else startPlacing(kind)
}

/** The "new" button makes a card at card and block zoom, a note at board
 *  zoom (TopIconBar's onNew). */
const newIsNote = () => currentZone() === 'board'

/** A storyline starts as one point, not a box. */
export const placesPoint = (kind: PlaceKind) => kind === 'storyline'

function footprint(kind: PlaceKind, zoom: number): Footprint {
  switch (kind) {
    case 'viewer': return viewerFootprint(zoom)
    case 'browser': return freeNodeFootprint('list', zoom)
    case 'filmMixer': { const s = filmMixerSize(); return { w: s.width, h: s.height, dy: 0 } }
    case 'roughCut': { const s = roughCutSize(); return { w: s.width, h: s.height, dy: 0 } }
    case 'loopStrip': { const s = loopStripSize(zoom); return { w: s.width, h: s.height, dy: 0 } }
    case 'storyline': return { w: 0, h: 0, dy: 0 }
    case 'new': return newIsNote() ? freeNodeFootprint('note', zoom) : cardFootprint(zoom)
    default: return freeNodeFootprint(kind, zoom)
  }
}

export interface PlaceBox { left: number; top: number; w: number; h: number; dy: number }

/** Where the thing would land for a cursor at `at`, in canvas units: the
 *  box centred on the cursor, its corner pulled onto a dot, raised clear of
 *  any card it would hide under. The outline and the click both use this,
 *  so what you see is where it goes. */
export function placeBox(kind: PlaceKind, at: { cx: number; cy: number }, zoom: number, free: boolean): PlaceBox {
  const fp = footprint(kind, zoom)
  const step = dotStep(zoom)
  if (placesPoint(kind)) {
    // createStorylineAt puts its point on the nearest dot.
    return { left: Math.round(at.cx / step) * step, top: Math.round(at.cy / step) * step, w: 0, h: 0, dy: 0 }
  }
  let left = at.cx - fp.w / 2, top = at.cy - fp.h / 2
  if (!free) {
    // As a dragged card's corner (snapCardToDots): pulled onto a dot when
    // near one, never more than a sixth of the way to the next.
    const reach = Math.min(12 / zoom, step / 6)
    const pull = (v: number) => {
      const n = Math.round(v / step) * step
      return Math.abs(n - v) <= reach ? n : v
    }
    left = pull(left); top = pull(top)
  }
  const isCard = kind === 'new' && !newIsNote()
  if (!isCard && currentZone() === 'card') top = riseClearOfCards(left, top, fp.w, fp.h, zoom)
  return { left, top, w: fp.w, h: fp.h, dy: fp.dy }
}

/** Cards draw over tiles and Viewers. Move the box up past every card it
 *  overlaps, a small gap above, until it overlaps none. */
function riseClearOfCards(left: number, top: number, w: number, h: number, zoom: number): number {
  const { groups, boards } = useBoardsStore.getState()
  const rects = canvasObstacleGroups(groups, new Set())
    .map(g => cardVisualRect(g, boards, zoom)?.rect)
    .filter((r): r is NonNullable<typeof r> => !!r)
  const gap = 12 / zoom
  for (let i = 0; i < 64; i++) {
    const hit = rects.find(r => left < r.right && left + w > r.left && top < r.bottom && top + h > r.top)
    if (!hit) break
    top = hit.top - gap - h
  }
  return top
}

/** Make it, at the box. */
function placeAt(kind: PlaceKind, box: PlaceBox) {
  const at = { cx: box.left + box.w / 2, cy: box.top + box.h / 2 + box.dy }
  switch (kind) {
    case 'viewer': addViewerCentered(at); break
    case 'browser': addBrowserNode(at); break
    case 'filmMixer': openFilmMixer(at); break
    case 'roughCut': openRoughCut(at); break
    case 'loopStrip': createLoopStrip({ x: box.left, y: box.top }); break
    case 'storyline': createStorylineAt(at); break
    case 'new': if (newIsNote()) addFreeNodeCentered('note', at); else createCardOrBoardAt(at); break
    // A 3D set comes with its card (utils/area3dCard).
    case 'area': bundleArea3dCard(addFreeNodeCentered('area', at)); break
    default: addFreeNodeCentered(kind, at)
  }
}

// ── The pointer ──

/** The canvas container: the box the tilt stages live in. */
function canvasHost(): Element | null {
  return document.querySelector('[data-tilt-stage="world"]')?.parentElement ?? null
}

/** Over the canvas itself (a card, a tile, bare ground), not a pinned panel,
 *  menu, HUD or the toolbar drawn over it. */
export function overCanvas(target: EventTarget | null): boolean {
  const el = target as Element | null
  const host = canvasHost()
  if (!el?.closest || !host || !host.contains(el)) return false
  if (el.closest('[data-pinned]')) return false
  return el === host || !!el.closest('[data-tilt-stage]')
}

/** The canvas point under the cursor, through the tilt when tilted. Null
 *  above the horizon. */
export function canvasPointUnder(clientX: number, clientY: number): { cx: number; cy: number } | null {
  const t = useTiltStore.getState()
  if (!isTilted(t)) return clientToCanvas(clientX, clientY)
  const host = canvasHost()
  if (!host) return null
  const r = host.getBoundingClientRect()
  const mx = r.left + r.width / 2, my = r.top + r.height / 2
  const g = unprojectTilt(clientX - mx, clientY - my, t.tilt, t.spin, t.shiftX, t.shiftY, 0, TILT_FAR)
  return g ? clientToCanvas(mx + g.x, my + g.y) : null
}

// Installed once, when this module loads, so they run before every other
// window listener (TiltLayer's re-sending, the canvas's rubber band): the
// press that places must reach nothing else. Idle, they return at once.
let eatUntilUp = false
if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', e => {
    if (!usePlacing.getState().kind || !e.isTrusted) return
    const at = overCanvas(e.target) ? canvasPointUnder(e.clientX, e.clientY) : null
    usePlacing.setState({ at, free: e.ctrlKey })
  }, true)
  window.addEventListener('pointerdown', e => {
    const { kind } = usePlacing.getState()
    if (!kind || !e.isTrusted || e.button !== 0) return
    if ((e.target as Element | null)?.closest?.('[data-top-icon-bar]')) return
    if (!overCanvas(e.target)) { cancelPlacing(); return }
    e.preventDefault()
    e.stopImmediatePropagation()
    eatUntilUp = true
    const at = canvasPointUnder(e.clientX, e.clientY)
    if (!at) return   // past the horizon: nothing to stand it on
    const zoom = useCanvasStore.getState().zoom
    placeAt(kind, placeBox(kind, at, zoom, e.ctrlKey))
    cancelPlacing()
  }, true)
  const eat = (e: Event) => {
    if (!eatUntilUp) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  window.addEventListener('pointerup', e => { if (eatUntilUp && e.isTrusted) { eat(e); setTimeout(() => { eatUntilUp = false }, 0) } }, true)
  window.addEventListener('click', eat, true)
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !usePlacing.getState().kind) return
    e.preventDefault()
    e.stopImmediatePropagation()
    cancelPlacing()
  }, true)
  // Ctrl pressed or let go without moving the mouse.
  const ctrl = (e: KeyboardEvent) => {
    if (e.key === 'Control' && usePlacing.getState().kind) usePlacing.setState({ free: e.type === 'keydown' })
  }
  window.addEventListener('keydown', ctrl, true)
  window.addEventListener('keyup', ctrl, true)
}
