// posterService.ts — static poster thumbnails for 3D models.
//
// Tiles, bars, and zoomed-out viewport windows need an <img>-able preview
// of a model without paying live-GL cost. This service renders a model
// once (offscreen, via the shared renderer — no window required), stores
// the PNG in the media blob store, and remembers `modelUrl → mediaref:`
// in a tiny persisted map so every surface showing the same model shares
// one poster. Consumers either read the map (getModelPoster / the
// useModelPoster hook) or call ensureModelPoster to generate on demand.

import * as THREE from 'three'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'
import { acquireModel, releaseModel, disposeInstance } from './modelCache'
import { applyOrbit, frameModel } from './orbitState'
import { getSharedRenderer } from './viewportRenderer'

const POSTER_W = 512
const POSTER_H = 384

interface PosterMapStore {
  map: Record<string, string>   // model url (raw ref) → poster 'mediaref:'
  setPoster: (modelUrl: string, posterRef: string) => void
}

export const usePosterMapStore = create<PosterMapStore>()(persist((set) => ({
  map: {},
  setPoster: (modelUrl, posterRef) =>
    set(s => ({ map: { ...s.map, [modelUrl]: posterRef } })),
}), {
  name: 'vidbars-model-posters',
  storage: createDebouncedIDBStorage(400),
  partialize: (s) => ({ map: s.map }),
  // v3: readRenderTargetPixels returns LINEAR values (three's sRGB output
  // encoding only applies to the canvas framebuffer), so earlier posters
  // were written linear → displayed dark. Drop them all; regeneration now
  // sRGB-encodes the readback (+ brighter rig). (v3 not v2: an HMR race
  // during development persisted stale entries under version 2.)
  // v4: posters are now self-contained `data:` URLs rather than
  // `mediaref:` pointers into the blob store — see generatePosterNow.
  // Every v3 entry points at blob bytes that this runtime cannot read
  // back, so they render as nothing; drop them and regenerate.
  version: 4,
  migrate: () => ({ map: {} }),
}))

/** Sync lookup — a `mediaref:` (resolvable via useResolvedMedia) or null. */
export function getModelPoster(modelUrl: string): string | null {
  return usePosterMapStore.getState().map[modelUrl] ?? null
}

/** Forget a poster so the next ensureModelPoster REGENERATES it. Needed
 *  when a stored `mediaref:` no longer resolves — e.g. a template or
 *  project load restores node records (which carry posterUrl) without the
 *  poster blobs, leaving every model pointing at an image that is gone. */
export function invalidateModelPoster(modelUrl: string): void {
  const map = usePosterMapStore.getState().map
  if (!(modelUrl in map)) return
  const next = { ...map }
  delete next[modelUrl]
  usePosterMapStore.setState({ map: next })
}

/** Follow model-url renames (old url → new url) so existing posters
 *  survive instead of regenerating. Used by the media localization sweep,
 *  which rewrites '/uploads/x.glb' style urls to 'mediaref:' pointers. */
export async function rekeyModelPosters(renames: Map<string, string>): Promise<void> {
  // The sweep can finish before this store's async rehydration lands —
  // wait for it, or the re-key would see an empty map and orphan entries.
  const p = usePosterMapStore.persist
  if (p && !p.hasHydrated()) {
    await new Promise<void>(resolve => {
      const unsub = p.onFinishHydration(() => { unsub(); resolve() })
    })
  }
  const { map } = usePosterMapStore.getState()
  let changed = false
  const next: Record<string, string> = { ...map }
  for (const [oldUrl, newUrl] of renames) {
    const poster = next[oldUrl]
    if (poster === undefined) continue
    delete next[oldUrl]
    if (next[newUrl] === undefined) next[newUrl] = poster
    changed = true
  }
  if (changed) usePosterMapStore.setState({ map: next })
}

/** React hook: the poster ref for a model url (reactive to generation). */
export function useModelPoster(modelUrl: string | null): string | null {
  return usePosterMapStore(s => (modelUrl ? s.map[modelUrl] ?? null : null))
}

// De-dupe concurrent generation per model url.
const inFlight = new Map<string, Promise<string | null>>()

/** Generate (or reuse) the poster for `modelUrl`. Resolves to the poster
 *  `mediaref:` or null when generation isn't possible yet (no renderer
 *  mounted / load failure) — callers just try again later. */
export function ensureModelPoster(modelUrl: string): Promise<string | null> {
  const existing = getModelPoster(modelUrl)
  if (existing) return Promise.resolve(existing)
  let p = inFlight.get(modelUrl)
  if (!p) {
    p = generatePoster(modelUrl).finally(() => inFlight.delete(modelUrl))
    inFlight.set(modelUrl, p)
  }
  return p
}

/** Draw model `modelUrl`'s poster again, over the one it has (it has been
 *  squared up another way: three/modelQuarter). The old one shows until
 *  the new one is made. */
export function redrawModelPoster(modelUrl: string): Promise<string | null> {
  return generatePoster(modelUrl)
}

/** Generation needs the shared renderer, which is attached by the GL host
 *  on mount. A tile can easily ask BEFORE that lands — on a fresh load, or
 *  right after a batch import — and the old code just returned null with
 *  no log. Nothing retried, because the only caller is an effect whose
 *  deps have not changed, so that model had no poster for the rest of the
 *  session. That is exactly "some of them came in with thumbnails and the
 *  rest never did". Wait for the renderer instead of giving up. */
async function waitForRenderer(timeoutMs = 20000): Promise<THREE.WebGLRenderer | null> {
  const t0 = performance.now()
  let r = getSharedRenderer()
  while (!r && performance.now() - t0 < timeoutMs) {
    await new Promise(res => setTimeout(res, 200))
    r = getSharedRenderer()
  }
  return r
}

/** One poster at a time. These are 10-20MB GLBs: eight parsed and
 *  uploaded to the GPU at once is a lot of transient memory for something
 *  with no deadline, and the model cache only keeps 6 entries warm, so a
 *  concurrent burst evicts the very entries it is loading. */
let queue: Promise<unknown> = Promise.resolve()

async function generatePoster(modelUrl: string): Promise<string | null> {
  const run = queue.then(() => generatePosterNow(modelUrl), () => generatePosterNow(modelUrl))
  queue = run.catch(() => {})
  return run
}

async function generatePosterNow(modelUrl: string): Promise<string | null> {
  const renderer = await waitForRenderer()
  if (!renderer) {
    console.warn('[posterService] no renderer available for', modelUrl)
    return null
  }
  let root: THREE.Object3D | null = null
  let target: THREE.WebGLRenderTarget | null = null
  try {
    root = await acquireModel(modelUrl)

    // Poster rig is deliberately BRIGHTER than the live viewport — at tile
    // size a dim render reads as murky.
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x232738)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x555577, 2.0))
    const dir = new THREE.DirectionalLight(0xffffff, 2.2)
    dir.position.set(3, 5, 4)
    scene.add(dir)
    const fill = new THREE.DirectionalLight(0xaaccff, 0.8)
    fill.position.set(-4, 2, -3)
    scene.add(fill)
    scene.add(root)

    const camera = new THREE.PerspectiveCamera(50, POSTER_W / POSTER_H, 0.1, 100)
    const framed = frameModel(root, camera.fov)
    camera.near = framed.near
    camera.far = framed.far
    applyOrbit(camera, framed.orbit)
    camera.updateProjectionMatrix()

    target = new THREE.WebGLRenderTarget(POSTER_W, POSTER_H)
    const prevTarget = renderer.getRenderTarget()
    const prevScissor = renderer.getScissorTest()
    renderer.setScissorTest(false)
    renderer.setRenderTarget(target)
    renderer.clear()
    renderer.render(scene, camera)
    const pixels = new Uint8Array(POSTER_W * POSTER_H * 4)
    renderer.readRenderTargetPixels(target, 0, 0, POSTER_W, POSTER_H, pixels)
    renderer.setRenderTarget(prevTarget)
    renderer.setScissorTest(prevScissor)

    // Render-target readback is LINEAR (three applies sRGB output encoding
    // only to the canvas framebuffer) — encode to sRGB or the PNG displays
    // dark. 256-entry LUT, then flip rows (GL is bottom-up) into a canvas.
    const toSRGB = new Uint8Array(256)
    for (let i = 0; i < 256; i++) {
      const l = i / 255
      const s = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055
      toSRGB[i] = Math.round(Math.min(1, Math.max(0, s)) * 255)
    }
    const cnv = document.createElement('canvas')
    cnv.width = POSTER_W; cnv.height = POSTER_H
    const ctx = cnv.getContext('2d')!
    const img = ctx.createImageData(POSTER_W, POSTER_H)
    const rowBytes = POSTER_W * 4
    for (let y = 0; y < POSTER_H; y++) {
      const src = (POSTER_H - 1 - y) * rowBytes
      const dst = y * rowBytes
      for (let x = 0; x < rowBytes; x += 4) {
        img.data[dst + x] = toSRGB[pixels[src + x]]
        img.data[dst + x + 1] = toSRGB[pixels[src + x + 1]]
        img.data[dst + x + 2] = toSRGB[pixels[src + x + 2]]
        img.data[dst + x + 3] = pixels[src + x + 3]
      }
    }
    ctx.putImageData(img, 0, 0)

    // A DATA URL, not a Blob in the media store.
    //
    // The poster is small (tens of KB) and it is the ONE piece of media
    // this app manufactures rather than receives, so it can be kept as a
    // self-contained string. That matters because a `blob:` URL is a
    // pointer to bytes the browser stores separately, and in this runtime
    // those bytes come back unreadable once they are more than a few
    // hundred bytes: FileReader throws, arrayBuffer() throws
    // NotReadableError, and an <img> pointed at the object URL decodes to
    // 0x0. The poster was being generated and stored perfectly and then
    // rendering as nothing.
    //
    // A data: URL carries the bytes inline, so there is nothing to fetch
    // and nothing to lose. useResolvedMedia passes non-mediaref strings
    // through untouched, so every existing consumer works unchanged.
    const dataUrl = cnv.toDataURL('image/png')
    if (!dataUrl || dataUrl.length < 32) return null

    usePosterMapStore.getState().setPoster(modelUrl, dataUrl)
    return dataUrl
  } catch (err) {
    console.warn('[posterService] generation failed for', modelUrl, err)
    return null
  } finally {
    if (target) target.dispose()
    if (root) { disposeInstance(root); releaseModel(modelUrl) }
  }
}
