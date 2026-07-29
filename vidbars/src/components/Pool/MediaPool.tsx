// MediaPool.tsx — the media pool / generation history component.
//
// One component, two GROUPINGS, because they are the same thing seen from
// two angles: a set of images with metadata and a big preview.
//
//   POOL     — flat, newest first. Everything generated, plus anything
//              loaded from a folder on disk.
//   HISTORY  — the same items grouped by generation session, each row
//              carrying the prompt that produced it, recallable.
//
// It reads the shared generation store rather than talking to any other
// component, which is what lets a Prompt Pad magneted alongside feed it
// with no wiring between the two.
//
// Local folders come in through the File System Access API. The handle is
// held for the session only; re-picking is one click and avoids asking for
// persistent permission the user did not ask to give.

import React, { useMemo, useRef, useState } from 'react'
import { useGenerationStore } from '../../store/generationStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import { putMedia } from '../../utils/mediaStore'
import { makeMediaRef } from '../../utils/mediaRef'

/** Icon-size ladder — the sml/mid/lrg control in the design. */
const SIZES = [56, 84, 124, 180] as const
type SizeIdx = 0 | 1 | 2 | 3

interface PoolEntry {
  id: string
  url: string
  label: string
  prompt?: string
  sessionId?: string
}

const Thumb: React.FC<{
  entry: PoolEntry
  px: number
  selected: boolean
  onClick: () => void
  onDragOut: (e: React.DragEvent) => void
}> = ({ entry, px, selected, onClick, onDragOut }) => {
  const src = useResolvedMedia(entry.url)
  return (
    <div
      draggable
      onDragStart={onDragOut}
      onClick={onClick}
      title={entry.prompt || entry.label}
      style={{
        width: px, height: px, flexShrink: 0,
        borderRadius: 4,
        background: src ? `#0c0e18 center/cover no-repeat url("${src}")` : 'rgba(255,255,255,0.06)',
        border: selected ? '2px solid rgba(140,190,255,0.95)' : '1px solid rgba(255,255,255,0.12)',
        cursor: 'grab',
        boxShadow: selected ? '0 0 0 1px rgba(140,190,255,0.4)' : undefined,
      }}
    />
  )
}

export const MediaPool: React.FC<{ nodeId: string }> = () => {
  const items = useGenerationStore(s => s.items)
  const sessions = useGenerationStore(s => s.sessions)
  const pending = useGenerationStore(s => s.pending)
  const [mode, setMode] = useState<'pool' | 'history'>('pool')
  const [sizeIdx, setSizeIdx] = useState<SizeIdx>(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [folder, setFolder] = useState<{ name: string; entries: PoolEntry[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const genEntries: PoolEntry[] = useMemo(
    () => items.map(i => ({
      id: i.id, url: i.url, label: i.prompt.slice(0, 40) || 'generated',
      prompt: i.prompt, sessionId: i.sessionId,
    })),
    [items],
  )
  const entries = folder ? [...folder.entries, ...genEntries] : genEntries
  const selected = entries.find(e => e.id === selectedId) ?? entries[0] ?? null
  const previewSrc = useResolvedMedia(selected?.url ?? null)

  /** Read a folder of images into the pool. Bytes go into the blob store so
   *  a dragged-out tile keeps working after the handle is gone. */
  const pickFolder = async () => {
    const picker = (window as unknown as {
      showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
    }).showDirectoryPicker
    if (!picker) { alert('This browser has no folder picker (File System Access API).'); return }
    setLoading(true)
    try {
      const dir = await picker()
      const found: PoolEntry[] = []
      // @ts-expect-error — values() is present on the handle at runtime
      for await (const handle of dir.values()) {
        if (handle.kind !== 'file') continue
        if (!/\.(png|jpe?g|webp|gif|avif)$/i.test(handle.name)) continue
        const file = await handle.getFile()
        const id = await putMedia(file)
        found.push({ id: `f:${handle.name}`, url: makeMediaRef(id), label: handle.name })
        if (found.length >= 400) break     // a folder is not a database
      }
      setFolder({ name: dir.name, entries: found })
    } catch { /* user cancelled */ }
    finally { setLoading(false) }
  }

  /** Drag a pool item out onto the canvas as an image tile. */
  const onDragOut = (entry: PoolEntry) => (e: React.DragEvent) => {
    e.dataTransfer.setData('application/x-vidbars-pool', JSON.stringify({ url: entry.url, label: entry.label }))
    e.dataTransfer.effectAllowed = 'copy'
  }

  /** Same thing without the drag, for when the pool is pinned and the
   *  canvas is somewhere else entirely. */
  const dropToCanvas = (entry: PoolEntry) => {
    const cs = useCanvasStore.getState()
    const fns = useFreeNodeStore.getState()
    useUndoCoordinator.getState().checkpoint()
    const cx = (window.innerWidth / 2 - cs.pan.x) / cs.zoom
    const cy = (window.innerHeight / 2 - cs.pan.y) / cs.zoom
    const id = fns.addFreeNode(cx, cy, 'image')
    fns.updateFreeNode(id, { imageUrl: entry.url, mediaType: 'image', label: entry.label })
    fns.setFreeSelection([id])
  }

  const px = SIZES[sizeIdx]
  const chip = (on: boolean): React.CSSProperties => ({
    background: on ? 'rgba(120,170,255,0.28)' : 'rgba(255,255,255,0.05)',
    border: `1px solid ${on ? 'rgba(140,190,255,0.55)' : 'rgba(255,255,255,0.1)'}`,
    borderRadius: 4, color: on ? '#dce9ff' : 'rgba(255,255,255,0.55)',
    fontSize: 9, fontWeight: 700, letterSpacing: '0.3px',
    padding: '2px 7px', cursor: 'pointer', fontFamily: 'inherit',
  })

  return (
    <div
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        background: '#12131f', overflow: 'hidden', fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* ── Toolbar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '5px 7px',
        borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <button style={chip(mode === 'pool')} onClick={() => setMode('pool')}>POOL</button>
        <button style={chip(mode === 'history')} onClick={() => setMode('history')}>HISTORY</button>
        <div style={{ width: 1, alignSelf: 'stretch', background: 'rgba(255,255,255,0.12)', margin: '0 3px' }} />
        {(['sml', 'mid', 'lrg', 'xl'] as const).map((lbl, i) => (
          <button key={lbl} style={chip(sizeIdx === i)} onClick={() => setSizeIdx(i as SizeIdx)}>{lbl}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button style={chip(false)} onClick={pickFolder} title="Load images from a folder on disk">
          {loading ? '…' : folder ? `📁 ${folder.name}` : '📁 FOLDER'}
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* ── Grid ── */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 7, minWidth: 0 }}>
          {pending > 0 && (
            <div style={{
              fontSize: 10, color: 'rgba(160,200,255,0.8)', marginBottom: 6,
              fontFamily: 'ui-monospace, monospace',
            }}>generating {pending}…</div>
          )}

          {mode === 'pool' ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {entries.map(e => (
                <Thumb key={e.id} entry={e} px={px} selected={selected?.id === e.id}
                  onClick={() => setSelectedId(e.id)} onDragOut={onDragOut(e)} />
              ))}
              {entries.length === 0 && (
                <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, padding: 12 }}>
                  Empty. Load a folder, or magnet a Prompt Pad to this pool and generate.
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {sessions.map(sess => {
                const rows = genEntries.filter(e => e.sessionId === sess.id)
                if (rows.length === 0) return null
                return (
                  <div key={sess.id}>
                    <div style={{
                      display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4,
                      color: 'rgba(180,210,255,0.85)', fontSize: 10, fontWeight: 700,
                    }}>
                      <span>{sess.label}</span>
                      <span style={{ color: 'rgba(255,255,255,0.3)', fontWeight: 400, fontSize: 9 }}>
                        {new Date(sess.startedAt).toLocaleString()} · {rows.length}
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {rows.map(e => (
                        <Thumb key={e.id} entry={e} px={Math.max(48, px * 0.75)} selected={selected?.id === e.id}
                          onClick={() => setSelectedId(e.id)} onDragOut={onDragOut(e)} />
                      ))}
                    </div>
                  </div>
                )
              })}
              {sessions.length === 0 && (
                <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, padding: 12 }}>
                  No generation sessions yet.
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Big preview ── */}
        <div style={{
          width: '38%', minWidth: 120, borderLeft: '1px solid rgba(255,255,255,0.08)',
          display: 'flex', flexDirection: 'column', flexShrink: 0,
        }}>
          <div style={{
            flex: 1, minHeight: 0,
            background: previewSrc ? `#0a0c14 center/contain no-repeat url("${previewSrc}")` : '#0a0c14',
          }} />
          {selected && (
            <div style={{ padding: 6, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{
                fontSize: 9.5, color: 'rgba(255,255,255,0.62)', lineHeight: 1.45,
                maxHeight: 54, overflow: 'auto', marginBottom: 5,
              }}>{selected.prompt || selected.label}</div>
              <button style={{ ...chip(false), width: '100%' }} onClick={() => dropToCanvas(selected)}>
                ↧ PLACE ON CANVAS
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
