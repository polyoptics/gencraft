// viewportRenderer.ts — ONE shared WebGLRenderer for all 3D viewport
// windows, rendered per-window via scissor/viewport rects.
//
// Why shared: browsers cap live WebGL contexts (~8-16, oldest silently
// killed), and a per-window <canvas> inside the world's `scale(zoom)`
// transform would rasterize at layout size then CSS-scale (blurry when
// zoomed in). The shared canvas lives in SCREEN space (absolute inset:0,
// pointer-events:none) painted UNDER the world transform container, so
// every window is pixel-crisp at any zoom and GL pixels sit below all
// canvas-space content. Window screen rects are computed analytically
// from store values (pan + x*zoom) — no getBoundingClientRect.
//
// Lifecycle is render-on-demand: a dirty flag + at most one pending rAF,
// kicked by store subscriptions (pan/zoom, window records) and input
// handlers. Idle = zero GPU work. The view registry is keyed by window id
// and synced FROM the store, decoupled from React mounts — zoom-layer
// remounts never touch GL state.

import * as THREE from 'three'
import { useCanvasStore } from '../store/canvasStore'
import { useViewport3DStore, type ViewportWindow3D } from '../store/viewport3dStore'
import { acquireModel, releaseModel, disposeInstance } from './modelCache'
import { applyOrbit, frameModel, dollyBounds, type OrbitState } from './orbitState'
import { DEFAULT_LOOK, createLook, applyLook, disposeLook, type LookInstance } from './modelLook'

/** Below this on-screen width (px) a window skips GL (frame shows poster). */
export const MIN_GL_PX = 80
const VIEWPORT_BG = 0x0d0e1a

export type ViewStatus = 'empty' | 'loading' | 'ready' | 'error'

export interface ViewRuntime {
  id: string
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /** Animation, when the loaded model brought clips with it. The mixer is
   *  created on load and ticked by the render loop while playing — which
   *  is also what switches the loop from render-on-demand to continuous
   *  (see renderFrame). */
  mixer?: THREE.AnimationMixer
  clips?: THREE.AnimationClip[]
  action?: THREE.AnimationAction
  clipIndex?: number
  playing?: boolean
  orbit: OrbitState
  dollyMin: number
  dollyMax: number
  modelUrl: string | null       // raw ref currently loaded/loading
  modelRoot: THREE.Object3D | null
  look?: LookInstance
  status: ViewStatus
  errorMsg?: string
  hasRenderedOnce: boolean
  loadSeq: number               // guards stale async loads
}

// ── Module state ──
let renderer: THREE.WebGLRenderer | null = null
/** Second context for SCREEN-PINNED windows — see renderFrame. */
let pinRenderer: THREE.WebGLRenderer | null = null
let container: HTMLElement | null = null
let containerW = 0
let containerH = 0
let rafHandle: number | null = null
/** Timestamp of the last animated frame; 0 when nothing is playing. */
let lastFrameMs = 0
let resizeObserver: ResizeObserver | null = null
const unsubscribers: Array<() => void> = []
const views = new Map<string, ViewRuntime>()
/** Screen px at the bottom of each window's body taken by its footer (the
 *  switcher strip). The GL rect stops above it, so a model is framed in the
 *  work area instead of drawing behind the footer. */
const footerInsets = new Map<string, number>()

/** Windows whose GL body is not drawn: a Viewer stood up off the plane
 *  (console mode's screen) leaves its flat footprint, where its model
 *  would otherwise go on being drawn. */
const glHidden = new Set<string>()
export function setGlHidden(ids: Iterable<string>): void {
  glHidden.clear()
  for (const id of ids) glHidden.add(id)
  requestRender()
}

export function setViewFooterInset(id: string, px: number): void {
  if ((footerInsets.get(id) ?? 0) === px) return
  if (px > 0) footerInsets.set(id, px); else footerInsets.delete(id)
  requestRender()
}

// ── Display look ── see modelLook.ts. Grey and the wire are applied as
// scene.overrideMaterial; texture and shading on this view's own materials.
const WIREFRAME_MAT = new THREE.MeshBasicMaterial({
  color: 0x9fd0ff, wireframe: true, transparent: true, opacity: 0.85,
})
const WIRE_OVER_MAT = new THREE.MeshBasicMaterial({
  color: 0x9fd0ff, wireframe: true, transparent: true, opacity: 0.2,
  depthFunc: THREE.LessEqualDepth, depthWrite: false,
})
const GRAY_MAT = new THREE.MeshStandardMaterial({
  color: 0xc8ccd8, roughness: 0.75, metalness: 0.0,
})
const GRAY_FLAT_MAT = new THREE.MeshStandardMaterial({
  color: 0xc8ccd8, roughness: 0.75, metalness: 0.0, flatShading: true,
})

export interface ModelStats {
  vertices: number
  triangles: number
  meshes: number
  materials: number
  textures: number
  bones: number
  animations: number
}
const statsByView = new Map<string, ModelStats>()

export function getModelStats(id: string): ModelStats | undefined {
  return statsByView.get(id)
}

function computeStats(root: THREE.Object3D, animations: number): ModelStats {
  let vertices = 0, triangles = 0, meshes = 0, bones = 0
  const mats = new Set<unknown>()
  const texes = new Set<unknown>()
  root.traverse(o => {
    const b = o as THREE.Bone
    if (b.isBone) bones++
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.geometry) return
    meshes++
    const pos = m.geometry.attributes?.position
    if (pos) vertices += pos.count
    triangles += m.geometry.index ? m.geometry.index.count / 3 : (pos ? pos.count / 3 : 0)
    for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) {
      if (!mat) continue
      mats.add(mat)
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'] as const) {
        const t = (mat as unknown as Record<string, unknown>)[k]
        if (t) texes.add(t)
      }
    }
  })
  return {
    vertices, triangles: Math.round(triangles), meshes,
    materials: mats.size, textures: texes.size, bones, animations,
  }
}

/** Skeleton helpers are created lazily, one per view, and only while the
 *  skin is hidden — there is nothing to look at otherwise. */
const skeletons = new Map<string, THREE.SkeletonHelper>()

function applyDisplayMode(id: string, view: ViewRuntime, win: ViewportWindow3D): void {
  const { texture, shade } = win.look ?? DEFAULT_LOOK
  if (view.look) applyLook(view.look, texture, shade)

  const skinVisible = win.showSkin !== false
  let hasSkinned = false
  view.modelRoot?.traverse(o => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) { hasSkinned = true; o.visible = skinVisible }
  })

  let helper = skeletons.get(id)
  if (!skinVisible && hasSkinned && view.modelRoot && !helper) {
    helper = new THREE.SkeletonHelper(view.modelRoot)
    // Drawn on top of everything so bones inside a body are still readable.
    // (The grey and wire overrides also apply to these lines; they stay
    // legible, just in the override's colour.)
    ;(helper.material as THREE.LineBasicMaterial).depthTest = false
    helper.renderOrder = 999
    skeletons.set(id, helper)
    view.scene.add(helper)
  }
  if (helper) helper.visible = !skinVisible
}

/** Draw a view: the surface, then the wire over it. The caller has cleared
 *  and set the target, and autoClear is off, so the wire keeps the depth. */
function renderLook(target: THREE.WebGLRenderer, view: ViewRuntime, win: ViewportWindow3D | undefined): void {
  const { texture, shade, wire } = win?.look ?? DEFAULT_LOOK
  const surface = texture || shade !== null
  const root = view.modelRoot
  // Hidden rather than skipped, so a skeleton still draws over a hollow model.
  if (root) root.visible = surface
  view.scene.overrideMaterial = texture ? null : shade === 'flat' ? GRAY_FLAT_MAT : GRAY_MAT
  target.render(view.scene, view.camera)
  if (root) root.visible = true
  if (wire) {
    view.scene.overrideMaterial = surface ? WIRE_OVER_MAT : WIREFRAME_MAT
    target.render(view.scene, view.camera)
  }
  view.scene.overrideMaterial = null
}

/** Take the model out of a view, with its look. */
function dropModelRoot(view: ViewRuntime): void {
  if (view.look) { disposeLook(view.look); view.look = undefined }
  if (view.modelRoot) { disposeInstance(view.modelRoot); view.modelRoot = null }
}

// ── Status pub/sub (for useViewStatus — mirrors useResolvedMedia's pattern) ──
type StatusSnapshot = { status: ViewStatus; hasRenderedOnce: boolean; errorMsg?: string }
const statusListeners = new Map<string, Set<() => void>>()
const statusSnapshots = new Map<string, StatusSnapshot>()
const EMPTY_STATUS: StatusSnapshot = { status: 'empty', hasRenderedOnce: false }

function notifyStatus(id: string): void {
  const v = views.get(id)
  statusSnapshots.set(id, v
    ? { status: v.status, hasRenderedOnce: v.hasRenderedOnce, errorMsg: v.errorMsg }
    : EMPTY_STATUS)
  statusListeners.get(id)?.forEach(cb => cb())
}

export function subscribeViewStatus(id: string, cb: () => void): () => void {
  let set = statusListeners.get(id)
  if (!set) { set = new Set(); statusListeners.set(id, set) }
  set.add(cb)
  return () => { set!.delete(cb) }
}

export function getViewStatusSnapshot(id: string): StatusSnapshot {
  return statusSnapshots.get(id) ?? EMPTY_STATUS
}

export function getViewRuntime(id: string): ViewRuntime | undefined {
  return views.get(id)
}

// ── Render scheduling ──
export function requestRender(): void {
  if (rafHandle !== null || !renderer) return
  if (document.visibilityState === 'hidden') return
  rafHandle = requestAnimationFrame(renderFrame)
}

function renderFrame(): void {
  rafHandle = null
  if (!renderer) return
  const { pan, zoom } = useCanvasStore.getState()
  const wins = useViewport3DStore.getState().windows
  const W = containerW, H = containerH
  if (W === 0 || H === 0) return

  // Advance any playing animation. This is the ONE thing that makes the
  // loop continuous instead of render-on-demand: while a clip is playing
  // we re-arm every frame, and stop the moment nothing is playing so idle
  // still costs zero GPU.
  const now = performance.now()
  const dt = lastFrameMs === 0 ? 0 : Math.min(0.1, (now - lastFrameMs) / 1000)
  lastFrameMs = now
  let anyPlaying = false
  for (const view of views.values()) {
    if (view.mixer && view.playing) { view.mixer.update(dt); anyPlaying = true }
  }
  if (!anyPlaying) lastFrameMs = 0
  let keepAnimating = false

  // Full transparent clear each frame — windows move with pan; skipping
  // this leaves ghost trails. The dot grid shows through around windows.
  renderer.setScissorTest(false)
  renderer.setClearColor(0x000000, 0)
  renderer.clear()

  // The PINNED stratum is a second canvas mounted ABOVE the world div.
  // It has to be a separate context: a canvas has one z-position, and a
  // pinned window floats over canvas content while a canvas-placed one
  // deliberately sits under it. Sharing `views` means a window keeps its
  // scene, camera and loaded model across a placement flip.
  if (pinRenderer) {
    pinRenderer.setScissorTest(false)
    pinRenderer.setClearColor(0x000000, 0)
    pinRenderer.clear()
    pinRenderer.setScissorTest(true)
  }

  renderer.setScissorTest(true)
  for (const win of Object.values(wins)) {
    // A pinned window's rect is its anchor and frozen scale; a
    // canvas-placed one projects through the live pan/zoom.
    const sx = win.pin ? win.pin.x : pan.x + win.x * zoom
    const sy = win.pin ? win.pin.y : pan.y + win.y * zoom
    const sw = win.width * (win.pin ? win.pin.scale : zoom)
    const sh = win.height * (win.pin ? win.pin.scale : zoom) - (footerInsets.get(win.id) ?? 0)
    if (sh <= 0) continue
    if (win.tuck) continue                                          // collapsed: draws nothing (utils/viewerTuck)
    if (sx + sw < 0 || sy + sh < 0 || sx > W || sy > H) continue   // offscreen
    if (sw < MIN_GL_PX) continue                                    // poster takes over
    if (glHidden.has(win.id)) continue                              // stood up (TiltLayer)
    const view = views.get(win.id)
    if (!view || view.status !== 'ready') continue
    const target = win.pin ? pinRenderer : renderer
    if (!target) continue

    // GL origin is bottom-left — flip Y. three multiplies by pixelRatio
    // internally, so pass CSS units.
    const bottom = H - (sy + sh)
    target.setViewport(sx, bottom, sw, sh)
    target.setScissor(sx, bottom, sw, sh)
    target.setClearColor(VIEWPORT_BG, 1)
    target.clear()

    applyDisplayMode(win.id, view, win)
    view.camera.aspect = sw / sh
    applyOrbit(view.camera, view.orbit)
    view.camera.updateProjectionMatrix()
    renderLook(target, view, win)

    if (!view.hasRenderedOnce) {
      view.hasRenderedOnce = true
      notifyStatus(win.id)
    }
    if (view.playing) keepAnimating = true
  }

  // Re-arm only while something is actually animating ON SCREEN — a
  // playing clip in a window scrolled out of view should not pin the loop.
  if (keepAnimating) requestRender()
}

// ── View registry sync (store-driven, not mount-driven) ──
function createView(id: string): ViewRuntime {
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.2))
  const dir = new THREE.DirectionalLight(0xffffff, 1.5)
  dir.position.set(3, 5, 4)
  scene.add(dir)
  const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100)
  const view: ViewRuntime = {
    id, scene, camera,
    orbit: { theta: Math.PI / 4, phi: Math.PI / 2.6, radius: 5, tx: 0, ty: 0, tz: 0 },
    dollyMin: 0.25, dollyMax: 50,
    modelUrl: null, modelRoot: null,
    status: 'empty', hasRenderedOnce: false, loadSeq: 0,
  }
  views.set(id, view)
  notifyStatus(id)
  return view
}

// ── Animation transport ──

export interface AnimInfo {
  clipNames: string[]
  clipIndex: number
  playing: boolean
  duration: number
}

export function getAnimInfo(id: string): AnimInfo | null {
  const view = views.get(id)
  if (!view?.clips?.length) return null
  const i = view.clipIndex ?? 0
  return {
    clipNames: view.clips.map((c, n) => c.name || `clip ${n + 1}`),
    clipIndex: i,
    playing: !!view.playing,
    duration: view.clips[i]?.duration ?? 0,
  }
}

/** Play a clip by index (or resume the current one). */
export function playClip(id: string, index?: number): void {
  const view = views.get(id)
  if (!view?.mixer || !view.clips?.length) return
  const i = Math.max(0, Math.min(view.clips.length - 1, index ?? view.clipIndex ?? 0))
  if (view.action && i !== view.clipIndex) { view.action.stop(); view.action = undefined }
  view.clipIndex = i
  if (!view.action) {
    view.action = view.mixer.clipAction(view.clips[i])
    view.action.reset()
  }
  view.action.paused = false
  view.action.play()
  view.playing = true
  lastFrameMs = 0        // don't charge the first frame for the idle gap
  requestRender()
}

export function pauseClip(id: string): void {
  const view = views.get(id)
  if (!view?.action) return
  view.action.paused = true
  view.playing = false
  requestRender()
}

export function stopClip(id: string): void {
  const view = views.get(id)
  if (!view?.mixer) return
  view.action?.stop()
  view.action = undefined
  view.playing = false
  // Return the rig to its rest pose rather than freezing mid-stride.
  view.mixer.setTime(0)
  requestRender()
}

/** Drive a rig from ANOTHER file's clips — the "drag an animation onto a
 *  model" gesture. Clips address bones by NAME, so this works whenever the
 *  two skeletons share a naming convention (Mixamo rigs generally do) and
 *  silently animates nothing when they do not. Returns how many of the
 *  clip's tracks actually found a target, so the caller can tell the user
 *  it did not take rather than leaving them staring at a still model. */
export function applyExternalClips(id: string, clips: THREE.AnimationClip[]): number {
  const view = views.get(id)
  if (!view?.modelRoot || clips.length === 0) return 0

  const names = new Set<string>()
  view.modelRoot.traverse(o => { if (o.name) names.add(o.name) })
  let matched = 0
  for (const clip of clips) {
    for (const track of clip.tracks) {
      // Track names look like "mixamorig:Hips.quaternion".
      const bone = track.name.split('.')[0]
      if (names.has(bone)) matched++
    }
  }
  if (matched === 0) return 0

  view.action?.stop()
  view.mixer?.stopAllAction()
  view.mixer = new THREE.AnimationMixer(view.modelRoot)
  view.clips = clips
  view.clipIndex = 0
  view.action = undefined
  playClip(id, 0)
  return matched
}

/** Take the clips out of ANOTHER model file and drive this window's rig
 *  with them — the "magnet an animation onto a character" gesture.
 *
 *  The donor is loaded through the normal cache (so a tile already on
 *  canvas costs nothing) purely to read its clips; its instance is
 *  released immediately, because clips are standalone data that address
 *  bones by name. Returns the number of tracks that found a bone: 0 means
 *  the two skeletons do not share a naming convention and the caller
 *  should say so rather than leave a motionless model unexplained. */
export async function applyAnimationFromUrl(id: string, donorUrl: string): Promise<number> {
  const view = views.get(id)
  if (!view?.modelRoot) return 0
  const donor = await acquireModel(donorUrl)
  try {
    const clips = donor.animations ?? []
    if (clips.length === 0) return 0
    return applyExternalClips(id, clips)
  } finally {
    disposeInstance(donor)
    releaseModel(donorUrl)
  }
}

/** Render a window's CURRENT view — its camera, its display mode — to a
 *  poster-sized data URL. This is what makes a bad auto-frame recoverable:
 *  pull back, orbit to something that reads well, and make that the
 *  thumbnail. Returns null if the view has no model ready. */
export function captureViewPoster(id: string, w = 512, h = 384): string | null {
  const view = views.get(id)
  const r = renderer ?? pinRenderer
  if (!view || !r || view.status !== 'ready') return null
  const win = useViewport3DStore.getState().windows[id]
  if (win) applyDisplayMode(id, view, win)

  const target = new THREE.WebGLRenderTarget(w, h)
  try {
    const prevTarget = r.getRenderTarget()
    const prevScissor = r.getScissorTest()
    r.setScissorTest(false)
    r.setRenderTarget(target)
    r.setClearColor(VIEWPORT_BG, 1)
    r.clear()
    const prevAspect = view.camera.aspect
    view.camera.aspect = w / h
    applyOrbit(view.camera, view.orbit)
    view.camera.updateProjectionMatrix()
    renderLook(r, view, win)
    const pixels = new Uint8Array(w * h * 4)
    r.readRenderTargetPixels(target, 0, 0, w, h, pixels)
    r.setRenderTarget(prevTarget)
    r.setScissorTest(prevScissor)
    view.camera.aspect = prevAspect
    view.camera.updateProjectionMatrix()

    // Same linear→sRGB + row flip as the poster service, and a data URL
    // for the same reason: blob bytes do not survive in this runtime.
    const toSRGB = new Uint8Array(256)
    for (let i = 0; i < 256; i++) {
      const l = i / 255
      const s = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055
      toSRGB[i] = Math.round(Math.min(1, Math.max(0, s)) * 255)
    }
    const cnv = document.createElement('canvas')
    cnv.width = w; cnv.height = h
    const ctx = cnv.getContext('2d')!
    const img = ctx.createImageData(w, h)
    const rowBytes = w * 4
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * rowBytes
      const dst = y * rowBytes
      for (let x = 0; x < rowBytes; x += 4) {
        img.data[dst + x] = toSRGB[pixels[src + x]]
        img.data[dst + x + 1] = toSRGB[pixels[src + x + 1]]
        img.data[dst + x + 2] = toSRGB[pixels[src + x + 2]]
        img.data[dst + x + 3] = pixels[src + x + 3]
      }
    }
    ctx.putImageData(img, 0, 0)
    return cnv.toDataURL('image/png')
  } finally {
    target.dispose()
    requestRender()
  }
}

function destroyView(id: string): void {
  const view = views.get(id)
  if (!view) return
  dropModelRoot(view)
  if (view.modelUrl) releaseModel(view.modelUrl)
  views.delete(id)
  notifyStatus(id)
}

async function loadModelIntoView(view: ViewRuntime, url: string, savedCamera: OrbitState | undefined): Promise<void> {
  const seq = ++view.loadSeq
  // Drop the previous model
  dropModelRoot(view)
  if (view.modelUrl) { releaseModel(view.modelUrl); view.modelUrl = null }
  const oldHelper = skeletons.get(view.id)
  if (oldHelper) { view.scene.remove(oldHelper); oldHelper.dispose?.(); skeletons.delete(view.id) }
  statsByView.delete(view.id)
  view.mixer?.stopAllAction()
  view.mixer = undefined
  view.clips = undefined
  view.action = undefined
  view.playing = false
  view.modelUrl = url
  view.status = 'loading'
  view.hasRenderedOnce = false
  notifyStatus(view.id)
  try {
    const root = await acquireModel(url)
    if (seq !== view.loadSeq) {   // superseded while loading
      disposeInstance(root)
      releaseModel(url)
      return
    }
    view.modelRoot = root
    view.look = createLook(root)
    view.scene.add(root)
    const clips = root.animations ?? []
    view.clips = clips
    view.mixer = clips.length > 0 ? new THREE.AnimationMixer(root) : undefined
    view.action = undefined
    view.clipIndex = clips.length > 0 ? 0 : undefined
    view.playing = false
    statsByView.set(view.id, computeStats(root, clips.length))
    const framed = frameModel(root, view.camera.fov)
    view.camera.near = framed.near
    view.camera.far = framed.far
    const bounds = dollyBounds(framed.orbit)
    view.dollyMin = bounds.min
    view.dollyMax = bounds.max
    view.orbit = savedCamera ? { ...savedCamera } : framed.orbit
    view.status = 'ready'
    notifyStatus(view.id)
    requestRender()
  } catch (err) {
    if (seq !== view.loadSeq) return
    releaseModel(url)
    view.modelUrl = null
    view.status = 'error'
    const msg = err instanceof Error ? err.message : String(err)
    view.errorMsg = /draco|KHR_draco/i.test(msg)
      ? 'Compressed (DRACO) GLB not supported yet'
      : msg
    notifyStatus(view.id)
  }
}

function syncViews(): void {
  const wins = useViewport3DStore.getState().windows
  // Remove views whose window is gone
  for (const id of Array.from(views.keys())) {
    if (!wins[id]) destroyView(id)
  }
  // Create/refresh views. Only MODEL actives engage GL; any other item
  // kind reads as "no model" here — the view drops to 'empty' and the
  // scissor loop skips the window (DOM content views own the body).
  for (const win of Object.values(wins)) {
    let view = views.get(win.id)
    if (!view) view = createView(win.id)
    const it = win.activeItem
    const targetUrl = it?.kind === 'media' && it.mediaType === 'model' ? it.url : null
    if (targetUrl !== view.modelUrl) {
      if (targetUrl) {
        void loadModelIntoView(view, targetUrl, win.camera)
      } else {
        ++view.loadSeq   // cancel any in-flight load
        dropModelRoot(view)
        if (view.modelUrl) { releaseModel(view.modelUrl); view.modelUrl = null }
        view.status = 'empty'
        view.hasRenderedOnce = false
        notifyStatus(win.id)
      }
    }
  }
  requestRender()
}

// ── Attach / detach ──
export function attachRenderer(canvas: HTMLCanvasElement, host: HTMLElement): () => void {
  if (renderer) detach()   // defensive: single instance
  container = host
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.autoClear = false

  const applySize = () => {
    if (!container || !renderer) return
    containerW = container.clientWidth
    containerH = container.clientHeight
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(containerW, containerH, false)   // CSS stays 100%/100%
    // The pinned stratum shares this container, so it shares its size.
    pinRenderer?.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    pinRenderer?.setSize(containerW, containerH, false)
    requestRender()
  }
  applySize()
  resizeObserver = new ResizeObserver(applySize)
  resizeObserver.observe(host)

  canvas.addEventListener('webglcontextlost', onContextLost)
  canvas.addEventListener('webglcontextrestored', onContextRestored)
  document.addEventListener('visibilitychange', onVisibility)

  unsubscribers.push(useCanvasStore.subscribe(requestRender))
  unsubscribers.push(useViewport3DStore.subscribe(syncViews))

  syncViews()   // pick up windows that hydrated before attach
  return detach
}

/** Attach the PINNED stratum's canvas. Sized from the same container as
 *  the world stratum, so both share containerW/H and one rAF loop. Safe to
 *  call before or after attachRenderer. */
export function attachPinRenderer(canvas: HTMLCanvasElement): () => void {
  pinRenderer?.dispose()
  pinRenderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
  })
  pinRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  pinRenderer.autoClear = false
  if (containerW > 0) pinRenderer.setSize(containerW, containerH, false)
  requestRender()
  return () => {
    pinRenderer?.dispose()
    pinRenderer = null
  }
}

function onContextLost(e: Event): void {
  e.preventDefault()   // signal we'll handle the restore
}
function onContextRestored(): void {
  // three re-uploads GPU resources lazily on the next render.
  requestRender()
}
function onVisibility(): void {
  if (document.visibilityState === 'visible') requestRender()
}

function detach(): void {
  if (rafHandle !== null) { cancelAnimationFrame(rafHandle); rafHandle = null }
  unsubscribers.forEach(u => u())
  unsubscribers.length = 0
  resizeObserver?.disconnect()
  resizeObserver = null
  if (renderer) {
    renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
    renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored)
  }
  document.removeEventListener('visibilitychange', onVisibility)
  for (const id of Array.from(views.keys())) destroyView(id)
  renderer?.dispose()
  renderer = null
  container = null
}

/** The shared renderer, for offscreen work (poster snapshots). Null until
 *  a GLCanvasHost has mounted. */
export function getSharedRenderer(): THREE.WebGLRenderer | null {
  return renderer
}
