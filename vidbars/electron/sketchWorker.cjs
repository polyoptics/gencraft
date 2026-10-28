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
//   (SKETCH_ENGINE=dino uses Grounding DINO + SAM2 instead of SAM 3)
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
// SAM 3 lives in its own venv (it needs a newer torch / transformers than
// the film's tools): a second worker, used for finding things when present.
const SAM3_PYTHON = process.env.VIDBARS_SAM3_PYTHON || path.join(path.dirname(POKT), '.sam3-venv', 'Scripts', 'python.exe')
const SAM3_SERVER = path.join(__dirname, 'sam3_server.py')
const HOME = path.join(os.tmpdir(), 'vidbars-sketch')
const OPS = new Set(['depth', 'segment', 'lines', 'formhatch', 'bghatch', 'look'])
// The looks that draw on the subject (and so need what Segment finds); the
// background ones use it only when a Segment card names something.
const SUBJECT_LOOKS = new Set(['hatch', 'cel', 'boil', 'misreg', 'construction', 'relight', 'formlight'])

/** Whether this machine can run the tools at all. */
function available() {
  return fs.existsSync(PYTHON) && ['tools/depth.py', 'tools/matte_auto.py', 'tools_scale/look_hybrid_colerase.py']
    .every(f => fs.existsSync(path.join(SKETCH, f)))
}

/** Whether SAM 3's venv is installed. */
const sam3Available = () => fs.existsSync(SAM3_PYTHON)

const toDataUrl = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64')

/** A long-running Python worker (one JSON request per line, one reply per
 *  line), started on first use and again after it stops. */
function worker(label, python, args) {
  let proc = null, ready = null, nextId = 1, tail = ''
  const waiting = new Map()
  const start = () => {
    if (ready) return ready
    ready = new Promise((resolve, reject) => {
      proc = spawn(python, ['-u', ...args], {
        cwd: HOME, windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1' },
      })
      tail = ''
      proc.stderr.on('data', d => { tail = (tail + d).slice(-4000) })
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
        for (const w of waiting.values()) w({ error: why, log: tail })
        waiting.clear()
      }
      proc.on('error', err => down(String(err.message || err)))
      proc.on('exit', code => down(`the ${label} stopped (exit ${code})`))
    })
    return ready
  }
  return {
    async request(msg) {
      await start()
      const id = nextId++
      return new Promise(resolve => {
        waiting.set(id, resolve)
        proc.stdin.write(JSON.stringify({ id, ...msg }) + '\n')
      })
    },
    tail: () => tail,
    stop() { if (proc) { proc.removeAllListeners('exit'); proc.kill(); proc = null; ready = null } },
  }
}

const sketch = worker('sketch worker', PYTHON, [SERVER, SKETCH, path.join(HOME, 'cache')])
const sam3 = worker('SAM 3 worker', SAM3_PYTHON, [SAM3_SERVER, path.join(HOME, 'cache'), SKETCH])
let queue = Promise.resolve()

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
 * job: { op: 'depth' | 'segment' | 'lines' | 'formhatch' | 'bghatch',
 *        frames: (dataUrl | path)[],
 *        objects?: { [name]: string[] }  — what to find (segment, the looks),
 *        engine?: 'sam3' | 'dino'        — what finds it: SAM 3 (the default
 *                                          where .sam3-venv exists) or
 *                                          Grounding DINO + SAM2,
 *        side?: number                   — a look's long edge,
 *        dials?: { [dial]: number }      — a look's dials }
 * Resolves, with `log` (the tools' output), `seconds` and `engine` (what
 * found the things):
 *   depth   { frames: dataUrl[] }  nearer = brighter
 *   segment { objects: { name: dataUrl[] } }  white = the thing, one per
 *           instance, plus 'figure' (all of them); {} when nothing was found
 *   lines / formhatch / bghatch  { frames: [{ layer: dataUrl }], colors }
 *   or { error }.
 */
function run(job) {
  const p = queue.then(() => runNow(job))
  queue = p.catch(() => {})
  return p
}

async function runNow({ op, look, frames, objects, side, dials, engine }) {
  if (!available()) return { error: `sketchLook tools not found at ${POKT}`, log: '' }
  if (!OPS.has(op)) return { error: `unknown op ${op}`, log: '' }
  if (!frames?.length) return { error: 'no frames', log: '' }
  try {
    fs.mkdirSync(HOME, { recursive: true })
    const { hash, paths } = frameFiles(frames)
    // What finds the things: SAM 3 unless asked otherwise or not installed.
    const finds = op === 'segment' || op === 'lines' || op === 'formhatch' || (op === 'look' && SUBJECT_LOOKS.has(look)) ||
      ((op === 'bghatch' || op === 'look') && objects)
    let used = finds ? (engine !== 'dino' && sam3Available() ? 'sam3' : 'dino') : undefined
    let note = ''
    if (used === 'sam3') {
      const r = await sam3.request({ op: 'segment', src: hash, frames: paths, objects })
      if (r.error) { used = 'dino'; note = `SAM 3 failed (${r.error}); used Grounding DINO + SAM2\n${r.log || ''}` }
      else if (op === 'segment') {
        return {
          objects: Object.fromEntries(Object.entries(r.objects).map(([n, fs_]) => [n, fs_.map(toDataUrl)])),
          log: r.log || '', seconds: r.seconds, engine: used,
        }
      }
    }
    const reply = await sketch.request({ op, look, src: hash, frames: paths, objects, side, dials, engine: used })
    if (reply.error) return { error: reply.error, log: note + (reply.log || '') }
    const out = { log: note + (reply.log || ''), seconds: reply.seconds, engine: used }
    if (op === 'depth') out.frames = reply.frames.map(toDataUrl)
    if (op === 'segment') out.objects = Object.fromEntries(Object.entries(reply.objects).map(([n, fs_]) => [n, fs_.map(toDataUrl)]))
    if (op === 'lines' || op === 'formhatch' || op === 'bghatch' || op === 'look') {
      out.frames = reply.frames.map(f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, toDataUrl(v)])))
      out.colors = reply.colors
    }
    return out
  } catch (err) {
    return { error: String(err.message || err), log: sketch.tail() }
  }
}

function stop() {
  sketch.stop()
  sam3.stop()
}

module.exports = { run, available, sam3Available, stop }

if (require.main === module) {
  // node electron/sketchWorker.cjs look:cel pic.png ...  runs one of the drawing looks
  const [opArg, ...rest] = process.argv.slice(2)
  const [op, look] = opArg.split(':')
  const frames = rest.filter(a => !a.includes('='))
  const kv = rest.filter(a => a.includes('=')).map(a => a.split('='))
  const dials = Object.fromEntries(kv.filter(([, v]) => !isNaN(Number(v))).map(([k, v]) => [k, Number(v)]))
  const objects = Object.fromEntries(kv.filter(([, v]) => isNaN(Number(v))).map(([n, ps]) => [n, ps.split(',')]))
  const outDir = process.env.SKETCH_OUT || process.cwd()
  const save = (name, url) => { const f = path.join(outDir, name); fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); console.log('wrote', f) }
  const once = async () => {
    const t0 = Date.now()
    const r = await run({ op, look, frames: frames.map(f => path.resolve(f)), objects, dials, side: 1400, engine: process.env.SKETCH_ENGINE })
    if (r.error) console.error('ERROR', r.error, r.log)
    console.log(`${op}: ${((Date.now() - t0) / 1000).toFixed(1)} s (worker ${r.seconds} s, ${r.engine ?? ''})`)
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
