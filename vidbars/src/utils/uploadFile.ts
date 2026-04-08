export interface UploadResult {
  url: string
  type: 'image' | 'video' | 'audio'
  originalName: string
}

/**
 * Upload a file to the server. Falls back to base64 data URL on error.
 */
export async function uploadFile(file: File): Promise<UploadResult> {
  try {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/upload', { method: 'POST', body: form })
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
    return await res.json()
  } catch {
    // Fallback: convert to data URL (works offline / if server is down)
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const mime = file.type
        const type = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image'
        resolve({
          url: reader.result as string,
          type: type as 'image' | 'video' | 'audio',
          originalName: file.name,
        })
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }
}
