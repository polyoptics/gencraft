// contextSheet.ts — one image that hands a whole card (or deck) to an AI:
// its reference pictures laid out together with its name, summary and the
// text on every bar. A chat model reads all of it from one upload, an image
// model gets every reference at once, and any upload box takes one file.
//
// Size is decided BEFORE anything is drawn: planSheet() lays the sheet out
// at a chosen width and reports its pixel size; estimateBytes() guesses the
// file size; renderSheet() draws it. Pictures keep their aspect (only the
// extreme ones are cropped), so the height follows from the width — width
// is the one knob.

import type { BoardData, ProjectGroup } from '../store/boardsStore'
import { getMediaItems } from '../types/bar'
import { resolveMediaUrl } from './useResolvedMedia'
import { cardTitle, fillFields } from './faceStyle'

export interface SheetPicture {
  /** A DRAWABLE url: the image itself, or a video/model's poster. */
  url: string
  caption: string
  /** 'video' / '3D' for a poster standing in for its file. */
  badge?: string
}
export interface SheetNote { title: string; text: string; depth: number }
export interface SheetSection {
  title: string
  color: string
  summary: string
  body: string
  pictures: SheetPicture[]
  notes: SheetNote[]
}

const isUntitled = (s: string | undefined) => !s || s.trim() === '' || s.trim() === 'Untitled'

/** One file, one picture: two bars can reach the same file through urls
 *  that differ only in their version stamp (`/api/file?v=…&path=…`). */
function pictureKey(u: string): string {
  if (!u.startsWith('/api/file')) return u
  try { return new URL(u, 'http://x').searchParams.get('path')?.toLowerCase() ?? u } catch { return u }
}

/** What each card contributes: its face override, every picture on its
 *  bars (tree order), and every bar that carries a name or text. */
export function collectSheet(groups: ProjectGroup[], boards: Record<string, BoardData>): SheetSection[] {
  return groups.map(g => {
    const pictures: SheetPicture[] = []
    const seen = new Set<string>()
    const add = (p: SheetPicture) => {
      const k = pictureKey(p.url)
      if (!seen.has(k)) { seen.add(k); pictures.push(p) }
    }
    if (g.cardHeroImage) add({ url: g.cardHeroImage, caption: 'Card face' })
    const notes: SheetNote[] = []

    const walk = (board: BoardData, barId: string, depth: number) => {
      const bar = board.bars[barId]
      if (!bar) return
      const label = isUntitled(bar.name) ? '' : bar.name.trim()
      for (const m of getMediaItems(bar.content)) {
        const caption = label || m.originalName?.replace(/\.[^.]+$/, '') || ''
        if (m.type === 'image') add({ url: m.url, caption })
        else if ((m.type === 'video' || m.type === 'model') && m.posterUrl) {
          add({ url: m.posterUrl, caption, badge: m.type === 'video' ? 'video' : '3D' })
        }
      }
      const text = [bar.subtitle, bar.content?.headerText, bar.content?.text]
        .map(t => t?.trim()).filter(Boolean).join('\n')
      if (label || text) notes.push({ title: label, text, depth })
      for (const child of bar.children) walk(board, child, depth + 1)
    }
    for (const bid of g.boardIds) {
      const board = boards[bid]
      if (board) for (const rid of board.rootIds) walk(board, rid, 0)
    }

    return {
      title: cardTitle(groups, g) || 'Untitled',
      color: g.color || '#5b8dd9',
      summary: g.cardSummary?.trim() ?? '',
      body: fillFields(g.cardText ?? '', groups, g.id).trim(),
      pictures,
      notes,
    }
  })
}

/** How long one picture may take. A request that never settles (a stalled
 *  or offline drive, an IndexedDB read blocked by another tab) would
 *  otherwise hold the whole dialog on "Loading…" with Create disabled. */
const PICTURE_TIMEOUT_MS = 15_000

/** Decode every picture once (shared by the preview and the final render).
 *  A picture that cannot be read, or does not arrive in time, maps to null
 *  and draws as a placeholder. */
export async function loadSheetImages(sections: SheetSection[]): Promise<Map<string, HTMLImageElement | null>> {
  const urls = [...new Set(sections.flatMap(s => s.pictures.map(p => p.url)))]
  const out = new Map<string, HTMLImageElement | null>()
  await Promise.all(urls.map(async u => {
    const load = async (): Promise<HTMLImageElement | null> => {
      try {
        const src = await resolveMediaUrl(u)
        if (!src) return null
        const img = new Image()
        img.decoding = 'async'
        img.src = src
        await img.decode()
        return img.naturalWidth > 0 ? img : null
      } catch {
        return null
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>(r => { timer = setTimeout(() => r(null), PICTURE_TIMEOUT_MS) })
    out.set(u, await Promise.race([load(), late]))
    clearTimeout(timer)
  }))
  return out
}

export interface SheetOptions {
  width: number
  theme: 'dark' | 'light'
  includeNotes: boolean
}

interface PlacedPicture { x: number; y: number; w: number; h: number; img: HTMLImageElement | null; badge?: string }
interface PlacedText { x: number; y: number; text: string; font: string; color: string }
interface PlacedRect { x: number; y: number; w: number; h: number; color: string }
export interface SheetPlan {
  width: number
  height: number
  bg: string
  rects: PlacedRect[]
  pictures: PlacedPicture[]
  texts: PlacedText[]
}

/** What a canvas can hold — Chromium's limits: 32,767 px a side and
 *  268,435,456 px in all. Past either it returns a blank canvas, so the
 *  dialog refuses rather than produce an empty file. */
export const MAX_SIDE = 32767
export const MAX_AREA = 268435456

/** Null when a canvas can hold this size, else the limit it breaks. */
export function canvasLimitHit(width: number, height: number): string | null {
  if (width > MAX_SIDE || height > MAX_SIDE) return `a canvas holds at most ${MAX_SIDE.toLocaleString()} px a side`
  if (width * height > MAX_AREA) return `a canvas holds at most ${Math.floor(MAX_AREA / 1e6)} megapixels`
  return null
}

const FONT = 'system-ui, "Segoe UI", sans-serif'

let measureCtx: CanvasRenderingContext2D | null = null
function measurer(): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')!
  return measureCtx
}

/** Greedy word wrap; a word wider than the line is broken by characters. */
function wrap(text: string, font: string, maxW: number): string[] {
  const ctx = measurer()
  ctx.font = font
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const tryLine = line ? `${line} ${word}` : word
      if (ctx.measureText(tryLine).width <= maxW) { line = tryLine; continue }
      if (line) lines.push(line)
      if (ctx.measureText(word).width <= maxW) { line = word; continue }
      let part = ''
      for (const ch of word) {
        if (ctx.measureText(part + ch).width > maxW && part) { lines.push(part); part = ch } else part += ch
      }
      line = part
    }
    lines.push(line)
  }
  return lines
}

/** Lay the sheet out at `opts.width` px. Pure measurement — nothing drawn. */
export function planSheet(
  sections: SheetSection[],
  images: Map<string, HTMLImageElement | null>,
  opts: SheetOptions,
): SheetPlan {
  const W = Math.max(256, Math.round(opts.width))
  const P = Math.round(W * 0.03)           // outer padding
  const G = Math.max(2, Math.round(W * 0.008))
  const innerW = W - 2 * P
  const titleSize = W * 0.034, bodySize = W * 0.0135, captionSize = W * 0.0105
  const ink = opts.theme === 'dark' ? '#eef0f6' : '#15161c'
  const muted = opts.theme === 'dark' ? 'rgba(238,240,246,0.62)' : 'rgba(21,22,28,0.6)'
  const plan: SheetPlan = { width: W, height: 0, bg: opts.theme === 'dark' ? '#15161f' : '#f7f7f4', rects: [], pictures: [], texts: [] }

  let y = P
  const text = (s: string, font: string, color: string, size: number, x: number, maxW: number, lead = 1.32) => {
    for (const line of wrap(s, font, maxW)) {
      plan.texts.push({ x, y, text: line, font, color })
      y += size * lead
    }
  }

  sections.forEach((sec, si) => {
    if (si > 0) {
      y += P * 0.6
      plan.rects.push({ x: P, y, w: innerW, h: Math.max(1, Math.round(W * 0.0012)), color: muted })
      y += P * 0.6
    }
    plan.rects.push({ x: P, y, w: innerW, h: Math.max(3, Math.round(W * 0.005)), color: sec.color })
    y += Math.max(3, Math.round(W * 0.005)) + G * 2
    text(sec.title, `700 ${titleSize}px ${FONT}`, ink, titleSize, P, innerW, 1.2)
    if (sec.summary) { y += G * 0.5; text(sec.summary, `italic ${bodySize * 1.1}px ${FONT}`, muted, bodySize * 1.1, P, innerW) }
    if (sec.body) { y += G * 0.5; text(sec.body, `${bodySize}px ${FONT}`, ink, bodySize, P, innerW) }
    y += G * 2

    // Pictures in justified rows: each row is scaled so it exactly spans
    // the sheet, around a target height that gives ~3–4 per row. Pictures
    // keep their aspect; very wide or very tall ones get a clamped box (and
    // are centre-cropped into it by renderSheet) so one panorama cannot
    // flatten a whole row.
    const T = innerW / 3.4
    const cap = captionSize * 1.7
    const items = sec.pictures.map(p => {
      const img = images.get(p.url) ?? null
      const a = img ? img.naturalWidth / img.naturalHeight : 1.5
      return { p, img, a: Math.min(4, Math.max(0.25, a)) }
    })
    let row: typeof items = []
    const placeRow = (h: number) => {
      let x = P
      for (const it of row) {
        const w = it.a * h
        plan.pictures.push({ x, y, w, h, img: it.img, badge: it.p.badge })
        if (it.p.caption) {
          const font = `${captionSize}px ${FONT}`
          const line = wrap(it.p.caption, font, w)[0] ?? ''
          plan.texts.push({ x, y: y + h + captionSize * 0.35, text: line, font, color: muted })
        }
        x += w + G
      }
      y += h + (row.some(it => it.p.caption) ? cap : 0) + G
      row = []
    }
    for (const it of items) {
      row.push(it)
      const sumA = row.reduce((s, r) => s + r.a, 0)
      if (sumA * T + G * (row.length - 1) >= innerW) placeRow((innerW - G * (row.length - 1)) / sumA)
    }
    if (row.length) placeRow(Math.min(T, (innerW - G * (row.length - 1)) / row.reduce((s, r) => s + r.a, 0)))

    if (opts.includeNotes && sec.notes.length) {
      y += G
      text('Notes', `700 ${bodySize * 1.1}px ${FONT}`, ink, bodySize * 1.1, P, innerW)
      y += G * 0.5
      for (const n of sec.notes) {
        const indent = Math.min(6, n.depth) * W * 0.018
        if (n.title) text(n.title, `600 ${bodySize}px ${FONT}`, ink, bodySize, P + indent, innerW - indent)
        if (n.text) text(n.text, `${bodySize}px ${FONT}`, muted, bodySize, P + indent + (n.title ? W * 0.012 : 0), innerW - indent - (n.title ? W * 0.012 : 0))
        y += G * 0.6
      }
    }
  })

  plan.height = Math.max(Math.round(y + P), 64)
  return plan
}

/** Draw a plan. `scale` < 1 draws a preview of the same layout. */
export function renderSheet(plan: SheetPlan, scale = 1): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(plan.width * scale))
  c.height = Math.max(1, Math.round(plan.height * scale))
  const ctx = c.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.fillStyle = plan.bg
  ctx.fillRect(0, 0, plan.width, plan.height)
  ctx.imageSmoothingQuality = 'high'
  for (const r of plan.rects) { ctx.fillStyle = r.color; ctx.fillRect(r.x, r.y, r.w, r.h) }
  for (const p of plan.pictures) {
    if (p.img) {
      // Centre-crop to the box rather than stretch into it: the box's aspect
      // is clamped for extreme pictures (see planSheet). For every other
      // picture the two agree and nothing is cut.
      const iw = p.img.naturalWidth, ih = p.img.naturalHeight, boxA = p.w / p.h
      let sx = 0, sy = 0, sw = iw, sh = ih
      if (iw / ih > boxA) { sw = ih * boxA; sx = (iw - sw) / 2 }
      else { sh = iw / boxA; sy = (ih - sh) / 2 }
      ctx.drawImage(p.img, sx, sy, sw, sh, p.x, p.y, p.w, p.h)
    } else {
      ctx.fillStyle = 'rgba(128,128,128,0.25)'
      ctx.fillRect(p.x, p.y, p.w, p.h)
    }
    if (p.badge) {
      const s = Math.max(10, p.h * 0.09)
      ctx.font = `700 ${s}px ${FONT}`
      const tw = ctx.measureText(p.badge).width
      ctx.fillStyle = 'rgba(0,0,0,0.65)'
      ctx.fillRect(p.x + s * 0.4, p.y + s * 0.4, tw + s * 0.8, s * 1.4)
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'top'
      ctx.fillText(p.badge, p.x + s * 0.8, p.y + s * 0.6)
    }
  }
  ctx.textBaseline = 'top'
  for (const t of plan.texts) { ctx.font = t.font; ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, t.y) }
  return c
}

/** A rough [low, high] guess of the file size in bytes. Photographic
 *  content compresses to roughly 0.1–0.35 bytes per pixel as JPEG at high
 *  quality, 1–3 as PNG. It is a guide for "how huge is this", not a promise. */
export function estimateBytes(width: number, height: number, format: 'jpeg' | 'png'): [number, number] {
  const px = width * height
  return format === 'jpeg' ? [px * 0.1, px * 0.35] : [px * 1, px * 3]
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}
