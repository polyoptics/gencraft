// fbxDataTextures.ts — make FBX's EMBEDDED textures survive this runtime.
//
// Binary FBX stores textures inline, and three's FBXLoader turns each one
// into a blob: URL:
//
//     return URL.createObjectURL( new Blob( [ array.buffer ], { type } ) )
//
// Blob urls do not work here. Measured on the user's own spacesuit.fbx: the
// loader produced exactly one blob url (image/jpeg, 2.7 MB) and feeding it
// to an <img> fired `error`. The texture object survives with no `image` at
// all, which is why the model renders untextured rather than visibly broken.
// Same root cause as the grey GLB models — see glbInlineTextures.
//
// The obvious fix, "convert the Blob to a data url", is not available: this
// runtime cannot read blob bytes back either (FileReader, arrayBuffer(),
// fetch() all fail above ~256 B). So instead of reading the Blob AFTER it
// exists, we capture the bytes as it is CONSTRUCTED, and hand back a data
// url from those bytes without the Blob ever being read.
//
// The patch window is exactly the synchronous FBXLoader.parse call, and is
// restored in a finally. FBX parsing is synchronous, so nothing else can
// interleave and see the patched globals.

/** Chunked so a multi-megabyte texture cannot blow the argument limit on
 *  String.fromCharCode — same reason glbInlineTextures chunks. */
function base64(bytes: Uint8Array): string {
  let out = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])
  }
  return btoa(out)
}

function partsToBytes(parts: BlobPart[]): Uint8Array | null {
  const chunks: Uint8Array[] = []
  for (const p of parts) {
    if (p instanceof Uint8Array) chunks.push(p)
    else if (p instanceof ArrayBuffer) chunks.push(new Uint8Array(p))
    else if (ArrayBuffer.isView(p)) chunks.push(new Uint8Array(p.buffer, p.byteOffset, p.byteLength))
    else return null                      // a string part is not a texture
  }
  if (chunks.length === 1) return chunks[0]
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const all = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { all.set(c, off); off += c.byteLength }
  return all
}

/** Run `parse` with embedded-image blobs redirected to data: urls. */
export function withDataUrlTextures<T>(parse: () => T): T {
  const RealBlob = window.Blob
  const realCreate = URL.createObjectURL
  // Bytes captured at construction, keyed by the Blob instance itself.
  const captured = new WeakMap<Blob, { type: string; parts: BlobPart[] }>()

  class PatchedBlob extends RealBlob {
    constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
      super(parts, options)
      captured.set(this as unknown as Blob, { type: options?.type ?? '', parts })
    }
  }

  ;(window as unknown as { Blob: typeof Blob }).Blob = PatchedBlob as unknown as typeof Blob
  URL.createObjectURL = ((obj: Blob | MediaSource): string => {
    const rec = obj instanceof RealBlob ? captured.get(obj) : undefined
    // Only images are redirected. Anything else keeps the real behaviour,
    // so this cannot quietly change something it was not aimed at.
    if (rec && rec.type.startsWith('image/')) {
      const bytes = partsToBytes(rec.parts)
      if (bytes) return `data:${rec.type};base64,${base64(bytes)}`
    }
    return realCreate.call(URL, obj as Blob)
  }) as typeof URL.createObjectURL

  try {
    return parse()
  } finally {
    ;(window as unknown as { Blob: typeof Blob }).Blob = RealBlob
    URL.createObjectURL = realCreate
  }
}
