// A STATE card's face (Brian 2026-11-08): the workshop where a thing's
// states are added and wired together with changes (utils/stateCard).
//
//   STATES    one row each, grouped ones indented under their state. The
//             lit dot is the current state; click a row to pick it. Pointed
//             at, a row shows: go to its master deck, add a state under it,
//             take it off. Double-click the name to rename. A card's link
//             "+" let go on a row makes that card's deck the state's deck;
//             let go on "+ State" it makes a new state from that deck.
//   CHANGES   what takes it from one state to another ("Hero drops it").
//             Click its name to make the change (picks its "to" state);
//             click from / to to choose them from the list.
//   OUTPUT    the deck of linked cards that shows the current state.
//
// Rows keep their size and place: the controls on a row are always there,
// only lit when pointed at, so nothing moves under the hand.

import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import {
  allChanges, hasMark, markLabel, type StateMark,
  addState, deckCards, editStates, goToCard, makeOutput, outputCards, pickState, removeState, stateTree,
  type StateMachine,
} from '../../utils/stateCard'
import { newDetailId } from '../../utils/cardTypes'

const stopPress = (e: React.PointerEvent) => { if (e.button === 0) e.stopPropagation() }

/** The plain list of state names a state is picked from (the header's
 *  picker, a change's from / to): names only, grouped ones indented. */
export const StateMenu: React.FC<{
  m: StateMachine; x: number; y: number; current?: string
  onPick: (stateId: string) => void; onClose: () => void
}> = ({ m, x, y, current, onPick, onClose }) => {
  const tree = stateTree(m)
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(y)
  useEffect(() => {
    const h = ref.current?.offsetHeight ?? 0
    if (y + h > window.innerHeight - 8) setTop(Math.max(8, window.innerHeight - 8 - h))
  }, [y])
  return ReactDOM.createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={e => { e.stopPropagation(); onClose() }} />
      <div
        ref={ref}
        data-state-menu
        onPointerDown={e => e.stopPropagation()}
        style={{
          position: 'fixed', left: x, top, zIndex: 9999, minWidth: 150, maxHeight: '70vh', overflowY: 'auto',
          background: 'rgba(22,24,34,0.97)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8,
          boxShadow: '0 8px 28px rgba(0,0,0,0.5)', padding: '4px 0', fontSize: 12.5,
          fontFamily: 'system-ui, -apple-system, sans-serif', color: 'rgba(255,255,255,0.88)',
        }}
      >
        {tree.length === 0 && <div style={{ padding: '5px 12px', color: 'rgba(255,255,255,0.4)' }}>No states yet</div>}
        {tree.map(({ s, depth }) => {
          const lit = s.id === current
          return (
            <div
              key={s.id}
              data-state-pick={s.name}
              onClick={() => { onPick(s.id); onClose() }}
              style={{
                padding: `4px 14px 4px ${12 + depth * 14}px`, cursor: 'pointer', whiteSpace: 'nowrap',
                background: lit ? 'rgba(127,209,255,0.18)' : undefined,
                color: lit ? 'rgba(160,220,255,1)' : undefined, fontWeight: lit ? 700 : 500,
              }}
              onPointerEnter={e => { if (!lit) e.currentTarget.style.background = 'rgba(255,255,255,0.07)' }}
              onPointerLeave={e => { if (!lit) e.currentTarget.style.background = '' }}
            >{depth > 0 ? '└ ' : ''}{s.name}</div>
          )
        })}
      </div>
    </>,
    document.body,
  )
}

/** The changes that can be put on a scene card or a storyline dot: every
 *  State card's, under its name. On/off items, lit while on; the list stays
 *  open for more. */
export const ChangeMenu: React.FC<{ x: number; y: number; marks: StateMark[] | undefined; onToggle: (k: StateMark) => void; onClose: () => void }> = ({ x, y, marks, onToggle, onClose }) => {
  const groups = useBoardsStore(s => s.groups)
  const list = allChanges(groups)
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(y)
  const [left, setLeft] = useState(x)
  useEffect(() => {
    const h = ref.current?.offsetHeight ?? 0, w = ref.current?.offsetWidth ?? 0
    if (y + h > window.innerHeight - 8) setTop(Math.max(8, window.innerHeight - 8 - h))
    if (x + w > window.innerWidth - 8) setLeft(Math.max(8, window.innerWidth - 8 - w))
  }, [x, y])
  const nameOf = (sc: ProjectGroup, sid?: string) => sc.stateCard?.states.find(s => s.id === sid)?.name ?? 'any'
  let last = ''
  return ReactDOM.createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={e => { e.stopPropagation(); onClose() }} onContextMenu={e => { e.preventDefault(); onClose() }} />
      <div ref={ref} data-change-menu onPointerDown={e => e.stopPropagation()} style={{
        position: 'fixed', left, top, zIndex: 9999, minWidth: 220, maxHeight: '70vh', overflowY: 'auto',
        background: 'rgba(22,24,34,0.97)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8,
        boxShadow: '0 8px 28px rgba(0,0,0,0.5)', padding: '4px 0', fontSize: 12.5,
        fontFamily: 'system-ui, -apple-system, sans-serif', color: 'rgba(255,255,255,0.88)',
      }}>
        {list.length === 0 && <div style={{ padding: '6px 12px', color: 'rgba(255,255,255,0.45)' }}>No changes yet: add them on a State card</div>}
        {list.map(({ sc, change }) => {
          const k = { state: sc.id, change: change.id }
          const on = hasMark(marks, k)
          const head = sc.id !== last ? (last = sc.id, sc.name || 'State') : null
          return (
            <React.Fragment key={`${sc.id}:${change.id}`}>
              {head && <div style={{ padding: '6px 12px 2px', fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', color: 'rgba(255,255,255,0.45)' }}>{head.toUpperCase()}</div>}
              <div data-change-pick={change.name} onClick={() => onToggle(k)}
                style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 14px 4px 16px', cursor: 'pointer', whiteSpace: 'nowrap',
                  background: on ? 'rgba(127,209,255,0.18)' : undefined, color: on ? 'rgba(160,220,255,1)' : undefined, fontWeight: on ? 700 : 500 }}
                onPointerEnter={e => { if (!on) e.currentTarget.style.background = 'rgba(255,255,255,0.07)' }}
                onPointerLeave={e => { if (!on) e.currentTarget.style.background = '' }}>
                <span style={{ flex: '1 1 auto' }}>{change.name}</span>
                <span style={{ fontSize: 11, opacity: 0.6 }}>{nameOf(sc, change.from)} → {nameOf(sc, change.to)}</span>
              </div>
            </React.Fragment>
          )
        })}
      </div>
    </>,
    document.body,
  )
}

/** Small tags saying what changes happen here ("Cup → Broken"). */
export const MarkTags: React.FC<{ marks: StateMark[] | undefined; font: number }> = ({ marks, font }) => {
  const groups = useBoardsStore(s => s.groups)
  const labels = (marks ?? []).map(k => markLabel(groups, k)).filter((x): x is string => !!x)
  if (!labels.length) return null
  return (
    <div data-mark-tags style={{ display: 'flex', flexWrap: 'wrap', gap: font * 0.35, pointerEvents: 'none' }}>
      {labels.map((l, i) => (
        <span key={i} style={{ fontSize: font, fontWeight: 700, lineHeight: 1.3, padding: `0 ${font * 0.5}px`, borderRadius: font,
          background: 'rgba(79,143,90,0.92)', color: '#fff', border: '1px solid rgba(255,255,255,0.35)', whiteSpace: 'nowrap',
          boxShadow: '0 1px 4px rgba(0,0,0,0.4)', fontFamily: 'system-ui, -apple-system, sans-serif' }}>{l}</span>
      ))}
    </div>
  )
}

/** The current state, picked by name, in a State card's header (and on its
 *  output deck's front). A fixed width, so the header never shifts. */
export const StatePicker: React.FC<{ stateCardId: string; height: number; width: number; font: number }> = ({ stateCardId, height, width, font }) => {
  const m = useBoardsStore(s => s.groups.find(g => g.id === stateCardId)?.stateCard)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  if (!m) return null
  const cur = m.states.find(s => s.id === m.current)
  return (
    <>
      <div
        data-state-picker
        title="Pick the state"
        onPointerDown={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
        onClick={e => {
          e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          setMenu(menu ? null : { x: r.left, y: r.bottom + 2 })
        }}
        style={{
          flex: '0 0 auto', width, height, boxSizing: 'border-box',
          display: 'flex', alignItems: 'center', gap: font * 0.3, padding: `0 ${font * 0.5}px`,
          borderRadius: height * 0.3, background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.18)',
          color: cur ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.45)', fontSize: font, fontWeight: 700,
          cursor: 'pointer', overflow: 'hidden', whiteSpace: 'nowrap',
        }}
      >
        <span style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{cur?.name ?? 'No state'}</span>
        <span style={{ flex: '0 0 auto', opacity: 0.7, fontSize: font * 0.8 }}>▾</span>
      </div>
      {menu && <StateMenu m={m} x={menu.x} y={menu.y} current={m.current} onPick={id => pickState(stateCardId, id)} onClose={() => setMenu(null)} />}
    </>
  )
}

/** Renaming a state or a change in place. */
const NameInput: React.FC<{ value: string; font: number; onDone: (v: string | null) => void }> = ({ value, font, onDone }) => {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => { requestAnimationFrame(() => { ref.current?.focus(); ref.current?.select() }) }, [])
  const finish = (v: string | null) => { if (done.current) return; done.current = true; onDone(v) }
  return (
    <input
      ref={ref}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => finish(draft.trim() || null)}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') finish(draft.trim() || null); if (e.key === 'Escape') finish(null) }}
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      style={{
        flex: '1 1 0', minWidth: 0, font: 'inherit', fontSize: font, fontWeight: 600, color: '#fff',
        background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.35)', borderRadius: 3, padding: '0 3px', outline: 'none',
      }}
    />
  )
}

/** A small control on a row: always laid out, lit only when the row is
 *  pointed at. */
const Knob: React.FC<{ show: boolean; title: string; size: number; onClick: (e: React.MouseEvent) => void; children: React.ReactNode; attr?: string }> = ({ show, title, size, onClick, children, attr }) => (
  <button
    type="button"
    title={title}
    {...(attr ? { [attr]: '' } : {})}
    onPointerDown={stopPress}
    onDoubleClick={e => e.stopPropagation()}
    onClick={e => { e.stopPropagation(); onClick(e) }}
    style={{
      flex: '0 0 auto', width: size, height: size, padding: 0, border: 'none', borderRadius: size * 0.25,
      background: 'rgba(0,0,0,0.25)', color: 'rgba(255,255,255,0.9)', fontSize: size * 0.7, lineHeight: 1,
      cursor: 'pointer', opacity: show ? 1 : 0, pointerEvents: show ? 'auto' : 'none', transition: 'opacity 0.1s',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit',
    }}
  >{children}</button>
)

export const StateFace: React.FC<{ group: ProjectGroup; width: number; height: number; reserve: number }> = ({ group, width, height, reserve }) => {
  const m = group.stateCard!
  const id = group.id
  // Only what the face shows of other cards (deck sizes, the output's), so
  // it is not redrawn on every edit anywhere.
  const seen = useBoardsStore(s => {
    const out = m.output && s.groups.some(g => g.id === m.output) ? outputCards(s.groups, id) : []
    return [...m.states.map(st => (st.deck ? deckCards(s.groups, st.deck).length : 0)),
      out.length, out.length === 1 && !out[0].linkOf ? 'e' : ''].join(',')
  })
  const parts = seen.split(',')
  const countOf = (i: number) => Number(parts[i]) || 0
  const outLen = countOf(m.states.length)
  const outEmpty = parts[m.states.length + 1] === 'e'
  const [hover, setHover] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; change: string; end: 'from' | 'to' } | null>(null)
  // A click, not a drag: the card did not move between press and release.
  const downAt = useRef<{ x: number; y: number } | null>(null)
  const where = () => { const g = useBoardsStore.getState().groups.find(x => x.id === id); return { x: g?.originX ?? 0, y: g?.originY ?? 0 } }
  const clickable = (f: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => { if (e.button === 0) downAt.current = where() },
    onClick: (e: React.MouseEvent) => {
      const a = downAt.current, b = where()
      downAt.current = null
      if (e.button !== 0 || !a || Math.hypot(a.x - b.x, a.y - b.y) > 0.5) return
      e.stopPropagation()
      f()
    },
  })

  const tree = stateTree(m)
  const nameOf = (sid?: string) => m.states.find(s => s.id === sid)?.name

  const pad = width * 0.05
  const rows = 3 + tree.length + 1 + m.changes.length + 1 + 1
  const rowH = Math.max(4, Math.min(width * 0.085, (height - reserve - Math.max(pad, reserve * 0.75)) / rows))
  const font = rowH * 0.56
  const knob = rowH * 0.72
  const show = (k: string) => hover === k

  const label = (text: string) => (
    <div style={{ height: rowH, display: 'flex', alignItems: 'flex-end', paddingBottom: rowH * 0.12, boxSizing: 'border-box',
      fontSize: font * 0.78, fontWeight: 800, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.55)' }}>{text}</div>
  )
  const rowStyle = (k: string, lit = false): React.CSSProperties => ({
    height: rowH, display: 'flex', alignItems: 'center', gap: rowH * 0.18, boxSizing: 'border-box',
    padding: `0 ${rowH * 0.2}px`, borderRadius: rowH * 0.22, cursor: 'pointer',
    background: lit ? 'rgba(255,255,255,0.2)' : hover === k ? 'rgba(255,255,255,0.09)' : 'transparent',
  })
  const addRow = (k: string, text: string, onClick: () => void, drop?: string) => (
    <div data-state-add={k} {...(drop ? { 'data-link-drop': drop } : {})} {...clickable(onClick)}
      onPointerEnter={() => setHover(k)} onPointerLeave={() => setHover(null)}
      style={{ ...rowStyle(k), color: 'rgba(255,255,255,0.6)', fontSize: font * 0.9, fontWeight: 600 }}>{text}</div>
  )

  return (
    <div data-state-face style={{
      position: 'absolute', inset: 0, paddingTop: Math.max(pad, reserve * 0.75), paddingLeft: pad, paddingRight: pad, paddingBottom: reserve, boxSizing: 'border-box', overflow: 'hidden',
      fontFamily: 'system-ui, -apple-system, sans-serif', color: 'rgba(255,255,255,0.92)', fontSize: font,
    }}>
      {label('STATES')}
      {tree.map(({ s, depth }) => {
        const k = `s:${s.id}`
        const lit = s.id === m.current
        const n = countOf(m.states.indexOf(s))
        return (
          <div key={s.id} data-state-row={s.name} data-link-drop={`statedeck:${id}:${s.id}`}
            {...clickable(() => pickState(id, s.id))}
            onPointerEnter={() => setHover(k)} onPointerLeave={() => setHover(null)}
            style={{ ...rowStyle(k, lit), paddingLeft: rowH * 0.2 + depth * rowH * 0.7 }}>
            <span style={{
              flex: '0 0 auto', width: rowH * 0.36, height: rowH * 0.36, borderRadius: '50%',
              background: lit ? '#9fe0ff' : 'transparent', border: `${Math.max(1, rowH * 0.06)}px solid ${lit ? '#9fe0ff' : 'rgba(255,255,255,0.5)'}`,
            }} />
            {renaming === k
              ? <NameInput value={s.name} font={font} onDone={v => { setRenaming(null); if (v && v !== s.name) editStates(id, x => ({ ...x, states: x.states.map(o => o.id === s.id ? { ...o, name: v } : o) })) }} />
              : <span onDoubleClick={e => { e.stopPropagation(); setRenaming(k) }}
                  style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: lit ? 700 : 500 }}>{s.name}</span>}
            <span title={s.deck ? `${n} card${n === 1 ? '' : 's'} in its deck` : 'No deck: let a card\'s + go here'}
              style={{ flex: '0 0 auto', fontSize: font * 0.85, color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums' }}>{s.deck && n ? n : '–'}</span>
            <Knob show={show(k) && !!s.deck} title="Go to its deck" size={knob} attr="data-state-go" onClick={() => s.deck && goToCard(s.deck)}>↗</Knob>
            <Knob show={show(k)} title="Add a state under this one" size={knob} attr="data-state-sub" onClick={() => addState(id, { parent: s.id })}>+</Knob>
            <Knob show={show(k)} title="Take this state off (its deck stays on the canvas)" size={knob} attr="data-state-remove" onClick={() => editStates(id, x => removeState(x, s.id))}>×</Knob>
          </div>
        )
      })}
      {addRow('add-state', '+ State', () => addState(id), `statedeck:${id}:new`)}

      {label('CHANGES')}
      {m.changes.map(c => {
        const k = `c:${c.id}`
        const end = (which: 'from' | 'to') => (
          <span data-state-change-end={which}
            onPointerDown={stopPress} onDoubleClick={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 2, change: c.id, end: which }) }}
            style={{ flex: '0 1 auto', minWidth: 0, maxWidth: '28%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: font * 0.85, padding: `0 ${rowH * 0.15}px`, borderRadius: rowH * 0.18, background: 'rgba(0,0,0,0.22)',
              color: nameOf(c[which]) ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.4)' }}>{nameOf(c[which]) ?? 'any'}</span>
        )
        return (
          <div key={c.id} data-state-change={c.name}
            {...clickable(() => { if (c.to) pickState(id, c.to) })}
            onPointerEnter={() => setHover(k)} onPointerLeave={() => setHover(null)}
            title={c.to ? `Make the change: ${nameOf(c.to)}` : 'Pick where it goes'}
            style={rowStyle(k)}>
            <span style={{ flex: '0 0 auto', fontSize: font * 0.9, color: 'rgba(255,255,255,0.6)' }}>⇢</span>
            {renaming === k
              ? <NameInput value={c.name} font={font} onDone={v => { setRenaming(null); if (v && v !== c.name) editStates(id, x => ({ ...x, changes: x.changes.map(o => o.id === c.id ? { ...o, name: v } : o) })) }} />
              : <span onDoubleClick={e => { e.stopPropagation(); setRenaming(k) }}
                  style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{c.name}</span>}
            {end('from')}
            <span style={{ flex: '0 0 auto', fontSize: font * 0.8, color: 'rgba(255,255,255,0.5)' }}>→</span>
            {end('to')}
            <Knob show={show(k)} title="Take this change off" size={knob} attr="data-change-remove" onClick={() => editStates(id, x => ({ ...x, changes: x.changes.filter(o => o.id !== c.id) }))}>×</Knob>
          </div>
        )
      })}
      {addRow('add-change', '+ Change', () => editStates(id, x => {
        // From the current state to the next one in the list.
        const t = stateTree(x).map(e => e.s.id)
        const at = t.indexOf(x.current ?? '')
        return { ...x, changes: [...x.changes, { id: newDetailId(), name: 'Change', from: x.current, to: t[at + 1] ?? t[0] }] }
      }))}

      {label('OUTPUT')}
      {m.output && outLen ? (
        <div data-state-output {...clickable(() => goToCard(m.output!))}
          onPointerEnter={() => setHover('out')} onPointerLeave={() => setHover(null)}
          title="Go to the output deck" style={rowStyle('out')}>
          <span style={{ flex: '0 0 auto', fontSize: font * 0.9 }}>🂠</span>
          <span style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
            {group.name || 'Output'} deck
          </span>
          <span style={{ flex: '0 0 auto', fontSize: font * 0.85, color: 'rgba(255,255,255,0.55)' }}>
            {outEmpty ? 'empty' : `${outLen} card${outLen === 1 ? '' : 's'}`}
          </span>
          <span style={{ flex: '0 0 auto', width: knob, textAlign: 'center', opacity: show('out') ? 1 : 0 }}>↗</span>
        </div>
      ) : addRow('make-output', '+ Make the output deck', () => makeOutput(id))}

      {menu && (
        <StateMenu m={m} x={menu.x} y={menu.y}
          current={m.changes.find(c => c.id === menu.change)?.[menu.end]}
          onPick={sid => editStates(id, x => ({ ...x, changes: x.changes.map(c => c.id === menu.change ? { ...c, [menu.end]: sid } : c) }))}
          onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
