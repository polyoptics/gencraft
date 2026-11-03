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
const { spawn, execFile } = require('child_process')

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

// ------------------------------------------------------------------ clips
// A video card's frames, for a Run over the whole clip: read out of the
// file a chunk at a time (CHUNK frames, never the whole clip at once) into
// HOME/clips/<clip>/<first frame>/, each chunk then drawn as one sequence so
// boil, optical flow, temporal steadying and SAM 3's tracking see motion.
// The page names a clip only by the id clipInfo handed it: never a file.
const CLIPS = path.join(HOME, 'clips')
const CHUNK = 120
const FFMPEG_DIR = 'C:\\Users\\User\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin'
/** ffmpeg / ffprobe: FFMPEG's folder, else on PATH, else the winget copy the film's scripts use. */
function bin(name) {
  if (process.env.FFMPEG) return path.join(path.dirname(process.env.FFMPEG), name + '.exe')
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(d, name + '.exe')
    if (d && fs.existsSync(f)) return f
  }
  return path.join(FFMPEG_DIR, name + '.exe')
}
const exec = (name, args) => new Promise((resolve, reject) =>
  execFile(bin(name), args, { windowsHide: true, maxBuffer: 1 << 24 }, (err, out, errOut) =>
    err ? reject(new Error(`${name}: ${String(errOut || err.message).trim().split('\n').pop()}`)) : resolve(out)))
/** clip id → { file, fps, n, w, h, audio } */
const clips = new Map()

/** A video file's clip: its id, frame rate, frame count and size. */
async function clipInfo(file) {
  const st = fs.statSync(file)
  const id = crypto.createHash('sha1').update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16)
  const known = clips.get(id)
  if (known) return { id, fps: known.fps, n: known.n, w: known.w, h: known.h, audio: known.audio }
  const j = JSON.parse(await exec('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,width,height,r_frame_rate,avg_frame_rate,nb_frames:format=duration', '-of', 'json', file]))
  const v = (j.streams || []).find(s => s.codec_type === 'video')
  if (!v) throw new Error('no video in the file')
  const rate = r => { const [a, b] = String(r || '0/1').split('/').map(Number); return b ? a / b : 0 }
  const fps = rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 24
  const n = Number(v.nb_frames) || Math.round(Number(j.format?.duration || 0) * fps)
  if (!n) throw new Error('could not count the frames')
  const info = { file, fps, n, w: v.width, h: v.height, audio: (j.streams || []).some(s => s.codec_type === 'audio') }
  clips.set(id, info)
  return { id, fps, n, w: info.w, h: info.h, audio: info.audio }
}

/** Frames start .. start+count of a clip as PNGs (long edge at most 4096):
 *  their paths. Read once; a clip's chunks stay a few days. */
async function clipChunk(id, start, count) {
  const c = clips.get(id)
  if (!c) throw new Error('unknown clip')
  const dir = path.join(CLIPS, id, String(start).padStart(6, '0') + '_' + count)
  if (!fs.existsSync(path.join(dir, 'done'))) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    await exec('ffmpeg', ['-v', 'error', '-ss', (start / c.fps).toFixed(6), '-i', c.file, '-frames:v', String(count),
      '-vf', "scale='if(gte(iw,ih),min(4096,iw),-2)':'if(gte(iw,ih),-2,min(4096,ih))'", '-start_number', '0', path.join(dir, '%04d.png')])
    fs.writeFileSync(path.join(dir, 'done'), '')
  }
  const now = new Date()
  fs.utimesSync(path.join(CLIPS, id), now, now)
  return fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort().map(f => path.join(dir, f))
}

/** A clip bake's frames as they are drawn: HOME/bakes/<bake>/NNNNNN.jpg. */
function bakeFrame(bake, i, dataUrl) {
  const m = /^data:image\/jpeg;base64,(.*)$/s.exec(dataUrl)
  if (!m) throw new Error('not a JPEG')
  const dir = path.join(HOME, 'bakes', bake)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, String(i).padStart(6, '0') + '.jpg'), Buffer.from(m[1], 'base64'))
}

/** A bake's frames as an MP4 at the clip's rate, with the clip's sound over
 *  the same frames; the frames then go. Resolves the file written. */
async function bakeEncode(bake, id, start, count, outFile) {
  const c = clips.get(id)
  if (!c) throw new Error('unknown clip')
  const dir = path.join(HOME, 'bakes', bake)
  const args = ['-v', 'error', '-y', '-framerate', String(c.fps), '-start_number', String(start), '-i', path.join(dir, '%06d.jpg')]
  if (c.audio) args.push('-ss', (start / c.fps).toFixed(6), '-t', (count / c.fps).toFixed(6), '-i', c.file, '-map', '0:v', '-map', '1:a?', '-c:a', 'aac', '-b:a', '192k', '-shortest')
  args.push('-frames:v', String(count), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  try { await exec('ffmpeg', args) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  return outFile
}

/** A bake that stopped: its frames go. */
function bakeDrop(bake) {
  fs.rmSync(path.join(HOME, 'bakes', bake), { recursive: true, force: true })
}

/** Clips not drawn for a few days go, and any bake left half-way. */
function pruneClips(days = 3) {
  for (const d of [CLIPS, path.join(HOME, 'bakes')]) {
    let es = []
    try { es = fs.readdirSync(d) } catch { continue }
    for (const e of es) {
      const p = path.join(d, e)
      try { if (Date.now() - fs.statSync(p).mtimeMs > days * 86400e3) fs.rmSync(p, { recursive: true, force: true }) } catch { /* in use */ }
    }
  }
}
pruneClips()

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

async function runNow({ op, look, frames, clip, objects, side, dials, engine, whole, scale }) {
  if (!available()) return { error: `sketchLook tools not found at ${POKT}`, log: '' }
  if (!OPS.has(op)) return { error: `unknown op ${op}`, log: '' }
  if (!frames?.length && !clip) return { error: 'no frames', log: '' }
  try {
    fs.mkdirSync(HOME, { recursive: true })
    // A clip's chunk (by its clip id and range: one sequence, its results
    // handed back as files: a chunk's worth of data urls would be far too
    // much to pass about), or the page's own pictures.
    const { hash, paths } = clip
      ? { hash: crypto.createHash('sha1').update(`clip|${clip.id}|${clip.start}|${clip.count}`).digest('hex').slice(0, 20),
          paths: await clipChunk(clip.id, clip.start, clip.count) }
      : frameFiles(frames)
    const toUrl = clip ? f => f : toDataUrl
    // What finds the things: SAM 3 unless asked otherwise or not installed.
    // `whole`: nothing named, the whole picture is the subject: nothing to find.
    const finds = !whole && (op === 'segment' || op === 'lines' || op === 'formhatch' || (op === 'look' && SUBJECT_LOOKS.has(look)) ||
      ((op === 'bghatch' || op === 'look') && objects))
    let used = finds ? (engine !== 'dino' && sam3Available() ? 'sam3' : 'dino') : undefined
    let note = ''
    if (used === 'sam3') {
      const r = await sam3.request({ op: 'segment', src: hash, frames: paths, objects })
      if (r.error) { used = 'dino'; note = `SAM 3 failed (${r.error}); used Grounding DINO + SAM2\n${r.log || ''}` }
      else if (op === 'segment') {
        // What SAM 3 found, and how big each thing is on screen (the card shows it).
        const sc = await sketch.request({ op: 'scales', src: hash, frames: paths, objects, engine: used, scale })
        return {
          objects: Object.fromEntries(Object.entries(r.objects).map(([n, fs_]) => [n, fs_.map(toUrl)])),
          scales: sc.scales ?? {}, log: r.log || '', seconds: r.seconds, engine: used,
        }
      }
    }
    const job = { op, look, src: hash, frames: paths, objects, side, dials, engine: used, whole: !!whole, scale }
    let reply = await sketch.request(job)
    // Out of GPU memory (another program, or SAM 3's worker, holding it): free what this worker caches and try
    // once more, rather than hand back a drawing that is not there.
    if (reply.error && /out of memory|CUDA error|cudaMalloc|CUBLAS_STATUS_ALLOC/i.test(`${reply.error}
${reply.log || ''}`)) {
      note += `ran out of GPU memory (${reply.error}); tried again
`
      await sketch.request({ op: 'free' })
      reply = await sketch.request(job)
    }
    if (reply.error) return { error: reply.error, log: note + (reply.log || '') }
    const out = { log: note + (reply.log || ''), seconds: reply.seconds, engine: used }
    if (op === 'depth') out.frames = reply.frames.map(toUrl)
    if (op === 'segment') {
      out.objects = Object.fromEntries(Object.entries(reply.objects).map(([n, fs_]) => [n, fs_.map(toUrl)]))
      out.scales = (await sketch.request({ op: 'scales', src: hash, frames: paths, objects, engine: used, scale })).scales ?? {}
    }
    if (op === 'lines' || op === 'formhatch' || op === 'bghatch' || op === 'look') {
      out.frames = reply.frames.map(f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, toUrl(v)])))
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

module.exports = { run, available, sam3Available, stop, clipInfo, clipChunk, bakeFrame, bakeEncode, bakeDrop, CHUNK }

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
