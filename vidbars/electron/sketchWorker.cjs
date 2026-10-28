// sketchWorker.cjs — runs sketchLook's depth, matte and line tools for VidBars.
//
// The tools live in the fcx24Poktnife checkout and run on its .audio-venv
// (torch + CUDA). They are never edited or copied: sketch_server.py
// executes them as they are, inside a cache folder per picture, so nothing
// is written into that checkout. It is ONE long-running process: models
// load on first use and stay loaded, and a picture's depth map, mattes and
// line layers are kept on disk by the picture's bytes, so asking again
// costs nothing.
//
// One job at a time: they share the one GPU.
//
//   node electron/sketchWorker.cjs depth pic.png [more frames...]
//   node electron/sketchWorker.cjs segment pic.png "hat=hat,cap" "dog=dog"
//   node electron/sketchWorker.cjs lines pic.png [person=person] [contour_w=5]

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const { spawn } = require('child_process')

const POKT = process.env.VIDBARS_SKETCHLOOK || 'D:\\Data\\AI\\ClaudeCode\\fcx24Poktnife'
const PYTHON = path.join(POKT, '.audio-venv', 'Scripts', 'python.exe')
const SKETCH = path.join(POKT, 'sketchLook')
const SERVER = path.join(__dirname, 'sketch_server.py')
const HOME = path.join(os.tmpdir(), 'vidbars-sketch')
const OPS = new Set(['depth', 'segment', 'lines'])

/** Whether this machine can run the tools at all. */
function available() {
  return fs.existsSync(PYTHON) && ['tools/depth.py', 'tools/matte_auto.py', 'tools_scale/look_hybrid_colerase.py']
    .every(f => fs.existsSync(path.join(SKETCH, f)))
}

const toDataUrl = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64')

let proc = null
let ready = null
let nextId = 1
const waiting = new Map()
let queue = Promise.resolve()
let stderrTail = ''

function start() {
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    proc = spawn(PYTHON, ['-u', SERVER, SKETCH, path.join(HOME, 'cache')], {
      cwd: HOME, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1' },
    })
    stderrTail = ''
    proc.stderr.on('data', d => { stderrTail = (stderrTail + d).slice(-4000) })
    readline.createInterface({ input: proc.stdout }).on('line', line => {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      if (msg.ready) { resolve(); return }
      const w = waiting.get(msg.id)
      if (w) { waiting.delete(msg.id); w(msg) }
    })
    const down = why => {
      proc = null
      ready = null
      reject(new Error(why))
      for (const w of waiting.values()) w({ error: why, log: stderrTail })
      waiting.clear()
    }
    proc.on('error', err => down(String(err.message || err)))
    proc.on('exit', code => down(`the sketch worker stopped (exit ${code})`))
  })
  return ready
}

/** Frames as files under one folder named by their bytes: (hash, paths). */
function frameFiles(frames) {
  const bufs = frames.map(f => {
    const m = /^data:image\/[\w+]+;base64,(.*)$/s.exec(f)
    return m ? Buffer.from(m[1], 'base64') : fs.readFileSync(f)
  })
  const h = crypto.createHash('sha1')
  for (const b of bufs) h.update(crypto.createHash('sha1').update(b).digest())
  const hash = h.digest('hex').slice(0, 20)
  const dir = path.join(HOME, 'in', hash)
  fs.mkdirSync(dir, { recursive: true })
  const paths = bufs.map((b, i) => {
    const f = path.join(dir, `${String(i).padStart(4, '0')}.img`)
    if (!fs.existsSync(f)) fs.writeFileSync(f, b)
    return f
  })
  return { hash, paths }
}

/**
 * job: { op: 'depth' | 'segment' | 'lines', frames: (dataUrl | path)[],
 *        objects?: { [name]: string[] }  — segment / lines: what to find,
 *        side?: number                   — lines: long edge it is drawn at,
 *        dials?: { [dial]: number }      — lines: look_hybrid_colerase dials }
 * Resolves, with `log` (the tools' output) and `seconds`:
 *   depth   { frames: dataUrl[] }  nearer = brighter
 *   segment { objects: { name: dataUrl[] } }  white = the thing, plus
 *           'figure' (all of them); {} when nothing was found
 *   lines   { frames: [{ outline, inside, paper, pencil }: dataUrl], colors }
 *   or { error }.
 */
function run(job) {
  const p = queue.then(() => runNow(job))
  queue = p.catch(() => {})
  return p
}

async function runNow({ op, frames, objects, side, dials }) {
  if (!available()) return { error: `sketchLook tools not found at ${POKT}`, log: '' }
  if (!OPS.has(op)) return { error: `unknown op ${op}`, log: '' }
  if (!frames?.length) return { error: 'no frames', log: '' }
  try {
    fs.mkdirSync(HOME, { recursive: true })
    const { hash, paths } = frameFiles(frames)
    await start()
    const id = nextId++
    const reply = await new Promise(resolve => {
      waiting.set(id, resolve)
      proc.stdin.write(JSON.stringify({ id, op, src: hash, frames: paths, objects, side, dials }) + '\n')
    })
    if (reply.error) return { error: reply.error, log: reply.log || '' }
    const out = { log: reply.log || '', seconds: reply.seconds }
    if (op === 'depth') out.frames = reply.frames.map(toDataUrl)
    if (op === 'segment') out.objects = Object.fromEntries(Object.entries(reply.objects).map(([n, fs_]) => [n, fs_.map(toDataUrl)]))
    if (op === 'lines') {
      out.frames = reply.frames.map(f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, toDataUrl(v)])))
      out.colors = reply.colors
    }
    return out
  } catch (err) {
    return { error: String(err.message || err), log: stderrTail }
  }
}

function stop() {
  if (proc) { proc.removeAllListeners('exit'); proc.kill(); proc = null; ready = null }
}

module.exports = { run, available, stop }

if (require.main === module) {
  const [op, ...rest] = process.argv.slice(2)
  const frames = rest.filter(a => !a.includes('='))
  const kv = rest.filter(a => a.includes('=')).map(a => a.split('='))
  const dials = Object.fromEntries(kv.filter(([, v]) => !isNaN(Number(v))).map(([k, v]) => [k, Number(v)]))
  const objects = Object.fromEntries(kv.filter(([, v]) => isNaN(Number(v))).map(([n, ps]) => [n, ps.split(',')]))
  const outDir = process.env.SKETCH_OUT || process.cwd()
  const save = (name, url) => { const f = path.join(outDir, name); fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); console.log('wrote', f) }
  const once = async () => {
    const t0 = Date.now()
    const r = await run({ op, frames: frames.map(f => path.resolve(f)), objects, dials, side: 1400 })
    if (r.error) console.error('ERROR', r.error, r.log)
    console.log(`${op}: ${((Date.now() - t0) / 1000).toFixed(1)} s (worker ${r.seconds} s)`)
    return r
  }
  ;(async () => {
    const r = await once()
    r.frames?.forEach((u, i) => typeof u === 'string' ? save(`${op}_${i}.png`, u) : Object.entries(u).forEach(([k, v]) => save(`${op}_${i}_${k}.png`, v)))
    for (const [n, us] of Object.entries(r.objects || {})) us.forEach((u, i) => save(`mask_${n}_${i}.png`, u))
    if (r.colors) console.log(r.colors)
    await once()  // again: should come from the cache
    stop()
  })()
}
