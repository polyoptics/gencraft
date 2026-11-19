// lineupScene.ts — the models standing on the world scale's lineup
// (components/UI/WorldScaleLine; Brian 2026-11-19: "The models could line
// up ... you could see the spinning models and all that stuff on the
// ruler"). One small canvas over the strip, looked at square on so a
// model's head is at its height on the ruler; each model stands at its
// place along it, as tall as its card says, turning.

import * as THREE from 'three'
import { acquireModel, releaseModel, disposeInstance } from './modelCache'
import { computePosedBounds } from './orbitState'

/** A model on the lineup: where its feet are (px from the canvas's left
 *  and from its bottom) and how tall it stands, px. */
export interface LineupModel { id: string; url: string; x: number; y: number; h: number }

/** Radians a second. */
const TURN = 0.7

export function createLineupScene(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setClearColor(0x000000, 0)
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x50556a, 1.5))
  const sun = new THREE.DirectionalLight(0xffffff, 1.8)
  sun.position.set(-0.5, 0.8, 1)
  scene.add(sun)
  const camera = new THREE.OrthographicCamera(0, 1, 1, 0, -20000, 20000)
  type Stood = { url: string; at: THREE.Group; turn: THREE.Group; inst: THREE.Object3D | null; tall: number; dead: boolean }
  const stood = new Map<string, Stood>()
  let raf = 0, dead = false, W = 0, H = 0
  const t0 = performance.now()

  const drop = (id: string) => {
    const s = stood.get(id)
    if (!s) return
    s.dead = true
    stood.delete(id)
    scene.remove(s.at)
    if (s.inst) { disposeInstance(s.inst); releaseModel(s.url) }
  }
  const frame = () => {
    raf = 0
    if (dead) return
    const a = (performance.now() - t0) / 1000 * TURN
    for (const s of stood.values()) s.turn.rotation.y = a
    renderer.render(scene, camera)
    if (stood.size) raf = requestAnimationFrame(frame)
  }
  const kick = () => { if (!raf && !dead) raf = requestAnimationFrame(frame) }

  return {
    /** The models to show now, on a canvas `w` by `h` px. */
    set(models: LineupModel[], w: number, h: number) {
      if (dead) return
      if (w !== W || h !== H) {
        W = w; H = h
        renderer.setSize(w, h, false)
        camera.right = w; camera.top = h
        camera.updateProjectionMatrix()
      }
      const seen = new Set<string>()
      for (const m of models) {
        seen.add(m.id)
        let s = stood.get(m.id)
        if (s && s.url !== m.url) { drop(m.id); s = undefined }
        if (!s) {
          const at = new THREE.Group(), turn = new THREE.Group()
          at.add(turn)
          scene.add(at)
          const made: Stood = s = { url: m.url, at, turn, inst: null, tall: 0, dead: false }
          stood.set(m.id, made)
          acquireModel(m.url).then(inst => {
            if (made.dead || dead) { disposeInstance(inst); releaseModel(m.url); return }
            const box = computePosedBounds(inst)
            const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3())
            // Feet at the turning point, its middle over it.
            inst.position.set(-c.x, -box.min.y, -c.z)
            made.tall = size.y
            made.inst = inst
            turn.add(inst)
            if (made.tall > 0) turn.scale.setScalar(Number(turn.userData.h ?? 0) / made.tall)
            kick()
          }).catch(() => { /* unreadable model: its place stays empty */ })
        }
        s.at.position.set(m.x, m.y, 0)
        s.turn.userData.h = m.h
        if (s.tall > 0) s.turn.scale.setScalar(m.h / s.tall)
      }
      for (const id of [...stood.keys()]) if (!seen.has(id)) drop(id)
      kick()
    },
    dispose() {
      dead = true
      if (raf) cancelAnimationFrame(raf)
      for (const id of [...stood.keys()]) drop(id)
      // (Its context is left to go with the canvas: forced lost, a canvas
      // mounted twice over, as a dev build mounts it, could not draw again.)
      renderer.dispose()
    },
  }
}
