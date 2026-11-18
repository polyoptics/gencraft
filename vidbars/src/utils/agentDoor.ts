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
import { viewportCenterInCanvas } from './canvasCreate'
import { CARD_TYPES, cardTypeOf, detailShown, newDetailId, type CardDetail, type CardType } from './cardTypes'
import { factionGroupsOf } from './factionGroups'
import { getMediaItems, type MediaItem, type MediaType } from '../types/bar'
import type { SceneDiv } from './sceneCard'

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

// ── The door ────────────────────────────────────────────────────────────

const OPS: Record<string, (args: Json) => Json | Promise<Json>> = { list: listCards, read: readCards, decks: listDecks, media: cardMedia, deal: dealDeck,
  edit: editCards, arrange: arrangeCards, deck: setDeck, link: linkCards, delete: deleteCards, select: selectCards, undo: undoLast,
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
