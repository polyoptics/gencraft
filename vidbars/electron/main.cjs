// main.cjs — the desktop shell.
//
// A window around the SAME app the browser runs, pointed at the Vite dev
// server. Nothing about the app is rebuilt for desktop: the dev server keeps
// serving /api/browse, /api/file, snapshots and uploads, and HMR still works.
// What the desktop adds is a narrow bridge (preload.cjs) for the handful of
// things a web page is never allowed to do: know a dropped file's real path,
// reveal it in Explorer, put that path on the clipboard, open it, and start a
// real OS file drag out to another app or a website's upload box.
//
// CommonJS (.cjs) on purpose: the package is `"type": "module"`, and these
// two files are loaded by Electron directly, not by Vite or `tsc -b`.

const { app, BrowserWindow, ipcMain, shell, clipboard, nativeImage, session } = require('electron')
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')

const PORT = Number(process.env.VIDBARS_PORT || 5173)
const DEV_URL = process.env.VIDBARS_URL || `http://localhost:${PORT}`
const DEV_ORIGIN = new URL(DEV_URL).origin
const APP_DIR = path.resolve(__dirname, '..')
const PUBLIC_DIR = path.join(APP_DIR, 'public')
const SELFTEST = process.env.VIDBARS_SELFTEST === '1'

// Before `ready`, so userData is %APPDATA%/VidBars rather than
// %APPDATA%/Electron — the canvas's IndexedDB lives there.
app.setName('VidBars')
// A separate profile for automated tests, so they never open (or lock) the
// real canvas's IndexedDB.
if (process.env.VIDBARS_USER_DATA) app.setPath('userData', path.resolve(process.env.VIDBARS_USER_DATA))
if (process.env.VIDBARS_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.VIDBARS_DEBUG_PORT)

// Same list as isServableDiskPath() in src/utils/diskUrl.ts — keep in step.
// It bounds what a reference may point at, and what "Open" will launch.
const MEDIA_FILE = /\.(png|jpe?g|jfif|webp|gif|avif|bmp|svg|ico|tiff?|heic|jxl|mp4|webm|mov|m4v|mkv|ogv|mp3|wav|ogg|oga|opus|m4a|aac|flac|glb|gltf|fbx|obj|bin|ktx2|tga|hdr|exr|dds)$/i

// ── Dev server ──────────────────────────────────────────────────────────
//
// Reuse one if it is already up (the preview, a terminal), otherwise start
// our own and stop it on quit. `--strictPort` because the window is pointed
// at a fixed URL: a server that quietly moved to 5174 would leave it blank.

let devServer = null

function probe(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      res.resume()
      resolve({ status: res.statusCode, type: String(res.headers['content-type'] || '') })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(1500, () => { req.destroy(); resolve(null) })
  })
}

/** Up, and actually VidBars — not some other tool that took the port. */
async function isVidbarsUp() {
  const r = await probe(`${DEV_URL}/api/ping`)
  if (!r) return false
  if (r.status === 200 && r.type.includes('application/json')) return true
  throw new Error(`Something other than VidBars is answering on ${DEV_URL}`)
}

async function ensureDevServer() {
  if (await isVidbarsUp()) return
  if (process.env.VIDBARS_URL) throw new Error(`Nothing is serving ${DEV_URL}`)
  console.log(`[vidbars] starting dev server on ${PORT}`)
  devServer = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    cwd: APP_DIR, shell: true, stdio: 'inherit',
  })
  devServer.on('exit', code => { devServer = null; if (code) console.log(`[vidbars] dev server exited ${code}`) })
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    if (await isVidbarsUp()) return
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`Dev server did not come up on ${DEV_URL}`)
}

function stopDevServer() {
  if (!devServer) return
  devServer.removeAllListeners('exit')   // our own kill is not a crash
  // `shell: true` puts npm under cmd.exe on Windows; killing the shell
  // leaves vite orphaned holding the port. Take the whole tree down — and
  // synchronously: Electron exits right after will-quit, before an async
  // taskkill would even have been launched.
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(devServer.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
  }
  else devServer.kill()
  devServer = null
}

// ── Paths ───────────────────────────────────────────────────────────────

/** \\host\share and //host/share. Merely touching one makes Windows
 *  authenticate to that host, and stored values can come from an imported
 *  project — so they are refused everywhere, before any fs call. */
function isUnc(p) {
  return /^[\\/]{2}/.test(p)
}

/** A raw dev-server endpoint rather than an app page. Case-insensitive,
 *  because the server's routing is: /API/file reaches the /api/file handler. */
function isApiRoute(pathname) {
  const lp = pathname.toLowerCase()
  return lp === '/api' || lp.startsWith('/api/') || lp.startsWith('/api.')
}

/** An absolute local path that exists, as its CANONICAL long name, or null.
 *  Every handler goes through this, so a stale or relative value fails
 *  quietly instead of resolving against the app's working directory — and
 *  the media allowlist is checked against the file that is really there,
 *  not an 8.3 short name (NOTES~1.PNG for notes.pngx) or a symlink. */
function realPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || isUnc(p)) return null
  try { return fs.realpathSync.native(p) } catch { return null }
}

function isFile(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

/** The file on disk behind a STORED media value, or null when it has none.
 *    /api/file?path=…, /api/thumb?path=…  → that path
 *    /uploads/x.png and any other public url → <vidbars>/public/…
 *    mediaref:, data:, blob:, http(s):    → null (the bytes live elsewhere)
 *  Only main knows where public/ is, which is why this lives here. */
function mediaPath(u) {
  if (typeof u !== 'string' || !u.startsWith('/') || u.startsWith('//')) return null
  let parsed
  try { parsed = new URL(u, 'http://x') } catch { return null }
  const route = parsed.pathname.toLowerCase()
  if (route === '/api/file' || route === '/api/thumb') {
    const p = parsed.searchParams.get('path')
    return p && path.isAbsolute(p) && !isUnc(p) ? path.normalize(p) : null
  }
  if (isApiRoute(parsed.pathname)) return null
  let parts
  try { parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent) } catch { return null }
  if (parts.length === 0) return null
  const abs = path.resolve(PUBLIC_DIR, ...parts)
  // A decoded %2F or .. must not walk out of public/.
  return abs.startsWith(PUBLIC_DIR + path.sep) ? abs : null
}

function canonical(p) {
  try { return fs.realpathSync.native(p) } catch { return path.resolve(p) }
}

/** Where a drag-out copy of something the app rendered is written — an
 *  effect result, prepared on hover so the drag itself has nothing to wait
 *  for. The app's own folder, not Pictures: these are not the user's
 *  saves. Held to a budget, not emptied (pruneDragCache). */
function dragCacheDir() {
  return path.join(app.getPath('userData'), 'Drag Cache')
}

// The Drag Cache's budget. A dropped copy can stay in use long after the
// drop — an editor (Resolve, Premiere, After Effects) links media IN PLACE,
// and an Alt-drop makes a shortcut to it — so a copy is never deleted the
// moment it is made, nor all at once at startup. Instead: at startup, the
// ones older than MAX_AGE; after each new one, the oldest past MAX_FILES or
// MAX_BYTES. A long tweak-and-hover session writes a 4096-px JPEG per
// setting, so without a running cap the folder grows by GBs.
const DRAG_CACHE_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000
const DRAG_CACHE_MAX_FILES = 100
const DRAG_CACHE_MAX_BYTES = 400 * 1024 * 1024
/** Never pruned, whatever their size: the newest files, which the page may
 *  still hand to a drag. At least FxResultLayer's in-memory cap (32) —
 *  it forgets the oldest first, in the order these were written. */
const DRAG_CACHE_KEEP_NEWEST = 48

/** Prune the Drag Cache to its budget, oldest first; with `maxAgeMs`, also
 *  everything older than that. Best effort and never throws: a file another
 *  program holds open just stays until next time. */
async function pruneDragCache(maxAgeMs = Infinity) {
  try {
    const dir = dragCacheDir()
    let names
    try { names = await fs.promises.readdir(dir) } catch { return }   // none made yet
    const files = (await Promise.all(names.map(async n => {
      const p = path.join(dir, n)
      try {
        const s = await fs.promises.stat(p)
        return s.isFile() ? { p, t: s.mtimeMs, size: s.size } : null
      } catch { return null }
    }))).filter(Boolean).sort((a, b) => b.t - a.t)   // newest first
    const now = Date.now()
    let bytes = 0
    for (let i = 0; i < files.length; i++) {
      bytes += files[i].size
      const overBudget = i >= DRAG_CACHE_KEEP_NEWEST && (i >= DRAG_CACHE_MAX_FILES || bytes > DRAG_CACHE_MAX_BYTES)
      if (overBudget || now - files[i].t > maxAgeMs) await fs.promises.unlink(files[i].p).catch(() => {})
    }
  } catch (err) {
    console.warn('[vidbars] drag cache not pruned:', err.message)
  }
}

/** Safe to reference IN PLACE rather than copy: a media file that exists
 *  and is not under the temp folder. A drag out of a zip or an email lands
 *  in %TEMP% and is deleted afterwards, so those must still be copied —
 *  and so must the Drag Cache: dragged back in (from Explorer, or after
 *  the page's own-drag guard has lapsed), a reference would break when
 *  the cache is pruned (pruneDragCache). */
function isStableMediaFile(p) {
  const abs = realPath(p)
  if (!abs || !MEDIA_FILE.test(abs) || !isFile(abs)) return false
  const at = canonical(abs).toLowerCase()
  return ![app.getPath('temp'), dragCacheDir()]
    .some(dir => at.startsWith(canonical(dir).toLowerCase() + path.sep))
}

// ── Bridge ──────────────────────────────────────────────────────────────

/** Only the app itself may drive the bridge: the top-level page on the dev
 *  server's origin. Not an iframe, not a page a link navigated to, and not
 *  a file /api/file served as a document. */
function fromApp(event) {
  try {
    if (event.senderFrame !== event.sender.mainFrame) return false
    const u = new URL(event.senderFrame.url)
    return u.origin === DEV_ORIGIN && !isApiRoute(u.pathname)
  } catch { return false }
}

/** Stored media values → the files an OS drag may carry: media files that
 *  exist, by their real names, de-duplicated, at most 64. Shared by the
 *  drag handler and the self-test. */
function dragFilesFor(urls) {
  const out = []
  // Bounded twice: the work (stored values that resolve to nothing still
  // cost a lookup) and the result (what the OS is handed).
  for (const u of (Array.isArray(urls) ? urls : [urls]).slice(0, 256)) {
    if (out.length >= 64) break
    const p = realPath(mediaPath(u))
    if (p && MEDIA_FILE.test(p) && isFile(p) && !out.includes(p)) out.push(p)
  }
  return out
}

// The drag image. startDrag needs it synchronously, during the dragstart,
// so the file's own thumbnail is prepared ahead — on hover — and kept here;
// a drag that beats it gets the neutral tile below.
//
// createThumbnailFromPath runs the shell's extractor INLINE on this thread
// (the await does not move it), so: only kinds Windows has a thumbnailer
// for, and a failure is remembered (null) rather than retried every hover.
const THUMBABLE = /\.(png|jpe?g|jfif|webp|gif|bmp|tiff?|heic|avif|mp4|m4v|mov|mkv|webm)$/i
const dragIcons = new Map()   // path → NativeImage, or null when it has none
async function prepareDragIcon(p) {
  if (dragIcons.has(p)) return !!dragIcons.get(p)
  let img = null
  if (THUMBABLE.test(p)) {
    try {
      const t = await nativeImage.createThumbnailFromPath(p, { width: 96, height: 96 })
      if (!t.isEmpty()) img = t
    } catch { /* no thumbnail for this file */ }
  }
  dragIcons.set(p, img)
  if (dragIcons.size > 64) dragIcons.delete(dragIcons.keys().next().value)
  return !!img
}

// The fallback drag image: a small neutral tile, built once.
let dragIcon = null
function getDragIcon() {
  if (dragIcon) return dragIcon
  const S = 32
  const buf = Buffer.alloc(S * S * 4)
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4
    const edge = x < 2 || y < 2 || x >= S - 2 || y >= S - 2
    buf[i] = edge ? 0xff : 0xd9      // B
    buf[i + 1] = edge ? 0xff : 0x8d  // G
    buf[i + 2] = edge ? 0xff : 0x5b  // R
    buf[i + 3] = 0xff                // A
  }
  dragIcon = nativeImage.createFromBitmap(buf, { width: S, height: S })
  return dragIcon
}

function registerBridge() {
  ipcMain.handle('vb:reveal', (e, p) => {
    const abs = fromApp(e) && realPath(p)
    if (!abs) return false
    shell.showItemInFolder(abs)
    return true
  })

  // Media only. shell.openPath runs whatever it is given — an .exe, a .bat,
  // a .lnk — so an unrestricted Open would turn any script on the page into
  // code execution.
  ipcMain.handle('vb:open', async (e, p) => {
    const abs = fromApp(e) && realPath(p)
    if (!abs) return 'Not found'
    if (!MEDIA_FILE.test(abs)) return 'Not a media file'
    return shell.openPath(abs)   // '' on success, an error message otherwise
  })

  ipcMain.handle('vb:copy-path', (e, p) => {
    if (!fromApp(e) || typeof p !== 'string' || !path.isAbsolute(p) || isUnc(p)) return false
    clipboard.writeText(path.normalize(p))
    return true
  })

  ipcMain.handle('vb:exists', (e, p) => fromApp(e) && !!realPath(p))

  ipcMain.handle('vb:resolve-media', (e, u) => {
    if (!fromApp(e)) return null
    const p = mediaPath(u)
    return p ? { path: p, exists: !!realPath(p) } : null
  })

  ipcMain.handle('vb:stable-path', (e, p) => fromApp(e) && isStableMediaFile(p))

  // Depth / Segment cards: sketchLook's depth and matte tools on this GPU.
  // Frames come as data urls only — the page never names a file to read.
  ipcMain.handle('vb:sketch-run', async (e, job) => {
    if (!fromApp(e)) return { error: 'Not allowed', log: '' }
    const frames = Array.isArray(job?.frames) ? job.frames.filter(f => typeof f === 'string' && f.startsWith('data:image/')) : []
    if (!frames.length || frames.length > 600) return { error: 'no pictures', log: '' }
    const objects = {}
    for (const [k, v] of Object.entries(job.objects || {})) if (Array.isArray(v)) objects[String(k)] = v.map(String)
    return require('./sketchWorker.cjs').run({ op: job.op, frames, objects })
  })

  // An image the app MADE (a context sheet, an effect result), written as a
  // real file so it can be dragged out like any other:
  // Pictures\<folder for its kind>\<name> <stamp>.jpg. Never a path the page
  // chose — the kind picks from a fixed list, the name is sanitised to one
  // segment, and only a PNG/JPEG data url is accepted. Resolves { path } of
  // the file actually written, or { error }.
  // Kind 'drag' is the exception to Pictures: a drag-out copy, written to
  // the app's own Drag Cache (dragCacheDir), held to a budget (pruneDragCache).
  const SAVE_FOLDERS = { 'context-sheet': 'VidBars Context Sheets', 'effect': 'VidBars Effects' }
  // Win32 treats these stems as DEVICES — the part before the first dot,
  // trailing spaces ignored — so 'Con.Air poster <stamp>.jpg' would go to
  // the console and report success for a file that does not exist.
  const RESERVED_STEM = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i
  /** Pictures — unless it is redirected to a network share, where every
   *  reader (/api/file, Reveal, drag-out) refuses the file. Then a local
   *  folder under the app's own data. */
  function saveDir(kind) {
    if (kind === 'drag') {
      const dir = dragCacheDir()
      return isUnc(dir) ? null : dir
    }
    for (const base of [app.getPath('pictures'), path.join(app.getPath('userData'), 'Saved Images')]) {
      if (!isUnc(base)) return path.join(base, SAVE_FOLDERS[kind])
    }
    return null
  }
  ipcMain.handle('vb:save-image', async (e, kind, name, dataUrl) => {
    if (!fromApp(e) || typeof dataUrl !== 'string' || !(Object.hasOwn(SAVE_FOLDERS, kind) || kind === 'drag')) return { error: 'Not allowed' }
    const m = /^data:image\/(png|jpeg);base64,/.exec(dataUrl)
    if (!m) return { error: 'Not a PNG or JPEG image' }
    const dir = saveDir(kind)
    if (!dir) return { error: `${kind === 'drag' ? 'The app data folder' : 'Pictures'} is on a network share, which VidBars cannot read files back from` }
    // Cut by CODE POINTS, on a well-formed string: half an emoji is written
    // to disk as U+FFFD while the path handed back keeps the half — a name
    // that matches no file, and that encodeURIComponent throws on.
    let safe = Array.from(String(name || '').toWellFormed().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_'))
      .slice(0, 80).join('').replace(/^[.\s]+|[.\s]+$/g, '') || (kind === 'context-sheet' ? 'context sheet' : 'image')
    // (Without a dot the stem is '<safe> <stamp>', which is never reserved.)
    if (safe.includes('.') && RESERVED_STEM.test(safe.split('.')[0].trimEnd())) safe = '_' + safe
    const d = new Date()
    const pad = n => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const ext = m[1] === 'png' ? 'png' : 'jpg'
    const buf = Buffer.from(dataUrl.slice(m[0].length), 'base64')
    try {
      await fs.promises.mkdir(dir, { recursive: true })
      // Never over an earlier file: a strip saves one per source within the
      // same second, and their labels repeat ('Image'). 'wx' fails rather
      // than replace, so two saves racing for a name cannot both get it.
      for (let n = 1; n <= 99; n++) {
        const file = path.join(dir, `${safe} ${stamp}${n > 1 ? ` (${n})` : ''}.${ext}`)
        try {
          await fs.promises.writeFile(file, buf, { flag: 'wx' })
          // Not awaited: the page is waiting on this path, and the file
          // just written is the newest, which a prune never takes.
          if (kind === 'drag') void pruneDragCache()
          return { path: file }
        } catch (err) {
          if (err.code !== 'EEXIST') throw err
        }
      }
      return { error: 'Too many files of this name saved this second' }
    } catch (err) {
      console.error('[vidbars] image not saved:', err.message)
      return { error: err.message }
    }
  })

  ipcMain.handle('vb:prepare-drag', (e, u) => {
    if (!fromApp(e)) return false
    const [p] = dragFilesFor([u])
    return p ? prepareDragIcon(p) : false
  })

  // Drag OUT by stored url: main resolves the files itself, so the
  // renderer's dragstart has nothing to await. The preload only sends this
  // right after a trusted dragstart, while the button is still down — an
  // OS drag begun with the button up drops at once, wherever the cursor is.
  ipcMain.on('vb:start-drag-media', (e, urls) => {
    if (!fromApp(e)) return
    const files = dragFilesFor(urls)
    if (files.length === 0) { e.sender.send('vb:drag-out-done'); return }
    console.log(`[vidbars] drag out: ${files.length} file(s)`)
    // Automated tests: report the files, never hand them to the OS. A real
    // drag with no button held drops at once wherever the user's own mouse
    // happens to be — into their Explorer, or their real canvas.
    if (process.env.VIDBARS_DRAG_DRYRUN === '1') {
      console.log('[vidbars] drag out (dry run): ' + files.map(f => path.basename(f)).join(' | '))
      setTimeout(() => e.sender.send('vb:drag-out-done'), 1000)
      return
    }
    const icon = dragIcons.get(files[0]) ?? getDragIcon()
    try {
      e.sender.startDrag(files.length === 1 ? { file: files[0], icon } : { file: files[0], files, icon })
    } finally {
      // The OS drag has ended (startDrag returns when it does). The page
      // ignores drops while its own drag is out — see isDraggingOut.
      e.sender.send('vb:drag-out-done')
    }
  })
}

// ── Window ──────────────────────────────────────────────────────────────

/** The app's own pages: the dev origin, but never a raw /api/ response. */
function isAppPage(url) {
  try {
    const u = new URL(url)
    return u.origin === DEV_ORIGIN && !isApiRoute(u.pathname)
  } catch { return false }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: '#1e1e1e',
    show: false,
    autoHideMenuBar: true,
    title: 'VidBars',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => { if (!SELFTEST) win.show() })

  // A file dropped where the app does not handle the drop would otherwise
  // NAVIGATE the window to that file and throw the canvas away; a link to
  // /api/file would open a raw file as a page on the bridge's origin.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppPage(url)) e.preventDefault()
  })
  // The app has no iframes. A same-origin one could reach the bridge
  // through `top`, so none may load at all.
  win.webContents.on('will-frame-navigate', (e) => {
    try { if (!e.isMainFrame && new URL(e.url).origin === DEV_ORIGIN) e.preventDefault() } catch { /* not a url */ }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    let external = false
    try { external = /^https?:$/.test(new URL(url).protocol) && new URL(url).origin !== DEV_ORIGIN } catch { /* not a url */ }
    if (external) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (SELFTEST) win.webContents.once('did-finish-load', () => selfTest(win))

  win.loadURL(DEV_URL)
  return win
}

/** Electron grants every permission by default. The app uses none of the
 *  sensitive ones (camera, mic, location, notifications…), so deny them. */
function lockPermissions() {
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
}

/** VIDBARS_SELFTEST=1: load the app hidden, exercise the bridge from the
 *  page, print the result, quit. Proves the preload is wired without
 *  anyone having to look at a window. */
async function selfTest(win) {
  let result
  // The test copies a path; put the user's clipboard back afterwards.
  const prevClip = clipboard.readText()
  // A raster file for the drag-image check (no SVG thumbnailer is promised).
  const testPng = path.join(app.getPath('temp'), 'vb-selftest.png')
  try { fs.writeFileSync(testPng, getDragIcon().toPNG()) } catch { /* reported as false */ }
  try {
    const self = __filename
    const icon = path.join(PUBLIC_DIR, 'favicon.svg')
    result = await win.webContents.executeJavaScript(`(async () => {
      const d = window.vidbarsDesktop
      if (!d) return { bridge: false }
      const self = ${JSON.stringify(self)}
      const icon = ${JSON.stringify(icon)}
      const enc = s => encodeURIComponent(s)
      return {
        bridge: true,
        keys: Object.keys(d).sort(),
        platform: d.platform,
        existsSelf: await d.exists(self),
        existsMissing: await d.exists(self + '.nope'),
        rejectsRelative: await d.exists('main.cjs'),
        rejectsUnc: await d.exists('\\\\\\\\localhost\\\\c$\\\\x.png'),
        copied: await d.copyPath(self),
        resolveFile: await d.resolveMedia('/api/file?path=' + enc(icon)),
        resolvePublic: await d.resolveMedia('/favicon.svg'),
        resolveEscape: await d.resolveMedia('/a%2F..%2F..%2Fpackage.json'),
        resolveApiCase: await d.resolveMedia('/API/FILE?path=' + enc(icon)),
        resolveOtherApi: await d.resolveMedia('/api/browse?dir=' + enc(icon)),
        resolveMediaref: await d.resolveMedia('mediaref:abc'),
        resolveData: await d.resolveMedia('data:image/png;base64,AAAA'),
        stableIcon: await d.isStablePath(icon),
        prepareDrag: await d.prepareDragIcon('/api/file?path=' + enc(${JSON.stringify(path.join(app.getPath('temp'), 'vb-selftest.png'))})),
        prepareDragSvg: await d.prepareDragIcon('/favicon.svg'),
        untrustedDragIgnored: (() => { d.startMediaDrag([${JSON.stringify('/favicon.svg')}]); return d.isDraggingOut() === false })(),
        stableScript: await d.isStablePath(self),
        openScript: await d.openPath(self),
        nodeLeaked: typeof require !== 'undefined' || typeof process !== 'undefined',
        appMounted: !!document.querySelector('#root')?.childElementCount,
      }
    })()`)
    result.clipboard = clipboard.readText()
    // Drag-out resolution, without starting a real OS drag.
    result.dragFiles = dragFilesFor([
      '/api/file?path=' + encodeURIComponent(icon),   // a media file
      '/favicon.svg',                                 // the same file again: de-duplicated
      '/api/file?path=' + encodeURIComponent(self),   // not media: refused
      'mediaref:abc',                                 // no file on disk
    ]).map(p => path.basename(p))
  } catch (err) {
    result = { error: String(err) }
  }
  clipboard.writeText(prevClip)
  try { fs.unlinkSync(testPng) } catch { /* already gone */ }
  console.log('[vidbars] SELFTEST ' + JSON.stringify(result))
  app.quit()
}

app.whenReady().then(async () => {
  lockPermissions()
  registerBridge()
  // Old drag-out copies. Not the whole folder: a program that keeps
  // dropped files BY REFERENCE (an editor's media bin) still needs
  // yesterday's — two days is the grace; Save is what makes a lasting
  // file. (The budget applies too.) Not awaited: it never takes the newest
  // files, so nothing this session writes can race it.
  void pruneDragCache(DRAG_CACHE_MAX_AGE_MS)
  try {
    await ensureDevServer()
  } catch (err) {
    console.error('[vidbars]', err.message)
    stopDevServer()   // app.exit() skips will-quit
    app.exit(1)
    return
  }
  createWindow()
})

app.on('window-all-closed', () => app.quit())
app.on('will-quit', stopDevServer)
