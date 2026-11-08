// modelCache.ts — GLTF/GLB + FBX loading, caching, and disposal.
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
//
// Animation clips are normalised onto `source.animations` for BOTH formats
// (glTF hangs them off the parse result rather than the scene) and copied
// onto each instance, since SkeletonUtils.clone does not carry them.
//
// FBX caveat: a binary FBX with EMBEDDED textures has them unpacked into
// blob: URLs by FBXLoader, and blob bytes are unreadable in this runtime —
// the same failure that made GLB textures grey. GLB is pre-processed to
// dodge that (see glbInlineTextures); the FBX container is not, so an
// embedded-texture FBX will load geometry, rig and animation correctly but
// render untextured.

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
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

import { withDataUrlTextures } from './fbxDataTextures'
import { isPrimitiveUrl, makePrimitive } from './primitives'

const loader = new GLTFLoader(manager)
const fbxLoader = new FBXLoader(manager)

/** FBX detection. Binary FBX starts with "Kaydara FBX Binary"; the ASCII
 *  variant is a text file whose header mentions FBX. Extension first
 *  because it is cheap and right almost always, magic bytes as the
 *  fallback for `mediaref:` urls that carry no filename. */
function isFbx(url: string, buf: ArrayBuffer): boolean {
  if (/\.fbx(\?|$)/i.test(url)) return true
  if (buf.byteLength < 24) return false
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, 24))
  return head.startsWith('Kaydara FBX Binary') || /^;\s*FBX|FBXHeaderExtension/.test(head)
}

async function loadEntry(url: string): Promise<CacheEntry> {
  // A primitive (three/primitives) is made, not loaded.
  if (isPrimitiveUrl(url)) return { source: makePrimitive(url), refCount: 0 }
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

  if (isFbx(url, buf)) {
    // FBXLoader.parse is synchronous and takes the raw buffer. Its second
    // argument is the resource path for EXTERNAL textures; '' because we
    // only have the file itself.
    // Embedded FBX textures would become blob: urls, which do not survive
    // here — the texture ends up with no image and the model renders
    // untextured. withDataUrlTextures redirects them to data: urls for the
    // duration of the (synchronous) parse. See fbxDataTextures.
    const group = withDataUrlTextures(() => fbxLoader.parse(buf, ''))
    // Animation clips live on the group for FBX. Keep them on `source` so
    // clones can carry them (SkeletonUtils.clone does not copy them).
    return { source: group as unknown as THREE.Group, refCount: 0 }
  }

  // Embedded textures become data URIs before the parser sees them — it
  // would otherwise turn each into a blob: URL, and those do not survive
  // in this runtime, leaving the model flat grey. See glbInlineTextures.
  const gltf = await loader.parseAsync(inlineGlbTextures(buf), '')
  // glTF hangs clips off the RESULT, not the scene; move them onto the
  // scene so every format exposes animations the same way.
  ;(gltf.scene as THREE.Object3D).animations = gltf.animations ?? []
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
  const inst = SkeletonUtils.clone(entry.source)
  // Clips are shared, read-only data — an AnimationMixer binds them to
  // whatever root it is given, so instances can safely reference the same
  // array. SkeletonUtils.clone does not carry them across.
  inst.animations = entry.source.animations ?? []
  return inst
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
