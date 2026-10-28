// aiEffects.ts — what effects NEED besides the picture: maps a model or a
// drawing tool makes from the strip's source picture, on the desktop's GPU
// (electron/sketchWorker.cjs runs sketchLook's own tools).
//
// An effect declares them (EffectDef.needs): 'depth' (grey, near = bright),
// 'mask' (the things a Segment card names; white = found) and 'lines' (the
// film outline's four layers). runChain asks for them before it draws:
//
//   - kept by WHAT they are made from — the source picture's stored url,
//     the phrases, the drawing's dials — never by the image a step happens
//     to receive, so stepping a card face, moving a slider after the step
//     or re-running reads them back instead of recomputing;
//   - a bake (a strip's Run, a save, a drag-out) waits for them and runs
//     once; a live preview never waits: the step passes its picture through
//     unchanged, its card says "computing…", and when the result lands
//     `version` ticks so the live strips run again.
//
// Phrases for a mask come from the nearest Segment card at or before the
// step on the strip, else "person".

import { create } from 'zustand'
import type { FxEngine, Tex } from './fxEngine'
import type { EffectKind, AuxKind } from './effects'

/** The strip step, as aiEffects reads it (chain.ts's effect item). */
export interface AuxStep { id: string; effect: EffectKind; params?: Record<string, number>; text?: string }

/** A Segment card's text: one thing per line, "name: phrase, phrase".
 *  A line with no colon names itself ("dog" finds a dog). */
export function parsePhrases(text: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const line of (text ?? '').split(/\r?\n|;/)) {
    const [a, b] = line.includes(':') ? line.split(/:(.*)/s) : [line, line]
    const name = a.trim()
    const phrases = (b ?? '').split(',').map(s => s.trim()).filter(Boolean)
    if (name && phrases.length) out[name] = [...(out[name] ?? []), ...phrases]
  }
  return out
}

/** The film outline is drawn at this long edge whatever the run's size: its
 *  dials are pixel sizes tuned at about this resolution, so a bake shows
 *  the drawing the preview showed (scaled up when bigger). */
export const LINE_SIDE = 1400
/** The film outline's sliders that are the drawing's own dials (sent to the
 *  tool); its other sliders only change how the layers are shown. */
export const LINE_DIALS = ['contour_w', 'detail', 'interior_w', 'rough', 'rough_opacity', 'wobble', 'dry', 'breaks', 'restroke', 'seed', 'boil']
/** The hatch cards' sliders that are their look's own dials. */
export const HATCH_DIALS: Partial<Record<EffectKind, string[]>> = {
  formhatch: ['spacing', 'weight', 'angle', 'wrap', 'tone1', 'default.cross', 'default.light', 'light_az', 'stroke_px', 'seed', 'boil'],
  bghatch: ['spacing', 'weight', 'opacity', 'far_opacity', 'far_cut', 'paint_hi', 'cross', 'pencil', 'stroke_px', 'seed', 'boil'],
}
/** A Shading mix card's values that change nothing (the look mixer's
 *  neutral: mixer_bake.py NEUTRAL, for the hatch layers). */
export const SHADE_NEUTRAL: Record<string, number> = { hatch: 1, bg: 1, hatch_weight: 1, bg_weight: 1, hatch_dark: 0, bg_dark: 0, light: 1 }
/** A Line mix card's values that change nothing. */
export const MIX_NEUTRAL: Record<string, number> = { strength: 1, pencil: 1, ink: 1, weight: 1, dark: 0, tint: 0, light: 1 }

export interface LineColors { ink: string; paper: string; pencil: string; graphite: string; pencil_tint: number }

type Kept =
  | { imgs: Record<string, HTMLImageElement | null>; colors?: LineColors }
  | { error: string }

interface Req { key: string; what: string; job: { op: 'depth' | 'segment' | 'lines' | 'formhatch' | 'bghatch'; objects?: Record<string, string[]>; dials?: Record<string, number>; side?: number } }

// Results by what they are made from; a few dozen pictures' worth.
const kept = new Map<string, Kept>()
const asked = new Map<string, Promise<void>>()
let queue: Promise<unknown> = Promise.resolve()

/** Per step: what its card should say ('' = nothing), and a counter that
 *  ticks whenever a result lands (live strips re-run on it). */
export const useAuxStore = create<{ version: number; byStep: Record<string, string> }>(() => ({ version: 0, byStep: {} }))

function say(stepId: string, text: string) {
  const s = useAuxStore.getState()
  if ((s.byStep[stepId] ?? '') !== text) useAuxStore.setState({ byStep: { ...s.byStep, [stepId]: text } })
}

function keep(key: string, v: Kept) {
  kept.delete(key)
  kept.set(key, v)
  if (kept.size > 32) kept.delete(kept.keys().next().value!)
}

function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36) + s.length.toString(36)
}

const AUX_KINDS = new Set<EffectKind>(['depth', 'segment', 'filmline', 'linemix', 'formhatch', 'bghatch', 'shademix'])
const isAuxKind = (k: EffectKind) => AUX_KINDS.has(k)
/** Cards that read a Segment card's phrases (the things to draw). */
const READS_PHRASES = new Set<EffectKind>(['filmline', 'formhatch', 'bghatch'])
/** Whether any step on the strip needs a model or tool (so its live result
 *  can change when one lands). */
export const stripNeedsAux = (steps: { kind: string; effect?: EffectKind }[]) =>
  steps.some(s => s.kind === 'effect' && !!s.effect && isAuxKind(s.effect))

function phrasesFor(steps: AuxStep[], i: number): Record<string, string[]> | null {
  for (let j = i; j >= 0; j--) if (steps[j].effect === 'segment') return parsePhrases(steps[j].text)
  return null
}

/** A hatch card at step i: its dials, and the Shading mix cards after it
 *  folded into its strength, line weight, ink darkness and highlights. */
function hatchSetup(steps: AuxStep[], i: number) {
  const s = steps[i], p = s.params ?? {}
  const dials: Record<string, number> = {}
  for (const k of HATCH_DIALS[s.effect] ?? []) if (typeof p[k] === 'number') dials[k] = p[k]
  const bg = s.effect === 'bghatch'
  const mix = { strength: 1, weight: 1, dark: 0, light: 1 }
  for (const x of steps.slice(i + 1)) {
    if (x.effect !== 'shademix') continue
    const m = { ...SHADE_NEUTRAL, ...x.params }
    mix.strength *= bg ? m.bg : m.hatch
    mix.weight *= bg ? m.bg_weight : m.hatch_weight
    mix.dark = Math.max(-1, Math.min(1, mix.dark + (bg ? m.bg_dark : m.hatch_dark)))
    mix.light *= m.light
  }
  return { dials, mix }
}

/** The film outline at step i: its dials, and the Line mix cards after it
 *  (up to the next outline) folded into one set of mix values. */
function lineSetup(steps: AuxStep[], i: number) {
  const p = steps[i].params ?? {}
  const dials: Record<string, number> = {}
  for (const k of LINE_DIALS) if (typeof p[k] === 'number') dials[k] = p[k]
  const mix = { ...MIX_NEUTRAL }
  for (let j = i + 1; j < steps.length && steps[j].effect !== 'filmline'; j++) {
    if (steps[j].effect !== 'linemix') continue
    const m = { ...MIX_NEUTRAL, ...steps[j].params }
    mix.strength *= m.strength; mix.pencil *= m.pencil; mix.ink *= m.ink; mix.weight *= m.weight
    mix.dark = Math.max(-1, Math.min(1, mix.dark + m.dark)); mix.tint = Math.max(mix.tint, m.tint); mix.light *= m.light
  }
  return { dials, mix }
}

/** What step i asks for, for the source with this url. [] = nothing, null =
 *  it cannot run (its card says why). */
function requests(steps: AuxStep[], i: number, url: string): Req[] | null {
  const s = steps[i], src = hash(url)
  if (s.effect === 'depth') return [{ key: `depth|${src}`, what: 'depth', job: { op: 'depth' } }]
  if (s.effect === 'segment') {
    const objects = parsePhrases(s.text)
    if (!Object.keys(objects).length) { say(s.id, 'Name something to find'); return null }
    return [{ key: `mask|${src}|${JSON.stringify(objects)}`, what: 'mask', job: { op: 'segment', objects } }]
  }
  if (s.effect === 'formhatch' || s.effect === 'bghatch') {
    // The figure hatch needs the things to hatch ("person" without a
    // Segment card); the background's subject is optional: without a
    // Segment card the whole picture is background.
    const objects = phrasesFor(steps, i) ?? (s.effect === 'formhatch' ? { person: ['person'] } : undefined)
    const { dials } = hatchSetup(steps, i)
    return [{ key: `${s.effect}|${src}|${JSON.stringify(objects ?? null)}|${JSON.stringify(dials)}|${LINE_SIDE}`,
      what: s.effect === 'formhatch' ? 'hatching' : 'background hatching',
      job: { op: s.effect, objects, dials, side: LINE_SIDE } }]
  }
  if (s.effect === 'shademix') {
    if (!steps.slice(0, i).some(x => x.effect === 'formhatch' || x.effect === 'bghatch')) { say(s.id, 'Put a hatch card before it'); return null }
    say(s.id, '')
    return []
  }
  if (s.effect === 'filmline') {
    const objects = phrasesFor(steps, i) ?? { person: ['person'] }
    const { dials } = lineSetup(steps, i)
    return [{ key: `lines|${src}|${JSON.stringify(objects)}|${JSON.stringify(dials)}|${LINE_SIDE}`, what: 'outline',
      job: { op: 'lines', objects, dials, side: LINE_SIDE } }]
  }
  if (s.effect === 'linemix') {
    if (!steps.slice(0, i).some(x => x.effect === 'filmline')) { say(s.id, 'Put a Film outline before it'); return null }
    say(s.id, '')
    return []
  }
  return []
}

function pictureOf(img: HTMLImageElement): string {
  const k = Math.min(1, 4096 / Math.max(img.naturalWidth, img.naturalHeight))
  const c = document.createElement('canvas')
  c.width = Math.round(img.naturalWidth * k)
  c.height = Math.round(img.naturalHeight * k)
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/png')
}

function decode(url: string | undefined): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null)
  const img = new Image()
  img.src = url
  return img.decode().then(() => img, () => null)
}

function ask(r: Req, img: HTMLImageElement): Promise<void> {
  const hit = asked.get(r.key)
  if (hit) return hit
  const p = (queue = queue.then(async () => {
    const run = window.vidbarsDesktop?.sketchRun
    if (!run) { keep(r.key, { error: 'Runs in the VidBars desktop app' }); return }
    const res = await run({ ...r.job, frames: [pictureOf(img)] })
    if (res.error) { console.warn(`[fx] ${r.what}:`, res.error, res.log); keep(r.key, { error: res.error }); return }
    if (r.job.op === 'depth') keep(r.key, { imgs: { depth: await decode(res.frames?.[0] as string | undefined) } })
    else if (r.job.op === 'segment') keep(r.key, { imgs: { mask: await decode(res.objects?.figure?.[0]) } })
    else {
      // A drawing: its layers by name (lines: outline, inside, paper,
      // pencil; formhatch: a k b h; bghatch: a k p).
      const f = (res.frames?.[0] ?? {}) as Record<string, string>
      const imgs = Object.fromEntries(await Promise.all(Object.entries(f).map(async ([n, u]) => [n, await decode(u)] as const)))
      keep(r.key, { imgs, colors: res.colors as unknown as LineColors })
    }
  }).catch(err => keep(r.key, { error: String(err?.message ?? err) }))
    .finally(() => { asked.delete(r.key); useAuxStore.setState(s => ({ version: s.version + 1 })) }))
  asked.set(r.key, p)
  return p
}

/** The needs of every step for every source, gathered before drawing. */
export interface AuxPlan { reqs: Map<string, Req[] | null>; pending: Promise<void>[] }
const planKey = (stepIndex: number, url: string) => `${stepIndex} ${url}`

/** Ask for what the strip's steps need. A bake (`wait`) waits for all of
 *  it; a live run only starts what is missing and goes on. */
export async function prepareAux(steps: AuxStep[], sources: { url: string; img: HTMLImageElement | null }[], wait: boolean): Promise<AuxPlan> {
  const plan: AuxPlan = { reqs: new Map(), pending: [] }
  for (const { url, img } of sources) {
    if (!img) continue
    for (let i = 0; i < steps.length; i++) {
      if (!isAuxKind(steps[i].effect)) continue
      const rs = requests(steps, i, url)
      plan.reqs.set(planKey(i, url), rs)
      for (const r of rs ?? []) if (!kept.has(r.key)) plan.pending.push(ask(r, img))
    }
  }
  if (wait) await Promise.all(plan.pending)
  return plan
}

/** The source's own map at the working image's size. */
function fit(e: FxEngine, img: HTMLImageElement, like: Tex): Tex {
  const up = e.upload(img, Math.max(like.w, like.h))
  if (up.w === like.w && up.h === like.h) return up
  const out = e.scaled(up, like.w, like.h)
  e.release(up)
  return out
}

const black = (e: FxEngine, like: Tex) =>
  e.pass('grade', e.target(like.w, like.h), { src: like, exposure: -24, contrast: 1, saturation: 0, tint: [1, 1, 1], tintAmt: 0 })

/** What step i receives besides its picture, as textures the size of
 *  `cur` — or null while something is missing (the step then passes the
 *  picture through). Release with releaseAux. */
export function auxFor(e: FxEngine, plan: AuxPlan, steps: AuxStep[], i: number, url: string, cur: Tex): Aux | null {
  const s = steps[i]
  const rs = plan.reqs.get(planKey(i, url))
  if (rs === undefined) return {}
  if (rs === null) return null
  const aux: Aux = {}
  for (const r of rs) {
    const k = kept.get(r.key)
    if (!k) { say(s.id, `Computing ${r.what}…`); releaseAux(e, aux); return null }
    if ('error' in k) { say(s.id, `${r.what[0].toUpperCase()}${r.what.slice(1)}: ${k.error}`); releaseAux(e, aux); return null }
    const tex = (n: string) => (k.imgs[n] ? fit(e, k.imgs[n]!, cur) : black(e, cur))
    if (r.what === 'depth') aux.depth = tex('depth')
    else if (r.what === 'mask') {
      aux.mask = tex('mask')
      // A Segment card a Film outline after it reads names what to outline:
      // its own mask is not the picture that outline should draw on.
      const next = steps.slice(i + 1).find(x => x.effect === 'segment' || READS_PHRASES.has(x.effect))
      aux.namesForLines = !!next && next.effect !== 'segment'
    }
    else if (r.job.op === 'formhatch' || r.job.op === 'bghatch') {
      const { mix } = hatchSetup(steps, i)
      aux.hatch = {
        a: tex('a'), k: tex('k'), b: tex('b'), h: tex('h'), p: tex('p'),
        pencil: (k.colors as unknown as { pencil?: string } | undefined)?.pencil ?? 'c8402a', background: r.job.op === 'bghatch', mix,
      }
    }
    else aux.lines = {
      outline: tex('outline'), inside: tex('inside'), paper: tex('paper'), pencil: tex('pencil'),
      colors: k.colors!, mix: lineSetup(steps, i).mix,
    }
  }
  say(s.id, '')
  return aux
}

export function releaseAux(e: FxEngine, aux: Aux | null) {
  if (!aux) return
  e.release(aux.depth)
  e.release(aux.mask)
  if (aux.lines) for (const t of [aux.lines.outline, aux.lines.inside, aux.lines.paper, aux.lines.pencil]) e.release(t)
  if (aux.hatch) for (const t of [aux.hatch.a, aux.hatch.k, aux.hatch.b, aux.hatch.h, aux.hatch.p]) e.release(t)
}

/** What the needs come to, handed to an effect's run. */
export interface Aux {
  depth?: Tex
  mask?: Tex
  /** The mask's phrases are what a later drawing card (outline, hatch) finds. */
  namesForLines?: boolean
  lines?: { outline: Tex; inside: Tex; paper: Tex; pencil: Tex; colors: LineColors; mix: Record<string, number> }
  /** A hatch look's layers: dark strokes (a alpha, k ink colour: multiply),
   *  light strokes (b, h: screen), the far pencil (p: multiply by `pencil`). */
  hatch?: { a: Tex; k: Tex; b: Tex; h: Tex; p: Tex; pencil: string; background: boolean; mix: Record<string, number> }
}
export type { AuxKind }
