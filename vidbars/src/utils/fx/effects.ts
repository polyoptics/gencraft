// effects.ts — what an effect card can be. Each effect is a short
// composition of fxEngine passes plus the few sliders worth exposing.
//
// Blends (multiply, screen, overlay) take a SECOND image: the image card
// placed right after them on the strip (see chain.ts).

import type { FxEngine, Tex } from './fxEngine'
import type { Aux } from './aiEffects'

export type EffectKind =
  | 'bloom' | 'glare' | 'glow' | 'ink' | 'cel' | 'sketch'
  | 'halftone' | 'chroma' | 'grade' | 'multiply' | 'screen' | 'overlay'
  | 'depth' | 'segment' | 'filmline' | 'linemix' | 'formhatch' | 'bghatch' | 'shademix'
  | 'painthatch' | 'filmcel' | 'boilink' | 'misreg' | 'construction' | 'relight' | 'formlight' | 'bglayout' | 'bgwash'
  | 'stipple' | 'halftoneshade'
  | 'combine'

/** What an effect may need besides its picture, made from the strip's
 *  SOURCE picture by a model or tool (aiEffects.ts): a depth map, a mask of
 *  the things a Segment card names, the film outline's line layers. */
export type AuxKind = 'depth' | 'mask' | 'lines' | 'hatch' | 'look'

export interface ParamDef {
  key: string; label: string; min: number; max: number; step: number; default: number
  /** A name per step, shown instead of the number (a choice, not an amount). */
  names?: string[]
}

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
  /** What it needs besides the picture (declared, so a strip can say what
   *  is missing). runChain gets them first and passes them as `aux`; while
   *  one is still being made the step shows its picture unchanged. */
  needs?: AuxKind[]
  run(e: FxEngine, src: Tex, p: Record<string, number>, other?: Tex | null, aux?: Aux): Tex
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

/** '0d0b0a' -> [r, g, b] in 0..1. */
const hexRgb = (h: string) => [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)

/** A hatch card's layers (aux.hatch) over `src`, or on white (Show:
 *  Alone); the picture unchanged while they are being made. */
function hatchComp(e: FxEngine, src: Tex, p: Record<string, number>, aux?: Aux): Tex {
  const H = aux?.hatch
  if (!H) return e.pass('copy', e.target(src.w, src.h), { src })
  return e.pass('hatchComp', e.target(src.w, src.h), {
    src, A: H.a, K: H.k, B: H.b, Hc: H.h, P: H.p, penC: hexRgb(H.pencil),
    strength: H.mix.strength, curve: 1 / Math.max(0.25, H.mix.weight), dark: H.mix.dark, light: H.mix.light,
    clipA: H.background ? 1 : 0, show: Math.round(p.show),
  })
}

/** A drawing look's layers (aux.look) over `src` in the look's own order
 *  and blend modes, or on white (Show: Alone), at `Strength`; the picture
 *  unchanged while they are being made. */
function lookComp(e: FxEngine, src: Tex, p: Record<string, number>, aux?: Aux): Tex {
  const L = aux?.look
  if (!L) return e.pass('copy', e.target(src.w, src.h), { src })
  let cur = p.show >= 0.5
    ? e.pass('grade', e.target(src.w, src.h), { src, exposure: 24, contrast: 1, saturation: 0, tint: [1, 1, 1], tintAmt: 0 })
    : e.pass('copy', e.target(src.w, src.h), { src })
  for (const l of L.layers) {
    const next = e.pass('layerOver', e.target(src.w, src.h), { src: cur, C: l.c, A: l.a, S: L.picture, blendMode: l.mode, strength: p.strength * (L.strength ?? 1) })
    e.release(cur)
    cur = next
  }
  return cur
}

/** A card for one of the film's drawing looks (aiEffects LOOK_OF): Show and
 *  Strength (live), then the look's own dials (each re-draws it). The
 *  background looks need no subject. */
function lookDef(kind: EffectKind, label: string, glyph: string, color: string, blurb: string, dials: ParamDef[], background = false): EffectDef {
  return {
    kind, label, glyph, color, blurb,
    needs: background ? ['depth', 'look'] : ['depth', 'mask', 'look'],
    params: [{ ...P('show', 'Show', 0, 1, 1, 0), names: ['Over picture', 'Alone'] }, P('strength', 'Strength', 0, 2, 0.01, 1), ...dials],
    run(e, src, p, _o, aux) { return lookComp(e, src, p, aux) },
  }
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
  // Made from the strip's SOURCE picture by sketchLook's tools on the
  // desktop's GPU (aiEffects.ts). Without what they need they show the
  // picture unchanged.
  depth: {
    kind: 'depth', label: 'Depth', glyph: '◭', color: '#8fb3c9',
    blurb: 'How far away everything is, in grey',
    needs: ['depth'],
    params: [P('far', 'Far is bright', 0, 1, 1, 0)],
    run(e, src, p, _o, aux) {
      if (!aux?.depth) return e.pass('copy', e.target(src.w, src.h), { src })
      return e.pass(p.far >= 0.5 ? 'invertGrey' : 'copy', e.target(src.w, src.h), { src: aux.depth })
    },
  },
  segment: {
    kind: 'segment', label: 'Segment', glyph: '◍', color: '#b9d98f',
    blurb: 'Finds the things you name and masks them',
    needs: ['mask'],
    // Find with: SAM 3 understands descriptions ("the man in the yellow
    // jacket") and tracks through a sequence; DINO + SAM2 is the film's
    // own matte_auto.py engine (and the fallback where SAM 3 is missing).
    // Scale (the film's tools_scale/scale.py): how big each thing it finds is
    // on screen sets how tightly the drawing cards draw it. Reference size:
    // the size in px a thing is drawn at as tuned; Minimum scale: the
    // smallest it goes; Spacing follows scale: how much hatch spacing
    // follows it (look_formhatch's hatch_scale). Under these, per thing it
    // found, its measured scale or a fixed one, and "partly in view".
    params: [P('cut', 'Cut out', 0, 1, 1, 0), { ...P('engine', 'Find with', 0, 1, 1, 0), names: ['SAM 3', 'DINO + SAM2'] },
      P('ref', 'Reference size', 100, 1500, 10, 500), P('lo', 'Minimum scale', 0.05, 1, 0.05, 0.25),
      P('spacing_follow', 'Spacing follows scale', 0, 1, 0.05, 0.5)],
    run(e, src, p, _o, aux) {
      if (!aux?.mask) return e.pass('copy', e.target(src.w, src.h), { src })
      // Before a Film outline it only names what to outline: the picture
      // goes on (Cut out still cuts it).
      if (p.cut < 0.5) return e.pass('copy', e.target(src.w, src.h), { src: aux.namesForLines ? src : aux.mask })
      return e.pass('blend', e.target(src.w, src.h), { src, other: aux.mask, mode: 0, mixAmt: 1, bScale: [1, 1], bOffset: [0, 0] })
    },
  },
  // The film's line look (sketchLook look_hybrid_colerase.py), drawn by
  // the tool itself: a black brush outline round what a Segment card before
  // it finds ("person" without one), ink lines inside, light paper lines on
  // dark areas and the red col-erase pencil under it all. Its three outputs
  // are those layers; Show picks all of them over the picture, or one alone
  // on white. The drawing's dials re-draw it (seconds); a Line mix card
  // after it changes how the layers mix (live).
  filmline: {
    kind: 'filmline', label: 'Film outline', glyph: '✍', color: '#e0785a',
    blurb: 'The film’s brush outline, inside lines and red pencil',
    needs: ['mask', 'lines'],
    params: [
      { ...P('show', 'Show', 0, 3, 1, 0), names: ['All', 'Outline', 'Inside', 'Pencil'] },
      P('contour_w', 'Outline weight', 0.5, 12, 0.1, 4.2), P('detail', 'Inside detail', 0, 1, 0.01, 0.6),
      P('interior_w', 'Inside weight', 0.2, 3, 0.05, 1), P('rough', 'Pencil', 0, 1.5, 0.01, 0.6),
      P('rough_opacity', 'Pencil opacity', 0, 1, 0.01, 0.85), P('wobble', 'Wobble', 0, 5, 0.05, 1.2),
      P('dry', 'Dry brush', 0, 1, 0.01, 0.85), P('breaks', 'Breaks', 0, 0.6, 0.01, 0.1),
      P('restroke', 'Second stroke', 0, 1, 0.01, 0.8), P('seed', 'Variation', 0, 9999, 1, 3030),
      P('boil', 'Boil (frames held)', 1, 6, 1, 2),
    ],
    run(e, src, p, _o, aux) {
      const L = aux?.lines
      if (!L) return e.pass('copy', e.target(src.w, src.h), { src })
      const m = L.mix
      // Ink to colour needs the colour under the line, blurred (the look's
      // interior-ink deep shade).
      const under = m.tint > 0 ? blurTimes(e, src, 1.5, 2) : null
      const out = e.pass('lineComp', e.target(src.w, src.h), {
        src, under: under ?? src, sil: L.outline, ink: L.inside, pap: L.paper, pen: L.pencil,
        inkC: hexRgb(L.colors.ink), papC: hexRgb(L.colors.paper), hue: hexRgb(L.colors.pencil), graph: hexRgb(L.colors.graphite),
        cs: L.colors.pencil_tint, show: Math.round(p.show),
        strength: m.strength, pencilK: m.pencil, inkK: m.ink, curve: 1 / Math.max(0.25, m.weight),
        dark: m.dark, tintAmt: m.tint, tintValue: 0.45, light: m.light,
      })
      e.release(under)
      return out
    },
  },
  // The look mixer's line controls (sketchLook tools_scale/mixer_bake.py
  // remix_np): they change how the Film outline before it mixes its
  // layers, live, without re-drawing. The card itself passes its picture on.
  linemix: {
    kind: 'linemix', label: 'Line mix', glyph: '⧉', color: '#d9a35f',
    blurb: 'Mixes the film outline’s layers live',
    needs: ['lines'],
    params: [
      P('strength', 'Line strength', 0, 2, 0.01, 1), P('pencil', 'Pencil', 0, 2, 0.01, 1), P('ink', 'Ink', 0, 2, 0.01, 1),
      P('weight', 'Line weight', 0.25, 4, 0.01, 1), P('dark', 'Ink darkness', -1, 1, 0.01, 0),
      P('tint', 'Ink to colour', 0, 1, 0.01, 0), P('light', 'Highlights', 0, 2, 0.01, 1),
    ],
    run(e, src) { return e.pass('copy', e.target(src.w, src.h), { src }) },
  },
  // The film's hatching (sketchLook look_formhatch.py), drawn by the tool:
  // pen strokes that wrap round the form the depth gives each thing a
  // Segment card before it finds ("person" without one), denser in shadow,
  // in a deepened local colour, with optional light strokes. A Shading mix
  // after it sets its strength, line weight and ink live.
  formhatch: {
    kind: 'formhatch', label: 'Form hatch', glyph: '▤', color: '#c98a6a',
    blurb: 'Pen hatching that wraps round the form',
    needs: ['depth', 'mask', 'hatch'],
    params: [
      { ...P('show', 'Show', 0, 1, 1, 0), names: ['Over picture', 'Alone'] },
      P('spacing', 'Line spacing', 2, 20, 0.1, 6.5), P('weight', 'Stroke weight', 0.3, 4, 0.05, 1.5),
      P('angle', 'Angle', -90, 90, 1, 62), P('wrap', 'Wrap round form', 0, 2, 0.01, 0.65),
      P('tone1', 'Shade from', 0, 1, 0.01, 0.3),
      // The tool leaves colours darker than this without dark strokes (on
      // dark hair or clothes they hardly show); 0 hatches everything.
      P('dark_lum', 'Skip darks', 0, 0.5, 0.01, 0.2), P('default.cross', 'Cross-hatch', 0, 1, 0.01, 1),
      P('default.light', 'Light strokes', 0, 1, 0.01, 0), P('light_az', 'Light from', 0, 360, 1, 110),
      P('stroke_px', 'Stroke length', 10, 200, 1, 80), P('seed', 'Variation', 0, 9999, 1, 3030),
      P('boil', 'Boil (frames held)', 1, 6, 1, 2),
    ],
    run(e, src, p, _o, aux) { return hatchComp(e, src, p, aux) },
  },
  // The film's background hatching (sketchLook look_bg_depthhatch.py): the
  // painting's own shadow shapes hatched by the same hand, quieter and
  // finer with distance (from the depth), the subject a Segment card before
  // it names left untouched (no Segment card: all of it is background).
  bghatch: {
    kind: 'bghatch', label: 'Background hatch', glyph: '▥', color: '#8aa0b8',
    blurb: 'Hatches the background, quieter with distance',
    needs: ['depth', 'hatch'],
    params: [
      { ...P('show', 'Show', 0, 1, 1, 0), names: ['Over picture', 'Alone'] },
      P('spacing', 'Line spacing', 2, 20, 0.1, 6), P('weight', 'Stroke weight', 0.3, 4, 0.05, 1.3),
      P('opacity', 'Ink, near', 0, 1, 0.01, 0.8), P('far_opacity', 'Ink, far', 0, 1, 0.01, 0.35),
      P('far_cut', 'Far cut-off', 0, 0.5, 0.01, 0.08), P('paint_hi', 'Shadow from', 0.5, 1, 0.01, 0.84),
      P('cross', 'Cross-hatch', 0, 1, 0.01, 1), P('pencil', 'Far pencil', 0, 1, 0.01, 0),
      P('stroke_px', 'Stroke length', 10, 200, 1, 64), P('seed', 'Variation', 0, 9999, 1, 3030),
      P('boil', 'Boil (frames held)', 1, 6, 1, 2),
    ],
    run(e, src, p, _o, aux) { return hatchComp(e, src, p, aux) },
  },
  // The look mixer's shading controls (sketchLook mixer_bake.py remix_np:
  // bg / hatch strength, curve_*, dark_*, light): they change how the hatch
  // cards before it mix, live, without re-drawing.
  shademix: {
    kind: 'shademix', label: 'Shading mix', glyph: '▦', color: '#a3a07a',
    blurb: 'Mixes the hatching live',
    needs: ['hatch'],
    params: [
      P('hatch', 'Figure shading', 0, 2, 0.01, 1), P('bg', 'Back shading', 0, 2, 0.01, 1),
      P('hatch_weight', 'Figure weight', 0.25, 4, 0.01, 1), P('bg_weight', 'Back weight', 0.25, 4, 0.01, 1),
      P('hatch_dark', 'Figure ink', -1, 1, 0.01, 0), P('bg_dark', 'Back ink', -1, 1, 0.01, 0),
      P('light', 'Highlights', 0, 2, 0.01, 1),
      // The Stipple and Halftone cards before it: their strength.
      P('stipple', 'Stipple', 0, 2, 0.01, 1), P('halftone', 'Halftone', 0, 2, 0.01, 1),
    ],
    run(e, src) { return e.pass('copy', e.target(src.w, src.h), { src }) },
  },
  // The film's other drawing looks (sketchLook tools_scale/look_*.py), each
  // run whole by the tool on the picture; the layers it writes come back and
  // go over the picture as the look itself lays them (lookComp). The subject
  // looks draw on what a Segment card before them finds ("person" without
  // one); the background ones leave that subject alone, or treat the whole
  // picture as background when there is no Segment card.
  painthatch: lookDef('painthatch', 'Painted-shadow hatch', '▧', '#b58a78', 'Hatches the shadows already painted in', [
    P('spacing', 'Line spacing', 2, 16, 0.1, 6), P('width', 'Stroke width', 0.3, 4, 0.05, 1.4),
    P('angle', 'Angle', -90, 90, 1, 58), P('form', 'Follow form', 0, 5, 0.05, 2.5), P('cross', 'Cross-hatch', 0, 2, 0.01, 1),
    P('length', 'Stroke length', 5, 100, 1, 28), P('drop', 'Shadow depth', 0.1, 0.8, 0.01, 0.4),
    P('seed', 'Variation', 0, 9999, 1, 3030), P('boil', 'Boil (frames held)', 1, 6, 1, 2),
  ]),
  filmcel: lookDef('filmcel', 'Cel shadows', '◒', '#7c8fd0', 'Flat designed shadow shapes on the form', [
    P('light_deg', 'Light from', 0, 360, 1, 80), P('terminator', 'Shadow amount', -0.5, 1, 0.01, 0.3),
    P('flatten', 'Flatten', 0, 1, 0.01, 0.85), P('hatch', 'Feather hatch', 0, 1, 0.01, 0.75),
    P('cast', 'Cast shadows', 0, 1, 0.01, 0.8), P('agree', 'Follow painting', 0, 1, 0.01, 0.5),
    P('jitter_px', 'Wobble', 0, 5, 0.05, 1.4), P('seed', 'Variation', 0, 9999, 1, 3030), P('boil', 'Boil (frames held)', 1, 6, 1, 2),
  ]),
  boilink: lookDef('boilink', 'Boiling ink', '〰', '#9a9aa8', 'A brush contour, heavy on the shadow side', [
    P('weight_lit', 'Lit weight', 0.5, 8, 0.1, 2), P('weight_shadow', 'Shadow weight', 1, 16, 0.1, 7.5),
    P('light_deg', 'Light from', 0, 360, 1, 135), P('texture', 'Dry brush', 0, 3, 0.05, 1.2),
    P('stroke_len', 'Stroke length', 20, 300, 1, 100), P('lost_edges', 'Lost edges', 0, 1, 0.01, 0.45),
    P('wobble', 'Wobble', 0, 3, 0.05, 0.35), P('seed', 'Variation', 0, 9999, 1, 3030), P('boil', 'Boil (frames held)', 1, 6, 1, 2),
  ]),
  misreg: lookDef('misreg', 'Misregistered line', '⧈', '#8f8fb8', 'A brush line printed slightly off', [
    P('weight', 'Line weight', 1, 16, 0.1, 6), P('offset', 'Misregistration', 0, 30, 0.5, 8),
    P('off_deg', 'Offset direction', 0, 360, 1, 215), P('gap', 'Lost edges', 0, 0.5, 0.01, 0.08),
    P('dry', 'Dry brush', 0, 1, 0.01, 0.14), P('stroke_len', 'Stroke length', 20, 300, 1, 120),
    P('tremor', 'Tremor', 0, 3, 0.05, 0.7), P('seed', 'Variation', 0, 9999, 1, 3030), P('boil', 'Boil (frames held)', 1, 6, 1, 2),
  ]),
  construction: lookDef('construction', 'Red pencil construction', '✐', '#d0604a', 'A searching red pencil drawing of the outline', [
    P('weight', 'Line weight', 0.5, 10, 0.1, 4), P('passes', 'Searching passes', 0, 5, 1, 2),
    P('pass_spread', 'Pass spread', 0, 12, 0.1, 3.5), P('overshoot', 'Overshoot', 0, 40, 0.5, 14),
    P('construction', 'Construction lines', 0, 8, 0.1, 2), P('tone', 'Pencil darkness', 0, 1, 0.01, 0.94),
    P('grain', 'Paper grain', 0, 1, 0.01, 0.55), P('seed', 'Variation', 0, 9999, 1, 7), P('boil', 'Boil (frames held)', 1, 6, 1, 2),
  ]),
  relight: lookDef('relight', 'Relight', '☀', '#e8c27a', 'Adds key light, rim light, shadow and haze', [
    P('key_deg', 'Key from', 0, 360, 1, 135), P('key_elev', 'Key height', 0, 90, 1, 25),
    P('key', 'Key light', 0, 1, 0.01, 0.4), P('shadow', 'Shadow', 0, 1, 0.01, 0.6), P('rim', 'Rim light', 0, 3, 0.05, 0.8),
    P('spec', 'Shine', 0, 3, 0.05, 1), P('ao', 'Occlusion', 0, 1, 0.01, 0.42), P('haze', 'Background haze', 0, 0.5, 0.01, 0.07),
    // How much the picture's own light holds the new light back. The film's
    // tool holds it fully back (1) on busy, already-lit painting, which on
    // most pictures left nothing to see: the card starts low (aiEffects
    // CARD_DIALS sends it even when untouched).
    P('respect', "Follow picture's light", 0, 1, 0.01, 0.3),
  ]),
  formlight: lookDef('formlight', 'Form light', '◓', '#9cc4ff', 'Rim light and wrap shadow on the form', [
    P('rim', 'Rim light', 0, 4, 0.05, 1.6), P('shadow', 'Wrap shadow', 0, 2, 0.05, 1), P('glint', 'Glints', 0, 3, 0.05, 1),
    P('depth', 'Roundness', 0.2, 2, 0.05, 1), P('env', 'Backdrop light', 0, 1, 0.01, 0.35), P('rim_spread', 'Rim spread', 10, 180, 1, 70),
  ]),
  bglayout: lookDef('bglayout', 'Background layout', '⌗', '#c87a5a', 'A red pencil layout drawing of the background', [
    P('far_ratio', 'Reach', 2, 40, 0.5, 10), P('busy', 'Calm busy areas', 0, 2, 0.05, 1), P('horizon', 'Skyline', 0, 1, 0.01, 0.24),
    P('halo', 'Gap round subject', 0, 40, 0.5, 12), P('hi', 'Line threshold', 0.2, 1, 0.01, 0.6),
    P('seed', 'Variation', 0, 9999, 1, 3030), P('boil', 'Boil (frames held)', 1, 6, 1, 2),
  ], true),
  // Combine looks: on a loop strip with look rows (utils/rail RailData.rows),
  // lays each row's look over the picture it is given, each limited to the
  // mask of the Segment card in that row (a row with none: everywhere,
  // under the masked ones). runChain does the laying; `run` is the stand-in.
  combine: {
    kind: 'combine', label: 'Combine looks', glyph: '⊞', color: '#c9b38a',
    blurb: 'Lays the look rows over it, each in its mask',
    needs: ['mask'],
    params: [P('strength', 'Strength', 0, 1, 0.01, 1)],
    run(e, src) { return e.pass('copy', e.target(src.w, src.h), { src }) },
  },
  // The hatching's shading drawn as other marks (sketchLook tools_marks
  // pat_stipple.py, pat_halftone.py): the worker draws both hatches first
  // and reads their shading from them, as the film's export does. Where:
  // the figure (what a Segment card before it finds; without one, the whole
  // picture), the background, or both.
  stipple: lookDef('stipple', 'Stipple', '⁘', '#a89a86', "The hatching's shading as pen stippling", [
    { ...P('where', 'Where', 0, 2, 1, 0), names: ['Figure', 'Background', 'Both'] },
    P('ink', 'Ink', 0.1, 1, 0.01, 0.62), P('dot', 'Dot size', 0.5, 4, 0.05, 1.6), P('dark', 'Darkness', 0.2, 2, 0.01, 0.87),
    P('edge', 'Edge accent', 0, 1.5, 0.01, 0.7), P('form', 'Follow form', 0, 1, 0.01, 0.3),
    P('jitter', 'Hand', 0, 0.5, 0.01, 0.3), P('shiver', 'Boil', 0, 0.4, 0.01, 0.14),
  ], true),
  halftoneshade: lookDef('halftoneshade', 'Halftone', '⣿', '#8a9cae', "The hatching's shading as a printed halftone", [
    { ...P('where', 'Where', 0, 2, 1, 0), names: ['Figure', 'Background', 'Both'] },
    P('cell', 'Screen size', 0.8, 4, 0.05, 1.9), P('ink', 'Ink', 0.1, 1, 0.01, 0.5), P('angle', 'Screen angle', 0, 90, 1, 45),
    P('form', 'Follow form', 0, 1, 0.01, 0.35), P('drift', 'Registration drift', 0, 2, 0.01, 0.45),
  ], true),
  bgwash: lookDef('bgwash', 'Background wash', '▒', '#8f9adc', 'A cool shadow wash and haze with distance', [
    P('haze', 'Haze', 0, 1, 0.01, 0.45), P('wash', 'Wash', 0, 1, 0.01, 0.48), P('core', 'Core accent', 0, 1, 0.01, 0.18),
    P('shade_hi', 'Shadow from', 0.5, 1, 0.01, 0.9), P('grain', 'Granulation', 0, 1, 0.01, 0.3), P('mottle', 'Mottle', 0, 0.5, 0.01, 0.12),
    P('seed', 'Variation', 0, 9999, 1, 3030), P('boil', 'Boil (frames held)', 1, 6, 1, 2),
  ], true),
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
export const EFFECT_ORDER: EffectKind[] = ['bloom', 'glare', 'glow', 'ink', 'cel', 'sketch', 'halftone', 'chroma', 'grade', 'multiply', 'screen', 'overlay', 'depth', 'segment', 'filmline', 'linemix', 'formhatch', 'bghatch', 'shademix',
  'painthatch', 'filmcel', 'boilink', 'misreg', 'construction', 'relight', 'formlight', 'bglayout', 'bgwash', 'stipple', 'halftoneshade', 'combine']

/** The effects by what they are, for the palette: each group's name, a line
 *  on what its cards have in common, and its cards. Every kind is in one. */
export const EFFECT_GROUPS: { id: string; title: string; note: string; kinds: EffectKind[] }[] = [
  { id: 'light', title: 'Light and colour', note: 'Instant. Glow, glare and colour over the picture', kinds: ['bloom', 'glare', 'glow', 'chroma', 'grade'] },
  { id: 'stylize', title: 'Stylize', note: 'Instant. Turns the whole picture into a look', kinds: ['ink', 'cel', 'sketch', 'halftone'] },
  { id: 'blend', title: 'Blend', note: 'Instant. Mixes in the next picture, or the look rows', kinds: ['multiply', 'screen', 'overlay', 'combine'] },
  { id: 'find', title: 'Find', note: 'Maps the drawing cards read', kinds: ['depth', 'segment'] },
  { id: 'drawlines', title: 'Draw: lines and shading', note: 'Drawn by the pen tool: a second or two for each change', kinds: ['filmline', 'construction', 'boilink', 'misreg', 'formhatch', 'bghatch', 'painthatch', 'stipple', 'halftoneshade'] },
  { id: 'drawlight', title: 'Draw: light and paint', note: 'Drawn by the tool: a second or two for each change', kinds: ['filmcel', 'relight', 'formlight', 'bglayout', 'bgwash'] },
  { id: 'mix', title: 'Mix a drawing', note: 'Instant. Re-mixes a drawing', kinds: ['linemix', 'shademix'] },
]
