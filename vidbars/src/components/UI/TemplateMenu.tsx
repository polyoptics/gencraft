import React, { useState, useRef, useEffect } from 'react'
import { useBoardsStore, freshCanvasBoards } from '../../store/boardsStore'
import type { BoardData, ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { ensureRolodexHome } from '../../utils/rolodexHome'
import { TEMPLATES } from '../../data/templates'
import type { TemplateData } from '../../data/templates'
import { SCAFFOLDS, instantiateScaffold } from '../../data/scaffolds'
import type { ScaffoldData } from '../../data/scaffolds'
import { insertProjectSnapshot } from '../../utils/projectInsert'
import { collectKeep, applyKeep } from '../../utils/cardKeep'
import { getGroupHeight } from '../../utils/nleRows'
import { keepDesignZone, zoomZonesSnapshot, applyZoomZonesSnapshot } from '../../store/zoomZonesStore'

interface SnapshotMeta { id: string; name: string; savedAt: number; file: string }

// Unified shape that lets the menu render scaffolds + presets the same way
type TemplateEntry =
  | { kind: 'scaffold'; data: ScaffoldData }
  | { kind: 'preset';   data: TemplateData }

export const TemplateMenu: React.FC = () => {
  const [open, setOpen] = useState(false)
  const [savingProject, setSavingProject] = useState(false)
  const [projectName, setProjectName] = useState('')
  const projectInputRef = useRef<HTMLInputElement>(null)
  const ref = useRef<HTMLDivElement>(null)
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([])
  const [busyFile, setBusyFile] = useState<string | null>(null)

  // ── Confirmation dialog state ──
  // When set, a modal yes/no overlay renders. Yes calls onYes; No clears.
  const [confirm, setConfirm] = useState<{
    message: string
    onYes: () => void
  } | null>(null)
  const yesBtnRef = useRef<HTMLButtonElement>(null)

  const setPan = useCanvasStore(s => s.setPan)
  const setZoom = useCanvasStore(s => s.setZoom)
  const setBoardPos = useCanvasStore(s => s.setBoardPos)

  useEffect(() => {
    if (!open) { setSavingProject(false); setProjectName('') }
  }, [open])

  useEffect(() => {
    if (savingProject) projectInputRef.current?.focus()
  }, [savingProject])

  // Fetch snapshot list when menu opens
  useEffect(() => {
    if (!open) return
    fetch('/api/snapshots/list').then(r => r.json()).then(setSnapshots).catch(() => {})
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Focus the Yes button when the confirm dialog opens, and wire Esc to cancel.
  useEffect(() => {
    if (!confirm) return
    yesBtnRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setConfirm(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm])

  /** Wraps an action in the yes/no confirmation dialog. */
  function ask(message: string, action: () => void) {
    setConfirm({ message, onYes: action })
  }

  // ── Snapshot helpers ─────────────────────────────────────────

  function getCurrentSnapshot() {
    const bs = useBoardsStore.getState()
    const cs = useCanvasStore.getState()
    const fn = useFreeNodeStore.getState()

    const primary = bs.boards['primary']
    const { bars, rootIds, projectName: pName } = primary ?? { bars: {}, rootIds: [], projectName: 'Block' }

    const allBars = Object.values(bars)
    const canvasWidth = allBars.length > 0 ? Math.max(...allBars.map(b => b.x + b.width)) : 800

    const extraBoards = bs.boardOrder
      .map(id => bs.boards[id])
      .filter(Boolean)
      .map(b => ({ ...b, selectedIds: [], viewerBarId: null }))

    const content = {
      projectName: pName,
      bars,
      rootIds,
      pan: cs.pan,
      boardPos: cs.boardPos,
      zoom: cs.zoom,
      canvasWidth,
      nleRowHeight: cs.nleRowHeight,
      extraBoards,
      boardOrder: bs.boardOrder,
      groups: bs.groups,
      freeNodes: fn.nodes,
      // How the zoom was split between Cards / Blocks / Boards.
      zoomZones: zoomZonesSnapshot(),
    }
    // What is kept beside the cards and tiles goes into the save with them
    // (utils/cardKeep): how their 3D models are turned and set, their notes.
    return { ...content, keep: collectKeep(bs.groups.map(g => g.id), Object.keys(fn.nodes), JSON.stringify(content)) }
  }

  /** Find the next available Y position below all existing groups */
  function nextFreeY(): number {
    const bs = useBoardsStore.getState()
    let maxBottom = 0
    bs.groups.forEach(g => {
      const h = getGroupHeight(g.boardIds, bs.boards)
      const bottom = g.originY + h
      if (bottom > maxBottom) maxBottom = bottom
    })
    return maxBottom + 60
  }

  // ── Project actions (load / insert / overwrite / delete / save) ──

  async function loadProject(file: string) {
    setBusyFile(file)
    try {
      const res = await fetch(`/api/snapshots/load/${file}`)
      const t = await res.json()
      if (!t || !t.bars) return

      // Replace canvas: primary content + extras + groups + free nodes.
      // 'primary' may be gone (deleting its card deletes it); loadLayout only
      // fills a board that exists, so give it a fresh one first.
      if (!useBoardsStore.getState().boards.primary) {
        const { primary } = freshCanvasBoards().boards
        useBoardsStore.setState(s => ({ boards: { ...s.boards, primary } }))
      }
      useBoardsStore.getState().loadLayout('primary', {
        bars: t.bars, rootIds: t.rootIds, projectName: t.projectName,
      })
      const bs = useBoardsStore.getState()
      bs.boardOrder.slice().forEach(id => useBoardsStore.getState().deleteBoard(id))
      if (t.extraBoards && t.boardOrder) {
        t.extraBoards.forEach((board: BoardData) => {
          useBoardsStore.setState(s => ({
            boards: { ...s.boards, [board.id]: { ...board, selectedIds: [], viewerBarId: null } },
            boardOrder: [...s.boardOrder, board.id],
          }))
        })
      }
      if (t.groups) useBoardsStore.setState({ groups: t.groups })
      // A project saved after its 'primary' card was deleted has no card for
      // it: the fresh board above would otherwise sit loose on the canvas.
      if (!useBoardsStore.getState().groups.some(g => g.boardIds.includes('primary'))) {
        useBoardsStore.getState().deleteBoard('primary')
      }
      if (t.freeNodes) useFreeNodeStore.setState({ nodes: t.freeNodes, selectedIds: [] })
      applyKeep(t.keep)
      // The project's own zoom zones when it saved them — then its zoom is
      // already on the level it was saved at. Older projects keep the
      // current zones and are moved onto the level they were made for.
      if (applyZoomZonesSnapshot(t.zoomZones)) setZoom(t.zoom)
      else setZoom(keepDesignZone(t.zoom))
      setPan(t.pan)
      if (t.boardPos) setBoardPos(t.boardPos)
      setOpen(false)
    } finally {
      setBusyFile(null)
    }
  }

  async function insertProject(file: string) {
    setBusyFile(file)
    try {
      const res = await fetch(`/api/snapshots/load/${file}`)
      const t = await res.json()
      if (!t) return
      insertProjectSnapshot(t, nextFreeY())
      setOpen(false)
    } finally {
      setBusyFile(null)
    }
  }

  async function overwriteProject(meta: SnapshotMeta) {
    // Save endpoint writes to `<safeName>.json`, so reusing the same name
    // overwrites the same file on disk.
    const snapshot = { name: meta.name, id: meta.id, savedAt: Date.now(), ...getCurrentSnapshot() }
    await fetch('/api/snapshots/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    })
    fetch('/api/snapshots/list').then(r => r.json()).then(setSnapshots).catch(() => {})
  }

  async function deleteProject(file: string) {
    await fetch(`/api/snapshots/delete/${file}`, { method: 'DELETE' })
    setSnapshots(s => s.filter(sn => sn.file !== file))
  }

  async function saveCurrentAsProject() {
    const name = projectName.trim()
    if (!name) return
    const snapshot = { name, id: crypto.randomUUID(), savedAt: Date.now(), ...getCurrentSnapshot() }
    await fetch('/api/snapshots/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    })
    setSavingProject(false)
    setProjectName('')
    fetch('/api/snapshots/list').then(r => r.json()).then(setSnapshots).catch(() => {})
  }

  // ── Template actions (load / insert) ───────────────────────────

  function loadTemplate(entry: TemplateEntry) {
    if (entry.kind === 'preset') {
      const t = entry.data
      // A fresh canvas, not the old one emptied: deleting the extra boards
      // left the previous project's default card behind — its name, hero,
      // position and deck membership — so a card hidden on the canvas
      // still showed in the Card Browser.
      useBoardsStore.setState(freshCanvasBoards())
      useFreeNodeStore.setState({ nodes: {}, selectedIds: [] })
      ensureRolodexHome()   // pointer now dangles — re-mint at the seed position
      setBoardPos({ x: 0, y: 0 })
      useBoardsStore.getState().loadTemplate('primary', t.id)
      if (t.card) {
        const bs = useBoardsStore.getState()
        const g = bs.groups.find(gr => gr.boardIds.includes('primary'))
        if (g) {
          bs.setGroupCardSize(g.id, t.card.width, t.card.height)
          // A card-shaped template is a grid card (utils/cardGrid): what is
          // dropped in fills cells inside it instead of growing it sideways.
          useBoardsStore.setState(st => ({ groups: st.groups.map(gr => gr.id === g.id ? { ...gr, layout: 'grid' as const } : gr) }))
        }
      }
      setZoom(keepDesignZone(t.zoom))
      const toolbarH = 40
      const canvasH = window.innerHeight - toolbarH
      setPan({
        x: Math.max(20, (window.innerWidth - t.canvasWidth * t.zoom) / 2),
        y: Math.round(canvasH * 0.18),
      })
    } else {
      // Scaffold: generate a fresh instance, fold the first block into primary,
      // remaining blocks become extras inside the same group.
      const inst = instantiateScaffold(entry.data.id, 0, 0)
      if (!inst || inst.boards.length === 0) return
      const bs = useBoardsStore.getState()
      bs.boardOrder.slice().forEach(bid => useBoardsStore.getState().deleteBoard(bid))
      useFreeNodeStore.setState({ nodes: {}, selectedIds: [] })
      ensureRolodexHome()   // pointer now dangles — re-mint at the seed position

      const [first, ...rest] = inst.boards
      useBoardsStore.setState(s => {
        const newPrimary: BoardData = {
          // 'primary' may have been deleted along with its card.
          ...(s.boards.primary ?? freshCanvasBoards().boards.primary),
          bars: first.bars,
          rootIds: first.rootIds,
          projectName: first.projectName,
          color: first.color,
          nleRow: 0,
          nleX: 0,
          layers: first.layers,
          pristine: true,
          selectedIds: [],
          viewerBarId: null,
          savedCollapsedState: null,
        }
        const newBoards: Record<string, BoardData> = { primary: newPrimary }
        rest.forEach(b => { newBoards[b.id] = b })
        const newGroup: ProjectGroup = {
          ...inst.group,
          boardIds: ['primary', ...rest.map(b => b.id)],
          originX: 0,
          originY: 0,
        }
        return {
          boards: newBoards,
          boardOrder: rest.map(b => b.id),
          groups: [newGroup],
        }
      })

      setBoardPos({ x: 0, y: 0 })
      setZoom(keepDesignZone(0.85))
      setPan({ x: 100, y: 100 })
    }
    setOpen(false)
  }

  function insertTemplate(entry: TemplateEntry) {
    if (entry.kind === 'preset') {
      const t = entry.data
      const freeY = nextFreeY()
      const newId = useBoardsStore.getState().createBoard(0, 0)
      useBoardsStore.getState().loadTemplate(newId, t.id)
      const bs = useBoardsStore.getState()
      const group = bs.groups.find(g => g.boardIds.includes(newId))
      if (group) useBoardsStore.getState().setGroupPos(group.id, freeY, 0)
      if (group && t.card) {
        useBoardsStore.getState().setGroupCardSize(group.id, t.card.width, t.card.height)
        useBoardsStore.setState(st => ({ groups: st.groups.map(gr => gr.id === group.id ? { ...gr, layout: 'grid' as const } : gr) }))
      }
    } else {
      const inst = instantiateScaffold(entry.data.id, nextFreeY(), 0)
      if (!inst) return
      useBoardsStore.setState(s => {
        const newBoards = { ...s.boards }
        inst.boards.forEach(b => { newBoards[b.id] = b })
        return {
          boards: newBoards,
          boardOrder: [...s.boardOrder, ...inst.boards.map(b => b.id)],
          groups: [...s.groups, inst.group],
        }
      })
    }
    setOpen(false)
  }

  // ── Styles ─────────────────────────────────────────────────────

  const btnStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    textAlign: 'left',
    background: 'none',
    border: 'none',
    borderRadius: 5,
    color: 'rgba(255,255,255,0.70)',
    fontSize: 11,
    fontWeight: 500,
    padding: '7px 10px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    letterSpacing: '0.2px',
    gap: 6,
  }

  // Hover colors are applied imperatively via mouseEnter/Leave below, since
  // React has no inline :hover. This base style is shared by every icon button.
  const iconBtn: React.CSSProperties = {
    background: 'none',
    border: 'none',
    color: 'rgba(255,255,255,0.22)',
    fontSize: 13,
    cursor: 'pointer',
    padding: '4px 4px 4px 2px',
    lineHeight: 1,
    flexShrink: 0,
  }

  // Build the unified template list (scaffolds first, then presets)
  const templateEntries: TemplateEntry[] = [
    ...SCAFFOLDS.map<TemplateEntry>(s => ({ kind: 'scaffold', data: s })),
    ...TEMPLATES.map<TemplateEntry>(t => ({ kind: 'preset', data: t })),
  ]

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: open ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 6,
          color: 'rgba(255,255,255,0.55)',
          fontSize: 11,
          fontWeight: 600,
          padding: '4px 10px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          fontFamily: 'inherit',
          letterSpacing: '0.2px',
        }}
      >
        Templates
        <svg width="8" height="5" viewBox="0 0 8 5" fill="none">
          <path d="M1 1l3 3 3-3" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          right: 0,
          background: '#1a1b2e',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 8,
          padding: '4px',
          minWidth: 220,
          zIndex: 1000,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}>

          {/* ── Projects (your saved canvases) ── */}
          <div style={{ padding: '4px 10px 2px', fontSize: 9, color: 'rgba(255,255,255,0.28)', letterSpacing: '0.6px', textTransform: 'uppercase' }}>
            Projects
          </div>
          {snapshots.map(sn => (
            <div key={sn.file} style={{ display: 'flex', alignItems: 'center' }}>
              <button
                style={{ ...btnStyle, flex: 1, color: busyFile === sn.file ? 'rgba(120,170,255,0.9)' : 'rgba(255,255,255,0.70)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                onClick={() => ask(`Load project "${sn.name}"? This replaces your current canvas.`, () => loadProject(sn.file))}
              >
                {busyFile === sn.file ? 'Loading…' : sn.name}
              </button>
              <button
                title="Insert as new group on canvas"
                style={iconBtn}
                onMouseEnter={e => (e.currentTarget.style.color = 'rgba(120,170,255,0.8)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.22)')}
                onClick={e => {
                  e.stopPropagation()
                  ask(`Insert "${sn.name}" into current canvas?`, () => insertProject(sn.file))
                }}
              >+</button>
              <button
                title="Overwrite this project with current canvas"
                style={iconBtn}
                onMouseEnter={e => (e.currentTarget.style.color = 'rgba(120,200,120,0.8)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.22)')}
                onClick={e => {
                  e.stopPropagation()
                  ask(`Overwrite "${sn.name}" with current canvas?`, () => overwriteProject(sn))
                }}
              >↺</button>
              <button
                title="Delete project file"
                style={{ ...iconBtn, padding: '4px 8px 4px 2px' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,100,100,0.7)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.22)')}
                onClick={e => {
                  e.stopPropagation()
                  ask(`Delete project "${sn.name}"? This cannot be undone.`, () => deleteProject(sn.file))
                }}
              >×</button>
            </div>
          ))}
          {savingProject ? (
            <div style={{ padding: '6px 8px', display: 'flex', gap: 6 }}>
              <input
                ref={projectInputRef}
                value={projectName}
                onChange={e => setProjectName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    const name = projectName.trim()
                    if (!name) return
                    ask(`Save current canvas as new project "${name}"?`, saveCurrentAsProject)
                  }
                  if (e.key === 'Escape') { setSavingProject(false); setProjectName('') }
                }}
                placeholder="Project name…"
                style={{
                  flex: 1, background: 'rgba(255,255,255,0.07)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 5, outline: 'none',
                  color: '#fff', fontSize: 11, padding: '4px 8px',
                  fontFamily: 'inherit',
                }}
              />
              <button
                onClick={() => {
                  const name = projectName.trim()
                  if (!name) return
                  ask(`Save current canvas as new project "${name}"?`, saveCurrentAsProject)
                }}
                style={{
                  background: 'rgba(100,200,120,0.25)', border: '1px solid rgba(100,200,120,0.4)',
                  borderRadius: 5, color: 'rgba(255,255,255,0.85)',
                  fontSize: 11, fontWeight: 600, padding: '4px 10px',
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >Save</button>
            </div>
          ) : (
            <button
              style={{ ...btnStyle, color: 'rgba(100,200,120,0.75)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
              onClick={() => setSavingProject(true)}
            >
              + Save current canvas as project
            </button>
          )}

          <div style={{ margin: '4px 8px', borderTop: '1px solid rgba(255,255,255,0.07)' }} />

          {/* ── Templates (scaffolds + presets unified) ── */}
          <div style={{ padding: '4px 10px 2px', fontSize: 9, color: 'rgba(255,255,255,0.28)', letterSpacing: '0.6px', textTransform: 'uppercase' }}>
            Templates
          </div>
          {templateEntries.map(entry => {
            const id = entry.kind === 'scaffold' ? entry.data.id : entry.data.id
            const name = entry.kind === 'scaffold' ? entry.data.name : entry.data.label
            const subtitle = entry.kind === 'scaffold' ? entry.data.description : null
            const color = entry.kind === 'scaffold' ? entry.data.color : '#5b8dd9'
            const blockCount = entry.kind === 'scaffold' ? entry.data.blocks.length : 1
            return (
              <div key={`${entry.kind}-${id}`} style={{ display: 'flex', alignItems: 'center' }}>
                <button
                  style={{ ...btnStyle, flex: 1 }}
                  title={subtitle ?? undefined}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                  onClick={() => ask(
                    `Load template "${name}"? This replaces your current canvas.`,
                    () => loadTemplate(entry),
                  )}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: 2,
                      background: color, flexShrink: 0,
                    }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {name}
                    </span>
                  </span>
                  <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10, flexShrink: 0 }}>
                    {blockCount}
                  </span>
                </button>
                <button
                  title="Insert as new group on canvas"
                  style={{ ...iconBtn, padding: '4px 8px 4px 2px' }}
                  onMouseEnter={e => (e.currentTarget.style.color = 'rgba(120,170,255,0.8)')}
                  onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.22)')}
                  onClick={e => {
                    e.stopPropagation()
                    ask(`Insert "${name}" into current canvas?`, () => insertTemplate(entry))
                  }}
                >+</button>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Confirmation dialog ── */}
      {confirm && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 2000,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setConfirm(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#1f2138',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 10,
              padding: '18px 20px 14px',
              minWidth: 280,
              maxWidth: 420,
              boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
              fontFamily: 'inherit',
            }}
          >
            <div style={{
              color: 'rgba(255,255,255,0.92)',
              fontSize: 13,
              lineHeight: 1.45,
              marginBottom: 14,
            }}>
              {confirm.message}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setConfirm(null)}
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 5,
                  color: 'rgba(255,255,255,0.7)',
                  fontSize: 11, fontWeight: 500,
                  padding: '6px 14px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >No</button>
              <button
                ref={yesBtnRef}
                onClick={() => {
                  const action = confirm.onYes
                  setConfirm(null)
                  action()
                }}
                style={{
                  background: 'rgba(100,150,255,0.35)',
                  border: '1px solid rgba(100,150,255,0.55)',
                  borderRadius: 5,
                  color: 'rgba(255,255,255,0.95)',
                  fontSize: 11, fontWeight: 600,
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  outline: 'none',
                  boxShadow: '0 0 0 2px rgba(100,150,255,0.35)',
                }}
              >Yes</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
