// PinLabels — the labels of the pins on models in the 3D view
// (store/notesStore): small digital tags, a title and an optional second
// line, on a short leader from the pin's dot. Page elements over the 3D
// layer, so they are crisp at every size; three/notesOverlay says where each
// pin is on screen every frame and they follow it. Round the back of the
// model they dim.
//  - Click: selects the card it links to.
//  - Drag: move the label to a better spot (its leader follows).
//  - Double-click: edit its title and second line here.

import React, { useEffect, useRef, useState } from 'react'
import { models } from '../Canvas/tilt/TiltModels'
import { useNotesStore, useNotesUi, type ModelPin } from '../../store/notesStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useTiltStore, isTilted } from '../../store/tiltStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { pinTitle, renamePin, setPinDesc } from '../../utils/annotations'
import type { PinSpot } from '../../three/notesOverlay'

/** The leader: up and out from the pin, then level under the title. */
const RISE = 26, RUN = 16

const Label: React.FC<{ spot: PinSpot; pin: ModelPin; title: string; focused: boolean; setRef: (el: HTMLDivElement | null) => void }> = ({ spot, pin, title, focused, setRef }) => {
  const [editing, setEditing] = useState(false)
  const [t, setT] = useState(title)
  const [d, setD] = useState(pin.desc)
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
  // Dragged somewhere else: the label moves, the leader still runs from the pin.
  const [live, setLive] = useState<[number, number] | null>(null)
  const [ox, oy] = live ?? pin.off ?? [0, 0]
  const dragged = useRef(false)
  const onDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    if (e.button !== 0 || editing) return
    const x0 = e.clientX, y0 = e.clientY
    const [bx, by] = pin.off ?? [0, 0]
    dragged.current = false
    let last: [number, number] | null = null
    const move = (ev: PointerEvent) => {
      if (!dragged.current && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
      dragged.current = true
      last = [bx + ev.clientX - x0, by + ev.clientY - y0]
      setLive(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      if (last) {
        useUndoCoordinator.getState().checkpoint()
        useNotesStore.getState().updatePin(spot.url, pin.id, { off: [Math.round(last[0]), Math.round(last[1])] })
      }
      setLive(null)
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
  }
  const text: React.CSSProperties = {
    fontFamily: '"JetBrains Mono", "Consolas", ui-monospace, monospace', letterSpacing: 0.3,
    textShadow: '0 1px 2px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.7)', whiteSpace: 'nowrap',
  }
  return (
    <div ref={setRef} data-pin-label="" style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', willChange: 'transform' }}>
      <svg width={1} height={1} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', filter: glow }}>
        {/* A thin leader up from the pin, then the rule the title sits on,
            ending in a short tick; the status is the small square at its start. */}
        <path d={`M0 0 L${RUN + ox} ${oy - RISE} H${RUN + ox + ruleW}`} fill="none" stroke={ink} strokeWidth={focused ? 1.6 : 1.1} opacity={0.95} />
        <path d={`M${RUN + ox + ruleW} ${oy - RISE} v5`} stroke={ink} strokeWidth={1.1} />
        <rect x={RUN + ox - 2.5} y={oy - RISE - 2.5} width={5} height={5} fill={resolved ? ink : '#0b1220'} stroke={ink} strokeWidth={1} />
      </svg>
      <div
        onPointerDown={onDown}
        onClick={() => {
          if (dragged.current) { dragged.current = false; return }
          useNotesUi.setState({ focus: { url: spot.url, pinId: pin.id } })
          if (pin.cardId) useBoardsStore.getState().setSelectedGroups([pin.cardId])
        }}
        onDoubleClick={() => { setT(title); setD(pin.desc); setEditing(true) }}
        title={'Click: show it on its Annotation card' + (pin.cardId ? ' and select its card' : '') + ' · Drag: move the label · Double-click: edit'}
        style={{ position: 'absolute', left: RUN + 6 + ox, top: oy - RISE - 17, pointerEvents: 'auto', cursor: live ? 'grabbing' : 'pointer', color: '#eef6ff', padding: '0 4px 2px 0' }}
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
  )
}

export const PinLabels: React.FC = () => {
  const notes = useNotesStore(s => s.models)
  const groups = useBoardsStore(s => s.groups)
  const focus = useNotesUi(s => s.focus)
  const [list, setList] = useState<PinSpot[]>([])
  const lastKey = useRef('')
  const els = useRef(new Map<string, HTMLDivElement>())
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const live = isTilted(useTiltStore.getState())
      const spots = live && models.pinSpots ? models.pinSpots() : []
      const next = new Map(spots.map(s => [s.id, s]))
      const key = [...next.keys()].sort().join(',')
      if (key !== lastKey.current) { lastKey.current = key; setList(spots.slice()) }
      for (const [id, el] of els.current) {
        const s = next.get(id)
        if (!s) continue
        el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`
        el.style.opacity = s.hidden ? '0.35' : '1'
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  void groups
  return (
    <>
      {list.map(s => {
        const id = s.id
        const pin = notes[s.url]?.pins.find(p => p.id === s.pinId)
        if (!pin) return null
        return (
          <Label key={id} spot={s} pin={pin} title={pinTitle(pin)} focused={focus?.pinId === pin.id}
            setRef={el => {
              if (el) {
                els.current.set(id, el)
                el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`
              } else els.current.delete(id)
            }} />
        )
      })}
    </>
  )
}
