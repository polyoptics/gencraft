import React, { useState, useRef, useEffect } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useUserTemplateStore } from '../../store/userTemplateStore'
import type { SavedTemplate } from '../../store/userTemplateStore'
import { TEMPLATES } from '../../data/templates'

export const TemplateMenu: React.FC = () => {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveName, setSaveName] = useState('')
  const saveInputRef = useRef<HTMLInputElement>(null)
  const ref = useRef<HTMLDivElement>(null)

  const setPan = useCanvasStore(s => s.setPan)
  const setZoom = useCanvasStore(s => s.setZoom)
  const setBoardPos = useCanvasStore(s => s.setBoardPos)

  const userTemplates = useUserTemplateStore(s => s.templates)
  const saveTemplate = useUserTemplateStore(s => s.saveTemplate)
  const removeTemplate = useUserTemplateStore(s => s.removeTemplate)
  const updateTemplate = useUserTemplateStore(s => s.updateTemplate)

  useEffect(() => {
    if (!open) { setSaving(false); setSaveName('') }
  }, [open])

  useEffect(() => {
    if (saving) saveInputRef.current?.focus()
  }, [saving])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function getCurrentSnapshot(): Omit<SavedTemplate, 'id' | 'savedAt' | 'name'> {
    const bs = useBoardsStore.getState()
    const cs = useCanvasStore.getState()
    const fn = useFreeNodeStore.getState()

    const primary = bs.boards['primary']
    const { bars, rootIds, projectName } = primary ?? { bars: {}, rootIds: [], projectName: 'storyMap' }

    const allBars = Object.values(bars)
    const canvasWidth = allBars.length > 0 ? Math.max(...allBars.map(b => b.x + b.width)) : 800

    // Extra boards — strip transient state (selection, open viewer)
    const extraBoards = bs.boardOrder
      .map(id => bs.boards[id])
      .filter(Boolean)
      .map(b => ({ ...b, selectedIds: [], viewerBarId: null }))

    return {
      projectName,
      bars,
      rootIds,
      pan: cs.pan,
      boardPos: cs.boardPos,
      zoom: cs.zoom,
      canvasWidth,
      nleRowHeight: cs.nleRowHeight,
      extraBoards,
      boardOrder: bs.boardOrder,
      freeNodes: fn.nodes,
    }
  }

  /** Find the next available NLE row (one below the last used row) */
  function nextFreeRow(): number {
    const bs = useBoardsStore.getState()
    const cs = useCanvasStore.getState()
    const pRow = Math.max(0, Math.round(cs.boardPos.y / cs.nleRowHeight))
    let maxRow = pRow
    for (const bid of bs.boardOrder) {
      const b = bs.boards[bid]
      if (b) maxRow = Math.max(maxRow, Math.round(b.nleRow))
    }
    return maxRow + 1
  }

  function applyBuiltIn(id: string) {
    const t = TEMPLATES.find(t => t.id === id)
    if (!t) return
    // Clear extra boards
    const bs = useBoardsStore.getState()
    bs.boardOrder.slice().forEach(bid => useBoardsStore.getState().deleteBoard(bid))
    // Clear free nodes
    useFreeNodeStore.setState({ nodes: {}, selectedIds: [] })
    // Reset boardPos
    setBoardPos({ x: 0, y: 0 })
    useBoardsStore.getState().loadTemplate('primary', id)
    setZoom(t.zoom)
    const toolbarH = 40
    const canvasH = window.innerHeight - toolbarH
    setPan({
      x: Math.max(20, (window.innerWidth - t.canvasWidth * t.zoom) / 2),
      y: Math.round(canvasH * 0.18),
    })
    setOpen(false)
  }

  function addBuiltInAsBoard(id: string) {
    const t = TEMPLATES.find(t => t.id === id)
    if (!t) return
    const row = nextFreeRow()
    const newId = useBoardsStore.getState().createBoard(row, 0)
    useBoardsStore.getState().loadTemplate(newId, id)
    setOpen(false)
  }

  function addUserTemplateAsBoard(id: string) {
    const t = userTemplates.find(t => t.id === id)
    if (!t) return
    const row = nextFreeRow()
    const newId = useBoardsStore.getState().createBoard(row, 0)
    useBoardsStore.getState().loadLayout(newId, {
      bars: t.bars,
      rootIds: t.rootIds,
      projectName: t.projectName,
    })
    setOpen(false)
  }

  function applyUserTemplate(id: string) {
    const t = userTemplates.find(t => t.id === id)
    if (!t) return

    // Restore primary board
    useBoardsStore.getState().loadLayout('primary', {
      bars: t.bars,
      rootIds: t.rootIds,
      projectName: t.projectName,
    })

    // Restore extra boards — clear existing extras first, then add saved ones
    const bs = useBoardsStore.getState()
    bs.boardOrder.slice().forEach(id => useBoardsStore.getState().deleteBoard(id))
    if (t.extraBoards && t.boardOrder) {
      t.extraBoards.forEach(board => {
        useBoardsStore.setState(s => ({
          boards: { ...s.boards, [board.id]: { ...board, selectedIds: [], viewerBarId: null } },
          boardOrder: [...s.boardOrder, board.id],
        }))
      })
    }

    // Restore free nodes
    if (t.freeNodes) {
      useFreeNodeStore.setState({ nodes: t.freeNodes, selectedIds: [] })
    }

    // Restore canvas
    setZoom(t.zoom)
    setPan(t.pan)
    if (t.boardPos) setBoardPos(t.boardPos)

    setOpen(false)
  }

  function overwriteTemplate(id: string) {
    const existing = userTemplates.find(t => t.id === id)
    if (!existing) return
    updateTemplate(id, { name: existing.name, ...getCurrentSnapshot() })
  }

  function commitSave() {
    const name = saveName.trim()
    if (!name) return
    saveTemplate({ name, ...getCurrentSnapshot() })
    setSaving(false)
    setSaveName('')
    setOpen(false)
  }

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
          minWidth: 180,
          zIndex: 1000,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}>

          {/* ── User-saved templates ── */}
          {userTemplates.length > 0 && (
            <>
              <div style={{ padding: '4px 10px 2px', fontSize: 9, color: 'rgba(255,255,255,0.28)', letterSpacing: '0.6px', textTransform: 'uppercase' }}>
                Saved
              </div>
              {userTemplates.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center' }}>
                  <button
                    style={{ ...btnStyle, flex: 1 }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                    onClick={() => applyUserTemplate(t.id)}
                  >
                    {t.name}
                  </button>
                  <button
                    title="Add as new board"
                    style={{
                      background: 'none', border: 'none',
                      color: 'rgba(255,255,255,0.22)', fontSize: 13,
                      cursor: 'pointer', padding: '4px 4px 4px 2px',
                      lineHeight: 1, flexShrink: 0,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'rgba(120,170,255,0.8)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.22)')}
                    onClick={e => { e.stopPropagation(); addUserTemplateAsBoard(t.id) }}
                  >+</button>
                  <button
                    title="Overwrite with current layout"
                    style={{
                      background: 'none', border: 'none',
                      color: 'rgba(255,255,255,0.22)', fontSize: 12,
                      cursor: 'pointer', padding: '4px 4px 4px 2px',
                      lineHeight: 1, flexShrink: 0,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'rgba(120,200,120,0.8)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.22)')}
                    onClick={e => { e.stopPropagation(); overwriteTemplate(t.id) }}
                  >↺</button>
                  <button
                    title="Delete saved layout"
                    style={{
                      background: 'none', border: 'none',
                      color: 'rgba(255,255,255,0.22)', fontSize: 13,
                      cursor: 'pointer', padding: '4px 8px 4px 2px',
                      lineHeight: 1, flexShrink: 0,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,100,100,0.7)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.22)')}
                    onClick={e => { e.stopPropagation(); removeTemplate(t.id) }}
                  >×</button>
                </div>
              ))}
              <div style={{ margin: '4px 8px', borderTop: '1px solid rgba(255,255,255,0.07)' }} />
            </>
          )}

          {/* ── Built-in templates ── */}
          <div style={{ padding: '4px 10px 2px', fontSize: 9, color: 'rgba(255,255,255,0.28)', letterSpacing: '0.6px', textTransform: 'uppercase' }}>
            Presets
          </div>
          {TEMPLATES.map(t => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center' }}>
              <button
                style={{ ...btnStyle, flex: 1 }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                onClick={() => applyBuiltIn(t.id)}
              >
                {t.label}
              </button>
              <button
                title="Add as new board"
                style={{
                  background: 'none', border: 'none',
                  color: 'rgba(255,255,255,0.22)', fontSize: 13,
                  cursor: 'pointer', padding: '4px 8px 4px 2px',
                  lineHeight: 1, flexShrink: 0,
                }}
                onMouseEnter={e => (e.currentTarget.style.color = 'rgba(120,170,255,0.8)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.22)')}
                onClick={e => { e.stopPropagation(); addBuiltInAsBoard(t.id) }}
              >+</button>
            </div>
          ))}

          <div style={{ margin: '4px 8px', borderTop: '1px solid rgba(255,255,255,0.07)' }} />

          {/* ── Save current ── */}
          {saving ? (
            <div style={{ padding: '6px 8px', display: 'flex', gap: 6 }}>
              <input
                ref={saveInputRef}
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitSave()
                  if (e.key === 'Escape') { setSaving(false); setSaveName('') }
                }}
                placeholder="Layout name…"
                style={{
                  flex: 1, background: 'rgba(255,255,255,0.07)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 5, outline: 'none',
                  color: '#fff', fontSize: 11, padding: '4px 8px',
                  fontFamily: 'inherit',
                }}
              />
              <button
                onClick={commitSave}
                style={{
                  background: 'rgba(100,150,255,0.25)', border: '1px solid rgba(100,150,255,0.4)',
                  borderRadius: 5, color: 'rgba(255,255,255,0.85)',
                  fontSize: 11, fontWeight: 600, padding: '4px 10px',
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >Save</button>
            </div>
          ) : (
            <button
              style={{ ...btnStyle, color: 'rgba(120,170,255,0.75)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
              onClick={() => setSaving(true)}
            >
              + Save current layout
            </button>
          )}
        </div>
      )}
    </div>
  )
}
