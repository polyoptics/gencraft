// orbitState.ts — hand-rolled orbit-camera math for viewport windows.
//
// Why not three's OrbitControls: it normalizes rotation by the DOM
// element's clientHeight, which ignores CSS transforms — inside the
// canvas's `scale(zoom)` world that makes rotation speed vary ~zoom×.
// Our input handlers normalize by the window's VISUAL height
// (height * zoom) instead, so the feel is zoom-invariant. State is a
// plain mutable object owned by the renderer's view registry; input
// handlers mutate it and call requestRender() — no store churn at
// pointer-move rate.

import * as THREE from 'three'
import type { Viewport3DCamera } from '../store/viewport3dStore'

export type OrbitState = Viewport3DCamera

const EPS = 0.01

export function clampPhi(phi: number): number {
  return Math.min(Math.PI - EPS, Math.max(EPS, phi))
}

/** Position + aim `cam` from spherical orbit state. */
export function applyOrbit(cam: THREE.PerspectiveCamera, o: OrbitState): void {
  const sinPhi = Math.sin(o.phi)
  cam.position.set(
    o.tx + o.radius * sinPhi * Math.sin(o.theta),
    o.ty + o.radius * Math.cos(o.phi),
    o.tz + o.radius * sinPhi * Math.cos(o.theta),
  )
  cam.lookAt(o.tx, o.ty, o.tz)
}

/** Default orbit that frames `root` nicely: target at the bounding-sphere
 *  center, radius derived from its size + camera fov. Returns the orbit
 *  plus near/far planes derived from the model scale (a fixed near clips
 *  huge models and z-fights tiny ones). */
/** Bounds of what is actually ON SCREEN.
 *
 *  Box3.setFromObject uses a SkinnedMesh's geometry bounds transformed by
 *  its world matrix — i.e. the BIND POSE, which for a rigged character is
 *  routinely far larger than the posed mesh and offset from it (T-pose
 *  arms, a root bone at the origin). Framing off that puts the model in a
 *  corner of the frame, tiny. So for skinned meshes we walk the vertices
 *  through applyBoneTransform and measure where they really are.
 *
 *  Sampled for large meshes: a bounding box only needs the extremes, and
 *  every 12th vertex finds them to well inside a pixel at poster size. */
export function computePosedBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true)
  const box = new THREE.Box3()
  const v = new THREE.Vector3()
  let sawSkinned = false

  root.traverse(obj => {
    const sk = obj as THREE.SkinnedMesh
    if (!sk.isSkinnedMesh || !sk.geometry?.attributes?.position) return
    sawSkinned = true
    const pos = sk.geometry.attributes.position
    const step = pos.count > 6000 ? 12 : 1
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i)
      sk.applyBoneTransform(i, v)
      box.expandByPoint(sk.localToWorld(v))
    }
    // Always include the last vertex — sampling can miss a lone extreme.
    if (step > 1 && pos.count > 0) {
      v.fromBufferAttribute(pos, pos.count - 1)
      sk.applyBoneTransform(pos.count - 1, v)
      box.expandByPoint(sk.localToWorld(v))
    }
  })

  // Non-skinned geometry (props, static parts) measured the normal way.
  root.traverse(obj => {
    const m = obj as THREE.Mesh
    if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || !m.geometry) return
    m.geometry.computeBoundingBox()
    if (m.geometry.boundingBox) {
      box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld))
    }
  })

  if (box.isEmpty()) return new THREE.Box3().setFromObject(root)
  // A rig with no skinned mesh gains nothing from the walk above; the
  // plain box is equivalent and cheaper to trust.
  if (!sawSkinned) return new THREE.Box3().setFromObject(root)
  return box
}

export function frameModel(root: THREE.Object3D, fovDeg = 50): { orbit: OrbitState; near: number; far: number } {
  const box = computePosedBounds(root)
  const sphere = new THREE.Sphere()
  box.getBoundingSphere(sphere)
  const r = Math.max(sphere.radius, 1e-4)
  const dist = (r / Math.tan((fovDeg * Math.PI / 180) / 2)) * 1.4
  return {
    orbit: {
      theta: Math.PI / 4,          // 3/4 view
      phi: Math.PI / 2.6,          // slightly above
      radius: dist,
      tx: sphere.center.x, ty: sphere.center.y, tz: sphere.center.z,
    },
    near: Math.max(dist / 100, 1e-4),
    far: dist * 20,
  }
}

/** Dolly bounds for a framed model. Deliberately loose: when the automatic
 *  framing gets a model wrong you need to be able to pull right back, see
 *  it, and re-frame by hand — a tight ceiling made that impossible. */
export function dollyBounds(o: OrbitState): { min: number; max: number } {
  return { min: o.radius * 0.002, max: o.radius * 200 }
}

const _right = new THREE.Vector3()
const _up = new THREE.Vector3()

/** Truck/pedestal pan: shift the orbit TARGET along the camera's right/up
 *  basis so the view slides without rotating. Screen deltas are converted
 *  at the target's distance (world-per-pixel from the vertical fov), using
 *  the window's VISUAL height — zoom-invariant like the orbit rotation. */
export function panOrbit(
  o: OrbitState,
  cam: THREE.PerspectiveCamera,
  dxPx: number,
  dyPx: number,
  screenHpx: number,
): void {
  const wpp = (2 * o.radius * Math.tan((cam.fov * Math.PI / 180) / 2)) / Math.max(1, screenHpx)
  // Camera basis from its world matrix (applyOrbit ran last frame; position
  // + lookAt keep it current). Columns: 0 = right, 1 = up.
  _right.setFromMatrixColumn(cam.matrixWorld, 0)
  _up.setFromMatrixColumn(cam.matrixWorld, 1)
  o.tx += -dxPx * wpp * _right.x + dyPx * wpp * _up.x
  o.ty += -dxPx * wpp * _right.y + dyPx * wpp * _up.y
  o.tz += -dxPx * wpp * _right.z + dyPx * wpp * _up.z
}
