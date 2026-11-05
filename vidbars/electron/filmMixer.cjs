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

// The canvas fills the mixer from cards: these drive its own page. Fixed
// scripts; what the app sends is only shot names, checked and JSON-encoded.
const SHOT_NAME = /^[A-Za-z0-9_-]{1,40}$/
const PAGE_SCRIPTS = {
  // Every shot the mixer can mix, in film order.
  shots: () => `F.segs.map((s, k) => ({ k, clip: s.clip, look: !!s.look, n: s.n, outside: !!s.outside, start: s.start, end: s.end })).filter(s => s.look && !s.outside)`,
  // Hide the page's own whole-film strip: the canvas holds the shots now.
  embed: () => `(() => {
    if (!document.getElementById('vb-embed')) {
      const st = document.createElement('style')
      st.id = 'vb-embed'
      st.textContent = '#timeline, #ruler, #strip { display: none !important }'
      document.head.appendChild(st)
    }
    return true
  })()`,
  // These shots, selected, the first (or the one already on) current.
  use: (clips) => `(() => {
    const want = ${JSON.stringify(clips)}
    const ks = want.map(c => F.segs.findIndex(s => s.clip === c && s.look)).filter(k => k >= 0)
    if (!ks.length) return 0
    if (!ks.includes(F.cur)) jumpTo(ks[0])
    F.sel = new Set(ks)
    F.anchor = ks[0]
    selChanged()
    return ks.length
  })()`,
  // The film's length in frames, and where each mixable shot starts and ends in it.
  film: () => `({ frames: Math.max(0, ...F.segs.filter(s => !s.outside && typeof s.end === 'number').map(s => s.end)), shots: F.segs.filter(s => s.look && !s.outside && typeof s.start === 'number').map(s => ({ clip: s.clip, start: s.start, end: s.end })) })`,
  // The shots selected now.
  sel: () => `[...F.sel].map(k => F.segs[k] && F.segs[k].clip).filter(Boolean)`,
  // Go to one shot, keeping the selection.
  go: (clips) => `(() => {
    const k = F.segs.findIndex(s => s.clip === ${JSON.stringify(clips[0])} && s.look)
    if (k < 0 || k === F.cur) return false
    jumpTo(k, { keepSel: true })
    return true
  })()`,
}

async function call(mainFrame, op, clips) {
  const make = Object.hasOwn(PAGE_SCRIPTS, op) ? PAGE_SCRIPTS[op] : null
  const names = Array.isArray(clips) ? clips.filter(c => typeof c === 'string' && SHOT_NAME.test(c)).slice(0, 500) : []
  if (!make || ((op === 'use' || op === 'go') && !names.length)) return null
  const page = pageFrame(mainFrame)
  if (!page) return null
  try { return await page.executeJavaScript(make(names)) } catch { return null }
}

/** A shot's thumbnail as a data url (cards keep their media as data). */
function thumb(seg) {
  if (!Number.isInteger(seg) || seg < 0) return Promise.resolve(null)
  return new Promise(resolve => {
    const req = http.get(`${URL_BASE}/thumb?seg=${seg}`, res => {
      const parts = []
      res.on('data', d => parts.push(d))
      res.on('end', () => resolve(res.statusCode === 200 ? 'data:image/jpeg;base64,' + Buffer.concat(parts).toString('base64') : null))
    })
    req.on('error', () => resolve(null))
    req.setTimeout(10_000, () => { req.destroy(); resolve(null) })
  })
}

module.exports = { status, start, stop, ownsRunning, view, frame, call, thumb }
