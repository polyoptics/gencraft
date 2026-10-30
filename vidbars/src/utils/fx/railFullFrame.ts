// railFullFrame — the frame a loop strip's Viewer shows, rendered at the size
// a Run would make it. The live preview works at FX_REF_SIDE; pieces cut from
// a docked Viewer (ImageStudio) come from this instead, so they carry the
// sources' real pixels without a Run.
//
// Rendered on the first cut and shared by the cuts that follow, so snipping
// repeatedly costs one render per recipe. A frame can be 8192 px a side, so
// it is let go a little after its last use, or as soon as the recipe moves on.

import { useFreeNodeStore } from '../../store/freeNodeStore'
import { usePosterMapStore } from '../../three/posterService'
import { isRail, railMembers } from '../rail'
import { railComboAt, railFaceCombo } from './railChain'
import { renderRailFrame } from './railRun'

const IDLE_MS = 20_000

export interface FullFrame {
  canvas: HTMLCanvasElement
  /** Done with it. Every frame handed out must be released. */
  release: () => void
}

interface Entry {
  sig: string
  frame: Promise<HTMLCanvasElement | null>
  users: number
  timer?: number
}

const entries = new Map<string, Entry>()

function free(entry: Entry): void {
  window.clearTimeout(entry.timer)
  void entry.frame.then(c => { if (c) c.width = c.height = 0 })
}

/** The strip's face-up combination at full size, or null when there is
 *  nothing to render or the render failed. Never rejects. */
export async function railFullFrame(railId: string): Promise<FullFrame | null> {
  const { nodes } = useFreeNodeStore.getState()
  const rail = nodes[railId]
  if (!isRail(rail)) return null
  const members = railMembers(nodes).get(railId)
  const combo = railComboAt(rail, members, railFaceCombo(rail, members), usePosterMapStore.getState().map)
  if (!combo) return null
  const sig = JSON.stringify(combo.items)

  let entry = entries.get(railId)
  if (entry?.sig !== sig) {
    // A frame still being cut from is freed by its last release.
    if (entry && entry.users === 0) free(entry)
    entry = { sig, frame: renderRailFrame(combo.items).catch(() => null), users: 0 }
    entries.set(railId, entry)
  }
  const held = entry
  window.clearTimeout(held.timer)
  held.users++
  const canvas = await held.frame
  const release = () => {
    if (--held.users > 0) return
    if (entries.get(railId) !== held) { free(held); return }
    held.timer = window.setTimeout(() => {
      if (entries.get(railId) === held) entries.delete(railId)
      free(held)
    }, IDLE_MS)
  }
  if (!canvas) {
    // Not cached: the next cut gets a fresh try.
    if (entries.get(railId) === held) entries.delete(railId)
    release()
    return null
  }
  return { canvas, release }
}
