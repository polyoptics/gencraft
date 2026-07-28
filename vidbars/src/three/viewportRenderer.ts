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
import { useViewport3DStore } from '../store/viewport3dStore'
import { acquireModel, releaseModel, disposeInstance } from './modelCache'
import { applyOrbit, frameModel, dollyBounds, type OrbitState } from './orbitState'

/** Below this on-screen width (px) a window skips GL (frame shows poster). */
export const MIN_GL_PX = 80
const VIEWPORT_BG = 0x0d0e1a

export type ViewStatus = 'empty' | 'loading' | 'ready' | 'error'

export interface ViewRuntime {
  id: string
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  orbit: OrbitState
  dollyMin: number
  dollyMax: number
  modelUrl: string | null       // raw ref currently loaded/loading
  modelRoot: THREE.Object3D | null
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
let resizeObserver: ResizeObserver | null = null
const unsubscribers: Array<() => void> = []
const views = new Map<string, ViewRuntime>()

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
    const sh = win.height * (win.pin ? win.pin.scale : zoom)
    if (sx + sw < 0 || sy + sh < 0 || sx > W || sy > H) continue   // offscreen
    if (sw < MIN_GL_PX) continue                                    // poster takes over
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

    view.camera.aspect = sw / sh
    applyOrbit(view.camera, view.orbit)
    view.camera.updateProjectionMatrix()
    target.render(view.scene, view.camera)

    if (!view.hasRenderedOnce) {
      view.hasRenderedOnce = true
      notifyStatus(win.id)
    }
  }
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

function destroyView(id: string): void {
  const view = views.get(id)
  if (!view) return
  if (view.modelRoot) disposeInstance(view.modelRoot)
  if (view.modelUrl) releaseModel(view.modelUrl)
  views.delete(id)
  notifyStatus(id)
}

async function loadModelIntoView(view: ViewRuntime, url: string, savedCamera: OrbitState | undefined): Promise<void> {
  const seq = ++view.loadSeq
  // Drop the previous model
  if (view.modelRoot) { disposeInstance(view.modelRoot); view.modelRoot = null }
  if (view.modelUrl) { releaseModel(view.modelUrl); view.modelUrl = null }
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
    view.scene.add(root)
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
        if (view.modelRoot) { disposeInstance(view.modelRoot); view.modelRoot = null }
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
