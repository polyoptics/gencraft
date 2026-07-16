// ViewportSwitcherStrip.tsx — the model "playlist" chips at the bottom of
// a viewport window, listing every model docked to it (derived — see
// useDockedModels). Click a chip → that model loads. Also owns the
// active-model RECONCILIATION: default to the first docked model, fall
// back when the active one undocks, clear when nothing is docked.
// Reconciliation is debounced (300ms) so a tile mid-drag crossing the
// dock boundary doesn't thrash model loads.

import React, { useEffect, useRef } from 'react'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useDockedModels } from '../../hooks/useDockedModels'
import { useResolvedMedia } from '../../utils/useResolvedMedia'

export const ViewportSwitcherStrip: React.FC<{ windowId: string }> = ({ windowId }) => {
  const win = useViewport3DStore(s => s.windows[windowId])
  const setActiveModel = useViewport3DStore(s => s.setActiveModel)
  const zoom = useCanvasStore(s => s.zoom)
  const docked = useDockedModels(windowId)
  const reconcileTimer = useRef<number | null>(null)

  const active = win?.activeModelUrl ?? null

  // ── Reconciliation (debounced for drag-transition stability) ──
  useEffect(() => {
    if (!win) return
    const desired = docked.length === 0
      ? null
      : (active && docked.some(m => m.url === active)) ? active : docked[0].url
    if (desired === active) {
      if (reconcileTimer.current !== null) { window.clearTimeout(reconcileTimer.current); reconcileTimer.current = null }
      return
    }
    if (reconcileTimer.current !== null) window.clearTimeout(reconcileTimer.current)
    reconcileTimer.current = window.setTimeout(() => {
      reconcileTimer.current = null
      // Re-check against live state — things move fast during drags.
      const liveWin = useViewport3DStore.getState().windows[windowId]
      if (liveWin && liveWin.activeModelUrl === active) {
        setActiveModel(windowId, desired)
      }
    }, 300)
    return () => {
      if (reconcileTimer.current !== null) { window.clearTimeout(reconcileTimer.current); reconcileTimer.current = null }
    }
  }, [win, docked, active, windowId, setActiveModel])

  if (!win || docked.length < 2) return null   // a single model needs no picker

  const iz = 1 / zoom
  return (
    <div
      onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}
      onWheel={e => e.stopPropagation()}
      style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        display: 'flex', alignItems: 'center', gap: 4 * iz,
        padding: `${4 * iz}px ${6 * iz}px`,
        background: 'rgba(13,14,26,0.85)',
        borderTop: `${Math.max(1, 1 / zoom)}px solid rgba(140,170,255,0.15)`,
        overflowX: 'hidden',
      }}
    >
      {docked.map(m => (
        <ModelChip
          key={m.url}
          name={m.name}
          posterUrl={m.posterUrl ?? null}
          isActive={m.url === active}
          iz={iz}
          onClick={() => setActiveModel(windowId, m.url)}
        />
      ))}
    </div>
  )
}

const ModelChip: React.FC<{
  name: string
  posterUrl: string | null
  isActive: boolean
  iz: number
  onClick: () => void
}> = ({ name, posterUrl, isActive, iz, onClick }) => {
  const resolvedPoster = useResolvedMedia(posterUrl)
  return (
    <div
      onClick={onClick}
      title={name}
      style={{
        display: 'flex', alignItems: 'center', gap: 4 * iz,
        padding: `${2 * iz}px ${6 * iz}px`,
        borderRadius: 5 * iz,
        background: isActive ? 'rgba(120,170,255,0.22)' : 'rgba(255,255,255,0.06)',
        border: `${Math.max(1, iz)}px solid ${isActive ? 'rgba(140,190,255,0.55)' : 'rgba(255,255,255,0.1)'}`,
        cursor: 'pointer',
        flexShrink: 0,
        maxWidth: 110 * iz,
      }}
    >
      {resolvedPoster ? (
        <img src={resolvedPoster} draggable={false} style={{ width: 16 * iz, height: 12 * iz, objectFit: 'cover', borderRadius: 2 * iz, flexShrink: 0 }} />
      ) : (
        <span style={{ fontSize: 8 * iz, color: 'rgba(160,200,255,0.7)', flexShrink: 0 }}>◆</span>
      )}
      <span style={{
        fontSize: 9 * iz, color: isActive ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.55)',
        fontWeight: isActive ? 700 : 500,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        userSelect: 'none',
      }}>{name}</span>
    </div>
  )
}
