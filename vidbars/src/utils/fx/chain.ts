// chain.ts — how an effect strip reads, and running it.
//
// A strip is cards lined up touching, read left to right:
//
//   [A] [B] [Bloom] [Ink] [Multiply] [Paper] [Glare]
//
// Image cards BEFORE the first effect are the batch: each of them goes
// through every effect in order. A blend effect (multiply, screen,
// overlay) takes the image card right AFTER it as its second input — so
// above, A and B each come out as glare(multiply(ink(bloom(X)), Paper)).
// Any other image card after the first effect is ignored (and reported).

import { fx, fitSource, type FxSource, type Tex } from './fxEngine'
import { EFFECTS, FX_REF_SIDE, effectParams, knownKind, type EffectKind } from './effects'
import { resolveMediaUrl } from '../useResolvedMedia'
import { prepareAux, auxFor, releaseAux } from './aiEffects'

export type ChainItem =
  | { id: string; kind: 'source'; url: string; label: string
      /** A video card's own stored url (`url` is its poster frame): a Run
       *  draws the whole clip (utils/fx/clipRun). */
      video?: string }
  | { id: string; kind: 'effect'; effect: EffectKind; params?: Record<string, number>
      /** Segment's phrases ("name: phrase, phrase" per line). */
      text?: string
      /** Switched off, or soloed (the card's on/off and solo buttons). */
      off?: boolean; solo?: boolean
      /** Cards tucked under it on a loop strip (utils/rail side inputs), in
       *  order: a Depth card's depth, a Segment card's mask. */
      inputs?: { id: string; effect: EffectKind; params?: Record<string, number>; text?: string; off?: boolean; solo?: boolean }[]
      /** A Combine card: the loop strip's look rows (utils/rail RailData.rows),
       *  each a chain of effects run on the same picture. */
      rows?: Extract<ChainItem, { kind: 'effect' }>[][] }

export interface ChainPlan {
  sources: Extract<ChainItem, { kind: 'source' }>[]
  steps: { item: Extract<ChainItem, { kind: 'effect' }>; other: Extract<ChainItem, { kind: 'source' }> | null }[]
  ignored: string[]
}

type EffectItem = Extract<ChainItem, { kind: 'effect' }>
type InputItem = NonNullable<EffectItem['inputs']>[number]

/** The strip as it runs: what it is with its switched-off cards taken out,
 *  wherever they are — the strip's own row, a look row (a Combine card's
 *  `rows`) or tucked under a card as its input (`inputs`) — so a card off
 *  always gives what the strip would give without it: no input means the
 *  card's fallback, no Segment card means no mask, a Combine card off means
 *  no looks. Soloed, a card is the only one that runs, on the picture, with
 *  its own inputs (as a solo in the strip's own row already is in
 *  planChain), wherever it is — and a soloed card switched OFF leaves
 *  nothing running: the original picture, until it is switched back on.
 *  The strip's own row keeps its off cards (planChain skips them, so a
 *  skipped blend still takes its partner).
 *  runChain reads every strip through this, look rows included. */
export function effectiveItems(items: ChainItem[]): ChainItem[] {
  const on = <T extends { off?: boolean }>(x: T) => !x.off
  const clean = (it: EffectItem): EffectItem => {
    const out: EffectItem = { ...it }
    delete out.inputs
    delete out.rows
    const inputs = (it.inputs as InputItem[] | undefined)?.filter(on)
      .map(x => ({ id: x.id, effect: x.effect, params: x.params, text: x.text }))
    if (inputs?.length) out.inputs = inputs
    if (it.rows) out.rows = it.rows.map(row => row.filter(on).map(clean))
    return out
  }
  // A solo below the strip's own row: in a look row, or an input.
  let nested: EffectItem | null = null
  const find = (list: EffectItem[]) => {
    for (const it of list) {
      if (nested) return
      const inp = (it.inputs as InputItem[] | undefined)?.find(x => x.solo)
      if (inp) { nested = { id: inp.id, kind: 'effect', effect: inp.effect, params: inp.params, text: inp.text, off: inp.off }; return }
      for (const row of it.rows ?? []) {
        const s = row.find(x => x.solo)
        if (s) { nested = s; return }
        find(row)
      }
    }
  }
  const effects = items.filter((it): it is EffectItem => it.kind === 'effect')
  if (!effects.some(it => it.solo)) find(effects)
  const out = items.map(it => (it.kind === 'effect' ? clean(it) : it))
  if (!nested) return out
  // The soloed card is switched off: nothing runs — every card of the
  // strip's row stands aside (off), and the soloed one is not added.
  if ((nested as EffectItem).off) return out.map(it => (it.kind === 'effect' ? { ...it, solo: false, off: true } : it))
  // Every card of the strip's row stands aside; the soloed one runs alone.
  return [...out.map(it => (it.kind === 'effect' ? { ...it, solo: false } : it)), { ...clean(nested as EffectItem), solo: true, off: false }]
}

/** Read a left-to-right strip into sources and steps (no pixels yet).
 *  An effect switched off is skipped; when one is soloed, it is the only
 *  effect that runs — or, the soloed one switched off, none does. A blend
 *  skipped either way still takes the picture
 *  after it — that picture is its partner, not a new batch picture — and
 *  mixes nothing in. */
export function planChain(items: ChainItem[]): ChainPlan {
  const plan: ChainPlan = { sources: [], steps: [], ignored: [] }
  const soloed = items.some(it => it.kind === 'effect' && it.solo)
  let i = 0
  while (i < items.length && items[i].kind === 'source') plan.sources.push(items[i++] as never)
  for (; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'source') { plan.ignored.push(it.id); continue }
    // A kind this build does not know (a snapshot from another build) runs
    // as Bloom — what its card shows — rather than throwing.
    const item = { ...it, effect: knownKind(it.effect) }
    let other: ChainPlan['steps'][number]['other'] = null
    if (EFFECTS[item.effect].blend && items[i + 1]?.kind === 'source') other = items[++i] as never
    if (soloed ? !it.solo || it.off : it.off) continue
    plan.steps.push({ item, other })
  }
  return plan
}

/** The strip as ONE of its batch pictures sees it: every other leading
 *  source dropped, everything after the first effect (blend partners
 *  included) kept. What saving or dragging out that picture's own result
 *  renders — and, stringified, the signature of that result. */
export function itemsForSource(items: ChainItem[], sourceId: string): ChainItem[] {
  const lead = new Set(planChain(items).sources.map(s => s.id))
  return items.filter(i => i.id === sourceId || !lead.has(i.id))
}

// Decoded images, by stored url. Small and session-long: a strip re-runs
// on every slider move and must not re-decode its sources each time.
// Least-recently-used goes first; a failure is not kept, so a file that is
// back (unlocked, remounted) reads on the next run.
const imageCache = new Map<string, Promise<HTMLImageElement | null>>()
export function loadImage(url: string): Promise<HTMLImageElement | null> {
  const hit = imageCache.get(url)
  if (hit) {
    imageCache.delete(url)
    imageCache.set(url, hit)
    return hit
  }
  const p = (async () => {
    try {
      const src = await resolveMediaUrl(url)
      if (!src) return null
      const img = new Image()
      img.decoding = 'async'
      img.src = src
      await img.decode()
      return img.naturalWidth > 0 ? img : null
    } catch { return null }
  })()
  imageCache.set(url, p)
  void p.then(img => { if (!img && imageCache.get(url) === p) imageCache.delete(url) })
  if (imageCache.size > 64) imageCache.delete(imageCache.keys().next().value!)
  return p
}

/** Drop a decoded picture that will not be asked for again (a baked clip's frame). */
export function forgetImage(url: string): void {
  imageCache.delete(url)
}

// Sources already fitted to a live working size, by size and url: a 24 MP
// photo is resampled once rather than uploaded whole on every slider tick.
// A save's one-off size is fitted but not kept.
const fitCache = new Map<string, { img: HTMLImageElement; fit: FxSource }>()
function fitted(img: HTMLImageElement, url: string, side: number): FxSource {
  if (side > FX_REF_SIDE) return fitSource(img, side)
  const key = `${side} ${url}`
  const hit = fitCache.get(key)
  fitCache.delete(key)
  // Checked against the decode it came from: a re-decoded url refits.
  const fit = hit?.img === img ? hit.fit : fitSource(img, side)
  fitCache.set(key, { img, fit })
  if (fitCache.size > 12) fitCache.delete(fitCache.keys().next().value!)
  return fit
}

export interface ChainResult {
  /** One output per source, in order. */
  outputs: { sourceId: string; label: string; canvas: HTMLCanvasElement }[]
  /** After each effect step, for the first source that could be read.
   *  Only made when asked for (`previewSide`); nothing shows them now —
   *  the result is shown on the picture itself. */
  stepPreviews: Map<string, HTMLCanvasElement>
  ignored: string[]
  /** Batch sources whose picture could not be read, so they have no
   *  output — lets that one picture say why, while the others still show
   *  theirs. (Optional: a result made elsewhere may not carry it.) */
  unreadable?: string[]
  error?: string
}

/** Run a strip. `maxSide` caps the working resolution (a live preview
 *  wants ~1400; a saved result the source's full size). `previewSide` is
 *  the step previews' long edge; 0 or false makes none (a save never shows
 *  them). `live`: a preview, which never waits for what a step needs from a
 *  model or tool (aiEffects) — the step shows its picture unchanged until
 *  it lands, and the live strips run again then. Otherwise (a Run, a save,
 *  a drag-out) the run waits for it and draws once. */
export async function runChain(items: ChainItem[], maxSide: number, previewSide: number | false = 220, opts: { live?: boolean } = {}): Promise<ChainResult> {
  const plan = planChain(effectiveItems(items))
  const unreadable: string[] = []
  const result: ChainResult = { outputs: [], stepPreviews: new Map(), ignored: plan.ignored, unreadable }
  if (plan.sources.length === 0) return { ...result, error: 'Put an image card at the start of the strip.' }

  const urls = [...plan.sources.map(s => s.url), ...plan.steps.flatMap(s => s.other ? [s.other.url] : [])]
  const images = new Map(await Promise.all(urls.map(async u => [u, await loadImage(u)] as const)))
  const steps = plan.steps.map(s => s.item)
  const aux = await prepareAux(steps, plan.sources.map(s => ({ url: s.url, img: images.get(s.url) ?? null })), !opts.live, opts.live ? undefined : maxSide)
  // A Combine card's look rows: each run as a strip of its own on the same
  // picture, here, before this run draws anything (a run ends by reclaiming
  // the engine's targets). Combine lays them over its picture in the loop.
  const looks = new Map<string, (HTMLCanvasElement | null)[]>()   // `${step} ${source url}` → per row
  for (const [i, s] of plan.steps.entries()) {
    if (s.item.effect !== 'combine' || !s.item.rows?.length) continue
    for (const source of plan.sources) {
      const outs: (HTMLCanvasElement | null)[] = []
      for (const row of s.item.rows) {
        const r = row.length ? await runChain([source, ...row], maxSide, false, opts) : null
        outs.push(r?.outputs[0]?.canvas ?? null)
      }
      looks.set(`${i} ${source.url}`, outs)
    }
  }

  // Taken after the wait: a context lost meanwhile is rebuilt here.
  const e = fx()
  if (!e) return { ...result, error: 'This display has no WebGL2.' }
  const side = Math.min(maxSide, e.maxTexSide)
  const others = new Map<string, Tex>()
  try {
    for (const s of plan.steps) {
      if (!s.other) continue
      const img = images.get(s.other.url)
      if (img) others.set(s.other.id, e.upload(fitted(img, s.other.url, side), side, EFFECTS[s.item.effect].matte ?? 0))
    }
    for (const source of plan.sources) {
      const img = images.get(source.url)
      if (!img) { unreadable.push(source.id); continue }
      const first = result.outputs.length === 0
      let cur = e.upload(fitted(img, source.url, side), side)
      // The picture itself, kept through the steps: a look whose colours
      // are the picture's (aiEffects) is re-coloured from what it is laid on.
      const picture = e.pass('copy', e.target(cur.w, cur.h), { src: cur })
      for (const [i, s] of plan.steps.entries()) {
        const def = EFFECTS[s.item.effect]
        // What it needs from a model or tool; still missing, the picture
        // goes through unchanged (its card says why).
        const inputs = s.item.inputs ?? []
        const got = def.needs || inputs.length ? auxFor(e, aux, steps, i, source.url, cur, picture) : {}
        // Side inputs (utils/rail): under a blend, the first input's map is
        // its second image when no picture partners it; under a plain
        // effect, a Segment card's mask limits it to the mask.
        const inputMap = got && inputs.length ? (inputs[0].effect === 'depth' ? got.depth : got.mask) ?? got.depth ?? got.mask : undefined
        const other = s.other ? others.get(s.other.id) : def.blend ? inputMap : null
        let next = got
          ? def.run(e, cur, effectParams(s.item.effect, s.item.params), other ?? null, got)
          : e.pass('copy', e.target(cur.w, cur.h), { src: cur })
        if (got && s.item.effect === 'combine') {
          // The look rows over the picture: those without a mask first (a
          // background look, over all of it), then each masked one in row
          // order, limited to its mask; at Combine's strength.
          const outs = looks.get(`${i} ${source.url}`) ?? []
          const strength = effectParams('combine', s.item.params).strength
          const order = outs.map((_, k) => k).sort((a, b) => Number(!!got.rowMasks?.[a]) - Number(!!got.rowMasks?.[b]))
          for (const k of order) {
            const canvas = outs[k]
            if (!canvas) continue
            const look = e.upload(canvas, Math.max(cur.w, cur.h))
            const fit = look.w === cur.w && look.h === cur.h ? look : e.scaled(look, cur.w, cur.h)
            const own = got.rowMasks?.[k]
            const mask = own ?? e.pass('grade', e.target(cur.w, cur.h), { src: cur, exposure: 24, contrast: 1, saturation: 0, tint: [1, 1, 1], tintAmt: 0 })
            const laid = e.pass('layerOver', e.target(cur.w, cur.h), { src: next, C: fit, A: mask, S: next, blendMode: 0, strength })
            if (!own) e.release(mask)
            if (fit !== look) e.release(look)
            e.release(fit)
            e.release(next)
            next = laid
          }
        } else if (got?.mask && !def.blend && !def.needs) {
          const limited = e.pass('layerOver', e.target(cur.w, cur.h), { src: cur, C: next, A: got.mask, S: cur, blendMode: 0, strength: 1 })
          e.release(next)
          next = limited
        }
        releaseAux(e, got)
        e.release(cur)
        cur = next
        if (first && previewSide) {
          // Shrunk on the GPU, so only the small preview is read back.
          const k = previewSide / Math.max(cur.w, cur.h)
          const small = k < 1 ? e.scaled(cur, cur.w * k, cur.h * k) : null
          result.stepPreviews.set(s.item.id, e.toCanvas(small ?? cur))
          e.release(small)
        }
      }
      e.release(picture)
      result.outputs.push({ sourceId: source.id, label: source.label, canvas: e.toCanvas(cur) })
      e.release(cur)
    }
  } catch (err) {
    result.error = String((err as Error)?.message ?? err)
  } finally {
    for (const t of others.values()) e.release(t)
    // Reclaims whatever a throw left out, and a save's full-size targets.
    e.endRun(FX_REF_SIDE)
  }
  if (e.gl.isContextLost()) {
    // Everything drawn after the loss is blank; the next run gets a fresh
    // engine. Say so rather than hand back (or save) empty pictures.
    result.outputs = []
    result.stepPreviews.clear()
    result.error = 'The GPU was reset during this run; try again.'
  }
  if (!result.error && result.outputs.length === 0) result.error = 'The image cards on this strip could not be read.'
  return result
}
