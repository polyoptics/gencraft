import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'
import { useCanvasStore } from './canvasStore'
import { usePinTravelStore } from './pinTravelStore'
import { sameRef, type LinkRef } from '../utils/linkTargets'
import type { Bar } from '../types/bar'
import { TEMPLATES } from '../data/templates'
import { CARD_TYPES, cardTypeOf, isAbove, newDetailId, typeColor, withTypeDetails, type CardType } from '../utils/cardTypes'
import { fillCard, nameKindOf } from '../utils/fillDetails'
import { makeName, nameKey } from '../utils/nameGen'
import { removeFromKin, type Kin } from '../utils/family'
import { deckLay, linkedLines } from '../utils/deckAway'
import { deckFront, primaryFirst } from '../utils/primaryCard'
import { useFreeNodeStore } from './freeNodeStore'
import { newSceneLayout, putCards, type SceneDiv } from '../utils/sceneCard'
import { getBoardAbsolutePos, computeGroupLayout, yToRow } from '../utils/nleRows'
import {
  makeBar,
  collectSubtree,
  addChild,
  addSibling,
  moveBarOp,
  moveMultipleOp,
  resizeEdge,
  deleteBarOp,
  deleteSubtreeOp,
  addParentAboveOp,
  reorderSiblingsOp,
  collapseAllToggleOp,
  importBarsOp,
  changeRowOp,
  reparentBarOp,
} from '../utils/barOps'

// Starting footprint of a new board's root bar — i.e. how big a brand-new
// card is at board zoom. A quarter of the original 480x270, same 16:9, so
// a new card arrives at a workable size instead of filling the view. Only
// NEW boards are affected; existing ones keep the size they were given.
export const INIT_W = 120
export const INIT_H = 67.5
const PRIMARY_INIT_ID = 'root-bar'

/** A project group — boards that collapse into one card at card zoom level */
export interface HeroImageTransform {
  scale: number      // 1 = cover-fit, >1 = zoomed in
  offsetX: number    // % shift from center (background-position)
  offsetY: number    // % shift from center
  flipH: boolean
  flipV: boolean
  opacity?: number   // hero image opacity (0–1, default 0.7)
}

/** The face a NEW card starts with: its picture at full strength, not
 *  blended into the card colour. A card made before this has no transform
 *  and keeps the 0.7 blend it always had (HeroImageLayer's default); the
 *  blend control dials either down. Every card-making path uses this. */
export const NEW_CARD_FACE: HeroImageTransform = { scale: 1, offsetX: 0, offsetY: 0, flipH: false, flipV: false, opacity: 1 }

export interface ProjectGroup {
  id: string
  name: string
  color: string
  boardIds: string[]   // ordered, can include 'primary'
  cardHeroImage: string | null
  cardHeroTransform?: HeroImageTransform
  /** SCREEN-PINNED cards — same shape and meaning as a free node's `pin`: a
   *  container-space anchor for the card's ORIGIN, plus the zoom frozen at
   *  pin time. Present ⇒ the card renders in PinLayer with a frozen camera
   *  instead of inside the canvas layers, so it holds still while the world
   *  moves under it. originX/originY stay world coordinates and stay live,
   *  which is what makes pin/unpin seamless. */
  pin?: { x: number; y: number; scale: number }
  /** Where it came FROM, captured at pin time. Unpinning puts it back here
   *  rather than dropping it wherever the camera happens to be pointing —
   *  a pin is a visit to the screen, not a move. */
  home?: { x: number; y: number }
  /** Which representation a PINNED card shows. On the canvas this is decided
   *  by the camera (LayerRouter's thresholds); a pinned card has detached
   *  from that camera, so the choice becomes explicit and lives here. This
   *  is the whole reason pinning a card is well-defined: it freezes WHICH
   *  view you are looking at, not just where it sits. */
  pinnedLayer?: 'card' | 'block' | 'board'
  cardSummary: string
  cardText: string     // independent body text visible on the card
  cardTextStyle?: import('../store/freeNodeStore').TextStyle
  cardHeaderText?: string
  cardHeaderTextStyle?: import('../store/freeNodeStore').TextStyle
  originY: number      // canvas-space Y position (group origin)
  originX: number      // canvas-space X position (group origin)
  cardWidthOverride?: number   // user-set card width (screen px)
  cardHeightOverride?: number  // user-set card height (screen px)
  deckState?: 'open' | 'fanned' | 'stacked'  // deck visual state (default: 'open')
  snipOf?: string         // cut from this source in a Viewer; its pieces share a deck (utils/snipCards)
  deckAnchorId?: string   // group ID of the deck anchor (its front card, the row's primary card); set when deckState !== 'open'
  nestedDeck?: boolean    // true if this group is a sub-deck anchor (persists through fan/stack cycles)
  deckOffsetX?: number    // offset from OWN anchor at stacking time (for position restore on open)
  deckOffsetY?: number
  /** Its row's primary card, as every card of the row remembers it: the
   *  front its deck last opened from, or the card made primary. It counts
   *  only while another card of the row remembers it too (utils/primaryCard). */
  deckLastFront?: string
  /**
   * When THIS group is a deck anchor, ghostSlots holds "checked-out" entries
   * for cards that were extracted from this deck. Each entry remembers where
   * the card's slot was so the dotted-outline strip can render in the fan
   * AND so the card can return to its slot when dropped on the ghost.
   * Extracted cards have NO deckAnchorId — they are independent on canvas.
   */
  ghostSlots?: Array<{
    cardId: string
    deckOffsetX: number
    deckOffsetY: number
  }>
  textSplitRatio?: number // header/body vertical split (0-1, default 0.5)
  linkedGroupIds?: string[]  // bi-directional references to other groups (optional for legacy; treat as [] when absent)
  /** References to BLOCKS and ELEMENTS this card owns. Card-to-card links
   *  stay in linkedGroupIds above — see utils/linkTargets for why the two
   *  fields coexist rather than one replacing the other. */
  linkedRefs?: import('../utils/linkTargets').LinkRef[]
  /** Annotation layer drawn on this card at card zoom. */
  cardStrokes?: import('../types/stroke').Stroke[]
  /** Cards-first (utils/cardGrid): a card that keeps its face's shape and
   *  lays its blocks out in rows of small cells inside it, in reading
   *  order, rather than growing a block to the right each time. Imports
   *  and Blank make these; older cards keep their own layout. */
  layout?: 'grid'
  /** A ROUGH CUT card (utils/cutCard): a grid card whose blocks are clips,
   *  in cut order, each trimmed (its media's clipIn/clipOut). Zoomed in to
   *  blocks it is a timeline; its face plays the cut. */
  cut?: import('../utils/cutCard').CutCardData
  /** The block the face shows (stepped with the arrows), when not the
   *  first. A block that has left the card falls back to the first. */
  faceBoardId?: string
  /** On a STACKED deck's anchor: the member card its face is stepped to
   *  (utils/cardGrid stepDeckFace). That card's own faceBoardId says which
   *  of its blocks. Absent, or no longer a member: the anchor itself. */
  deckFaceCard?: string
  /** A loop strip's result card: the card it was made from. They step
   *  through their pictures together (utils/railCards followFaces). */
  railSource?: string
  /** A result card shown bigger on a strip's tray (RailData.trayScale): its
   *  own frame size, which it goes back to when it leaves the tray. */
  railBase?: { w?: number; h?: number }
  /** An EFFECT card (utils/effectCards): its face is the effect's sliders,
   *  and lined up to the right of a picture card it processes that card's
   *  face. A real card otherwise — it moves, stacks and fans with a deck. */
  effect?: { kind: import('../utils/fx/effects').EffectKind; params?: Record<string, number>; text?: string
    /** Switched off: skipped in its chain (utils/fx/chain planChain). */
    off?: boolean
    /** Soloed: the only effect its chain runs. One per chain (effectToggles). */
    solo?: boolean }
  /** Turned over: the card shows its back, the DETAILS side (CardBack). */
  flipped?: boolean
  /** The rows on its details side (utils/cardTypes). */
  details?: import('../utils/cardTypes').CardDetail[]
  /** What kind of card it is (utils/cardTypes). Absent: an element card. */
  cardType?: CardType
  /** Coloured by hand: keeps its colour when its type, or its type's
   *  colour, changes. Otherwise it wears its type's colour. */
  ownColor?: boolean
  /** A FACTION's tree: member card id → the members it reports to. Its
   *  members are the cards it links to (linkedGroupIds); a member's rank
   *  is worked out from this (utils/cardTypes factionMembers). */
  reportsTo?: Record<string, string[]>
  /** A SCENE card's face: its divisions (utils/sceneCard). */
  scene?: SceneDiv
  /** A FAMILY's ties: who is whose parent and partner (utils/family). Its
   *  members are the cards it links to (linkedGroupIds). */
  kin?: Kin
  /** A LINKED card: another showing of this master card (utils/linkedCards).
   *  An edit on either is an edit on both, and on every other showing. */
  linkOf?: string
  /** A chart baked into this card: a storyline and its cards, folded in
   *  (utils/chartCard). Its back lists the chart's groups. */
  chart?: import('../utils/chartData').ChartData
}

/** Find which group a board belongs to */
export function getGroupForBoard(groups: ProjectGroup[], boardId: string): ProjectGroup | undefined {
  return groups.find(g => g.boardIds.includes(boardId))
}

/**
 * IDs of every group reachable from rootId via deckAnchorId chains, EXCLUDING
 * rootId itself. Used by extract/return to keep a sub-deck's members spatially
 * coherent with their anchor when the anchor moves: shift every descendant by
 * the same delta so deckOffsetX/Y stays consistent with originX/Y.
 *
 * Mirrors `expandWithNestedMembers` in useCardDecks.ts but inlined here to
 * avoid a circular import between the store and the hook.
 */
function getTransitiveDescendantIds(rootId: string, groups: ProjectGroup[]): string[] {
  const result = new Set<string>([rootId])
  let added = true
  while (added) {
    added = false
    for (const g of groups) {
      if (!result.has(g.id) && g.deckAnchorId && result.has(g.deckAnchorId)) {
        result.add(g.id)
        added = true
      }
    }
  }
  result.delete(rootId)
  return Array.from(result)
}

/** Layer-specific metadata — each zoom level has its own data fields */
export interface BoardLayerData {
  card: {
    heroImage: string | null   // card-level thumbnail (NOT bar.content.images[0])
    summary: string            // short text visible on card
    text: string               // independent body text at card zoom
    textStyle?: import('../store/freeNodeStore').TextStyle
    headerText?: string
    headerTextStyle?: import('../store/freeNodeStore').TextStyle
    widthOverride?: number     // user-set width (canvas px, pre-zoom)
    heightOverride?: number    // user-set height (canvas px, pre-zoom)
    textSplitRatio?: number    // header/body vertical split (0-1, default 0.5)
  }
  block: {
    thumbnail: string | null   // block-level representative image
    thumbnailTransform?: HeroImageTransform
    label: string              // display name override at block zoom
    text: string               // independent body text at block zoom
    textStyle?: import('../store/freeNodeStore').TextStyle
    headerText?: string
    headerTextStyle?: import('../store/freeNodeStore').TextStyle
    widthOverride?: number     // user-set width (canvas px, pre-zoom)
    heightOverride?: number    // user-set height (canvas px, pre-zoom)
    textSplitRatio?: number    // header/body vertical split (0-1, default 0.5)
    /** Annotation layer drawn on this block at block zoom. */
    strokes?: import('../types/stroke').Stroke[]
  }
  // Board layer uses bar tree directly — strokes per bar live on Bar.strokes
}

const DEFAULT_LAYERS: BoardLayerData = {
  card: { heroImage: null, summary: '', text: '' },
  block: { thumbnail: null, label: '', text: '' },
}

export interface BoardData {
  id: string
  projectName: string
  color: string        // board-level color (NLE overview block)
  nleRow: number       // which NLE row (integer, snapped)
  nleX: number         // horizontal canvas position
  canvasX?: number     // absolute canvas X (only when ungrouped / free canvas)
  canvasY?: number     // absolute canvas Y (only when ungrouped / free canvas)
  bars: Record<string, Bar>
  /** References this BLOCK owns — see utils/linkTargets. A block can be
   *  linked to anything, same mechanic as a card. */
  linkedRefs?: import('../utils/linkTargets').LinkRef[]
  rootIds: string[]
  viewerBarId: string | null
  selectedIds: string[]
  savedCollapsedState: Record<string, boolean> | null
  pristine: boolean
  boardScale: number   // content zoom (primary only, but stored per-board for generality)
  layers: BoardLayerData  // layer-specific metadata for card/block zoom levels
  /** The card this block was before it joined another, and its own shape
   *  then: pulling it back out restores both (utils/cardGrid). */
  fromCard?: {
    card: Omit<ProjectGroup, 'boardIds' | 'originX' | 'originY'>
    boardScale: number
    root?: { x: number; width: number; height: number }
  }
}

/** True if board is not in any group's boardIds */
export function isUngrouped(groups: ProjectGroup[], boardId: string): boolean {
  return !groups.some(g => g.boardIds.includes(boardId))
}

/** Get all board IDs that aren't in any group */
export function getUngroupedBoardIds(groups: ProjectGroup[], boards: Record<string, BoardData>): string[] {
  const grouped = new Set(groups.flatMap(g => g.boardIds))
  return Object.keys(boards).filter(id => !grouped.has(id))
}

interface BoardsState {
  boards: Record<string, BoardData>
  boardOrder: string[]    // does NOT include 'primary'
  groups: ProjectGroup[]  // project groups — each collapses to one card
  /** The colour picked for each card type, where it is not the type's own. */
  typeColors: Partial<Record<CardType, string>>
  /** Every name "Fill in details" or "New name" has handed out (nameKey),
   *  so none comes again, even after its card is gone. */
  usedNames: string[]

  createBoard: (nleRow: number, nleX: number) => string
  duplicateBoard: (sourceBoardId: string) => string
  extractBarToBoard: (sourceBoardId: string, barId: string) => string | null
  deleteBoard: (id: string) => void
  setBoardNlePos: (id: string, nleRow: number, nleX: number) => void
  setBoardColor: (id: string, color: string) => void
  setBoardProjectName: (id: string, name: string) => void
  setBoardScale: (id: string, scale: number) => void
  loadTemplate: (boardId: string, templateId: string) => void
  loadLayout: (boardId: string, data: { bars: Record<string, Bar>; rootIds: string[]; projectName: string }) => void

  addChildToBar: (boardId: string, barId: string) => void
  addSiblingBar: (boardId: string, barId: string, position: 'before' | 'after') => void
  moveBar: (boardId: string, barId: string, dx: number) => void
  moveMultiple: (boardId: string, ids: string[], dx: number) => void
  resizeBarEdge: (boardId: string, barId: string, edge: 'left' | 'right', delta: number) => void
  setBarHeight: (boardId: string, barId: string, h: number) => void
  renameBar: (boardId: string, barId: string, name: string) => void
  setSubtitle: (boardId: string, barId: string, subtitle: string) => void
  setIcon: (boardId: string, barId: string, icon: string | null) => void
  setBarColor: (boardId: string, barId: string, color: string) => void
  deleteBar: (boardId: string, barId: string) => void
  deleteSubtree: (boardId: string, barId: string) => void
  addParentAbove: (boardId: string, barId: string) => void
  openViewer: (boardId: string, barId: string) => void
  closeViewer: (boardId: string) => void
  setSelection: (boardId: string, ids: string[]) => void
  clearSelection: (boardId: string) => void
  clearAllSelections: () => void
  toggleSelection: (boardId: string, barId: string) => void
  toggleCollapsed: (boardId: string, barId: string) => void
  reorderSiblings: (boardId: string, barId: string) => void
  setContent: (boardId: string, barId: string, patch: Partial<Bar['content']>) => void
  collapseAllToggle: (boardId: string) => void
  importBars: (boardId: string, bars: Record<string, Bar>, newRootIds: string[], xOffset: number) => void
  changeBarRow: (boardId: string, barId: string, newRow: number, detach?: boolean) => void
  reparentBar: (boardId: string, barId: string, newParentId: string) => void
  crossBoardReparent: (sourceBoardId: string, barId: string, targetBoardId: string, newParentId: string) => void

  // ── Layer-specific actions ──
  setCardHeroImage: (boardId: string, url: string | null) => void
  setCardSummary: (boardId: string, summary: string) => void
  setBlockThumbnail: (boardId: string, url: string | null) => void
  setBlockThumbnailTransform: (boardId: string, transform: HeroImageTransform | undefined) => void
  setBlockLabel: (boardId: string, label: string) => void
  setBlockText: (boardId: string, text: string) => void
  setCardText: (boardId: string, text: string) => void
  setBlockTextStyle: (boardId: string, style: import('../store/freeNodeStore').TextStyle) => void
  setCardTextStyle: (boardId: string, style: import('../store/freeNodeStore').TextStyle) => void
  setBlockHeaderText: (boardId: string, text: string) => void
  setBlockHeaderTextStyle: (boardId: string, style: import('../store/freeNodeStore').TextStyle) => void
  setCardHeaderText: (boardId: string, text: string) => void
  setCardHeaderTextStyle: (boardId: string, style: import('../store/freeNodeStore').TextStyle) => void
  setCardSize: (boardId: string, w: number | undefined, h: number | undefined) => void
  setBlockSize: (boardId: string, w: number | undefined, h: number | undefined) => void

  // ── Project group actions ──
  createGroup: (name: string, boardIds: string[]) => string
  deleteGroup: (groupId: string) => void
  renameGroup: (groupId: string, name: string) => void
  setGroupColor: (groupId: string, color: string) => void
  setGroupFlipped: (groupId: string, flipped: boolean) => void
  /** Make it that type: it takes the type's starting details it lacks,
   *  and its colour, unless coloured by hand. */
  setGroupCardType: (groupId: string, type: CardType) => void
  /** Make every card of `groupIds` a `type` card (its starting details are
   *  added, details already there kept; its type colour unless it has its own). */
  setCardsType: (groupIds: string[], type: CardType) => void
  /** Coloured by hand, or (false) back to its type's colour. */
  setGroupOwnColor: (groupId: string, own: boolean) => void
  /** A type's colour, worn by every card of it not coloured by hand. */
  setTypeColor: (type: CardType, color: string) => void
  /** A card's link "+" let go on one of another card's details: that
   *  detail now shows the card dropped ('new': a new row for it, named
   *  after its type). */
  linkGroupDetail: (groupId: string, detailId: string | 'new', cardId: string) => void
  setGroupScene: (groupId: string, scene: SceneDiv) => void
  /** Cards let go on one of a scene's divisions: in it (out of the others). */
  putCardsInDivision: (sceneId: string, divId: string, cardIds: string[]) => void
  /** Who a faction member reports to: `bossId` alone (null: no one, the
   *  top), or with `also`, that one added to its bosses (taken off if it
   *  is one already). Never someone below it. */
  setReportsTo: (factionId: string, memberId: string, bossId: string | null, also?: boolean) => void
  /** A face copied from one card put on these (utils/faceStyle): its text,
   *  how it is set, and the line between title and body. Once, not tied. */
  pasteFaceStyle: (groupIds: string[], style: import('../utils/faceStyle').FaceStyle) => void
  /** A family's ties, all at once (utils/family makes them). */
  setFamilyKin: (familyId: string, kin: Kin) => void
  /** The cards' empty details made up to fit their types, and a new name
   *  for each still named what it came with (utils/fillDetails). */
  fillInDetails: (groupIds: string[]) => void
  /** A new name for each card whose type names its cards. */
  giveNewNames: (groupIds: string[]) => void
  /** Out of the faction (or family): unlinked; those who reported only to
   *  it report to its bosses instead (a family: utils/family removeFromKin). */
  removeMember: (factionId: string, memberId: string) => void
  setGroupDetails: (groupId: string, details: import('../utils/cardTypes').CardDetail[]) => void
  setGroupCardHeroImage: (groupId: string, url: string | null) => void
  /** Flip cards between screen-pinned and canvas-placed. Takes an ARRAY so a
   *  multi-selection converts in one set — same shape as setNodePlacement. */
  setGroupPlacement: (groupIds: string[], to: 'screen' | 'canvas',
                      view: { pan: { x: number; y: number }; zoom: number }) => void
  /** Make where a pinned card sits now the spot it returns to. */
  rehomePinnedGroup: (groupId: string,
                      view: { pan: { x: number; y: number }; zoom: number }) => void
  /** SCREEN-px delta for pinned cards. */
  movePinnedGroups: (groupIds: string[], dx: number, dy: number) => void
  /** Choose which representation a pinned card shows, and the scale that
   *  representation is normally seen at. */
  setPinnedLayer: (groupId: string, layer: 'card' | 'block' | 'board') => void
  /** Set a pinned card's scale directly — used by the fit-to-screen pass. */
  rescalePinnedGroup: (groupId: string, scale: number) => void
  setGroupCardHeroTransform: (groupId: string, transform: HeroImageTransform | undefined) => void
  setGroupCardSummary: (groupId: string, summary: string) => void
  setGroupCardText: (groupId: string, text: string) => void
  setGroupCardTextStyle: (groupId: string, style: import('../store/freeNodeStore').TextStyle) => void
  setGroupCardHeaderText: (groupId: string, text: string) => void
  setGroupCardHeaderTextStyle: (groupId: string, style: import('../store/freeNodeStore').TextStyle) => void
  setGroupCardSize: (groupId: string, w: number | undefined, h: number | undefined) => void
  setGroupTextSplitRatio: (groupId: string, ratio: number) => void
  setBlockTextSplitRatio: (boardId: string, ratio: number) => void
  setCardTextSplitRatio: (boardId: string, ratio: number) => void
  // ── Annotation / stroke actions ──
  setBarStrokes: (boardId: string, barId: string, strokes: import('../types/stroke').Stroke[]) => void
  setBlockStrokes: (boardId: string, strokes: import('../types/stroke').Stroke[]) => void
  setCardStrokes: (groupId: string, strokes: import('../types/stroke').Stroke[]) => void
  /** `asGiven`: groupIds[0] fronts it and the cards close as laid (a new
   *  card's deck, a check-in), with no front card picked or storyline flip. */
  setDeckState: (groupIds: string[], state: 'open' | 'fanned' | 'stacked', opts?: { asGiven?: boolean }) => void
  /** Make card `groupId` the primary card of its row `rowIds` (utils/primaryCard). */
  setRowPrimary: (groupId: string, rowIds: string[]) => void
  /** Pull a card out of its deck onto the canvas. The parent gets a ghostSlots
   *  entry remembering the slot's offset so the card can return. The card
   *  itself becomes independent (deckAnchorId/deckOffset cleared). If the
   *  card has tethered sub-members, it self-anchors and renders as a free-
   *  floating sub-deck on canvas. */
  extractFromDeck: (cardId: string, newOriginX: number, newOriginY: number) => void
  /** Return an extracted card to its parent deck's ghost slot. Re-tethers
   *  the card to the parent at the slot's saved offset, removes the slot
   *  entry, and snaps the card's origin to the slot position. */
  returnToDeck: (cardId: string) => void
  /** Permanently sever the tether: remove the card's ghost slot from its
   *  former parent. Card stays where it is on canvas, fully independent. */
  severDeckTether: (cardId: string) => void
  setGroupPos: (groupId: string, originY: number, originX: number) => void
  setGroupPosBatch: (updates: { groupId: string; originY: number; originX: number }[]) => void
  reassignBoard: (boardId: string, targetGroupId: string, dropCanvasPos?: { x: number; y: number }) => void
  moveToNewGroup: (boardId: string) => void
  duplicateGroup: (groupId: string) => string | null
  selectedGroupIds: string[]
  setSelectedGroup: (groupId: string | null) => void
  toggleGroupSelection: (groupId: string) => void
  setSelectedGroups: (groupIds: string[]) => void
  clearGroupSelection: () => void

  // ── Bi-directional group linking ──
  linkGroups: (a: string, b: string) => void
  unlinkGroups: (a: string, b: string) => void
  /** Link anything to anything: card, block or element, in any combination.
   *  `owner` is the drop target and holds the reference; `ref` is what it
   *  points at. Card-to-card is delegated to linkGroups so the original
   *  storage — which many consumers read directly — stays authoritative. */
  linkRefs: (owner: LinkRef, ref: LinkRef) => void
  unlinkRefs: (owner: LinkRef, ref: LinkRef) => void

  // ── Ungrouped board actions (free canvas) ──
  createUngroupedBoard: (canvasX: number, canvasY: number) => string
  ungroupBoard: (boardId: string) => void
  groupBoard: (boardId: string, targetGroupId: string) => void
  groupBoardAsNew: (boardId: string) => void
  setUngroupedBoardPos: (boardId: string, canvasX: number, canvasY: number) => void
}

type SetFn = (fn: (s: BoardsState) => Partial<BoardsState>) => void

function updateBoard(
  set: SetFn,
  boardId: string,
  fn: (b: BoardData) => Partial<BoardData>,
) {
  set(s => {
    const b = s.boards[boardId]
    if (!b) return s
    return { boards: { ...s.boards, [boardId]: { ...b, ...fn(b) } } }
  })
}

/** Apply a BarMutResult from barOps to a board via updateBoard */
function applyBarMut(
  set: SetFn,
  boardId: string,
  result: { bars: Record<string, Bar>; rootIds?: string[]; savedCollapsedState?: Record<string, boolean> | null } | null,
) {
  if (!result) return
  updateBoard(set, boardId, () => {
    const patch: Partial<BoardData> = { bars: result.bars }
    if (result.rootIds !== undefined) patch.rootIds = result.rootIds
    if (result.savedCollapsedState !== undefined) patch.savedCollapsedState = result.savedCollapsedState
    return patch
  })
}

const PRIMARY_BOARD: BoardData = {
  id: 'primary',
  projectName: 'Block',
  color: '#5b8dd9',
  nleRow: 0,
  nleX: 0,
  bars: {
    [PRIMARY_INIT_ID]: makeBar({
      id: PRIMARY_INIT_ID, parentId: null, rowIndex: 0,
      x: 0, width: INIT_W, height: INIT_H,
      name: 'Untitled', subtitle: '', color: '#5b8dd9',
    }),
  },
  rootIds: [PRIMARY_INIT_ID],
  viewerBarId: null,
  selectedIds: [],
  savedCollapsedState: null,
  pristine: true,
  boardScale: 1,
  layers: { ...DEFAULT_LAYERS },
}

const DEFAULT_GROUP: ProjectGroup = {
  id: 'default-group',
  name: 'Card',
  color: '#5b8dd9',
  boardIds: ['primary'],
  cardHeroImage: null,
  cardSummary: '',
  cardText: '',
  cardHeaderText: '',
  cardHeroTransform: { ...NEW_CARD_FACE },
  originY: 0,
  originX: 0,
}

/** The boards of a brand-new canvas — the primary board and its default
 *  card, exactly as first launch makes them. "Start fresh" (loading a
 *  one-board template) resets to this rather than keeping the previous
 *  project's default card: that card kept its name, hero, text, position
 *  and deck membership, and as a stacked member of a deck that no longer
 *  existed it was hidden on the canvas yet still listed in the Card
 *  Browser — a card you could see in the list and never find. */
export function freshCanvasBoards(): Pick<BoardsState, 'boards' | 'boardOrder' | 'groups' | 'selectedGroupIds'> {
  return {
    boards: { primary: { ...PRIMARY_BOARD, layers: { ...DEFAULT_LAYERS } } },
    boardOrder: [],
    groups: [{ ...DEFAULT_GROUP, boardIds: ['primary'] }],
    selectedGroupIds: [],
  }
}

export const useBoardsStore = create<BoardsState>()(persist((set, get) => ({
  boards: { primary: PRIMARY_BOARD },
  boardOrder: [],
  groups: [DEFAULT_GROUP],
  selectedGroupIds: [],
  typeColors: {},
  usedNames: [],

  createBoard(nleRow, nleX) {
    const id = crypto.randomUUID()
    const rootId = crypto.randomUUID()
    const board: BoardData = {
      id, projectName: '', color: '#5b8dd9',
      nleRow, nleX,
      bars: {
        [rootId]: makeBar({ id: rootId, parentId: null, rowIndex: 0, x: 0, width: INIT_W, height: INIT_H }),
      },
      rootIds: [rootId],
      viewerBarId: null,
      selectedIds: [],
      savedCollapsedState: null,
      pristine: true,
      boardScale: 1,
      layers: { ...DEFAULT_LAYERS },
    }
    set(s => {
      // Add new board to the first group
      const groups = s.groups.map((g, i) => i === 0 ? { ...g, boardIds: [...g.boardIds, id] } : g)
      return { boards: { ...s.boards, [id]: board }, boardOrder: [...s.boardOrder, id], groups }
    })
    return id
  },

  duplicateBoard(sourceBoardId) {
    const src = get().boards[sourceBoardId]
    const id = crypto.randomUUID()
    const idMap = new Map<string, string>()
    Object.keys(src.bars).forEach(bid => idMap.set(bid, crypto.randomUUID()))
    const bars: Record<string, Bar> = {}
    Object.values(src.bars).forEach(b => {
      const newId = idMap.get(b.id)!
      bars[newId] = {
        ...b, id: newId,
        parentId: b.parentId ? (idMap.get(b.parentId) ?? null) : null,
        children: b.children.map(cid => idMap.get(cid) ?? cid),
      }
    })
    const rootIds = src.rootIds.map(rid => idMap.get(rid) ?? rid)
    const board: BoardData = {
      // Empty source projectName stays empty in the copy (placeholder handles the display).
      id, projectName: src.projectName ? src.projectName + ' copy' : '', color: src.color,
      nleRow: src.nleRow, nleX: src.nleX + 40,
      bars, rootIds,
      viewerBarId: null, selectedIds: [], savedCollapsedState: null, pristine: false,
      boardScale: src.boardScale ?? 1,
      layers: structuredClone(src.layers ?? DEFAULT_LAYERS),
    }
    set(s => {
      // Add duplicate to same group as source
      const groups = s.groups.map(g =>
        g.boardIds.includes(sourceBoardId) ? { ...g, boardIds: [...g.boardIds, id] } : g
      )
      return { boards: { ...s.boards, [id]: board }, boardOrder: [...s.boardOrder, id], groups }
    })
    return id
  },

  extractBarToBoard(sourceBoardId, barId) {
    const src = get().boards[sourceBoardId]
    if (!src) return null
    const bar = src.bars[barId]
    if (!bar) return null

    // Collect the bar + its entire subtree
    const subtreeIds = collectSubtree(src.bars, barId)
    if (subtreeIds.length === 0) return null

    // Don't extract if it would leave the source board empty
    const remainingRoots = src.rootIds.filter(rid => !subtreeIds.includes(rid))
    if (remainingRoots.length === 0 && src.rootIds.includes(barId)) return null

    // Build bars for the new board (clone with same IDs — they're unique UUIDs)
    const extractedBars: Record<string, Bar> = {}
    const subtreeSet = new Set(subtreeIds)
    for (const sid of subtreeIds) {
      const b = src.bars[sid]
      if (!b) continue
      extractedBars[sid] = {
        ...b,
        // If this bar's parent is outside the subtree, make it a root
        parentId: b.parentId && subtreeSet.has(b.parentId) ? b.parentId : null,
        // Filter children to only those in the subtree
        children: b.children.filter(cid => subtreeSet.has(cid)),
      }
    }

    // Normalize x positions so the leftmost bar starts at 0
    const minX = Math.min(...Object.values(extractedBars).map(b => b.x))
    for (const b of Object.values(extractedBars)) b.x -= minX

    // Root IDs for the new board: bars with no parent in the extracted set
    const newRootIds = Object.values(extractedBars).filter(b => !b.parentId).map(b => b.id)

    const newBoardId = crypto.randomUUID()
    const newBoard: BoardData = {
      id: newBoardId,
      projectName: bar.name || src.projectName,
      color: bar.color || src.color,
      nleRow: src.nleRow ?? 0,
      nleX: (src.nleX ?? 0) + 200,
      bars: extractedBars,
      rootIds: newRootIds,
      viewerBarId: null,
      selectedIds: [],
      savedCollapsedState: null,
      pristine: false,
      boardScale: src.boardScale ?? 1,
      layers: { ...DEFAULT_LAYERS },
    }

    // Remove extracted bars from source board
    const srcBars = { ...src.bars }
    for (const sid of subtreeIds) delete srcBars[sid]

    // Detach from parent in source if this bar was a child
    if (bar.parentId && srcBars[bar.parentId]) {
      srcBars[bar.parentId] = {
        ...srcBars[bar.parentId],
        children: srcBars[bar.parentId].children.filter(cid => cid !== barId),
      }
    }

    const srcRootIds = src.rootIds.filter(rid => !subtreeSet.has(rid))

    set(s => {
      const updatedSrc = { ...s.boards[sourceBoardId], bars: srcBars, rootIds: srcRootIds, selectedIds: [] }
      const boards = { ...s.boards, [sourceBoardId]: updatedSrc, [newBoardId]: newBoard }
      // Add new board to the same group as the source
      const groups = s.groups.map(g =>
        g.boardIds.includes(sourceBoardId) ? { ...g, boardIds: [...g.boardIds, newBoardId] } : g
      )
      return { boards, boardOrder: [...s.boardOrder, newBoardId], groups }
    })
    return newBoardId
  },

  deleteBoard(id) {
    set(s => {
      const { [id]: _, ...rest } = s.boards
      // Remove from its group; auto-delete empty groups (keep at least one)
      let groups = s.groups.map(g => ({
        ...g,
        boardIds: g.boardIds.filter(bid => bid !== id),
      }))
      if (groups.length > 1) groups = groups.filter(g => g.boardIds.length > 0)
      return { boards: rest, boardOrder: s.boardOrder.filter(x => x !== id), groups }
    })
  },

  setBoardNlePos(id, nleRow, nleX) {
    const b = get().boards[id]
    if (b && b.nleRow === nleRow && b.nleX === nleX) return
    updateBoard(set, id, () => ({ nleRow, nleX }))
  },

  setBoardColor(id, color) {
    updateBoard(set, id, () => ({ color }))
  },

  setBoardProjectName(id, name) {
    updateBoard(set, id, () => ({ projectName: name }))
  },

  // ── Bar mutations: thin wrappers around barOps ──

  addChildToBar(boardId, barId) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, addChild(board.bars, board.rootIds, barId))
  },

  addSiblingBar(boardId, barId, position) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, addSibling(board.bars, board.rootIds, barId, position))
  },

  moveBar(boardId, barId, dx) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, moveBarOp(board.bars, barId, dx))
  },

  moveMultiple(boardId, ids, dx) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, moveMultipleOp(board.bars, ids, dx))
  },

  resizeBarEdge(boardId, barId, edge, delta) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, resizeEdge(board.bars, barId, edge, delta))
  },

  setBarHeight(boardId, barId, h) {
    updateBoard(set, boardId, b => ({ bars: { ...b.bars, [barId]: { ...b.bars[barId], height: Math.max(40, h) } } }))
  },

  renameBar(boardId, barId, name) {
    updateBoard(set, boardId, b => ({ bars: { ...b.bars, [barId]: { ...b.bars[barId], name } } }))
  },

  setSubtitle(boardId, barId, subtitle) {
    updateBoard(set, boardId, b => ({ bars: { ...b.bars, [barId]: { ...b.bars[barId], subtitle } } }))
  },

  setIcon(boardId, barId, icon) {
    updateBoard(set, boardId, b => ({ bars: { ...b.bars, [barId]: { ...b.bars[barId], icon } } }))
  },

  setBarColor(boardId, barId, color) {
    updateBoard(set, boardId, b => ({ bars: { ...b.bars, [barId]: { ...b.bars[barId], color } } }))
  },

  deleteBar(boardId, barId) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, deleteBarOp(board.bars, board.rootIds, barId))
  },

  deleteSubtree(boardId, barId) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, deleteSubtreeOp(board.bars, board.rootIds, barId))
  },

  addParentAbove(boardId, barId) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, addParentAboveOp(board.bars, board.rootIds, barId))
  },

  openViewer(boardId, barId) {
    updateBoard(set, boardId, () => ({ viewerBarId: barId }))
  },
  closeViewer(boardId) {
    updateBoard(set, boardId, () => ({ viewerBarId: null }))
  },
  setSelection(boardId, ids) {
    updateBoard(set, boardId, () => ({ selectedIds: ids }))
  },
  clearSelection(boardId) {
    updateBoard(set, boardId, () => ({ selectedIds: [] }))
  },
  clearAllSelections() {
    const boards = get().boards
    const updated: Record<string, any> = {}
    let changed = false
    for (const [id, board] of Object.entries(boards)) {
      if (board.selectedIds.length > 0) {
        updated[id] = { ...board, selectedIds: [] }
        changed = true
      } else {
        updated[id] = board
      }
    }
    if (changed) set({ boards: updated as any })
  },
  toggleSelection(boardId, barId) {
    updateBoard(set, boardId, b => ({
      selectedIds: b.selectedIds.includes(barId)
        ? b.selectedIds.filter(x => x !== barId)
        : [...b.selectedIds, barId],
    }))
  },
  toggleCollapsed(boardId, barId) {
    updateBoard(set, boardId, b => ({
      bars: { ...b.bars, [barId]: { ...b.bars[barId], collapsed: !b.bars[barId]?.collapsed } }
    }))
  },

  reorderSiblings(boardId, barId) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, reorderSiblingsOp(board.bars, barId))
  },

  setContent(boardId, barId, patch) {
    updateBoard(set, boardId, b => ({
      bars: { ...b.bars, [barId]: { ...b.bars[barId], content: { ...b.bars[barId]?.content, ...patch } } }
    }))
  },

  collapseAllToggle(boardId) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, collapseAllToggleOp(board.bars, board.savedCollapsedState))
  },

  importBars(boardId, newBars, newRootIds, xOffset) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, importBarsOp(board.bars, board.rootIds, newBars, newRootIds, xOffset))
  },

  changeBarRow(boardId, barId, newRow, detach = true) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, changeRowOp(board.bars, board.rootIds, barId, newRow, detach))
  },

  reparentBar(boardId, barId, newParentId) {
    const board = get().boards[boardId]; if (!board) return
    applyBarMut(set, boardId, reparentBarOp(board.bars, board.rootIds, barId, newParentId))
  },

  crossBoardReparent(sourceBoardId, barId, targetBoardId, newParentId) {
    const sourceBoard = get().boards[sourceBoardId]; if (!sourceBoard) return
    const targetBoard = get().boards[targetBoardId]; if (!targetBoard) return
    const newParent = targetBoard.bars[newParentId]; if (!newParent) return

    // Collect subtree from source
    const subtreeIds = collectSubtree(sourceBoard.bars, barId)
    const subtreeBars: Record<string, Bar> = {}
    subtreeIds.forEach(id => { if (sourceBoard.bars[id]) subtreeBars[id] = sourceBoard.bars[id] })

    // Adjust rowIndex: only move if bar is at or above new parent row
    const sourceBar = sourceBoard.bars[barId]; if (!sourceBar) return
    const minChildRow = newParent.rowIndex + 1
    if (sourceBar.rowIndex < minChildRow) {
      const rowDelta = minChildRow - sourceBar.rowIndex
      subtreeIds.forEach(id => {
        if (subtreeBars[id]) subtreeBars[id] = { ...subtreeBars[id], rowIndex: Math.max(0, subtreeBars[id].rowIndex + rowDelta) }
      })
    }

    // Adjust x positions: center the bar under new parent, shift entire subtree by same delta
    const parentCenterX = newParent.x + newParent.width / 2
    const barCenterX = sourceBar.x + sourceBar.width / 2
    const xDelta = parentCenterX - barCenterX
    subtreeIds.forEach(id => {
      if (subtreeBars[id]) subtreeBars[id] = { ...subtreeBars[id], x: subtreeBars[id].x + xDelta }
    })

    subtreeBars[barId] = { ...subtreeBars[barId], parentId: newParentId }

    // Add to target board
    const targetBars = { ...targetBoard.bars, ...subtreeBars }
    const targetParent = targetBars[newParentId]
    targetBars[newParentId] = { ...targetParent, children: [...targetParent.children, barId] }
    updateBoard(set, targetBoardId, () => ({ bars: targetBars }))

    // Remove from source board
    applyBarMut(set, sourceBoardId, deleteSubtreeOp(sourceBoard.bars, sourceBoard.rootIds, barId))
  },

  loadTemplate(boardId, templateId) {
    const tmpl = TEMPLATES.find(t => t.id === templateId)
    if (!tmpl) return
    updateBoard(set, boardId, () => ({
      bars: tmpl.bars,
      rootIds: tmpl.rootIds,
      projectName: tmpl.projectName,
      viewerBarId: null,
      pristine: true,
      selectedIds: [],
      savedCollapsedState: null,
    }))
  },

  loadLayout(boardId, data) {
    updateBoard(set, boardId, () => ({
      bars: data.bars,
      rootIds: data.rootIds,
      projectName: data.projectName,
      viewerBarId: null,
      pristine: true,
      selectedIds: [],
      savedCollapsedState: null,
    }))
  },

  setBoardScale(id, scale) {
    updateBoard(set, id, () => ({ boardScale: Math.max(0.25, Math.min(3.0, scale)) }))
  },

  // ── Layer-specific actions ──

  setCardHeroImage(boardId, url) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, card: { ...b.layers.card, heroImage: url } },
    }))
  },

  setCardSummary(boardId, summary) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, card: { ...b.layers.card, summary } },
    }))
  },

  setBlockThumbnail(boardId, url) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, thumbnail: url, ...(url === null ? { thumbnailTransform: undefined } : {}) } },
    }))
  },

  setBlockThumbnailTransform(boardId, transform) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, thumbnailTransform: transform } },
    }))
  },

  setBlockLabel(boardId, label) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, label } },
    }))
  },

  setBlockText(boardId: string, text: string) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, text } },
    }))
  },

  setCardText(boardId: string, text: string) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, card: { ...b.layers.card, text } },
    }))
  },

  setBlockTextStyle(boardId, style) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, textStyle: style } },
    }))
  },

  setCardTextStyle(boardId, style) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, card: { ...b.layers.card, textStyle: style } },
    }))
  },

  setBlockHeaderText(boardId, text) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, headerText: text } },
    }))
  },

  setBlockHeaderTextStyle(boardId, style) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, headerTextStyle: style } },
    }))
  },

  setCardHeaderText(boardId, text) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, card: { ...b.layers.card, headerText: text } },
    }))
  },

  setCardHeaderTextStyle(boardId, style) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, card: { ...b.layers.card, headerTextStyle: style } },
    }))
  },

  setCardSize(boardId, w, h) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, card: { ...b.layers.card, widthOverride: w, heightOverride: h } },
    }))
  },

  setBlockSize(boardId, w, h) {
    updateBoard(set, boardId, b => ({
      layers: { ...b.layers, block: { ...b.layers.block, widthOverride: w, heightOverride: h } },
    }))
  },

  // ── Project group actions ──

  createGroup(name, boardIds) {
    const id = crypto.randomUUID()
    const group: ProjectGroup = {
      id, name, color: '#5b8dd9', boardIds,
      cardHeroImage: null, cardSummary: '', cardText: '', cardHeaderText: '',
      cardHeroTransform: { ...NEW_CARD_FACE },
      originY: 0, originX: 0,
    }
    set(s => {
      // Remove these boardIds from any existing group to avoid duplicates
      const cleaned = s.groups.map(g => ({
        ...g, boardIds: g.boardIds.filter(bid => !boardIds.includes(bid)),
      }))
      // Remove empty groups (keep at least one via the new group)
      const remaining = cleaned.filter(g => g.boardIds.length > 0)
      return { groups: [...remaining, group] }
    })
    return id
  },

  deleteGroup(groupId) {
    set(s => {
      const target = s.groups.find(g => g.id === groupId)
      if (!target || s.groups.length <= 1) return s
      // Move orphaned boards to the first remaining group
      const others = s.groups.filter(g => g.id !== groupId)
      const first = { ...others[0], boardIds: [...others[0].boardIds, ...target.boardIds] }
      return { groups: [first, ...others.slice(1)] }
    })
  },

  renameGroup(groupId, name) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, name } : g) }))
  },

  setGroupColor(groupId, color) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, color } : g) }))
  },

  setGroupFlipped(groupId, flipped) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, flipped: flipped || undefined } : g) }))
  },

  setGroupCardType(groupId, type) {
    get().setCardsType([groupId], type)
  },

  setCardsType(groupIds, type) {
    const chosen = get().typeColors
    const ids = new Set(groupIds)
    set(s => ({ groups: s.groups.map(g => !ids.has(g.id) ? g : {
      ...g,
      cardType: type === 'element' ? undefined : type,
      details: withTypeDetails(g.details, type),
      ...(type === 'scene' && !g.scene ? { scene: newSceneLayout() } : {}),
      ...(g.ownColor ? {} : { color: typeColor(type, chosen) }),
    }) }))
  },

  setGroupOwnColor(groupId, own) {
    const chosen = get().typeColors
    set(s => ({ groups: s.groups.map(g => g.id !== groupId ? g : own
      ? { ...g, ownColor: true }
      : { ...g, ownColor: undefined, color: typeColor(cardTypeOf(g), chosen) }) }))
  },

  setTypeColor(type, color) {
    set(s => ({
      typeColors: { ...s.typeColors, [type]: color },
      groups: s.groups.map(g => !g.ownColor && cardTypeOf(g) === type && g.cardType ? { ...g, color } : g),
    }))
  },

  linkGroupDetail(groupId, detailId, cardId) {
    const src = get().groups.find(g => g.id === cardId)
    if (!src || cardId === groupId) return
    set(s => ({ groups: s.groups.map(g => {
      if (g.id !== groupId) return g
      const details = g.details ?? []
      if (detailId === 'new') {
        const name = src.cardType ? CARD_TYPES[src.cardType].label : 'Link'
        return { ...g, details: [...details, { id: newDetailId(), name, value: '', link: { card: cardId } }] }
      }
      return { ...g, details: details.map(d => d.id === detailId ? { ...d, link: { card: cardId } } : d) }
    }) }))
  },

  setGroupScene(groupId, scene) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, scene } : g) }))
  },

  putCardsInDivision(sceneId, divId, cardIds) {
    const ids = cardIds.filter(id => id !== sceneId)
    if (!ids.length) return
    set(s => ({ groups: s.groups.map(g => g.id === sceneId && g.scene ? { ...g, scene: putCards(g.scene, divId, ids) } : g) }))
  },

  setReportsTo(factionId, memberId, bossId, also) {
    set(s => ({ groups: s.groups.map(g => {
      if (g.id !== factionId) return g
      const tree = { ...(g.reportsTo ?? {}) }
      const now = tree[memberId] ?? []
      let next: string[]
      if (bossId == null) next = []
      else {
        if (bossId === memberId || isAbove(g, memberId, bossId)) return g
        next = also ? (now.includes(bossId) ? now.filter(b => b !== bossId) : [...now, bossId]) : [bossId]
      }
      if (next.length) tree[memberId] = next
      else delete tree[memberId]
      return { ...g, reportsTo: tree }
    }) }))
  },

  pasteFaceStyle(groupIds, style) {
    set(s => ({ groups: s.groups.map(g => !groupIds.includes(g.id) ? g : {
      ...g,
      cardHeaderText: style.header,
      cardText: style.body,
      cardHeaderTextStyle: style.headerStyle,
      cardTextStyle: style.bodyStyle,
      textSplitRatio: style.split,
    }) }))
  },

  setFamilyKin(familyId, kin) {
    set(s => ({ groups: s.groups.map(g => g.id === familyId ? { ...g, kin } : g) }))
  },

  fillInDetails(groupIds) {
    const st = get()
    const taken = new Set([...st.usedNames, ...st.groups.map(g => nameKey(g.name ?? '')).filter(Boolean)])
    const fresh: string[] = []
    const patch = new Map<string, Partial<ProjectGroup>>()
    for (const id of groupIds) {
      const g = st.groups.find(x => x.id === id)
      if (!g) continue
      const p = fillCard(g, st.groups, taken)
      if (p.name) fresh.push(nameKey(p.name))
      patch.set(id, p)
    }
    if (!patch.size) return
    set(s => ({
      usedNames: [...s.usedNames, ...fresh],
      groups: s.groups.map(g => patch.has(g.id) ? { ...g, ...patch.get(g.id) } : g),
    }))
  },

  giveNewNames(groupIds) {
    const st = get()
    const taken = new Set([...st.usedNames, ...st.groups.map(g => nameKey(g.name ?? '')).filter(Boolean)])
    const named = new Map<string, string>()
    for (const id of groupIds) {
      const g = st.groups.find(x => x.id === id)
      const kind = g && nameKindOf(cardTypeOf(g))
      if (kind) named.set(id, makeName(kind, taken))
    }
    if (!named.size) return
    set(s => ({
      usedNames: [...s.usedNames, ...[...named.values()].map(nameKey)],
      groups: s.groups.map(g => named.has(g.id) ? { ...g, name: named.get(g.id)! } : g),
    }))
  },

  removeMember(factionId, memberId) {
    get().unlinkGroups(factionId, memberId)
    set(s => ({ groups: s.groups.map(g => {
      if (g.id === factionId && g.kin) return { ...g, kin: removeFromKin(g.kin, memberId) }
      if (g.id !== factionId || !g.reportsTo) return g
      const { [memberId]: theirs = [], ...rest } = g.reportsTo
      const tree: Record<string, string[]> = {}
      for (const [id, bosses] of Object.entries(rest)) {
        const left = bosses.filter(b => b !== memberId)
        const next = bosses.includes(memberId) && !left.length ? theirs.filter(b => b !== id) : left
        if (next.length) tree[id] = next
      }
      return { ...g, reportsTo: tree }
    }) }))
  },

  setGroupDetails(groupId, details) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, details } : g) }))
  },

  setGroupCardHeroImage(groupId, url) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardHeroImage: url, ...(url === null ? { cardHeroTransform: undefined } : {}) } : g) }))
  },

  setGroupPlacement(groupIds, to, view) {
    // Where each card is leaving from, captured BEFORE the move — after it,
    // the pin is gone and there is nothing left to draw a line from.
    const departures = to === 'canvas'
      ? get().groups
          .filter(g => groupIds.includes(g.id) && g.pin)
          .map(g => ({ from: { x: g.pin!.x, y: g.pin!.y }, color: g.color,
                       home: g.home ?? { x: g.originX, y: g.originY } }))
      : []
    set(s => ({
      groups: s.groups.map(g => {
        if (!groupIds.includes(g.id)) return g
        if (to === 'screen') {
          if (g.pin) return g
          // The screen rect the browser is painting right now: the world
          // layer is translate(pan) scale(zoom) and the card's origin is
          // originX/originY.
          return {
            ...g,
            pin: {
              x: view.pan.x + g.originX * view.zoom,
              y: view.pan.y + g.originY * view.zoom,
              scale: view.zoom,
            },
            home: { x: g.originX, y: g.originY },
          }
        }
        if (!g.pin) return g
        const { pin: _drop, home, ...rest } = g
        // Back where it came from. No recorded home means it was pinned
        // before homes existed, so unproject where it sits — the old
        // behaviour, rather than a jump to somewhere arbitrary.
        if (home) return { ...rest, originX: home.x, originY: home.y }
        return {
          ...rest,
          originX: (g.pin.x - view.pan.x) / view.zoom,
          originY: (g.pin.y - view.pan.y) / view.zoom,
        }
      }),
    }))
    // A card that unpins jumps from the screen to somewhere in the world,
    // often off-screen. The streak is what tells you where it went.
    for (const d of departures) {
      usePinTravelStore.getState().emitTravel(
        d.from,
        { x: view.pan.x + d.home.x * view.zoom, y: view.pan.y + d.home.y * view.zoom },
        d.color,
      )
    }
  },

  rescalePinnedGroup(groupId, scale) {
    // Anchor-preserving: the top-left the user is looking at stays put and
    // the content shrinks toward it. Scaling about some other point would
    // make a fit feel like the card jumped somewhere else.
    set(s => ({
      groups: s.groups.map(g => (g.id === groupId && g.pin)
        ? { ...g, pin: { ...g.pin, scale: Math.max(0.02, Math.min(4, scale)) } }
        : g),
    }))
  },

  setPinnedLayer(groupId, layer) {
    // ONLY the layer. The pin is a FRAME — a fixed box at a fixed spot on
    // screen — and 1/2/3 choose what is drawn inside it. Rewriting pin.scale
    // here (it used to snap to 0.15/0.25/0.6 per level) resized and moved the
    // card on every switch, so picking a level felt like spawning a new
    // window somewhere else instead of looking further into the card you
    // already had. Content that does not fit the frame is scaled down into
    // it at render time; making the frame bigger is the scale grip's job.
    set(s => ({
      groups: s.groups.map(g => (g.id === groupId && g.pin)
        ? { ...g, pinnedLayer: layer }
        : g),
    }))
  },

  rehomePinnedGroup(groupId, view) {
    set(s => ({
      groups: s.groups.map(g => (g.id === groupId && g.pin)
        ? { ...g, home: {
            x: (g.pin.x - view.pan.x) / view.zoom,
            y: (g.pin.y - view.pan.y) / view.zoom,
          } }
        : g),
    }))
  },

  movePinnedGroups(groupIds, dx, dy) {
    if (dx === 0 && dy === 0) return
    set(s => ({
      groups: s.groups.map(g => (groupIds.includes(g.id) && g.pin)
        ? { ...g, pin: { ...g.pin, x: g.pin.x + dx, y: g.pin.y + dy } }
        : g),
    }))
  },

  setGroupCardHeroTransform(groupId, transform) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardHeroTransform: transform } : g) }))
  },

  setGroupCardSummary(groupId, summary) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardSummary: summary } : g) }))
  },

  setGroupCardText(groupId: string, text: string) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardText: text } : g) }))
  },

  setGroupCardTextStyle(groupId, style) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardTextStyle: style } : g) }))
  },

  setGroupCardHeaderText(groupId, text) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardHeaderText: text } : g) }))
  },

  setGroupCardHeaderTextStyle(groupId, style) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardHeaderTextStyle: style } : g) }))
  },

  setGroupCardSize(groupId, w, h) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardWidthOverride: w, cardHeightOverride: h } : g) }))
  },

  setGroupTextSplitRatio(groupId, ratio) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, textSplitRatio: ratio } : g) }))
  },

  setBlockTextSplitRatio(boardId, ratio) {
    set(s => {
      const b = s.boards[boardId]
      if (!b) return s
      return { boards: { ...s.boards, [boardId]: { ...b, layers: { ...b.layers, block: { ...b.layers.block, textSplitRatio: ratio } } } } }
    })
  },

  setCardTextSplitRatio(boardId, ratio) {
    set(s => {
      const b = s.boards[boardId]
      if (!b) return s
      return { boards: { ...s.boards, [boardId]: { ...b, layers: { ...b.layers, card: { ...b.layers.card, textSplitRatio: ratio } } } } }
    })
  },

  // ── Annotation strokes ─────────────────────────────────────
  // Each surface (bar / block / card) has its own per-zoom stroke layer.
  // `strokes` arrays use normalized 0–1 coords so strokes scale with their
  // host. Setters do a full replace; add/delete/clear are composed in
  // utils/strokeActions.ts so undo + history get a single mutation per change.

  setBarStrokes(boardId, barId, strokes) {
    set(s => {
      const b = s.boards[boardId]
      if (!b) return s
      const bar = b.bars[barId]
      if (!bar) return s
      return {
        boards: {
          ...s.boards,
          [boardId]: { ...b, bars: { ...b.bars, [barId]: { ...bar, strokes } } },
        },
      }
    })
  },

  setBlockStrokes(boardId, strokes) {
    set(s => {
      const b = s.boards[boardId]
      if (!b) return s
      return {
        boards: {
          ...s.boards,
          [boardId]: { ...b, layers: { ...b.layers, block: { ...b.layers.block, strokes } } },
        },
      }
    })
  },

  setCardStrokes(groupId, strokes) {
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, cardStrokes: strokes } : g) }))
  },

  setDeckState(ids, state, opts) {
    // For stacking/fanning: the new deck anchor is groupIds[0] — the deck's
    // own front card if it is one already, else the row's primary card (the
    // leftmost unless one was made primary). utils/primaryCard.
    const nodes = useFreeNodeStore.getState().nodes
    const groupIds = state === 'open' || opts?.asGiven ? ids : primaryFirst(get().groups, ids)
    const idSet = new Set(groupIds)
    // For opening: anchorId is undefined (no deck after open).
    const anchorId = state === 'open' ? undefined : groupIds[0]
    // Opening: the deck's front card. It stays the open row's primary card,
    // so the row's controls stay on it and the row closes onto it again,
    // whichever way its cards lie.
    const openFront = state === 'open' ? deckFront(get().groups, groupIds) : null
    // Linked to a storyline, its cards open away from the line: flipped to
    // the front card's far side (utils/deckAway). Opening, that is their
    // offsets; closing, their open places (hidden under the front card).
    const away = opts?.asGiven ? null : (() => {
      const all = get().groups
      const front = state === 'open' ? openFront : all.find(g => g.id === anchorId)
      if (!front) return null
      const lay = deckLay(front, groupIds, new Map(all.map(g => [g.id, g])), get().boards, linkedLines(nodes))
      return lay.flipped ? { front, lay } : null
    })()
    // Detect a stack ↔ fan crossing. When firing, mark the deck for
    // animation in canvasStore — FannedDeckOverlay's strips imperatively
    // slide out (fanning) or back in (stacking). For 'stacking', CardLayer
    // keeps the fan rendered during the animation window; once it clears,
    // the StackedDeckCard takes over.
    {
      const groups = get().groups
      const firstAnchor = groupIds[0] // canvasStore's deckId is just the anchor's id; matches what CardLayer compares against
      const wasFanned = groupIds.some(id => groups.find(g => g.id === id)?.deckState === 'fanned')
      const wasStacked = groupIds.some(id => groups.find(g => g.id === id)?.deckState === 'stacked')
      let phase: 'fanning' | 'stacking' | null = null
      if (state === 'fanned' && wasStacked) phase = 'fanning'
      else if (state === 'stacked' && wasFanned) phase = 'stacking'
      if (phase) {
        useCanvasStore.getState().setFanTransition({ deckId: firstAnchor, phase })
        // Adaptive cleanup: match the actual animation end so the
        // FannedDeckOverlay → StackedDeckCard handoff doesn't sit on a
        // pause. Per-strip duration + (N-1)*stagger + tiny buffer.
        // Stagger scales with deck size for readability — mirrors the
        // formula in FannedDeckOverlay's useLayoutEffect.
        const stripCount = Math.max(1, groupIds.length - 1)
        const STRIP_DURATION_MS = phase === 'fanning' ? 100 : 90
        const STAGGER_MS = Math.max(8, Math.min(20, Math.floor(stripCount * 1.5)))
        const CLEAR_BUFFER_MS = 20
        const clearAfter = STRIP_DURATION_MS + (stripCount - 1) * STAGGER_MS + CLEAR_BUFFER_MS
        setTimeout(() => {
          const cur = useCanvasStore.getState().fanTransition
          if (cur && cur.deckId === firstAnchor && cur.phase === phase) {
            useCanvasStore.getState().setFanTransition(null)
          }
        }, clearAfter)
      }
    }
    set(s0 => {
      const s = !away ? s0 : {
        ...s0,
        groups: s0.groups.map(g => {
          if (g.id === away.front.id) return away.lay.ghosts ? { ...g, ghostSlots: away.lay.ghosts } : g
          const p = away.lay.spots.get(g.id)
          if (!p) return g
          return state === 'open'
            ? { ...g, deckOffsetX: p.x - away.front.originX, deckOffsetY: p.y - away.front.originY }
            : { ...g, originX: p.x, originY: p.y }
        }),
      }
      // Detect sub-deck anchors: members whose ID is referenced by
      // deckAnchorId of COLLAPSED groups OUTSIDE this set (they anchor a
      // nested sub-deck). An open card's leftover pointer is not a sub-deck
      // — counting it took the sub-deck branch for a plain anchor, which
      // never sets its deckState: Open Deck left it stuck 'stacked', and
      // Stack left it 'open'. Same rule as useCardDecks' isSubDeckAnchor.
      const subDeckAnchors = new Set<string>()
      for (const g of s.groups) {
        if (!idSet.has(g.id) && g.deckAnchorId && idSet.has(g.deckAnchorId)
            && g.deckState && g.deckState !== 'open') {
          subDeckAnchors.add(g.deckAnchorId)
        }
      }
      // For stacking/fanning, the new anchor is groupIds[0].
      const anchorGroup = anchorId ? s.groups.find(g => g.id === anchorId) : null
      const groupById = new Map(s.groups.map(g => [g.id, g]))
      // Closing onto a card other than the one holding checked-out cards'
      // slots (another primary card): the slots go to the new front card,
      // where they lie on the canvas, so a card pulled out of the deck keeps
      // its place in it and checks back in there (returnToDeck looks for the
      // card holding its slot). A sub-deck keeps its own.
      const holders = new Set<string>()
      const handed = state === 'open' || !anchorGroup ? [] : s.groups.flatMap(g => {
        if (!idSet.has(g.id) || g.id === anchorId || subDeckAnchors.has(g.id) || !g.ghostSlots?.length) return []
        holders.add(g.id)
        return g.ghostSlots.map(sl => ({ ...sl, deckOffsetX: sl.deckOffsetX + g.originX - anchorGroup.originX, deckOffsetY: sl.deckOffsetY + g.originY - anchorGroup.originY }))
      })

      // For opening: each member is repositioned relative to its OWN
      // deckAnchorId (which is the deck's actual anchor — the group with
      // self-anchored deckAnchorId === id). Using groupIds[0] would be wrong
      // when groupIds[0] !== actual anchor, e.g. when a sub-member's content
      // extends further leftward than the anchor's so that the sub-member
      // lands ahead of the anchor in deck.memberIds.
      const refAnchor = (g: ProjectGroup) =>
        g.deckAnchorId && g.id !== g.deckAnchorId ? groupById.get(g.deckAnchorId) ?? null : null

      // When opening, propagate each in-idSet member's repositioning delta
      // down to its transitive descendants OUTSIDE idSet (deeper nested
      // sub-deck members). Without this, those nested members keep stale
      // absolute positions and their sub-deck's layout scrambles. Each
      // outside group adopts the delta of its NEAREST in-idSet ancestor.
      const positionShifts = new Map<string, { dx: number; dy: number }>()
      if (state === 'open') {
        const idSetDeltas = new Map<string, { dx: number; dy: number }>()
        for (const g of s.groups) {
          if (!idSet.has(g.id)) continue
          if (g.deckOffsetX == null || g.deckOffsetY == null) continue
          const anchor = refAnchor(g)
          if (!anchor) continue // self-anchored or no anchor — doesn't move
          const newOx = anchor.originX + g.deckOffsetX
          const newOy = anchor.originY + g.deckOffsetY
          const dx = newOx - g.originX
          const dy = newOy - g.originY
          if (dx !== 0 || dy !== 0) idSetDeltas.set(g.id, { dx, dy })
        }
        if (idSetDeltas.size > 0) {
          // Walk each outside group's deckAnchorId chain to its nearest
          // in-idSet ancestor. Visited-set guards against any cycle in the
          // anchor graph (e.g. a self-anchored card outside idSet).
          for (const g of s.groups) {
            if (idSet.has(g.id)) continue
            let cur = g.deckAnchorId
            const visited = new Set<string>()
            while (cur && !visited.has(cur)) {
              if (idSet.has(cur)) {
                const delta = idSetDeltas.get(cur)
                if (delta) positionShifts.set(g.id, delta)
                break
              }
              visited.add(cur)
              const parent = groupById.get(cur)
              if (!parent) break
              cur = parent.deckAnchorId
            }
          }
        }
      }

      const out = s.groups.map(g => {
          if (!idSet.has(g.id)) {
            const shift = positionShifts.get(g.id)
            if (shift) return { ...g, originX: g.originX + shift.dx, originY: g.originY + shift.dy }
            return g
          }
          if (subDeckAnchors.has(g.id)) {
            if (state === 'open') {
              // Sub-deck anchor opening: restore position relative to its own
              // deckAnchorId, preserving the sub-deck's own state and the
              // nestedDeck flag (it's still a sub-deck on canvas).
              let ox = g.originX, oy = g.originY
              const anchor = refAnchor(g)
              if (anchor && g.deckOffsetX != null && g.deckOffsetY != null) {
                ox = anchor.originX + g.deckOffsetX
                oy = anchor.originY + g.deckOffsetY
              }
              return { ...g, deckAnchorId: undefined, nestedDeck: true, originX: ox, originY: oy, deckOffsetX: undefined, deckOffsetY: undefined, deckLastFront: openFront ? openFront.id : g.deckLastFront }
            }
            // Stacking/fanning: store offset from new parent anchor for later restore.
            const offX = anchorGroup ? g.originX - anchorGroup.originX : g.deckOffsetX
            const offY = anchorGroup ? g.originY - anchorGroup.originY : g.deckOffsetY
            return { ...g, deckAnchorId: anchorId, nestedDeck: true, deckOffsetX: offX, deckOffsetY: offY, deckLastFront: undefined }
          }
          if (state === 'open') {
            // Regular member opening: restore position relative to its own anchor.
            let ox = g.originX, oy = g.originY
            const anchor = refAnchor(g)
            if (anchor && g.deckOffsetX != null && g.deckOffsetY != null) {
              ox = anchor.originX + g.deckOffsetX
              oy = anchor.originY + g.deckOffsetY
            }
            return { ...g, deckState: state, deckAnchorId: anchorId, nestedDeck: undefined, originX: ox, originY: oy, deckOffsetX: undefined, deckOffsetY: undefined, deckLastFront: openFront ? openFront.id : g.deckLastFront }
          }
          // Stacking/fanning: store offset from anchor
          const offX = anchorGroup ? g.originX - anchorGroup.originX : g.deckOffsetX
          const offY = anchorGroup ? g.originY - anchorGroup.originY : g.deckOffsetY
          // A closed deck keeps its own front (utils/primaryCard); the row
          // it came from is gone.
          return { ...g, deckState: state, deckAnchorId: anchorId, nestedDeck: g.nestedDeck, deckOffsetX: offX, deckOffsetY: offY, deckLastFront: undefined }
        })
      if (!handed.length) return { groups: out }
      return { groups: out.map(g => g.id === anchorId ? { ...g, ghostSlots: [...(g.ghostSlots ?? []), ...handed] }
        : holders.has(g.id) ? { ...g, ghostSlots: undefined } : g) }
    })
  },

  setRowPrimary(groupId, rowIds) {
    const row = new Set([groupId, ...rowIds])
    set(s => ({ groups: s.groups.map(g => row.has(g.id) && g.deckLastFront !== groupId ? { ...g, deckLastFront: groupId } : g) }))
  },

  extractFromDeck(cardId, newOriginX, newOriginY) {
    set(s => {
      const card = s.groups.find(g => g.id === cardId)
      if (!card || !card.deckAnchorId) return {}
      const parentId = card.deckAnchorId
      const parent = s.groups.find(g => g.id === parentId)
      if (!parent) return {}
      // Snapshot the card's slot offsets before clearing.
      const slotOffsetX = card.deckOffsetX ?? 0
      const slotOffsetY = card.deckOffsetY ?? 0
      // Does the card have tethered sub-members? Then it stays as a deck
      // anchor (self-anchored) so its sub-deck renders as a stacked/fanned
      // card on canvas. Otherwise it becomes a plain open card.
      const hasSubMembers = s.groups.some(g => g.id !== cardId && g.deckAnchorId === cardId)
      // Shift any transitive sub-members by the same delta as the anchor so
      // their absolute originX/Y stays consistent with their preserved
      // deckOffsetX/Y. Without this, sub-members render at the anchor's
      // pre-extract location until something forces a deckState='open' pass.
      const dx = newOriginX - card.originX
      const dy = newOriginY - card.originY
      const subTreeIds = hasSubMembers ? new Set(getTransitiveDescendantIds(cardId, s.groups)) : new Set<string>()
      return {
        groups: s.groups.map(g => {
          if (g.id === parentId) {
            const slots = g.ghostSlots ?? []
            // De-dupe by cardId in case the card was somehow already extracted.
            const filtered = slots.filter(sl => sl.cardId !== cardId)
            return { ...g, ghostSlots: [...filtered, { cardId, deckOffsetX: slotOffsetX, deckOffsetY: slotOffsetY }] }
          }
          if (g.id === cardId) {
            if (hasSubMembers) {
              // Self-anchored sub-deck on canvas; preserve its own deckState.
              const own: 'stacked' | 'fanned' =
                (g.deckState === 'stacked' || g.deckState === 'fanned') ? g.deckState : 'stacked'
              return {
                ...g,
                originX: newOriginX,
                originY: newOriginY,
                deckAnchorId: g.id,
                deckOffsetX: 0,
                deckOffsetY: 0,
                deckState: own,
                nestedDeck: undefined,
              }
            }
            // Plain open card.
            return {
              ...g,
              originX: newOriginX,
              originY: newOriginY,
              deckAnchorId: undefined,
              deckOffsetX: undefined,
              deckOffsetY: undefined,
              deckState: 'open',
              nestedDeck: undefined,
              deckLastFront: undefined,
            }
          }
          if (subTreeIds.has(g.id)) {
            return { ...g, originX: g.originX + dx, originY: g.originY + dy }
          }
          return g
        }),
      }
    })
  },

  returnToDeck(cardId) {
    set(s => {
      // Find the parent that holds this card's ghost slot.
      const parent = s.groups.find(p => (p.ghostSlots ?? []).some(sl => sl.cardId === cardId))
      if (!parent) return {}
      const slot = (parent.ghostSlots ?? []).find(sl => sl.cardId === cardId)!
      const card = s.groups.find(g => g.id === cardId)
      if (!card) return {}
      const newOriginX = parent.originX + slot.deckOffsetX
      const newOriginY = parent.originY + slot.deckOffsetY
      // Shift any transitive sub-members by the anchor's delta so the whole
      // sub-tree lands intact at the slot position. Without this, returning a
      // sub-deck snaps the anchor home but leaves its members at the drag-drop
      // location, breaking the visual layout until the sub-deck is re-opened.
      const dx = newOriginX - card.originX
      const dy = newOriginY - card.originY
      const subTreeIds = getTransitiveDescendantIds(cardId, s.groups)
      const subTreeIdSet = new Set(subTreeIds)
      // The card's own deck now CONTAINS the deck it was taken from (the
      // parent was stacked under it). Returning it there would put each deck
      // inside the other — a cycle in which every card is a hidden member
      // and nothing is ever drawn again. The tether has nothing left to
      // return to, so drop the ghost slot and leave the cards as they are.
      if (subTreeIdSet.has(parent.id)) {
        return {
          groups: s.groups.map(g => {
            if (g.id !== parent.id) return g
            const slots = (g.ghostSlots ?? []).filter(sl => sl.cardId !== cardId)
            return { ...g, ghostSlots: slots.length > 0 ? slots : undefined }
          }),
        }
      }
      // Cards reachable inside the returning anchor (anchor + descendants) are
      // no longer "extracted" from the parent — they live inside parent again
      // via the nested-deck chain. Drop any of their lingering ghostSlots from
      // the parent so we don't render orphan slots in the fan.
      const reachable = new Set<string>([cardId, ...subTreeIds])
      return {
        groups: s.groups.map(g => {
          if (g.id === parent.id) {
            const slots = (g.ghostSlots ?? []).filter(sl => !reachable.has(sl.cardId))
            return { ...g, ghostSlots: slots.length > 0 ? slots : undefined }
          }
          if (g.id === cardId) {
            // Land at the slot position; the exact tether depends on whether
            // the parent is currently a deck (fanned/stacked) or open.
            const hasSubMembers = subTreeIds.length > 0
            const parentIsOpen = !parent.deckState || parent.deckState === 'open'
            if (hasSubMembers) {
              const own: 'stacked' | 'fanned' =
                (g.deckState === 'stacked' || g.deckState === 'fanned') ? g.deckState : 'stacked'
              if (parentIsOpen) {
                // Parent is currently NOT a deck. Re-tethering to it would
                // mark this card as a hidden deck member of a non-existent
                // fan — it'd vanish from view until the parent re-closes.
                // Instead, return as a self-anchored sub-deck on canvas at
                // the slot position. Sub-tree members travel along via the
                // delta shift below.
                return {
                  ...g,
                  originX: newOriginX,
                  originY: newOriginY,
                  deckAnchorId: g.id,
                  deckOffsetX: 0,
                  deckOffsetY: 0,
                  deckState: own,
                  nestedDeck: undefined,
                }
              }
              // Parent is fanned/stacked → A becomes a nested sub-deck
              // member, rendering as a strip in the parent's fan/stack.
              return {
                ...g,
                originX: newOriginX,
                originY: newOriginY,
                deckAnchorId: parent.id,
                deckOffsetX: slot.deckOffsetX,
                deckOffsetY: slot.deckOffsetY,
                deckState: own,
                nestedDeck: true,
              }
            }
            // No sub-members. An open parent gives a standalone open card at
            // the slot position, matching the other now-open siblings — and
            // like them it keeps NO deckAnchorId (Open Deck clears theirs).
            // A leftover pointer to the parent was read as a sub-deck by the
            // next Stack or Open Deck, which left the anchor half-updated.
            if (parentIsOpen) {
              return {
                ...g,
                originX: newOriginX,
                originY: newOriginY,
                deckAnchorId: undefined,
                deckOffsetX: undefined,
                deckOffsetY: undefined,
                deckState: 'open',
                nestedDeck: undefined,
                deckLastFront: undefined,
              }
            }
            return {
              ...g,
              originX: newOriginX,
              originY: newOriginY,
              deckAnchorId: parent.id,
              deckOffsetX: slot.deckOffsetX,
              deckOffsetY: slot.deckOffsetY,
              deckState: parent.deckState,
              nestedDeck: undefined,
              deckLastFront: undefined,
            }
          }
          if (subTreeIdSet.has(g.id)) {
            return { ...g, originX: g.originX + dx, originY: g.originY + dy }
          }
          return g
        }),
      }
    })
  },

  severDeckTether(cardId) {
    set(s => ({
      groups: s.groups.map(g => {
        const slots = g.ghostSlots
        if (!slots || !slots.some(sl => sl.cardId === cardId)) return g
        const filtered = slots.filter(sl => sl.cardId !== cardId)
        return { ...g, ghostSlots: filtered.length > 0 ? filtered : undefined }
      }),
    }))
  },

  setGroupPos(groupId, originY, originX) {
    const g = get().groups.find(gr => gr.id === groupId)
    if (g && g.originY === originY && g.originX === originX) return
    set(s => ({ groups: s.groups.map(g => g.id === groupId ? { ...g, originY, originX } : g) }))
  },

  setGroupPosBatch(updates) {
    if (updates.length === 0) return
    // Single-group shortcut
    if (updates.length === 1) {
      const u = updates[0]
      const g = get().groups.find(gr => gr.id === u.groupId)
      if (g && g.originY === u.originY && g.originX === u.originX) return
      set(s => ({ groups: s.groups.map(g => g.id === u.groupId ? { ...g, originY: u.originY, originX: u.originX } : g) }))
      return
    }
    // Build lookup for O(1) per-group update
    const lookup = new Map(updates.map(u => [u.groupId, u]))
    // Check if anything actually changed
    const groups = get().groups
    const anyChanged = updates.some(u => {
      const g = groups.find(gr => gr.id === u.groupId)
      return !g || g.originY !== u.originY || g.originX !== u.originX
    })
    if (!anyChanged) return
    set(s => ({
      groups: s.groups.map(g => {
        const u = lookup.get(g.id)
        return u ? { ...g, originY: u.originY, originX: u.originX } : g
      })
    }))
  },

  reassignBoard(boardId, targetGroupId, dropCanvasPos) {
    const s = get()
    const targetGroup = s.groups.find(g => g.id === targetGroupId)
    if (!targetGroup) return
    // Use explicit drop position if provided, otherwise compute from current state
    const absPos = dropCanvasPos ?? getBoardAbsolutePos(boardId, s.groups, s.boards)
    // Compute local position within the target group
    const nleX = absPos.x - targetGroup.originX
    const targetLayout = computeGroupLayout(targetGroup.boardIds, s.boards)
    const localY = absPos.y - targetGroup.originY
    const nleRow = yToRow(localY, targetLayout)
    set(s2 => {
      const board = s2.boards[boardId]
      if (!board) return s2
      const updatedBoard = { ...board, nleRow, nleX }
      let groups = s2.groups.map(g => {
        if (g.id === targetGroupId) return { ...g, boardIds: g.boardIds.includes(boardId) ? g.boardIds : [...g.boardIds, boardId] }
        return { ...g, boardIds: g.boardIds.filter(bid => bid !== boardId) }
      })
      // Drop any source group that became empty (except default-group)
      groups = groups.filter(g => g.id === 'default-group' || g.id === targetGroupId || g.boardIds.length > 0)
      return { boards: { ...s2.boards, [boardId]: updatedBoard }, groups }
    })
  },

  moveToNewGroup(boardId) {
    const s = get()
    const board = s.boards[boardId]
    if (!board) return
    // Keep group.name empty for brand-new groups — the UI renders "New Card"
    // as a dimmed placeholder when the field is empty. If the board already
    // has a user-entered name, carry it over.
    const name = board.projectName && board.projectName.length > 0 ? board.projectName : ''
    const color = board.color ?? '#5b8dd9'
    const id = crypto.randomUUID()
    // Use absolute position so the new group origin matches the board's current visual position
    const absPos = getBoardAbsolutePos(boardId, s.groups, s.boards)
    set(s2 => {
      let groups = s2.groups.map(g => ({
        ...g, boardIds: g.boardIds.filter(bid => bid !== boardId),
      }))
      // Drop any source group that became empty (except default-group)
      groups = groups.filter(g => g.id === 'default-group' || g.boardIds.length > 0)
      // Reset board's local position to 0,0 within the new group
      const updatedBoard = { ...s2.boards[boardId], nleRow: 0, nleX: 0 }
      const newGroup: ProjectGroup = { id, name, color, boardIds: [boardId], cardHeroImage: null, cardSummary: '', cardText: '', cardHeaderText: '', cardHeroTransform: { ...NEW_CARD_FACE }, originY: absPos.y, originX: absPos.x }
      return { boards: { ...s2.boards, [boardId]: updatedBoard }, groups: [...groups, newGroup] }
    })
  },

  duplicateGroup(groupId) {
    const group = get().groups.find(g => g.id === groupId)
    if (!group) return null
    const newGroupId = crypto.randomUUID()
    const newBoardIds: string[] = []
    // Duplicate each board in the group
    group.boardIds.forEach(bid => {
      const newBid = get().duplicateBoard(bid)
      newBoardIds.push(newBid)
    })
    // Remove the duplicated boards from whatever group they landed in, create new group
    set(s => {
      const cleaned = s.groups.map(g => ({
        ...g, boardIds: g.boardIds.filter(bid => !newBoardIds.includes(bid)),
      }))
      const remaining = cleaned.filter(g => g.boardIds.length > 0)
      // Everything the card IS — its grid layout, face block, effect, size —
      // but not where it belongs: no deck, pin, strip result or links.
      const own: ProjectGroup = { ...group }
      for (const k of ['deckState', 'deckAnchorId', 'deckOffsetX', 'deckOffsetY', 'deckFaceCard', 'pin', 'railSource', 'railBase', 'deckLastFront', 'linkOf'] as const) delete own[k]
      const faceAt = group.faceBoardId ? group.boardIds.indexOf(group.faceBoardId) : -1
      const newGroup: ProjectGroup = {
        ...own,
        faceBoardId: faceAt >= 0 ? newBoardIds[faceAt] : undefined,
        id: newGroupId,
        name: group.name + ' copy',
        color: group.color,
        boardIds: newBoardIds,
        cardHeroImage: group.cardHeroImage,
        cardHeroTransform: group.cardHeroTransform ? { ...group.cardHeroTransform } : undefined,
        cardSummary: group.cardSummary,
        cardText: group.cardText ?? '',
        cardHeaderText: group.cardHeaderText ?? '',
        cardTextStyle: group.cardTextStyle ? { ...group.cardTextStyle } : undefined,
        cardHeaderTextStyle: group.cardHeaderTextStyle ? { ...group.cardHeaderTextStyle } : undefined,
        cardWidthOverride: group.cardWidthOverride,
        cardHeightOverride: group.cardHeightOverride,
        textSplitRatio: group.textSplitRatio,
        originY: group.originY + 100,
        originX: group.originX + 100,
      }
      return { groups: [...remaining, newGroup] }
    })
    return newGroupId
  },

  // ── Ungrouped board actions (free canvas) ──

  createUngroupedBoard(canvasX, canvasY) {
    const id = crypto.randomUUID()
    const rootId = crypto.randomUUID()
    const board: BoardData = {
      id, projectName: '', color: '#5b8dd9',
      nleRow: 0, nleX: 0,
      canvasX, canvasY,
      bars: {
        [rootId]: makeBar({ id: rootId, parentId: null, rowIndex: 0, x: 0, width: INIT_W, height: INIT_H }),
      },
      rootIds: [rootId],
      viewerBarId: null,
      selectedIds: [],
      savedCollapsedState: null,
      pristine: true,
      boardScale: 1,
      layers: { ...DEFAULT_LAYERS },
    }
    set(s => ({
      boards: { ...s.boards, [id]: board },
      boardOrder: [...s.boardOrder, id],
      // NOT added to any group — this is the key difference
    }))
    return id
  },

  ungroupBoard(boardId) {
    if (boardId === 'primary') return  // never ungroup primary
    const s = get()
    const group = s.groups.find(g => g.boardIds.includes(boardId))
    if (!group) return  // already ungrouped
    // Compute absolute canvas position before removing from group
    const absPos = getBoardAbsolutePos(boardId, s.groups, s.boards)
    set(s2 => {
      // Update board with absolute position
      const board = s2.boards[boardId]
      if (!board) return s2
      const updatedBoard = { ...board, canvasX: absPos.x, canvasY: absPos.y }
      // Remove from group
      let groups = s2.groups.map(g =>
        g.id === group.id ? { ...g, boardIds: g.boardIds.filter(bid => bid !== boardId) } : g
      )
      // Drop the source group if it became empty (except default-group)
      groups = groups.filter(g => g.id === 'default-group' || g.boardIds.length > 0)
      return { boards: { ...s2.boards, [boardId]: updatedBoard }, groups }
    })
  },

  groupBoard(boardId, targetGroupId) {
    const s = get()
    const board = s.boards[boardId]
    if (!board) return
    const group = s.groups.find(g => g.id === targetGroupId)
    if (!group) return
    // Compute local position within the target group
    const cx = board.canvasX ?? 0
    const cy = board.canvasY ?? 0
    const nleX = cx - group.originX
    const groupLayout = computeGroupLayout(group.boardIds, s.boards)
    const localY = cy - group.originY
    const nleRow = yToRow(localY, groupLayout)
    set(s2 => {
      const updatedBoard = { ...s2.boards[boardId], nleRow, nleX, canvasX: undefined, canvasY: undefined }
      const groups = s2.groups.map(g =>
        g.id === targetGroupId ? { ...g, boardIds: [...g.boardIds, boardId] } : g
      )
      return { boards: { ...s2.boards, [boardId]: updatedBoard }, groups }
    })
  },

  groupBoardAsNew(boardId) {
    const board = get().boards[boardId]
    if (!board) return
    const cx = board.canvasX ?? 0
    const cy = board.canvasY ?? 0
    const id = crypto.randomUUID()
    const newGroup: ProjectGroup = {
      id,
      // Empty so the UI renders "New Card" as a dimmed placeholder.
      name: board.projectName && board.projectName.length > 0 ? board.projectName : '',
      color: board.color ?? '#5b8dd9',
      boardIds: [boardId],
      cardHeroImage: null,
      cardSummary: '',
      cardText: '',
      cardHeaderText: '',
      cardHeroTransform: { ...NEW_CARD_FACE },
      originY: cy,
      originX: cx,
    }
    set(s => {
      const updatedBoard = { ...s.boards[boardId], nleRow: 0, nleX: 0, canvasX: undefined, canvasY: undefined }
      return {
        boards: { ...s.boards, [boardId]: updatedBoard },
        groups: [...s.groups, newGroup],
      }
    })
  },

  setUngroupedBoardPos(boardId, canvasX, canvasY) {
    const b = get().boards[boardId]
    if (b && b.canvasX === canvasX && b.canvasY === canvasY) return
    updateBoard(set, boardId, () => ({ canvasX, canvasY }))
  },

  setSelectedGroup(groupId) {
    set({ selectedGroupIds: groupId ? [groupId] : [] })
  },
  toggleGroupSelection(groupId) {
    set(s => {
      const ids = s.selectedGroupIds
      return { selectedGroupIds: ids.includes(groupId) ? ids.filter(id => id !== groupId) : [...ids, groupId] }
    })
  },
  setSelectedGroups(groupIds) {
    set({ selectedGroupIds: groupIds })
  },
  clearGroupSelection() {
    set({ selectedGroupIds: [] })
  },

  // ── One-way group linking ──
  // Stores only the outbound direction: "a references b". The reverse
  // (back-reference) is derived at render time via `getBackRefs`.
  // This lets the UI present asymmetric weights: the link you *made* is
  // prominent on your card; the back-reference on the referenced card
  // is smaller/muted.
  linkGroups(a, b) {
    if (!a || !b || a === b) return
    set(s => ({
      groups: s.groups.map(g => {
        if (g.id !== a) return g
        const cur = g.linkedGroupIds ?? []
        return cur.includes(b) ? g : { ...g, linkedGroupIds: [...cur, b] }
      }),
    }))
  },
  unlinkGroups(a, b) {
    if (!a || !b) return
    set(s => ({
      groups: s.groups.map(g => {
        if (g.id !== a) return g
        const cur = g.linkedGroupIds ?? []
        return cur.includes(b) ? { ...g, linkedGroupIds: cur.filter(id => id !== b) } : g
      }),
    }))
  },

  // ── Links between any two things ──────────────────────────────────────
  // linkGroups above is the card-to-card special case, kept because a dozen
  // consumers read linkedGroupIds directly. These two handle every pair.

  linkRefs(owner, ref) {
    if (sameRef(owner, ref)) return
    // Card-to-card keeps flowing into linkedGroupIds so that everything
    // already reading that field — the Rolodex, project insert, clone
    // expansion — keeps seeing links it would otherwise miss.
    if (owner.kind === 'group' && ref.kind === 'group') {
      get().linkGroups(owner.id, ref.id)
      return
    }
    const add = (list: LinkRef[] | undefined) =>
      (list ?? []).some(r => sameRef(r, ref)) ? list ?? [] : [...(list ?? []), ref]

    if (owner.kind === 'group') {
      set(s => ({ groups: s.groups.map(g =>
        g.id === owner.id ? { ...g, linkedRefs: add(g.linkedRefs) } : g) }))
      return
    }
    if (owner.kind === 'board') {
      set(s => {
        const b = s.boards[owner.id]
        if (!b) return {}
        return { boards: { ...s.boards, [owner.id]: { ...b, linkedRefs: add(b.linkedRefs) } } }
      })
      return
    }
    set(s => {
      const b = s.boards[owner.boardId]
      const bar = b?.bars[owner.id]
      if (!b || !bar) return {}
      return {
        boards: {
          ...s.boards,
          [owner.boardId]: {
            ...b,
            bars: { ...b.bars, [owner.id]: { ...bar, linkedRefs: add(bar.linkedRefs) } },
          },
        },
      }
    })
  },

  unlinkRefs(owner, ref) {
    if (owner.kind === 'group' && ref.kind === 'group') {
      get().unlinkGroups(owner.id, ref.id)
      // Fall through as well: an imported project could have put a group
      // referent in linkedRefs, and half-removing a link leaves a chip that
      // cannot be dismissed.
    }
    const drop = (list: LinkRef[] | undefined) => (list ?? []).filter(r => !sameRef(r, ref))

    if (owner.kind === 'group') {
      set(s => ({ groups: s.groups.map(g =>
        g.id === owner.id ? { ...g, linkedRefs: drop(g.linkedRefs) } : g) }))
      return
    }
    if (owner.kind === 'board') {
      set(s => {
        const b = s.boards[owner.id]
        if (!b) return {}
        return { boards: { ...s.boards, [owner.id]: { ...b, linkedRefs: drop(b.linkedRefs) } } }
      })
      return
    }
    set(s => {
      const b = s.boards[owner.boardId]
      const bar = b?.bars[owner.id]
      if (!b || !bar) return {}
      return {
        boards: {
          ...s.boards,
          [owner.boardId]: {
            ...b,
            bars: { ...b.bars, [owner.id]: { ...bar, linkedRefs: drop(bar.linkedRefs) } },
          },
        },
      }
    })
  },
}), {
  name: 'vidbars-boards',
  storage: createDebouncedIDBStorage(400),
  version: 12,
  migrate(persisted: any, version: number) {
    if (version < 3) {
      const boards = persisted.boards ?? {}
      for (const key of Object.keys(boards)) {
        if (!boards[key].layers) {
          boards[key].layers = { card: { heroImage: null, summary: '' }, block: { thumbnail: null, label: '' } }
        }
      }
    }
    if (version < 4) {
      const boardOrder: string[] = persisted.boardOrder ?? []
      const primary = persisted.boards?.['primary']
      const heroImage = primary?.layers?.card?.heroImage ?? null
      const summary = primary?.layers?.card?.summary ?? ''
      const color = primary?.color ?? '#5b8dd9'
      persisted.groups = [{
        id: 'default-group',
        name: 'NLE Timeline',
        color,
        boardIds: ['primary', ...boardOrder],
        cardHeroImage: heroImage,
        cardSummary: summary,
        originY: 0, originX: 0,
      }]
    }
    if (version < 5) {
      // v4→v5: Convert global nleRow/nleX to group-local + compute group origins.
      // Each group's origin = the minimum absolute position of its boards.
      // Each board's nleRow/nleX becomes relative to the group origin.
      //
      // For primary board: its global Y was stored in canvasStore.boardPos.y,
      // and its nleRow was 0. We read canvasStore separately and set primary's
      // nleRow/nleX in the group-local system.
      const boards = persisted.boards ?? {}
      const groups: any[] = persisted.groups ?? []
      const ROW_GAP = 16
      const FIXED_H = 300  // default nleRowHeight

      // Read canvasStore from localStorage to get primary board's absolute position
      let primaryAbsY = 0
      let primaryAbsX = 0
      try {
        const canvasRaw = localStorage.getItem('vidbars-canvas')
        if (canvasRaw) {
          const cs = JSON.parse(canvasRaw)?.state
          if (cs?.boardPos) {
            primaryAbsY = cs.boardPos.y ?? 0
            primaryAbsX = cs.boardPos.x ?? 0
          }
        }
      } catch {}

      // Helper: get a board's absolute Y from old global nleRow
      function oldAbsY(bid: string): number {
        if (bid === 'primary') return primaryAbsY
        const b = boards[bid]
        if (!b) return 0
        return (b.nleRow ?? 0) * (FIXED_H + ROW_GAP)
      }
      function oldAbsX(bid: string): number {
        if (bid === 'primary') return primaryAbsX
        return boards[bid]?.nleX ?? 0
      }

      groups.forEach((g: any) => {
        const bids: string[] = g.boardIds ?? []
        if (bids.length === 0) {
          g.originY = 0
          g.originX = 0
          return
        }

        // Group origin = min absolute position of its boards
        const absYs = bids.map(oldAbsY)
        const absXs = bids.map(oldAbsX)
        const minY = Math.min(...absYs)
        const minX = Math.min(...absXs)
        g.originY = minY
        g.originX = minX

        // Convert each board to group-local coordinates
        bids.forEach(bid => {
          const b = boards[bid]
          if (!b) return
          const absY = oldAbsY(bid)
          // Compute local row from Y offset within group
          const localY = absY - minY
          const localRow = Math.round(localY / (FIXED_H + ROW_GAP))
          b.nleRow = localRow
          b.nleX = oldAbsX(bid) - minX
        })
      })

      persisted.groups = groups
    }
    if (version < 7) {
      // v6→v7: Compact group-local nleRow values to sequential 0, 1, 2...
      // Previous data may have gaps or non-zero-based row numbers.
      const boards = persisted.boards ?? {}
      const groups: any[] = persisted.groups ?? []
      groups.forEach((g: any) => {
        const bids: string[] = g.boardIds ?? []
        if (bids.length === 0) return
        // Collect unique row numbers, sort them, map to 0-based sequential
        const rowSet = new Set<number>()
        bids.forEach(bid => { if (boards[bid]) rowSet.add(boards[bid].nleRow ?? 0) })
        const sorted = [...rowSet].sort((a, b) => a - b)
        const rowMap = new Map<number, number>()
        sorted.forEach((oldRow, idx) => rowMap.set(oldRow, idx))
        bids.forEach(bid => {
          const b = boards[bid]
          if (b) b.nleRow = rowMap.get(b.nleRow ?? 0) ?? 0
        })
      })
      persisted.groups = groups
    }
    if (version < 9) {
      // v8→v9: Add independent text fields to layers and groups
      const boards = persisted.boards ?? {}
      for (const b of Object.values(boards) as any[]) {
        if (b.layers?.card && !('text' in b.layers.card)) b.layers.card.text = ''
        if (b.layers?.block && !('text' in b.layers.block)) b.layers.block.text = ''
      }
      const groups: any[] = persisted.groups ?? []
      for (const g of groups) {
        if (!('cardText' in g)) g.cardText = ''
      }
    }
    if (version < 10) {
      // v9→v10: Backfill deckAnchorId for groups that have deckState set.
      // Groups with deckState !== 'open' but no deckAnchorId need one.
      // Reset them to 'open' so user can re-stack cleanly.
      const groups: any[] = persisted.groups ?? []
      for (const g of groups) {
        if (g.deckState && g.deckState !== 'open' && !g.deckAnchorId) {
          g.deckState = 'open'
        }
      }
    }
    if (version < 11) {
      // v10→v11: Backfill linkedGroupIds for bi-directional deck linking.
      const groups: any[] = persisted.groups ?? []
      for (const g of groups) {
        if (!Array.isArray(g.linkedGroupIds)) g.linkedGroupIds = []
      }
    }
    if (version < 12) {
      // v11→v12: Sweep "phantom" groups whose boardIds all resolve to
      // missing or empty boards (no valid root bars). Such groups
      // accumulated from interrupted localStorage writes, abandoned
      // create flows, and old migrations; the canvas renders them as
      // 0×0 (invisible) but the Rolodex would still list them. This
      // mirrors the validity check the canvas already applies in
      // CardLayer.tsx (see the GroupCard bounds calc).
      const boards = persisted.boards ?? {}
      const groups: any[] = persisted.groups ?? []
      const isRenderable = (g: any): boolean => {
        for (const bid of (g.boardIds ?? [])) {
          const board = boards[bid]
          if (!board) continue
          for (const rid of (board.rootIds ?? [])) {
            if (board.bars && board.bars[rid]) return true
          }
        }
        return false
      }
      const cleaned = groups.filter(isRenderable)
      // Invariant: keep at least one group so the canvas always has a
      // destination for new boards. If every group was phantom, fall
      // back to the original first group (almost always default-group).
      persisted.groups = cleaned.length > 0
        ? cleaned
        : (groups.length > 0 ? [groups[0]] : [])
    }
    return persisted as BoardsState
  },
  partialize: (s) => ({
    boards: Object.fromEntries(
      Object.entries(s.boards).map(([id, b]) => [id, {
        ...b,
        viewerBarId: null,
        selectedIds: [],
      }])
    ),
    boardOrder: s.boardOrder,
    groups: s.groups,
    typeColors: s.typeColors,
    usedNames: s.usedNames,
  }),
}))

/** Deck members whose anchor is GONE go back on the canvas. A member is
 *  hidden (CardLayer's render gate, isHiddenDeckMember) and is drawn only
 *  through its anchor's deck; when the anchor is deleted — or its group
 *  dropped because its last board moved away — nothing draws or opens the
 *  member again, so it stayed hidden on the canvas while the Card Browser
 *  still listed it.
 *
 *  Members on an anchor LOOP (A in B's deck, B in A's) are healed the same
 *  way: every anchor exists, yet each is a hidden member, so no deck in the
 *  loop is ever drawn. Checking a card back in through its tether used to
 *  build such loops; canvases saved with one get their cards back.
 *
 *  An anchor that exists outside any loop but is itself 'open' is NOT an
 *  orphaning: useCardDecks' stored-anchor fallback draws that deck from its
 *  members' state (older stacks built after a card was pulled out of a fan
 *  and put back have that shape). Healing it undid the stack.
 *
 *  A regular member opens where it is: a collapsed deck's members move
 *  with it, so their origins are already right. A member that is itself a
 *  SUB-DECK anchor (cards outside the loop point at it) keeps its own deck
 *  and becomes a top-level one — the same shape setDeckState gives a
 *  sub-deck whose parent opens — rather than spilling its cards out.
 *
 *  Also clears the leftover pointer an OPEN card could keep to its old deck
 *  (returnToDeck used to leave one). It means nothing — an opened deck's
 *  cards keep none — but several readers count any pointer: the card was
 *  dragged along with that deck, listed under it in the Card Browser, and
 *  taken for a sub-deck.
 *
 *  Returns the same array when nothing needs healing. */
export function healOrphanDeckMembers(groups: ProjectGroup[]): ProjectGroup[] {
  const byId = new Map(groups.map(g => [g.id, g]))
  const collapsed = (g: ProjectGroup | undefined) => !!g && !!g.deckState && g.deckState !== 'open'
  const isMember = (g: ProjectGroup) => collapsed(g) && !!g.deckAnchorId && g.deckAnchorId !== g.id
  // Hidden members whose anchor chain comes back round to itself.
  const inLoop = new Set<string>()
  for (const g of groups) {
    if (!isMember(g) || inLoop.has(g.id)) continue
    const path: string[] = []
    const at = new Map<string, number>()
    let cur: ProjectGroup | undefined = g
    while (cur && isMember(cur) && !inLoop.has(cur.id)) {
      const seen = at.get(cur.id)
      if (seen !== undefined) { for (const id of path.slice(seen)) inLoop.add(id); break }
      at.set(cur.id, path.length)
      path.push(cur.id)
      cur = byId.get(cur.deckAnchorId!)
    }
  }
  const pointedAt = new Set(groups.filter(m => isMember(m) && !inLoop.has(m.id)).map(m => m.deckAnchorId!))
  let changed = false
  const out = groups.map(g => {
    if (!isMember(g)) {
      if (collapsed(g) || !g.deckAnchorId || g.deckAnchorId === g.id) return g
      changed = true
      return { ...g, deckAnchorId: undefined, nestedDeck: undefined, deckOffsetX: undefined, deckOffsetY: undefined }
    }
    if (byId.has(g.deckAnchorId!) && !inLoop.has(g.id)) return g
    changed = true
    if (pointedAt.has(g.id)) {
      return { ...g, deckAnchorId: undefined, nestedDeck: true, deckOffsetX: undefined, deckOffsetY: undefined }
    }
    return { ...g, deckState: 'open' as const, deckAnchorId: undefined, nestedDeck: undefined, deckOffsetX: undefined, deckOffsetY: undefined }
  })
  return changed ? out : groups
}

// Heal on EVERY change to the card list rather than in each action that
// can remove an anchor (delete, the last board leaving a group, a template
// load, undo…) — and on load from storage, which repairs canvases saved
// while the bug was live.
useBoardsStore.subscribe((s, prev) => {
  if (s.groups === prev.groups) return
  const healed = healOrphanDeckMembers(s.groups)
  if (healed !== s.groups) useBoardsStore.setState({ groups: healed })
})

// Dev-only: expose the running store on `window` so debugging tooling
// (preview_eval, devtools console) can reach the SAME instance the app
// uses. Without this, dynamic `import()` from outside the bundle graph
// gives a separate hot-loaded copy, and any setState calls on it have
// no effect on the live UI. Tied to import.meta.env.DEV so production
// builds drop it.
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  ;(window as unknown as { useBoardsStore: typeof useBoardsStore }).useBoardsStore = useBoardsStore
}
