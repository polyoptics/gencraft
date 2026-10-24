import { putMedia } from './mediaStore'
import { makeMediaRef } from './mediaRef'
import { diskFileUrl, isServableDiskPath } from './diskUrl'
import type { MediaType } from '../types/bar'

export interface UploadResult {
  url: string
  type: MediaType
  originalName: string
}

const MODEL_EXT = /\.(glb|gltf|fbx)$/i

/** Classify a file into a MediaType. MIME-first with an extension fallback:
 *  Windows commonly reports an EMPTY file.type for .glb/.gltf drags, so the
 *  extension sniff is mandatory, not defensive. Single source of truth —
 *  every drop filter and node-type derivation calls this. */
export function classifyFile(file: File): MediaType {
  const mime = file.type
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('model/') || MODEL_EXT.test(file.name)) return 'model'
  return 'image'
}

/** True for any file kind the canvas accepts (image/video/audio/3D model). */
export function isAcceptedMediaFile(f: File): boolean {
  return f.type.startsWith('image/') || f.type.startsWith('video/')
    || f.type.startsWith('audio/') || f.type.startsWith('model/')
    || MODEL_EXT.test(f.name)
}

/** Fill in the MIME type Windows drops for .glb/.gltf drags so the stored
 *  blob (and its backup zip entry name) knows what it is. Non-copying:
 *  slice() re-types the same backing bytes. */
function withKnownMime(file: File): Blob {
  if (file.type) return file
  if (/\.glb$/i.test(file.name)) return file.slice(0, file.size, 'model/gltf-binary')
  if (/\.gltf$/i.test(file.name)) return file.slice(0, file.size, 'model/gltf+json')
  // No registered MIME for FBX; this is the de-facto one and it only has to
  // round-trip through our own blob store and backup zip.
  if (/\.fbx$/i.test(file.name)) return file.slice(0, file.size, 'application/octet-stream')
  return file
}

/** Best-effort raw-file archive: also POST the file to the dev server so a
 *  plain copy lands in public/uploads/ on disk. The returned path is never
 *  referenced — the blob store is the source of truth — so failures (no dev
 *  server, prod build) are silently ignored. */
function mirrorToServer(file: File): void {
  const form = new FormData()
  form.append('file', file)
  fetch('/api/upload', { method: 'POST', body: form }).catch(() => {})
}

/** Desktop only: the stored url for a file REFERENCED IN PLACE, or null
 *  when it must be copied instead — a plain browser, a file with no path
 *  (pasted, generated), a temp copy (dragged out of a zip or an email,
 *  deleted afterwards), or a kind /api/file will not serve.
 *
 *  Takes the ORIGINAL File: withKnownMime's slice() is a path-less Blob.
 *  Each bridge method is feature-detected because a hot reload can pair
 *  this code with an older preload that predates it. */
async function diskReference(file: File): Promise<string | null> {
  const d = window.vidbarsDesktop
  if (!d || typeof d.pathForFile !== 'function' || typeof d.isStablePath !== 'function') return null
  const p = d.pathForFile(file)
  if (!p || !isServableDiskPath(p)) return null
  try {
    if (!(await d.isStablePath(p))) return null
    // Size + mtime as dropped: a re-export to the same path is a new url,
    // so posters and parsed models cached by url do not stick to the old one.
    return diskFileUrl(p, `${file.size.toString(36)}-${file.lastModified.toString(36)}`)
  } catch {
    return null
  }
}

/**
 * Ingest a dropped/picked file.
 *
 * In the DESKTOP app a file from disk is referenced where it sits
 * (`/api/file?path=…`) and nothing is copied: the canvas is a map of the
 * user's drive, not a second copy of it. The trade-off is deliberate — a
 * project backup carries the reference, not the bytes, and moving or
 * deleting the file in Explorer breaks the tile.
 *
 * Otherwise the bytes go into the LOCAL IndexedDB blob store and a
 * `mediaref:` comes back — local-first because the project backup only
 * bundles blob-store media. A raw copy is still mirrored to the server's
 * uploads folder as an on-disk archive.
 *
 * Fallbacks if the blob store fails (e.g. quota): server upload, then an
 * inline base64 data URL — a drop is never lost.
 */
export async function uploadFile(file: File): Promise<UploadResult> {
  const type = classifyFile(file)
  const ref = await diskReference(file)
  if (ref) return { url: ref, type, originalName: file.name }
  try {
    const id = await putMedia(withKnownMime(file))
    mirrorToServer(file)
    return { url: makeMediaRef(id), type, originalName: file.name }
  } catch {
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/upload', { method: 'POST', body: form })
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
      // Keep the CLIENT classification — the upload server predates 'model'
      // and would mislabel .glb as 'image'.
      const json = await res.json()
      return { ...json, type }
    } catch {
      // Last resort: inline as a data URL so the drop survives.
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve({ url: reader.result as string, type, originalName: file.name })
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
    }
  }
}
