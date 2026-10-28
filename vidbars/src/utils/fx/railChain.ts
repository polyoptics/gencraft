// railChain.ts — how a loop strip (utils/rail) reads as an effect chain.
//
// The rail's slots, left to right, are an equation:
//
//   [Pictures] [Ink] [×] [Paper] [Glow]
//
// The FIRST role column is the SUBJECT: every combination starts from one
// of its pictures. A role column placed directly after a BLEND card
// (multiply, screen, overlay — EFFECTS[k].blend) is that card's PARTNER:
// what it mixes in. Any other role column takes no part (railWarnings says
// so on it). Effect cards apply in slot order — so above, each picture P
// and each paper Q come out as glow(multiply(ink(P), Q)).
//
// That is exactly an effect strip read by utils/fx/chain (planChain): one
// leading source, then the effects, a blend consuming the source right
// after it. So a combination is turned into ChainItems and run by the same
// runChain the strips use — the rail adds no second pipeline.
//
// Each column contributes its cards ('each') or only its face-up card, the
// last in the cascade ('pick'). A docked CARD (utils/railCards) is all of
// its pictures under 'each', its face under 'pick'. The run makes one result per combination:
// the product over the subject and partner columns. An EMPTY partner column
// counts once, with nothing to mix in (the blend then passes the picture
// through), so a strip can be tried before its texture is docked.
//
// Pure apart from the poster map default: reads the nodes it is given.

import type { FreeNodeData } from '../../store/freeNodeStore'
import { usePosterMapStore } from '../../three/posterService'
import { isRail, isRailPicture, type RailSlot } from '../rail'
import { railUnits, unitCard, unitOwner } from '../railCards'
import type { ChainItem } from './chain'
import { EFFECTS, effectKindOf } from './effects'

type Members = Map<string, FreeNodeData[]> | undefined
type SourceItem = Extract<ChainItem, { kind: 'source' }>

/** One live slot of the recipe. Card slots whose card has left are skipped,
 *  as the layout skips them — so "directly after" means after on screen. */
type Step =
  | { kind: 'role'; slot: RailSlot; cards: FreeNodeData[] }
  | { kind: 'card'; slot: RailSlot; card: FreeNodeData }

interface Reading {
  steps: Step[]
  /** The subject's role step, or null when the rail has no role slot. */
  subject: Extract<Step, { kind: 'role' }> | null
  /** Role slot id → the blend card slot id it feeds. */
  partners: Record<string, string>
  /** Blend card slot id → its partner role step. */
  partnerOf: Map<string, Extract<Step, { kind: 'role' }>>
  ignored: string[]
}

function isBlend(card: FreeNodeData): boolean {
  return !!EFFECTS[effectKindOf(card)].blend
}

function read(rail: FreeNodeData, members: Members): Reading {
  const out: Reading = { steps: [], subject: null, partners: {}, partnerOf: new Map(), ignored: [] }
  if (!isRail(rail)) return out
  for (const slot of rail.rail.slots) {
    const docked = members?.get(slot.id) ?? []
    if (slot.kind === 'card') {
      // Only an effect card can stand in a card slot; anything else there
      // (a stale dock) is no operator.
      const card = docked[0]
      if (card && card.type === 'effect') out.steps.push({ kind: 'card', slot, card })
    } else {
      // The run takes pictures only; anything else in a column is passed by.
      // A 'pick' column is its face-up card or nothing — the card the user
      // sees on top, not the last PICTURE (one still uploading has no url).
      const face = docked[docked.length - 1]
      const mode = slot.mode === 'pick' ? 'pick' : 'each'
      const cards = (mode === 'each' ? docked : face ? [face] : [])
        .flatMap(n => railUnits(n, mode)).filter(isRailPicture)
      out.steps.push({ kind: 'role', slot, cards })
    }
  }
  out.steps.forEach((s, i) => {
    if (s.kind !== 'role') return
    if (!out.subject) { out.subject = s; return }
    const prev = out.steps[i - 1]
    if (prev?.kind === 'card' && isBlend(prev.card)) {
      out.partners[s.slot.id] = prev.slot.id
      out.partnerOf.set(prev.slot.id, s)
    } else {
      out.ignored.push(s.slot.id)
    }
  })
  return out
}

/** The cards of a column the run takes: all of them ('each'), or only the
 *  face-up one — the last in the cascade ('pick'). */
function usedCards(step: Extract<Step, { kind: 'role' }>): FreeNodeData[] {
  return step.cards
}

/** A picture as a chain source — as an effect strip reads it (useFxStrips'
 *  stripItem): an image by its url, a video by its poster frame, the LIVE
 *  poster map first (the node's own copy can be a dead reference after a
 *  template or project load). A video with no poster yet gets an empty url,
 *  which the run reports as unreadable rather than skipping silently. */
function sourceItem(n: FreeNodeData, posters: Record<string, string>): SourceItem {
  // A chosen thumbnail (a data: url, "Set as thumbnail") first: it is the
  // frame the user picked. Else the live poster map, then the node's copy.
  const url = n.type === 'video'
    ? (n.posterUrl?.startsWith('data:') ? n.posterUrl : undefined) ?? (n.imageUrl ? posters[n.imageUrl] : undefined) ?? n.posterUrl ?? ''
    : n.imageUrl ?? ''
  return { id: n.id, kind: 'source', url, label: n.label }
}

/** Which role slots the run reads, and as what: `subject` is the first role
 *  slot's id; `partners` maps a role slot id to the blend CARD slot id whose
 *  mix-in it is; `ignored` lists role slots the run passes by. */
export function railColumns(rail: FreeNodeData, members: Members): { subject: string | null; partners: Record<string, string>; ignored: string[] } {
  const r = read(rail, members)
  return { subject: r.subject?.slot.id ?? null, partners: r.partners, ignored: r.ignored }
}

/** The columns a combination picks from, in slot order (subject first), each
 *  with its radix. An empty partner counts once (nothing to mix in). */
function radixColumns(r: Reading): { step: Extract<Step, { kind: 'role' }>; used: FreeNodeData[]; radix: number }[] {
  if (!r.subject) return []
  const cols = [r.subject, ...r.steps.filter((s): s is Extract<Step, { kind: 'role' }> => s.kind === 'role' && s.slot.id in r.partners)]
  return cols.map((step, i) => {
    const used = usedCards(step)
    return { step, used, radix: i === 0 ? used.length : Math.max(1, used.length) }
  })
}

/** The combination the strip's live preview shows: the subject column's
 *  face-up card as its face shows it — stepping a docked card to its third
 *  picture previews the third result — with the first of each partner. */
export function railFaceCombo(rail: FreeNodeData, members: Members): number {
  const r = read(rail, members)
  const cols = radixColumns(r)
  if (cols.length === 0 || !r.subject) return 0
  const docked = members?.get(r.subject.slot.id) ?? []
  const face = docked[docked.length - 1]
  if (!face) return 0
  const unit = railUnits(face, 'pick')[0]
  const at = unit ? cols[0].used.findIndex(u => u.id === unit.id) : -1
  if (at < 0) return 0
  return at * cols.slice(1).reduce((n, c) => n * c.radix, 1)
}

/** How many results a run makes: the product over the subject and partner
 *  columns ('each' → its card count, 'pick' → 1). 0 while the subject
 *  column is empty. */
export function railComboCount(rail: FreeNodeData, members: Members): number {
  const cols = radixColumns(read(rail, members))
  if (cols.length === 0) return 0
  return cols.reduce((n, c) => n * c.radix, 1)
}

/** Combination `index` (0 ≤ index < railComboCount) as chain items, in slot
 *  order: the subject's picture, then every effect card, each blend card
 *  followed by its partner's picture. Mixed radix over the columns in slot
 *  order with the LAST varying fastest — so results come subject by
 *  subject, the way the tray then reads. `sourceIds` is the pictures used,
 *  SUBJECT FIRST, then partners in slot order — the docked tiles, so a
 *  card's picture names its card. `subjectCard` is the subject's docked
 *  card (unitCard's key) when the subject is a held card's picture. Null
 *  when out of range. */
export function railComboAt(
  rail: FreeNodeData,
  members: Members,
  index: number,
  posters: Record<string, string> = usePosterMapStore.getState().map,
): { items: ChainItem[]; label: string; sourceIds: string[]; subjectCard: string | null } | null {
  const r = read(rail, members)
  const cols = radixColumns(r)
  if (cols.length === 0 || !Number.isInteger(index) || index < 0) return null
  const total = cols.reduce((n, c) => n * c.radix, 1)
  if (index >= total) return null

  const chosen = new Map<string, FreeNodeData | null>()
  let rest = index
  for (let k = cols.length - 1; k >= 0; k--) {
    const c = cols[k]
    chosen.set(c.step.slot.id, c.used[rest % c.radix] ?? null)
    rest = Math.floor(rest / c.radix)
  }
  const subject = chosen.get(r.subject!.slot.id)
  if (!subject) return null

  const items: ChainItem[] = [sourceItem(subject, posters)]
  const sourceIds = [unitOwner(subject.id)]
  let label = subject.label || 'picture'
  for (const s of r.steps) {
    if (s.kind !== 'card') continue
    const card = s.card
    items.push({ id: card.id, kind: 'effect', effect: effectKindOf(card), params: card.effect?.params, text: card.effect?.text })
    const partnerStep = r.partnerOf.get(s.slot.id)
    const partner = partnerStep ? chosen.get(partnerStep.slot.id) : null
    if (partner) {
      // Right after its blend card: planChain hands it to that card.
      items.push(sourceItem(partner, posters))
      sourceIds.push(unitOwner(partner.id))
      // The blend's own operator glyph, so the label reads like the
      // equation on the rail: 'Harbour × Paper + Stars'.
      label += ` ${EFFECTS[effectKindOf(card)].glyph} ${partner.label || 'picture'}`
    }
  }
  return { items, label, sourceIds, subjectCard: unitCard(subject.id) }
}

/** Why part of the recipe does nothing, by slot id: role columns the run
 *  passes by, and blend cards with no column after them to mix in. */
export function railWarnings(rail: FreeNodeData, members: Members): Record<string, string> {
  const r = read(rail, members)
  const out: Record<string, string> = {}
  for (const id of r.ignored) out[id] = 'Put a ×, + or overlay card before this column'
  r.steps.forEach((s, i) => {
    if (s.kind !== 'card' || !isBlend(s.card) || r.partnerOf.has(s.slot.id)) return
    const next = r.steps[i + 1]
    out[s.slot.id] = next && next === r.subject
      // The column right after it is the subject, which is never mixed in.
      ? 'The first column is the subject — move this card after it'
      : 'Put a column right after this card for what it mixes in'
  })
  return out
}
