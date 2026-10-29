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

import React, { useEffect, useRef } from 'react'
import * as THREE from 'three'
import {
  useTiltStore, isTilted, unprojectTilt, TILT_PERSPECTIVE, TILT_SNAP, type TiltShading,
} from '../../store/tiltStore'
import { useCanvasStore, groupBounds, MIN_ZOOM, MAX_ZOOM } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useBoardsStore } from '../../store/boardsStore'
import { getMediaItems } from '../../types/bar'
import { acquireModel, releaseModel, disposeInstance } from '../../three/modelCache'
import { computePosedBounds } from '../../three/orbitState'

/** Degrees of tilt / turn per pixel of Alt+drag. */
const DRAG_DEG = 0.25
/** Most models stood up at once — they are heavy. */
const MAX_MODELS = 12

const hostOf = (el: Element | null) => el?.closest('[data-zoom-bar-host]') as HTMLElement | null

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
      const sel = t0 < TILT_SNAP ? frameBox(true) : null
      const W = host.clientWidth, H = host.clientHeight
      const { pan, zoom } = useCanvasStore.getState()
      const cFrom = { x: (W / 2 - pan.x) / zoom, y: (H / 2 - pan.y) / zoom }
      const cTo = sel && { x: (sel.x0 + sel.x1) / 2, y: (sel.y0 + sel.y1) / 2 }
      // Orbit like Blender/Maya: you grab the near part of the ground —
      // drag up tips it away, drag right swings it right.
      const onMove = (ev: PointerEvent) => {
        useTiltStore.getState().setView(t0 - (ev.clientY - y0) * DRAG_DEG, s0 - (ev.clientX - x0) * DRAG_DEG)
        if (cTo) {
          const u = Math.min(1, useTiltStore.getState().tilt / 20)
          const k = u * u * (3 - 2 * u)
          const z = useCanvasStore.getState().zoom
          const cx = cFrom.x + (cTo.x - cFrom.x) * k, cy = cFrom.y + (cTo.y - cFrom.y) * k
          useCanvasStore.getState().setPan({ x: W / 2 - cx * z, y: H / 2 - cy * z })
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
        const u = Math.min(1, (performance.now() - start) / 380)
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
  return tilted ? <TiltedView /> : null
}

// ── Model cards ──

interface Target { key: string; url: string; u: number; v: number; w: number }

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

function cardModelUrl(id: string): string | null {
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(gr => gr.id === id)
  for (const bid of g ? g.boardIds : [id]) {
    const board = bs.boards[bid]
    if (!board) continue
    for (const bar of Object.values(board.bars)) {
      const m = getMediaItems(bar.content).find(it => it.type === 'model')
      if (m) return m.url
    }
  }
  return null
}

/** Every model card in view, as flat px from the host centre. */
function collectTargets(W: number, H: number): Target[] {
  const out: Target[] = []
  const { pan, zoom } = useCanvasStore.getState()
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    if (n.type !== 'model' || n.pin || !n.imageUrl) continue
    out.push({
      key: `node:${n.id}`, url: n.imageUrl,
      u: pan.x + (n.x + n.width / 2) * zoom - W / 2,
      v: pan.y + (n.y + n.height / 2) * zoom - H / 2,
      w: Math.min(n.width, n.height * 1.4) * zoom,
    })
  }
  const stage = document.querySelector<HTMLElement>('[data-tilt-stage="overlay"]')
  if (stage) {
    for (const el of stage.querySelectorAll<HTMLElement>('[data-group-card][data-id]')) {
      const url = cardModelUrl(el.dataset.id!)
      const at = url && offsetIn(el, stage)
      if (!url || !at) continue
      out.push({
        key: `card:${el.dataset.id}`, url,
        u: at.x + el.offsetWidth / 2 - W / 2,
        v: at.y + el.offsetHeight / 2 - H / 2,
        w: Math.min(el.offsetWidth, el.offsetHeight * 1.4),
      })
    }
  }
  return out
    .filter(t => Math.abs(t.u) < W && Math.abs(t.v) < H && t.w > 4)
    .slice(0, MAX_MODELS)
}

interface Standing {
  url: string
  stand: THREE.Group      // on the plane; local +Y is the plane's normal
  turn: THREE.Group       // turntable about that normal
  inst: THREE.Object3D | null
  size: THREE.Vector3
  phase: number
  dead: boolean
  /** Frame it was last among the targets. */
  seen: number
}

const WIRE_MAT = new THREE.MeshBasicMaterial({ color: 0x9fd0ff, wireframe: true, transparent: true, opacity: 0.85 })
const SHADED_MAT = new THREE.MeshStandardMaterial({ color: 0xc8ccd8, roughness: 0.75, metalness: 0 })
const overrideFor = (s: TiltShading) => s === 'wire' ? WIRE_MAT : s === 'shaded' ? SHADED_MAT : null

const TiltedView: React.FC = () => {
  const rootRef = useRef<HTMLDivElement>(null)
  const shading = useTiltStore(s => s.shading)
  const turn = useTiltStore(s => s.turn)
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
      | { kind: 'remap'; target: Element; pointerId: number }
    let g: Gesture | null = null
    const swallow = (e: Event) => { e.stopImmediatePropagation() }

    const onDown = (e: PointerEvent) => {
      if (!e.isTrusted || !onPlane(e.target)) return
      // Alt+left / Alt+right belong to the orbit and dolly gestures.
      if (e.altKey && e.button !== 1) return
      if (e.button === 1 || (e.button === 0 && isBareGround(e.target))) {
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
      if (!e.isTrusted || !g) return
      swallow(e)
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

  // ── Models standing on their cards ──
  useEffect(() => {
    // A fresh canvas per mount: a canvas whose context was lost (cleanup
    // below) can never give a working one again, and StrictMode remounts.
    const root = rootRef.current!
    const canvas = document.createElement('canvas')
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' })
    root.prepend(canvas)
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
    } catch {
      canvas.remove()   // no WebGL: the plane still tilts, models stay flat
      return
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.setClearColor(0x000000, 0)
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.2))
    const sun = new THREE.DirectionalLight(0xffffff, 1.5)
    sun.position.set(300, 800, 900)
    scene.add(sun)
    const camera = new THREE.PerspectiveCamera(50, 1, 10, TILT_PERSPECTIVE * 20)
    camera.position.set(0, 0, TILT_PERSPECTIVE)
    // The plane: CSS rotateX(t) rotateZ(s), carried from CSS's y-down
    // space into three's y-up space (F·R·F, F = flip y).
    const ground = new THREE.Group()
    ground.matrixAutoUpdate = false
    scene.add(ground)
    const F = new THREE.Matrix4().makeScale(1, -1, 1)
    const R = new THREE.Matrix4(), Rz = new THREE.Matrix4()

    const standing = new Map<string, Standing>()
    const spawn = (key: string, url: string): Standing => {
      const stand = new THREE.Group()
      stand.rotation.x = Math.PI / 2   // model +Y → plane normal; its front faces the viewer
      const turnG = new THREE.Group()
      stand.add(turnG)
      ground.add(stand)
      const s: Standing = { url, stand, turn: turnG, inst: null, size: new THREE.Vector3(), phase: Math.random() * 6.28, dead: false, seen: 0 }
      acquireModel(url).then(inst => {
        if (s.dead) { releaseModel(url); disposeInstance(inst); return }
        const box = computePosedBounds(inst)
        const c = box.getCenter(new THREE.Vector3())
        box.getSize(s.size)
        // Feet on the card, centred on it.
        inst.position.set(-c.x, -box.min.y, -c.z)
        turnG.add(inst)
        s.inst = inst
      }).catch(() => { /* unreadable model: the card just stays flat */ })
      standing.set(key, s)
      return s
    }
    const drop = (key: string, s: Standing) => {
      s.dead = true
      s.stand.removeFromParent()
      if (s.inst) { disposeInstance(s.inst); releaseModel(s.url) }
      standing.delete(key)
    }

    let raf = 0
    let frameNo = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      frameNo++
      const W = root.clientWidth, H = root.clientHeight
      if (!W || !H) return
      const { tilt: t, spin: sp, shading: sh, turn: on } = useTiltStore.getState()
      const size = renderer.getSize(new THREE.Vector2())
      if (size.x !== W || size.y !== H) renderer.setSize(W, H, false)
      camera.aspect = W / H
      camera.fov = 2 * Math.atan(H / 2 / TILT_PERSPECTIVE) * 180 / Math.PI
      camera.updateProjectionMatrix()
      R.makeRotationX(t * Math.PI / 180).multiply(Rz.makeRotationZ(sp * Math.PI / 180))
      ground.matrix.copy(F).multiply(R).multiply(F)
      ground.matrixWorldNeedsUpdate = true
      scene.overrideMaterial = overrideFor(sh)

      // Models rise out of their cards as the plane tips back.
      const rise = Math.min(1, Math.max(0, (t - 4) / 26))
      const ease = rise * rise * (3 - 2 * rise)
      const targets = collectTargets(W, H)
      const keep = new Set<string>()
      for (const tg of targets) {
        keep.add(tg.key)
        let s = standing.get(tg.key)
        if (s && s.url !== tg.url) { drop(tg.key, s); s = undefined }
        if (!s) s = spawn(tg.key, tg.url)
        s.stand.position.set(tg.u, -tg.v, 0)
        const foot = Math.max(s.size.x, s.size.z, 1e-6)
        let k = (tg.w * 0.6) / foot
        if (s.size.y * k > tg.w * 1.1) k = (tg.w * 1.1) / Math.max(s.size.y, 1e-6)
        s.stand.scale.set(k, k * Math.max(ease, 0.001), k)
        s.stand.visible = !!s.inst && ease > 0
        s.turn.rotation.y = on ? now / 1000 * 0.6 + s.phase : 0
      }
      // A card missing for a frame or two (a re-render, a deck shuffling)
      // is only hidden: dropping it would reload the model and blink.
      for (const [key, s] of standing) {
        if (keep.has(key)) { s.seen = frameNo; continue }
        s.stand.visible = false
        if (frameNo - s.seen > 120) drop(key, s)
      }
      renderer.render(scene, camera)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      for (const [key, s] of [...standing]) drop(key, s)
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
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
        <span>Tilted {Math.round(tilt)}° · drag cards to move them · drag the ground to pan · scroll to zoom · Alt+drag to orbit · F to frame</span>
        <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }} />
        {(['textured', 'shaded', 'wire'] as const).map(m => (
          <button key={m} style={btn(shading === m)} onClick={() => set.setShading(m)}>
            {m === 'textured' ? 'Textured' : m === 'shaded' ? 'Shaded' : 'Wireframe'}
          </button>
        ))}
        <button style={btn(turn)} onClick={() => set.setTurn(!turn)}>Turn</button>
        <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }} />
        <button style={btn(true)} onClick={() => set.flatten()}>Flat (Esc)</button>
      </div>
    </div>
  )
}
