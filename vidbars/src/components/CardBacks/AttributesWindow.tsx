// AttributesWindow.tsx — the details on the backs of many cards, side by
// side (Brian 2026-11-06). Feed it cards (dock a deck against it, or magnet
// a Card Browser to it and search, e.g. "character": utils/cardBacks) and
// it shows the SHAPE first: the fields most of the cards share, each with
// how many have it, then the outliers, the fields only a few have and which
// cards those are. Pick a field to see every card's value of it at once,
// edit them in place, and leaf through the cards themselves on the right.
//
// Changing the shape: double-click a field's name to rename it on every
// card, drag one field onto another to merge them (same thing, two names),
// add a field to the cards missing it, or take it off them all. Each is one
// undo.

import React, { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { ContentScaled, panelContentScale } from '../UI/PanelSurface'
import { RenameInput } from '../UI/RenameInput'
import { cardTitle } from '../../utils/faceStyle'
import {
  useCardFeed, fieldsOf, isCommon, renameField, mergeFields, addField, removeField, setDetailValue,
  type Field, type FieldUse,
} from '../../utils/cardBacks'
import { CardBackStyles, CardPreview, DIM, EmptyFeed, FAINT, FeedBar, INK, LINE, MiniCard, PANEL_BG } from './cardBackUi'

const ACCENT = '#8fb6ff'

/** A value as the values strip groups it. */
const valueKey = (s: string) => s.trim().toLowerCase()

export const AttributesWindow: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const node = useFreeNodeStore(s => s.nodes[nodeId])
  const feed = useCardFeed(nodeId)
  const groups = useBoardsStore(s => s.groups)
  const byId = useMemo(() => new Map(groups.map(g => [g.id, g])), [groups])
  const cards = useMemo(() => feed.ids.map(id => byId.get(id)).filter((g): g is ProjectGroup => !!g), [feed.ids, byId])
  const fields = useMemo(() => fieldsOf(cards, groups), [cards, groups])
  const common = fields.filter(f => isCommon(f, cards.length))
  const outliers = fields.filter(f => !isCommon(f, cards.length))

  const [sel, setSel] = useState<string | null>(null)
  const field = fields.find(f => f.key === sel) ?? fields[0] ?? null
  // A value picked in the values strip, for the field it was picked in.
  const [picked, setPicked] = useState<{ field: string; value: string } | null>(null)
  const valueFilter = picked && picked.field === field?.key ? picked.value : null
  const setValueFilter = (v: string | null) => setPicked(v === null || !field ? null : { field: field.key, value: v })
  const [renaming, setRenaming] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)   // detail id
  const [drag, setDragState] = useState<{ from: string; over: string | null; x: number; y: number } | null>(null)
  const dragRef = useRef(drag)
  const setDrag = (d: typeof drag) => { dragRef.current = d; setDragState(d) }
  const [atRaw, setAt] = useState(0)
  const cancelEdit = useRef(false)

  // The cards the field pane shows: the ones with the field (one value, if
  // a value is picked), and the preview leafs through the same.
  const uses = useMemo(() => !field ? [] : field.uses.filter(u => valueFilter === null || valueKey(u.shown) === valueFilter), [field, valueFilter])
  const missing = useMemo(() => !field ? [] : cards.filter(g => !field.uses.some(u => u.card.id === g.id)), [field, cards])
  const previewList = field ? [...uses.map(u => u.card), ...(valueFilter === null ? missing : [])] : cards
  const at = atRaw < previewList.length ? atRaw : 0

  const values = useMemo(() => {
    if (!field) return []
    const m = new Map<string, { text: string; n: number }>()
    for (const u of field.uses) {
      const k = valueKey(u.shown)
      const e = m.get(k)
      if (e) e.n++
      else m.set(k, { text: u.shown.trim(), n: 1 })
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n || a[1].text.localeCompare(b[1].text))
  }, [field])

  // Drag a field row onto another: merge them.
  const startDrag = (e: React.PointerEvent, from: string) => {
    if (e.button !== 0) return
    const sx = e.clientX, sy = e.clientY
    let on = false
    const move = (ev: PointerEvent) => {
      if (!on && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return
      on = true
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-attr-field]') as HTMLElement | null
      const over = el && el.closest(`[data-attr-window="${nodeId}"]`) ? el.dataset.attrField ?? null : null
      setDrag({ from, over: over === from ? null : over, x: ev.clientX, y: ev.clientY })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const over = dragRef.current?.over
      setDrag(null)
      if (over) {
        const into = fields.find(f => f.key === over)
        if (into) { mergeFields(feed.ids, from, into.key, into.name); setSel(into.key) }
      }
      if (!on) setSel(from)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const rootRef = useRef<HTMLDivElement>(null)
  const onKey = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setAt((at + 1) % Math.max(1, previewList.length)) }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setAt((at - 1 + previewList.length) % Math.max(1, previewList.length)) }
  }

  const fromField = drag ? fields.find(f => f.key === drag.from) : null
  const overField = drag?.over ? fields.find(f => f.key === drag.over) : null

  const fieldRow = (f: Field, outlier: boolean) => {
    const on = field?.key === f.key
    const target = drag?.over === f.key
    const share = cards.length ? f.uses.length / cards.length : 0
    return (
      <div
        key={f.key}
        data-attr-field={f.key}
        onPointerDown={e => startDrag(e, f.key)}
        onDoubleClick={() => { setSel(f.key); setRenaming(true) }}
        title={`${f.name}: on ${f.uses.length} of ${cards.length} cards${f.spellings.length ? ` (also spelled ${f.spellings.join(', ')})` : ''}. Click to look, double-click to rename, drag onto another field to merge.`}
        style={{
          padding: '6px 8px 7px', borderRadius: 7, marginBottom: 3, cursor: drag ? 'copy' : 'pointer', userSelect: 'none',
          background: target ? 'rgba(143,182,255,0.22)' : on ? 'rgba(143,182,255,0.12)' : 'rgba(255,255,255,0.025)',
          border: `1px solid ${target ? ACCENT : on ? 'rgba(143,182,255,0.45)' : LINE}`,
          opacity: drag?.from === f.key ? 0.45 : 1,
          transition: 'background 0.1s, border-color 0.1s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 650, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
          {f.spellings.length > 0 && <span style={{ fontSize: 10, color: '#ffcf7a', whiteSpace: 'nowrap' }} title={`Also spelled: ${f.spellings.join(', ')}`}>+{f.spellings.length} spelling{f.spellings.length > 1 ? 's' : ''}</span>}
          <span style={{ fontSize: 11, color: DIM, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{f.uses.length}<span style={{ color: FAINT }}>/{cards.length}</span></span>
        </div>
        {outlier ? (
          <div style={{ display: 'flex', gap: 3, marginTop: 5, alignItems: 'center' }}>
            {f.uses.slice(0, 9).map(u => <MiniCard key={u.card.id} g={u.card} w={14} />)}
            {f.uses.length > 9 && <span style={{ fontSize: 10, color: FAINT }}>+{f.uses.length - 9}</span>}
            <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: FAINT, marginLeft: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {f.uses.slice(0, 3).map(u => cardTitle(groups, u.card) || 'Untitled').join(', ')}
            </span>
          </div>
        ) : (
          <div
            title={`On ${f.uses.length} of ${cards.length} cards, filled in on ${f.filled}`}
            style={{ position: 'relative', height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.07)', marginTop: 6, overflow: 'hidden' }}
          >
            {/* Faint: on the card. Bright: filled in. */}
            <div style={{ position: 'absolute', inset: 0, width: `${share * 100}%`, borderRadius: 2, background: 'rgba(143,182,255,0.25)' }} />
            <div style={{ position: 'absolute', inset: 0, width: `${(cards.length ? f.filled / cards.length : 0) * 100}%`, borderRadius: 2, background: `linear-gradient(90deg, ${ACCENT}, #b59cff)` }} />
          </div>
        )}
      </div>
    )
  }

  const btn = (tone: 'plain' | 'go' | 'warn' = 'plain'): React.CSSProperties => ({
    height: 26, padding: '0 10px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
    background: tone === 'go' ? 'rgba(143,182,255,0.18)' : 'rgba(255,255,255,0.05)',
    border: `1px solid ${tone === 'go' ? 'rgba(143,182,255,0.5)' : tone === 'warn' ? 'rgba(255,120,110,0.35)' : LINE}`,
    color: tone === 'warn' ? '#ff9f96' : INK, whiteSpace: 'nowrap',
  })

  const section = (label: string, n: number, hint: string) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '10px 2px 6px' }} title={hint}>
      <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: DIM }}>{label}</span>
      <span style={{ fontSize: 10.5, color: FAINT }}>{n}</span>
    </div>
  )

  const tile = (u: FieldUse, i: number) => {
    const g = u.card
    const lit = previewList[at]?.id === g.id
    const isEditing = editing === u.detail.id
    return (
      <div
        key={g.id}
        onClick={() => setAt(i)}
        style={{
          display: 'flex', gap: 9, padding: 7, borderRadius: 9, cursor: 'pointer', minWidth: 0,
          background: lit ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.03)',
          border: `1px solid ${lit ? g.color : LINE}`, transition: 'border-color 0.12s, background 0.12s',
        }}
      >
        <MiniCard g={g} w={40} lit={lit} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ fontSize: 11, color: DIM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cardTitle(groups, g) || 'Untitled'}</div>
          {isEditing ? (
            <textarea
              autoFocus
              defaultValue={u.detail.value}
              onClick={e => e.stopPropagation()}
              onKeyDown={e => {
                e.stopPropagation()
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); setDetailValue(g.id, u.detail.id, (e.target as HTMLTextAreaElement).value); setEditing(null) }
                if (e.key === 'Escape') { cancelEdit.current = true; setEditing(null) }
              }}
              onBlur={e => { if (cancelEdit.current) cancelEdit.current = false; else setDetailValue(g.id, u.detail.id, e.target.value); setEditing(null) }}
              rows={2}
              style={{
                resize: 'none', width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.35,
                background: 'rgba(0,0,0,0.35)', color: INK, border: `1px solid ${ACCENT}`, borderRadius: 5, padding: '3px 5px', outline: 'none',
              }}
            />
          ) : (
            <div
              onClick={e => { if (u.detail.link) return; e.stopPropagation(); setAt(i); setEditing(u.detail.id) }}
              title={u.detail.link ? 'Linked to another card: edit it on the card' : 'Click to edit'}
              style={{
                fontSize: 13.5, lineHeight: 1.35, color: u.shown.trim() ? INK : FAINT, cursor: u.detail.link ? 'default' : 'text',
                fontStyle: u.detail.link ? 'italic' : 'normal', wordBreak: 'break-word',
                display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                borderRadius: 4, padding: '1px 3px', margin: '0 -3px',
              }}
            >{u.detail.link && '↗ '}{u.shown.trim() || 'empty'}</div>
          )}
        </div>
      </div>
    )
  }

  if (!node) return null
  return (
    <div
      ref={rootRef}
      data-attr-window={nodeId}
      tabIndex={0}
      onKeyDown={onKey}
      onPointerDown={e => { e.stopPropagation(); if (!(e.target as HTMLElement).closest('input,textarea')) rootRef.current?.focus({ preventScroll: true }) }}
      onWheel={e => e.stopPropagation()}
      data-wheel-own=""
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: PANEL_BG, outline: 'none' }}
    >
      <CardBackStyles />
      <ContentScaled factor={panelContentScale(node)}>
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif', color: INK }}>
          <FeedBar feed={feed} cards={cards} />
          {cards.length === 0 ? <EmptyFeed what="Then their backs show here side by side." /> : (
            <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
              {/* ── The fields: shared by most, then the outliers ── */}
              <div style={{ width: 280, flexShrink: 0, borderRight: `1px solid ${LINE}`, overflowY: 'auto', padding: '2px 10px 10px' }} data-wheel-own="">
                {section('Shared by most', common.length, 'On at least half of the cards')}
                {common.map(f => fieldRow(f, false))}
                {common.length === 0 && <div style={{ fontSize: 12, color: FAINT, padding: '2px 4px' }}>No field is on half the cards.</div>}
                {section('Outliers', outliers.length, 'On fewer than half of the cards')}
                {outliers.map(f => fieldRow(f, true))}
                {outliers.length === 0 && <div style={{ fontSize: 12, color: FAINT, padding: '2px 4px' }}>None. Every field is shared.</div>}
                <div style={{ marginTop: 10 }}>
                  {adding ? (
                    <RenameInput
                      autoFocus
                      placeholder={`New field on all ${cards.length} cards`}
                      onPointerDown={e => e.stopPropagation()}
                      onKeyDown={e => {
                        e.stopPropagation()
                        const v = (e.target as HTMLInputElement).value
                        if (e.key === 'Enter') { if (v.trim()) { addField(feed.ids, v); setSel(v.trim().toLowerCase()) } setAdding(false) }
                        if (e.key === 'Escape') setAdding(false)
                      }}
                      onBlur={() => setAdding(false)}
                      style={{ width: '100%', boxSizing: 'border-box', height: 28, fontSize: 12.5, background: 'rgba(0,0,0,0.35)', color: INK, border: `1px solid ${ACCENT}`, borderRadius: 7, padding: '0 8px', outline: 'none', fontFamily: 'inherit' }}
                    />
                  ) : (
                    <button style={{ ...btn(), width: '100%' }} onClick={() => setAdding(true)}>＋ New field on every card</button>
                  )}
                </div>
              </div>

              {/* ── One field, every card's value ── */}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                {field && (
                  <div style={{ padding: '12px 14px 8px', borderBottom: `1px solid ${LINE}`, flexShrink: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {renaming ? (
                        <RenameInput
                          autoFocus
                          defaultValue={field.name}
                          onPointerDown={e => e.stopPropagation()}
                          onKeyDown={e => {
                            e.stopPropagation()
                            const v = (e.target as HTMLInputElement).value
                            if (e.key === 'Enter') { renameField(feed.ids, field.key, v); setSel(v.trim().toLowerCase()); setRenaming(false) }
                            if (e.key === 'Escape') setRenaming(false)
                          }}
                          onBlur={e => { renameField(feed.ids, field.key, e.target.value); setSel(e.target.value.trim().toLowerCase() || field.key); setRenaming(false) }}
                          style={{ fontSize: 20, fontWeight: 700, background: 'rgba(0,0,0,0.35)', color: INK, border: `1px solid ${ACCENT}`, borderRadius: 7, padding: '1px 8px', outline: 'none', fontFamily: 'inherit', width: 220 }}
                        />
                      ) : (
                        <span onDoubleClick={() => setRenaming(true)} title="Double-click to rename it on every card" style={{ fontSize: 20, fontWeight: 750, color: INK, cursor: 'text' }}>{field.name}</span>
                      )}
                      <span style={{ fontSize: 12, color: DIM }}>on {field.uses.length} of {cards.length} cards · {field.filled} filled in</span>
                      <div style={{ flex: 1 }} />
                      <button style={btn()} onClick={() => setRenaming(true)} title="Rename it on every card that has it">Rename</button>
                      {missing.length > 0 && <button style={btn('go')} onClick={() => addField(missing.map(g => g.id), field.name)} title="Add it, empty, to every card without it">＋ Add to {missing.length} missing</button>}
                      <button style={btn('warn')} onClick={() => { removeField(feed.ids, field.key); setSel(null) }} title="Take it off every card (Ctrl+Z brings it back)">Remove from all</button>
                    </div>
                    {/* The values in use, the most common first: the bulk and the odd ones out. */}
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 9 }}>
                      {values.map(([k, v]) => {
                        const on = valueFilter === k
                        return (
                          <button
                            key={k}
                            onClick={() => { setValueFilter(on ? null : k); setAt(0) }}
                            title={on ? 'Show every value again' : 'Show only the cards with this value'}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 9px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
                              background: on ? 'rgba(143,182,255,0.25)' : 'rgba(255,255,255,0.05)',
                              border: `1px solid ${on ? ACCENT : LINE}`, color: v.text ? INK : FAINT, fontSize: 12, maxWidth: 260,
                            }}
                          >
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.text || 'empty'}</span>
                            <span style={{ fontSize: 10.5, color: DIM, background: 'rgba(255,255,255,0.08)', borderRadius: 8, padding: '0 5px' }}>{v.n}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
                <div style={{ flex: 1, overflowY: 'auto', padding: 12 }} data-wheel-own="">
                  {!field && <div style={{ color: DIM, fontSize: 13 }}>These cards have nothing on their backs yet. Add a field on the left.</div>}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 7 }}>
                    {uses.map((u, i) => tile(u, i))}
                  </div>
                  {field && valueFilter === null && missing.length > 0 && (
                    <>
                      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: DIM, margin: '16px 2px 7px' }}>
                        Without {field.name} <span style={{ color: FAINT, fontWeight: 600 }}>{missing.length}</span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {missing.map((g, j) => {
                          const i = uses.length + j
                          return (
                            <div key={g.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, width: 64 }}>
                              <MiniCard g={g} w={44} dim={previewList[at]?.id !== g.id} lit={previewList[at]?.id === g.id} onClick={() => setAt(i)} />
                              <div style={{ fontSize: 10, color: DIM, width: '100%', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cardTitle(groups, g) || 'Untitled'}</div>
                              <button style={{ ...btn(), height: 20, fontSize: 10.5, padding: '0 6px' }} onClick={() => addField([g.id], field.name)} title={`Add ${field.name} to this card`}>＋ add</button>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* ── The card itself, to leaf through ── */}
              <div style={{ width: 270, flexShrink: 0, borderLeft: `1px solid ${LINE}`, padding: '16px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'rgba(0,0,0,0.18)' }}>
                {previewList.length > 0 && <CardPreview list={previewList} at={at} onAt={setAt} field={field?.key ?? null} width={230} />}
                <div style={{ fontSize: 10.5, color: FAINT, marginTop: 10, textAlign: 'center', lineHeight: 1.5 }}>← → leaf through · click the card to turn it over</div>
              </div>
            </div>
          )}
        </div>
      </ContentScaled>
      {/* The field being dragged, and where it would go. */}
      {drag && fromField && createPortal(
        <div style={{
          position: 'fixed', left: drag.x + 12, top: drag.y + 10, zIndex: 10000, pointerEvents: 'none',
          padding: '5px 10px', borderRadius: 8, fontSize: 12, fontFamily: 'system-ui, sans-serif',
          background: overField ? 'rgba(40,60,110,0.95)' : 'rgba(20,22,32,0.92)', color: INK,
          border: `1px solid ${overField ? ACCENT : LINE}`, boxShadow: '0 6px 18px rgba(0,0,0,0.5)', whiteSpace: 'nowrap',
        }}>
          {overField ? <>Merge <b>{fromField.name}</b> into <b>{overField.name}</b></> : <>Drop on a field to merge <b>{fromField.name}</b> into it</>}
        </div>, document.body,
      )}
    </div>
  )
}
