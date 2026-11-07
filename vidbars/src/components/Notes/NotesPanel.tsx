// NotesPanel — the 3D notes and drawing tools (Brian 2026-11-07), in a
// panel locked to the SCREEN at the right edge: not on a card, not in the
// 3D space, it stays put while the canvas moves under it, flat or tilted.
// Opened from the top bar's Notes button; its fold button folds it to an
// icon strip (anchored at the right, so the fold button never moves).
//
// Every tool is its own on/off button, lit while in the hand (picking one
// puts the others down: the mouse holds one tool). The arrowheads are two
// independent toggles. The outliner lists the Areas and what lies on each:
// drag a row onto an Area to put it there, onto "Canvas" to take it off.

import React, { useMemo, useRef, useState } from 'react'
import { useNotesStore, useNotesUi, toggleTool, NOTE_COLORS, type NotesTool } from '../../store/notesStore'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { usePlacing, togglePlacing } from '../../utils/placeTool'
import { areaAt } from '../../utils/areaFollow'
import { curveBounds, curvePoints } from '../../utils/curveGeom'
import { useCurveDraft } from '../../utils/notesTool'

const S = 'rgba(228,234,255,0.92)'
const W_OPEN = 252, W_FOLDED = 52

type Ic = React.FC<{ size?: number; color?: string }>
const svg = (size: number) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const })
const IcCurve: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M4 18C6 8 12 5 20 6" stroke={S} /><circle cx="4" cy="18" r="1.8" fill="#4fc3ff" stroke="none" /><circle cx="20" cy="6" r="1.8" fill="#4fc3ff" stroke="none" /><path d="M10 10.5l3.6-3.4" stroke="#4fc3ff" strokeWidth="1.4" /></svg>
)
const IcSelect: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M6 3.5l11.5 9-5.2.9 3 5.6-2.4 1.3-3-5.6-3.9 3.6z" stroke={S} strokeWidth="1.6" /></svg>
)
const IcSmooth: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M3 16c3-9 6-9 9-4s6 5 9-4" stroke={S} /><circle cx="3" cy="16" r="1.8" fill="#4fc3ff" stroke="none" /><circle cx="12" cy="12" r="1.8" fill="#4fc3ff" stroke="none" /><circle cx="21" cy="8" r="1.8" fill="#4fc3ff" stroke="none" /></svg>
)
const IcPen: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M4 20c3-1 4-4 6-4s2 3 5 2 4-5 5-7" stroke="#ff8fd1" /><path d="M14.5 4.5l3 3L10 15l-3.6.6.6-3.6z" stroke={S} strokeWidth="1.6" /></svg>
)
const IcPin: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><circle cx="8" cy="16" r="2.4" fill="#ffb23f" stroke="none" /><path d="M9.6 14.4L14 10" stroke={S} strokeWidth="1.4" /><rect x="13" y="4" width="8" height="6" rx="1" stroke={S} strokeWidth="1.6" /></svg>
)
const IcArea: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><rect x="3" y="5" width="18" height="14" rx="2" stroke={S} /><path d="M9 5v14M15 5v14M3 12h18" stroke="#5fe39b" strokeWidth="1.2" /></svg>
)
const IcArrowStart: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M5 12h15" stroke={S} /><path d="M10 7l-5 5 5 5" stroke="#4fc3ff" /></svg>
)
const IcArrowEnd: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M4 12h15" stroke={S} /><path d="M14 7l5 5-5 5" stroke="#4fc3ff" /></svg>
)
const IcFold: React.FC<{ folded: boolean }> = ({ folded }) => (
  <svg {...svg(16)}><path d={folded ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} stroke={S} /></svg>
)

const btnStyle = (on: boolean, wide = false): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', justifyContent: wide ? 'flex-start' : 'center', gap: 8,
  height: 36, width: wide ? '100%' : 36, padding: wide ? '0 10px' : 0, boxSizing: 'border-box',
  background: on ? 'rgba(120,170,255,0.22)' : 'rgba(255,255,255,0.035)',
  border: `1px solid ${on ? 'rgba(120,170,255,0.55)' : 'rgba(255,255,255,0.08)'}`,
  borderRadius: 9, cursor: 'pointer', color: on ? '#eef4ff' : 'rgba(255,255,255,0.72)', fontSize: 12, flexShrink: 0,
})

const TOOLS: { id: NotesTool; Icon: Ic; name: string; tip: string }[] = [
  { id: 'curve', Icon: IcCurve, name: 'Curve', tip: 'Curve: click for corners, click-drag for smooth points. Double-click, Enter or Esc finishes; click the first point to close it. Works flat and in 3D.' },
  { id: 'pen', Icon: IcPen, name: 'Pen', tip: 'Pen: freehand. Over a model in 3D it draws on the model’s surface; anywhere else on the canvas.' },
  { id: 'pin', Icon: IcPin, name: 'Pin', tip: 'Pin: click a model in 3D to pin a note on it. Each pin gets a Note card, and the model gets an Annotation card.' },
]

const SMOOTH_TIP = 'Smooth: on or off. On, a curve runs smoothly through its points by itself, no handles to set; drag the points to reshape it. Also sets the selected curves.'

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div style={{ fontSize: 10, letterSpacing: 1.3, color: 'rgba(255,255,255,0.4)', fontFamily: 'ui-monospace, monospace' }}>{title}</div>
    {children}
  </div>
)

// ── Outliner ──
type Item = { kind: 'node' | 'card' | 'viewer' | 'curve'; id: string; name: string; icon: string; cx: number; cy: number }

function useOutline() {
  const nodes = useFreeNodeStore(s => s.nodes)
  const groups = useBoardsStore(s => s.groups)
  const windows = useViewport3DStore(s => s.windows)
  const curves = useNotesStore(s => s.curves)
  return useMemo(() => {
    const areas = Object.values(nodes).filter(n => n.type === 'area' && !n.pin)
    const kids = new Map<string, Item[]>()
    const root: Item[] = []
    const put = (it: Item, not?: string) => {
      const a = areaAt(nodes, it.cx, it.cy, not)
      if (a) { if (!kids.has(a.id)) kids.set(a.id, []); kids.get(a.id)!.push(it) }
      else if (it.kind === 'node' || it.kind === 'curve') root.push(it)
    }
    const icon = (n: FreeNodeData) => n.type === 'model' ? '◆' : n.type === 'area' ? '▦' : n.type === 'image' ? '▣' : n.type === 'video' ? '▶' : '▢'
    for (const n of Object.values(nodes)) {
      if (n.pin || n.railDock || n.type === 'storyline' || (n.tileDeck && n.tileDeck.anchor !== n.id)) continue
      if (n.type !== 'area' && n.type !== 'model') {
        // Loose tiles are only listed on an Area; at the root, models only.
        const a = areaAt(nodes, n.x + n.width / 2, n.y + n.height / 2)
        if (!a) continue
      }
      put({ kind: 'node', id: n.id, name: n.label || n.type, icon: icon(n), cx: n.x + n.width / 2, cy: n.y + n.height / 2 }, n.type === 'area' ? n.id : undefined)
    }
    for (const g of groups) {
      if (g.pin) continue
      const a = areaAt(nodes, g.originX + 20, g.originY + 20)
      if (a) put({ kind: 'card', id: g.id, name: g.name || 'Card', icon: '▭', cx: g.originX + 20, cy: g.originY + 20 })
    }
    for (const w of Object.values(windows)) put({ kind: 'viewer', id: w.id, name: 'Viewer', icon: '◳', cx: w.x + w.width / 2, cy: w.y + w.height / 2 })
    for (const c of Object.values(curves)) {
      const b = curveBounds(c)
      const inA = areaAt(nodes, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)
      const all = inA && c.pts.every(p => p.x >= inA.x && p.x <= inA.x + inA.width && p.y >= inA.y && p.y <= inA.y + inA.height)
      const it: Item = { kind: 'curve', id: c.id, name: c.arrowEnd || c.arrowStart ? 'Arrow' : c.kind === 'free' ? 'Pen line' : 'Curve', icon: '∿', cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 }
      if (all) { if (!kids.has(inA!.id)) kids.set(inA!.id, []); kids.get(inA!.id)!.push(it) }
      else root.push(it)
    }
    return { areas, kids, root }
  }, [nodes, groups, windows, curves])
}

/** Move an outliner item so its middle is at (x, y). */
function moveItemTo(it: Item, x: number, y: number) {
  const dx = x - it.cx, dy = y - it.cy
  if (it.kind === 'node') useFreeNodeStore.getState().moveManyFreeNodes([it.id], dx, dy)
  else if (it.kind === 'card') {
    const g = useBoardsStore.getState().groups.find(x => x.id === it.id)
    if (g) useBoardsStore.getState().setGroupPos(g.id, g.originY + dy, g.originX + dx)
  } else if (it.kind === 'viewer') {
    const w = useViewport3DStore.getState().windows[it.id]
    if (w) useViewport3DStore.getState().updateWindow(w.id, { x: w.x + dx, y: w.y + dy })
  } else useNotesStore.getState().moveCurves([it.id], dx, dy)
}

function selectItem(it: Item) {
  const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState()
  if (it.kind === 'node') { fs.setFreeSelection([it.id]); bs.clearGroupSelection() }
  else if (it.kind === 'card') { bs.setSelectedGroups([it.id]); fs.setFreeSelection([]) }
  else if (it.kind === 'curve') useNotesUi.setState({ selected: [it.id] })
}

const Outliner: React.FC = () => {
  const { areas, kids, root } = useOutline()
  const selNodes = useFreeNodeStore(s => s.selectedIds)
  const selCards = useBoardsStore(s => s.selectedGroupIds)
  const selCurves = useNotesUi(s => s.selected)
  const [dragging, setDragging] = useState<Item | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const drag = useRef<{ it: Item; x0: number; y0: number; live: boolean } | null>(null)
  const isSel = (it: Item) => it.kind === 'node' ? selNodes.includes(it.id) : it.kind === 'card' ? selCards.includes(it.id) : it.kind === 'curve' ? selCurves.includes(it.id) : false

  const down = (e: React.PointerEvent, it: Item) => {
    if (e.button !== 0) return
    drag.current = { it, x0: e.clientX, y0: e.clientY, live: false }
    const move = (ev: PointerEvent) => {
      const d = drag.current
      if (!d) return
      if (!d.live && Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) > 5) { d.live = true; setDragging(d.it) }
      if (!d.live) return
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-outline-drop]')
      setOver(el?.dataset.outlineDrop ?? null)
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const d = drag.current
      drag.current = null
      setDragging(null); setOver(null)
      if (!d) return
      if (!d.live) { selectItem(d.it); return }
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-outline-drop]')?.dataset.outlineDrop
      if (!target || target === d.it.id) return
      const nodes = useFreeNodeStore.getState().nodes
      useUndoCoordinator.getState().checkpoint()
      if (target === 'root') {
        const a = areaAt(nodes, d.it.cx, d.it.cy, d.it.kind === 'node' && nodes[d.it.id]?.type === 'area' ? d.it.id : undefined)
        if (a) moveItemTo(d.it, a.x + a.width + a.width * 0.15, d.it.cy)
        return
      }
      const a = nodes[target]
      if (!a) return
      // Into the Area: set down in its middle, a little apart from what is
      // already there.
      const n = (kids.get(a.id)?.length ?? 0)
      const step = Math.min(a.width, a.height) * 0.08
      moveItemTo(d.it, a.x + a.width / 2 + (n % 5 - 2) * step, a.y + a.height / 2 + (Math.floor(n / 5) % 5 - 2) * step)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const Row: React.FC<{ it: Item; depth: number; drop?: boolean }> = ({ it, depth, drop }) => (
    <div
      data-outline-drop={drop ? it.id : undefined}
      onPointerDown={e => down(e, it)}
      title={drop ? 'Drag rows onto an Area to put them on it' : 'Click to select · drag onto an Area'}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, height: 24, paddingLeft: 6 + depth * 14, paddingRight: 6,
        borderRadius: 5, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden',
        background: over === it.id && drop ? 'rgba(95,227,155,0.18)' : isSel(it) ? 'rgba(120,170,255,0.16)' : 'transparent',
        outline: over === it.id && drop ? '1px solid rgba(95,227,155,0.6)' : 'none',
        color: dragging?.id === it.id ? 'rgba(255,255,255,0.35)' : 'rgba(235,240,255,0.85)',
        userSelect: 'none',
      }}
    >
      <span style={{ width: 12, textAlign: 'center', color: it.kind === 'node' && it.icon === '▦' ? '#5fe39b' : 'rgba(160,200,255,0.8)' }}>{it.icon}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</span>
    </div>
  )

  const tree = (a: FreeNodeData, depth: number): React.ReactNode => {
    const it: Item = { kind: 'node', id: a.id, name: a.label || 'Area', icon: '▦', cx: a.x + a.width / 2, cy: a.y + a.height / 2 }
    const list = kids.get(a.id) ?? []
    return (
      <React.Fragment key={a.id}>
        <Row it={it} depth={depth} drop />
        {list.map(k => {
          const sub = k.kind === 'node' ? areas.find(x => x.id === k.id) : undefined
          return sub ? tree(sub, depth + 1) : <Row key={`${k.kind}${k.id}`} it={k} depth={depth + 1} />
        })}
      </React.Fragment>
    )
  }
  const topAreas = areas.filter(a => !areaAt(useFreeNodeStore.getState().nodes, a.x + a.width / 2, a.y + a.height / 2, a.id))
  const rootItems = root.filter(it => !(it.kind === 'node' && areas.some(a => a.id === it.id)))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <div data-outline-drop="root" style={{
        fontSize: 11, color: 'rgba(255,255,255,0.45)', padding: '2px 6px', borderRadius: 5,
        background: over === 'root' ? 'rgba(95,227,155,0.18)' : 'transparent',
      }}>Canvas</div>
      {topAreas.map(a => tree(a, 0))}
      {rootItems.map(it => <Row key={`${it.kind}${it.id}`} it={it} depth={0} />)}
      {!topAreas.length && !rootItems.length && (
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', padding: '2px 6px', lineHeight: 1.5 }}>Areas, models and curves show here.</div>
      )}
    </div>
  )
}

export const NotesPanel: React.FC = () => {
  const open = useNotesUi(s => s.open)
  const folded = useNotesUi(s => s.collapsed)
  const tool = useNotesUi(s => s.tool)
  const color = useNotesUi(s => s.color)
  const width = useNotesUi(s => s.width)
  const arrowStart = useNotesUi(s => s.arrowStart)
  const arrowEnd = useNotesUi(s => s.arrowEnd)
  const smooth = useNotesUi(s => s.smooth)
  const selected = useNotesUi(s => s.selected)
  const placing = usePlacing(s => s.kind)
  const drawing = useCurveDraft(s => !!s.curve)
  if (!open) return null

  /** A setting, and the same on the selected curves. */
  const apply = (patch: { color?: string; arrowStart?: boolean; arrowEnd?: boolean }) => {
    useNotesUi.setState(patch)
    const ns = useNotesStore.getState()
    const ids = selected.filter(id => ns.curves[id])
    if (!ids.length) return
    useUndoCoordinator.getState().checkpoint()
    for (const id of ids) ns.updateCurve(id, patch)
  }

  /** Smooth on or off, and the same on the selected curves (turned off, a
   *  curve keeps its shape: the handles it ran on become its own). */
  const setSmooth = (on: boolean) => {
    useNotesUi.setState({ smooth: on })
    const ns = useNotesStore.getState()
    const ids = selected.filter(id => ns.curves[id]?.kind === 'bezier' && !!ns.curves[id].smooth !== on)
    if (!ids.length) return
    useUndoCoordinator.getState().checkpoint()
    for (const id of ids) {
      const c = ns.curves[id]
      ns.updateCurve(id, on ? { smooth: true } : { smooth: false, pts: curvePoints(c) })
    }
  }
  const selectBtn = (
    <button key="select" style={btnStyle(!tool, !folded)} aria-pressed={!tool}
      title="Select: click a curve to select it (Shift adds), drag it to move it, drag its points and handles to reshape it. Delete removes. Esc also puts any tool down."
      onClick={() => useNotesUi.setState({ tool: null, linking: null })}>
      <IcSelect />{!folded && <span>Select</span>}
    </button>
  )
  const toolBtns = [selectBtn, ...TOOLS.map(t => (
    <button key={t.id} style={btnStyle(tool === t.id, !folded)} title={t.tip} aria-pressed={tool === t.id}
      onClick={() => toggleTool(t.id)}>
      <t.Icon />{!folded && <span>{t.name}{t.id === 'curve' && drawing ? ' · drawing' : ''}</span>}
    </button>
  ))]
  const areaBtn = (
    <button style={btnStyle(placing === 'area', !folded)} aria-pressed={placing === 'area'}
      title="Area card: a mat on the canvas that becomes a 3D workspace. Click, then click the canvas to set it down."
      onClick={() => { useNotesUi.setState({ tool: null }); togglePlacing('area') }}>
      <IcArea />{!folded && <span>Area card</span>}
    </button>
  )

  return (
    <div
      data-notes-panel=""
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      style={{
        position: 'fixed', top: 64, right: 52, width: folded ? W_FOLDED : W_OPEN, maxHeight: 'calc(100vh - 96px)',
        display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
        background: 'rgba(12,13,22,0.94)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 14,
        boxShadow: '0 10px 30px rgba(0,0,0,0.55)', zIndex: 870, color: '#e8f0ff', userSelect: 'none',
        backdropFilter: 'blur(6px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: folded ? 'center' : 'space-between', height: 38, padding: folded ? 0 : '0 8px 0 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        {!folded && <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4 }}>Notes &amp; 3D tools</span>}
        <button style={{ ...btnStyle(false), width: 28, height: 28, borderRadius: 7 }} onClick={() => useNotesUi.setState({ collapsed: !folded })}
          title={folded ? 'Open the panel out' : 'Fold to an icon strip'}>
          <IcFold folded={folded} />
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: folded ? 6 : 14, padding: folded ? 7 : 12, overflowY: 'auto', alignItems: folded ? 'center' : 'stretch' }}>
        {folded ? (
          <>
            {toolBtns}
            <div style={{ width: 24, height: 1, background: 'rgba(255,255,255,0.1)' }} />
            <button style={btnStyle(arrowStart)} aria-pressed={arrowStart} title="Arrowhead at the start" onClick={() => apply({ arrowStart: !arrowStart })}><IcArrowStart /></button>
            <button style={btnStyle(arrowEnd)} aria-pressed={arrowEnd} title="Arrowhead at the end" onClick={() => apply({ arrowEnd: !arrowEnd })}><IcArrowEnd /></button>
            <button style={btnStyle(smooth)} aria-pressed={smooth} title={SMOOTH_TIP} onClick={() => setSmooth(!smooth)}><IcSmooth /></button>
            <div style={{ width: 20, height: 20, borderRadius: 10, background: color, border: '2px solid rgba(255,255,255,0.25)' }} title="Colour (open the panel to change)" />
            <div style={{ width: 24, height: 1, background: 'rgba(255,255,255,0.1)' }} />
            {areaBtn}
          </>
        ) : (
          <>
            <Section title="TOOLS">{toolBtns}</Section>
            <Section title="ARROWHEADS">
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={{ ...btnStyle(arrowStart, true), flex: 1 }} aria-pressed={arrowStart} onClick={() => apply({ arrowStart: !arrowStart })} title="Arrowhead at the start: on or off"><IcArrowStart /><span>Start</span></button>
                <button style={{ ...btnStyle(arrowEnd, true), flex: 1 }} aria-pressed={arrowEnd} onClick={() => apply({ arrowEnd: !arrowEnd })} title="Arrowhead at the end: on or off"><IcArrowEnd /><span>End</span></button>
              </div>
            </Section>
            <Section title="CURVE">
              <button style={btnStyle(smooth, true)} aria-pressed={smooth} onClick={() => setSmooth(!smooth)} title={SMOOTH_TIP}><IcSmooth /><span>Smooth</span></button>
            </Section>
            <Section title="COLOUR">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: 4 }}>
                {NOTE_COLORS.map(c => (
                  <button key={c} onClick={() => apply({ color: c })} title={c} aria-pressed={c === color}
                    style={{ height: 20, borderRadius: 10, background: c, cursor: 'pointer', padding: 0,
                      border: c === color ? '2px solid #fff' : '2px solid rgba(255,255,255,0.15)', boxShadow: c === color ? '0 0 0 1px rgba(0,0,0,0.6)' : 'none' }} />
                ))}
              </div>
            </Section>
            <Section title={`THICKNESS · ${width}px`}>
              <input type="range" min={1} max={24} step={1} value={width}
                onChange={e => {
                  const w = +e.target.value
                  const ns = useNotesStore.getState()
                  const ids = selected.filter(id => ns.curves[id])
                  if (ids.length) {
                    useUndoCoordinator.getState().checkpoint()
                    for (const id of ids) ns.updateCurve(id, { width: ns.curves[id].width * w / width })
                  }
                  useNotesUi.setState({ width: w })
                }}
                style={{ width: '100%' }} />
            </Section>
            <Section title="PLACE">{areaBtn}</Section>
            <Section title="OUTLINER"><Outliner /></Section>
          </>
        )}
      </div>
    </div>
  )
}
