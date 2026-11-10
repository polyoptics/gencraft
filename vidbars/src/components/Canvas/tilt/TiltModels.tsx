import React, { useEffect, useRef } from 'react'
import {
  useTiltStore, useModelScaleStore, isTilted, offFlat, standTilt, standRise, unprojectTilt, TILT_FAR, TILT_PERSPECTIVE,
} from '../../../store/tiltStore'
import { usePeek } from '../../../utils/peek'
import { useCanvasStore } from '../../../store/canvasStore'
import { useFreeNodeStore } from '../../../store/freeNodeStore'
import { useViewport3DStore } from '../../../store/viewport3dStore'
import { useBoardsStore } from '../../../store/boardsStore'
import { useRailUiStore } from '../../../store/railUiStore'
import { railViewerDocks, viewerRail } from '../../../utils/railViewer'
import { viewportVisualRect } from '../../../utils/viewportDocking'
import { RAIL_COLORS } from '../rail/railStyle'
import { RAIL_TRAY } from '../../../utils/rail'
import { setGlHidden } from '../../../three/viewportRenderer'
import { getMediaItems } from '../../../types/bar'
import { faceBlocks } from '../../../utils/cardGrid'
import { selectStorylinesInBox, standingStories, storyWallOf } from '../StorylineLayer'
import { create } from 'zustand'
import { createTiltScene, trianglesOf, ART_MAX, type TiltTarget, type TiltFrameState, type ManipHit, type ManipPart, type TiltSlab, type TiltArt } from '../../../three/tiltScene'
import type { PinSpot } from '../../../three/notesOverlay'
import { useNotesStore } from '../../../store/notesStore'
import { PinLabels } from '../../Notes/PinLabels'
import { sceneOf, sceneSpot, dataKey } from '../../../utils/area3dScene'
import { useUndoCoordinator } from '../../../store/undoCoordinator'
import { useManip } from '../../../store/manipStore'
/** The notes store as it stands (read each frame without a hook). */
let notesNow = useNotesStore.getState()
useNotesStore.subscribe(s => { notesNow = s })

/** Models stand up while their triangles fit this budget (Brian
 *  2026-11-09: a count of 12 left cubes out), nearest the middle first; a
 *  3D scene's own always stand. MAX_MODELS: a ceiling on the count all the
 *  same. A file not loaded yet counts as UNKNOWN_TRIS. */
const TRI_BUDGET = 3_000_000
const MAX_MODELS = 400
const UNKNOWN_TRIS = 100_000

/** What the triangle budget held back in the last frame, for the 3D bar's
 *  warning: models not stood up, and the triangles standing. */
export const useTiltStats = create<{ held: number; tris: number }>(() => ({ held: 0, tris: 0 }))

/** The 3D side, shared between the always-on TiltModels and the input in
 *  TiltedView. */
export const models: {
  /** Hit test at a client point: a model's key, `person|<key>`,
   *  `deco|<owner>` (console furniture), or null. */
  pick: ((clientX: number, clientY: number) => string | null) | null
  /** How high the last furniture pick hit it, px off the plane. */
  pickZ: (() => number) | null
  info: ((key: string) => { url: string; unit: number } | null) | null
  /** Turn a model by a drag of (dx, dy) px: its new turn, or null. */
  spin: ((key: string, dx: number, dy: number, rad: number) => boolean) | null
  /** Let go of a model being turned: it drifts back. */
  letGo: ((key: string) => void) | null
  hovered: string | null
  /** Where the cursor rests over the plane with no button down, or null. */
  at: { x: number; y: number } | null
  /** Where a client point meets model `key`'s surface, in its own space
   *  (the 3D notes tools, utils/notesTool). */
  surface: ((key: string, clientX: number, clientY: number) => { url: string; p: { x: number; y: number; z: number }; n: { x: number; y: number; z: number }; size: number } | null) | null
  /** The pins on screen this frame (three/notesOverlay), px from the 3D
   *  layer's top-left, and that layer. */
  pinSpots: (() => PinSpot[]) | null
  /** Where model `key` stands on screen, client px: the box round it and
   *  the point it stands on. null when it is not standing. */
  screenBox: ((key: string) => { x0: number; y0: number; x1: number; y1: number; foot: { x: number; y: number } } | null) | null
  /** The lift handle's spots for a model, client px (tiltScene floatSpot). */
  floatSpot: ((key: string) => { foot: { x: number; y: number }; ground: { x: number; y: number }; up: { x: number; y: number }; ax: { x: number; y: number }; ay: { x: number; y: number }; r: number } | null) | null
  /** A model's middle: flat px from the host centre, and px up (tiltScene pivotOf). */
  pivotOf: ((key: string) => { u: number; v: number; z: number; base: number } | null) | null
  /** Where a pin's label dragged to a client point sits, model space. */
  labelAt: ((key: string, through: [number, number, number], clientX: number, clientY: number) => [number, number, number] | null) | null
  /** The surface stroke under a client point (the Erase tool). */
  strokeAt: ((clientX: number, clientY: number) => { url: string; id: string } | null) | null
  modelSize: ((key: string) => number | null) | null
  /** The manipulator part of a selected model in a 3D area's scene under
   *  a client point (utils/area3dHandles). c is client px. */
  gizmoAt: ((clientX: number, clientY: number) => ManipHit | null) | null
  /** Aim a camera at a client point (tiltScene aimAt). */
  aimAt: ((key: string, clientX: number, clientY: number, rise?: boolean) => { q: [number, number, number, number]; focus: number } | null) | null
  /** A camera's lens, axes and focal point (tiltScene cameraFrame). */
  cameraFrame: ((key: string) => ReturnType<ReturnType<typeof createTiltScene>['cameraFrame']>) | null
  /** Light up a manipulator part (hovered or held), or none. */
  manipHot: ((key: string | null, part: ManipPart | null) => void) | null
  root: HTMLElement | null
} = { gizmoAt: null, manipHot: null, labelAt: null, strokeAt: null, modelSize: null, pick: null, pickZ: null, info: null, spin: null, letGo: null, hovered: null, at: null, surface: null, pinSpots: null, screenBox: null, floatSpot: null, pivotOf: null, aimAt: null, cameraFrame: null, root: null }
/** A pick that lights up under the cursor: a model or a person, not
 *  furniture. */
export const modelKey = (k: string | null | undefined) => (k && !k.startsWith('deco|') ? k : null)

/** The camera angle the 3D look fades over: the sheen, raised parts and
 *  models come in over the first FADE_TILT degrees of tipping and go over
 *  the last ones of lying back flat, so they move with the camera rather
 *  than after it, the same both ways (Brian 2026-10-30). */
const FADE_TILT = 15
/** How far the 3D look is in at this angle, 0..1, eased at both ends. */
const fadeShown = () => {
  if (useTiltStore.getState().lock3d || useManip.getState().through) return 1
  const x = Math.min(1, offFlat(useTiltStore.getState()) / FADE_TILT)
  return x * x * (3 - 2 * x)
}
/** Whether anything 3D is on screen. */
const live3d = () => isTilted(useTiltStore.getState()) || !!useManip.getState().through

/** Whether model `key` ('card:<id>' / 'node:<id>') stands on a 3D area:
 *  a scene layout, where its turn is kept (Brian 2026-11-08). */
function onArea3d(key: string): boolean {
  // On a 3D area, or docked along its side (utils/area3dScene).
  return !!sceneOf(key)
}

const frameState = (): TiltFrameState => {
  const ts = useTiltStore.getState()
  const { unitsPerMetre: scales, sizeOf, poseOf, tintOf, stretchOf, lensOf } = useModelScaleStore.getState()
  const through = useManip.getState().through
  const placedMemo = new Map<string, boolean>()
  const placed = (key: string) => { let v = placedMemo.get(key); if (v === undefined) { v = onArea3d(key); placedMemo.set(key, v) } return v }
  return {
    tilt: ts.tilt, spin: ts.spin, yaw: ts.yaw, shiftX: ts.shiftX, shiftY: ts.shiftY, glide: ts.glide, texture: ts.texture, shade: ts.shade, wire: ts.wire, light: ts.light, turn: ts.turn,
    walls: ts.walls, figure: ts.figure, hovered: models.hovered,
    selected: new Set([
      ...useFreeNodeStore.getState().selectedIds.map(id => `node:${id}`),
      ...useBoardsStore.getState().selectedGroupIds.map(id => `card:${id}`),
    ]),
    unitsFor: url => scales[url],
    sizeFor: key => sizeOf[dataKey(key)] ?? 1,
    // Turn and stretch belong to a 3D set: off one (a master card left on
    // the canvas when its set folds) a model stands as it came, never
    // taking a set's rotation (Brian 2026-11-09).
    poseFor: key => placed(key) ? poseOf[dataKey(key)] : undefined,
    tintFor: key => tintOf[dataKey(key)],
    stretchFor: key => placed(key) ? stretchOf[dataKey(key)] : undefined,
    manip: useManip.getState(),
    placed,
    slabs: live3d() ? collectSlabs(fadeShown()) : (dropLifts(), []),
    art: live3d() ? lastArt : [],
    fade: fadeShown(),
    notesOf: url => notesNow.models[url],
    lock: ts.lock3d || !!through,
    lensFor: key => lensOf[dataKey(key)],
    through,
  }
}

/** A fingerprint of everything a frame without models draws from: the
 *  camera, the view's settings, every slab and picture. Equal → the canvas
 *  already shows it. */
function frameSig(st: TiltFrameState, W: number, H: number): string {
  let h1 = 0x811c9dc5 | 0, h2 = 7
  const n = (x: number | undefined | null) => {
    const v = x === undefined || x === null ? -1234567 : Math.round(x * 64)
    h1 = Math.imul(h1 ^ v, 16777619)
    h2 = (Math.imul(h2, 31) + v) | 0
  }
  const str = (x: string | undefined | null) => {
    if (x === undefined || x === null) { n(-7); return }
    for (let i = 0; i < x.length; i++) n(x.charCodeAt(i))
    n(x.length)
  }
  const b = (x: boolean | undefined) => n(x ? 1 : 0)
  // Ratios finer than px: a 1/64 step of the wheel glide's scale is a few
  // px at the screen's edge, and the furniture stopped following the
  // cards for the tail of a tilted wheel zoom.
  const r = (x: number | undefined) => n(x === undefined ? undefined : x * 64)
  n(W); n(H); n(st.tilt); n(st.spin); n(st.yaw); n(st.shiftX); n(st.shiftY); r(st.fade)
  r(st.glide?.k); n(st.glide?.x); n(st.glide?.y)
  b(st.texture); str(String(st.shade)); b(st.wire); b(st.turn); b(st.walls); b(st.figure); str(st.hovered)
  for (const k of Object.keys(st.light).sort()) { str(k); const v = (st.light as unknown as Record<string, unknown>)[k]; if (typeof v === 'number') n(v); else str(String(v)) }
  for (const k of [...st.selected].sort()) str(k)
  n(st.slabs.length)
  for (const sl of st.slabs) {
    n(sl.u); n(sl.v); n(sl.w); n(sl.h); n(sl.r); n(sl.t); n(sl.color); n(sl.z)
    n(sl.hinge?.v); n(sl.hinge?.z); n(sl.hinge?.a)
    b(sl.cap); n(sl.ring); n(sl.rim?.w); n(sl.rim?.h); b(sl.pop); b(sl.loft); str(sl.deco); b(sl.nopick)
    str(sl.finish); n(sl.bevel); n(sl.seam)
  }
  n(st.art.length)
  for (const a of st.art) { n(a.u); n(a.v); n(a.w); n(a.h); n(a.z); n(a.hinge?.v); n(a.hinge?.z); n(a.hinge?.a) }
  return `${h1}:${h2}`
}

/** Models standing on their cards (three/tiltScene). Mounted for the whole
 *  session, not just while tilted: the 3D view is built once, when the app
 *  is idle, and the models on screen are loaded and uploaded while still
 *  flat (when the view settles, and the moment Alt goes down). The first
 *  frames of a tilt then only draw. Only the cards in view are kept — at
 *  within the triangle budget — so memory follows what is on screen. */
export const TiltModels: React.FC = () => {
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = rootRef.current!
    let view: ReturnType<typeof createTiltScene> | null = null
    let canvas: HTMLCanvasElement | null = null
    let raf = 0
    let warmTimer: ReturnType<typeof setTimeout> | null = null
    let shown = false
    /** What the last frame drawn showed (frameSig); '' = draw the next. */
    let lastSig = ''
    /** Frames the picture has stayed the same. Quiet, the page is read for
     *  it every 4th frame only, and every frame again as soon as anything
     *  is touched (a store, the page, the pointer) or animates: reading
     *  every card and strip each frame was a steady cost at rest. */
    let poked = true, calm = 0, tick = 0
    const poke = () => { poked = true }
    const animating = () => document.getAnimations?.().some(a => a.playState === 'running') ?? false

    const warm = () => {
      const W = root.clientWidth, H = root.clientHeight
      if (!view || !W || !H || live3d()) return
      view.warm(W, H, collectTargets(W, H), frameState())
    }
    const warmSoon = () => {
      if (warmTimer) clearTimeout(warmTimer)
      warmTimer = setTimeout(warm, 500)
    }
    // The page is read and the 3D layer drawn after every other animation
    // callback of the frame, just before it is painted: a ResizeObserver
    // on a 1px marker runs then. As one of the callbacks, the read came
    // before the ones that move the camera (leaving 3D with Esc, F, the
    // wheel glide) and before a zoom-zone change re-made the tiles, so the
    // furniture was drawn a frame behind the cards and, crossing a zone,
    // everything standing fell flat for a frame (hunt 2026-11-01). The
    // marker sits outside <body>, which the idle read watches, and only
    // moves while the view is in 3D or leaving it.
    const marker = document.createElement('div')
    Object.assign(marker.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', visibility: 'hidden', pointerEvents: 'none' })
    document.documentElement.appendChild(marker)
    let markerW = 1
    const post = new ResizeObserver(() => draw(performance.now()))
    post.observe(marker)
    const frame = () => {
      raf = requestAnimationFrame(frame)
      if (!view || !canvas || !(shown || live3d())) return
      markerW = 3 - markerW
      marker.style.width = markerW + 'px'
    }
    const draw = (now: number) => {
      if (!view || !canvas) return
      const live = live3d()
      if (live !== shown) {
        shown = live
        canvas.style.display = live ? 'block' : 'none'
        if (!live) dropLifts()
        lastSig = ''
      }
      if (!live) return
      tick++
      if (!poked && calm > 30 && tick % 4 && !animating()) return
      poked = false
      const W = root.clientWidth, H = root.clientHeight
      if (models.at) models.hovered = modelKey(models.pick?.(models.at.x, models.at.y))
      // The slabs first: what stands this frame (a Viewer as a screen, a
      // card's lift) is what the models stand on.
      const st = W && H ? frameState() : null
      if (st) {
        // Drawn again only when something in it changed (Brian 2026-11-01:
        // "is this too resource-expensive?"): two shadow maps and a full
        // multisampled pass every frame while nothing moved was most of the
        // 3D view's cost. Standing models animate (turn, pop, fade), so
        // with any in view every frame is drawn as before.
        const targets = collectTargets(W, H)
        const sig = targets.length ? '' : frameSig(st, W, H)
        if (!sig || sig !== lastSig) view.frame(now, W, H, targets, st)
        calm = sig && sig === lastSig ? calm + 1 : 0
        lastSig = sig
      }
      // What this pass wrote (lifts, stands) is not a change to answer.
      seen.takeRecords()
    }
    const build = () => {
      // A fresh canvas per mount: a canvas whose context was lost (cleanup
      // below) can never give a working one again, and StrictMode remounts.
      canvas = document.createElement('canvas')
      Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', display: 'none' })
      root.prepend(canvas)
      try {
        view = createTiltScene(canvas)
      } catch {
        canvas.remove(); canvas = null   // no WebGL: the plane still tilts, models stay flat
        return
      }
      const v = view
      models.pick = (clientX, clientY) => {
        const r = root.getBoundingClientRect()
        return v.pick(clientX - r.left, clientY - r.top)
      }
      models.pickZ = v.pickZ
      models.info = key => v.info(key)
      models.spin = v.spinBy
      models.letGo = key => {
        // On a 3D area the turn is kept, as part of the layout (undoable).
        if (onArea3d(key)) {
          const q = v.keepTurn(key)
          if (q) { useUndoCoordinator.getState().checkpoint(); useModelScaleStore.getState().setPose(dataKey(key), q) }
          return
        }
        v.letGo(key, useTiltStore.getState().settle)
      }
      models.screenBox = key => {
        const b = v.screenBox(key)
        if (!b) return null
        const r = root.getBoundingClientRect()
        return { x0: b.x0 + r.left, y0: b.y0 + r.top, x1: b.x1 + r.left, y1: b.y1 + r.top, foot: { x: b.foot.x + r.left, y: b.foot.y + r.top } }
      }
      models.floatSpot = key => {
        const b = v.floatSpot(key)
        if (!b) return null
        const r = root.getBoundingClientRect()
        return { ...b, foot: { x: b.foot.x + r.left, y: b.foot.y + r.top }, ground: { x: b.ground.x + r.left, y: b.ground.y + r.top } }
      }
      models.pivotOf = key => v.pivotOf(key)
      models.surface = (key, clientX, clientY) => {
        const r = root.getBoundingClientRect()
        return v.surfaceAt(key, clientX - r.left, clientY - r.top)
      }
      models.pinSpots = v.pinSpots
      models.labelAt = (key, through, clientX, clientY) => {
        const r = root.getBoundingClientRect()
        return v.labelAt(key, through, clientX - r.left, clientY - r.top)
      }
      models.strokeAt = (clientX, clientY) => {
        const r = root.getBoundingClientRect()
        return v.strokeAt(clientX - r.left, clientY - r.top)
      }
      models.modelSize = v.modelSize
      models.gizmoAt = (clientX, clientY) => {
        const r = root.getBoundingClientRect()
        const g = v.gizmoAt(clientX - r.left, clientY - r.top)
        return g && { ...g, c: { x: g.c.x + r.left, y: g.c.y + r.top } }
      }
      models.manipHot = v.manipHot
      models.aimAt = (key, clientX, clientY, rise) => {
        const r = root.getBoundingClientRect()
        return v.aimAt(key, clientX - r.left, clientY - r.top, rise)
      }
      models.cameraFrame = v.cameraFrame
      models.root = root
      warm()
      raf = requestAnimationFrame(frame)
    }
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(build, { timeout: 2500 })
      : window.setTimeout(build, 1200)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Alt' && !e.repeat) warm() }
    window.addEventListener('keydown', onKey, true)
    const unsubs = [
      useCanvasStore.subscribe(warmSoon),
      useFreeNodeStore.subscribe(warmSoon),
      useBoardsStore.subscribe(warmSoon),
      // Settle turned back on: what was left turned rolls home.
      useTiltStore.subscribe((s, p) => { if (s.settle && !p.settle) view?.settleAll() }),
      ...[useTiltStore, useCanvasStore, useFreeNodeStore, useBoardsStore, useViewport3DStore, useRailUiStore, useModelScaleStore, useNotesStore, useManip].map(s => s.subscribe(poke)),
    ]
    const pokes = ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'resize'] as const
    for (const t of pokes) window.addEventListener(t, poke, { capture: true, passive: true })
    const seen = new MutationObserver(poke)
    seen.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle as number)
      else clearTimeout(idle as ReturnType<typeof setTimeout>)
      window.removeEventListener('keydown', onKey, true)
      for (const t of pokes) window.removeEventListener(t, poke, { capture: true })
      seen.disconnect()
      unsubs.forEach(u => u())
      if (warmTimer) clearTimeout(warmTimer)
      cancelAnimationFrame(raf)
      post.disconnect(); marker.remove()
      models.pick = null; models.pickZ = null; models.info = null; models.spin = null; models.letGo = null
      models.surface = null; models.pinSpots = null; models.screenBox = null; models.floatSpot = null; models.pivotOf = null; models.labelAt = null; models.strokeAt = null; models.modelSize = null; models.gizmoAt = null; models.manipHot = null; models.aimAt = null; models.cameraFrame = null; models.root = null
      view?.dispose()
      canvas?.remove()
    }
  }, [])
  return <div ref={rootRef} style={{ position: 'absolute', inset: 0, zIndex: 850, pointerEvents: 'none' }}><PinLabels /></div>
}

// ── Model cards ──


/** Offset of `el` inside `stage`, in layout px — offsets ignore transforms,
 *  so this is where the card sits on the FLAT plane even while tilted. */
function offsetIn(el: HTMLElement, stage: HTMLElement): { x: number; y: number } | null {
  const at = offsetScaled(el, stage, false)
  return at && { x: at.x, y: at.y }
}

/** offsetIn, through plain 2D `scale(k)` boxes (origin top left) on the
 *  way, such as a Viewer's CounterScaled: `k` is the scale it is drawn at
 *  relative to the stage. And through CSS zoom (the tilted canvas, laid
 *  out at the zoom, and the boxes in it that zoom back up): each box's
 *  offsets are in its own zoom's px, so they are taken to drawn px and
 *  back to the units of the box at the top. Without `scaled`, the plain
 *  boxes' scale is left out (offsetIn). */
function offsetScaled(el: HTMLElement, stage: HTMLElement, scaled = true): { x: number; y: number; k: number } | null {
  let x = 0, y = 0, k = cssZoomOf(el), top = 1
  let e: HTMLElement | null = el
  while (e && e !== stage) {
    const c = cssZoomOf(e)
    top = c
    x += e.offsetLeft * c; y += e.offsetTop * c
    const parent = e.offsetParent as HTMLElement | null
    const m = scaled && parent && parent !== stage ? /^scale\(([\d.e+-]+)\)$/.exec(parent.style.transform) : null
    if (m && /^(0(px)?|left) (0(px)?|top)$/.test(parent!.style.transformOrigin)) { const f = parseFloat(m[1]); x *= f; y *= f; k *= f }
    e = parent
  }
  return e === stage ? { x: x / top, y: y / top, k: k / top } : null
}

/** A file's name from its url — nothing for a `mediaref:` (it has none). */
const fileName = (url: string) => /^mediaref:/.test(url) ? '' : decodeURIComponent(url.split(/[\\/]/).pop()!.split('?')[0])

/** The model a card's FRONT shows, if it is one: a closed deck shows its
 *  face card, and a card the block its face is stepped to (else its first
 *  picture block) — so flipping a deck or a card swaps the standing model.
 *  A bare block element (data-id is a board) uses that block. */
export function cardModel(id: string): { url: string; name: string } | null {
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(gr => gr.id === id)
  let bid: string | null = id
  let name = ''
  if (g) {
    // A fanned deck's face shows the member clicked in the fan (its portal),
    // so the model above it follows that click.
    const portal = g.deckState === 'fanned' ? useCanvasStore.getState().deckPortalSelections[g.id] : undefined
    const face = (g.deckState === 'stacked' && g.deckFaceCard && bs.groups.find(gr => gr.id === g.deckFaceCard))
      || (portal && bs.groups.find(gr => gr.id === portal)) || g
    const blocks = faceBlocks(face, bs.boards)
    bid = face.faceBoardId && blocks.includes(face.faceBoardId) ? face.faceBoardId
      : face.cardHeroImage ? null : blocks[0] ?? null
    name = face.name
  }
  const board = bid ? bs.boards[bid] : undefined
  for (const rid of board?.rootIds ?? []) {
    const m = getMediaItems(board!.bars[rid]?.content).find(it => it.type === 'image' || it.type === 'video' || it.type === 'model')
    if (!m) continue
    return m.type === 'model' ? { url: m.url, name: m.originalName || fileName(m.url) || name || 'Model' } : null
  }
  return null
}

/** How thick things are, as a share of their shorter side: a Viewer like
 *  a phone on a table, a tile a bit less, a card thinner, and a closed deck
 *  as thick as the cards in it. */
const THICK = { viewer: 0.05, tile: 0.03, card: 0.012, deckMax: 0.25 }
/** A free card's thickness, canvas units: card stock is card stock, so
 *  every card off a strip is as thick as every other (a card made at the
 *  widest Cards zoom, 1250 across, at THICK.card). Sized by its own sides, a
 *  big card stood higher than a small one laid over it and hid it, against
 *  the flat view's order. */
const CARD_STOCK = 15
/** How far a card stands over one painted under it that it overlaps, px:
 *  enough to keep the flat view's order, too little to see. */
const OVER = 0.1
/** The same for tiles, px. A tile's raised header has a sheen drawn a hair
 *  towards the camera (tiltScene SHEEN_MAT's polygon offset): at OVER under
 *  a tile over it, that shine still showed through it as a pale band. */
const TILE_OVER = 1
const SIDE = { viewer: 0x4a4e5c, tile: 0x7a829e, card: 0x8a93b4, tray: 0x464c60, pop: 0x6a7088, edge: 0xc4c9d8 }
/** The most slices a deck's side is built from (its cards, or bands of them). */
const DECK_SLICES = 10

/** An element's corner radius in its own px, so a slab's corners match
 *  the rounded box drawn on top of it. */
function radiusOf(el: HTMLElement): number {
  return parseFloat(el.style.borderRadius || getComputedStyle(el).borderTopLeftRadius) || 0
}

/** Every card, deck, tile and Viewer on the tilted plane, as slabs (flat px
 *  from the host centre). Read from layout offsets, which tilting does not
 *  change, so this is cheap enough for every frame. */
function collectSlabs(K = 1): TiltSlab[] {
  const out: TiltSlab[] = []
  const lifting = new Map<HTMLElement, number>()
  /** Cards on a loop strip, by group id: how high their stand-in stands. */
  const docked = new Map<string, number>()
  const host = document.querySelector<HTMLElement>('[data-tilt-stage="world"]')
  if (!host) return out
  const W = host.offsetWidth, H = host.offsetHeight
  const W_ = W, H_ = H
  /** Console decks, by strip (see consoleFurniture). */
  const decks: Deck[] = []
  /** Each loop strip's body (host px) and how high its top stands: what
   *  lies loose over a strip flat is drawn over it, so in 3D it rests on
   *  that top (see rest). */
  const crowns: { x0: number; y0: number; x1: number; y1: number; z: number }[] = []
  const restOn = (x: number, y: number, w: number, h: number) =>
    crowns.reduce((z, c) => x < c.x1 && c.x0 < x + w && y < c.y1 && c.y0 < y + h ? Math.max(z, c.z) : z, 0)
  /** Cards resting on a strip's top, by group id: the height of their face. */
  const rested = new Map<string, number>()
  restTick()
  /** `keep`: a part of a strip whose body is kept, which stays with it. */
  const seen = seenGround(W, H)
  /** Near enough the screen to matter: within a screen and a half of its
   *  middle on the flat canvas, or on the ground the tipped camera sees. */
  const inView = (u: number, v: number, w: number, h: number) =>
    (Math.abs(u) - w / 2 <= W * 1.5 && Math.abs(v) - h / 2 <= H * 1.5) ||
    (!!seen && u + w / 2 >= seen.x0 && u - w / 2 <= seen.x1 && v + h / 2 >= seen.y0 && v - h / 2 <= seen.y1)
  const add = (x: number, y: number, w: number, h: number, t: number, color: number, r: number, keep = false) => {
    const u = x + w / 2 - W / 2, v = y + h / 2 - H / 2
    // Off by its nearest edge, not its centre: a long strip still filling
    // the screen kept its deck and bars only while its middle was near.
    // Kept too while on the ground the camera sees: tipped well back, the
    // top of the screen is far more than a screen away on the flat canvas,
    // and a cabinet up there fell flat (Brian 2026-11-01).
    if (w < 3 || h < 3) return
    if (!keep && !inView(u, v, w, h)) return
    out.push({ u, v, w, h, t, color, r })
    return out[out.length - 1]
  }
  /** A thin plate under a part raised over a strip, so the 3D view drawn
   *  over the page does not hide it (the strip's rim, its deck). */
  const plate = (x: number, y: number, w: number, h: number, z: number, r: number) => {
    const s = add(x, y, w, h, 0.5, SIDE.pop, r)
    if (s) s.z = z
  }
  // World layer: tiles and Viewers, in world units under the pan/zoom.
  const { pan, zoom } = useCanvasStore.getState()
  const lean = consoleLean(host, zoom)
  const leaning: Leaning[] = []
  const screens: Screen[] = []
  /** Console: column heads whose card leans (they ride up with it). */
  const riders: { head: HTMLElement; world: HTMLElement }[] = []
  /** Console: the cards' part of a row's insertion mark (see below). */
  const marks: { part: HTMLElement; world: HTMLElement; rail: string; z: number; band?: boolean }[] = []
  /** A column's insertion mark (a picture card dropped into a column). */
  const colMarks: { el: HTMLElement; world: HTMLElement; rail: string; slot: string; index: number; dragged: string }[] = []
  /** Cards and decks on the card layer: the height of their tops. */
  const cardTops = new Map<string, number>()
  /** Console: cards on a strip that lean back, by group id (radians). */
  const cardLean = new Map<string, number>()
  /** …and where each of those is docked, for the furniture behind it. */
  const cardDock = new Map<string, Omit<Leaning, 'id' | 'slab' | 'hinge'>>()
  /** Console: those cards' blocks and boards, standing with them, all but
   *  what shows over their strip flat hidden (see veil). */
  const buried: HTMLElement[] = []
  const worlds = [...host.querySelectorAll<HTMLElement>(':scope > div[style*="scale("]')]
  for (const world of worlds) {
    const tiles = [...world.querySelectorAll<HTMLElement>('[data-viewport3d]:not([data-pinned]), [data-freenode][data-id]:not([data-pinned])')]
    // Tiles lying over one another (a panel over a panel, a Viewer under a
    // tile): as cards do (below), each lies a hair over the tops of the
    // tiles painted under it that it overlaps, their raised headers and
    // buttons included. All at one height, the header of the one under
    // stood up through the one over it in 3D alone (second pass
    // 2026-11-01: the media pool's header across the history panel over
    // it). Walked in the flat view's paint order: z-index, then page order.
    const tileBase = new Map<HTMLElement, number>()
    {
      const nodes = useFreeNodeStore.getState().nodes
      const plain = tiles
        .map((el, i) => ({ el, i, z: parseInt(el.style.zIndex) || 0 }))
        .filter(({ el }) => !el.hasAttribute('data-rail') && !el.hasAttribute('data-rail-docked') &&
          !(el.hasAttribute('data-viewport3d') && lean.get(el.dataset.viewport3d!)) &&
          nodes[el.dataset.id ?? '']?.type !== 'cabinet')
        .sort((a, b) => a.z - b.z || a.i - b.i)
      const below: { x0: number; y0: number; x1: number; y1: number; top: number }[] = []
      for (const { el } of plain) {
        const at = offsetIn(el, world)
        if (!at) continue
        const x1 = at.x + el.offsetWidth, y1 = at.y + el.offsetHeight
        let base = 0
        for (const b of below) if (b.x0 < x1 && at.x < b.x1 && b.y0 < y1 && at.y < b.y1) base = Math.max(base, b.top + TILE_OVER)
        if (base > 0) tileBase.set(el, base)
        // Its top: its face, or what popParts raises off it.
        const w = el.offsetWidth * zoom
        below.push({ x0: at.x, y0: at.y, x1, y1, top: base + Math.min(w, el.offsetHeight * zoom) * POP * detail(w) })
      }
    }
    for (const node of tiles) {
      // A loop strip paints its face on its own body, which can sit off the
      // tile's box and outgrow it: the slab follows the body.
      const el = node.hasAttribute('data-rail') ? node.querySelector<HTMLElement>('[data-rail-body]') ?? node : node
      const at = offsetIn(el, world)
      if (!at) continue
      const viewer = node.hasAttribute('data-viewport3d')
      const w = el.offsetWidth * zoom, h = el.offsetHeight * zoom
      const m = Math.min(w, h)
      const slab = add(pan.x + at.x * zoom, pan.y + at.y * zoom, w, h,
        m * (viewer ? THICK.viewer : THICK.tile), viewer ? SIDE.viewer : SIDE.tile, radiusOf(el) * zoom)
      if (!slab) continue
      // Over a tile under it: lifted, its sides down to the canvas.
      const overTile = tileBase.get(node)
      if (overTile !== undefined) {
        slab.z = overTile
        slab.t += overTile
        lifting.set(node, overTile)
        chain(node, world)
      }
      let hinge: Hinge | undefined
      const fs = useFreeNodeStore.getState()
      const sa = viewer ? lean.get(node.dataset.viewport3d!) : undefined
      if (sa) {
        // Console: the Viewer a strip shows on stands up off the plane on
        // its bottom edge, a screen on a strut (Brian 2026-10-30, the
        // mockup machine), its slab under it.
        slab.z = slab.t
        lifting.set(node, slab.t)
        // A display's case, not an app window stood up: dark metal, with
        // a bright parting line round its edge, so its sides and its back
        // read as hardware from every side.
        slab.color = DECK.case
        slab.finish = 'body'
        slab.seam = slab.t * 0.5
        hinge = { v: slab.v + slab.h / 2, z: slab.z, a: sa }
        slab.hinge = hinge
        stand(node, hinge, zoom)
        screens.push({ id: node.dataset.viewport3d!, slab, hinge })
      } else if (fs.nodes[node.dataset.id ?? '']?.type === 'area') {
        // An Area card (components/Notes/AreaBody) is a tray in 3D: a low rim
        // round its mat, a workspace the models stand in.
        const k = detail(w)
        if (k > 0) slab.rim = { w: Math.max(2, 10 * zoom) * k, h: Math.max(2, 14 * zoom) * k }
        slab.color = SIDE.tray
      } else if (node.hasAttribute('data-rail')) {
        // A loop strip is a tray: a rim round its edge, its floor the face.
        // Far off (small on screen) it settles back to a plain slab.
        const k = detail(w)
        const u = fs.nodes[node.dataset.id!]?.rail?.unit || 1
        // Its width grows in with its height: at full width from the start,
        // its top lay almost level with the floor in the first degrees, a
        // dark band over the strip's edge and over anything lying across it.
        if (k > 0) slab.rim = { w: TRAY.rimW * u * zoom * k, h: TRAY.rimH * u * zoom * k }
        slab.color = SIDE.tray
        // The run arrow and the band of headers under it stand up out of
        // the tray, above its rim and the cards (Brian 2026-10-30).
        if (k > 0) {
          // Clear of the cards on it too (their tops, a single card thick).
          let top = 0
          for (const o of Object.values(fs.nodes)) {
            const d = o.railDock
            if (!d || d.railId !== node.dataset.id || d.lifted) continue
            const om = Math.min(o.width, o.height) * zoom
            top = Math.max(top, (dockLift(om, d.order ?? 0) + om * THICK.card) * k)
          }
          const H = Math.max(TRAY.rimH * TRAY.band * u * zoom * k, top + TRAY.rimH * u * zoom * k)
          // Console: the loop strip bar and the header bar stand on a deck
          // above the leaning cards' tops (Brian 2026-10-30: "above the
          // tilted cards ... so it appears like a machine"), rising with
          // their lean.
          const rid = node.dataset.id!
          const sr = railStand.get(rid) ?? 0
          // Console: the strip's body is the machine's chassis, deep, its
          // rim lit metal with machined edges, its floor a lit slate.
          if (sr > 0) {
            slab.color = DECK.body
            slab.finish = 'rim'
            const ground = el.querySelector<HTMLElement>(':scope > [data-rail-ground]')
            if (ground) floorTint(ground, sr)
            slab.bevel = 2 * u * zoom
            slab.t = Math.max(slab.t, 16 * u * zoom * sr)
            // Two-part case: a bright parting line round its wall.
            if (slab.t >= 6) slab.seam = slab.t * 0.42
          }
          const main = new Set([...(fs.nodes[rid]?.rail?.slots.map(sl => sl.id) ?? []), RAIL_TRAY])
          let D = H, A = H
          // Console: the live preview heads the results, so it leans back
          // at their head as a card would, the results' leaning in front.
          const ghost = sr > 0 ? world.querySelector<HTMLElement>(`[data-rail-overlay="${rid}"] [data-rail-ghost]`) : null
          const ga = ghost && offsetIn(ghost, world)
          let ghostRise = 0
          if (ghost && ga && ghost.offsetWidth) {
            const gw = ghost.offsetWidth * zoom, gh = ghost.offsetHeight * zoom, gm = Math.min(gw, gh)
            const a = leanOf.get(rid) ?? CONSOLE.slot * sr * Math.PI / 180
            const gz = dockLift(gm, 0) * k
            const gs = add(pan.x + ga.x * zoom, pan.y + ga.y * zoom, gw, gh, Math.min(gz, gm * THICK.tile), SIDE.card, radiusOf(ghost) * zoom, true)
            if (gs) {
              gs.z = gz
              gs.hinge = { v: gs.v + gs.h / 2, z: gz, a }
              lifting.set(ghost, gz)
              chain(ghost, world)
              stand(ghost, gs.hinge, zoom)
              leaning.push({ id: `ghost:${rid}`, rail: rid, slot: RAIL_TRAY, order: -1, slab: gs, hinge: gs.hinge, main: true })
              ghostRise = gz + gh * Math.sin(a) / Math.max(K, 1e-3)
            }
          }
          if (sr > 0) {
            for (const o of Object.values(fs.nodes)) {
              const d = o.railDock, a = lean.get(o.id)
              if (!a || !d || d.railId !== rid || !main.has(d.slotId)) continue
              const om = Math.min(o.width, o.height) * zoom
              // Its rise is the card's own, not faded with the lifts below
              // (scaled by K there), so the deck tops it at every tilt.
              D = Math.max(D, dockLift(om, 0) * k + o.height * zoom * Math.sin(a) / Math.max(K, 1e-3) + DECK.clear * u * zoom * sr)
            }
            if (ghostRise) D = Math.max(D, ghostRise + DECK.clear * u * zoom * sr)
          }
          const band = el.querySelector<HTMLElement>('[data-rail-band]')
          const ba = band && offsetIn(band, world), ea = offsetIn(el, world)
          if (D > H && band && ba && ea) {
            const rim = TRAY.rimW * u * zoom * k
            // The loop strip bar a step up again behind the header bar, so
            // each tier shows over the one in front, as on a meter bridge.
            A = D + DECK.step * u * zoom * sr
            decks.push({ rail: rid, D, A, s: sr, u: u * zoom,
              front: pan.y + (ba.y + band.offsetHeight) * zoom - H_ / 2, back: pan.y + ea.y * zoom + rim - H_ / 2,
              x0: pan.x + ea.x * zoom + rim - W_ / 2, x1: pan.x + (ea.x + el.offsetWidth) * zoom - rim - W_ / 2,
              band: { v0: pan.y + ba.y * zoom - H_ / 2, v1: pan.y + (ba.y + band.offsetHeight) * zoom - H_ / 2 } })
          }
          for (const part of el.querySelectorAll<HTMLElement>('[data-rail-band], [data-rail-arrow]')) {
            const a = offsetIn(part, world)
            if (!a || !part.offsetWidth) continue
            const z = part.hasAttribute('data-rail-arrow') ? A : D
            // Up on the deck (or its tier), a plate: the deck is its body, so
            // the wall under it is the strip's furniture, pressed as its band.
            // With the strip's body (and the deck on it), not culled alone.
            const s = add(pan.x + a.x * zoom, pan.y + a.y * zoom, part.offsetWidth * zoom, part.offsetHeight * zoom, z > H ? Math.min(z, 2) : z,
              SIDE.tray, (radiusOf(part) || 6 * u) * zoom, true)
            if (s) s.z = z
            lifting.set(part, z)
            chain(part, world)
            // Solid, its sides the colour of its face, as a raised button's.
            const face = fill(part)
            if (s && face) s.color = (face[0] << 16) | (face[1] << 8) | face[2]
            // Console: set in a machined bezel; the Run bar lit from within.
            if (s && sr > 0 && z > H) {
              const b = 2.5 * u * zoom * sr
              if (part.hasAttribute('data-rail-arrow')) s.finish = 'glow'
              if (b >= 0.5) out.push({ u: s.u, v: s.v, w: s.w + 2 * b, h: s.h + 2 * b, r: s.r + b, t: Math.min(z, 1.5 * b), z: z - 0.35,
                color: DECK.alu, finish: 'alu', bevel: b * 0.6, cap: true, deco: `rail:${rid}` })
            }
          }
          for (const head of el.querySelectorAll<HTMLElement>('[data-rail-head], [data-rail-card-head], [data-rail-tray-head]')) {
            // A look row's heads stay down with their row; a leaning card's
            // there rides up on it.
            const cid = head.dataset.railCardId
            const look = !!cid && !main.has(fs.nodes[cid]?.railDock?.slotId ?? '')
            // On the deck a hair over the header bar, a plane of its own: at
            // the bar's height the page's hit test took it for the bar.
            lifting.set(head, look ? H : D > H ? D + 0.5 : D)
            chain(head, world)
            if (look && lean.has(cid!)) riders.push({ head, world })
          }
          // Where a card dragged along a row would go: the mark's part over
          // the header bar up with the heads, its part down the cards stood
          // with them (below, once they lean). Flat on the floor it was
          // under the deck and the cards.
          const drop = useRailUiStore.getState().drop
          const lookRow = drop?.target.kind === 'row' && (drop.target.row ?? 0) > 0
          for (const part of world.querySelectorAll<HTMLElement>(`[data-rail-overlay="${rid}"] [data-rail-drop-mark-part]`)) {
            chain(part, world)
            // A look row's tabs ride its leaning cards: its part over them
            // stands as they do (below, with the riders).
            const band = part.dataset.railDropMarkPart === 'band'
            if (!band || lookRow) { marks.push({ part, world, rail: rid, z: H, band }); continue }
            // Its own plate (an opening in the 3D view over its line), or
            // the deck drawn over the page would hide it; over the heads.
            const z = (D > H ? D + 0.5 : D) + 0.5
            const a = offsetIn(part, world)
            const s = a && add(pan.x + a.x * zoom, pan.y + a.y * zoom, part.offsetWidth * zoom, part.offsetHeight * zoom, 0.5, DROP_RGB, part.offsetWidth * zoom / 2, true)
            if (s) { s.z = z; s.nopick = true }
            lifting.set(part, z)
          }
          // A column's mark: at the height of the top of the card whose top
          // edge it marks (below, once the card layer is read), so what shows
          // of it past that card's edge shows there, as flat; on the floor
          // the raised card hid it.
          const ct = drop?.target.kind === 'column' && drop.target.railId === rid ? drop.target : null
          const cm = ct && world.querySelector<HTMLElement>(`[data-rail-overlay="${rid}"] [data-rail-drop-mark="h"]`)
          if (ct && cm) { chain(cm, world); colMarks.push({ el: cm, world, rail: rid, slot: ct.slotId, index: ct.index, dragged: drop!.draggedId }) }
          // Console: Run stands up off the arrow as a pill, the machine's
          // button. Not while running: its progress and stop show as flat.
          const run = sr > 0 ? el.querySelector<HTMLElement>('[data-rail-arrow] button[data-rail-run="idle"]') : null
          const ra = run && offsetIn(run, world)
          // Its top, for what lies loose over it: over all of it the deck
          // with the heads on it (the bars, flat), which the leaning cards
          // stay under; behind the header bar the loop strip bar's tier.
          const cx = slab.u - slab.w / 2 + W_ / 2, cy = slab.v - slab.h / 2 + H_ / 2
          crowns.push({ x0: cx, y0: cy, x1: cx + slab.w, y1: cy + slab.h, z: D > H ? D + 0.5 : D })
          if (A > D && ba) crowns.push({ x0: cx, y0: cy, x1: cx + slab.w, y1: pan.y + ba.y * zoom, z: A })
          if (run && ra && run.offsetWidth) {
            const P = TRAY.rimH * u * zoom * k * sr
            // And Run's pill, up off the tier.
            crowns.push({ x0: pan.x + ra.x * zoom, y0: pan.y + ra.y * zoom, x1: pan.x + ra.x * zoom + run.offsetWidth * zoom, y1: pan.y + ra.y * zoom + run.offsetHeight * zoom, z: A + P })
            const rh = run.offsetHeight * zoom
            const ps = add(pan.x + ra.x * zoom, pan.y + ra.y * zoom, run.offsetWidth * zoom, rh, P, RUN_RGB, rh / 2, true)
            if (ps) ps.z = A + P
            lifting.set(run, P)
            chain(run, world)
            fill(run, { rgb: RUN_RGB_A, round: true })
          }
        }
      } else if (fs.nodes[node.dataset.id!]?.type === 'cabinet') {
        // A project cabinet: the flat face is its front lying down, and it
        // stands up on its bottom edge as the canvas tips. An open drawer's
        // tray comes straight out of its front, at that drawer's height, over
        // the same patch of canvas as in the flat view.
        const x = Math.max(0, Math.min(1, (standTilt(useTiltStore.getState()) - CONSOLE.from) / (FADE_TILT - CONSOLE.from)))
        const a = CABINET.stand * x * x * (3 - 2 * x) * detail(w) * Math.PI / 180
        if (a > 0) {
          hinge = { v: slab.v + slab.h / 2, z: 0, a }
          slab.t = w * CABINET.depth
          slab.hinge = hinge
          stand(node, hinge, zoom)
          const tray = node.querySelector<HTMLElement>('[data-cabinet-tray]')
          if (tray) {
            chain(tray, world)
            const id = tray.dataset.cabinetDrawer?.split(':')[1]
            const front = node.querySelector<HTMLElement>(`[data-cabinet-front="${id}"]`)
            const at = front && offsetIn(front, node)
            // Up the face from its bottom edge to the bottom of this drawer.
            const raise = at ? Math.max(0, node.offsetHeight - at.y - front!.offsetHeight) : 0
            const z = raise * zoom * Math.sin(a)
            stand(tray, { v: hinge.v, z, a: -a }, zoom, '50% 0%')
            setStyle(tray, 'translate', `0 ${-raise}px`)
            // The drawer as a box: its sides under the tray, a rim round it,
            // and its front panel gone out to the far end, as far from the
            // dark opening it left as the drawer is long.
            const boxAt = offsetIn(tray, world)
            if (boxAt && front) {
              const bw = tray.offsetWidth * zoom, bh = tray.offsetHeight * zoom, fh = front.offsetHeight * zoom
              // Where the tray really is: carried `raise` up the leaning face,
              // it starts that much less far out (and offsetIn leaves out the
              // cabinet's border). A thin floor under it, its walls the rim:
              // walls a whole drawer deep hung down over the drawer below.
              const bb = parseFloat(getComputedStyle(node).borderBottomWidth) || 0
              const back = (raise * Math.cos(a) - bb) * zoom
              const box = add(pan.x + boxAt.x * zoom, pan.y + boxAt.y * zoom - back, bw, bh, Math.max(2, fh * 0.08), SIDE.tile, 4 * zoom)
              if (box) {
                box.z = z
                box.rim = { w: Math.max(2, bw * CABINET.rim), h: fh * CABINET.rimH }
              }
              const panel = add(pan.x + boxAt.x * zoom, pan.y + boxAt.y * zoom + bh - fh - back, bw, fh, Math.max(2, bw * CABINET.rim), SIDE.tile, 4 * zoom)
              if (panel) {
                panel.hinge = { v: panel.v + fh / 2, z: Math.max(0, z - fh * 0.15), a }
                // Its face at the hinge's height: left on the floor, it swung
                // back about the hinge into the cabinet, never seen.
                panel.z = panel.hinge.z
                panel.cap = true
              }
            }
          }
        }
      } else if (node.hasAttribute('data-rail-docked')) {
        // Cards docked in a strip sit on its floor, each in the column a
        // little above the one before: a real stack, with its own sides.
        const n = fs.nodes[node.dataset.id!]
        const strip = n?.railDock && world.querySelector<HTMLElement>(`[data-freenode][data-id="${n.railDock.railId}"] [data-rail-body]`)
        const k = strip ? detail(strip.offsetWidth * zoom) : 0
        if (k > 0) {
          slab.z = dockLift(m, n?.railDock?.order ?? 0) * k
          slab.t = slab.z    // stacked on the floor, so its sides reach it
          lifting.set(node, slab.z)
          // Console: whatever is docked leans back on its bottom edge, a
          // plate a card thick (Brian 2026-10-30; the cast and the results
          // too, 2026-11-01). A card's stand-in only says how: the card
          // layer stands the card itself (below).
          const a = lean.get(node.dataset.id!)
          if (a) {
            hinge = { v: slab.v + slab.h / 2, z: slab.z, a }
            slab.t = Math.min(slab.z, m * THICK.tile)
            slab.hinge = hinge
            // Its selection ring shows over the sloped back behind it.
            if (fs.selectedIds.includes(n!.id)) slab.ring = 3
            const d = n!.railDock!
            const at = { rail: d.railId, slot: d.slotId, order: d.order ?? 0,
              main: d.slotId === RAIL_TRAY || !!fs.nodes[d.railId]?.rail?.slots.some(sl => sl.id === d.slotId) }
            if (n!.cardRef) { cardLean.set(n!.cardRef, a); cardDock.set(n!.cardRef, at) }
            else { stand(node, hinge, zoom); leaning.push({ id: n!.id, ...at, slab, hinge }) }
          }
        }
        // A card (or deck) on a strip is drawn by the card layer over an
        // invisible stand-in tile: the card takes the stand-in's place in
        // the stack (below), and the stand-in has no slab of its own.
        if (n?.cardRef) {
          if (k > 0) docked.set(n.cardRef, slab.z!)
          out.pop()
          continue
        }
      }
      // In a solitaire stack the cards above cover part of this one: what
      // they cover stays flat, so none of it pokes up through them.
      const over = coversOf(node.dataset.id)
      popParts(node, world, slab.z ?? 0, m, detail(w), lifting, (el, z, t) => {
        // Through a Viewer's screen-sized contents too (offsetScaled).
        const a = offsetScaled(el, world)
        if (!a) return
        const ew = el.offsetWidth * a.k, eh = el.offsetHeight * a.k
        if (over.some(r => a.x < r.x + r.width && r.x < a.x + ew && a.y < r.y + r.height && r.y < a.y + eh)) return false
        const p = add(pan.x + a.x * zoom, pan.y + a.y * zoom, ew * zoom, eh * zoom, t, SIDE.pop, radiusOf(el) * a.k * zoom)
        if (p) { p.z = z; p.pop = true; if (hinge) p.hinge = hinge }
        return p
      })
    }
  }
  // Console: a leaning card's tab (its column head, the strip's header band
  // above it) rides up with it, the card's own header above its top edge,
  // where it can still be seen and grabbed. It leaves the band as the card
  // turns and is level with the card's face once up.
  for (const { head, world } of riders) {
    const l = leaning.find(c => c.id === head.dataset.railCardId)
    const tile = l && world.querySelector<HTMLElement>(`[data-freenode][data-id="${l.id}"]`)
    const at = l && offsetIn(head, world), ta = tile && offsetIn(tile, world)
    if (!l || !tile || !at || !ta) continue
    const band = lifting.get(head) ?? 0
    const up = grownIn(l.hinge.a, CONSOLE.slot)
    const hinge = { v: l.hinge.v, z: band + (l.hinge.z - band) * up, a: l.hinge.a }
    lifting.set(head, hinge.z)
    stand(head, hinge, zoom, `50% ${ta.y + tile.offsetHeight - at.y}px`)
    // Its own plate, or the band's sides would show through it.
    const s = add(pan.x + at.x * zoom, pan.y + at.y * zoom, head.offsetWidth * zoom, head.offsetHeight * zoom,
      Math.max(1, l.slab.t), SIDE.tray, radiusOf(head) * zoom)
    if (!s) continue
    s.z = hinge.z
    s.hinge = hinge
    const face = fill(head)
    s.color = (face[0] << 16) | (face[1] << 8) | face[2]
    l.top = Math.min(l.top ?? Infinity, s.v - s.h / 2)
  }
  // The cards' part of an insertion mark leans with the cards it lies
  // between, from their bottom edges: on their plane, in the gap. A look
  // row's part over its tabs rides with them, above its cards' tops. Each
  // on a plate of its own (see above) that pick() sees through, as the
  // page's hit test sees through the mark: a drag goes on over it.
  for (const { part, world, rail, z, band } of marks) {
    const at = offsetIn(part, world)
    if (!at) continue
    const foot = at.y + part.offsetHeight
    let best: { l: Leaning; y: number; bottom: number } | undefined
    for (const l of leaning) {
      const tile = l.rail === rail ? world.querySelector<HTMLElement>(`[data-freenode][data-id="${l.id}"]`) : null
      const ta = tile && offsetIn(tile, world)
      if (!ta) continue
      const bottom = ta.y + tile!.offsetHeight, y = band ? ta.y : bottom
      if (Math.abs(y - foot) < part.offsetHeight / 2 && (!best || Math.abs(y - foot) < Math.abs(best.y - foot))) best = { l, y, bottom }
    }
    const plate = (hinge?: Hinge) => {
      const s = add(pan.x + at.x * zoom, pan.y + at.y * zoom, part.offsetWidth * zoom, part.offsetHeight * zoom, 0.5, DROP_RGB, part.offsetWidth * zoom / 2)
      if (s) { s.z = hinge ? hinge.z : z + 0.5; s.hinge = hinge; s.nopick = true }
    }
    if (!best) {
      // Nothing leans there (a strip held flat, 3D without the console):
      // over the cards at the header bar's level.
      lifting.set(part, z + 0.5)
      plate()
      continue
    }
    const { l } = best
    const up = band ? grownIn(l.hinge.a, CONSOLE.slot) : 1
    const hinge = { v: l.hinge.v, z: (band ? z + (l.hinge.z - z) * up : l.hinge.z) + 0.5, a: l.hinge.a }
    lifting.set(part, hinge.z)
    stand(part, hinge, zoom, `50% ${best.bottom - at.y}px`)
    plate(hinge)
  }
  // A card (or deck) on a strip has an invisible stand-in tile that is never
  // drawn, so its lift is worked out from the store: it stands on the
  // strip's floor, clear of it, like a docked tile.
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    if (!n.cardRef || !n.railDock || n.railDock.lifted) continue
    const strip = host.querySelector<HTMLElement>(`[data-freenode][data-id="${n.railDock.railId}"] [data-rail-body]`)
    const k = strip ? detail(strip.offsetWidth * zoom) : 0
    if (k > 0) docked.set(n.cardRef, dockLift(Math.min(n.width, n.height) * zoom, n.railDock.order ?? 0) * k)
    // Console: it leans as the strip's tiles do (Brian 2026-11-01: the cast
    // and the results too), the card layer standing the card itself.
    const a = k > 0 ? lean.get(n.id) : undefined
    if (a && !cardLean.has(n.cardRef)) {
      const d = n.railDock, nodes = useFreeNodeStore.getState().nodes
      cardLean.set(n.cardRef, a)
      cardDock.set(n.cardRef, { rail: d.railId, slot: d.slotId, order: d.order ?? 0,
        main: d.slotId === RAIL_TRAY || !!nodes[d.railId]?.rail?.slots.some(sl => sl.id === d.slotId) })
    }
  }
  // A storyline standing up (StorylineLayer, CSS 3D) is no slab, so the
  // slabs' sides, drawn over the page, painted over its lines wherever they
  // crossed on screen, even from behind it: a strip's front edge sliced its
  // stem. A depth-only plate under each of its lines and dots, turned up on
  // its wall as it stands, lets them hide what is behind them and still be
  // hidden by what is in front. Tops alone (ghost): they cast no shadow and
  // show nothing of their own.
  for (const st of standingStories()) {
    const hinge: Hinge = { v: pan.y + st.footY * zoom - H / 2, z: 0, a: Math.PI / 2 * st.rise }
    const wide = st.weight + 3
    for (const [x1, y1, x2, y2] of st.segs) {
      const len = Math.hypot(x2 - x1, y2 - y1) * zoom
      if (len < 1) continue
      const cx = pan.x + (x1 + x2) / 2 * zoom, cy = pan.y + (y1 + y2) / 2 * zoom
      const s = add(cx - len / 2, cy - wide / 2, len, wide, 0.01, SIDE.pop, wide / 2)
      if (s) { s.spin = Math.atan2(y2 - y1, x2 - x1); s.hinge = hinge; s.nopick = true; s.ghost = true }
    }
    for (const [x, y] of st.dots) {
      const d = 20
      const s = add(pan.x + x * zoom - d / 2, pan.y + y * zoom - d / 2, d, d, 0.01, SIDE.pop, d / 2)
      if (s) { s.hinge = hinge; s.nopick = true; s.ghost = true }
    }
  }
  // A card standing up with a storyline brings its row bands (the faint
  // stripes behind its rows, in the grid layer, InfiniteCanvas data-row-band)
  // up with it, on the same foot: nothing of it is left on the floor.
  const standBands = (id: string, hinge: Hinge, footY: number) => {
    for (const band of host.querySelectorAll<HTMLElement>(`[data-row-band="${id}"]`)) {
      const world = worlds.find(wd => wd.contains(band)) ?? band.parentElement
      const bat = world && offsetIn(band, world)
      if (!world || !bat) continue
      lifting.set(band, hinge.z)
      chain(band, world)
      stand(band, hinge, zoom, `50% ${(footY - (pan.y + bat.y * zoom)) / zoom}px`)
    }
  }
  // Card layer: cards and closed decks, already in screen px.
  const stage = document.querySelector<HTMLElement>('[data-tilt-stage="overlay"]')
  if (stage) {
    const groups = useBoardsStore.getState().groups
    const zones = hitZones(stage)
    // Each card's name band (header) is drawn beside it, not in it.
    const heads = new Map<string, HTMLElement>()
    for (const head of stage.querySelectorAll<HTMLElement>('[data-card-header]')) heads.set(head.dataset.cardHeader!, head)
    // In the flat view's paint order (see paintZ), so that each card can
    // stand over the cards painted under it that it overlaps.
    const cards = [...stage.querySelectorAll<HTMLElement>('[data-group-card][data-id]')]
      .map((el, i) => ({ el, i, z: paintZ(el, stage) }))
      .sort((a, b) => a.z - b.z || a.i - b.i)
    /** The raised cards placed so far that lie flat: their boxes and tops. */
    const under: { x0: number; y0: number; x1: number; y1: number; z: number }[] = []
    for (const { el } of cards) {
      const at = offsetIn(el, stage)
      if (!at) continue
      const id = el.dataset.id!
      const g = groups.find(gr => gr.id === id)
      if (g?.deckState === 'fanned') {
        // On a storyline's wall it stands with it, fanned as stacked (Brian
        // 2026-11-05: fanned there, it dropped back to the floor).
        const fy = storyWallOf(id) ?? (g.deckAnchorId ? storyWallOf(g.deckAnchorId) : null)
        const wy = fy === null ? null : pan.y + fy * zoom
        const a = wy === null ? 0 : Math.PI / 2 * standRise(useTiltStore.getState())
        const wall = wy !== null && a > 0 ? { v: wy - H / 2, y: wy, a } : undefined
        const top = fanSlabs(el, stage, at, add, lifting, docked.get(id), heads.get(id), wall)
        // On a wall, its link chips (and their "+") and its row bands stand
        // with it, over its front card, as a stacked deck's do.
        if (wall && top !== undefined) {
          const hinge: Hinge = { v: wall.v, z: top, a: wall.a }
          const chips = stage.querySelector<HTMLElement>(`[data-primary-rail="${id}"]`)
          const ca = chips && offsetIn(chips, stage)
          if (chips && ca) {
            lifting.set(chips, top + 0.25)
            chain(chips, stage)
            stand(chips, { ...hinge, z: top + 0.25 }, 1, `50% ${wall.y - ca.y}px`)
            for (const c of chips.querySelectorAll<HTMLElement>(':scope > * > *')) {
              const p = offsetScaled(c, stage)
              const s = p && add(p.x, p.y, c.offsetWidth * p.k, c.offsetHeight * p.k, 0.5, SIDE.pop, c.offsetHeight * p.k / 2)
              if (s) { s.z = top + 0.25; s.hinge = hinge }
            }
          }
          standBands(id, hinge, wall.y)
        }
        continue
      }
      const n = g?.deckState === 'stacked' ? 1 + groups.filter(o => o.deckAnchorId === id && o.deckState === 'stacked').length : 1
      const w = el.offsetWidth, h = el.offsetHeight, m = Math.min(w, h)
      // A deck's first child is its first page edge; one drawn on the left
      // has its rounding first, so read it as the right one reads (none).
      const r = (el.dataset.deckSide === 'left' ? 0 : radiusOf((el.firstElementChild as HTMLElement | null) ?? el)) || m * 0.06
      // On a loop strip it stands on the tray's floor, else on the canvas.
      let lift = docked.get(id) ?? (g?.deckAnchorId ? docked.get(g.deckAnchorId) : undefined)
      // Loose over a strip, it is drawn over the strip flat: on its top in
      // 3D, not under its rim and bars.
      const resting = lift === undefined ? rest(`card:${id}`, restOn(at.x, at.y, el.offsetWidth, el.offsetHeight)) : 0
      if (resting > 0) lift = resting
      // Linked to a storyline flipped up as a wall: it stands with it, turned
      // up on the wall's foot (stage px `wallY`), where it lies on the wall
      // as it lies by the line flat (StorylineLayer storyWallOf).
      const footY = storyWallOf(id) ?? (g?.deckAnchorId ? storyWallOf(g.deckAnchorId) : null)
      const wallY = footY === null ? null : pan.y + footY * zoom
      // Console: leaning back on its bottom edge, as its stand-in says.
      const tip = wallY !== null ? Math.PI / 2 * standRise(useTiltStore.getState()) : cardLean.get(id) ?? (g?.deckAnchorId ? cardLean.get(g.deckAnchorId) : undefined)
      const k = detail(w)
      let card: TiltSlab | undefined
      let tilt: Hinge | undefined
      // Off a strip, the highest top of the cards painted under it that it
      // overlaps: flat, it shows over them, so it stands over them here.
      let overTop: number | undefined
      if (lift === undefined) {
        for (const u of under) if (u.x0 < at.x + w && at.x < u.x1 && u.y0 < at.y + h && at.y < u.y1) overTop = Math.max(overTop ?? 0, u.z)
      }
      if (k <= 0 && lift === undefined && overTop === undefined && wallY === null) {
        card = add(at.x, at.y, w, h, m * THICK.card, SIDE.card, r)
      } else {
        // A card stands on what holds it, its thickness above it; a deck is
        // as tall as its cards, each a slice, the lower ones stepping out to
        // the right as its flat edges do. Its face rides on top. Off a strip
        // every card is one card stock thick, whatever its size.
        const f = Math.max(k, lift === undefined ? 0 : 1)
        const per = (lift === undefined ? CARD_STOCK * zoom : m * THICK.card) * f
        const thick = Math.min(m * THICK.deckMax, per * n)
        // Lying over a card painted under it, a hair above that card's top.
        const base = lift ?? Math.max(0, (overTop ?? -Infinity) + OVER - thick)
        const reserve = n > 1 ? Math.min(10, w * 0.05) : 0
        // Each card under the top one reaches a step further right than the
        // one above, so the deck's right side is an angled run of page edges
        // you can see (and click to fan) without the pile leaning: past the
        // flat deck's edge strip, grown in with the 3D look (Brian 2026-10-30).
        const L = Math.min(n - 1, DECK_SLICES)
        const spread = reserve + Math.max(0, Math.min(w * 0.08, L * Math.min(6, Math.max(2, w * 0.012))) - reserve) * f * K
        // A deck whose cards lie left of its front card (opened away from a
        // storyline) has its edges on the left as flat: its pages step out
        // leftward, the face past them (CardLayer StackedDeckCard).
        const lefty = el.dataset.deckSide === 'left'
        const faceX = lefty ? at.x + reserve : at.x
        // A free card's sides go down to the canvas, lifted over another or not.
        card = add(faceX, at.y, w - reserve, h, lift !== undefined ? thick : n > 1 ? per : base + per, SIDE.card, r)
        if (card) {
          card.z = base + thick
          cardTops.set(id, card.z)
          if (resting > 0) rested.set(id, card.z)
          lifting.set(el, card.z)
          chain(el, stage)
          tilt = tip ? { v: wallY !== null ? wallY - H / 2 : card.v + card.h / 2, z: card.z, a: tip } : undefined
          if (tilt) {
            card.hinge = tilt
            stand(el, tilt, 1, wallY !== null ? `50% ${wallY - at.y}px` : undefined)
            const d = cardDock.get(id) ?? (g?.deckAnchorId ? cardDock.get(g.deckAnchorId) : undefined)
            if (d) leaning.push({ id, ...d, slab: card, hinge: tilt })
          } else {
            under.push({ x0: at.x, y0: at.y, x1: at.x + w, y1: at.y + h, z: card.z })
          }
          riseZones(zones, at, w, h, card.z, lifting, stage, tilt, wallY ?? undefined)
          // Its name band rides on it, over the hover zone over it as flat
          // (band 51, zone 41, card 40), and leans with it on a strip. Left
          // on the floor it was under the raised card (gone from 1° of tilt),
          // and a double-click on the name went to the zone, which stacks.
          const head = heads.get(id)
          const ha = head && offsetIn(head, stage)
          if (head && ha) {
            lifting.set(head, card.z + 1)
            chain(head, stage)
            if (tilt) stand(head, { ...tilt, z: card.z + 1 }, 1, `50% ${(wallY ?? at.y + h) - ha.y}px`)
          }
          // Leaning, its link chips half over its bottom edge ('+', a link's
          // drag start, among them) lean with it as its name band does, over
          // its face as flat. Left on the floor they were under the leaning
          // card and a link could not be started from it.
          const chips = tilt ? stage.querySelector<HTMLElement>(`[data-primary-rail="${id}"]`) : null
          const ca = chips && offsetIn(chips, stage)
          if (chips && ca) {
            lifting.set(chips, card.z + 0.25)
            chain(chips, stage)
            stand(chips, { ...tilt!, z: card.z + 0.25 }, 1, `50% ${(wallY ?? at.y + h) - ca.y}px`)
            for (const c of chips.querySelectorAll<HTMLElement>(':scope > * > *')) {
              const a = offsetScaled(c, stage)
              const s = a && add(a.x, a.y, c.offsetWidth * a.k, c.offsetHeight * a.k, 0.5, SIDE.pop, c.offsetHeight * a.k / 2)
              if (s) { s.z = card.z + 0.25; s.hinge = tilt }
            }
          }
          if (tilt && wallY !== null) standBands(id, { ...tilt, z: card.z }, wallY)
          const below = thick - per
          // Its cards show once they stand clear of each other: any thinner,
          // in the first degrees of tilt, their tops flicker through the
          // face, so the flat deck's edge lines stay till then.
          const slices = n > 1 && per * K >= 1 && below * K >= L * 0.75
          if (slices) hideEdges(el, spread - reserve)
          for (let j = 1; slices && j <= L; j++) {
            const s = add(lefty ? faceX - spread * j / L : at.x, at.y, w - reserve + spread * j / L, h, below / L, j % 2 ? SIDE.edge : SIDE.card, r)
            if (s) { s.z = base + below * (1 - (j - 1) / L); s.cap = true; s.hinge = tilt }
          }
        }
      }
      popParts(el, stage, card?.z ?? 0, m, detail(w), lifting, (part, z, t) => {
        const a = offsetIn(part, stage)
        if (!a) return
        const p = add(a.x, a.y, part.offsetWidth, part.offsetHeight, t, SIDE.pop, radiusOf(part))
        if (p) { p.z = z; p.pop = true; p.hinge = tilt }
        return p
      })
      if (card?.z) unshadow(el, K)
    }
    // Zoomed in to Blocks or Boards, a card is drawn as its outline.
    for (const el of stage.querySelectorAll<HTMLElement>('[data-group-outline]')) {
      const at = offsetIn(el, stage)
      if (!at) continue
      const w = el.offsetWidth, h = el.offsetHeight, m = Math.min(w, h)
      const s = add(at.x, at.y, w, h, m * THICK.card, SIDE.card, Math.min(12, m * 0.08))
      // On a strip in console it leans as it does as a card (Brian
      // 2026-11-01: at every zoom): its outline, its header and its
      // blocks, all on its bottom edge, standing on the strip's floor.
      // Linked to a storyline flipped up, it stands with the wall the same
      // way at every zoom, all of it as one piece: on the wall's foot (stage
      // px `wallY`), as on the card layer above.
      const id = el.dataset.groupOutline!
      const g = useBoardsStore.getState().groups.find(gr => gr.id === id)
      const footY = storyWallOf(id) ?? (g?.deckAnchorId ? storyWallOf(g.deckAnchorId) : null)
      const wallY = footY === null ? null : pan.y + footY * zoom
      const tip = wallY !== null ? Math.PI / 2 * standRise(useTiltStore.getState())
        : cardLean.get(id) ?? (g?.deckAnchorId ? cardLean.get(g.deckAnchorId) : undefined)
      const lift = wallY !== null ? 0 : docked.get(id) ?? (g?.deckAnchorId ? docked.get(g.deckAnchorId) : undefined)
      if (s && lift === undefined) {
        // Loose over a strip, on its top as a card (above).
        const resting = rest(`card:${id}`, restOn(at.x, at.y, w, h))
        if (resting <= 0) continue
        s.z = resting + s.t
        lifting.set(el, s.z)
        chain(el, stage)
        rested.set(id, s.z)
        continue
      }
      if (!s || !g || !tip || lift === undefined) continue
      s.z = lift + s.t
      const tilt: Hinge = { v: wallY !== null ? wallY - H / 2 : s.v + s.h / 2, z: s.z, a: tip }
      s.hinge = tilt
      lifting.set(el, s.z)
      chain(el, stage)
      stand(el, tilt, 1, wallY !== null ? `50% ${wallY - at.y}px` : undefined)
      // The line it turns up on: its bottom edge, or the wall's foot.
      const bottom = wallY ?? at.y + h
      // Its link chips, half over its bottom edge, up with it.
      const chips = wallY !== null ? stage.querySelector<HTMLElement>(`[data-primary-rail="${id}"]`) : null
      const ca = chips && offsetIn(chips, stage)
      if (chips && ca) {
        lifting.set(chips, s.z + 0.25)
        chain(chips, stage)
        stand(chips, { ...tilt, z: s.z + 0.25 }, 1, `50% ${bottom - ca.y}px`)
      }
      const head = stage.querySelector<HTMLElement>(`[data-card-header="${id}"]`)
      const hat = head && offsetIn(head, stage)
      if (hat) {
        lifting.set(head!, s.z + 0.5)
        chain(head!, stage)
        stand(head!, { ...tilt, z: s.z + 0.5 }, 1, `50% ${bottom - hat.y}px`)
      }
      const d = cardDock.get(id) ?? (g.deckAnchorId ? cardDock.get(g.deckAnchorId) : undefined)
      const strip = d && host.querySelector<HTMLElement>(`[data-freenode][data-id="${d.rail}"]`)
      // Flat it is a faint tint lying on the strip's floor. Stood up, that
      // tint was a pane of glass: the floor's marks, the strip's ring and
      // the pictures behind showed through the card in 3D alone (second
      // pass 2026-11-01). It takes the colour flat shows under it, the
      // strip's floor through its tint, solid as the lean comes in.
      if (strip) {
        const ground = strip.querySelector<HTMLElement>('[data-rail-ground]')
        const under = ground ? rgba(getComputedStyle(ground).backgroundColor) : [24, 24, 30, 1]
        const tint = rgba(getComputedStyle(el).backgroundColor)
        const shown = [0, 1, 2].map(i => Math.round(tint[i] * tint[3] + under[i] * (1 - tint[3])))
        const solid = Math.min(1, railStand.get(d.rail) ?? 1)
        fill(el, { rgb: [...shown, Math.round(solid * 1000) / 1000] })
      }
      for (const bid of g.boardIds) {
        // Boards zoom: its dashed block outlines, over the card as flat.
        const bo = stage.querySelector<HTMLElement>(`[data-block-outline="${bid}"]`)
        const bat = bo && offsetIn(bo, stage)
        if (bat) {
          lifting.set(bo!, s.z + 0.25)
          chain(bo!, stage)
          stand(bo!, { ...tilt, z: s.z + 0.25 }, 1, `50% ${bottom - bat.y}px`)
        }
        // Its block (Blocks zoom) or board (Boards zoom), in the world layer.
        const wrap = host.querySelector<HTMLElement>(`[data-layer-block="${bid}"]`)?.parentElement
          ?? host.querySelector<HTMLElement>(`[data-block][data-board-id="${bid}"]`)?.closest<HTMLElement>('[data-board]')
        const world = wrap && worlds.find(wd => wd.contains(wrap))
        // Not one torn off and carried: that one follows the cursor (its
        // own transform, not the one standing it wrote).
        if (!wrap || !world || (wrap.style.transform && wrap.style.transform !== stood.get(wrap)?.wrote)) continue
        const wat = offsetIn(wrap, world)
        if (!wat) continue
        lifting.set(wrap, s.z + 0.25)
        chain(wrap, world)
        stand(wrap, { ...tilt, z: s.z + 0.25 }, zoom, `50% ${(bottom - (pan.y + wat.y * zoom)) / zoom}px`)
        // Flat, the strip (the table the cards lie on) paints over the
        // block's picture and the board's bars: only what is stacked above
        // it shows, such as their headers. Stood with the card, only those
        // show. Shown whole, the pictures came up out of the strip in 3D
        // alone.
        if (strip) { veil(wrap, overStrip(wrap, strip)); buried.push(wrap) }
      }
      if (wallY !== null) standBands(id, { ...tilt, z: s.z }, wallY)
      if (d) leaning.push({ id, ...d, slab: s, hinge: tilt })
    }
    // A resting card's header tab over its top edge, and its link chips
    // half over its bottom edge: up with it, over its face as flat.
    for (const [id, z] of rested) {
      const head = stage.querySelector<HTMLElement>(`[data-card-header="${id}"]`)
      const hat = head && offsetIn(head, stage)
      if (!hat) continue
      lifting.set(head!, z + 0.5)
      chain(head!, stage)
      plate(hat.x, hat.y, head!.offsetWidth, head!.offsetHeight, z + 0.5, radiusOf(head!))
    }
    for (const rail of rested.size ? stage.querySelectorAll<HTMLElement>('[data-primary-rail]') : []) {
      const z = rested.get(rail.dataset.primaryRail ?? '')
      if (z === undefined) continue
      lifting.set(rail, z + 0.25)
      chain(rail, stage)
      for (const c of rail.querySelectorAll<HTMLElement>(':scope > * > *')) {
        const a = offsetScaled(c, stage)
        if (a) plate(a.x, a.y, c.offsetWidth * a.k, c.offsetHeight * a.k, z + 0.25, c.offsetHeight * a.k / 2)
      }
    }
  }
  // A block's header bar is drawn over a strip it lies across flat (the
  // block itself under the strip): in 3D it rests on the strip's top.
  const blockHeads: HTMLElement[] = []
  for (const world of crowns.length ? worlds : []) {
    for (const head of world.querySelectorAll<HTMLElement>('[data-block-head]')) {
      // Not one standing with its card's outline (above).
      if (head.parentElement && lifting.has(head.parentElement)) continue
      const a = offsetIn(head, world)
      if (!a) continue
      const x = pan.x + a.x * zoom, y = pan.y + a.y * zoom, w = head.offsetWidth * zoom, h = head.offsetHeight * zoom
      const r = rest(`head:${head.dataset.blockHead}`, restOn(x, y, w, h))
      if (r <= 0) continue
      lifting.set(head, r + 0.5)
      chain(head, world)
      blockHeads.push(head)
      plate(x, y, w, h, r + 0.5, radiusOf(head) * zoom)
    }
  }
  for (const m of colMarks) {
    const col = Object.values(useFreeNodeStore.getState().nodes)
      .filter(n => n.railDock?.railId === m.rail && n.railDock.slotId === m.slot && !n.railDock.lifted && n.id !== m.dragged)
      .sort((p, q) => (p.railDock!.order ?? 0) - (q.railDock!.order ?? 0))
    const at = col[Math.min(m.index, col.length - 1)]
    // Its card's top as the card layer stands it (0 drawn as an outline),
    // a hair over the floor at the least: its plates below must be proud.
    const z = Math.max(0.5, (at?.cardRef && cardTops.get(at.cardRef)) || 0)
    lifting.set(m.el, z)
    // Its line and dots each on a plate of their own that pick() sees
    // through, as the row's (above): up off the floor, without one the 3D
    // view drawn over the page would hide them.
    for (const part of m.el.children as HTMLCollectionOf<HTMLElement>) {
      const a = offsetIn(part, m.world)
      if (!a || !part.offsetWidth) continue
      const s = add(pan.x + a.x * zoom, pan.y + a.y * zoom, part.offsetWidth * zoom, part.offsetHeight * zoom, 0.5, DROP_RGB, Math.min(part.offsetWidth, part.offsetHeight) * zoom / 2, true)
      if (s) { s.z = z; s.nopick = true }
    }
  }
  // Fading in or out, everything raised stands that share of its height.
  if (K < 1) {
    for (const [el, z] of lifting) lifting.set(el, z * K)
    const hinges = new Set<Hinge>()
    for (const s of out) {
      s.t *= K
      if (s.z !== undefined) s.z *= K
      if (s.rim) s.rim = { ...s.rim, h: s.rim.h * K }
      if (s.hinge) hinges.add(s.hinge)
    }
    for (const h of hinges) h.z *= K
  }
  // Lifting a block's header makes its block keep 3D, and so stack as one
  // piece, header and all, under the strip (flat, the header's z-index puts
  // it over the strip). Planes within a hair of each other the browser
  // draws in stacking order, so in the first degrees the header went under
  // the strip: it stands at least that hair up.
  for (const el of blockHeads) lifting.set(el, Math.max(lifting.get(el) ?? 0, 0.2))
  // First in the list: past the slab budget it is the far, small things
  // that go, never the machine.
  out.unshift(...consoleFurniture(leaning, screens, decks, zoom, K))
  setLifts(lifting)
  standScreens(screens.map(s => s.id))
  // Artwork — pictures, videos, Viewer screens — read after the lifts are
  // set, so a lifted card's picture is masked at its height.
  lastArt = []
  // Only those in view: counted over the whole page, a big project's
  // pictures past the cap took the shadow and sheen meant to skip them
  // (darker and grainy in 3D).
  const art = (x: number, y: number, w: number, h: number, z: number, hinge?: Hinge) => {
    const u = x + w / 2 - W / 2, v = y + h / 2 - H / 2
    if (w < 12 || h < 12 || lastArt.length >= ART_MAX || !inView(u, v, w, h)) return
    lastArt.push({ u, v, w, h, z, hinge })
  }
  for (const world of host.querySelectorAll<HTMLElement>(':scope > div[style*="scale("]')) {
    for (const el of world.querySelectorAll<HTMLElement>(ART)) {
      // Not a picture hidden as under its strip: the shadows and the sheen
      // skipped where nothing of it shows.
      if (buried.some(b => b.contains(el)) && getComputedStyle(el).visibility === 'hidden') continue
      // A Viewer's picture is drawn through CounterScaled's scale(1/zoom),
      // which layout offsets ignore: offsetScaled undoes it.
      const at = offsetScaled(el, world)
      // On a leaning card or a standing Viewer, it stands with it.
      if (at) art(pan.x + at.x * zoom, pan.y + at.y * zoom, el.offsetWidth * at.k * zoom, el.offsetHeight * at.k * zoom, liftOf(el), hingeOf(el))
    }
  }
  if (stage) {
    for (const el of stage.querySelectorAll<HTMLElement>(ART)) {
      const at = offsetIn(el, stage)
      if (at) art(at.x, at.y, el.offsetWidth, el.offsetHeight, liftOf(el))
    }
  }
  // A standing card, tile or Viewer seen from behind shows its slab's back,
  // not its face: edge-on, the face drawn under the slab showed through as
  // a dotted line along it (a GIF's orange through the cast cards' backs).
  // Every point of its plane faces the eye alike, so its hinge line says.
  const eye = eyeOnPlane()
  const behind = new Set<HTMLElement>()
  for (const [el, { hinge: h }] of stood) {
    if (h.a > 0 && (eye.y - h.v) * Math.sin(h.a) + (eye.z - h.z) * Math.cos(h.a) < 0) behind.add(el)
  }
  turnAway(behind)
  restDone()
  return out
}
// A card face's picture can also be a background image.
const ART = 'img, video, canvas, [style*="background-image: url"]'
let lastArt: TiltArt[] = []
/** Standing faces seen from behind (see collectSlabs), see-through: what
 *  they showed before, and what was written. Opacity, not visibility, so
 *  a press on a card's back still finds the card, as from the front. */
let turned = new Map<HTMLElement, { was: string; wrote: string }>()
function turnAway(next: Set<HTMLElement>) {
  for (const [e, t] of turned) if (!next.has(e) && e.style.opacity === t.wrote) e.style.opacity = t.was
  const now = new Map<HTMLElement, { was: string; wrote: string }>()
  for (const e of next) {
    const t = turned.get(e)
    if (t && e.style.opacity === t.wrote) { now.set(e, t); continue }
    const was = e.style.opacity
    e.style.opacity = '0'
    now.set(e, { was, wrote: e.style.opacity })
  }
  turned = now
}
/** What lies loose over a strip (a card, its outline, a block's header):
 *  how high each rests (before the fade), by key, on the strip's top under
 *  it, as it rises and falls. The one pressed is held where it was, so
 *  dragged off a strip (or onto one) it stays at the height its drag is
 *  read at (TiltedView's remap); let go, it settles from there (`off`).
 *  A card carried is read on what is under it (heldAt): it lies on that,
 *  or on the strip's top over a strip, so it shows over what it is
 *  dragged across, as flat. */
const restEase = new Map<string, { z: number; off: number }>()
const restSeen = new Set<string>()
let restLast = 0, restDt = 0
/** What is held in the 3D view. TiltedView's input writes it; the 3D
 *  dressing here reads it. */
export const grip: {
  /** The rest key of what is pressed in the 3D view, if it rests. */
  heldRest: string | null
  /** How high the surface is that the card carried is read on (see rest),
   *  and where on the canvas (canvas units) it was read, till let go (see
   *  consoleLean). */
  heldAt: number | null
  handAt: { x: number; y: number } | null
  /** The standing Viewer being dragged by its header, if one is. */
  carried: string | null
} = { heldRest: null, heldAt: null, handAt: null, carried: null }
/** The rest key of the loose thing `el` is part of (see rest). */
export function restKeyOf(el: Element | null): string | null {
  const c = el?.closest<HTMLElement>('[data-group-card], [data-group-outline], [data-card-header]')
  if (c) return `card:${c.dataset.groupOutline ?? c.dataset.cardHeader ?? c.dataset.id}`
  const h = el?.closest<HTMLElement>('[data-block-head]')
  return h ? `head:${h.dataset.blockHead}` : null
}
function restTick() {
  const now = performance.now()
  restDt = Math.min(100, Math.max(0, now - restLast))
  restLast = now
}
function rest(key: string, goal: number): number {
  const was = restEase.get(key)
  const held = key === grip.heldRest
  if (!was && goal <= 0 && !(held && grip.heldAt)) return 0
  restSeen.add(key)
  let off = was ? was.off * Math.exp(-restDt / (CONSOLE.easeMs / 3)) : 0
  if (held) off = (grip.heldAt === null ? was?.z ?? 0 : Math.max(grip.heldAt, goal)) - goal
  else if (Math.abs(off) < 0.05) off = 0
  const z = goal + off
  if (z > 0 || off) restEase.set(key, { z, off }); else restEase.delete(key)
  return z
}
function restDone() {
  for (const k of restEase.keys()) if (!restSeen.has(k)) restEase.delete(k)
  restSeen.clear()
}
/** Where the eye is in the plane's own frame (flat px from the host
 *  centre, y down, z up off the plane): the camera of unprojectTilt. */
function eyeOnPlane(): { y: number; z: number } {
  const { tilt, spin, yaw, shiftX, shiftY } = useTiltStore.getState()
  const t = tilt * Math.PI / 180, s = spin * Math.PI / 180, b = yaw * Math.PI / 180
  const y1 = -shiftY * Math.cos(t) + TILT_PERSPECTIVE * Math.sin(t), z1 = shiftY * Math.sin(t) + TILT_PERSPECTIVE * Math.cos(t)
  const x0 = -shiftX * Math.cos(b) - z1 * Math.sin(b)
  return { y: -x0 * Math.sin(s) + y1 * Math.cos(s), z: -shiftX * Math.sin(b) + z1 * Math.cos(b) }
}

/** The bits of a face that stand proud of it when tilted, near enough:
 *  a tile's header bar, and on an effect face its on/off-solo-↑ buttons
 *  and its name banner. Raised by a share of the card's shorter side. */
const POP = 0.025
function popParts(root: HTMLElement, stage: HTMLElement, base: number, m: number, k: number,
                  lifting: Map<HTMLElement, number>, slab: (el: HTMLElement, z: number, t: number) => false | TiltSlab | undefined) {
  if (k <= 0) return
  const parts = new Set<HTMLElement>()
  // A tile's header, and a Viewer's (as an fx card's).
  const head = root.querySelector<HTMLElement>(':scope > [data-freenode-header], :scope > [data-viewer-chrome]')
  if (head) parts.add(head)
  for (const b of root.querySelectorAll<HTMLElement>('[data-fx-onoff], [data-fx-solo], [data-fx-drag-out], [data-card-face-arrow]')) parts.add(b)
  // A Viewer's buttons, its picture tools (outline, crop and the rest) among
  // them, stand up as pucks.
  if (root.hasAttribute('data-viewport3d')) for (const b of root.querySelectorAll<HTMLElement>('button')) parts.add(b)
  for (const b of root.querySelectorAll<HTMLElement>('select[aria-label="Effect"]')) {
    if (b.parentElement) parts.add(b.parentElement)
  }
  const t = m * POP * k
  for (const el of parts) {
    if (!el.offsetWidth || !el.offsetHeight) continue
    // A panel body laid out in canvas units (CanvasUnits) stays one flat
    // layer: a part raised in it would have it drawn at canvas size.
    if (el.closest('[data-canvas-units]')) continue
    const p = slab(el, base + t, t)
    if (p === false) continue
    // An effect's name (its picker's box): words, so no shine across them
    // (the second pass saw a grey box behind the name in 3D alone).
    if (p && el.querySelector(':scope > select[aria-label="Effect"]')) p.bare = true
    lifting.set(el, t)
    chain(el, stage)
    level(el, root, lifting)
    // One piece: the part's sides are the colour of its face, and a button's
    // ring goes the same colour, so no rim reads as a second disc on top.
    const face = fill(el)
    if (p && face) p.color = (face[0] << 16) | (face[1] << 8) | face[2]
  }
}

/** Chromium hit-tests a transformed box (a card's scaled text layer,
 *  data-card-text) inside a flat, untransformed one (the face's content
 *  area) at the wrong depth once its ancestors keep 3D: in the far half of
 *  the tilted view it outranks parts raised well above it, so a face arrow
 *  showed but never took the cursor or the press, and the press grabbed
 *  the card instead (Brian 2026-10-30). A zero lift on each box beside the
 *  raised part's path up to its card makes that box a plane of its own,
 *  hit where it really is. Cleared with the other lifts when flat. */
function level(part: HTMLElement, root: HTMLElement, lifting: Map<HTMLElement, number>) {
  for (let e = part.parentElement; e && e !== root.parentElement; e = e.parentElement) {
    for (const c of e.children) {
      const h = c as HTMLElement
      if (h === part || h.contains(part) || lifting.has(h)) continue
      lifting.set(h, 0)
    }
  }
}

/** The boxes (world units) of the cards stacked over docked tile `id` in
 *  its strip column: the ones after it, which stand higher. */
function coversOf(id: string | undefined): { x: number; y: number; width: number; height: number }[] {
  const nodes = useFreeNodeStore.getState().nodes
  const d = id ? nodes[id]?.railDock : undefined
  if (!d || d.lifted) return []
  return Object.values(nodes).filter(o => o.id !== id && o.railDock && !o.railDock.lifted &&
    o.railDock.railId === d.railId && o.railDock.slotId === d.slotId && (o.railDock.order ?? 0) > (d.order ?? 0))
}

/** The parts of `el` (a docked card's block or board, in the world layer)
 *  that the flat view paints over its `strip`: what is stacked above it (a
 *  header at 30, a hovered or selected bar, a block's pen and its resize
 *  grips). A positioned box with a z-index is painted whole at it; any
 *  other box that stacks its contents (a transform, a filter, opacity)
 *  whole at 0, under the strip; the rest are looked into. At the strip's
 *  own z-index, what comes after it in the page is over it. */
function overStrip(el: HTMLElement, strip: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  const z0 = parseInt(getComputedStyle(strip).zIndex) || 0
  const after = !!(strip.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
  const look = (box: Element) => {
    for (const c of box.children) {
      const cs = getComputedStyle(c)
      if (cs.display === 'none') continue
      if (cs.position !== 'static' && cs.zIndex !== 'auto') {
        const z = parseInt(cs.zIndex)
        if (z > z0 || (z === z0 && after)) out.push(c as HTMLElement)
      } else if (cs.transform === 'none' && cs.filter === 'none' && parseFloat(cs.opacity) >= 1) look(c)
    }
  }
  look(el)
  return out
}

/** Hidden while tilted, all of `el` but the parts `shown` (each with what
 *  it holds): visibility, so they keep the order they paint in flat on the
 *  one plane `el` stands as. Put back flat, and for the flat view's hit
 *  tests (layFlat), where the hidden parts are there to be found. */
export let veiled = new Map<HTMLElement, string>()
let veiling = new Map<HTMLElement, string>()
function veil(el: HTMLElement, shown: HTMLElement[]) {
  for (const [e, v] of [[el, 'hidden'] as const, ...shown.map(p => [p, 'visible'] as const)]) {
    veiling.set(e, veiled.get(e) ?? e.style.visibility)
    if (e.style.visibility !== v) e.style.visibility = v
  }
}

/** For a raised bit to really stand off its face, every box between it and
 *  the stage has to keep its children in 3D (preserve-3d), and none may
 *  clip: overflow hidden (and clip, in Chromium) flattens them back onto
 *  the face. So those boxes stop clipping while tilted; tilting flat
 *  restores them. */
export let chained = new Map<HTMLElement, { ts: string; ov: string }>()
let chaining = new Map<HTMLElement, { ts: string; ov: string }>()
function chain(el: HTMLElement, stage: HTMLElement) {
  for (let e = el.parentElement; e && e !== stage; e = e.parentElement) {
    if (chaining.has(e)) continue
    const was = chained.get(e) ?? { ts: e.style.transformStyle, ov: e.style.overflow }
    chaining.set(e, was)
    if (!chained.has(e)) {
      e.style.transformStyle = 'preserve-3d'
      if (getComputedStyle(e).overflow !== 'visible') e.style.overflow = 'visible'
    }
  }
}
/** The flat canvas the tipped camera sees (px from the host's middle, with
 *  a margin), from a grid of screen points taken down to it; null flat. */
function seenGround(W: number, H: number): { x0: number; x1: number; y0: number; y1: number } | null {
  const { tilt, yaw, spin, shiftX, shiftY } = useTiltStore.getState()
  if (offFlat({ tilt, yaw }) < 0.5) return null
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
    const q = unprojectTilt((i / 8 - 0.5) * W, (j / 8 - 0.5) * H, tilt, spin, shiftX, shiftY, 0, TILT_FAR)
    if (!q) continue
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y)
  }
  if (x0 > x1) return null
  const m = Math.max(W, H) * 0.5
  return { x0: x0 - m, x1: x1 + m, y0: y0 - m, y1: y1 + m }
}
/** A raised part has to be solid: one with a see-through background would
 *  show the face under it through its lid. While raised it is filled with
 *  the colour it shows flat (its own over what is behind it). */
type Styled = 'boxShadow' | 'borderRadius' | 'borderTopColor' | 'borderRightColor' | 'borderBottomColor' | 'borderLeftColor' | 'backgroundColor'
/** What it showed before (`was`), and what was last written here (`wrote`,
 *  as the browser reads it back), by style. A border's colour is kept side
 *  by side: a Viewer's header has only top, left and right set, so its
 *  shorthand reads '', and put back as that it wiped all three. `rim`: each
 *  border's colour as it is flat. */
type Filled = { rgb: number[]; was: Partial<Record<Styled, string>>; wrote: Partial<Record<Styled, string>>; rim?: Partial<Record<Styled, number[]>> }
export let filled = new Map<HTMLElement, Filled>()
let filling = new Map<HTMLElement, Filled>()
/** Write `v` to `el`'s style `prop`, kept in `f`. Anything else there now
 *  was React's since (a tab's warning underline coming or going): that is
 *  what it shows flat from now on, under the fill. */
function restyle(el: HTMLElement, f: Filled, prop: Styled, v: (base: string) => string) {
  if (!(prop in f.was) || (f.wrote[prop] !== undefined && el.style[prop] !== f.wrote[prop])) f.was[prop] = el.style[prop]
  setStyle(el, prop, v(f.was[prop] ?? ''))
  f.wrote[prop] = el.style[prop]
}
const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const
/** `as`: filled with this colour instead, and with `round`, made a pill
 *  (console mode's Run button). */
function fill(el: HTMLElement, as?: { rgb: number[]; round?: boolean }): number[] {
  // Read again each frame: a toggle's colour changes as it is pressed.
  const was: Filled = filled.get(el) ?? { rgb: [0, 0, 0], was: {}, wrote: {} }
  filling.set(el, was)
  if (as) {
    was.rgb = as.rgb
    restyle(el, was, 'boxShadow', bs => `inset 0 0 0 9999px rgb(${as.rgb.join(',')})${bs ? ', ' + bs : ''}`)
    if (as.round) restyle(el, was, 'borderRadius', () => `${el.offsetHeight / 2}px`)
    return was.rgb
  }
  const cs = getComputedStyle(el)
  const own = rgba(cs.backgroundColor)
  // Down through every see-through box behind it to the first solid one:
  // a Viewer's pin and x show its header's colour, not a darker square of
  // the canvas under it.
  const behind: number[][] = []
  for (let e = el.parentElement; own[3] < 1 && e; e = e.parentElement) {
    // A strip's body shows its outline colour; inside it, its ground.
    const c = rgba(getComputedStyle(e.querySelector<HTMLElement>(':scope > [data-rail-ground]') ?? e).backgroundColor)
    if (c[3] > 0) behind.push(c)
    if (c[3] >= 1) break
  }
  const over = (c: number[], under: number[]) => [0, 1, 2].map(i => c[i] * c[3] + under[i] * (1 - c[3]))
  const shown = [...behind.reverse(), own].reduce((under, c) => over(c, under), [24, 24, 30])
  was.rgb = shown.map(Math.round)
  const css = `rgb(${was.rgb.join(',')})`
  // Painted as an inset shadow over the background, not as the background
  // itself, which React owns (a toggle sets it as it is pressed).
  restyle(el, was, 'boxShadow', bs => (own[3] < 1 ? `inset 0 0 0 9999px ${css}${bs ? ', ' + bs : ''}` : bs))
  // Its outline stays, as flat shows it over the fill, made solid too: a
  // Viewer's tool buttons and its header's edge read as they do flat. Its
  // flat colour is read while it is React's (not yet written here, or
  // changed since), as React set it: the browser's own reading can be
  // halfway through a fade (the Viewer header's, as it is hovered). After
  // that it is ours, and so kept.
  for (const side of SIDES) {
    const prop = `border${side}Color` as const
    if (!(parseFloat(cs[`border${side}Width`]) > 0)) continue
    const set = el.style[prop]
    if (set !== was.wrote[prop]) (was.rim ??= {})[prop] = rgba(/^rgba?\(/.test(set) ? set : cs[prop])
    const c = was.rim?.[prop] ?? [0, 0, 0, 0]
    restyle(el, was, prop, () => `rgb(${over(c, shown).map(Math.round).join(',')})`)
  }
  return was.rgb
}
/** Console: a standing strip's floor, from its flat ground colour to the
 *  machine's lit slate by `s` (how far it stands), so it grows in and out
 *  with the lean. Its own colour, not a shadow laid over it: a fill is
 *  cheap to draw, where an inset shadow made every tile of a big strip
 *  raster again. Put back when it lies flat (settleChains). */
function floorTint(el: HTMLElement, s: number) {
  const f: Filled = filled.get(el) ?? { rgb: [0, 0, 0], was: {}, wrote: {} }
  filling.set(el, f)
  restyle(el, f, 'backgroundColor', base => {
    const b = rgba(base || getComputedStyle(el).backgroundColor)
    return `rgb(${DECK.floor.map((c, i) => Math.round(b[i] + (c - b[i]) * s)).join(',')})`
  })
}
/** A raised card's drop shadow (its dark box-shadow, a deck's on its front
 *  card) fades out as the 3D look comes in, by `K`: drawn in the card's own
 *  plane, on a leaning card it hung out over the pictures behind it and
 *  darkened them. The light's shadows take its place. A coloured glow (the
 *  selection's) stays. */
const DARK = /rgba?\(0, 0, 0(?:, ([\d.]+))?\)/
const unshadowed = new WeakSet<Filled>()
function unshadow(card: HTMLElement, K: number) {
  for (const el of [card, ...card.children] as HTMLElement[]) {
    // A raised part is fill()'s (popParts, run first).
    if (filling.has(el)) continue
    let f = filled.get(el)
    if (f ? !unshadowed.has(f) : !DARK.test(el.style.boxShadow)) continue
    if (!f) unshadowed.add(f = { rgb: [0, 0, 0], was: {}, wrote: {} })
    filling.set(el, f)
    restyle(el, f, 'boxShadow', bs => bs.split(/,(?![^(]*\))/)
      .map(s => s.replace(DARK, (_, a) => `rgba(0, 0, 0, ${(Number(a ?? 1) * (1 - K)).toFixed(3)})`))
      .filter(s => !/rgba\(0, 0, 0, 0\.000\)/.test(s)).join(','))
  }
}
/** A fanned deck stands up too: its front card on top, and each strip
 *  peeking out to the right (or the left, a deck opened away from a
 *  storyline) a card lower than the one before, a stair of
 *  cards down to the canvas. The strips follow their slide as the fan
 *  opens or closes (their animated transform). Everything else on the
 *  fan (the face it surfaces, its controls) rides at the front card's
 *  height, on top. */
type AddSlab = (x: number, y: number, w: number, h: number, t: number, color: number, r: number) => TiltSlab | undefined
function fanSlabs(el: HTMLElement, stage: HTMLElement, at: { x: number; y: number }, add: AddSlab,
                  lifting: Map<HTMLElement, number>, lift: number | undefined, head?: HTMLElement,
                  wall?: { v: number; y: number; a: number }): number | undefined {
  const kids = [...el.children].filter(c => (c as HTMLElement).matches('[data-card-drop], [data-deck-slot-drop]')) as HTMLElement[]
  if (!kids.length) return undefined
  const front = kids.find(c => c.dataset.fanFront) ?? kids.reduce((a, b) => (b.offsetLeft === 0 && b.offsetWidth >= a.offsetWidth ? b : a))
  // Nearest the front card first, whichever side they run out on.
  const strips = kids.filter(c => c !== front).sort((a, b) => Math.abs(a.offsetLeft - front.offsetLeft) - Math.abs(b.offsetLeft - front.offsetLeft))
  const w = front.offsetWidth, h = front.offsetHeight, m = Math.min(w, h)
  const k = lift === undefined ? detail(w) : 1
  const base = lift ?? 0
  // Standing on a storyline's wall (stage px `wall.y` its foot): the whole
  // fan turns up on it, as a stacked deck does, its pages proud of it.
  const hinge: Hinge | undefined = wall && { v: wall.v, z: base, a: wall.a }
  if (hinge) stand(el, hinge, 1, `50% ${wall!.y - at.y}px`)
  if (k <= 0) {
    const s = add(at.x + front.offsetLeft, at.y + front.offsetTop, w, h, m * THICK.card, SIDE.card, 12)
    if (s) s.hinge = hinge
    return base + m * THICK.card
  }
  const per = m * THICK.card * k
  const top = base + per * (strips.length + 1)
  // The wrapper stays at the deck's base and its children rise from it:
  // a lifted wrapper (it takes the pointer) would sit over the lowered
  // strips and steal their hover, so a strip would never surface.
  if (base) lifting.set(el, base)
  chain(el, stage)
  for (const c of el.children) if (!strips.includes(c as HTMLElement)) { lifting.set(c as HTMLElement, top - base); chain(c as HTMLElement, stage) }
  // Its name band over its front card, as flat (band 51, fan 50).
  if (head) {
    const ha = hinge && offsetIn(head, stage)
    if (ha) {
      // On a wall it turns up as the fan does, on the same foot, and its
      // contents ride proud of it as the front card does inside the fan:
      // turned up on its own lifted foot, it stood behind the front card,
      // hidden.
      lifting.set(head, base); chain(head, stage)
      stand(head, hinge!, 1, `50% ${wall!.y - ha.y}px`)
      for (const hc of head.children) { lifting.set(hc as HTMLElement, top + 1 - base); chain(hc as HTMLElement, stage) }
    } else { lifting.set(head, top + 1); chain(head, stage) }
  }
  const c = add(at.x + front.offsetLeft, at.y + front.offsetTop, w, h, top - base, SIDE.card, radiusOf(front) || 12)
  if (c) { c.z = top; c.hinge = hinge }
  strips.forEach((st, i) => {
    const z = top - per * (i + 1)
    lifting.set(st, z - base)
    chain(st, stage)
    const mx = new DOMMatrix(getComputedStyle(st).transform)
    const s = add(at.x + st.offsetLeft + mx.m41, at.y + st.offsetTop, st.offsetWidth * mx.a, st.offsetHeight, z - base,
      i % 2 ? SIDE.card : SIDE.edge, 6)
    if (s) { s.z = z; s.hinge = hinge }
  })
  return top
}

/** Where a card comes in the flat view's paint order among the cards: the
 *  outermost z-index it sits under (a fanned deck's bundle, 55, is over the
 *  plain cards' 40). Page order settles the rest. */
function paintZ(el: HTMLElement, stage: HTMLElement): number {
  let z = 0
  for (let e: HTMLElement | null = el; e && e !== stage; e = e.parentElement) {
    const v = parseInt(e.style.zIndex)
    if (!isNaN(v)) z = v
  }
  return z
}

/** Invisible hit zones laid over a card (an opened deck's front card has
 *  one: its double-click closes the deck). Flat, they sit above the card
 *  by z-index; tilted, the card stands up through them, so a zone over a
 *  raised card is raised with it, a hair above, and takes its clicks as it
 *  does flat. */
function hitZones(stage: HTMLElement): { el: HTMLElement; at: { x: number; y: number } }[] {
  const out: { el: HTMLElement; at: { x: number; y: number } }[] = []
  for (const el of stage.querySelectorAll<HTMLElement>('div[style*="pointer-events: all"]')) {
    if (el.childElementCount || el.closest('[data-group-card]') || el.hasAttribute('data-freenode')) continue
    const at = offsetIn(el, stage)
    if (at) out.push({ el, at })
  }
  return out
}
function riseZones(zones: ReturnType<typeof hitZones>, at: { x: number; y: number }, w: number, h: number, z: number,
                   lifting: Map<HTMLElement, number>, stage: HTMLElement, hinge?: Hinge, hingeY?: number) {
  for (const zn of zones) {
    if (Math.abs(zn.at.x - at.x) > 1 || Math.abs(zn.at.y - at.y) > 1 || Math.abs(zn.el.offsetWidth - w) > 1 || Math.abs(zn.el.offsetHeight - h) > 1) continue
    lifting.set(zn.el, z + 0.5)
    chain(zn.el, stage)
    // On a leaning card, it leans with it (on its hinge line, `hingeY` stage
    // px, when that is not the card's own bottom edge).
    if (hinge) stand(zn.el, { ...hinge, z: z + 0.5 }, 1, hingeY !== undefined ? `50% ${hingeY - zn.at.y}px` : undefined)
  }
}

/** A closed deck's flat edge lines (its outline children, which take no
 *  clicks) give way to the modelled edges while it stands up. */
let hidden = new Set<HTMLElement>()
let hiding = new Set<HTMLElement>()
export let widened = new Map<HTMLElement, string>()
let widening = new Map<HTMLElement, string>()
/** Hide a stacked deck's flat edge lines (its slices draw them in 3D) and
 *  stretch its click-to-fan strip `reach` px further out, over the pages
 *  that step out past it (on the left the strip is held by its right side,
 *  so it grows leftward). */
function hideEdges(deck: HTMLElement, reach = 0) {
  for (const c of deck.children) {
    const e = c as HTMLElement
    if (e.dataset.fanEdge || (e.style.cursor === 'pointer' && e.style.pointerEvents === 'all' && e.offsetLeft > deck.offsetWidth / 2)) {
      const was = widened.get(e) ?? e.style.width
      widening.set(e, was)
      setStyle(e, 'width', `${(parseFloat(was) || 0) + reach}px`)
      continue
    }
    if (e.style.pointerEvents !== 'none' || e.offsetWidth > 16) continue
    hiding.add(e)
    if (!hidden.has(e)) e.style.visibility = 'hidden'
  }
}
function rgba(css: string): number[] {
  const n = css.match(/[\d.]+/g)?.map(Number) ?? []
  return n.length >= 3 ? [n[0], n[1], n[2], n[3] ?? 1] : [0, 0, 0, 0]
}
function settleChains() {
  for (const [e, f] of filled) {
    if (filling.has(e)) continue
    // Only what was written here goes back: React may have set it since.
    for (const prop of Object.keys(f.wrote) as Styled[]) if (e.style[prop] === f.wrote[prop]) e.style[prop] = f.was[prop] ?? ''
  }
  for (const e of hidden) if (!hiding.has(e)) e.style.visibility = ''
  hidden = hiding
  hiding = new Set()
  for (const [e, was] of veiled) if (!veiling.has(e)) e.style.visibility = was
  veiled = veiling
  veiling = new Map()
  for (const [e, was] of widened) if (!widening.has(e)) e.style.width = was
  widened = widening
  widening = new Map()
  filled = filling
  filling = new Map()
  for (const [e, was] of chained) {
    if (chaining.has(e)) continue
    e.style.transformStyle = was.ts
    e.style.overflow = was.ov
  }
  chained = chaining
  chaining = new Map()
}

/** How a loop strip reads as a tray, in its own units (and cards'
 *  thickness inside it as a share of their shorter side). */
const TRAY = { rimW: 6, rimH: 7, card: 0.03, stack: 0.9, band: 2.2 }
/** How far a docked card's underside stands off the strip's floor: a share
 *  of its size, so it keeps its proportions at every zoom. GAP px at the
 *  least, so the two faces are never level and never flicker: 6 px here made
 *  a far-off card up to 4x too thick, popping in when a wheel zoom rested
 *  (Brian 2026-11-02). */
const GAP = 1
function dockLift(m: number, order: number): number {
  return Math.max(GAP, m * TRAY.card) * (1 + order * TRAY.stack)
}

/** Detail by distance: how much of the raised 3D (rims, lifts) a thing
 *  shows, by its width on screen — none below DETAIL_FROM px, all of it
 *  from DETAIL_FULL px, eased between. A wheel zoom's glide counts: that is
 *  the width it shows, and when the wheel rests nothing changes. */
const DETAIL_FROM = 36, DETAIL_FULL = 80, DETAIL_TILT = 6
function detail(screenW: number): number {
  const w = screenW * (useTiltStore.getState().glide?.k ?? 1)
  const x = Math.max(0, Math.min(1, (w - DETAIL_FROM) / (DETAIL_FULL - DETAIL_FROM)))
  // And by tilt: the raised parts grow out of the face over the first
  // DETAIL_TILT degrees, so tipping in or out of 3D never pops them.
  const y = Math.min(1, offFlat(useTiltStore.getState()) / DETAIL_TILT)
  return x * x * (3 - 2 * x) * y * y * (3 - 2 * y)
}

/** Console mode: which docked effect tiles lean back, and by how much
 *  (radians), by tile id. Each strip eases between standing and flat:
 *  flat while something is dragged off it or onto it (Brian's rule: 3D
 *  works exactly as 2D, so a drop is judged on the flat strip). */
export const consoleEase = new Map<string, number>()
let consoleAt = 0
function consoleLean(host: HTMLElement, zoom: number): Map<string, number> {
  const out = new Map<string, number>()
  const { console: on } = useTiltStore.getState()
  const tilt = standTilt(useTiltStore.getState())
  const now = performance.now()
  const dt = Math.min(100, Math.max(0, now - consoleAt))
  consoleAt = now
  const x = Math.max(0, Math.min(1, (tilt - CONSOLE.from) / (FADE_TILT - CONSOLE.from)))
  const grown = x * x * (3 - 2 * x)
  const nodes = useFreeNodeStore.getState().nodes
  const drop = useRailUiStore.getState().drop
  const seen = new Set<string>()
  // Where things are on the flat plane, px from the host's centre (as
  // collectSlabs reads them), for nearFit.
  const { pan } = useCanvasStore.getState()
  const W = host.offsetWidth, H = host.offsetHeight
  /** Each strip's own ease (held flat or not, console on or off) and its
   *  detail: what its Viewer follows. */
  const standing = new Map<string, { e: number; k: number }>()
  railStand.clear()
  leanOf.clear()
  for (const n of Object.values(nodes)) {
    const r = n.rail
    if (!r || n.pin) continue
    seen.add(n.id)
    // Not for one of its own columns moved along it by its tab: that tab
    // rides its card, in line with the others, so the drag reads along
    // the standing row (folding, the row fell away from the cursor).
    const own = drop && [...r.slots, ...(r.rows ?? []).flat()].some(sl => sl.id === drop.draggedId)
    const held = (drop?.target.railId === n.id && !own) ||
      Object.values(nodes).some(o => o.railDock?.railId === n.id && o.railDock.lifted) ||
      // Begun lying down for a card carried onto it, it stays down while
      // the card is over it: lying down, it shows the cursor further back on
      // it than the leaning face did. Stood back up for that, the face came
      // back under the cursor and it lay down again, over and over.
      (!!grip.handAt && (consoleEase.get(n.id) ?? 1) < 1 &&
        grip.handAt.x >= n.x && grip.handAt.x <= n.x + n.width && grip.handAt.y >= n.y && grip.handAt.y <= n.y + n.height)
    const goal = on && !held ? 1 : 0
    // One that turns up while it stands (pasted, undone back) rises as the
    // others would; at the start of a tilt they all rise with it.
    const was = consoleEase.get(n.id) ?? (grown > 0 ? 0 : goal)
    const e = goal > was ? Math.min(goal, was + dt / CONSOLE.easeMs) : Math.max(goal, was - dt / CONSOLE.easeMs)
    consoleEase.set(n.id, e)
    if (e <= 0) continue
    const body = host.querySelector<HTMLElement>(`[data-freenode][data-id="${n.id}"] [data-rail-body]`)
    const k = body ? detail(body.offsetWidth * zoom) : 0
    standing.set(n.id, { e, k })
    // One angle for all of it, whatever the camera does: it is grown in out
    // of the flat view as the camera leaves the top and that is all. Seen
    // from lower, it faces you more, as a real thing on a table does. (Only
    // with the eye right up against it does it lean less: nearFit.)
    const s = grown * k * e * e * (3 - 2 * e)
    if (s <= 0) continue
    railStand.set(n.id, s)
    // Everything docked on it leans back, the cast and the results as the
    // effects (Brian 2026-11-01): each card on its own bottom edge, a
    // column's cards parallel, one behind the other.
    const docked = Object.values(nodes).filter(t => t.railDock?.railId === n.id && !t.railDock.lifted)
    // One angle for the whole strip (its rack is one plane behind them
    // all): as far back as its nearest card may lean (nearFit). A card's
    // stand-in is where the card layer draws the card.
    const full = CONSOLE.slot * s * Math.PI / 180
    let a = full
    for (const t of docked) {
      const m = Math.min(t.width, t.height) * zoom
      a = Math.min(a, nearFit(full, pan.x + t.x * zoom - W / 2, pan.x + (t.x + t.width) * zoom - W / 2, pan.y + (t.y + t.height) * zoom - H / 2,
        dockLift(m, t.railDock!.order ?? 0) * k + m * THICK.card, t.height * zoom))
    }
    // The live preview at the results' head leans with them (collectSlabs).
    const ghost = host.querySelector<HTMLElement>(`[data-rail-overlay="${n.id}"] [data-rail-ghost]`)
    let world = ghost?.parentElement
    while (world && world.parentElement !== host) world = world.parentElement
    const ga = ghost && world && ghost.offsetWidth ? offsetIn(ghost, world) : null
    if (ga) {
      const gw = ghost!.offsetWidth * zoom, gh = ghost!.offsetHeight * zoom
      a = Math.min(a, nearFit(full, pan.x + ga.x * zoom - W / 2, pan.x + ga.x * zoom + gw - W / 2, pan.y + ga.y * zoom + gh - H / 2,
        dockLift(Math.min(gw, gh), 0) * k, gh))
    }
    leanOf.set(n.id, a)
    for (const t of docked) out.set(t.id, a)
  }
  for (const id of consoleEase.keys()) if (!seen.has(id)) consoleEase.delete(id)
  // A Viewer stands while the strip it shows does, easing on its own (it
  // can be pulled off its strip, or a strip docked to it), and rises and
  // lies down with the tilt as its strip's cards do.
  const shown = new Map<string, { e: number; k: number }>()
  const windows = useViewport3DStore.getState().windows
  for (const [wid, docked] of railViewerDocks(nodes, windows, zoom)) {
    const rid = viewerRail(docked, useRailUiStore.getState().active)
    const st = rid && standing.get(rid)
    if (st) shown.set(wid, st)
  }
  for (const wid of new Set([...shown.keys(), ...screenEase.keys()])) {
    const sh = shown.get(wid), last = screenEase.get(wid)
    const was = last?.e ?? (grown > 0 ? 0 : sh?.e ?? 0)
    // Carried by its header, it stays as it is till let go (taken off its
    // strip, it lies down then).
    const goal = grip.carried === wid ? was : sh?.e ?? 0
    const e = goal > was ? Math.min(goal, was + dt / CONSOLE.easeMs) : Math.max(goal, was - dt / CONSOLE.easeMs)
    const k = sh?.k ?? last?.k ?? 0
    if (e <= 0 && goal <= 0) screenEase.delete(wid); else screenEase.set(wid, { e, k })
    const s = grown * k * e * e * (3 - 2 * e)
    const w = windows[wid]
    if (s <= 0 || !w || w.pin) continue
    // Its box takes in its header, a strip of fixed screen px above it.
    const vr = viewportVisualRect(w, zoom), m = Math.min(vr.width, vr.height) * zoom
    out.set(wid, nearFit(CONSOLE.viewer * s * Math.PI / 180, pan.x + vr.x * zoom - W / 2, pan.x + (vr.x + vr.width) * zoom - W / 2,
      pan.y + (vr.y + vr.height) * zoom - H / 2, m * THICK.viewer, vr.height * zoom))
  }
  return out
}
const screenEase = new Map<string, { e: number; k: number }>()
/** How far up each console strip stands this frame, 0..1, by id. */
const railStand = new Map<string, number>()
/** Each standing strip's lean this frame (radians), by id. */
const leanOf = new Map<string, number>()
/** How far a lean `a` (radians) has grown in, 0..1, out of `full` (the
 *  lean at all the way up, degrees). Laid lower by nearFit, the furniture
 *  and the tabs riding on the cards go with the angle, as when growing in. */
function grownIn(a: number, full: number): number {
  return Math.min(1, a / (full * Math.PI / 180))
}

/** How near the eye a standing piece may come, as a share of the eye's
 *  distance to the screen (TILT_PERSPECTIVE), and how far short of its
 *  nearest a piece seen from behind starts to give way (nearFit). */
const NEAR = 0.2, BEND = Math.PI / 6
/** Console: how far back (radians, up to `full`) a piece standing on its
 *  bottom edge may lean and still be wholly in front of the eye with NEAR
 *  to spare. Its bottom edge runs `x0`..`x1` at flat `v` (px from the host
 *  centre, as collectSlabs reads it), `z` up, and it is `h` long. The lean
 *  is a fixed angle (Brian: the same from every camera angle), but what
 *  stands grows with the zoom while the eye stays put: zoomed in close, a
 *  68 deg Viewer rose past the eye and the browser drew none of it (it
 *  drops a layer that reaches the camera), the leaning cards the same.
 *  So only when a piece would come that near does it lean less, just
 *  enough, and back up as you zoom out or turn away. Read off the camera
 *  as tiltCss places it, a wheel zoom's glide too, so it follows the zoom
 *  and the orbit smoothly; the three.js slabs and furniture take the same
 *  angle from the hinge. */
function nearFit(full: number, x0: number, x1: number, v: number, z: number, h: number): number {
  const { tilt, spin, yaw, glide } = useTiltStore.getState()
  const P = TILT_PERSPECTIVE
  const t = tilt * Math.PI / 180, sp = spin * Math.PI / 180
  const st = Math.sin(t), ct = Math.cos(t), ss = Math.sin(sp), cs = Math.cos(sp)
  const by = yaw * Math.PI / 180, sb = Math.sin(by), cb = Math.cos(by)
  const k = glide?.k ?? 1, gx = glide?.x ?? 0, gy = glide?.y ?? 0
  // How far towards the eye a point on the bottom edge is drawn (CSS z,
  // after the glide's scale and the tilt); its nearer end counts.
  const toward = (x: number) => {
    const X = gx + k * (x - gx), Y = gy + k * (v - gy)
    return (X * ss + Y * cs) * st + (-(X * cs - Y * ss) * sb + k * z * cb) * ct
  }
  const near = Math.max(toward(x0), toward(x1))
  // With its bottom edge itself that near, no angle keeps it all in front:
  // it lies down as the edge comes on, flat by the time the edge reaches
  // the eye. Stood up across the eye it was dropped; lying on the floor,
  // as the canvas does, it is still drawn.
  const most = full * Math.max(0, Math.min(1, (P - near) / (NEAR * P)))
  if (k * h < 1e-3) return most
  // Leaning back by `a`, its top edge comes k·h·f(a) nearer than its
  // bottom edge, f(a) = sin a cos t - cos a cos(spin) sin t = R sin(a - th):
  // seen from the front it rises towards the eye as it stands up. The top
  // goes no nearer than NEAR, nor than the bottom edge once that is nearer.
  const q = Math.max(0, (1 - NEAR) * P - near) / (k * h)
  const R = Math.hypot(ct, cs * st), th = Math.atan2(cs * st, ct)
  // Seen from behind, it leans towards the eye, nearest at th + 90 deg and
  // less near past that, so standing a little less brought it nearer and
  // the angle had to drop a long way at once. Over the last BEND before
  // that it counts as nearer than it is, rising straight on, so the angle
  // always gives way smoothly as you come close.
  const bend = th + Math.PI / 2 - BEND, rise = R * Math.sin(BEND), atBend = R * Math.cos(BEND)
  const need = (a: number) => a <= bend ? R * Math.sin(a - th) : atBend + rise * (a - bend)
  if (need(most) <= q) return most
  if (q >= atBend) return Math.max(0, bend + (q - atBend) / rise)
  return Math.max(0, th + Math.asin(q / R))
}
/** The Viewers standing this frame: their GL bodies are not drawn (they
 *  would stay on the floor where the Viewer lay). */
let stoodScreens: string[] = []
function standScreens(ids: string[]) {
  if (ids.join() === stoodScreens.join()) return
  stoodScreens = ids
  setGlHidden(ids)
}

/** Console mode (Brian 2026-10-30: the strip as the mockup's machine): the
 *  strip's effect cards lean back off its floor on their bottom edges, as
 *  on a sloped panel; its cast and results stay down in their columns.
 *  Degrees up from the floor. They rise from `from` degrees of tilt, full
 *  by FADE_TILT, and a strip eases down flat over `easeMs` while something
 *  is dragged onto it, so every drop lands by the flat view's rules. */
const CONSOLE = { slot: 45, viewer: 68, strutAt: 0.62, from: 4, easeMs: 220 }
/** Console's Run pill: the strip's own Run orange. */
const RUN_RGB = parseInt(RAIL_COLORS.orange.slice(1), 16)
const RUN_RGB_A = [RUN_RGB >> 16, (RUN_RGB >> 8) & 255, RUN_RGB & 255]
/** The strip's drop mark blue, for the sides of its plates. */
const DROP_RGB = parseInt(RAIL_COLORS.drop.slice(1), 16)
/** A project cabinet standing: degrees up from the canvas, its depth × width. */
const CABINET = { stand: 85, depth: 0.45, rim: 0.012, rimH: 0.35 }
/** A leaning card, and the flat top of its tab riding with it, if any. */
type Leaning = { id: string; rail: string; slot: string; order: number; slab: TiltSlab; hinge: Hinge; top?: number; main?: boolean }
/** A console strip's deck: the raised top its header bar and loop strip
 *  bar stand on, `D` px up (before the fade), from its back inside the rim
 *  (`back`) to the header bar's front edge (`front`), across `x0`..`x1`
 *  (flat px from the centre); `s` how far up the strip stands, `u` its
 *  unit on screen, `band` the header bar's own span. */
type Deck = { rail: string; D: number; A: number; s: number; u: number; front: number; back: number; x0: number; x1: number; band: { v0: number; v1: number } }
/** The deck's height over the cards' tops, and the loop strip bar's step
 *  up behind the header bar, in strip units; its colours (the mockup
 *  machine's slate): the deck, the bar's tier, the sloped back and the
 *  ribs between its slots, the bright trim along its crest, the lip, a
 *  Viewer's base and case, the strip's case and rim, and its floor (rgb)
 *  once it stands. */
const DECK = { clear: 10, step: 12, gap: 0.6, top: 0x2a2e3b, tier: 0x2a2e3b, slope: 0x363c50, rib: 0xb4bbc8, trim: 0xd2d7e0, lip: 0x1e2230, foot: 0x22252f, case: 0x22252f, alu: 0xb4bbc8, body: 0x454c62, floor: [64, 70, 94] }
type Screen = { id: string; slab: TiltSlab; hinge: Hinge }
/** Console furniture, as on the mockup's machine. Behind each run of
 *  leaning cards, a sloped back just behind their backs, so nothing shows
 *  through between or above them; in front, along their bottom edges, a
 *  dark lip they stand in. Built from the cards' final heights (after the
 *  fade). Three.js alone draws them ('deco'): a press on one is a press on
 *  its strip's band. */
/** Console: each run of leaning cards' plane (its cards' hinge), the run's
 *  span across and how far back its sloped back reaches (flat px from the
 *  centre), by owner ('rail:<id>'). A drag over the sloped back is read on
 *  that plane: what is there flat is the row's cards and the gaps between. */
export let decoPlanes: { owner: string; hinge?: Hinge; z: number; x0: number; x1: number; v0: number; v1: number }[] = []
function consoleFurniture(leaning: Leaning[], screens: Screen[], decks: Deck[], zoom: number, K: number): TiltSlab[] {
  const out: TiltSlab[] = []
  decoPlanes = []
  for (const sc of screens) {
    const { v, z, a } = sc.hinge
    if (a >= 87 * Math.PI / 180) continue
    // Grown in with the lean, not popped on.
    const f = grownIn(a, CONSOLE.viewer)
    // Under its bottom edge, a dark base down to the floor (it stands on
    // its face's edge, its thickness up).
    const back = z * Math.sin(a), front = z * 0.25 * f
    if (back + front >= 0.5) out.push({ u: sc.slab.u, v: v + (front - back) / 2, w: sc.slab.w, h: back + front, r: Math.min(4, z / 2),
      t: z, z, color: DECK.foot, finish: 'body', bevel: 2, cap: true, deco: `viewer:${sc.id}` })
    // A strut: a bar from the floor behind it up to its back, a little
    // over halfway up. Its underside starts on the floor at its foot.
    if (f < 0.05) continue
    const d = CONSOLE.strutAt * sc.slab.h
    const rise = d * Math.sin(a), run = 0.416 * rise
    const foot = v - d * Math.cos(a) - run
    const L = Math.hypot(rise, run)
    const w = Math.max(3, 0.05 * sc.slab.w), t = 0.6 * w
    out.push({ u: sc.slab.u, v: foot - L / 2, w, h: L, r: w / 3, t, z: 0, color: DECK.alu, finish: 'alu', cap: true,
      deco: `viewer:${sc.id}`, hinge: { v: foot, z: 0, a: Math.PI - Math.atan2(rise, run) } })
  }
  // The deck: a raised top across the back of the strip, from inside its
  // rim to the header bar's front edge, the header bar and the loop strip
  // bar on it.
  const deckOf = new Map<string, Deck & { Dk: number }>()
  for (const d of decks) {
    const Dk = d.D * K - DECK.gap
    deckOf.set(d.rail, { ...d, Dk })
    // Its walls a cased body with a bright parting line, as the strip's:
    // from behind and the side a tall plain dark box read as a hole.
    out.push({ u: (d.x0 + d.x1) / 2, v: (d.back + d.front) / 2, w: d.x1 - d.x0, h: d.front - d.back, r: 6 * d.u,
      t: Dk, z: Dk, color: DECK.top, finish: 'body', bevel: 2.5 * d.u, seam: Dk * 0.4, cap: true, deco: `rail:${d.rail}` })
    decoPlanes.push({ owner: `rail:${d.rail}`, z: Dk, x0: d.x0, x1: d.x1, v0: d.back, v1: d.front })
    // The loop strip bar's tier, back to the header bar's back edge.
    const Ak = d.A * K - DECK.gap
    if (Ak > Dk + 0.5 && d.band.v0 - d.back >= 1) {
      out.push({ u: (d.x0 + d.x1) / 2, v: (d.back + d.band.v0) / 2, w: d.x1 - d.x0, h: d.band.v0 - d.back, r: 6 * d.u,
        t: Ak, z: Ak, color: DECK.tier, finish: 'body', bevel: 2.5 * d.u, seam: (Ak - Dk) * 0.5, cap: true, deco: `rail:${d.rail}` })
      decoPlanes.push({ owner: `rail:${d.rail}`, z: Ak, x0: d.x0, x1: d.x1, v0: d.back, v1: d.band.v0 })
    }
  }
  if (!leaning.length) return out
  const nodes = useFreeNodeStore.getState().nodes
  /** Each deck's span across that a run's shelf fronts (below). */
  const shelved = new Map<string, [number, number][]>()
  // The sloped back stands behind each column's back card (the first in
  // its cascade); the cards in front lean parallel to it, each on its own
  // bottom edge.
  const backCard = new Map<string, Leaning>()
  for (const l of leaning) {
    const key = `${l.rail}|${l.slot}`, was = backCard.get(key)
    if (!was || l.order < was.order) backCard.set(key, l)
  }
  const byRail = new Map<string, Leaning[]>()
  for (const l of backCard.values()) byRail.set(l.rail, [...(byRail.get(l.rail) ?? []), l])
  for (const [rail, cards] of byRail) {
    const u = (nodes[rail]?.rail?.unit || 1) * zoom
    const owner = `rail:${rail}`
    const build = (run: Leaning[]) => {
      // One strip, one angle; the rack one plane behind the back-most card.
      const a = run[0].hinge.a, sa = Math.sin(a), ca = Math.cos(a)
      // Grown in with the lean (and shrunk with it), not popped on.
      const f = grownIn(a, CONSOLE.slot)
      const x0 = Math.min(...run.map(c => c.slab.u - c.slab.w / 2)) - 4 * u * f
      const x1 = Math.max(...run.map(c => c.slab.u + c.slab.w / 2)) + 4 * u * f
      const t = Math.max(...run.map(c => c.slab.t))
      // Its plane: parallel to the cards, just behind the one furthest back
      // (each card leans on its own bottom edge, a column's cascade and the
      // row's tiles alike), so one rack runs behind its columns, no wall
      // between them (Brian 2026-11-01: like the mockup's one wedge).
      const ref = run.reduce((m, c) => c.hinge.v * sa + c.hinge.z * ca < m.hinge.v * sa + m.hinge.z * ca ? c : m)
      const { v, z } = ref.hinge
      const back = t + 0.5
      const vB = v - back * sa, zB = Math.max(0.25, z - back * ca)
      // As far up its plane as the cards reach, or their tabs riding on them.
      const reach = Math.max(...run.map(c => {
        const len = c.hinge.v - Math.min(c.slab.v - c.slab.h / 2, c.top ?? Infinity)
        return (c.hinge.v - len * ca - vB) * -ca + (c.hinge.z + len * sa - zB) * sa
      }))
      // Under the deck (the strip's own row), the sloped back runs up to it
      // and a shelf at its height closes the gap to the header bar; a look
      // row's stops a little past its cards' tops.
      const deck = run[0].main ? deckOf.get(rail) : undefined
      let L = (reach + 2 * u) * f
      if (deck && a > 0) {
        shelved.set(rail, [...(shelved.get(rail) ?? []), [x0, x1]])
        L = Math.max(0, Math.min((deck.Dk - zB) / sa, (vB - deck.front) / Math.max(1e-3, ca)))
        const vT = vB - L * ca
        if (vT - deck.front >= 0.5) {
          out.push({ u: (x0 + x1) / 2, v: (vT + deck.front) / 2, w: x1 - x0, h: vT - deck.front + 1, r: Math.min(4 * u, (vT - deck.front) / 2),
            t: deck.Dk, z: deck.Dk, color: DECK.top, finish: 'dark', cap: true, deco: owner })
          decoPlanes.push({ owner, z: deck.Dk, x0, x1, v0: deck.front, v1: vT })
        }
      }
      const rack: Hinge = { v: vB, z: zB, a }
      if (L >= 1) out.push({ u: (x0 + x1) / 2, v: vB - L / 2, w: x1 - x0, h: L, r: 4 * u * f, t: zB, z: zB,
        color: DECK.slope, finish: 'body', cap: true, loft: true, deco: owner, hinge: rack })
      // A rib up the slope in each gap between its columns: a rack of slots.
      const rib = 3 * u * f
      const cols = [...run].sort((p, q) => p.slab.u - q.slab.u)
      if (L >= 1 && rib >= 0.5) {
        for (let i = 1; i < cols.length; i++) {
          const l = cols[i - 1].slab, r = cols[i].slab
          const gu = (l.u + l.w / 2 + r.u - r.w / 2) / 2
          out.push({ u: gu, v: vB - L / 2, w: rib, h: L, r: rib / 2, t: 2 * u * f, z: zB + 2 * u * f,
            color: DECK.rib, finish: 'alu', bevel: rib / 3, cap: true, deco: owner, hinge: rack })
        }
      }
      // Bright trim along the crest, where the slope meets the deck. Out
      // in front of the header bar, on the shelf, it stands as high as the
      // cards' raised buttons stand off them, so from behind they stay
      // hidden behind it, as the cards' tops do.
      if (deck && a > 0 && 3 * u * f >= 0.5) {
        const vC = Math.max(deck.front, vB - L * ca)
        const P = vC - deck.front >= 3 * u * f ? POP * Math.max(...run.map(c => Math.min(c.slab.w, c.slab.h))) * f : 0
        out.push({ u: (x0 + x1) / 2, v: vC, w: x1 - x0, h: 3 * u * f, r: 1.5 * u * f, t: 1 + P, z: deck.Dk + 0.4 + P,
          color: DECK.trim, finish: 'alu', cap: true, deco: owner })
      }
      // The slope, read on the back-most card's plane: what is there flat.
      decoPlanes.push({ owner, hinge: ref.hinge, z, x0, x1, v0: v - L - back - 2 * u, v1: v })
    }
    // A run: a row's columns side by side. The strip's own row is racked
    // end to end, a rack to each run of columns whose back cards share a
    // plane, so every rack touches its cards' backs: one rack behind them
    // all stood behind the card furthest back (the results' short preview,
    // the cast's shorter cards), and the effects stood well clear of it,
    // with a void between seen from the side. A look row's split where a
    // column is missing.
    cards.sort((a, b) => a.hinge.v - b.hinge.v || a.slab.u - b.slab.u)
    const main = cards.filter(c => c.main).sort((p, q) => p.slab.u - q.slab.u), looks = cards.filter(c => !c.main)
    const plane = (c: Leaning) => c.hinge.v * Math.sin(c.hinge.a) + c.hinge.z * Math.cos(c.hinge.a)
    let run: Leaning[] = []
    for (const c of main) {
      if (run.length && Math.abs(plane(run[run.length - 1]) - plane(c)) > 1) { build(run); run = [] }
      run.push(c)
    }
    if (run.length) build(run)
    run = []
    for (const c of looks) {
      const last = run[run.length - 1]
      if (last && (Math.abs(last.hinge.v - c.hinge.v) > 1 || c.slab.u - c.slab.w / 2 - (last.slab.u + last.slab.w / 2) > 0.3 * c.slab.w)) {
        build(run); run = []
      }
      run.push(c)
    }
    if (run.length) build(run)
  }
  // A dark lip along every leaning card's bottom edge, the card stood in
  // it as in a slot: side by side ones on one hinge line share one.
  const feet = [...leaning].sort((p, q) => p.rail.localeCompare(q.rail) || p.hinge.v - q.hinge.v || p.slab.u - q.slab.u)
  let foot: Leaning[] = []
  const lip = (run: Leaning[]) => {
    const { v, z, a } = run[0].hinge
    const u = (nodes[run[0].rail]?.rail?.unit || 1) * zoom, f = grownIn(a, CONSOLE.slot)
    const t = Math.max(...run.map(c => c.slab.t))
    const x0 = Math.min(...run.map(c => c.slab.u - c.slab.w / 2)) - 2 * u * f
    const x1 = Math.max(...run.map(c => c.slab.u + c.slab.w / 2)) + 2 * u * f
    if (6 * u * f < 1) return
    const owner = `rail:${run[0].rail}`
    out.push({ u: (x0 + x1) / 2, v: v + 3 * u * f, w: x1 - x0, h: 6 * u * f, r: 2 * u * f, t: z + t, z: z + t,
      color: DECK.lip, finish: 'body', bevel: 1.5 * u * f, cap: true, deco: owner })
    decoPlanes.push({ owner, z: z + t, x0, x1, v0: v, v1: v + 6 * u * f })
  }
  for (const c of feet) {
    const last = foot[foot.length - 1]
    if (last && (last.rail !== c.rail || Math.abs(last.hinge.v - c.hinge.v) > 1 || Math.abs(last.hinge.z - c.hinge.z) > 1 ||
      c.slab.u - c.slab.w / 2 - (last.slab.u + last.slab.w / 2) > 0.3 * c.slab.w)) { lip(foot); foot = [] }
    foot.push(c)
  }
  if (foot.length) lip(foot)
  // Bright trim along the top of the deck's front wall where no shelf
  // runs out from it (over the end columns), a lip under the header bar,
  // so the deck reads as one bridge across the strip. It stops where the
  // deck's front corners round off, and runs on under each shelf's rounded
  // corner, so no notch shows where they meet.
  for (const d of deckOf.values()) {
    const th = 8 * d.u * d.s
    if (th < 0.5) continue
    const rc = 6 * d.u, rs = 4 * d.u
    let from = d.x0 + rc
    const piece = (to: number) => {
      if (to - from >= 1) out.push({ u: (from + to) / 2, v: d.front + 0.5, w: to - from, h: 1, r: 0.5, t: th, z: d.Dk - 0.05,
        color: DECK.trim, finish: 'alu', cap: true, deco: `rail:${d.rail}` })
    }
    for (const [x0, x1] of (shelved.get(d.rail) ?? []).sort((p, q) => p[0] - q[0])) {
      piece(Math.min(x0 + rs, d.x1 - rc))
      from = Math.max(from, x1 - rs)
    }
    piece(d.x1 - rc)
  }
  return out
}
/** What was last asked of each element's style here, and what the browser
 *  read back: written again only when either changed. Writing the same
 *  value each frame still restyled the page and woke the frame loop's
 *  page watcher, so a 3D view at rest never rested. */
const asked = new WeakMap<HTMLElement, Map<string, { raw: string; out: string }>>()
type StyleKey = 'rotate' | 'transform' | 'transformOrigin' | 'translate' | 'width' | Styled
function setStyle(el: HTMLElement, prop: StyleKey, v: string) {
  let m = asked.get(el)
  if (!m) asked.set(el, m = new Map())
  const a = m.get(prop)
  if (a && a.raw === v && el.style[prop] === a.out) return
  el.style[prop] = v
  m.set(prop, { raw: v, out: el.style[prop] })
}
/** A card stood up on its bottom edge: the edge at flat `v` (px from the
 *  centre, y down) and height `z`, turned up by `a` radians. */
export type Hinge = { v: number; z: number; a: number }
type Stood = { hinge: Hinge; rotate: string; origin: string; transform: string; wrote: string }
export let stood = new Map<HTMLElement, Stood>()
let standing = new Map<HTMLElement, Stood>()
/** Stand `el` up on `hinge`. A world element sits under the world's
 *  scale(zoom), which scales across but not up: turned there plainly it
 *  would stretch, so it is scaled to screen size, turned, and scaled back
 *  (rigid on screen). */
function stand(el: HTMLElement, hinge: Hinge, zoom = 1, origin = '50% 100%') {
  // Laid out at the zoom (the tilted canvas, InfiniteCanvas worldStyle), it
  // scales up as across: turned plainly.
  if (zoom !== 1 && el.closest('[data-tilt-zoomed]')) zoom = 1
  const was = stood.get(el) ?? { hinge, rotate: el.style.rotate, origin: el.style.transformOrigin, transform: el.style.transform, wrote: '' }
  const deg = (-hinge.a * 180 / Math.PI).toFixed(2)
  // Each way first undoes the other's, or a zoom crossing exactly 1 left
  // both on and the card turned twice as far.
  if (zoom === 1) {
    if (was.wrote && el.style.transform === was.wrote) el.style.transform = was.transform
    was.wrote = ''
    setStyle(el, 'rotate', `x ${deg}deg`)
  } else {
    setStyle(el, 'rotate', was.rotate)
    setStyle(el, 'transform', `scale3d(${1 / zoom}, ${1 / zoom}, 1) rotateX(${deg}deg) scale3d(${zoom}, ${zoom}, 1)`)
    was.wrote = el.style.transform
  }
  setStyle(el, 'transformOrigin', origin)
  standing.set(el, { ...was, hinge })
}
function settleStands() {
  for (const [el, was] of stood) {
    if (standing.has(el)) continue
    if (el.hasAttribute('data-cabinet-tray')) el.style.translate = ''
    el.style.rotate = was.rotate
    el.style.transformOrigin = was.origin
    // Only what was written here goes back: React may have set it since.
    if (was.wrote && el.style.transform === was.wrote) el.style.transform = was.transform
  }
  stood = standing
  standing = new Map()
}
/** The hinge `el` stands on, if it is (or is on) a standing card. */
export function hingeOf(el: Element | null): Hinge | undefined {
  for (let e = el; e; e = e.parentElement) {
    const h = stood.get(e as HTMLElement)
    // A negative turn lays a tray back down on the canvas: no hinge to it.
    if (h) return h.hinge.a > 0 ? h.hinge : undefined
  }
}

/** The DOM tiles lifted off the plane (docked cards), and by how much. The
 *  lift is the CSS `translate` property, which leaves the tile's own
 *  transform alone; tilting flat puts them all back. */
export let lifted = new Map<HTMLElement, number>()
/** The CSS zoom each lift was written at: on the tilted canvas, laid out
 *  at the zoom (InfiniteCanvas worldStyle), a length is drawn that many
 *  times over, so a lift is written as screen px over it. */
let liftK = new Map<HTMLElement, number>()
function setLifts(next: Map<HTMLElement, number>) {
  const nextK = new Map<HTMLElement, number>()
  for (const [el, z] of next) {
    const k = cssZoomOf(el)
    nextK.set(el, k)
    if (Math.abs((lifted.get(el) ?? -1) - z) > 0.05 || liftK.get(el) !== k) el.style.translate = `0 0 ${(z / k).toFixed(3)}px`
  }
  liftK = nextK
  for (const el of lifted.keys()) if (!next.has(el)) el.style.translate = ''
  if (!!next.size !== !!lifted.size) {
    for (const st of document.querySelectorAll('[data-tilt-stage]')) st.toggleAttribute('data-tilt-3d', next.size > 0)
  }
  lifted = next
  settleChains()
  settleStands()
}
/** The CSS zoom `el` is laid out at: its own and its boxes' together. */
function cssZoomOf(el: HTMLElement): number {
  const k = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom
  return k && k > 0 ? k : 1
}
/** How high `el` stands: the lifts of everything raised that holds it
 *  (a button on a docked card stands on the card's lift), or 0. */
export function liftOf(el: Element | null): number {
  let z = 0
  for (let e = el; e; e = e.parentElement) {
    z += lifted.get(e as HTMLElement) ?? 0
    // A cabinet's open tray, out of its drawer at that drawer's height.
    const h = stood.get(e as HTMLElement)?.hinge
    if (h && h.a < 0) z += h.z
  }
  return z
}
function dropLifts() {
  if (lifted.size) setLifts(new Map())
  standScreens([])
  turnAway(new Set())
  restEase.clear()
  grip.heldRest = null
  grip.heldAt = null
  grip.handAt = null
  decoPlanes = []
  // Nothing carries over a flat spell (Console turned off, or on, in 2D):
  // the next tilt starts each strip and Viewer afresh.
  consoleEase.clear()
  screenEase.clear()
  // A Viewer carried as 3D was left lies down with the rest.
  grip.carried = null
}
// The 3D view may stop drawing once flat, so settle back here too: nothing
// stays lifted or unclipped in the flat view.
useTiltStore.subscribe(s => { if (!isTilted(s)) dropLifts() })

/** Every model card in view, as flat px from the host centre. */
function collectTargets(W: number, H: number): TiltTarget[] {
  // Models stand up out of their cards in the 3D mode only; peeking, they
  // stay flat in their cards (Brian 2026-11-04).
  if (usePeek.getState().target) return []
  const out: TiltTarget[] = []
  const { pan, zoom } = useCanvasStore.getState()
  // In a 3D area's scene, a model stands where it was put there (up in
  // the air if lifted); its wall stays on its card.
  const floats = useModelScaleStore.getState().floatOf
  const off = (key: string, t: TiltTarget): TiltTarget => {
    const sp = sceneSpot(key)
    // On its own card, it floats as high as its lift handle says.
    if (!sp) { const f = floats[dataKey(key)]; return f ? { ...t, float: f * zoom } : t }
    return { ...t, u: pan.x + sp.x * zoom - W / 2, v: pan.y + sp.y * zoom - H / 2, z: sp.h * zoom, wall: { u: t.u, v: t.v, h: t.h } }
  }
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    if (n.type !== 'model' || n.pin || !n.imageUrl) continue
    out.push(off(`node:${n.id}`, {
      key: `node:${n.id}`, url: n.imageUrl,
      u: pan.x + (n.x + n.width / 2) * zoom - W / 2,
      v: pan.y + (n.y + n.height / 2) * zoom - H / 2,
      w: Math.min(n.width, n.height * 1.4) * zoom,
      h: n.height * zoom,
      name: fileName(n.imageUrl) || n.label || 'Model',
    }))
  }
  // A Viewer showing a model: the model stands up on the Viewer, popping
  // in, and leaves the card it came from (Brian 2026-10-30). Once the
  // Viewer shows something else (a picture from another card docked to
  // it), the model hops back onto its card (Brian 2026-10-30).
  const viewers = Object.values(useViewport3DStore.getState().windows).map(w => {
    const it = w.activeItem
    const x0 = pan.x + w.x * zoom, y0 = pan.y + w.y * zoom
    return { id: w.id, x0, y0, x1: x0 + w.width * zoom, y1: y0 + w.height * zoom,
      url: it?.kind === 'media' && it.mediaType === 'model' ? it.url : null, name: it?.kind === 'media' ? it.name : undefined }
  })
  const onViewer = (v: typeof viewers[number], url: string, name?: string) => out.push({
    key: `viewer:${v.id}`, url, name: name || fileName(url) || 'Model', pop: true,
    u: (v.x0 + v.x1) / 2 - W / 2, v: (v.y0 + v.y1) / 2 - H / 2,
    w: Math.min(v.x1 - v.x0, (v.y1 - v.y0) * 1.4) * 0.7, h: v.y1 - v.y0,
  })
  // Not on a Viewer standing as console mode's screen: its body there is
  // the strip's result.
  for (const v of viewers) if (v.url && !stoodScreens.includes(v.id)) onViewer(v, v.url, v.name)
  const GAP = 14
  const stage = document.querySelector<HTMLElement>('[data-tilt-stage="overlay"]')
  if (stage) {
    for (const el of stage.querySelectorAll<HTMLElement>('[data-group-card][data-id]')) {
      const model = cardModel(el.dataset.id!)
      const at = model && offsetIn(el, stage)
      if (!model || !at) continue
      const x = at.x, y = at.y, w = el.offsetWidth, h = el.offsetHeight
      const v = viewers.find(r => x <= r.x1 + GAP && x + w >= r.x0 - GAP && y <= r.y1 + GAP && y + h >= r.y0 - GAP)
      // Beside a Viewer showing it, it is on the Viewer, unless that one
      // stands as a strip's screen.
      if (v?.url === model.url && !stoodScreens.includes(v.id)) continue
      out.push(off(`card:${el.dataset.id}`, {
        key: `card:${el.dataset.id}`, url: model.url, name: model.name,
        u: at.x + el.offsetWidth / 2 - W / 2,
        v: at.y + el.offsetHeight / 2 - H / 2,
        w: Math.min(el.offsetWidth, el.offsetHeight * 1.4),
        h: el.offsetHeight,
        z: liftOf(el),
      }))
    }
  }
  // A model in a 3D scene: its card may not be drawn (off screen while the
  // model, lifted or moved, is in view; or zoomed far out) and the model
  // still stands. off() puts it where the scene says.
  if (Object.values(useFreeNodeStore.getState().nodes).some(n => n.type === 'area' && !n.pin)) {
    const have = new Set(out.map(t => t.key))
    for (const g of useBoardsStore.getState().groups) {
      const key = `card:${g.id}`
      if (have.has(key) || g.pin) continue
      // On a scene or docked to one: its card may not be drawn (off
      // screen, or zoomed far out), so its box comes from the card.
      const sc = sceneOf(key)
      const model = sc && cardModel(g.id)
      if (!sc || !model) continue
      const sp = { card: sc.box }
      const w = sp.card.width * zoom, h = sp.card.height * zoom
      out.push(off(key, {
        key, url: model.url, name: model.name,
        u: pan.x + (sp.card.x + sp.card.width / 2) * zoom - W / 2,
        v: pan.y + (sp.card.y + sp.card.height / 2) * zoom - H / 2,
        w: Math.min(w, h * 1.4), h,
      }))
    }
  }
  const shown = out.filter(t => Math.abs(t.u) < W && Math.abs(t.v) < H && t.w > 4)
  // A card set to keep its model flat ("Show model in 3D" off).
  const groups = useBoardsStore.getState().groups
  const flatCard = (key: string) => key.startsWith('card:') && [key, dataKey(key)].some(k => groups.find(g => g.id === k.slice(5))?.hideModel3d)
  const inScene = (t: TiltTarget) => (t.key.startsWith('card:') || t.key.startsWith('node:')) && !!sceneOf(t.key)
  // A 3D scene's models all stand (Brian 2026-11-09: zoomed out, a cap
  // left them out). The rest, if the 3D bar's Models is on (a Viewer's
  // always), nearest the middle first, while they fit the triangle budget.
  const scene = shown.filter(t => inScene(t) && !flatCard(t.key))
  const canvasOn = useManip.getState().models
  const rest = shown
    .filter(t => !inScene(t) && !flatCard(t.key) && (canvasOn || t.key.startsWith('viewer:')))
    .sort((a, b) => (a.u * a.u + a.v * a.v) - (b.u * b.u + b.v * b.v))
  const keep = [...scene]
  let tris = scene.reduce((n, t) => n + (trianglesOf(t.url) ?? UNKNOWN_TRIS), 0)
  let held = 0
  for (const t of rest) {
    const n = trianglesOf(t.url) ?? UNKNOWN_TRIS
    if (keep.length >= MAX_MODELS || tris + n > TRI_BUDGET) { held++; continue }
    keep.push(t)
    tris += n
  }
  const st = useTiltStats.getState()
  if (st.held !== held || st.tris !== tris) useTiltStats.setState({ held, tris })
  return keep
}


/** Select what a screen-space box drawn on the tilted view covers. The
 *  cards' and tiles' on-screen boxes are their tilted outlines, so the test
 *  is in screen space, where the box was drawn. A click without a drag
 *  clears the selection, as on bare flat canvas. */
export function marqueeSelect(m: { x0: number; y0: number; x1: number; y1: number }, add: boolean) {
  const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
  if (Math.abs(m.x1 - m.x0) < 4 && Math.abs(m.y1 - m.y0) < 4) {
    if (add) return
    fs.setFreeSelection([])
    bs.clearGroupSelection()
    bs.clearAllSelections()
    useCanvasStore.getState().clearAllDeckPortals()
    return
  }
  const l = Math.min(m.x0, m.x1), r = Math.max(m.x0, m.x1), t = Math.min(m.y0, m.y1), b = Math.max(m.y0, m.y1)
  const hits = (el: Element) => {
    const rc = el.getBoundingClientRect()
    return rc.right > l && rc.left < r && rc.bottom > t && rc.top < b
  }
  const ids = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel)).filter(hits).map(el => el.dataset.id!)
  // Storylines: the points covered, or a storyline covered whole.
  const nodes = [...ids('[data-tilt-stage] [data-freenode][data-id]:not([data-pinned])'), ...selectStorylinesInBox(l, t, r, b, add)]
  const cards = ids('[data-tilt-stage] [data-group-card][data-id]')
  fs.setFreeSelection(add ? [...new Set([...fs.selectedIds, ...nodes])] : nodes)
  bs.setSelectedGroups(add ? [...new Set([...bs.selectedGroupIds, ...cards])] : cards)
}

/** Select the card or tile a model stands on. */
export function selectModel(key: string, add: boolean) {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
  const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
  if (kind === 'node') {
    fs.setFreeSelection(add ? [...new Set([...fs.selectedIds, id])] : [id])
    if (!add) bs.clearGroupSelection()
  } else {
    bs.setSelectedGroups(add ? [...new Set([...bs.selectedGroupIds, id])] : [id])
    if (!add) fs.setFreeSelection([])
  }
}
