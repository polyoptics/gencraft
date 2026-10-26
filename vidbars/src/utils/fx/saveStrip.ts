// saveStrip.ts — render a strip at full size and keep the result as real
// files (desktop: Pictures\VidBars Effects), one per source image, so they
// can be dragged out, revealed, or put back on the canvas like any media.

import { runChain, type ChainItem } from './chain'
import { EFFECTS } from './effects'
import { diskFileUrl } from '../diskUrl'
import { saveCanvasImage } from '../saveImage'

/** Saved results are rendered at up to this long edge — the sources' own
 *  size, capped where a canvas stays comfortable. */
const SAVE_SIDE = 8192

/** One output, and exactly one of what became of it:
 *    path + url  — saved as a file (desktop)
 *    downloaded  — handed to the browser's downloads; no file to point at
 *    error       — not saved, and why (`label` says which output) */
export interface SavedResult {
  label: string
  url: string | null
  path: string | null
  downloaded?: boolean
  error?: string
}

/** Main cuts a file name at 80 characters; cutting the LABEL first keeps the
 *  effect's name in it. By code points, so an emoji is never halved. */
function clip(s: string, n: number): string {
  const cps = Array.from(s)
  return cps.length > n ? cps.slice(0, n - 1).join('').trimEnd() + '…' : s
}

/** The file name (before main's date stamp) for one picture's result:
 *  its label, then the effects it went through — 'Harbour — Bloom + Ink'.
 *  Shared with the drag-out copy (FxResultLayer), so a dragged file and a
 *  saved one are named alike. */
export function resultName(label: string, items: ChainItem[]): string {
  const fxName = items.flatMap(i => i.kind === 'effect' ? [EFFECTS[i.effect].label] : []).join(' + ')
  return `${clip(label || 'image', 48)} — ${fxName}`
}

/** Why a save did not land, or null. On the desktop every result should
 *  come back as a file, so one with no path failed even when it carries no
 *  reason of its own; in a browser, no path just means it was downloaded. */
export function saveFailure(s: SavedResult): string | null {
  if (s.error) return s.error
  return !s.path && window.vidbarsDesktop?.saveImage ? `Could not save ${s.label || 'the result'}.` : null
}

/** Never rejects, so a caller's "Saving…" always ends: a failure of the
 *  whole run is `error`, one output's failure is that entry's `error`. */
export async function saveStripResult(items: ChainItem[]): Promise<{ saved: SavedResult[]; error?: string }> {
  const saved: SavedResult[] = []
  try {
    // No step previews: nothing would show them, and each is a GPU readback.
    const result = await runChain(items, SAVE_SIDE, false)
    if (result.error && result.outputs.length === 0) return { saved: [], error: result.error }
    for (const o of result.outputs) {
      const name = resultName(o.label, items)
      // The canvas was rendered for this save alone, so it is released once encoded.
      const r = await saveCanvasImage(o.canvas, 'effect', name, 'jpeg', 0.93, true)
      saved.push({ label: o.label, path: r.path, url: r.path ? diskFileUrl(r.path) : null, downloaded: r.downloaded, error: r.error })
    }
    return { saved, error: result.error }
  } catch (err) {
    return { saved, error: String((err as Error)?.message ?? err) }
  }
}
