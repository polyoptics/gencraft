// TiltLayer.tsx — the tilted view of the canvas (store/tiltStore).
//
// Alt+left-drag (Alt is the camera modifier) tips the flat canvas back
// into a ground plane: drag up/down to tilt, left/right to turn it. The
// DOM layers themselves are tilted with CSS (InfiniteCanvas world layers
// and the LayerOverlay wrapper in App share tiltCss), so every card, block
// and 3D viewer window stays exactly where it was on the plane.
//
// What this layer adds on top, only while tilted:
//  - input remapping: a press on a card or tile is re-sent to it at the
//    flat point under the cursor, so moving and resizing work on the
//    ground as they do flat. On bare ground drag pans and the wheel zooms.
//    Alt+drag tilts; Alt+middle-drag pans and Alt+right-drag or Alt+wheel
//    zooms, so Alt never has to be let go. Tilting back down to top-down
//    (or Esc, or Flat) returns to the flat view.
//  - one three.js canvas that stands each model card's model up above its
//    card, with the same camera the CSS perspective uses.

import React, { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  useTiltStore, useModelScaleStore, isTilted, unprojectTilt, TILT_SNAP, DEFAULT_LIGHT,
} from '../../store/tiltStore'
import { useCanvasStore, groupBounds, MIN_ZOOM, MAX_ZOOM } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useBoardsStore } from '../../store/boardsStore'
import { getMediaItems } from '../../types/bar'
import { faceBlocks } from '../../utils/cardGrid'
import { createTiltScene, type TiltTarget, type TiltFrameState, type TiltSlab, type TiltArt } from '../../three/tiltScene'

/** Degrees of tilt / turn per pixel of Alt+drag. */
const DRAG_DEG = 0.25
/** Sideways px an Alt+drag can wander before it starts turning the plane. */
const TURN_SLOP = 14
/** Most models stood up at once — they are heavy. */
const MAX_MODELS = 12

const hostOf = (el: Element | null) => el?.closest('[data-zoom-bar-host]') as HTMLElement | null

/** Ease the view's centre from `from` to `to` (canvas units) over
 *  GLIDE_MS, whatever the zoom does meanwhile. Slow in and out: moving
 *  your place on the canvas should never jolt. */
const GLIDE_MS = 1100
/** Tipping back from flat glides the view to the selection. Off for now:
 *  Brian found it didn't feel right (2026-10-30). F still frames. */
const GLIDE_ON_TILT = false
let glideRaf: number | null = null
function glideTo(from: { x: number; y: number }, to: { x: number; y: number }, W: number, H: number) {
  if (glideRaf !== null) cancelAnimationFrame(glideRaf)
  const start = performance.now()
  const tick = () => {
    const u = Math.min(1, (performance.now() - start) / GLIDE_MS)
    const k = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
    const z = useCanvasStore.getState().zoom
    const cx = from.x + (to.x - from.x) * k, cy = from.y + (to.y - from.y) * k
    useCanvasStore.getState().setPan({ x: W / 2 - cx * z, y: H / 2 - cy * z })
    glideRaf = u < 1 ? requestAnimationFrame(tick) : null
  }
  glideRaf = requestAnimationFrame(tick)
}

/** Alt+left-drag anywhere on the canvas host tilts it — over bare canvas
 *  or a card, a tile or a 3D Viewer, flat or already tilted. */
function useAltTiltGesture() {
  useEffect(() => {
    let altUsed = false
    let swallowMenu = false
    let swallowClick = false
    // Alt is the camera and nothing else (Brian 2026-10-30): with it held,
    // a press anywhere on the canvas, cards and tiles included, only moves
    // the view. Nothing under it selects, drags or changes — 3D Viewers
    // included, whatever the button (Brian 2026-10-30: no outliers). The
    // HUD's buttons still work.
    const onDown = (e: PointerEvent) => {
      swallowClick = false
      if (!e.altKey) return
      const target = e.target as Element | null
      const host = hostOf(target)
      if (!host) return
      if (target?.closest('input,textarea,select,[contenteditable="true"],[data-tilt-hud]')) return
      if (e.button === 1) {
        // Tilted, Alt+middle is the 3D pan (TiltedView). Flat, a Viewer
        // would pan its own picture: the canvas pans instead, as it does
        // everywhere else.
        if (!target?.closest('[data-viewport3d]') || isTilted(useTiltStore.getState().tilt)) return
        e.preventDefault()
        e.stopImmediatePropagation()
        altUsed = true
        swallowClick = true
        let last = { x: e.clientX, y: e.clientY }
        const onMove = (ev: PointerEvent) => {
          ev.stopImmediatePropagation()
          useCanvasStore.getState().shiftPan(ev.clientX - last.x, ev.clientY - last.y)
          last = { x: ev.clientX, y: ev.clientY }
        }
        const onUp = (ev: PointerEvent) => {
          ev.stopImmediatePropagation()
          window.removeEventListener('pointermove', onMove, true)
          window.removeEventListener('pointerup', onUp, true)
        }
        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', onUp, true)
        return
      }
      if (e.button !== 0 && e.button !== 2) return
      e.preventDefault()
      e.stopImmediatePropagation()
      altUsed = true
      swallowClick = true
      if (e.button === 2) { dolly(e, host); swallowMenu = true; return }
      const { tilt: t0, spin: s0 } = useTiltStore.getState()
      const x0 = e.clientX, y0 = e.clientY
      // Tipping back from flat with something selected makes it the pivot:
      // the view glides over to centre it while the plane tilts, wherever
      // on screen it was.
      const sel = GLIDE_ON_TILT && t0 < TILT_SNAP ? frameBox(true) : null
      const W = host.clientWidth, H = host.clientHeight
      const { pan, zoom } = useCanvasStore.getState()
      const cFrom = { x: (W / 2 - pan.x) / zoom, y: (H / 2 - pan.y) / zoom }
      const cTo = sel && { x: (sel.x0 + sel.x1) / 2, y: (sel.y0 + sel.y1) / 2 }
      let glideStarted = false
      // Orbit like Blender/Maya: you grab the near part of the ground —
      // drag up tips it away, drag right swings it right.
      const onMove = (ev: PointerEvent) => {
        // A little sideways slop while tipping back must not twist the
        // plane: turning starts only past a few px of real sideways drag.
        const dx = ev.clientX - x0
        const turnPx = Math.sign(dx) * Math.max(0, Math.abs(dx) - TURN_SLOP)
        useTiltStore.getState().setView(t0 - (ev.clientY - y0) * DRAG_DEG, s0 - turnPx * DRAG_DEG)
        if (cTo && !glideStarted && useTiltStore.getState().tilt > 0.5) {
          glideStarted = true
          glideTo(cFrom, cTo, W, H)
        }
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        if (useTiltStore.getState().tilt < TILT_SNAP) useTiltStore.getState().flatten()
      }
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
    }
    // Releasing Alt after a tilt must not pop the desktop app's menu bar.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && altUsed) { e.preventDefault(); altUsed = false }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altUsed = false
      if (e.key !== 'Escape' || !isTilted(useTiltStore.getState().tilt)) return
      const t = document.activeElement as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      useTiltStore.getState().flatten()
    }
    // Alt+right-drag zooms; the right button's context menu must not open
    // when it lets go.
    const onMenu = (e: MouseEvent) => {
      if (swallowMenu) { e.preventDefault(); e.stopPropagation(); swallowMenu = false }
    }
    // The click (and double-click) a camera press ends in reaches nothing;
    // the next press clears this.
    const onClick = (e: MouseEvent) => {
      if (!swallowClick) return
      e.preventDefault(); e.stopImmediatePropagation()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('contextmenu', onMenu, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('dblclick', onClick, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('contextmenu', onMenu, true)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('dblclick', onClick, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])
}

/** Alt+right-drag: zoom straight toward the middle of the view, flat or
 *  tilted (Maya's dolly) — right or up zooms in, left or down zooms out. */
function dolly(e: PointerEvent, host: HTMLElement) {
  const c = viewCentre(host)
  if (!c) return
  const px = c.x, py = c.y
  let last = { x: e.clientX, y: e.clientY }
  const onMove = (ev: PointerEvent) => {
    const d = (ev.clientX - last.x) - (ev.clientY - last.y)
    last = { x: ev.clientX, y: ev.clientY }
    if (d) useCanvasStore.getState().zoomAtPoint(Math.exp(d * 0.006), px, py)
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
  }
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
}

/** Where the camera is looking: the flat-view point (px in the host) at the
 *  middle of the screen. Zooming goes straight in and out along that line
 *  (Brian 2026-10-30), not toward the cursor. */
function viewCentre(host: HTMLElement): { x: number; y: number } | null {
  const W = host.clientWidth, H = host.clientHeight
  const { tilt, spin, shiftX, shiftY } = useTiltStore.getState()
  if (!isTilted(tilt)) return { x: W / 2, y: H / 2 }
  const p = unprojectTilt(0, 0, tilt, spin, shiftX, shiftY)
  return p && { x: p.x + W / 2, y: p.y + H / 2 }
}

type Rect = { x: number; y: number; w: number; h: number }

/** Canvas-unit bounds of the selected cards and tiles — or of everything
 *  on the canvas when nothing is selected. Pinned things never count. */
function frameBox(onlySelection = false): { x0: number; y0: number; x1: number; y1: number; selected: boolean } | null {
  const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
  const pick = (nodeIds: string[], groupIds: string[]) => [
    ...nodeIds.map(id => fs.nodes[id]).filter(n => n && !n.pin).map(n => ({ x: n.x, y: n.y, w: n.width, h: n.height })),
    ...groupIds.filter(id => !bs.groups.find(g => g.id === id)?.pin).map(groupBounds),
  ].filter((r): r is Rect => !!r)
  let rects = pick(fs.selectedIds, bs.selectedGroupIds)
  const selected = rects.length > 0
  if (!selected && !onlySelection) rects = pick(Object.keys(fs.nodes), bs.groups.map(g => g.id))
  if (!rects.length) return null
  return {
    x0: Math.min(...rects.map(r => r.x)), y0: Math.min(...rects.map(r => r.y)),
    x1: Math.max(...rects.map(r => r.x + r.w)), y1: Math.max(...rects.map(r => r.y + r.h)),
    selected,
  }
}

/** F frames the selection — the cards and tiles selected — in the middle
 *  of the view, which is also the pivot the tilted view orbits about. With
 *  nothing selected, F frames everything on the canvas. Flat or tilted. */
function useFrameKey() {
  useEffect(() => {
    let raf: number | null = null
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'f' && e.key !== 'F') return
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      const t = document.activeElement as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const host = document.querySelector<HTMLElement>('[data-zoom-bar-host]')
      if (!host) return
      const box = frameBox()
      if (!box) return
      e.preventDefault()
      const { x0, y0, x1, y1, selected } = box
      const W = host.clientWidth, H = host.clientHeight
      // Tilted, a model stands up out of its card: leave room above it.
      const fill = selected ? (isTilted(useTiltStore.getState().tilt) ? 0.38 : 0.6) : 0.9
      const zTo = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(W * fill / Math.max(x1 - x0, 1), H * fill / Math.max(y1 - y0, 1))))
      const cTo = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
      const { pan, zoom: zFrom } = useCanvasStore.getState()
      const cFrom = { x: (W / 2 - pan.x) / zFrom, y: (H / 2 - pan.y) / zFrom }
      // The camera comes back square on the framed thing too.
      const { shiftX: sx0, shiftY: sy0 } = useTiltStore.getState()
      // Glide: the centre moves straight, the zoom evenly in notches.
      if (raf !== null) cancelAnimationFrame(raf)
      const start = performance.now()
      const tick = () => {
        const u = Math.min(1, (performance.now() - start) / GLIDE_MS)
        const k = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
        const z = Math.exp(Math.log(zFrom) + (Math.log(zTo) - Math.log(zFrom)) * k)
        const cx = cFrom.x + (cTo.x - cFrom.x) * k, cy = cFrom.y + (cTo.y - cFrom.y) * k
        useCanvasStore.setState({ zoom: z, pan: { x: W / 2 - cx * z, y: H / 2 - cy * z } })
        if (sx0 || sy0) useTiltStore.getState().setShift(sx0 * (1 - k), sy0 * (1 - k))
        raf = u < 1 ? requestAnimationFrame(tick) : null
      }
      raf = requestAnimationFrame(tick)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown); if (raf !== null) cancelAnimationFrame(raf) }
  }, [])
}

/** Back flat with the camera still moved sideways: that move is now just a
 *  slide of the flat canvas, so it becomes the canvas pan and the shift
 *  goes. The view does not move; nothing is remembered for next time. */
function useShiftToPan() {
  useEffect(() => useTiltStore.subscribe(s => {
    if (s.tilt !== 0 || s.spin !== 0 || (!s.shiftX && !s.shiftY)) return
    // The pan is drawn by React and the shift straight on the stage: draw
    // the new pan now (flushSync), then drop the shift, so the next frame
    // shows both changes together and the view does not move. Clearing the
    // shift here, not later, also stops a second store update moving the
    // pan twice.
    flushSync(() => useCanvasStore.getState().shiftPan(s.shiftX, s.shiftY))
    useTiltStore.getState().setShift(0, 0)
  }), [])
}

export const TiltLayer: React.FC = () => {
  useAltTiltGesture()
  useFrameKey()
  useShiftToPan()
  const tilted = useTiltStore(s => isTilted(s.tilt))
  return (
    <>
      <TiltModels />
      {tilted && <TiltedView />}
    </>
  )
}

/** The 3D side, shared between the always-on TiltModels and the input in
 *  TiltedView. */
const models: {
  /** Hit test at a client point: a model's key, `person|<key>`, or null. */
  pick: ((clientX: number, clientY: number) => string | null) | null
  info: ((key: string) => { url: string; unit: number } | null) | null
  hovered: string | null
  /** Where the cursor rests over the plane with no button down, or null. */
  at: { x: number; y: number } | null
} = { pick: null, info: null, hovered: null, at: null }

const frameState = (): TiltFrameState => {
  const ts = useTiltStore.getState()
  const { unitsPerMetre: scales, sizeOf } = useModelScaleStore.getState()
  return {
    tilt: ts.tilt, spin: ts.spin, shiftX: ts.shiftX, shiftY: ts.shiftY, texture: ts.texture, flat: ts.flat, wire: ts.wire, light: ts.light, turn: ts.turn,
    walls: ts.walls, figure: ts.figure, hovered: models.hovered,
    selected: new Set([
      ...useFreeNodeStore.getState().selectedIds.map(id => `node:${id}`),
      ...useBoardsStore.getState().selectedGroupIds.map(id => `card:${id}`),
    ]),
    unitsFor: url => scales[url],
    sizeFor: key => sizeOf[key] ?? 1,
    slabs: isTilted(ts.tilt) ? collectSlabs() : (dropLifts(), []),
    art: isTilted(ts.tilt) ? lastArt : [],
  }
}

/** Models standing on their cards (three/tiltScene). Mounted for the whole
 *  session, not just while tilted: the 3D view is built once, when the app
 *  is idle, and the models on screen are loaded and uploaded while still
 *  flat (when the view settles, and the moment Alt goes down). The first
 *  frames of a tilt then only draw. Only the cards in view are kept — at
 *  most MAX_MODELS — so memory follows what is on screen. */
const TiltModels: React.FC = () => {
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = rootRef.current!
    let view: ReturnType<typeof createTiltScene> | null = null
    let canvas: HTMLCanvasElement | null = null
    let raf = 0
    let warmTimer: ReturnType<typeof setTimeout> | null = null
    let shown = false

    const warm = () => {
      const W = root.clientWidth, H = root.clientHeight
      if (!view || !W || !H || isTilted(useTiltStore.getState().tilt)) return
      view.warm(W, H, collectTargets(W, H), frameState())
    }
    const warmSoon = () => {
      if (warmTimer) clearTimeout(warmTimer)
      warmTimer = setTimeout(warm, 500)
    }
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (!view || !canvas) return
      const tilted = isTilted(useTiltStore.getState().tilt)
      if (tilted !== shown) { shown = tilted; canvas.style.display = tilted ? 'block' : 'none' }
      if (!tilted) return
      const W = root.clientWidth, H = root.clientHeight
      if (models.at) models.hovered = models.pick?.(models.at.x, models.at.y) ?? null
      if (W && H) view.frame(now, W, H, collectTargets(W, H), frameState())
    }
    const build = () => {
      // A fresh canvas per mount: a canvas whose context was lost (cleanup
      // below) can never give a working one again, and StrictMode remounts.
      canvas = document.createElement('canvas')
      Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', display: 'none' })
      root.prepend(canvas)
      try {
        view = createTiltScene(canvas)
      } catch {
        canvas.remove(); canvas = null   // no WebGL: the plane still tilts, models stay flat
        return
      }
      const v = view
      models.pick = (clientX, clientY) => {
        const r = root.getBoundingClientRect()
        return v.pick(clientX - r.left, clientY - r.top)
      }
      models.info = key => v.info(key)
      warm()
      raf = requestAnimationFrame(frame)
    }
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(build, { timeout: 2500 })
      : window.setTimeout(build, 1200)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Alt' && !e.repeat) warm() }
    window.addEventListener('keydown', onKey, true)
    const unsubs = [
      useCanvasStore.subscribe(warmSoon),
      useFreeNodeStore.subscribe(warmSoon),
      useBoardsStore.subscribe(warmSoon),
    ]
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle as number)
      else clearTimeout(idle as ReturnType<typeof setTimeout>)
      window.removeEventListener('keydown', onKey, true)
      unsubs.forEach(u => u())
      if (warmTimer) clearTimeout(warmTimer)
      cancelAnimationFrame(raf)
      models.pick = null; models.info = null
      view?.dispose()
      canvas?.remove()
    }
  }, [])
  return <div ref={rootRef} style={{ position: 'absolute', inset: 0, zIndex: 850, pointerEvents: 'none' }} />
}

// ── Model cards ──


/** Offset of `el` inside `stage`, in layout px — offsets ignore transforms,
 *  so this is where the card sits on the FLAT plane even while tilted. */
function offsetIn(el: HTMLElement, stage: HTMLElement): { x: number; y: number } | null {
  let x = 0, y = 0
  let e: HTMLElement | null = el
  while (e && e !== stage) {
    x += e.offsetLeft; y += e.offsetTop
    e = e.offsetParent as HTMLElement | null
  }
  return e === stage ? { x, y } : null
}

/** A file's name from its url — nothing for a `mediaref:` (it has none). */
const fileName = (url: string) => /^mediaref:/.test(url) ? '' : decodeURIComponent(url.split(/[\\/]/).pop()!.split('?')[0])

/** The model a card's FRONT shows, if it is one: a closed deck shows its
 *  face card, and a card the block its face is stepped to (else its first
 *  picture block) — so flipping a deck or a card swaps the standing model.
 *  A bare block element (data-id is a board) uses that block. */
function cardModel(id: string): { url: string; name: string } | null {
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(gr => gr.id === id)
  let bid: string | null = id
  let name = ''
  if (g) {
    // A fanned deck's face shows the member clicked in the fan (its portal),
    // so the model above it follows that click.
    const portal = g.deckState === 'fanned' ? useCanvasStore.getState().deckPortalSelections[g.id] : undefined
    const face = (g.deckState === 'stacked' && g.deckFaceCard && bs.groups.find(gr => gr.id === g.deckFaceCard))
      || (portal && bs.groups.find(gr => gr.id === portal)) || g
    const blocks = faceBlocks(face, bs.boards)
    bid = face.faceBoardId && blocks.includes(face.faceBoardId) ? face.faceBoardId
      : face.cardHeroImage ? null : blocks[0] ?? null
    name = face.name
  }
  const board = bid ? bs.boards[bid] : undefined
  for (const rid of board?.rootIds ?? []) {
    const m = getMediaItems(board!.bars[rid]?.content).find(it => it.type === 'image' || it.type === 'video' || it.type === 'model')
    if (!m) continue
    return m.type === 'model' ? { url: m.url, name: m.originalName || fileName(m.url) || name || 'Model' } : null
  }
  return null
}

/** How thick things are, as a share of their shorter side: a Viewer like
 *  a phone on a table, a tile a bit less, a card thinner, and a closed deck
 *  as thick as the cards in it. */
const THICK = { viewer: 0.05, tile: 0.03, card: 0.012, deckMax: 0.25 }
const SIDE = { viewer: 0x4a4e5c, tile: 0x7a829e, card: 0x8a93b4, tray: 0x464c60, pop: 0x6a7088, edge: 0xc4c9d8 }
/** The most slices a deck's side is built from (its cards, or bands of them). */
const DECK_SLICES = 10

/** An element's corner radius in its own px, so a slab's corners match
 *  the rounded box drawn on top of it. */
function radiusOf(el: HTMLElement): number {
  return parseFloat(el.style.borderRadius || getComputedStyle(el).borderTopLeftRadius) || 0
}

/** Every card, deck, tile and Viewer on the tilted plane, as slabs (flat px
 *  from the host centre). Read from layout offsets, which tilting does not
 *  change, so this is cheap enough for every frame. */
function collectSlabs(): TiltSlab[] {
  const out: TiltSlab[] = []
  const lifting = new Map<HTMLElement, number>()
  /** Cards on a loop strip, by group id: how high their stand-in stands. */
  const docked = new Map<string, number>()
  const host = document.querySelector<HTMLElement>('[data-tilt-stage="world"]')
  if (!host) return out
  const W = host.offsetWidth, H = host.offsetHeight
  const add = (x: number, y: number, w: number, h: number, t: number, color: number, r: number) => {
    const u = x + w / 2 - W / 2, v = y + h / 2 - H / 2
    if (w < 3 || h < 3 || Math.abs(u) > W * 1.5 || Math.abs(v) > H * 1.5) return
    out.push({ u, v, w, h, t, color, r })
    return out[out.length - 1]
  }
  // World layer: tiles and Viewers, in world units under the pan/zoom.
  const { pan, zoom } = useCanvasStore.getState()
  for (const world of host.querySelectorAll<HTMLElement>(':scope > div[style*="scale("]')) {
    for (const node of world.querySelectorAll<HTMLElement>('[data-viewport3d]:not([data-pinned]), [data-freenode][data-id]:not([data-pinned])')) {
      // A loop strip paints its face on its own body, which can sit off the
      // tile's box and outgrow it: the slab follows the body.
      const el = node.hasAttribute('data-rail') ? node.querySelector<HTMLElement>('[data-rail-body]') ?? node : node
      const at = offsetIn(el, world)
      if (!at) continue
      const viewer = node.hasAttribute('data-viewport3d')
      const w = el.offsetWidth * zoom, h = el.offsetHeight * zoom
      const m = Math.min(w, h)
      const slab = add(pan.x + at.x * zoom, pan.y + at.y * zoom, w, h,
        m * (viewer ? THICK.viewer : THICK.tile), viewer ? SIDE.viewer : SIDE.tile, radiusOf(el) * zoom)
      if (!slab) continue
      const fs = useFreeNodeStore.getState()
      if (node.hasAttribute('data-rail')) {
        // A loop strip is a tray: a rim round its edge, its floor the face.
        // Far off (small on screen) it settles back to a plain slab.
        const k = detail(w)
        const u = fs.nodes[node.dataset.id!]?.rail?.unit || 1
        if (k > 0) slab.rim = { w: TRAY.rimW * u * zoom, h: TRAY.rimH * u * zoom * k }
        slab.color = SIDE.tray
        // The run arrow and the band of headers under it stand up out of
        // the tray, above its rim and the cards (Brian 2026-10-30).
        if (k > 0) {
          // Clear of the cards on it too (their tops, a single card thick).
          let top = 0
          for (const o of Object.values(fs.nodes)) {
            const d = o.railDock
            if (!d || d.railId !== node.dataset.id || d.lifted) continue
            const om = Math.min(o.width, o.height) * zoom
            top = Math.max(top, (dockLift(om, d.order ?? 0) + om * THICK.card) * k)
          }
          const H = Math.max(TRAY.rimH * TRAY.band * u * zoom * k, top + TRAY.rimH * u * zoom * k)
          for (const part of el.querySelectorAll<HTMLElement>('[data-rail-band], [data-rail-arrow]')) {
            const a = offsetIn(part, world)
            if (!a || !part.offsetWidth) continue
            const s = add(pan.x + a.x * zoom, pan.y + a.y * zoom, part.offsetWidth * zoom, part.offsetHeight * zoom, H,
              SIDE.tray, (radiusOf(part) || 6 * u) * zoom)
            if (s) s.z = H
            lifting.set(part, H)
            chain(part, world)
            // Solid, its sides the colour of its face, as a raised button's.
            const face = fill(part)
            if (s && face) s.color = (face[0] << 16) | (face[1] << 8) | face[2]
          }
          for (const head of el.querySelectorAll<HTMLElement>('[data-rail-head], [data-rail-card-head], [data-rail-tray-head]')) {
            lifting.set(head, H)
            chain(head, world)
          }
        }
      } else if (node.hasAttribute('data-rail-docked')) {
        // Cards docked in a strip sit on its floor, each in the column a
        // little above the one before: a real stack, with its own sides.
        const n = fs.nodes[node.dataset.id!]
        const strip = n?.railDock && world.querySelector<HTMLElement>(`[data-freenode][data-id="${n.railDock.railId}"] [data-rail-body]`)
        const k = strip ? detail(strip.offsetWidth * zoom) : 0
        if (k > 0) {
          slab.z = dockLift(m, n?.railDock?.order ?? 0) * k
          slab.t = slab.z    // stacked on the floor, so its sides reach it
          lifting.set(node, slab.z)
        }
        // A card (or deck) on a strip is drawn by the card layer over an
        // invisible stand-in tile: the card takes the stand-in's place in
        // the stack (below), and the stand-in has no slab of its own.
        if (n?.cardRef) {
          if (k > 0) docked.set(n.cardRef, slab.z!)
          out.pop()
          continue
        }
      }
      // In a solitaire stack the cards above cover part of this one: what
      // they cover stays flat, so none of it pokes up through them.
      const over = coversOf(node.dataset.id)
      popParts(node, world, slab.z ?? 0, m, detail(w), lifting, (el, z, t) => {
        const a = offsetIn(el, world)
        if (!a) return
        if (over.some(r => a.x < r.x + r.width && r.x < a.x + el.offsetWidth && a.y < r.y + r.height && r.y < a.y + el.offsetHeight)) return false
        const p = add(pan.x + a.x * zoom, pan.y + a.y * zoom, el.offsetWidth * zoom, el.offsetHeight * zoom, t, SIDE.pop, radiusOf(el) * zoom)
        if (p) { p.z = z; p.pop = true }
        return p
      })
    }
  }
  // A card (or deck) on a strip has an invisible stand-in tile that is never
  // drawn, so its lift is worked out from the store: it stands on the
  // strip's floor, clear of it, like a docked tile.
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    if (!n.cardRef || !n.railDock || n.railDock.lifted) continue
    const strip = host.querySelector<HTMLElement>(`[data-freenode][data-id="${n.railDock.railId}"] [data-rail-body]`)
    const k = strip ? detail(strip.offsetWidth * zoom) : 0
    if (k > 0) docked.set(n.cardRef, dockLift(Math.min(n.width, n.height) * zoom, n.railDock.order ?? 0) * k)
  }
  // Card layer: cards and closed decks, already in screen px.
  const stage = document.querySelector<HTMLElement>('[data-tilt-stage="overlay"]')
  if (stage) {
    const groups = useBoardsStore.getState().groups
    const zones = hitZones(stage)
    for (const el of stage.querySelectorAll<HTMLElement>('[data-group-card][data-id]')) {
      const at = offsetIn(el, stage)
      if (!at) continue
      const id = el.dataset.id!
      const g = groups.find(gr => gr.id === id)
      if (g?.deckState === 'fanned') { fanSlabs(el, stage, at, add, lifting, docked.get(id)); continue }
      const n = g?.deckState === 'stacked' ? 1 + groups.filter(o => o.deckAnchorId === id && o.deckState === 'stacked').length : 1
      const w = el.offsetWidth, h = el.offsetHeight, m = Math.min(w, h)
      const r = radiusOf((el.firstElementChild as HTMLElement | null) ?? el) || m * 0.06
      // On a loop strip it stands on the tray's floor, else on the canvas.
      const lift = docked.get(id) ?? (g?.deckAnchorId ? docked.get(g.deckAnchorId) : undefined)
      const k = detail(w)
      let card: TiltSlab | undefined
      if (k <= 0 && lift === undefined) {
        card = add(at.x, at.y, w, h, m * THICK.card, SIDE.card, r)
      } else {
        // A card stands on what holds it, its thickness above it; a deck is
        // as tall as its cards, each a slice, the lower ones stepping out to
        // the right as its flat edges do. Its face rides on top.
        const per = m * THICK.card * Math.max(k, lift === undefined ? 0 : 1)
        const thick = Math.min(m * THICK.deckMax, per * n)
        const base = lift ?? 0
        const reserve = n > 1 ? Math.min(10, w * 0.05) : 0
        card = add(at.x, at.y, w - reserve, h, lift === undefined ? per : thick, SIDE.card, r)
        if (card) {
          card.z = base + thick
          lifting.set(el, card.z)
          chain(el, stage)
          riseZones(zones, at, w, h, card.z, lifting, stage)
          if (n > 1) hideEdges(el)
          const L = Math.min(n - 1, DECK_SLICES), below = thick - per
          for (let j = 1; j <= L; j++) {
            const s = add(at.x, at.y, w - reserve + reserve * j / L, h, below / L, j % 2 ? SIDE.edge : SIDE.card, r)
            if (s) { s.z = base + below * (1 - (j - 1) / L); s.cap = true }
          }
        }
      }
      popParts(el, stage, card?.z ?? 0, m, detail(w), lifting, (part, z, t) => {
        const a = offsetIn(part, stage)
        if (!a) return
        const p = add(a.x, a.y, part.offsetWidth, part.offsetHeight, t, SIDE.pop, radiusOf(part))
        if (p) { p.z = z; p.pop = true }
        return p
      })
    }
    // Zoomed in to Blocks or Boards, a card is drawn as its outline.
    for (const el of stage.querySelectorAll<HTMLElement>('[data-group-outline]')) {
      const at = offsetIn(el, stage)
      if (!at) continue
      const w = el.offsetWidth, h = el.offsetHeight, m = Math.min(w, h)
      add(at.x, at.y, w, h, m * THICK.card, SIDE.card, Math.min(12, m * 0.08))
    }
  }
  setLifts(lifting)
  // Artwork — pictures, videos, Viewer screens — read after the lifts are
  // set, so a lifted card's picture is masked at its height.
  lastArt = []
  const art = (x: number, y: number, w: number, h: number, z: number) => {
    if (w < 12 || h < 12 || lastArt.length >= 200) return
    lastArt.push({ u: x + w / 2 - W / 2, v: y + h / 2 - H / 2, w, h, z })
  }
  for (const world of host.querySelectorAll<HTMLElement>(':scope > div[style*="scale("]')) {
    for (const el of world.querySelectorAll<HTMLElement>(ART)) {
      const at = offsetIn(el, world)
      if (at) art(pan.x + at.x * zoom, pan.y + at.y * zoom, el.offsetWidth * zoom, el.offsetHeight * zoom, liftOf(el))
    }
  }
  if (stage) {
    for (const el of stage.querySelectorAll<HTMLElement>(ART)) {
      const at = offsetIn(el, stage)
      if (at) art(at.x, at.y, el.offsetWidth, el.offsetHeight, liftOf(el))
    }
  }
  return out
}
// A card face's picture can also be a background image.
const ART = 'img, video, canvas, [style*="background-image: url"]'
let lastArt: TiltArt[] = []

/** The bits of a face that stand proud of it when tilted, near enough:
 *  a tile's header bar, and on an effect face its on/off-solo-↑ buttons
 *  and its name banner. Raised by a share of the card's shorter side. */
const POP = 0.025
function popParts(root: HTMLElement, stage: HTMLElement, base: number, m: number, k: number,
                  lifting: Map<HTMLElement, number>, slab: (el: HTMLElement, z: number, t: number) => false | TiltSlab | undefined) {
  if (k <= 0) return
  const parts = new Set<HTMLElement>()
  const head = root.querySelector<HTMLElement>(':scope > [data-freenode-header]')
  if (head) parts.add(head)
  for (const b of root.querySelectorAll<HTMLElement>('[data-fx-onoff], [data-fx-solo], [data-fx-drag-out], [data-card-face-arrow]')) parts.add(b)
  for (const b of root.querySelectorAll<HTMLElement>('select[aria-label="Effect"]')) {
    if (b.parentElement) parts.add(b.parentElement)
  }
  const t = m * POP * k
  for (const el of parts) {
    if (!el.offsetWidth || !el.offsetHeight) continue
    const p = slab(el, base + t, t)
    if (p === false) continue
    lifting.set(el, t)
    chain(el, stage)
    // One piece: the part's sides are the colour of its face, and a button's
    // ring goes the same colour, so no rim reads as a second disc on top.
    const face = fill(el)
    if (p && face) p.color = (face[0] << 16) | (face[1] << 8) | face[2]
  }
}

/** The boxes (world units) of the cards stacked over docked tile `id` in
 *  its strip column: the ones after it, which stand higher. */
function coversOf(id: string | undefined): { x: number; y: number; width: number; height: number }[] {
  const nodes = useFreeNodeStore.getState().nodes
  const d = id ? nodes[id]?.railDock : undefined
  if (!d || d.lifted) return []
  return Object.values(nodes).filter(o => o.id !== id && o.railDock && !o.railDock.lifted &&
    o.railDock.railId === d.railId && o.railDock.slotId === d.slotId && (o.railDock.order ?? 0) > (d.order ?? 0))
}

/** For a raised bit to really stand off its face, every box between it and
 *  the stage has to keep its children in 3D (preserve-3d), and none may
 *  clip: overflow hidden (and clip, in Chromium) flattens them back onto
 *  the face. So those boxes stop clipping while tilted; tilting flat
 *  restores them. */
let chained = new Map<HTMLElement, { ts: string; ov: string }>()
let chaining = new Map<HTMLElement, { ts: string; ov: string }>()
function chain(el: HTMLElement, stage: HTMLElement) {
  for (let e = el.parentElement; e && e !== stage; e = e.parentElement) {
    if (chaining.has(e)) continue
    const was = chained.get(e) ?? { ts: e.style.transformStyle, ov: e.style.overflow }
    chaining.set(e, was)
    if (!chained.has(e)) {
      e.style.transformStyle = 'preserve-3d'
      if (getComputedStyle(e).overflow !== 'visible') e.style.overflow = 'visible'
    }
  }
}
/** A raised part has to be solid: one with a see-through background would
 *  show the face under it through its lid. While raised it is filled with
 *  the colour it shows flat (its own over what is behind it). */
type Filled = { bs: string; bc: string; rgb: number[] }
let filled = new Map<HTMLElement, Filled>()
let filling = new Map<HTMLElement, Filled>()
function fill(el: HTMLElement): number[] {
  // Read again each frame: a toggle's colour changes as it is pressed.
  const was = filled.get(el) ?? { bs: el.style.boxShadow, bc: el.style.borderColor, rgb: [0, 0, 0] }
  filling.set(el, was)
  const cs = getComputedStyle(el)
  const own = rgba(cs.backgroundColor)
  let under: number[] = [24, 24, 30, 1]
  for (let e = el.parentElement; own[3] < 1 && e; e = e.parentElement) {
    const c = rgba(getComputedStyle(e).backgroundColor)
    if (c[3] >= 1) { under = c; break }
  }
  const a = own[3]
  was.rgb = [0, 1, 2].map(i => Math.round(own[i] * a + under[i] * (1 - a)))
  const css = `rgb(${was.rgb.join(',')})`
  // Painted as an inset shadow over the background, not as the background
  // itself, which React owns (a toggle sets it as it is pressed).
  const bs = a < 1 ? `inset 0 0 0 9999px ${css}${was.bs ? ', ' + was.bs : ''}` : was.bs
  if (el.style.boxShadow !== bs) el.style.boxShadow = bs
  if (parseFloat(cs.borderTopWidth) > 0 && rgba(cs.borderTopColor).join() !== rgba(css).join()) el.style.borderColor = css
  return was.rgb
}
/** A fanned deck stands up too: its front card on top, and each strip
 *  peeking out to the right a card lower than the one before, a stair of
 *  cards down to the canvas. The strips follow their slide as the fan
 *  opens or closes (their animated transform). Everything else on the
 *  fan (the face it surfaces, its controls) rides at the front card's
 *  height, on top. */
type AddSlab = (x: number, y: number, w: number, h: number, t: number, color: number, r: number) => TiltSlab | undefined
function fanSlabs(el: HTMLElement, stage: HTMLElement, at: { x: number; y: number }, add: AddSlab,
                  lifting: Map<HTMLElement, number>, lift: number | undefined) {
  const kids = [...el.children].filter(c => (c as HTMLElement).matches('[data-card-drop], [data-deck-slot-drop]')) as HTMLElement[]
  if (!kids.length) return
  const front = kids.reduce((a, b) => (b.offsetLeft === 0 && b.offsetWidth >= a.offsetWidth ? b : a))
  const strips = kids.filter(c => c !== front).sort((a, b) => a.offsetLeft - b.offsetLeft)
  const w = front.offsetWidth, h = front.offsetHeight, m = Math.min(w, h)
  const k = lift === undefined ? detail(w) : 1
  if (k <= 0) { add(at.x, at.y, w, h, m * THICK.card, SIDE.card, 12); return }
  const per = m * THICK.card * k
  const base = lift ?? 0
  const top = base + per * (strips.length + 1)
  // The wrapper stays at the deck's base and its children rise from it:
  // a lifted wrapper (it takes the pointer) would sit over the lowered
  // strips and steal their hover, so a strip would never surface.
  if (base) lifting.set(el, base)
  chain(el, stage)
  for (const c of el.children) if (!strips.includes(c as HTMLElement)) { lifting.set(c as HTMLElement, top - base); chain(c as HTMLElement, stage) }
  const c = add(at.x + front.offsetLeft, at.y + front.offsetTop, w, h, top - base, SIDE.card, radiusOf(front) || 12)
  if (c) c.z = top
  strips.forEach((st, i) => {
    const z = top - per * (i + 1)
    lifting.set(st, z - base)
    chain(st, stage)
    const mx = new DOMMatrix(getComputedStyle(st).transform)
    const s = add(at.x + st.offsetLeft + mx.m41, at.y + st.offsetTop, st.offsetWidth * mx.a, st.offsetHeight, z - base,
      i % 2 ? SIDE.card : SIDE.edge, 6)
    if (s) s.z = z
  })
}

/** Invisible hit zones laid over a card (an opened deck's front card has
 *  one: its double-click closes the deck). Flat, they sit above the card
 *  by z-index; tilted, the card stands up through them, so a zone over a
 *  raised card is raised with it, a hair above, and takes its clicks as it
 *  does flat. */
function hitZones(stage: HTMLElement): { el: HTMLElement; at: { x: number; y: number } }[] {
  const out: { el: HTMLElement; at: { x: number; y: number } }[] = []
  for (const el of stage.querySelectorAll<HTMLElement>('div[style*="pointer-events: all"]')) {
    if (el.childElementCount || el.closest('[data-group-card]') || el.hasAttribute('data-freenode')) continue
    const at = offsetIn(el, stage)
    if (at) out.push({ el, at })
  }
  return out
}
function riseZones(zones: ReturnType<typeof hitZones>, at: { x: number; y: number }, w: number, h: number, z: number,
                   lifting: Map<HTMLElement, number>, stage: HTMLElement) {
  for (const zn of zones) {
    if (Math.abs(zn.at.x - at.x) > 1 || Math.abs(zn.at.y - at.y) > 1 || Math.abs(zn.el.offsetWidth - w) > 1 || Math.abs(zn.el.offsetHeight - h) > 1) continue
    lifting.set(zn.el, z + 0.5)
    chain(zn.el, stage)
  }
}

/** A closed deck's flat edge lines (its outline children, which take no
 *  clicks) give way to the modelled edges while it stands up. */
let hidden = new Set<HTMLElement>()
let hiding = new Set<HTMLElement>()
function hideEdges(deck: HTMLElement) {
  for (const c of deck.children) {
    const e = c as HTMLElement
    if (e.style.pointerEvents !== 'none' || e.offsetWidth > 16) continue
    hiding.add(e)
    if (!hidden.has(e)) e.style.visibility = 'hidden'
  }
}
function rgba(css: string): number[] {
  const n = css.match(/[\d.]+/g)?.map(Number) ?? []
  return n.length >= 3 ? [n[0], n[1], n[2], n[3] ?? 1] : [0, 0, 0, 0]
}
function settleChains() {
  for (const [e, was] of filled) if (!filling.has(e)) { e.style.boxShadow = was.bs; e.style.borderColor = was.bc }
  for (const e of hidden) if (!hiding.has(e)) e.style.visibility = ''
  hidden = hiding
  hiding = new Set()
  filled = filling
  filling = new Map()
  for (const [e, was] of chained) {
    if (chaining.has(e)) continue
    e.style.transformStyle = was.ts
    e.style.overflow = was.ov
  }
  chained = chaining
  chaining = new Map()
}

/** How a loop strip reads as a tray, in its own units (and cards'
 *  thickness inside it as a share of their shorter side). */
const TRAY = { rimW: 6, rimH: 7, card: 0.03, stack: 0.9, band: 2.2 }
/** How far a docked card's underside stands off the strip's floor: never
 *  less than GAP px, so the two faces are never level and never flicker. */
const GAP = 6
function dockLift(m: number, order: number): number {
  return Math.max(GAP, m * TRAY.card) * (1 + order * TRAY.stack)
}

/** Detail by distance: how much of the raised 3D (rims, lifts) a thing
 *  shows, by its width on screen — none below DETAIL_FROM px, all of it
 *  from DETAIL_FULL px, eased between. */
const DETAIL_FROM = 36, DETAIL_FULL = 80, DETAIL_TILT = 6
function detail(screenW: number): number {
  const x = Math.max(0, Math.min(1, (screenW - DETAIL_FROM) / (DETAIL_FULL - DETAIL_FROM)))
  // And by tilt: the raised parts grow out of the face over the first
  // DETAIL_TILT degrees, so tipping in or out of 3D never pops them.
  const y = Math.min(1, useTiltStore.getState().tilt / DETAIL_TILT)
  return x * x * (3 - 2 * x) * y * y * (3 - 2 * y)
}

/** The DOM tiles lifted off the plane (docked cards), and by how much. The
 *  lift is the CSS `translate` property, which leaves the tile's own
 *  transform alone; tilting flat puts them all back. */
let lifted = new Map<HTMLElement, number>()
function setLifts(next: Map<HTMLElement, number>) {
  for (const [el, z] of next) {
    if (Math.abs((lifted.get(el) ?? -1) - z) > 0.05) el.style.translate = `0 0 ${z.toFixed(2)}px`
  }
  for (const el of lifted.keys()) if (!next.has(el)) el.style.translate = ''
  if (!!next.size !== !!lifted.size) {
    for (const st of document.querySelectorAll('[data-tilt-stage]')) st.toggleAttribute('data-tilt-3d', next.size > 0)
  }
  lifted = next
  settleChains()
}
/** How high `el` stands: the lifts of everything raised that holds it
 *  (a button on a docked card stands on the card's lift), or 0. */
function liftOf(el: Element | null): number {
  let z = 0
  for (let e = el; e; e = e.parentElement) z += lifted.get(e as HTMLElement) ?? 0
  return z
}
function dropLifts() { if (lifted.size) setLifts(new Map()) }
// The 3D view may stop drawing once flat, so settle back here too: nothing
// stays lifted or unclipped in the flat view.
useTiltStore.subscribe(s => { if (!isTilted(s.tilt)) dropLifts() })

/** Every model card in view, as flat px from the host centre. */
function collectTargets(W: number, H: number): TiltTarget[] {
  const out: TiltTarget[] = []
  const { pan, zoom } = useCanvasStore.getState()
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    if (n.type !== 'model' || n.pin || !n.imageUrl) continue
    out.push({
      key: `node:${n.id}`, url: n.imageUrl,
      u: pan.x + (n.x + n.width / 2) * zoom - W / 2,
      v: pan.y + (n.y + n.height / 2) * zoom - H / 2,
      w: Math.min(n.width, n.height * 1.4) * zoom,
      h: n.height * zoom,
      name: fileName(n.imageUrl) || n.label || 'Model',
    })
  }
  // A Viewer showing a model, or with a card holding one docked beside it:
  // the model stands up on the Viewer, popping in, and leaves the card
  // (Brian 2026-10-30).
  const viewers = Object.values(useViewport3DStore.getState().windows).map(w => {
    const it = w.activeItem
    const x0 = pan.x + w.x * zoom, y0 = pan.y + w.y * zoom
    return { id: w.id, x0, y0, x1: x0 + w.width * zoom, y1: y0 + w.height * zoom,
      url: it?.kind === 'media' && it.mediaType === 'model' ? it.url : null, name: it?.kind === 'media' ? it.name : undefined }
  })
  const onViewer = (v: typeof viewers[number], url: string, name?: string) => out.push({
    key: `viewer:${v.id}`, url, name: name || fileName(url) || 'Model', pop: true,
    u: (v.x0 + v.x1) / 2 - W / 2, v: (v.y0 + v.y1) / 2 - H / 2,
    w: Math.min(v.x1 - v.x0, (v.y1 - v.y0) * 1.4) * 0.7, h: v.y1 - v.y0,
  })
  for (const v of viewers) if (v.url) onViewer(v, v.url, v.name)
  const GAP = 14
  const stage = document.querySelector<HTMLElement>('[data-tilt-stage="overlay"]')
  if (stage) {
    for (const el of stage.querySelectorAll<HTMLElement>('[data-group-card][data-id]')) {
      const model = cardModel(el.dataset.id!)
      const at = model && offsetIn(el, stage)
      if (!model || !at) continue
      const x = at.x, y = at.y, w = el.offsetWidth, h = el.offsetHeight
      const v = viewers.find(r => x <= r.x1 + GAP && x + w >= r.x0 - GAP && y <= r.y1 + GAP && y + h >= r.y0 - GAP)
      if (v && !v.url) { v.url = model.url; onViewer(v, model.url, model.name) }
      if (v?.url === model.url) continue
      out.push({
        key: `card:${el.dataset.id}`, url: model.url, name: model.name,
        u: at.x + el.offsetWidth / 2 - W / 2,
        v: at.y + el.offsetHeight / 2 - H / 2,
        w: Math.min(el.offsetWidth, el.offsetHeight * 1.4),
        h: el.offsetHeight,
        z: liftOf(el),
      })
    }
  }
  return out
    .filter(t => Math.abs(t.u) < W && Math.abs(t.v) < H && t.w > 4)
    .slice(0, MAX_MODELS)
}


/** Select what a screen-space box drawn on the tilted view covers. The
 *  cards' and tiles' on-screen boxes are their tilted outlines, so the test
 *  is in screen space, where the box was drawn. A click without a drag
 *  clears the selection, as on bare flat canvas. */
function marqueeSelect(m: { x0: number; y0: number; x1: number; y1: number }, add: boolean) {
  const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
  if (Math.abs(m.x1 - m.x0) < 4 && Math.abs(m.y1 - m.y0) < 4) {
    if (add) return
    fs.setFreeSelection([])
    bs.clearGroupSelection()
    bs.clearAllSelections()
    useCanvasStore.getState().clearAllDeckPortals()
    return
  }
  const l = Math.min(m.x0, m.x1), r = Math.max(m.x0, m.x1), t = Math.min(m.y0, m.y1), b = Math.max(m.y0, m.y1)
  const hits = (el: Element) => {
    const rc = el.getBoundingClientRect()
    return rc.right > l && rc.left < r && rc.bottom > t && rc.top < b
  }
  const ids = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel)).filter(hits).map(el => el.dataset.id!)
  const nodes = ids('[data-tilt-stage] [data-freenode][data-id]:not([data-pinned])')
  const cards = ids('[data-tilt-stage] [data-group-card][data-id]')
  fs.setFreeSelection(add ? [...new Set([...fs.selectedIds, ...nodes])] : nodes)
  bs.setSelectedGroups(add ? [...new Set([...bs.selectedGroupIds, ...cards])] : cards)
}

/** Select the card or tile a model stands on. */
function selectModel(key: string, add: boolean) {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
  const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
  if (kind === 'node') {
    fs.setFreeSelection(add ? [...new Set([...fs.selectedIds, id])] : [id])
    if (!add) bs.clearGroupSelection()
  } else {
    bs.setSelectedGroups(add ? [...new Set([...bs.selectedGroupIds, id])] : [id])
    if (!add) fs.setFreeSelection([])
  }
}

const TiltedView: React.FC = () => {
  const rootRef = useRef<HTMLDivElement>(null)
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const texture = useTiltStore(s => s.texture)
  const flat = useTiltStore(s => s.flat)
  const wire = useTiltStore(s => s.wire)
  const [lightOpen, setLightOpen] = useState(false)
  const turn = useTiltStore(s => s.turn)
  const walls = useTiltStore(s => s.walls)
  const figure = useTiltStore(s => s.figure)
  const tilt = useTiltStore(s => s.tilt)

  // ── Working on the tilted plane ──
  // The browser hit-tests the tilted DOM correctly, so a press lands on the
  // card under the cursor. Everything that card does with the press,
  // though, is flat-view math on clientX/Y. So the press and every move
  // and release that follow are re-sent to it at the FLAT point under the
  // cursor (the real ones are swallowed): dragging, resizing and
  // repositioning work on the ground exactly as they do flat.
  // Middle drag moves the camera in its own view plane (Maya's pan). The
  // wheel zooms straight in toward the middle of the view. Right-click is
  // left alone, so menus open where the cursor is.
  useEffect(() => {
    const root = rootRef.current!
    const host = hostOf(root)!
    const flatClient = (cx: number, cy: number, height = 0) => {
      const r = host.getBoundingClientRect()
      const { tilt: t, spin: s, shiftX, shiftY } = useTiltStore.getState()
      const p = unprojectTilt(cx - r.left - r.width / 2, cy - r.top - r.height / 2, t, s, shiftX, shiftY, height)
      return p && { x: p.x + r.width / 2 + r.left, y: p.y + r.height / 2 + r.top }
    }
    /** Pressed on the tilted canvas (not a pinned panel, the HUD, the zoom bar). */
    // Seen low or side-on, much of the screen shows no plane at all, only
    // the canvas behind it: that counts as the canvas too (bare ground), so
    // the camera can be grabbed anywhere.
    const canvasBox = () => document.querySelector('[data-tilt-stage="world"]')?.parentElement ?? null
    const onPlane = (t: EventTarget | null) => {
      const el = t as Element | null
      if (!el?.closest || hostOf(el) !== host) return false
      return !!el.closest('[data-tilt-stage]') || !!canvasBox()?.contains(el)
    }
    const isBareGround = (t: EventTarget | null) => {
      const el = t as Element
      return el.matches('[data-tilt-stage="world"]') || !el.closest('[data-tilt-stage]')
    }

    const resend = (e: MouseEvent, type: string, to: EventTarget, height = 0) => {
      // A lifted tile is pressed at its own height, not the floor's.
      const p = flatClient(e.clientX, e.clientY, height)
      if (!p) return
      // While the re-sent event runs, a handler asking what is under its
      // (flat) point is asking what is under the cursor: the browser hit-tests
      // the tilted DOM, so it is answered at the real point. Asked at the flat
      // point, a card let go over nothing found whatever card is drawn THERE
      // and was merged into it (Brian 2026-10-30: cards "deleted" by a drag).
      hitAt = { fx: p.x, fy: p.y, rx: e.clientX, ry: e.clientY }
      try { send(e, type, to, p) } finally { hitAt = null }
    }
    const send = (e: MouseEvent, type: string, to: EventTarget, p: { x: number; y: number }) => {
      const init: PointerEventInit = {
        bubbles: true, cancelable: true, composed: true, view: window, detail: e.detail,
        clientX: p.x, clientY: p.y,
        screenX: e.screenX + (p.x - e.clientX), screenY: e.screenY + (p.y - e.clientY),
        button: e.button, buttons: e.buttons,
        altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey,
      }
      if (type.startsWith('pointer')) {
        const pe = e as PointerEvent
        to.dispatchEvent(new PointerEvent(type, {
          ...init, pointerId: pe.pointerId, pointerType: pe.pointerType, isPrimary: pe.isPrimary,
          pressure: pe.pressure, width: pe.width, height: pe.height,
        }))
      } else {
        to.dispatchEvent(new MouseEvent(type, init))
      }
    }

    // Hit tests during a re-sent event: see resend.
    let hitAt: { fx: number; fy: number; rx: number; ry: number } | null = null
    const real = (x: number, y: number) => hitAt && Math.abs(x - hitAt.fx) < 0.5 && Math.abs(y - hitAt.fy) < 0.5 ? [hitAt.rx, hitAt.ry] : [x, y]
    const fromPoint = document.elementFromPoint, fromPoints = document.elementsFromPoint
    document.elementFromPoint = function (x: number, y: number) { const [a, b] = real(x, y); return fromPoint.call(this, a, b) }
    document.elementsFromPoint = function (x: number, y: number) { const [a, b] = real(x, y); return fromPoints.call(this, a, b) }

    type Gesture =
      | { kind: 'pan'; last: { x: number; y: number } }
      | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number }
      | { kind: 'person'; url: string; unit0: number; y0: number }
      | { kind: 'model'; key: string; k0: number; y0: number; moved: boolean }
      | { kind: 'remap'; target: Element; pointerId: number; height: number }
    let g: Gesture | null = null
    const swallow = (e: Event) => { e.stopImmediatePropagation() }

    const onDown = (e: PointerEvent) => {
      if (!e.isTrusted) return
      models.at = null
      // A model is clicked straight in 3D: it selects its card or tile
      // (Shift adds to the selection).
      if (e.button === 0 && !e.altKey && hostOf(e.target as Element) === host && !(e.target as Element).closest('[data-tilt-hud]')) {
        const key = models.pick?.(e.clientX, e.clientY)
        if (key?.startsWith('person|')) {
          // Size the person: drag up to grow them, down to shrink. How big
          // they are against the model IS the model's real-world scale, so
          // it is kept for that model file (and its wall's height follows).
          e.preventDefault(); swallow(e)
          const info = models.info?.(key.slice('person|'.length))
          if (info) g = { kind: 'person', url: info.url, unit0: info.unit, y0: e.clientY }
          return
        }
        if (key) {
          // A click selects; a drag up or down sizes the model on its card,
          // the same way the person is sized.
          e.preventDefault(); swallow(e)
          selectModel(key, e.shiftKey)
          g = { kind: 'model', key, k0: useModelScaleStore.getState().sizeOf[key] ?? 1, y0: e.clientY, moved: false }
          return
        }
      }
      if (!onPlane(e.target)) return
      // Alt+left / Alt+right belong to the orbit and dolly gestures.
      if (e.altKey && e.button !== 1) return
      // Bare ground: left-drag draws a selection box, a plain click clears
      // the selection — as flat. Panning is the camera's job (middle drag,
      // or Alt+middle).
      if (e.button === 0 && isBareGround(e.target)) {
        e.preventDefault(); swallow(e)
        g = { kind: 'marquee', x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY }
        return
      }
      if (e.button === 1) {
        e.preventDefault(); swallow(e)
        g = { kind: 'pan', last: { x: e.clientX, y: e.clientY } }
        return
      }
      if (e.button !== 0) return
      // preventDefault also stops the browser's own mousedown/move/up for
      // this press — they are re-sent below at the flat point instead.
      e.preventDefault(); swallow(e)
      const target = e.target as Element
      const height = liftOf(target)
      g = { kind: 'remap', target, pointerId: e.pointerId, height }
      resend(e, 'pointerdown', target, height)
      resend(e, 'mousedown', target, height)
    }
    const onMove = (e: PointerEvent) => {
      if (!e.isTrusted) return
      // A press whose release never reached us (let go outside the window,
      // or swallowed on the way) is over once no button is down: left
      // standing, it kept every later move to itself, and models stopped
      // lighting up under the cursor or taking clicks until a reload.
      if (g && e.buttons === 0) {
        if (g.kind === 'remap') { resend(e, 'pointerup', g.target, g.height); resend(e, 'mouseup', g.target, g.height) }
        if (g.kind === 'marquee') setBand(null)
        g = null
      }
      if (!g) {
        // Asked again every frame (TiltModels), not only as the mouse
        // moves: a model that was hidden for a frame (its card re-rendering)
        // as the cursor came to rest would otherwise stay unlit under it.
        models.at = e.buttons === 0 && !e.altKey && hostOf(e.target as Element) === host ? { x: e.clientX, y: e.clientY } : null
        models.hovered = models.at && (models.pick?.(models.at.x, models.at.y) ?? null)
        return
      }
      swallow(e)
      if (g.kind === 'person') {
        // Units per metre grows as the person does (a bigger person, in
        // the model's units, means a smaller model in metres).
        const u = g.unit0 * Math.exp(-(e.clientY - g.y0) / 160)
        useModelScaleStore.getState().setUnitsPerMetre(g.url, u)
        return
      }
      if (g.kind === 'model') {
        const dy = e.clientY - g.y0
        if (!g.moved && Math.abs(dy) < 4) return
        g.moved = true
        const k = Math.min(8, Math.max(0.1, g.k0 * Math.exp(-dy / 160)))
        useModelScaleStore.getState().setSize(g.key, k)
        return
      }
      if (g.kind === 'marquee') {
        g.x1 = e.clientX; g.y1 = e.clientY
        const r = host.getBoundingClientRect()
        setBand({ x: Math.min(g.x0, g.x1) - r.left, y: Math.min(g.y0, g.y1) - r.top, w: Math.abs(g.x1 - g.x0), h: Math.abs(g.y1 - g.y0) })
        return
      }
      if (g.kind === 'pan') {
        // Maya's pan: the camera slides in its own view plane, so the whole
        // view follows the mouse evenly, near and far alike.
        const ts = useTiltStore.getState()
        ts.setShift(ts.shiftX + e.clientX - g.last.x, ts.shiftY + e.clientY - g.last.y)
        g.last = { x: e.clientX, y: e.clientY }
        return
      }
      // A card that captured the pointer gets it, as it would flat.
      const real = e.target as Element
      const to = real.hasPointerCapture?.(g.pointerId) ? real : g.target
      resend(e, 'pointermove', to, g.height)
      resend(e, 'mousemove', to, g.height)
    }
    const onUp = (e: PointerEvent) => {
      if (!e.isTrusted || !g) return
      swallow(e)
      if (g.kind === 'remap') {
        const real = e.target as Element
        const to = real.hasPointerCapture?.(g.pointerId) ? real : g.target
        // A cancelled press is not a release: re-sent as an up, it let go of
        // a dragged card mid-drag, and it merged into whatever was under it
        // (Brian 2026-10-30: a card "jumps into a deck before I let go").
        if (e.type === 'pointercancel') resend(e, 'pointercancel', to, g.height)
        else { resend(e, 'pointerup', to, g.height); resend(e, 'mouseup', to, g.height) }
      }
      if (g.kind === 'marquee') { marqueeSelect(g, e.shiftKey); setBand(null) }
      g = null
    }
    const onWheel = (e: WheelEvent) => {
      if (!onPlane(e.target)) return
      e.preventDefault(); swallow(e)
      const c = viewCentre(host)
      if (c) useCanvasStore.getState().zoomAtPoint(e.deltaY < 0 ? 1.12 : 1 / 1.12, c.x, c.y)
    }
    // The browser's own drag (of a picture under the cursor) cancels the
    // pointer mid-gesture; while a press is being re-sent there is none.
    const onDragStart = (e: DragEvent) => { if (g?.kind === 'remap') e.preventDefault() }
    window.addEventListener('dragstart', onDragStart, true)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      window.removeEventListener('dragstart', onDragStart, true)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      window.removeEventListener('wheel', onWheel, true)
      models.at = null; models.hovered = null
      document.elementFromPoint = fromPoint
      document.elementsFromPoint = fromPoints
    }
  }, [])

  const btn = (active: boolean): React.CSSProperties => ({
    background: active ? 'rgba(120,170,255,0.25)' : 'transparent',
    border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6,
    color: active ? '#dfe8ff' : 'rgba(255,255,255,0.6)',
    fontSize: 11, padding: '3px 8px', cursor: 'pointer',
  })
  const set = useTiltStore.getState()

  return (
    <div
      ref={rootRef}
      style={{ position: 'absolute', inset: 0, zIndex: 850, pointerEvents: 'none' }}
    >
      {band && (
        <div style={{
          position: 'absolute', left: band.x, top: band.y, width: band.w, height: band.h,
          border: '1.5px solid rgba(120,170,255,0.8)', background: 'rgba(100,150,255,0.08)',
          borderRadius: 3, pointerEvents: 'none',
        }} />
      )}
      {lightOpen && <LightPanel onClose={() => setLightOpen(false)} />}
      <div
        data-tilt-hud
        style={{
          position: 'absolute', left: '50%', bottom: 14, transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
          background: 'rgba(19,20,31,0.88)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10,
          color: 'rgba(255,255,255,0.5)', fontSize: 11, cursor: 'default', userSelect: 'none',
          whiteSpace: 'nowrap', pointerEvents: 'auto',
        }}
      >
        <span>Tilted {Math.round(tilt)}° · click to select · drag a box to select many · Alt+drag orbits · Alt+middle pans · F frames</span>
        <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }} />
        <button style={{ ...btn(texture), opacity: wire === 'only' ? 0.4 : 1 }} disabled={wire === 'only'} onClick={() => set.setTexture(!texture)} title="The model's own textures; off shows plain clay">Texture</button>
        <button style={{ ...btn(flat), opacity: wire === 'only' ? 0.4 : 1 }} disabled={wire === 'only'} onClick={() => set.setFlat(!flat)} title="Even, low-contrast light and smooth surfaces">Flat</button>
        <button
          style={btn(wire !== 'off')}
          onClick={() => set.setWire(wire === 'off' ? 'over' : wire === 'over' ? 'only' : 'off')}
          title="Click to go: off, over the model, wireframe only"
        >{wire === 'off' ? 'Wireframe' : wire === 'over' ? 'Wireframe: over' : 'Wireframe: only'}</button>
        <button style={btn(lightOpen)} onClick={() => setLightOpen(o => !o)} title="Move the light, brightness and reflections">Light</button>
        <button style={btn(turn)} onClick={() => set.setTurn(!turn)}>Turn</button>
        <button style={btn(walls)} onClick={() => set.setWalls(!walls)} title="File name and size on a wall behind each model">Labels</button>
        <button style={btn(figure)} onClick={() => set.setFigure(!figure)} title="A 1.75 m person beside each model. Drag them up or down to set how big the model really is.">Person</button>
        <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }} />
        <button style={btn(true)} onClick={() => set.flatten()}>Exit 3D (Esc)</button>
      </div>
    </div>
  )
}

/** The Light panel: drag the dot round the dial to move the key light (the
 *  angle is where it comes from round the card, the distance from the
 *  centre how low it is: centre = straight overhead, rim = level with the
 *  card), plus brightness, reflections, and whether it turns with the
 *  turntable. Changes show live on every model. */
function LightPanel({ onClose }: { onClose: () => void }) {
  const light = useTiltStore(s => s.light)
  const setLight = useTiltStore(s => s.setLight)
  const R = 54
  const az = light.azimuth * Math.PI / 180
  const r = R * (1 - Math.max(0, Math.min(90, light.elevation)) / 90)
  const dot = { x: R + Math.sin(az) * r, y: R + Math.cos(az) * r }
  const aim = (e: React.PointerEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect()
    const dx = e.clientX - b.left - R, dy = e.clientY - b.top - R
    const d = Math.min(R, Math.hypot(dx, dy))
    setLight({ azimuth: Math.atan2(dx, dy) * 180 / Math.PI, elevation: 90 * (1 - d / R) })
  }
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }
  return (
    <div
      data-tilt-hud
      style={{
        position: 'absolute', left: '50%', bottom: 60, transform: 'translateX(-50%)',
        display: 'flex', gap: 14, padding: '10px 12px', alignItems: 'center',
        background: 'rgba(19,20,31,0.94)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10,
        color: 'rgba(255,255,255,0.7)', userSelect: 'none', pointerEvents: 'auto',
      }}
    >
      <svg
        width={R * 2} height={R * 2} style={{ cursor: 'crosshair', touchAction: 'none', flexShrink: 0 }}
        onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); aim(e) }}
        onPointerMove={e => { if (e.buttons & 1) aim(e) }}
      >
        <circle cx={R} cy={R} r={R - 1} fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.18)" />
        <circle cx={R} cy={R} r={R / 2} fill="none" stroke="rgba(255,255,255,0.08)" />
        <rect x={R - 9} y={R - 6} width={18} height={12} rx={2} fill="rgba(255,255,255,0.12)" />
        <line x1={R} y1={R} x2={dot.x} y2={dot.y} stroke="rgba(255,220,140,0.35)" />
        <circle cx={dot.x} cy={dot.y} r={7} fill="#ffd98a" stroke="#fff" strokeWidth={1} />
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 170 }}>
        <div style={row}>
          <span style={{ width: 70 }}>Brightness</span>
          <input type="range" min={0} max={6} step={0.05} value={light.power}
            onChange={e => setLight({ power: +e.target.value })} style={{ flex: 1 }} />
        </div>
        <div style={row}>
          <span style={{ width: 70 }}>Reflections</span>
          <input type="range" min={0} max={2.5} step={0.05} value={light.env}
            onChange={e => setLight({ env: +e.target.value })} style={{ flex: 1 }} />
        </div>
        <div style={row}>
          <span style={{ width: 70 }}>Shadows</span>
          <input type="range" min={0} max={1} step={0.02} value={light.shadows ?? DEFAULT_LIGHT.shadows}
            onChange={e => setLight({ shadows: +e.target.value })} style={{ flex: 1 }} />
        </div>
        <div style={row}>
          <span style={{ width: 70 }}>Sheen</span>
          <input type="range" min={0} max={1} step={0.02} value={light.sheen ?? DEFAULT_LIGHT.sheen}
            onChange={e => setLight({ sheen: +e.target.value })} style={{ flex: 1 }} />
        </div>
        <label style={{ ...row, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!light.soft} onChange={e => setLight({ soft: e.target.checked })} />
          Soft shadow edges
        </label>
        <label style={{ ...row, cursor: 'pointer' }}>
          <input type="checkbox" checked={light.spin} onChange={e => setLight({ spin: e.target.checked })} />
          Light turns with the turntable
        </label>
        <div style={{ ...row, justifyContent: 'space-between' }}>
          <button onClick={() => setLight(DEFAULT_LIGHT)} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6, color: 'rgba(255,255,255,0.6)', fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}>Reset</button>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6, color: 'rgba(255,255,255,0.6)', fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}>Done</button>
        </div>
      </div>
    </div>
  )
}
