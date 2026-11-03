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

import React, { useState } from 'react'
import type { FreeNodeData } from '../../store/freeNodeStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useFxStore } from '../../store/fxStore'
import { useAuxStore } from '../../utils/fx/aiEffects'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { EFFECTS, EFFECT_ORDER, effectKindOf, effectParams, type EffectKind, type ParamDef } from '../../utils/fx/effects'
import { soloedElsewhere, toggleEffectOff, toggleEffectSolo } from '../../utils/fx/effectToggles'
import { startEffectDragOut } from '../../utils/fx/effectDragOut'

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

/** The name picker's extra entry: not an effect, an action. */
const RESET_ALL = '__reset_all'

/** Slider rows and the name sit above the tile's edge-resize strips (z 19
 *  in FreeNode) — on a 5:7 card those strips would otherwise eat the ends
 *  of every row, where the lowest and highest values are. The corner grip
 *  (z 20, later in the DOM) still wins its own square, so the card stays
 *  resizable. */
const CONTROL_Z = 20

/** The on/off and solo buttons: small round chips at the card's scale. */
const toggleStyle = (u: number, bg: string, fg: string): React.CSSProperties => ({
  width: 8 * u, height: 8 * u, padding: 0, borderRadius: '50%', border: `${0.4 * u}px solid rgba(255,255,255,0.3)`,
  background: bg, color: fg, fontSize: 5 * u, fontWeight: 700, lineHeight: 1, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit',
})

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
/** A Segment card's rows for what it found (aiEffects subjects): each
 *  thing's scale — measured ("Auto") or fixed — and how partly it is in
 *  view (tools_scale/scale.py's VIEW: only part of it shows, so it is this
 *  many times bigger). Kept on the card as `scale:<name>` / `view:<name>`. */
function subjectRows(found: Record<string, number>): ParamDef[] {
  return Object.entries(found).flatMap(([name, measured]) => [
    {
      key: `scale:${name}`, label: `${name}: scale`, min: 0, max: 1, step: 0.05, default: 0,
      names: [`Auto ${measured.toFixed(2)}`, ...Array.from({ length: 20 }, (_, i) => ((i + 1) * 0.05).toFixed(2))],
    },
    { key: `view:${name}`, label: `${name}: partly in view`, min: 1, max: 3, step: 0.05, default: 1 },
  ])
}

function formatValue(p: ParamDef, v: number): string {
  if (p.names) return p.names[Math.round((v - p.min) / p.step)] ?? String(v)
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
  /** Where the live values are read from, when the face is not a tile's —
   *  an effect CARD (utils/effectCards) keeps them on its card. */
  read?: () => { kind: EffectKind; stored: Record<string, number> | undefined; text?: string; off?: boolean; solo?: boolean } | null
}> = ({ node, id, updateFreeNode, read }) => {
  const kind = effectKindOf(node)
  const def = EFFECTS[kind]
  const params = effectParams(kind, node.effect?.params)
  const stripKey = useFxStore(s => s.byNode[id])
  const strip = useFxStore(s => (stripKey ? s.strips[stripKey] : undefined))
  /** "Computing depth…", or why a model / tool result is missing. */
  const auxNote = useAuxStore(s => s.byStep[id] ?? '')
  /** A Segment card: what it found and how big each is on screen. */
  const found = useAuxStore(s => (kind === 'segment' ? s.subjects[id] : undefined))
  const rows: ParamDef[] = found ? [...def.params, ...subjectRows(found)] : def.params
  const valueOf = (p: ParamDef) => params[p.key] ?? node.effect?.params?.[p.key] ?? p.default
  /** The row being dragged — lit while the pointer holds it. */
  const [dragKey, setDragKey] = useState<string | null>(null)
  /** Keyboard focus on the (invisible) effect picker — underlines the name. */
  const [kindFocus, setKindFocus] = useState(false)
  /** The row under the pointer — shows its ↺ when the value is off default. */
  const [hoverKey, setHoverKey] = useState<string | null>(null)

  // Edits read the node fresh: a slider drag writes many times between two
  // renders, and a stale closure would drop whatever landed in between.
  const paramsNow = () => {
    if (read) return read()
    const n = useFreeNodeStore.getState().nodes[id]
    return n ? { kind: effectKindOf(n), stored: n.effect?.params, text: n.effect?.text, off: n.effect?.off, solo: n.effect?.solo } : null
  }
  /** The switches ride along with every edit (effectToggles). */
  const flags = (cur: { off?: boolean; solo?: boolean }) => ({ off: cur.off, solo: cur.solo })
  const setParam = (key: string, v: number) => {
    const cur = paramsNow()
    // Skip no-op writes: the pointer moving inside one step would otherwise
    // republish the strip (its items carry the params) on every frame.
    if (!cur || effectParams(cur.kind, cur.stored)[key] === v) return
    updateFreeNode(id, { effect: { kind: cur.kind, params: { ...cur.stored, [key]: v }, text: cur.text, ...flags(cur) } })
  }
  // Reset drops the override rather than writing the default, so the value
  // follows the effect's default if that is ever retuned. One undo step,
  // and none at all when there is nothing to reset.
  const resetParam = (key: string) => {
    const cur = paramsNow()
    if (!cur?.stored || !(key in cur.stored)) return
    checkpoint()
    const rest = { ...cur.stored }
    delete rest[key]
    updateFreeNode(id, { effect: { kind: cur.kind, params: rest, text: cur.text, ...flags(cur) } })
  }
  /** Every value back to the effect's default, as one undo step. */
  const resetAll = () => {
    const cur = paramsNow()
    if (!cur?.stored || Object.keys(cur.stored).length === 0) return
    checkpoint()
    updateFreeNode(id, { effect: { kind: cur.kind, params: {}, text: cur.text, ...flags(cur) } })
  }
  /** Segment's phrases. Typed locally and written on leaving the box:
   *  every write re-runs the strip, and a model run per keystroke would
   *  queue up behind each other. */
  const storedPhrases = node.effect?.text ?? ''
  const [phrases, setPhrases] = useState(storedPhrases)
  // An undo or another view changing the stored text replaces what is typed.
  const [seenPhrases, setSeenPhrases] = useState(storedPhrases)
  if (seenPhrases !== storedPhrases) { setSeenPhrases(storedPhrases); setPhrases(storedPhrases) }
  const commitPhrases = () => {
    const cur = paramsNow()
    if (!cur || (cur.text ?? '') === phrases) return
    checkpoint()
    updateFreeNode(id, { effect: { kind: cur.kind, params: cur.stored ?? {}, text: phrases, ...flags(cur) } })
  }
  /** Anything moved off its default — what Reset all would undo. */
  const anyChanged = def.params.some(p => params[p.key] !== p.default)
  const setKind = (k: EffectKind) => {
    if ((k as string) === RESET_ALL) { resetAll(); return }
    checkpoint()
    const cur = paramsNow()
    updateFreeNode(id, { effect: { kind: k, params: {}, ...(cur ? flags(cur) : {}) }, label: EFFECTS[k].label })
  }

  // u = 1% of the card's width, in canvas units (= CSS px: world space).
  const u = Math.min(node.width / 100, node.height / FACE_HEIGHT_U)
  const shadow = `0 ${0.4 * u}px ${1.2 * u}px rgba(0,0,0,0.75)`
  // Up to five sliders sit at full size under the art. More (the film
  // looks' dials) and the rows close up and the art gives way, so every
  // one fits the card as it comes, with nothing to scroll or resize.
  const n = rows.length
  const rowH = n > 5 ? Math.max(7, (96 - (n - 1)) / n) : 14
  const rowGap = n > 5 ? 1 : 2
  const rowFont = n > 5 ? Math.min(8.5, rowH * 0.74) : 8.5

  // A strip with no picture processes nothing, which reads the same as no
  // strip at all — so it gets the same hint, and its "no picture" error
  // would only repeat it. Not on a loop strip (utils/rail): there the card
  // takes its pictures from the strip's columns, and is never pushed.
  const hasPicture = !!strip?.items.some(it => it.kind === 'source')
  // Switched off, or muted by another effect's solo: the card dims.
  const off = !!node.effect?.off
  const solo = !!node.effect?.solo
  // Read on every render the strip or the rail changes; cheap.
  useFxStore(s => s.strips)
  useFreeNodeStore(s => s.nodes)
  const muted = !solo && soloedElsewhere(id)
  const hint = hasPicture || node.railDock ? null : 'Push against a picture'
  const error = hasPicture ? strip?.result?.error ?? null : null

  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
      padding: 4 * u, overflow: 'hidden', lineHeight: 1.2,
      background: mixIntoGround(def.color, 0.16), color: '#fff',
      position: 'relative',
    }}>
      {/* ── On/off and solo, top-LEFT of the card (an effect card's own
              pen and drag-out grip hold its top-right). Off: skipped in its
              chain; solo: the only effect its chain runs (one per chain) —
              and switched off while soloed, nothing runs. The face dims
              when this effect is not running. ── */}
      {(off || muted) && (
        <div style={{ position: 'absolute', inset: 0, zIndex: CONTROL_Z - 1, background: 'rgba(10,11,18,0.55)', pointerEvents: 'none' }} />
      )}
      <div style={{ position: 'absolute', zIndex: CONTROL_Z + 1, top: 1.5 * u, left: 1.5 * u, display: 'flex', gap: 1.2 * u }}>
        <button
          type="button" data-fx-onoff={off ? 'off' : 'on'}
          title={off ? 'Switched off — click to switch on' : 'Switch this effect off'}
          onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}
          onDoubleClick={stop}
          onClick={e => { e.stopPropagation(); toggleEffectOff(id) }}
          style={toggleStyle(u, off ? 'rgba(255,255,255,0.12)' : 'rgba(120,220,140,0.85)', off ? 'rgba(255,255,255,0.55)' : '#0b1a10')}
        >⏻</button>
        <button
          type="button" data-fx-solo={solo ? 'on' : 'off'}
          title={solo ? 'Soloed — click to clear' : 'Solo: only this effect runs'}
          onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}
          onDoubleClick={stop}
          onClick={e => { e.stopPropagation(); toggleEffectSolo(id) }}
          style={toggleStyle(u, solo ? 'rgba(255,205,80,0.95)' : 'rgba(255,255,255,0.12)', solo ? '#1a1404' : 'rgba(255,255,255,0.7)')}
        >S</button>
        {/* ↑: drag out a copy — into a row, under an effect as its
            input, onto another strip or a card (utils/fx/effectDragOut). */}
        <button
          type="button" data-fx-drag-out
          title="Drag out a copy of this effect — into a row, under an effect as its input, onto another strip or a card"
          onPointerDown={e => startEffectDragOut(e, id)}
          onClick={stop}
          onDoubleClick={stop}
          style={{ ...toggleStyle(u, 'rgba(0,0,0,0.45)', 'rgba(255,255,255,0.8)'), cursor: 'grab' }}
        >
          {/* The picture cards' drag-out arrow (DragOutGrip). */}
          <svg width={6 * u} height={6 * u} viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }}>
            <path d="M12 15V3" />
            <path d="M7 8l5-5 5 5" />
            <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
          </svg>
        </button>
      </div>
      {/* ── Art: the glyph on a flat tint. Static on purpose — the result
              is on the picture. Takes whatever height the rows leave. ── */}
      <div style={{
        flex: '1 1 0', minHeight: (n > 5 ? 6 : 16) * u, position: 'relative', overflow: 'hidden',
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
            it is being hovered. Just right of the on/off, solo and ↑ buttons.
            CONTROL_Z lifts the marks over the nw resize corner the way it
            lifts the rows. */}
        {(strip?.running || error) && (
          <div style={{ position: 'absolute', zIndex: CONTROL_Z, top: 1.5 * u, left: 26 * u, display: 'flex', gap: 1.5 * u, fontSize: 7 * u, lineHeight: 1 }}>
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
          {/* An action, not an effect: picking it resets every value and
              leaves the effect as it was. Here rather than on the face, so
              the face never grows or shrinks a row. */}
          <option disabled value="">──────────</option>
          <option value={RESET_ALL} disabled={!anyChanged}>↺  Reset all settings</option>
        </select>
      </div>
      {def.blend && (
        <div style={{
          fontSize: 5.5 * u, opacity: 0.7, textAlign: 'center', marginTop: 0.5 * u, flex: '0 0 auto',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textShadow: shadow,
        }}>Mixes in the next picture</div>
      )}
      {def.needs && auxNote && (
        <div title={auxNote} style={{
          fontSize: 5.5 * u, opacity: 0.75, textAlign: 'center', marginTop: 0.5 * u, flex: '0 0 auto',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textShadow: shadow,
        }}>{auxNote}</div>
      )}

      {/* ── Values: each row IS its slider. The fill shows the value; press
              anywhere to jump there and drag to follow; double-click for the
              default (the faint tick); arrow keys step it. ── */}
      <div style={{ marginTop: (n > 5 ? 2 : 3) * u, flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: rowGap * u }}>
        {rows.map(p => {
          const v = valueOf(p)
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
              title={`${p.label}: drag to set · Alt+click or ↺ to reset to ${formatValue(p, p.default)} (the tick)`}
              onPointerEnter={() => setHoverKey(p.key)}
              onPointerLeave={() => setHoverKey(k => (k === p.key ? null : k))}
              onPointerDown={e => {
                // Other buttons fall through: a middle-drag over a row still
                // pans the canvas, as it does anywhere else on the tile.
                if (e.button !== 0) return
                e.stopPropagation()
                // Alt+click resets it, and only that: the press never moves
                // the value first, so the reset is the one undo step.
                if (e.altKey) { e.preventDefault(); resetParam(p.key); return }
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
              // Not a reset: the first click of a double-click has already
              // moved the value. Only kept from reaching the tile.
              onDoubleClick={stop}
              onKeyDown={e => {
                const cur = paramsNow()
                if (!cur) return
                const was = effectParams(cur.kind, cur.stored)[p.key] ?? cur.stored?.[p.key] ?? p.default
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
                height: rowH * u, borderRadius: Math.min(3.5, rowH / 4) * u, overflow: 'hidden',
                background: 'rgba(0,0,0,0.32)',
                // An outline, not an inset shadow: the fill would paint over
                // a shadow. Unset, the keyboard focus ring shows instead.
                ...(dragKey === p.key ? { outline: `${0.5 * u}px solid ${def.color}`, outlineOffset: -0.5 * u } : null),
                display: 'flex', alignItems: 'center', padding: `0 ${3.5 * u}px`,
                fontSize: rowFont * u, textShadow: shadow,
                cursor: 'ew-resize', touchAction: 'none',
              }}
            >
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${frac * 100}%`, background: `${def.color}8c`, pointerEvents: 'none' }} />
              {/* The default: a faint tick, so where "reset" goes is always
                  in sight. */}
              <div style={{ position: 'absolute', top: '18%', bottom: '18%', left: `${defFrac * 100}%`, width: 0.6 * u, marginLeft: -0.3 * u, background: 'rgba(255,255,255,0.42)', borderRadius: 0.3 * u, pointerEvents: 'none' }} />
              <span style={{ position: 'relative', flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.92 }}>{p.label}</span>
              <span style={{ position: 'relative', flex: '0 0 auto', marginLeft: 2 * u, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatValue(p, v)}</span>
              {/* ↺ in a slot that is always there, so showing it on hover
                  moves nothing. Only when the value is off its default.
                  Its own press: the slider underneath never sees it. */}
              {(() => {
                const show = hoverKey === p.key && v !== p.default
                return (
                  <span
                    data-effect-reset={p.key}
                    role="button"
                    aria-label={`Reset ${p.label}`}
                    title={`Reset to ${formatValue(p, p.default)}`}
                    onPointerDown={e => {
                      if (e.button !== 0) return
                      e.stopPropagation(); e.preventDefault()
                      if (show) resetParam(p.key)
                    }}
                    onDoubleClick={stop}
                    style={{
                      position: 'relative', flex: '0 0 auto', width: 7 * u, marginLeft: 1.5 * u, marginRight: -1.5 * u,
                      textAlign: 'center', fontSize: rowFont * u, lineHeight: 1, fontWeight: 700,
                      opacity: show ? 0.9 : 0, cursor: show ? 'pointer' : 'ew-resize',
                      pointerEvents: show ? 'auto' : 'none', transition: 'opacity 120ms',
                    }}
                  >↺</span>
                )
              })()}
            </div>
          )
        })}
      </div>
      {kind === 'segment' && (
        <textarea
          value={phrases}
          placeholder={'One thing per line:\nperson\nhat: hat, cap'}
          title="What to find, one per line — name: phrase, phrase. Applied when you click away (or Ctrl+Enter)."
          spellCheck={false}
          onChange={e => setPhrases(e.target.value)}
          onBlur={commitPhrases}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitPhrases() }
          }}
          onPointerDown={e => e.stopPropagation()}
          onDoubleClick={stop}
          style={{
            position: 'relative', zIndex: CONTROL_Z, marginTop: 3 * u, flex: '1 1 auto', minHeight: 24 * u,
            resize: 'none', boxSizing: 'border-box', width: '100%',
            background: 'rgba(0,0,0,0.32)', color: 'inherit', border: 'none', borderRadius: 3.5 * u,
            padding: `${2.5 * u}px ${3.5 * u}px`, fontSize: 8 * u, fontFamily: 'inherit', lineHeight: 1.3, outline: 'none',
          }}
        />
      )}
    </div>
  )
}
