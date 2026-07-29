import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'
import path from 'path'
import type { Plugin } from 'vite'
import Busboy from 'busboy'
import crypto from 'crypto'

/** Vite plugin: POST /api/upload — saves files to public/uploads/, returns URL */
function fileUploadApi(): Plugin {
  const uploadDir = path.resolve(__dirname, 'public/uploads')

  function ensureDir() {
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })
  }

  function detectMediaType(mime: string): 'image' | 'video' | 'audio' {
    if (mime.startsWith('video/')) return 'video'
    if (mime.startsWith('audio/')) return 'audio'
    return 'image'
  }

  return {
    name: 'file-upload-api',
    configureServer(server) {
      server.middlewares.use('/api/upload', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }

        ensureDir()
        const bb = Busboy({ headers: req.headers as Record<string, string> })
        let fileProcessed: Promise<{ url: string; type: string; originalName: string }> | null = null

        bb.on('file', (_fieldname: string, file: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
          const { filename, mimeType } = info
          const uuid = crypto.randomUUID().slice(0, 8)
          const safeName = (filename || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_')
          const diskName = `${uuid}-${safeName}`
          const diskPath = path.join(uploadDir, diskName)
          const ws = fs.createWriteStream(diskPath)
          file.pipe(ws)

          fileProcessed = new Promise((resolve, reject) => {
            ws.on('finish', () => resolve({
              url: `/uploads/${diskName}`,
              type: detectMediaType(mimeType),
              originalName: filename,
            }))
            ws.on('error', reject)
          })
        })

        bb.on('finish', async () => {
          res.setHeader('Content-Type', 'application/json')
          if (fileProcessed) {
            try {
              const result = await fileProcessed
              res.end(JSON.stringify(result))
            } catch {
              res.statusCode = 500
              res.end(JSON.stringify({ error: 'Write failed' }))
            }
          } else {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'No file received' }))
          }
        })

        bb.on('error', () => {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Upload failed' }))
        })

        req.pipe(bb)
      })
    },
  }
}

/** Tiny Vite plugin: serves GET/POST /api/user-templates backed by a JSON file */
function userTemplatesApi(): Plugin {
  const filePath = path.resolve(__dirname, 'user-templates.json')

  function readFile(): unknown[] {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      }
    } catch { /* ignore parse errors */ }
    return []
  }

  return {
    name: 'user-templates-api',
    configureServer(server) {
      server.middlewares.use('/api/user-templates', (req, res) => {
        res.setHeader('Content-Type', 'application/json')

        if (req.method === 'GET') {
          res.end(JSON.stringify(readFile()))
          return
        }

        if (req.method === 'POST') {
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            try {
              const data = JSON.parse(body)
              fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
              res.end(JSON.stringify({ ok: true }))
            } catch (e) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Invalid JSON' }))
            }
          })
          return
        }

        res.statusCode = 405
        res.end(JSON.stringify({ error: 'Method not allowed' }))
      })
    },
  }
}

/** Vite plugin: GET/POST /api/snapshots — full scene snapshots stored as individual JSON files */
function snapshotsApi(): Plugin {
  const dir = path.resolve(__dirname, 'snapshots')

  function ensureDir() {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }

  function listSnapshots(): { id: string; name: string; savedAt: number; file: string }[] {
    ensureDir()
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    return files.map(f => {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8')
        const data = JSON.parse(raw)
        return { id: data.id ?? f, name: data.name ?? f.replace('.json', ''), savedAt: data.savedAt ?? 0, file: f }
      } catch { return null }
    }).filter(Boolean) as { id: string; name: string; savedAt: number; file: string }[]
  }

  return {
    name: 'snapshots-api',
    configureServer(server) {
      // List all snapshots (metadata only)
      server.middlewares.use('/api/snapshots/list', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(listSnapshots()))
      })

      // Get a specific snapshot by filename
      server.middlewares.use('/api/snapshots/load/', (req, res) => {
        const file = req.url?.replace(/^\//, '') ?? ''
        const filePath = path.join(dir, file)
        if (!file || !fs.existsSync(filePath)) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'Not found' }))
          return
        }
        res.setHeader('Content-Type', 'application/json')
        fs.createReadStream(filePath).pipe(res)
      })

      // Save a new snapshot
      server.middlewares.use('/api/snapshots/save', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('{}'); return }
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString() })
        req.on('end', () => {
          try {
            const data = JSON.parse(body)
            ensureDir()
            const safeName = (data.name || 'snapshot').replace(/[^a-zA-Z0-9_-]/g, '_')
            const fileName = `${safeName}.json`
            fs.writeFileSync(path.join(dir, fileName), JSON.stringify(data), 'utf-8')
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, file: fileName }))
          } catch {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Invalid JSON' }))
          }
        })
      })

      // Delete a snapshot
      server.middlewares.use('/api/snapshots/delete/', (req, res) => {
        if (req.method !== 'DELETE') { res.statusCode = 405; res.end('{}'); return }
        const file = req.url?.replace(/^\//, '') ?? ''
        const filePath = path.join(dir, file)
        if (file && fs.existsSync(filePath)) fs.unlinkSync(filePath)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })
    },
  }
}

/** Vite plugin: GET /api/browse?dir=<abs-or-relative path>
 *
 *  Lists the media files in a directory on disk so the Media Pool can point
 *  at a real folder. Files are returned as URLs the browser can load:
 *  anything under public/ is already served, and anything OUTSIDE it is
 *  streamed back through /api/file so the pool is not limited to the
 *  project. Dev-server only, which is the trust boundary here — this is a
 *  local-first tool, not a hosted service. */
function browseApi(): Plugin {
  const publicDir = path.resolve(__dirname, 'public')
  const MEDIA = /\.(png|jpe?g|webp|gif|avif|bmp|svg|mp4|webm|mov|mp3|wav|ogg|glb|gltf|fbx)$/i
  const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i

  function kindOf(name: string): string {
    if (/\.(mp4|webm|mov)$/i.test(name)) return 'video'
    if (/\.(mp3|wav|ogg)$/i.test(name)) return 'audio'
    if (/\.(glb|gltf|fbx)$/i.test(name)) return 'model'
    return 'image'
  }

  // ── Thumbnails ────────────────────────────────────────────────────────
  //
  // Painting an 8.5 MB PNG into a 72 px tile is the client's second-biggest
  // cost after model posters, and it is one the dev server can retire for
  // good: encode a small copy once, keep it on disk, serve it forever.
  //
  // ONE width, not a {128,256,512} ladder. 384 covers the largest tile
  // (156 px) at DPR 2 and at pinned scale for about 20 KB, while a ladder
  // would triple the cache and re-encode the whole folder every time
  // someone taps a size chip.
  const THUMB_W = 384
  const thumbDir = path.resolve(__dirname, 'node_modules/.cache/vidbars-thumbs')

  // sharp is OPTIONAL and loaded through a NON-LITERAL specifier on
  // purpose: a literal import('sharp') makes `tsc -b` red on any machine
  // that does not have the 19 MB native binary — which is precisely the
  // machine the fallback exists for. Absent sharp the pool still lists,
  // scrolls, drags and drops; it just shows originals and glyphs.
  let sharpMod: { (input: string | Buffer): any; concurrency(n: number): void } | null = null
  let sharpInit: Promise<void> | null = null
  function initSharp(): Promise<void> {
    if (!sharpInit) sharpInit = (async () => {
      try {
        const spec = 'sharp'
        const m = await import(/* @vite-ignore */ spec)
        const s = (m.default ?? m) as typeof sharpMod
        // libvips defaults to one worker thread per core. On a 32-core box
        // that starves Vite's own transform/HMR path, which the user reads
        // as a slow editor — a worse failure than a slow thumbnail.
        s?.concurrency(1)
        sharpMod = s
      } catch { sharpMod = null }
    })()
    return sharpInit
  }

  function thumbKey(abs: string, mtimeMs: number, size: number, w: number): string {
    return crypto.createHash('sha1')
      .update(`${abs}|${Math.round(mtimeMs)}|${size}|${w}`)
      .digest('hex')
  }

  // The cache directory is indexed once and kept in memory, so deciding
  // whether a listing of 2000 files already has thumbnails costs one
  // readdir per server lifetime rather than 2000 existsSync calls per
  // browse.
  let thumbIndex: Set<string> | null = null
  function index(): Set<string> {
    if (!thumbIndex) {
      try { fs.mkdirSync(thumbDir, { recursive: true }) } catch { /* ignore */ }
      try { thumbIndex = new Set(fs.readdirSync(thumbDir)) } catch { thumbIndex = new Set() }
    }
    return thumbIndex
  }

  /** Cached file for a key, or null. `.jpg` is a sharp encode, `.png` a
   *  model poster the browser rendered once and handed back verbatim. */
  function cachedThumb(key: string): string | null {
    const idx = index()
    for (const ext of ['.jpg', '.png']) {
      if (!idx.has(key + ext)) continue
      const p = path.join(thumbDir, key + ext)
      if (fs.existsSync(p)) return p
      idx.delete(key + ext)   // deleted underneath us
    }
    return null
  }

  /** tmp + rename so a half-written file is never served. Rename failure is
   *  routine on Windows (Defender, another handle) and must NOT be fatal —
   *  the caller still has the bytes and still answers the request. */
  function writeThumb(key: string, ext: string, buf: Buffer): void {
    const tmp = path.join(thumbDir, `${key}.${process.pid}.tmp`)
    try {
      fs.mkdirSync(thumbDir, { recursive: true })
      fs.writeFileSync(tmp, buf)
      fs.renameSync(tmp, path.join(thumbDir, key + ext))
      index().add(key + ext)
    } catch {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    }
  }

  // A file that cannot be read right now is not a file that can never be
  // read: /api/upload streams into public/uploads, so EBUSY/EPERM means
  // "mid-write", and a permanent marker would blank that tile for the rest
  // of the session. Everything else gets a longer, still-temporary marker.
  const negative = new Map<string, number>()
  const NEG_BUSY_MS = 60_000
  const NEG_FAIL_MS = 10 * 60_000

  // De-dupe concurrent generation of the same key, and cap how many encodes
  // run at once regardless of how many tiles scroll into view.
  const jobs = new Map<string, Promise<Buffer | null>>()
  const MAX_JOBS = 8
  let jobsRunning = 0
  const jobWaiters: (() => void)[] = []
  async function acquire(): Promise<void> {
    if (jobsRunning >= MAX_JOBS) await new Promise<void>(r => jobWaiters.push(r))
    jobsRunning++
  }
  function release(): void {
    jobsRunning--
    const next = jobWaiters.shift()
    if (next) next()
  }

  function encodeThumb(abs: string, key: string): Promise<Buffer | null> {
    let job = jobs.get(key)
    if (job) return job
    job = (async () => {
      await acquire()
      try {
        const s = sharpMod
        if (!s) return null
        const buf: Buffer = await s(abs)
          .rotate()                                    // honour EXIF orientation
          .resize({ width: THUMB_W, withoutEnlargement: true })
          .jpeg({ quality: 72, mozjpeg: true })
          .toBuffer()
        writeThumb(key, '.jpg', buf)
        return buf
      } catch (err) {
        const code = (err as { code?: string } | null)?.code
        const busy = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
        negative.set(key, Date.now() + (busy ? NEG_BUSY_MS : NEG_FAIL_MS))
        return null
      } finally {
        release()
      }
    })().finally(() => { jobs.delete(key) })
    jobs.set(key, job)
    return job
  }

  /** A listing url back to a path on disk, for POSTed model posters. */
  function absFromUrl(u: string): string | null {
    if (!u.startsWith('/')) return null
    if (u.startsWith('/api/file')) {
      const p = new URL(u, 'http://x').searchParams.get('path')
      return p && path.isAbsolute(p) ? p : null
    }
    try {
      const rel = u.split('?')[0].slice(1).split('/').map(decodeURIComponent).join(path.sep)
      return path.resolve(publicDir, rel)
    } catch { return null }
  }

  return {
    name: 'browse-api',
    configureServer(server) {
      // Settles long before the app's first listing request.
      void initSharp()

      server.middlewares.use('/api/browse', (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        const url = new URL(req.url ?? '', 'http://x')
        const raw = url.searchParams.get('dir') || 'public/uploads'
        const dir = path.isAbsolute(raw) ? raw : path.resolve(__dirname, raw)
        try {
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            res.statusCode = 404
            res.end(JSON.stringify({ error: 'Not a directory', dir }))
            return
          }
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          const files = entries
            .filter(e => e.isFile() && MEDIA.test(e.name))
            .slice(0, 2000)
            .map(e => {
              const full = path.join(dir, e.name)
              const rel = path.relative(publicDir, full)
              // Inside public/ → the dev server already serves it directly.
              const servable = !rel.startsWith('..') && !path.isAbsolute(rel)
              let size = 0
              let mtimeMs = 0
              // One stat, both facts — mtime is what makes a thumbnail
              // cache key self-invalidating when the file is replaced.
              try { const st = fs.statSync(full); size = st.size; mtimeMs = st.mtimeMs } catch { /* ignore */ }
              const kind = kindOf(e.name)

              // A real folder on a real disk contains `shot #2.png`, and an
              // unencoded '#' truncates the url at the fragment — the tile
              // silently 404s. So encode per SEGMENT (separators survive,
              // spaces and unicode round-trip).
              //
              // That is still not enough for the reserved set. Vite's static
              // middleware decodes with decodeURI, which by definition
              // leaves `;/?:@&=+$,#` escaped, so a file called `a&b.png`
              // arrives as a lookup for the literal name `a%26b.png` and
              // falls through to index.html — measured, not assumed. Those
              // names go through /api/file instead, where the name is a
              // query parameter and comes back exactly as it went in.
              const encodable = !/[;/?:@&=+$,#]/.test(rel)
              const url = servable && encodable
                ? '/' + rel.split(path.sep).map(encodeURIComponent).join('/')
                : `/api/file?path=${encodeURIComponent(full)}`

              // The client is told a thumbnail URL, never how one is keyed:
              // `v` is only there so the browser cache turns over when the
              // file changes. A thumb is offered when the bytes already
              // exist on disk (any kind, including model posters the
              // browser handed back), or when sharp can make one on demand.
              const key = thumbKey(full, mtimeMs, size, THUMB_W)
              const canMake = !!sharpMod && kind === 'image'
              const thumb = (canMake || cachedThumb(key))
                ? `/api/thumb?path=${encodeURIComponent(full)}&v=${Math.round(mtimeMs)}-${size}&w=${THUMB_W}`
                : null

              return { name: e.name, kind, size, mtimeMs, url, thumb }
            })
          const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
          res.end(JSON.stringify({
            dir, parent: path.dirname(dir), dirs, files,
            caps: { thumbs: !!sharpMod },
          }))
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // Stream a single file from anywhere on disk (see above).
      server.middlewares.use('/api/file', (req, res) => {
        const url = new URL(req.url ?? '', 'http://x')
        const p = url.searchParams.get('path')
        if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
          res.statusCode = 404
          res.end('not found')
          return
        }
        const ext = path.extname(p).toLowerCase()
        const types: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
          '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
          '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
          '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
          '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
        }
        res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'public, max-age=3600')
        fs.createReadStream(p).pipe(res)
      })

      // GET  /api/thumb?path=…&v=…&w=384 — a small copy of one file.
      // POST /api/thumb {url|path, dataUrl} — file a poster the browser
      //      rendered, so the next session never loads that model again.
      //
      // PULL-BASED, always: a thumbnail exists because a browser asked for
      // that exact URL. Nothing here walks a directory or pre-warms one.
      // Eagerly touching every file in a folder is the exact bug class that
      // made the pool unusable, and it does not become acceptable just
      // because it moved to the server.
      server.middlewares.use('/api/thumb', (req, res) => {
        if (req.method === 'POST') {
          let body = ''
          let bytes = 0
          let dead = false
          req.on('data', (c: Buffer) => {
            if (dead) return
            bytes += c.length
            if (bytes > 8 * 1024 * 1024) {
              dead = true
              res.statusCode = 413
              res.end('{}')
              req.destroy()
              return
            }
            body += c.toString('utf-8')
          })
          req.on('end', () => {
            if (dead) return
            res.setHeader('Content-Type', 'application/json')
            void (async () => {
              try {
                const data = JSON.parse(body) as { url?: string; path?: string; dataUrl?: string }
                const abs = data.path && path.isAbsolute(data.path)
                  ? data.path
                  : absFromUrl(data.url ?? '')
                const dataUrl = data.dataUrl ?? ''
                if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile() ||
                    !dataUrl.startsWith('data:image/')) {
                  res.statusCode = 400
                  res.end(JSON.stringify({ error: 'bad request' }))
                  return
                }
                const st = fs.statSync(abs)
                const key = thumbKey(abs, st.mtimeMs, st.size, THUMB_W)
                if (cachedThumb(key)) { res.end(JSON.stringify({ ok: true, cached: true })); return }

                const raw = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
                if (sharpMod) {
                  // Transcoding is worth it (a 512×384 poster PNG is ~200 KB
                  // against ~20 KB of JPEG) but is never required: without
                  // sharp the poster is filed verbatim and serves fine.
                  await acquire()
                  try {
                    const buf: Buffer = await sharpMod(raw)
                      .resize({ width: THUMB_W, withoutEnlargement: true })
                      .jpeg({ quality: 72, mozjpeg: true })
                      .toBuffer()
                    writeThumb(key, '.jpg', buf)
                  } catch {
                    writeThumb(key, '.png', raw)
                  } finally {
                    release()
                  }
                } else {
                  writeThumb(key, '.png', raw)
                }
                res.end(JSON.stringify({ ok: true }))
              } catch {
                res.statusCode = 400
                res.end(JSON.stringify({ error: 'bad request' }))
              }
            })()
          })
          return
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405
          res.end('method not allowed')
          return
        }

        const p = new URL(req.url ?? '', 'http://x').searchParams.get('path')
        if (!p || !path.isAbsolute(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
          res.statusCode = 404
          res.end('not found')
          return
        }
        // `w` rides along in the url for legibility and cache-busting, but
        // the server pins the width: one width means one cache entry per
        // file, and flipping a size chip never triggers a re-encode pass.
        const st = fs.statSync(p)
        const key = thumbKey(p, st.mtimeMs, st.size, THUMB_W)

        const hit = cachedThumb(key)
        if (hit) {
          // The key contains mtime and size, so a hit can never be stale —
          // a changed file is a different url.
          res.setHeader('Content-Type', hit.endsWith('.png') ? 'image/png' : 'image/jpeg')
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          fs.createReadStream(hit).pipe(res)
          return
        }

        const until = negative.get(key)
        if (until && Date.now() < until) { res.statusCode = 404; res.end('no thumb'); return }
        if (until) negative.delete(key)

        // Only stills can be encoded here. Models and video have no
        // server-side path — a model's thumbnail arrives by POST, from the
        // one place that can actually draw it.
        if (!sharpMod || !IMAGE.test(p)) { res.statusCode = 404; res.end('no thumb'); return }

        void encodeThumb(p, key).then(buf => {
          if (!buf) {
            // 404 rather than an error page: the client's onError falls
            // back to the original file, so a failure costs a tile its
            // small copy, never its picture.
            res.statusCode = 404
            res.end('no thumb')
            return
          }
          res.setHeader('Content-Type', 'image/jpeg')
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          res.end(buf)
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), fileUploadApi(), userTemplatesApi(), snapshotsApi(), browseApi()],
})
