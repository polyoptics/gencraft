// EffectTileBody — the face of an effect card, laid out like a playing card:
// a small static art panel (the effect's glyph on its colour), the effect's
// name, then one slider field per adjustable value. The face says WHAT the
// effect is and HOW it is set — never what the picture looks like: the
// processed result shows on the picture the strip starts with
// (FxResultLayer), which is also where Save and the drag-out grip live.
// Showing the image here made every card a thumbnail too small to judge
// and left no room for type you could read.
//
// Everything is sized from the card's OWN width (u = 1% of it), not from
// the camera. The tile is world space, so a bigger card carries bigger
// type, the way a real playing card does, and zooming scales the face as
// one piece instead of re-flowing it.
//
// Controls stop pointer-down from reaching the tile, so dragging a slider
// never drags the card — which also skips the tile's undo checkpoint, so
// each control that edits takes its own. Anywhere else on the face moves
// the card.

import React, { useRef, useState } from 'react'
import type { FreeNodeData } from '../../store/freeNodeStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useFxStore } from '../../store/fxStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { EFFECTS, EFFECT_ORDER, effectKindOf, effectParams, type EffectKind, type ParamDef } from '../../utils/fx/effects'

const stop = (e: React.SyntheticEvent) => e.stopPropagation()
const checkpoint = () => useUndoCoordinator.getState().checkpoint()

/** The ground every face is painted on. Each effect's colour is mixed into
 *  it, so the twelve kinds tell apart at a glance while staying flat and
 *  dark enough for white type. */
const FACE_GROUND = '#15161f'

/** The tallest face (five sliders) in u, art panel at its minimum. A card
 *  squashed by an old free resize — before cards were locked to 5:7 —
 *  takes u from its height instead, so its rows still fit. */
const FACE_HEIGHT_U = 128

/** A second press on the same row within this long, and this close, is the
 *  second half of a double-click (Windows' defaults): it neither jumps the
 *  value nor takes a checkpoint, so the reset that follows undoes in ONE
 *  step, back to before the first press. */
const DOUBLE_MS = 500
const DOUBLE_PX = 4

/** Slider rows and the name sit above the tile's edge-resize strips (z 19
 *  in FreeNode) — on a 5:7 card those strips would otherwise eat the ends
 *  of every row, where the lowest and highest values are. The corner grip
 *  (z 20, later in the DOM) still wins its own square, so the card stays
 *  resizable. */
const CONTROL_Z = 20

/** `hex` mixed into FACE_GROUND by `t` (0..1), as a flat rgb() colour. */
function mixIntoGround(hex: string, t: number): string {
  const a = parseInt(hex.slice(1), 16)
  const b = parseInt(FACE_GROUND.slice(1), 16)
  const ch = (shift: number) => Math.round(((a >> shift) & 0xff) * t + ((b >> shift) & 0xff) * (1 - t))
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`
}

/** Decimals the step itself carries — what a snapped value is rounded to,
 *  so 0.1 + 0.2 never lands as 0.30000000000000004. */
function stepPrecision(step: number): number {
  const s = String(step)
  const dot = s.indexOf('.')
  return dot < 0 ? 0 : s.length - dot - 1
}

/** How a value reads on the face: whole numbers for whole steps, otherwise
 *  as many decimals as the step has, at most two. */
function formatValue(p: ParamDef, v: number): string {
  return v.toFixed(p.step >= 1 ? 0 : Math.min(2, stepPrecision(p.step)))
}

/** `v` on p's step grid, inside its range. */
function snapValue(p: ParamDef, v: number): number {
  const snapped = p.min + Math.round((v - p.min) / p.step) * p.step
  return Number(Math.min(p.max, Math.max(p.min, snapped)).toFixed(stepPrecision(p.step)))
}

/** The value under the pointer: the row's whole width is the range. Read
 *  from the rendered rect, so it is right under any camera — canvas zoom
 *  or a pinned card's frozen scale alike. */
function valueAtPointer(p: ParamDef, el: HTMLElement, clientX: number): number {
  const r = el.getBoundingClientRect()
  const f = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0
  return snapValue(p, p.min + f * (p.max - p.min))
}

export const EffectTileBody: React.FC<{
  node: FreeNodeData
  id: string
  /** Unused: the face scales with the card, not the camera. Optional so
   *  FreeNodeBody may keep passing it or stop. */
  dz?: number
  updateFreeNode: (id: string, patch: Partial<FreeNodeData>) => void
}> = ({ node, id, updateFreeNode }) => {
  const kind = effectKindOf(node)
  const def = EFFECTS[kind]
  const params = effectParams(kind, node.effect?.params)
  const stripKey = useFxStore(s => s.byNode[id])
  const strip = useFxStore(s => (stripKey ? s.strips[stripKey] : undefined))
  /** The row being dragged — lit while the pointer holds it. */
  const [dragKey, setDragKey] = useState<string | null>(null)
  /** Keyboard focus on the (invisible) effect picker — underlines the name. */
  const [kindFocus, setKindFocus] = useState(false)
  const lastPress = useRef<{ key: string; t: number; x: number; y: number; count: number } | null>(null)

  // Edits read the node fresh: a slider drag writes many times between two
  // renders, and a stale closure would drop whatever landed in between.
  const paramsNow = () => {
    const n = useFreeNodeStore.getState().nodes[id]
    return n ? { kind: effectKindOf(n), stored: n.effect?.params } : null
  }
  const setParam = (key: string, v: number) => {
    const cur = paramsNow()
    // Skip no-op writes: the pointer moving inside one step would otherwise
    // republish the strip (its items carry the params) on every frame.
    if (!cur || effectParams(cur.kind, cur.stored)[key] === v) return
    updateFreeNode(id, { effect: { kind: cur.kind, params: { ...cur.stored, [key]: v } } })
  }
  // Reset drops the override rather than writing the default, so the value
  // follows the effect's default if that is ever retuned.
  const resetParam = (key: string) => {
    const cur = paramsNow()
    if (!cur?.stored || !(key in cur.stored)) return
    const rest = { ...cur.stored }
    delete rest[key]
    updateFreeNode(id, { effect: { kind: cur.kind, params: rest } })
  }
  const setKind = (k: EffectKind) => {
    checkpoint()
    updateFreeNode(id, { effect: { kind: k, params: {} }, label: EFFECTS[k].label })
  }

  // u = 1% of the card's width, in canvas units (= CSS px: world space).
  const u = Math.min(node.width / 100, node.height / FACE_HEIGHT_U)
  const shadow = `0 ${0.4 * u}px ${1.2 * u}px rgba(0,0,0,0.75)`

  // A strip with no picture processes nothing, which reads the same as no
  // strip at all — so it gets the same hint, and its "no picture" error
  // would only repeat it.
  const hasPicture = !!strip?.items.some(it => it.kind === 'source')
  const hint = hasPicture ? null : 'Push against a picture'
  const error = hasPicture ? strip?.result?.error ?? null : null

  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
      padding: 4 * u, overflow: 'hidden', lineHeight: 1.2,
      background: mixIntoGround(def.color, 0.16), color: '#fff',
    }}>
      {/* ── Art: the glyph on a flat tint. Static on purpose — the result
              is on the picture. Takes whatever height the rows leave. ── */}
      <div style={{
        flex: '1 1 0', minHeight: 16 * u, position: 'relative', overflow: 'hidden',
        borderRadius: 5 * u, background: mixIntoGround(def.color, 0.3),
        border: `${0.4 * u}px solid rgba(255,255,255,0.07)`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: u,
        // A size container, so the glyph can shrink to the panel (cqh)
        // when five sliders leave it short.
        containerType: 'size',
      }}>
        <div style={{
          fontSize: `min(${30 * u}px, ${hint ? `calc((100cqh - ${8.5 * u}px) * 0.85)` : '85cqh'})`,
          lineHeight: 1, color: def.color, textShadow: shadow,
        }}>{def.glyph}</div>
        {hint && (
          <div style={{
            fontSize: 6 * u, opacity: 0.75, maxWidth: '100%', padding: `0 ${2 * u}px`,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textShadow: shadow,
          }}>{hint}</div>
        )}
        {/* Top-LEFT: a collapsed deck's count badge owns the face's top-right
            corner (FreeNode), and there it covered both marks — the ⚠'s
            tooltip, the only place the strip error reads on the card,
            included. The ⚠ comes first so it holds the corner: "…" blinks
            on and off with every re-run, and would shove it sideways while
            it is being hovered. CONTROL_Z lifts the marks over the nw resize
            corner the way it lifts the rows. */}
        {(strip?.running || error) && (
          <div style={{ position: 'absolute', zIndex: CONTROL_Z, top: 1.5 * u, left: 2.5 * u, display: 'flex', gap: 1.5 * u, fontSize: 7 * u, lineHeight: 1 }}>
            {/* VS15 keeps the warning sign a text glyph, not an emoji. */}
            {error && <span title={error} style={{ color: '#ff9b9b', textShadow: shadow }}>{'⚠︎'}</span>}
            {strip?.running && <span title="Working…" style={{ opacity: 0.7 }}>…</span>}
          </div>
        )}
      </div>

      {/* ── Name: a title that is a native picker. The select is laid
              invisibly over the visible name — a visible select sizes
              itself to its WIDEST option, which would push the name off
              centre, and its popup keeps a fixed readable type size
              instead of scaling with the card. ── */}
      <div
        onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}
        onDoubleClick={stop}
        title="Change the effect"
        style={{
          position: 'relative', zIndex: CONTROL_Z, alignSelf: 'center', maxWidth: '100%',
          marginTop: 3 * u, flex: '0 0 auto', display: 'flex', alignItems: 'baseline', gap: 1.5 * u,
          textDecoration: kindFocus ? 'underline' : undefined,
        }}
      >
        <span style={{
          fontSize: 11 * u, fontWeight: 600, lineHeight: 1.15, textShadow: shadow,
          minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{def.label}</span>
        <span style={{ fontSize: 5.5 * u, opacity: 0.7, flex: '0 0 auto' }}>▾</span>
        <select
          aria-label="Effect"
          value={kind}
          onChange={e => setKind(e.target.value as EffectKind)}
          onFocus={e => setKindFocus(e.currentTarget.matches(':focus-visible'))}
          onBlur={() => setKindFocus(false)}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0,
            cursor: 'pointer', fontSize: 13, colorScheme: 'dark',
          }}
        >
          {EFFECT_ORDER.map(k => <option key={k} value={k}>{EFFECTS[k].glyph}  {EFFECTS[k].label}{EFFECTS[k].blend ? ' (mixes next picture)' : ''}</option>)}
        </select>
      </div>
      {def.blend && (
        <div style={{
          fontSize: 5.5 * u, opacity: 0.7, textAlign: 'center', marginTop: 0.5 * u, flex: '0 0 auto',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textShadow: shadow,
        }}>Mixes in the next picture</div>
      )}

      {/* ── Values: each row IS its slider. The fill shows the value; press
              anywhere to jump there and drag to follow; double-click for the
              default (the faint tick); arrow keys step it. ── */}
      <div style={{ marginTop: 3 * u, flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 2 * u }}>
        {def.params.map(p => {
          const v = params[p.key]
          const span = p.max - p.min
          const frac = span > 0 ? (v - p.min) / span : 0
          const defFrac = span > 0 ? (p.default - p.min) / span : 0
          return (
            <div
              key={p.key}
              role="slider"
              tabIndex={0}
              aria-label={p.label}
              aria-valuemin={p.min}
              aria-valuemax={p.max}
              aria-valuenow={v}
              aria-valuetext={formatValue(p, v)}
              title={`${p.label}: drag to set, double-click for ${formatValue(p, p.default)}`}
              onPointerDown={e => {
                // Other buttons fall through: a middle-drag over a row still
                // pans the canvas, as it does anywhere else on the tile.
                if (e.button !== 0) return
                e.stopPropagation()
                const now = performance.now()
                const prev = lastPress.current
                // Count presses the way the platform does: one close in time
                // and place to the press before continues the run. Only the
                // run's SECOND press belongs to the double-click — dblclick
                // fires on that one alone — so a third press right after a
                // reset starts a fresh drag instead of being swallowed too.
                const count = prev?.key === p.key && now - prev.t < DOUBLE_MS &&
                  Math.abs(e.clientX - prev.x) <= DOUBLE_PX && Math.abs(e.clientY - prev.y) <= DOUBLE_PX
                  ? prev.count + 1 : 1
                lastPress.current = { key: p.key, t: now, x: e.clientX, y: e.clientY, count }
                if (count === 2) return
                // One checkpoint per press, not per tick.
                checkpoint()
                e.currentTarget.setPointerCapture(e.pointerId)
                setDragKey(p.key)
                setParam(p.key, valueAtPointer(p, e.currentTarget, e.clientX))
              }}
              onPointerMove={e => {
                if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
                setParam(p.key, valueAtPointer(p, e.currentTarget, e.clientX))
              }}
              onPointerUp={e => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
              }}
              onLostPointerCapture={() => setDragKey(null)}
              // No checkpoint of its own: the double-click's first press took
              // one before it jumped the value, so a single undo restores
              // the value from before the whole gesture.
              onDoubleClick={e => { e.stopPropagation(); resetParam(p.key) }}
              onKeyDown={e => {
                const cur = paramsNow()
                if (!cur) return
                const was = effectParams(cur.kind, cur.stored)[p.key]
                const by = p.step * (e.shiftKey ? 10 : 1)
                const next =
                  e.key === 'ArrowRight' || e.key === 'ArrowUp' ? was + by
                  : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? was - by
                  : e.key === 'Home' ? p.min
                  : e.key === 'End' ? p.max
                  : null
                if (next === null) return
                e.preventDefault(); e.stopPropagation()
                // One checkpoint per keypress; a held key's repeats ride on it.
                if (!e.repeat) checkpoint()
                setParam(p.key, snapValue(p, next))
              }}
              style={{
                position: 'relative', zIndex: CONTROL_Z, flex: '0 0 auto',
                height: 14 * u, borderRadius: 3.5 * u, overflow: 'hidden',
                background: 'rgba(0,0,0,0.32)',
                // An outline, not an inset shadow: the fill would paint over
                // a shadow. Unset, the keyboard focus ring shows instead.
                ...(dragKey === p.key ? { outline: `${0.5 * u}px solid ${def.color}`, outlineOffset: -0.5 * u } : null),
                display: 'flex', alignItems: 'center', padding: `0 ${3.5 * u}px`,
                fontSize: 8.5 * u, textShadow: shadow,
                cursor: 'ew-resize', touchAction: 'none',
              }}
            >
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${frac * 100}%`, background: `${def.color}8c`, pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', top: '24%', bottom: '24%', left: `${defFrac * 100}%`, width: 0.5 * u, marginLeft: -0.25 * u, background: 'rgba(255,255,255,0.3)', pointerEvents: 'none' }} />
              <span style={{ position: 'relative', flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.92 }}>{p.label}</span>
              <span style={{ position: 'relative', flex: '0 0 auto', marginLeft: 2 * u, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatValue(p, v)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
