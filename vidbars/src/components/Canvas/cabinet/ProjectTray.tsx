// ProjectTray — an open drawer that holds a whole project, or could. The project
// shows as a little map of its canvas, every card and tile in its place with its
// picture. Dragged out, a ghost of its real footprint lies on the canvas, so you
// can see the room it needs before letting go.

import React, { useState } from 'react'
import ReactDOM from 'react-dom'
import { useCanvasStore } from '../../../store/canvasStore'
import { cssUrl } from '../../../utils/diskUrl'
import { useResolvedMedia } from '../../../utils/useResolvedMedia'
import { cabinetDrawerAt, canvasPointAt, useCabinetUi } from '../../../utils/cabinet'
import type { DrawerRef } from '../../../utils/cabinet'
import type { CabinetProject, ProjectMap, ProjectMapPart } from '../../../utils/cabinetData'
import { adoptSavedProject, forgetProject, putProjectAway, saveCanvasToDrawer, saveProject, takeProjectOut, takeProjectOutBelow } from '../../../utils/cabinetProjects'

const Part: React.FC<{ part: ProjectMapPart; map: ProjectMap; k: number; grow: number }> = ({ part, map, k, grow }) => {
  const pic = useResolvedMedia(part.pic)
  const dw = part.w * k * (grow - 1) / 2, dh = part.h * k * (grow - 1) / 2
  return (
    <div style={{
      position: 'absolute', boxSizing: 'border-box', overflow: 'hidden',
      left: (part.x - map.x) * k - dw, top: (part.y - map.y) * k - dh, width: part.w * k * grow, height: part.h * k * grow,
      borderRadius: Math.min(part.w, part.h) * k * 0.08, background: part.color,
      backgroundImage: pic ? cssUrl(pic) : undefined, backgroundSize: 'cover', backgroundPosition: 'center',
      boxShadow: '0 0 0 0.5px rgba(255,255,255,0.25)',
    }} />
  )
}

/** The project's canvas, drawn `height` high in its own shape. `grow` draws each
 *  picture bigger than its place, so a spread-out canvas still reads as pictures
 *  at this size rather than as specks. */
export const MapView: React.FC<{ map: ProjectMap; height: number; maxWidth?: number; grow?: number }> = ({ map, height, maxWidth = Infinity, grow = 1 }) => {
  const k = Math.min(height / Math.max(1, map.h), maxWidth / Math.max(1, map.w))
  return (
    <div style={{ position: 'relative', width: map.w * k, height: map.h * k, flexShrink: 0 }}>
      {map.parts.map((p, i) => <Part key={i} part={p} map={map} k={k} grow={grow} />)}
    </div>
  )
}

/** The real footprint on the canvas under the cursor. In the world layer, so it
 *  lies on the canvas in the tilted view as it does flat. */
const FootprintGhost: React.FC<{ map: ProjectMap; at: { cx: number; cy: number } }> = ({ map, at }) => {
  const zoom = useCanvasStore(s => s.zoom)
  const world = document.querySelector('[data-tilt-stage="world"] > div[style*="scale("]')
  if (!world) return null
  return ReactDOM.createPortal(
    <div style={{
      position: 'absolute', left: at.cx - map.w / 2, top: at.cy - map.h / 2, width: map.w, height: map.h,
      zIndex: 70, pointerEvents: 'none', opacity: 0.6, outline: `${2 / zoom}px dashed rgba(160,200,255,0.9)`,
      background: 'rgba(120,170,255,0.08)',
    }}>
      <MapView map={map} height={map.h} />
    </div>,
    world,
  )
}

const Chip: React.FC<{ u: number; onClick: () => void; title?: string; children: React.ReactNode }> = ({ u, onClick, title, children }) => (
  <button
    onClick={onClick}
    title={title}
    style={{
      padding: `${3 * u}px ${8 * u}px`, borderRadius: 5 * u, cursor: 'pointer', fontFamily: 'inherit',
      fontSize: 11 * u, fontWeight: 600, color: 'rgba(255,255,255,0.85)',
      background: 'rgba(255,255,255,0.09)', border: `${Math.max(1, u)}px solid rgba(255,255,255,0.16)`,
    }}
  >{children}</button>
)

interface SnapshotMeta { name: string; file: string }

export const EmptyDrawerActions: React.FC<{ drawer: DrawerRef; u: number }> = ({ drawer, u }) => {
  const [saved, setSaved] = useState<SnapshotMeta[] | 'loading' | null>(null)
  const choose = () => {
    setSaved('loading')
    fetch('/api/snapshots/list').then(r => r.json()).then(setSaved).catch(() => setSaved(null))
  }
  if (saved === 'loading') return <span style={{ margin: 'auto', color: 'rgba(255,255,255,0.5)', fontSize: 12 * u }}>Reading your saved projects…</span>
  if (saved) {
    return (
      <div onPointerDown={e => e.stopPropagation()} style={{ display: 'flex', flexWrap: 'wrap', gap: 4 * u, width: '100%' }}>
        {saved.map(s => <Chip key={s.file} u={u} onClick={() => { setSaved(null); adoptSavedProject(drawer, s.file, s.name) }}>{s.name}</Chip>)}
        <Chip u={u} onClick={() => setSaved(null)}>Cancel</Chip>
      </div>
    )
  }
  return (
    <div style={{ margin: 'auto', display: 'flex', gap: 6 * u, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
      <Chip u={u} onClick={() => saveCanvasToDrawer(drawer)} title="Save everything on the canvas as this drawer's project">Save canvas here</Chip>
      <Chip u={u} onClick={choose} title="Put a project saved through Templates in this drawer">Choose saved…</Chip>
    </div>
  )
}

export const ProjectTray: React.FC<{ drawer: DrawerRef; project: CabinetProject; u: number; height: number }> = ({ drawer, project, u, height }) => {
  const [ghost, setGhost] = useState<{ cx: number; cy: number } | null>(null)
  const out = !!project.out
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (out) return
    const sx = e.clientX, sy = e.clientY
    let moved = false
    let last: { cx: number; cy: number } | null = null
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
      moved = true
      last = cabinetDrawerAt(ev.clientX, ev.clientY) ? null : canvasPointAt(ev.clientX, ev.clientY, !ev.isTrusted)
      setGhost(last)
    }
    const end = (drop: boolean) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      setGhost(null)
      if (drop && moved && last) takeProjectOut(drawer, last.cx - project.map.w / 2, last.cy - project.map.h / 2)
    }
    const onUp = () => end(true)
    const onCancel = () => end(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }
  return (
    <div style={{ display: 'flex', gap: 8 * u, alignItems: 'center', width: '100%' }}>
      <div
        data-cabinet-project-map
        onPointerDown={onPointerDown}
        onDoubleClick={e => { e.stopPropagation(); if (!out) takeProjectOutBelow(drawer) }}
        title={out ? `${project.name} is out on the canvas` : `${project.name}: drag onto the canvas to spread it out, or double-click`}
        style={{ cursor: out ? 'default' : 'grab', touchAction: 'none', opacity: out ? 0.4 : 1, flexShrink: 0 }}
      >
        <MapView map={project.map} height={height} maxWidth={height * 2.4} grow={1.5} />
      </div>
      {ghost && <FootprintGhost map={project.map} at={ghost} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 * u, alignItems: 'flex-start', minWidth: 0 }}>
        {out ? (
          <>
            <Chip u={u} onClick={() => putProjectAway(drawer)} title="Save it and clear it off the canvas">Put away</Chip>
            <Chip u={u} onClick={() => saveProject(drawer)} title="Save it and keep working">Save</Chip>
          </>
        ) : (
          <>
            <Chip u={u} onClick={() => takeProjectOutBelow(drawer, true)} title="Stamp a copy below your work; the drawer keeps its project">Stamp a copy</Chip>
            <Chip u={u} onClick={() => forgetProject(drawer)} title="Empty this drawer. The saved file stays on disk">Empty drawer</Chip>
          </>
        )}
      </div>
    </div>
  )
}

/** The little picture on the front of a drawer that holds a project. */
export const FrontPicture: React.FC<{ map: ProjectMap; height: number; dim: boolean }> = ({ map, height, dim }) => (
  <span style={{ opacity: dim ? 0.4 : 1, display: 'inline-flex', flexShrink: 0 }}>
    <MapView map={map} height={height} maxWidth={height * 2} grow={1.5} />
  </span>
)

/** What a slow step is doing, or why it failed. */
export const DrawerStatus: React.FC<{ drawerId: string; u: number }> = ({ drawerId, u }) => {
  const word = useCabinetUi(s => s.busy[drawerId])
  return word ? <div style={{ width: '100%', color: 'rgba(255,255,255,0.65)', fontSize: 11 * u }}>{word}</div> : null
}
