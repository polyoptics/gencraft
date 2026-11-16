// cutMovie.cjs — a run of shots, end to end, as one MP4.
//
// The page opens a movie with its parts in order (each a file main found,
// where it starts in that file and how long it runs; a still picture is
// held for its length), asks for each part to be made, then closes it into
// one file. Every part is drawn to the same size and frame rate — those of
// the first moving part — fitted inside with black around it. Sound is kept where a part has it and silent
// where it has none; a movie with no sound anywhere has no sound track.
//
// Parts are made one at a time into a folder of their own (so the page can
// say how far along it is and stop between them), then joined without
// drawing the pictures again.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { bin } = require('./sketchWorker.cjs')

const HOME = path.join(os.tmpdir(), 'vidbars-movie')
/** The longest side a movie is made at. */
const MAX_SIDE = 3840
/** movie id → { dir, parts, w, h, fps, sound, made: Set, child } */
const jobs = new Map()

/** Run ffmpeg / ffprobe; `job.child` is the one running, so a drop can end it. */
const exec = (name, args, job) => new Promise((resolve, reject) => {
  const child = execFile(bin(name), args, { windowsHide: true, maxBuffer: 1 << 24 }, (err, out, errOut) => {
    if (job && job.child === child) job.child = null
    err ? reject(new Error(`${name}: ${String(errOut || err.message).trim().split('\n').pop()}`)) : resolve(out)
  })
  if (job) job.child = child
})

const probed = new Map()
/** A file's picture size, frame rate and whether it has sound. */
async function probe(file) {
  const st = fs.statSync(file)
  const key = `${file}|${st.size}|${st.mtimeMs}`
  const known = probed.get(key)
  if (known) return known
  const j = JSON.parse(await exec('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,width,height,r_frame_rate,avg_frame_rate:stream_side_data=rotation:format=duration', '-of', 'json', file]))
  const v = (j.streams || []).find(s => s.codec_type === 'video' && s.width && s.height)
  if (!v) throw new Error('no picture in the file')
  const rate = r => { const [a, b] = String(r || '0/1').split('/').map(Number); return b ? a / b : 0 }
  // A phone's movie lying on its side: ffmpeg turns it upright as it reads.
  const turned = (v.side_data_list || []).some(d => Math.abs(Number(d.rotation) || 0) % 180 === 90)
  const info = {
    w: turned ? v.height : v.width, h: turned ? v.width : v.height,
    fps: rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 0,
    audio: (j.streams || []).some(s => s.codec_type === 'audio'),
    length: Number(j.format?.duration) || 0,
  }
  probed.set(key, info)
  return info
}

/** Movies left half-way a day ago go. */
function prune() {
  let names
  try { names = fs.readdirSync(HOME) } catch { return }
  for (const n of names) {
    const d = path.join(HOME, n)
    try { if (!jobs.has(n) && Date.now() - fs.statSync(d).mtimeMs > 24 * 3600 * 1000) fs.rmSync(d, { recursive: true, force: true }) } catch { /* in use */ }
  }
}

/** Open a movie of `parts` ([{ file, still, in, len }], in order): its id,
 *  size and frame rate, and how long it will run. */
async function open(parts) {
  prune()
  const infos = []
  for (let i = 0; i < parts.length; i++) {
    try { infos.push(await probe(parts[i].file)) } catch (err) { throw new Error(`shot ${i + 1}: ${err.message}`) }
  }
  // The first moving part sets the shape and the rate; all stills: the first, at 30.
  const lead = parts.findIndex(p => !p.still)
  const shape = infos[lead < 0 ? 0 : lead]
  const k = Math.min(1, MAX_SIDE / Math.max(shape.w, shape.h))
  const even = n => Math.max(2, 2 * Math.round(n * k / 2))
  const fps = lead < 0 ? 30 : Math.max(1, Math.min(60, shape.fps || 30))
  // A part with no length of its own runs to the end of its file.
  const lens = parts.map((p, i) => p.len || Math.max(0, infos[i].length - p.in))
  const short = lens.findIndex(l => !(l >= 0.03))
  if (short >= 0) throw new Error(`shot ${short + 1}: nothing of it is left to play`)
  const id = crypto.randomBytes(8).toString('hex')
  const dir = path.join(HOME, id)
  fs.mkdirSync(dir, { recursive: true })
  jobs.set(id, {
    dir, w: even(shape.w), h: even(shape.h), fps, made: new Set(), child: null,
    parts: parts.map((p, i) => ({ ...p, len: lens[i], audio: !p.still && infos[i].audio })),
    sound: parts.some((p, i) => !p.still && infos[i].audio),
  })
  const job = jobs.get(id)
  return { id, w: job.w, h: job.h, fps, length: lens.reduce((a, l) => a + l, 0) }
}

const partFile = (job, i) => path.join(job.dir, String(i).padStart(5, '0') + '.mkv')

/** Make part i of an open movie. */
async function part(id, i) {
  const job = jobs.get(id)
  const p = job && job.parts[i]
  if (!p) throw new Error('unknown movie')
  const len = p.len.toFixed(6)
  const fps = String(job.fps)
  const args = ['-v', 'error', '-y']
  if (p.still) {
    // A GIF plays on, round and round, for its length; any other picture is held.
    if (/\.gif$/i.test(p.file)) args.push('-ignore_loop', '0', '-t', len, '-i', p.file)
    else args.push('-loop', '1', '-framerate', fps, '-t', len, '-i', p.file)
  } else {
    args.push('-ss', p.in.toFixed(6), '-t', len, '-i', p.file)
  }
  if (job.sound && !p.audio) args.push('-f', 'lavfi', '-t', len, '-i', 'anullsrc=r=48000:cl=stereo')
  // Fitted inside the movie's shape, black around it; a part whose file ends
  // early holds its last frame, so every part runs exactly its length.
  args.push('-vf', `scale=${job.w}:${job.h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${job.w}:${job.h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,`
    + `fps=${fps},tpad=stop_mode=clone:stop_duration=${len},format=yuv420p`, '-map', '0:v:0')
  if (job.sound) args.push('-map', p.audio ? '0:a:0' : '1:a:0', '-af', 'aresample=48000:async=1,apad', '-c:a', 'pcm_s16le', '-ac', '2', '-ar', '48000')
  else args.push('-an')
  args.push('-t', len, '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', partFile(job, i))
  await exec('ffmpeg', args, job)
  job.made.add(i)
}

/** Join an open movie's parts into `outFile` (an .mp4); its folder then goes. */
async function close(id, outFile) {
  const job = jobs.get(id)
  if (!job) throw new Error('unknown movie')
  try {
    for (let i = 0; i < job.parts.length; i++) if (!job.made.has(i)) throw new Error(`shot ${i + 1} was not made`)
    const list = path.join(job.dir, 'list.txt')
    fs.writeFileSync(list, job.parts.map((_, i) => `file '${partFile(job, i).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n')
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    const args = ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy']
    if (job.sound) args.push('-c:a', 'aac', '-b:a', '192k')
    // 'wx'-like: never over a file already there (the name is new, but be sure).
    args.push('-movflags', '+faststart', '-n', outFile)
    await exec('ffmpeg', args, job)
    return outFile
  } finally {
    drop(id)
  }
}

/** A movie that stopped: what was made of it goes. */
function drop(id) {
  const job = jobs.get(id)
  if (!job) return
  jobs.delete(id)
  try { job.child?.kill() } catch { /* already over */ }
  // (A part being written is let go of a moment after its ffmpeg ends.)
  const rm = () => { try { fs.rmSync(job.dir, { recursive: true, force: true }) } catch { /* next prune */ } }
  rm()
  setTimeout(rm, 1500).unref?.()
}

module.exports = { open, part, close, drop }
