// Replace a card in all its charts (Brian 2026-11-06). A card dragged onto a
// master card that charts show (utils/chartCard, utils/linkedCards), let go
// with Shift held, takes that card's place and its links: its spot and deck,
// every chart and faction it is a member of, and every linked card showing
// it, which now shows the new card. A plain drop never replaces. The old
// card goes to where the dragged card was picked up, as a plain card. The
// press took the undo checkpoint: one Ctrl+Z puts it all back.

import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useFreeNodeStore } from '../store/freeNodeStore'

/** How many charts show card `id` (folded or out). */
export function chartsShowing(groups: ProjectGroup[], id: string): number {
  return groups.filter(g => g.id !== id && g.chart?.places.some(p => p.card === id)).length
}

/** Card `newId` may replace card `oldId`: two different plain cards, the old
 *  one shown in a chart, the new one no linked card itself. */
export function canReplace(groups: ProjectGroup[], newId: string, oldId: string): boolean {
  if (newId === oldId) return false
  const n = groups.find(g => g.id === newId), o = groups.find(g => g.id === oldId)
  if (!n || !o || n.linkOf || o.linkOf || n.effect || o.effect || n.pin || o.pin) return false
  return chartsShowing(groups, oldId) > 0 || groups.some(g => g.linkOf === oldId)
}

/** `v` with every id `from` (as a value or a key) made `to`; lists lose
 *  repeats that makes. */
function renamed<T>(v: T, from: string, to: string): T {
  if (v === from) return to as T
  if (Array.isArray(v)) {
    const out = v.map(x => renamed(x, from, to))
    return (out.every(x => typeof x === 'string') ? [...new Set(out)] : out) as T
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      const key = k === from ? to : k
      const val = renamed(x, from, to)
      out[key] = key in out && Array.isArray(out[key]) && Array.isArray(val) ? renamed([...out[key] as unknown[], ...val], to, to) : val
    }
    return out as T
  }
  return v
}

/** Where a card sits: its spot, size and deck. */
const PLACE = ['originX', 'originY', 'cardWidthOverride', 'cardHeightOverride', 'deckState', 'deckAnchorId', 'deckOffsetX', 'deckOffsetY', 'nestedDeck', 'deckLastFront', 'deckLock', 'deckFaceCard', 'ghostSlots', 'wasOnStoryline'] as const

/** What points at other cards (renamed when the old card is replaced). The
 *  card's blocks and its own face are not here. */
const REFS = ['linkOf', 'linkedGroupIds', 'reportsTo', 'kin', 'factionGroups', 'foldedMembers', 'chart', 'deckAnchorId', 'deckLastFront', 'deckLock', 'deckFaceCard', 'ghostSlots', 'railSource'] as const

/** The fields a linked card shares with its master (as utils/linkedCards). */
const SHARED = [
  'name', 'color', 'ownColor', 'cardType', 'details',
  'cardHeroImage', 'cardHeroTransform', 'cardSummary',
  'cardText', 'cardTextStyle', 'cardHeaderText', 'cardHeaderTextStyle',
  'textSplitRatio', 'cardStrokes',
] as const

/** Card `newId` replaces card `oldId`; the old card goes to `from` (where
 *  the new one was picked up). The caller has taken the undo checkpoint. */
export function replaceCard(oldId: string, newId: string, from: { x: number; y: number }): boolean {
  const bs = useBoardsStore.getState()
  if (!canReplace(bs.groups, newId, oldId)) return false
  const old = bs.groups.find(g => g.id === oldId)!
  const nu = bs.groups.find(g => g.id === newId)!
  const place: Partial<ProjectGroup> = {}
  for (const k of PLACE) (place as Record<string, unknown>)[k] = renamed(old[k], oldId, newId)

  useBoardsStore.setState(s => ({
    groups: s.groups.map((g): ProjectGroup => {
      if (g.id === oldId) {
        // A plain card where the new one came from: no deck, no links.
        const out: ProjectGroup = { ...g, originX: from.x, originY: from.y, linkedGroupIds: [] }
        for (const k of ['deckState', 'deckAnchorId', 'deckOffsetX', 'deckOffsetY', 'nestedDeck', 'deckLastFront', 'deckLock', 'deckFaceCard', 'ghostSlots', 'wasOnStoryline'] as const) delete out[k]
        return out
      }
      // The new card's old deck forgets it.
      let h: ProjectGroup = g
      if (g.id !== newId) {
        if (h.deckLastFront === newId) h = { ...h, deckLastFront: undefined }
        if (h.deckFaceCard === newId) h = { ...h, deckFaceCard: undefined }
        if (h.ghostSlots?.some(x => x.cardId === newId)) h = { ...h, ghostSlots: h.ghostSlots.filter(x => x.cardId !== newId) }
      }
      const r: Partial<ProjectGroup> = {}
      for (const k of REFS) if (h[k] !== undefined) (r as Record<string, unknown>)[k] = renamed(h[k], oldId, newId)
      if (g.id === newId) {
        const links = [...new Set([...(nu.linkedGroupIds ?? []), ...(old.linkedGroupIds ?? [])])].filter(x => x !== newId && x !== oldId)
        return { ...h, ...r, ...place, linkedGroupIds: links } as ProjectGroup
      }
      const out = { ...h, ...r } as ProjectGroup
      // A linked card showing the old card now shows the new one.
      if (g.linkOf === oldId) for (const k of SHARED) (out as unknown as Record<string, unknown>)[k] = nu[k]
      return out
    }),
  }))

  // Storylines with the old card on a dot hold the new one there.
  const fs = useFreeNodeStore.getState()
  for (const n of Object.values(fs.nodes)) {
    const d = n.storyline
    if (d?.dots.some(p => p.cards?.includes(oldId))) fs.updateFreeNode(n.id, { storyline: { ...d, dots: d.dots.map(p => ({ ...p, cards: p.cards ? [...new Set(p.cards.map(c => c === oldId ? newId : c))] : p.cards })) } })
  }

  // Linked cards out on the canvas take copies of the new card's blocks.
  const fresh = useBoardsStore.getState()
  const src = fresh.groups.find(g => g.id === newId)
  if (src && src.boardIds.length) {
    for (const copy of fresh.groups.filter(g => g.linkOf === newId)) {
      const was = copy.boardIds
      const dup = src.boardIds.map(bid => useBoardsStore.getState().duplicateBoard(bid))
      const faceAt = src.faceBoardId ? src.boardIds.indexOf(src.faceBoardId) : -1
      useBoardsStore.setState(s => ({
        groups: s.groups.map(g => g.id === copy.id
          ? { ...g, boardIds: dup, faceBoardId: faceAt >= 0 ? dup[faceAt] : undefined }
          : { ...g, boardIds: g.boardIds.filter(b => !dup.includes(b)) }),
      }))
      for (const bid of was) useBoardsStore.getState().deleteBoard(bid)
    }
  }
  return true
}

// ── The hint while dragging ──────────────────────────────────────────────
// Over a card charts show: "Hold Shift to replace in N charts" by the
// pointer, the card outlined. With Shift held the hint and outline light up
// (the words stay the same).

let tip: HTMLDivElement | null = null
let ring: HTMLStyleElement | null = null

/** Shows the hint for card `oldId` at the pointer, or hides it (null). */
export function showReplaceHint(at: { x: number; y: number; oldId: string; shift: boolean } | null): void {
  if (!at) { tip?.remove(); ring?.remove(); tip = null; ring = null; return }
  const n = chartsShowing(useBoardsStore.getState().groups, at.oldId)
  if (!tip) {
    tip = document.createElement('div')
    tip.setAttribute('data-replace-hint', '')
    Object.assign(tip.style, {
      position: 'fixed', zIndex: '100000', pointerEvents: 'none', whiteSpace: 'nowrap',
      font: '500 12px/1 system-ui, sans-serif', padding: '6px 9px', borderRadius: '6px',
      background: 'rgba(16,18,30,0.94)', border: '1px solid', boxShadow: '0 2px 10px rgba(0,0,0,0.45)',
    } as CSSStyleDeclaration)
    document.body.appendChild(tip)
  }
  if (!ring) { ring = document.createElement('style'); document.head.appendChild(ring) }
  tip.textContent = n > 0 ? `Hold Shift to replace in ${n} chart${n === 1 ? '' : 's'}` : 'Hold Shift to replace in its linked cards'
  tip.style.left = `${at.x + 18}px`
  tip.style.top = `${at.y + 20}px`
  tip.style.color = at.shift ? '#ffe7a3' : '#c9d1e3'
  tip.style.borderColor = at.shift ? '#f2c14e' : 'rgba(255,255,255,0.18)'
  ring.textContent = `[data-layer-card="${at.oldId}"] { outline: 2px ${at.shift ? 'solid #f2c14e' : 'dashed rgba(242,193,78,0.55)'} !important; outline-offset: 3px; }`
}
