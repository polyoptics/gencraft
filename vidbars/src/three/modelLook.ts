// modelLook.ts — how a model is drawn, shared by the tilted 3D view and the
// Viewers, as three independent choices (Brian 2026-11-02):
//   texture  its own textures, or plain grey
//   shade    flat (faceted) or smooth shading, or none
//   wire     a wireframe over whatever else shows
// Texture on with no shading is the texture unlit; texture off with no
// shading is no surface at all, so the model is hollow.
//
// The cached materials and geometry are shared with every other view of the
// model, so an instance gets its own material copies, and swaps to a
// ref-counted smooth-normal geometry only while Smooth shows.

import * as THREE from 'three'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export type ModelShade = 'flat' | 'smooth' | null

export interface ModelLook {
  texture: boolean
  shade: ModelShade
  wire: boolean
}

export const DEFAULT_LOOK: ModelLook = { texture: true, shade: 'smooth', wire: false }

/** Many models arrive with split, faceted normals. Normals are averaged
 *  across faces that meet at under SMOOTH_CREASE, so curves go smooth and
 *  hard edges stay hard. Skinned meshes keep their own normals. */
const SMOOTH_CREASE = Math.PI * 70 / 180
const SMOOTH_MAX_TRIS = 400_000
const smoothed = new Map<THREE.BufferGeometry, { geo: THREE.BufferGeometry; refs: number }>()
type Swap = { mesh: THREE.Mesh; orig: THREE.BufferGeometry; smooth: THREE.BufferGeometry }

function smoothSwaps(root: THREE.Object3D): Swap[] {
  const out: Swap[] = []
  root.traverse(o => {
    const mesh = o as THREE.Mesh
    const src = mesh.isMesh ? mesh.geometry : null
    if (!src?.attributes.position || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return
    const tris = src.index ? src.index.count / 3 : src.attributes.position.count / 3
    if (tris > SMOOTH_MAX_TRIS) return
    let e = smoothed.get(src)
    if (!e) {
      try { e = { geo: toCreasedNormals(src, SMOOTH_CREASE), refs: 0 } } catch { return }
      smoothed.set(src, e)
    }
    e.refs++
    out.push({ mesh, orig: src, smooth: e.geo })
  })
  return out
}

function unlitCopy(m: THREE.Material): THREE.MeshBasicMaterial {
  const s = m as THREE.MeshStandardMaterial
  return new THREE.MeshBasicMaterial({
    map: s.map ?? null, alphaMap: s.alphaMap ?? null, color: s.color ?? 0xffffff,
    vertexColors: s.vertexColors, side: s.side, alphaTest: s.alphaTest,
    transparent: s.transparent, opacity: s.opacity,
  })
}

type Mat = THREE.Material | THREE.Material[]

export interface LookInstance {
  root: THREE.Object3D
  meshes: { mesh: THREE.Mesh; lit: Mat; unlit: Mat }[]
  lit: THREE.Material[]
  all: THREE.Material[]
  swaps: Swap[] | null
  smoothOn: boolean
  flatOn: boolean
  /** Each of its materials that came with a colour map, and that map; the
   *  maps numbered as three/modelMaps counts them; and which pictures it
   *  wears in their place now (modelMaps gradeLook). */
  maps: Map<THREE.Material, THREE.Texture>
  slotOf: Map<THREE.Texture, number>
  gradeSig: string
}

/** Give an instance its own materials; `made` hears each one created. */
export function createLook(root: THREE.Object3D, made?: (m: THREE.Material) => void): LookInstance {
  const look: LookInstance = { root, meshes: [], lit: [], all: [], swaps: null, smoothOn: false, flatOn: false, maps: new Map(), slotOf: new Map(), gradeSig: '' }
  const add = <M extends THREE.Material>(m: M): M => {
    look.all.push(m); made?.(m)
    const map = (m as unknown as THREE.MeshStandardMaterial).map
    if (map) {
      look.maps.set(m, map)
      if (!look.slotOf.has(map)) look.slotOf.set(map, look.slotOf.size)
    }
    return m
  }
  const litOf = (m: THREE.Material) => { const c = add(m.clone()); look.lit.push(c); return c }
  root.traverse(o => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const src = mesh.material
    const lit = Array.isArray(src) ? src.map(litOf) : litOf(src)
    const unlit = Array.isArray(src) ? src.map(m => add(unlitCopy(m))) : add(unlitCopy(src))
    mesh.material = lit
    look.meshes.push({ mesh, lit, unlit })
  })
  return look
}

/** Set an instance's materials and normals for this frame. Idempotent. */
export function applyLook(look: LookInstance, texture: boolean, shade: ModelShade): void {
  const wantSmooth = shade === 'smooth'
  if (wantSmooth && !look.swaps) look.swaps = smoothSwaps(look.root)
  if (look.swaps && wantSmooth !== look.smoothOn) {
    look.smoothOn = wantSmooth
    for (const w of look.swaps) w.mesh.geometry = wantSmooth ? w.smooth : w.orig
  }
  const wantFlat = shade === 'flat'
  if (wantFlat !== look.flatOn) {
    look.flatOn = wantFlat
    for (const m of look.lit) {
      (m as THREE.MeshStandardMaterial).flatShading = wantFlat
      m.needsUpdate = true
    }
  }
  const unlit = texture && !shade
  for (const e of look.meshes) e.mesh.material = unlit ? e.unlit : e.lit
}

/** Hand the geometry back and free the copies. */
export function disposeLook(look: LookInstance): void {
  for (const w of look.swaps ?? []) {
    w.mesh.geometry = w.orig
    const e = smoothed.get(w.orig)
    if (e && --e.refs <= 0) { e.geo.dispose(); smoothed.delete(w.orig) }
  }
  for (const m of look.all) m.dispose()
}
