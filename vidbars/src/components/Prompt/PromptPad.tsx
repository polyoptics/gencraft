// PromptPad.tsx — a workshop for BUILDING prompts, not a fixed menu.
//
// The vocabulary belongs to whoever is using it: sections and tags are all
// editable, addable and deletable, and the whole kit lives on the node, so
// two pads can carry different vocabularies (one for characters, one for
// environments) and each rides export and undo with its node.
//
// Deliberately ONE component rather than two. The tags are only useful next
// to the text they are building; splitting them would mean magneting two
// things together every time just to get back to a usable baseline. What IS
// separable — the history of what you sent — is its own app, because you
// might want that history docked somewhere else entirely.
//
// Sending records a prompt entry in the shared history and stops there.
// There is no generator behind it and nothing pretends otherwise.

import React, { useMemo, useState } from 'react'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { CounterScaled, usePanelChrome } from '../UI/PanelSurface'
import { recordHistory } from '../../store/historyStore'
import {
  defaultPromptKit, newSection, newTag, newSaved,
  type PromptKit, type PromptSection,
} from '../../utils/promptKit'

/** Small inline editor used for every renameable label in the pad. */
const InlineEdit: React.FC<{
  value: string
  onCommit: (v: string) => void
  onCancel?: () => void
  style?: React.CSSProperties
  placeholder?: string
}> = ({ value, onCommit, onCancel, style, placeholder }) => {
  const [draft, setDraft] = useState(value)
  return (
    <input
      autoFocus
      value={draft}
      placeholder={placeholder}
      onChange={e => setDraft(e.target.value)}
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit(draft.trim())
        if (e.key === 'Escape') (onCancel ?? (() => onCommit(value)))()
      }}
      onBlur={() => onCommit(draft.trim())}
      style={{
        background: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(140,190,255,0.5)', borderRadius: 3,
        color: 'rgba(255,255,255,0.92)', fontSize: 11.5, padding: '1px 5px',
        fontFamily: 'inherit', outline: 'none', minWidth: 0, ...style,
      }}
    />
  )
}

export const PromptPad: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const node = useFreeNodeStore(s => s.nodes[nodeId])
  const updateFreeNode = useFreeNodeStore(s => s.updateFreeNode)
  const { gz, showFooter, narrow } = usePanelChrome(node)
  const [showSaved, setShowSaved] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)   // 'sec:<id>' | 'tag:<id>' | 'saved:<id>'
  const [addingTagTo, setAddingTagTo] = useState<string | null>(null)
  const [sent, setSent] = useState(0)

  // The kit lives on the node. Defaulting here rather than at creation means
  // pads made before this existed still open with a full palette.
  const kit: PromptKit = useMemo(
    () => node?.promptKit ?? defaultPromptKit(),
    [node?.promptKit],
  )
  const setKit = (k: PromptKit) => updateFreeNode(nodeId, { promptKit: k })
  const patchSections = (fn: (s: PromptSection[]) => PromptSection[]) =>
    setKit({ ...kit, sections: fn(kit.sections) })

  const text = node?.text ?? ''
  const setText = (v: string) => updateFreeNode(nodeId, { text: v })

  const append = (tag: string) => {
    const t = text.trim()
    setText(t ? `${t}, ${tag}` : tag)
  }

  const send = () => {
    const t = text.trim()
    if (!t) return
    recordHistory({ kind: 'prompt', sourceId: nodeId, label: t, prompt: t })
    setSent(n => n + 1)
  }

  const chip = (on = false): React.CSSProperties => ({
    background: on ? 'rgba(120,170,255,0.28)' : 'rgba(255,255,255,0.05)',
    border: `1px solid ${on ? 'rgba(140,190,255,0.55)' : 'rgba(255,255,255,0.1)'}`,
    borderRadius: 4, color: on ? '#dce9ff' : 'rgba(255,255,255,0.6)',
    fontSize: 11, fontWeight: 600, padding: '2px 6px', cursor: 'pointer',
    fontFamily: 'inherit', textAlign: 'left', lineHeight: 1.4, flexShrink: 0,
  })

  const ghostBtn: React.CSSProperties = {
    background: 'none', border: 'none', color: 'rgba(255,255,255,0.25)',
    fontSize: 10, cursor: 'pointer', padding: '0 3px', fontFamily: 'inherit', flexShrink: 0,
  }

  return (
    <div
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#12131f' }}
    >
      {/* Every CSS px below is a SCREEN px, so the pad reads the same at
          any zoom — see PanelSurface. The saved rail and the footer hint
          drop out when the pad is too small on screen to afford them. */}
      <CounterScaled gz={gz}>
      <div style={{
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        overflow: 'hidden', fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* ── Prompt text + send ── */}
      <div style={{ display: 'flex', gap: 5, padding: 6, flexShrink: 0 }}>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            // Ctrl/Cmd+Enter sends; plain Enter stays a newline, because
            // this is a writing surface first.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() }
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 52, flexShrink: 0 }}>
          <button
            onClick={send}
            disabled={!text.trim()}
            title="Send (Ctrl+Enter) — recorded in history"
            style={{
              flex: 1,
              background: text.trim() ? 'rgba(120,170,255,0.3)' : 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(140,190,255,0.45)', borderRadius: 5,
              color: '#dce9ff', fontSize: 10, fontWeight: 700,
              cursor: text.trim() ? 'pointer' : 'default', fontFamily: 'inherit',
            }}
          >⏎</button>
          <button
            onClick={() => setText('')}
            title="Clear the prompt"
            style={{ ...chip(false), textAlign: 'center', padding: '3px 0' }}
          >CLR</button>
        </div>
      </div>

      {/* ── Save / show rail ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px 5px', flexShrink: 0 }}>
        <button
          style={chip(false)}
          title="Save this prompt"
          onClick={() => {
            if (!text.trim()) return
            setKit({ ...kit, saved: [newSaved(text.trim()), ...kit.saved] })
            setShowSaved(true)
          }}
        >＋ SAVE</button>
        <button style={chip(showSaved)} onClick={() => setShowSaved(v => !v)}
          title="Show saved prompts">▤ {kit.saved.length}</button>
        <div style={{ flex: 1 }} />
        {sent > 0 && (
          <span style={{ fontSize: 10.5, color: 'rgba(150,200,255,0.65)' }}>
            sent {sent}× · see History
          </span>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        {/* ── Tag workshop ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 6, minWidth: 0 }}>
          {kit.sections.map(sec => {
            const collapsed = !!sec.collapsed
            return (
              <div key={sec.id} style={{ marginBottom: 7 }}>
                {/* section header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 3 }}>
                  <button
                    onClick={() => patchSections(ss => ss.map(s =>
                      s.id === sec.id ? { ...s, collapsed: !collapsed } : s))}
                    title={collapsed ? 'Expand' : 'Collapse'}
                    style={{ ...ghostBtn, color: 'rgba(255,255,255,0.55)', fontSize: 13, padding: '0 4px' }}
                  >{collapsed ? '▸' : '▾'}</button>
                  {editing === `sec:${sec.id}` ? (
                    <InlineEdit
                      value={sec.label}
                      onCommit={v => {
                        if (v) patchSections(ss => ss.map(s => s.id === sec.id ? { ...s, label: v } : s))
                        setEditing(null)
                      }}
                      onCancel={() => setEditing(null)}
                      style={{ flex: 1 }}
                    />
                  ) : (
                    <div
                      onClick={() => setEditing(`sec:${sec.id}`)}
                      title="Click to rename"
                      style={{
                        flex: 1, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.6px',
                        textTransform: 'uppercase', color: 'rgba(255,255,255,0.32)',
                        cursor: 'text', userSelect: 'none',
                      }}
                    >{sec.label}{collapsed ? ` · ${sec.tags.length}` : ''}</div>
                  )}
                  <button style={ghostBtn} title="Add a tag here"
                    onClick={() => { setAddingTagTo(sec.id); if (collapsed) patchSections(ss => ss.map(s => s.id === sec.id ? { ...s, collapsed: false } : s)) }}>＋</button>
                  <button style={ghostBtn} title="Delete this section"
                    onClick={() => patchSections(ss => ss.filter(s => s.id !== sec.id))}>×</button>
                </div>

                {/* tags */}
                {!collapsed && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                    {sec.tags.map(tag => (
                      editing === `tag:${tag.id}` ? (
                        <InlineEdit
                          key={tag.id}
                          value={tag.text}
                          onCommit={v => {
                            patchSections(ss => ss.map(s => s.id !== sec.id ? s : {
                              ...s,
                              tags: v
                                ? s.tags.map(t => t.id === tag.id ? { ...t, text: v } : t)
                                : s.tags.filter(t => t.id !== tag.id),   // emptied = deleted
                            }))
                            setEditing(null)
                          }}
                          onCancel={() => setEditing(null)}
                          style={{ width: 130 }}
                        />
                      ) : (
                        <div key={tag.id} style={{ ...chip(false), display: 'flex', alignItems: 'center', gap: 2, padding: '2px 3px 2px 6px' }}>
                          <span onClick={() => append(tag.text)} title="Add to the prompt"
                            style={{ cursor: 'pointer' }}>+ {tag.text}</span>
                          <span onClick={() => setEditing(`tag:${tag.id}`)} title="Rename"
                            style={{ ...ghostBtn, fontSize: 10, opacity: 0.55, cursor: 'pointer' }}>✎</span>
                          <span
                            onClick={() => patchSections(ss => ss.map(s => s.id !== sec.id ? s
                              : { ...s, tags: s.tags.filter(t => t.id !== tag.id) }))}
                            title="Delete this tag"
                            style={{ ...ghostBtn, fontSize: 11, cursor: 'pointer' }}
                          >×</span>
                        </div>
                      )
                    ))}
                    {addingTagTo === sec.id && (
                      <InlineEdit
                        value=""
                        placeholder="new tag…"
                        onCommit={v => {
                          if (v) patchSections(ss => ss.map(s => s.id === sec.id
                            ? { ...s, tags: [...s.tags, newTag(v)] } : s))
                          setAddingTagTo(null)
                        }}
                        onCancel={() => setAddingTagTo(null)}
                        style={{ width: 130 }}
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })}

          <button
            style={{ ...chip(false), width: '100%', textAlign: 'center', marginTop: 2 }}
            onClick={() => {
              const s = newSection()
              setKit({ ...kit, sections: [...kit.sections, s] })
              setEditing(`sec:${s.id}`)
            }}
          >＋ new section</button>

          {showFooter && <div style={{
            marginTop: 8, fontSize: 10, lineHeight: 1.6, color: 'rgba(255,255,255,0.28)',
            borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 5,
          }}>
            click a tag to append it · ✎ rename · × delete · this vocabulary
            belongs to this pad
          </div>}
        </div>

        {/* ── Saved prompts rail ── */}
        {showSaved && !narrow && (
          <div style={{
            width: 158, flexShrink: 0, borderLeft: '1px solid rgba(255,255,255,0.08)',
            overflowY: 'auto', padding: 6,
          }}>
            <div style={{
              fontSize: 10.5, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.3)', marginBottom: 4,
            }}>Saved</div>
            {kit.saved.length === 0 && (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', lineHeight: 1.5 }}>
                Nothing saved yet. Write a prompt and hit SAVE.
              </div>
            )}
            {kit.saved.map(sp => (
              <div
                key={sp.id}
                style={{
                  padding: '4px 5px', marginBottom: 3, borderRadius: 3,
                  borderLeft: '2px solid rgba(140,190,255,0.5)',
                  background: 'rgba(255,255,255,0.03)',
                }}
              >
                {editing === `saved:${sp.id}` ? (
                  <InlineEdit
                    value={sp.label}
                    onCommit={v => {
                      setKit({
                        ...kit,
                        saved: kit.saved.map(x => x.id === sp.id ? { ...x, label: v || x.label } : x),
                      })
                      setEditing(null)
                    }}
                    onCancel={() => setEditing(null)}
                    style={{ width: '100%' }}
                  />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
                    <div
                      onClick={() => setText(sp.text)}
                      title="Click to load this prompt"
                      style={{
                        flex: 1, minWidth: 0, fontSize: 11, lineHeight: 1.4,
                        color: 'rgba(255,255,255,0.72)', cursor: 'pointer',
                      }}
                    >{sp.label}</div>
                    <span onClick={() => setEditing(`saved:${sp.id}`)} title="Rename"
                      style={{ ...ghostBtn, fontSize: 10, cursor: 'pointer' }}>✎</span>
                    <span
                      onClick={() => setKit({ ...kit, saved: kit.saved.filter(x => x.id !== sp.id) })}
                      title="Delete this saved prompt"
                      style={{ ...ghostBtn, fontSize: 10, cursor: 'pointer' }}
                    >×</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      </div>
      </CounterScaled>
    </div>
  )
}
