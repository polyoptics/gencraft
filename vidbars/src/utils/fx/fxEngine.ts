// fxEngine.ts — the GPU half of effect cards: a small WebGL2 image pipeline.
//
// ONE offscreen WebGL2 context for the whole app (browsers cap live
// contexts, and the 3D viewers already hold one). Images go in as textures,
// effects are fragment-shader passes between framebuffers, and a result
// comes out by drawing the final texture to this canvas and copying it to a
// 2D canvas. Targets are RGBA8 — plenty for looks work, and portable — plus
// half-float where a sum must run past 1 (bloom levels, glare rays) and the
// GPU can render to it.
//
// The pass vocabulary is deliberately small and general — blur, bright
// pass, directional streaks, mix — and the effects (effects.ts) are short
// compositions of it.

export interface Tex {
  tex: WebGLTexture
  fb: WebGLFramebuffer
  w: number
  h: number
  /** RGBA16F rather than RGBA8. */
  half: boolean
}

/** What can be uploaded: anything with a pixel size a 2D canvas can draw. */
export type FxSource = HTMLImageElement | HTMLCanvasElement | HTMLVideoElement | ImageBitmap

function sizeOf(s: FxSource): [number, number] {
  if (s instanceof HTMLImageElement) return [s.naturalWidth, s.naturalHeight]
  if (s instanceof HTMLVideoElement) return [s.videoWidth, s.videoHeight]
  return [s.width, s.height]
}

/** `src` with its long edge at most `side` — resampled on the CPU at high
 *  quality (a GPU shrink is one bilinear tap, and aliases), or `src` itself
 *  when it already fits. */
export function fitSource(src: FxSource, side: number): FxSource {
  const [w, h] = sizeOf(src)
  const k = side / Math.max(w, h)
  if (!(k < 1)) return src
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w * k))
  c.height = Math.max(1, Math.round(h * k))
  const g = c.getContext('2d')!
  g.imageSmoothingQuality = 'high'
  g.drawImage(src, 0, 0, c.width, c.height)
  return c
}

const bytesOf = (t: Tex) => t.w * t.h * (t.half ? 8 : 4)
/** The pool holds at most this much idle VRAM, so a full-size save does not
 *  stack up spare full-size targets while it runs (endRun drops what is
 *  left after it). */
const POOL_BYTES = 256 * 1024 * 1024
/** The GL canvas drops back to 1×1 after a readback bigger than this. */
const KEEP_CANVAS_PX = 2048 * 2048

const VERT = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`

/** Fragment shaders by name. Every one samples `src` at `uv`; extra
 *  uniforms are set per pass. */
const FRAG: Record<string, string> = {
  copy: `
    uniform sampler2D src;
    void main() { o = texture(src, uv); }`,

  // Source images are uploaded top-row-first; flipping once on the way in
  // keeps every later pass in GL's own orientation. They arrive
  // premultiplied, and transparency is settled here, over `matte`: black
  // for a source, the blend's neutral grey for a blend partner.
  flipIn: `
    uniform sampler2D src; uniform float matte;
    void main() { vec4 c = texture(src, vec2(uv.x, 1.0 - uv.y)); o = vec4(c.rgb + matte * (1.0 - c.a), 1.0); }`,

  // Soft-knee bright pass: what blooms and glares. Only the EXCESS above
  // the threshold passes (with a quadratic knee), not the whole bright
  // pixel — otherwise a light illustration is "bright" almost everywhere
  // and the glow swallows the picture. `gain` pre-scales what will be summed.
  bright: `
    uniform sampler2D src; uniform float threshold; uniform float knee; uniform float gain;
    void main() {
      vec3 c = texture(src, uv).rgb;
      float l = max(c.r, max(c.g, c.b));
      float rq = clamp(l - threshold + knee, 0.0, 2.0 * knee);
      rq = rq * rq / (4.0 * knee + 1e-4);
      float w = max(rq, l - threshold) / max(l, 1e-4);
      o = vec4(c * w * gain, 1.0);
    }`,

  // base + src, unclamped (a half-float target keeps the sum).
  add: `
    uniform sampler2D src; uniform sampler2D base;
    void main() { o = vec4(texture(base, uv).rgb + texture(src, uv).rgb, 1.0); }`,

  // 13-tap downsample (CoD/Jimenez) — the bloom pyramid's way down.
  down: `
    uniform sampler2D src; uniform vec2 texel;
    void main() {
      vec3 a = texture(src, uv + texel * vec2(-2, 2)).rgb, b = texture(src, uv + texel * vec2(0, 2)).rgb,
           c = texture(src, uv + texel * vec2(2, 2)).rgb, d = texture(src, uv + texel * vec2(-2, 0)).rgb,
           e = texture(src, uv).rgb, f = texture(src, uv + texel * vec2(2, 0)).rgb,
           g = texture(src, uv + texel * vec2(-2, -2)).rgb, h = texture(src, uv + texel * vec2(0, -2)).rgb,
           i = texture(src, uv + texel * vec2(2, -2)).rgb, j = texture(src, uv + texel * vec2(-1, 1)).rgb,
           k = texture(src, uv + texel * vec2(1, 1)).rgb, l = texture(src, uv + texel * vec2(-1, -1)).rgb,
           m = texture(src, uv + texel * vec2(1, -1)).rgb;
      vec3 r = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
      o = vec4(r, 1.0);
    }`,

  // 3x3 tent upsample added onto the level above — the pyramid's way up.
  up: `
    uniform sampler2D src; uniform sampler2D base; uniform vec2 texel; uniform float radius;
    void main() {
      vec2 t = texel * radius;
      vec3 s = texture(src, uv + vec2(-t.x, t.y)).rgb + texture(src, uv + vec2(0, t.y)).rgb * 2.0 + texture(src, uv + t).rgb
             + texture(src, uv + vec2(-t.x, 0)).rgb * 2.0 + texture(src, uv).rgb * 4.0 + texture(src, uv + vec2(t.x, 0)).rgb * 2.0
             + texture(src, uv - t).rgb + texture(src, uv + vec2(0, -t.y)).rgb * 2.0 + texture(src, uv + vec2(t.x, -t.y)).rgb;
      o = vec4(texture(base, uv).rgb + s / 16.0, 1.0);
    }`,

  // Separable 9-tap gaussian along `dir` (in texels, so it scales).
  blur: `
    uniform sampler2D src; uniform vec2 dir;
    void main() {
      vec4 c = texture(src, uv) * 0.2270270270;
      c += (texture(src, uv + dir * 1.3846153846) + texture(src, uv - dir * 1.3846153846)) * 0.3162162162;
      c += (texture(src, uv + dir * 3.2307692308) + texture(src, uv - dir * 3.2307692308)) * 0.0702702703;
      o = c;
    }`,

  // One leg of a glare streak: samples step out along `dir`, each weaker
  // by `decay` (Kawase-style; repeated passes with a growing step reach far).
  streak: `
    uniform sampler2D src; uniform vec2 dir; uniform float decay;
    void main() {
      vec3 c = vec3(0); float w = 1.0, tot = 0.0;
      for (int i = 0; i < 4; i++) {
        c += texture(src, uv + dir * float(i)).rgb * w; tot += w; w *= decay;
      }
      o = vec4(c / tot, 1.0);
    }`,

  // base + add * strength, tinted. Screen-style so whites do not clip hard.
  addGlow: `
    uniform sampler2D src; uniform sampler2D base; uniform float strength; uniform vec3 tint;
    void main() {
      vec3 b = texture(base, uv).rgb;
      vec3 g = texture(src, uv).rgb * tint * strength;
      o = vec4(1.0 - (1.0 - b) * (1.0 - clamp(g, 0.0, 1.0)) + max(g - 1.0, 0.0), 1.0);
    }`,

  // Two-image blends. `b` is cover-fitted into a's frame by bScale/bOffset.
  blend: `
    uniform sampler2D src; uniform sampler2D other; uniform int mode; uniform float mixAmt;
    uniform vec2 bScale; uniform vec2 bOffset;
    void main() {
      vec3 a = texture(src, uv).rgb;
      vec3 b = texture(other, uv * bScale + bOffset).rgb;
      vec3 r;
      if (mode == 0) r = a * b;                                         // multiply
      else if (mode == 1) r = 1.0 - (1.0 - a) * (1.0 - b);              // screen
      else if (mode == 2) r = mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a)); // overlay
      else if (mode == 3) r = min(a + b, 1.0);                          // add
      else r = mix((2.0 * b - 1.0) * (a - a * a) + a, (2.0 * b - 1.0) * (sqrt(a) - a) + a, step(0.5, b)); // soft light
      o = vec4(mix(a, r, mixAmt), 1.0);
    }`,

  // Ink lines: Sobel on luminance, shaped into a solid line weight. Edges
  // are found on `edges` (`src` itself, or its copy at the reference size;
  // `texel` is ITS texel), so a weight is the same share of the picture at
  // any working size.
  ink: `
    uniform sampler2D src; uniform sampler2D edges; uniform vec2 texel; uniform float threshold; uniform float weight;
    uniform vec3 inkColor; uniform float paper; uniform float amount;
    float L(vec2 o2) { vec3 c = texture(edges, uv + o2 * texel * weight).rgb; return dot(c, vec3(0.299, 0.587, 0.114)); }
    void main() {
      float gx = -L(vec2(-1,1)) - 2.0*L(vec2(-1,0)) - L(vec2(-1,-1)) + L(vec2(1,1)) + 2.0*L(vec2(1,0)) + L(vec2(1,-1));
      float gy = -L(vec2(-1,-1)) - 2.0*L(vec2(0,-1)) - L(vec2(1,-1)) + L(vec2(-1,1)) + 2.0*L(vec2(0,1)) + L(vec2(1,1));
      float e = smoothstep(threshold, threshold + 0.12, length(vec2(gx, gy)));
      vec3 base = mix(texture(src, uv).rgb, vec3(0.97, 0.96, 0.93), paper);
      o = vec4(mix(base, inkColor, e * amount), 1.0);
    }`,

  // Cel shading: quantise brightness into flat bands, keep the hue.
  cel: `
    uniform sampler2D src; uniform float levels; uniform float sat;
    void main() {
      vec3 c = texture(src, uv).rgb;
      float l = max(c.r, max(c.g, c.b));
      float q = (floor(l * levels + 0.5) / levels);
      vec3 hue = l > 0.0001 ? c / l : vec3(0);
      vec3 r = hue * q;
      float g = dot(r, vec3(0.299, 0.587, 0.114));
      o = vec4(mix(vec3(g), r, sat), 1.0);
    }`,

  // Radial chromatic aberration: R and B pulled apart from the centre.
  chroma: `
    uniform sampler2D src; uniform float amount;
    void main() {
      vec2 d = (uv - 0.5) * amount;
      o = vec4(texture(src, uv + d).r, texture(src, uv).g, texture(src, uv - d).b, 1.0);
    }`,

  // Manga screentone: dots on a rotated grid, sized by darkness.
  halftone: `
    uniform sampler2D src; uniform vec2 size; uniform float cell; uniform float angle; uniform float amount;
    void main() {
      vec2 px = uv * size;
      float s = sin(angle), c = cos(angle);
      vec2 r = mat2(c, -s, s, c) * px;
      vec2 cellUv = fract(r / cell) - 0.5;
      vec3 col = texture(src, uv).rgb;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      float rad = sqrt(1.0 - l) * 0.62;
      // Edge softened over one pixel at any cell size; no dot at all on white.
      float d = length(cellUv), aa = fwidth(d);
      float dotMask = (1.0 - smoothstep(rad - aa, rad + aa, d)) * smoothstep(0.0, aa, rad);
      vec3 tone = vec3(1.0 - dotMask);
      o = vec4(mix(col, tone * mix(vec3(1), col * 1.2, 0.25), amount), 1.0);
    }`,

  // Exposure / contrast / saturation / tint.
  grade: `
    uniform sampler2D src; uniform float exposure; uniform float contrast; uniform float saturation; uniform vec3 tint; uniform float tintAmt;
    void main() {
      vec3 c = texture(src, uv).rgb * exp2(exposure);
      c = (c - 0.5) * contrast + 0.5;
      float g = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(g), c, saturation);
      c = mix(c, c * tint * 1.6, tintAmt);
      o = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,

  // Pencil sketch: colour-dodge of the greyscale by its blurred inverse.
  // `blurred` is the blurred greyscale INVERSE prepared by the caller.
  dodge: `
    uniform sampler2D src; uniform sampler2D blurred; uniform float darkness; uniform float colorKeep;
    void main() {
      vec3 c = texture(src, uv).rgb;
      float g = dot(c, vec3(0.299, 0.587, 0.114));
      float b = texture(blurred, uv).r;
      float d = clamp(g / max(1.0 - b, 0.004), 0.0, 1.0);
      d = pow(d, darkness);
      o = vec4(mix(vec3(d), c * d, colorKeep), 1.0);
    }`,

  // The film outline's layers (alpha maps in .r) over the picture, as the
  // line look composites them (look_hybrid_colerase.py finish), with the
  // look mixer's line controls (mixer_bake.py remix_np). show: 0 all over
  // the picture; 1 the outline, 2 the inside lines, 3 the pencil, alone on
  // white.
  lineComp: `
    uniform sampler2D src; uniform sampler2D under; uniform sampler2D sil; uniform sampler2D ink;
    uniform sampler2D pap; uniform sampler2D pen;
    uniform vec3 inkC; uniform vec3 papC; uniform vec3 hue; uniform vec3 graph; uniform float cs; uniform float show;
    uniform float strength; uniform float pencilK; uniform float inkK; uniform float curve;
    uniform float dark; uniform float tintAmt; uniform float tintValue; uniform float light;
    void main() {
      float s = pow(texture(sil, uv).r, curve), a = pow(texture(ink, uv).r, curve);
      float p = pow(texture(pap, uv).r, curve), q = pow(texture(pen, uv).r, curve);
      s = clamp(s * inkK * strength, 0.0, 1.0); a = clamp(a * inkK * strength, 0.0, 1.0);
      p = clamp(p * inkK * light * strength, 0.0, 1.0); q = clamp(q * pencilK * strength, 0.0, 1.0);
      vec3 ic = dark > 0.0 ? inkC * (1.0 - dark) : inkC + (1.0 - inkC) * (-dark);
      if (tintAmt > 0.0) {
        vec3 u = texture(under, uv).rgb;
        vec3 deep = u * pow(u / max(max(u.r, max(u.g, u.b)), 1e-4), vec3(0.6)) * tintValue;
        ic = mix(ic, deep, tintAmt);
      }
      vec3 c = show < 0.5 ? texture(src, uv).rgb : vec3(1.0);
      if (show < 0.5 || show > 2.5) c = c * (1.0 - q) + q * ((1.0 - cs) * graph + cs * c * hue);
      if (show < 0.5) c = mix(c, papC, p);
      if (show < 0.5 || (show > 1.5 && show < 2.5)) c = mix(c, ic, a);
      if (show < 1.5) c = mix(c, ic, s);
      o = vec4(c, 1.0);
    }`,

  invertGrey: `
    uniform sampler2D src;
    void main() { float g = dot(texture(src, uv).rgb, vec3(0.299, 0.587, 0.114)); o = vec4(vec3(1.0 - g), 1.0); }`,
}

class FxEngine {
  readonly canvas: HTMLCanvasElement
  readonly gl: WebGL2RenderingContext
  /** The largest texture side this GPU takes; uploads are fitted to it. */
  readonly maxTexSide: number
  /** Half-float targets can be rendered to (EXT_color_buffer_float). */
  readonly halfFloat: boolean
  private programs = new Map<string, WebGLProgram>()
  /** Programs this driver rejected — rethrown, not recompiled per run. */
  private broken = new Map<string, Error>()
  private quad: WebGLBuffer
  private pool: Tex[] = []
  private pooledBytes = 0
  /** Targets handed out and not yet released — what endRun() reclaims. */
  private live = new Set<Tex>()

  constructor() {
    this.canvas = document.createElement('canvas')
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false })
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl
    this.maxTexSide = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS))
    this.halfFloat = this.canRenderHalf()
    this.quad = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  }

  private canRenderHalf(): boolean {
    const gl = this.gl
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return false
    const tex = gl.createTexture(), fb = gl.createFramebuffer()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1, 1, 0, gl.RGBA, gl.HALF_FLOAT, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.deleteFramebuffer(fb)
    gl.deleteTexture(tex)
    return ok
  }

  private program(name: string): WebGLProgram {
    const known = this.programs.get(name)
    if (known) return known
    const failure = this.broken.get(name)
    if (failure) throw failure
    const gl = this.gl
    const shaders: WebGLShader[] = []
    const sh = (type: number, srcText: string) => {
      const s = gl.createShader(type)!
      shaders.push(s)
      gl.shaderSource(s, srcText)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`fx shader ${name}: ${gl.getShaderInfoLog(s)}`)
      return s
    }
    const p = gl.createProgram()!
    try {
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT))
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, `#version 300 es\nprecision highp float;\nin vec2 uv;\nout vec4 o;\n${FRAG[name]}`))
      gl.bindAttribLocation(p, 0, 'p')
      gl.linkProgram(p)
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`fx program ${name}: ${gl.getProgramInfoLog(p)}`)
    } catch (err) {
      // A shader this driver rejects is rejected every time: remember that,
      // rather than recompile (and leak) on every slider tick.
      gl.deleteProgram(p)
      this.broken.set(name, err as Error)
      throw err
    } finally {
      // A linked program keeps what it needs; the shader objects can go.
      for (const s of shaders) gl.deleteShader(s)
    }
    this.programs.set(name, p)
    return p
  }

  /** A render target of this size — reused from the pool when possible.
   *  `half` asks for RGBA16F, and gets RGBA8 where the GPU cannot render
   *  to half-float. */
  target(w: number, h: number, half = false): Tex {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h))
    half = half && this.halfFloat
    const i = this.pool.findIndex(t => t.w === w && t.h === h && t.half === half)
    if (i >= 0) {
      const t = this.pool.splice(i, 1)[0]
      this.pooledBytes -= bytesOf(t)
      this.live.add(t)
      return t
    }
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, half ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, half ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fb = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    const t = { tex, fb, w, h, half }
    this.live.add(t)
    return t
  }

  /** Hand a target back for reuse. Releasing one twice is a no-op. */
  release(t: Tex | null | undefined): void {
    if (!t || !this.live.delete(t)) return
    this.pool.push(t)
    this.pooledBytes += bytesOf(t)
    // Bounded by count and by bytes: a long session of odd sizes, or one
    // full-size save, must not hoard GPU memory.
    while (this.pool.length > 24 || this.pooledBytes > POOL_BYTES) this.free(this.pool.shift()!)
  }

  private free(t: Tex): void {
    this.pooledBytes -= bytesOf(t)
    this.gl.deleteTexture(t.tex)
    this.gl.deleteFramebuffer(t.fb)
  }

  /** Close a run. Every target it did not hand back returns to the pool
   *  (an effect that threw midway), then pooled targets with a long edge
   *  over `keepSide` are freed: only working sizes recur, so a save's
   *  full-size targets would just hold VRAM. */
  endRun(keepSide: number): void {
    for (const t of [...this.live]) this.release(t)
    this.pool = this.pool.filter(t => {
      if (Math.max(t.w, t.h) <= keepSide) return true
      this.free(t)
      return false
    })
  }

  /** Upload an image/video/canvas, fitted so its long edge is ≤ maxSide
   *  (and the GPU's limit). Where a source recurs, pass it already fitted
   *  (fitSource) — fitting is CPU work. `matte` is what transparency
   *  becomes; see flipIn. */
  upload(src: FxSource, maxSide: number, matte = 0): Tex {
    const fit = fitSource(src, Math.min(maxSide, this.maxTexSide))
    const [w, h] = sizeOf(fit)
    const gl = this.gl
    const raw = gl.createTexture()!
    try {
      gl.bindTexture(gl.TEXTURE_2D, raw)
      // Premultiplied, so filtering never bleeds the colour hidden under
      // transparent pixels into their edges.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, fit)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return this.pass('flipIn', this.target(w, h), { src: raw, matte })
    } finally {
      gl.deleteTexture(raw)
    }
  }

  /** `t` resampled to w×h, in a new target of t's format. A reduction goes
   *  by halves — under LINEAR each halving is an exact 2×2 box — so a big
   *  one does not alias the way a single tap would. */
  scaled(t: Tex, w: number, h: number): Tex {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h))
    let cur = t
    while (cur.w >= 2 * w && cur.h >= 2 * h) {
      const next = this.pass('copy', this.target(cur.w >> 1, cur.h >> 1, cur.half), { src: cur })
      if (cur !== t) this.release(cur)
      cur = next
    }
    if (cur !== t && cur.w === w && cur.h === h) return cur
    const out = this.pass('copy', this.target(w, h, t.half), { src: cur })
    if (cur !== t) this.release(cur)
    return out
  }

  /** Run one shader into `out`. Uniform values: textures as Tex or a raw
   *  WebGLTexture, numbers, and [x, y] / [r, g, b] arrays. */
  pass(name: string, out: Tex, uniforms: Record<string, Tex | WebGLTexture | number | number[]>): Tex {
    const gl = this.gl
    const p = this.program(name)
    gl.useProgram(p)
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb)
    gl.viewport(0, 0, out.w, out.h)
    let unit = 0
    for (const [k, v] of Object.entries(uniforms)) {
      const loc = gl.getUniformLocation(p, k)
      if (loc === null) continue
      if (typeof v === 'number') {
        if (k === 'mode') gl.uniform1i(loc, v); else gl.uniform1f(loc, v)
      } else if (Array.isArray(v)) {
        if (v.length === 2) gl.uniform2f(loc, v[0], v[1]); else gl.uniform3f(loc, v[0], v[1], v[2])
      } else {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, (v as Tex).tex ?? (v as WebGLTexture))
        gl.uniform1i(loc, unit++)
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    return out
  }

  /** Copy a result to a fresh 2D canvas (top row first again). */
  toCanvas(t: Tex): HTMLCanvasElement {
    const gl = this.gl
    const c = this.canvas
    // Drawn into the GL canvas's bottom-left corner. The canvas only grows,
    // so small previews do not reallocate it, and drops back after a big
    // readback, so a full-size save does not keep its buffer.
    if (c.width < t.w || c.height < t.h) {
      c.width = Math.max(c.width, t.w)
      c.height = Math.max(c.height, t.h)
    }
    if (gl.drawingBufferWidth !== c.width || gl.drawingBufferHeight !== c.height) {
      // The browser could not allocate it at that size and shrank it; a
      // readback would come out cropped or stretched.
      c.width = c.height = 1
      throw new Error('This result is too large for the GPU.')
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, t.w, t.h)
    const p = this.program('copy')
    gl.useProgram(p)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, t.tex)
    gl.uniform1i(gl.getUniformLocation(p, 'src'), 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    const out = document.createElement('canvas')
    out.width = t.w
    out.height = t.h
    // The default framebuffer is bottom-row-first; drawImage of the GL
    // canvas reads it the right way up (its bottom-left corner is the
    // canvas's last t.h rows).
    out.getContext('2d')!.drawImage(c, 0, c.height - t.h, t.w, t.h, 0, 0, t.w, t.h)
    if (c.width * c.height > KEEP_CANVAS_PX) c.width = c.height = 1
    return out
  }
}

let engine: FxEngine | null = null
let failedAt = -Infinity
/** After a failed start, how long before trying again — a crashed GPU
 *  process, or WebGL blocked after a reset, often comes back. */
const RETRY_MS = 15_000
/** The shared engine, or null where WebGL2 is unavailable (for now). A
 *  lost context (GPU reset, driver timeout, out of memory — a full-size
 *  save is the likely trigger) is not restored: the next call builds a
 *  fresh engine, with an empty pool and program cache. */
export function fx(): FxEngine | null {
  if (engine?.gl.isContextLost()) engine = null
  if (engine || performance.now() - failedAt < RETRY_MS) return engine
  try { engine = new FxEngine() } catch (err) { failedAt = performance.now(); console.warn('[fx] unavailable, will retry:', err) }
  return engine
}
export type { FxEngine }
