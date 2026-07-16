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
export function frameModel(root: THREE.Object3D, fovDeg = 50): { orbit: OrbitState; near: number; far: number } {
  const box = new THREE.Box3().setFromObject(root)
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

/** Dolly bounds for a framed model — keeps wheel-zoom sane. */
export function dollyBounds(o: OrbitState): { min: number; max: number } {
  return { min: o.radius * 0.05, max: o.radius * 10 }
}
