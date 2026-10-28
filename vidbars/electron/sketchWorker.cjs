// sketchWorker.cjs — runs sketchLook's depth and matte tools for VidBars.
//
// The tools live in the fcx24Poktnife checkout and run on its .audio-venv
// (torch + CUDA). They are never edited or copied: sketch_run.py executes
// them as they are, inside a temp work folder, so a picture becomes a
// one-frame clip there and nothing is written into that checkout.
//
// One job at a time: both load models onto the one GPU.
//
//   node electron/sketchWorker.cjs depth pic.png [more frames...]
//   node electron/sketchWorker.cjs segment pic.png "hat=hat,cap" "dog=dog"

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const POKT = process.env.VIDBARS_SKETCHLOOK || 'D:\\Data\\AI\\ClaudeCode\\fcx24Poktnife'
const PYTHON = path.join(POKT, '.audio-venv', 'Scripts', 'python.exe')
const TOOLS = path.join(POKT, 'sketchLook', 'tools')
const SHIM = path.join(__dirname, 'sketch_run.py')
// matte_auto.py searches these unless told otherwise; a Segment card wants
// only the objects it names.
const TOOL_DEFAULT_OBJECTS = ['character', 'rifle', 'truck']

/** Whether this machine can run the tools at all. */
function available() {
  return fs.existsSync(PYTHON) && fs.existsSync(path.join(TOOLS, 'depth.py')) && fs.existsSync(path.join(TOOLS, 'matte_auto.py'))
}

const toDataUrl = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64')

/** A frame as a file path: data URLs are written out, paths pass through. */
function frameFile(frame, dir, i) {
  const m = /^data:image\/(\w+);base64,(.*)$/s.exec(frame)
  if (!m) return frame
  const f = path.join(dir, `in_${String(i).padStart(4, '0')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`)
  fs.writeFileSync(f, Buffer.from(m[2], 'base64'))
  return f
}

/** A safe folder name for an object (it becomes a matte subfolder). */
const objName = s => s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'object'

let queue = Promise.resolve()

/**
 * job: { op: 'depth' | 'segment', frames: (dataUrl | path)[],
 *        objects?: { [name]: string[] }  — segment: phrases per object }
 * Resolves { frames: dataUrl[] } for depth (nearer = brighter),
 * { objects: { name: dataUrl[] } } for segment (white = the object, plus
 * 'figure' = all of them; empty when nothing was found), or { error }.
 * Always with `log`, the tools' own output.
 */
function run(job) {
  const p = queue.then(() => runNow(job))
  queue = p.catch(() => {})
  return p
}

function runNow({ op, frames, objects }) {
  return new Promise(resolve => {
    if (!available()) return resolve({ error: `sketchLook tools not found at ${POKT}`, log: '' })
    if (op !== 'depth' && op !== 'segment') return resolve({ error: `unknown op ${op}`, log: '' })
    if (!frames?.length) return resolve({ error: 'no frames', log: '' })
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vidbars-sketch-'))
    const cleanup = () => fs.rm(work, { recursive: true, force: true }, () => {})
    try {
      const inDir = path.join(work, 'in')
      fs.mkdirSync(inDir)
      const list = path.join(work, 'frames.txt')
      fs.writeFileSync(list, frames.map((f, i) => frameFile(f, inDir, i)).join('\n'))
      const extra = []
      if (op === 'segment') {
        const named = Object.entries(objects || {})
          .map(([n, ps]) => [objName(n), (ps || []).map(s => s.trim().toLowerCase()).filter(Boolean)])
          .filter(([, ps]) => ps.length)
        if (!named.length) { cleanup(); return resolve({ error: 'name at least one thing to find', log: '' }) }
        for (const [n, ps] of named) extra.push('--phrase', `${n}=${ps.join(',')}`)
        for (const d of TOOL_DEFAULT_OBJECTS) if (!named.some(([n]) => n === d)) extra.push('--no-box', d)
      }
      const py = spawn(PYTHON, [SHIM, op, work, TOOLS, list, ...extra], {
        cwd: work, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1' },
      })
      let log = ''
      py.stdout.on('data', d => { log += d })
      py.stderr.on('data', d => { log += d })
      py.on('error', err => { cleanup(); resolve({ error: String(err.message || err), log }) })
      py.on('close', code => {
        const line = log.split(/\r?\n/).reverse().find(l => l.startsWith('RESULT '))
        let out
        try {
          if (code !== 0 || !line) throw new Error(`tool exited ${code}`)
          const r = JSON.parse(line.slice(7))
          out = op === 'depth'
            ? { frames: r.frames.map(toDataUrl) }
            : { objects: Object.fromEntries(Object.entries(r.objects).map(([n, fs_]) => [n, fs_.map(toDataUrl)])) }
        } catch (err) {
          out = { error: String(err.message || err) }
        }
        cleanup()
        resolve({ ...out, log: log.replace(/^RESULT .*$/m, '').slice(-4000) })
      })
    } catch (err) {
      cleanup()
      resolve({ error: String(err.message || err), log: '' })
    }
  })
}

module.exports = { run, available }

if (require.main === module) {
  const [op, ...rest] = process.argv.slice(2)
  const frames = rest.filter(a => !a.includes('='))
  const objects = Object.fromEntries(rest.filter(a => a.includes('=')).map(a => { const [n, ps] = a.split('='); return [n, ps.split(',')] }))
  const outDir = process.env.SKETCH_OUT || process.cwd()
  const t0 = Date.now()
  run({ op, frames: frames.map(f => path.resolve(f)), objects }).then(r => {
    const save = (name, url) => { const f = path.join(outDir, name); fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); console.log('wrote', f) }
    r.frames?.forEach((u, i) => save(`depth_${i}.png`, u))
    for (const [n, us] of Object.entries(r.objects || {})) us.forEach((u, i) => save(`mask_${n}_${i}.png`, u))
    console.log(r.log)
    if (r.error) { console.error('ERROR', r.error); process.exitCode = 1 }
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s`)
  })
}
