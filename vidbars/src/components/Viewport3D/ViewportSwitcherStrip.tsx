// ViewportSwitcherStrip.tsx — the source "playlist" at the bottom of a
// viewport window. One chip per connected SOURCE: tiles show their model
// poster; cards/decks show the card's FACE (hero) with a ×N badge when
// they hold several models — clicking a card chip shows its first model,
// clicking again cycles through them. Also owns the active-model
// RECONCILIATION: default to the first available model, fall back when
// the active one disconnects, clear when nothing is connected — debounced
// (300ms) so a tile mid-drag crossing the boundary doesn't thrash loads.

import React, { useEffect, useRef } from 'react'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useDockedSources, flattenSourceModels, type DockedSource } from '../../hooks/useDockedModels'
import { useResolvedMedia } from '../../utils/useResolvedMedia'

export const ViewportSwitcherStrip: React.FC<{ windowId: string }> = ({ windowId }) => {
  const win = useViewport3DStore(s => s.windows[windowId])
  const setActiveModel = useViewport3DStore(s => s.setActiveModel)
  const zoom = useCanvasStore(s => s.zoom)
  const sources = useDockedSources(windowId)
  const reconcileTimer = useRef<number | null>(null)

  const active = win?.activeModelUrl ?? null
  const flat = flattenSourceModels(sources)

  // ── Reconciliation (debounced for drag-transition stability) ──
  useEffect(() => {
    if (!win) return
    const desired = flat.length === 0
      ? null
      : (active && flat.some(m => m.url === active)) ? active : flat[0].url
    if (desired === active) {
      if (reconcileTimer.current !== null) { window.clearTimeout(reconcileTimer.current); reconcileTimer.current = null }
      return
    }
    if (reconcileTimer.current !== null) window.clearTimeout(reconcileTimer.current)
    reconcileTimer.current = window.setTimeout(() => {
      reconcileTimer.current = null
      const liveWin = useViewport3DStore.getState().windows[windowId]
      if (liveWin && liveWin.activeModelUrl === active) {
        setActiveModel(windowId, desired)
      }
    }, 300)
    return () => {
      if (reconcileTimer.current !== null) { window.clearTimeout(reconcileTimer.current); reconcileTimer.current = null }
    }
  }, [win, flat, active, windowId, setActiveModel])

  // Show when there's a real choice, or any card is connected (a single
  // docked card should still show its face for provenance).
  if (!win || (flat.length < 2 && !sources.some(s => s.kind === 'card'))) return null

  const iz = 1 / zoom
  const onChipClick = (s: DockedSource) => {
    if (s.models.length === 0) return
    const idx = active ? s.models.findIndex(m => m.url === active) : -1
    // Not this source's model yet → its first; else cycle within it.
    const next = idx < 0 ? s.models[0] : s.models[(idx + 1) % s.models.length]
    setActiveModel(windowId, next.url)
  }

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
      {sources.map(s => (
        <SourceChip
          key={`${s.kind}:${s.id}`}
          source={s}
          isActive={!!active && s.models.some(m => m.url === active)}
          iz={iz}
          onClick={() => onChipClick(s)}
        />
      ))}
    </div>
  )
}

const SourceChip: React.FC<{
  source: DockedSource
  isActive: boolean
  iz: number
  onClick: () => void
}> = ({ source, isActive, iz, onClick }) => {
  const resolvedFace = useResolvedMedia(source.face)
  const isCard = source.kind === 'card'
  const count = source.models.length
  return (
    <div
      onClick={onClick}
      title={isCard && count > 1 ? `${source.name} — ${count} models (click to cycle)` : source.name}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'center', gap: 4 * iz,
        padding: `${2 * iz}px ${6 * iz}px`,
        borderRadius: 5 * iz,
        background: isActive ? 'rgba(120,170,255,0.22)' : 'rgba(255,255,255,0.06)',
        border: `${Math.max(1, iz)}px solid ${isActive ? 'rgba(140,190,255,0.55)' : 'rgba(255,255,255,0.1)'}`,
        cursor: 'pointer',
        flexShrink: 0,
        maxWidth: 120 * iz,
      }}
    >
      {resolvedFace ? (
        <img
          src={resolvedFace}
          draggable={false}
          style={{
            width: (isCard ? 18 : 16) * iz,
            height: (isCard ? 22 : 12) * iz,   // cards read as portrait faces
            objectFit: 'cover',
            borderRadius: 2 * iz,
            flexShrink: 0,
          }}
        />
      ) : (
        <span style={{ fontSize: 8 * iz, color: 'rgba(160,200,255,0.7)', flexShrink: 0 }}>{isCard ? '▮' : '◆'}</span>
      )}
      <span style={{
        fontSize: 9 * iz, color: isActive ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.55)',
        fontWeight: isActive ? 700 : 500,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        userSelect: 'none',
      }}>{source.name}</span>
      {isCard && count > 1 && (
        <span style={{
          fontSize: 8 * iz, fontWeight: 700, flexShrink: 0,
          padding: `0 ${3 * iz}px`, borderRadius: 3 * iz,
          background: 'rgba(140,190,255,0.25)', color: 'rgba(200,225,255,0.95)',
        }}>×{count}</span>
      )}
    </div>
  )
}
