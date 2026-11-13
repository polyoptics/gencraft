// styleCard.ts — a STYLE card (Brian 2026-11-13): a loop strip's look, made
// into a card you can carry.
//
// The look is the strip's recipe without its cast: the effect cards in
// order, what is tucked under them, their look rows, and the pictures a
// blend mixes in (a paper, a texture: part of the look, not the subject).
// Any picture or clip can then be put through it: the look mixer does, a
// shot at a time, with each shot's own settings on top.
//
// The face is what the strip made when the card was made. The back lists
// the effects it holds, in words, as one detail; the recipe itself rides
// on the card (`style`) and is never shown raw.

import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useRailRunStore } from '../store/railRunStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { EFFECTS, knownKind } from './fx/effects'
import type { ChainItem } from './fx/chain'
import { railComboAt, railFaceCombo } from './fx/railChain'
import { isRail, railMembers } from './rail'
import { cardFaceSize, createMediaCard } from './cardGrid'
import { markNew } from './newCards'
import { newDetailId } from './cardTypes'

/** What a Style card carries: the strip's chain without its subject. */
export interface StyleData {
  items: ChainItem[]
  /** The strip it was made from (its name then), for the record. */
  from?: string
}

type Effect = Extract<ChainItem, { kind: 'effect' }>

/** The look's effects in words, in order, one line each: tucked inputs
 *  after their card, look rows after the Combine card, the picture a blend
 *  mixes in after the blend. Switched-off cards are left out. */
export function styleEffectLines(items: ChainItem[]): string[] {
  const out: string[] = []
  const name = (k: string) => EFFECTS[knownKind(k as never)].label
  const walk = (list: ChainItem[], indent: string) => {
    list.forEach((it, i) => {
      if (it.kind !== 'effect' || it.off) return
      let line = indent + name(it.effect)
      const ins = (it.inputs ?? []).filter(x => !x.off).map(x => name(x.effect))
      if (ins.length) line += ` (with ${ins.join(', ')})`
      const next = list[i + 1]
      if (EFFECTS[knownKind(it.effect)].blend && next?.kind === 'source') line += `: ${next.label || 'a picture'}`
      out.push(line)
      ;(it.rows ?? []).forEach((row, r) => {
        const on = row.filter(x => !x.off)
        if (on.length) { out.push(`${indent}  Look ${r + 2}:`); walk(on, indent + '    ') }
      })
    })
  }
  walk(items, '')
  return out
}

/** The Effects detail's value: the lines, one after another. */
export const styleEffectsText = (items: ChainItem[]): string => styleEffectLines(items).map(l => l.trim()).join(' · ')

/** Every effect in a look, nested ones too (inputs, look rows), in order:
 *  what the mixer's side panel lists. */
export function styleEffects(items: ChainItem[]): { id: string; effect: Effect['effect']; params?: Record<string, number>; text?: string; off?: boolean; depth: number }[] {
  const out: ReturnType<typeof styleEffects> = []
  const walk = (list: ChainItem[], depth: number) => {
    for (const it of list) {
      if (it.kind !== 'effect') continue
      out.push({ id: it.id, effect: it.effect, params: it.params, text: it.text, off: it.off, depth })
      for (const x of it.inputs ?? []) out.push({ id: x.id, effect: x.effect, params: x.params, text: x.text, off: x.off, depth: depth + 1 })
      for (const row of it.rows ?? []) walk(row, depth + 1)
    }
  }
  walk(items, 0)
  return out
}

/** Changes to a look, per effect (by its id): slider values and a Segment
 *  card's words. */
export type StyleTweaks = Record<string, { params?: Record<string, number>; text?: string }>

/** The look with tweaks laid over it, nested effects included. */
export function tweakedItems(items: ChainItem[], tweaks: StyleTweaks | undefined): ChainItem[] {
  if (!tweaks || !Object.keys(tweaks).length) return items
  const fix = <T extends { id: string; params?: Record<string, number>; text?: string }>(x: T): T => {
    const t = tweaks[x.id]
    if (!t) return x
    return { ...x, params: { ...x.params, ...t.params }, ...(t.text !== undefined ? { text: t.text } : {}) }
  }
  const walk = (list: ChainItem[]): ChainItem[] => list.map(it => {
    if (it.kind !== 'effect') return it
    const e = fix(it)
    return {
      ...e,
      ...(it.inputs ? { inputs: it.inputs.map(fix) } : {}),
      ...(it.rows ? { rows: it.rows.map(r => walk(r) as Effect[]) } : {}),
    }
  })
  return walk(items)
}

/** A Style card's look, if it is one. */
export const styleOf = (g: ProjectGroup | undefined): StyleData | null => (g?.style?.items?.length ? g.style : null)

/** The Effects row (and the strip's name) on a Style card's back. */
function styleDetails(items: ChainItem[], from?: string) {
  return [
    { id: newDetailId(), name: 'Effects', value: styleEffectsText(items) },
    ...(from ? [{ id: newDetailId(), name: 'Made from', value: from }] : []),
  ]
}

/** Put a Style card's look (after the mixer saved tweaks into it) and keep
 *  its Effects row in step. */
export function setStyleItems(groupId: string, items: ChainItem[]): void {
  useBoardsStore.setState(s => ({
    groups: s.groups.map(g => {
      if (g.id !== groupId || !g.style) return g
      const text = styleEffectsText(items)
      const details = (g.details ?? []).map(d => (d.name === 'Effects' && !d.link ? { ...d, value: text } : d))
      return { ...g, style: { ...g.style, items }, details }
    }),
  }))
}

/** Make a Style card from a loop strip: its look as it is now, the face its
 *  current result, set down just below the strip. Resolves the card's id,
 *  or why not. One undo step. */
export async function makeStyleCard(railId: string): Promise<{ id: string } | { error: string }> {
  const nodes = useFreeNodeStore.getState().nodes
  const rail = nodes[railId]
  if (!isRail(rail)) return { error: 'Not a loop strip' }
  const members = railMembers(nodes).get(railId)
  const combo = railComboAt(rail, members, railFaceCombo(rail, members))
  if (!combo) return { error: 'Put a picture and some effect cards on the strip first' }
  const items = combo.items.slice(1)
  if (!items.some(it => it.kind === 'effect')) return { error: 'The strip has no effect cards yet' }
  // The face: what the strip shows now, as a picture of its own.
  const canvas = useRailRunStore.getState().preview[railId]?.canvas
  let face: string | null = null
  if (canvas && canvas.width > 0) {
    const k = Math.min(1, 1024 / Math.max(canvas.width, canvas.height))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(canvas.width * k)); c.height = Math.max(1, Math.round(canvas.height * k))
    c.getContext('2d')!.drawImage(canvas, 0, 0, c.width, c.height)
    face = c.toDataURL('image/jpeg', 0.9)
  }
  const from = rail.label && rail.label !== 'Loop strip' ? rail.label : undefined
  const name = from ? `${from} style` : 'Style'
  const size = cardFaceSize()
  // Below the strip's left end, clear of it by half a card.
  const at = { cx: rail.x + size.w / 2, cy: rail.y + rail.height + size.h }
  useUndoCoordinator.getState().checkpoint()
  let id: string | null
  if (face) id = createMediaCard(at, [{ media: { url: face, type: 'image', originalName: `${name}.jpg` }, label: name }])
  else {
    const { createTextCard } = await import('./cardGrid')
    id = createTextCard(at, { title: name })
  }
  if (!id) return { error: 'The card could not be made' }
  const st = useBoardsStore.getState()
  st.setCardsType([id], 'style')
  useBoardsStore.setState(s => ({
    groups: s.groups.map(g => (g.id === id ? { ...g, name, style: { items, from }, details: styleDetails(items, from) } : g)),
  }))
  markNew([id])
  return { id }
}
