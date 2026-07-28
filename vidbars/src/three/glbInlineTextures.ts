// glbInlineTextures.ts — rewrite a GLB's embedded textures as data URIs.
//
// A GLB keeps its textures as raw bytes in the binary chunk, referenced by
// `bufferView`. GLTFLoader unpacks each one into a Blob and hands the
// resulting `blob:` URL to its image loader. In this runtime a blob's
// bytes come back unreadable once they are more than a few hundred bytes,
// so every one of those loads fails ("THREE.GLTFLoader: Couldn't load
// texture blob:…") and the model renders in flat grey — the geometry is
// fine, the materials just never get their maps.
//
// The bytes are already in memory, so we hand them to the parser in a form
// that needs no fetch: each image becomes `uri: "data:<mime>;base64,…"`
// and its `bufferView` reference is dropped. Geometry stays in the binary
// chunk untouched, so only texture bytes pay the ~33% base64 cost.
//
// Returns the original buffer unchanged when there is nothing to do (not
// a GLB, no images, or images that already carry a uri).

const GLB_MAGIC = 0x46546c67   // 'glTF'
const CHUNK_JSON = 0x4e4f534a  // 'JSON'
const CHUNK_BIN = 0x004e4942   // 'BIN\0'

/** btoa in slices — one apply() over a multi-MB array blows the stack. */
function base64(bytes: Uint8Array): string {
  let out = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])
  }
  return btoa(out)
}

interface GlbImage { bufferView?: number; mimeType?: string; uri?: string }
interface GlbBufferView { buffer: number; byteOffset?: number; byteLength: number }
interface GlbJson { images?: GlbImage[]; bufferViews?: GlbBufferView[] }

export function inlineGlbTextures(buf: ArrayBuffer): ArrayBuffer {
  if (buf.byteLength < 20) return buf
  const dv = new DataView(buf)
  if (dv.getUint32(0, true) !== GLB_MAGIC) return buf   // .gltf or not a model

  // Walk the chunk table. Chunk lengths are already 4-byte padded per spec.
  let off = 12
  let json: Uint8Array | null = null
  let bin: Uint8Array | null = null
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    const start = off + 8
    if (start + len > buf.byteLength) break            // truncated — leave it alone
    if (type === CHUNK_JSON) json = new Uint8Array(buf, start, len)
    else if (type === CHUNK_BIN) bin = new Uint8Array(buf, start, len)
    off = start + len
  }
  if (!json || !bin) return buf

  let doc: GlbJson
  try { doc = JSON.parse(new TextDecoder().decode(json)) as GlbJson }
  catch { return buf }

  const images = doc.images
  const views = doc.bufferViews
  if (!images?.length || !views?.length) return buf
  if (!images.some(im => im.bufferView !== undefined)) return buf   // already uri-based

  let rewrote = 0
  for (const im of images) {
    if (im.bufferView === undefined) continue
    const v = views[im.bufferView]
    if (!v) continue
    const start = v.byteOffset ?? 0
    if (start + v.byteLength > bin.byteLength) continue
    const mime = im.mimeType || 'image/png'
    im.uri = `data:${mime};base64,${base64(bin.subarray(start, start + v.byteLength))}`
    delete im.bufferView
    delete im.mimeType   // a uri-based image must not also declare mimeType
    rewrote++
  }
  if (rewrote === 0) return buf

  // Re-emit: header + JSON chunk (space-padded to 4) + the untouched BIN chunk.
  const jsonBytes = new TextEncoder().encode(JSON.stringify(doc))
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4
  const jsonLen = jsonBytes.length + jsonPad
  const total = 12 + 8 + jsonLen + 8 + bin.byteLength
  const out = new ArrayBuffer(total)
  const odv = new DataView(out)
  const ou8 = new Uint8Array(out)
  odv.setUint32(0, GLB_MAGIC, true)
  odv.setUint32(4, 2, true)
  odv.setUint32(8, total, true)
  odv.setUint32(12, jsonLen, true)
  odv.setUint32(16, CHUNK_JSON, true)
  ou8.set(jsonBytes, 20)
  for (let i = 0; i < jsonPad; i++) ou8[20 + jsonBytes.length + i] = 0x20   // space
  const binHeader = 20 + jsonLen
  odv.setUint32(binHeader, bin.byteLength, true)
  odv.setUint32(binHeader + 4, CHUNK_BIN, true)
  ou8.set(bin, binHeader + 8)
  return out
}
