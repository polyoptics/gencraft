// aiEffects.ts — effects a MODEL makes rather than a shader: Depth and
// Segment. They run sketchLook's own tools (depth.py, matte_auto.py) on the
// desktop's GPU through electron/sketchWorker.cjs, so they need the desktop
// app; in a plain browser tab they pass the picture through and say why.
//
// A model takes seconds, a strip re-runs on every slider tick, so results
// are kept by WHAT went in (the picture reaching the step, the phrases):
// the first run asks for the result and shows the picture unchanged, and
// runChain runs the strip again once it is in. Later runs read it at once.

import type { FxEngine, Tex } from './fxEngine'
import type { EffectKind } from './effects'

export const AI_KINDS: ReadonlySet<EffectKind> = new Set<EffectKind>(['depth', 'segment'])
export const isAiEffect = (k: EffectKind) => AI_KINDS.has(k)

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

type Kept = { img: HTMLImageElement | null } | { error: string }
// Results by input; a dozen is plenty (each is one picture).
const kept = new Map<string, Kept>()
const asked = new Map<string, Promise<void>>()
/** Per step: the input it wants now. A job whose step has moved on to
 *  another input (a slider upstream kept moving) is skipped, not run. */
const wanted = new Map<string, string>()
let queue: Promise<unknown> = Promise.resolve()

function keep(key: string, v: Kept) {
  kept.set(key, v)
  if (kept.size > 12) kept.delete(kept.keys().next().value!)
}

/** A cheap signature of a texture's pixels: a 32×32 readback, hashed. */
function fingerprint(e: FxEngine, t: Tex): string {
  const small = e.scaled(t, 32, 32)
  const c = e.toCanvas(small)
  e.release(small)
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
  let h = 2166136261
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619) }
  return `${t.w}x${t.h}:${(h >>> 0).toString(36)}`
}

function decode(url: string): Promise<HTMLImageElement | null> {
  const img = new Image()
  img.src = url
  return img.decode().then(() => img, () => null)
}

function ask(stepId: string, key: string, kind: EffectKind, text: string | undefined, picture: string): Promise<void> {
  const hit = asked.get(key)
  if (hit) return hit
  const run = window.vidbarsDesktop?.sketchRun
  const p = (queue = queue.then(async () => {
    if (wanted.get(stepId) !== key) return
    if (!run) { keep(key, { error: 'Depth and Segment run in the VidBars desktop app.' }); return }
    const r = await run(kind === 'depth'
      ? { op: 'depth', frames: [picture] }
      : { op: 'segment', frames: [picture], objects: parsePhrases(text) })
    if (r.error) { console.warn(`[fx] ${kind}:`, r.error, r.log); keep(key, { error: `${kind === 'depth' ? 'Depth' : 'Segment'}: ${r.error}` }); return }
    // Segment shows every named thing together ("figure"); nothing found
    // is an empty (black) mask.
    const url = kind === 'depth' ? r.frames?.[0] : r.objects?.figure?.[0]
    keep(key, { img: url ? await decode(url) : null })
  }).catch(err => keep(key, { error: String(err?.message ?? err) })).finally(() => asked.delete(key)))
  asked.set(key, p)
  return p
}

/**
 * One Depth / Segment step on the strip, synchronously: the kept result
 * when there is one, else the picture unchanged plus `pending` — a promise
 * that settles when the result is in, so the caller can run again.
 * Params: depth {far} (1 = far is bright); segment {cut} (0 the mask,
 * 1 the picture cut out by it).
 */
export function runAiStep(
  e: FxEngine, src: Tex, kind: EffectKind, stepId: string, text: string | undefined, p: Record<string, number>,
): { tex: Tex; pending?: Promise<void>; error?: string } {
  if (kind === 'segment' && !Object.keys(parsePhrases(text)).length) {
    return { tex: e.pass('copy', e.target(src.w, src.h), { src }), error: 'Segment: name something to find.' }
  }
  const key = `${kind}|${kind === 'segment' ? JSON.stringify(parsePhrases(text)) : ''}|${fingerprint(e, src)}`
  wanted.set(stepId, key)
  const got = kept.get(key)
  if (!got) {
    const picture = e.toCanvas(src).toDataURL('image/png')
    return { tex: e.pass('copy', e.target(src.w, src.h), { src }), pending: ask(stepId, key, kind, text, picture) }
  }
  if ('error' in got) return { tex: e.pass('copy', e.target(src.w, src.h), { src }), error: got.error }

  let map: Tex
  if (got.img) {
    const up = e.upload(got.img, Math.max(src.w, src.h))
    map = up.w === src.w && up.h === src.h ? up : e.scaled(up, src.w, src.h)
    if (map !== up) e.release(up)
  } else {
    map = e.pass('grade', e.target(src.w, src.h), { src, exposure: -20, contrast: 1, saturation: 0, tint: [1, 1, 1], tintAmt: 0 })
  }
  if (kind === 'depth' && p.far >= 0.5) {
    const inv = e.pass('invertGrey', e.target(map.w, map.h), { src: map })
    e.release(map)
    return { tex: inv }
  }
  if (kind === 'segment' && p.cut >= 0.5) {
    const cut = e.pass('blend', e.target(src.w, src.h), { src, other: map, mode: 0, mixAmt: 1, bScale: [1, 1], bOffset: [0, 0] })
    e.release(map)
    return { tex: cut }
  }
  return { tex: map }
}
