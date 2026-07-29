import { putMedia } from './mediaStore'
import { makeMediaRef } from './mediaRef'
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

/**
 * Ingest a dropped/picked file. Stores the bytes in the LOCAL IndexedDB
 * blob store FIRST and returns a `mediaref:` — local-first because the
 * project backup only bundles blob-store media: a server `/uploads/` path
 * is invisible to the exporter and dead without the dev server. A raw copy
 * is still mirrored to the server's uploads folder as an on-disk archive.
 *
 * Fallbacks if the blob store fails (e.g. quota): server upload (the
 * load-time localization sweep pulls it local later), then an inline
 * base64 data URL — a drop is never lost.
 */
export async function uploadFile(file: File): Promise<UploadResult> {
  const type = classifyFile(file)
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
