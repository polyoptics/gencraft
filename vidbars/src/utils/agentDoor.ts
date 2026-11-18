// agentDoor.ts — the doorway an agent (Claude) works through (Brian
// 2026-11-10).
//
// Claude, in the Claude app, talks to a small connector (agent/vidbars-mcp.mjs).
// The connector asks the dev server (/api/agent, vite.config.ts), which
// passes the request to this window over the dev server's own socket; the
// answer goes back the same way. Nothing here is on screen.
//
// What an agent may do, and all it may do:
//   • READ cards (list, read): their names, types, text, details, links.
//   • READ decks (decks): which cards sit together, in order.
//   • HAND OUT a card's media (media): where each picture, movie, sound or
//     model on it is kept, so it can be passed on to another tool.
//   • DEAL new cards (deal): one closed deck in an empty spot of the view,
//     to flip through, keep or delete. One undo takes the whole deal back.
//     A dealt card is a new card (words, media that came in from outside)
//     or a new LINKED card of one that is there (utils/linkedCards).
//   • CHANGE what is there, when the artist asks (Brian 2026-11-18, "I
//     definitely want that loosened for the agent"): edit cards' words,
//     type, colour and details (edit); move cards into a row or a closed
//     deck (arrange); open or close a deck (deck); link cards (link);
//     delete cards (delete); select cards (select); and take back the last
//     change (undo). Each change is one undo step.
//   • USE THE TOOLS (Brian 2026-11-18: "you would need access to do all
//     the things that you can do in VidBars"): list the tools on the canvas
//     (tools), set one down (place), build a 3D set from cards and stand
//     their models in it (set3d, stand3d), make a looping GIF or a movie
//     of cards (gif, movie), add cards to a Rough Cut (cut).
//   • WORK A STATES WORKSPACE (Brian 2026-11-18: "I want to be able to have
//     Claude set up state machine relationships"): read one (states), add
//     nodes and wires to it (statesBuild), change or take out what it has
//     (statesEdit), and work it by hand as a click does (statesRun).
// (Brian 2026-11-18: widened for passing references out and taking results
// back as cards, then for working on the canvas as he does.)

import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useViewport3DStore } from '../store/viewport3dStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { canvasObstacleGroups, cardVisualRect, cardsTouch, expandWithNestedMembers, isHiddenDeckMember } from '../hooks/useCardDecks'
import { cardFaceSize, createMediaCard, createTextCard } from './cardGrid'
import { linkedHeight, makeLinkedCard, masterOf } from './linkedCards'
import { getMedia } from './mediaStore'
import { blobToDataUrl, isDataUrl, isMediaRef, mediaRefId } from './mediaRef'
import { markNew } from './newCards'
import { agentGlide, agentPoint, agentSpotOfCard } from './agentCursor'
import { placeBox, placeToolAt, type PlaceKind } from './placeTool'
import { bundleArea3dCard } from './area3dCard'
import { cardHoldsModel, dataKey, rowCards } from './area3dScene'
import { useModelScaleStore, useTiltStore } from '../store/tiltStore'
import { freeNodeFootprint } from './canvasCreate'
import { deckGifShots, makeDeckMovie, makeGif, useGifJob } from './makeGif'
import { appendCards, clipLength, clipRow, clipStart, cutLength, MIN_CLIP, placed, splitClipAt, type RoughClip, type RoughCutData } from './roughCut'
import { deckOfPicks } from './roughCutPicks'
import {
  addItem, addWire, canWire, choose, fireEvent, itemPorts, itemSize, patchItem, patchWire, planeBox, poke, removeFromSpace,
  setNow, setValue, spaceNumbers, spaceOf, spaceTruths, wireKind,
  type CalcOp, type Compare, type GenShape, type SpaceItem, type SpaceKind, type SpaceWire, type StateSpaceData,
} from './stateSpace'
import { viewportCenterInCanvas } from './canvasCreate'
import { showDockedCardInViewer } from '../hooks/useDockedContent'
import { collectDeckContent } from './contentTraversal'
import { viewportVisualRect } from './viewportDocking'
import { activeItemKey } from '../store/viewport3dStore'
import { EFFECTS, type EffectKind } from './fx/effects'
import { paramHelp } from './fx/paramHelp'
import { createEffectCardGroup, effectChain } from './effectCards'
import { cardStripId } from './fx/cardStrips'
import { useFxStore } from '../store/fxStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { isRail, railMembers, railRows, RAIL_TRAY, RAIL_GEOM, type RailSlot } from './rail'
import { dockCardsOnRail, placeCard } from './railCards'
import { runRail, stopRail, isRailRunning } from './fx/railRun'
import { railComboCount } from './fx/railChain'
import { useRailRunStore } from '../store/railRunStore'
import { saveFailure, saveStripResult } from './fx/saveStrip'
import { useNotesStore, useNotesUi, newNoteId, type Curve, type CurvePoint, type PathRider } from '../store/notesStore'
import { curvesOf, parentOf } from './curveParent'
import { parentToPath, rideSpan, rideTime, ridePlaying, setRider, unparentFromPath, useRideClock } from './pathRide'
import { CAMERA_URL, PRIMITIVES, PRIM_NAMES, primitiveUrl, type Primitive } from '../three/primitives'
import {
  deleteBranchFrom, deleteDot, migrateStoryline, neighbours, newStoryline, normalizeStoryline, sortBase,
  type StoryDot, type StorylineData,
} from './storyline'
import { CARD_TYPES, cardTypeOf, detailShown, newDetailId, type CardDetail, type CardType } from './cardTypes'
import { factionGroupsOf } from './factionGroups'
import { getMediaItems, type MediaItem, type MediaType } from '../types/bar'
import {
  addLinks, addStrip, canFold, clearDiv, findDiv, findParent, isLeaf, leaf, leaves, moveDiv, patchDiv, removeDiv, removeLink, splitDiv,
  type SceneDiv,
} from './sceneCard'
import { dropCardsInDivision, refreshDivision } from './sceneContent'

const MAX_DEAL = 40

type Json = Record<string, unknown>

const clip = (s: string | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** The few words for the pointer's bubble: the agent's own (`doing`), or ours. */
const say = (args: Json, ours: string) => clip(typeof args.doing === 'string' && args.doing.trim() ? args.doing : ours, 90)

// ── Reading ─────────────────────────────────────────────────────────────

/** Where a card lies on the canvas: its left, top, width and height, canvas units. */
function placeOf(g: ProjectGroup): Json | undefined {
  const r = cardVisualRect(g, useBoardsStore.getState().boards, useCanvasStore.getState().zoom)?.rect
  return r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.right - r.left), h: Math.round(r.bottom - r.top) } : undefined
}

/** Every card, briefly: enough to pick which ones to read. */
function listCards(args: Json): Json {
  const { groups, selectedGroupIds } = useBoardsStore.getState()
  const type = typeof args.type === 'string' ? args.type.toLowerCase() : ''
  const q = typeof args.search === 'string' ? args.search.toLowerCase().trim() : ''
  const selected = new Set(selectedGroupIds)
  const byId = new Map(groups.map(g => [g.id, g]))
  const cards = groups
    // An output card of a State card only shows other cards.
    .filter(g => !g.stateOut)
    .filter(g => !type || cardTypeOf(g) === type)
    .filter(g => !q || [g.name, g.cardHeaderText, g.cardText].some(t => (t ?? '').toLowerCase().includes(q)))
    .filter(g => !args.selectedOnly || selected.has(g.id))
    .map(g => ({
      id: g.id,
      name: g.name,
      type: cardTypeOf(g),
      ...(g.cardHeaderText && g.cardHeaderText !== g.name ? { header: clip(g.cardHeaderText, 80) } : {}),
      ...(g.cardText ? { text: clip(g.cardText, 140) } : {}),
      ...(selected.has(g.id) ? { selected: true } : {}),
      ...(g.linkOf ? { showingOf: byId.get(g.linkOf)?.name ?? g.linkOf } : {}),
      ...(isHiddenDeckMember(g) ? { inDeckOf: byId.get(g.deckAnchorId!)?.name ?? g.deckAnchorId } : {}),
      ...(g.linkedGroupIds?.length ? { links: g.linkedGroupIds.length } : {}),
      ...(args.places && !isHiddenDeckMember(g) ? { place: placeOf(g) } : {}),
    }))
  agentPoint(say(args, 'Looking over the cards'), cards.length === 1 ? agentSpotOfCard(cards[0].id) : undefined)
  return { count: cards.length, cards }
}

function sceneOutline(div: SceneDiv, byId: Map<string, ProjectGroup>): Json {
  if (div.kids?.length) return { split: div.dir ?? 'row', parts: div.kids.map(k => sceneOutline(k, byId)) }
  const card = div.card ?? div.cards?.[0]
  return {
    ...(div.name ? { name: div.name } : {}),
    ...(div.notes ? { notes: div.notes } : {}),
    ...(card ? { card: byId.get(card)?.name ?? card, cardId: card } : {}),
    ...(div.opens ? { opensScene: byId.get(div.opens)?.name ?? div.opens } : {}),
  }
}

/** One card, in full (its words; pictures only by file name). */
function describe(g: ProjectGroup, groups: ProjectGroup[], boards: Record<string, BoardData>): Json {
  const byId = new Map(groups.map(x => [x.id, x]))
  const name = (id: string) => byId.get(id)?.name ?? id
  const blocks = g.boardIds.flatMap(bid => {
    const b = boards[bid]
    if (!b) return []
    return b.rootIds.flatMap(rid => {
      const bar = b.bars[rid]
      if (!bar) return []
      const media = getMediaItems(bar.content).map(m => `${m.type}: ${m.originalName ?? m.url.split(/[\\/]/).pop()?.slice(0, 80) ?? ''}`)
      const prompt = getMediaItems(bar.content).map(m => m.made?.prompt).find(Boolean)
      const text = typeof bar.content?.text === 'string' ? bar.content.text : ''
      if (!media.length && !text) return []
      return [{ name: bar.name, ...(text ? { text } : {}), ...(media.length ? { media } : {}), ...(prompt ? { madeWithPrompt: prompt } : {}) }]
    })
  })
  const fg = cardTypeOf(g) === 'faction' ? factionGroupsOf(g) : null
  return {
    id: g.id,
    name: g.name,
    type: cardTypeOf(g),
    header: g.cardHeaderText ?? '',
    text: g.cardText ?? '',
    ...(g.cardSummary ? { summary: g.cardSummary } : {}),
    details: (g.details ?? []).map(d => {
      const shown = detailShown(groups, d)
      return { name: d.name, value: shown.text, ...(shown.card ? { fromCard: shown.card.name } : {}) }
    }),
    ...(g.linkedGroupIds?.length ? { linkedCards: g.linkedGroupIds.map(id => ({ id, name: name(id), type: cardTypeOf(byId.get(id)) })) } : {}),
    ...(fg ? { factionGroups: fg.map(x => ({ title: x.title ?? '', members: x.cards.map(name) })) } : {}),
    ...(g.reportsTo && Object.keys(g.reportsTo).length
      ? { reportsTo: Object.fromEntries(Object.entries(g.reportsTo).map(([m, bosses]) => [name(m), bosses.map(name)])) } : {}),
    ...(g.kin ? { family: {
      parents: Object.fromEntries(Object.entries(g.kin.parents ?? {}).map(([m, ps]) => [name(m), ps.map(name)])),
      partners: (g.kin.partners ?? []).map(([a, b]) => [name(a), name(b)]),
    } } : {}),
    ...(g.scene ? { scene: sceneOutline(g.scene, byId) } : {}),
    ...(g.linkOf ? { showingOf: name(g.linkOf) } : {}),
    ...(blocks.length ? { blocks } : {}),
  }
}

function readCards(args: Json): Json {
  const { groups, boards, selectedGroupIds } = useBoardsStore.getState()
  const ids = Array.isArray(args.ids) && args.ids.length ? args.ids.map(String) : selectedGroupIds
  const missing: string[] = []
  const cards = ids.flatMap(id => {
    const g = groups.find(x => x.id === id)
    if (!g) { missing.push(id); return [] }
    return [describe(g, groups, boards)]
  })
  const first = cards[0] as { id: string; name: string } | undefined
  agentPoint(say(args, !first ? 'Reading' : cards.length > 1 ? `Reading ${cards.length} cards` : `Reading ${first.name}`), first ? agentSpotOfCard(first.id) : undefined)
  return { cards, ...(missing.length ? { notFound: missing } : {}) }
}

// ── Decks ───────────────────────────────────────────────────────────────

/** The decks on the canvas: closed ones (stacked or fanned on their front
 *  card) and open ones (cards lying touching), each with its cards in
 *  order. A card on its own is not a deck. */
function listDecks(args: Json): Json {
  const { groups, boards, selectedGroupIds } = useBoardsStore.getState()
  const zoom = useCanvasStore.getState().zoom
  const q = typeof args.search === 'string' ? args.search.toLowerCase().trim() : ''
  const selected = new Set(selectedGroupIds)
  const brief = (g: ProjectGroup) => ({ id: g.id, name: g.name, type: cardTypeOf(g), ...(g.linkOf ? { linked: true } : {}), ...(selected.has(g.id) ? { selected: true } : {}) })
  // What a closed deck holds, sub-decks and all, nearest first.
  const held = (anchorId: string): ProjectGroup[] => {
    const out: ProjectGroup[] = []
    const walk = (id: string) => {
      for (const m of groups) {
        if (m.id === id || m.deckAnchorId !== id || !isHiddenDeckMember(m) || out.includes(m)) continue
        out.push(m); walk(m.id)
      }
    }
    walk(anchorId)
    return out
  }
  const shown = groups.filter(g => !g.stateOut && !g.pin && !isHiddenDeckMember(g))
  // Open decks: the cards that touch, as the canvas joins them.
  const parent = shown.map((_, i) => i)
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]))
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    if (find(i) !== find(j) && cardsTouch(shown[i], shown[j], boards, zoom)) parent[find(i)] = find(j)
  }
  const rows = new Map<number, ProjectGroup[]>()
  shown.forEach((g, i) => rows.set(find(i), [...(rows.get(find(i)) ?? []), g]))
  const decks: Json[] = []
  for (const row of rows.values()) {
    row.sort((a, b) => Math.abs(a.originY - b.originY) > 40 ? a.originY - b.originY : a.originX - b.originX)
    const cards = row.flatMap(g => {
      const inside = held(g.id)
      return inside.length
        ? [{ ...brief(g), closedDeck: g.deckState === 'fanned' ? 'fanned' : 'stacked', holds: inside.map(brief) }]
        : [brief(g)]
    })
    const all = row.flatMap(g => [g, ...held(g.id)])
    if (all.length < 2) continue
    if (q && !all.some(g => g.name.toLowerCase().includes(q))) continue
    if (args.selectedOnly && !all.some(g => selected.has(g.id))) continue
    const state = row.length === 1 ? (row[0].deckState === 'fanned' ? 'fanned' : 'stacked') : 'open'
    decks.push({ front: row[0].name, frontId: row[0].id, state, count: all.length, cards })
  }
  agentPoint(say(args, 'Looking over the decks'), decks.length === 1 ? agentSpotOfCard(String(decks[0].frontId)) : undefined)
  return { count: decks.length, decks }
}

// ── Media ───────────────────────────────────────────────────────────────

const MAX_INLINE = 40 * 1024 * 1024

/** Where a stored url is kept, for the connector to turn into a file:
 *  a file on disk (`path`), one in the uploads folder (`upload`), a web
 *  address (`url`), or its bytes (`data`, a data: URL) when it lives in
 *  this window's own store. */
async function whereKept(url: string): Promise<Json> {
  if (url.startsWith('/api/file?')) {
    const p = new URL(url, 'http://x').searchParams.get('path')
    return p ? { path: p } : { missing: true }
  }
  if (url.startsWith('/uploads/')) return { upload: decodeURIComponent(url.slice('/uploads/'.length).split('?')[0]) }
  if (/^https?:/i.test(url)) return { url }
  if (isDataUrl(url)) return url.length > MAX_INLINE * 1.4 ? { tooBig: true } : { data: url }
  if (isMediaRef(url)) {
    const blob = await getMedia(mediaRefId(url)!).catch(() => null)
    if (!blob) return { missing: true }
    if (blob.size > MAX_INLINE) return { tooBig: true }
    return { data: await blobToDataUrl(blob) }
  }
  return { missing: true }
}

/** The media on cards, block by block, and where each is kept. With no
 *  ids, the selected cards. */
async function cardMedia(args: Json): Promise<Json> {
  const { groups, boards, selectedGroupIds } = useBoardsStore.getState()
  const ids = Array.isArray(args.ids) && args.ids.length ? args.ids.map(String) : selectedGroupIds
  const kinds = Array.isArray(args.kinds) && args.kinds.length ? new Set(args.kinds.map(String)) : null
  const missing: string[] = []
  const media: Json[] = []
  const firstId = ids.find(id => groups.some(x => x.id === id))
  agentPoint(say(args, 'Picking up media'), firstId ? agentSpotOfCard(firstId) : undefined)
  for (const id of ids) {
    const g = groups.find(x => x.id === id)
    if (!g) { missing.push(id); continue }
    for (const bid of g.boardIds) {
      const b = boards[bid]
      if (!b) continue
      for (const rid of b.rootIds) {
        const bar = b.bars[rid]
        for (const m of bar ? getMediaItems(bar.content) : []) {
          if (kinds && !kinds.has(m.type)) continue
          media.push({
            cardId: g.id, card: g.name, block: bar.name, type: m.type,
            ...(m.originalName ? { name: m.originalName } : {}),
            ...(m.made?.prompt ? { madeWithPrompt: m.made.prompt } : {}),
            kept: await whereKept(m.url),
          })
        }
      }
    }
  }
  return { count: media.length, media, ...(missing.length ? { notFound: missing } : {}) }
}

// ── Dealing ─────────────────────────────────────────────────────────────

interface Box { left: number; right: number; top: number; bottom: number }

/** Everything on the canvas a new deck must keep clear of. */
function obstacles(zoom: number): Box[] {
  const { groups, boards } = useBoardsStore.getState()
  const out: Box[] = []
  for (const g of canvasObstacleGroups(groups, new Set())) {
    const r = cardVisualRect(g, boards, zoom)?.rect
    if (r) out.push(r)
    // A closed deck opens into the row its cards remember.
    for (const m of groups) {
      if (m.deckAnchorId !== g.id || m.id === g.id || m.deckOffsetX == null || m.deckOffsetY == null) continue
      const mr = cardVisualRect(m, boards, zoom)?.rect
      if (!mr) continue
      const dx = g.originX + m.deckOffsetX - m.originX, dy = g.originY + m.deckOffsetY - m.originY
      out.push({ left: mr.left + dx, right: mr.right + dx, top: mr.top + dy, bottom: mr.bottom + dy })
    }
  }
  for (const n of Object.values(useFreeNodeStore.getState().nodes)) {
    if (n.pin) continue
    out.push({ left: n.x, right: n.x + n.width, top: n.y, bottom: n.y + n.height })
  }
  for (const w of Object.values(useViewport3DStore.getState().windows)) {
    out.push({ left: w.x, right: w.x + w.width, top: w.y, bottom: w.y + w.height })
  }
  return out
}

/** Where a row of `n` new cards goes: the empty spot nearest the middle of
 *  the view, far enough from everything that it joins no deck and covers
 *  nothing, with room for the deck to open to the right. Returns the first
 *  card's middle. */
function freeSpot(n: number, face: { w: number; h: number }, zoom: number): { cx: number; cy: number } {
  const mid = viewportCenterInCanvas()
  const obs = obstacles(zoom)
  const margin = face.w * 0.5
  const rowW = face.w * n
  // The header band over a card, and a little under it.
  const box = (cx: number, cy: number): Box => ({
    left: cx - face.w / 2 - margin, right: cx - face.w / 2 + rowW + margin,
    top: cy - face.h / 2 - margin - face.h * 0.25, bottom: cy + face.h / 2 + margin,
  })
  const clear = (b: Box) => !obs.some(o => o.left < b.right && o.right > b.left && o.top < b.bottom && o.bottom > b.top)
  const step = face.h * 0.5
  const R = 60
  const tries: { dx: number; dy: number; d: number }[] = []
  for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) tries.push({ dx: i * step, dy: j * step, d: Math.hypot(i, j) })
  tries.sort((a, b) => a.d - b.d)
  for (const t of tries) {
    if (clear(box(mid.cx + t.dx, mid.cy + t.dy))) return { cx: mid.cx + t.dx, cy: mid.cy + t.dy }
  }
  // Nowhere near: under everything there is.
  const bottom = Math.max(...obs.map(o => o.bottom))
  return { cx: mid.cx, cy: bottom + margin * 2 + face.h }
}

const TYPE_BY_NAME = new Map<string, CardType>(
  (Object.keys(CARD_TYPES) as CardType[]).filter(t => t !== 'area3d' && t !== 'state')
    .flatMap(t => [[t, t], [CARD_TYPES[t].label.toLowerCase(), t]] as [string, CardType][]),
)

const MEDIA_TYPES: MediaType[] = ['image', 'video', 'audio', 'model']

/** The media a dealt card is to hold: only what the connector has put where
 *  the app serves it (a file on disk, or one in the uploads folder). */
function mediaGiven(c: Json): MediaItem[] {
  return (Array.isArray(c.media) ? c.media as Json[] : []).flatMap(m => {
    const url = String(m.url ?? '')
    if (!url.startsWith('/api/file?') && !url.startsWith('/uploads/')) return []
    const type = MEDIA_TYPES.find(t => t === m.type) ?? 'image'
    return [{ url, type, ...(typeof m.name === 'string' && m.name ? { originalName: m.name } : {}) }]
  })
}

/** The top-left of an empty box `w` by `h` (canvas units) nearest the
 *  middle of the view, clear of everything by `margin`. */
function freeBox(w: number, h: number, margin: number): { left: number; top: number } {
  const mid = viewportCenterInCanvas()
  const obs = obstacles(useCanvasStore.getState().zoom)
  const clear = (l: number, t: number) => !obs.some(o => o.left < l + w + margin && o.right > l - margin && o.top < t + h + margin && o.bottom > t - margin)
  const step = Math.max(40, Math.min(w, h) * 0.25)
  const R = 60
  const tries: { dx: number; dy: number; d: number }[] = []
  for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) tries.push({ dx: i * step, dy: j * step, d: Math.hypot(i, j) })
  tries.sort((a, b) => a.d - b.d)
  for (const t of tries) {
    const l = mid.cx - w / 2 + t.dx, tp = mid.cy - h / 2 + t.dy
    if (clear(l, tp)) return { left: l, top: tp }
  }
  const bottom = obs.length ? Math.max(...obs.map(o => o.bottom)) : mid.cy
  return { left: mid.cx - w / 2, top: bottom + margin * 2 }
}

/** Deal cards as one closed deck: new cards, and new linked cards of cards
 *  that are there. One undo step. */
async function dealDeck(args: Json): Promise<Json> {
  const list = Array.isArray(args.cards) ? args.cards as Json[] : []
  if (!list.length) throw new Error('No cards to deal.')
  if (list.length > MAX_DEAL) throw new Error(`A deal is at most ${MAX_DEAL} cards.`)
  // Every card named must be there before anything is made.
  const before = useBoardsStore.getState().groups
  const there = new Set(before.map(g => g.id))
  for (const c of list) {
    if (c.linkTo != null && !there.has(String(c.linkTo))) throw new Error(`No card with id ${String(c.linkTo)} to make a linked card of.`)
    for (const f of Array.isArray(c.from) ? c.from : []) if (!there.has(String(f))) throw new Error(`No card with id ${String(f)} to link back to.`)
  }
  const zoom = useCanvasStore.getState().zoom
  const face = cardFaceSize(zoom)
  const at = freeSpot(list.length, face, zoom)
  // The pointer goes there first: the deal lands where it arrived.
  await agentGlide(say(args, list.length > 1 ? `Dealing ${list.length} cards` : 'Dealing a card'), { x: at.cx - face.w * 0.15, y: at.cy - face.h * 0.1 })

  useUndoCoordinator.getState().checkpoint()
  const made: string[] = []
  let linked = 0
  list.forEach((c, i) => {
    const spot = { cx: at.cx + i * face.w, cy: at.cy }
    if (c.linkTo != null) {
      // A linked card: another showing of its master, dealt here.
      const master = masterOf(useBoardsStore.getState().groups, String(c.linkTo))
      const id = makeLinkedCard(master)
      if (!id) return
      const h = linkedHeight(master, face.w, face.h) ?? face.h
      useBoardsStore.setState(st => ({
        groups: st.groups.map(g => g.id !== id ? g : { ...g, cardWidthOverride: face.w, cardHeightOverride: h, flipped: undefined }),
      }))
      const g = useBoardsStore.getState().groups.find(x => x.id === id)
      const r = g && cardVisualRect(g, useBoardsStore.getState().boards, zoom)?.rect
      if (g && r) {
        useBoardsStore.getState().setGroupPosBatch([{
          groupId: id,
          originX: g.originX + (spot.cx - face.w / 2) - r.left,
          originY: g.originY + (spot.cy + face.h / 2) - r.bottom,
        }])
      }
      made.push(id); linked++
      return
    }
    const name = String(c.name ?? '').trim() || `Card ${i + 1}`
    const header = typeof c.header === 'string' && c.header.trim() ? c.header.trim() : name
    const body = typeof c.text === 'string' ? c.text : ''
    const media = mediaGiven(c)
    let id: string
    if (media.length) {
      const mid = createMediaCard(spot, media.map(m => ({ media: m, label: m.originalName })))
      if (!mid) return
      id = mid
      const st = useBoardsStore.getState()
      st.renameGroup(id, name)
      if (typeof c.header === 'string' && c.header.trim()) st.setGroupCardHeaderText(id, header)
      if (body) st.setGroupCardText(id, body)
    } else {
      id = createTextCard(spot, { title: header, body })
      if (header !== name) useBoardsStore.getState().renameGroup(id, name)
    }
    const bs = useBoardsStore.getState()
    const type = TYPE_BY_NAME.get(String(c.type ?? '').toLowerCase().trim())
    if (type && type !== 'element') bs.setGroupCardType(id, type)
    const given = (Array.isArray(c.details) ? c.details as Json[] : [])
      .map(d => ({ name: String(d.name ?? '').trim(), value: String(d.value ?? '') }))
      .filter(d => d.name)
    if (given.length) {
      // Its type's own rows take the values given for them; the rest are added.
      const rows: CardDetail[] = [...(useBoardsStore.getState().groups.find(g => g.id === id)?.details ?? [])]
      for (const d of given) {
        const k = rows.findIndex(r => r.name.trim().toLowerCase() === d.name.toLowerCase())
        if (k >= 0) rows[k] = { ...rows[k], value: d.value }
        else rows.push({ id: newDetailId(), name: d.name, value: d.value })
      }
      useBoardsStore.getState().setGroupDetails(id, rows)
    }
    // The cards it came from: links held by the NEW card only.
    for (const f of Array.isArray(c.from) ? c.from : []) useBoardsStore.getState().linkGroups(id, String(f))
    made.push(id)
  })
  if (!made.length) throw new Error('Nothing could be dealt.')
  markNew(made)
  if (made.length > 1) {
    useBoardsStore.getState().setDeckState(made, 'stacked', { asGiven: true })
    useBoardsStore.getState().setRowPrimary(made[0], made)
  }
  const what = linked === made.length ? (made.length > 1 ? 'linked cards' : 'linked card')
    : linked ? 'cards (new and linked)' : (made.length > 1 ? 'new cards' : 'new card')
  return {
    dealt: made.length,
    cardIds: made,
    note: made.length > 1
      ? `Dealt ${made.length} ${what} as one closed deck in an empty spot of the view. Nothing else on the canvas was changed. One undo (Ctrl+Z) removes the whole deal.`
      : `Dealt one ${what} in an empty spot of the view. Nothing else on the canvas was changed. One undo (Ctrl+Z) removes it.`,
  }
}

// ── Changing what is there ──────────────────────────────────────────────

const TOUCH_GAP = 8

const idsOf = (v: unknown): string[] => Array.isArray(v) ? [...new Set(v.map(String))] : []

/** The cards `ids` name, or an error naming the ones that are not there. */
function cardsNamed(ids: string[]): ProjectGroup[] {
  const groups = useBoardsStore.getState().groups
  const missing = ids.filter(id => !groups.some(g => g.id === id))
  if (missing.length) throw new Error(`No card with id ${missing.join(', ')}.`)
  if (!ids.length) throw new Error('No cards named.')
  return ids.map(id => groups.find(g => g.id === id)!)
}

const names = (gs: ProjectGroup[]) => gs.length === 1 ? gs[0].name : `${gs.length} cards`

/** Edit cards: name, header, text, type, colour, detail rows. Only what is
 *  given changes. A linked card's edit is its master's too (linkedCards). */
async function editCards(args: Json): Promise<Json> {
  const list = Array.isArray(args.cards) ? args.cards as Json[] : []
  const cards = cardsNamed(list.map(c => String(c.id ?? '')))
  for (const c of list) {
    if (c.type != null && !TYPE_BY_NAME.has(String(c.type).toLowerCase().trim())) throw new Error(`No card type "${String(c.type)}".`)
    if (c.color != null && !/^#[0-9a-f]{6}$/i.test(String(c.color))) throw new Error('A colour is given as #rrggbb.')
  }
  await agentGlide(say(args, `Editing ${names(cards)}`), agentSpotOfCard(cards[0].id))
  useUndoCoordinator.getState().checkpoint()
  for (const c of list) {
    const id = String(c.id)
    const bs = useBoardsStore.getState()
    if (typeof c.name === 'string' && c.name.trim()) bs.renameGroup(id, c.name.trim())
    if (typeof c.header === 'string') bs.setGroupCardHeaderText(id, c.header)
    if (typeof c.text === 'string') bs.setGroupCardText(id, c.text)
    if (c.type != null) bs.setGroupCardType(id, TYPE_BY_NAME.get(String(c.type).toLowerCase().trim())!)
    if (c.color != null) bs.setGroupColor(id, String(c.color))
    const given = (Array.isArray(c.details) ? c.details as Json[] : [])
      .map(d => ({ name: String(d.name ?? '').trim(), value: d.value == null ? null : String(d.value) }))
      .filter(d => d.name)
    if (given.length) {
      // A row named like one it has takes the value (null: the row goes); the rest are added.
      let rows: CardDetail[] = [...(useBoardsStore.getState().groups.find(g => g.id === id)?.details ?? [])]
      for (const d of given) {
        const k = rows.findIndex(r => r.name.trim().toLowerCase() === d.name.toLowerCase())
        if (d.value == null) { if (k >= 0) rows = rows.filter((_, i) => i !== k) }
        else if (k >= 0) rows[k] = { ...rows[k], value: d.value }
        else rows.push({ id: newDetailId(), name: d.name, value: d.value })
      }
      useBoardsStore.getState().setGroupDetails(id, rows)
    }
  }
  return { edited: cards.length, cardIds: cards.map(g => g.id), note: 'One undo (Ctrl+Z) takes the edit back.' }
}

/** Move cards into one touching row (an open deck), in the order given, and
 *  with `close` shut it as a deck on the first. Where: `at` (the row's top-
 *  left, canvas units), right of card `beside`, or an empty spot of the
 *  view. A card inside a closed deck is taken out of it; a closed deck
 *  named by its front card moves whole. */
async function arrangeCards(args: Json): Promise<Json> {
  const ids = idsOf(args.ids)
  const cards = cardsNamed(ids)
  const zoom = useCanvasStore.getState().zoom
  const face = cardFaceSize(zoom)
  const rectOf = (id: string) => {
    const bs = useBoardsStore.getState()
    const g = bs.groups.find(x => x.id === id)
    return (g && cardVisualRect(g, bs.boards, zoom)?.rect) || null
  }
  let left: number, top: number
  const at = args.at as { x?: unknown; y?: unknown } | undefined
  if (at && Number.isFinite(Number(at.x)) && Number.isFinite(Number(at.y))) { left = Number(at.x); top = Number(at.y) }
  else if (args.beside != null) {
    const b = cardsNamed([String(args.beside)])[0]
    const r = rectOf(b.id)
    if (!r) throw new Error(`${b.name} is not laid out on the canvas.`)
    left = r.right + TOUCH_GAP; top = r.top
  } else {
    const spot = freeSpot(ids.length, face, zoom)
    left = spot.cx - face.w / 2; top = spot.cy - face.h / 2
  }
  await agentGlide(say(args, `Moving ${names(cards)}`), { x: left + face.w * 0.35, y: top + face.h * 0.4 })
  useUndoCoordinator.getState().checkpoint()
  let x = left
  for (const id of ids) {
    let g = useBoardsStore.getState().groups.find(o => o.id === id)!
    if (isHiddenDeckMember(g)) {
      // Out of its closed deck, for good (no slot kept for it to go back to).
      useBoardsStore.getState().extractFromDeck(id, g.originX, g.originY)
      useBoardsStore.getState().severDeckTether(id)
      g = useBoardsStore.getState().groups.find(o => o.id === id)!
    }
    const r = rectOf(id)
    if (!r) continue
    const dx = x - r.left, dy = top - r.top
    // A closed deck's cards go with its front card.
    const all = expandWithNestedMembers([id], useBoardsStore.getState().groups)
    const groups = useBoardsStore.getState().groups
    useBoardsStore.getState().setGroupPosBatch(all.flatMap(mid => {
      const m = groups.find(o => o.id === mid)
      return m ? [{ groupId: mid, originX: m.originX + dx, originY: m.originY + dy }] : []
    }))
    x += (r.right - r.left) + TOUCH_GAP
  }
  if (args.close && ids.length > 1) {
    useBoardsStore.getState().setDeckState(ids, 'stacked', { asGiven: true })
    useBoardsStore.getState().setRowPrimary(ids[0], ids)
  }
  // What the row now lies over, so it can be put somewhere clearer.
  const movedSet = new Set(ids.flatMap(id => expandWithNestedMembers([id], useBoardsStore.getState().groups)))
  const row = { left, right: x - TOUCH_GAP, top, bottom: Math.max(...ids.map(id => rectOf(id)?.bottom ?? top)) }
  const over = canvasObstacleGroups(useBoardsStore.getState().groups, movedSet).filter(g => {
    const r = rectOf(g.id)
    return r && r.left < row.right - 1 && r.right > row.left + 1 && r.top < row.bottom - 1 && r.bottom > row.top + 1
  }).map(g => g.name)
  return {
    moved: ids.length, cardIds: ids, place: { x: Math.round(left), y: Math.round(top) },
    ...(args.close && ids.length > 1 ? { closedDeck: true } : {}),
    ...(over.length ? { liesOver: over, warning: 'The row lies over other cards. Undo and choose a clearer place, or leave at and beside out for an empty spot.' } : {}),
    note: 'One undo (Ctrl+Z) takes the move back.',
  }
}

/** Open a closed deck, or close cards as a deck (stacked or fanned). */
async function setDeck(args: Json): Promise<Json> {
  const state = String(args.state ?? '')
  if (state !== 'open' && state !== 'stacked' && state !== 'fanned') throw new Error('state is open, stacked or fanned.')
  const ids = idsOf(args.ids)
  const cards = cardsNamed(ids)
  const groups = useBoardsStore.getState().groups
  // A closed deck named by one of its cards is the whole deck.
  let all = ids
  if (ids.length === 1) {
    let front = cards[0]
    for (let n = 0; n < 20 && isHiddenDeckMember(front); n++) front = groups.find(g => g.id === front.deckAnchorId) ?? front
    all = expandWithNestedMembers([front.id], groups)
    if (all.length < 2) throw new Error(`${cards[0].name} is not in a closed deck. To close cards as a deck, name them all.`)
  }
  await agentGlide(say(args, state === 'open' ? 'Opening a deck' : 'Closing a deck'), agentSpotOfCard(all[0]))
  useUndoCoordinator.getState().checkpoint()
  useBoardsStore.getState().setDeckState(all, state, state === 'open' ? undefined : { asGiven: true })
  return { state, cardIds: all, note: 'One undo (Ctrl+Z) takes it back.' }
}

/** Link card `from` to cards `to` (or with `remove`, unlink them). The link
 *  is held by `from`. */
async function linkCards(args: Json): Promise<Json> {
  const from = cardsNamed([String(args.from ?? '')])[0]
  const to = cardsNamed(idsOf(args.to).filter(id => id !== from.id))
  await agentGlide(say(args, `${args.remove ? 'Unlinking' : 'Linking'} ${from.name}`), agentSpotOfCard(from.id))
  useUndoCoordinator.getState().checkpoint()
  for (const t of to) {
    if (args.remove) useBoardsStore.getState().unlinkGroups(from.id, t.id)
    else useBoardsStore.getState().linkGroups(from.id, t.id)
  }
  return { [args.remove ? 'unlinked' : 'linked']: to.length, from: from.id, note: 'One undo (Ctrl+Z) takes it back.' }
}

/** Delete cards. A closed deck named by its front card goes whole, as the
 *  Delete key does it. */
async function deleteCards(args: Json): Promise<Json> {
  const ids = idsOf(args.ids)
  const cards = cardsNamed(ids)
  const { groups } = useBoardsStore.getState()
  const closed = cards.filter(g => !isHiddenDeckMember(g) && (g.deckState === 'stacked' || g.deckState === 'fanned')).map(g => g.id)
  const doomed = [...new Set([...ids, ...expandWithNestedMembers(closed, groups)])]
  await agentGlide(say(args, `Deleting ${doomed.length === 1 ? cards[0].name : `${doomed.length} cards`}`), agentSpotOfCard(ids[0]))
  useUndoCoordinator.getState().checkpoint()
  const gone: string[] = []
  for (const gid of doomed) {
    const bs = useBoardsStore.getState()
    if (bs.groups.length <= 1) break // the canvas keeps at least one card
    const g = bs.groups.find(gr => gr.id === gid)
    if (!g) continue
    // A card in a closed deck leaves it first, so the deck closes up behind it.
    if (isHiddenDeckMember(g) && !doomed.includes(g.deckAnchorId!)) {
      bs.extractFromDeck(gid, g.originX, g.originY)
      useBoardsStore.getState().severDeckTether(gid)
    }
    g.boardIds.forEach(bid => useBoardsStore.getState().deleteBoard(bid))
    useBoardsStore.getState().deleteGroup(gid)
    gone.push(gid)
  }
  const sel = useBoardsStore.getState().selectedGroupIds.filter(id => !gone.includes(id))
  useBoardsStore.getState().setSelectedGroups(sel)
  return { deleted: gone.length, names: doomed.map(id => groups.find(g => g.id === id)?.name ?? id), note: 'One undo (Ctrl+Z) brings them back.' }
}

/** Select cards, so the artist sees which ones are meant. */
function selectCards(args: Json): Json {
  const ids = idsOf(args.ids)
  const cards = ids.length ? cardsNamed(ids) : []
  useBoardsStore.getState().setSelectedGroups(ids)
  agentPoint(say(args, ids.length ? `Selecting ${names(cards)}` : 'Clearing the selection'), ids.length ? agentSpotOfCard(ids[0]) : undefined)
  return { selected: ids.length }
}

/** Take back the last change on the canvas (the artist's Ctrl+Z). */
function undoLast(args: Json): Json {
  if (!useUndoCoordinator.getState().canUndo) throw new Error('Nothing to undo.')
  agentPoint(say(args, 'Undoing the last change'))
  useUndoCoordinator.getState().undo()
  return { undone: true }
}

// ── The tools on the canvas ─────────────────────────────────────────────

const TOOL_KINDS: Record<string, { kind: Exclude<PlaceKind, 'new'>; label: string }> = {
  viewer: { kind: 'viewer', label: 'Viewer' }, media_pool: { kind: 'pool', label: 'Media Pool' },
  prompt_pad: { kind: 'prompt', label: 'Prompt Pad' }, card_prompts: { kind: 'promptCards', label: 'Card Prompts' },
  history: { kind: 'history', label: 'History' }, card_browser: { kind: 'browser', label: 'Card Browser' },
  attributes: { kind: 'attributes', label: 'Attributes' }, film_look: { kind: 'filmMixer', label: 'Film Look' },
  rough_cut: { kind: 'roughCut', label: 'Rough Cut' }, storyline: { kind: 'storyline', label: 'Storyline' },
  cabinet: { kind: 'cabinet', label: 'Cabinet' }, loop_strip: { kind: 'loopStrip', label: 'Loop strip' },
  set_3d: { kind: 'area', label: '3D set' }, states: { kind: 'stateSpace', label: 'States' },
}

/** Every tool on the canvas (tiles and Viewers), briefly. */
function toolsNow(): { id: string; type: string; place: Json; extra: Json }[] {
  const round = (n: { x: number; y: number; width: number; height: number }) => ({ x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.width), h: Math.round(n.height) })
  const groups = useBoardsStore.getState().groups
  return [
    ...Object.values(useFreeNodeStore.getState().nodes).filter(n => !n.pin).map(n => ({
      id: n.id, type: n.type === 'area' ? '3D set' : n.type, place: round(n),
      extra: {
        ...(n.areaCard ? { card: groups.find(g => g.id === n.areaCard)?.name ?? '', cardId: n.areaCard } : {}),
        ...(n.roughCut ? { clips: n.roughCut.clips.length } : {}),
      },
    })),
    ...Object.values(useViewport3DStore.getState().windows).map(w => ({ id: w.id, type: 'viewer', place: round(w), extra: {} })),
  ]
}

function listTools(args: Json): Json {
  const type = typeof args.type === 'string' ? args.type.toLowerCase() : ''
  const tools = toolsNow().filter(t => !type || t.type.toLowerCase() === type).map(t => ({ id: t.id, type: t.type, ...t.extra, place: t.place }))
  agentPoint(say(args, 'Looking over the tools'))
  return { count: tools.length, tools }
}

/** Set a tool down in an empty spot of the view (or at `at`, its middle). */
async function placeTool(args: Json): Promise<Json> {
  const k = TOOL_KINDS[String(args.tool ?? '')]
  if (!k) throw new Error(`No tool "${String(args.tool)}". Tools: ${Object.keys(TOOL_KINDS).join(', ')}.`)
  const zoom = useCanvasStore.getState().zoom
  const at = args.at as { x?: unknown; y?: unknown } | undefined
  let mid: { cx: number; cy: number }
  if (at && Number.isFinite(Number(at.x)) && Number.isFinite(Number(at.y))) mid = { cx: Number(at.x), cy: Number(at.y) }
  else {
    // An empty spot the size it lands at (a storyline starts as a point: room for a card).
    const fp = placeBox(k.kind, { cx: 0, cy: 0 }, zoom, true)
    const face = cardFaceSize(zoom)
    const w = fp.w || face.w * 2, h = fp.h || face.h
    const b = freeBox(w, h, face.w * 0.4)
    mid = { cx: b.left + w / 2, cy: b.top + h / 2 }
  }
  await agentGlide(say(args, `Setting down a ${k.label}`), { x: mid.cx, y: mid.cy })
  const before = new Set(toolsNow().map(t => t.id))
  useUndoCoordinator.getState().checkpoint()
  placeToolAt(k.kind, mid)
  const made = toolsNow().filter(t => !before.has(t.id))
  if (!made.length) return { placed: k.label, note: 'It was set down (or the one already on the canvas was opened).' }
  return { placed: k.label, tools: made.map(t => ({ id: t.id, type: t.type, ...t.extra, place: t.place })), note: 'One undo (Ctrl+Z) takes it away.' }
}

// ── 3D sets ─────────────────────────────────────────────────────────────

type Stand = { id: string; x?: number; y?: number; height?: number; size?: number; turn?: number; tip?: number; lookAt?: { x: number; y: number; height: number }; mm?: number; focus?: number }

const standsOf = (v: unknown): Stand[] => (Array.isArray(v) ? v as Json[] : []).map(c => ({
  id: String(c.id ?? ''),
  ...(Number.isFinite(Number(c.x)) && c.x != null ? { x: Math.min(1, Math.max(0, Number(c.x))) } : {}),
  ...(Number.isFinite(Number(c.y)) && c.y != null ? { y: Math.min(1, Math.max(0, Number(c.y))) } : {}),
  ...(Number.isFinite(Number(c.height)) && c.height != null ? { height: Math.max(0, Number(c.height)) } : {}),
  ...(Number.isFinite(Number(c.size)) && c.size != null ? { size: Math.min(20, Math.max(0.05, Number(c.size))) } : {}),
  ...(Number.isFinite(Number(c.turn)) && c.turn != null ? { turn: Number(c.turn) } : {}),
  ...(Number.isFinite(Number(c.tip)) && c.tip != null ? { tip: Math.max(-89, Math.min(89, Number(c.tip))) } : {}),
  ...(c.lookAt && typeof c.lookAt === 'object' && Number.isFinite(Number((c.lookAt as Json).x)) && Number.isFinite(Number((c.lookAt as Json).y))
    ? { lookAt: { x: Number((c.lookAt as Json).x), y: Number((c.lookAt as Json).y), height: Number((c.lookAt as Json).height) || 0 } } : {}),
  ...(Number.isFinite(Number(c.mm)) && c.mm != null ? { mm: Math.max(4, Math.min(1200, Number(c.mm))) } : {}),
  ...(Number.isFinite(Number(c.focus)) && c.focus != null ? { focus: Math.max(0.3, Number(c.focus)) } : {}),
}))

/** Stand card `cardId`'s model in 3D set `area`: across (x) and deep (y) as
 *  parts of its ground 0–1, how high off it (as a part of its width), how
 *  big (× its fit) and turned how far (degrees, about upright). */
function standModel(area: { width: number; height: number }, cardId: string, st: Stand, fallback: { x: number; y: number }): void {
  const key = dataKey(`card:${cardId}`)
  const ms = useModelScaleStore.getState()
  const was = ms.placeOf[key]
  const x = st.x ?? (was ? was.dx / area.width : fallback.x)
  const y = st.y ?? (was ? was.dy / area.height : fallback.y)
  ms.setPlace(key, { dx: x * area.width, dy: y * area.height, h: st.height != null ? st.height * area.width : was?.h ?? 0 })
  if (st.size != null) ms.setSetSize(key, st.size)
  if (st.lookAt) {
    // Faces a spot of the ground: from where it stands to there.
    const h = st.height != null ? st.height * area.width : was?.h ?? 0
    const q = lookQuat((st.lookAt.x - x) * area.width, st.lookAt.height * area.width - h, (st.lookAt.y - y) * area.height)
    if (q) ms.setPose(key, q)
  } else if (st.turn != null || st.tip != null) {
    const now = facingOf(ms.poseOf[key] as Quat | undefined)
    const yaw = (st.turn ?? now.turn) * Math.PI / 180, e = (st.tip ?? now.tip) * Math.PI / 180
    const q = lookQuat(Math.sin(yaw) * Math.cos(e), Math.sin(e), Math.cos(yaw) * Math.cos(e))
    if (q) ms.setPose(key, q)
  }
  if (st.mm != null || st.focus != null) ms.setLens(key, { ...(st.mm != null ? { mm: st.mm } : {}), ...(st.focus != null ? { focus: st.focus } : {}) })
}

/** Build a 3D set: a new set with its card, and under it a row of new
 *  LINKED cards of the cards named, their models standing in the set. The
 *  cards named stay where they are. */
async function make3dSet(args: Json): Promise<Json> {
  const stands = standsOf(args.cards)
  const cards = stands.length ? cardsNamed(stands.map(s => s.id)) : []
  const zoom = useCanvasStore.getState().zoom
  const face = cardFaceSize(zoom)
  const fp = freeNodeFootprint('area', zoom)
  const rowW = (face.w + TOUCH_GAP) * (cards.length + 1)
  const w = Math.max(fp.w, rowW), h = fp.h + face.h * 1.6
  const spot = freeBox(w, h, face.w * 0.4)
  await agentGlide(say(args, 'Building a 3D set'), { x: spot.left + fp.w / 2, y: spot.top + fp.h / 2 })

  useUndoCoordinator.getState().checkpoint()
  const before = new Set(Object.keys(useFreeNodeStore.getState().nodes))
  placeToolAt('area', { cx: spot.left + fp.w / 2, cy: spot.top + fp.h / 2 })
  const area = Object.values(useFreeNodeStore.getState().nodes).find(n => !before.has(n.id) && n.type === 'area')
  if (!area) throw new Error('The 3D set could not be made.')
  const setCardId = area.areaCard ?? bundleArea3dCard(area.id)
  if (!setCardId) throw new Error('The 3D set got no card.')
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (name) { useBoardsStore.getState().renameGroup(setCardId, name); useBoardsStore.getState().setGroupCardHeaderText(setCardId, name) }

  const rectOf = (id: string) => {
    const bs = useBoardsStore.getState()
    const g = bs.groups.find(x => x.id === id)
    return (g && cardVisualRect(g, bs.boards, zoom)?.rect) || null
  }
  const first = rectOf(setCardId)
  let x = (first?.right ?? area.x + face.w) + TOUCH_GAP
  const made: { id: string; name: string; of: string; model: boolean }[] = []
  cards.forEach((c, i) => {
    const master = masterOf(useBoardsStore.getState().groups, c.id)
    const id = makeLinkedCard(master)
    if (!id) return
    const lh = linkedHeight(master, face.w, face.h) ?? face.h
    useBoardsStore.setState(st => ({ groups: st.groups.map(g => g.id !== id ? g : { ...g, cardWidthOverride: face.w, cardHeightOverride: lh, flipped: undefined }) }))
    const g = useBoardsStore.getState().groups.find(o => o.id === id)
    const r = rectOf(id)
    if (g && r && first) {
      useBoardsStore.getState().setGroupPosBatch([{ groupId: id, originX: g.originX + (x - r.left), originY: g.originY + (first.top - r.top) }])
      x += (r.right - r.left) + TOUCH_GAP
    }
    const bs = useBoardsStore.getState()
    const model = cardHoldsModel(bs.groups.find(o => o.id === id)!, bs.boards)
    // Never told where: spread across the middle of the ground, left to right.
    if (model) standModel(area, id, stands[i], { x: (i + 1) / (cards.length + 1), y: 0.5 })
    made.push({ id, name: c.name, of: c.id, model })
  })
  markNew([setCardId, ...made.map(m => m.id)])
  const flat = made.filter(m => !m.model).map(m => m.name)
  return {
    setId: area.id, setCardId, place: { x: Math.round(area.x), y: Math.round(area.y), w: Math.round(area.width), h: Math.round(area.height) },
    cards: made,
    ...(flat.length ? { noModel: flat, warning: 'These cards hold no 3D model: they lie with the set as cards, nothing stands in it for them.' } : {}),
    note: 'A new 3D set with its card, and a linked card of each card under it. The cards named were not moved. The artist tilts the view (Alt+drag) to see it in 3D. One undo (Ctrl+Z) takes it all back.',
  }
}

/** Move, lift, size or turn models that stand in a 3D set. */
async function stand3d(args: Json): Promise<Json> {
  const area = useFreeNodeStore.getState().nodes[String(args.setId ?? '')]
  if (!area || area.type !== 'area') throw new Error('No 3D set with that id. list_tools gives them.')
  const stands = standsOf(args.cards)
  const cards = cardsNamed(stands.map(s => s.id))
  const withIt = new Set(rowCards(area).map(g => g.id))
  const out = cards.filter(c => !withIt.has(c.id)).map(c => c.name)
  if (out.length) throw new Error(`Not with that 3D set: ${out.join(', ')}. Use the ids of the linked cards under the set.`)
  await agentGlide(say(args, `Placing ${names(cards)} in the set`), { x: area.x + area.width / 2, y: area.y + area.height / 2 })
  useUndoCoordinator.getState().checkpoint()
  stands.forEach(st => standModel(area, st.id, st, { x: 0.5, y: 0.5 }))
  return { placed: cards.length, note: 'One undo (Ctrl+Z) takes it back.' }
}

// ── GIF, movie, Rough Cut ───────────────────────────────────────────────

/** The cards named with, for a closed deck's front card, every card in it. */
function withHeld(ids: string[]): string[] {
  const groups = useBoardsStore.getState().groups
  return [...new Set(ids.flatMap(id => expandWithNestedMembers([id], groups)))]
}

/** Wait for the GIF or movie being made, a while: what the notice says. */
async function madeOrGoing(job: Promise<void>): Promise<Json> {
  const done = await Promise.race([job.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 12_000))])
  const said = useGifJob.getState().text ?? ''
  return done
    ? { done: true, ...(said ? { said } : {}) }
    : { done: false, note: 'Still being made; VidBars shows its progress at the bottom of the screen, and the new card appears beside the cards when it is done.' }
}

async function makeGifOf(args: Json): Promise<Json> {
  const cards = cardsNamed(idsOf(args.ids))
  if (useGifJob.getState().busy) throw new Error('A GIF or movie is being made already. Wait for it.')
  const ids = withHeld(cards.map(c => c.id))
  const shots = deckGifShots(ids)
  if (!shots.length) throw new Error('There is no movie on those cards: nothing would move in a GIF.')
  agentPoint(say(args, 'Making a GIF'), agentSpotOfCard(cards[0].id))
  return { shots: shots.length, ...await madeOrGoing(makeGif(shots, cards[0].name || 'Deck', ids, !!args.pingPong)) }
}

async function makeMovieOf(args: Json): Promise<Json> {
  const cards = cardsNamed(idsOf(args.ids))
  if (useGifJob.getState().busy) throw new Error('A GIF or movie is being made already. Wait for it.')
  if (!('vidbarsDesktop' in window)) throw new Error('A movie (MP4) is made by the VidBars desktop app; this is a browser window.')
  const ids = withHeld(cards.map(c => c.id))
  const shots = deckGifShots(ids)
  if (!shots.length) throw new Error('There is no movie on those cards.')
  agentPoint(say(args, 'Making a movie'), agentSpotOfCard(cards[0].id))
  return { shots: shots.length, ...await madeOrGoing(makeDeckMovie(shots, cards[0].name || 'Deck', ids)) }
}

/** Add cards' clips to a Rough Cut, end to end after what it has. */
async function addToCut(args: Json): Promise<Json> {
  const node = useFreeNodeStore.getState().nodes[String(args.toolId ?? '')]
  if (!node?.roughCut) throw new Error('No Rough Cut with that id. list_tools gives them; place_tool rough_cut makes one.')
  const cards = cardsNamed(idsOf(args.ids))
  await agentGlide(say(args, `Adding ${names(cards)} to the Rough Cut`), { x: node.x + node.width / 2, y: node.y + node.height / 2 })
  const added = await appendCards(node.id, withHeld(cards.map(c => c.id)))
  if (!added) throw new Error('Those cards hold nothing a Rough Cut can play (a movie, a picture or a sound).')
  return { added, clips: useFreeNodeStore.getState().nodes[node.id]?.roughCut?.clips.length ?? added, note: 'One undo (Ctrl+Z) takes them out again.' }
}

// ── States workspaces ───────────────────────────────────────────────────

/** The node kinds by the names the shelf gives them. */
const STATE_KINDS: Record<string, { kind: SpaceKind; more?: Partial<SpaceItem> }> = {
  state: { kind: 'blank' }, any: { kind: 'any' }, event: { kind: 'event' }, pick_one: { kind: 'pick' },
  value: { kind: 'value' }, and: { kind: 'and' }, or: { kind: 'or' }, is_in: { kind: 'fact' },
  calculate: { kind: 'calc' }, signal: { kind: 'gen', more: { shape: 'wave' } }, switch: { kind: 'switch' },
  selector: { kind: 'dial', more: { opts: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }] } },
  counter: { kind: 'count' }, timer: { kind: 'timer' }, dice: { kind: 'dice' }, meter: { kind: 'meter' },
  send: { kind: 'send', more: { name: 'A' } }, receive: { kind: 'recv', more: { name: 'A' } }, wait: { kind: 'wait' },
  choose: { kind: 'choice', more: { opts: [{ id: 'a', name: 'Yes' }, { id: 'b', name: 'No' }] } },
  show_hide: { kind: 'act' }, path: { kind: 'path' }, world_clock: { kind: 'timeline', more: { world: true } },
  timeline: { kind: 'timeline' }, workspace: { kind: 'space' },
}
const kindName = (i: SpaceItem): string => i.kind === 'card' || i.kind === 'blank' ? 'state'
  : i.kind === 'timeline' ? (i.world ? 'world_clock' : 'timeline')
  : Object.entries(STATE_KINDS).find(([, v]) => v.kind === i.kind)?.[0] ?? i.kind

const CALC_OPS: Record<string, CalcOp> = {
  plus: 'add', minus: 'sub', times: 'mul', divided_by: 'div', smallest: 'min', largest: 'max', average: 'avg',
  greater_than: 'gt', less_than: 'lt', at_least: 'ge', at_most: 'le', equal_to: 'eq', not_equal_to: 'ne',
}
const SHAPES: Record<string, GenShape> = { pulse: 'pulse', sine: 'wave', square: 'square', saw: 'ramp', triangle: 'tri', noise: 'noise' }
const COMPARES: Compare[] = ['<', '<=', '=', '!=', '>=', '>']

function spaceNamed(v: unknown): { nodeId: string; d: StateSpaceData } {
  const nodeId = String(v ?? '')
  const d = spaceOf(nodeId)
  if (!d) throw new Error('No States workspace with that id. list_tools gives them; place_tool states makes one.')
  return { nodeId, d }
}

const num = (v: unknown): number | undefined => v != null && Number.isFinite(Number(v)) ? Number(v) : undefined

/** What an agent may set on a node, as the fields the workspace keeps. */
function itemPatch(c: Json, kind: SpaceKind): Partial<SpaceItem> {
  const p: Partial<SpaceItem> = {}
  if (typeof c.name === 'string') p.name = c.name
  if (typeof c.note === 'string') p.note = c.note
  if (c.card != null) {
    const g = cardsNamed([String(c.card)])[0]
    p.card = g.id
  }
  const v = num(c.value)
  if (v !== undefined) { p.val = v; p.init = v }
  if (typeof c.value === 'boolean') { p.val = c.value ? 1 : 0; p.init = p.val; p.flag = true }
  if (typeof c.yesNo === 'boolean') p.flag = c.yesNo || undefined
  if (num(c.n) !== undefined) p.n = num(c.n)
  if (num(c.low) !== undefined) p.lo = num(c.low)
  if (num(c.high) !== undefined) p.hi = num(c.high)
  if (typeof c.wrap === 'boolean') p.wrap = c.wrap || undefined
  if (c.op != null) {
    const op = CALC_OPS[String(c.op)]
    if (!op) throw new Error(`No calculation "${String(c.op)}". One of: ${Object.keys(CALC_OPS).join(', ')}.`)
    p.calc = op
  }
  if (c.shape != null) {
    const sh = SHAPES[String(c.shape)]
    if (!sh) throw new Error(`No signal shape "${String(c.shape)}". One of: ${Object.keys(SHAPES).join(', ')}.`)
    p.shape = sh
  }
  if (Array.isArray(c.options) && (kind === 'choice' || kind === 'dial')) {
    p.opts = c.options.map((o, i) => ({ id: String.fromCharCode(97 + (i % 26)) + (i >= 26 ? i : ''), name: String(o) }))
  }
  if (c.do === 'hide' || c.do === 'show') p.do = c.do
  if (typeof c.line === 'string') p.line = c.line
  if (typeof c.curve === 'string') p.curve = c.curve
  if (typeof c.space === 'string') p.space = c.space
  if (typeof c.start === 'boolean') p.start = c.start || undefined
  return p
}

/** What an agent may set on a wire. */
function wirePatch(c: Json): Partial<SpaceWire> {
  const p: Partial<SpaceWire> = {}
  if (typeof c.name === 'string') p.name = c.name
  if (typeof c.note === 'string') p.note = c.note
  if (c.compare != null) {
    if (!COMPARES.includes(c.compare as Compare)) throw new Error(`compare is one of ${COMPARES.join(' ')}.`)
    p.cmp = c.compare as Compare
    p.cn = num(c.number) ?? 0
  }
  if (typeof c.not === 'boolean') p.not = c.not || undefined
  if (typeof c.plain === 'boolean') p.plain = c.plain || undefined
  if (c.does === 'add' || c.does === 'set') { p.op = c.does; p.on = num(c.by) ?? (c.does === 'add' ? 1 : 0) }
  return p
}

/** A workspace, read: every node with its ports and how it stands, every wire. */
function readStates(args: Json): Json {
  const { nodeId, d } = spaceNamed(args.toolId)
  const groups = useBoardsStore.getState().groups
  const lit = spaceTruths(nodeId), nums = spaceNumbers(nodeId)
  const plane = planeBox(nodeId)
  const nodes = d.items.map(i => {
    const ports = itemPorts(i)
    return {
      id: i.id, kind: kindName(i),
      name: i.name ?? (i.card ? groups.find(g => g.id === i.card)?.name : undefined) ?? '',
      ...(i.card ? { cardId: i.card } : {}),
      ...(i.note ? { note: i.note } : {}),
      x: Math.round(i.x), y: Math.round(i.y),
      ...(i.start ? { start: true } : {}),
      ...(i.now ? { lit: true } : {}),
      ...(lit.has(i.id) ? { true: true } : {}),
      ...(nums.has(i.id) ? { number: nums.get(i.id) } : i.kind === 'value' ? { number: i.val ?? i.init ?? 0 } : {}),
      ...(i.opts ? { options: i.opts.map(o => ({ id: o.id, name: o.name })) } : {}),
      ...(i.kind === 'choice' && i.asking ? { asking: true } : {}),
      ...(i.kind === 'choice' && i.chose ? { answered: i.chose } : {}),
      in: ports.filter(q => !q.out).map(q => q.port), out: ports.filter(q => q.out).map(q => q.port),
    }
  })
  const wires = d.wires.map(w => ({
    id: w.id, kind: wireKind(d, w), from: w.a, ...(w.ap ? { fromPort: w.ap } : {}),
    ...(w.bp === 'knob' ? { toWire: w.b } : { to: w.b, toPort: w.bp ?? 'in' }),
    ...(w.name ? { name: w.name } : {}), ...(w.cmp ? { compare: w.cmp, number: w.cn ?? 0 } : {}), ...(w.not ? { not: true } : {}),
    ...(w.op ? { does: w.op, by: w.on } : {}),
  }))
  agentPoint(say(args, 'Reading the states'), plane ? { x: plane.x + plane.w * plane.k * 0.3, y: plane.y + plane.h * plane.k * 0.3 } : undefined)
  return {
    ...(plane ? { ground: { w: Math.round(plane.w), h: Math.round(plane.h) } } : {}),
    nodes, wires,
    wireKinds: 'change: state to state, an arrow (made by hand, or by a wire onto it: toWire). hold: a condition into a state keeps it lit while true. cond: a condition read all the time. signal: something that happens, sent once. link: a plain line.',
  }
}

/** A free middle for a new node: left to right in rows, clear of what is there. */
function freeNodeSpot(d: StateSpaceData, taken: { x: number; y: number }[], ground: { w: number; h: number }): { x: number; y: number } {
  const all = [...d.items.map(i => ({ x: i.x, y: i.y, ...itemSize(i) })), ...taken.map(t => ({ ...t, w: 130, h: 104 }))]
  for (let y = 110; y < Math.max(ground.h, 400) + 2000; y += 150) {
    for (let x = 120; x < Math.max(ground.w, 600) - 90; x += 190) {
      if (!all.some(o => Math.abs(o.x - x) < o.w / 2 + 85 && Math.abs(o.y - y) < o.h / 2 + 70)) return { x, y }
    }
  }
  return { x: 120, y: 110 }
}

/** A canvas spot on a workspace's ground, for the pointer. */
function groundSpot(nodeId: string, x: number, y: number): { x: number; y: number } | undefined {
  const pl = planeBox(nodeId)
  return pl ? { x: pl.x + x * pl.k, y: pl.y + y * pl.k } : undefined
}

/** Add nodes and wires to a workspace. One undo. */
async function buildStates(args: Json): Promise<Json> {
  const { nodeId, d } = spaceNamed(args.toolId)
  const nodeSpecs = Array.isArray(args.nodes) ? args.nodes as Json[] : []
  const wireSpecs = Array.isArray(args.wires) ? args.wires as Json[] : []
  if (!nodeSpecs.length && !wireSpecs.length) throw new Error('Nothing to add: give nodes, wires or both.')
  // Everything is checked before anything is made.
  const plan = nodeSpecs.map((c, i) => {
    const k = STATE_KINDS[String(c.kind ?? 'state')]
    if (!k) throw new Error(`No node kind "${String(c.kind)}". One of: ${Object.keys(STATE_KINDS).join(', ')}.`)
    const p = itemPatch(c, k.kind)
    let kind = k.kind
    if (kind === 'blank' && p.card) kind = 'card'
    if (kind === 'timeline' && !k.more?.world && !p.line) throw new Error('A timeline node needs line: a storyline\'s id (list_tools).')
    return { ref: typeof c.ref === 'string' && c.ref ? c.ref : `n${i + 1}`, kind, more: k.more, p, x: num(c.x), y: num(c.y) }
  })
  const ground = planeBox(nodeId) ?? { w: 930, h: 698 }
  await agentGlide(say(args, 'Wiring up the states'), groundSpot(nodeId, 200, 150) ?? null)
  useUndoCoordinator.getState().checkpoint()

  const ids: Record<string, string> = {}
  const taken: { x: number; y: number }[] = []
  for (const n of plan) {
    const at = n.x !== undefined && n.y !== undefined ? { x: n.x, y: n.y } : freeNodeSpot(spaceOf(nodeId) ?? d, taken, ground)
    taken.push(at)
    ids[n.ref] = addItem(nodeId, { kind: n.kind, ...n.more, ...n.p, x: Math.round(at.x / 10) * 10, y: Math.round(at.y / 10) * 10 }, false)
  }
  const wireIds: Record<string, string> = {}
  const failed: Json[] = []
  wireSpecs.forEach((c, i) => {
    const now = spaceOf(nodeId)!
    const end = (v: unknown) => { const k = String(v ?? ''); return ids[k] ?? k }
    const from = { node: end(c.from), port: typeof c.fromPort === 'string' ? c.fromPort : 'out' }
    const to = c.toWire != null
      ? { wire: wireIds[String(c.toWire)] ?? String(c.toWire), port: 'knob' }
      : { node: end(c.to), port: typeof c.toPort === 'string' ? c.toPort : 'in' }
    const label = `${String(c.from)} → ${c.toWire != null ? 'wire ' + String(c.toWire) : String(c.to)}`
    if (!canWire(now, from, to)) {
      const a = now.items.find(x => x.id === from.node), b = now.items.find(x => x.id === to.node)
      failed.push({
        wire: label,
        why: !a ? 'No node to wire from.' : !('wire' in to) && !b ? 'No node to wire to.' : 'Those two ports cannot be wired.',
        ...(a ? { fromHasOut: itemPorts(a).filter(q => q.out).map(q => q.port) } : {}),
        ...(b ? { toHasIn: itemPorts(b).filter(q => !q.out).map(q => q.port) } : {}),
      })
      return
    }
    const id = addWire(nodeId, from, to, false)
    if (!id) { failed.push({ wire: label, why: 'It could not be wired.' }); return }
    const p = wirePatch(c)
    if (Object.keys(p).length) patchWire(nodeId, id, p, false)
    wireIds[typeof c.ref === 'string' && c.ref ? c.ref : `w${i + 1}`] = id
  })
  return {
    nodes: ids, wires: wireIds,
    ...(failed.length ? { notWired: failed } : {}),
    note: 'One undo (Ctrl+Z) takes all of it back. read_states shows how it stands now.',
  }
}

/** Change, move or take out nodes and wires of a workspace. One undo. */
async function editStates(args: Json): Promise<Json> {
  const { nodeId, d } = spaceNamed(args.toolId)
  const nodeSpecs = Array.isArray(args.nodes) ? args.nodes as Json[] : []
  const wireSpecs = Array.isArray(args.wires) ? args.wires as Json[] : []
  const remove = idsOf(args.remove)
  const known = new Set([...d.items.map(i => i.id), ...d.wires.map(w => w.id)])
  const missing = [...nodeSpecs.map(c => String(c.id ?? '')), ...wireSpecs.map(c => String(c.id ?? '')), ...remove].filter(id => !known.has(id))
  if (missing.length) throw new Error(`Not in that workspace: ${missing.join(', ')}.`)
  if (!nodeSpecs.length && !wireSpecs.length && !remove.length) throw new Error('Nothing to change.')
  const nodePatches = nodeSpecs.map(c => {
    const it = d.items.find(i => i.id === String(c.id))
    if (!it) throw new Error(`${String(c.id)} is a wire: give it under wires.`)
    const p = itemPatch(c, it.kind)
    if (p.card && it.kind === 'blank') p.kind = 'card'
    const x = num(c.x), y = num(c.y)
    if (x !== undefined) p.x = Math.round(x / 10) * 10
    if (y !== undefined) p.y = Math.round(y / 10) * 10
    return { id: it.id, p }
  })
  const wirePatches = wireSpecs.map(c => ({ id: String(c.id), p: wirePatch(c) }))
  const first = d.items.find(i => i.id === (nodeSpecs[0]?.id ?? remove[0]))
  await agentGlide(say(args, 'Changing the states'), (first && groundSpot(nodeId, first.x, first.y)) ?? null)
  // (Taking out is its own step in the workspace: with other changes in the same request, a second undo.)
  if (nodePatches.length || wirePatches.length) useUndoCoordinator.getState().checkpoint()
  for (const n of nodePatches) patchItem(nodeId, n.id, n.p, false)
  for (const w of wirePatches) if (Object.keys(w.p).length) patchWire(nodeId, w.id, w.p, false)
  if (remove.length) removeFromSpace(nodeId, remove)
  return { changed: nodePatches.length + wirePatches.length, removed: remove.length, note: remove.length && (nodePatches.length || wirePatches.length) ? 'Undo (Ctrl+Z) twice takes it all back: once for what was taken out, once for the rest.' : 'One undo (Ctrl+Z) takes it back.' }
}

/** Work a workspace by hand, as a click on it does. */
async function runStates(args: Json): Promise<Json> {
  const { nodeId, d } = spaceNamed(args.toolId)
  const it = d.items.find(i => i.id === String(args.id ?? ''))
  if (!it) throw new Error('No node with that id in that workspace.')
  const act = String(args.do ?? '')
  await agentGlide(say(args, 'Working the states'), groundSpot(nodeId, it.x, it.y) ?? null)
  if (act === 'light' || act === 'unlight') {
    if (it.kind !== 'card' && it.kind !== 'blank') throw new Error('Only a state can be lit.')
    setNow(nodeId, it.id, act === 'light')
  } else if (act === 'fire') {
    if (it.kind !== 'event' && it.kind !== 'wait' && it.kind !== 'pick' && it.kind !== 'gen') throw new Error('Only an event, a wait, a pick one or a signal can be fired.')
    fireEvent(nodeId, it.id)
  } else if (act === 'set') {
    const v = typeof args.value === 'boolean' ? (args.value ? 1 : 0) : num(args.value)
    if (v === undefined) throw new Error('set needs value: a number, or true / false.')
    setValue(nodeId, it.id, v)
  } else if (act === 'poke') {
    const port = typeof args.port === 'string' ? args.port : 'in'
    if (!itemPorts(it).some(q => !q.out && q.port === port)) throw new Error(`That node has no input "${port}". It has: ${itemPorts(it).filter(q => !q.out).map(q => q.port).join(', ')}.`)
    poke(nodeId, it.id, port)
  } else if (act === 'answer') {
    if (it.kind !== 'choice') throw new Error('Only a choose can be answered.')
    const want = String(args.option ?? '').trim()
    const opt = it.opts?.find(o => o.id === want || o.id === want.replace(/^opt:/, '')) ?? it.opts?.find(o => (o.name ?? '').toLowerCase() === want.toLowerCase())
    if (!opt) throw new Error(`answer needs option: one of ${(it.opts ?? []).map(o => `${o.id} (${o.name})`).join(', ')}.`)
    choose(nodeId, it.id, opt.id)
  } else throw new Error('do is one of: light, unlight, fire, set, poke, answer.')
  const lit = spaceTruths(nodeId), nums = spaceNumbers(nodeId)
  const now = spaceOf(nodeId)!
  const groups = useBoardsStore.getState().groups
  return {
    done: act,
    litNow: now.items.filter(i => i.now).map(i => ({ id: i.id, name: i.name ?? groups.find(g => g.id === i.card)?.name ?? '' })),
    trueNow: now.items.filter(i => lit.has(i.id)).map(i => ({ id: i.id, kind: kindName(i), name: i.name ?? '' })),
    asking: now.items.filter(i => i.kind === 'choice' && i.asking).map(i => ({ id: i.id, name: i.name ?? '', options: (i.opts ?? []).map(o => ({ id: o.id, name: o.name })) })),
    numbers: Object.fromEntries([
      ...now.items.filter(i => i.kind === 'value').map(i => [i.id, i.val ?? i.init ?? 0] as [string, number]),
      ...[...nums].filter(([id]) => now.items.some(i => i.id === id)),
    ]),
    note: 'One undo (Ctrl+Z) takes it back.',
  }
}

// ── Storylines: dots joined by lines ────────────────────────────────────

function storyNamed(v: unknown): { nodeId: string; x: number; y: number; d: StorylineData } {
  const n = useFreeNodeStore.getState().nodes[String(v ?? '')]
  if (!n?.storyline) throw new Error('No storyline with that id. list_tools gives them; build_storyline without toolId makes one.')
  return { nodeId: n.id, x: n.x, y: n.y, d: migrateStoryline(n.storyline) }
}

function writeStory(nodeId: string, x: number, y: number, d: StorylineData): void {
  useFreeNodeStore.getState().updateFreeNode(nodeId, normalizeStoryline(x, y, sortBase(d)))
}

/** A storyline, read: its dots where they are on the canvas, what joins them, the cards on them. */
function readStoryline(args: Json): Json {
  const { nodeId, x, y, d } = storyNamed(args.toolId)
  const groups = useBoardsStore.getState().groups
  const base = d.base ?? []
  const start = d.dots.find(p => p.id === base[0])
  const dots = d.dots.map(p => ({
    id: p.id, title: p.title, x: Math.round(x + p.x), y: Math.round(y + p.y),
    ...(base.includes(p.id) ? { onBase: base.indexOf(p.id) + 1 } : {}),
    joined: neighbours(d, p.id),
    ...(p.cards?.length ? { cards: p.cards.map(c => ({ id: c, name: groups.find(g => g.id === c)?.name ?? '' })) } : {}),
    ...(p.changes?.length ? { changes: p.changes.length } : {}),
  }))
  agentPoint(say(args, 'Reading the storyline'), { x: x + (start?.x ?? 0), y: y + (start?.y ?? 0) })
  return {
    toolId: nodeId, title: d.title ?? '', description: d.description ?? '',
    ...(d.color ? { color: d.color } : {}), standsUp: !!d.standUp,
    ...(start && d.marker != null ? { marker: d.marker < 0 ? 'before the start' : Math.round(x + start.x + d.marker) } : {}),
    dots,
    note: 'The base is the straight line its dots sit on, left to right (onBase 1 is the start). Everything else is a branch off it.',
  }
}

/** Dots and lines added to a storyline (or a new one), all in one undo. */
async function buildStoryline(args: Json): Promise<Json> {
  const want = Array.isArray(args.dots) ? (args.dots as Json[]) : []
  if (want.length > 80) throw new Error('At most 80 dots at once.')
  for (const w of want) if (idsOf(w.cards).length) cardsNamed(idsOf(w.cards))
  const zoom = useCanvasStore.getState().zoom
  const face = cardFaceSize(zoom)
  const SP = Math.round(face.w * 1.6), RISE = Math.round(face.h * 1.15)
  const fresh = args.toolId == null
  let nodeId: string, x: number, y: number, d: StorylineData
  if (fresh) {
    if (!want.length) throw new Error('Give the dots of the new storyline.')
    const onBase = Math.max(1, want.filter(w => w.from == null).length)
    const at = args.at as { x?: unknown; y?: unknown } | undefined
    if (at && num(at.x) != null && num(at.y) != null) { x = num(at.x)!; y = num(at.y)! }
    else {
      const w = SP * onBase, h = RISE * 3 + face.h
      const b = freeBox(w, h, face.w * 0.4)
      x = b.left; y = b.top + h / 2
    }
    d = newStoryline()
    nodeId = ''
  } else ({ nodeId, x, y, d } = storyNamed(args.toolId))
  await agentGlide(say(args, fresh ? 'Drawing a storyline' : 'Adding to the storyline'), { x: x + (d.dots[0]?.x ?? 0), y: y + (d.dots[0]?.y ?? 0) })

  const dots: StoryDot[] = d.dots.map(p => ({ ...p }))
  const edges = [...d.edges]
  let base = [...(d.base ?? [])]
  const byId = () => new Map(dots.map(p => [p.id, p]))
  const refs: Record<string, string> = {}
  const made: Record<string, string> = {}
  const baseY = () => byId().get(base[0])?.y ?? 0
  // A new storyline's one dot is its first.
  let spare = fresh ? dots[0] : undefined
  let n = 0
  for (const w of want) {
    const ref = typeof w.ref === 'string' && w.ref ? w.ref : `dot${++n}`
    const title = typeof w.title === 'string' ? w.title : ''
    const cards = idsOf(w.cards)
    const ax = num(w.x), ay = num(w.y)
    let dot: StoryDot
    if (w.from == null) {
      // The next dot along the base.
      if (spare) { dot = spare; spare = undefined; dot.title = title }
      else {
        const last = byId().get(base[base.length - 1])
        dot = { id: crypto.randomUUID(), x: ax != null ? ax - x : (last ? Math.max(...base.map(b => byId().get(b)?.x ?? 0)) + SP : 0), y: baseY(), title }
        dots.push(dot)
        if (last) edges.push({ a: last.id, b: dot.id })
        base.push(dot.id)
      }
    } else {
      const fromId = refs[String(w.from)] ?? String(w.from)
      const from = byId().get(fromId)
      if (!from) throw new Error(`Dot "${String(w.from)}" (from) is not there. Use a ref given earlier in this request, or a dot's id from read_storyline.`)
      const kids = neighbours({ ...d, dots, edges }, fromId).filter(k => !base.includes(k))
      let px: number, py: number
      if (base.includes(fromId)) {
        const k = kids.length
        px = from.x + SP * 0.5; py = from.y + (k % 2 ? 1 : -1) * RISE * (1 + Math.floor(k / 2))
      } else {
        const k = Math.max(0, kids.length - 1)
        const dir = from.y > baseY() ? 1 : -1
        px = from.x + SP; py = from.y + dir * RISE * k
      }
      // Clear of the dots that are there: further out, the same side.
      const side = py < baseY() ? -1 : 1
      while (ax == null && ay == null && dots.some(q => Math.abs(q.x - px) < SP * 0.45 && Math.abs(q.y - py) < RISE * 0.45)) py += side * RISE
      dot = { id: crypto.randomUUID(), x: ax != null ? ax - x : px, y: ay != null ? ay - y : py, title }
      dots.push(dot)
      edges.push({ a: fromId, b: dot.id })
    }
    if (cards.length) dot.cards = [...new Set([...(dot.cards ?? []), ...cards])]
    refs[ref] = dot.id
    made[ref] = dot.id
  }
  if (!base.length && dots.length) base = [dots[0].id]
  const next: StorylineData = {
    ...d, dots, edges, base,
    ...(typeof args.title === 'string' ? { title: args.title } : {}),
    ...(typeof args.description === 'string' ? { description: args.description } : {}),
  }
  useUndoCoordinator.getState().checkpoint()
  if (fresh) nodeId = useFreeNodeStore.getState().addFreeNode(0, 0, 'storyline')
  writeStory(nodeId, x, y, next)
  const now = useFreeNodeStore.getState().nodes[nodeId]
  return {
    toolId: nodeId, dots: made,
    place: { x: Math.round(now.x), y: Math.round(now.y), w: Math.round(now.width), h: Math.round(now.height) },
    note: 'One undo (Ctrl+Z) takes it back. Cards put on a dot stay where they are and go with the dot when the artist drags it.',
  }
}

/** A storyline changed: its label and look, its dots, lines between dots, dots taken out; one undo. */
async function editStoryline(args: Json): Promise<Json> {
  const { nodeId, x, y, d } = storyNamed(args.toolId)
  const patches = Array.isArray(args.dots) ? (args.dots as Json[]) : []
  const has = (id: string) => d.dots.some(p => p.id === id)
  for (const c of patches) {
    if (!has(String(c.id))) throw new Error(`No dot with id ${String(c.id)} (read_storyline gives them).`)
    if (idsOf(c.cards).length) cardsNamed(idsOf(c.cards))
  }
  const join = (Array.isArray(args.join) ? args.join as Json[] : []).map(j => ({ a: String(j.a), b: String(j.b) }))
  const unjoin = (Array.isArray(args.unjoin) ? args.unjoin as Json[] : []).map(j => ({ a: String(j.a), b: String(j.b) }))
  for (const j of [...join, ...unjoin]) if (!has(j.a) || !has(j.b) || j.a === j.b) throw new Error('join and unjoin take two different dots of this storyline, { a, b }.')
  const remove = idsOf(args.remove), removeBranches = idsOf(args.removeBranchFrom)
  for (const id of [...remove, ...removeBranches]) if (!has(id)) throw new Error(`No dot with id ${id}.`)
  const start = d.dots.find(p => p.id === d.base?.[0])
  await agentGlide(say(args, 'Changing the storyline'), { x: x + (start?.x ?? 0), y: y + (start?.y ?? 0) })

  const base = d.base ?? []
  let next: StorylineData = { ...d, dots: d.dots.map(p => {
    const c = patches.find(q => String(q.id) === p.id)
    if (!c) return p
    const q: StoryDot = { ...p }
    if (typeof c.title === 'string') q.title = c.title
    if (num(c.x) != null) q.x = num(c.x)! - x
    // A base dot stays on the base line.
    if (num(c.y) != null && !base.includes(p.id)) q.y = num(c.y)! - y
    if (c.cards != null) { const ids = idsOf(c.cards); q.cards = ids.length ? ids : undefined }
    return q
  }) }
  const same = (e: { a: string; b: string }, j: { a: string; b: string }) => (e.a === j.a && e.b === j.b) || (e.a === j.b && e.b === j.a)
  if (unjoin.length) next = { ...next, edges: next.edges.filter(e => !unjoin.some(j => same(e, j))) }
  for (const j of join) if (!next.edges.some(e => same(e, j))) next = { ...next, edges: [...next.edges, j] }
  for (const id of removeBranches) if (next.dots.some(p => p.id === id)) next = deleteBranchFrom(next, id)
  for (const id of remove) if (next.dots.some(p => p.id === id)) next = deleteDot(next, id)
  if (typeof args.title === 'string') next = { ...next, title: args.title }
  if (typeof args.description === 'string') next = { ...next, description: args.description }
  if (typeof args.color === 'string') next = { ...next, color: args.color || undefined }
  if (typeof args.standUp === 'boolean') next = { ...next, standUp: args.standUp || undefined }
  if (typeof args.snap === 'boolean') next = { ...next, snap: args.snap ? undefined : false }

  useUndoCoordinator.getState().checkpoint()
  if (!next.dots.length) {
    useFreeNodeStore.getState().deleteFreeNode(nodeId)
    return { removed: true, note: 'Nothing was left of it, so the storyline is gone. One undo (Ctrl+Z) brings it back.' }
  }
  writeStory(nodeId, x, y, next)
  if (args.markerAt != null) {
    const now = useFreeNodeStore.getState().nodes[nodeId]
    const sd = now.storyline!
    const s0 = sd.dots.find(p => p.id === sd.base?.[0])
    const at = args.markerAt === 'start' ? undefined : sd.dots.find(p => p.id === String(args.markerAt))
    if (args.markerAt !== 'start' && !at) throw new Error(`markerAt is a dot's id, or "start" (before anything has happened).`)
    const { scrubStoryline } = await import('../components/Canvas/StorylineLayer')
    scrubStoryline(nodeId, at && s0 ? at.x - s0.x : -1e9)
  }
  return { ...readStoryline({ toolId: nodeId, doing: say(args, 'Changing the storyline') }), note: 'One undo (Ctrl+Z) takes it back.' }
}

// ── Scene cards: a face of sections ─────────────────────────────────────

const SCENE_COLORS = ['#5b8dd9', '#1f9ea6', '#6fa6a8', '#f2994a', '#8b6fd6', '#4fae6b']

function sceneNamed(v: unknown): { g: ProjectGroup; scene: SceneDiv } {
  const g = useBoardsStore.getState().groups.find(x => x.id === String(v ?? ''))
  if (!g) throw new Error(`No card with id ${String(v)}.`)
  if (!g.scene) throw new Error(`"${g.name}" is not a scene card. Make one with deal_deck (type scene), or give a card the type scene with edit_cards.`)
  return { g, scene: g.scene }
}

/** A scene's face, in full: every split and section with its id. */
function sceneTree(d: SceneDiv, byId: Map<string, ProjectGroup>): Json {
  const named = (id: string) => ({ id, name: byId.get(id)?.name ?? '' })
  if (!isLeaf(d)) {
    const n = d.kids!.length
    return {
      id: d.id, split: d.dir === 'col' ? 'stacked' : 'side_by_side',
      sizes: (d.sizes ?? d.kids!.map(() => 1 / n)).map(x => Math.round(x * 1000) / 1000),
      ...(canFold(d) ? { headed: true } : {}), ...(d.fold ? { folded: true } : {}),
      parts: d.kids!.map(k => sceneTree(k, byId)),
    }
  }
  const card = d.card ?? d.cards?.[0]
  return {
    id: d.id, name: d.name ?? '',
    ...(d.notes ? { notes: d.notes } : {}), ...(d.color ? { color: d.color } : {}),
    ...(d.image ? { picture: true } : {}),
    ...(card ? { card: named(card) } : {}),
    ...(d.deck?.length ? { deck: d.deck.map(named) } : {}),
    ...(d.hand ? { handsDown: true } : {}),
    ...(d.links?.length ? { links: d.links.map(named) } : {}),
    ...(d.live ? { live: true } : {}), ...(d.bump ? { bump: true } : {}), ...(d.tab ? { tab: true } : {}),
    ...(d.opens ? { opensScene: named(d.opens) } : {}),
  }
}

function readScene(args: Json): Json {
  const { g, scene } = sceneNamed(args.cardId)
  const byId = new Map(useBoardsStore.getState().groups.map(x => [x.id, x]))
  agentPoint(say(args, 'Reading the scene'), agentSpotOfCard(g.id))
  return {
    cardId: g.id, name: g.name, face: sceneTree(scene, byId),
    note: 'A split holds parts side by side or stacked, each with its share (sizes). A stacked split whose first part is a section is headed: that first part is its heading, and cards put on a heading are handed down to the sections under it.',
  }
}

/** A face from an outline: { split, sizes, parts } or { name, notes, color }. Cards and links wait in `after`. */
function sceneFromOutline(o: Json, turn: { n: number }, after: { id: string; cards: string[]; links: string[] }[], refs: Record<string, string>): SceneDiv {
  const parts = Array.isArray(o.parts) ? (o.parts as Json[]) : []
  if (parts.length) {
    const kids = parts.map(q => sceneFromOutline(q, turn, after, refs))
    const given = Array.isArray(o.sizes) && o.sizes.length === kids.length && (o.sizes as unknown[]).every(x => num(x) != null && num(x)! > 0) ? (o.sizes as unknown[]).map(Number) : kids.map(() => 1)
    const total = given.reduce((x, y) => x + y, 0)
    const d: SceneDiv = { id: newDetailId(), dir: o.split === 'stacked' ? 'col' : 'row', sizes: given.map(x => x / total), kids, ...(o.folded ? { fold: true } : {}) }
    if (typeof o.ref === 'string') refs[o.ref] = d.id
    return kids.length === 1 ? kids[0] : d
  }
  const d = leaf(typeof o.name === 'string' ? o.name : 'Section', typeof o.color === 'string' && o.color ? o.color : SCENE_COLORS[turn.n++ % SCENE_COLORS.length],
    { ...(typeof o.notes === 'string' && o.notes ? { notes: o.notes, face: true } : {}), ...(o.bump ? { bump: true } : {}), ...(o.tab ? { tab: true } : {}) })
  if (typeof o.ref === 'string') refs[o.ref] = d.id
  const cards = idsOf(o.cards), links = idsOf(o.links)
  if (cards.length || links.length) after.push({ id: d.id, cards, links })
  return d
}

/** A scene's face changed: a whole new layout and / or steps in order; one undo. */
async function editScene(args: Json): Promise<Json> {
  const { g } = sceneNamed(args.cardId)
  const bs = () => useBoardsStore.getState()
  const sceneNow = () => bs().groups.find(x => x.id === g.id)!.scene!
  const steps = Array.isArray(args.steps) ? (args.steps as Json[]) : []
  if (!args.layout && !steps.length) throw new Error('Give layout (the whole face) and / or steps.')
  const refs: Record<string, string> = {}
  const need = (v: unknown): SceneDiv => {
    const id = refs[String(v)] ?? String(v ?? '')
    const d = findDiv(sceneNow(), id)
    if (!d) throw new Error(`No section or split "${String(v)}" on this scene (read_scene gives the ids; a ref must be given by an earlier step).`)
    return d
  }
  const cardsOf = (v: unknown) => { const ids = idsOf(v).filter(id => id !== g.id); if (!ids.length) throw new Error('Give cards: the ids of the cards.'); cardsNamed(ids); return ids }
  await agentGlide(say(args, 'Laying out the scene'), agentSpotOfCard(g.id))
  useUndoCoordinator.getState().checkpoint()
  const before = sceneNow()
  try {
    if (args.layout && typeof args.layout === 'object') {
      const after: { id: string; cards: string[]; links: string[] }[] = []
      const face = sceneFromOutline(args.layout as Json, { n: 0 }, after, refs)
      for (const a of after) cardsNamed([...a.cards, ...a.links])
      bs().setGroupScene(g.id, face)
      for (const a of after) {
        if (a.cards.length) dropCardsInDivision(g.id, a.id, a.cards)
        if (a.links.length) bs().setGroupScene(g.id, addLinks(sceneNow(), a.id, a.links))
      }
    }
    for (const st of steps) {
      const what = String(st.do ?? '')
      const set = (next: SceneDiv) => bs().setGroupScene(g.id, next)
      const fresh = (id: string) => {
        const patch: Partial<SceneDiv> = {}
        if (typeof st.name === 'string') patch.name = st.name
        if (typeof st.color === 'string' && st.color) patch.color = st.color
        if (typeof st.notes === 'string' && st.notes) { patch.notes = st.notes; patch.face = true }
        if (Object.keys(patch).length) set(patchDiv(sceneNow(), id, patch))
        if (typeof st.ref === 'string') refs[st.ref] = id
      }
      if (what === 'split') {
        const d = need(st.section)
        if (!isLeaf(d)) throw new Error('split takes a section, not a split.')
        const dir = st.way === 'stacked' ? 'col' : 'row'
        set(splitDiv(sceneNow(), d.id, dir))
        const parent = findParent(sceneNow(), d.id)!
        fresh(parent.kids![parent.kids!.findIndex(k => k.id === d.id) + 1].id)
      } else if (what === 'strip') {
        const side = String(st.side) as 'top' | 'bottom' | 'left' | 'right'
        if (!['top', 'bottom', 'left', 'right'].includes(side)) throw new Error('strip: side is top, bottom, left or right.')
        const had = new Set(leaves(sceneNow()).map(l => l.id))
        set(addStrip(sceneNow(), side, num(st.share) != null ? Math.max(0.03, Math.min(0.9, num(st.share)!)) : undefined))
        fresh(leaves(sceneNow()).find(l => !had.has(l.id))!.id)
      } else if (what === 'set') {
        const d = need(st.section)
        const patch: Partial<SceneDiv> = {}
        if (isLeaf(d)) {
          if (typeof st.name === 'string') patch.name = st.name
          if (typeof st.notes === 'string') { patch.notes = st.notes; patch.face = true; patch.live = undefined }
          if (typeof st.color === 'string' && st.color) patch.color = st.color
          if (typeof st.bump === 'boolean') patch.bump = st.bump || undefined
          if (typeof st.tab === 'boolean') patch.tab = st.tab || undefined
          if (typeof st.label === 'boolean') patch.mid = st.label ? undefined : false
          if (typeof st.live === 'boolean') patch.live = st.live || undefined
        } else {
          if (typeof st.folded === 'boolean') { if (st.folded && !canFold(d)) throw new Error('Only a headed split (stacked, its first part a section) folds.'); patch.fold = st.folded || undefined }
          if (Array.isArray(st.sizes)) {
            const z = (st.sizes as unknown[]).map(Number)
            if (z.length !== d.kids!.length || z.some(x => !(x > 0))) throw new Error(`sizes: one share above 0 for each of its ${d.kids!.length} parts.`)
            const total = z.reduce((x, y) => x + y, 0)
            patch.sizes = z.map(x => x / total)
          }
        }
        if (!Object.keys(patch).length) throw new Error('set: nothing to set there (a section takes name, notes, color, bump, tab, label, live; a split takes sizes, folded).')
        set(patchDiv(sceneNow(), d.id, patch))
      } else if (what === 'put') {
        dropCardsInDivision(g.id, need(st.section).id, cardsOf(st.cards))
      } else if (what === 'link') {
        set(addLinks(sceneNow(), need(st.section).id, cardsOf(st.cards)))
      } else if (what === 'unlink') {
        const d = need(st.section)
        for (const c of cardsOf(st.cards)) set(removeLink(sceneNow(), c, d.id))
      } else if (what === 'refresh') {
        refreshDivision(g.id, need(st.section).id)
      } else if (what === 'clear') {
        set(clearDiv(sceneNow(), need(st.section).id))
      } else if (what === 'remove') {
        if (leaves(sceneNow()).length <= 1) throw new Error('The last section stays.')
        set(removeDiv(sceneNow(), need(st.section).id))
      } else if (what === 'move') {
        const where = String(st.where) as 'left' | 'right' | 'top' | 'bottom' | 'swap'
        if (!['left', 'right', 'top', 'bottom', 'swap'].includes(where)) throw new Error('move: where is left, right, top, bottom or swap.')
        const was = sceneNow()
        const next = moveDiv(was, need(st.section).id, need(st.to).id, where)
        if (next === was) throw new Error('That move makes no sense (onto itself, or into itself).')
        set(next)
      } else throw new Error(`No step "${what}". Steps: split, strip, set, put, link, unlink, refresh, clear, remove, move.`)
    }
  } catch (e) {
    // All or nothing: the face as it was.
    bs().setGroupScene(g.id, before)
    throw e
  }
  return { ...readScene({ cardId: g.id, doing: say(args, 'Laying out the scene') }), ...(Object.keys(refs).length ? { refs } : {}), undo: 'One undo (Ctrl+Z) takes it back.' }
}

// ── 3D sets: what stands in one, cameras, paths ─────────────────────────

function areaNamed(v: unknown) {
  const area = useFreeNodeStore.getState().nodes[String(v ?? '')]
  if (!area || area.type !== 'area') throw new Error('No 3D set with that id. list_tools gives them; make_3d_set makes one.')
  return area
}

/** The model a card holds (its address), if it holds one. */
function modelUrlOf(g: ProjectGroup): string | undefined {
  const boards = useBoardsStore.getState().boards
  for (const bid of g.boardIds ?? []) {
    const b = boards[bid]
    for (const rid of b?.rootIds ?? []) {
      const m = getMediaItems(b.bars[rid]?.content).find(x => x.type === 'model')
      if (m) return m.url
    }
  }
  return undefined
}

type Quat = [number, number, number, number]

/** How something turned by `q` faces: its turn about the upright, degrees, and its tip up, degrees. */
function facingOf(q: Quat | undefined): { turn: number; tip: number } {
  if (!q) return { turn: 0, tip: 0 }
  const [x, y, z, w] = q
  // Where its front (+z) points.
  const fx = 2 * (x * z + w * y), fy = 2 * (y * z - w * x), fz = 1 - 2 * (x * x + y * y)
  return { turn: Math.round(Math.atan2(fx, fz) * 180 / Math.PI), tip: Math.round(Math.asin(Math.max(-1, Math.min(1, fy))) * 180 / Math.PI) }
}

/** The turn that points a front (+z) along (dx across, dh up, dy down the canvas), upright. */
function lookQuat(dx: number, dh: number, dy: number): Quat | null {
  const len = Math.hypot(dx, dh, dy)
  if (len < 1e-6) return null
  const yaw = Math.atan2(dx, dy), pitch = -Math.asin(dh / len)
  const sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2), sp = Math.sin(pitch / 2), cp = Math.cos(pitch / 2)
  // yaw about the upright, then tipped about its own side.
  return [cy * sp, sy * cp, -sy * sp, cy * cp]
}

/** A point of a path as the agent gives it: on a set, 0 to 1 of its ground and height a part of its width; off one, canvas units. */
function pathPoint(o: Json, area: { x: number; y: number; width: number; height: number } | null): CurvePoint {
  const x = num(o.x), y = num(o.y)
  if (x == null || y == null) throw new Error('Each point needs x and y.')
  const h = num(o.height) ?? 0
  return {
    x: area ? area.x + x * area.width : x, y: area ? area.y + y * area.height : y,
    ...(h ? { z: area ? h * area.width : h } : {}),
    ...(typeof o.label === 'string' && o.label ? { label: o.label } : {}),
    ...(o.slow ? { slow: true } : {}),
    ...(o.corner ? { t: 'corner' as const } : {}),
    ...(num(o.twist) ? { twist: num(o.twist)! } : {}),
  }
}

function pathOut(c: Curve, area: { x: number; y: number; width: number; height: number } | null): Json {
  const byId = new Map(useBoardsStore.getState().groups.map(g => [g.id, g]))
  const r3 = (n: number) => Math.round(n * 1000) / 1000
  const span = c.riders?.length ? rideSpan(c) : null
  return {
    id: c.id, name: c.name ?? '', ...(c.kind === 'free' ? { penLine: true } : {}),
    ...(c.closed ? { closed: true } : {}), smooth: !!c.smooth, color: c.color,
    points: c.kind === 'free' ? c.pts.length : c.pts.map((p, i) => ({
      i, x: area ? r3((p.x - area.x) / area.width) : Math.round(p.x), y: area ? r3((p.y - area.y) / area.height) : Math.round(p.y),
      ...(p.z ? { height: area ? r3(p.z / area.width) : Math.round(p.z) } : {}),
      ...(p.label ? { label: p.label } : {}), ...(p.slow ? { slow: true } : {}), ...(p.t === 'corner' ? { corner: true } : {}), ...(p.twist ? { twist: p.twist } : {}),
    })),
    ...(c.riders?.length ? {
      riders: c.riders.map(r => ({
        cardId: r.key.startsWith('card:') ? r.key.slice(5) : r.key, name: byId.get(r.key.slice(5))?.name ?? '',
        ...(r.lead ? { lead: r.lead } : {}), ...(r.aim === false ? { aim: false } : {}), ...(r.heading ? { heading: r.heading } : {}),
        ...(r.bank ? { bank: r.bank } : {}), ...(r.lift ? { lift: r.lift } : {}), ...(r.side ? { side: r.side } : {}),
      })),
      starts: r3(span!.start), seconds: r3(span!.dur), after: c.rideAfter ?? 'loop', ...(c.rideEase ? { ease: true } : {}),
    } : {}),
  }
}

/** A 3D set, read: what stands in it and how, its cameras, its paths. */
function read3dSet(args: Json): Json {
  const area = areaNamed(args.setId)
  const ms = useModelScaleStore.getState()
  const r3 = (n: number) => Math.round(n * 1000) / 1000
  const curves = Object.values(useNotesStore.getState().curves)
  const things = rowCards(area).filter(g => g.id !== area.areaCard).map(g => {
    const key = dataKey(`card:${g.id}`)
    const url = modelUrlOf(g)
    const place = ms.placeOf[key]
    const lens = ms.lensOf[key]
    const rides = curves.find(c => c.riders?.some(r => r.key === `card:${g.id}`))
    return {
      cardId: g.id, name: g.name,
      ...(g.linkOf ? { linkedCardOf: g.linkOf } : {}),
      ...(url === CAMERA_URL ? { camera: true } : url?.startsWith('prim:') ? { shape: url.slice(5) } : url ? { model: true } : { noModel: true }),
      ...(place ? { x: r3(place.dx / area.width), y: r3(place.dy / area.height), height: r3((place.h ?? 0) / area.width) } : url ? { notPlaced: true } : {}),
      ...(url ? { size: r3(ms.setSizeOf[key] ?? ms.sizeOf[key] ?? 1), ...facingOf(ms.poseOf[key] as Quat | undefined) } : {}),
      ...(url === CAMERA_URL ? { lens: { mm: lens?.mm ?? 35, focus: r3(lens?.focus ?? 4) } } : {}),
      ...(rides ? { ridesPath: rides.id } : {}),
    }
  })
  agentPoint(say(args, 'Looking over the 3D set'), { x: area.x + area.width / 2, y: area.y + area.height / 2 })
  return {
    setId: area.id, ...(area.areaCard ? { setCardId: area.areaCard } : {}),
    ground: { x: Math.round(area.x), y: Math.round(area.y), w: Math.round(area.width), h: Math.round(area.height) },
    things, paths: curvesOf(area.id).map(c => pathOut(c, area)),
    clock: { seconds: r3(rideTime(area.id)), playing: ridePlaying(area.id) },
    note: 'x and y are 0 to 1 across and down the ground; height is a part of the ground\'s width. turn is degrees about the upright (0 faces down the canvas, toward the viewer; 90 faces right); tip is degrees up. A camera looks out of its front.',
  }
}

/** New shapes and cameras in a 3D set: each a card docked under the set, standing where told. */
async function addTo3dSet(args: Json): Promise<Json> {
  const area = areaNamed(args.setId)
  const want = Array.isArray(args.things) ? (args.things as Json[]) : []
  if (!want.length || want.length > 30) throw new Error('Give things: 1 to 30 shapes or cameras.')
  for (const w of want) if (!PRIMITIVES.includes(String(w.shape) as Primitive)) throw new Error(`No shape "${String(w.shape)}". Shapes: ${PRIMITIVES.join(', ')}.`)
  const zoom = useCanvasStore.getState().zoom
  const face = cardFaceSize(zoom)
  await agentGlide(say(args, 'Adding to the 3D set'), { x: area.x + area.width / 2, y: area.y + area.height / 2 })
  useUndoCoordinator.getState().checkpoint()
  const rectOf = (id: string) => {
    const bs = useBoardsStore.getState()
    const g = bs.groups.find(x => x.id === id)
    return (g && cardVisualRect(g, bs.boards, zoom)?.rect) || null
  }
  const made: { cardId: string; name: string; shape: string }[] = []
  want.forEach((w, i) => {
    const shape = String(w.shape) as Primitive
    const name = typeof w.name === 'string' && w.name.trim() ? w.name.trim() : PRIM_NAMES[shape]
    const row = rowCards(area).map(g => rectOf(g.id)).filter((r): r is NonNullable<typeof r> => !!r)
    const first = row[0]
    const right = first ? Math.max(...row.filter(r => r.top < first.bottom && r.bottom > first.top).map(r => r.right)) : area.x
    const top = first ? first.top : area.y + area.height + TOUCH_GAP
    const id = createMediaCard({ cx: right + TOUCH_GAP + face.w / 2, cy: top + face.h / 2 }, [{ media: { url: primitiveUrl(shape), type: 'model', originalName: name }, label: name }])
    if (!id) return
    useBoardsStore.setState(st => ({ groups: st.groups.map(g => g.id !== id ? g : { ...g, cardWidthOverride: face.w, cardHeightOverride: face.h }) }))
    const g = useBoardsStore.getState().groups.find(o => o.id === id), r = rectOf(id)
    if (g && r) useBoardsStore.getState().setGroupPosBatch([{ groupId: id, originX: g.originX + (right + TOUCH_GAP - r.left), originY: g.originY + (top - r.top) }])
    if (name !== PRIM_NAMES[shape]) useBoardsStore.getState().renameGroup(id, name)
    if (shape === 'camera') useModelScaleStore.getState().setLens(dataKey(`card:${id}`), { mm: 80 })
    standModel(area, id, standsOf([{ ...w, id }])[0], { x: (i + 1) / (want.length + 1), y: 0.5 })
    made.push({ cardId: id, name, shape })
  })
  markNew(made.map(m => m.cardId))
  return { added: made, note: 'Each is a new card docked under the set. One undo (Ctrl+Z) takes them back.' }
}

/** A path drawn: on a 3D set (it belongs to the set) or on the canvas. */
async function drawPath(args: Json): Promise<Json> {
  const area = args.setId != null ? areaNamed(args.setId) : null
  const want = Array.isArray(args.points) ? (args.points as Json[]) : []
  if (want.length < 2 || want.length > 200) throw new Error('A path needs 2 to 200 points.')
  const pts = want.map(o => pathPoint(o, area))
  const riders = idsOf(args.riders)
  if (riders.length) cardsNamed(riders)
  const ui = useNotesUi.getState()
  const zoom = useCanvasStore.getState().zoom
  await agentGlide(say(args, 'Drawing a path'), { x: pts[0].x, y: pts[0].y })
  useUndoCoordinator.getState().checkpoint()
  const id = newNoteId('cv')
  const curve: Curve = {
    id, kind: 'bezier', pts, smooth: args.smooth !== false,
    color: typeof args.color === 'string' && args.color ? args.color : ui.color,
    width: num(args.width) ?? ui.width / zoom,
    parent: area ? area.id : null,
    ...(typeof args.name === 'string' && args.name ? { name: args.name } : {}),
    ...(args.closed ? { closed: true } : {}),
    ...(args.arrow ? { arrowEnd: true } : {}),
  }
  useNotesStore.getState().addCurve(curve)
  for (const r of riders) parentToPath(`card:${r}`, id)
  ridePatch(id, args)
  await agentGlide(say(args, 'Drawing a path'), { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y })
  return { path: pathOut(useNotesStore.getState().curves[id], area), note: 'One undo (Ctrl+Z) takes it back.' }
}

/** When what rides a path sets off and arrives, and what it does then. */
function ridePatch(id: string, args: Json): void {
  const patch: Partial<Curve> = {}
  const start = num(args.starts), secs = num(args.seconds)
  if (start != null) patch.rideStart = Math.max(0, start)
  if (secs != null) patch.rideEnd = (start ?? useNotesStore.getState().curves[id]?.rideStart ?? 0) + Math.max(0.1, secs)
  if (args.after === 'loop' || args.after === 'stop' || args.after === 'pingpong') patch.rideAfter = args.after
  if (typeof args.ease === 'boolean') patch.rideEase = args.ease || undefined
  if (Object.keys(patch).length) useNotesStore.getState().updateCurve(id, patch)
}

/** A path changed, or taken away; one undo. */
async function editPath(args: Json): Promise<Json> {
  const ns = () => useNotesStore.getState()
  const c = ns().curves[String(args.pathId ?? '')]
  if (!c) throw new Error('No path with that id. read_3d_set gives a set\'s paths.')
  const pid = parentOf(c)
  const area = pid ? useFreeNodeStore.getState().nodes[pid] : null
  const points = Array.isArray(args.points) ? (args.points as Json[]) : null
  if (points && c.kind !== 'bezier') throw new Error('A pen line\'s points cannot be set.')
  if (points && (points.length < 2 || points.length > 200)) throw new Error('A path needs 2 to 200 points.')
  const pts = points?.map(o => pathPoint(o, area))
  const riders = Array.isArray(args.riders) ? (args.riders as Json[]).map(r => (typeof r === 'string' ? { id: r } : r) as Json) : null
  if (riders?.length) cardsNamed(riders.map(r => String(r.id)))
  await agentGlide(say(args, args.remove ? 'Taking a path away' : 'Changing a path'), { x: c.pts[0]?.x ?? 0, y: c.pts[0]?.y ?? 0 })
  useUndoCoordinator.getState().checkpoint()
  if (args.remove) { ns().deleteCurves([c.id]); return { removed: true, note: 'One undo (Ctrl+Z) brings it back.' } }
  const patch: Partial<Curve> = {}
  if (pts) patch.pts = pts
  if (typeof args.name === 'string') patch.name = args.name || undefined
  if (typeof args.closed === 'boolean') patch.closed = args.closed || undefined
  if (typeof args.smooth === 'boolean') patch.smooth = args.smooth
  if (typeof args.color === 'string' && args.color) patch.color = args.color
  if (num(args.width) != null) patch.width = Math.max(0.1, num(args.width)!)
  if (typeof args.arrow === 'boolean') patch.arrowEnd = args.arrow || undefined
  if (Object.keys(patch).length) ns().updateCurve(c.id, patch)
  if (riders) {
    const keep = new Set(riders.map(r => `card:${String(r.id)}`))
    for (const r of ns().curves[c.id].riders ?? []) if (!keep.has(r.key)) unparentFromPath(r.key)
    for (const r of riders) {
      const key = `card:${String(r.id)}`
      parentToPath(key, c.id)
      const p: Partial<PathRider> = {}
      if (num(r.lead) != null) p.lead = Math.max(0, Math.min(1, num(r.lead)!))
      if (typeof r.aim === 'boolean') p.aim = r.aim
      if (num(r.heading) != null) p.heading = num(r.heading)!
      if (num(r.bank) != null) p.bank = num(r.bank)!
      if (num(r.lift) != null) p.lift = area ? num(r.lift)! * area.width : num(r.lift)!
      if (num(r.side) != null) p.side = area ? num(r.side)! * area.width : num(r.side)!
      if (Object.keys(p).length) setRider(c.id, key, p)
    }
  }
  ridePatch(c.id, args)
  return { path: pathOut(ns().curves[c.id], area), note: 'One undo (Ctrl+Z) takes it back.' }
}

/** A set's ride clock: play, pause, or go to a time. */
function playPaths(args: Json): Json {
  const set = args.setId != null ? areaNamed(args.setId).id : ''
  const clock = useRideClock.getState()
  const t = num(args.seconds)
  if (t != null) clock.seek(t, set)
  if (args.do === 'play') clock.play(set)
  else if (args.do === 'pause') clock.pause(set)
  else if (t == null) throw new Error('Give do: play or pause, and / or seconds to go to.')
  agentPoint(say(args, args.do === 'play' ? 'Playing the paths' : 'Setting the clock'))
  return { seconds: Math.round(rideTime(set) * 1000) / 1000, playing: ridePlaying(set) }
}

// ── Effects: cards lined up to the right of a picture card ──────────────

function effectOut(g: ProjectGroup): Json {
  const e = g.effect!
  const def = EFFECTS[e.kind]
  return {
    id: g.id, kind: e.kind, name: def.label,
    params: Object.fromEntries(def.params.map(q => [q.key, e.params?.[q.key] ?? q.default])),
    ...(e.text ? { text: e.text } : {}), ...(e.off ? { off: true } : {}), ...(e.solo ? { solo: true } : {}),
  }
}

/** The effects there are, each with what it does and its settings. */
function listEffects(args: Json): Json {
  const one = typeof args.kind === 'string' ? args.kind : ''
  if (one && !(one in EFFECTS)) throw new Error(`No effect "${one}". list_effects without kind gives them all.`)
  agentPoint(say(args, 'Looking over the effects'))
  const full = (k: EffectKind) => {
    const d = EFFECTS[k]
    return {
      kind: k, name: d.label, does: d.blurb,
      ...(d.blend ? { mixesIn: 'the next picture card in the row' } : {}),
      ...(d.needs?.length ? { needs: d.needs } : {}),
      params: d.params.map(q => ({ key: q.key, name: q.label, min: q.min, max: q.max, default: q.default, ...(q.names ? { choices: q.names } : {}), ...(paramHelp(k, q.key) ? { means: paramHelp(k, q.key) } : {}) })),
    }
  }
  if (one) return full(one as EffectKind)
  return {
    effects: (Object.keys(EFFECTS) as EffectKind[]).map(k => ({ kind: k, name: EFFECTS[k].label, does: EFFECTS[k].blurb, params: EFFECTS[k].params.map(q => q.key) })),
    note: 'list_effects with kind gives one effect\'s settings in full (range, default, what each means).',
  }
}

/** The effect cards lined up to the right of a card, in the order they run. */
function readEffects(args: Json): Json {
  const [card] = cardsNamed([String(args.cardId ?? '')])
  const groups = useBoardsStore.getState().groups
  const chain = effectChain(card.id).map(id => groups.find(g => g.id === id)).filter((g): g is ProjectGroup => !!g?.effect)
  agentPoint(say(args, 'Reading the effects'), agentSpotOfCard(card.id))
  return { cardId: card.id, name: card.name, effects: chain.map(effectOut), note: 'They run left to right on the card\'s face picture; the face shows the result.' }
}

/** What an agent may set on an effect card. */
function effectPatch(kind: EffectKind, c: Json): Partial<NonNullable<ProjectGroup['effect']>> {
  const def = EFFECTS[kind]
  const p: Partial<NonNullable<ProjectGroup['effect']>> = {}
  if (c.params && typeof c.params === 'object') {
    const params: Record<string, number> = {}
    for (const [key, v] of Object.entries(c.params as Json)) {
      const q = def.params.find(x => x.key === key)
      if (!q) throw new Error(`${def.label} has no setting "${key}". Its settings: ${def.params.map(x => x.key).join(', ') || 'none'}.`)
      if (num(v) == null) throw new Error(`${def.label} ${key} takes a number, ${q.min} to ${q.max}.`)
      params[key] = Math.max(q.min, Math.min(q.max, num(v)!))
    }
    p.params = params
  }
  if (typeof c.text === 'string') p.text = c.text || undefined
  if (typeof c.off === 'boolean') p.off = c.off || undefined
  if (typeof c.solo === 'boolean') p.solo = c.solo || undefined
  return p
}

const writeEffect = (id: string, patch: Partial<NonNullable<ProjectGroup['effect']>>) =>
  useBoardsStore.setState(st => ({ groups: st.groups.map(g => g.id === id && g.effect ? { ...g, effect: { ...g.effect, ...patch, params: { ...g.effect.params, ...patch.params } } } : g) }))

/** New effect cards at the end of a card's row of effects; one undo. */
async function addEffects(args: Json): Promise<Json> {
  const [card] = cardsNamed([String(args.cardId ?? '')])
  const want = Array.isArray(args.effects) ? (args.effects as Json[]) : []
  if (!want.length || want.length > 20) throw new Error('Give effects: 1 to 20.')
  const plans = want.map(w => {
    const kind = String(w.kind ?? '') as EffectKind
    if (!(kind in EFFECTS)) throw new Error(`No effect "${kind}". list_effects gives them.`)
    return { kind, patch: effectPatch(kind, w) }
  })
  await agentGlide(say(args, 'Adding effects'), agentSpotOfCard(card.id))
  const was = useBoardsStore.getState().selectedGroupIds
  useUndoCoordinator.getState().checkpoint()
  const made: string[] = []
  for (const q of plans) {
    const id = createEffectCardGroup(q.kind, { after: card.id })
    if (Object.keys(q.patch).length) writeEffect(id, q.patch)
    made.push(id)
  }
  // The artist's selection is theirs.
  useBoardsStore.getState().setSelectedGroups(was)
  markNew(made)
  return { ...readEffects({ cardId: card.id, doing: say(args, 'Adding effects') }), added: made, undo: 'One undo (Ctrl+Z) takes them back.' }
}

/** Effect cards changed: their settings, text, off, solo; one undo. */
async function editEffects(args: Json): Promise<Json> {
  const want = Array.isArray(args.effects) ? (args.effects as Json[]) : []
  if (!want.length) throw new Error('Give effects: [{ id, params, text, off, solo }].')
  const cards = cardsNamed(want.map(w => String(w.id ?? '')))
  const plans = want.map((w, i) => {
    const e = cards[i].effect
    if (!e) throw new Error(`"${cards[i].name}" is not an effect card.`)
    return { id: cards[i].id, patch: effectPatch(e.kind, w) }
  })
  await agentGlide(say(args, 'Setting the effects'), agentSpotOfCard(cards[0].id))
  useUndoCoordinator.getState().checkpoint()
  for (const q of plans) writeEffect(q.id, q.patch)
  const groups = useBoardsStore.getState().groups
  return { effects: plans.map(q => effectOut(groups.find(g => g.id === q.id)!)), note: 'One undo (Ctrl+Z) takes it back.' }
}

/** A card's picture through its effects, saved as a file at full size. */
async function saveEffects(args: Json): Promise<Json> {
  const [card] = cardsNamed([String(args.cardId ?? '')])
  const fx = useFxStore.getState()
  const strip = fx.strips[fx.byNode[cardStripId(card.id)] ?? '']
  if (!strip || !strip.items.some(i => i.kind === 'effect')) throw new Error(`"${card.name}" has no effects running on it: add_effects first (the card needs a picture on its face).`)
  agentPoint(say(args, 'Saving the result'), agentSpotOfCard(card.id))
  const r = await saveStripResult(strip.items)
  const mine = r.saved[0]
  const failure = mine ? saveFailure(mine) : (r.error ?? 'Could not save the result.')
  if (failure) throw new Error(failure)
  return mine.path
    ? { file: mine.path, note: 'Saved. To bring it in as a card: deal_deck with media { file } and from: [the card\'s id].' }
    : { downloaded: true, note: 'Handed to the browser\'s downloads; on the desktop app it is saved as a file you can deal as a card.' }
}

// ── Rough Cut: its clips ────────────────────────────────────────────────

function cutNamed(v: unknown) {
  const node = useFreeNodeStore.getState().nodes[String(v ?? '')]
  if (!node?.roughCut) throw new Error('No Rough Cut with that id. list_tools gives them; place_tool rough_cut makes one.')
  return { node, cut: node.roughCut }
}

const r2 = (n: number) => Math.round(n * 100) / 100

function readCut(args: Json): Json {
  const { node, cut } = cutNamed(args.toolId)
  const clips = [...placed(cut.clips)].sort((a, b) => clipStart(a) - clipStart(b) || clipRow(a) - clipRow(b))
  agentPoint(say(args, 'Reading the Rough Cut'), { x: node.x + node.width / 2, y: node.y + node.height / 2 })
  return {
    toolId: node.id, seconds: r2(cutLength(clips)),
    ...(cut.frame ? { frame: { aspect: r2(cut.frame.aspect), fill: !!cut.frame.fill } } : {}),
    clips: clips.map(c => ({
      id: c.id, name: c.label, kind: c.kind, row: clipRow(c), start: r2(clipStart(c)), seconds: r2(clipLength(c)),
      ...(c.kind === 'video' ? { in: r2(c.in), out: r2(c.out), sourceSeconds: r2(c.full) } : {}),
      ...(c.pick ? { pick: true } : {}),
    })),
    note: 'start and seconds are on the timeline; row 0 is the top row, and where clips overlap the top row shows. in and out are the part of a movie in the cut.',
  }
}

/** A Rough Cut's clips changed: split, trimmed, moved, picked, taken out; one undo. */
async function editCut(args: Json): Promise<Json> {
  const { node, cut } = cutNamed(args.toolId)
  let clips: RoughClip[] = placed(cut.clips).map(c => ({ ...c }))
  const need = (id: unknown) => { const c = clips.find(x => x.id === String(id)); if (!c) throw new Error(`No clip with id ${String(id)} (read_rough_cut gives them).`); return c }
  for (const sp of Array.isArray(args.split) ? args.split as Json[] : []) {
    const c = need(sp.id), at = num(sp.at)
    if (at == null) throw new Error('split: give at, the time on the timeline in seconds.')
    const next = splitClipAt(clips, c.id, at)
    if (!next) throw new Error(`"${c.label}" cannot be split at ${at}: that is not inside it with ${MIN_CLIP} seconds on each side (it runs ${r2(clipStart(c))} to ${r2(clipStart(c) + clipLength(c))}).`)
    clips = next
  }
  for (const q of Array.isArray(args.clips) ? args.clips as Json[] : []) {
    const c = need(q.id)
    if (typeof q.name === 'string') c.label = q.name
    if (num(q.in) != null || num(q.out) != null) {
      if (c.kind !== 'video') throw new Error(`"${c.label}" is not a movie: set seconds for how long it shows.`)
      const i = Math.max(0, Math.min(c.full - MIN_CLIP, num(q.in) ?? c.in))
      c.in = i; c.out = Math.max(i + MIN_CLIP, Math.min(c.full, num(q.out) ?? c.out))
    }
    if (num(q.seconds) != null) c.out = c.kind === 'video' ? Math.min(c.full, c.in + Math.max(MIN_CLIP, num(q.seconds)!)) : c.in + Math.max(MIN_CLIP, num(q.seconds)!)
    if (num(q.start) != null) c.start = Math.max(0, num(q.start)!)
    if (num(q.row) != null) c.row = Math.max(0, Math.min(7, Math.round(num(q.row)!)))
    if (typeof q.pick === 'boolean') c.pick = q.pick || undefined
  }
  const remove = new Set(idsOf(args.remove))
  for (const id of remove) need(id)
  clips = clips.filter(c => !remove.has(c.id))
  const order = idsOf(args.order)
  if (order.length) {
    // End to end on the top row, in the order given; clips not named keep their places.
    let t = 0
    for (const id of order) { const c = need(id); c.start = t; c.row = 0; t += clipLength(c) }
  }
  const patch: Partial<RoughCutData> = { clips }
  if (args.frame === null) patch.frame = undefined
  else if (args.frame && typeof args.frame === 'object') {
    const f = args.frame as Json, aspect = num(f.aspect)
    if (aspect == null || aspect <= 0) throw new Error('frame: aspect is width divided by height (16:9 is 1.78).')
    patch.frame = { aspect, ...(f.fill ? { fill: true } : {}) }
  }
  await agentGlide(say(args, 'Cutting'), { x: node.x + node.width / 2, y: node.y + node.height / 2 })
  useUndoCoordinator.getState().checkpoint()
  useFreeNodeStore.getState().updateFreeNode(node.id, { roughCut: { ...cut, ...patch } })
  return { ...readCut({ toolId: node.id, doing: say(args, 'Cutting') }), undo: 'One undo (Ctrl+Z) takes it back.' }
}

/** The picked clips, out as a deck docked under the Rough Cut. */
function picksDeck(args: Json): Json {
  const { node } = cutNamed(args.toolId)
  agentPoint(say(args, 'Dealing the picks'), { x: node.x + node.width / 2, y: node.y + node.height })
  const before = new Set(useBoardsStore.getState().groups.map(g => g.id))
  const made = deckOfPicks(node.id)
  if (!made) throw new Error('No clip is picked. edit_rough_cut sets pick on clips.')
  return { cards: useBoardsStore.getState().groups.filter(g => !before.has(g.id)).map(g => ({ id: g.id, name: g.name })), note: 'A deck of the picked clips, docked under the Rough Cut. One undo (Ctrl+Z) takes it back.' }
}

// ── Viewers: what they show ─────────────────────────────────────────────

const itemOut = (i: { kind: string; name?: string; mediaType?: string; url?: string; sourceId?: string }) =>
  ({ ...(i.kind === 'media' ? { shows: i.mediaType } : { shows: 'text' }), ...(i.name ? { name: i.name } : {}) })

function readViewer(args: Json): Json {
  const w = useViewport3DStore.getState().windows[String(args.viewerId ?? '')]
  if (!w) throw new Error('No Viewer with that id. list_tools gives them; show_in_viewer without viewerId makes one.')
  agentPoint(say(args, 'Looking at the Viewer'), { x: w.x + w.width / 2, y: w.y + w.height / 2 })
  return {
    viewerId: w.id, place: { x: Math.round(w.x), y: Math.round(w.y), w: Math.round(w.width), h: Math.round(w.height) },
    ...(w.activeItem ? { showing: itemOut(w.activeItem) } : { showing: null }),
    ...(w.pin ? { pinnedToScreen: true } : {}),
    note: 'A Viewer shows what the cards touching it hold; its arrows step through them.',
  }
}

/** A Viewer set against a card's side, showing what the card holds. The card is not moved. */
async function showInViewer(args: Json): Promise<Json> {
  const [card] = cardsNamed([String(args.cardId ?? '')])
  const bs = useBoardsStore.getState()
  const zoom = useCanvasStore.getState().zoom
  const items = collectDeckContent(card.id, bs.groups, bs.boards)
  if (!items.length) throw new Error(`"${card.name}" holds nothing a Viewer can show (a picture, movie, model, sound or text).`)
  const r = cardVisualRect(card, bs.boards, zoom)?.rect
  if (!r) throw new Error(`"${card.name}" is not out on the canvas (it may be inside a closed deck).`)
  const vs = () => useViewport3DStore.getState()
  let id = args.viewerId != null ? String(args.viewerId) : ''
  if (id && !vs().windows[id]) throw new Error('No Viewer with that id. list_tools gives them.')
  if (id && vs().windows[id].pin) throw new Error('That Viewer is pinned to the screen: it shows only what is pinned beside it.')
  const side = ['left', 'right', 'top', 'bottom'].includes(String(args.side)) ? String(args.side) : 'right'
  await agentGlide(say(args, `Showing ${card.name} in a Viewer`), agentSpotOfCard(card.id))
  useUndoCoordinator.getState().checkpoint()
  if (!id) id = vs().addWindow(r.right, r.top)
  // Flush against the card's side, as drawn (its header is a band of its own).
  const w = vs().windows[id]
  const v = viewportVisualRect(w, zoom)
  const tx = side === 'right' ? r.left + (r.right - r.left) : side === 'left' ? r.left - v.width : r.left
  const ty = side === 'bottom' ? r.bottom : side === 'top' ? r.top - v.height : r.top
  vs().updateWindow(id, { x: w.x + (tx - v.x), y: w.y + (ty - v.y) })
  showDockedCardInViewer(card.id)
  const n = num(args.item)
  if (n != null && items[Math.round(n)]) vs().setActiveItem(id, items[Math.round(n)])
  const now = vs().windows[id]
  const on = !!now.activeItem && items.some(i => activeItemKey(i) === activeItemKey(now.activeItem))
  return {
    viewerId: id, ...(now.activeItem ? { showing: itemOut(now.activeItem) } : {}),
    holds: items.map((i, k) => ({ item: k, ...itemOut(i) })),
    ...(on ? {} : { warning: 'The Viewer is beside the card but did not take it up; the artist may need to nudge it against the card.' }),
    note: 'The Viewer was set against the card; the card was not moved. One undo (Ctrl+Z) takes it back.',
  }
}

// ── The view: where the artist is looking ───────────────────────────────

function viewNow(): Json {
  const { pan, zoom } = useCanvasStore.getState()
  const t = useTiltStore.getState()
  const w = window.innerWidth, h = window.innerHeight
  return {
    zoom: Math.round(zoom * 1000) / 10,
    sees: { x: Math.round(-pan.x / zoom), y: Math.round(-pan.y / zoom), w: Math.round(w / zoom), h: Math.round(h / zoom) },
    tilt: Math.round(t.tilt), spin: Math.round(t.spin),
    levels: 'Zoomed far out cards show as cards; closer, their blocks; closest, their boards for editing.',
  }
}

function readView(args: Json): Json {
  agentPoint(say(args, 'Looking around'))
  return viewNow()
}

/** The view moved: onto cards, a tool or a spot; zoomed; tilted. Not an undo step. */
async function moveView(args: Json): Promise<Json> {
  const cs = useCanvasStore.getState()
  const boxes: Box[] = []
  const ids = idsOf(args.cards)
  if (ids.length) {
    const bs = useBoardsStore.getState()
    for (const g of cardsNamed(ids)) { const r = cardVisualRect(g, bs.boards, cs.zoom)?.rect; if (r) boxes.push(r) }
  }
  if (args.toolId != null) {
    const t = toolsNow().find(x => x.id === String(args.toolId))
    if (!t) throw new Error('No tool with that id. list_tools gives them.')
    const q = t.place as { x: number; y: number; w: number; h: number }
    boxes.push({ left: q.x, top: q.y, right: q.x + q.w, bottom: q.y + q.h })
  }
  const at = args.at as Json | undefined
  if (at && num(at.x) != null && num(at.y) != null) boxes.push({ left: num(at.x)!, top: num(at.y)!, right: num(at.x)!, bottom: num(at.y)! })
  let zoom = cs.zoom
  if (num(args.zoom) != null) zoom = num(args.zoom)! / 100
  if (boxes.length) {
    const l = Math.min(...boxes.map(b => b.left)), r = Math.max(...boxes.map(b => b.right))
    const t = Math.min(...boxes.map(b => b.top)), b = Math.max(...boxes.map(q => q.bottom))
    if (args.fit && r > l && b > t) zoom = Math.min(window.innerWidth * 0.8 / (r - l), window.innerHeight * 0.7 / (b - t))
    cs.setZoom(zoom)
    const z = useCanvasStore.getState().zoom
    cs.setPan({ x: window.innerWidth / 2 - (l + r) / 2 * z, y: window.innerHeight / 2 - (t + b) / 2 * z })
  } else if (num(args.zoom) != null) {
    // About the middle of the view.
    const mid = viewportCenterInCanvas()
    cs.setZoom(zoom)
    const z = useCanvasStore.getState().zoom
    cs.setPan({ x: window.innerWidth / 2 - mid.cx * z, y: window.innerHeight / 2 - mid.cy * z })
  }
  if (num(args.tilt) != null || num(args.spin) != null) {
    const t = useTiltStore.getState()
    t.setView(Math.max(0, Math.min(89, num(args.tilt) ?? t.tilt)), num(args.spin) ?? t.spin)
  }
  agentPoint(say(args, 'Moving the view'))
  return viewNow()
}

// ── Loop strips: columns of cards, a row of effects, Run ────────────────

/** More results than this and the strip asks first: that is the artist's to answer. */
const STRIP_RUN_MOST = 100

function stripNamed(v: unknown) {
  const node = useFreeNodeStore.getState().nodes[String(v ?? '')]
  if (!isRail(node)) throw new Error('No loop strip with that id. list_tools gives them; place_tool loop_strip makes one.')
  return node
}

type Tile = ReturnType<typeof stripNamed>
const stripMid = (rail: Tile) => ({ x: rail.x + rail.width / 2, y: rail.y + rail.height / 2 })

function stripFx(n: FreeNodeData): Json {
  const e = n.effect ?? { kind: 'grade' as EffectKind }
  const def = EFFECTS[e.kind]
  return {
    id: n.id, kind: e.kind, name: def.label,
    params: Object.fromEntries(def.params.map(q => [q.key, e.params?.[q.key] ?? q.default])),
    ...(e.text ? { text: e.text } : {}), ...(e.off ? { off: true } : {}),
  }
}

function stripOut(rail: Tile): Json {
  const nodes = useFreeNodeStore.getState().nodes
  const groups = useBoardsStore.getState().groups
  const members = railMembers(nodes).get(rail.id)
  const col = (slotId: string) => [...(members?.get(slotId) ?? [])].sort((a, b) => a.railDock!.order - b.railDock!.order)
  const held = (n: FreeNodeData): Json => n.cardRef
    ? { cardId: n.cardRef, name: groups.find(g => g.id === n.cardRef)?.name ?? n.label }
    : { name: n.label, kind: n.type }
  const slot = (sl: RailSlot): Json => {
    if (sl.kind === 'role') return { column: sl.id, name: sl.name ?? '', mode: sl.mode ?? 'each', cards: col(sl.id).map(held) }
    const [card, ...inputs] = col(sl.id)
    return card ? { effect: stripFx(card), ...(inputs.length ? { inputs: inputs.map(stripFx) } : {}) } : { effect: null }
  }
  const [own, ...rows] = railRows(rail.rail)
  const run = useRailRunStore.getState().run[rail.id]
  const preview = useRailRunStore.getState().preview[rail.id]
  return {
    toolId: rail.id, name: rail.label || 'Loop strip',
    row: own.map(slot),
    ...(rows.length ? { lookRows: rows.map((r, i) => ({ row: i + 1, effects: r.map(slot) })) } : {}),
    results: col(RAIL_TRAY).map(held),
    runWouldMake: railComboCount(rail, members),
    ...(preview?.error ? { cannotRun: preview.error } : {}),
    ...(run ? { run: { running: run.running, done: run.done, of: run.total, made: run.made ?? 0, ...(run.note ? { note: run.note } : {}), ...(run.stopped ? { stopped: true } : {}), ...(run.error ? { error: run.error } : {}) } } : {}),
    note: 'Left to right: a column holds picture cards (mode each runs every card, pick only the last, face-up one); effects run in order on the first column\'s pictures; a column after a blend effect is what that effect mixes in. Results land at the right end.',
  }
}

function readStrip(args: Json): Json {
  const rail = stripNamed(args.toolId)
  agentPoint(say(args, 'Reading the loop strip'), stripMid(rail))
  return stripOut(rail)
}

/** A loop strip changed: its columns, the cards in them, its effects. One undo. */
async function editStrip(args: Json): Promise<Json> {
  const rail0 = stripNamed(args.toolId)
  const id = rail0.id
  if (rail0.pin) throw new Error('This loop strip is pinned. The artist unpins it.')
  const fs = () => useFreeNodeStore.getState()
  const rail = () => stripNamed(id)
  const list = (k: string) => Array.isArray(args[k]) ? (args[k] as Json[]) : []
  const roleOf = (v: unknown) => {
    const roles = rail().rail.slots.filter(sl => sl.kind === 'role')
    const sl = v == null ? roles[0] : roles.find(x => x.id === String(v))
    if (!sl) throw new Error(v == null ? 'This strip has no column: addColumns first.' : `No column "${String(v)}" on this strip. read_loop_strip gives them.`)
    return sl
  }
  const fxTile = (v: unknown) => {
    const n = fs().nodes[String(v ?? '')]
    if (n?.type !== 'effect' || n.railDock?.railId !== id) throw new Error(`No effect "${String(v)}" on this strip. read_loop_strip gives their ids.`)
    return n
  }
  const mode = (v: unknown): 'each' | 'pick' | undefined => {
    if (v == null) return undefined
    if (v !== 'each' && v !== 'pick') throw new Error('mode is each or pick.')
    return v
  }
  // Checked before anything changes.
  const columns = list('columns').map(c => ({ sl: roleOf(c.column), name: typeof c.name === 'string' ? c.name : undefined, mode: mode(c.mode) }))
  const addColumns = list('addColumns').map(c => ({ name: typeof c.name === 'string' ? c.name : 'Pictures', mode: mode(c.mode), at: c.at === 'start' ? 'start' as const : 'end' as const, index: num(c.at) }))
  const dock = list('dock').map(d => {
    const cards = cardsNamed(idsOf(d.cards))
    if (!cards.length) throw new Error('dock: give cards.')
    const fxCard = cards.find(g => g.effect)
    if (fxCard) throw new Error(`"${fxCard.name}" is an effect card: effects go in with addEffects.`)
    if (d.column != null && !String(d.column).startsWith('new:')) roleOf(d.column)
    return { cards: cards.map(g => g.id), column: d.column == null ? null : String(d.column) }
  })
  const undock = idsOf(args.undock)
  const addEffects = list('addEffects').map(w => {
    const kind = String(w.kind ?? '') as EffectKind
    if (!(kind in EFFECTS)) throw new Error(`No effect "${kind}". list_effects gives them.`)
    const row = num(w.row) ?? 0
    if (row < 0 || row > (rail0.rail.rows?.length ?? 0) + (args.addRow ? 1 : 0)) throw new Error(`No look row ${row} on this strip.`)
    return { kind, patch: effectPatch(kind, w), at: num(w.at), row, under: w.under == null ? null : String(w.under) }
  })
  const setEffects = list('effects').map(w => { const n = fxTile(w.id); return { id: n.id, patch: effectPatch(n.effect!.kind, w) } })
  const move = list('move').map(m => {
    if (num(m.at) == null) throw new Error('move: give at, the place in the row (0 first).')
    return { id: String(m.id ?? ''), at: num(m.at)!, row: num(m.row) }
  })
  const remove = idsOf(args.remove)
  for (const r of remove) if (!rail0.rail.slots.some(sl => sl.kind === 'role' && sl.id === r)) fxTile(r)
  if (!columns.length && !addColumns.length && !dock.length && !undock.length && !addEffects.length && !setEffects.length && !move.length && !remove.length && !args.addRow && !args.emptyResults)
    throw new Error('Nothing to change. Give columns, addColumns, dock, undock, addEffects, effects, move, remove, addRow or emptyResults.')

  await agentGlide(say(args, 'Setting up the loop strip'), stripMid(rail0))
  useUndoCoordinator.getState().checkpoint()
  for (const c of columns) fs().setRailSlot(id, c.sl.id, { ...(c.name != null ? { name: c.name } : {}), ...(c.mode ? { mode: c.mode } : {}) })
  const newCols: string[] = []
  for (const c of addColumns) {
    const sid = fs().addRailRole(id, c.at, c.name)
    if (!sid) continue
    newCols.push(sid)
    if (c.mode) fs().setRailSlot(id, sid, { mode: c.mode })
    if (c.index != null) fs().moveRailSlot(id, sid, Math.max(0, Math.min(rail().rail.slots.length, c.index)), 0)
  }
  if (args.addRow) fs().addRailRow(id)
  let docked = 0
  for (const d of dock) {
    const slotId = d.column?.startsWith('new:') ? newCols[Number(d.column.slice(4)) - 1] : roleOf(d.column).id
    if (!slotId) throw new Error(`dock: "${d.column}" names a new column that was not made (new:1 is the first of addColumns).`)
    docked += dockCardsOnRail(d.cards, { railId: id, kind: 'column', slotId, index: Infinity })
  }
  const added: string[] = []
  for (const w of addEffects) {
    const tid = fs().addFreeNode(0, 0, 'effect')
    fs().updateFreeNode(tid, { effect: { kind: w.kind, ...w.patch }, label: EFFECTS[w.kind].label })
    if (w.under) fs().dockToRail([tid], { railId: id, kind: 'input', slotId: fxTile(w.under).railDock!.slotId })
    else {
      const rowSlots = railRows(rail().rail)[w.row] ?? []
      fs().dockToRail([tid], { railId: id, kind: 'row', insertAt: Math.max(0, Math.min(rowSlots.length, w.at ?? rowSlots.length)), row: w.row })
    }
    if (fs().nodes[tid]?.railDock?.railId === id) added.push(tid)
    else fs().deleteFreeNode(tid)
  }
  for (const q of setEffects) {
    const n = fs().nodes[q.id]
    if (n?.effect) fs().updateFreeNode(q.id, { effect: { ...n.effect, ...q.patch, params: { ...n.effect.params, ...q.patch.params } } })
  }
  for (const m of move) {
    const n = fs().nodes[m.id]
    const slotId = n?.type === 'effect' && n.railDock?.railId === id ? n.railDock.slotId : m.id
    const rows = railRows(rail().rail)
    const from = rows.findIndex(r => r.some(sl => sl.id === slotId))
    if (from < 0) throw new Error(`move: nothing "${m.id}" on this strip.`)
    const row = m.row ?? from
    if (!rows[row]) throw new Error(`No look row ${row} on this strip.`)
    fs().moveRailSlot(id, slotId, Math.max(0, Math.min(rows[row].length, m.at)), row)
  }
  for (const r of remove) {
    const n = fs().nodes[r]
    if (n?.type === 'effect') { fs().undockFromRail(r); fs().deleteFreeNode(r) }
    else fs().removeRailSlot(id, r)
  }
  // Cards taken off are set down in a row just under the strip.
  let off = 0
  const gap = RAIL_GEOM.gap * (rail().rail.unit || 1)
  let x = rail().x
  // (Under the results, when those are set down too.)
  const drop = args.emptyResults ? Math.max(0, ...Object.values(fs().nodes).filter(n => n.railDock?.railId === id && n.railDock.slotId === RAIL_TRAY).map(n => (n.railDock?.prevH ?? n.height) + gap)) : 0
  for (const cid of undock) {
    const t = Object.values(fs().nodes).find(n => n.cardRef === cid && n.railDock?.railId === id)
    if (!t) continue
    const w = t.railDock?.prevW ?? t.width
    fs().undockFromRail(t.id)
    placeCard(cid, x, rail().y + rail().height + gap * 2 + drop)
    x += w + gap
    off++
  }
  if (args.emptyResults) fs().clearRailTray(id)
  // The strip lays itself out on the next frame.
  await new Promise(r => setTimeout(r, 120))
  return { ...stripOut(rail()), ...(newCols.length ? { newColumns: newCols } : {}), ...(added.length ? { addedEffects: added } : {}), ...(dock.length ? { docked } : {}), ...(undock.length ? { takenOff: off } : {}), undo: 'One undo (Ctrl+Z) takes it back.' }
}

/** Run a loop strip, or stop it. A run goes on after this answers. */
async function runStrip(args: Json): Promise<Json> {
  const rail = stripNamed(args.toolId)
  const id = rail.id
  if (args.do === 'stop') {
    stopRail(id)
    agentPoint(say(args, 'Stopping the run'), stripMid(rail))
  } else {
    if (isRailRunning(id)) throw new Error('This strip is already running. read_loop_strip says how far it is; do: stop stops it.')
    const total = railComboCount(rail, railMembers(useFreeNodeStore.getState().nodes).get(id))
    if (total === 0) throw new Error('Nothing to run: dock picture cards in the first column first.')
    if (total > STRIP_RUN_MOST) throw new Error(`This run would make ${total} results. More than ${STRIP_RUN_MOST} is for the artist to start, from the strip's own Run arrow.`)
    await agentGlide(say(args, `Running the loop strip (${total})`), stripMid(rail))
    void runRail(id)
  }
  // A short run is over before this answers; a long one is read again later.
  const t0 = Date.now()
  await new Promise(r => setTimeout(r, 150))
  while (isRailRunning(id) && Date.now() - t0 < 12_000) await new Promise(r => setTimeout(r, 200))
  const out = stripOut(stripNamed(id))
  return { ...out, ...(isRailRunning(id) ? { stillRunning: 'It goes on. read_loop_strip says how far it is and what has landed.' } : {}) }
}

// ── The door ────────────────────────────────────────────────────────────

const OPS: Record<string, (args: Json) => Json | Promise<Json>> = { list: listCards, read: readCards, decks: listDecks, media: cardMedia, deal: dealDeck,
  edit: editCards, arrange: arrangeCards, deck: setDeck, link: linkCards, delete: deleteCards, select: selectCards, undo: undoLast,
  tools: listTools, place: placeTool, set3d: make3dSet, stand3d, gif: makeGifOf, movie: makeMovieOf, cut: addToCut,
  states: readStates, statesBuild: buildStates, statesEdit: editStates, statesRun: runStates,
  story: readStoryline, storyBuild: buildStoryline, storyEdit: editStoryline,
  scene: readScene, sceneEdit: editScene,
  viewRead: readView, viewMove: moveView,
  stripRead: readStrip, stripEdit: editStrip, stripRun: runStrip,
  viewerRead: readViewer, viewerShow: showInViewer,
  cutRead: readCut, cutEdit: editCut, cutPicks: picksDeck,
  fxList: listEffects, fxRead: readEffects, fxAdd: addEffects, fxEdit: editEffects, fxSave: saveEffects,
  set3dRead: read3dSet, set3dAdd: addTo3dSet, pathDraw: drawPath, pathEdit: editPath, pathPlay: playPaths,
}

/** Start answering the connector. Only where the dev server's socket is
 *  (always, as VidBars runs: the desktop window is the dev server's page). */
export function startAgentDoor(): void {
  const hot = import.meta.hot
  if (!hot) return
  const hello = () => hot.send('vidbars:agent-hello', { desktop: 'vidbarsDesktop' in window })
  hot.on('vidbars:agent-do', async (msg: { id: string; op: string; args?: Json }) => {
    let reply: Json
    try {
      const op = OPS[msg.op]
      if (!op) throw new Error(`Unknown request: ${msg.op}`)
      reply = { id: msg.id, ok: true, result: await op(msg.args ?? {}) }
    } catch (e) {
      reply = { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    hot.send('vidbars:agent-done', reply)
  })
  // The server asks who is there when it has lost track (it restarted).
  hot.on('vidbars:agent-who', hello)
  hello()
}
