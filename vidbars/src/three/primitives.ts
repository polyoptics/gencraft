// primitives.ts — simple shapes to lay out a 3D area with (Brian
// 2026-11-08): a model whose url is `prim:<shape>` is made here, not
// loaded, so it goes everywhere a model goes (cards, posters, the 3D view,
// a 3D area's layout). In metres, standing on the ground, plain light grey
// so a model colour shows true.

import * as THREE from 'three'

export const PRIMITIVES = ['cube', 'sphere', 'cylinder', 'cone', 'plane', 'camera'] as const
export type Primitive = typeof PRIMITIVES[number]

export const PRIM_NAMES: Record<Primitive, string> = { cube: 'Cube', sphere: 'Sphere', cylinder: 'Cylinder', cone: 'Cone', plane: 'Plane', camera: 'Camera' }

export const isPrimitiveUrl = (url: string): boolean => url.startsWith('prim:')
export const primitiveUrl = (p: Primitive): string => `prim:${p}`

export const CAMERA_URL = 'prim:camera'
/** Where a camera primitive's lens is, model units: it looks down +z
 *  from here (its front faces the viewer, as every model's does). */
export const CAMERA_LENS_AT: [number, number, number] = [0, 0.3, 0.78]

/** A film camera (Brian 2026-11-09): a body, a lens with its hood, two
 *  reels on top, so which way it points and how it is turned read at a
 *  glance. 1 m long, standing on the ground. */
function makeCamera(): THREE.Group {
  const body = new THREE.MeshStandardMaterial({ color: 0xd8dce4, roughness: 0.55, metalness: 0.1 })
  const g = new THREE.Group()
  g.name = 'Camera'
  const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number, m: THREE.Material = body) => {
    const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); g.add(mesh); return mesh
  }
  add(new THREE.BoxGeometry(0.36, 0.5, 0.78), 0, 0.3, 0.06)
  // The lens, along +z, with a hood flaring out at its front.
  add(new THREE.CylinderGeometry(0.12, 0.12, 0.2, 32).rotateX(Math.PI / 2), 0, 0.3, 0.55)
  add(new THREE.CylinderGeometry(0.19, 0.13, 0.13, 32, 1, true).rotateX(Math.PI / 2), 0, 0.3, 0.715)
  // Its glass: dark, so the front reads even in one colour.
  const glass = new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.1, metalness: 0.6 })
  add(new THREE.CircleGeometry(0.115, 32), 0, 0.3, 0.651, glass)
  // Two reels on top, the bigger one in front.
  const reel = (r: number) => new THREE.CylinderGeometry(r, r, 0.1, 40).rotateZ(Math.PI / 2)
  add(reel(0.21), 0, 0.76, 0.12)
  add(reel(0.17), 0, 0.72, -0.28)
  // A viewfinder out of its left side, at the back.
  add(new THREE.BoxGeometry(0.1, 0.1, 0.22), -0.23, 0.38, -0.2)
  return g
}

/** The shape for a `prim:` url (a 1 m cube when it names none known). */
export function makePrimitive(url: string): THREE.Group {
  const kind = url.slice(5) as Primitive
  if (kind === 'camera') return makeCamera()
  const geo =
    kind === 'sphere' ? new THREE.SphereGeometry(0.5, 48, 24)
    : kind === 'cylinder' ? new THREE.CylinderGeometry(0.5, 0.5, 1, 48)
    : kind === 'cone' ? new THREE.ConeGeometry(0.5, 1, 48)
    : kind === 'plane' ? new THREE.BoxGeometry(2, 0.02, 2)
    : new THREE.BoxGeometry(1, 1, 1)
  const mat = new THREE.MeshStandardMaterial({ color: 0xd8dce4, roughness: 0.6, metalness: 0 })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = PRIM_NAMES[kind] ?? 'Cube'
  // Standing on the ground (its base at y = 0).
  mesh.position.y = kind === 'plane' ? 0.01 : 0.5
  const g = new THREE.Group()
  g.name = mesh.name
  g.add(mesh)
  return g
}
