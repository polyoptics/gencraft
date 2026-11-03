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
export interface AuxStep {
  id: string; effect: EffectKind; params?: Record<string, number>; text?: string
  /** Cards tucked under it on a loop strip (utils/rail side inputs). */
  inputs?: { id: string; effect: EffectKind; params?: Record<string, number>; text?: string }[]
  /** A Combine card: the look rows it lays over its picture. */
  rows?: AuxStep[][]
}

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
/** The drawing-look cards: which sketchLook look each runs (electron
 *  sketch_server.py LOOKS) and whether it draws the background (its subject
 *  then optional). Every slider but Show and Strength is the look's dial. */
export const LOOK_OF: Partial<Record<EffectKind, { look: string; background?: boolean }>> = {
  painthatch: { look: 'hatch' }, filmcel: { look: 'cel' }, boilink: { look: 'boil' }, misreg: { look: 'misreg' },
  construction: { look: 'construction' }, relight: { look: 'relight' }, formlight: { look: 'formlight' },
  bglayout: { look: 'bg_layout', background: true }, bgwash: { look: 'bg_tonewash', background: true },
}
const LIVE_ONLY = new Set(['show', 'strength'])
/** Look dials whose card default differs from the film tool's own, so they
 *  are sent even when the slider was never moved. */
const CARD_DIALS: Partial<Record<EffectKind, Record<string, number>>> = { relight: { respect: 0.3 } }
// 'follow': a normal layer whose colour the look took from the picture (a
// deepened local colour): laid on another picture, it takes that one's.
const BLEND = { normal: 0, multiply: 1, screen: 2, add: 3, hardlight: 4, follow: 5 } as Record<string, number>
/** A Shading mix card's values that change nothing (the look mixer's
 *  neutral: mixer_bake.py NEUTRAL, for the hatch layers). */
export const SHADE_NEUTRAL: Record<string, number> = { hatch: 1, bg: 1, hatch_weight: 1, bg_weight: 1, hatch_dark: 0, bg_dark: 0, light: 1 }
/** A Line mix card's values that change nothing. */
export const MIX_NEUTRAL: Record<string, number> = { strength: 1, pencil: 1, ink: 1, weight: 1, dark: 0, tint: 0, light: 1 }

export interface LineColors { ink: string; paper: string; pencil: string; graphite: string; pencil_tint: number }

type Kept =
  | { imgs: Record<string, HTMLImageElement | null>; colors?: LineColors; scales?: Record<string, number> }
  | { error: string }

/** A Segment card's scale settings (the film's tools_scale/scale.py): the
 *  size a subject is drawn at as tuned (Reference size, px), the smallest
 *  scale, and per thing it found a "partly in view" factor (only part of it
 *  shows: it is this many times bigger) and a fixed scale (0 = measured). */
export interface ScaleSettings { ref?: number; lo?: number; view: Record<string, number>; fixed: Record<string, number> }
function scaleOf(seg: AuxStep | undefined): ScaleSettings | undefined {
  if (!seg) return undefined
  const p = seg.params ?? {}
  const pick = (pre: string) => Object.fromEntries(Object.entries(p).filter(([k, v]) => k.startsWith(pre) && typeof v === 'number').map(([k, v]) => [k.slice(pre.length), v]))
  const view = Object.fromEntries(Object.entries(pick('view:')).filter(([, v]) => v !== 1))
  const fixed = Object.fromEntries(Object.entries(pick('scale:')).filter(([, v]) => v > 0))
  return { ...(typeof p.ref === 'number' ? { ref: p.ref } : {}), ...(typeof p.lo === 'number' ? { lo: p.lo } : {}), view, fixed }
}

/** The long edge this pass draws at (prepareAux sets it per picture): the
 *  live preview's, or a bake's own size when the picture is bigger. */
let drawSide = 1400

interface Req {
  key: string; what: string
  /** A Combine card's mask for look row `row` (0 = the first look row). */
  row?: number
  /** The Segment card this mask is (its card shows what it found). */
  segId?: string
  /** Asked only so that Segment card learns what it found (a drawing card's input). */
  quiet?: boolean
  job: { op: 'depth' | 'segment' | 'lines' | 'formhatch' | 'bghatch' | 'look'; look?: string; whole?: boolean; objects?: Record<string, string[]>; dials?: Record<string, number>; side?: number; engine?: Engine; scale?: ScaleSettings }
}
/** What finds the things a Segment card names: SAM 3 (descriptive phrases,
 *  every instance, tracked through a sequence) or Grounding DINO + SAM2. */
type Engine = 'sam3' | 'dino'
const engineOf = (s: AuxStep | undefined): Engine => (s?.params?.engine ?? 0) >= 0.5 ? 'dino' : 'sam3'

// Results by what they are made from; a few dozen pictures' worth.
const kept = new Map<string, Kept>()
const asked = new Map<string, Promise<void>>()
let queue: Promise<unknown> = Promise.resolve()

/** Per step: what its card should say ('' = nothing), and a counter that
 *  ticks whenever a result lands (live strips re-run on it). */
export const useAuxStore = create<{ version: number; byStep: Record<string, string>; subjects: Record<string, Record<string, number>> }>(() => ({ version: 0, byStep: {}, subjects: {} }))

/** What a Segment card found, and each thing's measured scale on screen. */
function setSubjects(segId: string, scales: Record<string, number>) {
  const s = useAuxStore.getState()
  if (JSON.stringify(s.subjects[segId] ?? {}) !== JSON.stringify(scales)) useAuxStore.setState({ subjects: { ...s.subjects, [segId]: scales } })
}

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

const AUX_KINDS = new Set<EffectKind>(['depth', 'segment', 'filmline', 'linemix', 'formhatch', 'bghatch', 'shademix', 'combine',
  ...(Object.keys(LOOK_OF) as EffectKind[])])
const isAuxKind = (k: EffectKind) => AUX_KINDS.has(k)
/** Cards that read a Segment card's phrases (the things to draw). */
const READS_PHRASES = new Set<EffectKind>(['filmline', 'formhatch', 'bghatch', ...(Object.keys(LOOK_OF) as EffectKind[])])
/** Whether any step on the strip needs a model or tool (so its live result
 *  can change when one lands). */
export const stripNeedsAux = (steps: { kind: string; effect?: EffectKind; inputs?: unknown[] }[]) =>
  steps.some(s => s.kind === 'effect' && !!s.effect && (isAuxKind(s.effect) || !!s.inputs?.length))

/** The Segment card a step reads: one tucked under it (a side input,
 *  utils/rail) first, else the nearest Segment card at or before it. */
function segmentFor(steps: AuxStep[], i: number): AuxStep | undefined {
  const own = steps[i].inputs?.find(x => x.effect === 'segment')
  if (own) return { ...own }
  for (let j = i; j >= 0; j--) if (steps[j].effect === 'segment') return steps[j]
  return undefined
}

function phrasesFor(steps: AuxStep[], i: number): Record<string, string[]> | null {
  const s = segmentFor(steps, i)
  return s ? parsePhrases(s.text) : null
}

/** The engine of the nearest Segment card at or before step i (SAM 3
 *  without one). */
function engineFor(steps: AuxStep[], i: number): Engine {
  return engineOf(segmentFor(steps, i))
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

/** A drawing card's Segment input, asked for as a mask too: the drawing
 *  segments by itself (the worker shares the result), and this is how the
 *  Segment card learns what it found and how big each thing is. */
function inputMask(steps: AuxStep[], i: number, src: string): Req[] {
  const x = steps[i].inputs?.find(y => y.effect === 'segment')
  const objects = x ? parsePhrases(x.text) : {}
  if (!x || !Object.keys(objects).length) return []
  const engine = engineOf(x), scale = scaleOf(x)
  return [{ key: `mask|${src}|${JSON.stringify(objects)}|${engine}|${JSON.stringify(scale)}`, what: 'mask', quiet: true, segId: x.id, job: { op: 'segment', objects, engine, scale } }]
}

/** What step i asks for, for the source with this url. [] = nothing, null =
 *  it cannot run (its card says why). */
function requests(steps: AuxStep[], i: number, url: string): Req[] | null {
  const s = steps[i], src = hash(url)
  // A plain effect or a blend fed by side inputs: their maps (runChain uses
  // them as the blend's second image, or the mask the effect is limited to).
  if (!isAuxKind(s.effect)) {
    const out: Req[] = []
    for (const x of s.inputs ?? []) {
      if (x.effect === 'depth' && !out.some(r => r.what === 'depth')) out.push({ key: `depth|${src}`, what: 'depth', job: { op: 'depth' } })
      if (x.effect === 'segment' && !out.some(r => r.what === 'mask')) {
        const objects = parsePhrases(x.text)
        if (!Object.keys(objects).length) { say(s.id, 'Name something on the Segment card under it'); return null }
        const engine = engineOf(x), scale = scaleOf(x)
        out.push({ key: `mask|${src}|${JSON.stringify(objects)}|${engine}|${JSON.stringify(scale)}`, what: 'mask', segId: x.id, job: { op: 'segment', objects, engine, scale } })
      }
    }
    return out
  }
  if (s.effect === 'depth') return [{ key: `depth|${src}`, what: 'depth', job: { op: 'depth' } }]
  if (s.effect === 'segment') {
    const objects = parsePhrases(s.text)
    if (!Object.keys(objects).length) { say(s.id, 'Name something to find'); return null }
    const engine = engineOf(s), scale = scaleOf(s)
    return [{ key: `mask|${src}|${JSON.stringify(objects)}|${engine}|${JSON.stringify(scale)}`, what: 'mask', segId: s.id, job: { op: 'segment', objects, engine, scale } }]
  }
  if (s.effect === 'formhatch' || s.effect === 'bghatch') {
    // The figure hatch needs the things to hatch ("person" without a
    // Segment card); the background's subject is optional: without a
    // Segment card the whole picture is background.
    // No Segment card: the figure hatch takes the whole picture as its subject.
    const objects = phrasesFor(steps, i) ?? undefined
    const whole = s.effect === 'formhatch' && !objects
    const { dials } = hatchSetup(steps, i)
    const engine = engineFor(steps, i)
    const seg = segmentFor(steps, i), scale = objects ? scaleOf(seg) : undefined
    // The Segment card's "Spacing follows scale": look_formhatch's hatch_scale.
    if (s.effect === 'formhatch' && typeof seg?.params?.spacing_follow === 'number') dials.hatch_scale = seg.params.spacing_follow
    return [{ key: `${s.effect}|${src}|${JSON.stringify(objects ?? null)}|${whole ? 'whole' : engine}|${JSON.stringify(dials)}|${JSON.stringify(scale)}|${drawSide}`,
      what: s.effect === 'formhatch' ? 'hatching' : 'background hatching',
      job: { op: s.effect, objects, whole, dials, side: drawSide, engine, scale } }, ...inputMask(steps, i, src)]
  }
  const lk = LOOK_OF[s.effect]
  if (lk) {
    // No Segment card: a subject look draws on the whole picture; a
    // background look treats it all as background.
    const objects = phrasesFor(steps, i) ?? undefined
    const whole = !lk.background && !objects
    const dials: Record<string, number> = { ...(CARD_DIALS[s.effect] ?? {}) }
    for (const [k, v] of Object.entries(s.params ?? {})) if (!LIVE_ONLY.has(k) && typeof v === 'number') dials[k] = v
    const engine = engineFor(steps, i)
    return [{ key: `look|${lk.look}|${src}|${JSON.stringify(objects ?? null)}|${whole ? 'whole' : engine}|${JSON.stringify(dials)}|${drawSide}`,
      what: 'drawing', job: { op: 'look', look: lk.look, objects, whole, dials, side: drawSide, engine } }, ...inputMask(steps, i, src)]
  }
  // A mix card changes how its drawing card mixes its layers, AT the
  // drawing card: whatever lies between the two then works on the re-mixed
  // drawing, as if the drawing had been made that way. Its note says which
  // drawing it mixes.
  // Combine: each look row's mask, from the Segment card in that row (or one
  // tucked under a card of it). A row with none covers the whole picture.
  if (s.effect === 'combine') {
    const rows = s.rows ?? []
    if (!rows.length) { say(s.id, 'Add a look row under the strip'); return [] }
    say(s.id, `Combines ${rows.length} look row${rows.length > 1 ? 's' : ''}`)
    const out: Req[] = []
    rows.forEach((row, k) => {
      const seg = row.find(x => x.effect === 'segment') ?? row.flatMap(x => x.inputs ?? []).find(x => x.effect === 'segment')
      const objects = seg ? parsePhrases(seg.text) : {}
      if (!Object.keys(objects).length) return
      const engine = engineOf(seg as AuxStep)
      out.push({ key: `mask|${src}|${JSON.stringify(objects)}|${engine}`, what: 'mask', row: k, job: { op: 'segment', objects, engine } })
    })
    return out
  }
  if (s.effect === 'shademix') {
    const n = steps.slice(0, i).filter(x => x.effect === 'formhatch' || x.effect === 'bghatch').length
    say(s.id, n ? `Mixes the ${n > 1 ? `${n} hatch cards` : 'hatch card'} before it` : 'Put a hatch card before it')
    return n ? [] : null
  }
  if (s.effect === 'filmline') {
    // No Segment card: the outline draws on the whole picture.
    const objects = phrasesFor(steps, i) ?? undefined
    const { dials } = lineSetup(steps, i)
    const engine = engineFor(steps, i)
    const scale = objects ? scaleOf(segmentFor(steps, i)) : undefined
    return [{ key: `lines|${src}|${JSON.stringify(objects ?? null)}|${objects ? engine : 'whole'}|${JSON.stringify(dials)}|${JSON.stringify(scale)}|${drawSide}`, what: 'outline',
      job: { op: 'lines', objects, whole: !objects, dials, side: drawSide, engine, scale } }, ...inputMask(steps, i, src)]
  }
  if (s.effect === 'linemix') {
    let j = i - 1
    while (j >= 0 && steps[j].effect !== 'filmline') j--
    say(s.id, j < 0 ? 'Put a Film outline before it' : `Mixes the Film outline ${i - j > 1 ? `${i - j} cards back` : 'before it'}`)
    return j < 0 ? null : []
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
    else if (r.job.op === 'segment') keep(r.key, { imgs: { mask: await decode(res.objects?.figure?.[0]) }, scales: (res as { scales?: Record<string, number> }).scales })
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
export async function prepareAux(steps: AuxStep[], sources: { url: string; img: HTMLImageElement | null }[], wait: boolean, side = LINE_SIDE): Promise<AuxPlan> {
  const plan: AuxPlan = { reqs: new Map(), pending: [] }
  for (const { url, img } of sources) {
    if (!img) continue
    // Drawn at the preview's size, or a bake's own when the picture is bigger
    // (the worker scales every pixel-size dial to match): a picture no bigger
    // than the preview's size bakes as the preview draws it.
    drawSide = Math.max(LINE_SIDE, Math.min(side, Math.max(img.naturalWidth, img.naturalHeight), 4096))
    for (let i = 0; i < steps.length; i++) {
      if (!isAuxKind(steps[i].effect) && !steps[i].inputs?.length) continue
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
export function auxFor(e: FxEngine, plan: AuxPlan, steps: AuxStep[], i: number, url: string, cur: Tex, picture?: Tex): Aux | null {
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
    if (r.row !== undefined) { (aux.rowMasks ??= [])[r.row] = tex('mask'); continue }
    if (r.segId && k.scales) setSubjects(r.segId, k.scales)
    if (r.quiet) continue
    if (r.what === 'depth') aux.depth = tex('depth')
    else if (r.what === 'mask') {
      aux.mask = tex('mask')
      // A Segment card a Film outline after it reads names what to outline:
      // its own mask is not the picture that outline should draw on.
      const next = steps.slice(i + 1).find(x => x.effect === 'segment' || READS_PHRASES.has(x.effect))
      aux.namesForLines = !!next && next.effect !== 'segment'
    }
    else if (r.job.op === 'look') {
      const modes = ((k.colors as unknown as { modes?: string[] } | undefined)?.modes ?? [])
      aux.look = { layers: modes.map((m, n) => ({ c: tex(`c${n}`), a: tex(`a${n}`), mode: BLEND[m] ?? 0 })), picture: picture ?? cur }
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
  if (s.effect !== 'linemix' && s.effect !== 'shademix' && s.effect !== 'combine') say(s.id, '')
  return aux
}

export function releaseAux(e: FxEngine, aux: Aux | null) {
  if (!aux) return
  e.release(aux.depth)
  e.release(aux.mask)
  if (aux.lines) for (const t of [aux.lines.outline, aux.lines.inside, aux.lines.paper, aux.lines.pencil]) e.release(t)
  if (aux.hatch) for (const t of [aux.hatch.a, aux.hatch.k, aux.hatch.b, aux.hatch.h, aux.hatch.p]) e.release(t)
  if (aux.look) for (const l of aux.look.layers) { e.release(l.c); e.release(l.a) }
  if (aux.rowMasks) for (const m of aux.rowMasks) e.release(m)
}

/** What the needs come to, handed to an effect's run. */
export interface Aux {
  depth?: Tex
  mask?: Tex
  /** A Combine card: each look row's mask (undefined: the row has none). */
  rowMasks?: (Tex | undefined)[]
  /** The mask's phrases are what a later drawing card (outline, hatch) finds. */
  namesForLines?: boolean
  lines?: { outline: Tex; inside: Tex; paper: Tex; pencil: Tex; colors: LineColors; mix: Record<string, number> }
  /** A hatch look's layers: dark strokes (a alpha, k ink colour: multiply),
   *  light strokes (b, h: screen), the far pencil (p: multiply by `pencil`). */
  hatch?: { a: Tex; k: Tex; b: Tex; h: Tex; p: Tex; pencil: string; background: boolean; mix: Record<string, number> }
  /** A drawing look's layers in its order: colour, alpha and blend mode
   *  (0 normal, 1 multiply, 2 screen, 3 add, 4 hard light, 5 normal in
   *  the colour of what it is laid on); `picture` is the strip's source
   *  picture (not to be released: runChain owns it). */
  look?: { layers: { c: Tex; a: Tex; mode: number }[]; picture: Tex }
}
export type { AuxKind }
