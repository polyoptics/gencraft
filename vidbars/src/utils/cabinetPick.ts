// cabinetPick.ts — Pick mode: sorting through things on the table by hand.
// Clicking and dragging are as ever, on or off (selecting, docking on a strip,
// decks, drawers). While it is on, a card or tile flicked and let go on the table
// also keeps its momentum, slides to a stop and knocks what it hits.
//
// A small simulation on the canvas plane, in canvas units, so it behaves the
// same flat and tilted. It only ever moves things: nothing is lost by a flick,
// and the one thing that puts something away is landing in an open drawer.

import { create } from 'zustand'
import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { canStowTile, canvasPointAt, stowCards, stowTiles, type DrawerRef } from './cabinet'

const KEY = 'vidbars.pickMode'
function readOn(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export const usePickMode = create<{ on: boolean; setOn: (on: boolean) => void }>()(set => ({
  on: readOn(),
  setOn: on => {
    set({ on })
    try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* private window */ }
  },
}))

/** Speed kept per 1/60 s. */
const FRICTION = 0.93
/** Canvas units per second, in on-screen terms (÷ zoom): below this, stopped. */
const STOP_SPEED = 25
/** A release below this just lands, and hits nothing: how piles get made. */
const THROW_SPEED = 220
/** How much of a hit goes into what it hits. */
const KNOCK = 0.7
/** The hardest throw, on-screen px per second (÷ zoom). */
const MAX_SPEED = 2600

interface Body {
  kind: 'card' | 'tile'
  id: string
  x: number; y: number; w: number; h: number
  vx: number; vy: number
  moved: boolean
  /** Who it is touching: a hit passes on once, when they first touch. */
  touching: Set<Body>
}

let bodies: Body[] = []
let flying = false
let raf: number | null = null
let held: Body | null = null
let samples: { t: number; x: number; y: number }[] = []

/** What can be picked up, as drawn on screen right now. */
function tableBodies(): Body[] {
  const { zoom, pan } = useCanvasStore.getState()
  const out: Body[] = []
  const fns = useFreeNodeStore.getState()
  for (const n of Object.values(fns.nodes)) {
    if (!canStowTile(n) || (n.tileDeck && n.tileDeck.anchor !== n.id)) continue
    if (document.querySelector(`[data-freenode][data-id="${n.id}"]`)) {
      out.push({ kind: 'tile', id: n.id, x: n.x, y: n.y, w: n.width, h: n.height, vx: 0, vy: 0, moved: false, touching: new Set() })
    }
  }
  for (const g of useBoardsStore.getState().groups) {
    if (g.pin) continue
    if (g.deckAnchorId && g.deckAnchorId !== g.id && g.deckState && g.deckState !== 'open') continue
    // On a loop strip, it stays where the strip holds it.
    if (Object.values(fns.nodes).some(n => n.cardRef === g.id && n.railDock)) continue
    const el =document.querySelector<HTMLElement>(`[data-group-card][data-id="${g.id}"]`)
    if (!el) continue
    // Its own layout box, which the tilt does not change, in canvas units: a
    // card is not drawn at its origin. Only ever moved by deltas, so that is fine.
    let left = 0, top = 0
    for (let e: HTMLElement | null = el; e && !e.hasAttribute('data-tilt-stage'); e = e.offsetParent as HTMLElement | null) {
      left += e.offsetLeft; top += e.offsetTop
    }
    out.push({
      kind: 'card', id: g.id,
      x: (left - pan.x) / zoom, y: (top - pan.y) / zoom, w: el.offsetWidth / zoom, h: el.offsetHeight / zoom,
      vx: 0, vy: 0, moved: false, touching: new Set(),
    })
  }
  return out
}

function moveBody(b: Body, dx: number, dy: number) {
  b.x += dx; b.y += dy
  b.moved = true
  if (b.kind === 'tile') {
    useFreeNodeStore.getState().moveFreeNode(b.id, dx, dy)
    return
  }
  // A deck moves whole: its hidden cards lie under its face.
  const bs = useBoardsStore.getState()
  bs.setGroupPosBatch(bs.groups
    .filter(g => g.id === b.id || (g.deckAnchorId === b.id && g.deckState && g.deckState !== 'open'))
    .map(g => ({ groupId: g.id, originX: g.originX + dx, originY: g.originY + dy })))
}

/** The open drawer whose tray this point of the canvas lies on. By canvas units,
 *  not a hit test: a thrown card is judged the same flat and tilted. */
function openTrayAt(cx: number, cy: number): DrawerRef | null {
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    const open = n.cabinet?.drawers.find(d => d.id === n.cabinet!.open)
    if (!open || open.project || n.pin) continue
    const tray = document.querySelector<HTMLElement>(`[data-freenode][data-id="${n.id}"] [data-cabinet-tray]`)
    if (!tray) continue
    if (cx >= n.x && cx <= n.x + n.width && cy >= n.y + tray.offsetTop && cy <= n.y + tray.offsetTop + tray.offsetHeight) {
      return { nodeId: n.id, drawerId: open.id }
    }
  }
  return null
}

function putAwayIfInTray(b: Body): boolean {
  const drawer = openTrayAt(b.x + b.w / 2, b.y + b.h / 2)
  if (!drawer) return false
  if (b.kind === 'tile') stowTiles([b.id], drawer)
  else stowCards([b.id], drawer)
  bodies = bodies.filter(o => o !== b)
  return true
}

/** Things slide only as far as the edge of the view, and bounce off it: nothing
 *  thrown ends up somewhere you would have to go looking for it. */
function bounceOffView(b: Body) {
  const host = document.querySelector('[data-tilt-stage="world"]')?.parentElement
  if (!host) return
  const { pan, zoom } = useCanvasStore.getState()
  const left = -pan.x / zoom, top = -pan.y / zoom
  const right = left + host.offsetWidth / zoom, bottom = top + host.offsetHeight / zoom
  const dx = b.x < left ? left - b.x : b.x + b.w > right ? right - b.w - b.x : 0
  const dy = b.y < top ? top - b.y : b.y + b.h > bottom ? bottom - b.h - b.y : 0
  if (dx) b.vx = Math.abs(b.vx) * Math.sign(dx) * 0.6
  if (dy) b.vy = Math.abs(b.vy) * Math.sign(dy) * 0.6
  if (dx || dy) moveBody(b, dx, dy)
}

const overlap = (a: Body, b: Body) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

function tick(last: number) {
  raf = requestAnimationFrame(now => {
    const dt = Math.min(0.05, (now - last) / 1000)
    const stop = STOP_SPEED / useCanvasStore.getState().zoom
    const hard = THROW_SPEED / useCanvasStore.getState().zoom
    let any = false
    for (const b of [...bodies]) {
      if (b === held) continue
      const speed = Math.hypot(b.vx, b.vy)
      if (speed < stop) { b.vx = b.vy = 0; continue }
      any = true
      moveBody(b, b.vx * dt, b.vy * dt)
      const f = Math.pow(FRICTION, dt * 60)
      b.vx *= f; b.vy *= f
      bounceOffView(b)
      if (putAwayIfInTray(b)) continue
      // Only what is really moving knocks anything: a card eased onto a pile
      // stays on it.
      if (speed < hard / 2) { b.touching.clear(); continue }
      for (const o of bodies) {
        if (o === b || o === held) continue
        if (!overlap(b, o)) { b.touching.delete(o); continue }
        if (b.touching.has(o)) continue
        b.touching.add(o)
        o.touching.add(b)
        // Along the line between their centres, never backwards: a fast card
        // can be past the other's centre by the frame they first touch.
        const nx = o.x + o.w / 2 - (b.x + b.w / 2), ny = o.y + o.h / 2 - (b.y + b.h / 2)
        const d = Math.hypot(nx, ny) || 1
        const ahead = nx * b.vx + ny * b.vy > 0
        const ux = ahead ? nx / d : b.vx / speed, uy = ahead ? ny / d : b.vy / speed
        o.vx += ux * speed * KNOCK
        o.vy += uy * speed * KNOCK
        b.vx *= 1 - KNOCK / 2
        b.vy *= 1 - KNOCK / 2
      }
    }
    if (any) tick(now)
    else { raf = null; flying = false }
  })
}

function point(e: PointerEvent) {
  return canvasPointAt(e.clientX, e.clientY, !e.isTrusted)
}

function onDown(e: PointerEvent) {
  if (!usePickMode.getState().on || e.button !== 0 || e.altKey || !(e.target instanceof Element)) return
  // A control keeps its click.
  if (e.target.closest('button, input, textarea, select, [data-resize], [data-cabinet-tray], [data-cabinet-front]')) return
  const el = e.target.closest<HTMLElement>('[data-freenode][data-id], [data-group-card][data-id]')
  const id = el?.dataset.id
  if (!id) return
  const b = tableBodies().find(o => o.id === id)
  const at = point(e)
  if (!b || !at) return
  // The hand has it now: the rest of what is sliding keeps sliding.
  bodies = bodies.filter(o => o.id !== id)
  held = b
  samples = [{ t: e.timeStamp, x: at.cx, y: at.cy }]
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onUp, true)
}

function onMove(e: PointerEvent) {
  if (!held) return
  const at = point(e)
  if (!at) return
  samples.push({ t: e.timeStamp, x: at.cx, y: at.cy })
  if (samples.length > 6) samples.shift()
}

function onUp(e: PointerEvent) {
  window.removeEventListener('pointermove', onMove, true)
  window.removeEventListener('pointerup', onUp, true)
  window.removeEventListener('pointercancel', onUp, true)
  const pressed = held
  held = null
  if (!pressed || e.type === 'pointercancel') return
  // The hand's speed over its last moments, not its last twitch.
  const recent = samples.filter(s => e.timeStamp - s.t < 100)
  const first = recent[0], last = recent[recent.length - 1]
  const span = first && last ? (last.t - first.t) / 1000 : 0
  const hard = THROW_SPEED / useCanvasStore.getState().zoom
  const max = MAX_SPEED / useCanvasStore.getState().zoom
  const raw = span > 0 ? Math.hypot(last.x - first.x, last.y - first.y) / span : 0
  const clamp = raw > max ? max / raw : 1
  const vx = span > 0 ? ((last.x - first.x) / span) * clamp : 0
  const vy = span > 0 ? ((last.y - first.y) / span) * clamp : 0
  // This listener runs first: wait for the drag's own release to finish. What
  // it put somewhere (a strip, a deck, a drawer) is no longer on the table.
  setTimeout(() => {
    const fresh = tableBodies()
    const b = fresh.find(o => o.id === pressed.id)
    if (!flying) bodies = fresh
    else if (b) bodies.push(b)
    // Not dragged (a click, a shift-click), or let go slowly: it stays.
    if (!b || (b.x === pressed.x && b.y === pressed.y) || Math.hypot(vx, vy) < hard) return
    if (putAwayIfInTray(b)) return
    b.vx = vx; b.vy = vy
    flying = true
    if (raf === null) tick(performance.now())
  })
}

// Ahead of the card and tile handlers, which listen further down the tree.
window.addEventListener('pointerdown', onDown, true)
