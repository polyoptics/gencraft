// mapSnapshot.ts — a 3D set's marked-up map as a picture on a card (Brian
// 2026-11-15): its ground, the pieces standing on it, its arrows and
// lines, and its notes (utils/mapNotes), as the flat view shows them. The
// card is new and lands in free space beside the set; nothing else moves.

import { useFreeNodeStore } from '../store/freeNodeStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { groundTile, GROUND_TINT, AREA_CELL } from '../components/Notes/AreaBody'
import { drawStroke, findFreeSlotRightOf } from '../components/Viewport3D/ImageStudio'
import { scenePieces, pieceShot, layPiece, PIECE_LIFT } from './scenePieces'
import { usePieceStore, getPiece, ensurePiece, type PiecePic } from '../three/pieceService'
import { curvesOf } from './curveParent'
import { curvePath, shownLine } from './curveGeom'
import { landSnip } from './snipCards'
import { markNew } from './newCards'
import { cardFaceSize } from './cardGrid'
import { notesOf, pinScale, PIN_DOT } from './mapNotes'

const CLAY = '#d8dce4'
const load = (src: string) => new Promise<HTMLImageElement | null>(done => {
  const img = new Image()
  img.onload = () => done(img)
  img.onerror = () => done(null)
  img.src = src
})
const soon = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), ms))])

/** Is `hex` a light colour (dark words go on it)? */
export function lightInk(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return true
  const n = parseInt(m[1], 16)
  return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 140
}

/** Words broken into lines no wider than `max`. */
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word
      if (line && ctx.measureText(next).width > max) { out.push(line); line = word } else line = next
    }
    out.push(line)
  }
  return out
}

/** Set `id`'s map, with its notes, as a new picture card beside it. The
 *  card's id, or null when none could be made. */
export async function snapshotSetMap(id: string): Promise<string | null> {
  const a = useFreeNodeStore.getState().nodes[id]
  if (!a || a.type !== 'area') return null
  const zoom = useCanvasStore.getState().zoom
  // Picture px per canvas unit: about 1600 px on its longer side.
  const k = Math.max(0.05, Math.min(4, 1600 / Math.max(a.width, a.height)))
  const W = Math.max(1, Math.round(a.width * k)), H = Math.max(1, Math.round(a.height * k))
  // What is a fixed size on the screen (a pin, its words): as big against
  // the set as the screen shows it now.
  const r = k / zoom
  const cnv = document.createElement('canvas')
  cnv.width = W; cnv.height = H
  const ctx = cnv.getContext('2d')!
  ctx.fillStyle = '#13141f'
  ctx.fillRect(0, 0, W, H)

  // The ground.
  const ground = a.ground ?? 'lines'
  if (ground !== 'none') {
    ctx.fillStyle = GROUND_TINT
    ctx.fillRect(0, 0, W, H)
    const t = groundTile(ground)
    const img = await load(t.src)
    if (img) {
      const T = Math.max(8, Math.round(t.size * k))
      const tile = document.createElement('canvas')
      tile.width = T; tile.height = T
      tile.getContext('2d')!.drawImage(img, 0, 0, T, T)
      const pat = ctx.createPattern(tile, 'repeat')
      if (pat) {
        const f = t.size * k / T
        const ox = ((a.gridAt?.x ?? 0) - AREA_CELL / 2) * k, oy = ((a.gridAt?.y ?? 0) - AREA_CELL / 2) * k
        pat.setTransform(new DOMMatrix().translate(ox, oy).scale(f))
        ctx.fillStyle = pat
        ctx.fillRect(0, 0, W, H)
      }
    }
  }
  ctx.strokeStyle = 'rgba(140,190,255,0.45)'
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1)

  // Its arrows and lines: each as one line in its colour, with its arrowheads.
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  for (const c of curvesOf(id)) {
    if (c.pts.length < 2) continue
    ctx.save()
    ctx.scale(k, k)
    ctx.translate(-a.x, -a.y)
    ctx.globalAlpha = c.opacity ?? 1
    ctx.strokeStyle = c.color
    ctx.fillStyle = c.endColor ?? c.color
    ctx.lineWidth = c.width
    ctx.stroke(new Path2D(curvePath(c)))
    for (const e of shownLine(c).ends) {
      if (e.kind !== 'arrow') continue
      const ang = Math.atan2(e.dir.y, e.dir.x), s = e.size
      ctx.beginPath()
      ctx.moveTo(e.tip.x, e.tip.y)
      ctx.lineTo(e.tip.x - Math.cos(ang - 0.42) * s, e.tip.y - Math.sin(ang - 0.42) * s)
      ctx.lineTo(e.tip.x - Math.cos(ang + 0.42) * s, e.tip.y - Math.sin(ang + 0.42) * s)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  }

  // The pieces standing on it, the bigger under the smaller.
  const sizes = usePieceStore.getState().sizes
  const pieces = scenePieces().filter(p => p.areaId === id)
  const laid: { area: number; draw: () => void }[] = []
  for (const p of pieces) {
    const shot = pieceShot(p), size = sizes[p.url]
    const pic: PiecePic | null = getPiece(p.url, shot.q, p.stretch) ?? await soon(ensurePiece(p.url, shot.q, p.stretch), 5000)
    const img = pic && size ? await load(pic.src) : null
    if (!pic || !size || !img) continue
    const lay = layPiece(p, pic, size, shot)
    const w = Math.max(1, Math.round(lay.w * k)), h = Math.max(1, Math.round(lay.h * k))
    if (w > 6000 || h > 6000) continue
    const off = document.createElement('canvas')
    off.width = w; off.height = h
    const o = off.getContext('2d')!
    o.fillStyle = p.tint ?? CLAY
    o.fillRect(0, 0, w, h)
    o.globalCompositeOperation = 'multiply'
    o.drawImage(img, 0, 0, w, h)
    o.globalCompositeOperation = 'destination-in'
    o.drawImage(img, 0, 0, w, h)
    const x = (p.x - a.x) * k, y = (p.y - p.h * PIECE_LIFT - a.y) * k
    laid.push({ area: w * h, draw: () => {
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(lay.turn)
      ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 1.5 * r; ctx.shadowOffsetY = r
      ctx.drawImage(off, -lay.ax * k, -lay.ay * k)
      ctx.restore()
      // Its name under it.
      const fs = 11 * r
      if (Math.max(w, h) > 28 * r) {
        ctx.font = `${fs}px system-ui, sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'
        ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 2 * r
        ctx.fillStyle = 'rgba(235,240,255,0.88)'
        const cs = Math.cos(lay.turn), sn = Math.sin(lay.turn), ax = lay.ax * k, ay = lay.ay * k
        const under = Math.max(...[[0, 0], [w, 0], [0, h], [w, h]].map(([cx, cy]) => (cx - ax) * sn + (cy - ay) * cs))
        ctx.fillText(p.name, x, y + under + 3 * r)
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0
      }
    } })
  }
  laid.sort((p, q) => q.area - p.area)
  for (const l of laid) l.draw()

  // Its notes: the marks, then the pins and their words.
  const notes = notesOf(id)
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  for (const m of notes.marks) drawStroke(ctx, m, p => ({ x: p.x * k, y: p.y * k }), k)
  const s = pinScale(zoom) * r
  const pins = [...notes.pins].sort((p, q) => p.n0 - q.n0)
  pins.forEach((p, i) => {
    const x = p.x * k, y = p.y * k, R = PIN_DOT / 2 * s
    ctx.beginPath()
    ctx.arc(x, y, R, 0, Math.PI * 2)
    ctx.fillStyle = p.color
    ctx.fill()
    ctx.lineWidth = 1.5 * s
    ctx.strokeStyle = 'rgba(12,13,22,0.9)'
    ctx.stroke()
    ctx.fillStyle = lightInk(p.color) ? '#12131f' : '#fff'
    ctx.font = `700 ${10 * s}px system-ui, sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(String(i + 1), x, y + 0.5 * s)
    if (!p.title && !p.desc) return
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'
    const max = 200 * s, pad = 6 * s, lh = 14 * s
    ctx.font = `600 ${11 * s}px system-ui, sans-serif`
    const head = p.title ? wrap(ctx, p.title, max) : []
    const headW = Math.max(0, ...head.map(l => ctx.measureText(l).width))
    ctx.font = `${11 * s}px system-ui, sans-serif`
    const body = p.desc ? wrap(ctx, p.desc, max) : []
    const bodyW = Math.max(0, ...body.map(l => ctx.measureText(l).width))
    const bw = Math.max(headW, bodyW) + pad * 2, bh = (head.length + body.length) * lh + 4 * s
    const bx = x + R + 4 * s, by = y - R
    ctx.beginPath()
    ctx.roundRect(bx, by, bw, bh, 5 * s)
    ctx.fillStyle = 'rgba(19,20,31,0.92)'
    ctx.fill()
    ctx.lineWidth = Math.max(1, s)
    ctx.strokeStyle = p.color
    ctx.globalAlpha = 0.6
    ctx.stroke()
    ctx.globalAlpha = 1
    let ty = by + 2 * s + 1.5 * s
    ctx.fillStyle = '#fff'
    ctx.font = `600 ${11 * s}px system-ui, sans-serif`
    for (const l of head) { ctx.fillText(l, bx + pad, ty); ty += lh }
    ctx.fillStyle = 'rgba(235,240,255,0.8)'
    ctx.font = `${11 * s}px system-ui, sans-serif`
    for (const l of body) { ctx.fillText(l, bx + pad, ty); ty += lh }
  })

  // (A data: url, never a blob: CLAUDE.md, generated media.)
  const url = W * H <= 1_200_000 ? cnv.toDataURL('image/png') : cnv.toDataURL('image/jpeg', 0.92)
  if (!url || url.length < 32) return null
  const now = useFreeNodeStore.getState().nodes[id] ?? a
  useUndoCoordinator.getState().checkpoint()
  const face = cardFaceSize()
  const gid = landSnip(
    { url, aspect: H / W, label: `${now.label || '3D set'} notes`, source: `mapnotes:${id}:${Date.now().toString(36)}` },
    () => findFreeSlotRightOf({ x: now.x, y: now.y, width: now.width + face.w * 0.5, height: now.height }, face.w, face.h),
  )
  if (gid) markNew([gid])
  return gid
}
