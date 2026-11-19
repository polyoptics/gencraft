// MergeDialog — two cards just linked say different things in rows of the
// same name (utils/detailMerge; Brian 2026-11-19: "whose height wins?").
// Each such row is shown with both cards' values: pick the one to keep
// and both cards share it from then on. A row with neither picked stays
// as it is on both. Nothing changes until "Share" is pressed; closing it
// leaves both cards as they are.

import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore } from '../../store/boardsStore'
import { useUnits } from '../../store/unitsStore'
import { useMergeAsk, answerMerge } from '../../utils/detailMerge'
import { heightAsUnit } from '../../utils/stickGeom'

const pickStyle = (lit: boolean): React.CSSProperties => ({
  flex: '1 1 0', minWidth: 0, textAlign: 'left', padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
  background: lit ? 'rgba(244,123,32,0.2)' : 'rgba(255,255,255,0.04)',
  border: lit ? '1.5px solid #f47b20' : '1.5px solid rgba(255,255,255,0.1)', color: '#e2e8f0',
})
const clip: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

export const MergeDialog: React.FC = () => {
  const ask = useMergeAsk(s => s.ask)
  const metric = useUnits(s => s.metric)
  const [keep, setKeep] = useState<Record<string, 'a' | 'b' | undefined>>({})
  useEffect(() => { setKeep({}) }, [ask])
  if (!ask) return null
  const groups = useBoardsStore.getState().groups
  const nameOf = (id: string) => groups.find(g => g.id === id)?.name || 'Untitled'
  const colorOf = (id: string) => groups.find(g => g.id === id)?.color || '#5b8dd9'
  const close = () => useMergeAsk.setState({ ask: null })
  const any = ask.rows.some(r => keep[r.aRow])
  const side = (r: typeof ask.rows[number], which: 'a' | 'b') => {
    const lit = keep[r.aRow] === which
    const text = which === 'a' ? r.aText : r.bText
    return (
      <button type="button" style={pickStyle(lit)}
        onClick={() => setKeep(k => ({ ...k, [r.aRow]: lit ? undefined : which }))}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, opacity: 0.65, marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: colorOf(which === 'a' ? ask.a : ask.b), flex: 'none' }} />
          <span style={clip}>{nameOf(which === 'a' ? ask.a : ask.b)}</span>
        </div>
        <div style={{ ...clip, fontSize: 14, fontWeight: 600 }}>{heightAsUnit(r.name, text, metric) ?? text}</div>
      </button>
    )
  }
  return ReactDOM.createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'rgba(0,0,0,0.35)' }} onPointerDown={close} />
      <div
        data-merge-dialog=""
        onPointerDown={e => e.stopPropagation()}
        onWheel={e => e.stopPropagation()}
        style={{
          position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 400, maxHeight: '70vh', display: 'flex', flexDirection: 'column',
          zIndex: 9999, background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12,
          boxShadow: '0 12px 40px rgba(0,0,0,0.6)', fontFamily: 'system-ui, sans-serif', color: '#e2e8f0',
        }}
      >
        <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>These two cards say different things</div>
          <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 3 }}>Pick the one to keep and both cards will share it. Leave a row unpicked to keep both as they are.</div>
        </div>
        <div style={{ padding: '10px 16px', overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.25) transparent' }}>
          {ask.rows.map(r => (
            <div key={r.aRow} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 1, opacity: 0.55, marginBottom: 4, textTransform: 'uppercase' }}>{r.name}</div>
              <div style={{ display: 'flex', gap: 8 }}>{side(r, 'a')}{side(r, 'b')}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 16px 14px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <button type="button" onClick={close}
            style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.14)', background: 'none', color: '#e2e8f0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5 }}>Leave both</button>
          <button type="button" disabled={!any} onClick={() => answerMerge(ask, keep)}
            style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: '#f47b20', color: '#1c1408', fontWeight: 700, cursor: any ? 'pointer' : 'default', opacity: any ? 1 : 0.4, fontFamily: 'inherit', fontSize: 12.5 }}>Share</button>
        </div>
      </div>
    </>,
    document.body,
  )
}
