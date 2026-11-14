import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'
import { canJoinTileDeck, collapsePatches, expandPositions, expandTileIds, tileDeckIndex } from '../utils/tileDecks'
import { DOCK_TOLERANCE, rectsTouch } from '../utils/viewportDocking'
import { RAIL_GEOM, RAIL_TRAY, railRows, withoutCardSlot, type RailSlot } from '../utils/rail'
import { newCabinet } from '../utils/cabinetData'
import { newStoryline } from '../utils/storyline'

// 'list' | 'pool' | 'prompt' | 'history' are COMPONENTS rather than media: a
// node whose body is a whole panel. They ride the same substrate as
// everything else — drag, resize, pin, dock, select, undo, export — which is
// the point of the modular design: a component is just a node that happens
// to be a tool.
export type FreeNodeType =
  | 'note' | 'image' | 'text' | 'video' | 'audio' | 'model'
  | 'list'     // the Rolodex / image scroller
  | 'pool'     // media pool — a folder on disk
  | 'prompt'   // prompt pad + tag palette
  | 'history'  // history lens — shows the kind of history it is docked to
  | 'effect'   // an effect card — one image operator on an effect strip (utils/fx)
  | 'rail'     // a loop strip — a rail of slots that runs a workflow (utils/rail)
  | 'cabinet'  // a project cabinet — drawers that hold cards (utils/cabinet)
  | 'filmMixer' // the film's look mixer (components/FilmMixer)
  | 'storyline' // points on lines that branch (utils/storyline)
  | 'roughCut' // clips in a row, trimmed and ordered (utils/roughCut)
  | 'attributes'  // the details on the backs of the cards fed to it, side by side (utils/cardBacks)
  | 'promptCards' // a prompt pad whose words come from card backs (utils/cardBacks)
  | 'annotations' // a model's notes: its pins and strokes (store/notesStore)
  | 'area'        // a mat on the canvas that is a workspace in 3D (components/Notes/AreaBody)
  | 'stateSpace'  // a state workspace: icons joined by lines (utils/stateSpace)

export interface TextStyle {
  fontSize: number       // in px (base, before zoom scaling)
  color: string          // text color
  bgColor: string        // background color
  bgOpacity: number      // 0–1
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
  vAlign: 'top' | 'middle' | 'bottom'
  fontFamily?: string    // CSS font-family value
  lineHeight?: number    // multiplier, e.g. 1.0, 1.2, 1.5 — default 1.55
  letterSpacing?: number // px — default 0
  fontWeight?: number    // 100–900 — overrides bold when set
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSize: 18,
  color: '#ffffff',
  bgColor: '#000000',
  bgOpacity: 0,
  bold: false,
  italic: false,
  align: 'left',
  vAlign: 'top',
}

export const DEFAULT_HEADER_STYLE: TextStyle = {
  fontSize: 28,
  color: '#ffffff',
  bgColor: '#000000',
  bgOpacity: 0,
  bold: true,
  italic: false,
  align: 'center',
  vAlign: 'top',
}

export const DEFAULT_BLOCK_HEADER_STYLE: TextStyle = {
  ...DEFAULT_HEADER_STYLE,
  fontSize: 45,
}

export const DEFAULT_BODY_STYLE: TextStyle = {
  ...DEFAULT_TEXT_STYLE,
}

export interface FreeNodeData {
  id: string
  x: number
  y: number
  width: number
  height: number
  type: FreeNodeType
  label: string
  text: string
  imageUrl: string | null
  imageTransform?: import('../store/boardsStore').HeroImageTransform
  mediaType?: import('../types/bar').MediaType | null
  /** Model tiles: rendered poster thumbnail (`mediaref:`), lazily generated. */
  posterUrl?: string | null
  /** List tiles: the pinned LIVE query (results derive from the stores). */
  listQuery?: import('../utils/contentKinds').ListQuery
  /** Media Pool: the directory it points at. Only the PATH persists — the
   *  listing is re-read on mount, since a folder changes under you. */
  poolDir?: string
  /** Prompt Pad: the tag workshop and saved prompts. Persisted per pad, so
   *  two pads can carry different vocabularies. */
  promptKit?: import('../utils/promptKit').PromptKit
  /** Card Prompts: its prompt tabs (Brian 2026-11-06), each a named prompt.
   *  The tab in use keeps its text in `text`; the others keep theirs here. */
  promptTabs?: { name: string; text: string }[]
  /** Card Prompts: the tab in use (index into promptTabs). */
  promptTab?: number
  /** Effect cards: which operator, and its slider values (missing keys
   *  take their defaults — utils/fx/effects). */
  effect?: { kind: import('../utils/fx/effects').EffectKind; params?: Record<string, number>; text?: string
    /** Switched off: skipped in its chain (utils/fx/chain planChain). */
    off?: boolean
    /** Soloed: the only effect its chain runs. One per chain (effectToggles). */
    solo?: boolean }
  /** COLLAPSED TILE DECK membership — present on EVERY member, the face
   *  included (face: anchor === own id, dx = dy = 0). Absent ⇒ open.
   *  Which tiles touch is derived; only "collapsed, and where each member
   *  goes back to" is stored, because a hidden member is no longer
   *  geometry and its place cannot be re-derived. Positions are NOT moved
   *  on collapse; expanding puts each member at face + (dx, dy). Helpers:
   *  utils/tileDecks. */
  tileDeck?: { anchor: string; dx: number; dy: number }
  /** Snipped / cropped / painted out of this source image url in a Viewer
   *  (ImageStudio), on tiles from before pieces became cards. Make cards
   *  (utils/snipCards) reads it to deck them by source. */
  snipOf?: string
  /** A run's stand-in for a card's picture that is an animated GIF
   *  (utils/railCards railUnits): it runs as a clip. Never stored. */
  gifClip?: boolean
  /** The look mixer (a Film Look node mixing a deck that is not the film's
   *  own): each shot's look and its own changes to it, by the shot's key
   *  (utils/filmShots DockedClip.key). components/FilmMixer/LookMixer. */
  lookMix?: { shots: Record<string, { style?: string; tweaks?: import('../utils/styleCard').StyleTweaks }> }
  /** State workspaces: the icons and the lines between them (utils/stateSpace). */
  stateSpace?: import('../utils/stateSpace').StateSpaceData
  /** Loop strips: the RECIPE — slots left to right (utils/rail). */
  rail?: import('../utils/rail').RailData
  /** Docked on a loop strip: which rail, which slot, where in its column.
   *  The rail decides this tile's x/y/size while it is docked (the rail sync
   *  host writes them); undocking restores the size it had. */
  railDock?: import('../utils/rail').RailDock
  /** Project cabinets: the drawers and what is put away in them. */
  cabinet?: import('../utils/cabinetData').CabinetData
  /** Rough cuts: the clips in order, each trimmed (utils/roughCut). */
  roughCut?: import('../utils/roughCut').RoughCutData
  /** Storylines: the lines and the points on them, relative to x/y
   *  (utils/storyline). x/y/width/height are kept the bounding box. */
  storyline?: import('../utils/storyline').StorylineData
  /** A STAND-IN for a canvas card (or the deck it fronts) on a loop strip:
   *  never drawn, it holds the card's place in its column, and the card is
   *  moved to it (utils/railCards, useRailSync). */
  cardRef?: string
  /** A run unit of a trimmed video clip (utils/railCards railUnits): the
   *  part of it a Run draws, seconds. */
  clipIn?: number
  clipOut?: number
  /** SCREEN-PINNED instances. Present ⇒ this node is rendered by
   *  <PinLayer/> OUTSIDE the world transform and is SKIPPED by
   *  FreeCanvas. Absent ⇒ canvas-placed. That is the whole model.
   *
   *  x/y are CANVAS-CONTAINER pixels — origin = top-left of the
   *  InfiniteCanvas container, the SAME basis `pan` is measured in. NOT
   *  document space: that differs by the toolbar height and shifts again
   *  when the storage banner mounts.
   *
   *  `scale` is the world zoom FROZEN at pin time. width/height stay
   *  CANVAS units and stay LIVE — the pinned box is
   *  layout(width × height) × scale(pin.scale). That is what keeps every
   *  existing size writer working unchanged (the Rolodex expansion
   *  drawer, the aspect-locked corner, resizeFreeNode's canvas-unit
   *  floors) and what makes offsetWidth — and so the panel's own
   *  embedScale — identical across the flip.
   *
   *  While pinned, x/y hold the pre-pin canvas position: stale, but still
   *  a VALID canvas quantity, so a missed guard is cosmetic rather than
   *  corrupting. Unpin recomputes them. */
  pin?: { x: number; y: number; scale: number }
  /** Where this node came FROM, captured when it was pinned. Unpinning
   *  puts it back here rather than dropping it wherever it happened to be
   *  sitting on screen — a pin is a temporary visit to the screen, not a
   *  move. Absent on nodes pinned before this existed, and on nodes that
   *  have never been pinned; both fall back to unprojecting the current
   *  position, which is the old behaviour. The re-home control overwrites
   *  it with the current spot when the visit turns out to be permanent. */
  home?: { x: number; y: number; width: number; height: number }
  /** Panel content scale, chosen by the user. Reshaping a panel changes its
   *  SHAPE; this changes how big everything inside it is drawn. Two
   *  independent gestures, the way the Rolodex already separates its drawer
   *  from its frame. Deliberately not derived from zoom: a browser whose
   *  contents re-flow as you zoom loses your place. */
  uiScale?: number
  /** For a Rolodex with a Viewer magneted to it: how a row reaches that
   *  Viewer. 'click' — only an explicit click sends. 'follow' — whatever the
   *  list settles on is shown, so flipping through browses live. Meaningless
   *  without an adjacent Viewer, which is why it lives here rather than in a
   *  stored link: the link itself is still pure geometry. */
  linkMode?: 'click' | 'follow'
  /** Media Pool view settings. On the node because they were component
   *  state, and every remount — zoom-layer switch, pin, cull — put the pool
   *  back to defaults mid-task. */
  poolSizeIdx?: number
  poolFilter?: string
  color: string
  textStyle?: TextStyle
  /** Annotation layer — vector strokes drawn on this node. */
  strokes?: import('../types/stroke').Stroke[]
  /** Annotation cards: the model file whose notes it shows (store/notesStore). */
  annotUrl?: string
  /** A 3D area out of a card: that card (utils/area3dCard). */
  areaCard?: string
  /** A 3D area out of a card: what already lay where it opened ('card:<id>',
   *  'node:<id>', 'viewer:<id>', 'curve:<id>'). Under it, not on it: never
   *  moved, folded in or stood in its scene, until moved by hand
   *  (utils/area3dScene isUnder). */
  under?: string[]
  /** A 3D area: where its ground's grid begins, from its top-left corner
   *  (canvas units). Its top or left edge pulled, the grid stays where it
   *  lay under what is on it (utils/area3dScene holdSets). Absent: at the
   *  corner. */
  gridAt?: { x: number; y: number }
  /** A 3D set: what its ground is drawn as (components/Notes/AreaBody).
   *  Absent: lines. 'none' is no ground at all, only its thin outline. */
  ground?: AreaGround
  /** A 3D set: its Play bar goes round again from the start when it comes
   *  to the end (components/UI/RidePlayBar). Absent: it stops there. */
  rideLoop?: boolean
  /** A 3D set: how its models show in the flat view (utils/liveTop).
   *  Absent: as pieces, pictures from above (utils/scenePieces). 'live':
   *  the models themselves, drawn live in 3D from straight above. */
  flatView?: AreaFlatView
}

/** A 3D set's ground: a line grid, dots, crosses, or nothing. */
export type AreaGround = 'lines' | 'dots' | 'cross' | 'none'
/** A 3D set's models in the flat view: pieces, or live 3D from above. */
export type AreaFlatView = 'pieces' | 'live'

const COLORS = ['#1e2235', '#1e3028', '#2e1e35', '#35281e', '#1e2e35', '#2e351e']
let colorIdx = 0

// COMPONENTS start twice as big per side — four times the area. They are
// tools, not tiles: a Media Pool wants a readable grid, a Prompt Pad
// wants its sections side by side, and at the old sizes every one of
// them had to be resized before it was usable. Media tiles keep their
// modest defaults; a dropped image is content, not an instrument.
const DEFAULT_HEIGHTS: Record<FreeNodeType, number> = {
  image: 180, note: 160, text: 180, video: 180, audio: 120, model: 180,
  list: 880, pool: 1080, prompt: 720, history: 800, effect: 252,
  rail: 360,   // a placeholder: the rail sizes itself to its layout
  cabinet: 280,
  filmMixer: 860,
  storyline: 0,   // its box is its lines' (utils/storyline)
  roughCut: 562,
  attributes: 760,
  promptCards: 600,
  annotations: 520,
  area: 900,
  stateSpace: 720,
}
const DEFAULT_WIDTHS: Partial<Record<FreeNodeType, number>> = {
  audio: 260,
  // Lists host a full embedded Rolodex — size for its natural panel
  // width (LEFTCOL_W 196 + margins), doubled.
  list: 480,
  // Brian's own pool (2026-11-03): about nine 'mid' tiles across. This
  // is its content size at uiScale 1; addFreeNodeCentered scales it.
  pool: 780,
  prompt: 920,
  history: 520,
  // A playing card, 5:7 (FreeNode holds that ratio on resize). The
  // whole tile is the card's face: name, then a slider per value.
  effect: 180,
  cabinet: 320,
  filmMixer: 1240,  // the button sizes it to the screen (openFilmMixer)
  roughCut: 1400,   // and so does this one's (openRoughCut)
  attributes: 1180,
  promptCards: 1080,
  annotations: 760,
  area: 1400,
  stateSpace: 1180,
}

/** A new free node's size before any zoom compensation. addFreeNode makes
 *  nodes this size; the toolbar's placing outline (utils/placeTool) reads it
 *  so the outline is the size of what lands. */
export function freeNodeDefaultSize(type: FreeNodeType): { width: number; height: number } {
  return { width: DEFAULT_WIDTHS[type] ?? 200, height: DEFAULT_HEIGHTS[type] ?? 160 }
}

interface FreeNodeStore {
  nodes: Record<string, FreeNodeData>
  selectedIds: string[]
  addFreeNode: (x: number, y: number, type: FreeNodeType) => string
  moveFreeNode: (id: string, dx: number, dy: number) => void
  moveManyFreeNodes: (ids: string[], dx: number, dy: number) => void
  resizeFreeNode: (id: string, dw: number, dh: number) => void
  /** Flip nodes between screen-pinned and canvas-placed. Takes an ARRAY
   *  so a host and everything docked to it later convert in ONE set —
   *  a half-converted assembly can then never exist, not even across the
   *  400ms debounced IDB write. pan/zoom are PASSED IN so this store
   *  keeps zero imports of canvasStore. */
  setNodePlacement: (ids: string[], to: 'screen' | 'canvas',
                     view: { pan: { x: number; y: number }; zoom: number }) => void
  /** Re-home a PINNED node: make where it sits now the spot it returns to.
   *  Without this a pin could never be made permanent — you would always
   *  snap back to wherever you first pinned from. */
  rehomePinnedNode: (id: string,
                     view: { pan: { x: number; y: number }; zoom: number }) => void
  /** SCREEN-px delta for pinned nodes. moveManyFreeNodes stays
   *  canvas-delta-only; keeping the two separate is what lets a pinned
   *  host carry pinned children later without reopening this store. */
  movePinnedNodes: (ids: string[], dx: number, dy: number) => void
  clampPinnedIntoView: (hostW: number, hostH: number) => void
  updateFreeNode: (id: string, patch: Partial<FreeNodeData>) => void
  /** Collapse touching tiles into a TILE DECK (utils/tileDecks). `clusterIds`
   *  in reading order — the first becomes the face. Selects only the face
   *  and returns its id, or null when there was nothing to collapse. The
   *  CALLER takes the undo checkpoint. */
  collapseTiles: (clusterIds: string[]) => string | null
  /** Open a tile deck: every member back at face + its offset, the deck
   *  fields cleared on all of them (face included), all of them selected. */
  expandTileDeck: (faceId: string) => void
  /** Deletes a deck FACE together with everything hidden behind it — what
   *  you see is what you delete; undo brings the whole deck back. */
  // ── Loop strips (utils/rail) — callers take the undo checkpoint ──
  /** A new rail at (x, y), sized by `unit`, holding one empty "Pictures"
   *  role slot. Returns its id. */
  addRail: (x: number, y: number, unit: number) => string
  /** Dock tiles on a rail. A column target takes pictures (in the order
   *  given, inserted at `index`); a row target takes ONE effect card as a new
   *  card slot at `insertAt`. Tiles already docked elsewhere move. */
  dockToRail: (nodeIds: string[], target: import('../utils/rail').RailDropTarget) => void
  /** Take a tile off its rail: its own size comes back, and a card slot it
   *  held is removed. x/y stay where the rail last put it. */
  undockFromRail: (nodeId: string) => void
  /** Change a slot's name or mode. */
  setRailSlot: (railId: string, slotId: string, patch: { name?: string; mode?: 'each' | 'pick' }) => void
  /** Add an empty role slot at the rail's start or end. Returns its id. */
  addRailRole: (railId: string, at: 'start' | 'end', name?: string) => string | null
  /** Remove an EMPTY role slot (a slot with cards stays). */
  removeRailSlot: (railId: string, slotId: string) => void
  /** A new, empty look row under the strip (RailData.rows). */
  addRailRow: (railId: string) => void
  /** Remove look row `index` (1 = the first): its cards come off the strip. */
  removeRailRow: (railId: string, index: number) => void
  /** Move slot `slotId` to before the slot now at `insertAt` (its length:
   *  the end) in row `row` (0: the strip's own row; k: RailData.rows[k-1]),
   *  what is docked in it going along. Pictures columns stay in row 0. */
  moveRailSlot: (railId: string, slotId: string, insertAt: number, row?: number) => void
  /** Delete the result tiles in a rail's tray (the files stay on disk). */
  clearRailTray: (railId: string) => void
  deleteFreeNode: (id: string) => void
  setFreeSelection: (ids: string[]) => void
  toggleFreeSelection: (id: string) => void
  clearFreeSelection: () => void
}

/** Undock what is docked on rail `railId` and passes `which`, into `out`:
 *  set down in a row just below the rail, at its own size — columns left to
 *  right, then the tray. Held cards become cards again (useRailSync).
 *  Returns whether anything moved. */
function setDownBelow(nodes: Record<string, FreeNodeData>, railId: string, which: (n: FreeNodeData) => boolean, out: Record<string, FreeNodeData>): boolean {
  const rail = nodes[railId]
  if (rail?.type !== 'rail') return false
  const slots = [...(rail.rail?.slots.map(sl => sl.id) ?? []), RAIL_TRAY]
  const gap = RAIL_GEOM.gap * (rail.rail?.unit ?? 1)
  let x = rail.x
  const y = rail.y + rail.height + gap * 2
  const docked = Object.values(nodes)
    .filter(n => n.railDock?.railId === railId && which(n))
    .sort((a, b) => (slots.indexOf(a.railDock!.slotId) - slots.indexOf(b.railDock!.slotId)) || (a.railDock!.order - b.railDock!.order))
  for (const n of docked) {
    const d = n.railDock!
    const w = d.prevW ?? n.width, h = d.prevH ?? n.height
    out[n.id] = { ...n, railDock: undefined, x, y, width: w, height: h }
    x += w + gap
  }
  return docked.length > 0
}

export const useFreeNodeStore = create<FreeNodeStore>()(persist((set) => ({
  nodes: {},
  selectedIds: [],

  addFreeNode: (x, y, type) => {
    const id = crypto.randomUUID()
    const color = COLORS[colorIdx++ % COLORS.length]
    const labels: Record<FreeNodeType, string> = {
      image: 'Image', note: 'Note', text: 'Text', video: 'Video', audio: 'Audio', model: 'Model',
      list: 'List', pool: 'Media Pool', prompt: 'Prompt Pad', history: 'History',
      effect: 'Effect', rail: 'Loop strip', cabinet: 'Project cabinet', filmMixer: 'Film Look',
      storyline: 'Storyline', roughCut: 'Rough Cut',
      attributes: 'Attributes', promptCards: 'Card Prompts',
      annotations: 'Annotations', area: '3D set', stateSpace: 'States',
    }
    const node: FreeNodeData = {
      id, x, y,
      ...freeNodeDefaultSize(type),
      type,
      label: labels[type] ?? type,
      text: '',
      imageUrl: null,
      mediaType: null,
      color,
      ...(type === 'cabinet' ? { cabinet: newCabinet() } : {}),
      ...(type === 'storyline' ? { width: 0, storyline: newStoryline() } : {}),
      ...(type === 'roughCut' ? { roughCut: { clips: [], pps: 60 } } : {}),
      ...(type === 'stateSpace' ? { stateSpace: { items: [], wires: [] } } : {}),
      ...(type === 'area' || type === 'annotations' ? { color: '#141a28' } : {}),
    }
    set(s => ({ nodes: { ...s.nodes, [id]: node } }))
    return id
  },

  moveFreeNode: (id, dx, dy) => {
    if (dx === 0 && dy === 0) return
    set(s => {
      if (!s.nodes[id]) return s
      // A deck FACE carries what is hidden behind it, so the members' x/y
      // stay face + offset and opening the deck lands them beside it, not
      // back where the deck was first collapsed. Moves only — resizes write
      // x/y through updateFreeNode and must not drag the deck along.
      const nodes = { ...s.nodes }
      for (const mid of expandTileIds([id], s.nodes)) {
        const n = nodes[mid]
        if (n) nodes[mid] = { ...n, x: n.x + dx, y: n.y + dy }
      }
      return { nodes }
    })
  },

  moveManyFreeNodes: (ids, dx, dy) => {
    if (dx === 0 && dy === 0) return
    set(s => {
      const updated = { ...s.nodes }
      // Faces bring their hidden members (see moveFreeNode). De-duplicated,
      // so a selection holding both a face and one of its members — or a
      // Viewer carrying a face — still moves each tile exactly once.
      for (const id of expandTileIds(ids, s.nodes)) {
        const n = updated[id]
        // Canvas deltas only — pinned nodes take SCREEN deltas via
        // movePinnedNodes. Unguarded, dragging a Viewer header at zoom
        // 0.1 would walk a pinned panel 100px per 10px of drag.
        if (n && !n.pin) updated[id] = { ...n, x: n.x + dx, y: n.y + dy }
      }
      return { nodes: updated }
    })
  },

  resizeFreeNode: (id, dw, dh) =>
    set(s => {
      const n = s.nodes[id]
      if (!n) return s
      return { nodes: { ...s.nodes, [id]: { ...n, width: Math.max(120, n.width + dw), height: Math.max(80, n.height + dh) } } }
    }),

  setNodePlacement: (ids, to, view) =>
    set(s => {
      const nodes = { ...s.nodes }
      let changed = false
      for (const id of ids) {
        const n = nodes[id]
        if (!n) continue
        if (to === 'screen') {
          if (n.pin) continue
          // The rect the browser is painting RIGHT NOW: the world div is
          // translate(pan) scale(zoom) and the node is left:x top:y.
          nodes[id] = {
            ...n,
            pin: {
              x: view.pan.x + n.x * view.zoom,
              y: view.pan.y + n.y * view.zoom,
              scale: view.zoom,
            },
            // Remember where it stood, so unpinning is a return trip.
            home: { x: n.x, y: n.y, width: n.width, height: n.height },
          }
        } else {
          if (!n.pin) continue
          const { pin: _drop, home: _dropHome, ...rest } = n
          // Deliberately NOT routed through resizeFreeNode: its 120/80
          // floors would silently resize a small tile mid-flip and break
          // the seam.
          if (n.home) {
            nodes[id] = { ...rest, ...n.home }
          } else {
            // No recorded home — either pinned before homes existed, or
            // re-homing was never used. Unproject where it is now, which
            // is what unpin always did.
            const k = n.pin.scale / view.zoom
            nodes[id] = {
              ...rest,
              x: (n.pin.x - view.pan.x) / view.zoom,
              y: (n.pin.y - view.pan.y) / view.zoom,
              width: n.width * k,
              height: n.height * k,
            }
          }
        }
        changed = true
      }
      return changed ? { nodes } : s
    }),

  rehomePinnedNode: (id, view) =>
    set(s => {
      const n = s.nodes[id]
      if (!n?.pin) return s
      // Exactly the rect a no-home unpin would produce — so pressing this
      // and then unpinning leaves the panel visually where it is.
      const k = n.pin.scale / view.zoom
      return {
        nodes: {
          ...s.nodes,
          [id]: {
            ...n,
            home: {
              x: (n.pin.x - view.pan.x) / view.zoom,
              y: (n.pin.y - view.pan.y) / view.zoom,
              width: n.width * k,
              height: n.height * k,
            },
          },
        },
      }
    }),

  movePinnedNodes: (ids, dx, dy) => {
    if (dx === 0 && dy === 0) return
    set(s => {
      const nodes = { ...s.nodes }
      for (const id of ids) {
        const n = nodes[id]
        if (n?.pin) nodes[id] = { ...n, pin: { ...n.pin, x: n.pin.x + dx, y: n.pin.y + dy } }
      }
      return { nodes }
    })
  },

  clampPinnedIntoView: (hostW, hostH) =>
    set(s => {
      if (hostW <= 0 || hostH <= 0) return s
      const KEEP = 48
      const nodes = { ...s.nodes }
      let changed = false
      for (const n of Object.values(s.nodes)) {
        if (!n.pin) continue
        const w = n.width * n.pin.scale
        // x may go negative (a panel can hang off the left edge); y floors
        // at 0 because the header is the drag handle and a header above
        // the top edge is unrecoverable.
        const x = Math.max(KEEP - w, Math.min(hostW - KEEP, n.pin.x))
        const y = Math.max(0, Math.min(hostH - KEEP, n.pin.y))
        if (x !== n.pin.x || y !== n.pin.y) {
          nodes[n.id] = { ...n, pin: { ...n.pin, x, y } }
          changed = true
        }
      }
      return changed ? { nodes } : s
    }),

  updateFreeNode: (id, patch) =>
    set(s => {
      const n = s.nodes[id]
      if (!n) return s
      return { nodes: { ...s.nodes, [id]: { ...n, ...patch } } }
    }),

  collapseTiles: (clusterIds) => {
    let faceId: string | null = null
    set(s => {
      const patches = collapsePatches(clusterIds, s.nodes)
      if (!patches) return s
      const nodes = { ...s.nodes }
      for (const [id, tileDeck] of Object.entries(patches)) {
        const n = nodes[id]
        if (n) nodes[id] = { ...n, tileDeck }
        faceId = tileDeck.anchor
      }
      // Only the face: everything else just left the canvas, and a
      // selection holding hidden tiles would carry them into Delete.
      return { nodes, selectedIds: faceId ? [faceId] : [] }
    })
    return faceId
  },

  expandTileDeck: (faceId) =>
    set(s => {
      const face = s.nodes[faceId]
      if (!face?.tileDeck) return s
      const pos = expandPositions(faceId, s.nodes)
      const nodes = { ...s.nodes }
      // MAKE ROOM first. While collapsed, the space right of the face is
      // free as far as everything else knows — hidden members are not
      // geometry — so tiles land there: the Effects palette puts a new card
      // flush right of a selected face, a dragged card snaps to the face's
      // edge. Reopening on top of them would stack two tiles on one spot,
      // and an effect strip (read left to right, ties by insertion order)
      // would read the newcomer in the MIDDLE of the deck's cards: the
      // processed picture would change just from opening the deck. So the
      // tiles lined up after the face move right by the deck's hidden
      // extent, and the open strip reads exactly as the collapsed one did.
      // Same set, so it is one undo step with the expand.
      const faceRight = face.x + face.width
      const shift = Math.max(...Object.entries(pos).map(([mid, p]) => p.x + (s.nodes[mid]?.width ?? 0))) - faceRight
      if (shift > 0) {
        const { hidden } = tileDeckIndex(s.nodes)
        const restored = Object.entries(pos).flatMap(([mid, p]) => {
          const m = s.nodes[mid]
          return m && mid !== faceId ? [{ ...p, width: m.width, height: m.height }] : []
        })
        // Visible canvas tiles after the face, other than the deck's own.
        const after = Object.values(s.nodes).filter(o =>
          !pos[o.id] && !o.pin && !hidden.has(o.id) && o.x >= faceRight - DOCK_TOLERANCE)
        // In the way: overlapping where a member reopens, or a deck-able
        // tile touching the face — it would read amid the reopened members,
        // and it cannot have been there at collapse time, or it would be in
        // the deck. (A panel touching the face may have been; it only moves
        // if it is actually in the way.)…
        const push = new Set(after.filter(o =>
          (canJoinTileDeck(o) && rectsTouch(face, o, DOCK_TOLERANCE)) ||
          restored.some(r => rectsTouch(r, o, -1))).map(o => o.id))
        // …and whatever is lined up after those, so the rest of a strip
        // keeps its place in the line instead of being run over.
        const queue = [...push]
        while (queue.length) {
          const cur = s.nodes[queue.pop()!]
          for (const o of after) {
            if (push.has(o.id) || !rectsTouch(cur, o, DOCK_TOLERANCE)) continue
            push.add(o.id)
            queue.push(o.id)
          }
        }
        // A pushed face takes the tiles hidden behind it along.
        for (const pid of expandTileIds([...push], s.nodes)) {
          const n = nodes[pid]
          if (n && !n.pin && !pos[pid]) nodes[pid] = { ...n, x: n.x + shift }
        }
      }
      const ids: string[] = []
      for (const [id, p] of Object.entries(pos)) {
        const n = nodes[id]
        if (!n) continue
        nodes[id] = { ...n, x: p.x, y: p.y, tileDeck: undefined }
        ids.push(id)
      }
      // All of them, so the deck that was just opened can be moved — or
      // collapsed again from the menu — as the one thing it was.
      return { nodes, selectedIds: ids }
    }),

  addRail: (x, y, unit) => {
    const id = crypto.randomUUID()
    const slotId = crypto.randomUUID()
    const node: FreeNodeData = {
      id, x, y, width: 600 * unit, height: 360 * unit,
      type: 'rail', label: 'Loop strip', text: '', imageUrl: null, mediaType: null,
      color: '#2a2b3a',
      rail: { unit, output: 'process', slots: [{ id: slotId, kind: 'role', name: 'Pictures', mode: 'each' }] },
    }
    set(s => ({ nodes: { ...s.nodes, [id]: node } }))
    return id
  },

  dockToRail: (nodeIds, target) =>
    set(s => {
      const rail = s.nodes[target.railId]
      if (!rail?.rail || rail.pin) return s
      const nodes = { ...s.nodes }
      let slots = rail.rail.slots
      // Look rows (RailData.rows): a 'row' target with row > 0 goes into one.
      let rows = rail.rail.rows
      const toRow = target.kind === 'row' ? target.row ?? 0 : 0
      let insertAt = target.kind === 'row' ? target.insertAt : 0
      // Off any rail first — a card slot it held goes with it.
      const ids = nodeIds.filter(id => nodes[id] && !nodes[id].pin && id !== target.railId)
      // An effect card's inputs (tucked under it, order 1…) move with it to
      // its new slot, and come off the rail when it leaves the slot row.
      const followers = new Map<string, string[]>()
      for (const id of ids) {
        const d = nodes[id].railDock
        if (!d || d.order !== 0 || nodes[id].type !== 'effect') continue
        followers.set(id, Object.values(nodes)
          .filter(m => !ids.includes(m.id) && m.railDock?.railId === d.railId && m.railDock.slotId === d.slotId && m.railDock.order > 0)
          .sort((a, b) => a.railDock!.order - b.railDock!.order).map(m => m.id))
      }
      for (const id of ids) {
        const d = nodes[id].railDock
        if (!d) continue
        // An input leaving its card leaves the card's slot where it is.
        const own = nodes[d.railId]?.rail
        if (d.order > 0 && own && railRows(own).flat().some(sl => sl.kind === 'card' && sl.id === d.slotId)) continue
        if (d.railId === target.railId) {
          // railDropTarget counted this card's own slot (still listed while
          // the card is lifted): removing it from before the insert point
          // moves that point one to the left — in the row it is going into.
          const inRow = toRow === 0 ? slots : rows?.[toRow - 1] ?? []
          const was = inRow.findIndex(sl => sl.kind === 'card' && sl.id === d.slotId)
          if (was >= 0 && was < insertAt) insertAt--
          const r = withoutCardSlot({ ...rail.rail, slots, rows }, d.slotId)
          slots = r.slots
          rows = r.rows
        } else if (own) {
          nodes[d.railId] = { ...nodes[d.railId], rail: withoutCardSlot(own, d.slotId) }
        }
      }
      const keepSize = (n: FreeNodeData) => ({ prevW: n.railDock?.prevW ?? n.width, prevH: n.railDock?.prevH ?? n.height })
      if (target.kind === 'row') {
        const id = ids.find(i => nodes[i].type === 'effect')
        if (!id) return s
        const slotId = crypto.randomUUID()
        const into = (row: RailSlot[]) => {
          const at = Math.max(0, Math.min(insertAt, row.length))
          return [...row.slice(0, at), { id: slotId, kind: 'card' as const }, ...row.slice(at)]
        }
        if (toRow > 0 && rows && rows[toRow - 1]) rows = rows.map((row, k) => (k === toRow - 1 ? into(row) : row))
        else slots = into(slots)
        nodes[id] = { ...nodes[id], tileDeck: undefined, railDock: { railId: target.railId, slotId, order: 0, ...keepSize(nodes[id]) } }
        ;(followers.get(id) ?? []).forEach((fid, k) => {
          nodes[fid] = { ...nodes[fid], railDock: { ...nodes[fid].railDock!, railId: target.railId, slotId, order: k + 1 } }
        })
      } else {
        // The column's other cards, in order, with the new ones spliced in.
        const moving = new Set(ids)
        const column = Object.values(nodes)
          .filter(n => !moving.has(n.id) && n.railDock?.railId === target.railId && n.railDock.slotId === target.slotId)
          .sort((a, b) => a.railDock!.order - b.railDock!.order)
          .map(n => n.id)
        // Inputs go under the card's existing inputs; nothing else is an input.
        const placed = target.kind === 'input' ? ids.filter(i => nodes[i].type === 'effect') : ids
        const at = target.kind === 'input' ? column.length : Math.max(0, Math.min(target.index, column.length))
        const ordered = [...column.slice(0, at), ...placed, ...column.slice(at)]
        ordered.forEach((nid, order) => {
          const n = nodes[nid]
          // A card already in the column keeps `lifted`: it may be in the
          // user's hand while a run lands a result in this column (the tray).
          const lifted = moving.has(nid) ? undefined : n.railDock?.lifted
          nodes[nid] = { ...n, tileDeck: undefined, railDock: { railId: target.railId, slotId: target.slotId, order, ...keepSize(n), lifted } }
        })
        // A card that left the slot row: its inputs come off with it.
        for (const fids of followers.values()) for (const fid of fids) {
          const m = nodes[fid]
          nodes[fid] = { ...m, railDock: undefined, width: m.railDock?.prevW ?? m.width, height: m.railDock?.prevH ?? m.height }
        }
      }
      nodes[target.railId] = { ...nodes[target.railId], rail: { ...rail.rail, slots, ...(rows ? { rows } : {}) } }
      return { nodes }
    }),

  undockFromRail: (nodeId) =>
    set(s => {
      const n = s.nodes[nodeId]
      const d = n?.railDock
      if (!n || !d) return s
      const nodes = { ...s.nodes }
      nodes[nodeId] = { ...n, railDock: undefined, width: d.prevW ?? n.width, height: d.prevH ?? n.height }
      const rail = nodes[d.railId]
      // An input tucked under an effect card (order 1…) leaves the card's slot.
      const cardSlot = !!rail?.rail && railRows(rail.rail).flat().some(sl => sl.kind === 'card' && sl.id === d.slotId)
      const isInput = d.order > 0 && cardSlot
      if (rail?.rail && !isInput) {
        nodes[d.railId] = { ...rail, rail: withoutCardSlot(rail.rail, d.slotId) }
        // An effect card leaving takes the inputs tucked under it off too.
        if (n.type === 'effect' && cardSlot) {
          for (const m of Object.values(nodes)) {
            if (m.id === nodeId || m.railDock?.railId !== d.railId || m.railDock.slotId !== d.slotId) continue
            nodes[m.id] = { ...m, railDock: undefined, width: m.railDock.prevW ?? m.width, height: m.railDock.prevH ?? m.height }
          }
        }
        // Close the gap it left in its column.
        Object.values(nodes)
          .filter(m => m.railDock?.railId === d.railId && m.railDock.slotId === d.slotId)
          .sort((a, b) => a.railDock!.order - b.railDock!.order)
          .forEach((m, order) => { if (m.railDock!.order !== order) nodes[m.id] = { ...m, railDock: { ...m.railDock!, order } } })
      }
      return { nodes }
    }),

  setRailSlot: (railId, slotId, patch) =>
    set(s => {
      const rail = s.nodes[railId]
      if (!rail?.rail) return s
      const slots = rail.rail.slots.map(sl => sl.id === slotId && sl.kind === 'role' ? { ...sl, ...patch } : sl)
      return { nodes: { ...s.nodes, [railId]: { ...rail, rail: { ...rail.rail, slots } } } }
    }),

  addRailRole: (railId, at, name) => {
    const rail = useFreeNodeStore.getState().nodes[railId]
    if (!rail?.rail) return null
    const slot = { id: crypto.randomUUID(), kind: 'role' as const, name: name ?? 'Pictures', mode: 'each' as const }
    const slots = at === 'start' ? [slot, ...rail.rail.slots] : [...rail.rail.slots, slot]
    set(s => ({ nodes: { ...s.nodes, [railId]: { ...s.nodes[railId], rail: { ...rail.rail!, slots } } } }))
    return slot.id
  },

  moveRailSlot: (railId, slotId, insertAt, row = 0) =>
    set(s => {
      const rail = s.nodes[railId]
      if (!rail?.rail) return s
      const rows = railRows(rail.rail)
      const fromRow = rows.findIndex(r => r.some(sl => sl.id === slotId))
      if (fromRow < 0 || !rows[row]) return s
      const from = rows[fromRow].findIndex(sl => sl.id === slotId)
      const moved = rows[fromRow][from]
      if (moved.kind === 'role' && row !== 0) return s
      const to = fromRow === row && insertAt > from ? insertAt - 1 : insertAt
      if (fromRow === row && to === from) return s
      const next = rows.map(r => r.filter(sl => sl.id !== slotId))
      next[row].splice(Math.max(0, Math.min(next[row].length, to)), 0, moved)
      const [slots, ...looks] = next
      return { nodes: { ...s.nodes, [railId]: { ...rail, rail: { ...rail.rail, slots, ...(rail.rail.rows ? { rows: looks } : {}) } } } }
    }),

  removeRailSlot: (railId, slotId) =>
    set(s => {
      const rail = s.nodes[railId]
      if (!rail?.rail) return s
      if (Object.values(s.nodes).some(n => n.railDock?.railId === railId && n.railDock.slotId === slotId)) return s
      // From whichever row holds it (utils/rail withoutCardSlot).
      const cleared = withoutCardSlot(rail.rail, slotId)
      return { nodes: { ...s.nodes, [railId]: { ...rail, rail: { ...cleared, slots: cleared.slots.filter(sl => sl.id !== slotId) } } } }
    }),

  addRailRow: (railId) =>
    set(s => {
      const rail = s.nodes[railId]
      if (!rail?.rail) return s
      return { nodes: { ...s.nodes, [railId]: { ...rail, rail: { ...rail.rail, rows: [...(rail.rail.rows ?? []), []] } } } }
    }),

  removeRailRow: (railId, index) =>
    set(s => {
      const rail = s.nodes[railId]
      const row = rail?.rail?.rows?.[index - 1]
      if (!rail?.rail || !row) return s
      const nodes = { ...s.nodes }
      // Its cards, and the inputs under them, come off where they are.
      const ids = new Set(row.map(sl => sl.id))
      for (const m of Object.values(nodes)) {
        if (m.railDock?.railId !== railId || !ids.has(m.railDock.slotId)) continue
        nodes[m.id] = { ...m, railDock: undefined, width: m.railDock.prevW ?? m.width, height: m.railDock.prevH ?? m.height }
      }
      const rows = rail.rail.rows!.filter((_, k) => k !== index - 1)
      nodes[railId] = { ...rail, rail: { ...rail.rail, rows: rows.length ? rows : undefined } }
      return { nodes }
    }),

  // Results are kept, as a deleted strip's are: set down below the strip.
  clearRailTray: (railId) =>
    set(s => {
      const nodes = { ...s.nodes }
      return setDownBelow(s.nodes, railId, n => n.railDock?.slotId === RAIL_TRAY, nodes) ? { nodes } : s
    }),

  deleteFreeNode: (id) =>
    set(s => {
      // A cabinet holding anything stays: its contents exist nowhere else.
      // Delete and Empty all put them on the canvas first (emptyCabinet).
      if (s.nodes[id]?.cabinet?.drawers.some(d => d.items.length > 0)) return s
      // A face takes its hidden members with it: deleting only the face
      // would orphan them, and orphans SHOW again (isHiddenTile) — a delete
      // that made tiles appear.
      const gone = new Set(expandTileIds([id], s.nodes))
      const nodes = { ...s.nodes }
      for (const d of gone) delete nodes[d]
      // A loop strip deletes only itself: what was docked on it — cards that
      // hold pictures, results — is set down in a row just below where it
      // was, at its own size, columns left to right, then the tray. A held
      // card becomes a card again (useRailSync). Undo brings it all back.
      if (s.nodes[id]?.type === 'rail') setDownBelow(s.nodes, id, () => true, nodes)
      // A hidden member deleted on its own (from the Card Browser) can
      // leave its face alone in its deck; a deck of one is just a tile.
      const anchor = s.nodes[id]?.tileDeck?.anchor
      if (anchor && anchor !== id && nodes[anchor]?.tileDeck &&
          !Object.values(nodes).some(m => m.id !== anchor && m.tileDeck?.anchor === anchor)) {
        nodes[anchor] = { ...nodes[anchor], tileDeck: undefined }
      }
      return { nodes, selectedIds: s.selectedIds.filter(x => !gone.has(x)) }
    }),

  setFreeSelection: (ids) => set({ selectedIds: ids }),
  toggleFreeSelection: (id) => set(s => ({
    selectedIds: s.selectedIds.includes(id)
      ? s.selectedIds.filter(x => x !== id)
      : [...s.selectedIds, id],
  })),
  clearFreeSelection: () => set({ selectedIds: [] }),
}), {
  name: 'vidbars-freenodes',
  // An empty tile set never replaces saved tiles unless they were deleted
  // in this session (utils/debouncedIDBStorage).
  storage: createDebouncedIDBStorage<Pick<FreeNodeStore, 'nodes'>>(400, { isEmpty: (s) => Object.keys(s.nodes ?? {}).length === 0 }),
  partialize: (s) => ({ nodes: s.nodes }),  // selectedIds is transient
  // A 3D area, then a "3D scene", is a "3D set" (Brian 2026-11-10): the
  // old default names take the new one. A name of its own stays.
  merge: (persisted, current) => {
    const nodes = { ...((persisted as Partial<FreeNodeStore> | undefined)?.nodes ?? current.nodes) }
    for (const [id, n] of Object.entries(nodes)) {
      if (n.type === 'area' && (n.label === '3D area' || n.label === 'Area' || n.label === '3D scene')) nodes[id] = { ...n, label: '3D set' }
    }
    return { ...current, ...(persisted as object), nodes }
  },
}))
