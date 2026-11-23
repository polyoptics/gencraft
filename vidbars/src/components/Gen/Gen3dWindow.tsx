// Gen3dWindow.tsx — the 3D generation window (Brian 2026-11-23, his
// sketch): "The generator's main purpose is to hold the cards. And then,
// in a nice big font, I want to know: what's the face limit? What's the AI
// 3d model? And I can set them right there. And the prompt bit can go
// underneath, and the generate can stay there."
//
// The cards are not ON the window: they are docked on its side, as many as
// he likes, or a whole deck, like cards on Film Look (utils/filmShots
// dockedCards). Generate makes a 3D model for each (utils/gen3d).
//
// Everything has a fixed place: picking another generator changes what the
// boxes hold, never where anything is. A box the generator has no use for
// (no face limit, no texture switch) stays where it is, unlit.

import React, { useState } from 'react'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useAgentChat } from '../../utils/agentChat'
import { ContentScaled, panelContentScale } from '../UI/PanelSurface'
import { DIM, FAINT, INK, LINE, PANEL_BG } from '../CardBacks/cardBackUi'
import {
  facesOption, genCards, generatorFor, notReady, patchGen, refreshGenerators, runGen, textureOption, useGenerators,
  type GenOption, type Generator,
} from '../../utils/gen3d'

const PAD = 12
const SIDE_W = 128
const GAP = 8
const BIG_H = 52
const GOLD = '#FFD24A'
// Rows, from the top.
const Y_GEN = 26
const Y_FACES = 102
const Y_MORE = 164
const Y_PROMPT = 214

const field: React.CSSProperties = {
  boxSizing: 'border-box', background: '#11131b', color: INK, border: `1px solid ${LINE}`, borderRadius: 6,
  fontSize: 12, fontFamily: 'inherit', outline: 'none',
}
const caption: React.CSSProperties = {
  position: 'absolute', left: PAD, height: 14, fontSize: 10, fontWeight: 700, letterSpacing: 1, color: DIM, textTransform: 'uppercase',
}
const big: React.CSSProperties = {
  ...field, position: 'absolute', height: BIG_H, borderRadius: 8, display: 'flex', alignItems: 'center',
}

/** One of the generator's smaller options, in its cell. */
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
          style={{ flex: 1, minWidth: 0, height: 24, background: 'transparent', color: INK, border: 'none', outline: 'none', fontSize: 12, fontFamily: 'inherit', textAlign: 'right', paddingRight: 8 }}
        />
      )}
    </div>
  )
}

/** What a generator takes, in a line, for its row in the list. */
const takes = (g: Generator): string => g.options.map(o => o.label).join(', ')

const cardsWord = (n: number) => n === 1 ? '1 docked card' : `${n} docked cards`

export const Gen3dWindow: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const node = useFreeNodeStore(s => s.nodes[nodeId])
  // What is docked is worked out from where the cards are: read again
  // whenever a card or a block changes.
  useBoardsStore(s => s.groups)
  useBoardsStore(s => s.boards)
  const generators = useGenerators(s => s.generators)
  const readAt = useGenerators(s => s.readAt)
  const box = node?.gen3d?.box
  const busy = useAgentChat(s => !!box && !!s.busy[box])
  const [listOpen, setListOpen] = useState(false)

  if (!node) return null
  const st = node.gen3d ?? {}
  const gen = generatorFor(node, generators)
  const opts = (gen && st.opts?.[gen.id]) || {}
  const faces = facesOption(gen)
  const texture = textureOption(gen)
  const more = gen?.options.filter(o => o !== faces && o !== texture).slice(0, 3) ?? []
  const docked = genCards(node)
  const why = notReady(node)
  const ui = panelContentScale(node)

  const setOpt = (key: string, v: number | boolean | string | undefined) => {
    if (!gen) return
    const mine = { ...opts }
    if (v === undefined) delete mine[key]; else mine[key] = v
    patchGen(nodeId, { opts: { ...st.opts, [gen.id]: mine } })
  }
  const facesValue = faces ? opts[faces.key] : undefined
  const textureOn = !!texture && (opts[texture.key] ?? texture.def) === true
  const facesRange = faces && (faces.min !== undefined || faces.max !== undefined) ? ` (${(faces.min ?? 0).toLocaleString('en-US')} to ${faces.max?.toLocaleString('en-US') ?? 'any'})` : ''

  // What Generate will do, in a line.
  const n = docked.make.length
  // On the button: a 3D model per docked card, or one from the words alone.
  const count = n || (!why ? 1 : 0)
  const notes: string[] = []
  if (n) notes.push(`${cardsWord(n)}: ${n === 1 ? 'it gets a 3D model' : 'each gets a 3D model'}`)
  if (docked.have.length) notes.push(`${docked.have.length} already ${docked.have.length === 1 ? 'has' : 'have'} one`)
  if (docked.plain.length) notes.push(`${docked.plain.length} with no picture`)
  const status = busy ? 'Claude is running it. Watch the chat box.'
    : n ? notes.join(' · ')
    : why ?? 'No cards docked: made from the words alone'

  return (
    <div
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      data-wheel-own=""
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: PANEL_BG }}
    >
      <style>{`.g3-item:hover { background: rgba(255,210,74,0.10) }`}</style>
      <ContentScaled factor={ui}>
        <div style={{ position: 'relative', width: '100%', height: '100%', fontFamily: 'system-ui, sans-serif', color: INK }}>
          <div style={{ ...caption, top: Y_GEN - 16 }}>Generator</div>
          <div
            className="g3-gen"
            onClick={() => setListOpen(o => !o)}
            title={gen ? `${gen.name}: ${gen.description}` : 'Pick a generator'}
            style={{ ...big, left: PAD, right: PAD + SIDE_W + GAP, top: Y_GEN, gap: 8, padding: '0 12px', cursor: 'pointer', borderColor: listOpen ? `${GOLD}99` : LINE }}
          >
            <span style={{ flex: 1, minWidth: 0, fontSize: 26, fontWeight: 700, letterSpacing: 0.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{gen?.name ?? 'none'}</span>
            <span style={{ color: DIM, fontSize: 18, flexShrink: 0 }}>▾</span>
          </div>
          <div
            className="g3-texture"
            onClick={() => { if (texture) setOpt(texture.key, !textureOn) }}
            title={texture ? 'Texture: on or off' : 'Texture: this generator has no switch for it'}
            style={{
              ...big, right: PAD, width: SIDE_W, top: Y_GEN, padding: '0 12px', fontSize: 17, fontWeight: 700,
              cursor: texture ? 'pointer' : 'default', opacity: texture ? 1 : 0.3,
              // Lit: solid light, dark words, as the app's other lit switches.
              // Yellow is Generate's alone (Brian 2026-11-23).
              color: textureOn ? '#14161f' : DIM, borderColor: textureOn ? 'rgba(232,238,255,0.92)' : LINE, background: textureOn ? 'rgba(232,238,255,0.92)' : '#11131b',
              justifyContent: 'center',
            }}
          >Texture</div>

          <div style={{ ...caption, top: Y_FACES - 16 }}>Faces</div>
          <div
            title={faces ? `${faces.label}${facesRange}. Empty: left to the generator.` : 'Faces: this generator has no face limit to set'}
            style={{ ...big, left: PAD, right: PAD + SIDE_W + GAP, top: Y_FACES, padding: '0 12px', opacity: faces ? 1 : 0.3 }}
          >
            <input
              className="g3-faces"
              disabled={!faces}
              value={typeof facesValue === 'number' ? facesValue.toLocaleString('en-US') : ''}
              placeholder={faces ? (faces.def !== undefined ? Number(faces.def).toLocaleString('en-US') : 'auto') : '—'}
              inputMode="numeric"
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              onChange={e => {
                if (!faces) return
                const t = e.target.value.replace(/[^\d]/g, '')
                setOpt(faces.key, t === '' ? undefined : Number(t))
              }}
              onBlur={() => {
                if (!faces || typeof facesValue !== 'number') return
                const v = Math.max(faces.min ?? facesValue, Math.min(faces.max ?? facesValue, facesValue))
                if (v !== facesValue) setOpt(faces.key, v)
              }}
              style={{ width: '100%', minWidth: 0, height: BIG_H - 4, background: 'transparent', color: INK, border: 'none', outline: 'none', fontSize: 28, fontWeight: 700, fontFamily: 'inherit', letterSpacing: 0.5 }}
            />
          </div>
          <div
            className="g3-go"
            onClick={() => { if (!why && !busy) runGen(nodeId) }}
            title={why ?? (busy ? 'Claude is running the last one' : `Makes ${count} 3D model${count === 1 ? '' : 's'}: passed to Claude to run on Krea. It uses your Krea credits.`)}
            style={{
              position: 'absolute', right: PAD, width: SIDE_W, top: Y_FACES, height: BIG_H, borderRadius: 8, boxSizing: 'border-box',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, fontSize: 17, fontWeight: 800,
              background: GOLD, color: '#15130a', opacity: why || busy ? 0.35 : 1, cursor: why || busy ? 'default' : 'pointer',
            }}
          >
            Generate
            {/* How many 3D models it will make, always in its place. */}
            <span className="g3-count" style={{ minWidth: 24, height: 24, boxSizing: 'border-box', padding: '0 6px', borderRadius: 12, background: '#15130a', color: GOLD, fontSize: 14, lineHeight: '24px', textAlign: 'center' }}>{count}</span>
          </div>

          <div style={{ position: 'absolute', left: PAD, right: PAD, top: Y_MORE, height: 26, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: GAP }}>
            {more.map(o => <OptionCell key={o.key} o={o} value={opts[o.key]} onValue={v => setOpt(o.key, v)} />)}
          </div>

          <div style={{ ...caption, top: Y_PROMPT - 16 }}>Prompt</div>
          <textarea
            value={node.text}
            onChange={e => useFreeNodeStore.getState().updateFreeNode(nodeId, { text: e.target.value })}
            onKeyDown={e => e.stopPropagation()}
            placeholder={n ? 'Words to go with the pictures, if the generator should have any' : 'What to make, in words'}
            style={{ ...field, position: 'absolute', left: PAD, right: PAD, top: Y_PROMPT, bottom: PAD + 22, resize: 'none', padding: '8px 10px', fontSize: 13, lineHeight: 1.5 }}
          />
          <div
            className="g3-status"
            title={n ? docked.make.map(g => g.name || 'Untitled').join(', ') : undefined}
            style={{ position: 'absolute', left: PAD, right: PAD, bottom: PAD - 2, height: 18, lineHeight: '18px', fontSize: 11, color: busy ? GOLD : n ? INK : DIM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >{status}</div>

          {listOpen && (
            <div style={{ position: 'absolute', left: PAD, right: PAD, top: Y_GEN + BIG_H + 4, bottom: PAD, boxSizing: 'border-box', background: '#0d0f17', border: `1px solid ${GOLD}66`, borderRadius: 8, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {generators.map(g => (
                  <div
                    key={g.id}
                    className="g3-item"
                    title={`${g.name}: ${g.description}`}
                    onClick={() => { useUndoCoordinator.getState().checkpoint(); patchGen(nodeId, { generator: g.id }); setListOpen(false) }}
                    style={{ padding: '7px 10px', cursor: 'pointer', borderBottom: `1px solid ${LINE}`, borderLeft: `3px solid ${g.id === gen?.id ? GOLD : 'transparent'}` }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{g.name}</div>
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
