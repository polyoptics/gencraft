// PinLabels — the labels of the pins on models in the 3D view
// (store/notesStore): small digital tags, a title and an optional second
// line, on a leader from the pin's dot. Page elements over the 3D layer, so
// they are crisp at every size. Each label has its own spot in 3D, by the
// model (ModelPin.at; Brian 2026-11-07: they stay where they are put), and
// three/notesOverlay says where the pin and that spot are on screen every
// frame. Round the back of the model they dim.
//  - Click: selects the card it links to.
//  - Drag: move the label to another spot in 3D, at the depth it was.
//  - Double-click: edit its title and second line here.

import React, { useEffect, useRef, useState } from 'react'
import { models } from '../Canvas/tilt/TiltModels'
import { useNotesStore, useNotesUi, type ModelPin } from '../../store/notesStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useTiltStore, isTilted } from '../../store/tiltStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { pinTitle, renamePin, setPinDesc } from '../../utils/annotations'
import { labelSpot, type PinSpot } from '../../three/notesOverlay'

/** The latest spots, by id, for a drag to start from. */
const latest = new Map<string, PinSpot>()

type Parts = { leader: SVGPathElement | null; tag: HTMLDivElement | null; box: HTMLDivElement | null }
/** Each label's parts on the page, by id, for the frame loop to lay out. */
const partsById = new Map<string, Parts>()
function setPart<K extends keyof Parts>(id: string, k: K, el: Parts[K]) {
  let p = partsById.get(id)
  if (!p) { p = { leader: null, tag: null, box: null }; partsById.set(id, p) }
  p[k] = el
  if (!p.leader && !p.tag && !p.box) partsById.delete(id)
  else if (el) { const s = latest.get(id); if (s) place(p, s) }
}

/** Lay a label's parts where its pin and spot are now. */
function place(parts: Parts, s: PinSpot) {
  if (parts.leader) parts.leader.setAttribute('d', `M${s.x.toFixed(1)} ${s.y.toFixed(1)} L${s.lx.toFixed(1)} ${s.ly.toFixed(1)}`)
  if (parts.tag) parts.tag.style.transform = `translate(${Math.round(s.lx)}px, ${Math.round(s.ly)}px)`
  if (parts.box) parts.box.style.opacity = s.hidden ? '0.35' : '1'
}

const Label: React.FC<{ spot: PinSpot; pin: ModelPin; title: string; focused: boolean }> = ({ spot, pin, title, focused }) => {
  const [editing, setEditing] = useState(false)
  const [t, setT] = useState(title)
  const [d, setD] = useState(pin.desc)
  const [moving, setMoving] = useState(false)
  const dragged = useRef(false)
  const resolved = pin.status === 'resolved'
  const done = () => {
    setEditing(false)
    useUndoCoordinator.getState().checkpoint()
    if (t.trim() && t !== title) renamePin(spot.url, pin, t.trim())
    if (d !== pin.desc) setPinDesc(spot.url, pin, d)
  }
  const ink = resolved ? '#5fe39b' : '#7fd4ff'
  const glow = focused ? `drop-shadow(0 0 4px ${ink})` : 'none'
  const ruleW = Math.min(200, Math.max(70, title.length * 7.4 + 22))
  const text: React.CSSProperties = {
    fontFamily: '"JetBrains Mono", "Consolas", ui-monospace, monospace', letterSpacing: 0.3,
    textShadow: '0 1px 2px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.7)', whiteSpace: 'nowrap',
  }
  const onDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    if (e.button !== 0 || editing || !models.labelAt || !models.root) return
    const s0 = latest.get(spot.id)
    const size = models.modelSize?.(spot.key)
    if (!s0 || !size) return
    const r = models.root.getBoundingClientRect()
    // The cursor's offset from the label's spot, kept as it moves.
    const gx = e.clientX - (r.left + s0.lx), gy = e.clientY - (r.top + s0.ly)
    const v = labelSpot(pin, size)
    const through: [number, number, number] = [v.x, v.y, v.z]
    const x0 = e.clientX, y0 = e.clientY
    dragged.current = false
    const move = (ev: PointerEvent) => {
      if (!dragged.current) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
        dragged.current = true
        setMoving(true)
        useUndoCoordinator.getState().checkpoint()
      }
      const at = models.labelAt?.(spot.key, through, ev.clientX - gx, ev.clientY - gy)
      if (at) useNotesStore.getState().updatePin(spot.url, pin.id, { at })
    }
    const up = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      setMoving(false)
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
  }
  return (
    <div ref={el => setPart(spot.id, 'box', el)} data-pin-label="" style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
      {/* The leader, from the pin to the label's spot. */}
      <svg width={1} height={1} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', filter: glow }}>
        <path ref={el => setPart(spot.id, 'leader', el)} fill="none" stroke={ink} strokeWidth={focused ? 1.6 : 1.1} opacity={0.95} />
      </svg>
      <div ref={el => setPart(spot.id, 'tag', el)} style={{ position: 'absolute', left: 0, top: 0, willChange: 'transform' }}>
        {/* The rule the title sits on, from the spot, ending in a short
            tick; the status is the small square at its start. */}
        <svg width={1} height={1} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', filter: glow }}>
          <path d={`M0 0 H${ruleW}`} fill="none" stroke={ink} strokeWidth={focused ? 1.6 : 1.1} opacity={0.95} />
          <path d={`M${ruleW} 0 v5`} stroke={ink} strokeWidth={1.1} />
          <rect x={-2.5} y={-2.5} width={5} height={5} fill={resolved ? ink : '#0b1220'} stroke={ink} strokeWidth={1} />
        </svg>
        <div
          onPointerDown={onDown}
          onClick={() => {
            if (dragged.current) { dragged.current = false; return }
            useNotesUi.setState({ focus: { url: spot.url, pinId: pin.id } })
            if (pin.cardId) useBoardsStore.getState().setSelectedGroups([pin.cardId])
          }}
          onDoubleClick={() => { setT(title); setD(pin.desc); setEditing(true) }}
          title={'Click: show it on its Annotation card' + (pin.cardId ? ' and select its card' : '') + ' · Drag: move the label (it stays there in 3D) · Double-click: edit'}
          style={{ position: 'absolute', left: 6, top: -17, pointerEvents: 'auto', cursor: moving ? 'grabbing' : 'pointer', color: '#eef6ff', padding: '0 4px 2px 0' }}
        >
          {editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, ...text }} onKeyDown={e => { if (e.key === 'Enter') done(); if (e.key === 'Escape') setEditing(false) }}>
              <input autoFocus value={t} onChange={e => setT(e.target.value)} placeholder="Title"
                style={{ font: 'inherit', fontSize: 12, fontWeight: 700, color: '#fff', background: 'rgba(8,12,22,0.9)', border: `1px solid ${ink}`, borderRadius: 2, padding: '1px 4px', width: 180 }} />
              <input value={d} onChange={e => setD(e.target.value)} placeholder="Second line (optional)" onBlur={done}
                style={{ font: 'inherit', fontSize: 11, color: 'rgba(232,240,255,0.8)', background: 'rgba(8,12,22,0.9)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 2, padding: '1px 4px', width: 180 }} />
            </div>
          ) : (
            <div style={text}>
              <div style={{ fontSize: 12, fontWeight: 600, lineHeight: '14px', opacity: resolved ? 0.75 : 1 }}>
                <span style={{ color: ink, fontSize: 9, marginRight: 5 }}>{String(pin.n0).padStart(2, '0')}</span>{title}
              </div>
              {pin.desc && <div style={{ fontSize: 10, lineHeight: '13px', marginTop: 4, color: 'rgba(220,235,255,0.65)' }}>{pin.desc}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export const PinLabels: React.FC = () => {
  const notes = useNotesStore(s => s.models)
  const focus = useNotesUi(s => s.focus)
  const [list, setList] = useState<PinSpot[]>([])
  const lastKey = useRef('')
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const live = isTilted(useTiltStore.getState())
      const spots = live && models.pinSpots ? models.pinSpots() : []
      latest.clear()
      for (const s of spots) latest.set(s.id, s)
      const key = [...latest.keys()].sort().join(',')
      if (key !== lastKey.current) { lastKey.current = key; setList(spots.slice()) }
      for (const [id, p] of partsById) {
        const s = latest.get(id)
        if (s) place(p, s)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <>
      {list.map(s => {
        const pin = notes[s.url]?.pins.find(p => p.id === s.pinId)
        if (!pin) return null
        return <Label key={s.id} spot={s} pin={pin} title={pinTitle(pin)} focused={focus?.pinId === pin.id} />
      })}
    </>
  )
}
