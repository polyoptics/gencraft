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
// It never edits, moves or deletes a card that is already there: there is
// no request for it, so no way to ask. (Brian 2026-11-18: widened for
// passing references out and taking results back as cards.)

import { useBoardsStore, type BoardData, type ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useViewport3DStore } from '../store/viewport3dStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { canvasObstacleGroups, cardVisualRect, cardsTouch, isHiddenDeckMember } from '../hooks/useCardDecks'
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

// ── The door ────────────────────────────────────────────────────────────

const OPS: Record<string, (args: Json) => Json | Promise<Json>> = { list: listCards, read: readCards, decks: listDecks, media: cardMedia, deal: dealDeck }

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
