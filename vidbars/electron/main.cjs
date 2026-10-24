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

/** Safe to reference IN PLACE rather than copy: a media file that exists
 *  and is not under the temp folder. A drag out of a zip or an email lands
 *  in %TEMP% and is deleted afterwards, so those must still be copied. */
function isStableMediaFile(p) {
  const abs = realPath(p)
  if (!abs || !MEDIA_FILE.test(abs) || !isFile(abs)) return false
  const tmp = canonical(app.getPath('temp')).toLowerCase() + path.sep
  return !canonical(abs).toLowerCase().startsWith(tmp)
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

// startDrag needs an icon synchronously, during the dragstart, so there is
// no time to fetch the file's own. A small neutral tile, built once.
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

  // `send`, not `handle`: the renderer's dragstart cannot await a reply,
  // and the OS drag has to begin while that event is still being handled.
  ipcMain.on('vb:start-drag', (e, paths) => {
    if (!fromApp(e)) return
    // Held to the same media-only line as Open and /api/file.
    const list = (Array.isArray(paths) ? paths : [paths]).slice(0, 64).map(realPath)
      .filter(p => p && MEDIA_FILE.test(p) && isFile(p))
    if (list.length === 0) return
    e.sender.startDrag(list.length === 1
      ? { file: list[0], icon: getDragIcon() }
      : { file: list[0], files: list, icon: getDragIcon() })
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
        stableScript: await d.isStablePath(self),
        openScript: await d.openPath(self),
        nodeLeaked: typeof require !== 'undefined' || typeof process !== 'undefined',
        appMounted: !!document.querySelector('#root')?.childElementCount,
      }
    })()`)
    result.clipboard = clipboard.readText()
  } catch (err) {
    result = { error: String(err) }
  }
  clipboard.writeText(prevClip)
  console.log('[vidbars] SELFTEST ' + JSON.stringify(result))
  app.quit()
}

app.whenReady().then(async () => {
  lockPermissions()
  registerBridge()
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
