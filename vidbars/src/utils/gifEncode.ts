// gifEncode.ts — a small animated GIF writer: frames of RGBA pixels in, the
// bytes of a looping GIF89a out. Each frame gets its own 256 colours (median
// cut over a 5-bit-per-channel histogram), so shots of different looks in
// one GIF each keep theirs. No dithering, no frame differencing: quick, and
// good enough for a GIF made in a click (utils/makeGif).

class Bytes {
  buf = new Uint8Array(1 << 20)
  len = 0
  private room(n: number) {
    if (this.len + n <= this.buf.length) return
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n))
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }
  byte(b: number) { this.room(1); this.buf[this.len++] = b }
  u16(v: number) { this.room(2); this.buf[this.len++] = v & 255; this.buf[this.len++] = (v >> 8) & 255 }
  bytes(a: ArrayLike<number>) { this.room(a.length); this.buf.set(a, this.len); this.len += a.length }
  text(s: string) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)) }
}

/** 256 colours for one frame, and each pixel's index into them. */
function quantize(rgba: Uint8ClampedArray, pixels: number): { palette: Uint8Array; index: Uint8Array } {
  const BINS = 32768
  const count = new Uint32Array(BINS)
  const sumR = new Uint32Array(BINS), sumG = new Uint32Array(BINS), sumB = new Uint32Array(BINS)
  const binOf = new Uint16Array(pixels)
  for (let i = 0, p = 0; i < pixels; i++, p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2]
    const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    binOf[i] = bin
    count[bin]++
    sumR[bin] += r; sumG[bin] += g; sumB[bin] += b
  }
  // The bins in use, cut into boxes: [from, to) ranges of `used`.
  let used: number[] = []
  for (let bin = 0; bin < BINS; bin++) if (count[bin]) used.push(bin)
  const chan = (bin: number, c: number) => (bin >> (10 - 5 * c)) & 31
  interface Box { from: number; to: number; axis: number; score: number }
  const measure = (from: number, to: number): Box => {
    let n = 0, axis = 0, range = -1
    for (let c = 0; c < 3; c++) {
      let lo = 31, hi = 0
      for (let i = from; i < to; i++) { const v = chan(used[i], c); if (v < lo) lo = v; if (v > hi) hi = v }
      if (hi - lo > range) { range = hi - lo; axis = c }
    }
    for (let i = from; i < to; i++) n += count[used[i]]
    // A box of one bin cannot be cut.
    return { from, to, axis, score: to - from < 2 ? -1 : (range + 1) * Math.sqrt(n) }
  }
  const boxes: Box[] = [measure(0, used.length)]
  while (boxes.length < 256) {
    let best = 0
    for (let i = 1; i < boxes.length; i++) if (boxes[i].score > boxes[best].score) best = i
    const box = boxes[best]
    if (box.score < 0) break
    const part = used.slice(box.from, box.to).sort((a, b) => chan(a, box.axis) - chan(b, box.axis))
    for (let i = 0; i < part.length; i++) used[box.from + i] = part[i]
    let total = 0
    for (const bin of part) total += count[bin]
    let run = 0, cut = 1
    for (let i = 0; i < part.length - 1; i++) {
      run += count[part[i]]
      cut = i + 1
      if (run >= total / 2) break
    }
    boxes[best] = measure(box.from, box.from + cut)
    boxes.push(measure(box.from + cut, box.to))
  }
  const palette = new Uint8Array(768)
  const lut = new Uint8Array(BINS)
  boxes.forEach((box, k) => {
    let n = 0, r = 0, g = 0, b = 0
    for (let i = box.from; i < box.to; i++) {
      const bin = used[i]
      n += count[bin]; r += sumR[bin]; g += sumG[bin]; b += sumB[bin]
      lut[bin] = k
    }
    if (n) { palette[k * 3] = Math.round(r / n); palette[k * 3 + 1] = Math.round(g / n); palette[k * 3 + 2] = Math.round(b / n) }
  })
  used = []
  const index = new Uint8Array(pixels)
  for (let i = 0; i < pixels; i++) index[i] = lut[binOf[i]]
  return { palette, index }
}

const table = new Uint16Array(4096 * 256)

/** GIF's LZW, 8-bit codes to start, into 255-byte sub-blocks. */
function lzw(index: Uint8Array, out: Bytes) {
  const MIN = 8, CLEAR = 1 << MIN, END = CLEAR + 1
  out.byte(MIN)
  const block = new Uint8Array(255)
  let fill = 0, acc = 0, bits = 0
  const emit = (code: number, size: number) => {
    acc |= code << bits
    bits += size
    while (bits >= 8) {
      block[fill++] = acc & 255
      acc >>>= 8
      bits -= 8
      if (fill === 255) { out.byte(255); out.bytes(block); fill = 0 }
    }
  }
  let next = END + 1, size = MIN + 1
  table.fill(0)
  emit(CLEAR, size)
  let prefix = index[0]
  for (let i = 1; i < index.length; i++) {
    const k = index[i]
    const key = (prefix << 8) | k
    const known = table[key]
    if (known) { prefix = known; continue }
    emit(prefix, size)
    if (next < 4096) {
      table[key] = next++
      if (next > (1 << size) && size < 12) size++
    } else {
      emit(CLEAR, size)
      table.fill(0)
      next = END + 1
      size = MIN + 1
    }
    prefix = k
  }
  emit(prefix, size)
  emit(END, size)
  if (bits > 0) { block[fill++] = acc & 255 }
  if (fill > 0) { out.byte(fill); out.bytes(block.subarray(0, fill)) }
  out.byte(0)
}

/** A looping GIF being written, frame by frame. */
export class GifWriter {
  private out = new Bytes()
  /** Each frame as written, to play again backward (finish). */
  private frames: Uint8Array[] = []
  readonly width: number
  readonly height: number
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    const o = this.out
    o.text('GIF89a')
    o.u16(width); o.u16(height)
    o.byte(0x70); o.byte(0); o.byte(0)          // no global colours
    o.bytes([0x21, 0xff, 11]); o.text('NETSCAPE2.0')
    o.bytes([3, 1]); o.u16(0); o.byte(0)        // loop for ever
  }
  /** One frame (width × height RGBA), shown for `delayCs` hundredths of a second. */
  frame(rgba: Uint8ClampedArray, delayCs: number) {
    const o = new Bytes()
    const { palette, index } = quantize(rgba, this.width * this.height)
    o.bytes([0x21, 0xf9, 4, 0x04]); o.u16(Math.max(2, Math.round(delayCs))); o.bytes([0, 0])
    o.byte(0x2c); o.u16(0); o.u16(0); o.u16(this.width); o.u16(this.height)
    o.byte(0x87)                                 // its own 256 colours
    o.bytes(palette)
    lzw(index, o)
    this.frames.push(o.buf.slice(0, o.len))
  }
  /** The finished file's bytes. Ping-pong: forward, then back again (the
   *  two end frames once each, so the turn does not stick). */
  finish(pingPong = false): Uint8Array {
    for (const f of this.frames) this.out.bytes(f)
    if (pingPong) for (let i = this.frames.length - 2; i >= 1; i--) this.out.bytes(this.frames[i])
    this.frames = []
    this.out.byte(0x3b)
    return this.out.buf.slice(0, this.out.len)
  }
}
