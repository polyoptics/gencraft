// ExportProjectDialog — "Export to new project" (utils/exportSelection): what
// was picked, how much comes along with it, and a name, BEFORE anything is
// written. Nothing in it moves or resizes: every line has its place from the
// start.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore } from '../../store/boardsStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useExportProjectStore } from '../../store/exportProjectStore'
import { exportPlan, exportToNewProject, projectFileOf, savedProjectFiles, type ExportPick } from '../../utils/exportSelection'

export const ExportProjectHost: React.FC = () => {
  const pick = useExportProjectStore(s => s.pick)
  return pick ? <ExportProjectDialog pick={pick} /> : null
}

const things = (cards: number, tiles: number) =>
  [cards ? `${cards} card${cards === 1 ? '' : 's'}` : '', tiles ? `${tiles} tile${tiles === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ') || 'nothing'

const ExportProjectDialog: React.FC<{ pick: ExportPick }> = ({ pick }) => {
  const close = useExportProjectStore(s => s.closeExport)
  // Read once, when it opens: what is exported is what was counted.
  const plan = useMemo(() => exportPlan(pick), [pick])
  const first = useMemo(() => {
    const g = useBoardsStore.getState().groups.find(x => x.id === plan.picked.cards[0])
    const n = useFreeNodeStore.getState().nodes[plan.picked.tiles[0]]
    return (g?.name || n?.label || 'Export').trim()
  }, [plan])
  const [name, setName] = useState(first)
  const [taken, setTaken] = useState<Set<string> | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.select() }, [])
  useEffect(() => { void savedProjectFiles().then(setTaken).catch(() => setTaken(new Set())) }, [])

  // A card docked on a loop strip is held there by a stand-in tile that is
  // never drawn: it goes along, and is not counted as a thing of its own.
  const seen = (ids: string[]) => { const nodes = useFreeNodeStore.getState().nodes; return ids.filter(id => !nodes[id]?.cardRef).length }
  const pickedTiles = seen(plan.picked.tiles), linkedTiles = seen(plan.linked.tiles)
  const picked = plan.picked.cards.length + pickedTiles
  const linked = plan.linked.cards.length + linkedTiles
  const clean = name.trim()
  const used = !!clean && !done && !!taken?.has(projectFileOf(clean).toLowerCase())
  const can = !!clean && !used && !busy && !done && picked > 0

  const go = async () => {
    if (!can) return
    setBusy(true); setError(null)
    const out = await exportToNewProject(plan, clean)
    setBusy(false)
    if ('error' in out) setError(out.error)
    else setDone(clean)
  }
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  const btn = (main: boolean, on = true): React.CSSProperties => ({
    padding: '7px 14px', borderRadius: 6, fontSize: 13, color: '#e2e8f0', cursor: on ? 'pointer' : 'default', opacity: on ? 1 : 0.5,
    border: `1px solid ${main ? 'rgba(140,180,255,0.8)' : 'rgba(255,255,255,0.14)'}`,
    background: main ? 'rgba(90,130,230,0.35)' : 'rgba(255,255,255,0.05)',
  })
  const note = error ? { text: error, color: '#ff9b9b' }
    : done ? { text: `Saved as the project "${done}". Open it from the project list; your canvas is as it was.`, color: '#9be3b4' }
    : used ? { text: 'A saved project already has that name.', color: '#ffd27a' }
    : { text: 'Copies go into a new saved project. Your canvas is not changed.', color: 'rgba(226,232,240,0.6)' }

  return ReactDOM.createPortal(
    <div
      data-export-project role="dialog" aria-modal="true" aria-label="Export to new project"
      onPointerDown={stop} onWheel={stop} onContextMenu={stop}
      // The app's shortcuts listen on document: nothing typed here reaches them.
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape' && !busy) close(); if (e.key === 'Enter') void go() }}
      onKeyUp={stop}
      onClick={e => { if (e.target === e.currentTarget && !busy) close() }}
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' }}
    >
      <div style={{ width: 420, maxWidth: '94vw', background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.6)', color: '#e2e8f0', display: 'flex', flexDirection: 'column', gap: 12, padding: 18 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Export to new project</div>
        <div data-export-count style={{ padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.05)', fontSize: 13, lineHeight: 1.5 }}>
          <div><b>{picked} picked, {linked} linked</b></div>
          <div style={{ opacity: 0.75 }}>Picked: {things(plan.picked.cards.length, pickedTiles)}</div>
          <div style={{ opacity: 0.75 }}>Linked, coming along: {things(plan.linked.cards.length, linkedTiles)}</div>
        </div>
        <input
          ref={input} data-export-name value={name} disabled={busy || !!done} placeholder="Project name" autoFocus
          onChange={e => { setName(e.target.value); setError(null) }}
          style={{ padding: '7px 10px', borderRadius: 6, fontSize: 13, color: '#e2e8f0', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.14)', outline: 'none' }}
        />
        <div data-export-note style={{ fontSize: 12, lineHeight: 1.4, height: 34, color: note.color }}>{note.text}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button data-export-go disabled={!can} onClick={() => { void go() }} style={btn(true, can)}>Export</button>
          <button data-export-close disabled={busy} onClick={close} style={btn(false, !busy)}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
