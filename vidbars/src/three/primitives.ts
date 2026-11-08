// primitives.ts — simple shapes to lay out a 3D area with (Brian
// 2026-11-08): a model whose url is `prim:<shape>` is made here, not
// loaded, so it goes everywhere a model goes (cards, posters, the 3D view,
// a 3D area's layout). In metres, standing on the ground, plain light grey
// so a model colour shows true.

import * as THREE from 'three'

export const PRIMITIVES = ['cube', 'sphere', 'cylinder', 'cone', 'plane'] as const
export type Primitive = typeof PRIMITIVES[number]

export const PRIM_NAMES: Record<Primitive, string> = { cube: 'Cube', sphere: 'Sphere', cylinder: 'Cylinder', cone: 'Cone', plane: 'Plane' }

export const isPrimitiveUrl = (url: string): boolean => url.startsWith('prim:')
export const primitiveUrl = (p: Primitive): string => `prim:${p}`

/** The shape for a `prim:` url (a 1 m cube when it names none known). */
export function makePrimitive(url: string): THREE.Group {
  const kind = url.slice(5) as Primitive
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
