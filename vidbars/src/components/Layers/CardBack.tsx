// The back of a card: its DETAILS side (Brian 2026-11-04). The Flip
// button turns a card over with a short animation; the back lists the
// card's details as name / value rows you can add, rename, change and
// remove. Data lives on the card itself (ProjectGroup.flipped / details).

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useBoardsStore } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { edgeColorFromHex, hexToHsl, hslToHex } from '../../utils/colorUtils'
import { newDetailId, type CardDetail } from '../../utils/cardTypes'

/** The back is laid out at a new card's own size and scaled with the card,
 *  so it reads the same at every zoom: nothing reflows as you zoom. */
const BACK_W = 125
const BACK_H = 184

/** The card's back colour: its own colour, deeper. */
export function backColor(color: string): string {
  try {
    const { h, s, l } = hexToHsl(color)
    return hslToHex(h, Math.min(1, s * 0.9), Math.max(0.08, l * 0.42))
  } catch { return '#1a1d29' }
}

/** Shows the side `flipped` asks for, turning the card element over to get
 *  there: a quarter turn away, the side swaps edge-on, a quarter turn back.
 *  It only animates `transform`, on top of whatever the card has (a card
 *  stood up in 3D keeps its own), so it is the same card flat or tilted. */
export function useCardFlip(flipped: boolean, ref: React.RefObject<HTMLElement | null>, flat: boolean): boolean {
  const [shown, setShown] = useState(flipped)
  const shownRef = useRef(shown)
  shownRef.current = shown
  const anim = useRef<Animation | null>(null)
  useLayoutEffect(() => {
    if (flipped === shownRef.current && !anim.current) return
    const el = ref.current
    anim.current?.cancel()
    anim.current = null
    if (!el || typeof el.animate !== 'function'
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setShown(flipped); return }
    const base = el.style.transform || ''
    // Flat, a little perspective makes it read as a turn; tilted, the
    // world already has it, and the card turns in that space.
    const persp = flat ? 'perspective(900px) ' : ''
    const turn = (deg: number) => ({ transform: `${base} ${persp}rotateY(${deg}deg)`.trim() })
    const a = el.animate([turn(0), turn(90)], { duration: 150, easing: 'ease-in' })
    anim.current = a
    a.onfinish = () => {
      if (anim.current !== a) return
      flushSync(() => setShown(flipped))
      const b = el.animate([turn(-90), turn(0)], { duration: 170, easing: 'ease-out' })
      anim.current = b
      b.onfinish = () => { if (anim.current === b) anim.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipped])
  useEffect(() => () => { anim.current?.cancel() }, [])
  return shown
}

/** Flip: lit while the back is showing. Same icon and words either way. */
export const FlipButton: React.FC<{
  flipped: boolean
  onFlip: () => void
  baseColor: string
  size: number
  visible: boolean
  style?: React.CSSProperties
}> = ({ flipped, onFlip, baseColor, size, visible, style }) => {
  const [hover, setHover] = useState(false)
  const lit = flipped || hover
  const tint = edgeColorFromHex(baseColor, flipped ? 0.95 : lit ? 0.85 : 0.55)
  const bg = edgeColorFromHex(baseColor, flipped ? 0.30 : lit ? 0.22 : 0.10)
  const border = edgeColorFromHex(baseColor, flipped ? 0.70 : lit ? 0.55 : 0.25)
  return (
    <button
      type="button"
      data-card-flip
      title="Flip the card over"
      onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}
      onDoubleClick={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onFlip() }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'absolute', zIndex: 60,
        width: size, height: size, padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: flipped ? bg : `linear-gradient(${bg}, ${bg}), rgba(0,0,0,0.35)`,
        border: `1px solid ${border}`, borderRadius: 4, color: tint,
        opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none',
        cursor: 'pointer', boxSizing: 'border-box', lineHeight: 1,
        transition: 'opacity 0.12s, background 0.12s, border-color 0.12s, color 0.12s',
        ...style,
      }}
    >
      <svg width={size * 0.68} height={size * 0.68} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {/* A card, and the arrow that turns it over. */}
        <rect x="2" y="5.5" width="6.5" height="8.5" rx="1" />
        <path d="M10.5 13.5 h2 a1 1 0 0 0 1 -1 v-6" strokeDasharray="1.6 1.6" />
        <path d="M4.5 3.2 C6.5 0.8 11 1.2 12.6 4.3" />
        <path d="M12.9 1.9 L12.7 4.5 L10.2 4.1" />
      </svg>
    </button>
  )
}

const stopPress = (e: React.PointerEvent) => { if (e.button === 0) e.stopPropagation() }

/** One editable bit of text on the back: shows the text; a click (not a
 *  drag) edits it in place. Enter or leaving it keeps the change, Escape
 *  drops it, Tab moves on. */
const BackField: React.FC<{
  value: string
  placeholder: string
  editing: boolean
  onStart: () => void
  onCommit: (v: string, next?: 'next' | 'prev') => void
  onCancel: () => void
  style: React.CSSProperties
  field: string
  /** The card's place on the canvas, to tell a click from a drag. */
  where: () => { x: number; y: number }
}> = ({ value, placeholder, editing, onStart, onCommit, onCancel, style, field, where }) => {
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  const down = useRef<{ x: number; y: number } | null>(null)
  const done = useRef(false)
  useEffect(() => {
    if (!editing) return
    done.current = false
    setDraft(value)
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])
  if (editing) {
    const commit = (next?: 'next' | 'prev') => { if (done.current) return; done.current = true; onCommit(draft, next) }
    return (
      <input
        ref={inputRef}
        data-card-detail-input={field}
        value={draft}
        placeholder={placeholder}
        onChange={e => setDraft(e.target.value)}
        onPointerDown={stopPress}
        onDoubleClick={e => e.stopPropagation()}
        onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          else if (e.key === 'Escape') { e.preventDefault(); done.current = true; onCancel() }
          else if (e.key === 'Tab') { e.preventDefault(); commit(e.shiftKey ? 'prev' : 'next') }
        }}
        onBlur={() => commit()}
        style={{
          ...style, minWidth: 0, width: '100%', boxSizing: 'border-box',
          background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.35)', borderRadius: 2,
          outline: 'none', padding: '0 2px', margin: 0, font: 'inherit', fontSize: style.fontSize,
          fontWeight: style.fontWeight, color: '#fff', userSelect: 'text',
        }}
      />
    )
  }
  return (
    <div
      data-card-detail={field}
      // A click edits; a drag moves the card. Told apart by whether the
      // card moved, not by the pointer's coordinates: in 3D the press is
      // re-sent at its flat point and the click is not, and a pressed card
      // lifts there, so the field's own place on screen changes too.
      onPointerDown={() => { down.current = where() }}
      onClick={e => {
        const d = down.current
        down.current = null
        const now = where()
        if (e.button !== 0 || !d || Math.hypot(now.x - d.x, now.y - d.y) > 0.5) return
        e.stopPropagation()
        onStart()
      }}
      onDoubleClick={e => e.stopPropagation()}
      style={{ ...style, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text', padding: '0 2px', border: '1px solid transparent' }}
    >{value || <span style={{ opacity: 0.4 }}>{placeholder}</span>}</div>
  )
}

/** The details side, filling the card's body (below its name tab). */
export const CardBack: React.FC<{
  groupId: string; color: string; width: number; height: number; hovered: boolean
  /** Screen px kept clear at the top-left for the Flip button. */
  reserve: number
}> = ({ groupId, color, width, height, hovered, reserve }) => {
  const details = useBoardsStore(s => s.groups.find(g => g.id === groupId)?.details) ?? NONE
  const [editing, setEditing] = useState<{ id: string; part: 'name' | 'value' } | null>(null)
  const [rowHover, setRowHover] = useState<string | null>(null)

  // Laid out at a new card's size, then scaled to this card.
  const s = Math.max(0.01, Math.min(width / BACK_W, height / BACK_H))
  const w = width / s, h = height / s

  const write = (next: CardDetail[]) => {
    useUndoCoordinator.getState().checkpoint()
    useBoardsStore.getState().setGroupDetails(groupId, next)
  }
  /** A row left with no name and no value is not kept. */
  const dropIfEmpty = (id: string) => {
    const cur = useBoardsStore.getState().groups.find(g => g.id === groupId)?.details ?? []
    const row = cur.find(d => d.id === id)
    if (row && !row.name.trim() && !row.value.trim()) useBoardsStore.getState().setGroupDetails(groupId, cur.filter(d => d.id !== id))
  }
  const cancel = (id: string) => { setEditing(null); dropIfEmpty(id) }
  const commit = (id: string, part: 'name' | 'value', v: string, next?: 'next' | 'prev') => {
    const cur = useBoardsStore.getState().groups.find(g => g.id === groupId)?.details ?? []
    const row = cur.find(d => d.id === id)
    if (row && row[part] !== v) write(cur.map(d => d.id === id ? { ...d, [part]: v } : d))
    // Done with a row, or tabbed off its value: an empty row goes.
    if (!next || part === 'value') dropIfEmpty(id)
    if (!next) { setEditing(null); return }
    // Tab: name → value → next row's name.
    const order = cur.flatMap(d => [{ id: d.id, part: 'name' as const }, { id: d.id, part: 'value' as const }])
    const i = order.findIndex(o => o.id === id && o.part === part) + (next === 'next' ? 1 : -1)
    setEditing(order[i] ?? null)
  }
  const add = () => {
    const cur = useBoardsStore.getState().groups.find(g => g.id === groupId)?.details ?? []
    const row: CardDetail = { id: newDetailId(), name: '', value: '' }
    write([...cur, row])
    setEditing({ id: row.id, part: 'name' })
  }
  const remove = (id: string) => {
    const cur = useBoardsStore.getState().groups.find(g => g.id === groupId)?.details ?? []
    write(cur.filter(d => d.id !== id))
    if (editing?.id === id) setEditing(null)
  }

  const where = () => {
    const g = useBoardsStore.getState().groups.find(gr => gr.id === groupId)
    return { x: g?.originX ?? 0, y: g?.originY ?? 0 }
  }
  const ink = edgeColorFromHex(color, 0.9)
  return (
    <div
      data-card-back={groupId}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: '0 0 12px 12px' }}
    >
      <div style={{
        position: 'absolute', left: 0, top: 0, width: w, height: h,
        transform: `scale(${s})`, transformOrigin: '0 0',
        boxSizing: 'border-box', padding: '7px 8px 6px',
        display: 'flex', flexDirection: 'column', gap: 3,
        color: '#fff', fontFamily: 'inherit',
      }}>
        {/* The printed border of a card's back. */}
        <div style={{ position: 'absolute', inset: 3, borderRadius: 7, border: `1px solid ${edgeColorFromHex(color, 0.28)}`, pointerEvents: 'none' }} />
        <div style={{
          fontSize: 7.5, fontWeight: 800, letterSpacing: 1.2, color: ink, opacity: 0.85,
          paddingLeft: Math.max(2, reserve / s - 8), minHeight: Math.max(0, reserve / s - 11), display: 'flex', alignItems: 'center',
        }}>DETAILS</div>
        <div
          data-wheel-own
          onWheel={e => { const el = e.currentTarget; if (el.scrollHeight > el.clientHeight + 1) e.stopPropagation() }}
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: 2, scrollbarWidth: 'thin' }}
        >
          {details.map(d => (
            <div
              key={d.id}
              data-card-detail-row={d.id}
              onPointerEnter={() => setRowHover(d.id)}
              onPointerLeave={() => setRowHover(r => r === d.id ? null : r)}
              style={{
                position: 'relative', display: 'grid', gridTemplateColumns: 'minmax(0, 42%) minmax(0, 1fr)', alignItems: 'baseline', gap: 3,
                borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 1,
              }}
            >
              <BackField
                field="name"
                where={where}
                value={d.name}
                placeholder="name"
                editing={editing?.id === d.id && editing.part === 'name'}
                onStart={() => setEditing({ id: d.id, part: 'name' })}
                onCommit={(v, n) => commit(d.id, 'name', v, n)}
                onCancel={() => cancel(d.id)}
                style={{ fontSize: 8, fontWeight: 700, color: ink, opacity: 0.85, textTransform: 'uppercase', letterSpacing: 0.4 }}
              />
              <BackField
                field="value"
                where={where}
                value={d.value}
                placeholder="—"
                editing={editing?.id === d.id && editing.part === 'value'}
                onStart={() => setEditing({ id: d.id, part: 'value' })}
                onCommit={(v, n) => commit(d.id, 'value', v, n)}
                onCancel={() => cancel(d.id)}
                style={{ fontSize: 10, fontWeight: 500, color: 'rgba(255,255,255,0.95)' }}
              />
              {rowHover === d.id && !editing && (
                <button
                  type="button"
                  data-card-detail-remove
                  title="Remove this detail"
                  onPointerDown={stopPress}
                  onClick={e => { e.stopPropagation(); remove(d.id) }}
                  style={{
                    position: 'absolute', right: 0, top: 0, width: 11, height: 11, padding: 0, lineHeight: '9px',
                    fontSize: 9, borderRadius: 3, border: 'none', cursor: 'pointer',
                    background: 'rgba(0,0,0,0.6)', color: 'rgba(255,255,255,0.85)',
                  }}
                >×</button>
              )}
            </div>
          ))}
          {details.length === 0 && (
            <div style={{ fontSize: 8.5, opacity: 0.45, padding: '2px 2px 0' }}>No details yet.</div>
          )}
          <button
            type="button"
            data-card-detail-add
            title="Add a detail"
            onPointerDown={stopPress}
            onDoubleClick={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); add() }}
            style={{
              alignSelf: 'flex-start', flexShrink: 0, marginTop: 2, fontSize: 8.5, fontWeight: 700, fontFamily: 'inherit',
              padding: '1px 6px', borderRadius: 8, cursor: 'pointer',
              background: 'rgba(0,0,0,0.3)', color: ink, border: `1px solid ${edgeColorFromHex(color, 0.35)}`,
              opacity: hovered || details.length === 0 ? 1 : 0, transition: 'opacity 0.12s',
              pointerEvents: hovered || details.length === 0 ? 'auto' : 'none',
            }}
          >+ detail</button>
        </div>
      </div>
    </div>
  )
}

const NONE: CardDetail[] = []
