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
import { putMedia } from '../utils/mediaStore'
import { makeMediaRef } from '../utils/mediaRef'
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
  version: 0,
}))

/** Sync lookup — a `mediaref:` (resolvable via useResolvedMedia) or null. */
export function getModelPoster(modelUrl: string): string | null {
  return usePosterMapStore.getState().map[modelUrl] ?? null
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

async function generatePoster(modelUrl: string): Promise<string | null> {
  const renderer = getSharedRenderer()
  if (!renderer) return null
  let root: THREE.Object3D | null = null
  let target: THREE.WebGLRenderTarget | null = null
  try {
    root = await acquireModel(modelUrl)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0d0e1a)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.2))
    const dir = new THREE.DirectionalLight(0xffffff, 1.5)
    dir.position.set(3, 5, 4)
    scene.add(dir)
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

    // GL rows are bottom-up — flip into a 2D canvas.
    const cnv = document.createElement('canvas')
    cnv.width = POSTER_W; cnv.height = POSTER_H
    const ctx = cnv.getContext('2d')!
    const img = ctx.createImageData(POSTER_W, POSTER_H)
    const rowBytes = POSTER_W * 4
    for (let y = 0; y < POSTER_H; y++) {
      const src = (POSTER_H - 1 - y) * rowBytes
      img.data.set(pixels.subarray(src, src + rowBytes), y * rowBytes)
    }
    ctx.putImageData(img, 0, 0)
    const blob = await new Promise<Blob | null>(res => cnv.toBlob(res, 'image/png'))
    if (!blob) return null

    const id = await putMedia(blob)
    const ref = makeMediaRef(id)
    usePosterMapStore.getState().setPoster(modelUrl, ref)
    return ref
  } catch (err) {
    console.warn('[posterService] generation failed for', modelUrl, err)
    return null
  } finally {
    if (target) target.dispose()
    if (root) { disposeInstance(root); releaseModel(modelUrl) }
  }
}
