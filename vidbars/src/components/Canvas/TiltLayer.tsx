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
import {
  useTiltStore, useModelScaleStore, isTilted, unprojectTilt, TILT_SNAP,
} from '../../store/tiltStore'
import { useCanvasStore, groupBounds, MIN_ZOOM, MAX_ZOOM } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useBoardsStore } from '../../store/boardsStore'
import { getMediaItems } from '../../types/bar'
import { createTiltScene, type TiltTarget, type TiltFrameState } from '../../three/tiltScene'

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
 *  or a card, flat or already tilted. Free nodes and 3D viewer windows
 *  keep Alt for their own use (effect reset, image studio pan). */
function useAltTiltGesture() {
  useEffect(() => {
    let altUsed = false
    let swallowMenu = false
    const onDown = (e: PointerEvent) => {
      if ((e.button !== 0 && e.button !== 2) || !e.altKey) return
      const target = e.target as Element | null
      const host = hostOf(target)
      if (!host) return
      if (target?.closest('input,textarea,select,[contenteditable="true"],[data-viewport3d],[data-freenode],[data-tilt-hud]')) return
      e.preventDefault()
      e.stopPropagation()
      altUsed = true
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
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('contextmenu', onMenu, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('contextmenu', onMenu, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])
}

/** Alt+right-drag: zoom about the point pressed, flat or tilted (Maya's
 *  dolly) — right or up zooms in, left or down zooms out. */
function dolly(e: PointerEvent, host: HTMLElement) {
  const r = host.getBoundingClientRect()
  const { tilt, spin } = useTiltStore.getState()
  const sx = e.clientX - r.left, sy = e.clientY - r.top
  const flat = isTilted(tilt) ? unprojectTilt(sx - r.width / 2, sy - r.height / 2, tilt, spin) : { x: sx - r.width / 2, y: sy - r.height / 2 }
  if (!flat) return
  const px = flat.x + r.width / 2, py = flat.y + r.height / 2
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
      // Glide: the centre moves straight, the zoom evenly in notches.
      if (raf !== null) cancelAnimationFrame(raf)
      const start = performance.now()
      const tick = () => {
        const u = Math.min(1, (performance.now() - start) / GLIDE_MS)
        const k = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
        const z = Math.exp(Math.log(zFrom) + (Math.log(zTo) - Math.log(zFrom)) * k)
        const cx = cFrom.x + (cTo.x - cFrom.x) * k, cy = cFrom.y + (cTo.y - cFrom.y) * k
        useCanvasStore.setState({ zoom: z, pan: { x: W / 2 - cx * z, y: H / 2 - cy * z } })
        raf = u < 1 ? requestAnimationFrame(tick) : null
      }
      raf = requestAnimationFrame(tick)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown); if (raf !== null) cancelAnimationFrame(raf) }
  }, [])
}

export const TiltLayer: React.FC = () => {
  useAltTiltGesture()
  useFrameKey()
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
} = { pick: null, info: null, hovered: null }

const frameState = (): TiltFrameState => {
  const ts = useTiltStore.getState()
  const { unitsPerMetre: scales, sizeOf } = useModelScaleStore.getState()
  return {
    tilt: ts.tilt, spin: ts.spin, shading: ts.shading, turn: ts.turn,
    walls: ts.walls, figure: ts.figure, hovered: models.hovered,
    selected: new Set([
      ...useFreeNodeStore.getState().selectedIds.map(id => `node:${id}`),
      ...useBoardsStore.getState().selectedGroupIds.map(id => `card:${id}`),
    ]),
    unitsFor: url => scales[url],
    sizeFor: key => sizeOf[key] ?? 1,
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

function cardModel(id: string): { url: string; name: string } | null {
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(gr => gr.id === id)
  for (const bid of g ? g.boardIds : [id]) {
    const board = bs.boards[bid]
    if (!board) continue
    for (const bar of Object.values(board.bars)) {
      const m = getMediaItems(bar.content).find(it => it.type === 'model')
      if (m) return { url: m.url, name: m.originalName || fileName(m.url) || g?.name || 'Model' }
    }
  }
  return null
}

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
  const stage = document.querySelector<HTMLElement>('[data-tilt-stage="overlay"]')
  if (stage) {
    for (const el of stage.querySelectorAll<HTMLElement>('[data-group-card][data-id]')) {
      const model = cardModel(el.dataset.id!)
      const at = model && offsetIn(el, stage)
      if (!model || !at) continue
      out.push({
        key: `card:${el.dataset.id}`, url: model.url, name: model.name,
        u: at.x + el.offsetWidth / 2 - W / 2,
        v: at.y + el.offsetHeight / 2 - H / 2,
        w: Math.min(el.offsetWidth, el.offsetHeight * 1.4),
        h: el.offsetHeight,
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
  const shading = useTiltStore(s => s.shading)
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
  // Bare ground: left or middle drag pans, grabbing the ground under the
  // cursor. The wheel zooms about the point under it. Right-click is left
  // alone, so menus open where the cursor is.
  useEffect(() => {
    const root = rootRef.current!
    const host = hostOf(root)!
    const flatClient = (cx: number, cy: number) => {
      const r = host.getBoundingClientRect()
      const { tilt: t, spin: s } = useTiltStore.getState()
      const p = unprojectTilt(cx - r.left - r.width / 2, cy - r.top - r.height / 2, t, s)
      return p && { x: p.x + r.width / 2 + r.left, y: p.y + r.height / 2 + r.top }
    }
    /** Pressed on the tilted canvas (not a pinned panel, the HUD, the zoom bar). */
    const onPlane = (t: EventTarget | null) => {
      const el = t as Element | null
      return !!el?.closest?.('[data-tilt-stage]') && hostOf(el) === host
    }
    const isBareGround = (t: EventTarget | null) => (t as Element).matches('[data-tilt-stage="world"]')

    const resend = (e: MouseEvent, type: string, to: EventTarget) => {
      const p = flatClient(e.clientX, e.clientY)
      if (!p) return
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

    type Gesture =
      | { kind: 'pan'; last: { x: number; y: number } }
      | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number }
      | { kind: 'person'; url: string; unit0: number; y0: number }
      | { kind: 'model'; key: string; k0: number; y0: number; moved: boolean }
      | { kind: 'remap'; target: Element; pointerId: number }
    let g: Gesture | null = null
    const swallow = (e: Event) => { e.stopImmediatePropagation() }

    const onDown = (e: PointerEvent) => {
      if (!e.isTrusted) return
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
      g = { kind: 'remap', target, pointerId: e.pointerId }
      resend(e, 'pointerdown', target)
      resend(e, 'mousedown', target)
    }
    const onMove = (e: PointerEvent) => {
      if (!e.isTrusted) return
      if (!g) {
        models.hovered = e.buttons === 0 && hostOf(e.target as Element) === host
          ? models.pick?.(e.clientX, e.clientY) ?? null
          : null
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
        const a = flatClient(g.last.x, g.last.y), b = flatClient(e.clientX, e.clientY)
        g.last = { x: e.clientX, y: e.clientY }
        if (a && b) useCanvasStore.getState().shiftPan(b.x - a.x, b.y - a.y)
        return
      }
      // A card that captured the pointer gets it, as it would flat.
      const real = e.target as Element
      const to = real.hasPointerCapture?.(g.pointerId) ? real : g.target
      resend(e, 'pointermove', to)
      resend(e, 'mousemove', to)
    }
    const onUp = (e: PointerEvent) => {
      if (!e.isTrusted || !g) return
      swallow(e)
      if (g.kind === 'remap') {
        const real = e.target as Element
        const to = real.hasPointerCapture?.(g.pointerId) ? real : g.target
        resend(e, 'pointerup', to)
        resend(e, 'mouseup', to)
      }
      if (g.kind === 'marquee') { marqueeSelect(g, e.shiftKey); setBand(null) }
      g = null
    }
    const onWheel = (e: WheelEvent) => {
      if (!onPlane(e.target)) return
      e.preventDefault(); swallow(e)
      const p = flatClient(e.clientX, e.clientY)
      if (!p) return
      const r = host.getBoundingClientRect()
      useCanvasStore.getState().zoomAtPoint(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x - r.left, p.y - r.top)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      window.removeEventListener('wheel', onWheel, true)
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
        {(['textured', 'shaded', 'wire'] as const).map(m => (
          <button key={m} style={btn(shading === m)} onClick={() => set.setShading(m)}>
            {m === 'textured' ? 'Textured' : m === 'shaded' ? 'Shaded' : 'Wireframe'}
          </button>
        ))}
        <button style={btn(turn)} onClick={() => set.setTurn(!turn)}>Turn</button>
        <button style={btn(walls)} onClick={() => set.setWalls(!walls)} title="File name and size on a wall behind each model">Labels</button>
        <button style={btn(figure)} onClick={() => set.setFigure(!figure)} title="A 1.75 m person beside each model. Drag them up or down to set how big the model really is.">Person</button>
        <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }} />
        <button style={btn(true)} onClick={() => set.flatten()}>Flat (Esc)</button>
      </div>
    </div>
  )
}
