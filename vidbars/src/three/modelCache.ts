// modelCache.ts — GLTF/GLB loading, caching, and disposal.
//
// Cache is keyed by the RAW ref string ('mediaref:<id>' | '/uploads/…' |
// 'http…') — never a session object URL, so the same model docked in two
// windows loads once. `mediaref:` bytes come straight from the blob store
// (loader.parse from an ArrayBuffer — self-contained GLB only; a multi-file
// .gltf needs an http/path URL for its external resources). Each consumer
// gets its own instance via SkeletonUtils.clone (plain .clone() shares
// skinned-mesh skeletons incorrectly; SkeletonUtils handles both skinned
// and static safely).
//
// Refcounted: release() moves a zero-ref entry into a small LRU; eviction
// fully disposes geometry/materials/textures. DRACO-compressed GLBs are
// not supported yet — the loader error surfaces as the window's error
// state ("compressed GLB not supported").

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { isMediaRef, mediaRefId } from '../utils/mediaRef'
import { inlineGlbTextures } from './glbInlineTextures'
import { getMedia } from '../utils/mediaStore'

interface CacheEntry {
  source: THREE.Group      // pristine parsed scene — never rendered directly
  refCount: number
}

const cache = new Map<string, CacheEntry>()
const pending = new Map<string, Promise<CacheEntry>>()
// Zero-ref entries kept warm, oldest-first. Small: models are heavy.
const lru: string[] = []
const LRU_MAX = 6

// Textures arrive as `data:` URIs (see inlineGlbTextures) and must be
// decoded by the plain TextureLoader, NOT three's default ImageBitmapLoader.
// ImageBitmapLoader does fetch(url) -> .blob() -> createImageBitmap, and the
// blob step throws in this runtime — which is why every model rendered in
// flat grey while its geometry loaded fine. Registering a handler for
// data: URIs routes them through an <img>, which works.
const manager = new THREE.LoadingManager()
manager.addHandler(/^data:/, new THREE.TextureLoader(manager))

const loader = new GLTFLoader(manager)

async function loadEntry(url: string): Promise<CacheEntry> {
  // Both paths go through parseAsync on bytes we hold, so the texture
  // inlining below applies either way. (The url path used to call
  // loadAsync, which fetches and parses internally and gave us no chance
  // to touch the buffer.)
  const buf = isMediaRef(url)
    ? await (async () => {
        const blob = await getMedia(mediaRefId(url)!)
        if (!blob) throw new Error('Model bytes not found in local media store')
        return blob.arrayBuffer()
      })()
    : await (await fetch(url)).arrayBuffer()

  // Embedded textures become data URIs before the parser sees them — it
  // would otherwise turn each into a blob: URL, and those do not survive
  // in this runtime, leaving the model flat grey. See glbInlineTextures.
  const gltf = await loader.parseAsync(inlineGlbTextures(buf), '')
  return { source: gltf.scene, refCount: 0 }
}

/** Load (or reuse) the model at `url` and return a fresh instance the
 *  caller owns. Call releaseModel(url) when done with it. */
export async function acquireModel(url: string): Promise<THREE.Object3D> {
  let entry = cache.get(url)
  if (!entry) {
    let p = pending.get(url)
    if (!p) {
      p = loadEntry(url).finally(() => pending.delete(url))
      pending.set(url, p)
    }
    entry = await p
    // Another awaiter may have populated the cache first — reuse theirs.
    const existing = cache.get(url)
    if (existing) entry = existing
    else cache.set(url, entry)
  }
  // Resurrect from LRU if it was parked there.
  const li = lru.indexOf(url)
  if (li >= 0) lru.splice(li, 1)
  entry.refCount++
  return SkeletonUtils.clone(entry.source)
}

/** Drop one reference. Zero-ref entries park in the LRU; overflow disposes. */
export function releaseModel(url: string): void {
  const entry = cache.get(url)
  if (!entry) return
  entry.refCount = Math.max(0, entry.refCount - 1)
  if (entry.refCount === 0) {
    lru.push(url)
    while (lru.length > LRU_MAX) {
      const evict = lru.shift()!
      const e = cache.get(evict)
      if (e && e.refCount === 0) {
        disposeObject(e.source)
        cache.delete(evict)
      }
    }
  }
}

/** Fully dispose a cloned instance returned by acquireModel. Clones share
 *  geometry/materials with the cached source, so instance disposal only
 *  detaches — real GPU disposal happens at LRU eviction. */
export function disposeInstance(root: THREE.Object3D): void {
  root.removeFromParent()
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse(obj => {
    const mesh = obj as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach(disposeMaterial)
    else if (mat) disposeMaterial(mat)
  })
}

function disposeMaterial(mat: THREE.Material): void {
  for (const value of Object.values(mat)) {
    if (value instanceof THREE.Texture) value.dispose()
  }
  mat.dispose()
}
