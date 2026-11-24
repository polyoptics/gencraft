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
//                                              (or POST, with {ids} as the body)
//
// OTHER FOLDERS (Brian 2026-11-24: "If I just copy stuff over and throw it
// somewhere, I should be able to point the card browser at a directory
// somewhere anyway and read cards and stuff"). Any folder can be added to
// the library: the project files in it are listed with the saves, and an
// address names it with `d=`. A PACKAGE is such a folder made to travel:
// its project file names its pictures, videos and 3D models as
// `libmedia:<name>`, and they lie beside it in `media/`. Looked at, they are
// read where they lie; a card brought in takes copies of its own into
// public/uploads, so it no longer needs the package.
//
//   GET  /api/library/folders                  the added folders
//   POST /api/library/folders {add|remove}     add or take away one
//   POST /api/library/package-media?d=&m=      one file into a package (the body)
//   POST /api/library/package?d=&name=         a package's project file (the body)

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { Plugin } from 'vite'
import { diskFileUrl, isServableDiskPath, isUncPath } from './src/utils/diskUrl'

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

export interface LibraryFile { file: string; dir?: string; v: string; name: string; savedAt: number; size: number }

/** How a package names a file of its own, in `media/` beside it. */
const LIBMEDIA = 'libmedia:'
const mediaName = (s: string) => path.basename(s.slice(LIBMEDIA.length).replace(/\\/g, '/'))

/** Every string in a document, each replaced by what `fn` gives for it. */
function mapStrings(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return fn(v)
  if (Array.isArray(v)) return v.map(x => mapStrings(x, fn))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = mapStrings(x, fn)
    return out
  }
  return v
}

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
  const uploadsDir = path.resolve(__dirname, 'public/uploads')
  const versionOf = (st: fs.Stats) => `${Math.round(st.mtimeMs)}-${st.size}`

  // ── The added folders: this machine's own list, beside the light copies ──
  const foldersFile = path.join(cacheDir, 'folders.json')
  function folders(): string[] {
    try {
      const list = JSON.parse(fs.readFileSync(foldersFile, 'utf-8'))
      return Array.isArray(list) ? list.filter(x => typeof x === 'string') : []
    } catch { return [] }
  }
  function setFolders(list: string[]) {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(foldersFile, JSON.stringify([...new Set(list)], null, 1), 'utf-8')
  }
  /** A folder as typed or pasted (quotes and a trailing slash dropped), or
   *  null when it cannot be one: not a whole path, or on another computer. */
  function cleanDir(raw: unknown): string | null {
    if (typeof raw !== 'string') return null
    const d = raw.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '')
    return d && path.isAbsolute(d) && !isUncPath(d) ? path.normalize(d) : null
  }

  /** The file behind an address, when it is still the version asked for. */
  function resolve(q: URLSearchParams): { rel: string; d: string; abs: string; st: fs.Stats } | null {
    const d = q.get('d') ?? ''
    const rel = safeRel(q.get('f'))
    if (!rel || (d && (rel.includes('/') || !folders().includes(d)))) return null
    const abs = path.join(d || dir, rel)
    let st: fs.Stats
    try { st = fs.statSync(abs) } catch { return null }
    if (!st.isFile() || (q.get('v') && q.get('v') !== versionOf(st))) return null
    return { rel, d, abs, st }
  }

  function listFiles(): LibraryFile[] {
    const out: LibraryFile[] = []
    const add = (rel: string, fallbackName: string, d = '') => {
      try {
        const st = fs.statSync(path.join(d || dir, rel))
        if (!st.isFile()) return
        const v = versionOf(st)
        // The name and date a project was saved under are inside the file;
        // the light copy has them once it exists.
        const head = readHead(rel, d, v)
        out.push({ file: rel, ...(d ? { dir: d } : {}), v, name: head?.name ?? fallbackName, savedAt: head?.savedAt ?? Math.round(st.mtimeMs), size: st.size })
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
    // The project files lying in each added folder.
    for (const d of folders()) {
      let inside: string[] = []
      try { inside = fs.readdirSync(d) } catch { /* not there now (a drive unplugged): listed again when it is */ }
      for (const f of inside) if (f.endsWith('.json')) add(f, f.replace(/\.json$/, ''), d)
    }
    return out.sort((a, b) => b.savedAt - a.savedAt)
  }

  const cacheFile = (rel: string, d: string) => path.join(cacheDir,
    (d ? `dir-${crypto.createHash('sha1').update(d).digest('hex').slice(0, 10)}_` : '') + rel.replace(/[^\w.-]/g, '_'))
  const headFile = (rel: string, d: string) => cacheFile(rel, d).replace(/\.json$/, '.head.json')

  function readHead(rel: string, d: string, v: string): { name: string; savedAt: number } | null {
    try {
      const h = JSON.parse(fs.readFileSync(headFile(rel, d), 'utf-8'))
      return h.v === v && h.lv === LIGHT_VERSION ? h : null
    } catch { return null }
  }

  /** The light copy, as JSON text: from beside the saves, else made now. */
  function lightText(rel: string, d: string, abs: string, st: fs.Stats): string {
    const v = versionOf(st)
    const cached = cacheFile(rel, d)
    const where = `f=${encodeURIComponent(rel)}${d ? `&d=${encodeURIComponent(d)}` : ''}`
    if (readHead(rel, d, v) && fs.existsSync(cached)) return fs.readFileSync(cached, 'utf-8')
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
        `/api/library/blob?${where}&v=${v}&o=${o}&n=${n}&t=${encodeURIComponent(head[1])}`)))
      at = end + 1
      i = end
    }
    parts.push(buf.subarray(at))
    const doc = JSON.parse(Buffer.concat(parts).toString('utf-8'), (_k, val) => {
      if (typeof val !== 'string') return val
      // A package's own file, read where it lies.
      if (d && val.startsWith(LIBMEDIA)) return diskFileUrl(path.join(d, 'media', mediaName(val)))
      if (val.length <= MAX_TEXT || val.startsWith('/api/library/blob?')) return val
      // What is left that long is text, or a picture written some other way.
      return val.startsWith('data:') ? null : val.slice(0, MAX_TEXT)
    }) as Doc
    const name = typeof doc.name === 'string' && doc.name ? doc.name : path.basename(rel, '.json')
    const savedAt = typeof doc.savedAt === 'number' ? doc.savedAt : Math.round(st.mtimeMs)
    // Only what has the shape of a card: saves go back a long way.
    const groups = (Array.isArray(doc.groups) ? doc.groups as GroupLike[] : [])
      .filter(g => g && typeof g.id === 'string' && Array.isArray(g.boardIds))
    const text = JSON.stringify({ file: rel, ...(d ? { dir: d } : {}), v, name, savedAt, groups, boards: boardsOf(doc) })
    try {
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(cached, text, 'utf-8')
      fs.writeFileSync(headFile(rel, d), JSON.stringify({ v, lv: LIGHT_VERSION, name, savedAt }), 'utf-8')
    } catch { /* a copy that cannot be kept is made again next time */ }
    return text
  }

  // The last project a card was brought in from, whole: the next card out of
  // the same project does not read 180 MB again. Let go after a while.
  let whole: { key: string; doc: Doc; timer: NodeJS.Timeout } | null = null
  function wholeDoc(abs: string, st: fs.Stats): Doc {
    const key = `${abs}@${versionOf(st)}`
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

      /** Only this app's own page, on this machine, changes what is on disk. */
      const mayWrite = (req: import('http').IncomingMessage) => {
        const origin = req.headers.origin
        return req.method === 'POST' && (!origin || origin === `http://${req.headers.host}`)
      }
      const body = (req: import('http').IncomingMessage, max: number) => new Promise<Buffer>((done, fail) => {
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (c: Buffer) => { size += c.length; if (size > max) { req.destroy(); fail(new Error('too big')) } else chunks.push(c) })
        req.on('end', () => done(Buffer.concat(chunks)))
        req.on('error', fail)
      })

      server.middlewares.use('/api/library/folders', (req, res) => {
        if (req.method === 'GET') return json(res, 200, folders())
        if (!mayWrite(req)) return json(res, 403, { error: 'Not allowed' })
        void body(req, 10_000).then(raw => {
          const b = JSON.parse(raw.toString('utf-8')) as { add?: unknown; remove?: unknown }
          if (b.remove !== undefined) { setFolders(folders().filter(x => x !== b.remove)); return json(res, 200, folders()) }
          const d = cleanDir(b.add)
          if (!d) return json(res, 400, { error: 'That is not a whole folder path' })
          let isDir = false
          try { isDir = fs.statSync(d).isDirectory() } catch { /* not there */ }
          if (!isDir) return json(res, 400, { error: 'No folder is there' })
          setFolders([...folders(), d])
          json(res, 200, folders())
        }).catch(() => json(res, 400, { error: 'Could not read that' }))
      })

      // ── Writing a package ──
      const packageDir = (q: URLSearchParams) => cleanDir(q.get('d'))

      server.middlewares.use('/api/library/package-media', (req, res) => {
        const q = query(req)
        const d = packageDir(q)
        const name = path.basename(q.get('m') ?? '')
        if (!mayWrite(req) || !d || !name || !isServableDiskPath(name)) return json(res, 400, { error: 'Not allowed' })
        const to = path.join(d, 'media', name)
        try {
          fs.mkdirSync(path.dirname(to), { recursive: true })
          const tmp = `${to}.part`
          const out = fs.createWriteStream(tmp)
          const fail = () => { fs.rm(tmp, { force: true }, () => {}); json(res, 500, { error: 'Could not write' }) }
          out.on('error', fail)
          req.on('error', fail)
          out.on('finish', () => { try { fs.renameSync(tmp, to); json(res, 200, { ok: true }) } catch { fail() } })
          req.pipe(out)
        } catch { json(res, 500, { error: 'Could not write' }) }
      })

      server.middlewares.use('/api/library/package', (req, res) => {
        const q = query(req)
        const d = packageDir(q)
        const name = (q.get('name') ?? '').replace(/[^\w .-]/g, '_').trim()
        if (!mayWrite(req) || !d || !name) return json(res, 400, { error: 'That is not a whole folder path' })
        void body(req, 400 * 1024 * 1024).then(raw => {
          const doc = JSON.parse(raw.toString('utf-8')) as Doc
          const mediaDir = path.join(d, 'media')
          fs.mkdirSync(mediaDir, { recursive: true })
          let copied = 0
          const missing: string[] = []
          const done = new Map<string, string>()
          /** A file this machine holds, copied into the package under `as`. */
          const take = (from: string, as: string, url: string) => {
            if (done.has(url)) return done.get(url)!
            let to = url
            try {
              const dest = path.join(mediaDir, as)
              const st = fs.statSync(from)
              let same = false
              try { same = fs.statSync(dest).size === st.size } catch { /* not there yet */ }
              if (!same) fs.copyFileSync(from, dest)
              copied++
              to = LIBMEDIA + as
            } catch { missing.push(url) }
            done.set(url, to)
            return to
          }
          const out = mapStrings(doc, s => {
            if (s.startsWith('/uploads/')) {
              const file = decodeURIComponent(s.slice('/uploads/'.length).split(/[?#]/)[0])
              if (!file || file.includes('..') || /[\\/]/.test(file)) return s
              return take(path.join(uploadsDir, file), file, s)
            }
            if (s.startsWith('/api/file?')) {
              const p = new URLSearchParams(s.slice('/api/file?'.length)).get('path')
              if (!p || !path.isAbsolute(p) || isUncPath(p) || !isServableDiskPath(p)) return s
              // Two files of one name in different folders stay two.
              return take(p, `${crypto.createHash('sha1').update(p).digest('hex').slice(0, 8)}-${path.basename(p)}`, s)
            }
            return s
          })
          const file = `${name}.json`
          const tmp = path.join(d, `${file}.part`)
          fs.writeFileSync(tmp, JSON.stringify(out), 'utf-8')
          fs.renameSync(tmp, path.join(d, file))
          // Made here, it is browsed here too.
          setFolders([...folders(), d])
          json(res, 200, { ok: true, dir: d, file, copied, missing: missing.length })
        }).catch(err => json(res, 500, { error: err instanceof Error ? err.message : 'Could not write' }))
      })

      server.middlewares.use('/api/library/light', (req, res) => {
        const f = resolve(query(req))
        if (!f) return json(res, 404, { error: 'Not found' })
        try { json(res, 200, lightText(f.rel, f.d, f.abs, f.st)) }
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
        if (!f) return json(res, 404, { error: 'Not found' })
        // Many cards at once (a card and all the cards linked to it) are
        // named in the body: too long a list for an address.
        const named: Promise<string[]> = req.method === 'POST'
          ? body(req, 1_000_000).then(raw => (JSON.parse(raw.toString('utf-8')) as { ids?: unknown }).ids).then(x => Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : [])
          : Promise.resolve((q.get('ids') ?? '').split(',').filter(Boolean))
        void named.then(list => {
          const ids = new Set(list)
          if (ids.size === 0) return json(res, 404, { error: 'Not found' })
          const doc = wholeDoc(f.abs, f.st)
          const boards = boardsOf(doc)
          const groups = ((doc.groups as GroupLike[] | undefined) ?? []).filter(g => g && ids.has(g.id))
          const boardIds = new Set(groups.flatMap(g => g.boardIds ?? []))
          const out = { projectName: doc.projectName ?? '', groups, extraBoards: [...boardIds].map(id => boards[id]).filter(Boolean) }
          // Out of a package, a card takes its files with it: copied into
          // this machine's own uploads, once, and named from there.
          json(res, 200, f.d ? mapStrings(out, s => {
            if (!s.startsWith(LIBMEDIA)) return s
            const name = mediaName(s)
            const to = path.join(uploadsDir, name)
            try {
              fs.mkdirSync(uploadsDir, { recursive: true })
              if (!fs.existsSync(to)) fs.copyFileSync(path.join(f.d, 'media', name), to)
              return `/uploads/${encodeURIComponent(name)}`
            } catch { return s }
          }) : out)
        }).catch(err => { json(res, 500, { error: err instanceof Error ? err.message : 'unreadable' }) })
      })
    },
  }
}
