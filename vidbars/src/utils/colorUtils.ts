/** Color conversion and variant generation utilities */

export interface HSL { h: number; s: number; l: number }
export interface HSV { h: number; s: number; v: number }

export function hexToHsl(hex: string): HSL {
  const n = parseInt(hex.replace('#', ''), 16)
  const r = (n >> 16) / 255, g = ((n >> 8) & 0xff) / 255, b = (n & 0xff) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: h * 360, s, l }
}

export function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1/6) return p + (q - p) * 6 * t
    if (t < 1/2) return q
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6
    return p
  }
  h = ((h % 360) + 360) % 360 / 360
  if (s === 0) {
    const v = Math.round(l * 255)
    return `#${v.toString(16).padStart(2,'0').repeat(3)}`
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const r = Math.round(hue2rgb(p, q, h + 1/3) * 255)
  const g = Math.round(hue2rgb(p, q, h) * 255)
  const b = Math.round(hue2rgb(p, q, h - 1/3) * 255)
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`
}

export function hexToHsv(hex: string): HSV {
  const n = parseInt(hex.replace('#', ''), 16)
  const r = (n >> 16) / 255, g = ((n >> 8) & 0xff) / 255, b = (n & 0xff) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const d = max - min
  const v = max
  const s = max === 0 ? 0 : d / max
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  return { h: h * 360, s, v }
}

export function hsvToHex(h: number, s: number, v: number): string {
  h = ((h % 360) + 360) % 360 / 360
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s)
  let r = 0, g = 0, b = 0
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break
    case 1: r = q; g = v; b = p; break
    case 2: r = p; g = v; b = t; break
    case 3: r = p; g = q; b = v; break
    case 4: r = t; g = p; b = v; break
    case 5: r = v; g = p; b = q; break
  }
  return `#${Math.round(r*255).toString(16).padStart(2,'0')}${Math.round(g*255).toString(16).padStart(2,'0')}${Math.round(b*255).toString(16).padStart(2,'0')}`
}

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v))

/**
 * Generate 4 color variants around a base color:
 * - brighter1/brighter2: lighter + less saturated (pastel/muted)
 * - darker1/darker2: darker + more saturated (rich/deep)
 */
export function generateHoverVariants(hex: string) {
  const { h, s, l } = hexToHsl(hex)
  return {
    brighter1: hslToHex(h, clamp(s - 0.18), clamp(l + 0.14)),
    brighter2: hslToHex(h, clamp(s - 0.32), clamp(l + 0.24)),
    darker1:   hslToHex(h, clamp(s + 0.12), clamp(l - 0.14)),
    darker2:   hslToHex(h, clamp(s + 0.22), clamp(l - 0.24)),
  }
}
