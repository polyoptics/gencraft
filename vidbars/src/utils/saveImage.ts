// saveImage.ts — keep an image the app MADE (a context sheet, an effect
// result). Desktop: a real file in Pictures, through the bridge, so it can be
// dragged out and revealed like any other. Plain browser: a download.
// Kind 'drag' (a drag-out copy, made ahead of a drag) is desktop only.
//
// One copy for every caller, because the limits are the transport's, not the
// caller's: what one IPC message can carry, and what a browser will download.

import type { SaveImageKind } from '../types/desktop'

export interface SaveImageOutcome {
  /** The file written (desktop only). */
  path: string | null
  /** Handed to the browser's downloads instead — there is no file to point
   *  at, and whether the browser then keeps it is out of the page's sight. */
  downloaded?: boolean
  /** Why nothing was saved. */
  error?: string
}

/** The desktop save crosses ONE ipcRenderer.invoke as a base64 string.
 *  Chromium caps a message at 256 MB, and going over can take the renderer
 *  down — with every unsaved change on the canvas — so stay well under. */
export const MAX_SAVE_CHARS = 192 * 1024 * 1024

/** Chromium will not download a data: url much past 2 MB. */
const MAX_DATA_URL_DOWNLOAD = 2 * 1024 * 1024

const EMPTY = 'the canvas came back empty — try a smaller size'

/** Encode `canvas` and keep it. Never rejects: a failed save comes back as
 *  `error`. `release` shrinks the canvas to 0×0 as soon as it is encoded, so
 *  a huge one is not held alongside its encoded copy while that crosses to
 *  disk — pass it only for a canvas made for this save. */
export async function saveCanvasImage(
  canvas: HTMLCanvasElement,
  kind: SaveImageKind,
  name: string,
  format: 'jpeg' | 'png',
  quality: number,
  release = false,
): Promise<SaveImageOutcome> {
  const spend = () => { if (release) canvas.width = canvas.height = 0 }
  try {
    return await save(canvas, kind, name, format, quality, spend)
  } catch (err) {
    return { path: null, error: String((err as Error)?.message ?? err) }
  } finally {
    spend()
  }
}

async function save(
  canvas: HTMLCanvasElement, kind: SaveImageKind, name: string,
  format: 'jpeg' | 'png', quality: number, spend: () => void,
): Promise<SaveImageOutcome> {
  const mime = format === 'png' ? 'image/png' : 'image/jpeg'
  const d = window.vidbarsDesktop
  if (d && typeof d.saveImage === 'function') {
    const dataUrl = canvas.toDataURL(mime, quality)
    spend()
    // 'data:,' is what Chromium hands back for a canvas it could not allocate.
    if (dataUrl.length < 64) return { path: null, error: EMPTY }
    if (dataUrl.length > MAX_SAVE_CHARS) {
      const mb = Math.round(dataUrl.length * 0.75 / 1048576)
      return { path: null, error: `at ${mb} MB it is more than the desktop can hand over in one piece — pick a smaller size${format === 'png' ? ', or JPEG' : ''}` }
    }
    const r = await d.saveImage(kind, name, dataUrl)
    if (typeof r === 'string') return { path: r }   // an older main: the bare path
    if (r && 'path' in r && r.path) return { path: r.path }
    return { path: null, error: r && 'error' in r && r.error ? r.error : 'could not save the file' }
  }

  // A drag-out copy exists to be handed to an OS drag, which only the
  // desktop can start. Downloading one would drop a file in the user's
  // Downloads on every hover.
  if (kind === 'drag') return { path: null, error: 'drag-out copies need the desktop app' }

  // Plain browser. Small: a data: url, which every browser downloads. Past
  // ~2 MB Chromium refuses one, so hand the downloader a Blob instead — only
  // the downloader touches its bytes; the page never reads them back (which
  // this runtime cannot do, see CLAUDE.md §6).
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, mime, quality))
  if (!blob || blob.size === 0) return { path: null, error: EMPTY }
  const small = blob.size * 4 / 3 < MAX_DATA_URL_DOWNLOAD
  const href = small ? canvas.toDataURL(mime, quality) : URL.createObjectURL(blob)
  spend()
  const a = document.createElement('a')
  a.href = href
  a.download = `${name}.${format === 'png' ? 'png' : 'jpg'}`
  a.click()
  if (!small) setTimeout(() => URL.revokeObjectURL(href), 60_000)
  return { path: null, downloaded: true }
}
