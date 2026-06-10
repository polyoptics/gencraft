import { putMedia } from './mediaStore'
import { makeMediaRef } from './mediaRef'

export interface UploadResult {
  url: string
  type: 'image' | 'video' | 'audio'
  originalName: string
}

/**
 * Ingest a dropped/picked file. Tries the server upload first; if that's
 * unavailable, stores the file in the LOCAL blob store and returns a
 * `mediaref:` (so new media never bloats the persisted state as base64).
 * Only if the blob store also fails do we fall back to a base64 data URL
 * so a drop is never lost.
 */
export async function uploadFile(file: File): Promise<UploadResult> {
  const mime = file.type
  const type: UploadResult['type'] =
    mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image'
  try {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/upload', { method: 'POST', body: form })
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
    return await res.json()
  } catch {
    // Server unavailable → keep it local: store the File (a Blob) in the
    // media blob store and reference it.
    try {
      const id = await putMedia(file)
      return { url: makeMediaRef(id), type, originalName: file.name }
    } catch {
      // Last resort (e.g. quota): inline as a data URL so the drop survives.
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve({ url: reader.result as string, type, originalName: file.name })
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
    }
  }
}
