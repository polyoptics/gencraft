// viewport3dStore.ts — persisted state for on-canvas CONTENT BROWSER
// windows ("Viewers").
//
// A viewer window is a canvas-space rectangle (pans/zooms with the world,
// sits UNDER other nodes) that renders its ACTIVE ITEM by type: models
// via the shared WebGL renderer (src/three/viewportRenderer.ts), images/
// video/audio/text via DOM views (Viewport3D/ContentViews.tsx). Only the
// window records persist here: which content is "docked" to a window is
// DERIVED from geometry (utils/viewportDocking.ts), never stored —
// matching how deck membership is derived in useCardDecks. `activeItem`
// is the one piece of content state.
//
// Camera persists per window (so a reload restores the view) but never
// moves under an undo (an orbit is a "look", not an edit) — see
// undoCoordinator.ts. `cameraUrl` records which MODEL owns the saved
// camera, so browsing away to an image/text page and back to the same
// model restores the orbit; only a different model resets it.
//
// Text zoom is the same tier one level finer: `textScales` remembers a
// size PER PAGE (browse back to a page and it is the size you left it)
// and `defaultTextScale` is this window's reading size — the opening size
// for a page you have never adjusted. Both persist, both are held out of
// undo the same way the camera is.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'
import type { MediaType } from '../types/bar'
import { recordHistory } from './historyStore'
import type { ModelLook } from '../three/modelLook'

export interface Viewport3DCamera {
  theta: number   // azimuth (rad)
  phi: number     // polar (rad), clamped away from poles
  radius: number  // dolly distance
  tx: number; ty: number; tz: number  // orbit target
}

/** What a browser window shows. Media items carry the raw ref (the bytes
 *  resolve via useResolvedMedia); text items carry a source pointer and
 *  resolve their content live from the stores at render time. */
export type ActiveItem =
  | { kind: 'media'; mediaType: MediaType; url: string; posterUrl?: string | null; name?: string }
  | { kind: 'text'; sourceId: string; name?: string }
  // text sourceId forms: 'bar:<boardId>:<barId>' | 'group:<groupId>' | 'tile:<nodeId>'

/** Map key for a TEXT item from its sourceId alone — the same string
 *  activeItemKey yields for that item, so the 'text:' prefix is owned
 *  here and never spelled out at a call site. */
export const textItemKey = (sourceId: string): string => `text:${sourceId}`

/** Stable identity for equality, dedupe, and strip-active matching. */
export function activeItemKey(i: ActiveItem | null | undefined): string | null {
  if (!i) return null
  return i.kind === 'media' ? `media:${i.url}` : textItemKey(i.sourceId)
}

// Text zoom moves in ×1.15 steps (the A−/A+ buttons), so scales are
// snapped to that geometric ladder. That makes A− then A+ land on
// EXACTLY the size you started from and keeps the % readout on stable
// rungs (100 / 87 / 76 / 66 / 57 …); rounding the raw float instead
// leaves 13% of values a step off after a round trip (0.5 → 0.43 → 0.49).
const TEXT_STEP = 1.15
const TEXT_RUNG_MIN = Math.ceil(Math.log(0.08) / Math.log(TEXT_STEP))  // −18 ⇒ ~8%
const TEXT_RUNG_MAX = Math.floor(Math.log(5) / Math.log(TEXT_STEP))    // +11 ⇒ ~465%

/** Nearest rung of the ×1.15 ladder, clamped. Wide range on purpose: the
 *  whole point is fitting a long page into a small window. */
export function snapTextScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1
  const rung = Math.round(Math.log(scale) / Math.log(TEXT_STEP))
  return Math.pow(TEXT_STEP, Math.max(TEXT_RUNG_MIN, Math.min(TEXT_RUNG_MAX, rung)))
}

export interface ViewportWindow3D {
  id: string
  x: number       // canvas units, top-left
  y: number
  width: number   // canvas units
  height: number
  title: string
  /** What this window is showing (docked content list is derived). */
  activeItem: ActiveItem | null
  /** undefined ⇒ auto-frame the model on next load. */
  camera?: Viewport3DCamera
  /** The model url `camera` was saved for — see header comment. */
  cameraUrl?: string
  /** VIEW-ONLY text zoom PER PAGE (activeItemKey's `text:<sourceId>` form
   *  → scale; 1 = the source's own sizes). A page you have adjusted keeps
   *  its own size; no entry ⇒ it follows `defaultTextScale`. Purely how
   *  big text renders HERE — never touches the card. A Record rather than
   *  camera's single slot + owner tag, because a text page's neighbours
   *  on the browse list are usually OTHER text pages: one slot would be
   *  evicted by the very browsing this exists to remember. */
  textScales?: Record<string, number>
  /** This window's reading size: the last zoom set anywhere in it, and
   *  the opening size for a page with no entry above. A window you have
   *  made small is small for EVERY page it shows. */
  defaultTextScale?: number
  /** SCREEN-PINNED windows — identical shape and meaning to a free node's
   *  `pin`: a container-space anchor plus the world zoom frozen at pin
   *  time. Present ⇒ the window renders OUTSIDE the world transform and
   *  is skipped by the canvas-space layer. width/height stay canvas units
   *  and stay live, so resize and the docking geometry keep working. */
  pin?: { x: number; y: number; scale: number }
  /** Canvas spot to return to on unpin — same meaning as a free node's
   *  `home`. See freeNodeStore for why a pin does not move a thing. */
  home?: { x: number; y: number; width: number; height: number }
  /** Collapsed against what it is attached to (utils/viewerTuck; Brian
   *  2026-11-14: "pop in and out of things that it's magneted to"). `side`
   *  is ITS edge that lies against that thing: collapsed, it is a bar along
   *  that edge and shows (and plays) nothing. `width`/`height` are the
   *  size it pops back out to; meanwhile the one it gave up is stored 1. */
  tuck?: { side: 'top' | 'right' | 'bottom' | 'left'; width: number; height: number }
  /** How the model is drawn; undefined means DEFAULT_LOOK. */
  look?: ModelLook
  /** false ⇒ hide the skinned meshes and show the skeleton instead. */
  showSkin?: boolean
  /** Vertex/triangle readout over the model. */
  showStats?: boolean
  createdAt: number
}

export const VIEWPORT3D_MIN_W = 240
export const VIEWPORT3D_MIN_H = 180
// 680×510 (2026-11-03): sized so a new Viewer sits alongside a new Media
// Pool and loop strip made at the same zoom instead of looking small next
// to them. Its chrome is screen-sized already, so only the window grows.
export const VIEWPORT3D_DEFAULT_W = 680
export const VIEWPORT3D_DEFAULT_H = 510

interface Viewport3DStore {
  windows: Record<string, ViewportWindow3D>
  /** Transient click-selection of Viewer ids — the Viewer's seat in the
   *  canvas selection model, shaped after freeNodeStore.selectedIds.
   *  Dropped by `partialize`, and invisible to undo because
   *  restoreSnapshot writes ONLY `{ windows }`. That cuts both ways: an
   *  undo can remove a window without pruning this list, so every reader
   *  must test liveness against `windows` (see useKeyboardDelete). */
  selectedIds: string[]
  addWindow: (x: number, y: number) => string
  moveWindow: (id: string, dx: number, dy: number) => void
  resizeWindow: (id: string, dw: number, dh: number) => void
  updateWindow: (id: string, patch: Partial<ViewportWindow3D>) => void
  removeWindow: (id: string) => void
  /** Draw this window over the other Viewers: they paint in key order. */
  raiseWindow: (id: string) => void
  setViewerSelection: (ids: string[]) => void
  toggleViewerSelection: (id: string) => void
  clearViewerSelection: () => void
  /** Clears the camera ONLY when a DIFFERENT model takes over. */
  setActiveItem: (id: string, item: ActiveItem | null) => void
  saveCamera: (id: string, cam: Viewport3DCamera) => void
  /** Flip a window between screen-pinned and canvas-placed. Same maths as
   *  the free-node version: pin freezes the rect the browser is painting
   *  now; unpin unprojects it and rescales by pin.scale / zoom, so the
   *  toggle is invisible. */
  setWindowPlacement: (id: string, to: 'screen' | 'canvas',
                       view: { pan: { x: number; y: number }; zoom: number }) => void
  /** Make where a pinned window sits now the spot it returns to. */
  rehomePinnedWindow: (id: string,
                       view: { pan: { x: number; y: number }; zoom: number }) => void
  /** SCREEN-px delta for a pinned window. */
  movePinnedWindow: (id: string, dx: number, dy: number) => void
  setLook: (id: string, look: ModelLook) => void
  toggleShowSkin: (id: string) => void
  toggleShowStats: (id: string) => void
  /** View-only text zoom for ONE page (itemKey = activeItemKey's
   *  `text:<sourceId>` form). Also becomes this window's reading size.
   *  Does NOT edit any card. */
  setTextScale: (id: string, itemKey: string, scale: number) => void
  /** Hand ONE page back to this window's reading size, leaving that
   *  reading size alone — see the % readout in ContentViews. */
  clearTextScale: (id: string, itemKey: string) => void
}

export const useViewport3DStore = create<Viewport3DStore>()(persist((set, get) => ({
  windows: {},
  selectedIds: [],

  addWindow: (x, y) => {
    const id = crypto.randomUUID()
    const win: ViewportWindow3D = {
      id, x, y,
      width: VIEWPORT3D_DEFAULT_W,
      height: VIEWPORT3D_DEFAULT_H,
      title: 'Viewer',
      activeItem: null,
      createdAt: Date.now(),
    }
    set(s => ({ windows: { ...s.windows, [id]: win } }))
    return id
  },

  moveWindow: (id, dx, dy) => {
    if (dx === 0 && dy === 0) return
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      return { windows: { ...s.windows, [id]: { ...w, x: w.x + dx, y: w.y + dy } } }
    })
  },

  resizeWindow: (id, dw, dh) =>
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      return {
        windows: {
          ...s.windows,
          [id]: {
            ...w,
            width: Math.max(VIEWPORT3D_MIN_W, w.width + dw),
            height: Math.max(VIEWPORT3D_MIN_H, w.height + dh),
          },
        },
      }
    }),

  updateWindow: (id, patch) =>
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      return { windows: { ...s.windows, [id]: { ...w, ...patch } } }
    }),

  raiseWindow: (id) =>
    set(s => {
      const { [id]: w, ...rest } = s.windows
      return w ? { windows: { ...rest, [id]: w } } : s
    }),

  removeWindow: (id) =>
    set(s => {
      const { [id]: _, ...rest } = s.windows
      // Self-pruning, like deleteFreeNode — so closing via × can never
      // leave the id behind in the selection.
      return s.selectedIds.includes(id)
        ? { windows: rest, selectedIds: s.selectedIds.filter(x => x !== id) }
        : { windows: rest }
    }),

  // The no-op guards here are load-bearing, not micro-optimisation:
  // zustand's persist wrapper calls storage.setItem() after EVERY
  // setState whether or not anything changed, and the debounced IDB
  // storage RESETS its timer on each call. clearViewerSelection fires on
  // every press anywhere in the app, so an unguarded set() would let a
  // burst of clicks starve a pending write of a real edit.
  setViewerSelection: (ids) => {
    const cur = get().selectedIds
    if (cur.length === ids.length && cur.every((x, i) => x === ids[i])) return
    set({ selectedIds: ids })
  },

  toggleViewerSelection: (id) => set(s => ({
    selectedIds: s.selectedIds.includes(id)
      ? s.selectedIds.filter(x => x !== id)
      : [...s.selectedIds, id],
  })),

  clearViewerSelection: () => {
    if (get().selectedIds.length === 0) return
    set({ selectedIds: [] })
  },

  setActiveItem: (id, item) => {
    // Opening something IS the history event — recorded here rather than at
    // each call site so every route into a Viewer (chip, click, dock,
    // reconciliation) lands in the record exactly once.
    if (item && activeItemKey(useViewport3DStore.getState().windows[id]?.activeItem) !== activeItemKey(item)) {
      if (item.kind === 'media') {
        recordHistory({
          kind: 'view', sourceId: id,
          label: item.name || item.url.split('/').pop() || item.mediaType,
          face: item.mediaType === 'image' ? item.url : item.posterUrl ?? null,
          url: item.url, mediaType: item.mediaType,
        })
      } else {
        recordHistory({ kind: 'view', sourceId: id, label: item.name || 'Text page' })
      }
    }
    set(s => {
      const w = s.windows[id]
      if (!w || activeItemKey(w.activeItem) === activeItemKey(item)) return s
      const nextModel = item?.kind === 'media' && item.mediaType === 'model' ? item.url : null
      // Camera resets only when a DIFFERENT model takes over; it survives
      // image/video/text excursions so returning to the model restores
      // the orbit.
      const resetCam = nextModel !== null && nextModel !== w.cameraUrl
      return {
        windows: {
          ...s.windows,
          [id]: {
            ...w, activeItem: item,
            ...(resetCam ? { camera: undefined, cameraUrl: undefined } : {}),
          },
        },
      }
    })
  },

  saveCamera: (id, cam) =>
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      const url = w.activeItem?.kind === 'media' && w.activeItem.mediaType === 'model'
        ? w.activeItem.url
        : w.cameraUrl
      return { windows: { ...s.windows, [id]: { ...w, camera: cam, cameraUrl: url } } }
    }),

  setWindowPlacement: (id, to, view) =>
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      if (to === 'screen') {
        if (w.pin) return s
        return { windows: { ...s.windows, [id]: {
          ...w,
          pin: {
            x: view.pan.x + w.x * view.zoom,
            y: view.pan.y + w.y * view.zoom,
            scale: view.zoom,
          },
          // Remember where it stood — unpinning is a return trip.
          home: { x: w.x, y: w.y, width: w.width, height: w.height },
        } } }
      }
      if (!w.pin) return s
      const { pin: _drop, home: _dropHome, ...rest } = w
      if (w.home) return { windows: { ...s.windows, [id]: { ...rest, ...w.home } } }
      // No recorded home: unproject where it is now, as unpin always did.
      const k = w.pin.scale / view.zoom
      return { windows: { ...s.windows, [id]: {
        ...rest,
        x: (w.pin.x - view.pan.x) / view.zoom,
        y: (w.pin.y - view.pan.y) / view.zoom,
        width: w.width * k,
        height: w.height * k,
      } } }
    }),

  rehomePinnedWindow: (id, view) =>
    set(s => {
      const w = s.windows[id]
      if (!w?.pin) return s
      const k = w.pin.scale / view.zoom
      return { windows: { ...s.windows, [id]: {
        ...w,
        home: {
          x: (w.pin.x - view.pan.x) / view.zoom,
          y: (w.pin.y - view.pan.y) / view.zoom,
          width: w.width * k,
          height: w.height * k,
        },
      } } }
    }),

  setLook: (id, look) =>
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      return { windows: { ...s.windows, [id]: { ...w, look } } }
    }),

  toggleShowSkin: (id) =>
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      return { windows: { ...s.windows, [id]: { ...w, showSkin: w.showSkin === false } } }
    }),

  toggleShowStats: (id) =>
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      return { windows: { ...s.windows, [id]: { ...w, showStats: !w.showStats } } }
    }),

  movePinnedWindow: (id, dx, dy) => {
    if (dx === 0 && dy === 0) return
    set(s => {
      const w = s.windows[id]
      if (!w?.pin) return s
      return { windows: { ...s.windows, [id]: { ...w, pin: { ...w.pin, x: w.pin.x + dx, y: w.pin.y + dy } } } }
    })
  },

  setTextScale: (id, itemKey, scale) =>
    set(s => {
      const w = s.windows[id]
      if (!w) return s
      const snapped = snapTextScale(scale)
      if (w.textScales?.[itemKey] === snapped && w.defaultTextScale === snapped) return s
      // Sizing a page pins it AND becomes this window's reading size, so
      // the next unseen page opens where you left off. Deliberately NO
      // "landing back on the reading size un-pins it" shortcut: the
      // reading size moves with every step, so by the time an A− / A+
      // round trip returns, the value it would have to match has already
      // followed it down. The % readout is the honest way back.
      const textScales = { ...w.textScales, [itemKey]: snapped }
      return {
        windows: { ...s.windows, [id]: { ...w, textScales, defaultTextScale: snapped } },
      }
    }),

  clearTextScale: (id, itemKey) =>
    set(s => {
      const w = s.windows[id]
      if (!w || w.textScales?.[itemKey] === undefined) return s
      const textScales = { ...w.textScales }
      delete textScales[itemKey]
      // defaultTextScale is deliberately UNTOUCHED: handing one page back
      // must not resize every page you have not set.
      return { windows: { ...s.windows, [id]: { ...w, textScales } } }
    }),
}), {
  name: 'vidbars-viewports3d',
  storage: createDebouncedIDBStorage(400),
  partialize: (s) => ({ windows: s.windows }),   // selectedIds is transient
  // v2: activeModelUrl → discriminated activeItem; '3D View' → 'Viewer';
  // camera ownership recorded in cameraUrl.
  // v3: window-wide textScale → per-page textScales + defaultTextScale.
  // v4: pick-one viewMode → independent look toggles.
  version: 4,
  migrate: (persisted, version) => {
    type LegacyWin = ViewportWindow3D & { activeModelUrl?: string | null; textScale?: number; viewMode?: string }
    const p = persisted as { windows?: Record<string, LegacyWin> }
    if (version < 2 && p?.windows) {
      for (const w of Object.values(p.windows)) {
        w.activeItem = w.activeModelUrl
          ? { kind: 'media', mediaType: 'model', url: w.activeModelUrl }
          : null
        if (w.camera && w.activeModelUrl) w.cameraUrl = w.activeModelUrl
        delete w.activeModelUrl
        if (w.title === '3D View') w.title = 'Viewer'
      }
    }
    if (version < 3 && p?.windows) {
      for (const w of Object.values(p.windows)) {
        if (typeof w.textScale !== 'number') continue
        // The old window-wide zoom IS a reading size — seed it
        // UNCONDITIONALLY so nothing snaps back to 100% on upgrade, even
        // for a window parked on a media item (the common case, since
        // defaultBrowseItem prefers media)…
        w.defaultTextScale = snapTextScale(w.textScale)
        // …and pin it on the text page it was set from, if there is one.
        const k = activeItemKey(w.activeItem)
        if (k && k.startsWith('text:')) w.textScales = { [k]: w.defaultTextScale }
        delete w.textScale
      }
    }
    if (version < 4 && p?.windows) {
      for (const w of Object.values(p.windows)) {
        if (w.viewMode === 'shaded') w.look = { texture: false, shade: 'smooth', wire: false }
        else if (w.viewMode === 'wireframe') w.look = { texture: false, shade: null, wire: true }
        delete w.viewMode
      }
    }
    return p as never
  },
}))
