// gen3d.ts — the 3D generation window's job (Brian 2026-11-20): what a
// generator takes, what the window holds, and the hand-off to Claude.
//
// VidBars does not call Krea. The window only DESCRIBES a job: the cards
// docked on its side (Brian 2026-11-23: "The generator's main purpose is
// to hold the cards ... as many as I want, on the side of the generator,
// or have a deck and dock a deck beside the generator, and then just hit
// Go"), the generator and its options, the words. Generate passes that to
// the Claude in the app (utils/agentChat), which runs it on Krea through
// its connector and brings each 3D model back as a card: behind the card
// it was made from, shown by that card's Model detail (utils/bringHome).
//
// The generators, their hover text and their options are Krea's own: read
// from Krea's list (list_models, get_model_schema) and kept as Krea gave
// them. What ships here is that list as read on 2026-11-20; "Refresh from
// Krea" in the window asks Claude to read it again (agentDoor
// setGenerators), and what it brings is kept on this PC.

import { create } from 'zustand'
import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { getMediaItems } from '../types/bar'
import { cardFaceMedia } from './cardGrid'
import { sendJob } from './agentChat'
import { dockedCards } from './filmShots'
import { modelOfCard } from './area3dScene'
import { detailShown } from './cardTypes'

/** One input of a generator, as Krea's schema gives it. */
interface KreaProp {
  type?: string
  enum?: string[]
  default?: unknown
  minimum?: number
  maximum?: number
  maxItems?: number
  description?: string
}

/** A generator as Krea lists it. */
export interface KreaModel {
  id: string
  name: string
  description: string
  inputSchema: { properties: Record<string, KreaProp> }
}

/** An option the window shows for a generator: a switch, a number or a pick. */
export interface GenOption {
  key: string
  label: string
  kind: 'switch' | 'number' | 'pick'
  picks?: string[]
  min?: number
  max?: number
  def?: unknown
}

/** An extra view a generator takes besides the reference picture. */
export interface GenView {
  /** Krea's field (`back_image_url`), or `image:2` for a generator that takes unnamed extra pictures. */
  key: string
  label: string
}

export interface Generator {
  id: string
  name: string
  /** Krea's own words about it: its hover text. */
  description: string
  options: GenOption[]
  views: GenView[]
}

const WORDS: Record<string, string> = { pbr: 'PBR' }
const labelOf = (key: string): string => {
  const words = key.replace(/^(generate|enable)_/, '').split('_').map(w => WORDS[w] ?? w)
  const s = words.join(' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** What the window shows for a generator, from Krea's schema for it. */
export function generatorOf(m: KreaModel): Generator {
  const props = m.inputSchema?.properties ?? {}
  const options: GenOption[] = []
  const views: GenView[] = []
  for (const [key, p] of Object.entries(props)) {
    if (key === 'prompt' || key === 'input_mode' || key === 'image_urls') continue
    const view = /^(.+)_image_url$/.exec(key)
    if (view) { views.push({ key, label: labelOf(view[1]) }); continue }
    if (p.type === 'boolean') options.push({ key, label: labelOf(key), kind: 'switch', def: p.default })
    else if (p.enum?.length) options.push({ key, label: labelOf(key), kind: 'pick', picks: p.enum, def: p.default })
    else if (p.type === 'number' || p.type === 'integer') options.push({ key, label: labelOf(key), kind: 'number', min: p.minimum, max: p.maximum, def: p.default })
  }
  // No named views, but more than one picture taken: the rest are views too.
  const many = props.image_urls?.maxItems ?? 1
  if (!views.length) for (let i = 2; i <= many; i++) views.push({ key: `image:${i}`, label: `View ${i}` })
  return { id: m.id, name: m.name, description: m.description, options, views }
}

const num = (minimum?: number, maximum?: number, def?: number): KreaProp => ({ type: 'number', ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}), ...(def !== undefined ? { default: def } : {}) })
const SEED: KreaProp = num()
const TEXTURE: KreaProp = { type: 'boolean', default: true }
const PBR: KreaProp = { type: 'boolean' }
const VIEW: KreaProp = { type: 'string' }
const pics = (maxItems?: number): KreaProp => ({ type: 'array', ...(maxItems ? { maxItems } : {}) })
const model = (id: string, name: string, description: string, properties: Record<string, KreaProp>): KreaModel =>
  ({ id, name, description, inputSchema: { properties } })

/** Krea's 3D generators as its list gave them on 2026-11-20. */
const SHIPPED: KreaModel[] = [
  model('tencent/hunyuan3d-3.1-pro', 'Hunyuan3D 3.1 Pro', 'High‑fidelity text or image‑to‑3D with optional PBR materials, multi‑view inputs, and adjustable face count for cleaner meshes.',
    { seed: SEED, generate_texture: TEXTURE, enable_pbr: PBR, face_count: num(40000, 1500000),
      back_image_url: VIEW, left_image_url: VIEW, right_image_url: VIEW, top_image_url: VIEW, bottom_image_url: VIEW, left_front_image_url: VIEW, right_front_image_url: VIEW, image_urls: pics() }),
  model('tencent/hunyuan3d-3.1-rapid', 'Hunyuan3D 3.1 Rapid', 'Fast, inexpensive tier of Hunyuan3D 3.1 for text or image-to-3D.',
    { generate_texture: TEXTURE, image_urls: pics() }),
  model('tencent/hunyuan3d-2.1', 'Hunyuan3D-2.1', 'High quality 3D model generator',
    { seed: num(undefined, undefined, 1337), generate_texture: TEXTURE, image_urls: pics() }),
  model('meshy/meshy-7.1', 'Meshy 7.1', 'Production-ready meshes from text, one image, or up to four views of the same object.',
    { seed: SEED, generate_texture: TEXTURE, target_polycount: num(100, 300000), enable_pbr: PBR, image_urls: pics(4) }),
  model('meshy/meshy-7', 'Meshy V7', 'Production-ready meshes from text or image, with clean topology and PBR-quality textures.',
    { seed: SEED, generate_texture: TEXTURE, target_polycount: num(100, 300000), enable_pbr: PBR, image_urls: pics() }),
  model('hyper3d/rodin-2.5', 'Rodin V2.5', 'Detailed, well-structured meshes with PBR materials from text or image.',
    { seed: SEED, generate_texture: TEXTURE, image_urls: pics(5) }),
  model('hyper3d/rodin-2.5-fast', 'Rodin V2.5 Fast', 'Rodin V2.5 tuned for speed and cost, for quick iteration on shapes.',
    { seed: SEED, generate_texture: TEXTURE, image_urls: pics(5) }),
  model('microsoft/trellis', 'TRELLIS', 'High quality 3D model generator',
    { seed: SEED, generate_texture: TEXTURE, texture_size: num(), image_urls: pics() }),
  model('microsoft/trellis-2', 'TRELLIS 2', 'Native 3D generative model for high-quality 3D asset creation',
    { seed: SEED, generate_texture: TEXTURE, resolution: { type: 'string', enum: ['512', '1024', '1536'] }, texture_size: { type: 'string', enum: ['1024', '2048', '4096'] }, decimation_target: num(100000, 2000000), image_urls: pics() }),
  model('tripo/tripo', 'Tripo', 'High quality 3D model generator',
    { seed: SEED, generate_texture: TEXTURE, image_urls: pics() }),
  model('tripo/h3.1', 'Tripo H3.1', "Tripo's flagship generator: sharp geometry from text or image at low cost.",
    { seed: SEED, generate_texture: TEXTURE, face_limit: num(1000, 2000000), image_urls: pics() }),
]

const KEY = 'vidbars.gen3d.generators'

function kept(): { at: string; models: KreaModel[] } | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (v && Array.isArray(v.models) && v.models.length) return v
  } catch { /* private window */ }
  return null
}

interface GeneratorsState {
  generators: Generator[]
  /** When Krea's list was last read (a date), for the window to show. */
  readAt: string
}

const start = kept()
export const useGenerators = create<GeneratorsState>(() => ({
  generators: (start?.models ?? SHIPPED).map(generatorOf),
  readAt: start?.at ?? '2026-11-20',
}))

/** Krea's list read again (Claude brings it: agentDoor setGenerators). Returns how many were taken. */
export function setGenerators(models: unknown): number {
  const ok = (Array.isArray(models) ? models : []).filter((m): m is KreaModel =>
    !!m && typeof m.id === 'string' && typeof m.name === 'string' && !!m.inputSchema && typeof m.inputSchema.properties === 'object')
    .map(m => ({ id: m.id, name: m.name, description: typeof m.description === 'string' ? m.description : '', inputSchema: { properties: m.inputSchema.properties } }))
  if (!ok.length) return 0
  const at = new Date().toISOString().slice(0, 10)
  try { localStorage.setItem(KEY, JSON.stringify({ at, models: ok })) } catch { /* private window */ }
  useGenerators.setState({ generators: ok.map(generatorOf), readAt: at })
  return ok.length
}

// ── What a window holds ─────────────────────────────────────────────────

/** A 3D generation window's own settings (FreeNodeData.gen3d). Its words
 *  are the node's `text`; its cards are the ones docked on it, worked out
 *  from where they are (genCards), never stored. */
export interface Gen3dState {
  /** Krea's id of the generator picked. Absent: the first in the list. */
  generator?: string
  /** Option values by Krea's field, per generator id, so each generator keeps its own. */
  opts?: Record<string, Record<string, number | boolean | string>>
  /** The chat box the last job was passed to. */
  box?: string
}

export function patchGen(nodeId: string, patch: Partial<Gen3dState>): void {
  const n = useFreeNodeStore.getState().nodes[nodeId]
  if (!n) return
  useFreeNodeStore.getState().updateFreeNode(nodeId, { gen3d: { ...n.gen3d, ...patch } })
}

/** A card's "+" let go on a window row (LinkDragOverlay "gen:"): the window
 *  has had no such rows since its cards are docked (2026-11-23). Nothing. */
export function linkGenCard(_nodeId: string, _slot: string, _cardId: string): void { /* no rows to link to */ }

export function generatorFor(node: FreeNodeData | undefined, list: Generator[]): Generator | undefined {
  return list.find(g => g.id === node?.gen3d?.generator) ?? list[0]
}

/** A generator's face limit, whatever Krea calls it for that one (face
 *  limit, face count, target polycount, decimation target). */
export const facesOption = (gen: Generator | undefined): GenOption | undefined =>
  gen?.options.find(o => o.kind === 'number' && /face|poly|decimation/.test(o.key))
/** A generator's texture switch. */
export const textureOption = (gen: Generator | undefined): GenOption | undefined =>
  gen?.options.find(o => o.kind === 'switch' && o.key === 'generate_texture')

/** Does the card's face hold a picture to send? */
export function facePicture(g: ProjectGroup | undefined): boolean {
  if (!g) return false
  const m = cardFaceMedia(g, useBoardsStore.getState().boards)
  return !!m && (m.type === 'image' || !!m.posterUrl)
}

/** Does the card's Model detail already show a 3D model's card? */
function hasModel(g: ProjectGroup, groups: ProjectGroup[]): boolean {
  const { boards } = useBoardsStore.getState()
  return !!g.details?.some(d => {
    if (d.name.trim().toLowerCase() !== 'model' || !d.link || d.link.detail || d.link.count || d.link.rankOf) return false
    const c = detailShown(groups, d).card
    return !!c && !!modelOfCard(c, boards)
  })
}

/** The cards docked on a window, sorted for Generate: `make` get a 3D
 *  model each, in reading order; `have` already show one in their Model
 *  detail and are left alone; `plain` have no picture on their face. A
 *  card that IS a 3D model (one made here, sitting behind its card) is
 *  not counted at all. */
export function genCards(node: FreeNodeData | undefined): { make: ProjectGroup[]; have: ProjectGroup[]; plain: ProjectGroup[] } {
  const out = { make: [] as ProjectGroup[], have: [] as ProjectGroup[], plain: [] as ProjectGroup[] }
  if (!node) return out
  const { groups, boards } = useBoardsStore.getState()
  for (const g of dockedCards(node, groups, boards)) {
    if (g.effect || modelOfCard(g, boards)) continue
    if (hasModel(g, groups)) out.have.push(g)
    else if (!facePicture(g)) out.plain.push(g)
    else out.make.push(g)
  }
  return out
}

/** The block of a card that holds its face picture, by name, for Claude to pick the right file. */
function faceBlock(g: ProjectGroup): string | null {
  const { boards } = useBoardsStore.getState()
  const m = cardFaceMedia(g, boards)
  if (!m) return null
  for (const bid of g.boardIds) {
    const b = boards[bid]
    for (const rid of b?.rootIds ?? []) {
      const bar = b.bars[rid]
      if (bar && getMediaItems(bar.content).some(x => x.url === m.url)) return bar.name
    }
  }
  return null
}

const cardLine = (g: ProjectGroup): string => {
  const block = faceBlock(g)
  return `card ${g.id} "${g.name}"${block ? ` (the picture in its block "${block}")` : ' (the picture on its face)'}`
}

/** Why the job cannot run yet, in plain words, or null when it can. */
export function notReady(node: FreeNodeData | undefined): string | null {
  if (!node) return 'No window'
  const c = genCards(node)
  if (c.make.length) return null
  if (c.have.length && !c.plain.length) return c.have.length === 1 ? 'The docked card already has a 3D model' : `All ${c.have.length} docked cards already have a 3D model`
  if (c.plain.length && !c.have.length) return c.plain.length === 1 ? 'The docked card has no picture on its face' : 'The docked cards have no picture on their faces'
  if (c.have.length || c.plain.length) return 'No docked card needs a 3D model'
  if (!node.text.trim()) return 'Dock cards on its side, or write what to make'
  return null
}

/** The job in words, for Claude. */
export function jobText(nodeId: string): string | null {
  const node = useFreeNodeStore.getState().nodes[nodeId]
  const gen = generatorFor(node, useGenerators.getState().generators)
  if (!node || !gen || notReady(node)) return null
  const st = node.gen3d ?? {}
  const cards = genCards(node).make
  const opts = st.opts?.[gen.id] ?? {}
  const set = gen.options.filter(o => opts[o.key] !== undefined && opts[o.key] !== '').map(o => `${o.key}: ${JSON.stringify(opts[o.key])}`)
  const words = node.text.trim()
  const many = cards.length > 1
  const lines: string[] = [
    `A 3D generation job from the "${node.label}" window in VidBars (tool ${nodeId}). The artist pressed Generate: run it on Krea now, exactly as set here, without asking first.`,
    '',
    `Generator: ${gen.id} (${gen.name})`,
  ]
  if (cards.length) {
    lines.push(many ? `Make ONE 3D model for EACH of these ${cards.length} cards, from that card's own picture:` : 'Make one 3D model from this card\'s picture:')
    for (const g of cards) lines.push(`- ${cardLine(g)}`)
  } else {
    lines.push('No picture. This is text to 3D (input_mode "text").')
  }
  lines.push(words ? `Words (prompt)${many ? ', the same for each' : ''}: ${words}` : 'Words (prompt): none')
  lines.push(set.length ? `Options${many ? ', the same for each' : ''}: ${set.join(', ')}` : 'Options: none set, leave them to the generator')
  lines.push('', many ? 'How, for each card in turn:' : 'How:')
  if (cards.length) {
    lines.push('1. get_card_media for the card (kinds: image) and upload its picture to Krea (get_upload_url, then send_file).')
    lines.push(`2. Krea generate_3d with model ${gen.id}: that picture in image_urls, the words as prompt if there are any, and the options.`)
    lines.push('3. When it is done, deal_deck ONE new card that holds the 3D model (its preview picture as the 3D model\'s thumbnail), named "<the card\'s name> 3D", from: [that card\'s id].')
    lines.push('4. bring_home from that card\'s id with the new card, so it goes behind that card and its Model detail shows it.')
    if (many) lines.push('You may start the Krea jobs together and bring each one home as it finishes. If one fails, go on with the rest.')
  } else {
    lines.push(`1. Krea generate_3d with model ${gen.id}, input_mode "text", the words as prompt, and the options.`)
    lines.push('2. When it is done, deal_deck ONE new card that holds the 3D model (its preview picture as the 3D model\'s thumbnail), named for what it is.')
    lines.push(`3. Set that card down beside this window (tool ${nodeId}) if you can (list_tools gives its place, arrange_cards moves the card). It belongs to no card, so no bring_home.`)
  }
  lines.push('', many
    ? 'At the end say in one or two plain sentences which cards got a 3D model and which did not, and why. Do not try another generator.'
    : 'Say in one or two plain sentences what came back. If Krea refuses or fails, say why and stop; do not try another generator.')
  return lines.join('\n')
}

/** Generate: pass the window's job to Claude. Returns false when there is nothing to run. */
export function runGen(nodeId: string): boolean {
  const node = useFreeNodeStore.getState().nodes[nodeId]
  const text = jobText(nodeId)
  const gen = generatorFor(node, useGenerators.getState().generators)
  if (!node || !text || !gen) return false
  const cards = genCards(node).make
  const what = cards.length > 3 ? `${cards.length} cards` : cards.length ? cards.map(g => g.name || 'Untitled').join(', ') : node.text.trim().slice(0, 80)
  const box = sendJob(text, `Generate 3D with ${gen.name}: ${what}`)
  patchGen(nodeId, { box })
  return true
}

/** "Refresh from Krea": ask Claude to read Krea's list of 3D generators again. */
export function refreshGenerators(): void {
  sendJob([
    'Read Krea\'s list of 3D generators again for the 3D generation window in VidBars.',
    '1. Krea list_models with category "3d".',
    '2. Krea get_model_schema for each one.',
    '3. Pass them all in ONE set_generators call, each as Krea gave it: id, name, description, and inputSchema with only its properties.',
    'Nothing else: no cards, no generations. Then say how many there are.',
  ].join('\n'), 'Refresh the 3D generators from Krea')
}
