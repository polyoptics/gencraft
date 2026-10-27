// RailBody — the face of a LOOP STRIP (utils/rail), drawn inside the rail's
// own tile: the run arrow across the top, a header over every slot, a
// dashed "drop here" card where a column is empty, the "+" that extends the
// rail at either end, and the results tray at its right end.
//
// The rail only draws its furniture. The cards docked on it are ordinary
// tiles, placed by the sync host (useRailSync) and stacked above the rail
// by FreeNode — so a column here is a solitaire cascade of real cards, and
// this face draws the well they sit in and the header they hang from. The
// few marks that must show OVER the cards (where a drag would land, what
// the run is making, the preview of the next result) live in RailOverlay.
//
// Everything is placed from railLayout, in canvas units, made local by
// subtracting the rail's x/y — the tile's box IS the layout's box. Every
// size is in the rail's unit `u` (createScaleFor at creation), so a rail
// made zoomed out is a usable size there, like a playing card.
//
// Controls stop the primary press (railStyle.stopPrimary); empty areas do
// not, so pressing the rail's body, a header's empty end or the arrow band
// outside its button moves the rail with FreeNode's own drag.

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useRailRunStore } from '../../store/railRunStore'
import { useRailUiStore } from '../../store/railUiStore'
import { RAIL_GEOM, RAIL_TRAY, railMembers, type RailColumn, type RailSlot, type Rect } from '../../utils/rail'
import { railComboAt } from '../../utils/fx/railChain'
import { EFFECTS, effectKindOf } from '../../utils/fx/effects'
import { DragOutGrip } from '../UI/DragOutGrip'
import { RailOverlay } from './rail/RailOverlay'
import { RailRunArrow } from './rail/RailRunArrow'
import { RailResizeGrip } from './rail/RailResizeGrip'
import { buildRailView, railNodesOf } from './rail/railView'
import { railOnViewer, touchRail } from '../../utils/railViewer'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { RAIL_COLORS as C, checkpoint, mixHex, pressButton, railShadow, stop, stopPrimary } from './rail/railStyle'

/** VS15 keeps the warning sign a text glyph, not an emoji. */
const WARN = '⚠︎'

/** A rect in the rail's own coordinates (CSS px inside the tile). */
type Local = { left: number; top: number; width: number; height: number }

/** Every result's file in a rail's tray, pile order — for Shift-drag-out. */
function trayUrls(railId: string): string[] {
  const tray = railMembers(useFreeNodeStore.getState().nodes).get(railId)?.get(RAIL_TRAY) ?? []
  return tray.flatMap(n => (n.imageUrl ? [n.imageUrl] : []))
}

/** The smallest a line of information gets on screen, in px: the rail's type
 *  is in its unit, so it shrinks with the zoom until it would vanish. */
const MIN_TEXT_PX = 8

export const RailBody: React.FC<{
  id: string; node: FreeNodeData; hovered: boolean
  /** The zoom the tile is drawn at (its pin's scale when pinned). */
  zoom: number
}> = ({ id, hovered, zoom }) => {
  const list = useFreeNodeStore(useShallow(s => railNodesOf(s.nodes, id)))
  const run = useRailRunStore(s => s.run[id])
  // Docked to a Viewer and the strip it shows? Read live: the Viewer and
  // the other strips move independently of this one.
  const onViewer = useFreeNodeStore(s => {
    const r = s.nodes[id]
    if (!r) return false
    const vw = useViewport3DStore.getState().windows
    return Object.keys(vw).length > 0 && railOnViewer(r, s.nodes, vw, zoom, useRailUiStore.getState().active)
  })
  useRailUiStore(s => s.active[0])
  useViewport3DStore(s => s.windows)
  const preview = useRailRunStore(s => s.preview[id])
  // An empty results tray takes the preview's shape (utils/rail
  // setTrayAspect): a new shape lays the rail out again.
  const previewShape = preview?.canvas && preview.canvas.width > 0 ? preview.canvas.height / preview.canvas.width : 0
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const view = useMemo(() => buildRailView(id, list), [id, list, previewShape])
  // Only drags aimed at THIS rail re-render it.
  const drop = useRailUiStore(s => (s.drop && s.drop.target.railId === id ? s.drop : null))

  // The world layer the tile lives in — where RailOverlay portals to. Found
  // once the face is attached (a stable callback ref: it runs on mount and
  // unmount only); the tile never changes parent while this face lives.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [world, setWorld] = useState<HTMLElement | null>(null)
  const attach = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el
    setWorld(el?.parentElement?.parentElement ?? null)
  }, [])
  // Step back over the tile's border, so local (0, 0) is the tile's outer
  // corner — where railLayout's box starts. Re-measured after every render
  // and written straight to the element: the border follows the zoom, and a
  // stale step-back would shear the face off the cards the sync host placed
  // in canvas units.
  useLayoutEffect(() => {
    const el = rootRef.current, tile = el?.parentElement
    if (!el || !tile) return
    const left = `${-tile.clientLeft}px`, top = `${-tile.clientTop}px`
    if (el.style.left !== left) el.style.left = left
    if (el.style.top !== top) el.style.top = top
  })

  const running = !!run?.running
  const runCurrent = run?.current
  const runIds = run?.currentIds
  // What the run is making now: its pictures (the run's own record of them
  // first — it read the combinations when Run was pressed) and the equation
  // they make, for the line under the arrow.
  const busy = useMemo(() => {
    if (!running || !view) return null
    let combo: ReturnType<typeof railComboAt> = null
    try { combo = runCurrent != null ? railComboAt(view.rail, view.members, runCurrent) : null } catch { combo = null }
    const ids = runIds ?? combo?.sourceIds ?? null
    if (!ids) return null
    if (combo && combo.sourceIds.join('\n') === ids.join('\n')) return { ids, label: combo.label }
    // The columns changed since Run: name the pictures the run really uses.
    const byId = new Map(list.map(n => [n.id, n]))
    return { ids, label: ids.map(i => byId.get(i)?.label || 'picture').join(' · ') }
  }, [running, view, runCurrent, runIds, list])

  if (!view) return null
  const { rail, layout: L, members, warnings, roles } = view
  const u = L.unit
  const loc = (r: Rect): Local => ({ left: r.x - rail.x, top: r.y - rail.y, width: r.width, height: r.height })
  /** A rect grown by `d` on every side. */
  const grow = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d })
  const bodyOf = (c: RailColumn): Rect => ({ x: c.x, y: c.bodyTop, width: c.width, height: c.bodyBottom - c.bodyTop })

  const slots = rail.rail?.slots ?? []
  const dropSlot = drop?.target.kind === 'column' ? drop.target.slotId : null
  const busySlots = new Map<string, 'subject' | 'partner'>()
  busy?.ids.forEach((bid, k) => {
    const col = L.columns.find(c => c.cards.some(b => b.id === bid))
    if (col && !busySlots.has(col.slotId)) busySlots.set(col.slotId, k === 0 ? 'subject' : 'partner')
  })

  /** What a role column is to the run, for its name's tooltip. */
  const roleNote = (slotId: string): string => {
    if (warnings[slotId]) return warnings[slotId]
    if (roles.subject === slotId) return 'The subject — every result starts from one of these pictures'
    const cardSlot = roles.partners[slotId]
    const card = cardSlot ? members?.get(cardSlot)?.[0] : undefined
    if (card) {
      const d = EFFECTS[effectKindOf(card)]
      return `Mixed in by the ${d.glyph} ${d.label} card before it`
    }
    return 'A column of pictures'
  }
  /** A new column's name: what it most likely holds. One added after a
   *  blend card is what that card mixes in. */
  const newColumnName = (at: 'start' | 'end'): string => {
    const last = slots[slots.length - 1]
    const card = at === 'end' && last?.kind === 'card' ? members?.get(last.id)?.[0] : undefined
    return card && EFFECTS[effectKindOf(card)].blend ? 'Texture' : 'Pictures'
  }

  const trayCards = members?.get(RAIL_TRAY) ?? []
  const lastResult = trayCards[trayCards.length - 1]
  const ghost = !running && view.count > 0 && preview?.canvas
    ? { canvas: preview.canvas, stale: preview.running }
    : null
  const rowTop = L.tray.head.y - rail.y
  const pad = RAIL_GEOM.pad * u
  // Shown on a Viewer (utils/railViewer): a quiet accent round the strip.
  const shown = onViewer

  return (
    <div
      ref={attach}
      data-rail-body={id}
      data-rail-on-viewer={shown ? 'true' : undefined}
      // Any press inside makes this the active strip a Viewer shows.
      onPointerDownCapture={() => touchRail(id)}
      style={{
        // left/top: set by the layout effect above (the tile's border).
        position: 'absolute', width: L.box.width, height: L.box.height,
        background: C.ground, borderRadius: 14 * u,
        // Inset, not a border: a border would move every child by its width.
        boxShadow: shown
          ? `inset 0 0 0 ${1.5 * u}px rgba(143,211,255,0.55), 0 0 ${10 * u}px rgba(143,211,255,0.18)`
          : `inset 0 0 0 ${1.5 * u}px ${C.edge}`,
        color: '#fff', userSelect: 'none', lineHeight: 1.2,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* ── The rail proper: the band every header hangs on. ── */}
      <div style={{
        position: 'absolute', left: pad / 2, right: pad / 2, top: rowTop - 4 * u,
        height: (RAIL_GEOM.headH + 8) * u, background: C.track, borderRadius: 10 * u,
      }} />

      {/* ── Column wells, behind the cards. A well lights while a drag
              would land in it, or while the run is taking its pictures. ── */}
      {L.columns.map(col => {
        if (col.kind === 'card') {
          const warn = !!warnings[col.slotId]
          return (
            <div key={col.slotId} style={{
              position: 'absolute', ...loc(grow(bodyOf(col), 4 * u)), borderRadius: 12 * u,
              background: 'rgba(255,255,255,0.03)',
              border: `${u}px solid ${warn ? 'rgba(242,184,75,0.55)' : 'rgba(255,255,255,0.08)'}`,
            }} />
          )
        }
        const busyAs = busySlots.get(col.slotId)
        const border = dropSlot === col.slotId ? `${2 * u}px solid ${C.drop}`
          : busyAs === 'subject' ? `${2 * u}px solid ${C.orangeHi}`
          : busyAs === 'partner' ? `${1.5 * u}px solid ${C.orange}`
          : `${u}px solid rgba(255,255,255,0.05)`
        return (
          <div key={col.slotId} data-rail-well={col.slotId} data-rail-busy-col={busyAs} style={{
            position: 'absolute', ...loc(grow(bodyOf(col), 4 * u)), borderRadius: 12 * u,
            background: 'rgba(255,255,255,0.025)', border,
          }} />
        )
      })}

      {/* ── Empty columns: a card-shaped outline to drop onto. ── */}
      {L.columns.map(col => col.kind === 'role' && col.empty && (
        <div key={col.slotId} data-rail-empty={col.slotId} style={{
          position: 'absolute', ...loc(bodyOf(col)), borderRadius: 10 * u,
          border: `${1.5 * u}px dashed ${dropSlot === col.slotId ? C.drop : 'rgba(255,255,255,0.22)'}`,
          background: dropSlot === col.slotId ? 'rgba(143,211,255,0.08)' : 'transparent',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 5 * u, padding: 10 * u, textAlign: 'center',
          fontSize: 11 * u, color: 'rgba(255,255,255,0.5)',
        }}>
          <span>Drop pictures here</span>
          {warnings[col.slotId] && (
            <span style={{ fontSize: Math.max(9 * u, MIN_TEXT_PX / zoom), lineHeight: 1.3, color: C.amber }}>{warnings[col.slotId]}</span>
          )}
        </div>
      ))}
      {L.tray.empty && !ghost && (
        <div style={{
          position: 'absolute', ...loc(bodyOf(L.tray)), borderRadius: 10 * u,
          border: `${1.5 * u}px dashed rgba(216,90,48,0.35)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 10 * u, textAlign: 'center',
          fontSize: 11 * u, color: 'rgba(255,255,255,0.42)',
        }}>Results land here</div>
      )}

      {/* ── Headers. ── */}
      {L.columns.map(col => {
        if (col.kind === 'card') {
          const card = members?.get(col.slotId)?.[0]
          return card
            ? <CardHead key={col.slotId} card={card} rect={loc(col.head)} u={u} warning={warnings[col.slotId]} />
            : null
        }
        return col.slot && (
          <RoleHead
            key={col.slotId}
            railId={id}
            slot={col.slot}
            rect={loc(col.head)}
            u={u}
            count={col.cards.length}
            warning={warnings[col.slotId]}
            note={roleNote(col.slotId)}
          />
        )
      })}
      <TrayHead
        railId={id}
        rect={loc(L.tray.head)}
        u={u}
        count={trayCards.length}
        lastUrl={lastResult?.imageUrl ?? null}
        hovered={hovered}
      />

      {/* ── Extend the rail at either end. ── */}
      <PlusButton railId={id} at="start" rect={loc(L.plusStart)} u={u} hovered={hovered} name={newColumnName('start')} />
      <PlusButton railId={id} at="end" rect={loc(L.plusEnd)} u={u} hovered={hovered} name={newColumnName('end')} />

      {/* ── Into the tray: the recipe's output flows right. ── */}
      <svg
        width={12 * u} height={22 * u}
        style={{
          position: 'absolute', pointerEvents: 'none', opacity: 0.6,
          left: (L.plusEnd.x + L.plusEnd.width + L.tray.x) / 2 - rail.x - 5 * u,
          top: L.plusEnd.y + L.plusEnd.height / 2 - rail.y - 11 * u,
        }}
      >
        <path d={`M ${1.5 * u} ${1.5 * u} L ${10 * u} ${11 * u} L ${1.5 * u} ${20.5 * u}`}
              fill="none" stroke={C.orange} strokeWidth={2.5 * u} strokeLinecap="round" strokeLinejoin="round" />
      </svg>

      <RailRunArrow
        railId={id}
        rect={loc(L.arrow)}
        u={u}
        minFont={MIN_TEXT_PX / zoom}
        label={rail.label || 'Loop strip'}
        count={view.count}
        run={run}
        previewError={preview?.error}
        currentLabel={busy?.label ?? null}
      />

      <RailResizeGrip railId={id} width={L.box.width} height={L.box.height} u={u} hovered={hovered} />
      {/* The results tray scales on its own: judge the results big while
          the inputs stay as they are. */}
      <RailResizeGrip
        railId={id} scales="tray" u={u} hovered={hovered}
        width={L.tray.width} height={L.tray.bodyBottom - L.tray.bodyTop}
        at={{ left: L.tray.x + L.tray.width - rail.x + 4 * u, top: L.tray.bodyBottom - rail.y + 4 * u }}
      />

      {world && (
        <RailOverlay
          host={world}
          railId={id}
          layout={L}
          slots={slots}
          drop={drop}
          busyIds={busy?.ids ?? null}
          ghost={ghost}
        />
      )}
    </div>
  )
}

// ── Headers ─────────────────────────────────────────────────────────────

/** A header chip's shared box. */
const chip = (rect: Local, u: number, background: string): React.CSSProperties => ({
  position: 'absolute', ...rect, boxSizing: 'border-box',
  display: 'flex', alignItems: 'center', gap: 4 * u, padding: `0 ${6 * u}px`,
  background, borderRadius: 8 * u, overflow: 'hidden', whiteSpace: 'nowrap',
})

/** A small round count. */
const Badge: React.FC<{ u: number; title?: string; children: React.ReactNode }> = ({ u, title, children }) => (
  <span title={title} style={{
    flex: '0 0 auto', minWidth: 17 * u, height: 17 * u, padding: `0 ${4 * u}px`, boxSizing: 'border-box',
    borderRadius: 8.5 * u, background: 'rgba(255,255,255,0.12)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 10 * u, fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums',
    color: 'rgba(255,255,255,0.8)',
  }}>{children}</span>
)

/** A role column's header: its name (double-click to rename), each / pick
 *  one, how many cards it holds — or an × to remove it while it is empty —
 *  and a warning when the run passes it by. */
const RoleHead: React.FC<{
  railId: string
  slot: RailSlot
  rect: Local
  u: number
  count: number
  warning?: string
  /** What the column is to the run (tooltip). */
  note: string
}> = ({ railId, slot, rect, u, count, warning, note }) => {
  const [draft, setDraft] = useState<string | null>(null)
  /** Enter, Escape and the blur that follows them each end the edit; only
   *  the first may commit, or a rename would take two undo steps. */
  const settled = useRef(true)
  const name = slot.name || 'Pictures'
  const mode = slot.mode === 'pick' ? 'pick' : 'each'
  const shadow = railShadow(u)

  const finish = (save: boolean) => {
    if (settled.current) return
    settled.current = true
    const v = draft?.trim()
    setDraft(null)
    if (save && v && v !== name) {
      checkpoint()
      useFreeNodeStore.getState().setRailSlot(railId, slot.id, { name: v })
    }
  }

  return (
    <div data-rail-head={slot.id} style={{
      ...chip(rect, u, C.head),
      boxShadow: warning ? `inset 0 ${-2 * u}px 0 ${C.amber}` : `inset 0 0 0 ${u}px rgba(255,255,255,0.05)`,
    }}>
      {draft !== null ? (
        <input
          data-rail-rename
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onFocus={e => e.currentTarget.select()}
          onBlur={() => finish(true)}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.key === 'Enter') finish(true)
            else if (e.key === 'Escape') finish(false)
          }}
          onPointerDown={stop}
          onDoubleClick={stop}
          style={{
            flex: '1 1 auto', minWidth: 0, height: 20 * u, padding: `0 ${2 * u}px`, margin: 0,
            background: 'rgba(255,255,255,0.08)', color: '#fff', border: 'none',
            borderBottom: `${u}px solid rgba(255,255,255,0.4)`, borderRadius: 0, outline: 'none',
            fontFamily: 'inherit', fontSize: 13 * u, fontWeight: 600,
          }}
        />
      ) : (
        <>
          <span
            data-rail-name
            title={`${note}\nDouble-click to rename`}
            onPointerDown={stopPrimary}
            onMouseDown={stopPrimary}
            onDoubleClick={e => { e.stopPropagation(); settled.current = false; setDraft(name) }}
            style={{
              flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
              fontSize: 13 * u, fontWeight: 600, textShadow: shadow, cursor: 'default',
            }}
          >{name}</span>
          {/* The header's empty middle moves the rail like its body does. */}
          <span style={{ flex: '1 1 0', alignSelf: 'stretch' }} />
        </>
      )}

      <button
        type="button"
        data-rail-mode={mode}
        title={mode === 'each'
          ? 'Each: the run takes every card in this column.\nClick for pick one.'
          : 'Pick one: the run takes only the face-up card — the bottom one.\nDrag another card to the bottom to switch. Click for each.'}
        onPointerDown={stopPrimary}
        onMouseDown={pressButton}
        onDoubleClick={stop}
        onClick={e => {
          e.stopPropagation()
          checkpoint()
          useFreeNodeStore.getState().setRailSlot(railId, slot.id, { mode: mode === 'each' ? 'pick' : 'each' })
        }}
        style={{
          flex: '0 0 auto', height: 17 * u, padding: `0 ${5 * u}px`, margin: 0, borderRadius: 8.5 * u,
          border: `${u}px solid ${mode === 'pick' ? C.orange : 'rgba(255,255,255,0.2)'}`,
          background: mode === 'pick' ? 'rgba(216,90,48,0.22)' : 'rgba(255,255,255,0.1)',
          color: '#fff', fontFamily: 'inherit', fontSize: 9 * u, fontWeight: 600, lineHeight: 1,
          cursor: 'pointer',
        }}
      >{mode === 'each' ? 'each' : 'pick one'}</button>

      {count > 0 ? (
        <Badge u={u} title={`${count} card${count === 1 ? '' : 's'} — the run takes ${mode === 'each' ? (count === 1 ? 'it' : 'every one') : 'the face-up one'}`}>{count}</Badge>
      ) : (
        <button
          type="button"
          data-rail-remove={slot.id}
          title="Remove this empty column"
          onPointerDown={stopPrimary}
          onMouseDown={pressButton}
          onDoubleClick={stop}
          onClick={e => {
            e.stopPropagation()
            checkpoint()
            useFreeNodeStore.getState().removeRailSlot(railId, slot.id)
          }}
          style={{
            flex: '0 0 auto', width: 17 * u, height: 17 * u, padding: 0, margin: 0, borderRadius: 8.5 * u,
            border: 'none', background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)',
            fontFamily: 'inherit', fontSize: 13 * u, lineHeight: 1, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}
        >×</button>
      )}

      {warning && (
        <span data-rail-warning title={warning} style={{ flex: '0 0 auto', color: C.amber, fontSize: 12 * u, lineHeight: 1 }}>{WARN}</span>
      )}
    </div>
  )
}

/** A card slot's label band: the operator, as a calculator key reads — a
 *  blend card's glyph big (× multiply, + screen, ◧ overlay), any other
 *  effect's glyph beside its name. Not a control: pressing it moves the rail. */
const CardHead: React.FC<{ card: FreeNodeData; rect: Local; u: number; warning?: string }> = ({ card, rect, u, warning }) => {
  const def = EFFECTS[effectKindOf(card)]
  return (
    <div
      data-rail-card-head={def.kind}
      title={warning ?? (def.blend ? `${def.glyph} ${def.label} — mixes in the column right after it` : def.label)}
      style={{
        ...chip(rect, u, mixHex(def.color, C.ground, 0.24)),
        justifyContent: 'center', gap: 5 * u,
        boxShadow: warning ? `inset 0 ${-2 * u}px 0 ${C.amber}` : `inset 0 0 0 ${u}px rgba(255,255,255,0.06)`,
      }}
    >
      <span style={{
        flex: '0 0 auto', color: def.color, lineHeight: 1, textShadow: railShadow(u),
        fontSize: (def.blend ? 22 : 15) * u, fontWeight: def.blend ? 700 : 400,
      }}>{def.glyph}</span>
      <span style={{
        minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        fontSize: 11 * u, fontWeight: 600, textShadow: railShadow(u),
      }}>{def.label}</span>
      {warning && <span style={{ flex: '0 0 auto', color: C.amber, fontSize: 12 * u, lineHeight: 1 }}>{WARN}</span>}
    </div>
  )
}

/** The tray's header: "Results", how many, a drag-out grip for the face-up
 *  result (Shift: all of them), and Clear. */
const TrayHead: React.FC<{
  railId: string
  rect: Local
  u: number
  count: number
  lastUrl: string | null
  hovered: boolean
}> = ({ railId, rect, u, count, lastUrl, hovered }) => (
  <div data-rail-tray-head style={{
    ...chip(rect, u, mixHex(C.orange, C.ground, 0.18)),
    boxShadow: `inset 0 0 0 ${u}px rgba(216,90,48,0.3)`,
  }}>
    <span style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 13 * u, fontWeight: 600, textShadow: railShadow(u) }}>Results</span>
    <Badge u={u}>{count}</Badge>
    <span style={{ flex: '1 1 0', alignSelf: 'stretch' }} />
    <DragOutGrip
      url={lastUrl}
      getUrls={({ all }) => (all ? trayUrls(railId) : [])}
      allLabel="every result in the tray"
      size={16 * u}
      visible={hovered}
    />
    {count > 0 && (
      <button
        type="button"
        data-rail-clear
        title="Set the results down on the canvas, below the strip"
        onPointerDown={stopPrimary}
        onMouseDown={pressButton}
        onDoubleClick={stop}
        onClick={e => {
          e.stopPropagation()
          checkpoint()
          useFreeNodeStore.getState().clearRailTray(railId)
        }}
        style={{
          flex: '0 0 auto', height: 18 * u, padding: `0 ${6 * u}px`, margin: 0, borderRadius: 5 * u,
          border: `${u}px solid rgba(255,255,255,0.2)`, background: 'transparent',
          color: 'rgba(255,255,255,0.78)', fontFamily: 'inherit', fontSize: 10 * u, fontWeight: 600, lineHeight: 1,
          cursor: 'pointer',
        }}
      >Take off</button>
    )}
  </div>
)

/** "+" at either end of the slot row: a new, empty role column there. */
const PlusButton: React.FC<{
  railId: string
  at: 'start' | 'end'
  rect: Local
  u: number
  hovered: boolean
  /** The new column's name. */
  name: string
}> = ({ railId, at, rect, u, hovered, name }) => (
  <button
    type="button"
    data-rail-plus={at}
    title={at === 'start'
      ? 'Add a column at the start — the first column is the subject'
      : 'Add a column at the end — after a ×, + or overlay card it is what that card mixes in'}
    onPointerDown={stopPrimary}
    onMouseDown={pressButton}
    onDoubleClick={stop}
    onClick={e => {
      e.stopPropagation()
      checkpoint()
      useFreeNodeStore.getState().addRailRole(railId, at, name)
    }}
    style={{
      position: 'absolute', ...rect, boxSizing: 'border-box', padding: 0, margin: 0,
      border: `${1.2 * u}px dashed rgba(255,255,255,${hovered ? 0.3 : 0.15})`, borderRadius: 8 * u,
      background: 'transparent', color: `rgba(255,255,255,${hovered ? 0.75 : 0.4})`,
      fontFamily: 'inherit', fontSize: 20 * u, lineHeight: 1, cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'color 120ms, border-color 120ms',
    }}
  >+</button>
)
