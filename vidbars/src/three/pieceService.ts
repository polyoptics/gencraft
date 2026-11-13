// pieceService.ts — a model's shape as a small picture, for its piece in
// the flat view (Brian 2026-11-12: a 3D set's models seen from above, as
// pieces on a war map; utils/scenePieces, components/Canvas/PieceLayer).
//
// The picture is the model in plain clay on nothing, lit from the eye (so
// it reads the same however the piece is turned on the canvas), its lower
// parts a little darker: the piece's colour goes over it where it is
// drawn. It is taken from one fixed side: `q` turns the model, about the
// middle of its box and stretched as it is, into the picture (x right, y
// up, z to the eye). It comes cropped to the model, with where the model's
// middle fell in it, so a piece is laid to scale on the spot it stands on.
//
// Drawn once and kept, as a model's poster is (three/posterService): a
// `data:` URL in a small persisted map, with what the model measures, so
// the flat view lays its pieces out without loading a model. Taken on the
// 3D view's own renderer (tiltScene lend), in the geometry it draws: a
// model standing there is not loaded into a renderer a second time. One
// at a time.

import * as THREE from 'three'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'
import { acquireModel, releaseModel, disposeInstance } from './modelCache'
import { computePosedBounds } from './orbitState'
import { createLook, applyLook, disposeLook, type LookInstance } from './modelLook'
import { models } from '../components/Canvas/tilt/TiltModels'

export type Quat = [number, number, number, number]
export type Vec3 = [number, number, number]

/** A picture of a model's shape: `src` a PNG `data:` URL; `w` × `h` what it
 *  covers, in the model's own units; `ox`, `oy` where the model's middle
 *  is in it, 0–1 from its left and its top; `edge` the outline of what it
 *  shows (a CSS polygon in its own box), which a press on its piece goes
 *  by. */
export interface PiecePic { src: string; w: number; h: number; ox: number; oy: number; edge?: string }

interface PieceStore {
  /** By pieceKey: the model's file, the side it is seen from, its stretch. */
  pics: Record<string, PiecePic>
  /** What a model measures (its box, in its own units), by its url. */
  sizes: Record<string, Vec3>
}

export const usePieceStore = create<PieceStore>()(persist(() => ({ pics: {}, sizes: {} } as PieceStore), {
  name: 'vidbars-model-pieces',
  storage: createDebouncedIDBStorage(400),
  partialize: s => ({ pics: s.pics, sizes: s.sizes }),
  // (A picture drawn another way later: bump this, and they are all drawn again.)
  version: 1,
  migrate: () => ({ pics: {}, sizes: {} }),
}))

/** The picture's longer side, px. Drawn SS times bigger and scaled down,
 *  for smooth edges (a render target has none of its own). */
const OUT = 256
const SS = 2
/** How many pictures are kept before the ones no piece shows are let go. */
const KEEP = 160

const r3 = (v: number) => Math.round(v * 500)
/** What a picture is kept under. Turns a fifth of a degree apart, or
 *  stretches a hundredth apart, share one. */
export function pieceKey(url: string, q: Quat, stretch?: Vec3): string {
  // q and -q are the same turn: the first part that is not nought, positive.
  let sign = 1
  for (const v of [q[3], q[2], q[1], q[0]]) { const n = r3(v); if (n) { sign = n < 0 ? -1 : 1; break } }
  const st = stretch ?? [1, 1, 1]
  return `${url}|${q.map(v => r3(v * sign) || 0).join(',')}|${st.map(v => Math.round(v * 100)).join(',')}`
}

/** The stored picture, or null. */
export function getPiece(url: string, q: Quat, stretch?: Vec3): PiecePic | null {
  return usePieceStore.getState().pics[pieceKey(url, q, stretch)] ?? null
}

/** Pictures no piece shows any more are let go, oldest first, once there
 *  are more than KEEP of them. `inUse`: the keys of the ones shown. */
export function trimPieces(inUse: Set<string>): void {
  const { pics } = usePieceStore.getState()
  const keys = Object.keys(pics)
  if (keys.length <= KEEP) return
  const next = { ...pics }
  let n = keys.length
  for (const k of keys) {
    if (n <= KEEP) break
    if (!inUse.has(k)) { delete next[k]; n-- }
  }
  if (n !== keys.length) usePieceStore.setState({ pics: next })
}

const inFlight = new Map<string, Promise<PiecePic | null>>()
/** The ones that could not be drawn (a model that will not load), and
 *  when: not tried again at once. */
const failed = new Map<string, number>()
const RETRY_MS = 30000

/** Draw (or reuse) model `url`'s picture from side `q`. Resolves to it, or
 *  null when it cannot be drawn yet (no 3D view, a model that will not
 *  load): asked again later, it is tried again. */
export function ensurePiece(url: string, q: Quat, stretch?: Vec3): Promise<PiecePic | null> {
  const key = pieceKey(url, q, stretch)
  const have = usePieceStore.getState().pics[key]
  if (have) return Promise.resolve(have)
  const f = failed.get(key)
  if (f !== undefined && performance.now() - f < RETRY_MS) return Promise.resolve(null)
  let p = inFlight.get(key)
  if (!p) {
    p = queued(() => shoot(key, url, q, stretch)).then(pic => {
      if (pic) failed.delete(key); else failed.set(key, performance.now())
      return pic
    }).finally(() => inFlight.delete(key))
    inFlight.set(key, p)
  }
  return p
}

/** One at a time: a model is a heavy thing to load, and the cache keeps
 *  few of them warm (as three/posterService). */
let queue: Promise<unknown> = Promise.resolve()
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

/** The stored pictures arrive a moment after the app starts: a picture
 *  drawn before then would be drawn for nothing, and lost when they land. */
function hydrated(): Promise<void> {
  const p = usePieceStore.persist
  if (!p || p.hasHydrated()) return Promise.resolve()
  return new Promise(resolve => { const off = p.onFinishHydration(() => { off(); resolve() }) })
}

/** The 3D view's renderer is made on idle, a moment after the canvas. */
async function lender(timeoutMs = 20000) {
  const t0 = performance.now()
  while (!models.lend && performance.now() - t0 < timeoutMs) await new Promise(res => setTimeout(res, 200))
  return models.lend
}

/** Plain clay, both sides (a sheet seen from behind still shows). */
const CLAY = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side: THREE.DoubleSide })

/** Linear to sRGB: a render target is read back linear. */
const TO_SRGB = new Uint8Array(256)
for (let i = 0; i < 256; i++) {
  const l = i / 255
  const s = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055
  TO_SRGB[i] = Math.round(Math.min(1, Math.max(0, s)) * 255)
}

/** The outline of what a picture shows: the tightest shape with no dents
 *  that holds it all, a pixel over, as a CSS polygon in the picture's own
 *  box. The picture is cut to the model's shape for the eye only (a mask
 *  takes no part in what a press lands on): without this, the clear
 *  corners of its box would take the presses meant for what lies under
 *  them. `EDGE_SIDES` sides: each lies along the picture, as far out as
 *  the picture goes that way. */
const EDGE_SIDES = 32
function outline(alpha: Uint8ClampedArray, w: number, h: number): string | undefined {
  // What shows, row by row: the corners of each row's first and last pixel.
  const pts: number[] = []
  for (let y = 0; y < h; y++) {
    let a = -1, b = -1
    for (let x = 0; x < w; x++) {
      if (alpha[(y * w + x) * 4 + 3] < 16) continue
      if (a < 0) a = x
      b = x
    }
    if (a >= 0) pts.push(a, y, a, y + 1, b + 1, y, b + 1, y + 1)
  }
  if (!pts.length) return undefined
  const far: number[] = [], cs: number[] = [], sn: number[] = []
  for (let i = 0; i < EDGE_SIDES; i++) {
    const t = i / EDGE_SIDES * Math.PI * 2
    cs.push(Math.cos(t)); sn.push(Math.sin(t))
    let most = -Infinity
    for (let k = 0; k < pts.length; k += 2) most = Math.max(most, pts[k] * cs[i] + pts[k + 1] * sn[i])
    far.push(most + 1)
  }
  // Its corners: where each side meets the next.
  const det = Math.sin(Math.PI * 2 / EDGE_SIDES)
  const out: string[] = []
  for (let i = 0; i < EDGE_SIDES; i++) {
    const j = (i + 1) % EDGE_SIDES
    const x = (far[i] * sn[j] - far[j] * sn[i]) / det, y = (far[j] * cs[i] - far[i] * cs[j]) / det
    out.push(`${(x / w * 100).toFixed(1)}% ${(y / h * 100).toFixed(1)}%`)
  }
  return `polygon(${out.join(', ')})`
}

async function shoot(key: string, url: string, q: Quat, stretch?: Vec3): Promise<PiecePic | null> {
  await hydrated()
  const have = usePieceStore.getState().pics[key]
  if (have) return have
  let root: THREE.Object3D | null = null
  let look: LookInstance | null = null
  let target: THREE.WebGLRenderTarget | null = null
  try {
    root = await acquireModel(url)
    // What it measures, as the 3D view measures it (tiltScene spawn).
    const box = computePosedBounds(root)
    if (box.isEmpty()) return null
    const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3())
    // In the geometry the 3D view draws (smoothed): what is loaded into
    // its renderer already serves here.
    look = createLook(root)
    applyLook(look, true, 'smooth')

    // The model about its middle, stretched along its own axes, then
    // turned to the picture (tiltScene: pose, under orient).
    const scene = new THREE.Scene()
    const turned = new THREE.Group(), grown = new THREE.Group()
    turned.quaternion.set(q[0], q[1], q[2], q[3]).normalize()
    if (stretch) grown.scale.set(stretch[0], stretch[1], stretch[2])
    root.position.set(-centre.x, -centre.y, -centre.z)
    grown.add(root); turned.add(grown); scene.add(turned)
    scene.overrideMaterial = CLAY
    scene.add(new THREE.AmbientLight(0xffffff, 1))
    const head = new THREE.DirectionalLight(0xffffff, 2)
    head.position.set(0, 0, 1)
    scene.add(head)

    // What it covers in the picture, a little over.
    const pb = computePosedBounds(turned)
    if (pb.isEmpty()) return null
    const pad = Math.max(pb.max.x - pb.min.x, pb.max.y - pb.min.y) * 0.02 + 1e-6
    const L = pb.min.x - pad, R = pb.max.x + pad, B = pb.min.y - pad, T = pb.max.y + pad
    const deep = Math.max(pb.max.z - pb.min.z, (R - L) * 0.01)
    const cam = new THREE.OrthographicCamera(L, R, T, B, deep * 0.5, deep * 2.5)
    cam.position.set(0, 0, pb.max.z + deep)
    // Its lower parts a little darker: from above, what is high and what
    // is low tell apart.
    scene.fog = new THREE.Fog(0x000000, deep, deep * 3.9)

    const long = OUT * SS, aspect = (R - L) / (T - B)
    const tw = Math.max(2, Math.round(aspect >= 1 ? long : long * aspect))
    const th = Math.max(2, Math.round(aspect >= 1 ? long / aspect : long))
    const lend = await lender()
    if (!lend) return null
    const pixels = lend(renderer => {
      target = new THREE.WebGLRenderTarget(tw, th)
      renderer.setScissorTest(false)
      renderer.setRenderTarget(target)
      renderer.setClearColor(0x000000, 0)
      renderer.clear()
      renderer.render(scene, cam)
      const px = new Uint8Array(tw * th * 4)
      renderer.readRenderTargetPixels(target, 0, 0, tw, th, px)
      return px
    })

    // Cropped to the model (rows come bottom-up), a pixel or two to spare.
    let x0 = tw, y0 = th, x1 = -1, y1 = -1
    for (let y = 0; y < th; y++) {
      const row = y * tw * 4
      for (let x = 0; x < tw; x++) {
        if (pixels[row + x * 4 + 3] < 8) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    if (x1 < x0) return null
    x0 = Math.max(0, x0 - SS); y0 = Math.max(0, y0 - SS); x1 = Math.min(tw - 1, x1 + SS); y1 = Math.min(th - 1, y1 + SS)
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1
    const big = document.createElement('canvas')
    big.width = cw; big.height = ch
    const bctx = big.getContext('2d')!
    const img = bctx.createImageData(cw, ch)
    for (let y = 0; y < ch; y++) {
      const src = ((y1 - y) * tw + x0) * 4, dst = y * cw * 4
      for (let x = 0; x < cw * 4; x += 4) {
        img.data[dst + x] = TO_SRGB[pixels[src + x]]
        img.data[dst + x + 1] = TO_SRGB[pixels[src + x + 1]]
        img.data[dst + x + 2] = TO_SRGB[pixels[src + x + 2]]
        img.data[dst + x + 3] = pixels[src + x + 3]
      }
    }
    bctx.putImageData(img, 0, 0)
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(cw / SS)); out.height = Math.max(1, Math.round(ch / SS))
    const octx = out.getContext('2d')!
    octx.imageSmoothingEnabled = true
    octx.imageSmoothingQuality = 'high'
    octx.drawImage(big, 0, 0, cw, ch, 0, 0, out.width, out.height)
    // A `data:` URL: generated media is unreadable as a blob here.
    const src = out.toDataURL('image/png')
    if (!src || src.length < 32) return null

    // The crop in the model's units, and its middle (the picture's 0, 0) in it.
    const ux = (R - L) / tw, uy = (T - B) / th
    const left = L + x0 * ux, top = B + (y1 + 1) * uy
    const w = cw * ux, h = ch * uy
    const edge = outline(octx.getImageData(0, 0, out.width, out.height).data, out.width, out.height)
    const pic: PiecePic = { src, w, h, ox: -left / w, oy: top / h, ...(edge ? { edge } : {}) }
    usePieceStore.setState(s => ({ pics: { ...s.pics, [key]: pic }, sizes: { ...s.sizes, [url]: [size.x, size.y, size.z] } }))
    return pic
  } catch (err) {
    console.warn('[pieceService] no picture for', url, err)
    return null
  } finally {
    if (target) (target as THREE.WebGLRenderTarget).dispose()
    if (look) disposeLook(look)
    if (root) { root.removeFromParent(); disposeInstance(root); releaseModel(url) }
  }
}
