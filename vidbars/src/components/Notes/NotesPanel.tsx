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
import { areaAt } from '../../utils/areaFollow'
import { ensureAnnotated, modelName } from '../../utils/annotations'
import { models, cardModel } from '../Canvas/tilt/TiltModels'
import { curveBounds, curvePoints } from '../../utils/curveGeom'
import { tangentState, setBroken, setCorner } from '../../utils/pathEdit'
import { useCanvasStore } from '../../store/canvasStore'
import { ColorPickerPopup } from '../Bar/ColorPickerPopup'
import { useCurveDraft } from '../../utils/notesTool'
import { useModelScaleStore } from '../../store/tiltStore'
import { createMediaCard } from '../../utils/cardGrid'
import { visibleCanvasCenter } from '../../utils/fx/createEffect'
import { PRIMITIVES, PRIM_NAMES, primitiveUrl, type Primitive } from '../../three/primitives'
import { dataKey } from '../../utils/area3dScene'
import { CameraTools, NEW_CAMERA_MM } from '../Canvas/tilt/LookThrough'

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
const IcBreak: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M3 18c2-6 5-9 9-9" stroke={S} /><path d="M12 9c2 5 5 8 9 9" stroke={S} /><path d="M12 9L6.5 4.5" stroke="#4fc3ff" strokeWidth="1.4" /><path d="M12 9l6.5-3" stroke="#4fc3ff" strokeWidth="1.4" /><rect x="10.2" y="7.2" width="3.6" height="3.6" fill="#ffe14a" stroke="none" /><circle cx="6.5" cy="4.5" r="1.6" fill="#4fc3ff" stroke="none" /><circle cx="18.5" cy="6" r="1.6" fill="#4fc3ff" stroke="none" /></svg>
)
const IcCorner: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M3 18L12 7l9 11" stroke={S} strokeLinejoin="miter" /><rect x="10.2" y="5.2" width="3.6" height="3.6" fill="#ffe14a" stroke="none" /></svg>
)
const IcPen: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M4 20c3-1 4-4 6-4s2 3 5 2 4-5 5-7" stroke="#ff8fd1" /><path d="M14.5 4.5l3 3L10 15l-3.6.6.6-3.6z" stroke={S} strokeWidth="1.6" /></svg>
)
const IcPin: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><circle cx="8" cy="16" r="2.4" fill="#ffb23f" stroke="none" /><path d="M9.6 14.4L14 10" stroke={S} strokeWidth="1.4" /><rect x="13" y="4" width="8" height="6" rx="1" stroke={S} strokeWidth="1.6" /></svg>
)
const IcErase: Ic = ({ size = 20 }) => (
  <svg {...svg(size)}><path d="M14.5 4.5l5 5-8.5 8.5H6l-2.5-2.5z" stroke={S} strokeWidth="1.6" /><path d="M9.5 9.5l5 5" stroke="#ff8fd1" strokeWidth="1.6" /><path d="M11 18h9" stroke={S} strokeWidth="1.4" /></svg>
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
  { id: 'curve', Icon: IcCurve, name: 'Curve', tip: 'Curve: click for corners, click-drag for smooth points. Double-click, Enter or Esc finishes; click the first point to close it. Click a selected curve’s end point to carry on from it. Works flat and in 3D.' },
  { id: 'pen', Icon: IcPen, name: 'Pen', tip: 'Pen: freehand. Over a model in 3D it draws on the model’s surface; anywhere else on the canvas.' },
  { id: 'pin', Icon: IcPin, name: 'Pin', tip: 'Pin: click a model in 3D to pin a note on it. Each pin gets a Note card, and the model gets an Annotation card.' },
  { id: 'erase', Icon: IcErase, name: 'Erase', tip: 'Erase: click or drag over a stroke on a model, a pin’s dot or a curve to remove just that. Models and cards are never touched.' },
]

const SMOOTH_TIP = 'Smooth: on or off. On, a curve runs smoothly through its points by itself, no handles to set; drag the points to reshape it. Also sets the selected curves.'

/** One of three switches sharing a row of the open panel. */
const THIRD: React.CSSProperties = { flex: '1 1 0', minWidth: 0, width: 'auto', padding: '0 5px', gap: 4, fontSize: 11.5, justifyContent: 'center' }
const BREAK_TIP = 'Break: on or off, for the selected points. On, a point’s two tangent handles are each their own, so the line can turn sharply through it with bent sides. Off, they stay in one line and the curve runs smoothly through. Ctrl-drag a handle breaks its point too.'
const CORNER_TIP = 'Corner: on or off, for the selected points. On, a point has no handles: the line turns sharply there. Off, it gets its handles back.'

/** The selected points' tangents: Break and Corner, each its own switch.
 *  Always here, dim until a point is selected. */
const PointTools: React.FC<{ folded: boolean }> = ({ folded }) => {
  // Read again when the selection or the curves change.
  useNotesUi(s => s.points)
  useNotesStore(s => s.curves)
  const st = tangentState()
  const set = (f: (on: boolean) => void, on: boolean) => {
    if (!st.any) return
    useUndoCoordinator.getState().checkpoint()
    f(on)
  }
  const dim = st.any ? 1 : 0.4
  const third = folded ? {} : THIRD
  const brk = (
    <button style={{ ...btnStyle(st.broken, !folded), ...third, opacity: dim }} aria-pressed={st.broken} aria-disabled={!st.any}
      title={BREAK_TIP} onClick={() => set(setBroken, !st.broken)}><IcBreak size={folded ? 20 : 16} />{!folded && <span>Break</span>}</button>
  )
  const cnr = (
    <button style={{ ...btnStyle(st.corner, !folded), ...third, opacity: dim }} aria-pressed={st.corner} aria-disabled={!st.any}
      title={CORNER_TIP} onClick={() => set(setCorner, !st.corner)}><IcCorner size={folded ? 20 : 16} />{!folded && <span>Corner</span>}</button>
  )
  return <>{brk}{cnr}</>
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div style={{ fontSize: 10, letterSpacing: 1.3, color: 'rgba(255,255,255,0.4)', fontFamily: 'ui-monospace, monospace' }}>{title}</div>
    {children}
  </div>
)

// ── The selected model's notes ──

/** The models of the selected tiles and cards that have notes: their key
 *  (as the 3D view knows them) and file. */
function useSelectedModels(): { key: string; url: string }[] {
  const selNodes = useFreeNodeStore(s => s.selectedIds)
  const selCards = useBoardsStore(s => s.selectedGroupIds)
  const nodes = useFreeNodeStore(s => s.nodes)
  const notes = useNotesStore(s => s.models)
  return useMemo(() => {
    const out: { key: string; url: string }[] = []
    const keys = [...selNodes.map(id => `node:${id}`), ...selCards.map(id => `card:${id}`)]
    for (const key of keys) {
      const n = key.startsWith('node:') ? nodes[key.slice(5)] : undefined
      const url = models.info?.(key)?.url ?? (n?.type === 'model' ? n.imageUrl : undefined)
      if (url && notes[url] && !out.some(o => o.url === url)) out.push({ key, url })
    }
    return out
  }, [selNodes, selCards, nodes, notes])
}

/** Clear its strokes, or bring its Annotation card back (made again if it
 *  was deleted): without going near the model itself. */
const ModelNotesRow: React.FC<{ k: string; url: string }> = ({ k, url }) => {
  const m = useNotesStore(s => s.models[url])
  const nodes = useFreeNodeStore(s => s.nodes)
  if (!m) return null
  const has = !!(m.cardNodeId && nodes[m.cardNodeId])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name || modelName(k, url)}</span>
        <span style={{ color: 'rgba(255,255,255,0.45)', fontFamily: 'ui-monospace, monospace', fontSize: 11, flexShrink: 0 }}>{m.strokes.length} strokes · {m.pins.length} pins</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={{ ...btnStyle(false, true), flex: 1, justifyContent: 'center', opacity: m.strokes.length ? 1 : 0.45 }} disabled={!m.strokes.length}
          title="Remove every stroke drawn on this model (Ctrl+Z brings them back). The Erase tool removes one at a time."
          onClick={() => { useUndoCoordinator.getState().checkpoint(); useNotesStore.getState().clearStrokes(url) }}>Clear strokes</button>
        <button style={{ ...btnStyle(false, true), flex: 1, justifyContent: 'center' }}
          title={has ? 'Select its Annotation card' : 'Its Annotation card was deleted: make it again, with all its pins'}
          onClick={() => {
            const id = ensureAnnotated(url, k)
            useFreeNodeStore.getState().setFreeSelection([id])
            useBoardsStore.getState().clearGroupSelection()
          }}>{'Annotation card'}</button>
      </div>
    </div>
  )
}

const SelectedModels: React.FC = () => {
  const list = useSelectedModels()
  if (!list.length) return null
  return <Section title="SELECTED MODEL">{list.map(m => <ModelNotesRow key={m.key} k={m.key} url={m.url} />)}</Section>
}

// ── 3D area: primitives and model colour (Brian 2026-11-08) ──

const PRIM_ICON: Record<Primitive, React.ReactNode> = {
  cube: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" stroke={S} /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" stroke={S} /></>,
  sphere: <><circle cx="12" cy="12" r="8.5" stroke={S} /><ellipse cx="12" cy="12" rx="8.5" ry="3.2" stroke={S} /></>,
  cylinder: <><ellipse cx="12" cy="5.5" rx="7" ry="2.5" stroke={S} /><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13" stroke={S} /></>,
  cone: <><path d="M12 3L5 18.5M12 3l7 15.5" stroke={S} /><ellipse cx="12" cy="18.5" rx="7" ry="2.5" stroke={S} /></>,
  plane: <path d="M7 8h14l-4 8H3z" stroke={S} />,
  camera: <><rect x="2.5" y="9" width="12" height="9" rx="1.5" stroke={S} /><path d="M14.5 12l6-3v9l-6-3" stroke={S} /><circle cx="6" cy="6" r="2.4" stroke={S} /><circle cx="11.5" cy="6" r="2.4" stroke={S} /></>,
}

/** Model colours: plain, readable over the dark ground. */
const MODEL_COLORS = ['#e8e8e8', '#7a7f8a', '#2b2d33', '#d9534f', '#f0a742', '#f2d64b', '#6fbf73', '#4aa3df', '#8a6fd1', '#c98a5a']

/** The selected models (cards and tiles), as the 3D view keys them. */
function useSelectedModelKeys(): string[] {
  const selNodes = useFreeNodeStore(s => s.selectedIds)
  const selCards = useBoardsStore(s => s.selectedGroupIds)
  const nodes = useFreeNodeStore(s => s.nodes)
  const groups = useBoardsStore(s => s.groups)
  return useMemo(() => [
    ...selNodes.filter(id => nodes[id]?.type === 'model').map(id => `node:${id}`),
    // (groups: a card's face can change to or from a model.)
    // A closed deck's colour goes with the member on its face (dataKey).
    ...selCards.filter(id => !!cardModel(id)).map(id => dataKey(`card:${id}`)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [selNodes, selCards, nodes, groups])
}

let made = 0
/** A primitive, as a model card: on the selected 3D area, else the one in
 *  the middle of the view, else in the middle of the view. */
function makePrimitive(p: Primitive) {
  const fn = useFreeNodeStore.getState()
  const sel = fn.selectedIds.map(id => fn.nodes[id]).find(n => n?.type === 'area')
  const mid = visibleCanvasCenter()
  const area = sel ?? areaAt(fn.nodes, mid.cx, mid.cy)
  // Each new one a step along, so they don't stack up.
  const i = made++ % 5
  const at = area
    ? { cx: area.x + area.width * (0.3 + 0.1 * i), cy: area.y + area.height * 0.5 }
    : { cx: mid.cx + i * 40, cy: mid.cy }
  useUndoCoordinator.getState().checkpoint()
  const id = createMediaCard(at, [{ media: { url: primitiveUrl(p), type: 'model', originalName: PRIM_NAMES[p] }, label: PRIM_NAMES[p] }])
  // A new camera's lens (one made before keeps the lens it had).
  if (id && p === 'camera') useModelScaleStore.getState().setLens(dataKey(`card:${id}`), { mm: NEW_CAMERA_MM })
  // Sized to the scene, not the zoom: made zoomed out, a card came out
  // bigger than the whole scene and lay half off it (Brian 2026-11-09).
  if (id && area) {
    const g = useBoardsStore.getState().groups.find(x => x.id === id)
    const w = g?.cardWidthOverride, h = g?.cardHeightOverride
    const k = w && h ? Math.min(1, area.width * 0.14 / w) : 1
    if (g && w && h && k < 1) {
      useBoardsStore.setState(st => ({
        groups: st.groups.map(x => x.id === id ? { ...x, cardWidthOverride: w * k, cardHeightOverride: h * k, originX: at.cx - w * k / 2 - 20, originY: at.cy - h * k / 2 } : x),
      }))
    }
  }
  if (id) useBoardsStore.getState().setSelectedGroup(id)
}

const Area3dTools: React.FC = () => {
  const keys = useSelectedModelKeys()
  const tintOf = useModelScaleStore(s => s.tintOf)
  const cur = keys.length ? tintOf[keys[0]] ?? null : null
  const paint = (c: string | null) => {
    if (!keys.length) return
    useUndoCoordinator.getState().checkpoint()
    const ms = useModelScaleStore.getState()
    for (const k of keys) ms.setTint(k, c)
  }
  const sw = (c: string | null, on: boolean): React.CSSProperties => ({
    height: 20, borderRadius: 10, padding: 0, cursor: keys.length ? 'pointer' : 'default',
    background: c ?? 'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 3px, transparent 3px 6px)',
    border: on ? '2px solid #fff' : '2px solid rgba(255,255,255,0.15)', boxShadow: on ? '0 0 0 1px rgba(0,0,0,0.6)' : 'none',
  })
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
        {PRIMITIVES.map(p => (
          <button key={p} style={{ ...btnStyle(false), width: '100%' }} onClick={() => makePrimitive(p)}
            title={`${PRIM_NAMES[p]}: a new model card, set on the selected 3D set (or the one in view)`}>
            <svg {...svg(20)}>{PRIM_ICON[p]}</svg>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 10, letterSpacing: 1.3, color: 'rgba(255,255,255,0.4)', fontFamily: 'ui-monospace, monospace', marginTop: 4 }}>MODEL COLOUR</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(11, 1fr)', gap: 4, opacity: keys.length ? 1 : 0.4 }}
        title={keys.length ? undefined : 'Select a model to colour it'}>
        <button style={sw(null, !!keys.length && !cur)} disabled={!keys.length} onClick={() => paint(null)} title="Its own colours" aria-pressed={!!keys.length && !cur} />
        {MODEL_COLORS.map(c => (
          <button key={c} style={sw(c, cur === c)} disabled={!keys.length} onClick={() => paint(c)} title={c} aria-pressed={cur === c} />
        ))}
      </div>
      <CameraTools />
    </>
  )
}

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
  else if (it.kind === 'curve') useNotesUi.setState({ selected: [it.id], points: [] })
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
      title={drop ? 'Drag rows onto a 3D set to put them on it' : 'Click to select · drag onto a 3D set'}
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
    const it: Item = { kind: 'node', id: a.id, name: !a.label || a.label === 'Area' ? '3D set' : a.label, icon: '▦', cx: a.x + a.width / 2, cy: a.y + a.height / 2 }
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
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', padding: '2px 6px', lineHeight: 1.5 }}>3D sets, models and curves show here.</div>
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
  const dashOn = useNotesUi(s => s.dashOn)
  const dashGap = useNotesUi(s => s.dashGap)
  const selected = useNotesUi(s => s.selected)
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null)
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

  /** The line's pattern (the length of a solid section, and of the empty
   *  one after it; none empty = one solid line), and the same on the
   *  selected curves, at the zoom they are seen at. */
  const setPattern = (on: number, gap: number) => {
    useNotesUi.setState({ dashOn: on, dashGap: gap })
    const ns = useNotesStore.getState()
    const z = useCanvasStore.getState().zoom
    for (const id of selected) if (ns.curves[id]) ns.updateCurve(id, { dash: gap > 0 ? [on / z, gap / z] : undefined })
  }
  /** One undo step for a whole drag of a slider. */
  const stepOnce = () => { if (selected.some(id => useNotesStore.getState().curves[id])) useUndoCoordinator.getState().checkpoint() }
  /** A colour of your own (the picker): one undo step for the whole pick. */
  const openPicker = (e: React.MouseEvent) => {
    // Beside the panel, not over it.
    const r = e.currentTarget.getBoundingClientRect()
    const panel = e.currentTarget.closest('[data-notes-panel]')?.getBoundingClientRect()
    if (selected.some(id => useNotesStore.getState().curves[id])) useUndoCoordinator.getState().checkpoint()
    setPicker({ x: (panel?.left ?? r.left) - 232, y: r.top - 60 })
  }
  const pickColor = (c: string) => {
    useNotesUi.setState({ color: c })
    const ns = useNotesStore.getState()
    for (const id of selected) if (ns.curves[id]) ns.updateCurve(id, { color: c })
  }
  const custom = !NOTE_COLORS.includes(color)

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
      title="Select: click a curve to select it (Shift adds), drag it to move it. Click one of its points to select it (Shift adds; double-click for all of them), drag points and handles to reshape it; in 3D, Shift-drag lifts and lowers. Double-click the line for a new point. Delete removes the selected points, or the curve. Esc also puts any tool down."
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
            <PointTools folded />
            <div style={{ width: 20, height: 20, borderRadius: 10, background: color, border: '2px solid rgba(255,255,255,0.25)' }} title="Colour (open the panel to change)" />
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
              {/* Three switches in the one row the section always had. */}
              <div style={{ display: 'flex', gap: 5 }}>
                <button style={{ ...btnStyle(smooth, true), ...THIRD }} aria-pressed={smooth} onClick={() => setSmooth(!smooth)} title={SMOOTH_TIP}><IcSmooth size={16} /><span>Smooth</span></button>
                <PointTools folded={false} />
              </div>
            </Section>
            <Section title="COLOUR">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 3 }}>
                {NOTE_COLORS.map(c => (
                  <button key={c} onClick={() => apply({ color: c })} title={c} aria-pressed={c === color}
                    style={{ height: 20, borderRadius: 10, background: c, cursor: 'pointer', padding: 0,
                      border: c === color ? '2px solid #fff' : '2px solid rgba(255,255,255,0.15)', boxShadow: c === color ? '0 0 0 1px rgba(0,0,0,0.6)' : 'none' }} />
                ))}
                {/* Any colour: the picker. Lit, showing it, while the colour in use is one of your own. */}
                <button onClick={openPicker} title="Any colour: pick your own" aria-pressed={custom}
                  style={{ height: 20, borderRadius: 10, cursor: 'pointer', padding: 0,
                    background: custom ? color : 'conic-gradient(#ff5a5a, #ffe14a, #5fe39b, #4fc3ff, #a98bff, #ff8fd1, #ff5a5a)',
                    border: custom ? '2px solid #fff' : '2px solid rgba(255,255,255,0.15)', boxShadow: custom ? '0 0 0 1px rgba(0,0,0,0.6)' : 'none' }} />
              </div>
              {picker && <ColorPickerPopup color={color} anchorX={picker.x} anchorY={picker.y} onChange={pickColor} onClose={() => setPicker(null)} />}
            </Section>
            <Section title="LINE">
              <div style={{ display: 'flex', gap: 10 }}>
                {([['Solid', dashOn, 1, (v: number) => setPattern(v, dashGap), 'The length of each solid section of the line'],
                  ['Gap', dashGap, 0, (v: number) => setPattern(dashOn, v), 'The length of the empty section after each solid one. 0: one solid line']] as const).map(([name, val, min, set, tip]) => (
                  <label key={name} title={`${tip}. Also sets the selected curves.`} style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
                      {name}
                      <input type="number" min={min} max={400} step={1} value={val}
                        onPointerDown={stepOnce} onKeyDown={e => { e.stopPropagation(); if (e.key !== 'Tab') stepOnce() }}
                        onChange={e => set(Math.max(min, Math.min(400, Math.round(+e.target.value || 0))))}
                        style={{ width: 46, height: 20, boxSizing: 'border-box', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 5, color: '#e8f0ff', fontSize: 11, textAlign: 'right', padding: '0 3px' }} />
                    </span>
                    <input type="range" min={min} max={120} step={1} value={Math.min(120, val)} onPointerDown={stepOnce} onKeyDown={stepOnce}
                      onChange={e => set(+e.target.value)} style={{ width: '100%' }} />
                  </label>
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
            <Section title="3D SET"><Area3dTools /></Section>
            <SelectedModels />
            <Section title="OUTLINER"><Outliner /></Section>
          </>
        )}
      </div>
    </div>
  )
}
