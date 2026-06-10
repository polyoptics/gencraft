// mediaRef.ts — reference scheme + codecs for the media blob store.
//
// An image/media value in the project state is either a plain URL
// (`data:`, `http(s):`, `blob:`, or a path) OR a `mediaref:<uuid>`
// pointer into the IndexedDB blob store (see mediaStore.ts). Only
// `data:` URLs get migrated into the blob store; everything else is
// used verbatim.

const PREFIX = 'mediaref:'

export function isMediaRef(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.startsWith(PREFIX)
}

export function makeMediaRef(id: string): string {
  return PREFIX + id
}

export function mediaRefId(s: string | null | undefined): string | null {
  return isMediaRef(s) ? s.slice(PREFIX.length) : null
}

export function isDataUrl(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.startsWith('data:')
}

/** Decode a base64 (or percent-encoded) data URL into a Blob.
 *  Returns null if the input isn't a data URL or can't be decoded. */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  if (!isDataUrl(dataUrl)) return null
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const header = dataUrl.slice(0, comma)
  const body = dataUrl.slice(comma + 1)
  const mime = header.match(/^data:([^;,]*)/)?.[1] || 'application/octet-stream'
  const isB64 = /;base64/i.test(header)
  try {
    if (isB64) {
      const binary = atob(body)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return new Blob([bytes], { type: mime })
    }
    return new Blob([decodeURIComponent(body)], { type: mime })
  } catch {
    return null
  }
}

/** Encode a Blob as a base64 data URL — used by export re-inlining so
 *  backup files stay self-contained. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'))
    reader.readAsDataURL(blob)
  })
}
