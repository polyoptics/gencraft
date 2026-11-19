// The back of a card: its DETAILS side (Brian 2026-11-04). The Flip
// button turns a card over with a short animation; the back shows the
// card's type (click to change it) and its details as name / value rows
// you can add, rename, change and remove. A card's link "+" let go on a
// value links it: the value then shows that card, or one of its details.
// Data lives on the card itself (ProjectGroup.flipped / details /
// cardType; utils/cardTypes).

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactDOM, { flushSync } from 'react-dom'
import { useBoardsStore } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useLinkDragStore } from '../../store/linkDragStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { cardFill, edgeColorFromHex, hexToHsl, hslToHex } from '../../utils/colorUtils'
import { CARD_TYPES, CARD_TYPE_ORDER, cardTypeOf, chartCards, chartName, chartRank, deckCardsOf, deckFavorite, detailShown, isChartRank, factionMembers, factionsOf, hasMembers, isAbove, isOwnCount, newDetailId, typeColor, type CardDetail, type CardType, type FactionMember } from '../../utils/cardTypes'
import { heightAsUnit } from '../../utils/stickGeom'
import { useUnits } from '../../store/unitsStore'
import { cardTitle } from '../../utils/faceStyle'
import { rankText } from '../../utils/chartData'
import { factionGroupsOf, withGroupMoved, withMemberMoved } from '../../utils/factionGroups'
import { ColorPickerPopup } from '../Bar/ColorPickerPopup'
import { areSiblings, arePartners, familiesOf, familyTree, isAncestor as isKinAbove, relationsOf, setChildOf, setPartners, setSiblings, type Kin } from '../../utils/family'

/** The back is laid out at a new card's own size and scaled with the card,
 *  so it reads the same at every zoom: nothing reflows as you zoom. */
const BACK_W = 125
const BACK_H = 184

/** The cards a colour change on this card is made on: every selected card
 *  when it is one of several selected (as the card menu's Card Color). */
function colorIds(groupId: string): string[] {
  const sel = useBoardsStore.getState().selectedGroupIds
  return sel.length > 1 && sel.includes(groupId) ? sel : [groupId]
}

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
  /** Long text runs onto more lines instead of being cut (unless folded). */
  wrap?: boolean
  folded?: boolean
  /** Told whether the text is more than one line long. */
  onLong?: (long: boolean) => void
}> = ({ value, placeholder, editing, onStart, onCommit, onCancel, style, field, where, shown, onPick, drop, lit, wrap, folded, onLong }) => {
  const [draft, setDraft] = useState(value)
  const textRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = textRef.current
    if (!el || !onLong) return
    const line = parseFloat(String(style.lineHeight ?? 12)) || 12
    onLong(folded ? el.scrollWidth > el.clientWidth + 1 : el.clientHeight > line * 1.5 + 2)
  })
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const twinRef = useRef<HTMLDivElement>(null)
  const done = useRef(false)
  const click = useClick(where, e => (shown !== undefined && onPick ? onPick(e) : onStart()))
  useEffect(() => {
    if (!editing) return
    done.current = false
    setDraft(value)
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])
  // The field being typed in lies over the canvas at a steady SCREEN size,
  // over the text it edits (as RenameInput does for names). Typed in the
  // card's own scaled space it came out many times too big in the app, a
  // few letters showing (Brian 2026-11-06), and far too small zoomed out.
  useEffect(() => {
    if (!editing) return
    let raf = 0
    const place = () => {
      const el = inputRef.current, r = twinRef.current?.getBoundingClientRect()
      if (el && r) {
        const w = Math.max(220, r.width)
        el.style.width = `${w}px`
        el.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, r.left))}px`
        el.style.top = `${Math.max(4, Math.min(window.innerHeight - el.offsetHeight - 4, r.top - 3))}px`
        el.style.height = 'auto'
        el.style.height = `${Math.min(220, el.scrollHeight + 2)}px`
      }
      raf = requestAnimationFrame(place)
    }
    place()
    // Plenty on the canvas cancels its presses, which would leave focus here.
    const away = (e: PointerEvent) => { if (e.target !== inputRef.current) inputRef.current?.blur() }
    window.addEventListener('pointerdown', away, true)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('pointerdown', away, true) }
  }, [editing])
  if (editing) {
    const commit = (next?: 'next' | 'prev') => { if (done.current) return; done.current = true; onCommit(draft, next) }
    return (
      <>
        {/* Keeps the text's place on the card while it is edited above it. */}
        <div ref={twinRef} style={{ ...style, minWidth: 0, width: '100%', visibility: 'hidden', whiteSpace: 'nowrap', overflow: 'hidden' }}>{value || placeholder}</div>
        {ReactDOM.createPortal(
          <textarea
            ref={inputRef}
            data-card-detail-input={field}
            value={draft}
            placeholder={placeholder}
            rows={1}
            onChange={e => setDraft(e.target.value)}
            onPointerDown={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
            onContextMenu={e => e.stopPropagation()}
            onKeyUp={e => e.stopPropagation()}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() }
              else if (e.key === 'Escape') { e.preventDefault(); done.current = true; onCancel() }
              else if (e.key === 'Tab') { e.preventDefault(); commit(e.shiftKey ? 'prev' : 'next') }
            }}
            onBlur={() => commit()}
            style={{
              position: 'fixed', zIndex: 10000, boxSizing: 'border-box', resize: 'none', overflow: 'auto',
              padding: '3px 6px', font: '500 13px/1.4 system-ui, sans-serif', color: '#fff', caretColor: '#fff',
              background: '#14161f', border: '1px solid rgba(120,180,255,0.9)', borderRadius: 4, outline: 'none',
              boxShadow: '0 4px 14px rgba(0,0,0,0.6)', userSelect: 'text',
            }}
          />,
          document.body,
        )}
      </>
    )
  }
  return (
    <div
      ref={textRef}
      data-card-detail={field}
      data-link-drop={drop}
      {...click}
      style={{
        ...style, minWidth: 0, overflow: 'hidden',
        ...(wrap && !folded ? { whiteSpace: 'normal', overflowWrap: 'anywhere' } : { textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
        cursor: shown !== undefined ? 'pointer' : 'text', padding: '0 2px', borderRadius: 2,
        // An outline, not a border: it takes no room between the rows.
        outline: lit ? '1px dashed rgba(255,255,255,0.7)' : 'none', outlineOffset: -1,
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
  /** Shown, but can't be picked (it would make no sense here). */
  disabled?: boolean
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
                disabled={it.disabled}
                onClick={() => { if (!it.disabled) it.onClick() }}
                onMouseEnter={e => { if (!it.disabled) e.currentTarget.style.background = 'rgba(255,255,255,0.07)' }}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                style={{
                  flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px 6px 10px',
                  background: 'none', border: 'none', cursor: it.disabled ? 'default' : 'pointer', color: '#e2e8f0', fontSize: 13, textAlign: 'left', borderRadius: 4,
                  opacity: it.disabled ? 0.35 : 1,
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

/** FOLD on a faction's back (lit: folded), as a long detail's FOLD looks. */
const MemberFold: React.FC<{ folded: boolean; ink: string; title: string; onClick: () => void; attr: Record<string, string> }> = ({ folded, ink, title, onClick, attr }) => (
  <button
    type="button"
    {...attr}
    title={title}
    onPointerDown={stopPress}
    onClick={e => { e.stopPropagation(); onClick() }}
    style={{
      flexShrink: 0, marginLeft: 'auto', marginRight: 12, height: 9, padding: '0 3px', lineHeight: '9px',
      fontSize: 6.5, fontWeight: 700, borderRadius: 3, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
      background: folded ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.3)', color: folded ? '#fff' : ink, opacity: folded ? 1 : 0.55,
    }}
  >FOLD</button>
)

/** A faction's members as listed (depth first, utils/cardTypes
 *  factionMembers) less those under a folded one; `crew`: a row has some
 *  under it, to fold. */
function unfolded(list: FactionMember[], folded: ReadonlySet<string>): { m: FactionMember; crew: boolean }[] {
  const out: { m: FactionMember; crew: boolean }[] = []
  let hideBelow = Infinity
  list.forEach((m, i) => {
    if (m.depth > hideBelow) return
    hideBelow = Infinity
    const crew = (list[i + 1]?.depth ?? -1) > m.depth
    out.push({ m, crew })
    if (crew && folded.has(m.card.id)) hideBelow = m.depth
  })
  return out
}

/** The details side, filling the card's body (below its name tab). */
export const CardBack: React.FC<{
  groupId: string; color: string; width: number; height: number; hovered: boolean
  /** Screen px kept clear at the top-left for the Flip button. */
  reserve: number
  /** In a scene card's section (SceneFace): the scale it is laid out at
   *  (as the section's text is), and its corners. A card: its own. */
  scale?: number
  radius?: number | string
}> = ({ groupId, color, width, height, hovered, reserve, scale, radius }) => {
  const details = useBoardsStore(s => s.groups.find(g => g.id === groupId)?.details) ?? NONE
  const type = useBoardsStore(s => cardTypeOf(s.groups.find(g => g.id === groupId)))
  const groups = useBoardsStore(s => s.groups)
  const me = groups.find(g => g.id === groupId)
  const members = type === 'faction' && me ? factionMembers(groups, me) : []
  // In groups (utils/factionGroups): top to bottom, each with its own hierarchy.
  const fgroups = type === 'faction' && me ? factionGroupsOf(me) : null
  // A linked card is its master shown again: its factions and kin are the master's.
  const meId = me?.linkOf ?? groupId
  const metric = useUnits(s => s.metric)
  // Charts to rank on; while one this back ranks on is out on the canvas,
  // its storyline as it stands (redrawn when its dots or their cards change).
  const charts = chartCards(groups)
  useFreeNodeStore(s => {
    const on = new Set(details.filter(isChartRank).map(d => d.link!.card))
    if (!on.size) return ''
    let k = ''
    for (const n of Object.values(s.nodes)) {
      const c = n.storyline?.chartCard
      if (c && on.has(c)) k += n.id + ':' + n.storyline!.dots.map(p => `${p.id},${p.y},${(p.cards ?? []).join('+')}`).join(';') + '|'
    }
    return k
  })
  const memberOf = factionsOf(groups, meId)
  // A family: its tree; any card: the families it is in, and its kin there.
  const tree = type === 'family' && me ? familyTree(groups, me) : []
  const kinOf = familiesOf(groups, meId).map(family => ({ family, rel: relationsOf(groups, family, meId) }))
  // A card's link "+" being dragged (not this card's own): the details
  // light up as places to let it go.
  const linking = useLinkDragStore(s => s.active && s.source?.kind === 'group' && s.source.id !== groupId)
  const [editing, setEditing] = useState<{ id: string; part: 'name' | 'value' } | null>(null)
  const [rowHover, setRowHover] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'type' | 'chart' } | { x: number; y: number; kind: 'link' | 'deck'; id: string } | null>(null)
  const [picker, setPicker] = useState<{ x: number; y: number; type: CardType } | null>(null)
  // The card's own colour and how see-through it is (the swatch by its type).
  const [cardPicker, setCardPicker] = useState<{ x: number; y: number } | null>(null)
  const closeCardPicker = useCallback(() => setCardPicker(null), [])
  // A member being dragged in a faction's list: onto the member it reports
  // to ('top': onto MEMBERS, it reports to no one). `ok`: it can go there
  // (never under someone below it).
  const [mdrag, setMdrag] = useState<{ id: string; over: string | null; ok: boolean } | null>(null)
  // A group being dragged by its heading: onto another group, to go there.
  const [gdrag, setGdrag] = useState<{ id: string; over: string | null } | null>(null)
  // A family member let go on another: how are they related? (a, b: ids)
  const [kinMenu, setKinMenu] = useState<{ a: string; b: string; x: number; y: number } | null>(null)

  // Laid out at a new card's size, then scaled to this card.
  const s = scale ?? Math.max(0.01, Math.min(width / BACK_W, height / BACK_H))
  const w = width / s, h = height / s
  // More details below than the back shows (it fades out at the bottom).
  const listRef = useRef<HTMLDivElement>(null)
  // Details whose value runs past one line (they get a fold button).
  const [longRows, setLongRows] = useState<Set<string>>(() => new Set())
  const [more, setMore] = useState(false)
  const checkMore = () => {
    const el = listRef.current
    setMore(!!el && el.scrollTop + el.clientHeight < el.scrollHeight - 1)
  }
  useLayoutEffect(checkMore)

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
    if (row && row[part] !== v) {
      write(rows.map(d => d.id === id ? { ...d, [part]: v } : d))
      // A value set on one of several selected cards: the other selected
      // cards that have a detail of the same name get it too (not linked ones).
      const bs = useBoardsStore.getState()
      const key = row.name.trim().toLowerCase()
      if (part === 'value' && key && bs.selectedGroupIds.length > 1 && bs.selectedGroupIds.includes(groupId)) {
        for (const other of bs.groups) {
          if (other.id === groupId || !bs.selectedGroupIds.includes(other.id) || !other.details) continue
          if (!other.details.some(d => !d.link && d.name.trim().toLowerCase() === key && d.value !== v)) continue
          bs.setGroupDetails(other.id, other.details.map(d => !d.link && d.name.trim().toLowerCase() === key ? { ...d, value: v } : d))
        }
      }
    }
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
  /** A detail reading this card's rank on chart card `chartId`. */
  const addRank = (chartId: string) => {
    const chart = useBoardsStore.getState().groups.find(g => g.id === chartId)
    if (!chart) return
    write([...cur(), { id: newDetailId(), name: chartName(chart), value: '', link: { card: chartId, rankOf: meId } }])
  }
  const chartMenu = (): MenuItem[] => charts.map(c => {
    const r = chartRank(c, meId)
    const have = cur().some(d => d.link?.rankOf && d.link.card === c.id)
    return {
      label: chartName(c), hint: r ? `  rank ${rankText(r)}` : '  not on it', swatch: c.color, checked: have,
      onClick: () => { if (!have) addRank(c.id); setMenu(null) },
    }
  })
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
  const colorClick = useClick(where, e => setCardPicker({ x: e.clientX + 12, y: e.clientY + 12 }))

  /** Press on a member: drag it onto another. In a faction, onto the one
   *  it reports to (Shift on letting go: as well as its boss now, or no
   *  longer if it already reports to that one). In a family, onto a
   *  relative: a menu asks how they are related. Found by what is under
   *  the pointer, which the 3D view answers for its re-sent flat points
   *  too. */
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
        const row = el.closest<HTMLElement>('[data-member-row]')
        if (row) return row.dataset.memberRow ?? null
        const head = el.closest<HTMLElement>('[data-group-head]')
        if (head) return 'group:' + head.dataset.groupHead
        return el.closest('[data-faction-top]') ? 'top' : null
      }
      return null
    }
    const okAt = (over: string | null) => {
      const f = useBoardsStore.getState().groups.find(g => g.id === groupId)
      if (!f || !over || over === id) return false
      if (f.cardType === 'family') return over !== 'top' && !over.startsWith('group:')
      return over === 'top' || over.startsWith('group:') || !isAbove(f, id, over)
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
      if (useBoardsStore.getState().groups.find(g => g.id === groupId)?.cardType === 'family') {
        // Beside the relative let go on, where it shows (measured once the
        // 3D view has the card tilted again).
        const fx = ev.clientX, fy = ev.clientY
        requestAnimationFrame(() => {
          const r = document.querySelector(`[data-card-back="${groupId}"] [data-member-row="${over}"]`)?.getBoundingClientRect()
          setKinMenu({ a: id, b: over, x: r ? r.right + 6 : fx, y: r ? r.top : fy })
        })
        return
      }
      useUndoCoordinator.getState().checkpoint()
      const bs = useBoardsStore.getState()
      const f = bs.groups.find(g => g.id === groupId)
      const shown = f ? factionGroupsOf(f) : null
      if (f && shown) {
        // Into a group (onto its heading, or onto one of its members): out
        // of the group it was in, at the top of that one unless onto a member.
        const to = over.startsWith('group:') ? over.slice(6) : shown.find(g => g.cards.includes(over))?.id
        if (to && !shown.find(g => g.id === to)?.cards.includes(id)) bs.setFactionShape(groupId, withMemberMoved(f, id, to))
        if (over.startsWith('group:')) { bs.setReportsTo(groupId, id, null); return }
      }
      useBoardsStore.getState().setReportsTo(groupId, id, over === 'top' ? null : over, over !== 'top' && ev.shiftKey)
    }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); end() } }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey, true)
  }

  /** Press on a group's heading: drag it onto another group's to take its
   *  place there (the rest move along). */
  const onGroupDown = (e: React.PointerEvent, id: string) => {
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
        return el.closest<HTMLElement>('[data-faction-group]')?.dataset.factionGroup ?? null
      }
      return null
    }
    const end = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey, true)
      setGdrag(null)
    }
    const onMove = (ev: PointerEvent) => {
      if (!live && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return
      live = true
      setGdrag({ id, over: at(ev) })
    }
    const onUp = (ev: PointerEvent) => {
      const over = live ? at(ev) : null
      end()
      const f = useBoardsStore.getState().groups.find(g => g.id === groupId)
      const shown = f ? factionGroupsOf(f) : null
      if (!f || !shown || !over || over === id) return
      const from = shown.findIndex(g => g.id === id), to = shown.findIndex(g => g.id === over)
      // Down: below the one let go on; up: above it.
      const before = to > from ? (shown[to + 1]?.id ?? null) : over
      useUndoCoordinator.getState().checkpoint()
      useBoardsStore.getState().setFactionShape(groupId, withGroupMoved(f, id, before))
    }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); end() } }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey, true)
  }

  // Members folded on this back: those under them are hidden.
  const folded = new Set(me?.foldedMembers ?? [])
  const setFolds = (ids: string[], f: boolean) => {
    useUndoCoordinator.getState().checkpoint()
    useBoardsStore.getState().setMembersFolded(groupId, ids, f)
  }

  /** One member's row in a faction's list (by rank, or inside its group).
   *  `crew`: some are under it, so it can be folded. */
  const memberRow = ({ card, rank, depth, bosses }: FactionMember, showRank: boolean, crew = false) => {
                const target = mdrag?.over === card.id && mdrag.ok
                return (
                <div
                  key={card.id}
                  data-faction-member={card.id}
                  data-member-row={card.id}
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
                  {showRank && <RankBadge rank={rank} color={color} />}
                  <span style={{ width: 6, height: 6, borderRadius: 2, background: card.color, flexShrink: 0, border: '1px solid rgba(255,255,255,0.5)' }} />
                  <span style={{ fontSize: 9.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '0 1 auto' }}>{card.name || 'Untitled'}</span>
                  {/* Its other bosses: it reports to them too. */}
                  {bosses.length > 1 && (
                    <span data-member-also title={'Also reports to ' + bosses.slice(1).map(b => b.name || 'Untitled').join(', ')} style={{ fontSize: 7.5, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '0 1000 auto' }}>
                      &amp; {bosses.slice(1).map(b => b.name || 'Untitled').join(', ')}
                    </span>
                  )}
                  {/* Fold away those under it (lit: folded). */}
                  {crew && (
                    <MemberFold
                      folded={folded.has(card.id)}
                      ink={ink}
                      title="Fold away those under them (lit: folded)"
                      attr={{ 'data-member-fold': card.id }}
                      onClick={() => setFolds([card.id], !folded.has(card.id))}
                    />
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
  }

  const ink = edgeColorFromHex(color, 0.9)
  // The names' column fits the longest name (within reason), the same for
  // every row, so the values line up.
  type ReadRow = { key: string; k: string; v: string; dot?: string; attr?: Record<string, string> }
  const readRows: ReadRow[] = [
    ...memberOf.flatMap(({ faction, rank, step, bosses }): ReadRow[] => [
      { key: faction.id + ':f', k: 'FACTION', v: faction.name || 'Untitled', dot: faction.color, attr: { 'data-member-of': faction.id } },
      { key: faction.id + ':r', k: 'RANK', v: rankText({ rank, step }) },
      ...(bosses.length ? [{ key: faction.id + ':b', k: 'REPORTS TO', v: bosses.map(b => b.name || 'Untitled').join(', '), dot: bosses[0].color, attr: { 'data-member-boss': faction.id } }] : []),
    ]),
    ...kinOf.flatMap(({ family, rel }): ReadRow[] => [
      { key: family.id + ':f', k: 'FAMILY', v: family.name || 'Untitled', dot: family.color, attr: { 'data-kin-of': family.id } },
      ...rel.map(r => ({ key: family.id + ':' + r.label, k: r.label.toUpperCase(), v: r.cards.map(c => c.name || 'Untitled').join(', '), dot: r.cards[0].color, attr: { 'data-kin-rel': r.label } })),
    ]),
  ]
  // Every detail is its name, small, over its value, which gets the
  // card's whole width: the same on every card shape.
  const rowStyle: React.CSSProperties = {
    position: 'relative', display: 'flex', flexDirection: 'column', gap: 0,
    borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 1,
  }
  const labelStyle: React.CSSProperties = { fontSize: 6.5, fontWeight: 700, color: ink, opacity: 0.8, textTransform: 'uppercase', letterSpacing: 0.4, lineHeight: '8px', paddingTop: 1 }
  const valueStyle: React.CSSProperties = { fontSize: 10, fontWeight: 500, color: 'rgba(255,255,255,0.95)', lineHeight: '11.5px' }
  const setFolded = (id: string, folded: boolean) => write(cur().map(d => d.id === id ? (folded ? { ...d, collapsed: true } : (({ collapsed: _c, ...rest }) => rest)(d)) : d))
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
  const kinItems = (a: string, b: string): MenuItem[] => {
    const bs = useBoardsStore.getState()
    const kin: Kin = bs.groups.find(g => g.id === groupId)?.kin ?? {}
    const name = (id: string) => bs.groups.find(g => g.id === id)?.name || 'Untitled'
    const apply = (next: Kin) => { useUndoCoordinator.getState().checkpoint(); bs.setFamilyKin(groupId, next); setKinMenu(null) }
    const child = (kin.parents?.[a] ?? []).includes(b)
    const parent = (kin.parents?.[b] ?? []).includes(a)
    const partners = arePartners(kin, a, b)
    const sibs = areSiblings(kin, a, b)
    // Ticked: they are. Pick a ticked one to undo it.
    return [
      { label: `Child of ${name(b)}`, checked: child, disabled: !child && isKinAbove(kin, a, b), onClick: () => apply(setChildOf(kin, a, b, !child)) },
      { label: `Parent of ${name(b)}`, checked: parent, disabled: !parent && isKinAbove(kin, b, a), onClick: () => apply(setChildOf(kin, b, a, !parent)) },
      { label: `Partner of ${name(b)}`, checked: partners, onClick: () => apply(setPartners(kin, a, b, !partners)) },
      { label: `Sibling of ${name(b)}`, checked: sibs, disabled: !sibs && (isKinAbove(kin, a, b) || isKinAbove(kin, b, a)), onClick: () => apply(setSiblings(kin, a, b, !sibs)) },
    ]
  }
  /** The cards in this card's deck, to pick one for a detail without
   *  going to find it (Brian 2026-11-19). */
  const deckMenu = (id: string): MenuItem[] => {
    const all = useBoardsStore.getState().groups
    const d = cur().find(x => x.id === id)
    const mates = deckCardsOf(all, groupId).filter(g => g.id !== groupId && g.id !== meId && !g.effect)
    if (!d) return []
    const items: MenuItem[] = mates.map(g => ({
      label: cardTitle(all, g) || 'Untitled',
      hint: g.fav === 3 ? '  master' : g.fav === 2 ? '  ♥♥' : g.fav === 1 ? '  ♥' : undefined,
      swatch: g.color,
      checked: d.link?.card === g.id && !d.link.detail && !d.link.count && !d.link.rankOf,
      onClick: () => { setLink(id, { card: g.id }); setMenu(null) },
    }))
    if (!items.length) items.push({ label: 'No other cards in its deck', disabled: true, onClick: () => {} })
    if (d.link) items.push({ label: 'Unlink, keep the text', separator: true, onClick: () => { setLink(id, null); setMenu(null) } })
    return items
  }
  const linkMenu = (id: string): MenuItem[] => {
    const all = useBoardsStore.getState().groups
    const d = cur().find(x => x.id === id)
    const card = d?.link && all.find(g => g.id === d.link!.card)
    if (!d?.link) return []
    if (!card) return [{ label: 'Unlink (the card is gone)', onClick: () => { setLink(id, null); setMenu(null) } }]
    // A rank on a chart: the charts to rank on instead.
    if (d.link.rankOf) return [
      ...charts.map(c => {
        const r = chartRank(c, d.link!.rankOf!)
        return {
          label: chartName(c), hint: r ? `  rank ${rankText(r)}` : '  not on it', swatch: c.color, checked: c.id === card.id,
          onClick: () => {
            // Its name follows the chart, unless it was renamed.
            const named = d.name.trim() === chartName(card)
            write(cur().map(x => x.id === id ? { ...x, ...(named ? { name: chartName(c) } : {}), link: { card: c.id, rankOf: d.link!.rankOf } } : x))
            setMenu(null)
          },
        }
      }),
      { label: 'Unlink, keep the text', separator: true, onClick: () => { setLink(id, null); setMenu(null) } },
    ]
    return [
      { label: card.name || 'Untitled', hint: '  the card', checked: !d.link.detail && !d.link.count && !d.link.favorite, swatch: card.color, onClick: () => { setLink(id, { card: card.id }); setMenu(null) } },
      // The card as its deck: whichever of the deck's cards is its favourite.
      ...(deckCardsOf(all, card.id).length > 1 ? [{ label: "Its deck's favourite", hint: `  ${deckFavorite(deckCardsOf(all, card.id))?.name || 'Untitled'}`, checked: !!d.link.favorite, onClick: () => { setLink(id, { card: card.id, favorite: true }); setMenu(null) } }] : []),
      // A faction or family: how many are in it (counted live).
      ...(hasMembers(card) ? [{ label: 'Number of members', hint: `  ${detailShown(all, { id: '', name: '', value: '', link: { card: card.id, count: 'members' } }).text}`, checked: d.link.count === 'members', onClick: () => { setLink(id, { card: card.id, count: 'members' }); setMenu(null) } }] : []),
      ...(card.details ?? []).filter(x => x.name.trim() && !isOwnCount(x, card.id)).map(x => ({
        label: x.name, hint: `  ${detailShown(all, x).text}`, checked: d.link!.detail === x.id,
        onClick: () => { setLink(id, { card: card.id, detail: x.id }); setMenu(null) },
      })),
      { label: 'Unlink, keep the text', separator: true, onClick: () => { setLink(id, null); setMenu(null) } },
    ]
  }

  return (
    <div
      data-card-back={groupId}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: radius ?? '0 0 12px 12px' }}
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
          paddingLeft: Math.max(0, reserve / s - 8), minHeight: Math.max(0, reserve / s - 11), display: 'flex', alignItems: 'center', gap: 3,
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
          {/* The card's colour and how see-through it is: click to set them. */}
          <div
            data-card-color
            title="Card color and transparency"
            {...colorClick}
            style={{
              display: 'inline-flex', alignItems: 'center', cursor: 'pointer', padding: '2.5px 4px', borderRadius: 3,
              background: cardPicker ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.25)',
            }}
          >
            <span style={{
              width: 11, height: 7, borderRadius: 2, boxSizing: 'border-box', border: '1px solid rgba(255,255,255,0.55)',
              background: `linear-gradient(${cardFill(color, me?.colorOpacity)}, ${cardFill(color, me?.colorOpacity)}), repeating-conic-gradient(#666 0% 25%, #333 0% 50%) 0 0 / 4px 4px`,
            }} />
          </div>
        </div>
        <div
          data-wheel-own
          ref={listRef}
          onScroll={checkMore}
          onWheel={e => { const el = e.currentTarget; if (el.scrollHeight > el.clientHeight + 1) e.stopPropagation() }}
          style={{
            flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: 1, scrollbarWidth: 'none',
            // No scrollbar: the details use the whole back; a soft fade at
            // the bottom says there is more to wheel down to.
            ...(more ? { maskImage: 'linear-gradient(to bottom, #000 calc(100% - 14px), transparent)', WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 14px), transparent)' } : null),
          }}
        >
          {/* A faction in groups: each group top to bottom (its number is
              its members' rank), and inside it who reports to whom. */}
          {fgroups && me && (
            <>
              <div
                data-faction-top
                title="Drag a section's heading onto another section to move it there"
                style={{ fontSize: 7, fontWeight: 800, letterSpacing: 1, color: ink, opacity: 0.6, padding: '1px 2px 0' }}
              >SECTION MEMBERS</div>
              {fgroups.map((fg, i) => {
                const sub = factionMembers(groups, { ...me, linkedGroupIds: fg.cards })
                const lead = sub[0]?.card
                // Its leaders with some under them: FOLD on the heading
                // folds the section down to its leaders (lit: all folded).
                const rows = unfolded(sub, folded)
                const leaders = sub.filter((m, k) => m.depth === 0 && (sub[k + 1]?.depth ?? -1) > 0).map(m => m.card.id)
                const allFolded = leaders.length > 0 && leaders.every(id => folded.has(id))
                const into = (mdrag?.over === 'group:' + fg.id && mdrag.ok) || (!!gdrag && gdrag.over === fg.id && gdrag.id !== fg.id)
                return (
                  <div key={fg.id} data-faction-group={fg.id} style={{
                    display: 'flex', flexDirection: 'column', gap: 1, paddingBottom: 2, borderRadius: 2,
                    borderBottom: '1px solid rgba(255,255,255,0.12)',
                    opacity: gdrag?.id === fg.id ? 0.45 : 1,
                    outline: into ? '1px dashed rgba(255,255,255,0.8)' : undefined,
                    background: into ? 'rgba(255,255,255,0.1)' : undefined,
                  }}>
                    <div
                      data-group-head={fg.id}
                      title="Drag onto another section to move it there. Drag a member here to put it in this section."
                      onPointerDown={e => onGroupDown(e, fg.id)}
                      style={{ display: 'flex', alignItems: 'center', gap: 3, minHeight: 13, cursor: gdrag ? 'grabbing' : 'grab' }}
                    >
                      <RankBadge rank={i + 1} color={color} />
                      <span style={{ fontSize: 9.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                        {fg.title?.trim() || lead?.name || 'Untitled'}
                      </span>
                      <span style={{ fontSize: 7.5, opacity: 0.55, flexShrink: 0 }}>{fg.cards.length}</span>
                      {leaders.length > 0 && (
                        <MemberFold
                          folded={allFolded}
                          ink={ink}
                          title="Fold the section down to its leaders (lit: folded)"
                          attr={{ 'data-section-fold': fg.id }}
                          onClick={() => setFolds(leaders, !allFolded)}
                        />
                      )}
                    </div>
                    <div style={{ marginLeft: 5, display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {rows.map(({ m, crew }) => memberRow(m, false, crew))}
                    </div>
                  </div>
                )
              })}
              <div style={{ fontSize: 7, fontWeight: 800, letterSpacing: 1, color: ink, opacity: 0.6, padding: '4px 2px 0' }}>DETAILS</div>
            </>
          )}
          {/* A faction: its members, by rank. */}
          {type === 'faction' && me && !fgroups && (
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
              {unfolded(members, folded).map(({ m, crew }) => memberRow(m, true, crew))}
              <div style={{ fontSize: 7, fontWeight: 800, letterSpacing: 1, color: ink, opacity: 0.6, padding: '4px 2px 0' }}>DETAILS</div>
            </>
          )}
          {/* A family: its tree, each under their parents, a partner from
              outside just after the one they are with. */}
          {type === 'family' && me && (
            <>
              <div style={{ fontSize: 7, fontWeight: 800, letterSpacing: 1, color: ink, opacity: 0.6, padding: '1px 2px 0' }}>MEMBERS</div>
              {tree.length === 0 && (
                <div style={{ fontSize: 8, opacity: 0.45, padding: '0 2px 2px' }}>Drag a card’s + here to add it.</div>
              )}
              {tree.map(row => {
                const elbow = row.depth > 0 && !row.partnerOf && <span style={{ width: 4, height: 6, marginTop: -5, flexShrink: 0, borderLeft: '1px solid rgba(255,255,255,0.35)', borderBottom: '1px solid rgba(255,255,255,0.35)' }} />
                if (!row.card) return (
                  <div key={row.id} data-family-unknown style={{ display: 'flex', alignItems: 'center', gap: 3, marginLeft: row.depth * 7, minHeight: 13, fontSize: 8.5, fontStyle: 'italic', opacity: 0.5, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    {elbow}Unknown parent
                  </div>
                )
                const card = row.card
                const target = mdrag?.over === card.id && mdrag.ok
                return (
                  <div
                    key={row.id}
                    data-family-member={card.id}
                    data-member-row={card.id}
                    data-member-depth={row.depth}
                    title="Drag onto another member to say how they are related"
                    onPointerDown={e => onMemberDown(e, card.id)}
                    onPointerEnter={() => setRowHover('m:' + card.id)}
                    onPointerLeave={() => setRowHover(r => r === 'm:' + card.id ? null : r)}
                    style={{
                      position: 'relative', display: 'flex', alignItems: 'center', gap: 3, marginLeft: row.depth * 7,
                      borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 1, minHeight: 13, borderRadius: 2,
                      cursor: mdrag ? (mdrag.ok ? 'grabbing' : 'no-drop') : 'grab',
                      opacity: mdrag?.id === card.id ? 0.45 : 1,
                      outline: target ? '1px dashed rgba(255,255,255,0.8)' : undefined,
                      background: target ? 'rgba(255,255,255,0.1)' : undefined,
                    }}
                  >
                    {elbow}
                    {/* With the one above: their partner. */}
                    {row.partnerOf && <span style={{ fontSize: 8.5, fontWeight: 700, opacity: 0.6, flexShrink: 0 }}>&amp;</span>}
                    <span style={{ width: 6, height: 6, borderRadius: 2, background: card.color, flexShrink: 0, border: '1px solid rgba(255,255,255,0.5)' }} />
                    <span style={{ fontSize: 9.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '0 1 auto' }}>{card.name || 'Untitled'}</span>
                    {/* Partners shown at their own place in the tree. */}
                    {row.partners.length > 0 && (
                      <span data-member-also title={'Partner of ' + row.partners.map(b => b.name || 'Untitled').join(', ')} style={{ fontSize: 7.5, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '0 1000 auto' }}>
                        &amp; {row.partners.map(b => b.name || 'Untitled').join(', ')}
                      </span>
                    )}
                    {rowHover === 'm:' + card.id && !linking && !mdrag && (
                      <button
                        type="button"
                        data-faction-member-remove
                        title="Take out of this family"
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
            const linked0 = d.link ? detailShown(groups, d) : null
            // A height is shown in the app's units, however it was typed (store/unitsStore).
            const asUnit = heightAsUnit(d.name, linked0 ? linked0.text : d.value, metric)
            const linked = linked0 && asUnit && d.link!.detail ? { ...linked0, text: asUnit } : linked0
            // Its own member count: shown, never typed, linked or removed.
            const own = isOwnCount(d, meId) || isOwnCount(d, groupId)
            const rank = isChartRank(d)
            return (
              <div
                key={d.id}
                data-card-detail-row={d.id}
                onPointerEnter={() => setRowHover(d.id)}
                onPointerLeave={() => setRowHover(r => r === d.id ? null : r)}
                style={rowStyle}
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
                  style={labelStyle}
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
                  shown={own ? <span data-member-count title="How many members it has: counted, not typed">{linked?.text}</span>
                    : rank && linked ? <span data-chart-rank={d.link!.card} title={`Rank on ${linked.card ? chartName(linked.card) : 'a chart'}: its group on the chart, counted from the top (read from the chart, not typed)`}><LinkShown text={linked.text} color={linked.card?.color} missing={linked.missing} whole={false} /></span>
                    : linked ? <LinkShown text={linked.text} color={linked.card?.color} missing={linked.missing} whole={!d.link!.detail && !d.link!.count} /> : asUnit && asUnit !== d.value ? asUnit : undefined}
                  onPick={own ? undefined : e => setMenu({ x: e.clientX, y: e.clientY, kind: 'link', id: d.id })}
                  drop={own || rank ? undefined : `detail:${groupId}:${d.id}`}
                  lit={linking}
                  wrap
                  folded={d.collapsed}
                  onLong={l => setLongRows(prev => prev.has(d.id) === l ? prev : (n => (l ? n.add(d.id) : n.delete(d.id), n))(new Set(prev)))}
                  style={valueStyle}
                />
                {/* Pick a card of its deck for this detail. Always there, in
                    the same place, whether or not it is in a deck. */}
                {!own && !rank && !(editing?.id === d.id) && (
                  <button
                    type="button"
                    data-card-detail-pick
                    title="Pick a card from its deck for this detail"
                    onPointerDown={stopPress}
                    onDoubleClick={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, kind: 'deck', id: d.id }) }}
                    style={{
                      position: 'absolute', right: 34, top: 0, width: 11, height: 9, padding: 0, lineHeight: '9px',
                      fontSize: 7, borderRadius: 3, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                      background: 'rgba(0,0,0,0.3)', color: ink, opacity: rowHover === d.id ? 1 : 0.5,
                    }}
                  >▾</button>
                )}
                {/* A detail that shows a card: a chip for it on the front,
                    or not (lit: on the front). */}
                {!own && !rank && d.link && !d.link.detail && !d.link.count && !(editing?.id === d.id) && (
                  <button
                    type="button"
                    data-card-detail-front={d.onFace ? 'on' : 'off'}
                    title="Show as a chip on the front of the card (lit: on the front)"
                    onPointerDown={stopPress}
                    onDoubleClick={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); write(cur().map(x => x.id !== d.id ? x : d.onFace ? (({ onFace: _f, ...rest }) => rest)(x) : { ...x, onFace: true })) }}
                    style={{
                      position: 'absolute', right: 47, top: 0, height: 9, padding: '0 3px', lineHeight: '9px',
                      fontSize: 6.5, fontWeight: 700, borderRadius: 3, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                      background: d.onFace ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.3)', color: d.onFace ? '#14161f' : ink, opacity: d.onFace ? 1 : 0.55,
                    }}
                  >FRONT</button>
                )}
                {/* A long value: fold it to one line, or open it again. */}
                {longRows.has(d.id) && !(editing?.id === d.id) && (
                  <button
                    type="button"
                    data-card-detail-fold
                    title="Fold to one line (lit: folded)"
                    onPointerDown={stopPress}
                    onClick={e => { e.stopPropagation(); setFolded(d.id, !d.collapsed) }}
                    style={{
                      position: 'absolute', right: 13, top: 0, height: 9, padding: '0 3px', lineHeight: '9px',
                      fontSize: 6.5, fontWeight: 700, borderRadius: 3, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                      background: d.collapsed ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.3)', color: d.collapsed ? '#fff' : ink, opacity: d.collapsed ? 1 : 0.55,
                    }}
                  >FOLD</button>
                )}
                {rowHover === d.id && !editing && !linking && !own && (
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
          {details.length === 0 && type !== 'faction' && type !== 'family' && readRows.length === 0 && (
            <div style={{ fontSize: 8.5, opacity: 0.45, padding: '2px 2px 0' }}>No details yet.</div>
          )}
          {/* The factions it is in, read from them: name, rank and boss;
              the families: name, and its kin there. */}
          {readRows.map(({ key, k, v, dot, attr }) => (
            <div key={key} {...attr} style={rowStyle}>
              <div title={k} style={{ ...labelStyle, padding: '0 3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k}</div>
              <div title={v} style={{ ...valueStyle, overflowWrap: 'anywhere', padding: '0 3px' }}>
                {dot ? <LinkShown text={v} color={dot} whole /> : v}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 3, alignSelf: 'flex-start', flexShrink: 0 }}>
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
          {/* A rank on one of the charts (cards a storyline was baked into). */}
          {charts.length > 0 && (
            <button
              type="button"
              data-card-chart-add
              title="Add its rank on a chart"
              onPointerDown={stopPress}
              onDoubleClick={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, kind: 'chart' }) }}
              style={{
                alignSelf: 'flex-start', flexShrink: 0, marginTop: 2, fontSize: 8.5, fontWeight: 700, fontFamily: 'inherit',
                padding: '1px 6px', borderRadius: 8, cursor: 'pointer', background: 'rgba(0,0,0,0.3)', color: ink,
                border: `1px solid ${edgeColorFromHex(color, 0.35)}`,
                opacity: hovered ? 1 : 0, transition: 'opacity 0.12s', pointerEvents: hovered ? 'auto' : 'none',
              }}
            >+ chart</button>
          )}
          </div>
        </div>
      </div>
      {menu?.kind === 'type' && <BackMenu at={menu} title="Card type" items={typeMenu()} onClose={() => setMenu(null)} />}
      {menu?.kind === 'chart' && <BackMenu at={menu} title="Rank on chart" items={chartMenu()} onClose={() => setMenu(null)} />}
      {menu?.kind === 'link' && <BackMenu at={menu} title="This detail shows" items={linkMenu(menu.id)} onClose={() => setMenu(null)} />}
      {menu?.kind === 'deck' && <BackMenu at={menu} title="Pick from the deck" items={deckMenu(menu.id)} onClose={() => setMenu(null)} />}
      {kinMenu && <BackMenu at={kinMenu} title={`${groups.find(g => g.id === kinMenu.a)?.name || 'Untitled'} is…`} items={kinItems(kinMenu.a, kinMenu.b)} onClose={() => setKinMenu(null)} />}
      {cardPicker && ReactDOM.createPortal(
        // One undo step for each press: a drag on the colour field or the
        // slider is one change. With several cards selected, all of them.
        <div style={{ display: 'contents' }} onPointerDownCapture={() => useUndoCoordinator.getState().checkpoint()}>
          <ColorPickerPopup
            color={color}
            anchorX={cardPicker.x}
            anchorY={cardPicker.y}
            opacity={me?.colorOpacity ?? 1}
            onChange={c => {
              const bs = useBoardsStore.getState()
              for (const id of colorIds(groupId)) { bs.setGroupColor(id, c); bs.setGroupOwnColor(id, true) }
            }}
            onOpacityChange={o => {
              const bs = useBoardsStore.getState()
              for (const id of colorIds(groupId)) bs.setGroupColorOpacity(id, o)
            }}
            onClose={closeCardPicker}
          />
        </div>,
        document.body,
      )}
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
