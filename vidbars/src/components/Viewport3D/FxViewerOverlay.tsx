// FxViewerOverlay — a Viewer at the end of an effect strip shows the
// strip's output instead of its own item, with a source picker when the
// strip carries several images, "Save" (full size, real files) and, once
// saved, a drag-out grip. Nothing here is stored: take the strip away from
// the Viewer and it shows its own item again.

import React, { useState } from 'react'
import { useFxStore } from '../../store/fxStore'
import { EFFECTS } from '../../utils/fx/effects'
import { saveFailure, saveStripResult, type SavedResult } from '../../utils/fx/saveStrip'
import { CanvasMirror } from '../UI/CanvasMirror'
import { DragOutGrip } from '../UI/DragOutGrip'

const stop = (e: React.SyntheticEvent) => e.stopPropagation()

export const FxViewerOverlay: React.FC<{ windowId: string; fontSize: number }> = ({ windowId, fontSize }) => {
  const strip = useFxStore(s => Object.values(s.strips).find(st => st.windowId === windowId))
  // This overlay outlives any one strip (it is mounted per Viewer), so a
  // pick and a save are each kept WITH what they were made for and simply
  // not shown once that changes: a slider moved, the strip was rebuilt, or
  // another strip docked here. A grip for an older file must never stand
  // in for the result on screen.
  const [pick, setPick] = useState({ key: '', i: 0 })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<{ sig: string; list: SavedResult[]; error?: string } | null>(null)
  if (!strip) return null

  const sig = strip.key + JSON.stringify(strip.items)
  const outputs = strip.result?.outputs ?? []
  const idx = Math.min(pick.key === strip.key ? pick.i : 0, Math.max(0, outputs.length - 1))
  const out = outputs[idx]
  const chainName = strip.items.flatMap(i => i.kind === 'effect' ? [EFFECTS[i.effect].label] : []).join(' → ')
  const btn: React.CSSProperties = {
    fontSize, padding: '1px 7px', borderRadius: 4, cursor: 'pointer',
    background: 'rgba(255,255,255,0.1)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)',
  }

  const save = async () => {
    const at = sig
    setSaving(true)
    try {
      const r = await saveStripResult(strip.items)
      setSaved({ sig: at, list: r.saved, error: r.error })
    } catch (err) {
      setSaved({ sig: at, list: [], error: String((err as Error)?.message ?? err) })
    } finally {
      setSaving(false)
    }
  }
  const mine = saved?.sig === sig ? saved : null
  const savedHere = mine?.list[idx]
  const failure = savedHere ? saveFailure(savedHere) : mine ? (mine.error ?? 'Could not save this result.') : null

  return (
    <div
      data-fx-output
      onPointerDown={stop} onWheel={stop} onDoubleClick={stop}
      style={{ position: 'absolute', inset: 0, zIndex: 5, background: '#0c0d14', display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', fontSize, color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.05)', flexShrink: 0 }}>
        <span style={{ color: '#f2b84b' }}>✦</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chainName || 'Effect strip'}{strip.running ? ' …' : ''}</span>
        {outputs.length > 1 && <>
          <button style={btn} onClick={() => setPick({ key: strip.key, i: (idx + outputs.length - 1) % outputs.length })}>‹</button>
          <span>{idx + 1}/{outputs.length}</span>
          <button style={btn} onClick={() => setPick({ key: strip.key, i: (idx + 1) % outputs.length })}>›</button>
        </>}
        {failure && <span title={failure} style={{ maxWidth: '40%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#ff9b9b' }}>{failure}</span>}
        {/* Beside Save, not instead of it: saving again is always allowed. */}
        {savedHere?.url && !failure && <DragOutGrip url={savedHere.url} size={fontSize * 1.4} />}
        <button style={btn} disabled={saving || !out} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {out
          ? <CanvasMirror source={out.canvas} style={{ width: '100%', height: '100%' }} />
          : <div style={{ fontSize, opacity: 0.6, padding: 12, textAlign: 'center' }}>{strip.result?.error ?? 'Running…'}</div>}
      </div>
    </div>
  )
}
