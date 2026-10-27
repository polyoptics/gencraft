// RailRunArrow — the big arrow across the top of a loop strip. It is the
// Run control AND the progress bar ("a graphic that goes across when we run
// it"): idle it says how many results a run would make, running it fills
// from left to right with a marker riding the fill's end, and the arrowhead
// turns into Stop.
//
// Only the arrowhead and its label are a button. The rest of the band is the
// rail like any other part of it: pressing it moves the rail (FreeNode's own
// drag), which is why nothing else here stops the pointer.
//
// Sizes are in the rail's unit `u`, so the arrow scales with the rail.

import React, { useRef, useState } from 'react'
import type { RailRunState } from '../../../store/railRunStore'
import { isRailRunning, runRail, stopRail } from '../../../utils/fx/railRun'
import { RAIL_COLORS as C, pressButton, railShadow, stop, stopPrimary } from './railStyle'

/** A second click this soon after Run is the other half of a double-click,
 *  not a request to stop the run the first half just started. */
const DOUBLE_MS = 450

export const RailRunArrow: React.FC<{
  railId: string
  /** The arrow band in the rail's own (local) coordinates. */
  rect: { left: number; top: number; width: number; height: number }
  u: number
  /** The status line's smallest type, in the rail's own px: it carries
   *  errors, and must not shrink away with the zoom. */
  minFont: number
  /** The rail's name, shown at the band's left. */
  label: string
  /** Results a run would make now. */
  count: number
  run: RailRunState | undefined
  /** Why the live preview has nothing to show, if it failed. */
  previewError?: string
  /** The combination in flight, as the equation it is ('Harbour × Paper'). */
  currentLabel?: string | null
}> = ({ railId, rect, u, minFont, label, count, run, previewError, currentLabel }) => {
  const [hot, setHot] = useState(false)
  const startedAt = useRef(0)

  const W = rect.width
  const barY = 4 * u, barH = 22 * u, midY = barY + barH / 2
  const headW = 30 * u, headHalf = 15 * u
  const labelW = Math.min(150 * u, W * 0.3)
  const x0 = labelW + 8 * u
  const x1 = Math.max(x0 + 20 * u, W - headW)
  const shadow = railShadow(u)

  const running = !!run?.running
  const total = run?.total ?? 0
  const frac = running && total > 0 ? Math.min(1, Math.max(0, (run?.done ?? 0) / total)) : 0
  const fillX = x0 + (x1 - x0) * frac
  /** Something to run, or a run to stop. */
  const live = running || count > 0
  const headFill = !live ? C.orangeDim : hot || running ? C.orangeHi : C.orange

  // The line under the arrow: what the run is making, what went wrong, or
  // how the last run went.
  let status: { text: string; tone: 'error' | 'dim' } | null = null
  if (running) {
    if (currentLabel) status = { text: currentLabel, tone: 'dim' }
  } else if (run?.error) {
    status = { text: run.error, tone: 'error' }
  } else if (count > 0 && previewError) {
    status = { text: previewError, tone: 'error' }
  } else if (run && run.total > 0) {
    const made = run.made ?? run.done
    const secs = run.ms != null ? ` in ${(run.ms / 1000).toFixed(1)} s` : ''
    status = {
      text: run.stopped ? `Stopped — ${made} of ${run.total} made` : `Made ${made} result${made === 1 ? '' : 's'}${secs}`,
      tone: 'dim',
    }
  }

  const onRun = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Whether or not the run is still going: one that ended inside the
    // double-click would otherwise be started again by its second half.
    if (performance.now() - startedAt.current < DOUBLE_MS) return
    if (isRailRunning(railId)) {
      stopRail(railId)
    } else if (count > 0) {
      startedAt.current = performance.now()
      // runRail takes the undo checkpoint itself: one step for the run.
      void runRail(railId)
    }
  }

  return (
    <div data-rail-arrow style={{ position: 'absolute', left: rect.left, top: rect.top, width: W, height: rect.height }}>
      <svg width={W} height={rect.height} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        {/* The bar: solid orange when there is something to run, a dark
            track for the fill to grow along while running, dim with
            nothing to do. Its right end tucks under the head. */}
        <rect x={x0} y={barY} width={x1 - x0 + 2 * u} height={barH} rx={Math.min(5 * u, barH / 2)}
              fill={running ? C.orangeTrack : live ? C.orange : C.orangeDim} />
        {running && frac > 0 && (
          <rect x={x0} y={barY} width={Math.max(0, fillX - x0) + (frac >= 1 ? 2 * u : 0)} height={barH}
                rx={Math.min(5 * u, barH / 2)} fill={C.orange} />
        )}
        <path d={`M ${x1} ${midY - headHalf} L ${W} ${midY} L ${x1} ${midY + headHalf} Z`} fill={headFill} />
        {running && (
          <>
            {/* The marker riding the fill's end. */}
            <rect data-rail-progress={frac.toFixed(3)} x={fillX - 1.5 * u} y={barY - 3 * u} width={3 * u} height={barH + 6 * u}
                  rx={1.5 * u} fill="#fff" />
            {/* Stop, in the head. */}
            <rect x={x1 + headW * 0.17} y={midY - 4 * u} width={8 * u} height={8 * u} rx={u} fill="#fff" />
          </>
        )}
      </svg>

      {/* The rail's name, with the loop mark: it runs over everything docked. */}
      <div title={label} style={{
        position: 'absolute', left: 0, top: barY, width: labelW, height: barH,
        display: 'flex', alignItems: 'center', gap: 4 * u, overflow: 'hidden',
        fontSize: 12 * u, fontWeight: 600, color: 'rgba(255,255,255,0.62)', whiteSpace: 'nowrap',
      }}>
        <span style={{ color: C.orange, fontSize: 14 * u, lineHeight: 1, flex: '0 0 auto' }}>⟳</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{label}</span>
      </div>

      {live ? (
        <button
          type="button"
          data-rail-run={running ? 'running' : 'idle'}
          title={running
            ? 'Stop after the picture being made now'
            : `Run the strip — ${count} result${count === 1 ? '' : 's'}, dealt into the tray`}
          onPointerDown={stopPrimary}
          onMouseDown={pressButton}
          onDoubleClick={stop}
          onClick={onRun}
          onMouseEnter={() => setHot(true)}
          onMouseLeave={() => setHot(false)}
          style={{
            position: 'absolute', right: 0, top: midY - headHalf, height: headHalf * 2,
            display: 'flex', alignItems: 'center',
            padding: `0 ${headW + 5 * u}px 0 ${10 * u}px`,
            background: 'transparent', border: 'none', margin: 0,
            color: '#fff', fontFamily: 'inherit', fontSize: 13 * u, fontWeight: 700, lineHeight: 1,
            whiteSpace: 'nowrap', textShadow: shadow, cursor: 'pointer',
          }}
        >{running
          ? (run?.stopping ? 'Stopping…' : `${Math.min(total, (run?.current ?? 0) + 1)} / ${total}`)
          : `Run ${count}`}</button>
      ) : (
        <div style={{
          position: 'absolute', left: x0, top: barY, width: x1 - x0, height: barH,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11 * u, color: 'rgba(255,255,255,0.8)', textShadow: shadow,
          whiteSpace: 'nowrap', overflow: 'hidden', pointerEvents: 'none',
        }}>Dock pictures under a slot</div>
      )}

      {status && (
        <div
          data-rail-status={status.tone}
          title={status.text}
          style={{
            position: 'absolute', left: x0, right: 0, top: midY + headHalf + u,
            fontSize: Math.max(9.5 * u, minFont), lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            color: status.tone === 'error' ? C.error : 'rgba(255,255,255,0.5)',
          }}
        >{status.text}</div>
      )}
    </div>
  )
}
