// libraryApi.ts — the saved projects as a library the Card Browser can look
// through without opening them (Brian 2026-11-23: "open a deck browser and
// look through all the cards and decks of all the projects, and be able to
// search and then bring assets in that way").
//
// A saved project runs to 180 MB, nearly all of it pictures written into the
// file as base64. So each file gets a LIGHT copy: the same document with
// every such picture swapped for a short address that reads the bytes
// straight out of the original file, at the place they sit. The light copy
// is a few hundred KB, is kept beside the saves (snapshots/.library) and is
// rebuilt only when its file changes.
//
// The saved files are only ever READ here.
//
//   GET /api/library/list                      the saved projects
//   GET /api/library/light?f=&v=               one project's light copy
//   GET /api/library/blob?f=&v=&o=&n=&t=       one picture's bytes
//   GET /api/library/cards?f=&v=&ids=a,b       those cards, whole, to bring in

import fs from 'fs'
import path from 'path'
import type { Plugin } from 'vite'

const LIGHT_VERSION = 1
/** Past this a file cannot be read as one string; it is listed, unreadable. */
const MAX_BYTES = 480 * 1024 * 1024
/** A base64 picture this long or longer is swapped for its address. */
const MIN_B64 = 1024
/** Any other text is cut to this in the light copy: it is for looking, and
 *  a card brought in is read whole from the original. */
const MAX_TEXT = 4000

type Doc = Record<string, unknown>
interface BoardLike { id: string; bars?: Record<string, unknown>; rootIds?: string[] }
interface GroupLike { id: string; boardIds?: string[] }

export interface LibraryFile { file: string; v: string; name: string; savedAt: number; size: number }

/** `name.json`, or `cabinet/name.json`: nothing else is a saved project. */
function safeRel(rel: string | null): string | null {
  if (!rel || rel.includes('..') || rel.includes('\\')) return null
  return /^(cabinet\/)?[^/]+\.json$/.test(rel) ? rel : null
}

/** A project's boards by id, the first ("primary") board among them. Saves
 *  keep that one apart, as `bars` + `rootIds`. */
function boardsOf(doc: Doc): Record<string, BoardLike> {
  const out: Record<string, BoardLike> = {}
  for (const b of (Array.isArray(doc.extraBoards) ? doc.extraBoards as BoardLike[] : [])) {
    if (b && typeof b.id === 'string' && b.bars && Array.isArray(b.rootIds)) out[b.id] = b
  }
  const bars = doc.bars as Record<string, unknown> | undefined
  if (!out.primary && bars && Object.keys(bars).length > 0) {
    out.primary = {
      id: 'primary', projectName: doc.projectName ?? '', color: '#5b8dd9', nleRow: 0, nleX: 0,
      bars, rootIds: (doc.rootIds as string[] | undefined) ?? [], viewerBarId: null, selectedIds: [],
      savedCollapsedState: null, boardScale: 1,
      layers: { card: { heroImage: null, summary: '', text: '' }, block: { thumbnail: null, label: '', text: '' } },
    } as BoardLike
  }
  return out
}

export function libraryApi(): Plugin {
  const dir = path.resolve(__dirname, 'snapshots')
  const cacheDir = path.join(dir, '.library')
  const versionOf = (st: fs.Stats) => `${Math.round(st.mtimeMs)}-${st.size}`

  /** The file behind an address, when it is still the version asked for. */
  function resolve(q: URLSearchParams): { rel: string; abs: string; st: fs.Stats } | null {
    const rel = safeRel(q.get('f'))
    if (!rel) return null
    const abs = path.join(dir, rel)
    let st: fs.Stats
    try { st = fs.statSync(abs) } catch { return null }
    if (!st.isFile() || (q.get('v') && q.get('v') !== versionOf(st))) return null
    return { rel, abs, st }
  }

  function listFiles(): LibraryFile[] {
    const out: LibraryFile[] = []
    const add = (rel: string, fallbackName: string) => {
      try {
        const st = fs.statSync(path.join(dir, rel))
        if (!st.isFile()) return
        const v = versionOf(st)
        // The name and date a project was saved under are inside the file;
        // the light copy has them once it exists.
        const head = readHead(rel, v)
        out.push({ file: rel, v, name: head?.name ?? fallbackName, savedAt: head?.savedAt ?? Math.round(st.mtimeMs), size: st.size })
      } catch { /* gone since the listing */ }
    }
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { /* no saves yet */ }
    for (const f of names) if (f.endsWith('.json')) add(f, f.replace(/\.json$/, ''))
    // A cabinet drawer keeps its last few versions, `<drawer>_<time>.json`:
    // only the newest of each is that project.
    let cab: string[] = []
    try { cab = fs.readdirSync(path.join(dir, 'cabinet')) } catch { /* no cabinet */ }
    const newest = new Map<string, { f: string; t: number }>()
    for (const f of cab) {
      const m = /^(.*)_(\d+)\.json$/.exec(f)
      if (!m) continue
      const t = Number(m[2])
      if (!newest.has(m[1]) || newest.get(m[1])!.t < t) newest.set(m[1], { f, t })
    }
    for (const { f } of newest.values()) add(`cabinet/${f}`, 'Cabinet project')
    return out.sort((a, b) => b.savedAt - a.savedAt)
  }

  const cacheFile = (rel: string) => path.join(cacheDir, rel.replace(/[^\w.-]/g, '_'))
  const headFile = (rel: string) => cacheFile(rel).replace(/\.json$/, '.head.json')

  function readHead(rel: string, v: string): { name: string; savedAt: number } | null {
    try {
      const h = JSON.parse(fs.readFileSync(headFile(rel), 'utf-8'))
      return h.v === v && h.lv === LIGHT_VERSION ? h : null
    } catch { return null }
  }

  /** The light copy, as JSON text: from beside the saves, else made now. */
  function lightText(rel: string, abs: string, st: fs.Stats): string {
    const v = versionOf(st)
    const cached = cacheFile(rel)
    if (readHead(rel, v) && fs.existsSync(cached)) return fs.readFileSync(cached, 'utf-8')
    if (st.size > MAX_BYTES) throw new Error('too big to read')
    const buf = fs.readFileSync(abs)
    // latin1: one character per byte, so a place in the text IS the place in
    // the file, which is what the picture addresses are made of.
    const raw = buf.toString('latin1')
    // Found by hand, not by a pattern: a pattern run over a picture many MB
    // long overruns the stack.
    const parts: Buffer[] = []
    let at = 0
    for (let i = raw.indexOf('"data:'); i >= 0; i = raw.indexOf('"data:', i + 1)) {
      const comma = raw.indexOf(',', i)
      const head = comma > 0 && comma - i < 120 ? /^"data:([\w.+/-]+)(?:;[\w=-]+)*;base64$/.exec(raw.slice(i, comma)) : null
      if (!head) continue
      // base64 holds no quote, so the next one closes the string.
      const end = raw.indexOf('"', comma)
      const o = comma + 1, n = end - o
      // (Not one quoted inside some text: that is text, and stays.)
      if (end < 0 || n < MIN_B64 || raw[i - 1] === '\\' || raw[end - 1] === '\\') continue
      parts.push(buf.subarray(at, i))
      parts.push(Buffer.from(JSON.stringify(
        `/api/library/blob?f=${encodeURIComponent(rel)}&v=${v}&o=${o}&n=${n}&t=${encodeURIComponent(head[1])}`)))
      at = end + 1
      i = end
    }
    parts.push(buf.subarray(at))
    const doc = JSON.parse(Buffer.concat(parts).toString('utf-8'), (_k, val) => {
      if (typeof val !== 'string' || val.length <= MAX_TEXT || val.startsWith('/api/library/blob?')) return val
      // What is left that long is text, or a picture written some other way.
      return val.startsWith('data:') ? null : val.slice(0, MAX_TEXT)
    }) as Doc
    const name = typeof doc.name === 'string' && doc.name ? doc.name : path.basename(rel, '.json')
    const savedAt = typeof doc.savedAt === 'number' ? doc.savedAt : Math.round(st.mtimeMs)
    // Only what has the shape of a card: saves go back a long way.
    const groups = (Array.isArray(doc.groups) ? doc.groups as GroupLike[] : [])
      .filter(g => g && typeof g.id === 'string' && Array.isArray(g.boardIds))
    const text = JSON.stringify({ file: rel, v, name, savedAt, groups, boards: boardsOf(doc) })
    try {
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(cached, text, 'utf-8')
      fs.writeFileSync(headFile(rel), JSON.stringify({ v, lv: LIGHT_VERSION, name, savedAt }), 'utf-8')
    } catch { /* a copy that cannot be kept is made again next time */ }
    return text
  }

  // The last project a card was brought in from, whole: the next card out of
  // the same project does not read 180 MB again. Let go after a while.
  let whole: { key: string; doc: Doc; timer: NodeJS.Timeout } | null = null
  function wholeDoc(rel: string, abs: string, st: fs.Stats): Doc {
    const key = `${rel}@${versionOf(st)}`
    if (whole?.key !== key) {
      if (st.size > MAX_BYTES) throw new Error('too big to read')
      if (whole) clearTimeout(whole.timer)
      whole = { key, doc: JSON.parse(fs.readFileSync(abs, 'utf-8')) as Doc, timer: setTimeout(() => {}, 0) }
    }
    clearTimeout(whole.timer)
    whole.timer = setTimeout(() => { whole = null }, 120_000)
    whole.timer.unref?.()
    return whole.doc
  }

  return {
    name: 'library-api',
    configureServer(server) {
      const json = (res: import('http').ServerResponse, code: number, body: unknown) => {
        res.statusCode = code
        res.setHeader('Content-Type', 'application/json')
        res.end(typeof body === 'string' ? body : JSON.stringify(body))
      }
      const query = (req: { url?: string }) => new URL(req.url ?? '', 'http://x').searchParams

      server.middlewares.use('/api/library/list', (_req, res) => json(res, 200, listFiles()))

      server.middlewares.use('/api/library/light', (req, res) => {
        const f = resolve(query(req))
        if (!f) return json(res, 404, { error: 'Not found' })
        try { json(res, 200, lightText(f.rel, f.abs, f.st)) }
        catch (err) { json(res, 500, { error: err instanceof Error ? err.message : 'unreadable' }) }
      })

      server.middlewares.use('/api/library/blob', (req, res) => {
        const q = query(req)
        const f = resolve(q)
        const o = Number(q.get('o')), n = Number(q.get('n'))
        const type = q.get('t') ?? ''
        if (!f || !q.get('v') || !Number.isInteger(o) || !Number.isInteger(n) || o < 0 || n <= 0 || o + n > f.st.size
          || !/^(image|video|audio|model)\/[\w.+-]+$/.test(type)) { res.statusCode = 404; res.end(); return }
        fs.open(f.abs, 'r', (err, fd) => {
          if (err) { res.statusCode = 404; res.end(); return }
          const b64 = Buffer.alloc(n)
          fs.read(fd, b64, 0, n, o, (err2, got) => {
            fs.close(fd, () => {})
            const text = err2 ? '' : b64.toString('latin1', 0, got)
            if (!text || /[^A-Za-z0-9+/=]/.test(text)) { res.statusCode = 404; res.end(); return }
            res.setHeader('Content-Type', type)
            res.setHeader('X-Content-Type-Options', 'nosniff')
            // The address names the file's version, so what it gives never changes.
            res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
            res.end(Buffer.from(text, 'base64'))
          })
        })
      })

      server.middlewares.use('/api/library/cards', (req, res) => {
        const q = query(req)
        const f = resolve(q)
        const ids = new Set((q.get('ids') ?? '').split(',').filter(Boolean))
        if (!f || ids.size === 0) return json(res, 404, { error: 'Not found' })
        try {
          const doc = wholeDoc(f.rel, f.abs, f.st)
          const boards = boardsOf(doc)
          const groups = ((doc.groups as GroupLike[] | undefined) ?? []).filter(g => g && ids.has(g.id))
          const boardIds = new Set(groups.flatMap(g => g.boardIds ?? []))
          json(res, 200, { projectName: doc.projectName ?? '', groups, extraBoards: [...boardIds].map(id => boards[id]).filter(Boolean) })
        } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : 'unreadable' }) }
      })
    },
  }
}
