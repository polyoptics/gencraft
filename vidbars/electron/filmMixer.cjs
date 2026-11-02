// filmMixer.cjs — runs the look mixer for the docked Film Look panel.
//
// The mixer lives in the fcx24Poktnife checkout and runs on its .audio-venv:
// a local server that renders the film's frames on the GPU, and its own page.
// It is never edited or copied. The panel shows that page, so the mixer in
// VidBars is the same mixer, on the same plan files, as mixer.cmd's.
//
// One mixer at a time: one started by hand on the port is used as it is, and
// left running when VidBars quits. One started here is asked to quit with
// VidBars, which frees the GPU. It is never killed: a film bake it started
// runs as its own process and keeps going.

const http = require('http')
const path = require('path')
const { spawn } = require('child_process')

const POKT = process.env.VIDBARS_SKETCHLOOK || 'D:\\Data\\AI\\ClaudeCode\\fcx24Poktnife'
const PYTHON = path.join(POKT, '.audio-venv', 'Scripts', 'python.exe')
const SKETCH = path.join(POKT, 'sketchLook')
const SCRIPT = path.join(SKETCH, 'tools_scale', 'mixer.py')
const PORT = Number(process.env.VIDBARS_MIXER_PORT || 8766)
// Automated tests: the mixer's --map, --looks, --prefs, --flags and --bake-dir,
// as a JSON list, so a test never touches the real plan.
const EXTRA_ARGS = process.env.VIDBARS_MIXER_ARGS ? JSON.parse(process.env.VIDBARS_MIXER_ARGS) : []
const URL_BASE = `http://localhost:${PORT}`
// Importing torch and reading the plan, on a cold disk.
const START_TIMEOUT_MS = 180_000

let proc = null
let starting = null
let tail = []

/** Up, and actually the mixer: /api/info answers JSON. */
function isUp() {
  return new Promise(resolve => {
    const req = http.get(`${URL_BASE}/api/info`, res => {
      res.resume()
      resolve(res.statusCode === 200 && String(res.headers['content-type'] || '').includes('json'))
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1500, () => { req.destroy(); resolve(false) })
  })
}

async function status() {
  return { running: await isUp(), starting: !!starting, url: URL_BASE }
}

function keepTail(chunk) {
  tail.push(...String(chunk).split(/\r?\n/).filter(Boolean))
  if (tail.length > 30) tail = tail.slice(-30)
}

async function runStart() {
  if (await isUp()) return { url: URL_BASE }
  tail = []
  let exited = null
  const child = spawn(PYTHON, ['-u', SCRIPT, '--no-browser', '--port', String(PORT), ...EXTRA_ARGS], {
    cwd: SKETCH, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc = child
  child.stdout.on('data', keepTail)
  child.stderr.on('data', keepTail)
  child.on('error', err => { exited = err.message; keepTail(err.message) })
  child.on('exit', code => { exited = `exited with code ${code}`; if (proc === child) proc = null })

  const until = Date.now() + START_TIMEOUT_MS
  while (Date.now() < until) {
    if (await isUp()) return { url: URL_BASE }
    if (exited) return { error: `The mixer ${exited}`, log: tail.join('\n') }
    await new Promise(r => setTimeout(r, 500))
  }
  return { error: 'The mixer did not come up in 3 minutes', log: tail.join('\n') }
}

/** Resolves { url } once the page can be shown, or { error, log }. */
function start() {
  if (!starting) starting = runStart().finally(() => { starting = null })
  return starting
}

/** True when VidBars started the mixer that is running now. */
function ownsRunning() {
  return !!proc
}

/** Ask a mixer started here to quit, the way its own Quit button does. */
function stop() {
  if (!proc) return Promise.resolve()
  return new Promise(resolve => {
    const req = http.request(`${URL_BASE}/api/quit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
    }, res => { res.resume(); res.on('end', resolve) })
    req.on('error', () => resolve())
    req.setTimeout(1500, () => { req.destroy(); resolve() })
    req.end('{}')
  })
}

// What the page is showing, read from inside it: the frame's origin keeps the
// app from reaching in itself. A fixed read, nothing from the app goes into it.
const VIEW_SCRIPT = `(() => {
  const e = S.pl[S.i]
  if (!e) return null
  const k = e.seg, s = F.segs[k], r = document.getElementById('cv').getBoundingClientRect()
  return {
    seg: k, i: e.i, clip: s.clip, overlay: !!s.overlay, cardOn: !!S.cardOn, playing: !!S.playing,
    picture: { x: r.x, y: r.y, width: r.width, height: r.height },
    look: s.look ? ((k === F.cur ? curLook() : segLook(k)) || zeroLook()) : null,
  }
})()`

/** The look layers read the current shot, frame and look from the mixer's own
 *  page, or null while it has none. */
async function view(mainFrame) {
  const page = pageFrame(mainFrame)
  if (!page) return null
  try { return await page.executeJavaScript(VIEW_SCRIPT) } catch { return null }
}

function pageFrame(mainFrame) {
  return mainFrame.framesInSubtree.find(f => {
    try { return new URL(f.url).origin === new URL(URL_BASE).origin } catch { return false }
  })
}

/** The page's own picture leaves it while the layers are open: it has gone to
 *  the back of the stack. */
async function showPicture(mainFrame, shown) {
  const page = pageFrame(mainFrame)
  if (!page) return
  const css = shown ? 'visible' : 'hidden'
  try { await page.executeJavaScript(`document.getElementById('cv').style.visibility = '${css}'`) } catch { /* page reloading */ }
}

/** One frame as a data url, so the page can read its pixels (it could not read
 *  an image from the mixer's origin). { loading: true } while the shot loads. */
function frame({ seg, i, look, card }) {
  if (!Number.isInteger(seg) || !Number.isInteger(i)) return Promise.resolve({ error: 'no such frame' })
  const q = `seg=${seg}&i=${i}&fmt=png&card=${card ? 1 : 0}` + (look ? `&look=${encodeURIComponent(JSON.stringify(look))}` : '')
  return new Promise(resolve => {
    const req = http.get(`${URL_BASE}/frame?${q}`, res => {
      const parts = []
      res.on('data', d => parts.push(d))
      res.on('end', () => {
        if (res.statusCode === 409) resolve({ loading: true })
        else if (res.statusCode !== 200) resolve({ error: `the mixer answered ${res.statusCode}` })
        else resolve({ url: 'data:image/png;base64,' + Buffer.concat(parts).toString('base64') })
      })
    })
    req.on('error', err => resolve({ error: err.message }))
    req.setTimeout(10_000, () => { req.destroy(); resolve({ error: 'the mixer took too long' }) })
  })
}

module.exports = { status, start, stop, ownsRunning, view, showPicture, frame }
