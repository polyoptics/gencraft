// Gen3dWindow.tsx — the 3D generation window (Brian 2026-11-20, his sketch
// "A"): one reference picture, an arrow beside it that opens the extra
// views when the generator takes them, the generator and its options
// under it, the words under those, and Generate.
//
// Nothing is laid ON the window. A card is linked in by letting its "+" go
// on the picture box or on a view's row (LinkDragOverlay), as a detail on
// a card's back is filled; the card stays where it is. The card linked as
// the reference is the card the 3D model goes to (utils/gen3d).
//
// Everything has a fixed place: picking another generator changes what the
// option cells hold, never where anything is, and opening the views makes
// the window wider to the right without moving what was there.

import React, { useState } from 'react'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useLinkDragStore } from '../../store/linkDragStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useAgentChat } from '../../utils/agentChat'
import { ContentScaled, panelContentScale } from '../UI/PanelSurface'
import { DIM, FAINT, INK, LINE, MiniCard, PANEL_BG, useFaceUrl } from '../CardBacks/cardBackUi'
import {
  VIEWS_W, generatorFor, notReady, patchGen, refreshGenerators, runGen, useGenerators,
  type GenOption, type Generator,
} from '../../utils/gen3d'

const PAD = 12
const REF_W = 200
const REF_H = 280
const LEFT_W = 300
const COL_W = LEFT_W - PAD * 2
const GOLD = '#FFD24A'

const field: React.CSSProperties = {
  boxSizing: 'border-box', background: '#11131b', color: INK, border: `1px solid ${LINE}`, borderRadius: 6,
  fontSize: 12, fontFamily: 'inherit', outline: 'none',
}

/** The reference picture's box: the card linked in, or where to let one go. */
const RefBox: React.FC<{ nodeId: string; card: ProjectGroup | undefined; gone: boolean; linking: boolean }> = ({ nodeId, card, gone, linking }) => {
  const url = useFaceUrl(card)
  return (
    <div
      className="g3-ref"
      data-link-drop={`gen:${nodeId}:ref`}
      title={card ? `${card.name}: the reference picture. The 3D model goes to this card.` : 'Let a card\'s + go here: its face picture is the reference, and the 3D model goes to that card'}
      style={{
        position: 'absolute', left: PAD, top: PAD, width: REF_W, height: REF_H, boxSizing: 'border-box', borderRadius: 8, overflow: 'hidden',
        border: card ? `1px solid ${card.color}` : `1.5px dashed ${linking ? GOLD : 'rgba(232,238,255,0.3)'}`,
        boxShadow: linking ? `0 0 0 2px ${GOLD}66` : 'none',
        background: url ? `#0b0c12 center / contain no-repeat url("${url}")` : '#0b0c12',
        display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
      }}
    >
      {!url && (
        <div style={{ color: card ? '#ff9a8a' : DIM, fontSize: 12, lineHeight: 1.5, padding: 16 }}>
          {gone ? 'That card is gone' : card ? 'This card has no picture on its face' : <>Reference picture<br /><span style={{ color: FAINT }}>let a card's + go here</span></>}
        </div>
      )}
      {(card || gone) && (
        <div
          className="g3-x"
          title="Take the reference off"
          onClick={() => { useUndoCoordinator.getState().checkpoint(); patchGen(nodeId, { ref: undefined }) }}
          style={{ position: 'absolute', right: 6, top: 6, width: 20, height: 20, borderRadius: 10, background: 'rgba(0,0,0,0.65)', color: INK, fontSize: 13, lineHeight: '20px', cursor: 'pointer' }}
        >×</div>
      )}
    </div>
  )
}

/** One extra view: its name, and the card linked to it. */
const ViewRow: React.FC<{ nodeId: string; slot: string; label: string; card: ProjectGroup | undefined; linking: boolean; top: number }> = ({ nodeId, slot, label, card, linking, top }) => (
  <div
    className="g3-view"
    data-link-drop={`gen:${nodeId}:${slot}`}
    title={card ? `${label}: ${card.name}` : `${label}: let a card's + go here`}
    style={{
      position: 'absolute', left: 0, right: 0, top, height: 32, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px',
      borderRadius: 6, border: `1px ${card ? 'solid' : 'dashed'} ${linking ? GOLD : card ? LINE : 'rgba(232,238,255,0.18)'}`,
    }}
  >
    <span style={{ width: 76, flexShrink: 0, fontSize: 12, color: DIM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    {card && <MiniCard g={card} w={18} />}
    <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: card ? INK : FAINT, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{card ? card.name : 'none'}</span>
    {card && (
      <span
        className="g3-x"
        title="Take this view off"
        onClick={() => {
          const n = useFreeNodeStore.getState().nodes[nodeId]
          const views = { ...n?.gen3d?.views }
          delete views[slot]
          useUndoCoordinator.getState().checkpoint()
          patchGen(nodeId, { views })
        }}
        style={{ width: 18, height: 18, borderRadius: 9, textAlign: 'center', lineHeight: '18px', fontSize: 13, color: INK, cursor: 'pointer', flexShrink: 0 }}
      >×</span>
    )}
  </div>
)

/** One option of the generator, in its cell. */
const OptionCell: React.FC<{ o: GenOption; value: number | boolean | string | undefined; onValue: (v: number | boolean | string | undefined) => void }> = ({ o, value, onValue }) => {
  const range = o.min !== undefined || o.max !== undefined ? ` (${o.min ?? ''} to ${o.max ?? ''})` : ''
  if (o.kind === 'switch') {
    const on = (value ?? o.def) === true
    return (
      <div
        onClick={() => onValue(!on)}
        title={`${o.label}: on or off`}
        style={{
          ...field, height: 26, display: 'flex', alignItems: 'center', gap: 7, padding: '0 8px', cursor: 'pointer',
          color: on ? INK : DIM, borderColor: on ? `${GOLD}99` : LINE, background: on ? 'rgba(255,210,74,0.10)' : '#11131b',
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 4, background: on ? GOLD : 'rgba(232,238,255,0.2)', flexShrink: 0 }} />
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
      </div>
    )
  }
  return (
    <div title={`${o.label}${range}. Empty: left to the generator.`} style={{ ...field, height: 26, display: 'flex', alignItems: 'center', gap: 6, padding: '0 0 0 8px', overflow: 'hidden' }}>
      <span style={{ color: DIM, whiteSpace: 'nowrap', flexShrink: 0, maxWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
      {o.kind === 'pick' ? (
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={e => onValue(e.target.value || undefined)}
          style={{ flex: 1, minWidth: 0, height: 24, background: '#11131b', color: INK, border: 'none', outline: 'none', fontSize: 12, fontFamily: 'inherit' }}
        >
          <option value="">auto</option>
          {o.picks?.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      ) : (
        <input
          value={typeof value === 'number' ? String(value) : ''}
          placeholder={o.def !== undefined ? String(o.def) : 'auto'}
          inputMode="numeric"
          onKeyDown={e => e.stopPropagation()}
          onChange={e => {
            const t = e.target.value.replace(/[^\d]/g, '')
            onValue(t === '' ? undefined : Number(t))
          }}
          onBlur={() => {
            if (typeof value !== 'number') return
            const v = Math.max(o.min ?? value, Math.min(o.max ?? value, value))
            if (v !== value) onValue(v)
          }}
          style={{ flex: 1, minWidth: 0, height: 24, background: 'transparent', color: INK, border: 'none', outline: 'none', fontSize: 12, fontFamily: 'inherit', textAlign: 'right', paddingRight: 8 }}
        />
      )}
    </div>
  )
}

/** What a generator takes, in a line, for its row in the list. */
const takes = (g: Generator): string => {
  const parts: string[] = []
  if (g.views.length) parts.push(g.views[0].key.startsWith('image:') ? `up to ${g.views.length + 1} views` : `views: ${g.views.map(v => v.label).join(', ')}`)
  if (g.options.length) parts.push(g.options.map(o => o.label).join(', '))
  return parts.join(' · ')
}

export const Gen3dWindow: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const node = useFreeNodeStore(s => s.nodes[nodeId])
  const groups = useBoardsStore(s => s.groups)
  const generators = useGenerators(s => s.generators)
  const readAt = useGenerators(s => s.readAt)
  const linking = useLinkDragStore(s => s.active && s.source?.kind === 'group')
  const box = node?.gen3d?.box
  const busy = useAgentChat(s => !!box && !!s.busy[box])
  const [listOpen, setListOpen] = useState(false)

  if (!node) return null
  const st = node.gen3d ?? {}
  const gen = generatorFor(node, generators)
  const card = (id: string | undefined) => id ? groups.find(g => g.id === id) : undefined
  const ref = card(st.ref)
  const opts = (gen && st.opts?.[gen.id]) || {}
  const canViews = !!gen?.views.length
  const open = !!st.viewsOpen
  const why = notReady(node)
  const ui = panelContentScale(node)

  const setOpt = (key: string, v: number | boolean | string | undefined) => {
    if (!gen) return
    const mine = { ...opts }
    if (v === undefined) delete mine[key]; else mine[key] = v
    patchGen(nodeId, { opts: { ...st.opts, [gen.id]: mine } })
  }
  // The views open to the right: the window is that much wider, and
  // nothing that was there moves.
  const toggleViews = () => {
    if (!canViews && !open) return
    useUndoCoordinator.getState().checkpoint()
    useFreeNodeStore.getState().updateFreeNode(nodeId, {
      width: Math.max(LEFT_W * ui, node.width + (open ? -1 : 1) * VIEWS_W * ui),
      gen3d: { ...st, viewsOpen: !open },
    })
  }

  return (
    <div
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      data-wheel-own=""
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: PANEL_BG }}
    >
      <style>{`.g3-ref .g3-x, .g3-view .g3-x { opacity: 0; transition: opacity 0.1s } .g3-ref:hover .g3-x, .g3-view:hover .g3-x { opacity: 1 } .g3-item:hover { background: rgba(255,210,74,0.10) }`}</style>
      <ContentScaled factor={ui}>
        <div style={{ position: 'relative', width: '100%', height: '100%', fontFamily: 'system-ui, sans-serif', color: INK }}>
          <RefBox nodeId={nodeId} card={ref} gone={!!st.ref && !ref} linking={linking} />

          <div
            onClick={toggleViews}
            title={canViews ? 'Extra views of the same thing (this generator takes them)' : 'Extra views: this generator takes one picture only'}
            style={{
              position: 'absolute', left: PAD + REF_W + 10, top: PAD + REF_H / 2 - 22, width: 26, height: 44, borderRadius: 6, boxSizing: 'border-box',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15,
              border: `1px solid ${open ? `${GOLD}99` : LINE}`, background: open ? 'rgba(255,210,74,0.10)' : 'transparent',
              color: open ? GOLD : INK, opacity: canViews || open ? 1 : 0.25, cursor: canViews || open ? 'pointer' : 'default',
            }}
          >▸</div>

          {open && (
            <div style={{ position: 'absolute', left: LEFT_W, top: PAD, width: VIEWS_W - PAD, height: REF_H }}>
              <div style={{ height: 20, fontSize: 11, color: DIM, textTransform: 'uppercase', letterSpacing: 0.6 }}>Extra views</div>
              {gen?.views.map((v, i) => (
                <ViewRow key={v.key} nodeId={nodeId} slot={v.key} label={v.label} card={card(st.views?.[v.key])} linking={linking} top={22 + i * 36} />
              ))}
              {!canViews && <div style={{ fontSize: 12, color: FAINT, lineHeight: 1.5, paddingTop: 6 }}>This generator takes one picture only.</div>}
            </div>
          )}

          <div style={{ position: 'absolute', left: PAD, top: PAD + REF_H + 5, width: COL_W, height: 16, fontSize: 11, color: DIM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {ref ? <>The 3D model goes to <span style={{ color: INK }}>{ref.name}</span></> : 'No reference: made from the words alone'}
          </div>

          <div
            onClick={() => setListOpen(o => !o)}
            title={gen ? `${gen.name}: ${gen.description}` : 'Pick a generator'}
            style={{ ...field, position: 'absolute', left: PAD, top: PAD + REF_H + 28, width: COL_W, height: 30, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', cursor: 'pointer', fontSize: 13, borderColor: listOpen ? `${GOLD}99` : LINE }}
          >
            <span style={{ color: DIM, fontSize: 11, flexShrink: 0 }}>Generator</span>
            <span style={{ flex: 1, minWidth: 0, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{gen?.name ?? 'none'}</span>
            <span style={{ color: DIM, flexShrink: 0 }}>▾</span>
          </div>

          <div style={{ position: 'absolute', left: PAD, top: PAD + REF_H + 66, width: COL_W, height: 86, display: 'grid', gridTemplateColumns: '1fr 1fr', gridAutoRows: '26px', gap: '4px 8px' }}>
            {gen?.options.slice(0, 6).map(o => <OptionCell key={o.key} o={o} value={opts[o.key]} onValue={v => setOpt(o.key, v)} />)}
          </div>

          <textarea
            value={node.text}
            onChange={e => useFreeNodeStore.getState().updateFreeNode(nodeId, { text: e.target.value })}
            onKeyDown={e => e.stopPropagation()}
            placeholder={ref ? 'Words to go with the picture, if the generator should have any' : 'What to make, in words'}
            style={{ ...field, position: 'absolute', left: PAD, right: PAD, top: PAD + REF_H + 160, bottom: PAD + 34 + 10, resize: 'none', padding: '8px 10px', fontSize: 13, lineHeight: 1.5 }}
          />

          <div
            onClick={() => { if (!why && !busy) runGen(nodeId) }}
            title={why ?? (busy ? 'Claude is running the last one' : 'Pass this to Claude to run on Krea. It uses your Krea credits.')}
            style={{
              position: 'absolute', left: PAD, bottom: PAD, width: 118, height: 34, borderRadius: 7, boxSizing: 'border-box',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700,
              background: GOLD, color: '#15130a', opacity: why || busy ? 0.35 : 1, cursor: why || busy ? 'default' : 'pointer',
            }}
          >Generate</div>
          <div style={{ position: 'absolute', left: PAD + 118 + 10, right: PAD, bottom: PAD, height: 34, display: 'flex', alignItems: 'center', fontSize: 11, lineHeight: 1.35, color: busy ? GOLD : DIM, overflow: 'hidden' }}>
            {busy ? 'Claude is running it. Watch the chat box.' : why ?? ''}
          </div>

          {listOpen && (
            <div style={{ position: 'absolute', left: PAD, top: PAD, width: COL_W, height: REF_H + 24, boxSizing: 'border-box', background: '#0d0f17', border: `1px solid ${GOLD}66`, borderRadius: 8, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {generators.map(g => (
                  <div
                    key={g.id}
                    className="g3-item"
                    title={`${g.name}: ${g.description}`}
                    onClick={() => { useUndoCoordinator.getState().checkpoint(); patchGen(nodeId, { generator: g.id }); setListOpen(false) }}
                    style={{ padding: '7px 10px', cursor: 'pointer', borderBottom: `1px solid ${LINE}`, borderLeft: `3px solid ${g.id === gen?.id ? GOLD : 'transparent'}` }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{g.name}</div>
                    <div style={{ fontSize: 11, color: DIM, lineHeight: 1.4 }}>{g.description}</div>
                    {takes(g) && <div style={{ fontSize: 11, color: FAINT, lineHeight: 1.4, marginTop: 2 }}>{takes(g)}</div>}
                  </div>
                ))}
              </div>
              <div
                className="g3-item"
                onClick={() => { refreshGenerators(); setListOpen(false) }}
                title="Ask Claude to read Krea's list of 3D generators and their options again"
                style={{ flexShrink: 0, padding: '7px 10px', fontSize: 11, color: DIM, cursor: 'pointer', borderTop: `1px solid ${LINE}` }}
              >Refresh from Krea <span style={{ color: FAINT }}>· read {readAt}</span></div>
            </div>
          )}
        </div>
      </ContentScaled>
    </div>
  )
}
