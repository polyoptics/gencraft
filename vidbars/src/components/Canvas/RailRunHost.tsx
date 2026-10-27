// RailRunHost — keeps every loop strip's live preview: combination 0 (the
// first picture of each column the run reads, or a 'pick' column's face-up
// card) rendered at the live working size, so the rail can show "this is
// what the run will make" where the next result would land.
//
// Only combination 0, never all of them: the preview is a look, the run is
// the work. Re-rendered (debounced) only when what combination 0 would
// compute changes — its pictures, its cards, their order, their sliders —
// which is the JSON of its chain items. Dragging the rail, dealing results
// into the tray or docking a card further down an 'each' column changes
// none of that, so none of it re-runs anything.
//
// Subscribes to the stores directly and renders nothing (mounted once in
// App, like RailSyncHost): it reacts to every tile change, and as a
// subscriber in a component body that would re-render on each drag frame.

import { useEffect } from 'react'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useRailRunStore } from '../../store/railRunStore'
import { usePosterMapStore } from '../../three/posterService'
import { isRail, railMembers } from '../../utils/rail'
import { runChain, type ChainResult } from '../../utils/fx/chain'
import { FX_REF_SIDE } from '../../utils/fx/effects'
import { railComboAt, railFaceCombo } from '../../utils/fx/railChain'
import { useBoardsStore } from '../../store/boardsStore'
import { isRailRunning, unreadable } from '../../utils/fx/railRun'

/** Quiet time after the last change before the preview re-renders — a
 *  slider drag renders once it rests, not on every tick. */
const DEBOUNCE_MS = 120
/** A preview that failed is tried again a few times, further apart each
 *  time: the cause can pass (a GPU reset, a file briefly unavailable), and
 *  nothing else re-runs it until the recipe changes. */
const RETRY_MS = 4000
const RETRIES = 3

export function RailRunHost(): null {
  useEffect(() => {
    let dead = false
    const sigs = new Map<string, string>()
    const timers = new Map<string, number>()
    const tokens = new Map<string, number>()
    /** The recipe whose preview last failed, and how often in a row. */
    const failed = new Map<string, { sig: string; n: number }>()
    const store = () => useRailRunStore.getState()

    const check = () => {
      const { nodes } = useFreeNodeStore.getState()
      const posters = usePosterMapStore.getState().map
      const members = railMembers(nodes)
      const seen = new Set<string>()
      for (const rail of Object.values(nodes)) {
        if (!isRail(rail)) continue
        const railId = rail.id
        seen.add(railId)
        // What the face-up card shows: step it and the preview follows.
        const combo = railComboAt(rail, members.get(railId), railFaceCombo(rail, members.get(railId)), posters)
        const sig = combo ? JSON.stringify(combo.items) : ''
        if (sigs.get(railId) === sig) continue
        sigs.set(railId, sig)
        window.clearTimeout(timers.get(railId))
        timers.delete(railId)
        // Whatever is in flight was for the old recipe: drop it on landing.
        const token = (tokens.get(railId) ?? 0) + 1
        tokens.set(railId, token)
        if (!combo) {
          store().setPreview(railId, { canvas: null, error: undefined, running: false })
          continue
        }
        timers.set(railId, window.setTimeout(() => {
          timers.delete(railId)
          // The old canvas stays up until the new one lands — no blank flash.
          store().setPreview(railId, { running: true })
          const noResult = (error: string): ChainResult => ({
            outputs: [], stepPreviews: new Map(), ignored: [], unreadable: [], error,
          })
          // The run's own check first: runChain passes a partner it cannot
          // read, and the ghost would show a result the run then refuses.
          void unreadable(combo.items)
            .then(why => why ? noResult(why) : runChain(combo.items, FX_REF_SIDE, false))
            // A run that throws is a result too, or `running` never clears.
            .catch(err => noResult(String((err as Error)?.message ?? err)))
            .then(r => {
              if (dead || tokens.get(railId) !== token) return
              const out = r.outputs[0]
              store().setPreview(railId, {
                canvas: out?.canvas ?? null,
                error: out ? undefined : r.error ?? 'Nothing came out',
                running: false,
              })
              if (out) { failed.delete(railId); return }
              const f = failed.get(railId)
              const n = f?.sig === sig ? f.n + 1 : 1
              if (n > RETRIES) return
              failed.set(railId, { sig, n })
              window.setTimeout(() => {
                if (dead || tokens.get(railId) !== token) return
                sigs.delete(railId)
                check()
              }, RETRY_MS * n)
            })
        }, DEBOUNCE_MS))
      }
      // Rails that are gone: no timer left behind, nothing kept for them.
      for (const railId of [...sigs.keys()]) {
        if (seen.has(railId)) continue
        sigs.delete(railId)
        window.clearTimeout(timers.get(railId))
        timers.delete(railId)
        // Bumped, not deleted: an undo brings a rail back under the SAME
        // id, and a restarted count could match a run still in flight.
        tokens.set(railId, (tokens.get(railId) ?? 0) + 1)
        failed.delete(railId)
        // A run still going reports to its state when it ends (and forgets
        // it then, if the rail is still gone): an undo may bring the rail
        // back while its last combination is rendering.
        if (!isRailRunning(railId)) store().forget(railId)
      }
    }

    check()
    const offNodes = useFreeNodeStore.subscribe((s, prev) => { if (s.nodes !== prev.nodes) check() })
    // A video's poster can land after its tile was docked.
    const offPosters = usePosterMapStore.subscribe((s, prev) => { if (s.map !== prev.map) check() })
    // A docked card's face is the card's: stepped, the preview follows.
    const offCards = useBoardsStore.subscribe((s, prev) => { if (s.groups !== prev.groups) check() })
    return () => {
      dead = true
      offNodes()
      offPosters()
      offCards()
      for (const t of timers.values()) window.clearTimeout(t)
    }
  }, [])
  return null
}
