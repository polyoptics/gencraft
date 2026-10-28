// effects.ts — what an effect card can be. Each effect is a short
// composition of fxEngine passes plus the few sliders worth exposing.
//
// Blends (multiply, screen, overlay) take a SECOND image: the image card
// placed right after them on the strip (see chain.ts).

import type { FxEngine, Tex } from './fxEngine'

export type EffectKind =
  | 'bloom' | 'glare' | 'glow' | 'ink' | 'cel' | 'sketch'
  | 'halftone' | 'chroma' | 'grade' | 'multiply' | 'screen' | 'overlay'
  | 'depth' | 'segment'

export interface ParamDef { key: string; label: string; min: number; max: number; step: number; default: number }

export interface EffectDef {
  kind: EffectKind
  label: string
  glyph: string
  /** Card accent colour. */
  color: string
  /** What it does, in one short plain line — for the places you pick an
   *  effect by what it looks like rather than by name (the Effects palette,
   *  the card browser's "Add new" rows). Short enough for two lines on a
   *  palette card. */
  blurb: string
  /** Takes a second image (the next image card on the strip). */
  blend?: boolean
  /** A blend partner's neutral grey — what its transparent areas become,
   *  so they leave the image as it is. */
  matte?: number
  params: ParamDef[]
  run(e: FxEngine, src: Tex, p: Record<string, number>, other?: Tex | null): Tex
}

/** The long edge every size-like slider is measured against. A dot size,
 *  line weight, blur or glow reach is the same SHARE of the picture at any
 *  working resolution, so a saved result (up to 8192) looks like the live
 *  preview — useFxStrips' LIVE_SIDE must equal this. Smaller pictures keep
 *  pixel sizes: nothing gets finer than a pixel. */
export const FX_REF_SIDE = 1400

/** How many working texels one reference texel spans (≥ 1). */
const unitOf = (t: Tex) => Math.max(1, Math.max(t.w, t.h) / FX_REF_SIDE)

/** `t` at the reference size, or `t` itself when it is no bigger — where
 *  neighbourhood work (pyramids, blurs, edge finding) happens. Release it
 *  only if it is not `t`. */
function atRef(e: FxEngine, t: Tex): Tex {
  const u = unitOf(t)
  return u > 1 ? e.scaled(t, t.w / u, t.h / u) : t
}

const P = (key: string, label: string, min: number, max: number, step: number, def: number): ParamDef =>
  ({ key, label, min, max, step, default: def })

/** Hue (0–360) → an RGB tint that keeps its brightness near 1. */
function hueTint(h: number): number[] {
  const f = (n: number) => { const k = (n + h / 30) % 12; return 1 - Math.max(-1, Math.min(k - 3, 9 - k, 1)) * 0.5 }
  return [f(0), f(8), f(4)].map(v => 0.5 + v * 0.5)
}

/** Bloom pyramid: bright pass, ~6 levels down, tent-filtered back up, all
 *  at the reference size (so the coarsest level spans the same share of
 *  the frame in a save as in the preview). The glow is the SUM of its
 *  levels; multiply strength by `norm` to average them, so the slider means
 *  the same at any size. On half-float targets the sum is kept and `norm`
 *  is 1/levels; on RGBA8 it would clip, so each level is pre-divided by
 *  the bright pass instead (more banding) and `norm` is 1. */
function bloomGlow(e: FxEngine, src: Tex, threshold: number, radius: number): { tex: Tex; norm: number } {
  const base = atRef(e, src)
  let n = 0
  for (let w = base.w, h = base.h; n < 6 && w >= 8 && h >= 8; n++) { w = Math.floor(w / 2); h = Math.floor(h / 2) }
  const gain = e.halfFloat ? 1 : 1 / Math.max(1, n)
  const bright = e.pass('bright', e.target(base.w, base.h, true), { src: base, threshold, knee: 0.15, gain })
  if (base !== src) e.release(base)
  // Too small for a pyramid: the bright pass is the glow.
  if (n === 0) return { tex: bright, norm: 1 }
  const levels: Tex[] = []
  let prev = bright
  for (let i = 0; i < n; i++) {
    const t = e.pass('down', e.target(Math.floor(prev.w / 2), Math.floor(prev.h / 2), true), { src: prev, texel: [1 / prev.w, 1 / prev.h] })
    levels.push(t)
    prev = t
  }
  e.release(bright)
  let acc = levels[levels.length - 1]
  for (let i = levels.length - 2; i >= 0; i--) {
    const out = e.pass('up', e.target(levels[i].w, levels[i].h, true), { src: acc, base: levels[i], texel: [1 / acc.w, 1 / acc.h], radius })
    if (acc !== levels[levels.length - 1]) e.release(acc)
    acc = out
  }
  for (const l of levels) if (l !== acc) e.release(l)
  return { tex: acc, norm: e.halfFloat ? 1 / n : 1 }
}

function blurTimes(e: FxEngine, src: Tex, spread: number, times: number): Tex {
  let cur = e.pass('copy', e.target(src.w, src.h), { src })
  for (let i = 0; i < times; i++) {
    const s = spread * (i + 1)
    const a = e.pass('blur', e.target(cur.w, cur.h), { src: cur, dir: [s / cur.w, 0] })
    e.release(cur)
    cur = e.pass('blur', e.target(a.w, a.h), { src: a, dir: [0, s / a.h] })
    e.release(a)
  }
  return cur
}

function blendWith(e: FxEngine, src: Tex, other: Tex | null | undefined, mode: number, mixAmt: number): Tex {
  if (!other) return e.pass('copy', e.target(src.w, src.h), { src })
  // Cover-fit `other` into src's frame.
  const aA = src.w / src.h, bA = other.w / other.h
  const bScale = bA > aA ? [aA / bA, 1] : [1, bA / aA]
  const bOffset = bA > aA ? [(1 - aA / bA) / 2, 0] : [0, (1 - bA / aA) / 2]
  return e.pass('blend', e.target(src.w, src.h), { src, other, mode, mixAmt, bScale, bOffset })
}

export const EFFECTS: Record<EffectKind, EffectDef> = {
  bloom: {
    kind: 'bloom', label: 'Bloom', glyph: '✺', color: '#f2b84b',
    blurb: 'Bright areas glow and spill light',
    params: [P('threshold', 'Threshold', 0, 1, 0.01, 0.55), P('strength', 'Strength', 0, 12, 0.05, 5), P('radius', 'Radius', 0.5, 3, 0.05, 1.2)],
    run(e, src, p) {
      const glow = bloomGlow(e, src, p.threshold, p.radius)
      const out = e.pass('addGlow', e.target(src.w, src.h), { src: glow.tex, base: src, strength: p.strength * glow.norm, tint: [1, 1, 1] })
      e.release(glow.tex)
      return out
    },
  },
  glare: {
    kind: 'glare', label: 'Glare', glyph: '✳', color: '#9fd4ff',
    blurb: 'Star-shaped rays from highlights',
    params: [P('threshold', 'Threshold', 0, 1, 0.01, 0.7), P('length', 'Length', 0.2, 3, 0.05, 1.2), P('strength', 'Strength', 0, 24, 0.1, 8),
      P('rays', 'Rays', 2, 8, 1, 4), P('angle', 'Angle', 0, 180, 1, 20)],
    run(e, src, p) {
      // Streaks are traced at half the reference size: cheaper, softer,
      // and the same length relative to the picture at any working size.
      const u = unitOf(src)
      const w = Math.max(4, Math.floor(src.w / (2 * u))), h = Math.max(4, Math.floor(src.h / (2 * u)))
      const rays = Math.max(1, Math.round(p.rays))
      // The rays are ADDED. Half-float keeps the sum and addGlow averages
      // it, so more rays means more points on the star, not a brighter one;
      // on RGBA8 the sum would clip, so each ray is pre-divided instead.
      const gain = e.halfFloat ? 1 : 1 / rays, norm = e.halfFloat ? 1 / rays : 1
      const base = u > 1 ? e.scaled(src, w, h) : src
      const bright = e.pass('bright', e.target(w, h, true), { src: base, threshold: p.threshold, knee: 0.1, gain })
      if (base !== src) e.release(base)
      let sum: Tex | null = null
      for (let r = 0; r < rays; r++) {
        const a = (p.angle + r * 360 / rays) * Math.PI / 180
        let cur = e.pass('copy', e.target(w, h, true), { src: bright })
        for (let it = 0; it < 3; it++) {
          const step = Math.pow(4, it) * p.length
          const next = e.pass('streak', e.target(w, h, true), { src: cur, dir: [Math.cos(a) * step / w, Math.sin(a) * step / h], decay: 0.86 })
          e.release(cur)
          cur = next
        }
        if (!sum) sum = cur
        else { const s2 = e.pass('add', e.target(w, h, true), { src: cur, base: sum }); e.release(sum); e.release(cur); sum = s2 }
      }
      e.release(bright)
      const out = e.pass('addGlow', e.target(src.w, src.h), { src: sum!, base: src, strength: p.strength * norm, tint: [0.92, 0.97, 1.08] })
      e.release(sum)
      return out
    },
  },
  glow: {
    kind: 'glow', label: 'Soft glow', glyph: '◌', color: '#f5a3c7',
    blurb: 'A soft, dreamy haze over it all',
    params: [P('strength', 'Strength', 0, 1, 0.01, 0.45), P('spread', 'Spread', 0.5, 6, 0.1, 2.5)],
    run(e, src, p) {
      // Blurred at a quarter of the reference size, so Spread is the same
      // share of the picture at any working size.
      const u = unitOf(src)
      const small = e.scaled(src, Math.max(4, src.w / (4 * u)), Math.max(4, src.h / (4 * u)))
      const blurred = blurTimes(e, small, p.spread, 3)
      e.release(small)
      const out = blendWith(e, src, blurred, 1, p.strength)
      e.release(blurred)
      return out
    },
  },
  ink: {
    kind: 'ink', label: 'Ink lines', glyph: '✒', color: '#c9c9d6',
    blurb: 'Traces the edges in dark ink',
    params: [P('threshold', 'Threshold', 0.02, 1, 0.01, 0.22), P('weight', 'Weight', 0.5, 4, 0.05, 1.2), P('paper', 'Paper', 0, 1, 0.01, 0), P('amount', 'Amount', 0, 1, 0.01, 1)],
    run(e, src, p) {
      const edges = atRef(e, src)
      const out = e.pass('ink', e.target(src.w, src.h), {
        src, edges, texel: [1 / edges.w, 1 / edges.h], threshold: p.threshold, weight: p.weight,
        inkColor: [0.07, 0.06, 0.1], paper: p.paper, amount: p.amount,
      })
      if (edges !== src) e.release(edges)
      return out
    },
  },
  cel: {
    kind: 'cel', label: 'Cel shade', glyph: '◐', color: '#7fd1a8',
    blurb: 'Flat cartoon colour with outlines',
    params: [P('levels', 'Bands', 2, 8, 1, 4), P('saturation', 'Colour', 0, 1.6, 0.01, 1.15), P('lines', 'Lines', 0, 1, 0.01, 0.8)],
    run(e, src, p) {
      const flat = e.pass('cel', e.target(src.w, src.h), { src, levels: p.levels, sat: p.saturation })
      if (p.lines <= 0.001) return flat
      const edges = atRef(e, flat)
      const out = e.pass('ink', e.target(src.w, src.h), {
        src: flat, edges, texel: [1 / edges.w, 1 / edges.h], threshold: 0.28, weight: 1.1, inkColor: [0.05, 0.05, 0.08], paper: 0, amount: p.lines,
      })
      if (edges !== flat) e.release(edges)
      e.release(flat)
      return out
    },
  },
  sketch: {
    kind: 'sketch', label: 'Sketch', glyph: '✎', color: '#d9c9a8',
    blurb: 'Turns it into a pencil drawing',
    params: [P('radius', 'Softness', 0.5, 6, 0.1, 2), P('darkness', 'Darkness', 0.5, 4, 0.05, 1.8), P('color', 'Colour', 0, 1, 0.01, 0)],
    run(e, src, p) {
      // The inverse is blurred at the reference size; dodge reads it back
      // up through LINEAR filtering.
      const small = atRef(e, src)
      const inv = e.pass('invertGrey', e.target(small.w, small.h), { src: small })
      if (small !== src) e.release(small)
      const blurred = blurTimes(e, inv, p.radius, 3)
      e.release(inv)
      const out = e.pass('dodge', e.target(src.w, src.h), { src, blurred, darkness: p.darkness, colorKeep: p.color })
      e.release(blurred)
      return out
    },
  },
  halftone: {
    kind: 'halftone', label: 'Screentone', glyph: '⠿', color: '#b0b8ff',
    blurb: 'Printed comic-book dots',
    params: [P('cell', 'Dot size', 2, 24, 0.5, 6), P('angle', 'Angle', 0, 90, 1, 45), P('amount', 'Amount', 0, 1, 0.01, 0.85)],
    run(e, src, p) {
      return e.pass('halftone', e.target(src.w, src.h), { src, size: [src.w, src.h], cell: p.cell * unitOf(src), angle: p.angle * Math.PI / 180, amount: p.amount })
    },
  },
  chroma: {
    kind: 'chroma', label: 'Chromatic', glyph: '◎', color: '#ff8fb1',
    blurb: 'Colour fringes, like a cheap lens',
    params: [P('amount', 'Amount', 0, 6, 0.05, 1.2)],
    run(e, src, p) { return e.pass('chroma', e.target(src.w, src.h), { src, amount: p.amount * 0.01 }) },
  },
  grade: {
    kind: 'grade', label: 'Colour grade', glyph: '◑', color: '#ffd28f',
    blurb: 'Exposure, contrast, colour and tint',
    params: [P('exposure', 'Exposure', -2, 2, 0.01, 0), P('contrast', 'Contrast', 0.5, 1.8, 0.01, 1.08), P('saturation', 'Saturation', 0, 2, 0.01, 1.15),
      P('hue', 'Tint hue', 0, 360, 1, 210), P('tint', 'Tint', 0, 1, 0.01, 0.12)],
    run(e, src, p) {
      return e.pass('grade', e.target(src.w, src.h), { src, exposure: p.exposure, contrast: p.contrast, saturation: p.saturation, tint: hueTint(p.hue), tintAmt: p.tint })
    },
  },
  multiply: {
    kind: 'multiply', label: 'Multiply', glyph: '×', color: '#a8a8c8', blend: true, matte: 1,
    blurb: 'Darkens it with the next picture',
    params: [P('mix', 'Mix', 0, 1, 0.01, 1)],
    run(e, src, p, other) { return blendWith(e, src, other, 0, p.mix) },
  },
  screen: {
    kind: 'screen', label: 'Screen', glyph: '+', color: '#c8e0ff', blend: true, matte: 0,
    blurb: 'Lightens it with the next picture',
    params: [P('mix', 'Mix', 0, 1, 0.01, 1)],
    run(e, src, p, other) { return blendWith(e, src, other, 1, p.mix) },
  },
  overlay: {
    kind: 'overlay', label: 'Overlay', glyph: '◧', color: '#d7b8ff', blend: true, matte: 0.5,
    blurb: 'Mixes in the next picture, punchier',
    params: [P('mix', 'Mix', 0, 1, 0.01, 1)],
    run(e, src, p, other) { return blendWith(e, src, other, 2, p.mix) },
  },
  // Made by a model, not a shader: runChain runs these through aiEffects
  // (the desktop's GPU). `run` here is only the stand-in for anything that
  // calls an effect directly — the picture, unchanged.
  depth: {
    kind: 'depth', label: 'Depth', glyph: '◭', color: '#8fb3c9',
    blurb: 'How far away everything is, in grey',
    params: [P('far', 'Far is bright', 0, 1, 1, 0)],
    run(e, src) { return e.pass('copy', e.target(src.w, src.h), { src }) },
  },
  segment: {
    kind: 'segment', label: 'Segment', glyph: '◍', color: '#b9d98f',
    blurb: 'Finds the things you name and masks them',
    params: [P('cut', 'Cut out', 0, 1, 1, 0)],
    run(e, src) { return e.pass('copy', e.target(src.w, src.h), { src }) },
  },
}

/** An effect card's kind, safely: a node from a snapshot or another build
 *  may carry no `effect`, or a kind this build does not know — both read
 *  as Bloom (what the card's face shows) instead of throwing. */
export function effectKindOf(n: { effect?: { kind?: string } | null }): EffectKind {
  return knownKind(n.effect?.kind)
}

/** `k` if this build knows the kind, else Bloom. (An own key: `in` would
 *  also accept 'toString'.) */
export function knownKind(k: string | undefined): EffectKind {
  return k && Object.hasOwn(EFFECTS, k) ? (k as EffectKind) : 'bloom'
}

/** Params with every missing (or non-numeric) key filled from its default,
 *  and each held to its slider's range. */
export function effectParams(kind: EffectKind, params: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const d of EFFECTS[knownKind(kind)].params) {
    const v = params?.[d.key]
    out[d.key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(d.max, Math.max(d.min, v)) : d.default
  }
  return out
}

/** In the order the add menu lists them. */
export const EFFECT_ORDER: EffectKind[] = ['bloom', 'glare', 'glow', 'ink', 'cel', 'sketch', 'halftone', 'chroma', 'grade', 'multiply', 'screen', 'overlay', 'depth', 'segment']
