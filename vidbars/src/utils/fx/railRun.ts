// railRun.ts — running a loop strip: every combination its columns make
// (utils/fx/railChain), rendered at full size, kept as a file, and dealt
// face-up onto the rail's results tray. Results made from a docked CARD's
// pictures land together as one card (utils/railCards' landResultCard),
// its pictures in the order they were made — one result card per input
// card — and, the run done, those cards close into one deck on the tray
// (deckRunResults): the run's results, in input order, to take away whole.
//
// One undo step for the whole run: Ctrl+Z afterwards takes every result
// back off the tray (the files stay on disk, as a saved strip's do). The
// step is taken as the first result lands, so a run that stops or fails
// before making anything leaves no empty step behind. An undo or redo
// DURING a run stops it, and the result in flight is dropped: the run was
// writing into the state the user just stepped away from.
//
// The combinations are read ONCE, when Run is pressed. Docking, reordering
// or tweaking a slider mid-run changes the next run, not this one — a run
// whose later results quietly followed edits made while it was going would
// be neither the old recipe nor the new one.
//
// Sequential: one combination at a time, across all rails (`lane`). Each
// render can be 8192 px a side, and its canvas is held until its file is
// written; two at once would double that for no gain — the GPU section of
// runChain is synchronous anyway.

import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useRailRunStore } from '../../store/railRunStore'
import { onUndoRestore, useUndoCoordinator } from '../../store/undoCoordinator'
import { usePosterMapStore } from '../../three/posterService'
import { RAIL_GEOM, RAIL_TRAY, isRail, railMembers } from '../rail'
import { deckRunResults, landResultCard, unitCardId } from '../railCards'
import { useBoardsStore } from '../../store/boardsStore'
import { diskFileUrl } from '../diskUrl'
import { saveCanvasImage } from '../saveImage'
import { loadImage, runChain, type ChainItem } from './chain'
import { railComboAt, railComboCount } from './railChain'
import { resultName } from './saveStrip'

/** Results render at up to this long edge on the desktop — the sources' own
 *  size, capped where a canvas stays comfortable (saveStrip's SAVE_SIDE). */
const RUN_SIDE = 8192
/** In a plain browser there is no file to write: the result is kept in the
 *  tile itself as a data: url (CLAUDE.md §6 — never a blob), so it is
 *  rendered no larger than a tile needs, and the project stays a sane size. */
const BROWSER_SIDE = 2048
/** A run this big asks first: each result is a full-size render and a file. */
const ASK_ABOVE = 100

/** Rails whose run loop is going, those asked to stop, and those stopped by
 *  an undo or redo — whose result in flight must not land. */
const active = new Set<string>()
const stopAsked = new Set<string>()
const discarded = new Set<string>()

onUndoRestore(() => {
  for (const railId of active) {
    discarded.add(railId)
    stopRail(railId)
  }
})

/** One combination at a time, whichever rail it is for. */
let lane: Promise<unknown> = Promise.resolve()
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const p = lane.then(job)
  lane = p.catch(() => undefined)
  return p
}

export function isRailRunning(railId: string): boolean {
  return active.has(railId)
}

/** Ask a running rail to stop. The combination in flight finishes (a result
 *  already written to disk still lands, so no file is left without its
 *  tile); nothing after it starts. */
export function stopRail(railId: string): void {
  if (!active.has(railId)) return
  stopAsked.add(railId)
  useRailRunStore.getState().patchRun(railId, { stopping: true })
}

const desktopSaves = () => typeof window.vidbarsDesktop?.saveImage === 'function'

/** The first picture of a combination that cannot be read, as a reason, or
 *  null. runChain passes a blend partner it cannot read silently (the blend
 *  then copies) — fine for a live view, wrong for a result that will be
 *  kept as if the texture were in it. Decodes are cached, so runChain
 *  reuses these. The live preview (RailRunHost) asks too, so the ghost never
 *  shows a result the run would refuse. */
export async function unreadable(items: ChainItem[]): Promise<string | null> {
  const sources = items.filter((i): i is Extract<ChainItem, { kind: 'source' }> => i.kind === 'source')
  const read = await Promise.all(sources.map(s => s.url ? loadImage(s.url) : Promise.resolve(null)))
  const bad = sources.find((_, i) => !read[i])
  return bad ? `could not read ${bad.label ? `“${bad.label}”` : 'a picture'}` : null
}

type Made = { url: string; w: number; h: number } | { error: string } | { stopped: true }

/** Render one combination and keep it: a file on the desktop, a data: url
 *  in a browser. Checks for a stop between the render and the save, so a
 *  stop never leaves a file on disk that no tile points at. */
async function make(items: ChainItem[], name: string, stopped: () => boolean): Promise<Made> {
  // Stop may have been asked while this waited for another rail's turn.
  if (stopped()) return { stopped: true }
  const why = await unreadable(items)
  if (why) return { error: why }
  const desktop = desktopSaves()
  const r = await runChain(items, desktop ? RUN_SIDE : BROWSER_SIDE, false)
  const out = r.outputs[0]
  // One subject per combination, so one output; drop any stray others.
  for (const o of r.outputs.slice(1)) o.canvas.width = o.canvas.height = 0
  if (!out) return { error: r.error ?? 'nothing came out' }
  const { width: w, height: h } = out.canvas
  if (stopped()) { out.canvas.width = out.canvas.height = 0; return { stopped: true } }
  if (!desktop) {
    const url = out.canvas.toDataURL('image/jpeg', 0.92)
    out.canvas.width = out.canvas.height = 0
    // 'data:,' is what Chromium hands back for a canvas it could not allocate.
    return url.length < 64 ? { error: 'the result came back empty' } : { url, w, h }
  }
  // Rendered for this result alone, so it is released once encoded.
  const s = await saveCanvasImage(out.canvas, 'effect', name, 'jpeg', 0.93, true)
  return s.path ? { url: diskFileUrl(s.path), w, h } : { error: s.error ?? 'could not save the file' }
}

/** Deal a result onto the tray: a plain image tile, appended — so it lands
 *  face-up on the pile. Sized to the rail's card width at its own aspect,
 *  which is the size it keeps if it is later pulled off the rail. False
 *  when the rail is gone. */
function land(railId: string, made: { url: string; w: number; h: number }, label: string): boolean {
  const fs = useFreeNodeStore.getState()
  const rail = fs.nodes[railId]
  if (!isRail(rail)) return false
  const u = rail.rail.unit > 0 ? rail.rail.unit : 1
  const width = RAIL_GEOM.picW * u
  const height = width * (made.h > 0 && made.w > 0 ? made.h / made.w : 0.75)
  const id = fs.addFreeNode(rail.x, rail.y, 'image')
  fs.updateFreeNode(id, { imageUrl: made.url, mediaType: 'image', label, width, height })
  fs.dockToRail([id], { railId, kind: 'column', slotId: RAIL_TRAY, index: Infinity })
  return true
}

/** Run every combination of a rail's columns and deal the results into its
 *  tray. Takes the undo checkpoint itself. A second call while the rail is
 *  running does nothing (stopRail stops it). Never rejects. */
export async function runRail(railId: string): Promise<void> {
  if (active.has(railId)) return
  const store = useRailRunStore.getState()
  const { nodes } = useFreeNodeStore.getState()
  const rail = nodes[railId]
  if (!isRail(rail)) return
  const members = railMembers(nodes).get(railId)
  const total = railComboCount(rail, members)
  if (total === 0) {
    store.setRun(railId, { running: false, done: 0, total: 0, current: 0, made: 0, error: 'Dock pictures under the first column, then run.' })
    return
  }

  if (total > ASK_ABOVE && !window.confirm(
    `Run ${total} results? Each one is a full-size picture, saved as its own file.`)) return

  // The recipe as it is now (see the top of the file). Each combination is
  // built from it as its turn comes, not all up front: a big Run N would
  // otherwise hold every chain in memory before the first render.
  const posters = usePosterMapStore.getState().map
  const railLabel = rail.label || 'Loop strip'
  active.add(railId)
  stopAsked.delete(railId)
  discarded.delete(railId)
  const t0 = performance.now()
  store.setRun(railId, { running: true, done: 0, total, current: 0, currentIds: railComboAt(rail, members, 0, posters)?.sourceIds, made: 0, startedAt: Date.now() })

  const failures: string[] = []
  let made = 0
  let stopped = false
  let gone = false
  let checkpointed = false
  // A card's results so far: they land together once its pictures are done.
  let pending: { card: string; name: string; results: { url: string; w: number; h: number; label: string }[] } | null = null
  /** This run's result cards, in input order: one deck at the end. */
  const runCards: string[] = []
  const flush = (): boolean => {
    const p = pending
    pending = null
    if (!p) return true
    const gid = landResultCard(railId, p.name, unitCardId(p.card), p.results)
    if (gid) runCards.push(gid)
    return !!gid
  }
  const isGone = () => !isRail(useFreeNodeStore.getState().nodes[railId])
  const stopping = () => stopAsked.has(railId) || isGone()
  try {
    for (let i = 0; i < total; i++) {
      if (isGone()) { gone = true; break }
      if (stopping()) { stopped = true; break }
      const combo = railComboAt(rail, members, i, posters)
      useRailRunStore.getState().patchRun(railId, { current: i, currentIds: combo?.sourceIds })
      if (!combo) { failures.push(`combination ${i + 1}: nothing to run`); continue }
      let out: Made
      try {
        out = await exclusive(() => make(combo.items, resultName(`${railLabel} — ${combo.label}`, combo.items), stopping))
      } catch (err) {
        out = { error: String((err as Error)?.message ?? err) }
      }
      if (isGone()) { gone = true; break }
      if ('stopped' in out || discarded.has(railId)) { stopped = true; break }
      if ('error' in out) failures.push(`${combo.label}: ${out.error}`)
      else {
        if (!checkpointed) { useUndoCoordinator.getState().checkpoint(); checkpointed = true }
        const name = resultName(combo.label, combo.items)
        if (combo.subjectCard) {
          if (pending && pending.card !== combo.subjectCard && !flush()) { gone = true; break }
          if (!pending) {
            const input = useBoardsStore.getState().groups.find(g => g.id === unitCardId(combo.subjectCard!))
            pending = { card: combo.subjectCard, name: `${input?.name || 'Card'} — ${railLabel}`, results: [] }
          }
          pending.results.push({ ...out, label: name })
          made++
        } else {
          if (!flush()) { gone = true; break }
          if (land(railId, out, name)) made++
          else { gone = true; break }
        }
      }
      useRailRunStore.getState().patchRun(railId, { done: i + 1, made })
    }
    // The last card's results — also when stopped: what was made is kept.
    if (!gone && !discarded.has(railId) && !flush()) gone = true
    // The run's result cards, one per input card: gathered into one deck
    // where the single result used to land (utils/railCards).
    if (!gone && !discarded.has(railId)) deckRunResults(runCards)
  } catch (err) {
    // Outside any one combination (landing a tile, the store): end the run
    // with the reason rather than leave the arrow spinning.
    failures.push(String((err as Error)?.message ?? err))
  } finally {
    active.delete(railId)
    stopAsked.delete(railId)
    discarded.delete(railId)
    if (gone) {
      // The rail was deleted mid-run: nothing left to report on.
      useRailRunStore.getState().forget(railId)
    } else {
      const error = failures.length === 0 ? undefined
        : `${failures.length} of ${total} failed — ${failures[0]}${failures.length > 1 ? ` (and ${failures.length - 1} more)` : ''}`
      if (failures.length) console.warn('[rail] run failures', failures)
      useRailRunStore.getState().patchRun(railId, {
        running: false, stopping: false, stopped, made, error,
        ms: Math.round(performance.now() - t0),
      })
    }
  }
}
