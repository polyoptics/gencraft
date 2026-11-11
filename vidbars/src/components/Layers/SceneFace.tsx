// A SCENE card's face (Brian's storyMap): its divisions, coloured, filling
// the face as a media sheet. A division without a face shows its name in
// the middle. A card let go on it copies that card's face in (header, text,
// picture and their look, utils/sceneContent), and from then on the
// division's face is drawn and edited exactly as a card's is
// (GroupCardText, its toolbar), never touching the card, which it only
// links back to (a small icon while pointed at). Double-click a division to
// write in it the same way.
//
// Controls live on the divisions themselves (Brian 2026-11-08: "interactive
// with the widgets and zones", no bar): pointed at, a division shows a "+"
// on its right edge (divide side by side) and on its bottom edge (divide
// top and bottom), its colour and a "more" button (bump out, open as its
// own scene card, fold, picture, unlink, remove) at its top-right. A
// section's heading folds the section to one strip and opens it again.
// Drag the line between two to resize them.
//
// Each division shows itself by the room it has, and moves smoothly between
// them: its full face; an icon (round picture and its header); one row
// (round picture, header, text); a standing strip (its header on end).
//
// The scene's view modes sit in a small widget at its bottom-right: Focus
// (click divisions to light them, a section's heading lights the section),
// Bump-outs (marked divisions stand taller), Trace (only divisions whose
// card or text matches stay lit, with the headings on the path to them).
// Data: ProjectGroup.scene / sceneView (utils/sceneCard).

import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useLinkDragStore } from '../../store/linkDragStore'
import { cardTitle } from '../../utils/faceStyle'
import { CARD_TYPES } from '../../utils/cardTypes'
import {
  breakEdge, canFold, canMerge, divBoxes, edgeBreaks, findDiv, mergeParts, heldCard, isLeaf, leaves, litDivisions, needOf, patchDiv, removeDiv, resizeSplit, sectionOf, shareUnits, splitDiv, takeCard,
  gathered, clearDiv, moveDiv, movedBy,
  type SceneDiv, type SceneView,
} from '../../utils/sceneCard'
import { GroupCardText } from './CardLayer'
import { CardBack, backColor } from './CardBack'
import { openDivision } from '../../utils/sceneOpen'
import { cardChanged, contentOf, copyFrom, migrateScene, refreshDivision, shownContent } from '../../utils/sceneContent'
import { bakeDivision } from '../../utils/sceneBake'
import { faceLayout, growStrip, GAP, NAT_H, NAT_W, PAD } from '../../utils/sceneGrow'
import { useCanvasStore } from '../../store/canvasStore'
import { ColorPickerPopup } from '../Bar/ColorPickerPopup'
import { DEFAULT_BODY_STYLE, DEFAULT_HEADER_STYLE } from '../../store/freeNodeStore'
import { area3dOutOf, toggleArea3d } from '../../utils/area3dCard'
import { useResolvedMedia } from '../../utils/useResolvedMedia'

/** A picture by its STORED url: one kept in the app's own media store
 *  (mediaref:, as a GIF made in the app can be) is looked up first, as a
 *  card's face does. Drawn as a plain <img>, so an animated GIF plays. */
const Pic: React.FC<React.ImgHTMLAttributes<HTMLImageElement> & { src: string }> = ({ src, ...rest }) => {
  const url = useResolvedMedia(src)
  return url ? <img src={url} {...rest} /> : null
}

/** Laid out at a new card's size and scaled with the card, like its back. */
// Card scale at which the layout reads at its natural size.
/** Shorter than this (layout units): one row. */
const ROW_H = 15
/** Narrower than this: a standing strip. */
const STAND_W = 14
/** Smaller than this, a division with a picture or face: an icon. */
const ICON_W = 36, ICON_H = 32
/** A division's controls, in screen px (the same size at every zoom). */
const TOOL_PX = 15

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const stopPress = (e: React.PointerEvent) => { if (e.button === 0) e.stopPropagation() }
type Box = { x: number; y: number; w: number; h: number }

/** Matches a trace: the card's name, type, text and details, or the
 *  division's own header and text. */
function traceMatch(d: SceneDiv, card: ProjectGroup | undefined, groups: ProjectGroup[], q: string): boolean {
  const n = q.trim().toLowerCase()
  if (!n) return true
  const hay = [d.name, d.notes]
  if (card) {
    hay.push(cardTitle(groups, card), card.name, card.cardText, card.cardType ? CARD_TYPES[card.cardType]?.label : '')
    for (const det of card.details ?? []) hay.push(`${det.name}: ${det.value}`, det.value)
  }
  return hay.some(h => (h ?? '').toLowerCase().includes(n))
}

type Ctx = {
  sceneId: string
  s: number
  /** A control's size in layout units. */
  u: number
  groups: ProjectGroup[]
  where: () => { x: number; y: number }
  write: (next: SceneDiv) => void
  root: () => SceneDiv | undefined
  picked: string | null
  pick: (id: string | null) => void
  linking: boolean
  renaming: string | null
  setRenaming: (id: string | null) => void
  /** The division whose notes are being typed into, in place. */
  noting: string | null
  setNoting: (id: string | null) => void
  lit: Set<string> | null
  bumps: boolean
  focus: boolean
  toggleFocus: (id: string) => void
  hovered: string | null
  setHovered: (id: string | null) => void
  moving: string | null
  setMoving: (id: string | null) => void
  /** A seam is being dragged: no easing, the divisions follow the hand. */
  dragging: boolean
  setDragging: (on: boolean) => void
  openMenu: (id: string, x: number, y: number) => void
  openPicker: (id: string, x: number, y: number) => void
  /** How far a seam's grab reaches into the parts beside it (layout units). */
  seamIn: number
  /** Every part's box (layout units). */
  boxes: Map<string, Box>
  /** Change a division (with an undo step unless step is false). */
  patch: (id: string, p: Partial<SceneDiv>, step?: boolean) => void
  /** Where a part's knobs are drawn: above every seam and edge bar, so a
   *  bumped part's knobs are never under a seam. In face layout units. */
  layer: HTMLDivElement | null
  W: number
  H: number
  /** The whole face, to read what a division gathers from its headings. */
  scene: SceneDiv
  /** A part being dragged to a new place (its divisions), and the press
   *  on a division's grip that starts it. */
  lifted: Set<string> | null
  startMove: (leafId: string, e: React.PointerEvent) => void
}

/** The outer edge bars (EdgeStrip): how deep each is, and how far the
 *  bottom and right ones sit inside the card's own resize bars. */
const edgeBand = (s: number) => Math.max(PAD, 7 / s)
const edgeOff = (s: number) => 7 / s

/** A click (the card did not move between press and release). */
function useClick(ctx: Ctx, onClick: (e: React.MouseEvent) => void) {
  const down = useRef<{ x: number; y: number } | null>(null)
  return {
    onPointerDown: (e: React.PointerEvent) => { if (e.button === 0) down.current = ctx.where() },
    onClick: (e: React.MouseEvent) => {
      const a = down.current, b = ctx.where()
      down.current = null
      if (e.button !== 0 || !a || Math.hypot(a.x - b.x, a.y - b.y) > 0.5) return
      onClick(e)
    },
  }
}

const NameInput: React.FC<{ d: SceneDiv; ctx: Ctx; font: number }> = ({ d, ctx, font }) => {
  const [draft, setDraft] = useState(d.name ?? '')
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => { requestAnimationFrame(() => { ref.current?.focus(); ref.current?.select() }) }, [])
  const commit = () => {
    if (done.current) return
    done.current = true
    const r = ctx.root()
    if (r && draft !== d.name) ctx.write(patchDiv(r, d.id, { name: draft }))
    ctx.setRenaming(null)
  }
  return (
    <input
      ref={ref}
      data-scene-name-input
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onPointerDown={stopPress}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); commit() }
        else if (e.key === 'Tab' && !d.face) { e.preventDefault(); commit(); ctx.setNoting(d.id) }
        else if (e.key === 'Escape') { e.preventDefault(); done.current = true; ctx.setRenaming(null) }
      }}
      onBlur={commit}
      style={{
        fontSize: font, fontWeight: 700, color: '#fff', textAlign: 'center', width: '86%', minWidth: 0, boxSizing: 'border-box',
        padding: '0 1px', margin: 0, fontFamily: 'inherit', background: 'rgba(0,0,0,0.45)', border: '0.5px solid rgba(255,255,255,0.6)',
        borderRadius: 1.5, outline: 'none', userSelect: 'text', pointerEvents: 'auto',
      }}
    />
  )
}

/** Typing a division's notes straight on the card: Enter makes a new
 *  line, Esc or a click away keeps them. */
const NotesInput: React.FC<{ d: SceneDiv; ctx: Ctx; font: number }> = ({ d, ctx, font }) => {
  const [draft, setDraft] = useState(d.notes ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  useEffect(() => { requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } }) }, [])
  const commit = () => {
    if (done.current) return
    done.current = true
    const r = ctx.root()
    if (r && draft !== (d.notes ?? '')) ctx.write(patchDiv(r, d.id, { notes: draft }))
    ctx.setNoting(null)
  }
  return (
    <textarea
      ref={ref}
      data-scene-notes-input
      value={draft}
      rows={Math.max(1, draft.split('\n').length)}
      onChange={e => setDraft(e.target.value)}
      onPointerDown={stopPress}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); commit() }
        else if (e.key === 'Tab') { e.preventDefault(); commit(); if (e.shiftKey) ctx.setRenaming(d.id) }
      }}
      onBlur={commit}
      style={{
        fontSize: font, lineHeight: 1.25, color: '#fff', textAlign: 'center', width: '92%', minWidth: 0, boxSizing: 'border-box', resize: 'none',
        padding: '0 1px', margin: 0, fontFamily: 'inherit', background: 'rgba(0,0,0,0.35)', border: '0.5px solid rgba(255,255,255,0.6)',
        borderRadius: 1.5, outline: 'none', userSelect: 'text', pointerEvents: 'auto', overflow: 'hidden',
      }}
    />
  )
}

/** A round control on a division, sized in screen px. */
const Knob: React.FC<{
  ctx: Ctx; tool: string; title: string; at: React.CSSProperties; lit?: boolean; bg?: string
  onClick: (e: React.MouseEvent) => void; children?: React.ReactNode
  /** A knob that is dragged (the move grip): its press. */
  onDown?: (e: React.PointerEvent) => void
}> = ({ ctx, tool, title, at, lit, bg, onClick, children, onDown }) => (
  <button
    type="button"
    data-scene-tool={tool}
    title={title}
    onPointerDown={onDown ?? stopPress}
    onDoubleClick={e => e.stopPropagation()}
    onClick={e => { e.stopPropagation(); onClick(e) }}
    style={{
      position: 'absolute', ...at, width: ctx.u, height: ctx.u, padding: 0, borderRadius: '50%', cursor: onDown ? 'grab' : 'pointer', zIndex: 6, pointerEvents: 'auto',
      display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
      background: bg ?? (lit ? '#ffd666' : 'rgba(14,16,24,0.82)'), color: lit ? '#111' : '#fff',
      border: `${ctx.u * 0.08}px solid rgba(255,255,255,${lit ? 1 : 0.75})`, boxShadow: `0 ${ctx.u * 0.08}px ${ctx.u * 0.25}px rgba(0,0,0,0.45)`,
      fontSize: ctx.u * 0.72, fontWeight: 800, lineHeight: 1, fontFamily: 'inherit',
    }}
  >{children}</button>
)

const Glyph: React.FC<{ ctx: Ctx; d: string }> = ({ ctx, d }) => (
  <svg width={ctx.u * 0.6} height={ctx.u * 0.6} viewBox="0 0 10 10"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const PLUS = 'M5 1.5v7M1.5 5h7'
const MORE = 'M2 5h0.01M5 5h0.01M8 5h0.01'
const GRIP = 'M3.5 2.5h0.01M6.5 2.5h0.01M3.5 5h0.01M6.5 5h0.01M3.5 7.5h0.01M6.5 7.5h0.01'
const CLEAR = 'M1.5 1.5h7v7h-7zM3.6 3.6l2.8 2.8M6.4 3.6L3.6 6.4'
const FOLD = 'M2 3.5h6M2 6.5h6'

/** The largest font (layout units) at which the longest word of `t` fits
 *  in `w`. */
const wordFit = (t: string, w: number) => {
  const longest = t.split(/\s+/).reduce((m, x) => Math.max(m, x.length), 1)
  return Math.max(0, w) / (longest * 0.62)
}

/** A small framed picture: a rounded rectangle, framed by `crop`. */
const Thumb: React.FC<{ src: string; crop: { x: number; y: number; z: number }; w: number; h: number; line?: boolean; at?: React.CSSProperties }> = ({ src, crop, w, h, line = true, at }) => (
  <div data-scene-thumb style={{
    flex: '0 0 auto', width: w, height: h, borderRadius: at ? 0 : Math.max(0.6, h * 0.12), overflow: 'hidden', position: 'relative', ...at,
    border: line ? `${Math.max(0.3, h * 0.05)}px solid rgba(255,255,255,0.85)` : undefined, boxSizing: 'border-box', boxShadow: at ? undefined : '0 0.5px 1.5px rgba(0,0,0,0.4)',
  }}>
    <Pic src={src} alt="" draggable={false} style={{
      position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none',
      objectPosition: `${crop.x}% ${crop.y}%`, transformOrigin: `${crop.x}% ${crop.y}%`, transform: `scale(${crop.z})`,
    }} />
  </div>
)
const THUMB = 4 / 3

/** A division's icon, shown when it is small: its set icon, or its picture. */
const iconOf = (d: SceneDiv, pic: string | null) => {
  const src = d.icon?.image ?? pic
  return src ? { src, crop: d.icon ?? d.crop ?? { x: 50, y: 50, z: 1 } } : null
}

const Division: React.FC<{ d: SceneDiv; box: Box; ctx: Ctx; heads: boolean; folded: boolean; inside?: SceneDiv[] }> = ({ d, box, ctx, heads, folded, inside }) => {
  const srcId = heldCard(d)
  const src = srcId ? ctx.groups.find(g => g.id === srcId) : undefined
  // A deck in it, stepped off its front with the arrows (Brian 2026-11-10):
  // that card shows, as it is now, to look at (the section's own face is
  // its front's, and comes back at the front).
  const deckN = d.deck?.length ?? 0
  const at = deckN > 1 ? Math.min(deckN - 1, Math.max(0, d.at ?? 0)) : 0
  const stepCard = at > 0 ? ctx.groups.find(g => g.id === d.deck![at]) : undefined
  // Its own copy, or its card as it is now (following live).
  const shown = stepCard ? contentOf(stepCard) : shownContent(d, src)
  const pic = shown.image ?? null
  const crop = stepCard ? { x: 50, y: 50, z: 1 } : d.crop ?? { x: 50, y: 50, z: 1 }
  const hero = stepCard ? undefined : d.hero
  const header = shown.name
  const text = shown.notes.trim()
  // Typing in a live division: it stops following, keeping what showed.
  const freeze = () => { if (d.live && src && !stepCard) ctx.patch(d.id, { ...copyFrom(src, false), live: false }, true) }
  // How it shows, by the room it has.
  const state: 'row' | 'stand' | 'icon' | 'full' =
    box.h < ROW_H ? 'row'
    : box.w < STAND_W ? 'stand'
    : (box.w < ICON_W || box.h < ICON_H) && (!!pic || !!d.face) ? 'icon'
    : 'full'
  const nameFont = state === 'row' ? clamp(box.h * 0.46, 3, 6.5)
    : state === 'stand' ? clamp(box.w * 0.5, 3, 6.5)
    : state === 'icon' ? clamp(Math.min(box.w * 0.13, box.h * 0.16), 3, 6.5)
    : clamp(Math.min(box.h * 0.26, box.w * 0.11, wordFit(header, box.w - 4)), 2.6, 11)
  // Words never break in two: the text gets smaller first.
  const textFont = clamp(Math.min(nameFont * 0.68, wordFit(text, box.w - 4)), 2.2, 9)
  const bump = ctx.bumps && !!d.bump
  const lift = bump ? Math.min(box.h * 0.22, 7) : 0
  const faded = ctx.lit && !ctx.lit.has(d.id)
  const picked = ctx.picked === d.id
  const hovered = ctx.hovered === d.id && !ctx.linking && !ctx.dragging
  const moving = ctx.moving === d.id && !!pic && !stepCard
  const opened = !!d.opens && ctx.groups.some(g => g.id === d.opens)
  const changed = cardChanged(d, src)
  // The card it shows can be turned over (Brian 2026-11-11): its back,
  // the card's details as they are now. A heading's hand-down cards are
  // not its face, so there is none to turn.
  const backCard = d.hand ? undefined : stepCard ?? src
  const canFlip = !!backCard && state === 'full'
  const flipped = canFlip && !!d.flip
  const click = useClick(ctx, () => {
    if (ctx.focus) ctx.toggleFocus(d.id)
    ctx.pick(d.id)
  })
  // Click a name or notes and type: no panel, no second click.
  // Its own face, sized as its text shows now, so nothing jumps when it
  // opens for typing.
  const faceScale = clamp(Math.min(box.w / NAT_W, box.h / (NAT_H * 0.5)), 0.12, 2.5)
  const giveFace = () => {
    if (d.face) return
    ctx.patch(d.id, {
      face: true,
      hstyle: d.hstyle ?? { ...DEFAULT_HEADER_STYLE, fontSize: Math.round(nameFont / faceScale * 10) / 10 },
      bstyle: d.bstyle ?? { ...DEFAULT_BODY_STYLE, fontSize: Math.round(textFont / faceScale * 10) / 10, align: 'center' },
    }, true)
  }
  // Full size: the card's own editor, toolbar and all (it gets a face of
  // its own first). Small: a plain line to type in.
  const divRef = useRef<HTMLDivElement>(null)
  const faceEdit = (field: 'header' | 'body') => {
    giveFace()
    const go = () => {
      divRef.current?.querySelector('[data-card-text]')?.dispatchEvent(new CustomEvent('start-edit', { bubbles: false, detail: { field } }))
      // The caret at the end of what is there, ready to add to it.
      requestAnimationFrame(() => {
        const a = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null
        if (a && typeof a.setSelectionRange === 'function' && divRef.current?.contains(a)) a.setSelectionRange(a.value.length, a.value.length)
      })
    }
    requestAnimationFrame(() => requestAnimationFrame(go))
  }
  const nameClick = useClick(ctx, e => {
    if (ctx.focus || stepCard) return
    e.stopPropagation()
    freeze()
    ctx.pick(d.id)
    if (state === 'full') faceEdit('header')
    else ctx.setRenaming(d.id)
  })
  const notesClick = useClick(ctx, e => {
    if (ctx.focus || stepCard) return
    e.stopPropagation()
    freeze()
    ctx.pick(d.id)
    if (state === 'full') faceEdit('body')
    else ctx.setNoting(d.id)
  })
  const shadow = '0 0.5px 1.5px rgba(0,0,0,0.75)'
  const nameEl = ctx.renaming === d.id
    ? <NameInput d={d} ctx={ctx} font={nameFont} />
    : header
      ? <span data-scene-name={d.id} {...nameClick} style={{ cursor: 'text', pointerEvents: 'auto' }}>{header}</span>
      : null
  // Small: a rectangle of its icon (set, or its own picture).
  const ic = iconOf(d, pic)
  // Small, its picture IS the bar (Brian 2026-11-09): flush to the box's
  // edges on three sides, the text beside it (a row, an icon with room
  // across) or under it (a standing strip, a tall icon).
  const across = state === 'row' || (state === 'icon' && box.w > box.h * 1.1)
  const bleed = !ic || (state !== 'row' && state !== 'stand' && state !== 'icon') ? null
    : across ? { w: Math.min(box.h * THUMB, box.w * (state === 'row' ? 0.45 : 0.5)), h: box.h + lift }
    : { w: box.w, h: Math.min(box.w / THUMB, (box.h + lift) * (state === 'stand' ? 0.45 : 0.6)) }
  const bleedEl = bleed && ic && <Thumb src={ic.src} crop={ic.crop} w={bleed.w} h={bleed.h} line={false} at={{ position: 'absolute', left: 0, top: 0 }} />

  // The parts tucked inside this heading: a small round picture each, or a
  // dot in its colour.
  const dots = (size: number, wrap: boolean) => inside && inside.length > 0 && (
    <div data-scene-inside style={{ display: 'flex', flexWrap: wrap ? 'wrap' : 'nowrap', justifyContent: 'center', gap: size * 0.3, maxWidth: '100%', overflow: 'hidden', flex: '0 1 auto', minWidth: 0 }}>
      {inside.slice(0, 24).map(l => ({ l, ic: iconOf(l, shownContent(l, ctx.groups.find(g => g.id === heldCard(l))).image ?? null) })).map(({ l, ic }) => (
        <div key={l.id} title={l.name} style={{
          flex: '0 0 auto', width: size * THUMB, height: size, borderRadius: Math.max(0.4, size * 0.2), background: l.color ?? '#5b8dd9', overflow: 'hidden', position: 'relative',
          border: `${Math.max(0.3, size * 0.1)}px solid rgba(255,255,255,0.8)`, boxSizing: 'border-box',
        }}>
          {ic && <Pic src={ic.src} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: `${ic.crop.x}% ${ic.crop.y}%`, transformOrigin: `${ic.crop.x}% ${ic.crop.y}%`, transform: `scale(${ic.crop.z})`, pointerEvents: 'none' }} />}
        </div>
      ))}
    </div>
  )

  // Move picture: drag the picture about inside the box, wheel zooms it.
  const onMoveDown = (e: React.PointerEvent) => {
    if (!moving || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }, c0 = { ...crop }
    useUndoCoordinator.getState().checkpoint()
    // A flipped picture is drawn mirrored about its crop spot, so a shift of
    // the spot moves it the other way on screen, and faster: turn it back
    // round and slow it to the speed an unflipped picture moves at, so it
    // follows the mouse the same either way.
    const img = divRef.current?.querySelector<HTMLImageElement>('img[data-scene-pic]')
    const mirrored = (flip: boolean | undefined, side: 'w' | 'h') => {
      if (!flip) return 1
      if (!img || !img.naturalWidth || !img.naturalHeight || !img.clientWidth || !img.clientHeight) return -1
      const fit = Math.max(img.clientWidth / img.naturalWidth, img.clientHeight / img.naturalHeight)
      const room = side === 'w' ? img.clientWidth : img.clientHeight
      const pic = c0.z * fit * (side === 'w' ? img.naturalWidth : img.naturalHeight)
      return -Math.max(0, pic - room) / (pic + room)
    }
    const kx = mirrored(d.hero?.flipH, 'w'), ky = mirrored(d.hero?.flipV, 'h')
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / ctx.s / Math.max(1, box.w) * 100 / c0.z * kx
      const dy = (ev.clientY - start.y) / ctx.s / Math.max(1, box.h) * 100 / c0.z * ky
      const r = ctx.root()
      if (r) useBoardsStore.getState().setGroupScene(ctx.sceneId, patchDiv(r, d.id, { crop: { ...c0, x: clamp(c0.x - dx, 0, 100), y: clamp(c0.y - dy, 0, 100) } }))
    }
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const onWheel = (e: React.WheelEvent) => {
    if (!moving) return
    e.stopPropagation()
    const r = ctx.root()
    if (r) useBoardsStore.getState().setGroupScene(ctx.sceneId, patchDiv(r, d.id, { crop: { ...crop, z: clamp(crop.z * (e.deltaY < 0 ? 1.08 : 1 / 1.08), 1, 6) } }))
  }
  const u = ctx.u
  const roomy = box.w > u * 3.2 + ctx.seamIn * 2 && box.h > u * 2.4 + ctx.seamIn * 2
  // A knob's place on the face (from a spot in this part), kept clear of
  // the outer edge bars and inside the card, so every knob can be reached:
  // a part against the card's edge, or bumped up out of its row, too.
  const band = edgeBand(ctx.s), off = edgeOff(ctx.s)
  // The card's own buttons in the face's top corners (picture, annotate
  // pen) are kept clear too.
  const corner = 22 / ctx.s
  const place = (l: number, t: number): React.CSSProperties => {
    const left = clamp(PAD + box.x + l, band, ctx.W - band - off - u)
    let top = clamp(PAD + box.y - lift + t, band, ctx.H - band - off - u)
    if (top < corner && (left < corner || left + u > ctx.W - corner)) top = corner
    return { left, top }
  }

  return (
    <div
      ref={divRef}
      data-scene-div={d.id}
      data-scene-state={state}
      data-link-drop={`division:${ctx.sceneId}:${d.id}`}
      {...click}
      onPointerDownCapture={onMoveDown}
      onWheel={onWheel}
      // Right-click: this division's own list (not the card's).
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); ctx.pick(d.id); ctx.openMenu(d.id, e.clientX, e.clientY) }}
      onPointerEnter={() => ctx.setHovered(d.id)}
      // Onto a seam or an edge bar (on the way to one of its knobs): it
      // stays pointed at, so its knobs stay put.
      onPointerLeave={e => { if (!overBar(e.relatedTarget)) ctx.setHovered(null) }}
      onDoubleClick={e => {
        e.stopPropagation()
        if (ctx.focus || moving || stepCard || flipped) return
        // Write in it as on a card: it gets a face of its own (its name the
        // header) and its header opens for typing, with the toolbar.
        giveFace()
        const el = e.currentTarget as HTMLElement
        requestAnimationFrame(() => el.querySelector('[data-card-text]')?.dispatchEvent(new CustomEvent('start-edit', { bubbles: false })))
      }}
      style={{
        position: 'absolute', left: box.x, top: box.y - lift, width: box.w, height: box.h + lift, zIndex: bump ? (hovered ? 16 : 13) : hovered ? 6 : picked ? 2 : 1,
        filter: faded ? 'grayscale(0.85) brightness(0.5)' : undefined, opacity: ctx.lifted?.has(d.id) ? 0.4 : faded ? 0.75 : 1,
        transition: ctx.dragging ? 'filter 0.18s, opacity 0.18s' : 'left 0.24s ease, top 0.24s ease, width 0.24s ease, height 0.24s ease, filter 0.18s, opacity 0.18s',
        cursor: moving ? 'move' : undefined,
      }}
    >
      {/* The box: its colour, its picture filling it. */}
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 2.2, overflow: 'hidden', background: d.color ?? '#5b8dd9',
        boxShadow: bump ? '0 1px 3px rgba(0,0,0,0.55)' : undefined,
        outline: moving ? '0.8px dashed #ffd666' : picked ? '0.8px solid #fff' : ctx.linking ? '0.6px dashed rgba(255,255,255,0.85)' : bump ? '0.5px solid rgba(255,255,255,0.55)' : undefined,
        outlineOffset: picked || ctx.linking || moving ? -0.8 : -0.5,
      }}>
        {pic && state === 'full' && (
          <Pic src={pic} alt="" draggable={false} data-scene-pic style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none',
            objectPosition: `${crop.x}% ${crop.y}%`, transformOrigin: `${crop.x}% ${crop.y}%`, opacity: hero?.opacity ?? 1,
            transform: `scale(${crop.z * (hero?.flipH ? -1 : 1)}, ${crop.z * (hero?.flipV ? -1 : 1)})`,
          }} />
        )}
        {bleedEl}
        {state === 'row' ? (
          // One row: round picture, the header, the text. A bare heading:
          // its name in the middle.
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: pic || text ? 'flex-start' : 'center', gap: 1.5,
            padding: `0 ${heads ? u * 1.1 : 2}px 0 ${bleed ? bleed.w + 2 : heads ? u * 1.1 : 2}px`, boxSizing: 'border-box', overflow: 'hidden', color: '#fff', textShadow: shadow, pointerEvents: 'none',
          }}>
            {nameEl && <span style={{ flex: '0 1 auto', fontSize: nameFont, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{nameEl}</span>}
            {text && <span style={{ flex: '1 1 0', fontSize: textFont * 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, opacity: 0.9 }}>{text}</span>}
            {dots(box.h * 0.42, false)}
          </div>
        ) : state === 'stand' ? (
          // A standing strip: round picture on top, its header on end.
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5,
            padding: `${bleed ? bleed.h + 1.5 : 2}px 0 2px`, boxSizing: 'border-box', overflow: 'hidden', color: '#fff', textShadow: shadow, pointerEvents: 'none',
          }}>
            {header && <span style={{
              writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontSize: nameFont, fontWeight: 700, whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis', minHeight: 0, flex: '1 1 0', textAlign: 'end',
            }}>{header}</span>}
          </div>
        ) : state === 'icon' ? (
          // An icon: its picture as a rectangle, its text beside it (under
          // it when the box stands tall).
          (() => {
            const side = across
            return (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', flexDirection: side ? 'row' : 'column', alignItems: 'center', justifyContent: 'center', gap: 1.5,
                padding: side ? `1.5px 1.5px 1.5px ${(bleed ? bleed.w : 0) + 2}px` : `${(bleed ? bleed.h : 0) + 1.5}px 1.5px 1.5px`,
                boxSizing: 'border-box', overflow: 'hidden', color: '#fff', textShadow: shadow, pointerEvents: 'none', textAlign: side ? 'left' : 'center',
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, maxWidth: '100%', gap: 0.5, overflow: 'hidden', flex: side ? '1 1 0' : '0 0 auto' }}>
                  {nameEl && <div style={{ flex: '0 0 auto', fontSize: nameFont, fontWeight: 700, lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameEl}</div>}
                  {text && (side
                    ? <div style={{ flex: '0 0 auto', fontSize: textFont * 0.9, lineHeight: 1.2, opacity: 0.9, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>{text}</div>
                    : <div style={{ flex: '0 0 auto', fontSize: textFont * 0.9, lineHeight: 1.2, opacity: 0.9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text.replace(/\s*\n\s*/g, ' · ')}</div>)}
                </div>
              </div>
            )
          })()
        ) : d.face && !stepCard ? (
          // Its own card face: drawn and edited as a card's is, with the
          // same toolbar (fonts, spacing, split...). Never the card's.
          <GroupCardText groupId={ctx.sceneId} heroImage={pic} onCropImage={() => { ctx.pick(d.id); ctx.setMoving(d.id) }} bind={{
            header, body: shown.notes, headerStyle: d.hstyle, bodyStyle: d.bstyle, split: d.split, hero: d.hero, pad: d.pad,
            scale: faceScale,
            setHeader: v => v !== header && ctx.patch(d.id, d.live && src ? { ...copyFrom(src, false), live: false, name: v } : { name: v }),
            setBody: v => v !== shown.notes && ctx.patch(d.id, d.live && src ? { ...copyFrom(src, false), live: false, notes: v } : { notes: v }),
            setHeaderStyle: st => ctx.patch(d.id, { hstyle: st }, true),
            setBodyStyle: st => ctx.patch(d.id, { bstyle: st }, true),
            setSplit: r => ctx.patch(d.id, { split: r }, false),
            setPad: pad => ctx.patch(d.id, { pad }, false),
            setHero: h => ctx.patch(d.id, { hero: h }, false),
          }} />
        ) : (
          // No face yet: its name, in the middle.
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: 2, boxSizing: 'border-box', color: '#fff', textAlign: 'center', overflow: 'hidden', pointerEvents: 'none', gap: 1,
          }}>
            {nameEl && <div style={{ fontSize: nameFont, fontWeight: 700, lineHeight: 1.1, textShadow: shadow, maxWidth: '100%', overflowWrap: 'anywhere' }}>{nameEl}</div>}
            {dots(clamp(Math.min(box.w, box.h) * 0.1, 2.5, 6), true)}
            {ctx.noting === d.id ? <NotesInput d={d} ctx={ctx} font={textFont} />
              : text ? <div data-scene-notes {...notesClick} style={{ fontSize: textFont, lineHeight: 1.25, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textShadow: shadow, maxWidth: '100%', opacity: 0.95, cursor: 'text', pointerEvents: 'auto' }}>{shown.notes}</div>
              : picked && !inside?.length && !stepCard && <div data-scene-notes-add {...notesClick} style={{ fontSize: textFont, opacity: 0.55, fontStyle: 'italic', cursor: 'text', pointerEvents: 'auto', textShadow: shadow }}>notes</div>}
          </div>
        )}
        {state === 'full' && d.face && inside && inside.length > 0 ? (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: Math.max(1, box.h * 0.08), display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 2 }}>
            {dots(clamp(Math.min(box.w, box.h) * 0.1, 2.5, 6), true)}
          </div>
        ) : null}
        {flipped && backCard && (
          // Turned over: the back of the card it shows, over its face.
          <div data-scene-back={backCard.id} style={{ position: 'absolute', inset: 0, zIndex: 2, background: backColor(d.color ?? '#5b8dd9') }}>
            <CardBack groupId={backCard.id} color={d.color ?? '#5b8dd9'} width={box.w} height={box.h} hovered={hovered}
              reserve={ctx.seamIn + u * 2.45} scale={faceScale} radius={2.2} />
          </div>
        )}
        {changed && (
          // The card it came from changed since: a small mark; a click
          // takes the new content (its look and crop stay).
          <button type="button" data-scene-refresh title="The card this came from changed: take its new header, text and picture" onPointerDown={stopPress}
            onClick={e => { e.stopPropagation(); useUndoCoordinator.getState().checkpoint(); refreshDivision(ctx.sceneId, d.id) }}
            style={{
              position: 'absolute', left: 1, top: 1, width: 5.5, height: 5.5, padding: 0, border: '0.4px solid #fff', borderRadius: '50%',
              background: 'rgba(255,214,102,0.95)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3,
            }}>
            <svg width="3.8" height="3.8" viewBox="0 0 8 8"><path d="M6.6 3.2A2.8 2.8 0 1 0 6.2 5.6" fill="none" stroke="#000" strokeWidth="1.2" /><path d="M7.4 0.8v2.8H4.6" fill="none" stroke="#000" strokeWidth="1.2" /></svg>
          </button>
        )}
        {d.deck && d.deck.length > 1 && (
          // A deck is in it: the edges of the cards behind its front, down
          // its right side, as a closed deck shows them.
          <div data-scene-deck-edges style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 2.2, pointerEvents: 'none', zIndex: 2, display: 'flex', gap: 0.5, justifyContent: 'flex-end' }}>
            <div style={{ width: 0.7, background: 'rgba(255,255,255,0.75)', margin: '6% 0', borderRadius: 0.4 }} />
            <div style={{ width: 0.7, background: 'rgba(255,255,255,0.9)', margin: '3% 0', borderRadius: 0.4 }} />
          </div>
        )}
        <div style={{ position: 'absolute', right: 1, bottom: 1, display: 'flex', gap: 1, zIndex: 3 }}>
          {src && hovered && (
            // Back to the card it came from: only while pointed at.
            <button type="button" data-scene-source title="Go to the card this came from" onPointerDown={stopPress}
              onClick={e => { e.stopPropagation(); goToCard(src.id) }}
              style={{
                width: 6, height: 6, padding: 0, border: '0.4px solid rgba(255,255,255,0.8)', borderRadius: 1.2, background: 'rgba(0,0,0,0.6)',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
              <svg width="4" height="4" viewBox="0 0 8 8"><path d="M3 1H1v6h6V5" fill="none" stroke="#fff" strokeWidth="1" /><path d="M4.5 0.8h2.7v2.7M7.2 0.8L3.6 4.4" fill="none" stroke="#fff" strokeWidth="1" /></svg>
            </button>
          )}
          {opened && (
            // It has its own scene card: lit; a click goes there.
            <button type="button" data-scene-opened title="Go to its scene card" onPointerDown={stopPress}
              onClick={e => { e.stopPropagation(); openDivision(ctx.sceneId, d.id) }}
              style={{
                width: 6, height: 6, padding: 0, border: '0.5px solid #fff', borderRadius: 1.2,
                background: 'rgba(255,214,102,0.95)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
              <OpenIcon size={4.4} color="#000" />
            </button>
          )}
        </div>
      </div>
      {/* Pointed at: what it gathers (Brian 2026-11-10). Its cast (a deck
          let go on it), then what its headings hand down (dashed), each a
          small picture; a click goes to that card. */}
      {hovered && !moving && !ctx.focus && (() => {
        const g = gathered(ctx.scene, d.id)
        // A heading: what it hands down. A division: more than its one card.
        if (g.own.length < (heads ? 1 : 2) && !g.handed.length) return null
        const th = Math.min(u * 1.15, box.h * 0.3)
        if (box.h < u * 2.2 || box.w < th * THUMB * 2) return null
        // Along its top, left of its colour and more knobs.
        const room = box.w - u * (canFlip ? 6.15 : 5) - ctx.seamIn * 2
        const all = [...g.own.map(c => ({ c, from: null as SceneDiv | null })), ...g.handed.flatMap(h => h.cards.map(c => ({ c, from: h.from })))]
        const fit = Math.max(1, Math.floor(room / (th * THUMB + th * 0.2)))
        const shown = all.length > fit ? all.slice(0, Math.max(1, fit - 1)) : all
        return (
          <div data-scene-cast style={{ position: 'absolute', left: ctx.seamIn + 0.6 + u * (canFlip ? 2.35 : 1.2), top: ctx.seamIn + 0.6, display: 'flex', gap: th * 0.2, alignItems: 'center', zIndex: 5 }}>
            {shown.map(({ c, from }) => {
              const card = ctx.groups.find(x => x.id === c)
              if (!card) return null
              const img = contentOf(card).image
              const name = cardTitle(ctx.groups, card)
              return (
                <button key={c} type="button" data-scene-cast-card={c} data-handed={from ? '' : undefined}
                  title={from ? `${name}: handed down from ${from.name || 'its heading'}` : name}
                  onPointerDown={stopPress} onDoubleClick={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); goToCard(c) }}
                  style={{
                    flex: '0 0 auto', width: th * THUMB, height: th, padding: 0, borderRadius: th * 0.14, overflow: 'hidden', position: 'relative', cursor: 'pointer',
                    background: card.color ?? '#5b8dd9', boxSizing: 'border-box', boxShadow: '0 0.5px 1.5px rgba(0,0,0,0.5)',
                    border: `${Math.max(0.35, th * 0.07)}px ${from ? 'dashed' : 'solid'} rgba(255,255,255,0.95)`,
                    color: '#fff', fontSize: th * 0.5, fontWeight: 700, lineHeight: 1, fontFamily: 'inherit',
                  }}>
                  {img ? <Pic src={img} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} />
                    : name.trim().slice(0, 1).toUpperCase()}
                </button>
              )
            })}
            {shown.length < all.length && <span style={{ fontSize: th * 0.55, fontWeight: 700, color: '#fff', textShadow: '0 0.5px 1.5px rgba(0,0,0,0.8)' }}>+{all.length - shown.length}</span>}
          </div>
        )
      })()}
      {/* A deck in it, pointed at: step through its cards, left and right
          (Brian 2026-11-10), with which one shows. Tilted, a 3D set's front
          shows the set; a model card stepped to, its model. */}
      {hovered && !moving && !ctx.focus && deckN > 1 && box.h >= u * 2.2 && box.w >= u * 4.2 && (
        <div data-scene-deck-step style={{ position: 'absolute', left: ctx.seamIn + 0.6, bottom: ctx.seamIn + 0.6, display: 'flex', alignItems: 'center', gap: u * 0.25, zIndex: 5 }}>
          {([-1, 1] as const).map(dir => (
            <button key={dir} type="button" data-scene-deck-arrow={dir < 0 ? 'left' : 'right'}
              title={dir < 0 ? 'The card before, in its deck' : 'The next card in its deck'}
              onPointerDown={stopPress} onDoubleClick={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); ctx.patch(d.id, { at: (at + dir + deckN) % deckN || undefined }, false) }}
              style={{
                order: dir < 0 ? 0 : 2, flex: '0 0 auto', width: u, height: u, padding: 0, borderRadius: '50%', cursor: 'pointer', boxSizing: 'border-box',
                display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(14,16,24,0.82)', color: '#fff',
                border: `${u * 0.08}px solid rgba(255,255,255,0.75)`, boxShadow: `0 ${u * 0.08}px ${u * 0.25}px rgba(0,0,0,0.45)`,
              }}>
              <Glyph ctx={ctx} d={dir < 0 ? 'M6.2 2L3.2 5l3 3' : 'M3.8 2l3 3-3 3'} />
            </button>
          ))}
          <span data-scene-deck-count style={{ order: 1, fontSize: u * 0.6, fontWeight: 700, color: '#fff', textShadow: '0 0.5px 1.5px rgba(0,0,0,0.85)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{at + 1} / {deckN}</span>
        </div>
      )}
      {ctx.layer && (() => {
      // Where each knob goes. "More" first, top right; its colour just left
      // of it; the rest never on top of one already placed (a short or
      // narrow part, or one against the card's edge): moved down past it.
      const at: Record<string, { left: number; top: number }> = {}
      const put = (k: string, p: React.CSSProperties) => {
        let l = p.left as number, t = p.top as number
        for (let n = 0; n < 4; n++) {
          const hit = Object.values(at).find(o => Math.abs(o.left - l) < u * 1.05 && Math.abs(o.top - t) < u * 1.05)
          if (!hit) break
          t = hit.top + u * 1.15
        }
        at[k] = { left: l, top: t }
      }
      put('more', place(Math.max(0, box.w - u * 1.1), ctx.seamIn))
      if (box.w > u * 2.4) at.color = { left: at.more.left - u * 1.15, top: at.more.top }
      if (box.w > u * 3.6) at.clear = { left: at.more.left - u * 2.3, top: at.more.top }
      put('move', place(ctx.seamIn, ctx.seamIn))
      // Flip: beside the grip, where a card's own Flip is (its top left).
      if (canFlip) put('flip', place(ctx.seamIn + u * 1.15, ctx.seamIn))
      if (heads) put('fold', box.w < STAND_W ? place((box.w - u) / 2, Math.min(1, box.h - u)) : place(Math.min(1, box.w - u), (box.h + lift - u) / 2))
      put('split-row', place(box.w - u - ctx.seamIn - u * 0.2, (box.h + lift - u) / 2))
      put('split-col', place((box.w - u) / 2, box.h + lift - u - ctx.seamIn - u * 0.2))
      return ReactDOM.createPortal(<>
      {/* A section's heading: fold the section to this strip, and back.
          Shown while pointed at, and always while folded (lit). */}
      {heads && (hovered || folded) && (
        <Knob ctx={ctx} tool="fold" lit={folded} title={folded ? 'Open this section' : 'Fold this section to one strip'}
          at={at.fold}
          onClick={() => ctx.patch(sectionId(ctx, d.id)!, { fold: !folded })}>
          <Glyph ctx={ctx} d={FOLD} />
        </Knob>
      )}
      {/* Pointed at: divide it (a "+" on its right edge and its bottom
          edge), its colour, and more. */}
      {hovered && !moving && (<>
        {roomy && (<>
          <Knob ctx={ctx} tool="split-row" title="Divide it side by side" at={at['split-row']}
            onClick={() => { const r = ctx.root(); if (r) ctx.write(splitDiv(r, d.id, 'row')) }}>
            <Glyph ctx={ctx} d={PLUS} />
          </Knob>
          <Knob ctx={ctx} tool="split-col" title="Divide it top and bottom" at={at['split-col']}
            onClick={() => { const r = ctx.root(); if (r) ctx.write(splitDiv(r, d.id, 'col')) }}>
            <Glyph ctx={ctx} d={PLUS} />
          </Knob>
        </>)}
        {at.color && (
          <Knob ctx={ctx} tool="color" title="Colour" bg={d.color ?? '#5b8dd9'} at={at.color}
            onClick={e => ctx.openPicker(d.id, e.clientX, e.clientY)} />
        )}
        <Knob ctx={ctx} tool="move" title={heads ? 'Drag: move this whole section somewhere else on the card' : 'Drag: move this section somewhere else on the card'}
          at={at.move} onDown={e => ctx.startMove(d.id, e)} onClick={() => {}}>
          <Glyph ctx={ctx} d={GRIP} />
        </Knob>
        {at.flip && (
          <Knob ctx={ctx} tool="flip" lit={flipped} title="Flip this section's card over" at={at.flip}
            onClick={() => ctx.patch(d.id, { flip: !d.flip || undefined })}>
            <svg width={u * 0.62} height={u * 0.62} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="5.5" width="6.5" height="8.5" rx="1" />
              <path d="M10.5 13.5 h2 a1 1 0 0 0 1 -1 v-6" strokeDasharray="1.6 1.6" />
              <path d="M4.5 3.2 C6.5 0.8 11 1.2 12.6 4.3" />
              <path d="M12.9 1.9 L12.7 4.5 L10.2 4.1" />
            </svg>
          </Knob>
        )}
        {at.clear && (
          <Knob ctx={ctx} tool="clear" title="Clear this section: what was put in it goes (undo brings it back)" at={at.clear}
            onClick={() => { const r = ctx.root(); if (r) ctx.write(clearDiv(r, d.id)) }}>
            <Glyph ctx={ctx} d={CLEAR} />
          </Knob>
        )}
        <Knob ctx={ctx} tool="more" title="More" at={at.more}
          onClick={e => ctx.openMenu(d.id, e.clientX, e.clientY)}>
          <Glyph ctx={ctx} d={MORE} />
        </Knob>
      </>)}
      </>, ctx.layer)
      })()}
    </div>
  )
}

/** A seam or an outer edge bar: passing over one keeps the part last
 *  pointed at (and its knobs) as it is. */
const overBar = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-scene-seam],[data-scene-edge],[data-scene-knobs]')
/** Off a seam or edge bar onto neither a part nor a knob: nothing pointed at. */
const offBar = (ctx: Ctx, t: EventTarget | null) => {
  if (!(t instanceof Element) || !t.closest('[data-scene-div],[data-scene-knobs],[data-scene-seam],[data-scene-edge]')) ctx.setHovered(null)
}

const sectionId = (ctx: Ctx, leafId: string) => { const r = ctx.root(); return r ? sectionOf(r, leafId)?.id : undefined }

/** Over to a card and select it (a card in a closed deck: its deck front). */
function goToCard(id: string) {
  useCanvasStore.getState().jumpToGroup(id)
  useBoardsStore.getState().setSelectedGroup(id)
}

const OpenIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg width={size} height={size} viewBox="0 0 8 8"><rect x="0.5" y="2.5" width="5" height="5" fill="none" stroke={color} strokeWidth="1" /><path d="M4 0.5h3.5V4M7.5 0.5L3.5 4.5" fill="none" stroke={color} strokeWidth="1" /></svg>
)

/** The line between two parts of a split: drag it to share the space
 *  between them differently. */
/** A seam's grab width (layout units): at least 9 screen px, so the edge
 *  is easy to find. */
const seamReach = (s: number) => Math.max(GAP + 1.6, 9 / s)

const Seam: React.FC<{ split: SceneDiv; i: number; box: Box; unit: number; ctx: Ctx }> = ({ split, i, box, unit, ctx }) => {
  const row = split.dir === 'row'
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    // A pointer move in flat screen px, divided by the face's scale, is a
    // move in layout units; a share is worth `unit` of them.
    const sizes = split.sizes ?? split.kids!.map(() => 1 / split.kids!.length)
    const a0 = sizes[i], b0 = sizes[i + 1]
    const start = row ? e.clientX : e.clientY
    useUndoCoordinator.getState().checkpoint()
    ctx.setDragging(true)
    // Neither side is squeezed past what it holds: it stops where the
    // part would have to tuck its contents in (or where it is now, if it
    // is already smaller than that).
    const MIN = 0.02
    const need = (k: SceneDiv, now: number) => {
      const n = needOf(k, GAP)
      return Math.max(MIN, Math.min(now, (row ? n.w : n.h) / Math.max(1, unit)))
    }
    const minA = need(split.kids![i], a0), minB = need(split.kids![i + 1], b0)
    const onMove = (ev: PointerEvent) => {
      const d = ((row ? ev.clientX : ev.clientY) - start) / ctx.s / Math.max(1, unit)
      const a = Math.max(minA, Math.min(a0 + b0 - minB, a0 + d))
      const r = ctx.root()
      if (r) useBoardsStore.getState().setGroupScene(ctx.sceneId, resizeSplit(r, split.id, i, a, a0 + b0 - a))
    }
    const onUp = () => { ctx.setDragging(false); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const reach = seamReach(ctx.s)
  const [over, setOver] = useState(false)
  // Its knobs are drawn on the face's knob layer (above every part, seam
  // and edge bar): from a spot on the seam to a spot on the face.
  const sx = PAD + (row ? box.x + box.w - (reach - GAP) / 2 : box.x), sy = PAD + (row ? box.y : box.y + box.h - (reach - GAP) / 2)
  const on = (a: { left: number; top: number }) => ({ left: sx + a.left, top: sy + a.top })
  return (
    <div
      data-scene-seam={`${split.id}:${i}`}
      onPointerDown={onDown}
      onPointerEnter={() => setOver(true)}
      onPointerLeave={e => { setOver(false); offBar(ctx, e.relatedTarget) }}
      onDoubleClick={e => e.stopPropagation()}
      style={{
        // Over every part, bumped ones too: an edge is always grabbable.
        position: 'absolute', zIndex: 20, cursor: row ? 'col-resize' : 'row-resize', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: row ? 'row' : 'column',
        ...(row
          ? { left: box.x + box.w - (reach - GAP) / 2, top: box.y, width: reach, height: box.h }
          : { left: box.x, top: box.y + box.h - (reach - GAP) / 2, width: box.w, height: reach }),
      }}
    >
      {(over || ctx.dragging) && <div style={{ flex: '0 0 auto', background: 'rgba(255,255,255,0.7)', borderRadius: 1, pointerEvents: 'none', ...(row ? { width: 2 / ctx.s, height: '100%' } : { height: 2 / ctx.s, width: '100%' }) }} />}
      {/* Pointed at: make the two parts one (in its middle), or break the
          line where another meets it (a T), so each half moves alone. */}
      {ctx.layer && ReactDOM.createPortal(<>
      {over && !ctx.dragging && canMerge(split, i) && (
        <Knob ctx={ctx} tool="merge" title="Make these two one"
          at={on(row ? { left: (reach - ctx.u) / 2, top: (box.h - ctx.u) / 2 } : { left: (box.w - ctx.u) / 2, top: (reach - ctx.u) / 2 })}
          onClick={() => { const r = ctx.root(); if (r) ctx.write(mergeParts(r, split.id, i)) }}>
          <Glyph ctx={ctx} d={row ? 'M1 5h3M2.6 3.4L4 5 2.6 6.6M9 5H6M7.4 3.4L6 5l1.4 1.6' : 'M5 1v3M3.4 2.6L5 4l1.6-1.4M5 9V6M3.4 7.4L5 6l1.6 1.4'} />
        </Knob>
      )}
      {over && !ctx.dragging && edgeBreaks(split, i).map(({ cut, j }) => {
        const side = split.kids![cut === 'a' ? i : i + 1]
        const kb = ctx.boxes.get(side.kids![j].id)
        if (!kb) return null
        const at = row
          ? { left: (reach - ctx.u) / 2, top: kb.y + kb.h + GAP / 2 - box.y - ctx.u / 2 }
          : { left: kb.x + kb.w + GAP / 2 - box.x - ctx.u / 2, top: (reach - ctx.u) / 2 }
        return (
          <Knob key={`${cut}${j}`} ctx={ctx} tool="break-edge" title="Break this line here: each half moves on its own" at={on(at)}
            onClick={() => { const r = ctx.root(); if (r) ctx.write(breakEdge(r, split.id, i, cut, j)) }}>
            <Glyph ctx={ctx} d={row ? 'M5 1v2.6M5 6.4V9M2.6 5h4.8' : 'M1 5h2.6M6.4 5H9M5 2.6v4.8'} />
          </Knob>
        )
      })}
      </>, ctx.layer)}
    </div>
  )
}

/** Along an outer edge of the face: pointed at, a "+" bar; a click adds a
 *  strip there as wide (or tall) as the whole face (Brian 2026-11-09). */
const EdgeStrip: React.FC<{ side: 'top' | 'bottom' | 'left' | 'right'; W: number; H: number; ctx: Ctx; onAdd: () => void }> = ({ side, W, H, ctx, onAdd }) => {
  const [over, setOver] = useState(false)
  const band = edgeBand(ctx.s)
  const across = side === 'top' || side === 'bottom'
  // The card's own resize bars own the outer few pixels of the bottom and
  // right edges, so those strips sit just inside them.
  const off = side === 'bottom' || side === 'right' ? edgeOff(ctx.s) : 0
  const at: React.CSSProperties = across
    ? { left: band, width: W - band * 2, height: band, ...(side === 'top' ? { top: 0 } : { top: H - band - off }) }
    : { top: band, height: H - band * 2, width: band, ...(side === 'left' ? { left: 0 } : { left: W - band - off }) }
  return (
    <div
      data-scene-edge={side}
      title={across ? 'Add a row across the whole card here' : 'Add a column down the whole card here'}
      onPointerEnter={() => setOver(true)}
      onPointerLeave={e => { setOver(false); offBar(ctx, e.relatedTarget) }}
      onPointerDown={stopPress}
      onDoubleClick={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); if (!ctx.dragging) onAdd() }}
      style={{ position: 'absolute', zIndex: 21, cursor: 'copy', display: 'flex', alignItems: 'center', justifyContent: 'center', ...at }}
    >
      {over && !ctx.dragging && (<>
        <div style={{ position: 'absolute', inset: across ? `${band * 0.3}px 0` : `0 ${band * 0.3}px`, borderRadius: band, background: 'rgba(255,214,102,0.35)', border: `${0.6 / ctx.s * 1.5}px dashed rgba(255,214,102,0.95)`, pointerEvents: 'none' }} />
        <div style={{
          position: 'relative', width: ctx.u, height: ctx.u, borderRadius: '50%', background: '#ffd666', color: '#111', display: 'flex',
          alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', boxShadow: `0 ${ctx.u * 0.08}px ${ctx.u * 0.25}px rgba(0,0,0,0.45)`,
        }}><Glyph ctx={ctx} d={PLUS} /></div>
      </>)}
    </div>
  )
}

/** A division's "more": a small list by it, each line a switch (lit while
 *  on) or an action. Closes on a pick, a press elsewhere or Esc. */
/** Set a division's icon (Brian 2026-11-09): the picture it shows when
 *  small, framed by dragging (pan) and the wheel (zoom); any picture can be
 *  chosen for it. Every change shows at once on the card. */
const IconEditor: React.FC<{
  x: number; y: number; src: string | null; icon: SceneDiv['icon']; own: boolean
  onChange: (icon: SceneDiv['icon']) => void; onClose: () => void
}> = ({ x, y, src, icon, own, onChange, onClose }) => {
  const ref = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const c = icon ?? { x: 50, y: 50, z: 1 }
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter') onClose() }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey) }
  }, [onClose])
  const FW = 168, FH = FW / THUMB
  const onPan = (e: React.PointerEvent) => {
    if (e.button !== 0 || !src) return
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }, c0 = { ...c }
    const move = (ev: PointerEvent) => onChange({
      ...icon, x: clamp(c0.x - (ev.clientX - start.x) / FW * 100 / c0.z, 0, 100), y: clamp(c0.y - (ev.clientY - start.y) / FH * 100 / c0.z, 0, 100), z: c0.z,
    })
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const btn = (label: string, tool: string, act: () => void) => (
    <button type="button" data-scene-icon-tool={tool} onClick={act} style={{
      height: 22, padding: '0 8px', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 5, cursor: 'pointer',
      background: 'rgba(255,255,255,0.06)', color: '#e6e9ef', fontSize: 11, fontFamily: 'inherit', whiteSpace: 'nowrap',
    }}>{label}</button>
  )
  return (
    <div ref={ref} data-scene-icon-editor onPointerDown={e => e.stopPropagation()} style={{
      position: 'fixed', left: Math.min(x + 6, window.innerWidth - FW - 30), top: Math.min(y + 6, window.innerHeight - FH - 110), zIndex: 10000,
      padding: 8, borderRadius: 8, background: 'rgba(18,20,28,0.97)', border: '1px solid rgba(255,255,255,0.14)', boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
      display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'inherit', color: '#e6e9ef', fontSize: 11,
    }}>
      <div>Icon <span style={{ opacity: 0.55 }}>drag to frame, wheel to zoom</span></div>
      <div data-scene-icon-frame onPointerDown={onPan}
        onWheel={e => { if (!src) return; e.stopPropagation(); onChange({ ...icon, x: c.x, y: c.y, z: clamp(c.z * (e.deltaY < 0 ? 1.08 : 1 / 1.08), 1, 6) }) }}
        style={{ width: FW, height: FH, borderRadius: 8, overflow: 'hidden', position: 'relative', background: '#2a2d38', cursor: src ? 'move' : 'default' }}>
        {src
          ? <Pic src={src} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: `${c.x}% ${c.y}%`, transformOrigin: `${c.x}% ${c.y}%`, transform: `scale(${c.z})`, pointerEvents: 'none' }} />
          : <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.5 }}>No picture yet</div>}
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {btn('Choose picture…', 'choose', () => fileRef.current?.click())}
        {icon?.image && own && btn('Use its own picture', 'own', () => onChange({ x: 50, y: 50, z: 1 }))}
        {icon && btn('Clear', 'clear', () => onChange(undefined))}
      </div>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => {
        const f = e.target.files?.[0]
        if (!f) return
        const rd = new FileReader()
        rd.onload = () => onChange({ image: String(rd.result), x: 50, y: 50, z: 1 })
        rd.readAsDataURL(f)
        e.target.value = ''
      }} />
    </div>
  )
}

/** The scene's view modes, from a "⋯" in its card's header bar (Brian
 *  2026-11-09: not floating over the face). Lit while a mode is on; the
 *  list opens under it. */
export const SceneViewButton: React.FC<{ groupId: string; size: number }> = ({ groupId, size }) => {
  const view = useBoardsStore(st => st.groups.find(g => g.id === groupId)?.sceneView) ?? {}
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const setView = (patch: Partial<SceneView>, step = true) => {
    if (step) useUndoCoordinator.getState().checkpoint()
    const g = useBoardsStore.getState().groups.find(gr => gr.id === groupId)
    useBoardsStore.getState().setGroupSceneView(groupId, { ...(g?.sceneView ?? {}), ...patch })
  }
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || (t as HTMLElement).closest?.('[data-scene-view-button]')) return
      setOpen(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey) }
  }, [open])
  const anyMode = !!view.focus || !!view.trace
  const row = (tool: string, on: boolean, label: string, title: string, act: () => void) => (
    <button type="button" data-scene-tool={tool} title={title} onClick={act} style={{
      display: 'flex', alignItems: 'center', gap: 7, height: 22, padding: '0 8px', border: 'none', borderRadius: 5, cursor: 'pointer',
      background: 'transparent', color: '#e6e9ef', fontSize: 11.5, textAlign: 'left', fontFamily: 'inherit',
    }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto', background: on ? '#ffd666' : 'transparent', border: '1px solid rgba(255,255,255,0.4)' }} />
      {label}
    </button>
  )
  return (
    <>
      <div
        data-scene-view-button
        title="View: Focus, Bump-outs, Trace"
        onPointerDown={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
        onClick={e => {
          e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          setOpen(open ? null : { x: r.right, y: r.bottom })
        }}
        style={{
          flex: '0 0 auto', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: Math.max(1, size * 0.18), cursor: 'pointer',
          background: anyMode ? 'rgba(255,214,102,0.3)' : 'transparent', color: anyMode ? '#ffd666' : 'rgba(255,255,255,0.55)',
        }}
      >
        <svg width={size * 0.8} height={size * 0.8} viewBox="0 0 16 16" fill="currentColor">
          <circle cx="3.5" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="12.5" cy="8" r="1.5" />
        </svg>
      </div>
      {open && ReactDOM.createPortal(
        <div ref={ref} data-scene-modes onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()} style={{
          position: 'fixed', left: Math.max(4, Math.min(open.x - 190, window.innerWidth - 200)), top: Math.min(open.y + 4, window.innerHeight - 150), zIndex: 10000,
          width: 190, padding: 4, borderRadius: 8, background: 'rgba(18,20,28,0.96)', border: '1px solid rgba(255,255,255,0.14)',
          boxShadow: '0 6px 20px rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', gap: 1, fontFamily: 'inherit',
        }}>
          {row('view-focus', !!view.focus, 'Focus', 'Click divisions to light them (a section\'s heading lights the section); the rest fade', () => setView({ focus: !view.focus }))}
          {view.focus && (view.picked?.length ?? 0) > 0 && row('view-focus-clear', false, 'Light every division again', 'Clear the lit divisions', () => setView({ picked: [] }))}
          {row('view-bumps', view.bumps !== false, 'Bump-outs', 'Divisions marked to bump out stand taller', () => setView({ bumps: view.bumps === false }))}
          {row('view-trace', !!view.trace, 'Trace', 'Only divisions whose card or text matches stay lit', () => setView({ trace: !view.trace }))}
          {view.trace && (
            <input
              data-scene-trace
              autoFocus
              value={view.traceText ?? ''}
              placeholder="prop, Budget: high…"
              onChange={e => setView({ traceText: e.target.value }, false)}
              onKeyDown={e => e.stopPropagation()}
              style={{
                margin: '2px 6px 4px', height: 22, boxSizing: 'border-box', padding: '0 8px', fontSize: 11, color: '#fff', fontFamily: 'inherit',
                background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 6, outline: 'none', userSelect: 'text',
              }}
            />
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

const MoreMenu: React.FC<{
  x: number; y: number; onClose: () => void
  items: { label: string; tool: string; lit?: boolean; danger?: boolean; hover?: (on: boolean) => void; act: () => void }[]
}> = ({ x, y, onClose, items }) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey) }
  }, [onClose])
  const left = Math.min(x + 6, window.innerWidth - 190)
  const top = Math.min(y + 6, window.innerHeight - items.length * 24 - 12)
  return (
    <div ref={ref} data-scene-more onPointerDown={e => e.stopPropagation()} style={{
      position: 'fixed', left, top, zIndex: 10000, minWidth: 170, padding: 4, borderRadius: 8,
      background: 'rgba(18,20,28,0.96)', border: '1px solid rgba(255,255,255,0.14)', boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
      display: 'flex', flexDirection: 'column', gap: 1, fontFamily: 'inherit',
    }}>
      {items.map(it => (
        <button key={it.tool} type="button" data-scene-tool={it.tool}
          onClick={() => { it.hover?.(false); it.act(); onClose() }}
          style={{
            display: 'flex', alignItems: 'center', gap: 7, height: 22, padding: '0 8px', border: 'none', borderRadius: 5, cursor: 'pointer',
            background: 'transparent', color: it.danger ? '#ff8a80' : '#e6e9ef', fontSize: 11.5, textAlign: 'left', fontFamily: 'inherit',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; it.hover?.(true) }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; it.hover?.(false) }}
        >
          <span style={{
            width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto',
            background: it.lit ? '#ffd666' : 'transparent', border: it.lit === undefined ? 'none' : '1px solid rgba(255,255,255,0.4)',
          }} />
          {it.label}
        </button>
      ))}
    </div>
  )
}

export const SceneFace: React.FC<{
  group: ProjectGroup; width: number; height: number
  /** Kept for the card's call; the face runs to the top (its buttons show
   *  over the first division on hover). */
  reserve?: number
}> = ({ group, width, height }) => {
  const groups = useBoardsStore(s => s.groups)
  const linking = useLinkDragStore(s => s.active && s.source?.kind === 'group' && s.source.id !== group.id)
  const zoom = useCanvasStore(st => st.zoom) || 1
  const [picked, setPicked] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [noting, setNoting] = useState<string | null>(null)
  const [hoveredDiv, setHoveredDiv] = useState<string | null>(null)
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  // A part being dragged to a new place: what moves, and where it would
  // land (beside which division, on which side, or swapped with it).
  const [drag, setDrag] = useState<{ id: string; own: Set<string>; target?: string; where?: 'left' | 'right' | 'top' | 'bottom' | 'swap' } | null>(null)
  const [picker, setPicker] = useState<{ id: string; x: number; y: number } | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [iconEdit, setIconEdit] = useState<{ id: string; x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const scene = group.scene
  const view: SceneView = group.sceneView ?? {}

  // Divisions holding a card from before faces were copied: copy now.
  useEffect(() => {
    if (!scene) return
    const next = migrateScene(scene)
    if (next) useBoardsStore.getState().setGroupScene(group.id, next)
  }, [scene, group.id])
  useEffect(() => { if (!picked) setMoving(null) }, [picked])

  // A press anywhere off this face (or Esc) lets the picked division go.
  useEffect(() => {
    if (!picked) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (rootRef.current && t && rootRef.current.contains(t)) return
      if ((t as HTMLElement | null)?.closest?.('[data-color-picker], [data-scene-more], [data-scene-icon-editor], [data-text-format-toolbar]')) return
      setPicked(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPicked(null) }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey) }
  }, [picked])

  const lit = useMemo(() => {
    if (!scene) return null
    const sets: Set<string>[] = []
    if (view.focus) { const l = litDivisions(scene, view.picked ?? []); if (l) sets.push(l) }
    if (view.trace && (view.traceText ?? '').trim()) {
      const hits = leaves(scene).filter(d => {
        const c = heldCard(d)
        return traceMatch(d, c ? groups.find(g => g.id === c) : undefined, groups, view.traceText ?? '')
      }).map(d => d.id)
      sets.push(litDivisions(scene, hits) ?? new Set())
    }
    if (!sets.length) return null
    // Both on: lit by both.
    return sets.reduce((a, b) => new Set([...a].filter(x => b.has(x))))
  }, [scene, view.focus, view.picked, view.trace, view.traceText, groups])

  if (!scene) return null
  // Organic sizing: text and controls grow slower than the card, so a
  // smaller card has less room in layout units and its divisions step down
  // through face -> icon -> row -> strip instead of just shrinking.
  // By the card's own size on the canvas, never the view's zoom: zooming
  // never changes the layout.
  // (Held where it was when the card was grown by adding space: fitK.)
  const { s, W, H, iw, ih } = faceLayout(width, height, zoom, view.fitK)
  const tucked = new Set<string>()
  const boxes = divBoxes(scene, iw, ih, GAP, tucked)
  const root = () => useBoardsStore.getState().groups.find(g => g.id === group.id)?.scene
  const setView = (patch: Partial<SceneView>) => {
    useUndoCoordinator.getState().checkpoint()
    const g = useBoardsStore.getState().groups.find(gr => gr.id === group.id)
    useBoardsStore.getState().setGroupSceneView(group.id, { ...(g?.sceneView ?? {}), ...patch })
  }
  const ctx: Ctx = {
    layer, W, H, scene, lifted: drag?.own ?? null,
    startMove: (leafId, e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()
      const r0 = root()
      const id = r0 ? movedBy(r0, leafId) : null
      const node = r0 && id ? findDiv(r0, id) : null
      if (!r0 || !id || !node) return
      const own = new Set(leaves(node).map(l => l.id))
      let cur: { target: string; where: 'left' | 'right' | 'top' | 'bottom' | 'swap' } | null = null
      setDragging(true)
      setDrag({ id, own })
      document.body.style.cursor = 'grabbing'
      const onMove = (ev: PointerEvent) => {
        // The division under the pointer on this face, not one being moved.
        const el = document.elementsFromPoint(ev.clientX, ev.clientY)
          .map(x => (x as HTMLElement).closest?.('[data-scene-div]') as HTMLElement | null)
          .find(x => x && (x.closest('[data-scene-face]') as HTMLElement | null)?.dataset.sceneFace === group.id)
        const tid = el?.dataset.sceneDiv
        if (!el || !tid || own.has(tid)) { if (cur) { cur = null; setDrag({ id, own }) } return }
        // Its middle: the two change places. Else the side nearest.
        const r = el.getBoundingClientRect()
        const fx = (ev.clientX - r.left) / Math.max(1, r.width), fy = (ev.clientY - r.top) / Math.max(1, r.height)
        const sides = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]] as const
        const where = Math.abs(fx - 0.5) < 0.2 && Math.abs(fy - 0.5) < 0.2 ? 'swap' : [...sides].sort((a, b) => a[1] - b[1])[0][0]
        if (cur?.target === tid && cur.where === where) return
        cur = { target: tid, where }
        setDrag({ id, own, ...cur })
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        setDragging(false)
        setDrag(null)
        const r = root()
        if (r && cur) { useUndoCoordinator.getState().checkpoint(); useBoardsStore.getState().setGroupScene(group.id, moveDiv(r, id, cur.target, cur.where)) }
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    sceneId: group.id, s, u: TOOL_PX / s, seamIn: (seamReach(s) - GAP) / 2, boxes, groups, linking, renaming, setRenaming, noting, setNoting,
    picked, pick: id => { setPicked(id); if (id !== moving) setMoving(null) }, lit, hovered: hoveredDiv, setHovered: setHoveredDiv,
    moving, setMoving, dragging, setDragging,
    openMenu: (id, x, y) => setMenu({ id, x, y }),
    openPicker: (id, x, y) => setPicker({ id, x, y }),
    patch: (id, p, step = true) => {
      const r = root()
      if (!r) return
      if (step) useUndoCoordinator.getState().checkpoint()
      useBoardsStore.getState().setGroupScene(group.id, patchDiv(r, id, p))
    },
    bumps: view.bumps !== false, focus: !!view.focus,
    toggleFocus: id => {
      const cur = view.picked ?? []
      setView({ picked: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] })
    },
    where: () => {
      const g = useBoardsStore.getState().groups.find(gr => gr.id === group.id)
      return { x: g?.originX ?? 0, y: g?.originY ?? 0 }
    },
    root,
    write: next => { useUndoCoordinator.getState().checkpoint(); useBoardsStore.getState().setGroupScene(group.id, next) },
  }

  // Leaves and seams, laid out absolutely from the tree. A folded section
  // shows its heading only; no seam touches a folded part.
  const parts: React.ReactNode[] = []
  const walk = (d: SceneDiv) => {
    const b = boxes.get(d.id)
    if (!b) return
    if (isLeaf(d)) {
      const sec = sectionOf(scene, d.id)
      // A tucked section's heading carries a dot for each part inside.
      const inside = sec && (tucked.has(sec.id) || sec.fold) ? leaves(sec).filter(l => l.id !== d.id) : undefined
      parts.push(<Division key={d.id} d={d} box={b} ctx={ctx} heads={!!sec} folded={!!sec?.fold} inside={inside} />)
      return
    }
    if ((d.fold && canFold(d)) || tucked.has(d.id)) { walk(d.kids![0]); return }
    const n = d.kids!.length
    const unit = shareUnits(d, b, GAP)
    d.kids!.forEach((k, i) => {
      walk(k)
      const next = d.kids![i + 1]
      if (next && !(k.fold && canFold(k)) && !(next.fold && canFold(next)) && boxes.get(k.id)) {
        parts.push(<Seam key={`${d.id}:${i}`} split={d} i={i} box={boxes.get(k.id)!} unit={unit} ctx={ctx} />)
      }
    })
    void n
  }
  walk(scene)

  const canRemove = leaves(scene).length > 1
  const edit = (fn: (r: SceneDiv) => SceneDiv) => { const r = root(); if (r) ctx.write(fn(r)) }
  const pickedColor = picker ? leaves(scene).find(l => l.id === picker.id)?.color ?? '#5b8dd9' : '#5b8dd9'

  // The "more" list for a division.
  const menuDiv = menu ? findDiv(scene, menu.id) : null
  const menuItems = menuDiv && isLeaf(menuDiv) ? (() => {
    const d = menuDiv
    const sec = sectionOf(scene, d.id)
    const items: { label: string; tool: string; lit?: boolean; danger?: boolean; hover?: (on: boolean) => void; act: () => void }[] = [
      { label: 'Bump out (stand taller)', tool: 'bump', lit: !!d.bump, act: () => edit(r => patchDiv(r, d.id, { bump: !d.bump })) },
      { label: 'Open as its own scene card', tool: 'open', lit: !!d.opens && groups.some(g => g.id === d.opens), act: () => openDivision(group.id, d.id) },
    ]
    items.push({ label: 'Set icon…', tool: 'icon', lit: !!d.icon, act: () => { useUndoCoordinator.getState().checkpoint(); setIconEdit({ id: d.id, x: menu!.x, y: menu!.y }) } })
    if (sec) items.push({ label: 'Fold this section', tool: 'fold-section', lit: !!sec.fold, act: () => edit(r => patchDiv(r, sec.id, { fold: !sec.fold })) })
    if (d.image) {
      items.push({ label: 'Move picture', tool: 'move-picture', lit: moving === d.id, act: () => { setPicked(d.id); setMoving(moving === d.id ? null : d.id) } })
      items.push({ label: 'Take the picture off', tool: 'remove-picture', act: () => { setMoving(null); edit(r => patchDiv(r, d.id, { image: undefined, crop: undefined })) } })
    }
    const card = heldCard(d) ? groups.find(g => g.id === heldCard(d)) : undefined
    if (card) items.push({
      label: 'Follow its card live', tool: 'live', lit: !!d.live,
      // Off again: it keeps what it shows now, as its own copy.
      act: () => edit(r => patchDiv(r, d.id, d.live ? { ...copyFrom(card, false), live: false } : { live: true })),
    })
    // Its card a 3D area card (utils/area3dCard): its scene laid out, or
    // folded back in, from here.
    if (card && (card.cardType === 'area3d' || card.area3d)) items.push({
      label: 'Show its 3D set', tool: 'area3d', lit: !!area3dOutOf(card.id), act: () => toggleArea3d(card.id),
      // Pointed at: where it comes out, and the room it takes.
      hover: on => useCanvasStore.getState().setPreviewHoveredDeckId(on && !area3dOutOf(card.id) ? 'set3d:' + card.id : null),
    })
    // Bake it back out to the canvas (utils/sceneBake): a new card as it
    // shows; with its cast, a closed deck; a heading, its whole section.
    items.push({ label: 'Bake out to a card', tool: 'bake-card', act: () => { bakeDivision(group.id, d.id, 'card') } })
    { const g = gathered(scene, d.id); if (g.own.length || g.handed.length) items.push({ label: 'Bake out to a deck, with its cast', tool: 'bake-deck', act: () => { bakeDivision(group.id, d.id, 'deck') } }) }
    if (sec) items.push({ label: 'Bake this section out to a deck', tool: 'bake-section', act: () => { bakeDivision(group.id, d.id, 'section') } })
    items.push({ label: 'Clear this section', tool: 'clear', act: () => { setMoving(null); edit(r => clearDiv(r, d.id)) } })
    if (heldCard(d)) items.push({ label: 'Unlink from its card', tool: 'unlink', act: () => edit(r => takeCard(d.live && card ? patchDiv(r, d.id, { ...copyFrom(card, false), live: false }) : r, d.id)) })
    if (canRemove) items.push({ label: 'Remove this division', tool: 'remove', danger: true, act: () => { edit(r => removeDiv(r, d.id)); setPicked(null) } })
    return items
  })() : null

  return (
    <div
      ref={rootRef}
      data-scene-face={group.id}
      onPointerLeave={() => setHoveredDiv(null)}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: '0 0 12px 12px' }}
    >
      <div style={{
        position: 'absolute', left: 0, top: 0, width: W, height: H,
        transform: `scale(${s})`, transformOrigin: '0 0', fontFamily: 'inherit',
      }}>
        <div style={{ position: 'absolute', left: PAD, top: PAD, width: iw, height: ih }}>
          {parts}
        </div>
        {!linking && (['top', 'bottom', 'left', 'right'] as const).map(side => (
          <EdgeStrip key={side} side={side} W={W} H={H} ctx={ctx} onAdd={() => {
            // The card grows by the new strip; what is there keeps its size
            // and place (no easing: nothing is seen to move).
            setDragging(true)
            growStrip(group.id, side, { width, height })
            requestAnimationFrame(() => requestAnimationFrame(() => setDragging(false)))
          }} />
        ))}
        {drag?.target && drag.where && (() => {
          // Where the part being dragged would land: that side of the
          // division under the pointer (all of it: the two change places).
          // Beside a heading is beside its whole section (moveDiv).
          const w = drag.where
          const sec = w !== 'bottom' && w !== 'swap' ? sectionOf(scene, drag.target) : null
          const b = boxes.get(sec && !drag.own.has(drag.target) ? sec.id : drag.target)
          if (!b) return null
          const at = w === 'left' ? { x: b.x, y: b.y, w: b.w / 2, h: b.h } : w === 'right' ? { x: b.x + b.w / 2, y: b.y, w: b.w / 2, h: b.h }
            : w === 'top' ? { x: b.x, y: b.y, w: b.w, h: b.h / 2 } : w === 'bottom' ? { x: b.x, y: b.y + b.h / 2, w: b.w, h: b.h / 2 } : b
          return <div data-scene-drop={w} style={{
            position: 'absolute', left: PAD + at.x, top: PAD + at.y, width: at.w, height: at.h, zIndex: 24, pointerEvents: 'none', boxSizing: 'border-box',
            borderRadius: 2.2, background: 'rgba(255,214,102,0.4)', border: `${1.5 / s}px ${w === 'swap' ? 'solid' : 'dashed'} rgba(255,214,102,0.95)`,
          }} />
        })()}
        <div ref={setLayer} data-scene-knobs style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, zIndex: 25, pointerEvents: 'none' }} />
      </div>
      {menu && menuItems && ReactDOM.createPortal(
        <MoreMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => {
          // Closed while Show its 3D set is pointed at: that outline goes too.
          const cs = useCanvasStore.getState()
          if (cs.previewHoveredDeckId?.startsWith('set3d:')) cs.setPreviewHoveredDeckId(null)
          setMenu(null)
        }} />,
        document.body,
      )}
      {iconEdit && (() => {
        const d = findDiv(scene, iconEdit.id)
        if (!d || !isLeaf(d)) return null
        const own = shownContent(d, groups.find(g => g.id === heldCard(d))).image ?? null
        return ReactDOM.createPortal(
          <IconEditor x={iconEdit.x} y={iconEdit.y} src={d.icon?.image ?? own} icon={d.icon} own={!!own}
            onChange={icon => { const r = root(); if (r) useBoardsStore.getState().setGroupScene(group.id, patchDiv(r, d.id, { icon })) }}
            onClose={() => setIconEdit(null)} />,
          document.body,
        )
      })()}
      {picker && ReactDOM.createPortal(
        <div data-color-picker>
          <ColorPickerPopup
            color={pickedColor}
            anchorX={picker.x}
            anchorY={picker.y}
            onChange={c => { const r = root(); if (r) { useUndoCoordinator.getState().checkpoint(); useBoardsStore.getState().setGroupScene(group.id, patchDiv(r, picker.id, { color: c })) } }}
            onClose={() => setPicker(null)}
          />
        </div>,
        document.body,
      )}
    </div>
  )
}
