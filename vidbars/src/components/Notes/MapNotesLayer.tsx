// MapNotesLayer — the notes on a 3D set's map (utils/mapNotes; Brian
// 2026-11-15): marks and pins drawn on the set in the flat view, the
// set's own. Drawn in the overlay stage with the pieces, each set's notes
// in one box laid on the set from the canvas's origin (as a piece is:
// folding into its card, the set takes the box along, utils/area3dCard),
// so tipped into 3D they lie on its ground.
//
// The bar (while a set is being annotated) is the Viewer's Annotate row:
// the same tools, colours and size, and a Pin. It sits at the top of the
// canvas, in one place, whatever is in the hand.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { useFreeNodeStore, type FreeNodeData, type MapPin } from '../../store/freeNodeStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { PAINT_TOOLS, PAINT_COLORS, ERASE_ICON, StrokeSvg, tbBtn } from '../Viewport3D/ImageStudio'
import { useMapNotesUi, annotateSet, clearSetNotes, setPinText, pinScale, PIN_DOT, type MapTool } from '../../utils/mapNotes'
import { snapshotSetMap, lightInk } from '../../utils/mapSnapshot'

const PIN_ICON = <><circle cx="8" cy="5.5" r="3.2" /><path d="M8 8.7V14" /></>
const TOOLS: { id: MapTool; icon: React.ReactNode; tip: string }[] = [
  ...PAINT_TOOLS.map(t => ({ ...t, tip: t.tip.replace('paint freehand', 'draw freehand') })),
  { id: 'pin', icon: PIN_ICON, tip: 'Pin: click the set to pin a note there and type its words. Drag a pin to move it; click it to change its words.' },
  { id: 'erase', icon: ERASE_ICON, tip: 'Erase: click or drag over a mark or a pin to remove it' },
]

/** A pin's words, being typed. */
const PinWords: React.FC<{ areaId: string; pin: MapPin }> = ({ areaId, pin }) => {
  const title = useRef<HTMLInputElement>(null)
  const desc = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    useUndoCoordinator.getState().checkpoint()
    title.current?.focus()
    title.current?.select()
  }, [])
  // The note grows with its words.
  useLayoutEffect(() => {
    const el = desc.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.max(30, el.scrollHeight)}px`
  }, [pin.desc])
  const field: React.CSSProperties = {
    display: 'block', width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.06)', color: '#fff',
    border: '1px solid rgba(255,255,255,0.14)', borderRadius: 3, outline: 'none', font: '11px system-ui, sans-serif', padding: '3px 5px',
  }
  const keys = (e: React.KeyboardEvent) => {
    // (Escape is the tool's: it closes the words. Everything else is typing.)
    if (e.key !== 'Escape') e.stopPropagation()
  }
  return (
    <div data-map-pin-edit="" onPointerDown={e => e.stopPropagation()} onKeyDown={keys} onKeyUp={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}
      style={{ width: 190, display: 'flex', flexDirection: 'column', gap: 3, padding: 4 }}>
      <input ref={title} value={pin.title} placeholder="Title" spellCheck={false}
        onChange={e => setPinText(areaId, pin.id, { title: e.target.value })}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); desc.current?.focus() } }}
        style={{ ...field, fontWeight: 600 }} />
      <textarea ref={desc} value={pin.desc} placeholder="Note" spellCheck={false} rows={2}
        onChange={e => setPinText(areaId, pin.id, { desc: e.target.value })}
        style={{ ...field, resize: 'none', overflow: 'hidden', lineHeight: '14px' }} />
    </div>
  )
}

const Pin: React.FC<{ areaId: string; pin: MapPin; n: number; x: number; y: number; zoom: number; live: boolean; editing: boolean }> = React.memo(({ areaId, pin, n, x, y, zoom, live, editing }) => {
  const s = pinScale(zoom)
  const R = PIN_DOT / 2
  const words = !!pin.title || !!pin.desc
  return (
    <div data-map-pin={pin.id} style={{ position: 'absolute', left: x * zoom, top: y * zoom, width: 0, height: 0, transform: `scale(${s})`, transformOrigin: '0 0', pointerEvents: 'none', zIndex: editing ? 2 : 1 }}>
      <div data-map-pin-dot="" style={{
        position: 'absolute', left: -R, top: -R, width: PIN_DOT, height: PIN_DOT, borderRadius: '50%', boxSizing: 'border-box',
        background: pin.color, border: '1.5px solid rgba(12,13,22,0.9)', color: lightInk(pin.color) ? '#12131f' : '#fff',
        font: '700 10px system-ui, sans-serif', lineHeight: `${PIN_DOT - 3}px`, textAlign: 'center', userSelect: 'none',
        boxShadow: '0 1px 3px rgba(0,0,0,0.6)', pointerEvents: live ? 'auto' : 'none', cursor: live ? 'pointer' : undefined,
      }}>{n}</div>
      {(words || editing) && (
        <div data-map-pin-words="" style={{
          position: 'absolute', left: R + 4, top: -R, width: 'max-content', maxWidth: 212, boxSizing: 'border-box',
          background: 'rgba(19,20,31,0.92)', border: `1px solid ${pin.color}99`, borderRadius: 5,
          boxShadow: '0 2px 8px rgba(0,0,0,0.45)', pointerEvents: live ? 'auto' : 'none', cursor: live && !editing ? 'pointer' : undefined,
        }}>
          {editing ? <PinWords areaId={areaId} pin={pin} /> : (
            <div style={{ padding: '2px 6px 3px', font: '11px system-ui, sans-serif', lineHeight: '14px', userSelect: 'none' }}>
              {pin.title && <div style={{ color: '#fff', fontWeight: 600, overflowWrap: 'anywhere' }}>{pin.title}</div>}
              {pin.desc && <div style={{ color: 'rgba(235,240,255,0.8)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{pin.desc}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

const SetNotes: React.FC<{ a: FreeNodeData; zoom: number }> = ({ a, zoom }) => {
  const live = useMapNotesUi(s => s.area === a.id)
  const draft = useMapNotesUi(s => s.area === a.id ? s.draft : null)
  const held = useMapNotesUi(s => s.area === a.id ? s.held : null)
  const editing = useMapNotesUi(s => s.area === a.id ? s.editing : null)
  const notes = a.mapNotes
  const marks = notes?.marks ?? [], pins = notes?.pins ?? []
  const order = [...pins].sort((p, q) => p.n0 - q.n0)
  return (
    <div data-map-notes={a.id} data-piece-set={a.id} style={{ position: 'absolute', left: a.x * zoom, top: a.y * zoom, width: a.width * zoom, height: a.height * zoom, pointerEvents: 'none' }}>
      <svg width="100%" height="100%" viewBox={`0 0 ${a.width} ${a.height}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}>
        {marks.map(m => <StrokeSvg key={m.id} st={m} />)}
        {draft && <StrokeSvg st={draft} />}
      </svg>
      {order.map((p, i) => {
        const at = held && held.id === p.id ? held : p
        return <Pin key={p.id} areaId={a.id} pin={p} n={i + 1} x={at.x} y={at.y} zoom={zoom} live={live} editing={editing === p.id} />
      })}
    </div>
  )
}

/** Where the canvas is on the screen: the bar sits at its top. */
function canvasBox(): { left: number; top: number; width: number } | null {
  const r = document.querySelector('[data-tilt-stage="world"]')?.parentElement?.getBoundingClientRect()
  if (!r) return null
  // (Under the top bar's icons, which hang over the canvas.)
  const icons = document.querySelector('[data-top-icon-bar]')?.getBoundingClientRect()
  return { left: r.left, width: r.width, top: Math.max(r.top + 10, icons ? icons.bottom + 8 : 0) }
}

const Bar: React.FC<{ id: string }> = ({ id }) => {
  const name = useFreeNodeStore(s => s.nodes[id]?.label ?? '3D set')
  const any = useFreeNodeStore(s => { const n = s.nodes[id]?.mapNotes; return !!n && (n.marks.length > 0 || n.pins.length > 0) })
  const tool = useMapNotesUi(s => s.tool)
  const color = useMapNotesUi(s => s.color)
  const size = useMapNotesUi(s => s.size)
  const fill = useMapNotesUi(s => s.fill)
  const [box, setBox] = useState(canvasBox)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const fit = () => setBox(canvasBox())
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  if (!box) return null
  const icon = (d: React.ReactNode) => (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>{d}</svg>
  )
  return ReactDOM.createPortal(
    <div data-map-notes-bar="" onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onWheel={e => e.stopPropagation()} style={{
      position: 'fixed', left: box.left + box.width / 2, top: box.top, transform: 'translateX(-50%)', zIndex: 9000,
      display: 'flex', alignItems: 'center', gap: 5, height: 32, boxSizing: 'border-box', whiteSpace: 'nowrap', padding: '0 10px',
      background: 'rgba(20,22,38,0.97)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8,
      boxShadow: '0 8px 28px rgba(0,0,0,0.5)', fontFamily: 'system-ui, sans-serif', userSelect: 'none',
    }}>
      <span title={`Notes on ${name}: drawn on the set, they go where it goes and fold away with it`}
        style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', width: 110, overflow: 'hidden', textOverflow: 'ellipsis' }}>Notes · {name}</span>
      <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
        {TOOLS.map(t => (
          <button key={t.id} data-map-tool={t.id} style={{ ...tbBtn(tool === t.id), padding: '3px 4px' }} aria-pressed={tool === t.id} title={t.tip}
            onClick={() => useMapNotesUi.setState({ tool: t.id })}>{icon(t.icon)}</button>
        ))}
        <button data-map-fill="" style={{ ...tbBtn(fill), padding: '3px 4px' }} aria-pressed={fill} onClick={() => useMapNotesUi.setState({ fill: !fill })}
          title="Fill: on or off. On, rectangles and ellipses are solid colour.">
          <svg width={14} height={14} viewBox="0 0 16 16" style={{ display: 'block' }}><rect x="3" y="3" width="10" height="10" rx="2" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.6} /></svg>
        </button>
      </div>
      <div style={{ display: 'flex', gap: 3, alignItems: 'center', marginLeft: 4 }}>
        {PAINT_COLORS.map(c => (
          <div key={c} data-map-color={c} onClick={() => useMapNotesUi.setState({ color: c })} title={c} style={{
            width: 13, height: 13, borderRadius: '50%', background: c, cursor: 'pointer', boxSizing: 'border-box',
            border: color === c ? '2px solid rgba(140,190,255,0.9)' : '1px solid rgba(0,0,0,0.4)',
          }} />
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <button style={tbBtn(false)} title="Thinner" onClick={() => useMapNotesUi.setState({ size: Math.max(2, size - 2) })}>−</button>
        <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.75)', width: 16, textAlign: 'center' }}>{size}</span>
        <button style={tbBtn(false)} title="Thicker" onClick={() => useMapNotesUi.setState({ size: Math.min(40, size + 2) })}>+</button>
      </div>
      <div style={{ display: 'flex', gap: 4, marginLeft: 6 }}>
        <button data-map-clear="" style={{ ...tbBtn(false), opacity: any ? 1 : 0.4 }} disabled={!any} onClick={() => clearSetNotes(id)}
          title="Remove every mark and pin on this set (Ctrl+Z brings them back)">Clear</button>
        <button data-map-snapshot="" style={{ ...tbBtn(false), opacity: busy ? 0.4 : 1 }} disabled={busy}
          onClick={() => { setBusy(true); void snapshotSetMap(id).finally(() => setBusy(false)) }}
          title="Snapshot: the set's map with its notes, as a new picture card beside the set">Snapshot</button>
        <button data-map-done="" style={tbBtn(true)} onClick={() => annotateSet(null)} title="Done: put the notes tools away (Esc)">Done</button>
      </div>
    </div>,
    document.body,
  )
}

export const MapNotesLayer: React.FC = () => {
  const nodes = useFreeNodeStore(s => s.nodes)
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const area = useMapNotesUi(s => s.area)
  const sets = Object.values(nodes).filter(a => a.type === 'area' && !a.pin && (a.id === area || (!!a.mapNotes && !a.mapNotes.off && (a.mapNotes.marks.length > 0 || a.mapNotes.pins.length > 0))))
  return (
    <>
      {sets.length > 0 && (
        // (At the pieces' level and drawn after them: over them, as a
        // note is over what it is about.)
        <div data-map-notes-layer="" style={{ position: 'absolute', left: pan.x, top: pan.y, width: 0, height: 0, zIndex: 55, pointerEvents: 'none' }}>
          {sets.map(a => <SetNotes key={a.id} a={a} zoom={zoom} />)}
        </div>
      )}
      {area && nodes[area] && (
        <>
          <style>{`[data-freenode][data-id="${area}"], [data-freenode][data-id="${area}"] *, [data-piece-set="${area}"] [data-piece-hit] { cursor: crosshair !important; }`}</style>
          <Bar id={area} />
        </>
      )}
    </>
  )
}
