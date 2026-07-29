// MediaPool.tsx — a real media pool: point it at a folder, get its files.
//
// No preview pane, deliberately. Previewing is what a Viewer does, and a
// Viewer magneted to a Rolodex magneted to this pool already gives you
// that — building it in here would be the same job done twice, and would
// argue against the modular idea rather than for it.
//
// Contents go into poolStore rather than component state, which is what
// lets a magneted Rolodex browse this pool without either component
// knowing the other exists.

import React, { useEffect, useState } from 'react'
import { usePoolStore, loadPoolDir, type PoolFile } from '../../store/poolStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { getModelPoster, ensureModelPoster, useModelPoster } from '../../three/posterService'

const SIZES = [48, 72, 108, 156] as const
const SIZE_LABELS = ['sml', 'mid', 'lrg', 'xl'] as const

const KIND_GLYPH: Record<PoolFile['kind'], string> = {
  image: '🖼', video: '▶', audio: '♪', model: '◆',
}

/** One file. Models show their generated poster; everything else shows
 *  itself. A model url is never fed to an <img> — it is not an image. */
const FileTile: React.FC<{
  file: PoolFile
  px: number
  selected: boolean
  onClick: () => void
  onDoubleClick: () => void
}> = ({ file, px, selected, onClick, onDoubleClick }) => {
  const poster = useModelPoster(file.kind === 'model' ? file.url : null)
  useEffect(() => {
    if (file.kind === 'model' && !getModelPoster(file.url)) void ensureModelPoster(file.url)
  }, [file.kind, file.url])

  const src = file.kind === 'model' ? poster : file.kind === 'image' ? file.url : null

  return (
    <div
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('application/x-vidbars-pool',
          JSON.stringify({ url: file.url, label: file.name, kind: file.kind }))
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={`${file.name}${file.size ? ` · ${Math.round(file.size / 1024)}KB` : ''}`}
      style={{
        width: px, height: px, flexShrink: 0, position: 'relative',
        borderRadius: 4,
        background: src
          ? `#0c0e18 center/cover no-repeat url("${src}")`
          : 'rgba(255,255,255,0.05)',
        border: selected ? '2px solid rgba(140,190,255,0.95)' : '1px solid rgba(255,255,255,0.1)',
        cursor: 'grab',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {!src && (
        <span style={{ fontSize: Math.max(11, px * 0.26), opacity: 0.5 }}>{KIND_GLYPH[file.kind]}</span>
      )}
      {file.kind !== 'image' && (
        <span style={{
          position: 'absolute', top: 2, right: 3, fontSize: 8,
          padding: '0 3px', borderRadius: 2, background: 'rgba(0,0,0,0.6)',
          color: 'rgba(180,215,255,0.9)', pointerEvents: 'none',
        }}>{file.kind === 'model' ? '3D' : KIND_GLYPH[file.kind]}</span>
      )}
    </div>
  )
}

export const MediaPool: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const node = useFreeNodeStore(s => s.nodes[nodeId])
  const updateFreeNode = useFreeNodeStore(s => s.updateFreeNode)
  const contents = usePoolStore(s => s.pools[nodeId])
  const [sizeIdx, setSizeIdx] = useState(1)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [pathDraft, setPathDraft] = useState('')
  const [editingPath, setEditingPath] = useState(false)

  const dir = node?.poolDir ?? 'public/uploads'

  // Re-read on mount and whenever the folder changes: a listing is a
  // snapshot of something that moves.
  useEffect(() => { void loadPoolDir(nodeId, dir) }, [nodeId, dir])

  const files = contents?.files ?? []
  const dirs = contents?.dirs ?? []
  const shown = filter.trim()
    ? files.filter(f => f.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : files

  const goTo = (d: string) => { updateFreeNode(nodeId, { poolDir: d }); setSelected(null) }

  /** Double-click drops a file on the canvas as a tile of its own kind. */
  const placeOnCanvas = (f: PoolFile) => {
    const cs = useCanvasStore.getState()
    const fns = useFreeNodeStore.getState()
    useUndoCoordinator.getState().checkpoint()
    const cx = (window.innerWidth / 2 - cs.pan.x) / cs.zoom
    const cy = (window.innerHeight / 2 - cs.pan.y) / cs.zoom
    const id = fns.addFreeNode(cx, cy, f.kind)
    fns.updateFreeNode(id, { imageUrl: f.url, mediaType: f.kind, label: f.name })
    fns.setFreeSelection([id])
  }

  const chip = (on: boolean): React.CSSProperties => ({
    background: on ? 'rgba(120,170,255,0.28)' : 'rgba(255,255,255,0.05)',
    border: `1px solid ${on ? 'rgba(140,190,255,0.55)' : 'rgba(255,255,255,0.1)'}`,
    borderRadius: 4, color: on ? '#dce9ff' : 'rgba(255,255,255,0.55)',
    fontSize: 9, fontWeight: 700, letterSpacing: '0.3px',
    padding: '2px 7px', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
  })

  const px = SIZES[sizeIdx]

  return (
    <div
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        background: '#12131f', overflow: 'hidden', fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* ── Path bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px',
        borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
      }}>
        <button style={chip(false)} title="Up one folder"
          onClick={() => contents?.parent && goTo(contents.parent)}>↑</button>
        {editingPath ? (
          <input
            autoFocus
            value={pathDraft}
            onChange={e => setPathDraft(e.target.value)}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter') { goTo(pathDraft.trim()); setEditingPath(false) }
              if (e.key === 'Escape') setEditingPath(false)
            }}
            onBlur={() => setEditingPath(false)}
            style={{
              flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(140,190,255,0.4)', borderRadius: 3,
              color: 'rgba(255,255,255,0.9)', fontSize: 9.5, padding: '2px 5px',
              fontFamily: 'ui-monospace, monospace', outline: 'none',
            }}
          />
        ) : (
          <div
            onClick={() => { setPathDraft(contents?.dir ?? dir); setEditingPath(true) }}
            title="Click to type a folder path"
            style={{
              flex: 1, minWidth: 0, fontSize: 9.5, color: 'rgba(255,255,255,0.55)',
              fontFamily: 'ui-monospace, monospace', cursor: 'text',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl',
            }}
          >{contents?.dir ?? dir}</div>
        )}
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>
          {contents?.loading ? '…' : `${files.length}`}
        </span>
      </div>

      {/* ── Controls ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 3, padding: '4px 6px',
        borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
      }}>
        {SIZE_LABELS.map((lbl, i) => (
          <button key={lbl} style={chip(sizeIdx === i)} onClick={() => setSizeIdx(i)}>{lbl}</button>
        ))}
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          onKeyDown={e => e.stopPropagation()}
          placeholder="filter…"
          style={{
            flex: 1, minWidth: 40, marginLeft: 4,
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 3, color: 'rgba(255,255,255,0.85)', fontSize: 9.5,
            padding: '2px 6px', fontFamily: 'inherit', outline: 'none',
          }}
        />
        <button style={chip(false)} title="Re-read this folder"
          onClick={() => void loadPoolDir(nodeId, dir)}>⟳</button>
      </div>

      {/* ── Grid ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 6, minHeight: 0 }}>
        {contents?.error && (
          <div style={{ color: 'rgba(255,150,150,0.8)', fontSize: 10, padding: 6 }}>{contents.error}</div>
        )}

        {dirs.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
            {dirs.map(d => (
              <button key={d.path} onClick={() => goTo(d.path)} style={{
                ...chip(false), fontWeight: 500, fontSize: 9.5, letterSpacing: 0,
              }}>📁 {d.name}</button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {shown.map(f => (
            <FileTile
              key={f.id} file={f} px={px}
              selected={selected === f.id}
              onClick={() => setSelected(f.id)}
              onDoubleClick={() => placeOnCanvas(f)}
            />
          ))}
        </div>

        {!contents?.loading && shown.length === 0 && dirs.length === 0 && (
          <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10.5, padding: 10, lineHeight: 1.6 }}>
            Nothing here. Click the path above to point at a folder —
            an absolute path works, or one relative to the project.
          </div>
        )}
      </div>

      <div style={{
        padding: '3px 6px', borderTop: '1px solid rgba(255,255,255,0.08)',
        fontSize: 8.5, color: 'rgba(255,255,255,0.3)', flexShrink: 0,
      }}>
        drag a file to the canvas · double-click to place it · magnet a Rolodex to browse this pool
      </div>
    </div>
  )
}
