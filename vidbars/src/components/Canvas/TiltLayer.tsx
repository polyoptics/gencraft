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
  useTiltStore, useModelScaleStore, isTilted, unprojectTilt, TILT_SNAP, TILT_FAR, DEFAULT_LIGHT,
} from '../../store/tiltStore'
import { useCanvasStore, groupBounds, MIN_ZOOM, MAX_ZOOM } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useRailUiStore } from '../../store/railUiStore'
import { railViewerDocks, viewerRail } from '../../utils/railViewer'
import { RAIL_COLORS } from './rail/railStyle'
import { setGlHidden } from '../../three/viewportRenderer'
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
  /** Hit test at a client point: a model's key, `person|<key>`,
   *  `deco|<owner>` (console furniture), or null. */
  pick: ((clientX: number, clientY: number) => string | null) | null
  /** How high the last furniture pick hit it, px off the plane. */
  pickZ: (() => number) | null
  info: ((key: string) => { url: string; unit: number } | null) | null
  hovered: string | null
  /** Where the cursor rests over the plane with no button down, or null. */
  at: { x: number; y: number } | null
} = { pick: null, pickZ: null, info: null, hovered: null, at: null }
/** A pick that lights up under the cursor: a model or a person, not
 *  furniture. */
const modelKey = (k: string | null | undefined) => (k && !k.startsWith('deco|') ? k : null)

/** The camera angle the 3D look fades over: the sheen, raised parts and
 *  models come in over the first FADE_TILT degrees of tipping and go over
 *  the last ones of lying back flat, so they move with the camera rather
 *  than after it, the same both ways (Brian 2026-10-30). */
const FADE_TILT = 15
/** How far the 3D look is in at this angle, 0..1, eased at both ends. */
const fadeShown = () => {
  const x = Math.min(1, useTiltStore.getState().tilt / FADE_TILT)
  return x * x * (3 - 2 * x)
}
/** Whether anything 3D is on screen. */
const live3d = () => isTilted(useTiltStore.getState().tilt)

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
    slabs: live3d() ? collectSlabs(fadeShown()) : (dropLifts(), []),
    art: live3d() ? lastArt : [],
    fade: fadeShown(),
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
      if (!view || !W || !H || live3d()) return
      view.warm(W, H, collectTargets(W, H), frameState())
    }
    const warmSoon = () => {
      if (warmTimer) clearTimeout(warmTimer)
      warmTimer = setTimeout(warm, 500)
    }
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (!view || !canvas) return
      const live = live3d()
      if (live !== shown) {
        shown = live
        canvas.style.display = live ? 'block' : 'none'
        if (!live) dropLifts()
      }
      if (!live) return
      const W = root.clientWidth, H = root.clientHeight
      if (models.at) models.hovered = modelKey(models.pick?.(models.at.x, models.at.y))
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
      models.pickZ = v.pickZ
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
      models.pick = null; models.pickZ = null; models.info = null
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
function collectSlabs(K = 1): TiltSlab[] {
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
  const lean = consoleLean(host, zoom)
  const leaning: Leaning[] = []
  const screens: Screen[] = []
  /** Console: column heads whose card leans (they ride up with it). */
  const riders: { head: HTMLElement; world: HTMLElement }[] = []
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
      let hinge: Hinge | undefined
      const fs = useFreeNodeStore.getState()
      const sa = viewer ? lean.get(node.dataset.viewport3d!) : undefined
      if (sa) {
        // Console: the Viewer a strip shows on stands up off the plane on
        // its bottom edge, a screen on a strut (Brian 2026-10-30, the
        // mockup machine), its slab under it.
        slab.z = slab.t
        lifting.set(node, slab.t)
        hinge = { v: slab.v + slab.h / 2, z: slab.z, a: sa }
        slab.hinge = hinge
        stand(node, hinge, zoom)
        screens.push({ id: node.dataset.viewport3d!, slab, hinge })
      } else if (node.hasAttribute('data-rail')) {
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
            if (head.dataset.railCardId && lean.has(head.dataset.railCardId)) riders.push({ head, world })
          }
          // Console: Run stands up off the arrow as a pill, the machine's
          // button. Not while running: its progress and stop show as flat.
          const sr = railStand.get(node.dataset.id!) ?? 0
          const run = sr > 0 ? el.querySelector<HTMLElement>('[data-rail-arrow] button[data-rail-run="idle"]') : null
          const ra = run && offsetIn(run, world)
          if (run && ra && run.offsetWidth) {
            const P = TRAY.rimH * u * zoom * k * sr
            const rh = run.offsetHeight * zoom
            const ps = add(pan.x + ra.x * zoom, pan.y + ra.y * zoom, run.offsetWidth * zoom, rh, P, RUN_RGB, rh / 2)
            if (ps) ps.z = H + P
            lifting.set(run, P)
            chain(run, world)
            fill(run, { rgb: RUN_RGB_A, round: true })
          }
        }
      } else if (fs.nodes[node.dataset.id!]?.type === 'cabinet') {
        // A project cabinet: the flat face is its front lying down, and it
        // stands up on its bottom edge as the canvas tips. An open drawer's
        // tray stays on the canvas, on the same patch as in the flat view.
        const x = Math.max(0, Math.min(1, (useTiltStore.getState().tilt - CONSOLE.from) / (FADE_TILT - CONSOLE.from)))
        const a = CABINET.stand * x * x * (3 - 2 * x) * detail(w) * Math.PI / 180
        if (a > 0) {
          hinge = { v: slab.v + slab.h / 2, z: 0, a }
          slab.t = w * CABINET.depth
          slab.hinge = hinge
          stand(node, hinge, zoom)
          const tray = node.querySelector<HTMLElement>('[data-cabinet-tray]')
          if (tray) {
            chain(tray, world)
            stand(tray, { v: hinge.v, z: 0, a: -a }, zoom, '50% 0%')
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
          // Console: an effect card leans back on its bottom edge, a plate
          // a card thick (Brian 2026-10-30).
          const a = lean.get(node.dataset.id!)
          if (a) {
            hinge = { v: slab.v + slab.h / 2, z: slab.z, a }
            slab.t = Math.min(slab.z, m * THICK.tile)
            slab.hinge = hinge
            stand(node, hinge, zoom)
            leaning.push({ id: n!.id, rail: n!.railDock!.railId, slab, hinge })
          }
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
        if (p) { p.z = z; p.pop = true; if (hinge) p.hinge = hinge }
        return p
      })
    }
  }
  // Console: a leaning card's tab (its column head, the strip's header band
  // above it) rides up with it, the card's own header above its top edge,
  // where it can still be seen and grabbed. It leaves the band as the card
  // turns and is level with the card's face once up.
  for (const { head, world } of riders) {
    const l = leaning.find(c => c.id === head.dataset.railCardId)
    const tile = l && world.querySelector<HTMLElement>(`[data-freenode][data-id="${l.id}"]`)
    const at = l && offsetIn(head, world), ta = tile && offsetIn(tile, world)
    if (!l || !tile || !at || !ta) continue
    const band = lifting.get(head) ?? 0
    const up = l.hinge.a / (CONSOLE.slot * Math.PI / 180)
    const hinge = { v: l.hinge.v, z: band + (l.hinge.z - band) * up, a: l.hinge.a }
    lifting.set(head, hinge.z)
    stand(head, hinge, zoom, `50% ${ta.y + tile.offsetHeight - at.y}px`)
    // Its own plate, or the band's sides would show through it.
    const s = add(pan.x + at.x * zoom, pan.y + at.y * zoom, head.offsetWidth * zoom, head.offsetHeight * zoom,
      Math.max(1, l.slab.t), SIDE.tray, radiusOf(head) * zoom)
    if (!s) continue
    s.z = hinge.z
    s.hinge = hinge
    const face = fill(head)
    s.color = (face[0] << 16) | (face[1] << 8) | face[2]
    l.top = Math.min(l.top ?? Infinity, s.v - s.h / 2)
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
        const f = Math.max(k, lift === undefined ? 0 : 1)
        const per = m * THICK.card * f
        const thick = Math.min(m * THICK.deckMax, per * n)
        const base = lift ?? 0
        const reserve = n > 1 ? Math.min(10, w * 0.05) : 0
        // Each card under the top one reaches a step further right than the
        // one above, so the deck's right side is an angled run of page edges
        // you can see (and click to fan) without the pile leaning: past the
        // flat deck's edge strip, grown in with the 3D look (Brian 2026-10-30).
        const L = Math.min(n - 1, DECK_SLICES)
        const spread = reserve + Math.max(0, Math.min(w * 0.08, L * Math.min(6, Math.max(2, w * 0.012))) - reserve) * f * K
        card = add(at.x, at.y, w - reserve, h, lift === undefined ? per : thick, SIDE.card, r)
        if (card) {
          card.z = base + thick
          lifting.set(el, card.z)
          chain(el, stage)
          riseZones(zones, at, w, h, card.z, lifting, stage)
          const below = thick - per
          // Its cards show once they stand clear of each other: any thinner,
          // in the first degrees of tilt, their tops flicker through the
          // face, so the flat deck's edge lines stay till then.
          const slices = n > 1 && per * K >= 1 && below * K >= L * 0.75
          if (slices) hideEdges(el, spread - reserve)
          for (let j = 1; slices && j <= L; j++) {
            const s = add(at.x, at.y, w - reserve + spread * j / L, h, below / L, j % 2 ? SIDE.edge : SIDE.card, r)
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
  // Fading in or out, everything raised stands that share of its height.
  if (K < 1) {
    for (const [el, z] of lifting) lifting.set(el, z * K)
    const hinges = new Set<Hinge>()
    for (const s of out) {
      s.t *= K
      if (s.z !== undefined) s.z *= K
      if (s.rim) s.rim = { ...s.rim, h: s.rim.h * K }
      if (s.hinge) hinges.add(s.hinge)
    }
    for (const h of hinges) h.z *= K
  }
  consoleFurniture(leaning, screens, out, zoom)
  setLifts(lifting)
  standScreens(screens.map(s => s.id))
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
  // A tile's header, and a Viewer's (as an fx card's).
  const head = root.querySelector<HTMLElement>(':scope > [data-freenode-header], :scope > [data-viewer-chrome]')
  if (head) parts.add(head)
  for (const b of root.querySelectorAll<HTMLElement>('[data-fx-onoff], [data-fx-solo], [data-fx-drag-out], [data-card-face-arrow]')) parts.add(b)
  // A Viewer's buttons, its picture tools (outline, crop and the rest) among
  // them, stand up as pucks.
  if (root.hasAttribute('data-viewport3d')) for (const b of root.querySelectorAll<HTMLElement>('button')) parts.add(b)
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
    level(el, root, lifting)
    // One piece: the part's sides are the colour of its face, and a button's
    // ring goes the same colour, so no rim reads as a second disc on top.
    const face = fill(el)
    if (p && face) p.color = (face[0] << 16) | (face[1] << 8) | face[2]
  }
}

/** Chromium hit-tests a transformed box (a card's scaled text layer,
 *  data-card-text) inside a flat, untransformed one (the face's content
 *  area) at the wrong depth once its ancestors keep 3D: in the far half of
 *  the tilted view it outranks parts raised well above it, so a face arrow
 *  showed but never took the cursor or the press, and the press grabbed
 *  the card instead (Brian 2026-10-30). A zero lift on each box beside the
 *  raised part's path up to its card makes that box a plane of its own,
 *  hit where it really is. Cleared with the other lifts when flat. */
function level(part: HTMLElement, root: HTMLElement, lifting: Map<HTMLElement, number>) {
  for (let e = part.parentElement; e && e !== root.parentElement; e = e.parentElement) {
    for (const c of e.children) {
      const h = c as HTMLElement
      if (h === part || h.contains(part) || lifting.has(h)) continue
      lifting.set(h, 0)
    }
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
type Filled = { bs: string; bc: string; rgb: number[]; br?: string }
let filled = new Map<HTMLElement, Filled>()
let filling = new Map<HTMLElement, Filled>()
/** `as`: filled with this colour instead, and with `round`, made a pill
 *  (console mode's Run button). */
function fill(el: HTMLElement, as?: { rgb: number[]; round?: boolean }): number[] {
  // Read again each frame: a toggle's colour changes as it is pressed.
  const was = filled.get(el) ?? { bs: el.style.boxShadow, bc: el.style.borderColor, rgb: [0, 0, 0] }
  filling.set(el, was)
  if (as) {
    was.rgb = as.rgb
    const bs = `inset 0 0 0 9999px rgb(${as.rgb.join(',')})${was.bs ? ', ' + was.bs : ''}`
    if (el.style.boxShadow !== bs) el.style.boxShadow = bs
    if (as.round) {
      if (was.br === undefined) was.br = el.style.borderRadius
      el.style.borderRadius = `${el.offsetHeight / 2}px`
    }
    return was.rgb
  }
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
let widened = new Map<HTMLElement, string>()
let widening = new Map<HTMLElement, string>()
/** Hide a stacked deck's flat edge lines (its slices draw them in 3D) and
 *  stretch its click-to-fan strip `reach` px further right, over the pages
 *  that step out past it. */
function hideEdges(deck: HTMLElement, reach = 0) {
  for (const c of deck.children) {
    const e = c as HTMLElement
    if (e.style.cursor === 'pointer' && e.style.pointerEvents === 'all' && e.offsetLeft > deck.offsetWidth / 2) {
      const was = widened.get(e) ?? e.style.width
      widening.set(e, was)
      e.style.width = `${(parseFloat(was) || 0) + reach}px`
      continue
    }
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
  for (const [e, was] of filled) {
    if (filling.has(e)) continue
    e.style.boxShadow = was.bs; e.style.borderColor = was.bc
    if (was.br !== undefined) e.style.borderRadius = was.br
  }
  for (const e of hidden) if (!hiding.has(e)) e.style.visibility = ''
  hidden = hiding
  hiding = new Set()
  for (const [e, was] of widened) if (!widening.has(e)) e.style.width = was
  widened = widening
  widening = new Map()
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

/** Console mode: which docked effect tiles lean back, and by how much
 *  (radians), by tile id. Each strip eases between standing and flat:
 *  flat while something is dragged off it or onto it (Brian's rule: 3D
 *  works exactly as 2D, so a drop is judged on the flat strip). */
const consoleEase = new Map<string, number>()
let consoleAt = 0
function consoleLean(host: HTMLElement, zoom: number): Map<string, number> {
  const out = new Map<string, number>()
  const { console: on, tilt } = useTiltStore.getState()
  const now = performance.now()
  const dt = Math.min(100, Math.max(0, now - consoleAt))
  consoleAt = now
  const x = Math.max(0, Math.min(1, (tilt - CONSOLE.from) / (FADE_TILT - CONSOLE.from)))
  const grown = x * x * (3 - 2 * x)
  const nodes = useFreeNodeStore.getState().nodes
  const drop = useRailUiStore.getState().drop
  const seen = new Set<string>()
  /** How far up each strip stands, 0..1. */
  const standing = new Map<string, number>()
  railStand.clear()
  for (const n of Object.values(nodes)) {
    const r = n.rail
    if (!r || n.pin) continue
    seen.add(n.id)
    // Not for one of its own columns moved along it by its tab: that tab
    // rides its card, in line with the others, so the drag reads along
    // the standing row (folding, the row fell away from the cursor).
    const own = drop && [...r.slots, ...(r.rows ?? []).flat()].some(sl => sl.id === drop.draggedId)
    const held = (drop?.target.railId === n.id && !own) ||
      Object.values(nodes).some(o => o.railDock?.railId === n.id && o.railDock.lifted)
    const goal = on && !held ? 1 : 0
    const was = consoleEase.get(n.id) ?? goal
    const e = goal > was ? Math.min(goal, was + dt / CONSOLE.easeMs) : Math.max(goal, was - dt / CONSOLE.easeMs)
    consoleEase.set(n.id, e)
    if (e <= 0 || grown <= 0) continue
    const body = host.querySelector<HTMLElement>(`[data-freenode][data-id="${n.id}"] [data-rail-body]`)
    const k = body ? detail(body.offsetWidth * zoom) : 0
    const s = grown * k * e * e * (3 - 2 * e)
    standing.set(n.id, s)
    railStand.set(n.id, s)
    if (s <= 0) continue
    const cards = new Set([...r.slots, ...(r.rows ?? []).flat()].filter(sl => sl.kind === 'card').map(sl => sl.id))
    for (const t of Object.values(nodes)) {
      const d = t.railDock
      if (t.type !== 'effect' || !d || d.railId !== n.id || d.lifted || (d.order ?? 0) !== 0 || !cards.has(d.slotId)) continue
      out.set(t.id, CONSOLE.slot * s * Math.PI / 180)
    }
  }
  for (const id of consoleEase.keys()) if (!seen.has(id)) consoleEase.delete(id)
  // A Viewer stands while the strip it shows does, easing on its own (it
  // can be pulled off its strip).
  const shown = new Map<string, number>()
  const windows = useViewport3DStore.getState().windows
  for (const [wid, docked] of railViewerDocks(nodes, windows, zoom)) {
    const rid = viewerRail(docked, useRailUiStore.getState().active)
    if (rid) shown.set(wid, standing.get(rid) ?? 0)
  }
  for (const wid of new Set([...shown.keys(), ...screenEase.keys()])) {
    // Carried by its header, it stays as it is till let go (taken off its
    // strip, it lies down then).
    const was = screenEase.get(wid) ?? shown.get(wid) ?? 0
    const goal = carried === wid ? was : shown.get(wid) ?? 0
    const e = goal > was ? Math.min(goal, was + dt / CONSOLE.easeMs) : Math.max(goal, was - dt / CONSOLE.easeMs)
    if (e <= 0 && goal <= 0) screenEase.delete(wid); else screenEase.set(wid, e)
    if (e > 0 && windows[wid] && !windows[wid].pin) out.set(wid, CONSOLE.viewer * e * Math.PI / 180)
  }
  return out
}
const screenEase = new Map<string, number>()
/** How far up each console strip stands this frame, 0..1, by id. */
const railStand = new Map<string, number>()
/** The standing Viewer being dragged by its header, if one is. */
let carried: string | null = null
/** The Viewers standing this frame: their GL bodies are not drawn (they
 *  would stay on the floor where the Viewer lay). */
let stoodScreens: string[] = []
function standScreens(ids: string[]) {
  if (ids.join() === stoodScreens.join()) return
  stoodScreens = ids
  setGlHidden(ids)
}

/** Console mode (Brian 2026-10-30: the strip as the mockup's machine): the
 *  strip's effect cards lean back off its floor on their bottom edges, as
 *  on a sloped panel; its cast and results stay down in their columns.
 *  Degrees up from the floor. They rise from `from` degrees of tilt, full
 *  by FADE_TILT, and a strip eases down flat over `easeMs` while something
 *  is dragged onto it, so every drop lands by the flat view's rules. */
const CONSOLE = { slot: 45, viewer: 68, strutAt: 0.62, from: 4, easeMs: 220 }
/** Console's Run pill: the strip's own Run orange. */
const RUN_RGB = parseInt(RAIL_COLORS.orange.slice(1), 16)
const RUN_RGB_A = [RUN_RGB >> 16, (RUN_RGB >> 8) & 255, RUN_RGB & 255]
/** A project cabinet standing: degrees up from the canvas, its depth × width. */
const CABINET = { stand: 85, depth: 0.45 }
/** A leaning card, and the flat top of its tab riding with it, if any. */
type Leaning = { id: string; rail: string; slab: TiltSlab; hinge: Hinge; top?: number }
type Screen = { id: string; slab: TiltSlab; hinge: Hinge }
/** Console furniture, as on the mockup's machine. Behind each run of
 *  leaning cards, a sloped back just behind their backs, so nothing shows
 *  through between or above them; in front, along their bottom edges, a
 *  dark lip they stand in. Built from the cards' final heights (after the
 *  fade). Three.js alone draws them ('deco'): a press on one is a press on
 *  its strip's band. */
function consoleFurniture(leaning: Leaning[], screens: Screen[], out: TiltSlab[], zoom: number) {
  // A standing Viewer's strut: a bar from the floor behind it up to its
  // back, a little over halfway up.
  for (const sc of screens) {
    const { v, a } = sc.hinge
    if (a < 20 * Math.PI / 180 || a >= 87 * Math.PI / 180) continue
    const d = CONSOLE.strutAt * sc.slab.h
    const rise = d * Math.sin(a), run = 0.416 * rise
    const foot = v - d * Math.cos(a) - run
    const L = Math.hypot(rise, run)
    const w = Math.max(3, 0.03 * sc.slab.w), t = 0.6 * w
    out.push({ u: sc.slab.u, v: foot - L / 2, w, h: L, r: w / 3, t, z: t, color: 0x3a4053, cap: true,
      deco: `viewer:${sc.id}`, hinge: { v: foot, z: t, a: Math.PI - Math.atan2(rise, run) } })
  }
  if (!leaning.length) return
  const nodes = useFreeNodeStore.getState().nodes
  const byRail = new Map<string, Leaning[]>()
  for (const l of leaning) byRail.set(l.rail, [...(byRail.get(l.rail) ?? []), l])
  for (const [rail, cards] of byRail) {
    const u = (nodes[rail]?.rail?.unit || 1) * zoom
    const owner = `rail:${rail}`
    const build = (run: Leaning[]) => {
      const x0 = Math.min(...run.map(c => c.slab.u - c.slab.w / 2)) - 4 * u
      const x1 = Math.max(...run.map(c => c.slab.u + c.slab.w / 2)) + 4 * u
      // One strip, one angle; one row, one hinge line.
      const { v, z, a } = run[0].hinge
      const t = Math.max(...run.map(c => c.slab.t))
      // As far up as the cards, or their tabs riding on them.
      const h = Math.max(...run.map(c => v - Math.min(c.slab.v - c.slab.h / 2, c.top ?? Infinity)))
      const back = t + 0.5
      const vB = v - back * Math.sin(a), zB = Math.max(0.25, z - back * Math.cos(a))
      const L = h + 2 * u
      out.push({ u: (x0 + x1) / 2, v: vB - L / 2, w: x1 - x0, h: L, r: 4 * u, t: zB, z: zB,
        color: 0x59607a, cap: true, loft: true, deco: owner, hinge: { v: vB, z: zB, a } })
      out.push({ u: (x0 + x1) / 2, v: v + 3 * u, w: x1 - x0, h: 6 * u, r: 2 * u, t: z + t, z: z + t,
        color: 0x1e2230, cap: true, deco: owner })
    }
    // A run: neighbours in one row with no other column between them.
    cards.sort((a, b) => a.hinge.v - b.hinge.v || a.slab.u - b.slab.u)
    let run: Leaning[] = []
    for (const c of cards) {
      const last = run[run.length - 1]
      if (last && (Math.abs(last.hinge.v - c.hinge.v) > 1 || c.slab.u - c.slab.w / 2 - (last.slab.u + last.slab.w / 2) > 0.3 * c.slab.w)) {
        build(run); run = []
      }
      run.push(c)
    }
    if (run.length) build(run)
  }
}
/** A card stood up on its bottom edge: the edge at flat `v` (px from the
 *  centre, y down) and height `z`, turned up by `a` radians. */
type Hinge = { v: number; z: number; a: number }
type Stood = { hinge: Hinge; rotate: string; origin: string; transform: string; wrote: string }
let stood = new Map<HTMLElement, Stood>()
let standing = new Map<HTMLElement, Stood>()
/** Stand `el` up on `hinge`. A world element sits under the world's
 *  scale(zoom), which scales across but not up: turned there plainly it
 *  would stretch, so it is scaled to screen size, turned, and scaled back
 *  (rigid on screen). */
function stand(el: HTMLElement, hinge: Hinge, zoom = 1, origin = '50% 100%') {
  const was = stood.get(el) ?? { hinge, rotate: el.style.rotate, origin: el.style.transformOrigin, transform: el.style.transform, wrote: '' }
  const deg = (-hinge.a * 180 / Math.PI).toFixed(2)
  if (zoom === 1) {
    el.style.rotate = `x ${deg}deg`
  } else {
    const t = `scale3d(${1 / zoom}, ${1 / zoom}, 1) rotateX(${deg}deg) scale3d(${zoom}, ${zoom}, 1)`
    if (el.style.transform !== t) el.style.transform = t
    was.wrote = el.style.transform
  }
  el.style.transformOrigin = origin
  standing.set(el, { ...was, hinge })
}
function settleStands() {
  for (const [el, was] of stood) {
    if (standing.has(el)) continue
    el.style.rotate = was.rotate
    el.style.transformOrigin = was.origin
    // Only what was written here goes back: React may have set it since.
    if (was.wrote && el.style.transform === was.wrote) el.style.transform = was.transform
  }
  stood = standing
  standing = new Map()
}
/** The hinge `el` stands on, if it is (or is on) a standing card. */
function hingeOf(el: Element | null): Hinge | undefined {
  for (let e = el; e; e = e.parentElement) {
    const h = stood.get(e as HTMLElement)
    // A negative turn lays a tray back down on the canvas: no hinge to it.
    if (h) return h.hinge.a > 0 ? h.hinge : undefined
  }
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
  settleStands()
}
/** How high `el` stands: the lifts of everything raised that holds it
 *  (a button on a docked card stands on the card's lift), or 0. */
function liftOf(el: Element | null): number {
  let z = 0
  for (let e = el; e; e = e.parentElement) z += lifted.get(e as HTMLElement) ?? 0
  return z
}
function dropLifts() { if (lifted.size) setLifts(new Map()); standScreens([]) }
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
  // A Viewer showing a model: the model stands up on the Viewer, popping
  // in, and leaves the card it came from (Brian 2026-10-30). Once the
  // Viewer shows something else (a picture from another card docked to
  // it), the model hops back onto its card (Brian 2026-10-30).
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
  // Not on a Viewer standing as console mode's screen: its body there is
  // the strip's result.
  for (const v of viewers) if (v.url && !stoodScreens.includes(v.id)) onViewer(v, v.url, v.name)
  const GAP = 14
  const stage = document.querySelector<HTMLElement>('[data-tilt-stage="overlay"]')
  if (stage) {
    for (const el of stage.querySelectorAll<HTMLElement>('[data-group-card][data-id]')) {
      const model = cardModel(el.dataset.id!)
      const at = model && offsetIn(el, stage)
      if (!model || !at) continue
      const x = at.x, y = at.y, w = el.offsetWidth, h = el.offsetHeight
      const v = viewers.find(r => x <= r.x1 + GAP && x + w >= r.x0 - GAP && y <= r.y1 + GAP && y + h >= r.y0 - GAP)
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
    const flatClient = (cx: number, cy: number, height = 0, hinge?: Hinge) => {
      const r = host.getBoundingClientRect()
      const { tilt: t, spin: s, shiftX, shiftY } = useTiltStore.getState()
      const sx = cx - r.left - r.width / 2, sy = cy - r.top - r.height / 2
      let p = unprojectTilt(sx, sy, t, s, shiftX, shiftY, height, TILT_FAR)
      if (hinge) {
        // A standing card: find the height at which the ray meets its face
        // (a point d behind the hinge line on the plane stands d·tan a up),
        // then lay that point back down flat on the card.
        const tan = Math.tan(hinge.a)
        const off = (h: number) => {
          const q = unprojectTilt(sx, sy, t, s, shiftX, shiftY, h)
          return q ? h - hinge.z - Math.max(0, hinge.v - q.y) * tan : 1
        }
        let lo = hinge.z, hi = hinge.z + Math.max(r.width, r.height) * 2
        for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; if (off(mid) > 0) hi = mid; else lo = mid }
        const q = unprojectTilt(sx, sy, t, s, shiftX, shiftY, lo, TILT_FAR)
        p = q && { x: q.x, y: hinge.v - Math.max(0, hinge.v - q.y) / Math.cos(hinge.a) }
      }
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

    // The last flat point a re-sent event went to. Where the cursor shows no
    // plane under it (past the horizon, or so near it the point is lost),
    // a release still has to arrive, or the drag it ends never ends and the
    // card sticks to the cursor (Brian 2026-10-30): it goes here.
    let lastFlat: { x: number; y: number } | null = null
    /** A press that drags something standing (a console Viewer by its
     *  header) or furniture (a strip by its sloped back): its moves are
     *  read on the level plane through the point grabbed, `h` px up, and
     *  sent relative to the press (`p0`, sent; `q0`, that plane's point
     *  then). Read on the standing face itself, the face moving with the
     *  drag moved the point read, and the Viewer ran off. */
    let rel: { h: number; q0: { x: number; y: number }; p0: { x: number; y: number } } | null = null
    /** A press on furniture: its native click (and double-click) would go to
     *  whatever is hidden behind it (a strip's header): kept from it. */
    let eatClick = false
    const resend = (e: MouseEvent, type: string, to: EventTarget, height = 0, at?: { x: number; y: number }) => {
      // A lifted tile is pressed at its own height, not the floor's.
      let p = at ?? null
      if (!p && rel) {
        const q = flatClient(e.clientX, e.clientY, rel.h)
        p = q && { x: rel.p0.x + q.x - rel.q0.x, y: rel.p0.y + q.y - rel.q0.y }
      } else if (!p) p = flatClient(e.clientX, e.clientY, height, hingeOf(to as Element))
      if (p) lastFlat = p
      else if (lastFlat && /up$|cancel$/.test(type)) p = lastFlat
      if (!p) return
      // While the re-sent event runs, a handler asking what is under a point
      // (a card let go: what it drops into) gets the flat view's answer: see
      // flatHit.
      hitAt = true
      try { send(e, type, to, p) } finally { hitAt = false; standBack() }
    }
    /** What a press hits, as the flat view has it. The browser's own hit
     *  test on a tilted or leaning card can pick a layer under the one in
     *  front at steep angles (the card's face under a slider row: the
     *  slider never saw the press). The flat view at the same point, kept
     *  to the tile, card or Viewer pressed, is what 2D would hit. */
    const flatTarget = (e: MouseEvent, target: Element, height: number): Element => {
      const unit = target.closest('[data-freenode][data-id], [data-group-card], [data-viewport3d]')
      if (!unit) return target
      const p = flatClient(e.clientX, e.clientY, height, hingeOf(target))
      if (!p) return target
      hitAt = true
      try {
        for (const el of document.elementsFromPoint(p.x, p.y)) if (unit.contains(el)) return el
      } finally { hitAt = false; standBack() }
      return target
    }
    /** Let go of a re-sent press whose own release never came: as a
     *  release, left button, so every drag handler takes it as one. At the
     *  flat point given, else where its last event went. */
    const release = (e: MouseEvent, r: { target: Element; height: number }, at?: { x: number; y: number } | null) => {
      const up = { button: 0, buttons: 0, detail: e.detail, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
        altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey,
        pointerId: (e as PointerEvent).pointerId ?? 1, pointerType: (e as PointerEvent).pointerType ?? 'mouse', isPrimary: true,
        pressure: 0, width: 1, height: 1 } as unknown as PointerEvent
      const p = at ?? lastFlat ?? undefined
      resend(up, 'pointerup', r.target, r.height, p)
      resend(up, 'mouseup', r.target, r.height, p)
    }
    // The card pressed can be re-rendered away mid-drag (a deck leaving a
    // Viewer's side swaps how it is drawn). Events sent to the old,
    // detached element reach nobody, not even the window listeners that
    // run the drag: the card stopped following, the release never ended
    // the drag, and it then stuck to the cursor (Brian 2026-10-30). Sent to
    // the page instead, they still reach those listeners.
    const reachable = (to: EventTarget) => (to instanceof Node && !to.isConnected ? document.body : to)
    const send = (e: MouseEvent, type: string, to: EventTarget, p: { x: number; y: number }) => {
      to = reachable(to)
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

    // Hit tests during a re-sent event. Its handlers work in flat points, so
    // they are answered from the flat view: the stages are laid flat (and
    // anything stood up or unclipped for 3D put back) for the moment of the
    // ask; no frame is drawn in between. Answered from the tilted view, the
    // cursor's ray reached on past the card in hand into whatever stands up
    // in front of it (a deck's tall stack, a card on a Viewer), and a card
    // let go there was merged into that one: only ever in 3D (Brian
    // 2026-10-30, cards found "inside another random card").
    // Boxes measured then (a slider's track under a re-sent flat point, a
    // drop slot) are the flat view's too: measured tilted, a slider on a
    // tilted card jumped to the wrong value. Laid flat at the first ask and
    // stood back up once the event is done, so many asks cost one.
    let hitAt = false
    let flatUndo: (() => void)[] | null = null
    const layFlat = () => {
      if (flatUndo) return
      const undo: (() => void)[] = flatUndo = []
      const put = (el: HTMLElement, prop: 'transform' | 'rotate' | 'overflow', v: string) => {
        const was = el.style[prop]
        if (was === v) return
        el.style[prop] = v
        // Put back only if nothing has written it since (the camera moving
        // the stage within the event).
        undo.push(() => { if (el.style[prop] === v) el.style[prop] = was })
      }
      for (const st of document.querySelectorAll<HTMLElement>('[data-tilt-stage]')) put(st, 'transform', 'none')
      for (const [el, was] of stood) { put(el, 'rotate', was.rotate); if (was.wrote) put(el, 'transform', was.transform) }
      for (const [el, was] of chained) put(el, 'overflow', was.ov)
    }
    const standBack = () => {
      const undo = flatUndo
      flatUndo = null
      if (undo) for (let i = undo.length - 1; i >= 0; i--) undo[i]()
    }
    const flatHit = <T,>(ask: () => T): T => {
      if (hitAt) layFlat()
      return ask()
    }
    const fromPoint = document.elementFromPoint, fromPoints = document.elementsFromPoint
    const rectOf = Element.prototype.getBoundingClientRect, rectsOf = Element.prototype.getClientRects
    document.elementFromPoint = function (x: number, y: number) { return flatHit(() => fromPoint.call(this, x, y)) }
    document.elementsFromPoint = function (x: number, y: number) { return flatHit(() => fromPoints.call(this, x, y)) }
    Element.prototype.getBoundingClientRect = function () { return flatHit(() => rectOf.call(this)) }
    Element.prototype.getClientRects = function () { return flatHit(() => rectsOf.call(this)) }

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
      // A press still open from before (its release lost on the way) is let
      // go where it was, before this one starts: replaced unended, its card
      // kept following the bare mouse (Brian's deck stuck to the cursor).
      if (g?.kind === 'remap') release(e, g)
      g = null
      lastFlat = null
      rel = null
      eatClick = false
      carried = null
      models.at = null
      // A model is clicked straight in 3D: it selects its card or tile
      // (Shift adds to the selection).
      if (e.button === 0 && !e.altKey && hostOf(e.target as Element) === host && !(e.target as Element).closest('[data-tilt-hud]')) {
        const key = models.pick?.(e.clientX, e.clientY)
        if (key?.startsWith('deco|')) {
          // Console furniture. A strip's sloped back or lip is pressed as
          // its band (as in 2D: the strip moves, its Viewer with it); a
          // Viewer's strut as its header.
          const [kind, id] = key.slice('deco|'.length).split(':')
          const to = kind === 'rail'
            ? document.querySelector<HTMLElement>(`[data-freenode][data-id="${id}"] [data-rail-band]`)
            : document.querySelector<HTMLElement>(`[data-viewport3d="${id}"] [data-viewer-chrome]`)
          const h = models.pickZ?.() ?? 0
          const q0 = to && flatClient(e.clientX, e.clientY, h)
          if (to && q0) {
            e.preventDefault(); swallow(e)
            hitAt = true
            let r: DOMRect
            try { r = to.getBoundingClientRect() } finally { hitAt = false; standBack() }
            // On the band under the cursor; on the header at its middle.
            const p0 = { x: kind === 'rail' ? q0.x : r.left + r.width / 2, y: r.top + r.height / 2 }
            rel = { h, q0, p0 }
            eatClick = true
            g = { kind: 'remap', target: to, pointerId: e.pointerId, height: 0 }
            resend(e, 'pointerdown', to, 0, p0)
            resend(e, 'mousedown', to, 0, p0)
            return
          }
        }
        if (key?.startsWith('person|')) {
          // Size the person: drag up to grow them, down to shrink. How big
          // they are against the model IS the model's real-world scale, so
          // it is kept for that model file (and its wall's height follows).
          e.preventDefault(); swallow(e)
          const info = models.info?.(key.slice('person|'.length))
          if (info) g = { kind: 'person', url: info.url, unit0: info.unit, y0: e.clientY }
          return
        }
        if (key && !key.startsWith('deco|')) {
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
      const height = liftOf(e.target as Element)
      const target = flatTarget(e, e.target as Element, height)
      g = { kind: 'remap', target, pointerId: e.pointerId, height }
      // A standing Viewer dragged by its header slides on the level plane
      // through the point grabbed (see rel).
      const hinge = hingeOf(target)
      if (hinge && target.closest('[data-viewer-chrome]')) {
        const p0 = flatClient(e.clientX, e.clientY, height, hinge)
        const r = host.getBoundingClientRect()
        const h = p0 && hinge.z + Math.max(0, hinge.v - (p0.y - r.top - r.height / 2)) * Math.sin(hinge.a)
        const q0 = p0 && flatClient(e.clientX, e.clientY, h!)
        if (p0 && q0) rel = { h: h!, q0, p0 }
        carried = target.closest<HTMLElement>('[data-viewport3d]')?.dataset.viewport3d ?? null
      }
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
        if (g.kind === 'remap') {
          // Brought to here first (moves can have stopped coming, after a
          // cancel), then let go here.
          resend(e, 'pointermove', g.target, g.height)
          resend(e, 'mousemove', g.target, g.height)
          release(e, g)
        }
        if (g.kind === 'marquee') setBand(null)
        g = null
        carried = null
      }
      if (!g) {
        // Asked again every frame (TiltModels), not only as the mouse
        // moves: a model that was hidden for a frame (its card re-rendering)
        // as the cursor came to rest would otherwise stay unlit under it.
        models.at = e.buttons === 0 && !e.altKey && hostOf(e.target as Element) === host ? { x: e.clientX, y: e.clientY } : null
        models.hovered = models.at && modelKey(models.pick?.(models.at.x, models.at.y))
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
        // Nor is it the end of the drag: a card's drag ignores it and goes
        // on till the button comes up, as flat. So the press stays open, its
        // moves still re-sent at the flat point (dropped, they were sent
        // as they came, tilted, and the card drifted off the cursor), until
        // its release or the next move with no button down.
        if (e.type === 'pointercancel') { resend(e, 'pointercancel', to, g.height); return }
        resend(e, 'pointerup', to, g.height); resend(e, 'mouseup', to, g.height)
      }
      if (g.kind === 'marquee') { marqueeSelect(g, e.shiftKey); setBand(null) }
      g = null
      carried = null
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
    const onClick = (e: MouseEvent) => { if (e.isTrusted && eatClick) { e.preventDefault(); swallow(e) } }
    window.addEventListener('dragstart', onDragStart, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('dblclick', onClick, true)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      window.removeEventListener('dragstart', onDragStart, true)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('dblclick', onClick, true)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      window.removeEventListener('wheel', onWheel, true)
      models.at = null; models.hovered = null
      document.elementFromPoint = fromPoint
      document.elementsFromPoint = fromPoints
      Element.prototype.getBoundingClientRect = rectOf
      Element.prototype.getClientRects = rectsOf
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
