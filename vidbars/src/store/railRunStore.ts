// railRunStore — the live state of every loop strip's run (utils/fx/railRun)
// and its preview (RailRunHost). Transient, never persisted: a preview is
// recomputed from the rail, and a run in flight does not survive a reload —
// the results it already dealt are ordinary tiles in the tray.

import { create } from 'zustand'

/** Combination 0 rendered at the live working size — "what the run will
 *  make", shown as a ghost card where the next result would land. */
export interface RailPreview {
  /** Null while there is nothing to show (no picture in the subject column,
   *  or the run produced nothing). Never released: mirrors copy from it. */
  canvas: HTMLCanvasElement | null
  /** Why there is no canvas. */
  error?: string
  /** A newer preview is being made; `canvas` is still the previous one. */
  running: boolean
}

export interface RailRunState {
  running: boolean
  /** Combinations finished (a failed one counts — it was attempted). */
  done: number
  total: number
  /** Index of the combination in flight (railComboAt). */
  current: number
  /** The pictures of the combination in flight, subject first — what
   *  railComboAt(current).sourceIds was when the run began, kept here so the
   *  highlight stays right even if the columns change mid-run. */
  currentIds?: string[]
  /** Results that landed in the tray. */
  made?: number
  /** Stop was asked; the combination in flight finishes first. */
  stopping?: boolean
  /** The run ended because it was stopped, not because it was done. */
  stopped?: boolean
  /** A summary of what failed ('2 of 9 failed — Harbour × Paper: …'). */
  error?: string
  /** Wall-clock start (Date.now()) and, once finished, how long it took. */
  startedAt?: number
  ms?: number
}

interface RailRunStore {
  preview: Record<string, RailPreview>
  run: Record<string, RailRunState>
  /** Merge into a rail's preview. */
  setPreview: (railId: string, patch: Partial<RailPreview>) => void
  /** Start a rail's run state afresh. */
  setRun: (railId: string, state: RailRunState) => void
  /** Merge into a rail's run state (ignored when it has none). */
  patchRun: (railId: string, patch: Partial<RailRunState>) => void
  /** Drop everything about a rail that is gone. */
  forget: (railId: string) => void
}

export const useRailRunStore = create<RailRunStore>(set => ({
  preview: {},
  run: {},
  setPreview: (railId, patch) => set(s => {
    const prev = s.preview[railId] ?? { canvas: null, running: false }
    const next = { ...prev, ...patch }
    if (next.canvas === prev.canvas && next.error === prev.error && next.running === prev.running) return s
    return { preview: { ...s.preview, [railId]: next } }
  }),
  setRun: (railId, state) => set(s => ({ run: { ...s.run, [railId]: state } })),
  patchRun: (railId, patch) => set(s => s.run[railId] ? { run: { ...s.run, [railId]: { ...s.run[railId], ...patch } } } : s),
  forget: railId => set(s => {
    if (!s.preview[railId] && !s.run[railId]) return s
    const preview = { ...s.preview }
    const run = { ...s.run }
    delete preview[railId]
    delete run[railId]
    return { preview, run }
  }),
}))
