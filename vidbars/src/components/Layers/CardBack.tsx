// The back of a card: its DETAILS side (Brian 2026-11-04). The Flip
// button turns a card over with a short animation; the back shows the
// card's type (click to change it) and its details as name / value rows
// you can add, rename, change and remove. A card's link "+" let go on a
// value links it: the value then shows that card, or one of its details.
// Data lives on the card itself (ProjectGroup.flipped / details /
// cardType; utils/cardTypes).

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactDOM, { flushSync } from 'react-dom'
import { useBoardsStore } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useLinkDragStore } from '../../store/linkDragStore'
import { edgeColorFromHex, hexToHsl, hslToHex } from '../../utils/colorUtils'
import { CARD_TYPES, CARD_TYPE_ORDER, cardTypeOf, detailShown, factionMembers, factionsOf, isAbove, newDetailId, typeColor, type CardDetail, type CardType } from '../../utils/cardTypes'
import { ColorPickerPopup } from '../Bar/ColorPickerPopup'

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

/** Click, not drag: a press that did not move the card. Told apart by the
 *  card's place on the canvas, not by the pointer's coordinates: in 3D the
 *  press is re-sent at its flat point and the click is not, and a pressed
 *  card lifts there, so things on it move on screen too. */
function useClick(where: () => { x: number; y: number }, onClick: (e: React.MouseEvent) => void) {
  const down = useRef<{ x: number; y: number } | null>(null)
  return {
    onPointerDown: () => { down.current = where() },
    onClick: (e: React.MouseEvent) => {
      const d = down.current
      down.current = null
      const now = where()
      if (e.button !== 0 || !d || Math.hypot(now.x - d.x, now.y - d.y) > 0.5) return
      e.stopPropagation()
      onClick(e)
    },
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
  }
}

/** One editable bit of text on the back: shows the text; a click (not a
 *  drag) edits it in place. Enter or leaving it keeps the change, Escape
 *  drops it, Tab moves on. A linked value shows what it links to instead,
 *  and a click on it asks what to show (onPick). */
const BackField: React.FC<{
  value: string
  placeholder: string
  editing: boolean
  onStart: () => void
  onCommit: (v: string, next?: 'next' | 'prev') => void
  onCancel: () => void
  style: React.CSSProperties
  field: string
  where: () => { x: number; y: number }
  /** Shown instead of the text (a link). A click then calls onPick. */
  shown?: React.ReactNode
  onPick?: (e: React.MouseEvent) => void
  /** A card's link "+" can be let go here (data-link-drop). */
  drop?: string
  /** Lit as a place to let go: a link is being dragged. */
  lit?: boolean
}> = ({ value, placeholder, editing, onStart, onCommit, onCancel, style, field, where, shown, onPick, drop, lit }) => {
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const click = useClick(where, e => (shown !== undefined && onPick ? onPick(e) : onStart()))
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
      data-link-drop={drop}
      {...click}
      style={{
        ...style, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        cursor: shown !== undefined ? 'pointer' : 'text', padding: '0 2px', borderRadius: 2,
        border: lit ? '1px dashed rgba(255,255,255,0.7)' : '1px solid transparent',
        background: lit ? 'rgba(255,255,255,0.08)' : undefined,
      }}
    >{shown !== undefined ? shown : (value || <span style={{ opacity: 0.4 }}>{placeholder}</span>)}</div>
  )
}

/** A small menu at the cursor, in screen pixels (the card's back is too
 *  small to hold one). */
type MenuItem = {
  label: string
  checked?: boolean
  onClick: () => void
  /** A colour swatch at the left; clicking it calls onSwatch instead. */
  swatch?: string
  onSwatch?: (e: React.MouseEvent) => void
  separator?: boolean
  hint?: string
}
const BackMenu: React.FC<{ at: { x: number; y: number }; title: string; items: MenuItem[]; onClose: () => void }> = ({ at, title, items, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const h = 34 + items.length * 30
  return ReactDOM.createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={e => { e.stopPropagation(); onClose() }} />
      <div
        data-card-back-menu
        onPointerDown={e => e.stopPropagation()}
        style={{
          position: 'fixed', left: Math.max(4, Math.min(at.x, window.innerWidth - 224)), top: Math.max(4, Math.min(at.y, window.innerHeight - h - 4)),
          width: 220, zIndex: 9999, background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)', padding: '5px 0', fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ padding: '4px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: 4, color: 'rgba(255,255,255,0.4)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        {items.map((it, i) => (
          <React.Fragment key={i}>
            {it.separator && <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '4px 0' }} />}
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {it.swatch !== undefined && (
                <button
                  type="button"
                  data-type-swatch
                  title={it.onSwatch ? `Colour for ${it.label} cards` : undefined}
                  onClick={e => { e.stopPropagation(); it.onSwatch?.(e) }}
                  style={{
                    marginLeft: 10, width: 16, height: 16, flexShrink: 0, borderRadius: 4, padding: 0,
                    background: it.swatch, border: '1px solid rgba(255,255,255,0.35)', cursor: it.onSwatch ? 'pointer' : 'default',
                  }}
                />
              )}
              <button
                type="button"
                data-back-menu-item={it.label}
                onClick={() => it.onClick()}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                style={{
                  flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px 6px 10px',
                  background: 'none', border: 'none', cursor: 'pointer', color: '#e2e8f0', fontSize: 13, textAlign: 'left', borderRadius: 4,
                }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.label}{it.hint && <span style={{ color: 'rgba(255,255,255,0.45)' }}>{it.hint}</span>}
                </span>
                <span style={{ width: 12, color: 'rgba(130,180,255,0.95)' }}>{it.checked ? '✓' : ''}</span>
              </button>
            </div>
          </React.Fragment>
        ))}
      </div>
    </>,
    document.body,
  )
}

/** A linked value: a dot in the linked card's colour, then what it shows. */
const LinkShown: React.FC<{ text: string; color?: string; missing?: boolean; whole: boolean }> = ({ text, color, missing, whole }) => (
  <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 3, maxWidth: '100%', opacity: missing ? 0.5 : 1 }}>
    <span style={{ width: 6, height: 6, borderRadius: whole ? 2 : 3, background: color ?? '#888', flexShrink: 0, alignSelf: 'center', border: '1px solid rgba(255,255,255,0.5)' }} />
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: missing ? 'line-through' : undefined }}>{text || '—'}</span>
  </span>
)

/** A member's rank in a faction: steps down from the top (1). Read
 *  from who reports to whom, so it is shown, not typed. */
const RankBadge: React.FC<{ rank: number; color: string }> = ({ rank, color }) => (
  <div data-member-rank={rank} title="Rank: steps down from the top" style={{
    width: 13, height: 11, flexShrink: 0, boxSizing: 'border-box', borderRadius: 3, fontSize: 8, fontWeight: 800, lineHeight: '9px',
    textAlign: 'center', color: '#fff', border: `1px solid ${edgeColorFromHex(color, 0.5)}`, background: edgeColorFromHex(color, 0.3),
  }}>{rank}</div>
)

/** The details side, filling the card's body (below its name tab). */
export const CardBack: React.FC<{
  groupId: string; color: string; width: number; height: number; hovered: boolean
  /** Screen px kept clear at the top-left for the Flip button. */
  reserve: number
}> = ({ groupId, color, width, height, hovered, reserve }) => {
  const details = useBoardsStore(s => s.groups.find(g => g.id === groupId)?.details) ?? NONE
  const type = useBoardsStore(s => cardTypeOf(s.groups.find(g => g.id === groupId)))
  const groups = useBoardsStore(s => s.groups)
  const me = groups.find(g => g.id === groupId)
  const members = type === 'faction' && me ? factionMembers(groups, me) : []
  const memberOf = factionsOf(groups, groupId)
  // A card's link "+" being dragged (not this card's own): the details
  // light up as places to let it go.
  const linking = useLinkDragStore(s => s.active && s.source?.kind === 'group' && s.source.id !== groupId)
  const [editing, setEditing] = useState<{ id: string; part: 'name' | 'value' } | null>(null)
  const [rowHover, setRowHover] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'type' } | { x: number; y: number; kind: 'link'; id: string } | null>(null)
  const [picker, setPicker] = useState<{ x: number; y: number; type: CardType } | null>(null)
  // A member being dragged in a faction's list: onto the member it reports
  // to ('top': onto MEMBERS, it reports to no one). `ok`: it can go there
  // (never under someone below it).
  const [mdrag, setMdrag] = useState<{ id: string; over: string | null; ok: boolean } | null>(null)

  // Laid out at a new card's size, then scaled to this card.
  const s = Math.max(0.01, Math.min(width / BACK_W, height / BACK_H))
  const w = width / s, h = height / s

  const cur = () => useBoardsStore.getState().groups.find(g => g.id === groupId)?.details ?? []
  const write = (next: CardDetail[]) => {
    useUndoCoordinator.getState().checkpoint()
    useBoardsStore.getState().setGroupDetails(groupId, next)
  }
  /** A row left with no name and no value is not kept. */
  const dropIfEmpty = (id: string) => {
    const row = cur().find(d => d.id === id)
    if (row && !row.link && !row.name.trim() && !row.value.trim()) useBoardsStore.getState().setGroupDetails(groupId, cur().filter(d => d.id !== id))
  }
  const cancel = (id: string) => { setEditing(null); dropIfEmpty(id) }
  const commit = (id: string, part: 'name' | 'value', v: string, next?: 'next' | 'prev') => {
    const rows = cur()
    const row = rows.find(d => d.id === id)
    if (row && row[part] !== v) write(rows.map(d => d.id === id ? { ...d, [part]: v } : d))
    // Done with a row, or tabbed off its value: an empty row goes.
    if (!next || part === 'value') dropIfEmpty(id)
    if (!next) { setEditing(null); return }
    // Tab: name → value → next row's name. A linked value is skipped.
    const order = rows.flatMap(d => d.link ? [{ id: d.id, part: 'name' as const }] : [{ id: d.id, part: 'name' as const }, { id: d.id, part: 'value' as const }])
    const i = order.findIndex(o => o.id === id && o.part === part) + (next === 'next' ? 1 : -1)
    setEditing(order[i] ?? null)
  }
  const add = () => {
    const row: CardDetail = { id: newDetailId(), name: '', value: '' }
    write([...cur(), row])
    setEditing({ id: row.id, part: 'name' })
  }
  const remove = (id: string) => {
    write(cur().filter(d => d.id !== id))
    if (editing?.id === id) setEditing(null)
  }
  const setLink = (id: string, link: CardDetail['link'] | null) => {
    write(cur().map(d => {
      if (d.id !== id) return d
      if (link) return { ...d, link }
      // Unlinked: it keeps, as text, what it showed.
      const { link: _gone, ...rest } = d
      return { ...rest, value: detailShown(useBoardsStore.getState().groups, d).text }
    }))
  }
  const where = () => {
    const g = useBoardsStore.getState().groups.find(gr => gr.id === groupId)
    return { x: g?.originX ?? 0, y: g?.originY ?? 0 }
  }
  const typeClick = useClick(where, e => setMenu({ x: e.clientX, y: e.clientY, kind: 'type' }))

  /** Press on a member: drag it onto the one it reports to. Shift on
   *  letting go: as well as its boss now (or no longer, if it already
   *  reports to that one). Found by what is under the pointer, which the
   *  3D view answers for its re-sent flat points too. */
  const onMemberDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const x0 = e.clientX, y0 = e.clientY
    let live = false
    const at = (ev: PointerEvent): string | null => {
      for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
        const back = el.closest('[data-card-back]')
        if (!back) continue
        if (back.getAttribute('data-card-back') !== groupId) return null
        const row = el.closest<HTMLElement>('[data-faction-member]')
        if (row) return row.dataset.factionMember ?? null
        return el.closest('[data-faction-top]') ? 'top' : null
      }
      return null
    }
    const okAt = (over: string | null) => {
      const f = useBoardsStore.getState().groups.find(g => g.id === groupId)
      if (!f || !over || over === id) return false
      return over === 'top' || !isAbove(f, id, over)
    }
    const end = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey, true)
      setMdrag(null)
    }
    const onMove = (ev: PointerEvent) => {
      if (!live && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return
      live = true
      const over = at(ev)
      setMdrag({ id, over, ok: okAt(over) })
    }
    const onUp = (ev: PointerEvent) => {
      const over = live ? at(ev) : null
      end()
      if (!over || !okAt(over)) return
      useUndoCoordinator.getState().checkpoint()
      useBoardsStore.getState().setReportsTo(groupId, id, over === 'top' ? null : over, over !== 'top' && ev.shiftKey)
    }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); end() } }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey, true)
  }

  const ink = edgeColorFromHex(color, 0.9)
  // The names' column fits the longest name (within reason), the same for
  // every row, so the values line up.
  const longest = Math.max(4, ...details.map(d => d.name.length), memberOf.length ? (memberOf.some(m => m.bosses.length) ? 10 : 7) : 0)
  const cols = `${Math.round(Math.min(w * 0.58, Math.max(w * 0.3, longest * 5.2 + 8)))}px minmax(0, 1fr)`
  const typeMenu = (): MenuItem[] => {
    const bs = useBoardsStore.getState()
    const me = bs.groups.find(g => g.id === groupId)
    const items: MenuItem[] = CARD_TYPE_ORDER.map(t => ({
      label: CARD_TYPES[t].label,
      checked: t === type,
      swatch: typeColor(t, bs.typeColors),
      onSwatch: t === 'element' ? undefined : (e: React.MouseEvent) => setPicker({ x: e.clientX, y: e.clientY, type: t }),
      onClick: () => {
        if (t !== type) { useUndoCoordinator.getState().checkpoint(); bs.setGroupCardType(groupId, t) }
        setMenu(null)
      },
    }))
    // Fill in: the empty details made up to fit the type (and the other
    // selected cards', when this is one of them).
    if (type !== 'element') items.push({
      label: 'Fill in details', separator: true,
      onClick: () => {
        const ids = bs.selectedGroupIds.includes(groupId) ? bs.selectedGroupIds : [groupId]
        useUndoCoordinator.getState().checkpoint()
        bs.fillInDetails(ids)
        setMenu(null)
      },
    })
    if (me?.ownColor) items.push({
      label: 'Use the type’s colour', separator: true,
      onClick: () => { useUndoCoordinator.getState().checkpoint(); bs.setGroupOwnColor(groupId, false); setMenu(null) },
    })
    return items
  }
  const linkMenu = (id: string): MenuItem[] => {
    const all = useBoardsStore.getState().groups
    const d = cur().find(x => x.id === id)
    const card = d?.link && all.find(g => g.id === d.link!.card)
    if (!d?.link) return []
    if (!card) return [{ label: 'Unlink (the card is gone)', onClick: () => { setLink(id, null); setMenu(null) } }]
    return [
      { label: card.name || 'Untitled', hint: '  the card', checked: !d.link.detail, swatch: card.color, onClick: () => { setLink(id, { card: card.id }); setMenu(null) } },
      ...(card.details ?? []).filter(x => x.name.trim()).map(x => ({
        label: x.name, hint: `  ${detailShown(all, x).text}`, checked: d.link!.detail === x.id,
        onClick: () => { setLink(id, { card: card.id, detail: x.id }); setMenu(null) },
      })),
      { label: 'Unlink, keep the text', separator: true, onClick: () => { setLink(id, null); setMenu(null) } },
    ]
  }

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
          paddingLeft: Math.max(0, reserve / s - 8), minHeight: Math.max(0, reserve / s - 11), display: 'flex', alignItems: 'center',
        }}>
          {/* The card's type: click to choose another. */}
          <div
            data-card-type={type}
            title="Card type"
            {...typeClick}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer', padding: '1px 4px 1px 3px', borderRadius: 3,
              fontSize: 7.5, fontWeight: 800, letterSpacing: 1.2, color: ink, background: 'rgba(0,0,0,0.25)',
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: 2, background: color, border: '1px solid rgba(255,255,255,0.45)' }} />
            {CARD_TYPES[type].label.toUpperCase()}
            <span style={{ opacity: 0.7, fontSize: 6.5, letterSpacing: 0 }}>▾</span>
          </div>
        </div>
        <div
          data-wheel-own
          onWheel={e => { const el = e.currentTarget; if (el.scrollHeight > el.clientHeight + 1) e.stopPropagation() }}
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: 2, scrollbarWidth: 'thin' }}
        >
          {/* A faction: its members, by rank. */}
          {type === 'faction' && me && (
            <>
              <div
                data-faction-top
                title="Drag a member here: it reports to no one (the top)"
                style={{
                  fontSize: 7, fontWeight: 800, letterSpacing: 1, color: ink, padding: '1px 2px 0', borderRadius: 2,
                  opacity: mdrag?.over === 'top' && mdrag.ok ? 1 : 0.6,
                  outline: mdrag?.over === 'top' && mdrag.ok ? '1px dashed rgba(255,255,255,0.8)' : undefined,
                  background: mdrag?.over === 'top' && mdrag.ok ? 'rgba(255,255,255,0.1)' : undefined,
                }}
              >MEMBERS</div>
              {members.length === 0 && (
                <div style={{ fontSize: 8, opacity: 0.45, padding: '0 2px 2px' }}>Drag a card’s + here to add it.</div>
              )}
              {members.map(({ card, rank, depth, bosses }) => {
                const target = mdrag?.over === card.id && mdrag.ok
                return (
                <div
                  key={card.id}
                  data-faction-member={card.id}
                  data-member-depth={depth}
                  title="Drag onto the member it reports to (Shift: as well as its boss now). Onto MEMBERS: the top."
                  onPointerDown={e => onMemberDown(e, card.id)}
                  onPointerEnter={() => setRowHover('m:' + card.id)}
                  onPointerLeave={() => setRowHover(r => r === 'm:' + card.id ? null : r)}
                  style={{
                    position: 'relative', display: 'flex', alignItems: 'center', gap: 3, marginLeft: depth * 7,
                    borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 1, minHeight: 13, borderRadius: 2,
                    cursor: mdrag ? (mdrag.ok ? 'grabbing' : 'no-drop') : 'grab',
                    opacity: mdrag?.id === card.id ? 0.45 : 1,
                    outline: target ? '1px dashed rgba(255,255,255,0.8)' : undefined,
                    background: target ? 'rgba(255,255,255,0.1)' : undefined,
                  }}
                >
                  {/* Under the member above it that it reports to. */}
                  {depth > 0 && <span style={{ width: 4, height: 6, marginTop: -5, flexShrink: 0, borderLeft: '1px solid rgba(255,255,255,0.35)', borderBottom: '1px solid rgba(255,255,255,0.35)' }} />}
                  <RankBadge rank={rank} color={color} />
                  <span style={{ width: 6, height: 6, borderRadius: 2, background: card.color, flexShrink: 0, border: '1px solid rgba(255,255,255,0.5)' }} />
                  <span style={{ fontSize: 9.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '0 1 auto' }}>{card.name || 'Untitled'}</span>
                  {/* Its other bosses: it reports to them too. */}
                  {bosses.length > 1 && (
                    <span data-member-also title={'Also reports to ' + bosses.slice(1).map(b => b.name || 'Untitled').join(', ')} style={{ fontSize: 7.5, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '0 1000 auto' }}>
                      &amp; {bosses.slice(1).map(b => b.name || 'Untitled').join(', ')}
                    </span>
                  )}
                  {rowHover === 'm:' + card.id && !linking && !mdrag && (
                    <button
                      type="button"
                      data-faction-member-remove
                      title="Take out of this faction"
                      onPointerDown={stopPress}
                      onClick={e => { e.stopPropagation(); useUndoCoordinator.getState().checkpoint(); useBoardsStore.getState().removeMember(groupId, card.id) }}
                      style={{
                        position: 'absolute', right: 0, top: 1, width: 11, height: 11, padding: 0, lineHeight: '9px',
                        fontSize: 9, borderRadius: 3, border: 'none', cursor: 'pointer',
                        background: 'rgba(0,0,0,0.6)', color: 'rgba(255,255,255,0.85)',
                      }}
                    >×</button>
                  )}
                </div>
                )
              })}
              <div style={{ fontSize: 7, fontWeight: 800, letterSpacing: 1, color: ink, opacity: 0.6, padding: '4px 2px 0' }}>DETAILS</div>
            </>
          )}
          {details.map(d => {
            const linked = d.link ? detailShown(groups, d) : null
            return (
              <div
                key={d.id}
                data-card-detail-row={d.id}
                onPointerEnter={() => setRowHover(d.id)}
                onPointerLeave={() => setRowHover(r => r === d.id ? null : r)}
                style={{
                  position: 'relative', display: 'grid', gridTemplateColumns: cols, alignItems: 'baseline', gap: 3,
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
                  style={{ fontSize: 8, fontWeight: 700, color: ink, opacity: 0.85, textTransform: 'uppercase', letterSpacing: 0.2 }}
                />
                <BackField
                  field="value"
                  where={where}
                  value={d.value}
                  placeholder="—"
                  editing={!d.link && editing?.id === d.id && editing.part === 'value'}
                  onStart={() => setEditing({ id: d.id, part: 'value' })}
                  onCommit={(v, n) => commit(d.id, 'value', v, n)}
                  onCancel={() => cancel(d.id)}
                  shown={linked ? <LinkShown text={linked.text} color={linked.card?.color} missing={linked.missing} whole={!d.link!.detail} /> : undefined}
                  onPick={e => setMenu({ x: e.clientX, y: e.clientY, kind: 'link', id: d.id })}
                  drop={`detail:${groupId}:${d.id}`}
                  lit={linking}
                  style={{ fontSize: 10, fontWeight: 500, color: 'rgba(255,255,255,0.95)' }}
                />
                {rowHover === d.id && !editing && !linking && (
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
            )
          })}
          {details.length === 0 && type !== 'faction' && memberOf.length === 0 && (
            <div style={{ fontSize: 8.5, opacity: 0.45, padding: '2px 2px 0' }}>No details yet.</div>
          )}
          {/* The factions it is in, read from them: name and rank. */}
          {memberOf.flatMap(({ faction, rank, bosses }) => [
            { k: 'FACTION', v: faction.name || 'Untitled', dot: faction.color, attr: { 'data-member-of': faction.id } },
            { k: 'RANK', v: String(rank) },
            ...(bosses.length ? [{ k: 'REPORTS TO', v: bosses.map(b => b.name || 'Untitled').join(', '), dot: bosses[0].color, attr: { 'data-member-boss': faction.id } }] : []),
          ].map(({ k, v, dot, attr }) => (
            <div key={faction.id + k} {...attr} style={{
              display: 'grid', gridTemplateColumns: cols, alignItems: 'baseline', gap: 3,
              borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 1,
            }}>
              <div style={{ fontSize: 8, fontWeight: 700, color: ink, opacity: 0.85, letterSpacing: 0.2, padding: '0 3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k}</div>
              <div style={{ fontSize: 10, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 3px' }}>
                {dot ? <LinkShown text={v} color={dot} whole /> : v}
              </div>
            </div>
          )))}
          <button
            type="button"
            data-card-detail-add
            data-link-drop={`detail:${groupId}:new`}
            title="Add a detail (or drop a card's link here)"
            onPointerDown={stopPress}
            onDoubleClick={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); add() }}
            style={{
              alignSelf: 'flex-start', flexShrink: 0, marginTop: 2, fontSize: 8.5, fontWeight: 700, fontFamily: 'inherit',
              padding: '1px 6px', borderRadius: 8, cursor: 'pointer',
              background: linking ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.3)', color: ink,
              border: linking ? '1px dashed rgba(255,255,255,0.7)' : `1px solid ${edgeColorFromHex(color, 0.35)}`,
              opacity: hovered || linking || details.length === 0 ? 1 : 0, transition: 'opacity 0.12s',
              pointerEvents: hovered || linking || details.length === 0 ? 'auto' : 'none',
            }}
          >+ detail</button>
        </div>
      </div>
      {menu?.kind === 'type' && <BackMenu at={menu} title="Card type" items={typeMenu()} onClose={() => setMenu(null)} />}
      {menu?.kind === 'link' && <BackMenu at={menu} title="This detail shows" items={linkMenu(menu.id)} onClose={() => setMenu(null)} />}
      {picker && ReactDOM.createPortal(
        <ColorPickerPopup
          color={typeColor(picker.type, useBoardsStore.getState().typeColors)}
          anchorX={picker.x}
          anchorY={picker.y}
          onChange={c => { useUndoCoordinator.getState().checkpoint(); useBoardsStore.getState().setTypeColor(picker.type, c) }}
          onClose={() => setPicker(null)}
        />,
        document.body,
      )}
    </div>
  )
}

const NONE: CardDetail[] = []
