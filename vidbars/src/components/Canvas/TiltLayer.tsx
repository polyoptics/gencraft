// TiltLayer.tsx — the tilted view of the canvas (store/tiltStore).
//
// Alt+left-drag (Alt is the camera modifier) tips the flat canvas back
// into a ground plane: drag up/down to tilt, left/right to turn it. The
// DOM layers themselves are tilted with CSS (InfiniteCanvas world layers
// and the LayerOverlay wrapper in App share tiltCss), so every card, block
// and 3D viewer window stays exactly where it was on the plane.
//
// What this layer adds on top, only while tilted:
//  - a pointer catcher: tilt is for looking, and every hit zone below
//    assumes the flat view, so here drag pans (grabbing the ground under
//    the cursor), the wheel zooms about the point under the cursor, and
//    Alt+drag keeps tilting. Esc, the Flat button, or tilting back down
//    returns to the flat view where editing works as always.
//  - one three.js canvas that stands each model card's model up above its
//    card, with the same camera the CSS perspective uses.

import React, { useEffect, useRef } from 'react'
import * as THREE from 'three'
import {
  useTiltStore, isTilted, unprojectTilt, TILT_PERSPECTIVE, TILT_SNAP, type TiltShading,
} from '../../store/tiltStore'
import { useCanvasStore } from '../../store/canvasStore'
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
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !e.altKey) return
      const target = e.target as Element | null
      const host = hostOf(target)
      if (!host) return
      if (target?.closest('input,textarea,select,[contenteditable="true"],[data-viewport3d],[data-freenode],[data-tilt-hud]')) return
      e.preventDefault()
      e.stopPropagation()
      altUsed = true
      const { tilt: t0, spin: s0 } = useTiltStore.getState()
      const x0 = e.clientX, y0 = e.clientY
      // Orbit like Blender/Maya: you grab the near part of the ground —
      // drag up tips it away, drag right swings it right.
      const onMove = (ev: PointerEvent) => {
        useTiltStore.getState().setView(t0 - (ev.clientY - y0) * DRAG_DEG, s0 - (ev.clientX - x0) * DRAG_DEG)
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
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])
}

export const TiltLayer: React.FC = () => {
  useAltTiltGesture()
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
}

const WIRE_MAT = new THREE.MeshBasicMaterial({ color: 0x9fd0ff, wireframe: true, transparent: true, opacity: 0.85 })
const SHADED_MAT = new THREE.MeshStandardMaterial({ color: 0xc8ccd8, roughness: 0.75, metalness: 0 })
const overrideFor = (s: TiltShading) => s === 'wire' ? WIRE_MAT : s === 'shaded' ? SHADED_MAT : null

const TiltedView: React.FC = () => {
  const rootRef = useRef<HTMLDivElement>(null)
  const shading = useTiltStore(s => s.shading)
  const turn = useTiltStore(s => s.turn)
  const tilt = useTiltStore(s => s.tilt)

  // ── Pan + zoom on the tilted plane ──
  useEffect(() => {
    const root = rootRef.current!
    const flatAt = (clientX: number, clientY: number) => {
      const r = root.getBoundingClientRect()
      const { tilt: t, spin: s } = useTiltStore.getState()
      const p = unprojectTilt(clientX - r.left - r.width / 2, clientY - r.top - r.height / 2, t, s)
      return p && { x: p.x + r.width / 2, y: p.y + r.height / 2 }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = flatAt(e.clientX, e.clientY)
      if (!p) return
      useCanvasStore.getState().zoomAtPoint(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y)
    }
    const onDown = (e: PointerEvent) => {
      if (e.altKey || (e.button !== 0 && e.button !== 1)) return
      if ((e.target as Element).closest('[data-tilt-hud]')) return
      e.preventDefault()
      root.setPointerCapture(e.pointerId)
      let last = { x: e.clientX, y: e.clientY }
      const onMove = (ev: PointerEvent) => {
        const a = flatAt(last.x, last.y), b = flatAt(ev.clientX, ev.clientY)
        last = { x: ev.clientX, y: ev.clientY }
        if (a && b) useCanvasStore.getState().shiftPan(b.x - a.x, b.y - a.y)
      }
      const onUp = () => {
        root.removeEventListener('pointermove', onMove)
        root.removeEventListener('pointerup', onUp)
      }
      root.addEventListener('pointermove', onMove)
      root.addEventListener('pointerup', onUp)
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    root.addEventListener('pointerdown', onDown)
    return () => {
      root.removeEventListener('wheel', onWheel)
      root.removeEventListener('pointerdown', onDown)
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
      const s: Standing = { url, stand, turn: turnG, inst: null, size: new THREE.Vector3(), phase: Math.random() * 6.28, dead: false }
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
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
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
      for (const [key, s] of standing) if (!keep.has(key)) drop(key, s)
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
      style={{ position: 'absolute', inset: 0, zIndex: 850, cursor: 'grab', touchAction: 'none' }}
    >
      <div
        data-tilt-hud
        style={{
          position: 'absolute', left: '50%', bottom: 14, transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
          background: 'rgba(19,20,31,0.88)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10,
          color: 'rgba(255,255,255,0.5)', fontSize: 11, cursor: 'default', userSelect: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        <span>Tilted {Math.round(tilt)}° · drag to pan · scroll to zoom · Alt+drag to tilt and turn</span>
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
