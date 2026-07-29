// PromptPad.tsx — the prompt editor and its tag palette.
//
// Deliberately ONE component rather than two. The tags are only useful
// next to the text they are building; splitting them would mean magneting
// two things together every time just to get back to a usable baseline.
// What IS separable — the saved-prompt list — is a rail on the side, the
// same shape as the Documents rail in the text viewer.
//
// Submitting writes to the shared generation store, which is what a Media
// Pool reads. Neither component knows the other exists; magneting them
// together is a spatial statement, not a wiring one.

import React, { useState } from 'react'
import { useGenerationStore, isUsingStubAdapter } from '../../store/generationStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'

/** The Mad-Libs palette from the design: click to append, grouped by the
 *  kind of thing it says. Editable per node later; these are the defaults
 *  that make the idea legible. */
const TAG_GROUPS: Array<{ label: string; tags: string[] }> = [
  { label: 'framing', tags: ['isometric view', 'orthographic view', 'front, back, left, right', 'arms out to the side', '3/4 view'] },
  { label: 'grid', tags: ['2x2 grid', '3x3 grid', 'where each cell contains', 'sprite sheet'] },
  { label: 'background', tags: ['clean black background', 'clean white background', 'transparent background', 'no shadow'] },
  { label: 'style', tags: ['in the same style as the reference images', 'flat vector', 'painterly', 'photoreal', 'blueprint'] },
  { label: 'for 3d', tags: ['T-pose', 'neutral pose', 'even lighting', 'texture atlas', 'seamless'] },
]

export const PromptPad: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const node = useFreeNodeStore(s => s.nodes[nodeId])
  const updateFreeNode = useFreeNodeStore(s => s.updateFreeNode)
  const submit = useGenerationStore(s => s.submit)
  const pending = useGenerationStore(s => s.pending)
  const startSession = useGenerationStore(s => s.startSession)
  const [count, setCount] = useState(4)
  const [showSaved, setShowSaved] = useState(false)
  const [saved, setSaved] = useState<string[]>([])

  // The prompt text lives on the node, so it persists and rides export.
  const text = node?.text ?? ''
  const setText = (v: string) => updateFreeNode(nodeId, { text: v })

  const append = (tag: string) => {
    const t = text.trim()
    setText(t ? `${t}, ${tag}` : tag)
  }

  const run = async () => {
    if (!text.trim()) return
    await submit({ prompt: text.trim(), refs: [], count })
  }

  const chip = (on = false): React.CSSProperties => ({
    background: on ? 'rgba(120,170,255,0.28)' : 'rgba(255,255,255,0.05)',
    border: `1px solid ${on ? 'rgba(140,190,255,0.55)' : 'rgba(255,255,255,0.1)'}`,
    borderRadius: 4, color: on ? '#dce9ff' : 'rgba(255,255,255,0.6)',
    fontSize: 9, fontWeight: 600, padding: '2px 6px', cursor: 'pointer',
    fontFamily: 'inherit', textAlign: 'left', lineHeight: 1.4,
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
      {/* ── Prompt text + run ── */}
      <div style={{ display: 'flex', gap: 5, padding: 6, flexShrink: 0 }}>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            // Ctrl/Cmd+Enter submits; plain Enter stays a newline, because
            // this is a writing surface first.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run() }
            e.stopPropagation()
          }}
          placeholder="inspirational jumpsuit, clean black background, arms out to the side"
          style={{
            flex: 1, minHeight: 62, resize: 'none',
            background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.9)',
            border: '1px solid rgba(255,255,255,0.12)', borderRadius: 5,
            padding: 7, fontSize: 11, lineHeight: 1.5, fontFamily: 'inherit', outline: 'none',
          }}
        />
        <button
          onClick={() => void run()}
          disabled={!text.trim() || pending > 0}
          title="Generate (Ctrl+Enter)"
          style={{
            width: 52, flexShrink: 0,
            background: text.trim() ? 'rgba(120,170,255,0.3)' : 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(140,190,255,0.45)', borderRadius: 5,
            color: '#dce9ff', fontSize: 10, fontWeight: 700, cursor: text.trim() ? 'pointer' : 'default',
            fontFamily: 'inherit',
          }}
        >{pending > 0 ? '…' : '⏎'}</button>
      </div>

      {/* ── Count + saved ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px 5px', flexShrink: 0 }}>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)' }}>count</span>
        {[1, 2, 4, 8].map(n => (
          <button key={n} style={chip(count === n)} onClick={() => setCount(n)}>{n}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button style={chip(false)} onClick={() => { if (text.trim()) setSaved(s => [text.trim(), ...s]) }}>SAVE</button>
        <button style={chip(showSaved)} onClick={() => setShowSaved(v => !v)}>▤</button>
        <button style={chip(false)} onClick={() => startSession()} title="Start a new generation session">NEW SESSION</button>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        {/* ── Tag palette ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 6, minWidth: 0 }}>
          {TAG_GROUPS.map(g => (
            <div key={g.label} style={{ marginBottom: 7 }}>
              <div style={{
                fontSize: 8.5, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.3)', marginBottom: 3,
              }}>{g.label}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                {g.tags.map(t => (
                  <button key={t} style={chip(false)} onClick={() => append(t)}>+ {t}</button>
                ))}
              </div>
            </div>
          ))}
          {isUsingStubAdapter() && (
            <div style={{
              marginTop: 4, fontSize: 8.5, lineHeight: 1.5, color: 'rgba(255,200,140,0.65)',
              borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 5,
            }}>
              No image provider configured — generating placeholder tiles so the
              flow is demonstrable. Wiring a real one is a single adapter function.
            </div>
          )}
        </div>

        {/* ── Saved prompts rail ── */}
        {showSaved && (
          <div style={{
            width: 150, flexShrink: 0, borderLeft: '1px solid rgba(255,255,255,0.08)',
            overflowY: 'auto', padding: 6,
          }}>
            <div style={{
              fontSize: 8.5, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.3)', marginBottom: 4,
            }}>Saved</div>
            {saved.length === 0 && (
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)' }}>Nothing saved yet.</div>
            )}
            {saved.map((s, i) => (
              <div
                key={i}
                onClick={() => setText(s)}
                title="Click to load this prompt"
                style={{
                  fontSize: 9, color: 'rgba(255,255,255,0.7)', lineHeight: 1.4,
                  padding: '4px 5px', marginBottom: 3, cursor: 'pointer',
                  borderLeft: '2px solid rgba(140,190,255,0.5)',
                  background: 'rgba(255,255,255,0.03)', borderRadius: 3,
                }}
              >{s.length > 90 ? `${s.slice(0, 90)}…` : s}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
